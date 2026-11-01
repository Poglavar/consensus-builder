import { afterEach, describe, expect, it, vi } from 'vitest';
import { searchOsmPlaces, __osmPlacesInternals } from '../places/osm-places.js';
import { setupPlacesRoute } from '../routes/places.js';

const bbox = [0.01, 0.01, 0.02, 0.02];
const makeSearch = (response, calls = []) => searchOsmPlaces({ bbox, query: 'park', limit: 20, overpassUrl: 'https://unit.test/interpreter',
    fetchImpl: async (url, options) => { calls.push({ url, options }); return { ok: true, headers: { get: () => null }, json: async () => response }; } });

describe('OSM place lookup', () => {
    it('searches names with literal regex escaping and returns center points without geometry', async () => {
        const calls = [];
        const result = await makeSearch({ elements: [
            { type: 'node', id: 7, lat: 0.015, lon: 0.016, tags: { name: 'Park [East].', place: 'neighbourhood' } },
            { type: 'way', id: 8, center: { lat: 0.014, lon: 0.013 }, tags: { name: 'Park House', amenity: 'cafe' } },
            { type: 'way', id: 9, center: { lat: 0.4, lon: 0.4 }, tags: { name: 'Outside' } }
        ] }, calls);
        const ql = new URLSearchParams(calls[0].options.body).get('data');
        expect(ql).toContain('["name"~"park",i]');
        expect(result).toEqual({ source: 'osm-overpass', partial: false, truncated: false, candidates: [
            { kind: 'neighbourhood', title: 'Park [East].', point: [0.016, 0.015], category: 'neighbourhood', osmId: 'node/7' },
            { kind: 'place', title: 'Park House', point: [0.013, 0.014], osmId: 'way/8' }
        ] });
        expect(result.candidates[0]).not.toHaveProperty('geometry');
    });

    it('keeps same-name bridge and station features ahead of entrance nodes before applying the result limit', async () => {
        const result = await searchOsmPlaces({ bbox, query: 'London Bridge', limit: 2, overpassUrl: 'https://unit.test/bridge-station-ranking',
            fetchImpl: async () => ({ ok: true, headers: { get: () => null }, json: async () => ({ elements: [
                { type: 'node', id: 2, lat: 0.015, lon: 0.016, tags: { name: 'London Bridge', railway: 'subway_entrance' } },
                { type: 'node', id: 3, lat: 0.016, lon: 0.017, tags: { name: 'London Bridge', railway: 'station' } },
                { type: 'way', id: 4, center: { lat: 0.014, lon: 0.018 }, tags: { name: 'London Bridge', bridge: 'yes' } },
                { type: 'way', id: 5, center: { lat: 0.017, lon: 0.019 }, tags: { name: 'London Bridge', public_transport: 'platform' } },
                { type: 'way', id: 6, center: { lat: 0.017, lon: 0.019 }, tags: { name: 'London Bridge East', bridge: 'yes' } }
            ] }) }) });
        expect(result.candidates).toEqual([
            { kind: 'place', title: 'London Bridge', point: [0.018, 0.014], category: 'bridge', osmId: 'way/4' },
            { kind: 'place', title: 'London Bridge', point: [0.017, 0.016], category: 'station', osmId: 'node/3' }
        ]);
        expect(result.truncated).toBe(true);
    });

    it('uses parsed house numbers and street constraints for address queries', async () => {
        const calls = [];
        const result = await searchOsmPlaces({ bbox, query: '12B Main Street', limit: 10, overpassUrl: 'https://unit.test/address',
            fetchImpl: async (_url, options) => { calls.push(options); return { ok: true, headers: { get: () => null }, json: async () => ({ elements: [
                { type: 'way', id: 30, center: { lat: 0.015, lon: 0.016 }, tags: { 'addr:housenumber': '12B', 'addr:street': 'Main Street' } }
            ] }) }; } });
        const ql = new URLSearchParams(calls[0].body).get('data');
        expect(ql).toContain('["addr:housenumber"="12B"]["addr:street"~"^Main Street$",i]');
        expect(result.candidates).toEqual([{ kind: 'address', title: '12B Main Street', point: [0.016, 0.015], osmId: 'way/30' }]);
    });

    it('finds street intersections from shared OSM nodes and never treats geometric crossings as enough', async () => {
        let query = '';
        const result = await searchOsmPlaces({ bbox, intersection: ['First Street', 'Second Street'], overpassUrl: 'https://unit.test/intersection',
            fetchImpl: async (_url, options) => { query = new URLSearchParams(options.body).get('data'); return { ok: true, headers: { get: () => null }, json: async () => ({ elements: [
                { type: 'node', id: 91, lat: 0.015, lon: 0.016, tags: {} }
            ] }) }; } });
        expect(query).toContain('node(w.a)->.na;node(w.b)->.nb;node.na.nb;');
        expect(result.candidates).toEqual([{ kind: 'intersection', title: 'First Street & Second Street', point: [0.016, 0.015], osmId: 'node/91' }]);
    });

    it('reports provider truncation and rejects missing or remark-marked results as incomplete', async () => {
        const items = Array.from({ length: 201 }, (_, id) => ({ type: 'node', id: 1000 + id, lat: 0.015, lon: 0.016, tags: { name: `Park ${id}` } }));
        const capped = await searchOsmPlaces({ bbox, query: 'park cap', limit: 20, overpassUrl: 'https://unit.test/capped',
            fetchImpl: async () => ({ ok: true, headers: { get: () => null }, json: async () => ({ elements: items }) }) });
        expect(capped.candidates).toHaveLength(20);
        expect(capped.truncated).toBe(true);
        for (const response of [{}, { elements: [], remark: 'runtime error with private detail' }]) {
            await expect(searchOsmPlaces({ bbox, query: `incomplete ${Object.keys(response).join('-')}`, overpassUrl: `https://unit.test/${Object.keys(response).join('-') || 'missing'}`,
                fetchImpl: async () => ({ ok: true, headers: { get: () => null }, json: async () => response }) })).rejects.toMatchObject({ status: 502 });
        }
    });

    it('validates route bounds and query shapes without opening a socket', async () => {
        const handlers = new Map();
        setupPlacesRoute({ get: (path, fn) => handlers.set(path, fn) }, {
            search: vi.fn(async value => ({ candidates: [], partial: false, truncated: false, source: 'osm-overpass', echoed: value })),
            landmarkGeometry: vi.fn()
        });
        const invoke = query => {
            const res = { status: vi.fn(function (code) { this.code = code; return this; }), json: vi.fn(function (body) { this.body = body; return this; }) };
            return Promise.resolve(handlers.get('/places')({ query }, res)).then(() => res);
        };
        const bad = await invoke({ bbox: '0,0,1,1', q: 'park' });
        expect(bad.code).toBe(400);
        const good = await invoke({ bbox: '0.01,0.01,0.02,0.02', streetA: 'First Street', streetB: 'Second Street', limit: '20' });
        expect(good.body.echoed).toMatchObject({ bbox, intersection: ['First Street', 'Second Street'], limit: 20 });
    });

    it('normalizes address-like queries and escapes regex metacharacters', () => {
        expect(__osmPlacesInternals.normalizedRequest({ query: '22A King St' })).toMatchObject({ query: '', address: { houseNumber: '22A', street: 'King St' } });
        expect(__osmPlacesInternals.literalRegex('Park (West).')).toBe('Park \\(West\\)\\.');
    });
});
