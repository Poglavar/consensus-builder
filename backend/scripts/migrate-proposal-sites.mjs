// Give every stored proposal its SITE and a BINDING (PARCEL-OPTIONAL.md, phase 1), without changing
// what any record means.
//
//   site    := the record's own footprint (footprint-parts.js, unioned by PostGIS), or — for a parcel
//              act with no geometry of its own — the union of its declared parcels;
//   binding := the CURRENT declaration, unchanged: parcels = cadastre_parcel_ids, toleranceM 0,
//              coverage from the site, source 'migration:declaration'.
//
// The binding is also RECOMPUTED from the site at tolerance 0 with the new rule (bound ⇔ the site
// reaches into the parcel by more than 1 mm). Where that differs from the declaration the row is
// REPORTED — missing (bound, not declared) and extra (declared, not bound) — and the difference is
// recorded on the stored binding as `recomputedDiffers`; the declaration itself is never rewritten.
//
// Reversible: before a row is written its previous site, binding and proposal_data are copied into
// proposal_site_backup_v1 (same schema as proposal), and --restore puts them back. Idempotent: a row
// that already has a site and a binding is skipped (and reported as such).
//
//   node scripts/migrate-proposal-sites.mjs --help
//   node scripts/migrate-proposal-sites.mjs                 # dry run (default): read-only report
//   node scripts/migrate-proposal-sites.mjs --ids 8,20
//   node scripts/migrate-proposal-sites.mjs --apply         # backup, then write rows one by one
//   node scripts/migrate-proposal-sites.mjs --restore       # put backed-up rows back
//
// Needs proposal.site / proposal.binding (routes/proposal-site-ddl.sql) before --apply.

import pkg from 'pg';
import dotenv from 'dotenv';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { assertCanonicalProposalRow } from '../proposals/serializer.js';
import { footprintParts, hasFootprint, proposalGeometryView } from '../proposals/footprint.js';
import { compareDeclaration, computeBinding, parcelActBinding } from '../proposals/binding.js';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });

const { Pool } = pkg;

export const MIGRATION_ID = 'proposal-sites-v1';
export const BACKUP_TABLE = 'proposal_site_backup_v1';
export const MIGRATION_SOURCE = 'migration:declaration';

const isPlainObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const round = (value, digits) => {
    const f = Math.pow(10, digits);
    return Math.round(Number(value) * f) / f;
};

// How a row's site would be measured: footprint, or the declared parcels of a geometry-less act.
export function siteSourceOf(row) {
    const parts = footprintParts(proposalGeometryView(row));
    if (parts.invalid) return { kind: 'invalid-footprint', parts, detail: parts.invalid };
    if (hasFootprint(parts)) return { kind: 'footprint', parts };
    return { kind: 'declared-parcels', parts };
}

/**
 * Pure classification of one row, given what the cadastre said about its site.
 * @param row  proposal row (id, cadastre_parcel_ids, proposal_data, sub-proposal columns, site?, binding?)
 * @param measurement  { site, binding } from computeBinding / parcelActBinding (recomputed at
 *   tolerance 0), or { error: { code, message } } when it could not be measured.
 * @returns {{ class: 'done'|'migratable'|'skipped', reason?, site?, binding?, missing?, extra? }}
 */
