// Prepare mapped barriers and whole-building anchors, then fit strict oriented rectangular plots.
import { rectangularPartition } from './rectangles.mjs?v=20261020';
export const RECIPE = 'browser-heuristic-v3';
export const DEFAULTS = Object.freeze({ sensitivity: 55, rectangularity: 65 });
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const around = [[1, 0], [0, 1], [-1, 0], [0, -1]];
const ROAD_WIDTHS = { motorway: 12, trunk: 10, primary: 9, secondary: 8, tertiary: 7, residential: 5, unclassified: 4, service: 3, track: 3, pedestrian: 2, footway: 1.5, path: 1 };
export function roadWidth(road) { return Number.isFinite(road.width_m) && road.width_m > 0 ? road.width_m : ROAD_WIDTHS[road.highway] || 3; }

export function paintPolygon(target, width, height, rings, value, sx = 1, sy = sx) {
  if (!rings?.length) return;
  const scaled = rings.map(ring => ring.map(([x, y]) => [x * sx, y * sy]));
  const points = scaled.flat();
  const y0 = clamp(Math.floor(Math.min(...points.map(p => p[1]))), 0, height - 1);
  const y1 = clamp(Math.ceil(Math.max(...points.map(p => p[1]))), 0, height);
  for (let y = y0; y < y1; y++) {
    const cuts = [], scan = y + 0.5;
    for (const ring of scaled) for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[j], b = ring[i];
      if ((a[1] > scan) !== (b[1] > scan)) cuts.push(a[0] + (scan - a[1]) * (b[0] - a[0]) / (b[1] - a[1]));
    }
    cuts.sort((a, b) => a - b);
    for (let j = 0; j + 1 < cuts.length; j += 2) {
      const start = clamp(Math.ceil(cuts[j] - 0.5), 0, width);
      const end = clamp(Math.ceil(cuts[j + 1] - 0.5), 0, width);
      target.fill(value, y * width + start, y * width + end);
    }
  }
}

function disk(target, width, height, x, y, radius, value, accept = () => true) {
  for (let yy = Math.max(0, Math.floor(y - radius)); yy <= Math.min(height - 1, Math.ceil(y + radius)); yy++) {
    for (let xx = Math.max(0, Math.floor(x - radius)); xx <= Math.min(width - 1, Math.ceil(x + radius)); xx++) {
      const i = yy * width + xx;
      if ((xx - x) ** 2 + (yy - y) ** 2 <= radius ** 2 && accept(i)) target[i] = value;
    }
  }
}

function stroke(target, width, height, points, radius, value, accept) {
  for (let j = 1; j < points.length; j++) {
    const a = points[j - 1], b = points[j], steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) * 2));
    for (let k = 0; k <= steps; k++) disk(target, width, height, a[0] + (b[0] - a[0]) * k / steps,
      a[1] + (b[1] - a[1]) * k / steps, radius, value, accept);
  }
}

export function imageEdges(rgba, width, height) {
  if (rgba.length !== width * height * 4) throw new Error('Image pixels do not match the processing grid.');
  const n = width * height, luminance = new Float32Array(n), smooth = new Float32Array(n), edge = new Float32Array(n);
  // A separable five-pixel box filter suppresses roof texture before colour gradients are combined.
  for (let channel = 0; channel < 3; channel++) {
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let dx = -2; dx <= 2; dx++) sum += rgba[(y * width + clamp(x + dx, 0, width - 1)) * 4 + channel];
      luminance[y * width + x] = sum / 5;
    }
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let dy = -2; dy <= 2; dy++) sum += luminance[clamp(y + dy, 0, height - 1) * width + x];
      smooth[y * width + x] = sum / 5;
    }
    for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const gx = smooth[i + 1] - smooth[i - 1], gy = smooth[i + width] - smooth[i - width];
      edge[i] += gx * gx + gy * gy;
    }
  }
  const histogram = new Uint32Array(256);
  for (let i = 0; i < n; i++) { edge[i] = Math.sqrt(edge[i]); histogram[Math.min(255, Math.round(edge[i]))]++; }
  let count = 0, scale = 1;
  for (; scale < 255; scale++) { count += histogram[scale - 1]; if (count >= n * 0.9) break; }
  for (let i = 0; i < n; i++) edge[i] = Math.min(1, edge[i] / scale);
  return edge;
}

