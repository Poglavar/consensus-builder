// Repair the authored Šibenik road graph as data, not as a render-time exception.
//
// The named plan is a graph of independently published corridor records. This migration:
//   1. removes the two explicitly identified disconnected road records from the plan;
//   2. collapses sub-metre micro-edges that represent one intended junction;
//   3. joins dangling endpoints only when they are within one metre of an existing node/edge;
//   4. removes the remaining unsupported dead-end stretches; and
//   5. rebuilds physical effects only where a centreline actually moved, while topology-only
//      noding keeps the already-published footprint and cadastral effect byte-for-byte.
//
// It is a dry run unless --apply is passed. Writes happen in one transaction. Retired proposal
// rows remain available as Cancelled history; only their numeric ids disappear from the named plan.

import pkg from 'pg';
import 'dotenv/config';
import { createRequire } from 'node:module';
import { serializeProposalRow } from '../proposals/serializer.js';
import { recomputeCorridorStats } from '../routes/road-corridor.js';
import {
    auditRoadNetwork,
    repairRoadNetwork
} from './lib/road-network-repair.mjs';

const require = createRequire(import.meta.url);
const { Pool } = pkg;

globalThis.turf = require('@turf/turf');
globalThis.stableStringify = require('../../frontend/js/shared-utils.js').stableStringify;
const planOrder = require('../../frontend/js/proposals/plan-order.js');
const ownershipFlowApi = require('../../frontend/js/proposals/ownership-flow.js');
const sharingApi = require('../../frontend/js/proposals/sharing.js');
const corridorLevels = require('../../frontend/js/proposals/corridor-levels.js');

const PLAN_SLUG = 'sibenik-2066-1';
const SNAP_TOLERANCE_METERS = 1;
const MICRO_EDGE_METERS = 1;
const EXPLICIT_DISCONNECTED_PROPOSAL_IDS = new Set([
    'c2-uh980k1g32gls', // Road 1008-1649
    'c2-1xglial6daau5' // Road 1008-1639
]);

export function parseArgs(argv) {
    const args = { apply: false, help: false };
    argv.forEach(arg => {
        if (arg === '--apply') args.apply = true;
        else if (arg === '--help' || arg === '-h') args.help = true;
        else throw new Error(`Unknown argument: ${arg}`);
    });
    return args;
}

function usage() {
    console.log(`
Repair the ${PLAN_SLUG} authored road network.

  node scripts/repair-sibenik-road-network.mjs          # dry run
  node scripts/repair-sibenik-road-network.mjs --apply  # transactional write

Safety: this script only writes through a localhost PostgreSQL connection.
`);
}

function assertLocalDatabaseConfig() {
    const host = String(process.env.PGHOST || '').trim().toLowerCase();
    if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
        throw new Error(`PGHOST must be localhost for this migration (received '${host || '(unset)'}')`);
    }
    if (!process.env.PGDATABASE) throw new Error('PGDATABASE is not set; run from backend/ so .env is loaded');
}

function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function corridorCenterline(definition) {
    const raw = (Array.isArray(definition?.points) && definition.points.length)
        ? definition.points
        : definition?.segments;
    if (!Array.isArray(raw) || !raw.length) return [];
    const segments = Array.isArray(raw[0]) ? raw : [raw];
    return segments.map(segment => (Array.isArray(segment) ? segment : []).map(point => ({ ...point })))
        .filter(segment => segment.length >= 2);
}

function profileWidth(profile) {
    const strips = Array.isArray(profile?.strips) ? profile.strips : [];
    const width = strips.reduce((sum, strip) => sum + (Number(strip?.width) || 0), 0);
    return width > 0 ? width : null;
}

function segmentWidth(definition, segmentId) {
    const override = segmentId !== null && segmentId !== undefined
        ? definition?.segmentProfiles?.[String(segmentId)]
        : null;
    return profileWidth(override) || profileWidth(definition?.profile) || Number(definition?.width) || 10;
}

function baseStretchId(segmentId, index) {
    if (segmentId === null || segmentId === undefined || String(segmentId) === '') return `anonymous-${index}`;
    const text = String(segmentId);
    const split = text.indexOf('~');
    return split === -1 ? text : text.slice(0, split);
}

