// Behavioural contract for the shared LR deal fingerprint used by local consent and plan hashes.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const deal = require('../../frontend/js/reparcellization-deal.js');
const ownershipSource = readFileSync(new URL('../../frontend/js/reparcellization-ownership.js', import.meta.url), 'utf8');
const cryptoSource = readFileSync(new URL('../../frontend/vendor/noble-hashes-1.8.0/sha256.js', import.meta.url), 'utf8');
const approvalSource = readFileSync(new URL('../../frontend/js/proposals/approval.js', import.meta.url), 'utf8');
const dealSource = readFileSync(new URL('../../frontend/js/reparcellization-deal.js', import.meta.url), 'utf8');

function rectangle(x1, y1, x2, y2) {
    return { type: 'Polygon', coordinates: [[[x1, y1], [x2, y1], [x2, y2], [x1, y2], [x1, y1]]] };
}

function proposal() {
    return {
        proposalId: 'lr-ž-🌍', goal: 'reparcellization', cadastreParcelIds: ['КЧ-2', 'HR-1'],
        offer: 100, offerCurrency: 'EUR', isConditional: true, expiresAt: '2030-01-01T00:00:00.000Z',
        depositEnabled: true, depositPercent: 10, decayEnabled: true, decayPercent: 5,
        decayDurationMs: 3600000, disbursementMode: 'partial',
        reparcellizationAgreement: { groupId: 'group-1', index: 0, count: 1 },
        reparcellization: {
            poolGeometry: rectangle(0, 0, 2, 1), poolSource: 'site', contributionBasis: 'area',
            poolUnitValue: 10, totalValue: 2000, contributionRatio: 1,
            polygons: [
                { geometry: rectangle(0, 0, 1, 1), percent: 50, owners: [
                    { ownerKey: 'owner:Željko/🌱', displayName: 'Željko', share: 0.75 },
                    { ownerKey: 'owner:Ana', displayName: 'Ana', share: 0.25 }
                ] },
                { geometry: rectangle(1, 0, 2, 1), ownerKey: 'owner:Ana', displayName: 'Ana', percent: 50 }
            ],
            inputParcels: [{ geometry: rectangle(0, 0, 2, 1), ownerKey: 'owner:Željko/🌱', displayName: 'Željko' }],
            ownerShares: [
                { ownerKey: 'owner:Željko/🌱', cashOffer: 60, contributedArea: 100, contributedValue: 1000,
                    entitledValue: 1000, assignedArea: 100, assignedValue: 1000, cashBalance: 0 },
                { ownerKey: 'owner:Ana', cashOffer: 40, contributedArea: 100, contributedValue: 1000,
                    entitledValue: 1000, assignedArea: 100, assignedValue: 1000, cashBalance: 0 }
            ],
            regime: { id: 'lr-regime-v1' }, policy: { threshold: 0.75 }, electorate: ['owner:Željko/🌱', 'owner:Ana']
        }
    };
}

function approvalSetup() {
    return {
        schema: 'proposal-approval/v1',
        rights: {
            schema: 'parcel-rights/v1', source: { provider: 'upload', reference: 'snapshot-1' },
            parcels: [
                { parcelId: 'КЧ-2', complete: true, areaM2: 100, owners: [
                    { ownerId: 'owner-ana', share: '1/2' }, { ownerId: 'owner-zeljko', share: '1/2' }
                ] },
                { parcelId: 'HR-1', complete: true, areaM2: 100, owners: [
                    { ownerId: 'owner-ana', share: '1/1' }
                ] }
            ]
        },
        policy: { type: 'unanimous' }
    };
}

function browserDeal() {
    const context = { TextEncoder };
    vm.runInNewContext(ownershipSource, context);
    vm.runInNewContext(cryptoSource, context);
    vm.runInNewContext(approvalSource, context);
    vm.runInNewContext(dealSource, context);
    return context.ReparcellizationDeal;
}