export function connectedGround(barrier, width, height) {
  const ids = new Int32Array(barrier.length), queue = new Int32Array(barrier.length), blocks = [null];
  for (let i = 0; i < ids.length; i++) if (!barrier[i] && !ids[i]) {
    const id = blocks.length; let head = 0, tail = 1, xsum = 0, ysum = 0;
    queue[0] = i; ids[i] = id;
    while (head < tail) {
      const p = queue[head++], x = p % width, y = (p / width) | 0; xsum += x; ysum += y;
      for (const [dx, dy] of around) {
        const xx = x + dx, yy = y + dy, q = yy * width + xx;
        if (xx >= 0 && xx < width && yy >= 0 && yy < height && !barrier[q] && !ids[q]) { ids[q] = id; queue[tail++] = q; }
      }
    }
    blocks.push({ id, cells: tail, center: [xsum / tail, ysum / tail], first: i });
  }
  return { ids, blocks };
}

function blockAngle(block, features, sx, sy, alignment) {
  const direction = (lines, isRoad) => {
    let cosine = 0, sine = 0, sum = 0;
    for (const line of lines) {
      if (line.bridge || line.tunnel) continue;
      for (const points of isRoad ? [line.points] : line.rings) for (let j = 1; j < points.length; j++) {
        const a = [points[j - 1][0] * sx, points[j - 1][1] * sy], b = [points[j][0] * sx, points[j][1] * sy];
        const dx = b[0] - a[0], dy = b[1] - a[1], length = Math.hypot(dx, dy);
        const distance = Math.hypot((a[0] + b[0]) / 2 - block.center[0], (a[1] + b[1]) / 2 - block.center[1]);
        const weight = length / (16 + distance) ** 2, angle = Math.atan2(dy, dx);
        cosine += Math.cos(4 * angle) * weight; sine += Math.sin(4 * angle) * weight; sum += weight;
      }
    }
    return { x: sum ? cosine / sum : 0, y: sum ? sine / sum : 0, sum };
  };
  const roads = direction(features.roads, true), buildings = direction(features.buildings, false);
  const mix = !roads.sum ? 0 : !buildings.sum ? 1 : alignment / 100;
  return { angle: Math.atan2(roads.y * mix + buildings.y * (1 - mix), roads.x * mix + buildings.x * (1 - mix)) / 4 };
}

