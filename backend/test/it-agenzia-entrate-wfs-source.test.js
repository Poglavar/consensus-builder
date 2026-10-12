// Agenzia delle Entrate INSPIRE CP WFS adapter: strict GML identity/geometry parsing and counted-complete reads.
// Data pages are recorded 2026-09-29 replies (Rome, Milan, Naples; count=3, so truncated by design).
// Hit-count replies are CONSTRUCTED in the MapServer WFS 2.0 shape: live hits behaviour is unverified.
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createAgenziaEntrateWfsParcelSource, parseAgenziaEntrateCollection } from '../parcels/it-agenzia-entrate-wfs-source.js';

const fixture = name => readFileSync(new URL(`./fixtures/it-agenzia-entrate-${name}-count3-2026-09-29.xml`, import.meta.url), 'utf8');
const ROME = fixture('rome-h501'), MILAN = fixture('milan-f205'), NAPLES = fixture('naples-f839');
const ROME_BOUNDS = [12.4820, 41.8985, 12.4835, 41.8995];
const descriptor = {
    id: 'it-agenzia-entrate-inspire-cp', adapter: 'it-agenzia-entrate-wfs',
    endpoint: 'https://wfs.cartografia.agenziaentrate.gov.it/inspire/wfs/owfs01.php',
    featureType: 'CP:CadastralParcel', responseCrs: 'EPSG:6706',
    idField: 'NATIONALCADASTRALREFERENCE', idPrefix: 'IT-AE-', idType: 'string', parcelNumberField: 'LABEL',
    outFields: ['NATIONALCADASTRALREFERENCE', 'ADMINISTRATIVEUNIT', 'LABEL'], maxBboxKm2: 0.25, maxFeatures: 2000, paceMs: 1000
};
const hits = matched => `<?xml version='1.0' encoding="UTF-8" ?>\n<wfs:FeatureCollection xmlns:CP="http://mapserver.gis.umn.edu/mapserver" xmlns:gml="http://www.opengis.net/gml/3.2" xmlns:wfs="http://www.opengis.net/wfs/2.0" timeStamp="2026-10-12T12:00:00" numberMatched="${matched}" numberReturned="0">\n</wfs:FeatureCollection>`;
const members = xml => xml.match(/<wfs:member>[\s\S]*?<\/wfs:member>/g);
// Keep only the named recorded members (by reference) and restate numberReturned accordingly.
function only(xml, refs) {
    const kept = members(xml).filter(member => refs.some(ref => member.includes(`<CP:NATIONALCADASTRALREFERENCE>${ref}<`)));
    const head = xml.slice(0, xml.indexOf('<wfs:member>')).replace(/numberReturned="\d+"/, `numberReturned="${kept.length}"`);
    return `${head}${kept.join('\n')}\n</wfs:FeatureCollection>`;
}
const response = (body, init = {}) => new Response(body, { status: 200, ...init, headers: { 'content-type': 'application/xml', ...(init.headers || {}) } });
function harness(...bodies) {
    let clock = 1_000_000;
    const waits = [], starts = [];
    const fetchImpl = vi.fn(async url => {
        starts.push(clock);
        const next = bodies.shift();
        if (next === undefined) throw new Error(`Unexpected request ${url}`);
        return next instanceof Response ? next : response(next);
    });
    const source = createAgenziaEntrateWfsParcelSource(descriptor, {
        fetchImpl, now: () => clock, waitImpl: async ms => { waits.push(ms); clock += ms; }
    });
    const url = index => new URL(fetchImpl.mock.calls[index][0]);
    return { source, fetchImpl, waits, starts, url };
}
const unavailable = { code: 'parcel-source-unavailable' };

