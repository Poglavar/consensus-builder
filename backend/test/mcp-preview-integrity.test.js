import { createContext, runInContext } from 'node:vm';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { cidOfObject } from '../cid.js';
import { createRequire } from 'node:module';
const { mapLimit, CONCURRENCY } = createRequire(import.meta.url)('../../frontend/js/draft-link.js');
const script = readFileSync(new URL('../../frontend/js/draft-preview.js', import.meta.url), 'utf8');
describe('private collection reference integrity', () => {
    const first = { schema: 'design/v1', title: 'Linked' }, extra = { schema: 'design/v1', title: 'Unlinked' };
    const plan = { schema: 'plan/v1', designCids: [cidOfObject(first)] };
    const agreement = { schema: 'agreement/v1', planCid: cidOfObject(plan) };
    it('shows the load overlay with progress while binding several designs at once, and hides it on failure', async () => {
        const designs = Array.from({ length: 9 }, (_, i) => ({ schema: 'design/v1', title: `Tower ${i}` }));
        const cids = designs.map(cidOfObject), calls = [];
        let inFlight = 0, peak = 0;
        const windowFor = ok => ({ location: { href: 'https://app.example/designs?draft=fixture' }, Cid: { cidOfObject },
            DraftLink: { mapLimit, CONCURRENCY, load: async (_href, { onProgress }) => { onProgress({ done: 9, total: 9 }); return { plan: { schema: 'plan/v1', designCids: cids }, designs, parcelSourceId: 'ground' }; } },
            PlanRecord: { validate: () => null }, DesignRecord: { validate: () => ({ valid: true }) },
            DesignSync: { apiBase: () => 'https://api.example' }, __siteBinding: { siteOf: () => ({}) },
            fetch: async () => {
                inFlight++; peak = Math.max(peak, inFlight);
                await new Promise(resolve => setTimeout(resolve, 5));
                inFlight--;
                return ok ? { ok: true, json: async () => ({ binding: {} }) } : { ok: false, json: async () => ({ error: 'ground down' }) };
            },
            showProposalLoadOverlay: (status, options) => calls.push(['show', status, options.title]),
            updateProposalLoadOverlay: options => calls.push(['update', options.progress]),
            hideProposalLoadOverlay: () => calls.push(['hide']),
            handleSharedDesignRoute: async (ids, { draftRows }) => {
                calls.push(['apply', ids.length]);
                return { failed: [], rows: [...draftRows.values()], localIds: new Map(ids.map(id => [id, id])) };
            },
            proposalStorage: { getProposal: id => ({ proposalId: id }) },
            PlanWorkspace: { resolve: async row => row }, ClickStack: { showPlan: vi.fn() } });
        const window = windowFor(true);
        runInContext(script, createContext({ window }));
        const result = await window.DraftPreview.open();
        expect(result.rows.map(row => row.content.title)).toEqual(designs.map(d => d.title));
        expect(calls[0]).toEqual(['show', 'Fetching the shared designs…', 'Shared designs']);
        expect(calls).toContainEqual(['update', { done: 9, total: 9 }]);
        expect(calls.filter(call => call[0] === 'update').at(-1)).toEqual(['update', { done: 9, total: 9 }]);
        expect(calls.at(-1)).toEqual(['apply', 9]);
        expect(peak).toBeGreaterThan(1);
        expect(peak).toBeLessThanOrEqual(CONCURRENCY);

        calls.length = 0;
        const failing = windowFor(false);
        runInContext(script, createContext({ window: failing }));
        await expect(failing.DraftPreview.open()).rejects.toThrow(/ground down/);
        expect(calls.at(-1)).toEqual(['hide']);
        expect(calls.some(call => call[0] === 'apply')).toBe(false);
    });
    it('binds each named-plan member to its own source and opens the exact plan before its timeline', async () => {
        const firstCid = cidOfObject(first), extraCid = cidOfObject(extra), requests = [];
        const content = { schema: 'plan/v1', designCids: [firstCid, extraCid], schedule: { [firstCid]: { start: '2028-01', end: '2028-10' } } };
        const apply = vi.fn(async (ids, { draftRows }) => ({ failed: [], rows: [...draftRows.values()], localIds: new Map(ids.map(id => [id, `local-${id}`])) }));
        const resolve = vi.fn(async row => row), showPlan = vi.fn(), arrive = vi.fn();
        const window = { location: { href: 'https://app.example/designs?draft=fixture' }, Cid: { cidOfObject },
            DraftLink: { mapLimit, CONCURRENCY, load: async () => ({ plan: content, designs: [first, extra], designSources: { [firstCid]: 'source-one', [extraCid]: 'source-two' } }) },
            PlanRecord: { validate: () => null }, DesignRecord: { validate: () => ({ valid: true }) },
            DesignSync: { apiBase: () => 'https://api.example', parcelSourceIdOf: () => 'wrong-current-source' }, __siteBinding: { siteOf: () => ({}) },
            fetch: async (_url, options) => { requests.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ binding: {} }) }; },
            handleSharedDesignRoute: apply, proposalStorage: { getProposal: proposalId => ({ proposalId }) },
            PlanWorkspace: { resolve }, ClickStack: { showPlan }, BuildoutClock: { arrive } };
        runInContext(script, createContext({ window }));
        const result = await window.DraftPreview.open();
        expect(requests.map(row => row.parcelSourceId)).toEqual(['source-one', 'source-two']);
        expect(result.rows.map(row => row.parcelSourceId)).toEqual(['source-one', 'source-two']);
        const row = { cid: cidOfObject(content), content };
        const designs = [firstCid, extraCid].map(id => ({ proposalId: `local-${id}` }));
        expect(resolve).toHaveBeenCalledWith(row, designs);
        expect(showPlan).toHaveBeenCalledWith(row, { designs, draft: true, frame: false });
        expect(arrive).toHaveBeenCalledWith(row);
        expect(showPlan.mock.invocationCallOrder[0]).toBeLessThan(arrive.mock.invocationCallOrder[0]);
    });
    for (const designs of [[first, extra], [extra], [first, first]]) it(`refuses ${designs.map(d => d.title).join(', ')} before binding or changing local records`, async () => {
        const apiBase = vi.fn(), fetch = vi.fn();
        const window = { location: { href: 'https://app.example/designs?draft=https%3A%2F%2Fmcp.example%2Fmcp%2Fpreviews%2Faaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, Cid: { cidOfObject }, fetch, DesignSync: { apiBase },
            PlanRecord: { validate: () => null },
            DraftLink: { mapLimit, CONCURRENCY, load: async () => ({ agreement, plan, designs }) } };
        runInContext(script, createContext({ window }));
        await expect(window.DraftPreview.open()).rejects.toThrow(/exactly match/);
        expect(apiBase).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    });
    it.each([{ blocked: true, omitted: [] }, { blocked: false, omitted: ['skipped-design'] }])('respects the conflict choice before creating an agreement (%j)', async choice => {
        const applied = { applied: [], skipped: [], failed: [], ...choice }, save = vi.fn();
        const window = { location: { href: 'https://app.example/designs?draft=https%3A%2F%2Fmcp.example%2Fmcp%2Fpreviews%2Faaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, Cid: { cidOfObject },
            PlanRecord: { validate: () => null },
            DraftLink: { mapLimit, CONCURRENCY, load: async () => ({ agreement, plan, designs:[first] }) },
            DesignSync: { apiBase: () => 'https://api.example', parcelSourceIdOf: () => 'fixture' },
            DesignRecord: { validate: () => ({valid:true}) }, __siteBinding: { siteOf: () => ({}) },
            fetch: async () => ({ok:true,json:async()=>({binding:{}})}),
            handleSharedDesignRoute: async () => applied, AgreementStore: { save } };
        runInContext(script, createContext({ window }));
        await expect(window.DraftPreview.open()).resolves.toBe(applied);
        expect(save).not.toHaveBeenCalled();
    });
});
