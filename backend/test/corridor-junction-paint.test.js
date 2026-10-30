// Tests for frontend/js/corridor-junction-paint.js: the 2D paint partition at a junction. The
// junction's carriageway is united and painted once; each arm's strips are clipped to outside what
// the junction paints (carriageway and footway corners), so junction and lanes can share one
// opacity and the junction stops reading as a darker patch (road-editor.md decision 1).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const turf = require('@turf/turf');
const paint = require('../../frontend/js/corridor-junction-paint.js');
const { buildCrossCorridorJunctionTreatments, buildCorridorPieceStrips, CORRIDOR_PROFILE_PRESETS } = require('../../frontend/js/corridor-profile.js');

// (lat, lng) in the fixtures are metres north and east of a point in Zagreb (as in
// corridor-profile.test.js): a real frame, so the treatments come out in real degrees.
const ZAGREB_FRAME = require('../../frontend/js/metric-frame.js').frameAt([15.97, 45.8]);
const place = point => { const [lat, lng] = ZAGREB_FRAME.metricToLatLng(point.lng, point.lat); return { lat, lng }; };
// Strips of one stretch (no taper), as the renderer builds them for a plain piece.
const stripsOf = (line, stripProfile) => buildCorridorPieceStrips({ points: line.map(place), profile: stripProfile, taper: null }, ZAGREB_FRAME);
const inZagreb = corridors => corridors.map(corridor => ({ ...corridor, centerline: corridor.centerline.map(segment => segment.map(place)) }));

const ringArea = ring => turf.area(paint.ringFeature(ring));
const polygonsFeature = polygons => {
    // A strip's painted polygons (flat ring, or arrays of rings) as one turf feature.
    const coordinates = polygons.map(polygon => {
        const rings = (polygon.length && !Array.isArray(polygon[0]) && polygon[0].lat !== undefined) ? [polygon] : polygon;
        return rings.map(ring => { const c = ring.map(p => [p.lng, p.lat]); c.push(c[0]); return c; });
    });
    return turf.multiPolygon(coordinates);
};
const areaOf = polygons => turf.area(polygonsFeature(polygons));
const overlapArea = (polygons, geometry) => {
    const hit = turf.intersect(polygonsFeature(polygons), turf.feature(geometry));
    return hit ? turf.area(hit) : 0;
};

const profile = { strips: CORRIDOR_PROFILE_PRESETS[40] };
const mainLine = [{ lat: 0, lng: -80 }, { lat: 0, lng: 80 }];
const branchLine = [{ lat: 0, lng: 0 }, { lat: 80, lng: 0 }];

function tJunction() {
    const main = { corridorId: 'main', centerline: [mainLine], profile };
    const branch = { corridorId: 'branch', centerline: [branchLine], profile };
    const [treatment] = buildCrossCorridorJunctionTreatments(inZagreb([main, branch]));
    const mainStrips = stripsOf(mainLine, profile);
    const branchStrips = stripsOf(branchLine, profile);
    return { treatment, mainStrips, branchStrips };
}

describe('the junction carriageway is painted once', () => {
    it('unites the overlapping arm boxes and fillets into one polygon', () => {
        const { treatment } = tJunction();
        expect(treatment.surfacePolygons.length).toBeGreaterThan(1);
        const polygons = paint.junctionSurfacePolygons(treatment);
        expect(polygons).toHaveLength(1); // one connected surface
        expect(polygons[0]).toHaveLength(1); // no leftover hole ring either
        const united = areaOf(polygons);
        const summed = treatment.surfacePolygons.reduce((sum, ring) => sum + ringArea(ring), 0);
        const largest = Math.max(...treatment.surfacePolygons.map(ringArea));
        // The branch's box lies inside the main road's boxes, so the union is well short of the
        // sum of the pieces but no smaller than any one of them.
        expect(united).toBeLessThan(summed * 0.9);
        expect(united).toBeGreaterThanOrEqual(largest - 1e-6);
        expect(paint.junctionSurfacePolygons(treatment)).toBe(polygons); // found once per treatment
    });
});