export function classifySiteRow(row, measurement, { now = new Date().toISOString() } = {}) {
    if (row.site !== null && row.site !== undefined && isPlainObject(row.binding)) return { class: 'done' };
    const declared = Array.isArray(row.cadastre_parcel_ids) ? row.cadastre_parcel_ids.map(String) : null;
    if (!declared) return { class: 'skipped', reason: 'no-declaration' };
    if (!measurement) return { class: 'skipped', reason: 'not-measured' };
    if (measurement.error) return { class: 'skipped', reason: measurement.error.code || 'measure-failed', detail: measurement.error.message };
    if (!measurement.site) return { class: 'skipped', reason: 'no-site' };

    const recomputed = measurement.binding;
    const unverified = recomputed.coverage === 'unknown';
    const { missing, extra } = unverified ? { missing: [], extra: [] } : compareDeclaration(declared, recomputed);
    const byId = new Map([...(recomputed.touched || []), ...(recomputed.parcels || [])].map(hit => [String(hit.parcelId), hit]));
    const binding = {
        parcels: declared.map(id => {
            const hit = byId.get(id);
            return {
                parcelId: id,
                overlapM2: hit && Number.isFinite(hit.overlapM2) ? hit.overlapM2 : null,
                intrusionM: hit && Number.isFinite(hit.intrusionM) ? hit.intrusionM : null
            };
        }),
        touched: [],
        toleranceM: 0,
        coverage: recomputed.coverage,
        unsurveyedM2: recomputed.unsurveyedM2 ?? 0,
        unknownM2: recomputed.unknownM2 ?? 0,
        siteM2: recomputed.siteM2 ?? null,
        source: MIGRATION_SOURCE,
        subject: unverified ? 'declared-unverified' : 'declared',
        computedAt: now,
        migration: MIGRATION_ID,
        ...(missing.length || extra.length ? { recomputedDiffers: { missing, extra } } : {})
    };
    // How far the site reaches into each missing parcel, for the report (null = no measurement).
    const missingIntrusionM = missing.map(id => {
        const hit = byId.get(id);
        return hit && Number.isFinite(hit.intrusionM) ? hit.intrusionM : null;
    });
    return { class: 'migratable', site: measurement.site, binding, missing, extra, missingIntrusionM };
}

// Report buckets for the width by which a site reaches into a parcel it does not declare.
export function intrusionBucket(widthM) {
    if (!Number.isFinite(widthM)) return 'unmeasured';
    if (widthM < 0.01) return '<1cm';
    if (widthM < 0.1) return '1-10cm';
    if (widthM < 1) return '10cm-1m';
    return '>=1m';
}

const HR_ID = /^HR-\d+-.+$/;

// Ask the cadastre (tolerance 0) about one row. Errors become a classified skip, never a throw.
export async function measureRow(db, row) {
    const source = siteSourceOf(row);
    try {
        if (source.kind === 'invalid-footprint') return { error: { code: 'invalid-footprint', message: source.detail } };
        if (source.kind === 'footprint') {
            const { site, binding } = await computeBinding(db, { parts: source.parts, toleranceM: 0, city: row.city || null });
            return { site, binding, source: source.kind };
        }
        const declared = Array.isArray(row.cadastre_parcel_ids) ? row.cadastre_parcel_ids.map(String) : [];
        if (!declared.length) return { error: { code: 'no-site', message: 'no geometry and no declared parcels' } };
        const act = await parcelActBinding(db, declared, { toleranceM: 0 });
        if (!act.site && act.binding.coverage !== 'unknown') return { error: { code: 'no-site', message: 'no declared parcel is a current parcel' } };
        if (!act.site) return { error: { code: 'no-site', message: 'declared parcels are outside the cadastre the server holds' } };
        return { site: act.site, binding: { ...act.binding, parcels: act.binding.parcels, touched: [] }, source: source.kind, extraIds: act.extra };
    } catch (error) {
        return { error: { code: error.code || 'measure-failed', message: error.message } };
    }
}

export function parseArgs(argv) {
    const args = { apply: false, restore: false, ids: null, json: false, help: false };
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === '--apply') args.apply = true;
        else if (arg === '--restore') args.restore = true;
        else if (arg === '--dry-run') { /* the default */ }
        else if (arg === '--json') args.json = true;
        else if (arg === '--help' || arg === '-h') args.help = true;
        else if (arg === '--ids') {
            const list = String(argv[++index] || '').split(',').map(value => value.trim()).filter(Boolean);
            if (!list.length || list.some(value => !/^\d+$/.test(value))) throw new Error('--ids needs comma-separated numeric row ids');
            args.ids = list.map(Number);
        } else throw new Error(`Unknown argument: ${arg}`);
    }
    if (args.apply && args.restore) throw new Error('Pass either --apply or --restore, not both.');
    return args;
}

