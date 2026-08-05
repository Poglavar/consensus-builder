// One-time migration to the flat record (rethink-proposals.md §15a, decision 2026-08-05):
// every stored parent declaration is flattened to BASE cadastral ids — `X#token-2` → `X` —
// so no record references another proposal's minted generation. Ghost references die here,
// by migration, instead of being healed at read time forever.
//
// What it touches: ancestor_parcel_ids, the parentParcelIds inside road_proposal /
// building_proposal / structure_proposal / reparcellization (+ its parcelIds pool list), and the
// same fields nested in proposal_data (including decideLaterProposal).
// What it deliberately leaves: descendant_parcel_ids and child ids (local mint bookkeeping),
// accepted_parcel_ids / owner_acceptances (consent is immutable — invariant #2), parent_features /
// child_features (geometry snapshots), parent_proposal_ids (proposal ids, not parcels), and
// government-roads' legacy underscore-form ids (still minted by a live feature; baseIdOf only
// strips `#…-n` suffixes, so they pass through untouched).
//
// Dry-run by default:
//   node scripts/migrate-flat-records.js
//   node scripts/migrate-flat-records.js --apply
//   node scripts/migrate-flat-records.js --apply --ids 97,98
//
// Run backfill-cadastre-parcel-ids.js (--force) alongside, so every row also carries the
// geometric flat declaration.

import pkg from 'pg';
import 'dotenv/config';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Pool } = pkg;
const { baseIdOf } = require('../../frontend/js/proposals/formation-edit.js');

const SUB_PAYLOAD_KEYS = Object.freeze(['roadProposal', 'buildingProposal', 'structureProposal', 'reparcellization', 'decideLaterProposal']);

// The synthetic-token sanitizer, mirrored from proposal-parcel-identity.js: child ids are minted
// as `<root>#<token>-<n>` where token derives from the minting proposal's id.
export function syntheticTokenOf(proposalId) {
    const sanitized = String(proposalId === undefined || proposalId === null ? '' : proposalId)
        .trim().replace(/#/g, '').replace(/\s+/g, '').replace(/[^a-zA-Z0-9_-]+/g, '');
    return sanitized || 'proposal';
}

// Child bookkeeping minted under a DIFFERENT token is a dead generation's snapshot (the record
// was captured while a predecessor proposal's fabric stood; that proposal no longer exists).
// Children are derived data — apply regenerates them from the definition — so foreign-token ids
// are dropped rather than carried forever. Returns null when nothing changed.
export function dropForeignChildIds(list, ownProposalId) {
    if (!Array.isArray(list)) return null;
    const token = syntheticTokenOf(ownProposalId);
    const marker = `#${token}-`;
    const kept = [];
    let changed = false;
    list.forEach(raw => {
        if (raw === undefined || raw === null) { changed = true; return; }
        const id = String(raw);
        if (!id.includes('#') || id.lastIndexOf(marker) > 0) kept.push(id);
        else changed = true;
    });
    return changed ? kept : null;
}

// Flatten one id list: base ids, deduped, order preserved. Returns null when nothing changed.
export function flattenIdList(list) {
    if (!Array.isArray(list)) return null;
    const seen = new Set();
    const flat = [];
    let changed = false;
    list.forEach(raw => {
        if (raw === undefined || raw === null) { changed = true; return; }
        const id = String(raw);
        const base = baseIdOf(id) || id;
        if (base !== id) changed = true;
        if (seen.has(base)) { changed = true; return; }
        seen.add(base);
        flat.push(base);
    });
    return changed ? flat : null;
}

// Flatten the parent declarations of one proposal-shaped object IN PLACE (top-level
// parentParcelIds, each sub-payload's parentParcelIds, and reparcellization's parcelIds pool),
// and drop dead-generation child bookkeeping (childParcelIds minted under a foreign token).
// Returns the list of dotted paths that changed.
export function flattenProposalObject(record, ownProposalId) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return [];
    const changedPaths = [];
    const flattenAt = (holder, key, path) => {
        const flat = flattenIdList(holder[key]);
        if (flat) { holder[key] = flat; changedPaths.push(path); }
    };
    const dropForeignAt = (holder, key, path) => {
        if (ownProposalId === undefined || ownProposalId === null) return;
        const kept = dropForeignChildIds(holder[key], ownProposalId);
        if (kept) { holder[key] = kept; changedPaths.push(`${path} (dead generation dropped)`); }
    };
    flattenAt(record, 'parentParcelIds', 'parentParcelIds');
    dropForeignAt(record, 'childParcelIds', 'childParcelIds');
    SUB_PAYLOAD_KEYS.forEach(sub => {
        const payload = record[sub];
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
        flattenAt(payload, 'parentParcelIds', `${sub}.parentParcelIds`);
        dropForeignAt(payload, 'childParcelIds', `${sub}.childParcelIds`);
        if (sub === 'reparcellization') flattenAt(payload, 'parcelIds', 'reparcellization.parcelIds');
    });
    return changedPaths;
}

export function parseArgs(argv) {
    const args = { apply: false, ids: null, help: false };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--apply') args.apply = true;
        else if (arg === '--help' || arg === '-h') args.help = true;
        else if (arg === '--ids') args.ids = String(argv[++i] || '').split(',').map(s => s.trim()).filter(Boolean);
        else throw new Error(`Unknown argument: ${arg}`);
    }
    return args;
}

