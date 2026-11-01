import { appTurf as turf } from '../agents/mcp-geometry.js';

const feature = geometry => ({ type: 'Feature', properties: {}, geometry });
const point = coordinates => feature({ type: 'Point', coordinates });
const validPosition = p => Array.isArray(p) && p.length >= 2 && p.slice(0, 2).every(Number.isFinite);
const positions = geometry => {
    if (!geometry) return [];
    if (geometry.type === 'GeometryCollection') return (geometry.geometries || []).flatMap(positions);
    const walk = value => Array.isArray(value) && value.length >= 2 && typeof value[0] === 'number'
        ? (validPosition(value) ? [value] : []) : Array.isArray(value) ? value.flatMap(walk) : [];
    return walk(geometry.coordinates);
};
const geometryFeature = item => item?.type === 'Feature' ? item : item?.geometry ? feature(item.geometry) : null;
const key = v => String(v ?? '').trim().toLocaleLowerCase();
const kind = geometry => ['Polygon', 'MultiPolygon'].includes(geometry?.type) ? 'outline'
    : ['LineString', 'MultiLineString'].includes(geometry?.type) ? 'centerline' : null;
const local = ([x, y], lat) => [x * 111320 * Math.cos(lat * Math.PI / 180), y * 111320];
const directionVector = direction => {
    if (typeof direction === 'number' && Number.isFinite(direction)) {
        const radians = ((direction % 360) + 360) % 360 * Math.PI / 180;
        return [Math.sin(radians), Math.cos(radians)];
    }
    const bearings = {
        n: 0, north: 0, up: 0, ne: 45, northeast: 45, 'up-right': 45,
        e: 90, east: 90, right: 90, se: 135, southeast: 135, 'down-right': 135,
        s: 180, south: 180, down: 180, sw: 225, southwest: 225, 'down-left': 225,
        w: 270, west: 270, left: 270, nw: 315, northwest: 315, 'up-left': 315
    };
    const bearing = bearings[String(direction ?? '').trim().toLowerCase()];
    if (bearing == null) return null;
    const radians = bearing * Math.PI / 180;
    return [Math.sin(radians), Math.cos(radians)];
};
const lines = geometry => geometry?.type === 'LineString' ? [geometry.coordinates]
    : geometry?.type === 'MultiLineString' ? geometry.coordinates
        : geometry?.type === 'Polygon' ? geometry.coordinates.map(ring => ring.slice(0, -1))
            : geometry?.type === 'MultiPolygon' ? geometry.coordinates.flatMap(poly => poly.map(ring => ring.slice(0, -1))) : [];
const polygons = geometry => geometry?.type === 'Polygon' ? [geometry.coordinates]
    : geometry?.type === 'MultiPolygon' ? geometry.coordinates : [];
const distance = (a, b) => turf.distance(point(a), point(b), { units: 'meters' });

function connectedTo(a, b, toleranceM = 0.5) {
    const endpoints = geometry => geometry.type === 'LineString' ? [geometry.coordinates[0], geometry.coordinates.at(-1)]
        : geometry.type === 'MultiLineString' ? geometry.coordinates.flatMap(line => [line[0], line.at(-1)]) : [];
    return endpoints(a).some(p => endpoints(b).some(q => distance(p, q) <= toleranceM));
}

function connectedLines(seed, all, metadata) {
    const candidates = all.filter(f => ['LineString', 'MultiLineString'].includes(f.geometry?.type) &&
        key(f.properties?.name) === key(metadata.name) && key(f.properties?.category) === key(metadata.category));
    const component = [];
    const used = new Set();
    const append = f => {
        if (used.has(f)) return;
        used.add(f);
        component.push(...lines(f.geometry));
    };
    append(seed);
    for (let cursor = 0; cursor < component.length; cursor++) {
        for (const candidate of candidates) {
            if (used.has(candidate)) continue;
            if (component.some(part => connectedTo({ type: 'LineString', coordinates: part }, candidate.geometry))) append(candidate);
        }
    }
    const geometry = component.length === 1 ? { type: 'LineString', coordinates: component[0] } : { type: 'MultiLineString', coordinates: component };
    return validLineNetwork(geometry) ? geometry : null;
}

