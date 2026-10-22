// Lens-backed owner approval end to end: a lens member attests an agreement's rights snapshot and
// which owners a wallet may act for (against its --rights registry file), wallets sign their own
// decisions over the agreement's CID (plan-design-agreement.md M2), and every receipt verifies from its
// signatures alone; those receipts are what the member later counts for its AgreementDecision (M3,
// lens-agreement-decision.test.js). Milestone: four owners across three parcels, one of them co-owned.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import request from 'supertest';
import { Keypair } from '@solana/web3.js';
import { createLensMember } from '../lens/member.js';
import { createDevnetRegistryIdentity } from '../lens/identity/devnet-registry.js';
import { createFakeIssuer } from '../lens/issuers.js';
import { createMemoryStore } from '../lens/store.js';
import { createLensPricing } from '../lens/pricing.js';
import { createLensMemberApp } from '../lens/server.js';
import { createApprovalAttester, fileRegistry, normalizeRegistry } from '../lens/approval.js';
import { cidOf, cidOfObject } from '../cid.js';
import { OPERATOR_TOKEN_HEADER } from '../lens/server.js';
import { serializeAgreementRow } from '../routes/agreements.js';
import { agreementRow } from './helpers/content-fixtures.js';
import { agreementContent } from './helpers/approval-decisions.js';

const require = createRequire(import.meta.url);
const approval = require('../../frontend/js/proposals/approval.js');
const proof = require('../../frontend/js/proposals/approval-proof.js');
const LensCore = require('../../frontend/js/lens-core.js');
const { createLensWalletAuthority } = require('../../frontend/js/proposals/approval-lens-authority.js');
const providerSource = readFileSync(new URL('../../frontend/js/proposals/approval-providers.js', import.meta.url), 'utf8');
const runtimeSource = readFileSync(new URL('../../frontend/js/proposals/approval-runtime.js', import.meta.url), 'utf8');

// Decisions are stamped with the real clock, so the member's clock sits just before it.
const NOW = Math.floor(Date.now() / 1000) - 60;
const clock = { nowSeconds: () => NOW };
const isoAt = seconds => new Date(seconds * 1000).toISOString();
const nowMs = () => NOW * 1000;

function wallet() {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const address = LensCore.base58Encode(new Uint8Array(Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url')));
    const signText = text => LensCore.base58Encode(new Uint8Array(sign(null, Buffer.from(text, 'utf8'), privateKey)));
    return { address, signMessage: async text => signText(text), signText };
}

const wallets = { a: wallet(), b: wallet(), c: wallet(), d: wallet(), stranger: wallet() };
const memberKeypair = Keypair.generate();
const MEMBER = memberKeypair.publicKey.toBase58();

// Parcel A: Owner A. Parcel B: Owner B. Parcel C: Owners C and D, half each.
const parcels = [
    { parcelId: 'parcel-a', areaM2: 100, owners: [{ ownerId: 'owner-a', share: '1/1' }] },
    { parcelId: 'parcel-b', areaM2: 50, owners: [{ ownerId: 'owner-b', share: '1/1' }] },
    { parcelId: 'parcel-c', areaM2: 25, owners: [{ ownerId: 'owner-c', share: '1/2' }, { ownerId: 'owner-d', share: '1/2' }] }
];
const registryJson = () => ({
    schema: 'lens-rights-registry/v1',
    parcels,
    signers: ['a', 'b', 'c', 'd'].map(id => ({ ownerId: `owner-${id}`, wallet: wallets[id].address }))
});
// The agreement-like subject of the decisions: a published agreement's CID, its input parcels and rule.
const AGREEMENT_CID = cidOf(Buffer.from('lr-lens-approval agreement'));
const OTHER_CID = cidOf(Buffer.from('another agreement'));
const agreement = (overrides = {}) => ({
    agreementCid: AGREEMENT_CID,
    cadastreParcelIds: ['parcel-a', 'parcel-b', 'parcel-c'],
    approvalConfig: {
        schema: 'proposal-approval/v1',
        rights: { schema: 'parcel-rights/v1', source: { provider: 'upload', reference: 'register-2026-10' }, parcels: parcels.map(p => ({ ...p, complete: true })) },
        policy: { type: 'unanimous' }
    },
    lens: [MEMBER],
    ...overrides
});
const contextOf = item => ({ cadastreParcelIds: item.cadastreParcelIds, approvalConfig: item.approvalConfig, lens: item.lens });

function memberApp({ registry = registryJson(), keypair = memberKeypair, validitySeconds } = {}) {
    const issuer = createFakeIssuer({ authority: keypair.publicKey.toBase58(), clock });
    const identity = createDevnetRegistryIdentity({ rows: [], clock, authority: keypair.publicKey.toBase58() });
    const member = createLensMember({ authority: keypair.publicKey.toBase58(), issuer, store: createMemoryStore(), identity, clock, dryRun: true });
    // The member's --rights file (lens/run.mjs); its devnet owner registry is covered in lens-approval-registry.test.js.
    const approvalAttester = registry ? createApprovalAttester({ keypair, registry: fileRegistry(registry), clock, validitySeconds }) : null;
    return createLensMemberApp({ member, pricing: createLensPricing({ dryRun: true }), approvalAttester });
}

// One loopback server per member for a whole test: supertest's per-request servers churn
// ephemeral ports, and with many suites in parallel a request can reach another suite's server.
const servers = [];
function serve(app) {
    const server = app.listen(0);
    servers.push(server);
    return server;
}
afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))));
});