describe('Agenzia delle Entrate GML parsing of recorded replies', () => {
    it('reads all three cities with agreeing identities, lon,lat order and published rings', () => {
        const rome = parseAgenziaEntrateCollection(ROME);
        expect(rome).toMatchObject({ numberMatchedUnknown: true, numberReturned: 3 });
        expect(rome.features.map(f => f.id)).toEqual(['H501A048700.1', 'H501A048600.100', 'H501A048600.101']);
        expect(rome.features[0].properties).toEqual({ NATIONALCADASTRALREFERENCE: 'H501A048700.1', ADMINISTRATIVEUNIT: 'H501', LABEL: '1' });
        // First recorded posList pair is "41.89913480 12.48304918" (lat lon); output is [lon, lat], unrounded.
        expect(rome.features[0].geometry.coordinates[0][0]).toEqual([12.48304918, 41.8991348]);
        expect(rome.features[0].geometry.coordinates[0].length).toBe(24);
        expect(parseAgenziaEntrateCollection(MILAN).features.map(f => f.id)).toEqual(['F205_039000.280', 'F205_039000.H', 'F205_039000.STRADA002']);
        const naples = parseAgenziaEntrateCollection(NAPLES).features[0];
        // MultiSurface with one surface member and four interior rings stays one polygon with all five rings.
        expect(naples.id).toBe('F839_008600.116');
        expect(naples.geometry.type).toBe('Polygon');
        expect(naples.geometry.coordinates.length).toBe(5);
    });

    it.each([
        ['gml:id disagreement', ROME.replace('gml:id="CadastralParcel.IT.AGE.PLA.H501A048700.1"', 'gml:id="CadastralParcel.IT.AGE.PLA.H501A048700.2"')],
        ['local ID disagreement', ROME.replace('<CP:INSPIREID_LOCALID>IT.AGE.PLA.H501A048700.1<', '<CP:INSPIREID_LOCALID>IT.AGE.PLA.H501A048700.9<')],
        ['label disagreement', ROME.replace('<CP:LABEL>1<', '<CP:LABEL>7<')],
        ['administrative unit disagreement', ROME.replace('<CP:ADMINISTRATIVEUNIT>H501</CP:ADMINISTRATIVEUNIT>', '<CP:ADMINISTRATIVEUNIT>F205</CP:ADMINISTRATIVEUNIT>')],
        ['INSPIRE namespace change', ROME.replace('<CP:INSPIREID_NAMESPACE>IT.AGE.PLA.<', '<CP:INSPIREID_NAMESPACE>IT.AGE.XX.<')],
        ['malformed national reference', ROME.replaceAll('H501A048700.1', 'H501A0487.1')],
        ['missing identity field', ROME.replace(/<CP:LABEL>1<\/CP:LABEL>/, '')],
        ['repeated identity field', ROME.replace('<CP:LABEL>1</CP:LABEL>', '<CP:LABEL>1</CP:LABEL><CP:LABEL>1</CP:LABEL>')],
        ['unexpected field', ROME.replace('<CP:LABEL>1</CP:LABEL>', '<CP:LABEL>1</CP:LABEL><CP:OWNER>x</CP:OWNER>')],
        ['nested identity markup', ROME.replace('<CP:LABEL>1</CP:LABEL>', '<CP:LABEL><b>1</b></CP:LABEL>')],
        // Every pair of the first ring swapped: still closed, so only the national envelope can catch it.
        ['swapped axis order', ROME.replace(/(<gml:posList srsDimension="2">)([^<]+)/, (_m, open, list) =>
            open + list.trim().split(/\s+/).map((_v, i, all) => all[i % 2 ? i - 1 : i + 1]).join(' '))],
        ['unclosed ring', ROME.replace('41.89921607 12.48302624 41.89913480 12.48304918 </gml:posList>', '41.89921607 12.48302624 </gml:posList>')],
        ['odd coordinate count', ROME.replace('41.89913480 12.48304918 41.89914563', '41.89913480 12.48304918 41.89914563 1')],
        ['different CRS', ROME.replace('srsName="urn:ogc:def:crs:EPSG::6706">\n            <gml:exterior>', 'srsName="urn:ogc:def:crs:EPSG::4326">\n            <gml:exterior>')],
        ['3D coordinates', ROME.replace('<gml:posList srsDimension="2">41.89913480', '<gml:posList srsDimension="3">41.89913480')],
        ['referenced geometry', ROME.replace('<CP:msGeometry>', '<CP:msGeometry xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="#elsewhere">')],
        ['repeated exterior', ROME.replace('</gml:exterior>', '</gml:exterior><gml:exterior><gml:LinearRing><gml:posList>41.1 12.1 41.2 12.1 41.2 12.2 41.1 12.1</gml:posList></gml:LinearRing></gml:exterior>')],
        ['repeated member', ROME.replace('</wfs:FeatureCollection>', `${members(ROME)[0]}</wfs:FeatureCollection>`).replace('numberReturned="3"', 'numberReturned="4"')],
        ['numberReturned above members', ROME.replace('numberReturned="3"', 'numberReturned="4"')],
        ['numberReturned below members', ROME.replace('numberReturned="3"', 'numberReturned="2"')],
        ['WFS truncation marker', ROME.replace('</wfs:FeatureCollection>', '<wfs:truncatedResponse/></wfs:FeatureCollection>')],
        ['cut-off document', ROME.slice(0, ROME.lastIndexOf('</wfs:member>'))],
        ['document type', ROME.replace('<wfs:FeatureCollection', '<!DOCTYPE x [<!ENTITY e SYSTEM "https://example.org/e">]><wfs:FeatureCollection')],
        ['service exception', '<?xml version="1.0"?><ows:ExceptionReport xmlns:ows="http://www.opengis.net/ows/1.1" version="2.0.0"><ows:Exception exceptionCode="NoApplicableCode"><ows:ExceptionText>busy</ows:ExceptionText></ows:Exception></ows:ExceptionReport>']
    ])('rejects %s', (_label, xml) => {
        expect(() => parseAgenziaEntrateCollection(xml)).toThrow(expect.objectContaining(unavailable));
    });
});

