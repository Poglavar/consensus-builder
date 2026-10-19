import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { setupEnsPlansRoute } from '../routes/ens-plans.js';
import { createRouteApp } from './helpers/create-route-app.js';

// In-memory plan store standing in for plans/plan-store.js (Postgres). Members are proposal rows;
// any numeric id exists unless listed in `absent`.
function makeStore({ absent = [] } = {}) {
    const plans = new Map();
    const proposals = new Map();
    const removed = new Set();
    const memberRow = id => proposals.get(String(id)) || {
        id: Number(id), proposal_id: `p-${id}`, title: `Proposal ${id}`, type: 'building', goal: 'buildings',
        site: { type: 'MultiPolygon', coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 0]]]] },
        proposal_data: {
            kind: 'owner-deal',
            site: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }
        },
        cadastre_parcel_ids: [`HR-1-${id}`], building_proposal: { parameters: { floors: 4 } }
    };
    return {
        proposals,
        async members(ids) { return ids.filter(id => !absent.includes(String(id)) && !removed.has(String(id))).map(memberRow); },
        removeProposal(id) { removed.add(String(id)); },
        async plan(slug) { return plans.get(slug) || null; },
        async supersededBy(slug) { return [...plans.values()].filter(plan => plan.supersedes === slug).map(plan => plan.slug); },
        async versionsOf(base) { return new Set([...plans.keys()].filter(slug => slug === base || slug.startsWith(`${base}-v`))); },
        listCalls: [],
        async list(city, filters = {}) {
            this.listCalls.push({ city, ...filters });
            return [...plans.values()].filter(plan => !city || plan.city === city)
                .filter(plan => !filters.proposalRowIds || plan.proposal_ids.some(id => filters.proposalRowIds.includes(id)))
                .map(plan => ({ ...plan, member_count: plan.proposal_ids.length, superseded: [...plans.values()].some(other => other.supersedes === plan.slug) }));
        },
        async insert(plan) {
            if (plans.has(plan.slug)) { const e = new Error('dup'); e.code = '23505'; throw e; }
            const row = { slug: plan.slug, proposal_ids: plan.proposalRowIds, title: plan.title, description: plan.description,
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
        const res = await request(app).post('/plans').send({ slug: 'harbor-plan', proposalRowIds: ['1', '2', '3'], title: 'Harbor' });
        expect(res.status).toBe(201);
        expect(res.body.name).toBe('harbor-plan.proposals.urbangametheory.eth');
        expect(res.body.url).toBe('/proposals/harbor-plan');
        expect(res.body.proposalRowIds).toEqual(['1', '2', '3']);
        expect(res.body.planHash).toMatch(/^[0-9a-f]{64}$/);
        expect(res.body.editToken).toBeUndefined();
        expect(res.body).not.toHaveProperty('proposalIds');
    });

    it('answers a taken name with 409 and the next free version', async () => {
        await request(app).post('/plans').send({ slug: 'harbor-plan', proposalRowIds: ['1'] });
        const res = await request(app).post('/plans').send({ slug: 'harbor-plan', proposalRowIds: ['9'] });
        expect(res.status).toBe(409);
        expect(res.body.suggestion).toBe('harbor-plan-v2');
        await request(app).post('/plans').send({ slug: 'harbor-plan-v2', proposalRowIds: ['9'] });
        const again = await request(app).post('/plans').send({ slug: 'harbor-plan-v2', proposalRowIds: ['10'] });
        expect(again.body.suggestion).toBe('harbor-plan-v3');
    });

    it('refuses members that do not exist', async () => {
        store = makeStore({ absent: ['404'] });
        app = createRouteApp((application) => setupEnsPlansRoute(application, null, { store }));
        const res = await request(app).post('/plans').send({ slug: 'ghost-plan', proposalRowIds: ['1', '404'] });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/404/);
    });

    it('rejects the retired proposalIds request field, including alongside proposalRowIds', async () => {
        const alone = await request(app).post('/plans').send({ slug: 'old-list-alone', proposalIds: ['1'] });
        const mixed = await request(app).post('/plans').send({
            slug: 'old-list-mixed', proposalIds: ['1'], proposalRowIds: ['2']
        });
        expect(alone.status).toBe(400);
        expect(mixed.status).toBe(400);
    });

    it('rejects purely-numeric names (reserved for proposal ids)', async () => {
        const res = await request(app).post('/plans').send({ slug: '123', proposalRowIds: ['1'] });
        expect(res.status).toBe(400);
    });

    it('rejects invalid names and empty proposal lists', async () => {
        expect((await request(app).post('/plans').send({ slug: 'a', proposalRowIds: ['1'] })).status).toBe(400);
        expect((await request(app).post('/plans').send({ slug: 'ok-name', proposalRowIds: [] })).status).toBe(400);
        expect((await request(app).post('/plans').send({ slug: 'ok-name', proposalRowIds: ['p-x'] })).status).toBe(400);
    });

    it('describes plan membership as database row IDs independently of minting', async () => {
        const invalid = await request(app).post('/plans').send({ slug: 'row-plan', proposalRowIds: ['authored-id'] });
        expect(invalid.status).toBe(400);
        expect(invalid.body.error).toContain('database row IDs');
        expect(invalid.body.error).not.toContain('minted');
        const valid = await request(app).post('/plans').send({ slug: 'row-plan', proposalRowIds: ['1'] });
        expect(valid.status).toBe(201);
        expect(valid.body.onchain).toBeNull();
    });

    it('fetches a plan and 404s on a missing one', async () => {
        await request(app).post('/plans').send({ slug: 'my-plan', proposalRowIds: ['5', '6'] });
        const ok = await request(app).get('/plans/my-plan');
        expect(ok.status).toBe(200);
        expect(ok.body.proposalRowIds).toEqual(['5', '6']);
        expect(ok.body).not.toHaveProperty('proposalIds');
        expect(ok.body.members[0]).toMatchObject({ proposalRowId: '5', authoredProposalId: 'p-5' });
        expect(ok.body.members[0]).not.toHaveProperty('id');
        expect(ok.body.members[0]).not.toHaveProperty('proposalId');
        expect((await request(app).get('/plans/nope')).status).toBe(404);
    });

    it('returns a renamed missing-member reference when a member is removed after naming', async () => {
        await request(app).post('/plans').send({ slug: 'vanished-plan', proposalRowIds: ['5', '6'] });
        store.removeProposal('5');

        const res = await request(app).get('/plans/vanished-plan');

        expect(res.status).toBe(200);
        expect(res.body.members[0]).toMatchObject({ proposalRowId: '5', missing: true });
        expect(res.body.members[0]).not.toHaveProperty('id');
        expect(res.body.members[0]).not.toHaveProperty('proposalId');
    });

    it('has no update: a named plan never changes', async () => {
        await request(app).post('/plans').send({ slug: 'fixed-plan', proposalRowIds: ['1'] });
        const put = await request(app).put('/plans/fixed-plan').send({ proposalRowIds: ['1', '2', '7'] });
        expect(put.status).toBe(404);
        expect((await request(app).get('/plans/fixed-plan')).body.proposalRowIds).toEqual(['1']);
    });

    it('records a revision as superseding the old plan, which learns of it on read', async () => {
        await request(app).post('/plans').send({ slug: 'borovje', proposalRowIds: ['1'] });
        const v2 = await request(app).post('/plans').send({ slug: 'borovje-v2', proposalRowIds: ['1', '2'], supersedes: 'borovje' });
        expect(v2.status).toBe(201);
        expect(v2.body.supersedes).toBe('borovje');
        expect((await request(app).get('/plans/borovje')).body.supersededBy).toEqual(['borovje-v2']);
        const bad = await request(app).post('/plans').send({ slug: 'orphan-v2', proposalRowIds: ['1'], supersedes: 'no-such-plan' });
        expect(bad.status).toBe(400);
    });

    it('flags a member whose content changed after the plan was named', async () => {
        await request(app).post('/plans').send({ slug: 'watched-plan', proposalRowIds: ['1', '2'] });
        const before = await request(app).get('/plans/watched-plan');
        expect(before.body.members.map(member => member.changed)).toEqual([false, false]);
        // Proposal 2 is repaired in place: one more floor.
        const repaired = (await store.members(['2']))[0];
        store.proposals.set('2', { ...repaired, building_proposal: { parameters: { floors: 5 } } });
        const after = await request(app).get('/plans/watched-plan');
        expect(after.body.members.map(member => member.changed)).toEqual([false, true]);
    });

    it.each([
        ['kind', 'community-vote'],
        ['site', { type: 'Polygon', coordinates: [[[0, 0], [2, 0], [2, 2], [0, 0]]] }]
    ])('detects changed authored %s without rewriting the named commitment', async (field, value) => {
        const named = await request(app).post('/plans').send({ slug: 'scope-plan', proposalRowIds: ['1'] });
        expect(named.status).toBe(201);
        expect((await request(app).get('/plans/scope-plan')).body.members[0].changed).toBe(false);

        const original = (await store.members(['1']))[0];
        store.proposals.set('1', { ...original, proposal_data: { ...original.proposal_data, [field]: value } });
        const after = await request(app).get('/plans/scope-plan');
        expect(after.status).toBe(200);
        expect(after.body.members[0].changed).toBe(true);
        expect(after.body.planHash).toBe(named.body.planHash);
    });

    it('lists plans of a city', async () => {
        await request(app).post('/plans').send({ slug: 'zg-plan', proposalRowIds: ['1'], city: 'zagreb', place: 'Borovje' });
        await request(app).post('/plans').send({ slug: 'sf-plan', proposalRowIds: ['2'], city: 'san_francisco' });
        const res = await request(app).get('/plans?city=zagreb');
        expect(res.body.plans.map(plan => [plan.slug, plan.place])).toEqual([['zg-plan', 'Borovje']]);
    });

    it('files a plan under its members\' city, not the view it was named from', async () => {
        store.proposals.set('5', { id: 5, proposal_id: 'p-5', title: 'Split one', type: 'building', city: 'split',
            site: { type: 'MultiPolygon', coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 0]]]] }, cadastre_parcel_ids: ['HR-1-5'] });
        store.proposals.set('6', { ...store.proposals.get('5'), id: 6, proposal_id: 'p-6' });
        store.proposals.set('7', { ...store.proposals.get('5'), id: 7, proposal_id: 'p-7', city: 'zagreb' });
        const res = await request(app).post('/plans').send({ slug: 'riva', proposalRowIds: ['7', '5', '6'], city: 'st' });
        expect(res.status).toBe(201);
        expect(res.body.city).toBe('split');
        // members without a city: the requested one, normalised
        const coded = await request(app).post('/plans').send({ slug: 'coded', proposalRowIds: ['1'], city: 'zg' });
        expect(coded.body.city).toBe('zagreb');
        // a short code reads the same city
        await request(app).get('/plans?city=st');
        expect(store.listCalls.at(-1).city).toBe('split');
    });

    it('lists the plans a proposal is part of, with member counts and superseded versions marked', async () => {
        await request(app).post('/plans').send({ slug: 'harbor', proposalRowIds: ['1', '2'], city: 'zagreb' });
        await request(app).post('/plans').send({ slug: 'harbor-v2', proposalRowIds: ['2', '3', '4'], city: 'zagreb', supersedes: 'harbor' });
        await request(app).post('/plans').send({ slug: 'elsewhere', proposalRowIds: ['9'], city: 'zagreb' });
        const res = await request(app).get('/plans?city=zagreb&proposal_row_ids=2,7');
        expect(res.status).toBe(200);
        expect(res.body.plans.map(plan => [plan.slug, plan.memberCount, plan.superseded])).toEqual([['harbor', 2, true], ['harbor-v2', 3, false]]);
        expect(res.body.plans[0].proposalRowIds).toEqual(['1', '2']);
        expect(store.listCalls.at(-1)).toEqual({ city: 'zagreb', proposalRowIds: ['2', '7'], parcelIds: null });
        expect(res.body.plans[0]).not.toHaveProperty('proposalIds');
    });

    it('rejects the retired proposal_ids filter, including alongside proposal_row_ids', async () => {
        expect((await request(app).get('/plans?proposal_ids=1')).status).toBe(400);
        expect((await request(app).get('/plans?proposal_ids=1&proposal_row_ids=2')).status).toBe(400);
    });

    it('passes a parcel filter to the store and refuses malformed or oversized filters', async () => {
        await request(app).get('/plans?city=zagreb&parcel_ids=HR-335533-2895/2,HR-335533-2896');
        expect(store.listCalls.at(-1)).toEqual({ city: 'zagreb', proposalRowIds: null, parcelIds: ['HR-335533-2895/2', 'HR-335533-2896'] });
        expect((await request(app).get('/plans?proposal_row_ids=1,abc')).status).toBe(400);
        const tooMany = Array.from({ length: 501 }, (_, i) => String(i + 1)).join(',');
        expect((await request(app).get(`/plans?proposal_row_ids=${tooMany}`)).status).toBe(400);
    });
});

