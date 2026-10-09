#!/usr/bin/env node
// Generic runner for "society" personas: any personas.json role with a pure policy module at
// agents/policies/<role>.js (contrarian, speculator, ...). Each turn reads active proposals, their
// markets and the persona's own history, asks the policy (or, explicitly, an LLM choosing among the
// policy's options) for ONE action or none, and executes it through the shared action engine with the
// same consensus.agent_run checkpoints, caps and Telegram summary as the proposer and supporter.
// Dry run by default; --live signs on devnet. --turns N plays N game days in one invocation.

import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { proposalAccount, proposalKey, isOthersActiveMinted, fitsBudget } from './policies/common.js';
import { societyHistory } from './policies/history.js';
import { societyPolicy, societyTurns, societyTurnSpent, societyBudget } from './run-policy.js';
import { ensurePledgeBookAndSet } from './pledger.js';
import { ensureMarketAndStake, usdcToAtomic } from './bettor.js';
import { revokePledge } from './lifecycle-actions.js';
import { assertUnderCap, dailyCapUsd, dailySpendUsd, getRun, listPersonaRuns, recordCosts, startRun, updateRun } from './ledger.js';
import { createAgentLlm, estimateBatchCostUsd, runPickBatch } from './llm-picker.js';
import { buildChoiceRequest, optionId, parseChoice } from './society-llm.js';
import { sendAndConfirmPolling } from './solana-send.js';
import { sendTelegram } from './telegram.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const actionEngineApi = require('../../frontend/js/agent-action-engine.js');
const web3 = require('@solana/web3.js');
const supportClient = require('../../frontend/js/solana/pledge-client.js');
const marketClient = require('../../frontend/js/solana/market-client.js');
supportClient.configure({ web3 });
marketClient.configure({ web3 });
const USDC_DEVNET = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const SIDE_NO = 0;
const CORE_ROLES = new Set(['proposer', 'supporter', 'lens-member']);
const CONTROLLERS = ['algorithm', 'llm'];
const MAX_RECORDS = 40;
const PLEDGE_STATUS = ['active', 'fulfilled', 'revoked', 'voided'];