describe('Agenzia delle Entrate WFS adapter', () => {
    it('reads a bbox as hits plus one counted page in EPSG:6706 lat,lon order, paced one request per second', async () => {
        const { source, url, waits, starts } = harness(hits(3), ROME);
        const result = await source.queryBounds(ROME_BOUNDS);
        expect(result).toMatchObject({ type: 'FeatureCollection', complete: true, returnsWGS84: true, sourceId: descriptor.id, numberMatched: 3 });
        expect(result.features.map(f => f.id)).toEqual(['IT-AE-H501A048700.1', 'IT-AE-H501A048600.100', 'IT-AE-H501A048600.101']);
        expect(result.features[0].properties).toMatchObject({ sourceParcelId: 'H501A048700.1', parcelNumber: '1',
            sourceProperties: { NATIONALCADASTRALREFERENCE: 'H501A048700.1', ADMINISTRATIVEUNIT: 'H501', LABEL: '1' } });
        const [count, page] = [url(0), url(1)];
        expect(count.origin + count.pathname).toBe(descriptor.endpoint);
        expect(count.searchParams.get('resultType')).toBe('hits');
        expect(count.searchParams.get('bbox')).toBe('41.8985,12.482,41.8995,12.4835,urn:ogc:def:crs:EPSG::6706');
        expect(count.searchParams.get('srsName')).toBe('urn:ogc:def:crs:EPSG::6706');
        expect(page.searchParams.get('count')).toBe('4');
        expect(page.searchParams.has('resultType')).toBe(false);
        expect(page.searchParams.get('bbox')).toBe(count.searchParams.get('bbox'));
        expect(waits).toEqual([1000]);
        expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(1000);
    });

    it('rejects a recorded count=3 page when the hit count says the area holds more (truncation)', async () => {
        await expect(harness(hits(10), ROME).source.queryBounds(ROME_BOUNDS)).rejects.toMatchObject(unavailable);
    });

    it('rejects a page that grew past the counted set, a numeric data count that disagrees, and an unknown hit count', async () => {
        await expect(harness(hits(2), ROME).source.queryBounds(ROME_BOUNDS)).rejects.toMatchObject(unavailable);
        await expect(harness(hits(3), ROME.replace('numberMatched="unknown"', 'numberMatched="5"')).source.queryBounds(ROME_BOUNDS)).rejects.toMatchObject(unavailable);
        // An unknown count (or a data page where the count was asked for) stops before any data request.
        for (const first of [hits('unknown'), ROME]) {
            const run = harness(first, ROME);
            await expect(run.source.queryBounds(ROME_BOUNDS)).rejects.toMatchObject(unavailable);
            expect(run.fetchImpl).toHaveBeenCalledTimes(1);
        }
    });

    it('refuses areas over the parcel limit before requesting data, and oversized boxes before any request', async () => {
        const over = harness(hits(2001));
        await expect(over.source.queryBounds(ROME_BOUNDS)).rejects.toMatchObject(unavailable);
        expect(over.fetchImpl).toHaveBeenCalledTimes(1);
        const big = harness();
        await expect(big.source.queryBounds([12.40, 41.85, 12.50, 41.95])).rejects.toMatchObject({ status: 400 });
        expect(big.fetchImpl).not.toHaveBeenCalled();
    });

    it('reads exact IDs on a fresh adapter with identical geometry and no absences', async () => {
        const bounds = await harness(hits(3), ROME).source.queryBounds(ROME_BOUNDS);
        const refs = ['H501A048700.1', 'H501A048600.101'];
        const { source, url } = harness(hits(2), only(ROME, refs));
        const exact = await source.queryIds(refs.map(ref => `IT-AE-${ref}`));
        expect(exact).toMatchObject({ complete: true, returnsWGS84: true, absentIds: [] });
        for (const feature of exact.features) {
            expect(feature.geometry).toEqual(bounds.features.find(f => f.id === feature.id).geometry);
        }
        const filter = url(1).searchParams.get('filter');
        expect(url(0).searchParams.get('resultType')).toBe('hits');
        expect(url(0).searchParams.get('filter')).toBe(filter);
        expect(url(1).searchParams.get('count')).toBe('3');
        expect(url(1).searchParams.has('bbox')).toBe(false);
        expect(filter).toContain('<fes:ValueReference>CP:NATIONALCADASTRALREFERENCE</fes:ValueReference><fes:Literal>H501A048700.1</fes:Literal>');
        expect(filter).toContain('<fes:Or>');
    });

    it('reports absence only from a zero hit count confirmed by an empty counted page', async () => {
        const empty = hits(0);
        const result = await harness(hits(1), only(ROME, ['H501A048700.1'])).source.queryIds(['IT-AE-H501A048700.1']);
        expect(result.absentIds).toEqual([]);
        const missing = await harness(empty, empty).source.queryIds(['IT-AE-H501A048700.99']);
        expect(missing).toMatchObject({ complete: true, features: [], absentIds: ['IT-AE-H501A048700.99'] });
        const partial = await harness(hits(1), only(ROME, ['H501A048700.1'])).source.queryIds(['IT-AE-H501A048700.1', 'IT-AE-H501A048700.99']);
        expect(partial.absentIds).toEqual(['IT-AE-H501A048700.99']);
    });

    it.each([
        ['an exception instead of the empty page', [hits(0), '<?xml version="1.0"?><ows:ExceptionReport xmlns:ows="http://www.opengis.net/ows/1.1"><ows:Exception exceptionCode="NoApplicableCode"/></ows:ExceptionReport>']],
        ['an exception instead of the hit count', ['<?xml version="1.0"?><ows:ExceptionReport xmlns:ows="http://www.opengis.net/ows/1.1"><ows:Exception exceptionCode="InvalidParameterValue"/></ows:ExceptionReport>']],
        ['a different native parcel', [hits(1), only(ROME, ['H501A048600.100'])]],
        ['a requested parcel repeated', [hits(2), only(ROME, ['H501A048700.1']).replace('</wfs:FeatureCollection>', `${members(only(ROME, ['H501A048700.1']))[0]}</wfs:FeatureCollection>`).replace('numberReturned="1"', 'numberReturned="2"')]],
        ['an HTML 200 page', [new Response('<html>Access Denied</html>', { headers: { 'content-type': 'text/html' } })]]
    ])('keeps exact reads unavailable on %s', async (_label, bodies) => {
        await expect(harness(...bodies).source.queryIds(['IT-AE-H501A048700.1'])).rejects.toMatchObject(unavailable);
    });

    it.each([['IT-AE-h501a048700.1'], ['IT-AE-H501A048700.1</fes:Literal>'], ['ES-DGC-H501A048700.1'], ['IT-AE-H501A048700'], [42]])('rejects invalid ID %s before any request', async id => {
        const { source, fetchImpl } = harness();
        await expect(source.queryIds([id])).rejects.toMatchObject({ status: 400 });
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it.each([403, 429])('maps HTTP %i to blocked/rate-limited without retrying', async status => {
        const { source, fetchImpl } = harness(new Response('<HTML><TITLE>Access Denied</TITLE></HTML>', { status, headers: { 'content-type': 'text/html', 'retry-after': '30' } }));
        await expect(source.queryBounds(ROME_BOUNDS)).rejects.toMatchObject({ upstreamStatus: status,
            code: status === 403 ? 'parcel-source-blocked' : 'parcel-source-rate-limited' });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('rejects declared or streamed bodies over the byte limit', async () => {
        const small = { ...descriptor, maxResponseBytes: 1024 };
        const declared = createAgenziaEntrateWfsParcelSource(small, { fetchImpl: async () => response(ROME, { headers: { 'content-length': String(ROME.length) } }), waitImpl: async () => {} });
        await expect(declared.queryBounds(ROME_BOUNDS)).rejects.toMatchObject(unavailable);
        const streamed = createAgenziaEntrateWfsParcelSource(small, { fetchImpl: async () => response(ROME), waitImpl: async () => {} });
        await expect(streamed.queryBounds(ROME_BOUNDS)).rejects.toMatchObject(unavailable);
    });

    it('keeps request starts one pace apart for concurrent callers', async () => {
        const { source, starts } = harness(hits(3), hits(3), ROME, ROME);
        await Promise.all([source.queryBounds(ROME_BOUNDS), source.queryBounds(ROME_BOUNDS)]);
        expect(starts.length).toBe(4);
        for (let i = 1; i < starts.length; i++) expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(1000);
    });

    it.each([
        { endpoint: 'http://wfs.cartografia.agenziaentrate.gov.it/inspire/wfs/owfs01.php' },
        { outFields: ['NATIONALCADASTRALREFERENCE', 'ADMINISTRATIVEUNIT', 'LABEL', 'INSPIREID_LOCALID'] },
        { idPrefix: 'IT-' }, { paceMs: 200 }, { maxBboxKm2: 5 }, { responseCrs: 'EPSG:4326' }, { adapter: 'gml-wfs' }
    ])('rejects descriptor override %o', override => {
        expect(() => createAgenziaEntrateWfsParcelSource({ ...descriptor, ...override })).toThrow('Invalid Agenzia delle Entrate WFS descriptor.');
    });
});
