#!/usr/bin/env node
// Agent runner (design §WS3): for each persona, once per UTC day — plan candidate parcels, choose
// with either the default deterministic controller or an explicitly requested LLM batch, mint each
// pick on Solana devnet with the persona keypair, post it through the paid x402 route (mint first:
// the record has no on-chain write path after creation), then stake on its market. Every stage is
// checkpointed in consensus.agent_run so a rerun never redoes a mint, payment or stake.
// Before minting anything new, the retire phase closes the persona's own stale proposals (Active,
// no acceptances, older than AGENT_RETIRE_AFTER_DAYS): cancel → resolve NO → claim the YES refund.
// With a lifecycle lens member configured (AGENT_LIFECYCLE_LENS_SERVICE_URL + _OPERATOR_TOKEN) the
// member's key joins every new mint's lens, and proposals whose lens includes it are expired by the
// member's "expired" verdict (settle_with_verdict) instead of cancelled by their author.
//
// Usage:
//   node agents/run.mjs --dry-run [--controller algorithm|llm] [--persona NAME] [--day YYYY-MM-DD]
//   node agents/run.mjs --live    [--controller algorithm|llm] [--persona NAME] [--until STAGE] [--lens KEY,KEY]
//   The lens (whose attestations decide the proposal) is --lens or, when absent, chosen from the attester
//   directory (GET /agent/lenses/members, agents/lens-directory-client.js); never the persona's own key.
//   STAGE: planned | chosen | minted | posted | staked (default staked)
// Env: PG* (run with PGHOST=localhost on the host), AGENT_DAILY_ACTION_CAP (4),
//      AGENT_RETIRE_AFTER_DAYS (7), AGENT_RETIRE_MAX_PER_RUN (3),
//      AGENT_LIFECYCLE_LENS_SERVICE_URL + AGENT_LIFECYCLE_LENS_OPERATOR_TOKEN (optional expiry verdicts),
//      AGENT_DAILY_USDC_CAP (0.35), AGENT_API_BASE (default http://localhost:$API_PORT),
//      SOLANA_RPC_URL, TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID (optional, one summary per run).
//      ANTHROPIC_API_KEY/AGENT_LLM_DAILY_CAP_USD are read only with explicit --controller llm; the model
//      is the shared LLM layer's default (agents/lib/llm-cost/defaults.json), never set here.

import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { Connection, Keypair } from '@solana/web3.js';
import * as turf from '@turf/turf';
import { fetchCandidateParcels } from './parcel-source.js';
import { planCandidates } from './planner.js';
import { buildProposalRecord } from './record-builder.js';
import { selectAlgorithmicPicks } from './algorithmic-picker.js';
import { buildPickRequests, parsePicks, estimateBatchCostUsd, runPickBatch, pickCustomId, createAgentLlm } from './llm-picker.js';
import { createPaidClient, paymentIdForProposal, postAgentProposal } from './x402-client.js';
import { mintProposal } from './minter.js';
import { resolveLens, describeLensChoice } from './lens-directory-client.js';
import { ensureMarketAndStake, usdcToAtomic } from './bettor.js';
import { getRun, startRun, updateRun, recordCosts, dailySpendUsd, assertUnderCap, dailyCapUsd, listRuns } from './ledger.js';
import { sendTelegram } from './telegram.js';
import { sendAndConfirmPolling } from './solana-send.js';
import {
    assertExecutionPlan, decisionCompletion, executionPolicy, summarizeExecutionPlan,
    retirePolicy, ownedProposalsFromRuns, retirementsSpent, planRetirements, ageInDays, lifecycleLensConfig, createAction
} from './run-policy.js';
import { fetchLensStatus } from './lens-ownership-client.js';
import { inspectRetirement, executeRetirement } from './lifecycle-actions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const actionEngineApi = require('../../frontend/js/agent-action-engine.js');

