import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import {
    syncTransactions,
    findMissingSignatures,
    storeTransactions,
    readTransactions,
    countTransactions,
    extractTouchedAddresses,
    chunk,
    isRateLimited,
    withRpcRetry,
    TRANSACTION_TABLE,
    FETCH_CHUNK_SIZE
} from '../solana/tx-store.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'solana-tx');
const DDL = fs.readFileSync(path.join(__dirname, '..', 'routes', 'transactions-ddl.sql'), 'utf8');

const TREASURY = 'AMbsiP9F8YY2y8n9uFdqtw7yNZZHvTWFEWSQGHKtmkoQ';
const TREASURY_USDC = '3kch82dBbEGMJhwjoT6X6xFuyfQLP7o8c6WTnA7Svpz9';
const PERSONA_WALLET = 'G4R6RCCcQHN9fLoExvTBBfhbw8BgvTEqhJezG3A1HvEg';
const PERSONA_USDC = '8VZjdVctk5LuyH7uSgmhKiyeW7S11UWrcZsQneTG3SW5';
const FACILITATOR = 'CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5';

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
 * Stub pool in the shape of test/helpers/mock-pool.js, but answering by SQL: the sync issues a
 * SELECT for the known signatures and an INSERT per chunk, and the tests need to drive both.
 */
function createStorePool({ known = [], failOn = null, failWith = 'db offline' } = {}) {
    const calls = [];
    const stored = [];
    return {
        calls,
        stored,
        async query(sql, params) {
            calls.push({ sql, params });
            if (failOn && sql.includes(failOn)) throw new Error(failWith);
            if (sql.includes('WHERE signature = ANY($1)')) {
                return { rows: (params[0] || []).filter((signature) => known.includes(signature)).map((signature) => ({ signature })), rowCount: 0 };
            }
            if (/^\s*INSERT INTO/i.test(sql)) {
                for (let i = 0; i < params.length; i += 7) {
                    stored.push({
                        signature: params[i],
                        slot: params[i + 1],
                        blockTime: params[i + 2],
                        cluster: params[i + 3],
                        raw: JSON.parse(params[i + 4]),
                        touchedAddresses: params[i + 5],
                        firstSeenWatched: params[i + 6]
                    });
                    known.push(params[i]);
                }
                return { rows: [], rowCount: params.length / 7 };
            }
            if (/count\(\*\)/i.test(sql)) return { rows: [{ total: stored.length }], rowCount: 1 };
            if (/FROM consensus\.solana_transaction/i.test(sql)) {
                return { rows: stored.map((row) => ({ signature: row.signature, slot: row.slot, block_time: row.blockTime, raw: row.raw })), rowCount: stored.length };
            }
            return { rows: [], rowCount: 0 };
        }
    };
}

function createConnectionStub({ signaturesByAddress = {}, failParsedAfter = null, failSignatures = null } = {}) {
    const calls = { signatures: [], parsedBatches: [] };
    return {
        calls,
        async getSignaturesForAddress(pubkey, options) {
            const address = pubkey.toBase58();
            calls.signatures.push({ address, options });
            if (failSignatures) throw new Error(failSignatures);
            return (signaturesByAddress[address] || []).map((signature) => ({
                signature,
                slot: FIXTURES[signature]?.slot ?? 1,
                blockTime: FIXTURES[signature]?.blockTime ?? 1,
                err: null
            }));
        },
        async getParsedTransactions(signatures, options) {
            calls.parsedBatches.push({ signatures, options });
            if (failParsedAfter !== null && calls.parsedBatches.length > failParsedAfter) {
                throw new Error('Too many requests for a specific RPC call');
            }
            return signatures.map((signature) => FIXTURES[signature] ?? null);
        }
    };
}

const syncOptions = { cluster: 'devnet', retryDelays: [], chunkSpacingMs: 0 };

