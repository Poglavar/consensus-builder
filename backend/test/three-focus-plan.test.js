// The decision 3D mode makes when a proposal is opened while the scene is up: frame it where it
// stands, rebuild the scene around it, or do nothing (frontend/js/three-focus-plan.js).
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { planProposalFocus, featuresCenter, distanceM } = require('../../frontend/js/three-focus-plan.js');

const square = (lng, lat, size = 0.0005) => ({
    type: 'Feature', properties: {},
    geometry: { type: 'Polygon', coordinates: [[[lng, lat], [lng + size, lat], [lng + size, lat + size], [lng, lat + size], [lng, lat]]] }
});
const ORIGIN = { lat: 45.8, lng: 16.0 };

describe('planProposalFocus', () => {
    it('frames a proposal whose parcels are all in the scene and near the anchor', () => {
        const plan = planProposalFocus({
            targets: [{ id: 'a', parcelIds: ['1', '2'], features: [square(16.0, 45.8), square(16.0006, 45.8)] }],
            originLatLng: ORIGIN, radiusM: 300
        });
        expect(plan.action).toBe('frame');
        expect(plan.features).toHaveLength(2);
    });

    it('relocates when some of the ground is missing from the scene', () => {
        const plan = planProposalFocus({
            targets: [{ id: 'a', parcelIds: ['1', '2', '3'], features: [square(16.0, 45.8)] }],
            originLatLng: ORIGIN, radiusM: 300
        });
        expect(plan.action).toBe('relocate');
        expect(plan.reason).toMatch(/ground/);
    });

    it('relocates when the ground lies beyond the loaded context radius', () => {
        // ~2.3 km east of the anchor
        const plan = planProposalFocus({
            targets: [{ id: 'a', parcelIds: ['1'], features: [square(16.03, 45.8)] }],
            originLatLng: ORIGIN, radiusM: 300
        });
        expect(plan.action).toBe('relocate');
        expect(plan.reason).toMatch(/context radius 300 m/);
    });

    it('frames an open-ground proposal on its site', () => {
        const site = square(16.001, 45.8005);
        const plan = planProposalFocus({
            targets: [{ id: 'a', parcelIds: [], features: [], siteFeature: site }],
            originLatLng: ORIGIN, radiusM: 300
        });
        expect(plan.action).toBe('frame');
        expect(plan.features).toEqual([site]);
    });

    it('does nothing for an unknown proposal or one without ground', () => {
        expect(planProposalFocus({ targets: [], originLatLng: ORIGIN, radiusM: 300 }).action).toBe('none');
        expect(planProposalFocus({ targets: [{ id: 'a', parcelIds: [], features: [] }], originLatLng: ORIGIN, radiusM: 300 }).action).toBe('none');
    });

    it('frames several proposals together on their joint ground', () => {
        const plan = planProposalFocus({
            targets: [
                { id: 'a', parcelIds: ['1'], features: [square(16.0, 45.8)] },
                { id: 'b', parcelIds: ['2'], features: [square(16.001, 45.801)] }
            ],
            originLatLng: ORIGIN, radiusM: 300
        });
        expect(plan.action).toBe('frame');
        expect(plan.features).toHaveLength(2);
    });

    it('frames without a usable anchor or radius instead of guessing a relocation', () => {
        const plan = planProposalFocus({ targets: [{ id: 'a', parcelIds: ['1'], features: [square(16.03, 45.8)] }], originLatLng: null, radiusM: NaN });
        expect(plan.action).toBe('frame');
    });
});

describe('geometry helpers', () => {
    it('finds the bbox centre of nested coordinates', () => {
        const c = featuresCenter([square(16.0, 45.8, 0.002)]);
        expect(c.lat).toBeCloseTo(45.801, 9);
        expect(c.lng).toBeCloseTo(16.001, 9);
        expect(featuresCenter([])).toBeNull();
    });

    it('measures distance in metres', () => {
        expect(Math.round(distanceM(ORIGIN, { lat: 45.8, lng: 16.0129 }))).toBeGreaterThan(990);
        expect(Math.round(distanceM(ORIGIN, { lat: 45.8, lng: 16.0129 }))).toBeLessThan(1010);
    });
});
