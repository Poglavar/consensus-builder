import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const Dog = require('../../frontend/js/proposals/dog-walkability.js');
const Metric = require('../../frontend/js/metric-frame.js');
const frame = Metric.frameFor([[15, 45]]);
const point = (x, y) => frame.toLngLat([x, y]);
const box = (x, y, width = 8) => ({ type: 'Polygon', coordinates: [
    [[x, y], [x + width, y], [x + width, y + width], [x, y + width], [x, y]].map(([a, b]) => point(a, b))
] });
const member = (cid, content) => ({ cid, content: { title: cid, ...content } });
const building = (id, x, y, use = 'residential') => member(id, {
    geometry: { buildings: [{ type: 'Feature', geometry: box(x, y), properties: { use, floors: 4 } }] }
});
const place = (id, x, y, kind = 'park') => member(id, { structureProposal: { kind, geometry: box(x, y) } });
const corridor = (id, points, tags) => {
    const nodes = points.map(([x, y, nodeTags], index) => {
        const [lon, lat] = point(x, y);
        return { type: 'node', id: index + 1, lat, lon, tags: nodeTags };
    });
    return member(id, { roadProposal: { definition: { kind: 'road', osm: { elements: [
        ...nodes, { type: 'way', id: -1, nodes: nodes.map(node => node.id), tags }
    ] } } } });
};
const evaluate = (...members) => Dog.evaluate({ designCids: members.map(row => row.cid) }, members);
const sidewalk = { highway: 'residential', sidewalk: 'both' };
const footpath = { highway: 'footway' };

describe('Dog walking coverage', () => {
    it('connects both sides only at a recorded crossing and includes a crossing delay', () => {
        const home = building('Home', -25, 8), park = place('Park', 25, -15);
        const blocked = evaluate(home, park, corridor('Street', [[-100, 0], [0, 0], [100, 0]], sidewalk));
        expect(blocked.score).toBe(0);
        expect(blocked.categories.green).toMatchObject({ destinations: 1, within5: 0, noRoute: 1 });
        const connected = evaluate(home, park, corridor('Street', [[-100, 0], [0, 0, { highway: 'crossing' }], [100, 0]], sidewalk));
        expect(connected.score).toBe(100);
        const route = connected.homes[0];
        expect(route.routes.green.seconds).toBeGreaterThan(50);
        expect(connected.route(route.id, 'green').length).toBeGreaterThan(4);
        expect(connected.categories.transit).toMatchObject({ destinations: 0, noRoute: null });
    });

    it('uses a walking detour, counts time bands, and leaves a different level disconnected', () => {
        const home = building('Home', 0, -7), shop = building('Shops', 92, 4, 'residential-shops');
        const walk = corridor('Footpath', [[0, 0], [0, 200], [100, 200], [100, 0]], footpath);
        const elevated = corridor('Bridge', [[0, 0], [100, 0]], { ...footpath, layer: '1' });
        const transit = place('Stop', 70, 214, 'station');
        const result = evaluate(home, shop, transit, walk, elevated);
        expect(result.homes[0].routes.shops.seconds).toBeGreaterThan(400);
        expect(result.categories.shops).toMatchObject({ within5: 1, within10: 2 });
        expect(result.categories.transit).toMatchObject({ destinations: 1, within5: 2 });
    });

    it('reports missing sidewalks separately from missing destinations and omits an unavailable score', () => {
        const home = building('Home', 10, 7);
        const street = corridor('Street', [[0, 0], [100, 0]], { highway: 'residential', sidewalk: 'no' });
        const result = evaluate(home, street);
        expect(result).toMatchObject({ pathCount: 0, connectedHomes: 0, score: null });
        expect(result.gaps.map(gap => gap.kind)).toEqual(['no-sidewalk']);
        expect(result.categories.green.noRoute).toBeNull();
    });

    it('does not invent a route through a building to an enclosed garden', () => {
        const home = building('Home', -15, -15), park = place('Garden', 6, 20);
        const barrier = member('Wall', { geometry: { buildings: [{ type: 'Feature', geometry: box(-6, 3, 20), properties: { use: 'public' } }] } });
        const path = corridor('Path', [[-30, 0], [30, 0]], footpath);
        expect(evaluate(home, park, path).categories.green.within5).toBe(1);
        expect(evaluate(home, park, path, barrier).categories.green).toMatchObject({ connectedDestinations: 0, noRoute: 1 });
    });
});
