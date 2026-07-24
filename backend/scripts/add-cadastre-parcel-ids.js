// Add proposal.cadastre_parcel_ids — the BASE cadastral parcels a proposal's geometry covers.
//
// Purely additive: a new nullable JSONB column plus a GIN index. Existing rows are left NULL and
// existing code paths never read it, so this is safe to run before or after the API deploy and is a
// no-op on re-run. Nothing is dropped or rewritten, so there is no second phase.
//
// Why (see rethink-proposals.md): ancestor_parcel_ids may name DERIVED parcels
// (HR-339270-823/1#p-road-2) that are re-minted on every apply and exist in exactly one browser.
// Cadastral ids mean the same thing everywhere.
//
// Dry-run by default:
//   node scripts/add-cadastre-parcel-ids.js
//   node scripts/add-cadastre-parcel-ids.js --apply

import pkg from 'pg';
import 'dotenv/config';

const { Pool } = pkg;

export function parseArgs(argv) {
    const args = { apply: false, help: false };
    for (const arg of argv) {
        if (arg === '--apply') args.apply = true;
        else if (arg === '--help' || arg === '-h') args.help = true;
        else throw new Error(`Unknown argument: ${arg}`);
    }
    return args;
}

function usage() {
    console.log(`
Add proposal.cadastre_parcel_ids (JSONB) and its GIN index.

  --apply   Write changes. Without this the script only reports what it would do.
  --help    Show this message.

Additive and idempotent — existing rows keep NULL, nothing is dropped.
`);
}

const STATEMENTS = [
    ['column', 'ALTER TABLE proposal ADD COLUMN IF NOT EXISTS cadastre_parcel_ids JSONB'],
    ['index', 'CREATE INDEX IF NOT EXISTS idx_proposal_cadastre_parcel_ids ON proposal USING GIN(cadastre_parcel_ids)'],
    ['comment', `COMMENT ON COLUMN proposal.cadastre_parcel_ids IS 'Base cadastral parcel IDs the proposal geometry covers. Stable across machines, unlike ancestor_parcel_ids which may name derived (re-minted) parcels.'`]
];

export async function run(argv = process.argv.slice(2)) {
    const args = parseArgs(argv);
    if (args.help) { usage(); return 0; }

    // Same PG* convention the API and the other migration scripts use — never a guessed default,
    // so this can only ever touch the database the environment already points at.
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
    try {
        const { rows: [db] } = await pool.query('SELECT current_database() AS name');
        const { rows: existing } = await pool.query(
            `SELECT column_name FROM information_schema.columns
             WHERE table_name = 'proposal' AND column_name = 'cadastre_parcel_ids'`
        );
        const { rows: [{ count }] } = await pool.query('SELECT COUNT(*)::int AS count FROM proposal');

        console.log(`database         : ${db.name}`);
        console.log(`proposal rows    : ${count}`);
        console.log(`column present   : ${existing.length ? 'yes — nothing to add' : 'no'}`);

        if (!args.apply) {
            console.log('\nDRY RUN — would execute:');
            STATEMENTS.forEach(([label, sql]) => console.log(`  [${label}] ${sql}`));
            console.log('\nRe-run with --apply to write.');
            return 0;
        }

        for (const [label, sql] of STATEMENTS) {
            await pool.query(sql);
            console.log(`applied [${label}]`);
        }

        // Verify from the catalogue, not from the absence of an error.
        const { rows: after } = await pool.query(
            `SELECT c.column_name, c.data_type, c.is_nullable,
                    (SELECT COUNT(*)::int FROM pg_indexes
                      WHERE tablename = 'proposal' AND indexname = 'idx_proposal_cadastre_parcel_ids') AS index_count
             FROM information_schema.columns c
             WHERE c.table_name = 'proposal' AND c.column_name = 'cadastre_parcel_ids'`
        );
        if (!after.length) {
            console.error('VERIFY FAILED — the column is still not present.');
            return 1;
        }
        const row = after[0];
        console.log(`\nverified: ${row.column_name} ${row.data_type} nullable=${row.is_nullable} index=${row.index_count === 1 ? 'present' : 'MISSING'}`);
        return row.index_count === 1 ? 0 : 1;
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