const STAGES = ['planned', 'chosen', 'minted', 'posted', 'staked'];
const CONTROLLERS = ['algorithm', 'llm'];
const PROPOSAL_NFT_PROGRAM = '3WsVS6LkLo4ySLaLvxKdwuD37fcCjE2Yu9fVh1nMfxbg';
const USDC_DEVNET = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const SIDE_YES = 1;

function usage(exitCode) {
    console.log([
        'Agent runner: plan → pick (algorithm by default, optional LLM) → mint → paid post → stake.',
        '',
        '  --dry-run            Plan and choose; write nothing, call no model, sign nothing',
        '  --live               Run for real, checkpointed in consensus.agent_run (rerun = resume)',
        '  --controller TYPE    algorithm (default, $0) or llm (explicit Anthropic batch)',
        '  --persona NAME       Only this persona (default: every persona in personas.json)',
        '  --day YYYY-MM-DD     The run day (default: today, UTC)',
        '  --candidates N       Candidates per persona offered to the controller (default 8)',
        '  --until STAGE        Stop after STAGE: planned | chosen | minted | posted | staked',
        '  --api URL            Backend base for POST /agent/proposals (default AGENT_API_BASE or http://localhost:$API_PORT)',
        '  --lens KEY,KEY       Lens member keys for every mint (default: chosen from GET /agent/lenses/members;',
        '                       an empty directory refuses to mint; the persona\'s own key alone is refused)',
        '  --help               This text'
    ].join('\n'));
    process.exit(exitCode);
}

