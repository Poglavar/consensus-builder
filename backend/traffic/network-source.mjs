// Read-only traffic network loader shared by the traffic API and export tooling.
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mapTrafficSignals, mergeSavedJunctions, publicCarLane } from '../scripts/lib/traffic-snapshot.mjs';

export const DEFAULT_BBOX = Object.freeze([15.946, 45.792, 15.990, 45.816]);

const TRAFFIC_MODES = new Set(['car', 'motorcar', 'motor_vehicle', 'vehicle']);

function validateBbox(bbox) {
    if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every(Number.isFinite)
        || bbox[0] >= bbox[2] || bbox[1] >= bbox[3]) {
        throw new Error('Invalid bbox; expected [west, south, east, north].');
    }
    return [...bbox];
}

function isoDate(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) throw new Error('Invalid timestamp returned by now().');
    return date.toISOString();
}

export async function loadTrafficNetwork({
    pool,
    topologyRoot,
    roadsApi,
    bbox = DEFAULT_BBOX,
    city = 'zagreb',
    fetchImpl = fetch,
    now = () => new Date()
} = {}) {
    if (!pool || typeof pool.query !== 'function') throw new Error('Pass a database pool with query().');
    if (!topologyRoot) throw new Error('Pass topologyRoot with the saved-junction pipeline checkout.');
    if (!roadsApi) throw new Error('Pass roadsApi for the OSM roads topology endpoint.');
    if (typeof fetchImpl !== 'function') throw new Error('fetchImpl must be a function.');

    const root = resolve(topologyRoot);
    const require = createRequire(import.meta.url);
    const Trams = require('../../frontend/traffic/tram-tracks.js');
    const load = name => require(resolve(root, 'frontend/js', name));
    const Graph = load('lane-topology-graph.js');
    const View = load('lane-topology-view.js');
    const Restrictions = load('lane-topology-restrictions.js');
    const Profile = load('corridor-profile.js');
    const OsmProfile = load('osm-profile.js');
    const { isUnsafeComparedWithParent, nodesWithMissingIncomingAssignments } = await import(
        pathToFileURL(resolve(root, 'backend/scripts/lib/stored-solutions.js'))
    );
    const extent = validateBbox(bbox);
    const api = String(roadsApi).replace(/\/$/, '');
    const response = await fetchImpl(`${api}/roads/topology?city=${encodeURIComponent(city)}&bbox=${extent.join(',')}`, {
        signal: AbortSignal.timeout(60000)
    });
    if (!response.ok) throw new Error(`OSM API: HTTP ${response.status}`);
    const evidence = await response.json();
    if (evidence.truncated || !evidence.snapshot?.id || !evidence.features?.length) {
        throw new Error('The OSM snapshot is missing or truncated; choose a smaller area.');
    }
    const railResponse = await fetchImpl(`${api}/roads/rails?bbox=${extent.join(',')}`, {
        signal: AbortSignal.timeout(60000)
    });
    if (!railResponse.ok) throw new Error(`OSM rails API: HTTP ${railResponse.status}`);
    const tramTracks = Trams.fromGeoJSON(await railResponse.json(), extent);

    const signalRows = (await pool.query(`SELECT n.osm_id, n.tags,
        ST_X(n.geom) AS lon, ST_Y(n.geom) AS lat,
        ARRAY(SELECT DISTINCT m.way_id::text FROM public.osm_topology_way_node m
            WHERE m.snapshot_id=n.snapshot_id AND m.node_id=n.osm_id ORDER BY m.way_id::text) AS way_ids
        FROM public.osm_topology_node n
        WHERE n.snapshot_id=$1 AND n.visible
        AND (n.tags->>'highway'='traffic_signals'
            OR (n.tags->>'highway'='crossing' AND (n.tags->>'crossing'='traffic_signals'
                OR n.tags->>'crossing:signals'='yes')))
        AND n.geom && ST_MakeEnvelope($2,$3,$4,$5,4326)
        ORDER BY n.osm_id`, [evidence.snapshot.id, ...extent])).rows;
    const decisionRows = (await pool.query(`SELECT decision_key, node_key, assignment
        FROM lane_topology_decision WHERE city=$1 AND superseded_at IS NULL
        AND point && ST_MakeEnvelope($2,$3,$4,$5,4326)`, [city, ...extent])).rows;
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
        AND s.status IN ('candidate','canonical') AND s.coverage && ST_MakeEnvelope($2,$3,$4,$5,4326)`, [city, ...extent])).rows;
    const parents = [...new Set(selected.map(row => row.parent_id).filter(Boolean))];
    const parentRows = parents.length
        ? (await pool.query(`${select} WHERE s.id=ANY($1::bigint[])`, [parents])).rows
        : [];
    const solutions = [...new Map([...parentRows, ...selected].map(row => [String(row.id), row])).values()]
        .map(row => ({ id: row.id, parentId: row.parent_id, sourceKind: row.source_kind,
            status: row.status, createdAt: isoDate(row.created_at), graph: row.graph,
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
    const inBounds = point => point[0] >= extent[0] && point[0] <= extent[2]
        && point[1] >= extent[1] && point[1] <= extent[3];
    const bounded = lane => Array.isArray(lane.geometry?.coordinates) && lane.geometry.coordinates.length >= 2
        && lane.geometry.coordinates.every(inBounds);
    const surfaceLanes = display.lanes.filter(lane => ['driving', 'bus'].includes(lane.type) && bounded(lane));
    const lanes = display.lanes.filter(lane => publicCarLane(lane)
        && !unsupportedWays.has(String(lane.sourceWayId)) && bounded(lane));
    const laneIds = new Set(lanes.map(lane => lane.id));
    const connections = display.connections.filter(connection => laneIds.has(connection.fromLaneId)
        && laneIds.has(connection.toLaneId) && !forbidden.has(connection.id)
        && (!Array.isArray(connection.allowedModes) || connection.allowedModes.some(mode => TRAFFIC_MODES.has(mode))));
    if (!lanes.length || !connections.length) throw new Error('No usable car network in the selected area.');
    const index = View.createIndex({ ...display, lanes, connections });
    const nodeIds = new Set(lanes.flatMap(lane => [lane.fromNode, lane.toNode]));
    const usedSavedNodes = new Set(connections.filter(connection => connection.savedSolutionId).map(connection => connection.nodeId));
    const junctionIds = new Set(display.nodes.filter(node => node.degree >= 3).map(node => node.id));
    const unresolved = new Set(merged.problems.filter(problem => problem.type === 'unresolved_intersection')
        .flatMap(problem => problem.nodeIds || []));
    const signals = mapTrafficSignals(signalRows.map(row => ({
        id: `osm-node:${row.osm_id}`, point: [row.lon, row.lat], tags: row.tags, wayIds: row.way_ids
    })), merged.sections, lanes);
    const savedJunctions = merged.savedJunctions.filter(item => usedSavedNodes.has(item.nodeId) && junctionIds.has(item.nodeId));
    const savedPartialJunctions = merged.savedPartialJunctions.map(item => ({ ...item,
        laneIds: item.laneIds.filter(id => connections.some(connection => connection.fromLaneId === id
            && connection.savedSolutionId === item.solutionId))
    })).filter(item => item.laneIds.length);
    const updatedAt = isoDate(now());
    return {
        schemaVersion: 2, city, bbox: extent,
        source: {
            osmSnapshotId: evidence.snapshot.id,
            osmTimestamp: evidence.snapshot.sourceTimestamp, osmSha256: evidence.snapshot.sourceSha256,
            updatedAt, exportedAt: updatedAt, selectedSolutions: selected.length,
            savedJunctions,
            savedPartialJunctions,
            liveDecisions: decisionRows.length, blockedRestrictions: forbidden.size,
            unsupportedRestrictionWays: unsupportedWays.size,
            counts: {
                surfaceLanes: surfaceLanes.length, simulatedLanes: lanes.length,
                tramWays: new Set(tramTracks.map(track => track.sourceWayId)).size,
                tramTrackPaths: tramTracks.reduce((count, track) => count + track.trackCount, 0),
                connections: connections.length, signals: signals.length,
                controlledSignals: signals.filter(signal => signal.controls.length).length,
                savedJunctions: savedJunctions.length,
                partialJunctions: new Set(savedPartialJunctions.map(item => item.nodeId)).size,
                unresolvedNodes: display.nodes.filter(node => nodeIds.has(node.id) && unresolved.has(node.id)).length
            },
            signalSource: 'OSM tagged signal nodes, original coordinates and way memberships in the same snapshot.',
            tramSource: 'OSM tram centerlines from the shared roads/rails API; track counts and gauge from OSM tags.',
            note: 'OSM and saved candidate junction answers; mapped signals with illustrative phase timings.'
        },
        signals,
        tramTracks,
        nodes: display.nodes.filter(node => nodeIds.has(node.id)).map(node => ({
            id: node.id, point: node.point, degree: node.degree, unresolved: unresolved.has(node.id)
        })),
        // Surface traces describe mapped geometry only. They do not enter the car lane index.
        surfaceLanes: surfaceLanes.map(lane => {
            const section = sections.get(lane.sectionId);
            return {
                id: lane.id, sectionId: lane.sectionId, sourceWayId: lane.sourceWayId,
                fromNode: lane.fromNode, toNode: lane.toNode,
                direction: lane.direction, ordinal: lane.travelOrdinal ?? lane.ordinal,
                stripIndex: lane.stripIndex, width: lane.width, access: lane.access ?? null,
                type: lane.type, name: section?.tags?.name || '', highway: section?.tags?.highway || '',
                points: lane.geometry.coordinates
            };
        }),
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
}
