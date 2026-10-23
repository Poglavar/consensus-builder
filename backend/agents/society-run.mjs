#!/usr/bin/env node
// Generic runner for "society" personas: any personas.json role with a pure policy module at
// agents/policies/<role>.js (contrarian, speculator, ...). Each turn reads the agreements of the
// persona's cities from the index with their accounts' on-chain status, their markets and the persona's
// own history, asks the policy (or, explicitly, an LLM choosing among the policy's options) for ONE
// action or none, and executes it through the shared action engine with the same consensus.agent_run
// checkpoints, caps and Telegram summary as the proposer and supporter. The subject of every market,
// pledge and claim is the agreement's chain account.
// Before the role's policy, every turn first collects winnings: a claim on a settled market the
// persona is owed money from (policies/collect.js). Dry run by default; --live signs on devnet.
// --turns N plays N game days in one invocation; --slot S lets a persona run several times a day.

import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createPool } from '../db/connection.cjs';
import { Keypair, PublicKey } from '@solana/web3.js';
import { accountsPerRequest, getMultipleAccountsBatched } from '../solana/account-batching.js';
import { fitsBudget, isOpen, isOthersOpen } from './policies/common.js';
import { societyHistory } from './policies/history.js';
import { decideTurn } from './policies/collect.js';
import { societyPolicy, societySlot, societyTurns, societyTurnSpent, societyBudget } from './run-policy.js';
import { ensurePledgeBookAndSet } from './pledger.js';
import { ensureMarketAndStake, usdcToAtomic } from './bettor.js';
import { claimAgreementMarket, resolveAgreementMarket, revokePledge } from './lifecycle-actions.js';
import { assertUnderCap, dailyCapUsd, dailySpendUsd, failStaleRuns, getRun, listPersonaRuns, recordCosts, STALE_RUN_HOURS, startRun, updateRun } from './ledger.js';
import { markAgentRunFailed, safeFailureDiagnostic } from './run-failure.js';
import { createAgentLlm, estimateBatchCostUsd, runPickBatch } from './llm-picker.js';
import { buildChoiceRequest, optionId, parseChoice } from './society-llm.js';
import { createRpcConnection } from '../solana/rpc.js';
import { ensureBotSolFunding, fundBotAction } from './funding.js';
import { sendAndConfirmPolling } from './solana-send.js';
import { sendTelegram } from './telegram.js';
import { isEntrypoint } from './entrypoint.js';
import { discoverAgreements, isMinted, readAgreementStatuses } from './discovery.js';
import { createIndexClient } from './publication-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const actionEngineApi = require('../../frontend/js/agent-action-engine.js');
const web3 = require('@solana/web3.js');
const supportClient = require('../../frontend/js/solana/pledge-client.js');
const marketClient = require('../../frontend/js/solana/market-client.js');
supportClient.configure({ web3 });
marketClient.configure({ web3 });
const USDC_DEVNET = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const { SIDE_NO, SIDE_YES } = marketClient.constants;
const CORE_ROLES = new Set(['proposer', 'supporter', 'lens-member']);
const CONTROLLERS = ['algorithm', 'llm'];
// Agreements whose designs are read for a policy that needs them (records), per turn.
const MAX_RECORDS = 40;
// Agreements read per turn: index pages (newest first) and, of those, minted ones whose market and
// positions are read. A cut is logged, never silent.
const MAX_MINTED = 500;
const PLEDGE_STATUS = ['active', 'fulfilled', 'revoked', 'voided'];

