// MCP parity for picking a street (ugt_select_parcels action street): an agent lists the street at a
// point with its segments and referable points, selects a segment's plots by side (or the whole
// street, or between two referable points), and gets the street reference a street vote records.
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { createMcpNavigation } from '../agents/mcp-navigation.js';
import { createStreetSegments, createStreetIdentityRegistry, overpassAddresses } from '../streets/street-segments.js';
import { resultSchemaFor } from '../agents/mcp-contracts.js';
const require = createRequire(import.meta.url);
const V = require('../../frontend/js/community/voting.js');

const LNG0 = -0.1, LAT0 = 51.5, M_PER_DEG = Math.PI * 6378137 / 180;
const ll = ([x, y]) => [LNG0 + x / (M_PER_DEG * Math.cos(LAT0 * Math.PI / 180)), LAT0 + y / M_PER_DEG];
const road = (id, name, points, tags = {}) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: points.map(ll) },
    properties: { osm_id: id, name, highway_type: 'residential', tags: { name, highway: 'residential', ...tags } } });
const box = (id, x0, y0, x1, y1) => ({ type: 'Feature', id, properties: { parcelId: id }, geometry: { type: 'Polygon', coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]].map(ll)] } });
// Hughes Road runs west→east for 300 m; Cross Road branches north at 150 m.
const ROADS = [road(11, 'Hughes Road', [[0, 0], [150, 0], [300, 0]], { 'ref:GB:usrn': '21000001' }), road(13, 'Cross Road', [[150, 0], [150, 120]])];
const PARCELS = [
    ...[0, 1, 2, 3, 4, 5].map(i => box(`n${i}`, i * 25, 8, i * 25 + 25, 40)),
    ...[0, 1, 2, 3, 4, 5].map(i => box(`ne${i}`, 155 + i * 24, 8, 155 + i * 24 + 24, 40)),
    ...[0, 1, 2].map(i => box(`s${i}`, i * 100, -40, i * 100 + 100, -8)),
    box('back', 0, 40, 100, 80)
];

function navigation() {
    const service = createStreetSegments(null, {
        roads: { readNetwork: async () => [], readLiveNetwork: async () => ({ type: 'FeatureCollection', features: ROADS }) },
        fetchBuildings: async () => ({ type: 'FeatureCollection', features: [] }),
        fetchAddresses: async () => overpassAddresses([{ type: 'node', id: 1, lon: ll([20, 15])[0], lat: ll([20, 15])[1], tags: { 'addr:housenumber': '2', 'addr:street': 'Hughes Road' } }]),
        identity: createStreetIdentityRegistry({ async query() { return { rows: [] }; } })
    });
    const read = {
        request: vi.fn(async (path, query) => {
            if (path !== '/streets/segments') throw new Error(`unexpected ${path}`);
            try {
                return await service.read({ point: query.point.split(',').map(Number), from: query.from, to: query.to });
            } catch (error) { throw Object.assign(new Error('Source returned HTTP'), { status: error.status, upstream: { error: error.message, code: error.code } }); }
        }),
        parcels: vi.fn(async () => ({ complete: true, truncated: false, features: PARCELS }))
    };
    return { read, nav: createMcpNavigation({ read }) };
}
const base = { city: 'london', parcelSourceId: 'hmlr-inspire', action: 'street', point: ll([60, 3]) };

