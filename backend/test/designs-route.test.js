// The design index (routes/designs.js, plan-design-agreement.md M2): POST /designs recomputes the CID,
// checks the design/v1 shape, derives the city and the binding from the site (checkProposalBinding
// over a scripted cadastre, nothing declared to compare), stores the content exactly as addressed and
// queues its thumbnail; the GET routes, the batch read and the binding preview read without writing.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createMockPool } from './helpers/mock-pool.js';
import { createContentApp } from './helpers/create-app.js';
import {
    PARK, SITE, SITE_MULTI, SPILL, box, cidOf, designContent, designRow, layoutContent, scriptedCadastre
} from './helpers/content-fixtures.js';
import { BINDING_COUNT_SQL, BINDING_SQL, FOOTPRINT_OUTSIDE_SITE_SQL, MAX_BINDING_PARCELS } from '../proposals/binding.js';
import { MAX_PINNED_OBJECT_BYTES } from '../storage/pinning.js';
import { MAX_DESIGN_LIST_LIMIT } from '../routes/designs.js';

const SELECT_ONE = /FROM consensus\.design WHERE cid = \$1/;
const SELECT_MANY = /FROM consensus\.design WHERE cid = ANY/;
const INSERT = /INSERT INTO consensus\.design/;

// The row an INSERT … RETURNING gives back for its parameters.
function insertedRow(params) {
    return {
        cid: params[0], city: params[1], goal: params[2], title: params[3], author: params[4],
        binding: JSON.parse(params[7]), content: JSON.parse(params[8]), origin_cid: params[9],
        screenshot_url: null, screenshot_before_url: null, screenshot_pair_url: null,
        created_at: new Date('2026-10-21T08:05:00.000Z')
    };
}

// A pool over a cadastre holding SPILL, an empty design index and inserts that succeed.
function indexPool({ cadastre = {}, existing = null } = {}) {
    const pool = createMockPool();
    pool.bindingAnswer = scriptedCadastre(cadastre);
    pool.answer(SELECT_ONE, { rows: existing ? [existing] : [] });
    pool.answer(INSERT, (sql, params) => ({ rows: [insertedRow(params)] }));
    return pool;
}

function appFor(pool, overrides = {}) {
    const thumbnailQueue = { enqueue: vi.fn() };
    return { app: createContentApp(pool, { thumbnailQueue, baseUrl: 'https://api.example', ...overrides }), thumbnailQueue };
}

const inserts = pool => pool.getCalls().filter(call => INSERT.test(call.sql));
const body = content => ({ cid: cidOf(content), content, parcelSourceId: 'oss-wfs' });

beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
});

