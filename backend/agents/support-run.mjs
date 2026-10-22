#!/usr/bin/env node
// Supporter persona: discover open minted agreements (the index's newest per city, their accounts read
// on chain), choose one with the deterministic controller, and perform one real Solana pledge,
// donation or market stake on it (the agreement's account is the subject). It shares personas.json,
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
import { sendAndConfirmPolling } from './solana-send.js';
import { sendTelegram } from './telegram.js';
import { runKeyFor, slotLabel } from './area-plan.js';
import { isEntrypoint } from './entrypoint.js';
import { discoverAgreements, readAgreementStatuses } from './discovery.js';
import { createIndexClient } from './publication-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const actionEngineApi = require('../../frontend/js/agent-action-engine.js');
const USDC_DEVNET = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const SIDE_YES = 1;

function usage(code) {
    console.log([
        'Supporter agent: discover open agreements → deterministic choice → one signed support action.', '',
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
    if (!argv.length) usage(0);
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

const log = message => console.log(`[${new Date().toISOString()}] ${message}`);

async function discoverOpenAgreements(index, persona, connection) {
    const cities = persona.support?.cities?.length ? persona.support.cities : ['zagreb'];
    const agreements = await discoverAgreements({ index, cities: cities.includes('*') ? [null] : Array.from(new Set(cities)), log });
    return readAgreementStatuses(agreements, connection);
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
            connection, pledgerKeypair: keypair, subject: decision.account,
            amountAtomic, sendAndConfirm: sendAndConfirmPolling
        });
    }
    if (decision.type === 'donate') {
        return (adapters.ensureDonationEscrowAndDonate || ensureDonationEscrowAndDonate)({
            connection, donorKeypair: keypair, subject: decision.account, amountAtomic,
            operationId: `${runId}:${decision.agreementCid}:donate`, sendAndConfirm: sendAndConfirmPolling
        });
    }
    if (decision.type === 'stake') {
        return (adapters.ensureMarketAndStake || ensureMarketAndStake)({
            connection, ownerKeypair: keypair, subject: decision.account,
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
    const index = createIndexClient({ apiBase, log });
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
                const agreements = await discoverOpenAgreements(index, persona, connection);
                const eligibility = await readSupportEligibility({ connection, wallet, persona, agreements });
                if (eligibility.closedMarketCids.length) log(`${persona.name}: excluded ${eligibility.closedMarketCids.length} resolved market(s)`);
                const choice = selectSupportAction({ day: runKey, persona, agreements: eligibility.agreements, wallet,
                    excludeCids: eligibility.alreadySupportedCids });
                log(`${persona.name}: ${choice.reason}`);
                if (args.dryRun) {
                    if (choice.selected) console.log(JSON.stringify(choice.selected, null, 2));
                    continue;
                }

                await updateRun(pool, runId, { stage: 'selected', status: choice.selected ? 'running' : 'done', summaryPatch: {
                    role: 'supporter', controller: 'algorithm', wallet,
                    decisionInput: { controller: 'algorithm', day, eligibleCids: choice.eligibleCids,
                        closedMarketCids: eligibility.closedMarketCids },
                    decisionResult: { controller: 'algorithm', costUsd: 0, rationale: choice.reason },
                    selection: choice.selected,
                    outcome: choice.selected ? 'selected' : 'no-eligible-agreement'
                } });
                if (!choice.selected) {
                    report.push(`${persona.name}: no eligible agreement`);
                    continue;
                }

                const runtime = actionEngineApi.createEngine({
                    decisionProviders: { algorithm: (_actor, context) => context.action },
                    actionHandlers: { '*': (_actor, _action, context) => context.execute() },
                    onActivity: activity => activities.push({ ...activity, runId, rationale: choice.selected.rationale })
                });
                const actor = { id: persona.name, name: persona.name, controller: 'algorithm', wallet };
                const selected = choice.selected;
                const verb = selected.type === 'stake' ? `staked ${selected.amount} USDC YES on` : selected.type === 'donate' ? `donated ${selected.amount} USDC to` : `pledged ${selected.amount} USDC to`;
                const execution = await runtime.run(actor, {
                    source: 'live',
                    action: {
                        type: selected.type, agreementCid: selected.agreementCid, account: selected.account,
                        amount: selected.amount, side: selected.side
                    },
                    execute: async () => ({
                        ...(await executeSupport({ decision: selected, connection, keypair, runId, pool, persona })),
                        entity: { type: 'agreement', id: selected.agreementCid },
                        message: `${persona.name} ${verb} "${selected.agreementName}".`
                    })
                });
                const { entity: _entity, message: _message, ...outcome } = execution.outcome;
                // A replayed adapter result found the support already on-chain: record a no-op, not an action.
                const verdict = classifySupportExecution(outcome);
                await updateRun(pool, runId, { stage: verdict.acted ? 'supported' : 'selected', status: 'done', summaryPatch: {
                    support: { type: selected.type, agreementCid: selected.agreementCid, account: selected.account, ...outcome },
                    activities: verdict.acted ? activities : [], outcome: verdict.runOutcome
                } });
                report.push(verdict.acted
                    ? `${persona.name}: ${selected.type} ${selected.amount} USDC on ${selected.agreementCid}`
                    : `${persona.name}: ${selected.agreementCid} was already supported; no new transaction`);
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

// A failure is reported once, in bot-monitor's 06:00 UTC message, not by every run.
if (isEntrypoint(import.meta.url)) main().catch(error => {
    const diagnostic = safeFailureDiagnostic(error);
    console.error(`[${new Date().toISOString()}] SUPPORTER FAILED: ${diagnostic}`);
    process.exit(1);
});