function usage(code) {
    console.log([
        'Society agent: one persona with a policy module (agents/policies/<role>.js) → one action or none per turn.', '',
        '  --persona NAME       The persona (required), e.g. preservationist-01 or speculator-01',
        '  --dry-run            (default) decide and print; no database or Solana writes',
        '  --live               Checkpoint and submit on devnet',
        '  --turns N            Play N game days (1-10): run ids <day>-<persona>-t<k>, seeds <day>:t<k>;',
        '                       the caps bound the whole invocation. Without it: run id <day>-<persona>',
        '  --slot LABEL         Run again on the same day: run ids <day>-<LABEL>-<persona>[-t<k>], seeds',
        '                       <day>:<LABEL>[:t<k>]; "auto" = h + the UTC hour (h08). The run day is unchanged',
        '  --personas FILE      Alternate personas.json (dry runs of a persona not yet configured)',
        '  --controller TYPE    algorithm (default, $0) or llm (explicit Anthropic batch choosing among the policy\'s options)',
        '  --day YYYY-MM-DD     UTC run day (default: today)',
        '  --api URL            Backend base URL',
        '  --help               This text', '',
        'Env: SOLANA_RPC_MAX_ACCOUNTS (100; 1-100 per RPC request), AGENT_SOCIETY_ACTION_CAP (4),',
        '     AGENT_SOCIETY_USDC_CAP (0.05) per invocation; AGENT_LLM_* with --controller llm.'
    ].join('\n'));
    process.exit(code);
}

function parseArgs(argv) {
    if (!argv.length) usage(0);
    const args = { controller: 'algorithm' };
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (token === '--help') usage(0);
        if (token === '--dry-run') { args.dryRun = true; continue; }
        if (token === '--live') { args.live = true; continue; }
        if (!token.startsWith('--') || !argv[index + 1] || argv[index + 1].startsWith('--')) usage(2);
        args[token.slice(2)] = argv[index + 1];
        index += 1;
    }
    if (args.dryRun && args.live) usage(2);
    if (!args.persona || !CONTROLLERS.includes(args.controller)) usage(2);
    if (args.turns !== undefined) {
        if (!/^\d+$/.test(args.turns)) usage(2);
        args.turns = Number(args.turns);
    }
    try { args.slot = societySlot(args.slot ?? null); } catch (_) { usage(2); }
    return args;
}

function log(message) {
    console.log(`[${new Date().toISOString()}] ${message}`);
}

function expandHome(value) {
    return value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
}

export function loadSocietyPersona(name, file = path.join(__dirname, 'personas.json')) {
    const personas = JSON.parse(fs.readFileSync(file, 'utf8')).personas || [];
    const persona = personas.find(item => item.name === name);
    if (!persona) throw new Error(`no persona named ${name} in personas.json`);
    if (!persona.role || CORE_ROLES.has(persona.role) || !/^[a-z][a-z-]*$/.test(persona.role)) {
        throw new Error(`${name} has role ${persona.role || 'proposer'}; society-run handles roles with an agents/policies/<role>.js module`);
    }
    if (!fs.existsSync(path.join(__dirname, 'policies', `${persona.role}.js`))) throw new Error(`no policy module agents/policies/${persona.role}.js for ${name}`);
    return persona;
}

function loadKeypair(persona) {
    const file = expandHome(persona.keypairPath || '');
    if (!persona.keypairPath || !fs.existsSync(file)) {
        throw new Error(`${persona.name} keypair ${persona.keypairPath || '(none)'} does not exist; generate it (solana-keygen new -o ${persona.keypairPath}) and set its wallet in personas.json`);
    }
    const keypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, 'utf8'))));
    if (!persona.wallet) throw new Error(`${persona.name} has wallet null in personas.json; set it to ${keypair.publicKey.toBase58()} before a live run`);
    if (persona.wallet !== keypair.publicKey.toBase58()) throw new Error(`${persona.name} keypair does not match configured wallet`);
    return keypair;
}

/**
 * The cities whose agreements a persona reads, newest first. `policy.cities: ['*']` is every city in
 * one unfiltered index read; an explicit list reads each city. Unminted and settled agreements come
 * along on purpose: the policies keep to open ones, the collect step needs the settled ones.
 */
export function discoveryCities(persona) {
    const cities = persona.policy?.cities?.length ? persona.policy.cities.map(String) : ['zagreb'];
    return cities.includes('*') ? [null] : Array.from(new Set(cities));
}

