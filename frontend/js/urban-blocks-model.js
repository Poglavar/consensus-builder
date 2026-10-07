// Pure road-to-block geometry and metrics. Shared by the worker and headless tests; no map,
// parcels, DOM or city-specific projection is required. Turf is supplied by the caller.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.UrbanBlocksModel = api;
})(typeof self !== 'undefined' ? self : null, function () {
    'use strict';
    const HIGHWAYS = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified',
        'residential', 'living_street', 'pedestrian', 'service', 'motorway_link', 'trunk_link',
        'primary_link', 'secondary_link', 'tertiary_link']);
    const COLORS = ['#ea9575', '#65b8a6', '#9c97ce', '#e4bc58', '#76a8cf', '#ce86ae', '#a0ba68', '#dd9e55'];
    const WALK_COLORS = Object.freeze({ within: '#0e7490', over: '#d97706' });
    const coord = p => p.map(v => Math.round(v * 1e9) / 1e9);
    const key = p => p.join(',');
    const edgeKey = (a, b) => [key(a), key(b)].sort().join('|');
    const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
    const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1];

    function isGroundRoad(properties = {}) {
        const activeTag = value => value != null && !['', 'no', 'false', '0'].includes(String(value));
        const layer = Number(properties.layer || 0);
        return HIGHWAYS.has(properties.highway || properties.highway_type)
            && !activeTag(properties.bridge) && !activeTag(properties.tunnel)
            && Number.isFinite(layer) && layer === 0 && properties.location !== 'underground';
    }

    function isRoadArea(properties = {}) {
        return ['yes', 'true', '1'].includes(String(properties.area));
    }

    // Noding is necessary before polygonize: a crossing inside either segment must become a
    // shared endpoint. Also split collinear overlaps, then deduplicate the undirected edges.
    function nodeRoads(roads, bbox, turf) {
        const segments = [];
        for (const road of roads.features) {
            if (!isGroundRoad(road.properties)) continue;
            const type = road.geometry?.type;
            if (type !== 'LineString' && type !== 'MultiLineString') continue;
            const clipped = turf.bboxClip(road, bbox);
            const lines = clipped.geometry.type === 'LineString'
                ? [clipped.geometry.coordinates] : clipped.geometry.coordinates;
            for (const line of lines) for (let i = 1; i < line.length; i++) {
                const a = coord(line[i - 1]), b = coord(line[i]);
                if (key(a) === key(b)) continue;
                segments.push({ a, b, name: road.properties?.name, cuts: [0, 1] });
            }
        }
        if (segments.length > 50000) throw new Error('Too many road segments. Zoom in and try again.');
        const sweep = segments.map(s => ({ ...s, minX: Math.min(s.a[0], s.b[0]), maxX: Math.max(s.a[0], s.b[0]),
            minY: Math.min(s.a[1], s.b[1]), maxY: Math.max(s.a[1], s.b[1]) })).sort((a, b) => a.minX - b.minX);
        let active = [], comparisons = 0;
        const add = (s, t) => { if (t >= -1e-8 && t <= 1 + 1e-8) s.cuts.push(Math.max(0, Math.min(1, t))); };
        for (const s of sweep) {
            active = active.filter(t => t.maxX >= s.minX);
            const r = sub(s.b, s.a);
            for (const t of active) {
                if (++comparisons > 10000000) throw new Error('Road network is too dense. Zoom in and try again.');
                if (t.maxY < s.minY || t.minY > s.maxY) continue;
                const v = sub(t.b, t.a), q = sub(t.a, s.a);
                const denominator = cross(r, v);
                if (Math.abs(denominator) > 1e-18) {
                    const u = cross(q, v) / denominator, w = cross(q, r) / denominator;
                    if (u >= -1e-8 && u <= 1 + 1e-8 && w >= -1e-8 && w <= 1 + 1e-8) {
                        add(s, u); add(t, w);
                    }
                } else if (Math.abs(cross(q, r)) <= 1e-18) {
                    add(s, dot(sub(t.a, s.a), r) / dot(r, r));
                    add(s, dot(sub(t.b, s.a), r) / dot(r, r));
                    add(t, dot(sub(s.a, t.a), v) / dot(v, v));
                    add(t, dot(sub(s.b, t.a), v) / dot(v, v));
                }
            }
            active.push(s);
        }
        const edges = new Map();
        for (const s of segments) {
            const cuts = [...new Set(s.cuts)].sort((a, b) => a - b);
            const at = t => coord([s.a[0] + (s.b[0] - s.a[0]) * t, s.a[1] + (s.b[1] - s.a[1]) * t]);
            for (let i = 1; i < cuts.length; i++) {
                const a = at(cuts[i - 1]), b = at(cuts[i]);
                if (key(a) === key(b)) continue;
                const id = edgeKey(a, b);
                if (!edges.has(id)) edges.set(id, turf.lineString([a, b], { names: [] }));
                if (s.name && !edges.get(id).properties.names.includes(s.name)) edges.get(id).properties.names.push(s.name);
            }
        }
        return edges;
    }

    function ringKey(ring) {
        // Road way splits or overlaps can insert extra collinear vertices without changing the
        // block. Ignore those in its identity, while retaining them in geometry and street names.
        const open = ring.slice(0, -1);
        const points = open.filter((p, i) => {
            const before = sub(p, open[(i - 1 + open.length) % open.length]);
            const after = sub(open[(i + 1) % open.length], p);
            return Math.abs(cross(before, after)) > 1e-18 || dot(before, after) < 0;
        }).map(key);
        const min = points.reduce((best, p, i) => p < points[best] ? i : best, 0);
        const forward = points.map((_, i) => points[(min + i) % points.length]).join('|');
        const reverse = points.map((_, i) => points[(min - i + points.length) % points.length]).join('|');
        return forward < reverse ? forward : reverse;
    }

    function hash(text) {
        let value = 2166136261;
        for (let i = 0; i < text.length; i++) value = Math.imul(value ^ text.charCodeAt(i), 16777619);
        return (value >>> 0).toString(16);
    }

    function metrics(block, turf) {
        const areaM2 = turf.area(block);
        const perimeterM = turf.length(turf.lineString(block.geometry.coordinates[0]), { units: 'meters' });
        return { areaM2, perimeterM, walkMinutes: perimeterM / (5000 / 60),
            compactness: 4 * Math.PI * areaM2 / (perimeterM * perimeterM) };
    }

    function detectBlocks(roads, bbox, turf) {
        if (roads?.partial || roads?.truncated) throw new Error('OSM road data is incomplete. Retry or zoom in before detecting blocks.');
        if (!Array.isArray(roads?.features)) throw new Error('Invalid OSM road data.');
        const edges = nodeRoads(roads, bbox, turf);
        if (!edges.size) return turf.featureCollection([]);
        const faces = turf.polygonize(turf.featureCollection([...edges.values()]));
        // Turf 6 emits disconnected nested loops as overlapping shells. Turn each immediate
        // child shell into a hole in its parent so a roundabout/island never paints twice.
        const shells = new Map();
        for (const face of faces.features) {
            const ring = face.geometry.coordinates[0];
            shells.set(ringKey(ring), turf.polygon([ring]));
        }
        const polygons = [...shells.values()];
        const sizes = polygons.map(p => turf.area(p));
        polygons.forEach((child, i) => {
            let parent = -1;
            polygons.forEach((candidate, j) => {
                if (sizes[j] <= sizes[i] || (parent !== -1 && sizes[j] >= sizes[parent])) return;
                if (turf.booleanPointInPolygon(turf.point(child.geometry.coordinates[0][0]),
                    turf.polygon([candidate.geometry.coordinates[0]]), { ignoreBoundary: true })) parent = j;
            });
            if (parent !== -1) polygons[parent].geometry.coordinates.push(child.geometry.coordinates[0].slice().reverse());
        });
        const seen = new Set();
        const blocks = [];
        for (const face of polygons) {
            // Never manufacture a closed block along the request boundary. The padded request
            // makes most on-screen blocks complete; open or cut-off blocks simply stay unshaded.
            if (face.geometry.coordinates.some(ring => ring.some(([x, y]) =>
                x <= bbox[0] + 1e-8 || y <= bbox[1] + 1e-8 || x >= bbox[2] - 1e-8 || y >= bbox[3] - 1e-8))) continue;
            const shapeKey = face.geometry.coordinates.map(ringKey).sort().join('/');
            if (seen.has(shapeKey)) continue;
            seen.add(shapeKey);
            const measurement = metrics(face, turf);
            if (measurement.areaM2 < 20) continue;
            const names = new Set();
            for (const ring of face.geometry.coordinates) for (let i = 1; i < ring.length; i++) {
                for (const name of edges.get(edgeKey(ring[i - 1], ring[i]))?.properties.names || []) names.add(name);
            }
            face.id = `osm-block-${hash(shapeKey)}`;
            face.properties = { ...measurement, color: COLORS[parseInt(hash(shapeKey), 16) % COLORS.length],
                streets: [...names].sort(), source: 'osm-road-centrelines' };
            blocks.push(face);
        }
        // Give adjacent faces distinct colours. The canonical ID order makes this independent
        // of OSM way order, while retaining a stable initial palette choice for isolated blocks.
        const owners = new Map(), neighbours = new Map(blocks.map(block => [block.id, new Set()]));
        for (const block of blocks) for (const ring of block.geometry.coordinates) for (let i = 1; i < ring.length; i++) {
            const edge = edgeKey(ring[i - 1], ring[i]);
            const previous = owners.get(edge);
            if (previous) { neighbours.get(block.id).add(previous); neighbours.get(previous).add(block.id); }
            owners.set(edge, block.id);
        }
        const painted = new Map();
        for (const block of blocks.slice().sort((a, b) => a.id.localeCompare(b.id))) {
            const unavailable = new Set([...neighbours.get(block.id)].map(id => painted.get(id)));
            const start = COLORS.indexOf(block.properties.color);
            block.properties.color = COLORS.map((_, i) => COLORS[(start + i) % COLORS.length]).find(c => !unavailable.has(c)) || COLORS[start];
            painted.set(block.id, block.properties.color);
        }
        return turf.featureCollection(blocks);
    }

    // This is a count of LOADED cadastral parcels whose representative point is inside the block,
    // not a claim that the entire cadastre is present. A spanning parcel belongs to one block.
    function loadedParcelCount(block, parcels, turf) {
        if (!Array.isArray(parcels) || !parcels.length) return null;
        const ids = new Set();
        for (const parcel of parcels) {
            if (!['Polygon', 'MultiPolygon'].includes(parcel.geometry?.type)) continue;
            const id = parcel.properties?.parcelId ?? parcel.properties?.parcel_id ?? parcel.properties?.PARCEL_ID ?? parcel.properties?.id ?? parcel.id;
            if (id == null || ids.has(String(id))) continue;
            if (turf.booleanPointInPolygon(turf.pointOnFeature(parcel), block, { ignoreBoundary: true })) ids.add(String(id));
        }
        return ids.size;
    }

    // Include spanning parcels too: SVG clipping shows only their borders inside this block.
    // Input comes from the immutable cadastral repository, never from proposal geometry.
    function parcelsInBlock(block, parcels, turf) {
        const bbox = turf.bbox(block);
        return turf.featureCollection((parcels || []).filter(parcel => {
            if (!['Polygon', 'MultiPolygon'].includes(parcel.geometry?.type)) return false;
            const extent = turf.bbox(parcel);
            return extent[0] <= bbox[2] && extent[2] >= bbox[0] && extent[1] <= bbox[3] && extent[3] >= bbox[1]
                && turf.booleanIntersects(parcel, block);
        }));
    }

    // A transparent area scenario, not a subdivision design: new streets and irregular shapes
    // will change the result. Keep at least one block and round up to meet the target area.
    function targetBlockCount(areaM2, targetSideM = 100) {
        if (!Number.isFinite(areaM2) || areaM2 <= 0 || !Number.isFinite(targetSideM) || targetSideM <= 0) return null;
        return Math.max(1, Math.ceil(areaM2 / (targetSideM * targetSideM)));
    }

    // Rank the complete loaded enclosures without mutating the detection result. Raw perimeter
    // decides the order (and therefore walking time at a fixed speed); IDs break exact ties.
    function rankBlocks(features) {
        return features.slice().sort((a, b) => b.properties.perimeterM - a.properties.perimeterM || a.id.localeCompare(b.id));
    }

    function walkBand(minutes, thresholdMinutes) {
        return minutes > thresholdMinutes ? 'over' : 'within';
    }

    function blockColor(feature, colorBy, thresholdMinutes) {
        return colorBy === 'walk' ? WALK_COLORS[walkBand(feature.properties.walkMinutes, thresholdMinutes)] : feature.properties.color;
    }

    return { detectBlocks, nodeRoads, metrics, loadedParcelCount, parcelsInBlock, isGroundRoad, isRoadArea, targetBlockCount,
        rankBlocks, walkBand, blockColor, WALK_COLORS };
});