describe('POST /designs', () => {
    it('indexes a design under its CID with the city and binding the server derives, and queues its thumbnail', async () => {
        const pool = indexPool();
        const { app, thumbnailQueue } = appFor(pool);
        // Metadata and source choice are both supplied explicitly by the consumer.
        const content = designContent({ city: 'new_york', origin: { cid: cidOf(designContent({ title: 'Original' })) } });
        const res = await request(app).post('/designs').send(body(content));

        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({ cid: cidOf(content), city: 'new_york', goal: 'park', title: 'Riverside park',
            author: 'Studio North', originCid: content.origin.cid, content, createdAt: '2026-10-21T08:05:00.000Z' });
        // The binding is derived from the site: the footprint inside it, then the parcels it takes.
        expect(pool.getBindingCalls().map(call => call.sql)).toEqual([FOOTPRINT_OUTSIDE_SITE_SQL, BINDING_COUNT_SQL, BINDING_SQL]);
        expect(res.body.binding.parcels.map(hit => hit.parcelId)).toEqual(['HR-335649-100', 'HR-335649-101']);
        expect(res.body.binding.touched.map(hit => hit.parcelId)).toEqual(['HR-335649-102']);
        expect(res.body.binding).toMatchObject({ coverage: 'complete', source: 'server:hr-cadastre' });

        const [insert] = inserts(pool);
        const params = insert.params;
        expect(params[0]).toBe(cidOf(content));
        expect(params[1]).toBe('new_york');
        expect(params.slice(2, 5)).toEqual(['park', 'Riverside park', 'Studio North']);
        expect(JSON.parse(params[5])).toEqual(SITE_MULTI);
        expect(JSON.parse(params[6])).toEqual({ west: 15.969, south: 45.799, east: 15.972, north: 45.802 });
        expect(JSON.parse(params[8])).toEqual(content);
        expect(params[9]).toBe(content.origin.cid);

        expect(thumbnailQueue.enqueue).toHaveBeenCalledTimes(1);
        const job = thumbnailQueue.enqueue.mock.calls[0][0];
        expect(job.pool).toBe(pool);
        expect(job.baseUrl).toBe('https://api.example');
        expect(job.design).toEqual({ cid: cidOf(content), city: 'new_york', content, binding: res.body.binding });
    });

    it('binds a road designation by its own polygon: a design is never an act on parcels', async () => {
        const pool = indexPool();
        const { structureProposal: _park, ...rest } = designContent();
        const content = { ...rest, goal: 'road-track', site: null, geometry: null, roadProposal: { definition: { polygon: PARK } } };
        const res = await request(appFor(pool).app).post('/designs').send(body(content));
        expect(res.status).toBe(201);
        expect(pool.getBindingCalls().map(call => call.sql)).toEqual([BINDING_COUNT_SQL, BINDING_SQL]);
        expect(res.body.binding.parcels.map(hit => hit.parcelId)).toEqual(['HR-335649-100', 'HR-335649-101']);
    });

    it('stores a design on ground whose cadastre the server does not hold, with unknown coverage', async () => {
        const pool = indexPool({ cadastre: { inRegion: false } });
        const res = await request(appFor(pool).app).post('/designs').send(body(designContent()));
        expect(res.status).toBe(201);
        expect(res.body.binding).toMatchObject({ coverage: 'unknown', parcels: [], subject: 'declared-unverified' });
    });

    it('refuses content that does not hash to the CID it is sent under, before any statement', async () => {
        const pool = indexPool();
        const content = designContent();
        const res = await request(appFor(pool).app).post('/designs').send({ cid: cidOf(designContent({ title: 'Other' })), content });
        expect(res.status).toBe(400);
        expect(res.body).toMatchObject({ code: 'cid-mismatch', computedCid: cidOf(content) });
        expect(pool.getCalls()).toEqual([]);
        expect(pool.getBindingCalls()).toEqual([]);
    });

    it('refuses what is not a design/v1 object with every error the shape check found', async () => {
        const pool = indexPool();
        const app = appFor(pool).app;
        const partial = { schema: 'design/v1', goal: 'park', structureProposal: { geometry: PARK } };
        const res = await request(app).post('/designs').send(body(partial));
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('invalid-design');
        expect(res.body.errors.map(error => error.code)).toEqual(expect.arrayContaining(['design-field-missing']));
        expect(res.body.errors.filter(error => error.code === 'design-field-missing').map(error => error.field))
            .toEqual(['title', 'description', 'author', 'city', 'site', 'toleranceM', 'geometry', 'origin', 'authoredAt']);

        const two = designContent({ buildingProposal: { parameters: { floors: 3 } } });
        expect((await request(app).post('/designs').send(body(two))).body.errors.map(error => error.code)).toEqual(['design-payload']);
        const extra = designContent({ cadastreParcelIds: ['HR-335649-100'] });
        expect((await request(app).post('/designs').send(body(extra))).body.errors).toEqual([
            expect.objectContaining({ code: 'design-field-unknown', field: 'cadastreParcelIds' })
        ]);
        expect(inserts(pool)).toEqual([]);
        expect(pool.getBindingCalls()).toEqual([]);
    });

    it('refuses a malformed request', async () => {
        const app = appFor(indexPool()).app;
        const content = designContent();
        for (const [sent, status, code] of [
            [{ ...body(content), cadastreParcelIds: [] }, 400, 'bad-request'],
            [{ ...body(content), parcelSourceId: 42 }, 400, 'bad-request'],
            [{ ...body(content), parcelSourceId: '' }, 400, 'bad-request'],
            [{ cid: 'not-a-cid', content }, 400, 'invalid-cid'],
            [{ cid: cidOf(content), content: [content] }, 400, 'invalid-design'],
            [{ cid: cidOf(content) }, 400, 'invalid-design']
        ]) {
            const res = await request(app).post('/designs').send(sent);
            expect([res.status, res.body.code]).toEqual([status, code]);
        }
    });

    it('refuses a design over the 10 MiB object cap', async () => {
        const content = designContent({ description: 'x'.repeat(MAX_PINNED_OBJECT_BYTES) });
        const res = await request(appFor(indexPool()).app).post('/designs').send({ cid: cidOf(designContent()), content });
        expect([res.status, res.body.code]).toEqual([413, 'too-large']);
    });

    it('refuses a parcel layout on its own: it is published with the agreement that settles its land', async () => {
        const pool = indexPool();
        const { app, thumbnailQueue } = appFor(pool);
        const res = await request(app).post('/designs').send(body(layoutContent()));
        expect([res.status, res.body.code]).toEqual([422, 'layout-needs-agreement']);
        expect(pool.getBindingCalls()).toEqual([]);
        expect(inserts(pool)).toEqual([]);
        expect(thumbnailQueue.enqueue).not.toHaveBeenCalled();
    });

    it('answers 409 with the indexed row for a CID already indexed, and binds nothing again', async () => {
        const content = designContent();
        const pool = indexPool({ existing: designRow(content) });
        const { app, thumbnailQueue } = appFor(pool);
        const res = await request(app).post('/designs').send(body(content));
        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({ cid: cidOf(content), city: 'zagreb', content });
        expect(pool.getBindingCalls()).toEqual([]);
        expect(inserts(pool)).toEqual([]);
        expect(thumbnailQueue.enqueue).not.toHaveBeenCalled();
    });

    it('answers 409 without a second thumbnail when another request indexed the CID first', async () => {
        const content = designContent();
        const pool = createMockPool();
        pool.bindingAnswer = scriptedCadastre();
        let selects = 0;
        pool.answer(SELECT_ONE, () => ({ rows: selects++ === 0 ? [] : [designRow(content)] }));
        pool.answer(INSERT, { rows: [] }); // ON CONFLICT DO NOTHING: the other request won
        const { app, thumbnailQueue } = appFor(pool);
        const res = await request(app).post('/designs').send(body(content));
        expect(res.status).toBe(409);
        expect(res.body.cid).toBe(cidOf(content));
        expect(thumbnailQueue.enqueue).not.toHaveBeenCalled();
    });

    it('refuses ground it cannot bind with a stable code, storing nothing', async () => {
        const road = (definition) => {
            const { structureProposal: _park, ...rest } = designContent();
            return { ...rest, goal: 'road', roadProposal: { definition } };
        };
        const cases = [
            [designContent({ site: box(200, 0, 201, 1) }), {}, 400, 'invalid-site'],
            [designContent({ toleranceM: 3 }), {}, 400, 'invalid-tolerance'],
            [road({ width: 12, points: [{ lat: 45.8, lng: 15.97 }, { lat: 45.801, lng: 15.971 }] }), {}, 400, 'invalid-footprint'],
            // A flagged legacy frame is refused by design validation before footprint binding.
            [road({ width: 12, points: [{ lat: 45.8, lng: 15.97 }, { lat: 45.801, lng: 15.971 }], constructionFrame: { kind: 'legacy-centreline' } }), {}, 400, 'invalid-design'],
            [designContent({ structureProposal: { kind: 'park', geometry: { type: 'Polygon', coordinates: 'x' } } }), {}, 400, 'invalid-footprint'],
            [designContent({ site: null, geometry: {}, structureProposal: { kind: 'park' } }), {}, 400, 'site-required'],
            [designContent(), { outsideM2: 37.2 }, 400, 'footprint-outside-site'],
            [designContent(), { parcels: [{ ...SPILL[1], bound: false, unresolved: true }] }, 409, 'binding-unresolved'],
            [designContent(), { count: MAX_BINDING_PARCELS + 1 }, 413, 'too-many-parcels']
        ];
        for (const [content, cadastre, status, code] of cases) {
            const pool = indexPool({ cadastre });
            const { app, thumbnailQueue } = appFor(pool);
            const res = await request(app).post('/designs').send(body(content));
            expect([res.status, res.body.code], `${code}: ${JSON.stringify(res.body)}`).toEqual([status, code]);
            expect(inserts(pool)).toEqual([]);
            expect(thumbnailQueue.enqueue).not.toHaveBeenCalled();
        }
    });

    it('answers 503 binding-unavailable, storing nothing, when the cadastre cannot be read', async () => {
        const pool = indexPool();
        pool.bindingAnswer = (sql) => {
            if (sql === FOOTPRINT_OUTSIDE_SITE_SQL) throw new Error('connection reset');
            return null;
        };
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        const res = await request(appFor(pool).app).post('/designs').send(body(designContent()));
        expect(error).toHaveBeenCalled();
        expect([res.status, res.body.code]).toEqual([503, 'binding-unavailable']);
        expect(inserts(pool)).toEqual([]);
    });
});

