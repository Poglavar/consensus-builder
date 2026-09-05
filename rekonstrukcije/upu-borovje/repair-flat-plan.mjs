#!/usr/bin/env node
// Repair the existing local Borovje records without changing identities or source plot positions.
// Dry-run first; each changed row is backed up in the same transaction before its update.
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { readFile } from 'node:fs/promises';
import { repairBorovjeRecords, BOROVJE_IDS, REPAIR_VERSION } from './flat-plan.mjs';
import { assertCanonicalProposalRow, stripLocalProposalState } from '../../backend/proposals/serializer.js';

const require = createRequire(new URL('../../backend/package.json', import.meta.url));
require('dotenv').config({ path: new URL('../../backend/.env', import.meta.url).pathname, quiet: true });
const turf = require('@turf/turf');
globalThis.turf = turf; // The shared browser/Node footprint helper resolves Turf at call time.
const { Pool } = require('pg');
const order = require('../frontend/js/proposals/plan-order.js');
const argv = process.argv.slice(2);
if (argv.includes('--help') || !argv.length) {
    console.log('Repair all 22 saved local Borovje proposals.\n  PGHOST=127.0.0.1 node rekonstrukcije/upu-borovje/repair-flat-plan.mjs --dry-run|--apply');
    process.exit(0);
}
if (argv.length !== 1 || !['--dry-run', '--apply'].includes(argv[0])) throw new Error('Use --dry-run or --apply.');
if (!['localhost', '127.0.0.1', '::1'].includes(process.env.PGHOST)
    || process.env.PGDATABASE !== 'geodata') throw new Error('This repair requires local PGHOST and PGDATABASE=geodata.');
const apply = argv[0] === '--apply';
const log = message => console.log(`[${new Date().toISOString()}] ${message}`);
const pool = new Pool({ max: 1 });
const client = await pool.connect();
try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '10s'");
    const { rows } = await client.query('SELECT * FROM public.proposal WHERE proposal_id = ANY($1::text[]) ORDER BY id FOR UPDATE', [BOROVJE_IDS]);
    const inputs = rows.map(row => stripLocalProposalState({
        ...row.proposal_data, proposalId: row.proposal_id, cadastreParcelIds: row.cadastre_parcel_ids,
        roadProposal: row.road_proposal, buildingProposal: row.building_proposal,
        structureProposal: row.structure_proposal, reparcellization: row.reparcellization
    }));
    const { records, adjustments } = repairBorovjeRecords(inputs, turf);
    const changes = [];
    for (const record of records) {
        const row = rows.find(item => item.proposal_id === record.proposalId);
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
            throw new Error(`${record.proposalId}: ${coverage.missing} m² outside declared cadastral ground`);
        }
        record.cadastreParcelIds = coverage.ids;
        if (record.acceptedParcelIds) record.acceptedParcelIds = record.acceptedParcelIds.filter(id => coverage.ids.includes(id));
        const after = {
            proposal_data: record, cadastre_parcel_ids: coverage.ids,
            accepted_parcel_ids: record.acceptedParcelIds || [],
            road_proposal: record.roadProposal || null, building_proposal: record.buildingProposal || null,
            structure_proposal: record.structureProposal || null, reparcellization: record.reparcellization || null,
            ownership_flow: null, cadastre_frame: null
        };
        assertCanonicalProposalRow({ ...row, ...after });
        if (Object.entries(after).some(([key, value]) => !isDeepStrictEqual(row[key], value))) changes.push({ row, after });
    }
    // Independent PostGIS proof: every authored plot/road is valid, connected and tiles the same
    // original UPU extent. Buildings/parks are content on those parcels, not additional ground.
    const ground = records.flatMap(record => record.reparcellization?.polygons?.map(p => p.geometry)
        || (record.roadProposal ? [record.roadProposal.definition.polygon] : []));
    const source = JSON.parse(await readFile(new URL('data/parcelation.geojson', import.meta.url), 'utf8'));
    const { rows: [mesh] } = await client.query(`
        WITH pieces AS (SELECT ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(g),4326),3765) geom
            FROM jsonb_array_elements($1::jsonb) g),
        original AS (SELECT ST_UnaryUnion(ST_Collect(ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(g),4326),3765))) geom
            FROM jsonb_array_elements($2::jsonb) g),
        mesh AS (SELECT bool_and(ST_IsValid(geom) AND ST_NumGeometries(geom)=1) valid,
            ST_UnaryUnion(ST_Collect(geom)) geom, SUM(ST_Area(geom)) sum_area FROM pieces)
        SELECT valid, ST_Area(m.geom) area, sum_area-ST_Area(m.geom) overlap,
            ST_Area(ST_Difference(o.geom,m.geom)) gap, ST_Area(ST_Difference(m.geom,o.geom)) outside
        FROM mesh m, original o`, [JSON.stringify(ground), JSON.stringify(source.features.map(f => f.geometry))]);
    if (!mesh.valid || mesh.overlap > 0.5 || mesh.gap > 0.5 || mesh.outside > 0.5) throw new Error(`Invalid ground mesh: ${JSON.stringify(mesh)}`);
    log(`local geodata: ${records.length} proposals, 17 plots + 2 roads; ${mesh.area.toFixed(3)} m²; gap ${mesh.gap.toFixed(6)}, overlap ${mesh.overlap.toFixed(6)}, outside ${mesh.outside.toFixed(6)} m²`);
    adjustments.filter(item => item.trimmedM2 > 1e-6).forEach(item => log(`${item.name}: trimmed ${item.trimmedM2.toFixed(3)} m² (${(100*item.trimmedM2/item.beforeM2).toFixed(3)}%)`));
    log(`${changes.length} row(s) need repair; mode ${apply ? 'APPLY' : 'DRY RUN'}`);
    if (apply && changes.length) {
        await client.query('SET LOCAL ROLE geo_user');
        await client.query(`CREATE TABLE IF NOT EXISTS public.proposal_borovje_flat_backup (
            proposal_id text NOT NULL, row_hash text NOT NULL, repair_version text NOT NULL,
            row_data jsonb NOT NULL, backed_up_at timestamptz NOT NULL DEFAULT now(),
            PRIMARY KEY(proposal_id,row_hash))`);
        for (const { row, after } of changes) {
            const json = JSON.stringify(row);
            await client.query(`INSERT INTO public.proposal_borovje_flat_backup
                (proposal_id,row_hash,repair_version,row_data) VALUES($1,$2,$3,$4::jsonb)
                ON CONFLICT DO NOTHING`, [row.proposal_id, createHash('sha256').update(json).digest('hex'), REPAIR_VERSION, json]);
            const entries = Object.entries(after);
            const { rows: [saved] } = await client.query(`UPDATE public.proposal SET
                ${entries.map(([key], i) => `${key}=$${i+2}::jsonb`).join(',')}, updated_at=now()
                WHERE id=$1 RETURNING *`, [row.id, ...entries.map(([,value]) => value === null ? null : JSON.stringify(value))]);
            assertCanonicalProposalRow(saved);
            if (entries.some(([key,value]) => !isDeepStrictEqual(saved[key],value))) throw new Error(`Readback mismatch ${row.id}`);
        }
    }
    await client.query(apply ? 'COMMIT' : 'ROLLBACK');
    log(apply ? `Committed ${changes.length} row(s); backups: public.proposal_borovje_flat_backup` : 'No rows written.');
} catch (error) {
    await client.query('ROLLBACK');
    throw error;
} finally {
    client.release();
    await pool.end();
}
