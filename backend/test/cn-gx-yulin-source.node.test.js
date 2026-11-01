// Protect Yulin's long native parcel keys when current and stale references share an object ID.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createArcgisParcelSource } from '../parcels/arcgis-source.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';

const descriptor = {
    id: 'cn-gx-tianditu-zongdi-natural-building', adapter: 'arcgis',
    endpoint: 'https://guangxi.tianditu.gov.cn/mapgxservice/rest/services/TMP/oldTM260414new/MapServer/8',
    idPrefix: 'cn-gx-tianditu-zongdi-natural-building:ZDID:',
    idFields: ['ZDID', 'OBJECTID'], idFieldTypes: { ZDID: 'string', OBJECTID: 'integer' },
    objectIdField: 'OBJECTID', parcelNumberField: 'ZDID', outFields: ['ZDID', 'OBJECTID'],
    queryFormat: 'esri-json', boundsQueryMode: 'object-ids', idsQueryMode: 'composite-object-ids',
    pageSize: 1, maxResponseBytes: 16777216
};
const oid = 2612799;
const currentKey = '45090001210188616';
const staleKey = '45090001210188617';
const currentId = `${descriptor.idPrefix}${currentKey}~${oid}`;
const staleId = `${descriptor.idPrefix}${staleKey}~${oid}`;
// Synthetic test geometry, never used as qualification or live-source evidence.
const rings = [[[110.15, 22.63], [110.15, 22.6301], [110.1501, 22.6301],
    [110.1501, 22.63], [110.15, 22.63]]];

function provider() {
    const calls = [];
    const state = { deleted: false, failGeometry: false };
    const fetchImpl = async (input, init = {}) => {
        const url = new URL(input);
        const params = new URLSearchParams(init.body || url.search);
        calls.push(params);
        assert.equal(url.origin + url.pathname, `${descriptor.endpoint}/query`);
        assert.equal(params.get('objectIds'), String(oid), 'deduplicate the OID shared by the two references');
        assert.equal(params.get('where'), '1=1', 'exact reads must use the OID index, not a regional ZDID scan');
        assert.equal(params.has('geometry'), false, 'cold exact reads must be independent of viewport state');
        assert.equal(params.get('f'), 'json');
        assert.equal(params.get('outFields'), params.get('returnGeometry') === 'true' ? 'ZDID,OBJECTID' : 'OBJECTID');
        let payload;
        if (params.has('returnCountOnly')) payload = { count: state.deleted ? 0 : 1 };
        else if (params.has('returnIdsOnly')) payload = { objectIdFieldName: 'OBJECTID', objectIds: state.deleted ? [] : [oid] };
        else {
            if (state.failGeometry) return new Response('Unavailable', { status: 503 });
            assert.equal(params.get('outSR'), '4326');
            for (const option of ['geometryPrecision', 'maxAllowableOffset', 'quantizationParameters']) {
                assert.equal(params.has(option), false, 'do not alter the returned source rings');
            }
            payload = { geometryType: 'esriGeometryPolygon', spatialReference: { wkid: 4326 },
                features: [{ attributes: { ZDID: currentKey, OBJECTID: oid }, geometry: { rings } }] };
        }
        return new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } });
    };
    return { calls, state, fetchImpl };
}

for (const [runtime, factory] of [['backend', createArcgisParcelSource], ['browser', browserParcelFactories.arcgis]]) {
    test(`${runtime}: Yulin current and stale keys sharing one OID resolve independently on cold reads`, async () => {
        const mock = provider();
        const requested = [staleId, currentId, currentId];
        const read = () => factory(descriptor, { fetchImpl: mock.fetchImpl }).queryIds(requested);
        const first = await read();
        assert.equal(first.complete, true);
        assert.deepEqual(first.absentIds, [staleId]);
        assert.deepEqual(first.features.map(feature => feature.id), [currentId]);
        assert.equal(first.features[0].properties.parcelNumber, currentKey);
        assert.deepEqual(first.features[0].properties.sourceProperties, { ZDID: currentKey, OBJECTID: oid });
        assert.deepEqual(first.features[0].geometry, { type: 'Polygon', coordinates: rings });
        assert.deepEqual(await read(), first);
        assert.equal(mock.calls.length, 6, 'each fresh factory independently checks count, manifest and geometry');
        mock.state.deleted = true;
        const removed = await read();
        assert.equal(removed.complete, true);
        assert.deepEqual(removed.features, []);
        assert.deepEqual(removed.absentIds, [staleId, currentId]);
    });

    test(`${runtime}: Yulin geometry transport failure cannot become absence for either composite key`, async () => {
        const mock = provider();
        mock.state.failGeometry = true;
        const source = factory(descriptor, { fetchImpl: mock.fetchImpl });
        await assert.rejects(source.queryIds([staleId, currentId]), /503|unavailable/i);
        assert.equal(mock.calls.length, 3);
        mock.state.failGeometry = false;
        const retried = await source.queryIds([currentId]);
        assert.deepEqual(retried.features.map(feature => feature.id), [currentId]);
        assert.deepEqual(retried.absentIds, []);
        assert.deepEqual(retried.features[0].geometry, { type: 'Polygon', coordinates: rings });
    });
}
