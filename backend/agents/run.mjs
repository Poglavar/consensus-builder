#!/usr/bin/env node
// Agent runner (design §WS3; plan-design-agreement.md M3): for each proposer persona and run slot, plan
// candidate parcels, choose with the default deterministic controller or an explicitly requested LLM
// batch, and for each pick: build the design (a building on its parcel) → pin and index it (POST /pins,
// POST /designs) → read who owns the parcel in the lens member's devnet owner registry
// (consensus.lens_devnet_owner, lens-owner-registry.js; with --seed-owners a parcel nobody owns is first
// registered to the persona) → build the binding owners' agreement over the design (its owners decide,
// unanimously, through receipts the lens member this runner operates verifies) → pin and index it
// (POST /agreements) → mint it on Solana devnet (create + fund with the persona's escrow lamports) →
// record its chain account in the index (POST /agreements/:cid/onchain) → stake YES on its market. Every
// stage is checkpointed in consensus.agent_run, and a design or agreement is checkpointed before it leaves
// the machine, so a rerun never builds another CID, mints twice or stakes twice.
// Before anything new, the settlement phase finishes the persona's own agreements from earlier runs (so
// every market stays open for at least one run): one whose land it owns alone it decides itself — its
// approval receipt, relayed (POST /agreements/:cid/decisions) → its lens member's AgreementDecision-v1
// (POST /lens/agreements/:cid/decision, as the member's operator) → attest → execute (the escrow goes to
// the payout, the sponsor) → resolve the market YES → claim; one past its deadline it expires (escrow back
// to the sponsor) → resolve NO → claim any YES refund. A community vote is a poll in the index: it is never
// minted and has no market, so the runner proposes none.
//
// Usage:
//   node agents/run.mjs --dry-run [--controller algorithm|llm] [--persona NAME] [--day YYYY-MM-DD] [--lens NAME|KEY]
//   node agents/run.mjs --live    [--controller algorithm|llm] [--persona NAME] [--until STAGE] [--slot auto|LABEL]
//                                 [--lens NAME|KEY] [--seed-owners]
//   --slot lets a persona run several times a day: run ids and pick ids become <day>-<slot>-…
//   ("auto" = h + the UTC hour). Each run visits one of the persona's areas (a stable rotation) and a
//   ~350 m window inside it, and never re-plans a parcel the persona already published a design on. An
//   area is { city, bbox } (Croatian cadastre in the database), { city, label, sourceId, bbox } (a live
//   parcel source through GET /parcel-sources/:id), or { mode: 'contest' } (other agents' open
//   agreements, answered with a different build-out so both compete in one contest; the rival is not an
//   owner of that land, so its agreement waits for the owners and expires unless they decide).
//   Parcel reads get at most three attempts within 180 seconds, with 5s/15s backoff or the provider's
//   longer cooldown. Persistent incomplete replies fail; signed actions are not retried by this policy.
//   STAGE: planned | chosen | designed | proposed | minted | recorded | staked (default staked)
// Env: DATABASE_URL (from backend/.env), AGENT_DAILY_ACTION_CAP (4), AGENT_DAILY_USDC_CAP (0.35),
//      AGENT_SETTLE_MAX_PER_RUN (3), AGENT_API_BASE (default http://localhost:$API_PORT),
//      AGENT_MARKET_SEED_USDC_CAP (0; explicit opt-in seed allowance, separate from trade budget),
//      AGENT_APP_ORIGIN (the Origin the index writes send; default https://urbangametheory.xyz),
//      AGENT_LENS (the lens member to operate, a lens-member persona's name or key, when --lens is not
//      given; by default the one lens-member persona whose service names an operator token),
//      AGENT_LENS_SERVICE_URL (overrides that persona's service.url), the variable its
//      service.operatorTokenEnv names (e.g. AGENT_LIFECYCLE_LENS_OPERATOR_TOKEN; required live: agreement
//      decisions are operator-only), SOLANA_RPC_URL, TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID for failure alerts.
//      ANTHROPIC_API_KEY/AGENT_LLM_DAILY_CAP_USD are read only with explicit --controller llm; the model
//      is the shared LLM layer's default (agents/lib/llm-cost/defaults.json), never set here.
// Persona: `agreement: { deadlineDays, lamports }` sets each agreement's deadline (days after it is
// built) and its escrow (lamports the sponsor funds at mint and execution requires, paid back to the
// sponsor as payout at execution, or refunded at expiry); `stakeUsdc` its YES stake.

import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createPool } from '../db/connection.cjs';
import { Keypair } from '@solana/web3.js';
import * as turf from '@turf/turf';
import { fetchCandidateParcels } from './parcel-source.js';
import { findProposalPlan, contestParcels, parcelsFromSource, pickedParcelIds, rivalAgreementCids, runKeyFor, seedFor, slotLabel, windowIn } from './area-plan.js';
import { planCandidates } from './planner.js';
import { cityMoney } from '../scripts/lib/frontend-city-money.mjs';
import { planHousingCandidates, housingOutreach } from './housing-policy.js';
import { findHousingPlan } from './housing-area-search.js';
import { fetchHousingScreen } from './housing-screen.js';
import { markAgentRunFailed, safeFailureDiagnostic } from './run-failure.js';
import { fetchSourceParcels } from './source-fetch.js';
import { bindingRejection, preflightCandidates, prioritizedPlannedCandidates } from './candidate-preflight.js';
import { checkProposalBinding } from '../proposals/binding.js';
import { hash32, isEligible, selectAlgorithmicPicks } from './algorithmic-picker.js';
import { buildPickRequests, parsePicks, estimateBatchCostUsd, runPickBatch, pickCustomId, createAgentLlm } from './llm-picker.js';
import { usdcToAtomic, openAgreementMarket } from './bettor.js';
import { getRun, startRun, updateRun, recordCosts, dailySpendUsd, assertUnderCap, dailyCapUsd, listRuns, failStaleRuns, STALE_RUN_HOURS } from './ledger.js';
import { createRpcConnection } from '../solana/rpc.js';
import { ensureBotSolFunding, ensureBotUsdcFunding } from './funding.js';
import { sendAndConfirmPolling } from './solana-send.js';
import {
    assertExecutionPlan, decisionCompletion, executionPolicy, summarizeExecutionPlan,
    settlementPolicy, ownedAgreementsFromRuns, settlementsSpent, planSettlements, planningNeedsRefresh, hasPublishedWork
} from './run-policy.js';
import { inspectSettlement, executeSettlement } from './lifecycle-actions.js';
import { buildRecipe } from './record-builder.js';
import {
    agreementObject, deadlineAfterDays, designObject, holdersFromRights, mapViewFromGeometry, noMoney, ownersRule, parcelOutputs, registryRights, planForDesigns
} from './agreement-objects.js';
import { createIndexClient } from './publication-client.js';
import { mintAgreement } from './agreement-minter.js';
import { agentRegistrationNote, isSoleOwner, readParcelOwners, registerSoleOwners } from './lens-owner-registry.js';
import { ensureOwnerApproval, requestAgreementDecision } from './lens-approval-client.js';
import { isEntrypoint } from './entrypoint.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const actionEngineApi = require('../../frontend/js/agent-action-engine.js');

