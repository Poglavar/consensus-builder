import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';
import { createMapGuideParcelSource, parseMapGuideFeatures, NS_ENDPOINT, NS_VIEWER, NS_SOURCE_ID, NS_PROJECTION, isNoviSadPublicRequest } from '../parcels/mapguide-selectfeatures-source.js';
import { fetchParcelProviderRelay, validateParcelProviderRelayRequest, createProviderRelayFetch } from '../parcels/provider-relay.js';
const descriptor = { id: NS_SOURCE_ID, endpoint: NS_ENDPOINT, adapter: 'mapguide-selectfeatures',
    idField: 'FID', geometryField: 'GEOM', idPrefix: 'RS-NS-FID-', outFields: ['FID'],
    resourceId: 'Library://ZigLocations/Data/Topobase_1.FeatureSource', className: 'JPOJOB:KAT_PARCELA',
    nativeProjection: NS_PROJECTION, maxFeatures: 200, browserTransport: 'relay', maxBboxKm2: 0.2 };
const id = 'RS-NS-FID-24440573';
const polygon = 'POLYGON ((7408613 5012837,7408646 5012837,7408646 5012854,7408613 5012837),(7408620 5012840,7408622 5012840,7408622 5012842,7408620 5012840))';
const xml = (property, values) => `<FeatureSet><Features>${values.map(value => `<Feature><Property><Name>${property}</Name><Value>${value}</Value></Property></Feature>`).join('')}</Features></FeatureSet>`;
function mock({ wrongId = false, absent = false, rows = ['24440573'] } = {}) {
    const requests = [];
    const fetchImpl = async (url, init = {}) => {
        requests.push({ url: String(url), body: init.body });
        if (String(url) === NS_VIEWER) return new Response('<iframe src="?SESSION=synthetic_public_session_12345&WEBLAYOUT=Library://layout"/>');
        assert.equal(String(url), NS_ENDPOINT);
        const p = new URLSearchParams(init.body);
        assert.equal(p.get('OPERATION'), 'SELECTFEATURES');
        assert.equal(p.get('CLASSNAME'), 'JPOJOB:KAT_PARCELA');
        assert.ok(['FID', 'GEOM'].includes(p.get('PROPERTIES')));
        const values = p.get('PROPERTIES') === 'GEOM' ? [polygon]
            : p.get('FILTER').startsWith('FID = ') ? absent ? [] : [wrongId ? '42' : '24440573'] : rows;
        return new Response(xml(p.get('PROPERTIES'), values));
    };
    return { fetchImpl, requests };
}
test('production factory repeats exact IDs using fresh anonymous sessions and preserves rings', async () => {
    const m = mock(), adapter = createParcelSource(descriptor, m);
    const first = await adapter.queryIds([id]), second = await adapter.queryIds([id]);
    assert.deepEqual(first, second);
    assert.equal(first.complete, true); assert.deepEqual(first.absentIds, []);
    assert.equal(first.features[0].id, id); assert.equal(first.features[0].geometry.coordinates.length, 2);
    const [lon,lat] = first.features[0].geometry.coordinates[0][0];
    assert.ok(Math.abs(lon-19.836) < 0.001 && Math.abs(lat-45.254) < 0.001);
    assert.equal(m.requests.filter(r => r.url === NS_VIEWER).length, 2);
    assert.deepEqual(Object.keys(first.features[0].properties.sourceProperties), ['FID']);
});
test('complete bounded FID manifests drive individual full geometry reads', async () => {
    const m = mock(), adapter = createMapGuideParcelSource(descriptor, m);
    const read = await adapter.queryBounds([19.835,45.253,19.837,45.255]);
    assert.equal(read.features.length, 1); assert.equal(read.complete, true);
    const p = new URLSearchParams(m.requests[1].body);
    assert.ok(p.get('FILTER').startsWith("GEOM ENVELOPEINTERSECTS GeomFromText('POLYGON (("));
    assert.equal(p.has('MAXFEATURES'), false);
    assert.match(p.get('FILTER'), /740\d{4}/);
    const duplicate = mock({ rows: ['24440573','24440573'] });
    await assert.rejects(createMapGuideParcelSource(descriptor, duplicate).queryBounds([19.835,45.253,19.837,45.255]));
    await assert.rejects(createMapGuideParcelSource({ ...descriptor, maxFeatures: 1 }, mock({rows:['1','2']})).queryBounds([19.835,45.253,19.837,45.255]));
});
test('absence, ignored filters, malformed XML and unsafe inputs fail distinctly', async () => {
    assert.deepEqual((await createMapGuideParcelSource(descriptor, mock({ absent: true })).queryIds([id])).absentIds, [id]);
    await assert.rejects(createMapGuideParcelSource(descriptor, mock({ wrongId: true })).queryIds([id]));
    const m = mock(); await assert.rejects(createMapGuideParcelSource(descriptor, m).queryIds([id + ' OR 1=1']));
    assert.equal(m.requests.length, 0);
    for (const body of ['<FeatureSet><Features><Feature/></Features></FeatureSet>', '<Exception/>', '<FeatureSet/>', '<FeatureSet><Features>', '<!DOCTYPE x><FeatureSet><Features/></FeatureSet>', xml('OTHER',['1'])]) {
        assert.throws(() => parseMapGuideFeatures(body, 'FID'));
    }
});
test('browser registration uses a pinned safe relay operation and repeats live exact reads', async () => {
    const m = mock(); let browserRequests = 0;
    const adapter = browserParcelFactories['mapguide-selectfeatures'](descriptor, { fetchImpl: async (url, init) => {
        browserRequests++;
        const request = validateParcelProviderRelayRequest(descriptor.id, { url, method: init.method, headers: init.headers, body: init.body }, { sources: [descriptor] });
        return fetchParcelProviderRelay(request, { providerFetch: m.fetchImpl });
    } });
    assert.equal((await adapter.queryIds([id])).features[0].id, id);
    assert.equal((await adapter.queryIds([id])).features[0].id, id);
    assert.equal(browserRequests, 2); assert.equal(m.requests.length, 6);
    const good = {url:NS_ENDPOINT,method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({_mapguideOperation:'queryIds',input:[id]})};
    for (const patch of [{url:NS_VIEWER},{url:NS_ENDPOINT+'?OPERATION=DELETE'},{body:'{"_mapguideOperation":"DELETE","input":[]}'},{headers:{'content-type':'text/xml'}}]) {
        assert.throws(() => validateParcelProviderRelayRequest(descriptor.id, {...good,...patch}, {sources:[descriptor]}));
    }
});
test('actual streamed byte overflow cancels before parsing', async () => {
    let cancelled = false;
    const fetchImpl = async () => new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(1024*1024+1));},cancel(){cancelled=true;}}));
    await assert.rejects(createMapGuideParcelSource(descriptor,{fetchImpl}).queryIds([id]));
    assert.equal(cancelled, true);
});

