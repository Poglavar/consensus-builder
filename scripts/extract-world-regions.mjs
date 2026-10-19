#!/usr/bin/env node
// Extracts the region outlines the world globe paints below country level (states, provinces,
// Länder, cantons, UK constituent countries, Belgian regions) from Natural Earth 10m files into the
// compact, checked-in world-parcels/regions.geojson that scripts/build-world-coverage.mjs reads.
// The raw Natural Earth files (~54 MB) stay outside the repository; this keeps only the countries
// in REGION_SCHEMES, pre-simplified (0.01°) and rounded (0.001°), so a coverage rebuild never needs
// a download. Region coverage itself is derived in build-world-coverage.mjs, never here.
//
// Inputs (Natural Earth v5.1.2, https://github.com/nvkelso/natural-earth-vector/tree/v5.1.2/geojson):
//   ne_10m_admin_1_states_provinces.geojson   ISO 3166-2 states/provinces (US, CA, AU, DE, ...)
//   ne_10m_admin_0_map_units.geojson          England/Wales/Scotland/N. Ireland and the three
//                                             Belgian regions, which admin-1 splits into councils
//                                             and provinces respectively
//
// Output is deterministic (sorted, rounded, no timestamp): re-extracting the same inputs is a
// byte-identical no-op.
//
// Usage: node scripts/extract-world-regions.mjs --run --admin1 <path> --map-units <path> [--out path]

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { simplifyRing } from './build-world-coverage.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT = path.join(REPO, 'world-parcels/regions.geojson');
const NE_VERSION = 'v5.1.2';
const PRE_TOLERANCE = 0.01;
// A polygon smaller than this (degrees, larger bbox side; ~4 px of the 4096-wide globe texture) is
// dropped: the globe clips region fills to the coarse 110m country land, which has no such islands,
// so they would only add bytes. A region's largest polygon always stays (Putrajaya, Basel-Stadt).
const MIN_RING_DEG = 0.4;

// Countries painted region by region, and which Natural Earth layer has their region scheme.
// Admin-1 is used where its units are the registry's subnational regions; it is wrong for GB
// (councils) and BE (provinces), whose regions are admin-0 map units instead.
export const REGION_SCHEMES = {
    AR: 'admin1', AU: 'admin1', BR: 'admin1', CA: 'admin1', CH: 'admin1', DE: 'admin1',
    ID: 'admin1', MX: 'admin1', MY: 'admin1', US: 'admin1',
    GB: 'mapUnits', BE: 'mapUnits'
};
// Map units carry no ISO 3166-2 code; these are the ISO 3166-2 codes of each unit (GU_A3).
export const MAP_UNIT_IDS = {
    GBR: { ENG: 'GB-ENG', WLS: 'GB-WLS', SCT: 'GB-SCT', NIR: 'GB-NIR' },
    BEL: { BFR: 'BE-VLG', BWR: 'BE-WAL', BCR: 'BE-BRU' }
};
// ISO 3166-2 codes changed after Natural Earth 5.1.2 was cut.
const RENAMED = { 'MX-DIF': 'MX-CMX' };
// Natural Earth's name_en is wrong or ambiguous for these capital districts.
const NAME_OVERRIDES = {
    'AR-C': 'Ciudad Autónoma de Buenos Aires', 'BR-DF': 'Distrito Federal',
    'MX-CMX': 'Mexico City', 'US-DC': 'District of Columbia'
};
// Provinces split after Natural Earth 5.1.2: the old outline stands for every successor, so the
// build can join each current registry code to exactly one outline.
const SPLIT = {
    'ID-KI': { codes: ['ID-KI', 'ID-KU'], name: 'Kalimantan Timur and Kalimantan Utara' },
    'ID-PA': { codes: ['ID-PA', 'ID-PP', 'ID-PS', 'ID-PT'], name: 'Papua, Papua Pegunungan, Papua Selatan and Papua Tengah' },
    'ID-PB': { codes: ['ID-PB', 'ID-PD'], name: 'Papua Barat and Papua Barat Daya' }
};

