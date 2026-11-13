// PostgreSQL side of the city meme token (docs/citymemetoken.md): writes one resolved market's
// awards once, and reads balances and standings. The reward math is in city-token-rewards.js.
import { edgesByHolder, marketAwards, cityToken, tokenSymbol, formatTokenAmount } from './city-token-rewards.js';

const CITY_SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/;

/**
 * Award one resolved market, once. `fills` are [{ holder, action, side, shares, amount }] in
 * execution order; `walletOf(holder)` gives the wallet stored beside each award. Returns
 * { awarded: false, reason } when the market was already awarded or cannot carry a city token.
 * Run inside a transaction: the marker row and the awards commit together.
 */
export async function awardMarket(db, { book, market, simulationRun = '', agreementAccount, city, outcome, fills, walletOf = () => null }) {
    if (!CITY_SLUG.test(city || '')) return { awarded: false, reason: `city ${JSON.stringify(city)} is not a city slug` };
    const done = await db.query('SELECT 1 FROM consensus.city_token_market WHERE book=$1 AND market=$2', [book, market]);
    if (done.rows.length) return { awarded: false, reason: 'already awarded' };
    const edges = edgesByHolder(fills, outcome);
    const awards = marketAwards({ book, city: cityToken(city), edges });
    const totalEdge = [...edges.values()].reduce((sum, edge) => sum + edge, 0n);
    await db.query(`INSERT INTO consensus.city_token_market
        (book, market, simulation_run, agreement_account, city, outcome, recipients, total_edge, fills)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [book, market, simulationRun, agreementAccount, city, outcome, edges.size, String(totalEdge), fills.length]);
    for (const award of awards) {
        await db.query(`INSERT INTO consensus.city_token_award
            (book, market, simulation_run, recipient, wallet, token, edge, amount, agreement_account)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [book, market, simulationRun, award.holder, walletOf(award.holder) || null, award.token,
            String(award.edge), String(award.amount), agreementAccount]);
    }
    return { awarded: true, recipients: edges.size, awards };
}

/** Award a resolved points market from its trade history. */
export async function awardPointsMarket(db, market) {
    if (!market.resolved || !market.outcome) throw new Error('points market is not resolved');
    if (!CITY_SLUG.test(market.city || '')) return { awarded: false, reason: `city ${JSON.stringify(market.city)} is not a city slug` };
    const { rows } = await db.query(
        `SELECT t.account_id, t.kind, t.side, t.shares, t.amount, a.wallet
           FROM consensus.points_transaction t JOIN consensus.points_account a ON a.id = t.account_id
          WHERE t.market_id = $1 AND t.kind IN ('buy','sell') ORDER BY t.created_at, t.id`, [market.id]);
    const wallets = new Map(rows.map(row => [row.account_id, row.wallet]));
    const fills = rows.map(row => ({ holder: row.account_id, action: row.kind, side: row.side,
        shares: BigInt(row.shares), amount: BigInt(row.amount) }));
    return awardMarket(db, { book: 'points', market: market.id, simulationRun: market.simulation_run,
        agreementAccount: market.agreement_account, city: market.city, outcome: market.outcome,
        fills, walletOf: holder => wallets.get(holder) });
}

const shape = row => ({ token: row.token, symbol: tokenSymbol(row.token), amount: String(row.amount),
    display: formatTokenAmount(row.amount) });

/** Awards one points account got on one market (for its claim receipt). */
export async function awardsFor(db, recipient, market) {
    const { rows } = await db.query(`SELECT token, amount FROM consensus.city_token_award
        WHERE recipient=$1 AND market=$2 ORDER BY token = 'ugt', token`, [recipient, market]);
    return rows.map(shape);
}

/**
 * Balances of a points account (recipient) or of a wallet. A wallet's balance includes the awards
 * of points accounts linked to it, so the two books meet at the wallet.
 */
export async function balances(db, { recipient = null, wallet = null, simulationRun = '' }) {
    const { rows } = await db.query(`SELECT token, sum(amount) AS amount, count(DISTINCT market) AS markets
        FROM consensus.city_token_award
        WHERE simulation_run = $3 AND (recipient = $1 OR ($2::text IS NOT NULL AND (wallet = $2 OR recipient = $2)))
        GROUP BY token ORDER BY token = 'ugt', sum(amount) DESC`, [recipient, wallet, simulationRun]);
    const recent = await db.query(`SELECT w.token, w.amount, w.book, w.agreement_account, w.created_at, m.outcome
        FROM consensus.city_token_award w JOIN consensus.city_token_market m USING (book, market)
        WHERE w.simulation_run = $3 AND (w.recipient = $1 OR ($2::text IS NOT NULL AND (w.wallet = $2 OR w.recipient = $2)))
        ORDER BY w.created_at DESC, w.token LIMIT 20`, [recipient, wallet, simulationRun]);
    return {
        balances: rows.map(row => ({ ...shape(row), markets: Number(row.markets) })),
        recent: recent.rows.map(row => ({ ...shape(row), book: row.book, agreementAccount: row.agreement_account,
            outcome: row.outcome, awardedAt: row.created_at.toISOString() }))
    };
}

/** Top holders of one token, by wallet when known, else by points account. */
export async function standings(db, { token, simulationRun = '', limit = 30 }) {
    const { rows } = await db.query(`SELECT coalesce(w.wallet, w.recipient) AS holder, (w.wallet IS NOT NULL) AS is_wallet,
            max(a.alias) AS alias, sum(w.amount) AS amount
        FROM consensus.city_token_award w
        LEFT JOIN consensus.points_account a ON w.book = 'points' AND a.id::text = w.recipient
        WHERE w.token = $1 AND w.simulation_run = $2
        GROUP BY 1, 2 ORDER BY sum(w.amount) DESC, 1 LIMIT $3`, [token, simulationRun, limit]);
    return rows.map((row, index) => ({ rank: index + 1, holder: row.holder,
        wallet: row.is_wallet ? row.holder : null, alias: row.alias || null, ...shape({ token, amount: row.amount }) }));
}
