// The pure site → parcel binding rule shared by the browser preview and the server
// (frontend/js/proposals/site-binding.js, PARCEL-OPTIONAL.md): linear intrusion, not area; a shared
// edge never binds; tolerance is a parameter with default 0; coverage semantics; which records are
// acts on parcels and so cannot have an empty binding.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const turf = require('@turf/turf');
const siteBinding = require('../../frontend/js/proposals/site-binding.js');

const {
    DEFAULT_INTRUSION_TOLERANCE_M,
    INTRUSION_NOISE_M,
    bindingFromParcels,
    compareDeclaration,
    intrusionWidth,
    isParcelAct,
    requiresParcels,
    siteOf
} = siteBinding;

// Ground metres → lng/lat about an anchor, with turf's own sphere so "0.3 m" here is 0.3 m to the
// buffer that measures it.
const LNG0 = 15.97;
const LAT0 = 45.8;
const M_LNG = turf.distance([LNG0, LAT0], [LNG0 + 0.01, LAT0], { units: 'meters' }) / 0.01;
const M_LAT = turf.distance([LNG0, LAT0], [LNG0, LAT0 + 0.01], { units: 'meters' }) / 0.01;
const P = (x, y) => [LNG0 + x / M_LNG, LAT0 + y / M_LAT];
const rect = (x0, y0, x1, y1) => ({
    type: 'Polygon',
    coordinates: [[P(x0, y0), P(x1, y0), P(x1, y1), P(x0, y1), P(x0, y0)]]
});
const opts = extra => ({ turf, ...extra });

// Two abutting parcels: A = [0,40]×[0,30], B = [40,80]×[0,30].
const A = { id: 'HR-1-A', geometry: rect(0, 0, 40, 30) };
const B = { id: 'HR-1-B', geometry: rect(40, 0, 80, 30) };

beforeAll(() => { globalThis.turf = turf; });
afterAll(() => { delete globalThis.turf; });

describe('constants', () => {
    it('defaults to zero tolerance with a 1 mm arithmetic floor', () => {
        expect(DEFAULT_INTRUSION_TOLERANCE_M).toBe(0);
        expect(INTRUSION_NOISE_M).toBe(0.001);
    });
});

