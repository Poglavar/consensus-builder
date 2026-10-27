// Exercises Ribeirao Preto's ArcGIS contract through both production factories and its browser relay.
// All polygon coordinates below are synthetic test data, not retained provider samples.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories, createBrowserProviderFetch } from '../parcels/browser-source-runtime.js';
import { createHttpsJsonFetch } from '../parcels/https-json-fetch.js';

const descriptor = {
    id: 'br-ribeirao-preto-geoportal-cadastro-coderp-lote',
    adapter: 'arcgis',
    endpoint: 'https://webgis.ribeiraopreto.sp.gov.br/server/rest/services/GeoPortal/Geoportal_Cadastro_Coderp/MapServer/0',
    idField: 'gid', objectIdField: 'gid', idType: 'integer',
    idPrefix: 'BR-RIBEIRAO-PRETO-LOTE-', outFields: ['gid'], queryFormat: 'esri-json',
    pageSize: 1000, maxFeatures: 10000, maxBboxKm2: 4,
    maxResponseBytes: 16777216, timeoutMs: 45000,
    countryCode: 'BR', metricSrid: 32723, sourceCrs: 'EPSG:31983',
    caCertificate: './certificates/thawte-tls-rsa-ca-g1.pem', browserTransport: 'relay',
    cityIds: ['ribeirao_preto']
};
const ids = [178927, 178928].map(gid => descriptor.idPrefix + gid);
const shell = [[-47.81,-21.165],[-47.81,-21.164],[-47.809,-21.164],[-47.809,-21.165],[-47.81,-21.165]];
const hole = [[-47.8098,-21.1648],[-47.8092,-21.1648],[-47.8092,-21.1642],[-47.8098,-21.1642],[-47.8098,-21.1648]];
const other = shell.map(([x,y]) => [x + 0.002, y]);
const rows = [178927, 178928].map(gid => ({ attributes: { gid }, geometry: { rings: [shell] } }));
const factories = { backend: createParcelSource, browser: browserParcelFactories.arcgis };

function provider(sourceRows = rows) {
    const calls = [];
    const fetchImpl = async (input, options = {}) => {
        const url = new URL(input), p = new URLSearchParams(options.body || url.search);
        assert.equal(url.origin + url.pathname, descriptor.endpoint + '/query');
        assert.equal(p.get('outFields'), 'gid');
        assert.equal(p.get('returnGeometry'), 'true');
        assert.equal(p.get('outSR'), '4326');
        assert.equal(p.get('f'), 'json');
        assert.equal(p.get('returnTrueCurves'), 'true');
        for (const key of ['geometryPrecision', 'maxAllowableOffset', 'quantizationParameters', 'token']) {
            assert.equal(p.has(key), false);
        }
        calls.push(p);
        const where = p.get('where');
        let selected = sourceRows;
        if (where !== '1=1') {
            assert.match(where, /^gid IN \([0-9,]+\)$/);
            const requested = where.slice(8, -1).split(',').map(Number);
            selected = sourceRows.filter(row => requested.includes(row.attributes.gid));
        }
        const offset = Number(p.get('resultOffset')), limit = Number(p.get('resultRecordCount'));
        return Response.json({ geometryType: 'esriGeometryPolygon', spatialReference: { wkid: 4326 },
            features: selected.slice(offset, offset + limit), exceededTransferLimit: offset + limit < selected.length });
    };
    return { fetchImpl, calls };
}

for (const [name, factory] of Object.entries(factories)) {
    test(`${name}: repeat exact gid reads preserve distinct IDs with identical full footprints`, async () => {
        const { fetchImpl, calls } = provider();
        const source = factory(descriptor, { fetchImpl });
        const first = await source.queryIds(ids), second = await source.queryIds(ids);
        assert.equal(first.complete, true);
        assert.equal(first.returnsWGS84, true);
        assert.deepEqual(first.absentIds, []);
        assert.deepEqual(first.features.map(feature => feature.id), ids);
        assert.deepEqual(second, first);
        for (let index = 0; index < rows.length; index++) {
            const feature = first.features[index];
            assert.deepEqual(feature.geometry, { type: 'Polygon', coordinates: [shell] });
            assert.equal(feature.properties.sourceId, descriptor.id);
            assert.equal(feature.properties.sourceParcelId, String(rows[index].attributes.gid));
            assert.deepEqual(feature.properties.sourceProperties, rows[index].attributes);
        }
        assert.deepEqual(calls.map(p => p.get('where')), ['gid IN (178927,178928)', 'gid IN (178927,178928)']);
    });

    test(`${name}: bbox paging retains whole polygons, holes and disconnected members`, async () => {
        const sourceRows = structuredClone(rows);
        sourceRows[0].geometry.rings = [shell, hole, other];
        const { fetchImpl, calls } = provider(sourceRows);
        const source = factory({ ...descriptor, pageSize: 1 }, { fetchImpl });
        // This viewport cuts through the first shell; geometry must remain whole.
        const bounds = [-47.8099,-21.1649,-47.8097,-21.1647];
        const result = await source.queryBounds(bounds);
        assert.equal(result.complete, true);
        assert.deepEqual(result.features.map(feature => feature.id), ids);
        assert.deepEqual(result.features[0].geometry, { type: 'MultiPolygon', coordinates: [[shell, hole], [other]] });
        assert.deepEqual(calls.map(p => p.get('resultOffset')), ['0','1']);
        for (const p of calls) {
            assert.equal(p.get('where'), '1=1');
            assert.equal(p.get('geometry'), bounds.join(','));
            assert.equal(p.get('geometryType'), 'esriGeometryEnvelope');
            assert.equal(p.get('inSR'), '4326');
            assert.equal(p.get('spatialRel'), 'esriSpatialRelIntersects');
        }
    });
}

