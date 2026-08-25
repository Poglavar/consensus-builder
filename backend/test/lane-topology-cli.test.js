import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
    applyRecognitionPatch,
    buildRecognitionPrompt,
    dominantModel,
    modelAcceptsImagery,
    PROVIDER_TIMEOUT_MS,
    providerAvailability,
    providerCommand,
    recognitionTargets,
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

// One junction node with two approaches: the rules settled the one arriving on s5 and left the one
// arriving on s2 open. This is what partial resolution produces, and the patch has to honour it —
// a node with connections is no longer proof that the node is finished.
function partiallyOpenGraph(openApproaches = [{ sectionId: 's2', name: 'Ilica', reason: 'multi_lane_approach_without_turn_lanes' }]) {
    const lane = (id, sectionId, fromNode, toNode, coordinates) => ({
        id, sectionId, fromNode, toNode, geometry: { type: 'LineString', coordinates }
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

    // Codex states its usage nowhere but the JSONL event stream, so a run that never asked for
    // events reported nothing — ten solved junctions with no token count at all. Both providers
    // must land in the same shape or the comparison between them cannot be made.
    it('reads Codex token usage out of its event stream', async () => {
        function codexSpawn() {
            const child = new EventEmitter();
            child.stdout = new PassThrough();
            child.stderr = new PassThrough();
            child.kill = () => {};
            child.stdin = {
                end() {
                    queueMicrotask(() => {
                        child.stdout.end([
                            '{"type":"turn.started"}',
                            '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}',
                            '{"type":"turn.completed","usage":{"input_tokens":67471,'
                                + '"cached_input_tokens":52480,"cache_write_input_tokens":11,'
                                + '"output_tokens":159,"reasoning_output_tokens":40}}'
                        ].join('\n'));
                        child.emit('close', 0, null);
                    });
                }
            };
            return child;
        }

        const result = await runCliTopologyProvider('codex', {
            deterministicGraph: fanInGraph()
        }, {
            spawnImpl: codexSpawn,
            timeoutMs: 1000,
            readFileImpl: async () => JSON.stringify({
                summary: 'ok',
                patch_json: JSON.stringify({ connections: [], problems: [] })
            })
        });

        expect(result.usage).toEqual({
            resolvedModel: null,      // codex does not name the model it resolved to
            // 67,471 reported minus the 52,480 of it that were cached. OpenAI counts input
            // INCLUSIVE of cached tokens where Anthropic reports them disjoint, and the shared
            // rate table assumes the latter — billing this verbatim charges the cache twice.
            inputTokens: 14991,
            outputTokens: 199,           // output plus reasoning, which is billed as output
            cacheReadTokens: 52480,
            cacheCreationTokens: 11,
            equivalentUsd: null,          // Codex states no cost; inventing one would be a guess
            durationMs: null,
            numTurns: 1
        });
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

    it('asks Codex for the event stream that carries its usage', () => {
        expect(providerCommand('codex').args({ jobDir: '/tmp/j', schemaPath: '/tmp/s', outputPath: '/tmp/o' }))
            .toContain('--json');
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
            // Keyed by the resolved id, which is how the alias we asked for becomes recordable.
            modelUsage: { 'claude-opus-5': { inputTokens: 1234 } },
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
            resolvedModel: 'claude-opus-5',
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
