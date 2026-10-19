// Junctions BETWEEN corridors that belong to different records.
//
// normalizeCorridorGraph only ever saw one record's own strokes, so two roads drawn as two proposals
// crossed with no shared node: the junction existed only as a rendering treatment, and the node
// editor could drag one road's leg out of the crossing and leave the other behind. These tests drive
// the network pass over separate corridors and pin the three things it must never get wrong — it
// must node every crossing (not the first 200), it must NOT node a grade separation, and it must not
// move any geometry.
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    insertCorridorCrossingNodes,
    normalizeCorridorNetwork
} = require('../../frontend/js/corridor-geometry.js');

const P = (lat, lng) => ({ lat, lng });
const has = (segments, lat, lng) => segments.some(segment => segment.some(
    point => Math.abs(point.lat - lat) < 1e-9 && Math.abs(point.lng - lng) < 1e-9
));
// Total planar length — invariant under noding and splitting, because both only change how the same
// locus is written down.
const planarLength = segments => segments.reduce((total, segment) => {
    let run = 0;
    for (let i = 0; i < segment.length - 1; i += 1) {
        run += Math.hypot(segment[i + 1].lat - segment[i].lat, segment[i + 1].lng - segment[i].lng);
    }
    return total + run;
}, 0);

const entry = (segments, segmentIds, extra = {}) => ({ segments, segmentIds, ...extra });

afterEach(() => { delete global.corridorTunnelEdgeKey; });

describe('normalizeCorridorNetwork', () => {
    it('nodes an X-crossing between two SEPARATE records into both of them', () => {
        const east = entry([[P(0, -5), P(0, 5)]], ['east']);
        const north = entry([[P(-5, 0), P(5, 0)]], ['north']);

        const results = normalizeCorridorNetwork([east, north]);

        // Both records now carry the crossing vertex — this is the whole bug: before, whichever road
        // was drawn second had it and the other did not.
        expect(has(east.segments, 0, 0)).toBe(true);
        expect(has(north.segments, 0, 0)).toBe(true);
        // And each splits into its two arms, so the junction is a graph node either side can grab.
        expect(east.segments).toHaveLength(2);
        expect(north.segments).toHaveLength(2);
        expect(east.segmentIds).toHaveLength(2);
        expect(results.every(result => result.changed)).toBe(true);
    });

    it('splits the through-road where another record ends on its mid-span (a T)', () => {
        const through = entry([[P(0, 0), P(0, 10)]], ['through']);
        const branch = entry([[P(0, 5), P(5, 5)]], ['branch']);

        normalizeCorridorNetwork([through, branch]);

        expect(through.segments).toHaveLength(2);
        expect(branch.segments).toHaveLength(1); // its endpoint was already a boundary
        // Both arms keep an id, so a per-arm cross-section cannot be orphaned.
        expect(through.segmentIds.filter(Boolean)).toHaveLength(2);
    });

    it('copies a split arm\'s cross-section override onto its derived id', () => {
        const profiles = { through: { strips: [{ type: 'driving', width: 9 }] } };
        const through = entry([[P(0, 0), P(0, 10)]], ['through'], { segmentProfiles: profiles });
        const branch = entry([[P(0, 5), P(5, 5)]], ['branch']);

        normalizeCorridorNetwork([through, branch]);

        expect(through.segmentIds).toHaveLength(2);
        through.segmentIds.forEach(id => expect(profiles[String(id)]).toEqual({ strips: [{ type: 'driving', width: 9 }] }));
    });

    it('nodes a T where one road ENDS exactly on another road\'s edge', () => {
        // Nothing crosses here — the branch stops dead on the through road's line. This is what a
        // snapped drop produces, and it has to node just as a crossing does.
        const through = entry([[P(0, 0), P(0, 10)]], ['through']);
        const branch = entry([[P(5, 5), P(0, 5)]], ['branch']);

        normalizeCorridorNetwork([through, branch]);

        expect(has(through.segments, 0, 5)).toBe(true);
        expect(through.segments).toHaveLength(2);
        // The branch keeps its two points: its endpoint was already the node.
        expect(branch.segments).toHaveLength(1);
        expect(branch.segments[0]).toHaveLength(2);
    });

    it('does NOT node an endpoint that merely lands near the edge', () => {
        // Why the drop has to be interpolated on the geographic edge rather than unprojected from a
        // pixel: a fifth of a metre short and the centrelines never meet, so there is no crossing to
        // find and the T is a T only on screen.
        const through = entry([[P(0, 0), P(0, 10)]], ['through']);
        const nearMiss = entry([[P(5, 5), P(0.000002, 5)]], ['near-miss']);

        normalizeCorridorNetwork([through, nearMiss]);

        expect(through.segments).toHaveLength(1);
        expect(has(through.segments, 0, 5)).toBe(false);
    });

    it('is convergent — a second pass changes nothing', () => {
        const east = entry([[P(0, -5), P(0, 5)]], ['east']);
        const north = entry([[P(-5, 0), P(5, 0)]], ['north']);

        normalizeCorridorNetwork([east, north]);
        const again = normalizeCorridorNetwork([east, north]);

        expect(again.every(result => result.changed)).toBe(false);
        expect(east.segments).toHaveLength(2);
        expect(north.segments).toHaveLength(2);
    });

    it('moves no geometry: total centreline length is unchanged', () => {
        const east = entry([[P(0, -5), P(0, 5)]], ['east']);
        const north = entry([[P(-5, 0), P(5, 0)]], ['north']);
        const before = planarLength(east.segments) + planarLength(north.segments);

        normalizeCorridorNetwork([east, north]);

        const after = planarLength(east.segments) + planarLength(north.segments);
        expect(Math.abs(after - before)).toBeLessThan(1e-12);
    });

    it('leaves a lone corridor with no partner untouched', () => {
        const only = entry([[P(0, 0), P(0, 5), P(0, 10)]], ['only']);
        const results = normalizeCorridorNetwork([only]);
        expect(only.segments).toHaveLength(1);
        expect(results[0].changed).toBe(false);
    });
});

