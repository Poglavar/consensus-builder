// The strict land rule on the server, generalised (PARCEL-OPTIONAL.md): cadastreParcelIds must EQUAL
// the PostGIS binding of the proposal's site — missing and extra parcels are refused separately; an
// empty declaration is allowed for a material proposal with a site; parcel acts still need parcels.
// Covers the shared footprint builder, checkProposalBinding against a scripted cadastre, the free
// POST /proposals, the paid /agent/proposals (refusal before any payment) and POST /proposals/binding.
// The SQL itself is run against a real database in proposal-binding-db.test.js (RUN_DB_TESTS=1).
import { beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { generateKeyPairSigner } from '@solana/kit';
import { createMockPool } from './helpers/mock-pool.js';
import { validProposalBody, insertResult, updateResult } from './helpers/fixtures.js';
import {
    MAX_FOOTPRINT_VERTICES,
    footprintParts,
    footprintQueryParams,
    proposalGeometryView
} from '../proposals/footprint.js';
import {
    BINDING_COUNT_SQL,
    BINDING_SQL,
    FOOTPRINT_OUTSIDE_SITE_SQL,
    INTRUSION_NOISE_M,
    MAX_BINDING_PARCELS,
    MAX_SITE_VERTICES,
    PARCEL_ACT_SITE_SQL,
    checkProposalBinding,
    computeBinding,
    parseHrParcelId,
    parseTolerance,
    validateSiteGeometry
} from '../proposals/binding.js';
import { setupProposalsRoute } from '../routes/proposals.js';
import { setupProposalBindingRoute } from '../routes/proposal-binding.js';
import { setupAgentProposalsRoute, AGENT_PROPOSALS_PATH } from '../routes/agent-proposals.js';
import { READ_ONLY_POST_PATHS } from '../index.js';

vi.mock('../thumbnails/proposal-thumbnail.js', () => ({
    generateAndStoreProposalThumbnail: vi.fn(async () => null)
}));

const box = (w, s, e, n) => ({ type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] });
const PARK = box(15.97, 45.80, 15.971, 45.801);
const SITE = box(15.969, 45.799, 15.972, 45.802);
const SITE_JSON = JSON.stringify({ type: 'MultiPolygon', coordinates: [SITE.coordinates] });

