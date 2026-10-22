// The author an outgoing record carries (GuestPolicy.claimAuthorAgentId / outgoingAuthor): a record
// this profile created as a guest leaves the device under the name chosen since, while published
// records, other agents' records and unclaimed records keep theirs. Also drives the real store
// (proposals/data.js addProposal claims, setProposalAuthor), storage.js stampCurrentAuthor with the
// real immutability rule (proposals/lineage.js isPublished: published under a CID), and the
// one outgoing path that pins a design (proposals/design-sync.js publishDesign and pinDesign).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const proposalOrigin = require('../../frontend/js/proposals/origin.js');
const policy = require('../../frontend/js/guest-policy.js');
const formationDepth = require('../../frontend/js/proposals/formation-depth.js');
const planOrder = require('../../frontend/js/proposals/plan-order.js');
const Cid = require('../../frontend/js/cid.js');
const ProposalLineage = require('../../frontend/js/proposals/lineage.js');
const DesignSync = require('../../frontend/js/proposals/design-sync.js');
const PublishTerms = require('../../frontend/js/proposals/publish-terms.js');
const dataSource = readFileSync(new URL('../../frontend/js/proposals/data.js', import.meta.url), 'utf8');
const storageSource = readFileSync(new URL('../../frontend/js/proposals/storage.js', import.meta.url), 'utf8');
const read = rel => readFileSync(new URL(`../../frontend/js/${rel}`, import.meta.url), 'utf8');

const GUEST = { id: 'user_agent_1', name: 'Guest 4232', isGuest: true, userControlled: true };
const NAMED = { id: 'user_agent_1', name: 'Mara', isGuest: false, userControlled: true };

describe('GuestPolicy.claimAuthorAgentId', () => {
    it('claims a new record whose author is the current profile', () => {
        expect(policy.claimAuthorAgentId({ author: 'Guest 4232' }, GUEST)).toBe('user_agent_1');
    });
    it('leaves a record by another name unclaimed (an AI agent, someone else\'s import)', () => {
        expect(policy.claimAuthorAgentId({ author: 'Planner bot' }, GUEST)).toBeNull();
        expect(policy.claimAuthorAgentId({ author: '' }, GUEST)).toBeNull();
    });
    it('keeps an existing claim and needs a profile to claim', () => {
        expect(policy.claimAuthorAgentId({ author: 'Mara', authorAgentId: 'user_agent_9' }, NAMED)).toBe('user_agent_9');
        expect(policy.claimAuthorAgentId({ author: 'Mara' }, null)).toBeNull();
        expect(policy.claimAuthorAgentId({ author: 'Mara' }, { id: '', name: 'Mara' })).toBeNull();
    });
});

describe('GuestPolicy.outgoingAuthor', () => {
    const draft = { author: 'Guest 4232', authorAgentId: 'user_agent_1' };
    it('restamps this profile\'s draft with its current name', () => {
        expect(policy.outgoingAuthor(draft, NAMED, { immutable: false })).toEqual({ author: 'Mara', restamped: true, reason: null });
    });
    it('is a no-op when the name has not changed', () => {
        expect(policy.outgoingAuthor({ ...draft, author: 'Mara' }, NAMED)).toEqual({ author: 'Mara', restamped: false, reason: null });
    });
    it('never renames a published record', () => {
        expect(policy.outgoingAuthor(draft, NAMED, { immutable: true })).toMatchObject({ author: 'Guest 4232', restamped: false, reason: 'immutable' });
    });
    it('keeps the author of another profile\'s record, an unclaimed record, or with no profile', () => {
        expect(policy.outgoingAuthor({ ...draft, authorAgentId: 'ai_agent_3' }, NAMED).reason).toBe('other-profile');
        expect(policy.outgoingAuthor({ author: 'Guest 4232' }, NAMED).reason).toBe('unclaimed');
        expect(policy.outgoingAuthor(draft, null).reason).toBe('no-profile');
    });
});

// ---- the real store and the real stamp ----
const saved = new Map();
function install(name, value) {
    if (!saved.has(name)) saved.set(name, { existed: Object.prototype.hasOwnProperty.call(globalThis, name), value: globalThis[name] });
    globalThis[name] = value;
}
afterEach(() => {
    for (const [name, prior] of saved) {
        if (prior.existed) globalThis[name] = prior.value; else delete globalThis[name];
    }
    saved.clear();
});

