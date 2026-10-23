// Source adapters and the shared representation contract must preserve geometry and uncertainty,
// and serve bounded read-only queries without inventing permission or applying proposals.
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { gupRepresentation, queryZagrebGup } from '../planning/providers/zagreb-gup.js';
import { planningRepresentations } from '../planning/sources.js';
import { setupPlanningRoutes } from '../routes/planning.js';
const require = createRequire(import.meta.url);
const scene = require('../../frontend/js/planning/scene.js');
const envelopes = require('../../frontend/js/planning/envelopes.js');
const feed = require('../../frontend/js/planning/feed.js');
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
        expect(result.proposalId).toBe('source:zagreb-gup-2025:HR-1-17/2'); expect(result.id).toBe('zagreb-gup-2025:HR-1-17/2');
        expect(result.source.recordId).toBe('HR-1-17/2'); expect(result.source.storage).toBe('public.parcel_build_envelope');
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
    it('keeps a pending-refresh massing and its original calculation provenance visible', () => {
        const input = row(); input.refresh_pending = { code: 'LOCAL_SYNC_PENDING', requestedAt: '2026-10-19T00:00:00Z' };
        const result = gupRepresentation(input);
        expect(result.assessment.refresh).toEqual(input.refresh_pending);
        expect(result.source.solverVersion).toBe('v44'); expect(result.source.computedAt).toBe(input.computed_at);
        expect(result.metrics.floorAreaM2).toBe(150); expect(result.volumes).toHaveLength(2);
        expect(gupRepresentation(row()).assessment.refresh).toBeNull();
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
        const pool = { query: vi.fn().mockResolvedValue(response([row(), invalid, row()], { refresh_count: 2 })) };
        const result = await queryZagrebGup(pool, { bbox: [10, 40, 10.01, 40.01], limit: 2 });
        expect(result.items).toHaveLength(1); expect(result.omitted).toBe(1); expect(result.nextAfter).toBe('17');
        expect(result.summary).toMatchObject({ cachedResults: 20, withGeometry: 3, withoutGeometry: 17, statuses: { no_validated_candidate: 17 } });
        expect(result.summary.awaitingRefresh).toBe(2);
        expect(pool.query).toHaveBeenCalledTimes(1);
        const [sql, parameters] = pool.query.mock.calls[0];
        expect(sql).toContain('FROM public.parcel_build_envelope'); expect(sql).toContain('e.current AND e.gup_id = $7');
        expect(sql).toContain('LEFT JOIN public.envelope_cache_error');
        expect(sql).not.toContain('f.error_detail'); // Internal diagnostics are not a public source explanation.
        expect(sql).toContain('e.geom && ST_Transform'); expect(sql).toContain('ST_Intersects');
        expect(sql).not.toMatch(/\b(?:proposal|INSERT|UPDATE|DELETE|CREATE)\b/i);
        expect(parameters).toEqual([10, 40, 10.01, 40.01, 3, null, 2025]);
        expect(sql).toContain('cestica_id > $6'); expect(sql).toContain('ORDER BY cestica_id LIMIT $5');
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
    it('advances past an entirely invalid page and reads the final page even when the viewport count exceeds the limit', async () => {
        const pool = { query: vi.fn().mockResolvedValueOnce(response([
            { ...row(), cestica_id: 18, floors: [null] }, { ...row(), cestica_id: 19 }
        ])).mockResolvedValueOnce(response([{ ...row(), cestica_id: 19 }], { profile_count: 2 })) };
        const query = { bbox: [10,40,10.01,40.01], limit: 1 };
        const first = await queryZagrebGup(pool, query);
        expect(first.items).toEqual([]); expect(first.omitted).toBe(1); expect(first.nextAfter).toBe('18');
        const last = await queryZagrebGup(pool, { ...query, after: first.nextAfter });
        expect(last.items).toHaveLength(1); expect(last.nextAfter).toBeNull();
        expect(pool.query.mock.calls[1][1]).toEqual([...query.bbox, 2, '18', 2025]);
    });
    it('rejects an invalid source position before querying the database', async () => {
        const pool = { query: vi.fn() };
        await expect(queryZagrebGup(pool, { bbox: [], limit: 200, after: '2147483648' })).rejects.toMatchObject({ status: 400 });
        expect(pool.query).not.toHaveBeenCalled();
    });
    it('supports a different city through a provider without changing the shared contract', async () => {
        const query = vi.fn().mockResolvedValue({ items: [{ id: 'a' }], omitted: 0, truncated: false });
        const result = await planningRepresentations({}, { city: 'sample', source: 'custom' }, [{ descriptor: { city: 'sample', id: 'custom' }, query }]);
        expect(result.schemaVersion).toBe('planning-representations.v1'); expect(result.items).toEqual([{ id: 'a' }]);
        expect(result.sources[0].id).toBe('custom'); expect(query).toHaveBeenCalledTimes(1);
    });
    it('reports an unconnected city as unavailable without querying another city', async () => {
        const query = vi.fn();
        await expect(planningRepresentations({}, { city: 'elsewhere' }, [{ descriptor: { city: 'sample', id: 'custom' }, query }]))
            .rejects.toMatchObject({status:400});
        expect(query).not.toHaveBeenCalled();
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
        { city: 'sample', bbox: '10,40,10.001,40.001', cursor: ['a', 'b'] },
        { city: 'sample', bbox: '10,40,10.001,40.001', cursor: 'a'.repeat(4097) },
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

describe('complete viewport loading', () => {
    const query = { city: 'sample', source: 'source', bbox: [10,40,10.01,40.01], limit: 200 };
    const url = 'https://example.test/planning/representations?city=sample&bbox=10,40,10.01,40.01';
    const page = (items, nextCursor = null, extra = {}) => ({ schemaVersion: 'planning-representations.v1', city: 'sample',
        items, sources: [{ id: 'source' }], summaries: [{ sourceId: 'source', withGeometry: 450, cachedResults: 900, withoutGeometry: 450 }],
        omitted: 0, truncated: Boolean(nextCursor), nextCursor, ...extra });
    const ok = body => ({ ok: true, json: async () => body });

    it('loads more than 200 results across source pages, keeps finished providers and counts their summaries only once', async () => {
        const providers = [450, 1].map((count, index) => ({ descriptor: { city: 'sample', id: `source-${index}` },
            query: vi.fn(async (_pool, { after, limit }) => {
                const start = Number(after || 0), end = Math.min(start + limit, count);
                return { items: Array.from({ length: end - start }, (_, i) => ({ id: `${index}:${start + i}` })),
                    omitted: 0, nextAfter: end < count ? String(end) : null,
                    summary: { sourceId: `source-${index}`, cachedResults: count * 2, withGeometry: count, withoutGeometry: count } };
            }) }));
        const fetchPage = vi.fn(async (address, options) => {
            expect(options.cache).toBe('no-store');
            const cursor = new URL(address).searchParams.get('cursor');
            return ok(await planningRepresentations({}, { ...query, sources: ['source-0','source-1'], ...(cursor ? { cursor } : {}) }, providers));
        });
        const onProgress = vi.fn();
        const result = await feed.loadViewport(url, { city: 'sample', fetchPage, onProgress });
        expect(result.items).toHaveLength(451); expect(new Set(result.items.map(i => i.id)).size).toBe(451);
        expect(result.items).toContainEqual({ id: '0:449' }); expect(result.items).toContainEqual({ id: '1:0' });
        expect(result.summaries).toHaveLength(2); expect(result.summaries.reduce((sum, s) => sum + s.cachedResults, 0)).toBe(902);
        expect(result.nextCursor).toBeNull(); expect(result.truncated).toBe(false);
        expect(fetchPage).toHaveBeenCalledTimes(3); expect(providers[1].query).toHaveBeenCalledTimes(1);
        expect(onProgress.mock.calls.map(([p]) => p.count)).toEqual([201, 401, 451]);
    });
    it('binds the cursor to its city, viewport and connected sources', async () => {
        const provider = { descriptor: { id: 'source', city: 'sample' }, query: vi.fn().mockResolvedValue({ items: [], omitted: 0, nextAfter: '17' }) };
        const { nextCursor: cursor } = await planningRepresentations({}, query, [provider]);
        provider.query.mockClear();
        for (const changed of [{ ...query, city: 'elsewhere' }, { ...query, bbox: [10,40,10.02,40.01] }]) {
            await expect(planningRepresentations({}, { ...changed, cursor }, [provider])).rejects.toMatchObject({ status: 400 });
        }
        await expect(planningRepresentations({}, { ...query, cursor }, [])).rejects.toMatchObject({ status: 400 });
        await expect(planningRepresentations({}, { ...query, cursor: 'broken' }, [provider])).rejects.toMatchObject({ status: 400 });
        expect(provider.query).not.toHaveBeenCalled();
    });
    it('continues after a page with no drawable items and sums omissions without duplicating overlapping identities', async () => {
        const fetchPage = vi.fn().mockResolvedValueOnce(ok(page([{ id: 'a' }], 'second')))
            .mockResolvedValueOnce(ok(page([], 'third', { omitted: 200 })))
            .mockResolvedValueOnce(ok(page([{ id: 'a' }, { id: 'b' }], null)));
        const result = await feed.loadViewport(url, { city: 'sample', fetchPage });
        expect(result.items).toEqual([{ id: 'a' }, { id: 'b' }]); expect(result.omitted).toBe(200);
        expect(result.summaries).toHaveLength(1);
    });
    it('does not return a successful partial viewport when a later page fails', async () => {
        const fetchPage = vi.fn().mockResolvedValueOnce(ok(page([{ id: 'a' }], 'second')))
            .mockResolvedValueOnce({ ok: false, status: 503 });
        await expect(feed.loadViewport(url, { city: 'sample', fetchPage })).rejects.toMatchObject({ status: 503 });
    });
    it('stops obsolete viewport reads before requesting another page', async () => {
        const controller = new AbortController(), fetchPage = vi.fn().mockResolvedValue(ok(page([{ id: 'a' }], 'second')));
        await expect(feed.loadViewport(url, { city: 'sample', fetchPage, signal: controller.signal,
            onProgress: () => controller.abort() })).rejects.toMatchObject({ name: 'AbortError' });
        expect(fetchPage).toHaveBeenCalledTimes(1);
    });
    it('rejects an obsolete response even if the fetcher ignores cancellation', async () => {
        const controller = new AbortController(), onProgress = vi.fn();
        const fetchPage = vi.fn(async () => { controller.abort(); return ok(page([{ id: 'old' }])); });
        await expect(feed.loadViewport(url, { city: 'sample', fetchPage, signal: controller.signal, onProgress })).rejects.toMatchObject({ name: 'AbortError' });
        expect(onProgress).not.toHaveBeenCalled();
    });
    it('rejects a repeated cursor instead of looping forever', async () => {
        const fetchPage = vi.fn().mockResolvedValue(ok(page([{ id: 'a' }], 'same')));
        await expect(feed.loadViewport(url, { city: 'sample', fetchPage })).rejects.toThrow('Repeated planning cursor');
        expect(fetchPage).toHaveBeenCalledTimes(2);
    });
    it.each([{ city: 'wrong' }, { nextCursor: undefined }, { truncated: true, nextCursor: null }])('refuses a mismatched or incomplete paging response %o', async extra => {
        const fetchPage = vi.fn().mockResolvedValue(ok(page([], null, extra)));
        await expect(feed.loadViewport(url, { city: 'sample', fetchPage })).rejects.toThrow('Invalid planning representation response');
    });
});

describe('shared planning scene', () => {
    it('changes one layer independently, retains selection and ignores invalid settings', () => {
        const store = scene.createStore(), listener = vi.fn();
        const off = store.subscribe(listener); store.select('a'); store.configure('permitted', 'solid');
        store.configure('permitted', 'solid'); store.configure('permitted', 'unknown'); store.configure('bogus', 'solid');
        expect(scene.displayPolicy(store.get())).toEqual({ existing: 'off', permitted: 'solid', proposed: 'solid' });
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
        const footprints = envelopes.mapFeatures(item, { detail:'footprint', deps:{ geometry: turf } });
        expect(footprints).toHaveLength(1); expect(footprints[0].geometry.coordinates).toHaveLength(1);
        expect(turf.area(footprints[0])).toBeCloseTo(turf.area(outer), 3);
        expect(envelopes.mapFeatures(item, { detail:'steps', deps:{ geometry: turf } }).map(f=>f.properties.topM)).toEqual([6,9]);
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
        const features = envelopes.volumeFeatures(item);
        expect(features.map(f => f.properties.height)).toEqual([6, 6]);
        expect(features[1].properties.baseM).toBe(3); expect(features[1].properties.partId).toBe('zagreb-gup-2025:HR-1-17/2:floor:2');
        expect(features[1].geometry).toEqual(inset); expect(features[1].properties.role).toBe('permitted');
        expect(features[1].properties.sourceProposalId).toBe(item.proposalId);
    });
    it('refuses an unsupported coordinate frame or invalid vertical range', () => {
        const item = gupRepresentation(row()); item.spatialReference.vertical = 'unknown-datum';
        expect(envelopes.volumeFeatures(item)).toEqual([]);
        item.spatialReference.vertical = 'relative-ground'; item.volumes[1].baseM = 9;
        expect(envelopes.volumeFeatures(item)).toHaveLength(1);
    });
    it('never reuses one city’s viewport key for another city', () => {
        expect(scene.queryKey('a', [10, 40, 11, 41])).not.toBe(scene.queryKey('b', [10, 40, 11, 41]));
    });
});
