// Exercise native KML identity, unchanged holes/altitudes and bounded single-member KMZ reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { parseParcelKml, createKmlKmzParcelSource } from '../parcels/kml-kmz-source.js';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';
const descriptor = { id: 'test-kmz', adapter: 'kml-kmz', endpoint: 'https://example.org/parcels.kmz',
    idPrefix: 'test:OBJECTID_1=', idFields: ['OBJECTID_1'], outFields: ['OBJECTID_1'], kmlMember: 'doc.kml',
    maxSnapshotBytes: 100000, maxDecompressedBytes: 100000, maxSnapshotFeatures: 10, maxFeatures: 10 };
const shell = '34,0,0 34.001,0,0 34.001,0.001,0 34,0.001,0 34,0,0';
const hole = '34.0002,0.0002,0 34.0003,0.0002,0 34.0003,0.0003,0 34.0002,0.0002,0';
const polygon = `<Polygon><outerBoundaryIs><LinearRing><coordinates>${shell}</coordinates></LinearRing></outerBoundaryIs><innerBoundaryIs><LinearRing><coordinates>${hole}</coordinates></LinearRing></innerBoundaryIs></Polygon>`;
const placemark = (id = 1361, geometry = polygon) => `<Placemark><description><![CDATA[<table><tr><td>OBJECTID_1</td><td>${id}</td></tr><tr><td>Plot_Owner</td><td>PRIVATE CANARY</td></tr></table>]]></description><MultiGeometry>${geometry}</MultiGeometry></Placemark>`;
const kml = content => strToU8(`<kml xmlns="http://www.opengis.net/kml/2.2"><Document>${content}</Document></kml>`);
test('preserves every source ring and ordinate and discards unrelated attributes', () => {
    const result = parseParcelKml(kml(placemark()), descriptor);
    assert.deepEqual(result.features[0].geometry, { type: 'Polygon', coordinates: [shell, hole].map(text => text.split(' ').map(tuple => tuple.split(',').map(Number))) });
    assert.deepEqual(result.features[0].properties, { OBJECTID_1: 1361 });
    assert.equal(JSON.stringify(result).includes('PRIVATE CANARY'), false);
    const multiple = parseParcelKml(kml(placemark(1361, polygon + polygon)), descriptor);
    assert.equal(multiple.features[0].geometry.type, 'MultiPolygon');
    assert.equal(multiple.features[0].geometry.coordinates.length, 2);
});
test('rejects duplicate IDs, missing IDs, non-polygon geometry and XML entities', () => {
    assert.throws(() => parseParcelKml(kml(placemark() + placemark()), descriptor), /repeated/);
    assert.throws(() => parseParcelKml(kml(placemark().replace('OBJECTID_1', 'other')), descriptor), /native parcel ID/);
    assert.throws(() => parseParcelKml(kml(placemark(1, polygon + '<LineString/>')), descriptor), /non-polygon/);
    assert.throws(() => parseParcelKml(strToU8('<!DOCTYPE kml><kml/>'), descriptor), /document types/);
});
test('production and browser factories use bounded KMZ reads and repeat exact IDs', async () => {
    const bytes = zipSync({ 'doc.kml': kml(placemark()), 'unneeded.xsl': strToU8('not a KML member') });
    let reads = 0;
    const fetchImpl = async () => { reads++; return new Response(bytes); };
    for (const factory of [createKmlKmzParcelSource, createParcelSource, browserParcelFactories['kml-kmz']]) {
        const source = factory(descriptor, { fetchImpl });
        const result = await source.queryIds(['test:OBJECTID_1=1361', 'test:OBJECTID_1=999']);
        assert.deepEqual(result.absentIds, ['test:OBJECTID_1=999']);
        assert.equal(result.features[0].geometry.coordinates.length, 2);
        assert.deepEqual(await source.queryIds(['test:OBJECTID_1=1361']), { ...result, absentIds: [] });
        assert.equal((await source.queryBounds([34, 0, 34.0001, 0.0001])).features.length, 1);
    }
    assert.equal(reads, 3);
    const oversized = createKmlKmzParcelSource({ ...descriptor, maxSnapshotBytes: 32 }, { fetchImpl });
    await assert.rejects(oversized.queryIds(['test:OBJECTID_1=1361']), /byte limit/);
    const expansion = createKmlKmzParcelSource({ ...descriptor, maxDecompressedBytes: 32 }, { fetchImpl });
    await assert.rejects(expansion.queryIds(['test:OBJECTID_1=1361']), /decompressed byte limit/);
});
