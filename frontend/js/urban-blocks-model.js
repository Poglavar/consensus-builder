// Pure road-to-block geometry and metrics. Shared by the worker and headless tests; no map,
// parcels, DOM or city-specific projection is required. Turf is supplied by the caller.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.UrbanBlocksModel = api;
})(typeof self !== 'undefined' ? self : null, function () {
    'use strict';
    const isPresent = value => value != null && String(value).trim() !== ''
        && !['no', 'false', '0'].includes(String(value).trim().toLowerCase());
    const COLORS = ['#ea9575', '#65b8a6', '#9c97ce', '#e4bc58', '#76a8cf', '#ce86ae', '#a0ba68', '#dd9e55'];
    const WALK_COLORS = Object.freeze({ within: '#0e7490', over: '#d97706' });
    const coord = p => p.map(v => Math.round(v * 1e9) / 1e9);
    const key = p => p.join(',');
    const edgeKey = (a, b) => [key(a), key(b)].sort().join('|');
    const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
    const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
    // railway=* also describes facilities. A workshop, station or platform outline is not
    // a track centreline and must not cut a building parcel out of its surrounding block.
    const RAIL_BOUNDARIES = new Set(['rail', 'tram', 'light_rail', 'subway', 'narrow_gauge',
        'monorail', 'funicular', 'miniature', 'preserved', 'disused', 'abandoned', 'construction']);

    function isGroundRoad(properties = {}) {
        const layer = Number(properties.layer || 0);
        return (isPresent(properties.highway) || isPresent(properties.highway_type))
            && !isPresent(properties.bridge) && !isPresent(properties.tunnel)
            && Number.isFinite(layer) && layer === 0 && properties.location !== 'underground';
    }

    function isRoadTrackBoundary(properties = {}) {
        return isGroundBoundary(properties) && (isGroundRoad(properties)
            || RAIL_BOUNDARIES.has(properties.railway) || RAIL_BOUNDARIES.has(properties.railway_type)
            || properties.isRoad === true || properties.isTrack === true || properties.isCorridor === true);
    }

    // Ways that run across ordinary lots without taking them: a sidewalk mapped beside the street,
    // a driveway or parking aisle, a footpath through a courtyard. They still bound blocks, but a lot
    // they touch is not street ground.
    // Pedestrian ways do not bound a block either: a separately mapped sidewalk often runs through the
    // front of the lots the cadastre records, and would cut them out of their own block.
    const PEDESTRIAN_WAYS = new Set(['footway', 'path', 'steps', 'cycleway', 'bridleway', 'corridor',
        'platform', 'elevator', 'sidewalk', 'crossing']);
    const MINOR_WAYS = new Set([...PEDESTRIAN_WAYS, 'track', 'service', 'proposed']);

    // A lot an OSM street or track line touches is street ground and stays out of a block.
    function parcelTouchesRoadTrack(parcel, boundaries, turf) {
        const a = turf.bbox(parcel);
        return boundaries.some(feature => {
            if (!isRoadTrackBoundary(feature.properties)) return false;
            const highway = feature.properties.highway || feature.properties.highway_type;
            if (MINOR_WAYS.has(highway)) return false;
            const b = feature.bbox || turf.bbox(feature);
            return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1]
                && turf.booleanIntersects(parcel, feature);
        });
    }

    // Any mapped transport or water edge can bound land. Bridges, tunnels and non-ground layers
    // do not enclose ground parcels.
    function isGroundBoundary(properties = {}) {
        const layer = Number(properties.layer || 0);
        const mappedBoundary = isPresent(properties.highway) || isPresent(properties.highway_type)
            || RAIL_BOUNDARIES.has(properties.railway) || RAIL_BOUNDARIES.has(properties.railway_type)
            || isPresent(properties.waterway) || isPresent(properties.waterway_type)
            || ['coastline', 'water'].includes(properties.natural)
            || properties.isRoad === true || properties.isTrack === true || properties.isCorridor === true;
        return mappedBoundary && !isPresent(properties.bridge) && !isPresent(properties.tunnel)
            && Number.isFinite(layer) && layer === 0 && properties.location !== 'underground';
    }

    function isRoadArea(properties = {}) {
        return ['yes', 'true', '1'].includes(String(properties.area));
    }

    function waterBodies(roads, turf) {
        const bodies = [];
        for (const feature of roads.features) {
            const properties = feature.properties || {};
            if (!(properties.natural === 'water' || properties.waterway === 'riverbank'
                || properties.waterway_type === 'riverbank') || !isGroundBoundary(properties)) continue;
            const geometry = feature.geometry;
            if (geometry?.type === 'Polygon') bodies.push(turf.feature(geometry, properties));
            else if (geometry?.type === 'MultiPolygon') {
                geometry.coordinates.forEach(coordinates => bodies.push(turf.polygon(coordinates, properties)));
            } else {
                const lines = geometry?.type === 'LineString' ? [geometry.coordinates]
                    : geometry?.type === 'MultiLineString' ? geometry.coordinates : [];
                for (const ring of lines) {
                    if (!Array.isArray(ring) || ring.length < 4 || key(coord(ring[0])) !== key(coord(ring[ring.length - 1]))) continue;
                    bodies.push(turf.polygon([ring], properties));
                }
            }
        }
        return bodies;
    }

    // Find a strictly interior point for polygon faces, including faces with holes whose centroid
    // falls in the hole. Scanlines between vertex latitudes yield points inside the filled rings.
    function interiorPoint(feature, turf) {
        const rings = feature.geometry?.type === 'Polygon' ? feature.geometry.coordinates : [];
        const latitudes = [...new Set(rings.flatMap(ring => ring.map(point => point[1])))].sort((a, b) => a - b);
        const scanlines = latitudes.slice(1).map((y, i) => (latitudes[i] + y) / 2);
        for (const y of scanlines) {
            const crossings = [];
            for (const ring of rings) for (let i = 1; i < ring.length; i++) {
                const a = ring[i - 1], b = ring[i];
                if ((a[1] > y) === (b[1] > y)) continue;
                crossings.push(a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
            }
            crossings.sort((a, b) => a - b);
            for (let i = 1; i < crossings.length; i += 2) {
                const point = turf.point([(crossings[i - 1] + crossings[i]) / 2, y]);
                if (turf.booleanPointInPolygon(point, feature, { ignoreBoundary: true })) return point;
            }
        }
        return null;
    }

    // An applied proposal's centreline as ground street lines of [lng, lat]: points carrying a level
    // other than 0 are on a bridge or in a tunnel, so they break the line like OSM's bridge=yes does.
    function groundRuns(centreline) {
        const runs = [];
        let run = [];
        for (const point of centreline || []) {
            const ground = !(typeof point?.level === 'number' && Number.isFinite(point.level) && point.level !== 0);
            if (ground && Number.isFinite(point?.lat) && Number.isFinite(point?.lng)) run.push([point.lng, point.lat]);
            else { if (run.length >= 2) runs.push(run); run = []; }
        }
        if (run.length >= 2) runs.push(run);
        return runs;
    }

    // Applied proposed streets join the road network. A street end within SNAP_M of a road moves onto
    // it and becomes a vertex of that road as well, so noding finds one shared node instead of an end
    // stopping a fraction of a millimetre short of the centreline, which would leave the block whole.
    const SNAP_M = 1;
    function withProposedStreets(roads, streets) {
        if (!Array.isArray(streets) || !streets.length) return roads;
        const features = roads.features.slice();
        const lines = [];
        features.forEach((road, owner) => {
            if (!isGroundBoundary(road.properties)) return;
            const type = road.geometry?.type;
            const parts = type === 'LineString' ? [road.geometry.coordinates] : type === 'MultiLineString' ? road.geometry.coordinates : [];
            parts.forEach((coords, part) => lines.push({ owner, part, coords: coords.slice() }));
        });
        const proposedFrom = lines.length;
        streets.forEach(coords => {
            if (!Array.isArray(coords) || coords.length < 2) return;
            features.push({ type: 'Feature', properties: { highway: 'residential', proposed: true },
                geometry: { type: 'LineString', coordinates: coords } });
            lines.push({ owner: features.length - 1, part: 0, coords: coords.map(p => p.slice()) });
        });
        const inserts = lines.map(() => []), junctions = [];
        for (let i = proposedFrom; i < lines.length; i++) {
            for (const end of [0, lines[i].coords.length - 1]) {
                const p = lines[i].coords[end];
                const kx = 111320 * Math.cos(p[1] * Math.PI / 180), ky = 111320;
                let best = null;
                lines.forEach((host, h) => {
                    if (h === i) return;
                    for (let k = 1; k < host.coords.length; k++) {
                        const a = host.coords[k - 1], b = host.coords[k];
                        const dx = (b[0] - a[0]) * kx, dy = (b[1] - a[1]) * ky;
                        const length2 = dx * dx + dy * dy;
                        if (!length2) continue;
                        const t = Math.max(0, Math.min(1, (((p[0] - a[0]) * kx) * dx + ((p[1] - a[1]) * ky) * dy) / length2));
                        const distance = Math.hypot((a[0] - p[0]) * kx + t * dx, (a[1] - p[1]) * ky + t * dy);
                        if (distance <= SNAP_M && (!best || distance < best.distance)) best = { distance, h, k, t, a, b };
                    }
                });
                if (!best) continue;
                const { h, k, t, a, b } = best;
                const at = t === 0 ? a : t === 1 ? b : [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
                lines[i].coords[end] = at;
                if (t > 0 && t < 1) { inserts[h].push({ k, t, at }); junctions.push(at); }
            }
        }
        inserts.forEach((list, h) => {
            if (!list.length) return;
            const line = lines[h];
            list.sort((x, y) => x.k - y.k || x.t - y.t);
            const coords = [];
            line.coords.forEach((point, k) => {
                for (const item of list) if (item.k === k) coords.push(item.at);
                coords.push(point);
            });
            line.coords = coords;
        });
        // Only roads that gained a junction vertex, and the proposed streets themselves, change.
        const touched = new Set(lines.filter((line, h) => h >= proposedFrom || inserts[h].length).map(line => line.owner));
        const rebuilt = new Map();
        for (const line of lines) {
            if (!touched.has(line.owner)) continue;
            if (!rebuilt.has(line.owner)) rebuilt.set(line.owner, []);
            rebuilt.get(line.owner)[line.part] = line.coords;
        }
        for (const [owner, parts] of rebuilt) {
            const road = features[owner];
            const geometry = road.geometry.type === 'LineString'
                ? { type: 'LineString', coordinates: parts[0] }
                : { type: 'MultiLineString', coordinates: road.geometry.coordinates.map((coords, part) => parts[part] || coords) };
            features[owner] = { ...road, geometry };
        }
        return { ...roads, features, junctions };
    }

    // Noding is necessary before polygonize: a crossing inside either segment must become a
    // shared endpoint. Also split collinear overlaps, then deduplicate the undirected edges.
    // A street that stops this close to another way is mapped short of a crossing it cannot make (a
    // busway, a fence, a pedestrian link), not a cul-de-sac inside a block. Its ground still divides
    // the blocks on either side, so for block enclosures (detectBlocks) its end is carried on to that
    // way. Subdivision candidates keep the mapped network as it is.
    const DEAD_END_REACH_M = 10;
    const TIP_TOUCH_M = 0.05;

    // Segments carrying each dead-end street tip along its last segment to the first way within reach.
    function deadEndLinks(segments, tips, bbox) {
        if (!tips.length) return [];
        const CELL = 0.0002;
        const cell = v => Math.floor(v / CELL);
        const grid = new Map();
        segments.forEach((s, index) => {
            for (let x = cell(Math.min(s.a[0], s.b[0])); x <= cell(Math.max(s.a[0], s.b[0])); x++) {
                for (let y = cell(Math.min(s.a[1], s.b[1])); y <= cell(Math.max(s.a[1], s.b[1])); y++) {
                    const id = `${x},${y}`;
                    if (!grid.has(id)) grid.set(id, []);
                    grid.get(id).push(index);
                }
            }
        });
        const near = (box) => {
            const found = new Set();
            for (let x = cell(box[0]); x <= cell(box[2]); x++) for (let y = cell(box[1]); y <= cell(box[3]); y++) {
                (grid.get(`${x},${y}`) || []).forEach(index => found.add(index));
            }
            return [...found].map(index => segments[index]);
        };
        const onEdge = p => p[0] <= bbox[0] + 1e-8 || p[1] <= bbox[1] + 1e-8 || p[0] >= bbox[2] - 1e-8 || p[1] >= bbox[3] - 1e-8;
        const links = [];
        for (const { tip, from, own } of tips) {
            if (onEdge(tip)) continue;
            const mx = 111320 * Math.cos(tip[1] * Math.PI / 180), my = 110540;
            const metric = p => [(p[0] - tip[0]) * mx, (p[1] - tip[1]) * my];
            const reach = DEAD_END_REACH_M / Math.min(mx, my);
            const candidates = near([tip[0] - reach, tip[1] - reach, tip[0] + reach, tip[1] + reach]).filter(s => s !== own);
            const touched = candidates.some(s => {
                const a = metric(s.a), ab = sub(metric(s.b), a);
                const t = Math.max(0, Math.min(1, -dot(a, ab) / dot(ab, ab)));
                return Math.hypot(a[0] + ab[0] * t, a[1] + ab[1] * t) <= TIP_TOUCH_M;
            });
            if (touched) continue;
            const back = metric(from), length = Math.hypot(...back);
            if (!(length > 0)) continue;
            const r = [-back[0] / length * DEAD_END_REACH_M, -back[1] / length * DEAD_END_REACH_M];
            let best = null;
            for (const s of candidates) {
                const a = metric(s.a), v = sub(metric(s.b), a);
                const denominator = cross(r, v);
                if (Math.abs(denominator) < 1e-12) continue;
                const u = cross(a, v) / denominator, w = cross(a, r) / denominator;
                if (u > 0 && u <= 1 && w >= 0 && w <= 1 && (!best || u < best)) best = u;
            }
            if (best !== null) {
                links.push({ a: tip, b: coord([tip[0] + r[0] * best / mx, tip[1] + r[1] * best / my]), name: null, proposed: false, cuts: [0, 1] });
            }
        }
        return links;
    }

    // enclosure: the network that bounds blocks (detectBlocks): no pedestrian ways, dead ends closed.
    function nodeRoads(roads, bbox, turf, { enclosure = false } = {}) {
        const segments = [];
        const tips = [];
        for (const road of roads.features) {
            if (!isGroundBoundary(road.properties)) continue;
            const highway = road.properties?.highway || road.properties?.highway_type;
            if (enclosure && PEDESTRIAN_WAYS.has(highway)) continue;
            const type = road.geometry?.type;
            if (!['LineString', 'MultiLineString', 'Polygon', 'MultiPolygon'].includes(type)) continue;
            const clipped = turf.bboxClip(road, bbox);
            const lines = clipped.geometry.type === 'LineString' ? [clipped.geometry.coordinates]
                : clipped.geometry.type === 'MultiLineString' ? clipped.geometry.coordinates
                    : clipped.geometry.type === 'Polygon' ? clipped.geometry.coordinates
                        : clipped.geometry.type === 'MultiPolygon' ? clipped.geometry.coordinates.flat() : [];
            const street = type.endsWith('LineString') && isGroundRoad(road.properties) && !MINOR_WAYS.has(highway);
            for (const line of lines) {
                const first = segments.length;
                for (let i = 1; i < line.length; i++) {
                    const a = coord(line[i - 1]), b = coord(line[i]);
                    if (key(a) === key(b)) continue;
                    segments.push({ a, b, name: road.properties?.name, proposed: road.properties?.proposed === true, cuts: [0, 1] });
                }
                if (street && segments.length > first) {
                    const head = segments[first], tail = segments[segments.length - 1];
                    tips.push({ tip: head.a, from: head.b, own: head }, { tip: tail.b, from: tail.a, own: tail });
                }
            }
        }
        if (segments.length > 50000) throw new Error('Too many road segments. Zoom in and try again.');
        if (enclosure) segments.push(...deadEndLinks(segments, tips, bbox));
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
                if (!edges.has(id)) edges.set(id, turf.lineString([a, b], { names: [], proposed: false }));
                if (s.proposed) edges.get(id).properties.proposed = true;
                if (s.name && !edges.get(id).properties.names.includes(s.name)) edges.get(id).properties.names.push(s.name);
            }
        }
        return edges;
    }

    function ringKey(ring, junctions = new Set()) {
        // Road way splits or overlaps can insert extra collinear vertices without changing the
        // block. Ignore those in its identity, while retaining them in geometry and street names.
        // A proposed street's junction lies on its road only to rounding, so the block across that
        // road, which it passes straight through, keeps its identity within a centimetre (~1e-7°).
        const open = ring.slice(0, -1);
        const points = open.filter((p, i) => {
            const before = sub(p, open[(i - 1 + open.length) % open.length]);
            const after = sub(open[(i + 1) % open.length], p);
            const chord = Math.hypot(...sub(open[(i + 1) % open.length], open[(i - 1 + open.length) % open.length]));
            const tolerance = junctions.has(key(p)) ? 1e-7 * chord : 1e-18;
            return Math.abs(cross(before, after)) > tolerance || dot(before, after) < 0;
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
        const edges = nodeRoads(roads, bbox, turf, { enclosure: true });
        if (!edges.size) return turf.featureCollection([]);
        const water = waterBodies(roads, turf);
        const junctions = new Set((roads.junctions || []).map(p => key(coord(p))));
        const faces = turf.polygonize(turf.featureCollection([...edges.values()]));
        // Turf 6 emits disconnected nested loops as overlapping shells. Turn each immediate
        // child shell into a hole in its parent so a roundabout/island never paints twice.
        const shells = new Map();
        for (const face of faces.features) {
            const ring = face.geometry.coordinates[0];
            shells.set(ringKey(ring, junctions), turf.polygon([ring]));
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
            // Water surfaces contribute their shore rings to polygonization, but their interiors
            // are not selectable blocks. Polygon holes remain land; coastline loops are omitted
            // from this mask because they may enclose islands rather than water.
            const point = interiorPoint(face, turf);
            if (point && water.some(body => turf.booleanPointInPolygon(point, body, { ignoreBoundary: true }))) continue;
            // Never manufacture a closed block along the request boundary. The padded request
            // makes most on-screen blocks complete; open or cut-off blocks simply stay unshaded.
            if (face.geometry.coordinates.some(ring => ring.some(([x, y]) =>
                x <= bbox[0] + 1e-8 || y <= bbox[1] + 1e-8 || x >= bbox[2] - 1e-8 || y >= bbox[3] - 1e-8))) continue;
            const shapeKey = face.geometry.coordinates.map(ring => ringKey(ring, junctions)).sort().join('/');
            if (seen.has(shapeKey)) continue;
            seen.add(shapeKey);
            const measurement = metrics(face, turf);
            if (measurement.areaM2 < 20) continue;
            const names = new Set();
            let proposedStreets = false;
            for (const ring of face.geometry.coordinates) for (let i = 1; i < ring.length; i++) {
                const edge = edges.get(edgeKey(ring[i - 1], ring[i]));
                for (const name of edge?.properties.names || []) names.add(name);
                if (edge?.properties.proposed) proposedStreets = true;
            }
            face.id = `osm-block-${hash(shapeKey)}`;
            face.properties = { ...measurement, color: COLORS[parseInt(hash(shapeKey), 16) % COLORS.length],
                streets: [...names].sort(), proposedStreets, source: 'osm-road-centrelines' };
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

    function coversParcel(container, parcel, turf) {
        const a = turf.bbox(container), b = turf.bbox(parcel);
        if (b[0] < a[0] || b[1] < a[1] || b[2] > a[2] || b[3] > a[3]) return false;
        return turf.difference(parcel, container) === null;
    }

    // Whole geometry decides membership. A rejected enclosing parcel also excludes the parcels
    // inside its holes or outline; they cannot be reached through border ground.
    function parcelIdsInBlock(block, parcels, turf, excluded = () => false) {
        const ids = new Set();
        const polygons = (Array.isArray(parcels) ? parcels : [])
            .filter(parcel => ['Polygon', 'MultiPolygon'].includes(parcel.geometry?.type));
        const rejected = polygons.filter(parcel => excluded(parcel) || !coversParcel(block, parcel, turf));
        const shells = rejected.map(parcel => ({ parcel, shell: turf.feature({ type: parcel.geometry.type,
            coordinates: parcel.geometry.type === 'Polygon' ? [parcel.geometry.coordinates[0]]
                : parcel.geometry.coordinates.map(rings => [rings[0]]) }) }));
        for (const parcel of polygons) {
            if (rejected.includes(parcel) || shells.some(({ parcel: parent, shell }) =>
                parent !== parcel && coversParcel(shell, parcel, turf))) continue;
            const id = parcel.properties?.parcelId ?? parcel.properties?.parcel_id ?? parcel.properties?.PARCEL_ID ?? parcel.properties?.id ?? parcel.id;
            if (id == null || ids.has(String(id))) continue;
            ids.add(String(id));
        }
        return [...ids];
    }

    function loadedParcelCount(block, parcels, turf) {
        if (!Array.isArray(parcels) || !parcels.length) return null;
        return parcelIdsInBlock(block, parcels, turf).length;
    }

    // A seed must fit wholly inside exactly one enclosure, including all disconnected pieces.
    function enclosureForParcel(blocks, seed, turf) {
        if (!seed || !['Polygon', 'MultiPolygon'].includes(seed.geometry?.type)
            || !Array.isArray(blocks?.features)) return null;
        const matches = blocks.features.filter(block => coversParcel(block, seed, turf));
        return matches.length === 1 ? matches[0] : null;
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

    return { detectBlocks, nodeRoads, groundRuns, withProposedStreets, metrics, loadedParcelCount, parcelIdsInBlock,
        enclosureForParcel, isGroundRoad, isGroundBoundary, isRoadTrackBoundary, parcelTouchesRoadTrack, isRoadArea, targetBlockCount,
        rankBlocks, walkBand, blockColor, WALK_COLORS };
});
