// Unit tests for building collision detection and stable tunnel-edge metadata.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    corridorTunnelEdgeKey,
    findBuildingTunnelIntersections,
    makeBuildingTunnelRecord,
    addBuildingTunnelRecord,
    removeBuildingTunnelEdge
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