const round3 = v => Math.round(v * 1000) / 1000;
const polygonsOf = geometry => geometry.type === 'Polygon' ? [geometry.coordinates]
    : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];

function ringExtent(ring) {
    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
    for (const [x, y] of ring) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    return Math.max(maxX - minX, maxY - minY);
}

function ringArea(ring) {
    let sum = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) sum += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
    return Math.abs(sum / 2);
}

function compactRing(ring) {
    let simplified = simplifyRing(ring, PRE_TOLERANCE);
    if (simplified.length < 4) simplified = ring;
    const rounded = [];
    for (const [lon, lat] of simplified) {
        const point = [round3(lon), round3(lat)];
        const prev = rounded[rounded.length - 1];
        if (!prev || prev[0] !== point[0] || prev[1] !== point[1]) rounded.push(point);
    }
    return rounded.length >= 4 ? rounded : null;
}

// Pre-simplifies the merged polygons and drops sub-pixel ones (an outer ring takes its holes with
// it); the polygon with the largest outer ring always stays.
function compactPolygons(polygons) {
    const largest = polygons.reduce((best, polygon, i) => (ringExtent(polygon[0]) > ringExtent(polygons[best][0]) ? i : best), 0);
    const out = [];
    polygons.forEach((polygon, i) => {
        if (i !== largest && ringExtent(polygon[0]) < MIN_RING_DEG) return;
        const outer = compactRing(polygon[0]);
        if (!outer) return;
        const holes = polygon.slice(1).filter(ring => ringExtent(ring) >= MIN_RING_DEG).map(compactRing).filter(Boolean);
        out.push([outer, ...holes]);
    });
    return out;
}

