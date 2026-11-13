// The EVM side of the agreement index (docs/blockchain-flows.md, R4): agreements/onchain-evm.js (the key an
// agreement's sponsor and CID derive on Agreement.sol, the contract's Record as `onchain`, the chain object
// over a fake reader and provider, and the Agreement read ABI of chain/evm.js decoding a real ABI-encoded
// answer), POST /agreements/:cid/onchain with { chain: 'evm', … } (201 first record, 200 refresh, every
// refusal before anything is written), the contract's terminal logs read through queryFilter and searched
// in a bounded, paged block range, and lifecycle oracle passes over EVM rows that write their land events.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { ethers } from 'ethers';
import { Keypair } from '@solana/web3.js';
import { createHash } from 'node:crypto';
import { createMockPool } from './helpers/mock-pool.js';
import { createContentApp } from './helpers/create-app.js';
import { agreementContent, agreementRow, cidOf, designContent } from './helpers/content-fixtures.js';
import { refreshOnchain } from '../agreements/onchain.js';
import {
    AGREEMENT_TERMINAL_EVENTS_ABI, EVM_MOVING_FIELDS, evmAccountOf, evmAgreementChain, evmAgreementKeyOf, evmOnchainMoved,
    isEvmTransactionHash, onchainFromEvmRecord
} from '../agreements/onchain-evm.js';
import { AGREEMENT_READ_ABI, agreementReader, loadAddressBook } from '../chain/evm.js';
import { buildEvmAgreementEvents, findEvmTerminalLog, landEventParams, syncAgreementLifecycle } from '../oracle/agreement-lifecycle.js';

const walletOf = byte => new ethers.Wallet(`0x${byte.repeat(32)}`).address;
const SPONSOR = walletOf('11');
const STRANGER = walletOf('22');
const LENS = walletOf('33');
const PAYOUT = walletOf('44');
const CHAIN_ID = '84532';
const CONTRACT = loadAddressBook()[CHAIN_ID].Agreement;
const NOW = Date.parse('2026-11-13T08:00:00.000Z');
const CREATED_AT = Math.floor(Date.parse('2026-11-12T10:00:00.000Z') / 1000);
const DEADLINE = Math.floor(Date.parse('2026-12-01T00:00:00.000Z') / 1000);
const EXECUTED_AT = Math.floor(Date.parse('2026-11-13T07:30:00.000Z') / 1000);
const TX = `0x${'ab'.repeat(32)}`;
const TX_2 = `0x${'cd'.repeat(32)}`;

const park = designContent();
const content = agreementContent([park], { sponsor: SPONSOR, deadline: '2026-12-01T00:00:00.000Z' });
const CID = cidOf(content);
const KEY = evmAgreementKeyOf(SPONSOR, CID);

// abi.encode(address, string) written out word by word, without the AbiCoder: the address left-padded,
// the string's offset (0x40), its byte length, its bytes right-padded to whole words.
function abiEncodeByHand(address, text) {
    const word = hex => hex.padStart(64, '0');
    const bytes = Buffer.from(text, 'utf8');
    const padded = Buffer.concat([bytes, Buffer.alloc((32 - (bytes.length % 32)) % 32)]);
    return `0x${word(address.slice(2).toLowerCase())}${word('40')}${word(bytes.length.toString(16))}${padded.toString('hex')}`;
}

// Agreement.sol's Record as ethers returns it (bigints), active and pending unless the fields say otherwise.
const recordOf = (overrides = {}) => ({
    sponsor: SPONSOR, lens: LENS, payout: PAYOUT, deadline: BigInt(DEADLINE), createdAt: BigInt(CREATED_AT),
    requiredWei: 10n ** 18n, escrowWei: 5n * 10n ** 17n, status: 0n, openGround: false, decision: 0n,
    decisionAttestedAt: 0n, decisionObservedAt: 0n, decisionAttestation: ethers.ZeroHash, decisionHash: ethers.ZeroHash,
    executedAt: 0n, cid: CID, ...overrides
});
const executedFields = { status: 1n, decision: 1n, escrowWei: 0n, executedAt: BigInt(EXECUTED_AT), decisionAttestation: `0x${'ee'.repeat(32)}` };

// The chain's blocks: one every 2 seconds (Base), block 1000 the agreement's creation.
const GENESIS = CREATED_AT - 2000;
const timeOfBlock = number => GENESIS + 2 * number;
const blockAt = seconds => (seconds - GENESIS) / 2;
const CREATED_BLOCK = blockAt(CREATED_AT);
const EXECUTED_BLOCK = blockAt(EXECUTED_AT);
const CANCELLED_AT = CREATED_AT + 36_000;
const READ_BLOCK = 45_000;
const EVENTS = new ethers.Interface(AGREEMENT_TERMINAL_EVENTS_ABI);
/** A terminal event log of the Agreement contract as eth_getLogs returns it. */
function terminalLog(name, values, { block, tx = TX_2, address = CONTRACT, index = 3 }) {
    const { data, topics } = EVENTS.encodeEventLog(name, values);
    return { address, data, topics, blockNumber: block, blockHash: `0x${'bb'.repeat(32)}`, transactionHash: tx, transactionIndex: 0, index, removed: false };
}
const executedLog = (overrides = {}) => terminalLog('AgreementExecuted',
    [overrides.key ?? KEY, CID, PAYOUT, 5n * 10n ** 17n, LENS, `0x${'ee'.repeat(32)}`, overrides.at ?? EXECUTED_AT], { block: EXECUTED_BLOCK, ...overrides });
