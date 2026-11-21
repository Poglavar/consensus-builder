import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const Hare = require('../../frontend/js/proposals/hare-cycling.js');
const frame = require('../../frontend/js/metric-frame.js').frameFor([[15, 45]]);
const point = (x, y) => frame.toLngLat([x, y]);
const square = (x, y) => ({ type: 'Polygon', coordinates: [
    [[x, y], [x + 4, y], [x + 4, y + 4], [x, y + 4], [x, y]].map(([a, b]) => point(a, b))
] });
const member = (cid, content) => ({ cid, content: { title: cid, ...content } });
const building = (id, x, y) => member(id, {
    geometry: { buildings: [{ type: 'Feature', geometry: square(x, y), properties: { use: 'residential', floors: 4 } }] }
});
const place = (id, x, y, kind = 'park') => member(id, { structureProposal: { kind, geometry: square(x, y) } });
function corridor(id, points, tags) {
    const nodes = points.map(([x, y, nodeTags], index) => {
        const [lon, lat] = point(x, y);
        return { type: 'node', id: index + 1, lat, lon, tags: nodeTags };
    });
    return member(id, { roadProposal: { definition: { kind: 'road', osm: { elements: [
        ...nodes, { type: 'way', id: -1, nodes: nodes.map(node => node.id), tags }
    ] } } } });
}
const evaluate = (...members) => Hare.evaluate({ designCids: members.map(row => row.cid) }, members);
const street = { highway: 'residential' };
const bikeway = { highway: 'cycleway' };

describe('Hare cycling', () => {
    it('weights each directional length and separates ungraded shared streets from scored metres', () => {
        const result = evaluate(
            corridor('Protected', [[0, 0], [100, 0]], { ...street, cycleway: 'track' }),
            corridor('Painted', [[100, 0], [300, 0]], { ...street, cycleway: 'lane' }),
            corridor('Slow', [[300, 0], [600, 0]], { ...street, maxspeed: '30' }),
            corridor('Fast', [[600, 0], [1000, 0]], { ...street, maxspeed: '20 mph' }),
            corridor('Unknown', [[1000, 0], [1100, 0]], street)
        );
        expect(result.lengths.protected).toBeCloseTo(200, 1);
        expect(result.lengths.painted).toBeCloseTo(400, 1);
        expect(result.lengths.slow).toBeCloseTo(600, 1);
        expect(result.lengths.fast).toBeCloseTo(800, 1);
        expect(result.lengths.unknown).toBeCloseTo(200, 1);
        expect(result.score).toBe(42);
        expect(evaluate(corridor('Unknown', [[0, 0], [100, 0]], street)).score).toBeNull();
    });

    it('recognizes a verge between a lane and traffic and grades opposing directions separately', () => {
        const result = evaluate(corridor('One protected side', [[0, 0], [100, 0]], { ...street, maxspeed: '40',
            'cb:lanes': 'cycleway:2:backward|verge:1|driving:3:backward|driving:3:forward|cycleway:2:forward' }));
        expect(result.segments[0].tiers).toEqual(['painted', 'protected']);
        expect(result.score).toBe(85);
    });

    it('honours one way and explicit contraflow, and separates reachability from lane quality', () => {
        const home = building('Home', 75, 8), park = place('Park', 15, 8);
        const single = evaluate(home, park, corridor('Street', [[0, 0], [100, 0]], { ...street, oneway: 'yes', maxspeed: '30' }));
        expect(single.score).toBe(40);
        expect(single.categories.green).toEqual({ destinations: 1, reachableDestinations: 0, reachableHomes: 0 });
        const two = evaluate(home, park, corridor('Street', [[0, 0], [100, 0]], { ...street, oneway: 'yes', 'oneway:bicycle': 'no', maxspeed: '30' }));
        expect(two.categories.green).toEqual({ destinations: 1, reachableDestinations: 1, reachableHomes: 1 });
        expect(two.selectTrip('building:Home:0', 'green', 'Park').coordinates.length).toBeGreaterThan(2);
    });

    it('needs a cycling crossing between protected paths on opposite sides of a through road', () => {
        const home = building('Home', -8, 65), park = place('Park', 6, -65);
        const north = corridor('North track', [[0, 100], [0, 0]], bikeway);
        const south = corridor('South track', [[0, 0], [0, -100]], bikeway);
        const unmarked = evaluate(home, park, north, south, corridor('Road', [[-100, 0], [0, 0], [100, 0]], street));
        expect(unmarked.categories.green.reachableHomes).toBe(0);
        expect(unmarked.gaps.some(gap => gap.kind === 'crossing-gap')).toBe(true);
        const marked = evaluate(home, park, north, south, corridor('Road', [[-100, 0], [0, 0, { highway: 'crossing', bicycle: 'yes' }], [100, 0]], street));
        expect(marked.categories.green.reachableHomes).toBe(1);
        const bridge = evaluate(home, park, north, south, corridor('Bridge', [[-100, 0], [0, 0], [100, 0]], { ...street, layer: '1' }));
        expect(bridge.categories.green.reachableHomes).toBe(1);
    });

    it('reports nearby unconnected ends and keeps bicycle-prohibited links out of routes', () => {
        const home = building('Home', 5, 8), stop = place('Station', 85, 8, 'station');
        const start = corridor('Start', [[0, 0], [45, 0]], bikeway);
        const end = corridor('End', [[55, 0], [100, 0]], bikeway);
        const broken = evaluate(home, stop, start, end);
        expect(broken.gaps.some(gap => gap.kind === 'unlinked-end')).toBe(true);
        expect(broken.categories.transit.reachableHomes).toBe(0);
        const closed = evaluate(home, stop, start, end, corridor('Closed', [[45, 0], [55, 0]], { ...street, bicycle: 'no' }));
        expect(closed.lengths.prohibited).toBeCloseTo(20, 1);
        expect(closed.categories.transit.reachableHomes).toBe(0);
    });
});
