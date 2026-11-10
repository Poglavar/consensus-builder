#!/usr/bin/env node
// vLAB restatement (README.md): fetches the author's published model and texts from vlab.igv.hr into
// the gitignored cache/, places the site model on the map from data/landmarks.json, and writes what the
// designs are built from: data/model.geojson (WGS84 footprints, roof heights, centrelines),
// data/georeference.json (the fit and its residuals) and data/sources.json (what was fetched, when,
// its hash). --site reads the plan's site parcels from the local cadastre into data/site.geojson.
//
//   node restatements/vlab/extract-model.mjs --fetch      # vlab.igv.hr → cache/ + data/sources.json
//   node restatements/vlab/extract-model.mjs --extract    # cache/ → data/model.geojson + data/georeference.json
//   node restatements/vlab/extract-model.mjs --site       # local public.parcel → data/site.geojson

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { axisCentreline, bboxCentre, fitSimilarity, glbTriangles, meanHeight, multiArea, rasterUnion, ribbonCentreline, roofParts, simplifyLine, unionTriangles, withoutSlivers } from './model-geometry.mjs';

const require = createRequire(new URL('../../backend/package.json', import.meta.url));
const proj4 = require('proj4');
proj4.defs('EPSG:3765', '+proj=tmerc +lat_0=0 +lon_0=16.5 +k=0.9999 +x_0=500000 +y_0=0 +ellps=GRS80 +units=m +no_defs');

const ORIGIN = 'https://vlab.igv.hr/';
const SOURCES = {
    'site.glb': 'ASSETS/site.glb',
    'building.glb': 'ASSETS/building.glb',
    'vlab_config.json': 'ASSETS/vlab_config.json',
    'content_hr.json': 'CONTENT/vlab_content_42.json',
    'content_en.json': 'CONTENT/vlab_content_42_en.json'
};
// The model's ground: the site's ground slab and the tower's base stand at 28.0 model metres.
export const GROUND_M = 28.0;
const here = name => new URL(name, import.meta.url);
const log = message => console.log(`[${new Date().toISOString()}] ${message}`);
const round = value => Math.round(value * 1e8) / 1e8;
const toWgs = ([x, y]) => proj4('EPSG:3765', 'EPSG:4326', [x, y]).map(round);
const toTm = (lon, lat) => proj4('EPSG:4326', 'EPSG:3765', [lon, lat]);
const multiToWgs = multi => ({ type: 'MultiPolygon', coordinates: multi.map(polygon => polygon.map(ring => ring.map(toWgs))) });

const { values } = parseArgs({ options: { fetch: { type: 'boolean' }, extract: { type: 'boolean' }, site: { type: 'boolean' }, help: { type: 'boolean' } } });
if (values.help || !(values.fetch || values.extract || values.site)) {
    console.log('Usage: node restatements/vlab/extract-model.mjs --fetch | --extract | --site   (see the header comment)');
    process.exit(values.help ? 0 : 1);
}

if (values.fetch) {
    await mkdir(here('./cache/'), { recursive: true });
    const fetched = {};
    for (const [name, path] of Object.entries(SOURCES)) {
        const url = new URL(path, ORIGIN).href;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
        const bytes = Buffer.from(await response.arrayBuffer());
        await writeFile(here(`./cache/${name}`), bytes);
        fetched[name] = { url, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), lastModified: response.headers.get('last-modified') };
        log(`${name}: ${bytes.length} bytes`);
    }
    await writeFile(here('./data/sources.json'), `${JSON.stringify({ fetchedAt: new Date().toISOString(), files: fetched }, null, 1)}\n`);
}

