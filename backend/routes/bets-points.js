// HTTP API for the independent PostgreSQL points ledger.
import rateLimit from 'express-rate-limit';
import { PublicKey } from '@solana/web3.js';
import {
    accountFromToken, amount, canTrade, digest, ensureMarket, marketShape, outcomeFor,
    parseSource, payout, randomUUID, STARTING_BALANCE, transaction, validateRealm,
    UUID, LMSR, WALLET_CHALLENGE_TTL_MS, walletChallengeMessage, verifyWalletSignature
} from '../markets/points-ledger.js';

const MAX_QUANTITY = LMSR.MAX_QUANTITY;
const error = (message, status = 400) => Object.assign(new Error(message), { status });
const bearer = req => /^Bearer (.+)$/.exec(req.get('authorization') || '')?.[1];
const noStore = (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); };

function sendError(res, cause, route = res.req?.path || 'unknown') {
    const status = cause.status || 500;
    const message = status < 500 ? cause.message : 'Points service unavailable';
    const code = message.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'points_unavailable';
    if (status >= 500) console.error(JSON.stringify({ at: new Date().toISOString(), route, code, name: cause.name || 'Error' }));
    return res.status(status).json({ error: code, message });
}

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}

function normalizePositionRows(rows) {
    const positions = {};
    for (const row of rows) {
        positions[row.agreement_account] = {
            yes: { amount: String(row.yes_shares), claimed: Boolean(row.yes_claimed) },
            no: { amount: String(row.no_shares), claimed: Boolean(row.no_claimed) },
            resolved: Boolean(row.resolved), outcome: row.outcome || null
        };
    }
    return positions;
}

async function outstandingObligation(db, market) {
    if (!market.resolved) {
        const yes = BigInt(market.q_yes);
        const no = BigInt(market.q_no);
        return yes > no ? yes : no;
    }
    const { rows } = await db.query(
        `SELECT yes_shares, no_shares, yes_claimed, no_claimed
           FROM consensus.points_position WHERE market_id = $1`, [market.id]
    );
    return rows.reduce((sum, row) => {
        if (market.outcome === 'void') {
            return sum + (row.yes_claimed ? 0n : BigInt(row.yes_shares) / 2n)
                + (row.no_claimed ? 0n : BigInt(row.no_shares) / 2n);
        }
        const side = market.outcome;
        const claimed = side === 'yes' ? row.yes_claimed : row.no_claimed;
        return sum + (claimed ? 0n : BigInt(side === 'yes' ? row.yes_shares : row.no_shares));
    }, 0n);
}

async function checkSolvency(db, market) {
    const obligation = await outstandingObligation(db, market);
    if (BigInt(market.vault) < obligation) throw error('points vault solvency invariant failed', 409);
}

function tradeRequest(body) {
    const allowed = ['requestId', 'agreementAccount', 'simulationRun', 'action', 'side', 'shares', 'maxCost', 'minReturn'];
    if (Object.keys(body).some(key => !allowed.includes(key))) throw error('unsupported trade field');
    if (!UUID.test(body.requestId || '')) throw error('requestId must be UUID');
    if (typeof body.agreementAccount !== 'string' || !body.agreementAccount) throw error('agreementAccount is required');
    if (!['buy', 'sell'].includes(body.action) || !['yes', 'no'].includes(body.side)) throw error('invalid trade action or side');
    const shares = amount(body.shares, 'shares');
    if (shares === 0n || shares > MAX_QUANTITY) throw error('shares must be a positive u64');
    if (body.action === 'buy') amount(body.maxCost, 'maxCost');
    else amount(body.minReturn, 'minReturn');
    return { ...body, simulationRun: validateRealm(body.simulationRun), shares: String(shares) };
}

function actionRequest(body, kind) {
    const allowed = kind === 'claim'
        ? ['requestId', 'agreementAccount', 'simulationRun', 'side']
        : ['requestId', 'agreementAccount', 'simulationRun'];
    if (Object.keys(body).some(key => !allowed.includes(key))) throw error(`unsupported ${kind} field`);
    if (!UUID.test(body.requestId || '')) throw error('requestId must be UUID');
    if (typeof body.agreementAccount !== 'string' || !body.agreementAccount) throw error('agreementAccount is required');
    if (kind === 'claim' && !['yes', 'no'].includes(body.side)) throw error('side must be yes or no');
    return { ...body, simulationRun: validateRealm(body.simulationRun) };
}

