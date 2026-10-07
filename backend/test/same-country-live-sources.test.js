// Route, identity, binding and locale contracts for four newly configured city parcel sources.
import express from 'express';
import request from 'supertest';
import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { createRequire } from 'node:module';
import proj4 from 'proj4';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as parcelSources from '../parcels/sources.js';
import { clearParcelSourceRuntimeCache, createParcelSource, parcelSourceCatalog, parcelSourceForIds } from '../parcels/sources.js';
import { setupParcelSourcesRoute } from '../routes/parcel-sources.js';
import { computeBinding } from '../proposals/binding.js';

const samples = [
    { city: 'houston', sourceId: 'us-tx-harris-hcad-parcels', centerLatLon: [29.7604, -95.3698], native: '0000000000001', fields: { acct_num: 'SYNTH-ACCOUNT-1' } },
    { city: 'curitiba', sourceId: 'br-curitiba-ippuc-lote-cadastral', centerLatLon: [-25.429, -49.273], native: '11150008', fields: { gtm_cod_lote: 12345, gtm_cod_quadra: '01115' } },
    { city: 'recife', sourceId: 'br-recife-prefeitura-lotes', centerLatLon: [-8.04622135042311, -34.9207751899257], native: '01020304050607', fields: { DISTRITO: 1, SETOR: 2, QUADRA: 3, FACE: 4, LOTE: 5 } },
    { city: 'durban', sourceId: 'za-ethekwini-cadastral-parcels', centerLatLon: [-29.8585, 31.0218], native: '{11111111-2222-3333-4444-555555555555}', display: 'SYNTH-PROPERTY-1', fields: { PROPKEY: 12345 } }
];
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const context = { URL, URLSearchParams, console }; context.window = context;
runInContext(read('../../frontend/js/city-config.js'), createContext(context));
const cities = context.CityConfigManager;
const require = createRequire(import.meta.url);
const route = require('../../frontend/js/parcels/route.js');
const descriptorFor = sample => parcelSourceCatalog.sources.find(source => source.id === sample.sourceId);
const pointFor = sample => [sample.centerLatLon[1], sample.centerLatLon[0]];
const polygon = (center, dx = 0, size = 0.0001) => ({
    type: 'Polygon',
    coordinates: [[[center[0] + dx, center[1]], [center[0] + dx + size, center[1]],
        [center[0] + dx + size, center[1] + size], [center[0] + dx, center[1] + size], [center[0] + dx, center[1]]]]
});
function propertiesFor(sample, descriptor, objectId) {
    const properties = {};
    for (const field of descriptor.outFields) {
        if (field === descriptor.objectIdField) properties[field] = objectId;
        else if (field === descriptor.idField) properties[field] = sample.native;
        else if (field === descriptor.parcelNumberField) properties[field] = sample.display;
        else if (Object.hasOwn(sample.fields, field)) properties[field] = sample.fields[field];
        else properties[field] = `SYNTHETIC-${field}`;
    }
    for (const [field, value] of Object.entries(descriptor.attributeFilters || {})) {
        properties[field] = Array.isArray(value) ? value[0] : value;
    }
    for (const field of descriptor.attributeNotNull || []) {
        if (properties[field] === undefined || properties[field] === null) properties[field] = `SYNTHETIC-${field}`;
    }
    for (const field of descriptor.attributeNull || []) properties[field] = null;
    for (const [field, rawValues] of Object.entries(descriptor.attributeExclusions || {})) {
        const values = Array.isArray(rawValues) ? rawValues : [rawValues];
        if (values.includes(properties[field])) properties[field] = 'SYNTHETIC-ALLOWED';
    }
    // This field models data that a service might expose but that the descriptor must not request.
    properties.OWNER_NAME = 'Synthetic owner value';
    return properties;
}
function fixture(sample, descriptor) {
    const center = pointFor(sample);
    const firstGeometry = polygon(center);
    const isParts = descriptor.nativeGeometryMode === 'parts';
    const rows = [{ type: 'Feature', id: 101, properties: propertiesFor(sample, descriptor, 101), geometry: firstGeometry }];
    const geometries = [firstGeometry];
    if (isParts) {
        const secondGeometry = polygon(center, 0.00035);
        rows.push({ type: 'Feature', id: 102, properties: propertiesFor(sample, descriptor, 102), geometry: secondGeometry });
        geometries.push(secondGeometry);
    }
    const site = isParts
        ? { type: 'MultiPolygon', coordinates: geometries.map(geometry => geometry.coordinates) }
        : firstGeometry;
    const bounds = [center[0] - 0.001, center[1] - 0.001, center[0] + 0.001, center[1] + 0.001];
    const calls = [];
    const fetchImpl = vi.fn(async (input, options = {}) => {
        const url = new URL(typeof input === 'string' ? input : input.url);
        const params = options.method === 'POST' ? new URLSearchParams(options.body) : url.searchParams;
        calls.push({ url, params });
        const where = params.get('where') || '';
        for (const field of descriptor.attributeNotNull || []) expect(where).toContain(`${field} IS NOT NULL`);
        for (const field of descriptor.attributeNull || []) expect(where).toContain(`${field} IS NULL`);
        for (const [field, rawValues] of Object.entries(descriptor.attributeFilters || {})) {
            expect(where).toContain(field);
            for (const value of Array.isArray(rawValues) ? rawValues : [rawValues]) expect(where).toContain(`'${String(value).replaceAll("'", "''")}'`);
        }
        for (const [field, rawValues] of Object.entries(descriptor.attributeExclusions || {})) {
            expect(where).toContain(field);
            for (const value of Array.isArray(rawValues) ? rawValues : [rawValues]) expect(where).toContain(`'${String(value).replaceAll("'", "''")}'`);
        }
        const returned = params.has('objectIds')
            ? rows.filter(row => params.get('objectIds').split(',').includes(String(row.properties[descriptor.objectIdField])))
            : rows;
        const response = params.has('returnCountOnly') ? { count: returned.length }
            : params.has('returnIdsOnly') ? { objectIdFieldName: descriptor.objectIdField,
                objectIds: returned.map(row => row.properties[descriptor.objectIdField]) }
                : { type: 'FeatureCollection', features: returned, exceededTransferLimit: false };
        return new Response(JSON.stringify(response), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    return { center, rows, site, bounds, calls, fetchImpl, id: descriptor.idPrefix + sample.native };
}
afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    clearParcelSourceRuntimeCache();
});

describe.each(samples)('$city live parcel source contract', sample => {
    it('serves bounded, native-ID and footprint requests with canonical identity and safe properties', async () => {
        const descriptor = descriptorFor(sample);
        expect(descriptor).toBeTruthy();
        const f = fixture(sample, descriptor);
        expect(parcelSourceForIds([f.id]).descriptor.id).toBe(sample.sourceId);
        const app = express(); app.use(express.json());
        setupParcelSourcesRoute(app, { sources: [descriptor], fetchImpl: f.fetchImpl });
        const path = `/parcel-sources/${descriptor.id}`;
        const viewport = await request(app).get(path).query({ bbox: f.bounds.join(',') });
        const exact = await request(app).get(path).query({ ids: f.id });
        const footprint = await request(app).post(`${path}/under`).send({ geometry: f.site, srid: 4326 });
        for (const result of [viewport, exact, footprint]) {
            expect(result.status).toBe(200);
            expect(result.body.complete).toBe(true);
            expect(result.body.features.map(feature => feature.id)).toEqual([f.id]);
            expect(result.body.features[0].properties).toMatchObject({ parcelId: f.id, sourceParcelId: sample.native });
            expect(Object.keys(result.body.features[0].properties.sourceProperties).sort())
                .toEqual(descriptor.outFields.filter(field => field in f.rows[0].properties).sort());
            expect(result.body.features[0].properties.sourceProperties).not.toHaveProperty('OWNER_NAME');
        }
        expect(exact.body.absentIds).toEqual([]);
        expect(exact.body.features).toEqual(viewport.body.features);
        if (descriptor.nativeGeometryMode === 'parts') {
            expect(viewport.body.features[0].properties.sourcePartCount).toBe(2);
            expect(viewport.body.features[0].geometry.type).toBe('MultiPolygon');
        }
        expect(f.calls.every(call => call.url.pathname === `${new URL(descriptor.endpoint).pathname}/query`)).toBe(true);
        expect(f.calls.every(call => call.params.get('f') === 'json' || call.params.get('f') === 'geojson')).toBe(true);
        expect(f.calls.some(call => call.params.has('returnIdsOnly'))).toBe(true);
        expect(f.calls.some(call => call.params.get('where')?.includes(`${descriptor.idField} IN (`))).toBe(true);
    });

    it('binds from the configured source without parcel-table reads and preserves city routing, metric projection and translations', async () => {
        const descriptor = descriptorFor(sample);
        const f = fixture(sample, descriptor);
        expect(parcelSources.parcelSourceForCity(sample.city).descriptor.id).toBe(sample.sourceId);
        const adapter = createParcelSource(descriptor, { fetchImpl: f.fetchImpl });
        const lookup = vi.spyOn(parcelSources, 'parcelSourceForCity').mockReturnValue({ descriptor, adapter });
        const db = { query: vi.fn(async () => { throw new Error('Live parcel source binding must not read parcel tables.'); }) };
        const { binding } = await computeBinding(db, { city: sample.city, site: f.site, toleranceM: 0 });
        expect(lookup).toHaveBeenCalledWith(sample.city, null);
        expect(db.query).not.toHaveBeenCalled();
        expect(binding).toMatchObject({ coverage: 'complete', source: `server:${descriptor.id}` });
        expect(binding.parcels.map(parcel => parcel.parcelId)).toEqual([f.id]);

        const previous = globalThis.CityConfigManager; globalThis.CityConfigManager = cities;
        try {
            expect(route.parcelIdToCityId(f.id)).toBe(sample.city);
        } finally {
            if (previous === undefined) delete globalThis.CityConfigManager;
            else globalThis.CityConfigManager = previous;
        }
        const city = cities.getCityConfig(sample.city);
        expect(city.parcels.sourceId).toBe(descriptor.id);
        const projected = proj4('EPSG:4326', city.projection.metricDefinition, f.center);
        const restored = proj4(city.projection.metricDefinition, 'EPSG:4326', projected);
        restored.forEach((coordinate, index) => expect(coordinate).toBeCloseTo(f.center[index], 8));
        for (const locale of ['en', 'es', 'hr', 'sr']) {
            expect(JSON.parse(read(`../../frontend/i18n/${locale}.json`)).city.labels[sample.city]).toBeTruthy();
        }
    });
});

describe('Durban source CA certificate', () => {
    it('loads the configured Sectigo CA certificate with the expected fingerprint', () => {
        const descriptor = descriptorFor(samples.find(sample => sample.city === 'durban'));
        expect(descriptor.caCertificate).toBe('./certificates/sectigo-public-server-authentication-ca-dv-r36.pem');
        const certificate = new X509Certificate(readFileSync(new URL(`../parcels/${descriptor.caCertificate}`, import.meta.url)));
        expect(certificate.ca).toBe(true);
        expect(certificate.subject).toContain('Sectigo Public Server Authentication CA DV R36');
        expect(certificate.issuer).toContain('Sectigo Public Server Authentication Root R46');
        expect(certificate.fingerprint256.replaceAll(':', '')).toBe('8C54C334B66BA4E426772AF4A3F9136C19A1AEC729FDB28C535C07A5A4EF22E0');
    });
});
