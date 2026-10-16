#!/usr/bin/env node
// Admits technically qualified parcel cities to the app. Qualification is the gate: it already
// proved the source is reachable and the production adapter reads it correctly. For every city whose
// latest exported outcome is `qualified` and that is not live yet, this checks that its evidence is
// intact and describes the production descriptor (nine gates, metric and independent metric audit,
// identity and query contract), then exports the evidence and writes the app city config, catalog
// scope, registry, demographics, labels and an admission manifest in the schema
// backend/test/qualified-city-release.test.js verifies. No provider is contacted.
//
// With --switch, a city that is already live moves to the source it newly qualified on (a better
// source for the same place, e.g. an area service replacing a point lookup): its city config keeps
// its id, centre and label, and only its parcel source, catalog scope and registry bindings change.
// The manifest records the source it switched from.
//
// Usage: node scripts/admit-qualified-cities.mjs --state <qualification state dir> [--state ...]
//          --release <name> [--exclude <code=reason>]... [--codes <a,b>] [--outcomes <file>]
//          [--country-config <json>] [--switch] [--apply]
// Without --apply nothing is written; the plan and any refusal are printed.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { alignmentContractHash } from './lib/parcel-alignment.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WUP = 'tmp/overnight-cities-2026-10-09/WUP2025-DB-DEGURBA-Cities-Population-Surface-Data.csv.gz';
const GATES = ['classification', 'exactIds', 'stableGeometry', 'explicitAbsence', 'sampling', 'completeness', 'binding', 'metric', 'alignment'];
const BLOCKERS = ['invalidCount', 'duplicateIdCount', 'conflictingSameIdGeometryCount', 'exactGeometryDuplicateCount', 'overlapPairCount', 'operationErrorCount'];
const CONTRACT = ['identityKind', 'lookupCellSize', 'attributeFilters', 'attributeExclusions', 'attributeNotNull', 'attributeNull', 'featureType', 'boundsQueryMode', 'idsQueryMode', 'boundsSrid', 'boundsProjection', 'queryFormat', 'nativeGeometryMode', 'disjointParts', 'overlapResolution', 'zoom', 'layer', 'groupFields', 'extent'];
const POINT_ADAPTERS = new Set(['pl-uldk-point', 'tkgm-point', 'msda-point']);
// Country display names for labels; the rest come from existing labels of the same country.
const COUNTRY_NAMES = {
    BE: { en: 'Belgium', es: 'Bélgica', hr: 'Belgija', sr: 'Белгија' },
    LV: { en: 'Latvia', es: 'Letonia', hr: 'Latvija', sr: 'Летонија' },
    LT: { en: 'Lithuania', es: 'Lituania', hr: 'Litva', sr: 'Литванија' },
    EE: { en: 'Estonia', es: 'Estonia', hr: 'Estonija', sr: 'Естонија' },
    UA: { en: 'Ukraine', es: 'Ucrania', hr: 'Ukrajina', sr: 'Украјина' },
    SI: { en: 'Slovenia', es: 'Eslovenia', hr: 'Slovenija', sr: 'Словенија' }
};
const CURRENCY = {
    US: ['en-US', 'USD'], DE: ['de-DE', 'EUR'], NL: ['nl-NL', 'EUR'], PL: ['pl-PL', 'PLN'], BE: ['nl-BE', 'EUR'], ET: ['am-ET', 'ETB'],
    FR: ['fr-FR', 'EUR'], GR: ['el-GR', 'EUR'], IL: ['he-IL', 'ILS'], NZ: ['en-NZ', 'NZD'], LV: ['lv-LV', 'EUR'],
    LT: ['lt-LT', 'EUR'], EE: ['et-EE', 'EUR'], BR: ['pt-BR', 'BRL'], AU: ['en-AU', 'AUD'], ZM: ['en-ZM', 'ZMW'],
    ES: ['es-ES', 'EUR'], UA: ['uk-UA', 'UAH'], SI: ['sl-SI', 'EUR'], IT: ['it-IT', 'EUR'], GB: ['en-GB', 'GBP'], IN: ['en-IN', 'INR']
};
const LOCALES = ['en', 'es', 'hr', 'sr'];
const TWIN_KM = 5;
const haversineKm = (lat1, lon1, lat2, lon2) => {
    const r = Math.PI / 180, a = Math.sin((lat2 - lat1) * r / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin((lon2 - lon1) * r / 2) ** 2;
    return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(a)));
};