function definitionEntry(row) {
    const definition = clone(row.road_proposal?.definition || {});
    const segments = corridorCenterline(definition);
    const ids = Array.isArray(definition.segmentIds) ? definition.segmentIds.slice(0, segments.length) : [];
    while (ids.length < segments.length) ids.push(null);
    return {
        dbId: Number(row.id),
        proposalId: String(row.proposal_id),
        title: row.title || row.name || row.proposal_id,
        row,
        definition,
        segments,
        segmentIds: ids,
        segmentProfiles: clone(definition.segmentProfiles || {})
    };
}

function definitionSignature(entry) {
    return globalThis.stableStringify({
        segments: entry.segments,
        segmentIds: entry.segmentIds,
        segmentProfiles: entry.segmentProfiles
    });
}

function footprintInputs(entry) {
    const inputs = [];
    entry.segments.forEach((segment, index) => {
        const segmentId = entry.segmentIds[index] ?? null;
        const width = segmentWidth(entry.definition, segmentId);
        corridorLevels.acquiringSpans(segment).forEach((span, spanIndex) => {
            if (span.length < 2) return;
            inputs.push({
                groupKey: `${baseStretchId(segmentId, index)}:${width}`,
                width,
                geometry: {
                    type: 'LineString',
                    coordinates: span.map(point => [Number(point.lng), Number(point.lat)])
                },
                spanIndex
            });
        });
    });
    return inputs;
}

const FOOTPRINT_SQL = `
    WITH input AS (
        SELECT value->>'groupKey' AS group_key,
               (value->>'width')::double precision AS width_m,
               ST_Transform(
                   ST_SetSRID(ST_GeomFromGeoJSON((value->'geometry')::text), 4326),
                   3765
               ) AS geom
        FROM jsonb_array_elements($1::jsonb) value
    ), grouped AS (
        SELECT group_key, width_m,
               ST_LineMerge(ST_UnaryUnion(ST_Collect(geom))) AS geom
        FROM input
        GROUP BY group_key, width_m
    ), buffered AS (
        SELECT ST_Buffer(geom, width_m / 2.0, 'endcap=flat join=bevel') AS geom
        FROM grouped
    ), merged AS (
        SELECT ST_CollectionExtract(ST_MakeValid(ST_UnaryUnion(ST_Collect(geom))), 3) AS geom
        FROM buffered
    )
    SELECT ST_AsGeoJSON(ST_Transform(geom, 4326))::json AS geometry,
           ST_Area(geom)::double precision AS area_m2
    FROM merged
`;

async function rebuildFootprint(client, entry) {
    const inputs = footprintInputs(entry);
    if (!inputs.length) throw new Error(`${entry.title} has no acquiring centreline spans`);
    const { rows: [row] } = await client.query(FOOTPRINT_SQL, [JSON.stringify(inputs)]);
    if (!row?.geometry || !['Polygon', 'MultiPolygon'].includes(row.geometry.type)) {
        throw new Error(`PostGIS could not rebuild ${entry.title}'s corridor footprint`);
    }
    return { geometry: row.geometry, areaM2: Number(row.area_m2) };
}

function latLngPairsFromGeometry(geometry) {
    const ring = coordinates => coordinates.map(([lng, lat]) => [Number(lat), Number(lng)]);
    if (geometry?.type === 'Polygon') return geometry.coordinates.map(ring);
    if (geometry?.type === 'MultiPolygon') return geometry.coordinates.map(polygon => polygon.map(ring));
    return null;
}

const PARCEL_CANDIDATES_SQL = `
    SELECT 'HR-' || p.maticni_broj_ko || '-' || p.broj_cestice AS parcel_id,
           ST_AsGeoJSON(ST_Transform(p.geom, 4326))::json AS geometry
    FROM parcel p
    WHERE p.current = true
      AND p.geom && ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON($1), 4326), 3765)
      AND ST_Intersects(p.geom, ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON($1), 4326), 3765))
`;