function decodeOrNull(info, decode) {
    return info?.data ? decode(info.data) : null;
}

// Batched account reads preserve address order and use the configured provider limit.
export function readAccounts(connection, addresses, env = process.env) {
    return getMultipleAccountsBatched(connection, addresses, { batchSize: accountsPerRequest(env) });
}

// Everything a policy and the collect step read, gathered fresh for every turn so turn k sees what
// turn k−1 signed. Every minted agreement's on-chain status, its market and both of the persona's
// positions are read (any status); every policy input uses the freshly read chain state.
async function gatherInputs({ index, persona, needs, connection, wallet }) {
    const agreements = await readAgreementStatuses(await discoverAgreements({ index, cities: discoveryCities(persona), log }), connection);
    let minted = agreements.filter(isMinted);
    if (minted.length > MAX_MINTED) {
        log(`${persona.name}: ${minted.length} minted agreements; reading markets for the newest ${MAX_MINTED}`);
        minted = minted.slice(0, MAX_MINTED);
    }
    const accounts = minted.map(agreement => agreement.account);
    const chainStatuses = Object.fromEntries(minted.map(agreement => [agreement.account, agreement.chainStatus]));
    const marketInfos = await readAccounts(connection, accounts.map(account => marketClient.getMarketPda(account)[0]));
    const markets = {};
    accounts.forEach((account, position) => { markets[account] = decodeOrNull(marketInfos[position], marketClient.decodeMarket); });

    const positions = {};
    const chain = { noPositionCids: [], yesPositionCids: [], pledges: {} };
    if (wallet) {
        const owner = new PublicKey(wallet);
        const withMarket = accounts.filter(account => markets[account]);
        const positionPdas = withMarket.flatMap(account => {
            const [market] = marketClient.getMarketPda(account);
            return [SIDE_YES, SIDE_NO].map(side => marketClient.getPositionPda(market, owner, side)[0]);
        });
        const positionInfos = await readAccounts(connection, positionPdas);
        withMarket.forEach((account, position) => {
            const yes = decodeOrNull(positionInfos[position * 2], marketClient.decodePosition);
            const no = decodeOrNull(positionInfos[position * 2 + 1], marketClient.decodePosition);
            if (yes || no) positions[account] = { yes, no };
        });
        minted.forEach(agreement => {
            const held = positions[agreement.account];
            if (needs.noPositions && held?.no?.amount > 0n) chain.noPositionCids.push(agreement.cid);
            if (needs.yesPositions && held?.yes?.amount > 0n) chain.yesPositionCids.push(agreement.cid);
        });
        if (needs.pledges) {
            const open = minted.filter(agreement => isOpen(agreement));
            await Promise.all(open.map(async agreement => {
                const commitment = await supportClient.readPledgeCommitment(connection, agreement.account, owner);
                if (commitment) chain.pledges[agreement.cid] = { status: PLEDGE_STATUS[commitment.status] || `status-${commitment.status}` };
            }));
        }
    }
    let recordFailures = 0;
    if (needs.records) {
        // The designs of the open agreements by others: what a density policy measures.
        const others = minted.filter(agreement => isOthersOpen(agreement, { wallet, personaName: persona.name })).slice(0, MAX_RECORDS);
        try {
            const rows = await index.getDesigns(others.flatMap(agreement => agreement.designCids));
            others.forEach(agreement => {
                agreement.designContents = agreement.designCids.map(cid => rows.get(cid)?.content).filter(Boolean);
                if (agreement.designContents.length < agreement.designCids.length) recordFailures += 1;
            });
        } catch (error) {
            recordFailures = others.length;
            log(`${persona.name}: designs unavailable (${error.message}); scoring agreements from their titles`);
        }
    }
    const terminal = minted.filter(agreement => agreement.chainStatus !== 'active').length;
    const cities = discoveryCities(persona);
    const where = cities[0] === null ? 'every city' : cities.length > 3 ? `${cities.length} cities` : cities.join(', ');
    log(`${persona.name}: ${agreements.length} agreement(s) in ${where}; `
        + `${minted.length} minted on Solana (${terminal} terminal), ${Object.values(markets).filter(Boolean).length} with a market; own positions on ${Object.keys(positions).length} market(s)`);
    return { agreements, markets, positions, chainStatuses, chain, recordFailures };
}

