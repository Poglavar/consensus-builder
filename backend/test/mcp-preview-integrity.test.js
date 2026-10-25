import { createContext, runInContext } from 'node:vm';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { cidOfObject } from '../cid.js';
const script = readFileSync(new URL('../../frontend/js/draft-preview.js', import.meta.url), 'utf8');
describe('private agreement reference integrity', () => {
    const first = { schema: 'design/v1', title: 'Linked' }, extra = { schema: 'design/v1', title: 'Unlinked' };
    it('binds each named-plan member to its own recorded source when opening the preview', async () => {
        const firstCid = cidOfObject(first), extraCid = cidOfObject(extra), requests = [];
        const apply = vi.fn(async (_ids, { draftRows }) => ({ failed: [], rows: [...draftRows.values()] }));
        const window = { location: { href: 'https://app.example/designs?draft=fixture' }, Cid: { cidOfObject },
            DraftLink: { load: async () => ({ plan: { schema: 'plan/v1', designCids: [firstCid, extraCid] }, designs: [first, extra], designSources: { [firstCid]: 'source-one', [extraCid]: 'source-two' } }) },
            PlanRecord: { validate: () => null }, DesignRecord: { validate: () => ({ valid: true }) },
            DesignSync: { apiBase: () => 'https://api.example', parcelSourceIdOf: () => 'wrong-current-source' }, __siteBinding: { siteOf: () => ({}) },
            fetch: async (_url, options) => { requests.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ binding: {} }) }; },
            handleSharedDesignRoute: apply };
        runInContext(script, createContext({ window }));
        const result = await window.DraftPreview.open();
        expect(requests.map(row => row.parcelSourceId)).toEqual(['source-one', 'source-two']);
        expect(result.rows.map(row => row.parcelSourceId)).toEqual(['source-one', 'source-two']);
    });
    for (const designs of [[first, extra], [extra], [first, first]]) it(`refuses ${designs.map(d => d.title).join(', ')} before binding or changing local records`, async () => {
        const apiBase = vi.fn(), fetch = vi.fn();
        const window = { location: { href: 'https://app.example/designs?draft=https%3A%2F%2Fmcp.example%2Fmcp%2Fpreviews%2Faaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, Cid: { cidOfObject }, fetch, DesignSync: { apiBase },
            DraftLink: { load: async () => ({ agreement: { schema: 'agreement/v1', designs: [{ cid: cidOfObject(first) }] }, designs }) } };
        runInContext(script, createContext({ window }));
        await expect(window.DraftPreview.open()).rejects.toThrow(/exactly match/);
        expect(apiBase).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    });
    it.each([{ blocked: true, omitted: [] }, { blocked: false, omitted: ['skipped-design'] }])('respects the conflict choice before creating an agreement (%j)', async choice => {
        const applied = { applied: [], skipped: [], failed: [], ...choice }, save = vi.fn();
        const window = { location: { href: 'https://app.example/designs?draft=https%3A%2F%2Fmcp.example%2Fmcp%2Fpreviews%2Faaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, Cid: { cidOfObject },
            DraftLink: { load: async () => ({ agreement: { schema:'agreement/v1', designs:[{cid:cidOfObject(first)}] }, designs:[first] }) },
            DesignSync: { apiBase: () => 'https://api.example', parcelSourceIdOf: () => 'fixture' },
            DesignRecord: { validate: () => ({valid:true}) }, __siteBinding: { siteOf: () => ({}) },
            fetch: async () => ({ok:true,json:async()=>({binding:{}})}),
            handleSharedDesignRoute: async () => applied, AgreementStore: { save } };
        runInContext(script, createContext({ window }));
        await expect(window.DraftPreview.open()).resolves.toBe(applied);
        expect(save).not.toHaveBeenCalled();
    });
});
