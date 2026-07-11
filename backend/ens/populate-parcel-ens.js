// Populates parcel_ens (slug -> parcelId mapping) that backs the ENS CCIP-Read
// gateway. Reads parcel ids from each city's source table, computes the
// ENSIP-15 slug, and upserts. Runnable from the CLI, restartable (idempotent
// upsert), progressive, and verbose. Start with --city=ny --dry-run.
//
// Usage:
//   node ens/populate-parcel-ens.js --city=ny [--limit=N] [--offset=N] [--batch-size=500] [--dry-run]
//
// Run against the LOCAL database only (host localhost:5432 may tunnel to prod):
//   docker compose exec backend node ens/populate-parcel-ens.js --city=ny --dry-run --limit=20
import dotenv from 'dotenv';
import pkg from 'pg';
import { parcelToSlug, parcelIdToCity } from './slug.js';

dotenv.config({ quiet: true });
const { Pool } = pkg;

// Per-city sources. parcelId formats mirror the backend parcel routes / mint
// scripts. Add a city by adding an entry here (countQuery, pageQuery ordered &
// paged with LIMIT $1 OFFSET $2, and toParcelId).
const CITY_SOURCES = {
    ny: {
        cityName: 'New York',
        countQuery: 'SELECT COUNT(DISTINCT swis_sbl_id)::int AS n FROM parcel_nyc_unit WHERE swis_sbl_id IS NOT NULL',
        pageQuery: 'SELECT DISTINCT swis_sbl_id AS local_id FROM parcel_nyc_unit WHERE swis_sbl_id IS NOT NULL ORDER BY swis_sbl_id LIMIT $1 OFFSET $2',
        toParcelId: (row) => `US-NY-${row.local_id}`,
    },
    // TODO: zg (parcel_info: maticni_broj_ko, broj_cestice -> HR-<ko>-<cestice>),
    //       co/lj/bg/ba — add as entries above following the same shape.
};

const log = (...args) => console.log(`[${new Date().toISOString()}]`, ...args);

function parseArgs(argv) {
    const out = {};
    for (const arg of argv.slice(2)) {
        const m = arg.match(/^--([^=]+)(?:=(.*))?$/);
        if (m) out[m[1]] = m[2] === undefined ? true : m[2];
    }
    return out;
}

function printUsage() {
    console.log(`Populate parcel_ens (ENS slug -> parcelId mapping).

  node ens/populate-parcel-ens.js --city=<code> [options]

Options:
  --city=<code>     Required. One of: ${Object.keys(CITY_SOURCES).join(', ')}
  --limit=N         Max parcels to process (default: all)
  --offset=N        Skip the first N source rows (default: 0)
  --batch-size=N    Upsert batch size (default: 500)
  --dry-run         Compute slugs and report, but do not write
  --help            Show this help`);
}

async function upsertBatch(pool, rows) {
    if (!rows.length) return 0;
    const slugs = rows.map((r) => r.slug);
    const parcelIds = rows.map((r) => r.parcelId);
    const cityCodes = rows.map((r) => r.cityCode);
    const res = await pool.query(
        `INSERT INTO parcel_ens (slug, parcel_id, city_code)
         SELECT s, p, c FROM UNNEST($1::text[], $2::text[], $3::text[]) AS t(s, p, c)
         ON CONFLICT (slug) DO UPDATE
           SET parcel_id = EXCLUDED.parcel_id, city_code = EXCLUDED.city_code, updated_at = now()`,
        [slugs, parcelIds, cityCodes],
    );
    return res.rowCount;
}

async function main() {
    const args = parseArgs(process.argv);
    if (args.help || !args.city) {
        printUsage();
        process.exit(args.help ? 0 : 1);
    }

    const source = CITY_SOURCES[args.city];
    if (!source) {
        console.error(`Unknown city '${args.city}'. Known: ${Object.keys(CITY_SOURCES).join(', ')}`);
        process.exit(1);
    }

    const batchSize = Number(args['batch-size']) || 500;
    const limit = args.limit !== undefined ? Number(args.limit) : Infinity;
    const startOffset = Number(args.offset) || 0;
    const dryRun = Boolean(args['dry-run']);

    const pool = new Pool({
        host: process.env.PGHOST,
        port: Number(process.env.PGPORT),
        user: process.env.PGUSER,
        password: process.env.PGPASSWORD,
        database: process.env.PGDATABASE,
    });

    try {
        const { rows: countRows } = await pool.query(source.countQuery);
        const total = Math.min(countRows[0].n, limit === Infinity ? countRows[0].n : limit);
        log(`City ${args.city} (${source.cityName}): ${countRows[0].n} source parcels; processing up to ${total}${dryRun ? ' (DRY RUN)' : ''}.`);

        const startedAt = Date.now();
        let processed = 0;
        let written = 0;
        let skipped = 0;
        const collisions = new Map(); // slug -> first parcelId, to detect collisions in this run
        let offset = startOffset;

        while (processed < total) {
            const page = Math.min(batchSize, total - processed);
            const { rows } = await pool.query(source.pageQuery, [page, offset]);
            if (!rows.length) break;

            const batch = [];
            for (const row of rows) {
                const parcelId = source.toParcelId(row);
                const slug = parcelToSlug(parcelId);
                const city = parcelIdToCity(parcelId);
                if (!slug || !city) {
                    skipped++;
                    log(`  skip: could not slug/city-map parcelId='${parcelId}'`);
                    continue;
                }
                if (collisions.has(slug) && collisions.get(slug) !== parcelId) {
                    skipped++;
                    log(`  COLLISION: slug='${slug}' from both '${collisions.get(slug)}' and '${parcelId}' — skipping the latter`);
                    continue;
                }
                collisions.set(slug, parcelId);
                batch.push({ slug, parcelId, cityCode: city.cityCode });
            }

            if (!dryRun) {
                written += await upsertBatch(pool, batch);
            }
            processed += rows.length;
            offset += rows.length;

            const elapsed = (Date.now() - startedAt) / 1000;
            const rate = processed / Math.max(elapsed, 0.001);
            const eta = (total - processed) / Math.max(rate, 0.001);
            log(`  progress ${processed}/${total} (${(100 * processed / total).toFixed(1)}%) — ${rate.toFixed(0)}/s, ETA ${eta.toFixed(0)}s${dryRun ? '' : `, written ${written}`}`);
        }

        log(`Done. processed=${processed}, ${dryRun ? 'would-write' : 'written'}=${dryRun ? processed - skipped : written}, skipped=${skipped}.`);
        if (dryRun && processed > 0) {
            // Show a couple of example mappings for sanity.
            const { rows } = await pool.query(source.pageQuery, [3, startOffset]);
            for (const row of rows) {
                const parcelId = source.toParcelId(row);
                log(`  example: ${parcelId} -> ${parcelToSlug(parcelId)}.parcels.urbangametheory.eth`);
            }
        }
    } finally {
        await pool.end();
    }
}

main().catch((err) => {
    console.error('populate-parcel-ens failed:', err);
    process.exit(1);
});