// Groups source features into regions: { id, cc, name, codes, members, label, polygons }.
export function collectRegions({ admin1, mapUnits }) {
    const regions = new Map();
    const add = (id, cc, name, label, geometry, extra = {}) => {
        if (!regions.has(id)) regions.set(id, { id, cc, name, label, labelArea: -1, polygons: [], ...extra });
        const region = regions.get(id);
        const polygons = polygonsOf(geometry);
        // The label of the largest part wins (NSW over Lord Howe Island).
        const area = polygons.reduce((sum, polygon) => sum + ringArea(polygon[0]), 0);
        if (area > region.labelArea) { region.labelArea = area; region.label = label; region.name = name; }
        region.polygons.push(...polygons);
    };

    for (const feature of admin1.features) {
        const p = feature.properties;
        if (REGION_SCHEMES[p.iso_a2] !== 'admin1') continue;
        const code = p.iso_3166_2 || '';
        if (code.includes('~') || !/^[A-Z]{2}-[A-Z0-9]{1,3}$/.test(code)) continue; // NE placeholder units
        const id = RENAMED[code] || code;
        const split = SPLIT[id];
        add(id, p.iso_a2, split?.name || NAME_OVERRIDES[id] || p.name_en || p.name, [p.latitude, p.longitude], feature.geometry,
            { codes: split ? split.codes : [id] });
    }

    for (const feature of mapUnits.features) {
        const p = feature.properties;
        const id = MAP_UNIT_IDS[p.ADM0_A3]?.[p.GU_A3];
        if (!id) continue;
        const cc = id.slice(0, 2);
        if (REGION_SCHEMES[cc] !== 'mapUnits') throw new Error(`map unit ${id} for a country not in the map-unit scheme`);
        // Admin-1 units inside the map unit, so a provider declaring admin-1 codes still joins.
        const members = [...new Set(admin1.features
            .filter(f => f.properties.adm0_a3 === p.ADM0_A3 && f.properties.gu_a3 === p.GU_A3 && /^[A-Z]{2}-/.test(f.properties.iso_3166_2 || ''))
            .map(f => f.properties.iso_3166_2))].sort();
        add(id, cc, p.GEOUNIT, [p.LABEL_Y, p.LABEL_X], feature.geometry, { codes: [id], members });
    }

    for (const cc of Object.keys(REGION_SCHEMES)) {
        if (![...regions.values()].some(region => region.cc === cc)) throw new Error(`no region outlines found for ${cc}`);
    }
    return [...regions.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function extractRegions({ admin1, mapUnits, sources = [] }) {
    const features = collectRegions({ admin1, mapUnits }).map(region => {
        const polygons = compactPolygons(region.polygons);
        const [lat, lon] = region.label;
        return {
            type: 'Feature',
            properties: {
                id: region.id, cc: region.cc, name: region.name,
                ...(region.codes.length > 1 || region.codes[0] !== region.id ? { codes: region.codes } : {}),
                ...(region.members ? { members: region.members } : {}),
                ...(Number.isFinite(lat) && Number.isFinite(lon) ? { labelLat: round3(lat), labelLon: round3(lon) } : {})
            },
            geometry: polygons.length === 1 ? { type: 'Polygon', coordinates: polygons[0] } : { type: 'MultiPolygon', coordinates: polygons }
        };
    });
    return {
        type: 'FeatureCollection',
        metadata: {
            generatedBy: 'scripts/extract-world-regions.mjs',
            naturalEarthVersion: NE_VERSION,
            preSimplifyToleranceDeg: PRE_TOLERANCE,
            minRingDeg: MIN_RING_DEG,
            sources
        },
        features
    };
}

function usage() {
    console.log(`Usage: node scripts/extract-world-regions.mjs --run --admin1 <path> --map-units <path> [--out path]

Writes world-parcels/regions.geojson (region outlines for the world globe) from Natural Earth
${NE_VERSION} 10m files:
  --admin1 <path>     ne_10m_admin_1_states_provinces.geojson
  --map-units <path>  ne_10m_admin_0_map_units.geojson
  --out <path>        output (default world-parcels/regions.geojson)
  --help              show this help
Download: https://github.com/nvkelso/natural-earth-vector/tree/${NE_VERSION}/geojson
Then rebuild the globe data: node scripts/build-world-coverage.mjs --run`);
}

function main(argv) {
    if (!argv.includes('--run') || argv.includes('--help')) { usage(); return; }
    const opt = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
    if (!opt('--admin1') || !opt('--map-units')) throw new Error('--admin1 and --map-units are required');
    const ts = () => new Date().toISOString();
    const read = file => {
        const text = readFileSync(path.resolve(file));
        return { json: JSON.parse(text), sha256: createHash('sha256').update(text).digest('hex') };
    };
    console.log(`[${ts()}] reading Natural Earth admin-1 and map units`);
    const admin1 = read(opt('--admin1'));
    const mapUnits = read(opt('--map-units'));
    const result = extractRegions({
        admin1: admin1.json, mapUnits: mapUnits.json,
        sources: [
            { file: 'ne_10m_admin_1_states_provinces.geojson', sha256: admin1.sha256 },
            { file: 'ne_10m_admin_0_map_units.geojson', sha256: mapUnits.sha256 }
        ].map(source => ({ ...source, url: `https://github.com/nvkelso/natural-earth-vector/blob/${NE_VERSION}/geojson/${source.file}` }))
    });
    const out = path.resolve(opt('--out') || DEFAULT_OUT);
    const json = `${JSON.stringify(result)}\n`;
    writeFileSync(out, json);
    const byCountry = result.features.reduce((m, f) => ({ ...m, [f.properties.cc]: (m[f.properties.cc] || 0) + 1 }), {});
    console.log(`[${ts()}] regions per country: ${JSON.stringify(byCountry)}`);
    console.log(`[${ts()}] wrote ${path.relative(REPO, out)} (${(json.length / 1024).toFixed(1)} KB, ${result.features.length} regions)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main(process.argv.slice(2));
}
