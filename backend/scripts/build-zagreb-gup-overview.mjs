#!/usr/bin/env node
// Build the WGS84 overview for Zagreb GUP 2025 Map 1 from the official geoportal export.
// Source: ../cadastre-data/government_plans/land-use-2025.geojson (layer 2563,
// Zagreb geoportal identify responses, EPSG:3765 / HTRS96/TM).
// The overview is deliberately descriptive: status is null because land-use codes do
// not by themselves establish building eligibility.
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { bbox, coordEach, simplify } from '@turf/turf';
import { gzipSync } from 'node:zlib';
import { sourceRevision } from '../planning/source-proposal.js';
import proj4 from 'proj4';
import { validateGeometry } from '../parcels/source-contract.js';

const input = process.argv[2] || new URL('../../../cadastre-data/government_plans/land-use-2025.geojson', import.meta.url);
const output = new URL('../../frontend/data/planning/zagreb-gup-2025-overview.json', import.meta.url);
const exactOutput = new URL('../planning/data/zagreb-gup-2025-zones.json.gz', import.meta.url);
const sourceId = 'zagreb-gup-2025';
const source = JSON.parse(readFileSync(input, 'utf8'));
const sourceCrs = '+proj=tmerc +lat_0=0 +lon_0=16.5 +k=0.9999 +x_0=500000 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs';
const wgs84 = proj4(sourceCrs, 'WGS84');

if (source?.type !== 'FeatureCollection' || source.features?.length !== 4476) {
    throw new Error(`Expected complete Map 1 source with 4476 features; got ${source?.features?.length}`);
}

// Map 1 codes from Article 8. For compound marks the first use sets the colour. The complete
// original mark is shown in the inspector.
function groupFor(code) {
    const first = code.split(',')[0].trim();
    if (first === 'S') return 'housing';
    if (/^M[012]?$/.test(first)) return 'mixed';
    if (/^D[1-8]?$/.test(first)) return 'public';
    if (/^V[1-3]$/.test(first)) return 'water';
    if (/^Z[1-4]?$|^ZIS$|^R[12]?$/.test(first)) return 'green';
    if (['K1', 'K2', 'T', 'TR'].includes(first)) return 'commercial';
    if (first === 'I') return 'industry';
    if (first === 'N') return 'restricted';
    return null;
}

function transformCoordinates(coords, rounded) {
    if (Array.isArray(coords[0])) return coords.map(part => transformCoordinates(part, rounded));
    const [lon, lat] = wgs84.forward(coords);
    return rounded ? [Math.round(lon * 1e5) / 1e5, Math.round(lat * 1e5) / 1e5] : [lon, lat];
}

function overviewGeometry(feature) {
    // Input units are metres, so this tolerance is a local ~9 m simplification.
    const simplified = simplify(feature, { tolerance: 9, highQuality: true, mutate: false });
    const geometry = { type: simplified.geometry.type, coordinates: transformCoordinates(simplified.geometry.coordinates, true) };
    if (!validateGeometry(geometry)) throw new Error(`Invalid geometry for ${feature.id}`);
    return geometry;
}

const uses = [];
const useIndexes = new Map();
const ids = new Set();
const exactZones = [];
const zones = source.features.map(feature => {
    if (!feature.id || ids.has(feature.id) || !feature.properties?.title) throw new Error('Missing or duplicate Map 1 feature');
    ids.add(feature.id);
    const code = String(feature.properties.title);
    const use = { key: `gup-${code.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, group: groupFor(code),
        label: code, stage: null, status: null };
    const useKey = JSON.stringify(use);
    if (!useIndexes.has(useKey)) { useIndexes.set(useKey, uses.length); uses.push(use); }
    const geometry = { type: feature.geometry.type, coordinates: transformCoordinates(feature.geometry.coordinates, false) };
    if (!validateGeometry(geometry)) throw new Error(`Invalid source geometry for ${feature.id}`);
    exactZones.push([String(feature.id), { use, geometry, bbox: bbox(geometry), version: sourceRevision(feature) }]);
    return [String(feature.id), useIndexes.get(useKey), overviewGeometry(feature)];
});

const bounds = [Infinity, Infinity, -Infinity, -Infinity];
coordEach(source, coordinate => {
    const [lon, lat] = wgs84.forward(coordinate);
    bounds[0] = Math.min(bounds[0], lon); bounds[1] = Math.min(bounds[1], lat);
    bounds[2] = Math.max(bounds[2], lon); bounds[3] = Math.max(bounds[3], lat);
});
const overview = { sourceId, bbox: bounds, uses, zones };
const bytes = Buffer.from(JSON.stringify(overview));
const temporary = new URL(`.zagreb-gup-2025-overview.${process.pid}.tmp`, output);
writeFileSync(temporary, bytes);
renameSync(temporary, output);
const exactTemporary = new URL(`.zagreb-gup-2025-zones.${process.pid}.tmp`, exactOutput);
writeFileSync(exactTemporary, gzipSync(Buffer.from(JSON.stringify(exactZones)), { level: 9 }));
renameSync(exactTemporary, exactOutput);
const positions = geometry => { let n = 0; const walk = x => Array.isArray(x[0]) ? x.forEach(walk) : n++; walk(geometry.coordinates); return n; };
console.log(JSON.stringify({ sourceFeatures: source.features.length, zones: zones.length, uses: uses.length, bbox: overview.bbox,
    overviewPositions: zones.reduce((n, [, , geometry]) => n + positions(geometry), 0), overviewBytes: bytes.length }, null, 2));
