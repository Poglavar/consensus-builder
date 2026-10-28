// A Block drawn on parcels stores the union of those parcels as its `site`. After a cadastre swap the
// old parcels are gone, so anything that has to rebuild the Block's shape must be able to start from
// that stored site instead of the live parcels. This pins that the Block generator (building-blocks.js
// blockRingOutline, after the editor's own superparcel steps) gives the same massing from either.
// The conversion to Freeform itself rebuilds nothing: it freezes the stored massing
// (proposals/freeform-conversion.js); this is the evidence that the site is a faithful stand-in.
//
// The classic script reads turf as a global and is evaluated in THIS realm (see
// generator-inside-site.test.js, which this harness follows).
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import * as turf from '@turf/turf';

globalThis.turf = turf;
const require = createRequire(import.meta.url);
const read = rel => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const footprint = require('../../frontend/js/footprint-geometry.js');
const siteDraft = require('../../frontend/js/proposals/site-draft.js');

const LAT = 45.81, LNG = 15.98;
const MX = 1 / (111320 * Math.cos(LAT * Math.PI / 180)), MY = 1 / 110540;
const deg = ([x, y]) => [LNG + x * MX, LAT + y * MY];
const poly = (id, ...rings) => turf.polygon(rings.map(r => [...r, r[0]].map(deg)), { id });

// Two abutting, slightly skewed parcels forming an L; shared edges use the same vertices.
const P = { p0: [0, 0], p1: [22, 1], p2: [45, 2], p3: [-1, 30], p4: [21, 31], q1: [21.5, 16], q2: [44.6, 15] };
const L_BLOCK = [poly('S1', [P.p0, P.p1, P.q1, P.p4, P.p3]), poly('S2', [P.p1, P.p2, P.q2, P.q1])];
// Three parcels in a row with a 4 cm cadastral sliver between the first two.
const ROW_WITH_SLIVER = [
    poly('A', [[0, 0], [20, 0], [20, 30], [0, 30]]),
    poly('B', [[20.04, 0], [40, 0], [40, 30], [20.04, 30]]),
    poly('C', [[40, 0], [60, 0], [60, 30], [40, 30]])
];

// Four parcels whose interior hides a 1 cm gap closed on both ends: two titles that do not quite
// meet, between neighbours that do. HM Land Registry's INSPIRE polygons are full of these.
const BLOCK_WITH_HAIRLINE = [
    poly('W', [[0, 0], [20, 0], [20, 15], [20, 30], [0, 30]]),
    poly('S', [[20, 0], [40, 0], [40, 15], [20, 15]]),
    poly('N', [[20, 15.01], [40, 15.01], [40, 30], [20, 30]]),
    poly('E', [[40, 0], [60, 0], [60, 30], [40, 30], [40, 15.01], [40, 15]])
];

let blockRingOutline;
beforeAll(() => {
    const noop = () => {};
    const stub = () => ({ addTo() { return this; }, on() { return this; }, bindTooltip() { return this; }, setLatLng: noop, getLatLng: () => ({ lat: 0, lng: 0 }) });
    globalThis.L = { geoJSON: stub, polygon: stub, polyline: stub, marker: stub, layerGroup: stub, featureGroup: stub, divIcon: () => ({}), map: () => ({ removeLayer: noop, addLayer: noop, fitBounds: noop, on: noop }) };
    globalThis.document = { getElementById: () => ({ classList: { add: noop, remove: noop }, style: {}, addEventListener: noop, setAttribute: noop }), createElement: () => ({}), querySelector: () => null, querySelectorAll: () => [], addEventListener: noop };
    globalThis.window = { addEventListener: noop, removeEventListener: noop, confirm: () => true, document: globalThis.document };
    globalThis.highlightBlock = noop;
    Object.assign(globalThis, footprint);
        Object.assign(globalThis.window, { turf, FootprintGeometry: footprint });
        (0, eval)(read('../../frontend/js/building-rule-geometry.js')); // eslint-disable-line no-eval
    let src = read('../../frontend/js/building-blocks.js');
    src += '\nglobalThis.__blockRingOutline = blockRingOutline;';
    (0, eval)(src); // eslint-disable-line no-eval
    blockRingOutline = globalThis.__blockRingOutline;
});

// The editor's own steps (generateBuildingInModal): a superparcel from the live parcels, or the
// stored site when the design has one, sanitised and reduced to its largest polygon.
const prepared = superparcel => footprint.toSingleLargestPolygon(footprint.sanitizePolygonFeature(superparcel) || superparcel);
const fromParcels = parcels => prepared(footprint.robustUnion(parcels));
const fromStoredSite = parcels => prepared(turf.feature(siteDraft.siteFromFeatures(parcels)));

function massing(superparcel) {
    const ring = blockRingOutline(superparcel, superparcel, { setback: 2, width: 9, simplifyM: 0.5 });
    const outer = ring.outer.geometry.coordinates[0];
    return turf.polygon(ring.inner ? [outer, ring.inner.geometry.coordinates[0].slice().reverse()] : [outer]);
}

const differenceM2 = (a, b) => {
    const one = turf.difference(a, b);
    const two = turf.difference(b, a);
    return (one ? turf.area(one) : 0) + (two ? turf.area(two) : 0);
};

describe('the Block massing from the stored site equals the massing from the live parcels', () => {
    it('on parcels sharing their vertices (the cadastre\'s normal case)', () => {
        expect(differenceM2(massing(fromParcels(L_BLOCK)), massing(fromStoredSite(L_BLOCK)))).toBeLessThan(0.01);
    });

    it('on parcels with a centimetre sliver between them', () => {
        const live = massing(fromParcels(ROW_WITH_SLIVER));
        const stored = massing(fromStoredSite(ROW_WITH_SLIVER));
        // The stored site keeps the sliver (two parts); the editor's sanitising closes it again, so
        // the massing is the same either way.
        expect(siteDraft.siteFromFeatures(ROW_WITH_SLIVER).coordinates).toHaveLength(2);
        expect(differenceM2(live, stored)).toBeLessThan(0.01);
    });

    // A kept hairline hole is widened by the setback into a 4 m gap through the building, and the
    // courtyard inset splits around it. Placing a Block in Hemel Hempstead showed both.
    it('on parcels with a hairline gap inside the block', () => {
        const site = siteDraft.siteFromFeatures(BLOCK_WITH_HAIRLINE);
        expect(site.coordinates.map(polygon => polygon.length)).toEqual([1]);
        expect(differenceM2(massing(fromParcels(BLOCK_WITH_HAIRLINE)), massing(fromStoredSite(BLOCK_WITH_HAIRLINE)))).toBeLessThan(0.01);
    });
});