function parseArgs(argv) {
    const args = { candidates: 8, until: 'staked', controller: 'algorithm' };
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
    if (!CONTROLLERS.includes(args.controller)) usage(2);
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
    const personas = (file.personas || []).filter((p) => (p.role || 'proposer') === 'proposer' && (!onlyName || p.name === onlyName));
    if (!personas.length) throw new Error(onlyName ? `no proposer persona named ${onlyName}` : 'personas.json lists no proposer personas');
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

// Dry-run view of the lens each persona with picks would mint with, and why; a refusal is printed,
// not thrown, so the rest of the plan stays visible.
async function logLensPlan({ entries, picksFor, args, apiBase }) {
    for (const entry of entries) {
        if (!picksFor(entry)) continue;
        try {
            const choice = withLifecycleMember(
                await resolveLens({ explicit: args.lens, proposer: entry.persona.wallet, apiBase }),
                await lifecycleMember()
            );
            log(`${entry.persona.name} ${describeLensChoice(choice)}`);
        } catch (err) {
            log(`${entry.persona.name} would REFUSE to mint: ${err.message}`);
        }
    }
}

// The configured lifecycle lens member ({ serviceUrl, operatorToken, key, credentialName }) or null.
// Its key and credential come from the member's own GET /lens/status, never from local config.
async function lifecycleMember() {
    const config = lifecycleLensConfig(process.env);
    if (!config) return null;
    const status = await fetchLensStatus({ serviceUrl: config.serviceUrl });
    return { ...config, key: status.key, credentialName: status.credentialName || undefined, kind: status.kind ?? null };
}

// A mint's lens plus the lifecycle member, so the member's expiry verdict can later settle it.
function withLifecycleMember(choice, member) {
    if (!member || choice.lens.includes(member.key)) return choice;
    return {
        ...choice,
        lens: [...choice.lens, member.key],
        reason: `${choice.reason}; + lifecycle member ${member.key} (AGENT_LIFECYCLE_LENS_SERVICE_URL) for expiry verdicts`
    };
}

// Retire phase. Proposals come from this persona's own agent_run rows (age = the row's run `day`);
// their state comes from the chain, so a rerun skips whatever is already cancelled/resolved/claimed.
// Retirement signatures share AGENT_DAILY_ACTION_CAP with the day's proposal: they get only what the
// proposal plan (and any retirement already signed today) leaves over, and the run says what waits.
async function retireStage({ pool, connection, entries, day, dryRun, controller, plannedActions, failures, report }) {
    const policy = executionPolicy(process.env);
    const retire = retirePolicy(process.env);
    const runs = await listRuns(pool);
    let budget = Math.max(0, policy.maxActions - plannedActions);
    log(`retire: after ${retire.afterDays} day(s) · ≤ ${retire.maxPerRun} per run · ${budget}/${policy.maxActions} signed actions left after ${plannedActions} planned for proposing`);
    // Configured but unreachable is a failure, not a silent switch back to cancelling.
    let lifecycle = null;
    try {
        lifecycle = await lifecycleMember();
    } catch (err) {
        log(`retire: lifecycle lens member unavailable, nothing retired this run: ${err.message}`);
        failures.push(`retire lifecycle member: ${err.message}`);
        return;
    }
    log(lifecycle
        ? `retire: proposals whose lens includes lifecycle member ${lifecycle.key} (${lifecycle.serviceUrl}) are EXPIRED by its verdict; the rest are cancelled`
        : 'retire: no lifecycle lens member configured (AGENT_LIFECYCLE_LENS_SERVICE_URL); stale proposals are cancelled by their author');
    for (const e of entries) {
        const persona = e.persona;
        const owned = ownedProposalsFromRuns(runs, persona.name, day);
        const signer = dryRun ? null : loadKeypair(persona.keypairPath).keypair;
        const owner = signer ? signer.publicKey.toBase58() : persona.wallet;
        const summary = e.run?.summary ?? {};
        const retirements = { ...(summary.retirements ?? {}) };
        const spent = retirementsSpent(retirements);
        const inspections = [];
        let young = 0;
        for (const proposal of owned) {
            // Too young to retire and not already cancelled by hand: no chain read needed.
            const ageDays = ageInDays(proposal.sourceDay, day);
            if (ageDays !== null && ageDays < retire.afterDays && !retirements[proposal.proposalPda]) { young += 1; continue; }
            try {
                inspections.push(await inspectRetirement({ connection, owner, proposal, lifecycleMember: lifecycle }));
            } catch (err) {
                log(`${persona.name} retire: could not read ${proposal.proposalId} ${proposal.proposalPda}: ${err.message}`);
                failures.push(`${persona.name} retire inspect ${proposal.proposalId}: ${err.message}`);
            }
        }
        const plan = planRetirements(inspections, { policy: retire, runDay: day, actionBudget: budget, spent });
        budget = Math.max(0, budget - plan.actions);
        const counts = plan.skipped.reduce((acc, item) => ({ ...acc, [item.reason]: (acc[item.reason] ?? 0) + 1 }), {});
        log(`${persona.name} retire: ${owned.length} own proposal(s) · ${young} younger than ${retire.afterDays}d · ${plan.selected.length} to retire (${plan.actions} signed action(s)) · skipped ${JSON.stringify(counts)}`);
        for (const item of plan.selected) {
            log(`   ${dryRun ? 'would retire' : 'retire'} ${item.proposalId} ${item.proposalPda} · ${item.ageDays}d old · ${item.steps.join(' → ')}${item.note ? ` · ${item.note}` : ''}`);
        }
        if (plan.limited) {
            log(`   ${plan.limited} eligible proposal(s) deferred: per-run cap ${retire.maxPerRun} or action cap (${plan.budget} left) reached; they retire on a later run`);
        }
        if (dryRun || !plan.selected.length) {
            if (plan.selected.length || plan.limited) report.push(`${persona.name}: ${dryRun ? 'would retire' : 'retired'} ${plan.selected.length}${plan.limited ? ` (${plan.limited} deferred)` : ''}`);
            continue;
        }

        const activities = Array.isArray(summary.activities) ? [...summary.activities] : [];
        const runtime = actionEngineApi.createEngine({
            decisionProviders: {
                algorithm: (_actor, context) => context.action,
                llm: (_actor, context) => context.action
            },
            actionHandlers: { '*': (_actor, _action, context) => context.execute() },
            onActivity: activity => activities.push(activity)
        });
        const actor = {
            id: persona.name, name: persona.name,
            controller: summary.controller || (summary.model ? 'llm' : controller), wallet: owner
        };
        const retirePlan = {
            policy: retire, day, budget: plan.budget,
            selected: plan.selected.map(item => ({ proposalId: item.proposalId, proposalPda: item.proposalPda, ageDays: item.ageDays, steps: item.steps })),
            skipped: plan.skipped
        };
        let retired = 0;
        for (const item of plan.selected) {
            try {
                await executeRetirement({
                    connection, ownerKeypair: signer, item, record: retirements[item.proposalPda] ?? {},
                    lifecycle: lifecycle ? { ...lifecycle, afterDays: retire.afterDays, evidenceRef: `agent-retire:no-acceptances:${retire.afterDays}d` } : null,
                    sendAndConfirm: sendAndConfirmPolling,
                    perform: async (action, execute) => (await runtime.run(actor, { action, execute, source: 'live' })).outcome,
                    checkpoint: async (record) => {
                        retirements[item.proposalPda] = record;
                        e.run = await updateRun(pool, e.runId, { summaryPatch: { retirements, retirePlan, activities } });
                    }
                });
                retirements[item.proposalPda] = { ...retirements[item.proposalPda], completedAt: new Date().toISOString() };
                e.run = await updateRun(pool, e.runId, { summaryPatch: { retirements, retirePlan, activities } });
                retired += 1;
                const done = retirements[item.proposalPda];
                log(`${persona.name} retired ${item.proposalId}: ${done.expiry ? `expire ${done.expiry.signature ?? 'replayed'} (verdict ${done.expiry.verdictAttestation})` : `cancel ${done.cancel?.signature ?? '-'}`} · resolve ${done.resolution?.signature ?? '-'} (${done.resolution?.outcome ?? 'not needed'}) · claim ${done.claim?.signature ?? done.claim?.reason ?? '-'}`);
            } catch (err) {
                failures.push(`${persona.name} retire ${item.proposalId}: ${err.message}`);
            }
        }
        report.push(`${persona.name}: retired ${retired}/${plan.selected.length}${plan.limited ? ` (${plan.limited} deferred)` : ''}`);
    }
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const day = args.day || todayUtc();
    const controller = args.controller;
    // The shared layer picks the model. Constructing the client sends nothing, so a dry run with
    // --controller llm still builds (and prices) the exact batch lines without an API key.
    let llm = null;
    if (controller === 'llm') {
        const { default: Anthropic } = await import('@anthropic-ai/sdk');
        llm = createAgentLlm({ client: new Anthropic(), meta: { runId: day } });
    }
    const model = llm ? llm.model : null;
    const apiBase = (args.api || process.env.AGENT_API_BASE || `http://localhost:${process.env.API_PORT || 3000}`).replace(/\/$/, '');
    const rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
    const personas = loadPersonas(args.persona);
    const pool = new pg.Pool({
        host: process.env.PGHOST, port: process.env.PGPORT, user: process.env.PGUSER,
        password: process.env.PGPASSWORD, database: process.env.PGDATABASE
    });
    const mode = args.dryRun ? 'dry-run' : 'live';
    log(`${mode} · day ${day} · ${personas.length} persona(s) · controller ${controller}${llm ? ` (${llm.model}, effort ${llm.effort})` : ' ($0 model spend)'} · api ${apiBase}`);

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
                run = await updateRun(pool, runId, { stage: 'planned', status: 'running', summaryPatch: {
                    candidates, city: persona.areas?.[0]?.city ?? 'zagreb', wallet: persona.wallet,
                    controller, ...(model ? { model } : {})
                } });
            }
            entries.push({ persona, runId, run, candidates });
        }

        // ---- stage 2: choose ---------------------------------------------------------------
        const needDecision = entries.filter((e) => !Array.isArray(e.run?.summary?.picks));
        if (controller === 'algorithm') {
            const decisions = new Map(needDecision.map((entry) => [
                entry.persona.name,
                selectAlgorithmicPicks({ day, persona: entry.persona, candidates: entry.candidates })
            ]));
            for (const e of needDecision) {
                const decision = decisions.get(e.persona.name);
                log(`${e.persona.name} algorithm: ${decision.picks.length} pick(s) from ${decision.policy.eligibleCandidateIds.length} eligible candidates · $0 model spend`);
                for (const pick of decision.picks) log(`   ${pick.candidateId}: ${pick.name}`);
            }
            if (args.dryRun) {
                await logLensPlan({ entries, args, apiBase, picksFor: entry => decisions.get(entry.persona.name)?.picks?.length });
                await retireStage({
                    pool, connection: new Connection(rpcUrl, 'confirmed'), entries, day, dryRun: true, controller,
                    plannedActions: summarizeExecutionPlan(entries.map(entry => ({
                        persona: entry.persona, run: { summary: { picks: decisions.get(entry.persona.name)?.picks ?? [] } }
                    }))).actionCount,
                    failures, report
                });
                log('dry run: nothing written, no model called, nothing signed');
                return;
            }
            if (stageIndex(args.until) < stageIndex('chosen')) return;

            for (const e of needDecision) {
                const decision = decisions.get(e.persona.name);
                const withIds = decision.picks.map((pick, index) => ({
                    ...pick, proposalId: proposalIdFor(e.persona, day, index)
                }));
                const completion = decisionCompletion(withIds);
                e.run = await updateRun(pool, e.runId, { stage: 'chosen', status: completion.status, summaryPatch: {
                    controller: 'algorithm',
                    picks: withIds,
                    rejectedPicks: decision.rejected,
                    pickCostUsd: 0,
                    decisionInput: {
                        controller: 'algorithm', day,
                        candidateIds: e.candidates.map(candidate => candidate.candidateId)
                    },
                    decisionResult: { controller: 'algorithm', costUsd: 0, policy: decision.policy },
                    ...(completion.outcome ? { outcome: completion.outcome } : {})
                } });
                log(`${e.persona.name} chosen: ${withIds.length} pick(s) · $0.0000`);
                for (const pick of withIds) log(`   ${pick.proposalId} ← ${pick.candidateId}: ${pick.name}`);
                if (completion.noPicks) report.push(`${e.persona.name}: no proposal selected · $0.0000`);
            }
        } else {
            const needPicks = needDecision.filter((entry) => entry.candidates.length);
            const requests = buildPickRequests({ llm, runId: `${day}`, day, entries: needPicks });
            const requestsByPersona = new Map(needPicks.map((entry, index) => [entry.persona.name, requests[index]]));
            const estimate = estimateBatchCostUsd(requests);
            const spent = args.live ? await dailySpendUsd(pool, day) : 0;
            const cap = dailyCapUsd(process.env);
            log(`batch: ${requests.length} request(s) · estimated ≤ $${estimate.toFixed(4)} · spent today $${spent.toFixed(4)} · cap $${cap}`);
            if (args.dryRun) {
                // The model is not called in a dry run, so assume each persona uses its full daily quota.
                await logLensPlan({ entries, args, apiBase, picksFor: entry => entry.candidates.length });
                await retireStage({
                    pool, connection: new Connection(rpcUrl, 'confirmed'), entries, day, dryRun: true, controller,
                    plannedActions: summarizeExecutionPlan(entries.map(entry => ({
                        persona: entry.persona,
                        run: { summary: { picks: Array.from({ length: entry.persona.dailyProposals ?? 1 }, (_, index) => ({ proposalId: `planned-${index + 1}` })) } }
                    }))).actionCount,
                    failures, report
                });
                log('dry run: nothing written, no model called, nothing signed');
                return;
            }
            if (stageIndex(args.until) < stageIndex('chosen')) return;

            if (needPicks.length) {
                assertUnderCap({ spentUsd: spent, estimateUsd: estimate, capUsd: cap });
                for (const e of needPicks) {
                    const request = requestsByPersona.get(e.persona.name);
                    if (!request) continue;
                    e.run = await updateRun(pool, e.runId, { status: 'running', summaryPatch: {
                        decisionInput: {
                            controller: 'llm',
                            customId: request.custom_id,
                            model: request.params.model,
                            maxTokens: request.params.max_tokens,
                            systemPrompt: request.params.system,
                            userPrompt: request.params.messages?.[0]?.content?.[0]?.text ?? null
                        }
                    } });
                }
                const existingBatchId = needPicks.find((e) => e.run?.summary?.batchId)?.run.summary.batchId ?? null;
                const batch = await runPickBatch({
                    llm, requests, existingBatchId,
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
                    // A refused or truncated item was still paid for: its cost reaches the daily cap either way.
                    if (result && typeof result.costUsd === 'number') {
                        await recordCosts(pool, e.runId, [{ item: result.customId, provider: 'anthropic', model: result.model || model, batchId: batch.batchId, usage: result.usage, usd: result.costUsd }]);
                    }
                    if (!result || result.error) {
                        failures.push(`${e.persona.name}: batch item ${result?.error ?? 'missing'}`);
                        await updateRun(pool, e.runId, { status: 'failed', summaryPatch: {
                            outcome: 'failed', error: result?.error ?? 'batch item missing'
                        } });
                        continue;
                    }
                    const { picks, rejected } = parsePicks(result.text, e.candidates, e.persona.dailyProposals);
                    const withIds = picks.map((pick, index) => ({ ...pick, proposalId: proposalIdFor(e.persona, day, index) }));
                    const completion = decisionCompletion(withIds);
                    e.run = await updateRun(pool, e.runId, { stage: 'chosen', status: completion.status, summaryPatch: {
                        controller: 'llm',
                        picks: withIds,
                        rejectedPicks: rejected,
                        pickCostUsd: result.costUsd ?? null,
                        decisionResult: { controller: 'llm', model: result.model || model, batchId: batch.batchId, usage: result.usage ?? null, costUsd: result.costUsd ?? null },
                        ...(completion.outcome ? { outcome: completion.outcome } : {})
                    } });
                    log(`${e.persona.name} chosen: ${withIds.length} pick(s) (${rejected.length} rejected) · $${(result.costUsd ?? 0).toFixed(4)}`);
                    for (const pick of withIds) log(`   ${pick.proposalId} ← ${pick.candidateId}: ${pick.name}`);
                    if (completion.noPicks) report.push(`${e.persona.name}: no proposal selected · $${(result.costUsd ?? 0).toFixed(4)}`);
                }
            }
        }
        if (stageIndex(args.until) < stageIndex('minted')) return;

        // ---- stages 3–5 per persona: mint → post → stake --------------------------------------
        const policy = executionPolicy(process.env);
        const executionPlan = assertExecutionPlan(summarizeExecutionPlan(entries, policy), policy);
        log(`execution policy: ${executionPlan.actionCount}/${policy.maxActions} signed actions · ≤ ${executionPlan.maxUsdc.toFixed(2)}/${policy.maxUsdc.toFixed(2)} USDC`);
        const connection = new Connection(rpcUrl, 'confirmed');

        // ---- retire phase: close stale own proposals before minting anything new -------------
        await retireStage({
            pool, connection, entries, day, dryRun: false, controller,
            plannedActions: executionPlan.actionCount, failures, report
        });
        for (const e of entries.filter(entry => entry.run?.summary?.picks?.length)) {
            e.run = await updateRun(pool, e.runId, { status: 'running', summaryPatch: {
                executionPolicy: policy,
                executionPlan: {
                    proposalCount: executionPlan.proposals.filter(item => item.persona === e.persona.name).length,
                    actions: executionPlan.proposals.filter(item => item.persona === e.persona.name).reduce((sum, item) => sum + item.actions, 0),
                    maxUsdc: executionPlan.proposals.filter(item => item.persona === e.persona.name).reduce((sum, item) => sum + item.usdc, 0)
                }
            } });
        }
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
            const runController = summary.controller || (summary.model ? 'llm' : controller);
            let personaFailed = false;
            const runtime = actionEngineApi.createEngine({
                decisionProviders: {
                    algorithm: (_actor, context) => context.action,
                    llm: (_actor, context) => context.action
                },
                actionHandlers: { '*': (_actor, _action, context) => context.execute() },
                onActivity: activity => activities.push(activity)
            });
            const actor = {
                id: persona.name, name: persona.name, controller: runController, wallet: keypair.publicKey.toBase58()
            };
            const runAction = async (action, execute) => {
                const result = await runtime.run(actor, { action, execute, source: 'live' });
                return result.outcome;
            };

            // The lens is chosen once per persona-day and checkpointed, so a resumed run mints with the
            // same authorities. No lens → no mint (never a silent self-lens).
            let lensChoice = summary.lensChoice ?? null;
            if (!lensChoice && picks.some(pick => !mints[pick.candidateId])) {
                try {
                    lensChoice = withLifecycleMember(
                        await resolveLens({ explicit: args.lens, proposer: keypair.publicKey.toBase58(), apiBase }),
                        await lifecycleMember()
                    );
                    await updateRun(pool, e.runId, { status: 'running', summaryPatch: { lensChoice } });
                    log(`${persona.name} ${describeLensChoice(lensChoice)}`);
                } catch (err) {
                    failures.push(`${persona.name} lens: ${err.message}`);
                    personaFailed = true;
                }
            }

            for (const [k, pick] of (personaFailed ? [] : picks.entries())) {
                const candidate = e.candidates.find((c) => c.candidateId === pick.candidateId);
                if (!candidate) { failures.push(`${persona.name}: pick ${pick.candidateId} has no candidate`); continue; }
                const tag = `${persona.name} ${k + 1}/${picks.length} ${pick.proposalId}`;

                // mint
                if (!mints[pick.candidateId]) {
                    try {
                        const minted = await runAction(createAction({ proposalId: pick.proposalId, lens: lensChoice.lens }), () => mintProposal({
                            connection, programId: PROPOSAL_NFT_PROGRAM, ownerKeypair: keypair,
                            parcelIds: [candidate.parcelId], isConditional: true,
                            imageUri: `${apiBase}/proposals/${pick.proposalId}`, lamports: 0n, lens: lensChoice.lens,
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
                        const paymentId = paymentIdForProposal(pick.proposalId);
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
                            const body = buildProposalRecord({
                                candidate, pick, persona: { ...persona, controller: runController },
                                runId: e.runId, city, onchain, turf
                            });
                            const { paidFetch } = await createPaidClient({
                                secretKey: secret,
                                paymentId,
                                rpcUrl
                            });
                            const response = await postAgentProposal({ baseUrl: apiBase, paidFetch, body });
                            if (response.status !== 201) {
                                throw new Error(`HTTP ${response.status}: ${typeof response.body === 'string' ? response.body : JSON.stringify(response.body)}`);
                            }
                            return response;
                        });
                        posts[pick.candidateId] = {
                            id: res.body.id,
                            proposalId: res.body.proposalId ?? pick.proposalId,
                            paymentId,
                            status: res.status,
                            tx: res.receipt?.transaction ?? null
                        };
                        await updateRun(pool, e.runId, { stage: 'minted', status: 'running', summaryPatch: { posts, activities } });
                        log(`${tag} posted: row ${res.body.id} (${res.status}) paid tx ${res.receipt?.transaction ?? '-'}`);
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
                summaryPatch: {
                    mints, posts, stakes, activities,
                    outcome: personaFailed ? 'failed' : (done && untilStage === 'staked' ? 'completed' : 'partial')
                }
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
    // This exact line is the external monitor's success sentinel. It is emitted only after every
    // persona has reached a non-failing terminal path, including the valid zero-pick outcome.
    log(`AGENT DAILY RUN — status=completed day=${day} personas=${personas.length}`);
    await sendTelegram(headline);
}

main().catch(async (err) => {
    console.error(`[${new Date().toISOString()}] FAILED:`, err);
    await sendTelegram(`Agents runner FAILED: ${err.message}`);
    process.exit(1);
});
