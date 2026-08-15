#!/usr/bin/env node
// Rebuild the historical local Borovje rows from the canonical UPU extent: two connected roads,
// three connected land-readjustment blocks and 17 non-road plots, with no gaps or sliver parcels.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { buildBorovjeTopology, roadDefinitionFor } from './plan-topology.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');
const require = createRequire(path.join(repoRoot, 'backend', 'package.json'));
const turf = require('@turf/turf');
const { Pool } = require('pg');
require('dotenv').config({ path: path.join(repoRoot, 'backend', '.env') });

const BASE_READJUSTMENT_ID = 633;
const ROAD_ROWS = Object.freeze({ main: 651, west: 699 });
const PARK_ROWS = Object.freeze({
    'R2-1': 645,
    'Z1-1': 646,
    'Z1-2': 647,
    'Z1-3': 648,
    'Z1-4': 649,
    'Z1-5': 650
});
const REQUIRED_IDS = [BASE_READJUSTMENT_ID, ...Object.values(ROAD_ROWS), ...Object.values(PARK_ROWS)];
const READJUSTMENT_IDS = Object.freeze([
    'p-upu-borovje-parcelacija',
    'p-upu-borovje-parcelacija-2',
    'p-upu-borovje-parcelacija-3'
]);
const COORDINATED_PLAN_ID = 'upu-borovje';
const REBUILD_MARK = 'repair-upu-borovje/clean-connected-plan-v1';
const MIN_INTERSECTION_M2 = 0.25;
const COLORS = Object.freeze({ M1: '#e8a24a', Z1: '#69b86b', R2: '#3aa88a' });

const clone = value => JSON.parse(JSON.stringify(value));
const geometryFeature = geometry => ({ type: 'Feature', properties: {}, geometry });
const areaOf = geometry => turf.area(geometryFeature(geometry));
const slugify = value => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function usage() {
    console.log([
        'Rebuild the local UPU Borovje ground mesh from the canonical reconstruction.',
        '',
        '  node rekonstrukcije/upu-borovje/apply-clean-topology.mjs          # dry run',
        '  node rekonstrukcije/upu-borovje/apply-clean-topology.mjs --apply  # write locally',
        '',
        'The apply is idempotent and stores the original affected rows in',
        'public.proposal_borovje_topology_backup before the first write.'
    ].join('\n'));
}

function parseArgs(argv) {
    const args = { apply: false, help: false };
    argv.forEach(arg => {
        if (arg === '--apply') args.apply = true;
        else if (arg === '--help' || arg === '-h') args.help = true;
        else throw new Error(`Unknown argument: ${arg}`);
    });
    return args;
}

async function loadGeojson(name) {
    return JSON.parse(await readFile(path.join(scriptDir, 'data', name), 'utf8'));
}

function effective(row) {
    const data = clone(row.proposal_data || {});
    if (row.road_proposal) data.roadProposal = clone(row.road_proposal);
    if (row.structure_proposal) data.structureProposal = clone(row.structure_proposal);
    if (row.reparcellization) data.reparcellization = clone(row.reparcellization);
    if (row.ancestor_parcel_ids) data.parentParcelIds = clone(row.ancestor_parcel_ids);
    if (row.cadastre_parcel_ids) data.cadastreParcelIds = clone(row.cadastre_parcel_ids);
    return data;
}

function stripDerivedState(data) {
    [
        'id', 'applied', 'appliedAt', 'childParcelIds', 'descendantParcelIds', 'parentFeatures',
        'childFeatures', 'formation', 'ownershipFlow', 'cadastreFrame', 'amendedByTaking'
    ].forEach(key => delete data[key]);
    ['roadProposal', 'structureProposal', 'reparcellization'].forEach(key => {
        const sub = data[key];
        if (!sub || typeof sub !== 'object') return;
        ['applied', 'appliedAt', 'childParcelIds', 'parentFeatures', 'childFeatures', 'formation', 'parentsToRemove']
            .forEach(field => delete sub[field]);
    });
    return data;
}

function displayName(properties = {}) {
    if (properties.kind === 'M1') return `Građevna čestica ${properties.name}`;
    if (properties.kind === 'R2') return `Rekreacija ${properties.name}`;
    return `Javni park ${properties.name}`;
}

