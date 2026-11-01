import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { resolveParcelNumber } from '../agents/mcp-parcel-numbers.js';

const require = createRequire(import.meta.url);
const { getParcelDisplayNumberFromFeature } = require('../../frontend/js/proposals/parcel-id.js');
const point = [15.98, 45.81];
const visible = (parcelId, label, at = point) => ({ parcelId, label, point: at });
const feature = (parcelId, properties = {}, geometry = { type: 'Polygon', coordinates: [[[15.97, 45.8], [15.99, 45.8], [15.99, 45.82], [15.97, 45.82], [15.97, 45.8]]] }) => ({
    type: 'Feature', id: parcelId, properties: { parcelId, ...properties }, geometry
});

describe('exact parcel number resolution', () => {
    it('matches the full displayed fraction label exactly', async () => {
        const result = await resolveParcelNumber({ parcelNumber: ' 12/4 ', visibleParcels: [
            visible('HR-335550-12-4', '12/4'), visible('HR-335550-12-40', '12/40')
        ] });
        expect(result).toEqual({ parcelId: 'HR-335550-12-4', label: '12/4', point });
    });

    it('resolves a full source ID exactly without guessing from a suffix', async () => {
        const parcels = [visible('cadastre-52-991/4', '991/4'), visible('cadastre-52-991/40', '991/40')];
        await expect(resolveParcelNumber({ parcelNumber: 'cadastre-52-991/4', visibleParcels: parcels }))
            .resolves.toMatchObject({ parcelId: 'cadastre-52-991/4', label: '991/4' });
        await expect(resolveParcelNumber({ parcelNumber: '4', visibleParcels: parcels }))
            .rejects.toMatchObject({ code: 'parcel-number-not-found' });
        await expect(resolveParcelNumber({ parcelNumber: '991', visibleParcels: parcels }))
            .rejects.toMatchObject({ code: 'parcel-number-not-found' });
    });

    it('refuses a duplicated displayed number with exact candidate references', async () => {
        await expect(resolveParcelNumber({ parcelNumber: '12/4', visibleParcels: [
            visible('parcel-a', '12/4', [15.98, 45.81]), visible('parcel-b', '12/4', [15.981, 45.811])
        ] })).rejects.toMatchObject({ code: 'parcel-number-ambiguous', constraints: { matches: [
            { parcelId: 'parcel-a', label: '12/4', point: [15.98, 45.81] },
            { parcelId: 'parcel-b', label: '12/4', point: [15.981, 45.811] }
        ] } });
    });

    it('refuses truncated visible-label coverage before attempting a match', async () => {
        await expect(resolveParcelNumber({ parcelNumber: '12/4', visibleParcels: [visible('p1', '12/4')], visibleParcelsTruncated: true }))
            .rejects.toMatchObject({ code: 'parcel-label-coverage-incomplete' });
    });

    it('uses the shared parcel display-number accessor for source features and queries complete geometry', async () => {
        const sourceFeature = feature('parcel-geometry-id', { BROJ_CESTICE: ' 8/7 ' });
        const expectedLabel = getParcelDisplayNumberFromFeature(sourceFeature);
        const read = { parcels: vi.fn(async () => ({ complete: true, truncated: false, features: [sourceFeature] })) };
        const result = await resolveParcelNumber({ parcelNumber: '8/7', city: 'test', parcelSourceId: 'cadastre', bbox: [15.97, 45.8, 15.99, 45.82], read });
        expect(expectedLabel).toBe('8/7');
        expect(read.parcels).toHaveBeenCalledTimes(1);
        const args = read.parcels.mock.calls[0][0];
        expect(args).toMatchObject({ city: 'test', parcelSourceId: 'cadastre', geometry: { type: 'Polygon' } });
        expect(args.geometry.coordinates[0]).toEqual([[15.97, 45.8], [15.99, 45.8], [15.99, 45.82], [15.97, 45.82], [15.97, 45.8]]);
        expect(result).toMatchObject({ parcelId: 'parcel-geometry-id', label: '8/7' });
        expect(result.point).toHaveLength(2);
    });

    it('refuses incomplete or truncated source coverage', async () => {
        const bbox = [15.97, 45.8, 15.99, 45.82];
        for (const sourceResult of [
            { complete: false, truncated: false, features: [] },
            { complete: true, truncated: true, features: [feature('p', { parcelNumber: '8/7' })] },
            { complete: true, truncated: false, features: null }
        ]) {
            const read = { parcels: vi.fn(async () => sourceResult) };
            await expect(resolveParcelNumber({ parcelNumber: '8/7', bbox, read })).rejects.toMatchObject({ code: 'parcel-coverage-incomplete' });
        }
    });

    it('requires a bounded explicit viewport when resolving labels from a source', async () => {
        await expect(resolveParcelNumber({ parcelNumber: '8/7', bbox: [0, 0, 0.031, 0.02], read: { parcels: vi.fn() } }))
            .rejects.toMatchObject({ code: 'parcel-number-bounds-required' });
    });
});
