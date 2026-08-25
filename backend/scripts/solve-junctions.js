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
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { enumerationTiles, insideCore } from './lib/city-tiles.js';
import { settledNodeIndex } from './lib/stored-solutions.js';

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
    order: 'size',
    concurrency: 1,
    pollMs: 5000,
    // Left null so it can be derived from the provider's own ceiling once --provider is known;
    // see jobTimeoutFor. A fixed number here is how the two ceilings drift apart.
    jobTimeoutMs: null
};

// How long the runner waits for a job the backend is running. It must outlast the ceiling the
// backend puts on the CLI, or the runner gives up on work that is still allowed to finish and
// reports it failed — which is exactly what "Job 377 still running after 1080s" was: an 18-minute
// runner watching a 15-minute provider, with a restart in between. The slack covers enqueue,
// polling and the read-back either side of the model call.
const JOB_TIMEOUT_SLACK_MS = 5 * 60 * 1000;
export function jobTimeoutFor(provider, ceilings) {
    const ceiling = (ceilings || {})[provider];
    return (Number(ceiling) || 15 * 60 * 1000) + JOB_TIMEOUT_SLACK_MS;
}
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
  --max-lanes N           Skip junctions with more lanes meeting them — a cost guard.
  --order size|spatial|finish
                          Most lanes first, nearest the centre, or the tiles closest to being
                          finished first — whole tiles at a time, so a run completes them.
  --limit N               Stop after N junctions this run.
  --concurrency N         Junctions in flight at once (default ${DEFAULTS.concurrency}).
  --redo                  Re-run junctions this model already solved.
  --ignore-stored         Do not consult other providers' stored answers; a junction another
                          model has already settled becomes work again (cross-model comparison).
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
            case '--max-lanes': args.maxLanes = Number(take()); break;
            case '--order': args.order = take(); break;
            case '--limit': args.limit = Number(take()); break;
            case '--concurrency': args.concurrency = Math.max(1, Number(take())); break;
            case '--log': args.log = take(); break;
            case '--redo': args.redo = true; break;
            case '--ignore-stored': args.ignoreStored = true; break;
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

// Injectable so the runner's own behaviour can be tested without a server. Everything below goes
// through this one function, so a test that replaces it controls the whole conversation.
let apiImpl = null;
export function setApiImpl(impl) { apiImpl = impl; }

async function api(base, path, init) {
    if (apiImpl) return apiImpl(base, path, init);
    return realApi(base, path, init);
}

async function realApi(base, path, init) {
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
        mine.forEach(junction => {
            if (found.has(junction.key)) return;
            // Which tile owns it, so a run can be asked to FINISH tiles rather than to chew the
            // biggest junctions. A tile is what the coverage map draws, so completing one is the
            // unit of visible progress.
            found.set(junction.key, { ...junction, tileKey: `${tile.row},${tile.column}` });
        });
        log(`tile ${index + 1}/${tiles.length}: ${evidence.features?.length ?? '?'} ways, `
            + `${stats.junctions} junctions, ${mine.length} in core`
            + (evidence.truncated ? ' — EVIDENCE TRUNCATED, tile is too big' : ''));
    }
    return [...found.values()];
}

// How many junctions each tile still has open, keyed by tile.
function openPerTile(junctions) {
    const counts = new Map();
    junctions.forEach(junction => {
        counts.set(junction.tileKey, (counts.get(junction.tileKey) || 0) + 1);
    });
    return counts;
}

function orderJunctions(junctions, args) {
    if (args.order === 'finish') {
        // Nearly-done tiles first. Completing a tile is worth more than shaving the largest
        // junction in a tile that will still be half open afterwards: it is what the coverage map
        // shows, and one decision can take a 109-junction tile from 99% to done.
        const counts = openPerTile(junctions);
        return junctions.slice().sort((a, b) =>
            (counts.get(a.tileKey) - counts.get(b.tileKey))
            || String(a.tileKey).localeCompare(String(b.tileKey))
            || (b.laneCount - a.laneCount)
            || a.key.localeCompare(b.key, undefined, { numeric: true }));
    }
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
    // Lanes, not arms: "biggest junction" means the most road meeting there, and that is also what
    // predicts the cost of solving it.
    return junctions.slice().sort((a, b) => (b.laneCount - a.laneCount)
        || (b.armCount - a.armCount)
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

// A short retry for reads that are incidental to the work. The junction's own run is never
// retried here — that costs tokens and belongs to the caller's resume — but re-reading a row that
// already exists is free, and one dropped connection should not be the end of it.
export async function withRetry(operation, args, attempts = 3) {
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            return await operation();
        } catch (error) {
            lastError = error;
            if (attempt < attempts) await sleep(Math.min(args?.pollMs || 2000, 2000) * attempt);
        }
    }
    throw lastError;
}

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

