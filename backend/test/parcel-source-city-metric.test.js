// A shared provider keeps one adapter identity while authoritative binding uses each city's metric projection.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createParcelSource, parcelSourceCatalog, parcelSourceForCity } from '../parcels/sources.js';
import { computeBinding, bindingFrame, FOOTPRINT_SITE_SQL } from '../proposals/binding.js';
import { encodeSnapshotNativeId } from '../parcels/geojson-snapshot-source.js';
const descriptor = { id: 'test-metric-shared', adapter: 'geojson-snapshot', endpoint: 'https://example.org/shared.geojson',
    idPrefix: 'TEST-METRIC-', idFields: ['city', 'sheet', 'id'], outFields: ['city', 'sheet', 'id'],
    cityIds: ['metric_tokyo', 'metric_osaka'], metricSrid: 32653,
    metricSridByCity: { metric_tokyo: 32654, metric_osaka: 32653 } };
const geometry = { type: 'Polygon', coordinates: [[[139.76, 35.69], [139.7601, 35.69],
    [139.7601, 35.6901], [139.76, 35.6901], [139.76, 35.69]]] };
afterEach(() => {
    const index = parcelSourceCatalog.sources.findIndex(source => source.id === descriptor.id);
    if (index >= 0) parcelSourceCatalog.sources.splice(index, 1);
    vi.unstubAllGlobals();
});
describe('shared source metric projection by city', () => {
    it('resolves per-city projection without changing adapter cache identity, and computes authoritative binding in the footprint\'s own frame', async () => {
        parcelSourceCatalog.sources.push(descriptor);
        const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ type: 'FeatureCollection', features: [
            { type: 'Feature', properties: { city: '13101', sheet: 'map', id: 'H1' }, geometry }
        ] })));
        vi.stubGlobal('fetch', fetchImpl);
        const tokyo = parcelSourceForCity('metric_tokyo');
        const osaka = parcelSourceForCity('metric_osaka');
        expect(tokyo.descriptor.metricSrid).toBe(32654);
        expect(osaka.descriptor.metricSrid).toBe(32653);
        expect(descriptor.metricSrid).toBe(32653);
        expect(tokyo.descriptor).not.toBe(descriptor);
        const ids = [descriptor.idPrefix + encodeSnapshotNativeId(['13101', 'map', 'H1'])];
        await tokyo.adapter.queryIds(ids);
        await osaka.adapter.queryIds(ids);
        const db = { query: vi.fn(() => { throw Error('Unexpected imported parcel read'); }) };
        const { binding } = await computeBinding(db, { city: 'metric_tokyo', site: geometry });
        expect(binding.coverage).toBe('complete');
        expect(binding.parcels.map(parcel => parcel.parcelId)).toEqual(ids);
        expect(db.query).not.toHaveBeenCalled();
        expect(fetchImpl).toHaveBeenCalledOnce();
        const unionDb = { query: vi.fn(async () => ({ rows: [{ geometry: JSON.stringify(geometry) }] })) };
        const parts = { polygons: [{ type: 'MultiPolygon', coordinates: [geometry.coordinates] }], centerline: null };
        // The source's per-city metric SRID describes its data; a footprint is widened in its own frame.
        await computeBinding(unionDb, { city: 'metric_tokyo', parts });
        expect(unionDb.query.mock.calls[0][0]).toBe(FOOTPRINT_SITE_SQL);
        expect(unionDb.query.mock.calls[0][0]).not.toMatch(/32654|32653|3765/);
        expect(unionDb.query.mock.calls[0][1].at(-1)).toBe(bindingFrame({ parts }).proj);
        await computeBinding(unionDb, { city: 'metric_osaka', parts });
        expect(unionDb.query.mock.calls[1][1].at(-1)).toBe(bindingFrame({ parts }).proj);
        expect(fetchImpl).toHaveBeenCalledOnce();
    });
    it('rejects missing, extra, noninteger and nonpositive metric mappings', () => {
        for (const metricSridByCity of [{ metric_tokyo: 32654 },
            { ...descriptor.metricSridByCity, extra: 32653 },
            { ...descriptor.metricSridByCity, metric_tokyo: 0 },
            { ...descriptor.metricSridByCity, metric_tokyo: 32654.5 },
            { ...descriptor.metricSridByCity, metric_tokyo: '32654' }]) {
            expect(() => createParcelSource({ ...descriptor, metricSridByCity })).toThrow(/metric/);
        }
    });
});
