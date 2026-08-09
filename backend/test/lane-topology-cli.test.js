import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
    applyRecognitionPatch,
    buildRecognitionPrompt,
    modelAcceptsImagery,
    PROVIDER_TIMEOUT_MS,
    providerAvailability,
    providerCommand,
    runCliTopologyProvider,
    TOPOLOGY_OUTPUT_SCHEMA,
    validateCandidateGraph
} from '../lane-topology/cli-providers.js';

function fanInGraph() {
    const sections = ['s1', 's2', 's3', 's4'].map(id => ({ id }));
    return {
        schemaVersion: 1,
        coverage: null,
        source: {},
        stats: { sourceWays: 4 },
        sections,
        nodes: [{ id: 'junction' }],
        lanes: [
            ['in1', 's1', 'a', 'junction', [[0, 0], [1, 1]]],
            ['in2', 's2', 'b', 'junction', [[0, 1], [1, 1]]],
            ['in3', 's3', 'c', 'junction', [[1, 0], [1, 1]]],
            ['out', 's4', 'junction', 'd', [[1, 1], [2, 2]]]
        ].map(([id, sectionId, fromNode, toNode, coordinates]) => ({
            id,
            sectionId,
            fromNode,
            toNode,
            geometry: { type: 'LineString', coordinates }
        })),
        connections: [],
        problems: []
    };
}

// A graph where the rules have already answered node A and left node B unresolved — the shape every
// crop now has, and the one the patch contract has to survive.
function partlySolvedGraph() {
    const lane = (id, sectionId, fromNode, toNode, coordinates) => ({
        id, sectionId, fromNode, toNode, geometry: { type: 'LineString', coordinates }
    });
    return {
        schemaVersion: 1,
        coverage: null,
        source: {},
        stats: { sourceWays: 4 },
        sections: ['s1', 's2', 's3', 's4'].map(id => ({ id })),
        nodes: [{ id: 'A', degree: 3 }, { id: 'B', degree: 3 }],
        lanes: [
            lane('lane:section:osm:11:0:x:A:forward:0', 's1', 'x', 'A', [[0, 0], [1, 0]]),
            lane('lane:section:osm:12:0:A:B:forward:0', 's2', 'A', 'B', [[1, 0], [2, 0]]),
            lane('lane:section:osm:13:0:B:y:forward:0', 's3', 'B', 'y', [[2, 0], [3, 0]]),
            lane('lane:section:osm:14:0:B:z:forward:0', 's4', 'B', 'z', [[2, 0], [2, 1]])
        ],
        connections: [{
            id: 'connection:A:in->out',
            nodeId: 'A',
            fromLaneId: 'lane:section:osm:11:0:x:A:forward:0',
            toLaneId: 'lane:section:osm:12:0:A:B:forward:0',
            type: 'continue',
            source: 'deterministic'
        }],
        problems: [
            {
                id: 'problem:unresolved-intersection:B',
                type: 'unresolved_intersection',
                severity: 'warning',
                nodeIds: ['B'],
                declineReason: 'multi_lane_approach_without_turn_lanes'
            },
            {
                id: 'problem:parcel:s2',
                type: 'lane_band_exceeds_road_parcel',
                severity: 'error',
                sectionIds: ['s2']
            }
        ]
    };
}

