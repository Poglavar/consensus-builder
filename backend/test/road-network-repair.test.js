import { describe, expect, it } from 'vitest';
import {
    auditRoadNetwork,
    repairRoadNetwork
} from '../scripts/lib/road-network-repair.mjs';

const BASE_LAT = 43.75;
const BASE_LNG = 15.87;
const latMeters = metres => BASE_LAT + metres / 111195;
const lngMeters = metres => BASE_LNG + metres / (111195 * Math.cos(BASE_LAT * Math.PI / 180));
const P = (north, east) => ({ lat: latMeters(north), lng: lngMeters(east) });

function entry(proposalId, segments) {
    return {
        proposalId,
        title: proposalId,
        segments,
        segmentIds: segments.map((_, index) => `${proposalId}-${index + 1}`),
        segmentProfiles: {}
    };
}

describe('road-network data repair', () => {
    it('collapses a sub-metre junction cluster without globally merging ordinary vertices', () => {
        const a = P(0, 0);
        const b1 = P(0, 100);
        const b2 = P(0.15, 100.1);
        const b3 = P(-0.1, 100.2);
        const c = P(100, 100);
        const d = P(100, 0);
        const roads = [entry('network', [
            [a, b1], [b1, b2], [b2, b3], [b3, b1],
            [b2, c], [c, d], [d, a]
        ])];

        const result = repairRoadNetwork(roads, { microEdgeMeters: 1, snapToleranceMeters: 1 });

        expect(result.collapsedJunctions).toHaveLength(1);
        expect(result.removedSegments).toHaveLength(0);
        expect(result.audit.microEdges).toHaveLength(0);
        expect(result.audit.dangling).toHaveLength(0);
        expect(result.audit.components).toHaveLength(1);
        expect(roads[0].segments).toHaveLength(4);
        // The other 100 m-apart corners remain where authored.
        expect(roads[0].segments.flat().some(point => Math.abs(point.lat - c.lat) < 1e-12)).toBe(true);
        expect(roads[0].segments.flat().some(point => Math.abs(point.lat - d.lat) < 1e-12)).toBe(true);
    });

    it('joins a dangling endpoint within one metre to an existing edge and retains the segment', () => {
        const a = P(0, 0);
        const b = P(0, 100);
        const c = P(100, 100);
        const d = P(100, 0);
        const nearTopEdge = P(99.5, 50);
        const roads = [
            entry('loop', [[a, b], [b, c], [c, d], [d, a]]),
            entry('connector', [[a, nearTopEdge]])
        ];

        const result = repairRoadNetwork(roads, { microEdgeMeters: 1, snapToleranceMeters: 1 });

        expect(result.snaps).toHaveLength(1);
        expect(result.snaps[0].distanceMeters).toBeLessThan(1);
        expect(roads[1].segments).toHaveLength(1);
        expect(result.audit.dangling).toHaveLength(0);
        expect(result.audit.components).toHaveLength(1);
    });

    it('removes unsupported dead-end stretches while preserving the closed network', () => {
        const a = P(0, 0);
        const b = P(0, 100);
        const c = P(100, 100);
        const d = P(100, 0);
        const roads = [
            entry('loop', [[a, b], [b, c], [c, d], [d, a]]),
            entry('dead-stub', [[a, P(-40, 0)]]),
            entry('isolated', [[P(500, 500), P(550, 500)]])
        ];

        const result = repairRoadNetwork(roads, { microEdgeMeters: 1, snapToleranceMeters: 1 });

        expect(new Set(result.removedSegments.map(item => item.proposalId)))
            .toEqual(new Set(['dead-stub', 'isolated']));
        expect(roads.find(item => item.proposalId === 'dead-stub').segments).toHaveLength(0);
        expect(roads.find(item => item.proposalId === 'isolated').segments).toHaveLength(0);
        expect(auditRoadNetwork(roads).dangling).toHaveLength(0);
        expect(auditRoadNetwork(roads).components).toHaveLength(1);
    });
});
