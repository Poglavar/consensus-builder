// Add proposal.ownership_flow and proposal.cadastre_frame — the publish-time stamps that record what
// a proposal's formation TAKES from each base cadastral parcel, where that ownership goes, and which
// cadastre vintage the stamps were computed against.
//
// Purely additive: two new nullable JSONB columns. Existing rows are left NULL and existing code
// paths never read them, so this is safe to run before or after the API deploy and is a no-op on
// re-run. Nothing is dropped or rewritten, so there is no second phase.
//
// Why (see rethink-proposals.md §9/§12 and D5/§11): consent binds to the EFFECT of a proposal, so the
// per-parcel cession has to be frozen at publish rather than recomputed from whatever cadastre a
// later reader happens to have loaded.
//
// Dry-run by default:
//   node scripts/add-ownership-flow.js
//   node scripts/add-ownership-flow.js --apply

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
Add proposal.ownership_flow (JSONB) and proposal.cadastre_frame (JSONB).

  --apply   Write changes. Without this the script only reports what it would do.
  --help    Show this message.

Additive and idempotent — existing rows keep NULL, nothing is dropped.
`);
}

const COLUMNS = ['ownership_flow', 'cadastre_frame'];

const STATEMENTS = [
    ['column', 'ALTER TABLE proposal ADD COLUMN IF NOT EXISTS ownership_flow JSONB'],
    ['column', 'ALTER TABLE proposal ADD COLUMN IF NOT EXISTS cadastre_frame JSONB'],
    ['comment', `COMMENT ON COLUMN proposal.ownership_flow IS 'Per crossed base cadastral parcel: ceded area (m2) and ownership destination (public/proposer/mapping/undecided), stamped at publish. See rethink-proposals.md §9/§12.'`],
    ['comment', `COMMENT ON COLUMN proposal.cadastre_frame IS 'Which cadastre frame the publish-time stamps were computed against ({ capturedAt }). See rethink-proposals.md D5/§11.'`]
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
             WHERE table_name = 'proposal' AND column_name = ANY($1::text[])`,
            [COLUMNS]
        );
        const { rows: [{ count }] } = await pool.query('SELECT COUNT(*)::int AS count FROM proposal');

        const present = new Set(existing.map(r => r.column_name));
        console.log(`database         : ${db.name}`);
        console.log(`proposal rows    : ${count}`);
        COLUMNS.forEach(name => {
            console.log(`column ${name.padEnd(15)} : ${present.has(name) ? 'present — nothing to add' : 'missing'}`);
        });

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
            `SELECT c.column_name, c.data_type, c.is_nullable
             FROM information_schema.columns c
             WHERE c.table_name = 'proposal' AND c.column_name = ANY($1::text[])
             ORDER BY c.column_name`,
            [COLUMNS]
        );
        const verified = new Set(after.map(r => r.column_name));
        const missing = COLUMNS.filter(name => !verified.has(name));
        if (missing.length) {
            console.error(`VERIFY FAILED — still not present: ${missing.join(', ')}`);
            return 1;
        }
        console.log('');
        after.forEach(row => {
            console.log(`verified: ${row.column_name} ${row.data_type} nullable=${row.is_nullable}`);
        });
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
