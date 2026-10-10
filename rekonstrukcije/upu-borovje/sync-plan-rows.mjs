#!/usr/bin/env node
// Carry the repaired local UPU Borovje rows (repair-flat-plan.mjs, verified 22/22) to another database,
// usually production, by proposal_id. Two steps, run where each database is:
//
//   node sync-plan-rows.mjs export --out borovje-rows.json                 # on the source (local) side
//   node sync-plan-rows.mjs import --in borovje-rows.json [--apply] \
//        [--backend <server checkout>/backend]                              # on the target side
//
// import is a dry run unless --apply. With --apply, each changed or inserted row is first copied into
// <schema>.proposal_borovje_sync_backup (same columns as proposal + backed_up_at) inside the same
// transaction. Every row is re-declared against the TARGET's own cadastre (its footprint must lie on
// current parcels within 0.5 m²) and must pass the canonical-row assertion, or nothing is written.
// site/binding are cleared on written rows; recompute them afterwards with
//   node scripts/migrate-proposal-sites.mjs --ids <ids> --apply
// which the import prints. Idempotent: a second import changes nothing.
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const log = message => console.log(`[${new Date().toISOString()}] ${message}`);
const USAGE = `Usage:
  node sync-plan-rows.mjs export --out <file.json> [--backend <dir>]
  node sync-plan-rows.mjs import --in <file.json> [--apply] [--backend <dir>]
--backend defaults to this checkout's backend/ (its .env selects the database).`;

// Authored content carried across. Lifecycle, chain, thumbnail, edit-token and consent columns stay
// as the target has them: they describe the target's history, not the plan's geometry.
const AUTHORED = ['name', 'title', 'description', 'proposal_data', 'cadastre_parcel_ids',
    'road_proposal', 'building_proposal', 'structure_proposal', 'reparcellization'];
// Columns a missing row is inserted with (taken from the source row).
const INSERTED = [...AUTHORED, 'proposal_id', 'city', 'author', 'type', 'created_at', 'lifecycle_status',
    'applied', 'decay_enabled', 'deposit_enabled', 'is_conditional', 'expires_at'];
const JSONB = new Set(['proposal_data', 'cadastre_parcel_ids', 'road_proposal', 'building_proposal',
    'structure_proposal', 'reparcellization']);

const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { out: { type: 'string' }, in: { type: 'string' }, apply: { type: 'boolean' },
        backend: { type: 'string' }, help: { type: 'boolean' } }
});
const mode = positionals[0];
if (values.help || !['export', 'import'].includes(mode)) { console.log(USAGE); process.exit(0); }

const backendDir = path.resolve(values.backend || new URL('../../backend', import.meta.url).pathname);
const require = createRequire(path.join(backendDir, 'package.json'));
require('dotenv').config({ path: path.join(backendDir, '.env'), quiet: true });
const { Pool } = require('pg');
const turf = require('@turf/turf');
globalThis.turf = turf; // the shared footprint helper resolves Turf at call time
const { assertCanonicalProposalRow } = await import(pathToFileURL(path.join(backendDir, 'proposals/serializer.js')).href);
const order = require(path.join(backendDir, '../frontend/js/proposals/plan-order.js'));

const pool = new Pool({ max: 1, ...(process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : {}) });
const client = await pool.connect();
let TABLE = 'proposal';
let BACKUP = 'proposal_borovje_sync_backup';
try {
    // The proposal table lives in `public` locally and in `consensus` on production; resolve it.
    const { rows: [where] } = await client.query(`SELECT current_database() db, inet_server_addr() host,
        (SELECT n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = 'proposal'::regclass) schema`);
    TABLE = `${where.schema}.proposal`;
    BACKUP = `${where.schema}.proposal_borovje_sync_backup`;
    log(`database ${where.db} @ ${where.host || 'socket'} · table ${TABLE} · mode ${mode}${mode === 'import' ? (values.apply ? ' APPLY' : ' DRY RUN') : ''}`);
    if (mode === 'export') await exportRows();
    else await importRows();
} finally {
    client.release();
    await pool.end();
}

async function exportRows() {
    if (!values.out) throw new Error('export needs --out <file.json>');
    // Only the source side needs the plan's id list; the import reads ids from the exported rows.
    const { BOROVJE_IDS } = await import('./flat-plan.mjs');
    const { rows } = await client.query(`SELECT ${INSERTED.join(', ')} FROM ${TABLE}
        WHERE proposal_id = ANY($1::text[]) ORDER BY created_at, proposal_id`, [BOROVJE_IDS]);
    const missing = BOROVJE_IDS.filter(id => !rows.some(row => row.proposal_id === id));
    if (missing.length) throw new Error(`source lacks ${missing.join(', ')}`);
    await writeFile(values.out, JSON.stringify({ exportedAt: new Date().toISOString(), rows }, null, 1));
    log(`exported ${rows.length} rows → ${values.out}`);
}

