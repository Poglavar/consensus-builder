#!/usr/bin/env node
// Agent runner (design §WS3): for each persona, once per UTC day — plan candidate parcels, let the
// model pick and write rationales in ONE Batches API job, mint each pick on Solana devnet with the
// persona keypair, post it through the paid x402 route (mint first: the record has no on-chain write
// path after creation), then stake on its market. Every stage is checkpointed in consensus.agent_run
// so a rerun resumes where it stopped and never redoes a mint, a payment or a stake.
//
// Usage:
//   node agents/run.mjs --dry-run [--persona NAME] [--day YYYY-MM-DD] [--candidates N]
//   node agents/run.mjs --live    [--persona NAME] [--day YYYY-MM-DD] [--until STAGE] [--api URL]
//   STAGE: planned | chosen | minted | posted | staked (default staked)
// Env: PG* (run with PGHOST=localhost on the host), ANTHROPIC_API_KEY, AGENT_LLM_MODEL,
//      AGENT_LLM_DAILY_CAP_USD (1000), AGENT_API_BASE (default http://localhost:$API_PORT),
//      SOLANA_RPC_URL, TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID (optional, one summary per run).

import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import Anthropic from '@anthropic-ai/sdk';
import { Connection, Keypair } from '@solana/web3.js';
import * as turf from '@turf/turf';
import { fetchCandidateParcels } from './parcel-source.js';
import { planCandidates } from './planner.js';
import { buildProposalRecord } from './record-builder.js';
import { buildPickRequests, parsePicks, estimateBatchCostUsd, runPickBatch, pickCustomId, DEFAULT_MODEL } from './llm-picker.js';
import { createPaidClient, paymentIdForProposal, postAgentProposal } from './x402-client.js';
import { mintProposal } from './minter.js';
import { ensureMarketAndStake, usdcToAtomic } from './bettor.js';
import { getRun, startRun, updateRun, recordCosts, dailySpendUsd, assertUnderCap, dailyCapUsd } from './ledger.js';
import { sendTelegram } from './telegram.js';
import { sendAndConfirmPolling } from './solana-send.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const actionEngineApi = require('../../frontend/js/agent-action-engine.js');

const STAGES = ['planned', 'chosen', 'minted', 'posted', 'staked'];
const PROPOSAL_NFT_PROGRAM = '3WsVS6LkLo4ySLaLvxKdwuD37fcCjE2Yu9fVh1nMfxbg';
const USDC_DEVNET = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const SIDE_YES = 1;

function usage(exitCode) {
    console.log([
        'Agent runner: plan → pick (LLM batch) → mint → paid post → stake, per persona per UTC day.',
        '',
        '  --dry-run            Plan and estimate the batch cost; write nothing, call no model, sign nothing',
        '  --live               Run for real, checkpointed in consensus.agent_run (rerun = resume)',
        '  --persona NAME       Only this persona (default: every persona in personas.json)',
        '  --day YYYY-MM-DD     The run day (default: today, UTC)',
        '  --candidates N       Candidates per persona offered to the model (default 8)',
        '  --until STAGE        Stop after STAGE: planned | chosen | minted | posted | staked',
        '  --api URL            Backend base for POST /agent/proposals (default AGENT_API_BASE or http://localhost:$API_PORT)',
        '  --help               This text'
    ].join('\n'));
    process.exit(exitCode);
}

function parseArgs(argv) {
    const args = { candidates: 8, until: 'staked' };
    for (let i = 0; i < argv.length; i += 1) {
        const token = argv[i];
        if (token === '--help') usage(0);
        if (token === '--dry-run') { args.dryRun = true; continue; }
        if (token === '--live') { args.live = true; continue; }
        if (!token.startsWith('--')) usage(2);
        const value = argv[i + 1];
        if (value === undefined || value.startsWith('--')) usage(2);
        const key = token.slice(2);
        args[key] = key === 'candidates' ? Number(value) : value;
        i += 1;
    }
    if (Boolean(args.dryRun) === Boolean(args.live)) {
        console.error('choose exactly one of --dry-run or --live');
        usage(2);
    }
    if (!STAGES.includes(args.until)) usage(2);
    if (!Number.isInteger(args.candidates) || args.candidates < 1) usage(2);
    return args;
}

function log(message) {
    console.log(`[${new Date().toISOString()}] ${message}`);
}

function todayUtc() {
    return new Date().toISOString().slice(0, 10);
}

function loadPersonas(onlyName) {
    const file = JSON.parse(fs.readFileSync(path.join(__dirname, 'personas.json'), 'utf8'));
    const personas = (file.personas || []).filter((p) => !onlyName || p.name === onlyName);
    if (!personas.length) throw new Error(onlyName ? `no persona named ${onlyName}` : 'personas.json lists no personas');
    return personas;
}

