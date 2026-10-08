// Exercises real protobuf decoding, cross-tile reconstruction and BEV absence/error semantics.
import { describe, expect, it, vi } from 'vitest';
import { PbfWriter } from 'pbf';
import { bbox, bboxPolygon, booleanPointInPolygon, point } from '@turf/turf';
import { BEV_TILES, createBevTileParcelSource } from '../parcels/bev-tile-source.js';
import { createParcelSource } from '../parcels/sources.js';

const E = 65536, S = 2 ** 32, X = 35748, Y = 22724;
const descriptor = { id: 'at-bev-fixture', adapter: 'bev-tiles', endpoint: BEV_TILES, idPrefix: 'AT-BEV-', outFields: ['kg', 'gnr'] };
const wgs = ([x, y]) => [x / S * 360 - 180, 180 / Math.PI * Math.atan(Math.sinh(Math.PI * (1 - 2 * y / S)))];
const rect = (w, n, e, s) => [[w, n], [e, n], [e, s], [w, s], [w, n]];
const absolute = ring => ring.map(([x, y]) => [X * E + x, Y * E + y]);
const parcelRings = [rect(100, 100, E + 100, 1000), rect(200, 200, 300, 300).reverse()];
const native = '01004:387/1', id = descriptor.idPrefix + native;

function encodeTile(rings, { extent = E, kg = '01004', gnr = '387/1', offsetX = 0, empty = false } = {}) {
    const pbf = new PbfWriter();
    if (empty) return pbf.finish();
    pbf.writeMessage(3, (_, layer) => {
        layer.writeStringField(1, 'gst');
        layer.writeVarintField(15, 2);
        layer.writeVarintField(5, extent);
        for (const key of ['kg', 'gnr']) layer.writeStringField(3, key);
        for (const value of [kg, gnr]) layer.writeMessage(4, (text, writer) => writer.writeStringField(1, text), value);
        layer.writeMessage(2, (_, writer) => {
            writer.writeVarintField(1, 1);
            writer.writePackedVarint(2, [0, 0, 1, 1]);
            writer.writeVarintField(3, 3);
            const commands = [];
            let previousX = 0, previousY = 0;
            const zigzag = number => number < 0 ? -number * 2 - 1 : number * 2;
            for (const ring of rings) {
                const points = ring.slice(0, -1).map(([x, y]) => [x - offsetX, y]);
                commands.push(9);
                points.forEach(([x, y], index) => {
                    if (index === 1) commands.push(((points.length - 1) << 3) | 2);
                    commands.push(zigzag(x - previousX), zigzag(y - previousY));
                    previousX = x; previousY = y;
                });
                commands.push(15);
            }
            writer.writePackedVarint(4, commands);
        });
    });
    return pbf.finish();
}

function locator(rings = parcelRings, props = {}) {
    const coordinates = rings.flat().map(absolutePoint => wgs([X * E + absolutePoint[0], Y * E + absolutePoint[1]]));
    const bounds = [Math.min(...coordinates.map(p => p[0])), Math.min(...coordinates.map(p => p[1])),
        Math.max(...coordinates.map(p => p[0])), Math.max(...coordinates.map(p => p[1]))];
    return { ...bboxPolygon(bounds), properties: { kg: '01004', gnr: '387/1', ez: '123', privateDetails: 'must not be published', ...props } };
}

function fixture({ rings = parcelRings, rightRings, locatorValue = locator(rings), tileOptions = {}, rightMissing = false, override } = {}) {
    return vi.fn(async (input, init) => {
        const url = String(input);
        expect(init.redirect).toBe('error');
        if (override) {
            const result = override(url);
            if (result) return result;
        }
        if (url.includes('/api/all/')) {
            const term = new URL(url).searchParams.get('term');
            return Response.json({ searchTerm: term, data: { type: 'FeatureCollection', ...(term === '01004 387/1' ? { features: [locatorValue] } : {}) } });
        }
        if (url.endsWith('/api/gst/01004/387/1/')) return Response.json(locatorValue);
        if (url.includes('/api/gst/')) return Response.json({ message: 'Grundstück nicht vorhanden' }, { status: 404 });
        const match = url.match(/\/16\/(\d+)\/(\d+)\.pbf$/);
        if (!match) throw new Error('Unexpected request');
        const x = Number(match[1]);
        return new Response(encodeTile(x === X + 1 && rightRings ? rightRings : rings, { offsetX: (x - X) * E, empty: rightMissing && x === X + 1, ...tileOptions }));
    });
}