test('malformed or foreign IDs fail before I/O; only a successful empty read reports absence', async () => {
    const { fetchImpl, calls } = provider();
    const source = createParcelSource(descriptor, { fetchImpl });
    for (const id of ['OTHER-178927', descriptor.idPrefix + '01', descriptor.idPrefix + '1 OR 1=1']) {
        await assert.rejects(source.queryIds([id]), error => error.status === 400);
    }
    assert.equal(calls.length, 0);
    const result = await source.queryIds([descriptor.idPrefix + '999999']);
    assert.equal(result.complete, true);
    assert.deepEqual(result.features, []);
    assert.deepEqual(result.absentIds, [descriptor.idPrefix + '999999']);
    const unavailable = createParcelSource(descriptor, { fetchImpl: async () => new Response(null, { status: 503 }) });
    await assert.rejects(unavailable.queryIds(ids), error => error.upstreamStatus === 503);
});

test('repeated OIDs and oversized streamed responses fail rather than publishing incomplete parcels', async () => {
    const repeating = provider([rows[0], rows[0]]);
    const source = createParcelSource({ ...descriptor, pageSize: 1 }, repeating);
    await assert.rejects(source.queryIds([ids[0]]), /pagination repeated or omitted an object ID/);
    const oversized = createParcelSource({ ...descriptor, maxResponseBytes: 32 }, provider());
    await assert.rejects(oversized.queryIds(ids), /response exceeds the byte limit/);
});

test('browser factory reads through the configured relay without a direct TLS attempt', async () => {
    const relayBase = 'https://app.example.test/api', upstream = provider();
    let relayCalls = 0;
    const fetchImpl = createBrowserProviderFetch(descriptor, { relayBase, fetchImpl: async (url, options) => {
        assert.equal(url, `${relayBase}/parcel-provider-relay/${descriptor.id}`);
        assert.equal(options.method, 'POST');
        assert.equal(options.credentials, 'omit');
        const request = JSON.parse(options.body);
        assert.equal(request.method, 'GET');
        relayCalls++;
        return upstream.fetchImpl(request.url, request);
    } });
    const result = await browserParcelFactories.arcgis(descriptor, { fetchImpl }).queryIds(ids);
    assert.deepEqual(result.features.map(feature => feature.id), ids);
    assert.equal(relayCalls, 1);
    await assert.rejects(createBrowserProviderFetch(descriptor)(descriptor.endpoint), /none is configured/);
});

test('source certificate supplements trust with verification enabled and a readable bounded body', async () => {
    const certificate = readFileSync(new URL('../parcels/' + descriptor.caCertificate, import.meta.url), 'utf8');
    assert.equal(new X509Certificate(certificate).ca, true);
    const fetchImpl = createHttpsJsonFetch(certificate, { getImpl(url, options, callback) {
        assert.equal(url, descriptor.endpoint);
        assert.equal(options.agent.options.rejectUnauthorized, true);
        assert.ok(options.agent.options.ca.includes(certificate));
        assert.ok(options.agent.options.ca.length > 1);
        // No custom hostname check replaces Node's normal certificate verification.
        assert.equal(options.agent.options.checkServerIdentity, undefined);
        const response = Readable.from([Buffer.from('{"count":2}')]);
        response.statusCode = 200;
        response.headers = { 'content-type': 'application/json' };
        queueMicrotask(() => callback(response));
        return new EventEmitter();
    } });
    assert.deepEqual(await (await fetchImpl(descriptor.endpoint)).json(), { count: 2 });
});
