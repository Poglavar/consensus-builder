// The public activity feeds, on agreements (plan-design-agreement.md, M3). GET /agent/activity is the
// explorer's unified actor/action envelope for humans, algorithms and LLM agents; GET /activity/recent
// the landing page's compact feed of confirmed, useful changes; GET /activity/cities the agreements each
// city holds, for the globe; GET /agent/runs and /agent/runs/:runId the agent runs behind them. Events
// come from the index (an agreement proposed, a design published: consensus.agreement, consensus.design),
// from the chain (the agreement program's instructions, decoded here by their discriminators, and the
// market and pledge instructions whose subject is an agreement account: consensus.solana_transaction)
// and from the agent runs' recorded activities (consensus.agent_run). Every event is about an agreement
// or a design, named by its CID: a chain account becomes its agreement's CID through the account index
// built from consensus.agreement (the account recorded once minted, else PDA(sponsor, CID)), and a place
// on the map comes from the site bounds of the agreement's first design, else from its city.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { buildAddressBook } from '../solana/address-book.js';
import { decodeBase58, decodeParsedTransaction, loadIdls } from '../solana/tx-decoder.js';
import { formatAtomicAmount } from '../utils/x402-payment.js';
import { AGREEMENT_PROGRAM_ID, AgreementClient, agreementAccountOf } from '../agreements/onchain.js';
import { normalizeCityCode } from '../utils/city-code.js';

const require = createRequire(import.meta.url);
const web3 = require('@solana/web3.js');
// The market program's codec (proposal_market): its id and the market PDA of an agreement account. web3
// is injected because the codec's own require would resolve from frontend/.
const marketClient = require('../../frontend/js/solana/lmsr-client.js').configure({ web3 });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MARKET_PROGRAM_ID = marketClient.constants.PROGRAM_ID;
const USDC_DECIMALS = 6;

// The agreement program's instructions by the hex of their discriminators (the shared codec), and the
// action each one is in the feeds. tx-decoder.js has no IDL for this program, so its instructions arrive
// as raw data and an account list whose first account is the agreement (programs/agreement/README.md).
const AGREEMENT_INSTRUCTIONS = new Map(Object.entries(AgreementClient.IX_DISCRIMINATORS)
    .map(([name, bytes]) => [Buffer.from(bytes).toString('hex'), name]));
const AGREEMENT_ACTIONS = Object.freeze({
    create: 'mint', fund: 'fund', attest: 'attest', execute: 'execute', cancel: 'cancel', expire: 'expire'
});
// The market and pledge instructions (decoded from their IDLs by tx-decoder.js) the feeds show. Their
// subject is the agreement account, in the role the programs still call `proposal`; a market instruction
// without that role names the market, whose PDA the account index maps as well.
const SUBJECT_ACTIONS = new Map([
    ['proposal_market', new Map([
        ['create_lmsr_market', 'createMarket'], ['buy', 'stake'], ['sell', 'sell'], ['resolve_lmsr', 'resolve'], ['claim_lmsr', 'claim']
    ])],
    ['proposal_pledge', new Map([
        ['donate', 'donate'], ['refund_donation', 'refundMyDonations'], ['release_donations', 'releaseDonations'],
        ['set_pledge', 'pledge'], ['revoke_pledge', 'revokePledge'], ['fulfill_pledge', 'fulfillPledge'],
        ['void_pledge', 'voidPledge']
    ])]
]);
// The chain actions the landing feed shows: outcomes, bets and support. Its agreements arrive as proposed
// from the index; a mint, a fund or an attestation is detail for the explorer.
const RECENT_CHAIN_ACTIONS = new Set([
    'execute', 'cancel', 'expire', 'createMarket', 'stake', 'sell', 'resolve', 'claim', 'donate', 'pledge', 'fulfillPledge'
]);
// The bet's own actions; the landing feed keeps room for them and links them to the bet.
const BET_ACTIONS = new Set(['createMarket', 'stake', 'sell', 'resolve', 'claim']);

