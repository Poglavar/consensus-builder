import { describe, expect, it } from 'vitest';
import { normalizeImageryObservations } from '../lane-topology/imagery-observations.js';

const imagery = {
    source: { key: 'zagreb_cdof_2022', capturedAt: '2022' },
    bbox: [15.961, 45.797, 15.963, 45.799],
    width: 1000,
    height: 1000,
    effectiveGsdM: 0.15
};

describe('lane topology imagery observations', () => {
    it('georeferences normalized north-up image points and measures lane widths', () => {
        const features = normalizeImageryObservations([{
            kind: 'lane_width',
            points: [[0.25, 0.5], [0.275, 0.5]],
            confidence: 0.84,
            sourceWayIds: [157387766],
            reason: 'Visible paint-to-paint cross-section.'
        }], imagery, 'codex');

        expect(features).toHaveLength(1);
        expect(features[0].geometry).toEqual({
            type: 'LineString',
            coordinates: [
                [15.9615, 45.798],
                [15.96155, 45.798]
            ]
        });
        expect(features[0].properties).toEqual(expect.objectContaining({
            kind: 'lane_width',
            source: 'codex',
            imagerySource: 'zagreb_cdof_2022',
            capturedAt: '2022',
            confidence: 0.84,
            sourceWayIds: ['157387766']
        }));
        expect(features[0].properties.measuredWidthM).toBeGreaterThan(3.8);
        expect(features[0].properties.measuredWidthM).toBeLessThan(4);
    });

    it('uses a point geometry for taper starts and rejects unsafe coordinates', () => {
        const features = normalizeImageryObservations([
            { kind: 'taper_start', points: [[0.4, 0.2]], confidence: 2 },
            { kind: 'road_edge', points: [[-0.1, 0.2], [0.2, 0.2]] },
            { kind: 'unknown', points: [[0.1, 0.1]] }
        ], imagery, 'claude');

        expect(features).toHaveLength(1);
        expect(features[0].geometry.type).toBe('Point');
        expect(features[0].geometry.coordinates).toEqual([15.9618, 45.7986]);
        expect(features[0].properties.confidence).toBe(1);
    });
});
