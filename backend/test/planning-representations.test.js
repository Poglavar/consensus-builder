// Source adapters and the shared representation contract must preserve geometry and uncertainty,
// and serve bounded read-only queries without inventing permission or applying proposals.
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { gupRepresentation, queryZagrebGup } from '../planning/providers/zagreb-gup.js';
import { planningRepresentations } from '../planning/sources.js';
import { setupPlanningRoutes } from '../routes/planning.js';
const require = createRequire(import.meta.url);
const scene = require('../../frontend/js/planning/scene.js');
const turf = require('../../frontend/vendor/turf-6.5.0/turf.min.js');
const geometry = { type: 'Polygon', coordinates: [[[10, 40], [10.001, 40], [10.001, 40.001], [10, 40.001], [10, 40]]] };
const row = () => ({ proposal_id: 'source-a', proposal_data: {
    source: { inputHash: 'version-a', zone: '2.4', gbpM2: 150, maxUnits: 0, applicability: 'unresolved',
        computedAt: '2026-10-10T00:00:00Z', variables: { max_gbp: 200, min_natural_terrain: 30, other_condition: 'retained' } },
    geometry: { superParcel: { type: 'Feature', geometry }, buildings: [
        { type: 'Feature', geometry, properties: { height: 6 } }, { type: 'Feature', geometry, properties: { height: 9 } }
    ] }
} });

describe('planning source adapters', () => {
    it('preserves source identity, all adjoining volumes and unresolved authority without mutating the proposal', () => {
        const input = row(), before = JSON.stringify(input);
        const result = gupRepresentation(input);
        expect(result.proposalId).toBe('source-a');
        expect(result.source.version).toBe('version-a');
        expect(result.source.computedAt).toBe('2026-10-10T00:00:00Z');
        expect(result.volumes.map(volume => [volume.baseM, volume.topM])).toEqual([[0, 6], [0, 9]]);
        expect(result.authority).toEqual({ effect: 'obligatory', basis: 'source-restatement', applicability: 'unresolved' });
        expect(result.assessment.constraints).toBe('not-evaluated');
        expect(result.constraints[0].value).toBe(0);
        expect(result.sourceEvidence.variables.other_condition).toBe('retained');
        expect(result).not.toHaveProperty('applied');
        expect(JSON.stringify(input)).toBe(before);
    });
    it('does not turn missing quantities into zero capacity', () => {
        const input = row(); input.proposal_data.source.gbpM2 = null; input.proposal_data.source.maxUnits = null;
        const result = gupRepresentation(input);
        expect(result.metrics.floorAreaM2).toBeNull();
        expect(result.constraints.some(limit => limit.quantity === 'dwellings')).toBe(false);
    });
    it.each([undefined, -1, 0, Infinity, '6'])('omits a source with invalid height %s rather than making up a volume', height => {
        const input = row(); input.proposal_data.geometry.buildings[1].properties.height = height;
        expect(gupRepresentation(input)).toBeNull();
    });
    it('rejects broken rings and out-of-range coordinates before rendering', () => {
        const input = row();
        input.proposal_data.geometry.buildings[0].geometry = { type: 'Polygon', coordinates: [[[181, 40], [10, 40]]] };
        expect(gupRepresentation(input)).toBeNull();
    });
    it('bounds spatial reads, reports truncation/omissions and does no writes', async () => {
        const invalid = row(); invalid.proposal_data.geometry.buildings = [];
        const pool = { query: vi.fn().mockResolvedValue({ rows: [row(), invalid, row()] }) };
        const result = await queryZagrebGup(pool, { bbox: [10, 40, 10.01, 40.01], limit: 2 });
        expect(result.items).toHaveLength(1); expect(result.omitted).toBe(1); expect(result.truncated).toBe(true);
        expect(pool.query).toHaveBeenCalledTimes(1);
        expect(pool.query.mock.calls[0][0]).toContain('(bounds->>0)::double precision <= $4');
        expect(pool.query.mock.calls[0][1]).toEqual(['zagreb', 10, 40, 10.01, 40.01, 3]);
    });
    it('supports a different city through a provider without changing the shared contract', async () => {
        const query = vi.fn().mockResolvedValue({ items: [{ id: 'a' }], omitted: 0, truncated: false });
        const result = await planningRepresentations({}, { city: 'sample' }, [{ descriptor: { city: 'sample', id: 'custom' }, query }]);
        expect(result.schemaVersion).toBe('planning-representations.v1'); expect(result.items).toEqual([{ id: 'a' }]);
        expect(result.sources[0].id).toBe('custom'); expect(query).toHaveBeenCalledTimes(1);
    });
    it('reports an unconnected city as unavailable without querying another city', async () => {
        const query = vi.fn();
        const result = await planningRepresentations({}, { city: 'elsewhere' }, [{ descriptor: { city: 'sample' }, query }]);
        expect(query).not.toHaveBeenCalled(); expect(result.coverage).toBe('unavailable'); expect(result.items).toEqual([]);
    });
});

