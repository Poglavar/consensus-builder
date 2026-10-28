// agents/agreement-objects.js: the design/v1 and agreement/v1 objects the agents publish, built on the
// browser's own record modules so they carry the CIDs the app computes and pass the index's checks, and
// the binding owners' rule whose rights snapshot is exactly what the lens member's devnet owner registry
// attests (backend/lens/approval.js devnetOwnerRegistry).
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { Keypair } from '@solana/web3.js';
import {
    AGREEMENT_SCHEMA, DESIGN_SCHEMA, noMoney, REGISTRY_RIGHTS_PROVIDER, agreementObject, boundParcelIds, cidOfObject, communityRule,
    deadlineAfterDays, designObject, holdersFromRights, isParcelLayout, mapViewFromGeometry, ownersRule, parcelOutputs, registryRights
} from '../agents/agreement-objects.js';
import { buildDesignRecord } from '../agents/record-builder.js';
import { validateDesignContent } from '../routes/designs.js';
import { validateAgreementContent } from '../routes/agreements.js';
import { canonicalBytes, cidOf } from '../cid.js';
import { createApprovalAttester, devnetOwnerRegistry } from '../lens/approval.js';
import { createDevnetRegistryIdentity } from '../lens/identity/devnet-registry.js';

const require = createRequire(import.meta.url);
const agreementRecord = require('../../frontend/js/agreement-record.js');
const PlanRecord = require('../../frontend/js/plan-record.js');

const PARCEL = { type: 'Polygon', coordinates: [[[15.97, 45.8], [15.9704, 45.8], [15.9704, 45.8003], [15.97, 45.8003], [15.97, 45.8]]] };
const MASSING = { type: 'Polygon', coordinates: [[[15.9701, 45.8001], [15.9703, 45.8001], [15.9703, 45.8002], [15.9701, 45.8002], [15.9701, 45.8001]]] };
const owner = Keypair.generate().publicKey.toBase58();
const coOwner = Keypair.generate().publicKey.toBase58();
const lensKeypair = Keypair.generate();
const LENS = lensKeypair.publicKey.toBase58();
const NOW_MS = Date.parse('2026-10-22T09:00:00.000Z');

describe('geometry-derived plan views', () => {
    it('uses real coordinate bounds without spreading large coordinate collections', () => {
        const points = Array.from({ length: 200_000 }, (_, index) => [15 + index / 1_000_000, 45 + index / 1_000_000]);
        expect(mapViewFromGeometry(points, 'zagreb')).toEqual({ at: '45.099999,15.099999,17', mode: '2d', city: 'zagreb' });
        expect(() => mapViewFromGeometry([], 'zagreb')).toThrow(/real geometry/);
    });
});

const design = designObject(buildDesignRecord({
    candidate: { parcelId: 'HR-335550-1234/1', massing: { type: 'Feature', properties: { floors: 6, height: 19.5 }, geometry: MASSING }, normalizedRule: null },
    pick: { name: 'Six storeys on the corner lot', rationale: 'Residential infill.' },
    persona: { name: 'densifier-01' }, city: 'zagreb', authoredAt: '2026-10-22T08:55:00.000Z'
}));
const namedPlan = PlanRecord.create('Agreement plan', [design.cid], { at: '45.8,15.97,17', mode: '2d', city: 'zagreb' });

function ownersAgreement(overrides = {}) {
    const rights = registryRights([{ parcelId: 'HR-335550-1234/1', owners: [{ owner, ownerCount: 1 }] }]);
    return agreementObject({
        title: 'Six storeys on the corner lot', author: 'densifier-01', sponsor: owner, city: 'zagreb', createdAt: '2026-10-22T09:00:00.000Z',
        designs: [{ cid: design.cid, goal: design.content.goal, title: design.content.title }],
        plan: { content: namedPlan, cid: cidOfObject(namedPlan) },
        parcels: [{ parcelId: 'HR-335550-1234/1', areaM2: 612.4, holders: holdersFromRights(rights, 'HR-335550-1234/1', { [owner]: 'densifier-01' }) }],
        outputs: parcelOutputs([{ parcelId: 'HR-335550-1234/1', geometry: PARCEL, areaM2: 612.4 }]),
        rule: ownersRule({ lens: LENS, rights }),
        deadline: deadlineAfterDays(NOW_MS, 7),
        money: noMoney('EUR'),
        ...overrides
    });
}

