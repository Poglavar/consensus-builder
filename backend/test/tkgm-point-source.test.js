import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createTkgmPointSource } from '../parcels/tkgm-point-source.js';

const fixture = JSON.parse(readFileSync(new URL('../../world-parcels/research/istanbul-live-2026-10-08-sample.geojson', import.meta.url), 'utf8')).features[0];
const descriptor = {
    adapter: 'tkgm-point',
    id: 'tr-tkgm-parselsorgu-api',
    idPrefix: 'TR-TKGM-',
    endpoint: 'https://cbsapi.tkgm.gov.tr/megsiswebapi.v3.1/api/parsel',
    idField: 'nativeId',
    parcelNumberField: 'parselNo',
    outFields: ['mahalleId', 'adaNo', 'parselNo']
};
const nativeId = '147986-1065-16';
const parcelId = `${descriptor.idPrefix}${nativeId}`;
const point = [28.94966, 41.01384];

function response(payload, status = 200, headers = { 'Content-Type': 'application/json' }) {
    return new Response(JSON.stringify(payload), { status, headers });
}

function source(fetchImpl, options = {}) { return createTkgmPointSource(descriptor, { fetchImpl, ...options }); }

function responseFeature(properties = fixture.properties, geometry = fixture.geometry) {
    return { type: 'Feature', geometry, properties };
}

afterEach(() => vi.restoreAllMocks());