describe('footprintParts (shared by browser, API and migration)', () => {
    it('takes each typology\'s authored geometry', () => {
        expect(footprintParts({ structureProposal: { geometry: PARK } }).sources).toEqual(['structureProposal.geometry']);
        expect(footprintParts({ geometry: { buildings: [{ type: 'Feature', properties: {}, geometry: PARK }] } }).sources)
            .toEqual(['geometry.buildings']);
        expect(footprintParts({ roadProposal: { definition: { polygon: PARK } } }).sources)
            .toEqual(['roadProposal.definition.polygon']);
        const plan = footprintParts({
            reparcellization: { polygons: [{ geometry: PARK }, { geometry: box(15.971, 45.80, 15.972, 45.801) }] },
            geometry: box(0, 0, 1, 1)
        });
        // A readjustment's polygons are its footprint; proposal.geometry on it is ignored.
        expect(plan.polygons).toHaveLength(2);
        expect(plan.sources).toEqual(['reparcellization.polygons']);
        expect(plan.approximate).toBe(false);
    });

    it('marks a road stored without its corridor polygon as an approximate centreline footprint', () => {
        const parts = footprintParts({ roadProposal: { definition: {
            width: 12,
            points: [{ lat: 45.8, lng: 15.97 }, { lat: 45.801, lng: 15.971 }]
        } } });
        expect(parts.approximate).toBe(true);
        expect(parts.polygons).toEqual([]);
        expect(parts.centerline.halfWidthM).toBe(6);
        expect(parts.centerline.segments).toEqual([[[15.97, 45.8], [15.971, 45.801]]]);
        const [, lines] = footprintQueryParams(parts);
        expect(JSON.parse(lines)).toEqual([{ line: { type: 'LineString', coordinates: [[15.97, 45.8], [15.971, 45.801]] }, halfWidthM: 6 }]);
    });

    it('reports malformed coordinates and over-large footprints instead of passing them to PostGIS', () => {
        expect(footprintParts({ structureProposal: { geometry: { type: 'Polygon', coordinates: [[[1, 2], [3, 'x']]] } } }).invalid)
            .toMatch(/structureProposal.geometry is not a valid/);
        const ring = Array.from({ length: MAX_FOOTPRINT_VERTICES + 1 }, (_, i) => [15 + i * 1e-7, 45]);
        ring.push(ring[0]);
        expect(footprintParts({ structureProposal: { geometry: { type: 'Polygon', coordinates: [ring] } } }).invalid)
            .toMatch(/vertices \(limit/);
    });

    it('reads sub-proposals from their columns first, like the serializer', () => {
        const view = proposalGeometryView({
            structure_proposal: { geometry: PARK },
            proposal_data: { structureProposal: { geometry: box(0, 0, 1, 1) }, title: 'x' }
        });
        expect(view.structureProposal.geometry).toBe(PARK);
        expect(view.title).toBe('x');
    });
});


// A scripted cadastre: answers the binding statements by identity and records them.
function cadastre({ count = 2, parcels = [], inRegion = true, unsurveyedM2 = 0, unknownM2 = 0, outsideM2 = 0, found = null } = {}) {
    const calls = [];
    return {
        calls,
        async query(sql, params) {
            calls.push({ sql, params });
            if (sql === BINDING_COUNT_SQL) return { rows: [{ parcels: count }] };
            if (sql === FOOTPRINT_OUTSIDE_SITE_SQL) return { rows: [{ outside_m2: outsideM2 }] };
            if (sql === BINDING_SQL) {
                return { rows: [{ parcels, site_m2: 9000, in_region: inRegion, unsurveyed_m2: unsurveyedM2, unknown_m2: unknownM2, site_geojson: SITE_JSON }] };
            }
            if (sql === PARCEL_ACT_SITE_SQL) {
                const ids = JSON.parse(params[0]).map(entry => entry.id).filter(id => !found || found.includes(id));
                return { rows: [{ parcels: ids.map(id => ({ parcelId: id, overlapM2: 400 })), site_geojson: ids.length ? SITE_JSON : null, site_m2: 400 * ids.length }] };
            }
            throw new Error(`unexpected SQL: ${sql.slice(0, 60)}`);
        }
    };
}
const hit = (parcelId, intrusionM, bound = true, overlapM2 = 50) => ({ parcelId, overlapM2, intrusionM, bound });
const SPILL = [hit('HR-335649-100', 40.2), hit('HR-335649-101', 0.42), hit('HR-335649-102', 0.0004, false, 0.01)];

describe('site and tolerance validation', () => {
    it('accepts a WGS84 Polygon/MultiPolygon and refuses everything else with a reason', () => {
        expect(validateSiteGeometry(PARK)).toBeNull();
        expect(validateSiteGeometry({ type: 'Feature', geometry: PARK })).toBeNull();
        expect(validateSiteGeometry({ type: 'LineString', coordinates: [[0, 0], [1, 1]] })).toMatch(/Polygon or MultiPolygon/);
        expect(validateSiteGeometry({ type: 'Polygon', coordinates: [[[0, 0], [1, 1], [0, 0]]] })).toMatch(/at least 4/);
        expect(validateSiteGeometry(box(200, 0, 201, 1))).toMatch(/out of WGS84 range/);
        expect(validateSiteGeometry({ type: 'Polygon', coordinates: [[[0, 0], [1, 'x'], [1, 1], [0, 0]]] })).toMatch(/finite/);
        expect(validateSiteGeometry(box(15, 45, 16, 46))).toMatch(/exceeds 500 km²/);
        const ring = Array.from({ length: MAX_SITE_VERTICES + 1 }, (_, i) => [15 + i * 1e-8, 45 + (i % 2) * 1e-8]);
        ring.push(ring[0]);
        expect(validateSiteGeometry({ type: 'Polygon', coordinates: [ring] })).toMatch(/vertices/);
    });

    it('takes a tolerance of 0..1 m, default 0', () => {
        expect(parseTolerance(undefined)).toEqual({ ok: true, value: 0 });
        expect(parseTolerance(0.05)).toEqual({ ok: true, value: 0.05 });
        expect(parseTolerance(-1).ok).toBe(false);
        expect(parseTolerance(1.5).ok).toBe(false);
        expect(parseTolerance('0.1').ok).toBe(false);
    });

    it('parses only HR cadastral ids', () => {
        expect(parseHrParcelId('HR-335649-1021/3')).toEqual({ id: 'HR-335649-1021/3', ko: 335649, number: '1021/3' });
        expect(parseHrParcelId('BG-1-2')).toBeNull();
    });
});

describe('computeBinding', () => {
    it('splits bound from touched, passes the linear floor to SQL and measures coverage', async () => {
        const db = cadastre({ parcels: SPILL });
        const { binding, site } = await computeBinding(db, { site: SITE, toleranceM: 0 });
        expect(db.calls.map(call => call.sql)).toEqual([BINDING_COUNT_SQL, BINDING_SQL]);
        expect(db.calls[1].params[2]).toBe(INTRUSION_NOISE_M); // max(0, noise)
        expect(binding.parcels.map(p => p.parcelId)).toEqual(['HR-335649-100', 'HR-335649-101']);
        expect(binding.touched.map(p => p.parcelId)).toEqual(['HR-335649-102']);
        expect(binding).toMatchObject({ coverage: 'complete', toleranceM: 0, source: 'server:hr-cadastre' });
        expect(site.type).toBe('MultiPolygon');

        const atTol = cadastre({ parcels: SPILL });
        await computeBinding(atTol, { site: SITE, toleranceM: 0.05 });
        expect(atTol.calls[1].params[2]).toBe(0.05);
    });

    it('is partial when open ground (or ground outside the cadastre) survives the floor', async () => {
        expect((await computeBinding(cadastre({ parcels: SPILL, unsurveyedM2: 12.5 }), { site: SITE })).binding)
            .toMatchObject({ coverage: 'partial', unsurveyedM2: 12.5, unknownM2: 0 });
        expect((await computeBinding(cadastre({ parcels: SPILL, unknownM2: 3 }), { site: SITE })).binding)
            .toMatchObject({ coverage: 'partial', unknownM2: 3 });
        // Surveyed region, nothing under the site: partial and all of it unsurveyed.
        expect((await computeBinding(cadastre({ parcels: [], unsurveyedM2: 9000 }), { site: SITE })).binding)
            .toMatchObject({ coverage: 'partial', parcels: [], unsurveyedM2: 9000 });
    });

    it('says unknown outside the cadastre it holds, and none only for a city with no cadastre', async () => {
        const unknown = (await computeBinding(cadastre({ inRegion: false }), { site: SITE, city: 'unconfigured_city' })).binding;
        expect(unknown).toMatchObject({ coverage: 'unknown', parcels: [], unknownM2: 9000, unsurveyedM2: 0 });
        expect(unknown.reason).toMatch(/cannot be bound/);
        const none = (await computeBinding(cadastre({ inRegion: false }), { site: SITE, city: 'explore' })).binding;
        expect(none).toMatchObject({ coverage: 'none', parcels: [], unsurveyedM2: 9000 });
    });

    it('refuses a site over the parcel cap before the expensive statement', async () => {
        const db = cadastre({ count: MAX_BINDING_PARCELS + 1 });
        await expect(computeBinding(db, { site: SITE })).rejects.toMatchObject({ code: 'too-many-parcels', status: 413 });
        expect(db.calls.map(call => call.sql)).toEqual([BINDING_COUNT_SQL]);
    });
});

describe('checkProposalBinding (declared == binding)', () => {
    const park = { goal: 'park', structureProposal: { kind: 'park', geometry: PARK } };

    it('accepts exactly the bound parcels, in any order', async () => {
        const result = await checkProposalBinding(cadastre({ parcels: SPILL }), park, ['HR-335649-101', 'HR-335649-100']);
        expect(result.ok).toBe(true);
        expect(result.binding.parcels).toHaveLength(2);
    });

    it('refuses bound parcels missing from the declaration (undeclared-parcels) with their intrusion', async () => {
        const result = await checkProposalBinding(cadastre({ parcels: SPILL }), park, ['HR-335649-100']);
        expect(result).toMatchObject({ ok: false, status: 400, code: 'undeclared-parcels', extra: [] });
        expect(result.missing).toEqual([{ id: 'HR-335649-101', overlapM2: 50, intrusionM: 0.42 }]);
        expect(result.parcels).toEqual([{ id: 'HR-335649-101', overlapM2: 50 }]);
        expect(result.error).toMatch(/reaches into 1 parcel/);
    });

    it('refuses declared parcels the site does not bind (unbound-parcels), naming how far it reaches', async () => {
        const result = await checkProposalBinding(cadastre({ parcels: SPILL }), park,
            ['HR-335649-100', 'HR-335649-101', 'HR-335649-102', 'HR-335649-999']);
        expect(result).toMatchObject({ ok: false, code: 'unbound-parcels', missing: [] });
        expect(result.extra).toEqual([{ id: 'HR-335649-102', intrusionM: 0.0004 }, { id: 'HR-335649-999', intrusionM: 0 }]);
    });

    it('reports both directions at once, missing first', async () => {
        const result = await checkProposalBinding(cadastre({ parcels: SPILL }), park, ['HR-335649-100', 'HR-335649-999']);
        expect(result.code).toBe('undeclared-parcels');
        expect(result.missing.map(m => m.id)).toEqual(['HR-335649-101']);
        expect(result.extra.map(m => m.id)).toEqual(['HR-335649-999']);
    });

    it('binds an authored site (not the footprint) and requires the footprint inside it', async () => {
        const db = cadastre({ parcels: SPILL });
        const ok = await checkProposalBinding(db, park, ['HR-335649-100', 'HR-335649-101'], { site: SITE });
        expect(ok.ok).toBe(true);
        expect(ok.site).toEqual({ type: 'MultiPolygon', coordinates: [SITE.coordinates] });
        expect(db.calls.map(call => call.sql)).toEqual([FOOTPRINT_OUTSIDE_SITE_SQL, BINDING_COUNT_SQL, BINDING_SQL]);
        expect(JSON.parse(db.calls[1].params[0])).toEqual([{ type: 'MultiPolygon', coordinates: [SITE.coordinates] }]);

        const outside = await checkProposalBinding(cadastre({ parcels: SPILL, outsideM2: 37.2 }), park, ['HR-335649-100'], { site: SITE });
        expect(outside).toMatchObject({ ok: false, code: 'footprint-outside-site' });
    });

    it('lets a material proposal on unsurveyed ground have an empty declaration', async () => {
        const result = await checkProposalBinding(cadastre({ parcels: [], unsurveyedM2: 9000 }), { goal: 'buildings' }, [], { site: SITE });
        expect(result.ok).toBe(true);
        expect(result.binding).toMatchObject({ coverage: 'partial', parcels: [] });
    });

    it('keeps the declaration unverified where the server holds no cadastre', async () => {
        const result = await checkProposalBinding(cadastre({ inRegion: false }), park, ['BG-77-1']);
        expect(result.ok).toBe(true);
        expect(result.binding).toMatchObject({ coverage: 'unknown', subject: 'declared-unverified', parcels: [{ parcelId: 'BG-77-1' }] });
    });

    it('still needs parcels for acts on parcels', async () => {
        const db = cadastre({ parcels: [] });
        expect(await checkProposalBinding(db, { goal: 'ownership-transfer' }, [])).toMatchObject({ ok: false, code: 'parcels-required' });
        expect(db.calls).toHaveLength(0);
        // A designation whose polygon lies on no parcel.
        const designation = { goal: 'road-track', roadProposal: { definition: { polygon: PARK, centerline: [] } } };
        expect(await checkProposalBinding(cadastre({ parcels: [], unsurveyedM2: 10 }), designation, ['HR-335649-100']))
            .toMatchObject({ ok: false, code: 'parcels-required' });
    });

    it('binds a parcel act without geometry to its declared parcels and refuses ids that are not current parcels', async () => {
        const ok = await checkProposalBinding(cadastre(), { goal: 'ownership-transfer' }, ['HR-335649-100']);
        expect(ok).toMatchObject({ ok: true, binding: { coverage: 'complete', subject: 'declared-parcels', parcels: [{ parcelId: 'HR-335649-100' }] } });
        const unknown = await checkProposalBinding(cadastre({ found: ['HR-335649-100'] }), { goal: 'offer' }, ['HR-335649-100', 'HR-335649-404']);
        expect(unknown).toMatchObject({ ok: false, code: 'unbound-parcels', extra: [{ id: 'HR-335649-404' }] });
    });

    it('refuses invalid geometry without querying', async () => {
        const db = cadastre();
        const invalid = await checkProposalBinding(db, { structureProposal: { geometry: { type: 'Polygon', coordinates: 'x' } } }, ['HR-1-1']);
        expect(invalid).toMatchObject({ ok: false, code: 'invalid-footprint' });
        expect(db.calls).toHaveLength(0);
    });
});

// The route pool: binding statements from the scripted cadastre, everything else queued.
function routePool(cadastreOptions) {
    const pool = createMockPool();
    const scripted = cadastre(cadastreOptions);
    pool.bindingAnswer = (sql, params) => ([BINDING_COUNT_SQL, BINDING_SQL, FOOTPRINT_OUTSIDE_SITE_SQL, PARCEL_ACT_SITE_SQL].includes(sql)
        ? null : undefined);
    const queued = pool.query.bind(pool);
    pool.bindingQueries = 0;
    pool.query = async (sql, params) => {
        if ([BINDING_COUNT_SQL, BINDING_SQL, FOOTPRINT_OUTSIDE_SITE_SQL, PARCEL_ACT_SITE_SQL].includes(sql)) {
            pool.bindingQueries += 1;
            return scripted.query(sql, params);
        }
        return queued(sql, params);
    };
    pool.bindingAnswer = null;
    pool.connect = async () => ({ query: pool.query, release() {}, on() {}, off() {} });
    return pool;
}

const parkBody = (overrides = {}) => validProposalBody({
    type: 'structure',
    goal: 'park',
    cadastreParcelIds: ['HR-335649-100'],
    structureProposal: { kind: 'park', geometry: PARK },
    ...overrides
});

function freeApp(pool) {
    const app = express();
    app.use(express.json({ limit: '15mb' }));
    setupProposalBindingRoute(app, pool);
    setupProposalsRoute(app, pool);
    return app;
}

describe('POST /proposals — declaration must equal the binding', () => {
    it('answers 400 undeclared-parcels with missing/extra and writes nothing', async () => {
        const pool = routePool({ parcels: SPILL });
        const res = await request(freeApp(pool)).post('/proposals').send(parkBody());
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('undeclared-parcels');
        expect(res.body.missing).toEqual([{ id: 'HR-335649-101', overlapM2: 50, intrusionM: 0.42 }]);
        expect(res.body.extra).toEqual([]);
        expect(pool.getCalls().some(call => /INSERT INTO proposal/.test(call.sql))).toBe(false);
    });

    it('answers 400 unbound-parcels for a declared parcel the site does not reach', async () => {
        const pool = routePool({ parcels: SPILL });
        const res = await request(freeApp(pool)).post('/proposals')
            .send(parkBody({ cadastreParcelIds: ['HR-335649-100', 'HR-335649-101', 'HR-335649-7'] }));
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('unbound-parcels');
        expect(res.body.extra).toEqual([{ id: 'HR-335649-7', intrusionM: 0 }]);
    });

    it('stores the server site and binding (a client binding is ignored) when the declaration matches', async () => {
        const pool = routePool({ parcels: SPILL });
        pool.setResults([insertResult(), updateResult()]);
        const res = await request(freeApp(pool)).post('/proposals')
            .send(parkBody({ cadastreParcelIds: ['HR-335649-100', 'HR-335649-101'], binding: { parcels: [], coverage: 'complete' }, toleranceM: 0 }));
        expect(res.status).toBe(201);
        expect(pool.bindingQueries).toBe(2);
        const insert = pool.getCalls().find(call => /INSERT INTO proposal/.test(call.sql));
        expect(insert.sql).toMatch(/site, binding/);
        const [site, binding] = insert.params.slice(39);
        expect(JSON.parse(site).type).toBe('MultiPolygon');
        expect(JSON.parse(binding).parcels.map(p => p.parcelId)).toEqual(['HR-335649-100', 'HR-335649-101']);
        const data = JSON.parse(insert.params[32]);
        expect(data.binding).toEqual(JSON.parse(binding));
        expect(data.site).toEqual(JSON.parse(site));
        expect(data).not.toHaveProperty('toleranceM');
    });

    it('binds geometry the body validator does not know about (a building proposal\'s own footprint)', async () => {
        const pool = routePool({ parcels: SPILL });
        const body = validProposalBody({
            type: 'building',
            goal: 'buildings',
            cadastreParcelIds: ['HR-335649-100'],
            geometry: { buildings: [{ type: 'Feature', properties: {}, geometry: PARK }] }
        });
        const res = await request(freeApp(pool)).post('/proposals').send(body);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('undeclared-parcels');
        expect(pool.bindingQueries).toBe(2);
    });

    it('stores a material proposal on unsurveyed ground with an empty declaration', async () => {
        const pool = routePool({ parcels: [], unsurveyedM2: 9000 });
        pool.setResults([insertResult(), updateResult()]);
        const res = await request(freeApp(pool)).post('/proposals')
            .send(parkBody({ cadastreParcelIds: [], site: SITE }));
        expect(res.status).toBe(201);
        const insert = pool.getCalls().find(call => /INSERT INTO proposal/.test(call.sql));
        expect(insert.params[21]).toBe('[]');
        expect(JSON.parse(insert.params[32]).cadastreParcelIds).toEqual([]);
        expect(JSON.parse(insert.params[40])).toMatchObject({ coverage: 'partial', unsurveyedM2: 9000 });
        // Omitting the field entirely is the same empty declaration.
        const pool2 = routePool({ parcels: [], unsurveyedM2: 9000 });
        pool2.setResults([insertResult(), updateResult()]);
        const body = parkBody({ site: SITE });
        delete body.cadastreParcelIds;
        expect((await request(freeApp(pool2)).post('/proposals').send(body)).status).toBe(201);
    });

    it('refuses an empty declaration for a parcel act, and one with no ground at all, before any SQL', async () => {
        const pool = routePool({ parcels: [] });
        const transfer = await request(freeApp(pool)).post('/proposals')
            .send(validProposalBody({ goal: 'ownership-transfer', cadastreParcelIds: [], site: SITE }));
        expect(transfer.body).toMatchObject({ code: 'parcels-required' });
        expect(transfer.status).toBe(400);
        expect(transfer.body.code).toBe('parcels-required');
        const nothing = await request(freeApp(pool)).post('/proposals').send(validProposalBody({ goal: 'park', cadastreParcelIds: [] }));
        expect(nothing.status).toBe(400);
        expect(nothing.body.code).toBe('parcels-required');
        expect(pool.bindingQueries).toBe(0);
    });

    it('refuses a malformed site or tolerance with a stable code', async () => {
        const pool = routePool({});
        const badSite = await request(freeApp(pool)).post('/proposals').send(parkBody({ site: { type: 'Point', coordinates: [1, 2] } }));
        expect(badSite.status).toBe(400);
        expect(badSite.body.code).toBe('invalid-site');
        const badTolerance = await request(freeApp(pool)).post('/proposals').send(parkBody({ toleranceM: 3 }));
        expect(badTolerance.status).toBe(400);
        expect(pool.bindingQueries).toBe(0);
    });
});

describe('POST /proposals/binding', () => {
    it('answers the binding of a site, on both paths', async () => {
        for (const path of ['/proposals/binding', '/agent/binding']) {
            const pool = routePool({ parcels: SPILL, unsurveyedM2: 4 });
            const res = await request(freeApp(pool)).post(path).send({ site: SITE, toleranceM: 0.01 });
            expect(res.status, path).toBe(200);
            expect(res.body.binding).toMatchObject({ coverage: 'partial', toleranceM: 0.01, unsurveyedM2: 4 });
            expect(res.body.binding.parcels.map(p => p.parcelId)).toEqual(['HR-335649-100', 'HR-335649-101']);
        }
    });

    it('validates before any SQL and refuses an over-cap site with 413', async () => {
        const pool = routePool({});
        const app = freeApp(pool);
        expect((await request(app).post('/proposals/binding').send({})).body.code).toBe('invalid-site');
        expect((await request(app).post('/proposals/binding').send({ site: SITE, toleranceM: -1 })).body.code).toBe('invalid-tolerance');
        expect((await request(app).post('/proposals/binding').send({ site: SITE, city: 42 })).status).toBe(400);
        expect(pool.bindingQueries).toBe(0);
        const big = await request(freeApp(routePool({ count: MAX_BINDING_PARCELS + 1 }))).post('/proposals/binding').send({ site: SITE });
        expect(big.status).toBe(413);
        expect(big.body.code).toBe('too-many-parcels');
    });

    it('is a read: exempt from the Origin gate and the write limiter', () => {
        expect(READ_ONLY_POST_PATHS.has('/proposals/binding')).toBe(true);
    });

    it('answers 500 (not a fake empty binding) when the cadastre query fails', async () => {
        const pool = routePool({});
        pool.query = async () => { throw new Error('db down'); };
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        const res = await request(freeApp(pool)).post('/proposals/binding').send({ site: SITE });
        error.mockRestore();
        expect(res.status).toBe(500);
        expect(res.body.binding).toBeUndefined();
    });
});

describe(`POST ${AGENT_PROPOSALS_PATH} — binding precheck`, () => {
    let env;
    beforeAll(async () => {
        const treasury = await generateKeyPairSigner();
        env = {
            X402_NETWORK: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
            X402_FACILITATOR_URL: 'https://facilitator.test',
            X402_PAY_TO: treasury.address,
            X402_PRICE_PROPOSAL: '$0.05'
        };
    });

    function paidApp(pool, facilitator) {
        const app = express();
        app.use(express.json({ limit: '15mb' }));
        setupProposalsRoute(app, pool);
        setupAgentProposalsRoute(app, pool, { env, facilitatorClient: facilitator });
        return app;
    }
    const fakeFacilitator = () => ({ getSupported: vi.fn(async () => ({ kinds: [], extensions: [], signers: {} })), verify: vi.fn(), settle: vi.fn() });

    it('refuses a mismatched declaration with 400 before the payment challenge and never settles', async () => {
        const facilitator = fakeFacilitator();
        const pool = routePool({ parcels: SPILL });
        const body = parkBody();
        delete body.author;
        const unpaid = await request(paidApp(pool, facilitator)).post(AGENT_PROPOSALS_PATH).send(body);
        expect(unpaid.status).toBe(400);
        expect(unpaid.body.code).toBe('undeclared-parcels');
        expect(unpaid.headers['payment-required']).toBeUndefined();

        const paid = await request(paidApp(pool, facilitator)).post(AGENT_PROPOSALS_PATH)
            .set('PAYMENT-SIGNATURE', 'anything').send(body);
        expect(paid.status).toBe(400);
        expect(facilitator.settle).not.toHaveBeenCalled();
        expect(facilitator.verify).not.toHaveBeenCalled();
    });

    it('lets a matching declaration (or an empty one on open ground) through to the payment challenge', async () => {
        const pool = routePool({ parcels: SPILL });
        const body = parkBody({ cadastreParcelIds: ['HR-335649-100', 'HR-335649-101'] });
        delete body.author;
        const res = await request(paidApp(pool, fakeFacilitator())).post(AGENT_PROPOSALS_PATH).send(body);
        // Past the precheck: the (unconfigured) payment gate answers, not a 400.
        expect(res.status).not.toBe(400);
        expect(pool.bindingQueries).toBe(2);

        const open = routePool({ parcels: [], unsurveyedM2: 9000 });
        const openBody = parkBody({ cadastreParcelIds: [], site: SITE });
        delete openBody.author;
        expect((await request(paidApp(open, fakeFacilitator())).post(AGENT_PROPOSALS_PATH).send(openBody)).status).not.toBe(400);
        expect(open.bindingQueries).toBe(3); // footprint-inside-site, count, binding
    });

    it('refuses with 503 (nothing charged) when the cadastre lookup fails', async () => {
        const facilitator = fakeFacilitator();
        const pool = routePool({});
        pool.query = async () => { throw new Error('db down'); };
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        const body = parkBody();
        delete body.author;
        const res = await request(paidApp(pool, facilitator)).post(AGENT_PROPOSALS_PATH).send(body);
        error.mockRestore();
        expect(res.status).toBe(503);
        expect(facilitator.settle).not.toHaveBeenCalled();
    });
});
