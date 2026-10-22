// The registries a lens member checks agreement approval facts against (lens/approval.js): its devnet
// owner registry read through the identity adapter on every request (devnetOwnerRegistry: each recorded
// wallet owns its parcel in equal shares and acts for itself) or a static lens-rights-registry/v1 file
// (fileRegistry, the member's --rights), the async attester over either, and what /lens/status reports.
import { generateKeyPairSync, sign } from 'node:crypto';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { Keypair } from '@solana/web3.js';
import { createApprovalAttester, devnetOwnerRegistry, fileRegistry } from '../lens/approval.js';
import { createLensMember } from '../lens/member.js';
import { createDevnetRegistryIdentity } from '../lens/identity/devnet-registry.js';
import { createFakeIssuer } from '../lens/issuers.js';
import { createMemoryStore } from '../lens/store.js';
import { createLensPricing } from '../lens/pricing.js';
import { createLensMemberApp } from '../lens/server.js';

const require = createRequire(import.meta.url);
const approval = require('../../frontend/js/proposals/approval.js');
const proof = require('../../frontend/js/proposals/approval-proof.js');
const LensCore = require('../../frontend/js/lens-core.js');

const NOW = 1790000000;
const clock = { nowSeconds: () => NOW };
const memberKeypair = Keypair.generate();
const MEMBER = memberKeypair.publicKey.toBase58();

function wallet() {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const address = LensCore.base58Encode(new Uint8Array(Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url')));
    return { address, signText: text => LensCore.base58Encode(new Uint8Array(sign(null, Buffer.from(text, 'utf8'), privateKey))) };
}
const ana = wallet();
const ben = wallet();
const cleo = wallet();
const stranger = wallet();

// A binding owners' agreement's approval context with the rights snapshot read from the devnet owner
// registry (docs-agents.md §4: each owner wallet is its ownerId, equal shares, no area).
const devnetParcel = (parcelId, wallets) => ({ parcelId, complete: true, areaM2: null,
    owners: wallets.map(owner => ({ ownerId: owner.address, share: `1/${wallets.length}` })) });
const context = (parcels, lens = [MEMBER]) => ({
    cadastreParcelIds: parcels.map(parcel => parcel.parcelId),
    approvalConfig: { schema: 'proposal-approval/v1', policy: { type: 'unanimous' },
        rights: { schema: 'parcel-rights/v1', source: { provider: 'lens-devnet-owners' }, parcels } },
    lens
});
// The identity adapter's batch read over a table the test can change between requests.
function fakeIdentity(table) {
    const reads = [];
    return {
        kind: 'fake-registry',
        reads,
        async ownerSets(parcelIds) {
            reads.push([...parcelIds]);
            return new Map(parcelIds.map(id => [id, (table.get(id) || []).map(owner => ({ parcelUid: id, owner, ownerCount: 1, establishedAt: NOW - 100 }))]));
        }
    };
}
async function authorityOf(attester, who, item) {
    const challenged = attester.issueChallenge({ wallet: who.address, contextHash: approval.contextHash(item) });
    return attester.attestAuthority({ wallet: who.address, challenge: challenged.challenge, signature: who.signText(challenged.message), ...item });
}

beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
    vi.restoreAllMocks();
});

