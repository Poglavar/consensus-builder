// Pavement triangles must leave the same lake/station openings as cadastral ground, including islands.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import * as turf from '@turf/turf';
import earcut from 'earcut';
const require = createRequire(import.meta.url);
const { buildPavementGeometry } = require('../../frontend/js/life/ground-geometry.js');
const polygon = coordinates => turf.polygon(coordinates);
const square = (a,b,c,d) => [[a,b],[c,b],[c,d],[a,d],[a,b]];
const deps = { difference: turf.difference, triangulate: (outer, holes) => {
    const rings = [outer, ...holes], vertices = rings.flat().flat(), starts = [];
    let count = outer.length;
    for (const hole of holes) { starts.push(count); count += hole.length; }
    const indices = earcut(vertices, starts, 2);
    return Array.from({ length: indices.length / 3 }, (_, i) => indices.slice(i * 3, i * 3 + 3));
} };
function triangles(part) {
    return Array.from({ length: part?.triangles || 0 }, (_, i) => {
        const points = Array.from(part.indices.slice(i * 3, i * 3 + 3), n => [part.positions[n * 3], part.positions[n * 3 + 1]]);
        return polygon([[...points, points[0]]]);
    });
}
const covers = (part, xy) => triangles(part).some(triangle => turf.booleanPointInPolygon(turf.point(xy), triangle));

describe('pavement openings', () => {
    it('leaves recessed lake water visible while retaining surrounding pavement', () => {
        const part = buildPavementGeometry([0,0,100,100], [polygon([square(20,20,80,80)])], deps);
        expect(covers(part, [50,50])).toBe(false);
        expect(covers(part, [10,50])).toBe(true);
        expect(covers(part, [90,50])).toBe(true);
        triangles(part).forEach(triangle => expect(turf.intersect(triangle, polygon([square(20.01,20.01,79.99,79.99)]))).toBeNull());
    });
    it('keeps islands and cuts multiple openings crossing the scene boundary', () => {
        const part = buildPavementGeometry([0,0,100,100], [polygon([square(20,20,80,80), square(40,40,60,60)]), polygon([square(-10,5,10,15)])], deps);
        expect(covers(part, [30,30])).toBe(false);
        expect(covers(part, [50,50])).toBe(true);
        expect(covers(part, [5,10])).toBe(false);
        expect(covers(part, [90,90])).toBe(true);
    });
    it('removes the plane when an opening consumes it and restores it after removal', () => {
        expect(buildPavementGeometry([0,0,100,100], [polygon([square(-1,-1,101,101)])], deps)).toBeNull();
        expect(covers(buildPavementGeometry([0,0,100,100], [], deps), [50,50])).toBe(true);
    });
});
