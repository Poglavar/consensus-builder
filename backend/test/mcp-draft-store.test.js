// Verify durable private draft recovery, source identity, expiry and bounded storage behavior.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { createPreviewLinks } from '../agents/mcp-preview-links.js';
import { createDraftStore, draftMembersMatch } from '../agents/mcp-draft-store.js';
import { canonicalBytes, cidOfObject } from '../cid.js';
const directories = [], stores = [];
const directory = () => { const path = mkdtempSync(join(tmpdir(), 'mcp-draft-test-')); directories.push(path); return path; };
afterEach(() => { for (const store of stores.splice(0)) store.dispose(); for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
const open = (storeDirectory, options = {}) => { const store = createPreviewLinks({ storeDirectory, origin: 'https://mcp.example', appOrigin: 'https://app.example', ...options }); stores.push(store); return store; };
const tokenOf = ref => new URL(ref).pathname.split('/').at(-1);
const design = title => ({ schema: 'design/v1', title, geometry: { type: 'Point', coordinates: [1, 2] } });
const PlanRecord = createRequire(import.meta.url)('../../frontend/js/plan-record.js');

describe('persistent private draft storage', () => {
    it('matches agreement members only through a verified plan, never inline legacy fields', () => {
        const member = design('Agreement member'), cid = cidOfObject(member);
        const content = PlanRecord.create('Agreement plan', [cid], { at: '45,15,17', mode: '2d' });
        const plan = { cid: cidOfObject(content), content };
        const agreement = { schema: 'agreement/v1', planCid: plan.cid };
        expect(draftMembersMatch(agreement, [{ cid }], plan)).toBe(true);
        expect(draftMembersMatch({ schema: 'agreement/v1', designs: [{ cid }] }, [{ cid }])).toBe(false);
        expect(draftMembersMatch(agreement, [{ cid }], { ...plan, cid: cidOfObject({ wrong: true }) })).toBe(false);
    });
    it('recovers the same bearer reference and exact canonical content after disposal and restart', async () => {
        const path = directory(), first = open(path), content = design('Exact record');
        const preview = first.create({ design: content, parcelSourceId: 'ground' });
        first.dispose();
        const recovered = open(path);
        expect(await recovered.resolve(preview.draftRef)).toEqual({ design: content, parcelSourceId: 'ground' });
        expect(canonicalBytes((await recovered.exportDraft(preview.draftRef)).design)).toEqual(canonicalBytes(content));
        expect(recovered.create({ design: content, parcelSourceId: 'ground' }).draftRef).toBe(preview.draftRef);
        expect(statSync(path).mode & 0o777).toBe(0o700);
        for (const name of readdirSync(path)) expect(statSync(join(path, name)).mode & 0o777).toBe(0o600);
    });
    it('retains collection membership and individual sources across restart and exports complete content', async () => {
        const path = directory(), first = open(path);
        const designs = [design('One'), design('Two')], designSources = { [cidOfObject(designs[0])]: 'ground-a', [cidOfObject(designs[1])]: 'ground-b' };
        const plan = { schema: 'plan/v1', designCids: designs.map(cidOfObject).sort() };
        const artifact = { plan, designs, designSources, parcelSourceId: null };
        const preview = first.create(artifact), before = first.get(tokenOf(preview.draftRef));
        first.dispose();
        const recovered = open(path), after = recovered.get(tokenOf(preview.draftRef));
        expect(after).toEqual(before);
        expect(await recovered.exportDraft(preview.draftRef)).toEqual(artifact);
        for (const member of after.designs) {
            const child = recovered.get(tokenOf(member.draftRef));
            expect(child.parcelSourceId).toBe(designSources[member.cid]);
            expect(cidOfObject(child.record)).toBe(member.cid);
        }
    });
    it('rejects new capacity without evicting or partly admitting a collection', async () => {
        const path = directory(), store = open(path, { maxEntries: 2 });
        const existing = store.create({ design: design('Existing') });
        const designs = [design('Member')], plan = { schema: 'plan/v1', designCids: designs.map(cidOfObject) };
        const artifact = { plan, designs };
        expect(store.create(artifact)).toMatchObject({ previewStatus: 'private-artifact', draftArtifact: artifact });
        expect(readdirSync(path).filter(name => name.endsWith('.json'))).toHaveLength(1);
        store.dispose();
        expect((await open(path).resolve(existing.draftRef)).design.title).toBe('Existing');
    });
    it('retains local collection links and all members indefinitely across restart without changing references', async () => {
        let time = 1_000;
        const path = directory(), options = { origin: 'http://localhost:4799', appOrigin: 'http://localhost:5680',
            now: () => time, maxEntries: 2 };
        const designs = [design('Local member')];
        const artifact = { plan: { schema: 'plan/v1', designCids: designs.map(cidOfObject) }, designs, parcelSourceId: 'ground' };
        const first = open(path, { ...options, ttlMs: 100 }), preview = first.create(artifact);
        const original = first.get(tokenOf(preview.draftRef));
        first.dispose();
        const retained = open(path, { ...options, ttlMs: null }), permanent = retained.create(artifact);
        expect(permanent.draftRef).toBe(preview.draftRef);
        expect(permanent.previewExpiresAt).toBeNull();
        retained.dispose();
        time = Date.UTC(2100, 0, 1);
        const recovered = open(path, { ...options, ttlMs: 100 });
        expect(recovered.get(tokenOf(preview.draftRef))).toEqual(original);
        expect(await recovered.resolve(preview.draftRef)).toEqual(artifact);
        expect(recovered.create(artifact)).toMatchObject({ draftRef: preview.draftRef, previewExpiresAt: null });
        expect(recovered.create({ design: design('Beyond capacity') }).previewStatus).toBe('private-artifact');
        recovered.clear();
        await expect(recovered.resolve(preview.draftRef)).rejects.toThrow(/unavailable or expired/);
    });
    it('permits non-expiring previews only when both preview and app origins are loopback', () => {
        expect(() => open(directory(), { ttlMs: null })).toThrow(/loopback/);
        expect(() => open(directory(), { ttlMs: null, origin: 'http://localhost:4799' })).toThrow(/loopback/);
        expect(() => open(directory(), { ttlMs: null, appOrigin: 'http://localhost:5680' })).toThrow(/loopback/);
    });
    it('honors advertised expiry after restart and admits replacements only after expiry', async () => {
        let time = 1_000;
        const path = directory(), options = { now: () => time, ttlMs: 100, maxEntries: 1 };
        const first = open(path, options), preview = first.create({ design: design('Expires') }); first.dispose();
        time = 1_099;
        const recovered = open(path, options);
        expect(await recovered.resolve(preview.draftRef)).toHaveProperty('design');
        expect(recovered.create({ design: design('Rejected') }).previewStatus).toBe('private-artifact');
        time = Date.parse(preview.previewExpiresAt);
        await expect(recovered.resolve(preview.draftRef)).rejects.toThrow(/unavailable or expired/);
        expect(recovered.create({ design: design('Replacement') }).previewStatus).toBe('private-link');
    });
    it('extends member retention with a reused collection without shortening older references', async () => {
        let time = 0;
        const path = directory(), options = { now: () => time, ttlMs: 100 };
        const store = open(path, options), content = design('Member');
        store.create({ design: content }); time = 90;
        const plan = { schema: 'plan/v1', designCids: [cidOfObject(content)] }, preview = store.create({ plan, designs: [content] });
        store.dispose(); time = 189;
        expect((await open(path, options).resolve(preview.draftRef)).designs).toEqual([content]);
    });
    it('isolates corrupt and tampered files without exposing their content or losing other references', async () => {
        const path = directory(), store = open(path);
        const good = store.create({ design: design('Good') }), corrupt = store.create({ design: design('Corrupt') });
        const corruptFile = join(path, `${tokenOf(corrupt.draftRef)}.json`);
        const entry = JSON.parse(readFileSync(corruptFile, 'utf8')); entry.row.record.title = 'Changed without changing CID';
        writeFileSync(corruptFile, JSON.stringify(entry));
        writeFileSync(join(path, `${'a'.repeat(32)}.json`), '{broken');
        store.dispose();
        const recovered = open(path);
        expect((await recovered.resolve(good.draftRef)).design.title).toBe('Good');
        await expect(recovered.resolve(corrupt.draftRef)).rejects.toThrow(/unavailable or expired/);
        expect(recovered.get('../escape')).toBeNull();
        recovered.clear();
        expect(readdirSync(path).filter(name => name.endsWith('.json'))).toEqual([]);
    });
    it('rejects collection metadata whose valid children differ from canonical membership', async () => {
        const path = directory(), store = open(path), first = design('Committed'), other = design('Other');
        const firstRef = store.create({ design: first }), otherRef = store.create({ design: other });
        const plan = { schema: 'plan/v1', designCids: [cidOfObject(first)] };
        expect(() => store.create({ plan, designs: [other] })).toThrow(expect.objectContaining({ code: 'invalid-draft-members' }));
        expect(() => store.create({ plan: { ...plan, designCids: [cidOfObject(first), cidOfObject(first)] }, designs: [first, other] }))
            .toThrow(expect.objectContaining({ code: 'invalid-draft-members' }));
        const preview = store.create({ plan, designs: [first] });
        const file = join(path, `${tokenOf(preview.draftRef)}.json`), entry = JSON.parse(readFileSync(file, 'utf8'));
        entry.row.designs = [{ cid: cidOfObject(other), draftRef: otherRef.draftRef }]; writeFileSync(file, JSON.stringify(entry)); store.dispose();
        const recovered = open(path);
        await expect(recovered.exportDraft(preview.draftRef)).rejects.toThrow(/unavailable or expired/);
        expect((await recovered.resolve(firstRef.draftRef)).design).toEqual(first);
        expect((await recovered.resolve(otherRef.draftRef)).design).toEqual(other);
    });
    it('refuses another writer in this process and releases ownership only on disposal', async () => {
        const path = directory(), store = open(path), preview = store.create({ design: design('Single writer') });
        expect(() => open(path)).toThrow(expect.objectContaining({ code: 'draft-store-locked' }));
        store.clear();
        expect(() => open(path)).toThrow(expect.objectContaining({ code: 'draft-store-locked' }));
        store.dispose();
        expect(open(path).get(tokenOf(preview.draftRef))).toBeNull();
    });
    it('refuses another process and reclaims its dead-PID claim after an unclean exit', async () => {
        const path = directory();
        const script = `import { createDraftStore } from ${JSON.stringify(new URL('../agents/mcp-draft-store.js', import.meta.url).href)};
createDraftStore({directory:process.argv[1]});process.stdout.write('ready\\n');setInterval(()=>{},1000);`;
        const child = spawn(process.execPath, ['--input-type=module', '-e', script, path], { stdio: ['ignore', 'pipe', 'pipe'] });
        try {
            await once(child.stdout, 'data');
            expect(() => open(path)).toThrow(expect.objectContaining({ code: 'draft-store-locked' }));
        } finally { child.kill('SIGKILL'); await once(child, 'exit'); }
        const recovered = open(path);
        expect(recovered.create({ design: design('Recovered writer') }).previewStatus).toBe('private-link');
        expect(readdirSync(path).filter(name => name.endsWith('.lock'))).toHaveLength(1);
    });
    it('requires explicit storage and distinguishes shutdown from destructive clear', () => {
        expect(() => createDraftStore({ directory: 'relative' })).toThrow(/absolute directory/);
        const path = directory(), first = open(path), preview = first.create({ design: design('Retained') });
        first.dispose();
        const recovered = open(path); expect(recovered.get(tokenOf(preview.draftRef))).not.toBeNull(); recovered.dispose();
        const destructive = open(path); destructive.clear(); destructive.dispose();
        const empty = open(path); expect(empty.get(tokenOf(preview.draftRef))).toBeNull(); empty.dispose();
        expect(readdirSync(path)).toEqual([]);
    });
});
