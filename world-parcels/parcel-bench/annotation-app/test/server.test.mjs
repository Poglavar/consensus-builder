import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createReviewServer } from '../server.mjs';

const TOKEN = 't'.repeat(40);
const ORIGIN = 'http://127.0.0.1:8787';
const created = [];
afterEach(async () => { for (const fn of created.splice(0).reverse()) await fn(); });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture({ basePath = '/review/', mutateBatch, mutateImage } = {}) {
    const root = await mkdtemp(join(tmpdir(), 'annotation-app-'));
    created.push(() => rm(root, { recursive: true, force: true }));
    const bundleDir = join(root, 'bundle'), dataDir = join(root, 'reviews');
    await mkdir(join(bundleDir, 'images'), { recursive: true });
    const image = Buffer.from('jpeg fixture bytes');
    await writeFile(join(bundleDir, 'images', 'sample-1.jpg'), mutateImage ? mutateImage(image) : image);
    const batch = {
        schema: 'plot-review-batch-v1', id: 'pilot-1', batch_hash: '',
        samples: [{ id: 'sample-1', width: 100, height: 100, bbox: [1, 2, 3, 4], crs: 'EPSG:3857', image: 'images/sample-1.jpg', image_sha256: hash(image), title: 'Sample imagery', attribution: 'Provider', license: 'Terms' }],
        tasks: [{ id: 'task-1', sample_id: 'sample-1', a: [20, 20], b: [70, 70] }],
    };
    const { batch_hash: _placeholder, ...payload } = batch;
    batch.batch_hash = hash(Buffer.from(JSON.stringify(payload)));
    const finalBatch = mutateBatch ? mutateBatch(batch) : batch;
    await writeFile(join(bundleDir, 'batch.json'), JSON.stringify(finalBatch));
    const server = await createReviewServer({ bundleDir, dataDir, token: TOKEN, basePath, publicOrigin: ORIGIN });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const base = `http://127.0.0.1:${server.address().port}${basePath}`;
    created.push(() => new Promise(resolve => server.close(resolve)));
    return { root, bundleDir, dataDir, server, base };
}

