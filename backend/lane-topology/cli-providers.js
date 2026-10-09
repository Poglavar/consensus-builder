import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import Anthropic from '@anthropic-ai/sdk';
import { normalizeImageryObservations } from './imagery-observations.js';

export const TOPOLOGY_PROMPT_VERSION = 'lane-topology-v14';
// Who answers a junction. `anthropic` is the metered Claude API through the shared LLM layer
// (agents/lib/llm-cost/llm.cjs) and the default; `claude` and `codex` are the subscription CLIs
// (cli.cjs), still selectable by name when the plan should pay instead.
export const TOPOLOGY_PROVIDERS = Object.freeze(['anthropic', 'claude', 'codex']);
export const DEFAULT_TOPOLOGY_PROVIDER = 'anthropic';

export function assertTopologyProvider(provider) {
    if (!TOPOLOGY_PROVIDERS.includes(provider)) {
        throw new Error(`Unknown topology provider "${provider}" (known: ${TOPOLOGY_PROVIDERS.join(', ')}).`);
    }
    return provider;
}
// The same question about the same crop, but not at the same speed, so not the same ceiling.
//
// 15 minutes came from codex, whose runs average 222 s and whose slowest measured junction was
// 911 s. Opus takes about four times as long — 458 s average over a 47-junction batch — and one
// junction in that batch ran to 911 s and was cut off with nothing to show for it: the ceiling had
// been set AT the top of the observed range, so the first heavy junction walked straight into it.
// A cut-off junction is the worst outcome available, because the full 15 minutes is spent and the
// answer is thrown away.
//
// So each provider gets a ceiling with real headroom over its own measured spread, and the ceiling
// stays a backstop against a hung CLI rather than a limit ordinary work can reach.
export const PROVIDER_TIMEOUT_MS = Object.freeze({
    codex: 15 * 60 * 1000,
    claude: 25 * 60 * 1000,
    // The same model as the claude CLI answering the same question, without the CLI's tool round
    // trips; until the API has its own measured spread it inherits Opus's ceiling. Applied as the
    // SDK client's request timeout.
    anthropic: 25 * 60 * 1000
});
export const TOPOLOGY_OUTPUT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'patch_json'],
    properties: {
        summary: { type: 'string' },
        patch_json: {
            type: 'string',
            description: 'A JSON-encoded topology decision patch with complete connections and problems arrays.'
        }
    }
};

// What is known about a model that a run cannot discover for itself. Absent from this table means
// no known limitation: an unlisted model takes imagery and is free to run.
export const MODEL_NOTES = Object.freeze({
    'gpt-5.3-codex-spark': Object.freeze({
        // input_modalities: ["text"]. Sending a crop does not fail — the CLI drops it and the model
        // answers from the tags alone, which is indistinguishable from an answer that read the
        // orthophoto until you check the reasons.
        acceptsImagery: false,
        // Scored against the deterministic rules on eight junctions they settle from turn:lanes, it
        // agreed on one. Its usual failure is to answer other nodes in the crop instead of the one
        // it was asked about. Wired up and selectable, but never by accident.
        enabled: false,
        note: 'text-only, and agreed with the deterministic rules on 1 of 8 junctions'
    })
});

export function modelAcceptsImagery(model) {
    return MODEL_NOTES[String(model || '')]?.acceptsImagery !== false;
}

export function modelIsEnabled(model) {
    return MODEL_NOTES[String(model || '')]?.enabled !== false;
}

export function modelNote(model) {
    return MODEL_NOTES[String(model || '')]?.note || null;
}

// Lanes are referred to by their index in graph.lanes rather than by the 90-character composite id.
// The model only ever needs a handle — the server rebuilds connection ids and geometry from the lane
// endpoints regardless — and the long form was both a third of the prompt and the thing runs got
// wrong: three of eight scored runs returned ids that did not exist.
const LANE_HANDLE = /^L(\d+)$/;

// The graph builder's restriction parser, not a second copy of it: via-node and member handling has
// exactly one definition, and a via-way relation stays unusable in both places for the same reason.
let restrictionsApi = null;
function restrictionsModule() {
    if (!restrictionsApi) {
        restrictionsApi = createRequire(import.meta.url)('../../frontend/js/lane-topology-restrictions.js');
    }
    return restrictionsApi;
}

// node key -> the movement rules OSM states there.
function restrictionIndex(restrictions) {
    const index = new Map();
    if (!Array.isArray(restrictions) || !restrictions.length) return index;
    const { describe } = restrictionsModule();
    restrictions.forEach(raw => {
        const rule = describe(raw);
        if (!rule.kind || !rule.fromWayId || !rule.toWayId || !rule.viaNodeKey) return;
        if (!index.has(rule.viaNodeKey)) index.set(rule.viaNodeKey, []);
        index.get(rule.viaNodeKey).push(rule);
    });
    return index;
}

export function laneHandle(index) {
    return `L${index}`;
}

