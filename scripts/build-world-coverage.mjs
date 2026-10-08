#!/usr/bin/env node
// Compiles the world parcel research (world-parcels/registry.json + world-parcels/countries.geojson)
// and the app's configured cities (frontend/js/city-config.js, read as TEXT, never imported) into the
// compact frontend/data/world-coverage.json that the globe (frontend/js/world/) paints and queries.
//
// Operational tiers (city routing), strongest first. Country fills use a separate coverage axis:
//   full     A dated national-scope review, backed by a verified parcel source and official scope
//            evidence, with no geographic exclusions (country-coverage-reviews.json).
//   partial  Verified parcel data in at least one city/region. Two-region samples prove only this.
//   none     A completed country search found no open parcel source, with no positive local evidence.
//   unknown  Unchecked or inconclusive. A configured app city alone is not open-source evidence.
// A country or city takes the STRONGEST operational tier any of its records earns.
//
//   live     A configured app city (CITY_CONFIGS: id, label, map.defaultCenter). Croatia is live as a
//            whole country because the app's parcel table is countrywide there (any HR city opens).
//   source   Open parcel data was verified but is not loaded in the app:
//              city     parcelStatus verified_*                 (verified_sample_city_scope, ..._partial_coverage, ...)
//              country  countryCoverage status verified_countrywide
//                       countryProbes status national_online_cadastre_verified_sample | partial_or_unofficial_sample
//                       | covered_by_parent_source (an overseas territory served by its parent's cadastre)
//                       | subnational_only when subnationalCoverage lists regionWide or partial regions
//              region   subnationalCoverage bucket regionWide | partial | ruralRegistryOnly
//   none     Researched, nothing open found:
//              city     no_verified_open_endpoint_after_attempts
//              country  no_online_cadastre_found | national_cadastre_credentialed_or_paid | national_cadastre_viewer_only
//              region   none | credentialed | viewerOnly
//   unknown  Not researched, or the check could not complete: temporarily_unavailable, not_probed,
//            no_verified_sample_candidate_* (a candidate that was never verified), subnational_only
//            without any listed open region, and every country with no probe at all.
//
// Output is deterministic (sorted, rounded, no wall-clock timestamp) so a rebuild with unchanged
// inputs is a byte-identical no-op. Outlines are Douglas-Peucker simplified and rounded to 0.01°,
// which is still sub-pixel on a 4096×2048 equirectangular texture (0.088°/px).
//
// Usage: node scripts/build-world-coverage.mjs --run [--tolerance 0.06] [--out path]

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULTS = {
    registry: path.join(REPO, 'world-parcels/registry.json'),
    countryReviews: path.join(REPO, 'world-parcels/country-coverage-reviews.json'),
    countries: path.join(REPO, 'world-parcels/countries.geojson'),
    cityConfig: path.join(REPO, 'frontend/js/city-config.js'),
    out: path.join(REPO, 'frontend/data/world-coverage.json'),
    tolerance: 0.06
};

export const TIER_RANK = { live: 3, source: 2, none: 1, unknown: 0 };
export const strongest = (...tiers) => tiers.filter(Boolean).reduce((best, t) => (TIER_RANK[t] > TIER_RANK[best] ? t : best), 'unknown');

// Countries whose parcels are loaded countrywide in the app (so every point inside is `live`).
export const LIVE_COUNTRIES = { HR: 'Parcels are countrywide in the app' };

export function cityStatusTier(status) {
    if (!status) return 'unknown';
    if (status.startsWith('verified_')) return 'source';
    if (status === 'no_verified_open_endpoint_after_attempts') return 'none';
    return 'unknown';
}

export function countryProbeTier(status, subnational) {
    switch (status) {
        case 'national_online_cadastre_verified_sample':
        case 'partial_or_unofficial_sample':
        case 'covered_by_parent_source':
            return 'source';
        case 'no_online_cadastre_found':
        case 'national_cadastre_credentialed_or_paid':
        case 'national_cadastre_viewer_only':
            return 'none';
        case 'subnational_only':
            return subnational && (subnational.regionWide + subnational.partial + (subnational.ruralRegistryOnly || 0)) > 0 ? 'source' : 'unknown';
        default:
            return 'unknown';
    }
}

export function countryCoverageTier(status) {
    // This legacy status includes unreviewed two-region tests, not proof of full country coverage.
    return status === 'verified_countrywide' ? 'source' : 'unknown';
}

