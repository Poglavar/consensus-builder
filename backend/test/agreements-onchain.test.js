// The chain side of the agreement index (plan-design-agreement.md M3): agreements/onchain.js (the account
// an agreement's sponsor and CID derive, the `onchain` record of a decoded account, the slot-guarded
// write, the RPC reader over a fake connection) and the routes on top of it: POST /agreements/:cid/onchain
// (201 first record, 200 refresh, every refusal before anything is written) and GET /agreements?minted=1.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { createMockPool } from './helpers/mock-pool.js';
import { createContentApp } from './helpers/create-app.js';
import { agreementContent, agreementRow, cidOf, designContent } from './helpers/content-fixtures.js';
import { agreementAccountBytes, agreementAccountInfo } from './fixtures/agreement-account.js';
import {
    AGREEMENT_PROGRAM_ID, AgreementClient, DEVNET_GENESIS_HASH, MOVING_FIELDS,
    agreementAccountOf, createAgreementChain, decisionOf, isPublicKey, isSignature, onchainFromAccount, onchainMoved,
    refreshOnchain, writeOnchain
} from '../agreements/onchain.js';

const require = createRequire(import.meta.url);
const LensCore = require('../../frontend/js/lens-core.js');

const keyFrom = seed => Keypair.fromSeed(Uint8Array.from({ length: 32 }, (_, index) => (index * 7 + seed) % 256)).publicKey.toBase58();
const SPONSOR = keyFrom(1);
const STRANGER = keyFrom(2);
const LENS = keyFrom(3);
const PAYOUT = keyFrom(4);
const ATTESTATION = keyFrom(5);
const signatureOf = fill => LensCore.base58Encode(new Uint8Array(64).fill(fill));
const SIG = signatureOf(7);
const SIG_2 = signatureOf(8);
const NOW = Date.parse('2026-10-22T08:00:00.000Z');
const DEADLINE = Math.floor(Date.parse('2026-11-01T00:00:00.000Z') / 1000);
const EXECUTED_AT = Math.floor(Date.parse('2026-10-22T07:30:00.000Z') / 1000);

const park = designContent();
const content = agreementContent([park], { sponsor: SPONSOR, deadline: '2026-11-01T00:00:00.000Z' });
const CID = cidOf(content);
const ACCOUNT = agreementAccountOf(CID, SPONSOR);

// The PDA as programs/agreement/README.md states it, computed here without the codec.
const pdaBySeeds = (cid, sponsor) => PublicKey.findProgramAddressSync(
    [Buffer.from('agreement'), new PublicKey(sponsor).toBuffer(), createHash('sha256').update(cid, 'utf8').digest()],
    new PublicKey(AGREEMENT_PROGRAM_ID)
)[0].toBase58();

// The account as the program writes it: active and pending unless the fields say otherwise.
const accountFields = (overrides = {}) => ({
    cid: CID, authority: SPONSOR, lens: LENS, payout: PAYOUT, deadline: DEADLINE,
    requiredLamports: 1000, escrowLamports: 1000, ...overrides
});
const decoded = (overrides = {}, address = ACCOUNT) => AgreementClient.readAgreement(new Uint8Array(agreementAccountBytes(accountFields(overrides))), address);
const executedFields = { status: 1, decision: 1, executedAt: EXECUTED_AT, escrowLamports: 0, decisionAttestation: ATTESTATION, decisionHash: Buffer.alloc(32, 9) };

/**
 * A connection the reader of agreements/onchain.js talks to: `accounts` maps an address to its account
 * info (absent = no account), `transactions` a signature to its transaction (absent = not found).
 */
function fakeConnection({ genesis = DEVNET_GENESIS_HASH, slot = 500, accounts = new Map(), transactions = new Map(), readError = null } = {}) {
    const calls = { genesis: 0, reads: [], transactions: [] };
    return {
        calls,
        accounts,
        transactions,
        slot,
        async getGenesisHash() {
            calls.genesis += 1;
            return genesis;
        },
        async getMultipleAccountsInfoAndContext(keys, commitment) {
            calls.reads.push({ addresses: keys.map(key => key.toBase58()), commitment });
            if (readError) throw readError;
            return { context: { slot: this.slot }, value: keys.map(key => this.accounts.get(key.toBase58()) ?? null) };
        },
        async getTransaction(signature, options) {
            calls.transactions.push({ signature, options });
            return this.transactions.get(signature) ?? null;
        }
    };
}
const touching = (...keys) => ({ slot: 499, meta: { err: null }, transaction: { message: { staticAccountKeys: keys.map(key => new PublicKey(key)) } } });

