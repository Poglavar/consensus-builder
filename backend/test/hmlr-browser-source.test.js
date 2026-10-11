import { afterEach, beforeAll, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import proj4 from 'proj4';
import { area as geoArea, intersect } from '@turf/turf';
import { HMLR_BROWSER_GROUND_POLICY, HMLR_BROWSER_GROUND_PREFIX } from '../parcels/hmlr-browser-ground.js';
import { createHmlrBrowserParcelSource, createMemoryHmlrFeatureStore } from '../parcels/hmlr-browser-source.js';
import { sha256Hex } from '../parcels/portable-hash.js';
import { createNodeHmlrFeatureStore } from '../parcels/node-hmlr-feature-store.js';

const SOURCE_DATE = '2026-10-11';
const DEFAULT_MANIFEST_URL = 'https://metadata.example/hmlr/manifest.json';
const LR = 'www.landregistry.gov.uk', GML = 'http://www.opengis.net/gml/3.2';
const coords = (x, y, size) => `${x} ${y} ${x + size} ${y} ${x + size} ${y + size} ${x} ${y + size} ${x} ${y}`;
const featureXml = (id, x, y, size) => `<wfs:member><lr:PREDEFINED g:id="row-${id}"><lr:INSPIREID>${id}</lr:INSPIREID><lr:GEOMETRY><g:MultiSurface srsName="urn:ogc:def:crs:EPSG::27700" srsDimension="2"><g:surfaceMember><g:Polygon><g:exterior><g:LinearRing><g:posList>${coords(x, y, size)}</g:posList></g:LinearRing></g:exterior></g:Polygon></g:surfaceMember></g:MultiSurface></lr:GEOMETRY></lr:PREDEFINED></wfs:member>`;
const xml = (features, sourceDate = SOURCE_DATE) => `<wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0" xmlns:lr="${LR}" xmlns:g="${GML}" timeStamp="${sourceDate}T08:30:00Z" numberMatched="${features.length}" numberReturned="${features.length}">${features.join('')}</wfs:FeatureCollection>`;
const response = (bytes, headers = {}, status = 200) => new Response(bytes, { status, headers: { 'content-length': String(bytes.byteLength), ...headers } });
const square = (id, x, y, size) => featureXml(id, x, y, size);

function fixture({ corruptArchiveSha = false, corruptZip = false, badShardHash = false, badShardUrl = false,
    sourceTimestamp = SOURCE_DATE, outOfManifestBounds = false, directoryOverride,
    versionedManifest = false, bulkFeatureCount = 0, authorityCount = 3 } = {}) {
    let manifestUrl = versionedManifest
        ? 'https://metadata.example/hmlr/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/manifest.json'
        : DEFAULT_MANIFEST_URL;
    const northRows = bulkFeatureCount
        ? Array.from({ length: bulkFeatureCount }, (_, i) => square(String(10000 + i), 530700 + (i % 100) * 30, 180100 + Math.floor(i / 100) * 30, 20))
        : [square('1001', 530800, 180200, 20)];
    const names = ['North', 'South', 'West'];
    while (names.length < authorityCount) names.push(`West ${names.length + 1}`);
    const archiveRows = names.map((_, index) => index === 0 ? northRows
        : index === 1 ? [square('1002', 530815, 180205, 20), square('1003', 530805, 180205, 2)]
            : index === 2 ? [square('9001', authorityCount > 3 ? 530800 : 700000, authorityCount > 3 ? 180210 : 600000, 20)]
                : [square(String(20000 + index), 530750 + (index - 3) * 40, 180150, 10)]);
    const archives = archiveRows.map((rows, index) => zipSync({ [`authority-${index}.gml`]: strToU8(xml(rows, sourceTimestamp)) }))
        .map(bytes => new Uint8Array(bytes));
    if (corruptZip) {
        const bytes = archives[1].slice(), view = new DataView(bytes.buffer), nameLength = view.getUint16(26, true), extraLength = view.getUint16(28, true);
        bytes[30 + nameLength + extraLength + 4] ^= 0x80; archives[1] = bytes;
    }
    const endpoints = names.map(name => `https://use-land-property-data.service.gov.uk/datasets/inspire/download/${name.toLowerCase().replaceAll(' ', '_')}.zip`);
    const idsByBucket = directoryOverride || (bulkFeatureCount
        ? Object.fromEntries([...northRows.map((_, i) => [String(10000 + i), [0]]), ['1002', [1]], ['1003', [1]], ['9001', [2]]])
        : { '1001': [0], '1002': [1], '1003': [1], '9001': [2] });
    for (let index = 3; index < names.length; index++) idsByBucket[String(20000 + index)] = [index];
    const shardContents = new Map();
    for (const [id, indices] of Object.entries(idsByBucket)) {
        const bucket = id.length < 4 ? id : id.slice(0, 4), entry = shardContents.get(bucket) || {};
        entry[id] = indices; shardContents.set(bucket, entry);
    }
    const shards = new Map([...shardContents].map(([bucket, content]) => {
        const bytes = strToU8(JSON.stringify(content));
        return [bucket, { bytes, sha256: sha256Hex(bytes) }];
    }));
    const authorityData = names.map((name, index) => ({ name, endpoint: endpoints[index], etag: `"release-${name.toLowerCase().replaceAll(' ', '_')}"`,
        bytes: archives[index].length, archiveSha256: sha256Hex(archives[index]), featureCount: index === 1 ? 2 : index === 0 ? northRows.length : 1,
        nativeBounds: index === 2 && authorityCount <= 3 ? [699900, 599900, 700100, 600100]
            : index === 0 && bulkFeatureCount ? [530600, 180000, 533800, 180500]
            : index === 0 && outOfManifestBounds ? [530700, 180100, 530810, 180300] : [530700, 180100, 530900, 180300],
        bounds: index === 2 && authorityCount <= 3 ? [1, 49, 2, 50]
            : index === 0 && bulkFeatureCount ? [-0.3, 51.3, 0, 51.7] : [-0.2, 51.4, -0.1, 51.6] }));
    if (corruptArchiveSha) authorityData[1].archiveSha256 = '0'.repeat(64);
    const idDirectoryCore = Object.fromEntries([...shards].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([bucket, shard]) => [bucket, { sha256: badShardHash && bucket === '1002' ? 'f'.repeat(64) : shard.sha256, bytes: shard.bytes.length }]));
    const core = { schemaVersion: 1, sourceDate: SOURCE_DATE, policy: HMLR_BROWSER_GROUND_POLICY,
        authorities: authorityData, idDirectory: idDirectoryCore };
    const releaseId = sha256Hex(JSON.stringify(core));
    if (versionedManifest) manifestUrl = `https://metadata.example/hmlr/${releaseId}/manifest.json`;
    const idDirectory = Object.fromEntries([...shards].map(([bucket, shard]) => {
        const sha = badShardHash && bucket === '1002' ? 'f'.repeat(64) : shard.sha256;
        const root = versionedManifest ? '/hmlr/' : '/hmlr/';
        const path = badShardUrl && bucket === '1002' ? `${root}unexpected/${releaseId}/ids/${bucket}.${sha}.json`
            : `${root}${releaseId}/ids/${bucket}.${sha}.json`;
        return [bucket, { url: `https://metadata.example${path}`, sha256: sha, bytes: shard.bytes.length }];
    }));
    const manifest = { schemaVersion: 1, sourceDate: SOURCE_DATE, policy: HMLR_BROWSER_GROUND_POLICY, releaseId,
        authorities: authorityData, idDirectory };
    const manifestBytes = strToU8(JSON.stringify(manifest));
    const archiveCalls = [], calls = [];
    const fetchImpl = async (url, options = {}) => {
        calls.push([String(url), options]);
        if (url === manifestUrl) return response(manifestBytes, { 'content-type': 'application/json' });
        for (let index = 0; index < endpoints.length; index++) if (url === endpoints[index]) {
            archiveCalls.push(index);
            return response(archives[index], { etag: authorityData[index].etag });
        }
        const shard = Object.entries(idDirectory).find(([, metadata]) => url === metadata.url)?.[0];
        const shardBytes = shard ? shards.get(shard)?.bytes : null;
        if (shardBytes) return response(shardBytes, { 'content-type': 'application/json' });
        return response(strToU8('missing'), {}, 404);
    };
    const storage = createMemoryHmlrFeatureStore();
    const descriptor = { id: 'gb-hmlr-browser-v1', adapter: 'hmlr-browser', idPrefix: HMLR_BROWSER_GROUND_PREFIX, manifestUrl };
    const create = (overrides = {}, options = {}) => createHmlrBrowserParcelSource({ ...descriptor, ...overrides }, {
        fetchImpl, featureStore: storage, cacheStorage: null, indexedDB: null, allowSample: true, ...options
    });
    return { manifest, releaseId, archives, archiveCalls, calls, fetchImpl, storage, create, authorityData, endpoints, northRows };
}