// Full coverage is a reviewed scope claim plus independently verified geometry, never an inference
// from samples, a national-looking endpoint name, or the app's configured city list.
export function countryCoverageLevel({ probe, coverage, subnational, hasVerifiedLocalSource = false, review, verifiedSourceIds = [] }) {
    const reviewedSource = review?.sourceIds?.some(id => verifiedSourceIds.includes(id));
    const scopeEvidence = review?.evidence?.some(source => source.title && /^https:\/\//.test(source.url || ''));
    const datedReview = /^\d{4}-\d{2}-\d{2}$/.test(review?.checkedAt || '');
    if (review?.coverage === 'full' && datedReview && reviewedSource && scopeEvidence
        && Array.isArray(review.exclusions) && review.exclusions.length === 0) return 'full';
    const tier = strongest(
        countryProbeTier(probe?.status, subnational), countryCoverageTier(coverage?.status),
        hasVerifiedLocalSource ? 'source' : 'unknown'
    );
    return tier === 'source' ? 'partial' : tier;
}

export function regionBucketTier(bucket) {
    if (bucket === 'regionWide' || bucket === 'partial' || bucket === 'ruralRegistryOnly') return 'source';
    if (bucket === 'none' || bucket === 'credentialed' || bucket === 'viewerOnly') return 'none';
    return 'unknown';
}

const PROBE_NOTES = {
    national_online_cadastre_verified_sample: 'National online cadastre (verified sample)',
    partial_or_unofficial_sample: 'Partial or unofficial parcel source',
    covered_by_parent_source: 'Covered by the parent country\'s cadastre',
    no_online_cadastre_found: 'No online cadastre found',
    national_cadastre_credentialed_or_paid: 'National cadastre needs credentials or payment',
    national_cadastre_viewer_only: 'National cadastre is a viewer only (no data service)',
    temporarily_unavailable: 'Check could not complete (service unreachable)'
};

// Parses CITY_CONFIGS out of city-config.js source text: each top-level `<key>: {` entry's id, label
// (a string literal, or translateCityText's fallback argument) and map.defaultCenter (else
// projection.fallbackLatLng). Deliberately not an import: the file is a browser classic script.
export function parseCityConfigs(source) {
    const start = source.indexOf('const CITY_CONFIGS = {');
    if (start < 0) throw new Error('CITY_CONFIGS not found in city-config.js');
    // Walk braces to the end of the object literal.
    let depth = 0; let end = -1;
    for (let i = source.indexOf('{', start); i < source.length; i++) {
        const ch = source[i];
        if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    const body = source.slice(source.indexOf('{', start) + 1, end);
    // Split into top-level entries by tracking depth.
    const entries = []; depth = 0; let current = null;
    for (let i = 0; i < body.length; i++) {
        const ch = body[i];
        if (depth === 0) {
            const m = /^\s*([a-z_][a-z0-9_]*)\s*:\s*\{/i.exec(body.slice(i, i + 80));
            if (m && ch.trim() !== '' && /[a-z_]/i.test(ch)) { current = { key: m[1], from: i }; }
        }
        if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0 && current) { entries.push(body.slice(current.from, i + 1)); current = null; } }
    }
    const num = '(-?\\d+(?:\\.\\d+)?)';
    // `explore: true` is the generic place-without-parcels entry, not a city on the globe.
    return entries.filter(text => !/\bexplore:\s*true\b/.test(text)).map(text => {
        const id = /\bid:\s*'([^']+)'/.exec(text)?.[1];
        const label = /\blabel:\s*'([^']+)'/.exec(text)?.[1]
            || /\blabel:\s*translateCityText\([^,]+,\s*'([^']+)'/.exec(text)?.[1] || id;
        const center = new RegExp(`defaultCenter:\\s*\\[\\s*${num}\\s*,\\s*${num}\\s*\\]`).exec(text)
            || new RegExp(`fallbackLatLng:\\s*\\[\\s*${num}\\s*,\\s*${num}\\s*\\]`).exec(text);
        if (!id || !center) throw new Error(`city-config entry without id or centre: ${text.slice(0, 60)}`);
        // Alternatives are opt-in; the globe describes the default source.
        const defaultText = text.replace(/\bliveSource:\s*\{[^}]*\}/g, '');
        const sourceId = /\bsourceId:\s*'([^']+)'/.exec(defaultText)?.[1];
        const queryMode = /\bstrategy:\s*'point'/.test(defaultText) ? 'point' : undefined;
        const dataVersion = /\bdataVersion:\s*'([^']+)'/.exec(text)?.[1];
        const radius = /\bliveRadiusKm:\s*(\d+(?:\.\d+)?)/.exec(text)?.[1];
        return { id, name: label.split(',')[0].trim(), label, lat: Number(center[1]), lon: Number(center[2]),
            ...(sourceId ? { sourceId } : {}), ...(queryMode ? { queryMode } : {}), ...(dataVersion ? { dataVersion } : {}), ...(radius ? { radiusKm: Number(radius) } : {}) };
    });
}

