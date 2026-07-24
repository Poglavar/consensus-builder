// Pure crossing detection and stable edge-addressing tests for pedestrian under/overpasses.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const originals = new Map();

function install(name, value) {
    originals.set(name, {
        existed: Object.prototype.hasOwnProperty.call(globalThis, name),
        value: globalThis[name]
    });
    globalThis[name] = value;
}

beforeAll(() => {
    const profile = require('../../frontend/js/corridor-profile.js');
    const tunnels = require('../../frontend/js/corridor-tunnel.js');
    install('normalizeCorridorProfile', profile.normalizeCorridorProfile);
    install('corridorProfileOf', profile.corridorProfileOf);
    install('corridorSegmentEntries', profile.corridorSegmentEntries);
    install('corridorCenterlineOf', profile.corridorCenterlineOf);
    install('corridorTunnelEdgeKey', tunnels.corridorTunnelEdgeKey);
    install('isApplied', () => true);
});

afterAll(() => {
    for (const [name, original] of originals) {
        if (original.existed) globalThis[name] = original.value;
        else delete globalThis[name];
    }
});

const grade = require('../../frontend/js/corridor-grade-separation.js');

const pedestrian = { strips: [{ type: 'sidewalk', width: 2 }] };
const driving = { strips: [{ type: 'sidewalk', width: 2 }, { type: 'driving', width: 6 }, { type: 'sidewalk', width: 2 }] };
const west = { lat: 45.8, lng: 15.899 };
const east = { lat: 45.8, lng: 15.901 };

function crossingRoad(profile = driving) {
    return {
        proposalId: 'road-north-south',
        title: 'Main road',
        applied: true,
        roadProposal: {
            definition: {
                points: [[{ lat: 45.799, lng: 15.9 }, { lat: 45.801, lng: 15.9 }]],
                segmentIds: ['main'],
                profile,
                width: 10
            }
        }
    };
}

describe('pedestrian road crossing detection', () => {
    it('offers grade separation only for a sidewalk-only route crossing a non-pedestrian road', () => {
        const hits = grade.detectPedestrianRoadCrossings(west, east, pedestrian, [crossingRoad()]);

        expect(hits).toHaveLength(1);
        expect(hits[0]).toMatchObject({
            proposalId: 'road-north-south',
            title: 'Main road',
            width: 10
        });
        expect(hits[0].point.lat).toBeCloseTo(45.8, 7);
        expect(hits[0].point.lng).toBeCloseTo(15.9, 7);
        expect(hits[0].t).toBeCloseTo(0.5, 5);
    });

    it('ignores vehicle routes and crossings with another pedestrian-only route', () => {
        expect(grade.detectPedestrianRoadCrossings(west, east, driving, [crossingRoad()])).toEqual([]);
        expect(grade.detectPedestrianRoadCrossings(west, east, pedestrian, [crossingRoad(pedestrian)])).toEqual([]);
    });

    it('resolves the selected underpass action into persistent ramp metadata', async () => {
        const previous = globalThis.showStyledChoice;
        globalThis.showStyledChoice = vi.fn(async () => 'underpass');
        try {
            const resolution = await grade.resolvePedestrianRoadCrossings(
                west, east, pedestrian, 2, [crossingRoad()]
            );

            expect(resolution.action).toBe('underpass');
            expect(resolution.records).toHaveLength(1);
            expect(resolution.records[0]).toMatchObject({
                mode: 'underpass',
                elevation: -3.2,
                width: 2,
                crossedWidth: 10,
                otherProposalId: 'road-north-south'
            });
            expect(resolution.records[0].startT).toBeLessThan(0.5);
            expect(resolution.records[0].endT).toBeGreaterThan(0.5);
        } finally {
            if (previous === undefined) delete globalThis.showStyledChoice;
            else globalThis.showStyledChoice = previous;
        }
    });
});

describe('grade-separated span edge addressing', () => {
    it('protects every ramp edge and drops the record when its geometry moves', () => {
        const hit = grade.detectPedestrianRoadCrossings(west, east, pedestrian, [crossingRoad()])[0];
        const record = grade.buildGradeSeparationRecords([hit], 'overpass', west, east, 2)[0];
        const points = [west, record.from, record.to, east];

        grade.refreshGradeSeparationEdgeKeys(record, points);

        expect(record.edgeKeys).toHaveLength(1);
        expect(grade.gradeSeparationSpanRecords([record])).toEqual([{ edgeKey: record.edgeKeys[0] }]);
        expect(grade.retainLiveGradeSeparations([points], [record])).toEqual([record]);
        expect(grade.retainLiveGradeSeparations([[west, east]], [record])).toEqual([]);
    });
});
