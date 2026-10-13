// Verifies OSM signal nodes map to source-way lane approaches without endpoint or proximity guesses.
import { describe, expect, it } from 'vitest';
import { mapTrafficSignals } from '../scripts/lib/traffic-snapshot.mjs';

const METRES_PER_DEGREE = 111320;
const point = (x, y = 0) => [x / METRES_PER_DEGREE, y / METRES_PER_DEGREE];

function signal(x, tags = {}, overrides = {}) {
    return {
        id: 'osm-node:signal', point: point(x),
        tags: { highway: 'traffic_signals', ...tags }, wayIds: ['way-a'], ...overrides
    };
}

function section(id, sourceWayId, xs) {
    return { id, sourceWayId, coordinates: xs.map(x => point(x)) };
}

function lane(id, options = {}) {
    const {
        sourceWayId = 'way-a', direction = 'forward', sectionId = 'segment-a',
        fromNode = 'start', toNode = 'end', xs = [0, 4, 10]
    } = options;
    return {
        id, sourceWayId, direction, sectionId, fromNode, toNode,
        geometry: { coordinates: xs.map(x => point(x)) }
    };
}

describe('mapTrafficSignals', () => {
    it('keeps the OSM source point and maps a mid-section forward signal to forward lanes only', () => {
        const source = signal(4, { 'traffic_signals:direction': 'forward' });
        const mapped = mapTrafficSignals([source], [section('segment-a', 'way-a', [0, 4, 10])], [
            lane('forward'), lane('backward', { direction: 'backward', xs: [10, 4, 0] })
        ]);

        expect(mapped).toEqual([{
            id: source.id, point: source.point, direction: 'forward', kind: 'traffic_signals',
            sourceWayIds: ['way-a'],
            controls: [expect.objectContaining({ laneId: 'forward' })]
        }]);
        expect(mapped[0].controls[0].fraction).toBeGreaterThan(0);
        expect(mapped[0].controls[0].fraction).toBeLessThan(1);
    });

    it('uses traffic_signals:direction and the legacy direction tag to select a single travel direction', () => {
        const source = signal(4, { 'traffic_signals:direction': 'backward', direction: 'forward' });
        const mapped = mapTrafficSignals([source], [section('segment-a', 'way-a', [0, 4, 10])], [
            lane('forward'), lane('backward', { direction: 'backward', xs: [10, 4, 0] })
        ]);
        expect(mapped[0].direction).toBe('backward');
        expect(mapped[0].controls.map(control => control.laneId)).toEqual(['backward']);

        const legacy = mapTrafficSignals(
            [signal(4, { direction: 'backward' })],
            [section('segment-a', 'way-a', [0, 4, 10])],
            [lane('forward'), lane('backward', { direction: 'backward', xs: [10, 4, 0] })]
        );
        expect(legacy[0].direction).toBe('backward');
        expect(legacy[0].controls.map(control => control.laneId)).toEqual(['backward']);
    });

    it('defaults to both directions when OSM has no direction tag', () => {
        const mapped = mapTrafficSignals(
            [signal(4)], [section('segment-a', 'way-a', [0, 4, 10])],
            [lane('forward'), lane('backward', { direction: 'backward', xs: [10, 4, 0] })]
        );
        expect(mapped[0].direction).toBe('both');
        expect(mapped[0].controls.map(control => control.laneId)).toEqual(['forward', 'backward']);
    });

    it('requires matching way and exact section vertex membership instead of nearby or remote geometry', () => {
        const mapped = mapTrafficSignals(
            [signal(4)],
            [
                section('signal-section', 'way-a', [0, 4, 10]),
                section('nearby-other-way', 'way-b', [0, 3.9, 10]),
                section('remote-same-way', 'way-a', [20, 30, 40])
            ],
            [
                lane('correct', { sectionId: 'signal-section' }),
                lane('nearby-unrelated-way', { sourceWayId: 'way-b', sectionId: 'nearby-other-way' }),
                lane('remote-section', { sectionId: 'remote-same-way', xs: [20, 30, 40] })
            ]
        );
        expect(mapped[0].controls.map(control => control.laneId)).toEqual(['correct']);
    });

    it('maps a junction-centre signal to incoming lanes and leaves outgoing lanes uncontrolled', () => {
        const source = signal(10, {}, { wayIds: ['incoming-way', 'outgoing-way'] });
        const mapped = mapTrafficSignals(
            [source],
            [section('incoming-section', 'incoming-way', [0, 10]), section('outgoing-section', 'outgoing-way', [10, 20])],
            [
                { ...lane('incoming', { sourceWayId: 'incoming-way', sectionId: 'incoming-section', toNode: source.id }),
                    geometry: { coordinates: [point(0, -2), point(10, 1)] } },
                lane('outgoing', { sourceWayId: 'outgoing-way', sectionId: 'outgoing-section', fromNode: source.id, xs: [10, 20] })
            ]
        );
        expect(mapped[0].controls.map(control => control.laneId)).toEqual(['incoming']);
        expect(mapped[0].controls[0].fraction).toBe(1);
    });

    it('does not invent signals when the OSM signal list is empty', () => {
        expect(mapTrafficSignals([], [section('segment-a', 'way-a', [0, 4, 10])], [lane('forward')])).toEqual([]);
    });
});