function withLaneHandles(graph) {
    const handleOf = new Map((graph.lanes || []).map((lane, index) => [lane.id, laneHandle(index)]));
    const to = id => handleOf.get(id) || id;
    return {
        ...graph,
        lanes: (graph.lanes || []).map(lane => ({ ...lane, id: to(lane.id) })),
        sections: (graph.sections || []).map(section => (
            Array.isArray(section.laneIds) ? { ...section, laneIds: section.laneIds.map(to) } : section
        )),
        // Connection ids are dropped outright: the server mints them, so sending them only spends
        // tokens on a string the model must not reuse.
        connections: (graph.connections || []).map(({ id, ...connection }) => ({
            ...connection,
            fromLaneId: to(connection.fromLaneId),
            toLaneId: to(connection.toLaneId)
        })),
        problems: (graph.problems || []).map(problem => (
            Array.isArray(problem.laneIds) ? { ...problem, laneIds: problem.laneIds.map(to) } : problem
        ))
    };
}

// The junction nodes the deterministic rules could not settle — the whole of the work, and why each
// one is hard. Without this the evidence package is a crop and the model picks its own target: the
// commonest scored failure was a patch full of movements at every node except the one that mattered.
export function recognitionTargets(graph) {
    const degreeOf = new Map((graph?.nodes || []).map(node => [node.id, node.degree]));
    const lanes = graph?.lanes || [];
    // The handles that are actually legal at this node, named rather than left to be inferred.
    //
    // A movement must run from a lane ENDING here into a lane STARTING here, and the model had to
    // work that out from fromNode/toNode across every lane in the crop. Two things made that hard
    // enough to fail five times: a two-way street contributes both an arriving and a departing lane
    // that differ only in direction, so barely a quarter of naive pairings are legal; and a crop
    // routinely holds ten unresolved nodes whose ids differ by a couple of digits, so a lane
    // arriving at one node pairs plausibly with a lane leaving another.
    //
    // Handing over the two lists turns an inference into a lookup.
    const handlesAt = (nodeId, openSections) => {
        const enterFrom = [];
        const leaveInto = [];
        lanes.forEach((lane, index) => {
            const handle = laneHandle(index);
            if (lane.toNode === nodeId
                && (!openSections || openSections.has(lane.sectionId))) enterFrom.push(handle);
            if (lane.fromNode === nodeId) leaveInto.push(handle);
        });
        return { enterFrom, leaveInto };
    };
    return (graph?.problems || [])
        .filter(problem => problem.type === 'unresolved_intersection')
        .flatMap(problem => (problem.nodeIds || []).map(nodeId => ({
            nodeId,
            arms: degreeOf.get(nodeId) ?? null,
            whyUnsettled: problem.declineReason || null,
            ...handlesAt(nodeId, problem.openApproaches?.length
                ? new Set(problem.openApproaches.map(entry => entry.sectionId))
                : null),
            // Named approaches mean the rest of the node is already decided and must be left alone.
            // Absent means every approach there is open.
            ...(problem.openApproaches?.length
                ? { openApproaches: problem.openApproaches.map(entry => ({
                    section: entry.sectionId,
                    street: entry.name || null,
                    why: entry.reason
                })) }
                : {})
        })));
}

// The executable behind each provider. Only the availability probe spawns it here; the recognition
// run itself goes through the shared CLI layer (agents/lib/llm-cost/cli.cjs), which owns the
// arguments, the model, key stripping, the schema, usage parsing, the kill at the ceiling and the
// ledger row.
const PROVIDER_COMMANDS = Object.freeze({ codex: 'codex', claude: 'claude' });

export function providerCommand(provider) {
    const command = PROVIDER_COMMANDS[provider];
    if (!command) throw new Error(`Unknown topology provider "${provider}".`);
    return { command };
}

// Probing spawns a real process, and every /process call used to re-probe with a 2.5 s ceiling. On a
// loaded machine the probe is the first thing to lose its slice, so a busy laptop reported an
// installed CLI as missing and the run was refused. A probe that ran out of time proves nothing
// about whether the CLI exists, so it is reported as indeterminate and never cached as a verdict.
const AVAILABILITY_PROBE_TIMEOUT_MS = 5000;
const AVAILABILITY_TTL_MS = 60000;
const availabilityCache = new Map();

export function clearProviderAvailabilityCache() {
    availabilityCache.clear();
}

export function providerAvailability(provider, spawnSyncImpl = spawnSync, env = process.env) {
    // The API has no executable to probe; what it needs is a key, and without one the first job
    // would fail on its first request.
    if (provider === 'anthropic') {
        const available = !!env.ANTHROPIC_API_KEY;
        return {
            available,
            version: available ? 'Claude API (metered)' : null,
            indeterminate: false,
            ...(available ? {} : { reason: 'ANTHROPIC_API_KEY is not set' })
        };
    }
    // Injected spawns belong to tests and must never see or fill the shared cache.
    const cacheable = spawnSyncImpl === spawnSync;
    if (cacheable) {
        const cached = availabilityCache.get(provider);
        if (cached && Date.now() - cached.at < AVAILABILITY_TTL_MS) return cached.value;
    }

    let value;
    try {
        const definition = providerCommand(provider);
        const result = spawnSyncImpl(definition.command, ['--version'], {
            encoding: 'utf8',
            timeout: AVAILABILITY_PROBE_TIMEOUT_MS,
            stdio: ['ignore', 'pipe', 'pipe']
        });
        const available = result?.status === 0;
        value = {
            available,
            version: available ? String(result.stdout || result.stderr || '').trim().slice(0, 160) : null,
            indeterminate: !available && result?.error?.code === 'ETIMEDOUT'
        };
    } catch (_) {
        value = { available: false, version: null, indeterminate: false };
    }

    if (cacheable && !value.indeterminate) availabilityCache.set(provider, { at: Date.now(), value });
    return value;
}

