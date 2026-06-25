// Ingests features from the Overture Maps open data into per-city Postgres tables, used as the
// generic 3D source for cities with no bespoke local model. Layer-parameterized:
//   --layer buildings  → footprints + heights from theme=buildings  → overture_building
//   --layer trees      → individual trees (base/land subtype=tree)  → overture_tree
// Both layers share one pipeline: DuckDB pulls the city's bbox from Overture's public S3 GeoParquet
// into a newline-delimited JSON file (extract), then we stream it into Postgres in batches, upserting
// on (city, overture_id) so a re-run refreshes the city in place and is safe to restart.
//
// Generalized over cities via backend/buildings/overture-cities.js — add a city there, then run this
// per layer. Verbose, timestamped, progressive logging throughout.
//
// Usage:
//   node scripts/ingest-overture.js --city belgrade --layer buildings
//   node scripts/ingest-overture.js --city belgrade --layer trees
//   node scripts/ingest-overture.js --city belgrade --layer trees --bbox 20.44,44.80,20.48,44.83
//   node scripts/ingest-overture.js --city belgrade --layer trees --extract-only
//   node scripts/ingest-overture.js --city belgrade --layer trees --load-only --in /path/to.ndjson
//
// Requires the DuckDB CLI for the extract phase (https://duckdb.org/docs/installation/); point at a
// non-PATH binary with --duckdb /path. The load phase uses the same PG* env as the app (reads
// backend/.env via dotenv); set PGHOST=localhost when running on the host against local docker.

import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pkg from 'pg';
import { OVERTURE_CITIES } from '../buildings/overture-cities.js';

const { Pool } = pkg;
const __dirname = dirname(fileURLToPath(import.meta.url));

// Latest Overture release as of this writing; override with --release. Releases are monthly.
const DEFAULT_RELEASE = '2026-06-17.0';
const S3_REGION = 'us-west-2';
const BATCH_SIZE = 1000; // rows per UNNEST upsert — bounded so progress is visible and memory flat.

// Per-layer definitions. Each layer maps an Overture theme/type to a Postgres table and declares the
// per-row "extra" columns beyond the shared (city, overture_id, geom, overture_release). The extract
// SELECT, the spatial WHERE filter, the DDL, and the UNNEST upsert are all derived from this.
const LAYERS = {
    buildings: {
        table: 'overture_building',
        ddl: '../buildings/overture-building-ddl.sql',
        s3type: 'theme=buildings/type=building',
        select: 'id, height, num_floors, ST_AsGeoJSON(geometry) AS geom',
        whereExtra: '',
        extra: [
            { name: 'h', col: 'height_m', cast: 'float8', get: r => (Number.isFinite(r.height) ? r.height : null) },
            { name: 'nf', col: 'num_floors', cast: 'int', get: r => (Number.isFinite(r.num_floors) ? r.num_floors : null) },
        ],
    },
    trees: {
        table: 'overture_tree',
        ddl: '../decor/overture-tree-ddl.sql',
        s3type: 'theme=base/type=land',
        // Overture's base/land carries individual trees as POINT features (subtype/class = tree),
        // derived+cleaned from OSM natural=tree. No height column exists here — the renderer assigns a
        // deterministic per-tree height — so we only need id + geometry.
        select: 'id, ST_AsGeoJSON(geometry) AS geom',
        whereExtra: "AND subtype = 'tree' AND class = 'tree'",
        extra: [],
    },
};

function ts() { return new Date().toISOString(); }
function log(...args) { console.log(`[${ts()}]`, ...args); }
function fail(msg) { console.error(`[${ts()}] ERROR: ${msg}`); process.exit(1); }

function printUsage() {
    console.log(`
Ingest Overture Maps features for a city into Postgres.

  --city <id>          Required. City id from overture-cities.js (${Object.keys(OVERTURE_CITIES).join(', ') || 'none configured'}).
  --layer <name>       Which feature layer: ${Object.keys(LAYERS).join(' | ')} (default buildings).
  --bbox <minLng,minLat,maxLng,maxLat>
                       Override the city's bbox (useful for a small smoke test).
  --release <ver>      Overture release (default ${DEFAULT_RELEASE}).
  --extract-only       Run only the DuckDB extract; leave the .ndjson for inspection.
  --load-only          Skip extract; load an existing .ndjson (see --in).
  --in <path>          Input .ndjson for --load-only (default: the layer's extract path).
  --out <path>         Where the extract writes (default: scratch dir per city/layer/release).
  --duckdb <path>      Path to the DuckDB CLI if not on PATH.
  --help               This message.

Examples:
  node scripts/ingest-overture.js --city belgrade --layer buildings
  node scripts/ingest-overture.js --city belgrade --layer trees
`);
}

