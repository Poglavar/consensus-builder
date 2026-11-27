// Effects of a design on its neighbouring plots, before and after: garden sunlight on a day, sky
// visible from a facing wall (vertical sky component) and the distance to the nearest facing wall.
// How each is measured is here; which readings a place uses and their thresholds are its guides
// (a rule set's `neighbourGuides`, data/planning-sources.json), passed in. Pure: footprints in
// lng/lat, heights in metres above flat ground, sun positions passed in (SunCalc's convention); no
// DOM, no turf. docs/neighbour-effects.md.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.NeighbourEffects = api;
})(typeof window !== 'undefined' ? window : typeof self !== 'undefined' ? self : null, function () {
    'use strict';

    // How the readings are taken, the same everywhere: a window's centre 1.6 m up a wall, walls from
    // 1.5 m long, plots within 4 times the tallest changed building (30–200 m), a garden grid of at
    // most 200 points, the sky every 2° and the sun every 10 minutes. The angle tests look from a
    // window every 3 m along a wall (window positions are not known); the splay test is taken
    // for a building beside a window's wall, starting within 3 m of its plane (an extension, not a
    // building across the street, which the angle test covers).
    const MEASURE = {
        windowHeightM: 1.6, minWallM: 1.5,
        reachFactor: 4, minReachM: 30, maxReachM: 200,
        maxGardenPoints: 200, skyStepDeg: 2, sunStepMin: 10,
        windowStepM: 3, adjoinM: 3,
        // The no-sky line: room points every half metre, at most 400 per room.
        noSkyStepM: 0.5, maxRoomPoints: 400, windowOnWallM: 0.6
    };
    const finite = value => typeof value === 'number' && Number.isFinite(value);
    // Less than this change is no change (garden share 0–1, sky in percentage points, metres,
    // degrees): a fraction of a point is noise of the sampling, not a loss anyone would notice.
    const SAME = { share: 0.01, sky: 1, distance: 0.5, angle: 0.5, splay: 0.1, sunlight: 1, noSky: 0.01 };
    const RAD = Math.PI / 180;
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
    function onSegment(p, a, b) {
        const ex = b[0] - a[0], ey = b[1] - a[1], len2 = ex * ex + ey * ey;
        const t = len2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * ex + (p[1] - a[1]) * ey) / len2)) : 0;
        return [a[0] + t * ex, a[1] + t * ey];
    }
    // The nearest points of segments ab and cd: { distance, from (on ab), to (on cd) }.
    function segmentsClosest(a, b, c, d) {
        const cross = (o, p, q) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
        const abc = cross(a, b, c), abd = cross(a, b, d);
        if (Math.sign(abc) !== Math.sign(abd) && Math.sign(cross(c, d, a)) !== Math.sign(cross(c, d, b))) {
            const f = abc / (abc - abd), at = [c[0] + f * (d[0] - c[0]), c[1] + f * (d[1] - c[1])];
            return { distance: 0, from: at, to: at };
        }
        let best = null;
        for (const [from, to] of [[a, onSegment(a, c, d)], [b, onSegment(b, c, d)], [onSegment(c, a, b), c], [onSegment(d, a, b), d]]) {
            const distance = Math.hypot(to[0] - from[0], to[1] - from[1]);
            if (!best || distance < best.distance) best = { distance, from, to };
        }
        return best;
    }
    // The nearest point of a solid's walls to segment ab: { distance, from (on ab), to (on the solid) }.
    function solidSegmentClosest(solid, a, b) {
        let best = { distance: Infinity, from: null, to: null };
        for (const part of solid.parts) for (const ring of part.rings) for (let i = 0; i < ring.length - 1; i++) {
            const closest = segmentsClosest(a, b, ring[i], ring[i + 1]);
            if (closest.distance < best.distance) best = closest;
        }
        return best;
    }

    // ---- Sun ----
    // The sun's positions over a day at a place, every `stepMin` minutes while it is up:
    // [{ altitude, dx, dy }] with (dx, dy) the horizontal unit vector towards the sun (east, north).
    function sunPath(sunCalc, dateISO, lat, lng, stepMin = MEASURE.sunStepMin) {
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
    // The sun over a year at a place, for probable sunlight hours (BRE BR 209 3.2.4: the hours the
    // sun is expected to shine on unobstructed ground, allowing for the place's average cloudiness):
    // positions every `stepMin` minutes on every `dayStep`th day, each weighted by the hours it
    // stands for times the chance the sun is out in its month, that month's recorded sunshine hours
    // (`monthHours`, January first) over the hours the sun is up in it. `winter` { from, to } (MM-DD,
    // from inclusive) marks the positions in the guide's winter months. Answers { positions: [{ dx,
    // dy, tan, weight, winter }], total (probable sunlight hours), equatorY (the y of the direction
    // of the noon sun: -1 south, 1 north) }.
    function sunYear(sunCalc, year, lat, lng, monthHours, winter = null, { stepMin = 20, dayStep = 4 } = {}) {
        const inWinter = !winter ? () => false : winter.from <= winter.to
            ? monthDay => monthDay >= winter.from && monthDay < winter.to
            : monthDay => monthDay >= winter.from || monthDay < winter.to;
        const upHours = new Array(12).fill(0), positions = [], hours = stepMin / 60 * dayStep;
        for (let day = 0; ; day += dayStep) {
            const date = new Date(Date.UTC(year, 0, 1 + day));
            if (date.getUTCFullYear() !== year) break;
            const month = date.getUTCMonth(), cold = inWinter(date.toISOString().slice(5, 10));
            const solarMidnight = date.getTime() - lng / 15 * 3600000;
            for (let minutes = stepMin / 2; minutes < 1440; minutes += stepMin) {
                const { altitude, azimuth } = sunCalc.getPosition(new Date(solarMidnight + minutes * 60000), lat, lng);
                if (altitude <= 0) continue;
                upHours[month] += hours;
                // SunCalc's azimuth runs from south, positive towards west.
                positions.push({ month, dx: -Math.sin(azimuth), dy: -Math.cos(azimuth), tan: Math.tan(altitude), winter: cold });
            }
        }
        const chance = upHours.map((up, month) => up > 0 && finite(monthHours[month]) ? Math.min(1, monthHours[month] / up) : 0);
        const weighted = positions.map(({ month, ...position }) => ({ ...position, weight: chance[month] * hours }));
        return { positions: weighted, total: weighted.reduce((sum, position) => sum + position.weight, 0), equatorY: lat >= 0 ? -1 : 1 };
    }
    // The share of probable sunlight hours (percent of `year.total`) reaching a wall point facing
    // (nx, ny), over the year and in the winter months, from the obstruction elevations along
    // wallDirections(nx, ny, stepDeg): a position counts when the sun is in front of the wall and
    // above the obstruction in its direction.
    function sunlightAt(year, bins, elevations) {
        const tans = elevations.map(Math.tan);
        let annual = 0, winter = 0;
        year.positions.forEach((position, i) => {
            const bin = bins[i];
            if (bin < 0 || position.tan <= tans[bin]) return;
            annual += position.weight;
            if (position.winter) winter += position.weight;
        });
        return { annual: 100 * annual / year.total, winter: 100 * winter / year.total };
    }
    // Which of wallDirections(nx, ny, stepDeg) each of the year's sun positions lies in, -1 behind the wall.
    function sunBins(year, nx, ny, stepDeg = MEASURE.skyStepDeg) {
        const count = Math.round(180 / stepDeg);
        return year.positions.map(({ dx, dy }) => {
            const along = dx * nx + dy * ny;
            if (along <= 0) return -1;
            const phi = Math.atan2(nx * dy - ny * dx, along) / RAD;
            return Math.min(count - 1, Math.max(0, Math.floor((phi + 90) / stepDeg)));
        });
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
    function wallDirections(nx, ny, stepDeg = MEASURE.skyStepDeg) {
        const step = stepDeg * Math.PI / 180, normal = Math.atan2(ny, nx), directions = [];
        for (let phi = -Math.PI / 2 + step / 2; phi < Math.PI / 2; phi += step) {
            directions.push({ dx: Math.cos(normal + phi), dy: Math.sin(normal + phi), weight: Math.cos(phi) * step });
        }
        return directions;
    }
    // The highest obstruction along each direction from (x, y) at height h0: [{ elevation (radians),
    // t (metres to it), heightM }], elevation 0 and t null where nothing rises above h0.
    function obstructionsReach(solids, x, y, h0, directions) {
        return directions.map(({ dx, dy }) => {
            const top = { elevation: 0, t: null, heightM: null };
            for (const solid of solids) {
                const rise = solid.heightM - h0;
                if (rise <= 0 || Math.atan2(rise, boxDistance(solid.box, x, y)) <= top.elevation) continue;
                const t = rayEntry(solid, x, y, dx, dy);
                if (t < Infinity && Math.atan2(rise, t) > top.elevation) Object.assign(top, { elevation: Math.atan2(rise, t), t, heightM: solid.heightM });
            }
            return top;
        });
    }
    // The elevation (radians) of the highest obstruction along each direction from (x, y) at height h0.
    const obstructions = (solids, x, y, h0, directions) => obstructionsReach(solids, x, y, h0, directions).map(top => top.elevation);
    // Percent of an unobstructed horizontal plane's sky light that reaches the wall point, from the
    // obstruction elevations along `directions`: 39.6 with nothing in front of it.
    const skyPercent = (directions, elevations) => 100 * directions.reduce((sum, direction, i) =>
        sum + direction.weight * (F(Math.PI / 2) - F(elevations[i])), 0) / HORIZONTAL;
    function skyComponent(solids, x, y, h0, nx, ny, stepDeg = MEASURE.skyStepDeg) {
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
    // The outside walls of a building that look out on some of the design: [{ a, b, mid, nx, ny, length,
    // faces }], each with its outward normal and whether it faces the design (the normal within 90°
    // of the design's nearest point). A wall against another standing building (`others`, a
    // terrace's party wall) is left out, as is one with none of the design in front of its plane.
    function outsideWalls(solid, target, others = []) {
        const walls = [];
        for (const part of solid.parts) {
            const ring = part.rings[0], outward = ringArea(ring) > 0 ? 1 : -1;
            for (let i = 0; i < ring.length - 1; i++) {
                const a = ring[i], b = ring[i + 1], length = Math.hypot(b[0] - a[0], b[1] - a[1]);
                if (length < MEASURE.minWallM) continue;
                // A counter-clockwise ring's outside is on the right of each edge.
                const nx = outward * (b[1] - a[1]) / length, ny = -outward * (b[0] - a[0]) / length;
                const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
                const to = nearestPoint(target, mid);
                if (!to) continue;
                const inFront = target.some(other => other.parts.some(p => p.rings[0].some(([x, y]) => (x - mid[0]) * nx + (y - mid[1]) * ny > 0.05)));
                if (!inFront) continue;
                const probe = [mid[0] + nx * PARTY_WALL_M, mid[1] + ny * PARTY_WALL_M];
                if (others.some(other => other !== solid && inParts(other.parts, probe[0], probe[1]))) continue;
                walls.push({ a, b, mid, nx, ny, length, faces: (to[0] - mid[0]) * nx + (to[1] - mid[1]) * ny > 0 });
            }
        }
        return walls;
    }
    // Window points along a wall, one every windowStepM, at least its middle; just off its face.
    function windowPoints(wall) {
        const count = Math.max(1, Math.floor(wall.length / MEASURE.windowStepM));
        return Array.from({ length: count }, (_, i) => {
            const f = (i + 0.5) / count;
            return [wall.a[0] + f * (wall.b[0] - wall.a[0]) + wall.nx * 0.05, wall.a[1] + f * (wall.b[1] - wall.a[1]) + wall.ny * 0.05];
        });
    }

    // ---- Angle tests from a window (screening tests: their place's guides say what follows) ----
    // Facing: the steepest angle above the horizontal at which `solids` rise in front of a window,
    // in the section square to its wall: { degrees, t (metres to it), heightM }, or null.
    function facingAngle(solids, [x, y], nx, ny, h0) {
        let best = null;
        for (const solid of solids) {
            if (solid.heightM <= h0) continue;
            const t = rayEntry(solid, x, y, nx, ny);
            if (t === Infinity) continue;
            const degrees = Math.atan2(solid.heightM - h0, t) / RAD;
            if (!best || degrees > best.degrees) best = { degrees, t, heightM: solid.heightM };
        }
        return best;
    }
    // Splay: a building beside a window's wall (not in front of the window, starting within adjoinM
    // of the wall's plane) crosses the splay line in plan (a line from the window at `degrees` to the
    // wall) and in elevation (the line falling at `degrees` from the building's top corner nearest
    // the window, which passes above the window). Answers the building that reaches deepest past
    // both lines: { depthM (how far the window lies under the elevation line, while the plan line
    // is crossed), side (+1 along the wall from a to b, −1 back), lateralM, endM, heightM }, or null.
    function splayAt(solids, [x, y], wall, h0, degrees) {
        const tx = (wall.b[0] - wall.a[0]) / wall.length, ty = (wall.b[1] - wall.a[1]) / wall.length, tan = Math.tan(degrees * RAD);
        let best = null;
        for (const solid of solids) {
            const local = solid.parts.flatMap(part => part.rings[0]).map(([px, py]) => [(px - x) * tx + (py - y) * ty, (px - x) * wall.nx + (py - y) * wall.ny]);
            const us = local.map(p => p[0]), vs = local.map(p => p[1]);
            const uMin = Math.min(...us), uMax = Math.max(...us), vMin = Math.min(...vs), vMax = Math.max(...vs);
            if ((uMin < 0 && uMax > 0) || vMax <= 0.05 || vMin > MEASURE.adjoinM) continue;
            const side = uMin >= 0 ? 1 : -1, lateralM = side > 0 ? uMin : -uMax;
            // Plan: some of the building lies past the line v = |u|·tan from the window.
            const plan = Math.max(...local.map(([u, v]) => v - Math.abs(u) * tan));
            // Elevation: the window under the line falling from the top corner nearest it.
            const elevation = solid.heightM - lateralM * tan - h0;
            if (plan <= 0 || elevation <= 0) continue;
            const depthM = Math.min(plan, elevation);
            if (!best || depthM > best.depthM) best = { depthM, side, lateralM, endM: vMax, heightM: solid.heightM };
        }
        return best;
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
    // How far a plot's land lies from the design's nearest building, in metres: 0 where they touch or overlap.
    function apartFrom(solids, shape) {
        let best = Infinity;
        for (const solid of solids) {
            if (solid.parts.some(part => part.rings[0].some(([x, y]) => inParts(shape.parts, x, y)))
                || shape.parts.some(part => part.rings[0].some(([x, y]) => inParts(solid.parts, x, y)))) return 0;
            for (const part of shape.parts) for (const ring of part.rings) for (let i = 0; i < ring.length - 1; i++) {
                best = Math.min(best, solidSegmentClosest(solid, ring[i], ring[i + 1]).distance);
            }
        }
        return best;
    }

    const areaOf = parts => parts.reduce((sum, part) => sum + Math.abs(ringArea(part.rings[0]))
        - part.rings.slice(1).reduce((holes, ring) => holes + Math.abs(ringArea(ring)), 0), 0);
    // The garden of a lot (its land outside every building, before and after) sampled on a grid, and
    // the share of it with at least two hours of sun on the day of `sun`. Buildings that stay are
    // tested once for both states; a point stops counting once both states have their two hours.
    function gardenReading(lot, { kept, removed, design }, sun, guide) {
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
        const step = Math.max(1, Math.sqrt(areaOf(lot.parts) / MEASURE.maxGardenPoints));
        const need = Math.ceil(guide.hours * 60 / sun.stepMin);
        const covered = (solids, x, y) => solids.some(solid => inParts(solid.parts, x, y));
        const before = { lit: 0, total: 0 }, after = { lit: 0, total: 0 }, lost = [];
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
            // Where the garden loses its hours of sun, for the drawing.
            if (open.before && open.after && hitsBefore >= need && hitsAfter < need) lost.push([x, y]);
        }
        if (!before.total || !after.total) return null;
        const share = { before: before.lit / before.total, after: after.lit / after.total };
        const status = grade(share.before, share.after, guide.share, guide.ratio, SAME.share);
        return { areaM2: after.total * step * step, before: share.before, after: share.after, status,
            marks: [{ type: 'points', role: 'lost', points: lost.map(([x, y]) => [x, y, 0.15]) }] };
    }
    // The worst wall of a lot's buildings for each reading the place has a guide for: the sky a wall
    // facing the design sees before and after, the nearest facing wall of the design (and, before,
    // of what the design replaces), the angle the design rises to in front of a window (`angle`) and
    // whether a building beside a window crosses its splay lines (`splay`), and the share of the
    // year's probable sunlight hours a wall facing within the guide's angle of the noon sun gets
    // (`sunlight`, with `year`: sunYear(...)). Each reading carries
    // `marks`, its drawing in local metres: the window, the guide's lines and planes, and what the
    // design does to them.
    function wallReadings(lotBuildings, { kept, removed, design }, reachM, guides, year) {
        let sky = null, distance = null, angle = null, splay = null, sunlight = null;
        const loss = reading => reading.before ? reading.after / reading.before : 1;
        const h0 = MEASURE.windowHeightM;
        // A screening test whose place names the detailed reading that then decides ("then") is
        // marked 'screen' when it is crossed: it says the detailed reading applies, and grades nothing.
        const crossed = kind => guides[kind].then && guides[guides[kind].then] ? 'screen' : 'fail';
        // Whether a reading is worse than the one kept so far: crossed before not, then deeper.
        const crossing = reading => reading.status !== 'same';
        const worse = (reading, than) => !than || (crossing(reading) !== crossing(than) ? crossing(reading) : reading.after > than.after);
        for (const building of lotBuildings) {
            for (const wall of outsideWalls(building, design, [...kept, ...removed])) {
                if (guides.splay) for (const point of windowPoints(wall)) {
                    const come = splayAt(design, point, wall, h0, guides.splay.degrees);
                    if (!come) continue;
                    const went = splayAt(removed, point, wall, h0, guides.splay.degrees);
                    const reading = { before: went ? went.depthM : 0, after: come.depthM, degrees: guides.splay.degrees, heightM: come.heightM, buildingId: building.id };
                    reading.status = reading.after > reading.before + SAME.splay ? crossed('splay') : 'same';
                    if (worse(reading, splay)) splay = { ...reading, marks: splayMarks(point, wall, come, h0, guides.splay.degrees) };
                }
                const closest = design.map(solid => solidSegmentClosest(solid, wall.a, wall.b)).reduce((a, b) => b.distance < a.distance ? b : a);
                const after = closest.distance;
                // What a point on the wall sees in each direction, swept once for both the sky and
                // the sun: null when it sees neither the design nor what the design replaces.
                let seen;
                const sweep = () => seen !== undefined ? seen : (seen = view(wall, { kept, removed, design }, h0));
                // Sunlight over the year, for a wall facing within the guide's angle of the noon sun.
                if (guides.sunlight && year && after <= reachM && wall.ny * year.equatorY >= Math.cos(guides.sunlight.facingDeg * RAD) - 1e-9 && sweep()) {
                    const bins = sunBins(year, wall.nx, wall.ny);
                    const then = sunlightAt(year, bins, seen.stay.map((v, i) => Math.max(v, seen.went[i])));
                    const now = sunlightAt(year, bins, seen.stay.map((v, i) => Math.max(v, seen.come[i])));
                    const reading = { before: then.annual, after: now.annual, winterBefore: then.winter, winterAfter: now.winter, buildingId: building.id };
                    reading.status = sunlightGrade(then, now, guides.sunlight);
                    if (!sunlight || rank(reading.status) > rank(sunlight.status) || (rank(reading.status) === rank(sunlight.status) && reading.before - reading.after > sunlight.before - sunlight.after)) {
                        // The sun the design takes: rays to its top edge in directions the sun comes from.
                        const sunny = new Set(bins.filter((bin, i) => bin >= 0 && year.positions[i].weight > 0));
                        sunlight = { ...reading, marks: lostRays(seen, h0, i => sunny.has(i)) };
                    }
                }
                if (!wall.faces) continue;
                const was = removed.length ? Math.min(...removed.map(solid => solidSegmentClosest(solid, wall.a, wall.b).distance)) : null;
                if (guides.distance) {
                    const near = { before: was, after, guideM: guides.distance.metres, buildingId: building.id };
                    // Only a wall brought within the guide counts; beyond it a closer wall is no effect.
                    near.status = near.after < near.guideM - 1e-9 && (near.before === null || near.after < near.before - SAME.distance) ? 'fail' : 'same';
                    if (!distance || near.after < distance.after) distance = { ...near, marks: [
                        { type: 'point', role: 'window', points: [[...closest.from, h0]] },
                        { type: 'line', role: 'measured', points: [[...closest.from, h0], [...closest.to, h0]] }] };
                }
                if (guides.angle && after <= reachM) for (const point of windowPoints(wall)) {
                    const come = facingAngle(design, point, wall.nx, wall.ny, h0);
                    if (!come) continue;
                    const went = facingAngle(removed, point, wall.nx, wall.ny, h0);
                    const reading = { before: went ? went.degrees : 0, after: come.degrees, degrees: guides.angle.degrees, buildingId: building.id };
                    reading.status = reading.after > guides.angle.degrees + 1e-9 && reading.after > reading.before + SAME.angle ? crossed('angle') : 'same';
                    if (worse(reading, angle)) angle = { ...reading, marks: angleMarks(point, wall, come, h0, guides.angle.degrees) };
                }
                // A wall that sees neither the design nor what it replaces keeps its sky.
                if (!guides.sky || after > reachM || !sweep()) continue;
                const { directions, stay, went, come } = seen;
                const reading = { before: skyPercent(directions, stay.map((v, i) => Math.max(v, went[i]))),
                    after: skyPercent(directions, stay.map((v, i) => Math.max(v, come[i]))), buildingId: building.id };
                reading.status = grade(reading.before, reading.after, guides.sky.percent, guides.sky.ratio, SAME.sky);
                if (!sky || rank(reading.status) > rank(sky.status) || (rank(reading.status) === rank(sky.status) && loss(reading) < loss(sky))) {
                    sky = { ...reading, marks: lostRays(seen, h0, () => true) };
                }
            }
        }
        return { sky, distance, angle, splay, sunlight };
    }
    // What a window point in the middle of a wall sees along wallDirections: the elevation of what
    // stays (`stay`), what the design replaces (`went`) and the design (`come`, with `reach`: how far
    // and how high), or null when it sees neither the design nor what it replaces.
    function view(wall, { kept, removed, design }, h0) {
        const x = wall.mid[0] + wall.nx * 0.05, y = wall.mid[1] + wall.ny * 0.05;
        const directions = wallDirections(wall.nx, wall.ny);
        const reach = obstructionsReach(design, x, y, h0, directions);
        const went = obstructions(removed, x, y, h0, directions), come = reach.map(top => top.elevation);
        if (went.every(v => v === 0) && come.every(v => v === 0)) return null;
        const byDistance = kept.map(solid => [boxDistance(solid.box, x, y), solid]).sort((a, b) => a[0] - b[0]).map(entry => entry[1]);
        return { x, y, directions, reach, went, come, stay: obstructions(byDistance, x, y, h0, directions) };
    }
    // What the design takes from a window drawn: the window, and a ray to the design's top edge in
    // every third direction (of those `counts`) where the design stands above all else.
    function lostRays({ x, y, directions, reach, stay, went }, h0, counts) {
        const rays = reach.map((top, i) => ({ top, i })).filter(({ top, i }) => i % 3 === 1 && counts(i) && top.t !== null && top.elevation > Math.max(stay[i], went[i]))
            .map(({ top, i }) => ({ type: 'line', role: 'measured', points: [[x, y, h0], [x + directions[i].dx * top.t, y + directions[i].dy * top.t, top.heightM]] }));
        return [{ type: 'point', role: 'window', points: [[x, y, h0]] }, ...rays];
    }
    // Sunlight to a window against its guide (BRE BR 209 3.2.13): beyond it when the window gets less
    // than `percent` of probable sunlight hours over the year and under `ratio` times before, or less
    // than `winterPercent` in the winter months and under `ratio` times its winter before, and loses
    // more than `lossPercent` of the year's; under a level within the guide otherwise ('below'), a
    // loss that meets both levels ('minor'), or 'same'. `before`, `after`: sunlightAt(...).
    function sunlightGrade(before, after, guide) {
        const under = (now, was, level) => now < level - 1e-9 && now < guide.ratio * was - 1e-9;
        const beyond = under(after.annual, before.annual, guide.percent) || under(after.winter, before.winter, guide.winterPercent);
        if (beyond && before.annual - after.annual > guide.lossPercent + 1e-9) return 'fail';
        if (!changed(before.annual, after.annual, SAME.sunlight) && !changed(before.winter, after.winter, SAME.sunlight)) return 'same';
        return after.annual < guide.percent - 1e-9 || after.winter < guide.winterPercent - 1e-9 ? 'below' : 'minor';
    }
    // The angle test drawn: the window, the guide's plane rising from the wall at its angle, and the
    // line from the window to the top of what the design puts in front of it.
    function angleMarks([x, y], wall, come, h0, degrees) {
        const far = Math.max(come.t + 5, 15), rise = h0 + far * Math.tan(degrees * RAD);
        const out = ([px, py]) => [px + wall.nx * far, py + wall.ny * far];
        return [
            { type: 'point', role: 'window', points: [[x, y, h0]] },
            { type: 'plane', role: 'guide', points: [[...wall.a, h0], [...wall.b, h0], [...out(wall.b), rise], [...out(wall.a), rise]] },
            { type: 'line', role: 'guide', points: [[x, y, h0], [...out([x, y]), rise]] },
            { type: 'line', role: 'measured', points: [[x, y, h0], [x + wall.nx * come.t, y + wall.ny * come.t, come.heightM]] }
        ];
    }
    // The splay test drawn: the window, the plan line on the ground from below it at the guide's
    // angle out to the building's end, and the elevation line on the wall falling at that angle
    // from the building's top corner nearest the window, past the window, to the ground.
    function splayMarks([x, y], wall, come, h0, degrees) {
        const tx = (wall.b[0] - wall.a[0]) / wall.length * come.side, ty = (wall.b[1] - wall.a[1]) / wall.length * come.side;
        const tan = Math.tan(degrees * RAD), cos = Math.cos(degrees * RAD), sin = Math.sin(degrees * RAD);
        const length = come.endM / sin, along = u => [x + tx * u, y + ty * u];
        // From the top corner (u = lateral, height h) down at the angle until the ground.
        const toGround = come.lateralM - come.heightM / tan;
        return [
            { type: 'point', role: 'window', points: [[x, y, h0]] },
            { type: 'line', role: 'guide', points: [[x, y, 0.1], [x + (tx * cos + wall.nx * sin) * length, y + (ty * cos + wall.ny * sin) * length, 0.1]] },
            { type: 'line', role: 'guide', points: [[...along(come.lateralM), come.heightM], [...along(toGround), 0.1]] },
            { type: 'line', role: 'measured', points: [[...along(come.lateralM), 0.1], [...along(come.lateralM), come.heightM]] }
        ];
    }
    // How a reading against a guide of a level and an allowance (after at least `level`, or at least
    // `ratio` times before) grades: 'fail' beyond the guide; 'below' under the level but within the
    // allowance; 'minor' a loss that still meets the level; 'same' no loss worth listing.
    function grade(before, after, level, ratio, same) {
        if (after < level - 1e-9 && after < ratio * before - 1e-9) return 'fail';
        if (!changed(before, after, same)) return 'same';
        return after < level - 1e-9 ? 'below' : 'minor';
    }
    const RANK = { same: 0, minor: 1, below: 2, fail: 3 };
    const rank = status => RANK[status] ?? 0;
    const worst = statuses => statuses.filter(Boolean).reduce((a, b) => rank(b) > rank(a) ? b : a, 'same');

    // `site`: the design's parcels (lng/lat geometries). `lots`: [{ id, geometry }] around it.
    // `existing`: [{ id, geometry, heightM, estimated? }] buildings standing now; those on the site go
    // with the design. `guides`: the place's { garden?: { hours, share, ratio }, sky?: { percent,
    // ratio }, sunlight?: { percent, winterPercent, ratio, lossPercent, facingDeg }, distance?: { metres }, … };
    // a reading without a guide is not taken. `sun`: sunPath(...) for the garden guide's day. `year`:
    // sunYear(...) from the place's sunshine records; without it there is no sunlight reading. Answers { lots: [{ id, status, direction, distanceM, garden, sky,
    // distance, estimatedHeights }], reachM, estimated } with only the lots whose readings change,
    // beyond a guide first, then by largest loss.
    // The local frame of an assessment and its buildings in it: the design's, and those standing now,
    // split into those its site removes and those kept. Null without a design building.
    function frameOf({ site, existing, proposed }) {
        const firstPoint = proposed.map(record => record.geometry?.type === 'Polygon' ? record.geometry.coordinates[0]?.[0]
            : record.geometry?.coordinates?.[0]?.[0]?.[0]).find(Boolean);
        if (!firstPoint) return null;
        const projection = projector(firstPoint[0], firstPoint[1]), project = projection.point;
        const siteParts = site.flatMap(geometry => partsOf(geometry, project));
        const design = proposed.map(record => solidOf(record, project)).filter(Boolean);
        if (!design.length) return null;
        const standing = existing.map(record => solidOf(record, project)).filter(Boolean);
        const onSite = solid => solid.point && inParts(siteParts, solid.point[0], solid.point[1]);
        return { projection, project, siteParts, design, standing, removed: standing.filter(onSite), kept: standing.filter(solid => !onSite(solid)) };
    }
    function assess({ site, lots, existing, proposed, sun, year = null, guides = {} }) {
        const frame = frameOf({ site, existing, proposed });
        if (!frame) return { lots: [], reachM: 0, estimated: 0 };
        const { projection, project, siteParts, design, standing, removed, kept } = frame;
        const tallest = Math.max(...design.map(solid => solid.heightM), ...removed.map(solid => solid.heightM));
        const reachM = Math.max(MEASURE.minReachM, Math.min(MEASURE.maxReachM, MEASURE.reachFactor * tallest));
        const changing = [...design, ...removed];
        const designBox = joinBoxes(design.map(solid => solid.box));
        const centre = [(designBox[0] + designBox[2]) / 2, (designBox[1] + designBox[3]) / 2];
        const results = [];
        for (const lot of lots) {
            const parts = partsOf(lot.geometry, project);
            if (!parts.length) continue;
            const shape = { parts, box: joinBoxes(parts.map(part => part.box)) };
            const middle = pointIn(parts);
            if (!middle || inParts(siteParts, middle[0], middle[1])) continue;
            const apart = Math.min(...changing.map(solid => boxesApart(solid.box, shape.box)));
            if (apart > reachM) continue;
            const lotBuildings = kept.filter(solid => solid.point && inParts(parts, solid.point[0], solid.point[1]));
            const near = solids => solids.filter(solid => boxesApart(solid.box, shape.box) <= MEASURE.maxReachM);
            const around = { kept: near(kept), removed: near(removed), design: near(design) };
            const garden = guides.garden && sun ? gardenReading(shape, around, sun, guides.garden) : null;
            const walls = guides.sky || guides.distance || guides.angle || guides.splay || guides.sunlight ? wallReadings(lotBuildings, around, reachM, guides, year) : {};
            const readings = { garden, sky: walls.sky || null, sunlight: walls.sunlight || null, distance: walls.distance || null, angle: walls.angle || null, splay: walls.splay || null };
            let status = worst(KINDS.map(kind => readings[kind]?.status));
            // Only graded readings list a plot: a crossed first check whose detailed reading shows no
            // change is answered by it, and the plot is left out.
            if (status === 'same') continue;
            // The drawings in lng/lat, heights kept.
            for (const kind of KINDS) {
                const reading = readings[kind];
                if (!reading) continue;
                if (reading.status === 'same') { readings[kind] = { ...reading, marks: undefined }; continue; }
                reading.marks = (reading.marks || []).map(mark => ({ ...mark, points: mark.points.map(([x, y, z]) => [...projection.lngLat([x, y]), z]) }));
            }
            const bearing = (Math.atan2(middle[0] - centre[0], middle[1] - centre[1]) * 180 / Math.PI + 360) % 360;
            results.push({ id: lot.id, status, direction: COMPASS[Math.round(bearing / 45) % 8], distanceM: apartFrom(design, shape), ...readings,
                // The plot's buildings, for readings taken on demand from their rooms (noSky).
                buildingIds: lotBuildings.map(solid => solid.id),
                estimatedHeights: around.kept.filter(solid => solid.estimated).length });
        }
        return { lots: arrange(results).flat(), reachM, estimated: standing.filter(solid => solid.estimated).length };
    }
    const COMPASS = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];

    // ---- No-sky line (BRE BR 209 2.2.10–2.2.11 and Appendix D) ----
    // Whether a point on a working plane sees sky through a window: a sight line from it over some
    // point of the window head (`heads`, at height zHead) clears everything outside (`solids`).
    function seesSky(px, py, pz, heads, zHead, solids) {
        for (const [hx, hy] of heads) {
            const run = Math.hypot(hx - px, hy - py);
            if (run < 1e-6 || zHead <= pz) continue;
            const ux = (hx - px) / run, uy = (hy - py) / run, slope = (zHead - pz) / run;
            let clear = true;
            for (const solid of solids) {
                const rise = solid.heightM - zHead;
                if (rise <= 0 || boxDistance(solid.box, hx, hy) * slope >= rise) continue;
                const t = rayEntry(solid, hx, hy, ux, uy);
                if (t < Infinity && t * slope < rise) { clear = false; break; }
            }
            if (clear) return true;
        }
        return false;
    }
    // The no-sky line in the rooms of a plot's buildings, before the design and after it: for each room
    // of a kind the guide names, the share of its working plane that sees sky, and the worst room
    // against the guide (beyond it when the share falls under `ratio` times before). `rooms`: [{
    // buildingId, level, floorM, kind, ring: [[lng, lat]], windows: [{ a, b, headM }] }] from the
    // buildings' layouts, `windows` those of the room's kind on its storey with their head above its
    // floor (each counts for the room whose wall it lies on, within windowOnWallM). The
    // room's own building is left out of what obstructs it. Answers the reading, with `rooms` (how
    // many were measured), or null when no room was measured.
    function noSky({ site, existing, proposed, rooms, guide }) {
        const frame = frameOf({ site, existing, proposed });
        if (!frame || !Array.isArray(rooms)) return null;
        const { projection, project, siteParts, design, removed, kept } = frame;
        const kinds = new Set(guide.rooms || []);
        const designPoints = design.flatMap(solid => solid.parts.flatMap(part => part.rings[0]));
        let worst = null, measured = 0;
        for (const room of rooms) {
            if (!kinds.has(room.kind) || !(room.level >= 0) || !room.windows?.length || !finite(room.floorM)) continue;
            const ring = room.ring.map(project);
            const part = { rings: [ring], box: boxOf(ring) };
            const centre = pointIn([part]);
            // A room on the site, or under the design, is not a neighbour's (a building reaching across).
            if (!centre || inParts(siteParts, centre[0], centre[1]) || design.some(solid => inParts(solid.parts, centre[0], centre[1]))) continue;
            const others = solids => solids.filter(solid => solid.id !== room.buildingId && boxDistance(solid.box, centre[0], centre[1]) <= MEASURE.maxReachM);
            const before = [...others(kept), ...others(removed)], after = [...others(kept), ...others(design)];
            // Each window's head on the outside face (a fifth of a metre out from the opening's line,
            // away from the room), sampled at its ends and middle; the top corners decide (D7).
            // A layout names a window's room by kind only: a room's windows are those on its own walls.
            const onWalls = ([x, y]) => ring.some((p, i) => i < ring.length - 1 && segmentsClosest([x, y], [x, y], p, ring[i + 1]).distance <= MEASURE.windowOnWallM);
            const windows = room.windows.map(window => ({ a: project(window.a), b: project(window.b), headM: window.headM }))
                .filter(({ a, b }) => onWalls([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2])).map(({ a, b, headM }) => {
                const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
                const length = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
                let nx = (b[1] - a[1]) / length, ny = -(b[0] - a[0]) / length;
                if ((centre[0] - mid[0]) * nx + (centre[1] - mid[1]) * ny > 0) { nx = -nx; ny = -ny; }
                const heads = [0.1, 0.5, 0.9].map(f => [a[0] + f * (b[0] - a[0]) + nx * 0.2, a[1] + f * (b[1] - a[1]) + ny * 0.2]);
                return { heads, zHead: room.floorM + headM, mid, faces: designPoints.some(([x, y]) => (x - mid[0]) * nx + (y - mid[1]) * ny > 0.05) };
            });
            // Only a window with some of the design in front of its wall can lose sky to it.
            if (!windows.some(window => window.faces)) continue;
            const pz = room.floorM + guide.workingPlaneM;
            const area = Math.abs(ringArea(ring));
            const step = Math.max(MEASURE.noSkyStepM, Math.sqrt(area / MEASURE.maxRoomPoints));
            const [w, s, e, n] = part.box;
            let total = 0, litBefore = 0, litAfter = 0;
            const lost = [];
            for (let x = w + step / 2; x < e; x += step) for (let y = s + step / 2; y < n; y += step) {
                if (!inPart(part, x, y)) continue;
                total++;
                const sees = solids => windows.some(window => seesSky(x, y, pz, window.heads, window.zHead, solids));
                const was = sees(before), now = sees(after);
                if (was) litBefore++;
                if (now) litAfter++;
                if (was && !now) lost.push([x, y, pz]);
            }
            if (!total) continue;
            measured++;
            const reading = { before: litBefore / total, after: litAfter / total, room: room.kind, level: room.level, buildingId: room.buildingId, ratio: guide.ratio };
            reading.status = reading.after < guide.ratio * reading.before - 1e-9 && changed(reading.before, reading.after, SAME.noSky) ? 'fail'
                : changed(reading.before, reading.after, SAME.noSky) ? 'minor' : 'same';
            const share = r => r.before > 0 ? r.after / r.before : 1;
            if (!worst || rank(reading.status) > rank(worst.status) || (rank(reading.status) === rank(worst.status) && share(reading) < share(worst))) {
                worst = { ...reading, marks: [
                    ...windows.map(window => ({ type: 'point', role: 'window', points: [[...window.mid, window.zHead]] })),
                    { type: 'plane', role: 'guide', points: ring.slice(0, -1).map(([x, y]) => [x, y, pz]) },
                    { type: 'points', role: 'lost', points: lost }] };
            }
        }
        if (!worst) return null;
        const reading = { ...worst, rooms: measured };
        if (reading.status === 'same') delete reading.marks;
        else reading.marks = reading.marks.map(mark => ({ ...mark, points: mark.points.map(([x, y, z]) => [...projection.lngLat([x, y]), z]) }));
        return reading;
    }

    // ---- Ranking ----
    const KINDS = ['garden', 'sunlight', 'sky', 'noSky', 'angle', 'splay', 'distance'];
    // How much one reading of a plot takes, 0–1: the share of its sunlit garden or sky lost, or for a
    // facing wall how far it now stands inside its guide. 0 when the reading did not change.
    function harmOf(lot, kind) {
        const value = lot[kind];
        if (!value || value.status === 'same') return 0;
        if (kind === 'distance') {
            const was = Math.min(finite(value.before) ? value.before : value.guideM, value.guideM);
            return Math.max(0, Math.min(1, (was - value.after) / value.guideM));
        }
        // An angle: how far above the guide's angle (or what stood before) towards the vertical.
        if (kind === 'angle') return Math.max(0, Math.min(1, (value.after - Math.max(value.before, value.degrees)) / (90 - value.degrees)));
        // A splay: how far under the elevation line the window lies, as a share of the building's
        // height above the window.
        if (kind === 'splay') return Math.max(0, Math.min(1, (value.after - value.before) / Math.max(value.heightM - MEASURE.windowHeightM, 1)));
        return value.before > 0 ? Math.max(0, Math.min(1, (value.before - value.after) / value.before)) : 0;
    }
    // A plot's harm is its largest graded loss; a crossed screening test grades nothing.
    const harm = (lot, kind = null) => kind ? harmOf(lot, kind) : Math.max(...KINDS.filter(each => lot[each]?.status !== 'screen').map(each => harmOf(lot, each)));
    // The kinds of reading that changed on a plot, with their status: [{ kind, status }].
    const changes = lot => KINDS.filter(kind => lot[kind] && lot[kind].status !== 'same').map(kind => ({ kind, status: lot[kind].status }));
    // Plots in three groups by their worst reading (or, with `kind`, that reading's grade): beyond a guide,
    // below a guide's level within its allowance, and minor losses; each by its largest loss first.
    // With `kind`, only the plots where that reading changed, by that reading's loss.
    const GRADES = ['fail', 'below', 'minor'];
    function arrange(lots, { kind = null } = {}) {
        const shown = kind ? lots.filter(lot => lot[kind] && lot[kind].status !== 'same') : lots;
        const order = list => list.slice().sort((a, b) => harm(b, kind) - harm(a, kind) || a.distanceM - b.distanceM);
        // A screening test has no grade of its own: its plot stays in the plot's group.
        const gradeOf = lot => kind && GRADES.includes(lot[kind].status) ? lot[kind].status : lot.status;
        return GRADES.map(each => order(shown.filter(lot => gradeOf(lot) === each)));
    }

    // ---- An affected plot as an agreement's affected parcel ----
    // The right each reading is evidence of (agreement-record.js AFFECTED_RIGHTS) and the guide value
    // it is read against, from the place's guides.
    const RIGHT_OF = { garden: 'garden', sunlight: 'sunlight', sky: 'daylight', noSky: 'daylight', angle: 'daylight', splay: 'daylight', distance: 'privacy' };
    const GUIDE_OF = { garden: g => g.garden?.share, sunlight: g => g.sunlight?.percent, sky: g => g.sky?.percent, noSky: g => g.noSky?.ratio,
        angle: g => g.angle?.degrees, splay: g => g.splay?.degrees, distance: g => g.distance?.metres };
    const rounded = value => (finite(value) ? Math.round(value * 10000) / 10000 : null);
    /**
     * A listed plot as the snapshot an agreement keeps of it: its parcel id, the rights its graded
     * readings are evidence of, and each changed reading (kind, before, after, guide, grade), rounded.
     * A crossed first check (grade 'screen') is kept but names no right of its own.
     * @returns {{ parcelId: string, rights: string[], readings: { kind, before, after, guide, grade }[] }}
     */
    function snapshot(lot, guides = {}) {
        const changed = changes(lot);
        const readings = changed.map(({ kind, status }) => ({ kind, before: rounded(lot[kind].before), after: rounded(lot[kind].after),
            guide: rounded(GUIDE_OF[kind](guides)), grade: status }));
        const graded = changed.filter(change => change.status !== 'screen');
        const rights = [...new Set((graded.length ? graded : changed).map(change => RIGHT_OF[change.kind]))].sort();
        return { parcelId: String(lot.id), rights, readings };
    }

    return { MEASURE, KINDS, GRADES, sunPath, sunYear, sunlightGrade, skyComponent, assess, noSky, statusOf: lot => worst(KINDS.map(kind => lot[kind]?.status)), projector, harm, changes, arrange, snapshot };
});
