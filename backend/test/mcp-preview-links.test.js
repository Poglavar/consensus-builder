// Private draft URLs address stored objects; collection manifests never embed member geometry.
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPreviewLinks } from '../agents/mcp-preview-links.js';
import { previewArtifact } from '../agents/mcp-preview.js';
import { cidOfObject } from '../cid.js';
const links = createRequire(import.meta.url)('../../frontend/js/draft-link.js');
const PlanRecord = createRequire(import.meta.url)('../../frontend/js/plan-record.js');
const design = title => ({ schema: 'design/v1', title, geometry: { coordinates: Array.from({ length: 4000 }, (_, i) => [i / 31, i / 71]) } });
const planOf = designs => {
    const content = PlanRecord.create('Agreement plan', designs.map(cidOfObject).sort(), { at: '45,15,17', mode: '2d' });
    return { cid: cidOfObject(content), content };
};
const directories = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const storeOf = options => {
    const storeDirectory = mkdtempSync(join(tmpdir(), 'mcp-preview-test-')); directories.push(storeDirectory);
    return createPreviewLinks({ origin: 'https://mcp.example', appOrigin: 'https://app.example', storeDirectory, ...options });
};
const tokenOf = reference => new URL(reference).pathname.split('/').at(-1);
const fetchFrom = store => async url => { const row = store.get(tokenOf(url)); return Response.json(row || { code: 'preview-expired' }, { status: row ? 200 : 410 }); };

