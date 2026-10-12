// Stamp proposal_data.effectHash on stored proposals that lack it, and verify the ones that have
// it: the hash owner consent binds to, computed from the stored fields exactly as the publish route
// does (proposals/effect-hash.js). A record without the stamp makes every reader union its footprint
// again — a 1,105-building plan took seconds per read, and the details panel read it once per listed
// parcel. Dry run by default. Idempotent: a stamped row is never rewritten. Rows whose hash cannot
// be computed here (no footprint, a legacy centre-line road, an invalid readjustment deal, a
// non-canonical row) are named and skipped; the browser derives those live, as before.
//
//   node scripts/stamp-effect-hashes.mjs                 # dry run: what would be stamped
//   node scripts/stamp-effect-hashes.mjs --apply         # stamp missing hashes, 50 rows per transaction
//   node scripts/stamp-effect-hashes.mjs --verify        # recompute stamped rows too, report mismatches
//   node scripts/stamp-effect-hashes.mjs --restamp --apply   # also rewrite stamps the current fingerprint disagrees with
//   node scripts/stamp-effect-hashes.mjs --ids 12,34     # limit to row ids
//
// A mismatch is a stamp from an older fingerprint scheme (the August 2026 building records): nothing
// binds to those — no acceptance record carries a hash on any database (checked 2026-10-12) — so
// --restamp rewrites them to what the browser computes today. Exit 0 when everything was stamped
// or verified, 2 when some rows were skipped or left mismatched.
// Connection: PG* variables from backend/.env.

import pkg from 'pg';
import dotenv from 'dotenv';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { serializeProposalRow } from '../proposals/serializer.js';
import { effectHashOf } from '../proposals/effect-hash.js';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });

const BATCH = 50;
const log = message => console.log(`[${new Date().toISOString()}] ${message}`);

/**
 * What to do with one row, from its served record and the stamp it carries.
 * @returns {{ action: 'stamp'|'already'|'verified'|'mismatch'|'skip', hash?: string|null, reason?: string }}
 */
export function decide(record, stamped, { verify = false, restamp = false } = {}) {
    if (stamped && !verify && !restamp) return { action: 'already' };
    let hash = null;
    try { hash = effectHashOf(record); } catch (error) { return { action: 'skip', reason: error.message }; }
    if (!hash) return { action: 'skip', reason: 'no server-computable footprint (content-only or legacy centre line)' };
    if (stamped === hash) return { action: 'verified' };
    if (stamped) return { action: restamp ? 'restamp' : 'mismatch', hash, reason: `stored ${stamped}, computed ${hash}` };
    return { action: 'stamp', hash };
}

export function parseArgs(argv) {
    const args = { apply: false, verify: false, restamp: false, help: false, ids: null };
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === '--apply') args.apply = true;
        else if (arg === '--verify') args.verify = true;
        else if (arg === '--restamp') args.restamp = true;
        else if (arg === '--dry-run') { /* the default */ }
        else if (arg === '--help' || arg === '-h') args.help = true;
        else if (arg === '--ids') {
            args.ids = String(argv[++index] || '').split(',').map(value => Number(value.trim())).filter(Number.isInteger);
            if (!args.ids.length) throw new Error('--ids needs a comma-separated list of row ids.');
        } else throw new Error(`Unknown argument: ${arg}`);
    }
    return args;
}

function usage() {
    console.log([
        'Stamp proposal_data.effectHash on stored proposals that lack it; verify the ones that have it.',
        '',
        'Usage: node scripts/stamp-effect-hashes.mjs [--dry-run | --apply] [--verify] [--restamp] [--ids 12,34]',
        '  --dry-run   Report what would be stamped (default; writes nothing)',
        '  --apply     Stamp the missing hashes, 50 rows per transaction',
        '  --verify    Recompute rows that already carry a hash and report mismatches (never rewrites them)',
        '  --restamp   Rewrite mismatched stamps with the current fingerprint (with --apply; a dry run reports them)',
        '  --ids       Only these proposal row ids',
        '  --help      Show this message'
    ].join('\n'));
}

export async function run(argv = process.argv.slice(2), { pool: injectedPool } = {}) {
    const args = parseArgs(argv);
    if (args.help) { usage(); return 0; }
    const pool = injectedPool || new pkg.Pool();
    const client = await pool.connect();
    const counts = { stamp: 0, restamp: 0, already: 0, verified: 0, mismatch: 0, skip: 0 };
    try {
        const { rows } = await client.query(
            'SELECT * FROM proposal WHERE ($1::int[] IS NULL OR id = ANY($1::int[])) ORDER BY id', [args.ids]);
        log(`${rows.length} proposal row(s) read${args.verify || args.restamp ? ', recomputing stamped rows too' : ''}`);
        const started = Date.now();
        let pending = [];
        const flush = async () => {
            if (!pending.length) return;
            await client.query('BEGIN');
            for (const { id, hash, overwrite } of pending) {
                // A fresh stamp only lands where none is; a restamp replaces the stale one.
                await client.query(`UPDATE proposal
                    SET proposal_data = proposal_data || jsonb_build_object('effectHash', $2::text), updated_at = now()
                    WHERE id = $1 AND ($3::boolean OR NOT (proposal_data ? 'effectHash'))`, [id, hash, overwrite]);
            }
            await client.query('COMMIT');
            pending = [];
        };
        for (let index = 0; index < rows.length; index++) {
            const row = rows[index];
            let outcome;
            try {
                const record = serializeProposalRow(row);
                outcome = decide(record, row.proposal_data?.effectHash || null, { verify: args.verify, restamp: args.restamp });
            } catch (error) {
                outcome = { action: 'skip', reason: error.message };
            }
            counts[outcome.action] += 1;
            if (outcome.action === 'skip' || outcome.action === 'mismatch' || outcome.action === 'restamp') log(`  row ${row.id} ${row.proposal_id}: ${outcome.action} — ${outcome.reason}`);
            if ((outcome.action === 'stamp' || outcome.action === 'restamp') && args.apply) {
                pending.push({ id: row.id, hash: outcome.hash, overwrite: outcome.action === 'restamp' });
                if (pending.length >= BATCH) await flush();
            }
            if ((index + 1) % 100 === 0 || index + 1 === rows.length) {
                const elapsed = (Date.now() - started) / 1000;
                const eta = index + 1 < rows.length ? Math.round(elapsed / (index + 1) * (rows.length - index - 1)) : 0;
                log(`${index + 1}/${rows.length} rows · ${Math.round(elapsed)} s · ETA ${eta} s`);
            }
        }
        await flush();
        log(`${args.apply ? 'stamped' : 'would stamp'} ${counts.stamp}, ${args.apply ? 'restamped' : 'would restamp'} ${counts.restamp}, already stamped ${counts.already}, verified ${counts.verified}, mismatched ${counts.mismatch}, skipped ${counts.skip}`);
        if (!args.apply && (counts.stamp || counts.restamp)) log('dry run: nothing written (pass --apply)');
        return counts.skip || counts.mismatch ? 2 : 0;
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
