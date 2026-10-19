import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import proj4 from 'proj4';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createCadastralParcelRepository } = require('../../frontend/js/parcels/ground-service.js');
const projectionDefinition = '+proj=tmerc +lat_0=0 +lon_0=16.5 +k=0.9999 +x_0=500000 +y_0=0 +ellps=GRS80 +units=m +no_defs';
proj4.defs('EPSG:3765', projectionDefinition);

function loadGeometry(options = {}) {
    const window = {
        proj4: options.proj4 || proj4,
        CityConfigManager: { datasetToLatLng: options.datasetToLatLng || (() => [0, 0]) },
        datasetToWgs84: options.datasetToWgs84 || (() => [0, 0]),
        __metricFrame: { frameFor: () => ({ latLngToMetric: (lat, lon) => [lon, lat] }) }
    };
    const context = vm.createContext({ window, console, setTimeout });
    vm.runInContext(readFileSync(new URL('../../frontend/js/parcels/utils/geometry.js', import.meta.url), 'utf8'), context);
    return window;
}

function polygonFeature(coords, id = 'HR-TEST') {
    return { type: 'Feature', properties: { parcelId: id }, geometry: { type: 'Polygon', coordinates: [[
        coords, [coords[0] + 10, coords[1]], [coords[0] + 10, coords[1] + 10], coords
    ]] } };
}

function loadOssTransport(responseFeatures = []) {
    const window = {
        fetch: async () => ({ ok: true, status: 200, json: async () => ({ features: responseFeatures, numberReturned: responseFeatures.length }) }),
        getCurrentDataSource: () => 'oss.uredjenazemlja.hr',
        getCurrentCityId: () => 'oss-test-city',
        CityConfigManager: { getCurrentCityId: () => 'oss-test-city', getCityConfig: () => ({ id: 'oss-test-city', parcels: { source: 'oss-wfs', gridSize: 500 } }),
            datasetToLatLng: (e, n) => [n / 100000, e / 100000] },
        buildParcelRequestParams: () => ({ url: 'https://example.invalid/wfs', isOSS: true })
    };
    const context = vm.createContext({ window, fetch: window.fetch, URL, URLSearchParams, console, setTimeout, AbortController });
    vm.runInContext(readFileSync(new URL('../../frontend/js/parcels/fetch.js', import.meta.url), 'utf8'), context);
    return window.__cadastralGroundTransport;
}

describe('parcel coordinate context', () => {
    it('uses an explicit EPSG:3765 definition regardless of active city projection', () => {
        const control = [15.981, 45.811];
        const native = proj4('EPSG:4326', 'EPSG:3765', control);
        const activeCityConversion = vi.fn(() => [-30, 120]);
        const window = loadGeometry({ datasetToLatLng: activeCityConversion });
        const result = window.convertGeoJSON({ type: 'FeatureCollection', features: [polygonFeature(native)] }, { sourceSrid: 'EPSG:3765', city: 'belgrade' });
        const output = result.features[0].geometry.coordinates[0][0];
        expect(output[0]).toBeCloseTo(control[0], 7);
        expect(output[1]).toBeCloseTo(control[1], 7);
        expect(activeCityConversion).not.toHaveBeenCalled();
    });

    it('fails closed for an explicit transform failure without trying legacy converters', () => {
        const failingProj4 = Object.assign(() => { throw new Error('grid unavailable'); }, { defs: proj4.defs });
        const fallback = vi.fn(() => [45, 16]);
        const active = vi.fn(() => [45, 16]);
        const window = loadGeometry({ proj4: failingProj4, datasetToLatLng: active, datasetToWgs84: fallback });
        expect(() => window.convertGeoJSON({ type: 'FeatureCollection', features: [polygonFeature([500000, 5070000])] }, { sourceSrid: 'EPSG:3765' }))
            .toThrow(/grid unavailable/);
        expect(active).not.toHaveBeenCalled();
        expect(fallback).not.toHaveBeenCalled();
    });

    it('leaves explicitly declared EPSG:4326 coordinates unchanged', () => {
        const active = vi.fn(() => [0, 0]);
        const window = loadGeometry({ datasetToLatLng: active });
        const feature = polygonFeature([15.981, 45.811]);
        const result = window.convertGeoJSON({ type: 'FeatureCollection', features: [feature] }, { sourceSrid: 4326 });
        expect(result.features[0].geometry.coordinates).toEqual(feature.geometry.coordinates);
        expect(active).not.toHaveBeenCalled();
    });

    it('passes transport source CRS and requested city into geometry conversion', async () => {
        const convert = vi.fn(collection => collection);
        const repository = createCadastralParcelRepository({
            root: { getCurrentCityId: () => 'oss-test-city' },
            convertFeatures: convert,
            transport: { fetchByIds: async ids => ({ status: 'ready', complete: true, absentIds: [],
                returnsWGS84: false, sourceSrid: 'EPSG:3765', features: ids.map(id => polygonFeature([500000, 5070000], id)) }) }
        });
        await repository.ensureIds(['HR-TEST'], { city: 'oss-test-city' });
        expect(convert).toHaveBeenCalledWith(expect.objectContaining({ type: 'FeatureCollection' }),
            { sourceSrid: 'EPSG:3765', city: 'oss-test-city' });
    });

    it('declares the requested EPSG:3765 CRS on both direct OSS ID and bbox transports', async () => {
        const transport = loadOssTransport([polygonFeature([500000, 5070000])]);
        const ids = await transport.fetchByIds(['HR-TEST'], { city: 'oss-test-city' });
        expect(ids).toMatchObject({ returnsWGS84: false, sourceSrid: 'EPSG:3765' });
        const bounds = await transport.fetchBounds(null, { city: 'oss-test-city', keys: ['0,0'] });
        expect(bounds).toMatchObject({ returnsWGS84: false, sourceSrid: 'EPSG:3765' });
    });

    it('rejects a viewport merge whose cells declare different CRSs', async () => {
        let requestNumber = 0;
        const window = {
            fetch: async () => ({ ok: true, status: 200, json: async () => ({ features: [], numberReturned: 0 }) }),
            CityConfigManager: { getCurrentCityId: () => 'test-city', getCityConfig: () => ({ id: 'test-city', parcels: { source: 'oss-wfs', gridSize: 500 } }),
                datasetToLatLng: (e, n) => [n, e] },
            getCurrentDataSource: () => 'backend',
            buildParcelRequestParams: () => ({ url: 'https://example.invalid/parcels', returnsWGS84: false,
                sourceSrid: ++requestNumber === 1 ? 'EPSG:3765' : 'EPSG:3794' })
        };
        const context = vm.createContext({ window, fetch: window.fetch, URL, URLSearchParams, console, setTimeout, AbortController });
        vm.runInContext(readFileSync(new URL('../../frontend/js/parcels/fetch.js', import.meta.url), 'utf8'), context);
        await expect(window.__cadastralGroundTransport.fetchBounds(null, { city: 'test-city', keys: ['0,0', '1,0'] }))
            .rejects.toThrow(/mixed source coordinate systems/);
    });
});
