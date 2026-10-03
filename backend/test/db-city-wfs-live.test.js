// Existing imported city identities and live published keys must not be guessed or replaced with WFS row IDs.
import { describe, expect, it, vi } from 'vitest';
import { createLegacyCityWfsSource, legacyCityWfsDescriptors } from '../parcels/legacy-wfs-sources.js';
import { createWfsParcelSource } from '../parcels/wfs-source.js';
import { computeSourceBinding } from '../parcels/source-binding.js';
const cases = [
    { city: 'ljubljana', native: '100100000278024754', label: '153/34', bounds: [14.505, 46.05, 14.506, 46.051],
        fields: { PARCELA_ID: 27802475, KO_ID: 1728, ST_PARCELE: '153/34' }, canonical: 'SI-100100000278024754' },
    { city: 'buenos_aires', native: '02-012-003', label: '02-012-003', bounds: [-58.378, -34.614, -58.377, -34.613],
        fields: { gid: 2567 }, canonical: 'AR-CABA-WFS-NAM-02-012-003' }
];
function raw(sample, descriptor) {
    const [x,y] = sample.bounds;
    return { type: 'Feature', id: 'provider.transport-row', properties: { [descriptor.idField]: sample.native,
        ...sample.fields, owner: 'not retained' }, geometry: { type: 'Polygon', coordinates: [[[x,y],
            [x+.0001,y], [x+.0001,y+.0001], [x,y+.0001], [x,y]]] } };
}
function response(features, matched = features.length) {
    return new Response(JSON.stringify({ type: 'FeatureCollection', features, numberMatched: matched, numberReturned: features.length }));
}
describe.each(cases)('$city live alternative', sample => {
    it('retains the published native key and distinct display label through bounds, exact and footprint reads', async () => {
        const descriptor = legacyCityWfsDescriptors.find(source => source.cityIds.includes(sample.city));
        const feature = raw(sample, descriptor), fetchImpl = vi.fn(async () => response([feature]));
        const source = createLegacyCityWfsSource(sample.city, { fetchImpl });
        expect((await source.queryBounds(sample.bounds)).features[0]).toMatchObject({ id: sample.canonical,
            properties: { sourceParcelId: sample.native, parcelNumber: sample.label } });
        const exact = await source.queryIds([sample.canonical]);
        expect(exact.absentIds).toEqual([]);
        expect(exact.features[0].properties.sourceProperties).not.toHaveProperty('owner');
        const sql = new URL(fetchImpl.mock.calls.at(-1)[0]).searchParams.get('cql_filter');
        expect(sql).toBe(`${descriptor.idField} IN ('${sample.native}')`);
        expect((await source.queryGeometry(feature.geometry)).features[0].id).toBe(sample.canonical);
        const { binding } = await computeSourceBinding(source, { site: feature.geometry, sourceId: descriptor.id });
        expect(binding.coverage).toBe('complete');
        expect(binding.parcels.map(parcel => parcel.parcelId)).toEqual([sample.canonical]);
    });
    it('fails closed on incomplete pages, changing counts and conflicting native geometry', async () => {
        const base = legacyCityWfsDescriptors.find(source => source.cityIds.includes(sample.city));
        const feature = raw(sample, base);
        await expect(createWfsParcelSource(base, { fetchImpl: async () => response([], 1) }).queryBounds(sample.bounds))
            .rejects.toThrow(/incomplete/);
        const pages = [response([feature], 2), response([{ ...feature, id: 'other-row' }], 3)];
        await expect(createWfsParcelSource({ ...base, pageSize: 1 }, { fetchImpl: async () => pages.shift() }).queryBounds(sample.bounds))
            .rejects.toThrow(/changing|inconsistent/);
        const conflict = { ...feature, id: 'other-row', geometry: structuredClone(feature.geometry) };
        conflict.geometry.coordinates[0][1][0] += .00001;
        await expect(createWfsParcelSource(base, { fetchImpl: async () => response([feature, conflict]) }).queryBounds(sample.bounds))
            .rejects.toThrow(/conflicting/);
    });
    it('rejects a transport row key or invalid native field before accepting ground', async () => {
        const base = legacyCityWfsDescriptors.find(source => source.cityIds.includes(sample.city));
        const feature = raw(sample, base);delete feature.properties[base.idField];
        await expect(createWfsParcelSource(base, { fetchImpl: async () => response([feature]) }).queryBounds(sample.bounds))
            .rejects.toThrow(/native parcel ID/);
        const fetchImpl = vi.fn();
        await expect(createLegacyCityWfsSource(sample.city, { fetchImpl }).queryIds(['AR-002-012-003']))
            .rejects.toMatchObject({ status: 400 });
        expect(fetchImpl).not.toHaveBeenCalled();
    });
});

it.each(['02-014A-011E', '02-025Z-PLT1', '01-010B-0000', '02-053-0FRA'])('accepts published Buenos Aires code %s without normalizing it', async native => {
    const descriptor = legacyCityWfsDescriptors.find(source => source.cityIds.includes('buenos_aires'));
    const sample = { ...cases[1], native, label: native };
    const source = createLegacyCityWfsSource('buenos_aires', { fetchImpl: async () => response([raw(sample, descriptor)]) });
    const exact = await source.queryIds([`AR-CABA-WFS-NAM-${native}`]);
    expect(exact.features[0].properties.sourceParcelId).toBe(native);
});
