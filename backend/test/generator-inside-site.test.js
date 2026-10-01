// Generated geometry must stay inside its source site EXACTLY: a design traced from parcels binds
// exactly those parcels at tolerance 0 (PARCEL-OPTIONAL.md). Phase 1's migration dry run found
// hundreds of designs reaching 1-10 cm into neighbours. The causes pinned here:
//   - robustUnion / sanitizePolygonFeature's ±0.1 m buffer pair (a morphological closing) put a
//     fillet into every concave corner of the superparcel — ~3.4 cm into the neighbour there;
//   - sanitizePolygonFeature dissolved a holed parcel's hole away (unkinkPolygon returns the hole as
//     a second piece), so an envelope covered the enclosed neighbour;
//   - the readjustment sweep rotated with rhumb-line turf.transformRotate, not affinely, so cut points
//     came back off the pool's edges (~1.5 mm out on a 400 m site);
//   - the freeform editor tolerates 0.01 m² outside the block, which was published as is;
//   - the binding preview itself could not see a fillet: turf.buffer returns nothing for a polygon
//     only centimetres across, so the oracle these tests use is pinned first.
//
// The classic scripts read turf as a global and are evaluated in THIS realm (a vm realm silently
// no-ops turf: its instanceof checks fail across the boundary).
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import * as turf from '@turf/turf';

globalThis.turf = turf;
const require = createRequire(import.meta.url);
const read = rel => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const footprint = require('../../frontend/js/footprint-geometry.js');
const { bindingFromParcels } = require('../../frontend/js/proposals/site-binding.js');
const siteClip = require('../../frontend/js/proposals/site-clip.js');
const variation = require('../../frontend/js/urban-rule-variation.js');
const slicer = require('../../frontend/js/reparcellization-slice.js');
const singleGeometry = require('../../frontend/js/single-building-geometry.js');

// Ground metres → WGS84 at Zagreb, affine (shared vertices stay bit-identical).
const LAT = 45.81, LNG = 15.98;
const MX = 1 / (111320 * Math.cos(LAT * Math.PI / 180)), MY = 1 / 110540;
const deg = ([x, y]) => [LNG + x * MX, LAT + y * MY];
const poly = (id, ...rings) => turf.polygon(rings.map(r => [...r, r[0]].map(deg)), { id });

// Two abutting, slightly skewed parcels forming an L, with a neighbour in the notch and a ring of
// neighbours around. Every shared edge uses the same vertices, as in the cadastre.
const P = { p0: [0, 0], p1: [22, 1], p2: [45, 2], p3: [-1, 30], p4: [21, 31], p5: [44, 30], q1: [21.5, 16], q2: [44.6, 15] };
const S1 = poly('S1', [P.p0, P.p1, P.q1, P.p4, P.p3]);
const S2 = poly('S2', [P.p1, P.p2, P.q2, P.q1]);
const NEIGHBOURS = [
    poly('N-notch', [P.q1, P.q2, P.p5, P.p4]),
    poly('N-west', [[-20, -1], P.p0, P.p3, [-21, 29]]),
    poly('N-south', [P.p0, [0, -15], [45, -13], P.p2, P.p1]),
    poly('N-east', [P.p2, [60, 3], [59, 31], P.p5, P.q2]),
    poly('N-north', [P.p3, P.p4, P.p5, [44, 45], [-1, 45]])
];
const SOURCES = [S1, S2];
const ALL = [...SOURCES, ...NEIGHBOURS].map(f => ({ id: f.properties.id, geometry: f.geometry }));
// The same L as ONE parcel (for the per-parcel envelope).
const L_PARCEL = poly('L', [P.p0, P.p1, P.p2, P.q2, P.q1, P.p4, P.p3]);
const L_ALL = [{ id: 'L', geometry: L_PARCEL.geometry }, ...NEIGHBOURS.map(f => ({ id: f.properties.id, geometry: f.geometry }))];

const boundIds = (geometry, parcels = ALL) =>
    bindingFromParcels(geometry.geometry || geometry, parcels, { toleranceM: 0 }).parcels.map(p => p.parcelId).sort();
const unionOf = features => features.reduce((acc, f) => (acc ? turf.union(acc, f) : f), null);

