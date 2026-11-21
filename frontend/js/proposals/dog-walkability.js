// Walks the pedestrian network of an exact plan revision, in metres and seconds.
(function (root, factory) {
    const load = (value, file) => value || (typeof require === 'function' ? require(file) : null);
    const api = factory(load(root.__metricFrame, '../metric-frame.js'), load(root.__corridorOsmForm, '../corridor-osm-form.js'),
        load(root.corridorSegmentEntries && root, '../corridor-profile.js'), load(root.__corridorJunction, '../corridor-junction.js'),
        load(root.BuildingUse, '../building-use.js'), load(root.__planYield, './plan-yield.js'));
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.DogWalkability = api;
})(typeof window !== 'undefined' ? window : globalThis, function (metric, osm, profiles, junctions, uses, yields) {
    'use strict';
    const CATEGORIES = ['green', 'shops', 'transit'];
    const SPEED = 1.2;
    const CROSSING_SECONDS = 15;
    const ACCESS_LIMIT_M = 25;
    const DENIED = new Set(['no', 'private']);
    const FOOTWAYS = new Set(['footway', 'pedestrian', 'path', 'steps', 'living_street']);
    const clamp = value => Math.max(0, Math.min(1, value));
    const minus = (a, b) => [a[0] - b[0], a[1] - b[1]];
    const norm = a => Math.hypot(...a);
    const dist = (a, b) => norm(minus(a, b));
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
    const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
    const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    const offset = (p, dir, across, along = 0) => [p[0] - dir[1] * across + dir[0] * along, p[1] + dir[0] * across + dir[1] * along];
    const level = point => point.level || 0;
    const nodeKey = point => `${point.lng.toFixed(7)},${point.lat.toFixed(7)}@${level(point)}`;
    const geometryOf = value => value?.type === 'Feature' ? value.geometry : value;
    const groundPolygons = value => {
        const geom = geometryOf(value);
        if (geom?.type === 'Polygon') return [geom.coordinates];
        if (geom?.type === 'MultiPolygon') return geom.coordinates;
        return [];
    };
    const denied = tags => DENIED.has(tags.foot) || (!tags.foot && DENIED.has(tags.access));
    const crossingAllowed = tags => tags.crossing !== 'no' && tags['crossing:markings'] !== 'no';
    const taggedCrossing = tags => (tags.highway === 'crossing' || !!tags.crossing) && crossingAllowed(tags) && !denied(tags);

    function corridorEntries(definition) {
        const elements = definition.osm?.elements;
        if (!Array.isArray(elements)) return profiles.corridorSegmentEntries(definition).map(row => ({ ...row, tags: {} }));
        const nodes = new Map(elements.filter(node => node.type === 'node').map(node => [node.id, node]));
        return elements.filter(way => way.type === 'way').flatMap(way => {
            const tags = way.tags || {};
            const profile = osm.profileFromLaneTags(tags);
            const points = way.nodes.map(id => nodes.get(id)).filter(Boolean).map(node => ({
                lat: node.lat, lng: node.lon, tags: node.tags || {},
                level: Number(node.tags?.['cb:level'] ?? tags.layer ?? (tags.bridge === 'yes' ? 1 : tags.tunnel === 'yes' ? -1 : 0)) || 0
            }));
            return profile && points.length > 1 ? [{ points, tags, profile }] : [];
        });
    }

    function facilities(contents) {
        const homes = [], destinations = [], buildings = [];
        let unstatedUse = 0;
        for (const { cid, content } of contents) {
            const space = content.structureProposal;
            if (['park', 'square', 'station'].includes(space?.kind)) {
                const geometry = space.geometry || content.site;
                destinations.push({ id: cid, title: content.title, geometry, category: space.kind === 'station' ? 'transit' : 'green' });
            }
            yields.buildingFeaturesOf(content).forEach((building, index) => {
                const properties = building.properties || {};
                const use = uses.effectiveUse(properties, Number(properties.floors));
                const name = typeof properties.name === 'string' ? properties.name.trim() : '';
                const row = { id: `building:${cid}:${index}`, title: name || content.title, geometry: building.geometry };
                buildings.push(row);
                if (!use) unstatedUse++;
                const groundUse = uses.storeyUses(use, 1)[0];
                if (uses.housesPeople(use) && (groundUse === 'residential' || !Number.isFinite(Number(properties.floors))
                    || uses.storeyUses(use, Number(properties.floors)).includes('residential'))) homes.push(row);
                if (groundUse === 'shop') destinations.push({ ...row, category: 'shops' });
            });
        }
        return { homes, destinations, buildings, unstatedUse };
    }

    function network(entries, frame) {
        const streets = [], groups = new Map(), paths = [], links = [], gaps = [];
        const pointXY = p => frame.latLngToMetric(p.lat, p.lng);
        for (const { points, tags, profile } of entries) {
            const spans = profiles.corridorStripSpans(profile);
            const walk = !denied(tags);
            const sidewalkOnly = spans.length && spans.every(s => s.type === 'sidewalk');
            const shared = walk && (sidewalkOnly || FOOTWAYS.has(tags.highway));
            const strips = walk ? spans.filter(s => s.type === 'sidewalk') : [];
            const left = strips.find(s => s.left + s.right > 0);
            const right = strips.findLast(s => s.left + s.right < 0);
            const sides = shared ? [0] : [left, right].filter(Boolean).map(s => (s.left + s.right) / 2);
            const edges = profiles.corridorProfileEdges(profile);
            for (let i = 1; i < points.length; i++) {
                const from = points[i - 1], to = points[i], a = pointXY(from), b = pointXY(to);
                const length = dist(a, b);
                if (length < 0.05) continue;
                const dir = minus(b, a).map(value => value / length);
                const edge = { a, b, atGround: !level(from) && !level(to), shared, dir, length, sides, edges, tags, pathRows: [] };
                if (!shared) {
                    streets.push(edge);
                    if (!sides.length) gaps.push({ kind: 'no-sidewalk', points: [a, b] });
                }
                edge.pathRows = sides.map(side => ({ a: offset(a, dir, side), b: offset(b, dir, side), splits: [],
                    ground: edge.atGround, side, edge }));
                paths.push(...edge.pathRows);
                for (const [p, xy, direction, end] of [[from, a, dir, 0], [to, b, dir.map(v => -v), 1]]) {
                    const key = nodeKey(p);
                    if (!groups.has(key)) groups.set(key, { xy, tags: [], arms: [] });
                    const group = groups.get(key);
                    group.tags.push(p.tags || {});
                    group.arms.push({ dir: direction, reversed: !!end, edge, end, edges, length, hasSidewalk: sides.length > 0,
                        angle: Math.atan2(direction[1], direction[0]) });
                }
            }
        }
        const endpoint = (arm, side, along = 0) => {
            const path = arm.edge.pathRows.find(p => arm.edge.shared || Math.sign(p.side) === side * (arm.end ? -1 : 1));
            return path && { path, t: arm.end ? 1 - along / arm.length : along / arm.length };
        };
        for (const { xy, tags, arms } of groups.values()) {
            if (arms.length < 2 && !tags.some(taggedCrossing)) continue;
            arms.sort((a, b) => a.angle - b.angle);
            // Turns follow the corner between adjacent arms. Opposite sidewalks stay separate.
            if (arms.length > 1) arms.forEach((arm, index) => {
                const next = arms[(index + 1) % arms.length];
                const a = endpoint(arm, 1), b = endpoint(next, -1);
                if (a && b) links.push({ a, b, delay: 0 });
            });
            const roadArms = arms.filter(arm => !arm.edge.shared);
            const model = roadArms.length >= 3 ? junctions.buildJunction(xy, roadArms) : null;
            const crossingStations = new Map(model?.arms.map(arm => [arm.source, arm.crossingStation]) || []);
            const allowed = tags.every(crossingAllowed);
            for (const arm of roadArms) {
                const marked = allowed && tags.some(taggedCrossing);
                const modeled = allowed && crossingAllowed(arm.edge.tags) ? crossingStations.get(arm) : null;
                const crossing = marked ? Math.min(1, arm.length / 2) : modeled;
                if (crossing == null && roadArms.length < 3) continue;
                const a = endpoint(arm, 1, crossing ?? 0), b = endpoint(arm, -1, crossing ?? 0);
                if (!a || !b) continue;
                if (crossing == null) gaps.push({ kind: 'crossing-gap', points: [lerp(a.path.a, a.path.b, a.t), lerp(b.path.a, b.path.b, b.t)] });
                else links.push({ a, b, delay: CROSSING_SECONDS });
            }
        }
        return { paths, streets, links, gaps };
    }

    function closestPoint(p, a, b) {
        const v = minus(b, a);
        return clamp(dot(minus(p, a), v) / (dot(v, v) || 1));
    }

    function intersection(a, b, c, d) {
        const r = minus(b, a), s = minus(d, c), q = minus(c, a), den = cross(r, s);
        if (Math.abs(den) < 0.00001) return false;
        const t = cross(q, s) / den, u = cross(q, r) / den;
        return t > 0.001 && t < 0.999 && u >= 0 && u <= 1;
    }

    function pointInRing(p, ring) {
        let inside = false;
        for (let i = 1; i < ring.length; i++) {
            const [x, y] = ring[i - 1], [nx, ny] = ring[i];
            if ((y > p[1]) !== (ny > p[1]) && p[0] < x + (nx - x) * (p[1] - y) / (ny - y)) inside = !inside;
        }
        return inside;
    }

    function attach(row, paths, streets, buildings) {
        const barrier = (a, b) => streets.some(s => s.atGround && intersection(a, b, s.a, s.b))
            || buildings.some(other => other.id !== row.id && other.rings.some(ring => {
                const shape = ring.outer;
                if (Math.max(a[0], b[0]) < ring.bounds[0] || Math.min(a[0], b[0]) > ring.bounds[2]
                    || Math.max(a[1], b[1]) < ring.bounds[1] || Math.min(a[1], b[1]) > ring.bounds[3]) return false;
                const midpoint = lerp(a, b, 0.5);
                const inside = pointInRing(midpoint, shape) && !ring.holes.some(hole => pointInRing(midpoint, hole));
                return inside || ring.edges.some(([x, y]) => intersection(a, b, x, y));
            }));
        let best = null, bestM = ACCESS_LIMIT_M;
        function consider(path, coordinate, t) {
            const onPath = lerp(path.a, path.b, t);
            const m = dist(coordinate, onPath);
            if (m >= bestM || barrier(coordinate, onPath)) return;
            best = { path, t, m, coordinate };
            bestM = m;
        }
        for (const path of paths) {
            if (!path.ground) continue;
            for (const { outer, bounds, edges } of row.rings) {
                if (Math.max(path.a[0], path.b[0]) + bestM < bounds[0] || Math.min(path.a[0], path.b[0]) - bestM > bounds[2]
                    || Math.max(path.a[1], path.b[1]) + bestM < bounds[1] || Math.min(path.a[1], path.b[1]) - bestM > bounds[3]) continue;
                for (const p of outer) consider(path, p, closestPoint(p, path.a, path.b));
                for (const [a, b] of edges) for (const [p, t] of [[path.a, 0], [path.b, 1]]) {
                    consider(path, lerp(a, b, closestPoint(p, a, b)), t);
                }
            }
        }
        return best;
    }

    function toGraph({ paths, links }, facilities) {
        const nodes = [];
        const addNode = xy => { const id = nodes.length; nodes.push({ xy, edges: [] }); return id; };
        const connect = (a, b, delay = 0) => {
            if (a === b) return;
            const seconds = dist(nodes[a].xy, nodes[b].xy) / SPEED + delay;
            nodes[a].edges.push([b, seconds]); nodes[b].edges.push([a, seconds]);
        };
        const insert = point => { point.path.splits.push(point); };
        for (const { a, b } of links) { insert(a); insert(b); }
        for (const item of facilities) if (item.attachment) insert(item.attachment);
        for (const path of paths) {
            const marks = [{ t: 0 }, ...path.splits, { t: 1 }].sort((a, b) => a.t - b.t);
            let previous;
            for (const mark of marks) {
                mark.node = previous && Math.abs(previous.t - mark.t) < 1e-8 ? previous.node : addNode(lerp(path.a, path.b, mark.t));
                if (previous) connect(previous.node, mark.node);
                previous = mark;
            }
        }
        for (const { a, b, delay } of links) connect(a.node, b.node, delay);
        return nodes;
    }

    function search(nodes, destinations) {
        const time = new Float64Array(nodes.length).fill(Infinity), next = new Int32Array(nodes.length).fill(-1);
        const target = new Array(nodes.length), queue = [];
        function push(pair) {
            let i = queue.length;
            queue.push(pair);
            while (i > 0) {
                const parent = (i - 1) >> 1;
                if (queue[parent][1] <= pair[1]) break;
                queue[i] = queue[parent]; i = parent;
            }
            queue[i] = pair;
        }
        function pop() {
            const first = queue[0], last = queue.pop();
            if (queue.length) {
                let i = 0;
                while (2 * i + 1 < queue.length) {
                    let child = 2 * i + 1;
                    if (child + 1 < queue.length && queue[child + 1][1] < queue[child][1]) child++;
                    if (queue[child][1] >= last[1]) break;
                    queue[i] = queue[child]; i = child;
                }
                queue[i] = last;
            }
            return first;
        }
        for (const row of destinations) {
            if (!row.attachment) continue;
            const { node, m } = row.attachment, seconds = m / SPEED;
            if (seconds >= time[node]) continue;
            time[node] = seconds;
            target[node] = row;
            push([node, seconds]);
        }
        while (queue.length) {
            const [node, seconds] = pop();
            if (seconds !== time[node]) continue;
            for (const [neighbour, travel] of nodes[node].edges) {
                const total = seconds + travel;
                if (total >= time[neighbour]) continue;
                time[neighbour] = total;
                next[neighbour] = node;
                target[neighbour] = target[node];
                push([neighbour, total]);
            }
        }
        return { time, next, target };
    }

    function evaluate(plan, designs) {
        const included = new Set(plan.designCids);
        const rows = designs.filter(row => included.has(row.cid));
        if (rows.length !== included.size) throw new Error('A plan member is unavailable.');
        const { homes, buildings, destinations, unstatedUse } = facilities(rows);
        const entries = rows.flatMap(({ content }) => {
            const definition = content.roadProposal?.definition;
            if (!definition || definition.kind === 'track') return [];
            return corridorEntries(definition).filter(row => !profiles.corridorProfileHasRail(row.profile)
                || profiles.corridorStripSpans(row.profile).some(strip => strip.type === 'sidewalk'));
        });
        const places = [...new Map([...buildings, ...destinations].map(row => [row.id, row])).values()];
        const positions = [...entries.map(entry => entry.points), ...places.map(row => row.geometry)];
        const coords = metric.collectPositions(positions);
        const frame = coords.length ? metric.frameFor(coords) : null;
        const lngLat = point => frame.toLngLat(point);
        const xy = point => frame.toMetric(point);
        const projected = new Map(places.map(row => [row.id, {
            ...row, rings: groundPolygons(row.geometry).map(([outer, ...holes]) => {
                const o = outer.map(xy);
                const x = o.map(p => p[0]), y = o.map(p => p[1]);
                return { outer: o, holes: holes.map(ring => ring.map(xy)), bounds: [Math.min(...x), Math.min(...y), Math.max(...x), Math.max(...y)],
                    edges: o.slice(1).map((p, index) => [o[index], p]) };
            })
        }]));
        const networkData = frame ? network(entries, frame) : { paths: [], streets: [], links: [], gaps: [] };
        const { paths, streets, gaps } = networkData;
        const barriers = buildings.map(row => projected.get(row.id));
        for (const row of projected.values()) row.attachment = attach(row, paths, streets, barriers);
        const nodes = toGraph(networkData, projected.values());
        const groups = Object.fromEntries(CATEGORIES.map(category => [category, destinations.filter(row => row.category === category)
            .map(row => projected.get(row.id))]));
        const sources = Object.fromEntries(CATEGORIES.map(category => [category, search(nodes, groups[category])]));
        const homeResults = homes.map(({ id, title, geometry }) => {
            const home = projected.get(id), attachment = home.attachment;
            const coordinate = attachment ? lngLat(attachment.coordinate) : metric.collectPositions(geometry)[0] || null;
            const routes = Object.fromEntries(CATEGORIES.map(category => {
                const { time, target } = sources[category], from = attachment?.node;
                const destination = target[from];
                return [category, destination ? { seconds: Math.round(time[from] + attachment.m / SPEED),
                    id: destination.id, title: destination.title } : null];
            }));
            return { id, title, coordinate, connected: !!attachment, routes };
        });
        const stats = Object.fromEntries(CATEGORIES.map(category => {
            const available = groups[category];
            const times = homeResults.map(row => row.routes[category]?.seconds ?? Infinity);
            return [category, { destinations: available.length, connectedDestinations: available.filter(row => row.attachment).length,
                within5: times.filter(seconds => seconds <= 300).length, within10: times.filter(seconds => seconds <= 600).length,
                noRoute: available.length ? times.filter(seconds => !Number.isFinite(seconds)).length : null }];
        }));
        const measured = CATEGORIES.map(category => stats[category]).filter(row => row.destinations);
        const destinationResults = destinations.map(({ id, title, category, geometry }) => {
            const attachment = projected.get(id).attachment;
            return { id, title, category, connected: !!attachment,
                coordinate: attachment ? lngLat(attachment.coordinate) : metric.collectPositions(geometry)[0] || null };
        });
        const result = { categories: stats, homes: homeResults, destinations: destinationResults, unstatedUse,
            connectedHomes: homeResults.filter(row => row.connected).length,
            score: paths.length && measured.length && homes.length ? Math.round(100 * measured.reduce((sum, row) => sum + row.within10, 0) / (measured.length * homes.length)) : null,
            pathCount: paths.length, paths: paths.map(path => [lngLat(path.a), lngLat(path.b)]),
            gaps: gaps.map(gap => ({ kind: gap.kind, points: gap.points.map(lngLat) })) };
        function route(id, category) {
            const home = projected.get(id), attachment = home?.attachment, source = sources[category];
            if (!attachment || !source || !source.target[attachment.node]) return null;
            const points = [attachment.coordinate];
            for (let i = attachment.node; i >= 0; i = source.next[i]) points.push(nodes[i].xy);
            points.push(source.target[attachment.node].attachment.coordinate);
            return points.map(lngLat);
        }
        return { ...result, route };
    }

    return Object.freeze({ evaluate, CATEGORIES });
});
