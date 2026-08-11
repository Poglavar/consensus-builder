import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { setupEnsPlansRoute } from '../routes/ens-plans.js';
import { createRouteApp } from './helpers/create-route-app.js';

// Minimal in-memory ens_plan store standing in for Postgres.
function makePlanPool() {
    const store = new Map();
    return {
        async query(sql, params) {
            if (/INSERT INTO ens_plan/i.test(sql)) {
                const [slug, idsJson, title, city, hash] = params;
                if (store.has(slug)) { const e = new Error('dup'); e.code = '23505'; throw e; }
                const row = { slug, proposal_ids: JSON.parse(idsJson), title, city, edit_token_hash: hash };
                store.set(slug, row);
                return { rows: [row], rowCount: 1 };
            }
            if (/SELECT \* FROM ens_plan WHERE slug/i.test(sql)) {
                const row = store.get(params[0]);
                return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
            }
            if (/UPDATE ens_plan SET/i.test(sql)) {
                const slug = params[params.length - 1];
                const row = store.get(slug);
                if (/proposal_ids = \$1/.test(sql)) row.proposal_ids = JSON.parse(params[0]);
                return { rows: [row], rowCount: 1 };
            }
            return { rows: [], rowCount: 0 };
        },
    };
}

let app;
beforeEach(() => { app = createRouteApp(setupEnsPlansRoute, makePlanPool()); });

describe('named plans CRUD', () => {
    it('creates a plan and returns an edit token + ENS name', async () => {
        const res = await request(app).post('/plans').send({ slug: 'harbor-plan', proposalIds: ['1', '2', '3'], title: 'Harbor' });
        expect(res.status).toBe(201);
        expect(res.body.name).toBe('harbor-plan.proposals.urbangametheory.eth');
        expect(res.body.url).toBe('/proposals/1,2,3');
        expect(res.body.editToken).toMatch(/^[0-9a-f]{48}$/);
    });

    it('rejects a duplicate name with 409', async () => {
        await request(app).post('/plans').send({ slug: 'harbor-plan', proposalIds: ['1'] });
        const res = await request(app).post('/plans').send({ slug: 'harbor-plan', proposalIds: ['9'] });
        expect(res.status).toBe(409);
    });

    it('rejects purely-numeric names (reserved for proposal ids)', async () => {
        const res = await request(app).post('/plans').send({ slug: '123', proposalIds: ['1'] });
        expect(res.status).toBe(400);
    });

    it('rejects invalid names and empty proposal lists', async () => {
        expect((await request(app).post('/plans').send({ slug: 'a', proposalIds: ['1'] })).status).toBe(400);
        expect((await request(app).post('/plans').send({ slug: 'ok-name', proposalIds: [] })).status).toBe(400);
        expect((await request(app).post('/plans').send({ slug: 'ok-name', proposalIds: ['p-x'] })).status).toBe(400);
    });

    it('fetches a plan and 404s on a missing one', async () => {
        await request(app).post('/plans').send({ slug: 'my-plan', proposalIds: ['5', '6'] });
        const ok = await request(app).get('/plans/my-plan');
        expect(ok.status).toBe(200);
        expect(ok.body.proposalIds).toEqual(['5', '6']);
        expect((await request(app).get('/plans/nope')).status).toBe(404);
    });

    it('updates a plan with the edit token (mutable) and rejects a bad token', async () => {
        const created = await request(app).post('/plans').send({ slug: 'living-plan', proposalIds: ['1'] });
        const { editToken } = created.body;

        const upd = await request(app).put('/plans/living-plan').send({ editToken, proposalIds: ['1', '2', '7'] });
        expect(upd.status).toBe(200);
        expect(upd.body.url).toBe('/proposals/1,2,7');

        const bad = await request(app).put('/plans/living-plan').send({ editToken: 'wrong', proposalIds: ['9'] });
        expect(bad.status).toBe(403);
    });
});

// Naming a plan refused at 51 proposals — "Too many proposals (max 50)" — which is a fifth of an
// ordinary plan here, so the feature was unusable on anything real.
//
// The count was a proxy. What a name actually carries is one link: `<base>/proposals/<id,id,id…>`,
// handed to a browser through the ENS `url` text record. So the limit belongs on the LENGTH of that
// link, which is also the only form that stays correct as ids grow — three hundred four-digit ids
// fit comfortably and three hundred seven-digit ones do not.
describe('how big a named plan may be', () => {
    let app;
    beforeEach(() => {
        app = createRouteApp((application, pool) => setupEnsPlansRoute(application, pool), makePlanPool());
    });

    const ids = (count, start = 900) => Array.from({ length: count }, (_, i) => String(start + i));

    it('takes a plan of three hundred — the size people actually build', async () => {
        const res = await request(app).post('/plans').send({ slug: 'sibenik-2066-1', proposalIds: ids(300) });
        expect(res.status, res.body && res.body.error).toBe(201);
        expect(res.body.proposalIds).toHaveLength(300);
    });

    it('refuses the same count when the ids are long enough to overflow the link', async () => {
        const res = await request(app).post('/plans').send({ slug: 'seven-digit', proposalIds: ids(300, 1234567) });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/characters/);
    });

    it('says how many are too many, instead of only that there are', async () => {
        // "Too long" leaves you guessing at how many to drop.
        const res = await request(app).post('/plans').send({ slug: 'way-too-big', proposalIds: ids(900, 1234567) });
        expect(res.body.error).toMatch(/too many/);
        expect(res.body.error).toMatch(/roughly \d+ fit/);
    });

    it('measures the DEDUPLICATED list, which is what the link carries', async () => {
        const duplicated = ids(300).concat(ids(300));
        const res = await request(app).post('/plans').send({ slug: 'with-dupes', proposalIds: duplicated });
        expect(res.status, res.body && res.body.error).toBe(201);
        expect(res.body.proposalIds).toHaveLength(300);
    });

    it('still refuses an empty plan', async () => {
        const res = await request(app).post('/plans').send({ slug: 'empty-plan', proposalIds: [] });
        expect(res.status).toBe(400);
    });
});
