import { describe, expect, it, vi } from 'vitest';
import { createMsdaPointSource } from '../parcels/msda-point-source.js';

const descriptor = {
    adapter: 'msda-point',
    id: 'ge-msda-napr-registered-land-plots',
    idPrefix: 'GE-NAPR-',
    endpoint: 'https://ms.gov.ge/core-api/v1/search',
    idField: 'cadCode',
    parcelNumberField: 'cadCode',
    outFields: ['cadCode']
};

const cadCode = '01.16.06.023.021';
const parcelId = `GE-NAPR-${cadCode}`;
const absentCode = '01.16.06.023.022';
const absentId = `GE-NAPR-${absentCode}`;
const wktShape = 'POLYGON ((44.80672966388622 41.708941444187076, 44.80666646292635 41.70899857722461, 44.80656614161029 41.70894133479246, 44.80655259169339 41.708933603691264, 44.806565920829 41.70891834915187, 44.80662768274834 41.70884766073413, 44.8067449407609 41.70891718488199, 44.80672132924812 41.70893659604853, 44.80672966388622 41.708941444187076))';
const record = { cadCode, wktShape };
const response = payload => new Response(JSON.stringify(payload), {
    status: 200, headers: { 'Content-Type': 'application/json' }
});
const source = fetchImpl => createMsdaPointSource(descriptor, { fetchImpl });

