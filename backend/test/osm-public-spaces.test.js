// GET /osm-public-spaces: OpenStreetMap parks and squares through our Overpass chain, for the public
// land of Plan stats and Compare plans; an incomplete answer is refused so the browser falls back.
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { setupOsmPublicSpacesRoute } from '../routes/osm-public-spaces.js';

const appFor = fetchSpaces => { const app = express(); setupOsmPublicSpacesRoute(app, { fetchSpaces }); return app; };
const park = { type: 'Feature', id: 'w1', geometry: { type: 'Polygon', coordinates: [[[0, 0], [0.001, 0], [0.001, 0.001], [0, 0]]] }, properties: { kind: 'park', osmId: 'w1' } };

describe('OSM parks and squares route', () => {
    it('refuses malformed, unlabelled and too-wide boxes before asking Overpass', async () => {
        const fetchSpaces = vi.fn();
        const app = appFor(fetchSpaces);
        for (const query of [{ bbox: 'bad', crs: 'EPSG:4326' }, { bbox: '15.9,45.8,15.91,45.81' }, { bbox: '15.9,45.8,15.99,45.81', crs: 'EPSG:4326' }]) {
            expect((await request(app).get('/osm-public-spaces').query(query)).status).toBe(400);
        }
        expect(fetchSpaces).not.toHaveBeenCalled();
    });

    it('answers the features of a complete reading', async () => {
        const fetchSpaces = vi.fn(async () => ({ type: 'FeatureCollection', features: [park], truncated: false, partial: false }));
        const res = await request(appFor(fetchSpaces)).get('/osm-public-spaces').query({ bbox: '15.9,45.8,15.91,45.81', crs: 'EPSG:4326' });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ type: 'FeatureCollection', features: [park], source: 'overpass' });
        expect(fetchSpaces.mock.calls[0][0]).toEqual([15.9, 45.8, 15.91, 45.81]);
    });

    it('refuses partial, capped and failed readings, so public land is never undercounted', async () => {
        const query = { bbox: '15.9,45.8,15.91,45.81', crs: 'EPSG:4326' };
        expect((await request(appFor(async () => ({ features: [park], partial: true }))).get('/osm-public-spaces').query(query)).status).toBe(503);
        expect((await request(appFor(async () => ({ features: [park], truncated: true }))).get('/osm-public-spaces').query(query)).status).toBe(503);
        const busy = await request(appFor(async () => { throw Object.assign(new Error('throttled'), { status: 503, retryAfter: 30 }); })).get('/osm-public-spaces').query(query);
        expect(busy.status).toBe(503);
        expect(busy.headers['retry-after']).toBe('30');
        expect((await request(appFor(async () => { throw new Error('down'); })).get('/osm-public-spaces').query(query)).status).toBe(502);
    });
});
