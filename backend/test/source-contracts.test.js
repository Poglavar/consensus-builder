import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { encodeCustomSource, decodeCustomSource, decodeCustomBuildingSource } from '../parcels/custom-source-config.js';
import { encodeImagerySource, decodeImagerySource } from '../imagery/custom-source.js';
import { sourceSystemCatalogue } from '../routes/source-system.js';
import { parseAtlasSources } from '../planning/atlas-url-sources.js';
const require = createRequire(import.meta.url);
const Contracts = require('../../frontend/js/source-contracts.js');
const Runtime = require('../../frontend/js/source-runtime.js');
const Economics = require('../../frontend/js/economic-sources.js');
const Browser = require('../../frontend/js/browser-source-readers.js');

describe('published source contracts', () => {
    it('keeps portable parcel and building examples accepted by the real codecs', () => {
        for (const family of ['parcels', 'buildings']) for (const id of ['arcgis', 'wfs', 'ogc-api', 'socrata', 'geojson-snapshot', ...(family === 'buildings' ? ['overpass'] : [])]) {
            const contract = Contracts.adapter(family, id);
            const encoded = encodeCustomSource(contract.example);
            const resolved = (family === 'buildings' ? decodeCustomBuildingSource : decodeCustomSource)(encoded);
            expect(resolved.adapter).toBe(id);
            expect(resolved.idPrefix).toMatch(/^CUSTOM-/);
            expect(contract.example).not.toHaveProperty('idPrefix');
            expect(contract.configSchema.required).toContain('endpoint');
        }
    });
    it('keeps imagery, planning and economics examples accepted by domain validators', () => {
        for (const id of ['xyz', 'wms']) {
            const example = Contracts.adapter('imagery', id).example;
            expect(decodeImagerySource(encodeImagerySource(example)).adapter).toBe(id);
        }
        const plan = Contracts.adapter('planning', 'atlas-url').example;
        expect(parseAtlasSources(JSON.stringify([plan]))[0]).toEqual(plan);
        const rates = Contracts.adapter('economics', 'rate-table').example;
        expect(Economics.rateTable(rates).rates).toHaveLength(1);
    });
    it('runs browser examples through real readers with injected transport', async () => {
        const photon = Contracts.adapter('geocoding', 'photon').example;
        const payload = { type: 'FeatureCollection', features: [] };
        const reader = Browser.geocoding.open(Runtime.source('geocoding', 'photon', photon, { kind: 'custom' }));
        expect(await reader.search({ q: 'sample' }, { fetchImpl: async () => ({ ok: true, json: async () => payload }) })).toEqual(payload);
        const alignment = Contracts.adapter('transit-alignments', 'static-geojson').example;
        const transit = Browser.transit.open(Runtime.source('transit-alignments', 'static-geojson', alignment, { kind: 'custom' }));
        expect(await transit.load({ fetchImpl: async () => ({ ok: true, json: async () => payload }) })).toEqual(payload);
        const terrain = Contracts.adapter('terrain-profile', 'dgu-dtm-20m').example;
        const result = { source: terrain.source, datum: terrain.datum, points: [{ dM: 0, elevAslM: null }, { dM: 10, elevAslM: 3 }] };
        expect(Contracts.adapter('terrain-profile', 'dgu-dtm-20m').custom).toBe(true);
        expect(await Browser.terrain.open(Runtime.source('terrain-profile', 'dgu-dtm-20m', terrain, { kind: 'custom' })).profile({ coordinates: [[0, 0], [0, 1]], stepM: 10 }, {
            global: { location: { origin: 'https://example.org' } }, fetchImpl: async () => ({ ok: true, json: async () => result })
        })).toEqual(result);
    });
    it('describes native adapter operations rather than claiming normalized reader methods', () => {
        expect(Contracts.adapter('planning', 'gup')).toMatchObject({ custom: false });
        expect(Contracts.adapter('planning', 'gup-cache')).toMatchObject({ providerSpecific: true });
        expect(Contracts.adapter('parcels', 'oss-wfs').methods).toContain('bindingMeasurements');
        expect(Contracts.adapter('parcels', 'parcel-ba').methods).toEqual(['lookup']);
        expect(Contracts.adapter('buildings', 'gdi-map').operations.lookup.argumentList).toEqual(['query']);
        expect(Contracts.adapter('buildings', 'overture-pmtiles').methods).toEqual(['featuresIn']);
        expect(Contracts.adapter('parcels', 'dgu-live').operations.fetchBbox.input.properties.bbox.description).toContain('3765');
        expect(Contracts.adapter('ownership', 'hr-oss-public-fallback').custom).toBe(false);
    });
    it('covers every required method registered by the source-system endpoint', () => {
        for (const family of sourceSystemCatalogue().abstractions) for (const adapter of family.adapters) {
            const contract = Contracts.adapter(family.id, adapter.id);
            expect(contract, family.id + '/' + adapter.id).not.toBeNull();
            for (const implementation of adapter.implementations || [adapter]) for (const name of implementation.required) {
                expect(contract.operations?.[name] || family.contract?.operations?.[name], family.id + '/' + adapter.id + '.' + name).toBeTruthy();
            }
        }
    });
    it('returns detached metadata and standalone operation value schemas', () => {
        const first = Contracts.adapter('parcels', 'arcgis');
        first.example.outFields.push('modified');
        first.configSchema.required.push('modified');
        expect(Contracts.adapter('parcels', 'arcgis').example.outFields).toEqual(['record_id']);
        expect(Contracts.adapter('parcels', 'arcgis').configSchema.required).not.toContain('modified');
        const schemas = Contracts.schemas();
        expect(schemas.operations.$defs.parcels_queryBounds_input.required).toEqual(['bbox']);
        expect(schemas.operations.$defs.parcels_queryBounds_output.required).toEqual(['features']);
        expect(schemas.operations.$defs.buildings_footprintsUnder_output).toBeUndefined();
        expect(Contracts.abstraction('buildings').operations.footprintsUnder.outputSchema).toBe(null);
        schemas.operations.$defs.parcels_queryBounds_input.required.push('modified');
        expect(Contracts.schemas().operations.$defs.parcels_queryBounds_input.required).toEqual(['bbox']);
    });
});
