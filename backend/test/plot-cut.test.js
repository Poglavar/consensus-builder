// A line draws what was drawn, between the places it anchors — and leaves the fabric conforming.
//
// Two properties are pinned here, because breaking either one is silent. First, ANCHORING: a new
// boundary needs a node at each end, so the line has to meet the fabric in at least two places (a
// crossing, or an end on an existing corner) and it runs between the outermost two and no further.
// Neither of the two earlier answers survives: extending both ends by a quarter of the pool's bbox
// made every cut global, and carrying a loose end "to the first thing it meets" put the line where
// the user had not drawn it. Second, CONFORMANCE: where the line lands on an edge, the vertex has
// to appear in the neighbour's ring too. Miss that and the two sides no longer share an edge — they
// look identical on the map, and the next drag of that node opens a gap along a boundary nobody
// touched.
import { describe, it, expect } from 'vitest';
import * as turf from '@turf/turf';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const cut = require('../../frontend/js/proposals/plot-cut.js');
const topo = require('../../frontend/js/proposals/plot-topology.js');

// Degrees per pixel: the pool below is then ~1000 × 714 px, a realistic editor viewport, so the
// pixel radii under test mean what they mean on screen.
const SCALE = { x: 2e-6, y: 1.4e-6 };

const ring = (west, south, east, north) => [
    [west, south], [east, south], [east, north], [west, north], [west, south]
];
const polygon = coords => ({ type: 'Polygon', coordinates: [coords] });

// A square pool split down the middle: plot A west, plot B east, sharing one boundary.
const POOL = polygon(ring(16.000, 45.800, 16.002, 45.801));
const PLOT_A = { geometry: polygon(ring(16.000, 45.800, 16.001, 45.801)) };
const PLOT_B = { geometry: polygon(ring(16.001, 45.800, 16.002, 45.801)) };
const PLOTS = [PLOT_A, PLOT_B];

function contextFor(plots = PLOTS) {
    const boundaryIndex = topo.boundaryIndexOf(POOL);
    const topology = topo.annotateBoundary(topo.buildTopology(plots), boundaryIndex);
    return { topology, pool: POOL, scale: SCALE };
}

const areaOf = geometry => turf.area({ type: 'Feature', properties: {}, geometry });
const hasVertex = (geometry, coord, tol = 1e-9) => (geometry.coordinates || [])
    .some(r => r.some(c => Math.abs(c[0] - coord[0]) <= tol && Math.abs(c[1] - coord[1]) <= tol));

describe('snapPoint', () => {
    it('snaps to a node inside the radius and reports which one', () => {
        const context = contextFor();
        // ~5 px south-east of the shared node at the pool's south edge.
        const snap = cut.snapPoint([16.001 + 3 * SCALE.x, 45.800 + 4 * SCALE.y], context, { scale: SCALE });

        expect(snap.kind).toBe('node');
        expect(snap.coord).toEqual([16.001, 45.800]);
        expect(snap.nodeId).toBeGreaterThanOrEqual(0);
    });

    it('prefers a node to an edge even when the edge is nearer', () => {
        const context = contextFor();
        // 1 px off the shared edge, 8 px from the node it ends at: the edge is nearer, the node wins.
        const snap = cut.snapPoint([16.001 + 1 * SCALE.x, 45.800 + 8 * SCALE.y], context, { scale: SCALE });

        expect(snap.kind).toBe('node');
        expect(snap.coord).toEqual([16.001, 45.800]);
    });

    it('projects onto an edge when no node is close', () => {
        const context = contextFor();
        const snap = cut.snapPoint([16.001 + 2 * SCALE.x, 45.8005], context, { scale: SCALE });

        expect(snap.kind).toBe('edge');
        expect(snap.coord[0]).toBeCloseTo(16.001, 12);
        expect(snap.coord[1]).toBeCloseTo(45.8005, 12);
    });

    it('leaves a point alone when nothing is within reach', () => {
        const context = contextFor();
        const snap = cut.snapPoint([16.0005, 45.8005], context, { scale: SCALE });

        expect(snap.kind).toBe('free');
        expect(snap.coord).toEqual([16.0005, 45.8005]);
    });
});

