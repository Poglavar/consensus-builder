// Pure subdivision experiments: node the real road network, pair T-junctions and connected dead
// ends, then try perimeter points where needed. A bounded beam search reports partial results.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.UrbanBlocksSubdivision = api;
})(typeof self !== 'undefined' ? self : null, function () {
    'use strict';
    const EPS = 0.02, SNAP = 0.5, MAX_PAIRS = 12000, MAX_CUTS = 48, BEAM_WIDTH = 4;
    const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
    const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
    const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    const same = (a, b) => distance(a, b) < EPS;
    const pointKey = p => p.map(v => Math.round(v * 1000)).join(',');
    const unit = v => { const d = Math.hypot(...v); return d ? v.map(x => x / d) : [0, 0]; };
    const length = path => path.slice(1).reduce((sum, p, i) => sum + distance(path[i], p), 0);
    const ringArea = ring => Math.abs(ring.slice(1).reduce((sum, p, i) => sum + cross(ring[i], p), 0) / 2);
    const fc = features => ({ type: 'FeatureCollection', features });
    const feature = (type, coordinates, properties = {}) => ({ type: 'Feature', geometry: { type, coordinates }, properties });
    const cutKind = (a, b) => ['dead-end', 'dead-end-projection', 't', 'perimeter'].find(kind => kind === a || kind === b);

    function projection(block) {
        const points = block.geometry.coordinates.flat();
        const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
        const origin = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
        const yScale = Math.PI * 6371008.8 / 180, xScale = yScale * Math.cos(origin[1] * Math.PI / 180);
        return { project: p => [(p[0] - origin[0]) * xScale, (p[1] - origin[1]) * yScale],
            unproject: p => [p[0] / xScale + origin[0], p[1] / yScale + origin[1]], xScale, yScale };
    }

    function nearest(p, ring) {
        let best = null, along = 0;
        for (let i = 0; i < ring.length - 1; i++) {
            const a = ring[i], v = sub(ring[i + 1], a), span = Math.hypot(...v);
            if (!span) continue;
            let t = Math.max(0, Math.min(1, dot(sub(p, a), v) / (span * span)));
            // Reuse a shared vertex exactly when snapping another cut to it. Re-projecting it
            // with floating-point arithmetic otherwise leaves microscopic overlap slivers.
            if (Math.min(t, 1 - t) * span < EPS) t = t < 0.5 ? 0 : 1;
            const point = t === 0 ? a : t === 1 ? ring[i + 1] : [a[0] + t * v[0], a[1] + t * v[1]], d = distance(p, point);
            if (!best || d < best.distance) best = { point, distance: d, along: along + t * span, index: i };
            along += span;
        }
        return best;
    }

    function inRing(p, ring) {
        let inside = false;
        for (let i = 0, j = ring.length - 2; i < ring.length - 1; j = i++) {
            const a = ring[i], b = ring[j];
            if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
        }
        return inside;
    }

    function inside(p, rings) {
        return inRing(p, rings[0]) && !rings.slice(1).some(ring => inRing(p, ring))
            && rings.every(ring => nearest(p, ring).distance > EPS);
    }

    function intersection(a, b, c, d) {
        const r = sub(b, a), s = sub(d, c), denominator = cross(r, s);
        if (Math.abs(denominator) < 1e-9) return null;
        const t = cross(sub(c, a), s) / denominator, u = cross(sub(c, a), r) / denominator;
        if (t < -1e-8 || t > 1 + 1e-8 || u < -1e-8 || u > 1 + 1e-8) return null;
        return { t: Math.max(0, Math.min(1, t)), point: [a[0] + t * r[0], a[1] + t * r[1]] };
    }

    function hits(a, b, rings) {
        const result = [];
        for (const ring of rings) for (let i = 1; i < ring.length; i++) {
            const hit = intersection(a, b, ring[i - 1], ring[i]);
            if (hit) result.push(hit);
        }
        return result.sort((x, y) => x.t - y.t);
    }

    function pathInside(path, rings) {
        if (path.slice(1, -1).some(p => !inside(p, rings))) return false;
        for (let i = 1; i < path.length; i++) {
            const a = path[i - 1], b = path[i];
            if (hits(a, b, rings.slice(1)).length) return false;
            const cuts = [0, ...hits(a, b, rings).map(hit => hit.t), 1].sort((x, y) => x - y);
            for (let j = 1; j < cuts.length; j++) {
                if (cuts[j] - cuts[j - 1] < 1e-8) continue;
                const t = (cuts[j] + cuts[j - 1]) / 2;
                if (!inside([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], rings)) return false;
            }
            for (let j = 1; j < i - 1; j++) {
                if (intersection(a, b, path[j - 1], path[j])) return false;
                // Parallel overlapping stems also make a self-touching, invalid split.
                if (nearest(a, [path[j - 1], path[j]]).distance < EPS || nearest(b, [path[j - 1], path[j]]).distance < EPS) return false;
            }
        }
        return true;
    }

    function hull(points) {
        const sorted = [...new Map(points.map(p => [pointKey(p), p])).values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
        const half = list => {
            const result = [];
            for (const p of list) {
                while (result.length > 1 && cross(sub(result.at(-1), result.at(-2)), sub(p, result.at(-1))) <= 1e-7) result.pop();
                result.push(p);
            }
            return result.slice(0, -1);
        };
        return [...half(sorted), ...half(sorted.slice().reverse())];
    }

    function measure(rings, options) {
        const outer = rings[0], convex = hull(outer.slice(0, -1));
        let boxArea = Infinity, longestSideM = Infinity, shortestSideM = Infinity;
        for (let i = 0; i < convex.length; i++) {
            const axis = unit(sub(convex[(i + 1) % convex.length], convex[i]));
            const x = convex.map(p => dot(p, axis)), y = convex.map(p => cross(p, axis));
            const width = Math.max(...x) - Math.min(...x), height = Math.max(...y) - Math.min(...y);
            const area = width * height, longest = Math.max(width, height);
            if (area < boxArea - 1e-5 || (Math.abs(area - boxArea) < 1e-5 && longest < longestSideM)) {
                boxArea = area; longestSideM = longest; shortestSideM = Math.min(width, height);
            }
        }
        const areaM2 = options.areaOf ? options.areaOf(rings)
            : ringArea(outer) - rings.slice(1).reduce((sum, ring) => sum + ringArea(ring), 0);
        const perimeterM = length(outer);
        const compactness = Math.min(1, 4 * Math.PI * areaM2 / (perimeterM * perimeterM));
        const rectangularity = Math.min(1, areaM2 / boxArea), aspectRatio = longestSideM / Math.max(EPS, shortestSideM);
        const winding = Math.sign(outer.slice(1).reduce((sum, p, i) => sum + cross(outer[i], p), 0));
        let sharpCorners = 0;
        for (let i = 0; i < outer.length - 1; i++) {
            const a = sub(outer[(i + outer.length - 2) % (outer.length - 1)], outer[i]);
            const b = sub(outer[(i + 1) % (outer.length - 1)], outer[i]);
            if (cross(a, b) * winding >= 0) continue;
            const angle = Math.acos(Math.max(-1, Math.min(1, dot(unit(a), unit(b)))));
            // Tiny survey/road-shape vertices should not carry the weight of a block corner.
            const weight = Math.min(1, Math.hypot(...a) / Math.sqrt(areaM2), Math.hypot(...b) / Math.sqrt(areaM2));
            sharpCorners += Math.max(0, 1 - angle / (Math.PI / 3)) ** 2 * weight;
        }
        // Shape preference is independent of the tolerated side limit. Raising that ceiling
        // must not reward long wedges that merely happen to fit under the new value.
        const shapePenalty = 2 * (1 - rectangularity) + Math.max(0, Math.log(aspectRatio / 1.5))
            + 2 * sharpCorners + 0.5 * (1 - compactness);
        return { areaM2, longestSideM, perimeterM, compactness, rectangularity, aspectRatio, shapePenalty,
            acceptable: areaM2 <= options.targetAreaM2 + 0.1 && longestSideM <= options.maxSideM + EPS };
    }

    function canonical(ring) {
        const keys = ring.slice(0, -1).map(pointKey);
        const first = keys.reduce((best, p, i) => p < keys[best] ? i : best, 0);
        const forward = keys.map((_, i) => keys[(first + i) % keys.length]).join(';');
        const reverse = keys.map((_, i) => keys[(first - i + keys.length) % keys.length]).join(';');
        return forward < reverse ? forward : reverse;
    }

    function face(rings, options) {
        return { rings, properties: measure(rings, options), key: rings.map(canonical).join('/') };
    }

    function boundaryArc(from, to, ring) {
        const perimeter = length(ring), end = to.along > from.along ? to.along : to.along + perimeter;
        let along = 0;
        const vertices = [];
        for (let i = 0; i < ring.length - 1; i++) {
            const at = along <= from.along + EPS ? along + perimeter : along;
            if (at < end - EPS) vertices.push({ point: ring[i], at });
            along += distance(ring[i], ring[i + 1]);
        }
        return [from.point, ...vertices.sort((a, b) => a.at - b.at).map(v => v.point), to.point];
    }

    function perimeterTrace(ring, fromPoint, toPoint) {
        const from = nearest(fromPoint, ring), to = nearest(toPoint, ring);
        if (same(from.point, to.point)) return { perimeterPath: [from.point], perimeterLengthM: 0 };
        const path = boundaryArc(from, to, ring);
        return { perimeterPath: path, perimeterLengthM: length(path) };
    }

    function splitFace(parent, cut, options) {
        const start = nearest(cut[0], parent.rings[0]), end = nearest(cut.at(-1), parent.rings[0]);
        if (start.distance > SNAP || end.distance > SNAP || same(start.point, end.point)) return null;
        const path = [start.point, ...cut.slice(1, -1), end.point].filter((p, i, list) => !i || !same(p, list[i - 1]));
        if (!pathInside(path, parent.rings)) return null;
        const a = boundaryArc(start, end, parent.rings[0]).concat(path.slice().reverse().slice(1));
        const b = boundaryArc(end, start, parent.rings[0]).concat(path.slice(1));
        const rings = [[a], [b]];
        for (const hole of parent.rings.slice(1)) {
            const owner = rings.find(list => inRing(hole[0], list[0]));
            if (!owner) return null;
            owner.push(hole);
        }
        const children = rings.map(list => face(list, options));
        const minArea = Math.max(40, options.targetAreaM2 * 0.05);
        if (children.some(child => child.properties.areaM2 < minArea)) return null;
        if (Math.abs(children[0].properties.areaM2 + children[1].properties.areaM2 - parent.properties.areaM2) > 0.1) return null;
        return children;
    }

    function circumferenceRoadRing(block, edges, project, turf) {
        // The drawn block and the road centreline enclosure are separate geometries. The
        // smallest road face enclosing the block identifies which roads belong to its perimeter;
        // nearby intersections on other streets must not become candidates just by proximity.
        const bbox = turf.bbox(block), slack = [EPS / project.xScale, EPS / project.yScale];
        const enclosures = turf.polygonize(fc([...edges.values()])).features.map(item => {
            const polygon = feature('Polygon', [item.geometry.coordinates[0]]);
            return { polygon, bbox: turf.bbox(polygon), area: turf.area(polygon) };
        }).filter(item => item.bbox[0] <= bbox[0] + slack[0] && item.bbox[1] <= bbox[1] + slack[1]
            && item.bbox[2] >= bbox[2] - slack[0] && item.bbox[3] >= bbox[3] - slack[1])
            .sort((a, b) => a.area - b.area);
        for (const item of enclosures) {
            const outside = turf.difference(block, item.polygon);
            if (!outside || turf.area(outside) <= 0.1) return item.polygon.geometry.coordinates[0].map(project.project);
        }
        // An incomplete set of surrounding ways can still establish perimeter membership where
        // an actual road edge coincides with the drawn boundary. It supplies no offset matches.
        return block.geometry.coordinates[0].map(project.project);
    }

    function streetAreas(roads, project, model) {
        return roads.features.filter(road => model.isGroundRoad(road.properties) && model.isRoadArea(road.properties)).flatMap(road => {
            const geometry = road.geometry;
            const polygons = geometry?.type === 'Polygon' ? [geometry.coordinates]
                : geometry?.type === 'MultiPolygon' ? geometry.coordinates
                    : geometry?.type === 'LineString' ? [[geometry.coordinates]]
                        : geometry?.type === 'MultiLineString' ? geometry.coordinates.map(ring => [ring]) : [];
            return polygons.filter(rings => rings.every(ring => ring.length >= 4 && same(project.project(ring[0]), project.project(ring.at(-1)))))
                .map(rings => rings.map(ring => ring.map(project.project)));
        });
    }

    function acrossStreetArea(a, b, areas) {
        const contains = (point, rings) => (inRing(point, rings[0]) || nearest(point, rings[0]).distance < EPS)
            && !rings.slice(1).some(ring => inRing(point, ring) && nearest(point, ring).distance >= EPS);
        if (!areas.some(rings => contains(a, rings)) || !areas.some(rings => contains(b, rings))) return false;
        const cuts = [0, ...areas.flatMap(rings => hits(a, b, rings).map(hit => hit.t)), 1].sort((x, y) => x - y);
        return cuts.slice(1).every((to, i) => {
            if (to - cuts[i] < 1e-8) return true;
            const t = (to + cuts[i]) / 2, point = a.map((value, j) => value + (b[j] - value) * t);
            return areas.some(rings => contains(point, rings));
        });
    }

    function boundaryDeadEnd(node, graph, rings, areas) {
        const direction = unit(sub(node.point, graph.get([...node.next][0]).point));
        const border = nearest(node.point, rings[0]);
        let entry = border.point;
        if (border.distance >= EPS) {
            const end = node.point.map((value, i) => value + direction[i] * length(rings[0]) * 2);
            const hit = hits(node.point, end, rings).find(item => distance(node.point, item.point) > EPS);
            if (!hit || nearest(hit.point, rings[0]).distance > EPS || !acrossStreetArea(node.point, hit.point, areas)) return null;
            entry = hit.point;
        }
        // An alley can end on a street-area edge rather than inside the drawn block. Its
        // straight continuation must enter this block before it can reach the opposite side.
        if (!inside(entry.map((value, i) => value + direction[i] * EPS * 2), rings)) return null;
        return { point: entry, path: [entry], direction, deadEndPoint: node.point };
    }

    function naturalCandidates(block, roads, project, turf, model) {
        const rings = block.geometry.coordinates.map(ring => ring.map(project.project));
        const bbox = turf.bbox(block);
        const padX = 100 / project.xScale, padY = 100 / project.yScale;
        const bounds = [Math.max(-180, bbox[0] - padX), Math.max(-90, bbox[1] - padY), Math.min(180, bbox[2] + padX), Math.min(90, bbox[3] + padY)];
        // Closed highway areas describe street space, not drivable centreline connections.
        // Keep them as evidence for the gap to the drawn block, but never as graph edges.
        const areas = streetAreas(roads, project, model);
        const centrelineRoads = fc(roads.features.filter(road => !model.isRoadArea(road.properties)));
        const edges = model.nodeRoads(centrelineRoads, bounds, turf);
        const roadRing = circumferenceRoadRing(block, edges, project, turf), graph = new Map();
        for (const edge of edges.values()) {
            const [a, b] = edge.geometry.coordinates.map(project.project);
            const onPerimeter = [a, b, a.map((v, i) => (v + b[i]) / 2)].every(p => nearest(p, roadRing).distance < EPS);
            for (const [p, q] of [[a, b], [b, a]]) {
                const id = pointKey(p);
                if (!graph.has(id)) graph.set(id, { point: p, next: new Set(), perimeterNext: new Set() });
                graph.get(id).next.add(pointKey(q));
                if (onPerimeter) graph.get(id).perimeterNext.add(pointKey(q));
            }
        }
        const result = [];
        for (const [id, node] of [...graph].sort(([a], [b]) => a.localeCompare(b))) {
            const border = nearest(node.point, rings[0]);
            const joiningArms = [...node.next].filter(other => !node.perimeterNext.has(other));
            const adjacentJunction = node.next.size >= 3 && acrossStreetArea(node.point, border.point, areas);
            if ((node.perimeterNext.size >= 2 && joiningArms.length) || adjacentJunction) {
                result.push({ id: `t-${id}`, kind: 't', point: border.point, path: [border.point],
                    junctionPoint: node.point, projectionDistanceM: border.distance,
                    directions: (joiningArms.length ? joiningArms : [...node.next]).map(other => unit(sub(node.point, graph.get(other).point))) });
            }
            if (node.next.size !== 1) continue;
            if (!inside(node.point, rings)) {
                const candidate = boundaryDeadEnd(node, graph, rings, areas);
                if (candidate) result.push({ id: `dead-${id}`, kind: 'dead-end', ...candidate });
                continue;
            }
            // A dead end only becomes a cut candidate when its real road path reaches the block
            // boundary. A disconnected internal service road must not invent such a connection.
            const queue = [id], previous = new Map([[id, null]]);
            let root = null, entrance = null;
            for (let cursor = 0; cursor < queue.length && !root; cursor++) {
                const current = queue[cursor], item = graph.get(current);
                const edge = nearest(item.point, rings[0]);
                if (edge.distance < EPS) { root = current; entrance = edge.point; break; }
                for (const next of item.next) {
                    if (previous.has(next)) continue;
                    const point = graph.get(next).point;
                    const crossing = hits(item.point, point, rings).find(hit => distance(item.point, hit.point) > EPS);
                    if (crossing) {
                        if (nearest(crossing.point, rings[0]).distance < EPS && pathInside([item.point, crossing.point], rings)) {
                            root = current; entrance = crossing.point; break;
                        }
                        continue;
                    }
                    if (!inside(point, rings) || !pathInside([item.point, point], rings)) continue;
                    previous.set(next, current); queue.push(next);
                }
            }
            if (!root) continue;
            const path = [entrance];
            for (let current = root; current !== null; current = previous.get(current)) path.push(graph.get(current).point);
            const cleanPath = path.filter((point, i) => !i || !same(point, path[i - 1]));
            if (cleanPath.length < 2) continue;
            result.push({ id: `dead-${id}`, kind: 'dead-end', point: node.point, path: cleanPath, direction: unit(sub(node.point, cleanPath.at(-2))) });
        }
        return result;
    }

    function deadEndProjections(rings, natural) {
        const result = [], reach = length(rings[0]) * 2;
        for (const candidate of natural.filter(item => item.kind === 'dead-end')) {
            const tip = candidate.point, end = tip.map((value, i) => value + candidate.direction[i] * reach);
            // Stop at the first obstruction: never jump across a courtyard or a concave gap
            // to a farther boundary that happens to lie along the same ray.
            const hit = hits(tip, end, rings).find(item => distance(tip, item.point) > EPS);
            if (!hit || nearest(hit.point, rings[0]).distance > EPS || !pathInside([tip, hit.point], rings)) continue;
            let landing = result.find(item => same(item.point, hit.point));
            if (!landing) {
                landing = { id: `dead-projection-${pointKey(hit.point)}`, kind: 'dead-end-projection',
                    point: hit.point, path: [hit.point], directions: [], projectionSources: [] };
                result.push(landing);
            }
            landing.directions.push(unit(sub(tip, landing.point)));
            const sourcePoint = candidate.deadEndPoint || tip;
            landing.projectionSources.push({ sourceId: candidate.id, sourcePoint, lengthM: distance(sourcePoint, landing.point) });
        }
        return result;
    }

    function candidatesForFace(parent, candidates) {
        const rings = parent.rings;
        return candidates.flatMap(candidate => {
            const border = nearest(candidate.point, rings[0]);
            if (candidate.kind === 'perimeter' || candidate.kind === 'dead-end-projection'
                || (candidate.kind === 'dead-end' && candidate.path.length === 1)) {
                return border.distance <= SNAP ? [{ ...candidate, point: border.point, path: [border.point] }] : [];
            }
            if (candidate.kind === 't') {
                if (border.distance > SNAP) return [];
                return [{ ...candidate, point: border.point, path: [border.point] }];
            }
            if (!inside(candidate.point, rings)) return [];
            // After another split, trim an existing alley to its last entry into this face.
            let path = candidate.path;
            for (let i = 1; i < candidate.path.length; i++) {
                const crossings = hits(candidate.path[i - 1], candidate.path[i], [rings[0]]);
                if (crossings.length) path = [crossings.at(-1).point, ...candidate.path.slice(i)];
            }
            path = path.filter((p, i) => !i || !same(p, path[i - 1]));
            if (path.length < 2 || nearest(path[0], rings[0]).distance > SNAP) return [];
            return [{ ...candidate, path }];
        });
    }

    function perimeterCandidates(parent, existing, interval) {
        const ring = parent.rings[0], perimeter = length(ring);
        if (!Number.isFinite(interval) || interval <= EPS || perimeter <= EPS) return [];
        // One ordered walk, seeded only by real road connections. Alley tips lie inside the
        // block, so their boundary entrance is the anchor. Repeated entrances count once.
        const anchors = existing.filter(candidate => ['t', 'dead-end'].includes(candidate.kind)).flatMap(candidate => {
            const border = nearest(candidate.path[0], ring);
            if (border.distance > SNAP) return [];
            return [{ point: border.point, along: border.along % perimeter,
                id: candidate.id || `${candidate.kind}-${pointKey(border.point)}`,
                kind: candidate.kind === 'dead-end' ? 'dead-end-root' : candidate.kind }];
        }).sort((a, b) => a.along - b.along || a.id.localeCompare(b.id));
        const unique = anchors.filter((anchor, i) => !i || anchor.along - anchors[i - 1].along > EPS);
        if (!unique.length) return [];
        const result = [], first = unique[0];
        let previous = first, cursor = first.along;
        for (const next of [...unique.slice(1), { ...first, along: first.along + perimeter }]) {
            // Encounter a natural anchor before the interval expires: continue from it. The
            // final anchor closes the loop, leaving no uncovered gap longer than interval.
            while (next.along - cursor > interval + EPS) {
                cursor += interval;
                let remaining = cursor % perimeter, point = null;
                for (let i = 1; i < ring.length; i++) {
                    const span = distance(ring[i - 1], ring[i]);
                    if (remaining > span) { remaining -= span; continue; }
                    const t = span ? remaining / span : 0;
                    point = ring[i - 1].map((v, j) => v + (ring[i][j] - v) * t);
                    break;
                }
                const id = `perimeter-${pointKey(point)}`;
                result.push({ id, kind: 'perimeter', point, path: [point], provenance: {
                    method: 'spacing', sourceId: previous.id, sourceKind: previous.kind,
                    sourcePoint: previous.point, boundarySource: previous.point,
                    ...perimeterTrace(ring, previous.point, point)
                } });
                previous = { point, id, kind: 'perimeter' };
            }
            previous = next;
            cursor = next.along;
        }
        return result;
    }

    function bendCost(candidate, direction, ring) {
        if (candidate.directions?.length) return Math.min(...candidate.directions.map(approach => 1 - dot(approach, direction)));
        if (candidate.direction) return 1 - dot(candidate.direction, direction);
        const border = nearest(candidate.point, ring), tangent = unit(sub(ring[border.index + 1], ring[border.index]));
        return 1 - Math.abs(cross(tangent, direction));
    }

    function work(piece, options) {
        if (piece.properties.acceptable) return 0;
        const ratio = piece.properties.areaM2 / options.targetAreaM2;
        return ratio * (Math.max(0, ratio - 1) + Math.max(0, piece.properties.longestSideM / options.maxSideM - 1));
    }

    function shapePreference(pieces, cuts) {
        const totalArea = pieces.reduce((sum, piece) => sum + piece.properties.areaM2, 0);
        const penalties = pieces.map(piece => piece.properties.shapePenalty);
        const average = pieces.reduce((sum, piece) => sum + piece.properties.shapePenalty * piece.properties.areaM2, 0) / totalArea;
        return (average + Math.max(...penalties) * 0.25) * 1000 + cuts.length * 50
            + cuts.reduce((sum, cut) => sum + cut.lengthM * 0.02 + cut.bending, 0);
    }

    function solutionScore(pieces, cuts, options) {
        return (pieces.some(piece => !piece.properties.acceptable) ? 1e9 : 0)
            + pieces.reduce((sum, piece) => sum + work(piece, options), 0) * 1e6
            + shapePreference(pieces, cuts);
    }

    // Retain both progress toward the size limits and a straighter street layout. Selecting the
    // beam by immediate area balance alone can permanently discard a good rectangular grid.
    function diverse(items, score, shapeScore, limit) {
        const progress = items.slice().sort((a, b) => score(a) - score(b));
        const shape = items.slice().sort((a, b) => shapeScore(a) - shapeScore(b) || score(a) - score(b));
        return [...new Set([...progress.slice(0, Math.ceil(limit / 2)), ...shape.slice(0, Math.ceil(limit / 2)), ...progress])].slice(0, limit);
    }

    function choicesForFace(parent, context) {
        if (context.cache.has(parent.key)) return context.cache.get(parent.key);
        const natural = candidatesForFace(parent, context.natural);
        const evaluate = candidates => {
            const choices = [];
            for (let i = 0; i < candidates.length; i++) for (let j = i + 1; j < candidates.length; j++) {
                if (context.testedPairs >= MAX_PAIRS) { context.limited = true; return choices; }
                context.testedPairs++;
                const a = candidates[i], b = candidates[j], direction = unit(sub(b.point, a.point));
                if (a.kind === 'dead-end' && dot(a.direction, direction) < 0) continue;
                if (b.kind === 'dead-end' && dot(b.direction, direction.map(v => -v)) < 0) continue;
                const path = [...a.path, ...b.path.slice().reverse()].filter((p, k, list) => !k || !same(p, list[k - 1]));
                const pieces = splitFace(parent, path, context.options);
                if (!pieces) continue;
                const remaining = pieces.reduce((sum, piece) => sum + work(piece, context.options), 0);
                if (remaining >= work(parent, context.options) - 1e-7) continue;
                const addedLengthM = distance(a.point, b.point);
                const bending = bendCost(a, direction, parent.rings[0]) + bendCost(b, direction.map(v => -v), parent.rings[0]);
                const cut = { points: [a.point, b.point], path, connectorIndex: a.path.length - 1,
                    fromKind: a.kind, toKind: b.kind, lengthM: addedLengthM,
                    bending,
                    kind: cutKind(a.kind, b.kind) };
                choices.push({ pieces, cut, score: solutionScore(pieces, [cut], context.options) });
            }
            return choices;
        };
        let choices = evaluate(natural);
        if (!choices.length && !context.limited) {
            const fallback = candidatesForFace(parent, context.fallback);
            if (fallback.length) {
                choices = evaluate([...natural, ...fallback]);
            }
        }
        const best = diverse(choices, choice => choice.score,
            choice => shapePreference(choice.pieces, [choice.cut]), 6);
        context.cache.set(parent.key, best);
        return best;
    }

    function stateScore(state, options) {
        return solutionScore(state.pieces, state.cuts, options);
    }

    function prepare({ block, roads }, turf, model) {
        if (block?.geometry?.type !== 'Polygon') throw new Error('Select a polygon block to subdivide.');
        if (!Array.isArray(roads?.features)) throw new Error('The selected block has no loaded road network. Refresh its area.');
        const project = projection(block);
        const natural = naturalCandidates(block, roads, project, turf, model);
        const rings = block.geometry.coordinates.map(ring => ring.map(project.project));
        return { project, natural: [...natural, ...deadEndProjections(rings, natural)] };
    }

    function limits(input, project, turf) {
        const options = { targetAreaM2: input?.targetAreaM2 ?? 10000, maxSideM: input?.maxSideM ?? 150,
            perimeterStepM: input?.perimeterStepM ?? 150 };
        if (!Number.isFinite(options.targetAreaM2) || options.targetAreaM2 < 1000 || options.targetAreaM2 > 50000) throw new Error('Maximum block area must be between 1,000 and 50,000 m².');
        if (![options.maxSideM, options.perimeterStepM].every(value => Number.isFinite(value) && value >= 20 && value <= 1000)) throw new Error('Side and spacing values must be between 20 and 1,000 m.');
        // Use the inspector's Turf area convention for both limits and output; metre projection
        // is only for line geometry and fitted side lengths, not a second definition of area.
        options.areaOf = rings => turf.area(feature('Polygon', rings.map(ring => ring.map(project.unproject))));
        return options;
    }

    function preview(input, turf, model, prepared = prepare(input, turf, model)) {
        const { project, natural } = prepared;
        const options = limits(input.options, project, turf);
        const parent = { rings: input.block.geometry.coordinates.map(ring => ring.map(project.project)) };
        const fallback = perimeterCandidates(parent, natural, options.perimeterStepM);
        return { candidates: fc([...natural, ...fallback].map(c => feature('Point', project.unproject(c.point), {
            id: c.id, kind: c.kind,
            ...(c.junctionPoint ? { junctionPoint: project.unproject(c.junctionPoint), projectionDistanceM: c.projectionDistanceM } : {}),
            ...(c.projectionSources ? { projectionSources: c.projectionSources.map(source => ({
                ...source, sourcePoint: project.unproject(source.sourcePoint)
            })) } : {}),
            ...(c.provenance ? { provenance: {
                ...c.provenance, sourcePoint: project.unproject(c.provenance.sourcePoint),
                boundarySource: project.unproject(c.provenance.boundarySource),
                perimeterPath: c.provenance.perimeterPath.map(project.unproject)
            } } : {})
        }))),
            stats: { tCount: natural.filter(c => c.kind === 't').length,
                deadEndCount: natural.filter(c => c.kind === 'dead-end').length,
                deadEndProjectionCount: natural.filter(c => c.kind === 'dead-end-projection').length, fallbackCount: fallback.length } };
    }

    // Place text in usable interior space, including concave pieces and pieces with holes.
    // Search cells by their possible clearance; the cap bounds work on detailed road outlines.
    function labelPoint(rings) {
        const outer = rings[0], xs = outer.map(p => p[0]), ys = outer.map(p => p[1]);
        const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
        const span = Math.max(maxX - minX, maxY - minY), precision = Math.max(0.1, span / 1000);
        const cell = (point, half = 0) => {
            const d = Math.min(...rings.map(ring => nearest(point, ring).distance))
                * (inRing(point, outer) && !rings.slice(1).some(ring => inRing(point, ring)) ? 1 : -1);
            return { point, half, d, potential: d + half * Math.SQRT2 };
        };
        let best = cell(outer[0]);
        // An inward offset from a real outer edge is an interior seed even when the centre
        // lies in a courtyard or outside an L-shaped piece.
        const winding = Math.sign(outer.slice(1).reduce((sum, p, i) => sum + cross(outer[i], p), 0));
        for (let i = 1; i < outer.length; i++) {
            const a = outer[i - 1], b = outer[i], direction = unit(sub(b, a));
            for (let offset = Math.min(distance(a, b) / 4, span / 20); offset > 1e-6; offset /= 2) {
                const candidate = cell([(a[0] + b[0]) / 2 - direction[1] * winding * offset,
                    (a[1] + b[1]) / 2 + direction[0] * winding * offset]);
                if (candidate.d > best.d) best = candidate;
                if (candidate.d > 0) break;
            }
        }
        const queue = [cell([(minX + maxX) / 2, (minY + maxY) / 2], span / 2)];
        const insert = candidate => {
            let lo = 0, hi = queue.length;
            while (lo < hi) {
                const mid = (lo + hi) >> 1;
                if (queue[mid].potential < candidate.potential) lo = mid + 1; else hi = mid;
            }
            queue.splice(lo, 0, candidate);
        };
        for (let visited = 0; queue.length && visited < 2048; visited++) {
            const current = queue.pop();
            if (current.d > best.d) best = current;
            if (current.potential - best.d <= precision) continue;
            const half = current.half / 2;
            for (const x of [-half, half]) for (const y of [-half, half]) insert(cell([current.point[0] + x, current.point[1] + y], half));
        }
        return best.point;
    }

    function layoutFromState(state, project) {
        return {
            pieces: fc(state.pieces.map((piece, i) => feature('Polygon', piece.rings.map(ring => ring.map(project.unproject)), {
                ...piece.properties, index: i + 1, labelPoint: project.unproject(labelPoint(piece.rings))
            }))),
            cuts: fc(state.cuts.map(cut => feature('LineString', cut.points.map(project.unproject), { kind: cut.kind, fromKind: cut.fromKind, toKind: cut.toKind,
                lengthM: cut.lengthM, splitPath: cut.path.map(project.unproject), connectorIndex: cut.connectorIndex }))),
            stats: { acceptableCount: state.pieces.filter(piece => piece.properties.acceptable).length, blockCount: state.pieces.length,
                cutsCount: state.cuts.length, addedLengthM: state.cuts.reduce((sum, cut) => sum + cut.lengthM, 0) }
        };
    }

    function plan({ block, roads, options: input = {} }, turf, model) {
        const { project, natural } = prepare({ block, roads }, turf, model);
        const options = limits(input, project, turf);
        const original = face(block.geometry.coordinates.map(ring => ring.map(project.project)), options);
        const fallback = perimeterCandidates(original, natural, options.perimeterStepM);
        const context = { natural, fallback, options, cache: new Map(), testedPairs: 0, limited: false };
        let beam = [{ pieces: [original], cuts: [] }], completed = [];
        const unique = states => [...new Map(states.map(state => [state.pieces.map(piece => piece.key).sort().join('|'), state])).values()];
        for (let step = 0; step < MAX_CUTS; step++) {
            const next = [];
            for (const state of beam) {
                let parent = null, choices = [];
                for (const candidate of state.pieces.filter(piece => !piece.properties.acceptable).sort((a, b) => work(b, options) - work(a, options))) {
                    choices = choicesForFace(candidate, context);
                    if (choices.length) { parent = candidate; break; }
                }
                if (!parent) { completed.push(state); continue; }
                for (const choice of choices) next.push({ pieces: [...state.pieces.filter(piece => piece !== parent), ...choice.pieces], cuts: [...state.cuts, choice.cut] });
            }
            if (!next.length) { beam = []; break; }
            beam = diverse(unique(next), state => stateScore(state, options),
                state => shapePreference(state.pieces, state.cuts), BEAM_WIDTH);
            if (context.limited) break;
            if (step === MAX_CUTS - 1) context.limited = true;
        }
        const winners = unique([...completed, ...beam]).sort((a, b) => stateScore(a, options) - stateScore(b, options)).slice(0, 5);
        return {
            layouts: winners.map(state => layoutFromState(state, project)),
            stats: { testedPairs: context.testedPairs, tCount: natural.filter(c => c.kind === 't').length,
                deadEndCount: natural.filter(c => c.kind === 'dead-end').length,
                deadEndProjectionCount: natural.filter(c => c.kind === 'dead-end-projection').length, fallbackCount: fallback.length, limited: context.limited }
        };
    }

    function restore({ block, subdivision }, turf) {
        if (block?.geometry?.type !== 'Polygon' || !Array.isArray(subdivision?.cuts) || subdivision.cuts.length > MAX_CUTS) throw new Error('Invalid shared splits.');
        const project = projection(block), options = limits(subdivision.options, project, turf);
        let pieces = [face(block.geometry.coordinates.map(ring => ring.map(project.project)), options)];
        const cuts = [], kinds = ['t', 'dead-end', 'perimeter', 'dead-end-projection'];
        let pointCount = 0;
        for (const item of subdivision.cuts) {
            const { path: raw, connectorIndex, fromKind, toKind } = item || {};
            if (!Array.isArray(raw) || raw.length < 2 || raw.length > 512 || (pointCount += raw.length) > 4096
                || !Number.isInteger(connectorIndex) || connectorIndex < 0 || connectorIndex >= raw.length - 1
                || !kinds.includes(fromKind) || !kinds.includes(toKind)
                || !raw.every(p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite)
                    && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90)) throw new Error('Invalid shared split path.');
            const path = raw.map(project.project);
            const points = path.slice(connectorIndex, connectorIndex + 2);
            let parentIndex = -1, children = null;
            for (let i = 0; i < pieces.length; i++) {
                children = splitFace(pieces[i], path, options);
                if (children) { parentIndex = i; break; }
            }
            if (!children || distance(...points) < EPS) throw new Error('Shared splits do not fit this block.');
            pieces = [...pieces.filter((_, i) => i !== parentIndex), ...children];
            cuts.push({ path, points, connectorIndex, fromKind, toKind, lengthM: distance(...points),
                kind: cutKind(fromKind, toKind) });
        }
        return { layouts: [layoutFromState({ pieces, cuts }, project)], stats: { restored: true } };
    }

    return { plan, preview, prepare, restore, measure, splitFace, perimeterCandidates };
});
