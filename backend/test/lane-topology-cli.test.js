import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
    applyRecognitionPatch,
    buildRecognitionPrompt,
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

describe('lane-topology CLI provider boundary', () => {
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
