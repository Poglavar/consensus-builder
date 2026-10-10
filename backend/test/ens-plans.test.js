import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { setupEnsPlansRoute } from '../routes/ens-plans.js';
import { createRouteApp } from './helpers/create-route-app.js';

// In-memory plan store standing in for plans/plan-store.js (Postgres). Members are proposal rows;
// any numeric id exists unless listed in `absent`.
function makeStore({ absent = [] } = {}) {
    const plans = new Map();
    const proposals = new Map();
    const memberRow = id => proposals.get(String(id)) || {
        id: Number(id), proposal_id: `p-${id}`, title: `Proposal ${id}`, type: 'building', goal: 'buildings',
        site: { type: 'MultiPolygon', coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 0]]]] },
        cadastre_parcel_ids: [`HR-1-${id}`], building_proposal: { parameters: { floors: 4 } }
    };
    return {
        proposals,
        async members(ids) { return ids.filter(id => !absent.includes(String(id))).map(memberRow); },
        async plan(slug) { return plans.get(slug) || null; },
        async supersededBy(slug) { return [...plans.values()].filter(plan => plan.supersedes === slug).map(plan => plan.slug); },
        async versionsOf(base) { return new Set([...plans.keys()].filter(slug => slug === base || slug.startsWith(`${base}-v`))); },
        async list(city) { return [...plans.values()].filter(plan => !city || plan.city === city); },
        async insert(plan) {
            if (plans.has(plan.slug)) { const e = new Error('dup'); e.code = '23505'; throw e; }
            const row = { slug: plan.slug, proposal_ids: plan.proposalIds, title: plan.title, description: plan.description,
                author: plan.author, place: plan.place, city: plan.city, member_hashes: plan.memberHashes,
                plan_hash: plan.planHash, supersedes: plan.supersedes, onchain_data: null, has_site: true };
            plans.set(plan.slug, row);
            return row;
        }
    };
}

let app;
let store;
beforeEach(() => {
    store = makeStore();
    app = createRouteApp((application) => setupEnsPlansRoute(application, null, { store }));
});

describe('named plans CRUD', () => {
    it('creates a plan with its ENS name and a content hash, and issues no edit token', async () => {
        const res = await request(app).post('/plans').send({ slug: 'harbor-plan', proposalIds: ['1', '2', '3'], title: 'Harbor' });
        expect(res.status).toBe(201);
        expect(res.body.name).toBe('harbor-plan.proposals.urbangametheory.eth');
        expect(res.body.url).toBe('/proposals/1,2,3');
        expect(res.body.planHash).toMatch(/^[0-9a-f]{64}$/);
        expect(res.body.editToken).toBeUndefined();
    });

    it('answers a taken name with 409 and the next free version', async () => {
        await request(app).post('/plans').send({ slug: 'harbor-plan', proposalIds: ['1'] });
        const res = await request(app).post('/plans').send({ slug: 'harbor-plan', proposalIds: ['9'] });
        expect(res.status).toBe(409);
        expect(res.body.suggestion).toBe('harbor-plan-v2');
        await request(app).post('/plans').send({ slug: 'harbor-plan-v2', proposalIds: ['9'] });
        const again = await request(app).post('/plans').send({ slug: 'harbor-plan-v2', proposalIds: ['10'] });
        expect(again.body.suggestion).toBe('harbor-plan-v3');
    });

    it('refuses members that do not exist', async () => {
        store = makeStore({ absent: ['404'] });
        app = createRouteApp((application) => setupEnsPlansRoute(application, null, { store }));
        const res = await request(app).post('/plans').send({ slug: 'ghost-plan', proposalIds: ['1', '404'] });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/404/);
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

    it('has no update: a named plan never changes', async () => {
        await request(app).post('/plans').send({ slug: 'fixed-plan', proposalIds: ['1'] });
        const put = await request(app).put('/plans/fixed-plan').send({ proposalIds: ['1', '2', '7'] });
        expect(put.status).toBe(404);
        expect((await request(app).get('/plans/fixed-plan')).body.proposalIds).toEqual(['1']);
    });

    it('records a revision as superseding the old plan, which learns of it on read', async () => {
        await request(app).post('/plans').send({ slug: 'borovje', proposalIds: ['1'] });
        const v2 = await request(app).post('/plans').send({ slug: 'borovje-v2', proposalIds: ['1', '2'], supersedes: 'borovje' });
        expect(v2.status).toBe(201);
        expect(v2.body.supersedes).toBe('borovje');
        expect((await request(app).get('/plans/borovje')).body.supersededBy).toEqual(['borovje-v2']);
        const bad = await request(app).post('/plans').send({ slug: 'orphan-v2', proposalIds: ['1'], supersedes: 'no-such-plan' });
        expect(bad.status).toBe(400);
    });

    it('flags a member whose content changed after the plan was named', async () => {
        await request(app).post('/plans').send({ slug: 'watched-plan', proposalIds: ['1', '2'] });
        const before = await request(app).get('/plans/watched-plan');
        expect(before.body.members.map(member => member.changed)).toEqual([false, false]);
        // Proposal 2 is repaired in place: one more floor.
        const repaired = (await store.members(['2']))[0];
        store.proposals.set('2', { ...repaired, building_proposal: { parameters: { floors: 5 } } });
        const after = await request(app).get('/plans/watched-plan');
        expect(after.body.members.map(member => member.changed)).toEqual([false, true]);
    });

    it('lists plans of a city', async () => {
        await request(app).post('/plans').send({ slug: 'zg-plan', proposalIds: ['1'], city: 'zagreb', place: 'Borovje' });
        await request(app).post('/plans').send({ slug: 'sf-plan', proposalIds: ['2'], city: 'san_francisco' });
        const res = await request(app).get('/plans?city=zagreb');
        expect(res.body.plans.map(plan => [plan.slug, plan.place])).toEqual([['zg-plan', 'Borovje']]);
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
        app = createRouteApp((application) => setupEnsPlansRoute(application, null, { store: makeStore() }));
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
