// The ground under a 3D scene: what covers it (grass, shrubs, crops, bare soil, sand, rock, built-up
// ground, forest floor, wetland, snow) on a coarse grid, and the colour each of those looks has
// there, so the model view paints its ground with a procedural pattern per look in the local colour
// instead of grey pavement everywhere. The look of a cell is ESA WorldCover 2021 (10 m land cover,
// worldwide), overridden where OpenStreetMap maps sand, rock, ice or wetland (OpenFreeMap
// landcover). The colours are medians of the ESA WorldCover 2021 Sentinel-2 annual composite over
// each look's cells: a few samples, never an image. Both are CC BY 4.0, read as Cloud-Optimized
// GeoTIFFs from ESA's public buckets with range requests (no CORS there, so the server reads them).

import * as turf from '@turf/turf';
import { expandBbox } from '../buildings/osm-3d.js';
import { createTileReader } from './openfreemap-tiles.js';

// Look ids as the cell values carry them; 0 is a cell nothing describes (open sea, a missing tile).
export const LOOKS = Object.freeze(['none', 'grass', 'shrub', 'crop', 'bare', 'sand', 'rock', 'built', 'forest', 'wetland', 'snow']);
const LOOK_ID = Object.freeze(Object.fromEntries(LOOKS.map((name, id) => [name, id])));
// WorldCover v200 class → look. Open water reads as wetland: mapped water is drawn over it from
// OpenStreetMap, so what shows of it is a shore.
const WORLDCOVER_LOOK = Object.freeze({ 10: 'forest', 20: 'shrub', 30: 'grass', 40: 'crop', 50: 'built', 60: 'bare',
    70: 'snow', 80: 'wetland', 90: 'wetland', 95: 'forest', 100: 'grass' });
// OpenFreeMap landcover classes the green layer does not draw (openfreemap-green.js), → look.
const OSM_LOOK = Object.freeze({ sand: 'sand', rock: 'rock', ice: 'snow', wetland: 'wetland' });

// A cell is about this many metres across; a large scene gets larger cells rather than more.
export const CELL_M = 20;
export const MAX_CELLS = 256;
// The colour samples are read on a coarser grid: medians need a few hundred samples, not every cell.
const COLOUR_CELLS = 48;
// Sentinel-2 L2A reflectance (×10000) that shows as full white: the scale of Sentinel-2's own true
// colour images (0..2000), a little softer so sunlit ground is not washed out.
const REFLECTANCE_WHITE = 2600;
const READ_TIMEOUT_MS = 20000;
const RESULT_CACHE_MAX = 64;

const MAP_ROOT = 'https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map';
const S2_ROOT = 'https://esa-worldcover-s2.s3.eu-central-1.amazonaws.com/rgbnir/2021';
// ESA's own wording (esa-worldcover.org/en/data-access, "Citation") as an HTML credit for Settings →
// Sources & software (ui/map-credits.js keeps its links and drops other markup), with OpenStreetMap's
// for the sand, rock and foot ways.
export const ATTRIBUTION = '© <a href="https://esa-worldcover.org/">ESA WorldCover project 2021</a> / Contains modified '
    + 'Copernicus Sentinel data (2021) processed by ESA WorldCover consortium, '
    + '<a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a> · '
    + '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

const pad = (value, width) => String(Math.abs(value)).padStart(width, '0');
const tileName = (lat, lon) => `${lat < 0 ? 'S' : 'N'}${pad(lat, 2)}${lon < 0 ? 'W' : 'E'}${pad(lon, 3)}`;

// The WorldCover map tiles (3° squares named by their south-west corner) and Sentinel-2 composite
// tiles (1° squares) covering a bbox: [{ url, bbox }].
export function mapTiles([w, s, e, n]) {
    return squares([w, s, e, n], 3).map(([lat, lon]) => ({
        url: `${MAP_ROOT}/ESA_WorldCover_10m_2021_v200_${tileName(lat, lon)}_Map.tif`, bbox: [lon, lat, lon + 3, lat + 3]
    }));
}
export function colourTiles([w, s, e, n]) {
    return squares([w, s, e, n], 1).map(([lat, lon]) => ({
        url: `${S2_ROOT}/${lat < 0 ? 'S' : 'N'}${pad(lat, 2)}/ESA_WorldCover_10m_2021_v200_${tileName(lat, lon)}_S2RGBNIR.tif`,
        bbox: [lon, lat, lon + 1, lat + 1]
    }));
}
function squares([w, s, e, n], size) {
    const out = [];
    for (let lat = Math.floor(s / size) * size; lat < n; lat += size) {
        for (let lon = Math.floor(w / size) * size; lon < e; lon += size) out.push([lat, lon]);
    }
    return out;
}

