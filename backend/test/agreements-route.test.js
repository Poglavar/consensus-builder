// The agreement index (routes/agreements.js, plan-design-agreement.md M2): POST /agreements checks the
// CID, the agreement/v1 shape section by section, that every linked design is indexed (a parcel
// layout comes along in `designs` and is indexed in the same transaction), that the input parcels are
// exactly the parcels the designs' sites take, and that the deadline lies ahead; the reads answer the
// index with the status from the chain once minted, else from the deadline (the chain account itself:
// agreements-onchain.test.js).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createMockPool } from './helpers/mock-pool.js';
import { createContentApp } from './helpers/create-app.js';
import {
    agreementContent, agreementRow, bindingOf, cidOf, designContent, designRow, layoutContent, pieceHash, scriptedCadastre, SPILL
} from './helpers/content-fixtures.js';
import { validateAgreementContent, MAX_AGREEMENT_DESIGNS } from '../routes/agreements.js';

const AGREEMENT_ONE = /FROM consensus\.agreement WHERE cid = \$1/;
const DESIGN_ONE = /FROM consensus\.design WHERE cid = \$1/;
const DESIGN_MANY = /FROM consensus\.design WHERE cid = ANY/;
const INSERT_DESIGN = /INSERT INTO consensus\.design/;
const INSERT_AGREEMENT = /INSERT INTO consensus\.agreement/;
const NOW = Date.parse('2026-10-21T12:00:00.000Z');

const park = designContent();
const layout = layoutContent();

function insertedDesign(params) {
    return { cid: params[0], city: params[1], goal: params[2], title: params[3], author: params[4], binding: JSON.parse(params[7]),
        content: JSON.parse(params[8]), origin_cid: params[9], screenshot_url: null, screenshot_before_url: null,
        screenshot_pair_url: null, created_at: new Date('2026-10-21T09:05:00.000Z') };
}
function insertedAgreement(params) {
    return { cid: params[0], city: params[1], title: params[2], author: params[3], design_cids: params[4], input_parcel_ids: params[5],
        parcel_source_id: params[6], deadline: params[7] ? new Date(params[7]) : null, status: 'active', content: JSON.parse(params[8]),
        onchain: null, screenshot_url: null, screenshot_before_url: null, screenshot_pair_url: null,
        created_at: new Date('2026-10-21T09:05:00.000Z') };
}

// An index holding `indexed` designs (and `agreements`), over a cadastre holding SPILL.
function indexPool({ indexed = [park], agreements = [], cadastre = {} } = {}) {
    const pool = createMockPool();
    pool.bindingAnswer = scriptedCadastre(cadastre);
    const rows = new Map(indexed.map(content => [cidOf(content), designRow(content)]));
    pool.answer(AGREEMENT_ONE, (sql, params) => ({ rows: agreements.filter(row => row.cid === params[0]) }));
    pool.answer(DESIGN_ONE, (sql, params) => ({ rows: rows.has(params[0]) ? [rows.get(params[0])] : [] }));
    pool.answer(DESIGN_MANY, (sql, params) => ({ rows: params[0].filter(cid => rows.has(cid)).map(cid => rows.get(cid)) }));
    pool.answer(INSERT_DESIGN, (sql, params) => ({ rows: [insertedDesign(params)] }));
    pool.answer(INSERT_AGREEMENT, (sql, params) => ({ rows: [insertedAgreement(params)] }));
    return pool;
}
function appFor(pool, overrides = {}) {
    const thumbnailQueue = { enqueue: vi.fn() };
    return { app: createContentApp(pool, { thumbnailQueue, baseUrl: 'https://api.example', now: () => NOW, ...overrides }), thumbnailQueue };
}
const sqlOf = pool => pool.getCalls().map(call => call.sql.trim().split(/\s+/).slice(0, 3).join(' '));
const writes = pool => pool.getCalls().filter(call => /^\s*(INSERT|BEGIN|COMMIT)/.test(call.sql));
const post = (app, content, designs) => request(app).post('/agreements')
    .send(designs ? { cid: cidOf(content), content, designs } : { cid: cidOf(content), content });

beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
});