const ts = () => new Date().toISOString();
const log = message => console.log(`[${ts()}] ${message}`);
const read = rel => fs.readFileSync(path.join(REPO, rel), 'utf8');
const readJson = file => JSON.parse(fs.readFileSync(path.isAbsolute(file) ? file : path.join(REPO, file), 'utf8'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const writeJson = (rel, value, indent = 2) => fs.writeFileSync(path.join(REPO, rel), `${JSON.stringify(value, null, indent)}\n`);

function parseArgs(argv) {
    const args = { states: [], exclude: new Map(), apply: false, release: null, codes: null, switch: false,
        outcomes: null, countryConfig: null };
    for (let i = 0; i < argv.length; i++) {
        const flag = argv[i];
        if (flag === '--state') args.states.push(path.resolve(argv[++i]));
        else if (flag === '--release') args.release = argv[++i];
        else if (flag === '--exclude') { const [code, ...reason] = argv[++i].split('='); args.exclude.set(code, reason.join('=') || 'excluded at admission'); }
        else if (flag === '--codes') args.codes = new Set(argv[++i].split(','));
        else if (flag === '--outcomes') args.outcomes = path.resolve(argv[++i]);
        else if (flag === '--country-config') args.countryConfig = path.resolve(argv[++i]);
        else if (flag === '--apply') args.apply = true;
        else if (flag === '--switch') args.switch = true;
        else if (flag === '--help') args.help = true;
        else throw new Error(`unknown argument ${flag}`);
    }
    if (args.help || !args.states.length || !/^\d{4}-\d{2}-\d{2}[\w-]*$/.test(args.release || '')) {
        console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter(l => l.startsWith('//')).join('\n'));
        process.exit(args.help ? 0 : 2);
    }
    return args;
}

// Minimal RFC 4180 reader for the WUP CSV (city names carry quoted commas).
function csvRows(text) {
    const rows = []; let row = [], field = '', quoted = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quoted) { if (c === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (c === '"') quoted = false; else field += c; }
        else if (c === '"') quoted = true;
        else if (c === ',') { row.push(field); field = ''; }
        else if (c === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
        else field += c;
    }
    if (field || row.length) { row.push(field); rows.push(row); }
    return rows;
}

function wupIndex() {
    const rows = csvRows(zlib.gunzipSync(fs.readFileSync(path.join(REPO, WUP))).toString('utf8').replace(/^﻿/, ''));
    const header = rows.shift();
    const col = name => header.indexOf(name);
    const byCode = new Map();
    for (const r of rows) {
        const code = r[col('City_Code')], year = r[col('Year')];
        if (!code || !['2015', '2025'].includes(year)) continue;
        const entry = byCode.get(code) || {};
        entry[year] = { pop: Number(r[col('Pop')]) * 1000, name: r[col('City_Name')], iso2: r[col('ISO2_Code')], country: r[col('Location')],
            lat: Number(r[col('PWCent_Latitude')]), lon: Number(r[col('PWCent_Longitude')]) };
        byCode.set(code, entry);
    }
    return byCode;
}

function latestOutcomes(outcomesPath = path.join(REPO, 'world-parcels/research/qualification-outcomes')) {
    const files = fs.statSync(outcomesPath).isDirectory()
        ? fs.readdirSync(outcomesPath).filter(n => n.endsWith('.json')).sort().map(n => path.join(outcomesPath, n))
        : [outcomesPath];
    const latest = new Map();
    for (const file of files) {
        for (const city of readJson(file).cities || []) {
            const key = String(city.cityCode), prev = latest.get(key);
            if (!prev || (city.finishedAt || '') >= (prev.finishedAt || '')) latest.set(key, city);
        }
    }
    return latest;
}

export function validateCountryConfig(config, expectedCountryCode = null) {
    const countryCode = config?.countryCode;
    const currency = config?.currency;
    if (!/^[A-Z]{2}$/.test(countryCode || '') || (expectedCountryCode && countryCode !== expectedCountryCode)) {
        throw new Error('country config countryCode must match the candidate ISO-3166 alpha-2 code');
    }
    const englishName = new Intl.DisplayNames(['en'], { type: 'region' }).of(countryCode);
    if (!englishName || englishName === countryCode || englishName === 'Unknown Region') throw new Error(`unsupported ISO-3166 alpha-2 country code ${countryCode}`);
    if (!currency || typeof currency.locale !== 'string' || !currency.locale.trim()
        || !/^[A-Z]{3}$/.test(currency.code || '')) throw new Error('country config needs a valid locale and three-letter currency code');
    let locale;
    try { locale = Intl.getCanonicalLocales(currency.locale)[0]; new Intl.NumberFormat(locale); }
    catch { throw new Error('country config currency locale is not a valid Intl locale'); }
    const supportedCurrencies = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('currency') : [];
    if (!supportedCurrencies.includes(currency.code)) throw new Error(`unsupported ISO-4217 currency code ${currency.code}`);
    return { countryCode, currency: { locale, code: currency.code } };
}

// Existing opt-in sources stay opt-in. A newly discovered source has no production
// default policy yet; after city-specific qualification, admission makes that new
// source the default for its first narrowly scoped production city binding.
export function sourceActivationDecision(candidateDescriptor, existingDescriptor = null) {
    if (existingDescriptor) {
        if (existingDescriptor.defaultForCity === false) {
            return { eligible: false, descriptor: existingDescriptor, activation: null };
        }
        return { eligible: true, descriptor: existingDescriptor,
            activation: { policy: 'existing_catalog_default', defaultForCity: true } };
    }
    const descriptor = { ...candidateDescriptor, cityIds: [], defaultForCity: true };
    return { eligible: true, descriptor, activation: {
        policy: 'newly_qualified_city_default', candidateDefaultForCity: candidateDescriptor.defaultForCity ?? null,
        defaultForCity: true, scope: 'admitted_city_ids',
        reason: 'new source descriptor promoted after nine-gate qualification; catalog scope is limited to admitted cities'
    } };
}

function countryName(code, locale) {
    return new Intl.DisplayNames([locale], { type: 'region' }).of(code);
}

export function currencyFor(countryCode, explicit) {
    if (explicit) return validateCountryConfig(explicit, countryCode).currency;
    const known = CURRENCY[countryCode];
    return known ? { locale: known[0], code: known[1] } : null;
}

// Final evidence of every technical-qualified city in the given runner state dirs (latest run wins).
function evidenceIndex(stateDirs) {
    const index = new Map();
    for (const dir of stateDirs) {
        const state = readJson(path.join(dir, 'state.json'));
        for (const [code, entry] of Object.entries(state.cities)) {
            if (entry.status !== 'technical-qualified') continue;
            const files = entry.evidenceFiles || [];
            const qualification = files.find(f => f.endsWith('evidence/qualification.json'));
            const candidate = files.find(f => f.endsWith('candidate.json'));
            if (!qualification || !candidate) continue;
            const cityDir = path.join(dir, 'cities', code);
            const evidenceDir = path.dirname(path.join(cityDir, qualification));
            const record = { code, finishedAt: entry.finishedAt || '', candidate: path.join(cityDir, candidate),
                qualification: path.join(evidenceDir, 'qualification.json'), metric: path.join(evidenceDir, 'metric-report.json'),
                independent: path.join(evidenceDir, 'independent-metric-report.json'), cache: path.join(evidenceDir, 'full-safe.geojson'), stateDir: dir };
            Object.assign(record, { alignment: path.join(evidenceDir, 'alignment-report.json'),
                independentAlignment: path.join(evidenceDir, 'independent-alignment-report.json'),
                alignmentEvidence: path.join(evidenceDir, 'alignment-evidence.json'),
                alignmentMetadata: path.join(evidenceDir, 'alignment-metadata.json'),
                alignmentNative: path.join(evidenceDir, 'alignment-native.json') });
            const prev = index.get(code);
            if (!prev || record.finishedAt >= prev.finishedAt) index.set(code, record);
        }
    }
    return index;
}

const sameUrl = (a, b) => { try { return new URL(a).href === new URL(b).href; } catch { return false; } };

// Every check the release test makes, applied before anything is written.
export function verifyAdmissionEvidence(evidence, catalogSource) {
    for (const key of ['candidate', 'qualification', 'metric', 'independent', 'cache', 'alignment',
        'independentAlignment', 'alignmentEvidence', 'alignmentMetadata', 'alignmentNative']) {
        if (!fs.existsSync(evidence[key])) return `missing ${key} evidence`;
    }
    const candidateBytes = fs.readFileSync(evidence.candidate);
    const candidate = JSON.parse(candidateBytes);
    const qualification = readJson(evidence.qualification);
    const metric = readJson(evidence.metric);
    const independent = readJson(evidence.independent);
    if (qualification.status !== 'technical-qualified') return 'qualification status is not technical-qualified';
    if (!GATES.every(gate => qualification.checks?.[gate]?.passed === true)) return 'not every gate passed';
    if (qualification.candidateSha256 !== sha256(candidateBytes)) return 'candidate hash differs from the qualification record';
    if (metric.inputSha256 !== qualification.cacheSha256) return 'metric input is not the qualification cache';
    if (sha256(fs.readFileSync(evidence.cache)) !== qualification.cacheSha256) return 'cache bytes differ from the qualification record';
    if (independent.inputSha256 !== metric.inputSha256 || independent.geometryChangedOrRepaired !== false || independent.geometryPass !== true
        || BLOCKERS.some(field => independent[field] !== 0)) return 'independent metric audit does not pass';
    if (!catalogSource) return `source ${candidate.descriptor?.id} is not in the catalog`;
    const d = candidate.descriptor;
    const alignment = readJson(evidence.alignment), independentAlignment = readJson(evidence.independentAlignment);
    const alignmentEvidence = readJson(evidence.alignmentEvidence);
    const contractSha256 = alignmentContractHash(d);
    if (alignmentContractHash(catalogSource) !== contractSha256) return 'candidate coordinate contract differs from the production catalog';
    for (const report of [alignment, independentAlignment]) {
        if (report.passed !== true || report.sourceId !== d.id || report.cityCode !== String(candidate.city.code)
            || report.contractSha256 !== contractSha256 || report.cacheSha256 !== qualification.cacheSha256
            || report.evidenceSha256 !== sha256(fs.readFileSync(evidence.alignmentEvidence))
            || report.nativeSha256 !== sha256(fs.readFileSync(evidence.alignmentNative))
            || report.metadataSha256 !== sha256(fs.readFileSync(evidence.alignmentMetadata))
            || report.sourceGeometryChanged !== false || report.fittedOffsetApplied !== false
            || report.bestOperationAvailable !== true || report.ballparkAllowed !== false
            || typeof report.maxVertexDifferenceM !== 'number' || !Number.isFinite(report.maxVertexDifferenceM)
            || typeof report.maxBoundaryDifferenceM !== 'number' || !Number.isFinite(report.maxBoundaryDifferenceM)
            || report.maxBoundaryDifferenceM > 0.25 || report.toleranceM !== 0.25
            || report.nativeCrs !== alignmentEvidence.nativeCrs
            || report.nativeAxisOrder !== alignmentEvidence.nativeAxisOrder) return 'independent coordinate alignment audit does not pass or bind to actual source evidence';
    }
    if (!sameUrl(d.endpoint ?? catalogSource.endpoint, catalogSource.endpoint) || d.idPrefix !== catalogSource.idPrefix
        || (d.idField ?? null) !== (catalogSource.idField ?? null) || JSON.stringify(d.idFields ?? null) !== JSON.stringify(catalogSource.idFields ?? null)) {
        return 'candidate identity differs from the production catalog';
    }
    const contract = CONTRACT.find(field => JSON.stringify(d[field] ?? null) !== JSON.stringify(catalogSource[field] ?? null));
    if (contract) return `candidate query contract differs from the catalog (${contract})`;
    return { candidate, candidateBytes, qualification, metric, independent, alignment, independentAlignment };
}

function slug(name) {
    return name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss').replace(/ł/gi, 'l')
        .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

// Replaces absolute local paths in exported evidence with their file names.
function sanitize(value) {
    if (typeof value === 'string') return /^(\/Users\/|\/home\/|\/root\/|\/private\/|\/tmp\/|\/var\/)/.test(value) ? path.basename(value) : value;
    if (Array.isArray(value)) return value.map(sanitize);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitize(v)]));
    return value;
}

