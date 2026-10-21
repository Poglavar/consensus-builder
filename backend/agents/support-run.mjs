#!/usr/bin/env node
// Daily supporter persona: discover active minted proposals, choose one with the deterministic
// controller, and perform one real Solana pledge/donation/market stake. It shares personas.json,
// consensus.agent_run, AgentActionEngine and the Activity Explorer with proposer agents.

import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createPool } from '../db/connection.cjs';
import { Keypair } from '@solana/web3.js';
import {
    classifySupportExecution, selectSupportAction
} from './supporter-picker.js';
import { assertSupportEligibility, readSupportEligibility } from './supporter-state.js';
import { ensurePledgeBookAndSet } from './pledger.js';
import { ensureDonationEscrowAndDonate } from './donor.js';
import { ensureMarketAndStake, usdcToAtomic } from './bettor.js';
import { getRun, startRun, updateRun } from './ledger.js';
import { markAgentRunFailed, safeFailureDiagnostic } from './run-failure.js';
import { createRpcConnection } from '../solana/rpc.js';
import { ensureBotSolFunding, fundBotAction } from './funding.js';
import { createRetryingFetch } from '../utils/retrying-fetch.js';
import { sendAndConfirmPolling } from './solana-send.js';
import { sendTelegram } from './telegram.js';
import { runKeyFor, slotLabel } from './area-plan.js';
import { isEntrypoint } from './entrypoint.js';
import { discoverProposalInputs, refreshProposalStatuses } from './discovery.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const actionEngineApi = require('../../frontend/js/agent-action-engine.js');
const USDC_DEVNET = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const SIDE_YES = 1;

function usage(code) {
    console.log([
        'Supporter agent: discover → deterministic choice → one signed support action.', '',
        '  --dry-run            Choose and print; no database or Solana writes',
        '  --live               Checkpoint and submit one real devnet action',
        '  --persona NAME       One supporter persona (default: every role=supporter persona)',
        '  --day YYYY-MM-DD     UTC run day (default: today)',
        '  --slot auto|LABEL    Several runs a day: run id <day>-<slot>-<persona>, choice seeded by it (auto = h + UTC hour)',
        '  --api URL            Backend base URL',
        '  --help               This text'
    ].join('\n'));
    process.exit(code);
}

function parseArgs(argv) {
    const args = {};
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (token === '--help') usage(0);
        if (token === '--dry-run') { args.dryRun = true; continue; }
        if (token === '--live') { args.live = true; continue; }
        if (!token.startsWith('--') || !argv[index + 1] || argv[index + 1].startsWith('--')) usage(2);
        args[token.slice(2)] = argv[index + 1];
        index += 1;
    }
    if (Boolean(args.dryRun) === Boolean(args.live)) usage(2);
    return args;
}

function expandHome(value) {
    return value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
}

function loadPersonas(name) {
    const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'personas.json'), 'utf8'));
    const personas = (config.personas || []).filter(persona => persona.role === 'supporter' && (!name || persona.name === name));
    if (!personas.length) throw new Error(name ? `no supporter persona named ${name}` : 'personas.json lists no supporter personas');
    return personas;
}

function loadKeypair(persona) {
    const secret = Uint8Array.from(JSON.parse(fs.readFileSync(expandHome(persona.keypairPath), 'utf8')));
    const keypair = Keypair.fromSecretKey(secret);
    if (persona.wallet && persona.wallet !== keypair.publicKey.toBase58()) {
        throw new Error(`${persona.name} keypair does not match configured wallet`);
    }
    return keypair;
}

async function fetchJson(url, options = {}) {
    const response = await createRetryingFetch({ requestLabel: () => 'proposal-read' })(url, { headers: { accept: 'application/json' }, ...options });
    if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
    return response.json();
}

