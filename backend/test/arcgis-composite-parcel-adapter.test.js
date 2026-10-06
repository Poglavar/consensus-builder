// Composite ArcGIS parcel identities use the snapshot codec and stay independent of transport OIDs.
import { describe, expect, it, vi } from 'vitest';
import { area as turfArea, feature as turfFeature, intersect as turfIntersect } from '@turf/turf';
import { createArcgisParcelSource } from '../parcels/arcgis-source.js';

const descriptor = {
    adapter: 'arcgis', id: 'om-test', endpoint: 'https://example.test/arcgis/FeatureServer/0',
    idPrefix: 'OM-TEST-', objectIdField: 'OBJECTID', idFields: ['PLOTUID', 'NEWPLOTNO'],
    idFieldTypes: { PLOTUID: 'integer', NEWPLOTNO: 'string' },
    outFields: ['OBJECTID', 'PLOTUID', 'NEWPLOTNO', 'STATUS'], pageSize: 2, maxFeatures: 20
};

const polygon = (west, south, east, north) => ({ type: 'Polygon',
    coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]] });
const feature = (objectId, plotuid, newplotno, geometry = polygon(58.38, 23.59, 58.381, 23.591), status = "O'K") => ({
    type: 'Feature', id: objectId,
    properties: { OBJECTID: objectId, PLOTUID: plotuid, NEWPLOTNO: newplotno, STATUS: status }, geometry
});
const response = features => ({ ok: true, status: 200,
    json: async () => ({ type: 'FeatureCollection', features, exceededTransferLimit: false }) });
const jsonResponse = payload => ({ ok: true, status: 200, json: async () => payload });

function makeFetch(handler) {
    const calls = [];
    const fetchImpl = vi.fn(async url => {
        const parsed = new URL(url);
        calls.push(parsed);
        return handler(parsed.searchParams, parsed);
    });
    return { fetchImpl, calls };
}