async function cadastralEffect(client, proposal) {
    const geometry = proposal.roadProposal?.definition?.polygon;
    const { rows } = await client.query(PARCEL_CANDIDATES_SQL, [JSON.stringify(geometry)]);
    const candidates = rows.map(row => ({
        id: row.parcel_id,
        feature: globalThis.turf.feature(row.geometry)
    }));
    const parentIds = planOrder.computeCadastreParcelIds(proposal, candidates);
    const ownershipFlow = ownershipFlowApi.computeOwnershipFlow(proposal, candidates);
    return { parentIds, ownershipFlow };
}

const FOOTPRINT_DIFF_SQL = `
    WITH old_footprint AS (
        SELECT ST_MakeValid(ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON($1), 4326), 3765)) AS geom
    ), new_footprint AS (
        SELECT ST_MakeValid(ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON($2), 4326), 3765)) AS geom
    )
    SELECT ST_Area(o.geom)::double precision AS old_area_m2,
           ST_Area(n.geom)::double precision AS new_area_m2,
           ST_Area(ST_SymDifference(o.geom, n.geom))::double precision AS symmetric_difference_m2
    FROM old_footprint o, new_footprint n
`;

async function footprintDifference(client, oldGeometry, newGeometry) {
    if (!oldGeometry) return { oldAreaM2: 0, newAreaM2: 0, symmetricDifferenceM2: 0, fraction: 0 };
    const { rows: [row] } = await client.query(FOOTPRINT_DIFF_SQL, [
        JSON.stringify(oldGeometry),
        JSON.stringify(newGeometry)
    ]);
    const oldAreaM2 = Number(row.old_area_m2) || 0;
    const newAreaM2 = Number(row.new_area_m2) || 0;
    const symmetricDifferenceM2 = Number(row.symmetric_difference_m2) || 0;
    return {
        oldAreaM2,
        newAreaM2,
        symmetricDifferenceM2,
        fraction: symmetricDifferenceM2 / Math.max(1, oldAreaM2, newAreaM2)
    };
}

function centerlineGeometry(definition) {
    const segments = corridorCenterline(definition);
    if (!segments.length) return null;
    return {
        type: 'MultiLineString',
        coordinates: segments.map(segment => segment.map(point => [Number(point.lng), Number(point.lat)]))
    };
}

const CENTERLINE_SHIFT_SQL = `
    WITH old_line AS (
        SELECT ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON($1), 4326), 3765) AS geom
    ), new_line AS (
        SELECT ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON($2), 4326), 3765) AS geom
    )
    SELECT ST_HausdorffDistance(o.geom, n.geom)::double precision AS shift_m
    FROM old_line o, new_line n
`;

async function centerlineShiftMeters(client, oldDefinition, newDefinition) {
    const oldGeometry = centerlineGeometry(oldDefinition);
    const newGeometry = centerlineGeometry(newDefinition);
    if (!oldGeometry || !newGeometry) return Infinity;
    const { rows: [row] } = await client.query(CENTERLINE_SHIFT_SQL, [
        JSON.stringify(oldGeometry),
        JSON.stringify(newGeometry)
    ]);
    return Number(row?.shift_m);
}

function sortedParcelHash(ids) {
    return [...new Set((ids || []).map(String))]
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
        .join('|');
}

