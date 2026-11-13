// City meme token rewards for correct agreement bets (docs/citymemetoken.md). Pure: fills and an
// outcome in, edges and awards out. Amounts are BigInt atomic units; tokens carry 6 decimals.

export const TOKEN_DECIMALS = 6;
const ONE = 10n ** BigInt(TOKEN_DECIMALS);
export const UGT = 'ugt';
// Points cost nothing, so a points market emits a fixed pool split by edge (bounded farming).
export const POINTS_POOL = 1_000n * ONE;
// Devnet USDC carries a real stake, so its reward is a rate on edge, uncapped: one city token per
// 0.01 USDC of edge (edge is in 10^-6 USDC, the token in 10^-6 tokens).
export const USDC_RATE = 100n;
// UGT is paid beside every city award at this fraction of it.
export const UGT_DIVISOR = 10n;

export const BOOKS = Object.freeze(['points', 'devnet-usdc']);

/** The token id of a city: its slug, lower case. */
export function cityToken(city) {
    if (typeof city !== 'string' || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(city)) {
        throw new Error(`city token needs a city slug, got ${JSON.stringify(city)}`);
    }
    return city;
}

/** Display symbol: ZAGREB, SANFRANCISCO, UGT. */
export function tokenSymbol(token) {
    return String(token).replace(/[^a-z0-9]/gi, '').toUpperCase();
}

/** Atomic amount → decimal string with trailing zeros dropped. */
export function formatTokenAmount(atomic) {
    const value = BigInt(atomic);
    const whole = value / ONE, frac = value % ONE;
    if (frac === 0n) return String(whole);
    return `${whole}.${String(frac).padStart(TOKEN_DECIMALS, '0').replace(/0+$/, '')}`;
}

/**
 * Winning-side edge of one holder: winning shares held at resolution minus their average cost.
 * fills: [{ action: 'buy'|'sell', side: 'yes'|'no', shares, amount }] in execution order, where
 * amount is the cost of a buy or the return of a sell. Outcome 'void' (or anything but yes/no) → 0.
 */
export function holderEdge(fills, outcome) {
    if (outcome !== 'yes' && outcome !== 'no') return 0n;
    const book = { yes: { shares: 0n, cost: 0n }, no: { shares: 0n, cost: 0n } };
    for (const fill of fills) {
        const side = book[fill.side];
        if (!side) throw new Error(`unknown side ${fill.side}`);
        const shares = BigInt(fill.shares), amount = BigInt(fill.amount);
        if (shares <= 0n || amount < 0n) throw new Error('fill shares must be positive and amount non-negative');
        if (fill.action === 'buy') {
            side.shares += shares; side.cost += amount;
        } else if (fill.action === 'sell') {
            if (shares > side.shares) throw new Error('fill sells more shares than are held');
            // Average cost: a sell removes its proportional slice of the cost basis.
            const removed = side.cost * shares / side.shares;
            side.cost -= removed; side.shares -= shares;
        } else {
            throw new Error(`unknown fill action ${fill.action}`);
        }
    }
    const won = book[outcome];
    const edge = won.shares - won.cost;
    return edge > 0n ? edge : 0n;
}

/** Net shares per side after all fills, to check a fill history against the market's q_yes/q_no. */
export function netShares(fills) {
    const net = { yes: 0n, no: 0n };
    for (const fill of fills) net[fill.side] += fill.action === 'buy' ? BigInt(fill.shares) : -BigInt(fill.shares);
    return net;
}

/** Group fills by holder and compute each holder's edge; holders with no edge are left out. */
export function edgesByHolder(fills, outcome) {
    const byHolder = new Map();
    for (const fill of fills) {
        if (!byHolder.has(fill.holder)) byHolder.set(fill.holder, []);
        byHolder.get(fill.holder).push(fill);
    }
    const edges = new Map();
    for (const [holder, own] of byHolder) {
        const edge = holderEdge(own, outcome);
        if (edge > 0n) edges.set(holder, edge);
    }
    return edges;
}

/**
 * Awards for one resolved market. Points: POINTS_POOL split pro rata by edge (floored; dust stays
 * unminted). Devnet USDC: edge × USDC_RATE. Each holder also gets UGT = city amount / UGT_DIVISOR.
 * Returns [{ holder, token, edge, amount }] with zero amounts dropped.
 */
export function marketAwards({ book, city, edges }) {
    if (!BOOKS.includes(book)) throw new Error(`unknown book ${book}`);
    const token = cityToken(city);
    const total = [...edges.values()].reduce((sum, edge) => sum + edge, 0n);
    const awards = [];
    for (const [holder, edge] of edges) {
        const amount = book === 'points' ? (total > 0n ? POINTS_POOL * edge / total : 0n) : edge * USDC_RATE;
        if (amount <= 0n) continue;
        awards.push({ holder, token, edge, amount });
        const ugt = amount / UGT_DIVISOR;
        if (ugt > 0n) awards.push({ holder, token: UGT, edge, amount: ugt });
    }
    return awards;
}