function fakeStorage() {
    const values = new Map();
    return {
        values,
        getItem: key => (values.has(key) ? values.get(key) : null),
        setItem: (key, value) => values.set(key, String(value)),
        removeItem: key => values.delete(key),
        forEach: callback => values.forEach((value, key) => callback(value, key)),
        async atomicWrite(change) {
            (change.deletes || []).forEach(key => values.delete(key));
            (change.puts || new Map()).forEach((value, key) => values.set(key, String(value)));
        }
    };
}

function boot(profile) {
    const state = { agent: profile };
    install('window', globalThis);
    install('Cid', Cid);
    install('__cbSecondaryTab', false);
    install('__formationDepth', formationDepth);
    install('__planOrder', planOrder);
    install('GuestPolicy', policy);
    install('getCurrentUserAgent', () => state.agent);
    install('normalizeParcelIdList', values => Array.from(new Set((values || []).map(String))));
    install('normalizeLensEntries', value => value || []);
    install('normalizeProposalStatusAxes', proposal => proposal);
    install('normalizeProposalGoalKey', value => String(value || '').trim().toLowerCase());
    install('isLocalProposalId', value => /^local-/.test(String(value || '')));
    install('PersistentStorage', fakeStorage());
    const store = (0, eval)(dataSource + '\n;proposalStorage');
    install('proposalStorage', store);
    install('ProposalOrigin', proposalOrigin);
    // The stamp asks the production immutability rule (ProposalLineage.isPublished).
    install('ProposalLineage', ProposalLineage);
    const stampCurrentAuthor = (0, eval)(storageSource + '\n;stampCurrentAuthor');
    return { store, state, stampCurrentAuthor };
}

const API = 'https://api.example.test';
const PUBLISHED_CID = Cid.cidOfObject({ schema: 'design/v1', title: 'published elsewhere' });
const SITE = { type: 'Polygon', coordinates: [[[15.97, 45.8], [15.971, 45.8], [15.971, 45.801], [15.97, 45.801], [15.97, 45.8]]] };
// Each park has its own local key, so the store does not derive one from its geometry.
let parkSeq = 0;
const park = (author, extra = {}) => ({
    proposalId: `park-${++parkSeq}`, goal: 'park', title: 'Park', author, cadastreParcelIds: ['HR-339164-2972'], applied: false,
    site: SITE, structureProposal: { kind: 'park', geometry: SITE }, ...extra
});

describe('publishing a record made as a guest (the store and stampCurrentAuthor)', () => {
    it('a guest park, then a profile name, then publish: the outgoing record and the local draft carry the new name', () => {
        const { store, state, stampCurrentAuthor } = boot({ ...GUEST });
        const id = store.addProposal(park('Guest 4232'));
        expect(store.getProposal(id).authorAgentId).toBe('user_agent_1');

        state.agent = { ...NAMED }; // the welcome dialog renames the same agent in place
        const outgoing = stampCurrentAuthor(store.getProposal(id));
        expect(outgoing.author).toBe('Mara');
        expect(store.getProposal(id).author).toBe('Mara');
    });

    it('a published design keeps its guest author', () => {
        const { store, state, stampCurrentAuthor } = boot({ ...GUEST });
        const id = store.addProposal(park('Guest 4232', { published: { cid: PUBLISHED_CID, publishedAt: '2026-10-20T10:00:00.000Z', apiBase: API } }));
        state.agent = { ...NAMED };
        expect(stampCurrentAuthor(store.getProposal(id)).author).toBe('Guest 4232');
        expect(store.getProposal(id).author).toBe('Guest 4232');
    });

    it('an AI agent\'s record keeps its own author', () => {
        const { store, state, stampCurrentAuthor } = boot({ ...GUEST });
        const id = store.addProposal(park('Planner bot'));
        expect(store.getProposal(id).authorAgentId).toBeUndefined();
        state.agent = { ...NAMED };
        expect(stampCurrentAuthor(store.getProposal(id)).author).toBe('Planner bot');
    });

    it('a fork made before the name is chosen is the profile\'s own record too', () => {
        const { store, state, stampCurrentAuthor } = boot({ ...GUEST });
        const source = store.addProposal(park('Someone else', { published: { cid: PUBLISHED_CID, publishedAt: null, apiBase: API } }));
        const fork = store.addProposal(park('Guest 4232', { sourceProposalId: source }));
        state.agent = { ...NAMED };
        expect(stampCurrentAuthor(store.getProposal(fork)).author).toBe('Mara');
        expect(store.getProposal(source).author).toBe('Someone else');
    });
});

