// Synthetic NetGIS fixtures exercise identity, topology preservation and transfer-cap safety.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createNetgisParcelSource, parseNetgisParcels, NETGIS_SOURCE_ID, NETGIS_ENDPOINT,
    ANTAKYA_SOURCE_ID, ANTAKYA_ENDPOINT } from '../parcels/netgis-runxml-source.js';
import { validateParcelProviderRelayRequest } from '../parcels/provider-relay.js';

const prefix = 'TR-ILKADIM-KENTREHBERI-OBJECTID-';
const descriptor = { id: NETGIS_SOURCE_ID, endpoint: NETGIS_ENDPOINT, adapter: 'netgis-runxml',
    workspace: 'REHBER7', layer: 'kentrehberi_parsel', idField: 'objectid', idPrefix: prefix,
    outFields: ['objectid'], sourceCrs: 'EPSG:7934', pageSize: 200, maxFeatures: 2000, maxBboxKm2: 1,
    sourceProjection: 'PROJCS["ITRF96 / TM36",GEOGCS["ITRF 1996",DATUM["International Terrestrial Reference Frame 1996",SPHEROID["GRS 1980",6378137,298.257222101]],PRIMEM["Greenwich",0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["Central_Meridian",36],PARAMETER["Latitude_Of_Origin",0],PARAMETER["Scale_Factor",1],PARAMETER["False_Easting",500000],PARAMETER["False_Northing",0],UNIT["Metre",1]]' };
const ring = '526490,4573297,0 526500,4573297,0 526500,4573307,0 526490,4573297,0';
const boundary = (name, text = ring) => `<gml:${name}><gml:LinearRing><gml:coordinates decimal="." cs="," ts=" ">${text}</gml:coordinates></gml:LinearRing></gml:${name}>`;
const polygon = (holes = '') => `<geometryMember><gml:Polygon srsName="EPSG:7934">${boundary('outerBoundaryIs')}${holes}</gml:Polygon></geometryMember>`;
const row = (id = '7', parts = polygon()) => `<gml:featureMember id="objectid"><kentrehb3A.Bağlantı1.kentrehberi_parsel><objectid>${id}</objectid><GEOMETRY><MultiGeometry>${parts}</MultiGeometry></GEOMETRY></kentrehb3A.Bağlantı1.kentrehberi_parsel></gml:featureMember>`;
const collection = rows => `<wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs" xmlns:gml="http://www.opengis.net/gml">${rows}</wfs:FeatureCollection>`;
const wrapped = xml => `<string xmlns="http://tempuri.org/">${xml.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</string>`;

