// Published floor plans in X-ray: the plans-to-model converter, the floor-plan-publication adapter
// (summary markers and on-demand models: batching, pagination, cache, failure), the authored-model-first
// rule, the marker-only /buildings/cell answer and the per-building GET /buildings/floor-model.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import request from 'supertest';
import { publishedPlansToFloorModel } from '../buildings/published-floor-model.js';
import { createFloorPlanPublicationReader } from '../buildings/floor-plan-publication.js';
import { createPublishedFloorModels, attachNearbyFloorModelMarkers, readNativeFloorModel, readCityConfigs } from '../buildings/floor-models.js';
import { setupBuildingsRoute } from '../routes/buildings.js';
import { setupBuildingFloorModelsRoute } from '../routes/building-floor-models.js';
import { createRouteApp } from './helpers/create-route-app.js';
import { createMockPool } from './helpers/mock-pool.js';

const require = createRequire(import.meta.url);
const { validateFloorPlans, registrationToLngLat } = require('../../frontend/js/building-floor-plans.js');
const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/podbrezje-a4-published-floor-plans.json', import.meta.url), 'utf8')).plans;
const A4 = '148972';
const silent = () => {};

const bilinear = (c, [u, v]) => [
    (1 - u) * (1 - v) * c[0][0] + u * (1 - v) * c[1][0] + u * v * c[2][0] + (1 - u) * v * c[3][0],
    (1 - u) * (1 - v) * c[0][1] + u * (1 - v) * c[1][1] + u * v * c[2][1] + (1 - u) * v * c[3][1]];
const metres = (a, b) => Math.hypot((a[0] - b[0]) * 111320 * Math.cos(a[1] * Math.PI / 180), (a[1] - b[1]) * 111320);

