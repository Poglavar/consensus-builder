// GlobalBuildingAtlas (TU Munich, LoD1): building footprints with satellite-predicted heights, read on
// demand from the GeoParquet copy on Source Cooperative. Each 5° tile's row groups cover small areas,
// so a building cell reads only the one or two groups under it. Serves the `global-building-atlas`
// building source and the height estimates other sources use for buildings that state no height.
import zlib from 'node:zlib';
import * as turf from '@turf/turf';
import { createRequire } from 'node:module';
import { asyncBufferFromUrl, cachedAsyncBuffer, parquetMetadataAsync, parquetReadObjects } from 'hyparquet';

const require = createRequire(import.meta.url);
const core = require('../../frontend/js/footprint-provider.js');

export const ATLAS_SOURCE = 'global-building-atlas';
export const ATLAS_BASE_URL = 'https://data.source.coop/tge-labs/globalbuildingatlas-lod1';
export const ATLAS_CREDIT = 'GlobalBuildingAtlas, TU Munich (CC BY-NC 4.0)';
const TILE_DEG = 5;
const REQUEST_TIMEOUT_MS = 30000;
const COLUMNS = ['source', 'id', 'height', 'bbox', 'geometry'];
const compressors = { ZSTD: input => new Uint8Array(zlib.zstdDecompressSync(input)) };

const log = (...args) => console.log(`[${new Date().toISOString()}] [global-building-atlas]`, ...args);

// Predictions under 2 m are noise around sheds and walls; above 500 m they are not buildings.
export function plausibleAtlasHeight(heightM) {
    return typeof heightM === 'number' && Number.isFinite(heightM) && heightM >= 2 && heightM <= 500;
}

// The 5° tiles a WGS84 box [w, s, e, n] touches, named as the atlas names them: e075_n45_e080_n40 is
// 75–80° E, 40–45° N (the northern edge first).
export function tileNamesFor([w, s, e, n]) {
    const lon = value => `${value < 0 ? 'w' : 'e'}${String(Math.abs(value)).padStart(3, '0')}`;
    const lat = value => `${value < 0 ? 's' : 'n'}${String(Math.abs(value)).padStart(2, '0')}`;
    const names = [];
    for (let x = Math.floor(w / TILE_DEG) * TILE_DEG; x < e; x += TILE_DEG) {
        for (let y = Math.floor(s / TILE_DEG) * TILE_DEG; y < n; y += TILE_DEG) {
            names.push(`${lon(x)}_${lat(y + TILE_DEG)}_${lon(x + TILE_DEG)}_${lat(y)}`);
        }
    }
    return names;
}

const timedFetch = (url, init = {}) => fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });

// One remote tile → { groups: [{ rowStart, rowEnd, bbox }], readRows(rowStart, rowEnd) }, or null when the
// atlas has no such tile (open sea). Any other failure throws: the source is unavailable, not empty.
async function openRemoteTile(url) {
    const head = await timedFetch(url, { method: 'HEAD' });
    if (head.status === 404) return null;
    const byteLength = Number(head.headers.get('content-length'));
    if (!head.ok || !(byteLength > 0)) throw Object.assign(new Error(`atlas tile HEAD ${head.status}`), { status: head.status });
    const file = cachedAsyncBuffer(await asyncBufferFromUrl({ url, byteLength, fetch: timedFetch }));
    const metadata = await parquetMetadataAsync(file);
    const names = metadata.row_groups[0]?.columns.map(column => column.meta_data.path_in_schema.join('.')) ?? [];
    const stat = (group, name) => group.columns[names.indexOf(name)]?.meta_data?.statistics;
    let rowStart = 0;
    const groups = metadata.row_groups.map(group => {
        const rows = Number(group.num_rows);
        const entry = { rowStart, rowEnd: rowStart + rows,
            bbox: [stat(group, 'bbox.xmin')?.min_value, stat(group, 'bbox.ymin')?.min_value,
                stat(group, 'bbox.xmax')?.max_value, stat(group, 'bbox.ymax')?.max_value] };
        rowStart += rows;
        return entry;
    });
    return { groups, readRows: (start, end) => parquetReadObjects({ file, metadata, rowStart: start, rowEnd: end, columns: COLUMNS, compressors }) };
}

const intersects = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
// A group without usable statistics may hold anything: it is read.
const groupMayIntersect = (group, box) => !group.bbox.every(Number.isFinite) || intersects(group.bbox, box);

/**
 * Reads atlas buildings by box. Tiles' indexes and recently read row groups are kept in memory, and
 * concurrent reads of one group share a request.
 * buildingsIn(box) → [{ id, kind ('osm' | 'ms' | …), heightM | null, bbox, geometry }]
 */