test('uses lowercase objectid and preserves all multipart rings, holes and Z', () => {
    const parsed = parseNetgisParcels(wrapped(collection(row('7', polygon(boundary('innerBoundaryIs')) + polygon()))));
    assert.equal(parsed[0].id, '7');
    assert.equal(parsed[0].geometry.type, 'MultiPolygon');
    assert.equal(parsed[0].geometry.coordinates.length, 2);
    assert.equal(parsed[0].geometry.coordinates[0].length, 2);
    assert.deepEqual(parsed[0].geometry.coordinates[0][1][0], [526490,4573297,0]);
});
test('rejects conflicting native IDs, foreign CRS and unclosed rings', () => {
    for (const xml of [collection(row() + row('7', polygon().replaceAll('526500', '526501'))), collection(row()).replace('EPSG:7934', 'EPSG:4326'),
        collection(row()).replaceAll(ring, '1,2,0 2,3,0 3,4,0 4,5,0')]) {
        assert.throws(() => parseNetgisParcels(xml));
    }
});
test('normalizes identical wire repeats of one ID while retaining distinct IDs and the raw transfer count', () => {
    const parsed = parseNetgisParcels(collection(row('7') + row('7') + row('8')));
    assert.equal(parsed.responseRowCount, 3);
    assert.deepEqual(parsed.map(p => p.id), ['7', '8']);
    assert.deepEqual(parsed[0].geometry, parsed[1].geometry);
});
test('fresh exact reads return only safe identity and projected geometry; absence is explicit', async () => {
    const requests = [];
    const source = createNetgisParcelSource(descriptor, { fetchImpl: async (url, init) => {
        assert.equal(url, NETGIS_ENDPOINT); requests.push(init);
        const form = new URLSearchParams(init.body);
        assert.equal(form.get('ServiceName'), 'CONMAN.GETINFOEX');
        return new Response(wrapped(collection(form.get('DataXML').includes('<Literal>8</Literal>') ? '' : row())));
    } });
    const a = await source.queryIds([prefix + '7']);
    const b = await source.queryIds([prefix + '7']);
    assert.deepEqual(a, b); assert.equal(requests.length, 2);
    assert.deepEqual(a.features[0].properties.sourceProperties, { objectid: '7' });
    assert.equal(a.features[0].geometry.coordinates[0][0][2], 0);
    assert.ok(Math.abs(a.features[0].geometry.coordinates[0][0][0] - 36.316) < 0.001);
    const absent = await source.queryIds([prefix + '8']);
    assert.deepEqual(absent.absentIds, [prefix + '8']);
    await assert.rejects(source.queryIds([prefix + '7 OR 1=1']));
    assert.equal(requests.length, 3);
});
test('rejects a foreign exact result and never treats a capped area response as complete', async () => {
    const source = createNetgisParcelSource({ ...descriptor, pageSize: 1 }, {
        fetchImpl: async () => new Response(wrapped(collection(row()))) });
    await assert.rejects(source.queryIds([prefix + '8']));
    await assert.rejects(source.queryBounds([36.316,41.294,36.3165,41.2945]), /cap|budget/);
});
test('identical wire rows count toward caps but produce one complete exact native entity', async () => {
    const source = createNetgisParcelSource({ ...descriptor, pageSize: 2 }, {
        fetchImpl: async () => new Response(wrapped(collection(row() + row()))) });
    const exact = await source.queryIds([prefix + '7']);
    assert.equal(exact.complete, true);
    assert.equal(exact.features.length, 1);
    // Two raw rows reach the cap even though they represent only one entity.
    await assert.rejects(source.queryBounds([36.316,41.294,36.3165,41.2945]), /cap|budget/);
});
test('bounded production form passes the registered provider byte relay', () => {
    const request = validateParcelProviderRelayRequest(NETGIS_SOURCE_ID, { url: NETGIS_ENDPOINT, method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/xml' },
        body: new URLSearchParams({ WorkSpace: 'REHBER7', ServiceName: 'CONMAN.GETINFOEX', DataXML: '<GetInfoEx/>' }).toString(),
        redirect: 'error' }, { sources: [descriptor] });
    assert.equal(request.target.href, NETGIS_ENDPOINT);
});

const sanliurfa = { ...descriptor, id: 'tr-sanliurfa-buyuksehir-netgis-parcels',
    endpoint: 'https://keos.sanliurfa.bel.tr/Netgis7/ncwebgisservice.asmx/RunXML', workspace: 'REHBER6',
    idPrefix: 'TR-SANLIURFA-KENTREHBERI-OBJECTID-', sourceCrs: 'EPSG:7935',
    sourceProjection: descriptor.sourceProjection.replace('TM36', 'TM39').replace('Meridian",36', 'Meridian",39') };
const sanliurfaRing = '482218.97048538283,4115013.876324758,0 482194.7205092147,4115019.7663381863,0 482187.7704961321,4114994.996363289,0 482194.14049027476,4114993.9363593576,0 482214.3504709623,4114989.73634749,0 482218.97048538283,4115013.876324758,0';
const sanliurfaXml = collection(row('573178')).replaceAll('EPSG:7934', 'EPSG:7935').replaceAll(ring, sanliurfaRing);
const startup = overrides => `<script type='text/javascript'>_startupParameters=${JSON.stringify({
    Workspace: 'REHBER6', WebgisUrl: 'https://keos.sanliurfa.bel.tr/Netgis7', SessionId: 'a'.repeat(32), ...overrides })}</script>`;

test('Şanlıurfa uses public anonymous bootstrap, native CRS and fresh repeatable exact reads', async () => {
    let bootstraps = 0, posts = 0;
    const source = createNetgisParcelSource(sanliurfa, { fetchImpl: async (url, init) => {
        if (url === 'https://keos.sanliurfa.bel.tr/keos/') { bootstraps++; return new Response(startup()); }
        assert.equal(url, sanliurfa.endpoint);
        const form = new URLSearchParams(init.body);
        assert.equal(form.get('WorkSpace'), 'REHBER6');
        assert.equal(form.get('SessionId'), 'a'.repeat(32));
        assert.ok(form.get('DataXML').includes('<PropertyNames>objectid,GEOMETRY</PropertyNames>'));
        posts++;
        return new Response(wrapped(sanliurfaXml));
    } });
    const id = sanliurfa.idPrefix + '573178';
    const first = await source.queryIds([id]);
    const second = await source.queryIds([id]);
    assert.deepEqual(first, second);
    assert.equal(bootstraps, 1); assert.equal(posts, 2);
    const xy = first.features[0].geometry.coordinates[0][0];
    assert.ok(Math.abs(xy[0] - 38.7998) < 0.001);
    assert.ok(Math.abs(xy[1] - 37.1665) < 0.001);
    assert.equal(xy[2], 0);
    assert.deepEqual(first.features[0].properties.sourceProperties, { objectid: '573178' });
    await assert.rejects(source.queryIds([prefix + '573178']), /native NetGIS/);
});