function parseArgs(argv) {
    const args = { release: DEFAULT_RELEASE, layer: 'buildings' };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        const next = () => argv[++i];
        switch (a) {
            case '--city': args.city = next(); break;
            case '--layer': args.layer = next(); break;
            case '--bbox': args.bbox = next(); break;
            case '--release': args.release = next(); break;
            case '--extract-only': args.extractOnly = true; break;
            case '--load-only': args.loadOnly = true; break;
            case '--in': args.in = next(); break;
            case '--out': args.out = next(); break;
            case '--duckdb': args.duckdb = next(); break;
            case '--help': case '-h': args.help = true; break;
            default: fail(`Unknown argument: ${a} (try --help)`);
        }
    }
    return args;
}

// Resolve the bbox to use: explicit --bbox wins, else the city's configured bbox.
function resolveBbox(args, cfg) {
    if (args.bbox) {
        const parts = args.bbox.split(',').map(Number);
        if (parts.length !== 4 || parts.some(n => !Number.isFinite(n))) {
            fail('--bbox must be minLng,minLat,maxLng,maxLat');
        }
        return parts;
    }
    return cfg.bbox;
}

function defaultExtractPath(city, layerName, release) {
    const dir = process.env.SCRATCH_DIR || join(__dirname, '..', '..', 'tmp');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return join(dir, `overture-${city}-${layerName}-${release}.ndjson`);
}

// Phase 1: DuckDB reads Overture's public S3 GeoParquet for the bbox and writes NDJSON.
function runExtract(args, layer, bbox, outPath) {
    const [minLng, minLat, maxLng, maxLat] = bbox;
    const release = args.release;
    const s3glob = `s3://overturemaps-us-west-2/release/${release}/${layer.s3type}/*`;

    // bbox.* are the per-row bounding-box struct fields Overture stores for spatial predicate
    // pushdown — filtering on them lets DuckDB skip row groups outside the city. With the spatial
    // extension loaded, the geometry column reads back as a GEOMETRY, so ST_AsGeoJSON consumes it
    // directly and gives us a portable footprint/point string for Postgres.
    const sql = `
INSTALL spatial; LOAD spatial;
INSTALL httpfs; LOAD httpfs;
SET s3_region='${S3_REGION}';
COPY (
    SELECT ${layer.select}
    FROM read_parquet('${s3glob}', hive_partitioning=1, filename=false)
    WHERE bbox.xmin BETWEEN ${minLng} AND ${maxLng}
      AND bbox.ymin BETWEEN ${minLat} AND ${maxLat}
      ${layer.whereExtra}
) TO '${outPath}' (FORMAT JSON, ARRAY false);
`.trim();

    const duckdb = args.duckdb || 'duckdb';
    log(`Extract: Overture ${release} ${layer.s3type}, bbox [${bbox.join(', ')}] → ${outPath}`);
    log(`Extract: this scans Overture's S3 GeoParquet over the network and may take a few minutes…`);

    const res = spawnSync(duckdb, [':memory:', '-c', sql], { stdio: ['ignore', 'inherit', 'inherit'] });
    if (res.error && res.error.code === 'ENOENT') {
        fail(`DuckDB CLI not found ('${duckdb}'). Install it (https://duckdb.org/docs/installation/) or pass --duckdb <path>.`);
    }
    if (res.status !== 0) fail(`DuckDB extract failed (exit ${res.status}).`);
    if (!existsSync(outPath)) fail(`Extract produced no output at ${outPath}.`);
    log(`Extract: done → ${outPath}`);
}

async function ensureTable(pool, layer) {
    const ddl = readFileSync(join(__dirname, layer.ddl), 'utf8');
    await pool.query(ddl);
    log(`Table ${layer.table} ensured.`);
}