export function compute({ sample, rgba, width = 512, height = 512, settings = DEFAULTS, edits = { seeds: [], dividers: [] } }) {
  if (![width, height].every(v => Number.isInteger(v) && v >= 8 && v <= 1024)) throw new Error('Invalid processing dimensions.');
  for (const key of ['sensitivity', 'rectangularity']) if (!Number.isFinite(settings[key]) || settings[key] < 0 || settings[key] > 100) throw new Error('Invalid controls.');
  const sx = width / sample.width, sy = height / sample.height, n = width * height;
  const cellM = (sample.bbox[2] - sample.bbox[0]) / width;
  const cellY = (sample.bbox[3] - sample.bbox[1]) / height;
  if (!Number.isFinite(cellM) || cellM <= 0 || Math.abs(cellM - cellY) > 1e-8) throw new Error('Rectangular plots require square metric processing cells.');
  const barrier = new Uint8Array(n), seeds = new Int32Array(n), buildings = new Uint8Array(n), metadata = [null], warnings = [];
  const features = sample.features, scalePoints = points => points.map(([x, y]) => [x * sx - 0.5, y * sy - 0.5]);
  for (const building of features.buildings) {
    const id = metadata.length;
    paintPolygon(seeds, width, height, building.rings, id, sx, sy);
    metadata.push({ id, kind: 'building', source_id: building.id, point: null });
  }
  for (let i = 0; i < n; i++) buildings[i] = seeds[i] ? 1 : 0;
  for (const water of features.water) paintPolygon(barrier, width, height, water.rings, 2, sx, sy);
  for (const line of features.waterways || []) stroke(barrier, width, height, scalePoints(line.points), Math.max(0.7, (line.width_m || 3) / cellM / 2), 2);
  for (const road of features.roads) if (!road.bridge && !road.tunnel) {
    stroke(barrier, width, height, scalePoints(road.points), Math.max(0.7, roadWidth(road) / cellM / 2), 1, i => !buildings[i] && barrier[i] !== 2);
  }
  let waterConflict = 0;
  for (let i = 0; i < n; i++) if (barrier[i] && seeds[i]) { waterConflict++; seeds[i] = 0; buildings[i] = 0; }
  if (waterConflict) warnings.push('Mapped water overlaps a building; water is excluded from generated plots.');
  let blocks = connectedGround(barrier, width, height);
  for (const divider of edits.dividers) {
    const [a, b] = scalePoints(divider), delta = [b[0] - a[0], b[1] - a[1]], length = Math.hypot(...delta);
    if (!Number.isFinite(length) || length < 2) throw new Error('Place the second divider point farther away.');
    const index = clamp(Math.round(a[1]), 0, height - 1) * width + clamp(Math.round(a[0]), 0, width - 1), block = blocks.ids[index];
    if (!block) throw new Error('Start the dividing line on open ground.');
    const extent = Math.hypot(width, height) * 2;
    const line = [-1, 1].map(sign => [a[0] + sign * delta[0] / length * extent, a[1] + sign * delta[1] / length * extent]);
    const mask = new Uint8Array(n);
    stroke(mask, width, height, line, 0.75, 1, i => blocks.ids[i] === block);
    if (mask.some((value, i) => value && buildings[i])) throw new Error('That line crosses a mapped building. Place it between buildings.');
    for (let i = 0; i < n; i++) if (mask[i]) barrier[i] = 3;
    blocks = connectedGround(barrier, width, height);
  }
  for (const point of edits.seeds) {
    const x = Math.floor(point[0] * sx), y = Math.floor(point[1] * sy), i = y * width + x;
    if (!Number.isFinite(x + y) || x < 0 || y < 0 || x >= width || y >= height || barrier[i] || buildings[i]) throw new Error('Place the new seed on open ground, outside mapped buildings and roads.');
    const id = metadata.length; seeds[i] = id; metadata.push({ id, kind: 'manual', source_id: null, point: [x, y] });
  }
  for (const block of blocks.blocks.slice(1)) Object.assign(block, blockAngle(block, features, sx, sy, settings.rectangularity));
  const edge = imageEdges(rgba, width, height);
  const partition = rectangularPartition({ width, height, blocks, seedLabels: seeds, metadata, edge, cellM, settings });
  const labels = new Int32Array(n);
  for (const plot of partition.plots) paintPolygon(labels, width, height, plot.polygons[0], plot.id);
  let ground = 0, covered = 0;
  for (let i = 0; i < n; i++) { if (!barrier[i]) ground++; if (labels[i]) covered++; }
  const visibleSeeds = new Set(seeds.filter(Boolean));
  const missedBuildings = [...visibleSeeds].filter(id => metadata[id].kind === 'building' && !partition.coveredSeeds.has(id));
  const missedManual = [...visibleSeeds].filter(id => metadata[id].kind === 'manual' && !partition.coveredSeeds.has(id));
  if (missedBuildings.length) warnings.push(`${missedBuildings.length} mapped buildings cannot fit a rectangle here and remain unassigned.`);
  if (missedManual.length) warnings.push(`${missedManual.length} added seeds cannot fit a rectangle here and remain unassigned.`);
  const grouped = partition.regions.filter(r => r.source_ids.length > 1).length;
  if (grouped) warnings.push(`${grouped} rectangles contain multiple mapped buildings because no building-safe straight cut separates them.`);
  return { recipe: RECIPE, width, height, labels, barrier, buildings, edge, seeds: metadata.slice(1),
    plots: partition.plots, regions: partition.regions, boundaries: partition.boundaries, rectangle_constraints: partition.rectangle_constraints, warnings,
    stats: { plots: partition.plots.length, coveredBuildings: new Set(partition.regions.flatMap(r => r.source_ids)).size,
      mappedBuildings: [...visibleSeeds].filter(id => metadata[id].kind === 'building').length, unassignedBuildings: missedBuildings.length,
      groupedBuildingPlots: grouped, manualSeeds: edits.seeds.length, unassignedManualSeeds: missedManual.length,
      generatedPlots: partition.regions.filter(r => r.kind === 'generated').length,
      groundCoverage: ground ? covered / ground : 0, unassigned_m2: (ground - covered) * cellM ** 2, blocks: blocks.blocks.length - 1 } };
}
