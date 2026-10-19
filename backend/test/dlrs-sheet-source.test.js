import { describe, expect, it, vi } from 'vitest';
import { createDlrsSheetParcelSource } from '../parcels/dlrs-sheet-source.js';

const descriptor = {
    id: 'bd-test-sheet', endpoint: 'https://settlement.gov.bd/Khatian/GetSheetJsonBySurvey',
    sheetForm: { rsnum: '201901', comcod: '4105', unitcod: '010510026', sheetno: '001' },
    idPrefix: 'BD-DLRS-201901-4105-010510026-001-', expectedSnapshotFeatures: 2,
    maxSnapshotBytes: 1024 * 1024, maxSnapshotFeatures: 5000, maxFeatures: 5000, maxBboxKm2: 1
};
const polygon = { type: 'Polygon', coordinates: [[[90.224, 23.966], [90.2242, 23.966],
    [90.2242, 23.9662], [90.224, 23.9662], [90.224, 23.966]]] };
const feature = (key, geometry = polygon) => ({ type: 'Feature', properties: { Dag_No: key, FID: 1, unrelated: 'discard' }, geometry });
const payload = features => ({ type: 'FeatureCollection', crs: { type: 'name', properties: { name: 'EPSG:4326' } }, features });
const response = (features = [feature('100'), feature('48')]) => new Response(JSON.stringify(payload(features)));
const bbox = [90.2239, 23.9659, 90.2243, 23.9663];

describe('DLRS complete BDS survey sheets', () => {
    it('uses the fixed anonymous sheet form, stable plot numbers and shared complete snapshot for all reads', async () => {
        const fetchImpl = vi.fn(async () => response());
        const source = createDlrsSheetParcelSource(descriptor, { fetchImpl });
        const bounds = await source.queryBounds(bbox);
        const ids = await source.queryIds([bounds.features[0].id, descriptor.idPrefix + '999']);
        const under = await source.queryGeometry(polygon);
        expect(bounds.complete).toBe(true);
        expect(bounds.features.map(f => f.id)).toEqual([descriptor.idPrefix + '100', descriptor.idPrefix + '48']);
        expect(ids.features.map(f => f.id)).toEqual([bounds.features[0].id]);
        expect(ids.absentIds).toEqual([descriptor.idPrefix + '999']);
        expect(under.features).toHaveLength(2);
        expect(bounds.features[0].properties.sourceProperties).toEqual({ Dag_No: '100' });
        expect(fetchImpl).toHaveBeenCalledOnce();
        expect(fetchImpl.mock.calls[0][1]).toMatchObject({ method: 'POST', redirect: 'error',
            body: 'rsnum=201901&comcod=4105&unitcod=010510026&sheetno=001' });
    });

    it('rejects partial or changed sheets rather than claiming complete or absent parcels', async () => {
        const source = createDlrsSheetParcelSource(descriptor, { fetchImpl: async () => response([feature('100')]) });
        await expect(source.queryBounds(bbox)).rejects.toMatchObject({ code: 'parcel-source-unavailable' });
    });

    it.each([
        [feature('100'), feature('100')],
        [feature(0), feature('48')],
        [feature(null), feature('48')],
        [feature('100', { type: 'Point', coordinates: [90.224, 23.966] }), feature('48')]
    ])('rejects duplicate, placeholder or invalid plot records', async (first, second) => {
        const source = createDlrsSheetParcelSource(descriptor, { fetchImpl: async () => response([first, second]) });
        await expect(source.queryBounds(bbox)).rejects.toMatchObject({ code: 'parcel-source-unavailable' });
    });

    it.each([403, 429])('preserves provider HTTP %i status and retry metadata', async status => {
        const source = createDlrsSheetParcelSource(descriptor, { fetchImpl: async () => new Response('', {
            status, headers: { 'Retry-After': '45' }
        }) });
        await expect(source.queryBounds(bbox)).rejects.toMatchObject({ upstreamStatus: status,
            code: status === 403 ? 'parcel-source-blocked' : 'parcel-source-rate-limited',
            ...(status === 429 ? { retryAfterSeconds: 45 } : {}) });
    });

    it('drops an expired snapshot when its refresh fails and recovers on a later successful read', async () => {
        let now = 1;
        const fetchImpl = vi.fn().mockResolvedValueOnce(response()).mockResolvedValueOnce(new Response('', { status: 503 }))
            .mockResolvedValueOnce(response());
        const source = createDlrsSheetParcelSource(descriptor, { fetchImpl, now: () => now });
        await source.queryBounds(bbox);
        now += 5 * 60 * 1000;
        await expect(source.queryIds([descriptor.idPrefix + '100'])).rejects.toMatchObject({ upstreamStatus: 503 });
        await expect(source.queryIds([descriptor.idPrefix + '100'])).resolves.toMatchObject({ complete: true });
        expect(fetchImpl).toHaveBeenCalledTimes(3);
    });

    it('rejects foreign IDs before network requests', async () => {
        const fetchImpl = vi.fn();
        const source = createDlrsSheetParcelSource(descriptor, { fetchImpl });
        await expect(source.queryIds(['OTHER-100'])).rejects.toMatchObject({ status: 400 });
        expect(fetchImpl).not.toHaveBeenCalled();
    });
});