// The footprint builder rebuilds a bend's joint wedge from the two arms that meet at a node — but
// ONLY when they are two pieces of one original stretch. Wedging every pair instead paves the far
// side of a T (a phantom fourth arm of footway). It tells the cases apart by the derived id, so
// what that id has to guarantee is pinned here rather than in the 6k-line drawing module.
const baseStretchId = id => {
    if (id === null || id === undefined) return null;
    const text = String(id);
    const cut = text.indexOf('~');
    return cut === -1 ? text : text.slice(0, cut);
};

describe('split pieces stay traceable to the stretch they came from', () => {
    it('gives both halves of a split through-road the same base id, and the branch a different one', () => {
        const through = entry([[P(0, 0), P(0, 10)]], ['through']);
        const branch = entry([[P(0, 5), P(5, 5)]], ['branch']);

        normalizeCorridorNetwork([through, branch]);

        const throughBases = new Set(through.segmentIds.map(baseStretchId));
        expect(through.segmentIds).toHaveLength(2);
        expect([...throughBases]).toEqual(['through']);
        expect(branch.segmentIds.map(baseStretchId)).toEqual(['branch']);
        // Which is the whole point: no piece of the branch can be mistaken for a continuation of
        // the through road, so the junction gets no wedge across it.
        expect(throughBases.has('branch')).toBe(false);
    });

    it('keeps the four arms of an X in two pairs, one per road', () => {
        const east = entry([[P(0, -5), P(0, 5)]], ['east']);
        const north = entry([[P(-5, 0), P(5, 0)]], ['north']);

        normalizeCorridorNetwork([east, north]);

        expect(east.segmentIds.map(baseStretchId)).toEqual(['east', 'east']);
        expect(north.segmentIds.map(baseStretchId)).toEqual(['north', 'north']);
    });
});