function loadKeypair(keypairPath) {
    const resolved = keypairPath.startsWith('~') ? path.join(os.homedir(), keypairPath.slice(1)) : keypairPath;
    const secret = new Uint8Array(JSON.parse(fs.readFileSync(resolved, 'utf8')));
    return { secret, keypair: Keypair.fromSecretKey(secret) };
}

function stageIndex(stage) {
    return stage ? STAGES.indexOf(stage) : -1;
}

// summary.picks carry a deterministic proposalId. It also derives the x402 payment identifier, so
// a retry of a completed post returns the original 201 without another settlement.
function proposalIdFor(persona, day, index) {
    return `agent-${persona.name}-${day}-${index + 1}`;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const day = args.day || todayUtc();
    const model = process.env.AGENT_LLM_MODEL || DEFAULT_MODEL;
    const apiBase = (args.api || process.env.AGENT_API_BASE || `http://localhost:${process.env.API_PORT || 3000}`).replace(/\/$/, '');
    const rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
    const personas = loadPersonas(args.persona);
    const pool = new pg.Pool({
        host: process.env.PGHOST, port: process.env.PGPORT, user: process.env.PGUSER,
        password: process.env.PGPASSWORD, database: process.env.PGDATABASE
    });
    const mode = args.dryRun ? 'dry-run' : 'live';
    log(`${mode} · day ${day} · ${personas.length} persona(s) · model ${model} · api ${apiBase}`);

    const failures = [];
    const report = [];
    try {
        // ---- stage 1: plan (every persona) ----------------------------------------------------
        const entries = [];
        for (const [i, persona] of personas.entries()) {
            const runId = `${day}-${persona.name}`;
            const existing = args.live ? await getRun(pool, runId) : null;
            if (existing && stageIndex(existing.stage) >= stageIndex('planned') && existing.summary?.candidates?.length) {
                log(`${persona.name} ${i + 1}/${personas.length} planned: resumed ${existing.summary.candidates.length} candidates from ${runId}`);
                entries.push({ persona, runId, run: existing, candidates: existing.summary.candidates });
                continue;
            }
            const parcels = [];
            const seen = new Set();
            for (const area of persona.areas || []) {
                const rows = await fetchCandidateParcels(pool, { city: area.city, bbox: area.bbox, limit: args.candidates * 6 });
                for (const row of rows) if (!seen.has(row.parcelId)) { seen.add(row.parcelId); parcels.push(row); }
            }
            const planned = planCandidates(parcels, persona, { turf, limit: args.candidates * 2, seed: Number(day.replace(/-/g, '')) });
            // The default envelope for a parcel without a stated rule (5 floors) is taller than anything
            // the 2025 GUP actually says in this bbox (3), so rule-backed candidates come first and the
            // default-rule ones are only used when nothing else is on offer.
            const ruleBacked = planned.filter((c) => c.rule?.source === 'urban-rule');
            const candidates = (ruleBacked.length ? ruleBacked : planned).slice(0, args.candidates);
            log(`${persona.name} ${i + 1}/${personas.length} planned: ${parcels.length} parcels → ${candidates.length} candidates`);
            for (const c of candidates) {
                log(`   ${c.parcelId} ${c.koName ?? ''} ${Math.round(c.areaM2)} m² · built ${Math.round(c.builtGfaM2)} m² → ${Math.round(c.proposedGfaM2)} m² (${c.allowedFloors} fl) · gain €${Math.round(c.gainEur)} · offer €${c.offerEur} · score ${c.score.toFixed(3)}`);
            }
            let run = null;
            if (args.live) {
                await startRun(pool, { runId, persona: persona.name, day, mode });
                run = await updateRun(pool, runId, { stage: 'planned', status: 'running', summaryPatch: { candidates, city: persona.areas?.[0]?.city ?? 'zagreb' } });
            }
            entries.push({ persona, runId, run, candidates });
        }

        // ---- stage 2: choose (ONE batch for all personas) ------------------------------------
        const needPicks = entries.filter((e) => e.candidates.length && !(e.run?.summary?.picks));
        const requests = buildPickRequests({ runId: `${day}`, day, entries: needPicks, model });
        const estimate = estimateBatchCostUsd(requests, model);
        const spent = args.live ? await dailySpendUsd(pool, day) : 0;
        const cap = dailyCapUsd(process.env);
        log(`batch: ${requests.length} request(s) · estimated ≤ $${estimate.toFixed(4)} · spent today $${spent.toFixed(4)} · cap $${cap}`);
        if (args.dryRun) {
            log('dry run: nothing written, no model called, nothing signed');
            return;
        }
        if (stageIndex(args.until) < stageIndex('chosen')) return;

        if (needPicks.length) {
            assertUnderCap({ spentUsd: spent, estimateUsd: estimate, capUsd: cap });
            const existingBatchId = needPicks.find((e) => e.run?.summary?.batchId)?.run.summary.batchId ?? null;
            const client = new Anthropic();
            const batch = await runPickBatch({
                client, requests, model, runId: day, existingBatchId,
                onProgress: (p) => log(`batch ${p.batchId ?? ''}: ${p.status ?? ''} ${p.succeeded ?? 0} ok / ${p.errored ?? 0} err / ${p.processing ?? 0} processing`)
            });
            for (const e of needPicks) {
                await updateRun(pool, e.runId, { stage: 'planned', status: 'running', summaryPatch: { batchId: batch.batchId } });
            }
            if (!batch.done) {
                log(`batch ${batch.batchId} still processing — checkpointed; rerun later to continue`);
                return;
            }
            for (const e of needPicks) {
                const result = batch.results.find((r) => r.customId === pickCustomId(day, e.persona.name));
                if (!result || result.error) {
                    failures.push(`${e.persona.name}: batch item ${result?.error ?? 'missing'}`);
                    await updateRun(pool, e.runId, { status: 'failed', summaryPatch: { error: result?.error ?? 'batch item missing' } });
                    continue;
                }
                if (typeof result.costUsd === 'number') {
                    await recordCosts(pool, e.runId, [{ item: result.customId, provider: 'anthropic', model, batchId: batch.batchId, usage: result.usage, usd: result.costUsd }]);
                }
                const { picks, rejected } = parsePicks(result.text, e.candidates, e.persona.dailyProposals);
                const withIds = picks.map((p, idx) => ({ ...p, proposalId: proposalIdFor(e.persona, day, idx) }));
                e.run = await updateRun(pool, e.runId, { stage: 'chosen', status: 'running', summaryPatch: { picks: withIds, rejectedPicks: rejected, pickCostUsd: result.costUsd ?? null } });
                log(`${e.persona.name} chosen: ${withIds.length} pick(s) (${rejected.length} rejected) · $${(result.costUsd ?? 0).toFixed(4)}`);
                for (const p of withIds) log(`   ${p.proposalId} ← ${p.candidateId}: ${p.name}`);
            }
        }
        if (stageIndex(args.until) < stageIndex('minted')) return;

        // ---- stages 3–5 per persona: mint → post → stake --------------------------------------
        const connection = new Connection(rpcUrl, 'confirmed');
        for (const e of entries) {
            const persona = e.persona;
            const summary = e.run?.summary ?? {};
            const picks = summary.picks ?? [];
            if (!picks.length) continue;
            const { secret, keypair } = loadKeypair(persona.keypairPath);
            const mints = { ...(summary.mints ?? {}) };
            const posts = { ...(summary.posts ?? {}) };
            const stakes = { ...(summary.stakes ?? {}) };
            const activities = Array.isArray(summary.activities) ? [...summary.activities] : [];
            const city = summary.city ?? 'zagreb';
            let personaFailed = false;
            const runtime = actionEngineApi.createEngine({
                decisionProviders: { llm: (_actor, context) => context.action },
                actionHandlers: { '*': (_actor, _action, context) => context.execute() },
                onActivity: activity => activities.push(activity)
            });
            const actor = {
                id: persona.name, name: persona.name, controller: 'llm', wallet: keypair.publicKey.toBase58()
            };
            const runAction = async (action, execute) => {
                const result = await runtime.run(actor, { action, execute, source: 'live' });
                return result.outcome;
            };

            for (const [k, pick] of picks.entries()) {
                const candidate = e.candidates.find((c) => c.candidateId === pick.candidateId);
                if (!candidate) { failures.push(`${persona.name}: pick ${pick.candidateId} has no candidate`); continue; }
                const tag = `${persona.name} ${k + 1}/${picks.length} ${pick.proposalId}`;

                // mint
                if (!mints[pick.candidateId]) {
                    try {
                        const minted = await runAction({ type: 'create', proposalId: pick.proposalId }, () => mintProposal({
                            connection, programId: PROPOSAL_NFT_PROGRAM, ownerKeypair: keypair,
                            parcelIds: [candidate.parcelId], isConditional: true,
                            imageUri: `${apiBase}/proposals/${pick.proposalId}`, lamports: 0n, lens: [keypair.publicKey.toBase58()],
                            sendAndConfirm: sendAndConfirmPolling
                        }));
                        mints[pick.candidateId] = { ...minted, count: minted.count === undefined ? undefined : String(minted.count) };
                        await updateRun(pool, e.runId, { stage: 'chosen', status: 'running', summaryPatch: { mints, activities } });
                        log(`${tag} minted: pda ${minted.proposalPda} tx ${minted.signature}`);
                    } catch (err) {
                        failures.push(`${tag} mint: ${err.message}`);
                        personaFailed = true;
                        break;
                    }
                }
                if (stageIndex(args.until) < stageIndex('posted')) continue;

                // post (paid)
                if (!posts[pick.candidateId]) {
                    try {
                        // The minter reports the account as proposalPda; the record (and the app's
                        // isProposalMinted) expects onchain.proposalId. Map explicitly — a null here
                        // would store a record that looks minted and points nowhere.
                        const res = await runAction({ type: 'publish', proposalId: pick.proposalId }, async () => {
                            const mint = mints[pick.candidateId];
                            const onchain = {
                                transactionHash: mint.transactionHash ?? mint.signature,
                                proposalId: mint.proposalPda,
                                chainId: mint.chainId ?? 'solana-devnet',
                                contractAddress: mint.contractAddress ?? PROPOSAL_NFT_PROGRAM
                            };
                            const body = buildProposalRecord({ candidate, pick, persona, runId: e.runId, city, onchain, turf });
                            const { paidFetch } = await createPaidClient({
                                secretKey: secret,
                                paymentId: paymentIdForProposal(body.proposalId),
                                rpcUrl
                            });
                            return postAgentProposal({ baseUrl: apiBase, paidFetch, body });
                        });
                        if (res.status === 201) {
                            posts[pick.candidateId] = { id: res.body.id, proposalId: res.body.proposalId ?? pick.proposalId, status: res.status, tx: res.receipt?.transaction ?? null };
                            await updateRun(pool, e.runId, { stage: 'minted', status: 'running', summaryPatch: { posts, activities } });
                            log(`${tag} posted: row ${res.body.id} (${res.status}) paid tx ${res.receipt?.transaction ?? '-'}`);
                        } else {
                            throw new Error(`HTTP ${res.status}: ${typeof res.body === 'string' ? res.body : JSON.stringify(res.body)}`);
                        }
                    } catch (err) {
                        failures.push(`${tag} post: ${err.message}`);
                        personaFailed = true;
                        break;
                    }
                }
                if (stageIndex(args.until) < stageIndex('staked')) continue;

                // stake YES on its own proposal
                if (!stakes[pick.candidateId]) {
                    try {
                        const staked = await runAction({ type: 'stake', proposalId: pick.proposalId, amount: persona.stakeUsdc, side: 'yes' }, () => ensureMarketAndStake({
                            connection, ownerKeypair: keypair, proposalPda: mints[pick.candidateId].proposalPda,
                            stakeMint: USDC_DEVNET, side: SIDE_YES, amountAtomic: usdcToAtomic(String(persona.stakeUsdc)),
                            sendAndConfirm: sendAndConfirmPolling
                        }));
                        stakes[pick.candidateId] = staked;
                        await updateRun(pool, e.runId, { stage: 'posted', status: 'running', summaryPatch: { stakes, activities } });
                        log(`${tag} staked ${persona.stakeUsdc} USDC YES: market ${staked.marketPda}${staked.created ? ' (created)' : ''} tx ${staked.stakeSignature}`);
                    } catch (err) {
                        failures.push(`${tag} stake: ${err.message}`);
                        personaFailed = true;
                        break;
                    }
                }
            }

            const untilStage = args.until;
            const reached = personaFailed ? null : untilStage;
            const done = Object.keys(posts).length === picks.length && (untilStage !== 'staked' || Object.keys(stakes).length === picks.length);
            await updateRun(pool, e.runId, {
                stage: reached && done ? untilStage : (Object.keys(stakes).length ? 'staked' : Object.keys(posts).length ? 'posted' : Object.keys(mints).length ? 'minted' : 'chosen'),
                status: personaFailed ? 'failed' : (done && untilStage === 'staked' ? 'done' : 'running'),
                summaryPatch: { mints, posts, stakes, activities }
            });
            report.push(`${persona.name}: ${picks.length} picks · ${Object.keys(mints).length} minted · ${Object.keys(posts).length} posted · ${Object.keys(stakes).length} staked · $${(summary.pickCostUsd ?? 0).toFixed(4)}`);
        }
    } finally {
        await pool.end();
    }

    const headline = `Agents ${day}: ${report.join(' | ') || 'nothing to do'}`;
    log(headline);
    if (failures.length) {
        const text = `${headline}\n${failures.length} FAILURE(S):\n- ${failures.join('\n- ')}`;
        console.error(text);
        await sendTelegram(text);
        process.exit(1);
    }
    await sendTelegram(headline);
}

main().catch(async (err) => {
    console.error(`[${new Date().toISOString()}] FAILED:`, err);
    await sendTelegram(`Agents runner FAILED: ${err.message}`);
    process.exit(1);
});