// Douglas-Peucker on [lon, lat] pairs (planar degrees are fine at this tolerance).
export function simplifyRing(points, tolerance) {
    if (points.length <= 4) return points.slice();
    const keep = new Uint8Array(points.length);
    keep[0] = keep[points.length - 1] = 1;
    const stack = [[0, points.length - 1]];
    while (stack.length) {
        const [a, b] = stack.pop();
        const [ax, ay] = points[a]; const [bx, by] = points[b];
        const dx = bx - ax; const dy = by - ay; const len2 = dx * dx + dy * dy;
        let maxD = -1; let idx = -1;
        for (let i = a + 1; i < b; i++) {
            const [px, py] = points[i];
            let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
            t = Math.max(0, Math.min(1, t));
            const ex = ax + t * dx - px; const ey = ay + t * dy - py;
            const d = ex * ex + ey * ey;
            if (d > maxD) { maxD = d; idx = i; }
        }
        if (idx >= 0 && maxD > tolerance * tolerance) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
    }
    return points.filter((_, i) => keep[i]);
}

const round2 = v => Math.round(v * 100) / 100;

// Flat [lon, lat, lon, lat, ...] rings; rings that collapse below a triangle are dropped.
export function compileRings(geometry, tolerance) {
    const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
    const rings = [];
    for (const polygon of polygons) {
        for (const ring of polygon) {
            let simplified = simplifyRing(ring, tolerance);
            if (simplified.length < 4) simplified = ring; // tiny island: keep its original shape
            const flat = [];
            let prev = null;
            for (const [lon, lat] of simplified) {
                const p = [round2(lon), round2(lat)];
                if (prev && prev[0] === p[0] && prev[1] === p[1]) continue;
                flat.push(p[0], p[1]); prev = p;
            }
            if (flat.length >= 8) rings.push(flat);
        }
    }
    return rings;
}

// Even-odd point-in-polygon over every ring of a country (holes fall out of the parity rule).
export function pointInRings(lat, lon, rings) {
    let inside = false;
    for (const ring of rings) {
        for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
            const xi = ring[i]; const yi = ring[i + 1]; const xj = ring[j]; const yj = ring[j + 1];
            if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
        }
    }
    return inside;
}