// Agreement rows as the feeds read them, with the goal and site bounds of the agreement's first design.
const AGREEMENT_ROWS = `
    SELECT a.cid, a.city, a.title, a.created_at, a.onchain, a.content->>'sponsor' AS sponsor,
           d.goal AS design_goal, d.bounds AS design_bounds
      FROM consensus.agreement a
      LEFT JOIN consensus.design d ON d.cid = a.design_cids[1]`;
// The agreements that have a chain account, or can have one: recorded once minted, derived from a sponsor.
const WITH_ACCOUNT = `a.onchain IS NOT NULL OR a.content->>'sponsor' IS NOT NULL`;
const DESIGN_ROWS = 'SELECT cid, city, goal, title, author, bounds, created_at FROM consensus.design';
const TRANSACTION_ROWS = 'SELECT signature, slot, block_time, raw, created_at FROM consensus.solana_transaction';

const iso = value => (value instanceof Date ? value.toISOString() : value ?? null);

function readPersonas() {
    try {
        return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'agents', 'personas.json'), 'utf8'));
    } catch {
        return { personas: [] };
    }
}

function asLimit(value) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) return 100;
    return Math.min(parsed, 250);
}

function accountFor(instruction, role) {
    return instruction?.accounts?.find(account => account.role === role)?.address || null;
}

// PDAs are pure functions of their seeds, and the feeds derive the same ones on every request.
const derivedAccounts = new Map();
function derived(key, derive) {
    if (!derivedAccounts.has(key)) derivedAccounts.set(key, derive());
    return derivedAccounts.get(key);
}

/**
 * Chain accounts to the agreements they belong to: { cid, account } by the agreement account and by the
 * PDA of its market. The agreement account is the one the index recorded once minted, else the one the
 * agreement's sponsor and CID derive; an agreement with neither has no account to find. Rows are
 * consensus.agreement rows with `cid`, `onchain` and `sponsor` (content.sponsor).
 */
export function agreementAccountIndex(rows = []) {
    const index = new Map();
    for (const row of rows) {
        const account = row.onchain?.account
            || derived(`agreement:${row.sponsor}:${row.cid}`, () => agreementAccountOf(row.cid, row.sponsor ?? null));
        if (!account) continue;
        const entry = { cid: row.cid, account };
        index.set(account, entry);
        if (row.sponsor) index.set(derived(`market:${account}:${row.sponsor}`, () => marketClient.getMarketPda(account, row.sponsor)[0].toBase58()), entry);
    }
    return index;
}

function activityActor(decoded, instruction, book) {
    const wallet = instruction.accounts?.find(account => account.signer)?.address
        || decoded.feePayer?.address
        || null;
    const entry = wallet ? book?.entryFor?.(wallet) : null;
    const persona = entry?.persona || null;
    return {
        id: wallet || 'chain-actor',
        name: persona || decoded.feePayer?.label || wallet || 'Chain actor',
        kind: persona ? 'agent' : 'human',
        controller: persona ? 'algorithm' : 'human',
        wallet
    };
}

