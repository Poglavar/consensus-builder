// Retire browser-local map visibility from server proposal rows.
//
// Dry-run by default. Safe rollout:
//   1. node scripts/remove-server-applied.js
//   2. node scripts/remove-server-applied.js --apply
//   3. deploy API versions that no longer read/write `applied`
//   4. node scripts/remove-server-applied.js --apply --drop-applied

import pkg from 'pg';
import 'dotenv/config';
import { canonicalizeLifecycleStatus } from '../proposals/lifecycle.js';
import { stripLocalProposalState } from '../proposals/serializer.js';

const { Pool } = pkg;
const SUB_COLUMNS = Object.freeze(['road_proposal', 'building_proposal', 'structure_proposal', 'reparcellization']);

export function parseArgs(argv) {
    const args = { apply: false, dropApplied: false, proposals: null, help: false };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--apply') args.apply = true;
        else if (arg === '--drop-applied') args.dropApplied = true;
        else if (arg === '--help' || arg === '-h') args.help = true;
        else if (arg === '--proposals') args.proposals = String(argv[++index] || '').split(',').map(v => v.trim()).filter(Boolean);
        else if (arg.startsWith('--proposals=')) args.proposals = arg.slice(12).split(',').map(v => v.trim()).filter(Boolean);
        else throw new Error(`Unknown argument: ${arg}`);
    }
    return args;
}

export function sanitizeProposalJson(value) {
    return stripLocalProposalState(value && typeof value === 'object' ? value : {});
}

function canonicalLifecycleForRow(row) {
    const raw = row.lifecycle_status ?? row.proposal_data?.lifecycleStatus ?? row.status;
    const canonical = canonicalizeLifecycleStatus(raw, {
        allowLegacyApplicationWords: true,
        fallback: 'Active'
    });
    return canonical || 'Active';
}

function usage() {
    console.log(`
Remove server-side proposal applied state.

  --apply          Write changes. Without this, the script is a dry run.
  --drop-applied   Drop the applied column after cleanup (full runs only).
  --proposals IDS  Limit to comma-separated numeric ids or proposal_ids.
  --help           Show this help.
`);
}

async function columnExists(pool, columnName) {
    const result = await pool.query(
        `SELECT 1 FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = 'proposal' AND column_name = $1`,
        [columnName]
    );
    return result.rowCount > 0;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) return usage();
    if (args.dropApplied && !args.apply) throw new Error('--drop-applied requires --apply.');
    if (args.dropApplied && args.proposals) throw new Error('--drop-applied cannot be used with --proposals.');

    const pool = new Pool({
        host: process.env.PGHOST,
        port: Number(process.env.PGPORT) || 5432,
        user: process.env.PGUSER,
        password: process.env.PGPASSWORD,
        database: process.env.PGDATABASE
    });

    try {
        const hasApplied = await columnExists(pool, 'applied');
        const hasLegacyStatus = await columnExists(pool, 'status');
        const where = args.proposals
            ? 'WHERE proposal_id = ANY($1::text[]) OR id::text = ANY($1::text[])'
            : '';
        const params = args.proposals ? [args.proposals] : [];
        const result = await pool.query(
            `SELECT id, proposal_id, lifecycle_status,
                    ${hasLegacyStatus ? 'status' : 'NULL::text AS status'},
                    proposal_data, road_proposal, building_proposal, structure_proposal, reparcellization
             FROM proposal ${where} ORDER BY id`,
            params
        );

        console.log(`${args.apply ? 'APPLY' : 'DRY RUN'}: ${result.rows.length} proposal(s); applied column ${hasApplied ? 'present' : 'already absent'}.`);
        for (const row of result.rows) {
            const lifecycle = canonicalLifecycleForRow(row);
            const proposalData = sanitizeProposalJson({ ...(row.proposal_data || {}), lifecycleStatus: lifecycle });
            const subs = Object.fromEntries(SUB_COLUMNS.map(column => [column, sanitizeProposalJson(row[column])]));
            console.log(`${args.apply ? 'WRITE' : 'DRY'} #${row.id} ${row.proposal_id}: lifecycle=${lifecycle}`);
            if (!args.apply) continue;
            await pool.query(
                `UPDATE proposal
                 SET lifecycle_status = $2,
                     proposal_data = $3::jsonb,
                     road_proposal = $4::jsonb,
                     building_proposal = $5::jsonb,
                     structure_proposal = $6::jsonb,
                     reparcellization = $7::jsonb,
                     updated_at = now()
                 WHERE id = $1`,
                [
                    row.id,
                    lifecycle,
                    JSON.stringify(proposalData),
                    row.road_proposal ? JSON.stringify(subs.road_proposal) : null,
                    row.building_proposal ? JSON.stringify(subs.building_proposal) : null,
                    row.structure_proposal ? JSON.stringify(subs.structure_proposal) : null,
                    row.reparcellization ? JSON.stringify(subs.reparcellization) : null
                ]
            );
        }

        if (args.apply && !args.proposals) {
            await pool.query(`ALTER TABLE proposal DROP CONSTRAINT IF EXISTS proposal_lifecycle_status_check`);
            await pool.query(`ALTER TABLE proposal ADD CONSTRAINT proposal_lifecycle_status_check
                CHECK (lifecycle_status IN ('Active', 'Executed', 'Cancelled', 'Expired', 'draft'))`);
        }

        if (args.dropApplied) {
            await pool.query(`DROP INDEX IF EXISTS idx_proposal_applied`);
            await pool.query(`DROP INDEX IF EXISTS idx_proposals_applied`);
            await pool.query(`ALTER TABLE proposal DROP COLUMN IF EXISTS applied`);
            console.log('Dropped proposal.applied and its known indexes.');
        }
    } finally {
        await pool.end();
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
}

