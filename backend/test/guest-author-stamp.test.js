// The author an outgoing record carries (GuestPolicy.claimAuthorAgentId / outgoingAuthor): a record
// this profile created as a guest leaves the device under the name chosen since, while published
// records, other agents' records and unclaimed records keep theirs. Also drives the real store
// (proposals/data.js addProposal claims, setProposalAuthor) and storage.js stampCurrentAuthor.
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const policy = require('../../frontend/js/guest-policy.js');
const formationDepth = require('../../frontend/js/proposals/formation-depth.js');
const planOrder = require('../../frontend/js/proposals/plan-order.js');
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
    it('never renames a published or minted record', () => {
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
    install('__cbSecondaryTab', false);
    install('__formationDepth', formationDepth);
    install('__planOrder', planOrder);
    install('GuestPolicy', policy);
    install('getCurrentUserAgent', () => state.agent);
    install('normalizeParcelIdList', values => Array.from(new Set((values || []).map(String))));
    install('normalizeOwnerAcceptances', value => value || {});
    install('normalizeLensEntries', value => value || []);
    install('normalizeProposalStatusAxes', proposal => proposal);
    install('normalizeProposalGoalKey', value => String(value || '').trim().toLowerCase());
    install('isLocalProposalId', value => /^local-/.test(String(value || '')));
    install('PersistentStorage', fakeStorage());
    const store = (0, eval)(dataSource + '\n;proposalStorage');
    install('proposalStorage', store);
    install('isProposalImmutable', proposal => !!(proposal && (proposal.serverProposalId || proposal.isMinted === true)));
    const stampCurrentAuthor = (0, eval)(storageSource + '\n;stampCurrentAuthor');
    return { store, state, stampCurrentAuthor };
}

const park = (author, extra = {}) => ({
    goal: 'park', title: 'Park', author, cadastreParcelIds: ['HR-339164-2972'], applied: false, ...extra
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

    it('a published record keeps its guest author', () => {
        const { store, state, stampCurrentAuthor } = boot({ ...GUEST });
        const id = store.addProposal(park('Guest 4232', { serverProposalId: '1355' }));
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
        const source = store.addProposal(park('Someone else', { serverProposalId: '900' }));
        const fork = store.addProposal(park('Guest 4232', { sourceProposalId: source }));
        state.agent = { ...NAMED };
        expect(stampCurrentAuthor(store.getProposal(fork)).author).toBe('Mara');
        expect(store.getProposal(source).author).toBe('Someone else');
    });
});

describe('every outgoing path stamps the current author', () => {
    it('publish, share link and the share dialog mint call stampCurrentAuthor; the agent id stays on the device', () => {
        const upload = read('proposals/server-sync.js');
        const gate = upload.indexOf("guestPolicyBlocks('publish')");
        const stamp = upload.indexOf('stampCurrentAuthor(proposal)');
        expect(gate).toBeGreaterThan(-1);
        expect(stamp).toBeGreaterThan(gate);
        expect(stamp).toBeLessThan(upload.indexOf('prepareForPublish'));
        expect(read('proposals/sharing-routes.js')).toMatch(/deepClone\(stampCurrentAuthor\(proposal\)\)/);
        expect(read('proposals/dialog-upload.js')).toMatch(/const proposalAuthor = stampCurrentAuthor\(proposal\)\.author/);
        const create = read('proposals/create.js');
        const build = create.slice(create.indexOf('function buildUploadReadyProposal('));
        // The share dialog projects first and uploads the projection: the stamp must happen in
        // the projection, before the agent id that proves ownership is dropped.
        expect(build.indexOf('stampCurrentAuthor(proposal)')).toBeGreaterThan(-1);
        expect(build.indexOf('stampCurrentAuthor(proposal)')).toBeLessThan(build.indexOf('delete uploadProposal.authorAgentId'));
        expect(read('proposals/bootstrap.js')).toMatch(/window\.stampCurrentAuthor = stampCurrentAuthor/);
    });
});
