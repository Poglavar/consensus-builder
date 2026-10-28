// Verify Córdoba's safe native parcel key, complete paging and unchanged geometry in both runtimes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';

const descriptor = {
    id: 'ar-cordoba-idecor-wfs-parcelas', adapter: 'wfs',
    endpoint: 'https://idecor-ws.mapascordoba.gob.ar/geoserver/idecor/parcelas/wfs',
    version: '1.0.0', featureType: 'idecor:parcelas', geometryField: 'geom',
    idField: 'par_idparcela', idType: 'integer', idPrefix: 'AR-CORDOBA-IDECOR-PARCELA-',
    outFields: ['par_idparcela'], requestProperties: true, pageSize: 1, paginationIdentity: 'native-id',
    maxFeatures: 10000, maxBboxKm2: 25, maxResponseBytes: 8388608
};
// Synthetic polygons include a hole; transport feature IDs intentionally differ from parcel keys.
const geometry = { type: 'MultiPolygon', coordinates: [[
    [[-64.207, -31.4], [-64.206, -31.4], [-64.206, -31.399], [-64.207, -31.399], [-64.207, -31.4]],
    [[-64.2068, -31.3998], [-64.2068, -31.3996], [-64.2066, -31.3996], [-64.2066, -31.3998], [-64.2068, -31.3998]]
]] };
const rows = [163984, 163990, 163998].map(nativeId => ({
    type: 'Feature', id: 'parcelas.900', properties: { par_idparcela: nativeId }, geometry
}));
const ids = rows.map(row => `${descriptor.idPrefix}${row.properties.par_idparcela}`);

for (const [runtime, factory] of [['backend', createParcelSource], ['browser', browserParcelFactories.wfs]]) {
    test(`Córdoba ${runtime} pages exact native IDs, preserves rings and minimizes fields`, async () => {
        const requests = [];
        const source = factory(descriptor, { fetchImpl: async input => {
            const url = new URL(input);
            requests.push(url);
            const filter = url.searchParams.get('cql_filter');
            const selected = filter
                ? rows.filter(row => filter.match(/^par_idparcela IN \(([\d,]+)\)$/)[1].split(',').includes(String(row.properties.par_idparcela)))
                : rows;
            const offset = Number(url.searchParams.get('startIndex'));
            return new Response(JSON.stringify({ type: 'FeatureCollection',
                totalFeatures: selected.length, features: selected.slice(offset, offset + 1),
                crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::4326' } } }));
        } });
        const first = await source.queryIds(ids);
        const second = await source.queryIds(ids);
        assert.equal(first.complete, true);
        assert.deepEqual(first.absentIds, []);
        assert.deepEqual(first, second);
        assert.deepEqual(first.features.map(row => row.id), ids);
        assert.deepEqual(first.features.map(row => row.geometry), rows.map(row => row.geometry));
        assert.deepEqual(first.features[0].properties.sourceProperties, { par_idparcela: 163984 });
        assert.deepEqual(requests.slice(0, 3).map(url => url.searchParams.get('startIndex')), ['0', '1', '2']);
        const bounded = await source.queryBounds([-64.2071, -31.4001, -64.2059, -31.3989]);
        assert.deepEqual(bounded.features, first.features);
        for (const url of requests) {
            assert.equal(url.origin + url.pathname, descriptor.endpoint);
            assert.equal(url.searchParams.get('propertyName'), 'geom,par_idparcela');
            assert.equal(url.searchParams.get('srsName'), 'EPSG:4326');
            assert.equal(url.searchParams.get('sortBy'), 'par_idparcela');
            assert.equal(url.searchParams.get('maxFeatures'), '1');
        }
        const absentId = `${descriptor.idPrefix}999999999999`;
        assert.deepEqual((await source.queryIds([absentId])).absentIds, [absentId]);
        const count = requests.length;
        await assert.rejects(source.queryIds([`${descriptor.idPrefix}163984 OR 1=1`]));
        await assert.rejects(source.queryIds(['FOREIGN-163984']));
        assert.equal(requests.length, count);
    });
    test(`Córdoba ${runtime} rejects repeated native rows across pages and within a page`, async () => {
        for (const pageSize of [1, 2]) {
            const source = factory({ ...descriptor, pageSize }, { fetchImpl: async () =>
                new Response(JSON.stringify({ type: 'FeatureCollection', totalFeatures: 2,
                    features: Array(pageSize).fill(rows[0]) })) });
            await assert.rejects(source.queryIds([ids[0]]), /repeated a native parcel ID/);
        }
    });
    test(`Córdoba ${runtime} only permits transport FID reuse with explicit native identity`, async () => {
        const source = factory({ ...descriptor, paginationIdentity: undefined, pageSize: 3 }, {
            fetchImpl: async () => new Response(JSON.stringify({ type: 'FeatureCollection', totalFeatures: 3, features: rows }))
        });
        await assert.rejects(source.queryIds(ids), /repeated or omitted a feature ID/);
        assert.throws(() => factory({ ...descriptor, paginationIdentity: 'unchecked' }), /Invalid WFS/);
    });
}