describe('lane-topology recognition contract', () => {
    it('shows lanes by short handle and names the junctions that are the work', () => {
        const prompt = buildRecognitionPrompt({ deterministicGraph: partlySolvedGraph() });

        expect(prompt).toContain('"id":"L0"');
        expect(prompt).toContain('"fromLaneId":"L0"');
        // The composite id is what runs got wrong and what made the prompt large; it must be gone.
        expect(prompt).not.toContain('lane:section:osm:11:0:x:A:forward:0');
        // The work is exactly the unresolved node, with why it is hard — and node A, which the
        // rules answered, is not in it. A still appears in the evidence, as a movement to respect.
        expect(prompt).toContain(
            '[{"nodeId":"B","arms":3,"whyUnsettled":"multi_lane_approach_without_turn_lanes"}]'
        );
    });

    it('resolves a handle back to the lane it stands for', () => {
        const graph = partlySolvedGraph();
        const applied = applyRecognitionPatch({
            connections: [{ fromLaneId: 'L1', toLaneId: 'L2', type: 'continue', confidence: 0.8 }],
            problems: []
        }, graph, 'claude');
        const added = applied.connections.find(connection => connection.source === 'claude');

        expect(added.fromLaneId).toBe('lane:section:osm:12:0:A:B:forward:0');
        expect(added.toLaneId).toBe('lane:section:osm:13:0:B:y:forward:0');
        expect(added.nodeId).toBe('B');
    });

    it('keeps the movements the rules derived instead of replacing them', () => {
        const graph = partlySolvedGraph();
        const applied = applyRecognitionPatch({
            connections: [{ fromLaneId: 'L1', toLaneId: 'L3', type: 'turn', confidence: 0.7 }],
            problems: []
        }, graph, 'claude');

        // Node A's deterministic movement survives a patch that only spoke about node B.
        expect(applied.connections.filter(connection => connection.nodeId === 'A')).toHaveLength(1);
        expect(applied.connections.filter(connection => connection.nodeId === 'B')).toHaveLength(1);
        // The junction it answered is no longer unresolved; the parcel finding it was never asked
        // about still is.
        expect(applied.problems.some(problem => problem.type === 'unresolved_intersection')).toBe(false);
        expect(applied.problems.some(problem => problem.type === 'lane_band_exceeds_road_parcel')).toBe(true);
    });

    it('discards movements at a node the rules already answered, and says how many', () => {
        const graph = partlySolvedGraph();
        const applied = applyRecognitionPatch({
            connections: [
                { fromLaneId: 'L0', toLaneId: 'L1', type: 'continue', confidence: 0.9 },
                { fromLaneId: 'L1', toLaneId: 'L2', type: 'continue', confidence: 0.8 }
            ],
            problems: []
        }, graph, 'claude');
        const atA = applied.connections.filter(connection => connection.nodeId === 'A');

        expect(atA).toHaveLength(1);
        expect(atA[0].source).toBe('deterministic');
        const reported = applied.problems.find(problem => problem.type === 'movements_outside_the_work');
        expect(reported.message).toContain('1 returned movements');
    });
});