afterEach(() => {
    vi.restoreAllMocks();
});

describe('the account an agreement derives', () => {
    it('is PDA ["agreement", sponsor, sha256(cid)] under the agreement program', () => {
        expect(ACCOUNT).toBe(pdaBySeeds(CID, SPONSOR));
        expect(ACCOUNT).toBe(AgreementClient.getAgreementPda(CID, SPONSOR)[0].toBase58());
    });

    it('moves with the sponsor and with the CID, so a stranger cannot squat a published CID', () => {
        expect(agreementAccountOf(CID, STRANGER)).toBe(pdaBySeeds(CID, STRANGER));
        expect(agreementAccountOf(CID, STRANGER)).not.toBe(ACCOUNT);
        const counter = cidOf(agreementContent([park], { sponsor: SPONSOR, title: 'Counter-agreement' }));
        expect(agreementAccountOf(counter, SPONSOR)).not.toBe(ACCOUNT);
    });

    it('is null without a canonical sponsor key', () => {
        for (const sponsor of [null, undefined, '', 'not-a-key', 42, `${SPONSOR}1`, ` ${SPONSOR}`]) {
            expect(agreementAccountOf(CID, sponsor), String(sponsor)).toBeNull();
            expect(isPublicKey(sponsor)).toBe(false);
        }
        expect(isPublicKey(SPONSOR)).toBe(true);
    });

    it('takes a transaction signature only as base58 of 64 bytes', () => {
        expect(isSignature(SIG)).toBe(true);
        for (const value of [null, 'abc', SIG.replace(/./, '0'), `${SIG}${SIG}`, 12]) expect(isSignature(value), String(value)).toBe(false);
    });
});

describe('the onchain record of a decoded account', () => {
    it('spells the program\'s codes, keeps lamports exact as text and times as the chain\'s own', () => {
        const account = decoded({ ...executedFields, requiredLamports: 18446744073709551615n, escrowLamports: 18446744073709551615n });
        expect(onchainFromAccount(account, { cluster: 'devnet', observedAt: '2026-10-22T08:00:00.000Z', observedSlot: 321 })).toEqual({
            chain: 'solana', cluster: 'devnet', programId: AGREEMENT_PROGRAM_ID, account: ACCOUNT, sponsor: SPONSOR, lens: LENS,
            status: 'executed', decision: 'satisfied', deadline: '2026-11-01T00:00:00.000Z',
            requiredLamports: '18446744073709551615', escrowLamports: '18446744073709551615',
            executedAt: '2026-10-22T07:30:00.000Z', observedAt: '2026-10-22T08:00:00.000Z', observedSlot: 321
        });
    });

    it('reads no deadline and no execution as null, and carries a signature only when given', () => {
        const record = onchainFromAccount(decoded({ deadline: 0 }), { cluster: 'devnet', observedAt: 'T', observedSlot: 1 });
        expect(record).toMatchObject({ status: 'active', decision: 'pending', deadline: null, executedAt: null });
        expect(record).not.toHaveProperty('signature');
        expect(onchainFromAccount(decoded(), { cluster: 'devnet', observedAt: 'T', observedSlot: 1, signature: SIG }).signature).toBe(SIG);
        expect(['cancelled', 'expired'].map((name, index) => onchainFromAccount(decoded({ status: index + 2 }), { cluster: 'devnet', observedAt: 'T', observedSlot: 1 }).status))
            .toEqual(['cancelled', 'expired']);
    });

    it('refuses a status code the program does not have', () => {
        expect(() => onchainFromAccount(decoded({ status: 7 }), { cluster: 'devnet', observedAt: 'T', observedSlot: 1 })).toThrow(/unknown code/);
    });

    it('reads every recorded decision code but satisfied as pending', () => {
        expect(decisionOf(decoded({ decision: 1 }))).toBe('satisfied');
        expect(decisionOf(decoded({ decision: 0 }))).toBe('pending');
        expect(decisionOf(decoded({ decision: 2 }))).toBe('pending');
    });

    it('takes only what the chain moves from a later observation', () => {
        const stored = { ...onchainFromAccount(decoded(), { cluster: 'devnet', observedAt: '2026-10-22T07:00:00.000Z', observedSlot: 100, signature: SIG }) };
        const fresh = onchainFromAccount(decoded({ ...executedFields, lens: STRANGER, payout: STRANGER, deadline: DEADLINE + 1, requiredLamports: 5 }),
            { cluster: 'devnet', observedAt: '2026-10-22T08:00:00.000Z', observedSlot: 200 });
        const next = refreshOnchain(stored, fresh);
        expect(MOVING_FIELDS).toEqual(['status', 'decision', 'escrowLamports', 'executedAt', 'observedAt', 'observedSlot']);
        expect(next).toEqual({ ...stored, status: 'executed', decision: 'satisfied', escrowLamports: '0', executedAt: '2026-10-22T07:30:00.000Z',
            observedAt: '2026-10-22T08:00:00.000Z', observedSlot: 200 });
        expect(next.lens).toBe(LENS);
        expect(next.signature).toBe(SIG);
        expect(onchainMoved(stored, fresh)).toBe(true);
        expect(onchainMoved(stored, { ...stored, observedAt: 'later', observedSlot: 999 })).toBe(false);
        expect(onchainMoved(stored, { ...stored, escrowLamports: '1001' })).toBe(true);
        expect(onchainMoved(null, fresh)).toBe(true);
    });

    it('writes only over an older or equal observation, and says whether it wrote', async () => {
        const pool = createMockPool();
        pool.answer(/UPDATE consensus\.agreement/, (sql, params) => ({ rows: [], rowCount: params[2] >= 100 ? 1 : 0 }));
        const record = onchainFromAccount(decoded(), { cluster: 'devnet', observedAt: 'T', observedSlot: 150 });
        expect(await writeOnchain(pool, CID, record)).toBe(true);
        expect(await writeOnchain(pool, CID, { ...record, observedSlot: 99 })).toBe(false);
        const [call] = pool.getCalls();
        expect(call.params).toEqual([CID, JSON.stringify(record), 150]);
        expect(call.sql).toMatch(/WHERE cid = \$1\s+AND \(onchain IS NULL OR COALESCE\(\(onchain->>'observedSlot'\)::bigint, 0\) <= \$3::bigint\)/);
    });
});