async function authorityFor(app, who, item = agreement()) {
    const contextHash = approval.contextHash(item);
    const challenged = await request(app).post('/lens/approval/challenge').send({ wallet: who.address, contextHash });
    expect(challenged.status).toBe(201);
    return request(app).post('/lens/approval/authority')
        .send({ ...contextOf(item), wallet: who.address, challenge: challenged.body.challenge, signature: who.signText(challenged.body.message) });
}

describe('approval proof statements', () => {
    it('verifies member-signed facts and rejects any change to a signed field', async () => {
        const app = serve(memberApp());
        const response = await authorityFor(app, wallets.c);
        expect(response.status).toBe(201);
        const { rights, authority } = response.body;
        expect(rights).toMatchObject({ schema: proof.RIGHTS_SCHEMA, member: MEMBER, parcelIds: ['parcel-a', 'parcel-b', 'parcel-c'],
            issuedAt: isoAt(NOW), expiresAt: isoAt(NOW + 7 * 24 * 3600) });
        expect(authority).toHaveLength(1);
        expect(authority[0]).toMatchObject({ schema: proof.AUTHORITY_SCHEMA, ownerId: 'owner-c', actorId: wallets.c.address });
        expect(proof.verifyAttestation(rights, proof.RIGHTS_SCHEMA)).toBe(true);
        expect(proof.verifyAttestation(authority[0], proof.AUTHORITY_SCHEMA)).toBe(true);
        expect(proof.verifyAttestation(authority[0], proof.RIGHTS_SCHEMA)).toBe(false);

        const mutations = [
            fact => ({ ...fact, ownerId: 'owner-d' }),
            fact => ({ ...fact, actorId: wallets.d.address }),
            fact => ({ ...fact, contextHash: 'approval1-sha256:other' }),
            fact => ({ ...fact, expiresAt: '2027-10-19T10:13:20.000Z' }),
            fact => ({ ...fact, member: wallets.a.address }),
            fact => ({ ...fact, signature: wallets.c.signText(proof.attestationMessage(proof.statementOf(fact))) }),
            fact => ({ ...fact, signature: 'not-base58-0OIl' })
        ];
        mutations.forEach(mutate => expect(proof.verifyAttestation(mutate(authority[0]), proof.AUTHORITY_SCHEMA)).toBe(false));
        expect(proof.verifyAttestation({ ...rights, parcelIds: ['parcel-c', 'parcel-a', 'parcel-b'] }, proof.RIGHTS_SCHEMA)).toBe(false);
    });

    it('signs decisions over a readable summary plus every canonical field', () => {
        const statement = approval.decisionContent(agreement(), {
            ownerId: 'owner-c', actorId: wallets.c.address, decision: 'approve', decidedAt: '2026-10-12T10:14:00.000Z'
        });
        expect(statement).toEqual({ schema: 'agreement-decision/v1', agreementCid: AGREEMENT_CID, ownerId: 'owner-c', actorId: wallets.c.address,
            contextHash: approval.contextHash(agreement()), decision: 'approve', decidedAt: '2026-10-12T10:14:00.000Z' });
        const message = proof.decisionMessage(statement);
        expect(message.split('\n').slice(0, 5)).toEqual([
            'Urban Game Theory owner decision',
            'Accept the agreement as owner owner-c.',
            `Agreement: ${AGREEMENT_CID}`,
            `Approval context: ${approval.contextHash(agreement())}`,
            'Signed at: 2026-10-12T10:14:00.000Z'
        ]);
        expect(message.endsWith(approval.stableStringify(statement))).toBe(true);
        expect(proof.decisionMessage({ ...statement, decision: 'withdraw' })).toContain('Withdraw the acceptance of the agreement as owner owner-c.');
        expect(proof.verifySignature(wallets.c.address, message, wallets.c.signText(message))).toBe(true);
        expect(proof.verifySignature(wallets.d.address, message, wallets.c.signText(message))).toBe(false);
        expect(proof.verifySignature(wallets.c.address, `${message} `, wallets.c.signText(message))).toBe(false);
    });
});

