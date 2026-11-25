// Contests: a city's published agreements grouped by the ground their designs take, with each minted
// agreement's prediction market beside it (plan-design-agreement.md, "Simplifications" 10). This is
// the shape behind GET /markets and the Bets sheet. Pure: the route feeds it index rows, the design
// sites it read and decoded market accounts; nothing here touches the database or an RPC.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { parcelSourceCatalog, resolveParcelSourceDescriptor } from '../parcels/sources.js';
import { agreementAccountOf } from '../agreements/onchain.js';
const terminalStatus = status => ['executed', 'cancelled', 'expired'].includes(status);

const require = createRequire(import.meta.url);
// The sheet's own model (frontend/js/bets/bets-model.js): the same state words and the same order,
// so the API and the Bets sheet cannot disagree about which row leads.
const { compareContests, compareRows } = require('../../frontend/js/bets/bets-model.js');
// The shared "does this shape take that ground" rule (docs/geometry-tolerances.md), the one binding uses.
const ground = require('../../frontend/js/geometry-tolerances.js');
const turf = require('@turf/turf');

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

/**
 * Government plan plots ({ source, recordId }: a planning source and its record), sorted and distinct.
 * A design drawn on a plan plot cites it (design sourceReferences); the plot is that agreement's land
 * where no cadastral parcel lies, e.g. state land in a general plan.
 */
export function normalizePlanPlots(value) {
    const byKey = new Map();
    for (const plot of Array.isArray(value) ? value : []) {
        const source = typeof plot?.source === 'string' ? plot.source.trim() : '';
        const recordId = typeof plot?.recordId === 'string' ? plot.recordId.trim() : '';
        if (source && recordId) byKey.set(JSON.stringify([source, recordId]), { source, recordId });
    }
    return [...byKey.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, plot]) => plot);
}

// The keys of all the land an agreement stands on: its qualified input parcels and its plan plots. Two
// agreements sharing a key are compared on the ground; a plot key never equals a parcel key.
const landKeysOf = agreement => [
    ...parcelRefsOf(agreement).map(refKey),
    ...normalizePlanPlots(agreement?.planPlots).map(plot => JSON.stringify(['plan-plot', plot.source, plot.recordId]))
];

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

/** The agreement's designs, as CIDs (consensus.agreement.design_cids). */
export function designCidsOf(agreement) {
    const list = Array.isArray(agreement?.designCids) ? agreement.designCids : [];
    return Array.from(new Set(list.filter(cid => typeof cid === 'string' && cid))).sort();
}

/**
 * Stable contest id: the designs whose ground the contest is about (a design's CID fixes its site),
 * not the agreements, so another agreement over the same designs stands in the same contest. Two
 * contests never hold one design (agreements sharing a design are one contest), so ids never collide,
 * however many contests stand on one parcel.
 */
export function contestId(designCids, fallback = '') {
    const cids = designCidsOf({ designCids });
    const seed = cids.length ? `designs:${JSON.stringify(cids)}` : `agreement:${fallback}`;
    return `c-${createHash('sha256').update(seed).digest('hex').slice(0, 12)}`;
}

// Pairs of agreements (indices into `list`) that share a qualified input parcel or a plan plot: the only
// pairs whose ground is compared, so agreements on parcels of different sources, or no land, never meet.
function sharingPairs(list) {
    const byParcel = new Map();
    list.forEach((agreement, index) => {
        for (const key of new Set(landKeysOf(agreement))) {
            if (!byParcel.has(key)) byParcel.set(key, []);
            byParcel.get(key).push(index);
        }
    });
    const pairs = new Map();
    for (const indices of byParcel.values()) {
        for (let i = 0; i < indices.length; i++) {
            for (let j = i + 1; j < indices.length; j++) pairs.set(`${indices[i]}:${indices[j]}`, [indices[i], indices[j]]);
        }
    }
    return Array.from(pairs.values());
}

/** The designs whose sites decide the contests: those of agreements sharing a qualified input parcel or a plan plot. */
export function designCidsToCompare(agreements) {
    const list = Array.isArray(agreements) ? agreements : [];
    const cids = new Set();
    for (const pair of sharingPairs(list)) for (const index of pair) designCidsOf(list[index]).forEach(cid => cids.add(cid));
    return Array.from(cids).sort();
}

/**
 * Whether two agreements' designs take overlapping ground: they share a design, or a design site of
 * one reaches into a design site of the other (geometry-tolerances.js reachesInto: the overlap is
 * ground, wider than noise and than the wider of the two designs' own tolerances). `designLand`:
 * design CID → { site, toleranceM }, the site (GeoJSON Polygon or MultiPolygon) the design's binding
 * was computed on and that binding's toleranceM (consensus.design). A design whose site is not known
 * reaches nothing. Answers are kept per pair: the route judges one cached read on every request.
 * A clip the shared rule cannot make is logged and judged apart, so one bad site never blanks the
 * Bets sheet.
 */
