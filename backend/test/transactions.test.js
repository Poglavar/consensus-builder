import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { setupTransactionsRoute, EXPLORER_LINKS, withRpcRetry, isRateLimited } from '../routes/transactions.js';
import { createRouteApp } from './helpers/create-route-app.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'solana-tx');

const TREASURY = 'AMbsiP9F8YY2y8n9uFdqtw7yNZZHvTWFEWSQGHKtmkoQ';
const TREASURY_USDC = '3kch82dBbEGMJhwjoT6X6xFuyfQLP7o8c6WTnA7Svpz9';
const PERSONA_WALLET = 'G4R6RCCcQHN9fLoExvTBBfhbw8BgvTEqhJezG3A1HvEg';
const FACILITATOR = 'CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5';
const ENV = { X402_PAY_TO: TREASURY };

const X402_SIG = '3qzwHhFzEMzVNjCpsePnVwRM2NUdNNqjggoSrWrGSviqCnSxBtaYfiJDWZrEvpjfcyvf5zCumeKXRMmCvG6DHsds';
const FUNDING_SIG = '5fdwbtLu4Nbt7kFy9AsPH4MWFBfnfHsiupHCKZzSQKfANC3GsBtp9TXEpTtCgQWfAHq2BgsXAdnFjzFQwDNx4Kwx';
const MINT_SIG = 'PUM8MJprjBMGbG3JyLfppGScpVRYPRLPqzfNU1DYpL7HhV7NRFv7Znk2G2S7hUK9o6GHLyoTYs2TURCsnWmHHAR';

function fixtureResult(name) {
    return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, `${name}.json`), 'utf8')).result;
}

const FIXTURES = {
    [X402_SIG]: fixtureResult('x402-settlement-transfer-checked'),
    [FUNDING_SIG]: fixtureResult('usdc-funding-create-ata-transfer'),
    [MINT_SIG]: fixtureResult('proposal-nft-mint-and-fund')
};

/**
 * In-memory stand-in for consensus.solana_transaction, driven by the SQL the store issues — same
 * spirit as test/helpers/mock-pool.js, but it has to answer four different statements.
 * `seed` pre-populates the table so a route can be tested without a successful sync.
 */
function createStorePool({ seed = [], failOn = null, failWith = 'db offline' } = {}) {
    const calls = [];
    const rows = new Map();
    const insert = (signature, extra = {}) => {
        const raw = FIXTURES[signature];
        rows.set(signature, {
            signature,
            slot: raw.slot,
            block_time: raw.blockTime,
            raw,
            touched_addresses: extra.touched ?? touchedOf(raw),
            ...extra
        });
    };
    for (const signature of seed) insert(signature);

    return {
        calls,
        rows,
        async query(sql, params) {
            calls.push({ sql, params });
            if (failOn && sql.includes(failOn)) throw new Error(failWith);

            if (sql.includes('WHERE signature = ANY($1)')) {
                return { rows: (params[0] || []).filter((signature) => rows.has(signature)).map((signature) => ({ signature })) };
            }
            if (/^\s*INSERT INTO/i.test(sql)) {
                for (let i = 0; i < params.length; i += 7) {
                    const signature = params[i];
                    if (rows.has(signature)) continue;
                    rows.set(signature, {
                        signature,
                        slot: params[i + 1],
                        block_time: params[i + 2],
                        raw: JSON.parse(params[i + 4]),
                        touched_addresses: params[i + 5]
                    });
                }
                return { rows: [], rowCount: params.length / 7 };
            }
            if (/count\(\*\)/i.test(sql)) return { rows: [{ total: rows.size }] };
            if (sql.includes('ORDER BY block_time DESC')) {
                const address = params.length === 3 ? params[1] : null;
                const limit = params.at(-1);
                const list = [...rows.values()]
                    .filter((row) => !address || (row.touched_addresses || []).includes(address))
                    .sort((a, b) => (b.block_time ?? -Infinity) - (a.block_time ?? -Infinity) || (b.slot ?? 0) - (a.slot ?? 0))
                    .slice(0, limit);
                return { rows: list.map(({ signature, slot, block_time, raw }) => ({ signature, slot, block_time, raw })) };
            }
            return { rows: [] };
        }
    };
}

function touchedOf(raw) {
    const keys = (raw.transaction.message.accountKeys || []).map((key) => key.pubkey);
    const owners = [...(raw.meta.preTokenBalances || []), ...(raw.meta.postTokenBalances || [])].map((balance) => balance.owner);
    return [...new Set([...keys, ...owners].filter(Boolean))];
}

