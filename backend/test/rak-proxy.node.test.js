// Exercise RAK's nested GET transport, complete paging, unchanged rings and relay boundary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories, createBrowserProviderFetch } from '../parcels/browser-source-runtime.js';
import { validateParcelProviderRelayRequest } from '../parcels/provider-relay.js';
import { RAK_SOURCE_ID, RAK_LAYER, RAK_PROXY, rakParcelQueryUrl } from '../parcels/rak-proxy.js';

const descriptor = {
    id: RAK_SOURCE_ID, adapter: 'arcgis', endpoint: RAK_LAYER, idPrefix: 'AE-RAK-',
    idField: 'ParcelID', idType: 'string', objectIdField: 'OBJECTID',
    outFields: ['OBJECTID', 'ParcelID'], queryFormat: 'esri-json', pageSize: 1,
    returnTrueCurves: false,
    maxResponseBytes: 1024 * 1024, browserTransport: 'relay'
};
const ring = [[55.96, 25.77], [55.96, 25.771], [55.961, 25.771], [55.961, 25.77], [55.96, 25.77]];
const row = i => ({ attributes: { OBJECTID: i, ParcelID: String(310060069 + i) }, geometry: { rings: [ring] } });
const payload = (features, exceededTransferLimit = false) => ({ geometryType: 'esriGeometryPolygon',
    spatialReference: { wkid: 4326 }, features, exceededTransferLimit });
function paramsFor(input, options) {
    assert.ok(String(input).startsWith(`${RAK_PROXY}${RAK_LAYER}/query?`));
    assert.equal(options.method, undefined);
    assert.equal(options.body, undefined);
    return new URLSearchParams(String(input).split('/query?')[1]);
}

test('backend RAK bounds paging retains complete source rings and native keys', async () => {
    const calls = [];
    const source = createParcelSource(descriptor, { fetchImpl: async (url, options) => {
        const params = paramsFor(url, options); calls.push(params);
        assert.equal(params.get('f'), 'json');
        assert.equal(params.get('returnTrueCurves'), 'false');
        assert.equal(params.get('outFields'), 'OBJECTID,ParcelID');
        const offset = Number(params.get('resultOffset'));
        return new Response(JSON.stringify(payload(offset < 2 ? [row(offset + 1)] : [], offset < 1)));
    } });
    const result = await source.queryBounds([55.96, 25.77, 55.962, 25.772]);
    assert.equal(result.complete, true);
    assert.deepEqual(result.features.map(f => f.id), ['AE-RAK-310060070', 'AE-RAK-310060071']);
    assert.deepEqual(result.features[0].geometry.coordinates, [ring]);
    assert.equal(calls[0].get('geometry'), calls[1].get('geometry'));
    assert.deepEqual(calls.map(p => p.get('resultOffset')), ['0', '1']);
});

test('long RAK exact-ID batches remain GET requests with raw nested separators', async () => {
    const native = Array.from({ length: 80 }, (_, i) => '3100600000000000' + String(i).padStart(4, '0'));
    const source = createParcelSource({ ...descriptor, pageSize: 2000 }, { fetchImpl: async (url, options) => {
        const params = paramsFor(url, options);
        assert.ok(url.length > 1800);
        assert.ok(params.get('where').includes("'31006000000000000000'"));
        return new Response(JSON.stringify(payload(native.map((ParcelID, i) => ({
            attributes: { OBJECTID: i + 1, ParcelID }, geometry: { rings: [ring] }
        })))));
    } });
    const result = await source.queryIds(native.map(id => `AE-RAK-${id}`));
    assert.equal(result.features.length, 80);
    assert.deepEqual(result.absentIds, []);
});

test('browser ArcGIS factory uses RAK transport and validates the relay envelope', async () => {
    let requested;
    const fetchImpl = createBrowserProviderFetch(descriptor, { relayBase: 'https://app.example/api',
        fetchImpl: async (url, options) => {
            assert.equal(url, `https://app.example/api/parcel-provider-relay/${RAK_SOURCE_ID}`);
            const envelope = JSON.parse(options.body);
            requested = validateParcelProviderRelayRequest(RAK_SOURCE_ID, envelope, { sources: [descriptor] });
            return new Response(JSON.stringify(payload([row(1)])));
        } });
    const result = await browserParcelFactories.arcgis(descriptor, { fetchImpl }).queryIds(['AE-RAK-310060070']);
    assert.equal(result.complete, true);
    assert.deepEqual(result.features[0].geometry.coordinates, [ring]);
    assert.ok(requested.target.href.startsWith(RAK_PROXY));
});

test('RAK relay rejects foreign layers, unsafe fields, duplicate params and POST', () => {
    const good = rakParcelQueryUrl(new URLSearchParams({ where: "ParcelID = '310060070'", outFields: 'OBJECTID,ParcelID', f: 'json', outSR: '4326' }));
    assert.doesNotThrow(() => validateParcelProviderRelayRequest(RAK_SOURCE_ID, { url: good }, { sources: [descriptor] }));
    for (const input of [
        { url: good.replace('MapServer/4', 'MapServer/3') },
        { url: good.replace('gis.rak.ae/server', 'evil.example/server') },
        { url: good + '&outFields=*' },
        { url: good.replace('OBJECTID%2CParcelID', '*') },
        { url: good, method: 'POST', body: '' }
    ]) assert.throws(() => validateParcelProviderRelayRequest(RAK_SOURCE_ID, input, { sources: [descriptor] }));
});

test('provider linear-ring mode handles curved parcels without local geometry changes', async () => {
    const fetchImpl = async (url, options) => {
        const params = paramsFor(url, options);
        const feature = params.get('returnTrueCurves') === 'false' ? row(1)
            : { attributes: row(1).attributes, geometry: { curveRings: [[ring[0], { c: [ring[1], ring[2]] }]] } };
        return new Response(JSON.stringify(payload([feature])));
    };
    const source = createParcelSource(descriptor, { fetchImpl });
    const result = await source.queryIds(['AE-RAK-310060070']);
    assert.deepEqual(result.features[0].geometry.coordinates, [ring]);
    await assert.rejects(createParcelSource({ ...descriptor, returnTrueCurves: true }, { fetchImpl })
        .queryIds(['AE-RAK-310060070']), /Unsupported Esri parcel polygon representation/);
});

test('linear-ring option requires Esri JSON and an explicit boolean', () => {
    assert.throws(() => createParcelSource({ ...descriptor, returnTrueCurves: 'false' }), /Invalid ArcGIS/);
    assert.throws(() => createParcelSource({ ...descriptor, queryFormat: 'geojson' }), /Invalid ArcGIS/);
});
