#!/usr/bin/env node
// Builds frontend/data/uk-economic-areas.js: the areas the UK economic sources are published for, so
// a plan's or parcel's rates follow the place it is in (js/economic-sources.js `areaAt`):
//   lad        English and Welsh local authority districts (ONS "Local Authority Districts (May 2023)
//              Boundaries UK BFE": full resolution, to the extent of the realm, so a district runs to the
//              middle of the Thames rather than stopping at its banks), the areas of MHCLG's land value
//              estimates (js/uk-land-rates.js, England only) and the administrative extents English and
//              Welsh cities declare (`extent` in data/city-configs.js, scripts/build-world-coverage.mjs);
//   lpvsBand   the London Plan Viability Study's value bands A-F (GLA, Value Band Map, 2026), the
//              areas of its sales values and build costs.
// Both are simplified (Douglas-Peucker, TOLERANCE_M, on the borders shared between neighbouring areas,
// so neighbours keep one common border and no gaps open between them) and written in WGS84 to 1e-5°.
// A feature lists its arcs only: membership is the parity of boundary crossings, so rings are not needed.
//
// Rerunnable: every download is cached in --cache (outside the repo), so a rerun reads no network.
//
// Usage: node scripts/build-uk-economic-areas.mjs --write [--cache DIR]
//        node scripts/build-uk-economic-areas.mjs --dry-run     (print sizes, write nothing)

import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = path.join(ROOT, 'frontend', 'data', 'uk-economic-areas.js');
const proj4 = createRequire(path.join(ROOT, 'backend', 'package.json'))('proj4');
const BNG = '+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy '
    + '+towgs84=446.448,-125.157,542.06,0.15,0.247,0.842,-20.489 +units=m +no_defs';
const toWgs84 = proj4(BNG, 'EPSG:4326');
// Borders keep 30 m. A district's edge with no neighbour (the sea, the border with Scotland) matters
// only to points at sea or outside England and Wales and keeps 250 m. Value bands keep 30 m
// everywhere: their edges without a neighbour border the postcode districts the map leaves unbanded.
export const TOLERANCE_M = 30;
const OUTER_TOLERANCE_M = 250;
const SCALE = 1e5;

const LAD_SERVICE = 'https://services1.arcgis.com/ESMARspQHYMw9BZ9/arcgis/rest/services/'
    + 'Local_Authority_Districts_May_2023_UK_BFE_V2/FeatureServer/0';
const LAD_PAGE = 20;
const LPVS_DATASET = 'https://data.london.gov.uk/dataset/london-plan-evidence-base-documents-e6j99';
const LPVS_FILES = { shp: 'https://data.london.gov.uk/download/e6j99/z91/Value%20Band%20Map%20-%20LPVS.shp',
    dbf: 'https://data.london.gov.uk/download/e6j99/yem/Value%20Band%20Map%20-%20LPVS.dbf' };

const log = message => console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);

