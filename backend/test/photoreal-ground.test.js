// Unit tests for extracting a smooth bare-ground grid from Google photogrammetry surface hits.

import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    selectTopSurfaceHeight,
    selectRoadSurfaceHeight,
    roadFloorEncodingRange,
    encodeRoadFloor,
    decodeRoadFloor,
    quantizationSafeRoadCutOffset,
    filterRoadFloorPatches,
    pairRoadReplacementPatches,
    createTerrainRefreshTracker,
    noteTerrainSourceChange,
    claimTerrainRefresh,
    cleanGroundGrid,
    sampleBilinear,
    coversBounds
} = require('../../frontend/js/photoreal-ground.js');

function slopedGrid(nx, ny) {
    return Float32Array.from({ length: nx * ny }, (_, index) => {
        const x = index % nx;
        const y = Math.floor(index / nx);
        return -2 + x * 0.35 + y * 0.15;
    });
}

describe('photoreal ground extraction', () => {
    it('keeps the top ray hit instead of the rejected lowest mesh hit', () => {
        expect(selectTopSurfaceHeight([18, 17.7, 0.2, -14], 1500)).toBe(18);
        expect(selectTopSurfaceHeight([2400, 3.5, -20], 1500)).toBe(3.5);
        expect(selectTopSurfaceHeight([2400, -1800], 1500)).toBeNull();
    });

    it('preserves an uncontaminated sloped terrain plane', () => {
        const nx = 9, ny = 9;
        const terrain = slopedGrid(nx, ny);
        expect(Array.from(cleanGroundGrid(terrain, nx, ny))).toEqual(Array.from(terrain));

        const tinyPlane = Float32Array.from([0, 0.5, 0.25, 0.75]);
        expect(Array.from(cleanGroundGrid(tinyPlane, 2, 2))).toEqual(Array.from(tinyPlane));
    });

    it('removes roof and canopy elevations while retaining the underlying slope', () => {
        const nx = 9, ny = 9;
        const terrain = slopedGrid(nx, ny);
        const surface = new Float32Array(terrain);
        for (let y = 3; y <= 5; y++) {
            for (let x = 3; x <= 5; x++) surface[y * nx + x] += 12;
        }
        surface[2 * nx + 7] += 8;

        const cleaned = cleanGroundGrid(surface, nx, ny);
        const roofCenter = 4 * nx + 4;
        expect(surface[roofCenter] - terrain[roofCenter]).toBeGreaterThan(10);
        expect(cleaned[roofCenter]).toBeCloseTo(terrain[roofCenter], 0);
        expect(Math.abs(cleaned[2 * nx + 7] - terrain[2 * nx + 7])).toBeLessThan(0.5);
    });

    it('fills a compact NoData hole but leaves an entirely missing region missing', () => {
        const nx = 7, ny = 7;
        const terrain = slopedGrid(nx, ny);
        terrain[3 * nx + 3] = NaN;
        const cleaned = cleanGroundGrid(terrain, nx, ny);
        expect(cleaned[3 * nx + 3]).toBeCloseTo(-0.5, 5);

        const missing = new Float32Array(nx * ny);
        missing.fill(NaN);
        expect(Array.from(cleanGroundGrid(missing, nx, ny)).every(Number.isNaN)).toBe(true);
    });
});

