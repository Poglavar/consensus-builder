// Flag the road records stored without their corridor land (projections.md §3, "Legacy"). Since
// preparation, a corridor's land is built by the server and stored with the record, and a centre line
// without land is refused as an unprepared corridor (footprint-parts.js). Older records were stored
// with only their centre line and width; this one-off migration marks each of them
//   roadProposal.definition.constructionFrame = { kind: 'legacy-centreline', migration: 'legacy-centreline-v1' }
// in both the road_proposal column and proposal_data.roadProposal, which is what lets them keep the
// approximate width/2 centreline footprint. Nothing else in the row changes.
//
// Additive and reversible: --restore removes exactly the flags this migration added. Idempotent: a
// flagged row is skipped. Run it BEFORE deploying the code that refuses unflagged centre lines (old
// code ignores the flag, so the order is safe).
//
// A row that already violates proposal_cadastre_parcel_ids_or_site (no parcels and no site — the
// constraint is NOT VALID, so such rows exist, but any UPDATE of one is refused) cannot be flagged.
// It is named and skipped, and the run exits 2 (partial) instead of 0.
//
//   node scripts/flag-legacy-centreline-roads.mjs --help
//   node scripts/flag-legacy-centreline-roads.mjs              # dry run (default): what would change
//   node scripts/flag-legacy-centreline-roads.mjs --apply      # flag them, one transaction
//   node scripts/flag-legacy-centreline-roads.mjs --restore    # remove this migration's flags
//   node scripts/flag-legacy-centreline-roads.mjs --ids 2,3    # limit to row ids

import pkg from 'pg';
import dotenv from 'dotenv';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });

const requireCjs = createRequire(import.meta.url);
const { footprintParts } = requireCjs('../../frontend/js/proposals/footprint-parts.js');

export const MIGRATION_ID = 'legacy-centreline-v1';
export const LEGACY_FRAME = Object.freeze({ kind: 'legacy-centreline', migration: MIGRATION_ID });

const log = message => console.log(`[${new Date().toISOString()}] ${message}`);
const isPlainObject = value => !!value && typeof value === 'object' && !Array.isArray(value);

// Does this definition need the flag? Exactly when the footprint reader would refuse it as an
// unprepared corridor: a centre line, no land, no flag.
export function needsLegacyFlag(definition) {
    if (!isPlainObject(definition) || definition.constructionFrame) return false;
    return footprintParts({ roadProposal: { definition } }).corridorUnprepared === true;
}

const withFrame = (roadProposal, frame) => {
    const definition = { ...roadProposal.definition };
    if (frame) definition.constructionFrame = frame;
    else delete definition.constructionFrame;
    return { ...roadProposal, definition };
};
const flaggedByUs = roadProposal => roadProposal?.definition?.constructionFrame?.migration === MIGRATION_ID;

// `conforming`: whether the row satisfies proposal_cadastre_parcel_ids_or_site (routes/proposal-site-ddl.sql),
// which any UPDATE of it re-checks.
const READ_SQL = `
    SELECT id, proposal_id, road_proposal, proposal_data->'roadProposal' AS data_road,
           COALESCE(CASE WHEN jsonb_typeof(cadastre_parcel_ids) = 'array'
                         THEN jsonb_array_length(cadastre_parcel_ids) > 0 OR site IS NOT NULL
                         ELSE FALSE END, FALSE) AS conforming
    FROM proposal
    WHERE (road_proposal IS NOT NULL OR proposal_data ? 'roadProposal')
      AND ($1::int[] IS NULL OR id = ANY($1::int[]))
    ORDER BY id`;

/**
 * The update for one row, or null. `mode` 'apply' adds the flag where needed; 'restore' removes it
 * where this migration added it.
 * @param {{ id, road_proposal, data_road }} row road_proposal column and proposal_data->'roadProposal'
 * @returns {null|{ id, roadProposal: object|null, dataRoad: object|null }} null = leave the field
 */
export function rowUpdate(row, mode = 'apply') {
    const fields = { roadProposal: row.road_proposal, dataRoad: row.data_road };
    const out = { id: row.id, roadProposal: null, dataRoad: null };
    for (const [key, roadProposal] of Object.entries(fields)) {
        if (!isPlainObject(roadProposal) || !isPlainObject(roadProposal.definition)) continue;
        if (mode === 'apply' && needsLegacyFlag(roadProposal.definition)) out[key] = withFrame(roadProposal, LEGACY_FRAME);
        if (mode === 'restore' && flaggedByUs(roadProposal)) out[key] = withFrame(roadProposal, null);
    }
    return out.roadProposal || out.dataRoad ? out : null;
}

