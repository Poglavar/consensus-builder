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
function createStorePool({ seed = [], failOn = null, failWith = 'db offline', syncRun = null } = {}) {
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

            if (sql.includes('FROM consensus.transaction_sync_run')) return { rows: syncRun ? [syncRun] : [] };

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
    it('reads the database and reports the durable worker status without RPC', async () => {
        const pool = createStorePool({
            seed: [X402_SIG, FUNDING_SIG, MINT_SIG],
            syncRun: {
                run_id: 'run-1', status: 'completed', started_at: new Date('2026-10-11T01:00:00Z'),
                completed_at: new Date('2026-10-11T01:01:00Z'), last_success_at: new Date('2026-10-11T01:01:00Z'),
                scanned: 3, new_signatures: 3, fetched: 3, failed: 0, error: null, error_stack: null, rpc_counts: { getSignaturesForAddress: 24 }
            }
        });
        const stub = { getSignaturesForAddress() { throw new Error('route must not access RPC'); } };

        const res = await request(createApp(stub, pool)).get('/transactions');

        expect(res.status).toBe(200);
        expect(res.body.cluster).toBe('devnet');
        expect(res.body.cached).toBe(false);
        expect(res.body.source).toBe('database');
        expect(typeof res.body.fetchedAt).toBe('string');
        expect(res.body.explorer).toEqual(EXPLORER_LINKS);
        expect(res.body.count).toBe(3);
        expect(res.body.stored).toBe(3);
        expect(res.body.sync).toMatchObject({ status: 'completed', scanned: 3, newSignatures: 3, fetched: 3, failed: 0, error: null });
        expect(res.body.sync.rpcCounts).toEqual({ getSignaturesForAddress: 24 });
        expect(res.body.sync.lastSuccessAt).toBe('2026-10-11T01:01:00.000Z');
        expect(res.body.transactions.map((tx) => tx.signature)).toEqual([X402_SIG, FUNDING_SIG, MINT_SIG]);
        expect(res.body.transactions[0].summary)
            .toBe('agent densifier-01 paid 0.05 USDC to treasury wallet (x402 settlement, fee paid by x402 facilitator)');
    });

    it('serves a populated store with no RPC regardless of legacy sync query parameters', async () => {
        const pool = createStorePool({ seed: [X402_SIG, MINT_SIG] });
        const stub = { getSignaturesForAddress() { throw new Error('route must not access RPC'); } };
        const app = createApp(stub, pool);
        for (const suffix of ['', '?sync=0', '?sync=1', '?force=true']) {
            const res = await request(app).get(`/transactions${suffix}`);
            expect(res.status).toBe(200);
            expect(res.body.source).toBe('database');
            expect(res.body.count).toBe(2);
            expect(res.body.stored).toBe(2);
        }
    });

    it('renders failed last attempt separately from the last successful sync', async () => {
        const pool = createStorePool({ seed: [X402_SIG], syncRun: {
            run_id: 'run-2', job_name: 'land-oracle', status: 'failed', started_at: new Date('2026-10-11T02:00:00Z'),
            completed_at: new Date('2026-10-11T02:01:00Z'), last_success_at: new Date('2026-10-11T01:01:00Z'),
            scanned: 0, new_signatures: 0, fetched: 0, failed: 0, error: '429 rate limited',
            error_stack: 'PRIVATE_STACK_SENTINEL_INTERNAL_ONLY', rpc_counts: { getSignaturesForAddress: 4 }
        } });
        const stub = { getSignaturesForAddress() { throw new Error('route must not access RPC'); } };
        const app = createApp(stub, pool);
        const res = await request(app).get('/transactions');
        expect(res.body.sync.status).toBe('failed');
        expect(res.body.sync.jobName).toBe('land-oracle');
        expect(res.body.sync.error).toBe('429 rate limited');
        expect(res.body.sync).toMatchObject({ scanned: 0, newSignatures: 0, fetched: 0, failed: 0, rpcCounts: { getSignaturesForAddress: 4 } });
        expect(res.body.sync).not.toHaveProperty('errorStack');
        expect(res.text).not.toContain('PRIVATE_STACK_SENTINEL_INTERNAL_ONLY');
        expect(res.body.sync.at).toBe('2026-10-11T02:01:00.000Z');
        expect(res.body.sync.lastSuccessAt).toBe('2026-10-11T01:01:00.000Z');
        const syncStatusSql = pool.calls.find(call => call.sql.includes('FROM consensus.transaction_sync_run')).sql;
        expect(syncStatusSql).toContain("job_name IN ('transaction-sync', 'land-oracle')");
        expect(syncStatusSql).toContain('AND dry_run = FALSE');
        expect(syncStatusSql.match(/AND dry_run = FALSE/g)).toHaveLength(2);
    });

    it('defaults the limit to 25 and caps it at 200', async () => {
        const pool = createStorePool({ seed: [X402_SIG] });
        const app = createApp(createConnectionStub(), pool);

        const limitParam = () => pool.calls.filter(call => call.sql.includes('FROM consensus.solana_transaction') && call.sql.includes('LIMIT')).at(-1)?.params.at(-1);

        await request(app).get('/transactions?sync=0');
        expect(limitParam()).toBe(25);

        await request(app).get('/transactions?sync=0&limit=5');
        expect(limitParam()).toBe(5);

        await request(app).get('/transactions?sync=0&limit=5000');
        expect(limitParam()).toBe(200);

        await request(app).get('/transactions?sync=0&limit=not-a-number');
        expect(limitParam()).toBe(25);
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

    it('serves the database snapshot even when an injected RPC stub would throw', async () => {
        const pool = createStorePool({ seed: [X402_SIG, MINT_SIG] });
        const stub = { getSignaturesForAddress() { throw new Error('no RPC is permitted'); } };

        const res = await request(createApp(stub, pool)).get('/transactions');

        expect(res.status).toBe(200);
        expect(res.body.count).toBe(2);
        expect(res.body.source).toBe('database');
        expect(res.body.sync).toBeNull();
        expect(res.body.transactions[0].summary)
            .toBe('agent densifier-01 paid 0.05 USDC to treasury wallet (x402 settlement, fee paid by x402 facilitator)');
    });

    it('answers 502 only when the store itself is unreachable', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => { });
        const pool = createStorePool({ failOn: 'ORDER BY block_time DESC', failWith: 'connection terminated' });

        const res = await request(createApp(createConnectionStub(), pool)).get('/transactions?sync=0');

        expect(res.status).toBe(502);
        expect(res.body.error).toBe('Transaction store unavailable: connection terminated');
    });

    it('answers 502 when durable sync status cannot be read', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => { });
        const pool = createStorePool({ failOn: 'FROM consensus.transaction_sync_run', failWith: 'relation does not exist' });
        const stub = { getSignaturesForAddress() { throw new Error('no RPC is permitted'); } };

        const res = await request(createApp(stub, pool)).get('/transactions');

        expect(res.status).toBe(502);
        expect(res.body.error).toBe('Transaction store unavailable: relation does not exist');
    });
});

