// One-time backfill for the proposal status split: the old overloaded `status` column becomes two
// independent fields —
//   lifecycle_status  (marketplace/on-chain): 'Active' | 'Executed' | 'Cancelled' | 'Expired' | 'draft'
//   applied           (boolean): whether the geometry is stamped on the map and cutting buildings
// — on the proposal row, on each sub-proposal JSONB, and mirrored into proposal_data.
//
// WHY: the two axes shared one string, so a marketplace/chain transition could silently un-apply a
// road. In particular road 474 (and ~30 like it) sit at status='Active' / roadProposal.status=
// 'unapplied' yet carry demolition records — conceptually applied, but the carve gate refused them.
// deriveApplied below recovers those: a road that carries demolitions and is not superseded is applied.
//
// IDEMPOTENT + RESTARTABLE. Values are computed deterministically from the legacy fields, so a re-run
// writes the same result. Each proposal is committed on its own, so a crash never loses progress.
//
// DRY RUN BY DEFAULT. Nothing is written unless --apply is passed.
//
// Usage:
//   node scripts/split-status-applied.js --help
//   node scripts/split-status-applied.js                     # dry run, all proposals
//   node scripts/split-status-applied.js --proposals 474     # dry run, one id
//   node scripts/split-status-applied.js --apply             # write

import pkg from 'pg';
import 'dotenv/config';

const { Pool } = pkg;

const log = (...args) => console.log(`[${new Date().toISOString()}]`, ...args);

function usage() {
    console.log(`
Split the overloaded proposal \`status\` into \`lifecycle_status\` + \`applied\`.

  --proposals <a,b,c>   Only these proposal ids (numeric id or proposal_id). Default: every proposal.
  --apply               Actually write. WITHOUT THIS NOTHING IS WRITTEN (dry run is the default).
  --help                Print this and exit.

Reads the database from the usual PG* env vars (backend/.env). Idempotent and safe to re-run.
`);
}

function parseArgs(argv) {
    const args = { proposals: null, apply: false, help: false };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--help' || arg === '-h') args.help = true;
        else if (arg === '--apply') args.apply = true;
        else if (arg === '--proposals') args.proposals = String(argv[++i] || '').split(',').map(s => s.trim()).filter(Boolean);
        else if (arg.startsWith('--proposals=')) args.proposals = arg.slice(12).split(',').map(s => s.trim()).filter(Boolean);
        else { console.error(`Unknown argument: ${arg}`); usage(); process.exit(1); }
    }
    return args;
}

const norm = (v) => String(v == null ? '' : v).trim().toLowerCase();
const APPLIED_LIKE = new Set(['applied', 'executed']);
const SUB_COLUMNS = ['road_proposal', 'building_proposal', 'structure_proposal', 'reparcellization'];

function subHasDemolitions(sub, isRoad) {
    if (!sub || typeof sub !== 'object') return false;
    const list = isRoad ? (sub.definition && sub.definition.demolishedBuildings) : sub.demolishedBuildings;
    return Array.isArray(list) && list.length > 0;
}

function rowHasDemolitions(row) {
    if (subHasDemolitions(row.road_proposal, true)) return true;
    return subHasDemolitions(row.structure_proposal, false) || subHasDemolitions(row.building_proposal, false);
}

// PURE. The map-application verdict for a DB row (snake_case JSONB columns). Order matters:
//   1. superseded / terminated  -> false
//   2. legacy status applied|executed  -> true   (the 114 'Applied' roads)
//   3. any sub-proposal status applied|executed  -> true
//   4. carries demolition records  -> true        (474 + the ~30 'Active'-with-cuts roads)
//   5. otherwise  -> false
export function deriveApplied(row) {
    const pdata = row.proposal_data || {};
    if (pdata.supersededByProposalId) return false;
    const life = norm(row.status);
    if (life === 'cancelled' || life === 'expired') return false;
    if (APPLIED_LIKE.has(life)) return true;
    if (SUB_COLUMNS.some(col => row[col] && APPLIED_LIKE.has(norm(row[col].status)))) return true;
    return rowHasDemolitions(row);
}

// PURE. The lifecycle value — never an application word. Leaked 'applied'/'unapplied' collapse to
// 'Active'; real lifecycle words are canonicalised.
export function deriveLifecycle(row) {
    switch (norm(row.status)) {
        case 'executed': return 'Executed';
        case 'cancelled': return 'Cancelled';
        case 'expired': return 'Expired';
        case 'draft': return 'draft';
        default: return 'Active'; // 'active', 'applied', 'unapplied', '' and unknowns
    }
}