// A grid of `cols` × `rows` equal cells over the bbox, row 0 at the north.
export function gridFor(bbox, cellM = CELL_M, maxCells = MAX_CELLS) {
    const [w, s, e, n] = bbox;
    const widthM = turf.distance([w, (s + n) / 2], [e, (s + n) / 2], { units: 'meters' });
    const heightM = turf.distance([w, s], [w, n], { units: 'meters' });
    const count = metres => Math.min(maxCells, Math.max(1, Math.round(metres / cellM)));
    return { bbox, cols: count(widthM), rows: count(heightM) };
}

// The part of `grid` whose cell centres lie in `tileBbox`: the cell ranges and their exact bbox.
function windowOf(grid, tileBbox) {
    const [w, s, e, n] = grid.bbox;
    const dx = (e - w) / grid.cols, dy = (n - s) / grid.rows;
    const col0 = Math.max(0, Math.ceil((tileBbox[0] - w) / dx - 0.5));
    const col1 = Math.min(grid.cols, Math.ceil((tileBbox[2] - w) / dx - 0.5));
    const row0 = Math.max(0, Math.ceil((n - tileBbox[3]) / dy - 0.5));
    const row1 = Math.min(grid.rows, Math.ceil((n - tileBbox[1]) / dy - 0.5));
    if (col1 <= col0 || row1 <= row0) return null;
    return { col0, col1, row0, row1, bbox: [w + col0 * dx, n - row1 * dy, w + col1 * dx, n - row0 * dy] };
}

// Reads `grid` from the tiles: `read(tile, window)` → band arrays for that window, laid into
// per-band arrays of the whole grid (0 where no tile answered).
async function readGrid(grid, tiles, bands, read) {
    const out = Array.from({ length: bands }, () => new Uint16Array(grid.cols * grid.rows));
    await Promise.all(tiles.map(async tile => {
        const win = windowOf(grid, tile.bbox);
        if (!win) return;
        const rasters = await read(tile, win);
        if (!rasters) return;
        const width = win.col1 - win.col0;
        for (let b = 0; b < bands; b++) {
            for (let r = win.row0; r < win.row1; r++) {
                for (let c = win.col0; c < win.col1; c++) out[b][r * grid.cols + c] = rasters[b][(r - win.row0) * width + (c - win.col0)];
            }
        }
    }));
    return out;
}

// Cells whose centre lies inside an OpenStreetMap sand/rock/ice/wetland area take its look.
export function overrideFromLandcover(looks, grid, features) {
    const [w, s, e, n] = grid.bbox;
    const dx = (e - w) / grid.cols, dy = (n - s) / grid.rows;
    let changed = 0;
    for (const feature of features) {
        const look = OSM_LOOK[feature.properties?.class];
        if (!look || !/Polygon$/.test(feature.geometry?.type || '')) continue;
        const [fw, fs, fe, fn] = turf.bbox(feature);
        const c0 = Math.max(0, Math.floor((fw - w) / dx)), c1 = Math.min(grid.cols - 1, Math.floor((fe - w) / dx));
        const r0 = Math.max(0, Math.floor((n - fn) / dy)), r1 = Math.min(grid.rows - 1, Math.floor((n - fs) / dy));
        for (let r = r0; r <= r1; r++) {
            for (let c = c0; c <= c1; c++) {
                if (!turf.booleanPointInPolygon([w + (c + 0.5) * dx, n - (r + 0.5) * dy], feature)) continue;
                looks[r * grid.cols + c] = LOOK_ID[look];
                changed++;
            }
        }
    }
    return changed;
}

// { look: { rgb: [r, g, b], ndvi, samples } }: per look, the median Sentinel-2 colour (sRGB bytes)
// and vegetation index ((NIR − red) / (NIR + red), 0 bare … ~0.8 lush) of the colour cells under its
// cells. An annual median is dull (winter counts), so the renderer, not this, decides how green a
// look is from its ndvi. Built-up ground keeps the renderer's own pavement colour, so it gets none.
export function paletteFrom(looks, grid, colour, colourGrid) {
    const samples = new Map();
    for (let r = 0; r < grid.rows; r++) {
        const cr = Math.min(colourGrid.rows - 1, Math.floor(r * colourGrid.rows / grid.rows));
        for (let c = 0; c < grid.cols; c++) {
            const look = LOOKS[looks[r * grid.cols + c]];
            if (!look || look === 'none' || look === 'built') continue;
            const cc = Math.min(colourGrid.cols - 1, Math.floor(c * colourGrid.cols / grid.cols));
            const i = cr * colourGrid.cols + cc;
            if (!colour[0][i] || !colour[1][i] || !colour[2][i] || !colour[3][i]) continue;
            if (!samples.has(look)) samples.set(look, [[], [], [], []]);
            const bucket = samples.get(look);
            for (let b = 0; b < 4; b++) bucket[b].push(colour[b][i]);
        }
    }
    const palette = {};
    for (const [look, bands] of samples) {
        // A typed array sorts numerically without a comparator: ~4× faster over a scene's 65k cells.
        const [red, green, blue, nir] = bands.map(values => {
            const sorted = Uint16Array.from(values).sort();
            return sorted[sorted.length >> 1];
        });
        palette[look] = {
            rgb: [red, green, blue].map(value => Math.round(255 * Math.min(1, value / REFLECTANCE_WHITE))),
            ndvi: Math.round(1000 * (nir - red) / (nir + red)) / 1000,
            samples: bands[0].length
        };
    }
    return palette;
}

