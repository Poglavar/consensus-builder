// Pure geometry for the vLAB restatement (README.md): reads a glTF binary's named meshes as triangles,
// fits the model's plan to the map from matched landmarks, and turns triangles into plan polygons,
// roof-height parts and centrelines. No network, no database, no files.

import { createRequire } from 'node:module';

const require = createRequire(new URL('../../backend/package.json', import.meta.url));
const polygonClipping = require('polygon-clipping');

// ---- glTF binary ---------------------------------------------------------------------------------------

/** Named mesh nodes of a GLB as { [name]: [[x, y, z] × 3] } in model units (y up). */
export function glbTriangles(buffer) {
    if (buffer.readUInt32LE(0) !== 0x46546c67) throw new Error('not a glTF binary');
    const jsonLength = buffer.readUInt32LE(12);
    const gltf = JSON.parse(buffer.subarray(20, 20 + jsonLength).toString('utf8'));
    const binStart = 20 + jsonLength;
    const bin = buffer.subarray(binStart + 8, binStart + 8 + buffer.readUInt32LE(binStart));
    const read = index => {
        const accessor = gltf.accessors[index];
        const view = gltf.bufferViews[accessor.bufferView];
        const offset = (view.byteOffset || 0) + (accessor.byteOffset || 0);
        if (accessor.componentType === 5126) {
            const stride = view.byteStride || 12;
            return Array.from({ length: accessor.count }, (_, i) => [0, 4, 8].map(k => bin.readFloatLE(offset + i * stride + k)));
        }
        const size = { 5121: 1, 5123: 2, 5125: 4 }[accessor.componentType];
        const method = { 1: 'readUInt8', 2: 'readUInt16LE', 4: 'readUInt32LE' }[size];
        return Array.from({ length: accessor.count }, (_, i) => bin[method](offset + i * size));
    };
    const out = {};
    for (const node of gltf.nodes) {
        if (node.mesh == null) continue;
        if (node.matrix || node.translation || node.rotation || node.scale) throw new Error(`${node.name}: node transforms are not supported`);
        const triangles = [];
        for (const primitive of gltf.meshes[node.mesh].primitives) {
            if ((primitive.mode ?? 4) !== 4) continue;
            const positions = read(primitive.attributes.POSITION);
            const indices = primitive.indices != null ? read(primitive.indices) : positions.map((_, i) => i);
            for (let i = 0; i + 2 < indices.length; i += 3) triangles.push([positions[indices[i]], positions[indices[i + 1]], positions[indices[i + 2]]]);
        }
        out[node.name] = triangles;
    }
    return out;
}

// ---- placing the model ---------------------------------------------------------------------------------

// The model's plan: glTF is y-up with -z north, so a plan point is (x, -z).
export const planOf = ([x, , z]) => [x, -z];

export function bboxCentre(triangles) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const triangle of triangles) for (const vertex of triangle) {
        const [x, y] = planOf(vertex);
        minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    return [(minX + maxX) / 2, (minY + maxY) / 2];
}

/**
 * Least-squares similarity (rotation, uniform scale, translation) taking plan points P onto map points
 * Q (both metric). Returns { scale, rotationDeg, apply, residualsM, rmsM }.
 */
export function fitSimilarity(P, Q) {
    if (P.length !== Q.length || P.length < 3) throw new Error('a fit needs at least three matched points');
    const mean = points => points.reduce((sum, [x, y]) => [sum[0] + x / points.length, sum[1] + y / points.length], [0, 0]);
    const [px, py] = mean(P), [qx, qy] = mean(Q);
    let a = 0, b = 0, d = 0;
    P.forEach(([x0, y0], i) => {
        const x = x0 - px, y = y0 - py, u = Q[i][0] - qx, w = Q[i][1] - qy;
        a += x * u + y * w; b += x * w - y * u; d += x * x + y * y;
    });
    const scale = Math.hypot(a, b) / d, theta = Math.atan2(b, a), cos = Math.cos(theta) * scale, sin = Math.sin(theta) * scale;
    const apply = ([x0, y0]) => { const x = x0 - px, y = y0 - py; return [qx + x * cos - y * sin, qy + x * sin + y * cos]; };
    const residualsM = P.map((p, i) => Math.hypot(apply(p)[0] - Q[i][0], apply(p)[1] - Q[i][1]));
    return { scale, rotationDeg: theta * 180 / Math.PI, apply, residualsM, rmsM: Math.sqrt(residualsM.reduce((s, r) => s + r * r, 0) / residualsM.length) };
}