export const STAGES = ['planned', 'chosen', 'designed', 'proposed', 'minted', 'recorded', 'staked'];
const CONTROLLERS = ['algorithm', 'llm'];
const CLUSTER = 'devnet';
const DEFAULT_APP_ORIGIN = 'https://urbangametheory.xyz';
const PUBLIC_APP_BASE = 'https://urbangametheory.xyz';

function usage(exitCode) {
    console.log([
        'Agent runner: settle own agreements of earlier runs (approve → lens decision → attest → execute, or expire;',
        'then resolve and claim), then plan → pick (algorithm by default, optional LLM) → design → owners → binding',
        'owners\' agreement → mint → record → stake.',
        '',
        '  --dry-run            Plan and choose; write nothing, call no model, sign nothing',
        '  --live               Run for real, checkpointed in consensus.agent_run (rerun = resume)',
        '  --controller TYPE    algorithm (default, $0) or llm (explicit Anthropic batch)',
        '  --persona NAME       Only this persona (default: every proposer persona in personas.json)',
        '  --day YYYY-MM-DD     The run day (default: today, UTC)',
        '  --slot auto|LABEL    Several runs a day: run id <day>-<slot>-<persona> (auto = h + the UTC hour)',
        '  --candidates N       Candidates per persona offered to the controller (default 8)',
        `  --until STAGE        Stop after STAGE: ${STAGES.join(' | ')}`,
        '  --api URL            The index the designs and agreements are published to (default AGENT_API_BASE or http://localhost:$API_PORT)',
        '  --lens NAME|KEY      The lens member this runner operates, named by every agreement (a lens-member persona;',
        '                       default AGENT_LENS, else the one whose service names an operator token)',
        '  --seed-owners        Register the persona as the sole owner of a picked parcel nobody owns in the lens',
        '                       member\'s devnet owner registry (as scripts/seed-lens-owners.mjs does)',
        '  --help               This text'
    ].join('\n'));
    process.exit(exitCode);
}

function parseArgs(argv) {
    if (!argv.length) usage(0);
    const args = { candidates: 8, until: 'staked', controller: 'algorithm' };
    for (let i = 0; i < argv.length; i += 1) {
        const token = argv[i];
        if (token === '--help') usage(0);
        if (token === '--dry-run') { args.dryRun = true; continue; }
        if (token === '--live') { args.live = true; continue; }
        if (token === '--seed-owners') { args.seedOwners = true; continue; }
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

// Checkpoint previews can contain unknown measurements. Logging must preserve that distinction.
export function formatCandidateQuantity(value, digits = 0) {
    return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : 'unknown';
}

function log(message) {
    console.log(`[${new Date().toISOString()}] ${message}`);
}

function todayUtc() {
    return new Date().toISOString().slice(0, 10);
}

function readPersonas() {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'personas.json'), 'utf8')).personas || [];
}

function proposersOf(all, onlyName) {
    const personas = all.filter((p) => (p.role || 'proposer') === 'proposer' && (!onlyName || p.name === onlyName));
    if (!personas.length) throw new Error(onlyName ? `no proposer persona named ${onlyName}` : 'personas.json lists no proposer personas');
    return personas;
}

// The lens member this runner operates: a lens-member persona whose service names an operator token
// variable, by name or key (--lens, AGENT_LENS) or, when there is only one, by default. Every agreement
// names it; its approval facts verify the owners' receipts, and its decision (operator-only) is what the
// agreement program records before it executes.
export function operatedLens(all, choice, env = process.env) {
    const members = all.filter(p => p.role === 'lens-member' && p.wallet && p.service?.operatorTokenEnv);
    const wanted = typeof choice === 'string' && choice.trim() ? choice.trim() : null;
    const member = wanted ? members.find(p => p.name === wanted || p.wallet === wanted) : (members.length === 1 ? members[0] : null);
    if (!member) {
        const known = members.map(p => p.name).join(', ') || 'none';
        throw new Error(wanted
            ? `--lens ${wanted} is not a lens-member persona whose service names an operator token (${known}): the runner asks its own lens member for decisions`
            : `name the lens member to operate with --lens or AGENT_LENS (lens-member personas with an operator token: ${known})`);
    }
    const serviceUrl = String(env.AGENT_LENS_SERVICE_URL || member.service.url || '').trim();
    if (!serviceUrl) throw new Error(`lens member ${member.name} has no service url (personas.json service.url or AGENT_LENS_SERVICE_URL)`);
    return {
        name: member.name, key: member.wallet, serviceUrl, tokenEnv: member.service.operatorTokenEnv,
        operatorToken: String(env[member.service.operatorTokenEnv] || '').trim() || null
    };
}

function loadKeypair(keypairPath) {
    const resolved = keypairPath.startsWith('~') ? path.join(os.homedir(), keypairPath.slice(1)) : keypairPath;
    return Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(resolved, 'utf8'))));
}

export function stageIndex(stage) {
    return stage ? STAGES.indexOf(stage) : -1;
}

function logCandidatePreflight(persona, result) {
    const rejected = result.rejected.map(item => `${item.candidateId} ${item.code} bound ${item.bound}`);
    log(`${persona} binding preflight: ${result.scanned} checked · ${result.candidates.length} accepted · ${result.rejected.length} rejected${rejected.length ? ` (${rejected.join('; ')})` : ''}`);
}

// A pick's stable id: what logs, activities and the settlement phase name it by (it is not a record id).
export function pickIdFor(persona, runKey, index) {
    return `agent-${persona.name}-${runKey}-${index + 1}`;
}

// One action through the shared action engine, so it lands in the run's activity feed. The entity and
// message ride on the outcome (the engine's own defaults name proposals); they are stripped again.
function actionRunner({ persona, controller, wallet, activities }) {
    const runtime = actionEngineApi.createEngine({
        decisionProviders: {
            algorithm: (_actor, context) => context.action,
            llm: (_actor, context) => context.action
        },
        actionHandlers: { '*': (_actor, _action, context) => context.execute() },
        onActivity: activity => activities.push(activity)
    });
    const actor = { id: persona.name, name: persona.name, controller, wallet };
    return async (action, execute, { entity = null, message = null } = {}) => {
        const result = await runtime.run(actor, {
            action, source: 'live',
            execute: async () => ({ ...(await execute()), ...(entity ? { entity } : {}), ...(message ? { message } : {}) })
        });
        const { entity: _entity, message: _message, ...outcome } = result.outcome;
        return outcome;
    };
}

// The activity line of one settlement step.
export function settlementMessage(persona, lens, item, type) {
    const cid = item.cid;
    switch (type) {
    case 'decide': return `${persona.name} approved its agreement ${cid} as the sole owner of its land.`;
    case 'lens-decision': return `${persona.name} asked lens member ${lens?.name ?? item.lens} for its decision on agreement ${cid}: satisfied.`;
    case 'attest': return `${persona.name} recorded the lens decision on agreement ${cid} on chain.`;
    case 'execute': return `${persona.name} executed its agreement ${cid}; the escrow went to its payout.`;
    case 'expire': return `${persona.name} expired its agreement ${cid} after its deadline; the escrow returned to it.`;
    case 'resolve': return `${persona.name} resolved the market of agreement ${cid} ${item.outcome}.`;
    default: return `${persona.name} claimed its YES ${item.outcome === 'YES' ? 'winnings' : 'refund'} on agreement ${cid}.`;
    }
}