export function buildRecognitionPrompt(input) {
    const targetSet = input?.targetNodeIds ? new Set(input.targetNodeIds) : null;
    const targets = recognitionTargets(input?.deterministicGraph)
        .filter(target => !targetSet || targetSet.has(target.nodeId));
    const evidence = input?.deterministicGraph
        ? { ...input, deterministicGraph: withLaneHandles(input.deterministicGraph) }
        : input;
    return [
        'You are reconstructing a directed, lane-level road topology from OpenStreetMap evidence.',
        'Return only the JSON object required by the supplied schema.',
        'The patch_json field must be a JSON-encoded object with connections, problems and imagery_observations arrays.',
        'Do not re-emit sections, nodes, lanes, profiles, or graph-entity geometry; the server preserves and validates them.',
        'imagery_observations is the only place to return newly observed physical geometry.',
        'Each connection needs only fromLaneId, toLaneId, type, priority, confidence, and a short reason.',
        'The server creates connection IDs, node IDs, and geometry from the referenced lane endpoints.',
        '',
        'Work:',
        ...(targetSet ? [`- This run is limited to targetNodeIds: ${JSON.stringify(input.targetNodeIds)}. `
            + 'Return connections and problems only for these nodes; give every problem a nodeIds '
            + 'array containing only target nodes. Leave every other node open.'] : []),
        targets.length
            ? '- Decide the lane-to-lane movements at these junction nodes, and only these. Where '
                + 'openApproaches is given, only traffic ARRIVING on those sections is undecided — the '
                + 'other approaches at that node are already derived and must be left alone. Every '
                + 'movement already in the graph is kept whether or not you repeat it.'
            : '- No junction in this crop is unresolved. Return empty arrays unless the evidence '
                + 'contradicts a movement already in the graph.',
        JSON.stringify(targets),
        '',
        'Rules:',
        '- Refer to a lane by the short handle in graph.lanes[].id (L0, L1, …). Copy a handle exactly '
            + 'from the evidence; never invent, abbreviate or renumber one.',
        '- A node the graph has already answered is closed: a connection there is discarded and '
            + 'reported, so spend no effort outside the listed nodes.',
        '- Preserve source section and lane geometry unless the evidence explicitly requires a correction.',
        '- Never treat an OSM tag as proof of physical reality when tags contradict each other.',
        '- An ordinary merge is binary: at most two incoming lanes and one outgoing lane; identify the continuing and yielding lane.',
        '- An ordinary split is binary: one incoming lane and at most two outgoing lanes. Stage larger changes as ordered events.',
        '- A lane may have multiple alternative permitted intersection movements; label them turn. They are not simultaneous physical merges or splits.',
        '- If the available lane graph cannot stage a non-binary physical transition, retain the best-supported connections and add a nonbinary_transition problem.',
        '- Respect oneway, access, PSV, tram, turn-lane and restriction evidence.',
        '- When orthophoto evidence is attached, inspect orthophoto.jpg before deciding physical continuations, tapers, splits or merges.',
        '- The orthophoto is north-up and spatially registered by the imagery metadata in the evidence package.',
        ...(input?.imagery?.source?.key === 'dgu_dof_lidar_2022_2023'
            ? ['- The DGU orthophoto has a translucent GEOPORTAL watermark. Ignore the watermark when tracing road markings and describe obscured details as uncertain.']
            : []),
        '- Treat imagery as physical evidence from its capture date, not as proof of current legal access or turn permissions.',
        '- Record visible physical geometry in imagery_observations. Use normalized image coordinates [x,y] from 0 to 1, with [0,0] at the top-left.',
        '- Supported observation kinds: road_edge, lane_divider, median_edge, stop_line, taper_start, merge_point and split_point.',
        '- Line observations need ordered points following the visible feature. Point observations need one point.',
        '- Every observation must include confidence, a short reason, and sourceWayIds from the supplied OSM evidence; include sectionIds or laneIds when identifiable.',
        '- Do not measure lane widths. A separate width analysis owns that measurement at a higher imagery resolution; record only the structure you can see.',
        '- Only record visible evidence. Omit occluded or guessed geometry and explain uncertainty as a problem instead.',
        '- Retain unresolved ambiguity as a problem with severity and evidence. Do not hallucinate missing connections.',
        '- Before closing an approach, account for EVERY public incoming driving lane on it. Each '
            + 'must have at least one accepted outgoing movement; if any lane remains uncertain, '
            + 'keep that approach unresolved and explain why in a node-scoped problem. Do not '
            + 'invent a movement merely to make the count complete.',
        '- Every connection must reference lane IDs present in graph.lanes.',
        '- A movement runs from a lane that ENDS at the junction node into a lane that STARTS there: '
            + 'fromLaneId must be a lane whose toNode is that node, and toLaneId a lane whose '
            + 'fromNode is that node. Each target below lists its legal handles as enterFrom and '
            + 'leaveInto — take fromLaneId from enterFrom and toLaneId from leaveInto, for the same '
            + 'target, and no other pairing is possible.',
        '- A two-way street contributes one lane arriving at the node and one leaving it. They differ '
            + 'only in direction, and the arriving one is never a valid destination.',
        '- A shared centre strip is represented by two directed lanes with the same physicalLaneId. '
            + 'They are opposite uses of one painted strip: decide each direction from its own endpoint, '
            + 'and do not treat it as two separate physical lanes.',
        '- Keep stable IDs from the deterministic graph whenever the same entity survives.',
        '',
        `Prompt version: ${TOPOLOGY_PROMPT_VERSION}`,
        '',
        'Evidence package:',
        JSON.stringify(evidence)
    ].join('\n');
}