describe('GET /designs/:cid', () => {
    it('answers the indexed row, 404 for a CID it does not hold and 400 for what is not a CID', async () => {
        const content = designContent();
        const pool = createMockPool();
        pool.answer((sql, params) => SELECT_ONE.test(sql) && params[0] === cidOf(content), { rows: [designRow(content)] });
        const app = appFor(pool).app;
        const found = await request(app).get(`/designs/${cidOf(content)}`);
        expect(found.status).toBe(200);
        expect(found.body).toMatchObject({ cid: cidOf(content), city: 'zagreb', goal: 'park', content, screenshotUrl: null, createdAt: '2026-10-21T08:05:00.000Z' });
        const missing = await request(app).get(`/designs/${cidOf(designContent({ title: 'Unpublished' }))}`);
        expect([missing.status, missing.body.code]).toEqual([404, 'design-not-found']);
        const invalid = await request(app).get('/designs/42');
        expect([invalid.status, invalid.body.code]).toEqual([400, 'invalid-cid']);
    });

    it('serves JSON-LD only under a canonical PUBLIC_API_BASE_URL', async () => {
        const content = designContent();
        const pool = createMockPool();
        pool.answer(SELECT_ONE, { rows: [designRow(content)] });
        const app = appFor(pool).app;
        vi.stubEnv('PUBLIC_API_BASE_URL', '');
        const unconfigured = await request(app).get(`/designs/${cidOf(content)}?format=jsonld`);
        expect([unconfigured.status, unconfigured.body.code]).toEqual([503, 'semantic-public-base-unconfigured']);

        vi.stubEnv('PUBLIC_API_BASE_URL', 'https://api.example');
        const document = await request(app).get(`/designs/${cidOf(content)}?format=jsonld`);
        expect(document.status).toBe(200);
        expect(document.headers['content-type']).toMatch(/^application\/ld\+json/);
        expect(document.body).toMatchObject({ '@id': `https://api.example/designs/${cidOf(content)}#design`, 'cb:cid': cidOf(content) });
    });

    it('refuses to describe stored content that is not a design (422)', async () => {
        const content = designContent();
        const pool = createMockPool();
        pool.answer(SELECT_ONE, { rows: [designRow(content, { content: { ...content, schema: 'agreement/v1' } })] });
        vi.stubEnv('PUBLIC_API_BASE_URL', 'https://api.example');
        const res = await request(appFor(pool).app).get(`/designs/${cidOf(content)}?format=jsonld`);
        expect([res.status, res.body.code]).toEqual([422, 'semantic-record-invalid']);
    });
});

