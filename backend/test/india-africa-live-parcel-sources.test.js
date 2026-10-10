// Keep Johannesburg's registered-stand source bound to the configured city and complete native parts.
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parcelSourceCatalog, parcelSourceForCity, parcelSourceForIds, clearParcelSourceRuntimeCache, createParcelSource } from '../parcels/sources.js';
import { computeBinding } from '../proposals/binding.js';

const root = new URL('../../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');
const sourceId = 'za-joburg-registered-stands';
const cityId = 'johannesburg';
const cityCases = [
    { city: 'johannesburg', source: sourceId, prefix: 'ZA-JOBURG-', srid: 32735, currency: 'ZAR' },
    { city: 'cosmo_city', source: sourceId, prefix: 'ZA-JOBURG-', srid: 32735, currency: 'ZAR' },
    { city: 'ennerdale', source: sourceId, prefix: 'ZA-JOBURG-', srid: 32735, currency: 'ZAR' },
    { city: 'accra', source: 'gh-ama-public-property-app', prefix: 'GH-AMA-', srid: 32630, currency: 'GHS' }
];
const sampleFixture = JSON.parse(read('world-parcels/research/india-africa-2026-10-08/root-joburg-bbox-response.json'));
const sampleFeature = sampleFixture.features[0];
const nativeId = sampleFeature.properties.SG_ID;
const parcelId = `ZA-JOBURG-${nativeId}`;
const descriptor = parcelSourceCatalog.sources.find(source => source.id === sourceId);

function shiftGeometry(geometry, longitudeDelta) {
    const shift = coordinate => Array.isArray(coordinate[0])
        ? coordinate.map(shift)
        : [coordinate[0] + longitudeDelta, coordinate[1], ...coordinate.slice(2)];
    return { ...geometry, coordinates: shift(geometry.coordinates) };
}

function fixtureRows({ overlap = false, mismatch = null } = {}) {
    const first = structuredClone(sampleFeature);
    first.id = first.properties.OBJECTID = 101;
    const second = structuredClone(first);
    second.id = second.properties.OBJECTID = 102;
    second.geometry = shiftGeometry(first.geometry, overlap ? 0.00005 : 0.001);
    if (mismatch) second.properties[mismatch] = `${second.properties[mismatch]}-different`;
    // Model requested ArcGIS outFields even where the saved, privacy-safe sample omitted a null.
    for (const row of [first, second]) {
        for (const field of descriptor.outFields) if (!Object.hasOwn(row.properties, field)) row.properties[field] = null;
    }
    return [first, second];
}

function featureBbox(feature) {
    const points = [];
    const visit = value => {
        if (Array.isArray(value) && typeof value[0] === 'number' && typeof value[1] === 'number') points.push(value);
        else if (Array.isArray(value)) value.forEach(visit);
    };
    visit(feature.geometry.coordinates);
    return [Math.min(...points.map(point => point[0])), Math.min(...points.map(point => point[1])),
        Math.max(...points.map(point => point[0])), Math.max(...points.map(point => point[1]))];
}

function sourceResponse(rows, calls) {
    return vi.fn(async (input, options = {}) => {
        const url = new URL(typeof input === 'string' ? input : input.url);
        const params = options.method === 'POST' ? new URLSearchParams(options.body) : url.searchParams;
        calls.push({ url, params });
        const matches = rows.filter(row => {
            if (params.has('objectIds')) return params.get('objectIds').split(',').includes(String(row.properties.OBJECTID));
            if (params.has('geometry')) {
                const query = params.get('geometry').split(',').map(Number);
                const bounds = featureBbox(row);
                return bounds[0] <= query[2] && bounds[2] >= query[0] && bounds[1] <= query[3] && bounds[3] >= query[1];
            }
            const where = params.get('where') || '';
            return where.includes(`'${nativeId}'`);
        });
        if (params.has('returnCountOnly')) {
            return Response.json({ count: matches.length });
        }
        if (params.has('returnIdsOnly')) {
            return Response.json({ objectIdFieldName: descriptor.objectIdField,
                objectIds: matches.map(row => row.properties[descriptor.objectIdField]) });
        }
        return Response.json({ type: 'FeatureCollection', features: matches, exceededTransferLimit: false });
    });
}

