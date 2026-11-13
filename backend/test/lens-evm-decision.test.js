// AgreementDecision-v1 for agreements minted on EVM (docs/blockchain-flows.md R4, lens/README.md): the
// lens member's EVM path over a fake EVM issuer (lens/member.js attestDecision with { chain }), how it
// finds and lists what it issued (memory and Postgres stores), and POST /lens/agreements/:cid/decision for
// an agreement with an EVM sponsor (lens/server.js): the member's EVM address as its lens key, the chain id
// from the index's `onchain`, and the refusals before anything is issued.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { ethers } from 'ethers';
import { cidOfObject } from '../cid.js';
import { createLensMember } from '../lens/member.js';
import { createDevnetRegistryIdentity } from '../lens/identity/devnet-registry.js';
import { createFakeIssuer } from '../lens/issuers.js';
import { encodeDecisionData } from '../lens/evm-issuer.js';
import { createMemoryStore, createPgStore } from '../lens/store.js';
import { createLensPricing } from '../lens/pricing.js';
import { createLensMemberApp, OPERATOR_TOKEN_HEADER } from '../lens/server.js';
import { planAgreementDecision, countAgreementDecisions } from '../lens/agreement-decision.js';
import { serializeAgreementRow } from '../routes/agreements.js';
import { loadAddressBook } from '../chain/evm.js';
import { agreementRow } from './helpers/content-fixtures.js';
import { MEMBER, NOW, agreement, agreementContent, approvalConfig, at, decision, wallets } from './helpers/approval-decisions.js';

const EVM_LENS = new ethers.Wallet(`0x${'5a'.repeat(32)}`).address;
const SPONSOR = new ethers.Wallet(`0x${'11'.repeat(32)}`).address;
const CHAIN_ID = '84532';
const SCHEMA = loadAddressBook()[CHAIN_ID].AgreementDecisionSchema;
const TOKEN = 'operator-secret';
const LENS_NOW = NOW + 30;
const EXPIRY = 3600;
const clock = { nowSeconds: () => LENS_NOW };
const LENS_KEYS = [MEMBER, EVM_LENS];

// An owner deal sponsored by an EVM wallet: its lens names the member's Solana key (which signs the
// approval facts) and its EVM address (which attests the decision on chain).
const rule = { electorate: 'owners', binding: true, approvalConfig, lens: LENS_KEYS };
const content = (overrides = {}) => agreementContent({ sponsor: SPONSOR, deadline: at(7 * 86400), rule, ...overrides });
const CID = cidOfObject(content());
const indexed = (overrides = {}) => serializeAgreementRow(agreementRow(content(), overrides));
const evmOnchain = (overrides = {}) => ({ chain: 'evm', chainId: CHAIN_ID, account: `0x${'0a'.repeat(32)}`, sponsor: SPONSOR, lens: EVM_LENS,
    status: 'active', decision: 'pending', observedSlot: 1, ...overrides });
const signed = (who, ownerId, offset) => decision(who, ownerId, { item: agreement({ agreementCid: CID, lens: LENS_KEYS }), offset });
const unanimous = async () => [await signed(wallets.a, 'owner-a', 1), await signed(wallets.b, 'owner-b', 2),
    await signed(wallets.c, 'owner-c', 3), await signed(wallets.d, 'owner-d', 4)];
const FIELDS = { agreementCid: CID, sponsor: SPONSOR, decision: 'satisfied', evidenceRef: `sha256:${'ab'.repeat(32)}`, sourceObservedAt: NOW + 4 };
const EVM = { family: 'evm', chainId: CHAIN_ID };

// A fake EVM issuer: records each request and answers a fresh uid and transaction hash.
function fakeEvmIssuer(address = EVM_LENS) {
    const requests = [];
    return {
        requests,
        address,
        async attest(input) {
            requests.push(input);
            const n = requests.length;
            // Upper-case hex: the member records the uid in lower case.
            return { uid: `0x${'A'.repeat(63)}${n}`, txHash: `0x${'f'.repeat(63)}${n}`, issuedAt: LENS_NOW - 2 };
        }
    };
}
function lensMember({ evmIssuer = fakeEvmIssuer(), store = createMemoryStore() } = {}) {
    const issuer = createFakeIssuer({ authority: MEMBER, clock });
    const identity = createDevnetRegistryIdentity({ rows: [], clock, authority: MEMBER });
    return { member: createLensMember({ authority: MEMBER, issuer, store, identity, clock, expirySeconds: EXPIRY, dryRun: true, evmIssuer }), issuer, evmIssuer, store };
}

beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
    vi.restoreAllMocks();
});

describe('the member attests on EVM', () => {
    it('through its EVM issuer, with the chain\'s decision schema, the encoded fields and its expiry', async () => {
        const { member, evmIssuer, issuer } = lensMember();
        const record = await member.attestDecision(FIELDS, { chain: EVM });
        expect(evmIssuer.requests).toEqual([{ chainId: CHAIN_ID, schemaUid: SCHEMA, data: encodeDecisionData(FIELDS), expirationTime: LENS_NOW + EXPIRY }]);
        const uid = `0x${'a'.repeat(63)}1`;
        expect(record).toEqual({
            address: uid, kind: 'decision', chain: 'evm', chainId: CHAIN_ID, uid, credential: null, schema: SCHEMA, authority: EVM_LENS,
            parcelUid: null, owner: null, payload: FIELDS, accountHash: null, expiry: LENS_NOW + EXPIRY, transactionSignature: `0x${'f'.repeat(63)}1`,
            payment: null, issuedAt: new Date((LENS_NOW - 2) * 1000).toISOString(), reused: false
        });
        expect(issuer.accounts.size).toBe(0);
        const { reused, ...stored } = record;
        expect(reused).toBe(false);
        expect(await member.listAttestations({ kind: 'decision', agreementCid: CID })).toEqual([stored]);
    });

    it('issues one decision per agreement, and finds it whatever the sponsor\'s case', async () => {
        const { member, evmIssuer } = lensMember();
        const first = await member.attestDecision(FIELDS, { chain: EVM });
        const again = await member.attestDecision({ ...FIELDS, sourceObservedAt: NOW + 5 }, { chain: EVM });
        expect(again).toMatchObject({ address: first.address, reused: true });
        expect(evmIssuer.requests).toHaveLength(1);
        expect(await member.findDecision({ agreementCid: CID, sponsor: SPONSOR.toLowerCase() })).toMatchObject({ address: first.address });
        // Another member's EVM decision in the same store is not this member's.
        const store = createMemoryStore();
        const other = lensMember({ evmIssuer: fakeEvmIssuer(SPONSOR), store });
        await other.member.attestDecision(FIELDS, { chain: EVM });
        expect(await lensMember({ store }).member.findDecision({ agreementCid: CID, sponsor: SPONSOR })).toBeNull();
    });

    it('refuses before issuing: no chain recorded, a Solana sponsor on EVM, no EVM key, a chain without an Agreement', async () => {
        const { member, evmIssuer } = lensMember();
        await expect(member.attestDecision(FIELDS)).rejects.toMatchObject({ status: 409, code: 'not_minted' });
        await expect(member.attestDecision({ ...FIELDS, sponsor: MEMBER }, { chain: EVM })).rejects.toMatchObject({ status: 422, code: 'invalid_decision' });
        await expect(member.attestDecision(FIELDS, { chain: { family: 'evm', chainId: '1' } })).rejects.toMatchObject({ status: 422, code: 'unsupported_chain' });
        await expect(lensMember({ evmIssuer: null }).member.attestDecision(FIELDS, { chain: EVM })).rejects.toMatchObject({ status: 503, code: 'evm_not_configured' });
        expect(evmIssuer.requests).toEqual([]);
        expect(() => lensMember({ evmIssuer: { address: 'not-an-address', attest() {} } })).toThrow(/EVM address/);
    });

    it('reports its EVM address in status only when it has one', async () => {
        expect(await lensMember().member.status()).toMatchObject({ key: MEMBER, evmAddress: EVM_LENS });
        expect(await lensMember({ evmIssuer: fakeEvmIssuer(EVM_LENS.toLowerCase()) }).member.evmAddress).toBe(EVM_LENS);
        expect(await lensMember({ evmIssuer: null }).member.status()).not.toHaveProperty('evmAddress');
    });

    it('keeps chain, chainId and uid through the Postgres store', async () => {
        const queries = [];
        let selected = [];
        const pool = { async query(sql, params) { queries.push({ sql, params }); return /SELECT/.test(sql) ? { rows: selected } : { rowCount: 1, rows: [] }; } };
        const row = { address: `0x${'01'.repeat(32)}`, kind: 'decision', credential: null, schema: SCHEMA, authority: EVM_LENS, parcel_uid: null, owner: null,
            payload: FIELDS, account_hash: null, expiry: String(LENS_NOW + EXPIRY), transaction_signature: `0x${'f'.repeat(64)}`, payment: null,
            issued_at: new Date(LENS_NOW * 1000), chain: 'evm', chain_id: CHAIN_ID };
        const { member } = lensMember({ store: createPgStore(pool) });
        await member.attestDecision(FIELDS, { chain: EVM });
        const insert = queries.find(query => /INSERT INTO consensus\.lens_attestation/.test(query.sql));
        expect(insert.sql).toMatch(/chain, chain_id\)/);
        expect(insert.params.slice(-2)).toEqual(['evm', CHAIN_ID]);
        selected = [row];
        expect((await createPgStore(pool).list({ agreementCid: CID }))[0]).toMatchObject({ chain: 'evm', chainId: CHAIN_ID, uid: row.address, credential: null, accountHash: null });
        const solana = await createPgStore({ query: async () => ({ rows: [{ ...row, chain: 'solana', chain_id: null }] }) }).get(row.address);
        expect(solana).not.toHaveProperty('chain');
    });
});