describe('the binding rule', () => {
    it('does not bind a parcel the site only shares an edge with', () => {
        const site = rect(0, 0, 40, 30); // exactly A
        const binding = bindingFromParcels(site, [A, B], opts());
        expect(binding.parcels.map(p => p.parcelId)).toEqual(['HR-1-A']);
        expect(binding.touched).toEqual([]);
        expect(binding.coverage).toBe('complete');
    });

    it('does not bind across a shared edge drawn with different vertices', () => {
        // The site's east edge lies on A/B's boundary but is split at other points.
        const site = { type: 'Polygon', coordinates: [[P(10, 0), P(40, 0), P(40, 7.3), P(40, 21.9), P(40, 30), P(10, 30), P(10, 0)]] };
        const binding = bindingFromParcels(site, [A, B], opts());
        expect(binding.parcels.map(p => p.parcelId)).toEqual(['HR-1-A']);
    });

    it('binds a 1 cm intrusion at the default tolerance and not at 5 cm', () => {
        const site = rect(0, 0, 40.01, 30); // 1 cm into B along the whole boundary
        const atZero = bindingFromParcels(site, [A, B], opts());
        expect(atZero.parcels.map(p => p.parcelId)).toEqual(['HR-1-A', 'HR-1-B']);
        const intoB = atZero.parcels.find(p => p.parcelId === 'HR-1-B');
        expect(intoB.intrusionM).toBeGreaterThan(0.009);
        expect(intoB.intrusionM).toBeLessThan(0.011);

        const atFive = bindingFromParcels(site, [A, B], opts({ toleranceM: 0.05 }));
        expect(atFive.parcels.map(p => p.parcelId)).toEqual(['HR-1-A']);
        // Not bound, but still reported, so a designer can see how far the site reaches.
        expect(atFive.touched.map(p => p.parcelId)).toEqual(['HR-1-B']);
        expect(atFive.toleranceM).toBe(0.05);
    });

    it('treats sub-millimetre slivers as noise even at tolerance 0', () => {
        const site = rect(0, 0, 40.0004, 30);
        const binding = bindingFromParcels(site, [A, B], opts());
        expect(binding.parcels.map(p => p.parcelId)).toEqual(['HR-1-A']);
    });

    it('measures intrusion as a width: a 0.3 m sliver reads 0.3 m whatever its length', () => {
        const longParcel = { id: 'HR-1-L', geometry: rect(0, 0, 600, 50) };
        const short = rect(-10, 0, 0.3, 5);   // 0.3 m × 5 m inside the parcel
        const long = rect(-10, 0, 0.3, 500);  // 0.3 m × 500 m inside the parcel
        const s = bindingFromParcels(short, [longParcel], opts()).parcels[0];
        const l = bindingFromParcels(long, [{ id: 'HR-1-L', geometry: rect(0, 0, 50, 600) }], opts()).parcels[0];
        expect(l.overlapM2 / s.overlapM2).toBeGreaterThan(50); // very different areas …
        for (const hit of [s, l]) {                            // … the same width
            expect(hit.intrusionM).toBeGreaterThan(0.297);
            expect(hit.intrusionM).toBeLessThan(0.303);
        }
        // A tolerance above the width unbinds it, below binds it — independent of area.
        expect(bindingFromParcels(long, [{ id: 'HR-1-L', geometry: rect(0, 0, 50, 600) }], opts({ toleranceM: 0.35 })).parcels).toEqual([]);
        expect(bindingFromParcels(long, [{ id: 'HR-1-L', geometry: rect(0, 0, 50, 600) }], opts({ toleranceM: 0.25 })).parcels).toHaveLength(1);
    });

    it('measures the widest part of an irregular intersection', () => {
        // An L: a 0.2 m strip plus a 3 m square; the inscribed circle fits in the square.
        const feature = turf.union(turf.feature(rect(0, 0, 20, 0.2)), turf.feature(rect(17, 0, 20, 3)));
        const width = intrusionWidth(feature, { turf });
        expect(width).toBeGreaterThan(2.99);
        expect(width).toBeLessThan(3.01);
    });

    it('refuses a tolerance outside 0..1 m', () => {
        expect(() => bindingFromParcels(rect(0, 0, 1, 1), [], opts({ toleranceM: -0.1 }))).toThrow(/toleranceM/);
        expect(() => bindingFromParcels(rect(0, 0, 1, 1), [], opts({ toleranceM: 2 }))).toThrow(/toleranceM/);
    });
});

describe('coverage', () => {
    it('is complete when the whole site lies on parcels, including across abutting parcels', () => {
        const binding = bindingFromParcels(rect(10, 5, 70, 25), [A, B], opts());
        expect(binding.coverage).toBe('complete');
        expect(binding.unsurveyedM2).toBe(0);
        expect(binding.parcels).toHaveLength(2);
    });

    it('ignores a cadastral micro-gap between parcels under the site', () => {
        const gapped = { id: 'HR-1-B', geometry: rect(40.0005, 0, 80, 30) }; // 0.5 mm gap
        const binding = bindingFromParcels(rect(10, 5, 70, 25), [A, gapped], opts());
        expect(binding.coverage).toBe('complete');
    });

    it('is partial, with the open ground measured, when part of the site lies on no parcel', () => {
        const binding = bindingFromParcels(rect(60, 5, 100, 25), [A, B], opts()); // half beyond B
        expect(binding.coverage).toBe('partial');
        expect(binding.parcels.map(p => p.parcelId)).toEqual(['HR-1-B']);
        expect(binding.unsurveyedM2).toBeGreaterThan(395);
        expect(binding.unsurveyedM2).toBeLessThan(405);
        expect(binding.siteM2).toBeGreaterThan(795);
    });

    it('is partial with the whole site unsurveyed when the region has a cadastre but nothing is under the site', () => {
        const binding = bindingFromParcels(rect(200, 200, 220, 210), [A, B], opts());
        expect(binding).toMatchObject({ coverage: 'partial', parcels: [] });
        expect(binding.unsurveyedM2).toBeCloseTo(binding.siteM2, 0);
    });

    it('is none when the caller says the region has no cadastre', () => {
        const binding = bindingFromParcels(rect(0, 0, 20, 10), [A], opts({ regionHasCadastre: false }));
        expect(binding).toMatchObject({ coverage: 'none', parcels: [] });
        expect(binding.unsurveyedM2).toBeCloseTo(binding.siteM2, 0);
    });

    it('labels a browser answer as a preview unless told otherwise', () => {
        expect(bindingFromParcels(rect(0, 0, 1, 1), [A], opts()).source).toBe('client-preview');
    });
});