async function login(base, token = TOKEN, origin = ORIGIN) {
    const response = await fetch(`${base}api/session`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ token }) });
    return { response, cookie: response.headers.get('set-cookie')?.split(';')[0] };
}
const validReview = () => ({ id: 'task-1', sample_id: 'sample-1', a: [20, 20], b: [70, 70], relation: 'separate', trace: [], note: 'Check edge' });
async function put(base, cookie, body, origin = ORIGIN) {
    return fetch(`${base}api/reviews/${body.value.id}`, { method: 'PUT', headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

describe('annotation review server', () => {
    it('requires authentication for the batch, reviews and imagery while serving only the shell publicly', async () => {
        const { base } = await fixture();
        const shell = await fetch(`${base}model.mjs`);
        assert.equal(shell.status, 200);
        assert.equal((await shell.text()).includes('plot-review-batch-v1'), true);
        assert.equal((await fetch(`${base}api/batch`)).status, 401);
        assert.equal((await fetch(`${base}api/reviews`)).status, 401);
        assert.equal((await fetch(`${base}images/sample-1.jpg`)).status, 401);
        const { response, cookie } = await login(base);
        assert.equal(response.status, 200);
        assert.match(response.headers.get('set-cookie'), /HttpOnly/);
        assert.match(response.headers.get('set-cookie'), /SameSite=Strict/);
        assert.match(response.headers.get('set-cookie'), /Path=\/review\//);
        assert.equal((await fetch(`${base}api/batch`, { headers: { cookie } })).status, 200);
        const image = await fetch(`${base}images/sample-1.jpg`, { headers: { cookie } });
        assert.equal(image.status, 200);
        assert.match(image.headers.get('cache-control'), /immutable/);
        assert.equal(Buffer.from(await image.arrayBuffer()).toString(), 'jpeg fixture bytes');
        assert.equal((await fetch(`${base}../server.mjs`)).status, 404);
    });

    it('checks pinned origin and token, bounds JSON bodies, and rejects tokens in URLs', async () => {
        const { base } = await fixture();
        assert.equal((await login(base, 'x'.repeat(40))).response.status, 401);
        assert.equal((await login(base, TOKEN, 'https://other.example')).response.status, 403);
        const cookie = (await login(base)).cookie;
        assert.equal((await fetch(`${base}api/session?token=${TOKEN}`)).status, 400);
        const cross = await put(base, cookie, { batch_hash: 'a'.repeat(64), base_revision: 0, mutation_id: randomUUID(), value: validReview() }, 'https://other.example');
        assert.equal(cross.status, 403);
        const large = await fetch(`${base}api/session`, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ token: TOKEN, extra: 'z'.repeat(140_000) }) });
        assert.equal(large.status, 413);
    });

    it('persists revisions, serves idempotent retries and rejects stale/conflicting writes', async () => {
        const f = await fixture(), { cookie } = await login(f.base);
        const mutationId = randomUUID();
        const body = { batch_hash: (await (await fetch(`${f.base}api/batch`, { headers: { cookie } })).json()).batch_hash, base_revision: 0, mutation_id: mutationId, value: validReview() };
        const saved = await put(f.base, cookie, body);
        assert.equal(saved.status, 200);
        const record = await saved.json();
        assert.equal(record.revision, 1);
        assert.equal((await put(f.base, cookie, body)).status, 200);
        const changedRetry = await put(f.base, cookie, { ...body, value: { ...body.value, note: 'different' } });
        assert.equal(changedRetry.status, 409);
        const stale = await put(f.base, cookie, { ...body, mutation_id: randomUUID(), value: { ...body.value, note: 'second' } });
        assert.equal(stale.status, 409);
        assert.equal((await stale.json()).current.revision, 1);
        const exported = await (await fetch(`${f.base}api/reviews`, { headers: { cookie } })).json();
        assert.equal(exported.schema, 'plot-review-export-v1');
        assert.equal(exported.reviews.length, 1);
        assert.equal(exported.history.length, 1);
        assert.equal(JSON.parse(await readFile(join(f.dataDir, 'reviews.json'), 'utf8')).history.length, 1);
        await new Promise(resolve => f.server.close(resolve));
        const restarted = await createReviewServer({ bundleDir: f.bundleDir, dataDir: f.dataDir, token: TOKEN, basePath: '/review/', publicOrigin: ORIGIN });
        await new Promise((resolve, reject) => { restarted.once('error', reject); restarted.listen(0, '127.0.0.1', resolve); });
        const restartedBase = `http://127.0.0.1:${restarted.address().port}/review/`;
        created.push(() => new Promise(resolve => restarted.close(resolve)));
        const restartedCookie = (await login(restartedBase)).cookie;
        const restored = await (await fetch(`${restartedBase}api/reviews`, { headers: { cookie: restartedCookie } })).json();
        assert.equal(restored.reviews[0].revision, 1);
        assert.deepEqual(restored.reviews[0].value, record.value);
    });

    it('rejects a second writer process and releases its lock on server close', async () => {
        const f = await fixture();
        await assert.rejects(createReviewServer({ bundleDir: f.bundleDir, dataDir: f.dataDir, token: TOKEN, publicOrigin: ORIGIN }), /Another annotation server/);
        await new Promise(resolve => f.server.close(resolve));
        const second = await createReviewServer({ bundleDir: f.bundleDir, dataDir: f.dataDir, token: TOKEN, publicOrigin: ORIGIN });
        await new Promise((resolve, reject) => { second.once('error', reject); second.listen(0, '127.0.0.1', resolve); });
        created.push(() => new Promise(resolve => second.close(resolve)));
    });

    it('binds persisted data to the exact batch and checks bundle hashes at startup', async () => {
        const f = await fixture();
        const batchPath = join(f.bundleDir, 'batch.json');
        const batch = JSON.parse(await readFile(batchPath, 'utf8'));
        batch.samples[0].title = 'Changed under same hash';
        await writeFile(batchPath, JSON.stringify(batch));
        await new Promise(resolve => f.server.close(resolve));
        await assert.rejects(createReviewServer({ bundleDir: f.bundleDir, dataDir: join(f.root, 'new-data'), token: TOKEN, publicOrigin: ORIGIN }), /Batch hash/);
        const bad = await mkdtemp(join(tmpdir(), 'annotation-bad-image-'));
        created.push(() => rm(bad, { recursive: true, force: true }));
        await mkdir(join(bad, 'images'));
        await writeFile(join(bad, 'images', 'sample-1.jpg'), 'wrong bytes');
        const badBatch = JSON.parse(await readFile(batchPath, 'utf8'));
        const { batch_hash: _oldHash, ...badPayload } = badBatch;
        badBatch.batch_hash = hash(Buffer.from(JSON.stringify(badPayload)));
        await writeFile(join(bad, 'batch.json'), JSON.stringify(badBatch));
        await assert.rejects(createReviewServer({ bundleDir: bad, dataDir: join(f.root, 'bad-data'), token: TOKEN, publicOrigin: ORIGIN }), /Image hash mismatch/);
    });
});