// The shared subscription-CLI layer, loaded on first use rather than imported. It is a sibling
// checkout, not a dependency of this one, and it is not deployed — a hard import would take the
// whole backend down on a server where agents/ does not exist, while a recognition run there fails
// on its own, loudly, with the reason.
let cliLayerApi = null;
function cliLayer() {
    if (!cliLayerApi) cliLayerApi = createRequire(import.meta.url)('../../../agents/lib/llm-cost/cli.cjs');
    return cliLayerApi;
}

// Its metered-API sibling, loaded the same way and for the same reason.
let llmLayerApi = null;
function llmLayer() {
    if (!llmLayerApi) llmLayerApi = createRequire(import.meta.url)('../../../agents/lib/llm-cost/llm.cjs');
    return llmLayerApi;
}

// The model a provider runs when the caller names none: the shared layer's default, so a resume
// can recognise solutions stored under the model that answered (the route records the resolved id,
// never null). The CLIs follow their provider's default (defaults.json → cli.<engine>.provider).
export function defaultModelFor(provider) {
    assertTopologyProvider(provider);
    const llm = llmLayer();
    const layerProvider = provider === 'anthropic' ? 'anthropic' : llm.DEFAULTS.cli?.[provider]?.provider;
    return layerProvider ? llm.resolveCall(layerProvider).model : null;
}

// The job record's usage, filled from the layer's result. Persisting it per job is what says
// whether a prompt change doubled what a junction takes, even though the plan pays.
const count = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);

// One shape for every provider, because the comparison between them is the point. Fields a CLI
// does not report stay null rather than zero — a run that reported nothing and a run that cost
// nothing must not look alike.
function normalizeUsage(fields) {
    const usage = {
        // What the CLI actually ran, not an alias. A ledger keyed on an alias cannot be read back
        // in a year; the CLI names the resolved id.
        resolvedModel: null,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheCreationTokens: null,
        // What the same run would have cost on the metered API; the CLI itself bills a subscription.
        equivalentUsd: null,
        // What the run was actually charged: the metered API's price, 0 for a plan-billed CLI run.
        costUsd: null,
        durationMs: null,
        numTurns: null,
        ...fields
    };
    return Object.values(usage).some(value => value !== null) ? usage : null;
}

// A claude run bills more than one model: the CLI hands background chores (summarising a tool
// result, naming the session) to a small model, so `modelUsage` routinely carries a Haiku entry
// beside the Opus one that did the work. Whichever the CLI happened to list first then became the
// ledger's answer to "which model solved this junction" — an Opus run recorded as Haiku, which is
// the first-wins merge bug in miniature. The model that produced the answer is the one that spent
// the output tokens on it, so pick by that rather than by key order.
export function dominantModel(modelUsage) {
    const entries = Object.entries(modelUsage || {});
    if (!entries.length) return null;
    // Each entry carries its own costUSD, which is exactly "how much of this run was this model" —
    // measured on a real run, the chore model was 1.7% of the bill. Output tokens are the fallback
    // for an envelope that does not price its models.
    const weight = ([, usage]) => Number(usage?.costUSD)
        || Number(usage?.outputTokens ?? usage?.output_tokens) || 0;
    // Ties (including every-model-reports-zero) keep the CLI's own order, so this can only ever
    // improve on the old behaviour, never scramble a single-model run.
    return entries.reduce((best, entry) => (weight(entry) > weight(best) ? entry : best))[0] || null;
}

// The layer's result → the job's usage record. `raw` is claude's envelope (modelUsage, duration,
// turns); codex states none of those, and the layer names the model it passed explicitly. An API
// result's `raw` is the Messages response: no modelUsage or turns, `model` is the one that
// answered, `costUsd` is metered and there is no equivalent (it IS the price).
export function usageFromResult(result) {
    const usage = result?.usage;
    const envelope = result?.raw && typeof result.raw === 'object' ? result.raw : null;
    return normalizeUsage({
        resolvedModel: dominantModel(envelope?.modelUsage) || result?.model || null,
        inputTokens: count(usage?.input_tokens),
        outputTokens: count(usage?.output_tokens),
        cacheReadTokens: count(usage?.cache_read_input_tokens),
        cacheCreationTokens: count(usage?.cache_creation_input_tokens),
        equivalentUsd: count(result?.equivalentUsd),
        costUsd: count(result?.costUsd),
        durationMs: count(envelope?.duration_ms) ?? count(result?.ms),
        numTurns: count(envelope?.num_turns)
    });
}

// The answer is { summary, patch_json }: the patch travels as a string so the output schema stays
// flat enough for both CLIs' structured-output grammars, and is decoded here.
function parseRecognitionAnswer(data) {
    if (typeof data?.patch_json === 'string') {
        return { ...data, patch: JSON.parse(data.patch_json) };
    }
    return { ...(data || {}) };
}

