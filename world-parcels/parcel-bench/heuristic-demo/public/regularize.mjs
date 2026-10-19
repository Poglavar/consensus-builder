// Straighten shared plot arcs once, with fixed junctions, bounded displacement and protected seeds.
import { cellPolygons } from './geometry.mjs';
import { paintPolygon } from './core.mjs';
const EPS = 1e-9;
const same = (a, b) => a[0] === b[0] && a[1] === b[1];
const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
export const ringArea = ring => ring.slice(1).reduce((area, p, i) => area + ring[i][0] * p[1] - p[0] * ring[i][1], 0) / 2;
export const polygonArea = polygons => polygons.reduce((sum, polygon) => sum + Math.abs(ringArea(polygon[0]))
  - polygon.slice(1).reduce((holes, ring) => holes + Math.abs(ringArea(ring)), 0), 0);

export function pointInPolygons([x, y], polygons) {
  return polygons.some(polygon => {
    let inside = false;
    for (const ring of polygon) for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i], b = ring[j];
      if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
    }
    return inside;
  });
}

function distanceSquared(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], length = dx * dx + dy * dy;
  const t = length ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length)) : 0;
  return (p[0] - a[0] - t * dx) ** 2 + (p[1] - a[1] - t * dy) ** 2;
}

function crosses(a, b, c, d) {
  const abC = cross(a, b, c), abD = cross(a, b, d), cdA = cross(c, d, a), cdB = cross(c, d, b);
  if (Math.abs(abC) < EPS && Math.abs(abD) < EPS) {
    const axis = Math.abs(b[0] - a[0]) > Math.abs(b[1] - a[1]) ? 0 : 1;
    return Math.min(Math.max(a[axis], b[axis]), Math.max(c[axis], d[axis]))
      - Math.max(Math.min(a[axis], b[axis]), Math.min(c[axis], d[axis])) > EPS;
  }
  if (same(a, c) || same(a, d) || same(b, c) || same(b, d)) return false;
  return abC * abD <= EPS && cdA * cdB <= EPS;
}

class SegmentIndex {
  constructor() { this.cells = new Map(); }
  keys(a, b) {
    const keys = [];
    for (let y = Math.floor(Math.min(a[1], b[1]) / 16); y <= Math.floor(Math.max(a[1], b[1]) / 16); y++)
      for (let x = Math.floor(Math.min(a[0], b[0]) / 16); x <= Math.floor(Math.max(a[0], b[0]) / 16); x++) keys.push(`${x},${y}`);
    return keys;
  }
  add(a, b) {
    const segment = { a, b, keys: this.keys(a, b) };
    for (const key of segment.keys) { if (!this.cells.has(key)) this.cells.set(key, new Set()); this.cells.get(key).add(segment); }
    return segment;
  }
  remove(segment) { for (const key of segment.keys) this.cells.get(key).delete(segment); }
  intersects(a, b, replaced) {
    const checked = new Set();
    for (const key of this.keys(a, b)) for (const segment of this.cells.get(key) || []) {
      if (replaced.has(segment) || checked.has(segment)) continue;
      checked.add(segment);
      if (crosses(a, b, segment.a, segment.b)) return true;
    }
    return false;
  }
}

function protectedCells(result) {
  const protectedMask = new Uint8Array(result.labels.length), best = new Map();
  const centers = new Map(result.regions.map(region => [region.id, region.center || [result.width / 2, result.height / 2]]));
  for (let i = 0; i < result.labels.length; i++) {
    if (result.buildings?.[i] || !result.labels[i]) protectedMask[i] = 1;
    const center = centers.get(result.labels[i]);
    if (!center) continue;
    const distance = (i % result.width - center[0]) ** 2 + (Math.floor(i / result.width) - center[1]) ** 2;
    if (!best.has(result.labels[i]) || distance < best.get(result.labels[i]).distance) best.set(result.labels[i], { i, distance });
  }
  // A representative cell also protects tiny disconnected regions that have no seed of their own.
  for (const { i } of best.values()) protectedMask[i] = 1;
  for (const seed of result.seeds || []) if (seed.point) {
    const [x, y] = seed.point; protectedMask[Math.floor(y) * result.width + Math.floor(x)] = 1;
  }
  return protectedMask;
}

function safeSweep(points, first, last, owners, result, protectedMask) {
  // The old chain and its replacement chord enclose every cell whose ownership would change.
  const ring = points.slice(first, last + 1), ys = ring.map(p => p[1]);
  const low = Math.max(0, Math.floor(Math.min(...ys))), high = Math.min(result.height, Math.ceil(Math.max(...ys)));
  for (let y = low; y < high; y++) {
    const scan = y + 0.5, cuts = [];
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i], b = ring[j];
      if ((a[1] > scan) !== (b[1] > scan)) cuts.push(a[0] + (scan - a[1]) * (b[0] - a[0]) / (b[1] - a[1]));
    }
    cuts.sort((a, b) => a - b);
    for (let j = 0; j + 1 < cuts.length; j += 2) {
      const start = Math.max(0, Math.ceil(cuts[j] - 0.5 + EPS)), end = Math.min(result.width, Math.ceil(cuts[j + 1] - 0.5 - EPS));
      for (let x = start; x < end; x++) {
        const cell = y * result.width + x;
        if (protectedMask[cell] || !owners.has(result.labels[cell])) return false;
      }
    }
  }
  return true;
}