if (values.extract) {
    const sources = JSON.parse(await readFile(here('./data/sources.json'), 'utf8'));
    const cached = async name => {
        const bytes = await readFile(here(`./cache/${name}`));
        const sha = createHash('sha256').update(bytes).digest('hex');
        if (sha !== sources.files[name]?.sha256) throw new Error(`cache/${name} is not the fetched file recorded in data/sources.json (run --fetch)`);
        return bytes;
    };
    const site = glbTriangles(await cached('site.glb'));
    const building = glbTriangles(await cached('building.glb'));
    const { landmarks } = JSON.parse(await readFile(here('./data/landmarks.json'), 'utf8'));

    const fit = fitSimilarity(landmarks.map(l => bboxCentre(site[l.node])), landmarks.map(l => toTm(l.lon, l.lat)));
    log(`fit: scale ${fit.scale.toFixed(4)}, rotation ${fit.rotationDeg.toFixed(2)}°, RMS ${fit.rmsM.toFixed(1)} m over ${landmarks.length} landmarks`);
    if (Math.abs(fit.scale - 1) > 0.02 || fit.rmsM > 15) throw new Error('the landmark fit is not a metric placement; check data/landmarks.json');
    const place = fit.apply;

    // The above-ground floor slabs of building.glb (levels pp…+6), for storey counts under each roof.
    const slabs = Object.entries(building)
        .filter(([name]) => /^lvl_(pp|p\d)_flo$/.test(name))
        .map(([name, triangles]) => ({ name, topM: Math.min(...triangles.map(meanHeight)) }))
        .sort((a, b) => a.topM - b.topM);
    const storeysUnder = roofM => slabs.filter(slab => slab.topM < roofM - 2).length;

    const features = [];
    const add = (geometry, properties) => features.push({ type: 'Feature', properties, geometry });
    for (const [key, node] of [['vlab', 'shell'], ['tower', 'tower']]) {
        const parts = roofParts(site[node], place, { minHeightM: GROUND_M + 1.5 });
        for (const part of parts) {
            add(multiToWgs(part.polygons), { kind: 'building', key, roofM: part.roofM, heightM: Math.round((part.roofM - GROUND_M) * 10) / 10,
                ...(key === 'vlab' ? { storeys: storeysUnder(part.roofM) } : {}), areaM2: Math.round(multiArea(part.polygons)) });
            log(`${key}: roof ${part.roofM} m → ${(part.roofM - GROUND_M).toFixed(1)} m, ${Math.round(multiArea(part.polygons))} m²`);
        }
    }
    for (const [kind, node] of [['park', 'int_park'], ['plaza', 'int_plaza']]) {
        const polygons = withoutSlivers(rasterUnion(site[node], place), 20);
        add(multiToWgs(polygons), { kind, node, areaM2: Math.round(multiArea(polygons)) });
        log(`${kind}: ${Math.round(multiArea(polygons))} m² in ${polygons.length} part(s)`);
    }
    for (const node of ['kul_inn_tech_muzej', 'kul_inn_fkit']) {
        const polygons = withoutSlivers(rasterUnion(site[node], place), 5);
        add(multiToWgs(polygons), { kind: 'kept', node, areaM2: Math.round(multiArea(polygons)) });
    }
    // The passage is drawn as a curved double-headed arrow running one way, so its centreline is the
    // mean across it along its main axis; the Cibona link bends, so it is chained through the ribbon.
    const centrelines = { passage: () => axisCentreline(site.int_prolaz, place), link: () => ribbonCentreline(site.int_veza, place, { cellM: 5, windowM: 12 }) };
    for (const [key, node] of [['passage', 'int_prolaz'], ['link', 'int_veza']]) {
        const line = simplifyLine(centrelines[key](), 1.5);
        add({ type: 'LineString', coordinates: line.map(point => toWgs(point.xy)) },
            { kind: 'line', key, node, heightsM: line.map(point => Math.round((point.heightM - GROUND_M) * 10) / 10) });
        log(`${key}: ${line.length} points`);
    }
    await writeFile(here('./data/model.geojson'), `${JSON.stringify({ type: 'FeatureCollection', features })}\n`);
    await writeFile(here('./data/georeference.json'), `${JSON.stringify({
        method: 'similarity fit of model plan (x, -z) bounding-box centres onto OSM centres in EPSG:3765',
        scale: Math.round(fit.scale * 1e6) / 1e6, rotationDeg: Math.round(fit.rotationDeg * 1e4) / 1e4, rmsM: Math.round(fit.rmsM * 10) / 10,
        residualsM: Object.fromEntries(landmarks.map((l, i) => [l.node, Math.round(fit.residualsM[i] * 10) / 10])),
        groundM: GROUND_M, slabs: slabs.map(slab => ({ level: slab.name.replace(/^lvl_|_flo$/g, ''), topM: Math.round(slab.topM * 10) / 10 }))
    }, null, 1)}\n`);
    log(`wrote ${features.length} features`);
}

