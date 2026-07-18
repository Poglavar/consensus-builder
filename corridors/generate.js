// Algorithmic corridor proposal generator (prototype) — see ../algorithmic-corridors.md.
// Pipeline: cost surface (cadastre + OSM + slope) -> least-cost path -> iterative
// penalty diversity loop -> arc smoothing with min curve radius -> PostGIS parcel
// set extraction -> Jaccard dedupe -> GeoJSON + proposals.json outputs.
// Usage: node generate.js --run [options]  (run --help for the list)
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, OUT_DIR, ORIGIN, DESTINATION, DEFAULTS, COST } from './lib/config.js';
import { makeGrid } from './lib/grid.js';
import { toHTRS } from './lib/proj.js';
import { connect } from './lib/db.js';
import { stampPolygon, stampLine } from './lib/raster.js';
import { leastCostPath } from './lib/dijkstra.js';
import { simplify, filletPath, pathLength, minDiscreteRadius, resample } from './lib/smooth.js';
import { extractParcels, jaccard } from './lib/parcels.js';
import { log, fail } from './lib/log.js';

// ---------- CLI ----------
const args = process.argv.slice(2);
function opt(name, def) {
    const i = args.indexOf('--' + name);
    return i >= 0 ? Number(args[i + 1]) : def;
}
if (!args.includes('--run')) {
    console.log(`Generate diverse curvature-legal corridor alternatives ${ORIGIN.name} -> ${DESTINATION.name}.`);
    console.log('Usage: node generate.js --run [options]');
    console.log('  --radius <m>       min curve radius        (default', DEFAULTS.minCurveRadius + ')');
    console.log('  --max-length <m>   corridor length cap     (default', DEFAULTS.maxLengthFactor + 'x straight line)');
    console.log('  --width <m>        corridor width          (default', DEFAULTS.corridorWidth + ')');
    console.log('  --count <n>        distinct proposals      (default', DEFAULTS.targetCount + ')');
    console.log('  --penalty <f>      penalty factor          (default', DEFAULTS.penaltyFactor + ')');
    console.log('  --jaccard <f>      similarity threshold    (default', DEFAULTS.jaccardThreshold + ')');
    console.log('  --allow-remote     permit a non-local database server');
    console.log('Requires data/osm-layers.json (fetch-osm-layers.js) and optionally data/dem-grid.bin (fetch-dem.js).');
    process.exit(0);
}

const grid = makeGrid();
const straight = Math.hypot(...(() => { const a = toHTRS([ORIGIN.lon, ORIGIN.lat]), b = toHTRS([DESTINATION.lon, DESTINATION.lat]); return [a[0] - b[0], a[1] - b[1]]; })());
const P = {
    minCurveRadius: opt('radius', DEFAULTS.minCurveRadius),
    maxLength: opt('max-length', DEFAULTS.maxLengthFactor * straight),
    corridorWidth: opt('width', DEFAULTS.corridorWidth),
    targetCount: opt('count', DEFAULTS.targetCount),
    penaltyFactor: opt('penalty', DEFAULTS.penaltyFactor),
    jaccardThreshold: opt('jaccard', DEFAULTS.jaccardThreshold),
};
log('parameters', { ...P, straightLine: Math.round(straight), grid: `${grid.cols}x${grid.rows}` });

// ---------- load layers ----------
const osmFile = path.join(DATA_DIR, 'osm-layers.json');
if (!fs.existsSync(osmFile)) fail('data/osm-layers.json missing — run: node fetch-osm-layers.js --run');
const osm = JSON.parse(fs.readFileSync(osmFile, 'utf8'));

let elev = null;
const demFile = path.join(DATA_DIR, 'dem-grid.bin');
if (fs.existsSync(demFile)) {
    const meta = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'dem-grid.meta.json'), 'utf8'));
    if (meta.cols !== grid.cols || meta.rows !== grid.rows) fail('dem-grid.bin was built for a different grid — refetch with fetch-dem.js --run --force');
    const demBuf = fs.readFileSync(demFile);
    elev = new Float32Array(demBuf.buffer, demBuf.byteOffset, demBuf.length / 4);
    log('DEM loaded');
} else {
    log('WARNING: no DEM (data/dem-grid.bin) — slope penalty disabled, routes may cross steep terrain');
}