async function prepareChangedProposal(client, entry, migrationAt, options = {}) {
    const rebuildPhysicalEffect = options.rebuildPhysicalEffect === true;
    const oldProposalId = entry.proposalId;
    const originalRoadProposal = clone(entry.row.road_proposal);
    const roadProposal = clone(originalRoadProposal);
    const definition = clone(entry.definition);
    definition.points = clone(entry.segments);
    definition.segments = definition.points;
    definition.segmentIds = clone(entry.segmentIds);
    definition.segmentProfiles = clone(entry.segmentProfiles || {});
    delete definition.surfaceFootprint;
    delete definition.demolishedBuildings;
    delete definition.demolitionScanned;

    if (rebuildPhysicalEffect) {
        const footprint = await rebuildFootprint(client, { ...entry, definition });
        definition.polygon = footprint.geometry;
        definition.latLngPairs = latLngPairsFromGeometry(footprint.geometry);
    } else {
        // Noding and splitting only change how the SAME centreline is represented. The stored
        // footprint is already the exact published effect; rebuilding it with a different boolean
        // geometry engine would introduce unrelated polygon drift.
        definition.polygon = clone(originalRoadProposal?.definition?.polygon || null);
        definition.latLngPairs = clone(originalRoadProposal?.definition?.latLngPairs || null);
    }
    roadProposal.definition = definition;

    const proposal = serializeProposalRow(entry.row);
    proposal.roadProposal = roadProposal;
    const effect = rebuildPhysicalEffect
        ? await cadastralEffect(client, proposal)
        : {
            parentIds: clone(entry.row.cadastre_parcel_ids || entry.row.ancestor_parcel_ids || []),
            ownershipFlow: clone(entry.row.ownership_flow || [])
        };
    proposal.parentParcelIds = effect.parentIds;
    proposal.cadastreParcelIds = clone(effect.parentIds);
    proposal.ownershipFlow = effect.ownershipFlow;
    proposal.cadastreFrame = rebuildPhysicalEffect
        ? { ...(proposal.cadastreFrame || {}), capturedAt: migrationAt }
        : clone(proposal.cadastreFrame || entry.row.cadastre_frame || null);
    proposal.updatedAt = migrationAt;
    if (rebuildPhysicalEffect) proposal.similarityHash = sortedParcelHash(effect.parentIds);
    proposal.roadProposal.parentParcelIds = clone(effect.parentIds);

    if (rebuildPhysicalEffect) {
        const stats = await recomputeCorridorStats(client, proposal);
        if (stats) {
            proposal.ownershipAndAcquisitionStats = stats;
            proposal.roadProposal.definition.metadata = proposal.roadProposal.definition.metadata || {};
            proposal.roadProposal.definition.metadata.ownershipAndAcquisitionStats = stats;
        }
    }
    proposal.effectHash = ownershipFlowApi.effectFingerprintOf(proposal);
    const newProposalId = sharingApi.proposalContentFingerprint(proposal);
    if (!newProposalId) throw new Error(`Could not fingerprint ${entry.title}`);
    proposal.proposalId = newProposalId;
    proposal.proposal_id = newProposalId;
    proposal.hash = newProposalId;

    const footprintDiff = await footprintDifference(
        client,
        originalRoadProposal?.definition?.polygon,
        proposal.roadProposal.definition.polygon
    );
    const centerlineShiftM = await centerlineShiftMeters(
        client,
        originalRoadProposal?.definition,
        proposal.roadProposal.definition
    );
    if (!Number.isFinite(centerlineShiftM)
        || centerlineShiftM > SNAP_TOLERANCE_METERS + 0.001) {
        throw new Error(
            `${entry.title} centreline moved ${Number.isFinite(centerlineShiftM) ? `${centerlineShiftM.toFixed(3)}m` : 'an unknown distance'}; `
            + `refusing a junction repair beyond ${SNAP_TOLERANCE_METERS}m`
        );
    }

    const { rows: collision } = await client.query(
        'SELECT id, proposal_id FROM proposal WHERE proposal_id = $1 AND id <> $2 LIMIT 1',
        [newProposalId, entry.dbId]
    );
    if (collision.length) {
        throw new Error(`${entry.title} would collide with existing proposal #${collision[0].id} (${newProposalId})`);
    }

    return {
        dbId: entry.dbId,
        title: entry.title,
        oldProposalId,
        newProposalId,
        roadProposal: proposal.roadProposal,
        proposalData: proposal,
        ancestorParcelIds: effect.parentIds,
        cadastreParcelIds: effect.parentIds,
        ownershipFlow: effect.ownershipFlow,
        cadastreFrame: proposal.cadastreFrame,
        footprintDiff,
        centerlineShiftM,
        rebuiltPhysicalEffect: rebuildPhysicalEffect,
        oldParents: Array.isArray(entry.row.cadastre_parcel_ids) ? entry.row.cadastre_parcel_ids.map(String) : []
    };
}