const cancelledLog = (overrides = {}) => terminalLog('AgreementCancelled',
    [overrides.key ?? KEY, CID, 5n * 10n ** 17n, overrides.at ?? CANCELLED_AT], { block: blockAt(CANCELLED_AT), ...overrides });

/**
 * The Agreement contract (`records` by key; an Error answers get() with a throw) and the RPC (`chainId`,
 * the current `block`, receipts by hash, block timestamps, and `logs` filtered as eth_getLogs does, a
 * range wider than `maxLogRange` blocks refused) the chain object reads through.
 */
function fakeEvm({ records = new Map(), block = 7000, chainId = 84532n, receipts = new Map(), readError = null, logs = [], maxLogRange = Infinity, chain = CHAIN_ID } = {}) {
    const calls = { exists: [], get: [], network: 0, receipts: [], blocks: [], logs: [] };
    const sameHex = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
    const reader = {
        async exists(key, overrides) {
            calls.exists.push({ key, overrides });
            if (readError) throw readError;
            return records.has(key);
        },
        async get(key, overrides) {
            calls.get.push({ key, overrides });
            const record = records.get(key);
            if (record instanceof Error) throw record;
            return record;
        }
    };
    const provider = {
        chainId,
        block,
        async getNetwork() { calls.network += 1; return { chainId: this.chainId }; },
        async getBlockNumber() { return this.block; },
        async getTransactionReceipt(hash) { calls.receipts.push(hash); return receipts.get(hash) ?? null; },
        async getBlock(number) { calls.blocks.push(number); return number <= this.block ? { number, timestamp: timeOfBlock(number) } : null; },
        async getLogs(filter) {
            const { fromBlock, toBlock } = filter;
            calls.logs.push({ fromBlock, toBlock, topics: filter.topics });
            if (toBlock - fromBlock + 1 > maxLogRange) throw Object.assign(new Error('block range too large'), { code: -32600 });
            return logs.filter(entry => sameHex(entry.address, filter.address) && entry.blockNumber >= fromBlock && entry.blockNumber <= toBlock
                && filter.topics.every((topic, index) => topic === null || sameHex(topic, entry.topics[index])));
        },
        // ethers reads logs through a runner's provider.
        get provider() { return this; }
    };
    return { calls, records, receipts, provider, chain: evmAgreementChain(chain, { env: {}, reader, provider }) };
}
const receipt = (overrides = {}) => ({ hash: TX, status: 1, to: CONTRACT, ...overrides });

afterEach(() => {
    vi.restoreAllMocks();
});

describe('the key an agreement derives on EVM', () => {
    it('is keccak256(abi.encode(address sponsor, string cid)), as Agreement.sol keyOf states it', () => {
        expect(KEY).toBe(ethers.keccak256(abiEncodeByHand(SPONSOR, CID)));
        expect(KEY).toMatch(/^0x[0-9a-f]{64}$/);
    });

    it('is the same whatever the sponsor\'s case, and moves with the sponsor and the CID', () => {
        expect(evmAgreementKeyOf(SPONSOR.toLowerCase(), CID)).toBe(KEY);
        expect(evmAgreementKeyOf(STRANGER, CID)).not.toBe(KEY);
        expect(evmAgreementKeyOf(SPONSOR, cidOf(agreementContent([park], { sponsor: SPONSOR, title: 'Counter' })))).not.toBe(KEY);
    });

    it('is null without an EVM sponsor or a CID', () => {
        for (const sponsor of [null, '', Keypair.generate().publicKey.toBase58(), SPONSOR.slice(0, 41), `${SPONSOR} `]) {
            expect(evmAgreementKeyOf(sponsor, CID), String(sponsor)).toBeNull();
        }
        expect(evmAgreementKeyOf(SPONSOR, '')).toBeNull();
    });

    it('takes a transaction hash only as 0x and 64 hex digits', () => {
        expect(isEvmTransactionHash(TX)).toBe(true);
        for (const value of [null, TX.slice(0, 65), `${TX}0`, TX.replace('0x', ''), 7]) expect(isEvmTransactionHash(value), String(value)).toBe(false);
    });
});