function createConnectionStub({ signaturesByAddress = {}, failSignatures = null, failParsed = null } = {}) {
    const calls = { signatures: [], parsedBatches: [] };
    return {
        calls,
        async getSignaturesForAddress(pubkey, options) {
            const address = pubkey.toBase58();
            calls.signatures.push({ address, options });
            if (failSignatures) throw new Error(failSignatures);
            return (signaturesByAddress[address] || []).map((signature) => ({
                signature,
                slot: FIXTURES[signature].slot,
                blockTime: FIXTURES[signature].blockTime,
                err: null
            }));
        },
        async getParsedTransactions(signatures, options) {
            calls.parsedBatches.push({ signatures, options });
            if (failParsed) throw new Error(failParsed);
            return signatures.map((signature) => FIXTURES[signature] ?? null);
        }
    };
}

// No retry delays and no chunk spacing in tests: a stubbed rate limit must fail fast.
function createApp(stub, pool, env = ENV, options = {}) {
    return createRouteApp(setupTransactionsRoute, pool, {
        env,
        connection: stub,
        rpcRetryDelays: [],
        chunkSpacingMs: 0,
        ...options
    });
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('GET /transactions/watched', () => {
    it('returns the watched address book without touching the rpc or the store', async () => {
        const stub = createConnectionStub();
        const pool = createStorePool();
        const res = await request(createApp(stub, pool)).get('/transactions/watched');

        expect(res.status).toBe(200);
        expect(res.body.cluster).toBe('devnet');
        expect(res.body.explorer).toEqual(EXPLORER_LINKS);
        expect(res.body).not.toHaveProperty('transactions');
        expect(stub.calls.signatures).toHaveLength(0);
        expect(pool.calls).toHaveLength(0);

        const labels = Object.fromEntries(res.body.watched.map((entry) => [entry.address, entry]));
        expect(labels[TREASURY]).toEqual({ address: TREASURY, label: 'treasury wallet', kind: 'wallet' });
        expect(labels[FACILITATOR].label).toBe('x402 facilitator (fee payer)');
        expect(labels[PERSONA_WALLET].label).toBe('agent densifier-01');
        expect(res.body.watched.map((entry) => entry.address)).not.toContain('11111111111111111111111111111111');
    });

    it('serves explorer templates for both explorers', () => {
        expect(EXPLORER_LINKS).toEqual({
            tx: 'https://explorer.solana.com/tx/{sig}?cluster=devnet',
            address: 'https://explorer.solana.com/address/{addr}?cluster=devnet',
            solscanTx: 'https://solscan.io/tx/{sig}?cluster=devnet',
            solscanAddress: 'https://solscan.io/account/{addr}?cluster=devnet'
        });
    });

    it('re-exports the rate-limit helpers the store defines', () => {
        expect(isRateLimited(new Error('Too many requests for a specific RPC call'))).toBe(true);
        expect(typeof withRpcRetry).toBe('function');
    });
});

describe('GET /transactions', () => {
    it('syncs, then serves the store newest first with the full contract', async () => {
        const pool = createStorePool();
        const stub = createConnectionStub({
            signaturesByAddress: { [TREASURY]: [FUNDING_SIG, MINT_SIG], [TREASURY_USDC]: [X402_SIG] }
        });

        const res = await request(createApp(stub, pool)).get('/transactions');

        expect(res.status).toBe(200);
        expect(res.body.cluster).toBe('devnet');
        expect(res.body.cached).toBe(false);
        expect(typeof res.body.fetchedAt).toBe('string');
        expect(res.body.explorer).toEqual(EXPLORER_LINKS);
        expect(res.body.count).toBe(3);
        expect(res.body.stored).toBe(3);
        expect(res.body.sync).toMatchObject({ scanned: 3, newSignatures: 3, fetched: 3, failed: 0, error: null });
        expect(typeof res.body.sync.at).toBe('string');
        expect(res.body.transactions.map((tx) => tx.signature)).toEqual([X402_SIG, FUNDING_SIG, MINT_SIG]);
        expect(res.body.transactions[0].summary)
            .toBe('agent densifier-01 paid 0.05 USDC to treasury wallet (x402 settlement, fee paid by x402 facilitator)');
    });

    it('serves a populated store with no rpc call at all when sync=0', async () => {
        const pool = createStorePool({ seed: [X402_SIG, MINT_SIG] });
        const stub = createConnectionStub({ signaturesByAddress: { [TREASURY]: [FUNDING_SIG] } });

        const res = await request(createApp(stub, pool)).get('/transactions?sync=0');

        expect(res.status).toBe(200);
        expect(stub.calls.signatures).toHaveLength(0);
        expect(stub.calls.parsedBatches).toHaveLength(0);
        expect(res.body.cached).toBe(true);
        expect(res.body.count).toBe(2);
        expect(res.body.stored).toBe(2);
        expect(res.body.sync).toEqual({ at: null, scanned: 0, newSignatures: 0, fetched: 0, failed: 0, error: null });
    });

    it('gates the sync on a thirty second TTL, but always reads the store fresh', async () => {
        vi.useFakeTimers();
        const pool = createStorePool();
        const stub = createConnectionStub({ signaturesByAddress: { [TREASURY]: [X402_SIG] } });
        const app = createApp(stub, pool);

        const first = await request(app).get('/transactions');
        expect(first.body.cached).toBe(false);
        const scansAfterFirst = stub.calls.signatures.length;

        // A second row appears on chain, but inside the TTL the sync does not run.
        stub.calls.signatures.length = 0;
        const second = await request(app).get('/transactions');
        expect(second.body.cached).toBe(true);
        expect(stub.calls.signatures).toHaveLength(0);
        expect(second.body.sync.at).toBe(first.body.sync.at);

        vi.setSystemTime(Date.now() + 31_000);
        const third = await request(app).get('/transactions');
        expect(third.body.cached).toBe(false);
        expect(stub.calls.signatures).toHaveLength(scansAfterFirst);
    });

    it('does not refetch a signature the store already holds', async () => {
        const pool = createStorePool({ seed: [X402_SIG] });
        const stub = createConnectionStub({ signaturesByAddress: { [TREASURY]: [X402_SIG, MINT_SIG] } });

        const res = await request(createApp(stub, pool)).get('/transactions');

        expect(stub.calls.parsedBatches).toHaveLength(1);
        expect(stub.calls.parsedBatches[0].signatures).toEqual([MINT_SIG]);
        expect(res.body.sync).toMatchObject({ scanned: 2, newSignatures: 1, fetched: 1 });
        expect(res.body.stored).toBe(2);
    });

    it('makes no getParsedTransactions call when the store is already complete', async () => {
        const pool = createStorePool({ seed: [X402_SIG, MINT_SIG] });
        const stub = createConnectionStub({ signaturesByAddress: { [TREASURY]: [X402_SIG, MINT_SIG] } });

        const res = await request(createApp(stub, pool)).get('/transactions');

        expect(stub.calls.parsedBatches).toHaveLength(0);
        expect(res.body.sync).toMatchObject({ newSignatures: 0, fetched: 0 });
        expect(res.body.count).toBe(2);
    });

    it('defaults the limit to 25 and caps it at 200', async () => {
        const pool = createStorePool({ seed: [X402_SIG] });
        const app = createApp(createConnectionStub(), pool);

        await request(app).get('/transactions?sync=0');
        expect(pool.calls.at(-2).params.at(-1)).toBe(25);

        await request(app).get('/transactions?sync=0&limit=5');
        expect(pool.calls.at(-2).params.at(-1)).toBe(5);

        await request(app).get('/transactions?sync=0&limit=5000');
        expect(pool.calls.at(-2).params.at(-1)).toBe(200);

        await request(app).get('/transactions?sync=0&limit=not-a-number');
        expect(pool.calls.at(-2).params.at(-1)).toBe(25);
    });

    it('applies the limit to the store read', async () => {
        const pool = createStorePool({ seed: [X402_SIG, FUNDING_SIG, MINT_SIG] });

        const res = await request(createApp(createConnectionStub(), pool)).get('/transactions?sync=0&limit=1');

        expect(res.body.count).toBe(1);
        expect(res.body.stored).toBe(3);
        expect(res.body.transactions[0].signature).toBe(X402_SIG);
    });

    it('filters in SQL on touched_addresses', async () => {
        const pool = createStorePool({ seed: [X402_SIG, FUNDING_SIG, MINT_SIG] });

        const res = await request(createApp(createConnectionStub(), pool))
            .get('/transactions?sync=0&address=6NPKGcQQ6yDzFLyPejeegsjrArHDQcAkHGvX8runxkjB');

        const read = pool.calls.find((call) => call.sql.includes('ORDER BY block_time DESC'));
        expect(read.sql).toContain('= ANY(touched_addresses)');
        expect(res.body.count).toBe(1);
        expect(res.body.transactions[0].signature).toBe(MINT_SIG);
        expect(res.body.stored).toBe(3);
    });

    it('finds a wallet that only appears as a token-account owner', async () => {
        const pool = createStorePool({ seed: [X402_SIG] });

        const res = await request(createApp(createConnectionStub(), pool)).get(`/transactions?sync=0&address=${TREASURY}`);

        expect(res.body.count).toBe(1);
        expect(res.body.transactions[0].signature).toBe(X402_SIG);
    });

    it('returns nothing when the filter address touches no stored transaction', async () => {
        const pool = createStorePool({ seed: [MINT_SIG] });

        const res = await request(createApp(createConnectionStub(), pool))
            .get('/transactions?sync=0&address=9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');

        expect(res.body.count).toBe(0);
        expect(res.body.transactions).toEqual([]);
    });

    it('still serves the store with 200 and sync.error when the rpc is rate limited', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => { });
        const pool = createStorePool({ seed: [X402_SIG, MINT_SIG] });
        const stub = createConnectionStub({ failSignatures: 'Too many requests for a specific RPC call' });

        const res = await request(createApp(stub, pool)).get('/transactions');

        expect(res.status).toBe(200);
        expect(res.body.count).toBe(2);
        expect(res.body.sync.error).toContain('Too many requests');
        expect(res.body.transactions[0].summary)
            .toBe('agent densifier-01 paid 0.05 USDC to treasury wallet (x402 settlement, fee paid by x402 facilitator)');
    });

    it('keeps the transactions a partially rate-limited sync managed to store', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => { });
        const pool = createStorePool();
        const stub = createConnectionStub({
            signaturesByAddress: { [TREASURY]: [X402_SIG, FUNDING_SIG, MINT_SIG] }
        });
        let batches = 0;
        const inner = stub.getParsedTransactions.bind(stub);
        stub.getParsedTransactions = async (signatures, options) => {
            batches += 1;
            if (batches > 1) throw new Error('Too many requests for a specific RPC call');
            return inner(signatures.slice(0, 2), options);
        };

        const res = await request(createApp(stub, pool, ENV, { syncTtlMs: 0 })).get('/transactions');

        expect(res.status).toBe(200);
        expect(res.body.stored).toBeGreaterThan(0);
        expect(res.body.sync.fetched).toBeGreaterThan(0);
    });

    it('answers 502 only when the store itself is unreachable', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => { });
        const pool = createStorePool({ failOn: 'ORDER BY block_time DESC', failWith: 'connection terminated' });

        const res = await request(createApp(createConnectionStub(), pool)).get('/transactions?sync=0');

        expect(res.status).toBe(502);
        expect(res.body.error).toBe('Transaction store unavailable: connection terminated');
    });

    it('answers 502 when the missing-signature lookup cannot reach the store', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => { });
        const pool = createStorePool({ failOn: 'WHERE signature = ANY($1)', failWith: 'relation does not exist' });
        const stub = createConnectionStub({ signaturesByAddress: { [TREASURY]: [X402_SIG] } });

        const res = await request(createApp(stub, pool)).get('/transactions');

        expect(res.status).toBe(502);
        expect(res.body.error).toBe('Transaction store unavailable: relation does not exist');
    });
});