beforeAll(() => {
    proj4.defs('EPSG:27700', '+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy +towgs84=446.448,-125.157,542.06,0.1502,0.2470,0.8421,-20.4894 +units=m +no_defs');
});
afterEach(() => { vi.restoreAllMocks(); });

test.each(['missing-length', 'compressed-wire-length'])('reads verified decoded bytes with %s HTTP metadata', async mode => {
    const f = fixture();
    const fetchImpl = async (url, options) => {
        const original = await f.fetchImpl(url, options);
        const headers = new Headers(original.headers);
        if (mode === 'missing-length') headers.delete('content-length');
        else {
            // Fetch exposes decoded bytes even when headers describe the compressed wire body.
            headers.set('content-encoding', 'gzip');
            headers.set('content-length', '1');
        }
        return new Response(original.body, { status: original.status, headers });
    };
    const result = await f.create({}, { fetchImpl }).queryIds([`${HMLR_BROWSER_GROUND_PREFIX}1002`]);
    assert.equal(result.complete, true);
    assert.deepEqual(result.features.map(feature => feature.id), [`${HMLR_BROWSER_GROUND_PREFIX}1002`]);
});

test('cancels an oversized headerless manifest while reading its decoded stream', async () => {
    const f = fixture();
    let cancelled = false;
    const fetchImpl = async () => new Response(new ReadableStream({
        pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); },
        cancel() { cancelled = true; }
    }));
    await assert.rejects(f.create({}, { fetchImpl }).queryIds([`${HMLR_BROWSER_GROUND_PREFIX}1002`]), /exceeds.*byte limit/);
    assert.equal(cancelled, true);
    assert.equal(f.archiveCalls.length, 0);
});