describe('ReparcellizationDeal shared fingerprint', () => {
    it('derives plot references from the committed plot content, identically in browser and node', () => {
        const record = proposal();
        const before = structuredClone(record);
        const slice = record.reparcellization.polygons[0];
        const committed = deal.content(record).plots.find(plot => plot.owners.length === 2);
        const expected = createHash('sha256').update(deal.stableStringify({
            schema: 'land-readjustment-plot/v1', plot: committed
        }), 'utf8').digest('hex');
        expect(deal.plotFingerprint(slice)).toBe(`lr-plot1-sha256:${expected}`);
        expect(browserDeal().plotFingerprint(slice)).toBe(deal.plotFingerprint(slice));
        const reordered = structuredClone(slice);
        reordered.owners.reverse();
        reordered.displayName = 'Cosmetic label';
        reordered.area = 999;
        expect(deal.plotFingerprint(reordered)).toBe(deal.plotFingerprint(slice));
        record.reparcellization.polygons.reverse();
        expect(record.reparcellization.polygons.map(deal.plotFingerprint).sort())
            .toEqual(before.reparcellization.polygons.map(deal.plotFingerprint).sort());
        expect(deal.fingerprint(record)).toBe(deal.fingerprint(before));
    });

    it.each(['geometry', 'allocation'])('changes the plot reference when its %s changes', field => {
        const slice = proposal().reparcellization.polygons[0];
        const edited = structuredClone(slice);
        if (field === 'geometry') edited.geometry.coordinates[0][1][0] += 1e-12;
        else edited.owners[0].ownerKey = 'another-party';
        expect(deal.plotFingerprint(edited)).not.toBe(deal.plotFingerprint(slice));
    });

    it('uses the versioned SHA-256 digest of its canonical payload, including Unicode in UTF-8', () => {
        const record = proposal();
        const content = deal.content(record);
        const expected = createHash('sha256').update(deal.stableStringify(content), 'utf8').digest('hex');
        expect(deal.fingerprint(record)).toBe(`lr2-sha256:${expected}`);
        expect(deal.fingerprint(record)).toMatch(/^lr2-sha256:[0-9a-f]{64}$/);
        expect(browserDeal().fingerprint(record)).toBe(deal.fingerprint(record));
    });

    it('commits to internal plot partition changes while keeping the outer footprint fixed', () => {
        const before = proposal();
        const after = proposal();
        after.reparcellization.polygons[0].geometry = rectangle(0, 0, 0.8, 1);
        after.reparcellization.polygons[1].geometry = rectangle(0.8, 0, 2, 1);
        expect(after.reparcellization.poolGeometry).toEqual(before.reparcellization.poolGeometry);
        expect(deal.fingerprint(after)).not.toBe(deal.fingerprint(before));
    });

    it.each([
        ['co-owner split', record => { record.reparcellization.polygons[0].owners = [
            { ownerKey: 'owner:Ana', share: 0.3 }, { ownerKey: 'owner:Željko/🌱', share: 0.7 }
        ]; }],
        ['recipient', record => { record.reparcellization.polygons[0].owners[0].ownerKey = 'owner:Bob'; }],
        ['per-owner cash split with the same total', record => {
            record.reparcellization.ownerShares[0].cashOffer = 70;
            record.reparcellization.ownerShares[1].cashOffer = 30;
        }],
        ['valuation', record => { record.reparcellization.totalValue += 1; }],
        ['contribution basis', record => { record.reparcellization.contributionBasis = 'value'; }],
        ['policy', record => { record.reparcellization.policy.threshold = 0.8; }],
        ['regime', record => { record.reparcellization.regime.id = 'lr-regime-v2'; }],
        ['electorate', record => { record.reparcellization.electorate.push('owner:Борис'); }],
        ['cadastre declaration', record => { record.cadastreParcelIds.push('HR-3'); }],
        ['cash total', record => { record.offer = 110; record.reparcellization.ownerShares[0].cashOffer = 70; record.reparcellization.ownerShares[1].cashOffer = 40; }],
        ['expiry', record => { record.expiresAt = '2031-01-01T00:00:00.000Z'; }],
        ['deposit terms', record => { record.depositPercent = 20; }],
        ['conditional terms', record => { record.isConditional = false; }],
        ['decay terms', record => { record.decayDurationMs += 1000; }],
        ['disbursement terms', record => { record.disbursementMode = 'conditional'; }]
    ])('changes when %s changes', (_label, mutate) => {
        const before = proposal();
        const after = proposal();
        mutate(after);
        expect(deal.fingerprint(after)).not.toBe(deal.fingerprint(before));
    });

    it('ignores cosmetic and derived metadata', () => {
        const before = proposal();
        const cosmetic = proposal();
        cosmetic.title = 'Renamed';
        cosmetic.thumbnail = '/changed.png';
        cosmetic.reparcellization.validated = false;
        cosmetic.reparcellization.generatedAt = '2030-01-01T00:00:00Z';
        cosmetic.reparcellization.ownerShares[0].generatedArea = 999;
        cosmetic.reparcellization.polygons.forEach(plot => { plot.percent = 1; plot.generatedArea = 123; });
        expect(deal.fingerprint(cosmetic)).toBe(deal.fingerprint(before));
    });

    it('canonicalizes member, plot, owner, cadastre and object-key order without reordering coordinates', () => {
        const before = proposal();
        before.lens = ['member-a', 'member-b'];
        before.approvalConfig = approvalSetup();
        const reordered = proposal();
        reordered.lens = ['member-b', 'member-a'];
        reordered.approvalConfig = approvalSetup();
        reordered.approvalConfig.rights.parcels.reverse();
        reordered.approvalConfig.rights.parcels[0].owners.reverse();
        reordered.cadastreParcelIds.reverse();
        reordered.reparcellization.ownerShares.reverse();
        reordered.reparcellization.polygons.reverse();
        reordered.reparcellization.polygons[1].owners.reverse();
        const reverseKeys = value => {
            if (Array.isArray(value)) return value.map(reverseKeys);
            if (!value || typeof value !== 'object') return value;
            return Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reverseKeys(child)]));
        };
        const reorderedKeys = reverseKeys(reordered);
        expect(deal.fingerprint(reorderedKeys)).toBe(deal.fingerprint(before));

        const fullHash = deal.fingerprint(before);
        const designHash = deal.designFingerprint(before);
        const approvalChanges = [
            changed => {
                changed.approvalConfig.rights.parcels[0].owners[0].share = '1/3';
                changed.approvalConfig.rights.parcels[0].owners[1].share = '2/3';
            },
            changed => { changed.lens = ['member-a', 'member-c']; },
            changed => { changed.approvalConfig.policy = { type: 'threshold',
                owners: { numerator: 1, denominator: 2, strict: false },
                area: { numerator: 7, denominator: 10, strict: false } }; }
        ];
        for (const mutate of approvalChanges) {
            const changed = structuredClone(before);
            mutate(changed);
            expect(deal.fingerprint(changed)).not.toBe(fullHash);
            expect(deal.designFingerprint(changed)).toBe(designHash);
        }

        const movedVertex = proposal();
        movedVertex.reparcellization.polygons[0].geometry.coordinates[0][1][0] += 1e-12;
        expect(deal.fingerprint(movedVertex)).not.toBe(deal.fingerprint(before));
    });

    it('rejects invalid ownership, ledger and unsupported settlement terms', () => {
        const cases = [
            ['shares that do not sum to one', record => { record.reparcellization.polygons[0].owners = [
                { ownerKey: 'owner:Ana', share: 0.7 }, { ownerKey: 'owner:Željko/🌱', share: 0.2 }
            ]; }],
            ['a missing owner identity', record => { record.reparcellization.polygons[0].owners = []; delete record.reparcellization.polygons[0].ownerKey; }],
            ['non-finite shares', record => { record.reparcellization.polygons[0].owners = [{ ownerKey: 'owner:Ana', share: Infinity }]; }],
            ['duplicate ledger identities', record => { record.reparcellization.ownerShares[1].ownerKey = record.reparcellization.ownerShares[0].ownerKey; }],
            ['a non-finite ledger number', record => { record.reparcellization.ownerShares[0].assignedValue = NaN; }],
            ['a mismatched proposal total', record => { record.offer = 101; }],
            ['non-EUR cash', record => { record.offerCurrency = 'USD'; }]
        ];
        for (const [label, mutate] of cases) {
            const invalid = proposal();
            mutate(invalid);
            expect(() => deal.fingerprint(invalid), label).toThrow();
        }

        const nullCash = proposal();
        nullCash.offer = 40;
        nullCash.reparcellization.ownerShares[0].cashOffer = null;
        nullCash.reparcellization.ownerShares[1].cashOffer = 40;
        expect(() => deal.fingerprint(nullCash), 'explicit null cash must not silently become zero').toThrow();
    });

    it('allows a complete ownerless open-ground plot without assigning it to an owner', () => {
        const openGround = proposal();
        openGround.offer = 0;
        openGround.reparcellization.polygons = [{
            geometry: rectangle(0, 0, 2, 1), noOwner: true,
            owners: [{ ownerKey: 'open-ground', share: 1, noOwner: true }]
        }];
        openGround.reparcellization.ownerShares = [{ ownerKey: 'open-ground', noOwner: true, cashOffer: 0 }];
        const payload = deal.content(openGround);
        expect(payload.plots[0].owners).toEqual([]);
        expect(payload.ledger[0]).toMatchObject({ ownerKey: 'open-ground', noOwner: true, cashCents: 0 });
        expect(deal.fingerprint(openGround)).toMatch(/^lr2-sha256:[0-9a-f]{64}$/);
    });

    it('treats the reserved open-ground ledger key as ownerless even without the explicit flag', () => {
        for (const noOwner of [undefined, false]) {
            const openGround = proposal();
            openGround.offer = 0;
            openGround.reparcellization.polygons = [{
                geometry: rectangle(0, 0, 2, 1), noOwner: true,
                owners: [{ ownerKey: 'open-ground', share: 1, noOwner: true }]
            }];
            openGround.reparcellization.ownerShares = [{
                ownerKey: 'open-ground', ...(noOwner === undefined ? {} : { noOwner }), cashOffer: 0
            }];
            expect(deal.content(openGround).ledger[0]).toMatchObject({ ownerKey: 'open-ground', noOwner: true, cashCents: 0 });
        }
    });

    it.each([undefined, false])('rejects positive cash for the open-ground key (noOwner flag: %s)', noOwner => {
        const openGround = proposal();
        openGround.offer = 1;
        openGround.reparcellization.polygons = [{
            geometry: rectangle(0, 0, 2, 1), noOwner: true,
            owners: [{ ownerKey: 'open-ground', share: 1, noOwner: true }]
        }];
        openGround.reparcellization.ownerShares = [{
            ownerKey: 'open-ground', ...(noOwner === undefined ? {} : { noOwner }), cashOffer: 1
        }];
        expect(() => deal.fingerprint(openGround)).toThrow('Ownerless ground cannot receive or pay cash.');
    });
});

describe('ReparcellizationDeal without cash', () => {
    // The Borovje readjustments carry no cash offer; production's offer_currency column default
    // stamped USD on them, and that must not void a deal that moves no money.
    const noCash = () => {
        const record = proposal();
        record.offer = 0;
        record.reparcellization.ownerShares.forEach(owner => { owner.cashOffer = 0; });
        return record;
    };

    it('ignores the stored currency when the ledger moves no money', () => {
        const usd = noCash();
        usd.offerCurrency = 'USD';
        expect(() => deal.fingerprint(usd)).not.toThrow();
        const eur = noCash();
        eur.offerCurrency = 'EUR';
        expect(deal.fingerprint(usd)).toBe(deal.fingerprint(eur));
        expect(deal.content(usd).terms.currency).toBeNull();
    });

    it('still refuses non-EUR cash', () => {
        const paid = proposal();
        paid.offerCurrency = 'USD';
        expect(() => deal.fingerprint(paid)).toThrow(/EUR/);
    });
});