describe('devnetOwnerRegistry', () => {
    it('reads the asked parcels\' owner sets: complete, no area, equal shares, each wallet acting for itself', async () => {
        const identity = fakeIdentity(new Map([['HR-1', [ana.address]], ['HR-2', [ben.address, cleo.address]]]));
        const registry = devnetOwnerRegistry(identity);
        const loaded = await registry.load(['HR-1', 'HR-2', 'HR-9']);
        expect(identity.reads).toEqual([['HR-1', 'HR-2', 'HR-9']]);
        // A parcel without recorded owners is not in the registry.
        expect([...loaded.parcels.keys()]).toEqual(['HR-1', 'HR-2']);
        expect(loaded.parcels.get('HR-1')).toMatchObject({ parcelId: 'HR-1', areaM2: null, owners: [{ ownerId: ana.address, share: '1/1' }] });
        expect(loaded.parcels.get('HR-2').owners.map(owner => owner.share)).toEqual(['1/2', '1/2']);
        expect([...loaded.signers.entries()].map(([key, parties]) => [key, [...parties]])).toEqual(
            [[ana.address, [ana.address]], [ben.address, [ben.address]], [cleo.address, [cleo.address]]]);
        expect(loaded.authorities.size).toBe(0);
        expect(loaded.publicBodies.size).toBe(0);
        expect(await registry.status()).toEqual({ source: 'devnet-owners', identity: 'fake-registry' });
        expect(() => devnetOwnerRegistry({ kind: 'certilia', ownerSet: async () => [] })).toThrow(/ownerSets/);
    });

    it('is read on every request, so a change to the registry is seen by the next attestation', async () => {
        const table = new Map([['HR-1', [ana.address]]]);
        const identity = fakeIdentity(table);
        const attester = createApprovalAttester({ keypair: memberKeypair, registry: devnetOwnerRegistry(identity), clock });
        const item = context([devnetParcel('HR-1', [ana]), devnetParcel('HR-2', [ben])]);
        await expect(attester.attestRights(item)).rejects.toMatchObject({ status: 404, code: 'unknown_parcel' });
        // The operator seeds HR-2's owner (agents/lens-owner-registry.js): the same request now passes.
        table.set('HR-2', [ben.address]);
        const rights = await attester.attestRights(item);
        expect(rights).toMatchObject({ schema: proof.RIGHTS_SCHEMA, member: MEMBER, contextHash: approval.contextHash(item), parcelIds: ['HR-1', 'HR-2'] });
        expect(proof.verifyAttestation(rights, proof.RIGHTS_SCHEMA)).toBe(true);
        // A co-owner added later makes the old snapshot wrong.
        table.set('HR-2', [ben.address, cleo.address]);
        await expect(attester.attestRights(item)).rejects.toMatchObject({ status: 409, code: 'rights_mismatch' });
        // Only the agreement's input parcels are read, once per request.
        expect(identity.reads).toEqual([['HR-1', 'HR-2'], ['HR-1', 'HR-2'], ['HR-1', 'HR-2']]);
    });

    it('lets each recorded wallet act for itself only, over the --owners rows', async () => {
        const rows = [
            { parcelUid: 'HR-1', owner: ana.address, ownerCount: 1, establishedAt: '2026-06-01T00:00:00Z' },
            { parcelUid: 'HR-2', owner: ben.address, ownerCount: 2, establishedAt: '2026-06-01T00:00:00Z' },
            { parcelUid: 'HR-2', owner: cleo.address, ownerCount: 2, establishedAt: '2026-07-01T00:00:00Z' }
        ];
        const identity = createDevnetRegistryIdentity({ rows, clock, authority: MEMBER });
        const attester = createApprovalAttester({ keypair: memberKeypair, registry: devnetOwnerRegistry(identity), clock });
        const item = context([devnetParcel('HR-1', [ana]), devnetParcel('HR-2', [ben, cleo])]);
        const facts = await authorityOf(attester, cleo, item);
        expect(facts.authority.map(fact => [fact.ownerId, fact.actorId])).toEqual([[cleo.address, cleo.address]]);
        expect(proof.verifyAttestation(facts.authority[0], proof.AUTHORITY_SCHEMA)).toBe(true);
        await expect(authorityOf(attester, stranger, item)).rejects.toMatchObject({ status: 403, code: 'not_authorized' });
        // Shares are equal by rows; a snapshot that splits them otherwise is not this registry's.
        const uneven = context([devnetParcel('HR-1', [ana]), { ...devnetParcel('HR-2', [ben, cleo]),
            owners: [{ ownerId: ben.address, share: '2/3' }, { ownerId: cleo.address, share: '1/3' }] }]);
        await expect(attester.attestRights(uneven)).rejects.toMatchObject({ status: 409, code: 'rights_mismatch' });
        // An area the registry does not hold is a mismatch too.
        const withArea = context([{ ...devnetParcel('HR-1', [ana]), areaM2: 500 }]);
        await expect(attester.attestRights(withArea)).rejects.toMatchObject({ status: 409, code: 'area_mismatch' });
        await expect(attester.attestRights(context([devnetParcel('HR-1', [ana])], [Keypair.generate().publicKey.toBase58()])))
            .rejects.toMatchObject({ status: 409, code: 'not_in_lens' });
    });
});

