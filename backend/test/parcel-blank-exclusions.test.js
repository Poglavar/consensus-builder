import { describe, expect, it, vi } from 'vitest';
import { createParcelAttributeFilter } from '../parcels/source-contract.js';
import { createArcgisParcelSource } from '../parcels/arcgis-source.js';

const descriptor = {
    adapter: 'arcgis', id: 'blank-test', endpoint: 'https://example.test/arcgis/FeatureServer/0',
    idPrefix: 'BLANK-', idField: 'PARCEL_ID', idType: 'string', objectIdField: 'OBJECTID',
    outFields: ['OBJECTID', 'PARCEL_ID', 'STATUS'], attributeExclusions: { STATUS: '' },
    boundsQueryMode: 'object-ids', idsQueryMode: 'object-ids', pageSize: 10, maxFeatures: 100
};

const polygon = { type: 'Polygon', coordinates: [[[58.38, 23.59], [58.381, 23.59],
    [58.381, 23.591], [58.38, 23.591], [58.38, 23.59]]] };
const parcel = status => ({ type: 'Feature', id: 7,
    properties: { OBJECTID: 7, PARCEL_ID: 'P1', STATUS: status }, geometry: polygon });
const collection = features => ({ type: 'FeatureCollection', features, exceededTransferLimit: false });
const jsonResponse = payload => ({ ok: true, status: 200, json: async () => payload });

function sourceWithRows(rows) {
    const calls = [];
    const fetchImpl = vi.fn(async url => {
        const parsed = new URL(url);
        calls.push(parsed);
        const params = parsed.searchParams;
        if (params.has('returnCountOnly')) return jsonResponse({ count: rows.length });
        if (params.has('returnIdsOnly')) return jsonResponse({ objectIds: rows.map(row => row.properties.OBJECTID), objectIdFieldName: 'OBJECTID' });
        if (params.has('objectIds')) return jsonResponse(collection(rows));
        return jsonResponse(collection([]));
    });
    return { source: createArcgisParcelSource(descriptor, { fetchImpl }), calls, fetchImpl };
}

describe('blank parcel attribute exclusions', () => {
    it('allows an empty exclusion and matches it as a fail-closed nonblank requirement', () => {
        const filter = createParcelAttributeFilter(descriptor);
        expect(filter.where).toBe("STATUS <> ''");
        expect(filter.matches({ STATUS: 'Active' })).toBe(true);
        expect(filter.matches({ STATUS: '' })).toBe(false);
        expect(filter.matches({ STATUS: null })).toBe(false);
        expect(filter.matches({})).toBe(false);
    });

    it('keeps empty positive filters invalid', () => {
        expect(() => createParcelAttributeFilter({ ...descriptor,
            attributeFilters: { STATUS: '' }, attributeExclusions: {} })).toThrow('Invalid parcel attribute filter.');
    });

    it('applies the blank exclusion to viewport, count, manifest, and exact native-ID reads', async () => {
        const { source, calls } = sourceWithRows([parcel('Active')]);
        const viewport = await source.queryBounds([58.379, 23.589, 58.382, 23.592]);
        const exact = await source.queryIds(['BLANK-P1']);

        expect(viewport.features.map(feature => feature.id)).toEqual(['BLANK-P1']);
        expect(exact.features.map(feature => feature.id)).toEqual(['BLANK-P1']);
        expect(calls.length).toBeGreaterThanOrEqual(6);
        for (const call of calls) expect(call.searchParams.get('where')).toContain("STATUS <> ''");

        expect(calls.some(call => call.searchParams.has('geometry') && call.searchParams.has('returnCountOnly'))).toBe(true);
        expect(calls.some(call => call.searchParams.has('geometry') && call.searchParams.has('returnIdsOnly'))).toBe(true);
        expect(calls.some(call => call.searchParams.has('returnCountOnly') && !call.searchParams.has('geometry')
            && call.searchParams.get('where').includes("PARCEL_ID IN ('P1')"))).toBe(true);
        expect(calls.some(call => call.searchParams.has('returnIdsOnly') && !call.searchParams.has('geometry')
            && call.searchParams.get('where').includes("PARCEL_ID IN ('P1')"))).toBe(true);
    });

    it('rejects an empty source key even when the provider ignores the exclusion SQL', async () => {
        const { source, calls } = sourceWithRows([parcel('')]);
        await expect(source.queryBounds([58.379, 23.589, 58.382, 23.592]))
            .rejects.toThrow('Parcel provider returned a record outside the configured ground status.');
        expect(calls.every(call => call.searchParams.get('where').includes("STATUS <> ''"))).toBe(true);
    });
});
