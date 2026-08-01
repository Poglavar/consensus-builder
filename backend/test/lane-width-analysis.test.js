// Locks the conservative road-strip lane-width detector against synthetic paint and blank asphalt.
import { createCanvas } from 'canvas';
import { describe, expect, it } from 'vitest';
import {
    LANE_WIDTH_ALGORITHM_VERSION,
    detectLaneWidthCandidates,
    findPaintPeaks
} from '../lane-topology/lane-width-analysis.js';

const CENTER = [15.9618, 45.7988];
const METRES_PER_DEGREE_LAT = 6_371_008.8 * Math.PI / 180;
const METRES_PER_DEGREE_LON = METRES_PER_DEGREE_LAT * Math.cos(CENTER[1] * Math.PI / 180);
const BBOX = [
    CENTER[0] - 30 / METRES_PER_DEGREE_LON,
    CENTER[1] - 50 / METRES_PER_DEGREE_LAT,
    CENTER[0] + 30 / METRES_PER_DEGREE_LON,
    CENTER[1] + 50 / METRES_PER_DEGREE_LAT
];

function evidence() {
    return {
        type: 'FeatureCollection',
        snapshotAt: '2026-07-22T20:42:11.000Z',
        features: [{
            type: 'Feature',
            geometry: {
                type: 'LineString',
                coordinates: [
                    [CENTER[0], BBOX[1] + 5 / METRES_PER_DEGREE_LAT],
                    [CENTER[0], BBOX[3] - 5 / METRES_PER_DEGREE_LAT]
                ]
            },
            properties: {
                osm_id: 'savska-synthetic',
                highway_type: 'secondary',
                tags: { highway: 'secondary', lanes: '3' }
            }
        }]
    };
}

function syntheticImage(withPaint = true) {
    const canvas = createCanvas(400, 667);
    const context = canvas.getContext('2d');
    context.fillStyle = '#4b5052';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#555b5d';
    for (let y = 0; y < canvas.height; y += 18) {
        context.fillRect(0, y, canvas.width, 4);
    }
    if (withPaint) {
        context.strokeStyle = '#f5f5eb';
        context.lineWidth = 2;
        [-4.5, -1.5, 1.5, 4.5].forEach(offsetM => {
            const x = canvas.width / 2 + offsetM / 0.15;
            context.beginPath();
            context.moveTo(x, 0);
            context.lineTo(x, canvas.height);
            context.stroke();
        });
    }
    return context.getImageData(0, 0, canvas.width, canvas.height);
}

function imagery() {
    return {
        bbox: BBOX,
        width: 400,
        height: 667,
        effectiveGsdM: 0.15,
        source: {
            key: 'synthetic_cdof',
            capturedAt: '2022'
        }
    };
}

describe('road-aligned lane-width analysis', () => {
    it('keeps separated recurring cross-road paint peaks', () => {
        const profile = Array.from({ length: 62 }, (_, index) => ({
            offsetM: Number((-3.1 + index * 0.1).toFixed(1)),
            score: 0.1,
            recurrence: 1
        }));
        profile.find(entry => entry.offsetM === -3).score = 0.9;
        profile.find(entry => entry.offsetM === 0).score = 0.88;
        const peaks = findPaintPeaks(profile);
        expect(peaks.map(peak => peak.offsetM)).toEqual([-3, 0]);
    });

    it('recovers inspectable three-metre paint-to-paint widths', () => {
        const result = detectLaneWidthCandidates(
            syntheticImage(true),
            imagery(),
            evidence(),
            { alongStepM: 12 }
        );
        const widths = result.measurements.features.map(
            feature => feature.properties.measuredWidthM
        );

        expect(result.algorithm.version).toBe(LANE_WIDTH_ALGORITHM_VERSION);
        expect(result.stats.waysMeasured).toBe(1);
        expect(result.stats.widthCandidates).toBeGreaterThan(3);
        expect(widths.every(width => Math.abs(width - 3) < 0.25)).toBe(true);
        expect(result.boundaries.features.length).toBeGreaterThan(widths.length);
        expect(result.measurements.features[0].properties).toEqual(expect.objectContaining({
            basis: 'paint-to-paint',
            sourceWayId: 'savska-synthetic',
            osmLaneCount: 3
        }));
        expect(result.stats.externalAiCostUsd).toBe(0);
    });

    it('does not invent widths on uniformly textured asphalt', () => {
        const result = detectLaneWidthCandidates(
            syntheticImage(false),
            imagery(),
            evidence()
        );
        expect(result.measurements.features).toHaveLength(0);
        expect(result.stats.waysMeasured).toBe(0);
    });
});
