// Replace the authored body of one stored structure proposal (park, square, lake, …) with a given
// polygon, and bring everything derived from it along: site, binding and the declared parcels
// (computed by checkProposalBinding with derive, so the declaration is what the geometry binds).
// Used to adjust legacy records to the current rules, e.g. trimming a park that stands a few m² on
// a road corridor as the app builds it today.
//
// Reversible: the previous structure_proposal, proposal_data, cadastre_parcel_ids, site and binding
// go into proposal_geometry_edit_backup_v1 first (the first backup of a row is kept), and --restore
// puts them back.
//
//   node scripts/set-structure-geometry.mjs --help
//   node scripts/set-structure-geometry.mjs --id 14 --geometry park.json          # dry run
//   node scripts/set-structure-geometry.mjs --id 14 --geometry park.json --apply
//   node scripts/set-structure-geometry.mjs --id 14 --restore

import { createPool } from '../db/connection.cjs';
import dotenv from 'dotenv';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { serializeProposalRow } from '../proposals/serializer.js';
import { checkProposalBinding } from '../proposals/binding.js';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });

export const BACKUP_TABLE = 'proposal_geometry_edit_backup_v1';
const ts = () => new Date().toISOString();
const log = message => console.log(`[${ts()}] ${message}`);

export function parseArgs(argv) {
    const args = { id: null, geometry: null, apply: false, restore: false, help: false };
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === '--apply') args.apply = true;
        else if (arg === '--restore') args.restore = true;
        else if (arg === '--help' || arg === '-h') args.help = true;
        else if (arg === '--id') args.id = Number(argv[++index]);
        else if (arg === '--geometry') args.geometry = argv[++index];
        else throw new Error(`Unknown argument: ${arg}`);
    }
    if (!args.help) {
        if (!Number.isInteger(args.id) || args.id < 1) throw new Error('--id needs a numeric proposal row id');
        if (args.apply && args.restore) throw new Error('Pass either --apply or --restore, not both.');
        if (!args.restore && !args.geometry) throw new Error('--geometry needs a GeoJSON Polygon/MultiPolygon file');
    }
    return args;
}

// Pure: the stored row's body replaced, in both copies the row keeps of it.
export function withGeometry(row, geometry) {
    if (!geometry || !['Polygon', 'MultiPolygon'].includes(geometry.type)) throw new Error('The geometry must be a Polygon or MultiPolygon.');
    if (!row.structure_proposal || !row.structure_proposal.geometry) throw new Error(`Row ${row.id} is not a structure proposal with an authored body.`);
    const structure = { ...row.structure_proposal, geometry };
    const data = { ...(row.proposal_data || {}) };
    if (data.structureProposal) data.structureProposal = { ...data.structureProposal, geometry };
    if (data.geometry) data.geometry = geometry;
    return { ...row, structure_proposal: structure, proposal_data: data };
}

function usage() {
    console.log([
        'Replace one structure proposal\'s authored body and recompute its site, binding and declared parcels.',
        '',
        '  --id N           Proposal row id (required).',
        '  --geometry FILE  GeoJSON Polygon/MultiPolygon (or a Feature) for the new body.',
        '  (default)        Dry run: report the new area and parcels. Writes nothing.',
        `  --apply          Back the row up into ${BACKUP_TABLE}, then write it.`,
        `  --restore        Put the row back from ${BACKUP_TABLE}.`,
        '',
        'Connection: DATABASE_URL (backend/.env, or exported to point at another database).'
    ].join('\n'));
}

const ROW_COLUMNS = '*, ST_AsGeoJSON(site, 9)::jsonb AS site';

