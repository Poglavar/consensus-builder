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

    function row(entry, options = {}) {
        const market = entry && entry.market ? entry.market : null;
        const odds = market ? chance(market.yesPool, market.noPool) : { yes: null, no: null };
        return {
            id: entry.id,
            proposalId: entry.proposalId,
            proposalAccount: entry.proposalAccount || null,
            title: entry.title || '',
            goal: entry.goal || null,
            author: entry.author || null,
            agent: Boolean(entry.agent),
            createdAt: entry.createdAt || null,
            screenshotUrl: entry.screenshotUrl || null,
            parcelIds: Array.isArray(entry.parcelIds) ? entry.parcelIds : [],
            lifecycleStatus: entry.lifecycleStatus || 'Active',
            state: rowState(entry),
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
            closesAt: entry.expiresAt || null,
            marketAddress: market ? market.address : null
        };
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
        switch (filter) {
            case 'open': return list.filter(item => ['open', 'needs-market', 'settling'].includes(item.state));
            case 'settled': return list.filter(item => item.state === 'resolved-yes' || item.state === 'resolved-no');
            case 'mine': return list.filter(item => item.proposalAccount && hasPosition(positionsByAccount[item.proposalAccount]));
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

    function contest(entry, options = {}) {
        const rows = (entry && Array.isArray(entry.proposals) ? entry.proposals : []).map(item => row(item, options));
        return {
            id: entry.id,
            parcelIds: entry.parcelIds || [],
            siteName: entry.siteName || null,
            land: landLabel(entry.parcelIds),
            proposalCount: rows.length,
            openCount: rows.filter(item => item.state === 'open').length,
            pool: formatAtomic(entry.poolAtomic, options.decimals),
            poolAtomic: atomic(entry.poolAtomic),
            latestCreatedAt: entry.latestCreatedAt || null,
            rows
        };
    }

    // Contests with money in them first, then the ones with more open pools, then the newest;
    // a stable sort, so equal contests keep the server's order.
    function orderContests(contests) {
        const list = Array.isArray(contests) ? contests.slice() : [];
        const when = value => Date.parse(value || '') || 0;
        return list.sort((left, right) => {
            if (left.poolAtomic !== right.poolAtomic) return left.poolAtomic > right.poolAtomic ? -1 : 1;
            if (left.openCount !== right.openCount) return right.openCount - left.openCount;
            return when(right.latestCreatedAt) - when(left.latestCreatedAt);
        });
    }

    return {
        USDC_DECIMALS, REFERENCE_STAKE, QUICK_STAKES, FILTERS, HIDDEN_STATES, formatAtomic, chance, payoutMultiple, toWin, oneSided,
        rowState, row, contest, orderContests, splitRows, filterRows, claimSides, hasPosition, landLabel, parcelLabel, authorLabel
    };
});