const isoOf = props => [props.ISO_A2, props.ISO_A2_EH].find(code => /^[A-Z]{2}$/.test(code || '')) || null;
const truncate = (text, max = 110) => (!text ? '' : text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`);

export function buildCoverage({ registry, countries, cityConfigSource, countryReviews = [], tolerance = DEFAULTS.tolerance }) {
    const sourcesById = new Map(registry.sources.map(s => [s.sourceId, s]));
    const probes = new Map(registry.countryProbes.map(p => [p.countryCode, p]));
    const coverage = new Map(registry.countryCoverage.map(c => [c.countryCode, c]));
    const subnational = new Map(registry.subnationalCoverage.map(s => [s.countryCode, s]));
    const reviews = new Map(countryReviews.map(review => [review.countryCode, review]));
    const verifiedSources = registry.sources.filter(s => s.verificationStatus?.startsWith('verified_'));
    const countriesWithVerifiedCities = new Set(registry.cities.filter(c => cityStatusTier(c.parcelStatus) === 'source').map(c => c.countryCode));

    const byCode = new Map();
    const territories = [];
    const ensure = (cc, name) => {
        if (!byCode.has(cc)) byCode.set(cc, { cc, name: name || cc, tier: 'unknown', note: '', center: null, rings: [] });
        return byCode.get(cc);
    };

    for (const feature of countries.features) {
        const cc = isoOf(feature.properties);
        if (!cc) {
            // Missing ISO identity prevents a registry join, not the existence of land. Keep
            // Natural Earth's own feature identity without assigning another country's coverage.
            const { NE_ID, NAME, LABEL_Y: y, LABEL_X: x } = feature.properties;
            if (!Number.isSafeInteger(NE_ID)) throw new Error('An uncoded land outline has no stable Natural Earth ID.');
            territories.push({ id: `ne:${NE_ID}`, name: NAME, tier: 'unknown', coverage: 'unknown', note: '',
                center: Number.isFinite(y) && Number.isFinite(x) ? [round2(y), round2(x)] : null,
                rings: compileRings(feature.geometry, tolerance) });
            continue;
        }
        const entry = ensure(cc, feature.properties.NAME);
        entry.rings.push(...compileRings(feature.geometry, tolerance));
        const { LABEL_Y: y, LABEL_X: x } = feature.properties;
        if (Number.isFinite(y) && Number.isFinite(x)) entry.center = [round2(y), round2(x)];
    }
    for (const p of registry.countryProbes) ensure(p.countryCode, p.country);
    for (const c of registry.countryCoverage) ensure(c.countryCode, c.country);
    for (const c of registry.cities) ensure(c.countryCode);
    for (const s of verifiedSources) ensure(s.countryCode);

    for (const entry of byCode.values()) {
        const probe = probes.get(entry.cc);
        const cov = coverage.get(entry.cc);
        const sub = subnational.get(entry.cc);
        const review = reviews.get(entry.cc);
        const verifiedSourceIds = verifiedSources.filter(s => s.countryCode === entry.cc).map(s => s.sourceId);
        const hasVerifiedLocalSource = verifiedSourceIds.length > 0 || countriesWithVerifiedCities.has(entry.cc);
        const probeTier = probe ? countryProbeTier(probe.status, sub) : 'unknown';
        const covTier = cov ? countryCoverageTier(cov.status) : 'unknown';
        entry.coverage = countryCoverageLevel({ probe, coverage: cov, subnational: sub, hasVerifiedLocalSource, review, verifiedSourceIds });
        entry.tier = strongest(probeTier, covTier, hasVerifiedLocalSource || entry.coverage === 'full' ? 'source' : 'unknown');
        if (entry.coverage === 'partial' && hasVerifiedLocalSource) entry.note = 'Open parcel data verified in at least one city or region; full country coverage is unconfirmed';
        else if (cov && covTier === 'source') entry.note = 'Parcel polygons verified in multiple regions; full country coverage is unconfirmed';
        else if (probe && probe.status === 'subnational_only' && sub) entry.note = `Regional sources: ${sub.regionWide} of ${sub.regionsTotal} regions region-wide, ${sub.partial} partial`;
        else if (probe && PROBE_NOTES[probe.status]) entry.note = PROBE_NOTES[probe.status];
        else if (probe && probe.status === 'subnational_only') entry.note = 'Regional sources only; not checked region by region';
        else if (!probe) entry.note = 'Not researched yet';
        // Review notes and links describe geographic scope; they never change app routing.
        if (review && review.coverage === entry.coverage && review.evidence?.length) {
            entry.note = review.note;
            entry.coverageSources = review.evidence.map(({ title, url }) => ({ title, url }));
        }
        if (sub) {
            entry.regions = [...sub.regions]
                .sort((a, b) => a.code.localeCompare(b.code))
                .map(r => [r.code, r.name, regionBucketTier(r.bucket)]);
        }
        if (LIVE_COUNTRIES[entry.cc]) entry.tier = 'live';
    }

    const cities = registry.cities
        .filter(c => Array.isArray(c.centerLatLon))
        .map(c => {
            const tier = cityStatusTier(c.parcelStatus);
            const source = c.sourceIds?.length ? sourcesById.get(c.sourceIds[0]) : null;
            const note = c.note || (source ? truncate(source.name)
                : tier === 'none' ? 'No open parcel endpoint found after several attempts'
                    : c.parcelStatus === 'temporarily_unavailable' ? 'Check could not complete (service unreachable)'
                        : 'Candidate source not yet verified');
            const viewerUrl = source?.viewerUrl || source?.catalogueUrl;
            return { id: c.cityId, name: c.name, cc: c.countryCode, lat: Math.round(c.centerLatLon[0] * 1e4) / 1e4, lon: Math.round(c.centerLatLon[1] * 1e4) / 1e4, tier, note,
                ...(/^https:\/\//.test(viewerUrl || '') ? { coverageSources: [{ title: source.name, url: viewerUrl }] } : {}) };
        })
        .sort((a, b) => a.id.localeCompare(b.id));

    // Ringless countries (small islands/city states absent from the 110m outlines) get a centre from
    // their first registry city so they are still searchable and hit-testable by radius.
    for (const entry of byCode.values()) {
        if (!entry.center) {
            const city = cities.find(c => c.cc === entry.cc);
            if (city) entry.center = [round2(city.lat), round2(city.lon)];
        }
    }

    const liveCities = parseCityConfigs(cityConfigSource).map(city => {
        const country = [...byCode.values()].find(e => e.rings.length && pointInRings(city.lat, city.lon, e.rings));
        return { id: city.id, name: city.name, label: city.label, cc: sourcesById.get(city.sourceId)?.countryCode || (country ? country.cc : null), lat: city.lat, lon: city.lon,
            ...(city.sourceId ? { sourceId: city.sourceId } : {}), ...(city.dataVersion ? { dataVersion: city.dataVersion } : {}),
            ...(city.queryMode ? { queryMode: city.queryMode } : {}),
            ...(city.radiusKm ? { radiusKm: city.radiusKm } : {}) };
    }).sort((a, b) => a.id.localeCompare(b.id));

    const countryList = [...byCode.values()]
        .filter(e => e.center || e.rings.length)
        .sort((a, b) => a.cc.localeCompare(b.cc))
        .map(({ cc, name, tier, coverage, note, coverageSources, center, rings, regions }) => ({ cc, name, tier, coverage, note,
            ...(coverageSources ? { coverageSources } : {}), center, ...(regions ? { regions } : {}), rings }));

    return {
        schemaVersion: 1,
        registryUpdatedAt: registry.updatedAt,
        tiers: ['live', 'source', 'none', 'unknown'],
        coverageLevels: ['full', 'partial', 'none', 'unknown'],
        liveCities,
        cities,
        territories: territories.sort((a, b) => a.id.localeCompare(b.id)),
        countries: countryList
    };
}

function usage() {
    console.log(`Usage: node scripts/build-world-coverage.mjs --run [options]

Builds frontend/data/world-coverage.json from world-parcels/registry.json,
world-parcels/country-coverage-reviews.json, world-parcels/countries.geojson and frontend/js/city-config.js.

Options:
  --run               actually build (without it, this help is printed)
  --tolerance <deg>   Douglas-Peucker tolerance in degrees (default ${DEFAULTS.tolerance})
  --out <path>        output file (default frontend/data/world-coverage.json)
  --help              show this help`);
}

function main(argv) {
    if (!argv.includes('--run') || argv.includes('--help')) { usage(); return; }
    const opt = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
    const tolerance = opt('--tolerance') !== undefined ? Number(opt('--tolerance')) : DEFAULTS.tolerance;
    const out = path.resolve(opt('--out') || DEFAULTS.out);
    const ts = () => new Date().toISOString();
    console.log(`[${ts()}] reading registry, outlines and city config`);
    const result = buildCoverage({
        registry: JSON.parse(readFileSync(DEFAULTS.registry, 'utf8')),
        countryReviews: JSON.parse(readFileSync(DEFAULTS.countryReviews, 'utf8')).reviews,
        countries: JSON.parse(readFileSync(DEFAULTS.countries, 'utf8')),
        cityConfigSource: readFileSync(DEFAULTS.cityConfig, 'utf8'),
        tolerance
    });
    const json = JSON.stringify(result);
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, `${json}\n`);
    const count = (list, key) => list.reduce((m, x) => ({ ...m, [x[key]]: (m[x[key]] || 0) + 1 }), {});
    const points = result.countries.reduce((n, c) => n + c.rings.reduce((k, r) => k + r.length / 2, 0), 0);
    console.log(`[${ts()}] live cities: ${result.liveCities.map(c => `${c.id}(${c.cc})`).join(', ')}`);
    console.log(`[${ts()}] countries by tier: ${JSON.stringify(count(result.countries, 'tier'))}; outline points: ${points}`);
    console.log(`[${ts()}] countries by coverage: ${JSON.stringify(count(result.countries, 'coverage'))}`);
    console.log(`[${ts()}] registry cities by tier: ${JSON.stringify(count(result.cities, 'tier'))}`);
    console.log(`[${ts()}] wrote ${path.relative(REPO, out)} (${(json.length / 1024).toFixed(1)} KB)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main(process.argv.slice(2));
}
