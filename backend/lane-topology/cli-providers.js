import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { normalizeImageryObservations } from './imagery-observations.js';

export const TOPOLOGY_PROMPT_VERSION = 'lane-topology-v10';
// Both providers answer the same question about the same crop, so they get the same ceiling. Codex
// kept 10 minutes from when its runs averaged 222 s; measured against this prompt a junction takes
// 337–911 s, so the shorter ceiling would have cut off work the other provider is allowed to finish.
export const PROVIDER_TIMEOUT_MS = Object.freeze({
    codex: 15 * 60 * 1000,
    claude: 15 * 60 * 1000
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

const MAX_OUTPUT_CHARS = 500_000;

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
    return (graph?.problems || [])
        .filter(problem => problem.type === 'unresolved_intersection')
        .flatMap(problem => (problem.nodeIds || []).map(nodeId => ({
            nodeId,
            arms: degreeOf.get(nodeId) ?? null,
            whyUnsettled: problem.declineReason || null,
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

export function providerCommand(provider) {
    if (provider === 'codex') {
        return {
            command: 'codex',
            args: ({ jobDir, schemaPath, outputPath, imagePath, model, reasoningEffort }) => [
                'exec',
                // Events as JSONL, which is the only place Codex states its token usage. The answer
                // still comes from --output-last-message, so stdout is free to carry the accounting.
                '--json',
                ...(model ? ['--model', model] : []),
                '--config', `model_reasoning_effort="${reasoningEffort || 'medium'}"`,
                '--skip-git-repo-check',
                '--ephemeral',
                '--sandbox', 'read-only',
                '--cd', jobDir,
                '--output-schema', schemaPath,
                '--output-last-message', outputPath,
                ...(imagePath ? ['--image', imagePath] : []),
                '-'
            ]
        };
    }
    if (provider === 'claude') {
        return {
            command: 'claude',
            args: ({ jobDir, imagePath, model } = {}) => [
                '--print',
                '--safe-mode',
                '--no-session-persistence',
                '--no-chrome',
                '--tools', imagePath ? 'Read' : '',
                ...(imagePath ? ['--add-dir', jobDir] : []),
                ...(model ? ['--model', model] : []),
                '--output-format', 'json',
                '--json-schema', JSON.stringify(TOPOLOGY_OUTPUT_SCHEMA)
            ]
        };
    }
    throw new Error(`Unknown topology provider "${provider}".`);
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

export function providerAvailability(provider, spawnSyncImpl = spawnSync) {
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
    const targets = recognitionTargets(input?.deterministicGraph);
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
        '- Treat imagery as physical evidence from its capture date, not as proof of current legal access or turn permissions.',
        '- Record visible physical geometry in imagery_observations. Use normalized image coordinates [x,y] from 0 to 1, with [0,0] at the top-left.',
        '- Supported observation kinds: road_edge, lane_divider, median_edge, stop_line, taper_start, merge_point and split_point.',
        '- Line observations need ordered points following the visible feature. Point observations need one point.',
        '- Every observation must include confidence, a short reason, and sourceWayIds from the supplied OSM evidence; include sectionIds or laneIds when identifiable.',
        '- Do not measure lane widths. A separate width analysis owns that measurement at a higher imagery resolution; record only the structure you can see.',
        '- Only record visible evidence. Omit occluded or guessed geometry and explain uncertainty as a problem instead.',
        '- Retain unresolved ambiguity as a problem with severity and evidence. Do not hallucinate missing connections.',
        '- Every connection must reference lane IDs present in graph.lanes.',
        '- Keep stable IDs from the deterministic graph whenever the same entity survives.',
        '',
        `Prompt version: ${TOPOLOGY_PROMPT_VERSION}`,
        '',
        'Evidence package:',
        JSON.stringify(evidence)
    ].join('\n');
}

function boundedAppend(existing, addition) {
    const combined = existing + String(addition || '');
    return combined.length <= MAX_OUTPUT_CHARS ? combined : combined.slice(combined.length - MAX_OUTPUT_CHARS);
}

function cliFailureDetail(stdout, stderr) {
    const output = [stderr, stdout].filter(Boolean).join('\n');
    // Only stderr, and deliberately not stdout: a CLI echoes the prompt, so the evidence package's
    // own problem messages are `"message": "..."` matches too — and being last, they won. A Codex
    // quota refusal was reported as "4 road arms meet here", which also defeated the runner's
    // quota check and would have turned one stop into a whole batch of identical failures.
    const apiMessages = [...String(stderr || '').matchAll(/"message"\s*:\s*"([^"]+)"/g)]
        .map(match => match[1].replaceAll('\\"', '"'));
    if (apiMessages.length) return apiMessages.at(-1);
    const errorLine = [...String(stderr || '').matchAll(/^\s*ERROR:\s*(.+)$/gm)]
        .map(match => match[1].trim())
        .filter(line => line && !line.startsWith('{'));
    if (errorLine.length) return errorLine.at(-1).slice(-1800);
    for (const source of [stderr, stdout]) {
        if (!String(source || '').trim()) continue;
        try {
            const parsed = JSON.parse(source);
            const candidates = [
                parsed?.error?.message,
                typeof parsed?.error === 'string' ? parsed.error : null,
                parsed?.message,
                typeof parsed?.result === 'string' ? parsed.result : null
            ].filter(value => typeof value === 'string' && value.trim());
            if (candidates.length) return candidates.at(-1).slice(-1800);
        } catch (_) {
            // Fall through to the bounded plain-text tail.
        }
    }
    const fallback = output
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .slice(-8)
        .join(' ')
        .slice(-1800);
    return fallback || 'No error details were emitted.';
}

function cliFailure(message, stdout, stderr) {
    const error = new Error(message);
    error.outputTail = `${stdout}\n${stderr}`.slice(-8000);
    return error;
}

function runSpawn(command, args, prompt, options = {}) {
    const spawnImpl = options.spawnImpl || spawn;
    const timeoutMs = Number(options.timeoutMs) || 10 * 60 * 1000;
    return new Promise((resolve, reject) => {
        const child = spawnImpl(command, args, {
            cwd: options.cwd,
            env: options.env || process.env,
            stdio: ['pipe', 'pipe', 'pipe']
        });
        let stdout = '';
        let stderr = '';
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            child.kill('SIGTERM');
            reject(cliFailure(
                `${command} topology recognition timed out after ${timeoutMs} ms.`,
                stdout,
                stderr
            ));
        }, timeoutMs);
        child.stdout?.on('data', chunk => { stdout = boundedAppend(stdout, chunk); });
        child.stderr?.on('data', chunk => { stderr = boundedAppend(stderr, chunk); });
        child.on('error', error => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(cliFailure(error.message || String(error), stdout, stderr));
        });
        child.on('close', (code, signal) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (code !== 0) {
                if (code === null && signal) {
                    reject(cliFailure(`${command} was terminated by ${signal}.`, stdout, stderr));
                    return;
                }
                reject(cliFailure(
                    `${command} exited ${code}: ${cliFailureDetail(stdout, stderr)}`,
                    stdout,
                    stderr
                ));
                return;
            }
            resolve({ stdout, stderr });
        });
        child.stdin?.end(prompt);
    });
}

// The CLI reports its token usage in the envelope, ahead of the answer. Reading it here is the only
// reliable place: by the time the run is a stored output tail, a large patch has pushed the counts
// out of the tail entirely. Subscription-billed runs still need the counts — they are what says
// whether a prompt change doubled the cost.
const count = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);

// One shape for every provider, because the comparison between them is the point. Fields a CLI
// does not report stay null rather than zero — a run that reported nothing and a run that cost
// nothing must not look alike.
function normalizeUsage(fields) {
    const usage = {
        // What the CLI actually ran, not the alias we asked for. `opus` moves between releases, so
        // a ledger keyed on it cannot be read back in a year; the CLI names the resolved id.
        resolvedModel: null,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheCreationTokens: null,
        // What the same run would have cost on the metered API; the CLI itself bills a subscription.
        equivalentUsd: null,
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
    const weight = ([, usage]) => Number(usage?.outputTokens ?? usage?.output_tokens) || 0;
    // Ties (including every-model-reports-zero) keep the CLI's own order, so this can only ever
    // improve on the old behaviour, never scramble a single-model run.
    return entries.reduce((best, entry) => (weight(entry) > weight(best) ? entry : best))[0] || null;
}

// Claude prints one JSON envelope carrying its own usage and a costed equivalent.
function claudeUsage(envelope) {
    const usage = envelope?.usage;
    const cost = Number(envelope?.total_cost_usd);
    if (!usage && !Number.isFinite(cost)) return null;
    return normalizeUsage({
        // modelUsage is keyed by the resolved model id.
        resolvedModel: dominantModel(envelope?.modelUsage),
        inputTokens: count(usage?.input_tokens),
        outputTokens: count(usage?.output_tokens),
        cacheReadTokens: count(usage?.cache_read_input_tokens),
        cacheCreationTokens: count(usage?.cache_creation_input_tokens),
        equivalentUsd: Number.isFinite(cost) ? cost : null,
        durationMs: count(envelope?.duration_ms),
        numTurns: count(envelope?.num_turns)
    });
}

// Codex streams JSONL events and reports usage on turn.completed — one per exec run, covering the
// whole run including its tool calls, so these sum rather than supersede. It states no cost, and
// inventing one from a price table would be a guess dressed as a measurement, so it stays null.
function codexUsage(stdout) {
    const totals = { input: 0, cached: 0, cacheWrite: 0, output: 0, turns: 0 };
    String(stdout || '').split('\n').forEach(line => {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) return;
        let event;
        try {
            event = JSON.parse(trimmed);
        } catch (_) {
            return;
        }
        if (event?.type !== 'turn.completed' || !event.usage) return;
        totals.turns += 1;
        // OpenAI counts input_tokens INCLUSIVE of the cached ones, where Anthropic reports the two
        // disjoint. The shared rate table assumes Anthropic's convention, so charging this verbatim
        // would bill the cached tokens twice — at full rate and again at the cache rate. On a real
        // junction that is 262,503 billed instead of 92,007, a threefold overstatement.
        totals.input += Number(event.usage.input_tokens) || 0;
        totals.cached += Number(event.usage.cached_input_tokens) || 0;
        totals.cacheWrite += Number(event.usage.cache_write_input_tokens) || 0;
        totals.output += Number(event.usage.output_tokens) || 0;
        // Reasoning tokens are billed as output and are invisible otherwise.
        totals.output += Number(event.usage.reasoning_output_tokens) || 0;
    });
    if (!totals.turns) return null;
    return normalizeUsage({
        inputTokens: Math.max(0, totals.input - totals.cached),
        outputTokens: totals.output,
        cacheReadTokens: totals.cached,
        cacheCreationTokens: totals.cacheWrite,
        numTurns: totals.turns
    });
}

export function providerUsage(provider, stdout, envelope) {
    return provider === 'codex' ? codexUsage(stdout) : claudeUsage(envelope);
}

// The shared ledger in agents/lib/llm-cost, which answers "what has the machine spent on
// models" across every repo. It is a sibling checkout, not a dependency of this one, and it is
// not deployed — so this is a soft link that says when it is missing rather than a hard import
// that would take the backend down on a server where agents/ does not exist.
let ledgerApi;
function costLedger() {
    if (ledgerApi !== undefined) return ledgerApi;
    try {
        ledgerApi = createRequire(import.meta.url)('../../../agents/lib/llm-cost/index.cjs');
    } catch (error) {
        console.warn('[lane-topology] shared cost ledger unavailable, recording usage locally only:',
            error.message);
        ledgerApi = null;
    }
    return ledgerApi;
}

// What the same tokens would have cost on the metered API, when the shared table knows the model.
// computeCost throws on an unpriced model by design — that refusal is the feature, so it is caught
// here and turned into "unknown" rather than allowed to fail the run or invent a number.
function meteredEquivalent(ledger, model, usage) {
    try {
        return ledger.computeCost(model, {
            input_tokens: usage.inputTokens ?? 0,
            output_tokens: usage.outputTokens ?? 0,
            cache_read_input_tokens: usage.cacheReadTokens ?? 0,
            cache_creation_input_tokens: usage.cacheCreationTokens ?? 0
        });
    } catch (_) {
        return null;
    }
}

// Recognition is billed to a Max or ChatGPT subscription, so it costs no money at the margin.
// The tokens still matter — they are what says whether a prompt change doubled what a junction
// takes — and Claude's own costed equivalent rides along without ever counting as spend.
export function ledgerRecognitionRun({ provider, model, usage, meta = {} }) {
    const ledger = costLedger();
    if (!ledger || !usage) return null;
    // The CLI names the model it resolved to when it can; when it cannot, the model we ASKED for is
    // still known — we passed it on the command line. Falling back to the provider name was giving
    // up information we had.
    const billed = usage.resolvedModel || model || provider;
    try {
        return ledger.recordSubscriptionRun({
            repo: 'consensus-builder',
            script: 'lane-topology-recognition',
            model: billed,
            usage,
            // A CLI that states its own cost is preferred; otherwise price it from the shared rate
            // table, which is why the table is shared. An unpriced model yields null rather than a
            // guess, and adding its rate later starts pricing these runs with no code change.
            equivalentUsd: Number.isFinite(usage.equivalentUsd)
                ? usage.equivalentUsd
                : meteredEquivalent(ledger, billed, usage),
            meta: { provider, promptVersion: TOPOLOGY_PROMPT_VERSION, ...meta }
        });
    } catch (error) {
        // Accounting must never take down the work it is accounting for.
        console.warn('[lane-topology] cost ledger write failed:', error.message);
        return null;
    }
}

function parseProviderOutput(provider, stdout, outputFileText) {
    let parsed;
    let usage = null;
    if (provider === 'codex') {
        parsed = JSON.parse(outputFileText);
        usage = providerUsage('codex', stdout);
    } else {
        const envelope = JSON.parse(stdout);
        usage = providerUsage(provider, stdout, envelope);
        const candidate = envelope.structured_output ?? envelope.result ?? envelope;
        parsed = typeof candidate === 'string' ? JSON.parse(candidate) : candidate;
    }
    if (typeof parsed?.patch_json === 'string') {
        return { ...parsed, usage, patch: JSON.parse(parsed.patch_json) };
    }
    return { ...parsed, usage };
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
    const laneById = new Map(laneList.map(lane => [lane.id, lane]));
    const sectionById = new Map((deterministicGraph.sections || []).map(section => [section.id, section]));
    // A handle is an index into graph.lanes; a full id still resolves, so an older provider's
    // output applies unchanged.
    const resolveLane = reference => {
        const handle = LANE_HANDLE.exec(String(reference ?? ''));
        return handle ? (laneList[Number(handle[1])] || null) : (laneById.get(reference) || null);
    };
    const seenPairs = new Set();
    const connections = patch.connections.map((decision, index) => {
        const fromLane = resolveLane(decision?.fromLaneId);
        const toLane = resolveLane(decision?.toLaneId);
        if (!fromLane || !toLane) {
            throw new Error(`Patch connection ${index} references a missing lane.`);
        }
        if (!fromLane.toNode || fromLane.toNode !== toLane.fromNode) {
            throw new Error(
                `Patch connection ${index} joins lanes that do not share a directed endpoint.`
            );
        }
        const pair = `${fromLane.id}->${toLane.id}`;
        if (seenPairs.has(pair)) throw new Error(`Patch contains duplicate connection ${pair}.`);
        seenPairs.add(pair);
        const fromPoint = laneEndpoint(fromLane, true);
        const toPoint = laneEndpoint(toLane, false);
        if (!fromPoint || !toPoint) throw new Error(`Patch connection ${pair} has missing lane geometry.`);
        const type = ['continue', 'merge', 'split', 'turn'].includes(decision.type)
            ? decision.type
            : 'continue';
        const confidence = Number(decision.confidence);
        return {
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
        };
    });
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
    const accepted = permitted.filter(isOpen);
    const overreach = permitted.length - accepted.length;
    const answeredApproaches = new Set(accepted.map(connection => (
        `${connection.nodeId}|${laneById.get(connection.fromLaneId)?.sectionId}`
    )));
    const answeredNodes = new Set(accepted.map(connection => connection.nodeId));

    const modelProblems = patch.problems.map((problem, index) => ({
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
    (deterministicGraph.problems || []).forEach(problem => {
        if (problem.type !== 'unresolved_intersection') {
            byId.set(problem.id, problem);
            return;
        }
        const nodeIds = problem.nodeIds || [];
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
    modelProblems.forEach(problem => byId.set(problem.id, problem));
    if (refused) {
        byId.set(`problem:${provider}:restricted-movements`, {
            id: `problem:${provider}:restricted-movements`,
            type: 'movements_against_restrictions',
            severity: 'warning',
            message: `${refused} returned movements are forbidden by an OSM turn restriction and were `
                + 'refused; the deterministic rules never emit these, so a patch may not either.'
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
    connections.filter(connection => connection.type !== 'turn').forEach(connection => {
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

export async function runCliTopologyProvider(provider, input, options = {}) {
    const definition = providerCommand(provider);
    if (options.imageBuffer && !modelAcceptsImagery(options.model)) {
        throw new Error(`Model ${options.model} takes text only; run it with imagery disabled `
            + 'rather than letting it answer from the tags while a crop goes unread.');
    }
    const jobDir = await mkdtemp(join(tmpdir(), `lane-topology-${provider}-`));
    const schemaPath = join(jobDir, 'output-schema.json');
    const outputPath = join(jobDir, 'output.json');
    const imagePath = options.imageBuffer ? join(jobDir, 'orthophoto.jpg') : null;
    try {
        await writeFile(schemaPath, JSON.stringify(TOPOLOGY_OUTPUT_SCHEMA), 'utf8');
        if (imagePath) await writeFile(imagePath, options.imageBuffer);
        const prompt = buildRecognitionPrompt(input);
        const args = definition.args({
            jobDir,
            schemaPath,
            outputPath,
            imagePath,
            model: options.model,
            reasoningEffort: options.reasoningEffort
                || process.env.LANE_TOPOLOGY_CODEX_REASONING_EFFORT
                || 'medium'
        });
        const result = await runSpawn(definition.command, args, prompt, {
            ...options,
            timeoutMs: options.timeoutMs
                || PROVIDER_TIMEOUT_MS[provider]
                || PROVIDER_TIMEOUT_MS.codex,
            cwd: jobDir
        });
        // Injectable for the same reason the spawn is: a test must be able to exercise the parsing
        // without a real CLI writing a real file.
        const readFileImpl = options.readFileImpl || (path => readFile(path, 'utf8'));
        const outputFileText = provider === 'codex' ? await readFileImpl(outputPath) : '';
        const parsed = parseProviderOutput(provider, result.stdout, outputFileText);
        // Ledger the run before the patch is applied: a patch this run cannot validate is still a
        // run whose tokens were spent, and an accounting that only counts successes understates.
        // An injected spawn means no CLI ran and no tokens were spent, so there is nothing to
        // account for. Without this the test suite wrote its fixtures into the shared ledger —
        // seven rows of invented usage sitting beside real spend, which is worse than none.
        if (options.ledger !== false && !options.spawnImpl) {
            ledgerRecognitionRun({
                provider,
                model: options.model,
                usage: parsed.usage,
                meta: {
                    city: input.selection?.city ?? null,
                    bbox: input.selection?.bbox ?? null,
                    imagery: input.imagery?.source ?? null
                }
            });
        }
        return {
            summary: String(parsed.summary || ''),
            graph: applyRecognitionPatch(parsed.patch, input.deterministicGraph, provider, {
                imagery: input.imagery,
                restrictions: input.restrictions
            }),
            usage: parsed.usage || null,
            outputTail: `${result.stdout}\n${result.stderr}`.slice(-8000)
        };
    } finally {
        await rm(jobDir, { recursive: true, force: true });
    }
}