export function validateCandidateGraph(candidate, deterministicGraph) {
    if (!candidate || !Array.isArray(candidate.sections) || !Array.isArray(candidate.nodes)
        || !Array.isArray(candidate.lanes) || !Array.isArray(candidate.connections)
        || !Array.isArray(candidate.problems)) {
        throw new Error('Provider returned an incomplete topology graph.');
    }
    const sectionIds = new Set(candidate.sections.map(section => section?.id).filter(Boolean));
    const laneIds = new Set(candidate.lanes.map(lane => lane?.id).filter(Boolean));
    if (laneIds.size !== candidate.lanes.length) throw new Error('Provider returned duplicate or missing lane IDs.');
    candidate.lanes.forEach(lane => {
        if (!sectionIds.has(lane.sectionId)) {
            throw new Error(`Lane ${lane.id || '(missing id)'} references missing section ${lane.sectionId}.`);
        }
    });
    candidate.connections.forEach(connection => {
        if (!laneIds.has(connection.fromLaneId) || !laneIds.has(connection.toLaneId)) {
            throw new Error(`Connection ${connection.id || '(missing id)'} references a missing lane.`);
        }
    });
    return {
        ...candidate,
        schemaVersion: deterministicGraph.schemaVersion,
        coverage: deterministicGraph.coverage,
        source: {
            ...(candidate.source || {}),
            osm: deterministicGraph.source
        },
        stats: {
            ...(deterministicGraph.stats || {}),
            sections: candidate.sections.length,
            nodes: candidate.nodes.length,
            lanes: candidate.lanes.length,
            connections: candidate.connections.length,
            problems: candidate.problems.length,
            sourceWays: deterministicGraph.stats?.sourceWays
                ?? deterministicGraph.source?.wayIds?.length
                ?? 0,
            unresolvedIntersections: candidate.problems.filter(
                problem => problem.type === 'unresolved_intersection'
            ).length,
            errors: candidate.problems.filter(problem => problem.severity === 'error').length,
            warnings: candidate.problems.filter(problem => problem.severity === 'warning').length,
            imageryObservations: candidate.observations?.imagery?.features?.length || 0
        }
    };
}

function laneEndpoint(lane, atEnd) {
    const coordinates = lane?.geometry?.coordinates;
    if (!Array.isArray(coordinates) || !coordinates.length) return null;
    return coordinates[atEnd ? coordinates.length - 1 : 0];
}

