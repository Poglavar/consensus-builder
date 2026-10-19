// Protect regional cohort identity, provenance and work ordering when rebuilding the research queue.
import { describe, expect, it } from 'vitest';
import { buildIndiaAfricaQueue } from '../../scripts/build-india-africa-parcel-queue.mjs';

function fixture() {
    const city = (cityCode, iso2, rank) => ({ cityCode, iso2, rank, name: `City ${cityCode}`, country: iso2, lat: cityCode, lon: 10, pop2025k: 100, annualGrowthPct2015To2025: 5 });
    return {
        largest: [city(1, 'IN', 10), city(2, 'ZA', 20), city(3, 'BR', 30)],
        growth: [city(1, 'IN', 4), city(4, 'NG', 5), city(5, 'MU', 6)],
        countries: { features: [{ properties: { CONTINENT: 'Africa', ISO_A2_EH: 'ZA' } }, { properties: { CONTINENT: 'Africa', ISO_A2_EH: 'NG' } }, { properties: { CONTINENT: 'South America', ISO_A2_EH: 'BR' } }] },
        enrichment: { cities: [[1, 'IN'], [2, 'ZA'], [3, 'BR'], [4, 'NG'], [5, 'MU']].map(([wupCityCode, countryCode]) => ({ wupCityCode, countryCode, registryCityIds: wupCityCode === 2 ? ['old:2'] : [], appCityIds: wupCityCode === 1 ? ['live-one'] : [] })) },
        registry: { cities: [{ cityId: 'old:2', parcelStatus: 'verified_sample', sourceIds: ['source-two'], researchFile: 'research/two.json' }] },
        report: { cities: [{ wupCityCode: 2, registryFound: true, verifiedSample: true }] }
    };
}

describe('India and Africa research queue', () => {
    it('deduplicates overlapping cohorts, retains both ranks and includes small African islands', () => {
        const input = fixture();
        const result = buildIndiaAfricaQueue(input);
        expect(result.counts).toMatchObject({ total: 4, india: 1, africa: 3, largest200: 2, growth200: 3, bothQueues: 1, alreadyLive: 1, previousSamplesNotLive: 1 });
        expect(result.cities.find(c => c.wupCityCode === 1)).toMatchObject({ largestRank: 10, growthRank: 4, cohorts: ['largest200', 'growth200'], population2025: 100000 });
        expect(result.cities.some(c => c.countryCode === 'BR')).toBe(false);
        expect(result.cities.some(c => c.countryCode === 'MU')).toBe(true);
        expect(input.largest[0].cohorts).toBeUndefined();
    });

    it('prioritizes prior samples and unresearched cities while retaining provenance and live cities', () => {
        const result = buildIndiaAfricaQueue(fixture());
        expect(result.cities.map(c => c.wupCityCode)).toEqual([2, 4, 5, 1]);
        expect(result.cities.map(c => c.priority)).toEqual([1, 2, 3, 4]);
        expect(result.cities[0]).toMatchObject({ previouslyInvestigated: true, workCategory: 'verify_existing_sample', sourceIds: ['source-two'], previousEvidenceFiles: ['research/two.json'] });
        expect(result.cities[1]).toMatchObject({ previouslyInvestigated: false, workCategory: 'new_city_research', registryFound: null });
        expect(result.cities.at(-1).workCategory).toBe('already_live');
    });

    it('rejects conflicting identities and duplicate rows instead of silently merging them', () => {
        const moved = fixture(); moved.growth[0].lat += 1;
        expect(() => buildIndiaAfricaQueue(moved)).toThrow(/Conflicting queue identity/);
        const duplicate = fixture(); duplicate.largest.push({ ...duplicate.largest[0] });
        expect(() => buildIndiaAfricaQueue(duplicate)).toThrow(/Duplicate largest200/);
        const mismatch = fixture(); mismatch.enrichment.cities[0].countryCode = 'NG';
        expect(() => buildIndiaAfricaQueue(mismatch)).toThrow(/mismatched demographic identity/);
    });

    it('retains newly researched WUP records before demographic links have been refreshed', () => {
        const input = fixture();
        input.registry.cities.push({ cityId: 'wup2025:4', countryCode: 'NG', parcelStatus: 'temporarily_unavailable', latestAssessmentFile: 'research/four.json' });
        const row = buildIndiaAfricaQueue(input).cities.find(city => city.wupCityCode === 4);
        expect(row).toMatchObject({ previouslyInvestigated: true, workCategory: 'retry_existing_city', registryCityIds: ['wup2025:4'], previousEvidenceFiles: ['research/four.json'] });
        input.registry.cities.at(-1).countryCode = 'IN';
        expect(() => buildIndiaAfricaQueue(input)).toThrow(/Conflicting registry country/);
    });
});
