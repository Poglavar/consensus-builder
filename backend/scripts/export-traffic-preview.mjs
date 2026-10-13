#!/usr/bin/env node
// Exports a read-only traffic preview from the shared OSM API and saved topology solutions.
// Uses the topology checkout's canonical builder and validation; never submits jobs or writes DB rows.
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import dotenv from 'dotenv';
import pg from 'pg';
import { mergeSavedJunctions, publicCarLane } from './lib/traffic-snapshot.mjs';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
if (!args.get('--topology-root')) throw new Error('Pass --topology-root with the checkout containing the saved-junction pipeline.');
const root = resolve(args.get('--topology-root'));
const require = createRequire(import.meta.url);
const load = name => require(resolve(root, 'frontend/js', name));
const Graph = load('lane-topology-graph.js');
const View = load('lane-topology-view.js');
const Restrictions = load('lane-topology-restrictions.js');
const Profile = load('corridor-profile.js');
const OsmProfile = load('osm-profile.js');
const { isUnsafeComparedWithParent, nodesWithMissingIncomingAssignments } = await import(
    pathToFileURL(resolve(root, 'backend/scripts/lib/stored-solutions.js'))
);
const bbox = (args.get('--bbox') || '15.946,45.792,15.990,45.816').split(',').map(Number);
if (bbox.length !== 4 || !bbox.every(Number.isFinite) || bbox[0] >= bbox[2] || bbox[1] >= bbox[3]) {
    throw new Error('Invalid --bbox; expected west,south,east,north.');
}
const city = args.get('--city') || 'zagreb';
const api = (args.get('--roads-api') || 'http://localhost:3001/api').replace(/\/$/, '');
const output = resolve(args.get('--output') || fileURLToPath(new URL('../../frontend/traffic/data/central.json.gz', import.meta.url)));
dotenv.config({ path: resolve(root, 'backend/.env'), quiet: true });
const pool = new pg.Pool({
    host: process.env.PGHOST === 'db' ? 'localhost' : process.env.PGHOST,
    port: Number(process.env.PGPORT) || 5432, user: process.env.PGUSER,
    password: process.env.PGPASSWORD, database: process.env.PGDATABASE,
    connectionTimeoutMillis: 10000, statement_timeout: 60000,
    options: '-c default_transaction_read_only=on'
});
try {
    const response = await fetch(`${api}/roads/topology?city=${encodeURIComponent(city)}&bbox=${bbox}`, {
        signal: AbortSignal.timeout(60000)
    });
    if (!response.ok) throw new Error(`OSM API: HTTP ${response.status}`);
    const evidence = await response.json();
    if (evidence.truncated || !evidence.snapshot || !evidence.features?.length) {
        throw new Error('The OSM snapshot is missing or truncated; choose a smaller area.');
    }
    const decisionRows = (await pool.query(`SELECT decision_key, node_key, assignment
        FROM lane_topology_decision WHERE city=$1 AND superseded_at IS NULL
        AND point && ST_MakeEnvelope($2,$3,$4,$5,4326)`, [city, ...bbox])).rows;
    const base = Graph.build(evidence, {
        snapshotAt: evidence.snapshot.sourceTimestamp, restrictions: evidence.restrictions,
        profileFromTags: Profile.corridorProfileFromOsmTags,
        orientProfile: OsmProfile.orientForRightHandTraffic,
        decisions: decisionRows.map(row => ({ decisionKey: row.decision_key, nodeKey: row.node_key, assignment: row.assignment }))
    });
    const select = `SELECT s.id, s.parent_id, s.source_kind, s.status, s.created_at, s.graph, s.stats,
        ARRAY(SELECT p.problem_key FROM lane_topology_problem p
            WHERE p.solution_id=s.id AND p.severity='error') AS error_keys
        FROM lane_topology_solution s`;
    const selected = (await pool.query(`${select} WHERE s.city=$1 AND s.source_kind<>'deterministic'
        AND s.status IN ('candidate','canonical') AND s.coverage && ST_MakeEnvelope($2,$3,$4,$5,4326)`, [city, ...bbox])).rows;
    const parents = [...new Set(selected.map(row => row.parent_id).filter(Boolean))];
    const parentRows = parents.length ? (await pool.query(`${select} WHERE s.id=ANY($1::bigint[])`, [parents])).rows : [];
    const solutions = [...new Map([...parentRows, ...selected].map(row => [String(row.id), row])).values()]
        .map(row => ({ id: row.id, parentId: row.parent_id, sourceKind: row.source_kind,
            status: row.status, createdAt: row.created_at.toISOString(), graph: row.graph,
            stats: row.stats, errorProblemKeys: row.error_keys }));
    const merged = mergeSavedJunctions(base, solutions, {
        isUnsafe: isUnsafeComparedWithParent, missingNodes: nodesWithMissingIncomingAssignments
    });
    const restrictions = Restrictions.checkConnections(merged, evidence.restrictions);
    const forbidden = new Set(restrictions.problems.flatMap(problem => problem.connectionIds || []));
    // Via-way and conditional restrictions cannot be represented by this memoryless lane graph.
    // Block their incoming ways conservatively instead of letting the preview violate them.
    const unusableIds = new Set(restrictions.stats.unusable.map(rule => String(rule.osmId)));
    const unsupportedWays = new Set((evidence.restrictions || []).filter(rule => unusableIds.has(String(rule.osm_id)))
        .flatMap(rule => (rule.members || []).filter(member => member.type === 'way' && member.role === 'from').map(member => String(member.ref))));
    const display = View.buildDisplayGraph(merged);
    const sections = new Map(merged.sections.map(section => [section.id, section]));
    const inBounds = point => point[0] >= bbox[0] && point[0] <= bbox[2] && point[1] >= bbox[1] && point[1] <= bbox[3];
    const lanes = display.lanes.filter(lane => publicCarLane(lane)
        && !unsupportedWays.has(String(lane.sourceWayId)) && lane.geometry.coordinates.every(inBounds));
    const laneIds = new Set(lanes.map(lane => lane.id));
    const connections = display.connections.filter(connection => laneIds.has(connection.fromLaneId)
        && laneIds.has(connection.toLaneId) && !forbidden.has(connection.id)
        && (!Array.isArray(connection.allowedModes) || connection.allowedModes.some(mode => ['car', 'motorcar', 'motor_vehicle', 'vehicle'].includes(mode))));
    const index = View.createIndex({ ...display, lanes, connections });
    const nodeIds = new Set(lanes.flatMap(lane => [lane.fromNode, lane.toNode]));
    const usedSavedNodes = new Set(connections.filter(connection => connection.savedSolutionId).map(connection => connection.nodeId));
    const junctionIds = new Set(display.nodes.filter(node => node.degree >= 3).map(node => node.id));
    const unresolved = new Set(merged.problems.filter(problem => problem.type === 'unresolved_intersection')
        .flatMap(problem => problem.nodeIds || []));
    const data = {
        schemaVersion: 1, city, bbox,
        source: {
            osmTimestamp: evidence.snapshot.sourceTimestamp, osmSha256: evidence.snapshot.sourceSha256,
            exportedAt: new Date().toISOString(), selectedSolutions: selected.length,
            savedJunctions: merged.savedJunctions.filter(item => usedSavedNodes.has(item.nodeId) && junctionIds.has(item.nodeId)),
            liveDecisions: decisionRows.length, blockedRestrictions: forbidden.size,
            unsupportedRestrictionWays: unsupportedWays.size,
            note: 'OSM and saved candidate junction answers; illustrative traffic and signal timings.'
        },
        nodes: display.nodes.filter(node => nodeIds.has(node.id)).map(node => ({
            id: node.id, point: node.point, degree: node.degree, unresolved: unresolved.has(node.id)
        })),
        lanes: lanes.map(lane => {
            const section = sections.get(lane.sectionId);
            const speed = Number.parseFloat(section?.tags?.maxspeed);
            return {
                id: lane.id, sectionId: lane.sectionId, sourceWayId: lane.sourceWayId,
                fromNode: lane.fromNode, toNode: lane.toNode, direction: lane.direction,
                ordinal: lane.travelOrdinal ?? lane.ordinal, stripIndex: lane.stripIndex,
                change: lane.change || section?.tags?.[`change:${lane.direction}`] || section?.tags?.change || null,
                turn: lane.turn, width: lane.width, name: section?.tags?.name || '',
                highway: section?.tags?.highway || '', maxSpeed: Number.isFinite(speed) ? speed : null,
                points: lane.geometry.coordinates
            };
        }),
        connections: connections.map(connection => ({
            id: connection.id, fromLaneId: connection.fromLaneId, toLaneId: connection.toLaneId,
            nodeId: connection.nodeId, type: connection.type,
            source: connection.savedSource || connection.source || 'deterministic',
            solutionId: connection.savedSolutionId || null,
            points: View.connectionCurve(connection, index, 20)
        }))
    };
    if (!data.lanes.length || !data.connections.length) throw new Error('No usable car network in the selected area.');
    await mkdir(dirname(output), { recursive: true });
    const json = JSON.stringify(data, (_key, value) => typeof value === 'number' ? Math.round(value * 1e7) / 1e7 : value) + '\n';
    await writeFile(output, gzipSync(json));
    console.log(JSON.stringify({ lanes: data.lanes.length, connections: data.connections.length,
        savedJunctions: data.source.savedJunctions.length, unresolvedNodes: data.nodes.filter(node => node.unresolved).length,
        restrictionChecks: restrictions.stats }, null, 2));
} finally { await pool.end(); }
