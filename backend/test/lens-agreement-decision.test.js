// AgreementDecision-v1 from the reference lens member (plan-design-agreement.md M3, lens/README.md
// "Agreement decision rules"): which decision an indexed agreement gets from its relayed owner decisions
// (lens/agreement-decision.js), how the member issues and finds it (lens/member.js), and the operator route
// POST /lens/agreements/:cid/decision (lens/server.js) over an in-memory agreement index.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { Keypair } from '@solana/web3.js';
import { cidOfObject } from '../cid.js';
import { countAgreementDecisions, decisionEvidenceRef, planAgreementDecision } from '../lens/agreement-decision.js';
import { createLensMember } from '../lens/member.js';
import { createDevnetRegistryIdentity } from '../lens/identity/devnet-registry.js';
import { createFakeIssuer } from '../lens/issuers.js';
import { createMemoryStore } from '../lens/store.js';
import { createLensPricing } from '../lens/pricing.js';
import { createLensMemberApp, OPERATOR_TOKEN_HEADER } from '../lens/server.js';
import { decodeLensAttestation, deriveLensSchemaPdas, parseLensAttestation } from '../oracle/lens-schemas.js';
import { loadAgreement, serializeAgreementRow } from '../routes/agreements.js';
import { createAgreementDecisionStore } from '../agreements/decisions.js';
import { agreementRow } from './helpers/content-fixtures.js';
import { createMockPool } from './helpers/mock-pool.js';
import { MEMBER, NOW, agreement, agreementContent, approvalConfig, at, decision, wallets } from './helpers/approval-decisions.js';

const require = createRequire(import.meta.url);
const approval = require('../../frontend/js/proposals/approval.js');
const LensCore = require('../../frontend/js/lens-core.js');

const SPONSOR = Keypair.generate().publicKey.toBase58();
const OTHER_LENS = Keypair.generate().publicKey.toBase58();
const TOKEN = 'operator-secret';
// The member's clock: 30 s after the fixtures' NOW, so decisions signed at NOW + offset are in its past.
const LENS_NOW = NOW + 30;
const clock = { nowSeconds: () => LENS_NOW };

// The published owner deal (unanimous over four owners on three parcels, lens = the member), sponsored and
// due in a week, and its row as GET /agreements/:cid serves it.
const content = (overrides = {}) => agreementContent({ sponsor: SPONSOR, deadline: at(7 * 86400), ...overrides });
const CID = cidOfObject(content());
const indexed = (body = content(), overrides = {}) => serializeAgreementRow(agreementRow(body, overrides));
// The minted account as the index records it (agreements/onchain.js onchainFromAccount).
const onchain = (overrides = {}) => ({ chain: 'solana', cluster: 'devnet', account: Keypair.generate().publicKey.toBase58(), sponsor: SPONSOR,
    lens: MEMBER, status: 'active', decision: 'pending', ...overrides });
// An owner decision signed on `cid`'s agreement, `offset` seconds after NOW.
const signed = (who, ownerId, { cid = CID, config = approvalConfig, ...options } = {}) =>
    decision(who, ownerId, { item: agreement({ agreementCid: cid, approvalConfig: config }), ...options });
// Every owner approves: A, B, and both co-owners of parcel C, one second apart.
const unanimous = async (cid = CID) => [await signed(wallets.a, 'owner-a', { cid, offset: 1 }), await signed(wallets.b, 'owner-b', { cid, offset: 2 }),
    await signed(wallets.c, 'owner-c', { cid, offset: 3 }), await signed(wallets.d, 'owner-d', { cid, offset: 4 })];
const hashOf = receipts => `sha256:${createHash('sha256').update(approval.stableStringify(receipts), 'utf8').digest('hex')}`;

beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
    vi.restoreAllMocks();
});