// What one top-level instruction does to an agreement, or null when it is none the feeds show:
// { instruction (its name), type (the action), subject (the agreement or market account), fields }.
function agreementStep(instruction) {
    if (instruction.program?.address === AGREEMENT_PROGRAM_ID) {
        const data = typeof instruction.data === 'string' ? decodeBase58(instruction.data) : null;
        const name = data && data.length >= 8 ? AGREEMENT_INSTRUCTIONS.get(data.subarray(0, 8).toString('hex')) : null;
        const type = name ? AGREEMENT_ACTIONS[name] : null;
        if (!type) return null;
        const fields = {};
        // fund(lamports: u64): what this instruction moved into the escrow.
        if (name === 'fund' && data.length >= 16) fields.lamports = data.readBigUInt64LE(8).toString();
        return { instruction: name, type, subject: instruction.accounts?.[0]?.address || null, fields };
    }
    const type = SUBJECT_ACTIONS.get(instruction.program?.name)?.get(instruction.action);
    if (!type) return null;
    const fields = {};
    if (['buy', 'sell'].includes(instruction.action)) fields.side = Number(instruction.args?.side) === 1 ? 'yes' : 'no';
    if (instruction.action === 'buy') {
        if (instruction.args?.shares != null) fields.shares = String(instruction.args.shares);
        if (instruction.args?.max_cost != null) fields.maxCost = formatAtomicAmount(String(instruction.args.max_cost), USDC_DECIMALS);
    } else if (instruction.action === 'sell') {
        if (instruction.args?.shares != null) fields.shares = String(instruction.args.shares);
        if (instruction.args?.min_return != null) fields.minReturn = formatAtomicAmount(String(instruction.args.min_return), USDC_DECIMALS);
    } else if (instruction.args?.amount != null && ['donate', 'set_pledge'].includes(instruction.action)) {
        fields.amount = formatAtomicAmount(String(instruction.args.amount), USDC_DECIMALS);
    }
    return {
        instruction: instruction.action, type,
        subject: accountFor(instruction, 'proposal') || accountFor(instruction, 'market'), fields
    };
}

/**
 * Project confirmed program instructions on indexed agreements into the same actor/action envelope as
 * agent runs. An instruction on an account the index does not map (another wallet's account for a
 * published CID, a market on something else) is not an agreement's activity and is left out.
 */
export function chainEvents(rows = [], {
    book,
    idls,
    agreementsByAccount = new Map(),
    decode = decodeParsedTransaction
} = {}) {
    const events = [];
    for (const row of rows) {
        const decoded = decode(row.raw, { book, idls });
        if (!decoded?.signature) continue;
        (decoded.instructions || []).forEach((instruction, position) => {
            if (instruction.inner) return;
            const step = agreementStep(instruction);
            const agreement = step?.subject ? agreementsByAccount.get(step.subject) : null;
            if (!agreement) return;
            const actor = activityActor(decoded, instruction, book);
            const action = { type: step.type, agreementCid: agreement.cid, ...step.fields };
            events.push({
                id: `chain:${decoded.signature}:${instruction.index ?? position}:${action.type}`,
                source: 'live',
                actor,
                action,
                entity: { type: 'agreement', id: agreement.cid },
                agreementAccount: agreement.account,
                ok: decoded.status === 'success',
                message: `${actor.name} submitted ${action.type} for agreement ${agreement.cid}.`,
                transaction: decoded.signature,
                occurredAt: decoded.time || null,
                recordedAt: decoded.time || row.created_at || null,
                provenance: {
                    source: 'solana_transaction',
                    slot: decoded.slot,
                    program: instruction.program?.address || null,
                    instruction: step.instruction
                }
            });
        });
    }
    return events;
}

/** One `propose` event per agreement row: the agreement published to the index, when it arrived there. */
export function agreementEvents(rows = []) {
    return rows.map(row => ({
        id: `agreement:${row.cid}:proposed`, source: 'live',
        action: { type: 'propose', agreementCid: row.cid },
        entity: { type: 'agreement', id: row.cid },
        ok: true, transaction: null, occurredAt: iso(row.created_at), recordedAt: iso(row.created_at),
        message: `Agreement ${row.title || row.cid} was proposed.`
    }));
}

/** One `design` event per design row: the design published to the index, when it arrived there. */
export function designEvents(rows = []) {
    return rows.map(row => ({
        id: `design:${row.cid}:published`, source: 'live',
        ...(row.author ? { actor: { id: String(row.author), name: String(row.author), kind: 'unknown', controller: 'unknown' } } : {}),
        action: { type: 'design', designCid: row.cid },
        entity: { type: 'design', id: row.cid },
        ok: true, transaction: null, occurredAt: iso(row.created_at), recordedAt: iso(row.created_at),
        message: `Design ${row.title || row.cid} was published.`
    }));
}

