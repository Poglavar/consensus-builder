// Synthetic source-contract tests for Sofia axes, safe fields, exact reads and bounded paging.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSofiaParcelSource, isSofiaParcelUrl, SOFIA_ENDPOINT, SOFIA_SOURCE_ID } from '../parcels/sofia-isofmap-source.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';
import { createParcelSource } from '../parcels/sources.js';
import { fetchParcelProviderRelay, validateParcelProviderRelayRequest } from '../parcels/provider-relay.js';

const d = { id: SOFIA_SOURCE_ID, adapter: 'sofia-isofmap', endpoint: SOFIA_ENDPOINT,
    version: '1.1.0', boundsVersion: '2.0.0', featureType: 'cad_immovable', idField: 'cadnumber',
    geometryField: 'msGeometry', responseCrs: 'EPSG:7801', idType: 'string',
    idPrefix: 'BG-SOFIA-ISOFMAP-CAD-IMMOVABLE|cadnumber|', parcelNumberField: 'cadnumber', outFields: ['cadnumber'] };
const id = '68134.901.5', canonical = d.idPrefix + id;
function xml({ nativeId = id, next, empty = false, wfs2 = false, geometry = '' } = {}) {
    const ring = '4729795.309 321721.267 4729795.309 321731.267 4729805.309 321731.267 4729805.309 321721.267 4729795.309 321721.267';
    return `<wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs${wfs2 ? '/2.0' : ''}" xmlns:gml="http://www.opengis.net/gml" xmlns:ms="http://mapserver.gis.umn.edu/mapserver"${wfs2 ? ` numberMatched="unknown" numberReturned="${empty ? 0 : 1}"` : ''}${next ? ` next="${next.replaceAll('&', '&amp;')}"` : ''}>
    ${empty ? '' : `<gml:featureMember><ms:cad_immovable><ms:cadnumber>${nativeId}</ms:cadnumber><ms:msGeometry>${geometry || `<gml:Polygon srsName="EPSG:7801"><gml:exterior><gml:LinearRing><gml:posList srsDimension="2">${ring}</gml:posList></gml:LinearRing></gml:exterior><gml:interior><gml:LinearRing><gml:posList>4729797 321723 4729797 321724 4729798 321724 4729798 321723 4729797 321723</gml:posList></gml:LinearRing></gml:interior></gml:Polygon>`}</ms:msGeometry></ms:cad_immovable></gml:featureMember>`}</wfs:FeatureCollection>`;
}

test('backend and browser factories retain native cadastral IDs and N/E polygon holes', async () => {
    let calls = 0;
    const fetchImpl = async url => {
        calls++;
        assert.equal(isSofiaParcelUrl(new URL(url)), true);
        assert.equal(new URL(url).searchParams.get('PROPERTYNAME'), 'ms:cadnumber,ms:msGeometry');
        return new Response(xml());
    };
    for (const factory of [createParcelSource]) {
        const source = factory(d, { fetchImpl });
        const first = await source.queryIds([canonical]), second = await source.queryIds([canonical]);
        assert.deepEqual(first, second);
        assert.equal(first.features[0].id, canonical);
        assert.equal(first.features[0].geometry.coordinates.length, 2);
        const [lon, lat] = first.features[0].geometry.coordinates[0][0];
        assert.ok(Math.abs(lon - 23.3244) < 0.001 && Math.abs(lat - 42.6829) < 0.001);
        assert.deepEqual(Object.keys(first.features[0].properties.sourceProperties), ['cadnumber']);
    }
    assert.equal(calls, 2);
});

