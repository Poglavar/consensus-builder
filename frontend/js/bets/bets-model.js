// Pure view model for the Bets sheet: turns a GET /markets contest into rows with a chance, a pool
// and a payout multiple, plus the state words the sheet shows. No DOM, no network, exact integer
// math on atomic USDC (the market program stores u64 atomic units).
(function attachBetsModel(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.BetsModel = api;
})(typeof window !== 'undefined' ? window : globalThis, function betsModelFactory() {
    'use strict';

    const USDC_DECIMALS = 6;
    const REFERENCE_STAKE = 1_000_000n; // the "1 USDC pays…" line is quoted for a 1 USDC bet

    function atomic(value) {
        try { return BigInt(value ?? 0); } catch (_) { return 0n; }
    }

    // Exact decimal text of atomic units; no floats, so a u64 keeps its low digits.
    function formatAtomic(value, decimals = USDC_DECIMALS) {
        const amount = atomic(value);
        const unit = 10n ** BigInt(decimals);
        const whole = amount / unit;
        const fraction = (amount % unit).toString().padStart(decimals, '0').replace(/0+$/, '');
        return fraction ? `${whole}.${fraction}` : whole.toString();
    }

    // Pool share in percent, one decimal, exactly rounded; null while nobody has bet.
    function chance(yesPool, noPool) {
        const yes = atomic(yesPool);
        const no = atomic(noPool);
        const total = yes + no;
        if (total <= 0n) return { yes: null, no: null };
        const pct = part => Number((part * 1000n + total / 2n) / total) / 10;
        return { yes: pct(yes), no: pct(no) };
    }

    // What one reference bet on `side` would pay if that side wins, as a multiple of the bet, with
    // the bet itself counted in the pool (parimutuel: stake × (yes + no + stake) / (side + stake)).
    // Two decimals, floored, so the sheet never promises more than the program pays.
    function payoutMultiple(side, yesPool, noPool, stake = REFERENCE_STAKE) {
        const yes = atomic(yesPool);
        const no = atomic(noPool);
        const bet = atomic(stake);
        if (bet <= 0n) return null;
        const own = (side === 'yes' ? yes : no) + bet;
        const total = yes + no + bet;
        return Number((total * 100n) / own) / 100;
    }

    // What a bet of `stake` atomic units on `side` collects if that side wins, in atomic units,
    // floored like the program's payout: stake × (yes + no + stake) / (side + stake). The pool at
    // settlement decides the real figure; this is the "to win" line the stake form shows live.
    function toWin(side, yesPool, noPool, stake) {
        const yes = atomic(yesPool);
        const no = atomic(noPool);
        const bet = atomic(stake);
        if (bet <= 0n) return 0n;
        const own = (side === 'yes' ? yes : no) + bet;
        return (bet * (yes + no + bet)) / own;
    }

    // The stake chips of the stake form, in USDC text; the pools are small, so the steps are too.
    const QUICK_STAKES = ['0.1', '1', '5'];

    // 'yes' or 'no' when only that side holds bets (a "100% chance" that is one bet of 0.25 USDC is
    // not a chance worth printing); null while the pool is empty or both sides are in.
    function oneSided(yesPool, noPool) {
        const yes = atomic(yesPool);
        const no = atomic(noPool);
        if (yes > 0n && no === 0n) return 'yes';
        if (no > 0n && yes === 0n) return 'no';
        return null;
    }

    // One word for where a proposal's bet stands. The server says whether a bet is open (from the
    // proposal account's own status when it could read it); the status words come from the chain
    // first and the expiry-aware database word second.
    function rowState(entry) {
        if (!entry) return 'not-minted';
        if (entry.market && entry.market.resolved) return entry.market.outcome === 'yes' ? 'resolved-yes' : 'resolved-no';
        if (entry.bettable) return 'open';
        if (entry.canOpenMarket) return 'needs-market';
        if (!entry.proposalAccount) return 'not-minted';
        const status = entry.chainStatus || entry.lifecycleStatus || 'Active';
        // Still Active on-chain but not bettable: the server saw a reason (unreadable market); treat it
        // as closed rather than inviting a transaction that would fail.
        if (status === 'Active') return 'closed';
        // The proposal left Active on-chain: the market only needs someone to resolve it from the
        // proposal's terminal status.
        return entry.market ? 'settling' : 'closed';
    }

    // Every word rowState can say. An older plan version arrives with its own (GET /markets clears its
    // bettable, since a newer version replaced it, but says where its pool stands).
    const ROW_STATES = ['open', 'needs-market', 'settling', 'resolved-yes', 'resolved-no', 'closed', 'not-minted'];
    // Rows still in play: a bet can go in, a pool can open, or a decided proposal awaits settlement.
    const LIVE_STATES = ['open', 'needs-market', 'settling'];
    const stateOf = item => (ROW_STATES.includes(item.state) ? item.state : rowState(item));

    function row(entry, options = {}) {
        const market = entry && entry.market ? entry.market : null;
        const odds = market ? chance(market.yesPool, market.noPool) : { yes: null, no: null };
        return {
            id: entry.id,
            // 'plan' for a named plan (plans.md): its own pool over a set of member proposals.
            kind: entry.kind === 'plan' ? 'plan' : 'proposal',
            planSlug: entry.planSlug || null,
            memberCount: Number.isFinite(entry.memberCount) ? entry.memberCount : 0,
            members: Array.isArray(entry.members) ? entry.members : [],
            proposalId: entry.proposalId,
            proposalAccount: entry.proposalAccount || null,
            title: entry.title || '',
            goal: entry.goal || null,
            author: entry.author || null,
            agent: Boolean(entry.agent),
            createdAt: entry.createdAt || null,
            screenshotUrl: entry.screenshotUrl || null,
            // The same ground without the proposal, when rendered (dividers.md, M3).
            screenshotBeforeUrl: entry.screenshotBeforeUrl || null,
            parcelIds: Array.isArray(entry.parcelIds) ? entry.parcelIds : [],
            lifecycleStatus: entry.lifecycleStatus || 'Active',
            state: stateOf(entry),
            chanceYes: odds.yes,
            chanceNo: odds.no,
            oneSided: market ? oneSided(market.yesPool, market.noPool) : null,
            pool: market ? formatAtomic(market.poolAtomic, options.decimals) : null,
            poolAtomic: market ? atomic(market.poolAtomic) : 0n,
            yesPoolAtomic: market ? atomic(market.yesPool) : 0n,
            noPoolAtomic: market ? atomic(market.noPool) : 0n,
            outcome: market && market.resolved ? (market.outcome === 'yes' ? 'yes' : 'no') : null,
            paysYes: market ? payoutMultiple('yes', market.yesPool, market.noPool) : null,
            paysNo: market ? payoutMultiple('no', market.yesPool, market.noPool) : null,
            // The market's own deadline, what rows sort by: a dated market has one, a legacy pool none.
            // expiresAt is the proposal's app-level expiry, the date shown when the market has no deadline.
            closesAt: entry.closesAt || null,
            expiresAt: entry.expiresAt || null,
            marketAddress: market ? market.address : null,
            // An older version of a named plan (plans.md): reachable for the bets already in its pool,
            // never offered for a new one.
            supersededBy: entry.supersededBy || null,
            superseded: Boolean(entry.supersededBy),
            olderVersions: Array.isArray(entry.olderVersions) ? entry.olderVersions.map(item => row(item, options)) : []
        };
    }

    // ---- order: one rule for GET /markets (backend/markets/contests.js) and the sheet ------------
    // Both shapes sort with these: a sheet row carries its state and a BigInt pool, a GET /markets
    // entry its market (pool as a decimal string) and the facts rowState reads.

    const timeOf = value => {
        const ms = Date.parse(value || '');
        return Number.isFinite(ms) ? ms : null;
    };
    const poolOf = item => atomic(item.poolAtomic !== undefined ? item.poolAtomic : item.market && item.market.poolAtomic);
    // In play first, settled after, then the rows nothing can be done with (no pool, never minted).
    function standing(item) {
        const state = stateOf(item);
        if (LIVE_STATES.includes(state)) return 0;
        return state === 'resolved-yes' || state === 'resolved-no' ? 1 : 2;
    }

    // Rows in a contest: rows in play first, the soonest deadline leading (a legacy pool has none and
    // follows the dated ones), then the bigger pool; settled rows after them, the bigger pool first.
    // Ties: a whole plan before its loose pieces, then the newest.
    function compareRows(a, b) {
        const rank = standing(a) - standing(b);
        if (rank) return rank;
        if (standing(a) === 0) {
            const closesA = timeOf(a.closesAt);
            const closesB = timeOf(b.closesAt);
            if (closesA !== closesB) {
                if (closesA === null) return 1;
                if (closesB === null) return -1;
                return closesA - closesB;
            }
        }
        const pool = poolOf(b) - poolOf(a);
        if (pool !== 0n) return pool > 0n ? 1 : -1;
        // A whole plan is what people argue about; its loose pieces come after it.
        if ((a.kind === 'plan') !== (b.kind === 'plan')) return a.kind === 'plan' ? -1 : 1;
        return (timeOf(b.createdAt) || 0) - (timeOf(a.createdAt) || 0);
    }

    const contestRows = item => (Array.isArray(item.rows) ? item.rows : Array.isArray(item.proposals) ? item.proposals : []);

    // Contests: the ones where a bet can go in now first, then by their leading row under the same
    // rule (rows are already in order, so the page opens on the city's best row), then the bigger
    // pool, more entries and the newest.
    function compareContests(a, b) {
        const rowsA = contestRows(a);
        const rowsB = contestRows(b);
        const openA = rowsA.some(item => stateOf(item) === 'open');
        const openB = rowsB.some(item => stateOf(item) === 'open');
        if (openA !== openB) return openA ? -1 : 1;
        if (rowsA.length && rowsB.length) {
            const lead = compareRows(rowsA[0], rowsB[0]);
            if (lead) return lead;
        } else if (rowsA.length !== rowsB.length) {
            return rowsA.length ? -1 : 1;
        }
        const pool = atomic(b.poolAtomic) - atomic(a.poolAtomic);
        if (pool !== 0n) return pool > 0n ? 1 : -1;
        const count = (b.proposalCount || 0) - (a.proposalCount || 0);
        if (count) return count;
        return (timeOf(b.latestCreatedAt) || 0) - (timeOf(a.latestCreatedAt) || 0);
    }

    // The sides of a settled pool the wallet can still collect from: the winning side's unclaimed
    // bets, or every unclaimed bet when nobody backed the winner (the program refunds then).
    function claimSides(row, positions) {
        if (!row || row.outcome === null || row.outcome === undefined || !positions) return [];
        const winningPool = row.outcome === 'yes' ? atomic(row.yesPoolAtomic) : atomic(row.noPoolAtomic);
        return ['yes', 'no'].filter(side => {
            const position = positions[side];
            if (!position || position.claimed || atomic(position.amount) <= 0n) return false;
            return winningPool === 0n || side === row.outcome;
        });
    }

    // Rows nothing can be done with yet (no mint, or decided before a pool existed) fold away under
    // a count, so a contest of 26 proposals with 2 pools reads as 2 pools.
    const HIDDEN_STATES = ['not-minted', 'closed'];
    function splitRows(rows) {
        const list = Array.isArray(rows) ? rows : [];
        return {
            shown: list.filter(item => !HIDDEN_STATES.includes(item.state)),
            hidden: list.filter(item => HIDDEN_STATES.includes(item.state))
        };
    }

    // The sheet's filter: 'all', 'open' (a bet can still go in or the pool awaits settlement),
    // 'settled', or 'mine' (the wallet holds a bet on it, settled or not).
    const FILTERS = ['all', 'open', 'settled', 'mine'];
    function hasPosition(positions) {
        return Boolean(positions && ['yes', 'no'].some(side => positions[side] && atomic(positions[side].amount) > 0n));
    }
    function filterRows(rows, filter, positionsByAccount = {}) {
        const list = Array.isArray(rows) ? rows : [];
        const mine = item => Boolean(item.proposalAccount && hasPosition(positionsByAccount[item.proposalAccount]));
        switch (filter) {
            case 'open': return list.filter(item => LIVE_STATES.includes(item.state));
            case 'settled': return list.filter(item => item.state === 'resolved-yes' || item.state === 'resolved-no');
            // A bet in an older version's pool keeps its plan in "Mine", so it can still be collected.
            case 'mine': return list.filter(item => mine(item) || (item.olderVersions || []).some(mine));
            default: return list;
        }
    }

    // An author that is a wallet address (the agents sign as their keypair) reads as its two ends,
    // "G4R6…HvEg"; a name stays a name.
    const ACCOUNT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
    function authorLabel(author) {
        const text = String(author ?? '').trim();
        if (!text) return '';
        return ACCOUNT.test(text) ? `${text.slice(0, 4)}…${text.slice(-4)}` : text;
    }

    // The number people know a parcel by: the last segment of a dash-joined cadastral uid when it
    // starts with a digit (HR-335614-2311 → "2311", US-CA-SF-4853003 → "4853003", HR-…-1754/1 →
    // "1754/1"); any other shape is shown whole.
    function parcelLabel(parcelId) {
        const text = String(parcelId ?? '').trim();
        const segments = text.split('-');
        const last = segments[segments.length - 1];
        return segments.length >= 2 && /^\d/.test(last) ? last : text;
    }

    // The sheet's heading for a contest: the land it is about, as the first parcel plus how many more.
    function landLabel(parcelIds) {
        const ids = Array.isArray(parcelIds) ? parcelIds.filter(Boolean) : [];
        if (!ids.length) return { first: null, more: 0 };
        return { first: String(ids[0]), more: ids.length - 1 };
    }

    // The counts are of current versions: a plan's older versions fold under its row (olderVersions)
    // and are neither entries nor plans of the contest. Rows keep GET /markets' order, re-applied here
    // (compareRows) so the sheet never disagrees with the API.
    function contest(entry, options = {}) {
        const rows = (entry && Array.isArray(entry.proposals) ? entry.proposals : []).map(item => row(item, options)).sort(compareRows);
        return {
            id: entry.id,
            parcelIds: entry.parcelIds || [],
            siteName: entry.siteName || null,
            land: landLabel(entry.parcelIds),
            proposalCount: rows.length,
            planCount: rows.filter(item => item.kind === 'plan').length,
            openCount: rows.filter(item => item.state === 'open').length,
            pool: formatAtomic(entry.poolAtomic, options.decimals),
            poolAtomic: atomic(entry.poolAtomic),
            latestCreatedAt: entry.latestCreatedAt || null,
            rows
        };
    }

    // Contests in GET /markets' order (compareContests): where a bet can go in now first, then by
    // their leading row, so a contest of settled pools never opens the page; a stable sort, so equal
    // contests keep the server's order.
    function orderContests(contests) {
        const list = Array.isArray(contests) ? contests.slice() : [];
        return list.sort(compareContests);
    }

    return {
        USDC_DECIMALS, REFERENCE_STAKE, QUICK_STAKES, FILTERS, HIDDEN_STATES, ROW_STATES, LIVE_STATES, formatAtomic, chance, payoutMultiple,
        toWin, oneSided, rowState, row, contest, compareRows, compareContests, orderContests, splitRows, filterRows, claimSides, hasPosition,
        landLabel, parcelLabel, authorLabel
    };
});
