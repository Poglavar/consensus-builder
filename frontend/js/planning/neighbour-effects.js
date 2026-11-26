// Effects of a design on its neighbouring plots, before and after, against the usual daylight and
// privacy guides: garden sunlight on 21 March (half the garden with 2 hours of sun, or 0.8 times
// before), sky visible from a facing wall (vertical sky component 27 %, or 0.8 times before) and the
// distance to the nearest facing wall (21 m). Pure: footprints in lng/lat, heights in metres above
// flat ground, sun positions passed in (SunCalc's convention); no DOM, no turf. docs/neighbour-effects.md.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.NeighbourEffects = api;
})(typeof window !== 'undefined' ? window : typeof self !== 'undefined' ? self : null, function () {
    'use strict';

    const GUIDE = {
        gardenHours: 2, gardenShare: 0.5, ratio: 0.8,
        skyPercent: 27, facingDistanceM: 21,
        windowHeightM: 1.6, minWallM: 1.5,
        reachFactor: 4, minReachM: 30, maxReachM: 200,
        maxGardenPoints: 200, skyStepDeg: 2, sunStepMin: 10
    };
    const finite = value => typeof value === 'number' && Number.isFinite(value);
    // Less than this change is no change (garden share 0–1, sky in percentage points, metres): a
    // fraction of a point is noise of the sampling, not a loss anyone would notice.
    const SAME = { share: 0.01, sky: 1, distance: 0.5 };
    // A wall this close to another building is a party wall: no window, so no sky or facing distance.
    const PARTY_WALL_M = 0.5;

    // ---- Local metres ----
    function projector(lng0, lat0) {
        const kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110540;
        return {
            point: ([lng, lat]) => [(lng - lng0) * kx, (lat - lat0) * ky],
            lngLat: ([x, y]) => [lng0 + x / kx, lat0 + y / ky]
        };
    }
    // Polygon or MultiPolygon → [{ rings: [[x,y]...][], box }], rings closed.
    function partsOf(geometry, project) {
        const polygons = geometry?.type === 'Polygon' ? [geometry.coordinates] : geometry?.type === 'MultiPolygon' ? geometry.coordinates : [];
        return polygons.map(polygon => {
            const rings = (polygon || []).filter(ring => Array.isArray(ring) && ring.length >= 4).map(ring => ring.map(project));
            return rings.length ? { rings, box: boxOf(rings[0]) } : null;
        }).filter(Boolean);
    }
    function boxOf(points) {
        let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
        for (const [x, y] of points) { if (x < w) w = x; if (x > e) e = x; if (y < s) s = y; if (y > n) n = y; }
        return [w, s, e, n];
    }
    const corners = ([w, s, e, n]) => [[w, s], [e, s], [e, n], [w, n]];
    const joinBoxes = boxes => boxes.reduce((a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]);
    const boxDistance = (box, x, y) => Math.hypot(Math.max(box[0] - x, 0, x - box[2]), Math.max(box[1] - y, 0, y - box[3]));
    const boxesApart = (a, b) => Math.hypot(Math.max(a[0] - b[2], 0, b[0] - a[2]), Math.max(a[1] - b[3], 0, b[1] - a[3]));
    function inRing(ring, x, y) {
        let inside = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const [xi, yi] = ring[i], [xj, yj] = ring[j];
            if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
        }
        return inside;
    }
    const inPart = (part, x, y) => x >= part.box[0] && x <= part.box[2] && y >= part.box[1] && y <= part.box[3]
        && inRing(part.rings[0], x, y) && !part.rings.slice(1).some(hole => inRing(hole, x, y));
    const inParts = (parts, x, y) => parts.some(part => inPart(part, x, y));
    // A point inside the shape: its largest part's centroid when inside, else the first grid hit.
    function pointIn(parts) {
        const part = parts.slice().sort((a, b) => (b.box[2] - b.box[0]) * (b.box[3] - b.box[1]) - (a.box[2] - a.box[0]) * (a.box[3] - a.box[1]))[0];
        if (!part) return null;
        const ring = part.rings[0];
        const c = ring.slice(0, -1).reduce((sum, [x, y]) => [sum[0] + x, sum[1] + y], [0, 0]).map(v => v / (ring.length - 1));
        if (inPart(part, c[0], c[1])) return c;
        const [w, s, e, n] = part.box;
        for (let i = 1; i < 10; i++) for (let j = 1; j < 10; j++) {
            const x = w + (e - w) * i / 10, y = s + (n - s) * j / 10;
            if (inPart(part, x, y)) return [x, y];
        }
        return c;
    }
    function ringArea(ring) {
        let sum = 0;
        for (let i = 0; i < ring.length - 1; i++) sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
        return sum / 2;
    }
    // Distance along the ray (x, y) + t·(dx, dy) to the first wall of the solid, or Infinity.
    // Whether the ray from (x, y) along (dx, dy) passes through a box at all (the slab test).
    function rayMeetsBox(box, x, y, dx, dy) {
        let near = 0, far = Infinity;
        if (Math.abs(dx) < 1e-12) { if (x < box[0] || x > box[2]) return false; }
        else {
            const t1 = (box[0] - x) / dx, t2 = (box[2] - x) / dx;
            near = Math.max(near, Math.min(t1, t2)); far = Math.min(far, Math.max(t1, t2));
        }
        if (Math.abs(dy) < 1e-12) { if (y < box[1] || y > box[3]) return false; }
        else {
            const t1 = (box[1] - y) / dy, t2 = (box[3] - y) / dy;
            near = Math.max(near, Math.min(t1, t2)); far = Math.min(far, Math.max(t1, t2));
        }
        return near <= far;
    }
    function rayEntry(solid, x, y, dx, dy) {
        let best = Infinity;
        if (!rayMeetsBox(solid.box, x, y, dx, dy)) return best;
        for (const part of solid.parts) for (const ring of part.rings) for (let i = 0; i < ring.length - 1; i++) {
            const [ax, ay] = ring[i], [bx, by] = ring[i + 1];
            const ex = bx - ax, ey = by - ay, denom = dx * ey - dy * ex;
            if (Math.abs(denom) < 1e-12) continue;
            const t = ((ax - x) * ey - (ay - y) * ex) / denom, u = ((ax - x) * dy - (ay - y) * dx) / denom;
            if (t > 1e-6 && u >= 0 && u <= 1 && t < best) best = t;
        }
        return best;
    }
    function segmentDistance(p, a, b) {
        const ex = b[0] - a[0], ey = b[1] - a[1], len2 = ex * ex + ey * ey;
        const t = len2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * ex + (p[1] - a[1]) * ey) / len2)) : 0;
        return Math.hypot(p[0] - a[0] - t * ex, p[1] - a[1] - t * ey);
    }
    function segmentsDistance(a, b, c, d) {
        const cross = (o, p, q) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
        if (Math.sign(cross(a, b, c)) !== Math.sign(cross(a, b, d)) && Math.sign(cross(c, d, a)) !== Math.sign(cross(c, d, b))) return 0;
        return Math.min(segmentDistance(a, c, d), segmentDistance(b, c, d), segmentDistance(c, a, b), segmentDistance(d, a, b));
    }
    // The nearest point of a solid's walls to segment ab: distance and the solid's nearest vertex/edge point.
    function solidSegmentDistance(solid, a, b) {
        let best = Infinity;
        for (const part of solid.parts) for (const ring of part.rings) for (let i = 0; i < ring.length - 1; i++) {
            const distance = segmentsDistance(a, b, ring[i], ring[i + 1]);
            if (distance < best) best = distance;
        }
        return best;
    }

    // ---- Sun ----
    // The sun's positions over a day at a place, every `stepMin` minutes while it is up:
    // [{ altitude, dx, dy }] with (dx, dy) the horizontal unit vector towards the sun (east, north).
    function sunPath(sunCalc, dateISO, lat, lng, stepMin = GUIDE.sunStepMin) {
        const [year, month, day] = String(dateISO).split('-').map(Number);
        const solarMidnight = Date.UTC(year, month - 1, day) - lng / 15 * 3600000;
        const path = [];
        for (let minutes = 0; minutes < 1440; minutes += stepMin) {
            const { altitude, azimuth } = sunCalc.getPosition(new Date(solarMidnight + minutes * 60000), lat, lng);
            // SunCalc's azimuth runs from south, positive towards west.
            if (altitude > 0) path.push({ altitude, tan: Math.tan(altitude), dx: -Math.sin(azimuth), dy: -Math.cos(azimuth) });
        }
        // Highest first: a garden point finds its two hours sooner, and the count stops there.
        path.sort((a, b) => b.altitude - a.altitude);
        return { stepMin, positions: path };
    }
    // Whether a ground point is in a solid's shadow for a sun position.
    function shades(solid, x, y, sun) {
        if (boxDistance(solid.box, x, y) * sun.tan >= solid.heightM) return false;
        return rayEntry(solid, x, y, sun.dx, sun.dy) * sun.tan < solid.heightM;
    }

    // ---- Vertical sky component (CIE standard overcast sky) ----
    // ∫ (1 + 2 sin θ)/3 · cos²θ dθ, from which the sky above an obstruction at elevation θ lights a wall.
    const F = theta => (theta / 2 + Math.sin(2 * theta) / 4 - (2 / 3) * Math.cos(theta) ** 3) / 3;
    const HORIZONTAL = 7 * Math.PI / 9;
    // The directions a wall point facing (nx, ny) looks along: [{ dx, dy, weight }] over the half plane.
    function wallDirections(nx, ny, stepDeg = GUIDE.skyStepDeg) {
        const step = stepDeg * Math.PI / 180, normal = Math.atan2(ny, nx), directions = [];
        for (let phi = -Math.PI / 2 + step / 2; phi < Math.PI / 2; phi += step) {
            directions.push({ dx: Math.cos(normal + phi), dy: Math.sin(normal + phi), weight: Math.cos(phi) * step });
        }
        return directions;
    }
    // The elevation (radians) of the highest obstruction along each direction from (x, y) at height h0.
    function obstructions(solids, x, y, h0, directions) {
        return directions.map(({ dx, dy }) => {
            let elevation = 0;
            for (const solid of solids) {
                const rise = solid.heightM - h0;
                if (rise <= 0 || Math.atan2(rise, boxDistance(solid.box, x, y)) <= elevation) continue;
                const t = rayEntry(solid, x, y, dx, dy);
                if (t < Infinity) elevation = Math.max(elevation, Math.atan2(rise, t));
            }
            return elevation;
        });
    }
    // Percent of an unobstructed horizontal plane's sky light that reaches the wall point, from the
    // obstruction elevations along `directions`: 39.6 with nothing in front of it.
    const skyPercent = (directions, elevations) => 100 * directions.reduce((sum, direction, i) =>
        sum + direction.weight * (F(Math.PI / 2) - F(elevations[i])), 0) / HORIZONTAL;
    function skyComponent(solids, x, y, h0, nx, ny, stepDeg = GUIDE.skyStepDeg) {
        const directions = wallDirections(nx, ny, stepDeg);
        return skyPercent(directions, obstructions(solids, x, y, h0, directions));
    }

    // ---- Readings ----
    function solidOf(record, project) {
        const parts = partsOf(record.geometry, project);
        if (!parts.length || !finite(record.heightM) || record.heightM <= 0) return null;
        return { id: record.id, parts, box: joinBoxes(parts.map(part => part.box)), heightM: record.heightM,
            estimated: !!record.estimated, point: pointIn(parts) };
    }
    // The walls of a building that face towards the design: [{ a, b, mid, nx, ny }], each wall's outward
    // normal pointing within 90° of the design's nearest point. A wall against another standing
    // building (`others`, a terrace's party wall) is left out.
    function facingWalls(solid, target, others = []) {
        const walls = [];
        for (const part of solid.parts) {
            const ring = part.rings[0], outward = ringArea(ring) > 0 ? 1 : -1;
            for (let i = 0; i < ring.length - 1; i++) {
                const a = ring[i], b = ring[i + 1], length = Math.hypot(b[0] - a[0], b[1] - a[1]);
                if (length < GUIDE.minWallM) continue;
                // A counter-clockwise ring's outside is on the right of each edge.
                const nx = outward * (b[1] - a[1]) / length, ny = -outward * (b[0] - a[0]) / length;
                const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
                const to = nearestPoint(target, mid);
                if (!to) continue;
                if ((to[0] - mid[0]) * nx + (to[1] - mid[1]) * ny <= 0) continue;
                const probe = [mid[0] + nx * PARTY_WALL_M, mid[1] + ny * PARTY_WALL_M];
                if (others.some(other => other !== solid && inParts(other.parts, probe[0], probe[1]))) continue;
                walls.push({ a, b, mid, nx, ny });
            }
        }
        return walls;
    }
    function nearestPoint(solids, p) {
        let best = null, distance = Infinity;
        for (const solid of solids) for (const part of solid.parts) for (const ring of part.rings) for (let i = 0; i < ring.length - 1; i++) {
            const a = ring[i], b = ring[i + 1], ex = b[0] - a[0], ey = b[1] - a[1], len2 = ex * ex + ey * ey;
            const t = len2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * ex + (p[1] - a[1]) * ey) / len2)) : 0;
            const q = [a[0] + t * ex, a[1] + t * ey], d = Math.hypot(q[0] - p[0], q[1] - p[1]);
            if (d < distance) { distance = d; best = q; }
        }
        return best;
    }
    const changed = (before, after, same) => finite(before) && finite(after) ? after < before - same : false;

    const areaOf = parts => parts.reduce((sum, part) => sum + Math.abs(ringArea(part.rings[0]))
        - part.rings.slice(1).reduce((holes, ring) => holes + Math.abs(ringArea(ring)), 0), 0);
    // The garden of a lot (its land outside every building, before and after) sampled on a grid, and
    // the share of it with at least two hours of sun on the day of `sun`. Buildings that stay are
    // tested once for both states; a point stops counting once both states have their two hours.
    function gardenReading(lot, { kept, removed, design }, sun) {
        const [w, s, e, n] = lot.box;
        // Per sun position, only the solids that can shade some part of the lot: on the sun's side of
        // it and tall enough for their shadow to reach it, nearest first. When neither the design nor
        // what it replaces can shade the lot at all, its garden keeps its sun: nothing to sample.
        const along = (box, dx, dy, pick) => pick(box[0] * dx + box[1] * dy, box[2] * dx + box[1] * dy, box[2] * dx + box[3] * dy, box[0] * dx + box[3] * dy);
        const casting = (solids, position) => {
            const behind = along(lot.box, position.dx, position.dy, Math.min);
            return solids.filter(solid => solid.apart * position.tan < solid.heightM && along(solid.box, position.dx, position.dy, Math.max) > behind);
        };
        const withApart = solids => solids.map(solid => ({ ...solid, apart: boxesApart(solid.box, lot.box) })).sort((a, b) => a.apart - b.apart);
        const [stays, goes, comes] = [kept, removed, design].map(withApart);
        const changing = sun.positions.map(position => ({ position, removed: casting(goes, position), design: casting(comes, position) }));
        if (changing.every(entry => !entry.removed.length && !entry.design.length)) return null;
        const casters = changing.map(entry => ({ ...entry, kept: casting(stays, entry.position) }));
        const step = Math.max(1, Math.sqrt(areaOf(lot.parts) / GUIDE.maxGardenPoints));
        const need = Math.ceil(GUIDE.gardenHours * 60 / sun.stepMin);
        const covered = (solids, x, y) => solids.some(solid => inParts(solid.parts, x, y));
        const before = { lit: 0, total: 0 }, after = { lit: 0, total: 0 };
        for (let x = w + step / 2; x < e; x += step) for (let y = s + step / 2; y < n; y += step) {
            if (!inParts(lot.parts, x, y) || covered(kept, x, y)) continue;
            const open = { before: !covered(removed, x, y), after: !covered(design, x, y) };
            let hitsBefore = 0, hitsAfter = 0;
            for (const { position, kept: stay, removed: went, design: come } of casters) {
                if (stay.some(solid => shades(solid, x, y, position))) continue;
                if (hitsBefore < need && !went.some(solid => shades(solid, x, y, position))) hitsBefore++;
                if (hitsAfter < need && !come.some(solid => shades(solid, x, y, position))) hitsAfter++;
                if (hitsBefore >= need && hitsAfter >= need) break;
            }
            if (open.before) { before.total++; if (hitsBefore >= need) before.lit++; }
            if (open.after) { after.total++; if (hitsAfter >= need) after.lit++; }
        }
        if (!before.total || !after.total) return null;
        const share = { before: before.lit / before.total, after: after.lit / after.total };
        const status = share.after < GUIDE.gardenShare && share.after < GUIDE.ratio * share.before - 1e-9 ? 'fail'
            : changed(share.before, share.after, SAME.share) ? 'worse' : 'same';
        return { areaM2: after.total * step * step, before: share.before, after: share.after, status };
    }
    // The worst facing wall of a lot's buildings: the sky it sees before and after, and the nearest
    // facing wall of the design (and, before, of what the design replaces).
    function wallReadings(lotBuildings, { kept, removed, design }, reachM) {
        let sky = null, distance = null;
        const loss = reading => reading.before ? reading.after / reading.before : 1;
        for (const building of lotBuildings) {
            for (const wall of facingWalls(building, design, [...kept, ...removed])) {
                const after = Math.min(...design.map(solid => solidSegmentDistance(solid, wall.a, wall.b)));
                const was = removed.length ? Math.min(...removed.map(solid => solidSegmentDistance(solid, wall.a, wall.b))) : null;
                const near = { before: was, after, buildingId: building.id };
                // Only a wall brought within the guide counts; farther than 21 m a closer wall is no effect.
                near.status = near.after < GUIDE.facingDistanceM - 1e-9 && (near.before === null || near.after < near.before - SAME.distance) ? 'fail' : 'same';
                if (!distance || near.after < distance.after) distance = near;
                if (after > reachM) continue;
                const x = wall.mid[0] + wall.nx * 0.05, y = wall.mid[1] + wall.ny * 0.05, h0 = GUIDE.windowHeightM;
                const directions = wallDirections(wall.nx, wall.ny);
                const went = obstructions(removed, x, y, h0, directions), come = obstructions(design, x, y, h0, directions);
                // A wall that sees neither the design nor what it replaces keeps its sky.
                if (went.every(v => v === 0) && come.every(v => v === 0)) continue;
                const byDistance = kept.map(solid => [boxDistance(solid.box, x, y), solid]).sort((a, b) => a[0] - b[0]).map(entry => entry[1]);
                const stay = obstructions(byDistance, x, y, h0, directions);
                const reading = { before: skyPercent(directions, stay.map((v, i) => Math.max(v, went[i]))),
                    after: skyPercent(directions, stay.map((v, i) => Math.max(v, come[i]))), buildingId: building.id };
                reading.status = reading.after < GUIDE.skyPercent - 1e-9 && reading.after < GUIDE.ratio * reading.before - 1e-9 ? 'fail'
                    : changed(reading.before, reading.after, SAME.sky) ? 'worse' : 'same';
                if (!sky || rank(reading.status) > rank(sky.status) || (rank(reading.status) === rank(sky.status) && loss(reading) < loss(sky))) sky = reading;
            }
        }
        return { sky, distance };
    }
    const RANK = { same: 0, worse: 1, fail: 2 };
    const rank = status => RANK[status] ?? 0;
    const worst = statuses => statuses.filter(Boolean).reduce((a, b) => rank(b) > rank(a) ? b : a, 'same');

    // `site`: the design's parcels (lng/lat geometries). `lots`: [{ id, geometry }] around it.
    // `existing`: [{ id, geometry, heightM, estimated? }] buildings standing now; those on the site go
    // with the design. `proposed`: [{ id, geometry, heightM }]. `sun`: sunPath(...) for 21 March.
    // Answers { lots: [{ id, status, direction, distanceM, garden, sky, distance, estimatedHeights }],
    // reachM, estimated } with only the lots whose readings change, worst first.
    function assess({ site, lots, existing, proposed, sun }) {
        const firstPoint = proposed.map(record => record.geometry?.type === 'Polygon' ? record.geometry.coordinates[0]?.[0]
            : record.geometry?.coordinates?.[0]?.[0]?.[0]).find(Boolean);
        if (!firstPoint) return { lots: [], reachM: 0, estimated: 0 };
        const projection = projector(firstPoint[0], firstPoint[1]), project = projection.point;
        const siteParts = site.flatMap(geometry => partsOf(geometry, project));
        const design = proposed.map(record => solidOf(record, project)).filter(Boolean);
        if (!design.length) return { lots: [], reachM: 0, estimated: 0 };
        const standing = existing.map(record => solidOf(record, project)).filter(Boolean);
        const onSite = solid => solid.point && inParts(siteParts, solid.point[0], solid.point[1]);
        const removed = standing.filter(onSite), kept = standing.filter(solid => !onSite(solid));
        const tallest = Math.max(...design.map(solid => solid.heightM), ...removed.map(solid => solid.heightM));
        const reachM = Math.max(GUIDE.minReachM, Math.min(GUIDE.maxReachM, GUIDE.reachFactor * tallest));
        const changes = [...design, ...removed];
        const designBox = joinBoxes(design.map(solid => solid.box));
        const centre = [(designBox[0] + designBox[2]) / 2, (designBox[1] + designBox[3]) / 2];
        const results = [];
        for (const lot of lots) {
            const parts = partsOf(lot.geometry, project);
            if (!parts.length) continue;
            const shape = { parts, box: joinBoxes(parts.map(part => part.box)) };
            const middle = pointIn(parts);
            if (!middle || inParts(siteParts, middle[0], middle[1])) continue;
            const apart = Math.min(...changes.map(solid => boxesApart(solid.box, shape.box)));
            if (apart > reachM) continue;
            const lotBuildings = kept.filter(solid => solid.point && inParts(parts, solid.point[0], solid.point[1]));
            const near = solids => solids.filter(solid => boxesApart(solid.box, shape.box) <= GUIDE.maxReachM);
            const around = { kept: near(kept), removed: near(removed), design: near(design) };
            const garden = gardenReading(shape, around, sun);
            const { sky, distance } = wallReadings(lotBuildings, around, reachM);
            const status = worst([garden?.status, sky?.status, distance?.status]);
            if (status === 'same') continue;
            const bearing = (Math.atan2(middle[0] - centre[0], middle[1] - centre[1]) * 180 / Math.PI + 360) % 360;
            results.push({ id: lot.id, status, direction: COMPASS[Math.round(bearing / 45) % 8], distanceM: apart, garden, sky, distance,
                estimatedHeights: around.kept.filter(solid => solid.estimated).length });
        }
        results.sort((a, b) => rank(b.status) - rank(a.status) || a.distanceM - b.distanceM);
        return { lots: results, reachM, estimated: standing.filter(solid => solid.estimated).length };
    }
    const COMPASS = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];

    return { GUIDE, sunPath, skyComponent, assess, projector };
});
