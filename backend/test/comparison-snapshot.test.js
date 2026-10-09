import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const codec = require('../../frontend/js/proposals/comparison-snapshot.js');
const pako = require('../../frontend/vendor/pako-2.1.0/pako.min.js');

function exampleInput() {
    return {
        alternatives: [
            { name: 'Café / 東京', proposals: [{ proposalId: 'a-1', title: 'Ångström' }] },
            { name: '第二案', proposals: [{ proposalId: 'b-1', title: 'München' }] }
        ],
        scope: { geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }, source: 'fixed' },
        assumptions: { peoplePerApartment: 2.4 },
        context: { parcels: [{ id: 'P-1', feature: { type: 'Feature', properties: {}, geometry: null } }], city: 'München' }
    };
}

function exampleResult() {
    return {
        engineVersion: 'compare-engine/3',
        scope: { geometry: null, areaM2: null, source: 'union-of-alternatives', complete: false },
        assumptions: { peoplePerApartment: 2.4 },
        alternatives: [
            { name: 'A', metrics: { buildings: 4 }, issues: [], features: { type: 'FeatureCollection', features: [] } },
            { name: 'B', metrics: { buildings: 6 }, issues: [], features: { type: 'FeatureCollection', features: [] } }
        ],
        deltas: { buildings: 2 },
        issues: []
    };
}

function utf8(text) { return new TextEncoder().encode(text); }
function base64url(bytes) { return Buffer.from(bytes).toString('base64url'); }

describe('comparison snapshot codec', () => {
    it('round-trips unicode content, inputs, results, and a reproducible compressed hash', () => {
        const snapshot = codec.create(exampleInput(), exampleResult(), { createdAt: '2026-10-08T12:00:00.000Z' });
        const first = codec.toHash(snapshot);
        expect(first).toMatch(/^#comparison=v1\.[A-Za-z0-9_-]+$/);
        expect(codec.toHash(snapshot)).toBe(first);
        expect(codec.fromHash(first)).toEqual(snapshot);
        expect(codec.parse(codec.stringify(snapshot))).toEqual(snapshot);
    });

    it('does not mutate or retain references to caller inputs', () => {
        const input = exampleInput();
        const result = exampleResult();
        const beforeInput = structuredClone(input);
        const beforeResult = structuredClone(result);
        const snapshot = codec.create(input, result, { createdAt: 'fixed' });
        expect(input).toEqual(beforeInput);
        expect(result).toEqual(beforeResult);
        input.alternatives[0].proposals[0].title = 'changed later';
        result.alternatives[0].buildings = 999;
        expect(snapshot.input.alternatives[0].proposals[0].title).toBe('Ångström');
        expect(snapshot.result.alternatives[0].metrics.buildings).toBe(4);
    });

    it('rejects invalid alternative counts and unsupported snapshot versions', () => {
        const input = exampleInput();
        input.alternatives.pop();
        expect(() => codec.create(input, exampleResult())).toThrow(/exactly two alternatives/);

        const snapshot = codec.create(exampleInput(), exampleResult(), { createdAt: 'fixed' });
        snapshot.version = 2;
        expect(() => codec.stringify(snapshot)).toThrow(/unsupported version/);
        expect(() => codec.fromHash('#comparison=v2.abc')).toThrow(/unsupported hash format or version/);
    });

    it('rejects invalid arrays, malformed JSON, and prototype-related keys', () => {
        expect(() => codec.parse('not json')).toThrow(/malformed JSON/);
        const base = {
            format: 'ugt-comparison', version: 1, createdAt: 'fixed', engineVersion: 'v1',
            input: { alternatives: [{ name: 'A', proposals: [] }, { name: 'B', proposals: 'not an array' }] },
            result: { engineVersion: 'v1' }
        };
        expect(() => codec.parse(JSON.stringify(base))).toThrow(/proposals must be an array/);
        const prototypeKey = '{"format":"ugt-comparison","version":1,"createdAt":"fixed","engineVersion":"v1","input":{"alternatives":[{"proposals":[{"__proto__":{}}]},{"proposals":[]}]},"result":{"engineVersion":"v1"}}';
        expect(() => codec.parse(prototypeKey)).toThrow(/forbidden key __proto__/);
    });

    it('rejects incomplete result shapes, mismatched versions, and invalid preview collections', () => {
        const snapshot = codec.create(exampleInput(), exampleResult(), { createdAt: 'fixed' });
        expect(() => codec.parse(JSON.stringify({ ...snapshot, result: { engineVersion: 'v1' } })))
            .toThrow(/result.scope must be an object/);
        const missingEngineVersion = structuredClone(snapshot);
        delete missingEngineVersion.engineVersion;
        delete missingEngineVersion.result.engineVersion;
        expect(() => codec.stringify(missingEngineVersion)).toThrow(/result.engineVersion must be a non-empty string/);
        expect(() => codec.parse(JSON.stringify({ ...snapshot, engineVersion: 'different' })))
            .toThrow(/engineVersion must match/);
        const invalidFeatures = structuredClone(snapshot);
        invalidFeatures.result.alternatives[0].features = { type: 'FeatureCollection', features: [{}] };
        expect(() => codec.stringify(invalidFeatures)).toThrow(/must be a GeoJSON Feature/);
    });

    it('rejects oversized compressed JSON, decoded gzip output, and hash strings', () => {
        expect(() => codec.parse(' '.repeat(codec.MAX_JSON_BYTES + 1))).toThrow(/JSON exceeds/);
        expect(() => codec.fromHash(`#comparison=v1.${'A'.repeat(codec.MAX_HASH_LENGTH)}`)).toThrow(/hash exceeds/);

        const oversizedJson = JSON.stringify({
            format: 'ugt-comparison', version: 1, createdAt: 'fixed', engineVersion: 'v1',
            input: { alternatives: [{ proposals: [] }, { proposals: [] }] },
            result: { engineVersion: 'v1', padding: 'x'.repeat(codec.MAX_JSON_BYTES) }
        });
        const compressed = pako.gzip(utf8(oversizedJson));
        const hash = `#comparison=v1.${base64url(compressed)}`;
        expect(hash.length).toBeLessThan(codec.MAX_HASH_LENGTH);
        expect(() => codec.fromHash(hash)).toThrow(/decoded JSON exceeds/);
    });

    it('caps proposal and coordinate counts and rejects non-finite values', () => {
        const tooMany = exampleInput();
        tooMany.alternatives[0].proposals = Array(codec.MAX_PROPOSALS + 1).fill({});
        expect(() => codec.create(tooMany, exampleResult())).toThrow(/exceeds 1000 proposals/);

        const tooManyVertices = exampleInput();
        tooManyVertices.scope.geometry.coordinates = [Array(codec.MAX_COORDINATE_VERTICES + 1).fill([0, 0])];
        expect(() => codec.create(tooManyVertices, exampleResult())).toThrow(/coordinate vertices/);

        const deeplyNested = exampleInput();
        deeplyNested.scope.geometry.coordinates = [];
        let deep = deeplyNested.scope.geometry.coordinates;
        for (let i = 0; i < 120; i += 1) { const next = []; deep.push(next); deep = next; }
        expect(() => codec.create(deeplyNested, exampleResult())).toThrow(/nested too deeply/);

        const nonFinite = exampleResult();
        nonFinite.deltas.buildings = Infinity;
        expect(() => codec.create(exampleInput(), nonFinite)).toThrow(/non-finite number/);
    });
});
