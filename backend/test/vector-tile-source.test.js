// Parcels rebuilt from a vector-tile snapshot: tile-cut rows are followed into neighbouring tiles,
// joined, given outline references, and village-seam overlaps resolved like any other source.
import { describe, expect, it, vi } from 'vitest';
import { PbfWriter } from 'pbf';
import { area, bbox as geometryBbox, intersect } from '@turf/turf';
import { createParcelSource } from '../parcels/sources.js';
import { OVERLAP_GROUND_POLICY } from '../parcels/overlap-ground.js';

const Z = 14, E = 4096, S = 2 ** Z * E, X = 11643, Y = 7135;
const wgs = ([x, y]) => [x / S * 360 - 180, 180 / Math.PI * Math.atan(Math.sinh(Math.PI * (1 - 2 * y / S)))];
const descriptor = { adapter: 'vector-tiles', id: 'in-mp-test-tiles', endpoint: 'https://tiles.example.test/mp/{z}/{x}/{y}.pbf',
    zoom: Z, layer: 'parcels', groupFields: ['ulpin'], parcelNumberField: 'parcel_no', outFields: ['ulpin', 'parcel_no', 'village'],
    idPrefix: 'IN-MP-TEST-', identityKind: 'geometry-sha256-v1', lookupCellSize: 0.002, maxBboxKm2: 4 };
// Rings in absolute grid units [west, north, east, south]; tiles carry them with a 64-unit buffer.
const rect = (w, n, e, s) => [[w, n], [e, n], [e, s], [w, s], [w, n]];
const at = (dx, dy) => [X * E + dx, Y * E + dy];
const rows = {
    // Crosses from tile X into tile X+1.
    A: { props: { ulpin: 'A', parcel_no: '10', village: 'East' }, ring: rect(...at(3800, 100), ...at(4400, 600)) },
    B: { props: { ulpin: 'B', parcel_no: '11', village: 'West' }, ring: rect(...at(1000, 1000), ...at(1300, 1300)) },
    // A larger plot from the neighbouring village map reaching over B's east edge.
    C: { props: { ulpin: 'C', parcel_no: '7', village: 'East' }, ring: rect(...at(1200, 900), ...at(1700, 1400)) },
    // Crosses into tile X+1 by a 10-unit-tall sliver that a tile builder may drop there.
    D: { props: { ulpin: 'D', parcel_no: '12', village: 'East' }, ring: rect(...at(3900, 2000), ...at(4100, 2010)) },
    // One key published for two separate plots of the same tile.
    E1: { props: { ulpin: 'E', parcel_no: '30', village: 'West' }, ring: rect(...at(200, 3000), ...at(300, 3100)) },
    E2: { props: { ulpin: 'E', parcel_no: '30', village: 'West' }, ring: rect(...at(2000, 3000), ...at(2100, 3100)) },
    // Tile X+1 simplified this row's edge 40 units shorter (F) or 200 units shorter (G) than tile X did.
    F: { props: { ulpin: 'F', parcel_no: '40', village: 'East' }, ring: rect(...at(3900, 3200), ...at(4300, 3500)),
        ringByTile: { [X + 1]: rect(...at(3900, 3200), ...at(4300, 3460)) } },
    G: { props: { ulpin: 'G', parcel_no: '41', village: 'East' }, ring: rect(...at(3900, 3600), ...at(4300, 3900)),
        ringByTile: { [X + 1]: rect(...at(3900, 3600), ...at(4300, 3700)) } }
};

function clipToTile(ring, x, y) {
    const [w, n, e, s] = [x * E - 64, y * E - 64, (x + 1) * E + 64, (y + 1) * E + 64];
    const xs = ring.map(p => p[0]), ys = ring.map(p => p[1]);
    const box = [Math.max(Math.min(...xs), w), Math.max(Math.min(...ys), n), Math.min(Math.max(...xs), e), Math.min(Math.max(...ys), s)];
    if (box[0] >= box[2] || box[1] >= box[3]) return null;
    return rect(...box).map(([px, py]) => [px - x * E, py - y * E]);
}