// ---- triangles to plan polygons ------------------------------------------------------------------------

const planArea = ([a, b, c]) => ((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;

// Normal's vertical share and sense, from model coordinates (y up).
function facing(triangle) {
    const [a, b, c] = triangle;
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const length = Math.hypot(...n);
    return length ? n[1] / length : 0;
}
// Horizontal in either winding: the exporter does not keep one face orientation.
export const isHorizontal = (triangle, minShare = 0.95) => Math.abs(facing(triangle)) >= minShare;
export const meanHeight = triangle => (triangle[0][1] + triangle[1][1] + triangle[2][1]) / 3;

// A centimetre grid: polygon-clipping's sweep line fails on near-coincident float edges, so inputs and
// every intermediate union are snapped to it, dropping the repeated vertices snapping makes.
const snap = value => Math.round(value * 100) / 100;
function snapMulti(multi) {
    return multi.map(polygon => polygon.map(ring => ring.map(([x, y]) => [snap(x), snap(y)])
        .filter((point, i, all) => i === 0 || point[0] !== all[i - 1][0] || point[1] !== all[i - 1][1]))
        .filter(ring => ring.length >= 4)).filter(polygon => polygon.length);
}

/**
 * Union of triangles' plan projections (placed by `place`), as polygon-clipping MultiPolygon rings.
 * Walls project to slivers: a triangle under minAreaM2, or thinner than minWidthM, adds no ground.
 */
export function unionTriangles(triangles, place, { minAreaM2 = 1e-4, minWidthM = 0.002 } = {}) {
    const pieces = [];
    for (const triangle of triangles) {
        const ring = triangle.map(vertex => place(planOf(vertex)).map(snap));
        const area = planArea(ring);
        const longest = Math.max(...[0, 1, 2].map(i => Math.hypot(ring[(i + 1) % 3][0] - ring[i][0], ring[(i + 1) % 3][1] - ring[i][1])));
        if (Math.abs(area) < minAreaM2 || (2 * Math.abs(area)) / longest < minWidthM) continue;
        const oriented = area > 0 ? ring : ring.slice().reverse();
        pieces.push([[[...oriented, oriented[0]]]]);
    }
    if (!pieces.length) return [];
    // Batches keep each union small: one call over tens of thousands of triangles is slow.
    let level = pieces;
    while (level.length > 1) {
        const next = [];
        for (let i = 0; i < level.length; i += 16) next.push(snapMulti(polygonClipping.union(...level.slice(i, i + 16))));
        level = next;
    }
    return level[0];
}

/**
 * Union of triangles' plan projections on a cellM grid: a cell is covered when its centre is inside a
 * triangle, row runs become rectangles in integer cell units (exact, so the union cannot fail on float
 * noise), and the staircase is simplified by toleranceM. For surfaces whose meshes are many slivers
 * (terraced parks), where an exact union of the triangles breaks polygon-clipping.
 */
export function rasterUnion(triangles, place, { cellM = 0.25, toleranceM = 0.3 } = {}) {
    const rows = new Map();
    for (const triangle of triangles) {
        const [a, b, c] = triangle.map(vertex => place(planOf(vertex)).map(value => value / cellM));
        const minRow = Math.ceil(Math.min(a[1], b[1], c[1]) - 0.5), maxRow = Math.floor(Math.max(a[1], b[1], c[1]) - 0.5);
        for (let row = minRow; row <= maxRow; row += 1) {
            const y = row + 0.5;
            const xs = [];
            for (const [p, q] of [[a, b], [b, c], [c, a]]) {
                if ((p[1] <= y && q[1] > y) || (q[1] <= y && p[1] > y)) xs.push(p[0] + (y - p[1]) / (q[1] - p[1]) * (q[0] - p[0]));
            }
            if (xs.length < 2) continue;
            const from = Math.ceil(Math.min(...xs) - 0.5), to = Math.floor(Math.max(...xs) - 0.5);
            if (to < from) continue;
            if (!rows.has(row)) rows.set(row, new Set());
            const cells = rows.get(row);
            for (let column = from; column <= to; column += 1) cells.add(column);
        }
    }
    const rectangles = [];
    for (const [row, cells] of rows) {
        const columns = [...cells].sort((x, y) => x - y);
        let start = columns[0];
        for (let i = 1; i <= columns.length; i += 1) {
            if (i < columns.length && columns[i] === columns[i - 1] + 1) continue;
            const end = columns[i - 1] + 1;
            rectangles.push([[[start, row], [end, row], [end, row + 1], [start, row + 1], [start, row]]]);
            start = columns[i];
        }
    }
    if (!rectangles.length) return [];
    let level = rectangles.map(rectangle => [rectangle]);
    while (level.length > 1) {
        const next = [];
        for (let i = 0; i < level.length; i += 64) next.push(polygonClipping.union(...level.slice(i, i + 64)));
        level = next;
    }
    const scaled = level[0].map(polygon => polygon.map(ring => ring.map(([x, y]) => [x * cellM, y * cellM])));
    return scaled.map(polygon => polygon.map(ring => simplifyRing(ring, toleranceM))).filter(polygon => polygon[0].length >= 4)
        .map(polygon => [polygon[0], ...polygon.slice(1).filter(ring => ring.length >= 4)]);
}

// Douglas–Peucker on a closed ring (first point = last).
function simplifyRing(ring, toleranceM) {
    const open = ring.slice(0, -1).map(xy => ({ xy }));
    // Split at the two mutually farthest-apart vertices so both halves have fixed ends.
    let far = 0;
    open.forEach((p, i) => { if (Math.hypot(p.xy[0] - open[0].xy[0], p.xy[1] - open[0].xy[1]) > Math.hypot(open[far].xy[0] - open[0].xy[0], open[far].xy[1] - open[0].xy[1])) far = i; });
    if (far === 0) return ring;
    const first = simplifyLine(open.slice(0, far + 1), toleranceM);
    const second = simplifyLine([...open.slice(far), open[0]], toleranceM);
    const out = [...first.slice(0, -1), ...second.slice(0, -1)].map(p => p.xy);
    return [...out, out[0]];
}

export const multiArea = multi => multi.reduce((sum, polygon) => sum + polygon.reduce((s, ring, i) => {
    let a = 0;
    for (let k = 0; k < ring.length - 1; k += 1) a += ring[k][0] * ring[k + 1][1] - ring[k + 1][0] * ring[k][1];
    return s + (i === 0 ? 1 : -1) * Math.abs(a / 2);
}, 0), 0);

/** Drops polygons and holes under minM2 (slivers a union or subtraction leaves). */
export function withoutSlivers(multi, minM2) {
    return multi
        .map(polygon => [polygon[0], ...polygon.slice(1).filter(hole => multiArea([[hole]]) >= minM2)])
        .filter(polygon => multiArea([[polygon[0]]]) >= minM2);
}

/**
 * Stepped massing from horizontal roof faces: faces are banded by height (bandM), bands under minBandM2
 * are parapets, stair heads and the like and are dropped, and each kept band is its roof's plan less
 * every higher band, so the parts never stack. → [{ roofM, polygons }] from the highest down.
 */
export function roofParts(triangles, place, { minHeightM, bandM = 0.5, minBandM2 = 50, minPartM2 = 5 }) {
    const bands = new Map();
    for (const triangle of triangles) {
        if (!isHorizontal(triangle)) continue;
        const height = meanHeight(triangle);
        if (height < minHeightM) continue;
        const key = Math.round(height / bandM) * bandM;
        if (!bands.has(key)) bands.set(key, []);
        bands.get(key).push(triangle);
    }
    const kept = [...bands.entries()]
        .map(([roofM, faces]) => ({ roofM, polygons: unionTriangles(faces, place) }))
        .filter(band => multiArea(band.polygons) >= minBandM2)
        .sort((a, b) => b.roofM - a.roofM);
    const parts = [];
    let above = [];
    for (const band of kept) {
        const own = above.length ? polygonClipping.difference(band.polygons, above) : band.polygons;
        const polygons = withoutSlivers(own, minPartM2);
        if (polygons.length) parts.push({ roofM: band.roofM, polygons });
        above = above.length ? polygonClipping.union(above, band.polygons) : band.polygons;
    }
    return parts;
}

// ---- centrelines ---------------------------------------------------------------------------------------

/**
 * The centreline of a ribbon mesh (an arrow, a ramp): vertices are binned on a cellM grid, the cell
 * centroids are chained from the cell farthest from the ribbon's middle by nearest neighbour, and the
 * chain is averaged over windowM. → [{ xy, heightM }] in placed metres.
 */
export function ribbonCentreline(triangles, place, { cellM = 3, windowM = 6 } = {}) {
    const cells = new Map();
    for (const triangle of triangles) for (const vertex of triangle) {
        const xy = place(planOf(vertex));
        const key = `${Math.floor(xy[0] / cellM)},${Math.floor(xy[1] / cellM)}`;
        const cell = cells.get(key) || { x: 0, y: 0, h: 0, n: 0 };
        cell.x += xy[0]; cell.y += xy[1]; cell.h += vertex[1]; cell.n += 1;
        cells.set(key, cell);
    }
    const points = [...cells.values()].map(cell => ({ xy: [cell.x / cell.n, cell.y / cell.n], heightM: cell.h / cell.n }));
    const middle = points.reduce((s, p) => [s[0] + p.xy[0] / points.length, s[1] + p.xy[1] / points.length], [0, 0]);
    const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    let current = points.reduce((far, p) => (distance(p.xy, middle) > distance(far.xy, middle) ? p : far), points[0]);
    const chain = [current];
    const left = new Set(points); left.delete(current);
    while (left.size) {
        let best = null;
        for (const p of left) if (!best || distance(p.xy, current.xy) < distance(best.xy, current.xy)) best = p;
        left.delete(best); chain.push(best); current = best;
    }
    // Moving average over windowM of path length keeps the bends and removes the grid's zigzag.
    const along = [0];
    for (let i = 1; i < chain.length; i += 1) along.push(along[i - 1] + distance(chain[i - 1].xy, chain[i].xy));
    return chain.map((p, i) => {
        const near = chain.filter((_, k) => Math.abs(along[k] - along[i]) <= windowM / 2);
        return {
            xy: [near.reduce((s, q) => s + q.xy[0], 0) / near.length, near.reduce((s, q) => s + q.xy[1], 0) / near.length],
            heightM: near.reduce((s, q) => s + q.heightM, 0) / near.length
        };
    });
}

/**
 * The centreline of a ribbon that runs one way (no bend back): vertices are projected on the ribbon's
 * principal axis and averaged in binM bins along it. → [{ xy, heightM }] in placed metres.
 */
export function axisCentreline(triangles, place, { binM = 4 } = {}) {
    const vertices = triangles.flat().map(vertex => ({ xy: place(planOf(vertex)), heightM: vertex[1] }));
    const [mx, my] = vertices.reduce((s, v) => [s[0] + v.xy[0] / vertices.length, s[1] + v.xy[1] / vertices.length], [0, 0]);
    let sxx = 0, syy = 0, sxy = 0;
    for (const { xy: [x, y] } of vertices) { sxx += (x - mx) ** 2; syy += (y - my) ** 2; sxy += (x - mx) * (y - my); }
    const angle = Math.atan2(2 * sxy, sxx - syy) / 2, ux = Math.cos(angle), uy = Math.sin(angle);
    const bins = new Map();
    for (const v of vertices) {
        const key = Math.floor(((v.xy[0] - mx) * ux + (v.xy[1] - my) * uy) / binM);
        const bin = bins.get(key) || { x: 0, y: 0, h: 0, n: 0 };
        bin.x += v.xy[0]; bin.y += v.xy[1]; bin.h += v.heightM; bin.n += 1;
        bins.set(key, bin);
    }
    return [...bins.entries()].sort((a, b) => a[0] - b[0]).map(([, bin]) => ({ xy: [bin.x / bin.n, bin.y / bin.n], heightM: bin.h / bin.n }));
}

/** Douglas–Peucker on [{ xy, ... }] with tolerance toleranceM; endpoints always stay. */
export function simplifyLine(points, toleranceM) {
    if (points.length <= 2) return points.slice();
    const [a, b] = [points[0].xy, points[points.length - 1].xy];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    let worst = 0, index = 0;
    for (let i = 1; i < points.length - 1; i += 1) {
        const [x, y] = points[i].xy;
        const offset = Math.abs((b[0] - a[0]) * (a[1] - y) - (a[0] - x) * (b[1] - a[1])) / length;
        if (offset > worst) { worst = offset; index = i; }
    }
    if (worst <= toleranceM) return [points[0], points[points.length - 1]];
    return [...simplifyLine(points.slice(0, index + 1), toleranceM).slice(0, -1), ...simplifyLine(points.slice(index), toleranceM)];
}