function safeChord(a, b, result, protectedMask) {
  for (let y = Math.max(0, Math.floor(Math.min(a[1], b[1]))); y < Math.min(result.height, Math.ceil(Math.max(a[1], b[1]))); y++) {
    for (let x = Math.max(0, Math.floor(Math.min(a[0], b[0]))); x < Math.min(result.width, Math.ceil(Math.max(a[0], b[0]))); x++) {
      const cell = y * result.width + x;
      if (!protectedMask[cell]) continue;
      if (distanceSquared([x + 0.5, y + 0.5], a, b) < EPS) return false;
      if (!result.buildings?.[cell]) continue;
      // A chord may touch a building cell's edge, but cannot clip any of its interior.
      let start = 0, end = 1;
      for (let axis = 0; axis < 2; axis++) {
        const delta = b[axis] - a[axis], low = (axis ? y : x) + EPS, high = low + 1 - 2 * EPS;
        if (!delta) { if (a[axis] < low || a[axis] > high) end = -1; }
        else { const lo = (low - a[axis]) / delta, hi = (high - a[axis]) / delta;
          start = Math.max(start, Math.min(lo, hi)); end = Math.min(end, Math.max(lo, hi)); }
      }
      if (end - start > EPS) return false;
    }
  }
  return true;
}

export function buildPlotGeometry(result, sample, { union, topology, feature }, maxDeviationM = 2) {
  const original = cellPolygons(result, union);
  const topo = topology({ plots: { type: 'FeatureCollection', features: original.map(plot => ({ type: 'Feature', id: plot.id,
    properties: {}, geometry: { type: 'MultiPolygon', coordinates: plot.polygons } })) } });
  const owners = topo.arcs.map(() => new Set()), index = new SegmentIndex(), protectedMask = protectedCells(result);
  for (const geometry of topo.objects.plots.geometries) for (const ref of geometry.arcs.flat(Infinity)) owners[ref < 0 ? ~ref : ref].add(geometry.id);
  const segments = topo.arcs.map(points => points.slice(1).map((point, i) => index.add(points[i], point)));
  const inputVertices = topo.arcs.reduce((sum, arc) => sum + arc.length, 0);
  const cellM = (sample.bbox[2] - sample.bbox[0]) / result.width, exteriorTolerance = 1;
  for (let arc = 0; arc < topo.arcs.length; arc++) {
    // Remove raster steps at road/water edges within one cell; excluded cell centres stay outside.
    const exterior = owners[arc].size === 1;
    const toleranceSquared = (exterior ? exteriorTolerance : maxDeviationM / cellM) ** 2;
    if (exterior) owners[arc].add(0);
    const points = topo.arcs[arc];
    function simplify(first, last) {
      if (last <= first + 1) return [points[first], points[last]];
      let farthest = -1, split = first + 1;
      for (let i = first + 1; i < last; i++) {
        const distance = distanceSquared(points[i], points[first], points[last]);
        if (distance > farthest) { farthest = distance; split = i; }
      }
      if (!same(points[first], points[last]) && farthest <= toleranceSquared) {
        const replaced = new Set(segments[arc].slice(first, last));
        if (!index.intersects(points[first], points[last], replaced)
          && safeChord(points[first], points[last], result, protectedMask)
          && safeSweep(points, first, last, owners[arc], result, protectedMask)) {
          for (const segment of replaced) index.remove(segment);
          index.add(points[first], points[last]);
          return [points[first], points[last]];
        }
      }
      const left = simplify(first, split), right = simplify(split, last);
      return [...left.slice(0, -1), ...right];
    }
    topo.arcs[arc] = simplify(0, points.length - 1);
  }
  const plots = feature(topo, topo.objects.plots).features.map(f => ({ id: f.id, polygons: f.geometry.coordinates }));
  const areas = new Map(plots.map(plot => [plot.id, polygonArea(plot.polygons) * cellM ** 2]));
  const labels = new Int32Array(result.labels.length);
  for (const plot of plots) for (const polygon of plot.polygons) paintPolygon(labels, result.width, result.height, polygon, plot.id);
  let ground = 0, assigned = 0;
  for (let i = 0; i < labels.length; i++) { if (!result.barrier?.[i]) ground++; if (labels[i]) assigned++; }
  return { ...result, labels, plots, boundaries: topo.arcs,
    stats: { ...result.stats, groundCoverage: ground ? assigned / ground : 0, unassigned_m2: (ground - assigned) * cellM ** 2 },
    regions: result.regions.map(region => ({ ...region, area_m2: areas.get(region.id) })),
    straightening: { max_deviation_m: maxDeviationM, exterior_max_deviation_m: exteriorTolerance * cellM, input_vertices: inputVertices,
      output_vertices: topo.arcs.reduce((sum, arc) => sum + arc.length, 0) } };
}
