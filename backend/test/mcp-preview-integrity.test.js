import { createContext, runInContext } from 'node:vm';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { cidOfObject } from '../cid.js';
const script = readFileSync(new URL('../../frontend/js/draft-preview.js', import.meta.url), 'utf8');
describe('private agreement fragment integrity', () => {
    const first = { schema: 'design/v1', title: 'Linked' }, extra = { schema: 'design/v1', title: 'Unlinked' };
    for (const designs of [[first, extra], [extra], [first, first]]) it(`refuses ${designs.map(d => d.title).join(', ')} before binding or changing local records`, async () => {
        const apiBase = vi.fn(), fetch = vi.fn();
        const window = { location: { hash: '#draft=fixture' }, Cid: { cidOfObject }, fetch, DesignSync: { apiBase },
            DraftLink: { parse: async () => ({ agreement: { schema: 'agreement/v1', designs: [{ cid: cidOfObject(first) }] }, designs }) } };
        runInContext(script, createContext({ window }));
        await expect(window.DraftPreview.open()).rejects.toThrow(/exactly match/);
        expect(apiBase).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    });
    it.each([{ blocked: true, omitted: [] }, { blocked: false, omitted: ['skipped-design'] }])('respects the conflict choice before creating an agreement (%j)', async choice => {
        const applied = { applied: [], skipped: [], failed: [], ...choice }, save = vi.fn();
        const window = { location: { hash: '#draft=fixture' }, Cid: { cidOfObject },
            DraftLink: { parse: async () => ({ agreement: { schema:'agreement/v1', designs:[{cid:cidOfObject(first)}] }, designs:[first] }) },
            DesignSync: { apiBase: () => 'https://api.example', parcelSourceIdOf: () => 'fixture' },
            DesignRecord: { validate: () => ({valid:true}) }, __siteBinding: { siteOf: () => ({}) },
            fetch: async () => ({ok:true,json:async()=>({binding:{}})}),
            handleSharedDesignRoute: async () => applied, AgreementStore: { save } };
        runInContext(script, createContext({ window }));
        await expect(window.DraftPreview.open()).resolves.toBe(applied);
        expect(save).not.toHaveBeenCalled();
    });
});
