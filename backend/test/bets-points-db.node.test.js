// Opt-in PostgreSQL integration test; every row is isolated by a unique simulation realm.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, randomBytes, randomUUID, sign } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import express from 'express';
import request from 'supertest';
import { Keypair } from '@solana/web3.js';
import database from '../db/connection.cjs';
import { LMSR, B, SEED, walletChallengeMessage } from '../markets/points-ledger.js';
import { setupBetsPointsRoutes } from '../routes/bets-points.js';

const enabled = process.env.POINTS_DB_TEST === '1';
const BACKEND_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)));
const MARKET_CANCEL = '11111111111111111111111111111111';
const MARKET_YES = '11111111111111111111111111111112';
const MARKET_LATE = '11111111111111111111111111111113';
const MARKET_OPEN = '11111111111111111111111111111114';

function keypairPrivateKey(pair) {
    const seed = Buffer.from(pair.secretKey.subarray(0, 32));
    const prefix = Buffer.from('302e020100300506032b657004220420', 'hex');
    return createPrivateKey({ key: Buffer.concat([prefix, seed]), format: 'der', type: 'pkcs8' });
}

test('points ledger transactions against local PostgreSQL', { skip: !enabled, timeout: 120_000 }, async t => {
    dotenv.config({ path: resolve(BACKEND_DIR, '.env'), quiet: true });
    const target = database.describeDatabase();
    if (!database.isLocalDatabase() || target.database !== 'geodata') {
        throw new Error('Refusing points ledger integration test: DATABASE_URL must target local geodata.');
    }

    const pool = database.createPool({ max: 4, connectionTimeoutMillis: 5000 });
    const run = `ledger-db-${randomBytes(6).toString('hex')}`;
    let clock = Date.now();
    const baseClock = clock;
    let sourceFailureFor = null;
    let retryAccount;
    const sources = new Map();
    const mkSource = account => ({
        account, cid: `points-test-${account.slice(-3)}-${randomUUID()}`,
        city: 'Local points ledger test', closesAt: Math.floor(clock / 1000) + 3600,
        chainTime: Math.floor(clock / 1000), graceSeconds: 0,
        chainStatus: 'active', executedAt: null, insiders: []
    });
    for (const account of [MARKET_CANCEL, MARKET_YES, MARKET_LATE, MARKET_OPEN]) sources.set(account, mkSource(account));
    sources.get(MARKET_OPEN).closesAt += 3600;

    try {
        const tables = await pool.query(`SELECT
            to_regclass('consensus.points_account') AS account_table,
            to_regclass('consensus.points_market') AS market_table,
            to_regclass('consensus.points_position') AS position_table,
            to_regclass('consensus.points_transaction') AS transaction_table,
            to_regclass('consensus.points_wallet_challenge') AS challenge_table`);
        assert.ok(Object.values(tables.rows[0]).every(Boolean), 'points ledger DDL must be applied before opt-in test');

        const app = express();
        app.use(express.json());
        setupBetsPointsRoutes(app, pool, {
            now: () => clock,
            readAgreement: async account => {
                if (sourceFailureFor === account) throw new Error('fixture source unavailable');
                const source = sources.get(account);
                if (!source) throw new Error('unknown fixture agreement');
                return { ...source };
            },
            rateLimiter: (_req, _res, next) => next()
        });

        const accounts = [];
        const createAccount = async label => {
            const token = randomBytes(32).toString('hex');
            const auth = { Authorization: `Bearer ${token}` };
            const response = await request(app).post('/bets/points/account').set(auth)
                .send({ agentId: `fixture-${label}`, simulationRun: run });
            assert.equal(response.status, 200, JSON.stringify(response.body));
            const item = { id: response.body.id, alias: response.body.alias, auth, token };
            accounts.push(item);
            return item;
        };
        const fetchMarket = async agreementAccount => (await request(app).get('/bets/points/markets')
            .query({ accounts: agreementAccount, simulationRun: run }).expect(200)).body.markets[agreementAccount];
        const submitTrade = (account, body) => request(app).post('/bets/points/trade')
            .set(account.auth).send({ ...body, simulationRun: run });
        const assertVaultCoversObligation = async agreementAccount => {
            const { rows: [market] } = await pool.query(
                `SELECT * FROM consensus.points_market WHERE agreement_account = $1 AND simulation_run = $2`,
                [agreementAccount, run]
            );
            const { rows: positions } = await pool.query(
                `SELECT yes_shares, no_shares, yes_claimed, no_claimed
                   FROM consensus.points_position WHERE market_id = $1`, [market.id]
            );
            let obligation;
            if (!market.resolved) obligation = BigInt(market.q_yes) > BigInt(market.q_no)
                ? BigInt(market.q_yes) : BigInt(market.q_no);
            else obligation = positions.reduce((sum, position) => {
                if (market.outcome === 'void') return sum
                    + (position.yes_claimed ? 0n : BigInt(position.yes_shares) / 2n)
                    + (position.no_claimed ? 0n : BigInt(position.no_shares) / 2n);
                const side = market.outcome;
                const claimed = side === 'yes' ? position.yes_claimed : position.no_claimed;
                const held = side === 'yes' ? position.yes_shares : position.no_shares;
                return sum + (claimed ? 0n : BigInt(held));
            }, 0n);
            assert.ok(BigInt(market.vault) >= obligation,
                `vault ${market.vault} must cover remaining obligation ${obligation}`);
        };

        await t.test('two accounts trade one LMSR market and an account can sell only its own shares', async () => {
            const first = await createAccount('two-account-a');
            const second = await createAccount('two-account-b');
            let market;
            const firstShares = 1_000_001n;
            const firstCost = LMSR.buyCost(B, 0n, 0n, 'yes', firstShares);
            const buyA = await submitTrade(first, {
                requestId: randomUUID(), agreementAccount: MARKET_CANCEL,
                action: 'buy', side: 'yes', shares: String(firstShares), maxCost: String(firstCost)
            }).expect(200);
            assert.equal(buyA.body.receipt.action, 'buy');
            assert.equal(buyA.body.receipt.amount, String(firstCost));
            const { rows: [afterBuy] } = await pool.query(
                `SELECT seed, vault FROM consensus.points_market
                  WHERE agreement_account = $1 AND simulation_run = $2`, [MARKET_CANCEL, run]
            );
            assert.equal(afterBuy.seed, String(SEED));
            assert.equal(afterBuy.vault, String(SEED + firstCost));
            market = await fetchMarket(MARKET_CANCEL);
            const secondShares = 1_000_003n;
            const secondCost = LMSR.buyCost(B, BigInt(market.qYes), BigInt(market.qNo), 'no', secondShares);
            await submitTrade(second, {
                requestId: randomUUID(), agreementAccount: MARKET_CANCEL,
                action: 'buy', side: 'no', shares: String(secondShares), maxCost: String(secondCost)
            }).expect(200);

            const ownReturn = LMSR.sellReturn(B, BigInt(market.qYes), BigInt(market.qNo), 'yes', 100_000n);
            await submitTrade(second, {
                requestId: randomUUID(), agreementAccount: MARKET_CANCEL,
                action: 'sell', side: 'yes', shares: '100000', minReturn: String(ownReturn)
            }).expect(409);
            market = await fetchMarket(MARKET_CANCEL);
            const returnA = LMSR.sellReturn(B, BigInt(market.qYes), BigInt(market.qNo), 'yes', 100_000n);
            const sellA = await submitTrade(first, {
                requestId: randomUUID(), agreementAccount: MARKET_CANCEL,
                action: 'sell', side: 'yes', shares: '100000', minReturn: String(returnA)
            }).expect(200);
            assert.equal(sellA.body.receipt.action, 'sell');
            const { rows: [afterSell] } = await pool.query(
                `SELECT seed, vault FROM consensus.points_market
                  WHERE agreement_account = $1 AND simulation_run = $2`, [MARKET_CANCEL, run]
            );
            assert.equal(afterSell.vault, String(SEED + firstCost + secondCost - returnA));
            await assertVaultCoversObligation(MARKET_CANCEL);
        });

        await t.test('concurrent large buys serialize cash and never overdraw', async () => {
            const account = await createAccount('concurrent');
            await fetchMarket(MARKET_LATE);
            const shares = 600_000_000n;
            const maxCost = String(LMSR.MAX_QUANTITY);
            const outcomes = await Promise.all([
                submitTrade(account, { requestId: randomUUID(), agreementAccount: MARKET_LATE,
                    action: 'buy', side: 'yes', shares: String(shares), maxCost }),
                submitTrade(account, { requestId: randomUUID(), agreementAccount: MARKET_LATE,
                    action: 'buy', side: 'yes', shares: String(shares), maxCost })
            ]);
            assert.deepEqual(outcomes.map(response => response.status).sort(), [200, 409]);
            const { body: own } = await request(app).get('/bets/points/account').set(account.auth)
                .query({ simulationRun: run }).expect(200);
            assert.ok(BigInt(own.balance) >= 0n);
            await assertVaultCoversObligation(MARKET_LATE);
        });

        await t.test('request retries survive source failure and JSONB key reordering without a second debit', async () => {
            const account = await createAccount('retry');
            retryAccount = account;
            const market = await fetchMarket(MARKET_YES);
            const shares = 2_000_000n;
            const cost = LMSR.buyCost(B, BigInt(market.qYes), BigInt(market.qNo), 'yes', shares);
            const trade = { requestId: randomUUID(), agreementAccount: MARKET_YES,
                action: 'buy', side: 'yes', shares: String(shares), maxCost: String(cost), simulationRun: run };
            const first = await request(app).post('/bets/points/trade').set(account.auth).send(trade).expect(200);
            const afterFirst = (await request(app).get('/bets/points/account').set(account.auth)
                .query({ simulationRun: run }).expect(200)).body.balance;
            sourceFailureFor = MARKET_YES;
            const reordered = { maxCost: trade.maxCost, shares: trade.shares, side: trade.side,
                action: trade.action, agreementAccount: trade.agreementAccount,
                simulationRun: run, requestId: trade.requestId };
            const retry = await request(app).post('/bets/points/trade').set(account.auth).send(reordered).expect(200);
            assert.equal(retry.body.receipt.id, first.body.receipt.id);
            assert.equal(retry.body.receipt.requestId, trade.requestId);
            assert.equal((await request(app).get('/bets/points/account').set(account.auth)
                .query({ simulationRun: run }).expect(200)).body.balance, afterFirst);
            await request(app).post('/bets/points/trade').set(account.auth)
                .send({ ...reordered, shares: String(shares + 1n) }).expect(409);
            sourceFailureFor = null;
            await assertVaultCoversObligation(MARKET_YES);
        });

        await t.test('stale quote rejects and void claims settle each side independently', async () => {
            const account = await createAccount('void');
            const market = await fetchMarket(MARKET_CANCEL);
            const staleCost = LMSR.buyCost(B, BigInt(market.qYes), BigInt(market.qNo), 'yes', 500_000n);
            const other = await createAccount('void-other-trader');
            const competitorBuyShares = 20_000_000n;
            const competitorMarket = await fetchMarket(MARKET_CANCEL);
            const competitorCost = LMSR.buyCost(B, BigInt(competitorMarket.qYes), BigInt(competitorMarket.qNo), 'yes', competitorBuyShares);
            await submitTrade(other, { requestId: randomUUID(), agreementAccount: MARKET_CANCEL,
                action: 'buy', side: 'yes', shares: String(competitorBuyShares), maxCost: String(competitorCost) }).expect(200);
            await submitTrade(account, { requestId: randomUUID(), agreementAccount: MARKET_CANCEL,
                action: 'buy', side: 'yes', shares: '500000', maxCost: String(staleCost) }).expect(409);

            const yesShares = 1_000_001n, noShares = 1_000_003n;
            const afterCompetitor = await fetchMarket(MARKET_CANCEL);
            const yesCost = LMSR.buyCost(B, BigInt(afterCompetitor.qYes), BigInt(afterCompetitor.qNo), 'yes', yesShares);
            await submitTrade(account, { requestId: randomUUID(), agreementAccount: MARKET_CANCEL,
                action: 'buy', side: 'yes', shares: String(yesShares), maxCost: String(yesCost) }).expect(200);
            const beforeNo = await fetchMarket(MARKET_CANCEL);
            const noCost = LMSR.buyCost(B, BigInt(beforeNo.qYes), BigInt(beforeNo.qNo), 'no', noShares);
            await submitTrade(account, { requestId: randomUUID(), agreementAccount: MARKET_CANCEL,
                action: 'buy', side: 'no', shares: String(noShares), maxCost: String(noCost) }).expect(200);

            sources.get(MARKET_CANCEL).chainStatus = 'cancelled';
            const resolve = await request(app).post('/bets/points/resolve').set(account.auth)
                .send({ requestId: randomUUID(), agreementAccount: MARKET_CANCEL, simulationRun: run }).expect(200);
            assert.equal(resolve.body.receipt.action, 'resolve');
            const yesClaim = await request(app).post('/bets/points/claim').set(account.auth)
                .send({ requestId: randomUUID(), agreementAccount: MARKET_CANCEL, simulationRun: run, side: 'yes' }).expect(200);
            const noClaim = await request(app).post('/bets/points/claim').set(account.auth)
                .send({ requestId: randomUUID(), agreementAccount: MARKET_CANCEL, simulationRun: run, side: 'no' }).expect(200);
            assert.equal(yesClaim.body.receipt.awardedAmount, String(yesShares / 2n));
            assert.equal(noClaim.body.receipt.awardedAmount, String(noShares / 2n));
            await request(app).post('/bets/points/claim').set(account.auth)
                .send({ requestId: randomUUID(), agreementAccount: MARKET_CANCEL, simulationRun: run, side: 'yes' }).expect(409);
            await assertVaultCoversObligation(MARKET_CANCEL);
        });

        await t.test('execution by deadline settles YES; execution after deadline settles NO', async () => {
            const yesAccount = await createAccount('execution-yes');
            let source = sources.get(MARKET_YES);
            let market = await fetchMarket(MARKET_YES);
            const yesShares = 3_000_000n;
            const yesCost = LMSR.buyCost(B, BigInt(market.qYes), BigInt(market.qNo), 'yes', yesShares);
            await submitTrade(yesAccount, { requestId: randomUUID(), agreementAccount: MARKET_YES,
                action: 'buy', side: 'yes', shares: String(yesShares), maxCost: String(yesCost) }).expect(200);
            clock = (source.closesAt - 1) * 1000;
            source.chainStatus = 'executed'; source.executedAt = source.closesAt - 2; source.chainTime = source.closesAt - 1;
            const yesResolution = await request(app).post('/bets/points/resolve').set(yesAccount.auth)
                .send({ requestId: randomUUID(), agreementAccount: MARKET_YES, simulationRun: run }).expect(200);
            assert.equal(yesResolution.body.receipt.outcome, 'yes');

            const lateAccount = await createAccount('execution-late');
            source = sources.get(MARKET_LATE);
            market = await fetchMarket(MARKET_LATE);
            const lateShares = 4_000_000n;
            const lateCost = LMSR.buyCost(B, BigInt(market.qYes), BigInt(market.qNo), 'yes', lateShares);
            await submitTrade(lateAccount, { requestId: randomUUID(), agreementAccount: MARKET_LATE,
                action: 'buy', side: 'yes', shares: String(lateShares), maxCost: String(lateCost) }).expect(200);
            clock = (source.closesAt + 2) * 1000;
            source.chainStatus = 'executed'; source.executedAt = source.closesAt + 1; source.chainTime = source.closesAt + 2;
            const noResolution = await request(app).post('/bets/points/resolve').set(lateAccount.auth)
                .send({ requestId: randomUUID(), agreementAccount: MARKET_LATE, simulationRun: run }).expect(200);
            assert.equal(noResolution.body.receipt.outcome, 'no');
            await assertVaultCoversObligation(MARKET_YES);
            await assertVaultCoversObligation(MARKET_LATE);
        });

        await t.test('leaderboard uses sequential LMSR sale value and public positions require explicit preview realm', async () => {
            clock = baseClock;
            const account = await createAccount('open-leaderboard');
            const market = await fetchMarket(MARKET_OPEN);
            const tradeShares = 10_000_000n;
            const cost = LMSR.buyCost(B, BigInt(market.qYes), BigInt(market.qNo), 'yes', tradeShares);
            await submitTrade(account, { requestId: randomUUID(), agreementAccount: MARKET_OPEN,
                action: 'buy', side: 'yes', shares: String(tradeShares), maxCost: String(cost) }).expect(200);
            const { body: ranking } = await request(app).get('/bets/points/leaderboard')
                .query({ simulationRun: run }).expect(200);
            const standing = ranking.leaderboard.find(item => item.account === account.id);
            assert.ok(standing);
            assert.equal(ranking.simulationRun, run);
            assert.equal(standing.positionsCount, 1);
            const { rows: [ledger] } = await pool.query(
                `SELECT a.balance, p.yes_shares, m.b, m.q_yes, m.q_no FROM consensus.points_account a
                   JOIN consensus.points_position p ON p.account_id = a.id
                   JOIN consensus.points_market m ON m.id = p.market_id
                  WHERE a.id = $1 AND m.agreement_account = $2 AND m.simulation_run = $3`, [account.id, MARKET_OPEN, run]
            );
            const shares = BigInt(ledger.yes_shares);
            const liquidation = LMSR.sellReturn(BigInt(ledger.b), BigInt(ledger.q_yes), BigInt(ledger.q_no), 'yes', shares);
            assert.equal(standing.cashBalance, String(ledger.balance));
            assert.equal(standing.equity, String(BigInt(ledger.balance) + liquidation));
            const hidden = await request(app).get('/bets/points/positions').query({ account: account.id }).expect(200);
            assert.deepEqual(hidden.body.positions, []);
            const preview = await request(app).get('/bets/points/positions')
                .query({ account: account.id, simulationRun: run });
            assert.equal(preview.status, 200, JSON.stringify(preview.body));
            assert.equal(preview.body.simulationRun, run);
            assert.ok(Array.isArray(preview.body.positions));
            assert.equal(preview.body.positions[0].agreementAccount, MARKET_OPEN);
            assert.equal(preview.body.positions[0].yes.amount, String(shares));
            await request(app).get('/bets/points/positions').query({ account: 'bad-id', simulationRun: run }).expect(400);
            const resolvedYesStanding = ranking.leaderboard.find(item => item.account === retryAccount.id);
            const retryData = (await request(app).get('/bets/points/account').set(retryAccount.auth)
                .query({ agreementAccount: MARKET_YES, simulationRun: run }).expect(200)).body;
            const winningShares = BigInt(retryData.positions[MARKET_YES].yes.amount);
            assert.equal(resolvedYesStanding.equity,
                String(BigInt(retryData.balance) + winningShares));
            const ordinary = await request(app).get('/bets/points/leaderboard').expect(200);
            assert.equal(ordinary.body.simulationRun, '');
            assert.deepEqual(ordinary.body.leaderboard, []);
        });

        await t.test('wallet proof is one-use, realm-unique, and cannot replace a linked wallet', async () => {
            const account = await createAccount('wallet');
            const pair = Keypair.generate();
            const wallet = pair.publicKey.toBase58();
            const challenge = (await request(app).post('/bets/points/wallet-challenge').set(account.auth)
                .send({ wallet, simulationRun: run }).expect(200)).body;
            const signature = sign(null, Buffer.from(challenge.message), keypairPrivateKey(pair)).toString('base64');
            await request(app).post('/bets/points/wallet-link').set(account.auth)
                .send({ wallet, nonce: challenge.nonce, signature, simulationRun: run }).expect(200);
            await request(app).post('/bets/points/wallet-link').set(account.auth)
                .send({ wallet, nonce: challenge.nonce, signature, simulationRun: run }).expect(409);
            const replacement = Keypair.generate().publicKey.toBase58();
            await request(app).post('/bets/points/wallet-challenge').set(account.auth)
                .send({ wallet: replacement, simulationRun: run }).expect(409);
            const other = await createAccount('wallet-conflict');
            await request(app).post('/bets/points/wallet-challenge').set(other.auth)
                .send({ wallet, simulationRun: run }).expect(409);
        });
    } finally {
        try {
            await pool.query(`DELETE FROM consensus.points_transaction WHERE account_id IN
                (SELECT id FROM consensus.points_account WHERE simulation_run = $1)`, [run]);
            await pool.query(`DELETE FROM consensus.points_wallet_challenge WHERE account_id IN
                (SELECT id FROM consensus.points_account WHERE simulation_run = $1)`, [run]);
            await pool.query(`DELETE FROM consensus.points_position WHERE account_id IN
                (SELECT id FROM consensus.points_account WHERE simulation_run = $1)
                OR market_id IN (SELECT id FROM consensus.points_market WHERE simulation_run = $1)`, [run]);
            await pool.query('DELETE FROM consensus.points_market WHERE simulation_run = $1', [run]);
            await pool.query('DELETE FROM consensus.points_account WHERE simulation_run = $1', [run]);
            const residue = await pool.query(
                `SELECT (SELECT count(*) FROM consensus.points_account WHERE simulation_run = $1)
                      + (SELECT count(*) FROM consensus.points_market WHERE simulation_run = $1) AS rows_left`, [run]
            );
            assert.equal(Number(residue.rows[0].rows_left), 0);
        } finally { await pool.end(); }
    }
});
