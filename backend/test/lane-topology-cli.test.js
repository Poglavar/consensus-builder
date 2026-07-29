import { describe, expect, it } from 'vitest';
import {
    applyRecognitionPatch,
    buildRecognitionPrompt,
    providerAvailability,
    providerCommand,
    TOPOLOGY_OUTPUT_SCHEMA,
    validateCandidateGraph
} from '../lane-topology/cli-providers.js';

describe('lane-topology CLI provider boundary', () => {
    it('runs Codex ephemerally in a read-only sandbox with structured output', () => {
        const args = providerCommand('codex').args({
            jobDir: '/tmp/topology-job',
            schemaPath: '/tmp/topology-job/schema.json',
            outputPath: '/tmp/topology-job/output.json'
        });
        expect(args).toContain('--ephemeral');
        expect(args).toContain('read-only');
        expect(args).toContain('--output-schema');
        expect(args).toContain('model_reasoning_effort="medium"');
        expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
        expect(TOPOLOGY_OUTPUT_SCHEMA.additionalProperties).toBe(false);
        expect(TOPOLOGY_OUTPUT_SCHEMA.required).toEqual(['summary', 'patch_json']);
        expect(TOPOLOGY_OUTPUT_SCHEMA.properties.patch_json.type).toBe('string');
    });

    it('runs Claude without tools and with JSON schema validation', () => {
        const args = providerCommand('claude').args({});
        expect(args).toContain('--safe-mode');
        expect(args).toContain('--tools');
        expect(args[args.indexOf('--tools') + 1]).toBe('');
        expect(args).toContain('--json-schema');
        expect(args).not.toContain('--dangerously-skip-permissions');
    });

    it('requires binary ordinary merge and split events in the recognition prompt', () => {
        const prompt = buildRecognitionPrompt({
            selection: { bbox: [1, 2, 3, 4] },
            deterministicGraph: { sections: [], nodes: [], lanes: [], connections: [], problems: [] }
        });
        expect(prompt).toContain('ordinary merge is binary');
        expect(prompt).toContain('ordinary split is binary');
        expect(prompt).toContain('Do not hallucinate missing connections');
        expect(prompt).toContain('patch_json');
        expect(prompt).toContain('Do not re-emit sections');
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
        expect(availability).toEqual({ available: false, version: null });
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
