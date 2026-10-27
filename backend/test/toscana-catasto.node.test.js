// Exercise native-ID location, GML preservation, complete bounds reads and failure handling.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createToscanaCatastoSource, parseToscanaGml, parseToscanaLocator, TOSCANA_SOURCE, TOSCANA_ENDPOINT } from '../parcels/toscana-catasto-source.js';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';

const descriptor = { id: TOSCANA_SOURCE, adapter: 'toscana-catasto', endpoint: TOSCANA_ENDPOINT,
    layer: 'rt_cat.idcatpart.rt', locatorLayer: 'rt_cat.idcatpart.bbox.rt', idPrefix: 'IT-TOSCANA-',
    idField: 'featureid', outFields: ['featureid'] };
const ring = '11.20,43.75 11.21,43.75 11.21,43.76 11.20,43.76 11.20,43.75';
const hole = '11.202,43.752 11.202,43.753 11.203,43.753 11.203,43.752 11.202,43.752';
const polygon = (outer, inner = '') => `<gml:polygonMember><gml:Polygon><gml:outerBoundaryIs><gml:LinearRing><gml:coordinates>${outer}</gml:coordinates></gml:LinearRing></gml:outerBoundaryIs>${inner ? `<gml:innerBoundaryIs><gml:LinearRing><gml:coordinates>${inner}</gml:coordinates></gml:LinearRing></gml:innerBoundaryIs>` : ''}</gml:Polygon></gml:polygonMember>`;
const member = (id = '0012', parts = polygon(ring, hole) + polygon(ring)) => `<gml:featureMember><ogr:rt_cat.idcatpart.rt fid="response-order.0"><ogr:geometryProperty><gml:MultiPolygon srsName="EPSG:4326">${parts}</gml:MultiPolygon></ogr:geometryProperty><ogr:featureid>${id}</ogr:featureid><ogr:irrelevant>discard</ogr:irrelevant></ogr:rt_cat.idcatpart.rt></gml:featureMember>`;
const xml = rows => `--boundary\r\nContent-Type: application/binary\r\n\r\n<?xml version="1.0"?><ogr:FeatureCollection xmlns:ogr="http://ogr.maptools.org/" xmlns:gml="http://www.opengis.net/gml">${rows}</ogr:FeatureCollection>\r\n--boundary--`;
const locator = (id = '0012') => `<?xml version="1.0"?><wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs" xmlns:gml="http://www.opengis.net/gml" xmlns:ms="http://mapserver.gis.umn.edu/mapserver"><gml:boundedBy><gml:Envelope srsName="urn:ogc:def:crs:EPSG::4326"><gml:lowerCorner>43.75 11.20</gml:lowerCorner><gml:upperCorner>43.76 11.21</gml:upperCorner></gml:Envelope></gml:boundedBy>${id === null ? '' : `<gml:featureMember><ms:rt_cat.idcatpart.bbox.rt gml:id="rt_cat.idcatpart.bbox.rt.${id}"><ms:pkuid>${id}</ms:pkuid></ms:rt_cat.idcatpart.bbox.rt></gml:featureMember>`}</wfs:FeatureCollection>`;

test('preserves all members, holes, source axes, precision and leading-zero native identities', () => {
    const { features } = parseToscanaGml(xml(member()), descriptor);
    assert.equal(features[0].id, 'IT-TOSCANA-0012');
    assert.deepEqual(features[0].geometry.coordinates, [
        [ring.split(' ').map(p => p.split(',').map(Number)), hole.split(' ').map(p => p.split(',').map(Number))],
        [ring.split(' ').map(p => p.split(',').map(Number))]
    ]);
    assert.deepEqual(features[0].properties.sourceProperties, { featureid: '0012' });
    assert.deepEqual(parseToscanaLocator(locator(), '0012'), [11.2,43.75,11.21,43.76]);
    assert.equal(parseToscanaLocator(locator(null), '0012'), null);
});

