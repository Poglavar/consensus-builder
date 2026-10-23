// CPU-only glTF bounding-box validation and conversion to building dimensions in metres.
(function (global) {
    'use strict';

    const MAX_FOOTPRINT_TRIANGLES = 250000;

    function footprintError(code) {
        const error = new Error(code);
        error.code = code;
        return error;
    }

    function dimensionsFromBounds({ min, max }) {
        if (![min.x, min.y, min.z, max.x, max.y, max.z].every(Number.isFinite)) return null;
        const sizes = [max.x - min.x, max.z - min.z, max.y - min.y];
        if (sizes.some(size => !Number.isFinite(size) || size < 0)) return null;
        const [width, length, height] = sizes.map(size => Math.max(1, +size.toFixed(1)));
        return { width, length, height };
    }

    // Convert projected triangle soup into one actual outline. Coordinates are metres east/north;
    // quantization gives stable deduplication across triangle order and winding.
    function projectedFootprint(triangles, union) {
        if (!(triangles instanceof Float64Array) || triangles.length % 6 !== 0
            || typeof union !== 'function') throw footprintError('empty');
        const count = triangles.length / 6;
        if (count > MAX_FOOTPRINT_TRIANGLES) throw footprintError('complex');
        const unique = new Map();
        for (let offset = 0; offset < triangles.length; offset += 6) {
            const vertices = [];
            for (let index = 0; index < 6; index += 2) {
                const x = triangles[offset + index];
                const y = triangles[offset + index + 1];
                if (!Number.isFinite(x) || !Number.isFinite(y)) throw footprintError('empty');
                vertices.push([Math.round(x * 1e6) / 1e6, Math.round(y * 1e6) / 1e6]);
            }
            const [a, b, c] = vertices;
            const area2 = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
            if (!Number.isFinite(area2)) throw footprintError('empty');
            if (area2 === 0) continue;
            const vertexKeys = vertices.map(([x, y]) => `${Math.round(x * 1e6)},${Math.round(y * 1e6)}`).sort();
            const key = vertexKeys.join(';');
            if (!unique.has(key)) unique.set(key, {
                type: 'Feature', properties: {},
                geometry: { type: 'Polygon', coordinates: [[a, b, c, a]] }
            });
        }
        let level = [...unique.values()];
        if (!level.length) throw footprintError('empty');
        while (level.length > 1) {
            const next = [];
            for (let index = 0; index < level.length; index += 2) {
                if (index + 1 === level.length) {
                    next.push(level[index]);
                    continue;
                }
                let merged;
                try { merged = union(level[index], level[index + 1]); }
                catch (_) { throw footprintError('outline'); }
                if (!merged?.geometry) throw footprintError('outline');
                next.push(merged);
            }
            level = next;
        }
        let geometry = level[0].geometry;
        if (geometry.type === 'MultiPolygon') {
            if (!Array.isArray(geometry.coordinates) || !geometry.coordinates.length) throw footprintError('empty');
            if (geometry.coordinates.length > 1) throw footprintError('disconnected');
            geometry = { type: 'Polygon', coordinates: geometry.coordinates[0] };
        }
        if (geometry.type !== 'Polygon' || !Array.isArray(geometry.coordinates) || !geometry.coordinates.length
            || geometry.coordinates.some(ring => !Array.isArray(ring) || ring.length < 4
                || ring.some(point => !Array.isArray(point) || !Number.isFinite(point[0]) || !Number.isFinite(point[1]))
                || ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1])) {
            throw footprintError('empty');
        }
        return { type: 'Feature', properties: {}, geometry };
    }

    const api = { dimensionsFromBounds, projectedFootprint, MAX_FOOTPRINT_TRIANGLES };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (global) global.BuildingModelGeometry = api;
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : globalThis));
