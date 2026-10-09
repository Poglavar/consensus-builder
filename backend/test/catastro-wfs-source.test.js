import { describe, expect, it, vi } from 'vitest';
import { createCatastroWfsParcelSource } from '../parcels/catastro-wfs-source.js';

const descriptor = {
    id: 'es-test', endpoint: 'https://ovc.catastro.meh.es/INSPIRE/wfsCP.aspx',
    idField: 'nationalCadastralReference', idPrefix: 'ES-DGC-',
    outFields: ['nationalCadastralReference'], maxBboxKm2: 1, maxFeatures: 5000
};
const native = '0245708VK4704C';
const bounds = [-3.704, 40.416, -3.703, 40.417];
const missing = key => `<?xml version='1.0' encoding="ISO-8859-1" standalone="no"?><ExceptionReport xmlns="http://www.opengis.net/ows/1.1" version="2.0.0"><Exception exceptionCode="OperationProcessingFailed"><ExceptionText><![CDATA[No se ha encontrado la parcela ${key} para el huso 25830]]></ExceptionText></Exception></ExceptionReport>`;
function gml({ key = native, matched = 1, returned = 1, zone = 30 } = {}) {
    const member = `<w:member><cp:CadastralParcel><cp:nationalCadastralReference>${key}</cp:nationalCadastralReference><cp:owner>discard</cp:owner><cp:geometry><g:MultiSurface srsName="urn:ogc:def:crs:EPSG::258${zone}"><g:surfaceMember><g:Polygon><g:exterior><g:LinearRing><g:posList>440000 4474000 440010 4474000 440010 4474010 440000 4474010 440000 4474000</g:posList></g:LinearRing></g:exterior></g:Polygon></g:surfaceMember></g:MultiSurface></cp:geometry></cp:CadastralParcel></w:member>`;
    return `<w:FeatureCollection xmlns:w="http://www.opengis.net/wfs/2.0" xmlns:cp="http://inspire.ec.europa.eu/schemas/cp/4.0" xmlns:g="http://www.opengis.net/gml/3.2" numberMatched="${matched}" numberReturned="${returned}">${returned ? member : ''}</w:FeatureCollection>`;
}
describe('Spanish cadastral GML WFS', () => {
    it('uses unpaged projected windows and exact native stored queries with no ownership data', async () => {
        const fetchImpl = vi.fn(async () => new Response(gml()));
        const source = createCatastroWfsParcelSource(descriptor, { fetchImpl });
        const result = await source.queryBounds(bounds);
        const exact = await source.queryIds([result.features[0].id]);
        expect(fetchImpl).toHaveBeenCalledOnce();
        await createCatastroWfsParcelSource(descriptor, { fetchImpl }).queryIds([result.features[0].id]);
        expect(result.complete).toBe(true);
        expect(exact.features[0].geometry).toEqual(result.features[0].geometry);
        expect(exact.absentIds).toEqual([]);
        expect(result.features[0].properties.sourceProperties).toEqual({ nationalCadastralReference: native });
        const viewport = new URL(fetchImpl.mock.calls[0][0]), lookup = new URL(fetchImpl.mock.calls[1][0]);
        expect(viewport.searchParams.get('srsName')).toBe('EPSG::25830');
        expect(viewport.searchParams.get('bbox').split(',').map(Number)[0]).toBeGreaterThan(400000);
        for (const key of ['count', 'startIndex', 'resultType']) expect(viewport.searchParams.has(key)).toBe(false);
        expect(lookup.searchParams.get('STOREDQUERY_ID')).toBe('GetParcel');
        expect(lookup.searchParams.get('REFCAT')).toBe(native);
        expect(lookup.searchParams.get('SRSNAME')).toBe('EPSG::25830');
    });
    it('selects UTM31 for Barcelona viewport reads', async () => {
        const fetchImpl = vi.fn(async () => new Response(gml({ zone: 31 })));
        await createCatastroWfsParcelSource(descriptor, { fetchImpl }).queryBounds([2.167, 41.386, 2.168, 41.387]);
        expect(new URL(fetchImpl.mock.calls[0][0]).searchParams.get('srsName')).toBe('EPSG::25831');
    });
    it.each([gml({ matched: 2 }), gml({ returned: 2 }), gml({ key: 'transport-row' }), '<ows:ExceptionReport xmlns:ows="http://www.opengis.net/ows/1.1"><ows:Exception exceptionCode="OperationProcessingFailed">No se ha encontrado</ows:Exception></ows:ExceptionReport>'])('rejects truncated, inconsistent, invalid-ID and HTTP200 exception collections', async body => {
        await expect(createCatastroWfsParcelSource(descriptor, { fetchImpl: async () => new Response(body) }).queryBounds(bounds)).rejects.toMatchObject({ code: 'parcel-source-unavailable' });
    });
    it('reports absence only from an explicit complete empty collection', async () => {
        const result = await createCatastroWfsParcelSource(descriptor, { fetchImpl: async () => new Response(gml({ matched: 0, returned: 0 })) }).queryIds(['ES-DGC-' + native]);
        expect(result).toMatchObject({ complete: true, features: [], absentIds: ['ES-DGC-' + native] });
    });
    it('recognizes the official exact-reference missing message and does not cache absence', async () => {
        const fetchImpl = vi.fn(async () => new Response(missing(native)));
        const source = createCatastroWfsParcelSource(descriptor, { fetchImpl });
        for (let i = 0; i < 2; i++) {
            expect(await source.queryIds(['ES-DGC-' + native])).toMatchObject({
                complete: true, features: [], absentIds: ['ES-DGC-' + native]
            });
        }
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        await expect(source.queryBounds(bounds)).rejects.toMatchObject({ code: 'parcel-source-unavailable' });
    });
    it.each([
        missing('0521307DF3802B'),
        missing(native).replace('25830]]', '25831]]'),
        missing(native).replace('OperationProcessingFailed', 'NoApplicableCode'),
        missing(native).replaceAll('http://www.opengis.net/ows/1.1', 'https://example.org/ows'),
        missing(native).replace('</ExceptionReport>', '<Exception exceptionCode="OperationProcessingFailed"><ExceptionText>Upstream failed</ExceptionText></Exception></ExceptionReport>'),
        missing(native).replace(']]></ExceptionText>', ']]><other/></ExceptionText>'),
        missing(native).replace('</ExceptionReport>', ''),
        missing(native).replace('<ExceptionReport', '<!DOCTYPE ExceptionReport [<!ENTITY external SYSTEM "https://example.org/entity">]><ExceptionReport'),
        missing(native).replace(`No se ha encontrado la parcela ${native} para el huso 25830`, 'Service temporarily unavailable'),
        '<html><body>No se ha encontrado la parcela ' + native + ' para el huso 25830</body></html>'
    ])('keeps mismatched, ambiguous and malformed absence replies unavailable', async body => {
        await expect(createCatastroWfsParcelSource(descriptor, { fetchImpl: async () => new Response(body) })
            .queryIds(['ES-DGC-' + native])).rejects.toMatchObject({ code: 'parcel-source-unavailable' });
    });
    it('rejects exact replies for a different native reference', async () => {
        await expect(createCatastroWfsParcelSource(descriptor, { fetchImpl: async () => new Response(gml({ key: '0521307DF3802B' })) }).queryIds(['ES-DGC-' + native])).rejects.toMatchObject({ code: 'parcel-source-unavailable' });
    });
    it.each([403, 429])('preserves HTTP%i and retry metadata', async status => {
        await expect(createCatastroWfsParcelSource(descriptor, { fetchImpl: async () => new Response('', { status, headers: { 'Retry-After': '42' } }) }).queryBounds(bounds)).rejects.toMatchObject({ upstreamStatus: status,
            code: status === 403 ? 'parcel-source-blocked' : 'parcel-source-rate-limited' });
    });
    it('validates IDs and oversized windows before I/O', async () => {
        const fetchImpl = vi.fn(), source = createCatastroWfsParcelSource(descriptor, { fetchImpl });
        await expect(source.queryIds(['OTHER-' + native])).rejects.toMatchObject({ status: 400 });
        await expect(source.queryBounds([-4, 40, -3, 41])).rejects.toMatchObject({ status: 400 });
        expect(fetchImpl).not.toHaveBeenCalled();
    });
    it('expires positive viewport reads and never claims absence after a failed refresh', async () => {
        let now = 1;
        const fetchImpl = vi.fn().mockResolvedValueOnce(new Response(gml())).mockResolvedValueOnce(new Response('', { status: 403 }));
        const source = createCatastroWfsParcelSource(descriptor, { fetchImpl, now: () => now });
        const viewport = await source.queryBounds(bounds);
        viewport.features[0].geometry.coordinates[0][0][0] = 0;
        expect((await source.queryIds(['ES-DGC-' + native])).features[0].geometry.coordinates[0][0][0]).not.toBe(0);
        now += 60000;
        await expect(source.queryIds(['ES-DGC-' + native])).rejects.toMatchObject({ code: 'parcel-source-blocked' });
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });
    it('filters bounding-box candidates against the proposal polygon', async () => {
        const source = createCatastroWfsParcelSource(descriptor, { fetchImpl: async () => new Response(gml()) });
        const sample = (await source.queryBounds(bounds)).features[0];
        const result = await source.queryGeometry(sample.geometry);
        expect(result.complete).toBe(true);
        expect(result.features.map(f => f.id)).toEqual([sample.id]);
    });
});
