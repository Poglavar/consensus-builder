import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { PbfWriter, PbfReader } from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';
import { validateParcelProviderRelayRequest } from '../parcels/provider-relay.js';

const d = { id: 'by-nca-test', adapter: 'vector-tiles', identityKind: 'native', geometryMode: 'interior-only',
    endpoint: 'https://tiles.example.test/tiles/parcels/{z}/{x}/{y}.pbf', layer: 'parcels', zoom: 14, extent: 4096,
    idField: 'cad_num', idType: 'string', idPrefix: 'BY-TEST-', parcelNumberField: 'cad_num', outFields: ['cad_num'],
    idLookupBounds: [27.57568359375, 53.891391285752874, 27.59765625, 53.90433815627469] };
function encode(rows = [{ id: '500000000009000082', x: 1000 }, { id: '500000000003000085', x: 0 }]) {
    const p = new PbfWriter();
    p.writeMessage(3, (_, l) => {
        l.writeStringField(1, 'parcels'); l.writeVarintField(15, 2); l.writeVarintField(5, 4096);
        l.writeStringField(3, 'cad_num'); l.writeStringField(3, 'ignored');
        for (const r of rows) l.writeMessage(4, (v, w) => w.writeStringField(1, v), r.id);
        l.writeMessage(4, (v, w) => w.writeStringField(1, v), 'discard-me');
        rows.forEach((r, i) => l.writeMessage(2, (_, w) => {
            w.writePackedVarint(2, [0, i, 1, rows.length]); w.writeVarintField(3, 3);
            // Clockwise square, closing with MVT ClosePath.
            w.writePackedVarint(4, [9, r.x * 2, 2000, 26, 200, 0, 0, 200, 199, 0, 15]);
        }));
    });
    return p.finish();
}
function provider(bytes = encode()) { return mock.fn(async () => new Response(bytes)); }
const view = [27.58, 53.895, 27.59, 53.902];
describe('native interior vector tiles', () => {
    it('routes Hrodna at z16 without changing z14 Minsk and Mahilioŭ reads in either runtime', async () => {
        const source = { ...d, id: 'by-nca-public-cadastral-map', idPrefix: 'BY-NCA-',
            endpoint: 'https://map.nca.by/tiles/294b19b9-3259-44e5-b8e8-000000000001/{z}/{x}/{y}.pbf' };
        const unchanged = structuredClone(source);
        const hrodnaId = '440100000002004190', mahilioId = '740100000004003257', minskId = '500000000009000082';
        const hrodnaBytes = encode([{ id: hrodnaId, x: 1000 }]);
        const fetchImpl = mock.fn(async url => new Response(url.endsWith('/16/37105/21141.pbf') ? hrodnaBytes
            : url.includes('/16/') ? encode([{ id: '440100999999999999', x: 0 }])
            : url.endsWith('/14/9572/5268.pbf') ? encode([{ id: mahilioId, x: 1000 }]) : encode()));
        for (const create of [createParcelSource, browserParcelFactories['vector-tiles']]) {
            const a = create(source, { fetchImpl });
            const ids = [hrodnaId, mahilioId, minskId].map(id => 'BY-NCA-' + id);
            const exact = await a.queryIds(ids);
            assert.deepEqual(exact.features.map(f => f.id).sort(), ids.sort());
            const parcel = exact.features.find(f => f.properties.sourceParcelId === hrodnaId);
            const native = new VectorTile(new PbfReader(hrodnaBytes)).layers.parcels.feature(0).toGeoJSON(37105, 21141, 16);
            assert.deepEqual(parcel.geometry, native.geometry);
            const inView = await a.queryBounds([23.825, 53.6793, 23.826, 53.6798]);
            assert.equal(inView.complete, true);
            assert.equal(inView.citywideComplete, false);
            assert.deepEqual(inView.features.map(f => f.id), ['BY-NCA-' + hrodnaId]);
            assert.deepEqual((await a.queryGeometry(parcel.geometry)).features, inView.features);
            assert.deepEqual(await a.queryIds(['BY-NCA-' + hrodnaId]), {
                ...exact, features: [parcel]
            });
            await assert.rejects(a.queryIds(['BY-NCA-440100999999999999']), /unresolved/);
            assert.equal((await a.queryBounds([23.817, 53.679, 23.826, 53.680])).complete, false);
        }
        assert.deepEqual(source, unchanged);
        for (const tile of ['16/37105/21141', '14/9447/5268', '14/9572/5268']) {
            assert.equal(fetchImpl.mock.calls.filter(({ arguments: [url] }) => url.endsWith('/' + tile + '.pbf')).length, 2);
        }
        assert.equal(fetchImpl.mock.callCount(), 22);
    });
    it('routes Mahilioŭ exact IDs and bounds in both runtimes while preserving the Minsk lookup window', async () => {
        const source = { ...d, id: 'by-nca-public-cadastral-map', idPrefix: 'BY-NCA-',
            endpoint: 'https://map.nca.by/tiles/294b19b9-3259-44e5-b8e8-000000000001/{z}/{x}/{y}.pbf' };
        const unchanged = structuredClone(source);
        const mahilioId = '740100000004003257', minskId = '500000000009000082';
        const mahilioBytes = encode([{ id: mahilioId, x: 1000 }]);
        const fetchImpl = mock.fn(async url => new Response(url.endsWith('/9572/5268.pbf') ? mahilioBytes : encode()));
        for (const create of [createParcelSource, browserParcelFactories['vector-tiles']]) {
            const a = create(source, { fetchImpl });
            // No prior bounds query or near hint is needed to resolve either city.
            const exact = await a.queryIds(['BY-NCA-' + mahilioId, 'BY-NCA-' + minskId]);
            assert.equal(exact.features.length, 2);
            const native = new VectorTile(new PbfReader(mahilioBytes)).layers.parcels.feature(0).toGeoJSON(9572, 5268, 14);
            const parcel = exact.features.find(f => f.properties.sourceParcelId === mahilioId);
            assert.deepEqual(parcel.geometry, native.geometry);
            const bounds = [30.327, 53.898, 30.332, 53.902];
            const inView = await a.queryBounds(bounds);
            assert.equal(inView.complete, true);
            assert.equal(inView.citywideComplete, false);
            assert.equal(inView.features[0].id, 'BY-NCA-' + mahilioId);
            assert.deepEqual((await a.queryGeometry(parcel.geometry)).features, inView.features);
            await assert.rejects(a.queryIds(['BY-NCA-740100999999999999']), /unresolved/);
        }
        assert.deepEqual(source, unchanged);
        assert.equal(fetchImpl.mock.callCount(), 4);
        assert.equal(fetchImpl.mock.calls.filter(({ arguments: [url] }) => url.endsWith('/9447/5268.pbf')).length, 2);
        assert.equal(fetchImpl.mock.calls.filter(({ arguments: [url] }) => url.endsWith('/9572/5268.pbf')).length, 2);
    });
    it('cancels an oversized tile stream before reading its remaining bytes', async () => {
        let cancelled = false, reads = 0;
        const fetchImpl = async () => new Response(new ReadableStream({
            pull(controller) { reads++; controller.enqueue(new Uint8Array(1024 * 1024)); },
            cancel() { cancelled = true; }
        }));
        const a = createParcelSource(d, { fetchImpl });
        await assert.rejects(a.queryIds(['BY-TEST-1']), /byte limit/);
        assert.equal(cancelled, true);
        assert.ok(reads <= 18);
    });
    it('backend and browser retain exact native IDs and unmodified decoded source coordinates', async () => {
        const bytes = encode(), fetchImpl = provider(bytes);
        const a = createParcelSource(d, { fetchImpl });
        const b = browserParcelFactories['vector-tiles'](d, { fetchImpl });
        const first = await a.queryIds(['BY-TEST-500000000009000082']);
        assert.deepEqual(await b.queryIds(['BY-TEST-500000000009000082']), first);
        assert.equal(fetchImpl.mock.callCount(), 2);
        assert.ok(fetchImpl.mock.calls.every(({ arguments: [url] }) => url.endsWith('/14/9447/5268.pbf')));
        const native = new VectorTile(new PbfReader(bytes)).layers.parcels.feature(0).toGeoJSON(9447, 5268, 14);
        assert.deepEqual(first.features[0].geometry, native.geometry);
        assert.equal(first.features[0].properties.sourceParcelId, '500000000009000082');
        assert.deepEqual(first.features[0].properties.sourceProperties, { cad_num: '500000000009000082' });
        assert.equal(first.complete, true);
    });
    it('reports bounded subset coverage and never asserts absence for tile-edge or unknown IDs', async () => {
        const a = createParcelSource(d, { fetchImpl: provider() });
        const result = await a.queryBounds(view);
        assert.equal(result.features.length, 1);
        assert.equal(result.complete, true);
        assert.equal(result.citywideComplete, false);
        assert.equal(result.excludedTileFragments, 1);
        assert.equal((await a.queryBounds([27.575, 53.895, 27.58, 53.902])).complete, false);
        for (const id of ['500000000003000085', '999']) await assert.rejects(a.queryIds(['BY-TEST-' + id]), /unresolved/);
        await assert.rejects(a.queryIds(['foreign-1']));
    });
    it('fails conflicting native geometry and retries failed downloads', async () => {
        const a = createParcelSource(d, { fetchImpl: provider(encode([{ id: '1', x: 100 }, { id: '1', x: 500 }])) });
        await assert.rejects(a.queryIds(['BY-TEST-1']), /conflicting/);
        const fetchImpl = provider(); fetchImpl.mock.mockImplementationOnce(async () => { throw new Error('offline'); });
        const b = createParcelSource(d, { fetchImpl });
        await assert.rejects(b.queryIds(['BY-TEST-500000000009000082']));
        assert.equal((await b.queryIds(['BY-TEST-500000000009000082'])).features.length, 1);
        assert.equal(fetchImpl.mock.callCount(), 2);
    });
    it('allows only the catalogued template, fixed zoom and valid XYZ coordinates through the relay', () => {
        const check = url => validateParcelProviderRelayRequest(d.id, { url }, { sources: [d] });
        const url = 'https://tiles.example.test/tiles/parcels/14/9447/5268.pbf';
        assert.equal(check(url).target.href, url);
        for (const bad of [url.replace('/14/', '/15/'), url.replace('9447', '16384'), url.replace('9447', '09447'),
            url.replace('/parcels/', '/other/'), url.replace('example.test', 'elsewhere.test'), url + '?x=1', url + '#x']) {
            assert.throws(() => check(bad));
        }
    });
    it('admits only the verified additional Hrodna z16 window through the NCA relay', () => {
        const source = { ...d, id: 'by-nca-public-cadastral-map',
            endpoint: 'https://map.nca.by/tiles/294b19b9-3259-44e5-b8e8-000000000001/{z}/{x}/{y}.pbf' };
        const check = url => validateParcelProviderRelayRequest(source.id, { url }, { sources: [source] });
        const url = source.endpoint.replace('{z}/{x}/{y}', '16/37105/21141');
        assert.equal(check(url).target.href, url);
        assert.equal(check(url.replace('/37105/', '/37106/')).target.href, url.replace('/37105/', '/37106/'));
        for (const bad of [url.replace('/37105/', '/37107/'), url.replace('/21141.', '/21143.'), url.replace('/16/', '/15/'), url + '?x=1', url + '#x',
            url.replace('37105', '037105')]) assert.throws(() => check(bad));
        const foreign = { ...source, id: 'foreign-source' };
        assert.throws(() => validateParcelProviderRelayRequest(foreign.id, { url }, { sources: [foreign] }));
    });
});