describe('POST /agreements', () => {
    it('indexes the agreement and the layout it carries in one transaction, then their thumbnails', async () => {
        const pool = indexPool();
        const { app, thumbnailQueue } = appFor(pool);
        const content = agreementContent([park, layout]);
        const res = await post(app, content, [{ cid: cidOf(layout), content: layout }]);

        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({
            cid: cidOf(content), city: 'zagreb', title: 'Riverside deal', author: 'Studio North',
            designCids: [cidOf(park), cidOf(layout)], inputParcelIds: ['HR-335649-100', 'HR-335649-101'],
            parcelSourceId: 'oss-wfs', deadline: '2099-01-01T00:00:00.000Z', status: 'active', content, onchain: null
        });
        // The layout was bound now, and written with the agreement or not at all.
        expect(pool.getBindingCalls().length).toBeGreaterThan(0);
        const order = writes(pool).map(call => call.sql.trim().split(/\s+/).slice(0, 3).join(' '));
        expect(order).toEqual(['BEGIN', 'INSERT INTO consensus.design', 'INSERT INTO consensus.agreement', 'COMMIT']);
        const designInsert = pool.getCalls().find(call => INSERT_DESIGN.test(call.sql));
        expect(designInsert.params[0]).toBe(cidOf(layout));
        expect(JSON.parse(designInsert.params[7]).parcels.map(hit => hit.parcelId)).toEqual(['HR-335649-100', 'HR-335649-101']);
        const agreementInsert = pool.getCalls().find(call => INSERT_AGREEMENT.test(call.sql));
        expect(agreementInsert.params.slice(0, 8)).toEqual([cidOf(content), 'zagreb', 'Riverside deal', 'Studio North',
            [cidOf(park), cidOf(layout)], ['HR-335649-100', 'HR-335649-101'], 'oss-wfs', '2099-01-01T00:00:00.000Z']);
        expect(JSON.parse(agreementInsert.params[8])).toEqual(content);

        expect(thumbnailQueue.enqueue).toHaveBeenCalledTimes(2);
        const [designJob, agreementJob] = thumbnailQueue.enqueue.mock.calls.map(([job]) => job);
        expect(designJob.design.cid).toBe(cidOf(layout));
        expect(agreementJob.agreement).toEqual({
            cid: cidOf(content), city: 'zagreb', designs: [{ content: park }, { content: layout }],
            inputParcelIds: ['HR-335649-100', 'HR-335649-101']
        });
        expect(agreementJob.baseUrl).toBe('https://api.example');
    });

    it('links designs the index already holds without carrying them', async () => {
        const other = designContent({ title: 'Second park' });
        const pool = indexPool({ indexed: [park, other] });
        const content = agreementContent([park, other]);
        const res = await post(appFor(pool).app, content);
        expect(res.status).toBe(201);
        expect(pool.getBindingCalls()).toEqual([]);
        expect(pool.getCalls().filter(call => INSERT_DESIGN.test(call.sql))).toEqual([]);
    });

    it('refuses an agreement linking a design the index does not hold, naming it', async () => {
        const pool = indexPool();
        const content = agreementContent([park, layout]);
        const res = await post(appFor(pool).app, content);
        expect(res.status).toBe(422);
        expect(res.body).toMatchObject({ code: 'design-not-indexed', missing: [cidOf(layout)] });
        expect(writes(pool)).toEqual([]);
    });

    it('refuses inputs that are not exactly the parcels the designs take, and then indexes none of them', async () => {
        const pool = indexPool();
        const { app, thumbnailQueue } = appFor(pool);
        const content = agreementContent([park, layout], { inputs: {
            parcels: [
                { parcelId: 'HR-335649-100', parcelSourceId: 'oss-wfs', areaM2: 600, holders: [{ ownerKey: 'owner-a', share: 1 }] },
                { parcelId: 'HR-335649-999', parcelSourceId: 'oss-wfs', areaM2: 10, holders: [{ ownerKey: 'owner-z', share: 1 }] }
            ],
            openGroundM2: 0
        } });
        const res = await post(app, content, [{ cid: cidOf(layout), content: layout }]);
        expect(res.status).toBe(422);
        expect(res.body).toMatchObject({ code: 'inputs-differ-from-binding', missing: ['HR-335649-101'], extra: ['HR-335649-999'] });
        // The layout it carried was checked and bound, but nothing was written.
        expect(writes(pool)).toEqual([]);
        expect(thumbnailQueue.enqueue).not.toHaveBeenCalled();
    });

    it('accepts inputs beyond the bound parcels unverified only where a design\'s cadastre is unknown', async () => {
        const unknown = designContent({ title: 'Across the border' });
        const pool = indexPool({ indexed: [] });
        const rows = { [cidOf(park)]: designRow(park), [cidOf(unknown)]: designRow(unknown, { binding: bindingOf([], { coverage: 'unknown' }) }) };
        pool.reset();
        pool.answer(AGREEMENT_ONE, { rows: [] });
        pool.answer(DESIGN_MANY, (sql, params) => ({ rows: params[0].map(cid => rows[cid]).filter(Boolean) }));
        pool.answer(INSERT_AGREEMENT, (sql, params) => ({ rows: [insertedAgreement(params)] }));
        const inputs = { parcels: [
            { parcelId: 'HR-335649-100', parcelSourceId: 'oss-wfs', areaM2: 600, holders: [{ ownerKey: 'owner-a', share: 1 }] },
            { parcelId: 'HR-335649-101', areaM2: 400, holders: [{ ownerKey: 'owner-b', share: 1 }] },
            { parcelId: 'BG-77-1', areaM2: 80, holders: [{ ownerKey: 'owner-d', share: 1 }] }
        ], openGroundM2: 0 };
        expect((await post(appFor(pool).app, agreementContent([park, unknown], { inputs }))).status).toBe(201);
        // A parcel a design takes is still required.
        const short = { ...inputs, parcels: inputs.parcels.filter(parcel => parcel.parcelId !== 'HR-335649-101') };
        const res = await post(appFor(pool).app, agreementContent([park, unknown], { inputs: short }));
        expect(res.body).toMatchObject({ code: 'inputs-differ-from-binding', missing: ['HR-335649-101'], extra: [] });
    });

    it('refuses a deadline that has passed by the server\'s clock', async () => {
        const pool = indexPool();
        const res = await post(appFor(pool).app, agreementContent([park], { deadline: '2026-10-21T11:59:59.000Z' }));
        expect(res.status).toBe(422);
        expect(res.body).toMatchObject({ code: 'deadline-past', section: 'details' });
        expect(writes(pool)).toEqual([]);
        const open = await post(appFor(indexPool()).app, agreementContent([park], { deadline: null }));
        expect(open.status).toBe(201);
        expect(open.body.deadline).toBeNull();
    });

    it('refuses content that does not hash to its CID, and a malformed request', async () => {
        const pool = indexPool();
        const app = appFor(pool).app;
        const content = agreementContent([park]);
        const mismatch = await request(app).post('/agreements').send({ cid: cidOf(park), content });
        expect(mismatch.status).toBe(400);
        expect(mismatch.body).toMatchObject({ code: 'cid-mismatch', cid: cidOf(park), computedCid: cidOf(content) });
        for (const [sent, code] of [
            [{ cid: cidOf(content), content, extra: 1 }, 'bad-request'],
            [{ cid: 'bafy', content }, 'invalid-cid'],
            [{ cid: cidOf(content), content: 'agreement' }, 'invalid-agreement'],
            [{ cid: cidOf(content), content, designs: { cid: cidOf(park) } }, 'bad-request'],
            [{ cid: cidOf(content), content, designs: [{ cid: cidOf(park), content: park, extra: 1 }] }, 'bad-request'],
            [{ cid: cidOf(content), content, designs: [{ cid: cidOf(layout), content: layout }] }, 'design-not-in-agreement']
        ]) {
            const res = await request(app).post('/agreements').send(sent);
            expect([res.status, res.body.code], code).toEqual([400, code]);
        }
        const twice = agreementContent([park, layout]);
        const duplicate = await post(app, twice, [{ cid: cidOf(layout), content: layout }, { cid: cidOf(layout), content: layout }]);
        expect([duplicate.status, duplicate.body.code]).toEqual([400, 'bad-request']);
        expect(writes(pool)).toEqual([]);
    });

    it('answers a carried design\'s own refusal, naming the design', async () => {
        const broken = { ...layout, goal: '' };
        const content = agreementContent([park, broken]);
        const res = await post(appFor(indexPool()).app, content, [{ cid: cidOf(broken), content: broken }]);
        expect(res.status).toBe(400);
        expect(res.body).toMatchObject({ code: 'invalid-design', design: cidOf(broken) });
    });

    it('answers 409 with the indexed row for an agreement already indexed, even past its deadline', async () => {
        const content = agreementContent([park]);
        const stored = agreementRow(content, { status: 'expired' });
        const pool = indexPool({ agreements: [stored] });
        const { app, thumbnailQueue } = appFor(pool, { now: () => Date.parse('2100-01-01T00:00:00.000Z') });
        const res = await post(app, content);
        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({ cid: cidOf(content), status: 'expired' });
        expect(sqlOf(pool)).toEqual(['SELECT cid, city,']);
        expect(thumbnailQueue.enqueue).not.toHaveBeenCalled();
    });

    it('rolls back and answers 500 when the agreement cannot be written; no thumbnail is queued', async () => {
        const pool = indexPool();
        pool.reset();
        pool.bindingAnswer = scriptedCadastre();
        pool.answer(AGREEMENT_ONE, { rows: [] });
        pool.answer(DESIGN_ONE, { rows: [] });
        pool.answer(DESIGN_MANY, { rows: [designRow(park)] });
        pool.answer(INSERT_DESIGN, (sql, params) => ({ rows: [insertedDesign(params)] }));
        pool.answer(INSERT_AGREEMENT, () => { throw new Error('disk full'); });
        const { app, thumbnailQueue } = appFor(pool);
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        const res = await post(app, agreementContent([park, layout]), [{ cid: cidOf(layout), content: layout }]);
        expect(error).toHaveBeenCalled();
        expect(res.status).toBe(500);
        expect(pool.getCalls().map(call => call.sql.trim().split(/\s+/)[0]).filter(word => ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(word)))
            .toEqual(['BEGIN', 'ROLLBACK']);
        expect(thumbnailQueue.enqueue).not.toHaveBeenCalled();
    });

    it('answers 409 with the winner\'s row when another request indexed the same agreement first', async () => {
        const content = agreementContent([park]);
        const pool = indexPool();
        pool.reset();
        let reads = 0;
        pool.answer(AGREEMENT_ONE, () => ({ rows: reads++ === 0 ? [] : [agreementRow(content)] }));
        pool.answer(DESIGN_MANY, { rows: [designRow(park)] });
        pool.answer(INSERT_AGREEMENT, { rows: [] });
        const { app, thumbnailQueue } = appFor(pool);
        const res = await post(app, content);
        expect(res.status).toBe(409);
        expect(res.body.cid).toBe(cidOf(content));
        expect(thumbnailQueue.enqueue).not.toHaveBeenCalled();
    });
});