// The centre of a site's bounds ({ west, south, east, north }, consensus.design.bounds), or null.
function centreOf(bounds) {
    if (!bounds || typeof bounds !== 'object') return null;
    const { west, south, east, north } = bounds;
    if (![west, south, east, north].every(value => typeof value === 'number' && Number.isFinite(value))) return null;
    if (west < -180 || east > 180 || south < -90 || north > 90 || west > east || south > north) return null;
    return { lat: (south + north) / 2, lon: (west + east) / 2 };
}

const byCid = rows => new Map(rows.map(row => [row.cid, row]));

// What a reader shows beside an event: the name of the agreement or design it is about, the goal (the
// design type) of that design or of the agreement's first design, the city, and a point on the map, the
// centre of that design's site bounds (without one the city is the place).
function withSubject(event, { agreements = new Map(), designs = new Map() } = {}) {
    const { type, id } = event.entity || {};
    if (type === 'agreement' && agreements.has(id)) {
        const row = agreements.get(id);
        const location = centreOf(row.design_bounds);
        return {
            ...event, agreementName: row.title ?? null, designGoal: row.design_goal ?? null,
            cityId: normalizeCityCode(row.city) || normalizeCityCode(event.cityId) || null,
            ...(location ? { location } : {})
        };
    }
    if (type === 'design' && designs.has(id)) {
        const row = designs.get(id);
        const location = centreOf(row.bounds);
        return {
            ...event, designName: row.title ?? null, designGoal: row.goal ?? null,
            cityId: normalizeCityCode(row.city) || normalizeCityCode(event.cityId) || null,
            ...(location ? { location } : {})
        };
    }
    return event;
}

function controllerOf(summary = {}) {
    if (summary.controller) return summary.controller;
    if (summary.decisionResult?.controller) return summary.decisionResult.controller;
    // Runs created before controller provenance was added still carry LLM-only evidence.
    if (summary.decisionResult?.model || summary.model || summary.batchId || Number(summary.pickCostUsd) > 0) return 'llm';
    return 'algorithm';
}

function personaWallet(book, persona) {
    const name = String(persona || '');
    if (!name) return null;
    return book?.entries?.find(entry => entry.kind === 'wallet' && entry.persona === name)?.address || null;
}

function runActor(row, summary, book) {
    const wallet = summary.wallet || personaWallet(book, row.persona);
    return {
        id: String(row.persona), name: String(row.persona), kind: 'agent', controller: controllerOf(summary), wallet
    };
}

function activityActorForRun(eventActor, runActor, persona) {
    if (!eventActor) return runActor;
    // A run can record an activity performed by another actor. Only add the run's known wallet
    // where the event explicitly identifies the run persona; never use it to relabel that actor.
    const actor = { ...eventActor };
    const isRunPersona = [actor.id, actor.name, actor.persona].some(value => String(value || '') === String(persona));
    return isRunPersona && !actor.wallet && runActor.wallet ? { ...actor, wallet: runActor.wallet } : actor;
}

// A proposer pick with what the run made of it (summary.designs, .agreements, .mints and .onchain are
// keyed by the pick's candidateId): its design, its agreement and that agreement's chain account.
function runPick(summary, pick) {
    const id = pick.candidateId;
    return {
        candidateId: id || null,
        name: pick.name || null,
        rationale: pick.rationale || null,
        designCid: summary.designs?.[id]?.cid || null,
        agreementCid: summary.agreements?.[id]?.cid || null,
        agreementAccount: summary.mints?.[id]?.account || summary.onchain?.[id]?.account || null
    };
}

// The picks of a run by the CIDs of the design and the agreement it published for each, so an activity
// about either finds the rationale it was chosen with.
function picksBySubject(summary) {
    const picks = new Map();
    for (const pick of Array.isArray(summary.picks) ? summary.picks : []) {
        const made = runPick(summary, pick);
        for (const cid of [made.designCid, made.agreementCid]) if (cid) picks.set(cid, made);
    }
    return picks;
}

