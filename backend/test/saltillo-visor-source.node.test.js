// Saltillo protocol, privacy, ring preservation, independent exact reads and browser relay behavior.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSaltilloVisorSource, SALTILLO_ENDPOINT, SALTILLO_LOCATOR, SALTILLO_SOURCE_ID } from '../parcels/saltillo-visor-source.js';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories, createBrowserProviderFetch } from '../parcels/browser-source-runtime.js';
import { validateParcelProviderRelayRequest } from '../parcels/provider-relay.js';

const d = { id: SALTILLO_SOURCE_ID, adapter: 'saltillo-visor', endpoint: SALTILLO_ENDPOINT,
    locatorEndpoint: SALTILLO_LOCATOR, idPrefix: 'MX-SALTILLO-VISOR|idCarto|',
    idField: 'idCarto', parcelNumberField: 'idCarto', outFields: ['idCarto'], browserTransport: 'relay' };
const id = d.idPrefix + '78053', other = d.idPrefix + '63970';
const ring = [[-100.9855, 25.4195], [-100.9853, 25.4195], [-100.9853, 25.4198], [-100.9855, 25.4198], [-100.9855, 25.4195]];
const row = (native = 78053, coordinates = ring) => ({ idCarto: native,
    coords: coordinates.map(([lng, lat]) => ({ lat, lng })), ignoredAttribute: 'discard-this' });
const json = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
function transport(rows = [row(), row(63970)], locator = { idCarto: 78053, lat: 25.4196, lng: -100.9854 }) {
    const calls = [];
    const fetchImpl = async (url, options = {}) => {
        calls.push({ url, options });
        if (String(url).startsWith(SALTILLO_LOCATOR)) return json(locator);
        assert.equal(url, SALTILLO_ENDPOINT);
        assert.equal(options.method, 'POST');
        assert.deepEqual([...new URLSearchParams(options.body).keys()].sort(), ['lat', 'lng']);
        return json(rows);
    };
    return { fetchImpl, calls };
}

test('backend and browser use fresh locator/ring reads, batching nearby requested IDs only', async () => {
    for (const factory of [createParcelSource, browserParcelFactories['saltillo-visor']]) {
        const t = transport();
        const source = factory(d, { fetchImpl: t.fetchImpl });
        const first = await source.queryIds([id, other]);
        const second = await source.queryIds([id, other]);
        assert.deepEqual(first, second);
        assert.equal(t.calls.length, 4);
        assert.deepEqual(first.features.map(f => f.id), [id, other]);
        assert.deepEqual(first.features[0].geometry, { type: 'Polygon', coordinates: [ring] });
        assert.deepEqual(first.features[0].properties.sourceProperties, { idCarto: '78053' });
        assert.equal(JSON.stringify(first).includes('discard-this'), false);
        assert.deepEqual(first.absentIds, []);
    }
});

test('bounds preserve overlapping native identities, omit unidentified overlays and filter nonlocal rings', async () => {
    const far = ring.map(([x, y]) => [x - 2, y]);
    const t = transport([row(), row(63970), row(null, far), row(999, far), row(1234, ring.slice(0, -1))]);
    const source = createSaltilloVisorSource(d, { fetchImpl: t.fetchImpl });
    const result = await source.queryBounds([-100.9856, 25.4194, -100.9852, 25.4199]);
    assert.deepEqual(result.features.map(f => f.id), [id, other]);
    assert.equal(result.unidentifiedRecords, 1);
    assert.equal(result.responseRecords, 5);
    assert.equal(result.unusableRecordCount, 1);
    assert.deepEqual(result.unusableIds, [d.idPrefix + '1234']);
    assert.equal(result.areaCompleteness, 'unverified');
    assert.deepEqual(result.features[0].geometry.coordinates[0], ring);
    await assert.rejects(source.queryBounds([-101, 25.4, -100.9, 25.5]), /too large|dimensions/);
    assert.equal(t.calls.length, 1);
});