function describeAudit(label, audit) {
    console.log(`${label}: ${audit.entryCount} road record(s), ${audit.segmentCount} stretch(es), `
        + `${audit.edgeCount} edge(s), ${audit.nodeCount} node(s), ${audit.components.length} component(s), `
        + `${audit.dangling.length} dangling endpoint(s), ${audit.microEdges.length} sub-${MICRO_EDGE_METERS}m edge(s), `
        + `${audit.duplicateEdgeCount} duplicate edge(s)`);
}

function describeRepair(result) {
    console.log(`\nCollapsed micro-junctions: ${result.collapsedJunctions.length}`);
    result.collapsedJunctions.forEach((item, index) => {
        console.log(`  ${index + 1}. ${item.nodeCount} nodes, edges ${item.edgeLengthsMeters.map(m => `${m.toFixed(3)}m`).join(', ')}`);
        console.log(`     ${item.proposalIds.join(', ')}`);
    });
    console.log(`Snapped dangling endpoints within ${SNAP_TOLERANCE_METERS}m: ${result.snaps.length}`);
    result.snaps.forEach(item => console.log(
        `  ${item.title || item.proposalId}: ${item.distanceMeters.toFixed(3)}m to ${item.kind}`
    ));
    console.log(`Removed unsupported stretches: ${result.removedSegments.length}`);
    result.removedSegments.forEach(item => console.log(
        `  ${item.title || item.proposalId} · ${item.segmentId || '(no id)'} · ${item.lengthMeters.toFixed(1)}m`
    ));
}

async function updateProposal(client, change) {
    await client.query(
        `UPDATE proposal
         SET proposal_id = $1,
             road_proposal = $2::jsonb,
             proposal_data = $3::jsonb,
             ancestor_parcel_ids = $4::jsonb,
             cadastre_parcel_ids = $5::jsonb,
             ownership_flow = $6::jsonb,
             cadastre_frame = $7::jsonb,
             updated_at = NOW()
         WHERE id = $8`,
        [
            change.newProposalId,
            JSON.stringify(change.roadProposal),
            JSON.stringify(change.proposalData),
            JSON.stringify(change.ancestorParcelIds),
            JSON.stringify(change.cadastreParcelIds),
            JSON.stringify(change.ownershipFlow),
            JSON.stringify(change.cadastreFrame),
            change.dbId
        ]
    );
}

async function retireProposal(client, entry, migrationAt) {
    const data = clone(entry.row.proposal_data || {});
    data.lifecycleStatus = 'Cancelled';
    data.applied = false;
    data.updatedAt = migrationAt;
    await client.query(
        `UPDATE proposal
         SET lifecycle_status = 'Cancelled', applied = false, proposal_data = $1::jsonb, updated_at = NOW()
         WHERE id = $2`,
        [JSON.stringify(data), entry.dbId]
    );
}

