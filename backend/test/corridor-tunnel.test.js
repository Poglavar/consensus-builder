// Unit tests for building collision detection and stable tunnel-edge metadata.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    corridorTunnelEdgeKey,
    findBuildingTunnelIntersections,
    makeBuildingTunnelRecord,
    addBuildingTunnelRecord,
    removeBuildingTunnelEdge,
    corridorSurfaceRuns
} = require('../../frontend/js/corridor-tunnel.js');

function fakeTurf(intersections = new Map()) {
    return {
        intersect: (_corridor, building) => intersections.get(building.properties.id) || null,
        area: feature => feature.properties.area
    };
}

describe('corridor building tunnels', () => {
    const from = { lat: 45.8, lng: 15.9 };
    const to = { lat: 45.81, lng: 15.91 };

    it('uses the same edge key in either drawing direction', () => {
        expect(corridorTunnelEdgeKey(from, to)).toBe(corridorTunnelEdgeKey(to, from));
    });

    it('keeps only building intersections with meaningful overlap', () => {
        const buildings = [
            { type: 'Feature', properties: { id: 'a' }, geometry: { type: 'Polygon', coordinates: [] } },
            { type: 'Feature', properties: { id: 'b' }, geometry: { type: 'Polygon', coordinates: [] } }
        ];
        const overlaps = new Map([
            ['a', { type: 'Feature', properties: { area: 12 }, geometry: { type: 'Polygon', coordinates: [] } }],
            ['b', { type: 'Feature', properties: { area: 0.1 }, geometry: { type: 'Polygon', coordinates: [] } }]
        ]);
        const hits = findBuildingTunnelIntersections(
            { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [] } },
            buildings,
            fakeTurf(overlaps)
        );
        expect(hits.map(hit => hit.id)).toEqual(['a']);
    });

    it('adds, replaces and removes records by edge rather than direction', () => {
        const first = makeBuildingTunnelRecord(from, to, [{ id: 'building-a' }], { segmentId: 's1' });
        const replacement = makeBuildingTunnelRecord(to, from, [{ id: 'building-b' }], { segmentId: 's1' });
        const records = addBuildingTunnelRecord([], first);
        addBuildingTunnelRecord(records, replacement);
        expect(records).toHaveLength(1);
        expect(records[0].buildingIds).toEqual(['building-b']);
        expect(removeBuildingTunnelEdge(records, from, to)).toEqual([]);
    });
});

// Tunnel spans are covered structures that acquire nothing: surface runs are the centerline
// minus tunnelled edges, and they drive parent collection and parcel splitting.
describe('corridorSurfaceRuns', () => {
    const p = (lng) => ({ lat: 0, lng });
    const seg = [p(0), p(1), p(2), p(3)];
    const tunnelOn = (a, b) => [{ edgeKey: corridorTunnelEdgeKey(a, b) }];

    it('passes the whole segment through when there are no tunnels', () => {
        expect(corridorSurfaceRuns([seg], [])).toEqual([seg]);
    });

    it('splits a segment into runs around a tunnelled edge', () => {
        const runs = corridorSurfaceRuns([seg], tunnelOn(p(1), p(2)));
        expect(runs).toEqual([[p(0), p(1)], [p(2), p(3)]]);
    });

    it('is direction-agnostic about the tunnel edge key', () => {
        const runs = corridorSurfaceRuns([seg], tunnelOn(p(2), p(1)));
        expect(runs).toEqual([[p(0), p(1)], [p(2), p(3)]]);
    });

    it('returns nothing for a fully tunnelled segment', () => {
        const short = [p(0), p(1)];
        expect(corridorSurfaceRuns([short], tunnelOn(p(0), p(1)))).toEqual([]);
    });

    it('drops runs shorter than one edge (tunnels on both sides of a vertex)', () => {
        const records = [...tunnelOn(p(0), p(1)), ...tunnelOn(p(1), p(2))];
        expect(corridorSurfaceRuns([seg], records)).toEqual([[p(2), p(3)]]);
    });

    it('accepts a single flat polyline as well as a segment list', () => {
        const runs = corridorSurfaceRuns(seg, tunnelOn(p(1), p(2)));
        expect(runs).toEqual([[p(0), p(1)], [p(2), p(3)]]);
    });

    it('handles multiple segments independently', () => {
        const other = [p(10), p(11)];
        const runs = corridorSurfaceRuns([seg, other], tunnelOn(p(1), p(2)));
        expect(runs).toEqual([[p(0), p(1)], [p(2), p(3)], [p(10), p(11)]]);
    });
});
