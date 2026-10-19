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
const inset = { type: 'Polygon', coordinates: [[[10.0002,40.0002],[10.0008,40.0002],[10.0008,40.0008],[10.0002,40.0008],[10.0002,40.0002]]] };
const row = () => ({ cestica_id: 17, parcel_id: 'HR-1-17/2', gup_id: 2025, zone: '2.4', rule_id: 'rule-a',
    computed_at: '2026-10-10T00:00:00Z', solver_version: 'v44', result_status: 'geometry_validated',
    geometry_status: 'passed', source: 'rule', build_regime: 'new_build', applicability_status: 'unresolved',
    gbp_m2: 150, max_units: 0, new_build_gbp_m2: 150, retained_stock_gbp_m2: 70, parcel_geometry: geometry,
    floors: [
        { geometry, height_m: 3, base_elevation_m: 0, top_elevation_m: 3 },
        { geometry, height_m: 3, base_elevation_m: 3, top_elevation_m: 6 },
        { geometry: inset, height_m: 3, base_elevation_m: 6, top_elevation_m: 9 }
    ] });
const response = (profiles, extra = {}) => ({ rows: [{ cached_count: 20, profile_count: profiles.length,
    status_counts: { geometry_validated: profiles.length, no_validated_candidate: 20 - profiles.length }, profiles, ...extra }] });

