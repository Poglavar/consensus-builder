import { describe, expect, it, vi } from 'vitest';
import { searchLandmarkGeometry, __landmarkSourceInternals } from '../places/landmark-source.js';
import { setupPlacesRoute } from '../routes/places.js';

const point = [0.015, 0.015];
const response = elements => ({ ok: true, headers: { get: () => null }, json: async () => ({ elements }) });
const fetchFor = (...answers) => {
    const calls = [];
    return { calls, fetchImpl: vi.fn(async (url, options) => {
        calls.push({ url, query: new URLSearchParams(options.body).get('data') });
        return response(answers.shift() || []);
    }) };
};
const way = (id, tags, coords) => ({ type: 'way', id, tags, geometry: coords.map(([lon, lat]) => ({ lon, lat })) });

describe('bounded OSM landmark geometry', () => {
    it('reads one exact way and keeps its complete area geometry and owner tags', async () => {
        const source = fetchFor([way(710001, { name: 'Bridge House', building: 'yes', highway: 'pedestrian' }, [
            [0.014, 0.014], [0.016, 0.014], [0.016, 0.016], [0.014, 0.016], [0.014, 0.014]
        ])]);
        const result = await searchLandmarkGeometry({ osmId: 'way/710001', point, overpassUrl: 'https://unit.test/landmark-exact', fetchImpl: source.fetchImpl });
        expect(source.calls).toHaveLength(1);
        expect(source.calls[0].query).toContain('way(710001);out geom;');
        expect(result).toMatchObject({ osmId: 'way/710001', title: 'Bridge House', category: null, partial: false, truncated: false, source: 'osm-overpass' });
        expect(result.features).toHaveLength(1);
        expect(result.features[0].geometry).toEqual({ type: 'Polygon', coordinates: [[
            [0.014, 0.014], [0.016, 0.014], [0.016, 0.016], [0.014, 0.016], [0.014, 0.014]
        ]] });
        expect(result.features[0].properties).toMatchObject({ osmId: 'way/710001', name: 'Bridge House', highway: 'pedestrian', type: 'way' });
    });

    it('returns an open highway as a line and does not turn a closed road loop into an area by default', async () => {
        const source = fetchFor(
            [way(710002, { highway: 'path', name: 'Open path' }, [[0.014, 0.014], [0.016, 0.016]])],
            [way(710003, { highway: 'service', name: 'Closed loop' }, [[0.014, 0.014], [0.016, 0.014], [0.016, 0.016], [0.014, 0.014]])]
        );
        const open = await searchLandmarkGeometry({ osmId: 'way/710002', point, overpassUrl: 'https://unit.test/landmark-line-open', fetchImpl: source.fetchImpl });
        const closed = await searchLandmarkGeometry({ osmId: 'way/710003', point, overpassUrl: 'https://unit.test/landmark-line-closed', fetchImpl: source.fetchImpl });
        expect(open.features[0].geometry.type).toBe('LineString');
        expect(closed.features[0].geometry.type).toBe('LineString');
    });

    it('does not turn a closed highway bridge=yes way into a polygon without area or man_made=bridge', async () => {
        const loop = way(710010, { name: 'Road bridge loop', highway: 'footway', bridge: 'yes' }, [
            [0.014, 0.014], [0.016, 0.014], [0.016, 0.016], [0.014, 0.016], [0.014, 0.014]
        ]);
        const source = fetchFor([loop]);
        const result = await searchLandmarkGeometry({ osmId: 'way/710010', point, overpassUrl: 'https://unit.test/landmark-highway-bridge-loop', fetchImpl: source.fetchImpl });
        expect(result.features[0].properties.category).toBe('bridge');
        expect(result.features[0].geometry.type).toBe('LineString');
    });

    it('stitches multipolygon outer and inner members without inventing closures', async () => {
        const relation = { type: 'relation', id: 710004, tags: { name: 'Covered passage', type: 'multipolygon', man_made: 'bridge' }, members: [
            { type: 'way', ref: 1, role: 'outer', geometry: [{ lon: 0.014, lat: 0.014 }, { lon: 0.016, lat: 0.014 }, { lon: 0.016, lat: 0.016 }] },
            { type: 'way', ref: 2, role: 'outer', geometry: [{ lon: 0.014, lat: 0.016 }, { lon: 0.016, lat: 0.016 }] },
            { type: 'way', ref: 3, role: 'outer', geometry: [{ lon: 0.014, lat: 0.014 }, { lon: 0.014, lat: 0.016 }] },
            { type: 'way', ref: 4, role: 'inner', geometry: [[0.0145, 0.0145], [0.015, 0.0145], [0.015, 0.015], [0.0145, 0.015], [0.0145, 0.0145]].map(([lon, lat]) => ({ lon, lat })) }
        ] };
        const source = fetchFor([relation]);
        const result = await searchLandmarkGeometry({ osmId: 'relation/710004', point, overpassUrl: 'https://unit.test/landmark-relation', fetchImpl: source.fetchImpl });
        expect(result.category).toBe('bridge');
        expect(result.features[0].geometry.type).toBe('Polygon');
        expect(result.features[0].geometry.coordinates).toHaveLength(2);
        const incomplete = { ...relation, id: 710005, members: relation.members.slice(0, 1) };
        const broken = fetchFor([incomplete]);
        await expect(searchLandmarkGeometry({ osmId: 'relation/710005', point, overpassUrl: 'https://unit.test/landmark-relation-broken', fetchImpl: broken.fetchImpl }))
            .rejects.toMatchObject({ code: 'landmark-incomplete', status: 503 });
    });

    it('gets nearby exact-name bridge features as separate complete geometries', async () => {
        const seed = way(710006, { name: 'Bridge & Walk', bridge: 'yes', highway: 'footway' }, [[0.014, 0.014], [0.015, 0.015]]);
        const nearby = way(710007, { name: 'Bridge & Walk', man_made: 'bridge' }, [[0.015, 0.015], [0.016, 0.016]]);
        const source = fetchFor([seed], [seed, nearby]);
        const result = await searchLandmarkGeometry({ osmId: 'way/710006', point, overpassUrl: 'https://unit.test/landmark-bridge-nearby', fetchImpl: source.fetchImpl });
        expect(source.calls).toHaveLength(2);
        expect(source.calls[1].query).toContain('["name"="Bridge & Walk"]');
        expect(source.calls[1].query).toContain('["bridge"="yes"]');
        expect(source.calls[1].query).toContain('["man_made"="bridge"]');
        expect(source.calls[1].query).toContain('out 101 geom;');
        expect(result.features.map(feature => feature.properties.osmId)).toEqual(['way/710006', 'way/710007']);
        expect(result.features.every(feature => feature.geometry.type === 'LineString')).toBe(true);
    });

    it('rejects oversized and malformed geometry instead of returning a partial landmark', async () => {
        const source = fetchFor([way(710008, { name: 'Too long', man_made: 'bridge' }, [[-0.04, -0.04], [0.015, 0.015]])]);
        await expect(searchLandmarkGeometry({ osmId: 'way/710008', point, overpassUrl: 'https://unit.test/landmark-wide', fetchImpl: source.fetchImpl }))
            .rejects.toMatchObject({ code: 'landmark-too-large', status: 503 });
        expect(() => __landmarkSourceInternals.coordinatesOf([{ lon: 1, lat: 2 }, { lon: NaN, lat: 3 }]))
            .toThrow(expect.objectContaining({ code: 'landmark-incomplete', status: 503 }));
    });

    it('bounds large non-bridge geometry and rejects an OSM id whose geometry is far from the supplied point', async () => {
        const wide = way(710011, { name: 'Wide building', building: 'yes' }, [
            [-0.04, -0.04], [0.015, -0.04], [0.015, 0.015], [-0.04, 0.015], [-0.04, -0.04]
        ]);
        const wideSource = fetchFor([wide]);
        await expect(searchLandmarkGeometry({ osmId: 'way/710011', point, overpassUrl: 'https://unit.test/landmark-wide-building', fetchImpl: wideSource.fetchImpl }))
            .rejects.toMatchObject({ code: 'landmark-too-large', status: 503 });
        const remote = way(710012, { name: 'Other bridge', man_made: 'bridge' }, [[0.0165, 0.0165], [0.017, 0.017]]);
        const remoteSource = fetchFor([remote]);
        await expect(searchLandmarkGeometry({ osmId: 'way/710012', point, overpassUrl: 'https://unit.test/landmark-wrong-anchor', fetchImpl: remoteSource.fetchImpl }))
            .rejects.toMatchObject({ code: 'landmark-point-mismatch', status: 404 });
    });

    it('enforces feature and coordinate limits across the combined seed and nearby bridge features', async () => {
        const seed = way(710013, { name: 'Crowded bridge', man_made: 'bridge' }, [[0.015, 0.015], [0.0151, 0.0151]]);
        const many = Array.from({ length: 100 }, (_, index) => way(711000 + index, { name: 'Crowded bridge', bridge: 'yes' }, [[0.015, 0.015], [0.0151, 0.0151]]));
        const featureSource = fetchFor([seed], many);
        await expect(searchLandmarkGeometry({ osmId: 'way/710013', point, overpassUrl: 'https://unit.test/landmark-feature-limit', fetchImpl: featureSource.fetchImpl }))
            .rejects.toMatchObject({ code: 'landmark-too-large', status: 503 });

        const line = (id, name, size) => way(id, { name, bridge: 'yes', highway: 'footway' }, Array.from({ length: size }, () => [0.015, 0.015]));
        const coordinateSource = fetchFor([line(710014, 'Long bridge', 5001)], [line(710015, 'Long bridge', 5000)]);
        await expect(searchLandmarkGeometry({ osmId: 'way/710014', point, overpassUrl: 'https://unit.test/landmark-coordinate-limit', fetchImpl: coordinateSource.fetchImpl }))
            .rejects.toMatchObject({ code: 'landmark-too-large', status: 503 });
    });

    it('validates the geometry route and delegates only valid OSM ids and points', async () => {
        const routes = new Map(), search = vi.fn(async args => ({ osmId: args.osmId, title: 'Bridge', features: [], partial: false, truncated: false, source: 'osm-overpass' }));
        setupPlacesRoute({ get: (path, handler) => routes.set(path, handler) }, { landmarkGeometry: search });
        const invoke = async (query, path = '/places/geometry') => {
            const response = { status: vi.fn(function (code) { this.statusCode = code; return this; }), json: vi.fn(function (body) { this.body = body; return this; }), set: vi.fn() };
            await routes.get(path)({ query }, response); return response;
        };
        expect((await invoke({ osmId: 'node/0', point: '0.015,0.015' })).statusCode).toBe(400);
        const valid = await invoke({ osmId: 'way/710009', point: '0.015,0.015' });
        expect(search).toHaveBeenCalledWith({ osmId: 'way/710009', point: [0.015, 0.015] });
        expect(valid.body).toMatchObject({ osmId: 'way/710009', partial: false, truncated: false });
    });
});
