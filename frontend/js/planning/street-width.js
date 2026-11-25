// Street width in front of a lot: from its front edge, across the public space, to the first other
// lot line, measured by rays cast outward from the edge. Pure geometry in a local metre frame; turf
// comes in through the options, so node (backend/planning/street-width.js) and the browser share it.
// The width feeds the street-wall rule (a facade may rise to a multiple of the distance across the
// street) and the relative rule terms; a lot whose rays reach nothing within the search distance has
// no measurable width.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.PlanningStreetWidth = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';
    const sitePlots = () => typeof window !== 'undefined' && window.__sitePlots ? window.__sitePlots : require('../proposals/site-plots.js');
    const frontageScores = (...args) => sitePlots().frontageScores(...args);
    const R = 6371008.8, RAD = Math.PI / 180;
    const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
    const boxesTouch = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

    function streetFrame(parcel, obstacles, reachM, turf) {
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

    function streetWidthAcross(parcel, frontEdge, obstacles, { turf, maxDistanceM = 40, rays = [0.25, 0.5, 0.75] } = {}) {
            return rayWidths(streetFrame(parcel, obstacles, maxDistanceM, turf), frontEdge, rays, maxDistanceM, 0.05);
    }

    // Street frontage and the dimensional evaluator share their edge numbering. A missing neighbour
    // is only an open side of a block if a mapped street actually faces it.
    function edgeStanding(parcel, obstacles = [], streets, { turf, minGapM = 2, spacingM = 2, maxDistanceM = 40, frontEdge = null } = {}) {
        const frame = streetFrame(parcel, obstacles, maxDistanceM, turf);
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

    // The street a parcel faces and what stands along it, for relative rule terms (rule-terms.js):
    // the street width in front (streetWidthAcross from the facing edge, across to the first other
    // lot) and the existing buildings on the other parcels within `reachM` that face the same street
    // (same name, else the same line). `parcels` are the lots around (GeoJSON features, the parcel
    // itself among them or not); `buildings` the existing building records there, or null when no
    // building source answered. Returns { street: { widthM, name, id, frontEdge } | null,
    // neighbours: records | null, neighbourParcels }. No facing street: both null (unknown).
    function streetSetting({ parcel, streets = [], parcels = [], buildings = null, turf, reachM = 60 }) {
        if (!turf) throw new TypeError('A street setting needs turf.');
        const facingOf = feature => (streets.length ? frontageScores(feature, streets, { turf })[0] : null) || null;
        const front = facingOf(parcel);
        if (!front) return { street: null, neighbours: null, neighbourParcels: 0, reason: 'no-facing-street' };
        const obstacles = parcels.filter(feature => feature?.geometry && feature !== parcel && feature.id !== parcel.id)
            .map(feature => ({ id: feature.id, geometry: feature.geometry, bbox: turf.bbox(feature), feature }));
        const width = streetWidthAcross(parcel, front.index, obstacles, { turf });
        const sameStreet = street => Boolean(street) && (front.street?.name ? street.name === front.street.name : street.id === front.street?.id);
        const [w, s, e, n] = turf.bbox(parcel), dLat = reachM / 110540, dLng = reachM / (111320 * Math.cos((s + n) / 2 * Math.PI / 180));
        const reach = [w - dLng, s - dLat, e + dLng, n + dLat];
        const along = obstacles.filter(entry => boxesTouch(entry.bbox, reach) && sameStreet(facingOf(entry.feature)?.street));
        const inside = (record, lot) => {
            try { return turf.booleanPointInPolygon(turf.pointOnFeature(turf.feature(record.geometry)), lot.feature); }
            catch (_) { return false; }
        };
        const neighbours = Array.isArray(buildings) ? buildings.filter(record => record?.geometry && along.some(lot => inside(record, lot))) : null;
        return { street: { widthM: width.widthM ?? null, name: front.street?.name || null, id: front.street?.id ?? null, frontEdge: front.index, source: 'street-width' },
            neighbours, neighbourParcels: along.length };
    }
    return { streetWidthAcross, edgeStanding, streetSetting };
});