describe('lens member approval routes', () => {
    it('reports approval capability and refuses when no registry is configured', async () => {
        const plain = serve(memberApp({ registry: null }));
        expect((await request(plain).get('/lens/status')).body.approval).toBeNull();
        const refused = await request(plain).post('/lens/approval/rights').send(contextOf(agreement()));
        expect(refused.status).toBe(503);
        expect(refused.body.error).toBe('approval_not_configured');

        const status = await request(serve(memberApp())).get('/lens/status');
        expect(status.body.approval).toMatchObject({ enabled: true, source: 'file', parcels: 3, owners: 4, authorities: 0, signers: 4 });
    });

    it('attests a matching snapshot and refuses mismatched, incomplete, unknown or out-of-lens contexts', async () => {
        const app = serve(memberApp());
        const attested = await request(app).post('/lens/approval/rights').send(contextOf(agreement()));
        expect(attested.status).toBe(201);
        expect(attested.body.rights.contextHash).toBe(approval.contextHash(agreement()));

        const refuse = async (item, status, code) => {
            const response = await request(app).post('/lens/approval/rights').send(contextOf(item));
            expect({ status: response.status, code: response.body.error }).toEqual({ status, code });
        };
        const withParcels = rows => agreement({ approvalConfig: { ...agreement().approvalConfig,
            rights: { ...agreement().approvalConfig.rights, parcels: rows } } });
        await refuse(withParcels(parcels.map(p => p.parcelId === 'parcel-c'
            ? { ...p, complete: true, owners: [{ ownerId: 'owner-c', share: '2/3' }, { ownerId: 'owner-d', share: '1/3' }] }
            : { ...p, complete: true })), 409, 'rights_mismatch');
        await refuse(withParcels(parcels.map(p => ({ ...p, complete: true, areaM2: p.parcelId === 'parcel-b' ? 51 : p.areaM2 }))), 409, 'area_mismatch');
        await refuse(withParcels(parcels.map(p => ({ ...p, complete: p.parcelId !== 'parcel-c' }))), 422, 'rights_incomplete');
        await refuse(agreement({ cadastreParcelIds: ['parcel-a', 'parcel-z'], approvalConfig: { ...agreement().approvalConfig,
            rights: { ...agreement().approvalConfig.rights, parcels: [{ ...parcels[0], complete: true },
                { parcelId: 'parcel-z', complete: true, areaM2: 10, owners: [{ ownerId: 'owner-z', share: '1/1' }] }] } } }), 404, 'unknown_parcel');
        await refuse(agreement({ lens: [wallets.a.address] }), 409, 'not_in_lens');
        await refuse(agreement({ approvalConfig: null }), 422, 'rights_incomplete');
    });

    it('names only the owners a wallet may act for, after it proves control of that wallet', async () => {
        const app = serve(memberApp());
        for (const id of ['a', 'b', 'c', 'd']) {
            const response = await authorityFor(app, wallets[id]);
            expect(response.status).toBe(201);
            expect(response.body.authority.map(fact => [fact.ownerId, fact.actorId])).toEqual([[`owner-${id}`, wallets[id].address]]);
        }
        const stranger = await authorityFor(app, wallets.stranger);
        expect({ status: stranger.status, code: stranger.body.error }).toEqual({ status: 403, code: 'not_authorized' });

        const contextHash = approval.contextHash(agreement());
        const challenged = await request(app).post('/lens/approval/challenge').send({ wallet: wallets.c.address, contextHash });
        expect(challenged.body.message).toBe(proof.approvalChallengeMessage({
            member: MEMBER, wallet: wallets.c.address, contextHash, challenge: challenged.body.challenge, expiresAt: challenged.body.expiresAt
        }));
        const send = body => request(app).post('/lens/approval/authority').send({ ...contextOf(agreement()), challenge: challenged.body.challenge, ...body });
        expect((await send({ wallet: wallets.c.address, signature: wallets.d.signText(challenged.body.message) })).body.error).toBe('bad_signature');
        expect((await send({ wallet: wallets.d.address, signature: wallets.d.signText(challenged.body.message) })).body.error).toBe('challenge_mismatch');
        const otherContext = await request(app).post('/lens/approval/authority').send({
            ...contextOf(agreement({ approvalConfig: { ...agreement().approvalConfig, policy: { type: 'threshold',
                owners: { numerator: 1, denominator: 2, strict: false }, area: { numerator: 1, denominator: 2, strict: false } } } })),
            wallet: wallets.c.address, challenge: challenged.body.challenge, signature: wallets.c.signText(challenged.body.message)
        });
        expect(otherContext.body.error).toBe('context_mismatch');
        const ok = await send({ wallet: wallets.c.address, signature: wallets.c.signText(challenged.body.message) });
        expect(ok.status).toBe(201);
        const reused = await send({ wallet: wallets.c.address, signature: wallets.c.signText(challenged.body.message) });
        expect(reused.body.error).toBe('challenge_unknown');
    });

    it('accepts large rights snapshots on approval routes only', async () => {
        const app = serve(memberApp());
        const padded = agreement();
        padded.approvalConfig.rights.parcels = [...padded.approvalConfig.rights.parcels,
            ...Array.from({ length: 700 }, (_, index) => ({ parcelId: `outside-${String(index).padStart(4, '0')}`, complete: false, areaM2: null, owners: [] }))];
        expect(JSON.stringify(contextOf(padded)).length).toBeGreaterThan(40 * 1024);
        expect((await request(app).post('/lens/approval/rights').send(contextOf(padded))).status).toBe(201);
        expect((await request(app).post('/lens/challenge').send({ parcelUid: 'x'.repeat(40 * 1024), owner: wallets.a.address })).status).toBe(413);
    });

    it('refuses an attester signing with a key other than the member key', () => {
        const other = Keypair.generate();
        const issuer = createFakeIssuer({ authority: MEMBER, clock });
        const identity = createDevnetRegistryIdentity({ rows: [], clock, authority: MEMBER });
        const member = createLensMember({ authority: MEMBER, issuer, store: createMemoryStore(), identity, clock, dryRun: true });
        const approvalAttester = createApprovalAttester({ keypair: other, registry: fileRegistry(registryJson()), clock });
        expect(() => createLensMemberApp({ member, pricing: createLensPricing({ dryRun: true }), approvalAttester }))
            .toThrow(/signs as/);
        expect(() => normalizeRegistry({ ...registryJson(), signers: [{ ownerId: 'owner-x', wallet: wallets.a.address }] }))
            .toThrow(/no registered right or authority/);
    });
});