if (values.site) {
    require('dotenv').config({ path: here('../../backend/.env').pathname, quiet: true });
    const { createPool, describeDatabase, isLocalDatabase } = require('./db/connection.cjs');
    if (!isLocalDatabase()) throw new Error(`refusing a non-local database: ${describeDatabase()}`);
    const pool = createPool();
    try {
        // At the API's own precision (ST_AsGeoJSON's nine decimals, parcels/oss-database-source.js): the
        // square rides these edges, and a coarser copy leaves slivers the app drops as debris.
        // The vLAB site inside the embankment: k.č. 6804/1, 6804/9 and 823/1, k.o. Centar (339270).
        const { rows } = await pool.query(`select cestica_id, broj_cestice, round(st_area(geom)) as area_m2, st_asgeojson(st_transform(geom, 4326), 9)::json as geometry
            from public.parcel where current and maticni_broj_ko = 339270 and broj_cestice = any($1) order by broj_cestice`, [['6804/1', '6804/9', '823/1']]);
        if (rows.length !== 3) throw new Error(`expected the three site parcels, found ${rows.length}`);
        await writeFile(here('./data/site.geojson'), `${JSON.stringify({ type: 'FeatureCollection', features: rows.map(row => ({ type: 'Feature',
            properties: { parcelId: String(row.cestica_id), number: row.broj_cestice, cadastralMunicipality: 339270, areaM2: Number(row.area_m2) }, geometry: row.geometry })) })}\n`);
        log(`site: ${rows.map(row => `${row.broj_cestice} (${row.area_m2} m²)`).join(', ')}`);
        // The existing buildings the plan keeps: GDI footprints at least 30 % under the model's kept
        // Technical Museum and FKIT. Spaces and the passage are cut against these, not the model's own.
        const model = JSON.parse(await readFile(here('./data/model.geojson'), 'utf8'));
        const kept = model.features.filter(feature => feature.properties.kind === 'kept');
        const found = [];
        for (const feature of kept) {
            const { rows: hits } = await pool.query(`with k as (select st_transform(st_setsrid(st_geomfromgeojson($1), 4326), 3765) g)
                select b.object_id, round(st_area(b.geom)) as area_m2, st_asgeojson(st_transform(b.geom, 4326), 8)::json as geometry
                from public.gdi_building_footprint b, k where st_intersects(b.geom, k.g) and st_area(st_intersection(b.geom, k.g)) >= 0.3 * st_area(b.geom)
                order by b.object_id`, [JSON.stringify(feature.geometry)]);
            for (const hit of hits) found.push({ type: 'Feature', properties: { objectId: String(hit.object_id), keptBy: feature.properties.node, areaM2: Number(hit.area_m2) }, geometry: hit.geometry });
            log(`${feature.properties.node}: ${hits.length} GDI building(s), ${hits.reduce((sum, hit) => sum + Number(hit.area_m2), 0)} m²`);
        }
        await writeFile(here('./data/kept-buildings.geojson'), `${JSON.stringify({ type: 'FeatureCollection', source: 'public.gdi_building_footprint (local)', features: found })}\n`);
    } finally {
        await pool.end();
    }
}