// Named plans use a short slug route; the route resolves membership server-side. Member limits bound
// server work and payloads, while deduplication keeps repeated IDs from inflating a plan.
describe('named plan membership bound and URL', () => {
    let app;
    beforeEach(() => {
        app = createRouteApp((application) => setupEnsPlansRoute(application, null, { store: makeStore() }));
    });

    const ids = (count, start = 900) => Array.from({ length: count }, (_, i) => String(start + i));

    it('names a 1,105-member plan of seven-digit row IDs using the short slug route', async () => {
        const res = await request(app).post('/plans').send({ slug: 'candlestick-plan', proposalRowIds: ids(1105, 1234567) });
        expect(res.status, res.body && res.body.error).toBe(201);
        expect(res.body.proposalRowIds).toHaveLength(1105);
        expect(res.body.url).toBe('/proposals/candlestick-plan');
    });

    it('rejects a deduplicated membership beyond the generic 5,000-member bound', async () => {
        const res = await request(app).post('/plans').send({ slug: 'too-many-members', proposalRowIds: ids(5001) });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/max 5000/);
    });

    it('applies the member cap after deduplicating IDs', async () => {
        const duplicated = ids(3000).concat(ids(3000));
        const res = await request(app).post('/plans').send({ slug: 'with-dupes', proposalRowIds: duplicated });
        expect(res.status, res.body && res.body.error).toBe(201);
        expect(res.body.proposalRowIds).toHaveLength(3000);
    });

    it('still refuses an empty plan', async () => {
        const res = await request(app).post('/plans').send({ slug: 'empty-plan', proposalRowIds: [] });
        expect(res.status).toBe(400);
    });
});
