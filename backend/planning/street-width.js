// Street width in front of a lot: from its front edge, across the public space, to the first other
// lot line, measured by rays cast outward from the edge. Pure geometry in a local metre frame.
// The width feeds the street-wall rule (a facade may rise to a multiple of the distance across the
// street); a lot whose rays reach nothing within the search distance has no measurable width.
import { createRequire } from 'node:module';
import * as turf from '@turf/turf';
const { frontageScores } = createRequire(import.meta.url)('../../frontend/js/proposals/site-plots.js');
const R = 6371008.8, RAD = Math.PI / 180;
const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const boxesTouch = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

function streetFrame(parcel, obstacles, reachM) {
    const ring = parcel?.geometry?.type === 'Polygon' && parcel.geometry.coordinates[0];
    if (!ring || ring.length < 4) return null;
    const [lng, lat] = ring[0], cos = Math.cos(lat * RAD);
    const project = ([x, y]) => [(x - lng) * RAD * R * cos, (y - lat) * RAD * R];
    const points = ring.map(project);
    const signed = points.slice(0, -1).reduce((sum, p, i) => sum + cross(p, points[i + 1]), 0);
    if (Math.abs(signed) < 2) return null;
    const edges = points.slice(0, -1).map((a, i) => {
        const vector = [points[i + 1][0] - a[0], points[i + 1][1] - a[1]], lengthM = Math.hypot(...vector);
        const factor = Math.sign(signed) / (lengthM || 1);
        return { a, vector, lengthM, normal: [vector[1] * factor, -vector[0] * factor] };
    });
    const [w, s, e, n] = turf.bbox(parcel), dy = reachM / 111320, dx = dy / cos;
    const search = [w - dx, s - dy, e + dx, n + dy], segments = [];
    for (const obstacle of obstacles) {
        if (obstacle.id === parcel.id || !obstacle.bbox || !boxesTouch(obstacle.bbox, search)) continue;
        const polygons = obstacle.geometry?.type === 'Polygon' ? [obstacle.geometry.coordinates] : obstacle.geometry?.coordinates || [];
        for (const [outerRing] of polygons) {
            const outer = outerRing.map(project);
            for (let i = 1; i < outer.length; i++) segments.push([outer[i - 1], [outer[i][0] - outer[i - 1][0], outer[i][1] - outer[i - 1][1]]]);
        }
    }
    return { edges, segments };
}

function rayWidths(frame, index, rays, maxDistanceM, offset) {
    const edge = frame?.edges[index];
    if (!edge || edge.lengthM <= 0.01) return { widthM: null, hits: [], reason: 'invalid-front-edge' };
    const { a, vector, normal } = edge, hits = [];
    for (const t of rays) {
        const x = a[0] + vector[0] * t + normal[0] * offset, y = a[1] + vector[1] * t + normal[1] * offset;
        let nearest = Infinity;
        for (const [p, segment] of frame.segments) {
            const divisor = cross(normal, segment);
            if (Math.abs(divisor) < 1e-9) continue;
            const delta = [p[0] - x, p[1] - y], ray = cross(delta, segment) / divisor, along = cross(delta, normal) / divisor;
            if (ray >= -1e-7 && along >= 0 && along <= 1 && ray <= maxDistanceM) nearest = Math.min(nearest, Math.max(0, ray));
        }
        if (Number.isFinite(nearest)) hits.push(Math.round(nearest * 100) / 100);
    }
    if (!hits.length) return { widthM: null, hits, reason: 'no-lot-across', maxDistanceM };
    const sorted = [...hits].sort((a, b) => a - b);
    return { widthM: sorted[Math.floor((sorted.length - 1) / 2)], hits, maxDistanceM };
}

export function streetWidthAcross(parcel, frontEdge, obstacles, { maxDistanceM = 40, rays = [0.25, 0.5, 0.75] } = {}) {
    return rayWidths(streetFrame(parcel, obstacles, maxDistanceM), frontEdge, rays, maxDistanceM, 0.05);
}

// Street frontage and the dimensional evaluator share their edge numbering. A missing neighbour
// is only an open side of a block if a mapped street actually faces it.
export function edgeStanding(parcel, obstacles = [], streets, { minGapM = 2, spacingM = 2, maxDistanceM = 40, frontEdge = null } = {}) {
    const frame = streetFrame(parcel, obstacles, maxDistanceM);
    const facing = frontageScores(parcel, streets?.features || [], { turf, maxDistanceM });
    const fronts = new Set(facing.map(edge => edge.index));
    const front = frame?.edges[frontEdge ?? facing[0]?.index];
    const edges = (frame?.edges || []).map((edge, index) => {
        const count = Math.max(3, Math.ceil(edge.lengthM / spacingM));
        const rays = Array.from({ length: count }, (_, i) => (i + 0.5) / count);
        const { hits, widthM } = rayWidths(frame, index, rays, maxDistanceM, 0);
        const alignment = front ? dot(front.normal, edge.normal) : 0;
        return { index, lengthM: edge.lengthM, open: fronts.has(index) && hits.every(distance => distance >= minGapM),
            role: alignment > 0.9 ? 'front' : alignment < -0.5 ? 'rear' : 'side', widthM };
    });
    const open = edges.filter(edge => edge.open && edge.lengthM >= 1);
    const significant = edges.filter(edge => edge.lengthM >= 1);
    const corner = open.some((edge, i) => edge.lengthM >= 3 && open.slice(i + 1).some(other => other.lengthM >= 3
        && Math.abs(dot(frame.edges[edge.index].normal, frame.edges[other.index].normal)) <= Math.SQRT1_2 + 1e-8));
    const roleWidths = Object.fromEntries(['front', 'side', 'rear'].map(role => {
        const walls = open.filter(edge => edge.role === role);
        return [role, walls.length && walls.every(edge => edge.widthM != null) ? Math.max(...walls.map(edge => edge.widthM)) : null];
    }));
    return { wholeBlock: significant.length >= 3 && significant.length === open.length, corner, openEdges: open.map(edge => edge.index),
        edgeWidthsM: edges.map(edge => edge.widthM), roleWidths };
}