async function cached(cacheDir, name, url) {
    const file = path.join(cacheDir, name);
    if (existsSync(file)) return readFileSync(file);
    log(`downloading ${url.split('?')[0]}`);
    const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`${response.status} from ${url.split('?')[0]}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    writeFileSync(`${file}.part`, bytes);
    renameSync(`${file}.part`, file);
    return bytes;
}

// The districts of one nation by its code letter (E England: E06-E09; W Wales: W06) in British
// National Grid metres, page by page.
async function districts(cacheDir, nation) {
    const where = `LAD23CD LIKE '${nation}%'`;
    const count = JSON.parse(await cached(cacheDir, `lad-bfe-${nation}-count.json`, `${LAD_SERVICE}/query?${new URLSearchParams({ where, returnCountOnly: 'true', f: 'json' })}`)).count;
    const features = [];
    for (let offset = 0; offset < count; offset += LAD_PAGE) {
        const query = new URLSearchParams({ where, outFields: 'LAD23CD,LAD23NM', outSR: '27700',
            geometryPrecision: '0', orderByFields: 'LAD23CD', resultOffset: String(offset), resultRecordCount: String(LAD_PAGE), f: 'geojson' });
        const page = JSON.parse(await cached(cacheDir, `lad-bfe-${nation}-${offset}.geojson`, `${LAD_SERVICE}/query?${query}`));
        features.push(...page.features);
        log(`${nation} districts ${features.length}/${count}`);
    }
    if (features.length !== count) throw new Error(`Read ${features.length} of ${count} ${nation} districts.`);
    return features.map(feature => ({ id: feature.properties.LAD23CD, name: feature.properties.LAD23NM,
        rings: (feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates).flat() }));
}

// The value band shapefile: polygons (shape type 5) in British National Grid, one record per band.
function shapefileRings(shp) {
    const rings = [];
    for (let offset = 100; offset < shp.length;) {
        const length = shp.readInt32BE(offset + 4) * 2;
        const at = offset + 8;
        if (shp.readInt32LE(at) !== 5) throw new Error('The value band map is not a polygon shapefile.');
        const parts = shp.readInt32LE(at + 36), points = shp.readInt32LE(at + 40);
        const starts = Array.from({ length: parts }, (_, i) => shp.readInt32LE(at + 44 + i * 4));
        const coordinate = i => [shp.readDoubleLE(at + 44 + parts * 4 + i * 16), shp.readDoubleLE(at + 52 + parts * 4 + i * 16)];
        rings.push(starts.map((start, i) => Array.from({ length: (starts[i + 1] ?? points) - start }, (_, k) => coordinate(start + k))));
        offset = at + length;
    }
    return rings;
}
function dbfValues(dbf, field) {
    const records = dbf.readUInt32LE(4), headerLength = dbf.readUInt16LE(8), recordLength = dbf.readUInt16LE(10);
    let column = null;
    for (let at = 32, offset = 1; dbf[at] !== 0x0d; at += 32) {
        const name = dbf.toString('latin1', at, at + 11).replace(/\0.*$/, ''), length = dbf[at + 16];
        if (name === field) column = { offset, length };
        offset += length;
    }
    if (!column) throw new Error(`The value band map has no ${field} field.`);
    return Array.from({ length: records }, (_, i) => dbf.toString('latin1', headerLength + i * recordLength + column.offset,
        headerLength + i * recordLength + column.offset + column.length).trim());
}
async function valueBands(cacheDir) {
    const rings = shapefileRings(await cached(cacheDir, 'lpvs.shp', LPVS_FILES.shp));
    const bands = dbfValues(await cached(cacheDir, 'lpvs.dbf', LPVS_FILES.dbf), 'Updated VB');
    if (bands.join('') !== 'ABCDEF' || rings.length !== 6) throw new Error(`Unexpected value bands: ${bands.join(',')}`);
    return bands.map((id, i) => ({ id, rings: rings[i] }));
}

// Arcs: every ring cut where the set of areas sharing its edges changes, each piece stored once
// whichever area meets it first, so neighbours simplify their common border identically.
function arcsOf(features) {
    const key = ([x, y]) => `${Math.round(x)},${Math.round(y)}`;
    const edgeKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
    const owners = new Map();
    const rings = features.flatMap((feature, index) => feature.rings.map(ring => {
        const points = ring.map(point => [Math.round(point[0]), Math.round(point[1])])
            .filter((point, i, all) => i === 0 || key(point) !== key(all[i - 1]));
        if (key(points[0]) !== key(points[points.length - 1])) points.push(points[0]);
        for (let i = 1; i < points.length; i++) {
            const edge = edgeKey(key(points[i - 1]), key(points[i]));
            if (!owners.has(edge)) owners.set(edge, new Set());
            owners.get(edge).add(index);
        }
        return { index, points };
    }));
    const sharing = (points, i) => [...owners.get(edgeKey(key(points[i]), key(points[i + 1])))].sort().join(',');
    const arcs = [], arcIds = new Map(), featureArcs = features.map(() => []);
    for (const { index, points } of rings) {
        const edges = points.length - 1;
        if (edges < 3) continue;
        const cuts = [];
        for (let i = 0; i < edges; i++) if (sharing(points, i) !== sharing(points, (i - 1 + edges) % edges)) cuts.push(i);
        // A ring with one neighbour all round (an island, an enclave) starts at its lowest vertex.
        if (!cuts.length) {
            let lowest = 0;
            for (let i = 1; i < edges; i++) if (key(points[i]) < key(points[lowest])) lowest = i;
            cuts.push(lowest);
        }
        for (let c = 0; c < cuts.length; c++) {
            const start = cuts[c], end = c + 1 < cuts.length ? cuts[c + 1] : cuts[0] + edges;
            const piece = Array.from({ length: end - start + 1 }, (_, k) => points[(start + k) % edges]);
            const forward = piece.map(key).join(';'), backward = piece.map(key).reverse().join(';');
            const canonical = forward < backward ? forward : backward;
            if (!arcIds.has(canonical)) {
                arcIds.set(canonical, arcs.length);
                arcs.push(Object.assign(forward < backward ? piece : piece.slice().reverse(), { shared: sharing(points, start % edges).includes(',') }));
            }
            featureArcs[index].push(arcIds.get(canonical));
        }
    }
    return { arcs, featureArcs };
}

function simplify(points, tolerance) {
    if (points.length <= 2) return points;
    const keep = new Uint8Array(points.length);
    keep[0] = keep[points.length - 1] = 1;
    const stack = [[0, points.length - 1]];
    while (stack.length) {
        const [a, b] = stack.pop();
        const [x1, y1] = points[a], [x2, y2] = points[b];
        const dx = x2 - x1, dy = y2 - y1, length = Math.hypot(dx, dy);
        let max = -1, index = -1;
        for (let i = a + 1; i < b; i++) {
            const [x, y] = points[i];
            const distance = length ? Math.abs(dy * x - dx * y + x2 * y1 - y2 * x1) / length : Math.hypot(x - x1, y - y1);
            if (distance > max) { max = distance; index = i; }
        }
        if (index >= 0 && max > tolerance) { keep[index] = 1; stack.push([a, index], [index, b]); }
    }
    const kept = points.filter((_, i) => keep[i]);
    // A closed arc (an island) keeps at least a triangle.
    if (kept.length < 4 && points.length >= 4 && kept[0][0] === kept[kept.length - 1][0] && kept[0][1] === kept[kept.length - 1][1]) {
        return [points[0], points[Math.floor(points.length / 3)], points[Math.floor(2 * points.length / 3)], points[points.length - 1]];
    }
    return kept;
}

// One layer: arcs as [x0, y0, dx1, dy1, …] in integer 1e-5° (longitude, latitude), each feature its
// id, name, bounding box (same units) and arc indexes.
function layerOf(features, outerTolerance) {
    const { arcs, featureArcs } = arcsOf(features);
    const encoded = arcs.map(arc => {
        const out = [];
        let px = 0, py = 0;
        for (const point of simplify(arc, arc.shared ? TOLERANCE_M : outerTolerance)) {
            const [lng, lat] = toWgs84.forward(point);
            const x = Math.round(lng * SCALE), y = Math.round(lat * SCALE);
            out.push(x - px, y - py);
            px = x; py = y;
        }
        return out;
    });
    const bboxOf = indexes => {
        const box = [Infinity, Infinity, -Infinity, -Infinity];
        for (const index of indexes) {
            let x = 0, y = 0;
            for (let i = 0; i < encoded[index].length; i += 2) {
                x += encoded[index][i]; y += encoded[index][i + 1];
                box[0] = Math.min(box[0], x); box[1] = Math.min(box[1], y); box[2] = Math.max(box[2], x); box[3] = Math.max(box[3], y);
            }
        }
        return box;
    };
    return { arcs: encoded, features: features.map((feature, i) => ({ id: feature.id, ...(feature.name ? { name: feature.name } : {}),
        bbox: bboxOf(featureArcs[i]), arcs: featureArcs[i] })) };
}

async function main() {
    const args = process.argv.slice(2);
    const write = args.includes('--write'), dryRun = args.includes('--dry-run');
    if (!write && !dryRun || args.includes('--help')) {
        console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter(line => line.startsWith('//')).join('\n'));
        return;
    }
    const cacheIndex = args.indexOf('--cache');
    const cacheDir = cacheIndex >= 0 ? args[cacheIndex + 1] : path.join(os.homedir(), '.cache', 'consensus-builder', 'uk-economic-areas');
    mkdirSync(cacheDir, { recursive: true });
    const lad = layerOf([...await districts(cacheDir, 'E'), ...await districts(cacheDir, 'W')], OUTER_TOLERANCE_M);
    const lpvsBand = layerOf(await valueBands(cacheDir), TOLERANCE_M);
    const data = {
        scale: SCALE, toleranceM: TOLERANCE_M, outerToleranceM: OUTER_TOLERANCE_M,
        sources: {
            lad: { name: 'ONS Local Authority Districts (May 2023) Boundaries UK BFE', url: LAD_SERVICE, licence: 'OGL v3' },
            lpvsBand: { name: 'GLA London Plan Viability Study value band map', url: LPVS_DATASET, licence: 'OGL v2' }
        },
        layers: { lad, lpvsBand }
    };
    const body = JSON.stringify(data);
    for (const [name, layer] of Object.entries(data.layers)) {
        log(`${name}: ${layer.features.length} areas, ${layer.arcs.length} arcs, ${layer.arcs.reduce((n, arc) => n + arc.length / 2, 0)} vertices`);
    }
    log(`${Math.round(body.length / 1024)} KB at ${TOLERANCE_M} m (${OUTER_TOLERANCE_M} m on districts' outer edges)`);
    if (!write) return;
    writeFileSync(OUTPUT, '// GENERATED by scripts/build-uk-economic-areas.mjs; do not edit. The areas UK economic sources are\n'
        + '// published for (English and Welsh local authority districts; the London Plan Viability Study value bands),\n'
        + '// read by js/economic-sources.js areaAt. Contains public sector information licensed under the OGL.\n'
        + '(function (root, data) {\n'
        + "    if (typeof module === 'object' && module.exports) module.exports = data;\n"
        + '    if (root) root.UkEconomicAreas = data;\n'
        + "})(typeof window !== 'undefined' ? window : null, " + body + ');\n');
    log(`wrote ${path.relative(ROOT, OUTPUT)}`);
}

main().catch(error => { console.error(error); process.exit(1); });
