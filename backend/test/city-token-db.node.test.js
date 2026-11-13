// Opt-in PostgreSQL test of city meme token awards through the real points routes: trades, resolve
// (which awards), the claim receipt, balances and standings. Isolated by a unique simulation realm.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import express from 'express';
import request from 'supertest';
import database from '../db/connection.cjs';
import { LMSR, B } from '../markets/points-ledger.js';
import { setupBetsPointsRoutes } from '../routes/bets-points.js';
import { setupCityTokenRoutes } from '../routes/city-token.js';
import { POINTS_POOL, UGT_DIVISOR } from '../markets/city-token-rewards.js';

const enabled = process.env.POINTS_DB_TEST === '1';
const BACKEND_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)));
const AGREEMENT = '11111111111111111111111111111115';

test('city token awards on points resolve', { skip: !enabled, timeout: 60_000 }, async () => {
    dotenv.config({ path: resolve(BACKEND_DIR, '.env'), quiet: true });
    if (!database.isLocalDatabase() || database.describeDatabase().database !== 'geodata') {
        throw new Error('Refusing city token integration test: DATABASE_URL must target local geodata.');
    }
    const pool = database.createPool({ max: 4, connectionTimeoutMillis: 5000 });
    const run = `city-token-${randomBytes(6).toString('hex')}`;
    let clock = Date.now();
    const source = { account: AGREEMENT, cid: `city-token-test-${randomUUID()}`, city: 'zagreb',
        closesAt: Math.floor(clock / 1000) + 3600, chainTime: Math.floor(clock / 1000), graceSeconds: 0,
        chainStatus: 'active', executedAt: null, insiders: [] };
    const app = express();
    app.use(express.json());
    const noLimit = (_req, _res, next) => next();
    setupBetsPointsRoutes(app, pool, { now: () => clock, readAgreement: async () => ({ ...source }), rateLimiter: noLimit });
    setupCityTokenRoutes(app, pool, { rateLimiter: noLimit });
    const account = async label => {
        const auth = { Authorization: `Bearer ${randomBytes(32).toString('hex')}` };
        const res = await request(app).post('/bets/points/account').set(auth).send({ agentId: label, simulationRun: run }).expect(200);
        return { id: res.body.id, auth };
    };
    const buy = async (who, side, shares) => {
        const market = (await request(app).get('/bets/points/markets').query({ accounts: AGREEMENT, simulationRun: run }).expect(200)).body.markets[AGREEMENT];
        const cost = LMSR.buyCost(B, BigInt(market.qYes), BigInt(market.qNo), side, shares);
        await request(app).post('/bets/points/trade').set(who.auth).send({ requestId: randomUUID(), agreementAccount: AGREEMENT,
            simulationRun: run, action: 'buy', side, shares: String(shares), maxCost: String(cost) }).expect(200);
        return cost;
    };
    try {
        const early = await account('early-yes'), late = await account('late-yes'), wrong = await account('no-side');
        const earlyCost = await buy(early, 'yes', 5_000_000n);
        await buy(wrong, 'no', 2_000_000n);
        const lateCost = await buy(late, 'yes', 5_000_000n);
        assert.ok(lateCost > earlyCost, 'the later buyer paid more for the same shares');

        clock = (source.closesAt - 1) * 1000;
        Object.assign(source, { chainStatus: 'executed', executedAt: source.closesAt - 2, chainTime: source.closesAt - 1 });
        await request(app).post('/bets/points/resolve').set(early.auth)
            .send({ requestId: randomUUID(), agreementAccount: AGREEMENT, simulationRun: run }).expect(200);

        const { rows } = await pool.query(`SELECT recipient, token, edge, amount FROM consensus.city_token_award
            WHERE simulation_run = $1 ORDER BY recipient, token`, [run]);
        const city = rows.filter(row => row.token === 'zagreb');
        assert.deepEqual(new Set(city.map(row => row.recipient)), new Set([early.id, late.id]), 'only correct bettors earn');
        const amountOf = id => BigInt(city.find(row => row.recipient === id).amount);
        assert.equal(BigInt(city.find(r => r.recipient === early.id).edge), 5_000_000n - earlyCost);
        assert.ok(amountOf(early.id) > amountOf(late.id), 'the earlier, cheaper call earns more');
        assert.ok(amountOf(early.id) + amountOf(late.id) <= POINTS_POOL);
        const ugt = rows.find(row => row.token === 'ugt' && row.recipient === early.id);
        assert.equal(BigInt(ugt.amount), amountOf(early.id) / UGT_DIVISOR);

        // Resolving again awards nothing more.
        await request(app).post('/bets/points/resolve').set(late.auth)
            .send({ requestId: randomUUID(), agreementAccount: AGREEMENT, simulationRun: run }).expect(200);
        const again = await pool.query('SELECT count(*)::int AS n FROM consensus.city_token_award WHERE simulation_run = $1', [run]);
        assert.equal(again.rows[0].n, rows.length);

        const claim = await request(app).post('/bets/points/claim').set(early.auth)
            .send({ requestId: randomUUID(), agreementAccount: AGREEMENT, simulationRun: run, side: 'yes' }).expect(200);
        assert.deepEqual(claim.body.receipt.cityToken.map(t => [t.symbol, t.amount]),
            [['ZAGREB', String(amountOf(early.id))], ['UGT', ugt.amount]]);

        const balance = await request(app).get('/bets/city-token/balances').query({ account: early.id, simulationRun: run }).expect(200);
        assert.equal(balance.body.balances.find(b => b.token === 'zagreb').amount, String(amountOf(early.id)));
        const standings = await request(app).get('/bets/city-token/standings').query({ token: 'zagreb', simulationRun: run }).expect(200);
        assert.equal(standings.body.standings[0].holder, early.id);
        assert.equal(standings.body.standings.length, 2);
    } finally {
        await pool.query('DELETE FROM consensus.city_token_award WHERE simulation_run = $1', [run]);
        await pool.query('DELETE FROM consensus.city_token_market WHERE simulation_run = $1', [run]);
        await pool.end();
    }
});
