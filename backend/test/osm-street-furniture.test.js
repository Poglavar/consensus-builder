// Street furniture from OSM (decor/osm-street-furniture.js, GET /decor/furniture): fountains as a
// point or a basin outline and street lamps, read live for the 3D model view.
import { describe, expect, it, vi } from 'vitest';
import {
    buildFurnitureQuery, ringCircle, overpassFurnitureToFeatures, createStreetFurnitureProvider,
    DEFAULT_FOUNTAIN_RADIUS_M, FURNITURE_MAX_SPAN_DEG
} from '../decor/osm-street-furniture.js';
import { setupDecorRoute } from '../routes/decor.js';

// A square ring of side `m` metres around (lon, lat).
function squareRing(lon, lat, m) {
    const dLat = m / 2 / 110570, dLon = m / 2 / (111320 * Math.cos(lat * Math.PI / 180));
    return [[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]].map(([x, y]) => ({ lon: lon + x * dLon, lat: lat + y * dLat }));
}

describe('OSM street furniture', () => {
    it('asks one query for fountain points and outlines and street lamps, in Overpass box order', () => {
        const query = buildFurnitureQuery([4.3, 52.07, 4.32, 52.08]);
        expect(query).toContain('node["amenity"="fountain"](52.07,4.3,52.08,4.32);');
        expect(query).toContain('way["amenity"="fountain"](52.07,4.3,52.08,4.32);');
        expect(query).toContain('node["highway"="street_lamp"](52.07,4.3,52.08,4.32);');
        expect(query).toContain('out geom;');
    });

    it('gives a basin outline its centre and the radius of a circle of its area', () => {
        const circle = ringCircle(squareRing(15.97, 45.81, 10));
        expect(circle.lng).toBeCloseTo(15.97, 6);
        expect(circle.lat).toBeCloseTo(45.81, 6);
        expect(circle.radiusM).toBeCloseTo(Math.sqrt(100 / Math.PI), 1);
        expect(ringCircle([{ lon: 1, lat: 1 }])).toBeNull();
    });

    it('turns fountains and lamps into points and leaves everything else out', () => {
        const { features, truncated } = overpassFurnitureToFeatures([
            { type: 'node', id: 1, lon: 4.3, lat: 52.07, tags: { amenity: 'fountain' } },
            { type: 'node', id: 2, lon: 4.31, lat: 52.07, tags: { highway: 'street_lamp' } },
            { type: 'way', id: 3, geometry: squareRing(4.305, 52.075, 8), tags: { amenity: 'fountain' } },
            { type: 'way', id: 4, geometry: squareRing(4.305, 52.075, 100), tags: { amenity: 'fountain' } },
            { type: 'node', id: 5, lon: 4.3, lat: 52.07, tags: { amenity: 'bench' } },
            { type: 'node', id: 6, lon: 4.3, lat: 52.07 }
        ]);
        expect(truncated).toBe(false);
        expect(features.map(f => [f.id, f.properties.kind])).toEqual([['n1', 'fountain'], ['n2', 'lamp'], ['w3', 'fountain'], ['w4', 'fountain']]);
        expect(features[0].properties.radiusM).toBe(DEFAULT_FOUNTAIN_RADIUS_M);
        expect(features[2].properties.radiusM).toBeCloseTo(Math.sqrt(64 / Math.PI), 1);
        expect(features[3].properties.radiusM).toBe(15);   // a pond-sized outline is held to a basin
        expect(overpassFurnitureToFeatures([
            { type: 'node', id: 1, lon: 4.3, lat: 52.07, tags: { highway: 'street_lamp' } },
            { type: 'node', id: 2, lon: 4.3, lat: 52.07, tags: { highway: 'street_lamp' } }
        ], 1).truncated).toBe(true);
    });

    it('answers fountains and lamps for an area, read around its centre when it is wider than a read', async () => {
        const fetchFurniture = vi.fn(async () => ({ features: overpassFurnitureToFeatures([
            { type: 'node', id: 1, lon: 4.3, lat: 52.07, tags: { amenity: 'fountain' } },
            { type: 'node', id: 2, lon: 4.31, lat: 52.07, tags: { highway: 'street_lamp' } }
        ]).features, partial: true }));
        const provider = createStreetFurnitureProvider({ fetchFurniture });
        const result = await provider.near({ type: 'Polygon', coordinates: [[[4, 52], [5, 52], [5, 53], [4, 53], [4, 52]]] }, 0);
        expect(result).toEqual({ fountains: [[4.3, 52.07, DEFAULT_FOUNTAIN_RADIUS_M]], lamps: [[4.31, 52.07]], count: 2, source: 'overpass', partial: true });
        const [w, s, e, n] = fetchFurniture.mock.calls[0][0];
        expect(e - w).toBeLessThanOrEqual(FURNITURE_MAX_SPAN_DEG);
        expect(n - s).toBeLessThanOrEqual(FURNITURE_MAX_SPAN_DEG);
        expect((w + e) / 2).toBeCloseTo(4.5, 6);
    });
});

describe('GET /decor/furniture', () => {
    function call(query, furnitureProvider) {
        const routes = {};
        setupDecorRoute({ get: (path, handler) => { routes[path] = handler; }, post: () => { } }, { query: vi.fn() },
            { waterProvider: { near: vi.fn() }, furnitureProvider });
        const res = { statusCode: 200 };
        res.status = code => { res.statusCode = code; return res; };
        res.json = body => { res.body = body; return res; };
        return routes['/decor/furniture']({ query }, res).then(() => res);
    }

    it('reads the box and buffer it is asked for', async () => {
        const near = vi.fn(async () => ({ fountains: [], lamps: [[1, 2]], count: 1, source: 'overpass' }));
        const res = await call({ bbox: '15.97,45.81,15.98,45.82', buffer_meters: '200' }, { near });
        expect(res.body.lamps).toEqual([[1, 2]]);
        expect(near.mock.calls[0][1]).toBe(200);
        expect(near.mock.calls[0][0].type).toBe('Polygon');
    });

    it('refuses a bad box and says when OSM is unavailable, instead of answering nothing', async () => {
        expect((await call({ bbox: 'x' }, { near: vi.fn() })).statusCode).toBe(400);
        const busy = await call({ bbox: '15.97,45.81,15.97,45.81' }, { near: async () => { throw Object.assign(new Error('backing off'), { status: 503 }); } });
        expect(busy.statusCode).toBe(503);
    });
});