function outlineFor(seed, all, connectedGeometry) {
    const seedGeom = feature(connectedGeometry || seed.geometry);
    const id = String(seed.properties?.osmId ?? '');
    const outlineCandidates = all.filter(f => ['Polygon', 'MultiPolygon'].includes(f.geometry?.type) &&
        (String(f.properties?.osmId ?? '') === id ||
            (key(f.properties?.name) === key(seed.properties?.name) && key(f.properties?.category) === key(seed.properties?.category))) &&
        turf.booleanIntersects(seedGeom, feature(f.geometry)));
    if (!outlineCandidates.length) return null;
    for (const candidate of outlineCandidates) {
        const parts = candidate.geometry.type === 'Polygon' ? [candidate.geometry.coordinates] : candidate.geometry.coordinates;
        for (let i = 0; i < parts.length; i++) for (const other of parts.slice(i + 1)) {
            if (!turf.booleanIntersects(feature({ type: 'Polygon', coordinates: parts[i] }), feature({ type: 'Polygon', coordinates: other }))) return null;
        }
    }
    // A disconnected outline match is ambiguous: never bridge a gap by name alone.
    if (outlineCandidates.length > 1 && outlineCandidates.some((a, i) => outlineCandidates.slice(i + 1).some(b => !turf.booleanIntersects(feature(a.geometry), feature(b.geometry))))) return null;
    let merged = outlineCandidates[0].geometry;
    for (const next of outlineCandidates.slice(1)) {
        const result = turf.union(feature(merged), feature(next.geometry));
        if (!result?.geometry) return null;
        merged = result.geometry;
    }
    return merged;
}

function validGeometry(geometry) {
    const geometryKind = kind(geometry);
    if (!geometryKind || !positions(geometry).every(validPosition)) return false;
    if (geometryKind === 'centerline') return lines(geometry).length > 0 && lines(geometry).every(line => line.length >= 2 && line.every(validPosition));
    return polygons(geometry).length > 0 && polygons(geometry).every(polygon => polygon.length > 0 && polygon.every(ring =>
        ring.length >= 4 && ring.every(validPosition) && ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1]));
}

function validLineNetwork(geometry) {
    const parts = lines(geometry);
    if (!parts.length || parts.some(line => line.length < 2 || !line.every(validPosition))) return false;
    const nodes = [];
    const nodeIndex = point => {
        const found = nodes.findIndex(node => distance(node.point, point) <= 0.5);
        if (found >= 0) return found;
        nodes.push({ point, degree: 0 });
        return nodes.length - 1;
    };
    const edges = parts.map(line => [nodeIndex(line[0]), nodeIndex(line.at(-1))]);
    if (edges.some(([a, b]) => a === b)) return false;
    for (const [a, b] of edges) { nodes[a].degree++; nodes[b].degree++; }
    if (nodes.filter(node => node.degree === 1).length !== 2 || !nodes.every(node => node.degree === 1 || node.degree === 2)) return false;
    const adjacent = nodes.map(() => []);
    for (const [a, b] of edges) { adjacent[a].push(b); adjacent[b].push(a); }
    const reached = new Set([0]), pending = [0];
    while (pending.length) for (const next of adjacent[pending.pop()]) if (!reached.has(next)) { reached.add(next); pending.push(next); }
    return reached.size === nodes.length;
}