export function setupBetsPointsRoutes(app, pool, { readAgreement, now = () => Date.now(), rateLimiter } = {}) {
    const limiter = rateLimiter || rateLimit({
        windowMs: 60_000, limit: 240, standardHeaders: true, legacyHeaders: false
    });
    const sourceFor = async account => parseSource(await readAgreement(account));
    const authenticate = async req => {
        const account = await accountFromToken(pool, bearer(req));
        const requestRealm = req.body?.simulationRun ?? req.query?.simulationRun ?? '';
        if (account.simulation_run !== requestRealm) throw error('token realm mismatch', 403);
        return account;
    };

    app.post('/bets/points/account', limiter, noStore, async (req, res) => {
        try {
            const { agentId } = req.body || {};
            const simulationRun = validateRealm(req.body?.simulationRun);
            const token = bearer(req);
            if (typeof agentId !== 'string' || agentId.length < 1 || agentId.length > 120
                || /[\u0000-\u001f\u007f]/.test(agentId) || !/^[a-f0-9]{64}$/i.test(token || '')) {
                throw error('invalid account request');
            }
            const hash = digest(token);
            const account = await transaction(pool, async db => {
                await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [hash]);
                const existing = (await db.query(
                    'SELECT * FROM consensus.points_account WHERE token_hash = $1 FOR UPDATE', [hash]
                )).rows[0];
                if (existing) {
                    if (existing.agent_id !== agentId || existing.simulation_run !== simulationRun) {
                        throw error('token already belongs to another account', 409);
                    }
                    return existing;
                }
                const id = randomUUID();
                return (await db.query(
                    `INSERT INTO consensus.points_account
                        (id, token_hash, agent_id, simulation_run, alias, balance)
                     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
                    [id, hash, agentId, simulationRun, `Forecaster ${id.slice(0, 6)}`, String(STARTING_BALANCE)]
                )).rows[0];
            });
            res.json({ id: account.id, account: account.id, alias: account.alias,
                balance: String(account.balance), simulationRun: account.simulation_run });
        } catch (cause) { sendError(res, cause); }
    });

    app.get('/bets/points/account', limiter, noStore, async (req, res) => {
        try {
            const account = await authenticate(req);
            const params = [account.id];
            const filter = req.query.agreementAccount
                ? ` AND m.agreement_account = $${params.push(req.query.agreementAccount)}` : '';
            const rows = await pool.query(
                `SELECT m.agreement_account, p.yes_shares, p.no_shares, p.yes_claimed,
                        p.no_claimed, m.outcome, m.resolved
                   FROM consensus.points_position p
                   JOIN consensus.points_market m ON m.id = p.market_id
                  WHERE p.account_id = $1${filter} ORDER BY m.agreement_account`, params
            );
            const recent = await pool.query(
                `SELECT receipt FROM consensus.points_transaction WHERE account_id = $1
                 ORDER BY created_at DESC LIMIT 20`, [account.id]
            );
            res.json({ id: account.id, alias: account.alias, wallet: account.wallet || null,
                balance: String(account.balance), positions: normalizePositionRows(rows.rows),
                recent: recent.rows.map(row => row.receipt) });
        } catch (cause) { sendError(res, cause); }
    });

    app.post('/bets/points/wallet-challenge', limiter, noStore, async (req, res) => {
        try {
            const account = await authenticate(req);
            const { wallet } = req.body || {};
            let canonicalWallet;
            try { canonicalWallet = new PublicKey(wallet).toBase58(); }
            catch { throw error('invalid wallet'); }
            if (wallet !== canonicalWallet) throw error('wallet must be canonical base58');
            const expiresAt = now() + WALLET_CHALLENGE_TTL_MS;
            const nonce = randomUUID().replaceAll('-', '');
            const message = walletChallengeMessage({ account: account.id, wallet, nonce,
                expiresAt: Math.floor(expiresAt / 1000) });
            await transaction(pool, async db => {
                const locked = (await db.query(
                    'SELECT id, wallet FROM consensus.points_account WHERE id = $1 FOR UPDATE', [account.id]
                )).rows[0];
                if (locked.wallet && locked.wallet !== wallet) throw error('unlink existing wallet first', 409);
                const collision = (await db.query(
                    `SELECT id FROM consensus.points_account WHERE wallet = $1 AND simulation_run = $2 FOR UPDATE`,
                    [wallet, account.simulation_run]
                )).rows[0];
                if (collision && collision.id !== account.id) throw error('wallet already linked in this realm', 409);
                await db.query(
                    `INSERT INTO consensus.points_wallet_challenge
                        (account_id, wallet, nonce, expires_at)
                     VALUES ($1,$2,$3,to_timestamp($4 / 1000.0))`, [account.id, wallet, nonce, expiresAt]
                );
            });
            res.json({ wallet, nonce, expiresAt: Math.floor(expiresAt / 1000), message });
        } catch (cause) { sendError(res, cause); }
    });

    app.post('/bets/points/wallet-link', limiter, noStore, async (req, res) => {
        try {
            const account = await authenticate(req);
            const { wallet, nonce, signature } = req.body || {};
            if (typeof nonce !== 'string' || !/^[a-f0-9]{32}$/.test(nonce)
                || typeof signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(signature)) {
                throw error('invalid wallet proof');
            }
            let canonicalWallet;
            try { canonicalWallet = new PublicKey(wallet).toBase58(); }
            catch { throw error('invalid wallet'); }
            if (wallet !== canonicalWallet) throw error('wallet must be canonical base58');
            const linked = await transaction(pool, async db => {
                await db.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
                    [wallet, account.simulation_run]);
                const locked = (await db.query(
                    'SELECT wallet FROM consensus.points_account WHERE id = $1 FOR UPDATE', [account.id]
                )).rows[0];
                if (locked.wallet && locked.wallet !== wallet) throw error('unlink existing wallet first', 409);
                const challenge = (await db.query(
                    `SELECT *, floor(extract(epoch from expires_at))::bigint expires_epoch
                       FROM consensus.points_wallet_challenge
                      WHERE account_id = $1 AND nonce = $2 FOR UPDATE`, [account.id, nonce]
                )).rows[0];
                if (!challenge || challenge.wallet !== wallet || challenge.consumed_at
                    || Number(challenge.expires_epoch) * 1000 <= now()) {
                    throw error('challenge missing, expired, or already used', 409);
                }
                const message = walletChallengeMessage({ account: account.id, wallet, nonce,
                    expiresAt: Number(challenge.expires_epoch) });
                const proof = Buffer.from(signature, 'base64');
                if (!verifyWalletSignature({ wallet, message, signature: proof })) throw error('wallet signature invalid', 403);
                const collision = (await db.query(
                    `SELECT id FROM consensus.points_account WHERE wallet = $1 AND simulation_run = $2 FOR UPDATE`,
                    [wallet, account.simulation_run]
                )).rows[0];
                if (collision && collision.id !== account.id) throw error('wallet already linked in this realm', 409);
                await db.query('UPDATE consensus.points_account SET wallet = $2, updated_at = now() WHERE id = $1',
                    [account.id, wallet]);
                await db.query(`UPDATE consensus.points_wallet_challenge SET consumed_at = now(), updated_at = now()
                    WHERE account_id = $1 AND nonce = $2`, [account.id, nonce]);
                return { account: account.id, wallet };
            });
            res.json(linked);
        } catch (cause) { sendError(res, cause); }
    });

    app.get('/bets/points/markets', limiter, noStore, async (req, res) => {
        try {
            const simulationRun = validateRealm(req.query.simulationRun);
            const accounts = String(req.query.accounts || '').split(',').filter(Boolean);
            if (accounts.length > 100) throw error('too many accounts');
            const markets = {};
            const subjects = {};
            for (const agreementAccount of accounts) {
                const source = await sourceFor(agreementAccount);
                subjects[agreementAccount] = {
                    account: source.account, cid: source.cid, city: source.city,
                    ...(source.sponsor ? { sponsor: source.sponsor } : {}),
                    chainStatus: source.chainStatus, deadline: new Date(source.closesAt * 1000).toISOString(),
                    closesAt: source.closesAt, graceSeconds: source.graceSeconds,
                    executedAt: source.executedAt
                };
                const market = await transaction(pool, async db => {
                    const exists = (await db.query(
                        `SELECT id FROM consensus.points_market
                          WHERE agreement_account = $1 AND simulation_run = $2`, [agreementAccount, simulationRun]
                    )).rows.length > 0;
                    const mayCreate = canTrade(source,
                        { resolved: false, closesAt: source.closesAt, graceSeconds: source.graceSeconds },
                        Math.floor(now() / 1000)) && source.chainTime < source.closesAt;
                    if (!exists && !mayCreate) return null;
                    return ensureMarket(db, source, simulationRun);
                });
                if (market) markets[agreementAccount] = marketShape(market);
            }
            res.json({ markets, subjects });
        } catch (cause) { sendError(res, cause); }
    });

    app.get('/bets/points/positions', limiter, noStore, async (req, res) => {
        try {
            const simulationRun = validateRealm(req.query.simulationRun);
            if (!UUID.test(req.query.account || '')) throw error('account must be UUID');
            const { rows } = await pool.query(
                `SELECT a.id AS account_id, a.alias, a.wallet, m.agreement_account,
                        p.yes_shares, p.no_shares, p.yes_claimed, p.no_claimed, m.resolved, m.outcome
                   FROM consensus.points_position p
                   JOIN consensus.points_account a ON a.id = p.account_id
                   JOIN consensus.points_market m ON m.id = p.market_id
                  WHERE a.id = $1 AND a.simulation_run = $2 AND m.simulation_run = $2
                  ORDER BY m.agreement_account`, [req.query.account, simulationRun]
            );
            const mapped = normalizePositionRows(rows);
            const positions = Object.entries(mapped).map(([agreementAccount, position]) => ({
                agreementAccount, ...position
            }));
            res.json({ account: rows[0]?.account_id || req.query.account,
                alias: rows[0]?.alias || null, wallet: rows[0]?.wallet || null,
                simulationRun, positions });
        } catch (cause) { sendError(res, cause); }
    });

    app.get('/bets/points/leaderboard', limiter, noStore, async (req, res) => {
        try {
            const simulationRun = validateRealm(req.query.simulationRun);
            const { rows } = await pool.query(
                `SELECT a.id, a.alias, a.wallet, a.balance, m.id AS market_id, m.b, m.q_yes, m.q_no,
                        m.resolved, m.outcome, p.yes_shares, p.no_shares, p.yes_claimed, p.no_claimed
                   FROM consensus.points_account a
              LEFT JOIN consensus.points_position p ON p.account_id = a.id
              LEFT JOIN consensus.points_market m ON m.id = p.market_id
                  WHERE a.simulation_run = $1
                    AND EXISTS (SELECT 1 FROM consensus.points_transaction t
                         WHERE t.account_id = a.id AND t.kind IN ('buy','sell'))`, [simulationRun]
            );
            const byAccount = new Map();
            for (const row of rows) {
                if (!byAccount.has(row.id)) byAccount.set(row.id, {
                    account: row.id, alias: row.alias, wallet: row.wallet || null,
                    balance: BigInt(row.balance), equity: BigInt(row.balance), positionsCount: 0
                });
                const standing = byAccount.get(row.id);
                if (!row.market_id) continue;
                const yes = BigInt(row.yes_shares), no = BigInt(row.no_shares);
                if (yes || no) standing.positionsCount++;
                if (row.resolved) {
                    if (!row.yes_claimed) standing.equity += payout('yes', yes, row.outcome);
                    if (!row.no_claimed) standing.equity += payout('no', no, row.outcome);
                } else {
                    const b = BigInt(row.b), qYes = BigInt(row.q_yes), qNo = BigInt(row.q_no);
                    let liquidation = 0n, afterYes = qYes;
                    // The public leaderboard prices a deterministic full exit: YES first, then NO.
                    if (yes) { liquidation += LMSR.sellReturn(b, qYes, qNo, 'yes', yes); afterYes -= yes; }
                    if (no) liquidation += LMSR.sellReturn(b, afterYes, qNo, 'no', no);
                    standing.equity += liquidation;
                }
            }
            const leaderboard = [...byAccount.values()]
                .sort((a, b) => a.equity === b.equity ? a.account.localeCompare(b.account)
                    : a.equity > b.equity ? -1 : 1)
                .slice(0, 30).map((row, index) => ({ rank: index + 1, account: row.account,
                    alias: row.alias, wallet: row.wallet, cashBalance: String(row.balance),
                    equity: String(row.equity), positionsCount: row.positionsCount }));
            res.json({ simulationRun, leaderboard });
        } catch (cause) { sendError(res, cause); }
    });

    async function mutate(req, res, kind) {
        res.set('Cache-Control', 'no-store');
        try {
            const account = await authenticate(req);
            const body = kind === 'trade' ? tradeRequest(req.body || {}) : actionRequest(req.body || {}, kind);
            if (body.simulationRun !== account.simulation_run) throw error('token realm mismatch', 403);
            const requestValue = canonical({ kind, ...body });
            const requestJson = JSON.stringify(requestValue);
            const receipt = await transaction(pool, async db => {
                const lockedAccount = (await db.query(
                    'SELECT * FROM consensus.points_account WHERE id = $1 FOR UPDATE', [account.id]
                )).rows[0];
                const prior = (await db.query(
                    `SELECT request = $3::jsonb AS same_request, receipt
                       FROM consensus.points_transaction
                      WHERE account_id = $1 AND request_id = $2`, [account.id, body.requestId, requestJson]
                )).rows[0];
                if (prior) {
                    if (!prior.same_request) throw error('requestId reused with different content', 409);
                    return prior.receipt;
                }

                const source = await sourceFor(body.agreementAccount);
                const nowSeconds = Math.floor(now() / 1000);
                const registered = (await db.query(
                    `SELECT id FROM consensus.points_market
                      WHERE agreement_account = $1 AND simulation_run = $2`,
                    [body.agreementAccount, account.simulation_run]
                )).rows[0];
                if (!registered && kind !== 'trade') throw error('points market is not registered', 409);
                if (!registered && kind === 'trade' && (!canTrade(source,
                    { resolved: false, closesAt: source.closesAt, graceSeconds: source.graceSeconds }, nowSeconds)
                    || source.chainTime >= source.closesAt)) throw error('market is closed', 409);
                const market = await ensureMarket(db, source, account.simulation_run);
                const position = (await db.query(
                    `SELECT * FROM consensus.points_position WHERE account_id = $1 AND market_id = $2 FOR UPDATE`,
                    [account.id, market.id]
                )).rows[0] || null;
                let side = body.side || null;
                let shares = 0n;
                let delta = 0n;
                let action = kind;
                let outcome = market.outcome;

                if (kind === 'trade') {
                    if (!canTrade(source, marketShape(market), nowSeconds)
                        || source.chainTime >= Number(market.closes_at)) throw error('market is closed', 409);
                    if (lockedAccount.wallet && source.insiders.includes(lockedAccount.wallet)) {
                        throw error('agreement insiders cannot trade', 403);
                    }
                    action = body.action;
                    shares = BigInt(body.shares);
                    const beforeYes = BigInt(market.q_yes), beforeNo = BigInt(market.q_no);
                    const afterYes = beforeYes + (side === 'yes' ? (action === 'buy' ? shares : -shares) : 0n);
                    const afterNo = beforeNo + (side === 'no' ? (action === 'buy' ? shares : -shares) : 0n);
                    if (afterYes < 0n || afterNo < 0n || afterYes > MAX_QUANTITY || afterNo > MAX_QUANTITY) {
                        throw error('market share limit exceeded', 409);
                    }
                    if (action === 'buy') {
                        delta = LMSR.buyCost(BigInt(market.b), beforeYes, beforeNo, side, shares);
                        if (delta > amount(body.maxCost, 'maxCost')) throw error('stale quote', 409);
                        if (BigInt(lockedAccount.balance) < delta) throw error('insufficient balance', 409);
                    } else {
                        const held = BigInt(position?.[`${side}_shares`] || 0);
                        if (shares > held) throw error('insufficient shares', 409);
                        delta = LMSR.sellReturn(BigInt(market.b), beforeYes, beforeNo, side, shares);
                        if (delta < amount(body.minReturn, 'minReturn')) throw error('stale quote', 409);
                    }
                    if (delta <= 0n) throw error('zero value trade');
                    if (action === 'buy') {
                        await db.query(`UPDATE consensus.points_account
                            SET balance = balance - $2, updated_at = now()
                            WHERE id = $1 AND balance >= $2`, [account.id, String(delta)]);
                        await db.query(`INSERT INTO consensus.points_position
                            (account_id, market_id, yes_shares, no_shares)
                            VALUES ($1,$2,$3,$4)
                            ON CONFLICT (account_id, market_id) DO UPDATE SET
                                yes_shares = consensus.points_position.yes_shares + EXCLUDED.yes_shares,
                                no_shares = consensus.points_position.no_shares + EXCLUDED.no_shares,
                                updated_at = now()`,
                        [account.id, market.id, String(side === 'yes' ? shares : 0n), String(side === 'no' ? shares : 0n)]);
                    } else {
                        await db.query(`UPDATE consensus.points_position SET
                            yes_shares = yes_shares - $3, updated_at = now()
                            WHERE account_id = $1 AND market_id = $2 AND yes_shares >= $3`,
                        [account.id, market.id, String(side === 'yes' ? shares : 0n)]);
                        await db.query(`UPDATE consensus.points_position SET
                            no_shares = no_shares - $3, updated_at = now()
                            WHERE account_id = $1 AND market_id = $2 AND no_shares >= $3`,
                        [account.id, market.id, String(side === 'no' ? shares : 0n)]);
                        await db.query('UPDATE consensus.points_account SET balance = balance + $2, updated_at = now() WHERE id = $1',
                            [account.id, String(delta)]);
                    }
                    const nextVault = BigInt(market.vault) + (action === 'buy' ? delta : -delta);
                    await db.query(`UPDATE consensus.points_market SET q_yes = $2, q_no = $3,
                        vault = $4, updated_at = now() WHERE id = $1`,
                    [market.id, String(afterYes), String(afterNo), String(nextVault)]);
                    market.q_yes = String(afterYes); market.q_no = String(afterNo); market.vault = String(nextVault);
                    await checkSolvency(db, market);
                } else if (kind === 'resolve') {
                    if (!market.resolved) {
                        outcome = outcomeFor(source, nowSeconds);
                        if (!outcome) throw error('market not resolvable', 409);
                        await db.query(`UPDATE consensus.points_market SET resolved = true, outcome = $2, updated_at = now()
                            WHERE id = $1`, [market.id, outcome]);
                        market.resolved = true; market.outcome = outcome;
                        side = outcome;
                    } else { outcome = market.outcome; side = market.outcome; }
                } else {
                    if (!market.resolved) throw error('market unresolved', 409);
                    if (!position) throw error('nothing claimable', 409);
                    const claimed = Boolean(position[`${side}_claimed`]);
                    shares = BigInt(position[`${side}_shares`]);
                    if (claimed || shares === 0n) throw error('nothing claimable on this side', 409);
                    delta = payout(side, shares, market.outcome);
                    if (delta === 0n) throw error('zero claim entitlement', 409);
                    await db.query(`UPDATE consensus.points_position SET ${side}_claimed = true, updated_at = now()
                        WHERE account_id = $1 AND market_id = $2 AND ${side}_claimed = false`, [account.id, market.id]);
                    await db.query(`UPDATE consensus.points_account SET balance = balance + $2,
                        updated_at = now() WHERE id = $1`, [account.id, String(delta)]);
                    const nextVault = BigInt(market.vault) - delta;
                    if (nextVault < 0n) throw error('points vault underflow', 409);
                    await db.query(`UPDATE consensus.points_market SET paid_out = paid_out + $2,
                        vault = $3, updated_at = now() WHERE id = $1`, [market.id, String(delta), String(nextVault)]);
                    market.vault = String(nextVault);
                    position[`${side}_claimed`] = true;
                    await checkSolvency(db, market);
                    outcome = market.outcome;
                }

                const currentBalance = kind === 'trade'
                    ? BigInt(lockedAccount.balance) + (action === 'buy' ? -delta : delta)
                    : kind === 'claim' ? BigInt(lockedAccount.balance) + delta : BigInt(lockedAccount.balance);
                if (currentBalance < 0n || currentBalance > MAX_QUANTITY) throw error('balance limit exceeded', 409);
                const result = {
                    id: randomUUID(), requestId: body.requestId, action, side, shares: String(shares), amount: String(delta),
                    ...(kind === 'claim' ? { awardedAmount: String(delta) } : {}),
                    ...(kind === 'resolve' || kind === 'claim' ? { outcome } : {}),
                    balance: String(currentBalance), agreementAccount: body.agreementAccount,
                    createdAt: new Date(now()).toISOString()
                };
                await db.query(`INSERT INTO consensus.points_transaction
                    (account_id, market_id, request_id, kind, side, shares, amount, request, receipt)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)`,
                [account.id, market.id, body.requestId, action, side, String(shares), String(delta),
                    requestJson, JSON.stringify(result)]);
                return result;
            });
            res.json({ receipt });
        } catch (cause) { sendError(res, cause); }
    }

    app.post('/bets/points/trade', limiter, (req, res) => mutate(req, res, 'trade'));
    app.post('/bets/points/resolve', limiter, (req, res) => mutate(req, res, 'resolve'));
    app.post('/bets/points/claim', limiter, (req, res) => mutate(req, res, 'claim'));
}
