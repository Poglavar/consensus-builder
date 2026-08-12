#!/usr/bin/env node
// Ranks the junctions the deterministic rules could not settle, hardest first, as a worklist.
//
// Complexity is the DECISION SURFACE, not the arm count: the number of candidate lane-to-lane
// movements at the junction's unresolved nodes, which is literally how many calls a person has to
// make there. A 4-arm crossing of two three-lane avenues is more work than an 8-arm cluster of
// driveways, and sorting by arms alone puts them the wrong way round.
//
//   node backend/scripts/junction-worklist.js --top 40
//   node backend/scripts/junction-worklist.js --center 45.8035,15.9905 --radius 3000 --format md
//
// The list shrinks as junctions get solved, so re-run it rather than working from an old copy.
import { createRequire } from 'node:module';
import { enumerationTiles, insideCore } from './lib/city-tiles.js';
import { settledNodeIndex } from './lib/stored-solutions.js';

const require = createRequire(import.meta.url);
const LaneTopologyJunctions = require('../../frontend/js/lane-topology-junctions.js');
const LaneTopologyGraph = require('../../frontend/js/lane-topology-graph.js');
const CorridorProfile = require('../../frontend/js/corridor-profile.js');
const OsmProfile = require('../../frontend/js/osm-profile.js');

const DEFAULTS = {
    api: 'http://localhost:4913',
    viewer: 'http://localhost:5913/topology/',
    city: 'zagreb',
    top: 40,
    format: 'table'
};
// Whole Zagreb snapshot.
const CITY_BBOX = [15.5459, 45.5136, 16.3620, 46.0356];

const USAGE = `
Rank unresolved junctions by how much deciding they need.

  --bbox W,S,E,N     Area to rank (default: the whole Zagreb snapshot).
  --center LAT,LNG   Alternative to --bbox, with --radius.
  --radius M         Half-size of the --center box in metres (default 3000).
  --top N            How many to list (default ${DEFAULTS.top}; 0 for all).
  --format table|md|json
  --api URL          Lane-topology API (default ${DEFAULTS.api}).
  --viewer URL       Topology viewer, for the per-junction links (default ${DEFAULTS.viewer}).
  --city NAME        City key (default ${DEFAULTS.city}).
`;

function parseArgs(argv) {
    const args = { ...DEFAULTS, radiusM: 3000 };
    for (let index = 0; index < argv.length; index += 1) {
        const value = argv[index + 1];
        const take = () => { index += 1; return value; };
        switch (argv[index]) {
            case '--bbox': args.bbox = take().split(',').map(Number); break;
            case '--center': args.center = take().split(',').map(Number); break;
            case '--radius': args.radiusM = Number(take()); break;
            case '--top': args.top = Number(take()); break;
            case '--format': args.format = take(); break;
            case '--api': args.api = take().replace(/\/+$/, ''); break;
            case '--viewer': args.viewer = take(); break;
            case '--city': args.city = take(); break;
            case '--help': case '-h': args.help = true; break;
            default: throw new Error(`Unknown argument "${argv[index]}".`);
        }
    }
    return args;
}

function centerBbox([lat, lng], radiusM) {
    const dLat = radiusM / 111_320;
    const dLng = radiusM / (111_320 * Math.max(0.1, Math.cos(lat * Math.PI / 180)));
    return [lng - dLng, lat - dLat, lng + dLng, lat + dLat];
}

// Candidate movements still open at one node: every lane of a still-open approach against every arm
// it could leave by. Approaches the rules already settled are not work and must not inflate the
// ranking — counting them put junctions above others by a margin that was already decided.
// An empty openApproaches means the whole node is open.
function decisionSurface(node, graph, open) {
    const lanes = graph.lanes.filter(lane => lane.fromNode === node.id || lane.toNode === node.id);
    const openSections = open && open.length ? new Set(open.map(entry => entry.sectionId)) : null;
    const incoming = lanes.filter(lane => lane.toNode === node.id
        && (!openSections || openSections.has(lane.sectionId)));
    const exitArms = new Set(lanes.filter(lane => lane.fromNode === node.id).map(lane => lane.sectionId));
    return incoming.reduce((total, lane) => total + Math.max(0, exitArms.size - (
        // Its own arm is not an exit for it: that would be the U-turn.
        exitArms.has(lane.sectionId) ? 1 : 0
    )), 0);
}

