// Tests for the per-city 3D building providers' radius query. The key guarantee: the result cap
// is applied AFTER a distance ordering, so growing the radius only adds farther buildings instead
// of returning an arbitrary, shuffling subset (which made buildings flicker in/out and reshaped
// the loaded footprint).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBuildingProviders } from '../buildings/index.js';
import { createZagrebProvider } from '../buildings/zagreb-3d.js';
import { createNycProvider } from '../buildings/nyc-footprints.js';
import { createNycArcgisProvider } from '../buildings/nyc-arcgis.js';
import { createOvertureProvider } from '../buildings/overture-3d.js';
import { createOvertureTreesProvider } from '../decor/overture-trees.js';
import { effectiveHeight, OVERTURE_CITIES } from '../buildings/overture-cities.js';
import { createMockPool } from './helpers/mock-pool.js';

describe('Zagreb 3D provider — near()', () => {
    it('orders candidates by distance before the cap so the cap is deterministic (nearest-first)', async () => {
        const pool = createMockPool();
        const provider = createZagrebProvider(pool);

        await provider.near({ type: 'Point', coordinates: [15.977, 45.813] }, 300);

        const { sql, params } = pool.getCalls()[0];
        // The distance ordering must precede the cap — without it the LIMIT keeps an arbitrary
        // subset. (Match the clause tokens, not bare ORDER BY/LIMIT, which also appear in comments.)
        const orderIdx = sql.indexOf('b.geom2d_3765 <-> q.g');
        const limitIdx = sql.indexOf('LIMIT 4000');
        expect(orderIdx).toBeGreaterThan(-1);
        // Cap is well above the densest 500m-radius query so the radius is the real limiter.
        expect(limitIdx).toBeGreaterThan(orderIdx);
        expect(params[1]).toBe(300); // buffer_meters passed straight through to ST_DWithin
    });
});

describe('NYC footprints provider — near()', () => {
    afterEach(() => { vi.unstubAllGlobals(); });

    it('queries a true radius circle ordered by distance, capping nearest-first', async () => {
        let capturedUrl = '';
        vi.stubGlobal('fetch', vi.fn(async (url) => {
            capturedUrl = url;
            return { ok: true, json: async () => ({ type: 'FeatureCollection', features: [] }) };
        }));

        const provider = createNycProvider({});
        await provider.near({ type: 'Point', coordinates: [-73.9855, 40.7580] }, 300);

        const decoded = decodeURIComponent(capturedUrl);
        // True radius (circle), not a bounding box. For a point query the radius equals the buffer.
        expect(decoded).toContain('within_circle(the_geom, 40.758, -73.9855, 300)');
        expect(decoded).not.toContain('within_box');
        // Deterministic nearest-first ordering + a cap high enough that the radius is the limiter.
        expect(decoded).toContain("$order=distance_in_meters(the_geom, 'POINT(-73.9855 40.758)')");
        expect(decoded).toContain('$limit=4000');
        // feature_code filtered server-side so the cap counts real buildings.
        expect(decoded).toContain('feature_code = 2100');
    });

    it('grows the circle radius as the buffer grows (monotonic coverage)', async () => {
        const radii = [];
        vi.stubGlobal('fetch', vi.fn(async (url) => {
            const m = decodeURIComponent(url).match(/within_circle\(the_geom, [\d.-]+, [\d.-]+, ([\d.]+)\)/);
            radii.push(Number(m[1]));
            return { ok: true, json: async () => ({ type: 'FeatureCollection', features: [] }) };
        }));

        const provider = createNycProvider({});
        const point = { type: 'Point', coordinates: [-73.9855, 40.7580] };
        await provider.near(point, 200);
        await provider.near(point, 500);

        expect(radii[1]).toBeGreaterThan(radii[0]);
    });
});

