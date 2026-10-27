// Geographic tile conversion and exact references must behave identically in both runtimes.
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { PbfWriter } from 'pbf';
import { createHash } from 'node:crypto';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';
import { validateParcelProviderRelayRequest } from '../parcels/provider-relay.js';

const d = { id: 'geographic-test', adapter: 'vector-tiles', idPrefix: 'GEO-TEST-',
    endpoint: 'https://tiles.example.test/parcels/{z}/{x}/{y}.pbf', zoom: 12,
    layer: 'parcels', extent: 4096, tileMatrix: 'geographic-2x1', geometryMode: 'interior-only',
    identityKind: 'geometry-sha256-v1', outFields: [], idLookupBounds: [85.97, 44.34, 85.99, 44.37] };
function encode({ shift = 0, extent = 4096, includeEdge = true, label = 'discard-me' } = {}) {
    const p = new PbfWriter();
    p.writeMessage(3, (_, layer) => {
        layer.writeStringField(1, 'parcels'); layer.writeVarintField(15, 2); layer.writeVarintField(5, extent);
        layer.writeStringField(3, 'ignored');
        layer.writeMessage(4, (_, w) => w.writeStringField(1, label));
        for (const x of includeEdge ? [1000 + shift, 0] : [1000 + shift]) layer.writeMessage(2, (_, w) => {
            w.writePackedVarint(2, [0, 0]); w.writeVarintField(3, 3);
            w.writePackedVarint(4, [9, x * 2, 2000, 26, 200, 0, 0, 200, 199, 0, 15]);
        });
    });
    return p.finish();
}
const fetcher = bytes => async url => {
    assert.equal(url, 'https://tiles.example.test/parcels/12/3026/519.pbf');
    return new Response(bytes);
};
const view = [85.978, 44.36, 85.982, 44.365];
it('preserves top-left geographic vertices, drops attributes and edge fragments, and independently rereads exact hashes in both runtimes', async () => {
    let calls = 0;
    const fetchImpl = async url => { calls++; return fetcher(encode())(url); };
    const a = createParcelSource(d, { fetchImpl });
    const result = await a.queryBounds(view);
    assert.equal(result.features.length, 1);
    const parcel = result.features[0];
    const xy = (x, y) => [-180 + (3026 + x / 4096) * 360 / 4096, 90 - (519 + y / 4096) * 360 / 4096];
    const geometry = { type: 'Polygon', coordinates: [[xy(1000, 1000), xy(1100, 1000), xy(1100, 1100), xy(1000, 1100), xy(1000, 1000)]] };
    assert.deepEqual(parcel.geometry, geometry);
    const hash = createHash('sha256').update(`geographic-test\ngeographic-interior-v1\n12/3026/519\n${JSON.stringify(geometry)}`).digest('hex');
    assert.equal(parcel.id, `GEO-TEST-t1~12~3026~519~${hash}`);
    assert.equal(parcel.properties.sourceGeometryHash, hash);
    assert.deepEqual(parcel.properties.sourceProperties, {});
    assert.equal(result.excludedTileFragments, 1);
    assert.equal(result.citywideComplete, false);
    assert.equal(result.complete, true);
    assert.equal((await a.queryBounds([85.969, 44.36, 85.972, 44.365])).complete, false);
    for (const create of [createParcelSource, browserParcelFactories['vector-tiles']]) {
        const adapter = create(d, { fetchImpl });
        const exact = await adapter.queryIds([parcel.id]);
        assert.deepEqual(exact.features, [parcel]);
        assert.deepEqual(exact.absentIds, []);
        assert.deepEqual((await adapter.queryGeometry(geometry)).features, [parcel]);
    }
    assert.equal(calls, 3);
    const renamed = createParcelSource(d, { fetchImpl: fetcher(encode({ label: 'changed attributes' })) });
    assert.deepEqual((await renamed.queryIds([parcel.id])).features, [parcel]);
    const changed = createParcelSource(d, { fetchImpl: fetcher(encode({ shift: 1 })) });
    await assert.rejects(changed.queryIds([parcel.id]), /unresolved/);
    for (const id of [parcel.id.replace('~12~', '~13~'), parcel.id.replace('~3026~', '~03026~'), parcel.id.replace('~519~', '~520~'), 'foreign']) {
        await assert.rejects(a.queryIds([id]));
    }
});
it('retries transient failures, accepts empty tiles, and rejects resolution changes', async () => {
    let calls = 0;
    const adapter = createParcelSource(d, { fetchImpl: async () => { if (++calls === 1) throw Error('offline'); return new Response(encode()); } });
    await assert.rejects(adapter.queryBounds(view), /unavailable/);
    assert.equal((await adapter.queryBounds(view)).features.length, 1);
    for (const response of [new Response(new Uint8Array()), new Response(null, { status: 204 })]) {
        const empty = createParcelSource(d, { fetchImpl: async () => response });
        assert.deepEqual((await empty.queryBounds(view)).features, []);
    }
    const changed = createParcelSource(d, { fetchImpl: fetcher(encode({ extent: 8192 })) });
    await assert.rejects(changed.queryBounds(view), /contract changed/);
});
it('cancels an oversized stream and validates fixed-zoom relay transport', async () => {
    let cancelled = false, pulls = 0;
    const adapter = createParcelSource(d, { fetchImpl: async () => new Response(new ReadableStream({
        pull(controller) { pulls++; controller.enqueue(new Uint8Array(1024 * 1024)); },
        cancel() { cancelled = true; }
    })) });
    await assert.rejects(adapter.queryBounds(view), /byte limit/);
    assert.equal(cancelled, true); assert.ok(pulls <= 18);
    const check = url => validateParcelProviderRelayRequest(d.id, { url }, { sources: [d] });
    const url = 'https://tiles.example.test/parcels/12/3026/519.pbf';
    assert.equal(check(url).target.href, url);
    for (const bad of [url + '?extra=1', url.replace('/12/', '/13/'), url.replace('/parcels/', '/other/')]) assert.throws(() => check(bad));
    assert.throws(() => createParcelSource({ ...d, outFields: ['ignored'] }));
});