test('browser batches an operation through the relay while each upstream read remains GET', async () => {
    let browserRequests = 0, upstreamRequests = 0;
    const source = browserParcelFactories['sofia-isofmap'](d, { fetchImpl: async (url, options) => {
        browserRequests++;
        assert.equal(url, SOFIA_ENDPOINT);
        assert.equal(options.method, 'POST');
        const request = validateParcelProviderRelayRequest(d.id, { url, method: options.method,
            headers: options.headers, body: options.body }, { sources: [d] });
        return fetchParcelProviderRelay(request, { providerFetch: async (target, init) => {
            upstreamRequests++;
            assert.equal(isSofiaParcelUrl(target), true);
            assert.equal(init.method, 'GET');
            return new Response(xml());
        } });
    } });
    for (let i = 0; i < 2; i++) assert.equal((await source.queryIds([canonical])).features[0].id, canonical);
    assert.equal(browserRequests, 2);
    assert.equal(upstreamRequests, 2);
    assert.throws(() => validateParcelProviderRelayRequest(d.id, { url: SOFIA_ENDPOINT, method: 'POST',
        headers: { 'content-type': 'application/json' }, body: '{"_sofiaOperation":"delete","input":[]}' }, { sources: [d] }));
    assert.throws(() => validateParcelProviderRelayRequest(d.id, { url: SOFIA_ENDPOINT, method: 'POST',
        headers: { 'content-type': 'application/json' }, body: '{"_sofiaOperation":"queryIds","input":[],"url":"http://private.invalid"}' }, { sources: [d] }));
});

test('exact filter rejection and explicit absence cannot be confused', async () => {
    const source = createSofiaParcelSource(d, { fetchImpl: async () => new Response(xml({ nativeId: '68134.901.6' })) });
    await assert.rejects(source.queryIds([canonical]), /ignored the exact/);
    const absent = createSofiaParcelSource(d, { fetchImpl: async () => new Response(xml({ empty: true })) });
    assert.deepEqual((await absent.queryIds([canonical])).absentIds, [canonical]);
    await assert.rejects(absent.queryIds([canonical + '<xml>']), /safe Sofia/);
});

test('short pages follow validated continuation and duplicate pages fail', async () => {
    let calls = 0;
    const fetchImpl = async value => {
        const url = new URL(value); calls++;
        assert.equal(isSofiaParcelUrl(url), true);
        const b = url.searchParams.get('BBOX').split(',').slice(0, 4).map(Number);
        assert.ok(b[0] > 4700000 && b[1] < 400000);
        if (calls === 1) {
            url.searchParams.set('STARTINDEX', '1');
            return new Response(xml({ wfs2: true, next: url.href }));
        }
        return new Response(xml({ wfs2: true, nativeId: '68134.901.6' }));
    };
    const read = await createSofiaParcelSource(d, { fetchImpl }).queryBounds([23.323, 42.682, 23.326, 42.685]);
    assert.equal(calls, 2);
    assert.equal(read.complete, true);
    assert.equal(read.features.length, 2);
    calls = 0;
    const repeats = createSofiaParcelSource(d, { fetchImpl: async value => {
        const url = new URL(value);
        url.searchParams.set('STARTINDEX', String(++calls));
        return new Response(xml({ wfs2: true, next: url.href }));
    } });
    await assert.rejects(repeats.queryBounds([23.323, 42.682, 23.326, 42.685]), /repeated a page/);
});

test('HTTP allowlist rejects other routes, fields, operations and excessive queries', async () => {
    let url;
    await createSofiaParcelSource(d, { fetchImpl: async value => { url = new URL(value); return new Response(xml()); } }).queryIds([canonical]);
    for (const [key, value] of [['PROPERTYNAME', 'owner'], ['REQUEST', 'GetCapabilities'], ['VERSION', '1.0.0']]) {
        const changed = new URL(url); changed.searchParams.set(key, value);
        assert.equal(isSofiaParcelUrl(changed), false);
    }
    assert.equal(isSofiaParcelUrl(new URL(url.href.replace('/owsmap?', '/other?'))), false);
    const extra = new URL(url); extra.searchParams.append('FILTER', 'anything');
    assert.equal(isSofiaParcelUrl(extra), false);
});

test('malformed geometry, foreign namespace and streamed byte overflow fail closed', async () => {
    for (const body of [xml({ geometry: '<gml:Point srsName="EPSG:7801"/>' }), xml().replaceAll('http://mapserver.gis.umn.edu/mapserver', 'https://foreign.invalid/')]) {
        await assert.rejects(createSofiaParcelSource(d, { fetchImpl: async () => new Response(body) }).queryIds([canonical]));
    }
    await assert.rejects(createSofiaParcelSource({ ...d, maxResponseBytes: 100 }, { fetchImpl: async () => new Response(xml()) }).queryIds([canonical]), /byte limit/);
});