test('a completed archive download timeout cannot abort local authority parsing', async () => {
    const f = fixture({ bulkFeatureCount: 600 }), downloadSignals = [];
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
        if (ms !== 180_000) return timeout(ms);
        const controller = new AbortController();
        downloadSignals.push(controller);
        return controller.signal;
    });
    const storage = {
        ...f.storage,
        async putBatch(...args) {
            // Model the network timer expiring after bytes arrived, during indexing.
            for (const controller of downloadSignals) controller.abort();
            return f.storage.putBatch(...args);
        }
    };
    const result = await f.create({}, { featureStore: storage }).queryIds([`${HMLR_BROWSER_GROUND_PREFIX}10000`]);
    assert.equal(result.complete, true);
    assert.equal(result.features[0].id, `${HMLR_BROWSER_GROUND_PREFIX}10000`);
    assert.equal((await storage.getAuthority(f.releaseId, 0)).ready, true);
    assert.equal((await storage.getIndex(f.releaseId, 0)).length, 600);
    assert.ok(downloadSignals.length > 0 && downloadSignals.every(controller => controller.signal.aborted));
});

test('archive request-budget exhaustion remains actionable instead of becoming provider unavailable', async () => {
    const f = fixture();
    const failure = Object.assign(new Error('Provider city probe reached its request limit'), { code: 'provider-probe-request-budget' });
    const source = f.create({}, { fetchImpl: async (url, options) => {
        if (f.endpoints.includes(url)) throw failure;
        return f.fetchImpl(url, options);
    } });
    await assert.rejects(source.queryIds([`${HMLR_BROWSER_GROUND_PREFIX}1002`]), error => error === failure);
    assert.equal((await f.storage.getAuthority(f.releaseId, 1)).ready, false);
});