test('independent exact calls relocate and refetch polygons; radius expansion handles a missed centre', async () => {
    const requests = [];
    const fetchImpl = async (url, init) => {
        const p = new URL(url).searchParams; requests.push(p);
        assert.equal(p.get('map'), 'owscatasto'); assert.equal(init.credentials, 'omit');
        if (p.get('service') === 'WFS') {
            assert.equal(p.get('propertyname'), 'pkuid');
            assert.equal(p.get('featureid'), 'rt_cat.idcatpart.bbox.rt.0012');
            return new Response(locator());
        }
        assert.equal(p.get('bbox'), '43.75,11.2,43.76,11.21');
        return new Response(xml(p.get('radius') === '8' ? '' : member()));
    };
    const source = createParcelSource(descriptor, { fetchImpl });
    const a = await source.queryIds(['IT-TOSCANA-0012']);
    const b = await source.queryIds(['IT-TOSCANA-0012']);
    assert.deepEqual(a,b); assert.equal(a.features.length,1); assert.deepEqual(a.absentIds,[]);
    assert.equal(requests.length,6); assert.equal(requests.filter(p => p.get('service') === 'WFS').length,2);
    assert.equal(browserParcelFactories['toscana-catasto'], createToscanaCatastoSource);
});

test('bounded reads use a covering pixel radius, retain full polygons and filter without clipping', async () => {
    let requests = 0;
    const source = createToscanaCatastoSource(descriptor, { fetchImpl: async url => {
        const p = new URL(url).searchParams; requests++;
        assert.equal(p.get('radius'), '215');
        return new Response(xml(member('12', polygon(ring))));
    } });
    const r = await source.queryBounds([11.204,43.754,11.206,43.756]);
    assert.equal(r.complete,true); assert.equal(r.features.length,1);
    assert.deepEqual(r.features[0].geometry.coordinates[0][0][0], [11.2,43.75]);
    assert.equal((await source.queryBounds([11.22,43.77,11.23,43.78])).features.length,0);
    assert.equal(requests,2);
});

test('a saturated identify window is subdivided before it can be reported complete', async () => {
    let requests = 0;
    const source = createToscanaCatastoSource(descriptor, { fetchImpl: async () => {
        requests++;
        return new Response(xml(requests === 1 ? member('12', polygon(ring)).repeat(501) : member('12', polygon(ring))));
    } });
    const r = await source.queryBounds([11.204,43.754,11.206,43.756]);
    assert.equal(requests,5); assert.equal(r.complete,true); assert.equal(r.features.length,1);
});

test('rejects conflicting identities, omitted members, foreign CRS, XML entities and unresolved exact IDs', async () => {
    for (const payload of [xml(member()+member('0012',polygon(hole))), xml(member()).replace('EPSG:4326','EPSG:3857'),
        xml(member()).replace('<gml:polygonMember>', '<gml:polygonMember xlink:href="x" xmlns:xlink="http://www.w3.org/1999/xlink">').replace('<gml:Polygon>',''),
        xml(member()).replace('<?xml version="1.0"?>','<?xml version="1.0"?><!DOCTYPE x [<!ENTITY x SYSTEM "file:///etc/passwd">]>')]) {
        assert.throws(() => parseToscanaGml(payload,descriptor), { status: 502 });
    }
    assert.throws(() => parseToscanaLocator(locator('13'), '0012'), { status: 502 });
    const source = createToscanaCatastoSource(descriptor, { fetchImpl: async url => new Response(new URL(url).searchParams.get('service') === 'WFS' ? locator() : xml('')) });
    await assert.rejects(source.queryIds(['IT-TOSCANA-0012']), { status: 502 });
    await assert.rejects(source.queryIds(["IT-TOSCANA-12' OR 1=1"]), { status: 400 });
    const absent = createToscanaCatastoSource(descriptor, { fetchImpl: async () => new Response(locator(null)) });
    assert.deepEqual((await absent.queryIds(['IT-TOSCANA-0012'])).absentIds, ['IT-TOSCANA-0012']);
});

test('enforces streamed byte caps, HTTP denial, cancellation and bounded-query limits', async () => {
    const limited = createToscanaCatastoSource(descriptor, { maxResponseBytes: 1024,
        fetchImpl: async () => new Response('x'.repeat(1025)) });
    await assert.rejects(limited.queryIds(['IT-TOSCANA-12']), { status: 502 });
    const denied = createToscanaCatastoSource(descriptor, { fetchImpl: async () => new Response('', { status:403 }) });
    await assert.rejects(denied.queryIds(['IT-TOSCANA-12']), { code:'parcel-source-blocked', upstreamStatus:403 });
    await assert.rejects(denied.queryBounds([11,43,12,44]), { status:400 });
    const controller = new AbortController(); controller.abort();
    const canceled = createToscanaCatastoSource(descriptor, { fetchImpl: async (_url, init) => { init.signal.throwIfAborted(); } });
    await assert.rejects(canceled.queryIds(['IT-TOSCANA-12'], { signal:controller.signal }), { name:'AbortError' });
});