describe('every outgoing path stamps the current author', () => {
    // The browser part of proposals/design-sync.js over the real store and stamp, with a fake index:
    // POST /pins echoes the CID it is sent, POST /designs answers the indexed row.
    function publisher(store, stampCurrentAuthor) {
        const pinned = [];
        const fetch = vi.fn(async (url, init = {}) => {
            const body = JSON.parse(init.body);
            if (url.endsWith('/pins')) {
                pinned.push(JSON.parse(Buffer.from(body.bytes, 'base64').toString('utf8')));
                return { ok: true, status: 201, json: async () => ({ cid: body.cid, pinnedAt: '2026-10-21T10:00:00.000Z' }) };
            }
            return { ok: true, status: 201, json: async () => ({ cid: body.cid, createdAt: '2026-10-21T10:00:01.000Z' }) };
        });
        const win = {
            fetch, btoa: text => Buffer.from(text, 'binary').toString('base64'), resolveBackendBaseUrl: () => API,
            ProposalPublishTerms: PublishTerms, guestPolicyBlocks: () => null, stampCurrentAuthor, proposalStorage: store
        };
        return { api: DesignSync.browser(win).api, pinned, fetch };
    }

    it('publishing a guest-made design pins it under the current name, without the agent id that proves ownership', async () => {
        const { store, state, stampCurrentAuthor } = boot({ ...GUEST });
        const id = store.addProposal(park('Guest 4232'));
        state.agent = { ...NAMED };
        const { api, pinned } = publisher(store, stampCurrentAuthor);
        const { cid } = await api.publishDesign(store.getProposal(id));
        expect(pinned).toHaveLength(1);
        expect(pinned[0].author).toBe('Mara');
        expect(pinned[0]).not.toHaveProperty('authorAgentId');
        expect(Cid.cidOfObject(pinned[0])).toBe(cid);
        // The local draft carries the name it left the device with, and is now that published design.
        expect(store.getProposal(id)).toMatchObject({ author: 'Mara', authorAgentId: 'user_agent_1', published: { cid, apiBase: API } });
    });

    it('a design pinned for an agreement carries the current name too', async () => {
        const { store, state, stampCurrentAuthor } = boot({ ...GUEST });
        const id = store.addProposal(park('Guest 4232'));
        state.agent = { ...NAMED };
        const { api, pinned, fetch } = publisher(store, stampCurrentAuthor);
        const { content } = await api.pinDesign(store.getProposal(id));
        expect(content.author).toBe('Mara');
        expect(pinned[0].author).toBe('Mara');
        // Pinned only: a parcel layout is indexed with its agreement.
        expect(fetch.mock.calls.map(([url]) => url)).toEqual([`${API}/pins`]);
    });

    it('a published design is not sent again under a new name', async () => {
        const { store, state, stampCurrentAuthor } = boot({ ...GUEST });
        const id = store.addProposal(park('Guest 4232'));
        state.agent = { ...NAMED };
        const { api, fetch } = publisher(store, stampCurrentAuthor);
        const first = await api.publishDesign(store.getProposal(id));
        state.agent = { ...NAMED, name: 'Mara Horvat' };
        const again = await api.publishDesign(store.getProposal(id));
        expect(again).toEqual({ cid: first.cid, row: null, alreadyPublished: true });
        expect(store.getProposal(id).author).toBe('Mara');
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('the stamp is the window global the publisher calls', () => {
        expect(read('proposals/bootstrap.js')).toMatch(/window\.stampCurrentAuthor = stampCurrentAuthor/);
    });
});