describe('bounded planning route', () => {
    async function invoke(parameters, query = vi.fn().mockResolvedValue({ items: [] })) {
        let handler;
        setupPlanningRoutes({ get: (_path, fn) => { handler = fn; } }, {}, { query });
        const res = { statusCode: 200, headers: {}, set(key, value) { this.headers[key] = value; return this; },
            status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
        await handler({ query: parameters }, res);
        return { res, query };
    }
    it('passes a valid viewport to the provider and forbids response caching', async () => {
        const { res, query } = await invoke({ city: 'sample', bbox: '10,40,10.001,40.001', limit: '10' });
        expect(res.statusCode).toBe(200); expect(res.headers['Cache-Control']).toBe('no-store');
        expect(query).toHaveBeenCalledWith({}, { city: 'sample', bbox: [10, 40, 10.001, 40.001], limit: 10 });
    });
    it.each([
        { city: 'sample', bbox: ',40,0.001,40.001' },
        { city: 'sample', bbox: '0,40,0.001,40.001', limit: '' },
        { city: '../sample', bbox: '10,40,10.001,40.001' },
        { city: 'sample', bbox: '10,40,11,41' },
        { city: 'sample', bbox: 'NaN,40,10.001,40.001' },
        { city: 'sample', bbox: '10,40,10.001,40.001', limit: '201' }
    ])('rejects invalid or excessive requests before reading data', async params => {
        const { res, query } = await invoke(params);
        expect(res.statusCode).toBe(400); expect(query).not.toHaveBeenCalled();
    });
    it('reports source failure instead of a successful empty result', async () => {
        const log = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            const { res } = await invoke({ city: 'sample', bbox: '10,40,10.001,40.001' }, vi.fn().mockRejectedValue(new Error('offline')));
            expect(res.statusCode).toBe(503); expect(res.body.code).toBe('planning-source-unavailable');
        } finally { log.mockRestore(); }
    });
});

