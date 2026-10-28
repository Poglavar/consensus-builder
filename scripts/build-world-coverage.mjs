#!/usr/bin/env node
// Compiles world parcel research, optional UN WUP 2025 city demographics, and the app's configured
// cities (frontend/data/city-configs.js, read as TEXT, never imported) into the compact
// frontend/data/world-coverage.json that the globe (frontend/js/world/) paints and queries.
// Region outlines (world-parcels/regions.geojson, from scripts/extract-world-regions.mjs), region
// reviews and the parcel source catalog add a region layer painted over the country fills.
// Population joins use exact app-city or explicitly configured WUP identities only; WUP values
// describe settlements and need not match administrative city boundaries.
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
//   none     Researched, nothing open found:
//              city     no_verified_open_endpoint_after_attempts
//              country  no_online_cadastre_found | national_cadastre_credentialed_or_paid | national_cadastre_viewer_only
//   unknown  Not researched, or the check could not complete: temporarily_unavailable, not_probed,
//            no_verified_sample_candidate_* (a candidate that was never verified), subnational_only
//            without any listed open region, and every country with no probe at all.
//
// Regions (US states, Canadian provinces, Länder, cantons, England/Wales/Scotland/N. Ireland, ...;
// one record per outline in world-parcels/regions.geojson) take the same coverage axis, derived
// for the region alone and painted over their country, which keeps its own honest fill:
//   full     A dated region review (region-coverage-reviews.json) passing the country-review gates:
//            a verified source for the region, https scope evidence, and no geographic exclusions.
//   partial  Verified parcel data somewhere in the region: subnationalCoverage bucket regionWide |
//            partial, a source-catalog provider whose discovery.jurisdiction.admin1 names the region
//            (or one of its admin-1 members), or a verified registry city inside the outline.
//   none     subnationalCoverage bucket none | credentialed | viewerOnly, nothing positive.
//   unknown  Everything else (unavailable, ruralRegistryOnly, not researched at region level).
// A region's tier follows its coverage (source/none/unknown). No region is `live`: a configured
// city covers its own radius, and `live` means parcels open anywhere in the area (Croatia).
//
// Per-city parcel checks (world-parcels/research/qualification-outcomes/*.json, written by
// scripts/export-qualification-outcomes.py) temper a reviewed `full` country or region once a
// check failed in one of its cities:
//   mostly   the cities that work there (live app cities plus qualified ones) outnumber the failures
//   partial  otherwise
// Unchecked cities (throttled, pending, awaiting a re-run) never count either way.
//
// Output is deterministic (sorted, rounded, no wall-clock timestamp) so a rebuild with unchanged
// inputs is a byte-identical no-op. Outlines are Douglas-Peucker simplified and rounded to 0.01°,
// which is still sub-pixel on a 4096×2048 equirectangular texture (0.088°/px).
//
// Usage: node scripts/build-world-coverage.mjs --run [--tolerance 0.06] [--region-tolerance 0.1] [--out path]

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { writeBootCoverage } from './build-boot-coverage.mjs';
import { readCityChecks } from './lib/parcel-city-coverage.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULTS = {
    registry: path.join(REPO, 'world-parcels/registry.json'),
    countryReviews: path.join(REPO, 'world-parcels/country-coverage-reviews.json'),
    countries: path.join(REPO, 'world-parcels/countries.geojson'),
    regions: path.join(REPO, 'world-parcels/regions.geojson'),
    regionReviews: path.join(REPO, 'world-parcels/region-coverage-reviews.json'),
    catalog: path.join(REPO, 'frontend/data/source-catalog.json'),
    demographics: path.join(REPO, 'world-parcels/report/city-demographics.json'),
    cityConfig: path.join(REPO, 'frontend/data/city-configs.js'),
    out: path.join(REPO, 'frontend/data/world-coverage.json'),
    tolerance: 0.06,
    // Region fills are clipped to the country land on the globe, so their coast detail is never
    // drawn; 0.1° is about one pixel of the 4096-wide texture (0.088°/px).
    regionTolerance: 0.1
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
// from samples, a national-looking endpoint name, or the app's configured city list. The same gates
// apply to country and region reviews.
export function reviewGrantsFull(review, verifiedSourceIds = []) {
    const reviewedSource = review?.sourceIds?.some(id => verifiedSourceIds.includes(id));
    const scopeEvidence = review?.evidence?.some(source => source.title && /^https:\/\//.test(source.url || ''));
    const datedReview = /^\d{4}-\d{2}-\d{2}$/.test(review?.checkedAt || '');
    return review?.coverage === 'full' && datedReview && !!reviewedSource && !!scopeEvidence
        && Array.isArray(review.exclusions) && review.exclusions.length === 0;
}

export function countryCoverageLevel({ probe, coverage, subnational, hasVerifiedLocalSource = false, review, verifiedSourceIds = [] }) {
    if (reviewGrantsFull(review, verifiedSourceIds)) return 'full';
    const tier = strongest(
        countryProbeTier(probe?.status, subnational), countryCoverageTier(coverage?.status),
        hasVerifiedLocalSource ? 'source' : 'unknown'
    );
    return tier === 'source' ? 'partial' : tier;
}

// A subnationalCoverage bucket's tier for that region alone. SICAR-style rural registries
// (ruralRegistryOnly) are self-declared perimeters, not cadastral parcels, so they stay unknown.
export function regionBucketTier(bucket) {
    if (bucket === 'regionWide' || bucket === 'partial') return 'source';
    if (bucket === 'none' || bucket === 'credentialed' || bucket === 'viewerOnly') return 'none';
    return 'unknown';
}

export function regionCoverageLevel({ buckets = [], hasProvider = false, hasVerifiedCity = false, review, verifiedSourceIds = [] }) {
    if (reviewGrantsFull(review, verifiedSourceIds)) return 'full';
    const tier = strongest(...buckets.map(regionBucketTier), hasProvider ? 'source' : 'unknown', hasVerifiedCity ? 'source' : 'unknown');
    return tier === 'source' ? 'partial' : tier;
}

// One outcome per city across every export file: the latest finished check wins.
export function latestOutcomes(files) {
    const byCity = new Map();
    for (const file of files) for (const city of file.cities) {
        const previous = byCity.get(city.cityCode);
        if (!previous || (city.finishedAt || '') >= (previous.finishedAt || '')) byCity.set(city.cityCode, city);
    }
    return [...byCity.values()];
}

// Checked cities of one place: live app cities and qualified ones work, held ones failed. A live
// city counts as working even if a check of another source failed there.
export function cityChecks(liveCities, outcomes, liveWupCodes = new Set()) {
    const works = liveCities.map(city => city.name);
    const failed = [];
    for (const city of outcomes) {
        if (liveWupCodes.has(city.cityCode) || city.appCityIds?.some(id => liveCities.some(live => live.id === id))) continue;
        if (city.outcome === 'qualified') works.push(city.cityName);
        else if (city.outcome === 'held') failed.push(city.cityName);
    }
    return { works, failed: [...new Set(failed)].sort() };
}

// A reviewed `full` place keeps full until a check fails in one of its cities.
export function temperFull(coverage, { works = [], failed = [] }) {
    if (coverage !== 'full' || !failed.length) return coverage;
    return works.length > failed.length ? 'mostly' : 'partial';
}

const checksNote = ({ works, failed }) =>
    `Parcel checks failed in ${listNames(failed)}; ${works.length} of ${works.length + failed.length} checked cities work.`;

// Registry subnational codes that are not the `<cc>-<code>` ISO 3166-2 code of their outline.
export const REGION_CODE_ALIASES = {
    MY: { JHR: 'MY-01', KDH: 'MY-02', KTN: 'MY-03', MLK: 'MY-04', NSN: 'MY-05', PHG: 'MY-06', PNG: 'MY-07', PRK: 'MY-08',
        PLS: 'MY-09', SGR: 'MY-10', TRG: 'MY-11', SBH: 'MY-12', SWK: 'MY-13', KUL: 'MY-14', LBN: 'MY-15', PJY: 'MY-16' }
};
export const regionIdFor = (cc, code) => REGION_CODE_ALIASES[cc]?.[code] || `${cc}-${code}`;
// subnationalCoverage countries painted only as a country, and why. Any other unpainted country
// fails the build, so a newly researched country cannot silently lose its region detail.
export const UNPAINTED_SUBNATIONAL = {
    RW: 'Registry regions are the 30 districts; Natural Earth admin-1 has only the five provinces.'
};

const BUCKET_NOTES = {
    none: 'No open regional parcel source found',
    credentialed: 'Regional cadastre needs credentials or payment',
    viewerOnly: 'Regional cadastre is a viewer only (no data service)',
    unavailable: 'Check could not complete (service unreachable)'
};

const PROBE_NOTES = {
    national_online_cadastre_verified_sample: 'National online cadastre (verified sample)',
    partial_or_unofficial_sample: 'Partial or unofficial parcel source',
    covered_by_parent_source: 'Covered by the parent country\'s cadastre',
    no_online_cadastre_found: 'No online cadastre found',
    national_cadastre_credentialed_or_paid: 'National cadastre needs credentials or payment',
    national_cadastre_viewer_only: 'National cadastre is a viewer only (no data service)',
    temporarily_unavailable: 'Check could not complete (service unreachable)'
};

// Parses CITY_CONFIGS out of data/city-configs.js source text: each top-level `<key>: {` entry's id, label
// (a string literal, or translateCityText's fallback argument) and map.defaultCenter (else
// projection.fallbackLatLng). Deliberately not an import: the file is a classic script.
export function parseCityConfigs(source) {
    const start = source.indexOf('const CITY_CONFIGS = {');
    if (start < 0) throw new Error('CITY_CONFIGS not found in city-configs.js');
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
        const withoutAlternatives = text.replace(/\bliveSource:\s*\{[^}]*\}/g, '');
        const defaultText = /\bparcels:\s*\{([^}]*)\}/.exec(withoutAlternatives)?.[1] || '';
        const sourceId = /\bsourceId:\s*'([^']+)'/.exec(defaultText)?.[1];
        const queryMode = /\bstrategy:\s*'point'/.test(defaultText) ? 'point' : undefined;
        const dataVersion = /\bdataVersion:\s*'([^']+)'/.exec(text)?.[1];
        const radius = /\bliveRadiusKm:\s*(\d+(?:\.\d+)?)/.exec(text)?.[1];
        const wupCityCodeField = /\bwupCityCode\s*:\s*([^,}\n]+)/.exec(text);
        const rawWupCityCode = wupCityCodeField?.[1]?.trim();
        // Configs may express IDs as numeric literals or quoted digit strings. Accept only
        // those static forms; expressions and other strings remain explicitly invalid.
        const wupCodeLiteral = rawWupCityCode?.match(/^(?:([0-9]+)|['"]([0-9]+)['"])$/);
        const parsedWupCityCode = wupCodeLiteral ? Number(wupCodeLiteral[1] ?? wupCodeLiteral[2]) : null;
        const wupCityCode = Number.isSafeInteger(parsedWupCityCode) && parsedWupCityCode > 0
            ? parsedWupCityCode : null;
        return { id, name: label.split(',')[0].trim(), label, lat: Number(center[1]), lon: Number(center[2]),
            ...(sourceId ? { sourceId } : {}), ...(queryMode ? { queryMode } : {}), ...(dataVersion ? { dataVersion } : {}), ...(radius ? { radiusKm: Number(radius) } : {}),
            ...(wupCityCodeField ? { wupCityCode } : {}) };
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

function ringsBbox(rings) {
    const box = [Infinity, Infinity, -Infinity, -Infinity];
    for (const ring of rings) {
        for (let i = 0; i < ring.length; i += 2) {
            box[0] = Math.min(box[0], ring[i]); box[2] = Math.max(box[2], ring[i]);
            box[1] = Math.min(box[1], ring[i + 1]); box[3] = Math.max(box[3], ring[i + 1]);
        }
    }
    return box;
}

const listNames = names => (names.length <= 2 ? names.join(' and ') : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`);

// Explains a derived (unreviewed) region coverage from its strongest evidence.
function regionNote(region, coverage) {
    if (coverage === 'partial') {
        const provider = region.providers[0];
        if (provider) return provider.discovery.jurisdiction.basis;
        const row = region.buckets.find(b => regionBucketTier(b.bucket) === 'source');
        if (row) {
            const scope = row.bucket === 'regionWide' ? 'Region-wide source' : 'Partial source';
            return row.sourceName ? `${scope}: ${truncate(row.sourceName)}; full coverage is not reviewed` : `${scope} verified; full coverage is not reviewed`;
        }
        const names = [...new Set(region.cities.map(city => city.name))].sort();
        return `Open parcel data verified in ${listNames(names)}; region-wide coverage is unconfirmed`;
    }
    const row = region.buckets.find(b => b.bucket === 'ruralRegistryOnly');
    if (coverage === 'unknown' && row) return row.mergeNote || 'Rural property registry only, not the cadastre';
    const known = region.buckets.find(b => BUCKET_NOTES[b.bucket]);
    return known ? BUCKET_NOTES[known.bucket] : 'No open parcel source verified in this region yet';
}

// One record per outline in world-parcels/regions.geojson: { id, cc, name, tier, coverage, note,
// coverageSources?, center, rings }. See the header for how coverage is derived.
export function buildRegions({ outlines, registry, catalog = [], reviews = [], tolerance = DEFAULTS.regionTolerance,
    liveCities = [], outcomes = [], liveWupCodes = new Set() }) {
    const regions = outlines.features.map(feature => {
        const p = feature.properties;
        if (!/^[A-Z]{2}-[A-Z0-9]{1,3}$/.test(p.id || '') || p.id.slice(0, 2) !== p.cc) throw new Error(`region outline with a malformed id: ${p.id}`);
        // Point-in-region joins use the outline at extraction precision, not the display rings.
        const fine = (feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates)
            .flat().map(ring => ring.flat());
        return {
            id: p.id, cc: p.cc, name: p.name, codes: p.codes || [p.id], members: p.members || [],
            center: Number.isFinite(p.labelLat) && Number.isFinite(p.labelLon) ? [round2(p.labelLat), round2(p.labelLon)] : null,
            rings: compileRings(feature.geometry, tolerance), fine, bbox: ringsBbox(fine), buckets: [], providers: [], cities: []
        };
    });
    const byCode = new Map();
    for (const region of regions) {
        for (const code of new Set([...region.codes, ...region.members])) {
            if (byCode.has(code)) throw new Error(`region code ${code} is in both ${byCode.get(code).id} and ${region.id}`);
            byCode.set(code, region);
        }
    }
    const painted = new Set(regions.map(region => region.cc));

    for (const sub of registry.subnationalCoverage) {
        if (!painted.has(sub.countryCode)) {
            if (UNPAINTED_SUBNATIONAL[sub.countryCode]) continue;
            throw new Error(`subnationalCoverage lists ${sub.countryCode} without region outlines; extract them (scripts/extract-world-regions.mjs) or record why in UNPAINTED_SUBNATIONAL`);
        }
        for (const row of sub.regions) {
            const id = regionIdFor(sub.countryCode, row.code);
            const region = byCode.get(id);
            if (!region || !region.codes.includes(id)) throw new Error(`subnational region ${sub.countryCode}/${row.code} (${row.name}) has no outline ${id}`);
            region.buckets.push(row);
        }
    }

    for (const source of [...catalog].sort((a, b) => a.id.localeCompare(b.id))) {
        const admin1 = source.discovery?.jurisdiction?.admin1;
        if (!Array.isArray(admin1)) continue;
        for (const code of admin1) {
            if (!painted.has(code.slice(0, 2))) continue;
            const region = byCode.get(code);
            if (!region) throw new Error(`catalog provider ${source.id} names admin-1 ${code}, which no region outline holds`);
            if (!region.providers.includes(source)) region.providers.push(source);
        }
    }

    for (const city of registry.cities) {
        if (cityStatusTier(city.parcelStatus) !== 'source' || !Array.isArray(city.centerLatLon)) continue;
        const [lat, lon] = city.centerLatLon;
        const region = regions.find(r => r.cc === city.countryCode && lon >= r.bbox[0] && lon <= r.bbox[2]
            && lat >= r.bbox[1] && lat <= r.bbox[3] && pointInRings(lat, lon, r.fine));
        if (region) region.cities.push(city);
    }
    const regionAt = (cc, lat, lon) => regions.find(r => r.cc === cc && lon >= r.bbox[0] && lon <= r.bbox[2]
        && lat >= r.bbox[1] && lat <= r.bbox[3] && pointInRings(lat, lon, r.fine));
    for (const region of regions) { region.live = []; region.outcomes = []; }
    for (const city of liveCities) regionAt(city.cc, city.lat, city.lon)?.live.push(city);
    for (const city of outcomes) regionAt(city.countryCode, city.point[0], city.point[1])?.outcomes.push(city);

    const byId = new Map(regions.map(region => [region.id, region]));
    const reviewById = new Map();
    for (const review of reviews) {
        if (!byId.has(review.regionCode)) throw new Error(`region review for ${review.regionCode}, which is not a region outline id`);
        if (reviewById.has(review.regionCode)) throw new Error(`more than one region review for ${review.regionCode}`);
        reviewById.set(review.regionCode, review);
    }
    const verifiedByCountry = new Map();
    for (const source of registry.sources) {
        if (!source.verificationStatus?.startsWith('verified_')) continue;
        if (!verifiedByCountry.has(source.countryCode)) verifiedByCountry.set(source.countryCode, []);
        verifiedByCountry.get(source.countryCode).push(source.sourceId);
    }

    return regions.map(region => {
        const review = reviewById.get(region.id);
        // A review may cite a verified source of the region's country or an executable provider
        // whose jurisdiction names the region; its scope evidence carries the regional claim.
        const verifiedSourceIds = [...(verifiedByCountry.get(region.cc) || []), ...region.providers.map(source => source.id)];
        const derived = regionCoverageLevel({
            buckets: region.buckets.map(row => row.bucket), hasProvider: region.providers.length > 0,
            hasVerifiedCity: region.cities.length > 0, review, verifiedSourceIds
        });
        const checks = cityChecks(region.live, region.outcomes, liveWupCodes);
        const coverage = temperFull(derived, checks);
        const reviewed = review && review.coverage === derived && review.evidence?.length;
        const note = reviewed ? review.note : regionNote(region, coverage);
        return {
            id: region.id, cc: region.cc, name: region.name,
            tier: ['full', 'mostly', 'partial'].includes(coverage) ? 'source' : coverage, coverage,
            note: coverage === derived ? note : `${note} ${checksNote(checks)}`,
            ...(reviewed ? { coverageSources: review.evidence.map(({ title, url }) => ({ title, url })) } : {}),
            center: region.center, rings: region.rings
        };
    }).sort((a, b) => a.id.localeCompare(b.id));
}

function demographicPopulation(demographics, cityId, countryCode, idField) {
    if (!demographics || !Array.isArray(demographics.cities) || !cityId) return null;
    const matches = demographics.cities.filter(row => idField === 'appCityIds'
        ? Array.isArray(row.appCityIds) && row.appCityIds.includes(cityId)
        : row[idField] === cityId);
    // Never resolve duplicate IDs by name, country, or input order. Any ambiguity or country
    // disagreement means this population is not safe to attach to the city.
    if (matches.length !== 1 || !countryCode || matches[0].countryCode !== countryCode) return null;
    const population = matches[0].population2025;
    return Number.isFinite(population) && population > 0 ? population : null;
}

function liveCityPopulation(demographics, city, countryCode) {
    if (Object.prototype.hasOwnProperty.call(city, 'wupCityCode')) {
        if (!Number.isSafeInteger(city.wupCityCode) || city.wupCityCode <= 0) return null;
        return demographicPopulation(demographics, city.wupCityCode, countryCode, 'wupCityCode');
    }
    return demographicPopulation(demographics, city.id, countryCode, 'appCityIds');
}

function demographicSourceMetadata(demographics) {
    const source = demographics?.sources?.find(row => row.name === 'UN DESA WUP 2025 city populations');
    if (!source) return null;
    return {
        title: source.name,
        url: source.url,
        year: 2025,
        ...(source.retrieved ? { retrieved: source.retrieved } : {}),
        basis: 'UN DESA WUP city settlement estimate; it may not match an administrative city boundary.'
    };
}

// The radius of the area a live city covers (location-first.md phase 2b). A declared liveRadiusKm
// records where qualification sampled the source (often 3 km), not how big the city is, so a view at
// the city's edge fell outside it: every declared radius is at least MIN_CITY_RADIUS_KM (20 km
// across), and larger declared ones stand, since several are researched source limits (Bogotá stops
// short of Soacha, Toronto of Markham and Mississauga). A city that declares none keeps the 60 km cap.
export const MIN_CITY_RADIUS_KM = 10;
export function coverageRadiusKm(declaredKm) {
    if (!Number.isFinite(declaredKm) || declaredKm <= 0) return null;
    return Math.min(60, Math.max(MIN_CITY_RADIUS_KM, declaredKm));
}

export function buildCoverage({ registry, countries, cityConfigSource, countryReviews = [], demographics = null, tolerance = DEFAULTS.tolerance,
    regions = null, regionReviews = [], catalog = [], regionTolerance = DEFAULTS.regionTolerance, outcomes = [] }) {
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
                population2025: demographicPopulation(demographics, c.cityId, c.countryCode, 'id'),
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

    const cityConfigs = parseCityConfigs(cityConfigSource);
    const radiusOf = city => {
        const km = coverageRadiusKm(city.radiusKm);
        return km === null ? {} : { radiusKm: km };
    };
    const liveWupCodes = new Set(cityConfigs.map(city => city.wupCityCode).filter(Number.isSafeInteger));
    const liveCities = cityConfigs.map(city => {
        const country = [...byCode.values()].find(e => e.rings.length && pointInRings(city.lat, city.lon, e.rings));
        const source = sourcesById.get(city.sourceId);
        // One publisher can serve city records in different jurisdictions. Use an explicit,
        // source-validated city association instead of assigning every city the publisher's country.
        const cityCountries = new Set(registry.cities.filter(row => row.appCityId === city.id
            && row.sourceIds?.includes(city.sourceId) && source?.liveIntegration?.status === 'enabled'
            && source.liveIntegration.cityIds?.includes(city.id)).map(row => row.countryCode).filter(Boolean));
        const cc = cityCountries.size === 1 ? [...cityCountries][0] : source?.countryCode || country?.cc || null;
        return { id: city.id, name: city.name, label: city.label, cc, lat: city.lat, lon: city.lon,
            population2025: liveCityPopulation(demographics, city, cc),
            ...(city.sourceId ? { sourceId: city.sourceId } : {}), ...(city.dataVersion ? { dataVersion: city.dataVersion } : {}),
            ...(city.queryMode ? { queryMode: city.queryMode } : {}),
            ...radiusOf(city) };
    }).sort((a, b) => a.id.localeCompare(b.id));

    for (const entry of byCode.values()) {
        const checks = cityChecks(liveCities.filter(city => city.cc === entry.cc), outcomes.filter(city => city.countryCode === entry.cc), liveWupCodes);
        const coverage = temperFull(entry.coverage, checks);
        if (coverage !== entry.coverage) { entry.coverage = coverage; entry.note = `${entry.note} ${checksNote(checks)}`.trim(); }
    }

    const countryList = [...byCode.values()]
        .filter(e => e.center || e.rings.length)
        .sort((a, b) => a.cc.localeCompare(b.cc))
        .map(({ cc, name, tier, coverage, note, coverageSources, center, rings }) => ({ cc, name, tier, coverage, note,
            ...(coverageSources ? { coverageSources } : {}), center, rings }));
    const populationSource = demographicSourceMetadata(demographics);

    return {
        schemaVersion: 1,
        registryUpdatedAt: registry.updatedAt,
        ...(populationSource ? { populationSource } : {}),
        tiers: ['live', 'source', 'none', 'unknown'],
        coverageLevels: ['full', 'mostly', 'partial', 'none', 'unknown'],
        liveCities,
        cities,
        territories: territories.sort((a, b) => a.id.localeCompare(b.id)),
        countries: countryList,
        regions: regions ? buildRegions({ outlines: regions, registry, catalog, reviews: regionReviews, tolerance: regionTolerance,
            liveCities, outcomes, liveWupCodes }) : []
    };
}

function usage() {
    console.log(`Usage: node scripts/build-world-coverage.mjs --run [options]

Builds frontend/data/world-coverage.json from world-parcels/registry.json,
world-parcels/country-coverage-reviews.json, world-parcels/countries.geojson,
world-parcels/regions.geojson, world-parcels/region-coverage-reviews.json,
world-parcels/research/qualification-outcomes/*.json, frontend/data/source-catalog.json, world-parcels/report/city-demographics.json
and frontend/data/city-configs.js.

Options:
  --run               actually build (without it, this help is printed)
  --tolerance <deg>   Douglas-Peucker tolerance in degrees (default ${DEFAULTS.tolerance})
  --region-tolerance <deg>  tolerance for region outlines (default ${DEFAULTS.regionTolerance})
  --regions <path>    region outlines (default world-parcels/regions.geojson; refresh it with
                      scripts/extract-world-regions.mjs)
  --demographics <path> demographics input (default world-parcels/report/city-demographics.json)
  --out <path>        output file (default frontend/data/world-coverage.json)
  --help              show this help`);
}

function main(argv) {
    if (!argv.includes('--run') || argv.includes('--help')) { usage(); return; }
    const opt = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
    const tolerance = opt('--tolerance') !== undefined ? Number(opt('--tolerance')) : DEFAULTS.tolerance;
    const out = path.resolve(opt('--out') || DEFAULTS.out);
    const regionTolerance = opt('--region-tolerance') !== undefined ? Number(opt('--region-tolerance')) : DEFAULTS.regionTolerance;
    const demographicsPath = path.resolve(opt('--demographics') || DEFAULTS.demographics);
    const regionsPath = path.resolve(opt('--regions') || DEFAULTS.regions);
    const ts = () => new Date().toISOString();
    console.log(`[${ts()}] reading registry, outlines, reviews, source catalog, city config and demographics`);
    const result = buildCoverage({
        registry: JSON.parse(readFileSync(DEFAULTS.registry, 'utf8')),
        countryReviews: JSON.parse(readFileSync(DEFAULTS.countryReviews, 'utf8')).reviews,
        countries: JSON.parse(readFileSync(DEFAULTS.countries, 'utf8')),
        regions: JSON.parse(readFileSync(regionsPath, 'utf8')),
        regionReviews: JSON.parse(readFileSync(DEFAULTS.regionReviews, 'utf8')).reviews,
        catalog: JSON.parse(readFileSync(DEFAULTS.catalog, 'utf8')).sources,
        cityConfigSource: readFileSync(DEFAULTS.cityConfig, 'utf8'),
        demographics: JSON.parse(readFileSync(demographicsPath, 'utf8')),
        // Completed qualification evidence is disposable; current configured sources
        // and city settings describe working coverage, without historical ledgers.
        outcomes: readCityChecks(REPO, {
            registry: JSON.parse(readFileSync(DEFAULTS.registry, 'utf8')),
            demographics: JSON.parse(readFileSync(demographicsPath, 'utf8'))
        }),
        tolerance, regionTolerance
    });
    const json = JSON.stringify(result);
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, `${json}\n`);
    const count = (list, key) => list.reduce((m, x) => ({ ...m, [x[key]]: (m[x[key]] || 0) + 1 }), {});
    const points = result.countries.reduce((n, c) => n + c.rings.reduce((k, r) => k + r.length / 2, 0), 0);
    console.log(`[${ts()}] live cities: ${result.liveCities.map(c => `${c.id}(${c.cc})`).join(', ')}`);
    console.log(`[${ts()}] countries by tier: ${JSON.stringify(count(result.countries, 'tier'))}; outline points: ${points}`);
    console.log(`[${ts()}] countries by coverage: ${JSON.stringify(count(result.countries, 'coverage'))}`);
    const regionPoints = result.regions.reduce((n, r) => n + r.rings.reduce((k, ring) => k + ring.length / 2, 0), 0);
    console.log(`[${ts()}] regions by coverage: ${JSON.stringify(count(result.regions, 'coverage'))}; outline points: ${regionPoints}`);
    console.log(`[${ts()}] full regions: ${result.regions.filter(r => r.coverage === 'full').map(r => r.id).join(', ') || 'none'}`);
    console.log(`[${ts()}] mostly regions: ${result.regions.filter(r => r.coverage === 'mostly').map(r => r.id).join(', ') || 'none'}`);
    console.log(`[${ts()}] registry cities by tier: ${JSON.stringify(count(result.cities, 'tier'))}`);
    console.log(`[${ts()}] wrote ${path.relative(REPO, out)} (${(json.length / 1024).toFixed(1)} KB)`);
    // The boot subset follows the JSON it is derived from (only for the default output).
    if (out === path.resolve(DEFAULTS.out)) {
        const boot = writeBootCoverage({ input: out });
        console.log(`[${ts()}] wrote ${path.relative(REPO, boot.out)} (${(boot.bytes / 1024).toFixed(1)} KB)`);
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main(process.argv.slice(2));
}
