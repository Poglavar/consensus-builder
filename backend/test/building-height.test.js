// Unit tests for frontend/js/building-height.js — the shared height estimator that three-mode.js
// and photoreal-mode.js both used to implement separately and divergently. These pin the two
// disagreements that were live: a string height "12" and an upper-case LEVELS. The 3D value feeds
// the € gain, so a wrong height is a wrong headline number.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { estimateBuildingHeightMeters, STOREY_HEIGHT_M } = require('../../frontend/js/building-height.js');

describe('estimateBuildingHeightMeters', () => {
    it('reads a string height (the GeoJSON-import case that read 10 in 3D)', () => {
        expect(estimateBuildingHeightMeters({ height: '12' })).toBe(12);
        expect(estimateBuildingHeightMeters({ height: 12 })).toBe(12);
    });

    it('reads upper-case HEIGHT and elevation', () => {
        expect(estimateBuildingHeightMeters({ HEIGHT: '9' })).toBe(9);
        expect(estimateBuildingHeightMeters({ elevation: 15 })).toBe(15);
    });

    it('falls back to levels × storey height, including upper-case LEVELS (the photoreal-blind case)', () => {
        expect(estimateBuildingHeightMeters({ levels: 5 })).toBe(5 * STOREY_HEIGHT_M);
        expect(estimateBuildingHeightMeters({ LEVELS: 5 })).toBe(5 * STOREY_HEIGHT_M);
        expect(estimateBuildingHeightMeters({ storeys: '3' })).toBe(3 * STOREY_HEIGHT_M);
        expect(estimateBuildingHeightMeters({ STORIES: 2 })).toBe(2 * STOREY_HEIGHT_M);
    });

    it('prefers a measured height over levels', () => {
        expect(estimateBuildingHeightMeters({ height: '12', levels: 5 })).toBe(12);
    });

    it('defaults to 10 m for an unknown or degenerate building', () => {
        expect(estimateBuildingHeightMeters({})).toBe(10);
        expect(estimateBuildingHeightMeters({ height: 0 })).toBe(10);
        expect(estimateBuildingHeightMeters({ height: -5 })).toBe(10);
        expect(estimateBuildingHeightMeters({ height: 'not a number' })).toBe(10);
        expect(estimateBuildingHeightMeters(null)).toBe(10);
    });

    it('accepts a whole GeoJSON feature, not just props', () => {
        expect(estimateBuildingHeightMeters({ properties: { height: '20' } })).toBe(20);
        expect(estimateBuildingHeightMeters({ type: 'Feature', properties: { LEVELS: 4 } })).toBe(4 * STOREY_HEIGHT_M);
    });
});