describe('which records act on parcels', () => {
    const park = { goal: 'park', structureProposal: { kind: 'park', geometry: rect(0, 0, 10, 10) } };

    it('requires parcels for offers, ownership transfers, votes, designations and merges', () => {
        const site = rect(0, 0, 10, 10);
        expect(requiresParcels({ goal: 'ownership-transfer', site })).toBe(true);
        expect(requiresParcels({ goal: 'Ownership-transfer-to-me', site })).toBe(true);
        expect(requiresParcels({ proposalRole: 'owner-offer', goal: 'square', site })).toBe(true);
        expect(requiresParcels({ ...park, isVote: true })).toBe(true);
        expect(requiresParcels({ goal: 'decide-later', site })).toBe(true);
        expect(requiresParcels({ goal: 'road-track', roadProposal: { definition: { polygon: site, centerline: [] } } })).toBe(true);
    });

    it('lets material proposals stand on a site or their own geometry', () => {
        expect(requiresParcels(park)).toBe(false);
        expect(requiresParcels({ goal: 'buildings', site: rect(0, 0, 10, 10) })).toBe(false);
        // Drawn but not yet built (its land comes from preparation), and a flagged legacy record.
        expect(requiresParcels({ goal: 'road-track', roadProposal: { definition: { width: 8, points: [{ lat: 45.8, lng: 15.97 }, { lat: 45.801, lng: 15.97 }] } } })).toBe(false);
        expect(requiresParcels({ goal: 'road-track', roadProposal: { definition: { width: 8, points: [{ lat: 45.8, lng: 15.97 }, { lat: 45.801, lng: 15.97 }], constructionFrame: { kind: 'legacy-centreline' } } } })).toBe(false);
        expect(isParcelAct({ goal: 'road-track', roadProposal: { definition: { polygon: rect(0, 0, 1, 1), points: [{ lat: 45.8, lng: 15.97 }, { lat: 45.801, lng: 15.97 }] } } })).toBe(false);
    });

    it('requires parcels for a record that has no ground at all', () => {
        expect(requiresParcels({ goal: 'park' })).toBe(true);
        expect(requiresParcels(null)).toBe(true);
    });
});

describe('siteOf', () => {
    it('prefers the authored site, then the footprint, then (parcel acts) the declared parcels', () => {
        const authored = rect(0, 0, 5, 5);
        expect(siteOf({ site: authored, structureProposal: { geometry: rect(50, 50, 60, 60) } })).toEqual({
            type: 'MultiPolygon', coordinates: [authored.coordinates]
        });
        const fromFootprint = siteOf({ structureProposal: { geometry: rect(0, 0, 10, 10) } });
        expect(fromFootprint.type).toBe('MultiPolygon');
        expect(turf.area(fromFootprint)).toBeGreaterThan(99);
        const act = siteOf({ goal: 'ownership-transfer', cadastreParcelIds: ['HR-1-A', 'HR-1-B'] }, { parcels: [A, B, { id: 'HR-1-C', geometry: rect(500, 0, 510, 10) }] });
        expect(turf.area(act)).toBeGreaterThan(2390);
        expect(turf.area(act)).toBeLessThan(2410);
        expect(siteOf({ goal: 'park' }, { parcels: [A] })).toBeNull();
    });
});

describe('compareDeclaration', () => {
    it('reports bound-but-undeclared and declared-but-unbound parcels separately', () => {
        const binding = { parcels: [{ parcelId: 'HR-1-A' }, { parcelId: 'HR-1-B' }] };
        expect(compareDeclaration(['HR-1-A', 'HR-1-Z'], binding)).toEqual({ missing: ['HR-1-B'], extra: ['HR-1-Z'] });
        expect(compareDeclaration(['HR-1-B', 'HR-1-A'], binding)).toEqual({ missing: [], extra: [] });
    });
});