export function parseArgs(argv) {
    const args = { apply: false, restore: false, help: false, ids: null };
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === '--apply') args.apply = true;
        else if (arg === '--restore') args.restore = true;
        else if (arg === '--dry-run') { /* the default */ }
        else if (arg === '--help' || arg === '-h') args.help = true;
        else if (arg === '--ids') {
            args.ids = String(argv[++index] || '').split(',').map(value => Number(value.trim())).filter(Number.isInteger);
            if (!args.ids.length) throw new Error('--ids needs a comma-separated list of row ids.');
        } else throw new Error(`Unknown argument: ${arg}`);
    }
    if (args.apply && args.restore) throw new Error('Pass either --apply or --restore, not both.');
    return args;
}

function usage() {
    console.log([
        'Flag road records stored without their corridor land as legacy-centreline (projections.md §3).',
        '',
        'Usage: node scripts/flag-legacy-centreline-roads.mjs [--dry-run | --apply | --restore] [--ids 2,3]',
        '  --dry-run   Report what would change (default; writes nothing)',
        '  --apply     Add the flag, all rows in one transaction',
        '  --restore   Remove the flags this migration added, one transaction',
        '  --ids       Only these proposal row ids',
        '  --help      Show this message',
        '',
        'Connection: PG* variables from backend/.env.'
    ].join('\n'));
}

export async function run(argv = process.argv.slice(2), { pool: injectedPool } = {}) {
    const args = parseArgs(argv);
    if (args.help) { usage(); return 0; }
    const mode = args.restore ? 'restore' : 'apply';
    const writing = args.apply || args.restore;
    const pool = injectedPool || new pkg.Pool();
    const client = await pool.connect();
    try {
        const { rows } = await client.query(READ_SQL, [args.ids]);
        const pending = rows.map(row => ({ row, update: rowUpdate(row, mode) })).filter(entry => entry.update);
        const blocked = pending.filter(entry => !entry.row.conforming).map(entry => entry.update.id);
        const updates = pending.filter(entry => entry.row.conforming).map(entry => entry.update);
        log(`${rows.length} road row(s) read; ${updates.length} to ${mode === 'restore' ? 'restore' : 'flag'}: ${updates.map(u => u.id).join(', ') || 'none'}`);
        if (blocked.length) {
            log(`WARNING: ${blocked.length} row(s) cannot be updated — they already violate proposal_cadastre_parcel_ids_or_site (no parcels and no site): ${blocked.join(', ')}`);
        }
        if (!writing) {
            log('dry run: nothing written (pass --apply or --restore)');
            return blocked.length ? 2 : 0;
        }
        await client.query('BEGIN');
        let written = 0;
        for (const update of updates) {
            const result = await client.query(`
                UPDATE proposal SET
                    road_proposal = COALESCE($2::jsonb, road_proposal),
                    proposal_data = CASE WHEN $3::jsonb IS NULL THEN proposal_data
                                         ELSE jsonb_set(proposal_data, '{roadProposal}', $3::jsonb) END,
                    updated_at = now()
                WHERE id = $1`,
            [update.id, update.roadProposal ? JSON.stringify(update.roadProposal) : null, update.dataRoad ? JSON.stringify(update.dataRoad) : null]);
            written += result.rowCount;
        }
        await client.query('COMMIT');
        log(`${mode === 'restore' ? 'restored' : 'flagged'} ${written} row(s)`);
        // Re-read: a second pass must find nothing left to do but the blocked rows.
        const { rows: after } = await client.query(READ_SQL, [args.ids]);
        const left = after.filter(row => row.conforming).map(row => rowUpdate(row, mode)).filter(Boolean);
        if (left.length) throw new Error(`after ${mode}, ${left.length} row(s) still need it: ${left.map(u => u.id).join(', ')}`);
        log('verified: a rerun would change nothing');
        if (blocked.length) {
            log(`PARTIAL: ${blocked.length} row(s) left as they were (see the warning above)`);
            return 2;
        }
        return 0;
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
    } finally {
        client.release();
        if (!injectedPool) await pool.end();
    }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
    run().then(code => process.exit(code), error => {
        console.error(`[${new Date().toISOString()}] failed: ${error.message}`);
        process.exit(1);
    });
}
