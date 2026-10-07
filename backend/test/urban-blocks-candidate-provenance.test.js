// Provenance must show the actual perimeter walk behind fallback points.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import * as turfModule from '@turf/turf';

const require = createRequire(import.meta.url);
const turf = turfModule.default || turfModule;
const model = require('../../frontend/js/urban-blocks-model.js');
const subdivision = require('../../frontend/js/urban-blocks-subdivision.js');

const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const pathLength = points => points.slice(1).reduce((sum, point, i) => sum + distance(points[i], point), 0);
const eq = (a, b, tolerance = 1e-7) => expect(distance(a, b)).toBeLessThanOrEqual(tolerance);
const localRectangle = [[0, 0], [400, 0], [400, 300], [0, 300], [0, 0]];

const METRES_PER_DEGREE = 111_195;
const highLatPoint = ([x, y]) => [15 + x / (METRES_PER_DEGREE * Math.cos(45.8 * Math.PI / 180)), 45.8 + y / METRES_PER_DEGREE];
const highLatRoad = (id, points) => ({ type: 'Feature', id, properties: { highway: 'residential' },
    geometry: { type: 'LineString', coordinates: points.map(highLatPoint) } });
const highLatBlock = turf.polygon([[...[ [0, 0], [140, 0], [140, 140], [0, 140], [0, 0] ].map(highLatPoint)]]);
const highLatRoads = turf.featureCollection([
    highLatRoad('curved-alley', [[0, 70], [25, 70], [50, 60], [70, 60]]),
    highLatRoad('right-boundary', [[140, 0], [140, 140]]),
    highLatRoad('right-tee', [[190, 70], [140, 70]])
]);

function assertProvenanceShape(candidate) {
    const provenance = candidate.provenance;
    expect(provenance).toMatchObject({
        method: 'spacing',
        sourceId: expect.any(String),
        sourceKind: expect.stringMatching(/^(t|dead-end-root|perimeter)$/),
        sourcePoint: expect.any(Array),
        boundarySource: expect.any(Array),
        perimeterPath: expect.any(Array),
        perimeterLengthM: expect.any(Number)
    });
}