afterEach(() => {
    vi.unstubAllGlobals();
    clearParcelSourceRuntimeCache();
});

describe('configured India/Africa live parcel cities', () => {
    it.each(cityCases)('$city resolves its published source, projection, currency and four locale labels', sample => {
        const provider = parcelSourceForCity(sample.city);
        expect(provider).not.toBeNull();
        expect(provider.descriptor).toMatchObject({ id: sample.source, idPrefix: sample.prefix, metricSrid: sample.srid });
        expect(parcelSourceForIds([sample.prefix + 'sample-native-id']).descriptor.id).toBe(sample.source);

        const context = { console, URL, URLSearchParams }; context.window = context;
        runInNewContext(read('frontend/js/city-config.js'), context);
        const city = context.CityConfigManager.getCityConfig(sample.city);
        expect(city.parcels).toMatchObject({ sourceId: sample.source, idPrefix: sample.prefix, ownership: false });
        expect(city.projection.metricCrs).toBeUndefined();
        expect(city.currency.code).toBe(sample.currency);
        for (const locale of ['en', 'es', 'hr', 'sr']) {
            expect(JSON.parse(read(`frontend/i18n/${locale}.json`)).city.labels[sample.city]).toBeTruthy();
        }
    });

    it('keeps Johannesburg registered stand grouping fields and object-ID query modes explicit', () => {
        expect(descriptor).toMatchObject({
            id: sourceId, idPrefix: 'ZA-JOBURG-', metricSrid: 32735, idField: 'SG_ID', idType: 'string',
            nativeGeometryMode: 'parts', disjointParts: true,
            boundsQueryMode: 'object-ids', idsQueryMode: 'object-ids',
            partMatchFields: ['PROPERTY_ID', 'STAND_NO', 'STATUS_DESC']
        });
        expect(parcelSourceForIds([parcelId]).descriptor.id).toBe(sourceId);
    });

    it('returns the same complete stand through viewport, exact-ID and binding reads without parcel SQL', async () => {
        const rows = fixtureRows();
        const calls = [];
        const fetchImpl = sourceResponse(rows, calls);
        const source = createParcelSource(descriptor, { fetchImpl });
        const [west, south, east, north] = featureBbox(sampleFeature);
        const viewport = await source.queryBounds([west - 0.00001, south - 0.00001, east + 0.00001, north + 0.00001]);
        const exact = await source.queryIds([parcelId]);

        for (const result of [viewport, exact]) {
            expect(result.complete).toBe(true);
            expect(result.features).toHaveLength(1);
            expect(result.features[0].id).toBe(parcelId);
            expect(result.features[0].properties).toMatchObject({ sourceParcelId: nativeId, sourcePartCount: 2 });
            expect(result.features[0].properties.sourceProperties).toMatchObject({
                PROPERTY_ID: sampleFeature.properties.PROPERTY_ID,
                STAND_NO: sampleFeature.properties.STAND_NO,
                STATUS_DESC: sampleFeature.properties.STATUS_DESC
            });
            expect(result.features[0].geometry.type).toBe('MultiPolygon');
            expect(result.features[0].geometry.coordinates).toHaveLength(2);
        }
        expect(viewport).toMatchObject({ sourceRows: 2, viewportSourceRows: 1 });
        expect(exact.absentIds).toEqual([]);
        expect(exact.features).toEqual(viewport.features);

        const db = { query: vi.fn(async () => { throw new Error('Live source binding must not read imported parcel tables.'); }) };
        vi.stubGlobal('fetch', fetchImpl);
        const { binding } = await computeBinding(db, { city: cityId, site: sampleFeature.geometry, toleranceM: 0 });
        expect(db.query).not.toHaveBeenCalled();
        expect(binding).toMatchObject({ coverage: 'complete', source: `server:${sourceId}` });
        expect(binding.parcels.map(parcel => parcel.parcelId)).toContain(parcelId);

        const whereReads = calls.filter(call => (call.params.get('where') || '').includes('SG_ID IN'));
        expect(whereReads.length).toBeGreaterThan(0);
        for (const call of whereReads) expect(call.params.get('where')).toContain(`SG_ID IN ('${nativeId}')`);
        expect(calls.some(call => call.params.has('returnCountOnly'))).toBe(true);
        expect(calls.some(call => call.params.has('returnIdsOnly'))).toBe(true);
    });

    it('rejects overlapping components for one SG_ID', async () => {
        const overlapSource = createParcelSource(descriptor, { fetchImpl: sourceResponse(fixtureRows({ overlap: true }), []) });
        await expect(overlapSource.queryIds([parcelId])).rejects.toMatchObject({
            status: 502, cause: expect.objectContaining({ message: 'Parcel components overlap.' })
        });
    });

    it.each(['PROPERTY_ID', 'STAND_NO', 'STATUS_DESC'])('rejects parts whose %s reference conflicts for one SG_ID', async field => {
        const mismatchSource = createParcelSource(descriptor, {
            fetchImpl: sourceResponse(fixtureRows({ mismatch: field }), [])
        });
        await expect(mismatchSource.queryIds([parcelId])).rejects.toThrow(/inconsistent administrative references/i);
    });

    it('binds Accra from the exact public selector after merging the first complete two-row PID group', async () => {
        const accraSourceId = 'gh-ama-public-property-app';
        const accraDescriptor = parcelSourceCatalog.sources.find(source => source.id === accraSourceId);
        const snapshot = JSON.parse(read('world-parcels/research/india-africa-integration-2026-10-08/accra-3336-duplicate-group-samples.json'));
        const firstGroup = snapshot.features.filter(feature => feature.properties.parcelid === 'AMAAW67819');
        expect(firstGroup).toHaveLength(2);
        const accraParcelId = 'GH-AMA-AMAAW67819';
        const calls = [];
        const fetchImpl = vi.fn(async (url, options = {}) => {
            calls.push({ url, options });
            return new Response(JSON.stringify(snapshot), { status: 200,
                headers: { 'Content-Type': 'application/geo+json', 'Content-Length': String(Buffer.byteLength(JSON.stringify(snapshot))) } });
        });
        vi.stubGlobal('fetch', fetchImpl);
        const provider = parcelSourceForCity('accra');
        expect(provider.descriptor).toMatchObject({
            id: accraSourceId, idPrefix: 'GH-AMA-', metricSrid: 32630,
            requestForm: { tbl: 'parcel', flds: 'parcelid,parcelcode' },
            idFields: ['parcelid'], outFields: ['parcelid', 'parcelcode'],
            nativeGeometryMode: 'parts', disjointParts: true, partMatchFields: ['parcelcode']
        });

        const exact = await provider.adapter.queryIds([accraParcelId]);
        expect(exact.complete).toBe(true);
        expect(exact.absentIds).toEqual([]);
        expect(exact.features).toHaveLength(1);
        expect(exact.features[0].properties).toMatchObject({ parcelId: accraParcelId, sourceParcelId: 'AMAAW67819', sourcePartCount: 2 });
        expect(exact.features[0].properties.sourceProperties).toEqual({ parcelid: 'AMAAW67819', parcelcode: '19AW054' });
        expect(exact.features[0].geometry.type).toMatch(/Polygon/);

        const db = { query: vi.fn(async () => { throw new Error('Live source binding must not read imported parcel tables.'); }) };
        const { binding } = await computeBinding(db, { city: 'accra', site: firstGroup[0].geometry, toleranceM: 0 });
        expect(db.query).not.toHaveBeenCalled();
        expect(binding).toMatchObject({ coverage: 'complete', source: `server:${accraSourceId}` });
        expect(binding.parcels.map(parcel => parcel.parcelId)).toContain(accraParcelId);
        expect(fetchImpl).toHaveBeenCalledOnce();
        const [{ url, options }] = calls;
        expect(url).toBe(accraDescriptor.endpoint);
        expect(options.method).toBe('POST');
        expect(options.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
        const form = new URLSearchParams(options.body);
        expect(Object.fromEntries(form)).toEqual({ tbl: 'parcel', flds: 'parcelid,parcelcode' });
        expect(form.get('flds')).not.toMatch(/owner/i);
    });

});