describe('validateAgreementContent', () => {
    const valid = agreementContent([park, layout]);
    const refused = (patch) => validateAgreementContent({ ...valid, ...patch }, { now: NOW });
    const withInputs = parcels => refused({ inputs: { parcels, openGroundM2: 0 } });
    const holder = (ownerKey, share = 1) => ({ ownerKey, share });

    it('accepts the fixture and copies out what the index looks things up by', () => {
        expect(validateAgreementContent(valid, { now: NOW })).toEqual({
            ok: true, designCids: [cidOf(park), cidOf(layout)], inputParcelIds: ['HR-335649-100', 'HR-335649-101'],
            parcelSourceId: 'oss-wfs', deadline: '2099-01-01T00:00:00.000Z'
        });
        const sourced = withInputs([{ parcelId: 'US-NY-1', parcelSourceId: 'nyc-mappluto', areaM2: 10, holders: [holder('a')] }]);
        expect(sourced).toMatchObject({ ok: true, parcelSourceId: 'nyc-mappluto', inputParcelIds: ['US-NY-1'] });
        expect(refused({ inputs: { parcels: [], openGroundM2: 120 } }).ok).toBe(true);
    });

    it.each([
        ['details', { schema: 'agreement/v0' }],
        ['details', { title: 'x'.repeat(501) }],
        ['details', { author: 7 }],
        ['details', { createdAt: '21 October 2026' }],
        ['details', { deadline: '2099-01-01' }],
        ['designs', { designs: [] }],
        ['designs', { designs: Array.from({ length: MAX_AGREEMENT_DESIGNS + 1 }, (_, index) => ({ cid: cidOf({ index }) })) }],
        ['designs', { designs: [{ cid: 'design-1' }] }],
        ['designs', { designs: [{ cid: cidOf(park) }, { cid: cidOf(park) }] }],
        ['land', { inputs: null }],
        ['land', { inputs: { parcels: [], openGroundM2: 0 } }],
        ['land', { inputs: { parcels: [], openGroundM2: -1 } }],
        ['land', { outputs: [{ ...valid.outputs[0], hash: 'piece1-sha256:XYZ' }] }],
        ['land', { outputs: [valid.outputs[0], valid.outputs[0]] }],
        ['land', { outputs: [{ ...valid.outputs[0], role: 'castle' }] }],
        ['land', { outputs: [{ ...valid.outputs[0], areaM2: -5 }] }],
        ['land', { outputs: [{ ...valid.outputs[0], fromParcelIds: 'HR-335649-100' }] }],
        ['land', { outputs: [{ ...valid.outputs[0], producedBy: cidOf({ elsewhere: true }) }] }],
        ['allocation', { allocations: [{ output: pieceHash('not-an-output'), to: { kind: 'holders' } }] }],
        ['allocation', { allocations: [valid.allocations[0], valid.allocations[0]] }],
        ['allocation', { allocations: [{ output: valid.outputs[0].hash, to: { kind: 'auction' } }] }],
        ['allocation', { allocations: [{ output: valid.outputs[0].hash, to: { kind: 'party' } }] }],
        ['allocation', { allocations: [{ output: valid.outputs[0].hash, to: { kind: 'joint', shares: [holder('a', 0.5), holder('b', 0.4)] } }] }],
        ['money', { money: { currency: 'USD', lines: [] } }],
        ['money', { money: { currency: 'EUR', lines: [{ ownerKey: 'owner-a', amountCents: 1 }, { ownerKey: 'owner-a', amountCents: 2 }] } }],
        ['money', { money: { currency: 'EUR', lines: [{ ownerKey: 'owner-a', amountCents: 10.5 }] } }],
        ['rule', { rule: { electorate: 'everyone', binding: true, lens: [] } }],
        ['rule', { rule: { electorate: 'owners', binding: 'yes', lens: [] } }],
        ['rule', { rule: { electorate: 'owners', binding: true, lens: 'member' } }],
        ['rule', { rule: { electorate: 'owners', binding: true, lens: [''] } }],
        ['rule', { rule: { electorate: 'community', binding: true, lens: [] } }],
        ['rule', { rule: { electorate: 'community', binding: false, lens: [], approvalConfig: { schema: 'proposal-approval/v1' } } }],
        ['rule', { rule: { electorate: 'owners', binding: true, lens: [], approvalConfig: { schema: 'approval/v0' } } }]
    ])('refuses a broken %s section', (section, patch) => {
        expect(refused(patch)).toMatchObject({ ok: false, status: 400, code: 'invalid-agreement', section });
    });

    it('refuses broken input parcels and holders', () => {
        for (const parcels of [
            [{ areaM2: 1, holders: [] }],
            [{ parcelId: 'p', areaM2: 1, holders: [holder('a')] }, { parcelId: 'p', areaM2: 1, holders: [holder('b')] }],
            [{ parcelId: 'p', areaM2: -1, holders: [holder('a')] }],
            [{ parcelId: 'p', areaM2: 1 }],
            [{ parcelId: 'p', areaM2: 1, holders: [holder('a', 0)] }],
            [{ parcelId: 'p', areaM2: 1, holders: [holder('a', 1.5)] }],
            [{ parcelId: 'p', areaM2: 1, holders: [holder('a', 0.5), holder('a', 0.5)] }],
            [{ parcelId: 'p', parcelSourceId: 'one', areaM2: 1, holders: [holder('a')] }, { parcelId: 'q', parcelSourceId: 'two', areaM2: 1, holders: [holder('b')] }]
        ]) {
            expect(withInputs(parcels), JSON.stringify(parcels)).toMatchObject({ ok: false, code: 'invalid-agreement', section: 'land' });
        }
    });

    it('refuses a deadline at or before now with 422, and is not fooled by a valid shape', () => {
        expect(refused({ deadline: new Date(NOW).toISOString() })).toMatchObject({ ok: false, status: 422, code: 'deadline-past' });
        expect(refused({ deadline: new Date(NOW + 1000).toISOString() }).ok).toBe(true);
    });
});

