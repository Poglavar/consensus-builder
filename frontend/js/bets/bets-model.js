// Pure view model for the Bets sheet: turns a GET /markets contest of agreements into rows with a
// current LMSR prices, fixed shares and deadline state. No DOM or network. Both points and devnet
// USDC use six decimal places and the same exact integer arithmetic.
(function attachBetsModel(root, factory) {
    const api = factory(typeof module === 'object' && module.exports ? require('./lmsr.js') : root.Lmsr,
        typeof module === 'object' && module.exports ? require('./betting-contract.js') : root.BettingContract);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.BetsModel = api;
})(typeof window !== 'undefined' ? window : globalThis, function betsModelFactory(lmsr, contract) {
    'use strict';

    const USDC_DECIMALS = 6;
    const REFERENCE_STAKE = 1_000_000n; // Reference payout quotes use one whole unit of the selected asset.

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

    // Quotes price the whole trade, including movement along the curve. A winning share always
    // pays one unit; later traders never dilute shares already held.
    function chance(market) {
        return { yes: lmsr.chance(market.b, market.qYes, market.qNo, 'yes'),
            no: lmsr.chance(market.b, market.qYes, market.qNo, 'no') };
    }
    function payoutMultiple(side, market, stake = REFERENCE_STAKE) {
        const quoted = contract.quote(market, side, atomic(stake));
        return Number(quoted.shares * 100n / quoted.amount) / 100;
    }
    const toWin = (side, market, stake) => contract.quote(market, side, atomic(stake)).shares;
    const QUICK_STAKES = ['0.1', '1', '5'];
    const POINTS_STAKES = ['10', '50', '100'];

    // Terminal status identifies a settlement opportunity. The dated oracle checks executedAt
    // before choosing YES or NO; cancellation is NO. This helper never pays a position.
    const SETTLEMENT = Object.freeze({ executed: 'yes', cancelled: 'no', expired: 'no' });
    const settlementOf = status => (Object.prototype.hasOwnProperty.call(SETTLEMENT, status) ? SETTLEMENT[status] : null);

    // One word for where an agreement's bet stands. The server says whether a bet is open (the
    // agreement account Active on-chain, as the lifecycle oracle observed it, and its deadline still
    // ahead). A known terminal status or Active observed after the cutoff permits settlement;
    // an unobserved status supplies no such evidence.
    function rowState(entry) {
        if (!entry) return 'not-minted';
        if (!entry.market && entry.markets?.length) {
            if (entry.bettable) return 'open';
            if (entry.canSettle) return 'settling';
            const first = entry.markets[0];
            return first.resolved ? `resolved-${first.outcome}` : 'closed';
        }
        if (entry.market && entry.market.resolved) return `resolved-${entry.market.outcome}`;
        if (entry.bettable) return 'open';
        if (entry.canSettle) return 'settling';
        if (!entry.market && !entry.markets?.length && entry.canOpenMarket) return 'needs-market';
        if (!entry.account) return 'not-minted';
        // An unavailable or otherwise ineligible source never invites a trade or settlement.
        if (!settlementOf(entry.chainStatus)) return 'closed';
        // The agreement left Active on-chain: the market needs someone to settle it.
        return entry.market ? 'settling' : 'closed';
    }

    // Every word rowState can say.
    const ROW_STATES = ['open', 'needs-market', 'settling', 'resolved-yes', 'resolved-no', 'resolved-void', 'closed', 'not-minted'];
    // Rows still in play: shares can be traded, a market can open, or a decided agreement awaits settlement.
    const LIVE_STATES = ['open', 'needs-market', 'settling'];
    const stateOf = item => (ROW_STATES.includes(item.state) ? item.state : rowState(item));

    // What a row is called: the agreement's own title, else its designs' titles in authored order (a
    // title is optional); empty when it has neither.
    function labelOf(entry) {
        const title = entry && typeof entry.title === 'string' ? entry.title.trim() : '';
        if (title) return title;
        const designs = (entry && Array.isArray(entry.designTitles) ? entry.designTitles : [])
            .map(item => String(item ?? '').trim()).filter(Boolean);
        return designs.length > 3 ? `${designs.slice(0, 3).join(' + ')} + …` : designs.join(' + ');
    }

    // One agreement's row. `contest` is the id of the contest it stands in.
    function row(entry, options = {}) {
        const market = options.market || (entry && entry.market ? entry.market : null);
        const source = market ? { ...entry, market, bettable: market.bettable ?? entry.bettable, canSettle: market.canSettle ?? entry.canSettle } : entry;
        if (market && market.model !== 'lmsr') throw new Error('The active betting UI requires an LMSR market');
        const odds = market ? chance(market) : { yes: null, no: null };
        return {
            kind: 'agreement',
            cid: entry.cid || null,
            account: entry.account || null,
            contest: entry.contest || options.contest || null,
            title: entry.title || '',
            label: labelOf(entry),
            designTitles: Array.isArray(entry.designTitles) ? entry.designTitles : [],
            author: entry.author || null,
            sponsor: entry.sponsor || null,
            asset: market?.asset || options.asset || 'points',
            market,
            canOpenMarket: Boolean(entry.canOpenMarket),
            city: entry.city || null,
            createdAt: entry.createdAt || null,
            // The agreement's own deadline: after it the agreement can no longer execute.
            deadline: entry.deadline || null,
            closesAt: market ? new Date(market.closesAt * 1000).toISOString() : entry.deadline || null,
            status: entry.status || null,
            chainStatus: entry.chainStatus || null,
            screenshotUrl: entry.screenshotUrl || null,
            // The same ground without the agreement's designs, when rendered (dividers.md, M3).
            screenshotBeforeUrl: entry.screenshotBeforeUrl || null,
            parcelIds: Array.isArray(entry.parcelIds) ? entry.parcelIds : [],
            state: stateOf(source),
            chanceYes: odds.yes,
            chanceNo: odds.no,
            liquidity: market ? formatAtomic(market.b) : null,
            sharesAtomic: market ? atomic(market.qYes) + atomic(market.qNo) : 0n,
            yesSharesAtomic: market ? atomic(market.qYes) : 0n,
            noSharesAtomic: market ? atomic(market.qNo) : 0n,
            outcome: market && market.resolved ? market.outcome : null,
            paysYes: market ? payoutMultiple('yes', market) : null,
            paysNo: market ? payoutMultiple('no', market) : null,
            marketAddress: market?.address || null,
            creator: market?.creator || null,
            creatorRole: market?.creatorRole || null,
            marketKind: market?.kind === 'recipe' || market?.kind === 1 ? 1 : 0
        };
    }

    // A GET /markets-shaped entry for an agreement read straight from the chain (js/solana/
    // market-bridge.js readSummary: the account's status, deadline and market), for the bet dialog's
    // row when the city list does not carry the agreement yet, such as one just minted. It takes bets
    // by the rule GET /markets applies (backend/markets/contests.js agreementEntry): the account Active
    // and its required deadline not yet reached.
    function chainEntry(account, summary, nowMs = Date.now()) {
        const market = summary?.market || null;
        const chainStatus = summary?.chainStatus?.toLowerCase() || null, deadline = summary?.deadline || null;
        const external = market?.kind === 1 || market?.kind === 'recipe';
        const now = Math.floor(nowMs / 1000);
        return { account, chainStatus, deadline, sponsor: summary?.sponsor || null, market,
            bettable: Boolean(market && !market.resolved && !market.proposed && (external || chainStatus === 'active') && now < market.closesAt),
            canOpenMarket: Boolean(account && chainStatus && summary?.canOpenMarket !== false),
            canSettle: Boolean(market && !market.resolved && (external || settlementOf(chainStatus) || now > market.closesAt + market.graceSeconds)) };
    }

    // ---- order: one rule for GET /markets (backend/markets/contests.js) and the sheet ------------
    // Both shapes sort with these: a sheet row carries its state and atomic share inventory;
    // a GET /markets entry carries the market and the facts rowState reads.

    const timeOf = value => {
        const ms = Date.parse(value || '');
        return Number.isFinite(ms) ? ms : null;
    };
    const sharesOf = item => item.market ? atomic(item.market.qYes) + atomic(item.market.qNo)
        : item.markets ? item.markets.reduce((total, pool) => total + atomic(pool.qYes) + atomic(pool.qNo), 0n) : atomic(item.sharesAtomic);
    // In play first, settled after, then the rows nothing can be done with (no market, never minted).
    function standing(item) {
        const state = stateOf(item);
        if (LIVE_STATES.includes(state)) return 0;
        return state.startsWith('resolved-') ? 1 : 2;
    }

    // Tradeable funded books lead by committed LMSR depth. Use the market address to break USDC ties.
    // The remaining states use actionability, deadline, outstanding shares and publication time.
    function compareRows(a, b) {
        const leading = item => item.markets?.find(market => market.bettable) || (stateOf(item) === 'open' ? item.market : null);
        const first = leading(a), second = leading(b);
        if (first || second) {
            if (!first || !second) return first ? -1 : 1;
            const depth = atomic(second.b) - atomic(first.b);
            if (depth) return depth > 0n ? 1 : -1;
            if (first.asset === 'devnet-usdc' && second.asset === 'devnet-usdc') return String(first.address).localeCompare(String(second.address));
        }
        const rank = standing(a) - standing(b);
        if (rank) return rank;
        if (standing(a) === 0) {
            const deadlineA = timeOf(a.closesAt || a.deadline);
            const deadlineB = timeOf(b.closesAt || b.deadline);
            if (deadlineA !== deadlineB) {
                if (deadlineA === null) return 1;
                if (deadlineB === null) return -1;
                return deadlineA - deadlineB;
            }
        }
        const pool = sharesOf(b) - sharesOf(a);
        if (pool !== 0n) return pool > 0n ? 1 : -1;
        return (timeOf(b.createdAt) || 0) - (timeOf(a.createdAt) || 0);
    }

    const contestRows = item => (Array.isArray(item.rows) ? item.rows : Array.isArray(item.agreements) ? item.agreements : []);

    // Contests: the ones where a bet can go in now first, then by their leading row under the same
    // rule (rows are already in order, so the page opens on the city's best row), then the bigger
    // pool, more agreements and the newest.
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
        const pool = sharesOf(b) - sharesOf(a);
        if (pool !== 0n) return pool > 0n ? 1 : -1;
        const count = (b.agreementCount || 0) - (a.agreementCount || 0);
        if (count) return count;
        return (timeOf(b.latestCreatedAt) || 0) - (timeOf(a.latestCreatedAt) || 0);
    }

    // Claimable fixed shares: the winning side, or both sides for a VOID's half payout.
    function claimSides(row, positions) {
        if (!row || row.outcome === null || row.outcome === undefined || !positions) return [];
        return ['yes', 'no'].filter(side => {
            const position = positions[side];
            if (!position || position.claimed || atomic(position.amount) <= 0n) return false;
            return contract.payout(side, atomic(position.amount), row.outcome) > 0n;
        });
    }

    // Rows nothing can be done with yet (no mint, or decided before a pool existed) fold away under
    // a count, so a contest of 26 agreements with 2 pools reads as 2 pools.
    const HIDDEN_STATES = ['not-minted', 'closed'];
    function splitRows(rows) {
        const list = Array.isArray(rows) ? rows : [];
        const withoutPool = item => HIDDEN_STATES.includes(item.state) && item.market == null;
        return {
            shown: list.filter(item => !withoutPool(item)),
            hidden: list.filter(withoutPool)
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
            case 'open': return list.filter(item => LIVE_STATES.includes(item.state));
            case 'settled': return list.filter(item => item.state.startsWith('resolved-'));
            case 'mine': return list.filter(item => Boolean(item.account && hasPosition(positionsByAccount[item.asset === 'devnet-usdc' ? item.marketAddress : item.account])));
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

    // One GET /markets contest as the sheet shows it. Rows keep GET /markets' order, re-applied here
    // (compareRows) so the sheet never disagrees with the API.
    function contest(entry, options = {}) {
        const agreements = entry.agreements || [];
        const rows = agreements.flatMap(item => (item.markets?.length ? item.markets : [item.market || null])
            .map(market => row(item, { ...options, contest: entry.id, market }))).sort(compareRows);
        return {
            id: entry.id,
            city: entry.city || null,                 // set on GET /markets?scope=other contests
            parcelIds: entry.parcelIds || [],
            land: landLabel(entry.parcelIds),
            agreementCount: agreements.length,
            openCount: rows.filter(item => item.state === 'open').length,
            sharesAtomic: atomic(entry.sharesAtomic),
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
        USDC_DECIMALS, REFERENCE_STAKE, QUICK_STAKES, POINTS_STAKES, FILTERS, HIDDEN_STATES, ROW_STATES, LIVE_STATES, SETTLEMENT, formatAtomic, chance,
        payoutMultiple, toWin, quote: contract.quote, settlementOf, rowState, labelOf, row, chainEntry, contest, compareRows, compareContests, orderContests, splitRows,
        filterRows, claimSides, hasPosition, landLabel, parcelLabel, authorLabel
    };
});
