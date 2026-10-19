import { afterEach, test, expect } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodeHmlrFeatureStore } from '../parcels/node-hmlr-feature-store.js';

const releaseId = 'a'.repeat(64);
const row = (nativeId, marker) => ({ nativeId,
    bboxWgs: [-0.2, 51.4, -0.1, 51.5], bboxNative: [530700, 180100, 530900, 180300],
    feature: { type: 'Feature', id: `native-${nativeId}`, properties: { marker }, geometry: { type: 'Polygon', coordinates: [[[marker, 1], [marker + 1, 1], [marker + 1, 2], [marker, 1]]] } }
});

const stores = new Set();
afterEach(async () => {
    await Promise.all([...stores].map(store => store.dispose()));
    stores.clear();
});

test('stores geometry in a temporary file and reads a selected feature by byte offset', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'hmlr-feature-store-test-'));
    const store = createNodeHmlrFeatureStore({ baseDir }); stores.add(store);
    await store.setAuthority(releaseId, 2, { ready: false, featureCount: 2, archiveSha256: 'f'.repeat(64) });
    await store.putBatch(releaseId, 2, [row('10001', 1), row('10002', 3)]);
    const index = await store.getIndex(releaseId, 2);
    expect(index).toHaveLength(2);
    expect(index[0]).toEqual({ nativeId: '10001', bboxWgs: row('10001', 1).bboxWgs, bboxNative: row('10001', 1).bboxNative });
    expect(index[0]).not.toHaveProperty('feature');
    const [featureDir] = await readdir(baseDir);
    const [partitionFile] = await readdir(join(baseDir, featureDir));
    const serializedPartition = await readFile(join(baseDir, featureDir, partitionFile), 'utf8');
    expect(serializedPartition).toContain('"marker":1');
    expect(serializedPartition).toContain('"marker":3');
    await store.setAuthority(releaseId, 2, { ready: true, featureCount: 2, archiveSha256: 'f'.repeat(64) });
    expect(await store.getFeature(releaseId, 2, '10002')).toEqual(row('10002', 3).feature);
    expect(await store.getFeature(releaseId, 2, 'missing')).toBeNull();
    expect(await store.getAuthority(releaseId, 2)).toMatchObject({ ready: true, featureCount: 2 });
    await expect(store.putBatch(releaseId, 2, [row('10003', 5)])).rejects.toThrow(/immutable/);
    await expect(store.setAuthority(releaseId, 2, { ready: false })).rejects.toThrow(/immutable/);
    await store.dispose(); stores.delete(store);
    expect(await readdir(baseDir)).toEqual([]);
    await rm(baseDir, { recursive: true, force: true });
});

test('serializes concurrent batches, rejects duplicate identities, and clears every authority row', async () => {
    const store = createNodeHmlrFeatureStore(); stores.add(store);
    const otherRelease = 'b'.repeat(64);
    await Promise.all([
        store.putBatch(releaseId, 0, [row('20001', 1)]),
        store.putBatch(releaseId, 0, [row('20002', 2)])
    ]);
    await store.setAuthority(releaseId, 0, { ready: true, featureCount: 2 });
    expect((await store.getIndex(releaseId, 0)).map(item => item.nativeId)).toEqual(['20001', '20002']);
    expect(await store.getFeature(releaseId, 0, '20002')).toEqual(row('20002', 2).feature);
    expect(await store.getFeature(otherRelease, 0, '20002')).toBeNull();
    await expect(store.putBatch(otherRelease, 0, [row('30001', 3), row('30001', 4)])).rejects.toThrow(/Repeated/);
    expect(await store.getFeature(otherRelease, 0, '30001')).toBeNull();
    await store.clearAuthority(releaseId, 0);
    expect(await store.getAuthority(releaseId, 0)).toBeNull();
    expect(await store.getIndex(releaseId, 0)).toEqual([]);
    expect(await store.getFeature(releaseId, 0, '20001')).toBeNull();
});

test('coalesces only in-flight authority loads and drops failed promises for retry', async () => {
    const store = createNodeHmlrFeatureStore(); stores.add(store);
    let release, calls = 0;
    const first = store.withAuthorityLoad(releaseId, 4, () => {
        calls++;
        return new Promise(resolve => { release = resolve; });
    });
    const joined = store.withAuthorityLoad(releaseId, 4, async () => { calls++; return 'should not run'; });
    expect(joined).toBe(first);
    await Promise.resolve();
    expect(calls).toBe(1);
    release('loaded');
    await expect(first).resolves.toBe('loaded');

    await expect(store.withAuthorityLoad(releaseId, 4, async () => {
        calls++;
        throw new Error('transient load failure');
    })).rejects.toThrow('transient load failure');
    await expect(store.withAuthorityLoad(releaseId, 4, async () => {
        calls++;
        return 'reverified';
    })).resolves.toBe('reverified');
    expect(calls).toBe(3);
});

test('dispose removes its temporary feature directory and closes the store', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'hmlr-feature-store-cleanup-'));
    const store = createNodeHmlrFeatureStore({ baseDir });
    const [directory] = await readdir(baseDir);
    expect(directory).toMatch(/^hmlr-features-/);
    await store.putBatch(releaseId, 0, [row('40001', 4)]);
    await store.dispose();
    expect(await readdir(baseDir)).toEqual([]);
    await expect(store.getFeature(releaseId, 0, '40001')).rejects.toThrow(/disposed/);
    await rm(baseDir, { recursive: true, force: true });
});