async function rank(args) {
    const found = new Map();
    // Nodes a stored decision already closed are not work, however the rules see them.
    const stored = await settledNodeIndex({
        api: args.api, city: args.city, bbox: args.bbox,
        log: message => process.stderr.write(`  ${message}\n`)
    });
    if (stored.settled.size) {
        process.stderr.write(`  ${stored.settled.size} nodes already settled by `
            + `${stored.consulted} stored solutions\n`);
    }
    const list = enumerationTiles(args.bbox);
    for (const [index, tile] of list.entries()) {
        const url = `${args.api}/lane-topology/osm?bbox=${tile.build.join(',')}`
            + `&city=${encodeURIComponent(args.city)}`;
        const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
        if (!response.ok) throw new Error(`GET ${url} → ${response.status}`);
        const evidence = await response.json();
        const graph = LaneTopologyGraph.build(evidence, {
            snapshotAt: evidence.snapshotAt,
            restrictions: evidence.restrictions,
            profileFromTags: CorridorProfile.corridorProfileFromOsmTags,
            orientProfile: OsmProfile.orientForRightHandTraffic
        });
        const nodesById = new Map(graph.nodes.map(node => [node.id, node]));
        const problemOf = new Map(graph.problems
            .filter(problem => problem.type === 'unresolved_intersection')
            .flatMap(problem => (problem.nodeIds || []).map(id => [id, problem])));
        const { junctions } = LaneTopologyJunctions.deriveJunctions(graph);
        junctions
            .filter(junction => !junction.resolved && insideCore(junction.point, tile.core))
            .forEach(junction => {
                if (found.has(junction.key)) return;
                const unresolved = junction.unresolvedNodeIds
                    .filter(id => !stored.settled.has(id))
                    .map(id => nodesById.get(id))
                    .filter(Boolean);
                // Every open node of this junction has since been answered and stored.
                if (!unresolved.length) return;
                found.set(junction.key, {
                    name: junction.name,
                    arms: junction.armCount,
                    unresolvedNodes: unresolved.length,
                    openApproaches: unresolved.reduce((total, node) => total
                        + (problemOf.get(node.id)?.openApproaches?.length
                            || new Set(graph.lanes.filter(lane => lane.toNode === node.id)
                                .map(lane => lane.sectionId)).size), 0),
                    movements: unresolved.reduce((total, node) => total
                        + decisionSurface(node, graph, problemOf.get(node.id)?.openApproaches), 0),
                    why: [...new Set(junction.unresolvedNodeIds
                        .map(id => problemOf.get(id)?.declineReason).filter(Boolean))],
                    point: junction.point,
                    bbox: junction.bbox
                });
            });
        if ((index + 1) % 250 === 0) {
            process.stderr.write(`  … ${index + 1}/${list.length} tiles, ${found.size} unresolved junctions\n`);
        }
    }
    return [...found.values()].sort((a, b) => (b.movements - a.movements)
        || (b.arms - a.arms)
        || a.name.localeCompare(b.name));
}

function link(args, junction) {
    return `${args.viewer}?backend=${encodeURIComponent(args.api)}`
        + `&lat=${junction.point[1].toFixed(5)}&lng=${junction.point[0].toFixed(5)}&zoom=19`;
}

function report(args, ranked) {
    const shown = args.top > 0 ? ranked.slice(0, args.top) : ranked;
    if (args.format === 'json') {
        console.log(JSON.stringify(shown.map(junction => ({ ...junction, url: link(args, junction) })), null, 1));
        return;
    }
    if (args.format === 'md') {
        console.log('| # | movements | arms | nodes | approaches | junction | why | open |');
        console.log('|--:|--:|--:|--:|--:|---|---|---|');
        shown.forEach((junction, index) => {
            console.log(`| ${index + 1} | ${junction.movements} | ${junction.arms} | ${junction.unresolvedNodes} `
                + `| ${junction.openApproaches} | ${junction.name} | ${junction.why.join(', ')} `
                + `| [open](${link(args, junction)}) |`);
        });
        return;
    }
    shown.forEach((junction, index) => {
        console.log(`${String(index + 1).padStart(3)}. ${String(junction.movements).padStart(4)} movements `
            + `· ${String(junction.arms).padStart(2)} arms · ${junction.unresolvedNodes} unresolved nodes `
            + `· ${junction.openApproaches} open approaches · ${junction.name}`);
        console.log(`     ${junction.why.join(', ')}`);
        console.log(`     ${link(args, junction)}`);
    });
    console.log(`\n${ranked.length} unresolved junctions in the area; `
        + `${ranked.reduce((total, junction) => total + junction.movements, 0)} movements to decide in all.`);
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        console.log(USAGE);
        return 0;
    }
    args.bbox = args.bbox || (args.center ? centerBbox(args.center, args.radiusM) : CITY_BBOX);
    report(args, await rank(args));
    return 0;
}

main().then(code => process.exit(code)).catch(error => {
    console.error(`fatal: ${error.message}`);
    process.exit(1);
});