export function applyRecognitionPatch(patch, deterministicGraph, provider = 'model', context = {}) {
    if (!patch || !Array.isArray(patch.connections) || !Array.isArray(patch.problems)) {
        throw new Error('Provider returned an incomplete topology decision patch.');
    }
    const laneList = deterministicGraph.lanes || [];
    const targetSet = context.targetNodeIds ? new Set(context.targetNodeIds) : null;
    const laneById = new Map(laneList.map(lane => [lane.id, lane]));
    const sectionById = new Map((deterministicGraph.sections || []).map(section => [section.id, section]));
    // A handle is an index into graph.lanes; a full id still resolves, so an older provider's
    // output applies unchanged.
    const resolveLane = reference => {
        const handle = LANE_HANDLE.exec(String(reference ?? ''));
        return handle ? (laneList[Number(handle[1])] || null) : (laneById.get(reference) || null);
    };
    const seenPairs = new Set();
    // A malformed connection is DROPPED and reported, not thrown.
    //
    // It used to throw, which discarded the entire patch: five runs died this way, one of them on
    // connection 34 of 34 — thirty-three good movements destroyed by the last one — for 61 minutes
    // of model time that produced nothing at all. Refused-by-restriction and answered-the-wrong-node
    // movements have always been handled this way, and a movement between lanes that do not meet is
    // no different in kind: it is one bad answer among good ones.
    //
    // The two things that keep this honest are below: a patch where NOTHING survives still fails,
    // and an approach is only ever closed by a connection that was actually accepted, so dropping
    // one cannot quietly mark its junction settled.
    const malformed = [];
    const connections = [];
    patch.connections.forEach((decision, index) => {
        const reject = why => malformed.push(`connection ${index} ${why}`);
        const fromLane = resolveLane(decision?.fromLaneId);
        const toLane = resolveLane(decision?.toLaneId);
        if (!fromLane || !toLane) {
            reject(`references a lane that is not in the graph `
                + `(${decision?.fromLaneId} -> ${decision?.toLaneId})`);
            return;
        }
        if (!fromLane.toNode || fromLane.toNode !== toLane.fromNode) {
            // Overwhelmingly the commonest one: the arriving and departing lane of a two-way street
            // look alike apart from direction, and only about a quarter of naive pairings are legal.
            reject(`joins lanes that do not share a directed endpoint `
                + `(${decision?.fromLaneId} ends at ${fromLane.toNode || 'nowhere'}, `
                + `${decision?.toLaneId} starts at ${toLane.fromNode || 'nowhere'})`);
            return;
        }
        const pair = `${fromLane.id}->${toLane.id}`;
        if (seenPairs.has(pair)) return;
        seenPairs.add(pair);
        const fromPoint = laneEndpoint(fromLane, true);
        const toPoint = laneEndpoint(toLane, false);
        if (!fromPoint || !toPoint) {
            reject(`has missing lane geometry (${pair})`);
            return;
        }
        const type = ['continue', 'merge', 'split', 'turn'].includes(decision.type)
            ? decision.type
            : 'continue';
        const confidence = Number(decision.confidence);
        connections.push({
            id: `connection:${fromLane.toNode}:${pair}`,
            nodeId: fromLane.toNode,
            fromLaneId: fromLane.id,
            toLaneId: toLane.id,
            type,
            priority: String(decision.priority || (type === 'merge' ? 'yielding' : 'continuing')),
            confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.5,
            source: provider,
            reason: String(decision.reason || '').slice(0, 1000),
            geometry: {
                type: 'LineString',
                coordinates: [fromPoint, toPoint]
            }
        });
    });
    // A patch that proposed movements and had none survive is not a partial answer, it is a broken
    // one, and storing it would mark the junction answered with nothing in it.
    if (patch.connections.length && !connections.length) {
        throw new Error(`Every one of the ${patch.connections.length} returned movements was `
            + `unusable: ${malformed.slice(0, 3).join('; ')}`);
    }
    // The patch is a decision at the open APPROACHES, not a replacement graph. Before the rules
    // settled junctions there was nothing to lose by overwriting; now nine movements in ten are
    // derived, and a model answering one junction would have deleted the rest. What is already
    // decided is therefore off limits — which also contains a model that wanders, the commonest
    // failure measured.
    //
    // Openness is per approach because resolution is: a node can have three settled approaches and
    // one open. An unresolved_intersection with an empty openApproaches means the whole node is
    // open; a graph with no unresolved problems at all predates this and is taken as fully open.
    const openApproachesByNode = new Map();
    (deterministicGraph.problems || [])
        .filter(problem => problem.type === 'unresolved_intersection')
        .forEach(problem => (problem.nodeIds || []).forEach(nodeId => {
            const sections = (problem.openApproaches || []).map(entry => entry.sectionId).filter(Boolean);
            openApproachesByNode.set(nodeId, sections.length ? new Set(sections) : null);
        }));
    // A movement OSM forbids is refused here exactly as the deterministic rules refuse it. Reporting
    // it after the fact was not equivalent: a real batch of ten junctions came back with four
    // turn_restriction_violation errors, each a connection the builder itself would never have made.
    const restrictionsAtNode = restrictionIndex(context.restrictions);
    const wayOfLane = lane => String(lane?.sourceWayId
        ?? sectionById.get(lane?.sectionId)?.sourceWayId ?? '');
    const forbidden = connection => {
        const rules = restrictionsAtNode.get(connection.nodeId);
        if (!rules?.length) return false;
        const { PROHIBITIVE, MANDATORY } = restrictionsModule();
        const fromWayId = wayOfLane(laneById.get(connection.fromLaneId));
        const toWayId = wayOfLane(laneById.get(connection.toLaneId));
        if (rules.some(rule => PROHIBITIVE.test(rule.kind)
            && rule.fromWayId === fromWayId && rule.toWayId === toWayId)) return true;
        const only = rules.find(rule => MANDATORY.test(rule.kind) && rule.fromWayId === fromWayId);
        return !!(only && only.toWayId !== toWayId);
    };
    const permitted = connections.filter(connection => !forbidden(connection));
    const refused = connections.length - permitted.length;

    const derivedNodes = new Set((deterministicGraph.connections || []).map(connection => connection.nodeId));
    const isOpen = connection => {
        if (openApproachesByNode.has(connection.nodeId)) {
            const sections = openApproachesByNode.get(connection.nodeId);
            return !sections || sections.has(laneById.get(connection.fromLaneId)?.sectionId);
        }
        return !derivedNodes.has(connection.nodeId);
    };
    const accepted = permitted.filter(connection =>
        (!targetSet || targetSet.has(connection.nodeId)) && isOpen(connection));
    const overreach = permitted.length - accepted.length;
    // A model can answer one lane on a multi-lane approach and omit its neighbour. That is a
    // partial answer, not evidence that the entire approach (or node) is settled.
    const assignedFrom = new Set([...(deterministicGraph.connections || []), ...accepted]
        .map(connection => connection.fromLaneId));
    const requiredIncoming = (nodeId, sectionId) => laneList.filter(lane =>
        lane.toNode === nodeId && (!sectionId || lane.sectionId === sectionId)
        && lane.type === 'driving'
        && !['no', 'private'].includes(lane.access));
    const allIncomingAssigned = (nodeId, sectionId) => {
        const required = requiredIncoming(nodeId, sectionId);
        return required.length > 0 && required.every(lane => assignedFrom.has(lane.id));
    };
    const answeredApproaches = new Set(accepted.flatMap(connection => {
        const sectionId = laneById.get(connection.fromLaneId)?.sectionId;
        return sectionId && allIncomingAssigned(connection.nodeId, sectionId)
            ? [`${connection.nodeId}|${sectionId}`] : [];
    }));
    const answeredNodes = new Set(accepted.filter(connection =>
        allIncomingAssigned(connection.nodeId)).map(connection => connection.nodeId));

    const modelProblems = patch.problems.filter(problem => !targetSet
        || (Array.isArray(problem?.nodeIds) && problem.nodeIds.length > 0
            && problem.nodeIds.every(nodeId => targetSet.has(nodeId)))).map((problem, index) => ({
        ...problem,
        id: String(problem?.id || `problem:${provider}:${index}`),
        type: String(problem?.type || 'model_uncertainty'),
        severity: ['info', 'warning', 'error'].includes(problem?.severity)
            ? problem.severity
            : 'warning',
        message: String(problem?.message || 'The model left this topology decision unresolved.')
    }));
    // Findings the model was never asked about — a parcel too narrow for its lanes — survive, minus
    // the "unresolved" note on every junction it has now answered. Same id means the model's version
    // wins, so re-emitting a problem restates it rather than duplicating it.
    const byId = new Map();
    const errorNodes = new Set(modelProblems.filter(problem => problem.severity === 'error')
        .flatMap(problem => problem.nodeIds || []));
    (deterministicGraph.problems || []).forEach(problem => {
        if (problem.type !== 'unresolved_intersection') {
            byId.set(problem.id, problem);
            return;
        }
        const nodeIds = problem.nodeIds || [];
        if (nodeIds.some(nodeId => errorNodes.has(nodeId))) {
            // A connected node still needs work when the model reports a physical topology error.
            byId.set(problem.id, problem);
            return;
        }
        const listed = problem.openApproaches || [];
        if (!listed.length) {
            // Whole node was open: answering it at all closes it, as before.
            if (nodeIds.some(nodeId => answeredNodes.has(nodeId))) return;
            byId.set(problem.id, problem);
            return;
        }
        // Only the approaches the model actually answered close. A node with one approach left is
        // still unresolved, and saying otherwise would hide the remaining work.
        const stillOpen = listed.filter(entry => !nodeIds.some(
            nodeId => answeredApproaches.has(`${nodeId}|${entry.sectionId}`)
        ));
        if (!stillOpen.length) return;
        byId.set(problem.id, stillOpen.length === listed.length
            ? problem
            : { ...problem, openApproaches: stillOpen });
    });
    modelProblems.forEach(problem => {
        // A model cannot overwrite an unrelated deterministic finding by reusing its ID.
        if (targetSet && byId.has(problem.id)) return;
        byId.set(problem.id, problem);
    });
    if (refused) {
        byId.set(`problem:${provider}:restricted-movements`, {
            id: `problem:${provider}:restricted-movements`,
            type: 'movements_against_restrictions',
            severity: 'warning',
            message: `${refused} returned movements are forbidden by an OSM turn restriction and were `
                + 'refused; the deterministic rules never emit these, so a patch may not either.'
        });
    }
    if (malformed.length) {
        // Loud, and with the offending references in it: the whole reason this class of failure went
        // five occurrences without a diagnosis is that nothing ever recorded WHAT the model said.
        byId.set(`problem:${provider}:malformed-movements`, {
            id: `problem:${provider}:malformed-movements`,
            type: 'malformed_movements',
            severity: 'warning',
            message: `${malformed.length} returned movements could not be used and were dropped; `
                + `the approaches they were meant to answer stay open. ${malformed.slice(0, 5).join('; ')}`
                + (malformed.length > 5 ? `; and ${malformed.length - 5} more` : '')
        });
    }
    if (overreach) {
        // Never a silent drop: a model spending its answer on the wrong nodes looks exactly like a
        // model that found little to say.
        byId.set(`problem:${provider}:outside-the-work`, {
            id: `problem:${provider}:outside-the-work`,
            type: 'movements_outside_the_work',
            severity: 'warning',
            message: `${overreach} returned movements sat at nodes the deterministic rules had `
                + 'already answered and were discarded; only unresolved junctions are open to a patch.'
        });
    }
    const problems = [...byId.values()];
    const fanOut = new Map();
    const fanIn = new Map();
    (targetSet ? accepted : connections).filter(connection => connection.type !== 'turn').forEach(connection => {
        if (!fanOut.has(connection.fromLaneId)) fanOut.set(connection.fromLaneId, []);
        if (!fanIn.has(connection.toLaneId)) fanIn.set(connection.toLaneId, []);
        fanOut.get(connection.fromLaneId).push(connection);
        fanIn.get(connection.toLaneId).push(connection);
    });
    [...fanOut.entries()].filter(([, entries]) => entries.length > 2).forEach(([laneId, entries]) => {
        const lane = laneById.get(laneId);
        problems.push({
            id: `problem:${provider}:nonbinary-split:${laneId}`,
            type: 'nonbinary_transition',
            severity: 'error',
            point: laneEndpoint(lane, true),
            laneIds: [...new Set([laneId, ...entries.map(entry => entry.toLaneId)])],
            message: `Physical split has ${entries.length} non-turn successors and must be staged into binary events.`
        });
    });
    [...fanIn.entries()].filter(([, entries]) => entries.length > 2).forEach(([laneId, entries]) => {
        const lane = laneById.get(laneId);
        problems.push({
            id: `problem:${provider}:nonbinary-merge:${laneId}`,
            type: 'nonbinary_transition',
            severity: 'error',
            point: laneEndpoint(lane, false),
            laneIds: [...new Set([...entries.map(entry => entry.fromLaneId), laneId])],
            message: `Physical merge has ${entries.length} non-turn predecessors and must be staged into binary events.`
        });
    });
    const imageryFeatures = normalizeImageryObservations(
        patch.imagery_observations,
        context.imagery,
        provider
    );
    const observations = imageryFeatures.length
        ? {
            ...(deterministicGraph.observations || {}),
            imagery: {
                source: context.imagery.source,
                bbox: context.imagery.bbox,
                width: context.imagery.width,
                height: context.imagery.height,
                effectiveGsdM: context.imagery.effectiveGsdM,
                features: imageryFeatures
            }
        }
        : deterministicGraph.observations;
    return validateCandidateGraph({
        ...deterministicGraph,
        connections: [...(deterministicGraph.connections || []), ...accepted],
        problems,
        ...(observations ? { observations } : {})
    }, deterministicGraph);
}

