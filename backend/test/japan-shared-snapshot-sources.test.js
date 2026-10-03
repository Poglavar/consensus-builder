// Shared 2026 Japan editions keep published composite IDs, selective resource reads and per-city binding.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parcelSourceCatalog, parcelSourceForCity, parcelSourceForIds } from '../parcels/sources.js';
import { encodeSnapshotNativeId } from '../parcels/geojson-snapshot-source.js';
import { computeBinding } from '../proposals/binding.js';
const cases = [
    { city: 'osaka', code: '27128', center: [135.532507321, 34.677750586], metric: 32653, count: 2487 },
    { city: 'tokyo', code: '13101', center: [139.766899192, 35.696623934], metric: 32654, count: 236 },
    { city: 'nagoya', code: '23101', center: [136.984010139, 35.163716454], metric: 32653, count: 284 }
];
const polygon = (x, y) => ({ type: 'Polygon', coordinates: [[[x, y], [x + .000001, y],
    [x + .000001, y + .000001], [x, y + .000001], [x, y]]] });
afterEach(() => vi.unstubAllGlobals());
describe.each(cases)('$city configured shared 2026 snapshot', sample => {
    it('loads the exact published namespace resource and binds without imported parcel tables', async () => {
        const base = parcelSourceCatalog.sources.find(source => source.id === 'jp-moj-geospatial-2026');
        const resource = base.snapshots.find(item => item.idNamespace.value === sample.code);
        const geometry = polygon(...sample.center);
        const fetchImpl = vi.fn(async url => {
            expect(url).toBe(resource.endpoint);
            const features = Array.from({ length: sample.count }, (_, i) => ({ type: 'Feature',
                properties: { 市区町村C: sample.code, 地図名: 'map~one', ID: 'H' + i, 地番: '21-1' },
                geometry: i === 0 ? geometry : polygon(resource.bbox[0] + .00001, resource.bbox[1] + .00001) }));
            return new Response(JSON.stringify({ type: 'FeatureCollection', features }), { headers: { ETag: resource.expectedEtag } });
        });
        vi.stubGlobal('fetch', fetchImpl);
        const provider = parcelSourceForCity(sample.city);
        expect(provider.descriptor.metricSrid).toBe(sample.metric);
        expect(provider.descriptor.idPrefix).toBe('JP-MOJ-2026-');
        const id = base.idPrefix + encodeSnapshotNativeId([sample.code, 'map~one', 'H0']);
        expect((await parcelSourceForIds([id]).adapter.queryIds([id])).features[0]).toMatchObject({ id });
        const bounds = [...sample.center.map(v => v - .0001), ...sample.center.map(v => v + .0001)];
        const visible = await provider.adapter.queryBounds(bounds);
        expect(visible.features.map(feature => feature.id)).toEqual([id]);
        const db = { query: vi.fn(() => { throw Error('Unexpected parcel-table read'); }) };
        const { binding } = await computeBinding(db, { city: sample.city, site: geometry });
        expect(binding).toMatchObject({ source: 'server:jp-moj-geospatial-2026', coverage: 'complete' });
        expect(binding.parcels.map(parcel => parcel.parcelId)).toEqual([id]);
        expect(db.query).not.toHaveBeenCalled();
        expect(fetchImpl).toHaveBeenCalledOnce();
    });
});
