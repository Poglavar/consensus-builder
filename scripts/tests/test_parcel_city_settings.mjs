// Contract checks for the single current per-WUP city settings schema and its runtime apply path.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { applyCitySettings, buildCitySettings, exportCitySettings, parseCityConfigs, recoverQualifiedSettings } from '../lib/parcel-city-settings.mjs';
import { parseCityConfigs as parseWorldCoverageCities } from '../build-world-coverage.mjs';

const configSource = `const SHARED_DEFAULT_ZOOM = 19; const CITY_CONFIGS = {
        test_city: { id: 'test_city', wupCityCode: '123', label: translateCityText('city.test', 'Test City'), country: 'Example',
            map: { defaultCenter: [1, 2], parcelZoomRange: { min: 17, max: Infinity } }, parcels: { strategy: 'point', source: 'parcel-source', sourceId: 'validated-source', liveSource: { sourceId: 'validated-source', idPrefix: 'T-' } },
            walk: { url: 'https://example.test/walk' } }
};`;

const configs = parseCityConfigs(configSource);
const catalog = { sources: [{ id: 'validated-source', adapter: 'arcgis', endpoint: 'https://example.test/features',
    cityIds: ['test_city'], evidenceFile: 'research/old.json', discovery: { evidence: ['research/old.json'] },
    outFields: ['ID'], maxFeatures: 50, attributeExclusions: { ID: ['', ' '] }, attributeFilters: { STATUS: ' ' } }] };

const [row] = buildCitySettings({ configs, catalog });
assert.equal(row.cityCode, '123');
assert.deepEqual(row.point, [1, 2]);
assert.deepEqual(row.bindings[0].runtimeConfig.parcels, configs.test_city.parcels);
assert.equal(Object.hasOwn(row, 'runtimeConfig'), false);
assert.equal(Object.hasOwn(row, 'appCityId'), false);
assert.equal(row.sources.length, 1);
assert.equal(row.sources[0].adapter, 'arcgis');
assert.equal(row.sources[0].endpoint, 'https://example.test/features');
assert.equal(row.sources[0].evidenceFile, undefined);
assert.deepEqual(row.sources[0].attributeExclusions, { ID: ['', ' '] });
assert.deepEqual(row.sources[0].attributeFilters, { STATUS: ' ' });
assert.deepEqual(row.sources[0].discovery.evidence, []);