describe('the onchain record of an EVM agreement', () => {
    it('spells the contract\'s codes, keeps wei exact as text and times as the contract\'s own', () => {
        const account = evmAccountOf(KEY, recordOf({ ...executedFields, sponsor: SPONSOR.toLowerCase(), requiredWei: 2n ** 255n }));
        expect(onchainFromEvmRecord(account, { chainId: CHAIN_ID, contract: CONTRACT, observedAt: '2026-11-13T08:00:00.000Z', observedSlot: 7000 })).toEqual({
            chain: 'evm', chainId: CHAIN_ID, contract: CONTRACT, account: KEY, sponsor: SPONSOR, lens: LENS, payout: PAYOUT,
            status: 'executed', decision: 'satisfied', deadline: '2026-12-01T00:00:00.000Z', createdAt: '2026-11-12T10:00:00.000Z',
            requiredWei: (2n ** 255n).toString(), escrowWei: '0', executedAt: '2026-11-13T07:30:00.000Z',
            observedAt: '2026-11-13T08:00:00.000Z', observedSlot: 7000
        });
    });

    it('reads no deadline and no execution as null, carries a signature only when given, and spells every status', () => {
        const at = { chainId: CHAIN_ID, contract: CONTRACT, observedAt: 'T', observedSlot: 1 };
        const record = onchainFromEvmRecord(evmAccountOf(KEY, recordOf({ deadline: 0n })), at);
        expect(record).toMatchObject({ status: 'active', decision: 'pending', deadline: null, executedAt: null });
        expect(record).not.toHaveProperty('signature');
        expect(onchainFromEvmRecord(evmAccountOf(KEY, recordOf()), { ...at, signature: TX }).signature).toBe(TX);
        expect([2n, 3n].map(status => onchainFromEvmRecord(evmAccountOf(KEY, recordOf({ status })), at).status)).toEqual(['cancelled', 'expired']);
        expect(() => onchainFromEvmRecord(evmAccountOf(KEY, recordOf({ status: 4n })), at)).toThrow(/unknown code/);
    });

    it('takes only what the contract moves from a later observation', () => {
        const at = { chainId: CHAIN_ID, contract: CONTRACT };
        const stored = onchainFromEvmRecord(evmAccountOf(KEY, recordOf()), { ...at, observedAt: 'T1', observedSlot: 100, signature: TX });
        const fresh = onchainFromEvmRecord(evmAccountOf(KEY, recordOf({ ...executedFields, lens: STRANGER, payout: STRANGER, requiredWei: 1n, deadline: 5n })),
            { ...at, observedAt: 'T2', observedSlot: 200 });
        expect(EVM_MOVING_FIELDS).toEqual(['status', 'decision', 'escrowWei', 'executedAt', 'observedAt', 'observedSlot']);
        expect(refreshOnchain(stored, fresh, EVM_MOVING_FIELDS)).toEqual({ ...stored, status: 'executed', decision: 'satisfied', escrowWei: '0',
            executedAt: '2026-11-13T07:30:00.000Z', observedAt: 'T2', observedSlot: 200 });
        expect(evmOnchainMoved(stored, fresh)).toBe(true);
        expect(evmOnchainMoved(stored, { ...stored, observedAt: 'T3', observedSlot: 300 })).toBe(false);
        expect(evmOnchainMoved(stored, { ...stored, escrowWei: '1' })).toBe(true);
    });
});

describe('the Agreement read ABI', () => {
    it('decodes the contract\'s ABI-encoded Record into the fields evmAccountOf reads', async () => {
        const iface = new ethers.Interface(AGREEMENT_READ_ABI);
        const raw = recordOf(executedFields);
        // A runner answering eth_call with what the contract would return for get(KEY).
        const runner = {
            provider: null,
            async call(tx) {
                const { name, args } = iface.parseTransaction({ data: tx.data });
                expect([name, args[0], tx.to]).toEqual(['get', KEY, CONTRACT]);
                return iface.encodeFunctionResult('get', [Object.values(raw)]);
            }
        };
        const reader = agreementReader(CHAIN_ID, { env: {}, provider: runner });
        expect(evmAccountOf(KEY, await reader.get(KEY))).toEqual({
            address: KEY, sponsor: SPONSOR, lens: LENS, payout: PAYOUT, deadline: DEADLINE, createdAt: CREATED_AT,
            requiredWei: (10n ** 18n).toString(), escrowWei: '0', statusCode: 1, openGround: false, decisionCode: 1,
            decisionAttestation: `0x${'ee'.repeat(32)}`, executedAt: EXECUTED_AT, cid: CID
        });
    });
});

describe('evmAgreementChain over a fake contract and RPC', () => {
    it('reads every key at one block, and classifies the absent and the undecodable', async () => {
        const other = evmAgreementKeyOf(STRANGER, CID);
        const broken = `0x${'01'.repeat(32)}`;
        const { chain, calls } = fakeEvm({ records: new Map([[KEY, recordOf()], [broken, recordOf({ status: 2n ** 70n })]]), block: 4321 });
        const rows = await chain.readAccounts([KEY, other, broken, 'not-a-key']);
        expect(rows.map(row => [row.address, row.problem, row.slot])).toEqual([[KEY, null, 4321], [other, 'missing', 4321], [broken, 'undecodable', 4321], ['not-a-key', 'missing', 4321]]);
        expect(rows[0].account).toMatchObject({ address: KEY, cid: CID, sponsor: SPONSOR, statusCode: 0, escrowWei: '500000000000000000' });
        expect([...calls.exists, ...calls.get].every(call => call.overrides.blockTag === 4321)).toBe(true);
        expect(chain).toMatchObject({ family: 'evm', chainId: CHAIN_ID, contract: CONTRACT });
    });

    it('checks the chain id once, refuses another chain with rpc-wrong-chain and checks again after a failure', async () => {
        const fake = fakeEvm({ chainId: 1n });
        await expect(fake.chain.readAccount(KEY)).rejects.toMatchObject({ code: 'rpc-wrong-chain' });
        expect(fake.calls.exists).toEqual([]);
        fake.provider.chainId = 84532n;
        await fake.chain.readAccount(KEY);
        await fake.chain.readAccount(KEY);
        expect(fake.calls.network).toBe(2);
    });

    it('says whether a reported transaction succeeded and was sent to the Agreement contract', async () => {
        const receipts = new Map([
            ['ok', receipt()], ['ok-lower', receipt({ to: CONTRACT.toLowerCase() })], ['failed', receipt({ status: 0 })],
            ['unrelated', receipt({ to: STRANGER })], ['deploy', receipt({ to: null })]
        ]);
        const { chain } = fakeEvm({ receipts });
        const answers = [];
        for (const hash of ['ok', 'ok-lower', 'failed', 'unrelated', 'deploy', 'unknown']) answers.push(await chain.transactionTouches(hash));
        expect(answers).toEqual(['ok', 'ok', 'failed', 'unrelated', 'unrelated', 'not-found']);
    });

    it('refuses a chain without an Agreement before anything is read', () => {
        expect(() => evmAgreementChain('1', { env: {} })).toThrowError(expect.objectContaining({ code: 'unknown-chain' }));
        expect(() => evmAgreementChain('84532', { env: {}, addressBook: { 84532: {} } })).toThrowError(expect.objectContaining({ code: 'no-agreement' }));
    });
});

