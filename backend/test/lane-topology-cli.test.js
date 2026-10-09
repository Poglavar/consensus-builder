import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import {
    applyRecognitionPatch,
    buildRecognitionPrompt,
    dominantModel,
    modelAcceptsImagery,
    DEFAULT_TOPOLOGY_PROVIDER,
    PROVIDER_TIMEOUT_MS,
    TOPOLOGY_PROVIDERS,
    providerAvailability,
    providerCommand,
    recognitionTargets,
    runTopologyProvider,
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
            type: 'driving',
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
        id, sectionId, fromNode, toNode, type: 'driving',
        geometry: { type: 'LineString', coordinates }
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

function twoOpenNodesGraph() {
    const graph = partlySolvedGraph();
    graph.nodes.push({ id: 'osm-node:101', degree: 3 }, { id: 'osm-node:102', degree: 3 });
    for (const [nodeId, index] of [['osm-node:101', 0], ['osm-node:102', 1]]) {
        const x = 4 + index * 3;
        graph.sections.push({ id: `open-in-${index}` }, { id: `open-out-${index}` });
        graph.lanes.push({
            id: `open-in-${index}`, sectionId: `open-in-${index}`, fromNode: `start-${index}`,
            toNode: nodeId, type: 'driving',
            geometry: { type: 'LineString', coordinates: [[x, 0], [x + 1, 0]] }
        }, {
            id: `open-out-${index}`, sectionId: `open-out-${index}`, fromNode: nodeId,
            toNode: `end-${index}`, type: 'driving',
            geometry: { type: 'LineString', coordinates: [[x + 1, 0], [x + 2, 0]] }
        });
        graph.problems.push({
            id: `problem:unresolved:${nodeId}`, type: 'unresolved_intersection',
            nodeIds: [nodeId], openApproaches: [{ sectionId: `open-in-${index}` }]
        });
    }
    return graph;
}

// One junction node with two approaches: the rules settled the one arriving on s5 and left the one
// arriving on s2 open. This is what partial resolution produces, and the patch has to honour it —
// a node with connections is no longer proof that the node is finished.
function partiallyOpenGraph(openApproaches = [{ sectionId: 's2', name: 'Ilica', reason: 'multi_lane_approach_without_turn_lanes' }]) {
    const lane = (id, sectionId, fromNode, toNode, coordinates) => ({
        id, sectionId, fromNode, toNode, type: 'driving',
        geometry: { type: 'LineString', coordinates }
    });
    return {
        schemaVersion: 1,
        coverage: null,
        source: {},
        stats: { sourceWays: 4 },
        // Way ids so a turn restriction, which OSM states between WAYS, can be matched at all.
        sections: ['s2', 's3', 's4', 's5'].map(id => ({ id, sourceWayId: id.replace('s', '1') })),
        nodes: [{ id: 'osm-node:B', degree: 4 }],
        lanes: [
            lane('lane:in:s2', 's2', 'w', 'osm-node:B', [[0, 0], [1, 0]]),
            lane('lane:in:s5', 's5', 'n', 'osm-node:B', [[1, 1], [1, 0]]),
            lane('lane:out:s3', 's3', 'osm-node:B', 'e', [[1, 0], [2, 0]]),
            lane('lane:out:s4', 's4', 'osm-node:B', 's', [[1, 0], [1, -1]])
        ],
        connections: [{
            id: 'connection:B:s5->s3',
            nodeId: 'osm-node:B',
            fromLaneId: 'lane:in:s5',
            toLaneId: 'lane:out:s3',
            type: 'turn',
            source: 'deterministic'
        }],
        problems: [{
            id: 'problem:unresolved-intersection:B',
            type: 'unresolved_intersection',
            severity: 'warning',
            nodeIds: ['osm-node:B'],
            declineReason: 'multi_lane_approach_without_turn_lanes',
            openApproaches
        }]
    };
}

describe('lane-topology partial resolution', () => {
    it('keeps a multi-lane approach open until every incoming lane has a movement', () => {
        const graph = partiallyOpenGraph();
        graph.lanes.push({
            ...graph.lanes[0], id: 'lane:in:s2:second',
            geometry: { type: 'LineString', coordinates: [[0, 0.1], [1, 0.1]] }
        });
        const one = applyRecognitionPatch({
            connections: [{ fromLaneId: 'lane:in:s2', toLaneId: 'lane:out:s3', type: 'turn' }],
            problems: []
        }, graph, 'codex');
        expect(one.problems.find(problem => problem.type === 'unresolved_intersection')
            ?.openApproaches).toHaveLength(1);

        const both = applyRecognitionPatch({
            connections: [
                { fromLaneId: 'lane:in:s2', toLaneId: 'lane:out:s3', type: 'turn' },
                { fromLaneId: 'lane:in:s2:second', toLaneId: 'lane:out:s4', type: 'turn' }
            ], problems: []
        }, graph, 'codex');
        expect(both.problems.some(problem => problem.type === 'unresolved_intersection'))
            .toBe(false);
    });

    it('requires the directed centre-lane incidence before closing its approach', () => {
        const graph = partiallyOpenGraph();
        const inbound = {
            ...graph.lanes[0], id: 'lane:centre:forward', physicalLaneId: 'physical:centre',
            centreLane: true
        };
        const outbound = {
            ...graph.lanes[0], id: 'lane:centre:backward', physicalLaneId: 'physical:centre',
            centreLane: true, fromNode: 'osm-node:B', toNode: 'w',
            geometry: { type: 'LineString', coordinates: [[1, 0], [0, 0]] }
        };
        graph.lanes.push(inbound, outbound);
        const one = applyRecognitionPatch({
            connections: [{ fromLaneId: 'lane:in:s2', toLaneId: 'lane:out:s3', type: 'turn' }],
            problems: []
        }, graph, 'codex');
        expect(one.problems.some(problem => problem.type === 'unresolved_intersection'))
            .toBe(true);

        const both = applyRecognitionPatch({
            connections: [
                { fromLaneId: 'lane:in:s2', toLaneId: 'lane:out:s3', type: 'turn' },
                { fromLaneId: 'lane:centre:forward', toLaneId: 'lane:out:s4', type: 'turn' }
            ],
            problems: []
        }, graph, 'codex');
        expect(both.problems.some(problem => problem.type === 'unresolved_intersection')).toBe(false);

        // The reverse incidence shares paint with the first lane but terminates at a different
        // node. It cannot be substituted for the incoming centre-lane decision.
        expect(() => applyRecognitionPatch({
            connections: [{ fromLaneId: 'lane:centre:backward', toLaneId: 'lane:out:s3', type: 'turn' }],
            problems: []
        }, graph, 'codex')).toThrow('do not share a directed endpoint');
    });

    it('applies an OSM turn restriction to a centre-lane incidence by its physical way', () => {
        const graph = partiallyOpenGraph();
        graph.lanes.push({
            ...graph.lanes[0], id: 'lane:centre:forward', physicalLaneId: 'physical:centre',
            centreLane: true
        });
        const result = applyRecognitionPatch({
            connections: [{ fromLaneId: 'lane:centre:forward', toLaneId: 'lane:out:s3', type: 'turn' }],
            problems: []
        }, graph, 'codex', {
            restrictions: [{
                osm_id: 71,
                restriction: 'no_left_turn',
                members: [
                    { role: 'from', type: 'way', ref: '12' },
                    { role: 'via', type: 'node', ref: 'B' },
                    { role: 'to', type: 'way', ref: '13' }
                ]
            }]
        });

        expect(result.connections.some(connection => connection.source === 'codex')).toBe(false);
        expect(result.problems.some(problem => problem.type === 'movements_against_restrictions')).toBe(true);
        expect(result.problems.some(problem => problem.type === 'unresolved_intersection')).toBe(true);
    });

    it('accepts a movement on the open approach and refuses one on a settled approach', () => {
        const applied = applyRecognitionPatch({
            connections: [
                { fromLaneId: 'L0', toLaneId: 'L2', type: 'continue', confidence: 0.8 },
                { fromLaneId: 'L1', toLaneId: 'L3', type: 'turn', confidence: 0.8 }
            ],
            problems: []
        }, partiallyOpenGraph(), 'claude');
        const fromOpen = applied.connections.filter(connection => connection.fromLaneId === 'lane:in:s2');
        const fromSettled = applied.connections.filter(connection => connection.fromLaneId === 'lane:in:s5');

        expect(fromOpen).toHaveLength(1);
        expect(fromOpen[0].source).toBe('claude');
        // The settled approach keeps exactly what the rules gave it, and nothing is added to it.
        expect(fromSettled).toHaveLength(1);
        expect(fromSettled[0].source).toBe('deterministic');
        expect(applied.problems.find(problem => problem.type === 'movements_outside_the_work').message)
            .toContain('1 returned movements');
    });

    it('closes the node only when every open approach has been answered', () => {
        const twoOpen = partiallyOpenGraph([
            { sectionId: 's2', name: 'Ilica', reason: 'multi_lane_approach_without_turn_lanes' },
            { sectionId: 's6', name: 'Savska', reason: 'receiving_lane_undetermined' }
        ]);
        const applied = applyRecognitionPatch({
            connections: [{ fromLaneId: 'L0', toLaneId: 'L2', type: 'continue', confidence: 0.8 }],
            problems: []
        }, twoOpen, 'claude');
        const remaining = applied.problems.find(problem => problem.type === 'unresolved_intersection');

        // Answering one of two leaves the junction unresolved, with only the other still listed.
        expect(remaining.openApproaches).toHaveLength(1);
        expect(remaining.openApproaches[0].sectionId).toBe('s6');
    });

    it('drops the unresolved note once the last open approach is answered', () => {
        const applied = applyRecognitionPatch({
            connections: [{ fromLaneId: 'L0', toLaneId: 'L2', type: 'continue', confidence: 0.8 }],
            problems: []
        }, partiallyOpenGraph(), 'claude');

        expect(applied.problems.some(problem => problem.type === 'unresolved_intersection')).toBe(false);
    });

    // A real batch of ten junctions came back with four turn_restriction_violation errors: movements
    // OSM forbids, which the deterministic rules would never have emitted because restrictions are
    // build input there. Reporting them afterwards is not the same as refusing them.
    it('refuses a movement an OSM turn restriction forbids, as the rules do', () => {
        const applied = applyRecognitionPatch({
            connections: [
                { fromLaneId: 'L0', toLaneId: 'L2', type: 'turn', confidence: 0.8 },
                { fromLaneId: 'L0', toLaneId: 'L3', type: 'turn', confidence: 0.8 }
            ],
            problems: []
        }, partiallyOpenGraph(), 'claude', {
            restrictions: [{
                osm_id: 700,
                restriction: 'no_left_turn',
                members: [
                    { role: 'from', type: 'way', ref: '12' },
                    { role: 'via', type: 'node', ref: 'B' },
                    { role: 'to', type: 'way', ref: '13' }
                ]
            }]
        });
        const fromOpen = applied.connections.filter(connection => connection.source === 'claude');

        expect(fromOpen).toHaveLength(1);
        expect(fromOpen[0].toLaneId).toBe('lane:out:s4');
        expect(applied.problems.find(problem => problem.type === 'movements_against_restrictions').message)
            .toContain('1 returned movements');
        // And the graph must not then also carry the violation it just refused.
        expect(applied.problems.some(problem => problem.type === 'turn_restriction_violation')).toBe(false);
    });

    it('tells the model which approaches are open, not just which node', () => {
        const prompt = buildRecognitionPrompt({ deterministicGraph: partiallyOpenGraph() });

        expect(prompt).toContain('"openApproaches":[{"section":"s2","street":"Ilica"');
        expect(prompt).toContain('only traffic ARRIVING on those sections is undecided');
        expect(prompt).toContain('EVERY public incoming driving lane');
    });
});

describe('lane-topology recognition contract', () => {
    it('shows lanes by short handle and names the junctions that are the work', () => {
        const prompt = buildRecognitionPrompt({ deterministicGraph: partlySolvedGraph() });

        expect(prompt).toContain('"id":"L0"');
        expect(prompt).toContain('"fromLaneId":"L0"');
        // The composite id is what runs got wrong and what made the prompt large; it must be gone.
        expect(prompt).not.toContain('lane:section:osm:11:0:x:A:forward:0');
        // The work is exactly the unresolved node, with why it is hard — and node A, which the
        // rules answered, is not in it. A still appears in the evidence, as a movement to respect.
        // Asserted field by field rather than as one serialized blob: pinning the exact JSON made
        // every addition to a target look like a regression.
        const targets = JSON.parse(prompt.match(/\[\{"nodeId".*?\}\]/s)[0]);
        expect(targets).toHaveLength(1);
        expect(targets[0]).toMatchObject({
            nodeId: 'B', arms: 3, whyUnsettled: 'multi_lane_approach_without_turn_lanes'
        });
        // Node A is absent from the WORK; it still appears in the evidence as a settled movement.
        expect(targets.map(t => t.nodeId)).not.toContain('A');
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
    it('limits a patch to the selected unresolved node and leaves its neighbor open', () => {
        const graph = twoOpenNodesGraph();
        const patch = {
            connections: [
                { fromLaneId: 'open-in-0', toLaneId: 'open-out-0', type: 'continue' },
                { fromLaneId: 'open-in-1', toLaneId: 'open-out-1', type: 'continue' }
            ],
            problems: [
                { id: 'model:target', nodeIds: ['osm-node:101'], message: 'Target evidence' },
                { id: 'model:neighbor', nodeIds: ['osm-node:102'], message: 'Neighbor evidence' },
                { id: 'model:unscoped', message: 'No node given' }
            ]
        };
        const result = applyRecognitionPatch(patch, graph, 'claude', {
            targetNodeIds: ['osm-node:101']
        });
        expect(result.connections.filter(connection => connection.nodeId === 'osm-node:101')).toHaveLength(1);
        expect(result.connections.filter(connection => connection.nodeId === 'osm-node:102')).toHaveLength(0);
        expect(result.problems.some(problem => problem.id === 'problem:unresolved:osm-node:101')).toBe(false);
        expect(result.problems).toContainEqual(graph.problems.find(problem =>
            problem.id === 'problem:unresolved:osm-node:102'));
        expect(result.problems.some(problem => problem.id === 'model:target')).toBe(true);
        expect(result.problems.some(problem => problem.id === 'model:neighbor'
            || problem.id === 'model:unscoped')).toBe(false);
        expect(result.connections).toContainEqual(graph.connections[0]);

        const prompt = buildRecognitionPrompt({ deterministicGraph: graph, targetNodeIds: ['osm-node:101'] });
        expect(prompt).toContain('targetNodeIds: ["osm-node:101"]');
        expect(prompt).toContain('"nodeId":"osm-node:101"');
        expect(prompt).not.toContain('"nodeId":"osm-node:102"');
    });

    it('keeps the existing all-open-nodes behavior when targets are omitted', () => {
        const graph = twoOpenNodesGraph();
        const result = applyRecognitionPatch({
            connections: [
                { fromLaneId: 'open-in-0', toLaneId: 'open-out-0' },
                { fromLaneId: 'open-in-1', toLaneId: 'open-out-1' }
            ],
            problems: [{ id: 'model:unscoped', message: 'General finding' }]
        }, graph);
        expect(result.connections.filter(connection => connection.nodeId.startsWith('osm-node:')))
            .toHaveLength(2);
        expect(result.problems.some(problem => problem.type === 'unresolved_intersection'
            && problem.nodeIds?.[0]?.startsWith('osm-node:'))).toBe(false);
        expect(result.problems.some(problem => problem.id === 'model:unscoped')).toBe(true);
    });

    it('refuses to hand a crop to a text-only model', async () => {
        expect(modelAcceptsImagery('opus')).toBe(true);
        expect(modelAcceptsImagery('gpt-5.3-codex-spark')).toBe(false);

        // The CLI would drop the image and answer from the tags, and the run would look identical
        // to one that read the orthophoto. Refusing is the only way that stays visible.
        await expect(runTopologyProvider('codex', { deterministicGraph: fanInGraph() }, {
            model: 'gpt-5.3-codex-spark',
            imageBuffer: Buffer.from('not really a jpeg'),
            complete: () => { throw new Error('the provider must not run at all'); }
        })).rejects.toThrow(/text only/i);
    });

    // The spawn, arguments, key stripping, schema conversion and usage parsing belong to the shared
    // layer (agents/lib/llm-cost/cli.cjs, with its own tests). What this boundary still owns is the
    // request it hands over and what it makes of the answer.
    function layerFake(answer = { summary: 'ok', patch_json: JSON.stringify({ connections: [], problems: [] }) }) {
        const calls = [];
        return {
            calls,
            createCliLlm(config) {
                return {
                    async complete(request) {
                        const image = request.content.find(part => part?.type === 'image');
                        calls.push({ config, request, imageOnDisk: image ? existsSync(image.path) : null });
                        return { data: answer, model: 'layer-default-model', usage: null, equivalentUsd: null, raw: null };
                    }
                };
            }
        };
    }

    it('hands Codex the crop by path, the output schema, its measured effort and no model id', async () => {
        const fake = layerFake();
        await runTopologyProvider('codex', { deterministicGraph: fanInGraph() }, {
            imageBuffer: Buffer.from('jpeg bytes'),
            createCliLlm: fake.createCliLlm
        });
        const [{ config, request, imageOnDisk }] = fake.calls;
        expect(config).toMatchObject({ engine: 'codex', repo: 'consensus-builder', script: 'lane-topology-recognition' });
        expect(config.timeoutMs).toBe(PROVIDER_TIMEOUT_MS.codex);
        const image = request.content.find(part => part?.type === 'image');
        expect(image.path).toMatch(/orthophoto\.jpg$/);
        expect(config.cwd).toBe(image.path.replace(/\/orthophoto\.jpg$/, ''));
        expect(imageOnDisk).toBe(true);
        expect(request.content.some(part => typeof part === 'string' && part.includes('patch_json'))).toBe(true);
        expect(request.schema).toBe(TOPOLOGY_OUTPUT_SCHEMA);
        expect(request.effort).toBe('medium');
        // The layer's default is the model; a call site that names one has pinned it.
        expect('model' in request).toBe(false);
        expect(TOPOLOGY_OUTPUT_SCHEMA.additionalProperties).toBe(false);
        expect(TOPOLOGY_OUTPUT_SCHEMA.required).toEqual(['summary', 'patch_json']);
        expect(TOPOLOGY_OUTPUT_SCHEMA.properties.patch_json.type).toBe('string');
    });

    it('gives Claude its own ceiling, no image when there is no crop, and a model only as an override', async () => {
        const fake = layerFake();
        await runTopologyProvider('claude', { deterministicGraph: fanInGraph() }, { createCliLlm: fake.createCliLlm });
        await runTopologyProvider('claude', { deterministicGraph: fanInGraph() }, {
            createCliLlm: fake.createCliLlm, model: 'sonnet'
        });
        const [plain, overridden] = fake.calls;
        expect(plain.config.engine).toBe('claude');
        expect(plain.config.timeoutMs).toBe(PROVIDER_TIMEOUT_MS.claude);
        expect(plain.request.content.some(part => part?.type === 'image')).toBe(false);
        expect('model' in plain.request).toBe(false);
        expect('effort' in plain.request).toBe(false);
        expect(overridden.request.model).toBe('sonnet');
    });

    // The default provider: the metered Claude API through the shared layer (llm.cjs), with the
    // same request the CLIs get. The layer owns the model, the vendor body and the ledger row.
    function apiFake(answer = { summary: 'ok', patch_json: JSON.stringify({ connections: [], problems: [] }) }) {
        const calls = [];
        return {
            calls,
            createLlm(config) {
                return {
                    async complete(request) {
                        const image = request.content.find(part => part?.type === 'image');
                        calls.push({ config, request, imageOnDisk: image ? existsSync(image.path) : null });
                        return {
                            data: answer,
                            model: 'claude-opus-5-5',
                            usage: { input_tokens: 9000, output_tokens: 1200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
                            costUsd: 0.075,
                            raw: { id: 'msg_1', model: 'claude-opus-5-5', stop_reason: 'end_turn' }
                        };
                    }
                };
            }
        };
    }

    it('defaults to the Claude API and keeps both CLIs selectable', () => {
        expect(DEFAULT_TOPOLOGY_PROVIDER).toBe('anthropic');
        expect(TOPOLOGY_PROVIDERS).toEqual(['anthropic', 'claude', 'codex']);
        expect(PROVIDER_TIMEOUT_MS.anthropic).toBeGreaterThan(0);
    });

    it('hands the API the crop by path, the output schema, a raw SDK client and no model id', async () => {
        const fake = apiFake();
        const result = await runTopologyProvider('anthropic', { deterministicGraph: fanInGraph() }, {
            imageBuffer: Buffer.from('jpeg bytes'),
            createLlm: fake.createLlm,
            createCliLlm: () => { throw new Error('the API provider must not reach a CLI'); },
            jobId: 42
        });
        const [{ config, request, imageOnDisk }] = fake.calls;
        expect(config).toMatchObject({
            repo: 'consensus-builder',
            script: 'lane-topology-recognition',
            meta: { provider: 'anthropic', jobId: 42 }
        });
        // A raw client the layer can stream through, not a track()-wrapped one or a CLI engine.
        expect(typeof config.client?.messages?.create).toBe('function');
        expect('engine' in config).toBe(false);
        const image = request.content.find(part => part?.type === 'image');
        expect(image.path).toMatch(/orthophoto\.jpg$/);
        expect(imageOnDisk).toBe(true);
        expect(request.content.some(part => typeof part === 'string' && part.includes('patch_json'))).toBe(true);
        expect(request.schema).toBe(TOPOLOGY_OUTPUT_SCHEMA);
        // Neither a model nor an effort: the layer's default model at its default effort, not a tier.
        expect('model' in request).toBe(false);
        expect('effort' in request).toBe(false);
        expect('tier' in request).toBe(false);
        // Metered: the charge is the price and there is no subscription equivalent.
        expect(result.usage).toMatchObject({
            resolvedModel: 'claude-opus-5-5',
            inputTokens: 9000,
            outputTokens: 1200,
            costUsd: 0.075,
            equivalentUsd: null,
            numTurns: null
        });
        expect(Number.isFinite(result.usage.durationMs)).toBe(true);
        expect(result.summary).toBe('ok');
    });

    it('reports the API available only when a key is configured, without spawning anything', () => {
        const noSpawn = () => { throw new Error('the API has no executable to probe'); };
        expect(providerAvailability('anthropic', noSpawn, { ANTHROPIC_API_KEY: 'sk-test' }))
            .toMatchObject({ available: true, indeterminate: false });
        expect(providerAvailability('anthropic', noSpawn, {}))
            .toMatchObject({ available: false, indeterminate: false, reason: expect.stringMatching(/ANTHROPIC_API_KEY/) });
    });

    it('refuses an unknown provider before running anything', async () => {
        await expect(runTopologyProvider('gemini', { deterministicGraph: fanInGraph() }, {
            complete: () => { throw new Error('must not run'); }
        })).rejects.toThrow(/Unknown topology provider/);
        expect(providerCommand('codex').command).toBe('codex');
    });

    // This used to require both providers to share one ceiling, on the reasoning that a provider cut
    // off where the other may keep working makes a comparison unfair. The measurement says otherwise:
    // codex averages 222 s and Opus 458 s, so one number cannot sit clear of both spreads. Set at
    // Opus's observed worst case of 911 s, 15 minutes cut off a real junction after spending the
    // whole 15 minutes on it — the ceiling stopped being a backstop and became a limit ordinary work
    // reached. What has to hold is headroom over each provider's OWN spread.
    describe('the ceiling on a CLI run', () => {
        // Measured over a 47-junction Opus batch: 458 s mean, 911 s worst — and that worst one was
        // cut off by the old 15-minute ceiling with nothing to show for the 15 minutes.
        const OPUS_WORST_OBSERVED_MS = 911_000;

        it('leaves Opus real headroom over its slowest measured junction', () => {
            expect(PROVIDER_TIMEOUT_MS.claude).toBeGreaterThan(OPUS_WORST_OBSERVED_MS * 1.5);
        });

        it('gives the slower provider the longer ceiling', () => {
            // Opus measured ~4x codex's wall clock over a 47-junction batch.
            expect(PROVIDER_TIMEOUT_MS.claude).toBeGreaterThan(PROVIDER_TIMEOUT_MS.codex);
        });

        it('keeps every ceiling a backstop rather than an hour-long hang', () => {
            Object.values(PROVIDER_TIMEOUT_MS).forEach(ceiling => {
                expect(ceiling).toBeLessThanOrEqual(30 * 60 * 1000);
            });
        });
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

    it('warns about the DGU watermark only when that orthophoto is attached', () => {
        const graph = { sections: [], nodes: [], lanes: [], connections: [], problems: [] };
        const dgu = buildRecognitionPrompt({
            deterministicGraph: graph,
            imagery: { source: { key: 'dgu_dof_lidar_2022_2023' } }
        });
        const city = buildRecognitionPrompt({
            deterministicGraph: graph,
            imagery: { source: { key: 'zagreb_cdof_2022' } }
        });
        expect(dgu).toContain('translucent GEOPORTAL watermark');
        expect(city).not.toContain('translucent GEOPORTAL watermark');
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

    // The layer's error carries the CLI's own reason; the runner's quota stop reads it from the job's
    // error, so it must survive into both the message and the stored tail.
    it('keeps the CLI refusal in the error and its output tail', async () => {
        let failure;
        try {
            await runTopologyProvider('codex', { deterministicGraph: fanInGraph() }, {
                complete: async () => {
                    throw Object.assign(new Error("llm-cost/cli: codex exit 1: ERROR: You've hit your usage limit."), {
                        reason: 'errored', raw: { threadId: 't-1' }
                    });
                }
            });
        } catch (error) {
            failure = error;
        }
        expect(failure?.message).toMatch(/usage limit/i);
        expect(failure?.outputTail).toMatch(/usage limit/i);
        expect(failure?.outputTail).toContain('t-1');
    });

    // Codex states no resolved model and no turn count; the layer names the model it passed and
    // prices the equivalent from the shared rate table. Both providers land in the same shape, or
    // the comparison between them cannot be made.
    it('records Codex token usage from the layer result in the job usage shape', async () => {
        const result = await runTopologyProvider('codex', { deterministicGraph: fanInGraph() }, {
            complete: async () => ({
                data: { summary: 'ok', patch_json: JSON.stringify({ connections: [], problems: [] }) },
                model: 'gpt-6.1-sol',
                usage: { input_tokens: 14991, output_tokens: 199, cache_read_input_tokens: 52480, cache_creation_input_tokens: 11 },
                equivalentUsd: 0.0421,
                costUsd: 0,
                raw: { threadId: 't-2' },
                ms: 222000
            })
        });

        expect(result.usage).toEqual({
            resolvedModel: 'gpt-6.1-sol',
            inputTokens: 14991,
            outputTokens: 199,
            cacheReadTokens: 52480,
            cacheCreationTokens: 11,
            equivalentUsd: 0.0421,
            costUsd: 0,
            durationMs: 222000,
            numTurns: null
        });
        expect(result.summary).toBe('ok');
    });

    // A real Opus probe came back attributed to Haiku: the CLI farms background chores out to a
    // small model, and the ledger took whichever key `modelUsage` listed first. Every claude row in
    // the cost ledger then named the wrong model.
    describe('dominantModel', () => {
        it('credits the model that spent the output tokens, not the first key listed', () => {
            expect(dominantModel({
                'claude-haiku-4-5-20251001': { outputTokens: 312 },
                'claude-opus-5': { outputTokens: 12150 }
            })).toBe('claude-opus-5');
        });

        it('reads the snake_case counts the CLI also emits', () => {
            expect(dominantModel({
                'claude-haiku-4-5-20251001': { output_tokens: 900 },
                'claude-opus-5': { output_tokens: 11000 }
            })).toBe('claude-opus-5');
        });

        // A real envelope: the chore model listed first, 1.7% of the bill, and the model that
        // actually answered listed second.
        it('credits by the per-model cost the CLI reports when it has one', () => {
            expect(dominantModel({
                'claude-haiku-4-5-20251001': { outputTokens: 13, costUSD: 0.000971 },
                'claude-opus-5': { outputTokens: 166, costUSD: 0.054617 }
            })).toBe('claude-opus-5');
        });

        it('keeps the single-model answer unchanged', () => {
            expect(dominantModel({ 'claude-opus-5': { outputTokens: 4 } })).toBe('claude-opus-5');
        });

        it('falls back to the CLI order when nothing reports output tokens', () => {
            expect(dominantModel({ 'claude-opus-5': {}, 'claude-haiku-4-5-20251001': {} }))
                .toBe('claude-opus-5');
        });

        it('has no answer when no model was billed', () => {
            expect(dominantModel({})).toBe(null);
            expect(dominantModel(undefined)).toBe(null);
        });
    });

    // A large patch must not push the usage out of anything: the counts come from the layer's
    // result, never scraped back off the 8000-char tail, and the claude envelope's own modelUsage
    // decides which model did the work (the chore model is listed first here, as it really is).
    it('reports the token usage of a run whose patch is far larger than the output tail', async () => {
        const patch = {
            connections: [{ fromLaneId: 'in1', toLaneId: 'out', type: 'continue', confidence: 0.9 }],
            problems: [{ type: 'padding', severity: 'info', message: 'x'.repeat(20000) }]
        };
        const envelope = {
            type: 'result',
            usage: { input_tokens: 1234, output_tokens: 567, cache_read_input_tokens: 89 },
            modelUsage: {
                'claude-haiku-4-5-20251001': { outputTokens: 13, costUSD: 0.000971 },
                'claude-opus-5': { outputTokens: 554, costUSD: 1.249 }
            },
            total_cost_usd: 1.25,
            duration_ms: 42000,
            num_turns: 3
        };

        const result = await runTopologyProvider('claude', {
            selection: {},
            osmWays: [],
            deterministicGraph: fanInGraph()
        }, {
            complete: async () => ({
                data: { summary: 'ok', patch_json: JSON.stringify(patch) },
                model: 'claude-haiku-4-5-20251001',
                usage: { input_tokens: 1234, output_tokens: 567, cache_read_input_tokens: 89, cache_creation_input_tokens: 0 },
                equivalentUsd: 1.25,
                costUsd: 0,
                raw: envelope,
                ms: 43000
            })
        });

        expect(result.outputTail.length).toBeLessThanOrEqual(8000);
        expect(result.outputTail).not.toContain('input_tokens');
        expect(result.usage).toEqual({
            resolvedModel: 'claude-opus-5',
            inputTokens: 1234,
            outputTokens: 567,
            cacheReadTokens: 89,
            cacheCreationTokens: 0,
            equivalentUsd: 1.25,
            costUsd: 0,
            durationMs: 42000,
            numTurns: 3
        });
        expect(result.graph.connections.some(connection => connection.source === 'claude')).toBe(true);
    });

    it('keeps what the model returned when its patch is rejected', async () => {
        let failure;
        try {
            await runTopologyProvider('codex', { deterministicGraph: fanInGraph() }, {
                complete: async () => ({ data: { summary: 'no patch here' }, model: 'm', usage: null, raw: null })
            });
        } catch (error) {
            failure = error;
        }
        expect(failure?.message).toMatch(/incomplete topology decision patch/);
        expect(failure?.outputTail).toContain('PATCH REJECTED');
        expect(failure?.outputTail).toContain('no patch here');
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

// One bad movement among good ones used to destroy the whole answer.
//
// applyRecognitionPatch threw on the first unusable connection, so the entire patch died with it:
// five real jobs failed this way, one of them on connection 34 of 34 — thirty-three good movements
// thrown away by the last — costing 61 minutes of model time that produced nothing. Restricted and
// wrong-node movements were already dropped-and-reported; a movement between lanes that do not meet
// is the same kind of thing.
describe('a patch with one unusable movement in it', () => {
    const graph = fanInGraph;
    const good = { fromLaneId: 'in1', toLaneId: 'out', type: 'turn', confidence: 0.9, reason: 'ok' };
    // `out` leaves the junction and `in2` arrives at it, so this runs the wrong way down `in2`.
    const backwards = { fromLaneId: 'out', toLaneId: 'in2', type: 'turn', confidence: 0.9, reason: 'x' };

    it('keeps the movements that are usable', () => {
        const result = applyRecognitionPatch({ connections: [good, backwards], problems: [] }, graph());
        expect(result.connections.map(c => `${c.fromLaneId}->${c.toLaneId}`)).toEqual(['in1->out']);
    });

    it('reports what it dropped, naming the lanes, so the next one is diagnosable', () => {
        const result = applyRecognitionPatch({ connections: [good, backwards], problems: [] }, graph());
        const problem = result.problems.find(p => p.type === 'malformed_movements');
        expect(problem).toBeTruthy();
        expect(problem.message).toContain('connection 1');
        expect(problem.message).toContain('out');
        expect(problem.message).toContain('in2');
    });

    it('drops a movement naming a lane that is not in the graph', () => {
        const result = applyRecognitionPatch({
            connections: [good, { fromLaneId: 'L999', toLaneId: 'out', confidence: 0.5 }],
            problems: []
        }, graph());
        expect(result.connections).toHaveLength(1);
        expect(result.problems.some(p => p.type === 'malformed_movements')).toBe(true);
    });

    // The guard that keeps "partial" from becoming "empty": a patch where nothing survives is a
    // broken answer, and storing it would mark the junction answered with nothing in it.
    it('still fails when not one movement survives', () => {
        expect(() => applyRecognitionPatch({ connections: [backwards], problems: [] }, graph()))
            .toThrow(/Every one of the 1 returned movements was unusable/);
    });

    it('leaves a patch that proposed nothing alone', () => {
        expect(() => applyRecognitionPatch({ connections: [], problems: [] }, graph())).not.toThrow();
    });
});

// The rule the validator enforces, now stated instead of inferred. A movement runs from a lane
// ENDING at the node into a lane STARTING there; measured on a real crop only ~28% of naive lane
// pairings satisfy that, because every two-way street offers an arriving lane and a departing one
// that differ only in direction.
describe('what a recognition target tells the model about its own node', () => {
    const targetsFor = graph => recognitionTargets(graph);

    it('names the legal handles on each side of the movement', () => {
        const graph = fanInGraph();
        graph.problems = [{
            id: 'p1', type: 'unresolved_intersection', nodeIds: ['junction'], openApproaches: []
        }];
        const [target] = targetsFor(graph);
        // in1/in2/in3 arrive (indices 0,1,2); out leaves (index 3).
        expect(target.enterFrom).toEqual(['L0', 'L1', 'L2']);
        expect(target.leaveInto).toEqual(['L3']);
    });

    it('narrows the arriving side to the approaches that are actually open', () => {
        const graph = fanInGraph();
        graph.problems = [{
            id: 'p1', type: 'unresolved_intersection', nodeIds: ['junction'],
            openApproaches: [{ sectionId: 's2' }]
        }];
        const [target] = targetsFor(graph);
        expect(target.enterFrom).toEqual(['L1']);
        // Everything leaving the node is still a legal destination.
        expect(target.leaveInto).toEqual(['L3']);
    });

    it('states the rule in the prompt, not just in the validator', () => {
        const graph = fanInGraph();
        graph.problems = [{ id: 'p1', type: 'unresolved_intersection', nodeIds: ['junction'], openApproaches: [] }];
        const prompt = buildRecognitionPrompt({ deterministicGraph: graph, selection: {}, osmWays: [] });
        expect(prompt).toContain('enterFrom');
        expect(prompt).toContain('leaveInto');
        expect(prompt).toMatch(/ENDS at the junction node/);
    });
});

// The honesty guard on partial patches. Dropping a movement must not let its junction read as
// answered — a half-answered junction that counts as settled is worse than a failed job, because
// nothing ever comes back to it.
describe('an approach whose movement was dropped', () => {
    it('stays open while the approach that WAS answered closes', () => {
        const graph = fanInGraph();
        graph.problems = [{
            id: 'p1', type: 'unresolved_intersection', nodeIds: ['junction'],
            openApproaches: [{ sectionId: 's1' }, { sectionId: 's2' }]
        }];

        const result = applyRecognitionPatch({
            connections: [
                // Answers the s1 approach, and is fine.
                { fromLaneId: 'in1', toLaneId: 'out', type: 'turn', confidence: 0.9 },
                // Meant to answer s2, but runs backwards up a lane that arrives here. Dropped.
                { fromLaneId: 'out', toLaneId: 'in2', type: 'turn', confidence: 0.9 }
            ],
            problems: []
        }, graph);

        expect(result.connections).toHaveLength(1);
        const open = result.problems.find(p => p.type === 'unresolved_intersection');
        expect(open, 'the junction must not be closed by a movement that was thrown away').toBeTruthy();
        expect(open.openApproaches.map(a => a.sectionId)).toEqual(['s2']);
        expect(result.problems.some(p => p.type === 'malformed_movements')).toBe(true);
    });
});

describe('error-marked junctions', () => {
    it('retains the unresolved node when a model reports a topology error there', () => {
        const graph = partlySolvedGraph();
        const result = applyRecognitionPatch({
            connections: [{
                fromLaneId: 'lane:section:osm:12:0:A:B:forward:0',
                toLaneId: 'lane:section:osm:13:0:B:y:forward:0',
                type: 'turn'
            }],
            problems: [{
                type: 'nonbinary_transition',
                severity: 'error',
                nodeIds: ['B'],
                message: 'Lane split still needs a staged binary event.'
            }]
        }, graph, 'codex');
        expect(result.connections.some(connection => connection.nodeId === 'B')).toBe(true);
        expect(result.problems.some(problem => problem.type === 'unresolved_intersection'
            && problem.nodeIds.includes('B'))).toBe(true);
    });
});
