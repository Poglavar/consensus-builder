import { describe, it, expect, vi } from 'vitest';
import proj4 from 'proj4';
import { createGmlWfsParcelSource } from '../parcels/gml-wfs-source.js';
import { FINLAND_CP_GML_SCHEMA, parseGmlParcels } from '../parcels/gml-parcel-reader.js';

const ID = '158297269';
const PREFIX = 'http://paikkatiedot.fi/so/1001077/cp/CadastralParcel/';
const NS = 'http://paikkatiedot.fi/so/1001077/cp/CadastralParcel/';
const BASE = 'http://inspire.ec.europa.eu/schemas/base/3.3';
const CP = FINLAND_CP_GML_SCHEMA.featureNamespace;
const GML = FINLAND_CP_GML_SCHEMA.gmlNamespace;
const descriptor = {
    adapter: 'gml-wfs', id: 'fi-inspire-cp-wfs',
    endpoint: 'https://inspire-wfs.maanmittauslaitos.fi/inspire-wfs/cp/wfs',
    featureType: 'cp:CadastralParcel', idField: 'localId', geometryField: 'geometry', responseCrs: 'EPSG:3067',
    idPrefix: PREFIX, idType: 'string', parcelNumberField: 'localId', outFields: ['localId'],
    pageSize: 2, maxFeatures: 100, maxBboxKm2: 0.2
};
const ring = '385349.096 6672293.508 385359.096 6672293.508 385359.096 6672303.508 385349.096 6672303.508 385349.096 6672293.508';
function member(id = ID, { gmlId = `FI_CP_CADASTRALPARCEL_${id}`, publicId = `${NS}${id}`, namespace = NS, codeSpace = 'http://paikkatiedot.fi', geometry = `<g:Polygon srsName="EPSG:3067" srsDimension="2"><g:exterior><g:LinearRing><g:posList>${ring}</g:posList></g:LinearRing></g:exterior></g:Polygon>`, other = '' } = {}) {
    return `<wfs:member><cp:CadastralParcel g:id="${gmlId}"><g:identifier codeSpace="${codeSpace}">${publicId}</g:identifier><cp:inspireId><b:Identifier><b:localId>${id}</b:localId><b:namespace>${namespace}</b:namespace></b:Identifier></cp:inspireId>${other}<cp:nationalCadastralReference>09143200010026</cp:nationalCadastralReference><cp:geometry>${geometry}</cp:geometry></cp:CadastralParcel></wfs:member>`;
}
function collection(features = '', matched = 0, returned = 0) {
    return `<wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0" xmlns:cp="${CP}" xmlns:b="${BASE}" xmlns:g="${GML}" numberMatched="${matched}" numberReturned="${returned}">${features}</wfs:FeatureCollection>`;
}
function response(body) { return new Response(body, { headers: { 'content-type': 'application/gml+xml; version=3.2' } }); }
function hits(count) { return response(collection('', count, 0)); }