test('fresh Node adapters share disk partitions and coalesce concurrent authority loads', async () => {
    const f = fixture(), store = createNodeHmlrFeatureStore();
    try {
        const first = f.create({}, { featureStore: store }), second = f.create({}, { featureStore: store });
        const results = await Promise.all([
            first.queryIds([`${HMLR_BROWSER_GROUND_PREFIX}1001`]),
            second.queryIds([`${HMLR_BROWSER_GROUND_PREFIX}1002`])
        ]);
        assert.ok(results.every(result => result.complete && result.features.length === 1));
        assert.deepEqual(f.archiveCalls.sort(), [0, 1]);
        const fresh = await f.create({}, { featureStore: store }).queryIds([`${HMLR_BROWSER_GROUND_PREFIX}1001`]);
        assert.equal(fresh.features[0].id, `${HMLR_BROWSER_GROUND_PREFIX}1001`);
        assert.equal(f.archiveCalls.length, 2);
    } finally { await store.dispose(); }
});

test('loads only viewport authorities, resolves cross-authority input context, and publishes uncut non-overlapping ground', async () => {
    const f = fixture(), source = f.create();
    const center = proj4('EPSG:27700', 'EPSG:4326', [530820, 180212]);
    const result = await source.queryBounds([center[0] - 0.00003, center[1] - 0.00003, center[0] + 0.00003, center[1] + 0.00003]);
    assert.equal(result.complete, true);
    assert.equal(result.snapshotId, f.releaseId);
    assert.deepEqual(f.archiveCalls.sort(), [0, 1]);
    assert.deepEqual(result.features.map(item => item.id).sort(), [`${HMLR_BROWSER_GROUND_PREFIX}1001`, `${HMLR_BROWSER_GROUND_PREFIX}1002`].sort());
    assert.equal(intersect(result.features[0], result.features[1]), null);
    assert.ok(result.features.some(item => geoArea(item) > 0));
    assert.ok(f.calls.filter(([url]) => url.includes('/datasets/inspire/download/')).every(([, options]) => options.headers.Accept === 'application/zip'));
    await source.queryBounds([center[0] - 0.00003, center[1] - 0.00003, center[0] + 0.00003, center[1] + 0.00003]);
    assert.equal(f.archiveCalls.length, 2);
});

test('cold authority archives load serially while same-authority work remains coalesced', async () => {
    const f = fixture({ authorityCount: 4 });
    let activeArchives = 0, peakArchives = 0;
    const fetchImpl = async (url, options) => {
        if (!f.endpoints.includes(url)) return f.fetchImpl(url, options);
        activeArchives++;
        peakArchives = Math.max(peakArchives, activeArchives);
        await new Promise(resolve => setTimeout(resolve, 8));
        try { return await f.fetchImpl(url, options); }
        finally { activeArchives--; }
    };
    const source = f.create({}, { fetchImpl });
    const center = proj4('EPSG:27700', 'EPSG:4326', [530820, 180210]);
    const result = await source.queryBounds([center[0] - 0.002, center[1] - 0.001, center[0] + 0.002, center[1] + 0.001]);
    assert.equal(result.complete, true);
    assert.deepEqual(f.archiveCalls.sort(), [0, 1, 2, 3]);
    assert.equal(peakArchives, 1);
});

