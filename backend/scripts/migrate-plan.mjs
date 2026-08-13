// Replicates a NAMED PLAN (ens_plan row + the proposals it lists) from this
// environment's database into another one — built for shipping the Šibenik
// 2066 plan from the local authoring database to production.
//
// Ids are re-minted on the target (the id spaces diverged long ago), keyed for
// idempotence on proposal_id — the stable natural key with a unique index on
// both sides — so a re-run updates in place and never duplicates. The embedded
// proposal_data.id is rewritten to the target's new id (the app treats it as
// authoritative). screenshot_url is dropped: the local values are
// http://localhost:4583/... thumbnails that would ship dead links.
//
// Transit-project imports (the rail track) are deliberately SKIPPED: they are
// re-created natively on the target by import-transit-project.mjs against the
// target's own transit_project row, and spliced into the plan via --track-id.
//
// Dry-run by default:
//   node scripts/migrate-plan.mjs --slug sibenik-2066-1 \
//       --source-url postgresql://.../geodata \
//       --target-url postgresql://.../geodata [--track-id 120] [--apply]
//
// The target is always stated explicitly; there is no default to fall into.

import pg from 'pg';
import { randomBytes, createHash } from 'node:crypto';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';

const log = (message) => console.log(`[${new Date().toISOString()}] ${message}`);

function parseArgs(argv) {
    const args = { slug: null, sourceUrl: null, targetUrl: null, trackId: null, apply: false, help: false };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--help' || arg === '-h') args.help = true;
        else if (arg === '--apply') args.apply = true;
        else if (arg === '--dry-run') args.apply = false;
        else if (arg === '--slug') args.slug = String(argv[++index] || '').trim();
        else if (arg === '--source-url') args.sourceUrl = String(argv[++index] || '').trim();
        else if (arg === '--target-url') args.targetUrl = String(argv[++index] || '').trim();
        else if (arg === '--track-id') args.trackId = Number(argv[++index]);
        else throw new Error(`Unknown argument: ${arg}`);
    }
    return args;
}

function usage() {
    console.log(`Usage: node scripts/migrate-plan.mjs --slug <plan> [--source-url <postgres url>] --target-url <postgres url> [--track-id <id>] [--apply]

  --slug        ens_plan slug to replicate (required)
  --source-url  source database; defaults to the standard PG* environment
  --target-url  the DATABASE THE PLAN SHIPS TO — stated, never guessed (required)
  --track-id    target-side proposal id of the natively re-imported rail track;
                spliced where the source plan listed its own transit import
  --apply       write; without it the plan of work is printed and nothing changes`);
}