async function assertNoExternalContentIdReferences(client, changes) {
    if (!changes.length) return;
    const targets = changes.map(change => ({ dbId: change.dbId, oldId: change.oldProposalId }));
    const { rows: proposalReferences } = await client.query(
        `WITH target AS (
             SELECT * FROM jsonb_to_recordset($1::jsonb) AS item("dbId" integer, "oldId" text)
         ), refs AS MATERIALIZED (
             SELECT id, proposal_id, proposal_data ->> 'sourceProposalId' AS referenced_id FROM proposal
             UNION ALL
             SELECT id, proposal_id, proposal_data ->> 'replacementOfProposalId' FROM proposal
             UNION ALL
             SELECT id, proposal_id, proposal_data ->> 'copiedFromProposalId' FROM proposal
             UNION ALL
             SELECT id, proposal_id, proposal_data #>> '{copySource,proposalId}' FROM proposal
             UNION ALL
             SELECT p.id, p.proposal_id, value
             FROM proposal p
             CROSS JOIN LATERAL jsonb_array_elements_text(
                 CASE WHEN jsonb_typeof(p.parent_proposal_ids) = 'array'
                      THEN p.parent_proposal_ids ELSE '[]'::jsonb END
             ) item(value)
             UNION ALL
             SELECT p.id, p.proposal_id, value
             FROM proposal p
             CROSS JOIN LATERAL jsonb_array_elements_text(
                 CASE WHEN jsonb_typeof(p.child_proposal_ids) = 'array'
                      THEN p.child_proposal_ids ELSE '[]'::jsonb END
             ) item(value)
             UNION ALL
             SELECT p.id, p.proposal_id, value
             FROM proposal p
             CROSS JOIN LATERAL jsonb_array_elements_text(
                 CASE WHEN jsonb_typeof(p.proposal_data -> 'supersedesProposalIds') = 'array'
                      THEN p.proposal_data -> 'supersedesProposalIds' ELSE '[]'::jsonb END
             ) item(value)
         )
         SELECT target."dbId" AS target_id, target."oldId" AS old_id,
                refs.id AS source_id, refs.proposal_id AS source_proposal_id
         FROM target
         JOIN refs ON refs.id <> target."dbId" AND refs.referenced_id = target."oldId"
         LIMIT 1`,
        [JSON.stringify(targets)]
    );
    if (proposalReferences.length) {
        const ref = proposalReferences[0];
        throw new Error(
            `Cannot change ${ref.old_id}: proposal #${ref.source_id} (${ref.source_proposal_id}) still references it`
        );
    }

    const { rows: sceneReferences } = await client.query(
        `WITH target AS (
             SELECT * FROM jsonb_to_recordset($1::jsonb) AS item("dbId" integer, "oldId" text)
         ), refs AS (
             SELECT id, focus_proposal_id AS referenced_id FROM ai_scene
             UNION ALL
             SELECT scene.id, member.value #>> '{}'
             FROM ai_scene scene
             CROSS JOIN LATERAL jsonb_array_elements(
                 CASE WHEN jsonb_typeof(scene.proposal_ids) = 'array'
                      THEN scene.proposal_ids ELSE '[]'::jsonb END
             ) member(value)
         )
         SELECT target."oldId" AS old_id, refs.id AS scene_id
         FROM target
         JOIN refs ON refs.referenced_id = target."oldId"
         LIMIT 1`,
        [JSON.stringify(targets)]
    );
    if (sceneReferences.length) {
        const ref = sceneReferences[0];
        throw new Error(`Cannot change ${ref.old_id}: AI scene #${ref.scene_id} still references it`);
    }
}

async function assertRetirementsArePlanLocal(client, retired) {
    if (!retired.length) return;
    const retiredIds = retired.map(entry => entry.dbId);
    const { rows } = await client.query(
        `SELECT plan.slug, member.value #>> '{}' AS proposal_id
         FROM ens_plan plan
         CROSS JOIN LATERAL jsonb_array_elements(plan.proposal_ids) member(value)
         WHERE plan.slug <> $1
           AND (member.value #>> '{}')::integer = ANY($2::integer[])
         LIMIT 1`,
        [PLAN_SLUG, retiredIds]
    );
    if (rows.length) {
        throw new Error(`Cannot retire proposal #${rows[0].proposal_id}: it is also in named plan '${rows[0].slug}'`);
    }
}

async function verifyWrittenState(client, expectedPlanIds, changes, retired) {
    const { rows: [plan] } = await client.query(
        'SELECT proposal_ids FROM ens_plan WHERE slug = $1',
        [PLAN_SLUG]
    );
    if (globalThis.stableStringify(plan.proposal_ids) !== globalThis.stableStringify(expectedPlanIds)) {
        throw new Error('Plan membership verification failed');
    }
    for (const change of changes) {
        const { rows: [row] } = await client.query(
            'SELECT * FROM proposal WHERE id = $1',
            [change.dbId]
        );
        if (!row || row.proposal_id !== change.newProposalId) throw new Error(`Identity verification failed for #${change.dbId}`);
        if (globalThis.stableStringify(row.road_proposal) !== globalThis.stableStringify(row.proposal_data?.roadProposal)) {
            throw new Error(`Road geometry copies diverged for #${change.dbId}`);
        }
        if (globalThis.stableStringify(row.ancestor_parcel_ids) !== globalThis.stableStringify(row.cadastre_parcel_ids)) {
            throw new Error(`Cadastral parent copies diverged for #${change.dbId}`);
        }
        const serialized = serializeProposalRow(row);
        if (sharingApi.proposalContentFingerprint(serialized) !== row.proposal_id) {
            throw new Error(`Content fingerprint verification failed for #${change.dbId}`);
        }
        if (ownershipFlowApi.effectFingerprintOf(serialized) !== serialized.effectHash) {
            throw new Error(`Effect fingerprint verification failed for #${change.dbId}`);
        }
    }
    if (retired.length) {
        const { rows } = await client.query(
            'SELECT id, lifecycle_status, applied FROM proposal WHERE id = ANY($1::int[])',
            [retired.map(entry => entry.dbId)]
        );
        if (rows.some(row => row.lifecycle_status !== 'Cancelled' || row.applied !== false)) {
            throw new Error('Retired proposal verification failed');
        }
    }
}

