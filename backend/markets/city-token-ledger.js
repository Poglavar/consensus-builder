// PostgreSQL side of the city meme token (docs/citymemetoken.md): writes one resolved market's
// awards once, and reads balances and standings. The reward math is in city-token-rewards.js.
import { edgesByHolder, marketAwards, cityToken, tokenSymbol, formatTokenAmount, boostPayouts } from './city-token-rewards.js';

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

// The identities one balance covers: a points account and its linked wallet (one per realm).
async function identities(db, { recipient = null, wallet = null, simulationRun = '' }) {
    const { rows } = await db.query(`SELECT id::text AS id, wallet FROM consensus.points_account
        WHERE simulation_run = $3 AND (id::text = $1 OR ($2::text IS NOT NULL AND wallet = $2))`, [recipient, wallet, simulationRun]);
    return [...new Set([recipient, wallet, ...rows.flatMap(row => [row.id, row.wallet])].filter(Boolean))];
}

// Per-token net balance of a set of identities: bet awards + boost payouts received − boosts spent
// (a refunded boost no longer counts as spent).
const NET_SQL = `SELECT token, sum(amount) AS amount FROM (
        SELECT token, amount FROM consensus.city_token_award WHERE simulation_run = $2 AND (recipient = ANY($1) OR wallet = ANY($1))
        UNION ALL SELECT token, amount FROM consensus.city_token_boost_payout WHERE simulation_run = $2 AND recipient = ANY($1)
        UNION ALL SELECT token, -amount FROM consensus.city_token_boost WHERE simulation_run = $2 AND booster = ANY($1) AND status <> 'refunded'
    ) entries GROUP BY token`;

/**
 * Net balances of a points account or of a wallet. A wallet's balance includes the points account
 * linked to it, so the two books meet at the wallet.
 */
export async function balances(db, { recipient = null, wallet = null, simulationRun = '' }) {
    const ids = await identities(db, { recipient, wallet, simulationRun });
    const { rows } = await db.query(NET_SQL, [ids, simulationRun]);
    const recent = await db.query(`SELECT * FROM (
            SELECT token, amount, 'award' AS kind, agreement_account, created_at FROM consensus.city_token_award
             WHERE simulation_run = $2 AND (recipient = ANY($1) OR wallet = ANY($1))
            UNION ALL SELECT token, amount, 'payout-' || role, agreement_account, created_at FROM consensus.city_token_boost_payout
             WHERE simulation_run = $2 AND recipient = ANY($1)
            UNION ALL SELECT token, amount, 'boost-' || status, agreement_account, created_at FROM consensus.city_token_boost
             WHERE simulation_run = $2 AND booster = ANY($1)
        ) entries ORDER BY created_at DESC, token LIMIT 20`, [ids, simulationRun]);
    return {
        balances: rows.filter(row => BigInt(row.amount) > 0n)
            .sort((a, b) => (a.token === 'ugt') - (b.token === 'ugt') || (BigInt(b.amount) > BigInt(a.amount) ? 1 : -1)).map(shape),
        recent: recent.rows.map(row => ({ ...shape(row), kind: row.kind, agreementAccount: row.agreement_account,
            at: row.created_at.toISOString() }))
    };
}

/**
 * Spend `amount` of `token` from a points account (and its linked wallet's earnings) on boosting an
 * active agreement. Locks the account so concurrent boosts cannot overspend. Idempotent by request.
 */
export async function spendBoost(db, { account, requestId, source, token, amount }) {
    const prior = await db.query('SELECT * FROM consensus.city_token_boost WHERE booster = $1 AND request_id = $2', [account.id, requestId]);
    if (prior.rows[0]) {
        const row = prior.rows[0];
        if (row.agreement_account !== source.account || row.token !== token || row.amount !== String(amount)) {
            throw Object.assign(new Error('requestId reused with different content'), { status: 409 });
        }
        return { boost: boostShape(row), replayed: true };
    }
    if (token !== 'ugt' && token !== source.city) throw Object.assign(new Error(`boost this agreement with ${source.city} or ugt`), { status: 400 });
    await db.query('SELECT id FROM consensus.points_account WHERE id = $1 FOR UPDATE', [account.id]);
    const ids = await identities(db, { recipient: account.id, wallet: account.wallet, simulationRun: account.simulation_run });
    const { rows } = await db.query(NET_SQL, [ids, account.simulation_run]);
    const held = BigInt(rows.find(row => row.token === token)?.amount || 0);
    if (held < amount) throw Object.assign(new Error('insufficient city token balance'), { status: 409 });
    const inserted = await db.query(`INSERT INTO consensus.city_token_boost
        (booster, request_id, simulation_run, agreement_account, agreement_cid, city, token, amount)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [account.id, requestId, account.simulation_run, source.account, source.cid, source.city, token, String(amount)]);
    return { boost: boostShape(inserted.rows[0]), replayed: false };
}

const boostShape = row => ({ id: row.id, agreementAccount: row.agreement_account, status: row.status,
    ...shape(row), createdAt: row.created_at.toISOString() });

/** An agreement's city-token boosts: totals per token and status, and the latest boosts. */
export async function agreementBoosts(db, { agreementAccount, simulationRun = '' }) {
    const { rows } = await db.query(`SELECT token, status, sum(amount) AS amount, count(DISTINCT booster)::int AS boosters
        FROM consensus.city_token_boost WHERE agreement_account = $1 AND simulation_run = $2
        GROUP BY token, status ORDER BY token = 'ugt', token, status`, [agreementAccount, simulationRun]);
    return rows.map(row => ({ ...shape(row), status: row.status, boosters: row.boosters }));
}

/**
 * Settle one agreement's active boosts once its chain status is final: 'executed' pays each boost
 * out (boostPayouts), 'cancelled' or 'expired' refunds it. Run inside a transaction.
 */
export async function settleBoosts(db, { agreementAccount, chainStatus, sponsor, rights }) {
    if (!['executed', 'cancelled', 'expired'].includes(chainStatus)) return { settled: 0 };
    const { rows } = await db.query(`SELECT * FROM consensus.city_token_boost
        WHERE agreement_account = $1 AND status = 'active' FOR UPDATE`, [agreementAccount]);
    for (const boost of rows) {
        if (chainStatus === 'executed') {
            for (const payout of boostPayouts({ amount: BigInt(boost.amount), sponsor, rights })) {
                await db.query(`INSERT INTO consensus.city_token_boost_payout
                    (boost_id, simulation_run, recipient, role, token, amount, agreement_account) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
                [boost.id, boost.simulation_run, payout.recipient, payout.role, boost.token, String(payout.amount), agreementAccount]);
            }
        }
        await db.query(`UPDATE consensus.city_token_boost SET status = $2, settled_at = now(), updated_at = now() WHERE id = $1`,
            [boost.id, chainStatus === 'executed' ? 'paid' : 'refunded']);
    }
    return { settled: rows.length, outcome: chainStatus === 'executed' ? 'paid' : 'refunded' };
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