describe('POST /transactions/sync', () => {
    it('syncs immediately, ignoring the TTL', async () => {
        const pool = createStorePool();
        const stub = createConnectionStub({ signaturesByAddress: { [TREASURY]: [X402_SIG] } });
        const app = createApp(stub, pool);

        await request(app).get('/transactions');
        const scansAfterGet = stub.calls.signatures.length;

        const res = await request(app).post('/transactions/sync');

        expect(res.status).toBe(200);
        expect(res.body.cluster).toBe('devnet');
        expect(res.body.stored).toBe(1);
        expect(res.body.sync).toMatchObject({ scanned: 1, newSignatures: 0, fetched: 0, failed: 0, error: null });
        expect(stub.calls.signatures.length).toBe(scansAfterGet * 2);
    });

    it('picks up a transaction that appeared inside the TTL window', async () => {
        const pool = createStorePool();
        const signatures = { [TREASURY]: [X402_SIG] };
        const stub = createConnectionStub({ signaturesByAddress: signatures });
        const app = createApp(stub, pool);

        await request(app).get('/transactions');
        signatures[TREASURY] = [X402_SIG, MINT_SIG];

        const forced = await request(app).post('/transactions/sync');
        expect(forced.body.sync).toMatchObject({ newSignatures: 1, fetched: 1 });

        const page = await request(app).get('/transactions?sync=0');
        expect(page.body.count).toBe(2);
    });

    it('reports a rate limit in sync.error instead of failing the request', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => { });
        const pool = createStorePool({ seed: [X402_SIG] });
        const stub = createConnectionStub({ failSignatures: '429 Too Many Requests' });

        const res = await request(createApp(stub, pool)).post('/transactions/sync');

        expect(res.status).toBe(200);
        expect(res.body.sync.error).toContain('429');
        expect(res.body.stored).toBe(1);
    });

    it('answers 502 when the store is unreachable', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => { });
        const pool = createStorePool({ failOn: 'WHERE signature = ANY($1)', failWith: 'db offline' });
        const stub = createConnectionStub({ signaturesByAddress: { [TREASURY]: [X402_SIG] } });

        const res = await request(createApp(stub, pool)).post('/transactions/sync');

        expect(res.status).toBe(502);
        expect(res.body.error).toBe('Transaction store unavailable: db offline');
    });
});