const ADAPTERS = { fundBotAction, ensureMarketAndStake, ensurePledgeBookAndSet, revokePledge, resolveAgreementMarket, claimAgreementMarket };

/** Sign one society action. `adapters` replaces the chain calls in tests. */
export async function execute({ action, connection, keypair, caps, pool, persona, runId, adapters = {} }) {
    const act = { ...ADAPTERS, ...adapters };
    if (action.usdc > caps.maxUsdc + 1e-9) throw new Error(`${action.type} of ${action.amount} USDC exceeds AGENT_SOCIETY_USDC_CAP ${caps.maxUsdc}`);
    if (action.type === 'stake' && (action.side === 'yes' || action.side === 'no')) {
        await act.fundBotAction({ action, connection, pool, persona, runId });
        // targetAmount makes a retried turn a replay instead of a second stake.
        return act.ensureMarketAndStake({
            connection, ownerKeypair: keypair, subject: action.account, stakeMint: USDC_DEVNET,
            side: action.side === 'yes' ? SIDE_YES : SIDE_NO, amountAtomic: usdcToAtomic(action.amount), targetAmount: true, sendAndConfirm: sendAndConfirmPolling
        });
    }
    if (action.type === 'pledge') {
        return act.ensurePledgeBookAndSet({
            connection, pledgerKeypair: keypair, subject: action.account,
            amountAtomic: usdcToAtomic(action.amount), sendAndConfirm: sendAndConfirmPolling
        });
    }
    if (action.type === 'revokePledge') {
        return act.revokePledge({ connection, pledgerKeypair: keypair, subject: action.account, sendAndConfirm: sendAndConfirmPolling });
    }
    if (action.type === 'claim' && (action.side === 'yes' || action.side === 'no')) {
        // Both steps read the chain first, so a retried turn replays whatever already landed.
        let resolution = null;
        if (action.resolveFirst) {
            resolution = await act.resolveAgreementMarket({ connection, resolverKeypair: keypair, subject: action.account, sendAndConfirm: sendAndConfirmPolling });
        }
        const claim = await act.claimAgreementMarket({
            connection, claimerKeypair: keypair, subject: action.account, side: action.side, sendAndConfirm: sendAndConfirmPolling
        });
        return {
            resolveSignature: resolution?.signature || null, outcome: resolution?.outcome || null,
            signature: claim.signature || null, replayed: Boolean(claim.replayed) && !resolution?.signature
        };
    }
    throw new Error(`society-run cannot execute ${action.type}`);
}

export function activityMessage(persona, action) {
    if (action.type === 'stake' && action.side === 'yes') return `${persona.name} bet YES ${action.amount} USDC on agreement ${action.agreementName}.`;
    if (action.type === 'stake') return `${persona.name} bet ${String(action.side).toUpperCase()} ${action.amount} USDC against agreement ${action.agreementName}.`;
    if (action.type === 'claim') return `${persona.name} collected ${action.payout} USDC from its ${String(action.side).toUpperCase()} bet on agreement ${action.agreementName}${action.resolveFirst ? ' after settling its market' : ''}.`;
    if (action.type === 'pledge') return `${persona.name} pledged ${action.amount} USDC to agreement ${action.agreementName}.`;
    if (action.type === 'revokePledge') return `${persona.name} revoked its pledge to agreement ${action.agreementName}.`;
    return `${persona.name} ${action.type} agreement ${action.agreementName}.`;
}