describe('NYC ArcGIS provider — near()', () => {
    afterEach(() => { vi.unstubAllGlobals(); });

    it('queries the NYCMaps radius service and extrudes roof heights from feet to metres', async () => {
        let capturedUrl = '';
        vi.stubGlobal('fetch', vi.fn(async (url) => {
            capturedUrl = url;
            return {
                ok: true,
                json: async () => ({
                    type: 'FeatureCollection',
                    features: [{
                        type: 'Feature',
                        properties: {
                            BIN: 1079147,
                            DOITT_ID: 7602,
                            HEIGHT_ROOF: 119.98858395,
                            FEATURE_CODE: 2100,
                            NAME: 'City Hall Park-CITY HALL',
                            OBJECTID: 1079392
                        },
                        geometry: {
                            type: 'Polygon',
                            coordinates: [[
                                [-74.0061, 40.7129],
                                [-74.0059, 40.7129],
                                [-74.0059, 40.7127],
                                [-74.0061, 40.7127],
                                [-74.0061, 40.7129]
                            ]]
                        }
                    }]
                })
            };
        }));

        const provider = createNycArcgisProvider();
        const { buildings, count, source } = await provider.near({ type: 'Point', coordinates: [-74.006, 40.7128] }, 300);
        const url = new URL(capturedUrl);

        expect(url.hostname).toBe('services6.arcgis.com');
        expect(url.pathname).toContain('/BUILDING_view/FeatureServer/0/query');
        expect(url.searchParams.get('f')).toBe('geojson');
        expect(url.searchParams.get('geometry')).toBe('-74.006,40.7128');
        expect(url.searchParams.get('geometryType')).toBe('esriGeometryPoint');
        expect(url.searchParams.get('distance')).toBe('300');
        expect(url.searchParams.get('units')).toBe('esriSRUnit_Meter');
        expect(url.searchParams.get('where')).toBe('HEIGHT_ROOF > 0 AND FEATURE_CODE = 2100');
        expect(url.searchParams.get('resultRecordCount')).toBe('4000');

        expect(source).toBe('nyc-arcgis');
        expect(count).toBe(1);
        expect(buildings[0].object_id).toBe(1079147);
        expect(buildings[0].z_max).toBeCloseTo(119.98858395 * 0.3048);
        expect(buildings[0].faces.length).toBeGreaterThan(0);
    });
});

describe('Building provider registry', () => {
    afterEach(() => { vi.unstubAllGlobals(); });

    it('uses ArcGIS for NYC by default and keeps Socrata selectable by env flag', async () => {
        const urls = [];
        vi.stubGlobal('fetch', vi.fn(async (url) => {
            urls.push(url);
            return { ok: true, json: async () => ({ type: 'FeatureCollection', features: [] }) };
        }));

        const pool = createMockPool();
        await createBuildingProviders(pool, {}).resolve('new_york').near({ type: 'Point', coordinates: [-74.01, 40.71] }, 310);
        await createBuildingProviders(pool, { NYC_BUILDINGS_SOURCE: 'socrata' }).resolve('new_york').near({ type: 'Point', coordinates: [-74.02, 40.72] }, 320);

        expect(urls[0]).toContain('services6.arcgis.com');
        expect(urls[1]).toContain('data.cityofnewyork.us/resource/5zhs-2jue.geojson');
    });
});