describe('GET /agreements/:cid', () => {
    it('answers the indexed row with its status from the chain account, else from the deadline, in SQL', async () => {
        const active = agreementContent([park]);
        const expired = agreementContent([park], { title: 'Lapsed deal' });
        const pool = indexPool({ agreements: [agreementRow(active), agreementRow(expired, { status: 'expired' })] });
        const app = appFor(pool).app;
        const one = await request(app).get(`/agreements/${cidOf(active)}`);
        expect(one.status).toBe(200);
        expect(one.body).toMatchObject({ cid: cidOf(active), status: 'active', designCids: [cidOf(park)], createdAt: '2026-10-21T09:05:00.000Z' });
        expect((await request(app).get(`/agreements/${cidOf(expired)}`)).body.status).toBe('expired');
        // A terminal status the account reached wins; only an active (or unminted) agreement expires by its deadline.
        expect(pool.getCalls()[0].sql).toMatch(new RegExp(String.raw`CASE WHEN onchain->>'status' IN \('executed', 'cancelled', 'expired'\) THEN onchain->>'status'\s+`
            + String.raw`WHEN deadline IS NOT NULL AND deadline <= now\(\) THEN 'expired' ELSE 'active' END AS status`));
        const executed = agreementContent([park], { title: 'Executed deal' });
        const minted = indexPool({ agreements: [agreementRow(executed, { status: 'executed', onchain: { account: 'acc', status: 'executed' } })] });
        const res = await request(appFor(minted).app).get(`/agreements/${cidOf(executed)}`);
        expect(res.body).toMatchObject({ status: 'executed', onchain: { account: 'acc', status: 'executed' } });
    });

    it('answers 404 and 400, and JSON-LD only under a canonical PUBLIC_API_BASE_URL', async () => {
        const content = agreementContent([park]);
        const app = appFor(indexPool({ agreements: [agreementRow(content)] })).app;
        expect((await request(app).get(`/agreements/${cidOf(park)}`)).body.code).toBe('agreement-not-found');
        expect((await request(app).get('/agreements/12')).body.code).toBe('invalid-cid');
        vi.stubEnv('PUBLIC_API_BASE_URL', '');
        const unconfigured = await request(app).get(`/agreements/${cidOf(content)}?format=jsonld`);
        expect([unconfigured.status, unconfigured.body.code]).toEqual([503, 'semantic-public-base-unconfigured']);
        vi.stubEnv('PUBLIC_API_BASE_URL', 'https://api.example');
        const document = await request(app).get(`/agreements/${cidOf(content)}?format=jsonld`);
        expect(document.status).toBe(200);
        expect(document.headers['content-type']).toMatch(/^application\/ld\+json/);
        expect(document.body['@id']).toBe(`https://api.example/agreements/${cidOf(content)}#agreement`);
    });
});

