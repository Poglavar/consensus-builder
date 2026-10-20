import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const turf = require('@turf/turf');
const { validate } = require('../../frontend/js/reparcellization-validation.js');

const rect = (west, south, east, north) => ({
    type: 'Polygon',
    coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]]
});
const plot = (geometry, ownerKey = 'owner:a') => ({ geometry, ownerKey });
const base = (polygons, poolGeometry = null) => ({
    goal: 'reparcellization',
    type: 'Reparcellization',
    title: 'Test readjustment',
    cadastreParcelIds: ['cad:1'],
    offer: 0,
    offerCurrency: 'EUR',
    reparcellization: {
        ...(poolGeometry ? { poolGeometry } : {}),
        polygons
    }
});
const check = proposal => validate(proposal, { turf });

describe('shared reparcellization validation', () => {
    it('rejects equal-area overlap and hole independently, even when area totals cancel', () => {
        const pool = rect(16, 46, 16.003, 46.001);
        const proposal = base([
            plot(rect(16, 46, 16.002, 46.001)),
            plot(rect(16.0015, 46, 16.0025, 46.001))
        ], pool);

        const result = check(proposal);

        expect(result.valid).toBe(false);
        expect(result.errors.map(error => error.code)).toEqual(expect.arrayContaining([
            'overlapping-polygons', 'coverage-gap'
        ]));
        expect(result.metrics.overlapAreaM2).toBeGreaterThan(0);
        expect(result.metrics.uncoveredAreaM2).toBeGreaterThan(0);
        expect(result.metrics.overlapAreaM2).toBeCloseTo(result.metrics.uncoveredAreaM2, 3);
    });

    it('reports plots outside an explicitly declared pool', () => {
        const result = check(base([
            plot(rect(16, 46, 16.002, 46.001))
        ], rect(16, 46, 16.001, 46.001)));

        expect(result.errors.map(error => error.code)).toContain('coverage-excess');
        expect(result.metrics.outsideAreaM2).toBeGreaterThan(0);
    });

    it('accepts a fully covered explicit partial-parcel take', () => {
        const smallTake = rect(16.0004, 46, 16.0006, 46.001);
        const proposal = base([plot(smallTake)], smallTake);
        proposal.reparcellization.inputParcels = [{
            geometry: rect(16, 46, 16.001, 46.001), ownerKey: 'owner:a'
        }];

        expect(check(proposal)).toMatchObject({ valid: true, errors: [] });
    });

    it('uses plot union as the intended take when no pool geometry is declared', () => {
        const result = check(base([plot(rect(16, 46, 16.001, 46.001))]));

        expect(result.valid).toBe(true);
        expect(result.metrics.poolAreaM2).toBeGreaterThan(0);
        expect(result.metrics.uncoveredAreaM2).toBe(0);
        expect(result.metrics.outsideAreaM2).toBe(0);
    });

    it.each([
        ['self-crossing boundary', { type: 'Polygon', coordinates: [[[16, 46], [16.001, 46.001], [16.001, 46], [16, 46.001], [16, 46]]] }],
        ['hole outside shell', { type: 'Polygon', coordinates: [
            rect(16, 46, 16.002, 46.002).coordinates[0],
            rect(16.01, 46.01, 16.011, 46.011).coordinates[0][0]
        ] }],
        ['malformed coordinates', { type: 'Polygon', coordinates: [[[16, 46], ['bad', 46], [16, 46]]] }],
        ['degenerate ring', { type: 'Polygon', coordinates: [[[16, 46], [16, 46], [16, 46], [16, 46]]] }]
    ])('fails closed for %s', (_label, geometry) => {
        const result = check(base([plot(geometry)]));
        expect(result.valid).toBe(false);
        expect(result.errors.map(error => error.code)).toContain('invalid-polygon');
    });

    it('fails closed when geometry operations throw', () => {
        const throwingTurf = {
            ...turf,
            difference: () => { throw new Error('geometry engine failed'); }
        };
        const result = validate(base([plot(rect(16, 46, 16.001, 46.001))], rect(16, 46, 16.001, 46.001)), { turf: throwingTurf });

        expect(result.valid).toBe(false);
        expect(result.errors.map(error => error.code)).toContain('invalid-pool');
    });

    it('checks arbitrary joint allocation shares, duplicates and missing output allocation', () => {
        const geometry = rect(16, 46, 16.001, 46.001);
        const joint = check(base([{
            geometry,
            owners: [
                { ownerKey: 'owner:a', share: 0.2 },
                { ownerKey: 'owner:b', share: 0.3 },
                { ownerKey: 'owner:c', share: 0.5 }
            ],
            jointPool: true
        }]));
        expect(joint.valid).toBe(true);
        expect(joint.normalizedOwnership[0].owners).toHaveLength(3);

        const duplicate = check(base([{
            geometry,
            owners: [{ ownerKey: 'owner:a', share: 0.5 }, { ownerKey: 'owner:a', share: 0.5 }]
        }]));
        expect(duplicate.errors.map(error => error.code)).toContain('invalid-allocation');

        const missing = check(base([{ geometry }]));
        expect(missing.errors.map(error => error.code)).toContain('invalid-allocation');
    });

    it('keeps missing input rights as approval-not-ready while allowing an abstract output owner', () => {
        const result = check(base([plot(rect(16, 46, 16.001, 46.001))]));

        expect(result.valid).toBe(true);
        expect(result.rightsReady).toBe(false);
        expect(result.readyForApproval).toBe(false);
        expect(result.warnings.map(warning => warning.code)).toContain('ownership-unresolved');
    });

    it('requires known parcel areas when a threshold approval policy needs them', () => {
        const proposal = base([plot(rect(16, 46, 16.001, 46.001))]);
        proposal.approvalConfig = {
            schema: 'proposal-approval/v1',
            rights: {
                schema: 'parcel-rights/v1', source: { provider: 'upload' },
                parcels: [{ parcelId: 'cad:1', complete: true, areaM2: null, owners: [{ ownerId: 'owner:a', share: '1/1' }] }]
            },
            policy: {
                type: 'threshold',
                owners: { numerator: 1, denominator: 2, strict: false },
                area: { numerator: 1, denominator: 2, strict: false }
            }
        };

        const result = check(proposal);

        expect(result.valid).toBe(true);
        expect(result.rightsReady).toBe(false);
        expect(result.readyForApproval).toBe(false);
        expect(result.warnings.map(warning => warning.code)).toContain('ownership-unresolved');
    });

    it('requires the proposal cash total to equal exact EUR owner ledger cents', () => {
        const proposal = base([plot(rect(16, 46, 16.001, 46.001))]);
        proposal.offer = 1.01;
        proposal.reparcellization.ownerShares = [{ ownerKey: 'owner:a', cashOffer: 1 }];

        const result = check(proposal);

        expect(result.errors.map(error => error.code)).toContain('invalid-readjustment-deal');
        expect(result.totalCashCents).toBeNull();
    });

    it('leaves positive cash funding unknown until funded and treats zero obligation as ready', () => {
        const proposal = base([plot(rect(16, 46, 16.001, 46.001))]);
        proposal.offer = 12.34;
        proposal.reparcellization.ownerShares = [{ ownerKey: 'owner:a', cashOffer: 12.34 }];

        expect(check(proposal)).toMatchObject({ valid: true, totalCashCents: 1234, fundingReady: false });
        proposal.funded = true;
        expect(check(proposal).fundingReady).toBe(true);
        proposal.offer = 0;
        proposal.reparcellization.ownerShares[0].cashOffer = 0;
        proposal.funded = false;
        expect(check(proposal).fundingReady).toBe(true);
    });

    it('treats explicit unrepresented open-ground null cash as zero, but rejects null cash for a named owner', () => {
        const geometry = rect(16, 46, 16.001, 46.001);
        const openGround = base([{
            geometry,
            ownerKey: 'open-ground',
            unrepresentedGround: true,
            owners: [{ ownerKey: 'open-ground', share: 1 }]
        }]);
        openGround.reparcellization.ownerShares = [{ ownerKey: 'open-ground', unrepresentedGround: true, cashOffer: null }];

        expect(check(openGround)).toMatchObject({ valid: true, totalCashCents: 0, fundingReady: true });

        const namedOwner = base([plot(geometry)]);
        namedOwner.reparcellization.ownerShares = [{ ownerKey: 'owner:a', cashOffer: null }];
        const invalid = check(namedOwner);
        expect(invalid.valid).toBe(false);
        expect(invalid.errors.map(error => error.code)).toContain('invalid-readjustment-deal');
    });

    it('does not mutate the proposal or its geometry', () => {
        const proposal = base([plot(rect(16, 46, 16.001, 46.001))]);
        const before = JSON.stringify(proposal);

        check(proposal);

        expect(JSON.stringify(proposal)).toBe(before);
    });
});