describe('the design object', () => {
    it('is design/v1 that the index accepts, under the CID the server computes from its bytes', () => {
        expect(design.content.schema).toBe(DESIGN_SCHEMA);
        expect(validateDesignContent(design.content)).toMatchObject({ ok: true });
        expect(design.cid).toBe(cidOf(canonicalBytes(design.content)));
        expect(design.cid).toBe(cidOfObject(design.content));
        expect(isParcelLayout(design.content)).toBe(false);
        expect(isParcelLayout({ parcelLayout: { plots: [] } })).toBe(true);
    });

    it('refuses a record the index would refuse', () => {
        expect(() => designObject({ goal: 'buildings', title: 'No ground', buildingProposal: {} })).toThrow(expect.objectContaining({ code: 'invalid-design' }));
    });
});

describe('rights from the devnet owner registry', () => {
    it('is parcel-rights/v1 with complete parcels, no area and equal shares per recorded owner', () => {
        const rights = registryRights([
            { parcelId: 'HR-1', owners: [{ owner, ownerCount: 1 }] },
            { parcelId: 'HR-2', owners: [{ owner, ownerCount: 2 }, { owner: coOwner, ownerCount: 2 }] }
        ]);
        expect(rights).toMatchObject({ schema: 'parcel-rights/v1', source: { provider: REGISTRY_RIGHTS_PROVIDER } });
        expect(rights.parcels).toEqual([
            expect.objectContaining({ parcelId: 'HR-1', complete: true, areaM2: null, owners: [{ ownerId: owner, share: '1/1' }] }),
            expect.objectContaining({ parcelId: 'HR-2', complete: true, areaM2: null, owners: expect.arrayContaining([{ ownerId: owner, share: '1/2' }, { ownerId: coOwner, share: '1/2' }]) })
        ]);
        expect(holdersFromRights(rights, 'HR-2', { [owner]: 'densifier-01' })).toEqual(expect.arrayContaining([
            { ownerKey: owner, displayName: 'densifier-01', share: 0.5 },
            { ownerKey: coOwner, displayName: coOwner, share: 0.5 }
        ]));
    });

    it('refuses a parcel without owners, an owner count the rows contradict, and an unknown parcel', () => {
        expect(() => registryRights([{ parcelId: 'HR-1', owners: [] }])).toThrow(/has no owner in the devnet owner registry/);
        expect(() => registryRights([{ parcelId: 'HR-1', owners: [{ owner, ownerCount: 2 }] }])).toThrow(/lists 1 owner\(s\) of parcel HR-1 but counts 2/);
        const rights = registryRights([{ parcelId: 'HR-1', owners: [{ owner, ownerCount: 1 }] }]);
        expect(() => holdersFromRights(rights, 'HR-9')).toThrow(/has no parcel HR-9/);
    });

    it('is exactly what the lens member attests: the same snapshot passes, one that names another owner does not', async () => {
        const clock = { nowSeconds: () => Math.floor(NOW_MS / 1000) };
        const attesterOver = rows => createApprovalAttester({
            keypair: lensKeypair, clock,
            registry: devnetOwnerRegistry(createDevnetRegistryIdentity({ rows, clock, authority: LENS }))
        });
        const { content } = ownersAgreement();
        const context = { ...agreementRecord.approvalSubject(content) };
        const fact = await attesterOver([{ parcelUid: 'HR-335550-1234/1', owner, ownerCount: 1, establishedAt: '2026-10-01T00:00:00Z' }]).attestRights(context);
        expect(fact).toMatchObject({ member: LENS, parcelIds: ['HR-335550-1234/1'] });
        await expect(attesterOver([{ parcelUid: 'HR-335550-1234/1', owner: coOwner, ownerCount: 1, establishedAt: '2026-10-01T00:00:00Z' }]).attestRights(context))
            .rejects.toMatchObject({ code: 'rights_mismatch' });
    });
});

