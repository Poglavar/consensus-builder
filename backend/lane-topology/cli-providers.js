import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { normalizeImageryObservations } from './imagery-observations.js';

export const TOPOLOGY_PROMPT_VERSION = 'lane-topology-v9';
export const PROVIDER_TIMEOUT_MS = Object.freeze({
    codex: 10 * 60 * 1000,
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

export function providerCommand(provider) {
    if (provider === 'codex') {
        return {
            command: 'codex',
            args: ({ jobDir, schemaPath, outputPath, imagePath, model, reasoningEffort }) => [
                'exec',
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
    return [
        'You are reconstructing a directed, lane-level road topology from OpenStreetMap evidence.',
        'Return only the JSON object required by the supplied schema.',
        'The patch_json field must be a JSON-encoded object with complete connections, problems and imagery_observations arrays.',
        'Do not re-emit sections, nodes, lanes, profiles, or graph-entity geometry; the server preserves and validates them.',
        'imagery_observations is the only place to return newly observed physical geometry.',
        'Each connection needs only fromLaneId, toLaneId, type, priority, confidence, and a short reason.',
        'The server creates connection IDs, node IDs, and geometry from the referenced lane endpoints.',
        '',
        'Rules:',
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
        JSON.stringify(input)
    ].join('\n');
}

function boundedAppend(existing, addition) {
    const combined = existing + String(addition || '');
    return combined.length <= MAX_OUTPUT_CHARS ? combined : combined.slice(combined.length - MAX_OUTPUT_CHARS);
}

function cliFailureDetail(stdout, stderr) {
    const output = [stderr, stdout].filter(Boolean).join('\n');
    const apiMessages = [...output.matchAll(/"message"\s*:\s*"([^"]+)"/g)]
        .map(match => match[1].replaceAll('\\"', '"'));
    if (apiMessages.length) return apiMessages.at(-1);
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

function parseProviderOutput(provider, stdout, outputFileText) {
    let parsed;
    if (provider === 'codex') parsed = JSON.parse(outputFileText);
    else {
        const envelope = JSON.parse(stdout);
        const candidate = envelope.structured_output ?? envelope.result ?? envelope;
        parsed = typeof candidate === 'string' ? JSON.parse(candidate) : candidate;
    }
    if (typeof parsed?.patch_json === 'string') {
        return { ...parsed, patch: JSON.parse(parsed.patch_json) };
    }
    return parsed;
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
    const laneById = new Map(
        (deterministicGraph.lanes || []).map(lane => [lane.id, lane])
    );
    const seenPairs = new Set();
    const connections = patch.connections.map((decision, index) => {
        const fromLane = laneById.get(decision?.fromLaneId);
        const toLane = laneById.get(decision?.toLaneId);
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
    const problems = patch.problems.map((problem, index) => ({
        ...problem,
        id: String(problem?.id || `problem:${provider}:${index}`),
        type: String(problem?.type || 'model_uncertainty'),
        severity: ['info', 'warning', 'error'].includes(problem?.severity)
            ? problem.severity
            : 'warning',
        message: String(problem?.message || 'The model left this topology decision unresolved.')
    }));
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
        connections,
        problems,
        ...(observations ? { observations } : {})
    }, deterministicGraph);
}

export async function runCliTopologyProvider(provider, input, options = {}) {
    const definition = providerCommand(provider);
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
        const outputFileText = provider === 'codex' ? await readFile(outputPath, 'utf8') : '';
        const parsed = parseProviderOutput(provider, result.stdout, outputFileText);
        return {
            summary: String(parsed.summary || ''),
            graph: applyRecognitionPatch(parsed.patch, input.deterministicGraph, provider, {
                imagery: input.imagery
            }),
            outputTail: `${result.stdout}\n${result.stderr}`.slice(-8000)
        };
    } finally {
        await rm(jobDir, { recursive: true, force: true });
    }
}
