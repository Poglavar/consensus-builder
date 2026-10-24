// Publication refuses unplayable metric routes before touching storage or pinning immutable content.
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { canonicalBytes, cidOf } from '../cid.js';
import { MAX_PINNED_OBJECT_BYTES } from '../storage/pinning.js';
import { setupFlightsRoute } from '../routes/flights.js';
const require = createRequire(import.meta.url), CameraFlight = require('../../frontend/js/camera-flight.js');

const a = cidOf(Buffer.from('design a')), b = cidOf(Buffer.from('design b'));
const content = {
    schema: 'camera-flight/v1', title: 'Courtyard flight', designCids: [a, b].sort(),
    view: { at: '52.47935,-1.87943,18', mode: 'model', city: 'birmingham', language: 'en', settings: {} },
    frame: { lat: 52.47935, lng: -1.87943, datum: 'model-ground' }, fov: 45,
    route: [{ id: 'start', position: [0, 2, 0], travelSeconds: 0, holdSeconds: 1 },
        { id: 'end', position: [20, 4, 10], travelSeconds: 5, holdSeconds: 0 }],
    looks: [{ id: 'look-start', time: 0, quaternion: [0, 0, 0, 1] },
        { id: 'look-end', time: 6, quaternion: [0, 1, 0, 0] }], interiors: [], cues: []
};
const cid = cidOf(canonicalBytes(content));
const floorPlans = () => ({
    schema: 'consensus-builder.building-floor-plans.v2',
    registration: { basis: 'corners', corners: [[-1.88, 52.47], [-1.8799, 52.47], [-1.8799, 52.4701], [-1.88, 52.4701]] },
    layouts: [{ id: 'layout', source: { kind: 'generated', generator: 'fixture', parameters: {} },
        architecture: { schema: 'consensus-builder.floor-architecture.v1', dimensionsM: [10, 8], wallHeightM: 2.8,
            slabThicknessM: .2, walls: [[[[0, 0], [1, 0], [1, .02], [0, .02]]]],
            slabs: [[[[0, 0], [1, 0], [1, 1], [0, 1]]]], landings: [], openings: [], stairs: [], railings: [] } }],
    floors: [{ id: 'floor', level: 0, elevationM: 0, elevationBasis: 'estimated', layoutId: 'layout' }], suggested: true
});
const interiorContent = () => ({ ...structuredClone(content), interiors: [{ id: 'snapshot', feature: {
    type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[-1.88, 52.47], [-1.8799, 52.47], [-1.8799, 52.4701], [-1.88, 52.47]]] },
    properties: { floorPlans: floorPlans() }
} }] });

function server({ records = new Map(), designs = [a, b], pin = vi.fn(async ({ cid }) => ({ cid })),
    insert = true, queryError = false, readbackError = false } = {}) {
    let inserted = false;
    const pool = { query: vi.fn(async (sql, params) => {
        if (queryError || (inserted && readbackError)) throw new Error('Database unavailable');
        if (sql.startsWith('SELECT cid, content')) return { rows: records.has(params[0]) ? [structuredClone(records.get(params[0]))] : [] };
        if (sql.startsWith('SELECT cid FROM consensus.design')) return { rows: designs.filter(cid => params[0].includes(cid)).map(cid => ({ cid })) };
        if (sql.startsWith('INSERT INTO consensus.camera_flight')) {
            if (insert && !records.has(params[0])) records.set(params[0], { cid: params[0], content: JSON.parse(params[1]) });
            inserted = true; return { rows: [] };
        }
        throw new Error(`Unexpected query: ${sql}`);
    }) };
    const app = express(); app.use(express.json({ limit: '15mb' }));
    setupFlightsRoute(app, { pool, pinBytes: pin, uploadRateLimiter: (_req, _res, next) => next() });
    return { app, records, pool, pin };
}
afterEach(() => vi.restoreAllMocks());

