// Client of the design and agreement index (plan-design-agreement.md, M2 "Courier and index", M3): pins a
// canonical design/v1 or agreement/v1 object through the courier (POST /pins), indexes it (POST /designs,
// POST /agreements), asks what a site binds (POST /designs/binding), relays owner decisions (GET and POST
// /agreements/:cid/decisions), records an agreement's chain account (POST /agreements/:cid/onchain) and
// reads the index back. The proposer runner, the MCP tools and the
// restatement scripts share it. Every CID is computed here (backend/cid.js) and an answer naming another
// is refused. Every write is safe to repeat: an object is filed under its CID, and 409 answers the row
// the index already holds.
import { setTimeout as delay } from 'node:timers/promises';
import { canonicalBytes, cidOf, isCid } from '../cid.js';
import { createRetryingFetch } from '../utils/retrying-fetch.js';

// The courier shares the upload routes' per-client budget (30 pins per 15 minutes): a caller that pins a
// whole restatement waits for the window instead of failing half-way.
export const MAX_RATE_LIMIT_WAIT_MS = 16 * 60 * 1000;
const RATE_LIMIT_ROUNDS = 4;
const BATCH_LIMIT = 1000;
// The index reads a fresh mint on its own RPC: a few pauses cover its lag behind the sender's.
const ONCHAIN_ATTEMPTS = 4;
const ONCHAIN_PAUSE_MS = 5000;