export async function solveJunction(base, args, junction, bbox) {
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
    // The read-back exists to put "295 connections, 19 problems" on the progress line. It must
    // never decide whether the junction succeeded: a transient `fetch failed` here used to throw
    // out of solveJunction, the caller's catch built a `status: failed` record, and a junction
    // whose answer was already computed, stored and costed was reported as lost. That happened on
    // the Miramarska junction — job 62 completed, solution 139 with 192 connections, run summary
    // said "1 failed". Someone reading that goes looking for work that is sitting in the database.
    if (job.status === 'completed' && job.resultSolutionId) {
        try {
            const { solution } = await withRetry(
                () => api(base, `/lane-topology/solutions/${job.resultSolutionId}`),
                args
            );
            record.stats = {
                connections: solution.stats?.connections ?? null,
                problems: solution.stats?.problems ?? null,
                errors: solution.stats?.errors ?? null
            };
        } catch (error) {
            // Said out loud, because a silent miss would look like a junction that produced
            // nothing rather than one whose summary could not be fetched.
            record.statsError = String(error.message || error);
        }
    }
    return record;
}

function summariseUsage(records) {
    const totals = records.reduce((accumulator, record) => {
        if (!record.usage) return accumulator;
        accumulator.input += record.usage.inputTokens || 0;
        accumulator.output += record.usage.outputTokens || 0;
        accumulator.cached += record.usage.cacheReadTokens || 0;
        accumulator.counted += 1;
        // Only Claude states a costed equivalent. Averaging over the runs that do would put a
        // number on runs that did not, so the count travels with the money.
        if (Number.isFinite(record.usage.equivalentUsd)) {
            accumulator.usd += record.usage.equivalentUsd;
            accumulator.costed += 1;
        }
        return accumulator;
    }, { input: 0, output: 0, cached: 0, usd: 0, counted: 0, costed: 0 });
    if (!totals.counted) return 'usage not reported';
    const money = totals.costed === totals.counted
        ? ` · $${totals.usd.toFixed(2)} equivalent (subscription-billed, not charged)`
        : (totals.costed
            ? ` · $${totals.usd.toFixed(2)} equivalent over ${totals.costed}/${totals.counted} runs`
            : ' · no costed equivalent reported by this CLI');
    return `${totals.input.toLocaleString()} in (${totals.cached.toLocaleString()} cached)`
        + ` / ${totals.output.toLocaleString()} out tokens${money}`;
}

// Junctions a person has to look at, which a model must not be sent to again. Read from disk each
// run so the list can be edited without a restart; a missing or unreadable file means an empty list
// rather than a crash, because a worklist is not worth failing a batch over.
export function manualReviewKeys(file) {
    const path = file || new URL('../lane-topology/manual-review.json', import.meta.url);
    try {
        return new Set((JSON.parse(readFileSync(path, 'utf8')).junctions || [])
            .map(entry => entry.key).filter(Boolean));
    } catch (error) {
        if (error.code !== 'ENOENT') log(`manual-review list unreadable (${error.message})`);
        return new Set();
    }
}