test('Şanlıurfa validates public viewer binding and rejects foreign GML CRS', async () => {
    for (const overrides of [{ Workspace: 'REHBER7' }, { WebgisUrl: 'https://example.invalid/Netgis7' }, { SessionId: '' }]) {
        let requests = 0;
        const source = createNetgisParcelSource(sanliurfa, { fetchImpl: async () => { requests++; return new Response(startup(overrides)); } });
        await assert.rejects(source.queryIds([sanliurfa.idPrefix + '573178']), /viewer binding/);
        assert.equal(requests, 1);
    }
    assert.throws(() => parseNetgisParcels(sanliurfaXml));
    assert.equal(parseNetgisParcels(sanliurfaXml, 'EPSG:7935')[0].id, '573178');
    assert.throws(() => createNetgisParcelSource({ ...sanliurfa, workspace: 'REHBER7' }));
});

test('Şanlıurfa spatial requests send TM39 E,N and both public resources pass the fixed relay', async () => {
    const source = createNetgisParcelSource(sanliurfa, { fetchImpl: async (url, init) => {
        if (url.endsWith('/keos/')) return new Response(startup());
        const xml = new URLSearchParams(init.body).get('DataXML');
        assert.match(xml, /srsName="EPSG:7935"/);
        const coordinate = xml.match(/ts=" ">([^<]+)/)[1].split(' ')[0].split(',').map(Number);
        assert.ok(coordinate[0] > 480000 && coordinate[0] < 485000);
        assert.ok(coordinate[1] > 4114000 && coordinate[1] < 4116000);
        return new Response(wrapped(sanliurfaXml));
    } });
    assert.equal((await source.queryBounds([38.799,37.166,38.800,37.167])).features.length, 1);
    for (const url of [sanliurfa.endpoint, 'https://keos.sanliurfa.bel.tr/keos/']) {
        const post = url === sanliurfa.endpoint;
        const relay = validateParcelProviderRelayRequest(sanliurfa.id, { url, method: post ? 'POST' : 'GET',
            headers: post ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {},
            ...(post ? { body: new URLSearchParams({ WorkSpace: 'REHBER6', DataXML: '<GetInfoEx/>' }).toString() } : {}),
            redirect: 'error' }, { sources: [{ ...sanliurfa, homepage: 'https://keos.sanliurfa.bel.tr/keos/', catalogueUrl: 'https://keos.sanliurfa.bel.tr/keos/' }] });
        assert.equal(relay.target.href, url);
    }
});

test('canceling the initial viewport read does not poison shared anonymous bootstrap', async () => {
    let ready, finish, bootstrapSignal, bootstraps = 0;
    const started = new Promise(resolve => { ready = resolve; });
    const bootstrap = new Promise(resolve => { finish = resolve; });
    const source = createNetgisParcelSource(sanliurfa, { fetchImpl: async (url, init) => {
        if (url.endsWith('/keos/')) { bootstrapSignal = init.signal; bootstraps++; ready(); return bootstrap; }
        init.signal.throwIfAborted();
        return new Response(wrapped(sanliurfaXml));
    } });
    const controller = new AbortController(), id = sanliurfa.idPrefix + '573178';
    const canceled = source.queryIds([id], { signal: controller.signal });
    const failure = assert.rejects(canceled, { name: 'AbortError' });
    await started; controller.abort();
    assert.equal(bootstrapSignal.aborted, false);
    finish(new Response(startup()));
    await failure;
    assert.equal((await source.queryIds([id])).features[0].id, id);
    assert.equal(bootstraps, 1);
});

test('failed public bootstrap remains retryable on the next exact read', async () => {
    let bootstraps = 0;
    const source = createNetgisParcelSource(sanliurfa, { fetchImpl: async url => {
        if (url.endsWith('/keos/')) {
            if (++bootstraps === 1) throw Error('temporary transport failure');
            return new Response(startup());
        }
        return new Response(wrapped(sanliurfaXml));
    } });
    const id = sanliurfa.idPrefix + '573178';
    await assert.rejects(source.queryIds([id]), /temporary transport failure/);
    assert.equal((await source.queryIds([id])).features[0].id, id);
    assert.equal(bootstraps, 2);
});