describe('published plans → one X-ray floor model', () => {
    it('draws a storey from its whole-floor plan, another from its flats, at the envelope elevations', () => {
        const plans = fixture();
        const floor = plans.find(plan => plan.scope === 'floor');
        const result = publishedPlansToFloorModel(plans, { publicationUrl: id => `https://publication.test/api/floor-plans/${id}` });
        const model = result.floorPlans;
        expect(validateFloorPlans(model)).toEqual([]);
        expect(model.storeys.map(storey => [storey.level, storey.elevationM, storey.elevationBasis])).toEqual([[2, 7.27, 'estimated'], [6, 19.98, 'estimated']]);
        // The whole floor owns level 2 (its own architecture, unmoved); its two flats are listed, not drawn.
        const level2 = model.storeys[0], layout2 = model.layouts.find(layout => layout.id === level2.layoutId);
        expect(level2.source.planIds).toEqual([floor.id]);
        expect(layout2.architecture.walls).toEqual(floor.architecture.walls);
        expect(level2.units.map(unit => unit.id).sort()).toEqual(['A4-C-05', 'A4-C-06']);
        expect(level2.units.every(unit => unit.kind === 'apartment' && unit.url.startsWith('https://'))).toBe(true);
        // Walls fill the estimated 3.17 m storey above a 0.2 m slab.
        expect(layout2.architecture.wallHeightM).toBe(2.97);
        expect(layout2.source).toMatchObject({ url: floor.source.url, sha256: floor.source.sha256,
            publication: [{ planId: floor.id, url: `https://publication.test/api/floor-plans/${floor.id}`, quality: 'needs_review' }] });
        // Level 6 has no whole-floor plan: its two flats are merged into one layout in the floor's frame.
        expect(model.registration).toMatchObject({ corners: floor.registration.corners, accuracy: 'approximate', accuracyM: 2 });
        const level6 = model.storeys[1], layout6 = model.layouts.find(layout => layout.id === level6.layoutId);
        const flats6 = plans.filter(plan => plan.floor === 6);
        expect(level6.source.planIds.sort()).toEqual(flats6.map(plan => plan.id).sort());
        expect(layout6.architecture.walls).toHaveLength(flats6.reduce((sum, plan) => sum + plan.architecture.walls.length, 0));
        // A moved point lands where the flat's own registration put it on the map.
        const flat = flats6.find(plan => plan.id === level6.source.planIds[0]);
        const toMap = registrationToLngLat(model);
        for (const [moved, original] of [[layout6.architecture.walls[0][0][0], flat.architecture.walls[0][0][0]],
            [layout6.architecture.openings[0].a, flat.architecture.openings[0].a]]) {
            expect(metres(toMap(...moved), bilinear(flat.registration.corners, original))).toBeLessThan(0.01);
        }
        expect(result.footprint.type).toBe('MultiPolygon');
        expect(result.skipped).toEqual({ unregistered: 0, invalidArchitecture: 0, noLevel: 0, noStorey: 0 });
    });

    it('frames flats that no whole-floor plan contains in the rectangle that bounds them', () => {
        const flats = fixture().filter(plan => plan.scope === 'unit');
        const model = publishedPlansToFloorModel(flats).floorPlans;
        expect(validateFloorPlans(model)).toEqual([]);
        expect(model.registration.basis).toMatch(/Bounding frame of 4 published plan registrations/);
        const [o, a, , b] = model.registration.corners;
        const toLocal = p => [(p[0] - o[0]) * 111320 * Math.cos(o[1] * Math.PI / 180), (p[1] - o[1]) * 111320];
        const U = toLocal(a), V = toLocal(b), det = U[0] * V[1] - U[1] * V[0];
        for (const corner of flats.flatMap(plan => plan.registration.corners)) {
            const d = toLocal(corner), u = (d[0] * V[1] - d[1] * V[0]) / det, v = (U[0] * d[1] - U[1] * d[0]) / det;
            // Within a millimetre of the frame (its corners are rounded to 1e-9 degrees).
            expect(u).toBeGreaterThan(-1e-5); expect(u).toBeLessThan(1 + 1e-5);
            expect(v).toBeGreaterThan(-1e-5); expect(v).toBeLessThan(1 + 1e-5);
        }
    });

    it('skips and counts plans it cannot place, and gives no model when none can be placed', () => {
        const plans = fixture();
        const unregistered = plans.map(plan => ({ ...plan, registration: null }));
        expect(publishedPlansToFloorModel(unregistered)).toBeNull();
        const mixed = [{ ...plans[0], registration: null }, { ...plans[1], architecture: null }, ...plans.slice(2)];
        const result = publishedPlansToFloorModel(mixed);
        expect(result.skipped).toMatchObject({ unregistered: 1, invalidArchitecture: 1 });
        expect(result.floorPlans.storeys.map(storey => storey.level)).toEqual([2, 6]);
        // Without the whole floor, level 2 is drawn by its remaining flat.
        expect(result.floorPlans.storeys[0].source.planIds).toEqual([plans[2].id]);
        const noEnvelope = plans.map(plan => ({ ...plan, building: { ...plan.building, envelope: null } }));
        expect(publishedPlansToFloorModel(noEnvelope)).toBeNull();
    });
});

// A fake publication API: full plans at /floor-plans, the compact listing at /floor-plans/summaries
// (cadastre-data's row shape), per qualified native id, `limit` per page.
const summaryOf = plan => ({ id: plan.id, buildingId: plan.buildingId ?? null, scope: plan.scope, floor: plan.floor ?? null, levels: plan.levels || [], unitId: plan.unitId ?? null,
    quality: plan.quality?.status ?? null, registered: Boolean(plan.registration), buildingRefs: plan.buildingRefs, updatedAt: plan.updatedAt ?? null });
function fakePublication(plansById, { fail = () => false } = {}) {
    const calls = [];
    const fetch = async url => {
        const parsed = new URL(url), query = parsed.searchParams;
        calls.push({ path: parsed.pathname, ...Object.fromEntries(query) });
        const ids = (query.get('nativeBuildingIds') ?? query.get('nativeBuildingId')).split(',');
        if (fail(ids, parsed.pathname)) throw new Error('connect ECONNREFUSED');
        const summaries = parsed.pathname.endsWith('/summaries');
        const all = ids.flatMap(id => plansById[id] || []).map(plan => summaries ? summaryOf(plan) : plan);
        const offset = Number(query.get('offset')), limit = Number(query.get('limit'));
        const body = { plans: all.slice(offset, offset + limit), limit, offset, hasMore: all.length > offset + limit };
        return { ok: true, json: async () => body, bytes: JSON.stringify(body).length };
    };
    return { fetch, calls };
}
const config = { baseUrl: 'https://publication.test/api/', city: 'zagreb', source: 'zagreb-3d', buildingSource: 'zagreb-3d' };
const identity = buildingId => ({ city: 'zagreb', source: 'zagreb-3d', ownerId: '', buildingId });
const belongTo = (id, source = 'zagreb-3d') => fixture().map(plan => ({ ...plan, buildingRefs: [{ city: 'zagreb', source, ownerId: '', buildingId: id }] }));

