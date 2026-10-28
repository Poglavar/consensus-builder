// Check ASIG KML identity, lossless polygon parsing, bounded transport and both runtime factories.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAsigWmsKmlParcelSource, ASIG_SOURCE_ID, ASIG_ENDPOINT } from '../parcels/asig-wms-kml-source.js';
import { parseParcelKml } from '../parcels/kml-kmz-source.js';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';

const descriptor = { id: ASIG_SOURCE_ID, endpoint: ASIG_ENDPOINT, adapter: 'asig-wms-kml',
    layer: 'p_kadas_albscad_072026', style: 'polygon', idPrefix: 'AL-ASIG-', idField: 'inspireid',
    idFields: ['inspireid'], outFields: ['inspireid'], kmlIdEncoding: 'geoserver-span-string',
    kmlAllowLabelPoints: true, maxFeatures: 1000, maxResponseBytes: 8388608, maxBboxKm2: 4 };
const shell = '19.8,41.34,0 19.801,41.34,0 19.801,41.341,0 19.8,41.34,0';
const hole = '19.8002,41.3401,0 19.8003,41.3401,0 19.8003,41.3402,0 19.8002,41.3401,0';
const ring = (text, side) => `<${side}BoundaryIs><LinearRing><coordinates>${text}</coordinates></LinearRing></${side}BoundaryIs>`;
const mark = (id = 'ASHK_PK__412100') => `<Placemark><description><![CDATA[<ul><li><strong><span class="atr-name">inspireid</span>:</strong> <span class="atr-value">${id}</span></li><li><span>unused</span><span>discard me</span></li></ul>]]></description><MultiGeometry><Point><coordinates>19.8,41.34,0</coordinates></Point><Polygon>${ring(shell, 'outer')}${ring(hole, 'inner')}</Polygon></MultiGeometry></Placemark>`;
const kml = content => new TextEncoder().encode(`<kml xmlns="http://www.opengis.net/kml/2.2"><Document>${content}</Document></kml>`);
const parse = bytes => parseParcelKml(bytes, { ...descriptor, maxDecompressedBytes: 8388608, maxSnapshotFeatures: 1001, kmlAllowEmpty: true });

test('string inspireid is the only attribute; label Points do not alter polygon rings or altitude', () => {
    const rows = parse(kml(mark()));
    assert.deepEqual(rows.features[0].properties, { inspireid: 'ASHK_PK__412100' });
    assert.deepEqual(rows.features[0].geometry, { type: 'Polygon', coordinates: [shell, hole].map(text => text.split(' ').map(tuple => tuple.split(',').map(Number))) });
    assert.equal(JSON.stringify(rows).includes('discard me'), false);
    assert.throws(() => parse(kml(mark() + mark())), /repeated/);
    assert.throws(() => parse(kml(mark().replace('inspireid', 'other'))), /native parcel ID/);
    assert.throws(() => parse(kml(mark().replace('<Point>', '<LineString>').replace('</Point>', '</LineString>'))), /non-polygon/);
    assert.throws(() => parse(new TextEncoder().encode('<ServiceExceptionReport/>')), /no parcel polygons/);
    assert.deepEqual(parse(kml('')).features, []);
});

test('backend and browser issue independent exact filters, preserve geometry and report true absence', async () => {
    for (const factory of [createAsigWmsKmlParcelSource, createParcelSource, browserParcelFactories['asig-wms-kml']]) {
        const calls = [];
        const source = factory(descriptor, { fetchImpl: async (url, init) => {
            calls.push({ url: new URL(url), init }); return new Response(kml(mark()));
        } });
        const first = await source.queryIds(['AL-ASIG-ASHK_PK__412100', 'AL-ASIG-ASHK_PK__999']);
        const second = await source.queryIds(['AL-ASIG-ASHK_PK__412100', 'AL-ASIG-ASHK_PK__999']);
        assert.deepEqual(second, first);
        assert.equal(calls.length, 2);
        assert.deepEqual(first.absentIds, ['AL-ASIG-ASHK_PK__999']);
        assert.equal(first.features[0].properties.sourceParcelId, 'ASHK_PK__412100');
        assert.equal(first.features[0].id, 'AL-ASIG-ASHK_PK__412100');
        for (const call of calls) {
            assert.equal(call.url.searchParams.get('CQL_FILTER'), "inspireid IN ('ASHK_PK__412100','ASHK_PK__999')");
            assert.equal(call.url.searchParams.get('styles'), 'polygon');
            assert.equal(call.url.searchParams.get('propertyName'), 'inspireid');
            assert.equal(call.url.searchParams.get('maxFeatures'), '3');
            assert.equal(call.init.credentials, 'omit');
        }
        await assert.rejects(source.queryIds(["AL-ASIG-ASHK_PK__1') OR 1=1"]), /Invalid ASIG/);
        await assert.rejects(source.queryBounds([19, 40, 20, 41]), /area is too large/);
    }
});

test('bounds sentinel, foreign exact IDs, exceptions and actual streamed overflows fail closed', async () => {
    const create = fetchImpl => createAsigWmsKmlParcelSource(descriptor, { fetchImpl });
    const truncated = create(async () => new Response(kml(Array.from({ length: 1001 }, (_, index) => mark(`ASHK_PK__${index}`)).join(''))));
    await assert.rejects(truncated.queryBounds([19.8, 41.34, 19.801, 41.341]), /truncated/);
    const foreign = create(async () => new Response(kml(mark('ASHK_PK__2'))));
    await assert.rejects(foreign.queryIds(['AL-ASIG-ASHK_PK__1']), /truncated/);
    const denied = create(async () => new Response('<ServiceExceptionReport/>'));
    await assert.rejects(denied.queryIds(['AL-ASIG-ASHK_PK__1']), /no parcel polygons/);
    let cancelled = false;
    const oversized = create(async () => new Response(new ReadableStream({
        start(controller) { controller.enqueue(new Uint8Array(8388609)); }, cancel() { cancelled = true; }
    })));
    await assert.rejects(oversized.queryIds(['AL-ASIG-ASHK_PK__1']), /truncated/);
    assert.equal(cancelled, true);
    const empty = create(async () => new Response(kml('')));
    assert.deepEqual((await empty.queryIds(['AL-ASIG-ASHK_PK__1'])).absentIds, ['AL-ASIG-ASHK_PK__1']);
});