const quote = s => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

function parcelsLine(descriptor) {
    const point = POINT_ADAPTERS.has(descriptor.adapter);
    const attribution = descriptor.attribution || `${descriptor.operator || descriptor.name} · parcels · adapted`;
    return `            parcels: { strategy: ${point ? "'point'" : "'grid'"}, gridSize: ${point ? 0.0025 : 0.001}, source: 'parcel-source', sourceId: ${quote(descriptor.id)}, idPrefix: ${quote(descriptor.idPrefix)}, requiresBackend: true, ownership: false, liveRadiusKm: 8, attribution: ${quote(attribution)} },`;
}

// Replaces the one-line parcels setting of an existing city entry; nothing else in it changes.
function switchParcelsLine(configText, appCityId, descriptor) {
    const start = configText.indexOf(`\n        ${appCityId}: {\n`);
    if (start < 0) throw new Error(`city-config.js has no entry ${appCityId}`);
    const end = configText.indexOf('\n        },', start);
    const block = configText.slice(start, end);
    const lines = block.split('\n').filter(line => /^ {12}parcels: \{.*\},$/.test(line));
    if (lines.length !== 1) throw new Error(`${appCityId}: expected one single-line parcels setting, found ${lines.length}`);
    return configText.slice(0, start) + block.replace(lines[0], parcelsLine(descriptor)) + configText.slice(end);
}

