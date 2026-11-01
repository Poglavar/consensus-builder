// Verify bounded DGC geometry reads and the matching backend/browser relay contract.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createSanJuanDgcSource, SANJUAN_SOURCE, SANJUAN_ENDPOINT, isSanJuanRequest } from '../parcels/sanjuan-dgc-source.js';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';
import { validateParcelProviderRelayRequest } from '../parcels/provider-relay.js';
import { createParcelProviderRelayRouter } from '../routes/parcel-provider-relay.js';

const d = { id: SANJUAN_SOURCE, endpoint: SANJUAN_ENDPOINT, adapter: 'sanjuan-dgc',
    idPrefix: 'AR-SJ-DGC-PARCEL-', idField: 'id', outFields: ['id'],
    lookupBounds: [[-68.55, -31.55, -68.53, -31.53]], maxBboxKm2: 6 };
const geometry = { type: 'Polygon', coordinates: [[[-68.542, -31.54], [-68.541, -31.54],
    [-68.541, -31.539], [-68.542, -31.54]]] };
const row = id => ({ type: 'Feature', id, properties: { Lbl: 'discard', CtiId: 120 }, geometry });
const response = features => new Response(JSON.stringify({ type: 'FeatureCollection', features }));

test('the real relay route delivers a DGC response arriving after its former 15 second deadline', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const router = createParcelProviderRelayRouter({ sources: [d], relayFetch: (_request, { signal }) =>
        new Promise((resolve, reject) => {
            const abort = () => reject(signal.reason);
            signal.addEventListener('abort', abort, { once: true });
            setTimeout(() => {
                signal.removeEventListener('abort', abort);
                resolve(response([row(22539)]));
            }, 20000);
        }) });
    const url = new URL(d.endpoint); url.searchParams.set('bbox', d.lookupBounds[0].join(','));
    const req = Object.assign(new EventEmitter(), { params: { sourceId: d.id }, body: { url: url.href } });
    const res = Object.assign(new EventEmitter(), { statusCode: 200, chunks: [], headersSent: false, writableEnded: false,
        status(code) { this.statusCode = code; return this; },
        json(value) { this.error = value; this.writableEnded = true; return this; },
        setHeader() {},
        write(chunk) { this.chunks.push(Buffer.from(chunk)); this.headersSent = true; return true; },
        end() { this.writableEnded = true; } });
    const handler = router.stack.find(layer => layer.route).route.stack.at(-1).handle;
    const pending = handler(req, res);
    await new Promise(setImmediate);
    t.mock.timers.tick(20000);
    await pending;
    assert.equal(res.statusCode, 200, JSON.stringify(res.error));
    assert.equal(res.writableEnded, true);
    assert.equal(JSON.parse(Buffer.concat(res.chunks)).features[0].id, 22539);
});

test('backend and browser factories freshly reread native IDs and preserve every geometry coordinate', async () => {
    for (const factory of [createSanJuanDgcSource, createParcelSource, browserParcelFactories['sanjuan-dgc']]) {
        const requests = [];
        const adapter = factory(d, { fetchImpl: async url => {
            requests.push(url);
            return response([row(22539), row(22547), { type: 'Feature', id: 4, geometry: { type: 'Polygon', coordinates: [[]] } }]);
        } });
        const ids = ['AR-SJ-DGC-PARCEL-22539'];
        for (let n = 0; n < 2; n++) {
            const r = await adapter.queryIds(ids);
            assert.equal(r.complete, true);
            assert.equal(r.features.length, 1);
            assert.equal(r.features[0].properties.sourceParcelId, '22539');
            assert.deepEqual(r.features[0].geometry, geometry);
            assert.deepEqual(r.features[0].properties.sourceProperties, { id: '22539' });
            assert.equal(JSON.stringify(r).includes('discard'), false);
        }
        assert.equal(requests.length, 2);
        assert.ok(requests.every(url => isSanJuanRequest(d, new URL(url))));
        assert.equal(adapter.getDiagnostics().emptyGeometryCount, 2);
        assert.ok(adapter.getDiagnostics().streamedBytes > 0);
    }
});

test('unobserved IDs stay unresolved, overlapping distinct IDs survive and conflicts fail', async () => {
    const adapter = createSanJuanDgcSource(d, { fetchImpl: async () => response([row(1), row(2)]) });
    const absent = await adapter.queryIds(['AR-SJ-DGC-PARCEL-99']);
    assert.equal(absent.complete, false);
    assert.deepEqual(absent.absentIds, []);
    const bounds = await adapter.queryBounds(d.lookupBounds[0]);
    assert.equal(bounds.features.length, 2);
    assert.equal(bounds.areaComplete, false);
    const changed = structuredClone(row(1));
    changed.geometry.coordinates[0][1][0] = -68.5405;
    await assert.rejects(createSanJuanDgcSource(d, { fetchImpl: async () => response([row(1), changed]) }).queryIds(['AR-SJ-DGC-PARCEL-1']), /conflicting geometry/);
});