function usage() {
    console.log([
        'Set proposal.site and proposal.binding on every stored proposal. The binding records the CURRENT',
        'declaration unchanged; rows whose binding recomputed at tolerance 0 differs are reported, not rewritten.',
        '',
        '  (default)   Dry run: classify and report. Opens a READ ONLY session; writes nothing.',
        '  --dry-run   The same, explicitly.',
        `  --apply     Copy each row's previous site/binding/proposal_data into ${BACKUP_TABLE}, then write`,
        '              it — one transaction per row that locks, re-measures, re-classifies and verifies.',
        `  --restore   Put every row in ${BACKUP_TABLE} (or --ids) back as it was.`,
        '  --ids LIST  Limit to comma-separated numeric row ids.',
        '  --json      Also print the per-row report as JSON.',
        '  --help      Show this message.',
        '',
        'Idempotent: rows that already have a site and a binding are skipped.',
        'Connection: PG* variables (backend/.env, or exported to point at another database).'
    ].join('\n'));
}

const ts = () => new Date().toISOString();
const log = message => console.log(`[${ts()}] ${message}`);
const examples = (list, limit = 3) => (list.length ? `${list.slice(0, limit).join(', ')}${list.length > limit ? ` … (+${list.length - limit})` : ''}` : '—');

const ROW_COLUMNS = `id, proposal_id, city, type, title, cadastre_parcel_ids, proposal_data,
    road_proposal, building_proposal, structure_proposal, reparcellization,
    ST_AsGeoJSON(site, 9)::jsonb AS site, binding`;

async function proposalSchema(db) {
    const { rows } = await db.query(`SELECT n.nspname AS schema FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = 'proposal'::regclass`);
    return rows[0].schema;
}

async function ensureBackupTable(db, schema) {
    await db.query(`CREATE TABLE IF NOT EXISTS ${schema}.${BACKUP_TABLE} (
        id INTEGER PRIMARY KEY,
        site geometry(MultiPolygon, 4326),
        binding JSONB,
        proposal_data JSONB NOT NULL,
        backed_up_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
    )`);
}

async function applyRow(pool, id, schema, now) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('SET LOCAL ROLE geo_user');
        const { rows } = await client.query(`SELECT ${ROW_COLUMNS} FROM proposal WHERE id = $1 FOR UPDATE`, [id]);
        if (!rows.length) { await client.query('ROLLBACK'); return { status: 'gone' }; }
        const result = classifySiteRow(rows[0], await measureRow(client, rows[0]), { now });
        if (result.class !== 'migratable') { await client.query('ROLLBACK'); return { status: `now-${result.class}` }; }
        // The first backup of a row is the pre-migration state; a re-run never overwrites it.
        await client.query(`INSERT INTO ${schema}.${BACKUP_TABLE} (id, site, binding, proposal_data)
            SELECT id, site, binding, proposal_data FROM proposal WHERE id = $1
            ON CONFLICT (id) DO NOTHING`, [id]);
        const site = JSON.stringify(result.site);
        const binding = JSON.stringify(result.binding);
        await client.query(`UPDATE proposal
            SET site = ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON($1::text), 4326)), 3)),
                binding = $2::jsonb,
                proposal_data = proposal_data || jsonb_build_object('site', $1::jsonb, 'binding', $2::jsonb)
            WHERE id = $3`, [site, binding, id]);
        // Verify from the row as stored, not from the absence of an error.
        const { rows: after } = await client.query(`SELECT ${ROW_COLUMNS} FROM proposal WHERE id = $1`, [id]);
        if (!after[0].site || after[0].binding?.migration !== MIGRATION_ID) throw new Error('site/binding did not persist');
        assertCanonicalProposalRow(after[0]);
        await client.query('COMMIT');
        return { status: 'written' };
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        return { status: 'failed', error: error.detail || error.message };
    } finally {
        client.release();
    }
}