describe('the binding oracle', () => {
    it('sees a 3 cm fillet in a corner (turf.buffer alone returns nothing for so small a piece)', () => {
        // The corner square [20, 20.1] × [10, 10.1] minus a 0.1 m disc: the fillet a ±0.1 m buffer
        // pair leaves in a concave corner. Its inscribed circle is ~3.4 cm wide.
        const corner = poly('c', [[20, 10], [20.1, 10], [20.1, 10.1], [20, 10.1]]);
        const disc = turf.circle(deg([20.1, 10.1]), 0.1, { units: 'meters', steps: 256 });
        const fillet = turf.difference(corner, disc);
        const site = turf.union(poly('x', [[0, 0], [20, 0], [20, 20], [0, 20]]), fillet);
        const neighbour = { id: 'N', geometry: poly('N', [[20, 10], [40, 10], [40, 20], [20, 20]]).geometry };
        const hit = bindingFromParcels(site.geometry, [neighbour], { toleranceM: 0 });
        expect(hit.parcels.map(p => p.parcelId)).toEqual(['N']);
        expect(hit.parcels[0].intrusionM).toBeGreaterThan(0.01);
        expect(hit.parcels[0].intrusionM).toBeLessThan(0.05);
    });
});

describe('superparcel (robustUnion, sanitizePolygonFeature)', () => {
    it('the union of two parcels binds exactly those two', () => {
        expect(boundIds(footprint.robustUnion(SOURCES))).toEqual(['S1', 'S2']);
    });

    it('sanitizing the superparcel keeps it exact', () => {
        const sp = footprint.sanitizePolygonFeature(footprint.robustUnion(SOURCES));
        expect(boundIds(sp)).toEqual(['S1', 'S2']);
    });

    it('sanitizing a parcel with a hole keeps the hole (the enclosed parcel is not bound)', () => {
        const holed = poly('H', [[0, 0], [40, 0], [40, 40], [0, 40]], [[15, 15], [15, 25], [25, 25], [25, 15]]);
        const enclosed = poly('E', [[15, 15], [25, 15], [25, 25], [15, 25]]);
        const parcels = [holed, enclosed].map(f => ({ id: f.properties.id, geometry: f.geometry }));
        const out = footprint.sanitizePolygonFeature(holed);
        expect(boundIds(out, parcels)).toEqual(['H']);
        expect(turf.area(out)).toBeCloseTo(turf.area(holed), 3);
    });

    it('still repairs a bow-tie (the dissolve is kept for real kinks)', () => {
        const bowtie = poly('B', [[0, 0], [10, 10], [10, 0], [0, 10]]);
        const out = footprint.sanitizePolygonFeature(bowtie);
        expect(turf.kinks(out).features.length).toBe(0);
        expect(turf.area(out)).toBeGreaterThan(40);
    });

    it('fills a cadastral micro-gap between the parcels but not a real hole', () => {
        // S2 pulled 5 cm away from S1 along their shared edge leaves an enclosed 5 cm gap.
        const left = poly('A', [[0, 0], [20, 0], [20, 10], [19.95, 10], [19.95, 20], [20, 20], [20, 30], [0, 30]]);
        const right = poly('B', [[20, 0], [40, 0], [40, 30], [20, 30], [20, 20], [20, 10]]);
        const site = siteClip.siteOfParcels([left, right]);
        expect(site.geometry.type).toBe('Polygon');
        expect(site.geometry.coordinates.length).toBe(1); // the 5 cm gap is filled
        const holed = siteClip.siteOfParcels([poly('H', [[0, 0], [40, 0], [40, 40], [0, 40]], [[15, 15], [15, 25], [25, 25], [25, 15]])]);
        expect(holed.geometry.coordinates.length).toBe(2); // a 10 m hole is a parcel, not a gap
    });
});

