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
const manifests = [
    json('world-parcels/research/qualification-admission-2026-10-11.json'),
    json('world-parcels/research/qualification-admission-2026-10-11-round2.json'),
    json('world-parcels/research/qualification-admission-2026-10-12-round2.json'),
    json('world-parcels/research/qualification-admission-2026-10-12-pl-egib.json')
];
// A later admission that switched a live city to a newly qualified source (switchedFrom) replaces
// its earlier binding; the earlier one stays in its manifest as history.
const current = new Map();
for (const manifest of manifests) for (const city of manifest.cities) current.set(city.cityCode, city);
const admittedCities = [...current.values()];
const registry = json('world-parcels/registry.json');
const context = { console, URL, URLSearchParams }; context.window = context;
runInNewContext(read('frontend/js/city-config.js').toString(), context);
const blockers = ['invalidCount', 'duplicateIdCount', 'conflictingSameIdGeometryCount',
    'exactGeometryDuplicateCount', 'overlapPairCount', 'operationErrorCount'];

describe('qualified city production admission', () => {
    it('keeps every admission cohort complete and uniquely bound to app cities', () => {
        for (const manifest of manifests) {
            expect(manifest.cities.length).toBe(manifest.cityCount);
            expect(new Set(manifest.cities.map(city => city.cityCode)).size).toBe(manifest.cities.length);
        }
        expect(new Set(admittedCities.map(city => city.appCityId)).size).toBe(admittedCities.length);
        // A switch names the source the city was admitted on before, in an earlier manifest.
        manifests.forEach((manifest, index) => {
            for (const city of manifest.cities.filter(entry => entry.switchedFrom)) {
                const earlier = manifests.slice(0, index).flatMap(entry => entry.cities).filter(entry => entry.cityCode === city.cityCode);
                expect(earlier.at(-1)).toMatchObject({ appCityId: city.appCityId, sourceId: city.switchedFrom });
            }
        });
        expect(manifests[1].cityCount).toBe(108);
        expect(manifests[1].cities.every(city => city.primaryReview.status === 'admitted')).toBe(true);
        // The 2026-10-12 jurisdiction-first release, written by scripts/admit-qualified-cities.mjs.
        expect(manifests[2].cityCount).toBe(205);
        expect(manifests[2].cities.every(city => city.primaryReview.status === 'admitted')).toBe(true);
    });

    it.each(admittedCities)('$appCityId resolves the qualified source with reproducible, non-repaired evidence', city => {
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
        const candidate = json(city.evidenceFiles.candidate);
        expect(candidate.city).toMatchObject({ code: city.cityCode, name: city.qualificationCityName });
        expect(candidate.city.point).toEqual([city.wupPointLatLon[1], city.wupPointLatLon[0]]);
        expect(source.descriptor.endpoint).toBe(candidate.descriptor.endpoint);
        expect(source.descriptor.idPrefix).toBe(candidate.descriptor.idPrefix);
        expect(source.descriptor.idField).toBe(candidate.descriptor.idField);
        expect(source.descriptor.idFields).toEqual(candidate.descriptor.idFields);
        expect(config.parcels.idPrefix).toBe(candidate.descriptor.idPrefix);
        // Reused-provider admissions must execute the same query contract that was qualified.
        if (city.primaryReview) {
            for (const field of ['attributeFilters', 'attributeExclusions', 'attributeNotNull', 'attributeNull',
                'featureType', 'boundsQueryMode', 'idsQueryMode', 'boundsSrid', 'boundsProjection']) {
                expect(source.descriptor[field] ?? null).toEqual(candidate.descriptor[field] ?? null);
            }
        }
        expect(qualification.sourceId).toBe(city.sourceId);
        expect(qualification.cityCode).toBe(city.cityCode);
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