describe('planAgreementDecision', () => {
    const plan = (item = indexed(), receipts = [], { lensKey = MEMBER, nowSeconds = LENS_NOW } = {}) =>
        planAgreementDecision({ agreement: item, count: countAgreementDecisions(item, receipts), lensKey, nowSeconds });
    // The LensError a plan throws, as the route answers it.
    function refusal(run) {
        try {
            run();
        } catch (error) {
            return { status: error.status, code: error.code, tally: error.details?.tally };
        }
        throw new Error('expected the plan to refuse');
    }

    it('is satisfied once the rule passes: the last signing time, and a hash of the counted receipts in signing order', async () => {
        const receipts = await unanimous();
        const result = plan(indexed(), receipts);
        expect(result.fields).toEqual({
            agreementCid: CID, sponsor: SPONSOR, decision: 'satisfied', evidenceRef: hashOf(receipts), sourceObservedAt: NOW + 4
        });
        expect(result.tally).toMatchObject({ ready: true, passed: true, acceptedOwners: 4 });
        expect(result.counted).toBe(4);
        expect(decisionEvidenceRef(receipts)).toBe(hashOf(receipts));
        // The relay's order is the signing order, whatever order the receipts arrive in.
        expect(plan(indexed(), [...receipts].reverse(), {}).fields).toEqual(result.fields);
    });

    it('counts each party\'s current approval only, and times the outcome by the last decision applied', async () => {
        const [a, b, c, d] = await unanimous();
        const withdrawn = await signed(wallets.c, 'owner-c', { decision: 'withdraw', offset: 5 });
        const again = await signed(wallets.c2, 'owner-c', { offset: 6 });
        const result = plan(indexed(), [a, b, c, d, withdrawn, again]);
        expect(result.fields.evidenceRef).toBe(hashOf([a, b, d, again]));
        expect(result.fields.sourceObservedAt).toBe(NOW + 6);
        expect(result.counted).toBe(4);
        // A decision on another agreement (another CID) and a forged one do not count.
        const foreign = await signed(wallets.b, 'owner-b', { cid: cidOfObject(content({ title: 'Counter-agreement' })), offset: 2 });
        const forged = { ...(await signed(wallets.d, 'owner-d', { offset: 4 })), decidedAt: at(9) };
        expect(refusal(() => plan(indexed(), [a, foreign, c, forged]))).toMatchObject({ status: 409, code: 'rule_not_met', tally: { acceptedOwners: 2, passed: false } });

        // Under an owners' majority, a withdrawal that leaves the rule met is the moment the counted state came to be.
        const majority = { ...approvalConfig, policy: { type: 'threshold', owners: { numerator: 1, denominator: 2, strict: false } } };
        const body = content({ rule: { electorate: 'owners', binding: true, approvalConfig: majority, lens: [MEMBER] } });
        const cid = cidOfObject(body);
        const votes = [await signed(wallets.a, 'owner-a', { cid, config: majority, offset: 1 }), await signed(wallets.b, 'owner-b', { cid, config: majority, offset: 2 }),
            await signed(wallets.c, 'owner-c', { cid, config: majority, offset: 3 })];
        const out = await signed(wallets.c, 'owner-c', { cid, config: majority, decision: 'withdraw', offset: 5 });
        const majorityPlan = plan(indexed(body), [...votes, out]);
        expect(majorityPlan.fields).toMatchObject({ agreementCid: cid, sourceObservedAt: NOW + 5, evidenceRef: hashOf(votes.slice(0, 2)) });
        expect(majorityPlan.tally).toMatchObject({ acceptedOwners: 2, passed: true });
    });

    it('refuses while the rule is not met, with the engine\'s tally', async () => {
        const receipts = await unanimous();
        expect(refusal(() => plan(indexed(), receipts.slice(0, 3))))
            .toMatchObject({ status: 409, code: 'rule_not_met', tally: { ready: true, passed: false, acceptedOwners: 3 } });
        expect(refusal(() => plan(indexed(), []))).toMatchObject({ status: 409, code: 'rule_not_met', tally: { acceptedOwners: 0 } });
        // A rule that cannot be counted (no rights snapshot) is not met either.
        const uncountable = content({ rule: { electorate: 'owners', binding: true, approvalConfig: null, lens: [MEMBER] } });
        expect(refusal(() => plan(indexed(uncountable), receipts))).toMatchObject({ status: 409, code: 'rule_not_met', tally: { ready: false } });
    });

    it('refuses an agreement with no sponsor wallet, and a member outside its lens or its account\'s lens', async () => {
        const receipts = await unanimous();
        for (const sponsor of [null, 'not-a-wallet']) {
            const body = content({ sponsor });
            expect(refusal(() => plan(indexed(body), receipts))).toMatchObject({ status: 422, code: 'no_sponsor' });
        }
        expect(refusal(() => plan(indexed(), receipts, { lensKey: OTHER_LENS }))).toMatchObject({ status: 409, code: 'not_in_lens' });
        expect(refusal(() => plan(indexed(content(), { onchain: onchain({ lens: OTHER_LENS }) }), receipts)))
            .toMatchObject({ status: 409, code: 'not_agreement_lens' });
        // Minted with this member as its lens and still pending: the decision is issued.
        expect(plan(indexed(content(), { onchain: onchain() }), receipts).fields.decision).toBe('satisfied');
    });

    it('refuses a closed agreement, a decision already recorded on its account, and a passed deadline', async () => {
        const receipts = await unanimous();
        for (const status of ['executed', 'cancelled']) {
            expect(refusal(() => plan(indexed(content(), { status, onchain: onchain({ status }) }), receipts)))
                .toMatchObject({ status: 409, code: 'agreement_closed', tally: { passed: true } });
        }
        expect(refusal(() => plan(indexed(content(), { onchain: onchain({ decision: 'satisfied' }) }), receipts)))
            .toMatchObject({ status: 409, code: 'decision_recorded' });
        // The program takes a decision only before the deadline; at the deadline the account can only expire.
        const due = content({ deadline: at(30) });
        const dueReceipts = await unanimous(cidOfObject(due));
        expect(refusal(() => plan(indexed(due), dueReceipts, { nowSeconds: NOW + 30 }))).toMatchObject({ status: 409, code: 'deadline_passed' });
        expect(plan(indexed(due), dueReceipts, { nowSeconds: NOW + 29 }).fields.sourceObservedAt).toBe(NOW + 4);
        // No deadline: never passed.
        const open = content({ deadline: null });
        expect(plan(indexed(open), await unanimous(cidOfObject(open)), { nowSeconds: NOW + 10 ** 6 }).fields.decision).toBe('satisfied');
    });

    it('refuses a source time it does not have or that lies ahead of its clock', async () => {
        const receipts = await unanimous();
        expect(refusal(() => plan(indexed(), receipts, { nowSeconds: NOW + 3 }))).toMatchObject({ status: 409, code: 'source_time_in_future' });
        // A rule met with nobody to count (a leaseholders' test on land without leases) has no decision to time it by.
        const vacuous = { ...approvalConfig, policy: { type: 'rules', authorities: [],
            tests: [{ measure: 'headcount', of: 'leaseholders', scope: 'all', numerator: 1, denominator: 2, strict: false }] } };
        const body = content({ rule: { electorate: 'owners', binding: true, approvalConfig: vacuous, lens: [MEMBER] } });
        expect(refusal(() => plan(indexed(body), []))).toMatchObject({ status: 422, code: 'source_time_missing', tally: { passed: true } });
    });
});