test('only bounded GET geometry route is allowed; invalid IDs never fetch', async () => {
    const url = new URL(SANJUAN_ENDPOINT); url.searchParams.set('bbox', d.lookupBounds[0].join(','));
    assert.equal(isSanJuanRequest(d, url), true);
    assert.equal(validateParcelProviderRelayRequest(d.id, { url: url.href }, { sources: [d] }).target.href, url.href);
    // The route uses this deadline for both headers and body. Its former 15 s default
    // cancelled live browser reads before the adapter's 45 s deadline.
    assert.equal(validateParcelProviderRelayRequest(d.id, { url: url.href }, { sources: [d] }).timeoutMs, 45000);
    assert.throws(() => validateParcelProviderRelayRequest(d.id, { url: url.href, method: 'POST', body: '{}' }, { sources: [d] }));
    assert.equal(isSanJuanRequest(d, url, 'POST', '{}'), false);
    const other = new URL(url); other.pathname = other.pathname.replace(/6$/, '4');
    assert.equal(isSanJuanRequest(d, other), false);
    url.searchParams.set('ObjId', '1');
    assert.equal(isSanJuanRequest(d, url), false);
    assert.throws(() => validateParcelProviderRelayRequest(d.id, { url: url.href }, { sources: [d] }));
    const adapter = createSanJuanDgcSource(d, { fetchImpl: async () => { assert.fail('invalid input fetched'); } });
    await assert.rejects(adapter.queryIds(['AR-SJ-DGC-PARCEL-1e4']), /canonical/);
    await assert.rejects(adapter.queryBounds([-69, -32, -68.99, -31.99]), /scope/);
});

test('stream limit is enforced without Content-Length, and provider errors remain errors', async () => {
    let cancelled = false;
    const adapter = createSanJuanDgcSource({ ...d, maxResponseBytes: 1024 }, { fetchImpl: async () => new Response(new ReadableStream({
        pull(controller) { controller.enqueue(new Uint8Array(1025)); },
        cancel() { cancelled = true; }
    })) });
    await assert.rejects(adapter.queryIds(['AR-SJ-DGC-PARCEL-1']), /byte budget/);
    assert.equal(cancelled, true);
    await assert.rejects(createSanJuanDgcSource(d, { fetchImpl: async () => new Response(null, { status: 403 }) })
        .queryIds(['AR-SJ-DGC-PARCEL-1']), error => error.upstreamStatus === 403);
});


test('one transient DGC operation timeout is retried with a fresh bounded GET in every factory', async () => {
    for (const factory of [createSanJuanDgcSource, createParcelSource, browserParcelFactories['sanjuan-dgc']]) {
        const requests = [];
        let cancelled = 0;
        const adapter = factory(d, { fetchImpl: async (url, options) => {
            requests.push({ url, signal: options.signal });
            if (requests.length === 1) return new Response(new ReadableStream({
                cancel() { cancelled++; }
            }), { status: 500 });
            return response([row(22539)]);
        } });
        const result = await adapter.queryIds(['AR-SJ-DGC-PARCEL-22539']);
        assert.equal(result.complete, true);
        assert.deepEqual(result.features[0].geometry, geometry);
        assert.equal(requests.length, 2);
        assert.equal(requests[0].url, requests[1].url);
        assert.notEqual(requests[0].signal, requests[1].signal);
        assert.equal(cancelled, 1);
        assert.equal(adapter.getDiagnostics().operationTimeoutRetries, 1);
    }
});

test('persistent HTTP 500 fails after two attempts; denied, limited and cancelled reads never retry', async () => {
    for (const status of [500, 401, 403, 429]) {
        let requests = 0;
        const adapter = createSanJuanDgcSource(d, { fetchImpl: async () => {
            requests++;
            return new Response(null, { status });
        } });
        await assert.rejects(adapter.queryIds(['AR-SJ-DGC-PARCEL-22539']), error => error.upstreamStatus === status);
        assert.equal(requests, status === 500 ? 2 : 1);
    }
    const controller = new AbortController();
    let requests = 0;
    const adapter = createSanJuanDgcSource(d, { fetchImpl: async () => {
        requests++;
        controller.abort(new Error('user cancelled'));
        return new Response(null, { status: 500 });
    } });
    await assert.rejects(adapter.queryIds(['AR-SJ-DGC-PARCEL-22539'], { signal: controller.signal }), /user cancelled/);
    assert.equal(requests, 1);
});
