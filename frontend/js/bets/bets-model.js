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
            lifecycleStatus: entry.lifecycleStatus || 'Active',
            state: rowState(entry),
            chanceYes: odds.yes,
            chanceNo: odds.no,
            pool: market ? formatAtomic(market.poolAtomic, options.decimals) : null,
            poolAtomic: market ? atomic(market.poolAtomic) : 0n,
            paysYes: market ? payoutMultiple('yes', market.yesPool, market.noPool) : null,
            paysNo: market ? payoutMultiple('no', market.yesPool, market.noPool) : null,
            closesAt: entry.expiresAt || null,
            marketAddress: market ? market.address : null
        };
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
            rows
        };
    }

    return { USDC_DECIMALS, REFERENCE_STAKE, formatAtomic, chance, payoutMultiple, rowState, row, contest, landLabel, parcelLabel };
});
