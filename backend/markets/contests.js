// Contests: a city's proposals grouped by their qualified land references, with each one's prediction
// market beside it. This is the shape behind GET /markets and the Bets sheet. Pure — the route feeds
// it rows and decoded market accounts; nothing here touches the database or an RPC.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { PublicKey } from '@solana/web3.js';
import { PROPOSAL_PROGRAM_ID } from '../oracle/proposal-lifecycle.js';
import { canonicalizeLifecycleStatus } from '../proposals/lifecycle.js';
import { normalizeParcelSource } from '../proposals/parcel-set.js';
import { resolveParcelSourceDescriptor } from '../parcels/sources.js';

const require = createRequire(import.meta.url);
// The sheet's own model (frontend/js/bets/bets-model.js): the same state words and the same order,
// so the API and the Bets sheet cannot disagree about which row leads.
const { compareContests, compareRows } = require('../../frontend/js/bets/bets-model.js');

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

export function normalizeKnownParcelSource(value) {
    let normalized;
    try { normalized = normalizeParcelSource(value); } catch { return null; }
    if (!normalized) return null;
    if (normalized.sourceId !== 'hr-cadastre') {
        try { if (!resolveParcelSourceDescriptor(normalized.sourceId)) return null; } catch { return null; }
    }
    return normalized;
}

export function parcelRefsOf(proposal) {
    const parcelSource = normalizeKnownParcelSource(proposal?.parcelSource);
    if (!parcelSource) return [];
    return normalizeParcelIds(proposal?.parcelIds).map(parcelId => ({ ...parcelSource, parcelId }));
}

export function normalizeParcelRefs(value) {
    const refs = Array.isArray(value) ? value : [];
    const byKey = new Map();
    for (const ref of refs) {
        const source = normalizeKnownParcelSource({ sourceId: ref?.sourceId, snapshotId: ref?.snapshotId });
        const parcelId = typeof ref?.parcelId === 'string' ? ref.parcelId.trim() : '';
        if (!source || !parcelId) continue;
        const normalized = { ...source, parcelId };
        byKey.set(JSON.stringify([normalized.sourceId, normalized.snapshotId, normalized.parcelId]), normalized);
    }
    return [...byKey.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, ref]) => ref);
}

/** Stable contest id: the land, not the proposals, so a new proposal joins an existing contest. */
export function contestId(parcelRefs, fallback = '') {
    const refs = normalizeParcelRefs(parcelRefs);
    const seed = refs.length ? `land:${JSON.stringify(refs)}` : `unqualified-proposal:${fallback}`;
    return `c-${createHash('sha256').update(seed).digest('hex').slice(0, 12)}`;
}

/** Union-find over shared qualified parcel references. */
export function groupByLand(proposals) {
    const list = Array.isArray(proposals) ? proposals : [];
    const parent = list.map((_, index) => index);
    const find = index => (parent[index] === index ? index : (parent[index] = find(parent[index])));
    const union = (a, b) => { parent[find(a)] = find(b); };
    const firstByParcel = new Map();
    list.forEach((proposal, index) => {
        for (const ref of parcelRefsOf(proposal)) {
            const key = JSON.stringify([ref.sourceId, ref.snapshotId, ref.parcelId]);
            if (firstByParcel.has(key)) union(index, firstByParcel.get(key));
            else firstByParcel.set(key, index);
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
    const lifecycleStatus = canonicalizeLifecycleStatus(proposal.lifecycleStatus) || 'Unknown';
    // What the market program will see: the proposal account's own status when it was readable.
    // The database's expiry-aware status is the display word; it can run ahead of the chain (an
    // app deadline passed, no verdict settled yet), and the program only honours the chain.
    const chainStatus = proposalAccount && statuses && statuses.get(proposalAccount) ? statuses.get(proposalAccount) : null;
    const active = chainStatus === 'Active';
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
        screenshotPairUrl: proposal.screenshotPairUrl || null,
        parcelIds: normalizeParcelIds(proposal.parcelIds),
        parcelRefs: parcelRefsOf(proposal),
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

/**
 * Build the public contests payload for one city.
 * @param {{ city: string, proposals: Array<object>, markets: Map<string, { address: string, market: object|null }>, statuses?: Map<string, string>, now?: Date }} input
 *   statuses: proposal account → on-chain status name ('Active' | 'Executed' | 'Cancelled' | 'Expired').
 *   proposals: { id, proposalId, title, goal, lifecycleStatus, createdAt, expiresAt, author, agent,
 *   proposalRole, screenshotUrl, parcelIds, parcelSource, proposalAccount }. Only contests with at least one
 *   minted proposal are returned: a contest nobody can bet on is a proposals list, not a market.
 *   Entries and contests come in the Bets sheet's order (bets-model.js compareRows, compareContests).
 */
export function buildContests({ city, proposals, markets = new Map(), statuses = new Map(), now = new Date() }) {
    const contests = groupByLand(proposals).map(group => {
        const entries = group.map(proposal => proposalEntry(proposal, markets, statuses)).sort(compareRows);
        const parcelIds = normalizeParcelIds(group.flatMap(item => normalizeParcelIds(item.parcelIds)));
        const parcelRefs = normalizeParcelRefs(group.flatMap(parcelRefsOf));
        const withMarket = entries.filter(entry => entry.market);
        const pool = withMarket.reduce((sum, entry) => sum + atomic(entry.market.poolAtomic), 0n);
        return {
            id: contestId(parcelRefs, entries.map(entry => entry.proposalId).sort()[0] || ''),
            parcelIds,
            parcelRefs,
            siteName: siteNameOf(entries),
            proposalCount: entries.length,
            mintedCount: entries.filter(entry => entry.proposalAccount).length,
            marketCount: withMarket.length,
            openMarketCount: entries.filter(entry => entry.bettable).length,
            poolAtomic: pool.toString(),
            latestCreatedAt: entries.reduce((latest, entry) => (timeOf(entry.createdAt) > timeOf(latest) ? entry.createdAt : latest), null),
            proposals: entries
        };
    }).filter(contest => contest.mintedCount > 0)
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