function cityConfigEntry(item) {
    const { appCityId, code, label, center, descriptor, countryCode } = item;
    const { locale, code: currency } = item.currency;
    const q = quote;
    return [
        `        ${appCityId}: {`,
        `            id: ${q(appCityId)}, wupCityCode: ${q(code)},`,
        `            label: translateCityText(${q(`city.labels.${appCityId}`)}, ${q(label)}),`,
        `            currency: { locale: ${q(locale)}, code: ${q(currency)} },`,
        `            map: { initialView: { type: 'center', zoom: SHARED_DEFAULT_ZOOM }, defaultCenter: [${center[0]}, ${center[1]}], defaultZoom: SHARED_DEFAULT_ZOOM, parcelZoomRange: { min: 17, max: Infinity }, latLngPadding: 0.08 },`,
        `            projection: { datasetCrs: 'EPSG:4326', definition: '+proj=longlat +datum=WGS84 +no_defs', fallbackLatLng: [${center[0]}, ${center[1]}], fallbackDataset: [${center[1]}, ${center[0]}] },`,
        parcelsLine(descriptor),
        `            buildings: { source: 'overture-tiles' }, sidebar: { disabledSections: ['parcelBlocks', 'roads', 'areaMonitor'] }, parcelBuilder: { url: 'https://urbangametheory.xyz/codechecker/' }`,
        `        },`
    ].join('\n');
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const { parseCityConfigs } = await import(pathToFileURL(path.join(REPO, 'scripts/build-world-coverage.mjs')));
    const catalogDoc = readJson('backend/parcels/source-catalog.json');
    const registry = readJson('world-parcels/registry.json');
    const demographics = readJson('world-parcels/report/city-demographics.json');
    const i18n = Object.fromEntries(LOCALES.map(l => [l, readJson(`frontend/i18n/${l}.json`)]));
    const configText = read('frontend/js/city-config.js');
    const configs = parseCityConfigs(configText);
    const configIds = new Set([...configText.matchAll(/^ {8}([a-z0-9_]+): \{$/gm)].map(m => m[1]));

    // Live already: configured WUP codes, earlier admissions and the coverage report's app bindings.
    const live = new Set(configs.map(c => String(c.wupCityCode)).filter(c => c !== 'undefined'));
    for (const name of fs.readdirSync(path.join(REPO, 'world-parcels/research')).filter(n => /^qualification-admission-.*\.json$/.test(n))) {
        for (const city of readJson(`world-parcels/research/${name}`).cities) live.add(String(city.cityCode));
    }
    for (const c of readJson('frontend/data/parcel-coverage-report.json').cities || []) {
        if (c.wupCityCode && (c.appCityIds || []).some(id => configIds.has(id))) live.add(String(c.wupCityCode));
    }

    // Country names per locale from existing labels of admitted cities.
    const countryNames = Object.fromEntries(LOCALES.map(l => [l, {}]));
    for (const row of registry.cities) {
        if (!row.appCityId || !row.countryCode) continue;
        for (const l of LOCALES) {
            const label = i18n[l].city?.labels?.[row.appCityId];
            if (label?.includes(', ') && !countryNames[l][row.countryCode]) countryNames[l][row.countryCode] = label.slice(label.lastIndexOf(', ') + 2);
        }
    }
    for (const [cc, names] of Object.entries(COUNTRY_NAMES)) for (const l of LOCALES) countryNames[l][cc] ??= names[l];

    const outcomes = latestOutcomes(args.outcomes || undefined);
    const evidence = evidenceIndex(args.states);
    const wup = wupIndex();
    const explicitCountry = args.countryConfig ? validateCountryConfig(readJson(args.countryConfig)) : null;
    const plan = [], refused = [];
    const taken = new Set(configIds);
    for (const [code, outcome] of [...outcomes].sort((a, b) => Number(a[0]) - Number(b[0]))) {
        if (outcome.outcome !== 'qualified' || live.has(code) || (args.codes && !args.codes.has(code))) continue;
        if (args.exclude.has(code)) { refused.push({ code, name: outcome.cityName, reason: args.exclude.get(code) }); continue; }
        const ev = evidence.get(code);
        if (!ev) { refused.push({ code, name: outcome.cityName, reason: 'no evidence in the given state dirs' }); continue; }
        const candidate = readJson(ev.candidate);
        const candidateDescriptor = candidate.descriptor;
        const candidateSourceId = candidateDescriptor?.id;
        const existingCatalogSource = catalogDoc.sources.find(s => s.id === candidateSourceId) || null;
        const catalogSource = existingCatalogSource || candidateDescriptor;
        const checked = verifyAdmissionEvidence(ev, catalogSource);
        if (typeof checked === 'string') { refused.push({ code, name: outcome.cityName, reason: checked }); continue; }
        const activation = sourceActivationDecision(candidateDescriptor, existingCatalogSource);
        if (!activation.eligible) {
            refused.push({ code, name: outcome.cityName,
                reason: `${catalogSource.id} is an existing opt-in alternative (defaultForCity false)` });
            continue;
        }
        const selectedSource = activation.descriptor;
        const w = wup.get(code)?.['2025'];
        const countryCode = selectedSource.countryCode || outcome.countryCode;
        let currency;
        const candidateCountry = candidate.city?.currency ? { countryCode, currency: candidate.city.currency } : null;
        try { currency = currencyFor(countryCode, explicitCountry || candidateCountry); }
        catch (error) { refused.push({ code, name: outcome.cityName, reason: error.message }); continue; }
        if (!currency) { refused.push({ code, name: outcome.cityName, reason: `no verified currency configuration for ${countryCode}` }); continue; }
        for (const l of LOCALES) countryNames[l][countryCode] ??= countryName(countryCode, l);
        if (!LOCALES.every(l => countryNames[l][countryCode])) { refused.push({ code, name: outcome.cityName, reason: `no localized country label for ${countryCode}` }); continue; }
        if (!existingCatalogSource) {
            const endpoint = candidateDescriptor?.endpoint;
            if (!candidateDescriptor || !candidateSourceId || !/^https?:\/\//i.test(endpoint || '')
                || !candidateDescriptor.adapter || !candidateDescriptor.idPrefix || !candidateDescriptor.name) {
                refused.push({ code, name: outcome.cityName, reason: 'new source descriptor lacks a public HTTP(S) endpoint, adapter, display name or ID prefix' }); continue;
            }
            // The production descriptor is a separate copy. The candidate and its hash stay unchanged.
            selectedSource.countryCode ||= countryCode;
        }
        // A live city configured without a WUP code is the same place when its centre is this close.
        const pointLatLon = [checked.candidate.city.point[1], checked.candidate.city.point[0]];
        const twin = configs.find(c => Number.isFinite(c.lat) && haversineKm(c.lat, c.lon, ...pointLatLon) < TWIN_KM
            && (catalogDoc.sources.find(s => s.id === c.sourceId)?.countryCode ?? countryCode) === countryCode);
        if (twin) { refused.push({ code, name: outcome.cityName, reason: `already live as ${twin.id} (${haversineKm(twin.lat, twin.lon, ...pointLatLon).toFixed(1)} km away)` }); continue; }
        let appCityId = slug(outcome.cityName);
        if (taken.has(appCityId)) appCityId = `${appCityId}_${(selectedSource.stateCode || countryCode).toLowerCase()}`;
        if (taken.has(appCityId)) appCityId = `${appCityId}_${code}`;
        taken.add(appCityId);
        const point = checked.candidate.city.point; // [longitude, latitude]
        const metricCrs = checked.metric.metricCrs || checked.qualification.checks.metric.metricCrs;
        // Same-named cities in one country are told apart by their state or region code.
        const takenLabels = new Set([...Object.values(i18n.en.city?.labels || {}), ...plan.map(item => item.label)]);
        const qualifier = takenLabels.has(`${outcome.cityName}, ${countryNames.en[countryCode]}`) ? ` (${selectedSource.stateCode || code})` : '';
        plan.push({ code, appCityId, outcome, evidence: ev, ...checked, catalogSource: selectedSource,
            activationDecision: activation.activation, countryCode, currency, qualifier,
            name: outcome.cityName, label: `${outcome.cityName}${qualifier}, ${countryNames.en[countryCode]}`,
            center: [point[1], point[0]], metricSrid: Number(String(metricCrs).split(':')[1]),
            population2025: w?.pop ?? null, population2015: wup.get(code)?.['2015']?.pop ?? null, countryName: countryNames.en[countryCode] });
    }

    // Switches: a live city whose newest technical-qualified evidence names another catalog source.
    if (args.switch) {
        for (const [code, ev] of [...evidence].sort((a, b) => Number(a[0]) - Number(b[0]))) {
            const config = configs.find(c => String(c.wupCityCode) === code);
            if (!config || (args.codes && !args.codes.has(code))) continue;
            const candidate = readJson(ev.candidate);
            const name = candidate.city?.name || code;
            const catalogSource = catalogDoc.sources.find(s => s.id === candidate.descriptor?.id);
            if (catalogSource && config.sourceId === catalogSource.id) continue;
            if (args.exclude.has(code)) { refused.push({ code, name, reason: args.exclude.get(code) }); continue; }
            const checked = verify(ev, catalogSource);
            if (typeof checked === 'string') { refused.push({ code, name, reason: checked }); continue; }
            if (catalogSource.defaultForCity === false) { refused.push({ code, name, reason: `${catalogSource.id} is an opt-in alternative (defaultForCity false)` }); continue; }
            const countryCode = catalogSource.countryCode || config.countryCode;
            const metricCrs = checked.metric.metricCrs || checked.qualification.checks.metric.metricCrs;
            const point = checked.candidate.city.point; // [longitude, latitude]
            plan.push({ code, appCityId: config.id, switchedFrom: config.sourceId, outcome: { cityName: name }, evidence: ev, ...checked,
                catalogSource, countryCode, qualifier: '', name, label: null, center: [config.lat, config.lon], wupPoint: [point[1], point[0]],
                metricSrid: Number(String(metricCrs).split(':')[1]), population2025: wup.get(code)?.['2025']?.pop ?? null,
                population2015: wup.get(code)?.['2015']?.pop ?? null, countryName: countryNames.en[countryCode] });
        }
    }

    // Production descriptors as they will be after admission (scope + per-city metric frame).
    const nextCatalog = structuredClone(catalogDoc);
    for (const item of plan.filter(entry => entry.switchedFrom)) {
        const previous = nextCatalog.sources.find(s => s.id === item.switchedFrom);
        if (!previous) continue;
        previous.cityIds = (previous.cityIds || []).filter(id => id !== item.appCityId);
        if (previous.metricSridByCity) delete previous.metricSridByCity[item.appCityId];
    }
    for (const item of plan) {
        let source = nextCatalog.sources.find(s => s.id === item.catalogSource.id);
        if (!source) {
            source = structuredClone(item.catalogSource);
            source.cityIds = [];
            nextCatalog.sources.push(source);
        }
        source.cityIds = [...new Set([...(source.cityIds || []), item.appCityId])];
        if (source.metricSridByCity || source.metricSrid !== item.metricSrid) {
            source.metricSridByCity ??= Object.fromEntries((source.cityIds || []).filter(id => id !== item.appCityId).map(id => [id, source.metricSrid]));
            source.metricSridByCity[item.appCityId] = item.metricSrid;
        }
        source.metricSrid ??= item.metricSrid;
    }
    for (const item of plan) item.descriptor = nextCatalog.sources.find(s => s.id === item.catalogSource.id);

    log(`plan: ${plan.filter(item => !item.switchedFrom).length} cities to admit, ${plan.filter(item => item.switchedFrom).length} to switch source, ${refused.length} refused`);
    const bySource = {};
    for (const item of plan) bySource[item.descriptor.id] = (bySource[item.descriptor.id] || 0) + 1;
    log(`by source: ${JSON.stringify(bySource)}`);
    for (const r of refused) log(`refused ${r.code} ${r.name}: ${r.reason}`);

    if (!args.apply) { log('dry run: nothing written (pass --apply)'); return; }
    if (!plan.length) { log('no eligible cities; nothing written'); return; }

    const evidenceRoot = `world-parcels/research/qualification-${args.release}`;
    const manifestCities = [];
    for (const item of plan) {
        const dir = `${evidenceRoot}/${item.code}`;
        fs.mkdirSync(path.join(REPO, dir), { recursive: true });
        const exportOne = (name, file, sanitizeIt) => {
            const original = fs.readFileSync(file);
            const bytes = sanitizeIt ? Buffer.from(`${JSON.stringify(sanitize(JSON.parse(original)), null, 2)}\n`) : original;
            fs.writeFileSync(path.join(REPO, dir, name), bytes);
            return { original: sha256(original), exported: sha256(bytes), rel: `${dir}/${name}` };
        };
        const c = exportOne('candidate.json', item.evidence.candidate, false);
        const q = exportOne('qualification.json', item.evidence.qualification, true);
        const m = exportOne('metric-report.json', item.evidence.metric, true);
        const a = exportOne('independent-metric-audit.json', item.evidence.independent, true);
        const alignmentFiles = Object.fromEntries([
            ['alignment', 'alignment-report.json'], ['independentAlignment', 'independent-alignment-report.json'],
            ['alignmentEvidence', 'alignment-evidence.json'], ['alignmentMetadata', 'alignment-metadata.json'],
            ['alignmentNative', 'alignment-native.json']
        ].map(([key, name]) => [key, exportOne(name, item.evidence[key], false)]));
        const metricSummary = Object.fromEntries(['sourceCrs', 'metricCrs', 'inputSha256', 'featureCount', 'geometryChangedOrRepaired', 'geometryPass', ...BLOCKERS].map(k => [k, item.metric[k]]));
        manifestCities.push({
            cityCode: item.code, appCityId: item.appCityId, cityName: item.name, qualificationCityName: item.candidate.city.name,
            cityId: (registry.cities.find(r => String(r.wupCityCode) === item.code)?.cityId) || `wup2025:${item.code}`,
            countryCode: item.countryCode, country: item.countryName, sourceId: item.descriptor.id,
            ...(item.switchedFrom ? { switchedFrom: item.switchedFrom } : {}),
            appCenterLatLon: item.center, wupPointLatLon: item.wupPoint || item.center,
            candidate: { qualificationRecordedSha256: item.qualification.candidateSha256, evidenceOriginalSha256: c.original, evidenceExportSha256: c.exported },
            qualification: { status: 'technical-qualified', evidenceOriginalSha256: q.original, evidenceExportSha256: q.exported,
                gates: Object.fromEntries(GATES.map(g => [g, true])), featureCount: item.qualification.featureCount,
                sampleIds: item.candidate.sampleIds, cellSizeDegrees: item.qualification.cellSizeDegrees, limitations: item.qualification.limitations },
            metric: { evidenceOriginalSha256: m.original, evidenceExportSha256: m.exported, ...metricSummary },
            evidenceFiles: { candidate: c.rel, qualification: q.rel, metric: m.rel, independentMetricAudit: a.rel,
                ...Object.fromEntries(Object.entries(alignmentFiles).map(([key, file]) => [key, file.rel])) },
            alignment: { ...item.alignment, evidenceExportSha256: alignmentFiles.alignment.exported },
            independentMetricAudit: { sha256: a.exported, method: 'Independent GEOS recomputation by the qualification runner from the unchanged full-safe cache.',
                ...Object.fromEntries(['inputSha256', 'metricCrs', 'featureCount', 'geometryChangedOrRepaired', 'geometryPass', ...BLOCKERS].map(k => [k, item.independent[k]])) },
            sourceProfile: { adapter: item.descriptor.adapter, endpoint: item.descriptor.endpoint, idField: item.descriptor.idField ?? null,
                idFields: item.descriptor.idFields ?? null, idPrefix: item.descriptor.idPrefix, metricSrid: item.metricSrid,
                evidence: [item.descriptor.discovery?.jurisdiction?.basis].filter(Boolean),
                activationDecision: item.activationDecision },
            verifiedAt: args.release.slice(0, 10),
            primaryReview: { status: 'admitted', method: 'Qualification evidence re-verified offline: nine gates, independent geometry and native CRS alignment audits, production descriptor identity and query contract.' }
        });
    }

    // Catalog, registry, demographics, labels, city config.
    writeJson('backend/parcels/source-catalog.json', nextCatalog);
    for (const item of plan) {
        const qualificationFile = `${evidenceRoot}/${item.code}/qualification.json`;
        const metricFile = `${evidenceRoot}/${item.code}/metric-report.json`;
        const cityId = manifestCities.find(c => c.cityCode === item.code).cityId;
        let row = registry.cities.find(r => r.cityId === cityId);
        if (!row) { row = { cityId, citySource: 'https://population.un.org/wup/', researchOrder: null, historicalSourceIds: [] }; registry.cities.push(row); }
        Object.assign(row, { wupCityCode: Number(item.code), name: row.name || item.name, country: row.country || item.countryName, countryCode: item.countryCode,
            centerLatLon: row.centerLatLon || item.center, parcelStatus: 'verified_sample_partial_coverage',
            sourceIds: [...new Set([...(row.sourceIds || []), item.descriptor.id])], researchFile: qualificationFile,
            qualificationEvidenceFile: qualificationFile, metricReportFile: metricFile,
            ...(item.population2025 ? { population2025: item.population2025 } : {}), ...(item.population2015 ? { population2015: item.population2015 } : {}),
            appCityId: item.appCityId,
            note: 'Passed all nine parcel qualification gates, including independently verified native CRS handling, at the recorded sample location for this settlement. Survey and basemap accuracy and wider coverage remain unverified.' });
        let source = registry.sources.find(s => s.sourceId === item.descriptor.id);
        if (!source) {
            const d = item.descriptor;
            source = { sourceId: d.id, name: d.name, operator: d.operator || null, countryCode: d.countryCode, scope: d.scope || d.discovery?.jurisdiction?.basis || null,
                endpoint: d.endpoint || null, method: 'Public bounded real-adapter qualification, independent native ID rereads, explicit absence, footprint and binding',
                responseFormat: 'Canonical GeoJSON Polygon/MultiPolygon', crs: 'EPSG:4326 output; per-city UTM independent metric audit',
                reuseStatus: 'Source conditions and data age are informational. Legal title and survey accuracy unverified; only public parcel identifiers and geometry requested.',
                evidenceFile: d.discovery?.jurisdiction?.evidence?.[0] ? `world-parcels/${d.discovery.jurisdiction.evidence[0]}` : qualificationFile,
                verifiedCityIds: [], verificationStatus: 'verified_live_city_adapter', liveIntegration: { status: 'enabled', cityIds: [] }, appCityIds: [] };
            registry.sources.push(source);
        }
        source.verifiedCityIds = [...new Set([...(source.verifiedCityIds || []), cityId])];
        source.liveIntegration ??= { status: 'enabled', cityIds: [] };
        source.liveIntegration.status = 'enabled';
        source.liveIntegration.cityIds = [...new Set([...(source.liveIntegration.cityIds || []), item.appCityId])];
        source.liveIntegration.additionalCityEvidence = { ...(source.liveIntegration.additionalCityEvidence || {}), [item.appCityId]: qualificationFile };
        source.appCityIds = [...new Set([...(source.appCityIds || []), item.appCityId])];
        const previous = item.switchedFrom && registry.sources.find(s => s.sourceId === item.switchedFrom);
        if (previous) {
            previous.appCityIds = (previous.appCityIds || []).filter(id => id !== item.appCityId);
            if (previous.liveIntegration) {
                previous.liveIntegration.cityIds = (previous.liveIntegration.cityIds || []).filter(id => id !== item.appCityId);
                if (previous.liveIntegration.additionalCityEvidence) delete previous.liveIntegration.additionalCityEvidence[item.appCityId];
            }
        }

        let demo = demographics.cities.find(r => String(r.wupCityCode) === item.code);
        if (!demo) {
            const w15 = item.population2015, w25 = item.population2025;
            demo = { id: cityId, cohorts: [], name: item.name, countryCode: item.countryCode, latitude: item.center[0], longitude: item.center[1],
                wupLatitude: item.center[0], wupLongitude: item.center[1], wupName: item.name, wupCityCode: Number(item.code), appCityIds: [],
                population2025: w25, population2015: w15,
                annualGrowthPct2015To2025: w15 && w25 ? Number((100 * Math.log(w25 / w15) / 10).toFixed(6)) : null, registryCityIds: [cityId],
                populationMatch: { basis: 'explicit_wup2025_city_code', sourceName: 'UN DESA WUP 2025', confidence: 'high', distanceKm: 0 } };
            demographics.cities.push(demo);
        }
        demo.cohorts = [...new Set([...(demo.cohorts || []), 'app'])];
        demo.appCityIds = [...new Set([...(demo.appCityIds || []), item.appCityId])];
        Object.assign(demo, { parcelSourceId: item.descriptor.id, parcelQualification: 'technical-qualified-bounded', qualificationEvidence: qualificationFile });
        for (const l of LOCALES) {
            i18n[l].city ??= {}; i18n[l].city.labels ??= {};
            i18n[l].city.labels[item.appCityId] = `${item.name}${item.qualifier}, ${countryNames[l][item.countryCode]}`;
        }
    }
    writeJson('world-parcels/registry.json', registry);
    writeJson('world-parcels/report/city-demographics.json', demographics);
    for (const l of LOCALES) {
        // Labels are inserted in place so the file keeps its key order and formatting elsewhere.
        const file = `frontend/i18n/${l}.json`;
        const text = read(file);
        const city = text.match(/\n {2,4}"city": \{\n/);
        const anchor = city && /\n( +)"labels": \{\n/.exec(text.slice(city.index));
        if (!anchor) throw new Error(`${file}: no city.labels block`);
        anchor.index += city.index;
        const indent = `${anchor[1]}    `;
        const existing = readJson(file).city.labels;
        const lines = plan.filter(item => !(item.appCityId in existing)).map(item => `${indent}${JSON.stringify(item.appCityId)}: ${JSON.stringify(i18n[l].city.labels[item.appCityId])},`);
        const at = anchor.index + anchor[0].length;
        const updated = text.slice(0, at) + (lines.length ? `${lines.join('\n')}\n` : '') + text.slice(at);
        JSON.parse(updated);
        fs.writeFileSync(path.join(REPO, file), updated);
    }
    // Switched cities change only their parcels line; new entries go after the last configured city,
    // and that entry needs a trailing comma first.
    let nextConfigText = configText;
    for (const item of plan.filter(entry => entry.switchedFrom)) nextConfigText = switchParcelsLine(nextConfigText, item.appCityId, item.descriptor);
    const added = plan.filter(item => !item.switchedFrom);
    if (added.length) {
        const close = nextConfigText.indexOf('\n    };', nextConfigText.indexOf('const CITY_CONFIGS = {'));
        const before = nextConfigText.slice(0, close).replace(/\}\s*$/, match => (match.trimEnd().endsWith(',') ? match : match.replace('}', '},')));
        nextConfigText = `${before}\n${added.map(cityConfigEntry).join('\n')}${nextConfigText.slice(close)}`;
    }
    fs.writeFileSync(path.join(REPO, 'frontend/js/city-config.js'), nextConfigText);

    writeJson(`world-parcels/research/qualification-admission-${args.release}.json`, {
        schemaVersion: 1, verifiedAt: args.release.slice(0, 10), cityCount: manifestCities.length,
        scope: `${manifestCities.length} technically qualified city/source bindings admitted to the app${manifestCities.some(city => city.switchedFrom) ? ' (live cities moved to a newly qualified source carry switchedFrom)' : ''}. Qualification is bounded: it does not establish citywide completeness, legal title, survey accuracy or currentness.`,
        refused, cities: manifestCities
    });
    log(`applied: ${manifestCities.length} cities admitted; manifest world-parcels/research/qualification-admission-${args.release}.json`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => { console.error(`[${ts()}] ${error.stack || error}`); process.exitCode = 1; });
}