describe('planning source adapters', () => {
    it('preserves cached identity, elevations and evidence without creating or mutating proposals', () => {
        const input = row(), before = JSON.stringify(input), result = gupRepresentation(input);
        expect(result.proposalId).toBeNull(); expect(result.id).toBe('zagreb-gup-2025:HR-1-17/2');
        expect(result.source.recordId).toBe('2025:17'); expect(result.source.storage).toBe('public.parcel_build_envelope');
        expect(result.source.computedAt).toBe(input.computed_at); expect(result.source.solverVersion).toBe('v44');
        expect(result.volumes.map(volume => [volume.baseM, volume.topM])).toEqual([[0, 6], [6, 9]]);
        expect(result.volumes[1].geometry).toBe(inset);
        expect(result.authority).toEqual({ effect: 'obligatory', basis: 'solver-cache', applicability: 'unresolved' });
        expect(result.assessment.constraints).toBe('not-evaluated'); expect(result.constraints[0].value).toBe(0);
        expect(result.sourceEvidence.new_build_gbp_m2).toBe(150); expect(result.sourceEvidence.retained_stock_gbp_m2).toBe(70);
        expect(result).not.toHaveProperty('applied'); expect(JSON.stringify(input)).toBe(before);
    });
    it('keeps stable identity but changes source revision when the cached result changes', () => {
        const input = row(), before = gupRepresentation(input);
        input.computed_at = '2026-10-11T00:00:00Z'; input.gbp_m2 = 160;
        const after = gupRepresentation(input);
        expect(after.id).toBe(before.id); expect(after.source.version).not.toBe(before.source.version);
    });
    it('does not turn missing quantities into zero capacity or scalar quantities into geometry', () => {
        const input = row(); input.gbp_m2 = null; input.max_units = null;
        const result = gupRepresentation(input);
        expect(result.metrics.floorAreaM2).toBeNull(); expect(result.constraints).toEqual([]);
        input.floors = null; input.gbp_m2 = 500; expect(gupRepresentation(input)).toBeNull();
    });
    it('labels empirical existing-stock geometry separately from a calculated new-build option', () => {
        const result = gupRepresentation({ ...row(), source: 'empirical', result_status: 'existing_stock_estimate',
            geometry_status: 'not_checked', build_regime: 'reconstruction' });
        expect(result.assessment).toMatchObject({ meaning: 'existing-stock-estimate', geometry: 'not_checked', regime: 'reconstruction' });
    });
    it('preserves overhangs and below-ground floors without the native proposal import restrictions', () => {
        const input = row(); input.floors = [
            { geometry: inset, height_m: 3, base_elevation_m: -3, top_elevation_m: 0 },
            { geometry, height_m: 4, base_elevation_m: 0, top_elevation_m: 4 }
        ];
        expect(gupRepresentation(input).volumes.map(v => [v.geometry, v.baseM, v.topM])).toEqual([[inset, -3, 0], [geometry, 0, 4]]);
    });
    it.each([undefined, -1, 0, Infinity, '3'])('omits an invalid cached floor height %s rather than inventing a volume', height => {
        const input = row(); input.floors[1].height_m = height; expect(gupRepresentation(input)).toBeNull();
    });
    it('rejects broken rings and out-of-range coordinates before rendering', () => {
        const input = row(); input.floors[0].geometry = { type: 'Polygon', coordinates: [[[181, 40], [10, 40]]] };
        expect(gupRepresentation(input)).toBeNull();
    });
    it('does not display rejected geometry or malformed profiles as permitted massing', () => {
        for (const result_status of ['geometry_failed', 'condition_failed']) {
            expect(gupRepresentation({ ...row(), result_status })).toBeNull();
        }
        expect(gupRepresentation({ ...row(), zero_capacity_bound: true })).toBeNull();
        expect(gupRepresentation({ ...row(), floors: [null] })).toBeNull();
    });
    it('reads the sole cache by viewport, bounds geometry and retains non-geometric result counts', async () => {
        const invalid = row(); invalid.floors[0].height_m = 0;
        const pool = { query: vi.fn().mockResolvedValue(response([row(), invalid, row()])) };
        const result = await queryZagrebGup(pool, { bbox: [10, 40, 10.01, 40.01], limit: 2 });
        expect(result.items).toHaveLength(1); expect(result.omitted).toBe(1); expect(result.truncated).toBe(true);
        expect(result.summary).toMatchObject({ cachedResults: 20, withGeometry: 3, withoutGeometry: 17, statuses: { no_validated_candidate: 17 } });
        expect(pool.query).toHaveBeenCalledTimes(1);
        const [sql, parameters] = pool.query.mock.calls[0];
        expect(sql).toContain('FROM public.parcel_build_envelope'); expect(sql).toContain('e.current AND e.gup_id = 2025');
        expect(sql).toContain('e.geom && ST_Transform'); expect(sql).toContain('ST_Intersects');
        expect(sql).not.toMatch(/\b(?:proposal|INSERT|UPDATE|DELETE|CREATE)\b/i);
        expect(parameters).toEqual([10, 40, 10.01, 40.01, 3]);
    });
    it('reads changed upstream results on the next request instead of retaining another cache', async () => {
        const pool = { query: vi.fn().mockResolvedValueOnce(response([row()]))
            .mockResolvedValueOnce(response([{ ...row(), gbp_m2: 200 }])) };
        const query = { bbox: [10,40,10.01,40.01], limit: 2 };
        expect((await queryZagrebGup(pool, query)).items[0].metrics.floorAreaM2).toBe(150);
        expect((await queryZagrebGup(pool, query)).items[0].metrics.floorAreaM2).toBe(200);
        expect(pool.query).toHaveBeenCalledTimes(2);
    });
    it('reports cached results without geometry without manufacturing an envelope or a zero', async () => {
        const pool = { query: vi.fn().mockResolvedValue(response([], { cached_count: 4, status_counts: { evidence_missing: 4 } })) };
        const result = await queryZagrebGup(pool, { bbox: [10,40,10.01,40.01], limit: 2 });
        expect(result.items).toEqual([]); expect(result.omitted).toBe(0);
        expect(result.summary).toMatchObject({ cachedResults: 4, withoutGeometry: 4, statuses: { evidence_missing: 4 } });
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
        expect(scene.mapFeatures(item, 'steps', turf).map(f=>f.properties.topM)).toEqual([6,9]);
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
        expect(features[1].properties.baseM).toBe(3); expect(features[1].properties.partId).toBe('zagreb-gup-2025:HR-1-17/2:floor:2');
        expect(features[1].geometry).toEqual(inset); expect(features[1].properties.role).toBe('permitted');
        expect(features[1].properties.sourceProposalId).toBeNull();
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