// ---------- parcel grid (cached; built from PostGIS on first run) ----------
const client = await connect({ allowRemote: args.includes('--allow-remote') });
const parcelGridFile = path.join(DATA_DIR, 'parcel-grid.bin');
let parcelCount; // Uint16 per cell: number of parcels intersecting the cell
if (fs.existsSync(parcelGridFile)) {
    const pgBuf = fs.readFileSync(parcelGridFile);
    parcelCount = new Uint16Array(pgBuf.buffer, pgBuf.byteOffset, pgBuf.length / 2);
    if (parcelCount.length !== grid.size) fail('parcel-grid.bin was built for a different grid — delete it and rerun');
    log('parcel grid loaded from cache');
} else {
    log('building parcel grid in PostGIS (one-time, may take minutes)...');
    parcelCount = new Uint16Array(grid.size);
    const { rows } = await client.query(`
        SELECT (g.i - $1::int) AS col, (g.j - $2::int) AS row, count(*)::int AS n
        FROM parcel p
        CROSS JOIN LATERAL ST_SquareGrid($3::float8, p.geom) g
        WHERE p.current AND p.geom && ST_MakeEnvelope($4, $5, $6, $7, 3765)
          AND ST_Intersects(p.geom, g.geom)
        GROUP BY 1, 2`,
        [grid.i0, grid.j0, grid.cell, grid.xmin, grid.ymin, grid.xmax, grid.ymax]);
    for (const r of rows) {
        if (r.col >= 0 && r.col < grid.cols && r.row >= 0 && r.row < grid.rows) {
            parcelCount[grid.idx(r.col, r.row)] = Math.min(65535, r.n);
        }
    }
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(parcelGridFile, Buffer.from(parcelCount.buffer));
    log(`parcel grid built (${rows.length} covered cells)`);
}

// ---------- cost surface ----------
log('assembling cost surface...');
const baseCost = new Float32Array(grid.size).fill(1);
let blocked = 0;
for (let i = 0; i < grid.size; i++) {
    if (parcelCount[i] === 0) { baseCost[i] = COST.noParcel; blocked++; continue; }
    const extra = Math.min(COST.fragmentationCap, 1 + COST.fragmentationPerParcel * (parcelCount[i] - 1));
    baseCost[i] = extra;
}
log(`  no-parcel blocked cells: ${blocked} (${(100 * blocked / grid.size).toFixed(1)}%)`);

const mul = f => i => { if (isFinite(baseCost[i])) baseCost[i] *= f; };
const set = v => i => { baseCost[i] = v; };
for (const w of osm.water) if (w.closed) stampPolygon(grid, w.coords, set(COST.water));
for (const w of osm.wetland) if (w.closed) stampPolygon(grid, w.coords, mul(COST.wetland));
for (const w of [...osm.protected, ...osm.nature_reserve]) if (w.closed) stampPolygon(grid, w.coords, mul(COST.protected));
for (const w of osm.builtup) if (w.closed) stampPolygon(grid, w.coords, mul(COST.builtup));
for (const w of osm.aerodrome) if (w.closed) stampPolygon(grid, w.coords, mul(COST.aerodrome));
if (elev) {
    let steep = 0;
    for (let row = 0; row < grid.rows; row++) {
        for (let col = 0; col < grid.cols; col++) {
            const i = grid.idx(col, row);
            if (!isFinite(baseCost[i])) continue;
            const cl = col > 0 ? i - 1 : i, cr = col < grid.cols - 1 ? i + 1 : i;
            const rd = row > 0 ? i - grid.cols : i, ru = row < grid.rows - 1 ? i + grid.cols : i;
            const sx = (elev[cr] - elev[cl]) / ((cr - cl) === 2 ? 2 * grid.cell : grid.cell);
            const sy = (elev[ru] - elev[rd]) / ((ru - rd) === 2 * grid.cols ? 2 * grid.cell : grid.cell);
            const slope = Math.hypot(sx, sy);
            if (slope > COST.slopeBlock) { baseCost[i] = Infinity; steep++; continue; }
            baseCost[i] *= 1 + Math.min(COST.slopeCap, (slope / COST.slopeRef) ** 2);
        }
    }
    log(`  slope-blocked cells: ${steep}`);
}
// Soft keep-away zone near blocked cells: raw least-cost paths otherwise hug
// obstacle edges, leaving the min-radius arcs no room and making smoothing
// fail. Costs rise as cells get closer to a blocked cell.
{
    const KEEPAWAY_CELLS = 3, KEEPAWAY_FACTOR = 1.6;
    const nearBlocked = new Uint8Array(grid.size);
    for (let row = 0; row < grid.rows; row++) {
        for (let col = 0; col < grid.cols; col++) {
            const i = grid.idx(col, row);
            if (isFinite(baseCost[i])) continue;
            for (let dr = -KEEPAWAY_CELLS; dr <= KEEPAWAY_CELLS; dr++) {
                for (let dc = -KEEPAWAY_CELLS; dc <= KEEPAWAY_CELLS; dc++) {
                    if (grid.inBounds(col + dc, row + dr)) {
                        const j = grid.idx(col + dc, row + dr);
                        const d = Math.max(Math.abs(dc), Math.abs(dr));
                        nearBlocked[j] = Math.max(nearBlocked[j], KEEPAWAY_CELLS + 1 - d);
                    }
                }
            }
        }
    }
    for (let i = 0; i < grid.size; i++) {
        if (isFinite(baseCost[i]) && nearBlocked[i]) {
            baseCost[i] *= 1 + (KEEPAWAY_FACTOR - 1) * nearBlocked[i] / KEEPAWAY_CELLS;
        }
    }
}