function readjustmentRecord(sourceRow, component, index, parentParcelIds) {
    const proposalId = READJUSTMENT_IDS[index];
    const blockNumber = index + 1;
    const title = `UPU Borovje – nova parcelacija – blok ${blockNumber}/3`;
    const totalArea = component.plots.reduce((sum, plot) => sum + areaOf(plot.geometry), 0);
    const polygons = component.plots.map(plot => {
        const plotArea = areaOf(plot.geometry);
        return {
            ownerKey: slugify(plot.properties?.name),
            displayName: displayName(plot.properties),
            color: COLORS[plot.properties?.kind] || '#999999',
            percent: Math.round((plotArea / totalArea) * 1000) / 10,
            area: Math.round(plotArea * 10) / 10,
            sourceKind: plot.properties?.kind || null,
            sourceName: plot.properties?.name || null,
            geometry: clone(plot.geometry)
        };
    });
    const basePlan = sourceRow.reparcellization || {};
    const reparcellization = {
        ...clone(basePlan),
        algorithm: 'upu-plan',
        parcelIds: parentParcelIds.slice(),
        parentParcelIds: parentParcelIds.slice(),
        poolGeometry: clone(component.geometry),
        totalArea: Math.round(totalArea * 10) / 10,
        ownerShares: [],
        polygons,
        rebuiltBy: REBUILD_MARK,
        validated: true
    };
    delete reparcellization.applied;
    const data = stripDerivedState(effective(sourceRow));
    Object.assign(data, {
        proposalId,
        proposal_id: proposalId,
        coordinatedPlanId: COORDINATED_PLAN_ID,
        city: 'zagreb',
        goal: 'reparcellization',
        type: 'parcel',
        title,
        name: title,
        description: `Nova parcelacija povezanog bloka ${blockNumber} od 3. Ulična mreža odvaja ga od ostalih dijelova obuhvata, zato su tri nepovezana područja objavljena kao tri zasebna prijedloga parcelacije.`,
        parentParcelIds: parentParcelIds.slice(),
        cadastreParcelIds: parentParcelIds.slice(),
        coordinatedPlanId: COORDINATED_PLAN_ID,
        reparcellization
    });
    return { proposalId, title, description: data.description, parentParcelIds, data, reparcellization };
}

function roadRecord(sourceRow, road, parentParcelIds) {
    const data = stripDerivedState(effective(sourceRow));
    const definition = roadDefinitionFor(road.streets, road.geometry);
    const roadProposal = {
        ...(data.roadProposal || {}),
        definition,
        parentParcelIds: parentParcelIds.slice()
    };
    delete roadProposal.childParcelIds;
    delete roadProposal.applied;
    Object.assign(data, {
        coordinatedPlanId: COORDINATED_PLAN_ID,
        parentParcelIds: parentParcelIds.slice(),
        cadastreParcelIds: parentParcelIds.slice(),
        roadProposal
    });
    if (data.geometry && typeof data.geometry === 'object') {
        data.geometry.roadPlan = clone(definition);
        data.geometry.roadGeometry = null;
    }
    return { parentParcelIds, data, roadProposal };
}

function parkRecord(sourceRow, plot, parentParcelIds) {
    const data = stripDerivedState(effective(sourceRow));
    const structureProposal = {
        ...(data.structureProposal || {}),
        kind: 'park',
        geometry: clone(plot.geometry),
        parentParcelIds: parentParcelIds.slice()
    };
    delete structureProposal.applied;
    Object.assign(data, {
        coordinatedPlanId: COORDINATED_PLAN_ID,
        parentParcelIds: parentParcelIds.slice(),
        cadastreParcelIds: parentParcelIds.slice(),
        structureProposal
    });
    return { parentParcelIds, data, structureProposal };
}

async function anchorsFor(client, geometries) {
    const { rows: [row] } = await client.query(`
        WITH input AS (
            SELECT ST_Transform(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON(g)::geometry, 4326)), 3765) AS g
            FROM jsonb_array_elements($1::jsonb) g
        ), footprint AS (
            SELECT ST_UnaryUnion(ST_Collect(g)) AS g FROM input
        ), hit AS (
            SELECT 'HR-' || p.maticni_broj_ko || '-' || p.broj_cestice AS id,
                   ST_Area(ST_Intersection(footprint.g, p.geom)) AS overlap_m2
            FROM footprint JOIN public.parcel p
              ON p.current AND p.geom && footprint.g
             AND ST_Area(ST_Intersection(footprint.g, p.geom)) >= $2
        )
        SELECT COALESCE(array_agg(id ORDER BY overlap_m2 DESC), '{}') AS ids FROM hit`,
    [JSON.stringify(geometries), MIN_INTERSECTION_M2]);
    return row.ids || [];
}

async function proposalColumns(client) {
    const { rows } = await client.query(`
        SELECT attname AS name FROM pg_attribute
        WHERE attrelid = 'public.proposal'::regclass AND attnum > 0 AND NOT attisdropped AND attname <> 'id'
        ORDER BY attnum`);
    return rows.map(row => row.name);
}