describe('BEV full parcel reconstruction', () => {
    it('unions buffered tile fragments, preserves a hole, and rereads the same full shape by native reference', async () => {
        const fetchImpl = fixture(), source = createParcelSource(descriptor, { fetchImpl });
        const [west, north] = wgs([X * E + E - 200, Y * E + 150]);
        const [east, south] = wgs([X * E + E + 50, Y * E + 500]);
        const result = await source.queryBounds([west, south, east, north]);
        expect(result).toMatchObject({ complete: true, sourceId: descriptor.id });
        expect(result.features).toHaveLength(1);
        const parcel = result.features[0];
        expect(parcel.id).toBe(id);
        expect(parcel.geometry.type).toBe('Polygon');
        expect(parcel.geometry.coordinates).toHaveLength(2);
        expect(booleanPointInPolygon(point(wgs(absolute([[250, 250]])[0])), parcel)).toBe(false);
        const expected = bbox(locator());
        bbox(parcel).forEach((value, index) => expect(value).toBeCloseTo(expected[index], 10));
        expect(parcel.properties.sourceProperties).toEqual({ kg: '01004', gnr: '387/1', ez: '123' });
        expect(parcel.geometry).not.toEqual(locator().geometry);
        const before = fetchImpl.mock.calls.length;
        const reread = await source.queryIds([id, id]);
        expect(reread.features).toEqual(result.features);
        expect(reread.absentIds).toEqual([]);
        expect(fetchImpl.mock.calls.length - before).toBe(3);
    });

    it('preserves disconnected pieces instead of substituting the locator rectangle', async () => {
        const rings = [rect(100, 100, 200, 200), rect(300, 300, 400, 400)];
        const result = await createBevTileParcelSource(descriptor, { fetchImpl: fixture({ rings }) }).queryIds([id]);
        expect(result.features[0].geometry.type).toBe('MultiPolygon');
        expect(result.features[0].geometry.coordinates).toHaveLength(2);
    });

    it('distinguishes confirmed absence from generic HTTP404 and never caches a missing parcel', async () => {
        const fetchImpl = fixture(), source = createBevTileParcelSource(descriptor, { fetchImpl });
        const absent = descriptor.idPrefix + '01004:999999999';
        await expect(source.queryIds([absent])).resolves.toMatchObject({ complete: true, features: [], absentIds: [absent] });
        await source.queryIds([absent]);
        expect(fetchImpl).toHaveBeenCalledTimes(4);
        const generic = fixture({ override: url => url.includes('/api/gst/') ? new Response('<html>Not found</html>', { status: 404 }) : null });
        await expect(createBevTileParcelSource(descriptor, { fetchImpl: generic }).queryIds([absent])).rejects.toMatchObject({ code: 'parcel-source-unavailable' });
    });

    it('fails closed when a tile omits the far side of a parcel', async () => {
        await expect(createBevTileParcelSource(descriptor, { fetchImpl: fixture({ rightMissing: true }) }).queryIds([id])).rejects.toThrow(/tile edge/);
    });

    it('accepts a generalized outline inside a wider locator while still rejecting a missing far-side fragment', async () => {
        const locatorValue = locator([rect(90, 90, E + 110, 1010)]);
        const complete = await createBevTileParcelSource(descriptor, { fetchImpl: fixture({ locatorValue }) }).queryIds([id]);
        expect(complete.features).toHaveLength(1);
        expect(complete.features[0].geometry).not.toEqual(locatorValue.geometry);
        await expect(createBevTileParcelSource(descriptor, { fetchImpl: fixture({ locatorValue, rightMissing: true }) })
            .queryIds([id])).rejects.toThrow(/tile edge/);
    });

    it('rejects tile geometry extending outside the locator envelope', async () => {
        const locatorValue = locator([rect(110, 110, E + 90, 990)]);
        await expect(createBevTileParcelSource(descriptor, { fetchImpl: fixture({ locatorValue }) })
            .queryIds([id])).rejects.toThrow(/locator bounds/);
    });

    it('rejects contradictory neighbouring fragment edges and a missing very narrow cut', async () => {
        const rings = [rect(100, 100, E + 100, 1000)], rightRings = [rect(100, 110, E + 100, 990)];
        await expect(createBevTileParcelSource(descriptor, { fetchImpl: fixture({ rings, rightRings }) })
            .queryIds([id])).rejects.toThrow(/tile edge/);
        const narrow = [rect(E - 100, 100, E + 100, 101)];
        await expect(createBevTileParcelSource(descriptor, { fetchImpl: fixture({ rings: narrow, rightMissing: true }) })
            .queryIds([id])).rejects.toThrow(/tile edge/);
    });

    it('fails closed on mismatched locator identity and changed tile resolution', async () => {
        await expect(createBevTileParcelSource(descriptor, { fetchImpl: fixture({ locatorValue: locator(parcelRings, { gnr: '999' }) }) }).queryIds([id])).rejects.toThrow(/identity/);
        await expect(createBevTileParcelSource(descriptor, { fetchImpl: fixture({ tileOptions: { extent: 4096 } }) }).queryIds([id])).rejects.toThrow(/resolution/);
    });

    it.each([403, 429, 502])('preserves provider HTTP%s failures without reporting absence', async status => {
        const fetchImpl = fixture({ override: () => new Response('{}', { status, headers: { 'Retry-After': '45' } }) });
        await expect(createBevTileParcelSource(descriptor, { fetchImpl }).queryIds([id])).rejects.toMatchObject({ upstreamStatus: status });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('enforces tile and byte budgets before returning incomplete data', async () => {
        const fetchImpl = fixture();
        await expect(createBevTileParcelSource({ ...descriptor, maxTiles: 1 }, { fetchImpl }).queryIds([id])).rejects.toThrow(/tile limit/);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        const oversized = fixture({ override: url => url.includes('.pbf') ? new Response('x', { headers: { 'Content-Length': '5000000' } }) : null });
        await expect(createBevTileParcelSource(descriptor, { fetchImpl: oversized }).queryIds([id])).rejects.toThrow(/oversized/);
    });

    it('rejects an unexpected endpoint and unsafe references before network access', async () => {
        expect(() => createBevTileParcelSource({ ...descriptor, endpoint: 'https://example.com/' })).toThrow(/descriptor/);
        const fetchImpl = fixture(), source = createBevTileParcelSource(descriptor, { fetchImpl });
        for (const value of ['AT-BEV-01004:../1', 'AT-BEV-01004:1?x=1', 'OTHER-01004:1']) {
            await expect(source.queryIds([value])).rejects.toMatchObject({ status: 400 });
        }
        expect(fetchImpl).not.toHaveBeenCalled();
    });
});
