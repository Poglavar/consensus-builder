import { describe, expect, it } from 'vitest';
import {
    MAX_BUILDING_OVERLAP_M2,
    MIN_DOUBLE_SIDED_PARKING_WIDTH_M,
    assessParkingCandidate,
    parseArgs,
    preclassifyRoadCandidate
} from '../scripts/seed-pionir-observed-circulation.mjs';

const parking = (overrides = {}) => ({
    parkingOsmId: 100,
    parking: 'surface',
    access: 'private',
    capacity: 21,
    siteRatio: 0.98,
    buildingOverlapM2: 0,
    insideAreaM2: 530,
    aisleOsmId: 101,
    aisleLengthM: 35.6,
    aisleGeometry: {
        type: 'LineString',
        coordinates: [[15.9, 45.8], [15.901, 45.8]]
    },
    ...overrides
});

describe('Pionir observed circulation importer', () => {
    it('requires an explicit dry-run or apply mode', () => {
        expect(() => parseArgs([])).toThrow('Choose exactly one');
        expect(parseArgs(['--dry-run', '--export'])).toMatchObject({ dryRun: true, apply: false, export: true });
        expect(parseArgs(['--apply', '--only', 'a,b']).only).toEqual(new Set(['a', 'b']));
    });

    it('accepts a paired aisle only when the parking polygon supports a credible cross-section', () => {
        const result = assessParkingCandidate(parking());
        expect(result.included).toBe(true);
        expect(result.measuredWidthM).toBeCloseTo(530 / 35.6);
        expect(result.measuredWidthM).toBeGreaterThan(MIN_DOUBLE_SIDED_PARKING_WIDTH_M);
        expect(result.drivingWidthM).toBeCloseTo((530 / 35.6) - 10);
    });

    it('rejects parking that overlaps a building or lacks an aisle', () => {
        expect(assessParkingCandidate(parking({ buildingOverlapM2: MAX_BUILDING_OVERLAP_M2 })))
            .toMatchObject({ included: false, reason: 'parking-polygon-overlaps-building' });
        expect(assessParkingCandidate(parking({ aisleOsmId: null, aisleGeometry: null })))
            .toMatchObject({ included: false, reason: 'no-matching-parking-aisle' });
    });

    it('rejects a polygon whose area-to-aisle ratio cannot identify two-sided parking', () => {
        expect(assessParkingCandidate(parking({ insideAreaM2: 150 })))
            .toMatchObject({ included: false, reason: 'parking-cross-section-ambiguous' });
    });

    it('removes rejected road pieces before they can connect separate proposal components', () => {
        const surface = {
            osmId: 1,
            highwayType: 'service',
            name: null,
            insideRatio: 1,
            insideLengthM: 30,
            tags: { highway: 'service' }
        };
        expect(preclassifyRoadCandidate(surface)).toBeNull();
        expect(preclassifyRoadCandidate({ ...surface, tags: { highway: 'service', tunnel: 'yes' } }))
            .toBe('below-grade-or-covered');
        expect(preclassifyRoadCandidate({ ...surface, insideLengthM: 3 }))
            .toBe('fragment-too-short');
        expect(preclassifyRoadCandidate(surface, new Set([1])))
            .toBe('represented-by-parking-court');
    });
});