// A run's events are the activities it recorded (every runner records what it did through the shared
// action engine); a run that recorded none (it chose nothing, replayed what was done, or stopped before
// acting) still shows that it ran.
function runEvents(row, book = null) {
    const summary = row.summary || {};
    const actor = runActor(row, summary, book);
    const recordedCity = normalizeCityCode(summary.city);
    const base = {
        source: 'live', actor, ok: row.status !== 'failed',
        occurredAt: row.updated_at || row.started_at, recordedAt: row.updated_at || row.started_at,
        runId: row.run_id,
        ...(recordedCity ? { cityId: recordedCity } : {}),
        model: summary.decisionResult?.model || summary.model || null,
        modelCostUsd: summary.decisionResult?.costUsd ?? summary.pickCostUsd ?? null,
        batchId: summary.decisionResult?.batchId || summary.batchId || null
    };
    const picks = picksBySubject(summary);
    const withRunContext = (event) => {
        const pick = picks.get(event?.entity?.id) || null;
        return {
            ...event,
            // The activity envelope remains shared. These are optional evidence fields, rather than
            // an agent-only shape, so a human or algorithmic event can carry the same provenance.
            rationale: event.rationale || pick?.rationale || null,
            provenance: event.provenance || {
                runId: row.run_id,
                stage: row.stage || null,
                mode: row.mode || null,
                transaction: event.transaction || null
            }
        };
    };
    if (Array.isArray(summary.activities) && summary.activities.length) {
        return summary.activities.map((event, index) => ({
            ...event,
            id: event.id || `activity:${row.run_id}:${index}`,
            source: 'live',
            actor: activityActorForRun(event.actor, actor, row.persona),
            runId: row.run_id,
            ...(!event.cityId && recordedCity ? { cityId: recordedCity } : {}),
            model: event.model || base.model,
            modelCostUsd: event.modelCostUsd ?? base.modelCostUsd,
            batchId: event.batchId || base.batchId
        })).map(withRunContext);
    }
    return [withRunContext({
        ...base, id: `run:${row.run_id}:${row.stage || 'started'}`,
        action: { type: 'run_status', stage: row.stage || 'started' },
        message: `${row.persona} agent run ${row.status}: ${row.stage || 'started'}.`
    })];
}

// Scope filters for /agent/activity (actor, source, action, agreement, run, city). Chain events are decoded
// in JS, so filtering happens after projection; a filtered request scans a wider, still bounded,
// window per source and reports it, so a client can tell "none in the window" from "none at all".
export const ACTIVITY_SCAN_WINDOW = 1000;

/**
 * The newest `limit` events, newest first, keeping up to half the places for bets: a burst of new
 * agreements (a whole superblock proposed at once) must not push every bet off the landing feed. Places
 * the bets do not use go to the other events, and the other way round.
 */
export function recentWithBets(events = [], limit = 12) {
    const sorted = events.slice().sort((a, b) => (Date.parse(b.occurredAt || b.recordedAt || 0) || 0)
        - (Date.parse(a.occurredAt || a.recordedAt || 0) || 0));
    const isBet = event => BET_ACTIONS.has(event.action?.type);
    const bets = sorted.filter(isBet);
    const rest = sorted.filter(event => !isBet(event));
    const betCount = Math.min(bets.length, Math.max(Math.ceil(limit / 2), limit - rest.length));
    const chosen = new Set([...bets.slice(0, betCount), ...rest.slice(0, limit - betCount)]);
    return sorted.filter(event => chosen.has(event));
}
const ACTIVITY_FILTER_FIELDS = ['actor', 'source', 'action', 'agreement', 'run', 'city'];

export function activityFilters(query = {}) {
    const filters = {};
    for (const field of ACTIVITY_FILTER_FIELDS) {
        const value = typeof query[field] === 'string' ? query[field].trim() : '';
        if (!value) continue;
        const bounded = value.slice(0, 200);
        const normalized = field === 'city' ? normalizeCityCode(bounded) : bounded;
        if (normalized) filters[field] = normalized;
    }
    return filters;
}

