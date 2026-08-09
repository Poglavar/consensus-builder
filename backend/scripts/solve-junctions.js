#!/usr/bin/env node
// Batch-solves lane-topology junctions with the Claude/Codex CLI, one junction at a time.
//
// The manager UI solves whatever is in the viewport, one press at a time. This is the same work
// unattended: enumerate every unsolved junction in an area, then run the CLI over each with its own
// tight bbox and orthophoto crop. A junction is the unit the model actually solves (see
// frontend/js/lane-topology-junctions.js), so it is also the unit of progress, resume and cost here.
//
// Resume is judged by the ARTIFACT: a junction counts as done when a stored solution for exactly its
// bbox, by this provider and model, already exists. A re-run after a kill therefore loses progress at
// worst, never correctness, and a different model never overwrites an earlier model's work.
//
//   node backend/scripts/solve-junctions.js --center 45.8035,15.9905 --radius 1200 --dry-run
//   node backend/scripts/solve-junctions.js --bbox 15.98,45.79,16.00,45.81 --limit 5
//
// Long runs belong under `run-job` so they outlive the shell that started them.
import { createRequire } from 'node:module';
import { appendFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const LaneTopologyJunctions = require('../../frontend/js/lane-topology-junctions.js');
const LaneTopologyGraph = require('../../frontend/js/lane-topology-graph.js');
const CorridorProfile = require('../../frontend/js/corridor-profile.js');
const OsmProfile = require('../../frontend/js/osm-profile.js');
// The backend owns which models can see an image; the runner must not keep a second opinion.
const CliProviders = await import('../lane-topology/cli-providers.js');

const DEFAULTS = {
    api: 'http://localhost:4913',
    city: 'zagreb',
    provider: 'claude',
    model: 'opus',
    imagery: 'zagreb_cdof_2022',
    padM: 70,
    minSpanM: 140,
    minArms: 3,
    order: 'arms',
    concurrency: 1,
    pollMs: 5000,
    jobTimeoutMs: 18 * 60 * 1000
};
// The builder's own ceiling; tiles for junction ENUMERATION must stay under it.
const MAX_BBOX_SPAN_DEG = 0.08;
// ~1.3 km of latitude. Big enough that most junctions sit in one tile's core, small enough that the
// evidence query stays quick and never approaches the server's 5000-way evidence cap.
const TILE_SPAN_DEG = 0.012;
// Enumeration tiles overlap so a junction on a tile edge is still derived with all of its arms.
const TILE_OVERLAP_DEG = 0.0015;
const MAX_RECOGNITION_GSD_M = 0.35;
const BBOX_EPSILON = 1e-6;
// A CLI that reports the subscription window is exhausted will report it for every junction after
// this one too, so the run stops rather than burning the queue into identical failures.
const QUOTA_PATTERN = /rate.?limit|usage limit|quota|too many requests|overloaded/i;

const USAGE = `
Solve lane-topology junctions in bulk with a CLI model.

  --bbox W,S,E,N          Area to enumerate junctions in (WGS84).
  --center LAT,LNG        Alternative to --bbox, with --radius.
  --radius M              Half-size of the --center box, in metres (default 1000).

  --api URL               Lane-topology API base (default ${DEFAULTS.api}).
  --city NAME             City key (default ${DEFAULTS.city}).
  --provider claude|codex Recognition CLI (default ${DEFAULTS.provider}).
  --model NAME            Model passed to the CLI (default ${DEFAULTS.model}).
  --imagery KEY|none      Orthophoto source (default ${DEFAULTS.imagery}).

  --pad M                 Padding around a junction's nodes (default ${DEFAULTS.padM} m).
  --min-span M            Smallest junction crop (default ${DEFAULTS.minSpanM} m).
  --min-arms N            Skip junctions with fewer arms (default ${DEFAULTS.minArms}).
  --max-arms N            Skip junctions with more arms — they exceed one CLI call.
  --order arms|spatial    Biggest junctions first, or nearest the centre (default ${DEFAULTS.order}).
  --limit N               Stop after N junctions this run.
  --concurrency N         Junctions in flight at once (default ${DEFAULTS.concurrency}).
  --redo                  Re-run junctions this model already solved.
  --include-resolved      Also run junctions the deterministic rules already settled.
  --allow-disabled-model  Run a model this task has measured as unfit (see MODEL_NOTES).
  --log FILE              Append one JSON line per junction here.
  --dry-run               Enumerate and report; run nothing.

Billing: the claude CLI is billed to the Max subscription and the codex CLI to the ChatGPT
subscription — neither spends API credit. Token counts are still recorded per junction, because
that is what tells you whether a prompt change doubled the cost.
`;

function parseArgs(argv) {
    const args = { ...DEFAULTS, radiusM: 1000 };
    for (let index = 0; index < argv.length; index += 1) {
        const flag = argv[index];
        const value = argv[index + 1];
        const take = () => { index += 1; return value; };
        switch (flag) {
            case '--bbox': args.bbox = take().split(',').map(Number); break;
            case '--center': args.center = take().split(',').map(Number); break;
            case '--radius': args.radiusM = Number(take()); break;
            case '--api': args.api = take().replace(/\/+$/, ''); break;
            case '--city': args.city = take(); break;
            case '--provider': args.provider = take(); break;
            case '--model': args.model = take(); break;
            case '--imagery': args.imagery = take(); break;
            case '--pad': args.padM = Number(take()); break;
            case '--min-span': args.minSpanM = Number(take()); break;
            case '--min-arms': args.minArms = Number(take()); break;
            case '--max-arms': args.maxArms = Number(take()); break;
            case '--order': args.order = take(); break;
            case '--limit': args.limit = Number(take()); break;
            case '--concurrency': args.concurrency = Math.max(1, Number(take())); break;
            case '--log': args.log = take(); break;
            case '--redo': args.redo = true; break;
            case '--include-resolved': args.includeResolved = true; break;
            case '--allow-disabled-model': args.allowDisabledModel = true; break;
            case '--dry-run': args.dryRun = true; break;
            case '--help': case '-h': args.help = true; break;
            default: throw new Error(`Unknown argument "${flag}".`);
        }
    }
    if (args.imagery === 'none') args.imagery = null;
    return args;
}

function stamp() {
    return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function log(message) {
    console.log(`[${stamp()}] ${message}`);
}

function metresToDegrees(metres, lat) {
    const dLat = metres / 111_320;
    const dLng = metres / (111_320 * Math.max(0.1, Math.cos(lat * Math.PI / 180)));
    return { dLat, dLng };
}

function roundBbox(bbox) {
    return bbox.map(value => Number(Number(value).toFixed(7)));
}

function sameBbox(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== 4 || b.length !== 4) return false;
    return a.every((value, index) => Math.abs(Number(value) - Number(b[index])) <= BBOX_EPSILON);
}

function centerBbox(center, radiusM) {
    const [lat, lng] = center;
    const { dLat, dLng } = metresToDegrees(radiusM, lat);
    return [lng - dLng, lat - dLat, lng + dLng, lat + dLat];
}

// Cores tile the target exactly; each build box is a core grown by the overlap, so a junction is
// enumerated once (by the core that holds its centre) but always with its full set of arms.
function enumerationTiles(bbox) {
    const [west, south, east, north] = bbox;
    const columns = Math.max(1, Math.ceil((east - west) / TILE_SPAN_DEG));
    const rows = Math.max(1, Math.ceil((north - south) / TILE_SPAN_DEG));
    const spanX = (east - west) / columns;
    const spanY = (north - south) / rows;
    const tiles = [];
    for (let row = 0; row < rows; row += 1) {
        for (let column = 0; column < columns; column += 1) {
            const core = [
                west + column * spanX,
                south + row * spanY,
                west + (column + 1) * spanX,
                south + (row + 1) * spanY
            ];
            const build = [
                core[0] - TILE_OVERLAP_DEG,
                core[1] - TILE_OVERLAP_DEG,
                core[2] + TILE_OVERLAP_DEG,
                core[3] + TILE_OVERLAP_DEG
            ];
            if (build[2] - build[0] > MAX_BBOX_SPAN_DEG || build[3] - build[1] > MAX_BBOX_SPAN_DEG) {
                throw new Error('Enumeration tile exceeds the API bbox ceiling; lower TILE_SPAN_DEG.');
            }
            tiles.push({ core, build });
        }
    }
    return tiles;
}

function insideCore(point, core) {
    if (!Array.isArray(point)) return false;
    const [lng, lat] = point.map(Number);
    return lng >= core[0] && lng < core[2] && lat >= core[1] && lat < core[3];
}

function junctionBbox(junction, padM, minSpanM) {
    const box = Array.isArray(junction.bbox) ? junction.bbox.slice() : null;
    const point = junction.point;
    if (!box && !Array.isArray(point)) return null;
    const lat = Number(point?.[1] ?? (box[1] + box[3]) / 2);
    const pad = metresToDegrees(padM, lat);
    let [west, south, east, north] = box || [point[0], point[1], point[0], point[1]];
    west -= pad.dLng; east += pad.dLng;
    south -= pad.dLat; north += pad.dLat;
    const minimum = metresToDegrees(minSpanM / 2, lat);
    const centerLng = (west + east) / 2;
    const centerLat = (south + north) / 2;
    if (east - west < minimum.dLng * 2) {
        west = centerLng - minimum.dLng;
        east = centerLng + minimum.dLng;
    }
    if (north - south < minimum.dLat * 2) {
        south = centerLat - minimum.dLat;
        north = centerLat + minimum.dLat;
    }
    return roundBbox([west, south, east, north]);
}

async function api(base, path, init) {
    const response = await fetch(`${base}${path}`, {
        // Node's default is a 300 s headers timeout that surfaces as a bare "fetch failed"; a slow
        // evidence query has to fail as itself, with the path that was slow.
        signal: AbortSignal.timeout(init?.timeoutMs || 10 * 60 * 1000),
        ...init,
        headers: {
            'content-type': 'application/json',
            // The backend refuses writes without a recognised Origin; a script has none of its own.
            origin: 'http://localhost',
            ...(init?.headers || {})
        }
    });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch (_) { body = { raw: text.slice(0, 500) }; }
    if (!response.ok) {
        throw new Error(`${init?.method || 'GET'} ${path} → ${response.status}: ${body?.error || text.slice(0, 300)}`);
    }
    return body;
}

// Enumeration builds the deterministic graph in-process from the same evidence endpoint the server
// uses. Asking the server to build and STORE a solution per tile is the same work plus a parcel fetch
// and a write, and every junction run rebuilds its own base graph anyway — so this is enumeration
// without leaving a trail of throwaway solutions behind.
async function junctionsInArea(base, args) {
    const tiles = enumerationTiles(args.bbox);
    const found = new Map();
    for (const [index, tile] of tiles.entries()) {
        const bbox = roundBbox(tile.build);
        const evidence = await api(
            base,
            `/lane-topology/osm?bbox=${bbox.join(',')}&city=${encodeURIComponent(args.city)}`
        );
        const graph = LaneTopologyGraph.build(evidence, {
            snapshotAt: evidence.snapshotAt,
            // The deterministic junction rules read these, so enumeration must see the same
            // evidence the server's build does or it would queue junctions the server can solve.
            restrictions: evidence.restrictions,
            profileFromTags: CorridorProfile.corridorProfileFromOsmTags,
            orientProfile: OsmProfile.orientForRightHandTraffic
        });
        const { junctions, stats } = LaneTopologyJunctions.deriveJunctions(graph);
        const mine = junctions.filter(junction => insideCore(junction.point, tile.core));
        mine.forEach(junction => { if (!found.has(junction.key)) found.set(junction.key, junction); });
        log(`tile ${index + 1}/${tiles.length}: ${evidence.features?.length ?? '?'} ways, `
            + `${stats.junctions} junctions, ${mine.length} in core`
            + (evidence.truncated ? ' — EVIDENCE TRUNCATED, tile is too big' : ''));
    }
    return [...found.values()];
}

function orderJunctions(junctions, args) {
    if (args.order === 'spatial') {
        const [west, south, east, north] = args.bbox;
        const centerLng = (west + east) / 2;
        const centerLat = (south + north) / 2;
        return junctions.slice().sort((a, b) => {
            const distance = junction => Math.hypot(
                (junction.point?.[0] ?? 0) - centerLng,
                (junction.point?.[1] ?? 0) - centerLat
            );
            return distance(a) - distance(b);
        });
    }
    return junctions.slice().sort((a, b) => (b.armCount - a.armCount)
        || a.key.localeCompare(b.key, undefined, { numeric: true }));
}

async function existingSolution(base, args, bbox) {
    const body = await api(base, `/lane-topology/solutions?city=${encodeURIComponent(args.city)}`
        + `&bbox=${bbox.join(',')}&limit=100`);
    return (body.solutions || []).find(solution => solution.sourceKind === args.provider
        && sameBbox(solution.bbox, bbox)
        && (solution.model || null) === (args.model || null)) || null;
}

// The crop is attached per junction, so a fused junction too wide for the GSD budget loses its
// imagery instead of failing the whole junction — OSM-only is a worse answer, not no answer.
async function imageryForBbox(base, args, bbox) {
    if (!args.imagery) return null;
    try {
        const body = await api(base, `/lane-topology/imagery/crop-spec?source=${encodeURIComponent(args.imagery)}`
            + `&bbox=${bbox.join(',')}`);
        const gsd = Number(body?.crop?.effectiveGsdM);
        if (Number.isFinite(gsd) && gsd <= MAX_RECOGNITION_GSD_M) return args.imagery;
        return null;
    } catch (_) {
        return null;
    }
}

const sleep = ms => new Promise(resolve => { setTimeout(resolve, ms); });

async function waitForJob(base, jobId, args) {
    const deadline = Date.now() + args.jobTimeoutMs;
    for (;;) {
        await sleep(args.pollMs);
        const { job } = await api(base, `/lane-topology/jobs/${jobId}`);
        if (job.status === 'completed' || job.status === 'failed') return job;
        if (Date.now() > deadline) {
            throw new Error(`Job ${jobId} still ${job.status} after ${Math.round(args.jobTimeoutMs / 1000)}s.`);
        }
    }
}

async function solveJunction(base, args, junction, bbox) {
    const startedAt = Date.now();
    const imagerySource = await imageryForBbox(base, args, bbox);
    const enqueued = await api(base, '/lane-topology/process', {
        method: 'POST',
        body: JSON.stringify({
            bbox,
            city: args.city,
            provider: args.provider,
            model: args.model,
            imagerySource
        })
    });
    const job = await waitForJob(base, enqueued.job.id, args);
    const record = {
        key: junction.key,
        name: junction.name,
        armCount: junction.armCount,
        bbox,
        imagerySource,
        jobId: job.id,
        status: job.status,
        solutionId: job.resultSolutionId || null,
        error: job.error || null,
        durationS: Math.round((Date.now() - startedAt) / 1000),
        usage: job.usage || null,
        at: new Date().toISOString()
    };
    if (job.status === 'completed' && job.resultSolutionId) {
        const { solution } = await api(base, `/lane-topology/solutions/${job.resultSolutionId}`);
        record.stats = {
            connections: solution.stats?.connections ?? null,
            problems: solution.stats?.problems ?? null,
            errors: solution.stats?.errors ?? null
        };
    }
    return record;
}

function summariseUsage(records) {
    const totals = records.reduce((accumulator, record) => {
        if (!record.usage) return accumulator;
        accumulator.input += record.usage.inputTokens || 0;
        accumulator.output += record.usage.outputTokens || 0;
        accumulator.usd += record.usage.equivalentUsd || 0;
        accumulator.counted += 1;
        return accumulator;
    }, { input: 0, output: 0, usd: 0, counted: 0 });
    if (!totals.counted) return 'usage not reported';
    return `${totals.input.toLocaleString()} in / ${totals.output.toLocaleString()} out tokens`
        + ` · $${totals.usd.toFixed(2)} equivalent (subscription-billed, not charged)`;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help || (!args.bbox && !args.center)) {
        console.log(USAGE);
        return 0;
    }
    if (!args.bbox) args.bbox = centerBbox(args.center, args.radiusM);
    args.bbox = roundBbox(args.bbox);
    if (args.bbox.length !== 4 || args.bbox.some(value => !Number.isFinite(value))) {
        throw new Error('Invalid --bbox / --center.');
    }
    const base = args.api;

    const providers = await api(base, '/lane-topology/providers');
    if (!providers.enabled) throw new Error('CLI topology recognition is disabled on this backend.');
    const availability = providers.providers?.[args.provider];
    if (availability && availability.available === false && !availability.indeterminate) {
        throw new Error(`The ${args.provider} CLI is not available to the backend.`);
    }
    // A text-only model with imagery configured would fail on its first job and every one after it.
    // Say so before the enumeration, not two thousand junctions in.
    if (args.imagery && !CliProviders.modelAcceptsImagery(args.model)) {
        throw new Error(`Model ${args.model} takes text only — pass --imagery none, and expect an `
            + 'answer derived from tags and geometry alone.');
    }
    // Kept wired and selectable, never reachable by accident: a model measured to be poor at this
    // should cost a deliberate flag, not a typo.
    if (!CliProviders.modelIsEnabled(args.model) && !args.allowDisabledModel) {
        throw new Error(`Model ${args.model} is disabled for this task (`
            + `${CliProviders.modelNote(args.model)}). Pass --allow-disabled-model to run it anyway.`);
    }
    log(`provider ${args.provider} (${availability?.version || 'version unknown'}), model ${args.model}, `
        + `prompt ${providers.promptVersion}`
        + (args.imagery ? `, imagery ${args.imagery}` : ', NO IMAGERY — tags and geometry only'));
    log(`area ${args.bbox.join(',')}`);

    const enumerated = (await junctionsInArea(base, args))
        .filter(junction => junction.armCount >= args.minArms);
    // Junctions the deterministic rules already settled are not recognition work. Spending a CLI
    // call to re-derive an answer the builder produces for free is the whole cost problem.
    const deterministic = args.includeResolved ? [] : enumerated.filter(junction => junction.resolved);
    const all = enumerated.filter(junction => !deterministic.includes(junction));
    // A junction the run will not attempt has to be said out loud. Silent truncation reads as
    // "the area is solved" when the biggest interchanges in it were never tried.
    const oversized = args.maxArms ? all.filter(junction => junction.armCount > args.maxArms) : [];
    const junctions = orderJunctions(all.filter(junction => !oversized.includes(junction)), args);
    log(`${enumerated.length} junctions with ${args.minArms}+ arms`
        + `; ${deterministic.length} already settled by the deterministic rules`
        + `; ${junctions.length} need recognition`
        + (oversized.length ? `; SKIPPED ${oversized.length} over ${args.maxArms} arms: `
            + oversized.map(junction => `${junction.name} (${junction.armCount})`).join(', ') : ''));

    const queue = [];
    let alreadyDone = 0;
    for (const junction of junctions) {
        const bbox = junctionBbox(junction, args.padM, args.minSpanM);
        if (!bbox) continue;
        if (!args.redo) {
            const existing = await existingSolution(base, args, bbox);
            if (existing) { alreadyDone += 1; continue; }
        }
        queue.push({ junction, bbox });
        if (args.limit && queue.length >= args.limit) break;
    }
    log(`${queue.length} to run, ${alreadyDone} already solved by ${args.provider}/${args.model}`);

    if (args.dryRun) {
        queue.slice(0, 20).forEach(({ junction, bbox }) => {
            log(`  ${junction.armCount} arms · ${junction.name} · ${bbox.join(',')}`);
        });
        if (queue.length > 20) log(`  … and ${queue.length - 20} more`);
        return 0;
    }
    if (!queue.length) return 0;

    const records = [];
    let solved = 0;
    let failed = 0;
    let stopped = null;
    let next = 0;

    async function worker() {
        for (;;) {
            if (stopped) return;
            const index = next;
            next += 1;
            if (index >= queue.length) return;
            const { junction, bbox } = queue[index];
            let record;
            try {
                record = await solveJunction(base, args, junction, bbox);
            } catch (error) {
                record = {
                    key: junction.key,
                    name: junction.name,
                    armCount: junction.armCount,
                    bbox,
                    status: 'failed',
                    error: String(error.message || error),
                    at: new Date().toISOString()
                };
            }
            records.push(record);
            if (record.status === 'completed') solved += 1; else failed += 1;
            if (args.log) {
                await appendFile(args.log, `${JSON.stringify(record)}\n`).catch(() => {});
            }
            const done = solved + failed;
            const elapsedS = (Date.now() - startedAt) / 1000;
            const etaS = done ? Math.round((elapsedS / done) * (queue.length - done)) : 0;
            const tokens = record.usage
                ? `, ${record.usage.outputTokens ?? '?'} out tokens`
                : '';
            const detail = record.status === 'completed'
                ? `${record.stats?.connections ?? '?'} connections, `
                    + `${record.stats?.problems ?? '?'} problems${tokens}`
                : `FAILED: ${String(record.error || '').slice(0, 200)}`;
            log(`${done}/${queue.length} · ${Math.round(100 * done / queue.length)}% · `
                + `${record.armCount} arms · ${record.name} · ${record.durationS ?? '?'}s · ${detail} · `
                + `ETA ${Math.floor(etaS / 60)}m${String(etaS % 60).padStart(2, '0')}s`);
            if (record.status !== 'completed' && QUOTA_PATTERN.test(String(record.error || ''))) {
                stopped = `The ${args.provider} CLI reported a limit: ${record.error}`;
                return;
            }
        }
    }

    const startedAt = Date.now();
    await Promise.all(Array.from({ length: Math.min(args.concurrency, queue.length) }, worker));

    const minutes = Math.round((Date.now() - startedAt) / 60000);
    log(`done: ${solved} solved, ${failed} failed, ${queue.length - solved - failed} not attempted, ${minutes} min`);
    log(`usage: ${summariseUsage(records)}`);
    if (stopped) {
        log(`STOPPED EARLY — ${stopped}`);
        return 2;
    }
    // Persistent per-item failures must poison the verdict rather than hide inside a "done" line.
    return failed ? 1 : 0;
}

main().then(code => { process.exitCode = code; }).catch(error => {
    console.error(`[${stamp()}] fatal: ${error.message}`);
    process.exitCode = 1;
});