// One junction through one provider: the metered API (`anthropic`, llm.cjs) or a subscription CLI
// (`claude` | `codex`, cli.cjs). The request — crop by path, prompt, schema, no model id — is the
// same for all three; only the transport and who pays differ.
export async function runTopologyProvider(provider, input, options = {}) {
    assertTopologyProvider(provider);
    if (options.imageBuffer && !modelAcceptsImagery(options.model)) {
        throw new Error(`Model ${options.model} takes text only; run it with imagery disabled `
            + 'rather than letting it answer from the tags while a crop goes unread.');
    }
    const jobDir = await mkdtemp(join(tmpdir(), `lane-topology-${provider}-`));
    const imagePath = options.imageBuffer ? join(jobDir, 'orthophoto.jpg') : null;
    try {
        if (imagePath) await writeFile(imagePath, options.imageBuffer);
        // Injectable so a test exercises everything around the model call without a CLI, and
        // without writing invented usage into the shared ledger: only the real layer ledgers.
        const ledger = {
            repo: 'consensus-builder',
            script: 'lane-topology-recognition',
            // jobId on the ledger row is what keeps ledger-backfill.js from writing the run twice.
            meta: {
                provider,
                promptVersion: TOPOLOGY_PROMPT_VERSION,
                ...(options.jobId !== undefined && options.jobId !== null ? { jobId: options.jobId } : {})
            }
        };
        const timeoutMs = options.timeoutMs || PROVIDER_TIMEOUT_MS[provider];
        const createLlm = options.createLlm || (config => llmLayer().createLlm(config));
        const createCliLlm = options.createCliLlm || (config => cliLayer().createCliLlm(config));
        const complete = options.complete || (provider === 'anthropic'
            // A raw client: the layer ledgers every call itself. Its timeout is the provider ceiling.
            ? request => createLlm({ ...ledger, client: new Anthropic({ timeout: timeoutMs }) }).complete(request)
            : request => createCliLlm({
                ...ledger,
                engine: provider,
                // The job directory holds the crop, so claude's Read tool may open it from here.
                cwd: jobDir,
                timeoutMs
            }).complete(request));
        const startedAt = Date.now();
        let result;
        try {
            result = await complete({
                content: [
                    ...(imagePath ? [{ type: 'image', path: imagePath }] : []),
                    buildRecognitionPrompt(input)
                ],
                schema: TOPOLOGY_OUTPUT_SCHEMA,
                // No model unless the caller overrides one: the layer's default is the model.
                ...(options.model ? { model: options.model } : {}),
                // Codex has run this task at medium effort since it was measured; claude and the API take
                // the layer's default (the default model, not a cheap tier: a junction is a judgment call).
                ...(provider === 'codex'
                    ? { effort: options.reasoningEffort || process.env.LANE_TOPOLOGY_CODEX_REASONING_EFFORT || 'medium' }
                    : (options.reasoningEffort ? { effort: options.reasoningEffort } : {})),
                meta: {
                    city: input.selection?.city ?? null,
                    bbox: input.selection?.bbox ?? null,
                    imagery: input.imagery?.source ?? null
                }
            });
        } catch (error) {
            // The job record keeps `error.outputTail` in preference to the stack; the layer's
            // message carries the CLI's own reason (a quota refusal included), and the envelope
            // whatever the model did say.
            if (!error.outputTail) {
                error.outputTail = [error.message, error.raw ? JSON.stringify(error.raw) : '']
                    .filter(Boolean).join('\n').slice(-8000);
            }
            throw error;
        }
        // The CLI layer times its own run; an API result does not, so the wall clock stands in.
        const usage = usageFromResult({ ...result, ms: result.ms ?? Date.now() - startedAt });
        const outputTail = String(result.data ? JSON.stringify(result.data) : (result.text ?? '')).slice(-8000);
        let parsed;
        let graph;
        try {
            parsed = parseRecognitionAnswer(result.data);
            graph = applyRecognitionPatch(parsed.patch, input.deterministicGraph, provider, {
                imagery: input.imagery,
                restrictions: input.restrictions,
                targetNodeIds: input.targetNodeIds
            });
        } catch (error) {
            // The job record keeps `error.outputTail` in preference to the stack, so without this
            // a rejected patch was replaced by OUR OWN stack trace and the model's answer was gone.
            // That is why the malformed-movement failures sat undiagnosed across five jobs and two
            // providers: the evidence was destroyed at the moment it was needed.
            error.outputTail = `PATCH REJECTED: ${error.message}\n\n`
                + `--- what the model returned ---\n${outputTail}`;
            throw error;
        }
        return {
            summary: String(parsed.summary || ''),
            graph,
            usage,
            outputTail
        };
    } finally {
        await rm(jobDir, { recursive: true, force: true });
    }
}