describe('ugt_select_parcels action street', () => {
    it('lists the street with its segments, sides and referable points, keeping the selection', async () => {
        const { nav, read } = navigation();
        const listed = await nav.selectParcels({ ...base, selection: { parcelIds: ['x'], focusParcelId: 'x', active: false } });
        expect(listed.selection).toEqual({ parcelSourceId: 'hmlr-inspire', focusParcelId: 'x', parcelIds: ['x'], active: false });
        expect(listed.street).toMatchObject({ name: 'Hughes Road', official: { scheme: 'GB-USRN', id: '21000001' }, lengthM: 300 });
        expect(listed.street.segments.map(s => [s.index, s.from.kind, s.to.kind, s.sides.left])).toEqual([[0, 'end', 'branch', 'north'], [1, 'branch', 'end', 'north']]);
        expect(listed.street.segments[0].to.names).toEqual(['Cross Road']);
        expect(listed.street.points.find(p => p.houseNumber === '2')).toMatchObject({ kind: 'number', side: 'left' });
        expect(read.parcels).not.toHaveBeenCalled();
        expect(resultSchemaFor('ugt_select_parcels').safeParse({ ok: true, ...listed }).success).toBe(true);
    });

    it('selects a segment by side and returns the reference a street vote records', async () => {
        const { nav } = navigation();
        const north = await nav.selectParcels({ ...base, segment: 1, side: 'left' });
        expect(north.selection.parcelIds).toEqual(['ne0', 'ne1', 'ne2', 'ne3', 'ne4', 'ne5']);
        expect(north.streetReference).toMatchObject({ name: 'Hughes Road', part: 'segment', side: 'left', official: { scheme: 'GB-USRN', id: '21000001' },
            from: { kind: 'branch', names: ['Cross Road'] }, to: { kind: 'end' }, osmWayIds: ['11'] });
        // ne0 is also along Cross Road: a corner plot (Strong Suburbs para 6.1), as the map's picker marks it.
        expect(north.streetReference.corners).toEqual([{ parcelId: 'ne0', streets: ['Cross Road'] }]);
        // The voting record takes the reference as it comes.
        const voting = V.configuration({ schema: 'community-voting/v2', id: '6f1c1a52-7c1e-4b5e-9a37-0c6f2d1f4a10', codeHashes: ['a'.repeat(64)], street: north.streetReference });
        expect(voting.street).toEqual(north.streetReference);
        expect(() => V.configuration({ schema: 'community-voting/v2', id: '6f1c1a52-7c1e-4b5e-9a37-0c6f2d1f4a10', codeHashes: ['a'.repeat(64)], street: { ...north.streetReference, side: 'north' } })).toThrow(/side/);
        const south = await nav.selectParcels({ ...base, segment: 0, side: 'right' });
        expect(south.selection.parcelIds).toEqual(['s0', 's1']);
        const whole = await nav.selectParcels({ ...base, segment: 'whole', side: 'both' });
        expect(whole.selection.parcelIds).not.toContain('back');
        expect(whole.selection.parcelIds).toHaveLength(6 + 6 + 3);
        expect(whole.streetReference).toMatchObject({ part: 'street', side: 'both' });
        expect(whole.streetReference.from).toBeUndefined();
    });

    it('selects between two referable points, such as a house number and a branching', async () => {
        const { nav } = navigation();
        const { street } = await nav.selectParcels(base);
        const two = street.points.find(p => p.houseNumber === '2'), branch = street.points.find(p => p.kind === 'branch');
        const part = await nav.selectParcels({ ...base, segment: `${two.id}-${branch.id}`, side: 'left' });
        expect(part.selection.parcelIds).toEqual(['n0', 'n1', 'n2', 'n3', 'n4', 'n5']);
        expect(part.streetReference.from).toMatchObject({ kind: 'number', houseNumber: '2' });
        await expect(nav.selectParcels({ ...base, segment: 'p0-p999' })).rejects.toMatchObject({ code: 'street-point-not-found' });
        await expect(nav.selectParcels({ ...base, segment: 7 })).rejects.toMatchObject({ code: 'street-segment-not-found' });
        await expect(nav.selectParcels({ ...base, point: ll([60, 300]) })).rejects.toMatchObject({ code: 'street-not-found' });
        await expect(nav.selectParcels({ ...base, action: 'select', segment: 0 })).rejects.toMatchObject({ code: 'invalid-parcel-action' });
    });
});