test('ID shards resolve exact, suppressed, and truly absent IDs; missing catalog rows fail closed', async () => {
    const f = fixture(), source = f.create();
    const result = await source.queryIds([`${HMLR_BROWSER_GROUND_PREFIX}1002`, `${HMLR_BROWSER_GROUND_PREFIX}9999`]);
    assert.deepEqual(result.features.map(item => item.id), [`${HMLR_BROWSER_GROUND_PREFIX}1002`]);
    assert.deepEqual(result.absentIds, [`${HMLR_BROWSER_GROUND_PREFIX}9999`]);
    assert.deepEqual(f.archiveCalls.sort(), [0, 1]);
    const contained = await source.queryIds([`${HMLR_BROWSER_GROUND_PREFIX}1003`]);
    assert.deepEqual(contained.features, []);
    assert.deepEqual(contained.suppressedIds, [`${HMLR_BROWSER_GROUND_PREFIX}1003`]);
    assert.deepEqual(contained.absentIds, [`${HMLR_BROWSER_GROUND_PREFIX}1003`]);
    const accounted = new Set([...contained.features.map(feature => feature.id), ...contained.absentIds]);
    assert.deepEqual([...accounted], [`${HMLR_BROWSER_GROUND_PREFIX}1003`]);
    const missing = fixture({ directoryOverride: { '1002': [0] } });
    await assert.rejects(missing.create().queryIds([`${HMLR_BROWSER_GROUND_PREFIX}1002`]), /missing native parcel/);
});

test('concurrent ID requests coalesce authority downloads and use the same release edition', async () => {
    const f = fixture(), source = f.create();
    const [a, b] = await Promise.all([
        source.queryIds([`${HMLR_BROWSER_GROUND_PREFIX}1002`]),
        source.queryIds([`${HMLR_BROWSER_GROUND_PREFIX}1003`])
    ]);
    assert.equal(a.snapshotId, b.snapshotId);
    assert.equal(f.archiveCalls.filter(index => index === 0).length, 1);
    assert.equal(f.archiveCalls.filter(index => index === 1).length, 1);
});

test('GML batch writes are drained during parsing instead of accumulating the full authority', async () => {
    const f = fixture({ bulkFeatureCount: 1001 }), backing = createMemoryHmlrFeatureStore();
    let activeWrites = 0, peakWrites = 0, batchCount = 0;
    const featureStore = {
        getAuthority: (...args) => backing.getAuthority(...args),
        setAuthority: (...args) => backing.setAuthority(...args),
        clearAuthority: (...args) => backing.clearAuthority(...args),
        getIndex: (...args) => backing.getIndex(...args),
        getFeature: (...args) => backing.getFeature(...args),
        putBatch(releaseId, authorityIndex, records) {
            activeWrites++;
            batchCount++;
            peakWrites = Math.max(peakWrites, activeWrites);
            return new Promise((resolve, reject) => setTimeout(() => {
                backing.putBatch(releaseId, authorityIndex, records).then(resolve, reject).finally(() => { activeWrites--; });
            }, 8));
        }
    };
    const source = f.create({}, { featureStore });
    const result = await source.queryIds([`${HMLR_BROWSER_GROUND_PREFIX}10000`]);
    assert.deepEqual(result.features.map(feature => feature.id), [`${HMLR_BROWSER_GROUND_PREFIX}10000`]);
    assert.ok(batchCount >= 5, `expected several 250-feature writes; got ${batchCount}`);
    assert.ok(peakWrites <= 2, `pending writes grew to ${peakWrites}`);
    assert.equal((await backing.getIndex(f.releaseId, 0)).length, 1001);
    assert.equal((await backing.getAuthority(f.releaseId, 0)).ready, true);
});

test('rejects archive hash mismatch, bad ZIP CRC, bad shard hash, and snapshot edition mismatch without ready partial data', async () => {
    const wrongSha = fixture({ corruptArchiveSha: true });
    await assert.rejects(wrongSha.create().queryIds([`${HMLR_BROWSER_GROUND_PREFIX}1002`]), /SHA-256/);
    assert.equal((await wrongSha.storage.getAuthority(wrongSha.releaseId, 1)).ready, false);
    const badZip = fixture({ corruptZip: true });
    await assert.rejects(badZip.create().queryIds([`${HMLR_BROWSER_GROUND_PREFIX}1002`]), /ZIP|GML|archive/);
    assert.equal((await badZip.storage.getAuthority(badZip.releaseId, 1)).ready, false);
    const badShard = fixture({ badShardHash: true });
    await assert.rejects(badShard.create().queryIds([`${HMLR_BROWSER_GROUND_PREFIX}1002`]), /shard SHA-256/);
    const wrongEdition = fixture();
    await assert.rejects(wrongEdition.create({ snapshotId: 'f'.repeat(64) }).queryBounds([-0.12, 51.50, -0.11, 51.51]), /edition/);
    assert.deepEqual(wrongEdition.archiveCalls, []);
});

