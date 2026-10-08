// Exercises anonymous outline coverage, fresh geometry identity reads, and the real source-binding boundary without network access.
import { describe, expect, it, vi } from 'vitest';
import { booleanIntersects, feature as geoFeature } from '@turf/turf';
import { createParcelSource } from '../parcels/sources.js';
import { computeSourceBinding, computeSourceParcelActBinding } from '../parcels/source-binding.js';
import { GEOMETRY_IDENTITY_KIND, geometryParcelFeature } from '../parcels/geometry-identity.js';

const descriptor = {
    id: 'nairobi-outlines-test', idPrefix: 'KE-NAI-OUTLINE-', adapter: 'nairobi-outlines',
    endpoint: 'https://nairobimaps.com/api/get_parcels.php', identityKind: GEOMETRY_IDENTITY_KIND,
    maxBboxKm2: 1, maxFeatures: 4000, maxResponseBytes: 2 * 1024 * 1024, lookupCellSize: 0.0025
};
const rectangle = (west, south, east, north) => ({
    type: 'Polygon', coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]]
});
const feature = geometry => ({ type: 'Feature', geometry, properties: {} });
const payload = (features, metadata = {}) => ({
    type: 'FeatureCollection', features,
    metadata: { count: features.length, zoom: 19, limit: 4000, truncated: false, ...metadata }
});
const response = (body, status = 200, headers = {}) => Response.json(body, { status, headers });
const source = (fetchImpl, overrides = {}) => createParcelSource({ ...descriptor, ...overrides }, { fetchImpl });

