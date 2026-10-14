// Exercises derived signal controllers without depending on browser or map rendering.
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const Traffic = require('../../frontend/traffic/simulation.js');
const { createNetwork, sample, signalAspect } = Traffic;

const ORIGIN = [15.98, 45.81];
const METRES_PER_DEGREE = 111320;
const xScale = METRES_PER_DEGREE * Math.cos(ORIGIN[1] * Math.PI / 180);
const geo = ([x, y]) => [ORIGIN[0] + x / xScale, ORIGIN[1] + y / METRES_PER_DEGREE];

function lane(id, fromNode, toNode, start, end, options = {}) {
    return {
        id, sectionId: options.sectionId || `section-${id}`, sourceWayId: options.sourceWayId || `way-${id}`,
        name: options.name || 'Test Street', fromNode, toNode, direction: options.direction || 'forward',
        type: 'driving', access: 'yes', highway: options.highway || 'primary', width: options.width || 3.5,
        stripIndex: options.stripIndex ?? 0, ordinal: options.ordinal ?? 0, turn: null, change: 'yes',
        points: [geo(start), geo(end)]
    };
}

function connection(id, fromLaneId, toLaneId, nodeId, point) {
    return { id, fromLaneId, toLaneId, nodeId, points: [geo(point), geo(point)] };
}

function data(lanes, connections = [], signals = [], degrees = {}) {
    const ids = new Set(lanes.flatMap(item => [item.fromNode, item.toNode]));
    return {
        bbox: [ORIGIN[0] - .01, ORIGIN[1] - .01, ORIGIN[0] + .01, ORIGIN[1] + .01],
        nodes: [...ids].map(id => ({ id, degree: degrees[id] ?? (id === 'junction' ? 4 : 1) })),
        lanes, connections, signals
    };
}

function crossroad(signals = []) {
    const lanes = [
        lane('east-in', 'west', 'junction', [-100, 0], [0, 0], { sectionId: 'east-west', name: 'East Road' }),
        lane('west-in', 'east', 'junction', [100, 0], [0, 0], { sectionId: 'east-west-westbound', name: 'West Road', direction: 'backward' }),
        lane('north-in', 'south', 'junction', [0, -100], [0, 0], { sectionId: 'south-north', name: 'North Road' }),
        lane('south-in', 'north', 'junction', [0, 100], [0, 0], { sectionId: 'north-south', name: 'South Road', direction: 'backward' }),
        lane('east-out', 'junction', 'east-outer', [0, 0], [100, 0], { sectionId: 'east-out' }),
        lane('west-out', 'junction', 'west-outer', [0, 0], [-100, 0], { sectionId: 'west-out', direction: 'backward' }),
        lane('north-out', 'junction', 'north-outer', [0, 0], [0, 100], { sectionId: 'north-out' }),
        lane('south-out', 'junction', 'south-outer', [0, 0], [0, -100], { sectionId: 'south-out', direction: 'backward' })
    ];
    const connections = [
        connection('east-move', 'east-in', 'east-out', 'junction', [0, 0]),
        connection('west-move', 'west-in', 'west-out', 'junction', [0, 0]),
        connection('north-move', 'north-in', 'north-out', 'junction', [0, 0]),
        connection('south-move', 'south-in', 'south-out', 'junction', [0, 0])
    ];
    return createNetwork(data(lanes, connections, signals, { junction: 4 }));
}

function aspectTime(signal, phase, wanted) {
    for (let time = 0; time < signal.phases.length * 29; time += .1) {
        if (signalAspect(signal, phase, time) === wanted) return time;
    }
    throw new Error(`No ${wanted} interval for ${phase}`);
}