describe('resolveCut', () => {
    it('does nothing at all with a line that anchors on nothing', () => {
        const context = contextFor();
        // Drawn wholly inside plot A, touching no boundary. It implies no new boundary, so it is
        // not carried on to anything — the old rule extended it to the first thing it met, which
        // put the line somewhere it had not been drawn.
        const resolved = cut.resolveCut([[16.0003, 45.8005], [16.0007, 45.8005]], context, { turf }, { scale: SCALE });

        expect(resolved.ok).toBe(false);
        expect(resolved.reason).toBe('no-anchors');
    });

    it('needs two anchors, not one', () => {
        const context = contextFor();
        // Starts on the west outline and stops in the middle of plot A: one anchor.
        const resolved = cut.resolveCut([[16.000, 45.8005], [16.0007, 45.8005]], context, { turf }, { scale: SCALE });

        expect(resolved.anchors.length).toBe(1);
        expect(resolved.reason).toBe('no-anchors');
    });

    it('trims to the anchored stretch and never past it', () => {
        const context = contextFor();
        // Drawn well beyond the pool on both sides. What survives is west outline → east outline.
        const resolved = cut.resolveCut([[15.998, 45.8005], [16.004, 45.8005]], context, { turf }, { scale: SCALE });

        expect(resolved.ok).toBe(true);
        expect(resolved.points[0][0]).toBeCloseTo(16.000, 9);
        expect(resolved.points[resolved.points.length - 1][0]).toBeCloseTo(16.002, 9);
    });

    it('takes an end placed on an existing corner as one of the two anchors', () => {
        const context = contextFor();
        // From the shared node at the pool's south edge, north-east out through the east outline:
        // one anchor from the corner it starts on, one from the boundary it crosses.
        const resolved = cut.resolveCut([[16.001, 45.800], [16.0025, 45.8005]], context, { turf }, { scale: SCALE });

        expect(resolved.ok).toBe(true);
        expect(resolved.ends[0].kind).toBe('node');
        expect(resolved.anchors.length).toBeGreaterThanOrEqual(2);
    });

    it('reports every crossing as a node about to be created', () => {
        const context = contextFor();
        const resolved = cut.resolveCut([[15.999, 45.8005], [16.003, 45.8005]], context, { turf }, { scale: SCALE });

        // West outline, the A|B boundary, east outline — each once, despite the pool ring and the
        // plot rings both offering the same segment.
        const xs = resolved.crossings.map(c => Number(c.coord[0].toFixed(6))).sort();
        expect(xs).toEqual([16.000, 16.001, 16.002]);
    });

    it('takes a frozen point exactly where it was clicked', () => {
        const context = contextFor();
        // A middle vertex two pixels from the shared boundary: it would snap onto it, but Shift
        // was held. Ends are tested separately — they terminate whether or not they snapped.
        const near = [16.001 + 2 * SCALE.x, 45.8005];
        const line = [[16.0003, 45.8003], near, [16.0003, 45.8007]];

        const snapped = cut.resolveCut(line, context, { turf }, { scale: SCALE });
        const frozen = cut.resolveCut(line, context, { turf }, { scale: SCALE, frozen: [false, true, false] });

        expect(snapped.points[1][0]).toBeCloseTo(16.001, 12);
        expect(frozen.points[1]).toEqual(near);
    });

    it('keeps the Shift flags aligned when a repeated click is dropped', () => {
        const context = contextFor();
        const near = [16.001 + 2 * SCALE.x, 45.8005];
        // The user double-clicked the first point. Deduping the coordinates without deduping the
        // flags alongside them would shift every later flag by one, and the wrong vertex would be
        // the frozen one — which looks like snapping randomly failing.
        const line = [[16.0003, 45.8003], [16.0003, 45.8003], near, [16.0003, 45.8007]];

        const resolved = cut.resolveCut(line, context, { turf }, { scale: SCALE, frozen: [false, false, true, false] });

        expect(resolved.points[1]).toEqual(near);
    });

    it('a frozen end can still anchor by crossing, it just does not snap', () => {
        const context = contextFor();
        // Drawn past both outlines with Shift held throughout: no snapping anywhere, but the two
        // crossings are anchors all the same.
        const resolved = cut.resolveCut([[15.998, 45.8005], [16.004, 45.8005]], context, { turf },
            { scale: SCALE, frozen: [true, true] });

        expect(resolved.ok).toBe(true);
        expect(resolved.ends.every(e => e.kind === 'crossing')).toBe(true);
    });

    it('refuses a line that is not a line', () => {
        const context = contextFor();
        expect(cut.resolveCut([[16.0005, 45.8005]], context, { turf }, { scale: SCALE }).reason).toBe('too-few');
        // Two clicks in the same spot are one point, not a zero-length cut.
        expect(cut.resolveCut([[16.0005, 45.8005], [16.0005, 45.8005]], context, { turf }, { scale: SCALE }).reason)
            .toBe('too-few');
    });
});

