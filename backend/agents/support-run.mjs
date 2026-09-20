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
import pg from 'pg';
import { Connection, Keypair } from '@solana/web3.js';
import { selectSupportAction } from './supporter-picker.js';
import { ensurePledgeBookAndSet } from './pledger.js';
import { ensureDonationEscrowAndDonate } from './donor.js';
import { ensureMarketAndStake, usdcToAtomic } from './bettor.js';
import { getRun, startRun, updateRun } from './ledger.js';
import { sendAndConfirmPolling } from './solana-send.js';
import { sendTelegram } from './telegram.js';

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

async function fetchJson(url) {
    const response = await fetch(url, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
    return response.json();
}

async function discoverProposals(apiBase, persona) {
    const cities = persona.support?.cities?.length ? persona.support.cities : ['zagreb'];
    const pages = await Promise.all(cities.map(city => fetchJson(
        `${apiBase}/proposals/summary?city=${encodeURIComponent(city)}&lifecycle=Active&limit=100`
    )));
    const byId = new Map();
    pages.flatMap(page => page.proposals || []).forEach(proposal => byId.set(String(proposal.proposalId || proposal.id), proposal));
    return Array.from(byId.values());
}

async function executeSupport({ decision, connection, keypair, runId }) {
    const amountAtomic = usdcToAtomic(decision.amount);
    const capAtomic = usdcToAtomic(String(process.env.AGENT_SUPPORT_USDC_CAP || '0.25'));
    if (amountAtomic > capAtomic) {
        throw new Error(`support amount ${decision.amount} USDC exceeds AGENT_SUPPORT_USDC_CAP`);
    }
    if (decision.type === 'pledge') {
        return ensurePledgeBookAndSet({
            connection, pledgerKeypair: keypair, proposalPda: decision.proposalAccount,
            amountAtomic, sendAndConfirm: sendAndConfirmPolling
        });
    }
    if (decision.type === 'donate') {
        return ensureDonationEscrowAndDonate({
            connection, donorKeypair: keypair, proposalPda: decision.proposalAccount, amountAtomic,
            operationId: `${runId}:${decision.proposalId}:donate`, sendAndConfirm: sendAndConfirmPolling
        });
    }
    if (decision.type === 'stake') {
        return ensureMarketAndStake({
            connection, ownerKeypair: keypair, proposalPda: decision.proposalAccount,
            stakeMint: USDC_DEVNET, side: SIDE_YES, amountAtomic, sendAndConfirm: sendAndConfirmPolling
        });
    }
    throw new Error(`unsupported support action ${decision.type}`);
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const day = args.day || new Date().toISOString().slice(0, 10);
    const apiBase = (args.api || process.env.AGENT_API_BASE || `http://localhost:${process.env.API_PORT || 3000}`).replace(/\/$/, '');
    const rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
    const personas = loadPersonas(args.persona);
    const pool = args.live ? new pg.Pool({
        host: process.env.PGHOST, port: process.env.PGPORT, user: process.env.PGUSER,
        password: process.env.PGPASSWORD, database: process.env.PGDATABASE
    }) : null;
    const connection = args.live ? new Connection(rpcUrl, 'confirmed') : null;
    const report = [];
    try {
        for (const persona of personas) {
            const runId = `${day}-${persona.name}`;
            const existing = args.live ? await getRun(pool, runId) : null;
            if (existing?.status === 'done') {
                report.push(`${persona.name}: resumed ${existing.summary?.outcome || 'completed'}`);
                continue;
            }
            const keypair = args.live ? loadKeypair(persona) : null;
            const wallet = keypair?.publicKey.toBase58() || persona.wallet || null;
            const proposals = await discoverProposals(apiBase, persona);
            const choice = selectSupportAction({ day, persona, proposals, wallet });
            console.log(`[${new Date().toISOString()}] ${persona.name}: ${choice.reason}`);
            if (args.dryRun) {
                if (choice.selected) console.log(JSON.stringify(choice.selected, null, 2));
                continue;
            }

            await startRun(pool, { runId, persona: persona.name, day, mode: 'live' });
            await updateRun(pool, runId, { stage: 'selected', status: choice.selected ? 'running' : 'done', summaryPatch: {
                role: 'supporter', controller: 'algorithm', wallet,
                decisionInput: { controller: 'algorithm', day, eligibleProposalIds: choice.eligibleProposalIds },
                decisionResult: { controller: 'algorithm', costUsd: 0, rationale: choice.reason },
                selection: choice.selected,
                outcome: choice.selected ? 'selected' : 'no-eligible-proposal'
            } });
            if (!choice.selected) {
                report.push(`${persona.name}: no eligible proposal`);
                continue;
            }

            const activities = [];
            const runtime = actionEngineApi.createEngine({
                decisionProviders: { algorithm: (_actor, context) => context.action },
                actionHandlers: { '*': (_actor, _action, context) => context.execute() },
                onActivity: activity => activities.push({ ...activity, runId, rationale: choice.selected.rationale })
            });
            const actor = { id: persona.name, name: persona.name, controller: 'algorithm', wallet };
            try {
                const execution = await runtime.run(actor, {
                    source: 'live',
                    action: {
                        type: choice.selected.type, proposalId: choice.selected.proposalId,
                        amount: choice.selected.amount, side: choice.selected.side
                    },
                    execute: () => executeSupport({ decision: choice.selected, connection, keypair, runId })
                });
                await updateRun(pool, runId, { stage: 'supported', status: 'done', summaryPatch: {
                    support: { type: choice.selected.type, proposalId: choice.selected.proposalId, proposalAccount: choice.selected.proposalAccount, ...execution.outcome },
                    activities, outcome: 'completed'
                } });
                report.push(`${persona.name}: ${choice.selected.type} ${choice.selected.amount} USDC on ${choice.selected.proposalId}`);
            } catch (error) {
                await updateRun(pool, runId, { stage: 'selected', status: 'failed', summaryPatch: {
                    activities, outcome: 'failed', error: error.message
                } });
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

main().catch(async error => {
    console.error(`[${new Date().toISOString()}] SUPPORTER FAILED:`, error);
    await sendTelegram(`Supporter agent FAILED: ${error.message}`);
    process.exit(1);
});
