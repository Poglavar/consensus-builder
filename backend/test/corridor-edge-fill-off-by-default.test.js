// The pavement fill must stay OFF unless a road's author asked for it.
//
// A drawn road declares its full cross-section, so widening its sidewalks out to the frontage is
// wrong by definition. The expansion is for an ADOPTED existing street, and nothing adopts one yet.
// It used to default to 'buildings' and, worse, the cross-section editor rewrote the stored choice
// from the CLEARANCE tab's mode on every save — so drawing a road and editing its profile switched
// the fill on silently. Across large rural parcels (Šibenik) that laid 25 m / ~4,000 m² aprons down
// both sides, because EDGE_FILL_MAX_REACH is a backstop and the frontage that normally shapes the
// fill was nowhere within reach.

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../../frontend/js/corridor-edge-fill-scene.js', import.meta.url), 'utf8');

// Every collaborator regionsFor would reach for, as counting spies. If the fill is off it must not
// touch any of them — that is what makes "off" free rather than merely empty.
function bootScene() {
    const calls = [];
    const spy = (name, result) => (...args) => { calls.push(name); return result; };
    globalThis.window = globalThis;
    globalThis.turf = { intersect: spy('turf.intersect', null), area: spy('turf.area', 0), union: spy('turf.union', null), booleanIntersects: spy('turf.booleanIntersects', false) };
    globalThis.wgs84ToHTRS96 = spy('wgs84ToHTRS96', [0, 0]);
    globalThis.htrs96ToWGS84 = spy('htrs96ToWGS84', [0, 0]);
    globalThis.corridorEdgeFillSides = spy('corridorEdgeFillSides', { left: null, right: null });
    globalThis.corridorEdgeFillRegion = spy('corridorEdgeFillRegion', null);
    globalThis.corridorFeatureFromLatLngRing = spy('corridorFeatureFromLatLngRing', null);
    globalThis.buildCorridorStripPolygon = spy('buildCorridorStripPolygon', []);
    globalThis.corridorSegmentEntries = spy('corridorSegmentEntries', [
        { points: [{ lat: 43.73, lng: 15.88 }, { lat: 43.74, lng: 15.89 }], profile: { strips: [{ type: 'sidewalk', width: 1 }] } }
    ]);
    globalThis.corridorProfileOf = spy('corridorProfileOf', { strips: [{ type: 'sidewalk', width: 1 }] });
    globalThis.document = { getElementById: () => null };
    (0, eval)(source);
    return { CorridorEdgeFill: globalThis.window.CorridorEdgeFill, calls };
}

describe('corridor edge fill — off unless asked for', () => {
    let scene;
    beforeEach(() => { scene = bootScene(); });

    it('does no fill work at all for a road that never chose a limit', () => {
        // Asserting only on the RESULT cannot catch a bad default: with the sides stub returning
        // nothing fillable, the 'buildings' path also ends up returning []. Verified by flipping
        // DEFAULT_LIMIT back to 'buildings' — the result assertion stayed green, this one goes red.
        expect(scene.CorridorEdgeFill.regionsFor({})).toEqual([]);
        expect(scene.calls).toEqual([]);
    });

    it('returns nothing when the limit is explicitly none', () => {
        expect(scene.CorridorEdgeFill.regionsFor({ edgeFill: { limit: 'none' } })).toEqual([]);
    });

    it('short-circuits before doing any parcel or geometry work', () => {
        scene.CorridorEdgeFill.regionsFor({ edgeFill: { limit: 'none' } });
        // Not merely an empty result — it must never have looked at a parcel or a centerline.
        expect(scene.calls).toEqual([]);
    });

    it('still honours an explicit buildings/parcels choice, so adopting a street can turn it on', () => {
        // Proves the guard is scoped to 'none' and has not disabled the feature outright: with a
        // real limit, regionsFor gets as far as asking which sides are fillable.
        scene.CorridorEdgeFill.regionsFor({ edgeFill: { limit: 'buildings' } });
        expect(scene.calls).toContain('corridorSegmentEntries');
    });
});