test('manifest, endpoint and ID URL validation reject arbitrary sources', () => {
    const f = fixture();
    assert.throws(() => f.create({ manifestUrl: 'http://metadata.example/hmlr/manifest.json' }), /HTTPS/);
    assert.throws(() => f.create({ idPrefix: 'GB-HMLR-GROUND-v1-' }), /descriptor/);
});

test('latest and versioned manifests accept only ID shards under their immutable release parent', async () => {
    const versioned = fixture({ versionedManifest: true });
    const result = await versioned.create().queryIds([`${HMLR_BROWSER_GROUND_PREFIX}1002`]);
    assert.deepEqual(result.features.map(feature => feature.id), [`${HMLR_BROWSER_GROUND_PREFIX}1002`]);
    const escaped = fixture({ badShardUrl: true });
    await assert.rejects(escaped.create().queryIds([`${HMLR_BROWSER_GROUND_PREFIX}1002`]), /escapes its immutable/);
    assert.deepEqual(escaped.archiveCalls, []);
});

test('a corrupted cached archive is deleted and recovered once from the pinned publisher', async () => {
    const f = fixture(), memory = new Map(), cacheName = 'hmlr-browser-ground-archives-v1';
    const cacheStorage = { async open(name) {
        assert.equal(name, cacheName);
        return {
            async match(key) { return memory.get(key) || null; },
            async put(key, value) { memory.set(key, value); },
            async delete(key) { return memory.delete(key); }
        };
    } };
    const authority = f.authorityData[1], key = new URL(`${f.releaseId}/${authority.archiveSha256}.zip`, new URL('./.archives/', DEFAULT_MANIFEST_URL)).href;
    memory.set(key, response(new Uint8Array(authority.bytes).fill(0x61)));
    const source = f.create({}, { cacheStorage });
    const result = await source.queryIds([`${HMLR_BROWSER_GROUND_PREFIX}1002`]);
    assert.equal(result.features.length, 1);
    assert.equal(f.archiveCalls.filter(index => index === 1).length, 1);
    const cached = new Uint8Array(await memory.get(key).arrayBuffer());
    assert.equal(sha256Hex(cached), authority.archiveSha256);

    const failing = fixture(), failedMemory = new Map(), failedAuthority = failing.authorityData[1];
    const failedKey = new URL(`${failing.releaseId}/${failedAuthority.archiveSha256}.zip`, new URL('./.archives/', DEFAULT_MANIFEST_URL)).href;
    failedMemory.set(failedKey, response(new Uint8Array(failedAuthority.bytes).fill(0x61)));
    const failingCache = { async open() { return {
        async match(url) { return failedMemory.get(url) || null; },
        async put(url, value) { failedMemory.set(url, value); },
        async delete(url) { return failedMemory.delete(url); }
    }; } };
    const sourceWithoutProvider = failing.create({}, { cacheStorage: failingCache,
        fetchImpl: async (url, options) => {
            if (url === failing.endpoints[1]) throw new Error('publisher offline');
            return failing.fetchImpl(url, options);
        } });
    await assert.rejects(sourceWithoutProvider.queryIds([`${HMLR_BROWSER_GROUND_PREFIX}1002`]), /unavailable/);
    assert.equal(failedMemory.has(failedKey), false);
});