// ---- the route ---------------------------------------------------------------------------------

const ONE = /FROM consensus\.agreement WHERE cid = \$1/;
const UPDATE = /UPDATE consensus\.agreement/;

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
function appFor(rows, fake) {
    const { pool, byCid } = indexPool(rows);
    const chains = [];
    const app = createContentApp(pool, {
        thumbnailQueue: { enqueue: vi.fn() }, baseUrl: 'https://api.example', now: () => NOW,
        evmAgreementChain: chainId => { chains.push(chainId); return fake.chain; },
        agreementChain: () => { throw new Error('the Solana reader is not asked for an EVM mint'); }
    });
    return { app, pool, byCid, chains };
}
const postOnchain = (app, body, cid = CID) => request(app).post(`/agreements/${cid}/onchain`).send(body);
const pointer = (extra = {}) => ({ chain: 'evm', chainId: CHAIN_ID, account: KEY, ...extra });
const updates = pool => pool.getCalls().filter(call => UPDATE.test(call.sql));

describe('POST /agreements/:cid/onchain on EVM', () => {
    beforeEach(() => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    it('records the key the sponsor and CID derive (201), then refreshes what the contract moves (200)', async () => {
        const fake = fakeEvm({ records: new Map([[KEY, recordOf()]]), receipts: new Map([[TX, receipt()]]) });
        const { app, byCid, pool, chains } = appFor([agreementRow(content)], fake);

        const first = await postOnchain(app, pointer({ signature: TX, chainId: 84532 }));
        expect(first.status).toBe(201);
        const recorded = {
            chain: 'evm', chainId: CHAIN_ID, contract: CONTRACT, account: KEY, sponsor: SPONSOR, lens: LENS, payout: PAYOUT,
            status: 'active', decision: 'pending', deadline: '2026-12-01T00:00:00.000Z', createdAt: '2026-11-12T10:00:00.000Z',
            requiredWei: '1000000000000000000', escrowWei: '500000000000000000', executedAt: null,
            observedAt: '2026-11-13T08:00:00.000Z', observedSlot: 7000, signature: TX
        };
        expect(first.body).toMatchObject({ cid: CID, status: 'active', onchain: recorded });
        expect(byCid.get(CID).onchain).toEqual(recorded);
        expect(chains).toEqual([CHAIN_ID]);
        expect(fake.calls.receipts).toEqual([TX]);

        // Executed. A later read refreshes it; the stored signature is kept, not verified again.
        fake.records.set(KEY, recordOf(executedFields));
        fake.provider.block = 7100;
        const second = await postOnchain(app, pointer({ signature: TX_2, account: KEY.toUpperCase().replace('0X', '0x') }));
        expect(second.status).toBe(200);
        expect(second.body.onchain).toEqual({ ...recorded, status: 'executed', decision: 'satisfied', escrowWei: '0',
            executedAt: '2026-11-13T07:30:00.000Z', observedSlot: 7100 });
        expect(fake.calls.receipts).toHaveLength(1);
        expect(updates(pool).map(call => call.params[2])).toEqual([7000, 7100]);
    });

    it('never moves an agreement back: a read at an older block writes nothing', async () => {
        const fake = fakeEvm({ records: new Map([[KEY, recordOf(executedFields)]]), block: 7100 });
        const { app, byCid } = appFor([agreementRow(content)], fake);
        expect((await postOnchain(app, pointer())).status).toBe(201);
        fake.records.set(KEY, recordOf());
        fake.provider.block = 7050;
        const lagging = await postOnchain(app, pointer());
        expect(lagging.status).toBe(200);
        expect(lagging.body.onchain).toMatchObject({ status: 'executed', observedSlot: 7100 });
        expect(byCid.get(CID).onchain.status).toBe('executed');
    });

    it('refuses a malformed request, another chain, a vote, a Solana sponsor and another key before reading the chain', async () => {
        const vote = agreementContent([park], { sponsor: SPONSOR, title: 'A vote', rule: { electorate: 'community', binding: false, approvalConfig: null, lens: [] } });
        const solanaSponsored = agreementContent([park], { sponsor: Keypair.generate().publicKey.toBase58(), title: 'Solana sponsor' });
        const fake = fakeEvm({ records: new Map([[KEY, recordOf()]]) });
        const { app, pool } = appFor([agreementRow(content), agreementRow(vote), agreementRow(solanaSponsored)], fake);
        const cases = [
            [{ ...pointer(), cluster: 'devnet' }, CID, 400, 'bad-request'],
            [{ chain: 'evm', chainId: CHAIN_ID }, CID, 400, 'bad-request'],
            [pointer({ chainId: '1' }), CID, 400, 'unsupported-chain-id'],
            [pointer({ chainId: undefined }), CID, 400, 'unsupported-chain-id'],
            [pointer({ signature: 'not-a-hash' }), CID, 400, 'bad-request'],
            [pointer({ signature: TX.slice(0, 40) }), CID, 400, 'bad-request'],
            [pointer(), cidOf(park), 404, 'agreement-not-found'],
            [pointer({ account: evmAgreementKeyOf(SPONSOR, cidOf(vote)) }), cidOf(vote), 422, 'not-binding'],
            [pointer(), cidOf(solanaSponsored), 422, 'no-sponsor']
        ];
        for (const [body, cid, status, code] of cases) {
            const res = await postOnchain(app, body, cid);
            expect([res.status, res.body.code], code).toEqual([status, code]);
        }
        const mismatch = await postOnchain(app, pointer({ account: evmAgreementKeyOf(STRANGER, CID) }));
        expect(mismatch.status).toBe(400);
        expect(mismatch.body).toMatchObject({ code: 'onchain-account-mismatch', expected: KEY });
        expect(fake.calls.exists).toEqual([]);
        expect(updates(pool)).toEqual([]);
    });

    it('refuses an agreement recorded on Solana, on another EVM chain or under another key', async () => {
        const fake = fakeEvm({ records: new Map([[KEY, recordOf()]]) });
        for (const onchain of [
            { chain: 'solana', cluster: 'devnet', account: Keypair.generate().publicKey.toBase58(), observedSlot: 1 },
            { chain: 'evm', chainId: '11155111', account: KEY, observedSlot: 1 },
            { chain: 'evm', chainId: CHAIN_ID, account: evmAgreementKeyOf(STRANGER, CID), observedSlot: 1 }
        ]) {
            const res = await postOnchain(appFor([agreementRow(content, { onchain })], fake).app, pointer());
            expect([res.status, res.body.code]).toEqual([409, 'onchain-recorded-elsewhere']);
        }
        expect(fake.calls.exists).toEqual([]);
    });

    it('answers what the contract says: missing, undecodable, another CID or sponsor, a transaction it cannot use', async () => {
        const answer = async ({ record = recordOf(), signature = null, txReceipt = null, chainId, readError } = {}) => {
            const fake = fakeEvm({ chainId, readError, records: new Map(record ? [[KEY, record]] : []), receipts: new Map(txReceipt ? [[TX, txReceipt]] : []) });
            const { app, pool } = appFor([agreementRow(content)], fake);
            const res = await postOnchain(app, pointer(signature ? { signature } : {}));
            expect(updates(pool)).toEqual([]);
            return [res.status, res.body.code];
        };
        expect(await answer({ chainId: 1n })).toEqual([503, 'chain-unavailable']);
        expect(await answer({ readError: new Error('429 Too Many Requests') })).toEqual([502, 'chain-unavailable']);
        expect(await answer({ record: null })).toEqual([404, 'onchain-account-missing']);
        expect(await answer({ record: new Error('could not decode result data') })).toEqual([409, 'onchain-not-agreement']);
        expect(await answer({ record: recordOf({ cid: cidOf(park) }) })).toEqual([409, 'onchain-cid-mismatch']);
        expect(await answer({ record: recordOf({ sponsor: STRANGER }) })).toEqual([409, 'onchain-sponsor-mismatch']);
        expect(await answer({ signature: TX })).toEqual([409, 'onchain-signature-not-found']);
        expect(await answer({ signature: TX, txReceipt: receipt({ status: 0 }) })).toEqual([400, 'onchain-signature-mismatch']);
        expect(await answer({ signature: TX, txReceipt: receipt({ to: STRANGER }) })).toEqual([400, 'onchain-signature-mismatch']);
    });

    it('accepts the sponsor in the contract whatever its case, and leaves the Solana path to Solana sponsors', async () => {
        const fake = fakeEvm({ records: new Map([[KEY, recordOf({ sponsor: SPONSOR.toLowerCase() })]]) });
        const { app } = appFor([agreementRow(content)], fake);
        expect((await postOnchain(app, pointer())).status).toBe(201);
        const solana = await postOnchain(appFor([agreementRow(content)], fake).app, { chain: 'solana', cluster: 'devnet', account: Keypair.generate().publicKey.toBase58() });
        expect([solana.status, solana.body.code]).toEqual([422, 'no-sponsor']);
    });
});

// ---- the lifecycle oracle ------------------------------------------------------------------------

describe('the lifecycle oracle on an EVM chain', () => {
    const stored = (overrides = {}) => onchainFromEvmRecord(evmAccountOf(KEY, recordOf()), {
        chainId: CHAIN_ID, contract: CONTRACT, observedAt: '2026-11-12T12:00:00.000Z', observedSlot: 6000, signature: TX
    });
    // The index: agreement rows (each on two input parcels) and the land events inserted, counted per
    // account and attester the way storedEventCounts asks.
    function oracleIndex(rows) {
        const pool = createMockPool();
        const byCid = new Map(rows.map(row => [row.cid, structuredClone(row)]));
        const events = new Map();
        pool.answer(/FROM consensus\.agreement\s+WHERE onchain->>'chain' = 'evm' AND onchain->>'chainId' = \$1/, (sql, params) => ({
            rows: [...byCid.values()].filter(row => row.onchain.chain === 'evm' && row.onchain.chainId === params[0])
                .map(row => ({ cid: row.cid, sponsor: row.sponsor, input_parcel_ids: ['p-1', 'p-2'], parcel_source_id: null, onchain: structuredClone(row.onchain) }))
        }));
        pool.answer(/FROM consensus\.land_event\s+WHERE event_type = ANY/, (sql, params) => {
            const counts = new Map();
            for (const stored of events.values()) {
                const account = JSON.parse(stored[10]).account;
                if (!params[0].includes(stored[1]) || !params[1].includes(account) || stored[8] !== params[2]) continue;
                const entry = counts.get(`${account}|${stored[1]}`) || { account, event_type: stored[1], events: 0, ended_at: stored[7] };
                entry.events += 1;
                counts.set(`${account}|${stored[1]}`, entry);
            }
            return { rows: [...counts.values()] };
        });
        pool.answer(/INSERT INTO consensus\.land_event/, (sql, params) => {
            if (events.has(params[0])) return { rows: [] };
            events.set(params[0], params);
            return { rows: [{ inserted: 1 }] };
        });
        pool.answer(UPDATE, (sql, params) => {
            byCid.get(params[0]).onchain = JSON.parse(params[1]);
            return { rows: [], rowCount: 1 };
        });
        return { pool, byCid, events };
    }
    const sha256Of = ({ topics, data }) => createHash('sha256').update(Buffer.concat([...topics, data].map(hex => Buffer.from(ethers.getBytes(hex))))).digest('hex');

    it('refreshes the EVM rows of its chain id and writes the land events of an executed agreement, timed by its block; a second pass searches and writes nothing', async () => {
        const otherCid = cidOf(agreementContent([park], { sponsor: SPONSOR, title: 'Elsewhere' }));
        const { pool, byCid, events } = oracleIndex([
            { cid: CID, sponsor: SPONSOR.toLowerCase(), onchain: stored() },
            { cid: otherCid, sponsor: SPONSOR, onchain: { ...stored(), chainId: '11155111' } }
        ]);
        const fake = fakeEvm({ records: new Map([[KEY, recordOf(executedFields)]]), block: READ_BLOCK, logs: [executedLog()] });
        const result = await syncAgreementLifecycle({ pool, chain: fake.chain, apply: true, now: () => NOW });
        expect(result).toMatchObject({ scanned: 1, reconciled: 1, moved: 1, terminal: 1, inserted: 3, invalidAccounts: [], missingEvidence: [], failed: [] });
        expect(byCid.get(CID).onchain).toEqual({ ...stored(), status: 'executed', decision: 'satisfied', escrowWei: '0',
            executedAt: '2026-11-13T07:30:00.000Z', endedAt: '2026-11-13T07:30:00.000Z', observedAt: '2026-11-13T08:00:00.000Z', observedSlot: READ_BLOCK });
        expect(byCid.get(otherCid).onchain.status).toBe('active');

        // Ids name the chain and the contract, so they never meet a Solana id or another chain's.
        const prefix = `eip155:84532:${CONTRACT}`;
        expect(result.events.map(event => event.id)).toEqual([
            `${prefix}:agreement_lifecycle:${KEY}:executed`, `${prefix}:agreement_executed:${KEY}:p-1`, `${prefix}:agreement_executed:${KEY}:p-2`
        ]);
        // Only the blocks timed executed_at were asked for logs: one block.
        expect(fake.calls.logs.map(call => [call.fromBlock, call.toBlock])).toEqual([[EXECUTED_BLOCK, EXECUTED_BLOCK]]);
        const lifecycle = events.get(`${prefix}:agreement_lifecycle:${KEY}:executed`);
        const evidence = JSON.parse(lifecycle[10]);
        expect(lifecycle.slice(0, 10)).toEqual([
            `${prefix}:agreement_lifecycle:${KEY}:executed`, 'agreement_lifecycle', 'agreement', KEY, 'executed',
            `https://sepolia.basescan.org/tx/${TX_2}`, `sha256:${sha256Of(evidence.log)}`, '2026-11-13T07:30:00.000Z', CONTRACT, TX_2
        ]);
        expect(evidence).toMatchObject({
            source: { chain: 'eip155:84532', contract: CONTRACT, transaction: TX_2, block: EXECUTED_BLOCK, logIndex: 3,
                transactionUrl: `https://sepolia.basescan.org/tx/${TX_2}`, contractUrl: `https://sepolia.basescan.org/address/${CONTRACT}` },
            agreementCid: CID, account: KEY, sponsor: SPONSOR, lens: LENS, decision: 'satisfied', attestation: `0x${'ee'.repeat(32)}`,
            payout: PAYOUT, paidWei: '500000000000000000', inputParcelIds: ['p-1', 'p-2'], statusCode: 1
        });
        expect(evidence.log).toEqual({ topics: executedLog().topics, data: executedLog().data });
        const parcel = events.get(`${prefix}:agreement_executed:${KEY}:p-2`);
        expect(parcel.slice(1, 5)).toEqual(['agreement_executed', 'parcel', 'p-2', 'executed']);
        expect(JSON.parse(parcel[10])).toMatchObject({ agreementCid: CID, account: KEY, lens: LENS });

        const logReads = fake.calls.logs.length;
        const second = await syncAgreementLifecycle({ pool, chain: fake.chain, apply: true, now: () => NOW });
        expect(second).toMatchObject({ terminal: 1, events: [], inserted: 0, missingEvidence: [], failed: [] });
        expect(fake.calls.logs).toHaveLength(logReads);
        expect(events.size).toBe(3);
    });

    it('dates a cancelled agreement on Sepolia by its log\'s block, links Etherscan, and records when it ended', async () => {
        const SEPOLIA = '11155111';
        const contract = loadAddressBook()[SEPOLIA].Agreement;
        const onchain = { ...stored(), chainId: SEPOLIA, contract };
        const { pool, byCid } = oracleIndex([{ cid: CID, sponsor: SPONSOR, onchain }]);
        const fake = fakeEvm({ chain: SEPOLIA, chainId: 11155111n, records: new Map([[KEY, recordOf({ status: 2n, escrowWei: 0n })]]), block: READ_BLOCK,
            logs: [cancelledLog({ address: contract }), cancelledLog({ key: evmAgreementKeyOf(STRANGER, CID), address: contract, tx: TX })] });
        const result = await syncAgreementLifecycle({ pool, chain: fake.chain, apply: true, now: () => NOW });
        expect(result).toMatchObject({ terminal: 1, inserted: 1, missingEvidence: [], failed: [] });
        const [event] = result.events;
        expect(event).toMatchObject({
            id: `eip155:11155111:${contract}:agreement_lifecycle:${KEY}:cancelled`, outcome: 'cancelled',
            observedAt: new Date(CANCELLED_AT * 1000).toISOString(), attester: { kind: 'evm_contract', address: contract },
            source: { transaction: TX_2, transactionUrl: `https://sepolia.etherscan.io/tx/${TX_2}` },
            evidence: { refundedWei: '500000000000000000', decision: 'pending', attestation: null }
        });
        expect(byCid.get(CID).onchain.endedAt).toBe(new Date(CANCELLED_AT * 1000).toISOString());
        // Searched newest first from the block it was read at, never before its creation.
        expect(fake.calls.logs[0].toBlock).toBe(READ_BLOCK);
        expect(Math.min(...fake.calls.logs.map(call => call.fromBlock))).toBeGreaterThanOrEqual(CREATED_BLOCK);
    });

    it('reports a terminal agreement whose log is not on chain as missing evidence', async () => {
        const { pool, events } = oracleIndex([{ cid: CID, sponsor: SPONSOR, onchain: stored() }]);
        const fake = fakeEvm({ records: new Map([[KEY, recordOf(executedFields)]]), block: READ_BLOCK, logs: [executedLog({ key: evmAgreementKeyOf(STRANGER, CID) })] });
        const lines = [];
        const result = await syncAgreementLifecycle({ pool, chain: fake.chain, apply: true, now: () => NOW, log: line => lines.push(line) });
        expect(result).toMatchObject({ terminal: 1, events: [], inserted: 0, missingEvidence: [KEY], failed: [] });
        expect(events.size).toBe(0);
        expect(lines.some(line => line.includes(`no AgreementExecuted log of this key up to block ${READ_BLOCK}`))).toBe(true);
    });

    it('reports a key the contract no longer answers or that names another sponsor, and writes nothing in a dry run', async () => {
        const otherCid = cidOf(agreementContent([park], { sponsor: SPONSOR, title: 'Gone' }));
        const { pool } = oracleIndex([
            { cid: CID, sponsor: SPONSOR, onchain: stored() },
            { cid: otherCid, sponsor: SPONSOR, onchain: { ...stored(), account: evmAgreementKeyOf(SPONSOR, otherCid) } }
        ]);
        const fake = fakeEvm({ records: new Map([[KEY, recordOf({ sponsor: STRANGER })]]) });
        const result = await syncAgreementLifecycle({ pool, chain: fake.chain, apply: false, now: () => NOW });
        expect(result.invalidAccounts.map(item => [item.cid, item.problem])).toEqual([[CID, `belongs to ${STRANGER}, not the sponsor`], [otherCid, 'missing']]);
        expect(updates(pool)).toEqual([]);
    });
});

describe('the terminal logs of an EVM agreement', () => {
    const account = fields => evmAccountOf(KEY, recordOf(fields));

    it('are read with queryFilter by event and key, and decoded with the event\'s own time', async () => {
        const fake = fakeEvm({ block: READ_BLOCK, logs: [
            executedLog(), cancelledLog(), executedLog({ key: evmAgreementKeyOf(STRANGER, CID), tx: TX }), executedLog({ address: STRANGER })
        ] });
        const logs = await fake.chain.terminalLogs({ key: KEY, outcome: 'executed', fromBlock: 0, toBlock: READ_BLOCK });
        expect(logs).toEqual([{
            outcome: 'executed', key: KEY, cid: CID, payout: PAYOUT, wei: '500000000000000000', lens: LENS,
            decisionAttestation: `0x${'ee'.repeat(32)}`, at: EXECUTED_AT, transaction: TX_2, block: EXECUTED_BLOCK, logIndex: 3,
            address: CONTRACT, topics: executedLog().topics, data: executedLog().data, removed: false
        }]);
        expect(fake.calls.logs[0].topics).toEqual([EVENTS.getEvent('AgreementExecuted').topicHash, KEY]);
        expect(await fake.chain.blockTime(EXECUTED_BLOCK)).toBe(EXECUTED_AT);
        await expect(fake.chain.terminalLogs({ key: KEY, outcome: 'active', fromBlock: 0, toBlock: 1 })).rejects.toThrow(/not a terminal/);
    });

    it('are searched newest first between the block the end could first happen and the block read, halving a range the RPC refuses', async () => {
        const fake = fakeEvm({ block: READ_BLOCK, logs: [cancelledLog()], maxLogRange: 3000 });
        const lines = [];
        const paging = { blocks: 10_000 };
        const found = await findEvmTerminalLog(fake.chain, { account: account({ status: 2n }), outcome: 'cancelled', toBlock: READ_BLOCK, paging, log: line => lines.push(line) });
        expect(found).toMatchObject({ transaction: TX_2, block: blockAt(CANCELLED_AT), at: CANCELLED_AT, blockTime: CANCELLED_AT });
        expect(paging.blocks).toBe(2500);
        const ranges = fake.calls.logs.map(call => [call.fromBlock, call.toBlock]);
        expect(ranges.slice(0, 3)).toEqual([[35_001, 45_000], [40_001, 45_000], [42_501, 45_000]]);
        expect(lines[0]).toMatch(/refused the logs of blocks 35001-45000 \(block range too large\); asking 5000 block\(s\) at a time/);
        // Pages answered are contiguous, newest first, and stop at the page holding the log.
        const answered = ranges.slice(2);
        answered.slice(1).forEach(([, to], index) => expect(to).toBe(answered[index][0] - 1));
        expect(answered.at(-1)[0]).toBeLessThanOrEqual(blockAt(CANCELLED_AT));
    });

    it('cover an expired agreement from its deadline only, and throw when the RPC refuses a single block', async () => {
        const deadline = CREATED_AT + 7200;
        const fake = fakeEvm({ block: READ_BLOCK });
        expect(await findEvmTerminalLog(fake.chain, { account: account({ status: 3n, deadline: BigInt(deadline) }), outcome: 'expired', toBlock: READ_BLOCK })).toBeNull();
        const ranges = fake.calls.logs.map(call => [call.fromBlock, call.toBlock]);
        expect(ranges[0]).toEqual([35_001, READ_BLOCK]);
        expect(ranges.at(-1)[0]).toBe(blockAt(deadline));

        const refusing = fakeEvm({ block: READ_BLOCK, maxLogRange: 0 });
        await expect(findEvmTerminalLog(refusing.chain, { account: account({ status: 2n }), outcome: 'cancelled', toBlock: READ_BLOCK })).rejects.toThrow(/block range too large/);
    });

    it('become land events only when the log names this agreement on this contract and its time is its block\'s', () => {
        const executed = account(executedFields);
        const { topics, data } = executedLog();
        const log = { outcome: 'executed', key: KEY, cid: CID, payout: PAYOUT, wei: '1', lens: LENS, decisionAttestation: `0x${'ee'.repeat(32)}`,
            at: EXECUTED_AT, transaction: TX_2, block: EXECUTED_BLOCK, logIndex: 0, address: CONTRACT, topics, data, removed: false, blockTime: EXECUTED_AT };
        const build = (source, record = executed) => buildEvmAgreementEvents({ agreement: { cid: CID, inputParcelIds: ['p-1'] }, account: record, chainId: CHAIN_ID, contract: CONTRACT, source });
        expect(build(log)).toHaveLength(2);
        // source_url, source_hash (sha256 of the log's topics and data), source_observed_at, attester.
        const logHash = createHash('sha256').update(Buffer.concat([...topics, data].map(hex => Buffer.from(ethers.getBytes(hex))))).digest('hex');
        expect(landEventParams(build(log)[0]).slice(5, 9)).toEqual([`https://sepolia.basescan.org/tx/${TX_2}`, `sha256:${logHash}`, '2026-11-13T07:30:00.000Z', CONTRACT]);
        expect(() => build({ ...log, blockTime: EXECUTED_AT + 2 })).toThrow(/says .* but its block .* is timed/);
        expect(() => build({ ...log, at: EXECUTED_AT - 2, blockTime: EXECUTED_AT - 2 })).toThrow(/stores executed_at/);
        expect(() => build({ ...log, key: evmAgreementKeyOf(STRANGER, CID) })).toThrow(/does not record executed/);
        expect(() => build({ ...log, address: STRANGER })).toThrow(/does not record executed/);
        expect(() => build({ ...log, outcome: 'cancelled' })).toThrow(/does not record executed/);
        expect(() => build(log, account())).toThrow(/is active, not terminal/);
        // A local chain has no explorer: the source is named by chain and transaction.
        const local = buildEvmAgreementEvents({ agreement: { cid: CID, inputParcelIds: [] }, account: executed, chainId: '31337', contract: CONTRACT, source: log });
        expect(local[0].source).toMatchObject({ url: `eip155:31337:tx:${TX_2}`, transactionUrl: null, contractUrl: null });
    });
});
