// Groups the nodes the deterministic builder could not solve (degree > 2) into junctions — the unit
// an LLM run actually solves, and the unit a solution should be stored and versioned against.
//
// Nodes are fused by NETWORK adjacency, never by map distance: two nodes join only when a road link
// short enough to be part of the intersection runs between them. Distance alone cannot tell a
// dual-carriageway crossing (two nodes, 30 m of median between them — one junction) from two
// separate intersections that merely pass close by with no road joining them.
//
// The bias is deliberately toward fusing. Splitting one real intersection is corrupting: a movement
// crossing the boundary cannot be expressed, and each half gets solved without the other's arms.
// Fusing two is merely coarse — still solvable, just a bigger crop and a coarser accept/reject unit.
(function (root, factory) {
    const api = factory(root || {});
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.LaneTopologyJunctions = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';

    // A median link, slip lane or staggered crossing is shorter than this; a short city block is not.
    const DEFAULT_MAX_LINK_LENGTH_M = 40;
    // Degree is incident section-endpoints. The builder solves degree 2 deterministically and emits
    // unresolved_intersection above it, so anything over 2 is exactly the work an LLM has to do.
    const MIN_JUNCTION_DEGREE = 3;
    const OSM_NODE_PREFIX = 'osm-node:';

    let graphApi = null;
    function graphModule() {
        if (graphApi) return graphApi;
        graphApi = (root && root.LaneTopologyGraph)
            || (typeof require === 'function' ? require('./lane-topology-graph.js') : null);
        if (!graphApi) throw new Error('LaneTopologyJunctions requires lane-topology-graph.js to be loaded first.');
        return graphApi;
    }

    function metersBetween(a, b) {
        if (!Array.isArray(a) || !Array.isArray(b)) return Number.POSITIVE_INFINITY;
        return graphModule().lineLengthMeters([a, b]);
    }

    function osmNodeIdOf(nodeId) {
        return String(nodeId).startsWith(OSM_NODE_PREFIX)
            ? String(nodeId).slice(OSM_NODE_PREFIX.length)
            : null;
    }

    // Way and section ids arrive as numeric strings, where a plain sort puts '1000' before '999'.
    function byNaturalId(a, b) {
        return String(a).localeCompare(String(b), undefined, { numeric: true });
    }

    function createUnionFind(ids) {
        const parent = new Map(ids.map(id => [id, id]));
        function find(id) {
            let current = id;
            while (parent.get(current) !== current) current = parent.get(current);
            let walk = id;
            while (parent.get(walk) !== walk) {
                const next = parent.get(walk);
                parent.set(walk, current);
                walk = next;
            }
            return current;
        }
        return {
            find,
            union(a, b) {
                const rootA = find(a);
                const rootB = find(b);
                if (rootA !== rootB) parent.set(rootA, rootB);
            }
        };
    }

    // node id -> [{ nodeId, lengthM }], one entry per incident atomic section.
    function buildAdjacency(sections) {
        const adjacency = new Map();
        const link = (from, to, lengthM) => {
            if (!adjacency.has(from)) adjacency.set(from, []);
            adjacency.get(from).push({ nodeId: to, lengthM });
        };
        sections.forEach(section => {
            if (!section || section.startNode === section.endNode) return;
            const lengthM = Number(section.lengthM);
            const usable = Number.isFinite(lengthM) ? lengthM : Number.POSITIVE_INFINITY;
            link(section.startNode, section.endNode, usable);
            link(section.endNode, section.startNode, usable);
        });
        return adjacency;
    }

    // Shortest network path from a seed to every other seed reachable without passing through a
    // third seed, bounded by maxLinkLengthM. Walking through the non-seed nodes in between is what
    // makes a link split by a mid-block tag change behave like the single link it physically is.
    function fuseSeeds(seedIds, adjacency, nodesById, maxLinkLengthM) {
        const seeds = new Set(seedIds);
        const unionFind = createUnionFind(seedIds);
        seedIds.forEach(seedId => {
            const best = new Map([[seedId, 0]]);
            const queue = [{ nodeId: seedId, distanceM: 0 }];
            while (queue.length) {
                queue.sort((a, b) => a.distanceM - b.distanceM);
                const { nodeId, distanceM } = queue.shift();
                if (distanceM > (best.get(nodeId) ?? Number.POSITIVE_INFINITY)) continue;
                (adjacency.get(nodeId) || []).forEach(edge => {
                    const nextDistance = distanceM + edge.lengthM;
                    if (nextDistance > maxLinkLengthM) return;
                    if (nextDistance >= (best.get(edge.nodeId) ?? Number.POSITIVE_INFINITY)) return;
                    best.set(edge.nodeId, nextDistance);
                    if (seeds.has(edge.nodeId)) {
                        unionFind.union(seedId, edge.nodeId);
                        return; // Never traverse THROUGH another junction.
                    }
                    // Only a plain pass-through node continues the walk; a dead end ends it.
                    if ((nodesById.get(edge.nodeId)?.degree || 0) === 2) {
                        queue.push({ nodeId: edge.nodeId, distanceM: nextDistance });
                    }
                });
            }
        });
        return unionFind;
    }

    function junctionName(armSections, osmNodeIds, nodeIds) {
        const names = [...new Set(armSections.map(section => section?.name).filter(Boolean))].sort();
        if (names.length > 1) return names.join(' × ');
        if (names.length === 1) return names[0];
        return `Junction ${osmNodeIds[0] || nodeIds[0]}`;
    }

    function junctionGeometry(memberNodes) {
        const points = memberNodes.map(node => node.point).filter(point => Array.isArray(point));
        if (!points.length) return { point: null, bbox: null, spanM: 0 };
        const lngs = points.map(point => Number(point[0]));
        const lats = points.map(point => Number(point[1]));
        const bbox = [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)];
        return {
            point: [
                lngs.reduce((sum, value) => sum + value, 0) / lngs.length,
                lats.reduce((sum, value) => sum + value, 0) / lats.length
            ],
            bbox,
            // Diagonal of the member nodes, so a caller can refuse a crop that would blow the GSD budget.
            spanM: metersBetween([bbox[0], bbox[1]], [bbox[2], bbox[3]])
        };
    }

    // { junctions: [...], stats } — junctions are proposals. Membership is meant to be stored and
    // corrected; solved work stays keyed to stable node ids so regrouping re-scopes it, never destroys it.
    function deriveJunctions(graph, options) {
        const maxLinkLengthM = Number.isFinite(Number(options?.maxLinkLengthM))
            ? Number(options.maxLinkLengthM)
            : DEFAULT_MAX_LINK_LENGTH_M;
        const minDegree = Number.isFinite(Number(options?.minDegree))
            ? Number(options.minDegree)
            : MIN_JUNCTION_DEGREE;

        const sections = Array.isArray(graph?.sections) ? graph.sections : [];
        const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
        const nodesById = new Map(nodes.map(node => [node.id, node]));
        const seedIds = nodes.filter(node => (node.degree || 0) >= minDegree).map(node => node.id);
        if (!seedIds.length) {
            return { junctions: [], stats: { seedNodes: 0, junctions: 0, fused: 0, maxSpanM: 0, maxLinkLengthM } };
        }

        const unionFind = fuseSeeds(seedIds, buildAdjacency(sections), nodesById, maxLinkLengthM);
        const components = new Map();
        seedIds.forEach(seedId => {
            const key = unionFind.find(seedId);
            if (!components.has(key)) components.set(key, []);
            components.get(key).push(seedId);
        });

        const junctions = [...components.values()].map(memberIds => {
            const nodeIds = [...memberIds].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
            const members = new Set(nodeIds);
            const memberNodes = nodeIds.map(id => nodesById.get(id)).filter(Boolean);
            const arms = [];
            const internal = [];
            sections.forEach(section => {
                const startInside = members.has(section.startNode);
                const endInside = members.has(section.endNode);
                if (startInside && endInside) internal.push(section);
                else if (startInside || endInside) arms.push(section);
            });
            const osmNodeIds = nodeIds.map(osmNodeIdOf).filter(Boolean);
            const geometry = junctionGeometry(memberNodes);
            return {
                key: `junction:${(osmNodeIds.length ? osmNodeIds : nodeIds).join('+')}`,
                name: junctionName(arms, osmNodeIds, nodeIds),
                nodeIds,
                osmNodeIds,
                // A junction whose nodes lack OSM ids cannot be matched across snapshots.
                stableIdentity: osmNodeIds.length === nodeIds.length,
                armSectionIds: arms.map(section => section.id).sort(byNaturalId),
                internalSectionIds: internal.map(section => section.id).sort(byNaturalId),
                armCount: arms.length,
                sourceWayIds: [...new Set(
                    [...arms, ...internal].map(section => section.sourceWayId).filter(value => value != null)
                )].sort(byNaturalId),
                ...geometry
            };
        }).sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));

        return {
            junctions,
            stats: {
                seedNodes: seedIds.length,
                junctions: junctions.length,
                fused: junctions.filter(junction => junction.nodeIds.length > 1).length,
                maxSpanM: junctions.reduce((max, junction) => Math.max(max, junction.spanM || 0), 0),
                maxLinkLengthM
            }
        };
    }

    return {
        DEFAULT_MAX_LINK_LENGTH_M,
        MIN_JUNCTION_DEGREE,
        deriveJunctions,
        osmNodeIdOf
    };
});