export function matchesActivityFilters(event, filters) {
    if (filters.actor && ![event.actor?.id, event.actor?.wallet, event.actor?.name].includes(filters.actor)) return false;
    if (filters.source && event.source !== filters.source) return false;
    if (filters.action && event.action?.type !== filters.action) return false;
    if (filters.agreement && ![event.entity?.type === 'agreement' ? event.entity.id : null, event.action?.agreementCid].includes(filters.agreement)) return false;
    if (filters.run && event.runId !== filters.run) return false;
    if (filters.city && normalizeCityCode(event.cityId) !== filters.city) return false;
    return true;
}

// One event per action, entity and transaction (else per id), oldest first. A later list replaces an
// earlier one's event: a run's own record of a chain action replaces the decoded one, and a run's
// design or propose replaces the index's.
function mergeEvents(...lists) {
    const byAction = new Map();
    lists.flat().forEach(event => {
        const hasEntityOrTransaction = Boolean(event.entity?.id || event.transaction);
        const key = hasEntityOrTransaction
            ? `${event.action?.type || ''}:${event.entity?.id || ''}:${event.transaction || ''}`
            : (event.id || `${event.recordedAt}:${event.message || ''}`);
        byAction.set(key, event);
    });
    return Array.from(byAction.values()).sort((left, right) => {
        const a = Date.parse(left.recordedAt || left.occurredAt || 0) || 0;
        const b = Date.parse(right.recordedAt || right.occurredAt || 0) || 0;
        return a - b;
    });
}

function runDetail(row, costs = [], book = null) {
    const summary = row.summary || {};
    const recordedCost = costs.reduce((total, cost) => total + (Number(cost.usd) || 0), 0);
    const summaryCost = Number(summary.decisionResult?.costUsd ?? summary.pickCostUsd ?? 0);
    return {
        id: row.run_id,
        persona: row.persona,
        role: summary.role || 'proposer',
        wallet: summary.wallet || personaWallet(book, row.persona),
        mode: row.mode,
        status: row.status,
        stage: row.stage,
        startedAt: row.started_at,
        finishedAt: row.finished_at || null,
        updatedAt: row.updated_at,
        controller: controllerOf(summary),
        model: summary.decisionResult?.model || summary.model || costs[0]?.model || null,
        modelCostUsd: recordedCost || (Number.isFinite(summaryCost) ? summaryCost : 0),
        batchId: summary.decisionResult?.batchId || summary.batchId || costs[0]?.batch_id || null,
        outcome: summary.outcome || null,
        // The lens key every agreement of the run names.
        lens: summary.lens || null,
        support: summary.support || null,
        picks: Array.isArray(summary.picks) ? summary.picks.map(pick => runPick(summary, pick)) : [],
        costs: costs.map(cost => ({
            item: cost.item,
            provider: cost.provider,
            model: cost.model,
            batchId: cost.batch_id,
            inputTokens: cost.input_tokens,
            outputTokens: cost.output_tokens,
            cacheReadTokens: cost.cache_read_tokens,
            cacheCreationTokens: cost.cache_creation_tokens,
            usd: Number(cost.usd),
            recordedAt: cost.created_at
        }))
    };
}

// Agreements per city, for the globe's city markers: rows of GROUP BY city folded by the city's id
// ('zg' and 'zagreb' are one city), largest first. Rows without a city are not a place on the globe
// and are left out.
export function cityAgreementCounts(rows = []) {
    const counts = new Map();
    for (const row of rows) {
        const id = normalizeCityCode(row?.city);
        const agreements = Number(row?.agreements);
        if (!id || !Number.isFinite(agreements) || agreements <= 0) continue;
        counts.set(id, (counts.get(id) || 0) + Math.floor(agreements));
    }
    return Array.from(counts, ([id, agreements]) => ({ id, agreements }))
        .sort((a, b) => b.agreements - a.agreements || a.id.localeCompare(b.id));
}

