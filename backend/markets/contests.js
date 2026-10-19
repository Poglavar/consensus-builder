// Contests: a city's proposals and named plans grouped by the land they claim, with each one's
// prediction market beside it. This is the shape behind GET /markets and the Bets sheet. A named plan
// (plans.md) is an entry of its own over its members' land; proposals that belong to a plan in the
// contest fold under it instead of standing as separate rows, and so do the plan's older versions
// (a revision records `supersedes`). Pure — the route feeds it rows and decoded market accounts;
// nothing here touches the database or an RPC.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { PublicKey } from '@solana/web3.js';
import { PROPOSAL_PROGRAM_ID } from '../oracle/proposal-lifecycle.js';

const require = createRequire(import.meta.url);
// The sheet's own model (frontend/js/bets/bets-model.js): the same state words and the same order,
// so the API and the Bets sheet cannot disagree about which row leads.
const { compareContests, compareRows, rowState } = require('../../frontend/js/bets/bets-model.js');

export const DEVNET_PROPOSAL_LOCATION_SQL = `
    onchain_data->>'chainId' = 'solana-devnet'
    AND onchain_data->>'contractAddress' = '${PROPOSAL_PROGRAM_ID}'`;

/** A declared account in the deployment this market serves; the RPC reader verifies the account. */
export function proposalAccountOf(onchainData) {
    const data = onchainData && typeof onchainData === 'object' ? onchainData : null;
    if (!data) return null;
    if (data.chainId !== 'solana-devnet' || data.contractAddress !== PROPOSAL_PROGRAM_ID) return null;
    if (typeof data.proposalId !== 'string') return null;
    try {
        const account = new PublicKey(data.proposalId).toBase58();
        return account === data.proposalId ? account : null;
    } catch { return null; }
}

export function normalizeParcelIds(value) {
    const list = Array.isArray(value) ? value : [];
    return Array.from(new Set(list.map(item => String(item ?? '').trim()).filter(Boolean))).sort();
}

/** Stable contest id: the land, not the proposals, so a new proposal joins an existing contest. */
export function contestId(parcelIds, fallback = '') {
    const ids = normalizeParcelIds(parcelIds);
    const seed = ids.length ? `land:${ids.join('\n')}` : `proposal:${fallback}`;
    return `c-${createHash('sha256').update(seed).digest('hex').slice(0, 12)}`;
}