describe('Nairobi anonymous outline adapter', () => {
    it('rejects an explicit changed bbox, foreign CRS, or disguised error response', async () => {
        for (const extra of [
            { bbox: [-180, -90, 180, 90] },
            { crs: { type: 'name', properties: { name: 'EPSG:3857' } } },
            { error: 'Preview quota reached' }
        ]) {
            await expect(source(async () => response({ ...payload([]), ...extra }))
                .queryBounds([36.845, -1.267, 36.846, -1.266])).rejects.toMatchObject({ status: 502 });
        }
    });

    it('rejects an invalid ID anywhere in a batch before sending a valid first ID', async () => {
        const id = geometryParcelFeature(descriptor, feature(rectangle(36.8452, -1.2662, 36.8453, -1.2661))).id;
        const fetchImpl = vi.fn();
        await expect(source(fetchImpl).queryIds([id, 'OTHER-123'])).rejects.toMatchObject({ status: 400 });
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('enforces the byte cap while reading a body without content-length', async () => {
        await expect(source(async () => new Response(' '.repeat(2048)), { maxResponseBytes: 1024 })
            .queryBounds([36.845, -1.267, 36.846, -1.266])).rejects.toThrow(/byte limit/);
    });

    it('binds an actual outline and its declared geometry reference with no native parcel number', async () => {
        const shape = feature(rectangle(36.8452, -1.2662, 36.8453, -1.2661));
        const canonical = geometryParcelFeature(descriptor, shape);
        const adapter = source(async () => response(payload([shape])));
        const footprint = await computeSourceBinding(adapter, { site: shape.geometry, sourceId: descriptor.id });
        const declared = await computeSourceParcelActBinding(adapter, [canonical.id], { sourceId: descriptor.id });
        for (const output of [footprint, declared]) {
            expect(output.binding.coverage).toBe('complete');
            expect(output.binding.parcels).toHaveLength(1);
            expect(output.binding.parcels[0].parcelId).toBe(canonical.id);
        }
    });

    it('requires complete, consistent response metadata and enforces the app feature cap', async () => {
        const sample = feature(rectangle(36.8452, -1.2662, 36.8453, -1.2661));
        const invalidPayloads = [
            payload([sample], { count: 2 }),
            payload([sample], { zoom: 18 }),
            payload([sample], { limit: 0 }),
            payload([sample], { truncated: true }),
            payload([sample], { limit: 1 })
        ];
        for (const body of invalidPayloads) {
            await expect(source(async () => response(body)).queryBounds([36.845, -1.267, 36.846, -1.266]))
                .rejects.toMatchObject({ status: 502, code: 'parcel-source-unavailable' });
        }
        const overAppCap = source(async () => response(payload([sample, sample])), { maxFeatures: 1 });
        await expect(overAppCap.queryBounds([36.845, -1.267, 36.846, -1.266]))
            .rejects.toMatchObject({ status: 502, code: 'parcel-source-unavailable' });
    });

    it('validates bad bounds as local HTTP 400 before any outbound request', async () => {
        const fetchImpl = vi.fn();
        const adapter = source(fetchImpl);

        await expect(adapter.queryBounds([36.846, -1.267, 36.845, -1.266])).rejects.toMatchObject({ status: 400 });
        await expect(adapter.queryBounds([36.845, -1.267, 40, -1.266])).rejects.toMatchObject({ status: 400 });
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it.each([
        [401, 'parcel-source-blocked'], [403, 'parcel-source-blocked'], [429, 'parcel-source-rate-limited']
    ])('maps upstream HTTP %i into safe provider metadata', async (status, code) => {
        const fetchImpl = vi.fn(async () => response({ message: 'private upstream details' }, status, { 'Retry-After': '42' }));
        const error = await source(fetchImpl).queryBounds([36.845, -1.267, 36.846, -1.266]).catch(value => value);

        expect(error).toMatchObject({ status: 502, upstreamStatus: status, code });
        expect(error.message).not.toContain('private upstream details');
        if (status === 429) expect(error.retryAfterSeconds).toBe(42);
        expect(fetchImpl).toHaveBeenCalledOnce();
    });

    it('does not confuse an upstream 413 with the local invalid-bounds HTTP 400', async () => {
        const fetchImpl = vi.fn(async () => response({}, 413));
        await expect(source(fetchImpl).queryBounds([36.845, -1.267, 36.846, -1.266]))
            .rejects.toMatchObject({ status: 502, upstreamStatus: 413, code: 'parcel-source-unavailable' });
        expect(fetchImpl).toHaveBeenCalledOnce();
    });

    it('cold-resolves only requested synthetic IDs from a fresh 0.0025-degree cell read', async () => {
        const first = feature(rectangle(36.8452, -1.2662, 36.8453, -1.2661));
        const second = feature(rectangle(36.8460, -1.2660, 36.8461, -1.2659));
        const firstCanonical = geometryParcelFeature(descriptor, first);
        const secondCanonical = geometryParcelFeature(descriptor, second);
        const ids = [firstCanonical.id, secondCanonical.id, firstCanonical.id];
        const fetchImpl = vi.fn(async () => response(payload([first, second])));
        const adapter = source(fetchImpl);

        const result = await adapter.queryIds(ids);

        expect(fetchImpl).toHaveBeenCalledOnce();
        const url = new URL(fetchImpl.mock.calls[0][0]);
        expect(url.searchParams.get('bbox')).toBe('36.8449998,-1.2675002,36.8475002,-1.2649998');
        expect(url.searchParams.get('zoom')).toBe('19');
        expect(result.features.map(item => item.id).sort()).toEqual([firstCanonical.id, secondCanonical.id].sort());
        expect(result.absentIds).toEqual([]);
        expect(result.features.every(item => item.properties.sourceParcelId === null && item.properties.parcelNumber === null)).toBe(true);
    });

    it('marks a geometry version absent instead of substituting a changed shape at its locator', async () => {
        const oldGeometry = rectangle(36.8452, -1.2662, 36.8453, -1.2661);
        const newGeometry = rectangle(36.8452, -1.2662, 36.84531, -1.2661);
        const oldId = geometryParcelFeature(descriptor, feature(oldGeometry)).id;
        const current = geometryParcelFeature(descriptor, feature(newGeometry));
        const adapter = source(async () => response(payload([feature(newGeometry)])));

        await expect(adapter.queryIds([oldId])).resolves.toMatchObject({
            features: [], absentIds: [oldId], complete: true
        });
        expect(current.id).not.toBe(oldId);
    });

    it('never returns absence when the fresh bounded request fails', async () => {
        const sample = feature(rectangle(36.8452, -1.2662, 36.8453, -1.2661));
        const id = geometryParcelFeature(descriptor, sample).id;
        const fetchImpl = vi.fn(async () => response({}, 503));

        await expect(source(fetchImpl).queryIds([id])).rejects.toMatchObject({
            status: 502, upstreamStatus: 503, code: 'parcel-source-unavailable'
        });
        expect(fetchImpl).toHaveBeenCalledOnce();
    });

    it('rejects geometry whose envelope is outside the requested cell', async () => {
        const elsewhere = feature(rectangle(36.85, -1.2662, 36.8501, -1.2661));
        const fetchImpl = vi.fn(async () => response(payload([elsewhere])));

        await expect(source(fetchImpl).queryBounds([36.845, -1.267, 36.846, -1.266]))
            .rejects.toMatchObject({ status: 502, code: 'parcel-source-unavailable' });
    });

    it('accepts envelope-only candidates on bounds reads but filters them from a footprint query', async () => {
        const site = rectangle(36.84575, -1.26525, 36.84585, -1.26515);
        const envelopeHitButNoIntersection = feature({
            type: 'Polygon',
            coordinates: [[[36.845, -1.266], [36.846, -1.266], [36.845, -1.265], [36.845, -1.266]]]
        });
        expect(booleanIntersects(envelopeHitButNoIntersection, geoFeature(site))).toBe(false);
        const fetchImpl = vi.fn(async () => response(payload([envelopeHitButNoIntersection])));
        const adapter = source(fetchImpl);

        await expect(adapter.queryBounds([36.84575, -1.26525, 36.84585, -1.26515]))
            .resolves.toMatchObject({ complete: true, features: [expect.objectContaining({ properties: expect.objectContaining({ sourceParcelId: null, parcelNumber: null }) })] });
        await expect(adapter.queryGeometry(site)).resolves.toMatchObject({ complete: true, features: [] });
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('surfaces the source-binding parcel cap as local HTTP 413', async () => {
        const parcel = {
            type: 'Feature', id: 'KE-NAI-OUTLINE-test', geometry: rectangle(36.8452, -1.2662, 36.8453, -1.2661),
            properties: { parcelId: 'KE-NAI-OUTLINE-test', sourceId: descriptor.id }
        };
        const oversizedAdapter = {
            queryGeometry: vi.fn(async () => ({ complete: true, features: Array(5001).fill(parcel) }))
        };

        await expect(computeSourceBinding(oversizedAdapter, {
            site: rectangle(36.8452, -1.2662, 36.8453, -1.2661), sourceId: descriptor.id
        })).rejects.toMatchObject({ status: 413, code: 'too-many-parcels' });
    });

    it('works through the source factory and real binding when a one-outline envelope candidate does not overlap the site', async () => {
        const site = rectangle(36.84575, -1.26525, 36.84585, -1.26515);
        const envelopeHitButNoIntersection = feature({
            type: 'Polygon',
            coordinates: [[[36.845, -1.266], [36.846, -1.266], [36.845, -1.265], [36.845, -1.266]]]
        });
        const fetchImpl = vi.fn(async () => response(payload([envelopeHitButNoIntersection])));
        const adapter = createParcelSource({ ...descriptor }, { fetchImpl });

        const result = await computeSourceBinding(adapter, {
            site,
            sourceId: descriptor.id,
            now: () => new Date('2026-10-08T00:00:00.000Z')
        });

        expect(fetchImpl).toHaveBeenCalledOnce();
        expect(result.binding).toMatchObject({ source: `server:${descriptor.id}`, coverage: 'partial', parcels: [], unknownM2: 0 });
        expect(result.binding.unsurveyedM2).toBeGreaterThan(0);
    });
});
