// App admission must remain tied to the exact evidence that qualified its native parcel source.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { parcelSourceForCity } from '../parcels/sources.js';

const root = new URL('../../', import.meta.url);
const read = file => readFileSync(new URL(file, root));
const json = file => JSON.parse(read(file));
const digest = file => createHash('sha256').update(read(file)).digest('hex');
const manifest = json('world-parcels/research/qualification-admission-2026-10-11.json');
const registry = json('world-parcels/registry.json');
const context = { console, URL, URLSearchParams }; context.window = context;
runInNewContext(read('frontend/js/city-config.js').toString(), context);
const blockers = ['invalidCount', 'duplicateIdCount', 'conflictingSameIdGeometryCount',
    'exactGeometryDuplicateCount', 'overlapPairCount', 'operationErrorCount'];

describe('qualified city production admission', () => {
    it.each(manifest.cities)('$appCityId resolves the qualified source with reproducible, non-repaired evidence', city => {
        const source = parcelSourceForCity(city.appCityId);
        expect(source?.descriptor.id).toBe(city.sourceId);
        expect(source.descriptor.metricSrid).toBe(Number(city.metric.metricCrs.split(':')[1]));
        const config = context.CityConfigManager.getCityConfig(city.appCityId);
        expect(config.id).toBe(city.appCityId);
        expect(config.parcels).toMatchObject({ source: 'parcel-source', sourceId: city.sourceId, ownership: false });
        expect(config.map.defaultCenter).toEqual(city.appCenterLatLon);
        const row = registry.cities.find(row => row.cityId === city.cityId && row.appCityId === city.appCityId);
        expect(row?.sourceIds).toContain(city.sourceId);
        expect(row.countryCode).toBe(city.countryCode);
        const provider = registry.sources.find(row => row.sourceId === city.sourceId);
        expect(provider.liveIntegration.status).toBe('enabled');
        expect(provider.liveIntegration.cityIds).toContain(city.appCityId);
        for (const kind of ['candidate', 'qualification', 'metric']) {
            expect(digest(city.evidenceFiles[kind])).toBe(city[kind].evidenceExportSha256);
        }
        const qualification = json(city.evidenceFiles.qualification);
        expect(qualification.candidateSha256).toBe(city.candidate.qualificationRecordedSha256);
        expect(Object.values(qualification.checks).filter(gate => gate.passed).length).toBe(8);
        const metric = json(city.evidenceFiles.metric);
        expect(metric.inputSha256).toBe(qualification.cacheSha256);
        const independent = json(city.evidenceFiles.independentMetricAudit);
        expect(independent.inputSha256).toBe(metric.inputSha256);
        expect(independent.geometryChangedOrRepaired).toBe(false);
        expect(independent.geometryPass).toBe(true);
        for (const field of blockers) expect(independent[field]).toBe(0);
        for (const locale of ['en', 'es', 'hr', 'sr']) {
            expect(json(`frontend/i18n/${locale}.json`).city.labels[city.appCityId]).toBeTruthy();
        }
    });
});
