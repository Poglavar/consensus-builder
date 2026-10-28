// The junction with an applied road is previewed while drawing (road-editor.md decision 4): the
// applied corridors that share a node with the drawing — at one of their vertices, or part-way along
// an edge where Finish will node it in — join the junction pass as short arms around that node.
// Tests the pure arm selection of the loaded road-drawing.js (helpers/road-drawing-env.js), that the
// junction builder then draws a junction the drawing takes part in, and — through the drawing's own
// redrawRoadStrips over a corridor-render.js stand-in — what reaches the junction pass and what the
// strips and markings get.
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { loadRoadDrawing, at } from './helpers/road-drawing-env.js';

const require = createRequire(import.meta.url);
const turf = require('@turf/turf');
const corridorProfile = require('../../frontend/js/corridor-profile.js');
const junctionPaint = require('../../frontend/js/corridor-junction-paint.js');

let env = null;
afterEach(() => {
    env?.dispose();
    env = null;
});

const appliedArmsMeetingDrawing = (...args) => {
    env = env || loadRoadDrawing();
    return env.api.appliedArmsMeetingDrawing(...args);
};

const P = (lat, lng) => ({ lat, lng });
const PROFILE = { strips: [{ type: 'sidewalk', width: 2 }, { type: 'driving', width: 6 }, { type: 'sidewalk', width: 2 }] };
// An applied east–west street near Zagreb with a bend vertex in the middle.
const street = { points: [P(45.8, 15.97), P(45.8, 15.971), P(45.8, 15.972)], profile: PROFILE, corridorId: 'p1' };

describe('applied arms meeting the drawing', () => {
    it('takes the arms around an applied vertex the drawing shares', () => {
        const drawing = [[P(45.8, 15.971), P(45.801, 15.971)]];
        const arms = appliedArmsMeetingDrawing(drawing, [street]);
        expect(arms).toEqual([{ points: [P(45.8, 15.97), P(45.8, 15.971), P(45.8, 15.972)], profile: PROFILE, corridorId: 'p1' }]);
    });

    it('finds a T snapped onto the middle of an applied edge, around the drawing’s exact node', () => {
        const t = 0.37;
        const onEdge = P(45.8, 15.97 + t * 0.001);
        const arms = appliedArmsMeetingDrawing([[P(45.799, onEdge.lng), onEdge]], [street]);
        expect(arms).toHaveLength(1);
        expect(arms[0].points).toEqual([P(45.8, 15.97), onEdge, P(45.8, 15.971)]);
    });

    it('takes one arm at an applied road’s end', () => {
        const arms = appliedArmsMeetingDrawing([[P(45.8, 15.972), P(45.801, 15.973)]], [street]);
        expect(arms[0].points).toEqual([P(45.8, 15.971), P(45.8, 15.972)]);
    });

    it('keeps stacked nodes separate and only projects onto a same-level edge', () => {
        const elevated = { ...street, points: street.points.map(point => ({ ...point, level: 1 })) };
        const atLevel = (lng, level) => ({ ...P(45.8, lng), level });
        expect(appliedArmsMeetingDrawing([[atLevel(15.971, 0)]], [elevated])).toEqual([]);
        expect(appliedArmsMeetingDrawing([[atLevel(15.9705, 0)]], [elevated])).toEqual([]);
        const shared = atLevel(15.9705, 1);
        const arms = appliedArmsMeetingDrawing([[atLevel(15.9705, 0)], [shared]], [elevated]);
        expect(arms).toHaveLength(1);
        expect(arms[0].points[1]).toEqual(shared);
        expect(appliedArmsMeetingDrawing([[shared]], [{ ...elevated,
            points: [atLevel(15.97, 0), atLevel(15.971, 1)] }])).toEqual([]);
    });

    it('leaves alone a near miss that is not a shared node', () => {
        // 2 cm north of the centre line: snapping would have landed on it; this did not.
        const nearMiss = P(45.8 + 0.02 / 111320, 15.9705);
        expect(appliedArmsMeetingDrawing([[P(45.799, 15.9705), nearMiss]], [street])).toEqual([]);
        expect(appliedArmsMeetingDrawing([[P(45.81, 15.98), P(45.811, 15.98)]], [street])).toEqual([]);
    });

    it('gives the junction builder a junction the drawing takes part in', () => {
        const { buildCorridorJunctionTreatmentsForEntries } = require('../../frontend/js/corridor-profile.js');
        const frame = require('../../frontend/js/metric-frame.js').frameAt([15.971, 45.8]);
        const onEdge = P(45.8, 15.9705);
        const drawing = [{ points: [P(45.7995, 15.9705), onEdge], profile: PROFILE, corridorId: 'active-drawing' }];
        // The drawing alone ends in a dead end: no junction to draw.
        expect(buildCorridorJunctionTreatmentsForEntries(drawing, frame)).toEqual([]);
        const arms = appliedArmsMeetingDrawing(drawing.map(entry => entry.points), [street]);
        const junctions = buildCorridorJunctionTreatmentsForEntries(drawing.concat(arms), frame);
        expect(junctions).toHaveLength(1);
        expect(junctions[0].degree).toBe(3);
        expect(junctions[0].lat).toBeCloseTo(onEdge.lat, 7);
        expect(junctions[0].lng).toBeCloseTo(onEdge.lng, 7);
        expect([...junctions[0].corridorIds].sort()).toEqual(['active-drawing', 'p1']);
    });
});