function encodeTile(x, y, skip = new Set()) {
    const features = Object.entries(rows).filter(([key]) => !skip.has(`${key}@${x}`))
        .map(([, row]) => ({ props: row.props, ring: clipToTile(row.ringByTile?.[x] ?? row.ring, x, y) })).filter(row => row.ring);
    const pbf = new PbfWriter();
    if (!features.length) return pbf.finish();
    const keys = ['ulpin', 'parcel_no', 'village'], values = [];
    const valueIndex = value => { if (!values.includes(value)) values.push(value); return values.indexOf(value); };
    const encoded = features.map(feature => ({ tags: keys.flatMap((key, index) => [index, valueIndex(feature.props[key])]), ring: feature.ring }));
    pbf.writeMessage(3, (_, layer) => {
        layer.writeStringField(1, 'parcels');
        layer.writeVarintField(15, 2);
        layer.writeVarintField(5, E);
        for (const key of keys) layer.writeStringField(3, key);
        for (const value of values) layer.writeMessage(4, (text, writer) => writer.writeStringField(1, text), value);
        for (const feature of encoded) layer.writeMessage(2, (_, writer) => {
            writer.writePackedVarint(2, feature.tags);
            writer.writeVarintField(3, 3);
            const zigzag = number => number < 0 ? -number * 2 - 1 : number * 2;
            // Exterior rings wind clockwise in tile coordinates (y down).
            const points = feature.ring.slice(0, -1);
            const commands = [9, zigzag(points[0][0]), zigzag(points[0][1]), ((points.length - 1) << 3) | 2];
            for (let i = 1; i < points.length; i++) commands.push(zigzag(points[i][0] - points[i - 1][0]), zigzag(points[i][1] - points[i - 1][1]));
            commands.push(15);
            writer.writePackedVarint(4, commands);
        });
    });
    return pbf.finish();
}

function provider({ skip } = {}) {
    const urls = [];
    const fetchImpl = vi.fn(async url => {
        urls.push(String(url));
        const [, x, y] = String(url).match(/\/14\/(\d+)\/(\d+)\.pbf$/).map(Number);
        return new Response(encodeTile(x, y, skip));
    });
    return { fetchImpl, urls };
}
const view = (w, n, e, s) => { const [west, north] = wgs(at(w, n)), [east, south] = wgs(at(e, s)); return [west, south, east, north]; };