const antakya = { ...descriptor, id: ANTAKYA_SOURCE_ID, endpoint: ANTAKYA_ENDPOINT, workspace: 'REHBER6',
    idPrefix: 'TR-ANTAKYA-KEOS-KENTREHBERI-OBJECTID-',
    homepage: 'https://keos.antakya.bel.tr/keos/', catalogueUrl: 'https://keos.antakya.bel.tr/keos/' };
const antakyaStartup = () => startup({ WebgisUrl: 'https://keos.antakya.bel.tr/Netgis7' });
const antakyaRing = '514200,4009380,0 514210,4009380,0 514210,4009390,0 514200,4009380,0';
const antakyaXml = collection(row()).replaceAll(ring, antakyaRing);

test('Antakya public handler uses its own form contract and repeats fresh exact reads in TM36', async () => {
    let posts = 0, bootstraps = 0;
    const source = createNetgisParcelSource(antakya, { fetchImpl: async (url, init) => {
        if (url === antakya.homepage) { bootstraps++; return new Response(antakyaStartup()); }
        assert.equal(url, ANTAKYA_ENDPOINT);
        const form = new URLSearchParams(init.body);
        assert.deepEqual([...form.keys()].sort(), ['dataXML', 'serviceName', 'sessionId', 'webgisUrl', 'workspaceName']);
        assert.equal(form.get('webgisUrl'), 'https://keos.antakya.bel.tr/Netgis7');
        assert.equal(form.get('workspaceName'), 'REHBER6');
        assert.equal(form.get('serviceName'), 'CONMAN.GETINFOEX');
        assert.equal(form.get('sessionId'), 'a'.repeat(32));
        assert.match(form.get('dataXML'), /<PropertyNames>objectid,GEOMETRY<\/PropertyNames>/);
        assert.match(form.get('dataXML'), /<Literal>7<\/Literal>/);
        posts++; return new Response(antakyaXml);
    } });
    const id = antakya.idPrefix + '7';
    const first = await source.queryIds([id]), second = await source.queryIds([id]);
    assert.deepEqual(first, second);
    assert.equal(posts, 2); assert.equal(bootstraps, 1);
    const xy = first.features[0].geometry.coordinates[0][0];
    assert.ok(Math.abs(xy[0] - 36.15792) < 0.0001);
    assert.ok(Math.abs(xy[1] - 36.21472) < 0.0001);
    assert.deepEqual(first.features[0].properties.sourceProperties, { objectid: '7' });
    assert.throws(() => createNetgisParcelSource({ ...antakya, endpoint: NETGIS_ENDPOINT }));
    await assert.rejects(source.queryIds([prefix + '7']));
});

test('Antakya sends spatial E,N axes and rejects duplicate native IDs', async () => {
    const source = createNetgisParcelSource(antakya, { fetchImpl: async (url, init) => {
        if (url === antakya.homepage) return new Response(antakyaStartup());
        const xml = new URLSearchParams(init.body).get('dataXML');
        const coordinate = xml.match(/ts=" ">([^<]+)/)[1].split(' ')[0].split(',').map(Number);
        assert.ok(coordinate[0] > 514000 && coordinate[0] < 514500);
        assert.ok(coordinate[1] > 4009000 && coordinate[1] < 4009600);
        return new Response(antakyaXml);
    } });
    assert.equal((await source.queryBounds([36.157,36.214,36.159,36.216])).features.length, 1);
    const duplicateSource = createNetgisParcelSource(antakya, { fetchImpl: async url =>
        new Response(url === antakya.homepage ? antakyaStartup() : collection(row() + row())) });
    await assert.rejects(duplicateSource.queryIds([antakya.idPrefix + '7']), /duplicate native ID/);
});

test('Antakya viewer and bounded handler forms pass the fixed provider relay', () => {
    for (const url of [ANTAKYA_ENDPOINT, antakya.homepage]) {
        const post = url === ANTAKYA_ENDPOINT;
        const result = validateParcelProviderRelayRequest(ANTAKYA_SOURCE_ID, { url, method: post ? 'POST' : 'GET',
            headers: post ? { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/xml' } : {},
            ...(post ? { body: new URLSearchParams({ workspaceName: 'REHBER6',
                webgisUrl: 'https://keos.antakya.bel.tr/Netgis7', serviceName: 'CONMAN.GETINFOEX',
                sessionId: 'a'.repeat(32), dataXML: '<GetInfoEx/>' }).toString() } : {}),
            redirect: 'error' }, { sources: [antakya] });
        assert.equal(result.target.href, url);
    }
});