test('incomplete or wrong-edition authority data never leaves a ready or queryable partition', async () => {
    const f = fixture(), originalFetch = f.fetchImpl;
    const brokenFetch = async (url, options) => {
        if (url === f.endpoints[1]) {
            const bytes = f.archives[1].slice(0, -8);
            return response(bytes, { etag: f.authorityData[1].etag, 'content-length': String(f.authorityData[1].bytes) });
        }
        return originalFetch(url, options);
    };
    const source = f.create({}, { fetchImpl: brokenFetch });
    await assert.rejects(source.queryIds([`${HMLR_BROWSER_GROUND_PREFIX}1002`]), /incomplete/);
    assert.equal((await f.storage.getAuthority(f.releaseId, 1)).ready, false);
    assert.deepEqual(await f.storage.getIndex(f.releaseId, 1), []);
    const retry = f.create();
    const loaded = await retry.queryIds([`${HMLR_BROWSER_GROUND_PREFIX}1002`]);
    assert.equal(loaded.features.length, 1);
    assert.equal((await f.storage.getAuthority(f.releaseId, 1)).ready, true);

    const wrongDate = fixture({ sourceTimestamp: '2026-10-10' });
    await assert.rejects(wrongDate.create().queryIds([`${HMLR_BROWSER_GROUND_PREFIX}1002`]), /date, CRS, or complete feature count/);
    assert.equal((await wrongDate.storage.getAuthority(wrongDate.releaseId, 1)).ready, false);
    assert.deepEqual(await wrongDate.storage.getIndex(wrongDate.releaseId, 1), []);
});

test('maximum native extent bounds are checked and tampered persisted indexes are discarded', async () => {
    const f = fixture({ outOfManifestBounds: true });
    await assert.rejects(f.create().queryIds([`${HMLR_BROWSER_GROUND_PREFIX}1001`]), /native extent/);
    assert.equal((await f.storage.getAuthority(f.releaseId, 0)).ready, false);

    const cached = fixture(), source = cached.create();
    await source.queryIds([`${HMLR_BROWSER_GROUND_PREFIX}1001`]);
    const rows = await cached.storage.getIndex(cached.releaseId, 0);
    const tamperedStore = {
        getAuthority: (...args) => cached.storage.getAuthority(...args),
        setAuthority: (...args) => cached.storage.setAuthority(...args),
        clearAuthority: (...args) => cached.storage.clearAuthority(...args),
        putBatch: (...args) => cached.storage.putBatch(...args),
        getFeature: (...args) => cached.storage.getFeature(...args),
        async getIndex(...args) {
            const index = await cached.storage.getIndex(...args);
            index[0] = { ...index[0], bboxNative: [1, 2, 3, 4] };
            return index;
        }
    };
    const repaired = await cached.create({}, { featureStore: tamperedStore }).queryIds([`${HMLR_BROWSER_GROUND_PREFIX}1001`]);
    assert.equal(repaired.features.length, 1);
    assert.equal(cached.archiveCalls.filter(index => index === 0).length, 2);
    assert.equal((await cached.storage.getAuthority(cached.releaseId, 0)).ready, true);
    assert.equal(rows.length, 1);

    const corrupted = fixture(), firstLoad = corrupted.create();
    await firstLoad.queryIds([`${HMLR_BROWSER_GROUND_PREFIX}1001`]);
    const narrowedStore = {
        getAuthority: (...args) => corrupted.storage.getAuthority(...args),
        setAuthority: (...args) => corrupted.storage.setAuthority(...args),
        clearAuthority: (...args) => corrupted.storage.clearAuthority(...args),
        putBatch: (...args) => corrupted.storage.putBatch(...args),
        getFeature: (...args) => corrupted.storage.getFeature(...args),
        async getIndex(...args) {
            const index = await corrupted.storage.getIndex(...args);
            index[0] = { ...index[0], bboxNative: [530700, 180100, 530710, 180110] };
            return index;
        }
    };
    await assert.rejects(corrupted.create({}, { featureStore: narrowedStore }).queryIds([`${HMLR_BROWSER_GROUND_PREFIX}1001`]), /disagrees with its conservative/);
    assert.equal((await corrupted.storage.getAuthority(corrupted.releaseId, 0)).ready, false);
    assert.deepEqual(await corrupted.storage.getIndex(corrupted.releaseId, 0), []);
});