describe('durable camera flight API', () => {
    it('pins canonical bytes, replays the exact snapshot after restart and retries without repinning', async () => {
        const { app, records, pin } = server();
        const first = await request(app).post('/flights').send({ content });
        expect(first.status).toBe(201); expect(first.body).toEqual({ cid, content });
        expect(pin).toHaveBeenCalledExactlyOnceWith({ cid, bytes: canonicalBytes(content), name: `flight-${cid}` });
        const restarted = server({ records });
        expect((await request(restarted.app).get(`/flights/${cid}`)).body).toEqual(first.body);
        const retry = await request(restarted.app).post('/flights').send({ content });
        expect(retry.status).toBe(200); expect(retry.body).toEqual(first.body);
        expect(restarted.pin).not.toHaveBeenCalled();
    });
    it('saves a city-only flight without requesting design existence', async () => {
        const api = server(); const city = { ...content, designCids: [] };
        const response = await request(api.app).post('/flights').send({ content: city });
        expect(response.status).toBe(201); expect(response.body.cid).toBe(cidOf(canonicalBytes(city)));
        expect(api.pool.query.mock.calls.some(([sql]) => sql.startsWith('SELECT cid FROM consensus.design'))).toBe(false);
    });
    it('retains validated interior snapshots and gives changed content a different CID', async () => {
        const snapshot = interiorContent(), api = server();
        const response = await request(api.app).post('/flights').send({ content: snapshot });
        expect(response.status).toBe(201); expect(response.body.content).toEqual(snapshot);
        expect(response.body.cid).toBe(cidOf(canonicalBytes(snapshot))); expect(response.body.cid).not.toBe(cid);
    });
    it.each([
        value => { value.schema = 'wrong'; }, value => { value.designCids = [a, a]; },
        value => { value.route[0].position[0] = null; }, value => { value.looks[0].quaternion = [0, 0, 0, 0]; },
        value => { value.view.mode = 'photo'; }, value => { value.frame.datum = 'unknown'; },
        value => { value.frame.lat = 52.4793501; }, value => { value.route[1].position = [36000.001, 48000, 10]; }
    ])('rejects malformed records before any database or pinning effects', async change => {
        const api = server(), bad = structuredClone(content); change(bad);
        expect((await request(api.app).post('/flights').send({ content: bad })).status).toBe(400);
        expect(api.pool.query).not.toHaveBeenCalled(); expect(api.pin).not.toHaveBeenCalled();
    });
    it('rejects curve overshoot outside the metric domain even when every authored node is valid', async () => {
        const bad = structuredClone(content);
        bad.route = [[0, 0, 0], [59900, -500, 0], [59900, 500, 0], [0, 1000, 0]].map((position, index) => ({
            id: `point-${index}`, position, travelSeconds: index ? 10 : 0, holdSeconds: 0
        }));
        expect(CameraFlight.validate(bad)).toBeNull();
        expect(() => CameraFlight.compile(bad)).toThrow(/60 km metric frame/);
        const api = server(), response = await request(api.app).post('/flights').send({ content: bad });
        expect(response.status).toBe(400); expect(response.body.error).toMatch(/camera flight/i);
        expect(api.pool.query).not.toHaveBeenCalled(); expect(api.pin).not.toHaveBeenCalled(); expect(api.records.size).toBe(0);
    });
    it.each([
        plans => { plans.registration.corners[1] = plans.registration.corners[0]; },
        plans => { plans.floors[0].layoutId = 'missing'; },
        plans => { plans.layouts[0].architecture.wallHeightM = 100; },
        plans => { plans.suggested = false; }
    ])('checks full interior floor models before any side effects', async change => {
        const bad = interiorContent(); change(bad.interiors[0].feature.properties.floorPlans);
        const api = server(), response = await request(api.app).post('/flights').send({ content: bad });
        expect(response.status).toBe(400); expect(response.body.error).toMatch(/interior|floorPlans/i);
        expect(api.pool.query).not.toHaveBeenCalled(); expect(api.pin).not.toHaveBeenCalled();
    });
    it('rejects oversized presentation snapshots before database or pinning effects', async () => {
        const bad = interiorContent(); bad.interiors[0].feature.properties.floorPlans.fixturePadding = Array.from({ length: Math.ceil(MAX_PINNED_OBJECT_BYTES / 100000) }, () => 'x'.repeat(100000));
        const api = server(), response = await request(api.app).post('/flights').send({ content: bad });
        expect(response.status).toBe(413); expect(response.body.code).toBe('too-large');
        expect(api.pool.query).not.toHaveBeenCalled(); expect(api.pin).not.toHaveBeenCalled();
    });
    it('reports missing referenced designs before pinning', async () => {
        const api = server({ designs: [a] }), response = await request(api.app).post('/flights').send({ content });
        expect(response.status).toBe(409); expect(response.body.missing).toEqual([b]);
        expect(api.pin).not.toHaveBeenCalled(); expect(api.records.size).toBe(0);
    });
    it('reports exhausted quota with an actionable retry and no indexed record', async () => {
        const api = server({ pin: vi.fn(async () => { throw Object.assign(new Error('Quota exhausted'), { code: 'pinning-quota-exhausted' }); }) });
        const response = await request(api.app).post('/flights').send({ content });
        expect(response.status).toBe(409); expect(response.body).toMatchObject({ code: 'pinning-quota-exhausted', next: { action: expect.stringContaining('Restore quota') } });
        expect(api.records.size).toBe(0);
    });
    it.each([async () => ({ cid: a }), async () => undefined, async () => { throw new Error('Pin unavailable'); }])('refuses a failed or mismatched pin without indexing', async pin => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const api = server({ pin });
        expect((await request(api.app).post('/flights').send({ content })).status).toBe(503);
        expect(api.records.size).toBe(0);
    });
    it.each([{ insert: false }, { readbackError: true }, { queryError: true }])('never reports save success without verified durable readback', async options => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const api = server(options);
        expect((await request(api.app).post('/flights').send({ content })).status).toBe(503);
    });
    it('rejects corrupt indexed content on GET and idempotent POST', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const api = server({ records: new Map([[cid, { cid, content: { ...content, title: 'Changed' } }]]) });
        expect((await request(api.app).get(`/flights/${cid}`)).status).toBe(503);
        expect((await request(api.app).post('/flights').send({ content })).status).toBe(503);
        expect(api.pin).not.toHaveBeenCalled();
    });
    it('distinguishes malformed links, missing records and database errors', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const api = server();
        expect((await request(api.app).get('/flights/invalid')).status).toBe(400);
        expect(api.pool.query).not.toHaveBeenCalled();
        expect((await request(api.app).get(`/flights/${cid}`)).status).toBe(404);
        expect((await request(server({ queryError: true }).app).get(`/flights/${cid}`)).status).toBe(503);
    });
});