// Discounts last: cheap corridors along existing rail / major roads.
const railDiscount = new Float32Array(grid.size).fill(1);
for (const w of osm.rail) stampLine(grid, w.coords, COST.nearDist, i => { railDiscount[i] = Math.min(railDiscount[i], COST.railDiscount); });
for (const w of osm.major_road) stampLine(grid, w.coords, COST.nearDist, i => { railDiscount[i] = Math.min(railDiscount[i], COST.roadDiscount); });
for (let i = 0; i < grid.size; i++) if (isFinite(baseCost[i])) baseCost[i] *= railDiscount[i];

// ---------- endpoints ----------
function snapToUnblocked(lonLat, name) {
    const ideal = grid.idxOfPoint(toHTRS(lonLat));
    if (ideal < 0) fail(`${name} endpoint is outside the grid`);
    // BFS outward until a non-blocked cell is found.
    const queue = [ideal];
    const seen = new Set(queue);
    while (queue.length) {
        const i = queue.shift();
        if (isFinite(baseCost[i])) {
            if (i !== ideal) log(`${name} snapped ${Math.round(Math.hypot(...grid.centerOf(i).map((v, k) => v - grid.centerOf(ideal)[k])))}m to nearest unblocked cell`);
            return i;
        }
        const col = i % grid.cols, row = Math.floor(i / grid.cols);
        for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            if (grid.inBounds(col + dc, row + dr)) {
                const j = grid.idx(col + dc, row + dr);
                if (!seen.has(j)) { seen.add(j); queue.push(j); }
            }
        }
        if (seen.size > 10000) break;
    }
    fail(`${name}: no unblocked cell within ~1km — check the cost surface`);
}
const startIdx = snapToUnblocked([ORIGIN.lon, ORIGIN.lat], ORIGIN.name);
const endIdx = snapToUnblocked([DESTINATION.lon, DESTINATION.lat], DESTINATION.name);

const slug = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// ---------- diversity loop ----------
const runId = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
const runDir = path.join(OUT_DIR, runId);
fs.mkdirSync(runDir, { recursive: true });
const penalty = new Float32Array(grid.size).fill(1);
const PENALTY_MAX = 50;
const accepted = [];
const proposalsFile = path.join(runDir, 'proposals.json');

function stampPathPenalty(coords, factor) {
    stampLine(grid, coords, DEFAULTS.penaltyRadius, i => {
        penalty[i] = Math.min(PENALTY_MAX, penalty[i] * factor);
    });
}

// Short crossings of blocked cells are allowed — a rail line bridges a sea
// notch or an out-of-cadastre pocket with a viaduct/embankment. Long ones are
// rejected (that would be a real sea crossing).
const EXCURSION_STEP = 10, EXCURSION_MAX_RUN = 200, EXCURSION_MAX_TOTAL = 800;
function blockedExcursions(coords) {
    let run = 0, maxRun = 0, total = 0;
    for (const p of resample(coords, EXCURSION_STEP)) {
        const i = grid.idxOfPoint(p);
        if (i < 0) return { maxRun: Infinity, total: Infinity }; // left the grid
        if (!isFinite(baseCost[i])) {
            run += EXCURSION_STEP; total += EXCURSION_STEP;
            if (run > maxRun) maxRun = run;
        } else {
            run = 0;
        }
    }
    return { maxRun, total };
}