describe('shared planning scene', () => {
    it('changes one layer independently, retains selection and ignores invalid settings', () => {
        const store = scene.createStore(), listener = vi.fn();
        const off = store.subscribe(listener); store.select('a'); store.configure('permitted', 'solid');
        store.configure('permitted', 'solid'); store.configure('permitted', 'unknown'); store.configure('bogus', 'solid');
        expect(scene.displayPolicy(store.get())).toEqual({ existing: 'ghost', permitted: 'solid', proposed: 'solid' });
        expect(store.get()).toMatchObject({ selectedId: 'a', revision: 2 }); expect(listener).toHaveBeenCalledTimes(2);
        off(); store.select(null); expect(listener).toHaveBeenCalledTimes(2);
    });
    it('allows every combination of three independent display states', () => {
        const store = scene.createStore();
        for (const existing of scene.displayStates) for (const permitted of scene.displayStates) for (const proposed of scene.displayStates) {
            store.configure('existing', existing); store.configure('permitted', permitted); store.configure('proposed', proposed);
            expect(scene.displayPolicy(store.get())).toEqual({ existing, permitted, proposed });
        }
    });
    it('keeps content choices orthogonal to visibility and rerolls only the proposed representation', () => {
        const store = scene.createStore({ existing: 'off', permitted: 'solid', proposed: 'ghost' });
        store.configure('existingScope', 'removed'); store.configure('proposedForm', 'massing'); store.reroll();
        expect(store.get()).toMatchObject({ existingScope: 'removed', proposedForm: 'both', variation: '1' });
        expect(scene.displayPolicy(store.get())).toEqual({ existing: 'off', permitted: 'solid', proposed: 'ghost' });
        expect(scene.settings(store.get())).not.toHaveProperty('selectedId');
        expect(scene.settings(store.get())).not.toHaveProperty('variation');
    });
    it('joins height components into one footprint while retaining explicit height steps', () => {
        const inner = turf.polygon([[[10.0002,40.0002],[10.0008,40.0002],[10.0008,40.0008],[10.0002,40.0008],[10.0002,40.0002]]]);
        const outer = turf.feature(geometry), ring = turf.difference(outer, inner);
        const item = gupRepresentation(row()); item.volumes[0].geometry = ring.geometry; item.volumes[1].geometry = inner.geometry;
        const footprints = scene.mapFeatures(item, 'footprint', turf);
        expect(footprints).toHaveLength(1); expect(footprints[0].geometry.coordinates).toHaveLength(1);
        expect(turf.area(footprints[0])).toBeCloseTo(turf.area(outer), 3);
        expect(scene.mapFeatures(item, 'steps', turf).map(f=>f.properties.height)).toEqual([6,9]);
        expect(item.volumes[0].geometry.coordinates).toHaveLength(2);
    });
    it('selects all, surviving and removed physical geometry without mutating evidence', () => {
        const remainder = { ...geometry, tag: 'remainder' }, demolishedPart = { ...geometry, tag: 'demolished' };
        const record = { remainder, demolishedPart, geometry };
        expect(scene.builtGeometry(geometry, record, 'all')).toBe(geometry);
        expect(scene.builtGeometry(geometry, record, 'surviving')).toBe(remainder);
        expect(scene.builtGeometry(geometry, record, 'removed')).toBe(demolishedPart);
        expect(scene.builtGeometry(geometry, null, 'removed')).toBeNull();
        expect(scene.builtGeometry(geometry, { geometry }, 'surviving')).toBeNull();
        expect(record).toEqual({ remainder, demolishedPart, geometry });
    });
    it('projects the same source geometry and stable part identity into map and model features', () => {
        const item = gupRepresentation(row()); item.volumes[1].baseM = 3;
        const features = scene.volumeFeatures(item);
        expect(features.map(f => f.properties.height)).toEqual([6, 6]);
        expect(features[1].properties.baseM).toBe(3); expect(features[1].properties.partId).toBe('source-a:1');
        expect(features[1].geometry).toEqual(geometry); expect(features[1].properties.role).toBe('permitted');
        expect(features[1].properties.sourceProposalId).toBe('source-a');
    });
    it('refuses an unsupported coordinate frame or invalid vertical range', () => {
        const item = gupRepresentation(row()); item.spatialReference.vertical = 'unknown-datum';
        expect(scene.volumeFeatures(item)).toEqual([]);
        item.spatialReference.vertical = 'relative-ground'; item.volumes[1].baseM = 9;
        expect(scene.volumeFeatures(item)).toHaveLength(1);
    });
    it('never reuses one city’s viewport key for another city', () => {
        expect(scene.queryKey('a', [10, 40, 11, 41])).not.toBe(scene.queryKey('b', [10, 40, 11, 41]));
    });
});