// A dry-run member signing as MEMBER (the agreement's lens), over a fake SAS issuer.
function lensMember({ authority = MEMBER, store = createMemoryStore() } = {}) {
    const issuer = createFakeIssuer({ authority, clock });
    const identity = createDevnetRegistryIdentity({ rows: [], clock, authority });
    return { member: createLensMember({ authority, issuer, store, identity, clock, dryRun: true }), issuer, store };
}
const FIELDS = { agreementCid: CID, sponsor: SPONSOR, decision: 'satisfied', evidenceRef: `sha256:${'ab'.repeat(32)}`, sourceObservedAt: NOW + 4 };

describe('the member issues AgreementDecision-v1', () => {
    it('under its credential\'s AgreementDecision schema, in the program\'s [12, 12, 12, 12, 8] layout', async () => {
        const { member, issuer } = lensMember();
        const record = await member.attestDecision(FIELDS);
        expect(record).toMatchObject({ kind: 'decision', authority: MEMBER, credential: member.credential, schema: member.schemas.decision,
            parcelUid: null, owner: null, payload: FIELDS, reused: false, issuedAt: new Date(LENS_NOW * 1000).toISOString() });
        expect(deriveLensSchemaPdas({ authority: MEMBER, credentialName: 'LensMember' })).toEqual({ credential: member.credential, schemas: member.schemas });
        const bytes = issuer.accounts.get(record.address);
        const account = parseLensAttestation(bytes);
        expect(account).toMatchObject({ authority: MEMBER, credential: member.credential, schema: member.schemas.decision });
        // Four borsh strings (u32 LE length + UTF-8), then the int64 source time, and nothing after it.
        const payload = Buffer.from(account.payload);
        let offset = 0;
        const strings = [];
        for (let field = 0; field < 4; field += 1) {
            const length = payload.readUInt32LE(offset);
            strings.push(payload.subarray(offset + 4, offset + 4 + length).toString('utf8'));
            offset += 4 + length;
        }
        expect(strings).toEqual([CID, SPONSOR, 'satisfied', FIELDS.evidenceRef]);
        expect(Number(payload.readBigInt64LE(offset))).toBe(NOW + 4);
        expect(offset + 8).toBe(payload.length);
        expect(decodeLensAttestation('decision', bytes, { nowSeconds: LENS_NOW }).fields).toEqual(FIELDS);
    });

    it('lands a retry on the same attestation, and another source time on another', async () => {
        const { member, issuer } = lensMember();
        const first = await member.attestDecision(FIELDS);
        const again = await member.attestDecision({ ...FIELDS });
        expect(again).toMatchObject({ address: first.address, reused: true });
        expect(issuer.accounts.size).toBe(1);
        const later = await member.attestDecision({ ...FIELDS, sourceObservedAt: NOW + 5 });
        expect(later.address).not.toBe(first.address);
        expect((await member.status()).counts).toMatchObject({ decision: 2, agreements: 1 });
    });

    it('states satisfied only, never in the future, for a CID and a sponsor wallet', async () => {
        const { member, issuer } = lensMember();
        for (const fields of [
            { ...FIELDS, decision: 'refused' },
            { ...FIELDS, decision: 'pending' },
            { ...FIELDS, sourceObservedAt: LENS_NOW + 1 },
            { ...FIELDS, sponsor: 'not-a-wallet' },
            { ...FIELDS, agreementCid: 'agreement-1' },
            { ...FIELDS, evidenceRef: '' }
        ]) {
            await expect(member.attestDecision(fields)).rejects.toMatchObject({ status: 422, code: 'invalid_decision' });
        }
        expect(issuer.accounts.size).toBe(0);
    });

    it('finds the decision it issued for an agreement and sponsor, and no one else\'s', async () => {
        const store = createMemoryStore();
        const { member } = lensMember({ store });
        const other = lensMember({ authority: OTHER_LENS, store });
        expect(await member.findDecision({ agreementCid: CID, sponsor: SPONSOR })).toBeNull();
        // Another member's decision on the same agreement, in the same store, is not this member's.
        await other.member.attestDecision(FIELDS);
        expect(await member.findDecision({ agreementCid: CID, sponsor: SPONSOR })).toBeNull();
        const issued = await member.attestDecision(FIELDS);
        expect(await member.findDecision({ agreementCid: CID, sponsor: SPONSOR })).toMatchObject({ address: issued.address, authority: MEMBER });
        // The same CID under another sponsor is another account; another CID is another agreement.
        expect(await member.findDecision({ agreementCid: CID, sponsor: OTHER_LENS })).toBeNull();
        expect(await member.findDecision({ agreementCid: cidOfObject(content({ title: 'Counter-agreement' })), sponsor: SPONSOR })).toBeNull();
    });
});

