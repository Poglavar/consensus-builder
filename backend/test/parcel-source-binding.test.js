// Verifies authoritative binding and parcel acts against complete live-source results, and the
// tiled read of a site larger than its source answers in one query.
import { describe, expect, it, vi } from 'vitest';
import * as turfModule from '@turf/turf';
import {
    computeSourceBinding, computeSourceBindings, computeSourceParcelActBinding, queryTiles, MAX_SOURCE_BINDING_QUERIES,
    SOURCE_BINDING_TIME_BUDGET_MS, TILE_CONCURRENCY
} from '../parcels/source-binding.js';
import { areaLimitError, validateBounds } from '../parcels/source-contract.js';
import { wgs84BboxAreaKm2 } from '../utils/helpers.js';

const turf = turfModule.default || turfModule;

const SOURCE = 'ca-on-toronto';
const SOURCE_PREFIX = 'CA-ON-TORONTO-';
const square = (west, south, east, north) => ({
    type: 'Polygon',
    coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]]
});
const site = square(-79.384, 43.652, -79.374, 43.662);

function parcel(nativeId, geometry, sourceId = SOURCE) {
    const parcelId = `${SOURCE_PREFIX}${nativeId}`;
    return {
        type: 'Feature', id: parcelId, geometry,
        properties: { id: parcelId, parcelId, sourceId, sourceParcelId: String(nativeId) }
    };
}

function adapterWith(features, overrides = {}) {
    return {
        queryGeometry: vi.fn(async () => ({ type: 'FeatureCollection', complete: true, features })),
        queryIds: vi.fn(async ids => ({
            type: 'FeatureCollection', complete: true, features: features.filter(f => ids.includes(f.properties.parcelId)),
            absentIds: ids.filter(id => !features.some(f => f.properties.parcelId === id))
        })),
        ...overrides
    };
}

describe('computeSourceBinding', () => {
    it('normalizes site to MultiPolygon and returns canonical source binding with timestamp', async () => {
        const adapter = adapterWith([
            parcel('101', square(-79.384, 43.652, -79.379, 43.662)),
            parcel('102', square(-79.379, 43.652, -79.374, 43.662))
        ]);
        const now = () => new Date('2026-10-02T10:30:00.000Z');

        const result = await computeSourceBinding(adapter, { site, sourceId: SOURCE, snapshotId: 'snapshot-1', now });

        expect(adapter.queryGeometry).toHaveBeenCalledWith({ type: 'MultiPolygon', coordinates: [site.coordinates] });
        expect(result.site.type).toBe('MultiPolygon');
        expect(result.binding).toMatchObject({
            source: 'server:ca-on-toronto', coverage: 'complete', unknownM2: 0,
            parcelSource: { sourceId: SOURCE, snapshotId: 'snapshot-1' },
            computedAt: '2026-10-02T10:30:00.000Z', toleranceM: 0
        });
        expect(result.binding.parcels.map(item => item.parcelId)).toEqual([
            'CA-ON-TORONTO-101', 'CA-ON-TORONTO-102'
        ]);
    });

    it('applies a bounded tolerance so a narrow contact becomes touched rather than bound', async () => {
        const thin = parcel('201', square(-79.384, 43.652, -79.383999, 43.662));
        const adapter = adapterWith([thin]);
        const result = await computeSourceBinding(adapter, { site, toleranceM: 0.5, sourceId: SOURCE });

        expect(result.binding.toleranceM).toBe(0.5);
        expect(result.binding.parcels).toEqual([]);
        expect(result.binding.touched.map(item => item.parcelId)).toEqual(['CA-ON-TORONTO-201']);
    });

    it('reports partial coverage when the complete response leaves open ground', async () => {
        const adapter = adapterWith([parcel('301', square(-79.384, 43.652, -79.379, 43.662))]);

        const { binding } = await computeSourceBinding(adapter, { site, sourceId: SOURCE });

        expect(binding.coverage).toBe('partial');
        expect(binding.unsurveyedM2).toBeGreaterThan(0);
        expect(binding.unknownM2).toBe(0);
    });

    it('keeps a genuinely empty complete sample as partial open ground', async () => {
        const adapter = adapterWith([]);

        const { binding } = await computeSourceBinding(adapter, { site, sourceId: SOURCE });

        expect(binding).toMatchObject({ coverage: 'partial', parcels: [], touched: [], unknownM2: 0 });
        expect(binding.unsurveyedM2).toBeGreaterThan(0);
    });

    it('rejects incomplete, oversized, foreign, and failed source responses without producing binding', async () => {
        const incomplete = adapterWith([], {
            queryGeometry: vi.fn(async () => ({ type: 'FeatureCollection', complete: false, features: [] }))
        });
        await expect(computeSourceBinding(incomplete, { site, sourceId: SOURCE })).rejects.toThrow(/complete/i);

        const oversized = adapterWith(Array.from({ length: 5001 }, (_, i) => parcel(String(i + 1), square(-79.384, 43.652, -79.383, 43.653))));
        await expect(computeSourceBinding(oversized, { site, sourceId: SOURCE })).rejects.toThrow(/5000/);

        const foreign = adapterWith([parcel('401', square(-79.384, 43.652, -79.383, 43.653), 'other-source')]);
        await expect(computeSourceBinding(foreign, { site, sourceId: SOURCE })).rejects.toThrow(/foreign/i);

        const failed = adapterWith([], { queryGeometry: vi.fn(async () => { throw new Error('provider down'); }) });
        await expect(computeSourceBinding(failed, { site, sourceId: SOURCE })).rejects.toThrow('provider down');
    });

    it('validates site shape and tolerance before querying the provider', async () => {
        const adapter = adapterWith([]);
        await expect(computeSourceBinding(adapter, { site: { type: 'Point', coordinates: [0, 0] }, sourceId: SOURCE })).rejects.toThrow(/Polygon/);
        await expect(computeSourceBinding(adapter, { site, toleranceM: 1.1, sourceId: SOURCE })).rejects.toThrow(/toleranceM/);
        expect(adapter.queryGeometry).not.toHaveBeenCalled();
    });
});

