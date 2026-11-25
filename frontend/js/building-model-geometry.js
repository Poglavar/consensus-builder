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

    // Clipper (vendor/clipper-lib-6.4.2) unions on integers: millimetres here.
    const CLIPPER_SCALE = 1000;
    // A part or hole of the outline below 1 m² (or 1 % of the largest part, for a small model) is mesh
    // noise, such as a post beside the building or a gap between two slabs: not a separate building
    // part or a courtyard.
    const NOISE_M2 = 1;
    const NOISE_SHARE = 0.01;
    const clipperLib = () => (global && global.ClipperLib) || require('../vendor/clipper-lib-6.4.2/clipper.js');

    // Convert projected triangle soup into one actual outline. Coordinates are metres east/north. One
    // integer union of every triangle (non-zero fill) cannot fail on the slivers and nearly coincident
    // edges of exported buildings, as a pairwise floating-point union did.
    function projectedFootprint(triangles) {
        if (!(triangles instanceof Float64Array) || triangles.length % 6 !== 0) throw footprintError('empty');
        const count = triangles.length / 6;
        if (count > MAX_FOOTPRINT_TRIANGLES) throw footprintError('complex');
        const ClipperLib = clipperLib();
        // A slab's top and bottom project onto the same triangles: each distinct one is added once.
        const paths = [], seen = new Set();
        for (let offset = 0; offset < triangles.length; offset += 6) {
            const points = [];
            for (let index = 0; index < 6; index += 2) {
                const x = triangles[offset + index];
                const y = triangles[offset + index + 1];
                if (!Number.isFinite(x) || !Number.isFinite(y)) throw footprintError('empty');
                points.push({ X: Math.round(x * CLIPPER_SCALE), Y: Math.round(y * CLIPPER_SCALE) });
            }
            const [a, b, c] = points;
            const area2 = (b.X - a.X) * (c.Y - a.Y) - (b.Y - a.Y) * (c.X - a.X);
            if (area2 === 0) continue;
            const key = points.map(point => `${point.X},${point.Y}`).sort().join(';');
            if (seen.has(key)) continue;
            seen.add(key);
            paths.push(area2 > 0 ? points : [a, c, b]);
        }
        if (!paths.length) throw footprintError('empty');
        const { Clipper, ClipType, PolyType, PolyFillType } = ClipperLib;
        const union = (input, output, strictlySimple) => {
            const clipper = new Clipper();
            clipper.StrictlySimple = strictlySimple;
            clipper.AddPaths(input, PolyType.ptSubject, true);
            if (!clipper.Execute(ClipType.ctUnion, output, PolyFillType.pftNonZero, PolyFillType.pftNonZero)) throw footprintError('outline');
            return output;
        };
        // The union of the triangles, then a strictly simple pass over its few rings, which splits a
        // courtyard touching the outline at a vertex into its own ring (strictly simple over every
        // triangle at once takes minutes on a large building).
        const tree = union(union(paths, new ClipperLib.Paths(), false), new ClipperLib.PolyTree(), true);
        // Outer rings at any depth (an island inside a courtyard is a part too), each with its holes.
        const area = node => Math.abs(Clipper.Area(node.Contour())) / CLIPPER_SCALE / CLIPPER_SCALE;
        const parts = [];
        const collect = outers => outers.forEach(outer => {
            parts.push(outer);
            outer.Childs().forEach(hole => collect(hole.Childs()));
        });
        collect(tree.Childs());
        const largest = Math.max(0, ...parts.map(area));
        const noise = Math.min(NOISE_M2, largest * NOISE_SHARE);
        const kept = parts.filter(part => area(part) >= noise);
        if (!kept.length || !(largest > 0)) throw footprintError('empty');
        if (kept.length > 1) throw footprintError('disconnected');
        // Cleaning drops the collinear vertices and zero-width spikes that T-junctions between
        // triangles leave in the union (within 2 mm).
        const ring = node => {
            const points = Clipper.CleanPolygon(node.Contour(), 2).map(point => [point.X / CLIPPER_SCALE, point.Y / CLIPPER_SCALE]);
            return points.length >= 3 ? [...points, points[0]] : null;
        };
        const outline = ring(kept[0]);
        if (!outline) throw footprintError('empty');
        const holes = kept[0].Childs().filter(hole => area(hole) >= noise).map(ring).filter(Boolean);
        return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [outline, ...holes] } };
    }

    // Visible scene triangles, shared by the upload dialog and CPU model importer.
    function modelTriangles(object, center, THREE) {
        const triangles = [];
        const vertex = new THREE.Vector3();
        const instanceMatrix = new THREE.Matrix4();
        const transform = new THREE.Matrix4();
        object.updateMatrixWorld(true);
        object.traverseVisible(node => {
            const geometry = node.isMesh && node.geometry;
            const position = geometry && geometry.attributes.position;
            if (!position) return;
            const index = geometry.index;
            const count = index ? index.count : position.count;
            const drawStart = geometry.drawRange.start;
            const drawEnd = Math.min(count, drawStart + geometry.drawRange.count);
            const materials = Array.isArray(node.material) ? node.material : [node.material];
            const groups = Array.isArray(node.material) ? geometry.groups : [{ start: 0, count, materialIndex: 0 }];
            for (let instance = 0; instance < (node.isInstancedMesh ? node.count : 1); instance++) {
                transform.copy(node.matrixWorld);
                if (node.isInstancedMesh) {
                    node.getMatrixAt(instance, instanceMatrix);
                    transform.multiply(instanceMatrix);
                }
                for (const group of groups) {
                    if (!materials[group.materialIndex] || materials[group.materialIndex].visible === false) continue;
                    const start = Math.max(drawStart, group.start);
                    const end = Math.min(drawEnd, group.start + group.count);
                    for (let offset = start; offset + 2 < end; offset += 3) {
                        if (triangles.length >= MAX_FOOTPRINT_TRIANGLES * 6) throw Object.assign(new Error('Model triangle limit'), { code: 'complex' });
                        for (let corner = 0; corner < 3; corner++) {
                            const vertexIndex = index ? index.getX(offset + corner) : offset + corner;
                            node.getVertexPosition(vertexIndex, vertex).applyMatrix4(transform);
                            triangles.push(vertex.x - center.x, -(vertex.z - center.z));
                        }
                    }
                }
            }
        });
        return new Float64Array(triangles);
    }

    const api = { modelTriangles, dimensionsFromBounds, projectedFootprint, MAX_FOOTPRINT_TRIANGLES };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (global) global.BuildingModelGeometry = api;
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : globalThis));