describe('POST /lens/agreements/:cid/decision', () => {
    // The member with an agreement index: GET /agreements/:cid rows by CID, and the relayed receipts.
    function memberApp({ rows = [indexed()], receipts = [], operatorToken = TOKEN, withIndex = true } = {}) {
        const { member, issuer, store } = lensMember();
        const index = { rows, receipts };
        const agreements = withIndex ? {
            load: vi.fn(async cid => index.rows.find(row => row.cid === cid) ?? null),
            decisions: vi.fn(async cid => (index.rows.some(row => row.cid === cid) ? index.receipts : []))
        } : null;
        const app = createLensMemberApp({ member, pricing: createLensPricing({ dryRun: true }), operatorToken, agreements, clock });
        return { app, member, issuer, store, index, agreements };
    }
    const ask = (app, cid = CID, token = TOKEN) => {
        const call = request(app).post(`/lens/agreements/${cid}/decision`);
        return token ? call.set(OPERATOR_TOKEN_HEADER, token) : call;
    };

    it('decides from the index alone: 201 with the attestation and the tally once every owner approved', async () => {
        const receipts = await unanimous();
        const { app, issuer, agreements } = memberApp({ receipts });
        // Whatever the caller sends is ignored: the CID is the whole request.
        const res = await ask(app).send({ decision: 'refused', sponsor: OTHER_LENS, sourceObservedAt: 1 });
        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({
            kind: 'decision', authority: MEMBER, reused: false, counted: 4, tally: { passed: true, acceptedOwners: 4 },
            payload: { agreementCid: CID, sponsor: SPONSOR, decision: 'satisfied', evidenceRef: hashOf(receipts), sourceObservedAt: NOW + 4 }
        });
        expect(agreements.load).toHaveBeenCalledWith(CID);
        expect(agreements.decisions).toHaveBeenCalledWith(CID);
        expect(decodeLensAttestation('decision', issuer.accounts.get(res.body.address)).fields).toEqual(res.body.payload);
        // The member console and the agreement panel read this answer (frontend/js/lens-core.js).
        expect(LensCore.readDecisionAnswer(res.body, CID)).toMatchObject({ ok: true, address: res.body.address, decision: 'satisfied', counted: 4,
            tally: { passed: true, acceptedOwners: 4, totalOwners: 4 } });
        // What the browser reads to record it on chain (vocabulary.md "M3 state", browser side).
        const listed = await request(app).get('/lens/attestations').query({ kind: 'decision', agreementCid: CID });
        expect(listed.body.attestations.map(row => row.address)).toEqual([res.body.address]);
        expect(listed.body.attestations[0]).not.toHaveProperty('reused');
    });

    it('answers the decision it issued, once, whatever the index says later', async () => {
        const receipts = await unanimous();
        const { app, issuer, index } = memberApp({ receipts });
        const first = await ask(app);
        expect(first.status).toBe(201);
        // Owner C withdraws and the account records the decision: asked again, the member answers what it issued.
        index.receipts = [...receipts, await signed(wallets.c, 'owner-c', { decision: 'withdraw', offset: 5 })];
        index.rows = [indexed(content(), { onchain: onchain({ decision: 'satisfied' }) })];
        const again = await ask(app);
        expect(again.status).toBe(200);
        expect(again.body).toMatchObject({ address: first.body.address, reused: true, payload: first.body.payload, tally: { passed: false }, counted: 3 });
        expect(issuer.accounts.size).toBe(1);
    });

    it('refuses with the tally while the rule is not met, and for every other reason before issuing anything', async () => {
        const receipts = await unanimous();
        const cases = [
            [{ receipts: receipts.slice(0, 3) }, 409, 'rule_not_met'],
            [{ receipts, rows: [indexed(content({ sponsor: null }))] }, 422, 'no_sponsor'],
            [{ receipts, rows: [indexed(content(), { onchain: onchain({ lens: OTHER_LENS }) })] }, 409, 'not_agreement_lens'],
            [{ receipts, rows: [indexed(content(), { status: 'cancelled', onchain: onchain({ status: 'cancelled' }) })] }, 409, 'agreement_closed'],
            [{ receipts, rows: [indexed(content(), { onchain: onchain({ decision: 'satisfied' }) })] }, 409, 'decision_recorded'],
            [{ receipts, rows: [indexed(content({ deadline: at(20) }), { status: 'expired' })] }, 409, 'deadline_passed']
        ];
        for (const [setup, status, code] of cases) {
            const { app, issuer } = memberApp(setup);
            const body = setup.rows ? setup.rows[0] : indexed();
            const res = await ask(app, body.cid);
            expect({ code, status: res.status, error: res.body.error }).toEqual({ code, status, error: code });
            expect(res.body.tally).toMatchObject({ ready: true });
            expect(issuer.accounts.size).toBe(0);
        }
        // An agreement whose lens does not include this member.
        const foreign = content({ rule: { electorate: 'owners', binding: true, approvalConfig, lens: [OTHER_LENS] } });
        const { app, issuer } = memberApp({ rows: [indexed(foreign)] });
        const res = await ask(app, cidOfObject(foreign));
        expect([res.status, res.body.error]).toEqual([409, 'not_in_lens']);
        expect(issuer.accounts.size).toBe(0);
    });

    it('reads the index as lens/run.mjs wires it: the agreement row and the relay\'s stored receipts in the API database', async () => {
        const receipts = await unanimous();
        const pool = createMockPool();
        pool.answer(/FROM consensus\.agreement WHERE cid = \$1/, (sql, params) => ({ rows: params[0] === CID ? [agreementRow(content())] : [] }));
        pool.answer(/FROM consensus\.agreement_decision WHERE agreement_cid = \$1/, { rows: receipts.map(receipt => ({ receipt })) });
        const decisionStore = createAgreementDecisionStore(pool);
        const { member } = lensMember();
        const app = createLensMemberApp({ member, pricing: createLensPricing({ dryRun: true }), operatorToken: TOKEN, clock,
            agreements: { load: cid => loadAgreement(pool, cid), decisions: cid => decisionStore.list(cid) } });
        const res = await request(app).post(`/lens/agreements/${CID}/decision`).set(OPERATOR_TOKEN_HEADER, TOKEN);
        expect(res.status).toBe(201);
        expect(res.body.payload).toMatchObject({ agreementCid: CID, sponsor: SPONSOR, evidenceRef: hashOf(receipts), sourceObservedAt: NOW + 4 });
        // The status the member judges is the index's (chain once minted, else the deadline), read with the row.
        const statement = pool.getCalls().find(call => /FROM consensus\.agreement WHERE cid = \$1/.test(call.sql));
        expect(statement.sql).toMatch(/onchain->>'status' IN \('executed', 'cancelled', 'expired'\)/);
        expect(statement.params).toEqual([CID]);
    });

    it('is operator-only, needs the index, and refuses what is not an indexed agreement CID', async () => {
        const { app } = memberApp({ receipts: await unanimous() });
        expect([(await ask(app, CID, null)).status, (await ask(app, CID, null)).body.error]).toEqual([401, 'operator_only']);
        expect((await ask(app, CID, 'guess')).body.error).toBe('operator_only');
        expect([(await ask(app, 'proposal-17')).status, (await ask(app, 'proposal-17')).body.error]).toEqual([400, 'bad_request']);
        const unknown = await ask(app, cidOfObject(content({ title: 'Never indexed' })));
        expect([unknown.status, unknown.body.error]).toEqual([404, 'agreement_not_found']);

        const noToken = memberApp({ operatorToken: null });
        expect([(await ask(noToken.app)).status, (await ask(noToken.app)).body.error]).toEqual([503, 'operator_not_configured']);
        const noIndex = memberApp({ withIndex: false });
        expect([(await ask(noIndex.app)).status, (await ask(noIndex.app)).body.error]).toEqual([503, 'agreements_not_configured']);
        const status = await request(noIndex.app).get('/lens/status');
        expect(status.body.decisions).toEqual({ operatorToken: true, agreementIndex: false });
        expect((await request(app).get('/lens/status')).body.decisions).toEqual({ operatorToken: true, agreementIndex: true });
    });
});