export function landOverlap(designLand = new Map()) {
    const features = new Map();
    const featureOf = cid => {
        if (!features.has(cid)) {
            const site = designLand.get(cid)?.site;
            features.set(cid, site && ['Polygon', 'MultiPolygon'].includes(site.type) ? { type: 'Feature', properties: {}, geometry: site } : null);
        }
        return features.get(cid);
    };
    const toleranceOf = cid => {
        const value = designLand.get(cid)?.toleranceM;
        return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
    };
    const reaches = (a, b) => {
        const shape = featureOf(a);
        const other = featureOf(b);
        if (!shape || !other) return false;
        try {
            return ground.reachesInto(turf, shape, other, Math.max(toleranceOf(a), toleranceOf(b)), { site: 'markets/contests.landOverlap', proposalId: a });
        } catch (error) {
            console.error(`[${new Date().toISOString()}] contests: the sites of designs ${a} and ${b} could not be clipped; judged apart:`, error);
            return false;
        }
    };
    const answers = new Map();
    return (first, second) => {
        const key = JSON.stringify([first?.cid, second?.cid].sort());
        if (!answers.has(key)) {
            const mine = designCidsOf(first);
            const theirs = designCidsOf(second);
            answers.set(key, mine.some(cid => theirs.includes(cid)) || mine.some(a => theirs.some(b => reaches(a, b))));
        }
        return answers.get(key);
    };
}

/**
 * Union-find over overlapping ground: two agreements sharing a qualified input parcel join when
 * `overlaps(a, b)` (landOverlap) says their designs take overlapping ground, and contests are what
 * those joins connect, transitively. Sharing a parcel alone joins nothing: agreements whose designs
 * stand apart on one large parcel are separate contests.
 */
