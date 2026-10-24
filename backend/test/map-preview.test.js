import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createMapPreviewService } from '../thumbnails/map-preview.js';

const CID_A = 'bafybeigdyrzt5sfp7udm7hu76uh6y26nfctev4x3b2sgj6xw4x5lq5m6ni';
const CID_B = 'bafybeihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku';
const dirs = [];
async function cacheDir() {
    const dir = await mkdtemp(path.join(tmpdir(), 'map-preview-test-'));
    dirs.push(dir);
    return dir;
}
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

function fixture(options = {}) {
    const calls = { load: [], render: [], save: [], exists: [] };
    const { files = new Set(), ...serviceOptions } = options;
    const designs = new Map([[CID_A, { cid: CID_A }], [CID_B, { cid: CID_B }]]);
    const load = vi.fn(async (_pool, cids) => {
        calls.load.push([...cids]);
        return new Map(cids.filter(cid => designs.has(cid)).map(cid => [cid, designs.get(cid)]));
    });
    const render = serviceOptions.render || vi.fn(async rows => { calls.render.push(rows.map(row => row.cid)); return Buffer.from('png'); });
    const save = vi.fn((_buffer, key) => {
        calls.save.push(key);
        const fileName = `${key}.png`;
        files.add(fileName);
        return { fileName, imagePath: `/unused/${fileName}` };
    });
    const exists = vi.fn(fileName => { calls.exists.push(fileName); return files.has(fileName); });
    const service = createMapPreviewService({ pool: {}, cacheDir: serviceOptions.cacheDir, load, render, save, exists, renderAttempts: 1, ...serviceOptions });
    return { service, calls, files, designs, load, render, save, exists };
}

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

describe('map preview service', () => {
    it('loads and renders every published member in sorted CID order', async () => {
        const dir = await cacheDir();
        const f = fixture({ cacheDir: dir });
        await f.service.prepare([CID_B, CID_A]);
        expect(f.load).toHaveBeenCalledOnce();
        expect(f.load.mock.calls[0][1]).toEqual([CID_A, CID_B]);
        expect(f.render.mock.calls[0][0].map(row => row.cid)).toEqual([CID_A, CID_B]);
        expect(f.save).toHaveBeenCalledOnce();
    });

    it('uses one key for reordered and duplicate CID lists and persists across service instances', async () => {
        const dir = await cacheDir();
        const first = fixture({ cacheDir: dir });
        const a = await first.service.prepare([CID_A, CID_B, CID_A]);
        const same = await first.service.prepare([CID_B, CID_A]);
        expect(same).toEqual(a);
        expect(first.load).toHaveBeenCalledOnce();
        const restarted = fixture({ cacheDir: dir, files: first.files });
        expect(await restarted.service.prepare([CID_B, CID_A])).toEqual(a);
        expect(restarted.load).not.toHaveBeenCalled();
        expect(restarted.render).not.toHaveBeenCalled();
    });

    it('regenerates a manifest whose image file is missing', async () => {
        const dir = await cacheDir();
        const first = fixture({ cacheDir: dir });
        await first.service.prepare([CID_A]);
        first.files.clear();
        const second = fixture({ cacheDir: dir });
        await second.service.prepare([CID_A]);
        expect(second.load).toHaveBeenCalledOnce();
        expect(second.render).toHaveBeenCalledOnce();
    });

    it('coalesces concurrent preparation for the same set', async () => {
        const dir = await cacheDir();
        const gate = deferred();
        const f = fixture({ cacheDir: dir, render: vi.fn(async rows => { await gate.promise; return Buffer.from(rows[0].cid); }) });
        const one = f.service.prepare([CID_A, CID_B]);
        const two = f.service.prepare([CID_B, CID_A]);
        await vi.waitFor(() => expect(f.render).toHaveBeenCalledOnce());
        gate.resolve();
        expect(await Promise.all([one, two])).toEqual([expect.objectContaining({ width: 1200 }), expect.objectContaining({ width: 1200 })]);
        expect(f.load).toHaveBeenCalledOnce();
        expect(f.render).toHaveBeenCalledOnce();
    });

    it('returns 404 without caching when any published member is missing', async () => {
        const dir = await cacheDir();
        const f = fixture({ cacheDir: dir });
        f.designs.delete(CID_B);
        await expect(f.service.prepare([CID_A, CID_B])).rejects.toMatchObject({ status: 404 });
        expect(f.render).not.toHaveBeenCalled();
        f.designs.set(CID_B, { cid: CID_B });
        await f.service.prepare([CID_A, CID_B]);
        expect(f.load).toHaveBeenCalledTimes(2);
    });

    it('does not cache failed renders and succeeds on retry', async () => {
        const dir = await cacheDir();
        const render = vi.fn().mockRejectedValueOnce(new Error('temporary render failure')).mockResolvedValueOnce(Buffer.from('png'));
        const f = fixture({ cacheDir: dir, render });
        await expect(f.service.prepare([CID_A])).rejects.toThrow('temporary render failure');
        await expect(f.service.prepare([CID_A])).resolves.toMatchObject({ width: 1200, height: 630 });
        expect(f.render).toHaveBeenCalledTimes(2);
    });

    it('retries a transient rendering failure once before completing the same request', async () => {
        const render = vi.fn().mockRejectedValueOnce(Object.assign(new Error('tile timeout'), { status: 503 }))
            .mockResolvedValueOnce(Buffer.from('png'));
        const f = fixture({ cacheDir: await cacheDir(), render, renderAttempts: 2 });
        await expect(f.service.prepare([CID_A])).resolves.toMatchObject({ width: 1200, height: 630 });
        expect(render).toHaveBeenCalledTimes(2);
        expect(f.save).toHaveBeenCalledOnce();
    });

    it('does not retry a permanent missing-geometry refusal', async () => {
        const render = vi.fn().mockRejectedValue(Object.assign(new Error('no geometry'), { status: 422 }));
        const f = fixture({ cacheDir: await cacheDir(), render, renderAttempts: 2 });
        await expect(f.service.prepare([CID_A])).rejects.toMatchObject({ status: 422 });
        expect(render).toHaveBeenCalledOnce();
    });

    it('rejects new distinct work at the active bound', async () => {
        const dir = await cacheDir();
        const gate = deferred();
        const entered = deferred();
        const render = vi.fn(async rows => { entered.resolve(); await gate.promise; return Buffer.from(rows[0].cid); });
        const f = fixture({ cacheDir: dir, maxQueued: 1, render });
        const pending = f.service.prepare([CID_A]);
        await entered.promise;
        await expect(f.service.prepare([CID_B])).rejects.toMatchObject({ status: 503 });
        gate.resolve();
        await pending;
    });

    it('rejects invalid CID lists before loading source designs', async () => {
        const f = fixture({ cacheDir: await cacheDir() });
        for (const value of [[], ['not-a-cid'], [CID_A, null], 'cid']) {
            await expect(f.service.prepare(value)).rejects.toMatchObject({ status: 400 });
        }
        expect(f.load).not.toHaveBeenCalled();
    });
});
