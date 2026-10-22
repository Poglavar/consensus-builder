// Contests: a city's published agreements grouped by the land they take, with each minted
// agreement's prediction market beside it (plan-design-agreement.md, "Simplifications" 10). This is
// the shape behind GET /markets and the Bets sheet. Pure: the route feeds it index rows and decoded
// market accounts; nothing here touches the database or an RPC.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { parcelSourceCatalog, resolveParcelSourceDescriptor } from '../parcels/sources.js';
import { agreementAccountOf } from '../agreements/onchain.js';
import { marketOutcome } from '../oracle/market-recipe.js';

const require = createRequire(import.meta.url);
// The sheet's own model (frontend/js/bets/bets-model.js): the same state words and the same order,
// so the API and the Bets sheet cannot disagree about which row leads.
const { compareContests, compareRows } = require('../../frontend/js/bets/bets-model.js');

// The source the server binds a city's designs against when an agreement names none and the city
// has no catalogue default (backend/proposals/binding.js computeBinding).
export const HR_CADASTRE = Object.freeze({ sourceId: 'hr-cadastre', snapshotId: null });

/**
 * The market's subject: the agreement's chain account as the index's `onchain` records it
 * ({ chain: 'solana', cluster: 'devnet', account, … }, agreements/onchain.js), kept only when it is
 * the account this CID and sponsor derive (PDA ["agreement", sponsor, sha256(cid)]). Another
 * wallet's account for the same CID can never record the lens decision, so it never selects a
 * market; an agreement without a sponsor has no account.
 */
export function subjectAccountOf({ cid, sponsor, onchain } = {}) {
    const pointer = onchain && typeof onchain === 'object' ? onchain : null;
    if (!pointer || pointer.chain !== 'solana' || pointer.cluster !== 'devnet' || typeof pointer.account !== 'string') return null;
    try {
        return agreementAccountOf(cid, sponsor) === pointer.account ? pointer.account : null;
    } catch {
        return null;
    }
}

/**
 * The parcel source an agreement's input ids are in: the one it names, else its city's default
 * catalogue source, else the Croatian cadastre, the same choice the server's binding makes. An
 * unknown named source qualifies nothing (null): raw ids from it never match another agreement's.
 */
export function parcelSourceOf({ city = null, parcelSourceId = null } = {}) {
    if (parcelSourceId === HR_CADASTRE.sourceId) return HR_CADASTRE;
    let descriptor = null;
    try {
        descriptor = parcelSourceId === null || parcelSourceId === undefined
            ? parcelSourceCatalog.sources.find(source => source.defaultForCity !== false && Array.isArray(source.cityIds) && source.cityIds.includes(city)) || null
            : resolveParcelSourceDescriptor(parcelSourceId);
    } catch {
        return null;
    }
    if (parcelSourceId !== null && parcelSourceId !== undefined && !descriptor) return null;
    return descriptor ? { sourceId: descriptor.id, snapshotId: descriptor.snapshotId || null } : HR_CADASTRE;
}

export function normalizeParcelIds(value) {
    const list = Array.isArray(value) ? value : [];
    return Array.from(new Set(list.map(item => String(item ?? '').trim()).filter(Boolean))).sort();
}

/** The agreement's input land as qualified references (sourceId, snapshotId, parcelId). */
export function parcelRefsOf(agreement) {
    const source = parcelSourceOf(agreement || {});
    if (!source) return [];
    return normalizeParcelIds(agreement.inputParcelIds).map(parcelId => ({ ...source, parcelId }));
}

const refKey = ref => JSON.stringify([ref.sourceId, ref.snapshotId, ref.parcelId]);

export function normalizeParcelRefs(value) {
    const byKey = new Map();
    for (const ref of Array.isArray(value) ? value : []) {
        const parcelId = typeof ref?.parcelId === 'string' ? ref.parcelId.trim() : '';
        if (typeof ref?.sourceId !== 'string' || !ref.sourceId || !parcelId) continue;
        const normalized = { sourceId: ref.sourceId, snapshotId: ref.snapshotId || null, parcelId };
        byKey.set(refKey(normalized), normalized);
    }
    return [...byKey.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, ref]) => ref);
}

/** Stable contest id: the land, not the agreements, so a new agreement joins an existing contest. */
export function contestId(parcelRefs, fallback = '') {
    const refs = normalizeParcelRefs(parcelRefs);
    const seed = refs.length ? `land:${JSON.stringify(refs)}` : `unqualified-agreement:${fallback}`;
    return `c-${createHash('sha256').update(seed).digest('hex').slice(0, 12)}`;
}

/** Union-find over shared qualified input parcel references. */
export function groupByLand(agreements) {
    const list = Array.isArray(agreements) ? agreements : [];
    const parent = list.map((_, index) => index);
    const find = index => (parent[index] === index ? index : (parent[index] = find(parent[index])));
    const union = (a, b) => { parent[find(a)] = find(b); };
    const firstByParcel = new Map();
    list.forEach((agreement, index) => {
        for (const ref of parcelRefsOf(agreement)) {
            const key = refKey(ref);
            if (firstByParcel.has(key)) union(index, firstByParcel.get(key));
            else firstByParcel.set(key, index);
        }
    });
    const groups = new Map();
    list.forEach((agreement, index) => {
        const root = find(index);
        if (!groups.has(root)) groups.set(root, []);
        groups.get(root).push(agreement);
    });
    return Array.from(groups.values());
}

