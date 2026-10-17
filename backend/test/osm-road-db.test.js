// /osm-road's table query against the real osm_road table: a box in Zagreb answers from the
// table, and a box far from Croatia (Bogotá) runs the same query without a projection error and
// falls through to Overpass. Run with RUN_DB_TESTS=1 (and DATABASE_URL pointing at the local database).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { setupOsmRoadRoute } from '../routes/osm-road.js';

const live = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;

live('GET /osm-road on the real table', () => {
    let client;
    let app;
    const overpassAsked = [];

    beforeAll(async () => {
        const { createClient } = await import('../db/connection.cjs');
        client = createClient();
        await client.connect();
        app = express();
        setupOsmRoadRoute(app, { query: (...args) => client.query(...args) }, {
            fetchOverpassRoads: async box => { overpassAsked.push(box); return { features: [], truncated: false }; }
        });
    });
    afterAll(async () => { if (client) await client.end(); });

    it('answers a Zagreb box from the table', async () => {
        const res = await request(app).get('/osm-road?bbox=15.975,45.810,15.980,45.814&crs=EPSG:4326');
        expect(res.status).toBe(200);
        expect(res.body.source).toBe('osm_road');
        expect(res.body.features.length).toBeGreaterThan(0);
    });

    it('answers a Bogotá box from Overpass instead of failing to project it into Croatian TM', async () => {
        const res = await request(app).get('/osm-road?bbox=-74.0840,4.6090,-74.0805,4.6120&crs=EPSG:4326');
        expect(res.status).toBe(200);
        expect(res.body.source).toBe('overpass');
        expect(overpassAsked).toEqual([[-74.0840, 4.6090, -74.0805, 4.6120]]);
    });
});
