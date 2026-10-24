// Spatial apartment entries and buffered unit crops retain the registered floor model's real placement.
(function (root, factory) {
    const api = factory(root, typeof require === 'function' ? require : null);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.CameraFlightInteriors = api;
})(typeof window !== 'undefined' ? window : null, function (root, nodeRequire) {
    'use strict';
    const finite = value => typeof value === 'number' && Number.isFinite(value);
    const clone = value => JSON.parse(JSON.stringify(value));
    const same = (a, b) => a[0] === b[0] && a[1] === b[1];
    const open = ring => same(ring[0], ring[ring.length - 1]) ? ring.slice(0, -1) : ring.slice();
    const closed = ring => [...open(ring), ring[0]];
    const point = p => Array.isArray(p) && p.length === 2 && Array.from(p).every(x => finite(x) && x >= 0 && x <= 1);
    const orient = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const area = ring => ring.reduce((sum, a, i) => {
        const b = ring[(i + 1) % ring.length]; return sum + a[0] * b[1] - a[1] * b[0];
    }, 0) / 2;
    const cross = (a, b, c, d) => orient(a, b, c) * orient(a, b, d) < -1e-20 && orient(c, d, a) * orient(c, d, b) < -1e-20;
    function inRing(p, ring) {
        let inside = false;
        for (let i = 0; i < ring.length; i++) {
            const a = ring[i], b = ring[(i + 1) % ring.length];
            if (Math.abs(orient(a, b, p)) < 1e-12 && p[0] >= Math.min(a[0], b[0]) && p[0] <= Math.max(a[0], b[0])
                && p[1] >= Math.min(a[1], b[1]) && p[1] <= Math.max(a[1], b[1])) return 0;
            if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
        }
        return inside ? 1 : -1;
    }

    function validateBoundary(boundary) {
        if (!Array.isArray(boundary) || !boundary.length || boundary.length > 100) return 'Apartment boundary must contain normalized polygons.';
        let vertices = 0;
        for (const rings of Array.from(boundary)) {
            if (!Array.isArray(rings) || !rings.length || rings.length > 100) return 'Apartment boundary needs an outer ring.';
            const normalized = [];
            for (const raw of Array.from(rings)) {
                if (!Array.isArray(raw) || raw.length < 3 || raw.length > 2048 || !Array.from(raw).every(point)) return 'Apartment boundary needs finite normalized UV points.';
                const ring = open(raw); vertices += ring.length;
                if (vertices > 20000 || ring.length < 3 || Math.abs(area(ring)) < 1e-12) return 'Apartment boundary is empty or too complex.';
                for (let i = 0; i < ring.length; i++) {
                    if (same(ring[i], ring[(i + 1) % ring.length])) return 'Apartment boundary contains duplicate vertices.';
                    for (let j = i + 2; j < ring.length; j++) {
                        if (i === 0 && j === ring.length - 1) continue;
                        if (cross(ring[i], ring[(i + 1) % ring.length], ring[j], ring[(j + 1) % ring.length])) return 'Apartment boundary crosses itself.';
                    }
                }
                normalized.push(ring);
            }
            for (let i = 1; i < normalized.length; i++) {
                if (normalized[i].some(p => inRing(p, normalized[0]) !== 1)) return 'Apartment boundary hole must lie inside its outer ring.';
                for (let j = 0; j < i; j++) {
                    if (j && (inRing(normalized[i][0], normalized[j]) >= 0 || inRing(normalized[j][0], normalized[i]) >= 0)) return 'Apartment boundary holes overlap.';
                    for (let a = 0; a < normalized[i].length; a++) for (let b = 0; b < normalized[j].length; b++) {
                        if (cross(normalized[i][a], normalized[i][(a + 1) % normalized[i].length], normalized[j][b], normalized[j][(b + 1) % normalized[j].length])) return 'Apartment boundary rings cross.';
                    }
                }
            }
        }
        return null;
    }

    const polygonsOf = feature => !feature ? [] : feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
    const shape = (polygons, turf) => turf.multiPolygon(polygons.map(rings => rings.map(closed)));
    const uvPolygons = feature => polygonsOf(feature).map(rings => rings.map(open).filter(ring => ring.length >= 3 && Math.abs(area(ring)) > 1e-12)).filter(rings => rings.length);

    function interiorPoint(feature, turf) {
        const inside = p => turf.booleanPointInPolygon(turf.point(p), feature, { ignoreBoundary: true });
        if (typeof turf.pointOnFeature === 'function') {
            const candidate = turf.pointOnFeature(feature).geometry.coordinates;
            if (inside(candidate)) return candidate;
        }
        for (const rings of polygonsOf(feature)) {
            const ys = [...new Set(rings.flat().map(p => p[1]))].sort((a, b) => a - b);
            for (let i = 1; i < ys.length; i++) {
                const y = (ys[i - 1] + ys[i]) / 2, xs = [];
                for (const raw of rings) { const ring = open(raw); ring.forEach((a, j) => {
                    const b = ring[(j + 1) % ring.length];
                    if ((a[1] > y) !== (b[1] > y)) xs.push(a[0] + (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]));
                }); }
                xs.sort((a, b) => a - b);
                for (let j = 1; j < xs.length; j += 2) {
                    const candidate = [(xs[j - 1] + xs[j]) / 2, y];
                    if (inside(candidate)) return candidate;
                }
            }
        }
        throw new Error('Interior has no usable entry point.');
    }

    function inverseRegistration(plans) {
        const [a, b, c, d] = plans.registration.corners;
        const x = b.map((v, i) => v - a[i]), y = d.map((v, i) => v - a[i]), bend = c.map((v, i) => v - b[i] - d[i] + a[i]);
        return target => {
            let u = 0.5, v = 0.5;
            for (let iteration = 0; iteration < 16; iteration++) {
                const error = a.map((n, i) => n + u * x[i] + v * y[i] + u * v * bend[i] - target[i]);
                if (Math.hypot(...error) < 1e-12) return [u, v];
                const du = x.map((n, i) => n + v * bend[i]), dv = y.map((n, i) => n + u * bend[i]);
                const determinant = du[0] * dv[1] - du[1] * dv[0];
                if (!finite(determinant) || Math.abs(determinant) < 1e-20) break;
                u -= (error[0] * dv[1] - error[1] * dv[0]) / determinant;
                v -= (du[0] * error[1] - du[1] * error[0]) / determinant;
                if (!finite(u) || !finite(v) || Math.abs(u) > 10 || Math.abs(v) > 10) break;
            }
            throw new Error('Cannot invert the interior registration.');
        };
    }

    // Generated polygon unions can leave a zero-area collinear spur at the ring seam.
    // Remove it in normalized UV before geographic buffering, which otherwise keeps the spur alone.
    function withoutSpurs(raw) {
        const ring = open(raw);
        let changed = true;
        while (changed && ring.length > 3) {
            changed = false;
            for (let i = 0; i < ring.length; i++) {
                if (Math.abs(orient(ring[(i + ring.length - 1) % ring.length], ring[i], ring[(i + 1) % ring.length])) < 1e-12) {
                    ring.splice(i, 1); changed = true; break;
                }
            }
        }
        return ring;
    }

    function expandedBoundary(boundary, architecture, plans, geometry, turf) {
        const toLngLat = geometry.registrationToLngLat(plans), fromLngLat = inverseRegistration(plans);
        const geographic = shape(boundary.map(rings => rings.map(ring => withoutSpurs(ring).map(p => toLngLat(p[0], p[1])))), turf);
        const depth = architecture.openings.reduce((max, opening) => Math.max(max, opening.depthM), 0.3);
        const buffered = turf.buffer(geographic, Math.min(0.6, depth + 0.05), { units: 'meters', steps: 4 });
        if (!buffered?.geometry) throw new Error('Cannot buffer the apartment boundary.');
        const polygons = polygonsOf(buffered).map(rings => rings.map(ring => ring.map(fromLngLat)));
        if (!polygons.length || polygons.flat(2).some(p => !Array.isArray(p) || !p.every(finite))) throw new Error('Invalid buffered apartment boundary.');
        return shape(polygons, turf);
    }

    function segmentPieces(a, b, boundary, turf) {
        const times = [0, 1], dx = b[0] - a[0], dy = b[1] - a[1];
        for (const rings of polygonsOf(boundary)) for (const raw of rings) {
            const ring = open(raw);
            ring.forEach((c, i) => {
                const d = ring[(i + 1) % ring.length], ex = d[0] - c[0], ey = d[1] - c[1], den = dx * ey - dy * ex;
                if (Math.abs(den) < 1e-14) return;
                const t = ((c[0] - a[0]) * ey - (c[1] - a[1]) * ex) / den;
                const s = ((c[0] - a[0]) * dy - (c[1] - a[1]) * dx) / den;
                if (t > 0 && t < 1 && s >= -1e-9 && s <= 1 + 1e-9) times.push(t);
            });
        }
        times.sort((x, y) => x - y);
        const lerp = t => [a[0] + t * dx, a[1] + t * dy], pieces = [];
        for (let i = 1; i < times.length; i++) {
            const start = times[i - 1], end = times[i];
            if (end - start > 1e-9 && turf.booleanPointInPolygon(turf.point(lerp((start + end) / 2)), boundary)) pieces.push({ a: lerp(start), b: lerp(end), start, end });
        }
        return pieces;
    }

    function cropArchitecture(source, boundary, geometry, turf) {
        const points = polygonsOf(boundary).flat(2), minimum = [0, 1].map(axis => Math.min(...points.map(p => p[axis]))),
            maximum = [0, 1].map(axis => Math.max(...points.map(p => p[axis]))), span = maximum.map((n, i) => n - minimum[i]);
        const rebase = p => p.map((n, i) => Math.max(0, Math.min(1, (n - minimum[i]) / span[i])));
        const clip = polygons => polygons.flatMap(rings => uvPolygons(turf.intersect(shape([rings], turf), boundary)))
            .map(rings => rings.map(ring => ring.map(rebase)));
        const architecture = { ...clone(source), dimensionsM: source.dimensionsM.map((n, i) => n * span[i]),
            walls: clip(source.walls), slabs: clip(source.slabs), landings: clip(source.landings) };
        if (source.platforms) architecture.platforms = source.platforms.flatMap(platform => clip([platform.rings]).map(rings => ({ ...clone(platform), rings })));
        for (const field of ['openings', 'stairs', 'railings']) {
            architecture[field] = source[field].flatMap(item => segmentPieces(item.a, item.b, boundary, turf).flatMap(piece => {
                const result = { ...clone(item), a: rebase(piece.a), b: rebase(piece.b) };
                if (Math.hypot(result.a[0] - result.b[0], result.a[1] - result.b[1]) < 1e-7) return [];
                if (item.hinge) {
                    const leaf = segmentPieces(item.hinge, item.openTip, boundary, turf)[0];
                    if (!leaf) return [];
                    result.hinge = rebase(leaf.a); result.openTip = rebase(leaf.b);
                    if (Math.hypot(result.hinge[0] - result.openTip[0], result.hinge[1] - result.openTip[1]) < 1e-7) return [];
                }
                if (field === 'stairs') {
                    result.fromM = item.fromM + (item.toM - item.fromM) * piece.start;
                    result.toM = item.fromM + (item.toM - item.fromM) * piece.end;
                    result.steps = Math.max(1, Math.round(item.steps * (piece.end - piece.start)));
                }
                return [result];
            }));
        }
        const errors = geometry.validateArchitecture(architecture);
        if (errors.length) throw new Error(`Cannot crop apartment architecture: ${errors.join('; ')}`);
        return { architecture, minimum, maximum };
    }

    function listUnits(feature, options = {}) {
        const plans = feature?.properties?.floorPlans;
        if (!plans) return [];
        const geometry = options.geometry || root?.__buildingFloorPlans || (nodeRequire && nodeRequire('./building-floor-plans.js'));
        const turf = options.turf || root?.turf || (nodeRequire && nodeRequire('node:module').createRequire(`${process.cwd()}/package.json`)('@turf/turf'));
        if (!geometry || !turf) throw new Error('Floor geometry and Turf are required for interior entries.');
        const errors = geometry.validateFloorPlans(plans);
        if (errors.length) throw new Error(`Invalid interior floor model: ${errors.join('; ')}`);
        const layouts = new Map(plans.layouts.map(layout => [layout.id, layout])), toLngLat = geometry.registrationToLngLat(plans), result = [], crops = new Map();
        for (const floor of plans.floors) {
            const layout = layouts.get(floor.layoutId), spatial = (floor.apartments || []).filter(apartment => apartment.boundary !== undefined);
            const common = { floorId: floor.id, level: floor.level, elevationM: floor.elevationM, suggested: plans.suggested === true };
            if (!spatial.length) {
                result.push({ ...common, id: `${floor.id}/floor`, apartmentId: null, architecture: clone(layout.architecture),
                    entryUv: interiorPoint(shape(layout.architecture.slabs, turf), turf), registration: clone(plans.registration) });
                continue;
            }
            const ids = new Set();
            for (const apartment of spatial) {
                if (ids.has(apartment.id)) throw new Error('Apartment identities must be unique within a floor.');
                ids.add(apartment.id);
                const error = validateBoundary(apartment.boundary);
                if (error) throw new Error(`${floor.id}/${apartment.id}: ${error}`);
                const boundary = shape(apartment.boundary, turf);
                const entryUv = apartment.entryUv === undefined ? interiorPoint(boundary, turf) : apartment.entryUv;
                if (!point(entryUv) || !turf.booleanPointInPolygon(turf.point(entryUv), boundary, { ignoreBoundary: true })) throw new Error('Apartment entry must be inside its usable boundary.');
                const cropId = JSON.stringify([layout.id, apartment.boundary]);
                if (!crops.has(cropId)) {
                    const expanded = expandedBoundary(apartment.boundary, layout.architecture, plans, geometry, turf);
                    crops.set(cropId, cropArchitecture(layout.architecture, expanded, geometry, turf));
                }
                const crop = crops.get(cropId);
                const [u0, v0] = crop.minimum, [u1, v1] = crop.maximum;
                result.push({ ...common, id: `${floor.id}/apartment/${apartment.id}`, apartmentId: apartment.id,
                    architecture: clone(crop.architecture), entryUv: entryUv.slice(), boundary: clone(apartment.boundary),
                    registration: { ...clone(plans.registration), corners: [[u0, v0], [u1, v0], [u1, v1], [u0, v1]].map(p => toLngLat(...p)) },
                    ...(typeof apartment.name === 'string' ? { name: apartment.name } : {}),
                    ...(apartment.rooms ? { rooms: clone(apartment.rooms) } : {}), ...(apartment.doorUv ? { doorUv: clone(apartment.doorUv) } : {}) });
            }
        }
        return result;
    }
    return Object.freeze({ listUnits, validateBoundary });
});
