#!/usr/bin/env node
// How much of the city's lane topology is settled, tile by tile.
//
// The worklist answers "what is hardest"; this answers "where is nearly finished". They are
// different questions with different winners: a tile with one monstrous interchange is hard but
// not nearly finished, and a tile with nine junctions and four open approaches is the opposite.
//
// The topology itself is not stored: 91% of it is a pure function of the OSM snapshot plus the
// deterministic rules, so it is derived here on demand. Only decisions that are NOT derivable — a
// model answer, a human adjudication — live in lane_topology_solution, and this consults them, or
// junctions solved days ago would keep counting as work.
//
//   node backend/scripts/topology-coverage.js --format table --top 25
//   node backend/scripts/topology-coverage.js --format json > coverage.json
import { createRequire } from 'node:module';
import { enumerationTiles, insideCore } from './lib/city-tiles.js';
import { settledNodeIndex, listAllSolutions } from './lib/stored-solutions.js';

const require = createRequire(import.meta.url);
const LaneTopologyGraph = require('../../frontend/js/lane-topology-graph.js');
const LaneTopologyJunctions = require('../../frontend/js/lane-topology-junctions.js');
const CorridorProfile = require('../../frontend/js/corridor-profile.js');
const OsmProfile = require('../../frontend/js/osm-profile.js');

const DEFAULTS = {
    api: 'http://localhost:4913',
    viewer: 'http://localhost:5913/topology/',
    city: 'zagreb',
    format: 'table',
    top: 25,
    // Below this a tile is a field with a driveway in it: "100% done" there means nothing.
    minJunctions: 8
};
const CITY_BBOX = [15.5459, 45.5136, 16.3620, 46.0356];
// Mirrors the bulk solver's --min-arms floor and the rules' own `fewer_than_three_arms` decline.
const MIN_JUNCTION_ARMS = 3;

// stderr, not stdout: `--format json > coverage.json` means anything on stdout that is not the
// report corrupts the file.
const note = (message) => console.error(`[${new Date().toISOString()}] ${message}`);

const USAGE = `
Report lane-topology coverage per tile, and which tiles are nearly finished.

  --bbox W,S,E,N     Area to report (default: the whole Zagreb snapshot).
  --format table|json
  --top N            How many nearly-finished tiles to list (default ${DEFAULTS.top}).
  --min-junctions N  Ignore tiles with fewer junctions than this (default ${DEFAULTS.minJunctions}).
  --api URL          Lane-topology API (default ${DEFAULTS.api}).
  --viewer URL       Topology viewer, for the per-tile links.
  --city NAME        City key (default ${DEFAULTS.city}).
`;

function parseArgs(argv) {
    const args = { ...DEFAULTS };
    for (let index = 0; index < argv.length; index += 1) {
        const value = argv[index + 1];
        const take = () => { index += 1; return value; };
        switch (argv[index]) {
            case '--bbox': args.bbox = take().split(',').map(Number); break;
            case '--format': args.format = take(); break;
            case '--top': args.top = Number(take()); break;
            case '--min-junctions': args.minJunctions = Number(take()); break;
            case '--api': args.api = take().replace(/\/+$/, ''); break;
            case '--viewer': args.viewer = take(); break;
            case '--city': args.city = take(); break;
            case '--help': case '-h': args.help = true; break;
            default: throw new Error(`Unknown argument "${argv[index]}".`);
        }
    }
    return args;
}

function decisionSurface(node, graph, open) {
    const lanes = graph.lanes.filter(lane => lane.fromNode === node.id || lane.toNode === node.id);
    const openSections = open && open.length ? new Set(open.map(entry => entry.sectionId)) : null;
    const incoming = lanes.filter(lane => lane.toNode === node.id
        && (!openSections || openSections.has(lane.sectionId)));
    const exitArms = new Set(lanes.filter(lane => lane.fromNode === node.id).map(lane => lane.sectionId));
    return incoming.reduce((total, lane) => total
        + Math.max(0, exitArms.size - (exitArms.has(lane.sectionId) ? 1 : 0)), 0);
}