describe('ArcGIS composite native parcel IDs', () => {
    it('encodes ordered native parts with the snapshot codec and keeps viewport IDs distinct', async () => {
        const { fetchImpl } = makeFetch(() => response([
            feature(1, 42, '00100'), feature(2, 42, '00101')
        ]));
        const source = createArcgisParcelSource(descriptor, { fetchImpl });
        const result = await source.queryBounds([58.379, 23.589, 58.382, 23.592]);

        expect(result.features.map(item => item.id)).toEqual(['OM-TEST-42~00100', 'OM-TEST-42~00101']);
        expect(result.features.map(item => item.properties.sourceParcelId)).toEqual(['42~00100', '42~00101']);
        expect(result.features[0].properties.sourceProperties).toEqual({ OBJECTID: 1, PLOTUID: 42, NEWPLOTNO: '00100', STATUS: "O'K" });

        const escaped = createArcgisParcelSource(descriptor, { fetchImpl: makeFetch(() => response([
            feature(3, 42, '00A~B')
        ])).fetchImpl });
        const encoded = await escaped.queryBounds([58.379, 23.589, 58.382, 23.592]);
        expect(encoded.features[0].id).toBe('OM-TEST-42~00A%7EB');
    });

    it('queries composite tuples as ORs of typed AND clauses with quoted strings and preserved zeroes', async () => {
        const { fetchImpl, calls } = makeFetch(() => response([]));
        const source = createArcgisParcelSource(descriptor, { fetchImpl });
        const ids = ['OM-TEST-42~00100', "OM-TEST-43~00'A"];
        const result = await source.queryIds(ids);

        expect(calls).toHaveLength(1);
        expect(calls[0].searchParams.get('where')).toBe("(PLOTUID = 42 AND NEWPLOTNO = '00100') OR (PLOTUID = 43 AND NEWPLOTNO = '00''A')");
        expect(result.absentIds).toEqual(ids);
        expect(result.complete).toBe(true);
    });

    it('uses percent-escaped canonical components when forming the tuple query', async () => {
        const { fetchImpl, calls } = makeFetch(() => response([]));
        await createArcgisParcelSource(descriptor, { fetchImpl }).queryIds(['OM-TEST-42~00A%7EB']);
        expect(calls[0].searchParams.get('where')).toBe("(PLOTUID = 42 AND NEWPLOTNO = '00A~B')");
    });

    it('rejects malformed, foreign, and noncanonical encodings before fetching', async () => {
        const { fetchImpl } = makeFetch(() => response([]));
        const source = createArcgisParcelSource(descriptor, { fetchImpl });
        for (const id of ['US-X-42~00100', 'OM-TEST-42~00100%', 'OM-TEST-42~00A%7eB',
            'OM-TEST-042~00100', 'OM-TEST-42~~00100', 'OM-TEST-42~%41']) {
            await expect(source.queryIds([id])).rejects.toThrow(/id/i);
        }
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('rejects invalid composite descriptors, including legacy scalar ID options', () => {
        const invalid = [
            { ...descriptor, idFields: ['PLOTUID'] },
            { ...descriptor, idFields: ['PLOTUID', 'PLOTUID'] },
            { ...descriptor, idFields: ['PLOTUID', 'MISSING'] },
            { ...descriptor, idFieldTypes: { PLOTUID: 'integer', NEWPLOTNO: 'date' } },
            { ...descriptor, idFieldTypes: { PLOTUID: 'integer' } },
            { ...descriptor, idField: 'PLOTUID' },
            { ...descriptor, idType: 'string' },
            { ...descriptor, idPattern: '^.+$' },
            { ...descriptor, idQueryBraces: true }
        ];
        for (const item of invalid) expect(() => createArcgisParcelSource(item)).toThrow(/Invalid ArcGIS/);
    });

    it('supports a string/string composite identity for PAIN-style native keys', async () => {
        const stringDescriptor = { ...descriptor, idFields: ['PAIN', 'NEWPLOTNO'],
            idFieldTypes: { PAIN: 'string', NEWPLOTNO: 'string' },
            outFields: ['OBJECTID', 'PAIN', 'NEWPLOTNO', 'STATUS'] };
        const { fetchImpl, calls } = makeFetch(() => response([]));
        const result = await createArcgisParcelSource(stringDescriptor, { fetchImpl })
            .queryIds(['OM-TEST-PAIN-007~00023']);
        expect(calls[0].searchParams.get('where')).toBe("(PAIN = 'PAIN-007' AND NEWPLOTNO = '00023')");
        expect(result.absentIds).toEqual(['OM-TEST-PAIN-007~00023']);
    });

    it('does not report IDs absent when the composite object-ID manifest is incomplete', async () => {
        const { fetchImpl } = makeFetch(params => params.has('returnCountOnly')
            ? jsonResponse({ count: 2 })
            : jsonResponse({ objectIds: [7], objectIdFieldName: 'OBJECTID' }));
        const source = createArcgisParcelSource({ ...descriptor, idsQueryMode: 'object-ids' }, { fetchImpl });
        await expect(source.queryIds(['OM-TEST-42~00100'])).rejects.toThrow(/object-ID/i);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('fetches all native component rows beyond the viewport and returns stable complete geometry', async () => {
        const rows = [
            feature(1, 42, '00100', polygon(58.3801, 23.5901, 58.3805, 23.5905)),
            feature(2, 42, '00100', polygon(58.3820, 23.5901, 58.3824, 23.5905))
        ];
        const handler = params => {
            const where = params.get('where') || '';
            if (params.has('returnCountOnly')) return jsonResponse({ count: params.has('geometry') ? 1 : 2 });
            if (params.has('returnIdsOnly')) return jsonResponse({ objectIds: params.has('geometry') ? [1] : [1, 2], objectIdFieldName: 'OBJECTID' });
            if (params.has('objectIds')) return response(rows.filter(row => params.get('objectIds').split(',').includes(String(row.properties.OBJECTID))));
            if (where.includes('PLOTUID = 42')) return response(rows);
            return response([]);
        };
        const { fetchImpl, calls } = makeFetch(handler);
        const source = createArcgisParcelSource({ ...descriptor, nativeGeometryMode: 'parts',
            boundsQueryMode: 'object-ids', idsQueryMode: 'object-ids', pageSize: 1,
            attributeFilters: { STATUS: "O'K" } }, { fetchImpl });
        const viewport = await source.queryBounds([58.3800, 23.5900, 58.3810, 23.5910]);
        const panned = await source.queryBounds([58.3815, 23.5900, 58.3830, 23.5910]);
        const exact = await source.queryIds(['OM-TEST-42~00100']);

        expect(viewport.features).toHaveLength(1);
        expect(viewport.features[0].geometry.type).toBe('MultiPolygon');
        expect(viewport.features[0].geometry.coordinates).toHaveLength(2);
        expect(viewport.features).toEqual(panned.features);
        expect(viewport.features).toEqual(exact.features);
        expect(viewport).toMatchObject({ complete: true, sourceRows: 2, viewportSourceRows: 1 });
        expect(calls.some(url => url.searchParams.get('objectIds') === '2')).toBe(true);
        for (const url of calls) {
            expect(url.searchParams.get('where')).toContain("STATUS = 'O''K'");
            if (url.searchParams.get('where').includes('PLOTUID = 42')) {
                expect(url.searchParams.get('where')).toContain("(PLOTUID = 42 AND NEWPLOTNO = '00100')");
            }
        }
    });

    describe('disjoint native components', () => {
        const partsDescriptor = { ...descriptor, nativeGeometryMode: 'parts', boundsQueryMode: 'object-ids',
            idsQueryMode: 'object-ids', disjointParts: true };
        const west = polygon(58.38, 23.59, 58.3804, 23.5904);
        const east = polygon(58.381, 23.59, 58.3814, 23.5904);
        const overlap = polygon(58.3802, 23.5901, 58.3806, 23.5905);

        function exactSource(rows) {
            const { fetchImpl } = makeFetch(params => {
                if (params.has('returnCountOnly')) return jsonResponse({ count: rows.length });
                if (params.has('returnIdsOnly')) return jsonResponse({ objectIds: rows.map(row => row.properties.OBJECTID), objectIdFieldName: 'OBJECTID' });
                if (params.has('objectIds')) {
                    const ids = params.get('objectIds').split(',');
                    return response(rows.filter(row => ids.includes(String(row.properties.OBJECTID))));
                }
                return response([]);
            });
            return createArcgisParcelSource(partsDescriptor, { fetchImpl });
        }

        it('unions positive-area disjoint components into one stable parcel geometry', async () => {
            const result = await exactSource([feature(1, 42, '00100', west), feature(2, 42, '00100', east)])
                .queryIds(['OM-TEST-42~00100']);
            expect(result.complete).toBe(true);
            expect(result.features).toHaveLength(1);
            expect(result.features[0].geometry.type).toBe('MultiPolygon');
            expect(result.features[0].geometry.coordinates).toHaveLength(2);
        });

        it('rejects positive-area overlap between non-identical components', async () => {
            await expect(exactSource([feature(1, 42, '00100', west), feature(2, 42, '00100', overlap)])
                .queryIds(['OM-TEST-42~00100'])).rejects.toMatchObject({
                cause: expect.objectContaining({ message: 'Parcel components overlap.' })
            });
        });

        it('allows and de-duplicates identical geometry copies', async () => {
            const result = await exactSource([feature(1, 42, '00100', west), feature(2, 42, '00100', west)])
                .queryIds(['OM-TEST-42~00100']);
            expect(result.features).toHaveLength(1);
            expect(result.features[0].geometry).toEqual(west);
            expect(result.features[0].properties.sourcePartCount).toBe(2);
        });

        it('accepts a positive numeric seam overlap below the fixed tolerance', async () => {
            const tinyWest = polygon(58.38, 23.59, 58.3804, 23.590001);
            const tinyEast = polygon(58.380399999, 23.59, 58.3808, 23.590001);
            const overlap = turfIntersect(turfFeature(tinyWest), turfFeature(tinyEast));
            const overlapArea = turfArea(overlap);
            expect(overlapArea).toBeGreaterThan(0);
            expect(overlapArea).toBeLessThan(0.0001);

            const result = await exactSource([
                feature(1, 42, '00100', tinyWest), feature(2, 42, '00100', tinyEast)
            ], { partsCoordinatePrecision: 9 }).queryIds(['OM-TEST-42~00100']);
            expect(result.features).toHaveLength(1);
            expect(result.features[0].geometry.type).toBe('Polygon');
        });

        it('rejects a small numeric overlap above the fixed tolerance', async () => {
            const tinyWest = polygon(58.38, 23.59, 58.3804, 23.590001);
            const slightlyLargerEast = polygon(58.38039999, 23.59, 58.3808, 23.590001);
            const overlap = turfIntersect(turfFeature(tinyWest), turfFeature(slightlyLargerEast));
            const overlapArea = turfArea(overlap);
            expect(overlapArea).toBeGreaterThan(0.0001);
            expect(overlapArea).toBeLessThan(0.001);

            await expect(exactSource([
                feature(1, 42, '00100', tinyWest), feature(2, 42, '00100', slightlyLargerEast)
            ], { partsCoordinatePrecision: 9 }).queryIds(['OM-TEST-42~00100']))
                .rejects.toMatchObject({ cause: expect.objectContaining({ message: 'Parcel components overlap.' }) });
        });

        it('rejects disjointParts unless it is a boolean on parts geometry mode', () => {
            expect(() => createArcgisParcelSource({ ...descriptor, disjointParts: true })).toThrow(/Invalid ArcGIS/);
            expect(() => createArcgisParcelSource({ ...partsDescriptor, disjointParts: 'true' })).toThrow(/Invalid ArcGIS/);
        });
    });

    describe('administrative component references', () => {
        const partsDescriptor = { ...descriptor, nativeGeometryMode: 'parts', boundsQueryMode: 'object-ids',
            idsQueryMode: 'object-ids', partMatchFields: ['NEWHOUSINGAREACD', 'NEWPHASECD'],
            outFields: [...descriptor.outFields, 'NEWHOUSINGAREACD', 'NEWPHASECD'] };
        const first = polygon(58.38, 23.59, 58.3804, 23.5904);
        const second = polygon(58.381, 23.59, 58.3814, 23.5904);

        function referencedRow(objectId, geometry, values = {}) {
            const row = feature(objectId, 42, '00100', geometry);
            return { ...row, properties: { ...row.properties, ...values } };
        }

        function exactSource(rows, overrides = {}) {
            const { fetchImpl } = makeFetch(params => {
                if (params.has('returnCountOnly')) return jsonResponse({ count: rows.length });
                if (params.has('returnIdsOnly')) return jsonResponse({ objectIds: rows.map(row => row.properties.OBJECTID), objectIdFieldName: 'OBJECTID' });
                if (params.has('objectIds')) {
                    const ids = params.get('objectIds').split(',');
                    return response(rows.filter(row => ids.includes(String(row.properties.OBJECTID))));
                }
                return response([]);
            });
            return createArcgisParcelSource({ ...partsDescriptor, ...overrides }, { fetchImpl });
        }

        it('rejects parts of one composite parcel with different administrative references', async () => {
            const rows = [
                referencedRow(1, first, { NEWHOUSINGAREACD: 'A1', NEWPHASECD: 'P1' }),
                referencedRow(2, second, { NEWHOUSINGAREACD: 'A2', NEWPHASECD: 'P1' })
            ];
            await expect(exactSource(rows).queryIds(['OM-TEST-42~00100']))
                .rejects.toThrow(/inconsistent administrative references/i);
        });

        it('rejects a row that omits a required administrative reference property', async () => {
            const rows = [
                referencedRow(1, first, { NEWHOUSINGAREACD: null, NEWPHASECD: null }),
                referencedRow(2, second, { NEWHOUSINGAREACD: null })
            ];
            await expect(exactSource(rows).queryIds(['OM-TEST-42~00100']))
                .rejects.toThrow(/omitted parcel administrative references/i);
        });

        it('accepts matching explicit null references on every component', async () => {
            const rows = [
                referencedRow(1, first, { NEWHOUSINGAREACD: null, NEWPHASECD: null }),
                referencedRow(2, second, { NEWHOUSINGAREACD: null, NEWPHASECD: null })
            ];
            const result = await exactSource(rows).queryIds(['OM-TEST-42~00100']);
            expect(result.features).toHaveLength(1);
            expect(result.features[0].geometry.type).toBe('MultiPolygon');
            expect(result.features[0].properties.sourceProperties).toMatchObject({
                NEWHOUSINGAREACD: null, NEWPHASECD: null
            });
        });

        it('validates partMatchFields as a bounded list of output fields on parts descriptors', () => {
            const invalid = [
                { ...descriptor, partMatchFields: ['STATUS'] },
                { ...partsDescriptor, partMatchFields: [] },
                { ...partsDescriptor, partMatchFields: ['BAD FIELD'] },
                { ...partsDescriptor, partMatchFields: ['MISSING'] },
                { ...partsDescriptor, partMatchFields: Array.from({ length: 9 }, (_, index) => `FIELD_${index}`),
                    outFields: [...partsDescriptor.outFields, ...Array.from({ length: 9 }, (_, index) => `FIELD_${index}`)] }
            ];
            for (const item of invalid) expect(() => createArcgisParcelSource(item)).toThrow(/Invalid ArcGIS/);
        });
    });
});
