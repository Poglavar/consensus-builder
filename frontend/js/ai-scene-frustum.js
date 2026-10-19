// Which proposals were inside the camera when an AI-scene shot was taken.
//
// Sharing an AI render used to bake in EVERY applied proposal; the link then re-applied the whole
// plan, not the handful the picture actually shows. This narrows the set to what was in frame: build
// the six frustum planes from the capture camera's view-projection matrix (Gribb–Hartmann extraction,
// matching THREE.Frustum.setFromProjectionMatrix) and keep a proposal if any point of its footprint
// falls inside.
//
// Pure math on purpose — no THREE, no DOM — so it is unit-testable headlessly. The caller injects the
// matrix (camera.projectionMatrix × camera.matrixWorldInverse, as a length-16 column-major array), a
// lat/lng → scene-XY projector, and each proposal's lat/lng footprint. The footprint is tested on the
// ground plane (z ≈ 0, where all our content sits); an aerial/oblique shot that frames a proposal
// always frames its ground footprint, so height-aware testing buys nothing here.
(function (global) {
    'use strict';

    // Footprints are sparse (a straight road is a 4-corner polygon), so a proposal crossing the middle
    // of the frame can have every raw vertex outside the frustum. Densify each edge to this spacing —
    // scene XY is mercator-scaled metres, so this is ~metres — before testing.
    const DEFAULT_DENSIFY_M = 12;
    // Count a footprint grazing the frame edge as in-view rather than flickering out on rounding.
    const DEFAULT_MARGIN_M = 2;

    function finite(v) { return typeof v === 'number' && Number.isFinite(v); }

    // Six inward-facing planes [a,b,c,d] (a·x+b·y+c·z+d ≥ 0 inside) from a column-major view-projection
    // matrix. Layout: elements[col*4 + row], so the w-row is [e3,e7,e11,e15] and row0 is [e0,e4,e8,e12].
    // Plane = wRow ∓ axisRow, exactly as THREE derives left/right/bottom/top/near/far.
    function frustumPlanes(elements) {
        if (!elements || elements.length < 16) return null;
        const e = elements;
        const w = [e[3], e[7], e[11], e[15]];
        const x = [e[0], e[4], e[8], e[12]];
        const y = [e[1], e[5], e[9], e[13]];
        const z = [e[2], e[6], e[10], e[14]];
        const combine = (row, sign) => normalizePlane([
            w[0] + sign * row[0], w[1] + sign * row[1], w[2] + sign * row[2], w[3] + sign * row[3]
        ]);
        const planes = [
            combine(x, +1), // left
            combine(x, -1), // right
            combine(y, +1), // bottom
            combine(y, -1), // top
            combine(z, +1), // near
            combine(z, -1)  // far
        ];
        return planes.every(Boolean) ? planes : null;
    }

    function normalizePlane(p) {
        const n = Math.hypot(p[0], p[1], p[2]);
        if (!finite(n) || n === 0) return null;
        return [p[0] / n, p[1] / n, p[2] / n, p[3] / n];
    }

    function pointInsidePlanes(planes, px, py, pz, marginM) {
        const margin = finite(marginM) ? marginM : 0;
        for (let i = 0; i < planes.length; i++) {
            const p = planes[i];
            if (p[0] * px + p[1] * py + p[2] * pz + p[3] < -margin) return false;
        }
        return true;
    }

    // Every ring of a GeoJSON geometry as arrays of [lng, lat]. Polygon/MultiPolygon are the norm;
    // LineString/MultiLineString are tolerated so a bare road centreline still culls.
    function geometryRings(geometry) {
        if (!geometry || !geometry.coordinates) return [];
        const c = geometry.coordinates;
        switch (geometry.type) {
            case 'Polygon': return c.filter(Array.isArray);
            case 'MultiPolygon': return c.filter(Array.isArray).flat().filter(Array.isArray);
            case 'LineString': return [c];
            case 'MultiLineString': return c.filter(Array.isArray);
            default: return [];
        }
    }

    function densifyEdgeXY(a, b, maxSpacingM, out) {
        out.push(a);
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const len = Math.hypot(dx, dy);
        if (maxSpacingM > 0 && len > maxSpacingM) {
            const steps = Math.ceil(len / maxSpacingM);
            for (let i = 1; i < steps; i++) {
                const t = i / steps;
                out.push([a[0] + dx * t, a[1] + dy * t]);
            }
        }
    }

    // A ring of [lng,lat] → densified scene-XY points. Skips vertices the projector can't place.
    function ringToDenseXY(ring, project, maxSpacingM) {
        const xy = [];
        for (let i = 0; i < ring.length; i++) {
            const pt = ring[i];
            if (!Array.isArray(pt) || pt.length < 2) continue;
            const projected = project(pt[1], pt[0]); // project(lat, lng)
            if (Array.isArray(projected) && finite(projected[0]) && finite(projected[1])) {
                xy.push([projected[0], projected[1]]);
            }
        }
        if (xy.length < 2) return xy;
        const dense = [];
        for (let i = 0; i < xy.length - 1; i++) densifyEdgeXY(xy[i], xy[i + 1], maxSpacingM, dense);
        dense.push(xy[xy.length - 1]);
        return dense;
    }

    // True if any densified footprint point of `features` lands inside the frustum.
    function featuresInFrustum(features, planes, project, options) {
        const densifyM = finite(options.densifyM) ? options.densifyM : DEFAULT_DENSIFY_M;
        const marginM = finite(options.marginM) ? options.marginM : DEFAULT_MARGIN_M;
        const zLevels = Array.isArray(options.zLevels) && options.zLevels.length ? options.zLevels : [0];
        for (let f = 0; f < features.length; f++) {
            const feature = features[f];
            const geometry = feature && feature.geometry ? feature.geometry : feature;
            const rings = geometryRings(geometry);
            for (let r = 0; r < rings.length; r++) {
                const dense = ringToDenseXY(rings[r], project, densifyM);
                for (let i = 0; i < dense.length; i++) {
                    for (let z = 0; z < zLevels.length; z++) {
                        if (pointInsidePlanes(planes, dense[i][0], dense[i][1], zLevels[z], marginM)) {
                            return true;
                        }
                    }
                }
            }
        }
        return false;
    }

    // proposals: [{ id, features }] where features are lat/lng GeoJSON Features (or geometries).
    // options.elements: length-16 column-major view-projection matrix.
    // options.project: (lat, lng) → [x, y] in scene space.
    // Returns the ids whose footprint is in frame, or null when the frustum can't be built (caller
    // then keeps its full set — narrowing only ever happens on a confident, non-null result).
    function proposalsInView(proposals, options) {
        options = options || {};
        const planes = frustumPlanes(options.elements);
        if (!planes || typeof options.project !== 'function' || !Array.isArray(proposals)) return null;
        const inView = [];
        proposals.forEach(function (proposal) {
            if (!proposal || proposal.id == null) return;
            const features = Array.isArray(proposal.features) ? proposal.features : [];
            if (featuresInFrustum(features, planes, options.project, options)) inView.push(proposal.id);
        });
        return inView;
    }

    const api = {
        frustumPlanes: frustumPlanes,
        pointInsidePlanes: pointInsidePlanes,
        geometryRings: geometryRings,
        ringToDenseXY: ringToDenseXY,
        featuresInFrustum: featuresInFrustum,
        proposalsInView: proposalsInView,
        DEFAULT_DENSIFY_M: DEFAULT_DENSIFY_M,
        DEFAULT_MARGIN_M: DEFAULT_MARGIN_M
    };

    global.__aiSceneFrustum = api;

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
})(typeof window !== 'undefined' ? window : globalThis);