describe('GET /designs', () => {
    const listed = async (query) => {
        const pool = createMockPool();
        pool.answer(/FROM consensus\.design/, { rows: [designRow(designContent())] });
        const res = await request(appFor(pool).app).get(`/designs${query}`);
        return { res, call: pool.getCalls()[0] };
    };

    it('lists newest first with the default limit and no filter', async () => {
        const { res, call } = await listed('');
        expect(res.status).toBe(200);
        expect(res.body.count).toBe(1);
        expect(res.body.designs[0]).toMatchObject({ cid: cidOf(designContent()), goal: 'park' });
        expect(call.sql).not.toMatch(/WHERE/);
        expect(call.sql).toMatch(/ORDER BY created_at DESC, cid\s+LIMIT \$1/);
        expect(call.params).toEqual([100]);
    });

    it('filters by city, text and box, in that parameter order', async () => {
        const { call } = await listed('?city=ZAGREB&q=park&bbox=15.9,45.7,16.1,45.9&limit=5');
        expect(call.sql).toMatch(/WHERE city = \$1 AND \(title ILIKE \$2 OR author ILIKE \$2\) AND site && ST_MakeEnvelope\(\$3, \$4, \$5, \$6, 4326\) AND ST_Intersects\(site, ST_MakeEnvelope\(\$3, \$4, \$5, \$6, 4326\)\)/);
        expect(call.params).toEqual(['zagreb', '%park%', 15.9, 45.7, 16.1, 45.9, 5]);
    });

    it('matches q literally: % and _ (and the escape itself) are escaped', async () => {
        const { call } = await listed(`?q=${encodeURIComponent(' 50%_off\\ ')}`);
        expect(call.params).toEqual(['%50\\%\\_off\\\\%', 100]);
        const { call: blank } = await listed('?q=%20%20');
        expect(blank.sql).not.toMatch(/ILIKE/);
    });

    it('caps the limit and falls back to the default for one that is not a positive number', async () => {
        expect((await listed(`?limit=${MAX_DESIGN_LIST_LIMIT + 5000}`)).call.params).toEqual([MAX_DESIGN_LIST_LIMIT]);
        expect((await listed('?limit=abc')).call.params).toEqual([100]);
        expect((await listed('?limit=0')).call.params).toEqual([100]);
    });

    it('refuses a malformed filter before querying', async () => {
        for (const [query, code] of [
            ['?bbox=1,2,3', 'invalid-bbox'], ['?bbox=16,45,15,46', 'invalid-bbox'], ['?bbox=1,2,3,x', 'invalid-bbox'],
            ['?bbox=-181,0,0,1', 'invalid-bbox'], ['?bbox=1,,2,3', 'invalid-bbox'],
            [`?q=${'a'.repeat(201)}`, 'bad-request'], ['?city=a&city=b', 'bad-request'], [`?city=${'c'.repeat(101)}`, 'bad-request']
        ]) {
            const { res, call } = await listed(query);
            expect([res.status, res.body.code], query).toEqual([400, code]);
            expect(call).toBeUndefined();
        }
    });
});