describe('temporary hosted MCP object references', () => {
    it('stores one object once, keeps URLs short, and loads its exact content without redirect or decoding', async () => {
        const store = storeOf(), content = design('Private site');
        const artifact = await previewArtifact({ design: content, parcelSourceId: 'chosen-source' });
        const result = store.decorate({ cid: cidOfObject(content), design: content, alternatives: [artifact, artifact] });
        const preview = result.alternatives[0];
        expect(result.design).toBe(content);
        expect(preview.previewStatus).toBe('private-link');
        expect(preview.previewUrl.length).toBeLessThan(250);
        expect(new URL(preview.previewUrl).hash).toBe('');
        expect(new URL(preview.previewUrl).searchParams.get('draft')).toBe(preview.draftRef);
        expect(preview.previewUrl).not.toContain('coordinates');
        expect(result.alternatives[1].draftRef).toBe(preview.draftRef);
        const decoded = await links.load(preview.previewUrl, { fetchImpl: fetchFrom(store), cidOf: cidOfObject });
        expect(decoded).toEqual({ design: content, parcelSourceId: 'chosen-source' });
        expect(await store.resolve(preview.draftRef)).toEqual(decoded);
        const copy = store.get(tokenOf(preview.draftRef)); copy.record.title = 'Changed outside store';
        expect((await store.resolve(preview.draftRef)).design.title).toBe('Private site');
    });
    it('keeps a large plan as references and fetches member objects individually with CID checks', async () => {
        const store = storeOf(), designs = Array.from({ length: 20 }, (_, i) => design(`Building ${i}`));
        const plan = { schema: 'plan/v1', title: 'A neighbourhood', designCids: designs.map(cidOfObject).sort(), view: {} };
        expect(JSON.stringify(designs).length).toBeGreaterThan(1_000_000);
        const preview = store.create({ plan, designs, parcelSourceId: 'ground' });
        const manifest = store.get(tokenOf(preview.draftRef));
        expect(JSON.stringify(manifest).length).toBeLessThan(8000);
        expect(JSON.stringify(manifest)).not.toContain('coordinates');
        expect(manifest.designs).toHaveLength(20);
        expect(manifest.designs.every(member => Object.keys(member).sort().join(',') === 'cid,draftRef')).toBe(true);
        let requests = 0;
        const restored = await links.load(preview.previewUrl, { fetchImpl: async url => { requests++; return fetchFrom(store)(url); }, cidOf: cidOfObject });
        expect(requests).toBe(21);
        expect(restored).toEqual({ plan, designs, parcelSourceId: 'ground' });
        expect(await store.resolve(preview.draftRef)).toEqual(restored);
    });
    it('loads a named plan with each member source and keeps agreements on one source', async () => {
        const store = storeOf(), designs = [design('First source'), design('Second source')];
        const designSources = { [cidOfObject(designs[0])]: 'ground-a', [cidOfObject(designs[1])]: 'ground-b' };
        const plan = { schema: 'plan/v1', designCids: designs.map(cidOfObject).sort() };
        const preview = store.create({ plan, designs, designSources });
        expect(await links.load(preview.previewUrl, { fetchImpl: fetchFrom(store), cidOf: cidOfObject }))
            .toEqual({ plan, designs, designSources, parcelSourceId: null });
        const wrongSource = async url => {
            const row = store.get(tokenOf(url));
            if (row.record.schema === 'design/v1') row.parcelSourceId = 'changed-source';
            return Response.json(row);
        };
        await expect(links.load(preview.previewUrl, { fetchImpl: wrongSource, cidOf: cidOfObject })).rejects.toThrow(/Invalid private collection member/);
        const agreementPlan = planOf(designs), agreement = { schema: 'agreement/v1', planCid: agreementPlan.cid };
        const mixed = store.create({ agreement, plan: agreementPlan, designs, designSources, parcelSourceId: 'ground-a' });
        await expect(links.load(mixed.previewUrl, { fetchImpl: fetchFrom(store), cidOf: cidOfObject })).rejects.toThrow(/Invalid private collection member/);
    });
    it('refuses agreement previews without the exact valid plan and rejects inline legacy membership', () => {
        const store = storeOf(), designs = [design('Agreement member')], plan = planOf(designs);
        expect(() => store.create({ agreement: { schema: 'agreement/v1', planCid: plan.cid }, designs }))
            .toThrow(expect.objectContaining({ code: 'invalid-draft-plan' }));
        expect(() => store.create({ agreement: { schema: 'agreement/v1', planCid: plan.cid }, plan: { ...plan, cid: cidOfObject({ wrong: true }) }, designs }))
            .toThrow(expect.objectContaining({ code: 'invalid-draft-plan' }));
        expect(() => store.create({ agreement: { schema: 'agreement/v1', planCid: plan.cid, designs: [{ cid: cidOfObject(designs[0]) }] }, plan, designs }))
            .toThrow(expect.objectContaining({ code: 'invalid-draft-plan' }));
    });
    it('rejects changed content and member redirects to another server before importing anything', async () => {
        const store = storeOf(), content = design('Original');
        const preview = store.create({ design: content });
        const changed = store.get(tokenOf(preview.draftRef)); changed.record.title = 'Tampered';
        await expect(links.load(preview.previewUrl, { cidOf: cidOfObject, fetchImpl: async () => Response.json(changed) })).rejects.toThrow(/content identifier/);
        const plan = { schema: 'plan/v1', designCids: [cidOfObject(content)] };
        const collection = store.create({ plan, designs: [content] });
        const manifest = store.get(tokenOf(collection.draftRef)); manifest.designs[0].draftRef = manifest.designs[0].draftRef.replace('mcp.example', 'other.example');
        await expect(links.load(collection.previewUrl, { cidOf: cidOfObject, fetchImpl: async () => Response.json(manifest) })).rejects.toThrow(/same preview server/);
    });
    it('does not apply the individual object limit to the combined designs of a collection', () => {
        const store = storeOf();
        const designs = [0, 1].map(index => ({ schema: 'design/v1', title: `Design ${index}`, description: 'x'.repeat(6 * 1024 * 1024) }));
        const plan = { schema: 'plan/v1', designCids: designs.map(cidOfObject).sort() };
        const preview = store.create({ plan, designs });
        expect(preview.previewStatus).toBe('private-link');
        const manifest = store.get(tokenOf(preview.draftRef));
        expect(JSON.stringify(manifest).length).toBeLessThan(1000);
        expect(manifest.designs.every(member => store.get(tokenOf(member.draftRef)))).toBe(true);
    });
    it('expires, bounds and clears private state without publication', async () => {
        let now = 0;
        const store = storeOf({ ttlMs: 100, maxEntries: 1, now: () => now });
        const first = store.create({ design: design('first') }), second = store.create({ design: design('second') });
        expect(store.get(tokenOf(first.draftRef)).record.title).toBe('first');
        expect(second).toMatchObject({ previewStatus: 'private-artifact', previewUrl: null });
        now = 100; expect(store.get(tokenOf(first.draftRef))).toBeNull();
        await expect(store.resolve(first.draftRef)).rejects.toMatchObject({ code: 'draft-reference-expired' });
        const third = store.create({ design: design('third') }); store.clear();
        expect(store.get(tokenOf(third.draftRef))).toBeNull();
        expect(() => storeOf({ origin: 'http://public.example' })).toThrow(/Invalid private draft/);
        expect(() => links.reference('https://mcp.example/mcp/previews/' + 'a'.repeat(32) + '#geometry')).toThrow();
    });
    it('retains an artifact when cache capacity cannot hold its members and never asks for publication', () => {
        const store = storeOf({ maxEntries: 1 }), content = design('Member');
        const plan = planOf([content]);
        const artifact = { agreement: { schema: 'agreement/v1', planCid: plan.cid }, plan, designs: [content] };
        const result = store.create(artifact);
        expect(result).toMatchObject({ previewUrl: null, previewStatus: 'private-artifact', draftArtifact: artifact });
        expect(result.next).toBeUndefined();
    });
    it('enforces a generous per-object bound without a compressed-URL limit', () => {
        const store = storeOf();
        expect(store.create({ design: { schema: 'design/v1', description: 'x'.repeat(2_000_000) } }).previewStatus).toBe('private-link');
        expect(() => store.create({ design: { schema: 'design/v1', description: 'x'.repeat(links.MAX_OBJECT_BYTES) } })).toThrow(/10 MiB/);
        const tightCache = storeOf({ maxBytes: links.MAX_OBJECT_BYTES });
        const artifact = { design: { schema: 'design/v1', description: 'x'.repeat(links.MAX_OBJECT_BYTES - 50) } };
        expect(tightCache.create(artifact)).toMatchObject({ previewStatus: 'private-artifact', draftArtifact: artifact });
    });
});
