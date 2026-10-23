// Exercise Ogun's guarded full-schema WFS reads, exact identity and unchanged geometry.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createWfsParcelSource } from '../parcels/wfs-source.js';

test('the registered Ogun descriptor can initialize without requesting upstream data', () => {
    const catalog = JSON.parse(readFileSync(new URL('../../frontend/data/source-catalog.json', import.meta.url), 'utf8'));
    const registered = catalog.sources.find(source => source.id === 'ng-ogun-sdi-geonode-parcels');
    assert.doesNotThrow(() => createWfsParcelSource(registered, {
        fetchImpl: () => assert.fail('Initialization must not fetch upstream data')
    }));
});

const descriptor = {
    id: 'ng-ogun-sdi-geonode-parcels', adapter: 'wfs',
    endpoint: 'https://geoserver.ogunstate.gov.ng/geoserver/ows', version: '2.0.0',
    featureType: 'geonode:parcels', geometryField: 'geom', idField: null, idType: 'string',
    nativeIdMode: 'feature-id', idPattern: '^parcels\\.[0-9]+$', idPrefix: 'NG-OGUN-',
    outFields: [], requestProperties: false, unfilteredSchemaProfile: 'ng-ogun-parcels-v1',
    pageSize: 1, idBatchSize: 2, maxFeatures: 10, maxBboxKm2: 1
};
const fields = { fid: 'xsd:int', lga_name: 'xsd:string', lga_num: 'xsd:int',
    block_num: 'xsd:int', parcel_num: 'xsd:int', parcel_status: 'xsd:string',
    data_source: 'xsd:int', status: 'xsd:int', area: 'xsd:double',
    date_created: 'xsd:date', old_file: 'xsd:string', geom: 'gml:MultiSurfacePropertyType' };
const schema = (changes = {}) => `<xsd:schema xmlns:xsd="http://www.w3.org/2001/XMLSchema"
    xmlns:geonode="http://www.geonode.org/" xmlns:gml="http://www.opengis.net/gml/3.2"
    targetNamespace="http://www.geonode.org/"><xsd:complexType name="parcelsType"><xsd:sequence>
    ${Object.entries({ ...fields, ...changes }).map(([name, type]) => `<xsd:element name="${name}" type="${type}"/>`).join('')}
    </xsd:sequence></xsd:complexType><xsd:element name="parcels" type="geonode:parcelsType"/></xsd:schema>`;
const geometry = { type: 'MultiPolygon', coordinates: [
    [[[3.938,6.821],[3.939,6.821],[3.939,6.822],[3.938,6.822],[3.938,6.821]],
        [[3.9382,6.8212],[3.9382,6.8213],[3.9383,6.8213],[3.9383,6.8212],[3.9382,6.8212]]],
    [[[3.94,6.821],[3.941,6.821],[3.941,6.822],[3.94,6.821]]]
] };
const raw = (fid, extra = {}) => ({ type: 'Feature', id: `parcels.${fid}`, geometry,
    properties: { fid, parcel_status: 'uninterpreted', old_file: null, ...extra } });
const page = (features, matched = features.length) => new Response(JSON.stringify({
    type: 'FeatureCollection', numberMatched: matched, numberReturned: features.length, features,
    crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:CRS::84' } },
    links: [{ rel: 'next', href: 'http://internal.invalid/geoserver/ows' }]
}));
function fixture(responses, override = {}) {
    const requests = [];
    const source = createWfsParcelSource({ ...descriptor, ...override }, { fetchImpl: async (url, options) => {
        requests.push({ url: new URL(url), options });
        assert.ok(responses.length, 'Unexpected request');
        return responses.shift();
    } });
    return { source, requests };
}

test('checks the safe schema before exact reads and strips every non-identity attribute', async () => {
    const { source, requests } = fixture([new Response(schema()), page([raw(340)])]);
    const result = await source.queryIds(['NG-OGUN-parcels.340']);
    assert.equal(result.complete, true);
    assert.deepEqual(result.absentIds, []);
    assert.equal(result.features[0].properties.sourceParcelId, 'parcels.340');
    assert.deepEqual(result.features[0].properties.sourceProperties, {});
    assert.deepEqual(result.features[0].geometry, geometry);
    assert.equal(requests[0].url.searchParams.get('request'), 'DescribeFeatureType');
    assert.equal(requests[1].url.searchParams.get('resourceId'), 'parcels.340');
    assert.equal(requests[1].url.searchParams.has('propertyName'), false);
    assert.ok(requests.every(({ options }) => options.cache === 'no-store' && options.redirect === 'error'));
});

test('preserves distinct duplicate outlines and constructs public-endpoint pages without following next links', async () => {
    const { source, requests } = fixture([new Response(schema()), page([raw(340)], 2), page([raw(341)], 2),
        new Response(schema()), page([raw(340)], 2), page([raw(341)], 2)]);
    const result = await source.queryBounds([3.938,6.821,3.939,6.822]);
    assert.equal(result.features.length, 2);
    assert.deepEqual(result.features.map(f => f.id), ['NG-OGUN-parcels.340', 'NG-OGUN-parcels.341']);
    assert.ok(requests.every(({ url }) => url.origin === 'https://geoserver.ogunstate.gov.ng'));
    assert.equal(requests[2].url.searchParams.get('startIndex'), '1');
    assert.equal(requests.filter(({ url }) => url.searchParams.get('request') === 'DescribeFeatureType').length, 2);
});

test('a new schema attribute or changed type prevents all parcel reads', async () => {
    for (const changes of [{ unexpected: 'xsd:string' }, { fid: 'xsd:string' }]) {
        const { source, requests } = fixture([new Response(schema(changes))]);
        await assert.rejects(source.queryIds(['NG-OGUN-parcels.340']), /schema changed/);
        assert.equal(requests.length, 1);
    }
});

test('rejects malformed/oversized schema, DTD and denied metadata before parcel reads', async () => {
    for (const response of [new Response('<bad>'), new Response('x'.repeat(65537)),
        new Response('<!DOCTYPE x []>' + schema()), new Response('', { status: 403 })]) {
        const { source, requests } = fixture([response]);
        await assert.rejects(source.queryIds(['NG-OGUN-parcels.340']), { status: 502 });
        assert.equal(requests.length, 1);
    }
});

test('response schema drift, mismatched fid and invalid geometry fail without publishing features', async () => {
    for (const feature of [raw(340, { unexpected: 'discard' }), { ...raw(340), id: 'parcels.341' },
        raw(340, { fid: '340' }), { ...raw(340), geometry: null }]) {
        const { source } = fixture([new Response(schema()), page([feature])]);
        await assert.rejects(source.queryIds(['NG-OGUN-parcels.340']), { status: 502 });
    }
});

test('profile cannot enable unfiltered reads for any other source or native ID pattern', () => {
    for (const override of [{ id: 'another-source' }, { endpoint: 'https://other.invalid/wfs' },
        { featureType: 'geonode:other' }, { idPattern: '.*' }, { outFields: ['old_file'] },
        { responseSrid: 3857 }, { projection: '+proj=longlat +datum=WGS84' },
        { unfilteredSchemaProfile: undefined }]) {
        assert.throws(() => fixture([], override), /Invalid WFS/);
    }
});

test('foreign or malformed IDs fail before schema or parcel network requests', async () => {
    for (const id of ['FOREIGN-parcels.340', 'NG-OGUN-parcels.340,parcels.341']) {
        const { source, requests } = fixture([]);
        await assert.rejects(source.queryIds([id]), { status: 400 });
        assert.equal(requests.length, 0);
    }
});