async function discoverProposals(apiBase, persona) {
    const cities = persona.support?.cities?.length ? persona.support.cities : ['zagreb'];
    return discoverProposalInputs({ apiBase, cities: cities.includes('*') ? [null] : Array.from(new Set(cities)), fetchJson,
        log: message => console.log(`[${new Date().toISOString()}] ${message}`) });
}

export async function executeSupport({ decision, connection, keypair, runId, pool, persona, adapters = {} }) {
    const amountAtomic = usdcToAtomic(decision.amount);
    const capAtomic = usdcToAtomic(String(process.env.AGENT_SUPPORT_USDC_CAP || '0.25'));
    if (amountAtomic > capAtomic) {
        throw new Error(`support amount ${decision.amount} USDC exceeds AGENT_SUPPORT_USDC_CAP`);
    }
    await (adapters.assertSupportEligibility || assertSupportEligibility)({ connection, decision, pool });
    await (adapters.fundBotAction || fundBotAction)({ action: decision, connection, pool, persona, runId });
    if (decision.type === 'pledge') {
        return (adapters.ensurePledgeBookAndSet || ensurePledgeBookAndSet)({
            connection, pledgerKeypair: keypair, proposalPda: decision.proposalAccount,
            amountAtomic, sendAndConfirm: sendAndConfirmPolling
        });
    }
    if (decision.type === 'donate') {
        return (adapters.ensureDonationEscrowAndDonate || ensureDonationEscrowAndDonate)({
            connection, donorKeypair: keypair, proposalPda: decision.proposalAccount, amountAtomic,
            operationId: `${runId}:${decision.proposalId}:donate`, sendAndConfirm: sendAndConfirmPolling
        });
    }
    if (decision.type === 'stake') {
        return (adapters.ensureMarketAndStake || ensureMarketAndStake)({
            connection, ownerKeypair: keypair, proposalPda: decision.proposalAccount,
            stakeMint: USDC_DEVNET, side: SIDE_YES, amountAtomic, sendAndConfirm: sendAndConfirmPolling
        });
    }
    throw new Error(`unsupported support action ${decision.type}`);
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const day = args.day || new Date().toISOString().slice(0, 10);
    const runKey = runKeyFor(day, slotLabel(args.slot));
    const apiBase = (args.api || process.env.AGENT_API_BASE || `http://localhost:${process.env.API_PORT || 3000}`).replace(/\/$/, '');
    const rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
    const personas = loadPersonas(args.persona);
    const pool = args.live ? createPool() : null;
    // Reads (existing support) happen in dry-run too; only --live signs anything.
    const connection = createRpcConnection(rpcUrl, 'confirmed');
    const report = [];
    try {
        for (const persona of personas) {
            const runId = `${runKey}-${persona.name}`;
            const existing = args.live ? await getRun(pool, runId) : null;
            if (existing?.status === 'done') {
                report.push(`${persona.name}: resumed ${existing.summary?.outcome || 'completed'}`);
                continue;
            }
            let runStarted = false;
            const activities = [];
            try {
                if (args.live) {
                    await startRun(pool, { runId, persona: persona.name, day, mode: 'live' });
                    runStarted = true;
                    await updateRun(pool, runId, { stage: 'gathering', status: 'running', summaryPatch: {
                        role: 'supporter', controller: 'algorithm', outcome: 'gathering'
                    } });
                }
                const keypair = args.live ? loadKeypair(persona) : null;
                const wallet = keypair?.publicKey.toBase58() || persona.wallet || null;
                if (args.live) {
                    const funding = await ensureBotSolFunding({ connection, persona });
                    if (funding.status === 'funded') await updateRun(pool, runId, { summaryPatch: { funding } });
                }
                const proposals = await refreshProposalStatuses(await discoverProposals(apiBase, persona), connection, {
                    pool: args.live ? pool : null, log: message => console.log(`[${new Date().toISOString()}] ${message}`)
                });
                const eligibility = await readSupportEligibility({ connection, wallet, persona, proposals });
                if (eligibility.closedMarketIds.length) console.log(`[${new Date().toISOString()}] ${persona.name}: excluded ${eligibility.closedMarketIds.length} resolved market(s)`);
                const choice = selectSupportAction({ day: runKey, persona, proposals: eligibility.proposals, wallet,
                    excludeProposalIds: eligibility.alreadySupportedIds });
                console.log(`[${new Date().toISOString()}] ${persona.name}: ${choice.reason}`);
                if (args.dryRun) {
                    if (choice.selected) console.log(JSON.stringify(choice.selected, null, 2));
                    continue;
                }

                await updateRun(pool, runId, { stage: 'selected', status: choice.selected ? 'running' : 'done', summaryPatch: {
                    role: 'supporter', controller: 'algorithm', wallet,
                    decisionInput: { controller: 'algorithm', day, eligibleProposalIds: choice.eligibleProposalIds,
                        closedMarketIds: eligibility.closedMarketIds },
                    decisionResult: { controller: 'algorithm', costUsd: 0, rationale: choice.reason },
                    selection: choice.selected,
                    outcome: choice.selected ? 'selected' : 'no-eligible-proposal'
                } });
                if (!choice.selected) {
                    report.push(`${persona.name}: no eligible proposal`);
                    continue;
                }

                const runtime = actionEngineApi.createEngine({
                    decisionProviders: { algorithm: (_actor, context) => context.action },
                    actionHandlers: { '*': (_actor, _action, context) => context.execute() },
                    onActivity: activity => activities.push({ ...activity, runId, rationale: choice.selected.rationale })
                });
                const actor = { id: persona.name, name: persona.name, controller: 'algorithm', wallet };
                const execution = await runtime.run(actor, {
                    source: 'live',
                    action: {
                        type: choice.selected.type, proposalId: choice.selected.proposalId,
                        amount: choice.selected.amount, side: choice.selected.side
                    },
                    execute: () => executeSupport({ decision: choice.selected, connection, keypair, runId, pool, persona })
                });
                // A replayed adapter result found the support already on-chain: record a no-op, not an action.
                const verdict = classifySupportExecution(execution.outcome);
                await updateRun(pool, runId, { stage: verdict.acted ? 'supported' : 'selected', status: 'done', summaryPatch: {
                    support: { type: choice.selected.type, proposalId: choice.selected.proposalId, proposalAccount: choice.selected.proposalAccount, ...execution.outcome },
                    activities: verdict.acted ? activities : [], outcome: verdict.runOutcome
                } });
                report.push(verdict.acted
                    ? `${persona.name}: ${choice.selected.type} ${choice.selected.amount} USDC on ${choice.selected.proposalId}`
                    : `${persona.name}: ${choice.selected.proposalId} was already supported; no new transaction`);
            } catch (error) {
                if (runStarted) {
                    try {
                        await markAgentRunFailed(pool, runId, error, { summaryPatch: { role: 'supporter', activities } });
                    } catch (recordError) {
                        console.error(`[support-run] could not record failure for ${runId}: ${safeFailureDiagnostic(recordError)}`);
                    }
                }
                throw error;
            }
        }
    } finally {
        if (pool) await pool.end();
    }
    const headline = `Support agents ${day}: ${report.join(' | ') || 'dry run complete'}`;
    console.log(`[${new Date().toISOString()}] ${headline}`);
    if (args.live) {
        console.log(`[${new Date().toISOString()}] AGENT SUPPORT RUN — status=completed day=${day} personas=${personas.length}`);
        await sendTelegram(headline);
    }
}

if (isEntrypoint(import.meta.url)) main().catch(async error => {
    const diagnostic = safeFailureDiagnostic(error);
    console.error(`[${new Date().toISOString()}] SUPPORTER FAILED: ${diagnostic}`);
    await sendTelegram(`Supporter agent FAILED: ${diagnostic}`, { alert: true });
    process.exit(1);
});