describe('insertNodesIntoRings', () => {
    it('puts the vertex in every ring whose boundary passes through it', () => {
        const geometries = [PLOT_A.geometry, PLOT_B.geometry];

        const out = cut.insertNodesIntoRings(geometries, [[16.001, 45.8005]]);

        expect(hasVertex(out[0], [16.001, 45.8005])).toBe(true);
        expect(hasVertex(out[1], [16.001, 45.8005])).toBe(true);
        expect(out.inserted).toBe(2);
    });

    it('does not duplicate a vertex that is already there', () => {
        const before = PLOT_A.geometry.coordinates[0].length;

        const out = cut.insertNodesIntoRings([PLOT_A.geometry], [[16.001, 45.800]]);

        expect(out[0].coordinates[0].length).toBe(before);
        expect(out.inserted).toBe(0);
    });

    it('leaves the input untouched', () => {
        const before = JSON.stringify(PLOT_A.geometry);
        cut.insertNodesIntoRings([PLOT_A.geometry], [[16.001, 45.8005]]);
        expect(JSON.stringify(PLOT_A.geometry)).toBe(before);
    });
});

describe('cutPlots', () => {
    it('splits only the plot the line runs through', () => {
        const context = contextFor();
        // West outline to the A|B boundary: two anchors, and only plot A between them.
        const result = cut.cutPlots(PLOTS, [[16.000, 45.8005], [16.001, 45.8005]], context, { turf }, { scale: SCALE });

        expect(result.ok).toBe(true);
        // Plot A becomes two, plot B stays one.
        expect(result.results.filter(r => r.sourceIndex === 0).length).toBe(2);
        expect(result.results.filter(r => r.sourceIndex === 1).length).toBe(1);
        expect(result.added).toBe(1);
    });

    it('gives the untouched neighbour the node the cut landed on', () => {
        const context = contextFor();

        const result = cut.cutPlots(PLOTS, [[16.000, 45.8005], [16.001, 45.8005]], context, { turf }, { scale: SCALE });
        const neighbour = result.results.find(r => r.sourceIndex === 1);

        // This is the conformance half. Without it plot B still reads 45.800→45.801 as ONE edge
        // while plot A now has a vertex halfway along it, so the two stop sharing that boundary.
        expect(hasVertex(neighbour.geometry, [16.001, 45.8005], 1e-7)).toBe(true);
    });

    it('conserves the land', () => {
        const context = contextFor();

        const result = cut.cutPlots(PLOTS, [[16.000, 45.8005], [16.001, 45.8005]], context, { turf }, { scale: SCALE });
        const total = result.results.reduce((sum, r) => sum + areaOf(r.geometry), 0);

        expect(total).toBeCloseTo(areaOf(POOL), 3);
    });

    it('still cuts clean across when the line is drawn past both sides', () => {
        const context = contextFor();

        const result = cut.cutPlots(PLOTS, [[15.999, 45.8005], [16.003, 45.8005]], context, { turf }, { scale: SCALE });

        expect(result.ok).toBe(true);
        expect(result.results.length).toBe(4);
        expect(result.results.reduce((sum, r) => sum + areaOf(r.geometry), 0)).toBeCloseTo(areaOf(POOL), 3);
    });

    it('reports a line that does nothing rather than pretending to work', () => {
        const context = contextFor();
        // Drawn in open ground well away from the pool: it anchors on nothing.
        const result = cut.cutPlots(PLOTS, [[15.998, 45.7990], [15.9985, 45.7995]], context, { turf }, { scale: SCALE });

        expect(result.ok).toBe(false);
        expect(result.reason).toBe('no-anchors');
    });

    it('does not split when the line merely runs along a boundary that is already there', () => {
        const context = contextFor();
        // Straight down the A|B boundary: two anchors (both ends on it), but no plot is divided by
        // a line that follows a border it already has.
        const result = cut.cutPlots(PLOTS, [[16.001, 45.8002], [16.001, 45.8008]], context, { turf }, { scale: SCALE });

        expect(result.ok).toBe(false);
        expect(['no-split', 'no-anchors']).toContain(result.reason);
    });

    it('splits along a bent line, noding every crossing', () => {
        const context = contextFor();
        // An L drawn inside plot A: down from the north edge, then east into the A|B boundary.
        const result = cut.cutPlots(PLOTS,
            [[16.0005, 45.801], [16.0005, 45.8005], [16.001, 45.8005]], context, { turf }, { scale: SCALE });

        expect(result.ok).toBe(true);
        expect(result.results.filter(r => r.sourceIndex === 0).length).toBe(2);
        expect(result.results.reduce((sum, r) => sum + areaOf(r.geometry), 0)).toBeCloseTo(areaOf(POOL), 3);
    });
});