export function groupByLand(agreements, overlaps = () => false) {
    const list = Array.isArray(agreements) ? agreements : [];
    const parent = list.map((_, index) => index);
    const find = index => (parent[index] === index ? index : (parent[index] = find(parent[index])));
    const union = (a, b) => { parent[find(a)] = find(b); };
    for (const [a, b] of sharingPairs(list)) {
        if (find(a) !== find(b) && overlaps(list[a], list[b])) union(a, b);
    }
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

function marketEntry({ market, address }, source, now) {
    const external = market.kind === 1;
    const active = external || source.chainStatus === 'active';
    const closesAt = Number(market.closesAt);
    const afterGrace = now > closesAt + market.graceSeconds;
    const bettable = !market.resolved && !market.proposed && active && now < closesAt;
    const canSettle = !market.resolved && (external || terminalStatus(source.chainStatus) || afterGrace);
    return {
        address, kind: external ? 'recipe' : 'agreement', model: 'lmsr', asset: 'devnet-usdc', creator: market.creator,
        creatorRole: market.creator === source.sponsor ? 'sponsor' : source.lenses.includes(market.creator) ? 'verifier' : null,
        b: String(market.b), qYes: String(market.qYes), qNo: String(market.qNo), seed: String(market.seed),
        closesAt, graceSeconds: market.graceSeconds, maxPosition: String(market.maxPosition), paidOut: String(market.paidOut),
        resolved: Boolean(market.resolved), outcome: market.resolved ? ['no', 'yes', 'void'][Number(market.outcome)] : null,
        bettable, canSettle,
        ...(external ? { recipeHash: Buffer.from(market.recipeHash).toString('hex'), trustedAttester: market.trustedAttester,
            credential: market.credential, schema: market.schema, proposed: Boolean(market.proposed),
            challengeEndsAt: market.challengeEndsAt == null ? null : Number(market.challengeEndsAt) } : {})
    };
}

function agreementEntry(agreement, markets, nowMs) {
    const account = agreement.account || null;
    const source = account ? markets.get(account) : null;
    const chainStatus = account ? (source ? source.chainStatus : agreement.chainStatus) ?? null : null;
    const deadline = source ? source.deadline : agreement.deadline;
    const deadlinePassed = deadline && Date.parse(deadline) <= nowMs;
    const marketEntries = (source?.markets || []).map(item => marketEntry(item, source, Math.floor(nowMs / 1000)))
        .sort((a, b) => Number(b.bettable) - Number(a.bettable) ||
            (BigInt(a.b) === BigInt(b.b) ? a.address.localeCompare(b.address) : BigInt(a.b) > BigInt(b.b) ? -1 : 1));
    return {
        kind: 'agreement',
        cid: agreement.cid,
        account,
        title: agreement.title || null,
        author: agreement.author || null,
        sponsor: agreement.sponsor || null,
        city: agreement.city || null,
        status: terminalStatus(chainStatus) ? chainStatus : deadlinePassed ? 'expired' : 'active',
        chainStatus,
        deadline: deadline || null,
        createdAt: agreement.createdAt || null,
        designTitles: Array.isArray(agreement.designTitles) ? agreement.designTitles : [],
        screenshotUrl: agreement.screenshotUrl || null,
        screenshotBeforeUrl: agreement.screenshotBeforeUrl || null,
        screenshotPairUrl: agreement.screenshotPairUrl || null,
        parcelIds: normalizeParcelIds(agreement.inputParcelIds),
        parcelRefs: parcelRefsOf(agreement),
        planPlots: normalizePlanPlots(agreement.planPlots),
        markets: marketEntries,
        bettable: marketEntries.some(item => item.bettable),
        canSettle: marketEntries.some(item => item.canSettle),
        canOpenMarket: Boolean(account && chainStatus)
    };
}

/**
 * Build the public contests payload for one city.
 * @param {{ city: string, agreements: Array<object>, markets?: Map<string, { sponsor: string, lenses: string[], chainStatus: string, deadline: string|null, markets: Array<{ address: string, market: object }> }>, overlaps?: Function, now?: Date }} input
 *   agreements: { cid, title, author, city, designCids, inputParcelIds, parcelSourceId, planPlots, deadline,
 *   createdAt, designTitles, screenshotUrl, screenshotBeforeUrl, screenshotPairUrl, account,
 *   chainStatus } (routes/markets.js rowToAgreement); markets: agreement account → its decoded market
 *   account; overlaps: whether two agreements' designs take overlapping ground (landOverlap over the
 *   design sites the route read); without it every agreement is a contest of its own.
 *   Only contests with at least one minted agreement are returned: a contest nobody can bet on is
 *   a list of agreements, not a market. Unminted agreements stay in a contest beside minted ones,
 *   without a pool. Entries and contests come in the Bets sheet's order (bets-model.js compareRows,
 *   compareContests).
 */
export function buildContests({ city, agreements, markets = new Map(), overlaps = () => false, now = new Date() }) {
    const nowMs = now.getTime();
    const contests = groupByLand(agreements, overlaps).map(group => {
        const parcelRefs = normalizeParcelRefs(group.flatMap(parcelRefsOf));
        const id = contestId(group.flatMap(designCidsOf), group.map(agreement => agreement.cid).sort()[0] || '');
        const entries = group.map(agreement => ({ ...agreementEntry(agreement, markets, nowMs), contest: id })).sort(compareRows);
        const withMarket = entries.flatMap(entry => entry.markets);
        return {
            id,
            parcelIds: normalizeParcelIds(group.flatMap(agreement => normalizeParcelIds(agreement.inputParcelIds))),
            parcelRefs,
            planPlots: normalizePlanPlots(group.flatMap(agreement => normalizePlanPlots(agreement.planPlots))),
            agreementCount: entries.length,
            mintedCount: entries.filter(entry => entry.account).length,
            marketCount: withMarket.length,
            openMarketCount: withMarket.filter(market => market.bettable).length,
            sharesAtomic: withMarket.reduce((sum, entry) => sum + atomic(entry.qYes) + atomic(entry.qNo), 0n).toString(),
            latestCreatedAt: entries.reduce((latest, entry) => (timeOf(entry.createdAt) > timeOf(latest) ? entry.createdAt : latest), null),
            agreements: entries
        };
    }).filter(contest => contest.mintedCount > 0)
        .sort(compareContests);

    return { city, generatedAt: now.toISOString(), summary: summarize(contests), contests };
}

function summarize(contests) {
    return contests.reduce((acc, contest) => ({
        contests: acc.contests + 1,
        agreements: acc.agreements + contest.agreementCount,
        markets: acc.markets + contest.marketCount,
        openMarkets: acc.openMarkets + contest.openMarketCount,
        sharesAtomic: (atomic(acc.sharesAtomic) + atomic(contest.sharesAtomic)).toString()
    }), { contests: 0, agreements: 0, markets: 0, openMarkets: 0, sharesAtomic: '0' });
}

// Every city but `city`: each city's contests are built on their own (parcel numbers of two cities
// never join one contest), carry their city, and are ordered together as one list.
export function buildOtherCityContests({ city, agreements, markets = new Map(), overlaps = () => false, now = new Date() }) {
    const byCity = new Map();
    for (const agreement of Array.isArray(agreements) ? agreements : []) {
        if (!agreement.city || agreement.city === city) continue;
        if (!byCity.has(agreement.city)) byCity.set(agreement.city, []);
        byCity.get(agreement.city).push(agreement);
    }
    const contests = [...byCity].flatMap(([other, list]) =>
        buildContests({ city: other, agreements: list, markets, overlaps, now }).contests.map(contest => ({ ...contest, city: other })))
        .sort(compareContests);
    return { city, scope: 'other', generatedAt: now.toISOString(), summary: summarize(contests), contests };
}