describe('createAgreementChain over a fake connection', () => {
    const others = [keyFrom(11), keyFrom(12), keyFrom(13), keyFrom(14)];

    it('classifies every account and decodes the agreements, with the slot of the read', async () => {
        const accounts = new Map([
            [ACCOUNT, agreementAccountInfo(accountFields())],
            [others[0], agreementAccountInfo(accountFields(), { owner: SystemProgram.programId.toBase58() })],
            [others[1], { owner: new PublicKey(AGREEMENT_PROGRAM_ID), data: Buffer.alloc(296, 1) }],
            [others[2], { owner: new PublicKey(AGREEMENT_PROGRAM_ID), data: agreementAccountBytes(accountFields()).subarray(0, 100) }]
        ]);
        const connection = fakeConnection({ accounts, slot: 777 });
        const chain = createAgreementChain({ connection, env: {} });
        const rows = await chain.readAccounts([ACCOUNT, ...others]);
        expect(rows.map(row => [row.address, row.problem, row.slot])).toEqual([
            [ACCOUNT, null, 777], [others[0], 'wrong-program', 777], [others[1], 'not-agreement', 777],
            [others[2], 'undecodable', 777], [others[3], 'missing', 777]
        ]);
        expect(rows[0].account).toMatchObject({ address: ACCOUNT, cid: CID, authority: SPONSOR, lens: LENS, statusCode: 0 });
        expect(rows[0].data.equals(agreementAccountBytes(accountFields()))).toBe(true);
        expect(rows.slice(1).every(row => row.account === null)).toBe(true);
        expect(connection.calls.reads).toEqual([{ addresses: [ACCOUNT, ...others], commitment: 'confirmed' }]);
    });

    it('reads in batches of SOLANA_RPC_MAX_ACCOUNTS and refuses an answer of another length', async () => {
        const connection = fakeConnection();
        const chain = createAgreementChain({ connection, env: { SOLANA_RPC_MAX_ACCOUNTS: '2' } });
        const rows = await chain.readAccounts([ACCOUNT, ...others]);
        expect(connection.calls.reads.map(read => read.addresses.length)).toEqual([2, 2, 1]);
        expect(rows.map(row => row.address)).toEqual([ACCOUNT, ...others]);
        connection.getMultipleAccountsInfoAndContext = async () => ({ context: { slot: 1 }, value: [null] });
        await expect(chain.readAccounts([ACCOUNT, others[0]])).rejects.toThrow(/returned 1 results for 2 accounts/);
    });

    it('checks the genesis once, refuses another cluster with rpc-wrong-cluster and checks again after a failure', async () => {
        const connection = fakeConnection({ genesis: 'another-cluster' });
        const chain = createAgreementChain({ connection });
        await expect(chain.readAccount(ACCOUNT)).rejects.toMatchObject({ code: 'rpc-wrong-cluster' });
        expect(connection.calls.reads).toEqual([]);
        connection.getGenesisHash = async () => { connection.calls.genesis += 1; return DEVNET_GENESIS_HASH; };
        await chain.readAccount(ACCOUNT);
        await chain.readAccount(ACCOUNT);
        expect(connection.calls.genesis).toBe(2);
        expect(connection.calls.reads).toHaveLength(2);
        expect(() => createAgreementChain({ cluster: 'mainnet-beta', connection })).toThrow(/unsupported cluster/);
    });

    it('says whether a reported transaction succeeded and names the account', async () => {
        const transactions = new Map([
            ['ok-static', touching(STRANGER, ACCOUNT)],
            ['ok-loaded', { meta: { err: null, loadedAddresses: { writable: [ACCOUNT], readonly: [] } }, transaction: { message: { staticAccountKeys: [] } } }],
            ['failed', { ...touching(ACCOUNT), meta: { err: { InstructionError: [0, 'Custom'] } } }],
            ['unrelated', touching(STRANGER)]
        ]);
        const connection = fakeConnection({ transactions });
        const chain = createAgreementChain({ connection });
        const answers = [];
        for (const signature of ['ok-static', 'ok-loaded', 'failed', 'unrelated', 'unknown']) answers.push(await chain.transactionTouches(signature, ACCOUNT));
        expect(answers).toEqual(['ok', 'ok', 'failed', 'unrelated', 'not-found']);
        expect(connection.calls.transactions[0].options).toEqual({ commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
    });
});

// ---- the routes ------------------------------------------------------------------------------------

const ONE = /FROM consensus\.agreement WHERE cid = \$1/;
const UPDATE = /UPDATE consensus\.agreement/;

// The index holding `rows`; its UPDATE keeps the guard the SQL states (asserted above), so a test can
// see what a lagging read leaves behind.
function indexPool(rows) {
    const pool = createMockPool();
    const byCid = new Map(rows.map(row => [row.cid, structuredClone(row)]));
    pool.answer(ONE, (sql, params) => ({ rows: byCid.has(params[0]) ? [structuredClone(byCid.get(params[0]))] : [] }));
    pool.answer(UPDATE, (sql, params) => {
        const row = byCid.get(params[0]);
        if (!row || !(row.onchain === null || (row.onchain.observedSlot ?? 0) <= Number(params[2]))) return { rows: [], rowCount: 0 };
        row.onchain = JSON.parse(params[1]);
        return { rows: [], rowCount: 1 };
    });
    return { pool, byCid };
}

function appFor(rows, connection) {
    const { pool, byCid } = indexPool(rows);
    const app = createContentApp(pool, {
        thumbnailQueue: { enqueue: vi.fn() }, baseUrl: 'https://api.example', now: () => NOW,
        agreementChain: cluster => createAgreementChain({ cluster, connection })
    });
    return { app, pool, byCid };
}
const postOnchain = (app, body, cid = CID) => request(app).post(`/agreements/${cid}/onchain`).send(body);
const pointer = (extra = {}) => ({ chain: 'solana', cluster: 'devnet', account: ACCOUNT, ...extra });
const updates = pool => pool.getCalls().filter(call => UPDATE.test(call.sql));

describe('POST /agreements/:cid/onchain', () => {
    beforeEach(() => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    it('records the account the sponsor and CID derive (201), then refreshes what the chain moves (200)', async () => {
        const connection = fakeConnection({ accounts: new Map([[ACCOUNT, agreementAccountInfo(accountFields())]]), transactions: new Map([[SIG, touching(SPONSOR, ACCOUNT)]]) });
        const { app, byCid, pool } = appFor([agreementRow(content)], connection);

        const first = await postOnchain(app, pointer({ signature: SIG }));
        expect(first.status).toBe(201);
        const recorded = {
            chain: 'solana', cluster: 'devnet', programId: AGREEMENT_PROGRAM_ID, account: ACCOUNT, sponsor: SPONSOR, lens: LENS,
            status: 'active', decision: 'pending', deadline: '2026-11-01T00:00:00.000Z', requiredLamports: '1000', escrowLamports: '1000',
            executedAt: null, observedAt: '2026-10-22T08:00:00.000Z', observedSlot: 500, signature: SIG
        };
        expect(first.body).toMatchObject({ cid: CID, onchain: recorded });
        expect(byCid.get(CID).onchain).toEqual(recorded);
        expect(connection.calls.transactions.map(call => call.signature)).toEqual([SIG]);

        // The account executed. A later read refreshes it; the stored signature is kept, not verified again,
        // and another one reported now is not taken.
        connection.accounts.set(ACCOUNT, agreementAccountInfo(accountFields(executedFields)));
        connection.slot = 600;
        const second = await postOnchain(app, pointer({ signature: SIG_2 }));
        expect(second.status).toBe(200);
        expect(second.body.onchain).toEqual({ ...recorded, status: 'executed', decision: 'satisfied', escrowLamports: '0',
            executedAt: '2026-10-22T07:30:00.000Z', observedSlot: 600 });
        expect(connection.calls.transactions).toHaveLength(1);
        expect(updates(pool).map(call => call.params[2])).toEqual([500, 600]);
    });

    it('never moves an agreement back: a read older than the stored one writes nothing', async () => {
        const connection = fakeConnection({ accounts: new Map([[ACCOUNT, agreementAccountInfo(accountFields(executedFields))]]), slot: 600 });
        const { app, byCid } = appFor([agreementRow(content)], connection);
        expect((await postOnchain(app, pointer())).status).toBe(201);
        // A lagging RPC still sees the account active.
        connection.accounts.set(ACCOUNT, agreementAccountInfo(accountFields()));
        connection.slot = 550;
        const lagging = await postOnchain(app, pointer());
        expect(lagging.status).toBe(200);
        expect(lagging.body.onchain).toMatchObject({ status: 'executed', decision: 'satisfied', observedSlot: 600 });
        expect(byCid.get(CID).onchain.status).toBe('executed');
    });

    it('adds a signature reported after the first record once it verifies, and leaves it out when null', async () => {
        const connection = fakeConnection({ accounts: new Map([[ACCOUNT, agreementAccountInfo(accountFields())]]), transactions: new Map([[SIG, touching(ACCOUNT)]]) });
        const { app } = appFor([agreementRow(content)], connection);
        const unsigned = await postOnchain(app, pointer({ signature: null }));
        expect(unsigned.status).toBe(201);
        expect(unsigned.body.onchain).not.toHaveProperty('signature');
        expect(connection.calls.transactions).toEqual([]);
        const signed = await postOnchain(app, pointer({ signature: SIG }));
        expect(signed.status).toBe(200);
        expect(signed.body.onchain.signature).toBe(SIG);
    });

    it('refuses a malformed request, an unknown agreement, a vote and an agreement without a sponsor before reading the chain', async () => {
        const vote = agreementContent([park], { sponsor: SPONSOR, title: 'A vote', rule: { electorate: 'community', binding: false, approvalConfig: null, lens: [] } });
        const unsponsored = agreementContent([park], { title: 'No sponsor' });
        const connection = fakeConnection({ accounts: new Map([[ACCOUNT, agreementAccountInfo(accountFields())]]) });
        const { app, pool } = appFor([agreementRow(content), agreementRow(vote), agreementRow(unsponsored)], connection);
        const cases = [
            [pointer(), '12', 400, 'invalid-cid'],
            [{ ...pointer(), extra: true }, CID, 400, 'bad-request'],
            [{ chain: 'solana', cluster: 'devnet' }, CID, 400, 'bad-request'],
            [pointer({ chain: 'evm' }), CID, 400, 'unsupported-chain'],
            [pointer({ cluster: 'mainnet-beta' }), CID, 400, 'unsupported-cluster'],
            [pointer({ signature: 'not-a-signature' }), CID, 400, 'bad-request'],
            [pointer(), cidOf(park), 404, 'agreement-not-found'],
            [pointer({ account: agreementAccountOf(cidOf(vote), SPONSOR) }), cidOf(vote), 422, 'not-binding'],
            [pointer(), cidOf(unsponsored), 422, 'no-sponsor']
        ];
        for (const [body, cid, status, code] of cases) {
            const res = await postOnchain(app, body, cid);
            expect([res.status, res.body.code], `${code}`).toEqual([status, code]);
        }
        expect(connection.calls.reads).toEqual([]);
        expect(updates(pool)).toEqual([]);
    });

    it('names the account it expects when another is reported, and refuses one recorded elsewhere', async () => {
        const elsewhere = agreementRow(content, { onchain: { chain: 'solana', cluster: 'devnet', account: STRANGER, observedSlot: 1 } });
        const connection = fakeConnection({ accounts: new Map([[ACCOUNT, agreementAccountInfo(accountFields())]]) });
        const mismatch = await postOnchain(appFor([agreementRow(content)], connection).app, pointer({ account: agreementAccountOf(CID, STRANGER) }));
        expect(mismatch.status).toBe(400);
        expect(mismatch.body).toMatchObject({ code: 'onchain-account-mismatch', expected: ACCOUNT });
        const recorded = await postOnchain(appFor([elsewhere], connection).app, pointer());
        expect([recorded.status, recorded.body.code]).toEqual([409, 'onchain-recorded-elsewhere']);
        expect(connection.calls.reads).toEqual([]);
    });

    it('answers what the chain says: missing, not an agreement, another CID or authority, a transaction it cannot use', async () => {
        const answer = async ({ info = agreementAccountInfo(accountFields()), signature = null, transaction = null, genesis, readError } = {}) => {
            const connection = fakeConnection({ genesis, readError, accounts: new Map(info ? [[ACCOUNT, info]] : []), transactions: new Map(transaction ? [[SIG, transaction]] : []) });
            const { app, pool } = appFor([agreementRow(content)], connection);
            const res = await postOnchain(app, pointer(signature ? { signature } : {}));
            expect(updates(pool)).toEqual([]);
            return [res.status, res.body.code];
        };
        expect(await answer({ genesis: 'another-cluster' })).toEqual([503, 'chain-unavailable']);
        expect(await answer({ readError: new Error('429 Too Many Requests') })).toEqual([502, 'chain-unavailable']);
        expect(await answer({ info: null })).toEqual([404, 'onchain-account-missing']);
        expect(await answer({ info: agreementAccountInfo(accountFields(), { owner: SystemProgram.programId.toBase58() }) })).toEqual([409, 'onchain-not-agreement']);
        expect(await answer({ info: agreementAccountInfo(accountFields({ cid: cidOf(park) })) })).toEqual([409, 'onchain-cid-mismatch']);
        expect(await answer({ info: agreementAccountInfo(accountFields({ authority: STRANGER })) })).toEqual([409, 'onchain-sponsor-mismatch']);
        expect(await answer({ signature: SIG })).toEqual([409, 'onchain-signature-not-found']);
        expect(await answer({ signature: SIG, transaction: { ...touching(ACCOUNT), meta: { err: 'failed' } } })).toEqual([400, 'onchain-signature-mismatch']);
        expect(await answer({ signature: SIG, transaction: touching(STRANGER) })).toEqual([400, 'onchain-signature-mismatch']);
    });
});

describe('GET /agreements?minted=1', () => {
    const listed = async query => {
        const pool = createMockPool();
        pool.answer(/FROM consensus\.agreement/, { rows: [agreementRow(content, { onchain: { account: ACCOUNT, status: 'active' } })] });
        const app = createContentApp(pool, { thumbnailQueue: { enqueue: vi.fn() } });
        const res = await request(app).get(`/agreements${query}`);
        return { res, call: pool.getCalls()[0] };
    };

    it('keeps the agreements the index holds a chain account for', async () => {
        const { res, call } = await listed('?city=zg&minted=1&limit=5');
        expect(res.status).toBe(200);
        expect(res.body.agreements[0].onchain).toEqual({ account: ACCOUNT, status: 'active' });
        expect(call.sql).toMatch(/WHERE city = \$1 AND onchain IS NOT NULL\s+ORDER BY created_at DESC, cid\s+LIMIT \$2/);
        expect(call.params).toEqual(['zagreb', 5]);
        const { call: all } = await listed('');
        expect(all.sql).not.toMatch(/onchain IS NOT NULL/);
    });

    it('refuses any other minted value before querying', async () => {
        for (const query of ['?minted=2', '?minted=true', '?minted=0', '?minted=1&minted=1']) {
            const { res, call } = await listed(query);
            expect([res.status, res.body.code], query).toEqual([400, 'bad-request']);
            expect(call).toBeUndefined();
        }
    });
});
