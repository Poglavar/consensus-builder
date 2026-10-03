// ANDF NUP is the stable parcel key; local labels and WFS row IDs never replace it.
import { describe, expect, it, vi } from 'vitest';
import { createWfsParcelSource } from '../parcels/wfs-source.js';
import { computeSourceBinding } from '../parcels/source-binding.js';
import { parcelSourceForCity } from '../parcels/sources.js';
const descriptor = { id: 'bj-andf-efoncier-geoserver', adapter: 'wfs', endpoint: 'https://geoserver.andf.bj/geoserver/efb/wfs',
    featureType: 'efb:efb_parcel', idField: 'nup', idType: 'string', idPrefix: 'BJ-ANDF-', idPattern: '^[0-9]+$',
    parcelNumberField: 'local_parcel_identification', outFields: ['nup', 'local_parcel_identification', 'commune_name'],
    pageSize: 500, maxFeatures: 10000, maxBboxKm2: 25, metricSrid: 32631 };
const geometry = { type: 'Polygon', coordinates: [[[2.3895, 6.3864], [2.3896, 6.3864],
    [2.3896, 6.3865], [2.3895, 6.3865], [2.3895, 6.3864]]] };
const raw = { type: 'Feature', id: 'efb_parcel.transport-row', geometry,
    properties: { nup: '001413974', local_parcel_identification: 'display-42', commune_name: 'Cotonou', owner: 'not retained' } };
function fetcher(feature = raw) { return vi.fn(async () => new Response(JSON.stringify({
    type: 'FeatureCollection', features: [feature], numberMatched: 1, numberReturned: 1
}))); }
describe('Cotonou live NUP parcels', () => {
    it('resolves the configured official provider without claiming national completeness', () => {
        const configured = parcelSourceForCity('cotonou').descriptor;
        expect(configured).toMatchObject({ id: descriptor.id, idField: 'nup', idPrefix: 'BJ-ANDF-',
            idType: 'string', parcelNumberField: 'local_parcel_identification', metricSrid: 32631 });
        expect(configured.scope).toContain('national completeness are unverified');
        expect(configured.licenceNote).toContain('service defaults');
    });
    it('retains exact native string keys including leading zeroes and separate display metadata', async () => {
        const fetchImpl = fetcher(), source = createWfsParcelSource(descriptor, { fetchImpl });
        const exact = await source.queryIds(['BJ-ANDF-001413974']);
        expect(exact).toMatchObject({ complete: true, absentIds: [] });
        expect(exact.features[0]).toMatchObject({ id: 'BJ-ANDF-001413974', properties: {
            sourceParcelId: '001413974', parcelNumber: 'display-42', sourceId: descriptor.id } });
        const url = new URL(fetchImpl.mock.calls[0][0]);
        expect(url.searchParams.get('cql_filter')).toBe("nup IN ('001413974')");
        expect(exact.features[0].properties.sourceProperties).not.toHaveProperty('owner');
    });
    it('returns complete bounds and footprint reads, and authoritative source binding', async () => {
        const source = createWfsParcelSource(descriptor, { fetchImpl: fetcher() });
        expect((await source.queryBounds([2.3894, 6.3863, 2.3897, 6.3866])).features).toHaveLength(1);
        expect((await source.queryGeometry(geometry)).features[0].id).toBe('BJ-ANDF-001413974');
        const { binding } = await computeSourceBinding(source, { site: geometry, sourceId: descriptor.id });
        expect(binding).toMatchObject({ coverage: 'complete', source: 'server:' + descriptor.id });
        expect(binding.parcels.map(parcel => parcel.parcelId)).toEqual(['BJ-ANDF-001413974']);
    });
    it('rejects missing native NUP rather than replacing it with a row key', async () => {
        const source = createWfsParcelSource(descriptor, { fetchImpl: fetcher({ ...raw, properties: { local_parcel_identification: '42' } }) });
        await expect(source.queryBounds([2.3894, 6.3863, 2.3897, 6.3866])).rejects.toThrow(/identity|ID/i);
    });
});
