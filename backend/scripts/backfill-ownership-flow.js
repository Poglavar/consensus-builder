// Backfill proposal.ownership_flow for rows published before the column existed.
//
// A server row IS the published snapshot, so recomputing from its stored geometry gives exactly the
// value the publish-time stamp would have written — see rethink-proposals.md §9/§12. The flow itself
// is computed by the SAME module the browser uses (frontend/js/proposals/ownership-flow.js), so the
// backfill cannot drift from what new proposals get; PostGIS only narrows the candidate parcels.
//
// proposal.cadastre_frame is deliberately NOT backfilled: a historical row has no honest capture date,
// and inventing one would claim the stamps were verified against a cadastre vintage nobody recorded.
//
// Dry-run by default:
//   node scripts/backfill-ownership-flow.js
//   node scripts/backfill-ownership-flow.js --apply
//   node scripts/backfill-ownership-flow.js --apply --ids 97,98 --force
//
// Only Zagreb-style cadastral parcels are supported (the `parcel` table). Rows for other cities are
// reported as skipped rather than guessed at.

import pkg from 'pg';
import 'dotenv/config';
import { createRequire } from 'node:module';
import { serializeProposalRow } from '../proposals/serializer.js';

const require = createRequire(import.meta.url);
const { Pool } = pkg;

// plan-order.js reads `turf` from the runtime global, exactly as it does in the browser.
globalThis.turf = require('@turf/turf');
const planOrder = require('../../frontend/js/proposals/plan-order.js');
const ownershipFlow = require('../../frontend/js/proposals/ownership-flow.js');

const SUPPORTED_CITIES = new Set(['zagreb']);

export function parseArgs(argv) {
    const args = { apply: false, force: false, ids: null, help: false };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--apply') args.apply = true;
        else if (arg === '--force') args.force = true;
        else if (arg === '--help' || arg === '-h') args.help = true;
        else if (arg === '--ids') args.ids = String(argv[++i] || '').split(',').map(s => s.trim()).filter(Boolean);
        else throw new Error(`Unknown argument: ${arg}`);
    }
    return args;
}

function usage() {
    console.log(`
Backfill proposal.ownership_flow from each row's stored geometry and goal.

  --apply     Write changes. Without this the script only reports what it would do.
  --force     Recompute rows that already have a value (default: only NULL rows).
  --ids LIST  Limit to comma-separated numeric ids.
  --help      Show this message.

Only rows whose city is one of: ${[...SUPPORTED_CITIES].join(', ')}.
cadastre_frame is never written — historical rows have no honest capture date.
`);
}

const CANDIDATE_SQL = `
    SELECT 'HR-' || p.maticni_broj_ko || '-' || p.broj_cestice AS parcel_id,
           ST_AsGeoJSON(ST_Transform(p.geom, 4326))::json AS geometry
    FROM parcel p
    WHERE p.current = true
      AND p.geom && ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON($1), 4326), 3765)
      AND ST_Intersects(p.geom, ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON($1), 4326), 3765))
`;

function totalCededM2(flow) {
    return flow.reduce((sum, entry) => sum + (Number(entry && entry.cededM2) || 0), 0);
}

