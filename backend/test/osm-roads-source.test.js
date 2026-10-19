// The 2D road tools read OSM roads through our backend (frontend/js/osm-roads-source.js): a view is
// split into scene-sized tiles, /osm-road features come back in the Overpass element shape with their
// node ids, and only a server that does not answer lets the caller go to public Overpass.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const source = require('../../frontend/js/osm-roads-source.js');

const line = (props) => ({ type: 'Feature', properties: props, geometry: { type: 'LineString', coordinates: [[16, 45], [16.001, 45]] } });
const ok = (body) => ({ ok: true, status: 200, json: async () => body });

describe('tileBbox', () => {
    it('splits a view into tiles no larger than the scene span and refuses a region', () => {
        const tiles = source.tileBbox([16.0, 45.0, 16.12, 45.04]);
        expect(tiles).toHaveLength(3);
        tiles.forEach(([w, s, e, n]) => { expect(e - w).toBeLessThanOrEqual(source.TILE_SPAN_DEG); expect(n - s).toBeLessThanOrEqual(source.TILE_SPAN_DEG); });
        expect(tiles[0][0]).toBe(16.0);
        expect(tiles[2][2]).toBeCloseTo(16.12, 12);
        expect(source.tileBbox([15, 45, 16, 46])).toBeNull();
    });
});

describe('featuresToElements', () => {
    it('gives each OSM way once, with its tags, node ids and geometry, filtered like the old query', () => {
        const elements = source.featuresToElements([
            line({ osm_id: 1, highway_type: 'primary', tags: { highway: 'primary' }, osm_node_ids: [10, 11] }),
            line({ osm_id: 1, highway_type: 'primary', tags: { highway: 'primary' } }),           // same way from a second tile
            line({ osm_id: 2, highway_type: 'footway', tags: { highway: 'footway' } }),           // unnamed footpath: left out
            line({ osm_id: 3, highway_type: 'footway', name: 'Šetnica', tags: { highway: 'footway' } }),
            line({ osm_id: 4, highway_type: null, railway_type: 'rail', tags: { railway: 'rail' } })
        ]);
        expect(elements.map(e => e.id)).toEqual([1, 3, 4]);
        expect(elements[0]).toMatchObject({ type: 'way', nodes: [10, 11], geometry: [{ lat: 45, lon: 16 }, { lat: 45, lon: 16.001 }] });
        expect(elements[1].tags.name).toBe('Šetnica');
        expect(elements[2].tags.railway).toBe('rail');
    });
});

describe('fetchFromBackend', () => {
    it('asks our /osm-road for every tile with railways, and never anything else', async () => {
        const urls = [];
        const answer = await source.fetchFromBackend([16.0, 45.0, 16.06, 45.02], {
            base: 'https://api.example/', fetchImpl: async (url) => { urls.push(url); return ok({ features: [line({ osm_id: urls.length, highway_type: 'residential', tags: { highway: 'residential' } })] }); }
        });
        expect(urls).toHaveLength(2);
        urls.forEach(url => expect(url).toMatch(/^https:\/\/api\.example\/osm-road\?bbox=[\d.,]+&crs=EPSG:4326&railways=1$/));
        expect(answer).toMatchObject({ partial: false, tooLarge: false });
        expect(answer.elements).toHaveLength(2);
    });

    it('marks the server down only when it does not answer or answers with an HTTP error', async () => {
        await expect(source.fetchFromBackend([16, 45, 16.01, 45.01], { fetchImpl: async () => { throw new TypeError('Failed to fetch'); } }))
            .rejects.toMatchObject({ backendUnavailable: true });
        await expect(source.fetchFromBackend([16, 45, 16.01, 45.01], { fetchImpl: async () => ({ ok: false, status: 502 }) }))
            .rejects.toMatchObject({ backendUnavailable: true });
        // Up, but its Overpass chain had nothing: an answer, not a reason to go to public Overpass.
        const empty = await source.fetchFromBackend([16, 45, 16.01, 45.01], { fetchImpl: async () => ok({ features: [], overpass: 'unavailable' }) });
        expect(empty).toMatchObject({ elements: [], partial: true });
    });

    it('says a region-sized view is too large without asking anything', async () => {
        let asked = 0;
        const answer = await source.fetchFromBackend([15, 45, 16, 46], { fetchImpl: async () => { asked += 1; return ok({ features: [] }); } });
        expect(answer.tooLarge).toBe(true);
        expect(asked).toBe(0);
    });
});