// What in an enumerated area is actually work, and why each of the rest is not. Pure, because the
// three reasons a junction gets skipped are the three ways a run can silently understate what it
// did, and every one of them has already been a bug:
//
//   deterministic — the rules settle it for free; paying a model to re-derive it is the whole cost
//                   problem, and this is the filter that keeps a sweep affordable.
//   adjudicated   — ANOTHER provider has already answered it. The runner could not see this: resume
//                   keys on (junction, bbox, provider, model), and open/closed is a fresh
//                   derivation, so a Claude sweep re-asked roughly a fifth of what Codex had done.
//                   Same predicate the coverage report uses, so the two now agree on what is left.
//   oversized     — over the --max-lanes cost guard. Reported out loud, because silent truncation
//                   reads as "the area is solved" when its biggest interchanges were never tried.
//   needsPerson   — on the manual-review list: repeated failures for unrelated reasons, so the
//                   junction is the problem and another run just spends the ceiling again.
export function classifyJunctions(enumerated,
    { settledNodes, includeResolved, maxLanes, manualReview } = {}) {
    const settled = settledNodes || new Set();
    const manual = manualReview instanceof Set ? manualReview : new Set(manualReview || []);
    const deterministic = [];
    const adjudicated = [];
    const oversized = [];
    const needsPerson = [];
    const open = [];
    for (const junction of enumerated || []) {
        if (!includeResolved && junction.resolved) { deterministic.push(junction); continue; }
        // Sent to a model again it would fail again, at the cost of a full provider ceiling. It is
        // still open work — it is just not work a model does.
        if (manual.has(junction.key)) { needsPerson.push(junction); continue; }
        // An empty list means the derivation names no open node, so there is nothing for a stored
        // answer to have settled — `every` on an empty array is true and would skip it silently.
        if (!includeResolved && junction.unresolvedNodeIds?.length
            && junction.unresolvedNodeIds.every(id => settled.has(id))) {
            adjudicated.push(junction);
            continue;
        }
        if (maxLanes && junction.laneCount > maxLanes) { oversized.push(junction); continue; }
        open.push(junction);
    }
    return { deterministic, adjudicated, oversized, needsPerson, open };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help || (!args.bbox && !args.center)) {
        console.log(USAGE);
        return 0;
    }
    if (!args.jobTimeoutMs) {
        args.jobTimeoutMs = jobTimeoutFor(args.provider, CliProviders.PROVIDER_TIMEOUT_MS);
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
    const stored = (args.includeResolved || args.ignoreStored)
        ? { settled: new Set(), consulted: 0 }
        : await settledNodeIndex({ api: base, city: args.city, bbox: args.bbox, log });
    const { deterministic, adjudicated, oversized, needsPerson, open } = classifyJunctions(
        enumerated, { settledNodes: stored.settled, manualReview: manualReviewKeys(), ...args });
    const junctions = orderJunctions(open, args);
    log(`${enumerated.length} junctions with ${args.minArms}+ arms`
        + `; ${deterministic.length} already settled by the deterministic rules`
        + (adjudicated.length ? `; ${adjudicated.length} already answered by a stored solution `
            + `(${stored.consulted} consulted)` : '')
        + (needsPerson.length ? `; SKIPPED ${needsPerson.length} on the manual-review list: `
            + needsPerson.map(junction => junction.name).join(', ') : '')
        + `; ${junctions.length} need recognition`
        + (oversized.length ? `; SKIPPED ${oversized.length} over ${args.maxLanes} lanes: `
            + oversized.map(junction => `${junction.name} (${junction.laneCount} lanes, `
                + `${junction.armCount} arms)`).join(', ') : ''));

    const queue = [];
    let alreadyDone = 0;
    let completedTiles = 0;
    // In `finish` mode the limit is applied per TILE, not per junction: half a tile completes
    // nothing, so a tile that will not fit in what is left of the budget is skipped in favour of a
    // smaller one. Every other mode keeps the plain per-junction limit.
    const byTile = new Map();
    for (const junction of junctions) {
        const key = args.order === 'finish' ? junction.tileKey : '';
        if (!byTile.has(key)) byTile.set(key, []);
        byTile.get(key).push(junction);
    }

    for (const [tileKey, group] of byTile) {
        const candidates = [];
        for (const junction of group) {
            const bbox = junctionBbox(junction, args.padM, args.minSpanM);
            if (!bbox) continue;
            if (!args.redo) {
                const existing = await existingSolution(base, args, bbox);
                if (existing) { alreadyDone += 1; continue; }
            }
            candidates.push({ junction, bbox });
            // Outside `finish` mode this is the old behaviour exactly: stop at the limit.
            if (args.order !== 'finish' && args.limit && queue.length + candidates.length >= args.limit) break;
        }
        if (!candidates.length) {
            // Every junction in it was already solved: the tile is finished, just not by this run.
            if (args.order === 'finish' && tileKey) completedTiles += 0;
            continue;
        }
        if (args.order === 'finish' && args.limit) {
            const room = args.limit - queue.length;
            if (candidates.length > room) {
                // Never start a tile this run cannot finish — unless nothing has been queued at
                // all, in which case a partial tile beats an empty run.
                if (queue.length) continue;
                queue.push(...candidates.slice(0, room));
                break;
            }
            completedTiles += 1;
        }
        queue.push(...candidates);
        if (args.limit && queue.length >= args.limit) break;
    }
    log(`${queue.length} to run, ${alreadyDone} already solved by ${args.provider}/${args.model}`
        + (args.order === 'finish' ? `; they finish ${completedTiles} tile${completedTiles === 1 ? '' : 's'}` : ''));

    if (args.dryRun) {
        queue.slice(0, 20).forEach(({ junction, bbox }) => {
            log(`  ${junction.laneCount} lanes · ${junction.armCount} arms · ${junction.name} · ${bbox.join(',')}`);
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
            const detail = record.status !== 'completed'
                ? `FAILED: ${String(record.error || '').slice(0, 200)}`
                : (record.statsError
                    // Solved and stored; only the summary read failed. Naming the solution makes
                    // that checkable rather than something to take on trust.
                    ? `solved, solution ${record.solutionId} stored `
                        + `(summary unreadable: ${record.statsError.slice(0, 80)})${tokens}`
                    : `${record.stats?.connections ?? '?'} connections, `
                        + `${record.stats?.problems ?? '?'} problems${tokens}`);
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
    // Counted separately: these junctions ARE solved and their solutions are stored, so they must
    // not be added to `failed`, but a run where the summary read kept dropping is worth seeing.
    const unsummarised = records.filter(record => record.statsError).length;
    log(`done: ${solved} solved, ${failed} failed, ${queue.length - solved - failed} not attempted`
        + `${unsummarised ? `, ${unsummarised} solved whose summary could not be read` : ''}, ${minutes} min`);
    log(`usage: ${summariseUsage(records)}`);
    if (stopped) {
        log(`STOPPED EARLY — ${stopped}`);
        return 2;
    }
    // Persistent per-item failures must poison the verdict rather than hide inside a "done" line.
    return failed ? 1 : 0;
}

// Only when run as a command. Importing this file — which a test does, to drive solveJunction
// without a server — must not start enumerating Zagreb or print the usage banner.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().then(code => { process.exitCode = code; }).catch(error => {
        console.error(`[${stamp()}] fatal: ${error.message}`);
        process.exitCode = 1;
    });
}