async function declaredParcels(record) {
    const footprint = order.footprintOf(record);
    if (!footprint) throw new Error(`${record.proposalId}: no footprint`);
    const { rows: [coverage] } = await client.query(`
        WITH input AS (SELECT ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON($1),4326),3765) AS geom),
        hits AS (
            SELECT 'HR-' || p.maticni_broj_ko || '-' || p.broj_cestice AS id,
                ST_Area(ST_Intersection(p.geom,i.geom)) AS area, p.geom
            FROM public.parcel p, input i
            WHERE p.current AND p.geom && i.geom AND ST_Area(ST_Intersection(p.geom,i.geom)) >= 0.25
        ) SELECT array_agg(id ORDER BY area DESC,id) AS ids,
            ST_Area(ST_Difference((SELECT geom FROM input),ST_UnaryUnion(ST_Collect(geom)))) AS missing
        FROM hits`, [JSON.stringify(footprint.geometry)]);
    if (!coverage.ids?.length || coverage.missing > 0.5) {
        throw new Error(`${record.proposalId}: ${Number(coverage.missing).toFixed(2)} m² outside the target's current cadastre`);
    }
    return coverage.ids;
}

async function importRows() {
    if (!values.in) throw new Error('import needs --in <file.json>');
    const { rows: source } = JSON.parse(await readFile(values.in, 'utf8'));
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '10s'");
    const { rows: target } = await client.query(`SELECT * FROM ${TABLE} WHERE proposal_id = ANY($1::text[]) FOR UPDATE`,
        [source.map(row => row.proposal_id)]);
    const plan = [];
    for (const row of source) {
        const record = { ...row.proposal_data, proposalId: row.proposal_id, cadastreParcelIds: row.cadastre_parcel_ids,
            roadProposal: row.road_proposal, buildingProposal: row.building_proposal,
            structureProposal: row.structure_proposal, reparcellization: row.reparcellization };
        const ids = await declaredParcels(record);
        const incoming = { ...row, cadastre_parcel_ids: ids, proposal_data: { ...row.proposal_data, cadastreParcelIds: ids } };
        const existing = target.find(item => item.proposal_id === row.proposal_id);
        const after = existing ? { ...existing } : {};
        (existing ? AUTHORED : INSERTED).forEach(key => { after[key] = incoming[key]; });
        assertCanonicalProposalRow({ ...after, accepted_parcel_ids: existing?.accepted_parcel_ids ?? null });
        const changed = !existing || AUTHORED.some(key => !isDeepStrictEqual(existing[key], incoming[key]));
        plan.push({ proposalId: row.proposal_id, existing, incoming, changed, parcels: ids.length });
    }
    plan.forEach(item => log(`${item.existing ? (item.changed ? 'update' : 'same  ') : 'insert'} ${item.proposalId}`
        + `${item.existing ? ` (#${item.existing.id})` : ''} · ${item.parcels} parcel(s)`));
    const writes = plan.filter(item => item.changed);
    if (!values.apply || !writes.length) {
        await client.query('ROLLBACK');
        log(`${writes.length} row(s) would be written; ${values.apply ? 'nothing to do' : 'DRY RUN, nothing written'}.`);
        return;
    }
    // New tables belong to geo_user (later DDL by the owner must not abort on a foreign owner).
    await client.query('SET LOCAL ROLE geo_user');
    await client.query(`CREATE TABLE IF NOT EXISTS ${BACKUP}
        (LIKE ${TABLE}, backed_up_at timestamptz NOT NULL DEFAULT now())`);
    await client.query('RESET ROLE');
    const written = [];
    for (const item of writes) {
        if (item.existing) {
            await client.query(`INSERT INTO ${BACKUP} SELECT p.*, now() FROM ${TABLE} p WHERE p.id = $1`, [item.existing.id]);
            const sets = AUTHORED.map((key, i) => `${key} = $${i + 2}${JSONB.has(key) ? '::jsonb' : ''}`);
            await client.query(`UPDATE ${TABLE} SET ${sets.join(', ')}, site = NULL, binding = NULL, updated_at = now() WHERE id = $1`,
                [item.existing.id, ...AUTHORED.map(key => JSONB.has(key) ? JSON.stringify(item.incoming[key]) : item.incoming[key])]);
            written.push(item.existing.id);
        } else {
            const cols = INSERTED;
            const { rows: [inserted] } = await client.query(`INSERT INTO ${TABLE} (${cols.join(', ')}, updated_at)
                VALUES (${cols.map((key, i) => `$${i + 1}${JSONB.has(key) ? '::jsonb' : ''}`).join(', ')}, now()) RETURNING id`,
                cols.map(key => JSONB.has(key) ? JSON.stringify(item.incoming[key]) : item.incoming[key]));
            written.push(inserted.id);
        }
    }
    await client.query('COMMIT');
    log(`wrote ${written.length} row(s): ${written.join(',')}. Backup table ${BACKUP}.`);
    log(`next: node scripts/migrate-proposal-sites.mjs --ids ${written.join(',')} --apply   (from ${backendDir})`);
}
