#!/usr/bin/env node
// Join saved population/growth cohorts by WUP identity, retaining prior evidence and live status.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const unique = values => [...new Set(values.filter(Boolean))];

export function buildIndiaAfricaQueue({ largest, growth, countries, enrichment, registry, report }) {
    const africa = new Set(countries.features
        .filter(feature => feature.properties.CONTINENT === 'Africa')
        .map(feature => feature.properties.ISO_A2_EH));
    // Small African countries and territories absent from the coarse Natural Earth outline collection.
    for (const iso of ['CV', 'KM', 'MU', 'SC', 'ST', 'RE', 'YT', 'SH']) africa.add(iso);
    const enriched = new Map(enrichment.cities.filter(city => city.wupCityCode).map(city => [String(city.wupCityCode), city]));
    const records = new Map(registry.cities.map(city => [city.cityId, city]));
    const recordsByWup = new Map();
    for (const city of registry.cities) {
        const code = city.wupCityCode || city.cityId.match(/^wup2025:(\d+)$/)?.[1];
        if (!code) continue;
        const matches = recordsByWup.get(String(code)) || [];
        matches.push(city);
        recordsByWup.set(String(code), matches);
    }
    const displayed = new Map(report.cities.filter(city => city.wupCityCode).map(city => [String(city.wupCityCode), city]));
    const cities = new Map();

    for (const [cohort, input] of [['largest200', largest], ['growth200', growth]]) {
        for (const item of input) {
            if (item.iso2 !== 'IN' && !africa.has(item.iso2)) continue;
            if (!Number.isInteger(item.cityCode) || !Number.isInteger(item.rank)) throw Error('Invalid queue identity/rank');
            const key = `wup2025:${item.cityCode}`;
            let city = cities.get(key);
            if (!city) {
                const demographics = enriched.get(String(item.cityCode));
                if (!demographics || demographics.countryCode !== item.iso2) throw Error(`Missing/mismatched demographic identity: ${key}`);
                const freshRecords = recordsByWup.get(String(item.cityCode)) || [];
                if (freshRecords.some(row => row.countryCode !== item.iso2)) throw Error(`Conflicting registry country: ${key}`);
                const registryCityIds = unique([...demographics.registryCityIds, ...freshRecords.map(row => row.cityId)]);
                const prior = registryCityIds.map(id => records.get(id)).filter(Boolean);
                const view = displayed.get(String(item.cityCode));
                city = {
                    cityId: key, wupCityCode: item.cityCode, name: item.name, country: item.country, countryCode: item.iso2,
                    region: item.iso2 === 'IN' ? 'India' : 'Africa', centerLatLon: [item.lat, item.lon],
                    largestRank: null, growthRank: null, population2025: Math.round(item.pop2025k * 1000),
                    annualGrowthPct2015To2025: demographics.annualGrowthPct2015To2025 ?? null,
                    cohorts: [], appCityIds: [...demographics.appCityIds], registryCityIds,
                    previouslyInvestigated: prior.length > 0,
                    previousStatuses: unique(prior.map(row => row.parcelStatus)),
                    registryFound: view?.registryFound ?? null, verifiedSample: view?.verifiedSample ?? false,
                    sourceIds: unique(prior.flatMap(row => row.sourceIds || [])),
                    previousEvidenceFiles: unique(prior.flatMap(row => [
                        row.latestAssessmentFile, row.latestAttemptFile, row.researchFile, row.retryFile,
                        ...(row.integrationAttempts || []).map(attempt => attempt.evidenceFile)
                    ])),
                    wikipediaUrl: demographics.wikipediaUrl ?? null
                };
                cities.set(key, city);
            } else if (city.countryCode !== item.iso2 || Math.abs(city.centerLatLon[0] - item.lat) > .01 || Math.abs(city.centerLatLon[1] - item.lon) > .01) {
                throw Error(`Conflicting queue identity: ${key}`);
            }
            if (city.cohorts.includes(cohort)) throw Error(`Duplicate ${cohort} identity: ${key}`);
            city.cohorts.push(cohort);
            city[cohort === 'largest200' ? 'largestRank' : 'growthRank'] = item.rank;
            if (cohort === 'growth200') city.annualGrowthPct2015To2025 = item.annualGrowthPct2015To2025;
        }
    }

    const priority = { verify_existing_sample: 0, new_city_research: 1, retry_existing_city: 2, already_live: 3 };
    const rows = [...cities.values()];
    for (const city of rows) {
        city.workCategory = city.appCityIds.length ? 'already_live' : city.verifiedSample ? 'verify_existing_sample'
            : city.previouslyInvestigated ? 'retry_existing_city' : 'new_city_research';
        city.bestCohortRank = Math.min(city.largestRank ?? Infinity, city.growthRank ?? Infinity);
    }
    rows.sort((a, b) => priority[a.workCategory] - priority[b.workCategory] || a.bestCohortRank - b.bestCohortRank || a.cityId.localeCompare(b.cityId));
    rows.forEach((city, index) => { city.priority = index + 1; });
    const count = predicate => rows.filter(predicate).length;
    return {
        schemaVersion: 1, scope: 'india-africa', preparedAt: '2026-10-08',
        sources: ['world-parcels/queue-top200.json', 'world-parcels/queue-growth-top200.json', 'world-parcels/countries.geojson', 'world-parcels/report/city-demographics.json', 'world-parcels/registry.json'],
        methodology: {
            identity: 'Deduplicate by saved WUP 2025 city code, validating country and coordinates; preserve source names and centre points.',
            geography: 'India (IN), or Africa in the saved Natural Earth CONTINENT classification, supplemented by small African island jurisdictions absent from the coarse outline dataset.',
            growth: 'Saved 2015–2025 average annual exponential growth ranking, not a forecast; queue quality filters are unchanged.',
            priority: 'Validate prior polygon samples first, then newly investigated cities, then retries. Already live cities remain listed. Within each category use the better saved cohort rank.',
            research: 'A documented registry/map lead is distinct from a usable polygon feed. New outcomes are recorded separately from this baseline.'
        },
        counts: {
            total: rows.length, india: count(city => city.region === 'India'), africa: count(city => city.region === 'Africa'),
            largest200: count(city => city.largestRank !== null), growth200: count(city => city.growthRank !== null),
            bothQueues: count(city => city.cohorts.length === 2), previouslyInvestigated: count(city => city.previouslyInvestigated),
            newCityResearch: count(city => !city.previouslyInvestigated), alreadyLive: count(city => city.appCityIds.length > 0),
            previousSamplesNotLive: count(city => city.workCategory === 'verify_existing_sample')
        },
        cities: rows
    };
}

export function runBuild(root = ROOT) {
    const read = file => JSON.parse(readFileSync(path.join(root, file), 'utf8'));
    const result = buildIndiaAfricaQueue({
        largest: read('world-parcels/queue-top200.json'), growth: read('world-parcels/queue-growth-top200.json'),
        countries: read('world-parcels/countries.geojson'), enrichment: read('world-parcels/report/city-demographics.json'),
        registry: read('world-parcels/registry.json'), report: read('frontend/data/parcel-coverage-report.json')
    });
    writeFileSync(path.join(root, 'world-parcels/queue-india-africa.json'), `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify(result.counts));
    return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    if (process.argv.includes('--run')) runBuild();
    else console.log('Usage: node scripts/build-india-africa-parcel-queue.mjs --run');
}