describe('the preview is wired into the junction pass only', () => {
    function spy(impl) {
        const fn = (...args) => {
            fn.calls.push(args);
            const result = impl(...args);
            fn.results.push(result);
            return result;
        };
        fn.calls = [];
        fn.results = [];
        return fn;
    }

    // An applied road 30 m north of the origin, and an applied track 300 m north; neither is drawn by
    // the drawing tool, which must only borrow their arms for its junctions.
    const appliedCorridor = (proposalId, north, profile, extra = {}) => ({
        proposalId, applied: true,
        roadProposal: { definition: { points: [[at(-50, north), at(50, north), at(150, north)]], segmentIds: ['s1'], profile, width: 10 } },
        ...extra
    });

    // The drawing tool with the real corridor-profile builders wrapped in spies, open on the road.
    async function openOver(proposals, globals = {}) {
        env = loadRoadDrawing({ proposals, renderer: true, globals: { __corridorJunctionPaint: junctionPaint, ...globals } });
        const wrapped = {};
        ['buildCorridorJunctionTreatmentsForEntries', 'buildCorridorLaneMarkingsForEntries', 'buildCorridorStrips', 'buildCorridorPieceStrips']
            .forEach(name => { wrapped[name] = globalThis[name] = spy(globalThis[name]); });
        await env.api.requestCorridorDrawingTool('road');
        return wrapped;
    }
    const corridorIdsOf = entries => [...new Set(entries.map(entry => entry.corridorId))];
    const polygonFeature = polygon => {
        const rings = polygon.length && Array.isArray(polygon[0]) ? polygon : [polygon];
        return turf.polygon(rings.map(ring => {
            const coordinates = ring.map(point => [point.lng, point.lat]);
            coordinates.push(coordinates[0]);
            return coordinates;
        }));
    };
    const overlapAreaWith = (strips, geometry) => (strips || [])
        .filter(strip => strip.type === 'driving')
        .flatMap(strip => strip.polygons || [])
        .reduce((area, polygon) => {
            const overlap = turf.intersect(polygonFeature(polygon), turf.feature(geometry));
            return area + (overlap ? turf.area(overlap) : 0);
        }, 0);

    it('adds the applied arms to the junction builder, never to the strips or markings', async () => {
        const node = at(20, 30);
        // A clean, axis-aligned treatment keeps this wiring regression focused on the render
        // partition instead of the real builder's very narrow arm geometry at this snapped node.
        const coverage = [at(10, 20), at(30, 20), at(30, 40), at(10, 40), at(10, 20)];
        const treatment = {
            lat: node.lat, lng: node.lng, degree: 3, corridorIds: ['active-drawing', 'p1'],
            arms: [], surfacePolygons: [coverage], cornerPolygons: []
        };
        const previewUpdates = [];
        const wrapped = await openOver([appliedCorridor('p1', 30, PROFILE)], {
            buildCorridorJunctionTreatmentsForEntries: () => [treatment],
            setCorridorDrawingJunctionPreview: junctions => previewUpdates.push(junctions)
        });
        // A T: from the south onto the middle of the applied road's first edge.
        await env.click(at(20, -60));
        await env.click(at(20, 27));
        const [junctionEntries] = wrapped.buildCorridorJunctionTreatmentsForEntries.calls.at(-1);
        expect(corridorIdsOf(junctionEntries).sort()).toEqual(['active-drawing', 'p1']);
        const [markingEntries] = wrapped.buildCorridorLaneMarkingsForEntries.calls.at(-1);
        expect(corridorIdsOf(markingEntries)).toEqual(['active-drawing']);
        // The strips are the drawing's own piece only: one render, of its 90 m.
        expect(env.rendered.strips).toHaveLength(1);
        wrapped.buildCorridorStrips.calls.forEach(([segments]) => expect(segments).toEqual([env.session.roadSegments[0]]));
        // The shared junction is drawn, at the T's node, with both corridors in it.
        const [{ junctions, pane }] = env.rendered.junctions.slice(-1);
        expect(pane).toBe('corridorJunctionsPane');
        expect(junctions).toHaveLength(1);
        expect(junctions[0].degree).toBe(3);
        expect([...junctions[0].corridorIds].sort()).toEqual(['active-drawing', 'p1']);
        expect(junctions[0].lat).toBeCloseTo(node.lat, 7);
        const junctionCoverage = junctionPaint.paintOf(junctions[0]).coverage;
        const rawDraftStrips = wrapped.buildCorridorStrips.results.at(-1);
        const renderedDraftStrips = env.rendered.strips.at(-1).strips;
        expect(overlapAreaWith(rawDraftStrips, junctionCoverage)).toBeGreaterThan(0.01);
        expect(overlapAreaWith(renderedDraftStrips, junctionCoverage)).toBeLessThan(0.01);
        expect(previewUpdates.at(-1)).toEqual(junctions);
        expect(env.session.roadStripLayer).not.toBeNull();
        expect(env.map.hasLayer(env.session.roadStripLayer)).toBe(true);
        env.api.clearRoadStripLayer();
        expect(previewUpdates.at(-1)).toEqual([]);
    });

    it('draws the transition pieces like the applied renderer does', async () => {
        const wrapped = await openOver([]);
        // Two stretches meeting end to end at 100 m east: the second starts exactly on the first's end.
        await env.click(at(0, 0));
        await env.click(at(100, 0));
        env.key('Escape');
        await env.idle();
        await env.click(at(100, 0), { altKey: true });
        await env.click(at(200, 0));
        expect(env.session.roadSegmentIds).toEqual(['s1', 's2']);
        // The second stretch is wider: a transition zone tapers between them.
        env.session.roadSegmentProfiles = { s2: globalThis.corridorProfileFromLegacy(14, 2, false) };
        wrapped.buildCorridorPieceStrips.calls.length = 0;
        wrapped.buildCorridorStrips.calls.length = 0;
        env.api.redrawRoadStrips();
        const tapered = wrapped.buildCorridorPieceStrips.calls.map(([piece]) => piece).filter(piece => piece.taper);
        expect(tapered.length).toBeGreaterThan(0);
        // A body piece is drawn by its own profile.
        expect(wrapped.buildCorridorStrips.calls.length).toBeGreaterThan(0);
        expect(env.rendered.strips.at(-1).options.pane).toBe('corridorStripsPane');
    });

    it('keeps only junctions the drawing takes part in', async () => {
        const theirs = { lat: at(0, 500).lat, lng: at(0, 500).lng, degree: 3, corridorIds: ['p1', 'p2'], arms: [] };
        const ours = { lat: at(0, 0).lat, lng: at(0, 0).lng, degree: 3, corridorIds: ['active-drawing', 'p1'], arms: [] };
        await openOver([], { buildCorridorJunctionTreatmentsForEntries: () => [theirs, ours] });
        await env.click(at(0, 0));
        await env.click(at(100, 0));
        expect(env.rendered.junctions.at(-1).junctions).toEqual([ours]);
    });

    it('looks at applied corridors of either kind, near the drawing only', () => {
        const track = corridorProfile.corridorDefaultTrackProfile();
        env = loadRoadDrawing({
            proposals: [
                appliedCorridor('track-1', 30, track),
                appliedCorridor('draft-road', 30, PROFILE, { applied: false }),
                appliedCorridor('far-road', 900, PROFILE)
            ]
        });
        // The drawing meets both corridors 30 m north at their middle vertex.
        const drawing = [{ points: [at(50, -60), at(50, 30)], profile: PROFILE, corridorId: 'active-drawing' }];
        const arms = env.api.appliedJunctionArmsForDrawing(drawing);
        // The applied track joins (a level crossing shares the node); the unapplied road does not.
        expect(arms.map(arm => arm.corridorId)).toEqual(['track-1']);
        expect(arms[0].points).toHaveLength(3);
        expect(env.api.appliedJunctionArmsForDrawing([])).toEqual([]);
    });

    it('borrows the renderer’s surface runs rather than a protected bridge or tunnel span', () => {
        const proposal = appliedCorridor('bridge', 30, PROFILE);
        const calls = [];
        env = loadRoadDrawing({ proposals: [proposal], globals: {
            corridorJunctionEntriesFor: (record, definition) => {
                calls.push([record.proposalId, definition]);
                return []; // The applied renderer excluded this protected span.
            }
        } });
        expect(env.api.appliedJunctionArmsForDrawing([{ points: [at(50, -60), at(50, 30)] }])).toEqual([]);
        expect(calls).toHaveLength(1);
        expect(calls[0][0]).toBe('bridge');
    });
});
