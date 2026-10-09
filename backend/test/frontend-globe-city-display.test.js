// Exercise the globe's population ranking and viewport-bounded city display without WebGL/DOM.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const CityDisplay = require('../../frontend/js/world/globe-city-display.js');

function freezeDeep(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    Object.freeze(value);
    Object.values(value).forEach(freezeDeep);
    return value;
}

function candidatesFor(entries, pointFor, { labelWidth = 58, labelHeight = 16 } = {}) {
    return entries.map((entry, index) => {
        const [x, y] = pointFor(entry, index);
        return Object.freeze({ entry, x, y, labelWidth, labelHeight });
    });
}

describe('globe city detail selection', () => {
    it('ranks live cities by population ahead of research points and keeps missing population unknown', () => {
        const coverage = freezeDeep({
            liveCities: [
                { id: 'unknown-live', population2025: null },
                { id: 'small-live', population2025: 150000 },
                { id: 'large-live', population2025: 8_000_000 },
                { id: 'mid-live', population2025: 2_000_000 },
                { id: 'invalid-live', population2025: 0 }
            ],
            cities: [
                { id: 'very-large-research', population2025: 100_000_000 },
                { id: 'unknown-research' },
                { id: 'small-research', population2025: 90000 }
            ]
        });
        const before = JSON.stringify(coverage);
        const ranked = CityDisplay.rankCities(coverage);
        const rankedReversedInput = CityDisplay.rankCities({
            liveCities: [...coverage.liveCities].reverse(),
            cities: [...coverage.cities].reverse()
        });

        expect(ranked.slice(0, 3).map(entry => entry.key)).toEqual([
            'live:large-live', 'live:mid-live', 'live:small-live'
        ]);
        expect(ranked.find(entry => entry.key === 'live:unknown-live').population).toBeNull();
        expect(ranked.find(entry => entry.key === 'live:invalid-live').population).toBeNull();
        expect(ranked.find(entry => entry.key === 'research:very-large-research').population).toBe(100_000_000);
        expect(ranked.slice(-3).every(entry => !entry.live)).toBe(true);
        expect(rankedReversedInput.map(entry => entry.key)).toEqual(ranked.map(entry => entry.key));
        expect(JSON.stringify(coverage)).toBe(before);
    });

    it('reveals small and unknown live labels on zoom while holding source/research points back at world scale', () => {
        const coverage = freezeDeep({
            liveCities: [
                { id: 'major', name: 'Major', population2025: 8_000_000 },
                { id: 'small', name: 'Small', population2025: 500_000 },
                { id: 'unknown', name: 'Unknown' }
            ],
            cities: [{ id: 'research', name: 'Research', population2025: 25_000_000 }]
        });
        const ranked = CityDisplay.rankCities(coverage);
        const candidates = candidatesFor(ranked, entry => ({
            'live:major': [180, 300], 'live:small': [470, 300], 'live:unknown': [760, 300], 'research:research': [1040, 300]
        }[entry.key]));
        const viewport = { width: 1200, height: 800 };
        const world = CityDisplay.layout(candidates, { ...viewport, altitudeKm: 20_000 });
        const close = CityDisplay.layout(candidates, { ...viewport, altitudeKm: 5_000 });
        const worldKeys = new Set(world.markers.map(marker => marker.entry.key));
        const closeLabels = new Set(close.labels.map(label => label.entry.key));

        expect(worldKeys.has('research:research')).toBe(false);
        expect(worldKeys.has('live:major')).toBe(true);
        expect(world.labels.map(label => label.entry.key)).not.toContain('live:small');
        expect(world.labels.map(label => label.entry.key)).not.toContain('live:unknown');
        expect(closeKeys(close).has('research:research')).toBe(true);
        expect(closeLabels.has('live:small')).toBe(true);
        expect(closeLabels.has('live:unknown')).toBe(true);
        expect(coverage.liveCities[2].population2025).toBeUndefined();
    });

    it('keeps marker and label counts bounded as a synthetic catalog grows from 1,000 to 2,000 cities', () => {
        function makeCoverage(count) {
            return {
                liveCities: Array.from({ length: count }, (_, index) => ({
                    id: `city-${String(index).padStart(4, '0')}`,
                    name: `City ${index}`,
                    population2025: 9_000_000 - index
                })),
                cities: []
            };
        }
        const viewport = { width: 1200, height: 900, altitudeKm: 1 };
        const layouts = [1_000, 2_000].map(count => {
            const ranked = CityDisplay.rankCities(makeCoverage(count));
            const candidates = candidatesFor(ranked, (entry, index) => [35 + (index % 15) * 80, 20 + Math.floor(index / 15) * 42]);
            return CityDisplay.layout(candidates, viewport);
        });

        for (const result of layouts) {
            expect(result.markers.length).toBeLessThanOrEqual(CityDisplay.MAX_MARKERS);
            expect(result.labels.length).toBeLessThanOrEqual(CityDisplay.MAX_LABELS);
        }
        expect(layouts[1].markers.length).toBe(layouts[0].markers.length);
        expect(layouts[1].labels.length).toBe(layouts[0].labels.length);
    });

    it('declutters dense projected clusters and keeps visible marker spacing', () => {
        const coverage = {
            liveCities: Array.from({ length: 400 }, (_, index) => ({ id: `cluster-${index}`, population2025: 4_000_000 - index })),
            cities: []
        };
        const ranked = CityDisplay.rankCities(coverage);
        const candidates = candidatesFor(ranked, (_, index) => [600 + (index % 20) * 0.2, 450 + Math.floor(index / 20) * 0.2]);
        const result = CityDisplay.layout(candidates, { width: 1200, height: 900, altitudeKm: 1 });

        expect(result.markers.length).toBeLessThan(10);
        for (let i = 0; i < result.markers.length; i++) for (let j = i + 1; j < result.markers.length; j++) {
            const a = result.markers[i]; const b = result.markers[j];
            expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(result.detail.markerSpacing);
        }
    });

    it('keeps labels in the viewport and clear of blocked regions and neighboring labels', () => {
        const coverage = {
            liveCities: Array.from({ length: 16 }, (_, index) => ({ id: `city-${index}`, population2025: 5_000_000 - index })),
            cities: []
        };
        const ranked = CityDisplay.rankCities(coverage);
        const points = [[12, 130], [140, 130], [270, 130], [410, 130], [550, 130], [690, 130], [830, 130], [970, 130], [1188, 130],
            [12, 320], [140, 320], [270, 320], [410, 320], [550, 320], [830, 320], [1188, 320]];
        const candidates = candidatesFor(ranked, (_, index) => points[index], { labelWidth: 78, labelHeight: 18 });
        const viewport = { width: 1200, height: 500, altitudeKm: 1 };
        const blocked = [{ x: 300, y: 90, w: 90, h: 100 }];
        const result = CityDisplay.layout(candidates, viewport, { blocked });

        expect(result.labels.length).toBeGreaterThan(2);
        for (const label of result.labels) {
            expect(label.x).toBeGreaterThanOrEqual(10);
            expect(label.y).toBeGreaterThanOrEqual(10);
            expect(label.x + label.w).toBeLessThanOrEqual(viewport.width - 10);
            expect(label.y + label.h).toBeLessThanOrEqual(viewport.height - 10);
            expect(CityDisplay.canPlace(label, viewport, blocked, 0)).toBe(true);
        }
        for (let i = 0; i < result.labels.length; i++) for (let j = i + 1; j < result.labels.length; j++) {
            expect(CityDisplay.canPlace(result.labels[i], viewport, [result.labels[j]], result.detail.labelGap)).toBe(true);
        }
    });

    it('prioritizes a pinned city while preserving marker and label budgets', () => {
        const coverage = {
            liveCities: Array.from({ length: 300 }, (_, index) => ({
                id: `city-${String(index).padStart(3, '0')}`,
                population2025: index === 299 ? null : 8_000_000 - index
            })),
            cities: []
        };
        const ranked = CityDisplay.rankCities(coverage);
        const candidates = candidatesFor(ranked, (_, index) => [35 + (index % 15) * 80, 20 + Math.floor(index / 15) * 42]);
        const pinnedKey = ranked.find(entry => entry.city.id === 'city-299').key;
        const result = CityDisplay.layout(candidates, { width: 1200, height: 900, altitudeKm: 1 }, { pinnedKeys: [pinnedKey] });
        const marker = result.markers.find(item => item.entry.key === pinnedKey);

        expect(marker).toBeDefined();
        expect(marker.glow).toBe(true);
        expect(result.labels.some(label => label.entry.key === pinnedKey)).toBe(true);
        expect(result.markers.length).toBeLessThanOrEqual(CityDisplay.MAX_MARKERS);
        expect(result.labels.length).toBeLessThanOrEqual(CityDisplay.MAX_LABELS);
    });

    it('does not mutate coverage, ranked entries, or projected candidates', () => {
        const coverage = freezeDeep({
            liveCities: [{ id: 'frozen-live', population2025: 700_000 }],
            cities: [{ id: 'frozen-research', population2025: 100_000 }]
        });
        const ranked = Object.freeze(CityDisplay.rankCities(coverage).map(entry => Object.freeze(entry)));
        const candidates = Object.freeze(candidatesFor(ranked, (_, index) => [300 + index * 180, 250]).map(Object.freeze));
        const before = JSON.stringify({ coverage, ranked, candidates });
        CityDisplay.layout(candidates, { width: 1000, height: 700, altitudeKm: 5_000 });

        expect(JSON.stringify({ coverage, ranked, candidates })).toBe(before);
        expect(ranked.find(entry => entry.key === 'live:frozen-live').population).toBe(700_000);
    });
});

function closeKeys(result) {
    return new Set(result.markers.map(marker => marker.entry.key));
}
