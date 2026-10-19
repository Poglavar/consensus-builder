import { describe, it, expect, vi } from 'vitest';
import proj4 from 'proj4';
import { createGmlWfsParcelSource } from '../parcels/gml-wfs-source.js';
import { NORWAY_TEIG_GML_SCHEMA, parseGmlParcels } from '../parcels/gml-parcel-reader.js';

const ID = '291142538';
const descriptor = {
    adapter: 'gml-wfs', id: 'no-teig-gml-wfs',
    endpoint: 'https://wfs.geonorge.no/skwms1/wfs.matrikkelen-eiendomskart-teig',
    featureType: 'app:Teig', idField: 'teigId', geometryField: 'område', responseCrs: 'EPSG:25833',
    idPrefix: 'NO-TEIG-', idType: 'string', parcelNumberField: 'teigId', outFields: ['teigId'],
    pageSize: 2, maxFeatures: 20
};
const ring = '597000 6640000 597010 6640000 597010 6640010 597000 6640010 597000 6640000';
function member(id = ID, gmlId = `teig.${id}`) {
    return `<wfs:member><app:Teig g:id="${gmlId}"><app:område><g:Polygon srsName="urn:ogc:def:crs:EPSG::25833" srsDimension="2"><g:exterior><g:LinearRing><g:posList>${ring}</g:posList></g:LinearRing></g:exterior></g:Polygon></app:område><app:teigId>${id}</app:teigId></app:Teig></wfs:member>`;
}
function collection(features = '', matched = 0, returned = 0) {
    return `<wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0" xmlns:app="${NORWAY_TEIG_GML_SCHEMA.featureNamespace}" xmlns:g="http://www.opengis.net/gml/3.2" numberMatched="${matched}" numberReturned="${returned}">${features}</wfs:FeatureCollection>`;
}
function response(body) { return new Response(body, { headers: { 'content-type': 'application/gml+xml; version=3.2' } }); }
function hits(count) { return response(collection('', count, 0)); }

describe('Norway Teig WFS profile', () => {
    it('normalizes only the provider declared-zero quirk and retains its provenance', async () => {
        const parsed = await parseGmlParcels(collection(member(), 1, 0), { schema: { ...NORWAY_TEIG_GML_SCHEMA } });
        expect(parsed).toMatchObject({ featureCount: 1, numberMatched: 1, numberReturned: 1,
            declaredNumberReturned: 0, numberReturnedNormalized: true,
            numberReturnedProtocolException: 'kartverket-no-teig-zero-numberReturned-on-data-response' });
        expect(parsed.features[0].id).toBe(ID);
        await expect(parseGmlParcels(collection(member(), 1, 2), { schema: NORWAY_TEIG_GML_SCHEMA })).rejects.toThrow(/counts/);
        await expect(parseGmlParcels(collection(member(), 1, 0))).rejects.toThrow();
    });

    it('requires the gml:id to exactly bind the numeric native teigId', async () => {
        await expect(parseGmlParcels(collection(member(ID, 'teig.999')), { schema: NORWAY_TEIG_GML_SCHEMA })).rejects.toThrow(/does not match/);
        await expect(parseGmlParcels(collection(member(ID, 'missing')), { schema: NORWAY_TEIG_GML_SCHEMA })).rejects.toThrow(/does not match/);
        await expect(parseGmlParcels(collection(member(ID, '')), { schema: NORWAY_TEIG_GML_SCHEMA })).rejects.toThrow();
        await expect(parseGmlParcels(collection(member().replace(' g:id="teig.291142538"', '')), { schema: NORWAY_TEIG_GML_SCHEMA })).rejects.toThrow();
        await expect(parseGmlParcels(collection(member('29x')), { schema: NORWAY_TEIG_GML_SCHEMA })).rejects.toThrow(/identifier/);
        const curve = member().replaceAll('g:Polygon', 'g:Curve');
        await expect(parseGmlParcels(collection(curve), { schema: NORWAY_TEIG_GML_SCHEMA })).rejects.toThrow();
    });

    it('uses RESOURCEID for known and absent native IDs and checks stable complete counts', async () => {
        const requests = [];
        const fetchImpl = vi.fn(async url => {
            const parsed = new URL(url); requests.push(parsed);
            if (parsed.searchParams.get('resultType') === 'hits') return hits(1);
            return response(collection(member(), 1, 0));
        });
        const source = createGmlWfsParcelSource(descriptor, { fetchImpl });
        const result = await source.queryIds([`NO-TEIG-${ID}`, 'NO-TEIG-999999999']);
        expect(result).toMatchObject({ complete: true, numberMatched: 1, absentIds: ['NO-TEIG-999999999'] });
        expect(result.features.map(feature => feature.properties.sourceParcelId)).toEqual([ID]);
        expect(fetchImpl).toHaveBeenCalledTimes(3);
        expect(requests.every(url => url.searchParams.get('filter') === null)).toBe(true);
        expect(requests.every(url => url.searchParams.get('RESOURCEID') === `teig.${ID},teig.999999999`)).toBe(true);
        expect(requests[1].searchParams.get('count')).toBe('1');
        expect(requests[1].searchParams.get('startIndex')).toBe('0');
        await expect(source.queryIds(['NO-TEIG-0291142538'])).rejects.toMatchObject({ status: 400 });
    });

    it('does not call a missing or unstable hits count an explicit absence', async () => {
        const fetchImpl = vi.fn(async () => response('<ows:ExceptionReport xmlns:ows="http://www.opengis.net/ows/1.1"/>'));
        await expect(createGmlWfsParcelSource(descriptor, { fetchImpl }).queryIds([`NO-TEIG-${ID}`])).rejects.toThrow();
        const counts = [1, 0];
        const unstable = vi.fn(async url => new URL(url).searchParams.get('resultType') === 'hits'
            ? hits(counts.shift()) : response(collection(member(), 1, 0)));
        await expect(createGmlWfsParcelSource(descriptor, { fetchImpl: unstable }).queryIds([`NO-TEIG-${ID}`])).rejects.toThrow(/changed/);
    });

    it('uses one unchanged Intersects predicate for the pre-count, data page, and post-count', async () => {
        const center = proj4('EPSG:25833', 'EPSG:4326').forward([597005, 6640005]);
        const bounds = [center[0] - 0.0001, center[1] - 0.0001, center[0] + 0.0001, center[1] + 0.0001];
        const requests = [];
        const fetchImpl = vi.fn(async url => {
            const parsed = new URL(url); requests.push(parsed);
            if (parsed.searchParams.get('resultType') === 'hits') return hits(1);
            return response(collection(member(), 1, 0));
        });
        const result = await createGmlWfsParcelSource(descriptor, { fetchImpl }).queryBounds(bounds);
        expect(result.complete).toBe(true);
        expect(result.features).toHaveLength(1);
        expect(fetchImpl).toHaveBeenCalledTimes(3);
        expect(requests.every(url => url.searchParams.get('RESOURCEID') === null)).toBe(true);
        const filters = requests.map(url => url.searchParams.get('filter'));
        expect(new Set(filters).size).toBe(1);
        expect(filters[0]).toContain('<fes:Intersects>');
        expect(filters[0]).toContain('<fes:ValueReference>app:område</fes:ValueReference>');
        expect(requests[1].searchParams.get('count')).toBe('1');
        expect(requests[1].searchParams.get('startIndex')).toBe('0');
    });
});