describe('POST /transactions/sync', () => {
    it('remains a DB-only refresh for old clients', async () => {
        const pool = createStorePool({ seed: [X402_SIG] });
        const stub = { getSignaturesForAddress() { throw new Error('old POST must not access RPC'); } };
        const app = createApp(stub, pool);

        const res = await request(app).post('/transactions/sync');

        expect(res.status).toBe(200);
        expect(res.body.cluster).toBe('devnet');
        expect(res.body.stored).toBe(1);
        expect(res.body.sync).toBeNull();
        expect(res.body.source).toBe('database');
    });

    it('does not force a worker run when the old refresh request is repeated', async () => {
        const pool = createStorePool({ seed: [X402_SIG] });
        const stub = { getSignaturesForAddress() { throw new Error('old POST must not access RPC'); } };
        const app = createApp(stub, pool);

        const first = await request(app).post('/transactions/sync');
        const second = await request(app).post('/transactions/sync');
        expect(first.body.stored).toBe(second.body.stored);
        expect(first.body.sync).toEqual(second.body.sync);
    });

    it('reports the durable failed worker outcome without attempting RPC', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => { });
        const pool = createStorePool({ seed: [X402_SIG], syncRun: {
            run_id: 'failed-run', status: 'failed', started_at: new Date('2026-10-11T02:00:00Z'),
            completed_at: new Date('2026-10-11T02:01:00Z'), last_success_at: null,
            scanned: 0, new_signatures: 0, fetched: 0, failed: 0, error: '429 Too Many Requests',
            error_stack: 'PRIVATE_STACK_SENTINEL_INTERNAL_ONLY', rpc_counts: { getSignaturesForAddress: 1 }
        } });
        const stub = { getSignaturesForAddress() { throw new Error('route must not access RPC'); } };

        const res = await request(createApp(stub, pool)).post('/transactions/sync');

        expect(res.status).toBe(200);
        expect(res.body.sync.error).toContain('429');
        expect(res.body.sync).toMatchObject({ scanned: 0, newSignatures: 0, fetched: 0, failed: 0, rpcCounts: { getSignaturesForAddress: 1 } });
        expect(res.body.sync).not.toHaveProperty('errorStack');
        expect(res.text).not.toContain('PRIVATE_STACK_SENTINEL_INTERNAL_ONLY');
        expect(res.body.stored).toBe(1);
    });

    it('answers 502 when the store is unreachable', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => { });
        const pool = createStorePool({ failOn: 'FROM consensus.transaction_sync_run', failWith: 'db offline' });
        const stub = { getSignaturesForAddress() { throw new Error('route must not access RPC'); } };

        const res = await request(createApp(stub, pool)).post('/transactions/sync');

        expect(res.status).toBe(502);
        expect(res.body.error).toBe('Transaction store unavailable: db offline');
    });
});