describe('floor-plan-publication adapter', () => {
    it('marks buildings from compact summaries, at most 200 at a time, and caches the marks', async () => {
        const api = fakePublication({ [A4]: fixture() });
        const reader = createFloorPlanPublicationReader(config, { fetch: api.fetch, cache: new Map(), log: silent });
        const ids = [A4, ...Array.from({ length: 449 }, (_, i) => String(900000 + i))];
        const marks = await reader.fetchFloorModelMarkers(ids.map(identity));
        expect([...marks.entries()]).toEqual([[A4, { storeys: [2, 6], units: 4 }]]);
        expect(api.calls.every(call => call.path === '/api/floor-plans/summaries' && call.limit === '500')).toBe(true);
        expect(api.calls.map(call => call.nativeBuildingIds.split(',').length)).toEqual([200, 200, 50]);
        const before = api.calls.length;
        expect((await reader.fetchFloorModelMarkers([identity(A4), identity('900001')])).get(A4)).toEqual({ storeys: [2, 6], units: 4 });
        expect(api.calls.length).toBe(before);
        // Unregistered plans cannot be drawn and do not mark a building.
        const unregistered = fakePublication({ [A4]: fixture().map(plan => ({ ...plan, registration: null })) });
        const other = createFloorPlanPublicationReader(config, { fetch: unregistered.fetch, cache: new Map(), log: silent });
        expect((await other.fetchFloorModelMarkers([identity(A4)])).size).toBe(0);
    });

    it("reads one building's full plans on demand, following pages, and caches the model", async () => {
        // 230 copies of A4's plans under one id: three pages of 100.
        const many = Array.from({ length: 230 }, (_, i) => ({ ...fixture()[i % 5], id: `plan-${String(i).padStart(3, '0')}` }));
        const api = fakePublication({ [A4]: many });
        const reader = createFloorPlanPublicationReader(config, { fetch: api.fetch, cache: new Map(), log: silent });
        const rows = await reader.fetchFloorModels([identity(A4)]);
        expect(rows.get(A4).floorPlans.storeys.map(storey => storey.level)).toEqual([2, 6]);
        expect(rows.get(A4).publication).toMatchObject({ baseUrl: 'https://publication.test/api', city: 'zagreb', source: 'zagreb-3d', buildingId: A4 });
        expect(api.calls.map(call => [call.path, call.nativeBuildingId, call.offset, call.limit])).toEqual([
            ['/api/floor-plans', A4, '0', '100'], ['/api/floor-plans', A4, '100', '100'], ['/api/floor-plans', A4, '200', '100']]);
        expect((await reader.fetchFloorModels([identity(A4)])).get(A4)).toBe(rows.get(A4));
        expect(api.calls).toHaveLength(3);
    });

    it('degrades a failed read to no published plans, logs it, and does not cache it', async () => {
        const logs = [];
        const api = fakePublication({ [A4]: fixture() }, { fail: ids => ids.includes(A4) });
        const reader = createFloorPlanPublicationReader(config, { fetch: api.fetch, cache: new Map(), log: line => logs.push(line) });
        const report = {};
        expect((await reader.fetchFloorModelMarkers([identity(A4)], report)).size).toBe(0);
        expect(report.publishedUnavailable).toBe(true);
        expect(logs.join('\n')).toMatch(/1 buildings without published plans: connect ECONNREFUSED/);
        await reader.fetchFloorModelMarkers([identity(A4)]);
        expect(api.calls).toHaveLength(2);
    });

    it("translates the app's native ids into the publication's and answers under the native id", async () => {
        const api = fakePublication({ 'way/77': belongTo('way/77', 'osm') });
        const reader = createFloorPlanPublicationReader({ ...config, source: 'osm', buildingSource: 'osm-3d',
            buildingIds: [{ match: '^w(\\d+)$', ref: 'way/$1' }] }, { fetch: api.fetch, cache: new Map(), log: silent });
        const osm = id => ({ city: 'zagreb', source: 'osm-3d', ownerId: '', buildingId: id });
        const marks = await reader.fetchFloorModelMarkers([osm('w77'), osm('n5'), identity('w77')]);
        expect([...marks.keys()]).toEqual(['w77']);
        expect(api.calls.map(call => call.nativeBuildingId)).toEqual(['way/77']);
    });

    it('takes no URL from a city configuration and refuses unknown settings', async () => {
        const city = entry => [{ id: 'city_a', floorModels: { namespace: 'city_a', published: [{ adapter: 'floor-plan-publication', ...entry }] } }];
        const pool = { query: async () => ({ rows: [] }) };
        for (const entry of [{ ...config, baseUrl: 'http://metadata.internal/' }, { city: 'a', source: 'b', buildingSource: 'c', idField: 'x' }]) {
            const report = {};
            const published = createPublishedFloorModels({ fetch: async () => { throw new Error('must not fetch'); }, cityConfigs: city(entry), env: {} });
            const [building] = await attachNearbyFloorModelMarkers(pool, 'city_a', 'c', [{ object_id: '1' }], { published, report });
            expect(building).toEqual({ object_id: '1' });
            expect(report.publishedUnavailable).toBe(true);
        }
    });
});