export async function run(argv = process.argv.slice(2)) {
    const args = parseArgs(argv);
    if (args.help) { usage(); return 0; }
    assertLocalDatabaseConfig();

    const pool = new Pool({
        host: process.env.PGHOST,
        port: Number(process.env.PGPORT) || 5432,
        user: process.env.PGUSER,
        password: process.env.PGPASSWORD,
        database: process.env.PGDATABASE
    });
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { rows: [db] } = await client.query(
            'SELECT current_database() AS name, inet_server_addr()::text AS address'
        );
        console.log(`database: ${db.name} (${db.address})   mode: ${args.apply ? 'APPLY' : 'DRY RUN'}`);

        const { rows: [plan] } = await client.query(
            `SELECT proposal_ids FROM ens_plan WHERE slug = $1${args.apply ? ' FOR UPDATE' : ''}`,
            [PLAN_SLUG]
        );
        if (!plan) throw new Error(`Named plan '${PLAN_SLUG}' was not found`);
        const planIds = plan.proposal_ids.map(value => Number(value)).filter(Number.isFinite);
        const { rows } = await client.query(
            `SELECT p.*
             FROM unnest($1::int[]) WITH ORDINALITY wanted(id, ord)
             JOIN proposal p ON p.id = wanted.id
             ORDER BY wanted.ord`,
            [planIds]
        );
        if (rows.length !== planIds.length) throw new Error(`Plan resolves ${rows.length}/${planIds.length} proposal rows`);

        // Rail corridors obey different graph rules: a project track can legitimately enter and
        // leave the plan window without joining the street graph. This migration is strictly the
        // authored street network, so tracks remain untouched and in the named plan.
        const roadEntries = rows.filter(row => {
            const definition = row.road_proposal?.definition;
            return definition && definition.metadata?.isTrack !== true;
        }).map(definitionEntry);
        const originalSignatures = new Map(roadEntries.map(entry => [entry.dbId, definitionSignature(entry)]));
        const explicitRetired = roadEntries.filter(entry => EXPLICIT_DISCONNECTED_PROPOSAL_IDS.has(entry.proposalId));
        const repairEntries = roadEntries.filter(entry => !EXPLICIT_DISCONNECTED_PROPOSAL_IDS.has(entry.proposalId));
        console.log(`plan: ${planIds.length} proposal(s), ${roadEntries.length} corridor record(s)`);
        console.log(`explicitly disconnected records to retire: ${explicitRetired.length}`);
        explicitRetired.forEach(entry => console.log(`  #${entry.dbId} ${entry.title} (${entry.proposalId})`));

        describeAudit('Before controlled repair', auditRoadNetwork(repairEntries, { microEdgeMeters: MICRO_EDGE_METERS }));
        const repair = repairRoadNetwork(repairEntries, {
            microEdgeMeters: MICRO_EDGE_METERS,
            snapToleranceMeters: SNAP_TOLERANCE_METERS,
            pruneDangling: true
        });
        describeRepair(repair);
        describeAudit('After controlled repair', repair.audit);

        if (repair.audit.dangling.length) throw new Error('Repair still leaves dangling road endpoints');
        if (repair.audit.microEdges.length) throw new Error('Repair still leaves sub-metre road edges');
        if (repair.audit.components.length !== 1) {
            throw new Error(`Repair leaves ${repair.audit.components.length} road components; refusing to guess which to remove`);
        }
        if (repair.audit.duplicateEdgeCount) throw new Error('Repair created duplicate road edges');

        const prunedEmpty = repairEntries.filter(entry => !entry.segments.length);
        const retiredById = new Map([...explicitRetired, ...prunedEmpty].map(entry => [entry.dbId, entry]));
        const retired = [...retiredById.values()];
        const changedEntries = repairEntries.filter(entry =>
            entry.segments.length && definitionSignature(entry) !== originalSignatures.get(entry.dbId)
        );

        const migrationAt = new Date().toISOString();
        const changes = [];
        const physicalProposalIds = new Set([
            ...repair.collapsedJunctions.flatMap(item => item.proposalIds),
            ...repair.snaps.map(item => item.proposalId).filter(Boolean),
            ...repair.removedSegments.map(item => item.proposalId).filter(Boolean)
        ]);
        for (const entry of changedEntries) {
            changes.push(await prepareChangedProposal(client, entry, migrationAt, {
                rebuildPhysicalEffect: physicalProposalIds.has(entry.proposalId)
            }));
        }
        await assertNoExternalContentIdReferences(client, changes);
        await assertRetirementsArePlanLocal(client, retired);

        console.log(`\nProposal records changed: ${changes.length}`);
        changes.forEach(change => {
            const before = new Set(change.oldParents);
            const after = new Set(change.cadastreParcelIds);
            const added = [...after].filter(id => !before.has(id));
            const removed = [...before].filter(id => !after.has(id));
            console.log(`  #${change.dbId} ${change.title}`);
            console.log(`     ${change.oldProposalId} -> ${change.newProposalId}`);
            console.log(`     ${change.rebuiltPhysicalEffect ? 'physical geometry' : 'topology only'}; `
                + `centreline shift ${change.centerlineShiftM.toFixed(3)}m; `
                + `footprint Δ ${change.footprintDiff.symmetricDifferenceM2.toFixed(2)}m² `
                + `(${(change.footprintDiff.fraction * 100).toFixed(3)}%); parents +${added.length}/-${removed.length}`);
            if (added.length) console.log(`       added: ${added.join(', ')}`);
            if (removed.length) console.log(`       removed: ${removed.join(', ')}`);
        });
        console.log(`Proposal records retired from plan: ${retired.length}`);
        retired.forEach(entry => console.log(`  #${entry.dbId} ${entry.title} (${entry.proposalId})`));

        const retiredIds = new Set(retired.map(entry => entry.dbId));
        const nextPlanIds = plan.proposal_ids.filter(value => !retiredIds.has(Number(value)));
        console.log(`Named plan membership: ${plan.proposal_ids.length} -> ${nextPlanIds.length}`);

        if (!args.apply) {
            await client.query('ROLLBACK');
            console.log('\nDry run complete; no data written. Re-run with --apply to commit this exact repair.');
            return 0;
        }

        for (const change of changes) await updateProposal(client, change);
        for (const entry of retired) await retireProposal(client, entry, migrationAt);
        await client.query(
            'UPDATE ens_plan SET proposal_ids = $1::jsonb, updated_at = NOW() WHERE slug = $2',
            [JSON.stringify(nextPlanIds), PLAN_SLUG]
        );
        await verifyWrittenState(client, nextPlanIds, changes, retired);
        await client.query('COMMIT');
        console.log(`\nCommitted and verified: ${changes.length} corrected, ${retired.length} retired, `
            + `${nextPlanIds.length} proposals remain in ${PLAN_SLUG}.`);
        return 0;
    } catch (error) {
        try { await client.query('ROLLBACK'); } catch (_) { }
        throw error;
    } finally {
        client.release();
        await pool.end();
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run().then(code => { process.exitCode = code; }).catch(error => {
        console.error(`FAILED: ${error.message}`);
        process.exitCode = 1;
    });
}
