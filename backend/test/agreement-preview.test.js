import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAgreementPreviewService, AGREEMENT_PREVIEW_REVISION } from '../thumbnails/agreement-preview.js';

const CID = 'bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq';
const subject = { cid: CID, city: 'zagreb', designs: [{ content: { schema: 'design/v1' }, binding: {} }], inputParcelIds: [] };
const png = Buffer.from('89504e470d0a1a0a', 'hex');

const dirs = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true }))); });

async function harness(render, options = {}) {
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agreement-preview-test-'));
    dirs.push(cacheDir);
    let serial = 0;
    const save = vi.fn(async (buffer, name) => {
        const file = path.join(cacheDir, `${name}-${++serial}.png`);
        await fs.writeFile(file, buffer);
        return { imagePath: `/uploads/images/${path.basename(file)}`, fileName: path.basename(file) };
    });
    const exists = name => Boolean(name) && existsSync(path.join(cacheDir, name));
    return { cacheDir, save, service: createAgreementPreviewService({ cacheDir, render, save, exists, concurrency: 2, ...options }) };
}

describe('agreement model preview cache', () => {
    it('deduplicates concurrent and repeated renders and returns all cached views', async () => {
        const render = vi.fn(async () => ({ after: png, before: png, pair: png, baselineComplete: true }));
        const { service, save, cacheDir } = await harness(render);
        const [one, two] = await Promise.all([service.prepare(CID, subject), service.prepare(CID, subject)]);
        expect(one).toEqual(two);
        expect(one.after).toMatch(/^\/uploads\/images\//);
        expect(one.before).toBeTruthy(); expect(one.pair).toBeTruthy();
        expect(render).toHaveBeenCalledOnce(); expect(save).toHaveBeenCalledTimes(3);
        expect(await service.prepare(CID, subject)).toEqual(one);
        expect(render).toHaveBeenCalledOnce();
        const files = await fs.readdir(cacheDir);
        expect(files.some(file => file.startsWith(`${AGREEMENT_PREVIEW_REVISION}-${CID}`))).toBe(true);
    });

    it('returns null views for a renderer with no visual change without poisoning a later retry', async () => {
        const render = vi.fn()
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ after: png, before: null, pair: null, baselineComplete: false });
        const { service, save } = await harness(render);
        await expect(service.prepare(CID, subject)).resolves.toMatchObject({ after: null, before: null, pair: null });
        const recovered = await service.prepare(CID, subject);
        expect(recovered.after).toMatch(/^\/uploads\/images\//);
        expect(recovered.before).toBeNull(); expect(recovered.pair).toBeNull();
        expect(render).toHaveBeenCalledTimes(2); expect(save).toHaveBeenCalledOnce();
    });

    it('rejects an agreement whose design records cannot all be loaded', async () => {
        const pool = { query: vi.fn(async () => ({ rows: [{ cid: CID, city: 'zagreb', design_cids: ['missing'], input_parcel_ids: [] }] })) };
        const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agreement-preview-test-'));
        dirs.push(cacheDir);
        const service = createAgreementPreviewService({ pool, cacheDir, load: async () => new Map(), render: vi.fn() });
        await expect(service.prepare(CID)).rejects.toMatchObject({ status: 404 });
    });

    it('keeps a partial preview until retry, then publishes both views from the recovered scene', async () => {
        let time = 0;
        const render = vi.fn().mockResolvedValueOnce({ after: png, before: null, pair: null, baselineComplete: false })
            .mockResolvedValueOnce({ after: Buffer.concat([png, Buffer.from('with neighbours')]), before: png, pair: png, baselineComplete: true });
        const { service, save } = await harness(render, { now: () => time, retryMs: 100 });
        const partial = await service.prepare(CID, subject);
        expect(await service.prepare(CID, subject)).toEqual(partial);
        expect(save).toHaveBeenCalledTimes(1);
        time = 101;
        const recovered = await service.prepare(CID, subject);
        expect(recovered.before).toBeTruthy();
        expect(recovered.pair).toBeTruthy();
        expect(recovered.after).not.toEqual(partial.after);
        expect(await service.prepare(CID, subject)).toEqual(recovered);
        expect(render).toHaveBeenCalledTimes(2);
    });

    it('keeps a completed pair when another worker finishes a partial render later', async () => {
        let started, release;
        const running = new Promise(resolve => { started = resolve; });
        const partial = new Promise(resolve => { release = resolve; });
        const h = await harness(async () => { started(); return partial; });
        const slow = h.service.prepare(CID, subject);
        await running;
        const fast = createAgreementPreviewService({ cacheDir: h.cacheDir, save: h.save, exists: () => true,
            render: async () => ({ after: png, before: png, pair: png, baselineComplete: true }) });
        const complete = await fast.prepare(CID, subject);
        release({ after: png, before: null, pair: null, baselineComplete: false });
        await slow;
        expect(await h.service.prepare(CID, subject)).toEqual(complete);
    });
});