describe('transactions-ddl.sql', () => {
    it('declares the table, both indexes and the geo_user ownership guard', () => {
        expect(DDL).toMatch(/CREATE TABLE IF NOT EXISTS consensus\.solana_transaction/i);
        for (const column of ['signature TEXT PRIMARY KEY', 'slot BIGINT', 'block_time BIGINT', 'cluster TEXT NOT NULL', 'raw JSONB NOT NULL', 'touched_addresses TEXT\\[\\]', 'first_seen_watched TEXT\\[\\]', 'created_at TIMESTAMPTZ', 'updated_at TIMESTAMPTZ']) {
            expect(DDL).toMatch(new RegExp(column, 'i'));
        }
        expect(DDL).toMatch(/CREATE INDEX IF NOT EXISTS \w+\s+ON consensus\.solana_transaction \(block_time DESC, slot DESC\)/i);
        expect(DDL).toMatch(/USING GIN \(touched_addresses\)/i);
        expect(DDL).toMatch(/rolname = 'geo_user'/);
        expect(DDL).toMatch(/OWNER TO geo_user/);
    });

    it('names the table the store writes to', () => {
        expect(TRANSACTION_TABLE).toBe('consensus.solana_transaction');
    });
});

describe('extractTouchedAddresses', () => {
    it('collects every account key', () => {
        const touched = extractTouchedAddresses(FIXTURES[MINT_SIG]);

        expect(touched).toContain('8ErKUqcQR3bvuZx2Rt9ke7u38vQBwPPSXWrXJD8YUPyw');
        expect(touched).toContain('6NPKGcQQ6yDzFLyPejeegsjrArHDQcAkHGvX8runxkjB');
        expect(touched).toContain('3WsVS6LkLo4ySLaLvxKdwuD37fcCjE2Yu9fVh1nMfxbg');
        expect(touched).toEqual([...touched].sort());
    });

    it('includes token-balance owners, which are not account keys', () => {
        const touched = extractTouchedAddresses(FIXTURES[X402_SIG]);

        // The agent's wallet IS an account key here (it signs), but the treasury only appears as
        // the owner behind its token account — without preTokenBalances the filter would miss it.
        expect(FIXTURES[X402_SIG].transaction.message.accountKeys.map((key) => key.pubkey)).not.toContain(TREASURY);
        expect(touched).toContain(TREASURY);
        expect(touched).toContain(TREASURY_USDC);
        expect(touched).toContain(PERSONA_WALLET);
        expect(touched).toContain(PERSONA_USDC);
        expect(touched).toContain(FACILITATOR);
    });

    it('deduplicates and survives a transaction with no balances', () => {
        expect(extractTouchedAddresses({ transaction: { message: { accountKeys: [{ pubkey: TREASURY }, { pubkey: TREASURY }] } } }))
            .toEqual([TREASURY]);
        expect(extractTouchedAddresses(null)).toEqual([]);
    });

    it('accepts PublicKey objects as well as base58 strings', () => {
        const touched = extractTouchedAddresses({
            transaction: { message: { accountKeys: [{ pubkey: new PublicKey(TREASURY) }] } },
            meta: { postTokenBalances: [{ owner: PERSONA_WALLET }] }
        });

        expect(touched).toEqual([TREASURY, PERSONA_WALLET].sort());
    });
});

describe('chunk / rate-limit helpers', () => {
    it('splits into fixed size groups', () => {
        expect(chunk([1, 2, 3, 4, 5, 6, 7], 5)).toEqual([[1, 2, 3, 4, 5], [6, 7]]);
        expect(chunk([], 5)).toEqual([]);
        expect(FETCH_CHUNK_SIZE).toBe(5);
    });

    it('recognises the devnet rate-limit message', () => {
        expect(isRateLimited(new Error('failed to get transactions: Too many requests for a specific RPC call'))).toBe(true);
        expect(isRateLimited(new Error('429'))).toBe(true);
        expect(isRateLimited(new Error('connection refused'))).toBe(false);
    });

    it('retries a rate limit and rethrows anything else', async () => {
        let attempts = 0;
        const value = await withRpcRetry(async () => {
            attempts += 1;
            if (attempts < 3) throw new Error('Too many requests for a specific RPC call');
            return 'ok';
        }, [0, 0, 0]);
        expect(value).toBe('ok');
        expect(attempts).toBe(3);

        await expect(withRpcRetry(async () => { throw new Error('connection refused'); }, [0])).rejects.toThrow('connection refused');
    });
});