describe('Finland INSPIRE CadastralParcel WFS profile', () => {
    it('binds all observed identity forms and transforms TM35FIN easting/northing coordinates', async () => {
        const parsed = await parseGmlParcels(collection(member(), 1, 1), { schema: FINLAND_CP_GML_SCHEMA });
        expect(parsed).toMatchObject({ featureCount: 1, numberMatched: 1, numberReturned: 1, sourceCrs: 'EPSG:3067' });
        expect(parsed.features[0].id).toBe(ID);
        expect(parsed.features[0].properties).toEqual({ localId: ID });
        const [lon, lat] = parsed.features[0].geometry.coordinates[0][0];
        expect(lon).toBeCloseTo(24.933579, 4);
        expect(lat).toBeCloseTo(60.171398, 4);
    });

    it('rejects any disagreement among gml:id, gml:identifier, localId, namespace, and codeSpace', async () => {
        const variants = [
            member(ID, { gmlId: 'FI_CP_CADASTRALPARCEL_999' }),
            member(ID, { publicId: `${NS}999` }),
            member(ID, { namespace: `${NS}wrong/` }),
            member(ID, { codeSpace: 'http://example.invalid' }),
            member('00158297269')
        ];
        for (const xml of variants) await expect(parseGmlParcels(collection(xml, 1, 1), { schema: FINLAND_CP_GML_SCHEMA })).rejects.toThrow();
    });

    it('rejects missing, duplicate, and path-confused INSPIRE identifiers', async () => {
        const noInspireId = member().replace(/<cp:inspireId>[\s\S]*?<\/cp:inspireId>/, '');
        const duplicate = member().replace('</b:Identifier>', '<b:localId>158297269</b:localId></b:Identifier>');
        const outsidePath = member().replace('<cp:inspireId>', '<cp:other><b:Identifier><b:localId>158297269</b:localId></b:Identifier></cp:other><cp:inspireId>');
        for (const xml of [noInspireId, duplicate, outsidePath]) {
            await expect(parseGmlParcels(collection(xml, 1, 1), { schema: FINLAND_CP_GML_SCHEMA })).rejects.toThrow();
        }
    });

    it('fails closed on non-polygon geometry encodings', async () => {
        for (const geometry of ['<g:Point srsName="EPSG:3067"><g:pos>385349 6672293</g:pos></g:Point>', '<g:Curve/>', '<g:Ring/>']) {
            await expect(parseGmlParcels(collection(member(ID, { geometry }), 1, 1), { schema: FINLAND_CP_GML_SCHEMA })).rejects.toThrow();
        }
    });

    it('uses WFS RESOURCEID for exact known and synthetic IDs and omits unsupported property projection', async () => {
        const requests = [];
        const fetchImpl = vi.fn(async url => {
            const parsed = new URL(url); requests.push(parsed);
            if (parsed.searchParams.get('resultType') === 'hits') return hits(1);
            return response(collection(member(), 1, 1));
        });
        const result = await createGmlWfsParcelSource(descriptor, { fetchImpl }).queryIds([`${PREFIX}${ID}`, `${PREFIX}9999999999999999`]);
        expect(result).toMatchObject({ complete: true, numberMatched: 1, absentIds: [`${PREFIX}9999999999999999`] });
        expect(result.features[0]).toMatchObject({ id: `${PREFIX}${ID}`, properties: { sourceParcelId: ID, sourceProperties: { localId: ID } } });
        expect(requests).toHaveLength(3);
        expect(requests.every(url => url.searchParams.get('RESOURCEID') === `FI_CP_CADASTRALPARCEL_${ID},FI_CP_CADASTRALPARCEL_9999999999999999`)).toBe(true);
        expect(requests.every(url => url.searchParams.get('propertyName') === null && url.searchParams.get('filter') === null)).toBe(true);
        expect(requests[1].searchParams.get('count')).toBe('1');
        await expect(createGmlWfsParcelSource(descriptor).queryIds([`${PREFIX}00123`])).rejects.toMatchObject({ status: 400 });
    });

    it('does not infer absence from a missing or changing hits count', async () => {
        const unavailable = vi.fn(async () => response('<ows:ExceptionReport xmlns:ows="http://www.opengis.net/ows/1.1"/>'));
        await expect(createGmlWfsParcelSource(descriptor, { fetchImpl: unavailable }).queryIds([`${PREFIX}${ID}`])).rejects.toThrow();
        const counts = [1, 0];
        const changing = vi.fn(async url => new URL(url).searchParams.get('resultType') === 'hits'
            ? hits(counts.shift()) : response(collection(member(), 1, 1)));
        await expect(createGmlWfsParcelSource(descriptor, { fetchImpl: changing }).queryIds([`${PREFIX}${ID}`])).rejects.toThrow(/changed/);
    });

    it('uses a native EPSG:3067 BBOX KVP and exact stable hit/data/post counts across pages', async () => {
        const center = proj4('EPSG:3067', 'EPSG:4326').forward([385354, 6672298]);
        const bounds = [center[0] - 0.0004, center[1] - 0.0004, center[0] + 0.0004, center[1] + 0.0004];
        const ids = [ID, '158297273', '158297274'];
        const requests = [];
        const fetchImpl = vi.fn(async url => {
            const parsed = new URL(url); requests.push(parsed);
            if (parsed.searchParams.get('resultType') === 'hits') return hits(3);
            const start = Number(parsed.searchParams.get('startIndex'));
            const count = Number(parsed.searchParams.get('count'));
            const members = ids.slice(start, start + count).map(id => member(id)).join('');
            return response(collection(members, 3, count));
        });
        const result = await createGmlWfsParcelSource(descriptor, { fetchImpl }).queryBounds(bounds);
        expect(result).toMatchObject({ complete: true, numberMatched: 3 });
        expect(result.features).toHaveLength(3);
        expect(fetchImpl).toHaveBeenCalledTimes(4);
        expect(requests.every(url => url.searchParams.get('bbox')?.endsWith(',EPSG:3067'))).toBe(true);
        expect(requests.every(url => url.searchParams.get('filter') === null && url.searchParams.get('propertyName') === null)).toBe(true);
        expect(requests.map(url => url.searchParams.get('startIndex')).filter(value => value !== null)).toEqual(['0', '2']);
        expect(requests.map(url => url.searchParams.get('count')).filter(value => value !== null)).toEqual(['2', '1']);
    });

    it('discards unconfigured upstream properties from parser output', async () => {
        const xml = collection(member(ID, { other: '<cp:label>Ignored label</cp:label><cp:nationalCadastralReference>ignored</cp:nationalCadastralReference>' }), 1, 1);
        const parsed = await parseGmlParcels(xml, { schema: { ...FINLAND_CP_GML_SCHEMA } });
        expect(Object.keys(parsed.features[0].properties)).toEqual(['localId']);
    });
});
