// Corridor clearance: how much room the surroundings leave a corridor, measured perpendicular
// to its centerline. One sampling pass (a station every couple of metres, a ray cast to each side)
// feeds everything built on top: the corridor width profile ("how wide could this road be, here"),
// the pinch point (the narrowest gap and the obstacles that form it), and the fit computation
// ("would the road fit if it were shifted sideways, and by how much"). All functions are pure and
// planar (metres, x east, y north) — projection stays with the caller, like corridor-profile's
// strip geometry — so every one of them is unit-testable without a map.
(function (global) {
    'use strict';

    // Browser: corridor-profile.js loads first and its top-level declarations are globals.
    // Node (vitest): require it — never re-declare, so the two realms share one implementation.
    const samplePolyline = (typeof global.samplePolylinePlanar === 'function')
        ? global.samplePolylinePlanar
        : (typeof require === 'function' ? require('./corridor-profile.js').samplePolylinePlanar : null);

    const CLEARANCE_DEFAULT_STEP = 2; // metres between stations
    const CLEARANCE_DEFAULT_MAX = 100; // metres a side ray reaches before the side counts as open
    const CLEARANCE_EPS = 1e-9;
    // Same limit corridor-profile uses for strip joints: a mitre longer than 4x the offset is a
    // near-reversal, and the vertex falls back to the unscaled edge normal instead.
    const CLEARANCE_MITRE_LIMIT = 4;

    // An obstacle is { id, kind, rings: [ [[x,y],...], ... ] } — every ring contributes boundary
    // segments (holes included: a ray stops at whatever boundary it meets first).
    function clearanceObstacleIndex(obstacles) {
        const indexed = [];
        (obstacles || []).forEach(obstacle => {
            if (!obstacle || !Array.isArray(obstacle.rings)) return;
            const segs = [];
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            obstacle.rings.forEach(ring => {
                if (!Array.isArray(ring) || ring.length < 2) return;
                for (let i = 0; i < ring.length; i += 1) {
                    const a = ring[i];
                    const b = ring[(i + 1) % ring.length];
                    if (!Array.isArray(a) || !Array.isArray(b)) continue;
                    if (!Number.isFinite(a[0]) || !Number.isFinite(a[1])
                        || !Number.isFinite(b[0]) || !Number.isFinite(b[1])) continue;
                    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < CLEARANCE_EPS) continue;
                    segs.push([a, b]);
                    minX = Math.min(minX, a[0], b[0]);
                    minY = Math.min(minY, a[1], b[1]);
                    maxX = Math.max(maxX, a[0], b[0]);
                    maxY = Math.max(maxY, a[1], b[1]);
                }
            });
            if (!segs.length) return;
            indexed.push({ id: obstacle.id, kind: obstacle.kind || null, segs, bbox: [minX, minY, maxX, maxY] });
        });
        return indexed;
    }

    // Perpendicular clearance at stations along a centerline. Returns
    // [{ point, angle, s, left, right }] where left/right are { distance, obstacleId, kind }
    // for the nearest obstacle boundary on that side, or null when nothing lies within
    // maxDistance (an open side). Left is the left of the direction of travel, matching the
    // sign convention of offsetPolylinePlanar and the strip spans.
    //
    // A station whose point sits INSIDE an obstacle still reports the distances to that
    // obstacle's walls — the road overlapping a building is the existing collision machinery's
    // case to flag, not this function's.
    function corridorClearanceSamples(pointsXY, obstacles, options = {}) {
        if (typeof samplePolyline !== 'function') return [];
        const step = Number(options.stationStep) > 0 ? Number(options.stationStep) : CLEARANCE_DEFAULT_STEP;
        const maxDistance = Number(options.maxDistance) > 0 ? Number(options.maxDistance) : CLEARANCE_DEFAULT_MAX;
        const stations = samplePolyline(pointsXY, step);
        if (!stations.length) return [];
        const indexed = clearanceObstacleIndex(obstacles);

        return stations.map(station => {
            const p = station.point;
            const nx = -Math.sin(station.angle);
            const ny = Math.cos(station.angle);
            let left = null;
            let right = null;
            indexed.forEach(obstacle => {
                const [minX, minY, maxX, maxY] = obstacle.bbox;
                if (p[0] < minX - maxDistance || p[0] > maxX + maxDistance
                    || p[1] < minY - maxDistance || p[1] > maxY + maxDistance) return;
                obstacle.segs.forEach(([a, b]) => {
                    const dx = b[0] - a[0];
                    const dy = b[1] - a[1];
                    // Solve p + t*(nx,ny) = a + u*(dx,dy): t is the signed distance along the
                    // perpendicular (positive left), u the position along the boundary segment.
                    const det = dx * ny - dy * nx;
                    if (Math.abs(det) < 1e-12) return; // boundary parallel to the ray
                    const apx = a[0] - p[0];
                    const apy = a[1] - p[1];
                    const t = (dx * apy - dy * apx) / det;
                    const u = (nx * apy - ny * apx) / det;
                    if (u < -CLEARANCE_EPS || u > 1 + CLEARANCE_EPS) return;
                    if (Math.abs(t) > maxDistance) return;
                    if (t > CLEARANCE_EPS) {
                        if (!left || t < left.distance) left = { distance: t, obstacleId: obstacle.id, kind: obstacle.kind };
                    } else if (t < -CLEARANCE_EPS) {
                        if (!right || -t < right.distance) right = { distance: -t, obstacleId: obstacle.id, kind: obstacle.kind };
                    }
                });
            });
            return { point: p, angle: station.angle, s: station.distance, left, right };
        });
    }

    // Aggregate a sampling pass into the numbers the stats view shows. `roadWidth` is the
    // cross-section total the corridor is compared against. An open side counts as maxDistance
    // of room and marks the station `unbounded` — its width is a floor ("at least this much"),
    // not a measurement, and the aggregates carry that flag alongside the number.
    function corridorClearanceStats(samples, roadWidth, options = {}) {
        if (!Array.isArray(samples) || !samples.length) return null;
        const maxDistance = Number(options.maxDistance) > 0 ? Number(options.maxDistance) : CLEARANCE_DEFAULT_MAX;
        const width = Number(roadWidth) || 0;

        const widths = samples.map((sample, index) => {
            const L = sample.left ? sample.left.distance : maxDistance;
            const R = sample.right ? sample.right.distance : maxDistance;
            return { index, s: sample.s, width: L + R, unbounded: !sample.left || !sample.right };
        });

        let minEntry = widths[0];
        let maxEntry = widths[0];
        let sum = 0;
        let minLeft = Infinity;
        let minRight = Infinity;
        widths.forEach(entry => {
            if (entry.width < minEntry.width) minEntry = entry;
            if (entry.width > maxEntry.width) maxEntry = entry;
            sum += entry.width;
        });
        samples.forEach(sample => {
            minLeft = Math.min(minLeft, sample.left ? sample.left.distance : maxDistance);
            minRight = Math.min(minRight, sample.right ? sample.right.distance : maxDistance);
        });

        const pinchSample = samples[minEntry.index];
        return {
            widths,
            minWidth: minEntry.width,
            minWidthUnbounded: minEntry.unbounded,
            maxWidth: maxEntry.width,
            maxWidthUnbounded: maxEntry.unbounded,
            avgWidth: sum / widths.length,
            minLeft,
            minRight,
            // The road fits in place when every station leaves half the road on each side.
            fitsAsIs: minLeft >= width / 2 - CLEARANCE_EPS && minRight >= width / 2 - CLEARANCE_EPS,
            pinch: {
                index: minEntry.index,
                sample: pinchSample,
                width: minEntry.width,
                unbounded: minEntry.unbounded,
                leftObstacle: pinchSample.left || null,
                rightObstacle: pinchSample.right || null
            }
        };
    }

    // The rigid lateral shift that makes a road of `roadWidth` fit. Each station constrains the
    // shift d (positive = left of travel) to  need - R  <=  d  <=  L - need  where need is the
    // half-width plus a safety margin; the intersection over all stations is the feasible
    // interval. `shift` is the smallest move inside it (0 when the road already fits), or null
    // when the interval is empty — then not even moving helps and the honest answer is the
    // corridor's min width.
    function corridorFitShift(samples, roadWidth, options = {}) {
        if (!Array.isArray(samples) || !samples.length) return null;
        const maxDistance = Number(options.maxDistance) > 0 ? Number(options.maxDistance) : CLEARANCE_DEFAULT_MAX;
        const margin = Number.isFinite(options.margin) ? Number(options.margin) : 0.05;
        const need = (Number(roadWidth) || 0) / 2 + margin;

        let dMin = -Infinity;
        let dMax = Infinity;
        samples.forEach(sample => {
            const L = sample.left ? sample.left.distance : maxDistance;
            const R = sample.right ? sample.right.distance : maxDistance;
            dMax = Math.min(dMax, L - need);
            dMin = Math.max(dMin, need - R);
        });
        const feasible = dMin <= dMax + CLEARANCE_EPS;
        const shift = !feasible ? null : (dMin > 0 ? dMin : (dMax < 0 ? dMax : 0));
        return { dMin, dMax, feasible, shift };
    }

    // Per-vertex offsets for a shift that respects held endpoints: full `shift` in the interior,
    // easing (smoothstep) to zero over `taperMeters` toward each held end — the shape of a real
    // road realignment, and what keeps a shifted segment welded to the junctions it meets.
    function corridorShiftOffsets(pointsXY, shift, options = {}) {
        if (!Array.isArray(pointsXY) || pointsXY.length < 2) return null;
        const taper = Number(options.taperMeters) > 0 ? Number(options.taperMeters) : 15;
        const ease = t => (t <= 0 ? 0 : (t >= 1 ? 1 : t * t * (3 - 2 * t)));

        const arclength = [0];
        for (let i = 1; i < pointsXY.length; i += 1) {
            arclength.push(arclength[i - 1] + Math.hypot(
                pointsXY[i][0] - pointsXY[i - 1][0],
                pointsXY[i][1] - pointsXY[i - 1][1]
            ));
        }
        const total = arclength[arclength.length - 1];
        return pointsXY.map((point, i) => {
            let factor = 1;
            if (options.holdStart) factor *= ease(arclength[i] / taper);
            if (options.holdEnd) factor *= ease((total - arclength[i]) / taper);
            return shift * factor;
        });
    }

    // Offset a polyline by a PER-VERTEX distance (positive left of travel), moving each vertex
    // along its mitre direction. Unlike offsetPolylinePlanar this keeps the vertex count and
    // order — vertex i of the result corresponds to vertex i of the input — which is what lets
    // a shift be baked back into a stored centerline without disturbing anything keyed to it.
    function offsetPolylineVariable(pointsXY, offsets) {
        if (!Array.isArray(pointsXY) || pointsXY.length < 2) return null;
        if (!Array.isArray(offsets) || offsets.length !== pointsXY.length) return null;

        // Edge normals, reusing the previous normal across zero-length edges.
        const normals = [];
        let lastNormal = null;
        for (let i = 0; i < pointsXY.length - 1; i += 1) {
            const dx = pointsXY[i + 1][0] - pointsXY[i][0];
            const dy = pointsXY[i + 1][1] - pointsXY[i][1];
            const length = Math.hypot(dx, dy);
            if (length >= CLEARANCE_EPS) lastNormal = [-dy / length, dx / length];
            normals.push(lastNormal);
        }
        if (!normals.some(Boolean)) return null;
        // A leading zero-length edge has no normal yet; backfill from the first real one.
        const firstNormal = normals.find(Boolean);
        for (let i = 0; i < normals.length; i += 1) {
            if (!normals[i]) normals[i] = firstNormal;
        }

        return pointsXY.map((point, i) => {
            const prev = normals[Math.max(0, i - 1)];
            const next = normals[Math.min(normals.length - 1, i)];
            const mx = prev[0] + next[0];
            const my = prev[1] + next[1];
            const mitreLength = Math.hypot(mx, my);
            let dir = prev;
            let scale = 1;
            if (mitreLength >= CLEARANCE_EPS) {
                dir = [mx / mitreLength, my / mitreLength];
                const cosHalf = dir[0] * prev[0] + dir[1] * prev[1];
                scale = 1 / Math.max(cosHalf, 1 / CLEARANCE_MITRE_LIMIT);
            }
            return [point[0] + dir[0] * offsets[i] * scale, point[1] + dir[1] * offsets[i] * scale];
        });
    }

    // Insert interpolated vertices so no edge is longer than maxSpacing. A tapered shift bends
    // the polyline BETWEEN vertices; a long straight edge has none to bend at, so it is given some.
    function densifyPolylineXY(pointsXY, maxSpacing) {
        if (!Array.isArray(pointsXY) || pointsXY.length < 2) return null;
        const spacing = Number(maxSpacing) > 0 ? Number(maxSpacing) : 5;
        const result = [pointsXY[0]];
        for (let i = 1; i < pointsXY.length; i += 1) {
            const a = pointsXY[i - 1];
            const b = pointsXY[i];
            const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
            const pieces = Math.ceil(length / spacing);
            for (let k = 1; k < pieces; k += 1) {
                const t = k / pieces;
                result.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
            }
            result.push(b);
        }
        return result;
    }

    function pointToSegmentDistance(p, a, b) {
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const len2 = dx * dx + dy * dy;
        if (len2 < CLEARANCE_EPS) return Math.hypot(p[0] - a[0], p[1] - a[1]);
        const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
        return Math.hypot(p[0] - (a[0] + dx * t), p[1] - (a[1] + dy * t));
    }

    // Which endpoints of a segment are welded to something else — another segment of the same
    // network, or another road's centerline. A held endpoint must not move when the segment is
    // shifted, so the shift tapers to zero toward it.
    function corridorHeldEndpoints(pointsXY, otherPolylines, tolerance = 0.75) {
        if (!Array.isArray(pointsXY) || pointsXY.length < 2) return { start: false, end: false };
        const near = endpoint => (otherPolylines || []).some(poly => {
            if (!Array.isArray(poly) || poly.length < 2) return false;
            for (let i = 0; i < poly.length - 1; i += 1) {
                if (pointToSegmentDistance(endpoint, poly[i], poly[i + 1]) <= tolerance) return true;
            }
            return false;
        });
        return { start: near(pointsXY[0]), end: near(pointsXY[pointsXY.length - 1]) };
    }

    // The available-corridor band as one ring: each side's boundary at its measured clearance,
    // capped at `cap` metres so an open side reads as generous rather than absurd. Display
    // geometry — a sharp bend can fold it, and Leaflet's even-odd fill renders that fine
    // (the same stance corridorStripRingPlanar takes).
    function corridorClearanceHalo(samples, cap) {
        if (!Array.isArray(samples) || samples.length < 2) return null;
        const limit = Number(cap) > 0 ? Number(cap) : 30;
        const leftSide = [];
        const rightSide = [];
        samples.forEach(sample => {
            const nx = -Math.sin(sample.angle);
            const ny = Math.cos(sample.angle);
            const L = Math.min(sample.left ? sample.left.distance : limit, limit);
            const R = Math.min(sample.right ? sample.right.distance : limit, limit);
            leftSide.push([sample.point[0] + nx * L, sample.point[1] + ny * L]);
            rightSide.push([sample.point[0] - nx * R, sample.point[1] - ny * R]);
        });
        return [...leftSide, ...rightSide.reverse()];
    }

    // An 8-way compass label key for a planar direction (x east, y north) — how "left of travel"
    // is said to someone who does not know which way the road was drawn.
    function corridorCompass8(direction) {
        if (!Array.isArray(direction) || (!direction[0] && !direction[1])) return null;
        const bearing = (Math.atan2(direction[0], direction[1]) * 180 / Math.PI + 360) % 360;
        const keys = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];
        return keys[Math.round(bearing / 45) % 8];
    }

    const api = {
        corridorClearanceSamples,
        corridorClearanceStats,
        corridorFitShift,
        corridorShiftOffsets,
        offsetPolylineVariable,
        densifyPolylineXY,
        corridorHeldEndpoints,
        corridorClearanceHalo,
        corridorCompass8,
        CLEARANCE_DEFAULT_STEP,
        CLEARANCE_DEFAULT_MAX
    };

    Object.assign(global, api);

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
})(typeof window !== 'undefined' ? window : globalThis);