describe('findMissingSignatures', () => {
    it('asks the store once and returns the set difference in order', async () => {
        const pool = createStorePool({ known: [FUNDING_SIG] });

        const missing = await findMissingSignatures(pool, [X402_SIG, FUNDING_SIG, MINT_SIG]);

        expect(missing).toEqual([X402_SIG, MINT_SIG]);
        expect(pool.calls).toHaveLength(1);
        expect(pool.calls[0].sql).toContain('WHERE signature = ANY($1)');
        expect(pool.calls[0].params).toEqual([[X402_SIG, FUNDING_SIG, MINT_SIG]]);
    });

    it('does not query at all for an empty list', async () => {
        const pool = createStorePool();
        expect(await findMissingSignatures(pool, [])).toEqual([]);
        expect(pool.calls).toHaveLength(0);
    });
});

describe('storeTransactions', () => {
    it('inserts a batch in one statement and never overwrites an existing row', async () => {
        const pool = createStorePool();

        const written = await storeTransactions(pool, [
            { signature: X402_SIG, slot: 1, blockTime: 2, raw: FIXTURES[X402_SIG], touchedAddresses: [TREASURY], firstSeenWatched: [TREASURY] },
            { signature: MINT_SIG, slot: 3, blockTime: 4, raw: FIXTURES[MINT_SIG], touchedAddresses: [PERSONA_WALLET], firstSeenWatched: [] }
        ]);

        expect(written).toBe(2);
        expect(pool.calls).toHaveLength(1);
        expect(pool.calls[0].sql).toContain('ON CONFLICT (signature) DO NOTHING');
        expect(pool.calls[0].sql).toContain('consensus.solana_transaction');
        expect(pool.calls[0].params).toHaveLength(14);
        expect(pool.stored[0].raw).toEqual(FIXTURES[X402_SIG]);
        expect(pool.stored[0].cluster).toBe('devnet');
    });

    it('writes nothing and issues no query for an empty batch', async () => {
        const pool = createStorePool();
        expect(await storeTransactions(pool, [])).toBe(0);
        expect(pool.calls).toHaveLength(0);
    });
});

describe('readTransactions', () => {
    it('orders newest first and pushes null block times last', async () => {
        const pool = createStorePool();
        await readTransactions(pool, { limit: 7 });

        expect(pool.calls[0].sql).toContain('ORDER BY block_time DESC NULLS LAST, slot DESC');
        expect(pool.calls[0].sql).toContain('LIMIT $2');
        expect(pool.calls[0].params).toEqual(['devnet', 7]);
    });

    it('filters on touched_addresses when an address is given', async () => {
        const pool = createStorePool();
        await readTransactions(pool, { limit: 5, address: PERSONA_WALLET });

        expect(pool.calls[0].sql).toContain('$2 = ANY(touched_addresses)');
        expect(pool.calls[0].params).toEqual(['devnet', PERSONA_WALLET, 5]);
    });
});