describe('four owners across three parcels approve only for themselves', () => {
    let server;
    let serviceUrl;
    beforeAll(async () => {
        server = memberApp().listen(0);
        await new Promise(resolve => server.once('listening', resolve));
        serviceUrl = `http://127.0.0.1:${server.address().port}`;
    });
    afterAll(() => new Promise(resolve => server.close(resolve)));

    function runtime() {
        const context = createContext({ ProposalApproval: approval, console, TextEncoder });
        runInContext(providerSource, context);
        runInContext(runtimeSource, context);
        let current = null;
        const authority = createLensWalletAuthority({ wallet: () => current, now: nowMs });
        context.ProposalApprovalAuthorities.register('lens-wallet', authority.provider);
        return { context, authority, use: who => { current = who; } };
    }
    const actor = { id: 'profile-1' }; // One local profile; the connected wallet is the signer.

    it('verifies each wallet, counts co-owners whole, survives reload and rejects tampering', async () => {
        const { context, authority, use } = runtime();
        const item = agreement();
        const runtimeApi = context.ProposalApprovalRuntime;
        const decide = (parcelId, ownerId, withdraw = false) => runtimeApi.decide(item, parcelId, ownerId, actor, withdraw);

        // Without lens evidence nobody can act, even with a wallet connected.
        use(wallets.c);
        expect(await decide('parcel-c', 'owner-c')).toEqual({ error: 'authority-unresolved' });
        // An agreement not yet proposed has no CID to sign.
        expect(await runtimeApi.decide(agreement({ agreementCid: undefined }), 'parcel-c', 'owner-c', actor)).toEqual({ error: 'not-proposed' });

        for (const id of ['a', 'b', 'c', 'd']) {
            use(wallets[id]);
            await expect(authority.verifyOwner(item, { memberKey: MEMBER, serviceUrl })).resolves.toEqual({ wallet: wallets[id].address, ownerIds: [`owner-${id}`] });
        }
        use(wallets.stranger);
        await expect(authority.verifyOwner(item, { memberKey: MEMBER, serviceUrl })).rejects.toMatchObject({ code: 'not_authorized' });
        await expect(authority.verifyOwner(item, { memberKey: wallets.a.address, serviceUrl })).rejects.toMatchObject({ code: 'member-not-in-lens' });

        use(wallets.a);
        expect(runtimeApi.authorizedOwnerIds(item, actor)).toEqual(['owner-a']);
        expect(await decide('parcel-a', 'owner-a')).toMatchObject({ acceptedOwners: 1, acceptedParcelIds: ['parcel-a'], passed: false });
        use(wallets.c);
        expect(runtimeApi.authorizedOwnerIds(item, actor)).toEqual(['owner-c']);
        expect(await decide('parcel-c', 'owner-d')).toEqual({ error: 'authority-unresolved' });
        expect(await decide('parcel-c', 'owner-c')).toMatchObject({ acceptedOwners: 2, acceptedParcelIds: ['parcel-a'], acceptedAreaM2: 100 });
        const halfC = runtimeApi.state(item, 'parcel-c', actor).entries;
        expect(halfC.map(entry => [entry.ownerId, entry.accepted, entry.canAccept, entry.canUndo]))
            .toEqual([['owner-c', true, false, true], ['owner-d', false, false, false]]);
        use(wallets.d);
        expect(await decide('parcel-c', 'owner-d')).toMatchObject({ acceptedOwners: 3, acceptedParcelIds: ['parcel-a', 'parcel-c'], acceptedAreaM2: 125 });
        use(wallets.b);
        expect(await decide('parcel-b', 'owner-b')).toMatchObject({ acceptedOwners: 4, acceptedAreaM2: 175, passed: true });

        const receipt = item.ownerApprovals['owner-c'];
        expect(receipt).toMatchObject({ ownerId: 'owner-c', actorId: wallets.c.address, providerId: 'lens-wallet', decision: 'approve',
            decisionProof: { scheme: proof.DECISION_SCHEME } });
        expect(receipt.evidence.authority).toMatchObject({ member: MEMBER, ownerId: 'owner-c', actorId: wallets.c.address });

        // Reload: a fresh browser with no evidence cache and no wallet still verifies every receipt.
        const reloaded = runtime();
        const stored = JSON.parse(JSON.stringify(item));
        expect(reloaded.context.ProposalApprovalRuntime.summary(stored)).toMatchObject({ acceptedOwners: 4, totalOwners: 4, passed: true });
        // The same receipts on another agreement (another CID) count for nothing.
        expect(reloaded.context.ProposalApprovalRuntime.summary({ ...JSON.parse(JSON.stringify(stored)), agreementCid: OTHER_CID }))
            .toMatchObject({ acceptedOwners: 0, passed: false });

        const tampered = [
            copy => { copy.ownerApprovals['owner-c'].decidedAt = new Date(Date.parse(copy.ownerApprovals['owner-c'].decidedAt) + 1000).toISOString(); },
            copy => { copy.ownerApprovals['owner-c'].decisionProof.signature = copy.ownerApprovals['owner-d'].decisionProof.signature; },
            copy => { copy.ownerApprovals['owner-c'].actorId = wallets.d.address; },
            copy => { copy.ownerApprovals['owner-c'].evidence.authority = copy.ownerApprovals['owner-d'].evidence.authority; },
            copy => { copy.ownerApprovals['owner-c'].decidedAt = isoAt(NOW + 30 * 24 * 3600); }
        ];
        for (const mutate of tampered) {
            const copy = JSON.parse(JSON.stringify(stored));
            mutate(copy);
            expect(reloaded.context.ProposalApprovalRuntime.validIds(copy)).toEqual(['owner-a', 'owner-b', 'owner-d']);
        }
        // Evidence from a member outside the lens never counts, even when its signatures are valid.
        const outsideLens = { ...stored, lens: [Keypair.generate().publicKey.toBase58()] };
        expect(reloaded.context.ProposalApprovalRuntime.summary(outsideLens).acceptedOwners).toBe(0);

        // Only the signer who recorded an acceptance withdraws it; the co-owned parcel stops counting.
        use(wallets.d);
        await expect(decide('parcel-c', 'owner-d', true)).resolves.toMatchObject({ acceptedOwners: 3, acceptedParcelIds: ['parcel-a', 'parcel-b'], passed: false });
        expect(item.ownerApprovalHistory.at(-1)).toMatchObject({ ownerId: 'owner-d', decision: 'withdraw', actorId: wallets.d.address });
    });

    it('lets an owner-and-area threshold pass without the co-owned parcel', async () => {
        const { context, authority, use } = runtime();
        const item = agreement({ approvalConfig: { ...agreement().approvalConfig, policy: { type: 'threshold',
            owners: { numerator: 1, denominator: 2, strict: false }, area: { numerator: 7, denominator: 10, strict: false } } } });
        for (const id of ['a', 'c']) {
            use(wallets[id]);
            await authority.verifyOwner(item, { memberKey: MEMBER, serviceUrl });
        }
        use(wallets.a);
        await context.ProposalApprovalRuntime.decide(item, 'parcel-a', 'owner-a', actor);
        use(wallets.c);
        // Two of four owners (50%) but only 100 of 175 m² (57%): parcel C needs both co-owners.
        expect(await context.ProposalApprovalRuntime.decide(item, 'parcel-c', 'owner-c', actor))
            .toMatchObject({ acceptedOwners: 2, acceptedAreaM2: 100, passed: false,
                tests: [expect.objectContaining({ measure: 'area', met: false }), expect.objectContaining({ measure: 'headcount', met: true })] });
    });

    it('counts the receipts the browser recorded into the member\'s AgreementDecision for the published agreement', async () => {
        // The published owner deal over the three parcels, with this member as its lens and a sponsor wallet.
        const sponsor = Keypair.generate().publicKey.toBase58();
        const content = agreementContent({ sponsor, deadline: isoAt(NOW + 7 * 86400),
            rule: { electorate: 'owners', binding: true, approvalConfig: agreement().approvalConfig, lens: [MEMBER] } });
        const cid = cidOfObject(content);
        const item = agreement({ agreementCid: cid });
        const { context, authority, use } = runtime();
        for (const [id, parcelId] of [['a', 'parcel-a'], ['b', 'parcel-b'], ['c', 'parcel-c'], ['d', 'parcel-c']]) {
            use(wallets[id]);
            await authority.verifyOwner(item, { memberKey: MEMBER, serviceUrl });
            await context.ProposalApprovalRuntime.decide(item, parcelId, `owner-${id}`, actor);
        }
        const receipts = Object.values(item.ownerApprovals);
        expect(receipts).toHaveLength(4);

        // The same member, asked by its operator, reads the index and the relayed receipts (decisions are
        // stamped with the real clock, so this member's clock is the real one).
        const realClock = { nowSeconds: () => Math.floor(Date.now() / 1000) + 1 };
        const issuer = createFakeIssuer({ authority: MEMBER, clock: realClock });
        const identity = createDevnetRegistryIdentity({ rows: [], clock: realClock, authority: MEMBER });
        const member = createLensMember({ authority: MEMBER, issuer, store: createMemoryStore(), identity, clock: realClock, dryRun: true });
        const row = serializeAgreementRow(agreementRow(content));
        const app = createLensMemberApp({ member, pricing: createLensPricing({ dryRun: true }), operatorToken: 'op', clock: realClock,
            agreements: { load: async asked => (asked === cid ? row : null), decisions: async () => [...receipts].reverse() } });
        const res = await request(app).post(`/lens/agreements/${cid}/decision`).set(OPERATOR_TOKEN_HEADER, 'op');
        expect(res.status).toBe(201);
        // Signing order: by decidedAt, then by signature (code units), as the relay folds them.
        const inSigningOrder = [...receipts].sort((x, y) => Date.parse(x.decidedAt) - Date.parse(y.decidedAt)
            || (x.decisionProof.signature < y.decisionProof.signature ? -1 : 1));
        expect(res.body.payload).toEqual({
            agreementCid: cid, sponsor, decision: 'satisfied',
            evidenceRef: `sha256:${createHash('sha256').update(approval.stableStringify(inSigningOrder), 'utf8').digest('hex')}`,
            sourceObservedAt: Math.floor(Date.parse(inSigningOrder.at(-1).decidedAt) / 1000)
        });
        expect(res.body).toMatchObject({ counted: 4, tally: { passed: true, acceptedOwners: 4 } });
    });

    it('refuses evidence that does not verify before keeping it, and never signs for another wallet', async () => {
        const forged = Keypair.generate();
        const forger = serve(memberApp({ keypair: forged }));
        const item = agreement({ lens: [MEMBER, forged.publicKey.toBase58()] });
        // A member that signs with its own key cannot pass its facts off as another lens member's.
        const fetchImpl = async (url, init) => {
            const response = await request(forger)[init.method.toLowerCase()](new URL(url).pathname).set(init.headers).send(init.body ? JSON.parse(init.body) : undefined);
            return { status: response.status, json: async () => response.body };
        };
        let current = wallets.c;
        const authority = createLensWalletAuthority({ wallet: () => current, now: nowMs, fetchImpl });
        await expect(authority.verifyOwner(item, { memberKey: MEMBER, serviceUrl: 'http://forger.invalid' }))
            .rejects.toMatchObject({ code: 'bad-challenge' });
        await expect(authority.verifyOwner(item, { memberKey: forged.publicKey.toBase58(), serviceUrl: 'http://forger.invalid' }))
            .resolves.toMatchObject({ ownerIds: ['owner-c'] });
        current = wallets.d;
        const receipt = { ownerId: 'owner-c', actorId: wallets.c.address };
        await expect(authority.provider.signDecision({ receipt, statement: {} })).rejects.toMatchObject({ code: 'wrong-wallet' });
    });
});
