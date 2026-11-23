#!/usr/bin/env node
// Re-reads one district of Alatau's general plan (Government Decree No. 727 of 9 September 2025) from the
// planning provider `alatau-genplan-727` through a running API (read-only GETs), and writes the committed
// snapshot the designs are built from: data/zones.geojson (every zone in the district, the road zone
// clipped to the read area) and data/district.geojson (the district outline: the street centrelines
// around the 3×3 of the plan's street grid centred on zone 479341). README.md describes the choice.
//
//   node fetch-zones.mjs --api http://localhost:4691

import { mkdir, rename, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const turf = createRequire(new URL('../../backend/package.json', import.meta.url))('@turf/turf');

const SOURCE = 'alatau-genplan-727';
const CITY = 'alatau';
const CENTRE = '479341';
const ROAD_USE = 'roads';
// The area read around the district: the district and the blocks across every street that bounds it.
const READ_BBOX = [77.0780, 43.7915, 77.0975, 43.8045];
// The street centrelines that bound the district, each midway between the blocks on its two sides,
// in the frame of the street grid (see README). Row 1's west block, 479343, spans two grid columns, so
// the district steps out west at that row: its street is the one west of 479343.
const CENTRELINES = Object.freeze({
    west: { axis: 'u', outer: ['479332', '476776'], outerFace: 'max', inner: ['479336', '479340'], innerFace: 'min' },
    westRow1: { axis: 'u', outer: ['478247'], outerFace: 'max', inner: ['479343'], innerFace: 'min' },
    east: { axis: 'u', outer: ['482148', '482150', '479354'], outerFace: 'min', inner: ['482147', '482149', '479350'], innerFace: 'max' },
    south: { axis: 'v', outer: ['479333', '479338'], outerFace: 'max', inner: ['480585', '480588', '480595'], innerFace: 'min' },
    north: { axis: 'v', outer: ['479351', '479356', '478240'], outerFace: 'min', inner: ['479346', '479350', '479343'], innerFace: 'max' },
    step: { axis: 'v', outer: ['479343'], outerFace: 'min', inner: ['476776', '476807'], innerFace: 'max' }
});
// A zone counts as in the district when this much of it lies inside the outline (m²).
const MIN_INSIDE_M2 = 1;

const log = message => console.log(`[${new Date().toISOString()}] ${message}`);
const round = value => Math.round(value * 1e8) / 1e8;
const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
const dataPath = name => fileURLToPath(new URL(`./data/${name}`, import.meta.url));

const { values: args } = parseArgs({ options: { api: { type: 'string' }, help: { type: 'boolean' } } });
if (args.help || !args.api) {
    console.log('Usage: node fetch-zones.mjs --api <API base, e.g. http://localhost:4691>\n'
        + 'Reads the district zones of the Alatau general plan through the API and rewrites data/zones.geojson and data/district.geojson.');
    process.exit(args.help ? 0 : 1);
}
const api = args.api.replace(/\/+$/, '');

async function getJson(pathAndQuery) {
    const response = await fetch(`${api}${pathAndQuery}`);
    if (!response.ok) throw new Error(`GET ${pathAndQuery.split('?')[0]}: HTTP ${response.status}`);
    return response.json();
}

async function writeJson(name, value) {
    await mkdir(dataPath(''), { recursive: true });
    const file = dataPath(name), temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value)}\n`);
    await rename(temporary, file);
}

// Every zone in the read area, all pages.
async function readArea() {
    const items = [];
    let cursor = null;
    do {
        const query = new URLSearchParams({ city: CITY, source: SOURCE, bbox: READ_BBOX.join(','), limit: '200', ...(cursor ? { cursor } : {}) });
        const page = await getJson(`/planning/representations?${query}`);
        items.push(...page.items);
        log(`read ${items.length} zones${page.nextCursor ? ', more follow' : ''}`);
        cursor = page.nextCursor || null;
    } while (cursor);
    return items;
}

// The street grid's frame: origin at the centre zone's centroid, u along its edges' mean direction.
function gridFrame(zone) {
    const [lon0, lat0] = turf.centroid(turf.feature(zone.site)).geometry.coordinates;
    const kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110574;
    const metres = ([x, y]) => [(x - lon0) * kx, (y - lat0) * ky];
    let weighted = 0, length = 0;
    for (const ring of turf.getCoords(turf.flatten(turf.feature(zone.site)).features[0])) {
        for (let i = 1; i < ring.length; i++) {
            const [ax, ay] = metres(ring[i - 1]), [bx, by] = metres(ring[i]);
            const edge = Math.hypot(bx - ax, by - ay);
            if (edge < 20) continue;
            weighted += ((((Math.atan2(by - ay, bx - ax) * 180 / Math.PI) % 90) + 90) % 90) * edge;
            length += edge;
        }
    }
    const theta = weighted / length * Math.PI / 180;
    const toGrid = point => {
        const [a, b] = metres(point);
        return [a * Math.cos(theta) + b * Math.sin(theta), -a * Math.sin(theta) + b * Math.cos(theta)];
    };
    const toLonLat = ([u, v]) => {
        const a = u * Math.cos(theta) - v * Math.sin(theta), b = u * Math.sin(theta) + v * Math.cos(theta);
        return [round(lon0 + a / kx), round(lat0 + b / ky)];
    };
    return { origin: [round(lon0), round(lat0)], thetaDeg: Math.round(theta * 180 / Math.PI * 1000) / 1000, toGrid, toLonLat };
}

function districtOutline(byId, frame) {
    const extent = id => {
        const zone = byId.get(id);
        if (!zone) throw new Error(`zone ${id} is not in the read area`);
        const points = turf.coordAll(turf.feature(zone.site)).map(frame.toGrid);
        const u = points.map(p => p[0]), v = points.map(p => p[1]);
        return { u: { min: Math.min(...u), max: Math.max(...u) }, v: { min: Math.min(...v), max: Math.max(...v) } };
    };
    const lines = {};
    for (const [name, line] of Object.entries(CENTRELINES)) {
        const outer = mean(line.outer.map(id => extent(id)[line.axis][line.outerFace]));
        const inner = mean(line.inner.map(id => extent(id)[line.axis][line.innerFace]));
        lines[name] = { ...line, streetWidthM: Math.round(Math.abs(outer - inner) * 10) / 10, at: Math.round((outer + inner) / 2 * 100) / 100 };
    }
    const { west, westRow1, east, south, north, step } = Object.fromEntries(Object.entries(lines).map(([key, line]) => [key, line.at]));
    const ring = [[west, south], [east, south], [east, north], [westRow1, north], [westRow1, step], [west, step], [west, south]].map(frame.toLonLat);
    return { geometry: { type: 'Polygon', coordinates: [ring] }, lines };
}

const fetchedAt = new Date().toISOString();
const area = await readArea();
const withSite = area.filter(item => item.site);
const byId = new Map(withSite.map(item => [item.source.recordId, item]));
const centre = byId.get(CENTRE);
if (!centre) throw new Error(`the centre zone ${CENTRE} was not returned`);
const frame = gridFrame(centre);
const outline = districtOutline(byId, frame);
const outlineFeature = turf.feature(outline.geometry);
// The road zone is kept as read in the area, so the area must hold the district with room to spare.
if (!turf.booleanWithin(outlineFeature, turf.buffer(turf.bboxPolygon(READ_BBOX), -0.05, { units: 'kilometers' }))) {
    throw new Error('the district outline reaches within 50 m of the read area; widen READ_BBOX');
}
log(`district outline ${Math.round(turf.area(outlineFeature))} m², grid at ${frame.thetaDeg}°`);

const inDistrict = withSite.filter(item => {
    const hit = turf.intersect(turf.feature(item.site), outlineFeature);
    return hit && turf.area(hit) >= MIN_INSIDE_M2;
});
const features = [];
for (const item of inDistrict.sort((a, b) => Number(a.source.recordId) - Number(b.source.recordId))) {
    const recordId = item.source.recordId;
    let geometry = item.site, read = 'bbox';
    // The road zone is one 18.7 km² polygon around every block of the city: it is kept as read in the
    // area, not whole. Every other zone is re-read by its id, whole.
    if (item.use?.key !== ROAD_USE) {
        const record = await getJson(`/planning/record?${new URLSearchParams({ city: CITY, source: SOURCE, recordId })}`);
        const whole = record.items?.[0];
        if (!whole?.site) throw new Error(`zone ${recordId}: the record read returned no geometry`);
        geometry = whole.site;
        read = 'record';
    }
    const evidence = item.sourceEvidence?.properties || {};
    features.push({
        type: 'Feature',
        id: recordId,
        properties: {
            recordId, read, sourceVersion: item.source.version, title: item.title,
            use: item.use, landBasis: item.landBasis || null, heightM: item.metrics?.heightM ?? null, status: item.assessment?.status ?? null,
            functional: evidence.functional ?? null, gpzone: evidence.gpzone ?? null, implementation: evidence.implementation ?? null
        },
        geometry
    });
    log(`zone ${recordId} ${item.use?.key} (${read})`);
}

await writeJson('zones.geojson', {
    type: 'FeatureCollection',
    source: { id: SOURCE, label: centre.source.label, service: centre.source.service, layer: centre.source.layer, edition: centre.source.edition, url: centre.source.url },
    fetchedAt,
    readBbox: READ_BBOX,
    features
});
await writeJson('district.geojson', {
    type: 'Feature',
    properties: {
        centreZone: CENTRE, fetchedAt, gridOrigin: frame.origin, gridAngleDeg: frame.thetaDeg,
        centrelines: Object.fromEntries(Object.entries(outline.lines).map(([key, line]) => [key,
            { axis: line.axis, atM: line.at, streetWidthM: line.streetWidthM, between: { outer: line.outer, inner: line.inner } }])),
        areaM2: Math.round(turf.area(outlineFeature) * 10) / 10
    },
    geometry: outline.geometry
});
log(`wrote ${features.length} zones to data/zones.geojson and the outline to data/district.geojson`);