describe('the two faces quote the same numbers along their new border', () => {
    it('shares the cut coordinates bit-for-bit, not merely to within a tolerance', () => {
        const context = contextFor();

        const result = cut.cutPlots(PLOTS, [[16.000, 45.8005], [16.001, 45.8005]], context, { turf }, { scale: SCALE });
        const [west, east] = result.results.filter(r => r.sourceIndex === 0).map(r => r.geometry);

        // Every coordinate of the shared border has to be the SAME double on both faces. Computing
        // each side independently produced coordinates 3.5e-15° apart — geometrically identical,
        // and enough that polygonize saw no shared node at all, dropped the face, and took its
        // land with it. "Close enough" is not a thing a planar subdivision can be.
        const asKeys = geometry => new Set(geometry.coordinates[0].map(c => `${c[0]},${c[1]}`));
        const shared = [...asKeys(west)].filter(k => asKeys(east).has(k));

        expect(shared.length).toBeGreaterThanOrEqual(2);
    });

    it('never hands back more land than it was given, even for a plot with a hole', () => {
        // A donut. polygonize reads a hole ring as an ordinary edge and returns the hole ITSELF as
        // a face: on one Borovje plot that turned 17,383 m² into 29,158. Refusing is acceptable
        // here; inventing 11,774 m² is not.
        const donut = {
            geometry: {
                type: 'Polygon',
                coordinates: [
                    ring(16.000, 45.800, 16.002, 45.801),
                    ring(16.0012, 45.8004, 16.0016, 45.8006).slice().reverse()
                ]
            }
        };
        const boundaryIndex = topo.boundaryIndexOf(POOL);
        const context = {
            topology: topo.annotateBoundary(topo.buildTopology([donut]), boundaryIndex),
            pool: POOL, scale: SCALE
        };

        const result = cut.cutPlots([donut], [[15.9995, 45.8003], [16.0025, 45.8003]], context, { turf }, { scale: SCALE });

        if (result.ok) {
            const total = result.results.reduce((sum, r) => sum + areaOf(r.geometry), 0);
            expect(total).toBeCloseTo(areaOf(donut.geometry), 2);
        } else {
            expect(result.reason).toBe('no-split');
        }
    });
});

describe('boundaryGroups', () => {
    it('groups the edges two plots share, and offers nothing on the pooled outline', () => {
        const context = contextFor();

        const groups = cut.boundaryGroups(context.topology);

        expect(groups.length).toBe(1);
        expect(groups[0].plots).toEqual([0, 1]);
        expect(cut.boundaryPaths(groups[0], context.topology).length).toBe(groups[0].edges.length);
    });

    it('grows to cover a boundary made of several edges', () => {
        // Same two plots, but the shared line has a bend in it, so it is two edges — erasing it
        // has to take the whole chain or it would leave a slit rather than one merged plot.
        const west = { geometry: polygon([
            [16.000, 45.800], [16.001, 45.800], [16.0012, 45.8005], [16.001, 45.801], [16.000, 45.801], [16.000, 45.800]
        ]) };
        const east = { geometry: polygon([
            [16.001, 45.800], [16.002, 45.800], [16.002, 45.801], [16.001, 45.801], [16.0012, 45.8005], [16.001, 45.800]
        ]) };
        const boundaryIndex = topo.boundaryIndexOf(POOL);
        const topology = topo.annotateBoundary(topo.buildTopology([west, east]), boundaryIndex);

        const groups = cut.boundaryGroups(topology);

        expect(groups.length).toBe(1);
        expect(groups[0].edges.length).toBe(2);
    });
});
