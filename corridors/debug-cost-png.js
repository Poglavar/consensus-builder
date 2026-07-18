// Debug visualization: renders the cost surface to data/cost-debug.png
// (black = blocked, white = cheap, red = penalized/expensive, blue line = rail).
// Usage: node debug-cost-png.js --run
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { DATA_DIR, COST } from './lib/config.js';
import { makeGrid } from './lib/grid.js';
import { stampPolygon, stampLine } from './lib/raster.js';
import { log } from './lib/log.js';

if (!process.argv.includes('--run')) {
    console.log('Render the cost surface to data/cost-debug.png. Usage: node debug-cost-png.js --run');
    process.exit(0);
}

const grid = makeGrid();
const pgBuf = fs.readFileSync(path.join(DATA_DIR, 'parcel-grid.bin'));
const parcelCount = new Uint16Array(pgBuf.buffer, pgBuf.byteOffset, pgBuf.length / 2);
const osm = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'osm-layers.json'), 'utf8'));

const png = new PNG({ width: grid.cols, height: grid.rows });
for (let row = 0; row < grid.rows; row++) {
    for (let col = 0; col < grid.cols; col++) {
        const i = grid.idx(col, row);
        // PNG rows top-down; grid rows bottom-up.
        const p = ((grid.rows - 1 - row) * grid.cols + col) * 4;
        const covered = parcelCount[i] > 0;
        png.data[p] = covered ? 230 : 0;
        png.data[p + 1] = covered ? 230 : 0;
        png.data[p + 2] = covered ? 230 : 0;
        png.data[p + 3] = 255;
    }
}
const paint = (r, g, b) => i => {
    const row = Math.floor(i / grid.cols), col = i % grid.cols;
    const p = ((grid.rows - 1 - row) * grid.cols + col) * 4;
    png.data[p] = r; png.data[p + 1] = g; png.data[p + 2] = b;
};
for (const w of osm.builtup) if (w.closed) stampPolygon(grid, w.coords, paint(255, 200, 120));
for (const w of osm.water) if (w.closed) stampPolygon(grid, w.coords, paint(80, 80, 255));
for (const w of osm.rail) stampLine(grid, w.coords, 30, paint(0, 160, 0));

// Overlay accepted centerlines from the newest run (distinct colors).
const OUT_DIR = path.join(path.dirname(DATA_DIR), 'out');
const runs = fs.existsSync(OUT_DIR) ? fs.readdirSync(OUT_DIR).sort() : [];
if (runs.length) {
    const runDir = path.join(OUT_DIR, runs[runs.length - 1]);
    const { toHTRS } = await import('./lib/proj.js');
    const colors = [[220, 0, 0], [160, 0, 200], [0, 90, 220], [200, 120, 0], [0, 140, 140], [120, 90, 40], [255, 0, 130], [90, 90, 255], [0, 0, 0], [130, 160, 0], [255, 90, 90], [90, 40, 130]];
    const files = fs.readdirSync(runDir).filter(f => /^corridor-\d+\.geojson$/.test(f)).sort();
    files.forEach((f, k) => {
        const fc = JSON.parse(fs.readFileSync(path.join(runDir, f), 'utf8'));
        const line = fc.features.find(x => x.properties.kind === 'centerline');
        const coords = line.geometry.coordinates.map(toHTRS);
        stampLine(grid, coords, 25, paint(...colors[k % colors.length]));
    });
    log(`overlaid ${files.length} centerlines from ${runs[runs.length - 1]}`);
}
fs.writeFileSync(path.join(DATA_DIR, 'cost-debug.png'), PNG.sync.write(png));
log('wrote data/cost-debug.png');
