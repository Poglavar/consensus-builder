// Exercises the provider-independent parcel gateway and its validation and failure responses.
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { setupParcelSourcesRoute } from '../routes/parcel-sources.js';

const descriptor = {
    adapter: 'arcgis',
    id: 'ca-on-toronto',
    name: 'Toronto property boundary',
    endpoint: 'https://gis.toronto.ca/arcgis/rest/services/cot_geospatial27/FeatureServer/36',
    idField: 'PARCELID',
    objectIdField: 'OBJECTID',
    idPrefix: 'CA-ON-TORONTO-',
    outFields: ['OBJECTID', 'PARCELID'],
    pageSize: 2,
    maxFeatures: 10
};

const parcel = {
    type: 'Feature', id: 5,
    properties: { OBJECTID: 5, PARCELID: '12345' },
    geometry: { type: 'Polygon', coordinates: [[[-79.384, 43.652], [-79.383, 43.652], [-79.383, 43.653], [-79.384, 43.652]]] }
};

function makeApp(fetchImpl) {
    const app = express();
    app.use(express.json());
    setupParcelSourcesRoute(app, { sources: [descriptor], fetchImpl });
    return app;
}

function geojsonFetch(features = [parcel]) {
    return vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ type: 'FeatureCollection', features, exceededTransferLimit: false })
    }));
}

describe('parcel source routes', () => {
    it('lists configured sources without querying parcel geometry', async () => {
        const fetchImpl = geojsonFetch();
        const response = await request(makeApp(fetchImpl)).get('/parcel-sources');

        expect(response.status).toBe(200);
        expect(response.body.sources).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'ca-on-toronto' })
        ]));
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('routes a valid bbox to the provider and returns a complete feature collection', async () => {
        const fetchImpl = geojsonFetch();
        const response = await request(makeApp(fetchImpl))
            .get('/parcel-sources/ca-on-toronto?bbox=-79.384,43.652,-79.383,43.653');

        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({ type: 'FeatureCollection', complete: true });
        expect(response.body.features).toHaveLength(1);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('routes namespaced parcel IDs and carries complete absence information', async () => {
        const fetchImpl = geojsonFetch([parcel]);
        const response = await request(makeApp(fetchImpl))
            .get('/parcel-sources/ca-on-toronto?ids=CA-ON-TORONTO-12345,CA-ON-TORONTO-99999');

        expect(response.status).toBe(200);
        expect(response.body.complete).toBe(true);
        expect(response.body.features.map(feature => feature.id)).toEqual(['CA-ON-TORONTO-12345']);
        expect(response.body.absentIds).toEqual(['CA-ON-TORONTO-99999']);
    });

    it('routes a GeoJSON footprint through POST /under', async () => {
        const fetchImpl = geojsonFetch([parcel]);
        const response = await request(makeApp(fetchImpl))
            .post('/parcel-sources/ca-on-toronto/under')
            .send({ geometry: {
                type: 'Polygon',
                coordinates: [[[-79.384, 43.652], [-79.383, 43.652], [-79.383, 43.653], [-79.384, 43.652]]]
            }, srid: 4326 });

        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({ type: 'FeatureCollection', complete: true });
        expect(response.body.features.map(feature => feature.id)).toContain('CA-ON-TORONTO-12345');
    });

    it('rejects missing, repeated, malformed, and competing query parameters', async () => {
        const app = makeApp(geojsonFetch());
        for (const path of [
            '/parcel-sources/ca-on-toronto',
            '/parcel-sources/ca-on-toronto?bbox=1,2,3',
            '/parcel-sources/ca-on-toronto?bbox=1,2,3,4&bbox=5,6,7,8',
            '/parcel-sources/ca-on-toronto?ids=CA-ON-TORONTO-1&ids=CA-ON-TORONTO-2',
            '/parcel-sources/ca-on-toronto?bbox=1,2,3,4&ids=CA-ON-TORONTO-1',
            '/parcel-sources/ca-on-toronto?bbox=0,0,181,91'
        ]) {
            const response = await request(app).get(path);
            expect(response.status, path).toBe(400);
        }
        const invalidBody = await request(app).post('/parcel-sources/ca-on-toronto/under').send({ geometry: null });
        expect(invalidBody.status).toBe(400);
    });

    it('returns 404 for an unconfigured source', async () => {
        const response = await request(makeApp(geojsonFetch()))
            .get('/parcel-sources/no-such-source?bbox=-79.384,43.652,-79.383,43.653');
        expect(response.status).toBe(404);
    });

    it('maps provider failures to gateway errors and never reports them as an empty success', async () => {
        const unavailableFetch = vi.fn(async () => ({
            ok: false, status: 503, json: async () => ({ error: { message: 'upstream unavailable' } })
        }));
        const failed = await request(makeApp(unavailableFetch))
            .get('/parcel-sources/ca-on-toronto?bbox=-79.384,43.652,-79.383,43.653');
        expect(failed.status).toBe(502);
        expect(failed.body.complete).not.toBe(true);
        expect(failed.body.features).not.toEqual([]);

        const timeoutFetch = vi.fn(async () => { throw Object.assign(new Error('timeout'), { name: 'AbortError' }); });
        const timedOut = await request(makeApp(timeoutFetch))
            .get('/parcel-sources/ca-on-toronto?bbox=-79.384,43.652,-79.383,43.653');
        expect(timedOut.status).toBe(504);
        expect(timedOut.body.complete).not.toBe(true);
        expect(timedOut.body.features).not.toEqual([]);
    });
});
