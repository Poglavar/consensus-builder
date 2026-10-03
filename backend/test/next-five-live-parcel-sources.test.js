// Checks new city sources through their configured adapter, exact identity and native provenance.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createParcelSource, parcelSourceForCity } from '../parcels/sources.js';
import { computeBinding } from '../proposals/binding.js';
import { encodeSnapshotNativeId } from '../parcels/geojson-snapshot-source.js';
afterEach(() => vi.unstubAllGlobals());

const cases = [
    { city: 'sydney', source: 'au-nsw-six-cadastre-lot', srid: 32756, native: 100098447,
        prefix: 'AU-NSW-', label: '9//DP11050', bounds: [151.078, -33.86, 151.081, -33.857] },
    { city: 'sao_paulo', source: 'br-sp-geosampa-lote-cidadao', srid: 32723, native: 1958754,
        prefix: 'BR-SP-GEOSAMPA-', label: '0001', bounds: [-46.635, -23.552, -46.632, -23.549] },
    { city: 'birmingham', source: 'gb-arcgis-geodom-land-registry-inspire-2021', srid: 32630,
        native: '43509130', prefix: 'GB-HMLR-', label: '43509130', bounds: [-1.98, 52.4975, -1.9775, 52.5] },
    { city: 'lusaka', source: 'zm-lusaka-mtendere-east-agol-unofficial', srid: 32735,
        native: '11111111-2222-3333-4444-555555555555', prefix: 'ZM-LUSAKA-GID-', label: '42', bounds: [28.379, -15.406, 28.382, -15.403] },
    { city: 'osaka', source: 'jp-moj-geospatial-2026', srid: 32653,
        components: ['27128', 'sheet~1', 'H000000001'], prefix: 'JP-MOJ-2026-', label: '21-1', bounds: [135.5, 34.68, 135.503, 34.683] }
];
function fixture(descriptor, sample) {
    const [west, south] = sample.bounds;
    const geometry = { type: 'Polygon', coordinates: [[[west, south], [west + .0001, south],
        [west + .0001, south + .0001], [west, south + .0001], [west, south]]] };
    const properties = {
        ...(descriptor.idFields ? Object.fromEntries(descriptor.idFields.map((field, i) => [field, sample.components[i]]))
            : { [descriptor.idField]: sample.native }),
        ...(descriptor.parcelNumberField ? { [descriptor.parcelNumberField]: sample.label } : {}),
        ...(descriptor.objectIdField ? { [descriptor.objectIdField]: 123 } : {}),
        ...(sample.city === 'sao_paulo' ? { cd_identificador_original_lote: 7654321 } : {}) };
    const raw = { type: 'Feature', id: 'transport.123', properties, geometry };
    const features = [raw];
    // A pinned snapshot has an expected full collection size; other synthetic native IDs live far from the test footprint.
    for (let i = 1; i < (descriptor.expectedSnapshotFeatures || 1); i++) features.push({ ...raw,
        properties: { ...properties, [descriptor.idFields[2]]: 'other' + i },
        geometry: { type: 'Polygon', coordinates: [[[140, 35], [140.0001, 35], [140.0001, 35.0001], [140, 35.0001], [140, 35]]] } });
    const fetchImpl = vi.fn(async (url, options) => {
        const params = options?.method === 'POST' ? new URLSearchParams(options.body) : new URL(url).searchParams;
        const payload = params.has('returnCountOnly') ? { count: 1 }
            : params.has('returnIdsOnly') ? { objectIdFieldName: descriptor.objectIdField, objectIds: [123] }
                : { type: 'FeatureCollection', features, numberMatched: features.length, numberReturned: features.length, exceededTransferLimit: false };
        return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json',
            ...(descriptor.expectedEtag ? { ETag: descriptor.expectedEtag } : {}) } });
    });
    const native = sample.components ? encodeSnapshotNativeId(sample.components) : String(sample.native);
    return { raw, fetchImpl, native, id: sample.prefix + native };
}
describe.each(cases)('$city configured live source', sample => {
    it('keeps native parcel identity distinct from source row identity and display labels', async () => {
        const { descriptor } = parcelSourceForCity(sample.city);
        expect(descriptor.id).toBe(sample.source);
        expect(descriptor.metricSrid).toBe(sample.srid);
        const { fetchImpl, id, native } = fixture(descriptor, sample);
        const adapter = createParcelSource(descriptor, { fetchImpl });
        const bounds = await adapter.queryBounds(sample.bounds);
        expect(bounds.features[0]).toMatchObject({ id,
            properties: { sourceParcelId: native, parcelNumber: sample.label } });
        const exact = await adapter.queryIds([id]);
        expect(exact.absentIds).toEqual([]);
        expect(exact.features).toEqual(bounds.features);
        if (sample.city === 'sao_paulo') {
            expect(exact.features[0].properties.sourceProperties.cd_identificador_original_lote).toBe(7654321);
            expect(new URL(fetchImpl.mock.calls.at(-1)[0]).searchParams.get('cql_filter')).toContain('cd_identificador');
        }
        if (sample.city === 'birmingham') {
            expect(descriptor.dataVersion).toBe('2021-10-22');
            expect(descriptor.attributeExclusions).toEqual({ INSPIREID: ['No LR Title Detected'] });
            for (const [url] of fetchImpl.mock.calls) {
                expect(new URL(url).searchParams.get('where')).toContain("INSPIREID <> 'No LR Title Detected'");
            }
        }
        if (sample.city === 'lusaka') {
            expect(descriptor.idField).toBe('GlobalID');
            expect(descriptor.objectIdField).toBe('FID');
            expect(descriptor.idQueryBraces).toBe(true);
        }
        if (sample.city === 'osaka') {
            expect(descriptor.dataVersion).toBe('2026');
            expect(descriptor.expectedSnapshotFeatures).toBe(2487);
            expect(descriptor.idFields).toEqual(['市区町村C', '地図名', 'ID']);
            expect(native).toBe('27128~sheet%7E1~H000000001');
            expect(fetchImpl).toHaveBeenCalledOnce();
        }
    });
    it('binds the footprint through the chosen source without imported parcel tables', async () => {
        const { descriptor } = parcelSourceForCity(sample.city);
        const { raw, fetchImpl, id } = fixture(descriptor, sample);
        vi.stubGlobal('fetch', fetchImpl);
        const db = { query: vi.fn(async () => { throw Error('Unexpected parcel database read'); }) };
        const { binding } = await computeBinding(db, { city: sample.city, site: raw.geometry });
        expect(db.query).not.toHaveBeenCalled();
        expect(binding).toMatchObject({ coverage: 'complete', source: 'server:' + descriptor.id });
        expect(binding.parcels.map(p => p.parcelId)).toEqual([id]);
    });
});
