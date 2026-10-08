#!/usr/bin/env node
// Builds the interactive parcel report from current research evidence and versioned demographic snapshots.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectReportEvidence } from './parcel-report-evidence.mjs';
import { countryCategory, mapLinks, summarizeJurisdictions } from '../frontend/js/parcel-coverage-report-model.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GITHUB = 'https://github.com/Poglavar/consensus-builder/blob/colosseum-worlds-fair/';
const readJson = file => JSON.parse(readFileSync(file, 'utf8'));
const finiteOrNull = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const unique = values => [...new Set(values.filter(Boolean))];
const latest = records => records.filter(Boolean).sort((a, b) => (b.date || '').localeCompare(a.date || ''))[0] || null;

export function buildParcelReport({ registry, evidence, enrichment, countryData, coverage, sourceCatalog, growthQueue = [], focusQueue = [] }) {
    const checkedById = new Map([...evidence.cities, ...(evidence.appCities || [])].map(row => [row.cityId, row]));
    const countryEvidence = new Map(evidence.countries.map(row => [row.countryCode, row]));
    const countryNames = new Map(countryData.countries.map(row => [row.code, row.name]));
    const liveById = new Map(coverage.liveCities.map(row => [row.id, row]));
    const sourceById = new Map(registry.sources.map(row => [row.sourceId, row]));
    const growthRankByCode = new Map(growthQueue.map(row => [String(row.cityCode), row.rank]));
    const focusByCode = new Map(focusQueue.map(row => [String(row.wupCityCode), row]));
    const inputCities = enrichment.cities.map(row => ({ ...row, registryCityIds: [...row.registryCityIds], appCityIds: [...row.appCityIds] }));
    const knownIds = new Set(inputCities.flatMap(row => row.registryCityIds));
    const inputByWupCode = new Map(inputCities.filter(row => row.wupCityCode).map(row => [String(row.wupCityCode), row]));
    // New research rows remain visible even before their demographic enrichment is refreshed.
    for (const city of registry.cities) {
        if (knownIds.has(city.cityId)) continue;
        const existing = inputByWupCode.get(String(city.wupCityCode || city.cityId.match(/^wup2025:(\d+)$/)?.[1]));
        if (existing) {
            existing.registryCityIds.push(city.cityId);
            existing.cohorts = unique([...(existing.cohorts || []), 'registry']);
            knownIds.add(city.cityId);
            continue;
        }
        inputCities.push({ id: city.cityId, name: city.name, countryCode: city.countryCode, latitude: city.centerLatLon?.[0], longitude: city.centerLatLon?.[1], registryCityIds: [city.cityId], appCityIds: [], cohorts: ['registry'] });
    }
    // Registry source integrations are explicit links when a source verifies exactly one registry
    // city and the configured app city points back to that same source. Ambiguous or stale links
    // stay unbound; provider/country membership and similar names are not sufficient evidence.
    const appCityByRegistryCity = new Map();
    const ambiguousRegistryCities = new Set();
    // A reviewed city row can explicitly bind one entry of a shared provider. Require both
    // the live configuration and enabled source ledger to agree; names/proximity never bind it.
    for (const city of registry.cities) {
        const liveCity = liveById.get(city.appCityId);
        const source = liveCity && sourceById.get(liveCity.sourceId);
        if (source?.liveIntegration?.status === 'enabled'
            && source.liveIntegration.cityIds?.includes(city.appCityId)
            && city.sourceIds?.includes(liveCity.sourceId)) {
            appCityByRegistryCity.set(city.cityId, city.appCityId);
        }
    }
    for (const source of registry.sources) {
        const integration = source.liveIntegration;
        const appCityId = integration?.appCityId;
        if (integration?.status !== 'enabled' || typeof appCityId !== 'string'
            || !Array.isArray(source.verifiedCityIds) || source.verifiedCityIds.length !== 1) continue;
        const liveCity = liveById.get(appCityId);
        if (!liveCity || liveCity.sourceId !== source.sourceId) continue;
        const [registryCityId] = source.verifiedCityIds;
        if (typeof registryCityId !== 'string' || !registryCityId) continue;
        if (appCityByRegistryCity.has(registryCityId) && appCityByRegistryCity.get(registryCityId) !== appCityId) ambiguousRegistryCities.add(registryCityId);
        else appCityByRegistryCity.set(registryCityId, appCityId);
    }
    for (const city of inputCities) {
        for (const registryCityId of city.registryCityIds) {
            const appCityId = appCityByRegistryCity.get(registryCityId);
            if (appCityId && !ambiguousRegistryCities.has(registryCityId) && !city.appCityIds.includes(appCityId)) {
                city.appCityIds.push(appCityId);
            }
        }
    }
    const cities = inputCities.map(city => {
        if (!countryNames.has(city.countryCode)) throw new Error(`City ${city.id} has no country/territory roster entry: ${city.countryCode}`);
        const checks = [...city.registryCityIds, ...city.appCityIds.map(id => `app:${id}`)].map(id => checkedById.get(id)).filter(Boolean);
        const configuredSources = (sourceCatalog.sources || []).filter(source => source.cityIds?.some(id => city.appCityIds.includes(id)));
        const sourceIds = unique([...checks.flatMap(row => row.sourceIds), ...configuredSources.map(source => source.id), ...city.appCityIds.map(id => liveById.get(id)?.sourceId)]);
        const knownSources = sourceIds.map(id => sourceById.get(id)).filter(Boolean);
        const checkedDateEvidence = latest(checks.map(row => row.checkedDateEvidence));
        const found = checks.some(row => row.registryFound === true) || configuredSources.length > 0;
        const checked = checks.some(row => row.checked);
        return {
            id: city.id, name: city.name, country: countryNames.get(city.countryCode), countryCode: city.countryCode,
            latitude: finiteOrNull(city.latitude), longitude: finiteOrNull(city.longitude),
            registryCityIds: city.registryCityIds, appCityIds: city.appCityIds.filter(id => liveById.has(id)), cohorts: city.cohorts || [],
            wupCityCode: city.wupCityCode ?? null, wupName: city.wupName || null,
            growthRank: growthRankByCode.get(String(city.wupCityCode)) ?? null,
            researchFocusRegion: focusByCode.get(String(city.wupCityCode))?.region ?? null,
            researchPriority: focusByCode.get(String(city.wupCityCode))?.priority ?? null,
            population2015: finiteOrNull(city.population2015), population2025: finiteOrNull(city.population2025),
            annualGrowthPct2015To2025: finiteOrNull(city.annualGrowthPct2015To2025), populationPlausibility2025: city.populationPlausibility2025 || null,
            populationMatch: city.populationMatch || null,
            checked, checkedDate: checkedDateEvidence?.date || null, checkedDateEvidence,
            registryFound: found ? true : checked && checks.some(row => row.registryFound === false) ? false : null,
            registryFindingBasis: checks.some(row => row.registryFound === true) ? 'recorded_evidence' : configuredSources.length ? 'configured_source' : null,
            registryBasis: unique(checks.map(row => row.registryBasis)).join('\n') || null,
            verifiedSample: checks.some(row => row.verifiedSample), impliedParcelsTried: checks.some(row => row.impliedParcelsTried === true) ? true : null,
            sourceIds, evidenceUrls: unique([...checks.flatMap(row => row.evidenceUrls), ...knownSources.map(source => source.endpoint)]).filter(value => typeof value === 'string' && /^https?:\/\//.test(value)),
            evidenceFiles: unique([...checks.flatMap(row => row.evidenceFiles), ...configuredSources.map(source => source.evidenceFile)]),
            ...mapLinks(city.latitude, city.longitude), wikipediaUrl: city.wikipediaUrl || null, wikipediaEvidence: city.wikipediaEvidence || null
        };
    }).sort((a, b) => a.name.localeCompare(b.name, 'en') || a.id.localeCompare(b.id));
    if (new Set(cities.map(row => row.id)).size !== cities.length) throw new Error('Duplicate report city identities');
    const countries = countryData.countries.map(country => {
        const record = countryEvidence.get(country.code);
        const countryCities = cities.filter(city => city.countryCode === country.code);
        const statisticsIncluded = country.kind !== 'de_facto_territory' && !country.overlapsParent;
        const row = {
            code: country.code, name: country.name, iso3: country.iso3 || null, m49: country.m49 ?? null, kind: country.kind,
            overlapsParent: country.overlapsParent || null, statisticsIncluded,
            landAreaKm2: finiteOrNull(country.stats?.landAreaKm2), builtUpAreaKm2: finiteOrNull(country.stats?.builtUpAreaKm2), population: finiteOrNull(country.stats?.population),
            statisticsYear: country.stats?.year || null, missingStatisticsReason: country.missingReason || null,
            citiesChecked: countryCities.filter(city => city.checked).length,
            citiesWithRegistry: countryCities.filter(city => city.registryFound === true).length,
            checked: record?.checked || false, checkedDate: record?.checkedDate || null,
            nationalCadastreFound: record?.nationalCadastreFound ?? null,
            verifiedNationalSample: record?.verifiedNationalSample || false, countryCoverageSampled: record?.countryCoverageSampled || false,
            subnationalEvidence: record?.subnationalEvidence || null, parentSource: record?.parentSource || false,
            probeStatus: record?.probeStatus || null, evidenceFiles: record?.evidenceFiles || [], evidenceUrls: record?.evidenceUrls || []
        };
        row.category = countryCategory(row);
        return row;
    }).sort((a, b) => a.name.localeCompare(b.name, 'en'));
    if (new Set(countries.map(row => row.code)).size !== countries.length) throw new Error('Duplicate report country identities');
    const summary = summarizeJurisdictions(countries, countryData.world);
    const dates = [...cities, ...countries].map(row => row.checkedDate).filter(Boolean).sort();
    return {
        schemaVersion: 1,
        purpose: 'Interactive inventory of parcel-registry research. Area shares describe jurisdictions with evidence, not cadastral polygon completeness.',
        metadata: {
            asOf: dates.at(-1) || enrichment.asOf, demographicSnapshotDate: enrichment.asOf, statisticsYear: 2025,
            cityCount: cities.length, countryCount: countries.length, statisticalJurisdictions: countries.filter(row => row.statisticsIncluded && row.landAreaKm2 !== null).length,
            checkedCityCount: cities.filter(row => row.checked).length, uncheckedCityCount: cities.filter(row => !row.checked).length,
            cityRegistryFoundCount: cities.filter(row => row.registryFound === true).length, verifiedCitySampleCount: cities.filter(row => row.verifiedSample).length,
            nationalCadastreCount: countries.filter(row => row.nationalCadastreFound === true).length, countryTwoRegionCount: countries.filter(row => row.countryCoverageSampled).length,
            populationMatchedCount: cities.filter(row => row.population2025 !== null).length, growthMatchedCount: cities.filter(row => row.annualGrowthPct2015To2025 !== null).length,
            checkedCitiesMissingDate: cities.filter(row => row.checked && !row.checkedDate).length, wikiCityCount: cities.filter(row => row.wikipediaUrl).length,
            configuredAppCityCount: coverage.liveCities.length, unmatchedStatisticalAmounts: summary.residual,
            warnings: evidence.warnings
        },
        world: countryData.world, breakdown: summary.rows, cities, countries,
        methodology: {
            countries: countryData.methodology, cities: enrichment.methodNotes || [],
            checked: 'A recorded city investigation, including failed attempts. A configured app source can establish registry identification without supplying a city-specific investigation date.',
            registryFound: 'Yes for city-scoped registry evidence (including local registry offices or cadastral maps), a verified parcel sample, or a source configured for that city. Registry presence does not imply a public geometry API. Broader regional leads with unresolved target coverage remain null; a recorded unsuccessful search is not proof that no registry exists.',
            growthRanking: 'Saved UN WUP 2025 queue: average annual exponential population growth during 2015–2025, at least 50,000 people at both endpoints, and Moderate or High 2025 population plausibility. Rank is among this quality-filtered urban-centre cohort, not municipalities or a forecast.',
            nationalCadastreFound: 'Identified national, parent-country, credentialed or viewer-only cadastre, or a recorded multi-region sample. This is not a claim of territorial completeness.',
            impliedParcelsTried: 'True only for a documented inferred-parcel experiment. A missing historical record remains null.',
            cityPopulationAggregation: 'City populations are not added to estimate world coverage. WUP urban centres can overlap municipal identities; jurisdiction statistics supply the additive denominators.',
            countryRoster: countryData.scope,
            rebuild: 'node scripts/build-parcel-coverage-report.mjs --run'
        },
        sources: [
            { name: 'Project parcel research registry and linked investigation records', url: `${GITHUB}world-parcels/registry.json` },
            { name: 'Configured parcel sources and adapter evidence', url: `${GITHUB}backend/parcels/source-catalog.json` },
            { name: 'UN DESA, World Urbanization Prospects 2025 — city population estimates', url: 'https://population.un.org/wup/downloads?tab=Cities', accessedAt: enrichment.asOf },
            { name: 'UN DESA, average annual population growth definition', url: 'https://population.un.org/wup/glossary-demographic-terms', accessedAt: enrichment.asOf },
            ...countryData.sources.map(source => ({ name: source.title || source.name, url: source.url, accessedAt: source.accessed || source.downloaded || null })),
            { name: 'Wikipedia and Wikidata — verified article identities', url: 'https://www.wikidata.org/wiki/Wikidata:Main_Page', accessedAt: enrichment.asOf },
            { name: 'Inferred parcel experiments — recorded evaluation', url: `${GITHUB}world-parcels/guess-spike/README.md` }
        ]
    };
}

export function runBuild(repoRoot = REPO) {
    const registry = readJson(path.join(repoRoot, 'world-parcels/registry.json'));
    const coverage = readJson(path.join(repoRoot, 'frontend/data/world-coverage.json'));
    const sourceCatalog = readJson(path.join(repoRoot, 'backend/parcels/source-catalog.json'));
    const report = buildParcelReport({
        registry, evidence: collectReportEvidence({ registry, repoRoot, appCities: coverage.liveCities, sourceCatalog }),
        enrichment: readJson(path.join(repoRoot, 'world-parcels/report/city-demographics.json')),
        growthQueue: readJson(path.join(repoRoot, 'world-parcels/queue-growth-top200.json')),
        focusQueue: readJson(path.join(repoRoot, 'world-parcels/queue-india-africa.json')).cities,
        countryData: readJson(path.join(repoRoot, 'world-parcels/report/country-statistics.json')),
        coverage, sourceCatalog
    });
    const out = path.join(repoRoot, 'frontend/data/parcel-coverage-report.json');
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ output: path.relative(repoRoot, out), ...report.metadata }, null, 2));
    return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    if (process.argv.includes('--run')) runBuild();
    else console.log('Usage: node scripts/build-parcel-coverage-report.mjs --run\nRebuilds frontend/data/parcel-coverage-report.json from research and versioned demographic inputs.');
}