function usage() {
    console.log(`
Flatten stored parent declarations to base cadastral ids (the §15a flat record).

  --apply     Write changes. Without this the script only reports what it would do.
  --ids LIST  Limit to comma-separated numeric row ids.
  --help      Show this message.
`);
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

    const stats = { total: 0, unchanged: 0, changed: 0, written: 0 };

    try {
        const { rows: [db] } = await pool.query('SELECT current_database() AS name');
        console.log(`database: ${db.name}   mode: ${args.apply ? 'APPLY' : 'DRY RUN'}\n`);

        const params = [];
        let where = '';
        if (args.ids) { params.push(args.ids.map(Number).filter(Number.isFinite)); where = `WHERE id = ANY($1::int[])`; }
        const { rows } = await pool.query(
            `SELECT id, proposal_id, title, name, ancestor_parcel_ids, descendant_parcel_ids,
                    road_proposal, building_proposal, structure_proposal, reparcellization, proposal_data
             FROM proposal ${where} ORDER BY id`, params);
        stats.total = rows.length;
        console.log(`${rows.length} row(s) to consider\n`);

        for (const row of rows) {
            const label = `#${row.id} ${String(row.title || row.name || '').slice(0, 45)}`;
            const updates = {};
            const notes = [];

            const flatAncestors = flattenIdList(row.ancestor_parcel_ids);
            if (flatAncestors) {
                updates.ancestor_parcel_ids = flatAncestors;
                notes.push(`ancestor_parcel_ids ${row.ancestor_parcel_ids.length}→${flatAncestors.length}`);
            }

            const keptDescendants = dropForeignChildIds(row.descendant_parcel_ids, row.proposal_id);
            if (keptDescendants) {
                updates.descendant_parcel_ids = keptDescendants;
                notes.push(`descendant_parcel_ids ${row.descendant_parcel_ids.length}→${keptDescendants.length} (dead generation dropped)`);
            }

            for (const [column, subKey] of [
                ['road_proposal', 'roadProposal'],
                ['building_proposal', 'buildingProposal'],
                ['structure_proposal', 'structureProposal'],
                ['reparcellization', 'reparcellization']
            ]) {
                const payload = row[column];
                if (!payload || typeof payload !== 'object') continue;
                const clone = JSON.parse(JSON.stringify(payload));
                const paths = flattenProposalObject({ [subKey]: clone }, row.proposal_id)
                    .map(path => path.replace(`${subKey}.`, `${column}.`));
                if (paths.length) {
                    updates[column] = clone;
                    notes.push(paths.join(', '));
                }
            }

            if (row.proposal_data && typeof row.proposal_data === 'object') {
                const clone = JSON.parse(JSON.stringify(row.proposal_data));
                const paths = flattenProposalObject(clone, row.proposal_id);
                if (paths.length) {
                    updates.proposal_data = clone;
                    notes.push(`proposal_data: ${paths.join(', ')}`);
                }
            }

            if (!Object.keys(updates).length) { stats.unchanged++; continue; }
            stats.changed++;
            console.log(`  ${args.apply ? 'WRITE' : 'would'} ${label}`);
            notes.forEach(note => console.log(`         ${note}`));

            if (args.apply) {
                const sets = [];
                const values = [];
                Object.entries(updates).forEach(([column, value]) => {
                    values.push(JSON.stringify(value));
                    sets.push(`${column} = $${values.length}::jsonb`);
                });
                values.push(row.id);
                await pool.query(`UPDATE proposal SET ${sets.join(', ')} WHERE id = $${values.length}`, values);
                stats.written++;
            }
        }

        console.log(`\n${JSON.stringify(stats, null, 1)}`);

        if (args.apply) {
            // Verify from the table, not from the loop's own bookkeeping: no parent declaration
            // may still carry a derived (#-suffixed) id.
            const { rows: residue } = await pool.query(
                `SELECT id, proposal_id, descendant_parcel_ids, road_proposal, proposal_data FROM proposal`);
            let foreign = 0;
            residue.forEach(r => {
                if (dropForeignChildIds(r.descendant_parcel_ids, r.proposal_id)) foreign++;
                else if (r.road_proposal && dropForeignChildIds(r.road_proposal.childParcelIds, r.proposal_id)) foreign++;
                else if (r.proposal_data && dropForeignChildIds(r.proposal_data.childParcelIds, r.proposal_id)) foreign++;
            });
            console.log(`verified: ${foreign} row(s) still carry dead-generation child ids (expect 0)`);

            const { rows: [after] } = await pool.query(`
                SELECT COUNT(*)::int AS dirty FROM proposal
                WHERE ancestor_parcel_ids::text LIKE '%#%'
                   OR road_proposal->'parentParcelIds' @> '[]'::jsonb AND road_proposal->>'parentParcelIds' LIKE '%#%'
                   OR building_proposal->>'parentParcelIds' LIKE '%#%'
                   OR structure_proposal->>'parentParcelIds' LIKE '%#%'
                   OR reparcellization->>'parentParcelIds' LIKE '%#%'
                   OR reparcellization->>'parcelIds' LIKE '%#%'
                   OR proposal_data->>'parentParcelIds' LIKE '%#%'`);
            console.log(`\nverified: ${after.dirty} row(s) still carry a derived id in a parent declaration (expect 0)`);
            return after.dirty === 0 ? 0 : 1;
        }
        console.log('\nRe-run with --apply to write.');
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
