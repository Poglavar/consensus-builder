#!/usr/bin/env node
// Cuts New York's 3D Building Model (NYC OTI, CityGML 2.0 LoD2, one 916 MB zip of 20 delivery areas,
// EPSG:2263 feet) into 1,000 ft tiles of CityJSON 2.0 for the nyc-3d building source (nyc-3d.js),
// uploaded to R2 afterwards. Resumable: phase 1 reads each delivery area once into per-tile line files
// (an area without its .done mark is read again from zero); phase 2 writes each tile not yet written;
// phase 3 writes the manifest. Nothing is uploaded here.
//
// Usage: node buildings/build-nyc-3d-tiles.mjs --zip <DA_WISE_GML.zip> --out <dir> [--areas DA4,DA5] --run
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createCityGmlStream } from './citygml.js';
import { buildingBox, cityJsonTile, tilesOf } from './city-model-tiles.js';
import { NYC_TILE_FT } from './nyc-3d.js';
const REFERENCE_SYSTEM = 'https://www.opengis.net/def/crs/EPSG/0/2263';
const log = (...args) => console.log(`[${new Date().toISOString()}] [nyc-3d-tiles]`, ...args);

const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
if (!args.includes('--run') || !option('zip') || !option('out')) {
    console.log('Usage: node buildings/build-nyc-3d-tiles.mjs --zip <DA_WISE_GML.zip> --out <dir> [--areas DA4,DA5] --run');
    process.exit(args.includes('--help') || !args.length ? 0 : 1);
}
const zip = option('zip'), out = option('out');
const work = join(out, 'work'), tiles = join(out, 'tiles');
mkdirSync(work, { recursive: true }); mkdirSync(tiles, { recursive: true });

const entries = execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8', maxBuffer: 1 << 20 }).split('\n')
    .filter(name => /DA\d+_3D_Buildings_Merged\.gml$/.test(name));
const wanted = option('areas') ? new Set(option('areas').split(',')) : null;
const areas = entries.map(name => ({ name, area: name.match(/(DA\d+)_/)[1] })).filter(entry => !wanted || wanted.has(entry.area));
const totalBytes = Object.fromEntries(execFileSync('unzip', ['-Zl', zip], { encoding: 'utf8', maxBuffer: 1 << 22 }).split('\n')
    .map(line => line.trim().split(/\s+/)).filter(cols => cols.length > 9 && /\.gml$/.test(cols.at(-1))).map(cols => [cols.at(-1), Number(cols[3])]));

// ---- Phase 1: each delivery area → work/<area>/<tile>.ndjson, one building per line ----
async function readArea({ name, area }) {
    const dir = join(work, area);
    if (existsSync(join(dir, '.done'))) { log(`${area}: already read, skipped`); return; }
    rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
    const started = Date.now(), size = totalBytes[name] || 0;
    let buffered = new Map(), bufferedBytes = 0, buildings = 0, read = 0, lastLog = 0;
    const flush = () => {
        for (const [tile, lines] of buffered) appendFileSync(join(dir, `${tile}.ndjson`), lines.join(''));
        buffered = new Map(); bufferedBytes = 0;
    };
    const stream = createCityGmlStream(building => {
        const box = buildingBox(building);
        if (!box || !building.id) return;
        const line = JSON.stringify(building) + '\n';
        for (const tile of tilesOf(box, NYC_TILE_FT)) {
            if (!buffered.has(tile)) buffered.set(tile, []);
            buffered.get(tile).push(line); bufferedBytes += line.length;
        }
        buildings += 1;
        if (bufferedBytes > 200e6) flush();
    });
    const child = spawn('unzip', ['-p', zip, name]);
    child.stdout.setEncoding('utf8');
    for await (const chunk of child.stdout) {
        stream.write(chunk);
        read += Buffer.byteLength(chunk);
        if (Date.now() - lastLog > 15000) {
            lastLog = Date.now();
            const share = size ? read / size : 0, seconds = (Date.now() - started) / 1000;
            log(`${area}: ${(read / 1e6).toFixed(0)}/${(size / 1e6).toFixed(0)} MB · ${buildings} buildings · ${(share * 100).toFixed(0)}% · ETA ${share ? Math.round(seconds / share - seconds) : '?'} s`);
        }
    }
    stream.end();
    const code = await new Promise(resolve => child.on('close', resolve));
    if (code !== 0) throw new Error(`${area}: unzip exited ${code}`);
    flush();
    writeFileSync(join(dir, '.done'), JSON.stringify({ buildings, bytes: read, seconds: (Date.now() - started) / 1000 }));
    log(`${area}: ${buildings} buildings in ${Math.round((Date.now() - started) / 1000)} s`);
}

for (const [i, entry] of areas.entries()) {
    log(`phase 1: area ${i + 1}/${areas.length} ${entry.area}`);
    await readArea(entry);
}

// ---- Phase 2: every tile from the areas read → tiles/<tile>.city.json (gzip bytes), once ----
const done = readdirSync(work).filter(area => existsSync(join(work, area, '.done')));
const tileIds = [...new Set(done.flatMap(area => readdirSync(join(work, area)).filter(name => name.endsWith('.ndjson')).map(name => name.slice(0, -7))))].sort();
const started = Date.now();
let written = 0, skipped = 0, bytes = 0, buildingCount = 0;
for (const [i, tile] of tileIds.entries()) {
    const target = join(tiles, `${tile}.city.json`);
    if (existsSync(target)) { skipped += 1; bytes += statSync(target).size; continue; }
    const byId = new Map();
    for (const area of done) {
        const file = join(work, area, `${tile}.ndjson`);
        if (!existsSync(file)) continue;
        for (const line of readFileSync(file, 'utf8').split('\n')) if (line) { const building = JSON.parse(line); byId.set(building.id, building); }
    }
    const body = gzipSync(JSON.stringify(cityJsonTile([...byId.values()], { referenceSystem: REFERENCE_SYSTEM,
        metadata: { title: `NYC 3D Building Model, tile ${tile} (${NYC_TILE_FT} ft)` } })));
    writeFileSync(`${target}.part`, body); renameSync(`${target}.part`, target);
    written += 1; bytes += body.length; buildingCount += byId.size;
    if (i % 500 === 0) {
        const share = (i + 1) / tileIds.length, seconds = (Date.now() - started) / 1000;
        log(`phase 2: ${i + 1}/${tileIds.length} tiles · ${(bytes / 1e6).toFixed(0)} MB · ETA ${Math.round(seconds / share - seconds)} s`);
    }
}
log(`phase 2: ${written} tiles written, ${skipped} already there (skipped), ${(bytes / 1e6).toFixed(1)} MB gzip`);

// ---- Phase 3: the manifest the source reads first ----
const manifest = { schema: 'ugt-city-model-tiles/v1', source: 'NYC 3D Building Model (NYC Office of Technology and Innovation, 2014 survey)',
    sourceUrl: 'https://maps.nyc.gov/download/3dmodel/DA_WISE_GML.zip', referenceSystem: REFERENCE_SYSTEM, tileSize: NYC_TILE_FT,
    format: 'CityJSON 2.0, gzip', areas: done, tiles: tileIds.length, sourceBytes: statSync(zip).size };
writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
log(`manifest: ${tileIds.length} tiles from ${done.length} areas`);