describe('fileRegistry', () => {
    const raw = {
        schema: 'lens-rights-registry/v1',
        parcels: [{ parcelId: 'HR-1', areaM2: 400, owners: [{ ownerId: 'owner-7f3a', share: '1/1' }] }],
        publicBodies: [],
        authorities: [{ authorityId: 'planning-office', parcelIds: ['HR-1'] }],
        signers: [{ ownerId: 'owner-7f3a', wallet: ana.address }, { ownerId: 'planning-office', wallet: ben.address }]
    };

    it('serves the same registry for every request and reports itself as the file', async () => {
        const registry = fileRegistry(raw);
        const first = await registry.load(['HR-1']);
        expect(await registry.load(['HR-404'])).toBe(first);
        expect(first.parcels.get('HR-1')).toMatchObject({ areaM2: 400, owners: [{ ownerId: 'owner-7f3a', share: '1/1' }] });
        expect(await registry.status()).toEqual({ source: 'file', parcels: 1, owners: 1, authorities: 1, signers: 2 });
        expect(() => fileRegistry({ ...raw, schema: 'parcel-rights/v1' })).toThrow(/lens-rights-registry\/v1/);
    });

    it('is the only shape the attester takes besides the devnet registry: a bare registry object is refused', () => {
        expect(() => createApprovalAttester({ keypair: memberKeypair, registry: { parcels: new Map() }, clock })).toThrow(/registry source/);
        expect(() => createApprovalAttester({ keypair: memberKeypair, registry: fileRegistry(raw) })).toThrow(/clock/);
    });
});

describe('/lens/status reports the approval registry', () => {
    function memberApp(approvalRegistry) {
        const identity = createDevnetRegistryIdentity({ rows: [], clock, authority: MEMBER });
        const member = createLensMember({ authority: MEMBER, issuer: createFakeIssuer({ authority: MEMBER, clock }), store: createMemoryStore(), identity, clock, dryRun: true });
        const approvalAttester = createApprovalAttester({ keypair: memberKeypair, registry: approvalRegistry(identity), clock, validitySeconds: 3600 });
        return createLensMemberApp({ member, pricing: createLensPricing({ dryRun: true }), approvalAttester });
    }

    it('names the devnet owner registry by default and the file under --rights', async () => {
        const devnet = await request(memberApp(identity => devnetOwnerRegistry(identity))).get('/lens/status');
        expect(devnet.body.approval).toEqual({ enabled: true, source: 'devnet-owners', identity: 'devnet-registry', validitySeconds: 3600 });
        const file = await request(memberApp(() => fileRegistry({ schema: 'lens-rights-registry/v1', parcels: [], signers: [] }))).get('/lens/status');
        expect(file.body.approval).toEqual({ enabled: true, source: 'file', parcels: 0, owners: 0, authorities: 0, signers: 0, validitySeconds: 3600 });
    });

    it('answers an approval route from the devnet registry over HTTP', async () => {
        const rows = [{ parcelUid: 'HR-1', owner: ana.address, ownerCount: 1, establishedAt: '2026-06-01T00:00:00Z' }];
        const identity = createDevnetRegistryIdentity({ rows, clock, authority: MEMBER });
        const member = createLensMember({ authority: MEMBER, issuer: createFakeIssuer({ authority: MEMBER, clock }), store: createMemoryStore(), identity, clock, dryRun: true });
        const app = createLensMemberApp({ member, pricing: createLensPricing({ dryRun: true }),
            approvalAttester: createApprovalAttester({ keypair: memberKeypair, registry: devnetOwnerRegistry(identity), clock }) });
        const ok = await request(app).post('/lens/approval/rights').send(context([devnetParcel('HR-1', [ana])]));
        expect(ok.status).toBe(201);
        expect(ok.body.rights.parcelIds).toEqual(['HR-1']);
        const unknown = await request(app).post('/lens/approval/rights').send(context([devnetParcel('HR-2', [ana])]));
        expect([unknown.status, unknown.body.error]).toEqual([404, 'unknown_parcel']);
    });
});