describe('computeSourceBinding over a site larger than one source query', () => {
    // About 3.2 km × 1.7 km (5.3 km²) in Toronto, tiled exactly by a grid of 8 × 4 parcels.
    const BIG = [-79.40, 43.64, -79.36, 43.655];
    const bigSite = square(...BIG);
    const gridParcels = (columns, rows, [w, s, e, n] = BIG, prefix = 'G') => {
        const dx = (e - w) / columns, dy = (n - s) / rows;
        const out = [];
        for (let row = 0; row < rows; row++) {
            for (let column = 0; column < columns; column++) {
                out.push(parcel(`${prefix}${row}-${column}`, square(w + column * dx, s + row * dy, w + (column + 1) * dx, s + (row + 1) * dy)));
            }
        }
        return out;
    };
    const quiet = () => {};

    // A provider that refuses, as the live adapters do, a query whose box is over its limits
    // (validateBounds), and answers every parcel meeting the queried geometry.
    function cappedAdapter(features, { maxBboxKm2 = 1, sides = {}, answer = null, fail = () => null } = {}) {
        const answered = [];
        const adapter = {
            answered,
            queryGeometry: vi.fn(async geometry => {
                const box = turf.bbox(geometry);
                validateBounds(box, maxBboxKm2, sides);
                const failure = fail(box);
                if (failure) throw failure;
                const hits = features.filter(feature => turf.booleanIntersects(feature, turf.feature(geometry)));
                answered.push({ box, ids: hits.map(hit => hit.properties.parcelId) });
                return answer ? answer(hits, box) : { type: 'FeatureCollection', complete: true, features: hits };
            })
        };
        return adapter;
    }
    const ids = binding => binding.parcels.map(hit => hit.parcelId);

    it('plans tiles within the declared limits that cover the box edge to edge', () => {
        const tiles = queryTiles(BIG, { maxBboxKm2: 1 });
        expect(tiles.length).toBeGreaterThan(1);
        for (const [w, s, e, n] of tiles) expect(wgs84BboxAreaKm2(w, s, e, n)).toBeLessThanOrEqual(1);
        expect(tiles.reduce((sum, [w, s, e, n]) => sum + (e - w) * (n - s), 0)).toBeCloseTo((BIG[2] - BIG[0]) * (BIG[3] - BIG[1]), 12);
        expect(queryTiles(BIG, {})).toEqual([BIG]);
        expect(queryTiles([-79.384, 43.652, -79.383, 43.653], { maxBboxKm2: 1 })).toHaveLength(1);
        // A long thin box is cut across its length only.
        expect(queryTiles([-79.5, 43.65, -79.2, 43.6505], { maxBboxKm2: 1 }).length).toBeLessThan(5);
    });

    it('binds every parcel of a site spanning several tiles once, never querying over the limit', async () => {
        const parcels = gridParcels(8, 4);
        const adapter = cappedAdapter(parcels);
        const log = vi.fn();

        const { binding } = await computeSourceBinding(adapter, { site: bigSite, sourceId: SOURCE, limits: { maxBboxKm2: 1 }, log });

        expect(ids(binding)).toEqual(parcels.map(p => p.properties.parcelId).sort());
        expect(binding).toMatchObject({ coverage: 'complete', unsurveyedM2: 0, unknownM2: 0 });
        // Planned from the declared limit: no query was refused, and there were several.
        expect(adapter.queryGeometry.mock.calls.length).toBe(adapter.answered.length);
        expect(adapter.answered.length).toBeGreaterThan(4);
        expect(log).toHaveBeenCalledWith(expect.stringMatching(/over the source's query limit: \d+ tiles/));
        expect(log).toHaveBeenCalledWith(expect.stringMatching(/^tile \d+\/\d+ /));
    });

    it('finds an undeclared limit by the adapter refusing the box, and reads in quarters', async () => {
        const parcels = gridParcels(8, 4);
        const adapter = cappedAdapter(parcels, { maxBboxKm2: 1 });
        const { binding } = await computeSourceBinding(adapter, { site: bigSite, sourceId: SOURCE, log: quiet });
        expect(ids(binding)).toEqual(parcels.map(p => p.properties.parcelId).sort());
        expect(adapter.queryGeometry.mock.calls.length).toBeGreaterThan(adapter.answered.length);

        // Side limits refuse with their own validateBounds message.
        const sided = cappedAdapter(parcels, { maxBboxKm2: 25, sides: { maxBboxWidthM: 900, maxBboxHeightM: 900 } });
        const declared = await computeSourceBinding(sided, { site: bigSite, sourceId: SOURCE, log: quiet,
            limits: { maxBboxWidthM: 900, maxBboxHeightM: 900 } });
        expect(ids(declared.binding)).toHaveLength(32);
        expect(sided.queryGeometry.mock.calls.length).toBe(sided.answered.length);
        const undeclared = cappedAdapter(parcels, { maxBboxKm2: 25, sides: { maxBboxWidthM: 900, maxBboxHeightM: 900 } });
        expect(ids((await computeSourceBinding(undeclared, { site: bigSite, sourceId: SOURCE, log: quiet })).binding)).toHaveLength(32);
    });

    it('reads a tile over the source feature limit in quarters', async () => {
        const parcels = gridParcels(8, 4);
        const adapter = cappedAdapter(parcels, { maxBboxKm2: 25, answer: hits => {
            if (hits.length > 9) throw areaLimitError('Parcel provider query exceeds the parcel limit; use a smaller area.');
            return { type: 'FeatureCollection', complete: true, features: hits };
        } });
        const { binding } = await computeSourceBinding(adapter, { site: bigSite, sourceId: SOURCE, limits: { maxBboxKm2: 25 }, log: quiet });
        expect(ids(binding)).toHaveLength(32);
        expect(binding.coverage).toBe('complete');
    });

    it('does not duplicate a parcel crossing tiles, and binds a parcel answered in fragments on their union', async () => {
        const strip = parcel('STRIP', square(BIG[0] - 0.001, 43.646, BIG[2] + 0.001, 43.649));
        const rest = [square(BIG[0], BIG[1], BIG[2], 43.646), square(BIG[0], 43.649, BIG[2], BIG[3])]
            .map((geometry, i) => parcel(`REST${i}`, geometry));
        const whole = cappedAdapter([strip, ...rest]);
        const { binding } = await computeSourceBinding(whole, { site: bigSite, sourceId: SOURCE, limits: { maxBboxKm2: 1 }, log: quiet });
        expect(ids(binding)).toEqual([`${SOURCE_PREFIX}REST0`, `${SOURCE_PREFIX}REST1`, `${SOURCE_PREFIX}STRIP`]);
        expect(whole.answered.filter(answer => answer.ids.includes(`${SOURCE_PREFIX}STRIP`)).length).toBeGreaterThan(1);
        const stripArea = turf.area(turf.feature(square(BIG[0], 43.646, BIG[2], 43.649)));
        const stripHit = binding.parcels.find(hit => hit.parcelId === `${SOURCE_PREFIX}STRIP`);
        expect(stripHit.overlapM2).toBeCloseTo(stripArea, -1);

        // A source answering only the part of a parcel inside each queried box: the parcel's land is
        // every fragment, not the first tile's.
        const fragments = cappedAdapter([strip, ...rest], { answer: (hits, box) => ({
            type: 'FeatureCollection', complete: true,
            features: hits.map(hit => ({ ...hit, geometry: turf.bboxClip(hit, box).geometry }))
                .filter(hit => hit.geometry.coordinates.length && turf.area(hit) > 0)
        }) });
        const clipped = await computeSourceBinding(fragments, { site: bigSite, sourceId: SOURCE, limits: { maxBboxKm2: 1 }, log: quiet });
        expect(ids(clipped.binding)).toEqual(ids(binding));
        expect(clipped.binding.parcels.find(hit => hit.parcelId === `${SOURCE_PREFIX}STRIP`).overlapM2).toBeCloseTo(stripArea, -1);
        expect(clipped.binding.coverage).toBe('complete');
    });

    it('refuses the whole site when one tile fails, is incomplete or is truncated', async () => {
        const parcels = gridParcels(8, 4);
        const inEast = box => box[2] > -79.365;
        const down = Object.assign(new Error('Parcel provider is unavailable.'), { status: 502, code: 'parcel-source-unavailable' });
        const failing = cappedAdapter(parcels, { fail: box => (inEast(box) ? down : null) });
        await expect(computeSourceBinding(failing, { site: bigSite, sourceId: SOURCE, limits: { maxBboxKm2: 1 }, log: quiet }))
            .rejects.toMatchObject({ code: 'parcel-source-unavailable', status: 502 });
        expect(failing.answered.length).toBeGreaterThan(0);

        const incomplete = cappedAdapter(parcels, { answer: (hits, box) => ({ type: 'FeatureCollection', complete: !inEast(box), features: hits }) });
        await expect(computeSourceBinding(incomplete, { site: bigSite, sourceId: SOURCE, limits: { maxBboxKm2: 1 }, log: quiet }))
            .rejects.toThrow(/complete/i);

        const truncated = cappedAdapter(parcels, { answer: (hits, box) => ({ type: 'FeatureCollection', complete: !inEast(box), truncated: inEast(box), features: hits }) });
        await expect(computeSourceBinding(truncated, { site: bigSite, sourceId: SOURCE, limits: { maxBboxKm2: 1 }, log: quiet }))
            .rejects.toMatchObject({ code: 'too-many-parcels', status: 413 });
    });

    it('still refuses a site meeting more than 5000 parcels when no tile does', async () => {
        const parcels = gridParcels(80, 64);
        const adapter = cappedAdapter(parcels);
        const refusal = computeSourceBinding(adapter, { site: bigSite, sourceId: SOURCE, limits: { maxBboxKm2: 1 }, log: quiet });
        await expect(refusal).rejects.toMatchObject({ code: 'too-many-parcels', status: 413 });
        const error = await refusal.catch(caught => caught);
        expect(error.count).toBeGreaterThan(5000);
        for (const result of adapter.queryGeometry.mock.results) {
            if (result.type === 'return') expect((await result.value).features.length).toBeLessThan(5000);
        }
    });

    it(`refuses a site needing more than ${MAX_SOURCE_BINDING_QUERIES} queries`, async () => {
        // About 1,000 queries of 0.005 km² would cover the 5.3 km² site.
        const adapter = cappedAdapter([], { maxBboxKm2: 0.005 });
        await expect(computeSourceBinding(adapter, { site: bigSite, sourceId: SOURCE, log: quiet }))
            .rejects.toMatchObject({ code: 'parcel-source-area-limit', message: expect.stringMatching(/more than \d+ queries/) });
        expect(adapter.queryGeometry.mock.calls.length).toBe(MAX_SOURCE_BINDING_QUERIES);
    });

    it('refuses a box over the area or side limits under the area-limit code, a malformed one without', () => {
        const refusal = run => { try { run(); } catch (error) { return error; } return null; };
        expect(refusal(() => validateBounds(BIG, 1))).toMatchObject({ status: 400, code: 'parcel-source-area-limit' });
        expect(refusal(() => validateBounds(BIG, 25, { maxBboxWidthM: 900 }))).toMatchObject({ status: 400, code: 'parcel-source-area-limit' });
        const malformed = refusal(() => validateBounds([BIG[2], BIG[1], BIG[0], BIG[3]], 25));
        expect(malformed).toMatchObject({ status: 400 });
        expect(malformed.code).toBeUndefined();
    });

    it('starts no query once reading the site has taken the time budget, and refuses it as too large', async () => {
        // Each query moves the binding's clock on by 10 s as it starts: four start, and the fifth
        // would start at 40 s.
        let elapsed = 0;
        const adapter = cappedAdapter(gridParcels(8, 4), { fail: () => { elapsed += 10_000; return null; } });
        const log = vi.fn();
        await expect(computeSourceBinding(adapter, { site: bigSite, sourceId: SOURCE, limits: { maxBboxKm2: 1 }, log,
            timeBudgetMs: SOURCE_BINDING_TIME_BUDGET_MS, clock: () => elapsed }))
            .rejects.toMatchObject({ code: 'parcel-source-area-limit', status: 422, message: expect.stringMatching(/took over 40 s/) });
        expect(adapter.queryGeometry.mock.calls.length).toBe(TILE_CONCURRENCY);
        expect(log).toHaveBeenCalledWith(expect.stringMatching(/^refused after 4 queries/));
    });
});

// A plan's members bound together: one reading of the source for all of them, each site decided as alone.
describe('computeSourceBindings', () => {
    const features = [
        parcel('201', square(-79.384, 43.652, -79.379, 43.657)),
        parcel('202', square(-79.379, 43.652, -79.374, 43.657)),
        parcel('203', square(-79.384, 43.657, -79.374, 43.662))
    ];
    const west = square(-79.3838, 43.6522, -79.3802, 43.6548);
    const east = square(-79.3788, 43.6522, -79.3752, 43.6548);
    const across = square(-79.381, 43.6555, -79.377, 43.6585);
    const now = () => new Date('2026-11-21T12:00:00.000Z');

    it('reads the source once for every site, and binds each exactly as it is bound alone', async () => {
        const adapter = adapterWith(features);
        const together = await computeSourceBindings(adapter, [{ site: west }, { site: east, toleranceM: 0.5 }, { site: across }],
            { sourceId: SOURCE, now });
        expect(adapter.queryGeometry).toHaveBeenCalledTimes(1);
        for (const [index, [geometry, toleranceM]] of [[west, 0], [east, 0.5], [across, 0]].entries()) {
            const alone = await computeSourceBinding(adapterWith(features), { site: geometry, toleranceM, sourceId: SOURCE, now });
            expect(together[index]).toEqual(alone);
        }
        expect(together.map(result => result.binding.parcels.map(item => item.parcelId))).toEqual([
            ['CA-ON-TORONTO-201'], ['CA-ON-TORONTO-202'], ['CA-ON-TORONTO-201', 'CA-ON-TORONTO-202', 'CA-ON-TORONTO-203']
        ]);
    });

    it('names a binding read in the browser by its origin, and refuses an unknown origin or no sites', async () => {
        const [result] = await computeSourceBindings(adapterWith(features), [{ site: west }], { sourceId: SOURCE, now, origin: 'browser' });
        expect(result.binding.source).toBe('browser:ca-on-toronto');
        await expect(computeSourceBindings(adapterWith(features), [{ site: west }], { sourceId: SOURCE, origin: 'elsewhere' })).rejects.toThrow(/origin/);
        await expect(computeSourceBindings(adapterWith(features), [], { sourceId: SOURCE })).rejects.toThrow(/sites/);
    });

    it('refuses every site when the one reading fails', async () => {
        const adapter = adapterWith(features, { queryGeometry: vi.fn(async () => ({ type: 'FeatureCollection', complete: false, features })) });
        await expect(computeSourceBindings(adapter, [{ site: west }, { site: east }], { sourceId: SOURCE })).rejects.toThrow(/complete/i);
    });
});

describe('computeSourceParcelActBinding', () => {
    it('unions declared parcel geometries and returns geodesic areas plus explicit absent IDs', async () => {
        const first = parcel('501', square(-79.384, 43.652, -79.379, 43.657));
        const second = parcel('502', square(-79.379, 43.652, -79.374, 43.657));
        const absent = `${SOURCE_PREFIX}503`;
        const adapter = adapterWith([first, second]);
        const result = await computeSourceParcelActBinding(adapter, [first.properties.parcelId, second.properties.parcelId, absent], {
            sourceId: SOURCE,
            toleranceM: 0.25,
            now: () => new Date('2026-10-02T12:00:00.000Z')
        });

        expect(adapter.queryIds).toHaveBeenCalledWith([first.properties.parcelId, second.properties.parcelId, absent]);
        expect(result.site.type).toBe('MultiPolygon');
        expect(result.extra).toEqual([absent]);
        expect(result.binding).toMatchObject({
            coverage: 'complete', subject: 'declared-parcels', source: `server:${SOURCE}`,
            parcelSource: { sourceId: SOURCE, snapshotId: null },
            toleranceM: 0.25, unsurveyedM2: 0, unknownM2: 0, computedAt: '2026-10-02T12:00:00.000Z'
        });
        expect(result.binding.parcels).toEqual([
            expect.objectContaining({ parcelId: first.properties.parcelId, overlapM2: expect.any(Number), intrusionM: null }),
            expect.objectContaining({ parcelId: second.properties.parcelId, overlapM2: expect.any(Number), intrusionM: null })
        ]);
        expect(result.binding.siteM2).toBeGreaterThan(0);
    });

    it('requires complete ID results and a consistent absent-ID set', async () => {
        const id = `${SOURCE_PREFIX}601`;
        const incomplete = adapterWith([], {
            queryIds: vi.fn(async () => ({ type: 'FeatureCollection', complete: false, features: [], absentIds: [id] }))
        });
        await expect(computeSourceParcelActBinding(incomplete, [id], { sourceId: SOURCE })).rejects.toThrow(/complete/i);

        const inconsistent = adapterWith([], {
            queryIds: vi.fn(async () => ({ type: 'FeatureCollection', complete: true, features: [], absentIds: [] }))
        });
        await expect(computeSourceParcelActBinding(inconsistent, [id], { sourceId: SOURCE })).rejects.toThrow(/inconsistent/i);
    });

    it('reports every declared ID as extra when a complete lookup finds no parcels', async () => {
        const ids = [`${SOURCE_PREFIX}701`, `${SOURCE_PREFIX}702`];
        const adapter = adapterWith([]);

        const result = await computeSourceParcelActBinding(adapter, ids, { sourceId: SOURCE });

        expect(result.site).toBeNull();
        expect(result.extra).toEqual(ids);
        expect(result.binding).toMatchObject({ coverage: 'complete', subject: 'declared-parcels', parcels: [], siteM2: 0 });
    });

    it('resolves selections larger than the provider request limit in complete batches', async () => {
        const ids = Array.from({ length: 81 }, (_, index) => `${SOURCE_PREFIX}${1000 + index}`);
        const adapter = adapterWith([]);

        const result = await computeSourceParcelActBinding(adapter, ids, { sourceId: SOURCE });

        expect(adapter.queryIds.mock.calls.map(([batch]) => batch.length)).toEqual([80, 1]);
        expect(result.extra).toEqual(ids);
        expect(result.binding).toMatchObject({ coverage: 'complete', parcels: [], siteM2: 0 });
    });

    it('rejects a selection if a later ID batch is incomplete', async () => {
        const ids = Array.from({ length: 81 }, (_, index) => `${SOURCE_PREFIX}${2000 + index}`);
        const adapter = adapterWith([], {
            queryIds: vi.fn()
                .mockResolvedValueOnce({ complete: true, features: [], absentIds: ids.slice(0, 80) })
                .mockResolvedValueOnce({ complete: false, features: [], absentIds: [] })
        });

        await expect(computeSourceParcelActBinding(adapter, ids, { sourceId: SOURCE })).rejects.toThrow(/complete/i);
    });
});