describe('POST /designs/batch', () => {
    it('answers every requested CID once, in request order, null for those it does not hold', async () => {
        const a = designContent();
        const b = designContent({ title: 'Second park' });
        const pool = createMockPool();
        pool.answer(SELECT_MANY, { rows: [designRow(a)] });
        const res = await request(appFor(pool).app).post('/designs/batch').send({ cids: [cidOf(b), cidOf(a), cidOf(b)] });
        expect(res.status).toBe(200);
        expect(res.body.count).toBe(1);
        expect(res.body.items.map(item => [item.cid, item.design?.cid ?? null])).toEqual([[cidOf(b), null], [cidOf(a), cidOf(a)]]);
        expect(pool.getCalls()[0].params).toEqual([[cidOf(b), cidOf(a)]]);
    });

    it('takes 1 to 1000 CIDs and nothing else', async () => {
        const pool = createMockPool();
        const app = appFor(pool).app;
        const cid = cidOf(designContent());
        for (const sent of [{}, { cids: [] }, { cids: ['42'] }, { cids: cid }, { cids: [cid], extra: true },
            { cids: Array.from({ length: 1001 }, () => cid) }]) {
            const res = await request(app).post('/designs/batch').send(sent);
            expect([res.status, res.body.code]).toEqual([400, 'bad-request']);
        }
        expect(pool.getCalls()).toEqual([]);
    });
});