describe('block (building-blocks.js blockRingOutline + the per-parcel split)', () => {
    let blockRingOutline;
    beforeAll(() => {
        const noop = () => {};
        const stub = () => ({ addTo() { return this; }, on() { return this; }, bindTooltip() { return this; }, setLatLng: noop, getLatLng: () => ({ lat: 0, lng: 0 }) });
        globalThis.L = { geoJSON: stub, polygon: stub, polyline: stub, marker: stub, layerGroup: stub, featureGroup: stub, divIcon: () => ({}), map: () => ({ removeLayer: noop, addLayer: noop, fitBounds: noop, on: noop }) };
        globalThis.document = { getElementById: () => ({ classList: { add: noop, remove: noop }, style: {}, addEventListener: noop, setAttribute: noop }), createElement: () => ({}), querySelector: () => null, querySelectorAll: () => [], addEventListener: noop };
        globalThis.window = { addEventListener: noop, removeEventListener: noop, confirm: () => true, document: globalThis.document };
        globalThis.highlightBlock = noop;
        Object.assign(globalThis, footprint);
        let src = read('../../frontend/js/building-blocks.js');
        src += '\nglobalThis.__blockRingOutline = blockRingOutline;';
        (0, eval)(src); // eslint-disable-line no-eval
        blockRingOutline = globalThis.__blockRingOutline;
    });

    // The modal's own sequence (generateBuildingInModal).
    function superparcel() {
        const sp = footprint.sanitizePolygonFeature(footprint.robustUnion(SOURCES));
        return footprint.toSingleLargestPolygon(sp);
    }

    function massingOf(ring) {
        const outer = ring.outer.geometry.coordinates[0];
        return turf.polygon(ring.inner ? [outer, ring.inner.geometry.coordinates[0].slice().reverse()] : [outer]);
    }

    for (const simplifyM of [0, 1.5]) {
        it(`a ring with no setback (simplify ${simplifyM} m) binds exactly the block's parcels`, () => {
            const sp = superparcel();
            const ring = blockRingOutline(sp, sp, { setback: 0, width: 6, simplifyM });
            expect(ring && ring.outer).toBeTruthy();
            expect(boundIds(massingOf(ring))).toEqual(['S1', 'S2']);
        });
    }

    it('each per-parcel piece binds exactly its own parcel', () => {
        const sp = superparcel();
        const massing = massingOf(blockRingOutline(sp, sp, { setback: 0, width: 6, simplifyM: 0 }));
        const { pieces } = variation.splitMassingByParcels(massing, SOURCES.map(f => ({ feature: f, parcelId: f.properties.id })), { minPlotAreaM2: 0 }, 1, { turf });
        expect(pieces.map(p => p.properties.parcelId)).toEqual(['S1', 'S2']);
        pieces.forEach(piece => expect(boundIds(piece)).toEqual([piece.properties.parcelId]));
    });
});

describe('detached envelope per parcel (urban-rule-variation evaluateParcel, as parcel-based.js calls it)', () => {
    const deps = () => ({ turf, sanitize: footprint.sanitizePolygonFeature, largestPolygon: footprint.toSingleLargestPolygon });

    it('with no setback, the envelope of an L-shaped parcel binds only that parcel', () => {
        const { envelope, status } = variation.evaluateParcel(L_PARCEL, { minDistance: 0, minPlotAreaM2: 0 }, deps());
        expect(status).toBe('ok');
        expect(boundIds(envelope, L_ALL)).toEqual(['L']);
    });

    it('the envelope of a holed parcel leaves the enclosed parcel alone', () => {
        const holed = poly('H', [[0, 0], [40, 0], [40, 40], [0, 40]], [[15, 15], [15, 25], [25, 25], [25, 15]]);
        const enclosed = poly('E', [[15, 15], [25, 15], [25, 25], [15, 25]]);
        const parcels = [holed, enclosed].map(f => ({ id: f.properties.id, geometry: f.geometry }));
        const { envelope } = variation.evaluateParcel(holed, { minDistance: 0.5, minPlotAreaM2: 0 }, deps());
        expect(boundIds(envelope, parcels)).toEqual(['H']);
    });
});

describe('row houses (one unit per parcel, row-house.js rebuildRowUnits)', () => {
    it('a bar reaching past the parcels is cut into units that each bind only their parcel', () => {
        const bar = poly('bar', [[-5, 5], [50, 6], [50, 12], [-5, 11]]);
        const { pieces } = variation.splitMassingByParcels(bar, SOURCES.map(f => ({ feature: f, parcelId: f.properties.id })),
            { typology: 'row', kind: 'exact', minPlotAreaM2: 0 }, 7, { turf });
        expect(pieces).toHaveLength(2);
        pieces.forEach(piece => expect(boundIds(piece)).toEqual([piece.properties.parcelId]));
    });
});