describe('vector-tile snapshot parcels', () => {
    it('follows a row cut at a tile edge into the next tile and rereads the joined outline by reference', async () => {
        const { fetchImpl, urls } = provider();
        const source = createParcelSource(descriptor, { fetchImpl });
        const result = await source.queryBounds(view(3700, 50, 3900, 700));
        expect(urls.some(url => url.endsWith(`/14/${X + 1}/${Y}.pbf`))).toBe(true);
        const a = result.features.find(feature => feature.properties.sourceProperties.ulpin === 'A');
        expect(a.id).toMatch(/^IN-MP-TEST-g1~/);
        expect(a.properties.parcelNumber).toBe('10');
        const [west, , east] = geometryBbox(a);
        expect(west).toBeCloseTo(wgs(at(3800, 0))[0], 7);
        expect(east).toBeCloseTo(wgs(at(4400, 0))[0], 7);
        const exact = await source.queryIds([a.id]);
        expect(exact.features.map(feature => feature.id)).toEqual([a.id]);
        expect(exact.features[0].geometry).toEqual(a.geometry);
        expect((await source.queryIds([a.id.replace(/~[0-9a-f]{64}$/, `~${'0'.repeat(64)}`)])).absentIds).toHaveLength(1);
    });

    it('reuses decoded tiles for a repeated view', async () => {
        const { fetchImpl } = provider();
        const source = createParcelSource(descriptor, { fetchImpl });
        await source.queryBounds(view(900, 900, 1400, 1400));
        const calls = fetchImpl.mock.calls.length;
        await source.queryBounds(view(900, 900, 1400, 1400));
        expect(fetchImpl.mock.calls.length).toBe(calls);
    });

    it('refuses a row whose cut has no matching fragment in the neighbouring tile', async () => {
        const { fetchImpl } = provider({ skip: new Set([`A@${X + 1}`]) });
        const source = createParcelSource(descriptor, { fetchImpl });
        await expect(source.queryBounds(view(3700, 50, 3900, 700))).rejects.toThrow(/do not close/);
    });

    it('accepts a sliver the neighbouring tile dropped, but only up to about ten metres of cut', async () => {
        const { fetchImpl } = provider({ skip: new Set([`D@${X + 1}`]) });
        const result = await createParcelSource(descriptor, { fetchImpl }).queryBounds(view(3950, 1990, 4050, 2020));
        expect(result.features.map(feature => feature.properties.sourceProperties.ulpin)).toEqual(['D']);
        expect(result.droppedSliverCuts).toBe(1);
    });

    it('accepts a cut the neighbour matches up to a simplification gap, and refuses a longer one', async () => {
        const source = createParcelSource(descriptor, { fetchImpl: provider().fetchImpl });
        const f = await source.queryBounds(view(3950, 3250, 4050, 3300));
        expect(f.features.map(feature => feature.properties.sourceProperties.ulpin)).toEqual(['F']);
        expect(f.droppedSliverCuts).toBeGreaterThan(0);
        await expect(source.queryBounds(view(3950, 3650, 4050, 3700))).rejects.toThrow(/do not close/);
    });

    it('keeps two separate plots that share a key apart, with the same outline in every view', async () => {
        const source = createParcelSource(descriptor, { fetchImpl: provider().fetchImpl });
        const alone = await source.queryBounds(view(150, 2950, 350, 3150));
        const both = await source.queryBounds(view(150, 2950, 2150, 3150));
        expect(alone.features).toHaveLength(1);
        expect(both.features).toHaveLength(2);
        expect(both.features.find(feature => feature.id === alone.features[0].id).geometry).toEqual(alone.features[0].geometry);
    });

    it('cuts a village-seam overlap to the larger plot when overlap resolution is on', async () => {
        const { fetchImpl } = provider();
        const plain = await createParcelSource(descriptor, { fetchImpl }).queryBounds(view(900, 900, 1400, 1400));
        const raw = Object.fromEntries(plain.features.map(feature => [feature.properties.sourceProperties.ulpin, feature]));
        expect(area(intersect(raw.B, raw.C))).toBeGreaterThan(100);
        const resolved = await createParcelSource({ ...descriptor, id: 'in-mp-test-tiles-ground', overlapResolution: OVERLAP_GROUND_POLICY },
            { fetchImpl: provider().fetchImpl }).queryBounds(view(900, 900, 1400, 1400));
        const byUlpin = Object.fromEntries(resolved.features.map(feature => [feature.properties.sourceProperties.ulpin, feature]));
        expect(byUlpin.B.properties.geometryKind).toBe('derived-ground');
        expect(byUlpin.C.properties.geometryKind).toBeUndefined();
        const shared = intersect(byUlpin.B, byUlpin.C);
        expect(shared ? area(shared) : 0).toBeLessThan(0.01);
    });

    it('rejects a descriptor without a grouping key or outline identity', () => {
        const fetchImpl = async () => new Response(new Uint8Array());
        expect(() => createParcelSource({ ...descriptor, groupFields: [] }, { fetchImpl })).toThrow(/Invalid vector-tile/);
        expect(() => createParcelSource({ ...descriptor, identityKind: undefined }, { fetchImpl })).toThrow(/Invalid vector-tile/);
        expect(() => createParcelSource({ ...descriptor, endpoint: 'http://tiles.example.test/{z}/{x}/{y}.pbf' }, { fetchImpl })).toThrow(/Invalid vector-tile/);
    });
});