export function createAtlasReader({ baseUrl = ATLAS_BASE_URL, openTile = openRemoteTile, groupCacheSize = 12 } = {}) {
    const tiles = new Map();
    const groups = new Map();

    function tile(name) {
        const url = `${baseUrl}/${name}.parquet`;
        if (!tiles.has(url)) {
            const started = Date.now();
            tiles.set(url, openTile(url).then(opened => {
                log(`tile ${name}: ${opened ? `${opened.groups.length} row groups` : 'none (no buildings)'} in ${Date.now() - started} ms`);
                return opened;
            }, error => { tiles.delete(url); throw error; }));
        }
        return { url, pending: tiles.get(url) };
    }

    function group(url, opened, index) {
        const key = `${url}#${index}`;
        if (groups.has(key)) {
            const hit = groups.get(key);
            groups.delete(key);
            groups.set(key, hit);
            return hit;
        }
        const { rowStart, rowEnd } = opened.groups[index];
        const pending = opened.readRows(rowStart, rowEnd).then(rows => rows.map(row => ({
            id: String(row.id), kind: String(row.source),
            heightM: plausibleAtlasHeight(row.height) ? Math.round(row.height * 100) / 100 : null,
            bbox: [row.bbox.xmin, row.bbox.ymin, row.bbox.xmax, row.bbox.ymax], geometry: row.geometry
        })).filter(row => row.geometry), error => { groups.delete(key); throw error; });
        groups.set(key, pending);
        while (groups.size > groupCacheSize) groups.delete(groups.keys().next().value);
        return pending;
    }

    async function buildingsIn(box) {
        const found = [];
        for (const name of tileNamesFor(box)) {
            const { url, pending } = tile(name);
            const opened = await pending;
            if (!opened) continue;
            const wanted = opened.groups.map((entry, index) => groupMayIntersect(entry, box) ? index : -1).filter(index => index >= 0);
            const rows = await Promise.all(wanted.map(index => group(url, opened, index)));
            for (const list of rows) for (const row of list) if (intersects(row.bbox, box)) found.push(row);
        }
        return found;
    }

    return { buildingsIn };
}

function rowToFeature(row) {
    return { type: 'Feature', id: `GBA-${row.kind}-${row.id}`, geometry: row.geometry,
        properties: { measured_height_m: null, levels: null, atlas_height_m: row.heightM } };
}

const atlasEstimate = heightM => plausibleAtlasHeight(heightM) ? { heightM, source: ATLAS_SOURCE } : null;

// The atlas as a building source: its footprints (OpenStreetMap's as the atlas copied them and
// Microsoft's machine-learning ones) with the predicted height as each one's estimate.
export function createAtlasBuildingProvider({ reader = createAtlasReader() } = {}) {
    return core.createFootprintProvider({
        turf,
        label: ATLAS_SOURCE,
        log,
        async featuresIn(box) {
            return { features: (await reader.buildingsIn(box)).map(rowToFeature), partial: false };
        },
        heightEstimateFor: feature => atlasEstimate(feature.properties?.atlas_height_m),
        sources: { near: ATLAS_SOURCE, footprints: ATLAS_SOURCE }
    });
}

function areaOf(geometry) {
    try { return turf.area({ type: 'Feature', properties: {}, geometry }); } catch { return 0; /* an invalid ring has no measurable area */ }
}

/**
 * Height estimates from the atlas for another source's buildings that state no height or storeys:
 * the atlas row of the same OpenStreetMap way, else the atlas building covering more than half of the
 * footprint. → async (features, box) → (feature) → { heightM, source } | null
 */
export function createAtlasHeightEstimator({ reader = createAtlasReader() } = {}) {
    return async function estimateHeights(_features, box) {
        const rows = await reader.buildingsIn(box);
        const byWay = new Map(rows.filter(row => row.kind === 'osm').map(row => [row.id, row]));
        return feature => {
            const osmId = String(feature?.properties?.osm_id ?? '');
            if (/^w[1-9]\d*$/.test(osmId) && byWay.has(osmId.slice(1))) return atlasEstimate(byWay.get(osmId.slice(1)).heightM);
            const geometry = feature?.geometry;
            const own = areaOf(geometry);
            if (!(own > 0)) return null;
            const bbox = turf.bbox(geometry);
            let best = null, bestShare = 0.5;
            for (const row of rows) {
                if (row.heightM == null || !intersects(row.bbox, bbox)) continue;
                let clip = null;
                try { clip = turf.intersect({ type: 'Feature', properties: {}, geometry }, { type: 'Feature', properties: {}, geometry: row.geometry }); }
                catch { continue; /* an invalid ring covers nothing it can measure */ }
                const share = clip ? areaOf(clip.geometry) / own : 0;
                if (share > bestShare) { best = row; bestShare = share; }
            }
            return best ? atlasEstimate(best.heightM) : null;
        };
    };
}
