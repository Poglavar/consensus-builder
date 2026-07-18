// Fetches elevation for every grid cell from AWS Terrain Tiles (terrarium
// encoding, zoom 13, ~19 m/px) and caches a Float32 elevation grid to
// data/dem-grid.bin (+ meta json). Slope is derived from this at generate time.
// Usage: node fetch-dem.js --run [--force]
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { DATA_DIR } from './lib/config.js';
import { makeGrid } from './lib/grid.js';
import { toWGS } from './lib/proj.js';
import { log, fail } from './lib/log.js';

const Z = 13;
const BIN_FILE = path.join(DATA_DIR, 'dem-grid.bin');
const META_FILE = path.join(DATA_DIR, 'dem-grid.meta.json');

const args = process.argv.slice(2);
if (!args.includes('--run')) {
    console.log('Fetch AWS terrain tiles and build a per-cell elevation grid into data/dem-grid.bin.');
    console.log('Usage: node fetch-dem.js --run [--force]');
    process.exit(0);
}
if (fs.existsSync(BIN_FILE) && !args.includes('--force')) {
    fail(`${BIN_FILE} already exists — pass --force to refetch`);
}

const grid = makeGrid();
log(`grid ${grid.cols}x${grid.rows} = ${grid.size} cells`);
fs.mkdirSync(DATA_DIR, { recursive: true });

const tiles = new Map(); // "x/y" -> decoded PNG
async function getTile(tx, ty) {
    const key = `${tx}/${ty}`;
    if (!tiles.has(key)) {
        const url = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${Z}/${tx}/${ty}.png`;
        log(`fetching tile ${key} (${tiles.size + 1})`);
        const res = await fetch(url);
        if (!res.ok) throw new Error(`tile ${key}: HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        tiles.set(key, PNG.sync.read(buf));
    }
    return tiles.get(key);
}

function mercatorPixel(lon, lat) {
    const n = 2 ** Z * 256;
    const x = (lon + 180) / 360 * n;
    const y = (1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * n;
    return [x, y];
}

async function elevationAt(px, py) {
    // Bilinear over the 4 surrounding pixels (tiles fetched as needed).
    const x0 = Math.floor(px - 0.5), y0 = Math.floor(py - 0.5);
    const fx = px - 0.5 - x0, fy = py - 0.5 - y0;
    let acc = 0;
    for (const [dx, dy, w] of [[0, 0, (1 - fx) * (1 - fy)], [1, 0, fx * (1 - fy)], [0, 1, (1 - fx) * fy], [1, 1, fx * fy]]) {
        const gx = x0 + dx, gy = y0 + dy;
        const tile = await getTile(Math.floor(gx / 256), Math.floor(gy / 256));
        const ix = (gy % 256) * 256 + (gx % 256);
        const r = tile.data[ix * 4], g = tile.data[ix * 4 + 1], b = tile.data[ix * 4 + 2];
        acc += w * ((r * 256 + g + b / 256) - 32768);
    }
    return acc;
}

const elev = new Float32Array(grid.size);
const t0 = Date.now();
for (let idx = 0; idx < grid.size; idx++) {
    const [lon, lat] = toWGS(grid.centerOf(idx));
    const [px, py] = mercatorPixel(lon, lat);
    elev[idx] = await elevationAt(px, py);
    if (idx % 100000 === 0 && idx > 0) {
        const eta = Math.round((Date.now() - t0) / idx * (grid.size - idx) / 1000);
        log(`sampled ${idx}/${grid.size} cells, ETA ${eta}s`);
    }
}
fs.writeFileSync(BIN_FILE, Buffer.from(elev.buffer));
fs.writeFileSync(META_FILE, JSON.stringify({ cols: grid.cols, rows: grid.rows, xmin: grid.xmin, ymin: grid.ymin, cell: grid.cell, zoom: Z }));
log(`wrote ${BIN_FILE} (${tiles.size} tiles used)`);