test('exact reads fail on mismatched locator, missing native geometry and conflicting same-ID rings', async () => {
    for (const t of [transport([], { idCarto: 999, lat: 25.4196, lng: -100.9854 }), transport([]),
        transport([row(), row(78053, ring.map(([x,y]) => [x + 0.00001, y]))])]) {
        const source = createSaltilloVisorSource(d, { fetchImpl: t.fetchImpl });
        await assert.rejects(source.queryIds([id]), /match|missing|conflicting/);
    }
    const t = transport([row(78053, ring.slice(0, -1))]);
    await assert.rejects(createSaltilloVisorSource(d, { fetchImpl: t.fetchImpl }).queryIds([id]), /unusable polygon/);
});

test('a repeat exact read cannot be satisfied by a prior viewport cache', async () => {
    let postCount = 0;
    const fetchImpl = async url => {
        if (String(url).startsWith(SALTILLO_LOCATOR)) return json({ idCarto: 78053, lat: 25.4196, lng: -100.9854 });
        postCount++;
        return json([row(78053, postCount < 3 ? ring : ring.map(([x,y]) => [x + 0.00001, y]))]);
    };
    const source = createSaltilloVisorSource(d, { fetchImpl });
    await source.queryBounds([-100.9856, 25.4194, -100.9852, 25.4199]);
    const first = await source.queryIds([id]), second = await source.queryIds([id]);
    assert.notDeepEqual(first.features[0].geometry, second.features[0].geometry);
    assert.equal(postCount, 3);
});

test('actual streamed bytes enforce the cap even without Content-Length', async () => {
    let cancelled = false;
    const fetchImpl = async () => new Response(new ReadableStream({
        pull(controller) { controller.enqueue(new Uint8Array(1025)); },
        cancel() { cancelled = true; }
    }));
    const source = createSaltilloVisorSource(d, { fetchImpl, maxResponseBytes: 1024 });
    await assert.rejects(source.queryBounds([-100.9856, 25.4194, -100.9852, 25.4199]), /byte budget/);
    assert.equal(cancelled, true);
});

test('adjacent viewport cells share one bounded neighborhood; exact reads bypass it', async () => {
    const t = transport();
    const source = createSaltilloVisorSource(d, { fetchImpl: t.fetchImpl });
    const bounds = [-100.9856, 25.4194, -100.9852, 25.4199];
    await source.queryBounds(bounds);
    await source.queryBounds(bounds.map((n, i) => n + (i % 2 ? 0 : 0.0001)));
    assert.equal(t.calls.length, 1);
    await source.queryIds([id]);
    assert.equal(t.calls.length, 3);
});

test('ambiguous neighboring IDs cannot hide stable parcels or satisfy exact reads', async () => {
    const t = transport([row(), row(999), row(999, ring.map(([x,y]) => [x + 0.00001, y]))]);
    const source = createSaltilloVisorSource(d, { fetchImpl: t.fetchImpl });
    const result = await source.queryBounds([-100.9856, 25.4194, -100.9852, 25.4199]);
    assert.deepEqual(result.features.map(f => f.id), [id]);
    assert.deepEqual(result.ambiguousIds, [d.idPrefix + '999']);
    assert.equal(result.ambiguousRecordCount, 1);
    await assert.rejects(source.queryIds([id, d.idPrefix + '999']), /conflicting source rings/);
});

test('browser transport relays only pinned numeric ID and lat/lng requests', async () => {
    const t = transport();
    const fetchImpl = async (url, options) => {
        assert.equal(url, 'https://app.example/api/parcel-provider-relay/' + encodeURIComponent(d.id));
        const envelope = JSON.parse(options.body);
        validateParcelProviderRelayRequest(d.id, envelope, { sources: [d] });
        return t.fetchImpl(envelope.url, envelope);
    };
    const provider = createBrowserProviderFetch(d, { fetchImpl, relayBase: 'https://app.example/api' });
    const source = browserParcelFactories['saltillo-visor'](d, { fetchImpl: provider });
    assert.equal((await source.queryIds([id])).features[0].id, id);
    for (const input of [
        { url: SALTILLO_LOCATOR + '?q=some-text' },
        { url: SALTILLO_LOCATOR + '?q=78053&extra=1' },
        { url: 'https://visor.saltillo.gob.mx/simple.php?idCarto=78053' },
        { url: SALTILLO_ENDPOINT, method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'lat=25.4&lng=-101&extra=1' },
        { url: SALTILLO_ENDPOINT, method: 'GET' }
    ]) assert.throws(() => validateParcelProviderRelayRequest(d.id, input, { sources: [d] }));
});