describe('authored models and published plans together', () => {
    it("declares Zagreb's survey, cadastre and OSM buildings and no source for a city without one", () => {
        const configs = readCityConfigs();
        const zagreb = configs.find(city => city.id === 'zagreb');
        expect(zagreb.floorModels.published.map(entry => [entry.adapter, entry.buildingSource, entry.source])).toEqual([
            ['floor-plan-publication', 'zagreb-3d', 'zagreb-3d'], ['floor-plan-publication', 'dgu-3d', 'dgu-building'], ['floor-plan-publication', 'osm-3d', 'osm']]);
        const published = createPublishedFloorModels({ cityConfigs: configs, env: {} });
        expect(published.sources('zagreb').map(source => source.config.baseUrl)).toEqual(Array(3).fill('https://zagreb.lol/api'));
        expect(published.sources('new_york')).toEqual([]);
    });

    it('marks an authored model as the registry, asks the publication only for the rest, and serves the authored model first', async () => {
        const authored = { schema: 'authored' };
        const pool = { query: async sql => ({ rows: [sql.includes('AS levels')
            ? { city: 'zagreb', source: 'zagreb-3d', owner_id: '', building_id: 'b1', version: 3, levels: [0, 1], units: 2 }
            : { city: 'zagreb', source: 'zagreb-3d', owner_id: '', building_id: 'b1', version: 3, floor_plans: authored, footprint: null }] }) };
        const api = fakePublication({ b1: belongTo('b1'), b2: belongTo('b2') });
        const published = createPublishedFloorModels({ fetch: api.fetch, cache: new Map(), cityConfigs: readCityConfigs(), env: { FLOOR_PLAN_PUBLICATION_API_URL: 'https://publication.test/api' } });
        const [b1, b2, b3] = await attachNearbyFloorModelMarkers(pool, 'zagreb', 'zagreb-3d', [{ object_id: 'b1' }, { object_id: 'b2' }, { object_id: 'b3' }], { published });
        expect(b1.floorPlansAvailable).toEqual({ origin: 'registry', city: 'zagreb', source: 'zagreb-3d', storeys: [0, 1], units: 2 });
        expect(b2.floorPlansAvailable).toEqual({ origin: 'publication', city: 'zagreb', source: 'zagreb-3d', storeys: [2, 6], units: 4 });
        expect(b3).toEqual({ object_id: 'b3' });
        for (const building of [b1, b2]) expect(building.floorPlans).toBeUndefined();
        expect(api.calls.map(call => [call.path, call.nativeBuildingIds])).toEqual([['/api/floor-plans/summaries', 'b2,b3']]);
        expect(await readNativeFloorModel(pool, identity('b1'), { published })).toMatchObject({ origin: 'registry', version: 3, floorPlans: authored });
        expect(api.calls).toHaveLength(1);
        const empty = { query: async () => ({ rows: [] }) };
        const b2Model = await readNativeFloorModel(empty, identity('b2'), { published });
        expect(b2Model).toMatchObject({ origin: 'publication', buildingId: 'b2', version: null });
        expect(validateFloorPlans(b2Model.floorPlans)).toEqual([]);
        expect(await readNativeFloorModel(empty, identity('b3'), { published })).toBeNull();
    });
});

