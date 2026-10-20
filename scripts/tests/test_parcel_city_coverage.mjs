// Contract tests for exact WUP identity, settings precedence and advisory failed URL checks.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readCityChecks } from '../lib/parcel-city-coverage.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'parcel-city-coverage-'));
try {
    const cities = path.join(root, 'world-parcels/cities');
    const put = (code, name, file, value) => {
        const dir = path.join(cities, String(code));
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, file), JSON.stringify(value));
    };
    const setting = (code, options = {}) => ({ schemaVersion: 1, cityCode: String(code),
        name: options.name || `City ${code}`, point: options.point,
        bindings: [{ appCityId: options.appCityId || `city_${code}`, runtimeConfig: {
            id: options.appCityId || `city_${code}`, ...(options.runtimeWup ? { wupCityCode: String(code) } : {}),
            map: options.defaultCenter ? { defaultCenter: options.defaultCenter } : {},
            parcels: { source: 'parcel-source', sourceId: `source_${code}` }
        } }],
        sources: options.invalidSources ? [] : [{ id: `source_${code}`, adapter: 'arcgis', countryCode: options.sourceCountry || 'SC', endpoint: 'https://example.test/parcels' }] });

    put(101, 'city', 'settings.json', setting(101));
    put(101, 'city', 'failed-urls.json', [{ url: 'https://failed.example/parcels' }]);
    put(102, 'empty', 'failed-urls.json', []);
    put(103, 'held', 'failed-urls.json', [{ url: 'https://held.example/parcels', reason: 'timeout' }]);
    put(104, 'fuzzy', 'failed-urls.json', [{ url: 'https://fuzzy.example/parcels' }]);
    put(105, 'point fallback', 'settings.json', setting(105, { runtimeWup: true, defaultCenter: [5, 6], invalidSources: true }));
    put(105, 'point fallback', 'failed-urls.json', [{ url: 'https://held-point.example/parcels' }]);
    put(106, 'unknown', 'settings.json', setting(106, { point: [7, 8] }));
    put(107, 'mismatched settings', 'settings.json', { ...setting(108, { point: [8, 8] }), cityCode: '108' });
    put(107, 'mismatched settings', 'failed-urls.json', [{ url: 'https://wrong-city.example/parcels' }]);
    put(112, 'demographic WUP mapping', 'settings.json', setting(112, { appCityId: 'mapped_app_112' }));
    put(113, 'unactivated qualified source', 'settings.json', { schemaVersion: 1, cityCode: '113', name: 'Unactivated', point: [13, 14],
        bindings: [], sources: [{ id: 'source_113', adapter: 'arcgis' }] });

    const registry = { cities: [
        { wupCityCode: 101, name: 'Qualified City', centerLatLon: [1, 2] },
        { wupCityCode: 102, name: 'Empty Failure List City', countryCode: 'EF', centerLatLon: [2, 3] },
        { wupCityCode: 999, name: 'Fuzzy name match only', countryCode: 'ZZ', centerLatLon: [4, 4] },
        { wupCityCode: 105, name: 'Point Fallback City', countryCode: 'PF' },
        { wupCityCode: 107, name: 'No Point City', countryCode: 'NP' },
        { wupCityCode: 113, name: 'Unactivated Qualified City', countryCode: 'UQ', centerLatLon: [13, 14] },
        { wupCityCode: 111, name: 'Pending City', countryCode: 'PN', centerLatLon: [11, 11] }
    ] };
    const demographics = { cities: [
        { wupCityCode: 103, name: 'Held City', countryCode: 'HC', latitude: 3, longitude: 4 },
        { wupCityCode: 112, name: 'Demographic Mapping City', countryCode: 'DM', latitude: 12, longitude: 13, appCityIds: ['mapped_app_112'] }
    ] };

    const rows = readCityChecks(root, { registry, demographics });
    assert.deepEqual(rows, [
        { cityCode: 101, cityName: 'Qualified City', countryCode: 'SC', point: [1, 2], outcome: 'qualified', appCityIds: ['city_101'] },
        { cityCode: 102, cityName: 'Empty Failure List City', countryCode: 'EF', point: [2, 3], outcome: 'held', appCityIds: [] },
        { cityCode: 103, cityName: 'Held City', countryCode: 'HC', point: [3, 4], outcome: 'held', appCityIds: [] },
        { cityCode: 105, cityName: 'Point Fallback City', countryCode: 'PF', point: [5, 6], outcome: 'held', appCityIds: [] },
        { cityCode: 112, cityName: 'Demographic Mapping City', countryCode: 'DM', point: [12, 13], outcome: 'qualified', appCityIds: ['mapped_app_112'] },
        { cityCode: 113, cityName: 'Unactivated Qualified City', countryCode: 'UQ', point: [13, 14], outcome: 'qualified', appCityIds: [] }
    ]);
} finally {
    fs.rmSync(root, { recursive: true, force: true });
}

process.stdout.write('parcel city coverage tests passed\n');
