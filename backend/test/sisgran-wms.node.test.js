// Synthetic GML exercises safe SISGRAN identity, geometry, limits and both production factories.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';
import { createSisgranWmsSource } from '../parcels/sisgran-wms-source.js';

const descriptor = { id: 'br-cg-sisgran-infra-imoveis', adapter: 'sisgran-wms',
    endpoint: 'https://sisgran.campogrande.ms.gov.br/sisgran/api/v1/maps/wms',
    layer: 'sisgran:vw_infra_imoveis', idField: 'gid', idPrefix: 'BR-CG-SISGRAN-', outFields: ['gid'] };
const ring = '-54.62,-20.47 -54.619,-20.47 -54.619,-20.469 -54.62,-20.47 -54.62,-20.47';
const hole = '-54.6198,-20.4699 -54.6197,-20.4699 -54.6197,-20.4698 -54.6198,-20.4699';
const boundary = (name, coords) => `<gml:${name}><gml:LinearRing><gml:coordinates decimal="." cs="," ts=" ">${coords}</gml:coordinates></gml:LinearRing></gml:${name}>`;
const member = gid => `<gml:featureMember><sisgran:vw_infra_imoveis fid="unstable-fid"><sisgran:gid>${gid}</sisgran:gid><sisgran:geom><gml:MultiPolygon srsName="http://www.opengis.net/gml/srs/epsg.xml#4326"><gml:polygonMember><gml:Polygon srsName="EPSG:4326">${boundary('outerBoundaryIs',ring)}${boundary('innerBoundaryIs',hole)}</gml:Polygon></gml:polygonMember></gml:MultiPolygon></sisgran:geom></sisgran:vw_infra_imoveis></gml:featureMember>`;
const xml = members => `<wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs" xmlns:gml="http://www.opengis.net/gml" xmlns:sisgran="http://sisgran">${members}</wfs:FeatureCollection>`;
const id = descriptor.idPrefix + '205845';

test('backend and browser independently filter native gid and preserve full rings and holes', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => { calls.push({ url: new URL(url), init }); return new Response(xml(member('205845'))); };
    const first = await createParcelSource(descriptor, { fetchImpl }).queryIds([id]);
    const second = await browserParcelFactories['sisgran-wms'](descriptor, { fetchImpl }).queryIds([id]);
    assert.equal(calls.length, 4);
    assert.deepEqual(first, second);
    assert.deepEqual(first.absentIds, []);
    assert.deepEqual(first.features[0].geometry.coordinates, [[ring,hole].map(text => text.split(' ').map(p => p.split(',').map(Number)))]);
    assert.deepEqual(first.features[0].properties.sourceProperties, { gid: '205845' });
    for (const { url, init } of calls) {
        assert.equal(url.searchParams.get('CQL_FILTER'), 'gid IN (205845)');
        assert.equal(url.searchParams.get('PROPERTYNAME'), 'gid,geom');
        assert.equal(url.searchParams.get('CRS'), 'CRS:84');
        assert.ok(['1024', '4096'].includes(url.searchParams.get('WIDTH')));
        assert.equal(url.searchParams.get('BUFFER'), url.searchParams.get('WIDTH'));
        assert.equal(init.credentials, 'omit');
        assert.equal(init.redirect, 'error');
    }
});

test('bounds specify the geometry filter CRS and return only intersecting exact geometry', async () => {
    const requests = [];
    const source = createSisgranWmsSource(descriptor, { fetchImpl: async url => {
        requests.push(new URL(url).searchParams); return new Response(xml(member('205845')));
    } });
    const bounds = [-54.6201,-20.4701,-54.6189,-20.4689];
    const read = await source.queryBounds(bounds);
    assert.equal(read.features.length, 1);
    assert.equal(requests[0].get('CQL_FILTER'), "BBOX(geom,-54.6201,-20.4701,-54.6189,-20.4689,'EPSG:4326')");
    assert.equal((await source.queryBounds([-54.6,-20.4,-54.599,-20.399])).features.length, 0);
    assert.ok(requests.some(params => params.get('CQL_FILTER') === 'gid IN (205845)'));
});

test('generalized locator geometry never becomes a parcel result or a cached exact read', async () => {
    const requests = [];
    const generalized = xml(member('205845')).replace(ring,
        '-54.6195,-20.4695 -54.6195,-20.4695 -54.6195,-20.4695 -54.6195,-20.4695');
    const source = createSisgranWmsSource(descriptor, { fetchImpl: async url => {
        const params = new URL(url).searchParams; requests.push(params);
        return new Response(params.get('WIDTH') === '4096' ? generalized : xml(member('205845')));
    } });
    const first = await source.queryIds([id]);
    const second = await source.queryIds([id]);
    assert.deepEqual(first.features[0].geometry.coordinates[0][0], ring.split(' ').map(p => p.split(',').map(Number)));
    assert.deepEqual(first, second);
    assert.equal(requests.length, 4);
    assert.deepEqual(requests.map(p => p.get('WIDTH')), ['4096', '1024', '4096', '1024']);
    assert.equal(requests[1].get('BBOX'), requests[3].get('BBOX'));
    const bounds = requests[1].get('BBOX').split(',').map(Number);
    assert.ok(Math.abs(bounds[2] - bounds[0] - 0.005) < 1e-10);
    assert.ok(bounds[0] < -54.6195 && bounds[2] > -54.6195);
});

test('rejects foreign IDs, duplicate IDs, unsafe fields, CRS mismatches and malformed XML', async () => {
    for (const payload of [xml(member('10')), xml(member('205845') + member('205845')),
        xml(member('205845')).replace('<sisgran:gid>', '<sisgran:address>unsafe</sisgran:address><sisgran:gid>'),
        xml(member('205845')).replace('epsg.xml#4326', 'epsg.xml#31981'), '<broken>',
        '<!DOCTYPE x [<!ENTITY bad SYSTEM "file:///etc/passwd">]>' + xml(member('205845'))]) {
        await assert.rejects(createSisgranWmsSource(descriptor, { fetchImpl: async () => new Response(payload) }).queryIds([id]), { status: 502 });
    }
    const empty = createSisgranWmsSource(descriptor, { fetchImpl: async () => new Response(xml('')) });
    assert.deepEqual((await empty.queryIds([id])).absentIds, [id]);
    await assert.rejects(empty.queryIds([id + "' OR 1=1"]), { status: 400 });
    await assert.rejects(empty.queryBounds([-55,-21,-54,-20]), { status: 400 });
});

test('fails closed on saturation, streamed byte limit, upstream HTTP denial and cancellation', async () => {
    await assert.rejects(createSisgranWmsSource(descriptor, { fetchImpl: async () => new Response(xml(member('205845') + member('205846'))) }).queryIds([id]), { status: 502 });
    await assert.rejects(createSisgranWmsSource(descriptor, { maxResponseBytes: 1024, fetchImpl: async () => new Response(' '.repeat(1025)) }).queryIds([id]), { status: 502 });
    await assert.rejects(createSisgranWmsSource(descriptor, { fetchImpl: async () => new Response('', { status: 403 }) }).queryIds([id]), { upstreamStatus: 403 });
    const controller = new AbortController(); controller.abort(new Error('cancelled'));
    await assert.rejects(createSisgranWmsSource(descriptor, { fetchImpl: async (_url, { signal }) => { signal.throwIfAborted(); } }).queryIds([id], { signal: controller.signal }), /cancelled/);
});