// Build the mutated proposal_data mirror + each sub-proposal JSONB with the boolean stamped on.
function mirrorApplied(row, applied, lifecycle) {
    const pdata = { ...(row.proposal_data || {}) };
    pdata.applied = applied;
    pdata.lifecycleStatus = lifecycle;
    pdata.status = lifecycle; // legacy readers of proposal_data.status get a clean lifecycle value
    delete pdata.status; // the legacy overloaded field is gone for good
    ['roadProposal', 'buildingProposal', 'structureProposal', 'reparcellization', 'decideLaterProposal'].forEach(k => {
        if (pdata[k] && typeof pdata[k] === 'object') {
            pdata[k] = { ...pdata[k], applied };
            delete pdata[k].status; // sub-proposals track application by the boolean, not a status string
        }
    });
    const subs = {};
    SUB_COLUMNS.forEach(col => {
        if (row[col] && typeof row[col] === 'object') {
            subs[col] = { ...row[col], applied };
            delete subs[col].status;
        } else {
            subs[col] = row[col];
        }
    });
    return { pdata, subs };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) { usage(); return; }

    const pool = new Pool({
        host: process.env.PGHOST,
        port: Number(process.env.PGPORT) || 5432,
        user: process.env.PGUSER,
        password: process.env.PGPASSWORD,
        database: process.env.PGDATABASE
    });

    log(`Connecting to ${process.env.PGDATABASE}@${process.env.PGHOST}:${process.env.PGPORT || 5432} as ${process.env.PGUSER}`);
    log(args.apply ? 'MODE: APPLY — changes WILL be written.' : 'MODE: DRY RUN — nothing will be written. Pass --apply to write.');

    const totals = { proposals: 0, appliedTrue: 0, appliedFalse: 0, rescued: 0 };

    try {
        // Idempotent + restartable: once the legacy `status` column is dropped, the migration is done.
        const hasStatus = (await pool.query(
            `SELECT 1 FROM information_schema.columns WHERE table_name = 'proposal' AND column_name = 'status'`
        )).rowCount > 0;
        if (!hasStatus) {
            log('Legacy `status` column is already gone — nothing to migrate. Done.');
            return;
        }

        if (args.apply) {
            await pool.query(`ALTER TABLE proposal ADD COLUMN IF NOT EXISTS applied BOOLEAN NOT NULL DEFAULT true`);
            await pool.query(`ALTER TABLE proposal ADD COLUMN IF NOT EXISTS lifecycle_status VARCHAR(50)`);
            await pool.query(`CREATE INDEX IF NOT EXISTS idx_proposal_applied ON proposal(applied)`);
            await pool.query(`CREATE INDEX IF NOT EXISTS idx_proposal_lifecycle_status ON proposal(lifecycle_status)`);
            log('Ensured columns applied + lifecycle_status and their indexes exist.');
        }

        const where = args.proposals
            ? 'WHERE proposal_id = ANY($1::text[]) OR id::text = ANY($1::text[])'
            : '';
        const params = args.proposals ? [args.proposals] : [];
        const { rows } = await pool.query(
            `SELECT id, proposal_id, type, status, road_proposal, building_proposal, structure_proposal,
                    reparcellization, proposal_data
             FROM proposal ${where} ORDER BY id`,
            params
        );
        log(`Scanning ${rows.length} proposal(s).`);

        for (const row of rows) {
            totals.proposals++;
            const applied = deriveApplied(row);
            const lifecycle = deriveLifecycle(row);
            applied ? totals.appliedTrue++ : totals.appliedFalse++;
            // A "rescue" is a road that legacy status alone would leave unapplied but demolitions save.
            if (applied && !APPLIED_LIKE.has(norm(row.status)) && rowHasDemolitions(row)) totals.rescued++;

            const label = `#${row.id} ${row.proposal_id} [${row.type || '?'}] status=${row.status} -> lifecycle=${lifecycle} applied=${applied}`;
            if (!args.apply) { log(`DRY ${label}`); continue; }

            const { pdata, subs } = mirrorApplied(row, applied, lifecycle);
            await pool.query(
                `UPDATE proposal
                    SET applied = $2,
                        lifecycle_status = $3,
                        road_proposal = $4::jsonb,
                        building_proposal = $5::jsonb,
                        structure_proposal = $6::jsonb,
                        reparcellization = $7::jsonb,
                        proposal_data = $8::jsonb,
                        updated_at = now()
                  WHERE id = $1`,
                [
                    row.id, applied, lifecycle,
                    subs.road_proposal ? JSON.stringify(subs.road_proposal) : null,
                    subs.building_proposal ? JSON.stringify(subs.building_proposal) : null,
                    subs.structure_proposal ? JSON.stringify(subs.structure_proposal) : null,
                    subs.reparcellization ? JSON.stringify(subs.reparcellization) : null,
                    JSON.stringify(pdata)
                ]
            );
            log(`WROTE ${label}`);
        }

        // Drop the legacy overloaded column for good — only after every row has been backfilled, and
        // only for a full run (a --proposals subset must not drop the column out from under the rest).
        if (args.apply && !args.proposals) {
            await pool.query(`ALTER TABLE proposal ALTER COLUMN lifecycle_status SET DEFAULT 'Active'`);
            await pool.query(`UPDATE proposal SET lifecycle_status = 'Active' WHERE lifecycle_status IS NULL`);
            await pool.query(`ALTER TABLE proposal ALTER COLUMN lifecycle_status SET NOT NULL`);
            await pool.query(`DROP INDEX IF EXISTS idx_proposals_status`);
            await pool.query(`ALTER TABLE proposal DROP COLUMN IF EXISTS status`);
            log('Dropped the legacy `status` column and its index. lifecycle_status is now NOT NULL.');
        } else if (args.apply) {
            log('Subset run (--proposals): left the legacy `status` column in place. Run without --proposals to drop it.');
        }

        log(`Done. proposals=${totals.proposals} applied=true:${totals.appliedTrue} applied=false:${totals.appliedFalse} rescued(demolitions):${totals.rescued}`);
        if (!args.apply) log('DRY RUN — re-run with --apply to write.');
    } finally {
        await pool.end();
    }
}

// Only run main() when invoked directly, so the pure derivers can be imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch(err => { console.error(err); process.exit(1); });
}