describe('TKGM point parcel source', () => {
    it('registers the live Istanbul native identity and keeps only the three ID fields', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(response(responseFeature()));
        const adapter = source(fetchImpl);
        const result = await adapter.queryPoint(point);

        expect(fetchImpl).toHaveBeenCalledOnce();
        expect(fetchImpl.mock.calls[0][0]).toBe(`${descriptor.endpoint}/41.01384/28.94966`);
        expect(fetchImpl.mock.calls[0][1]).toMatchObject({ method: 'GET', redirect: 'error' });
        expect(fetchImpl.mock.calls[0][1].headers).toEqual({ Accept: 'application/geo+json, application/json' });
        expect(fetchImpl.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
        expect(result).toMatchObject({ complete: true, queryType: 'point', sourceId: descriptor.id, returnsWGS84: true, point });
        expect(result.features).toHaveLength(1);
        expect(result.features[0]).toMatchObject({
            id: parcelId,
            geometry: fixture.geometry,
            properties: {
                parcelId, sourceId: descriptor.id, sourceParcelId: nativeId, parcelNumber: '16',
                sourceProperties: { mahalleId: '147986', adaNo: '1065', parselNo: '16' }
            }
        });
        expect(Object.keys(result.features[0].properties.sourceProperties)).toEqual(descriptor.outFields);
    });

    it('uses exact native IDs and preserves string padding without numeric coercion', async () => {
        const padded = { mahalleId: '00147986', adaNo: '001065', parselNo: '00016' };
        const id = 'TR-TKGM-00147986-001065-00016';
        const fetchImpl = vi.fn().mockResolvedValue(response(responseFeature(padded)));
        const result = await source(fetchImpl).queryIds([id, id]);

        expect(fetchImpl).toHaveBeenCalledOnce();
        expect(fetchImpl.mock.calls[0][0]).toBe(`${descriptor.endpoint}/00147986/001065/00016`);
        expect(result).toMatchObject({ complete: true, queryType: 'ids', sourceId: descriptor.id, returnsWGS84: true, absentIds: [] });
        expect(result.features).toHaveLength(1);
        expect(result.features[0].id).toBe(id);
        expect(result.features[0].properties.sourceParcelId).toBe('00147986-001065-00016');
        expect(result.features[0].properties.sourceProperties).toEqual(padded);
    });

    it('accepts only an exact-ID no-hit 404 message that echoes the requested native ID', async () => {
        const message = 'Parsel Bulunamadı: Mahalle Id = 147986 - Ada = 999999 - Parsel = 999999';
        const fetchImpl = vi.fn().mockResolvedValue(response({ Message: message }, 404));
        const absentId = 'TR-TKGM-147986-999999-999999';
        const result = await source(fetchImpl).queryIds([absentId]);
        expect(result).toMatchObject({ complete: true, queryType: 'ids', absentIds: [absentId], features: [] });

        const other404 = vi.fn().mockResolvedValue(response({ Message: 'Parsel Bulunamadı' }, 404));
        await expect(source(other404).queryIds([absentId])).rejects.toMatchObject({
            status: 502, code: 'parcel-source-unavailable', upstreamStatus: 404
        });
    });

    it('returns an empty point result only for the provider 404 that echoes the requested coordinates', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(response({ Message: 'Parsel Bulunamadı: Enlem = 0 - Boylam=0 ' }, 404));
        await expect(source(fetchImpl).queryPoint([0, 0])).resolves.toMatchObject({
            complete: true, queryType: 'point', point: [0, 0], features: []
        });
        expect(fetchImpl).toHaveBeenCalledOnce();

        const unrelated = vi.fn().mockResolvedValue(response({ Message: 'Parsel Bulunamadı: Enlem = 0 - Boylam=1' }, 404));
        await expect(source(unrelated).queryPoint([0, 0])).rejects.toMatchObject({
            status: 502, code: 'parcel-source-unavailable', upstreamStatus: 404
        });
    });

    it('verifies Turkish decimal-comma no-hit coordinates without accepting a different point', async () => {
        const queried = [29.0470015858534, 40.2050411327084];
        const message = 'Parsel Bulunamadı: Enlem = 40,2050411327084 - Boylam=29,0470015858534 ';
        const fetchImpl = vi.fn().mockResolvedValue(response({ Message: message }, 404));
        await expect(source(fetchImpl).queryPoint(queried)).resolves.toMatchObject({
            complete: true, queryType: 'point', point: queried, features: []
        });
        const wrong = vi.fn().mockResolvedValue(response({ Message: message.replace('29,0470015858534', '29,0470015858535') }, 404));
        await expect(source(wrong).queryPoint(queried)).rejects.toMatchObject({ status: 502, upstreamStatus: 404 });
    });

    it('rejects HTTP 200 nulls as invalid point and exact-ID provider results', async () => {
        await expect(source(vi.fn().mockResolvedValue(response(null))).queryPoint(point))
            .rejects.toMatchObject({ status: 502, code: 'parcel-source-unavailable' });
        await expect(source(vi.fn().mockResolvedValue(response(null))).queryIds([parcelId]))
            .rejects.toMatchObject({ status: 502, code: 'parcel-source-unavailable' });

        const mismatch = vi.fn().mockResolvedValue(response(responseFeature({ ...fixture.properties, parselNo: '17' })));
        await expect(source(mismatch).queryIds([parcelId])).rejects.toMatchObject({ status: 502, code: 'parcel-source-unavailable' });
    });

    it('rejects invalid or non-containing point responses instead of snapping to a nearby parcel', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(response(responseFeature()));
        const adapter = source(fetchImpl);
        for (const invalid of [null, [], [28, 41, 1], ['28.9', 41], [181, 41], [28, -91], [NaN, 41]]) {
            await expect(adapter.queryPoint(invalid)).rejects.toMatchObject({ status: 400, code: 'invalid-parcel-point' });
        }
        expect(fetchImpl).not.toHaveBeenCalled();

        await expect(adapter.queryPoint([29, 41.5])).rejects.toMatchObject({ status: 502, code: 'parcel-source-unavailable' });
        expect(fetchImpl).toHaveBeenCalledOnce();
    });

    it('rejects malformed features, geometries, and native IDs from the provider', async () => {
        const sourceWith = payload => source(vi.fn().mockResolvedValue(response(payload)));
        await expect(sourceWith({ type: 'Feature', geometry: fixture.geometry }).queryPoint(point)).rejects.toMatchObject({ status: 502 });
        await expect(sourceWith(responseFeature(fixture.properties, { type: 'LineString', coordinates: [] })).queryPoint(point)).rejects.toMatchObject({ status: 502 });
        await expect(sourceWith(responseFeature({ ...fixture.properties, adaNo: 'bad-id' })).queryPoint(point)).rejects.toMatchObject({ status: 502 });
        await expect(source(vi.fn().mockResolvedValue(new Response('not-json'))).queryPoint(point)).rejects.toMatchObject({ status: 502 });
    });

    it('rejects invalid IDs and refuses area requests without calling the provider', async () => {
        const fetchImpl = vi.fn();
        const adapter = source(fetchImpl);
        await expect(adapter.queryIds(['147986-1065-16'])).rejects.toMatchObject({ status: 400, code: 'invalid-parcel-ids' });
        await expect(adapter.queryIds(['TR-TKGM-147986-1065'])).rejects.toMatchObject({ status: 400, code: 'invalid-parcel-ids' });
        await expect(adapter.queryIds(Array.from({ length: 81 }, (_, index) => `TR-TKGM-147986-${index}-1`))).rejects.toMatchObject({ status: 400 });
        await expect(adapter.queryBounds([28.9, 41, 29, 41.1])).rejects.toMatchObject({ status: 422, code: 'parcel-source-area-unsupported' });
        await expect(adapter.queryGeometry({ type: 'Polygon', coordinates: [] })).rejects.toMatchObject({ status: 422, code: 'parcel-source-area-unsupported' });
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('maps timeouts, access failures, and oversized responses without retrying', async () => {
        const timedOut = vi.fn().mockRejectedValue(Object.assign(new Error('timeout'), { name: 'TimeoutError' }));
        await expect(source(timedOut).queryPoint(point)).rejects.toMatchObject({ status: 504 });
        expect(timedOut).toHaveBeenCalledOnce();

        const forbidden = vi.fn().mockResolvedValue(response({ Message: 'blocked' }, 403));
        await expect(source(forbidden).queryPoint(point)).rejects.toMatchObject({ status: 502, code: 'parcel-source-blocked', upstreamStatus: 403 });
        expect(forbidden).toHaveBeenCalledOnce();

        const rateLimited = vi.fn().mockResolvedValue(new Response('<html>slow down</html>', {
            status: 429, headers: { 'content-type': 'text/html', 'retry-after': '17' }
        }));
        await expect(source(rateLimited).queryPoint(point)).rejects.toMatchObject({
            status: 502, code: 'parcel-source-rate-limited', upstreamStatus: 429, retryAfterSeconds: 17
        });
        expect(rateLimited).toHaveBeenCalledOnce();

        const large = vi.fn().mockResolvedValue(new Response(' '.repeat(2 * 1024 * 1024 + 1), { status: 200 }));
        await expect(source(large).queryPoint(point)).rejects.toMatchObject({ status: 502, code: 'parcel-source-unavailable' });
    });

    it('requires the descriptor to retain the verified endpoint and ID fields', () => {
        expect(() => createTkgmPointSource({ ...descriptor, endpoint: 'https://example.test' })).toThrow(/Invalid TKGM/);
        expect(() => createTkgmPointSource({ ...descriptor, outFields: ['mahalleId', 'adaNo', 'owner'] })).toThrow(/Invalid TKGM/);
    });
});