function usage(code) {
    console.log([
        'Society agent: one persona with a policy module (agents/policies/<role>.js) → one action or none per turn.', '',
        '  --persona NAME       The persona (required), e.g. preservationist-01 or speculator-01',
        '  --dry-run            (default) decide and print; no database or Solana writes',
        '  --live               Checkpoint and submit on devnet',
        '  --turns N            Play N game days (1-10): run ids <day>-<persona>-t<k>, seeds <day>:t<k>;',
        '                       the caps bound the whole invocation. Without it: run id <day>-<persona>',
        '  --controller TYPE    algorithm (default, $0) or llm (explicit Anthropic batch choosing among the policy\'s options)',
        '  --day YYYY-MM-DD     UTC run day (default: today)',
        '  --api URL            Backend base URL',
        '  --help               This text', '',
        'Env: AGENT_SOCIETY_ACTION_CAP (4), AGENT_SOCIETY_USDC_CAP (0.05) per invocation; AGENT_LLM_* with --controller llm.'
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

async function fetchJson(url) {
    const response = await fetch(url, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
    return response.json();
}

async function discoverProposals(apiBase, persona) {
    const cities = persona.policy?.cities?.length ? persona.policy.cities : ['zagreb'];
    const pages = await Promise.all(cities.map(city => fetchJson(
        `${apiBase}/proposals/summary?city=${encodeURIComponent(city)}&lifecycle=Active&limit=100`
    )));
    const byId = new Map();
    pages.flatMap(page => page.proposals || []).forEach(proposal => byId.set(proposalKey(proposal), proposal));
    return Array.from(byId.values());
}

// Everything a policy reads, gathered fresh for every turn so turn k sees what turn k−1 signed.
async function gatherInputs({ apiBase, persona, needs, connection, wallet }) {
    const proposals = await discoverProposals(apiBase, persona);
    const minted = proposals.filter(proposal => proposalAccount(proposal));
    const markets = {};
    await Promise.all(minted.map(async proposal => {
        const account = proposalAccount(proposal);
        markets[account] = await marketClient.readMarket(connection, account);
    }));
    const chain = { noPositionProposalIds: [], pledges: {} };
    if (wallet) {
        const owner = new PublicKey(wallet);
        await Promise.all(minted.map(async proposal => {
            const account = proposalAccount(proposal);
            if (needs.noPositions) {
                const position = await marketClient.readPosition(connection, account, owner, SIDE_NO);
                if (position && position.amount > 0n) chain.noPositionProposalIds.push(proposalKey(proposal));
            }
            if (needs.pledges) {
                const commitment = await supportClient.readPledgeCommitment(connection, account, owner);
                if (commitment) chain.pledges[proposalKey(proposal)] = { status: PLEDGE_STATUS[commitment.status] || `status-${commitment.status}` };
            }
        }));
    }
    let recordFailures = 0;
    if (needs.records) {
        const others = minted.filter(proposal => isOthersActiveMinted(proposal, { wallet, personaName: persona.name })).slice(0, MAX_RECORDS);
        await Promise.all(others.map(async proposal => {
            try {
                proposal.record = await fetchJson(`${apiBase}/proposals/${encodeURIComponent(proposal.id ?? proposalKey(proposal))}`);
            } catch (error) {
                recordFailures += 1;
                log(`${persona.name}: record ${proposalKey(proposal)} unavailable (${error.message}); scoring it from its summary text`);
            }
        }));
    }
    return { proposals, markets, chain, recordFailures };
}

async function execute({ action, connection, keypair, caps }) {
    if (action.usdc > caps.maxUsdc + 1e-9) throw new Error(`${action.type} of ${action.amount} USDC exceeds AGENT_SOCIETY_USDC_CAP ${caps.maxUsdc}`);
    if (action.type === 'stake' && action.side === 'no') {
        // targetAmount makes a retried turn a replay instead of a second stake.
        return ensureMarketAndStake({
            connection, ownerKeypair: keypair, proposalPda: action.proposalAccount, stakeMint: USDC_DEVNET,
            side: SIDE_NO, amountAtomic: usdcToAtomic(action.amount), targetAmount: true, sendAndConfirm: sendAndConfirmPolling
        });
    }
    if (action.type === 'pledge') {
        return ensurePledgeBookAndSet({
            connection, pledgerKeypair: keypair, proposalPda: action.proposalAccount,
            amountAtomic: usdcToAtomic(action.amount), sendAndConfirm: sendAndConfirmPolling
        });
    }
    if (action.type === 'revokePledge') {
        return revokePledge({ connection, pledgerKeypair: keypair, proposalAccount: action.proposalAccount, sendAndConfirm: sendAndConfirmPolling });
    }
    throw new Error(`society-run cannot execute ${action.type}`);
}

function activityMessage(persona, action) {
    if (action.type === 'stake') return `${persona.name} bet ${String(action.side).toUpperCase()} ${action.amount} USDC against proposal ${action.proposalName}.`;
    if (action.type === 'pledge') return `${persona.name} pledged ${action.amount} USDC to proposal ${action.proposalName}.`;
    if (action.type === 'revokePledge') return `${persona.name} revoked its pledge to proposal ${action.proposalName}.`;
    return `${persona.name} ${action.type} proposal ${action.proposalName}.`;
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
    const connection = new Connection(process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com', 'confirmed');
    const persona = loadSocietyPersona(args.persona);
    const policy = await import(/* @vite-ignore */ new URL(`./policies/${persona.role}.js`, import.meta.url).href);
    if (typeof policy.decide !== 'function' || !policy.NEEDS) throw new Error(`agents/policies/${persona.role}.js must export decide() and NEEDS`);
    const turns = societyTurns({ day, personaName: persona.name, turns: args.turns ?? null });
    const caps = societyPolicy(process.env);
    const keypair = live ? loadKeypair(persona) : null;
    const wallet = keypair?.publicKey.toBase58() || persona.wallet || null;
    const pool = live ? new pg.Pool({
        host: process.env.PGHOST, port: process.env.PGPORT, user: process.env.PGUSER,
        password: process.env.PGPASSWORD, database: process.env.PGDATABASE
    }) : null;
    log(`${live ? 'LIVE' : 'dry run'} · ${persona.name} (${persona.role}) · day ${day} · ${turns.length} turn(s) · controller ${args.controller} · caps ${caps.maxActions} signed action(s), ${caps.maxUsdc} USDC per invocation · api ${apiBase}`);

    const spent = { actions: 0, usdc: 0 };
    const simulated = [];
    const report = [];
    try {
        for (const turn of turns) {
            const label = `${persona.name}${turn.turn ? ` t${turn.turn}` : ''}`;
            const existing = live ? await getRun(pool, turn.runId) : null;
            if (existing?.status === 'done') {
                const used = societyTurnSpent(existing.summary);
                spent.actions += used.actions; spent.usdc += used.usdc;
                report.push(`${label}: resumed ${existing.summary?.outcome || 'done'}`);
                continue;
            }
            const budget = societyBudget(caps, spent);
            let action = existing?.status === 'running' ? existing.summary?.society?.action || null : null;
            let decisionResult = existing?.summary?.decisionResult || null;
            let decision = null;
            if (!action) {
                const inputs = await gatherInputs({ apiBase, persona, needs: policy.NEEDS, connection, wallet });
                const runs = live ? await listPersonaRuns(pool, persona.name) : [];
                const history = societyHistory({ runs, chain: inputs.chain, simulated });
                decision = policy.decide({
                    persona, seed: turn.seed, now: Date.now(), wallet,
                    proposals: inputs.proposals, markets: inputs.markets, history, budget
                });
                log(`${label}: ${decision.reason}`);
                if (live) {
                    await startRun(pool, { runId: turn.runId, persona: persona.name, day, mode: 'live' });
                    await updateRun(pool, turn.runId, { summaryPatch: {
                        role: persona.role, controller: args.controller, wallet, turn: turn.turn, seed: turn.seed,
                        decisionInput: { controller: args.controller, seed: turn.seed, budget, eligibleProposalIds: decision.eligibleProposalIds, recordFailures: inputs.recordFailures }
                    } });
                }
                if (args.controller === 'llm') {
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
                    decisionResult = { controller: 'algorithm', costUsd: 0, rationale: decision.reason };
                }
            }
            if (!live) {
                if (action) {
                    console.log(JSON.stringify(action, null, 2));
                    simulated.push(action);
                    spent.actions += action.signedActions; spent.usdc += action.usdc;
                    report.push(`${label}: would ${action.type}${action.side ? ` ${action.side.toUpperCase()}` : ''} ${action.proposalId}`);
                } else {
                    report.push(`${label}: ${decision?.capped ? 'cap reached' : 'no action'}`);
                    if (decision?.capped) break;
                }
                continue;
            }

            const options = (decision?.options || []).slice(0, 5).map(option => ({ proposalId: option.proposalId, type: option.action.type, rationale: option.action.rationale }));
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

            const activities = [];
            const runtime = actionEngineApi.createEngine({
                decisionProviders: { algorithm: (_actor, context) => context.action, llm: (_actor, context) => context.action },
                actionHandlers: { '*': (_actor, _action, context) => context.execute() },
                onActivity: activity => activities.push({ ...activity, runId: turn.runId, rationale: action.rationale })
            });
            const actor = { id: persona.name, name: persona.name, controller: args.controller, wallet };
            try {
                const execution = await runtime.run(actor, {
                    source: 'live',
                    action: { type: action.type, proposalId: action.proposalId, amount: action.amount, side: action.side || null },
                    execute: async () => ({ ...(await execute({ action, connection, keypair, caps })), message: activityMessage(persona, action) })
                });
                const { message: _message, ...result } = execution.outcome;
                const acted = Boolean(result.signature || result.stakeSignature) && result.replayed !== true;
                const summary = { society: { action, acted, options, execution: result }, activities: acted ? activities : [], outcome: acted ? 'completed' : 'replayed' };
                await updateRun(pool, turn.runId, { stage: acted ? 'acted' : 'selected', status: 'done', summaryPatch: summary });
                const used = societyTurnSpent(summary);
                spent.actions += used.actions; spent.usdc += used.usdc;
                report.push(acted
                    ? `${label}: ${action.type}${action.side ? ` ${action.side.toUpperCase()}` : ''}${action.amount ? ` ${action.amount} USDC` : ''} on ${action.proposalId}`
                    : `${label}: ${action.proposalId} already in that state on-chain; no new transaction`);
            } catch (error) {
                await updateRun(pool, turn.runId, { stage: 'selected', status: 'failed', summaryPatch: { activities, outcome: 'failed', error: error.message } });
                throw error;
            }
        }
    } finally {
        if (pool) await pool.end();
    }
    const headline = `Society ${persona.name} (${persona.role}) ${day}: ${report.join(' | ') || 'nothing to do'} · spent ${spent.actions}/${caps.maxActions} actions, ${spent.usdc.toFixed(2)}/${caps.maxUsdc.toFixed(2)} USDC${live ? '' : ' (dry run, nothing written)'}`;
    log(headline);
    if (live) {
        log(`AGENT SOCIETY RUN — status=completed day=${day} persona=${persona.name} turns=${turns.length}`);
        await sendTelegram(headline);
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch(async error => {
        console.error(`[${new Date().toISOString()}] SOCIETY AGENT FAILED:`, error);
        if (process.argv.includes('--live')) await sendTelegram(`Society agent FAILED: ${error.message}`);
        process.exit(1);
    });
}