describe('POST /designs/binding', () => {
    it('uses the named Croatian database gateway for both binding preview and publication', async () => {
        const pool = indexPool(), app = appFor(pool).app;
        const preview = await request(app).post('/designs/binding').send({ site: SITE, city: 'zagreb', parcelSourceId: 'oss-wfs' });
        expect(preview.status).toBe(200);
        expect(preview.body).toMatchObject({ parcelSourceId: 'oss-wfs', binding: { parcelSource: { sourceId: 'hr-cadastre' }, coverage: 'complete' } });
        const publication = await request(app).post('/designs').send({ ...body(designContent()), parcelSourceId: 'oss-wfs' });
        expect(publication.status).toBe(201);
        expect(publication.body.binding.parcels).toEqual(preview.body.binding.parcels);
    });
    it('answers the binding a design on that site would get, storing nothing', async () => {
        const pool = indexPool({ cadastre: { unsurveyedM2: 4 } });
        const res = await request(appFor(pool).app).post('/designs/binding').send({ site: SITE, toleranceM: 0.01, city: 'client-label', parcelSourceId: 'oss-wfs' });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ city: 'client-label', parcelSourceId: 'oss-wfs' });
        expect(res.body.binding).toMatchObject({ coverage: 'partial', toleranceM: 0.01, unsurveyedM2: 4 });
        expect(res.body.binding.parcels.map(hit => hit.parcelId)).toEqual(['HR-335649-100', 'HR-335649-101']);
        expect(pool.getBindingCalls().map(call => call.sql)).toEqual([BINDING_COUNT_SQL, BINDING_SQL]);
        expect(pool.getCalls()).toEqual([]);
    });

    it('refuses a missing or malformed site and tolerance before any statement', async () => {
        const pool = indexPool();
        const app = appFor(pool).app;
        for (const [sent, code] of [
            [{}, 'bad-request'],
            [{ site: { type: 'Point', coordinates: [15.97, 45.8] } }, 'invalid-site'],
            [{ site: box(200, 0, 201, 1) }, 'invalid-site'],
            [{ site: 'SITE' }, 'invalid-site'],
            [{ site: SITE, toleranceM: -1 }, 'invalid-tolerance'],
            [{ site: SITE, toleranceM: '0.1' }, 'invalid-tolerance']
        ]) {
            const res = await request(app).post('/designs/binding').send(sent);
            expect([res.status, res.body.code], JSON.stringify(sent)).toEqual([400, code]);
        }
        expect(pool.getBindingCalls()).toEqual([]);
    });

    it('keeps a binding refusal\'s own status, and answers 503 binding-unavailable when the cadastre fails', async () => {
        const big = await request(appFor(indexPool({ cadastre: { count: MAX_BINDING_PARCELS + 1 } })).app)
            .post('/designs/binding').send({ site: SITE, parcelSourceId: 'oss-wfs' });
        expect([big.status, big.body.code]).toEqual([413, 'too-many-parcels']);

        const pool = indexPool();
        pool.bindingAnswer = () => { throw new Error('db down'); };
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        const down = await request(appFor(pool).app).post('/designs/binding').send({ site: SITE, parcelSourceId: 'oss-wfs' });
        expect(error).toHaveBeenCalled();
        expect([down.status, down.body.code]).toEqual([503, 'binding-unavailable']);
        expect(down.body.binding).toBeUndefined();
    });
});