describe('Overture 3D provider — near()', () => {
    it('queries a geography-radius circle, filters by city, and caps after a distance order', async () => {
        const pool = createMockPool();
        const provider = createOvertureProvider(pool, 'belgrade');

        await provider.near({ type: 'Point', coordinates: [20.4589, 44.8125] }, 300);

        const { sql, params } = pool.getCalls()[0];
        // True metres radius via geography — works at any latitude with no per-city projected CRS.
        expect(sql).toContain('ST_DWithin(b.geom::geography, q.g::geography, $3)');
        // City scoping precedes the spatial test so the cap counts only this city's buildings.
        expect(sql).toContain('b.city = $2');
        // One shared table for all Overture layers, discriminated by the layer column.
        expect(sql).toContain('overture_feature');
        expect(sql).toContain("b.layer = 'buildings'");
        // Distance order must precede the cap, else the LIMIT keeps an arbitrary, shuffling subset.
        const orderIdx = sql.indexOf('b.geom <-> q.g');
        const limitIdx = sql.indexOf('LIMIT 4000');
        expect(orderIdx).toBeGreaterThan(-1);
        expect(limitIdx).toBeGreaterThan(orderIdx);
        expect(params[1]).toBe('belgrade'); // city filter
        expect(params[2]).toBe(300);        // buffer straight through to ST_DWithin
    });

    it('extrudes each footprint with the height fallback (measured → floors → default)', async () => {
        const pool = createMockPool();
        const square = {
            type: 'Polygon',
            coordinates: [[[20.45, 44.81], [20.4501, 44.81], [20.4501, 44.8101], [20.45, 44.8101], [20.45, 44.81]]]
        };
        pool.setResult({
            rows: [
                { overture_id: 'a', height_m: 24, num_floors: null, geometry: square }, // measured
                { overture_id: 'b', height_m: null, num_floors: 5, geometry: square },   // floors
                { overture_id: 'c', height_m: null, num_floors: null, geometry: square } // default
            ]
        });
        const provider = createOvertureProvider(pool, 'belgrade');

        const { buildings, count, source } = await provider.near({ type: 'Point', coordinates: [20.45, 44.81] }, 200);
        const cfg = OVERTURE_CITIES.belgrade;

        expect(source).toBe('overture-3d');
        expect(count).toBe(3);
        expect(buildings.find(b => b.object_id === 'a').z_max).toBeCloseTo(24);
        expect(buildings.find(b => b.object_id === 'b').z_max).toBeCloseTo(5 * cfg.floorHeightM);
        expect(buildings.find(b => b.object_id === 'c').z_max).toBeCloseTo(cfg.defaultHeightM);
    });

    it('effectiveHeight picks the right source in priority order', () => {
        const cfg = { floorHeightM: 3.2, defaultHeightM: 9 };
        expect(effectiveHeight(30, 99, cfg)).toEqual({ height: 30, source: 'overture' });
        expect(effectiveHeight(0, 4, cfg)).toEqual({ height: 12.8, source: 'floors' });
        expect(effectiveHeight(NaN, NaN, cfg)).toEqual({ height: 9, source: 'default' });
    });
});

describe('Overture trees provider — near()', () => {
    it('queries a geography-radius circle, filters by city, caps after a distance order', async () => {
        const pool = createMockPool();
        const provider = createOvertureTreesProvider(pool, 'belgrade');

        await provider.near({ type: 'Point', coordinates: [20.4612, 44.8125] }, 300);

        const { sql, params } = pool.getCalls()[0];
        expect(sql).toContain('ST_DWithin(t.geom::geography, q.g::geography, $3)');
        expect(sql).toContain('t.city = $2');
        expect(sql).toContain('overture_feature');
        expect(sql).toContain("t.layer = 'trees'");
        const orderIdx = sql.indexOf('t.geom <-> q.g');
        const limitIdx = sql.indexOf('LIMIT 8000');
        expect(orderIdx).toBeGreaterThan(-1);
        expect(limitIdx).toBeGreaterThan(orderIdx);
        expect(params[1]).toBe('belgrade');
        expect(params[2]).toBe(300);
    });

    it('returns trees as [lng, lat] pairs', async () => {
        const pool = createMockPool();
        pool.setResult({ rows: [{ lng: 20.46, lat: 44.81 }, { lng: 20.47, lat: 44.82 }] });
        const provider = createOvertureTreesProvider(pool, 'belgrade');

        const { trees, count, source } = await provider.near({ type: 'Point', coordinates: [20.46, 44.81] }, 200);
        expect(source).toBe('overture-trees');
        expect(count).toBe(2);
        expect(trees[0]).toEqual([20.46, 44.81]);
    });
});