describe('lane-topology CLI provider boundary', () => {
    it('refuses to hand a crop to a text-only model', async () => {
        expect(modelAcceptsImagery('opus')).toBe(true);
        expect(modelAcceptsImagery('gpt-5.3-codex-spark')).toBe(false);

        // The CLI would drop the image and answer from the tags, and the run would look identical
        // to one that read the orthophoto. Refusing is the only way that stays visible.
        await expect(runCliTopologyProvider('codex', { deterministicGraph: fanInGraph() }, {
            model: 'gpt-5.3-codex-spark',
            imageBuffer: Buffer.from('not really a jpeg'),
            spawnImpl: () => { throw new Error('the provider must not spawn at all'); }
        })).rejects.toThrow(/text only/i);
    });

    it('runs Codex ephemerally in a read-only sandbox with structured output', () => {
        const args = providerCommand('codex').args({
            jobDir: '/tmp/topology-job',
            schemaPath: '/tmp/topology-job/schema.json',
            outputPath: '/tmp/topology-job/output.json',
            imagePath: '/tmp/topology-job/orthophoto.jpg'
        });
        expect(args).toContain('--ephemeral');
        expect(args).toContain('read-only');
        expect(args).toContain('--output-schema');
        expect(args.slice(args.indexOf('--image'), args.indexOf('--image') + 2))
            .toEqual(['--image', '/tmp/topology-job/orthophoto.jpg']);
        expect(args).toContain('model_reasoning_effort="medium"');
        expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
        expect(TOPOLOGY_OUTPUT_SCHEMA.additionalProperties).toBe(false);
        expect(TOPOLOGY_OUTPUT_SCHEMA.required).toEqual(['summary', 'patch_json']);
        expect(TOPOLOGY_OUTPUT_SCHEMA.properties.patch_json.type).toBe('string');
    });

    it('runs Claude without tools and with JSON schema validation', () => {
        const args = providerCommand('claude').args({ model: 'sonnet' });
        expect(args).toContain('--safe-mode');
        expect(args).toContain('--no-session-persistence');
        expect(args).toContain('--no-chrome');
        expect(args).not.toContain('--bare');
        expect(args).toContain('--tools');
        expect(args[args.indexOf('--tools') + 1]).toBe('');
        expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2)).toEqual(['--model', 'sonnet']);
        expect(args).toContain('--json-schema');
        expect(args).not.toContain('--dangerously-skip-permissions');
        expect(PROVIDER_TIMEOUT_MS.claude).toBe(15 * 60 * 1000);
        expect(PROVIDER_TIMEOUT_MS.codex).toBe(10 * 60 * 1000);
    });

    it('gives Claude read-only access to an attached orthophoto in the isolated job directory', () => {
        const args = providerCommand('claude').args({
            jobDir: '/tmp/topology-job',
            imagePath: '/tmp/topology-job/orthophoto.jpg'
        });
        expect(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 2))
            .toEqual(['--tools', 'Read']);
        expect(args.slice(args.indexOf('--add-dir'), args.indexOf('--add-dir') + 2))
            .toEqual(['--add-dir', '/tmp/topology-job']);
    });

    it('requires binary ordinary merge and split events in the recognition prompt', () => {
        const prompt = buildRecognitionPrompt({
            selection: { bbox: [1, 2, 3, 4] },
            deterministicGraph: { sections: [], nodes: [], lanes: [], connections: [], problems: [] }
        });
        expect(prompt).toContain('ordinary merge is binary');
        expect(prompt).toContain('ordinary split is binary');
        expect(prompt).toContain('label them turn');
        expect(prompt).toContain('inspect orthophoto.jpg');
        expect(prompt).toContain('Do not hallucinate missing connections');
        expect(prompt).toContain('patch_json');
        expect(prompt).toContain('Do not re-emit sections');
    });

    // Width is measured by the separate local-CV analysis at a higher imagery resolution. A
    // recognition run that also measures widths gives the same quantity two producers and no
    // adjudication rule, so the prompt must not ask for it at all.
    it('leaves lane width to the width analysis and never asks the model to measure it', () => {
        const prompt = buildRecognitionPrompt({
            selection: { bbox: [1, 2, 3, 4] },
            deterministicGraph: { sections: [], nodes: [], lanes: [], connections: [], problems: [] }
        });
        expect(prompt).toContain('Do not measure lane widths');
        expect(prompt).not.toContain('lane_width');
        expect(prompt).not.toMatch(/Supported observation kinds:.*lane_width/);
        // The structural observations stay — they establish topology, they do not measure it.
        expect(prompt).toContain('taper_start');
        expect(prompt).toContain('merge_point');
        expect(prompt).toContain('stop_line');
    });

    it('does not trust connections to lane IDs absent from the candidate', () => {
        expect(() => validateCandidateGraph({
            sections: [{ id: 's1' }],
            nodes: [],
            lanes: [{ id: 'l1', sectionId: 's1' }],
            connections: [{ id: 'c1', fromLaneId: 'l1', toLaneId: 'missing' }],
            problems: []
        }, { schemaVersion: 1, coverage: null, source: {} })).toThrow(/missing lane/i);
    });

    it('reports an unavailable executable without throwing', () => {
        const availability = providerAvailability('codex', () => ({ status: 127, stdout: '', stderr: '' }));
        expect(availability).toEqual({ available: false, version: null, indeterminate: false });
    });

    // A busy machine starved the 2.5 s probe and the run was refused as "CLI is not available",
    // though the CLI was installed and answered in 0.16 s once the machine was idle.
    it('reports a timed-out probe as indeterminate rather than missing', () => {
        const availability = providerAvailability('claude', () => ({
            status: null, stdout: '', stderr: '', error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })
        }));
        expect(availability.available).toBe(false);
        expect(availability.indeterminate).toBe(true);
    });

    it('reports a missing binary as definitely unavailable', () => {
        const availability = providerAvailability('claude', () => ({
            status: null, stdout: '', stderr: '', error: Object.assign(new Error('nope'), { code: 'ENOENT' })
        }));
        expect(availability.available).toBe(false);
        expect(availability.indeterminate).toBe(false);
    });

    it('reports an available CLI with its version', () => {
        const availability = providerAvailability('claude', () => ({
            status: 0, stdout: '2.1.220 (Claude Code)\n', stderr: ''
        }));
        expect(availability).toEqual({
            available: true, version: '2.1.220 (Claude Code)', indeterminate: false
        });
    });

    it('retains a failed provider stdout tail when stderr is empty', async () => {
        function failingSpawn() {
            const child = new EventEmitter();
            child.stdout = new PassThrough();
            child.stderr = new PassThrough();
            child.kill = () => {};
            child.stdin = {
                end() {
                    queueMicrotask(() => {
                        child.stdout.end('{"error":{"message":"subscription authentication failed"}}');
                        child.emit('close', 1, null);
                    });
                }
            };
            return child;
        }

        let failure;
        try {
            await runCliTopologyProvider('claude', {
                selection: {},
                osmWays: [],
                deterministicGraph: fanInGraph()
            }, {
                spawnImpl: failingSpawn,
                timeoutMs: 1000
            });
        } catch (error) {
            failure = error;
        }
        expect(failure?.message).toContain('subscription authentication failed');
        expect(failure?.outputTail).toContain('subscription authentication failed');
    });

    // A CLI echoes the prompt to stdout, so the evidence package's own problem messages look exactly
    // like API error messages — and being last, they used to win. A real Codex quota refusal was
    // reported as "4 road arms meet here", which also hid the word the runner watches for to stop a
    // batch, turning one refusal into a queue of identical failures.
    it('reports the CLI refusal, not a problem message echoed back from the prompt', async () => {
        function refusingSpawn() {
            const child = new EventEmitter();
            child.stdout = new PassThrough();
            child.stderr = new PassThrough();
            child.kill = () => {};
            child.stdin = {
                end() {
                    queueMicrotask(() => {
                        child.stdout.end('prompt echo … {"message":"4 road arms meet here; '
                            + 'lane-to-lane movements have not been inferred yet."}');
                        child.stderr.end("ERROR: You've hit your usage limit. Try again later.");
                        child.emit('close', 1, null);
                    });
                }
            };
            return child;
        }

        let failure;
        try {
            await runCliTopologyProvider('codex', { deterministicGraph: fanInGraph() }, {
                spawnImpl: refusingSpawn,
                timeoutMs: 1000
            });
        } catch (error) {
            failure = error;
        }
        expect(failure?.message).toMatch(/usage limit/i);
        expect(failure?.message).not.toMatch(/road arms meet here/);
    });

    // The envelope carries usage BEFORE the answer, so a large patch pushes the counts out of the
    // 8000-char output tail entirely — a real run reported "usage not reported" for exactly that
    // reason. The counts have to be read from the parsed envelope, not scraped back off the tail.
    it('reports the token usage of a run whose patch is far larger than the output tail', async () => {
        const patch = {
            connections: [{ fromLaneId: 'in1', toLaneId: 'out', type: 'continue', confidence: 0.9 }],
            problems: [{ type: 'padding', severity: 'info', message: 'x'.repeat(20000) }]
        };
        const envelope = JSON.stringify({
            type: 'result',
            usage: { input_tokens: 1234, output_tokens: 567, cache_read_input_tokens: 89 },
            total_cost_usd: 1.25,
            duration_ms: 42000,
            structured_output: { summary: 'ok', patch_json: JSON.stringify(patch) }
        });

        function spawnImpl() {
            const child = new EventEmitter();
            child.stdout = new PassThrough();
            child.stderr = new PassThrough();
            child.kill = () => {};
            child.stdin = {
                end() {
                    queueMicrotask(() => {
                        child.stdout.end(envelope);
                        child.emit('close', 0, null);
                    });
                }
            };
            return child;
        }

        const result = await runCliTopologyProvider('claude', {
            selection: {},
            osmWays: [],
            deterministicGraph: fanInGraph()
        }, { spawnImpl, timeoutMs: 1000 });

        expect(result.outputTail).not.toContain('input_tokens');
        expect(result.usage).toEqual({
            inputTokens: 1234,
            outputTokens: 567,
            cacheReadTokens: 89,
            cacheCreationTokens: null,
            equivalentUsd: 1.25,
            durationMs: 42000,
            numTurns: null
        });
    });

    it('applies a compact decision patch while preserving graph geometry and entities', () => {
        const graph = {
            schemaVersion: 1,
            coverage: null,
            source: {},
            stats: { sourceWays: 2 },
            sections: [{ id: 's1' }, { id: 's2' }],
            nodes: [{ id: 'n1' }],
            lanes: [
                {
                    id: 'l1', sectionId: 's1', fromNode: 'n0', toNode: 'n1',
                    geometry: { type: 'LineString', coordinates: [[1, 1], [2, 2]] }
                },
                {
                    id: 'l2', sectionId: 's2', fromNode: 'n1', toNode: 'n2',
                    geometry: { type: 'LineString', coordinates: [[2, 2], [3, 3]] }
                }
            ],
            connections: [],
            problems: []
        };
        const result = applyRecognitionPatch({
            connections: [{
                fromLaneId: 'l1',
                toLaneId: 'l2',
                type: 'continue',
                priority: 'continuing',
                confidence: 0.9,
                reason: 'same alignment'
            }],
            problems: []
        }, graph, 'codex');
        expect(result.sections).toBe(graph.sections);
        expect(result.lanes).toBe(graph.lanes);
        expect(result.connections[0]).toMatchObject({
            nodeId: 'n1',
            fromLaneId: 'l1',
            toLaneId: 'l2',
            source: 'codex'
        });
        expect(result.connections[0].geometry.coordinates).toEqual([[2, 2], [2, 2]]);
        expect(result.stats.sourceWays).toBe(2);
    });

    it('accepts multiple alternative turns into one outgoing lane', () => {
        const graph = fanInGraph();
        const result = applyRecognitionPatch({
            connections: ['in1', 'in2', 'in3'].map(fromLaneId => ({
                fromLaneId,
                toLaneId: 'out',
                type: 'turn'
            })),
            problems: []
        }, graph, 'codex');

        expect(result.connections).toHaveLength(3);
        expect(result.problems).toHaveLength(0);
    });

    it('keeps a non-binary physical merge as an inspectable error instead of failing the job', () => {
        const graph = fanInGraph();
        const result = applyRecognitionPatch({
            connections: ['in1', 'in2', 'in3'].map(fromLaneId => ({
                fromLaneId,
                toLaneId: 'out',
                type: 'merge'
            })),
            problems: []
        }, graph, 'codex');

        expect(result.connections).toHaveLength(3);
        expect(result.problems).toContainEqual(expect.objectContaining({
            type: 'nonbinary_transition',
            severity: 'error',
            laneIds: ['in1', 'in2', 'in3', 'out']
        }));
        expect(result.stats.errors).toBe(1);
    });

    it('keeps georeferenced imagery observations separate from topology entities', () => {
        const graph = fanInGraph();
        const result = applyRecognitionPatch({
            connections: [],
            problems: [],
            imagery_observations: [{
                kind: 'taper_start',
                points: [[0.5, 0.25]],
                confidence: 0.9,
                sourceWayIds: ['157387766']
            }]
        }, graph, 'codex', {
            imagery: {
                source: { key: 'zagreb_cdof_2022', capturedAt: '2022' },
                bbox: [15.961, 45.797, 15.963, 45.799],
                width: 1000,
                height: 1000,
                effectiveGsdM: 0.15
            }
        });

        expect(result.lanes).toBe(graph.lanes);
        expect(result.observations.imagery.features).toHaveLength(1);
        expect(result.observations.imagery.features[0].geometry).toEqual({
            type: 'Point',
            coordinates: [15.962, 45.7985]
        });
        expect(result.stats.imageryObservations).toBe(1);
    });

    it('rejects patch connections whose directed lane endpoints do not meet', () => {
        const graph = {
            schemaVersion: 1,
            coverage: null,
            source: {},
            sections: [{ id: 's1' }, { id: 's2' }],
            nodes: [],
            lanes: [
                {
                    id: 'l1', sectionId: 's1', fromNode: 'a', toNode: 'b',
                    geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] }
                },
                {
                    id: 'l2', sectionId: 's2', fromNode: 'c', toNode: 'd',
                    geometry: { type: 'LineString', coordinates: [[2, 2], [3, 3]] }
                }
            ],
            connections: [],
            problems: []
        };
        expect(() => applyRecognitionPatch({
            connections: [{ fromLaneId: 'l1', toLaneId: 'l2' }],
            problems: []
        }, graph, 'codex')).toThrow(/do not share/i);
    });
});
