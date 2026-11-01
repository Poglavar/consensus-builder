import test from 'node:test';
import assert from 'node:assert/strict';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';
import { BHUVAN_AREA_STYLE, createBhuvanTgCadSource } from '../parcels/bhuvan-tg-cad-source.js';

const descriptor = { id: 'in-nrsc-bhuvan-telangana-tg-cad-gfi', adapter: 'bhuvan-tg-cad',
    endpoint: 'https://bhuvan-vec1.nrsc.gov.in/bhuvan/ows', layer: 'cadastral:TG_Cad', style: 'cad_2d_new',
    idField: 'fid', idFields: ['fid'], idPrefix: 'IN-NRSC-TG-', outFields: ['fid'], lookupBounds: [80.05,17.12,80.29,17.38] };
const native = 'TG_Cad.2746179', id = descriptor.idPrefix + native;
const ring = '80.185,17.255 80.186,17.255 80.186,17.256 80.185,17.255';
const hole = '80.1855,17.2552 80.1856,17.2552 80.1856,17.2553 80.1855,17.2552';
const boundary = (name, text) => `<gml:${name}><gml:LinearRing><gml:coordinates decimal="." cs="," ts=" ">${text}</gml:coordinates></gml:LinearRing></gml:${name}>`;
const polygon = () => `<gml:polygonMember><gml:Polygon>${boundary('outerBoundaryIs',ring)}${boundary('innerBoundaryIs',hole)}</gml:Polygon></gml:polygonMember>`;
const member = (fid = native) => `<gml:featureMember><cad:TG_Cad fid="${fid}"><cad:the_geom><gml:MultiPolygon srsName="http://www.opengis.net/gml/srs/epsg.xml#4326">${polygon()}${polygon()}</gml:MultiPolygon></cad:the_geom></cad:TG_Cad></gml:featureMember>`;
const xml = members => `<wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs" xmlns:gml="http://www.opengis.net/gml" xmlns:cad="http://bhuvan-vec1.nrsc.gov.in/cadastral">${members}</wfs:FeatureCollection>`;
const geometry = { type: 'MultiPolygon', coordinates: Array.from({ length: 2 }, () => [ring,hole].map(s => s.split(' ').map(p => p.split(',').map(Number)))) };

test('backend and browser use fresh native-fid lookup then preserve every source part and ring', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => { calls.push({ params: new URL(url).searchParams, init }); return new Response(xml(member())); };
    const first = await createParcelSource(descriptor, { fetchImpl }).queryIds([id]);
    const second = await browserParcelFactories['bhuvan-tg-cad'](descriptor, { fetchImpl }).queryIds([id]);
    assert.deepEqual(first, second);
    assert.deepEqual(first.features[0].geometry, geometry);
    assert.deepEqual(first.features[0].properties.sourceProperties, { fid: native });
    assert.deepEqual(first.absentIds, []);
    assert.equal(calls.length, 4);
    calls.forEach(({ params, init }, index) => {
        assert.equal(params.get('featureid'), native);
        assert.equal(params.get('propertyName'), 'the_geom');
        assert.equal(params.get('version'), '1.1.1');
        assert.equal(params.get('srs'), 'EPSG:4326');
        assert.equal(params.get('SLD_BODY'), index % 2 ? null : BHUVAN_AREA_STYLE);
        assert.equal(params.get('styles'), index % 2 ? 'cad_2d_new' : '');
        assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'error');
    });
    assert.equal(calls[1].params.get('bbox'), calls[3].params.get('bbox'));
});

test('bounds send whole-frame SLD and CRS-explicit BBOX, then reread exact polygons', async () => {
    const calls = [];
    const source = createBhuvanTgCadSource(descriptor, { fetchImpl: async url => {
        calls.push(new URL(url).searchParams); return new Response(xml(member()));
    } });
    const read = await source.queryBounds([80.184,17.254,80.187,17.257]);
    assert.equal(read.features.length, 1); assert.deepEqual(read.features[0].geometry, geometry);
    assert.equal(calls[0].get('cql_filter'), "BBOX(the_geom,80.184,17.254,80.187,17.257,'EPSG:4326')");
    assert.equal(calls[0].get('SLD_BODY'), BHUVAN_AREA_STYLE);
    assert.equal(calls[1].get('featureid'), native);
    const misses = await source.queryBounds([80.18,17.25,80.181,17.251]);
    assert.equal(misses.features.length, 0);
});

test('generalized locator is never returned and independent calls repeat both live reads', async () => {
    let calls = 0;
    const source = createBhuvanTgCadSource(descriptor, { fetchImpl: async url => {
        calls++;
        const params = new URL(url).searchParams;
        return new Response(params.has('SLD_BODY') ? xml(member()).replaceAll(ring, '80.185,17.255 '.repeat(3)+'80.185,17.255') : xml(member()));
    } });
    const first = await source.queryIds([id]); const second = await source.queryIds([id]);
    assert.equal(calls, 4); assert.deepEqual(first, second); assert.deepEqual(first.features[0].geometry, geometry);
});

test('unlocated IDs are unresolved, never state-wide absence; rejects unsafe IDs before fetching', async () => {
    let calls = 0;
    const source = createBhuvanTgCadSource(descriptor, { fetchImpl: async () => { calls++; return new Response(xml('')); } });
    await assert.rejects(source.queryIds([id]), { code: 'parcel-id-not-located' });
    await assert.rejects(source.queryIds([id+"' OR 1=1"]), { status: 400 });
    await assert.rejects(source.queryBounds([79,17,79.001,17.001]), { status: 400 });
    assert.equal(calls, 1);
});

test('fails closed on foreign IDs, duplicate native fids, extra attributes, wrong CRS and malformed XML', async () => {
    for (const payload of [xml(member('TG_Cad.10')), xml(member()+member()),
        xml(member()).replace('<cad:the_geom>', '<cad:address>unsafe</cad:address><cad:the_geom>'),
        xml(member()).replace('epsg.xml#4326','epsg.xml#3857'), '<broken>',
        xml(member()).replace('<gml:Polygon>', '<gml:Polygon srsName="EPSG:3857">'),
        xml(member()).replace('</gml:LinearRing>', '</gml:LinearRing><gml:LinearRing/>'),
        '<!DOCTYPE x [<!ENTITY bad SYSTEM "file:///etc/passwd">]>'+xml(member())]) {
        await assert.rejects(createBhuvanTgCadSource(descriptor, { fetchImpl: async () => new Response(payload) }).queryIds([id]), { status: 502 });
    }
});

test('caps streamed bytes, propagates HTTP denial/cancellation, serializes operations', async () => {
    await assert.rejects(createBhuvanTgCadSource(descriptor, { maxResponseBytes: 1024, fetchImpl: async () => new Response(' '.repeat(1025)) }).queryIds([id]), { status: 502 });
    await assert.rejects(createBhuvanTgCadSource(descriptor, { fetchImpl: async () => new Response('', { status: 403 }) }).queryIds([id]), { upstreamStatus: 403 });
    const controller = new AbortController(); controller.abort(new Error('cancelled'));
    await assert.rejects(createBhuvanTgCadSource(descriptor).queryIds([id], { signal: controller.signal }), /cancelled/);
    let active = 0, peak = 0;
    const source = createBhuvanTgCadSource(descriptor, { fetchImpl: async () => {
        peak = Math.max(peak, ++active); await new Promise(resolve => setTimeout(resolve, 5)); active--; return new Response(xml(member()));
    } });
    await Promise.all([source.queryIds([id]),source.queryIds([id])]); assert.equal(peak, 1);
});