// Settlement phase. Agreements come from this persona's own agent_run rows of earlier runs (this run's
// picks are minted after it, so every market stays open for at least one run); their state comes from
// the chain, so a rerun skips whatever is already done. Settlement transactions share
// AGENT_DAILY_ACTION_CAP with the run's picks: they get only what the pick plan (and any settlement
// already signed in this run) leaves over, and the run says what waits. The signer, the transaction
// sender, the lens's fetch, the market readers and adapters and the clock are injected for tests.
export async function settleStage({
    pool, connection, index, lens, entries, dryRun, controller, plannedActions, failures, report,
    env = process.env, loadSigner = persona => loadKeypair(persona.keypairPath), sendAndConfirm = sendAndConfirmPolling,
    fetchImpl, readers = {}, adapters = {}, now = () => new Date()
}) {
    const policy = executionPolicy(env);
    const settle = settlementPolicy(env);
    const runs = await listRuns(pool);
    let budget = Math.max(0, policy.maxActions - plannedActions);
    log(`settlement: ≤ ${settle.maxPerRun} per run · ${budget}/${policy.maxActions} signed actions left after ${plannedActions} planned for picks · lens ${lens.name} ${lens.key}`);
    for (const e of entries) {
        const persona = e.persona;
        const signer = dryRun ? null : loadSigner(persona);
        const owner = signer ? signer.publicKey.toBase58() : persona.wallet;
        const summary = e.run?.summary ?? {};
        const settlements = { ...(summary.settlements ?? {}) };
        const owned = ownedAgreementsFromRuns(runs, persona.name, owner).filter(agreement => agreement.sourceRunId !== e.runId);
        const inspections = [];
        for (const agreement of owned) {
            try {
                inspections.push(await inspectSettlement({ connection, owner, agreement, lensKey: lens.key, readers }));
            } catch (err) {
                log(`${persona.name} settlement: could not read ${agreement.cid} ${agreement.account}: ${safeFailureDiagnostic(err)}`);
                failures.push(`${persona.name} settlement inspect ${agreement.cid}: ${safeFailureDiagnostic(err)}`);
            }
        }
        const plan = planSettlements(inspections, { policy: settle, actionBudget: budget, spent: settlementsSpent(settlements) });
        budget = Math.max(0, budget - plan.actions);
        const counts = plan.skipped.reduce((acc, item) => ({ ...acc, [item.reason]: (acc[item.reason] ?? 0) + 1 }), {});
        log(`${persona.name} settlement: ${owned.length} own agreement(s) open · ${plan.selected.length} to settle (${plan.actions} signed action(s)) · skipped ${JSON.stringify(counts)}`);
        for (const item of plan.selected) {
            log(`   ${dryRun ? 'would settle' : 'settle'} ${item.cid} ${item.account} · ${item.state} · ${item.steps.join(' → ')}${item.note ? ` · ${item.note}` : ''}`);
        }
        if (plan.limited) log(`   ${plan.limited} agreement(s) deferred: per-run cap ${settle.maxPerRun} or action cap (${plan.budget} left) reached; they settle on a later run`);
        // Nothing left to do for these, ever: recorded so later runs stop reading them (a missing account
        // is read again: an RPC that lags is not proof it is gone).
        const finished = inspections.filter(item => ['closed', 'foreign', 'retired'].includes(item.state));
        if (dryRun || (!plan.selected.length && !finished.length)) {
            if (plan.selected.length || plan.limited) report.push(`${persona.name}: ${dryRun ? 'would settle' : 'settled'} ${plan.selected.length}${plan.limited ? ` (${plan.limited} deferred)` : ''}`);
            continue;
        }

        const activities = Array.isArray(summary.activities) ? [...summary.activities] : [];
        const run = actionRunner({ persona, controller: summary.controller || controller, wallet: owner, activities });
        const settlementPlan = { day: e.day, budget: plan.budget, selected: plan.selected.map(item => ({ cid: item.cid, account: item.account, state: item.state, steps: item.steps })), skipped: plan.skipped };
        for (const item of finished) {
            settlements[item.account] = { cid: item.cid, account: item.account, state: item.state, settled: item.state !== 'retired', retired: item.state === 'retired', completedAt: now().toISOString() };
        }
        e.run = await updateRun(pool, e.runId, { summaryPatch: { settlements, settlementPlan } });
        let settled = 0;
        for (const item of plan.selected) {
            const entity = { type: 'agreement', id: item.cid };
            try {
                await executeSettlement({
                    connection, ownerKeypair: signer, item, record: settlements[item.account] ?? {},
                    sendAndConfirm, readers, adapters,
                    decide: () => ensureOwnerApproval({ index, serviceUrl: lens.serviceUrl, lensKey: lens.key, cid: item.cid, content: item.content, keypair: signer, fetchImpl }),
                    askLens: () => requestAgreementDecision({ serviceUrl: lens.serviceUrl, operatorToken: lens.operatorToken, cid: item.cid, fetchImpl }),
                    perform: (action, execute) => run({ ...action, account: item.account }, execute, {
                        entity, message: settlementMessage(persona, lens, item, action.type)
                    }),
                    checkpoint: async (record) => {
                        settlements[item.account] = record;
                        e.run = await updateRun(pool, e.runId, { summaryPatch: { settlements, settlementPlan, activities } });
                    }
                });
                // The index refreshes the agreement's state from the chain (decision, status).
                await index.recordOnchain(item.cid, { cluster: CLUSTER, account: item.account });
                // Executed or expired, its market resolved and the claim taken: nothing is left to settle.
                const terminal = item.steps.includes('execute') || item.steps.includes('expire') || ['executed', 'cancelled', 'expired'].includes(item.state);
                settlements[item.account] = { ...settlements[item.account], completedAt: now().toISOString(), settled: terminal };
                e.run = await updateRun(pool, e.runId, { summaryPatch: { settlements, settlementPlan, activities } });
                settled += 1;
                const done = settlements[item.account];
                log(`${persona.name} settled ${item.cid} (${item.state}): ${[
                    done.approval ? `approval ${done.approval.replayed ? 'already relayed' : done.approval.decidedAt}` : null,
                    done.lensDecision ? `lens decision ${done.lensDecision.address}${done.lensDecision.reused ? ' (reused)' : ''}` : null,
                    done.attest ? `attest ${done.attest.signature ?? 'already recorded'}` : null,
                    done.execution ? `execute ${done.execution.signature ?? done.execution.status}` : null,
                    done.expiry ? `expire ${done.expiry.signature ?? done.expiry.status}` : null,
                    done.resolution ? `resolve ${done.resolution.signature ?? '-'} (${done.resolution.outcome})` : null,
                    done.claim ? `claim ${done.claim.signature ?? done.claim.reason ?? '-'}` : null
                ].filter(Boolean).join(' · ')}`);
            } catch (err) {
                if (err?.status === 410 && err?.code === 'retired-agreement-format') {
                    settlements[item.account] = { ...settlements[item.account], cid: item.cid, account: item.account, state: 'retired', retired: true, settled: false, completedAt: now().toISOString() };
                    e.run = await updateRun(pool, e.runId, { summaryPatch: { settlements, settlementPlan, activities } });
                    log(`${persona.name} settlement ${item.cid}: retired format; automation skipped`);
                    continue;
                }
                failures.push(`${persona.name} settlement ${item.cid}: ${safeFailureDiagnostic(err)}`);
            }
        }
        report.push(`${persona.name}: settled ${settled}/${plan.selected.length}${plan.limited ? ` (${plan.limited} deferred)` : ''}`);
    }
}

