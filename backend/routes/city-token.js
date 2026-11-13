// Public reads of the off-chain city meme token ledger (docs/citymemetoken.md): balances of a points
// account or wallet, and per-token standings. Awards are written by resolve and the award job.
import rateLimit from 'express-rate-limit';
import { PublicKey } from '@solana/web3.js';
import { balances, standings } from '../markets/city-token-ledger.js';
import { validateRealm, UUID } from '../markets/points-ledger.js';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });

function canonicalWallet(value) {
    try { const wallet = new PublicKey(value).toBase58(); if (wallet === value) return wallet; } catch { /* below */ }
    throw fail('wallet must be a canonical base58 address');
}

export function setupCityTokenRoutes(app, pool, { rateLimiter } = {}) {
    const limiter = rateLimiter || rateLimit({ windowMs: 60_000, limit: 240, standardHeaders: true, legacyHeaders: false });
    const send = (res, cause) => {
        const status = cause.status || 500;
        if (status >= 500) console.error(`[${new Date().toISOString()}] city token route failed:`, cause);
        res.status(status).json({ error: status < 500 ? cause.message : 'City token service unavailable' });
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