export function cleanApiBase(value) {
    const text = String(value || '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\/[^/\s]+/.test(text)) throw new Error(`the API base must be an http(s) URL, got ${JSON.stringify(value)}`);
    return text;
}

// An index answer that is not what was asked: { status, code, body } ride on the error.
function refusal(what, result) {
    const code = result.body?.code || `http-${result.status}`;
    const reason = result.body?.error || (result.text ? result.text.replace(/\s+/g, ' ').slice(0, 300) : `HTTP ${result.status}`);
    return Object.assign(new Error(`${what} refused (${result.status} ${code}): ${reason}`), { status: result.status, code, body: result.body });
}

function mismatch(what, expected, received) {
    return Object.assign(new Error(`${what}: the server answered ${received ?? 'no CID'}, not ${expected}; nothing is trusted from it`),
        { code: 'cid-mismatch', expected, received: received ?? null });
}

function requireCid(cid, label = 'cid') {
    if (!isCid(cid)) throw new Error(`${label} must be a CIDv1 UnixFS sha2-256 base32 CID, got ${JSON.stringify(cid)}`);
    return cid;
}

/**
 * The CID and canonical bytes of an object, as the courier and the index compute them.
 * @returns {{ cid: string, bytes: Buffer }}
 */
export function addressOf(object) {
    const bytes = canonicalBytes(object);
    return { cid: cidOf(bytes), bytes };
}

/** Whether an agreement row's `onchain` record (routes/agreements.js POST /agreements/:cid/onchain) is this account. */
export function onchainNames(row, account) {
    return Boolean(row?.onchain && account && row.onchain.account === String(account));
}

/**
 * @param {{ apiBase: string, origin?: string|null, fetchImpl?: Function, timeoutMs?: number,
 *           waitOnRateLimit?: boolean, pinIntervalMs?: number, now?: Function, wait?: Function, log?: Function }} options
 *   origin: sent on writes (the API's write guard admits the app's origins; a headless caller names one).
 *   waitOnRateLimit: wait out a 429 (Retry-After, at most MAX_RATE_LIMIT_WAIT_MS) instead of failing.
 */
export function createIndexClient({
    apiBase, origin = null, fetchImpl = globalThis.fetch, timeoutMs = 60_000,
    waitOnRateLimit = false, pinIntervalMs = 0, now = Date.now, wait = delay, log = () => {}
} = {}) {
    const base = cleanApiBase(apiBase);
    if (!Number.isFinite(pinIntervalMs) || pinIntervalMs < 0) throw new Error('pinIntervalMs must be non-negative');
    // POST is replayed only on transport failures and 5xx: every write here is keyed by a CID.
    const retrying = createRetryingFetch({
        fetchImpl, timeoutMs, retryMethods: new Set(['GET', 'POST']),
        // This client owns 429 cooldowns: the generic short retry loop must not replay them first.
        shouldRetryResponse: response => response.status !== 429, wait,
        requestLabel: ({ method }) => `index-${method.toLowerCase()}`
    });

    const pinned = new Map();
    let pinQueue = Promise.resolve();
    let nextPinAt = 0;

    async function call(method, path, body) {
        for (let round = 1; ; round += 1) {
            const headers = { accept: 'application/json' };
            if (body !== undefined) headers['content-type'] = 'application/json';
            if (method !== 'GET' && origin) headers.origin = origin;
            const response = await retrying(`${base}${path}`, {
                method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) })
            });
            const text = await response.text();
            let json = null;
            try { json = text ? JSON.parse(text) : null; } catch (_) { json = null; }
            if (response.status === 429 && waitOnRateLimit && round < RATE_LIMIT_ROUNDS) {
                const header = response.headers.get('retry-after');
                const headerSeconds = Number(header);
                const headerMs = Number.isFinite(headerSeconds) ? headerSeconds * 1000 : Date.parse(header) - now();
                const bodyMs = Number(json?.retryAfterSeconds) * 1000;
                const declared = Math.max(Number.isFinite(headerMs) ? headerMs : 0, Number.isFinite(bodyMs) ? bodyMs : 0);
                const ms = declared > 0 ? declared : 60_000 * 2 ** (round - 1);
                // Never retry earlier than a server cooldown that exceeds our bounded wait.
                if (ms > MAX_RATE_LIMIT_WAIT_MS) return { status: response.status, ok: response.ok, body: json, text };
                log(`${method} ${path.split('?')[0]}: rate limited; waiting ${Math.round(ms / 1000)} s (round ${round}/${RATE_LIMIT_ROUNDS - 1})`);
                await wait(ms);
                continue;
            }
            return { status: response.status, ok: response.ok, body: json, text };
        }
    }

    /** POST /pins: { cid, pinnedAt } of exactly these canonical bytes. */
    async function pin(kind, object) {
        if (!['design', 'plan', 'agreement'].includes(kind)) throw new Error('kind must be design, plan or agreement');
        const { cid, bytes } = addressOf(object);
        if (pinned.has(cid)) return pinned.get(cid);
        const queued = pinQueue.then(async () => {
            if (pinned.has(cid)) return pinned.get(cid);
            const pause = nextPinAt - now();
            if (pause > 0) await wait(pause);
            nextPinAt = now() + pinIntervalMs;
            const result = await call('POST', '/pins', { kind, cid, bytes: bytes.toString('base64') });
            nextPinAt = now() + pinIntervalMs;
            if (!result.ok) throw refusal(`pin ${kind} ${cid}`, result);
            if (result.body?.cid !== cid) throw mismatch(`pin ${kind}`, cid, result.body?.cid);
            const receipt = { cid, pinnedAt: result.body.pinnedAt ?? null };
            pinned.set(cid, receipt);
            return receipt;
        });
        pinQueue = queued.catch(() => {});
        return queued;
    }

    /** POST /designs: { row, created } (created false: the CID was indexed already). */
    async function indexDesign(cid, content, { parcelSourceId = null } = {}) {
        requireCid(cid);
        const result = await call('POST', '/designs', { cid, content, parcelSourceId });
        if (result.status !== 201 && result.status !== 409) throw refusal(`index design ${cid}`, result);
        if (result.body?.cid !== cid) throw mismatch('index design', cid, result.body?.cid);
        return { row: result.body, created: result.status === 201 };
    }

    /** Pin and index one design/v1 object: { cid, row, created }. */
    async function publishDesign(content, { parcelSourceId = null } = {}) {
        const { cid } = addressOf(content);
        let stage = 'pin-design'; const pinnedCids = [];
        try {
            await pin('design', content); pinnedCids.push(cid); stage = 'index-design';
            const { row, created } = await indexDesign(cid, content, { parcelSourceId });
            return { cid, row, created };
        } catch (error) { throw Object.assign(error, { cid, stage, pinnedCids, indexed: false }); }
    }

    /** POST /designs/binding: what a design on this site would bind ({ city, parcelSourceId, binding }); nothing is stored. */
    async function designBinding({ site, toleranceM = null, city = null, parcelSourceId = null } = {}) {
        if (!site || !['Polygon', 'MultiPolygon'].includes(site.type)) throw new Error('designBinding needs a Polygon or MultiPolygon site');
        const result = await call('POST', '/designs/binding', {
            site, ...(toleranceM === null ? {} : { toleranceM }), ...(city ? { city } : {}), ...(parcelSourceId ? { parcelSourceId } : {})
        });
        if (!result.ok || !result.body?.binding) throw refusal('design binding', result);
        return result.body;
    }

    /** GET /designs/:cid → the row, or null when the index does not hold it. */
    async function getDesign(cid) {
        const result = await call('GET', `/designs/${encodeURIComponent(requireCid(cid))}`);
        if (result.status === 404) return null;
        if (!result.ok) throw refusal(`read design ${cid}`, result);
        if (result.body?.cid !== cid) throw mismatch('read design', cid, result.body?.cid);
        return result.body;
    }

    /** POST /designs/batch → Map(cid → row) of the designs the index holds. */
    async function getDesigns(cids) {
        const wanted = [...new Set((cids || []).map(cid => requireCid(cid)))];
        const rows = new Map();
        for (let start = 0; start < wanted.length; start += BATCH_LIMIT) {
            const result = await call('POST', '/designs/batch', { cids: wanted.slice(start, start + BATCH_LIMIT) });
            if (!result.ok || !Array.isArray(result.body?.items)) throw refusal('read designs', result);
            for (const item of result.body.items) {
                if (item?.design && item.design.cid === item.cid) rows.set(item.cid, item.design);
            }
        }
        return rows;
    }

    /**
     * POST /agreements: { row, created }. `designs` carries [{ cid, content }] of linked designs the index
     * does not hold yet, indexed in the same transaction.
     */
    async function indexAgreement(cid, content, { plan, designs = [] } = {}) {
        requireCid(cid);
        const body = { cid, content, ...(plan ? { plan } : {}), ...(designs.length ? { designs } : {}) };
        const result = await call('POST', '/agreements', body);
        if (result.status !== 201 && result.status !== 409) throw refusal(`index agreement ${cid}`, result);
        if (result.body?.cid !== cid) throw mismatch('index agreement', cid, result.body?.cid);
        return { row: result.body, created: result.status === 201 };
    }

    /** Pin and index one agreement/v1 object: { cid, row, created }. */
    async function publishAgreement(content, { plan, designs = [] } = {}) {
        const { cid } = addressOf(content);
        let stage = plan ? 'pin-plan' : 'pin-agreement'; const pinnedCids = [];
        try {
            if (plan) {
                if (!plan.content || plan.cid !== content.planCid || addressOf(plan.content).cid !== plan.cid) {
                    throw mismatch('agreement plan', content.planCid, plan.cid);
                }
                await pin('plan', plan.content); pinnedCids.push(plan.cid);
            }
            stage = 'pin-agreement';
            await pin('agreement', content); pinnedCids.push(cid); stage = 'index-agreement';
            const { row, created } = await indexAgreement(cid, content, { plan, designs });
            return { cid, row, created };
        } catch (error) { throw Object.assign(error, { cid, stage, pinnedCids, indexed: false }); }
    }

    /**
     * POST /agreements/:cid/onchain { chain, cluster, account, signature }: the account the agreement was
     * minted as (201 recorded, 200 refreshed). The server reads the account and the transaction on its own
     * RPC, which can lag the sender's: a signature it cannot see yet is asked again after a pause.
     */
    async function recordOnchain(cid, { chain = 'solana', cluster, account, signature = null } = {}) {
        requireCid(cid);
        if (!cluster || !account) throw new Error('recordOnchain needs cluster and account');
        for (let attempt = 1; ; attempt += 1) {
            const result = await call('POST', `/agreements/${encodeURIComponent(cid)}/onchain`, { chain, cluster, account, signature });
            if (result.ok) {
                if (!onchainNames(result.body, account)) throw mismatch('record the chain account', account, result.body?.onchain?.account);
                return result.body;
            }
            const unseen = ['onchain-signature-not-found', 'onchain-account-missing'].includes(result.body?.code);
            if (!unseen || attempt >= ONCHAIN_ATTEMPTS) throw refusal(`record the chain account of ${cid}`, result);
            log(`POST /agreements/${cid}/onchain: ${result.body.code}; asking again in ${ONCHAIN_PAUSE_MS * attempt / 1000} s (${attempt}/${ONCHAIN_ATTEMPTS})`);
            await wait(ONCHAIN_PAUSE_MS * attempt);
        }
    }

    /** GET /agreements/:cid/decisions → every relayed owner decision (receipt) on the agreement, in signing order. */
    async function listDecisions(cid) {
        const result = await call('GET', `/agreements/${encodeURIComponent(requireCid(cid))}/decisions`);
        if (!result.ok || !Array.isArray(result.body?.decisions)) throw refusal(`read the decisions on ${cid}`, result);
        if (result.body.agreementCid !== cid) throw mismatch('read decisions', cid, result.body.agreementCid);
        return result.body.decisions;
    }

    /**
     * POST /agreements/:cid/decisions { receipt }: { stored, duplicate } (201 stored, 200 already stored).
     * The relay re-verifies the receipt's three signatures and refuses one that does not apply.
     */
    async function relayDecision(cid, receipt) {
        const result = await call('POST', `/agreements/${encodeURIComponent(requireCid(cid))}/decisions`, { receipt });
        if (result.status !== 201 && result.status !== 200) throw refusal(`relay a decision on ${cid}`, result);
        return { stored: result.body?.stored === true, duplicate: result.body?.duplicate === true };
    }

    /** GET /agreements/:cid → the row, or null when the index does not hold it. */
    async function getAgreement(cid) {
        const result = await call('GET', `/agreements/${encodeURIComponent(requireCid(cid))}`);
        if (result.status === 404) return null;
        if (!result.ok) throw refusal(`read agreement ${cid}`, result);
        if (result.body?.cid !== cid) throw mismatch('read agreement', cid, result.body?.cid);
        return result.body;
    }

    /** GET /agreements?city=&design=&parcel=&limit= → { agreements, count }, newest first. */
    async function listAgreements({ city = null, design = null, parcel = null, limit = null } = {}) {
        const query = new URLSearchParams();
        if (city) query.set('city', city);
        if (design) query.set('design', requireCid(design, 'design'));
        if (parcel) query.set('parcel', parcel);
        if (limit) query.set('limit', String(limit));
        const text = query.toString();
        const result = await call('GET', `/agreements${text ? `?${text}` : ''}`);
        if (!result.ok || !Array.isArray(result.body?.agreements)) throw refusal('list agreements', result);
        return result.body;
    }

    return {
        apiBase: base, pin, indexDesign, publishDesign, designBinding, getDesign, getDesigns,
        indexAgreement, publishAgreement, listDecisions, relayDecision, recordOnchain, getAgreement, listAgreements
    };
}