/** Union-find over shared parcel ids: proposals that touch any common parcel share a contest. */
export function groupByLand(proposals) {
    const list = Array.isArray(proposals) ? proposals : [];
    const parent = list.map((_, index) => index);
    const find = index => (parent[index] === index ? index : (parent[index] = find(parent[index])));
    const union = (a, b) => { parent[find(a)] = find(b); };
    const firstByParcel = new Map();
    list.forEach((proposal, index) => {
        for (const id of normalizeParcelIds(proposal.parcelIds)) {
            if (firstByParcel.has(id)) union(index, firstByParcel.get(id));
            else firstByParcel.set(id, index);
        }
    });
    const groups = new Map();
    list.forEach((proposal, index) => {
        const root = find(index);
        if (!groups.has(root)) groups.set(root, []);
        groups.get(root).push(proposal);
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

// The market's own deadline as an ISO instant, or null. A decoded account carries it as i64 Unix
// seconds (market-client.js reads i64 as BigInt); a legacy pool has none.
export function closesAtOf(market) {
    const value = market ? market.closesAt : null;
    if (value === null || value === undefined || value === '') return null;
    const unixSeconds = typeof value === 'bigint' || typeof value === 'number' || /^\d+$/.test(String(value));
    // 0 is an unset deadline, not 1970.
    if (unixSeconds && !(Number(value) > 0)) return null;
    const date = unixSeconds ? new Date(Number(value) * 1000) : new Date(String(value));
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
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

function proposalEntry(proposal, markets, statuses) {
    const proposalAccount = proposal.proposalAccount || null;
    const decoded = proposalAccount ? markets.get(proposalAccount) : null;
    const market = marketEntry(decoded);
    const lifecycleStatus = String(proposal.lifecycleStatus || 'Active');
    // What the market program will see: the proposal account's own status when it was readable.
    // The database's expiry-aware status is the display word; it can run ahead of the chain (an
    // app deadline passed, no verdict settled yet), and the program only honours the chain.
    const chainStatus = proposalAccount && statuses && statuses.get(proposalAccount) ? statuses.get(proposalAccount) : null;
    const active = (chainStatus || lifecycleStatus) === 'Active';
    return {
        id: proposal.id,
        kind: 'proposal',
        proposalId: proposal.proposalId,
        title: proposal.title || null,
        goal: proposal.goal || null,
        lifecycleStatus,
        chainStatus,
        createdAt: proposal.createdAt || null,
        expiresAt: proposal.expiresAt || null,
        author: proposal.author || null,
        agent: Boolean(proposal.agent),
        proposalRole: proposal.proposalRole || null,
        screenshotUrl: proposal.screenshotUrl || null,
        screenshotBeforeUrl: proposal.screenshotBeforeUrl || null,
        parcelIds: normalizeParcelIds(proposal.parcelIds),
        siteName: proposal.siteName || null,
        proposalAccount,
        market,
        // The market's deadline when it has one (dated markets); rows in play sort by it.
        closesAt: market ? closesAtOf(decoded.market) : null,
        // Bets are only possible on an open market of a proposal that is still Active on-chain.
        bettable: Boolean(market && !market.resolved && active),
        // A minted, Active proposal without a market: anyone can open the (single) market for it.
        canOpenMarket: Boolean(proposalAccount && !market && active)
    };
}

// A named plan as a contest entry: same market fields as a proposal, plus its members.
function planEntry(plan, markets, statuses, proposalsById) {
    const base = proposalEntry({
        id: `plan:${plan.slug}`,
        proposalId: plan.slug,
        title: plan.title || plan.slug,
        goal: 'plan',
        lifecycleStatus: 'Active',
        createdAt: plan.createdAt,
        expiresAt: null,
        author: plan.author,
        parcelIds: plan.parcelIds,
        siteName: plan.place,
        proposalAccount: plan.proposalAccount
    }, markets, statuses);
    const members = (plan.memberIds || []).map(String).filter(id => proposalsById.has(id)).map(id => {
        const member = proposalsById.get(id);
        return { id: member.id, proposalId: member.proposalId, title: member.title || null, goal: member.goal || null };
    });
    return { ...base, kind: 'plan', planSlug: plan.slug, supersedes: plan.supersedes || null, memberCount: members.length, members };
}

// A version a newer one in the same contest replaced. It stays reachable for the bets already in its
// pool (to settle and collect) but is never offered: not bettable, and no new pool. `state` is where
// its pool stands, read as if it were current (an open pool says 'open'); its members are the
// current version's business, so only their count travels.
function olderVersionEntry(plan, supersededBy, markets, statuses, proposalsById) {
    const { members, ...entry } = planEntry(plan, markets, statuses, proposalsById);
    return {
        ...entry,
        slug: plan.slug,
        supersededBy,
        state: rowState({ ...entry, canOpenMarket: false }),
        bettable: false,
        canOpenMarket: false
    };
}

/**
 * The versions of named plans in one contest (plans.md: a revision is a new plan that records
 * `supersedes`). A plan another plan in the same list supersedes is not current; it folds under the
 * newest version of its chain, newest first, each with the slug that replaced it. A plan whose
 * predecessor is not in the list (another contest's land) simply stands. Returns
 * { current: [plan], older: Map(slug → [{ plan, supersededBy }]) }.
 */
export function foldVersions(plans) {
    const list = Array.isArray(plans) ? plans : [];
    const bySlug = new Map(list.map(plan => [plan.slug, plan]));
    const replaced = new Set(list.map(plan => plan.supersedes).filter(slug => slug && bySlug.has(slug)));
    const claimed = new Set();
    const older = new Map();
    const walk = head => {
        claimed.add(head.slug);
        const chain = [];
        let newer = head;
        while (newer.supersedes && bySlug.has(newer.supersedes) && !claimed.has(newer.supersedes)) {
            const plan = bySlug.get(newer.supersedes);
            claimed.add(plan.slug);
            chain.push({ plan, supersededBy: newer.slug });
            newer = plan;
        }
        older.set(head.slug, chain);
    };
    const current = list.filter(plan => !replaced.has(plan.slug));
    current.forEach(walk);
    // Plans that supersede each other in a loop have no newest version; the first of them stands, so
    // nothing disappears from the list.
    for (const plan of list) {
        if (!claimed.has(plan.slug)) { current.push(plan); walk(plan); }
    }
    return { current, older };
}

// A blockName the app generated from a parcel selection ("Parcel HR-335614-2355", "Parcels 12, 13")
// names nothing; only an authored site name counts.
const GENERATED_SITE_NAME = /^parcels?\b/i;

// The name the contest's proposals gave their land, when any did: the most common one wins.
export function siteNameOf(entries) {
    const counts = new Map();
    for (const entry of entries) {
        const name = typeof entry.siteName === 'string' ? entry.siteName.trim() : '';
        if (name && !GENERATED_SITE_NAME.test(name)) counts.set(name, (counts.get(name) || 0) + 1);
    }
    // A named plan's place is an authored name for the whole site; it outranks pieces' block names.
    for (const entry of entries) {
        if (entry.kind === 'plan' && typeof entry.siteName === 'string' && entry.siteName.trim()) {
            const name = entry.siteName.trim();
            counts.set(name, (counts.get(name) || 0) + 1_000_000);
        }
    }
    let best = null;
    for (const [name, count] of counts) if (!best || count > best.count) best = { name, count };
    return best ? best.name : null;
}

/**
 * Build the public contests payload for one city.
 *   plans: named plans { slug, title, place, author, createdAt, memberIds (proposal row ids),
 *   proposalAccount, supersedes } — their land is the union of their members' parcels. A plan another
 *   plan in its contest supersedes is no entry of its own: it folds under the newest version as
 *   `olderVersions`, and the contest counts (proposalCount, planCount, mintedCount, marketCount,
 *   openMarketCount, poolAtomic) are of current versions; foldedCount counts folded members and
 *   older versions together.
 * @param {{ city: string, proposals: Array<object>, markets: Map<string, { address: string, market: object|null }>, statuses?: Map<string, string>, now?: Date }} input
 *   statuses: proposal account → on-chain status name ('Active' | 'Executed' | 'Cancelled' | 'Expired').
 *   proposals: { id, proposalId, title, goal, lifecycleStatus, createdAt, expiresAt, author, agent,
 *   proposalRole, screenshotUrl, parcelIds, proposalAccount }. Only contests with at least one
 *   minted proposal are returned: a contest nobody can bet on is a proposals list, not a market.
 *   Entries and contests come in the Bets sheet's order (bets-model.js compareRows, compareContests).
 */
export function buildContests({ city, proposals, plans = [], markets = new Map(), statuses = new Map(), now = new Date() }) {
    const proposalsById = new Map(proposals.map(proposal => [String(proposal.id), proposal]));
    const planItems = plans.map(plan => ({
        ...plan,
        isPlan: true,
        parcelIds: normalizeParcelIds((plan.memberIds || []).flatMap(id => proposalsById.get(String(id))?.parcelIds || []))
    })).filter(plan => plan.parcelIds.length);
    const contests = groupByLand([...proposals, ...planItems]).map(group => {
        const groupPlans = group.filter(item => item.isPlan);
        // Members of every version fold away, so a piece an older version used does not resurface as a row.
        const folded = new Set(groupPlans.flatMap(plan => (plan.memberIds || []).map(String)));
        const versions = foldVersions(groupPlans);
        const entries = [
            ...versions.current.map(plan => ({
                ...planEntry(plan, markets, statuses, proposalsById),
                olderVersions: versions.older.get(plan.slug)
                    .map(({ plan: old, supersededBy }) => olderVersionEntry(old, supersededBy, markets, statuses, proposalsById))
            })),
            ...group.filter(item => !item.isPlan && !folded.has(String(item.id))).map(proposal => proposalEntry(proposal, markets, statuses))
        ].sort(compareRows);
        const olderCount = groupPlans.length - versions.current.length;
        const parcelIds = normalizeParcelIds(group.flatMap(item => normalizeParcelIds(item.parcelIds)));
        const withMarket = entries.filter(entry => entry.market);
        const pool = withMarket.reduce((sum, entry) => sum + atomic(entry.market.poolAtomic), 0n);
        return {
            id: contestId(parcelIds, entries[0]?.proposalId || ''),
            parcelIds,
            siteName: siteNameOf(entries),
            proposalCount: entries.length,
            planCount: versions.current.length,
            foldedCount: folded.size + olderCount,
            mintedCount: entries.filter(entry => entry.proposalAccount).length,
            marketCount: withMarket.length,
            openMarketCount: entries.filter(entry => entry.bettable).length,
            poolAtomic: pool.toString(),
            latestCreatedAt: entries.reduce((latest, entry) => (timeOf(entry.createdAt) > timeOf(latest) ? entry.createdAt : latest), null),
            proposals: entries
        };
    // An older version's pool keeps its contest listed even when no current version is minted yet,
    // so the bets in it can still be settled and collected.
    }).filter(contest => contest.mintedCount > 0 || contest.proposals.some(entry => (entry.olderVersions || []).some(old => old.proposalAccount)))
        .sort(compareContests);

    const summary = contests.reduce((acc, contest) => ({
        contests: acc.contests + 1,
        proposals: acc.proposals + contest.proposalCount,
        markets: acc.markets + contest.marketCount,
        openMarkets: acc.openMarkets + contest.openMarketCount,
        poolAtomic: (atomic(acc.poolAtomic) + atomic(contest.poolAtomic)).toString()
    }), { contests: 0, proposals: 0, markets: 0, openMarkets: 0, poolAtomic: '0' });

    return { city, generatedAt: now.toISOString(), summary, contests };
}
