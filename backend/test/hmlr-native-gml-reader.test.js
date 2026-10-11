// Native HMLR streaming preserves metric geometry while excluding unrelated property attributes.
import { describe, it, expect } from 'vitest';
import { parseGmlParcels } from '../parcels/gml-parcel-reader.js';

const LR = 'www.landregistry.gov.uk';
const GML = 'http://www.opengis.net/gml/3.2';
const ring = '530800 180200 530810 180200 530810 180210 530800 180210 530800 180200';

function feature(id = '001', coordinates = ring) {
    return `<wfs:member><lr:PREDEFINED g:id="transport-row"><lr:INSPIREID>${id}</lr:INSPIREID><lr:OWNER>private data excluded</lr:OWNER><lr:GEOMETRY><g:MultiSurface srsName="urn:ogc:def:crs:EPSG::27700" srsDimension="2"><g:surfaceMember><g:Polygon><g:exterior><g:LinearRing><g:posList>${coordinates}</g:posList></g:LinearRing></g:exterior></g:Polygon></g:surfaceMember></g:MultiSurface></lr:GEOMETRY></lr:PREDEFINED></wfs:member>`;
}

function xml(members = feature(), attrs = 'numberMatched="1" numberReturned="1"') {
    return `<wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0" xmlns:lr="${LR}" xmlns:g="${GML}" ${attrs}>${members}</wfs:FeatureCollection>`;
}

describe('HMLR native-coordinate streaming GML reader', () => {
    it('streams safe features with exact EPSG:27700 coordinates and no retained feature index', async () => {
        const emitted = [];
        const result = await parseGmlParcels(xml(), {
            coordinateMode: 'native',
            onFeature: item => emitted.push(item)
        });

        expect(emitted).toHaveLength(1);
        expect(emitted[0]).toEqual({
            type: 'Feature', id: '001', properties: { INSPIREID: '001' },
            geometry: { type: 'Polygon', coordinates: [[
                [530800, 180200], [530810, 180200], [530810, 180210],
                [530800, 180210], [530800, 180200]
            ]] },
            bbox: [530800, 180200, 530810, 180210]
        });
        expect(result).toMatchObject({
            features: [], featureCount: 1, uniqueFeatureCount: null,
            duplicateNativeCount: null, numberMatched: 1, numberReturned: 1,
            sourceCrs: 'EPSG:27700', extent: [530800, 180200, 530810, 180210]
        });
        expect(JSON.stringify(emitted[0])).not.toContain('private data');
    });

    it('keeps the default WGS84 result behavior when no streaming callback is supplied', async () => {
        const result = await parseGmlParcels(xml());
        expect(result.features).toHaveLength(1);
        expect(result).toMatchObject({ uniqueFeatureCount: 1, duplicateNativeCount: 0, sourceCrs: 'EPSG:27700' });
        expect(result.features[0].geometry.coordinates[0][0][0]).toBeCloseTo(-0.116, 2);
        expect(result.features[0].geometry.coordinates[0][0][1]).toBeCloseTo(51.506, 2);
    });

    it('can stream the default WGS84 mode without retaining parsed features', async () => {
        const emitted = [];
        const result = await parseGmlParcels(xml(), { onFeature: item => emitted.push(item) });
        expect(result.features).toEqual([]);
        expect(result.featureCount).toBe(1);
        expect(result.uniqueFeatureCount).toBeNull();
        expect(result.duplicateNativeCount).toBeNull();
        expect(emitted[0].geometry.coordinates[0][0][0]).toBeCloseTo(-0.116, 2);
    });

    it('reports a validated collection timeStamp as sourceTimestamp', async () => {
        const result = await parseGmlParcels(xml(feature(), 'timeStamp="2026-10-04T03:01:14.283Z" numberMatched="1" numberReturned="1"'), {
            coordinateMode: 'native', onFeature: () => {}
        });
        expect(result.sourceTimestamp).toBe('2026-10-04T03:01:14.283Z');
        await expect(parseGmlParcels(xml(feature(), 'timeStamp="2026-02-30T03:01:14Z" numberMatched="1" numberReturned="1"'), {
            coordinateMode: 'native', onFeature: () => {}
        })).rejects.toThrow(/collection timestamp/);
    });

    it('restricts native mode to HMLR PREDEFINED/INSPIREID in EPSG:27700', async () => {
        await expect(parseGmlParcels(xml().replace('27700', '25830'), { coordinateMode: 'native' }))
            .rejects.toThrow(/Native HMLR coordinates require EPSG:27700/);
        const cp = xml().replaceAll('lr:', 'cp:').replace('xmlns:lr=', 'xmlns:cp=')
            .replaceAll('PREDEFINED', 'CadastralParcel').replaceAll('INSPIREID', 'nationalCadastralReference')
            .replaceAll('GEOMETRY', 'geometry');
        await expect(parseGmlParcels(cp, { coordinateMode: 'native' })).rejects.toThrow();
        await expect(parseGmlParcels(xml(), { coordinateMode: 'native', idField: 'nationalCadastralReference' }))
            .rejects.toThrow(/options/);
        await expect(parseGmlParcels(xml(), { coordinateMode: 'native', featureNamespace: LR }))
            .rejects.toThrow(/options/);
        await expect(parseGmlParcels(xml(), { coordinateMode: 'bogus' })).rejects.toThrow(/options/);
    });

    it('requires a synchronous callback', async () => {
        await expect(parseGmlParcels(xml(), {
            coordinateMode: 'native', onFeature: () => Promise.resolve()
        })).rejects.toThrow(/callback must be synchronous/);
        await expect(parseGmlParcels(xml(), { onFeature: true })).rejects.toThrow(/options/);
    });

    it('requires caller rollback when a terminal count check fails after callback emission', async () => {
        const staged = [];
        try {
            await parseGmlParcels(xml(feature(), 'numberMatched="1" numberReturned="2"'), {
                coordinateMode: 'native', onFeature: item => staged.push(item)
            });
        } catch {
            // The importer owns this transaction boundary; callbacks are intentionally
            // synchronous and may have staged valid rows before final document checks.
            staged.length = 0;
        }
        expect(staged).toEqual([]);
    });

    it('requires caller rollback when unsafe XML follows already emitted features', async () => {
        const staged = [];
        const unsafe = xml(feature()).replace('</wfs:FeatureCollection>', '<!DOCTYPE unsafe></wfs:FeatureCollection>');
        try {
            await parseGmlParcels(unsafe, { coordinateMode: 'native', onFeature: item => staged.push(item) });
        } catch {
            staged.length = 0;
        }
        expect(staged).toEqual([]);
    });
});