const isTransitImport = (row) => String(row.proposal_id || '').startsWith('transit-project-')
    || Boolean(row.proposal_data?.source?.transitProjectId);

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help || !args.slug || !args.targetUrl) { usage(); process.exit(args.help ? 0 : 1); }
    if (!args.sourceUrl) {
        dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });
    }

    const source = new pg.Pool({ ...(args.sourceUrl ? { connectionString: args.sourceUrl } : {}), max: 1 });
    const target = new pg.Pool({ connectionString: args.targetUrl, max: 1 });
    try {
        // ── Read the plan and its proposals from the source ────────────────
        const { rows: planRows } = await source.query(
            'SELECT * FROM ens_plan WHERE slug = $1', [args.slug],
        );
        if (planRows.length === 0) throw new Error(`No plan '${args.slug}' in the source database.`);
        const plan = planRows[0];
        const orderedIds = (plan.proposal_ids || []).map(Number);
        log(`plan '${args.slug}': ${orderedIds.length} proposals listed`);

        const { rows: proposals } = await source.query(
            'SELECT * FROM proposal WHERE id = ANY($1::int[])', [orderedIds],
        );
        const byId = new Map(proposals.map((row) => [row.id, row]));
        const missing = orderedIds.filter((id) => !byId.has(id));
        if (missing.length) throw new Error(`Plan lists ids missing from source: ${missing.join(', ')}`);

        const trackRows = proposals.filter(isTransitImport);
        const migrate = orderedIds.map((id) => byId.get(id)).filter((row) => !isTransitImport(row));
        log(`migrating ${migrate.length} proposals; skipping ${trackRows.length} transit import(s): `
            + trackRows.map((row) => `${row.id}(${row.proposal_id})`).join(', '));

        // Cross-references would need remapping; this set has none and the
        // script refuses rather than migrating a graph it would silently cut.
        for (const row of migrate) {
            for (const column of ['parent_proposal_ids', 'child_proposal_ids']) {
                const value = row[column];
                if (Array.isArray(value) ? value.length : (value && value !== 'null')) {
                    throw new Error(`Proposal ${row.id} has ${column}=${JSON.stringify(value)} — id remapping for references is not implemented.`);
                }
            }
        }

        // ── Column parity ───────────────────────────────────────────────────
        const columnsOf = async (pool) => new Set((await pool.query(
            `SELECT column_name FROM information_schema.columns
             WHERE table_name = 'proposal'`,
        )).rows.map((row) => row.column_name));
        const sourceColumns = await columnsOf(source);
        const targetColumns = await columnsOf(target);
        const shared = [...sourceColumns].filter((column) => targetColumns.has(column) && column !== 'id');
        const dropped = [...sourceColumns].filter((column) => !targetColumns.has(column));
        if (dropped.length) {
            throw new Error(`Target proposal table lacks columns: ${dropped.join(', ')} — apply the schema first.`);
        }

        if (!args.apply) {
            const { rows: [{ existing }] } = await target.query(
                'SELECT count(*)::int AS existing FROM proposal WHERE proposal_id = ANY($1)',
                [migrate.map((row) => row.proposal_id)],
            );
            log(`dry run: would upsert ${migrate.length} proposals (${existing} already on target), `
                + `then upsert plan '${args.slug}' with ${migrate.length + (args.trackId ? 1 : 0)} ids`
                + (args.trackId ? ` (track spliced as ${args.trackId})` : ' (NO track id — plan ships without the rail!)'));
            log('nothing was written. Re-run with --apply.');
            return;
        }

        // ── Upsert proposals, re-minting ids ────────────────────────────────
        const targetClient = await target.connect();
        const idMap = new Map();   // source id → target id
        let inserted = 0;
        let updated = 0;
        const targetIds = [];
        let editToken = null;
        let planWasInserted = false;
        try {
            await targetClient.query('BEGIN');
            for (const row of migrate) {
                const data = { ...row.proposal_data };
                delete data.screenshotUrl;
                const columns = shared;
                const values = columns.map((column) => {
                    if (column === 'proposal_data') return JSON.stringify(data);
                    if (column === 'screenshot_url') return null;
                    const value = row[column];
                    return value !== null && typeof value === 'object' ? JSON.stringify(value) : value;
                });
                const placeholders = columns.map((_, index) => `$${index + 1}`);
                const updates = columns.map((column) => `${column} = EXCLUDED.${column}`);
                const { rows: [written] } = await targetClient.query(
                    `INSERT INTO proposal (${columns.join(', ')})
                     VALUES (${placeholders.join(', ')})
                     ON CONFLICT (proposal_id) DO UPDATE SET ${updates.join(', ')}
                     RETURNING id, (xmax = 0) AS was_insert`,
                    values,
                );
                // The app treats the embedded id as authoritative — align it with
                // the row id the target actually minted.
                await targetClient.query(
                    `UPDATE proposal SET proposal_data = jsonb_set(proposal_data, '{id}', to_jsonb(id))
                     WHERE id = $1`, [written.id],
                );
                idMap.set(row.id, written.id);
                if (written.was_insert) inserted += 1; else updated += 1;
            }
            for (const id of orderedIds) {
                const row = byId.get(id);
                if (isTransitImport(row)) {
                    if (Number.isInteger(args.trackId)) targetIds.push(String(args.trackId));
                    else log(`WARNING: plan listed transit import ${id} but no --track-id was given — omitted`);
                } else {
                    targetIds.push(String(idMap.get(id)));
                }
            }
            editToken = randomBytes(24).toString('base64url');
            const tokenHash = createHash('sha256').update(editToken).digest('hex');
            const { rows: [planWritten] } = await targetClient.query(
                `INSERT INTO ens_plan (slug, proposal_ids, title, city, edit_token_hash)
                 VALUES ($1, $2::jsonb, $3, $4, $5)
                 ON CONFLICT (slug) DO UPDATE SET proposal_ids = EXCLUDED.proposal_ids,
                                                  title = COALESCE(ens_plan.title, EXCLUDED.title),
                                                  city = EXCLUDED.city,
                                                  updated_at = CURRENT_TIMESTAMP
                 RETURNING (xmax = 0) AS was_insert`,
                [args.slug, JSON.stringify(targetIds), plan.title, plan.city, tokenHash],
            );
            planWasInserted = planWritten.was_insert;
            await targetClient.query('COMMIT');
        } catch (error) {
            await targetClient.query('ROLLBACK').catch(() => {});
            throw error;
        } finally {
            targetClient.release();
        }

        log(`proposals: ${inserted} inserted, ${updated} updated`);
        if (planWasInserted) {
            log(`plan '${args.slug}' created with ${targetIds.length} ids`);
            log(`EDIT TOKEN (shown once, save it): ${editToken}`);
        } else {
            log(`plan '${args.slug}' updated with ${targetIds.length} ids (existing edit token kept)`);
        }

        const mapping = Object.fromEntries(idMap);
        console.log(JSON.stringify({ idMap: mapping, planIds: targetIds }, null, 0).slice(0, 2000));
    } finally {
        await source.end();
        await target.end();
    }
}

main().catch((err) => {
    console.error(`[${new Date().toISOString()}] migration failed:`, err.message);
    process.exit(1);
});
