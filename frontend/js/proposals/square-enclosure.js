// Sample a square's authored outer edges in ground metres. The same measurement produces
// the per-side numbers and the segments painted on the map.
(function (root, factory) {
    'use strict';
    const api = factory(root.LocalFrame || (typeof require === 'function' ? require('../local-frame.js') : null));
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (typeof window !== 'undefined') window.SquareEnclosure = api;
})(typeof window !== 'undefined' ? window : globalThis, function (frame) {
    'use strict';
    const MAX_REACH_M = 25;
    const STEP_M = 2;
    const EPSILON_M = 0.01;
    const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
    const subtract = (a, b) => [a[0] - b[0], a[1] - b[1]];
    const interpolate = (a, delta, t) => [a[0] + delta[0] * t, a[1] + delta[1] * t];
    const overlaps = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

    function polygonsOf(shape) {
        const geometry = shape?.type === 'Feature' ? shape.geometry : shape;
        if (geometry?.type === 'Polygon') return [geometry.coordinates];
        if (geometry?.type === 'MultiPolygon') return geometry.coordinates;
        return [];
    }

    function edges(ring) {
        return ring.map((a, i) => {
            const b = ring[(i + 1) % ring.length], delta = subtract(b, a);
            return { a, delta, length: Math.hypot(...delta), box: bounds([a, b]) };
        }).filter(edge => edge.length > EPSILON_M);
    }

    function bounds(points) {
        return points.reduce(([west, south, east, north], [x, y]) =>
            [Math.min(west, x), Math.min(south, y), Math.max(east, x), Math.max(north, y)],
        [Infinity, Infinity, -Infinity, -Infinity]);
    }

    function projectRing(ring, project) {
        const points = [];
        for (const point of ring) {
            const next = project(...point);
            if (!points.length || Math.hypot(...subtract(next, points.at(-1))) > EPSILON_M) points.push(next);
        }
        if (points.length > 1 && Math.hypot(...subtract(points[0], points.at(-1))) <= EPSILON_M) points.pop();
        // A subdivided straight edge remains one side. Preserve actual corners, including chamfers.
        return points.filter((point, i) => {
            const before = points[(i + points.length - 1) % points.length];
            const after = points[(i + 1) % points.length];
            const span = subtract(after, before);
            const along = subtract(point, before);
            return Math.hypot(...span) <= EPSILON_M
                || Math.abs(cross(along, span)) / Math.hypot(...span) > EPSILON_M
                || along[0] * (span[0] - along[0]) + along[1] * (span[1] - along[1]) <= 0;
        });
    }

    function hitDistance(point, direction, segments, limit = Infinity, minimum = EPSILON_M) {
        let nearest = Infinity;
        for (const segment of segments) {
            const denominator = cross(direction, segment.delta);
            if (Math.abs(denominator) < 1e-9) continue;
            const offset = subtract(segment.a, point);
            const distance = cross(offset, segment.delta) / denominator;
            const fraction = cross(offset, direction) / denominator;
            if (distance >= minimum && distance <= limit && fraction >= -1e-9 && fraction <= 1 + 1e-9) {
                nearest = Math.min(nearest, Math.max(0, distance));
            }
        }
        return nearest;
    }

    function median(values) {
        if (!values.length) return null;
        values.sort((a, b) => a - b);
        const i = Math.floor(values.length / 2);
        return values.length % 2 ? values[i] : (values[i - 1] + values[i]) / 2;
    }

    function searchArea(square) {
        const points = polygonsOf(square).flatMap(polygon => polygon[0]);
        if (!points.length) return null;
        const [west, south, east, north] = bounds(points);
        const local = frame.makeLocalFrame((west + east) / 2, (south + north) / 2);
        const dx = MAX_REACH_M / local.metersPerDegLng, dy = MAX_REACH_M / local.metersPerDegLat;
        return { type: 'Polygon', coordinates: [[[west - dx, south - dy], [east + dx, south - dy],
            [east + dx, north + dy], [west - dx, north + dy], [west - dx, south - dy]]] };
    }

    function measure(square, buildings) {
        const search = searchArea(square);
        if (!search) return { sides: [], wallM: 0, perimeterM: 0, nearby: [] };
        const searchBox = bounds(search.coordinates[0]);
        const local = frame.makeLocalFrame((searchBox[0] + searchBox[2]) / 2, (searchBox[1] + searchBox[3]) / 2);
        const toDegrees = point => local.toDegrees(...point);
        const nearby = buildings.filter(building => {
            const polygons = polygonsOf(building.geometry);
            return polygons.length && overlaps(searchBox, bounds(polygons.flatMap(polygon => polygon[0])));
        });
        const stock = nearby.map(building => ({
            heightM: building.heightM,
            segments: polygonsOf(building.geometry).flatMap(polygon =>
                polygon.flatMap(ring => edges(projectRing(ring, local.toMeters))))
        }));
        const polygons = polygonsOf(square).map(polygon => polygon.map(ring => projectRing(ring, local.toMeters)));
        const boundary = polygons.flatMap(polygon => edges(polygon[0]));

        const sides = polygons.flatMap(polygon => {
            const outer = edges(polygon[0]);
            const winding = Math.sign(outer.reduce((area, edge) => area + cross(edge.a, edge.delta), 0));
            if (!winding) return [];
            const across = outer.concat(polygon.slice(1).flatMap(edges));
            return outer.map(({ a, delta, length, box }) => {
                const inward = [-delta[1] * winding / length, delta[0] * winding / length];
                const outward = inward.map(value => -value);
                const edgeBox = [box[0] - MAX_REACH_M, box[1] - MAX_REACH_M, box[2] + MAX_REACH_M, box[3] + MAX_REACH_M];
                const candidates = stock.map(({ heightM, segments }) =>
                    ({ heightM, segments: segments.filter(segment => overlaps(edgeBox, segment.box)) })).filter(item => item.segments.length);
                const samples = Math.ceil((length - EPSILON_M) / STEP_M);
                const stretches = [], ratios = [], widths = [];
                let wallSamples = 0, longestGapM = 0;
                for (let i = 0; i < samples; i++) {
                    const point = interpolate(a, delta, (i + 0.5) / samples);
                    const width = hitDistance(point, inward, across);
                    const limit = Math.min(MAX_REACH_M, hitDistance(point, outward, boundary) - EPSILON_M);
                    let distance = Infinity, heightM = null;
                    for (const building of candidates) {
                        const hit = hitDistance(point, outward, building.segments, Math.min(distance, limit), -EPSILON_M);
                        if (hit < distance) { distance = hit; heightM = building.heightM; }
                    }
                    const wall = Number.isFinite(distance);
                    if (Number.isFinite(width)) widths.push(width);
                    if (wall) {
                        wallSamples++;
                        if (heightM > 0 && Number.isFinite(width)) ratios.push(heightM / (width + distance));
                    }
                    const previous = stretches.at(-1);
                    if (previous?.wall === wall) previous.end = i + 1;
                    else stretches.push({ wall, start: i, end: i + 1 });
                }
                const segments = stretches.map(({ wall, start, end }) => {
                    if (!wall) longestGapM = Math.max(longestGapM, (end - start) * length / samples);
                    return { wall, coordinates: [start, end].map(i => toDegrees(interpolate(a, delta, i / samples))) };
                });
                return { lengthM: length, wallM: wallSamples * length / samples, longestGapM, widthM: median(widths),
                    heightToWidth: median(ratios), heightCoverage: wallSamples ? ratios.length / wallSamples : null, segments };
            });
        });
        return { sides, nearby, wallM: sides.reduce((sum, side) => sum + side.wallM, 0),
            perimeterM: sides.reduce((sum, side) => sum + side.lengthM, 0) };
    }

    function score({ wallM, perimeterM }, complete) {
        if (!(perimeterM > 0)) return null;
        const share = 100 * wallM / perimeterM;
        const value = complete ? Math.round(share) : Math.floor(share);
        return {
            value, verdict: !complete ? 'minimum' : value >= 75 ? 'enclosed' : value >= 50 ? 'partialEnclosure' : 'open'
        };
    }

    return { measure, searchArea, score };
});
