import { describe, it, expect, vi } from 'vitest';
import { createWfsParcelSource } from '../parcels/wfs-source.js';

const GEOMETRY = { type:'Polygon', coordinates:[[[131.9,43.1],[131.901,43.1],[131.901,43.101],[131.9,43.101],[131.9,43.1]]] };
const nativeId = '25:01:0010101:123';
const descriptor = {
    adapter:'wfs', id:'ru-vladivostok-cadastral-test', endpoint:'https://cadastre.example.test/wfs',
    featureType:'v:КадастровыйУчасток', idField:'КН', geometryField:'Контур', idType:'string',
    idPattern:'^[0-9:]+$', idPrefix:'RU-VLAD-', outFields:['КН','Номер'], parcelNumberField:'Номер',
    requestProperties:true, attributeNotNull:['КН'], pageSize:10, maxFeatures:100, maxBboxKm2:25
};

function sourceFeature(extra = {}) {
    return { type:'Feature', id:'v:КадастровыйУчасток.1', properties:{ 'КН':nativeId, 'Номер':'123', 'Собственник':'private', ...extra }, geometry:GEOMETRY };
}

function response(feature) {
    return { ok:true, status:200, json:async () => ({ type:'FeatureCollection', features:[feature], numberMatched:1, numberReturned:1 }) };
}

function makeSource({ feature = sourceFeature(), override = {} } = {}) {
    const urls = [];
    const fetchImpl = vi.fn(async value => { urls.push(new URL(value)); return response(feature); });
    return { adapter:createWfsParcelSource({ ...descriptor, ...override }, { fetchImpl }), fetchImpl, urls };
}

describe('Unicode WFS cadastral identifiers', () => {
    it('uses legal Cyrillic QName and fields for bounds and exact IDs while retaining the configured projection', async () => {
        const { adapter, fetchImpl, urls } = makeSource();
        const bounds = await adapter.queryBounds([131.9,43.1,131.902,43.102]);
        const exact = await adapter.queryIds([`RU-VLAD-${nativeId}`]);

        expect(bounds.complete).toBe(true);
        expect(bounds.features[0].geometry).toEqual(GEOMETRY);
        expect(exact).toMatchObject({ complete:true, absentIds:[], features:[{ id:`RU-VLAD-${nativeId}` }] });
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(urls[0].searchParams.get('typeNames')).toBe('v:КадастровыйУчасток');
        expect(urls[0].searchParams.get('propertyName')).toBe('Контур,КН,Номер');
        expect(urls[0].searchParams.get('cql_filter')).toContain('BBOX(Контур,');
        expect(urls[1].searchParams.get('typeNames')).toBe('v:КадастровыйУчасток');
        expect(urls[1].searchParams.get('cql_filter')).toContain(`КН IN ('${nativeId}')`);
        expect(bounds.features[0].properties.sourceProperties).toEqual({ 'КН':nativeId, 'Номер':'123' });
        expect(exact.features[0].properties.sourceProperties).toEqual({ 'КН':nativeId, 'Номер':'123' });
        expect(JSON.stringify(bounds.features[0].properties)).not.toContain('Собственник');
    });

    it('rejects a foreign canonical prefix before making an exact-ID request', async () => {
        const { adapter, fetchImpl } = makeSource();
        await expect(adapter.queryIds([`OTHER-${nativeId}`])).rejects.toThrow(/different source/);
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it.each([
        { idField:"КН' OR '1'='1" },
        { idField:'КН-1' },
        { geometryField:'Контур) OR 1=1' },
        { featureType:"v:КадастровыйУчасток' OR '1'='1" },
        { featureType:'v:Кадастровый Участок' }
    ])('rejects non-XML punctuation/injection in Unicode identifiers: %j', override => {
        const fetchImpl = vi.fn();
        expect(() => createWfsParcelSource({ ...descriptor, ...override }, { fetchImpl }))
            .toThrow(/Invalid WFS parcel source descriptor/);
        expect(fetchImpl).not.toHaveBeenCalled();
    });
});
