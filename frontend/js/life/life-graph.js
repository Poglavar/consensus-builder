// Life graph: what the schematic vehicles drive along and what the walkable surface is painted
// from, for the 3D model view. Pure geometry/data, no DOM, no THREE. Works in TRUE metres (x east,
// y north, z up) in whatever local frame the caller provides; the caller projects lat/lng into it.
// Inputs are applied corridor lanes, OSM road features (/osm-road rows or Overpass ways), park
// paths and plaza polygons. Output: directed drive `tracks` joined through snapped node ids, the
// `surface` paint lists (carriageways, preferred walking bands and fills) that life-surface.js
// rasterises, and `areas`. See 3d-life.md.
(function (root, factory) {
    if (typeof module !== 'undefined' && module.exports) module.exports = factory();
    else root.__lifeGraph = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const NODE_SNAP_M = 0.5;          // vertices closer than this are one node (Station3D uses the same)
    const LANE_WIDTH_M = 3.5;         // default OSM lane width
    const SIDEWALK_DEPTH_M = 4.5;     // walking band beyond the carriageway edge of a street
    const LOOSE_END_SNAP_M = 8;       // a corridor end this close to an OSM node joins the network
    const MITRE_LIMIT = 4;            // offset joints sharper than this fall back to a bevel
    const ZCODE = { GROUND: 0, PLAZA: 1, PATH: 2, KERB: 3 };

    // Driveable OSM classes and a calm schematic cruise speed (m/s) for each. Station3D uses 8–22;
    // these are a little slower so a scene at 300 m reads as traffic, not as a race.
    const DRIVE_CLASSES = {
        motorway: 24, motorway_link: 14, trunk: 20, trunk_link: 12, primary: 15, primary_link: 10,
        secondary: 13, secondary_link: 10, tertiary: 11, tertiary_link: 9, unclassified: 9, residential: 8
    };
    // Streets whose sidewalk band carries people unless OSM says otherwise.
    const SIDEWALK_CLASSES = new Set(['primary', 'secondary', 'tertiary', 'unclassified', 'residential']);
    // Ways that ARE walking space.
    const FOOT_CLASSES = new Set(['footway', 'path', 'pedestrian', 'steps', 'living_street', 'track', 'cycleway']);
    const CORRIDOR_SPEED = { driving: 11, bus: 10 };
    const CORRIDOR_CARRIAGEWAY_TYPES = new Set(['driving', 'bus', 'parking', 'parking_perpendicular', 'parking_angled', 'rail']);

    function dist(a, b) { return Math.hypot(b[0] - a[0], b[1] - a[1]); }

    function nodeKey(x, y) {
        return Math.round(x / NODE_SNAP_M) + ':' + Math.round(y / NODE_SNAP_M);
    }

    // Drop consecutive duplicates (within 1 cm) so offsets and lengths never divide by zero.
    function dedupe(points) {
        const out = [];
        for (const p of points) {
            if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
            const last = out[out.length - 1];
            if (last && Math.hypot(p[0] - last[0], p[1] - last[1]) < 0.01) continue;
            out.push([p[0], p[1], Number.isFinite(p[2]) ? p[2] : 0]);
        }
        return out;
    }

    // Parallel offset of a polyline by a signed distance, positive to the LEFT of travel. Mitred
    // joints with a bevel fallback at near-reversals; good enough for lane centres a few metres out.
    function offsetPolyline(points, offset) {
        if (!Array.isArray(points) || points.length < 2) return null;
        if (!offset) return points.map(p => p.slice());
        const normals = [];
        for (let i = 0; i < points.length - 1; i++) {
            const dx = points[i + 1][0] - points[i][0];
            const dy = points[i + 1][1] - points[i][1];
            const len = Math.hypot(dx, dy) || 1;
            normals.push([-dy / len, dx / len]);
        }
        const out = [];
        for (let i = 0; i < points.length; i++) {
            const p = points[i];
            let nx, ny;
            if (i === 0) { [nx, ny] = normals[0]; }
            else if (i === points.length - 1) { [nx, ny] = normals[normals.length - 1]; }
            else {
                const a = normals[i - 1], b = normals[i];
                nx = a[0] + b[0]; ny = a[1] + b[1];
                const len = Math.hypot(nx, ny);
                if (len < 1e-6) { nx = a[0]; ny = a[1]; }
                else {
                    nx /= len; ny /= len;
                    // Mitre length grows as 1/cos(half-angle); cap it so hairpins don't shoot off.
                    const cosHalf = Math.max(1e-6, nx * a[0] + ny * a[1]);
                    const scale = Math.min(1 / cosHalf, MITRE_LIMIT);
                    nx *= scale; ny *= scale;
                }
            }
            out.push([p[0] + nx * offset, p[1] + ny * offset, p[2] || 0]);
        }
        return out;
    }

    function polylineLength(points) {
        let len = 0;
        for (let i = 1; i < points.length; i++) len += dist(points[i - 1], points[i]);
        return len;
    }

    function ringArea(ring) {
        let area = 0;
        for (let i = 0, n = ring.length; i < n; i++) {
            const a = ring[i], b = ring[(i + 1) % n];
            area += a[0] * b[1] - b[0] * a[1];
        }
        return Math.abs(area) / 2;
    }

    function pointInRing(x, y, ring) {
        let inside = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
            const crosses = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-12) + xi);
            if (crosses) inside = !inside;
        }
        return inside;
    }

    function parseOneway(tags) {
        const raw = tags && tags.oneway != null ? String(tags.oneway).trim().toLowerCase() : '';
        if (raw === 'yes' || raw === '1' || raw === 'true') return 1;
        if (raw === '-1' || raw === 'reverse') return -1;
        if (tags && String(tags.junction || '').toLowerCase() === 'roundabout') return 1;
        return 0;
    }

    function parseCount(value) {
        const n = parseInt(value, 10);
        return Number.isFinite(n) && n > 0 ? n : null;
    }

    function parseWidth(value) {
        const n = parseFloat(value);
        return Number.isFinite(n) && n > 0 ? n : null;
    }

    // Which sides of a street carry a sidewalk band: `separate` means OSM maps it as its own
    // footway (already walking space), so nothing is added for it here.
    function sidewalkSides(tags) {
        const t = tags || {};
        const main = String(t.sidewalk || '').toLowerCase();
        if (main === 'separate' || main === 'no' || main === 'none') return { left: false, right: false };
        const sideOf = value => {
            const v = String(value || '').toLowerCase();
            if (!v) return null;
            return !(v === 'no' || v === 'none' || v === 'separate');
        };
        const left = sideOf(t['sidewalk:left']);
        const right = sideOf(t['sidewalk:right']);
        if (main === 'left') return { left: true, right: right === true };
        if (main === 'right') return { left: left === true, right: true };
        return { left: left !== false, right: right !== false };
    }

    function isClosedRing(coords) {
        if (!Array.isArray(coords) || coords.length < 4) return false;
        const a = coords[0], b = coords[coords.length - 1];
        return Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
    }

    function createGraphBuilder() {
        const ways = [];       // { id, points, lanes:[{offset, dir, speed, kind}], carriageway:{offset, halfWidth}|null, bands:[{offset, halfWidth, zcode}], source }
        const areas = [];
        const fills = [];      // preferred walking polygons: { rings, zcode, kind }
        const blocked = [];    // structure footprints and obstacles people never enter
        let nextTrackId = 0;

        function addWay(way) {
            const points = dedupe(way.points);
            if (points.length < 2) return;
            ways.push({ lanes: [], bands: [], carriageway: null, ...way, points });
        }

        // An applied corridor: `segments` of centreline points (true metres, already in the local
        // frame) with that segment's lane spans ({type, direction, left, right}, positive left of the
        // drawing direction; the right kerb carries forward traffic). `zAt(x, y)` supplies the
        // surface height (grade separations); flat corridors pass none.
        function addCorridor(corridor) {
            const zAt = typeof corridor.zAt === 'function' ? corridor.zAt : null;
            (corridor.segments || []).forEach((segment, index) => {
                const points = (segment.points || []).map(p => [p[0], p[1], zAt ? zAt(p[0], p[1]) : 0]);
                const lanes = [];
                const bands = [];
                let carriageLeft = -Infinity, carriageRight = Infinity;
                (segment.spans || []).forEach(span => {
                    const centre = (span.left + span.right) / 2;
                    if (span.type === 'driving' || span.type === 'bus') {
                        const dir = span.direction === 'backward' ? -1 : 1;
                        lanes.push({ offset: centre, dir, speed: CORRIDOR_SPEED[span.type], kind: span.type });
                    }
                    if (CORRIDOR_CARRIAGEWAY_TYPES.has(span.type)) {
                        carriageLeft = Math.max(carriageLeft, span.left);
                        carriageRight = Math.min(carriageRight, span.right);
                    } else {
                        // Sidewalks, verges, medians and cycle paths are walking space on the kerb.
                        bands.push({ offset: centre, halfWidth: Math.max(0.5, span.width / 2), zcode: ZCODE.KERB });
                    }
                });
                addWay({
                    points, lanes, bands, source: 'corridor', zLift: corridor.zLift || 0,
                    carriageway: carriageLeft > carriageRight
                        ? { offset: (carriageLeft + carriageRight) / 2, halfWidth: (carriageLeft - carriageRight) / 2 } : null,
                    id: (corridor.id || 'corridor') + ':' + (segment.id || index)
                });
            });
        }

        // GeoJSON features from /osm-road (osm_road rows) or converted Overpass ways.
        // `project(lng, lat)` → [x, y] true metres.
        function addOsmRoads(features, project) {
            (features || []).forEach(feature => {
                const props = (feature && feature.properties) || {};
                const tags = props.tags || {};
                const highway = String(props.highway_type || tags.highway || '');
                const geometry = feature && feature.geometry;
                if (!geometry) return;
                const lines = geometry.type === 'LineString' ? [geometry.coordinates]
                    : geometry.type === 'MultiLineString' ? geometry.coordinates
                        : geometry.type === 'Polygon' ? [geometry.coordinates[0]] : [];
                const width = parseWidth(props.width_meters) || parseWidth(tags.width);
                const isArea = String(tags.area || '').toLowerCase() === 'yes' || geometry.type === 'Polygon';
                lines.forEach(coords => {
                    const points = coords.map(c => project(c[0], c[1]));
                    if (DRIVE_CLASSES[highway] !== undefined) {
                        // OSM implies one-way on motorways and their ramps when the tag is absent.
                        const oneway = parseOneway(tags) || ((highway === 'motorway' || highway === 'motorway_link') && tags.oneway == null ? 1 : 0);
                        const total = parseCount(tags.lanes) || (oneway ? (highway === 'motorway' || highway === 'trunk' ? 2 : 1) : 2);
                        const laneWidth = width ? Math.min(LANE_WIDTH_M, width / total) : LANE_WIDTH_M;
                        const speed = DRIVE_CLASSES[highway];
                        const lanes = [];
                        if (oneway) {
                            for (let i = 0; i < total; i++) lanes.push({ offset: (i - (total - 1) / 2) * laneWidth, dir: oneway, speed, kind: 'driving' });
                        } else {
                            const forward = parseCount(tags['lanes:forward']) || Math.ceil(total / 2);
                            const backward = parseCount(tags['lanes:backward']) || Math.max(1, total - forward);
                            for (let i = 0; i < forward; i++) lanes.push({ offset: -(i + 0.5) * laneWidth, dir: 1, speed, kind: 'driving' });
                            for (let i = 0; i < backward; i++) lanes.push({ offset: (i + 0.5) * laneWidth, dir: -1, speed, kind: 'driving' });
                        }
                        // The carriageway reaches the outer edge of the outermost lane actually laid
                        // out (an odd two-way lane count puts lanes past lanes×width/2), or the
                        // mapped width when that is wider.
                        const laidOut = lanes.reduce((edge, lane) => Math.max(edge, Math.abs(lane.offset) + laneWidth / 2), 0);
                        const half = Math.max(laidOut, (width || 0) / 2);
                        const bands = [];
                        if (SIDEWALK_CLASSES.has(highway)) {
                            const sides = sidewalkSides(tags);
                            const bandHalf = SIDEWALK_DEPTH_M / 2;
                            if (sides.left) bands.push({ offset: half + bandHalf, halfWidth: bandHalf, zcode: ZCODE.GROUND });
                            if (sides.right) bands.push({ offset: -(half + bandHalf), halfWidth: bandHalf, zcode: ZCODE.GROUND });
                        }
                        addWay({ points, lanes, bands, carriageway: { offset: 0, halfWidth: half }, source: 'osm', id: 'osm:' + (props.osm_id || ways.length), highway });
                    } else if (FOOT_CLASSES.has(highway)) {
                        if (isArea && isClosedRing(coords)) {
                            fills.push({ rings: [points], zcode: ZCODE.GROUND, kind: 'pedestrian-area' });
                            return;
                        }
                        const bands = [{ offset: 0, halfWidth: Math.max(1.5, (width || 0) / 2), zcode: ZCODE.GROUND }];
                        const lanes = [];
                        if (highway === 'living_street') {
                            bands[0].halfWidth = Math.max(3, (width || 6) / 2);
                            lanes.push({ offset: -1.5, dir: 1, speed: 5, kind: 'driving' });
                            lanes.push({ offset: 1.5, dir: -1, speed: 5, kind: 'driving' });
                        }
                        addWay({ points, lanes, bands, carriageway: null, source: 'osm', id: 'osm:' + (props.osm_id || ways.length), highway });
                    }
                });
            });
        }

        function ringsFromFeature(feature, project) {
            const geometry = feature && feature.geometry;
            if (!geometry) return [];
            const polygons = geometry.type === 'Polygon' ? [geometry.coordinates]
                : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
            return polygons
                .filter(rings => rings && rings[0] && rings[0].length >= 3)
                .map(rings => rings.map(ring => ring.map(c => project(c[0], c[1]))));
        }

        // A park: its lawn is walking space, its footpaths preferred bands, its ponds are water.
        function addPark(feature, project) {
            const deco = feature && feature.properties && feature.properties.decorations;
            (deco && Array.isArray(deco.paths) ? deco.paths : []).forEach(coords => {
                if (!Array.isArray(coords) || coords.length < 2) return;
                addWay({ points: coords.map(c => project(c[0], c[1])), bands: [{ offset: 0, halfWidth: 1.2, zcode: ZCODE.PATH }], source: 'park', id: 'park-path:' + ways.length });
            });
            (deco && Array.isArray(deco.ponds) ? deco.ponds : []).forEach(ring => {
                if (Array.isArray(ring) && ring.length >= 3) blocked.push({ rings: [ring.map(c => project(c[0], c[1]))] });
            });
            ringsFromFeature(feature, project).forEach(rings => {
                fills.push({ rings, zcode: ZCODE.PLAZA, kind: 'park' });
                addArea(rings, 'park');
            });
            obstaclesOf(deco, project).forEach(o => blocked.push(o));
        }

        // A plaza: paved walking space; its fountain, stalls, statues, trees and benches are kept clear.
        function addSquare(feature, project) {
            const deco = feature && feature.properties && feature.properties.decorations;
            ringsFromFeature(feature, project).forEach(rings => {
                fills.push({ rings, zcode: ZCODE.PLAZA, kind: 'square' });
                addArea(rings, 'square');
            });
            obstaclesOf(deco, project).forEach(o => blocked.push(o));
        }

        // Anything people never enter: building footprints, water, lakes, station halls. A context
        // building arrives as a face mesh (`faces`: GeoJSON polygons with [lng, lat, z] vertices,
        // the shape Zagreb's GDI meshes and the extruded footprints share); its roof faces project
        // onto exactly the ground it covers, while walls project to slivers and are skipped.
        function addBlockedFeature(feature, project) {
            if (feature && Array.isArray(feature.faces)) {
                feature.faces.forEach(face => {
                    const rings = face && Array.isArray(face.coordinates) ? face.coordinates : null;
                    if (!rings || !rings[0] || rings[0].length < 3) return;
                    const projected = rings.map(ring => ring.map(c => project(c[0], c[1])));
                    if (ringArea(projected[0]) < 1) return;
                    blocked.push({ rings: projected });
                });
                return;
            }
            ringsFromFeature(feature, project).forEach(rings => blocked.push({ rings }));
        }

        function obstaclesOf(deco, project) {
            if (!deco) return [];
            const out = [];
            const push = (coord, r) => {
                if (Array.isArray(coord) && Number.isFinite(coord[0]) && Number.isFinite(coord[1])) {
                    const [x, y] = project(coord[0], coord[1]);
                    out.push({ x, y, r });
                }
            };
            (Array.isArray(deco.trees) ? deco.trees : []).forEach(c => push(c, 0.6));
            (Array.isArray(deco.benches) ? deco.benches : []).forEach(b => push(Array.isArray(b && b.coordinate) ? b.coordinate : b, 1.0));
            (Array.isArray(deco.stalls) ? deco.stalls : []).forEach(s => push(Array.isArray(s && s.coordinate) ? s.coordinate : s, 2.0));
            (Array.isArray(deco.statues) ? deco.statues : []).forEach(s => push(Array.isArray(s && s.coordinate) ? s.coordinate : s, 1.5));
            if (deco.fountain) push(Array.isArray(deco.fountain.coordinate) ? deco.fountain.coordinate : deco.fountain, Number(deco.fountain.radius) || 2.5);
            return out;
        }

        function addArea(rings, kind) {
            const outer = rings[0];
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            outer.forEach(([x, y]) => { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; });
            areas.push({ id: 'area:' + areas.length, kind, outer, holes: rings.slice(1), area: ringArea(outer), bbox: [minX, minY, maxX, maxY] });
        }

        // Split every way at vertices shared with another way (or its own ends), emit drive tracks
        // and collect the surface paint lists.
        function build() {
            const keyUse = new Map();   // node key → number of distinct ways touching it
            ways.forEach(way => {
                if (!way.lanes.length) return;
                const seen = new Set();
                way.points.forEach(p => {
                    const key = nodeKey(p[0], p[1]);
                    if (seen.has(key)) return;
                    seen.add(key);
                    keyUse.set(key, (keyUse.get(key) || 0) + 1);
                });
            });
            const nodes = new Map();
            const tracks = [];
            const nodeAt = (p) => {
                const key = nodeKey(p[0], p[1]);
                if (!nodes.has(key)) nodes.set(key, { id: key, x: p[0], y: p[1], out: [], sources: new Set(), ways: new Set() });
                return nodes.get(key);
            };
            const pushTrack = (track) => { track.id = nextTrackId++; tracks.push(track); return track; };
            const carriageways = [];
            const bands = [];

            ways.forEach(way => {
                if (way.carriageway) {
                    const pts = offsetPolyline(way.points, way.carriageway.offset);
                    if (pts) carriageways.push({ pts, halfWidth: way.carriageway.halfWidth });
                }
                way.bands.forEach(band => {
                    const pts = offsetPolyline(way.points, band.offset);
                    if (pts) bands.push({ pts, halfWidth: band.halfWidth, zcode: band.zcode || 0 });
                });
                if (!way.lanes.length) return;
                // Cut the centreline into edges between junction vertices.
                const cuts = [0];
                for (let i = 1; i < way.points.length - 1; i++) {
                    if ((keyUse.get(nodeKey(way.points[i][0], way.points[i][1])) || 0) >= 2) cuts.push(i);
                }
                cuts.push(way.points.length - 1);
                for (let c = 0; c < cuts.length - 1; c++) {
                    const centre = way.points.slice(cuts[c], cuts[c + 1] + 1);
                    if (centre.length < 2) continue;
                    const from = nodeAt(centre[0]);
                    const to = nodeAt(centre[centre.length - 1]);
                    if (from === to && polylineLength(centre) < 1) continue;
                    from.sources.add(way.source); to.sources.add(way.source);
                    from.ways.add(way.id); to.ways.add(way.id);
                    way.lanes.forEach(lane => {
                        const pts = offsetPolyline(centre, lane.offset);
                        if (!pts) return;
                        if (lane.dir < 0) pts.reverse();
                        const track = pushTrack({
                            kind: 'drive', laneKind: lane.kind, pts: pts.map(p => [p[0], p[1], (p[2] || 0) + (way.zLift || 0)]),
                            from: lane.dir < 0 ? to.id : from.id, to: lane.dir < 0 ? from.id : to.id,
                            speed: lane.speed, source: way.source, wayId: way.id, width: LANE_WIDTH_M
                        });
                        finishTrack(track);
                        nodes.get(track.from).out.push(track.id);
                    });
                }
            });

            connectLooseEnds(nodes, tracks);

            let driveLength = 0;
            tracks.forEach(track => { driveLength += track.len; });
            return {
                tracks, areas: areas.slice(), nodes,
                surface: { carriageways, bands, fills: fills.slice(), blocked: blocked.slice() },
                stats: { tracks: tracks.length, driveLength, areas: areas.length, nodes: nodes.size, carriageways: carriageways.length, bands: bands.length, fills: fills.length, blocked: blocked.length }
            };
        }

        return { addCorridor, addOsmRoads, addPark, addSquare, addBlockedFeature, addWay, build };
    }

    function finishTrack(track) {
        const cum = [0];
        for (let i = 1; i < track.pts.length; i++) cum.push(cum[i - 1] + dist(track.pts[i - 1], track.pts[i]));
        track.cum = cum;
        track.len = cum[cum.length - 1];
    }

    // A corridor drawn onto an existing street rarely ends exactly on an OSM vertex. Merge each
    // dead-end corridor node into the nearest OSM node within reach so traffic flows between them.
    function connectLooseEnds(nodes, tracks) {
        const osmNodes = [];
        nodes.forEach(node => { if (node.sources.has('osm')) osmNodes.push(node); });
        if (!osmNodes.length) return;
        nodes.forEach(node => {
            if (node.sources.has('osm') || !node.sources.has('corridor')) return;
            if (node.ways.size > 1) return; // a real corridor junction, not a loose end
            let best = null, bestD = LOOSE_END_SNAP_M;
            for (const candidate of osmNodes) {
                const d = Math.hypot(candidate.x - node.x, candidate.y - node.y);
                if (d < bestD) { bestD = d; best = candidate; }
            }
            if (!best) return;
            tracks.forEach(track => {
                if (track.from === node.id) track.from = best.id;
                if (track.to === node.id) track.to = best.id;
            });
            best.out.push(...node.out);
            node.out = [];
            node.mergedInto = best.id;
        });
    }

    // Position, heading and z at arc length `s` along a track (clamped). `segHint` speeds up the
    // monotone walk agents make; the result carries the segment index back.
    function sampleTrack(track, s, out, segHint) {
        const pts = track.pts, cum = track.cum;
        const n = pts.length;
        if (s <= 0) { fill(out, pts[0], pts[1], 0); return out; }
        if (s >= track.len) { fill(out, pts[n - 2], pts[n - 1], 1); out.seg = n - 2; return out; }
        let i = Math.min(Math.max(segHint || 0, 0), n - 2);
        while (i > 0 && cum[i] > s) i--;
        while (i < n - 2 && cum[i + 1] < s) i++;
        const segLen = cum[i + 1] - cum[i];
        fill(out, pts[i], pts[i + 1], segLen > 0 ? (s - cum[i]) / segLen : 0);
        out.seg = i;
        return out;
    }

    // The curve a vehicle drives from track `a` into track `b` through their shared node: both lanes
    // are trimmed back by the tangent length of a `radius` (default TURN_RADIUS_M) arc for the turn
    // angle and joined
    // by a cubic Bézier along their tangents (a circular-arc approximation). Hairpins and U-turns
    // turn tightly at the node instead of 14 m before it. The result is track-shaped (pts/cum/len,
    // so sampleTrack reads it; point i is the Bézier at t = i / CURVE_SAMPLES) plus `ctrl` (the four
    // control points, for curveHeading), `exitS` on `a`, `entryS` on `b` and `vmax`, the speed that
    // keeps the lateral acceleration under LATERAL_ACCEL.
    const TURN_RADIUS_M = 7;
    const TURN_TRIM_MIN_M = 1.5;
    const TURN_TRIM_MAX_M = 14;
    const TURN_TRIM_SHARE = 0.4;      // a trim never takes more of a track than this, so both ends fit
    const HAIRPIN_RAD = 3 * Math.PI / 4;
    const LATERAL_ACCEL = 2.5;        // m/s²
    const CURVE_SAMPLES = 12;

    function angleBetween(h0, h1) {
        let d = h1 - h0;
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        return Math.abs(d);
    }

    function junctionCurve(a, b, radius) {
        const turnRadius = radius > 0 ? radius : TURN_RADIUS_M;
        const na = a.pts.length;
        const endHeading = Math.atan2(a.pts[na - 1][1] - a.pts[na - 2][1], a.pts[na - 1][0] - a.pts[na - 2][0]);
        const startHeading = Math.atan2(b.pts[1][1] - b.pts[0][1], b.pts[1][0] - b.pts[0][0]);
        const angle = angleBetween(endHeading, startHeading);
        const trim = angle > HAIRPIN_RAD ? TURN_TRIM_MIN_M
            : Math.min(TURN_TRIM_MAX_M, Math.max(TURN_TRIM_MIN_M, turnRadius * Math.tan(angle / 2)));
        const exitS = Math.max(0, a.len - Math.min(trim, TURN_TRIM_SHARE * a.len));
        const entryS = Math.min(b.len, Math.min(trim, TURN_TRIM_SHARE * b.len));
        const p0 = sampleTrack(a, exitS, {}, 0);
        const p3 = sampleTrack(b, entryS, {}, 0);
        const turn = angleBetween(p0.heading, p3.heading);
        const chord = Math.hypot(p3.x - p0.x, p3.y - p0.y);
        const handle = (2 / 3) * chord / (1 + Math.cos(turn / 2));
        const c1 = [p0.x + Math.cos(p0.heading) * handle, p0.y + Math.sin(p0.heading) * handle];
        const c2 = [p3.x - Math.cos(p3.heading) * handle, p3.y - Math.sin(p3.heading) * handle];
        const pts = [];
        for (let i = 0; i <= CURVE_SAMPLES; i++) {
            const t = i / CURVE_SAMPLES, u = 1 - t;
            const w0 = u * u * u, w1 = 3 * u * u * t, w2 = 3 * u * t * t, w3 = t * t * t;
            pts.push([
                w0 * p0.x + w1 * c1[0] + w2 * c2[0] + w3 * p3.x,
                w0 * p0.y + w1 * c1[1] + w2 * c2[1] + w3 * p3.y,
                p0.z + (p3.z - p0.z) * t
            ]);
        }
        const curve = { pts, exitS, entryS, ctrl: [[p0.x, p0.y], c1, c2, [p3.x, p3.y]], startHeading: p0.heading };
        finishTrack(curve);
        curve.vmax = turn > 0.05 ? Math.sqrt(LATERAL_ACCEL * curve.len / turn) : Infinity;
        return curve;
    }

    // Heading along a junction curve at arc length `s`, from the Bézier's tangent rather than its
    // chords, so a tight curve turns the body continuously instead of in CURVE_SAMPLES steps.
    function curveHeading(curve, s, segHint) {
        const sample = sampleTrack(curve, s, {}, segHint);
        const i = sample.seg, segLen = curve.cum[i + 1] - curve.cum[i];
        const t = Math.min(1, Math.max(0, (i + (segLen > 0 ? (Math.min(Math.max(s, 0), curve.len) - curve.cum[i]) / segLen : 0)) / CURVE_SAMPLES));
        const [p0, c1, c2, p3] = curve.ctrl, u = 1 - t;
        const dx = 3 * u * u * (c1[0] - p0[0]) + 6 * u * t * (c2[0] - c1[0]) + 3 * t * t * (p3[0] - c2[0]);
        const dy = 3 * u * u * (c1[1] - p0[1]) + 6 * u * t * (c2[1] - c1[1]) + 3 * t * t * (p3[1] - c2[1]);
        return Math.hypot(dx, dy) > 1e-9 ? Math.atan2(dy, dx) : curve.startHeading;
    }

    function fill(out, a, b, t) {
        out.x = a[0] + (b[0] - a[0]) * t;
        out.y = a[1] + (b[1] - a[1]) * t;
        out.z = (a[2] || 0) + ((b[2] || 0) - (a[2] || 0)) * t;
        out.heading = Math.atan2(b[1] - a[1], b[0] - a[0]);
        out.seg = 0;
    }

    function pointInArea(area, x, y) {
        if (x < area.bbox[0] || x > area.bbox[2] || y < area.bbox[1] || y > area.bbox[3]) return false;
        if (!pointInRing(x, y, area.outer)) return false;
        for (const hole of area.holes) if (pointInRing(x, y, hole)) return false;
        return true;
    }

    return {
        NODE_SNAP_M, LANE_WIDTH_M, SIDEWALK_DEPTH_M, DRIVE_CLASSES, ZCODE,
        createGraphBuilder, offsetPolyline, nodeKey, sampleTrack, junctionCurve, curveHeading, pointInArea,
        parseOneway, sidewalkSides, ringArea, pointInRing
    };
});