function atomic(value) {
    try { return BigInt(value ?? 0); } catch (_) { return 0n; }
}

function timeOf(value) {
    const ms = value instanceof Date ? value.getTime() : Date.parse(value || '');
    return Number.isFinite(ms) ? ms : 0;
}

function marketEntry(decoded) {
    if (!decoded || !decoded.market) return null;
    const market = decoded.market;
    const yesPool = atomic(market.yesPool);
    const noPool = atomic(market.noPool);
    const resolved = Boolean(market.resolved);
    return {
        address: decoded.address || null,
        yesPool: yesPool.toString(),
        noPool: noPool.toString(),
        poolAtomic: (yesPool + noPool).toString(),
        resolved,
        outcome: resolved ? (Number(market.outcome) === 1 ? 'yes' : 'no') : null
    };
}

/**
 * One agreement as a contest entry. `status` is the word shown: the chain's terminal status when
 * the lifecycle oracle observed one, else expired once the deadline passed, else active.
 * `chainStatus` is what the market program resolves from (null when unminted or unobserved). A pool
 * takes bets and can be opened only while the account is Active and the deadline, after which the
 * agreement can no longer execute, lies ahead.
 */
function agreementEntry(agreement, markets, nowMs) {
    const account = agreement.account || null;
    const market = marketEntry(account ? markets.get(account) : null);
    const chainStatus = account ? agreement.chainStatus || null : null;
    const deadlineMs = agreement.deadline ? Date.parse(agreement.deadline) : NaN;
    const deadlinePassed = Number.isFinite(deadlineMs) && deadlineMs <= nowMs;
    const live = chainStatus === 'active' && !deadlinePassed;
    return {
        kind: 'agreement',
        cid: agreement.cid,
        account,
        title: agreement.title || null,
        author: agreement.author || null,
        city: agreement.city || null,
        status: marketOutcome(chainStatus) ? chainStatus : deadlinePassed ? 'expired' : 'active',
        chainStatus,
        deadline: agreement.deadline || null,
        createdAt: agreement.createdAt || null,
        designTitles: Array.isArray(agreement.designTitles) ? agreement.designTitles : [],
        screenshotUrl: agreement.screenshotUrl || null,
        screenshotBeforeUrl: agreement.screenshotBeforeUrl || null,
        screenshotPairUrl: agreement.screenshotPairUrl || null,
        parcelIds: normalizeParcelIds(agreement.inputParcelIds),
        parcelRefs: parcelRefsOf(agreement),
        market,
        bettable: Boolean(market && !market.resolved && live),
        canOpenMarket: Boolean(account && !market && live)
    };
}

/**
 * Build the public contests payload for one city.
 * @param {{ city: string, agreements: Array<object>, markets?: Map<string, { address: string, market: object|null }>, now?: Date }} input
 *   agreements: { cid, title, author, city, inputParcelIds, parcelSourceId, deadline, createdAt,
 *   designTitles, screenshotUrl, screenshotBeforeUrl, screenshotPairUrl, account, chainStatus }
 *   (routes/markets.js rowToAgreement); markets: agreement account → its decoded market account.
 *   Only contests with at least one minted agreement are returned: a contest nobody can bet on is
 *   a list of agreements, not a market. Unminted agreements stay in a contest beside minted ones,
 *   without a pool. Entries and contests come in the Bets sheet's order (bets-model.js compareRows,
 *   compareContests).
 */
export function buildContests({ city, agreements, markets = new Map(), now = new Date() }) {
    const nowMs = now.getTime();
    const contests = groupByLand(agreements).map(group => {
        const parcelRefs = normalizeParcelRefs(group.flatMap(parcelRefsOf));
        const id = contestId(parcelRefs, group.map(agreement => agreement.cid).sort()[0] || '');
        const entries = group.map(agreement => ({ ...agreementEntry(agreement, markets, nowMs), contest: id })).sort(compareRows);
        const withMarket = entries.filter(entry => entry.market);
        return {
            id,
            parcelIds: normalizeParcelIds(group.flatMap(agreement => normalizeParcelIds(agreement.inputParcelIds))),
            parcelRefs,
            agreementCount: entries.length,
            mintedCount: entries.filter(entry => entry.account).length,
            marketCount: withMarket.length,
            openMarketCount: entries.filter(entry => entry.bettable).length,
            poolAtomic: withMarket.reduce((sum, entry) => sum + atomic(entry.market.poolAtomic), 0n).toString(),
            latestCreatedAt: entries.reduce((latest, entry) => (timeOf(entry.createdAt) > timeOf(latest) ? entry.createdAt : latest), null),
            agreements: entries
        };
    }).filter(contest => contest.mintedCount > 0)
        .sort(compareContests);

    const summary = contests.reduce((acc, contest) => ({
        contests: acc.contests + 1,
        agreements: acc.agreements + contest.agreementCount,
        markets: acc.markets + contest.marketCount,
        openMarkets: acc.openMarkets + contest.openMarketCount,
        poolAtomic: (atomic(acc.poolAtomic) + atomic(contest.poolAtomic)).toString()
    }), { contests: 0, agreements: 0, markets: 0, openMarkets: 0, poolAtomic: '0' });

    return { city, generatedAt: now.toISOString(), summary, contests };
}
