// Removes degenerate and coincident faces/triangles before city-model meshes reach Three.js.
// The Zagreb LOD2 source contains some surfaces twice with opposite winding, which otherwise z-fight.

(function (global) {
    'use strict';

    const DEFAULT_EPSILON_M = 0.01;
    const DEFAULT_MIN_AREA_M2 = 0.0001;

    function distanceSquared(a, b) {
        const dx = a[0] - b[0];
        const dy = a[1] - b[1];
        const dz = a[2] - b[2];
        return (dx * dx) + (dy * dy) + (dz * dz);
    }

    function cleanRing(ring, epsilonM = DEFAULT_EPSILON_M) {
        if (!Array.isArray(ring)) return [];
        const epsilonSquared = epsilonM * epsilonM;
        const cleaned = [];
        ring.forEach(point => {
            if (!Array.isArray(point) || point.length < 3) return;
            const normalized = [Number(point[0]), Number(point[1]), Number(point[2])];
            if (!normalized.every(Number.isFinite)) return;
            const previous = cleaned[cleaned.length - 1];
            if (!previous || distanceSquared(previous, normalized) > epsilonSquared) cleaned.push(normalized);
        });
        while (cleaned.length > 1 && distanceSquared(cleaned[0], cleaned[cleaned.length - 1]) <= epsilonSquared) {
            cleaned.pop();
        }
        return cleaned;
    }

    function polygonArea3D(ring) {
        if (!Array.isArray(ring) || ring.length < 3) return 0;
        let nx = 0;
        let ny = 0;
        let nz = 0;
        for (let i = 0; i < ring.length; i++) {
            const a = ring[i];
            const b = ring[(i + 1) % ring.length];
            nx += (a[1] - b[1]) * (a[2] + b[2]);
            ny += (a[2] - b[2]) * (a[0] + b[0]);
            nz += (a[0] - b[0]) * (a[1] + b[1]);
        }
        return Math.hypot(nx, ny, nz) / 2;
    }

    function quantizedPointKey(point, epsilonM) {
        return point.map(value => Math.round(value / epsilonM)).join(',');
    }

    function canonicalRingKey(ring, epsilonM = DEFAULT_EPSILON_M) {
        return ring.map(point => quantizedPointKey(point, epsilonM)).sort().join('|');
    }

    function prepareFaceRings(rings, options = {}) {
        const epsilonM = Number(options.epsilonM) > 0 ? Number(options.epsilonM) : DEFAULT_EPSILON_M;
        const minAreaM2 = Number(options.minAreaM2) > 0 ? Number(options.minAreaM2) : DEFAULT_MIN_AREA_M2;
        if (!Array.isArray(rings) || !rings.length) return null;

        const outer = cleanRing(rings[0], epsilonM);
        if (outer.length < 3 || polygonArea3D(outer) < minAreaM2) return null;
        const holes = rings.slice(1)
            .map(ring => cleanRing(ring, epsilonM))
            .filter(ring => ring.length >= 3 && polygonArea3D(ring) >= minAreaM2);

        const holeKeys = holes.map(ring => canonicalRingKey(ring, epsilonM)).sort();
        const key = `o:${canonicalRingKey(outer, epsilonM)};h:${holeKeys.join(';')}`;
        const seenFaceKeys = options.seenFaceKeys;
        if (seenFaceKeys && seenFaceKeys.has(key)) return null;
        if (seenFaceKeys) seenFaceKeys.add(key);
        return { rings: [outer, ...holes], key };
    }

    function appendUniqueTriangle(positions, triangle, options = {}) {
        if (!Array.isArray(positions) || !Array.isArray(triangle) || triangle.length !== 3) return false;
        const epsilonM = Number(options.epsilonM) > 0 ? Number(options.epsilonM) : DEFAULT_EPSILON_M;
        const minAreaM2 = Number(options.minAreaM2) > 0 ? Number(options.minAreaM2) : DEFAULT_MIN_AREA_M2;
        const points = triangle.map(point => Array.isArray(point) ? point.map(Number) : []);
        if (points.some(point => point.length < 3 || !point.slice(0, 3).every(Number.isFinite))) return false;
        if (polygonArea3D(points) < minAreaM2) return false;

        const key = points.map(point => quantizedPointKey(point, epsilonM)).sort().join('|');
        const seenTriangleKeys = options.seenTriangleKeys;
        if (seenTriangleKeys && seenTriangleKeys.has(key)) return false;
        if (seenTriangleKeys) seenTriangleKeys.add(key);
        points.forEach(point => positions.push(point[0], point[1], point[2]));
        return true;
    }

    const api = {
        DEFAULT_EPSILON_M,
        DEFAULT_MIN_AREA_M2,
        cleanRing,
        polygonArea3D,
        canonicalRingKey,
        prepareFaceRings,
        appendUniqueTriangle
    };

    if (global) global.__threeMeshSanitize = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