describe('syncTransactions', () => {
    it('stores only the signatures the table has never seen', async () => {
        const pool = createStorePool({ known: [FUNDING_SIG] });
        const connection = createConnectionStub({
            signaturesByAddress: { [TREASURY]: [FUNDING_SIG, MINT_SIG], [TREASURY_USDC]: [X402_SIG] }
        });

        const result = await syncTransactions({ pool, connection, watched: [TREASURY, TREASURY_USDC], ...syncOptions });

        expect(result).toEqual({ scanned: 3, newSignatures: 2, fetched: 2, failed: 0, error: null });
        expect(connection.calls.parsedBatches).toHaveLength(1);
        expect(connection.calls.parsedBatches[0].signatures.sort()).toEqual([MINT_SIG, X402_SIG].sort());
        expect(pool.stored.map((row) => row.signature).sort()).toEqual([MINT_SIG, X402_SIG].sort());
    });

    it('makes zero getParsedTransactions calls when nothing is new', async () => {
        const pool = createStorePool({ known: [X402_SIG, MINT_SIG] });
        const connection = createConnectionStub({ signaturesByAddress: { [TREASURY]: [X402_SIG, MINT_SIG] } });

        const result = await syncTransactions({ pool, connection, watched: [TREASURY], ...syncOptions });

        expect(result).toEqual({ scanned: 2, newSignatures: 0, fetched: 0, failed: 0, error: null });
        expect(connection.calls.parsedBatches).toHaveLength(0);
        expect(pool.stored).toEqual([]);
    });

    it('is idempotent: a second sync over the same chain state fetches nothing', async () => {
        const pool = createStorePool();
        const connection = createConnectionStub({ signaturesByAddress: { [TREASURY]: [X402_SIG, MINT_SIG] } });

        const first = await syncTransactions({ pool, connection, watched: [TREASURY], ...syncOptions });
        const second = await syncTransactions({ pool, connection, watched: [TREASURY], ...syncOptions });

        expect(first.fetched).toBe(2);
        expect(second).toEqual({ scanned: 2, newSignatures: 0, fetched: 0, failed: 0, error: null });
        expect(connection.calls.parsedBatches).toHaveLength(1);
        expect(pool.stored).toHaveLength(2);
    });

    it('records the touched addresses and which watched scans surfaced the signature', async () => {
        const pool = createStorePool();
        const connection = createConnectionStub({
            signaturesByAddress: { [TREASURY_USDC]: [X402_SIG], [PERSONA_USDC]: [X402_SIG] }
        });

        await syncTransactions({ pool, connection, watched: [TREASURY_USDC, PERSONA_USDC], ...syncOptions });

        const row = pool.stored[0];
        expect(row.signature).toBe(X402_SIG);
        expect(row.firstSeenWatched.sort()).toEqual([PERSONA_USDC, TREASURY_USDC].sort());
        expect(row.touchedAddresses).toContain(TREASURY);
        expect(row.touchedAddresses).toContain(PERSONA_WALLET);
        expect(row.slot).toBe(FIXTURES[X402_SIG].slot);
        expect(row.blockTime).toBe(FIXTURES[X402_SIG].blockTime);
    });

    it('splits the misses into chunks of five', async () => {
        const many = {};
        const signatures = [];
        for (let i = 0; i < 12; i += 1) {
            const signature = `${X402_SIG.slice(0, -2)}${String(i).padStart(2, '0')}`;
            signatures.push(signature);
            many[signature] = { ...FIXTURES[X402_SIG], slot: 100 + i, blockTime: 1000 + i };
        }
        Object.assign(FIXTURES, many);
        const pool = createStorePool();
        const connection = createConnectionStub({ signaturesByAddress: { [TREASURY]: signatures } });

        const result = await syncTransactions({ pool, connection, watched: [TREASURY], ...syncOptions });

        expect(connection.calls.parsedBatches.map((batch) => batch.signatures.length)).toEqual([5, 5, 2]);
        expect(result.fetched).toBe(12);
        for (const signature of signatures) delete FIXTURES[signature];
    });

    it('keeps the chunks it already stored when a later chunk is rate limited', async () => {
        const many = {};
        const signatures = [];
        for (let i = 0; i < 12; i += 1) {
            const signature = `${MINT_SIG.slice(0, -2)}${String(i).padStart(2, '0')}`;
            signatures.push(signature);
            many[signature] = { ...FIXTURES[MINT_SIG], slot: 200 + i, blockTime: 2000 + i };
        }
        Object.assign(FIXTURES, many);
        const pool = createStorePool();
        // The first chunk succeeds, the second is refused — the classic devnet failure.
        const connection = createConnectionStub({ signaturesByAddress: { [TREASURY]: signatures }, failParsedAfter: 1 });

        const result = await syncTransactions({ pool, connection, watched: [TREASURY], ...syncOptions });

        expect(result.error).toContain('Too many requests');
        expect(result.newSignatures).toBe(12);
        expect(result.fetched).toBe(5);
        expect(pool.stored).toHaveLength(5);
        for (const signature of signatures) delete FIXTURES[signature];
    });

    it('resumes from the store after a rate-limited run, fetching only what is still missing', async () => {
        const many = {};
        const signatures = [];
        for (let i = 0; i < 8; i += 1) {
            const signature = `${FUNDING_SIG.slice(0, -2)}${String(i).padStart(2, '0')}`;
            signatures.push(signature);
            many[signature] = { ...FIXTURES[FUNDING_SIG], slot: 300 + i, blockTime: 3000 + i };
        }
        Object.assign(FIXTURES, many);
        const pool = createStorePool();

        const killed = createConnectionStub({ signaturesByAddress: { [TREASURY]: signatures }, failParsedAfter: 1 });
        const first = await syncTransactions({ pool, connection: killed, watched: [TREASURY], ...syncOptions });
        expect(first.fetched).toBe(5);

        const resumed = createConnectionStub({ signaturesByAddress: { [TREASURY]: signatures } });
        const second = await syncTransactions({ pool, connection: resumed, watched: [TREASURY], ...syncOptions });

        expect(second.newSignatures).toBe(3);
        expect(second.fetched).toBe(3);
        expect(resumed.calls.parsedBatches).toHaveLength(1);
        expect(pool.stored).toHaveLength(8);
        for (const signature of signatures) delete FIXTURES[signature];
    });

    it('counts a signature the rpc returns nothing for as failed, not fetched', async () => {
        const pool = createStorePool();
        const connection = createConnectionStub({ signaturesByAddress: { [TREASURY]: [X402_SIG, 'GhostSignatureThatTheRpcHasNoTransactionFor'] } });

        const result = await syncTransactions({ pool, connection, watched: [TREASURY], ...syncOptions });

        expect(result.fetched).toBe(1);
        expect(result.failed).toBe(1);
        expect(pool.stored).toHaveLength(1);
    });

    it('still fetches what a partially failed scan surfaced', async () => {
        const pool = createStorePool();
        const connection = createConnectionStub({ signaturesByAddress: { [TREASURY]: [X402_SIG, MINT_SIG] } });
        const inner = connection.getSignaturesForAddress.bind(connection);
        connection.getSignaturesForAddress = async (pubkey, options) => {
            // The first watched address answers, the second is refused.
            if (connection.calls.signatures.length >= 1) {
                connection.calls.signatures.push({ address: pubkey.toBase58(), options });
                throw new Error('Too many requests for a specific RPC call');
            }
            return inner(pubkey, options);
        };

        const result = await syncTransactions({ pool, connection, watched: [TREASURY, PERSONA_USDC], ...syncOptions });

        expect(result.error).toContain('Too many requests');
        expect(result.scanned).toBe(2);
        expect(result.newSignatures).toBe(2);
        expect(result.fetched).toBe(2);
        expect(pool.stored.map((row) => row.signature).sort()).toEqual([MINT_SIG, X402_SIG].sort());
    });

    it('reports a failed signature scan without throwing and without fetching', async () => {
        const pool = createStorePool();
        const connection = createConnectionStub({ failSignatures: 'Too many requests for a specific RPC call' });

        const result = await syncTransactions({ pool, connection, watched: [TREASURY], ...syncOptions });

        expect(result.error).toContain('Too many requests');
        expect(result.newSignatures).toBe(0);
        expect(connection.calls.parsedBatches).toHaveLength(0);
        expect(pool.calls).toHaveLength(0);
    });

    it('fetches nothing in dry-run mode but still reports what is missing', async () => {
        const pool = createStorePool();
        const connection = createConnectionStub({ signaturesByAddress: { [TREASURY]: [X402_SIG, MINT_SIG] } });

        const result = await syncTransactions({ pool, connection, watched: [TREASURY], dryRun: true, ...syncOptions });

        expect(result).toEqual({ scanned: 2, newSignatures: 2, fetched: 0, failed: 0, error: null });
        expect(connection.calls.parsedBatches).toHaveLength(0);
        expect(pool.stored).toEqual([]);
    });

    it('reports scan and fetch progress against a known total', async () => {
        const pool = createStorePool();
        const connection = createConnectionStub({ signaturesByAddress: { [TREASURY]: [X402_SIG], [PERSONA_USDC]: [MINT_SIG] } });
        const events = [];

        await syncTransactions({
            pool,
            connection,
            watched: [TREASURY, PERSONA_USDC],
            onProgress: (event) => events.push(event),
            ...syncOptions
        });

        const scans = events.filter((event) => event.phase === 'scan');
        expect(scans.map((event) => `${event.done}/${event.total}`)).toEqual(['1/2', '2/2']);
        expect(events.at(-1)).toMatchObject({ phase: 'fetch', total: 2 });
    });
});

describe('countTransactions', () => {
    it('counts the rows for the cluster', async () => {
        const pool = createStorePool();
        await countTransactions(pool, 'devnet');

        expect(pool.calls[0].sql).toContain('count(*)::int');
        expect(pool.calls[0].params).toEqual(['devnet']);
    });
});
