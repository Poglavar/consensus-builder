// Contests: a city's proposals grouped by the land they claim, with each proposal's prediction
// market beside it. This is the shape behind GET /markets and the Bets sheet. Pure — the route
// feeds it proposal rows and decoded market accounts; nothing here touches the database or an RPC.
import { createHash } from 'node:crypto';

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** The Solana proposal account a published proposal was minted as, or null. */
export function proposalAccountOf(onchainData) {
    const data = onchainData && typeof onchainData === 'object' ? onchainData : null;
    if (!data) return null;
    const chain = String(data.chainId || data.chain || '').toLowerCase();
    if (!chain.startsWith('solana')) return null;
    const account = String(data.proposalId || data.proposalAccount || data.tokenId || '').trim();
    return BASE58.test(account) ? account : null;
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
    const market = proposalAccount ? marketEntry(markets.get(proposalAccount)) : null;
    const lifecycleStatus = String(proposal.lifecycleStatus || 'Active');
    // What the market program will see: the proposal account's own status when it was readable.
    // The database's expiry-aware status is the display word; it can run ahead of the chain (an
    // app deadline passed, no verdict settled yet), and the program only honours the chain.
    const chainStatus = proposalAccount && statuses && statuses.get(proposalAccount) ? statuses.get(proposalAccount) : null;
    const active = (chainStatus || lifecycleStatus) === 'Active';
    return {
        id: proposal.id,
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
        parcelIds: normalizeParcelIds(proposal.parcelIds),
        siteName: proposal.siteName || null,
        proposalAccount,
        market,
        // Bets are only possible on an open market of a proposal that is still Active on-chain.
        bettable: Boolean(market && !market.resolved && active),
        // A minted, Active proposal without a market: anyone can open the (single) market for it.
        canOpenMarket: Boolean(proposalAccount && !market && active)
    };
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
    let best = null;
    for (const [name, count] of counts) if (!best || count > best.count) best = { name, count };
    return best ? best.name : null;
}

function compareProposals(a, b) {
    const pool = atomic(b.market?.poolAtomic) - atomic(a.market?.poolAtomic);
    if (pool !== 0n) return pool > 0n ? 1 : -1;
    if (a.bettable !== b.bettable) return a.bettable ? -1 : 1;
    if (Boolean(a.proposalAccount) !== Boolean(b.proposalAccount)) return a.proposalAccount ? -1 : 1;
    return timeOf(b.createdAt) - timeOf(a.createdAt);
}

function compareContests(a, b) {
    if ((a.openMarketCount > 0) !== (b.openMarketCount > 0)) return a.openMarketCount > 0 ? -1 : 1;
    const pool = atomic(b.poolAtomic) - atomic(a.poolAtomic);
    if (pool !== 0n) return pool > 0n ? 1 : -1;
    if (a.proposalCount !== b.proposalCount) return b.proposalCount - a.proposalCount;
    return timeOf(b.latestCreatedAt) - timeOf(a.latestCreatedAt);
}

/**
 * Build the public contests payload for one city.
 * @param {{ city: string, proposals: Array<object>, markets: Map<string, { address: string, market: object|null }>, statuses?: Map<string, string>, now?: Date }} input
 *   statuses: proposal account → on-chain status name ('Active' | 'Executed' | 'Cancelled' | 'Expired').
 *   proposals: { id, proposalId, title, goal, lifecycleStatus, createdAt, expiresAt, author, agent,
 *   proposalRole, screenshotUrl, parcelIds, proposalAccount }. Only contests with at least one
 *   minted proposal are returned: a contest nobody can bet on is a proposals list, not a market.
 */
export function buildContests({ city, proposals, markets = new Map(), statuses = new Map(), now = new Date() }) {
    const contests = groupByLand(proposals).map(group => {
        const entries = group.map(proposal => proposalEntry(proposal, markets, statuses)).sort(compareProposals);
        const parcelIds = normalizeParcelIds(group.flatMap(proposal => normalizeParcelIds(proposal.parcelIds)));
        const withMarket = entries.filter(entry => entry.market);
        const pool = withMarket.reduce((sum, entry) => sum + atomic(entry.market.poolAtomic), 0n);
        return {
            id: contestId(parcelIds, entries[0]?.proposalId || ''),
            parcelIds,
            siteName: siteNameOf(entries),
            proposalCount: entries.length,
            mintedCount: entries.filter(entry => entry.proposalAccount).length,
            marketCount: withMarket.length,
            openMarketCount: entries.filter(entry => entry.bettable).length,
            poolAtomic: pool.toString(),
            latestCreatedAt: entries.reduce((latest, entry) => (timeOf(entry.createdAt) > timeOf(latest) ? entry.createdAt : latest), null),
            proposals: entries
        };
    }).filter(contest => contest.mintedCount > 0).sort(compareContests);

    const summary = contests.reduce((acc, contest) => ({
        contests: acc.contests + 1,
        proposals: acc.proposals + contest.proposalCount,
        markets: acc.markets + contest.marketCount,
        openMarkets: acc.openMarkets + contest.openMarketCount,
        poolAtomic: (atomic(acc.poolAtomic) + atomic(contest.poolAtomic)).toString()
    }), { contests: 0, proposals: 0, markets: 0, openMarkets: 0, poolAtomic: '0' });

    return { city, generatedAt: now.toISOString(), summary, contests };
}