describe('cells mark buildings; one building is read on demand', () => {
    const cell = [15.968, 45.764, 15.977, 45.769];
    const mesh = id => ({ object_id: Number(id), z_min: 120, z_max: 149.5, faces: [] });

    it('answers a cell with a small marker and no plans, and does not cache an unanswered publication', async () => {
        const pool = createMockPool();
        let down = false;
        const api = fakePublication({ [A4]: fixture() }, { fail: () => down });
        const published = createPublishedFloorModels({ fetch: api.fetch, cache: new Map(), cityConfigs: readCityConfigs(), env: {}, log: silent });
        const app = createRouteApp(setupBuildingsRoute, pool, { publishedFloorModels: published });
        pool.setResults([{ rows: [mesh(A4), mesh('148971')] }, { rows: [] }]);
        const res = await request(app).post('/buildings/cell').send({ kind: 'near', bbox: cell, source: 'gdi-3d', floorModelNamespace: 'zagreb' });
        expect(res.status).toBe(200);
        const [a4, a3] = res.body.items;
        expect(a4.floorPlansAvailable).toEqual({ origin: 'publication', city: 'zagreb', source: 'zagreb-3d', storeys: [2, 6], units: 4 });
        expect(a4.floorPlans).toBeUndefined();
        expect(a3).toEqual(mesh('148971'));
        expect(JSON.stringify(a4.floorPlansAvailable).length).toBeLessThan(200);
        const answer = JSON.stringify(res.body);
        expect(answer).not.toMatch(/architecture|registration|walls/);
        expect(answer.length).toBeLessThan(1000);
        expect(api.calls).toEqual([expect.objectContaining({ path: '/api/floor-plans/summaries', city: 'zagreb', source: 'zagreb-3d', nativeBuildingIds: `${A4},148971` })]);

        // Another cell while the publication is down: buildings answer without marks, and the answer is not kept.
        down = true;
        const other = [15.978, 45.764, 15.987, 45.769];
        pool.setResults([{ rows: [mesh('5')] }, { rows: [] }]);
        const failed = await request(app).post('/buildings/cell').send({ kind: 'near', bbox: other, source: 'gdi-3d', floorModelNamespace: 'zagreb' });
        expect(failed.status).toBe(200);
        expect(failed.body.items).toEqual([mesh('5')]);
        down = false;
        pool.setResults([{ rows: [mesh('5')] }, { rows: [] }]);
        const queries = pool.getCalls().length;
        await request(app).post('/buildings/cell').send({ kind: 'near', bbox: other, source: 'gdi-3d', floorModelNamespace: 'zagreb' });
        expect(pool.getCalls().length).toBeGreaterThan(queries);
    });

    it('serves the marked building its model, absence as null, and an unanswered publication as 503', async () => {
        let down = false;
        const api = fakePublication({ [A4]: fixture() }, { fail: () => down });
        const published = createPublishedFloorModels({ fetch: api.fetch, cache: new Map(), cityConfigs: readCityConfigs(), env: {}, log: silent });
        const app = createRouteApp(setupBuildingFloorModelsRoute, { query: async () => ({ rows: [] }) }, { publishedFloorModels: published });
        const found = await request(app).get(`/buildings/floor-model?city=zagreb&source=zagreb-3d&buildingId=${A4}`);
        expect(found.status).toBe(200);
        expect(found.body.model).toMatchObject({ origin: 'publication', city: 'zagreb', source: 'zagreb-3d', buildingId: A4, version: null });
        expect(found.body.model.footprint.type).toBe('MultiPolygon');
        expect(validateFloorPlans(found.body.model.floorPlans)).toEqual([]);
        expect(found.body.model.floorPlans.storeys.map(storey => storey.level)).toEqual([2, 6]);
        expect((await request(app).get('/buildings/floor-model?city=zagreb&source=zagreb-3d&buildingId=1')).body).toEqual({ model: null });
        down = true;
        expect((await request(app).get('/buildings/floor-model?city=zagreb&source=zagreb-3d&buildingId=2')).status).toBe(503);
    });
});