function sqlValue(column, value, values) {
    if (value === null) return 'NULL';
    values.push(typeof value === 'string' ? value : JSON.stringify(value));
    const placeholder = `$${values.length}`;
    if (typeof value === 'string') return `${placeholder}::text`;
    if (typeof value === 'boolean') return `${placeholder}::boolean`;
    return `${placeholder}::jsonb`;
}

async function insertSibling(client, sourceId, columns, record) {
    const overrides = new Map(Object.entries({
        proposal_id: record.proposalId,
        title: record.title,
        name: record.title,
        description: record.description,
        ancestor_parcel_ids: record.parentParcelIds,
        cadastre_parcel_ids: record.parentParcelIds,
        descendant_parcel_ids: [],
        parent_features: [],
        child_features: [],
        proposal_data: record.data,
        reparcellization: record.reparcellization,
        ownership_flow: null,
        cadastre_frame: null
    }));
    const values = [];
    const select = columns.map(column => {
        if (column === 'updated_at') return 'now()';
        return overrides.has(column) ? sqlValue(column, overrides.get(column), values) : column;
    });
    values.push(sourceId);
    const { rows: [inserted] } = await client.query(
        `INSERT INTO public.proposal (${columns.join(', ')})
         SELECT ${select.join(', ')} FROM public.proposal WHERE id = $${values.length}
         RETURNING id`, values);
    if (!inserted) throw new Error(`Could not clone readjustment ${record.proposalId}`);
    return inserted.id;
}

async function updateRecord(client, rowId, record, subColumn, subValue) {
    const values = [
        rowId,
        JSON.stringify(record.data),
        JSON.stringify(record.parentParcelIds),
        record.data.title || null,
        record.data.name || null,
        record.data.description || null,
        JSON.stringify(subValue)
    ];
    const subSet = `${subColumn} = $7::jsonb`;
    const { rowCount } = await client.query(`
        UPDATE public.proposal SET
            proposal_data = $2::jsonb,
            ancestor_parcel_ids = $3::jsonb,
            cadastre_parcel_ids = $3::jsonb,
            descendant_parcel_ids = '[]'::jsonb,
            parent_features = '[]'::jsonb,
            child_features = '[]'::jsonb,
            ownership_flow = NULL,
            cadastre_frame = NULL,
            title = COALESCE($4, title),
            name = COALESCE($5, name),
            description = COALESCE($6, description),
            ${subSet},
            updated_at = now()
        WHERE id = $1 AND (
            proposal_data IS DISTINCT FROM $2::jsonb OR
            ancestor_parcel_ids IS DISTINCT FROM $3::jsonb OR
            cadastre_parcel_ids IS DISTINCT FROM $3::jsonb OR
            descendant_parcel_ids IS DISTINCT FROM '[]'::jsonb OR
            parent_features IS DISTINCT FROM '[]'::jsonb OR
            child_features IS DISTINCT FROM '[]'::jsonb OR
            ownership_flow IS NOT NULL OR cadastre_frame IS NOT NULL OR
            title IS DISTINCT FROM COALESCE($4, title) OR
            name IS DISTINCT FROM COALESCE($5, name) OR
            description IS DISTINCT FROM COALESCE($6, description) OR
            ${subColumn} IS DISTINCT FROM $7::jsonb
        )`, values);
    return rowCount;
}

async function ensureBackup(client) {
    await client.query(`
        CREATE TABLE IF NOT EXISTS public.proposal_borovje_topology_backup (
            proposal_id text PRIMARY KEY,
            id integer NOT NULL,
            row_data jsonb NOT NULL,
            backed_up_at timestamptz NOT NULL DEFAULT now()
        )`);
    await client.query(`
        INSERT INTO public.proposal_borovje_topology_backup (proposal_id, id, row_data)
        SELECT proposal_id, id, to_jsonb(p) FROM public.proposal p
        WHERE id = ANY($1::int[])
           OR proposal_id = ANY($2::text[])
        ON CONFLICT (proposal_id) DO NOTHING`, [REQUIRED_IDS, READJUSTMENT_IDS]);
}