describe('crossings that are deliberately NOT junctions', () => {
    it('nodes NEITHER side when one of them carries a tunnel/bridge record', () => {
        global.corridorTunnelEdgeKey = (a, b) => `${a.lat},${a.lng}|${b.lat},${b.lng}`;
        const bridgeKey = global.corridorTunnelEdgeKey(P(0, -5), P(0, 5));
        const bridge = entry([[P(0, -5), P(0, 5)]], ['bridge'], { protectedEdgeKeys: new Set([bridgeKey]) });
        const under = entry([[P(-5, 0), P(5, 0)]], ['under']);

        normalizeCorridorNetwork([bridge, under]);

        // The old code protected only the tunnelled edge and still noded the other side, leaving a
        // stray vertex under the bridge that the junction renderer read as a T-joint.
        expect(bridge.segments[0]).toHaveLength(2);
        expect(under.segments[0]).toHaveLength(2);
        expect(has(under.segments, 0, 0)).toBe(false);
    });

    it('does not node two stretches running at different levels', () => {
        const surface = [[{ lat: 0, lng: -5 }, { lat: 0, lng: 5 }]];
        const underground = [[{ lat: -5, lng: 0, level: -1 }, { lat: 5, lng: 0, level: -1 }]];
        const a = entry(surface, ['surface']);
        const b = entry(underground, ['underground']);

        normalizeCorridorNetwork([a, b]);

        expect(has(a.segments, 0, 0)).toBe(false);
        expect(has(b.segments, 0, 0)).toBe(false);
    });

    it('never nodes a ramp, whose middle has no single level to sit at', () => {
        const ramp = [[{ lat: 0, lng: -5, level: 0 }, { lat: 0, lng: 5, level: -1 }]];
        const surface = [[{ lat: -5, lng: 0 }, { lat: 5, lng: 0 }]];
        const a = entry(ramp, ['ramp']);
        const b = entry(surface, ['surface']);

        normalizeCorridorNetwork([a, b]);

        expect(a.segments[0]).toHaveLength(2);
        expect(b.segments[0]).toHaveLength(2);
    });

    it('keeps the level on a node inserted into a levelled stretch, and across the split', () => {
        const belowA = entry([[{ lat: 0, lng: -5, level: -1 }, { lat: 0, lng: 5, level: -1 }]], ['a']);
        const belowB = entry([[{ lat: -5, lng: 0, level: -1 }, { lat: 5, lng: 0, level: -1 }]], ['b']);

        normalizeCorridorNetwork([belowA, belowB]);

        // Two underground stretches on the SAME level do meet, and the junction stays underground —
        // a node that surfaced would put a tunnelled stretch back to taking land.
        expect(belowA.segments).toHaveLength(2);
        belowA.segments.flat().forEach(point => expect(point.level).toBe(-1));
    });
});

describe('insertCorridorCrossingNodes at network scale', () => {
    it('nodes every crossing, not the first 200 (the old restart cap)', () => {
        // A 30 × 30 grid: 900 crossings, comfortably past the old `guard++ < 200` ceiling, where
        // everything beyond the cap was silently left unnoded.
        const COUNT = 30;
        const segments = [];
        for (let i = 0; i < COUNT; i += 1) segments.push([P(i, -1), P(i, COUNT)]);      // horizontals
        for (let j = 0; j < COUNT; j += 1) segments.push([P(-1, j), P(COUNT, j)]);      // verticals

        insertCorridorCrossingNodes(segments, segments.map((_, i) => i));

        // Every line meets all COUNT of the perpendicular ones, so each gains COUNT interior vertices.
        segments.forEach(segment => expect(segment).toHaveLength(COUNT + 2));
        expect(has(segments, COUNT - 1, COUNT - 1)).toBe(true);
    });

    it('inserts one node, not two, where several roads meet the same edge at the same spot', () => {
        const through = [P(0, 0), P(0, 10)];
        const first = [P(0, 5), P(5, 5)];
        const second = [P(0, 5), P(-5, 5)];
        const segments = [through, first, second];

        insertCorridorCrossingNodes(segments, ['through', 'first', 'second']);

        const atJunction = through.filter(point => Math.abs(point.lat) < 1e-9 && Math.abs(point.lng - 5) < 1e-9);
        expect(atJunction).toHaveLength(1);
    });
});