export function setupAgentActivityRoute(app, pool, {
    env = process.env,
    book = buildAddressBook({ env, personas: readPersonas() }),
    idls = loadIdls(path.join(__dirname, '..', '..', 'blockchain', 'solana', 'idl')),
    decode = decodeParsedTransaction
} = {}) {
    // A compact public feed of confirmed, useful changes. This deliberately reads the agreements
    // proposed to the index alongside successful confirmed transactions on indexed agreements: their
    // outcomes (execute, cancel, expire), bets and support.
    app.get('/activity/recent', async (req, res) => {
        res.set('Cache-Control', 'no-store');
        try {
            const requested = Number(req.query.limit);
            const limit = Number.isInteger(requested) && requested > 0 ? Math.min(requested, 30) : 12;
            const [proposed, withAccount, transactions, marketTransactions] = await Promise.all([
                pool.query(`${AGREEMENT_ROWS} ORDER BY a.created_at DESC, a.cid LIMIT $1`, [limit]),
                pool.query(`${AGREEMENT_ROWS} WHERE ${WITH_ACCOUNT}`),
                pool.query(
                    `${TRANSACTION_ROWS}
                      WHERE cluster = 'devnet'
                      ORDER BY block_time DESC NULLS LAST, slot DESC
                      LIMIT $1`, [limit * 4]
                ),
                // The market program's own recent transactions, so bets reach the feed even when
                // a burst of mints fills the general window above.
                pool.query(
                    `${TRANSACTION_ROWS}
                      WHERE cluster = 'devnet' AND touched_addresses @> ARRAY[$1]::text[]
                      ORDER BY block_time DESC NULLS LAST, slot DESC
                      LIMIT $2`, [MARKET_PROGRAM_ID, limit * 2]
                )
            ]);
            const transactionRows = [...new Map([...transactions.rows, ...marketTransactions.rows]
                .map(row => [row.signature, row])).values()];
            const confirmedChainEvents = chainEvents(transactionRows, {
                book, idls, agreementsByAccount: agreementAccountIndex(withAccount.rows), decode
            }).filter(event => event.ok === true && RECENT_CHAIN_ACTIONS.has(event.action.type));
            const agreements = byCid([...withAccount.rows, ...proposed.rows]);
            const events = recentWithBets(mergeEvents(agreementEvents(proposed.rows), confirmedChainEvents), limit)
                .map(event => withSubject(event, { agreements }));
            return res.json({ events, source: 'live' });
        } catch (error) {
            console.error(`[${new Date().toISOString()}] GET /activity/recent failed:`, error);
            return res.status(500).json({ error: 'Failed to read recent activity', source: 'live' });
        }
    });

    // How many agreements each city holds: what the globe paints its city dots and label badges with.
    // One grouped count; a minute of caching is plenty for a globe.
    app.get('/activity/cities', async (req, res) => {
        res.set('Cache-Control', 'public, max-age=60');
        try {
            const { rows } = await pool.query(
                `SELECT city, COUNT(*)::int AS agreements
                   FROM consensus.agreement
                  WHERE city IS NOT NULL
                  GROUP BY city`
            );
            return res.json({ cities: cityAgreementCounts(rows) });
        } catch (error) {
            console.error(`[${new Date().toISOString()}] GET /activity/cities failed:`, error);
            return res.status(500).json({ error: 'Failed to count agreements per city' });
        }
    });

    // The explorer's feed: agreements proposed and designs published to the index, decoded chain actions
    // on indexed agreements and the agent runs' recorded activities, the newest `limit` of them.
    app.get('/agent/activity', async (req, res) => {
        try {
            const limit = asLimit(req.query.limit);
            const filters = activityFilters(req.query);
            const filtered = Object.keys(filters).length > 0;
            const window = filtered ? ACTIVITY_SCAN_WINDOW : limit;
            const [runs, transactions, withAccount, proposed, designs] = await Promise.all([
                pool.query(
                    `SELECT run_id, persona, mode, status, stage, summary, started_at, updated_at
                       FROM consensus.agent_run
                      ORDER BY updated_at DESC
                      LIMIT $1`,
                    [window]
                ),
                pool.query(
                    `${TRANSACTION_ROWS}
                      WHERE cluster = 'devnet'
                      ORDER BY block_time DESC NULLS LAST, slot DESC
                      LIMIT $1`,
                    [window]
                ),
                pool.query(`${AGREEMENT_ROWS} WHERE ${WITH_ACCOUNT}`),
                pool.query(`${AGREEMENT_ROWS} ORDER BY a.created_at DESC, a.cid LIMIT $1`, [window]),
                pool.query(`${DESIGN_ROWS} ORDER BY created_at DESC, cid LIMIT $1`, [window])
            ]);
            const chain = chainEvents(transactions.rows, {
                book, idls, agreementsByAccount: agreementAccountIndex(withAccount.rows), decode
            });
            const subjects = { agreements: byCid([...withAccount.rows, ...proposed.rows]), designs: byCid(designs.rows) };
            const events = mergeEvents(
                agreementEvents(proposed.rows),
                designEvents(designs.rows),
                chain,
                runs.rows.flatMap(row => runEvents(row, book))
            ).map(event => withSubject(event, subjects))
                .filter(event => matchesActivityFilters(event, filters)).slice(-limit);
            res.json({
                events, count: events.length, source: 'live',
                ...(filtered ? { filters, scanWindow: ACTIVITY_SCAN_WINDOW } : {})
            });
        } catch (error) {
            console.error(`[${new Date().toISOString()}] GET /agent/activity failed:`, error);
            res.status(500).json({ error: 'Failed to read agent activity' });
        }
    });

    // Bounded run index for the judge/demo surface. This is intentionally separate from the event
    // feed: a completed zero-pick run is evidence of scheduler liveness even when it produced no
    // agreement transaction. Controller filtering is applied after legacy provenance inference.
    app.get('/agent/runs', async (req, res) => {
        try {
            const limit = asLimit(req.query.limit);
            const controller = String(req.query.controller || '').trim().toLowerCase();
            if (controller && !['algorithm', 'llm'].includes(controller)) {
                return res.status(400).json({ error: 'controller must be algorithm or llm' });
            }
            const { rows } = await pool.query(
                `SELECT run_id, persona, mode, status, stage, summary, started_at, finished_at, updated_at
                   FROM consensus.agent_run
                  ORDER BY updated_at DESC
                  LIMIT $1`,
                [controller ? 250 : limit]
            );
            const runs = rows.map(row => runDetail(row, [], book))
                .filter(run => !controller || run.controller === controller)
                .slice(0, limit);
            return res.json({ runs, count: runs.length });
        } catch (error) {
            console.error(`[${new Date().toISOString()}] GET /agent/runs failed:`, error);
            return res.status(500).json({ error: 'Failed to read agent runs' });
        }
    });

    // Read-only drill-down for the explorer. Costs are taken from the immutable per-call ledger,
    // never re-estimated from an activity message or model name.
    app.get('/agent/runs/:runId', async (req, res) => {
        try {
            const runId = String(req.params.runId || '').trim();
            if (!runId) return res.status(400).json({ error: 'runId is required' });
            const { rows } = await pool.query(
                `SELECT run_id, persona, mode, status, stage, summary, started_at, finished_at, updated_at
                   FROM consensus.agent_run
                  WHERE run_id = $1
                  LIMIT 1`,
                [runId]
            );
            const row = rows[0];
            if (!row) return res.status(404).json({ error: 'Agent run not found' });
            const costs = await pool.query(
                `SELECT item, provider, model, batch_id, input_tokens, output_tokens,
                        cache_read_tokens, cache_creation_tokens, usd, created_at
                   FROM consensus.agent_cost
                  WHERE run_id = $1
                  ORDER BY created_at ASC, id ASC`,
                [runId]
            );
            return res.json({ run: runDetail(row, costs.rows, book), events: runEvents(row, book) });
        } catch (error) {
            console.error(`[${new Date().toISOString()}] GET /agent/runs/:runId failed:`, error);
            return res.status(500).json({ error: 'Failed to read agent run' });
        }
    });
}

export { asLimit, controllerOf, mergeEvents, runDetail, runEvents };
