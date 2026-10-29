// Street width in front of a lot: from its front edge, across the public space, to the first other
// lot line, measured by rays cast outward from the edge. Pure geometry in a local metre frame.
// The width feeds the street-wall rule (a facade may rise to a multiple of the distance across the
// street); a lot whose rays reach nothing within the search distance has no measurable width.
const R = 6371008.8, RAD = Math.PI / 180;
const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
const boxesTouch = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

function outerRings(geometry) {
    if (geometry?.type === 'Polygon') return [geometry.coordinates[0]];
    if (geometry?.type === 'MultiPolygon') return geometry.coordinates.map(polygon => polygon[0]);
    return [];
}

// `parcel` is a GeoJSON polygon feature with an `id`; `frontEdge` indexes its ring's edges the way
// the evaluator does (edge i runs from vertex i to vertex i + 1); `obstacles` are `{ id, geometry,
// bbox }` of the lots that may lie across the street, the lot itself included or not.
export function streetWidthAcross(parcel, frontEdge, obstacles, { maxDistanceM = 40, rays = [0.25, 0.5, 0.75] } = {}) {
    const ring = parcel?.geometry?.type === 'Polygon' ? parcel.geometry.coordinates[0] : null;
    const count = ring ? ring.length - 1 : 0;
    if (!ring || count < 3 || !Number.isInteger(frontEdge) || frontEdge < 0 || frontEdge >= count) return { widthM: null, hits: [], reason: 'invalid-front-edge' };
    const a = ring[frontEdge], b = ring[(frontEdge + 1) % count], cos = Math.cos(a[1] * RAD);
    const project = p => [(p[0] - a[0]) * RAD * R * cos, (p[1] - a[1]) * RAD * R];
    const points = ring.slice(0, -1).map(project);
    const signed = points.reduce((sum, p, i) => { const q = points[(i + 1) % count]; return sum + cross(p, q); }, 0);
    const [bx, by] = project(b), length = Math.hypot(bx, by);
    if (!(length > 0.01) || Math.abs(signed) < 2) return { widthM: null, hits: [], reason: 'degenerate-front-edge' };
    // Outward is to the right of a counter-clockwise ring's edge and to the left of a clockwise one's.
    const normal = signed > 0 ? [by / length, -bx / length] : [-by / length, bx / length];
    const dLat = maxDistanceM / 111320, dLng = dLat / cos;
    const search = [Math.min(a[0], b[0]) - dLng, Math.min(a[1], b[1]) - dLat, Math.max(a[0], b[0]) + dLng, Math.max(a[1], b[1]) + dLat];
    const segments = [];
    for (const obstacle of obstacles) {
        if (obstacle.id === parcel.id || !obstacle.bbox || !boxesTouch(obstacle.bbox, search)) continue;
        for (const outer of outerRings(obstacle.geometry)) {
            const local = outer.map(project);
            for (let i = 0; i < local.length - 1; i++) segments.push([local[i], local[i + 1]]);
        }
    }
    const hits = [];
    for (const t of rays) {
        // The ray starts a hand's width outside the lot so its own edge never counts as a hit.
        const origin = [bx * t + normal[0] * 0.05, by * t + normal[1] * 0.05];
        let nearest = null;
        for (const [p, q] of segments) {
            const e = [q[0] - p[0], q[1] - p[1]], w = [p[0] - origin[0], p[1] - origin[1]], denominator = cross(normal, e);
            if (Math.abs(denominator) < 1e-9) continue;
            const s = cross(w, e) / denominator, u = cross(w, normal) / denominator;
            if (s >= 0 && u >= 0 && u <= 1 && s <= maxDistanceM && (nearest === null || s < nearest)) nearest = s;
        }
        if (nearest !== null) hits.push(Math.round(nearest * 100) / 100);
    }
    if (!hits.length) return { widthM: null, hits, reason: 'no-lot-across', maxDistanceM };
    const sorted = [...hits].sort((x, y) => x - y);
    return { widthM: sorted[Math.floor((sorted.length - 1) / 2)], hits, maxDistanceM };
}