// Build the UNNEST upsert for a layer. Scalars (city, release) are repeated server-side; the per-row
// fields travel as aligned arrays, matching the repo's bulk-insert convention.
function buildUpsertSql(layer) {
    const cols = layer.extra.map(e => e.col);
    const colList = ['city', 'overture_id', 'geom', ...cols, 'overture_release'].join(', ');
    const unnestParts = ['$3::text[]', '$4::text[]'];
    const tNames = ['oid', 'gj'];
    layer.extra.forEach((e, i) => { unnestParts.push(`$${5 + i}::${e.cast}[]`); tNames.push(e.name); });
    const selectVals = ['$1', 't.oid', 'ST_SetSRID(ST_GeomFromGeoJSON(t.gj), 4326)', ...layer.extra.map(e => `t.${e.name}`), '$2'];
    const updates = ['geom = EXCLUDED.geom', ...cols.map(c => `${c} = EXCLUDED.${c}`), 'overture_release = EXCLUDED.overture_release', 'updated_at = now()'];
    return `
        INSERT INTO ${layer.table} (${colList})
        SELECT ${selectVals.join(', ')}
        FROM UNNEST(${unnestParts.join(', ')}) AS t(${tNames.join(', ')})
        WHERE t.gj IS NOT NULL
        ON CONFLICT (city, overture_id) DO UPDATE SET ${updates.join(', ')}
    `;
}

async function upsertBatch(pool, sql, layer, city, release, batch) {
    const ids = batch.map(r => r.id);
    // DuckDB's JSON COPY re-parses the ST_AsGeoJSON string into a nested object, so geom arrives as an
    // object here; ST_GeomFromGeoJSON wants text, so stringify when needed (string form too).
    const geoms = batch.map(r => (typeof r.geom === 'string' ? r.geom : JSON.stringify(r.geom)));
    const extraArrays = layer.extra.map(e => batch.map(e.get));
    await pool.query(sql, [city, release, ids, geoms, ...extraArrays]);
}

// Phase 2: stream the NDJSON into Postgres in batches. Upsert keying makes the whole phase
// restartable — a re-run reprocesses from the top but converges to the same rows.
async function runLoad(args, layer, city, inPath) {
    if (!existsSync(inPath)) fail(`Input not found: ${inPath} (run extract first or pass --in).`);

    const pool = new Pool({
        host: process.env.PGHOST,
        port: Number(process.env.PGPORT) || 5432,
        user: process.env.PGUSER,
        password: process.env.PGPASSWORD,
        database: process.env.PGDATABASE,
    });
    log(`Load: connecting to ${process.env.PGDATABASE}@${process.env.PGHOST}:${process.env.PGPORT || 5432} as ${process.env.PGUSER}`);

    try {
        await ensureTable(pool, layer);
        const upsertSql = buildUpsertSql(layer);

        const rl = createInterface({ input: createReadStream(inPath), crlfDelay: Infinity });
        let batch = [];
        let total = 0;
        const start = Date.now();

        const flush = async () => {
            if (batch.length === 0) return;
            await upsertBatch(pool, upsertSql, layer, city, args.release, batch);
            total += batch.length;
            const rate = total / Math.max(1, (Date.now() - start) / 1000);
            log(`Load: ${total} rows upserted (${rate.toFixed(0)}/s)`);
            batch = [];
        };

        for await (const line of rl) {
            const s = line.trim();
            if (!s) continue;
            let row;
            try { row = JSON.parse(s); } catch (_) { continue; }
            if (!row || !row.geom) continue;
            batch.push(row);
            if (batch.length >= BATCH_SIZE) await flush();
        }
        await flush();
        log(`Load: done. ${total} ${args.layer} for '${city}'.`);
    } finally {
        await pool.end();
    }
}

async function main() {
    const args = parseArgs(process.argv);
    if (args.help || (!args.city && !args.loadOnly)) { printUsage(); process.exit(args.help ? 0 : 1); }

    const layer = LAYERS[args.layer];
    if (!layer) fail(`Unknown --layer '${args.layer}' (one of: ${Object.keys(LAYERS).join(', ')}).`);

    const cfg = OVERTURE_CITIES[args.city];
    if (!cfg) fail(`City '${args.city}' is not in overture-cities.js (${Object.keys(OVERTURE_CITIES).join(', ') || 'none'}).`);

    const bbox = resolveBbox(args, cfg);
    const extractPath = args.out || defaultExtractPath(args.city, args.layer, args.release);
    const loadPath = args.in || extractPath;

    if (!args.loadOnly) runExtract(args, layer, bbox, extractPath);
    if (args.extractOnly) { log('Extract-only: stopping before load.'); return; }
    await runLoad(args, layer, args.city, args.loadOnly ? loadPath : extractPath);
    log('All done.');
}

main().catch(err => fail(err && err.stack ? err.stack : String(err)));