describe('MSDA point parcel source', () => {
    it('returns only a polygon containing the requested point with canonical source identity', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(response({ naprTchParcel: { layerRecords: [record] } }));
        const result = await source(fetchImpl).queryPoint([44.80665, 41.70893]);

        expect(fetchImpl).toHaveBeenCalledOnce();
        expect(fetchImpl.mock.calls[0][0]).toBe(`${descriptor.endpoint}/search-by-xy`);
        expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ lrIds: [261415], x: 44.80665, y: 41.70893, zoom: 20 });
        expect(result).toMatchObject({ complete: true, queryType: 'point', sourceId: descriptor.id, returnsWGS84: true });
        expect(result.features).toHaveLength(1);
        expect(result.features[0]).toMatchObject({
            id: parcelId,
            geometry: { type: 'Polygon' },
            properties: {
                parcelId, sourceId: descriptor.id, sourceParcelId: cadCode,
                parcelNumber: cadCode, sourceProperties: { cadCode }
            }
        });
        expect(result).not.toHaveProperty('absentIds');
    });

    it('treats a null NAPR point result as no parcel at that point only', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(response({ naprTchParcel: null }));
        await expect(source(fetchImpl).queryPoint([44.8067283, 41.7088867])).resolves.toMatchObject({
            complete: true, queryType: 'point', point: [44.8067283, 41.7088867], features: []
        });
    });

    it('does not snap to a nearby parcel when returned geometry misses the requested point', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(response({ naprTchParcel: { layerRecords: [record] } }));
        await expect(source(fetchImpl).queryPoint([44.8064, 41.7088])).rejects.toMatchObject({
            status: 502, code: 'parcel-source-unavailable'
        });
    });

    it('rejects malformed point payloads and invalid parcel geometry as provider errors', async () => {
        const missingRows = vi.fn().mockResolvedValue(response({ naprTchParcel: {} }));
        await expect(source(missingRows).queryPoint([44.80665, 41.70893])).rejects.toMatchObject({ status: 502 });

        const malformedGeometry = vi.fn().mockResolvedValue(response({
            naprTchParcel: { layerRecords: [{ cadCode, wktShape: 'LINESTRING (44.8 41.7, 44.9 41.8)' }] }
        }));
        await expect(source(malformedGeometry).queryPoint([44.80665, 41.70893])).rejects.toMatchObject({ status: 502 });

        const payloadError = vi.fn().mockResolvedValue(response({ error: 'temporarily unavailable', naprTchParcel: { layerRecords: [] } }));
        await expect(source(payloadError).queryPoint([44.80665, 41.70893])).rejects.toMatchObject({ status: 502 });
        const layerError = vi.fn().mockResolvedValue(response({ naprTchParcel: { error: 'query failed', layerRecords: [] } }));
        await expect(source(layerError).queryPoint([44.80665, 41.70893])).rejects.toMatchObject({ status: 502 });
    });

    it('fetches exact canonical IDs, declares only requested absences and rejects mismatched codes', async () => {
        const fetchImpl = vi.fn()
            .mockResolvedValueOnce(response({ naprSearchResult: record }))
            .mockResolvedValueOnce(response({ naprSearchResult: null }));
        const result = await source(fetchImpl).queryIds([parcelId, absentId]);
        expect(fetchImpl.mock.calls.map(call => [call[0], JSON.parse(call[1].body)])).toEqual([
            [`${descriptor.endpoint}/unified-search`, { searchText: cadCode }],
            [`${descriptor.endpoint}/unified-search`, { searchText: absentCode }]
        ]);
        expect(result).toMatchObject({
            complete: true, queryType: 'ids', sourceId: descriptor.id, returnsWGS84: true,
            absentIds: [absentId]
        });
        expect(result.features.map(feature => feature.id)).toEqual([parcelId]);

        const mismatch = vi.fn().mockResolvedValue(response({ naprSearchResult: { ...record, cadCode: 'different' } }));
        await expect(source(mismatch).queryIds([parcelId])).rejects.toMatchObject({ status: 502 });
    });

    it('rejects malformed exact-ID responses instead of converting them to absence', async () => {
        const missingResult = vi.fn().mockResolvedValue(response({}));
        await expect(source(missingResult).queryIds([parcelId])).rejects.toMatchObject({ status: 502 });
        const badWkt = vi.fn().mockResolvedValue(response({ naprSearchResult: { cadCode, wktShape: 'POLYGON EMPTY' } }));
        await expect(source(badWkt).queryIds([parcelId])).rejects.toMatchObject({ status: 502 });
        const payloadError = vi.fn().mockResolvedValue(response({ error: 'temporarily unavailable', naprSearchResult: null }));
        await expect(source(payloadError).queryIds([parcelId])).rejects.toMatchObject({ status: 502 });
        const recordError = vi.fn().mockResolvedValue(response({ naprSearchResult: { error: 'query failed' } }));
        await expect(source(recordError).queryIds([parcelId])).rejects.toMatchObject({ status: 502 });
    });

    it('accepts source-binding-sized exact-ID chunks up to 80 IDs', async () => {
        const ids = Array.from({ length: 80 }, (_, index) => `GE-NAPR-01.16.06.023.${String(index + 1).padStart(3, '0')}`);
        const fetchImpl = vi.fn().mockImplementation(() => response({ naprSearchResult: null }));
        const result = await source(fetchImpl).queryIds(ids);
        expect(fetchImpl).toHaveBeenCalledTimes(80);
        expect(result.absentIds).toEqual(ids);
        await expect(source(vi.fn()).queryIds([...ids, parcelId])).rejects.toMatchObject({ status: 400, code: 'invalid-parcel-ids' });
    });

    it('does not call the provider for area queries', async () => {
        const fetchImpl = vi.fn();
        const adapter = source(fetchImpl);
        await expect(adapter.queryBounds([44.8, 41.7, 44.81, 41.71])).rejects.toMatchObject({
            status: 422, code: 'parcel-source-area-unsupported'
        });
        await expect(adapter.queryGeometry({ type: 'Polygon', coordinates: [] })).rejects.toMatchObject({
            status: 422, code: 'parcel-source-area-unsupported'
        });
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('maps public HTTP failures and bounds the response size', async () => {
        const forbidden = vi.fn().mockResolvedValue(new Response('', { status: 403 }));
        await expect(source(forbidden).queryPoint([44.80665, 41.70893])).rejects.toMatchObject({
            status: 502, code: 'parcel-source-blocked', upstreamStatus: 403
        });

        const large = vi.fn().mockResolvedValue(new Response(' '.repeat(2 * 1024 * 1024 + 1), { status: 200 }));
        await expect(source(large).queryPoint([44.80665, 41.70893])).rejects.toMatchObject({ status: 502 });
    });
});