export async function run(argv = process.argv.slice(2)) {
    const args = parseArgs(argv);
    if (args.help) { usage(); return 0; }
    if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set — refusing to guess a database.'); return 1; }
    const pool = createPool();
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('SET LOCAL ROLE geo_user');
        if (args.restore) {
            const result = await client.query(`UPDATE proposal p SET structure_proposal = b.structure_proposal, proposal_data = b.proposal_data,
                cadastre_parcel_ids = b.cadastre_parcel_ids, site = b.site, binding = b.binding, updated_at = now()
                FROM consensus.${BACKUP_TABLE} b WHERE p.id = b.id AND b.id = $1`, [args.id]);
            await client.query('COMMIT');
            log(`restored ${result.rowCount} row(s)`);
            return result.rowCount === 1 ? 0 : 1;
        }
        const parsed = JSON.parse(readFileSync(args.geometry, 'utf8'));
        const geometry = parsed.type === 'Feature' ? parsed.geometry : parsed;
        const { rows } = await client.query(`SELECT ${ROW_COLUMNS} FROM proposal WHERE id = $1 FOR UPDATE`, [args.id]);
        if (!rows.length) throw new Error(`No proposal row ${args.id}.`);
        const row = rows[0];
        const next = withGeometry(row, geometry);
        const record = serializeProposalRow({ ...next, site: null, binding: null });
        delete record.site;
        delete record.binding;
        const bound = await checkProposalBinding(client, record, row.cadastre_parcel_ids, { city: row.city, derive: true });
        if (!bound.ok) throw new Error(`binding refused: ${bound.code} ${bound.error}`);
        const before = [...(row.cadastre_parcel_ids || [])].map(String).sort();
        const after = bound.cadastreParcelIds;
        const { rows: [area] } = await client.query(`SELECT round(ST_Area(ST_SetSRID(ST_GeomFromGeoJSON($1::text), 4326)::geography)::numeric, 2) AS new_m2,
            round(ST_Area(site::geography)::numeric, 2) AS old_m2 FROM proposal WHERE id = $2`, [JSON.stringify(geometry), args.id]);
        log(`#${row.id} ${row.proposal_id} ${row.type} · site ${area.old_m2} → ${area.new_m2} m² · parcels ${before.length} → ${after.length}`
            + ` · dropped [${before.filter(id => !after.includes(id)).join(', ')}] · added [${after.filter(id => !before.includes(id)).join(', ')}] · coverage ${bound.binding.coverage}`);
        if (!args.apply) { await client.query('ROLLBACK'); return 0; }
        await client.query(`CREATE TABLE IF NOT EXISTS consensus.${BACKUP_TABLE} (
            id INTEGER PRIMARY KEY,
            structure_proposal JSONB,
            proposal_data JSONB NOT NULL,
            cadastre_parcel_ids JSONB,
            site geometry(MultiPolygon, 4326),
            binding JSONB,
            backed_up_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
            created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
            updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
        )`);
        await client.query(`INSERT INTO consensus.${BACKUP_TABLE} (id, structure_proposal, proposal_data, cadastre_parcel_ids, site, binding)
            SELECT id, structure_proposal, proposal_data, cadastre_parcel_ids, site, binding FROM proposal WHERE id = $1
            ON CONFLICT (id) DO NOTHING`, [args.id]);
        const site = JSON.stringify(bound.site);
        const binding = JSON.stringify(bound.binding);
        await client.query(`UPDATE proposal SET structure_proposal = $1::jsonb, cadastre_parcel_ids = $2::jsonb,
                site = ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON($3::text), 4326)), 3)),
                binding = $4::jsonb,
                proposal_data = $5::jsonb || jsonb_build_object('site', $3::jsonb, 'binding', $4::jsonb, 'cadastreParcelIds', $2::jsonb),
                updated_at = now()
            WHERE id = $6`, [JSON.stringify(next.structure_proposal), JSON.stringify(after), site, binding, JSON.stringify(next.proposal_data), args.id]);
        // Verify from the row as stored, not from the absence of an error.
        const { rows: [stored] } = await client.query(`SELECT ${ROW_COLUMNS} FROM proposal WHERE id = $1`, [args.id]);
        const recheck = await checkProposalBinding(client, serializeProposalRow({ ...stored, site: null, binding: null }), stored.cadastre_parcel_ids, { city: stored.city });
        if (!recheck.ok) throw new Error(`stored row does not bind: ${recheck.code} ${recheck.error}`);
        await client.query('COMMIT');
        log(`#${row.id} written`);
        return 0;
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        console.error(`[${ts()}] failed: ${error.message}`);
        return 1;
    } finally {
        client.release();
        await pool.end();
    }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
    run().then(code => { process.exitCode = code; }, error => { console.error(`[${ts()}] ${error.stack || error.message}`); process.exitCode = 1; });
}
