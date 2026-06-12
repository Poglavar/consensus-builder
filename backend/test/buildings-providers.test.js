// Tests for the per-city 3D building providers' radius query. The key guarantee: the result cap
// is applied AFTER a distance ordering, so growing the radius only adds farther buildings instead
// of returning an arbitrary, shuffling subset (which made buildings flicker in/out and reshaped
// the loaded footprint).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createZagrebProvider } from '../buildings/zagreb-3d.js';
import { createNycProvider } from '../buildings/nyc-footprints.js';
import { createMockPool } from './helpers/mock-pool.js';

describe('Zagreb 3D provider — near()', () => {
    it('orders candidates by distance before the cap so the cap is deterministic (nearest-first)', async () => {
        const pool = createMockPool();
        const provider = createZagrebProvider(pool);

        await provider.near({ type: 'Point', coordinates: [15.977, 45.813] }, 300);

        const { sql, params } = pool.getCalls()[0];
        // The distance ordering must precede the cap — without it the LIMIT keeps an arbitrary
        // subset. (Match the clause tokens, not bare ORDER BY/LIMIT, which also appear in comments.)
        const orderIdx = sql.indexOf('b.shape <-> q.g');
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