// Rival index admission by CID: a current agreement returns its recorded chain status (onchain.status,
// refreshed by the lifecycle oracle), or null without an account. Only a retired-format HTTP 410 maps
// to `retired`, which is an index admission state, not a chain lifecycle status.
export async function rivalIndexStatuses(index, cids) {
    const statuses = {};
    for (const cid of cids) {
        try {
            const row = await index.getAgreement(cid);
            statuses[cid] = row?.onchain?.status ?? null;
        } catch (error) {
            if (error?.status === 410 && error?.code === 'retired-agreement-format') statuses[cid] = 'retired';
            else throw error;
        }
    }
    return statuses;
}

// The parcels one run plans on, from the area this run visits; parcels the persona already published a
// design on are dropped, so no run proposes the same land twice.
async function parcelsForArea({ pool, apiBase, index, area, persona, runKey, day, runs, limit }) {
    if (!area) return { parcels: [], city: 'zagreb', where: 'no area' };
    const mine = pickedParcelIds(runs, { persona: persona.name });
    const fresh = parcels => parcels.filter(parcel => !mine.has(parcel.parcelId));
    if (area.mode === 'contest') {
        const rivals = { persona: persona.name, runDay: day, withinDays: area.withinDays ?? 3 };
        const indexStatuses = await rivalIndexStatuses(index, rivalAgreementCids(runs, rivals));
        const all = contestParcels(runs, { ...rivals, floorCap: area.floorCap ?? null, indexStatuses });
        const open = fresh(all);
        // One city per run: the rival answers agreements where the rotation lands, not everywhere at once.
        const cities = [...new Set(open.map(parcel => parcel.city).filter(Boolean))].sort();
        const city = cities.length ? cities[hash32(`${runKey}:${persona.name}`) % cities.length] : 'zagreb';
        return { parcels: open.filter(parcel => parcel.city === city).slice(0, limit), city, where: `contest (${city}, ${open.length} open parcels)` };
    }
    if (persona.housingResearch) {
        for (let attempt = 0; attempt < 3; attempt++) {
            const window = windowIn(area.bbox, `${runKey}:housing${attempt}`, persona.name, area.windowM ?? 850);
            const collection = await fetchSourceParcels(apiBase, area.sourceId, window, { log });
            if (collection?.complete !== true) throw new Error('Affordabot requires a complete parcel source response');
            const parcels = fresh(parcelsFromSource(collection, { turf, place: area.label, minAreaM2: 1200, maxAreaM2: 20000 }));
            const screened = await fetchHousingScreen(parcels, turf.bbox(turf.buffer(turf.bboxPolygon(window), 0.85, { units: 'kilometers' })), { turf, area });
            const eligible = screened.filter(p => !p.housingScreen.excluded && p.housingScreen.transitDistanceM !== null && p.housingScreen.transitDistanceM <= 800);
            log(`affordabot ${area.city} window ${attempt + 1}/3: ${collection.features.length} source parcels, ${parcels.length} sized, ${eligible.length} screened leads; exclusions ${JSON.stringify(screened.reduce((counts, p) => { const key = p.housingScreen.excludedBy || 'clear'; counts[key] = (counts[key] || 0) + 1; return counts; }, {}))}`);
            if (eligible.length) return { parcels: eligible.slice(0, limit), city: area.city, where: `${area.city} ${window.join(',')}` };
        }
        return { parcels: [], city: area.city, where: `${area.city} (3 bounded windows screened)` };
    }
    const window = windowIn(area.bbox, runKey, persona.name, area.windowM ?? 350);
    if (area.sourceId) {
        const collection = await fetchSourceParcels(apiBase, area.sourceId, window, { log });
        const parcels = fresh(parcelsFromSource(collection, { turf, place: area.label ?? null }))
            .map(parcel => (area.floorCap ? { ...parcel, floorCap: area.floorCap } : parcel));
        return { parcels: parcels.slice(0, limit), city: area.city, where: `${area.city} ${window.join(',')}` };
    }
    const rows = await fetchCandidateParcels(pool, { city: area.city, bbox: window, limit });
    return { parcels: fresh(rows).map(parcel => (area.floorCap ? { ...parcel, floorCap: area.floorCap } : parcel)), city: area.city, where: `${area.city} ${window.join(',')}` };
}

// The candidate's parcel as the agreement's one input and one output: a building on its parcel forms no
// piece, so the parcel stands as it is (role 'parcel'), hashed over the geometry its parcel source serves.
export function parcelLand(candidate) {
    const feature = { type: 'Feature', properties: {}, geometry: candidate.geometry };
    const areaM2 = turf.area(feature);
    return {
        parcels: [{ parcelId: String(candidate.parcelId), parcelSourceId: candidate.parcelSourceId || null, areaM2 }],
        outputs: parcelOutputs([{ parcelId: candidate.parcelId, geometry: candidate.geometry, areaM2 }])
    };
}