describe('urban block perimeter candidate provenance', () => {
    it('does not invent a corner anchor when there is no natural boundary entrance', () => {
        const parent = { rings: [localRectangle] };
        const candidates = subdivision.perimeterCandidates(parent, [], 150);
        const anchor = { id: 'tee-anchor', kind: 't', point: [0, 0], path: [[0, 0]] };

        expect(candidates).toEqual([]);
        for (const invalidStep of [0, -1, NaN, Infinity]) {
            expect(subdivision.perimeterCandidates(parent, [anchor], invalidStep)).toEqual([]);
        }
    });

    it('spaces from natural anchors, resets at close anchors, and bounds the closing gap', () => {
        const anchors = [
            { id: 'tee-start', kind: 't', point: [0, 0], path: [[0, 0]] },
            { id: 'tee-90', kind: 't', point: [90, 0], path: [[90, 0]] },
            { id: 'tee-110', kind: 't', point: [110, 0], path: [[110, 0]] },
            { id: 'tee-1300', kind: 't', point: [100, 300], path: [[100, 300]] }
        ];
        const candidates = subdivision.perimeterCandidates({ rings: [localRectangle] }, anchors, 150);
        const candidateAt260 = candidates.find(candidate => distance(candidate.point, [260, 0]) < 1e-8);

        expect(candidateAt260).toBeDefined();
        eq(candidateAt260.provenance.sourcePoint, [110, 0], 1e-8);
        expect(candidateAt260.provenance.sourceId).toBe('tee-110');
        expect(candidates.some(candidate => distance(candidate.point, [150, 0]) < 1e-8)).toBe(false);
        expect(candidates.some(candidate => distance(candidate.point, [0, 0]) < 1e-8)).toBe(false);

        const visited = [
            ...candidates.map(candidate => ({ id: candidate.id, point: candidate.point, candidate })),
            ...anchors.map(anchor => ({ id: anchor.id, point: anchor.point, anchor }))
        ];
        const along = point => {
            if (Math.abs(point[1]) < 1e-7) return point[0];
            if (Math.abs(point[0] - 400) < 1e-7) return 400 + point[1];
            if (Math.abs(point[1] - 300) < 1e-7) return 700 + 400 - point[0];
            return 1400 - point[1];
        };
        const ringOrder = visited.map(item => ({ ...item, at: (along(item.point) + 1400 - along(anchors[0].point)) % 1400 }))
            .sort((a, b) => a.at - b.at);
        const fallbacks = ringOrder.filter(item => item.candidate);
        for (const candidate of fallbacks) {
            assertProvenanceShape(candidate.candidate);
            expect(candidate.candidate.provenance.sourcePoint).toBeDefined();
            expect(candidate.candidate.provenance.perimeterLengthM).toBeCloseTo(150, 6);
        }
        for (let i = 1; i < ringOrder.length; i++) expect(ringOrder[i].at - ringOrder[i - 1].at).toBeLessThanOrEqual(150 + 1e-8);
        expect(1400 - ringOrder.at(-1).at).toBeLessThanOrEqual(150 + 1e-8);
        eq(fallbacks[0].candidate.provenance.sourcePoint, [110, 0], 1e-8);
        for (let i = 1; i < ringOrder.length; i++) {
            const current = ringOrder[i];
            if (!current.candidate) continue;
            const previous = ringOrder[i - 1];
            expect(current.candidate.provenance.sourceId).toBe(previous.id);
            expect(current.candidate.provenance.sourceKind).toBe(previous.candidate ? 'perimeter' : previous.anchor.kind);
            eq(current.candidate.provenance.sourcePoint, previous.point, 1e-8);
        }
    });

    it('walks forward across ring closure, carries skipped-sample provenance, and respects winding', () => {
        const anchor = [0, 100];
        const tee = { id: 'tee-anchor', kind: 't', point: anchor, path: [anchor] };
        const startAlong = [
            subdivision.perimeterCandidates({ rings: [localRectangle] }, [tee], 300),
            subdivision.perimeterCandidates({ rings: [localRectangle.slice().reverse()] }, [tee], 300)
        ];
        for (const candidates of startAlong) {
            expect(candidates).toHaveLength(4);
            for (const candidate of candidates) {
                assertProvenanceShape(candidate);
                expect(candidate.provenance.method).toBe('spacing');
                expect(candidate.provenance.perimeterLengthM).toBeCloseTo(300, 6);
                expect(pathLength(candidate.provenance.perimeterPath)).toBeCloseTo(300, 6);
            }
            expect(candidates[0].provenance.sourceId).toBe(tee.id);
            expect(candidates[0].provenance.sourceKind).toBe('t');
            expect(candidates[0].provenance.sourcePoint).toEqual(anchor);
        }
        expect(startAlong[0][0].provenance.perimeterPath).toContainEqual([0, 0]);

        const longArc = subdivision.perimeterCandidates({ rings: [localRectangle] }, [tee], 800)[0];
        expect(longArc.provenance.perimeterLengthM).toBeCloseTo(800, 6);
        expect(pathLength(longArc.provenance.perimeterPath)).toBeCloseTo(800, 6);
        expect(longArc.provenance.perimeterLengthM).toBeGreaterThan(1400 / 2);

        const skipped = { id: 'tee-at-skipped-sample', kind: 't', point: [200, 0], path: [[200, 0]] };
        const afterSkipped = subdivision.perimeterCandidates({ rings: [localRectangle] }, [tee, skipped], 300);
        expect(afterSkipped[0].provenance.sourceId).toBe(skipped.id);
        expect(afterSkipped[0].provenance.sourceKind).toBe('t');
        expect(afterSkipped[0].provenance.sourcePoint).toEqual(skipped.point);
        expect(afterSkipped[0].provenance.perimeterLengthM).toBeCloseTo(300, 6);

        const deadEnd = { id: 'dead-end-id', kind: 'dead-end', point: [70, 60], path: [[0, 70], [25, 70], [70, 60]] };
        const fromDeadEndRoot = subdivision.perimeterCandidates({ rings: [localRectangle] }, [deadEnd], 300)[0];
        expect(fromDeadEndRoot.provenance.sourceId).toBe(deadEnd.id);
        expect(fromDeadEndRoot.provenance.sourceKind).toBe('dead-end-root');
        eq(fromDeadEndRoot.provenance.sourcePoint, [0, 70], 1e-8);
    });

    it('keeps one walk with no repeated root when natural anchors repeat', () => {
        const root = { id: 'tee-root', kind: 't', point: [0, 0], path: [[0, 0]] };
        const repeated = { id: 'tee-root-duplicate', kind: 't', point: [0, 0], path: [[0, 0]] };
        const candidates = subdivision.perimeterCandidates({ rings: [localRectangle] }, [root, repeated], 150);

        expect(candidates.every(candidate => distance(candidate.point, root.point) > 1e-8)).toBe(true);
        expect(new Set(candidates.map(candidate => candidate.id)).size).toBe(candidates.length);
        expect(candidates[0].provenance.sourcePoint).toEqual(root.point);
        expect(candidates[0].provenance.sourceId).toBe(root.id);
    });

    it('traces a concave boundary arc around its notch instead of a crossing chord', () => {
        const ring = [[0, 0], [300, 0], [300, 100], [100, 100], [100, 300], [0, 300], [0, 0]];
        const source = [300, 100];
        const tee = { id: 'notch-tee', kind: 't', point: source, path: [source] };
        const candidate = subdivision.perimeterCandidates({ rings: [ring] }, [tee], 300)[0];
        const provenance = candidate.provenance;
        const polygon = turf.polygon([[...[...ring].map(([x, y]) => [x / METRES_PER_DEGREE, y / METRES_PER_DEGREE])]]);
        const chordMidpoint = [(source[0] + candidate.point[0]) / (2 * METRES_PER_DEGREE),
            (source[1] + candidate.point[1]) / (2 * METRES_PER_DEGREE)];

        expect(provenance.perimeterPath).toContainEqual([100, 100]);
        expect(pathLength(provenance.perimeterPath)).toBeCloseTo(300, 6);
        expect(distance(source, candidate.point)).toBeLessThan(provenance.perimeterLengthM);
        expect(turf.booleanPointInPolygon(turf.point(chordMidpoint), polygon)).toBe(false);
        expect(provenance.perimeterPath[0]).toEqual(source);
        expect(provenance.perimeterPath.at(-1)).toEqual(candidate.point);
    });

    it('keeps natural preview points stable while spacing changes the single fallback walk', () => {
        const preview = step => subdivision.preview({ block: highLatBlock, roads: highLatRoads,
            options: { targetAreaM2: 10000, maxSideM: 150, perimeterStepM: step } }, turf, model);
        const sparse = preview(50), wide = preview(200);
        const natural = candidates => candidates.features.filter(feature => ['t', 'dead-end'].includes(feature.properties.kind));
        expect(natural(sparse.candidates)).toEqual(natural(wide.candidates));

        const firstSpacing = result => result.candidates.features.find(feature => feature.properties.provenance?.method === 'spacing');
        const sparseFirst = firstSpacing(sparse), wideFirst = firstSpacing(wide);
        expect(sparseFirst).toBeDefined();
        expect(wideFirst).toBeDefined();
        assertProvenanceShape(sparseFirst.properties);
        assertProvenanceShape(wideFirst.properties);
        expect(sparseFirst.properties.provenance.sourceId).toBe(wideFirst.properties.provenance.sourceId);
        eq(sparseFirst.properties.provenance.sourcePoint, wideFirst.properties.provenance.sourcePoint, 1e-8);
        expect(sparseFirst.geometry.coordinates).not.toEqual(wideFirst.geometry.coordinates);

        const spacingPoints = candidates => candidates.features.filter(feature => feature.properties.kind === 'perimeter');
        expect(spacingPoints(sparse.candidates).every(feature => feature.properties.provenance.method === 'spacing')).toBe(true);
        expect(spacingPoints(wide.candidates).every(feature => feature.properties.provenance.method === 'spacing')).toBe(true);
        expect(sparse.candidates.features.some(feature => feature.properties.provenance?.method === 'continuation')).toBe(false);
        expect(wide.candidates.features.some(feature => feature.properties.provenance?.method === 'continuation')).toBe(false);
        expect(sparse.candidates.features.some(feature => feature.properties.provenance?.approachPath)).toBe(false);
    });

    it('plans only cuts whose perimeter endpoints appear in the preview candidates', () => {
        const block = turf.polygon([[...[ [0, 0], [300, 0], [300, 200], [0, 200], [0, 0] ].map(highLatPoint)]]);
        const planInput = { block, roads: turf.featureCollection([
            highLatRoad('top-boundary', [[0, 200], [300, 200]]),
            highLatRoad('top-stem', [[150, 250], [150, 200]]),
            highLatRoad('bottom-boundary', [[0, 0], [300, 0]]),
            highLatRoad('bottom-stem', [[150, -50], [150, 0]])
        ]), options: { targetAreaM2: 10000, maxSideM: 150, perimeterStepM: 150 } };
        const preview = subdivision.preview(planInput, turf, model);
        const plan = subdivision.plan(planInput, turf, model);
        const perimeterPreview = preview.candidates.features.filter(feature => feature.properties.kind === 'perimeter');
        const distanceMetres = (a, b) => distance(a, b) * METRES_PER_DEGREE * Math.cos(45.8 * Math.PI / 180);

        expect(plan.stats.fallbackCount).toBe(preview.stats.fallbackCount);
        expect(perimeterPreview.length).toBeGreaterThan(0);
        for (const layout of plan.layouts) for (const cut of layout.cuts.features) {
            for (const [endpoint, kind] of [[cut.geometry.coordinates[0], cut.properties.fromKind],
                [cut.geometry.coordinates.at(-1), cut.properties.toKind]]) {
                if (kind !== 'perimeter') continue;
                expect(perimeterPreview.some(candidate => distanceMetres(endpoint, candidate.geometry.coordinates) < 0.02)).toBe(true);
            }
        }
    });
});