describe('visible Google road-surface sampling', () => {
    it('keeps the visible centre surface when adjacent roofs are higher', () => {
        expect(selectRoadSurfaceHeight(0.2, 12, 11.5, {
            halfWidth: 6, probeDistance: 10
        })).toBeCloseTo(0.2, 9);
    });

    it('replaces a high centre obstacle when both road edges agree on lower ground', () => {
        expect(selectRoadSurfaceHeight(14, 1.2, 1.6)).toBeCloseTo(1.4, 9);
    });

    it('does not invent ground from disagreeing sides or turn NoData into zero', () => {
        expect(selectRoadSurfaceHeight(10, 0, 4)).toBe(10);
        expect(selectRoadSurfaceHeight(null, 1, 2)).toBeCloseTo(1.5, 9);
        expect(selectRoadSurfaceHeight(null, 0, 10)).toBeNull();
        expect(selectRoadSurfaceHeight(null, null, 2)).toBe(2);
        expect(selectRoadSurfaceHeight(null, null, null)).toBeNull();
    });

    it('raises a level road to the high semantic edge of a consistent cross-slope', () => {
        expect(selectRoadSurfaceHeight(10, 11, 9, {
            halfWidth: 6,
            probeDistance: 10
        })).toBeCloseTo(10.6, 9);
    });

    it('does not mistake a unilateral side obstacle for terrain cross-slope', () => {
        expect(selectRoadSurfaceHeight(10, 18, 9.8, {
            halfWidth: 6,
            probeDistance: 10
        })).toBe(10);
        expect(selectRoadSurfaceHeight(10, 14, 6, {
            halfWidth: 6,
            probeDistance: 10,
            maximumCrossSlope: 0.18
        })).toBe(10);
    });

    it('uses plausible semantic-edge detail but ignores edge cars and facades', () => {
        expect(selectRoadSurfaceHeight(10, 10, 10, {
            halfWidth: 6,
            probeDistance: 10,
            edgeLeft: 10.32,
            edgeRight: 9.95
        })).toBeCloseTo(10.32, 9);
        expect(selectRoadSurfaceHeight(10, 10, 10, {
            halfWidth: 6,
            probeDistance: 10,
            edgeLeft: 11.2,
            edgeRight: 9.95
        })).toBe(10);
    });
});

describe('height-aware road cut encoding', () => {
    it('keeps cut patches in lockstep with proposal and parcel isolation', () => {
        const patches = [
            { proposalId: 'road-a', positions: [1] },
            { proposalId: 'road-b', positions: [2] }
        ];

        expect(filterRoadFloorPatches(patches, null)).toEqual(patches);
        expect(filterRoadFloorPatches(patches, 'road-b')).toEqual([patches[1]]);
        expect(filterRoadFloorPatches(patches, '__parcel__')).toEqual([]);
        expect(filterRoadFloorPatches(null, 'road-a')).toEqual([]);
    });

    it('publishes only masks that have a matching opaque road envelope', () => {
        const maskA = {
            proposalId: 'road-a', segmentId: 'main', _replacementKey: 'road-a|run-1', positions: [1]
        };
        const maskB = { proposalId: 'road-b', segmentId: 'branch', positions: [2] };
        const sameSegmentWrongRun = {
            proposalId: 'road-a', segmentId: 'main', _replacementKey: 'road-a|run-2', positions: [2.5]
        };
        const envelopeA = {
            proposalId: 'road-a', segmentId: 'main', _replacementKey: 'road-a|run-1', positions: [3]
        };
        const envelopeOnly = { proposalId: 'road-c', segmentId: 'main', positions: [4] };

        expect(pairRoadReplacementPatches(
            [maskA, sameSegmentWrongRun, maskB], [envelopeA, envelopeOnly]
        )).toEqual({ masks: [maskA], envelopes: [envelopeA] });
        expect(pairRoadReplacementPatches([maskA], [])).toEqual({ masks: [], envelopes: [] });
        expect(pairRoadReplacementPatches(
            [maskA, { ...maskA, positions: [9] }], [envelopeA]
        )).toEqual({ masks: [], envelopes: [] });
        expect(pairRoadReplacementPatches(
            [{ proposalId: 'legacy', segmentId: 'main' }],
            [{ proposalId: 'legacy', segmentId: 'main' }]
        )).toEqual({ masks: [], envelopes: [] });
    });

    it('keeps zero and the complete road span inside an adaptively padded range', () => {
        const encoding = roadFloorEncodingRange([-2.2, -1.1, 3.4]);

        expect(encoding.min).toBeLessThanOrEqual(-6.2);
        expect(encoding.max).toBeCloseTo(7.4, 12);
        expect(encoding.min).toBeLessThanOrEqual(0);
        expect(encoding.max).toBeGreaterThanOrEqual(0);
        expect(encoding.quantizationM).toBeCloseTo(encoding.range / 255, 12);
    });

    it('round-trips an RGBA8 floor within half a quantisation step', () => {
        const encoding = roadFloorEncodingRange([-1.8, 2.6]);
        const source = 0.73;
        const byte = Math.round(encodeRoadFloor(source, encoding) * 255);
        const decoded = decodeRoadFloor(byte / 255, encoding);

        expect(Math.abs(decoded - source)).toBeLessThanOrEqual(encoding.quantizationM / 2 + 1e-9);
    });

    it('keeps the worst upward floor quantisation below the opaque foundation', () => {
        [8, 12.354230880737305, 40].forEach(range => {
            const encoding = { min: -4, range, quantizationM: range / 255 };
            const offset = quantizationSafeRoadCutOffset(encoding, {
                targetOffsetM: 0.02,
                coverTopOffsetM: 0.04,
                safetyMarginM: 0.01
            });

            expect(offset).not.toBeNull();
            expect(offset + encoding.quantizationM / 2).toBeLessThanOrEqual(0.03 + 1e-12);
            expect(offset).toBeLessThanOrEqual(0.02);
        });
        expect(quantizationSafeRoadCutOffset(null)).toBeNull();
    });

    it('supports different local cut floors along one road', () => {
        const encoding = roadFloorEncodingRange([0, 3]);
        const floor0 = decodeRoadFloor(encodeRoadFloor(0, encoding), encoding) - 0.4;
        const floor3 = decodeRoadFloor(encodeRoadFloor(3, encoding), encoding) - 0.4;

        expect(-0.5 > floor0).toBe(false);
        expect(0 > floor0).toBe(true);
        expect(2.5 > floor3).toBe(false);
        expect(3 > floor3).toBe(true);
    });
});