async function run(argv = process.argv.slice(2)) {
    const args = parseArgs(argv);
    if (args.help) { usage(); return; }
    if (!process.env.PGDATABASE) throw new Error('PGDATABASE is not set; refusing to guess a database');

    const [parcelation, streets] = await Promise.all([
        loadGeojson('parcelation.geojson'),
        loadGeojson('streets.geojson')
    ]);
    const topology = buildBorovjeTopology(parcelation, streets, turf);
    const pool = new Pool();
    const client = await pool.connect();
    let written = 0;
    const ids = {};
    try {
        await client.query('BEGIN');
        const { rows } = await client.query(`
            SELECT * FROM public.proposal
            WHERE id = ANY($1::int[]) OR proposal_id = ANY($2::text[])
            ORDER BY id`, [REQUIRED_IDS, READJUSTMENT_IDS]);
        const byId = new Map(rows.map(row => [row.id, row]));
        const byProposalId = new Map(rows.map(row => [row.proposal_id, row]));
        const missing = REQUIRED_IDS.filter(id => !byId.has(id));
        if (missing.length) throw new Error(`Required local proposal rows are missing: ${missing.join(', ')}`);

        console.log(`database: ${process.env.PGDATABASE}   mode: ${args.apply ? 'APPLY' : 'DRY RUN'}`);
        console.log(`plan ${topology.stats.poolM2.toFixed(1)} m² = roads ${topology.stats.roadsM2.toFixed(1)} + plots ${topology.stats.plotsM2.toFixed(1)}`);
        console.log(`${topology.stats.readjustmentCount} connected readjustments; ${topology.stats.plotCount} plots; smallest ${topology.stats.minPlotM2.toFixed(1)} m²`);
        console.log(`mesh gap ${topology.stats.gapM2.toFixed(3)}; outside ${topology.stats.outsideM2.toFixed(3)}; overlap ${topology.stats.overlapM2.toFixed(3)} m²`);

        const sourceRow = byId.get(BASE_READJUSTMENT_ID);
        const readjustmentRecords = [];
        for (let index = 0; index < topology.readjustments.length; index += 1) {
            const component = topology.readjustments[index];
            const anchors = await anchorsFor(client, [component.geometry]);
            if (!anchors.length) throw new Error(`Readjustment block ${index + 1} has no cadastral anchors`);
            const record = readjustmentRecord(sourceRow, component, index, anchors);
            readjustmentRecords.push(record);
            console.log(`  LR ${index + 1}: ${component.areaM2.toFixed(1)} m², ${component.plots.length} plots, ${anchors.length} anchors`);
        }

        const roadRecords = {};
        for (const key of ['main', 'west']) {
            const anchors = await anchorsFor(client, [topology.roads[key].geometry]);
            if (!anchors.length) throw new Error(`${key} road has no cadastral anchors`);
            roadRecords[key] = roadRecord(byId.get(ROAD_ROWS[key]), topology.roads[key], anchors);
            console.log(`  road ${key}: ${areaOf(topology.roads[key].geometry).toFixed(1)} m², ${anchors.length} anchors, ${topology.roads[key].streets.length} segment(s)`);
        }

        const parkRecords = [];
        for (const [name, rowId] of Object.entries(PARK_ROWS)) {
            const plot = topology.plots.find(item => item.properties?.name === name);
            if (!plot) throw new Error(`Canonical parcel ${name} is missing`);
            const anchors = await anchorsFor(client, [plot.geometry]);
            if (!anchors.length) throw new Error(`${name} has no cadastral anchors`);
            parkRecords.push({ rowId, record: parkRecord(byId.get(rowId), plot, anchors) });
        }

        if (!args.apply) {
            console.log('DRY RUN — no rows written. Re-run with --apply.');
            await client.query('ROLLBACK');
            return;
        }

        await client.query('SET LOCAL ROLE geo_user');
        await ensureBackup(client);
        const columns = await proposalColumns(client);
        for (let index = 0; index < readjustmentRecords.length; index += 1) {
            const record = readjustmentRecords[index];
            let row = byProposalId.get(record.proposalId);
            if (!row) {
                const id = await insertSibling(client, BASE_READJUSTMENT_ID, columns, record);
                row = { id, proposal_id: record.proposalId };
                written += 1;
                console.log(`  inserted #${id} ${record.proposalId}`);
            } else {
                written += await updateRecord(client, row.id, record, 'reparcellization', record.reparcellization);
            }
            ids[record.proposalId] = row.id;
        }
        written += await updateRecord(client, ROAD_ROWS.main, roadRecords.main, 'road_proposal', roadRecords.main.roadProposal);
        written += await updateRecord(client, ROAD_ROWS.west, roadRecords.west, 'road_proposal', roadRecords.west.roadProposal);
        for (const { rowId, record } of parkRecords) {
            written += await updateRecord(client, rowId, record, 'structure_proposal', record.structureProposal);
        }
        await client.query('COMMIT');
        console.log(`${written} row write(s); readjustments ${READJUSTMENT_IDS.map(id => `#${ids[id]}`).join(', ')}`);
    } catch (error) {
        try { await client.query('ROLLBACK'); } catch (_) { }
        throw error;
    } finally {
        client.release();
        await pool.end();
    }
}

run().catch(error => {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
});