test('real transport gate permits only pinned anonymous HTTP reads before public DNS validation', async () => {
    let httpCalls = 0, dnsCalls = 0;
    const fetchImpl = createProviderRelayFetch({
        lookupImpl: async () => { dnsCalls++; return [{address: '93.184.216.34', family: 4}]; },
        requestImpl: () => { throw new Error('wrong HTTPS transport'); },
        httpRequestImpl: (options, done) => {
            httpCalls++;
            assert.equal(options.protocol, 'http:'); assert.equal(options.hostname, 'www.mapanovisad.rs');
            const req = new EventEmitter(); req.destroy = () => {};
            req.end = body => {
                const incoming = Readable.from([Buffer.from('<html/>')]); incoming.statusCode = 200; incoming.headers = {};
                done(incoming);
            };
            return req;
        }
    });
    assert.equal(await (await fetchImpl(new URL(NS_VIEWER))).text(), '<html/>');
    const m = mock(); await createMapGuideParcelSource(descriptor, m).queryIds([id]);
    const body = m.requests[1].body;
    assert.equal(isNoviSadPublicRequest(new URL(NS_ENDPOINT),'POST',body), true);
    assert.equal(await (await fetchImpl(new URL(NS_ENDPOINT), {method:'POST',body})).text(), '<html/>');
    for (const changed of [body.replace('PROPERTIES=FID','PROPERTIES=OTHER'),body+'&EXTRA=1',body.replace('SELECTFEATURES','DELETEFEATURES')]) {
        await assert.rejects(fetchImpl(new URL(NS_ENDPOINT), {method:'POST',body:changed}));
    }
    await assert.rejects(fetchImpl(new URL(NS_ENDPOINT.replace('mapagent.fcgi','other')), {method:'POST',body}));
    assert.equal(httpCalls, 2); assert.equal(dnsCalls, 2);
});
