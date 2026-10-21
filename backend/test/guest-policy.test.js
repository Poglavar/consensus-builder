// Guest rules (frontend/js/guest-policy.js): device-local acts are open to guests and acts that leave
// the device need a profile name. Also checks that the browser gates are wired to the policy at the
// places acts leave the device: publishing a design (proposals/design-sync.js) and sharing the
// applied designs (proposals/sharing-routes.js).
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const policy = require('../../frontend/js/guest-policy.js');
const DesignSync = require('../../frontend/js/proposals/design-sync.js');
const PublishTerms = require('../../frontend/js/proposals/publish-terms.js');
const FRONTEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../frontend/js');
const read = rel => fs.readFileSync(path.join(FRONTEND, rel), 'utf8');

const GUEST = { isGuest: true };
const NAMED = { isGuest: false };

describe('GuestPolicy.requires', () => {
    it.each([
        ['create', 'none'], ['edit', 'none'], ['fork', 'none'], ['apply', 'none'], ['compare', 'none'],
        ['publish', 'name'], ['share', 'name'], ['mint', 'name'], ['joinList', 'name']
    ])('%s -> %s', (action, requirement) => {
        expect(policy.requires(action)).toBe(requirement);
    });

    it('throws on an action it does not know, instead of letting it through', () => {
        expect(() => policy.requires('deleteEverything')).toThrow(/unknown action/);
        // Offering one's land is no longer an act of a design (owner offers went with the terms).
        expect(() => policy.requires('ownerOffer')).toThrow(/unknown action/);
    });
});

describe('GuestPolicy.check', () => {
    it('lets a guest do everything that stays on the device', () => {
        for (const action of ['create', 'edit', 'fork', 'apply', 'compare']) {
            expect(policy.check(action, GUEST)).toMatchObject({ allowed: true, missing: [] });
        }
    });

    it('asks a guest for a name for everything that leaves the device, and nothing more', () => {
        for (const action of ['publish', 'share', 'mint', 'joinList']) {
            expect(policy.check(action, GUEST)).toMatchObject({ allowed: false, missing: ['name'] });
            expect(policy.check(action, NAMED).allowed).toBe(true);
        }
    });

    it('treats unknown facts as unmet (no profile = guest)', () => {
        expect(policy.missing('publish', {})).toEqual(['name']);
        expect(policy.missing('publish', undefined)).toEqual(['name']);
    });
});

// The browser part of proposals/design-sync.js over a fake index: POST /pins echoes the CID it is
// sent, POST /designs answers the indexed row.
function designPublisher(profile) {
    const fetch = vi.fn(async (url, init = {}) => {
        const body = init.body ? JSON.parse(init.body) : null;
        const answer = url.endsWith('/pins') ? { cid: body.cid, pinnedAt: '2026-10-21T10:00:00.000Z' }
            : { cid: body.cid, createdAt: '2026-10-21T10:00:01.000Z' };
        return { ok: true, status: 201, json: async () => answer };
    });
    const win = {
        fetch,
        btoa: text => Buffer.from(text, 'binary').toString('base64'),
        resolveBackendBaseUrl: () => 'https://api.example.test',
        ProposalPublishTerms: PublishTerms,
        guestPolicyBlocks: vi.fn(action => (policy.check(action, profile).allowed ? null : 'Choose a profile name to publish.')),
        stampCurrentAuthor: vi.fn(record => record),
        proposalStorage: { getProposal: () => null, _indexProposal: vi.fn(), save: vi.fn() }
    };
    return { win, api: DesignSync.browser(win).api, fetch };
}
const SITE = { type: 'Polygon', coordinates: [[[15.97, 45.8], [15.971, 45.8], [15.971, 45.801], [15.97, 45.801], [15.97, 45.8]]] };
const park = () => ({ proposalId: 'park-1', goal: 'park', title: 'Park', author: 'Guest 4232', site: SITE,
    createdAt: '2026-10-20T09:00:00.000Z', structureProposal: { kind: 'park', geometry: SITE } });

describe('browser gates follow the policy', () => {
    it('the old blanket "personalize to create" gate is gone everywhere', () => {
        const offenders = [];
        const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).forEach(entry => {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) return walk(full);
            if (entry.name.endsWith('.js') && fs.readFileSync(full, 'utf8').includes('requirePersonalizedUser')) offenders.push(full);
        });
        walk(FRONTEND);
        expect(offenders).toEqual([]);
    });

    it('every name gate names an action the policy gates on a name', () => {
        const calls = [];
        const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).forEach(entry => {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) return walk(full);
            if (!entry.name.endsWith('.js')) return;
            for (const m of fs.readFileSync(full, 'utf8').matchAll(/guestPolicyBlocks\('([^']+)'\)/g)) calls.push(m[1]);
        });
        walk(FRONTEND);
        // Publishing a design, proposing an agreement and sharing the applied designs.
        expect(calls.length).toBeGreaterThanOrEqual(3);
        for (const action of calls) expect(policy.requires(action)).toBe('name');
    });

    it('a guest publishing a design is stopped before anything is pinned or restamped', async () => {
        const { win, api, fetch } = designPublisher(GUEST);
        await expect(api.publishDesign(park())).rejects.toMatchObject({ code: 'name-needed', cancelled: true });
        expect(win.guestPolicyBlocks).toHaveBeenCalledWith('publish');
        expect(fetch).not.toHaveBeenCalled();
        expect(win.stampCurrentAuthor).not.toHaveBeenCalled();
    });

    it('a named profile publishes: the author is stamped before the design is pinned and indexed', async () => {
        const { win, api, fetch } = designPublisher(NAMED);
        const design = park();
        const result = await api.publishDesign(design);
        expect(win.guestPolicyBlocks).toHaveBeenCalledWith('publish');
        expect(win.stampCurrentAuthor).toHaveBeenCalledWith(design);
        expect(win.stampCurrentAuthor.mock.invocationCallOrder[0]).toBeLessThan(fetch.mock.invocationCallOrder[0]);
        expect(fetch.mock.calls.map(([url]) => url)).toEqual(['https://api.example.test/pins', 'https://api.example.test/designs']);
        expect(design.published).toEqual({ cid: result.cid, publishedAt: '2026-10-21T10:00:01.000Z', apiBase: 'https://api.example.test' });
    });

    it('sharing the applied designs asks for a name before the share panel opens', () => {
        const sharing = read('proposals/sharing-routes.js');
        const share = sharing.slice(sharing.indexOf('function shareAppliedProposals('));
        const gate = share.indexOf("guestPolicyBlocks('share')");
        expect(gate).toBeGreaterThan(-1);
        expect(gate).toBeLessThan(share.indexOf('showSharePlanPanel('));
    });
});