// One chosen pick through the stages after `chosen` (designed → proposed → minted → recorded →
// staked), as far as `until` (agents/README.md, "The proposer run"). The run's checkpoint maps in `state`
// (designs, owners, agreements, mints, onchain, stakes, bindingFailures) are updated in place and saved
// through `save(stage, patch)` after each step; a design or agreement is checkpointed with its CID before
// it leaves the machine, so a rerun resumes at the first unfinished step and never builds a second CID,
// mints twice or stakes twice. Returns { refusal } when the index binds the design to land other than the
// candidate's parcel (the caller fails the persona's run); any other failure throws. The chain steps
// (mintImpl) and the clock are injected so the stages run headless in tests.
export async function advancePick({
    pick, candidate, tag, persona, keypair, lens, until = 'staked', city, day, slot = null, seedOwners = false,
    walletNames = {}, stakeUsdc = '0', state, index, pool, connection, run, save,
    mintImpl = mintAgreement, openMarketImpl = openAgreementMarket, fundMarketSeed = ensureBotUsdcFunding,
    marketSeedCapUsdc = 0, sendAndConfirm = sendAndConfirmPolling,
    now = () => new Date()
}) {
    if (!isEligible(candidate)) throw new Error('Candidate has no supported planning basis; replan before publication or minting.');
    const { designs, owners, agreements, mints, onchain, stakes, bindingFailures } = state;
    const markets = state.markets ??= {};
    const marketFunding = state.marketFunding ??= {};
    const wallet = keypair.publicKey.toBase58();
    const staking = usdcToAtomic(stakeUsdc) > 0n;
    const key = pick.candidateId;
    // design: built once and checkpointed before it leaves the machine, then pinned and
    // indexed; the server's binding must be exactly the candidate parcel.
    if (!designs[key]) {
        const recipe = buildRecipe({ candidate, pick, persona, city, authoredAt: now().toISOString() });
        const { content, cid } = designObject(recipe.design);
        designs[key] = { cid, content, goal: content.goal, title: content.title, terms: recipe.agreement };
        await save(null, { designs });
        log(`${tag} design built: ${cid}`);
    }
    if (!designs[key].indexedAt) {
        const design = designs[key];
        const published = await run({ type: 'design', designCid: design.cid, pickId: pick.pickId },
            () => index.publishDesign(design.content, { parcelSourceId: candidate.parcelSourceId || null }),
            { entity: { type: 'design', id: design.cid }, message: `${persona.name} published the design "${design.title}".` });
        const parcelIds = (published.row.binding?.parcels || []).map(hit => String(hit.parcelId)).sort();
        const coverage = published.row.binding?.coverage ?? null;
        if (coverage !== 'complete' || parcelIds.length !== 1 || parcelIds[0] !== String(candidate.parcelId)) {
            const refusal = {
                ...bindingRejection(candidate, { code: 'agent-binding-not-candidate', parcelIds, error: `The index bound ${parcelIds.join(', ') || 'no parcel'} (coverage ${coverage}), not exactly ${candidate.parcelId}.` }),
                pickId: pick.pickId, designCid: design.cid, phase: 'design-indexed'
            };
            bindingFailures.push(refusal);
            return { refusal };
        }
        designs[key] = { ...design, city: published.row.city ?? null, binding: { parcelIds, coverage }, indexedAt: now().toISOString() };
        await save('designed', { designs });
        log(`${tag} design ${published.created ? 'indexed' : 'already indexed'}: ${design.cid} binds ${parcelIds.join(', ')}`);
    }
    if (stageIndex(until) < stageIndex('proposed')) return {};

    // owners: who owns the pick's parcel in the lens member's devnet owner registry. With
    // --seed-owners a parcel nobody owns is registered to the persona first; one somebody owns is
    // never changed (a contest's rival proposes to the land's owners).
    if (!owners[key]) {
        const parcelId = String(candidate.parcelId);
        let set = (await readParcelOwners(pool, [parcelId])).get(parcelId);
        if (!set.length && seedOwners && !candidate.rival) {
            await registerSoleOwners(pool, [{ parcelId, wallet, persona: persona.name }], {
                note: agentRegistrationNote('run.mjs --seed-owners'), log: line => log(`${tag} owner registry ${line}`)
            });
            set = (await readParcelOwners(pool, [parcelId])).get(parcelId);
        }
        if (!set.length) {
            throw new Error(`parcel ${parcelId} has no owner in the devnet owner registry: register it (scripts/seed-lens-owners.mjs --day ${day}${slot ? ` --slot ${slot}` : ''} --persona ${persona.name} --apply, or run with --seed-owners) and run again`);
        }
        owners[key] = {
            parcelId, owners: set.map(row => ({ owner: row.owner, ownerCount: row.ownerCount })),
            soleOwner: isSoleOwner(set, wallet), readAt: now().toISOString()
        };
        await save(null, { owners });
        log(`${tag} owners of ${parcelId}: ${owners[key].soleOwner ? `${persona.name} alone` : set.map(row => walletNames[row.owner] || row.owner).join(', ')}`);
    }

    // agreement: a binding owners' agreement over the one design; inputs = the design's binding with
    // its registered owners as holders, outputs = the parcel as it stands, rule = every owner
    // approves (unanimous) through receipts the operated lens member verifies; deadline and
    // escrow from the persona's terms.
    if (!agreements[key]) {
        const design = designs[key];
        const terms = design.terms;
        const createdAt = now().toISOString();
        const deadline = deadlineAfterDays(Date.parse(createdAt), terms.deadlineDays);
        const land = parcelLand(candidate);
        const rights = registryRights([{ parcelId: owners[key].parcelId, owners: owners[key].owners }]);
        const holders = holdersFromRights(rights, owners[key].parcelId, walletNames);
        const { content, cid, plan } = agreementObject({
            title: terms.title, author: persona.name, sponsor: wallet, city: design.city ?? city, createdAt,
            plan: planForDesigns(terms.title, [design], mapViewFromGeometry([candidate.geometry], design.content.city ?? city)),
            designs: [{ cid: design.cid, goal: design.goal, title: design.title }],
            parcels: land.parcels.map(parcel => ({ ...parcel, holders })), openGroundM2: 0, outputs: land.outputs,
            money: noMoney(cityMoney(design.city ?? city).currentCurrency()),
            rule: ownersRule({ lens: lens.key, rights }), deadline
        });
        agreements[key] = { cid, content, plan, title: terms.title, deadline, lamports: terms.lamports, soleOwner: owners[key].soleOwner };
        await save(null, { agreements, lens: lens.key });
        log(`${tag} agreement built: ${cid} · binding, ${owners[key].soleOwner ? 'its sole owner decides' : 'its owners decide'} · deadline ${deadline} · escrow ${terms.lamports} lamports · lens ${lens.name} ${lens.key}`);
    }
    if (!agreements[key].indexedAt) {
        const agreement = agreements[key];
        const published = await run({ type: 'propose', agreementCid: agreement.cid, designCid: designs[key].cid, pickId: pick.pickId },
            () => index.publishAgreement(agreement.content, { plan: agreement.plan }),
            { entity: { type: 'agreement', id: agreement.cid }, message: agreement.soleOwner
                ? `${persona.name} proposed "${agreement.title}" as a binding agreement on its own parcel ${owners[key].parcelId}.`
                : `${persona.name} proposed "${agreement.title}" to the owners of parcel ${owners[key].parcelId}.` });
        agreements[key] = { ...agreement, indexedAt: now().toISOString(), status: published.row.status ?? null };
        await save('proposed', { agreements });
        log(`${tag} agreement ${published.created ? 'indexed' : 'already indexed'}: ${agreement.cid}`);
    }
    if (stageIndex(until) < stageIndex('minted')) return {};

    // mint: create + fund in one transaction; the chain is read first, so a rerun signs nothing twice.
    if (!mints[key]) {
        const agreement = agreements[key];
        const minted = await run({ type: 'mint', agreementCid: agreement.cid, lamports: agreement.lamports, lens: agreement.content.rule.lens, pickId: pick.pickId },
            () => mintImpl({
                connection, sponsorKeypair: keypair, cid: agreement.cid, lens: agreement.content.rule.lens[0],
                deadline: agreement.deadline, lamports: agreement.lamports, openGround: false,
                sendAndConfirm
            }),
            { entity: { type: 'agreement', id: agreement.cid }, message: `${persona.name} minted "${agreement.title}" on Solana devnet.` });
        mints[key] = { ...minted, cluster: CLUSTER, mintedAt: now().toISOString() };
        await save('minted', { mints });
        log(`${tag} minted: ${minted.account}${minted.created ? '' : ' (already created)'} · escrow ${minted.escrowLamports} lamports · tx ${minted.signature ?? 'none needed'}`);
    }
    if (stageIndex(until) < stageIndex('recorded')) return {};

    // record: the index reads the account itself and keeps the create transaction.
    if (!onchain[key]) {
        const mint = mints[key];
        await index.recordOnchain(agreements[key].cid, { cluster: CLUSTER, account: mint.account, signature: mint.createSignature });
        onchain[key] = { account: mint.account, signature: mint.createSignature, recordedAt: now().toISOString() };
        await save('recorded', { onchain });
        log(`${tag} recorded in the index: ${mint.account}`);
    }
    if (stageIndex(until) < stageIndex('staked')) return {};
    if (marketSeedCapUsdc > 0 && !markets[key]) {
        const opened = await run({ type: 'openMarket', agreementCid: agreements[key].cid, pickId: pick.pickId },
            () => openMarketImpl({ connection, sponsorKeypair: keypair, subject: mints[key].account,
                maxSeedAtomic: usdcToAtomic(String(marketSeedCapUsdc)), sendAndConfirm,
                ensureSeed: async requiredAtomic => {
                    const funding = await fundMarketSeed({ connection, persona, pool, requiredAtomic, maxActionAtomic: usdcToAtomic(String(marketSeedCapUsdc)), sendAndConfirm });
                    if (funding.status === 'funded') { marketFunding[key] = funding; await save(null, { marketFunding }); }
                    return funding;
                } }),
            { entity: { type: 'agreement', id: agreements[key].cid }, message: `${persona.name} opened the market for ${agreements[key].title}.` });
        markets[key] = { ...opened, openedAt: now().toISOString() };
        await save(null, { markets });
        log(`${tag} market opened: ${opened.address} · seed ${opened.seedAtomic} atomic devnet USDC`);
    }
    if (!staking) return {};

    // The author is the sponsor and cannot trade its own market. Persist the reason at the normal
    // checkpoint boundary so resumed runs do not retry an action the protocol forbids.
    if (!stakes[key]) {
        const agreement = agreements[key];
        stakes[key] = { skipped: true, skipReason: 'agreement-sponsor-cannot-trade-own-market', amount: stakeUsdc };
        await save('staked', { stakes });
        log(`${tag} skipped own-market trade: agreement sponsor cannot trade its market`);
    }
    return {};
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const day = args.day || todayUtc();
    const slot = slotLabel(args.slot);
    const runKey = runKeyFor(day, slot);
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
    const index = createIndexClient({ apiBase, origin: process.env.AGENT_APP_ORIGIN || DEFAULT_APP_ORIGIN, waitOnRateLimit: true, pinIntervalMs: 31_000, log });
    const allPersonas = readPersonas();
    const personas = proposersOf(allPersonas, args.persona);
    const lens = operatedLens(allPersonas, args.lens ?? process.env.AGENT_LENS);
    if (args.live && !lens.operatorToken) {
        throw new Error(`${lens.tokenEnv} is not set: the runner asks lens member ${lens.name} for agreement decisions as its operator`);
    }
    // Owner ids are wallets; an owner that is one of the personas is shown by its name.
    const walletNames = Object.fromEntries(allPersonas.filter(p => p.wallet).map(p => [p.wallet, p.name]));
    const pool = createPool();
    const mode = args.dryRun ? 'dry-run' : 'live';
    log(`${mode} · day ${day}${slot ? ` · slot ${slot}` : ''} · ${personas.length} persona(s) · controller ${controller}${llm ? ` (${llm.model}, effort ${llm.effort})` : ' ($0 model spend)'} · api ${apiBase} · lens ${lens.name} ${lens.key} at ${lens.serviceUrl}${args.seedOwners ? ' · seeding owners' : ''}`);

    const failures = [];
    const report = [];
    const startedRuns = new Set();
    let housingLock = null;
    try {
        // ---- stage 1: plan (every persona) ----------------------------------------------------
        const entries = [];
        if (personas.some(p => p.housingResearch) && args.live) {
            housingLock = await pool.connect();
            const { rows } = await housingLock.query('SELECT pg_try_advisory_lock(57401, hashtext($1)) AS locked', ['affordabot']);
            if (!rows[0]?.locked) throw new Error('Affordabot is already running; refusing concurrent publication');
        }
        if (args.live) {
            const abandoned = await failStaleRuns(pool);
            if (abandoned.length) log(`failed ${abandoned.length} abandoned run(s) with no checkpoint for ${STALE_RUN_HOURS} h: ${abandoned.join(', ')}`);
        }
        const allRuns = await listRuns(pool);
        for (const [i, persona] of personas.entries()) {
            const runId = `${runKey}-${persona.name}`;
            const existing = args.live ? await getRun(pool, runId) : null;
            if (args.live) {
                await startRun(pool, { runId, persona: persona.name, day, mode });
                startedRuns.add(runId);
            }
            const refreshPlanning = planningNeedsRefresh(existing, persona);
            const resumePlanning = existing && !refreshPlanning && stageIndex(existing.stage) >= stageIndex('planned') && existing.summary?.candidates?.length;
            if (!resumePlanning && hasPublishedWork(existing)) throw new Error(`${persona.name}: this run already published under a different planning policy; use a fresh --slot rather than rewriting its CIDs`);
            if (refreshPlanning) log(`${persona.name}: replanning unpublished candidates under ${persona.planningPolicy}`);
            if (resumePlanning) {
                log(`${persona.name} ${i + 1}/${personas.length} planned: resumed ${existing.summary.candidates.length} candidates from ${runId}`);
                let candidates = existing.summary.candidates;
                let run = existing;
                if (!Array.isArray(existing.summary.picks)) {
                    const preflight = await preflightCandidates({
                        db: pool, rankedCandidates: candidates, limit: args.candidates,
                        scanLimit: args.candidates * 2, persona, city: existing.summary.city ?? 'zagreb',
                        checkBinding: checkProposalBinding, log
                    });
                    candidates = preflight.candidates;
                    logCandidatePreflight(persona.name, preflight);
                    run = await updateRun(pool, runId, { summaryPatch: {
                        candidates,
                        candidatePreflight: { scanned: preflight.scanned, accepted: candidates.length, rejected: preflight.rejected }
                    } });
                }
                entries.push({ persona, runId, day, run, candidates });
                continue;
            }
            const planArea = async area => {
                const source = await parcelsForArea({ pool, apiBase, index, area, persona, runKey, day, runs: allRuns, limit: args.candidates * 6 });
                const { parcels, city } = source;
                // Gains are in the money of the place (London in GBP, Zagreb in EUR), at the app's own
                // floor-area sale price for that city (frontend-owned money settings).
                const prices = cityMoney(city).currentFloorAreaPrices();
                const money = { currency: prices.currency, salePricePerM2: prices.sale.perSqm };
                const planned = (persona.housingResearch ? planHousingCandidates : planCandidates)(parcels, persona, { turf, money, limit: args.candidates * 2, seed: seedFor(runKey) });
                // Rule-backed previews come first. Automatic uplift selection additionally requires a
                // complete building baseline; a default envelope alone does not authorize publication.
                const preflight = await preflightCandidates({
                    db: pool, rankedCandidates: prioritizedPlannedCandidates(planned),
                    limit: args.candidates, scanLimit: args.candidates * 2,
                    persona, city, checkBinding: checkProposalBinding, log
                });
                return { ...source, preflight };
            };
            const { parcels, city, where, preflight, areaAttempts = [] } = persona.housingResearch
                ? await findHousingPlan(persona.areas, day, planArea, { log })
                : await findProposalPlan(persona.areas, runKey, persona.name, planArea, { log });
            const candidates = preflight.candidates;
            logCandidatePreflight(persona.name, preflight);
            log(`${persona.name} ${i + 1}/${personas.length} planned in ${where}: ${parcels.length} parcels → ${candidates.length} candidates`);
            for (const c of candidates) {
                log(`   ${c.parcelId} ${c.koName ?? ''} ${formatCandidateQuantity(c.areaM2)} m² · built ${formatCandidateQuantity(c.builtGfaM2)} m² → ${formatCandidateQuantity(c.proposedGfaM2)} m² (${c.plannedFloors ?? c.allowedFloors}/${c.allowedFloors} fl) · gain ${formatCandidateQuantity(c.gain)} ${c.currency} · score ${formatCandidateQuantity(c.score, 3)}`);
            }
            let run = null;
            if (args.live) {
                run = await updateRun(pool, runId, { stage: 'planned', status: 'running', summaryPatch: {
                    candidates, city, area: where, slot, wallet: persona.wallet,
                    ...(existing ? { picks: null, designs: {}, agreements: {}, owners: {} } : {}),
                    areaAttempts,
                    candidatePreflight: { scanned: preflight.scanned, accepted: candidates.length, rejected: preflight.rejected },
                    controller, ...(model ? { model } : {})
                } });
            }
            entries.push({ persona, runId, day, run, candidates });
        }

        // ---- stage 2: choose ---------------------------------------------------------------
        const needDecision = entries.filter((e) => !Array.isArray(e.run?.summary?.picks));
        if (controller === 'algorithm') {
            const decisions = new Map(needDecision.map((entry) => [
                entry.persona.name,
                selectAlgorithmicPicks({ day: runKey, persona: entry.persona, candidates: entry.candidates })
            ]));
            for (const e of needDecision) {
                const decision = decisions.get(e.persona.name);
                log(`${e.persona.name} algorithm: ${decision.picks.length} pick(s) from ${decision.policy.eligibleCandidateIds.length} eligible candidates · $0 model spend`);
                for (const pick of decision.picks) log(`   ${pick.candidateId}: ${pick.name}`);
            }
            if (args.dryRun) {
                await settleStage({
                    pool, connection: createRpcConnection(rpcUrl, 'confirmed'), index, lens, entries, dryRun: true, controller,
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
                const withIds = decision.picks.map((pick, index) => ({ ...pick, pickId: pickIdFor(e.persona, runKey, index) }));
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
                for (const pick of withIds) log(`   ${pick.pickId} ← ${pick.candidateId}: ${pick.name}`);
                if (completion.noPicks) report.push(`${e.persona.name}: no design selected · $0.0000`);
            }
        } else {
            const needPicks = needDecision.filter((entry) => entry.candidates.some(isEligible));
            const requests = buildPickRequests({ llm, runId: `${day}`, day, entries: needPicks });
            const requestsByPersona = new Map(needPicks.map((entry, index) => [entry.persona.name, requests[index]]));
            const estimate = estimateBatchCostUsd(requests);
            const spent = args.live ? await dailySpendUsd(pool, day) : 0;
            const cap = dailyCapUsd(process.env);
            log(`batch: ${requests.length} request(s) · estimated ≤ $${estimate.toFixed(4)} · spent today $${spent.toFixed(4)} · cap $${cap}`);
            if (args.dryRun) {
                // The model is not called in a dry run, so assume each persona uses its full daily quota.
                await settleStage({
                    pool, connection: createRpcConnection(rpcUrl, 'confirmed'), index, lens, entries, dryRun: true, controller,
                    plannedActions: summarizeExecutionPlan(entries.map(entry => ({
                        persona: entry.persona,
                        run: { summary: { picks: Array.from({ length: entry.persona.dailyProposals ?? 1 }, (_, index) => ({ pickId: `planned-${index + 1}` })) } }
                    }))).actionCount,
                    failures, report
                });
                log('dry run: nothing written, no model called, nothing signed');
                return;
            }
            if (stageIndex(args.until) < stageIndex('chosen')) return;

            for (const e of needDecision.filter(entry => !entry.candidates.some(isEligible))) {
                e.run = await updateRun(pool, e.runId, { stage: 'chosen', status: 'done', summaryPatch: {
                    controller: 'llm',
                    picks: [],
                    rejectedPicks: [],
                    pickCostUsd: 0,
                    decisionInput: { controller: 'llm', day, candidateIds: [] },
                    decisionResult: { controller: 'llm', costUsd: 0, reason: 'no-eligible-planning-candidates' },
                    outcome: 'no-picks'
                } });
                log(`${e.persona.name} chosen: 0 picks; no eligible planning candidates · $0.0000`);
                report.push(`${e.persona.name}: no eligible planning candidates · $0.0000`);
            }

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
                    const withIds = picks.map((pick, index) => ({ ...pick, pickId: pickIdFor(e.persona, runKey, index) }));
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
                    for (const pick of withIds) log(`   ${pick.pickId} ← ${pick.candidateId}: ${pick.name}`);
                    if (completion.noPicks) report.push(`${e.persona.name}: no design selected · $${(result.costUsd ?? 0).toFixed(4)}`);
                }
            }
        }
        if (stageIndex(args.until) < stageIndex('designed')) return;

        // ---- stages 3–7 per persona: design → agreement → mint → record → stake --------------
        const policy = executionPolicy(process.env);
        const executionPlan = assertExecutionPlan(summarizeExecutionPlan(entries, policy), policy);
        log(`execution policy: ${executionPlan.actionCount}/${policy.maxActions} signed actions · ≤ ${executionPlan.maxUsdc.toFixed(2)}/${policy.maxUsdc.toFixed(2)} USDC · ≤ ${executionPlan.maxMarketSeedUsdc.toFixed(5)}/${policy.maxMarketSeedUsdc.toFixed(5)} devnet USDC market seed`);
        const connection = createRpcConnection(rpcUrl, 'confirmed');

        for (const entry of entries) {
            const funding = await ensureBotSolFunding({ connection, persona: entry.persona });
            if (funding.status === 'funded') entry.run = await updateRun(pool, entry.runId, { summaryPatch: { funding } });
        }

        // ---- settlement phase: finish own agreements of earlier runs before anything new -----
        await settleStage({
            pool, connection, index, lens, entries, dryRun: false, controller,
            plannedActions: executionPlan.actionCount, failures, report
        });
        for (const e of entries.filter(entry => entry.run?.summary?.picks?.length)) {
            e.run = await updateRun(pool, e.runId, { status: 'running', summaryPatch: {
                executionPolicy: policy,
                executionPlan: {
                    pickCount: executionPlan.picks.filter(item => item.persona === e.persona.name).length,
                    actions: executionPlan.picks.filter(item => item.persona === e.persona.name).reduce((sum, item) => sum + item.actions, 0),
                    maxUsdc: executionPlan.picks.filter(item => item.persona === e.persona.name).reduce((sum, item) => sum + item.usdc, 0),
                    maxMarketSeedUsdc: executionPlan.picks.filter(item => item.persona === e.persona.name).reduce((sum, item) => sum + item.marketSeedUsdc, 0)
                }
            } });
        }
        const until = args.until;
        for (const e of entries) {
            const persona = e.persona;
            const summary = e.run?.summary ?? {};
            const picks = summary.picks ?? [];
            if (!picks.length) continue;
            const keypair = loadKeypair(persona.keypairPath);
            const wallet = keypair.publicKey.toBase58();
            if (wallet !== persona.wallet) throw new Error(`Wallet does not match persona ${persona.name}`);
            const designs = { ...(summary.designs ?? {}) };
            const owners = { ...(summary.owners ?? {}) };
            const agreements = { ...(summary.agreements ?? {}) };
            const mints = { ...(summary.mints ?? {}) };
            const onchain = { ...(summary.onchain ?? {}) };
            const stakes = { ...(summary.stakes ?? {}) };
            const markets = { ...(summary.markets ?? {}) };
            const marketFunding = { ...(summary.marketFunding ?? {}) };
            const bindingFailures = [...(summary.bindingFailures ?? [])];
            const activities = Array.isArray(summary.activities) ? [...summary.activities] : [];
            const city = summary.city ?? 'zagreb';
            const runController = summary.controller || (summary.model ? 'llm' : controller);
            const stakeUsdc = String(persona.stakeUsdc ?? '0');
            const staking = usdcToAtomic(stakeUsdc) > 0n;
            let personaFailed = false;
            const run = actionRunner({ persona, controller: runController, wallet, activities });
            const save = async (stage, patch) => {
                e.run = await updateRun(pool, e.runId, { ...(stage ? { stage } : {}), status: 'running', summaryPatch: { ...patch, activities } });
            };

            for (const [k, pick] of picks.entries()) {
                const candidate = e.candidates.find((c) => c.candidateId === pick.candidateId);
                if (!candidate) { failures.push(`${persona.name}: pick ${pick.candidateId} has no candidate`); personaFailed = true; break; }
                const tag = `${persona.name} ${k + 1}/${picks.length} ${pick.pickId}`;
                try {
                    const { refusal } = await advancePick({
                        pick, candidate, tag, persona, keypair, lens, until, city, day, slot, seedOwners: Boolean(args.seedOwners),
                        walletNames, stakeUsdc, state: { designs, owners, agreements, mints, onchain, stakes, markets, marketFunding, bindingFailures },
                        index, pool, connection, run, save, marketSeedCapUsdc: policy.maxMarketSeedUsdc,
                    });
                    if (refusal) {
                        await updateRun(pool, e.runId, { status: 'failed', summaryPatch: { designs, bindingFailures, activities, outcome: 'failed', error: `binding refused ${refusal.code}` } });
                        failures.push(`${tag} binding ${refusal.code}: ${refusal.reason}`);
                        personaFailed = true;
                        break;
                    }
                } catch (err) {
                    failures.push(`${tag}: ${safeFailureDiagnostic(err)}`);
                    personaFailed = true;
                    break;
                }
            }

            const finishedAt = key => (staking ? Boolean(stakes[key]) : Boolean(onchain[key])) && (policy.maxMarketSeedUsdc <= 0 || Boolean(markets[key]));
            const reachedAll = stage => picks.every(pick => ({
                designed: designs[pick.candidateId]?.indexedAt,
                proposed: agreements[pick.candidateId]?.indexedAt,
                minted: mints[pick.candidateId],
                recorded: onchain[pick.candidateId],
                staked: finishedAt(pick.candidateId)
            })[stage]);
            const done = !personaFailed && reachedAll(until);
            const furthest = ['staked', 'recorded', 'minted', 'proposed', 'designed'].find(stage => picks.some(pick => ({
                designed: designs[pick.candidateId]?.indexedAt,
                proposed: agreements[pick.candidateId]?.indexedAt,
                minted: mints[pick.candidateId],
                recorded: onchain[pick.candidateId],
                staked: stakes[pick.candidateId]
            })[stage])) || 'chosen';
            const outreach = persona.housingResearch
                ? picks.filter(pick => agreements[pick.candidateId]?.indexedAt).map(pick => housingOutreach({
                    candidate: e.candidates.find(c => c.candidateId === pick.candidateId),
                    agreementCid: agreements[pick.candidateId].cid, publicBase: PUBLIC_APP_BASE
                }))
                : null;
            await updateRun(pool, e.runId, {
                stage: done ? until : furthest,
                status: personaFailed ? 'failed' : (done && until === 'staked' ? 'done' : 'running'),
                summaryPatch: {
                    designs, owners, agreements, mints, onchain, stakes, markets, marketFunding, bindingFailures, activities, lens: lens.key,
                    ...(outreach ? { outreach } : {}),
                    error: personaFailed ? failures.filter(value => value.startsWith(persona.name)).map(safeFailureDiagnostic).join('; ').slice(0, 500) : null,
                    outcome: personaFailed ? 'failed' : (done && until === 'staked' ? 'completed' : 'partial')
                }
            });
            const marketTrades = Object.values(stakes).filter(item => !item.skipped).length;
            const skippedOwnTrades = Object.values(stakes).filter(item => item.skipped).length;
            report.push(`${persona.name}: ${picks.length} picks · ${Object.keys(designs).length} designs · ${Object.keys(agreements).length} agreements · ${Object.keys(mints).length} minted · ${Object.keys(onchain).length} recorded · ${marketTrades} market trade(s) · ${skippedOwnTrades} own-market trade(s) skipped · $${(summary.pickCostUsd ?? 0).toFixed(4)}`);
        }
    } catch (error) {
        for (const runId of startedRuns) {
            const current = await getRun(pool, runId);
            if (current?.status === 'running') await markAgentRunFailed(pool, runId, error);
        }
        throw error;
    } finally {
        if (housingLock) {
            try { await housingLock.query('SELECT pg_advisory_unlock(57401, hashtext($1))', ['affordabot']); }
            finally { housingLock.release(); }
        }
        await pool.end();
    }

    const headline = `UGT proposing bots ${day}: ${report.join(' | ') || 'nothing to do'}`;
    log(headline);
    if (failures.length) {
        // No Telegram here: a failed run is reported once, in bot-monitor's 06:00 UTC message
        // (every persona has an outcome check). A per-run alert repeated every few hours.
        const text = `${headline}\n${failures.length} FAILURE(S):\n- ${failures.join('\n- ')}`;
        console.error(text);
        process.exit(1);
    }
    // This exact line is the external monitor's success sentinel. It is emitted only after every
    // persona has reached a non-failing terminal path, including the valid zero-pick outcome.
    log(`AGENT DAILY RUN — status=completed day=${day} personas=${personas.length}`);
    // A clean run is not news: Telegram carries only failures; the outcome is on the bots dashboard.
}

// Importable from tests (the stage and settlement functions above); main() runs only as the process's
// entry point (entrypoint.js: argv[1] or PM2's pm_exec_path).
if (isEntrypoint(import.meta.url)) {
    main().catch((err) => {
        console.error(`[${new Date().toISOString()}] FAILED:`, safeFailureDiagnostic(err));
        process.exit(1);
    });
}