describe('bounded terrain LOD refresh tracking', () => {
    it('accepts a later source revision after an earlier quiet-period refit', () => {
        const tracker = createTerrainRefreshTracker(3);

        noteTerrainSourceChange(tracker, 'ground-lock');
        expect(claimTerrainRefresh(tracker)).toEqual({
            revision: 1,
            refresh: 1,
            maxRefreshes: 3,
            reason: 'ground-lock'
        });
        expect(claimTerrainRefresh(tracker)).toBeNull();

        noteTerrainSourceChange(tracker, 'finer-visible-lod');
        expect(claimTerrainRefresh(tracker)).toMatchObject({
            revision: 2,
            refresh: 2,
            reason: 'finer-visible-lod'
        });
    });

    it('coalesces source churn and never exceeds the refit budget', () => {
        const tracker = createTerrainRefreshTracker(2);

        noteTerrainSourceChange(tracker, 'load-1');
        noteTerrainSourceChange(tracker, 'load-2');
        expect(claimTerrainRefresh(tracker)).toMatchObject({ revision: 2, refresh: 1 });
        noteTerrainSourceChange(tracker, 'load-3');
        expect(claimTerrainRefresh(tracker)).toMatchObject({ revision: 3, refresh: 2 });
        noteTerrainSourceChange(tracker, 'load-4');
        expect(claimTerrainRefresh(tracker)).toBeNull();
        expect(tracker.refreshes).toBe(2);
        expect(tracker.appliedRevision).toBe(3);
    });
});

describe('photoreal ground-grid sampling', () => {
    it('renormalises bilinear weights around NoData instead of equally averaging valid corners', () => {
        const grid = {
            minX: 0,
            minY: 0,
            dx: 1,
            dy: 1,
            nx: 2,
            ny: 2,
            z: Float32Array.from([0, 10, 20, NaN])
        };
        expect(sampleBilinear(grid, 0.75, 0.25)).toBeCloseTo(8.461538, 6);
        expect(sampleBilinear(grid, -0.01, 0.25)).toBeNull();
    });

    it('detects when an edited proposal outgrows the cached terrain extent', () => {
        const grid = { minX: -10, minY: -20, dx: 5, dy: 10, nx: 5, ny: 5, z: new Float32Array(25) };
        expect(coversBounds(grid, { minX: -10, minY: -20, maxX: 10, maxY: 20 })).toBe(true);
        expect(coversBounds(grid, { minX: -10, minY: -20, maxX: 10.1, maxY: 20 })).toBe(false);
    });
});
