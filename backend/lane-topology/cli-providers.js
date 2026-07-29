import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export const TOPOLOGY_PROMPT_VERSION = 'lane-topology-v3';
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
            args: ({ jobDir, schemaPath, outputPath, model, reasoningEffort }) => [
                'exec',
                ...(model ? ['--model', model] : []),
                '--config', `model_reasoning_effort="${reasoningEffort || 'medium'}"`,
                '--skip-git-repo-check',
                '--ephemeral',
                '--sandbox', 'read-only',
                '--cd', jobDir,
                '--output-schema', schemaPath,
                '--output-last-message', outputPath,
                '-'
            ]
        };
    }
    if (provider === 'claude') {
        return {
            command: 'claude',
            args: () => [
                '--print',
                '--bare',
                '--safe-mode',
                '--tools', '',
                '--output-format', 'json',
                '--json-schema', JSON.stringify(TOPOLOGY_OUTPUT_SCHEMA)
            ]
        };
    }
    throw new Error(`Unknown topology provider "${provider}".`);
}

export function providerAvailability(provider, spawnSyncImpl = spawnSync) {
    try {
        const definition = providerCommand(provider);
        const result = spawnSyncImpl(definition.command, ['--version'], {
            encoding: 'utf8',
            timeout: 2500,
            stdio: ['ignore', 'pipe', 'pipe']
        });
        return {
            available: result.status === 0,
            version: result.status === 0 ? String(result.stdout || result.stderr || '').trim().slice(0, 160) : null
        };
    } catch (_) {
        return { available: false, version: null };
    }
}

export function buildRecognitionPrompt(input) {
    return [
        'You are reconstructing a directed, lane-level road topology from OpenStreetMap evidence.',
        'Return only the JSON object required by the supplied schema.',
        'The patch_json field must be a JSON-encoded object with complete connections and problems arrays.',
        'Do not re-emit sections, nodes, lanes, profiles, or geometry; the server preserves and validates them.',
        'Each connection needs only fromLaneId, toLaneId, type, priority, confidence, and a short reason.',
        'The server creates connection IDs, node IDs, and geometry from the referenced lane endpoints.',
        '',
        'Rules:',
        '- Preserve source section and lane geometry unless the evidence explicitly requires a correction.',
        '- Never treat an OSM tag as proof of physical reality when tags contradict each other.',
        '- An ordinary merge is binary: at most two incoming lanes and one outgoing lane; identify the continuing and yielding lane.',
        '- An ordinary split is binary: one incoming lane and at most two outgoing lanes. Stage larger changes as ordered events.',
        '- A lane may have multiple alternative permitted intersection movements; these are not simultaneous physical merges.',
        '- Respect oneway, access, PSV, tram, turn-lane and restriction evidence.',
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
            child.kill('SIGTERM');
            reject(new Error(`${command} topology recognition timed out after ${timeoutMs} ms.`));
        }, timeoutMs);
        child.stdout?.on('data', chunk => { stdout = boundedAppend(stdout, chunk); });
        child.stderr?.on('data', chunk => { stderr = boundedAppend(stderr, chunk); });
        child.on('error', error => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(error);
        });
        child.on('close', (code, signal) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (code !== 0) {
                if (code === null && signal) {
                    reject(new Error(`${command} was terminated by ${signal}.`));
                    return;
                }
                const apiMessages = [...stderr.matchAll(/"message"\s*:\s*"([^"]+)"/g)]
                    .map(match => match[1].replaceAll('\\"', '"'));
                const fallback = stderr
                    .split('\n')
                    .map(line => line.trim())
                    .filter(Boolean)
                    .slice(-8)
                    .join(' ')
                    .slice(-1800);
                const detail = apiMessages.at(-1) || fallback || 'No error details were emitted.';
                reject(new Error(`${command} exited ${code}: ${detail}`));
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
            warnings: candidate.problems.filter(problem => problem.severity === 'warning').length
        }
    };
}

function laneEndpoint(lane, atEnd) {
    const coordinates = lane?.geometry?.coordinates;
    if (!Array.isArray(coordinates) || !coordinates.length) return null;
    return coordinates[atEnd ? coordinates.length - 1 : 0];
}

export function applyRecognitionPatch(patch, deterministicGraph, provider = 'model') {
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
    const fanOut = new Map();
    const fanIn = new Map();
    connections.forEach(connection => {
        fanOut.set(connection.fromLaneId, (fanOut.get(connection.fromLaneId) || 0) + 1);
        fanIn.set(connection.toLaneId, (fanIn.get(connection.toLaneId) || 0) + 1);
    });
    if ([...fanOut.values()].some(count => count > 2)) {
        throw new Error('Provider returned a non-binary split with more than two outgoing connections.');
    }
    if ([...fanIn.values()].some(count => count > 2)) {
        throw new Error('Provider returned a non-binary merge with more than two incoming connections.');
    }
    const problems = patch.problems.map((problem, index) => ({
        ...problem,
        id: String(problem?.id || `problem:${provider}:${index}`),
        type: String(problem?.type || 'model_uncertainty'),
        severity: ['info', 'warning', 'error'].includes(problem?.severity)
            ? problem.severity
            : 'warning',
        message: String(problem?.message || 'The model left this topology decision unresolved.')
    }));
    return validateCandidateGraph({
        ...deterministicGraph,
        connections,
        problems
    }, deterministicGraph);
}

export async function runCliTopologyProvider(provider, input, options = {}) {
    const definition = providerCommand(provider);
    const jobDir = await mkdtemp(join(tmpdir(), `lane-topology-${provider}-`));
    const schemaPath = join(jobDir, 'output-schema.json');
    const outputPath = join(jobDir, 'output.json');
    try {
        await writeFile(schemaPath, JSON.stringify(TOPOLOGY_OUTPUT_SCHEMA), 'utf8');
        const prompt = buildRecognitionPrompt(input);
        const args = definition.args({
            jobDir,
            schemaPath,
            outputPath,
            model: options.model,
            reasoningEffort: options.reasoningEffort
                || process.env.LANE_TOPOLOGY_CODEX_REASONING_EFFORT
                || 'medium'
        });
        const result = await runSpawn(definition.command, args, prompt, {
            ...options,
            cwd: jobDir
        });
        const outputFileText = provider === 'codex' ? await readFile(outputPath, 'utf8') : '';
        const parsed = parseProviderOutput(provider, result.stdout, outputFileText);
        return {
            summary: String(parsed.summary || ''),
            graph: applyRecognitionPatch(parsed.patch, input.deterministicGraph, provider),
            outputTail: `${result.stdout}\n${result.stderr}`.slice(-8000)
        };
    } finally {
        await rm(jobDir, { recursive: true, force: true });
    }
}