// The explicit LLM controller: the model picks one of the options that fit the budget, or none.
async function llmChoose({ pool, persona, turn, decision, budget, day, dryRun, existing }) {
    const options = decision.options.filter(option => fitsBudget(option.action, budget));
    if (!options.length) return { action: null, decisionResult: { controller: 'llm', costUsd: 0, rationale: decision.reason }, skipped: true };
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const llm = createAgentLlm({ client: new Anthropic(), meta: { runId: turn.runId } });
    const request = buildChoiceRequest({ llm, runId: turn.runId, persona, role: persona.role, seed: turn.seed, options });
    const model = request.params.model;
    const estimate = estimateBatchCostUsd([request]);
    if (dryRun) {
        log(`${persona.name}: dry run would ask ${model} to choose among ${options.length} option(s) (≤ $${estimate.toFixed(4)}): ${options.map(optionId).join(', ')}`);
        return { action: null, decisionResult: { controller: 'llm', costUsd: 0, rationale: 'dry run: model not called' }, skipped: true };
    }
    const existingBatchId = existing?.summary?.llm?.batchId || null;
    if (!existingBatchId) assertUnderCap({ spentUsd: await dailySpendUsd(pool, day), estimateUsd: estimate, capUsd: dailyCapUsd(process.env) });
    await updateRun(pool, turn.runId, { summaryPatch: { decisionInput: {
        controller: 'llm', customId: request.custom_id, model, maxTokens: request.params.max_tokens,
        systemPrompt: request.params.system, userPrompt: request.params.messages[0].content[0].text
    } } });
    const batch = await runPickBatch({ llm, requests: [request], existingBatchId });
    await updateRun(pool, turn.runId, { summaryPatch: { llm: { batchId: batch.batchId } } });
    if (!batch.done) return { pending: batch.batchId };
    const result = batch.results.find(item => item.customId === request.custom_id);
    // A refused or truncated item was still paid for: its cost reaches the daily cap either way.
    if (result && typeof result.costUsd === 'number') {
        await recordCosts(pool, turn.runId, [{ item: result.customId, provider: 'anthropic', model: result.model || model, batchId: batch.batchId, usage: result.usage, usd: result.costUsd }]);
    }
    if (!result || result.error) throw new Error(`batch ${batch.batchId} item ${result?.error ?? 'missing'}`);
    const choice = parseChoice(result.text, options);
    const action = choice.option ? { ...choice.option.action, policyRationale: choice.option.action.rationale, rationale: choice.rationale } : null;
    return {
        action,
        decisionResult: {
            controller: 'llm', model: result.model || model, batchId: batch.batchId, usage: result.usage ?? null, costUsd: result.costUsd ?? null,
            rationale: choice.rationale || decision.reason, rejected: choice.rejected
        }
    };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const live = Boolean(args.live);
    const day = args.day || new Date().toISOString().slice(0, 10);
    const apiBase = (args.api || process.env.AGENT_API_BASE || `http://localhost:${process.env.API_PORT || 3000}`).replace(/\/$/, '');
    const connection = createRpcConnection(process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com', 'confirmed');
    const index = createIndexClient({ apiBase, log });
    const persona = loadSocietyPersona(args.persona, ...(args.personas ? [path.resolve(args.personas)] : []));
    const policy = await import(/* @vite-ignore */ new URL(`./policies/${persona.role}.js`, import.meta.url).href);
    if (typeof policy.decide !== 'function' || !policy.NEEDS) throw new Error(`agents/policies/${persona.role}.js must export decide() and NEEDS`);
    const turns = societyTurns({ day, personaName: persona.name, turns: args.turns ?? null, slot: args.slot });
    const caps = societyPolicy(process.env);
    const pool = live ? createPool() : null;
    let keypair = null;
    let wallet = persona.wallet || null;
    log(`${live ? 'LIVE' : 'dry run'} · ${persona.name} (${persona.role}) · day ${day}${args.slot ? ` · slot ${args.slot}` : ''} · ${turns.length} turn(s) · controller ${args.controller} · caps ${caps.maxActions} signed action(s), ${caps.maxUsdc} USDC per invocation · api ${apiBase}`);

    const spent = { actions: 0, usdc: 0 };
    const simulated = [];
    const report = [];
    try {
        if (pool) {
            const abandoned = await failStaleRuns(pool);
            if (abandoned.length) log(`failed ${abandoned.length} abandoned run(s) with no checkpoint for ${STALE_RUN_HOURS} h: ${abandoned.join(', ')}`);
        }
        for (const turn of turns) {
            const label = `${persona.name}${turn.turn ? ` t${turn.turn}` : ''}`;
            const existing = live ? await getRun(pool, turn.runId) : null;
            if (existing?.status === 'done') {
                const used = societyTurnSpent(existing.summary);
                spent.actions += used.actions; spent.usdc += used.usdc;
                report.push(`${label}: resumed ${existing.summary?.outcome || 'done'}`);
                continue;
            }
            let runStarted = false;
            const activities = [];
            try {
                if (live) {
                    await startRun(pool, { runId: turn.runId, persona: persona.name, day, mode: 'live' });
                    runStarted = true;
                    await updateRun(pool, turn.runId, { stage: 'gathering', status: 'running', summaryPatch: {
                        role: persona.role, controller: args.controller, wallet, turn: turn.turn, seed: turn.seed,
                        outcome: 'gathering'
                    } });
                    if (!keypair) {
                        keypair = loadKeypair(persona);
                        wallet = keypair.publicKey.toBase58();
                        await updateRun(pool, turn.runId, { summaryPatch: { wallet } });
                    }
                    const funding = await ensureBotSolFunding({ connection, persona });
                    if (funding.status === 'funded') await updateRun(pool, turn.runId, { summaryPatch: { funding } });
                }
                const budget = societyBudget(caps, spent);
                let action = existing?.status === 'running' ? existing.summary?.society?.action || null : null;
                let decisionResult = existing?.summary?.decisionResult || null;
                let decision = null;
                if (!action) {
                    const inputs = await gatherInputs({ index, persona, needs: policy.NEEDS, connection, wallet });
                    const runs = live ? await listPersonaRuns(pool, persona.name) : [];
                    const history = societyHistory({ runs, chain: inputs.chain, simulated });
                    // A claim the persona is owed comes first; otherwise the role's own policy decides.
                    decision = decideTurn(policy.decide, {
                        persona, seed: turn.seed, now: Date.now(), wallet,
                        agreements: inputs.agreements, markets: inputs.markets, positions: inputs.positions,
                        chainStatuses: inputs.chainStatuses, history, budget
                    });
                    log(`${label}: ${decision.reason}`);
                    if (live) await updateRun(pool, turn.runId, { summaryPatch: {
                        decisionInput: { controller: args.controller, seed: turn.seed, step: decision.step, budget, eligibleCids: decision.eligibleCids, recordFailures: inputs.recordFailures }
                    } });
                    // Collecting what the persona is owed is mechanical; the model only chooses among role options.
                    if (args.controller === 'llm' && decision.step === 'role') {
                        const chosen = await llmChoose({ pool, persona, turn, decision, budget, day, dryRun: !live, existing });
                        if (chosen.pending) {
                            log(`${label}: batch ${chosen.pending} still processing — checkpointed; rerun to continue`);
                            report.push(`${label}: awaiting model batch`);
                            break;
                        }
                        action = chosen.action;
                        decisionResult = chosen.decisionResult;
                    } else {
                        action = decision.action;
                        decisionResult = { controller: decision.step === 'collect' ? 'collect' : 'algorithm', costUsd: 0, rationale: decision.reason };
                    }
                }
                if (!live) {
                    if (action) {
                        console.log(JSON.stringify(action, null, 2));
                        simulated.push(action);
                        spent.actions += action.signedActions; spent.usdc += action.usdc;
                        report.push(`${label}: would ${action.type}${action.side ? ` ${action.side.toUpperCase()}` : ''}${action.resolveFirst ? ' (resolve first)' : ''} ${action.agreementCid}`);
                    } else {
                        report.push(`${label}: ${decision?.capped ? 'cap reached' : 'no action'}`);
                        if (decision?.capped) break;
                    }
                    continue;
                }

                const options = (decision?.options || []).slice(0, 5).map(option => ({ agreementCid: option.agreementCid, type: option.action.type, rationale: option.action.rationale }));
                if (!action) {
                    const outcome = decision?.capped ? 'cap-reached' : 'no-action';
                    await updateRun(pool, turn.runId, { stage: 'selected', status: 'done', summaryPatch: {
                        decisionResult, society: { action: null, acted: false, options }, outcome
                    } });
                    report.push(`${label}: ${outcome}`);
                    if (decision?.capped) break;
                    continue;
                }
                await updateRun(pool, turn.runId, { stage: 'selected', status: 'running', summaryPatch: {
                    decisionResult, society: { action, acted: false, options }, outcome: 'selected'
                } });

                const runtime = actionEngineApi.createEngine({
                    decisionProviders: { algorithm: (_actor, context) => context.action, llm: (_actor, context) => context.action },
                    actionHandlers: { '*': (_actor, _action, context) => context.execute() },
                    onActivity: activity => activities.push({ ...activity, runId: turn.runId, rationale: action.rationale })
                });
                const actor = { id: persona.name, name: persona.name, controller: args.controller, wallet };
                const execution = await runtime.run(actor, {
                    source: 'live',
                    action: { type: action.type, agreementCid: action.agreementCid, account: action.account, amount: action.amount, side: action.side || null },
                    execute: async () => ({
                        ...(await execute({ action, connection, keypair, caps, pool, persona, runId: turn.runId })),
                        entity: { type: 'agreement', id: action.agreementCid }, message: activityMessage(persona, action)
                    })
                });
                const { message: _message, entity: _entity, ...result } = execution.outcome;
                const acted = Boolean(result.signature || result.stakeSignature || result.resolveSignature) && result.replayed !== true;
                const summary = { society: { action, acted, options, execution: result }, activities: acted ? activities : [], outcome: acted ? 'completed' : 'replayed' };
                await updateRun(pool, turn.runId, { stage: acted ? 'acted' : 'selected', status: 'done', summaryPatch: summary });
                const used = societyTurnSpent(summary);
                spent.actions += used.actions; spent.usdc += used.usdc;
                report.push(acted
                    ? `${label}: ${action.type}${action.side ? ` ${action.side.toUpperCase()}` : ''}${action.amount ? ` ${action.amount} USDC` : ''}${action.payout ? ` (${action.payout} USDC back)` : ''} on ${action.agreementCid}`
                    : `${label}: ${action.agreementCid} already in that state on-chain; no new transaction`);
            } catch (error) {
                if (runStarted) {
                    try {
                        await markAgentRunFailed(pool, turn.runId, error, { summaryPatch: { role: persona.role, activities } });
                    } catch (recordError) {
                        console.error(`[society-run] could not record failure for ${turn.runId}: ${safeFailureDiagnostic(recordError)}`);
                    }
                }
                throw error;
            }
        }
    } finally {
        if (pool) await pool.end();
    }
    const headline = `Society ${persona.name} (${persona.role}) ${day}${args.slot ? ` ${args.slot}` : ''}: ${report.join(' | ') || 'nothing to do'} · spent ${spent.actions}/${caps.maxActions} actions, ${spent.usdc.toFixed(2)}/${caps.maxUsdc.toFixed(2)} USDC${live ? '' : ' (dry run, nothing written)'}`;
    log(headline);
    if (live) {
        log(`AGENT SOCIETY RUN — status=completed day=${day} persona=${persona.name} turns=${turns.length}`);
        await sendTelegram(headline);
    }
}

if (isEntrypoint(import.meta.url)) {
    // A failure is reported once, in bot-monitor's 06:00 UTC message, not by every run.
    main().catch(error => {
        const diagnostic = safeFailureDiagnostic(error);
        console.error(`[${new Date().toISOString()}] SOCIETY AGENT FAILED: ${diagnostic}`);
        process.exit(1);
    });
}