function supportAnchor(geometry, direction, relation) {
    const v = directionVector(direction);
    const rings = exteriorRings(geometry);
    if (!v || !rings.length) return null;
    const all = rings.flat();
    const lat = all.reduce((n, p) => n + p[1], 0) / all.length;
    const xy = p => local(p, lat);
    const score = p => { const q = xy(p); return q[0] * v[0] + q[1] * v[1]; };
    if (relation === 'corner') {
        const p = all.reduce((best, current) => score(current) > score(best) ? current : best, all[0]);
        return { anchor: p.slice(0, 2), segment: null };
    }
    if (relation === 'end') {
        const bounds = all.slice(0, -1).map(xy);
        const mean = bounds.reduce((sum, p) => [sum[0] + p[0] / bounds.length, sum[1] + p[1] / bounds.length], [0, 0]);
        const xx = bounds.reduce((sum, p) => sum + (p[0] - mean[0]) ** 2, 0);
        const yy = bounds.reduce((sum, p) => sum + (p[1] - mean[1]) ** 2, 0);
        const xyCov = bounds.reduce((sum, p) => sum + (p[0] - mean[0]) * (p[1] - mean[1]), 0);
        const theta = 0.5 * Math.atan2(2 * xyCov, xx - yy);
        const axis = [Math.cos(theta), Math.sin(theta)];
        const sign = (v[0] * axis[0] + v[1] * axis[1]) >= 0 ? 1 : -1;
        const terminal = all.reduce((best, p) => (xy(p)[0] * axis[0] + xy(p)[1] * axis[1]) * sign >
            (xy(best)[0] * axis[0] + xy(best)[1] * axis[1]) * sign ? p : best, all[0]);
        return { anchor: terminal.slice(0, 2), segment: null };
    }
    // Select the support edge. Its midpoint lies on the real exterior ring, including rotated outlines.
    let best = null;
    for (const ring of rings) for (let i = 0; i < ring.length - 1; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length];
        if (distance(a, b) <= 0) continue;
        const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        const value = score(mid);
        if (!best || value > best.value) best = { a, b, mid, value };
    }
    const p = relation === 'edge' ? best.mid : all.reduce((p, q) => score(q) > score(p) ? q : p, all[0]);
    return { anchor: p.slice(0, 2), segment: relation === 'edge' ? [best.a.slice(0, 2), best.b.slice(0, 2)] : null };
}

function lineAnchor(geometry, direction) {
    const v = directionVector(direction);
    if (!v) return null;
    const parts = lines(geometry);
    const endpoints = parts.flatMap(line => [line[0], line[line.length - 1]]).filter(validPosition);
    if (!endpoints.length) return null;
    // A valid terminal is an endpoint not shared by another component within the OSM connection tolerance.
    const terminals = endpoints.filter((p, i) => endpoints.filter((q, j) => j !== i).every(q => distance(p, q) > 0.5));
    if (!terminals.length) return null;
    const lat = terminals.reduce((n, p) => n + p[1], 0) / terminals.length;
    const value = p => { const q = local(p, lat); return q[0] * v[0] + q[1] * v[1]; };
    return terminals.reduce((a, b) => value(b) > value(a) ? b : a, terminals[0]).slice(0, 2);
}

export function landmarkTarget({ features, osmId, relation, direction } = {}) {
    if (!Array.isArray(features) || !osmId || !['edge', 'corner', 'end', 'beside'].includes(relation)) return null;
    if ((relation !== 'beside' && direction == null) || (direction != null && !directionVector(direction))) return null;
    const all = features.map(geometryFeature).filter(f => f && validGeometry(f.geometry));
    const seed = all.find(f => String(f.properties?.osmId ?? '') === String(osmId));
    if (!seed) return null;
    const lineSeed = ['LineString', 'MultiLineString'].includes(seed.geometry.type);
    const centerline = lineSeed ? connectedLines(seed, all, seed.properties) : null;
    if (lineSeed && !centerline) return null;
    const outline = outlineFor(seed, all, centerline);
    const geometry = outline || centerline;
    if (!geometry || !validGeometry(geometry)) return null;
    let anchor, edge;
    if (relation === 'beside') {
        if (kind(geometry) === 'outline' && directionVector(direction)) anchor = supportAnchor(geometry, direction, 'edge')?.anchor;
        else if (kind(geometry) === 'centerline' && directionVector(direction)) anchor = lineAnchor(geometry, direction);
        else anchor = positions(geometry)[0].slice(0, 2);
    } else if (kind(geometry) === 'outline') {
        const selected = supportAnchor(geometry, direction, relation);
        anchor = selected?.anchor; edge = selected?.segment;
    } else anchor = lineAnchor(geometry, direction);
    if (!anchor) return null;
    const targetGeometry = relation === 'beside'
        ? kind(geometry) === 'outline' ? { type: 'MultiLineString', coordinates: exteriorRings(geometry) } : geometry
        : kind(geometry) === 'outline'
            ? edge ? { type: 'LineString', coordinates: edge } : { type: 'Point', coordinates: anchor }
            : { type: 'Point', coordinates: anchor };
    return {
        anchor,
        geometry: targetGeometry,
        landmarkGeometry: geometry,
        interpretation: { relation, direction: direction ?? null, geometryKind: kind(geometry) }
    };
}