async function restore(pool, args) {
    const client = await pool.connect();
    try {
        const schema = await proposalSchema(client);
        await client.query('BEGIN');
        await client.query('SET LOCAL ROLE geo_user');
        const filter = args.ids ? 'WHERE b.id = ANY($1::int[])' : '';
        const result = await client.query(`UPDATE proposal p
            SET site = b.site, binding = b.binding, proposal_data = b.proposal_data
            FROM ${schema}.${BACKUP_TABLE} b ${filter ? `${filter} AND` : 'WHERE'} p.id = b.id`, args.ids ? [args.ids] : []);
        await client.query('COMMIT');
        log(`restored ${result.rowCount} row(s) from ${schema}.${BACKUP_TABLE}`);
        return 0;
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        console.error(`[${ts()}] restore failed: ${error.message}`);
        return 1;
    } finally {
        client.release();
    }
}

export async function run(argv = process.argv.slice(2)) {
    const args = parseArgs(argv);
    if (args.help) { usage(); return 0; }
    if (!process.env.PGDATABASE) {
        console.error('PGDATABASE is not set — refusing to guess a database.');
        return 1;
    }
    const pool = new Pool();
    try {
        if (args.restore) return await restore(pool, args);
        const reader = await pool.connect();
        try {
            if (!args.apply) await reader.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');
            const { rows: [target] } = await reader.query(
                "SELECT current_database() AS db, current_user AS usr, coalesce(inet_server_addr()::text, 'socket') AS host, inet_server_port() AS port, current_setting('transaction_read_only') AS ro"
            );
            log(`${MIGRATION_ID} · mode ${args.apply ? 'APPLY' : 'DRY RUN'} · db ${target.db} as ${target.usr} @ ${target.host}:${target.port} · read_only=${target.ro}`);
            const schema = await proposalSchema(reader);
            const filter = args.ids ? 'WHERE id = ANY($1::int[])' : '';
            const { rows } = await reader.query(`SELECT ${ROW_COLUMNS} FROM proposal ${filter} ORDER BY id`, args.ids ? [args.ids] : []);
            const now = ts();
            const started = Date.now();
            const results = [];
            for (const [index, row] of rows.entries()) {
                const quick = classifySiteRow(row, null);
                const result = quick.class === 'done' || quick.reason === 'no-declaration'
                    ? quick
                    : classifySiteRow(row, await measureRow(reader, row), { now });
                results.push({ row, result });
                const k = index + 1;
                if (result.class !== 'migratable' || result.missing.length || result.extra.length || k % 50 === 0 || k === rows.length) {
                    const eta = Math.round(((Date.now() - started) / k) * (rows.length - k) / 1000);
                    const detail = result.class === 'migratable'
                        ? `${result.binding.coverage} · declared ${result.binding.parcels.length} · missing ${result.missing.length} [${examples(result.missing)}] · extra ${result.extra.length} [${examples(result.extra)}]`
                        : (result.reason || '') + (result.detail ? ` (${result.detail})` : '');
                    log(`${k}/${rows.length} ETA ${eta}s #${row.id} ${row.type || '?'}/${row.proposal_data?.goal || '-'} ${result.class.toUpperCase()} · ${detail}`);
                }
            }

            const migratable = results.filter(item => item.result.class === 'migratable');
            const differing = migratable.filter(item => item.result.missing.length || item.result.extra.length);
            const skipped = results.filter(item => item.result.class === 'skipped');
            const byReason = {};
            skipped.forEach(item => { byReason[item.result.reason] = (byReason[item.result.reason] || 0) + 1; });
            const byCoverage = {};
            migratable.forEach(item => { byCoverage[item.result.binding.coverage] = (byCoverage[item.result.binding.coverage] || 0) + 1; });
            const byGoal = {};
            differing.forEach(item => {
                const goal = `${item.row.type || '?'}/${item.row.proposal_data?.goal || '-'}`;
                byGoal[goal] = (byGoal[goal] || 0) + 1;
            });

            // Declarations still in a pre-HR id format can never equal a binding: count them apart.
            const legacyIdRows = differing.filter(item => (item.row.cadastre_parcel_ids || []).some(id => !HR_ID.test(String(id))));
            const hrRows = differing.filter(item => !legacyIdRows.includes(item));
            const missingWidths = {};
            hrRows.forEach(item => item.result.missingIntrusionM.forEach(width => {
                const bucket = intrusionBucket(width);
                missingWidths[bucket] = (missingWidths[bucket] || 0) + 1;
            }));

            const stats = { written: 0, skipped: 0, failed: 0 };
            if (args.apply) {
                await reader.query('SET ROLE geo_user');
                await ensureBackupTable(reader, schema);
                await reader.query('RESET ROLE');
                log(`backup table ${schema}.${BACKUP_TABLE} ready; applying ${migratable.length} row(s)`);
                for (const [index, item] of migratable.entries()) {
                    const outcome = await applyRow(pool, item.row.id, schema, now);
                    if (outcome.status === 'written') stats.written += 1;
                    else if (outcome.status === 'failed') stats.failed += 1;
                    else stats.skipped += 1;
                    if (outcome.status !== 'written' || (index + 1) % 50 === 0 || index + 1 === migratable.length) {
                        log(`apply ${index + 1}/${migratable.length} #${item.row.id} ${outcome.status}${outcome.error ? ` · ${outcome.error}` : ''}`);
                    }
                }
            }

            console.log(JSON.stringify({
                migrationId: MIGRATION_ID,
                mode: args.apply ? 'apply' : 'dry-run',
                total: rows.length,
                done: results.filter(item => item.result.class === 'done').length,
                migratable: migratable.length,
                coverage: byCoverage,
                skipped: byReason,
                differingFromDeclaration: {
                    rows: differing.length,
                    withMissing: differing.filter(item => item.result.missing.length).length,
                    withExtra: differing.filter(item => item.result.extra.length).length,
                    missingParcels: differing.reduce((sum, item) => sum + item.result.missing.length, 0),
                    extraParcels: differing.reduce((sum, item) => sum + item.result.extra.length, 0),
                    byTypeGoal: byGoal,
                    rowsWithNonHrDeclaredIds: legacyIdRows.length,
                    hrRows: {
                        rows: hrRows.length,
                        withMissing: hrRows.filter(item => item.result.missing.length).length,
                        withExtra: hrRows.filter(item => item.result.extra.length).length,
                        missingParcels: hrRows.reduce((sum, item) => sum + item.result.missing.length, 0),
                        extraParcels: hrRows.reduce((sum, item) => sum + item.result.extra.length, 0),
                        missingByIntrusionWidth: missingWidths
                    },
                    examples: [...hrRows.slice(0, 6), ...legacyIdRows.slice(0, 2)].map(item => ({
                        id: item.row.id,
                        type: item.row.type,
                        goal: item.row.proposal_data?.goal || null,
                        missing: item.result.missing.slice(0, 3),
                        extra: item.result.extra.slice(0, 3)
                    }))
                },
                ...(args.apply ? { stats } : {})
            }, null, 2));
            if (args.json) {
                console.log(JSON.stringify(results.map(({ row, result }) => ({
                    id: row.id,
                    class: result.class,
                    reason: result.reason || null,
                    coverage: result.binding?.coverage || null,
                    missing: result.missing || [],
                    extra: result.extra || []
                })), null, 2));
            }
            return stats.failed ? 1 : 0;
        } finally {
            reader.release();
        }
    } finally {
        await pool.end();
    }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
    run().then(code => { process.exitCode = code; }).catch(error => {
        console.error(`[${ts()}] ${error.stack || error.message}`);
        process.exitCode = 1;
    });
}
