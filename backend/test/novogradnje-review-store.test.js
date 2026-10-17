import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAnnotationStore } from '../floor-plans/review-annotations.js';
import { createReviewServer } from '../scripts/novogradnje-draft-review-server.mjs';

const draft = { unitId: 'S2', sourceSha256: 'a'.repeat(64), page: 1, draftId: 'b'.repeat(64), image: 'S2.jpg' };
const document = () => ({ schema: 'novogradnje.plan-annotations.v1', ...draft, revision: 0,
    shapes: [{ id: 'wall-1', type: 'wall', points: [[0.1, 0.2], [0.4, 0.2]], note: 'Missing partition' }], note: 'Bathroom at the top.' });
const cleanup = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function fixture(drafts = [draft]) {
    const directory = await mkdtemp(join(tmpdir(), 'plan-review-'));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const store = createAnnotationStore({ directory, drafts, now: () => '2026-10-14T12:00:00Z' });
    return { directory, store };
}

describe('durable floor plan review annotations', () => {
    it('saves, reads the persisted document, and survives a new store instance', async () => {
        const { directory, store } = await fixture();
        expect(await store.read('S2')).toMatchObject({ revision: 0, shapes: [], note: '' });
        expect(await readdir(directory)).toEqual([]);
        const saved = await store.write('S2', { ...document(), untrusted: 'discard', updatedAt: 'client-time' });
        expect(saved.revision).toBe(1);
        expect(saved.updatedAt).toBe('2026-10-14T12:00:00Z');
        expect(saved).not.toHaveProperty('untrusted');
        expect(saved).not.toHaveProperty('image');
        const fresh = createAnnotationStore({ directory, drafts: [draft] });
        expect(await fresh.read('S2')).toEqual(saved);
        const files = await readdir(directory);
        expect(files).toHaveLength(1);
        expect(JSON.parse(await readFile(join(directory, files[0]), 'utf8'))).toEqual(saved);
    });
    it('rejects stale saves and serializes concurrent revisions without losing an edit', async () => {
        const { store, directory } = await fixture();
        const results = await Promise.allSettled([
            store.write('S2', { ...document(), note: 'first' }),
            store.write('S2', { ...document(), note: 'second' }),
        ]);
        expect(results[0].status).toBe('fulfilled');
        expect(results[1].reason.status).toBe(409);
        expect((await store.read('S2')).note).toBe('first');
        await expect(store.write('S2', document())).rejects.toMatchObject({ status: 409 });
        const saved = await store.write('S2', { ...document(), revision: 1, shapes: [], note: '' });
        expect(saved).toMatchObject({ revision: 2, shapes: [], note: '' });
        expect(await readdir(directory)).toHaveLength(1);
    });
    it('copies in-flight input and retains the original source identity', async () => {
        const { store } = await fixture(), value = document();
        const pending = store.write('S2', value);
        value.shapes[0].points[0][0] = 0.9;
        expect((await pending).shapes[0].points[0][0]).toBe(0.1);
        for (const update of [{ unitId: 'S3' }, { sourceSha256: 'c'.repeat(64) }, { draftId: 'wrong' }, { page: 2 }]) {
            await expect(store.write('S2', { ...document(), ...update })).rejects.toMatchObject({ status: 400 });
        }
        await expect(store.read('../unknown')).rejects.toMatchObject({ status: 404 });
    });
    it('rejects invalid geometry, duplicate IDs and unbounded notes before writing', async () => {
        const { store, directory } = await fixture();
        const shape = document().shapes[0];
        for (const patch of [
            { revision: null }, { note: 'x'.repeat(2001) },
            { shapes: [shape, shape] }, { shapes: Array.from({ length: 201 }, (_, i) => ({ ...shape, id: 'w' + i })) },
            ...[null, Infinity, NaN, -0.1, 1.1].map(x => ({ shapes: [{ ...shape, points: [[x, 0.2], [0.3, 0.4]] }] })),
            { shapes: [{ ...shape, note: 'x'.repeat(501) }] },
            { shapes: [{ ...shape, type: 'note' }] },
        ]) await expect(store.write('S2', { ...document(), ...patch })).rejects.toMatchObject({ status: 400 });
        expect(await readdir(directory)).toEqual([]);
    });
    it('keeps annotations when a different draft of the same apartment is opened', async () => {
        const { directory, store } = await fixture();
        await store.write('S2', document());
        const newStore = createAnnotationStore({ directory, drafts: [{ ...draft, draftId: 'c'.repeat(64) }] });
        expect((await newStore.read('S2')).revision).toBe(0);
        expect((await store.read('S2')).revision).toBe(1);
    });
});

describe('temporary review HTTP boundary', () => {
    it('serves only review assets and bounded, same-origin annotation writes', async () => {
        const { directory } = await fixture();
        await writeFile(join(directory, 'drafts.json'), JSON.stringify([draft]));
        const server = await createReviewServer({ dataDirectory: directory });
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, resolve); });
        cleanup.push(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
        const base = `http://localhost:${server.address().port}`;
        const get = await fetch(base + '/api/annotations/S2');
        expect(get.headers.get('cache-control')).toContain('no-store');
        expect((await get.json()).revision).toBe(0);
        const save = (value, headers = {}) => fetch(base + '/api/annotations/S2', { method: 'PUT',
            headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(value) });
        expect((await save(document(), { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
        const saved = await save(document());
        expect(saved.status).toBe(200);
        expect((await saved.json()).revision).toBe(1);
        expect((await save(document())).status).toBe(409);
        expect((await save({ ...document(), note: 'x'.repeat(140000) })).status).toBe(413);
        expect((await fetch(base + '/.env')).status).toBe(404);
        expect((await fetch(base + '/api/annotations/unknown')).status).toBe(404);
        const index = await fetch(base + '/');
        expect(index.status).toBe(200);
        expect(await index.text()).toContain('annotation');
    });
});
