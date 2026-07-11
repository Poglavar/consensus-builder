// Unit tests for reopening an immutable corridor proposal as an editable road drawing.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    ACTIVE_DRAFT_KEY,
    buildCorridorDrawingSeed,
    resolveCorridorScreenshotGeometry,
    saveActiveCorridorDraft,
    getActiveCorridorDraft,
    clearActiveCorridorDraft
} = require('../../frontend/js/corridor-draft.js');

function memoryStorage() {
    const values = new Map();
    return {
        getItem: key => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value),
        removeItem: key => values.delete(key)
    };
}

describe('corridor drawing drafts', () => {
    const definition = {
        points: [{ lat: 40.7, lng: -74 }, { lat: 40.71, lng: -73.99 }],
        segmentIds: ['s1'],
        width: 10,
        sidewalkWidth: 1,
        tunnels: [{ id: 'building-tunnel:a', kind: 'building', edgeKey: 'a', buildingIds: ['b1'] }],
        profile: { strips: [{ type: 'sidewalk', width: 1 }, { type: 'driving', width: 9 }] }
    };

    it('uses an edited cross-section when reopening a placed road', () => {
        const edited = { strips: [{ type: 'cycleway', width: 2 }, { type: 'driving', width: 8 }] };
        const seed = buildCorridorDrawingSeed(definition, edited);

        expect(seed.profile).toEqual(edited);
        expect(seed.centerline).toEqual(definition.points);
        expect(seed.segmentIds).toEqual(['s1']);
        expect(seed.width).toBe(10);
        expect(seed.tunnels).toEqual(definition.tunnels);
    });

    it('clones proposal geometry and profile instead of mutating immutable source data', () => {
        const seed = buildCorridorDrawingSeed(definition);
        seed.centerline[0].lat = 0;
        seed.profile.strips[0].type = 'parking';
        seed.segmentIds.push('s2');
        seed.tunnels[0].buildingIds.push('b2');

        expect(definition.points[0].lat).toBe(40.7);
        expect(definition.profile.strips[0].type).toBe('sidewalk');
        expect(definition.segmentIds).toEqual(['s1']);
        expect(definition.tunnels[0].buildingIds).toEqual(['b1']);
    });

    it('rejects definitions without a centerline', () => {
        expect(buildCorridorDrawingSeed({ width: 10 }, null)).toBeNull();
    });

    it('autosaves, restores and clears one active dirty drawing', () => {
        const storage = memoryStorage();
        const saved = saveActiveCorridorDraft({ kind: 'road', cityId: 'nyc', seed: { width: 10 } }, storage);

        expect(saved.dirty).toBe(true);
        expect(storage.getItem(ACTIVE_DRAFT_KEY)).toContain('"cityId":"nyc"');
        expect(getActiveCorridorDraft(storage)).toMatchObject({ kind: 'road', cityId: 'nyc', seed: { width: 10 } });

        clearActiveCorridorDraft(storage);
        expect(getActiveCorridorDraft(storage)).toBeNull();
    });

    it('ignores malformed or clean stored records', () => {
        const storage = memoryStorage();
        storage.setItem(ACTIVE_DRAFT_KEY, '{broken');
        expect(getActiveCorridorDraft(storage)).toBeNull();
        storage.setItem(ACTIVE_DRAFT_KEY, JSON.stringify({ kind: 'road', seed: {}, dirty: false }));
        expect(getActiveCorridorDraft(storage)).toBeNull();
    });

    it('frames road screenshots from the corridor instead of its larger parent parcels', () => {
        const corridor = { type: 'Polygon', coordinates: [[[-74, 40.7], [-73.99, 40.7], [-74, 40.7]]] };
        const fallback = [[40.6, -74.1], [40.8, -73.8], [40.6, -74.1]];
        const result = resolveCorridorScreenshotGeometry({ roadProposal: { definition: { polygon: corridor } } }, fallback);

        expect(result).toEqual({ polygon: corridor.coordinates, polygonOrder: 'lnglat', fitToPolygonOnly: true });
    });

    it('keeps the generic parcel screenshot path for non-corridor proposals', () => {
        const fallback = [[40.6, -74.1], [40.8, -73.8], [40.6, -74.1]];
        expect(resolveCorridorScreenshotGeometry({}, fallback))
            .toEqual({ polygon: fallback, polygonOrder: 'auto', fitToPolygonOnly: false });
    });
});
