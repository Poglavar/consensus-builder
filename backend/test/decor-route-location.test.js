// /decor answers by place, never by a city name (location-first.md phase 2): layers from what lies in
// the requested box, trees where the geometry is — an Overture city's labelled ingests first, any
// other place (Zagreb, New York, explore) from the geometry alone.
import { describe, expect, it, vi } from 'vitest';
import { setupDecorRoute } from '../routes/decor.js';

function app() {
    const routes = {};
    return { routes, get: (path, handler) => { routes['GET ' + path] = handler; }, post: (path, handler) => { routes['POST ' + path] = handler; } };
}
const response = () => {
    const res = { statusCode: 200 };
    res.status = code => { res.statusCode = code; return res; };
    res.json = body => { res.body = body; return res; };
    return res;
};
const point = (lon, lat) => ({ type: 'Point', coordinates: [lon, lat] });

describe('GET /decor/layers', () => {
    it('lists the scenery found in the box, water everywhere', async () => {
        const pool = { query: vi.fn(async () => ({ rows: [{ kind: 'trees' }] })) };
        const server = app();
        setupDecorRoute(server, pool, { waterProvider: { near: vi.fn() } });
        const res = response();
        await server.routes['GET /decor/layers']({ query: { bbox: '15.96,45.80,15.98,45.82' } }, res);
        expect(res.body).toEqual({ layers: ['trees', 'water'] });
        const [sql, params] = pool.query.mock.calls[0];
        expect(sql).toMatch(/ST_MakeEnvelope\(\$1, \$2, \$3, \$4, 4326\)/);
        expect(sql).not.toMatch(/city/);
        expect(params).toEqual([15.96, 45.8, 15.98, 45.82, ['trees']]);
    });

    it('refuses a request without a box (a city name is no longer an answer)', async () => {
        const server = app();
        setupDecorRoute(server, { query: vi.fn() }, { waterProvider: { near: vi.fn() } });
        const res = response();
        await server.routes['GET /decor/layers']({ query: { city: 'zagreb' } }, res);
        expect(res.statusCode).toBe(400);
    });
});

describe('POST /decor/near', () => {
    // The labels each tree query was asked with, in order (data-scope.js ladder rungs).
    function treesFor(geometry, body = {}) {
        const labels = [];
        const pool = { query: vi.fn(async (sql, params) => { labels.push(params[1]); return { rows: [{ lng: 1, lat: 2 }] }; }) };
        const server = app();
        setupDecorRoute(server, pool, { waterProvider: { near: vi.fn() } });
        const res = response();
        return server.routes['POST /decor/near']({ body: { geometry, buffer_meters: 200, ...body } }, res).then(() => ({ res, labels }));
    }

    it('gives Zagreb trees from the geometry alone, where it used to give none', async () => {
        const { res, labels } = await treesFor(point(15.9706, 45.81305));
        expect(res.body).toMatchObject({ trees: [[1, 2]], count: 1 });
        expect(labels).toEqual([null]);
    });

    it("reads Split's own ingest first, whatever city the body names", async () => {
        const { labels } = await treesFor(point(16.4402, 43.5081), { city: 'belgrade' });
        expect(labels[0]).toBe('split');
    });

    it('answers explore and New York from the geometry too', async () => {
        expect((await treesFor(point(90.4074, 23.7104))).labels).toEqual([null]);
        expect((await treesFor(point(-73.9857, 40.7484))).labels).toEqual([null]);
    });
});
