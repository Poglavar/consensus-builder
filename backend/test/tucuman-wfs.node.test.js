// Cover native KEY reads, unchanged XYZ geometry, and the fixed DGC HTTP relay exception.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories, createBrowserProviderFetch } from '../parcels/browser-source-runtime.js';
import { createProviderRelayFetch, validateParcelProviderRelayRequest } from '../parcels/provider-relay.js';
import { TUCUMAN_SOURCE_ID, TUCUMAN_WFS_ENDPOINT } from '../parcels/tucuman-wfs-transport.js';

const descriptor = {
    id: TUCUMAN_SOURCE_ID, adapter: 'wfs', endpoint: TUCUMAN_WFS_ENDPOINT,
    version: '1.1.0', featureType: 'dgct:PARCELASRUBEP', idField: 'KEY', idType: 'string',
    geometryField: 'GEOMETRY', requestProperties: true, outFields: ['KEY'],
    idPrefix: 'AR-TUCUMAN-DGC-PARCELASRUBEP-', paginationIdentity: 'native-id',
    browserTransport: 'relay', maxResponseBytes: 1048576, pageSize: 100
};
const geometry = { type: 'Polygon', coordinates: [
    [[-65.21,-26.82,0],[-65.209,-26.82,0],[-65.209,-26.819,0],[-65.21,-26.82,0]]
] };
let transportSequence = 0;
const payload = key => new Response(JSON.stringify({ type: 'FeatureCollection', totalFeatures: 1,
    numberMatched: 1, numberReturned: 1,
    features: [{ type: 'Feature', id: `PARCELASRUBEP.fid-${++transportSequence}`, geometry, properties: { KEY: key } }]
}));

test('backend and browser factories query exact native keys without changing XYZ geometry', async () => {
    for (const factory of [createParcelSource, browserParcelFactories.wfs]) {
        const requests = [];
        const source = factory(descriptor, { fetchImpl: async (input, options) => {
            const url = new URL(input); requests.push(url);
            assert.equal(options.redirect, 'error');
            assert.equal(url.searchParams.get('propertyName'), 'GEOMETRY,KEY');
            assert.equal(url.searchParams.get('cql_filter'), "KEY IN ('PH6699')");
            return payload('PH6699');
        } });
        const id = descriptor.idPrefix + 'PH6699';
        for (let i = 0; i < 2; i++) {
            const result = await source.queryIds([id]);
            assert.equal(result.complete, true);
            assert.deepEqual(result.absentIds, []);
            assert.equal(result.features[0].id, id);
            assert.deepEqual(result.features[0].geometry, geometry);
            assert.deepEqual(result.features[0].properties.sourceProperties, { KEY: 'PH6699' });
        }
        assert.equal(requests.length, 2);
    }
});

test('HTTP is rejected for other sources, endpoints, schemas and browser transports', () => {
    for (const changes of [{ id: 'another-source' }, { endpoint: TUCUMAN_WFS_ENDPOINT + '/other' },
        { outFields: ['KEY', 'DESCRIP'] }, { featureType: 'dgct:another' }, { browserTransport: undefined }]) {
        assert.throws(() => createParcelSource({ ...descriptor, ...changes }), /Invalid WFS/);
    }
});

test('browser uses the relay and relay permits only the reviewed HTTP layer and fields', async () => {
    const source = browserParcelFactories.wfs(descriptor, { fetchImpl: createBrowserProviderFetch(descriptor, {
        relayBase: 'https://backend.example', fetchImpl: async (url, options) => {
            assert.equal(url, `https://backend.example/parcel-provider-relay/${descriptor.id}`);
            const envelope = JSON.parse(options.body);
            const validated = validateParcelProviderRelayRequest(descriptor.id, envelope, { sources: [descriptor] });
            assert.equal(validated.target.protocol, 'http:');
            for (const [field, value] of [['typeName', 'dgct:another'], ['propertyName', 'KEY,DESCRIP']]) {
                const changed = new URL(envelope.url); changed.searchParams.set(field, value);
                assert.throws(() => validateParcelProviderRelayRequest(descriptor.id, { ...envelope, url: changed.href }, { sources: [descriptor] }));
            }
            for (const field of ['PROPERTYNAME', 'propertyName']) {
                const changed = new URL(envelope.url); changed.searchParams.append(field, 'KEY,DESCRIP');
                assert.throws(() => validateParcelProviderRelayRequest(descriptor.id, { ...envelope, url: changed.href }, { sources: [descriptor] }));
            }
            assert.throws(() => validateParcelProviderRelayRequest(descriptor.id, { ...envelope, method: 'POST' }, { sources: [descriptor] }));
            return payload('2053');
        }
    }) });
    const result = await source.queryIds([descriptor.idPrefix + '2053']);
    assert.equal(result.features[0].properties.sourceParcelId, '2053');
});

test('relay HTTP transport streams the pinned public endpoint through node:http', async () => {
    const url = new URL(descriptor.endpoint);
    for (const [key, value] of Object.entries({ service: 'WFS', version: '1.1.0', request: 'GetFeature',
        typeName: descriptor.featureType, outputFormat: 'application/json', srsName: 'CRS:84',
        propertyName: 'GEOMETRY,KEY' })) url.searchParams.set(key, value);
    let calls = 0;
    const fetch = createProviderRelayFetch({
        requestImpl: () => { throw new Error('Must use HTTP for the published endpoint'); },
        httpRequestImpl: (options, callback) => {
            calls++;
            assert.equal(options.hostname, new URL(descriptor.endpoint).hostname);
            assert.equal(options.protocol, 'http:');
            const request = new EventEmitter(); request.destroy = () => {};
            request.end = () => {
                const incoming = new PassThrough(); incoming.statusCode = 200; incoming.headers = {};
                callback(incoming); incoming.end('{}');
            };
            return request;
        }
    });
    assert.equal(await (await fetch(url)).text(), '{}');
    assert.equal(calls, 1);
    await assert.rejects(fetch(new URL(descriptor.endpoint + '/other')), /rejected/);
});