async function surveyTile(args, tile, storedByTile, settledNodes) {
    const url = `${args.api}/lane-topology/osm?bbox=${tile.build.join(',')}`
        + `&city=${encodeURIComponent(args.city)}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`GET ${url} → ${response.status}`);
    const evidence = await response.json();
    if (!evidence.features?.length) return null;
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
    const mine = junctions.filter(junction => insideCore(junction.point, tile.core));
    if (!mine.length) return null;

    // A junction whose open nodes have all been answered by a stored decision is finished, even
    // though a fresh derivation still calls it open.
    //
    // And a junction with fewer than three arms is not work at ALL: the rules decline it as
    // `fewer_than_three_arms`, the bulk solver's arm floor skips it, and nothing a model could say
    // would settle it — it is a mid-block node or a dead end that node fusion happened to group.
    // Counting it as open put a permanent phantom in the tile, which is why five of the
    // twenty-four "one junction from done" tiles had nothing to run: their last open junction had
    // two arms, and they could never have reached 100%.
    const workable = mine.filter(junction => (junction.armCount || 0) >= MIN_JUNCTION_ARMS);
    const openJunctions = workable.filter(junction => !junction.resolved
        && junction.unresolvedNodeIds.some(id => !settledNodes.has(id)));
    const movements = openJunctions.reduce((total, junction) => total
        + junction.unresolvedNodeIds.filter(id => !settledNodes.has(id)).reduce((sum, nodeId) => {
            const node = nodesById.get(nodeId);
            return node ? sum + decisionSurface(node, graph, problemOf.get(nodeId)?.openApproaches) : sum;
        }, 0), 0);
    const centre = [(tile.core[0] + tile.core[2]) / 2, (tile.core[1] + tile.core[3]) / 2];
    return {
        core: tile.core.map(value => Number(value.toFixed(6))),
        centre: centre.map(value => Number(value.toFixed(6))),
        junctions: workable.length,
        settled: workable.length - openJunctions.length,
        open: openJunctions.length,
        // Kept visible rather than dropped: they are real nodes, they are simply not decisions.
        notJunctions: mine.length - workable.length,
        movements,
        // Decisions that are not derivable and therefore had to be stored.
        storedSolutions: storedByTile(tile.core),
        done: workable.length ? (workable.length - openJunctions.length) / workable.length : 1
    };
}

// Stored solutions are the only persisted part, so a tile's count of them says where real
// recognition or adjudication has landed — as opposed to where the rules simply answered.
// The city bbox is far wider than the endpoint's own ceiling, so passing it returned HTTP 400 and
// this reported zero stored solutions everywhere, in silence. Ask for the city unfiltered and let
// the per-tile overlap below do the narrowing.
async function storedSolutionIndex(args) {
    let boxes = [];
    try {
        boxes = (await listAllSolutions({ api: args.api, city: args.city, log: note }))
            .map(solution => solution.bbox)
            .filter(box => Array.isArray(box) && box.length === 4);
    } catch (error) {
        // Loud, because a survey that quietly forgets stored work reads as "nothing has been done".
        note(`WARNING: stored solutions unavailable (${error.message}); tile counts will read 0`);
    }
    return core => boxes.filter(box => box[0] < core[2] && box[2] > core[0]
        && box[1] < core[3] && box[3] > core[1]).length;
}

function link(args, tile) {
    return `${args.viewer}?backend=${encodeURIComponent(args.api)}`
        + `&lat=${tile.centre[1].toFixed(5)}&lng=${tile.centre[0].toFixed(5)}&zoom=16`;
}

function report(args, tiles) {
    const totals = tiles.reduce((sum, tile) => ({
        junctions: sum.junctions + tile.junctions,
        settled: sum.settled + tile.settled,
        movements: sum.movements + tile.movements
    }), { junctions: 0, settled: 0, movements: 0 });

    if (args.format === 'json') {
        console.log(JSON.stringify({ totals, tiles: tiles.map(tile => ({ ...tile, url: link(args, tile) })) }, null, 1));
        return;
    }
    console.log(`${tiles.length} tiles with roads · ${totals.junctions} junctions · `
        + `${totals.settled} settled (${Math.round(100 * totals.settled / totals.junctions)}%) · `
        + `${totals.movements} decisions left\n`);

    // Nearly finished: a real amount of road, and few enough decisions left to clear in a sitting.
    const nearly = tiles
        .filter(tile => tile.junctions >= args.minJunctions && tile.open > 0)
        .sort((a, b) => (a.movements - b.movements) || (b.done - a.done))
        .slice(0, args.top);
    console.log(`Nearest to finished (at least ${args.minJunctions} junctions, still open):`);
    nearly.forEach((tile, index) => {
        console.log(`${String(index + 1).padStart(3)}. ${String(tile.movements).padStart(3)} decisions `
            + `· ${tile.open} of ${tile.junctions} junctions open · ${Math.round(100 * tile.done)}% settled`);
        console.log(`     ${link(args, tile)}`);
    });
    const clean = tiles.filter(tile => tile.junctions >= args.minJunctions && !tile.open).length;
    console.log(`\n${clean} tiles with ${args.minJunctions}+ junctions are already fully settled.`);
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        console.log(USAGE);
        return 0;
    }
    args.bbox = args.bbox || CITY_BBOX;
    const storedByTile = await storedSolutionIndex(args);
    const stored = await settledNodeIndex({
        api: args.api, city: args.city, bbox: args.bbox,
        log: message => process.stderr.write(`  ${message}\n`)
    });
    if (stored.settled.size) {
        process.stderr.write(`  ${stored.settled.size} nodes already settled by `
            + `${stored.consulted} stored solutions\n`);
    }
    const list = enumerationTiles(args.bbox);
    const tiles = [];
    for (const [index, tile] of list.entries()) {
        const surveyed = await surveyTile(args, tile, storedByTile, stored.settled);
        if (surveyed) tiles.push(surveyed);
        if ((index + 1) % 250 === 0) {
            process.stderr.write(`  … ${index + 1}/${list.length} tiles, ${tiles.length} with roads\n`);
        }
    }
    report(args, tiles);
    return 0;
}

main().then(code => process.exit(code)).catch(error => {
    console.error(`fatal: ${error.message}`);
    process.exit(1);
});