export async function run(argv = process.argv.slice(2)) {
    const args = parseArgs(argv);
    if (args.help) { usage(); return 0; }

    if (!process.env.PGDATABASE) {
        console.error('PGDATABASE is not set — refusing to guess a database. Run from backend/ so .env loads.');
        return 1;
    }

    const pool = new Pool({
        host: process.env.PGHOST,
        port: Number(process.env.PGPORT) || 5432,
        user: process.env.PGUSER,
        password: process.env.PGPASSWORD,
        database: process.env.PGDATABASE
    });

    const stats = { total: 0, skippedCity: 0, skippedHasValue: 0, contentOnly: 0, noFootprint: 0, noParcels: 0, computed: 0, written: 0, unchanged: 0 };

    try {
        const { rows: [db] } = await pool.query('SELECT current_database() AS name');
        console.log(`database: ${db.name}   mode: ${args.apply ? 'APPLY' : 'DRY RUN'}${args.force ? ' (force)' : ''}\n`);

        const where = [];
        const params = [];
        if (!args.force) where.push('ownership_flow IS NULL');
        if (args.ids) { params.push(args.ids.map(Number).filter(Number.isFinite)); where.push(`id = ANY($${params.length}::int[])`); }
        const { rows } = await pool.query(
            `SELECT * FROM proposal ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id`, params);

        stats.total = rows.length;
        console.log(`${rows.length} row(s) to consider\n`);

        for (const row of rows) {
            const label = `#${row.id} ${String(row.title || row.name || '').slice(0, 40)}`;

            if (!SUPPORTED_CITIES.has(String(row.city || ''))) {
                stats.skippedCity++;
                console.log(`  SKIP  ${label} — city '${row.city}' has no cadastral parcel table here`);
                continue;
            }
            if (row.ownership_flow && !args.force) { stats.skippedHasValue++; continue; }

            // Rebuild the proposal exactly as the API serves it, so footprintOf sees the same shape
            // the browser would.
            const proposal = serializeProposalRow(row);
            const goal = proposal.goal;

            // Content-only typologies (rules, votes, transfers, as-is) form nothing, so the CORRECT
            // stamp is an empty flow — not a missing one. Writing [] records that we looked.
            let flow;
            if (!ownershipFlow.destinationForGoal(goal)) {
                flow = [];
                stats.contentOnly++;
                console.log(`  ${args.apply ? 'WRITE' : 'would'} ${label}`);
                console.log(`         goal '${goal || '(none)'}' is content-only  ->  empty flow`);
            } else {
                const footprint = planOrder.footprintOf(proposal);
                if (!footprint) {
                    stats.noFootprint++;
                    console.log(`  ----  ${label} — no usable geometry`);
                    continue;
                }

                const { rows: candidates } = await pool.query(CANDIDATE_SQL, [JSON.stringify(footprint.geometry)]);
                if (!candidates.length) {
                    stats.noParcels++;
                    console.log(`  ----  ${label} — geometry covers no cadastral parcel`);
                    continue;
                }

                flow = ownershipFlow.computeOwnershipFlow(
                    proposal,
                    candidates.map(c => ({ id: c.parcel_id, feature: globalThis.turf.feature(c.geometry) }))
                );
                stats.computed++;

                console.log(`  ${args.apply ? 'WRITE' : 'would'} ${label}`);
                console.log(`         goal '${goal}'  ->  ${flow.length} parcel(s), ${totalCededM2(flow)} m² ceded to ${ownershipFlow.destinationForGoal(goal)}`);
            }

            const before = Array.isArray(row.ownership_flow) ? row.ownership_flow : null;
            if (before && JSON.stringify(before) === JSON.stringify(flow)) {
                stats.unchanged++;
                continue;
            }

            if (args.apply) {
                await pool.query('UPDATE proposal SET ownership_flow = $1 WHERE id = $2', [JSON.stringify(flow), row.id]);
                stats.written++;
            }
        }

        console.log(`\n${JSON.stringify(stats, null, 1)}`);

        if (args.apply) {
            // Verify from the table, not from the loop's own bookkeeping.
            const { rows: [after] } = await pool.query(
                'SELECT COUNT(*)::int AS filled FROM proposal WHERE ownership_flow IS NOT NULL');
            console.log(`\nverified: ${after.filled} row(s) now carry ownership_flow`);
        } else {
            console.log('\nRe-run with --apply to write.');
        }
        return 0;
    } finally {
        await pool.end();
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run().then(code => { process.exitCode = code; }).catch(err => {
        console.error('FAILED:', err.message);
        process.exitCode = 1;
    });
}