function parcelId(parcel) {
    const p = parcel?.properties || {};
    return String(p.parcelId ?? p.parcel_id ?? p.id ?? parcel?.id ?? '');
}

function boundaryRings(geometry) {
    if (geometry?.type === 'Polygon') return geometry.coordinates;
    if (geometry?.type === 'MultiPolygon') return geometry.coordinates.flat();
    return [];
}

function exteriorRings(geometry) {
    if (geometry?.type === 'Polygon') return geometry.coordinates.slice(0, 1);
    if (geometry?.type === 'MultiPolygon') return geometry.coordinates.map(poly => poly[0]);
    return [];
}

function closestOnLine(pointFeature, line) {
    if (!line || line.length < 2) return null;
    return turf.nearestPointOnLine(feature({ type: 'LineString', coordinates: line }), pointFeature, { units: 'meters' });
}

function targetDistanceToBoundary(targetGeometry, parcelGeometry) {
    const rings = boundaryRings(parcelGeometry);
    if (!rings.length) return null;
    const targetLines = lines(targetGeometry);
    const targetPositions = positions(targetGeometry);
    let best = null;
    for (const ring of rings) {
        const closed = ring;
        for (const line of targetLines) {
            const intersections = turf.lineIntersect(feature({ type: 'LineString', coordinates: closed }), feature({ type: 'LineString', coordinates: line })).features;
            if (intersections.length) return { distanceM: 0, point: intersections[0].geometry.coordinates };
        }
        for (const p of targetPositions) {
            const near = closestOnLine(point(p), closed);
            if (near && (!best || near.properties.dist < best.distanceM)) best = { distanceM: near.properties.dist, point: near.geometry.coordinates };
        }
        for (const p of ring) for (const line of targetLines) {
            const near = closestOnLine(point(p), line);
            if (near && (!best || near.properties.dist < best.distanceM)) best = { distanceM: near.properties.dist, point: p.slice(0, 2) };
        }
        for (const line of targetLines) for (const p of line) {
            const near = closestOnLine(point(p), closed);
            if (near && (!best || near.properties.dist < best.distanceM)) best = { distanceM: near.properties.dist, point: near.geometry.coordinates };
        }
    }
    return best;
}

export function rankLandmarkParcels({ target, parcels, maxDistanceM = 50 } = {}) {
    if (!target?.geometry || !target?.landmarkGeometry || !Array.isArray(parcels) || !Number.isFinite(maxDistanceM) || maxDistanceM < 0 || maxDistanceM > 200) return [];
    const vector = directionVector(target.interpretation?.direction);
    const anchor = target.anchor;
    const out = new Map();
    for (const parcel of parcels) {
        const geometry = parcel?.geometry;
        const id = parcelId(parcel);
        if (!id || !['Polygon', 'MultiPolygon'].includes(geometry?.type) || !validGeometry(geometry)) continue;
        const parcelFeature = feature(geometry);
        const targetFeature = feature(target.landmarkGeometry);
        if (turf.booleanIntersects(parcelFeature, targetFeature)) {
            let overlap = 0;
            try { const intersection = turf.intersect(parcelFeature, targetFeature); if (intersection) overlap = turf.area(intersection); }
            catch { continue; }
            if (overlap > 1 || targetFeature.geometry.type.includes('Line') || targetFeature.geometry.type === 'MultiLineString') continue;
        }
        const closest = targetDistanceToBoundary(target.geometry, geometry);
        if (!closest || closest.distanceM > maxDistanceM) continue;
        if (vector && anchor) {
            const lat = (anchor[1] + closest.point[1]) / 2;
            const a = local(anchor, lat), p = local(closest.point, lat);
            if ((p[0] - a[0]) * vector[0] + (p[1] - a[1]) * vector[1] < -0.5) continue;
        }
        const candidate = { parcelId: id, point: closest.point, distanceM: closest.distanceM };
        const prior = out.get(id);
        if (!prior || candidate.distanceM < prior.distanceM || (candidate.distanceM === prior.distanceM &&
            (candidate.point[0] < prior.point[0] || (candidate.point[0] === prior.point[0] && candidate.point[1] < prior.point[1])))) out.set(id, candidate);
    }
    return [...out.values()].sort((a, b) => a.distanceM - b.distanceM || a.parcelId.localeCompare(b.parcelId));
}