describe('decision rules', () => {
    it('makes a binding owners\' agreement decided unanimously through one lens member', () => {
        const rights = registryRights([{ parcelId: 'HR-1', owners: [{ owner, ownerCount: 1 }] }]);
        const rule = ownersRule({ lens: ` ${LENS} `, rights });
        expect(rule).toMatchObject({ electorate: 'owners', binding: true, lens: [LENS],
            approvalConfig: { schema: 'proposal-approval/v1', policy: { type: 'unanimous' }, rights: { source: { provider: REGISTRY_RIGHTS_PROVIDER } } } });
        expect(() => ownersRule({ lens: '', rights })).toThrow(/names the lens member that decides it/);
    });

    it('makes a community vote a poll with no owner approval and a deduplicated lens', () => {
        expect(communityRule()).toEqual({ electorate: 'community', binding: false, approvalConfig: null, lens: [] });
        expect(communityRule([LENS, ` ${LENS}`, ''])).toEqual({ electorate: 'community', binding: false, approvalConfig: null, lens: [LENS] });
        expect(communityRule(LENS).lens).toEqual([LENS]);
    });

    it('sets the deadline a whole number of days later, on a whole second', () => {
        expect(deadlineAfterDays(Date.parse('2026-10-22T09:00:00.750Z'), 7)).toBe('2026-10-29T09:00:00.000Z');
        expect(deadlineAfterDays(Date.parse('2026-10-22T09:00:00.000Z'), 0.5)).toBe('2026-10-22T21:00:00.000Z');
        expect(() => deadlineAfterDays(NOW_MS, 0)).toThrow(/positive/);
        expect(() => deadlineAfterDays(Number.NaN, 7)).toThrow(/current time/);
    });
});

describe('land', () => {
    it('takes the union of the designs\' bindings, sorted the way parcel numbers read', () => {
        expect(boundParcelIds([
            { parcels: [{ parcelId: 'HR-1-10/1' }, { parcelId: 'HR-1-2/1' }] },
            { parcels: [{ parcelId: 'HR-1-2/1' }, { parcelId: ' ' }, { parcelId: null }] },
            null
        ])).toEqual(['HR-1-2/1', 'HR-1-10/1']);
    });

    it('leaves each input parcel standing as its own output, hashed over its geometry', () => {
        const [output] = parcelOutputs([{ parcelId: 'HR-1', geometry: { type: 'Feature', properties: {}, geometry: PARCEL }, areaM2: 612.4 }]);
        expect(output).toEqual({ hash: agreementRecord.outputHash(PARCEL), areaM2: 612.4, fromParcelIds: ['HR-1'], role: 'parcel', producedBy: null, geometry: PARCEL });
        expect(output.hash).toMatch(/^piece1-sha256:[0-9a-f]{64}$/);
        expect(() => parcelOutputs([{ parcelId: 'HR-1', areaM2: 1 }])).toThrow(/has no geometry/);
        expect(() => parcelOutputs([{ parcelId: 'HR-1', geometry: PARCEL, areaM2: null }])).toThrow(/needs its area/);
    });
});