describe('structures (proposals/geometry.js buildGeometryFromParcels)', () => {
    it('a park on the two parcels binds exactly them', () => {
        const src = read('../../frontend/js/proposals/geometry.js');
        const body = src.slice(src.indexOf('function buildGeometryFromParcels('), src.indexOf('function computeLakeZonesForGeometry('));
        const build = (0, eval)(`(${body})`); // eslint-disable-line no-eval
        expect(boundIds(build(SOURCES))).toEqual(['S1', 'S2']);
    });
});

describe('readjustment sweep (reparcellization-slice.js sliceAlongBearing)', () => {
    // A ~450 m pool of two parcels inside a ring of neighbours. The rhumb-line rotation brought cut
    // points back up to ~1.5 mm off the pool's edges at this scale (binding a neighbour at the 1 mm
    // floor on some bearings); the affine rotation must bring them back to float precision.
    const big = poly('B1', [[0, 0], [200, 40], [190, 330], [-10, 300]]);
    const big2 = poly('B2', [[200, 40], [440, 60], [420, 320], [190, 330]]);
    const around = turf.difference(poly('NB', [[-60, -60], [500, -60], [500, 400], [-60, 400]]), turf.union(big, big2));
    const parcels = [big, big2].map(f => ({ id: f.properties.id, geometry: f.geometry })).concat([{ id: 'NB', geometry: around.geometry }]);
    const owners = [0.3, 0.2, 0.5].map((percent, i) => ({ ownerKey: `o${i}`, percent }));

    // Largest distance (m) of any slice vertex lying OUTSIDE the pool from the pool's boundary.
    function maxOutsideM(slices, pool) {
        const boundary = turf.polygonToLine(pool);
        const lines = boundary.type === 'FeatureCollection' ? boundary.features : [boundary];
        let worst = 0;
        for (const slice of slices) {
            for (const rings of (slice.geometry.type === 'Polygon' ? [slice.geometry.coordinates] : slice.geometry.coordinates)) {
                for (const p of rings[0]) {
                    if (turf.booleanPointInPolygon(p, pool)) continue;
                    const d = Math.min(...lines.map(line => turf.pointToLineDistance(p, line, { units: 'meters' })));
                    worst = Math.max(worst, d);
                }
            }
        }
        return worst;
    }

    for (const bearing of [27, 63, 118]) {
        it(`slices at bearing ${bearing}° stay inside the pool and cover it`, () => {
            const pool = siteClip.siteOfParcels([big, big2]);
            const slices = slicer.sliceAlongBearing(pool, owners, bearing, { turf });
            expect(slices).toHaveLength(3);
            expect(maxOutsideM(slices, pool)).toBeLessThan(1e-5);
            slices.forEach(slice => expect(boundIds(slice.geometry, parcels)).not.toContain('NB'));
            const total = slices.reduce((sum, s) => sum + turf.area(turf.feature(s.geometry)), 0);
            expect(Math.abs(total - turf.area(pool)) / turf.area(pool)).toBeLessThan(1e-6);
        });
    }
});

describe('freeform building (single-building-geometry clipFootprintToBoundary)', () => {
    it('a footprint the editor accepts as inside (≤0.01 m² out) is published clipped to the block', () => {
        const block = footprint.toSingleLargestPolygon(footprint.robustUnion(SOURCES));
        // A building against S2's top edge q1→q2, poking 1.5 cm over 0.5 m of it into the notch.
        const top = x => P.q1[1] + (x - P.q1[0]) * (P.q2[1] - P.q1[1]) / (P.q2[0] - P.q1[0]);
        const footprintFeature = poly('F', [[30, 8], [40, 8], [40, top(40) + 0.015], [39.5, top(39.5) + 0.015], [39.45, top(39.45)], [30, top(30)]]);
        expect(singleGeometry.footprintWithinBoundary(footprintFeature, block, turf)).toBe(true);
        expect(boundIds(footprintFeature)).toContain('N-notch');
        const clipped = singleGeometry.clipFootprintToBoundary(footprintFeature, block, turf);
        expect(boundIds(clipped)).toEqual(['S2']);
        expect(clipped.properties.id).toBe('F');
    });
});