describe('GET /agreements', () => {
    const listed = async (query) => {
        const pool = createMockPool();
        pool.answer(/FROM consensus\.agreement/, { rows: [agreementRow(agreementContent([park]))] });
        const res = await request(appFor(pool).app).get(`/agreements${query}`);
        return { res, call: pool.getCalls()[0] };
    };

    it('filters by city, design and parcel, newest first', async () => {
        const { res, call } = await listed(`?city=zagreb&design=${cidOf(park)}&parcel=HR-335649-100&limit=20`);
        expect(res.status).toBe(200);
        expect(res.body.count).toBe(1);
        expect(res.body.agreements[0]).toMatchObject({ designCids: [cidOf(park)], status: 'active' });
        expect(call.sql).toMatch(/WHERE city = \$1 AND design_cids @> ARRAY\[\$2\]::text\[\] AND input_parcel_ids @> ARRAY\[\$3\]::text\[\]/);
        expect(call.sql).toMatch(/ORDER BY created_at DESC, cid\s+LIMIT \$4/);
        expect(call.params).toEqual(['zagreb', cidOf(park), 'HR-335649-100', 20]);
        const { call: all } = await listed('');
        expect(all.sql).not.toMatch(/WHERE/);
        expect(all.params).toEqual([100]);
    });

    it('refuses a malformed filter before querying', async () => {
        for (const [query, code] of [['?design=park', 'invalid-cid'], [`?parcel=${'p'.repeat(257)}`, 'bad-request'],
            ['?parcel=%20', 'bad-request'], ['?city=a&city=b', 'bad-request']]) {
            const { res, call } = await listed(query);
            expect([res.status, res.body.code], query).toEqual([400, code]);
            expect(call).toBeUndefined();
        }
    });
});

// The binding fixture the layout gets above is the scripted cadastre's: SPILL's bound parcels.
it('uses a cadastre whose bound parcels are the fixture agreement\'s inputs', () => {
    expect(SPILL.filter(hit => hit.bound).map(hit => hit.parcelId)).toEqual(agreementContent([park]).inputs.parcels.map(parcel => parcel.parcelId));
});