// Try progressively finer simplification: coarse tolerance gives long
// tangents (nice geometry) but arcs may swing into blocked cells; finer
// tolerances hug the raw path more closely.
function smoothWithFallback(rawCoords, radius) {
    for (const tol of [60, 30, 15]) {
        const smoothed = filletPath(simplify(rawCoords, tol), radius);
        if (!smoothed) continue;
        if (pathLength(smoothed) > P.maxLength) continue;
        const exc = blockedExcursions(smoothed);
        if (exc.maxRun > EXCURSION_MAX_RUN || exc.total > EXCURSION_MAX_TOTAL) continue;
        return { smoothed, exc, tol };
    }
    return null;
}

for (let iter = 1; iter <= DEFAULTS.maxIterations && accepted.length < P.targetCount; iter++) {
    const t0 = Date.now();
    const result = leastCostPath(grid, baseCost, penalty, startIdx, endIdx);
    if (!result) { log(`iter ${iter}: endpoints disconnected — stopping`); break; }
    const rawCoords = result.path.map(i => grid.centerOf(i));
    const rawLen = pathLength(rawCoords);
    if (rawLen > P.maxLength) { log(`iter ${iter}: raw path ${Math.round(rawLen)}m exceeds cap ${Math.round(P.maxLength)}m — search space exhausted`); break; }

    const sm = smoothWithFallback(rawCoords, P.minCurveRadius);
    if (!sm) {
        log(`iter ${iter}: rejected (no radius-legal geometry within blocked-excursion limits) — penalizing and retrying`);
        stampPathPenalty(rawCoords, DEFAULTS.rejectPenaltyFactor);
        continue;
    }
    const { smoothed, exc } = sm;

    const ext = await extractParcels(client, smoothed, P.corridorWidth);
    const maxJac = accepted.length ? Math.max(...accepted.map(a => jaccard(a.parcelIds, ext.parcelIds))) : 0;
    if (maxJac > P.jaccardThreshold) {
        log(`iter ${iter}: rejected (jaccard ${maxJac.toFixed(2)} vs accepted) — penalizing and retrying`);
        stampPathPenalty(smoothed, DEFAULTS.rejectPenaltyFactor);
        continue;
    }

    const n = accepted.length + 1;
    const lengthM = Math.round(pathLength(smoothed));
    const minR = Math.round(minDiscreteRadius(smoothed));
    const record = {
        id: `${slug(ORIGIN.name)}-${slug(DESTINATION.name)}-${runId}-${String(n).padStart(2, '0')}`,
        lengthM, minRadiusM: minR, cost: Math.round(result.cost),
        bridgedM: exc.total, longestBridgeM: exc.maxRun,
        maxJaccardVsOthers: Number(maxJac.toFixed(3)),
        parcelCount: ext.parcelIds.size,
        parcelIds: [...ext.parcelIds].sort((a, b) => a - b),
        parcels: ext.parcels,
    };
    accepted.push({ ...record, parcelIds: ext.parcelIds });

    fs.writeFileSync(path.join(runDir, `corridor-${String(n).padStart(2, '0')}.geojson`), JSON.stringify({
        type: 'FeatureCollection',
        features: [
            { type: 'Feature', properties: { ...record, parcelIds: undefined, parcels: undefined, kind: 'corridor' }, geometry: ext.corridorGeoJSON },
            { type: 'Feature', properties: { id: record.id, kind: 'centerline' }, geometry: ext.centerlineGeoJSON },
        ],
    }));
    fs.writeFileSync(proposalsFile, JSON.stringify(accepted.map(a => ({ ...a, parcelIds: [...a.parcelIds].sort((x, y) => x - y), parcels: undefined })), null, 1));
    log(`iter ${iter}: ACCEPTED #${n} — ${lengthM}m, minR ${minR}m, ${ext.parcelIds.size} parcels, jaccard ${maxJac.toFixed(2)}, ${Date.now() - t0}ms`);
    stampPathPenalty(smoothed, P.penaltyFactor);
}

// Combined overview file for quick inspection (geojson.io etc.).
const allFeatures = [];
for (let i = 1; i <= accepted.length; i++) {
    const fc = JSON.parse(fs.readFileSync(path.join(runDir, `corridor-${String(i).padStart(2, '0')}.geojson`), 'utf8'));
    allFeatures.push(fc.features.find(f => f.properties.kind === 'centerline'));
}
fs.writeFileSync(path.join(runDir, 'all-centerlines.geojson'), JSON.stringify({ type: 'FeatureCollection', features: allFeatures }));

log(`done: ${accepted.length}/${P.targetCount} distinct proposals in ${runDir}`);
log('summary:', accepted.map(a => `${a.id.slice(-2)}: ${a.lengthM}m/${a.parcelCount} parcels`).join('  '));
await client.end();