describe('the junction carriageway is painted once', () => {
    it('is one polygon with no leftover ring for a 26 m street along a parallel with a 7.5 m branch', () => {
        // The combination that showed a second polygon in the browser: a fillet piece that only
        // touched the arm box along the carriageway edge stayed separate, with a degenerate ring.
        const wide = { strips: CORRIDOR_PROFILE_PRESETS[26] };
        const narrow = { strips: CORRIDOR_PROFILE_PRESETS[7.5] };
        const main = { corridorId: 'main', centerline: [mainLine], profile: wide };
        const branch = { corridorId: 'branch', centerline: [branchLine], profile: narrow };
        const [treatment] = buildCrossCorridorJunctionTreatments(inZagreb([main, branch]));
        const polygons = paint.junctionSurfacePolygons(treatment);
        expect(polygons).toHaveLength(1);
        expect(polygons[0]).toHaveLength(1);
        const coverage = paint.paintOf(treatment).coverage;
        expect(coverage.type).toBe('Polygon'); // the footway corners unite with it too
    });
});

describe('arm strips are clipped to what the junction paints', () => {
    it('cuts the through road\'s lanes into the two sides of the box and leaves nothing under it', () => {
        const { treatment, mainStrips } = tJunction();
        const coverage = paint.paintOf(treatment).coverage;
        const painted = paint.clipStrips(mainStrips, [treatment]);
        expect(painted.map(strip => strip.type)).toEqual(mainStrips.map(strip => strip.type));
        const driving = painted.filter(strip => strip.type === 'driving');
        expect(driving.length).toBeGreaterThan(0);
        driving.forEach((strip, index) => {
            const whole = mainStrips.filter(s => s.type === 'driving')[index];
            expect(strip.polygons).toHaveLength(2); // west of the box, east of the box
            const before = areaOf(whole.polygons);
            const after = areaOf(strip.polygons);
            expect(after).toBeLessThan(before);
            // Exactly the overlap went: what was under the junction, nothing more.
            expect(Math.abs((before - overlapArea(whole.polygons, coverage)) - after)).toBeLessThan(0.05);
            expect(overlapArea(strip.polygons, coverage)).toBeLessThan(0.05);
        });
    });

    it('clips the branch\'s footway where it ran into the main road\'s carriageway', () => {
        const { treatment, branchStrips } = tJunction();
        const coverage = paint.paintOf(treatment).coverage;
        const painted = paint.clipStrips(branchStrips, [treatment]);
        const sidewalks = branchStrips.filter(strip => strip.type === 'sidewalk');
        expect(sidewalks.length).toBeGreaterThan(0);
        sidewalks.forEach(whole => {
            const clipped = painted.find(strip => strip.type === 'sidewalk' && strip.left === whole.left);
            expect(clipped).toBeTruthy();
            expect(overlapArea(whole.polygons, coverage)).toBeGreaterThan(1); // it did run into the box
            expect(overlapArea(clipped.polygons, coverage)).toBeLessThan(0.05);
            expect(areaOf(clipped.polygons)).toBeGreaterThan(areaOf(whole.polygons) * 0.5);
        });
    });

    it('leaves no sliver where a through road bends by a hair at the node', () => {
        // A real frame curves a parallel: two arms drawn along one latitude meet at ~1e-5 rad, so
        // their boxes only touched at the node line and the strip kept a sub-pixel sliver between
        // them (a visible dark hairline). The boxes now overlap behind the node and unite.
        const hair = [{ lat: 0, lng: -80 }, { lat: 0, lng: 0 }, { lat: 0.001, lng: 80 }];
        const main = { corridorId: 'main', centerline: [hair], profile };
        const branch = { corridorId: 'branch', centerline: [branchLine], profile };
        const [treatment] = buildCrossCorridorJunctionTreatments(inZagreb([main, branch]));
        expect(paint.junctionSurfacePolygons(treatment)).toHaveLength(1);
        const painted = paint.clipStrips(stripsOf(hair, profile), [treatment]);
        painted.filter(strip => strip.type === 'driving').forEach(strip => {
            expect(strip.polygons).toHaveLength(2); // west of the box, east of the box, nothing between
        });
    });

    it('returns a ring no junction touches as the same object, and strips untouched without junctions', () => {
        const { treatment } = tJunction();
        const asideLine = [{ lat: 400, lng: -80 }, { lat: 400, lng: 80 }];
        const aside = stripsOf(asideLine, profile);
        const painted = paint.clipStrips(aside, [treatment]);
        painted.forEach((strip, index) => expect(strip.polygons[0]).toBe(aside[index].polygons[0]));
        expect(paint.clipStrips(aside, [])).toBe(aside);
    });

    it('drops a strip the junction paints entirely', () => {
        const { treatment } = tJunction();
        const stub = [{ lat: 0, lng: 0 }, { lat: 2, lng: 0 }]; // 2 m into the branch, all inside the box
        const strips = stripsOf(stub, { strips: [{ type: 'driving', width: 3 }] });
        expect(strips).toHaveLength(1);
        expect(paint.clipStrips(strips, [treatment])).toEqual([]);
    });
});

