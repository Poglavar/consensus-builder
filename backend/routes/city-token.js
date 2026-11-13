// The off-chain city meme token ledger over HTTP (docs/citymemetoken.md): public balances, standings and
// agreement boosts, and boosting an agreement from a points account. Awards are written by resolve and
// the award job; boosts are settled by the award job once the agreement's chain status is final.
import rateLimit from 'express-rate-limit';
import { PublicKey } from '@solana/web3.js';
import { balances, standings, spendBoost, agreementBoosts } from '../markets/city-token-ledger.js';
import { validateRealm, UUID, accountFromToken, parseSource, transaction } from '../markets/points-ledger.js';
import { formatTokenAmount } from '../markets/city-token-rewards.js';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });

function canonicalWallet(value) {
    try { const wallet = new PublicKey(value).toBase58(); if (wallet === value) return wallet; } catch { /* below */ }
    throw fail('wallet must be a canonical base58 address');
}

export function setupCityTokenRoutes(app, pool, { readAgreement, now = () => Date.now(), rateLimiter } = {}) {
    const limiter = rateLimiter || rateLimit({ windowMs: 60_000, limit: 240, standardHeaders: true, legacyHeaders: false });
    const send = (res, cause) => {
        const status = cause.status || 500;
        if (status >= 500) console.error(`[${new Date().toISOString()}] city token route failed:`, cause);
        const message = status < 500 ? cause.message : 'City token service unavailable';
        // Same error shape as the points routes: a code (upper-cased by the client) and the message.
        res.status(status).json({ error: message.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''), message });
    };

    app.get('/bets/city-token/balances', limiter, async (req, res) => {
        res.set('Cache-Control', 'no-store');
        try {
            const simulationRun = validateRealm(req.query.simulationRun);
            const recipient = req.query.account ? String(req.query.account) : null;
            if (recipient && !UUID.test(recipient)) throw fail('account must be a points account id');
            const wallet = req.query.wallet ? canonicalWallet(String(req.query.wallet)) : null;
            if (!recipient && !wallet) throw fail('account or wallet is required');
            res.json({ account: recipient, wallet, simulationRun, ...(await balances(pool, { recipient, wallet, simulationRun })) });
        } catch (cause) { send(res, cause); }
    });

    app.get('/bets/city-token/boosts', limiter, async (req, res) => {
        res.set('Cache-Control', 'no-store');
        try {
            const simulationRun = validateRealm(req.query.simulationRun);
            const agreementAccount = String(req.query.agreementAccount || '');
            if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(agreementAccount)) throw fail('agreementAccount is required');
            res.json({ agreementAccount, simulationRun, boosts: await agreementBoosts(pool, { agreementAccount, simulationRun }) });
        } catch (cause) { send(res, cause); }
    });

    // Boost an agreement with the city token or UGT. Authenticated like every points write (the
    // bearer credential), idempotent by requestId, and refused once the agreement is no longer active.
    app.post('/bets/points/boost', limiter, async (req, res) => {
        res.set('Cache-Control', 'no-store');
        try {
            const body = req.body || {};
            const allowed = ['requestId', 'agreementAccount', 'simulationRun', 'token', 'amount'];
            if (Object.keys(body).some(key => !allowed.includes(key))) throw fail('unsupported boost field');
            if (!UUID.test(body.requestId || '')) throw fail('requestId must be UUID');
            if (typeof body.amount !== 'string' || !/^[1-9]\d{0,25}$/.test(body.amount)) throw fail('amount must be a positive integer string');
            if (typeof body.token !== 'string' || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(body.token)) throw fail('token must be a city slug or ugt');
            const simulationRun = validateRealm(body.simulationRun);
            const bearer = /^Bearer (.+)$/.exec(req.get('authorization') || '')?.[1];
            const account = await accountFromToken(pool, bearer);
            if (account.simulation_run !== simulationRun) throw fail('token realm mismatch', 403);
            if (typeof readAgreement !== 'function') throw fail('agreement source unavailable', 503);
            const source = parseSource(await readAgreement(String(body.agreementAccount || '')));
            if (source.chainStatus !== 'active' || source.chainTime >= source.closesAt || Math.floor(now() / 1000) >= source.closesAt) {
                throw fail('this agreement is no longer open for boosts', 409);
            }
            const { boost, replayed } = await transaction(pool, db => spendBoost(db, {
                account, requestId: body.requestId, source, token: body.token, amount: BigInt(body.amount) }));
            console.log(`[${new Date().toISOString()}] city token boost ${replayed ? 'replayed' : 'spent'}: ${formatTokenAmount(boost.amount)} ${boost.symbol} on ${source.account}`);
            res.json({ receipt: { requestId: body.requestId, replayed, ...boost } });
        } catch (cause) { send(res, cause); }
    });

    app.get('/bets/city-token/standings', limiter, async (req, res) => {
        res.set('Cache-Control', 'no-store');
        try {
            const simulationRun = validateRealm(req.query.simulationRun);
            const token = String(req.query.token || 'ugt');
            if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(token)) throw fail('token must be a city slug or ugt');
            res.json({ token, simulationRun, standings: await standings(pool, { token, simulationRun }) });
        } catch (cause) { send(res, cause); }
    });
}
