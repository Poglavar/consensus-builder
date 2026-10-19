// Verifies completed capital research, source associations and executable city profiles.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { createParcelSource, parcelSourceCatalog } from '../parcels/sources.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RESEARCH_DIR = path.join(REPO_ROOT, 'world-parcels/research/world-capitals-2026-10-08');
const readJson = file => JSON.parse(readFileSync(path.join(REPO_ROOT, file), 'utf8'));
const resolveResearchRef = ref => path.resolve(REPO_ROOT, 'world-parcels', ref);

const roster = readJson('world-parcels/research/world-capitals-2026-10-08/roster.json');
const queue = readJson('world-parcels/research/world-capitals-2026-10-08/queue.json');
const index = readJson('world-parcels/research/world-capitals-2026-10-08/index.json');
const registry = readJson('world-parcels/registry.json');
const report = readJson('frontend/data/parcel-coverage-report.json');
const coverage = readJson('frontend/data/world-coverage.json');
const researchRows = queue.cities.map(row => ({
    queue: row,
    research: readJson(path.relative(REPO_ROOT, resolveResearchRef(row.researchFile)))
}));

describe('world capitals research and runtime integration', () => {
    it('covers 225 distinct seats across 195 core country codes and keeps supplementary seats explicit', () => {
        const cities = roster.cities;
        expect(cities).toHaveLength(225);
        expect(new Set(cities.map(city => city.cityId)).size).toBe(cities.length);

        // Additional functioning, disputed and associated seats do not inflate country coverage.
        const coreSeats = cities.filter(city => !String(city.capitalRole || '').startsWith('supplement'));
        expect(new Set(coreSeats.map(city => city.countryCode)).size).toBe(195);
        const coveredCountryCodes = new Set(coreSeats.map(city => city.countryCode));
        expect(coveredCountryCodes.has('VA')).toBe(true);
        expect(coveredCountryCodes.has('PS')).toBe(true);

        const supplementary = cities.filter(city => city.seatType === 'supplemental_functioning_or_claimed_seat'
            || String(city.capitalRole || '').startsWith('supplement'));
        expect(supplementary.length).toBeGreaterThan(0);
        expect(supplementary.every(city => city.capitalRole && city.capitalRole !== 'primary')).toBe(true);
        expect(cities.some(city => city.cityId === 'capital:PS:east-jerusalem')).toBe(true);
        expect(cities.some(city => city.cityId === 'capital:PS:ramallah')).toBe(true);
    });

    it('links every completed queue record through registry and generated report evidence', () => {
        expect(queue.cities).toHaveLength(69);
        expect(new Set(queue.cities.map(city => city.cityId)).size).toBe(queue.cities.length);
        expect(queue.remainingCount).toBe(0);
        expect(queue.cities.every(city => city.researchStatus === 'complete' && city.checkedAt)).toBe(true);

        const registryById = new Map(registry.cities.map(city => [city.cityId, city]));
        const reportById = new Map(report.cities.map(city => [city.id, city]));
        for (const { queue: queued, research } of researchRows) {
            expect(existsSync(resolveResearchRef(queued.researchFile)), queued.researchFile).toBe(true);
            expect(research).toMatchObject({ cityId: queued.cityId, status: 'complete' });
            expect(research.checkedAt).toBeTruthy();
            for (const ref of [
                research.sourceCandidate?.safeSampleFile,
                research.sourceCandidate?.responseFile,
                research.sourceCandidate?.sampleFile,
                research.sourceCandidate?.evidenceFile,
                research.verifiedParcelResponse?.responseFile,
                research.verifiedParcelResponse?.sampleFile
            ].filter(Boolean)) {
                const file = ref.startsWith('research/') ? resolveResearchRef(ref) : path.join(RESEARCH_DIR, ref);
                expect(existsSync(file), `${queued.cityId}: ${ref}`).toBe(true);
            }

            const registryCity = registryById.get(queued.cityId);
            expect(registryCity, `registry row for ${queued.cityId}`).toBeTruthy();
            expect(registryCity.capitalResearch).toMatchObject({
                cohort: 'world-capitals',
                evidenceFile: queued.researchFile,
                checkedAt: research.checkedAt.slice(0, 10)
            });
            expect(registryCity.dataFindings?.registryFound ?? null).toBe(research.registryFound ?? null);
            expect(registryCity.sourceIds || []).toEqual(research.sourceIds || []);

            const reportCity = reportById.get(queued.cityId);
            expect(reportCity, `generated report row for ${queued.cityId}`).toBeTruthy();
            expect(reportCity.checked).toBe(true);
            expect(reportCity.checkedDate).toBe(research.checkedAt.slice(0, 10));
            expect(reportCity.checkedDateEvidence).toMatchObject({ path: queued.researchFile });
            expect(reportCity.registryFound ?? null).toBe(research.registryFound ?? null);
            expect(reportCity.sourceIds || []).toEqual(research.sourceIds || []);
            expect(reportCity.evidenceFiles).toContain(queued.researchFile);
            for (const evidenceFile of reportCity.evidenceFiles || []) {
                expect(evidenceFile.startsWith('research/'), `${queued.cityId}: ${evidenceFile}`).toBe(true);
                expect(existsSync(resolveResearchRef(evidenceFile)), `${queued.cityId}: ${evidenceFile}`).toBe(true);
            }
        }
    });

    it('distinguishes ten enabled new app cities from quality and access holds', () => {
        const enabled = researchRows.filter(({ queue: city }) => city.runtimeReadiness === 'enabled');
        const qualityHolds = researchRows.filter(({ queue: city }) => city.runtimeReadiness === 'held_quality_review');
        const accessHolds = researchRows.filter(({ queue: city }) => city.runtimeReadiness === 'held_access_review');
        expect(enabled).toHaveLength(10);
        expect(qualityHolds).toHaveLength(9);
        expect(accessHolds.map(({ queue: city }) => city.cityId)).toEqual(['capital:BO:la-paz']);
        expect(index.newAppCities).toBe(enabled.length);
        expect(index.geometryQualityHeldCities).toBe(qualityHolds.length);
        expect(index.geometryAccessHeldCities).toBe(accessHolds.length);

        const sourceRows = new Map(parcelSourceCatalog.sources.map(source => [source.id, source]));
        const liveCities = new Map(coverage.liveCities.map(city => [city.id, city]));
        for (const { queue: queued, research } of enabled) {
            expect(queued.verifiedSample).toBe(true);
            expect(research.runtimeReadiness).toBe('enabled');
            expect(research.appCityId).toBeTruthy();
            expect(research.sourceIds).toHaveLength(1);
            const source = sourceRows.get(research.sourceIds[0]);
            expect(source, `${queued.cityId} source`).toBeTruthy();
            expect(source.cityIds).toContain(research.appCityId);
            expect(liveCities.get(research.appCityId)?.sourceId).toBe(source.id);
            for (const ref of [source.evidenceFile, ...Object.values(source.additionalCityEvidence || {})].filter(Boolean)) {
                expect(ref.startsWith('research/'), `${source.id}: ${ref}`).toBe(true);
                expect(existsSync(resolveResearchRef(ref)), `${source.id}: ${ref}`).toBe(true);
            }

            // Instantiate each configured city entry against a fetch that must never be called.
            const fetchImpl = vi.fn(async () => { throw new Error('unexpected live source request'); });
            const adapter = createParcelSource(source, { fetchImpl });
            expect(adapter).toMatchObject({
                queryBounds: expect.any(Function),
                queryIds: expect.any(Function),
                queryGeometry: expect.any(Function)
            });
            expect(fetchImpl).not.toHaveBeenCalled();
        }
    });

    it('keeps shared and city-specific catalog identities aligned across registry and coverage', () => {
        const sourceRows = new Map(parcelSourceCatalog.sources.map(source => [source.id, source]));
        const registryById = new Map(registry.cities.map(city => [city.cityId, city]));
        const reportById = new Map(report.cities.map(city => [city.id, city]));
        const liveById = new Map(coverage.liveCities.map(city => [city.id, city]));

        const govmapId = 'il-govmap-cadastral-parcel-rows';
        const govmap = sourceRows.get(govmapId);
        expect(govmap).toBeTruthy();
        expect(govmap.cityIds).toEqual(expect.arrayContaining(['jerusalem', 'eastjerusalem']));
        expect(govmap.additionalCityEvidence).toMatchObject({
            jerusalem: 'research/world-capitals-2026-10-08/jerusalem-acceptance.json',
            eastjerusalem: 'research/world-capitals-2026-10-08/east-jerusalem-acceptance.json'
        });
        for (const [cityId, appCityId, countryCode] of [
            ['capital:IL:jerusalem', 'jerusalem', 'IL'],
            ['capital:PS:east-jerusalem', 'eastjerusalem', 'PS']
        ]) {
            const registered = registryById.get(cityId);
            const reported = reportById.get(cityId);
            expect(registered).toMatchObject({ appCityId, countryCode, sourceIds: [govmapId] });
            expect(reported).toMatchObject({ id: cityId, countryCode, sourceIds: [govmapId], appCityIds: [appCityId] });
            expect(liveById.get(appCityId)?.sourceId).toBe(govmapId);
        }

        const cetinje = registryById.get('capital:ME:cetinje');
        const podgorica = registryById.get('capital:ME:podgorica');
        expect(cetinje?.runtimeReadiness).toBe('enabled');
        expect(podgorica?.runtimeReadiness).toBe('held_quality_review');
        const montenegro = sourceRows.get('me-water-cadastral-parcels');
        expect(montenegro.cityIds).toContain('cetinje');
        expect(montenegro.cityIds).not.toContain('podgorica');
        expect(reportById.get('capital:ME:cetinje')?.appCityIds).toContain('cetinje');
        expect(reportById.get('capital:ME:podgorica')?.appCityIds).toEqual([]);

        const pdok = sourceRows.get('nl-pdok-brk-kadastrale-kaart');
        expect(pdok.cityIds).toContain('thehague');
        expect(pdok.additionalCityEvidence?.thehague).toBe('research/world-capitals-2026-10-08/the-hague-acceptance.json');
        expect(reportById.get('capital:NL:the-hague')?.appCityIds).toContain('thehague');
        expect(reportById.get('capital:NL:the-hague')?.sourceIds).toContain(pdok.id);
        expect(liveById.get('thehague')?.sourceId).toBe(pdok.id);
    });
});