describe('the agreement object', () => {
    it('is agreement/v1 that the index accepts, without output geometry, under the CID of its bytes', () => {
        const { content, cid, plan } = ownersAgreement();
        expect(content.schema).toBe(AGREEMENT_SCHEMA);
        expect(validateAgreementContent(content, { now: NOW_MS })).toMatchObject({ ok: true });
        expect(cid).toBe(cidOf(canonicalBytes(content)));
        expect(content).toMatchObject({
            sponsor: owner, deadline: '2026-10-29T09:00:00.000Z', money: noMoney('EUR'), allocations: [{ output: agreementRecord.outputHash(PARCEL), to: { kind: 'party', ownerKey: owner } }],
            inputs: { parcels: [{ parcelId: 'HR-335550-1234/1', areaM2: 612.4, holders: [{ ownerKey: owner, displayName: 'densifier-01', share: 1 }] }], openGroundM2: 0 },
            rule: { electorate: 'owners', binding: true, lens: [LENS] }
        });
        expect(content.planCid).toBe(plan.cid);
        expect(content).not.toHaveProperty('designs');
        expect(content.outputs).toEqual([{ hash: agreementRecord.outputHash(PARCEL), areaM2: 612.4, fromParcelIds: ['HR-335550-1234/1'], role: 'parcel', producedBy: null }]);
        // The same parts are the same agreement; other terms are another one over the same design.
        expect(ownersAgreement().cid).toBe(cid);
        expect(ownersAgreement({ deadline: deadlineAfterDays(NOW_MS, 8) }).cid).not.toBe(cid);
    });

    it('builds a poll over the same design', () => {
        const { content } = ownersAgreement({ rule: communityRule(), sponsor: null });
        expect(content.rule).toEqual({ electorate: 'community', binding: false, approvalConfig: null, lens: [], settlement: null });
        expect(validateAgreementContent(content, { now: NOW_MS })).toMatchObject({ ok: true });
    });

    it('retains consultation metadata in the immutable agent agreement and addresses changed organisers separately', () => {
        const consultation = { organiser: 'did:web:community.example', participationUrl: 'https://community.example/participate' };
        const first = ownersAgreement({ rule: communityRule(), sponsor: null, consultation });
        expect(first.content.consultation).toEqual(consultation);
        expect(validateAgreementContent(first.content, { now: NOW_MS }).ok).toBe(true);
        const changed = ownersAgreement({ rule: communityRule(), sponsor: null, consultation: { ...consultation, organiser: 'did:web:another.example' } });
        expect(changed.cid).not.toBe(first.cid);
        expect(first.content.consultation).toEqual(consultation);
        expect(() => ownersAgreement({ consultation })).toThrow(/community/i);
        expect(() => ownersAgreement({ rule: communityRule(), consultation: { ...consultation, extra: true } })).toThrow(/participation/i);
        expect(() => ownersAgreement({ rule: communityRule(), consultation: { ...consultation, participationUrl: 'http://community.example/' } })).toThrow(/HTTPS/i);
    });

    it('refuses what the agreement dialog refuses', () => {
        const invalid = parts => {
            try { ownersAgreement(parts); } catch (error) { return error; }
            return null;
        };
        expect(invalid({ designs: [] })).toMatchObject({ code: 'invalid-agreement', message: expect.stringMatching(/at least one design/) });
        expect(invalid({ designs: [{ cid: 'agent-1' }] })).toMatchObject({ code: 'invalid-agreement', message: expect.stringMatching(/linked by its CID/) });
        expect(invalid({ outputs: [{ hash: 'piece1-sha256:' + 'a'.repeat(64), areaM2: 1, fromParcelIds: ['HR-335550-1234/1'], role: 'plot', producedBy: cidOfObject({ other: true }) }] }))
            .toMatchObject({ code: 'invalid-agreement', message: expect.stringMatching(/a design the agreement does not link/) });
        expect(invalid({ parcels: [], openGroundM2: 0 })).toMatchObject({ code: 'invalid-agreement', message: expect.stringMatching(/land/) });
        expect(invalid({ money: { currency: 'SOL', lines: [] } })).toMatchObject({ code: 'invalid-agreement', message: expect.stringMatching(/currency of the agreement's city/) });
        expect(() => noMoney(undefined)).toThrow(/city's currency/);
        expect(invalid({ rule: { electorate: 'community', binding: true, approvalConfig: null, lens: [] } }))
            .toMatchObject({ code: 'invalid-agreement', message: expect.stringMatching(/cannot bind the owners/) });
    });
});