describe('the footway\'s edge fill is clipped the same way', () => {
    it('loses the part under the junction and is null when nothing is left', () => {
        const { treatment } = tJunction();
        const square = (cx, cy, half) => ({
            type: 'Polygon',
            coordinates: [[[cx - half, cy - half], [cx + half, cy - half], [cx + half, cy + half], [cx - half, cy + half], [cx - half, cy - half]]
                .map(([x, y]) => { const [lat, lng] = ZAGREB_FRAME.metricToLatLng(x, y); return [lng, lat]; })]
        });
        const acrossTheMouth = square(0, 25, 10); // straddles the branch's mouth, 15–35 m north of the node
        const clipped = paint.clipGeometry(acrossTheMouth, [treatment]);
        expect(clipped).toBeTruthy();
        expect(turf.area(turf.feature(clipped))).toBeLessThan(turf.area(turf.feature(acrossTheMouth)));
        expect(paint.clipGeometry(square(0, 0, 1), [treatment])).toBeNull();
        expect(paint.clipGeometry(acrossTheMouth, [])).toBe(acrossTheMouth);
    });
});

describe('a junction raw turf cannot unite', () => {
    // Klara grid 3's junction: arm boxes meeting at vertices 4e-8° apart, which raw turf 6.5 refuses
    // with "Unable to complete output ring". On the shared grid it unites, so it paints once.
    const fixture = require('./fixtures/junction-union-klara-grid-3.json');
    const rings = [...fixture.united.geometry.coordinates.map(polygon => polygon[0]), fixture.ring.geometry.coordinates[0]]
        .map(ring => ring.map(([lng, lat]) => [lat, lng]));
    const clips = require('../../frontend/js/proposals/parcel-arrangement.js');

    it('unites on the shared grid with no clip failure', () => {
        const before = clips.clipHealth().bySite['corridor-junction-paint.unionOfRings'] || 0;
        const united = paint.unionOfRings(rings);
        expect(united.type).toBe('Polygon');
        expect(turf.area(turf.feature(united))).toBeCloseTo(190.672, 2);
        expect(clips.clipHealth().bySite['corridor-junction-paint.unionOfRings'] || 0).toBe(before);
    });
});

describe('when turf refuses a piece', () => {
    const clips = require('../../frontend/js/proposals/parcel-arrangement.js');
    beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); });
    afterEach(() => { vi.restoreAllMocks(); delete globalThis.turf; });

    it('paints the strip whole rather than dropping it, and says so', () => {
        const { treatment, mainStrips } = tJunction();
        const fresh = JSON.parse(JSON.stringify(treatment)); // its own paint cache entry
        globalThis.turf = { ...turf, difference: () => { throw new Error('degenerate'); } };
        const before = clips.clipHealth().bySite['corridor-junction-paint.clipGeometry'] || 0;
        const painted = paint.clipStrips(mainStrips, [fresh]);
        painted.forEach((strip, index) => expect(strip.polygons[0]).toBe(mainStrips[index].polygons[0]));
        expect(clips.clipHealth().bySite['corridor-junction-paint.clipGeometry']).toBeGreaterThan(before);
    });
});