describe('planAgreementDecision for an EVM agreement', () => {
    it('takes the member\'s EVM address as the lens key, in any case, and refuses its Solana key once the contract names the EVM one', async () => {
        const item = indexed({ onchain: evmOnchain({ lens: EVM_LENS.toLowerCase() }) });
        const count = countAgreementDecisions(item, await unanimous());
        expect(planAgreementDecision({ agreement: item, count, lensKey: EVM_LENS, nowSeconds: LENS_NOW }).fields).toMatchObject({ sponsor: SPONSOR, decision: 'satisfied' });
        expect(() => planAgreementDecision({ agreement: item, count, lensKey: MEMBER, nowSeconds: LENS_NOW })).toThrowError(expect.objectContaining({ code: 'not_agreement_lens' }));
        const outside = new ethers.Wallet(`0x${'77'.repeat(32)}`).address;
        expect(() => planAgreementDecision({ agreement: item, count, lensKey: outside, nowSeconds: LENS_NOW })).toThrowError(expect.objectContaining({ code: 'not_in_lens' }));
    });
});

describe('POST /lens/agreements/:cid/decision for an EVM agreement', () => {
    function memberApp({ rows = [indexed({ onchain: evmOnchain() })], receipts = [], evmIssuer } = {}) {
        const built = lensMember(evmIssuer === undefined ? {} : { evmIssuer });
        const agreements = { load: async cid => rows.find(row => row.cid === cid) ?? null, decisions: async () => receipts };
        return { ...built, app: createLensMemberApp({ member: built.member, pricing: createLensPricing({ dryRun: true }), operatorToken: TOKEN, agreements, clock }) };
    }
    const ask = app => request(app).post(`/lens/agreements/${CID}/decision`).set(OPERATOR_TOKEN_HEADER, TOKEN);

    it('attests on the chain the index records it minted on, and lists it with chain, chainId and uid', async () => {
        const { app, evmIssuer } = memberApp({ receipts: await unanimous() });
        const res = await ask(app);
        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({ kind: 'decision', chain: 'evm', chainId: CHAIN_ID, uid: res.body.address, authority: EVM_LENS, reused: false, counted: 4,
            payload: { agreementCid: CID, sponsor: SPONSOR, decision: 'satisfied', sourceObservedAt: NOW + 4 } });
        expect(evmIssuer.requests.map(item => item.chainId)).toEqual([CHAIN_ID]);
        const listed = await request(app).get('/lens/attestations').query({ kind: 'decision', agreementCid: CID });
        expect(listed.body.attestations).toEqual([expect.objectContaining({ chain: 'evm', chainId: CHAIN_ID, uid: res.body.address })]);
        const again = await ask(app);
        expect([again.status, again.body.reused, again.body.address]).toEqual([200, true, res.body.address]);
        expect(evmIssuer.requests).toHaveLength(1);
        expect((await request(app).get('/lens/status')).body.evmAddress).toBe(EVM_LENS);
    });

    it('refuses an agreement not recorded on an EVM chain, and a member without an EVM key, before issuing', async () => {
        const receipts = await unanimous();
        for (const onchain of [null, { chain: 'solana', cluster: 'devnet', account: MEMBER, lens: MEMBER, status: 'active', decision: 'pending' }]) {
            const { app, evmIssuer } = memberApp({ rows: [indexed({ onchain })], receipts });
            const res = await ask(app);
            expect([res.status, res.body.error]).toEqual([409, 'not_minted']);
            expect(evmIssuer.requests).toEqual([]);
        }
        const res = await ask(memberApp({ receipts, evmIssuer: null }).app);
        expect([res.status, res.body.error]).toEqual([503, 'evm_not_configured']);
    });
});