describe('derived traffic signal plan', () => {
    const records = [
        { id: 'osm-node:east', point: geo([0, 0]), kind: 'traffic_signals', controls: [{ laneId: 'east-in', fraction: 1 }] },
        { id: 'osm-node:west', point: geo([0, 0]), kind: 'traffic_signals', controls: [{ laneId: 'west-in', fraction: 1 }] },
        { id: 'osm-node:north', point: geo([0, 0]), kind: 'traffic_signals', controls: [{ laneId: 'north-in', fraction: 1 }] },
        { id: 'osm-node:south', point: geo([0, 0]), kind: 'traffic_signals', controls: [{ laneId: 'south-in', fraction: 1 }] }
    ];

    it('gives opposite approaches the same phase and perpendicular approaches different phases', () => {
        const network = crossroad(records);
        const byLane = Object.fromEntries(['east-in', 'west-in', 'north-in', 'south-in'].map(id => {
            const control = network.lanes.get(id).signals[0];
            return [id, { control, head: network.signals.get(control.signalId) }];
        }));

        expect(byLane['east-in'].control.phase).toBe(byLane['west-in'].control.phase);
        expect(byLane['north-in'].control.phase).toBe(byLane['south-in'].control.phase);
        expect(byLane['east-in'].control.phase).not.toBe(byLane['north-in'].control.phase);
        const greenAt = aspectTime(byLane['east-in'].head, byLane['east-in'].control.phase, 'green');
        expect(signalAspect(byLane['west-in'].head, byLane['west-in'].control.phase, greenAt)).toBe('green');
        expect(signalAspect(byLane['north-in'].head, byLane['north-in'].control.phase, greenAt)).toBe('red');
    });

    it('provides an all-red interval between opposing phase axes', () => {
        const network = crossroad(records);
        const east = network.lanes.get('east-in').signals[0];
        const north = network.lanes.get('north-in').signals[0];
        const head = network.signals.get(east.signalId);
        const phaseEnd = aspectTime(head, east.phase, 'amber');

        expect(signalAspect(head, east.phase, phaseEnd + 2.9)).toBe('amber');
        expect(signalAspect(head, east.phase, phaseEnd + 3.1)).toBe('red');
        expect(signalAspect(network.signals.get(north.signalId), north.phase, phaseEnd + 3.1)).toBe('red');
        expect(signalAspect(network.signals.get(north.signalId), north.phase, phaseEnd + 5.1)).toBe('green');
    });

    it('creates no heads or lane controls without tagged signal-source records', () => {
        const network = crossroad([]);

        expect(network.data.signals).toEqual([]);
        expect(network.signals.size).toBe(0);
        expect([...network.lanes.values()].every(item => item.signals.length === 0)).toBe(true);
    });

    it('groups lights within one metre into one standalone stop per lane and keeps both source IDs', () => {
        const approach = lane('approach', 'west', 'east', [-100, 0], [100, 0], { sourceWayId: 'way-main', name: 'Main Road' });
        const sourceSignals = [
            { id: 'osm-node:101', point: geo([0, 0]), kind: 'traffic_signals', controls: [{ laneId: 'approach', fraction: .5 }] },
            { id: 'osm-node:102', point: geo([.8, 0]), kind: 'signalised_crossing', controls: [{ laneId: 'approach', fraction: .504 }] }
        ];
        const network = createNetwork(data([approach], [], sourceSignals));
        const laneSignals = network.lanes.get('approach').signals;

        expect(network.signals.size).toBe(1);
        expect(laneSignals).toHaveLength(1);
        const head = network.signals.get(laneSignals[0].signalId);
        expect(head.sourceIds).toEqual(['osm-node:101', 'osm-node:102']);
        expect(network.controllers.size).toBe(1);
        expect(network.data.signals).toEqual(sourceSignals);
    });

    it('places a stop line upstream of the source point and a curb-side head with source provenance', () => {
        const network = crossroad([records[0]]);
        const approach = network.lanes.get('east-in'), control = approach.signals[0];
        const head = network.signals.get(control.signalId);
        const stop = sample(approach.path, control.stopS);
        const headPoint = network.project(head.point);
        const sourcePoint = network.project(records[0].point);
        const dx = headPoint[0] - stop.x, dy = headPoint[1] - stop.y;
        const right = [Math.sin(stop.angle), -Math.cos(stop.angle)];
        const along = [Math.cos(stop.angle), Math.sin(stop.angle)];

        expect(control.stopS).toBeCloseTo(approach.path.length - 2.5, 5);
        expect(Math.hypot(stop.x - sourcePoint[0], stop.y - sourcePoint[1])).toBeCloseTo(2.5, 1);
        expect(dx * right[0] + dy * right[1]).toBeCloseTo(2.55, 1);
        expect(dx * along[0] + dy * along[1]).toBeCloseTo(0, 1);
        expect(head.sourceIds).toEqual(['osm-node:east']);
        expect(head.sourcePoints).toEqual([records[0].point]);
        expect(head.point).not.toEqual(records[0].point);
        expect(head.name).toBe('East Road');
        expect(head.direction).toBe('E');
    });

    it('does not add a second stop to lanes internal to a grouped junction', () => {
        const lanes = [
            lane('approach', 'west', 'j-west', [-100, 0], [-10, 0], { sectionId: 'west-road' }),
            lane('internal', 'j-west', 'j-east', [-10, 0], [10, 0], { sectionId: 'junction-internal', highway: 'service' }),
            lane('exit', 'j-east', 'east', [10, 0], [100, 0], { sectionId: 'east-road' })
        ];
        const connections = [connection('enter', 'approach', 'internal', 'j-west', [-10, 0]),
            connection('leave', 'internal', 'exit', 'j-east', [10, 0])];
        const signal = { id: 'osm-node:j-west', point: geo([-10, 0]), kind: 'traffic_signals',
            controls: [{ laneId: 'approach', fraction: 1 }] };
        const network = createNetwork(data(lanes, connections, [signal], { 'j-west': 3, 'j-east': 3 }));

        expect(network.controllers.size).toBe(1);
        expect(network.lanes.get('approach').signals).toHaveLength(1);
        expect(network.lanes.get('internal').signals).toEqual([]);
    });
});
