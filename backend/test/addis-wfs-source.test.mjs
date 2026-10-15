import test from 'node:test';
import assert from 'node:assert/strict';
import { createWfsParcelSource } from '../parcels/wfs-source.js';

const descriptor = {
    id: 'et-addis-eland-geoserver-parcel-publish', adapter: 'wfs',
    endpoint: 'https://geos.addiscadaster.gov.et/geoserver/ows',
    featureType: 'ncrprs_cadaster:v_1_parcel_cadaster_publish', version: '1.0.0',
    idField: 'uniqueparcelid', idType: 'string', idPrefix: 'ET-ADDIS-ELAND-',
    idPattern: '^AA[0-9]{12}$', geometryField: 'geometry', requestProperties: true,
    outFields: ['uniqueparcelid'], pageSize: 1, maxFeatures: 10, maxBboxKm2: 1,
    responseSrid: 20137,
    projection: '+proj=utm +zone=37 +a=6378249.145 +rf=293.465 +towgs84=-166,-15,204 +units=m +no_defs'
};
const native = id => ({ type: 'Feature', id: `transport.${id}`,
    properties: { uniqueparcelid: id }, geometry: { type: 'MultiPolygon', coordinates: [[[
        [472395.6068, 995281.2943], [472389.4057, 995281.0184],
        [472386.8724, 995291.661], [472395.6068, 995281.2943]
    ]]] } });

test('published native CRS metadata does not change a default geographic WFS response', async () => {
    const { responseSrid, ...geographicDescriptor } = descriptor;
    geographicDescriptor.projection = 'EPSG:31983';
    const source = createWfsParcelSource(geographicDescriptor, { fetchImpl: async url => {
        assert.equal(new URL(url).searchParams.get('srsName'), 'EPSG:4326');
        const feature = native('AA000041000409');
        feature.geometry = { type: 'Polygon', coordinates: [[[38, 9], [38.01, 9], [38.01, 9.01], [38, 9]]] };
        return new Response(JSON.stringify({ type: 'FeatureCollection', features: [feature], totalFeatures: 1 }));
    } });
    const result = await source.queryBounds([38, 9, 38.001, 9.001]);
    assert.deepEqual(result.features[0].geometry.coordinates[0][0], [38, 9]);
});

test('Addis WFS 1.0 requests only native geometry and parcel ID, pages, and transforms through the declared operation', async () => {
    const ids = ['AA000041000409', 'AA000041000776'];
    const requests = [];
    const fetchImpl = async url => {
        const p = new URL(url).searchParams;
        requests.push(p);
        assert.equal(p.get('version'), '1.0.0');
        assert.equal(p.get('typeName'), descriptor.featureType);
        assert.equal(p.get('srsName'), 'EPSG:20137');
        assert.equal(p.get('sortBy'), 'uniqueparcelid');
        assert.equal(p.get('propertyName'), 'geometry,uniqueparcelid');
        assert.equal(p.get('count'), p.get('maxFeatures'));
        const offset = Number(p.get('startIndex'));
        const selected = p.has('bbox') ? ids : ids.filter(id => p.get('cql_filter').includes(id));
        const page = selected.slice(offset, offset + Number(p.get('maxFeatures'))).map(native);
        return new Response(JSON.stringify({ type: 'FeatureCollection', features: page,
            totalFeatures: selected.length, numberMatched: selected.length, numberReturned: page.length,
            crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::20137' } } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const source = createWfsParcelSource(descriptor, { fetchImpl });
    const bounds = await source.queryBounds([38.7491, 9.0055, 38.7498, 9.0062]);
    assert.equal(bounds.complete, true);
    assert.deepEqual(bounds.features.map(f => f.id), ids.map(id => descriptor.idPrefix + id));
    assert.equal(requests.length, 2);
    assert.equal(requests[0].get('bbox'), '38.7491,9.0055,38.7498,9.0062,EPSG:4326');
    const coordinate = bounds.features[0].geometry.coordinates[0][0][0];
    assert.ok(Math.abs(coordinate[0] - 38.749695465545564) < 1e-10);
    assert.ok(Math.abs(coordinate[1] - 9.005658675705021) < 1e-10);
    const exact = await source.queryIds([descriptor.idPrefix + ids[0]]);
    assert.deepEqual(exact.features.map(f => f.id), [descriptor.idPrefix + ids[0]]);
    assert.deepEqual(exact.absentIds, []);
});

test('Addis WFS rejects missing or mismatched CRS tags on nonempty projected responses', async t => {
    const cases = [
        ['missing CRS', undefined],
        ['geographic CRS', { type: 'name', properties: { name: 'EPSG:4326' } }],
        ['different projected CRS', { type: 'name', properties: { name: 'EPSG:32637' } }]
    ];
    for (const [label, crs] of cases) {
        await t.test(label, async () => {
            const payload = { type: 'FeatureCollection', features: [native('AA000041000409')],
                totalFeatures: 1, numberMatched: 1, numberReturned: 1,
                ...(crs === undefined ? {} : { crs }) };
            const source = createWfsParcelSource(descriptor, { fetchImpl: async () => new Response(JSON.stringify(payload)) });
            await assert.rejects(source.queryBounds([38.7491, 9.0055, 38.7498, 9.0062]),
                /omitted or changed its projected response CRS/);
        });
    }
});

test('Addis projected WFS descriptors require an explicit coordinate operation', () => {
    const withoutOperation = { ...descriptor };
    delete withoutOperation.projection;
    assert.throws(() => createWfsParcelSource(withoutOperation), /Invalid WFS parcel source descriptor/);
});