assert.throws(() => buildCitySettings({ configs, catalog: { sources: [] } }), /absent from source catalog/);
assert.throws(() => buildCitySettings({ configs: { ...configs, candidate: {
    ...configs.test_city, id: 'candidate', wupCityCode: '124', parcels: { source: 'parcel-source', sourceId: 'candidate-only' }
} }, catalog }), /absent from source catalog/);
assert.throws(() => buildCitySettings({ configs, catalog, codes: ['999'] }), /No configured WUP city/);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'parcel-city-settings-'));
try {
    for (const dir of ['frontend/js', 'frontend/data', 'backend/parcels', 'world-parcels/report']) fs.mkdirSync(path.join(root, dir), { recursive: true });
    fs.writeFileSync(path.join(root, 'frontend/data/city-configs.js'), `${configSource}\n// retained outside config`);
    fs.writeFileSync(path.join(root, 'frontend/data/source-catalog.json'), JSON.stringify(catalog));
    fs.writeFileSync(path.join(root, 'world-parcels/report/city-demographics.json'), JSON.stringify({ cities: [] }));
    const cli = spawnSync(process.execPath, [fileURLToPath(new URL('../lib/parcel-city-settings.mjs', import.meta.url)), '--root', root, '123'], { encoding: 'utf8' });
    assert.equal(cli.status, 0, cli.stderr);
    assert.deepEqual(JSON.parse(cli.stdout), { written: 1 });
    exportCitySettings(root);
    const settingsFile = path.join(root, 'world-parcels/cities/123/settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    settings.bindings[0].runtimeConfig.parcels.gridSize = 77;
    settings.sources[0].endpoint = 'https://example.test/updated';
    fs.writeFileSync(settingsFile, JSON.stringify(settings));
    fs.mkdirSync(path.join(root, 'world-parcels/cities/9999'), { recursive: true });
    fs.writeFileSync(path.join(root, 'world-parcels/cities/9999/failed-urls.json'), '[]');
    assert.deepEqual(applyCitySettings(root), { citySettings: 1, appCities: 1, sources: 1, databaseSources: 0 });
    const appliedConfigs = parseCityConfigs(fs.readFileSync(path.join(root, 'frontend/data/city-configs.js'), 'utf8'));
    const appliedCatalog = JSON.parse(fs.readFileSync(path.join(root, 'frontend/data/source-catalog.json'), 'utf8'));
    assert.equal(appliedConfigs.test_city.parcels.gridSize, 77);
    assert.equal(appliedConfigs.test_city.map.parcelZoomRange.max, Infinity);
    assert.equal(appliedCatalog.sources[0].endpoint, 'https://example.test/updated');
    assert.equal(appliedCatalog.sources[0].evidenceFile, undefined);
    const appliedText = fs.readFileSync(path.join(root, 'frontend/data/city-configs.js'), 'utf8');
    assert.match(appliedText, /        test_city: \{/);
    assert.match(appliedText, /retained outside config/);
    assert.match(appliedText, /label: translateCityText\('city\.test', 'Test City'\)/);
    const coverageCities = parseWorldCoverageCities(appliedText);
    assert.equal(coverageCities.length, 1);
    assert.equal(coverageCities[0].id, 'test_city');
    assert.equal(coverageCities[0].sourceId, 'validated-source');

    settings.sources = [];
    fs.writeFileSync(settingsFile, JSON.stringify(settings));
    assert.throws(() => applyCitySettings(root, { codes: ['123'] }), /Missing source descriptor/);
    settings.sources = [catalog.sources[0], { ...catalog.sources[0], endpoint: 'https://example.test/conflict' }];
    fs.writeFileSync(settingsFile, JSON.stringify(settings));
    assert.throws(() => applyCitySettings(root, { codes: ['123'] }), /Conflicting source descriptor/);
} finally {
    fs.rmSync(root, { recursive: true, force: true });
}

const sharedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'parcel-city-shared-source-'));
try {
    for (const dir of ['frontend/js', 'frontend/data', 'backend/parcels', 'world-parcels/report']) fs.mkdirSync(path.join(sharedRoot, dir), { recursive: true });
    const sharedConfigs = {
        city_a: { id: 'city_a', wupCityCode: '11', label: 'City A', map: { defaultCenter: [1, 1] }, parcels: { source: 'parcel-source', sourceId: 'shared-source' } },
        city_b: { id: 'city_b', wupCityCode: '12', label: 'City B', map: { defaultCenter: [2, 2] }, parcels: { source: 'parcel-source', sourceId: 'shared-source' } }
    };
    const sharedCatalog = { sources: [{ id: 'shared-source', adapter: 'arcgis', endpoint: 'https://example.test/shared',
        cityIds: ['city_a', 'city_b', 'city_c'], metricSridByCity: { city_a: 26910, city_b: 26911, city_c: 26912 }, evidenceFile: 'research/archive.json' }] };
    const sharedConfigSource = `const CITY_CONFIGS = {\n        city_a: { id: 'city_a', wupCityCode: '11', label: 'City A', map: { defaultCenter: [1, 1] }, parcels: { source: 'parcel-source', sourceId: 'shared-source' } },\n        city_b: { id: 'city_b', wupCityCode: '12', label: 'City B', map: { defaultCenter: [2, 2] }, parcels: { source: 'parcel-source', sourceId: 'shared-source' } }\n};`;
    fs.writeFileSync(path.join(sharedRoot, 'frontend/data/city-configs.js'), sharedConfigSource);
    fs.writeFileSync(path.join(sharedRoot, 'frontend/data/source-catalog.json'), JSON.stringify(sharedCatalog));
    fs.writeFileSync(path.join(sharedRoot, 'world-parcels/report/city-demographics.json'), JSON.stringify({ cities: [] }));
    exportCitySettings(sharedRoot);
    const cityAFile = path.join(sharedRoot, 'world-parcels/cities/11/settings.json');
    const cityBFile = path.join(sharedRoot, 'world-parcels/cities/12/settings.json');
    const cityA = JSON.parse(fs.readFileSync(cityAFile, 'utf8'));
    const cityB = JSON.parse(fs.readFileSync(cityBFile, 'utf8'));
    assert.deepEqual(cityA.sources[0].cityIds, ['city_a']);
    assert.deepEqual(cityA.sources[0].metricSridByCity, { city_a: 26910 });
    const reducedCatalog = structuredClone(sharedCatalog);
    reducedCatalog.sources[0].cityIds = ['city_c'];
    reducedCatalog.sources[0].metricSridByCity = { city_c: 26912 };
    fs.writeFileSync(path.join(sharedRoot, 'frontend/data/source-catalog.json'), JSON.stringify(reducedCatalog));
    cityB.sources[0].endpoint = 'https://example.test/conflicting';
    fs.writeFileSync(cityBFile, JSON.stringify(cityB));
    assert.throws(() => applyCitySettings(sharedRoot), /Conflicting source descriptor/);

    cityB.sources[0].endpoint = 'https://example.test/shared';
    fs.writeFileSync(cityBFile, JSON.stringify(cityB));
    applyCitySettings(sharedRoot);
    let merged = JSON.parse(fs.readFileSync(path.join(sharedRoot, 'frontend/data/source-catalog.json'), 'utf8')).sources[0];
    assert.deepEqual(new Set(merged.cityIds), new Set(['city_a', 'city_b', 'city_c']));
    assert.deepEqual(merged.metricSridByCity, { city_c: 26912, city_a: 26910, city_b: 26911 });

    cityA.sources[0].endpoint = 'https://example.test/updated-shared';
    fs.writeFileSync(cityAFile, JSON.stringify(cityA));
    applyCitySettings(sharedRoot, { codes: ['11'] });
    merged = JSON.parse(fs.readFileSync(path.join(sharedRoot, 'frontend/data/source-catalog.json'), 'utf8')).sources[0];
    assert.equal(merged.endpoint, 'https://example.test/updated-shared');
    assert.deepEqual(new Set(merged.cityIds), new Set(['city_a', 'city_b', 'city_c']));
    assert.deepEqual(merged.metricSridByCity, { city_a: 26910, city_b: 26911, city_c: 26912 });
    assert.equal(merged.evidenceFile, undefined);
} finally {
    fs.rmSync(sharedRoot, { recursive: true, force: true });
}

const recoveryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'parcel-city-recovery-'));
try {
    fs.mkdirSync(path.join(recoveryRoot, 'backend/parcels'), { recursive: true });
    fs.writeFileSync(path.join(recoveryRoot, 'backend/parcels/browser-source-runtime.js'),
        "export const browserParcelFactories = Object.freeze({ arcgis: () => {}, 'not-an-adapter': undefined });\n");
    const hash = bytes => createHash('sha256').update(bytes).digest('hex');
    const artifact = (name, { adapter = 'arcgis', cityCode = '201', tamper = false, tamperCache = false } = {}) => {
        const dir = path.join(recoveryRoot, 'artifacts', name), evidence = path.join(dir, 'evidence');
        fs.mkdirSync(evidence, { recursive: true });
        const candidate = { city: { code: cityCode, name: 'Recovered City', countryCode: 'RC', point: [10, 20] },
            sourceClassification: { isParcel: true, evidence: ['official cadastral layer'] },
            descriptor: { id: `source-${name}`, adapter, endpoint: 'https://example.test/parcels', idPrefix: 'P-' } };
        const candidateBytes = Buffer.from(JSON.stringify(candidate));
        const cacheBytes = Buffer.from(JSON.stringify({ type: 'FeatureCollection', features: [
            { type: 'Feature', id: 'P-1', properties: {}, geometry: { type: 'Polygon', coordinates: [[[1, 1], [2, 1], [2, 2], [1, 1]]] } }
        ] }));
        fs.writeFileSync(path.join(dir, 'candidate.json'), candidateBytes);
        fs.writeFileSync(path.join(evidence, 'full-safe.geojson'), cacheBytes);
        fs.writeFileSync(path.join(evidence, 'qualification.json'), JSON.stringify({ status: 'technical-qualified', cityCode,
            sourceId: candidate.descriptor.id, candidateSha256: tamper ? 'bad' : hash(candidateBytes), cacheSha256: tamperCache ? 'bad' : hash(cacheBytes),
            checks: { classification: { passed: true }, exactIds: { passed: true }, stableGeometry: { passed: true } } }));
        return dir;
    };
    const good = artifact('good');
    const badHash = artifact('bad-hash', { cityCode: '202', tamper: true });
    const badCache = artifact('bad-cache', { cityCode: '203', tamperCache: true });
    const unsupported = artifact('unsupported', { cityCode: '204', adapter: 'not-an-adapter' });
    const result = await recoverQualifiedSettings(recoveryRoot, [good, badHash, badCache, unsupported]);
    assert.deepEqual(result.recovered, ['201']);
    assert.equal(result.skipped.length, 3);
    const recovered = JSON.parse(fs.readFileSync(path.join(recoveryRoot, 'world-parcels/cities/201/settings.json'), 'utf8'));
    assert.deepEqual(recovered.bindings, []);
    assert.equal(recovered.sources[0].id, 'source-good');
    assert.deepEqual(recovered.point, [20, 10]);
    assert.equal(fs.existsSync(path.join(recoveryRoot, 'world-parcels/cities/202/settings.json')), false);
    assert.equal(fs.existsSync(path.join(recoveryRoot, 'world-parcels/cities/203/settings.json')), false);
    assert.equal(fs.existsSync(path.join(recoveryRoot, 'world-parcels/cities/204/settings.json')), false);

    const bound = path.join(recoveryRoot, 'world-parcels/cities/201/settings.json');
    const boundSettings = { ...recovered, bindings: [{ appCityId: 'city_201', runtimeConfig: { id: 'city_201', parcels: { sourceId: 'source-good' } } }] };
    fs.writeFileSync(bound, JSON.stringify(boundSettings));
    const precedence = await recoverQualifiedSettings(recoveryRoot, [good]);
    assert.deepEqual(precedence.recovered, []);
    assert.match(precedence.skipped[0].reason, /working settings/);
} finally { fs.rmSync(recoveryRoot, { recursive: true, force: true }); }

process.stdout.write('parcel city settings tests passed\n');