const log = (...args) => console.log(`[${new Date().toISOString()}] [ground-cover]`, ...args);

function withTimeout(promise, ms, what) {
    let timer;
    return Promise.race([promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error(`${what} timed out after ${ms} ms`), { status: 504 })), ms);
    })]).finally(() => clearTimeout(timer));
}

// geotiff is imported on the first tile read, not with this module: its web-worker dependency reads
// worker data the moment it loads inside any worker thread, and the routes that import this module run
// in worker threads under vitest (--pool=threads).
// ESA's tiles are 1024² deflate blocks; inflating one on the API's thread held every other request
// up to ~110 ms, so they inflate in two worker threads shared by every tile.
const DECODER_THREADS = 2;
let decoderPool = null;
const openCog = url => import('geotiff').then(async ({ fromUrl, Pool }) => {
    decoderPool ||= new Pool(DECODER_THREADS);
    const tiff = await fromUrl(url);
    return { readRasters: options => tiff.readRasters({ ...options, pool: decoderPool }) };
});

export function createGroundCoverProvider({ reader = createTileReader(), open = openCog, fetchImpl = fetch, now = Date.now } = {}) {
    const images = new Map(); // tile URL → Promise<GeoTIFF|null> (null: no such tile, the sea)
    const results = new Map(); // area key → result, most recent last

    function image(url) {
        if (!images.has(url)) {
            images.set(url, open(url).catch(async error => {
                // A tile that does not exist is the open sea (geotiff's error does not say which, so
                // ask the bucket); anything else may pass, so the next read tries again.
                const head = await fetchImpl(url, { method: 'HEAD' }).catch(() => null);
                if (head && head.status === 404) return null;
                images.delete(url);
                throw error;
            }));
        }
        return images.get(url);
    }

    const readTile = (bands, resampleMethod) => async (tile, win) => {
        const tiff = await image(tile.url);
        if (!tiff) return null;
        const rasters = await tiff.readRasters({ bbox: win.bbox, width: win.col1 - win.col0, height: win.row1 - win.row0,
            samples: bands, resampleMethod });
        return bands.map((_, b) => rasters[b]);
    };

    async function near(geometry, bufferMeters) {
        const bbox = expandBbox(turf.bbox(geometry), bufferMeters);
        const key = bbox.map(value => value.toFixed(5)).join(',');
        if (results.has(key)) {
            const hit = results.get(key);
            results.delete(key);
            results.set(key, hit);
            return hit;
        }
        const started = now();
        const grid = gridFor(bbox);
        const colourGrid = { bbox, cols: Math.min(grid.cols, COLOUR_CELLS), rows: Math.min(grid.rows, COLOUR_CELLS) };
        const [classes, colour, landcover] = await withTimeout(Promise.all([
            readGrid(grid, mapTiles(bbox), 1, readTile([0], 'nearest')),
            readGrid(colourGrid, colourTiles(bbox), 4, readTile([0, 1, 2, 3], 'bilinear')),
            reader.features(bbox, ['landcover']).then(result => result.features)
        ]), READ_TIMEOUT_MS, 'Ground cover');

        const looks = new Uint8Array(grid.cols * grid.rows);
        classes[0].forEach((value, i) => { looks[i] = LOOK_ID[WORLDCOVER_LOOK[value]] || 0; });
        const overridden = overrideFromLandcover(looks, grid, landcover);
        const counts = {};
        looks.forEach(id => { if (id) counts[LOOKS[id]] = (counts[LOOKS[id]] || 0) + 1; });
        const result = {
            bbox, cols: grid.cols, rows: grid.rows, cellM: CELL_M,
            looks: Buffer.from(looks).toString('base64'), lookNames: LOOKS,
            palette: paletteFrom(looks, grid, colour, colourGrid), counts,
            source: 'esa-worldcover-2021', attribution: ATTRIBUTION
        };
        log(`${grid.cols}×${grid.rows} cells (${overridden} from OSM), looks ${JSON.stringify(counts)} in ${now() - started} ms`);
        results.set(key, result);
        if (results.size > RESULT_CACHE_MAX) results.delete(results.keys().next().value);
        return result;
    }
    return { near };
}
