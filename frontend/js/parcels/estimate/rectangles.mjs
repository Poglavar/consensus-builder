// Subdivide oriented ground blocks with building-safe straight cuts, then fit four-sided rectangles.
const EPS = 1e-8;
const area = r => (r[2] - r[0]) * (r[3] - r[1]);
const contains = (r, a) => r[0] <= a[0] && r[1] <= a[1] && r[2] >= a[2] && r[3] >= a[3];
const bounds = items => [Math.min(...items.map(a => a.box[0])), Math.min(...items.map(a => a.box[1])),
  Math.max(...items.map(a => a.box[2])), Math.max(...items.map(a => a.box[3]))];
export const CONSTRAINTS = Object.freeze({ sides: 4, max_aspect_ratio: 4, minimum_open_area_m2: 40, minimum_open_width_m: 3 });

function frameFor(block, cells, source) {
  const { width, height, blocks, seedLabels, edge } = source, c = Math.cos(block.angle), s = Math.sin(block.angle);
  const rotate = (x, y) => [x * c + y * s, -x * s + y * c];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const seedBounds = new Map();
  for (const p of cells) {
    const x = p % width, y = Math.floor(p / width), corners = [[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1]].map(([x, y]) => rotate(x, y));
    const box = [Math.min(...corners.map(p => p[0])), Math.min(...corners.map(p => p[1])),
      Math.max(...corners.map(p => p[0])), Math.max(...corners.map(p => p[1]))];
    minX = Math.min(minX, box[0]); minY = Math.min(minY, box[1]); maxX = Math.max(maxX, box[2]); maxY = Math.max(maxY, box[3]);
    const seed = seedLabels[p];
    if (seed) {
      const old = seedBounds.get(seed);
      seedBounds.set(seed, old ? [Math.min(old[0], box[0]), Math.min(old[1], box[1]), Math.max(old[2], box[2]), Math.max(old[3], box[3])] : box);
    }
  }
  const x0 = Math.floor(minX + EPS), y0 = Math.floor(minY + EPS), w = Math.ceil(maxX - EPS) - x0, h = Math.ceil(maxY - EPS) - y0;
  const toImage = (x, y) => [(x + x0) * c - (y + y0) * s, (x + x0) * s + (y + y0) * c];
  const free = new Uint8Array(w * h), gradients = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const corners = [[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1]].map(([x, y]) => toImage(x, y));
    const left = Math.floor(Math.min(...corners.map(p => p[0])) + EPS), top = Math.floor(Math.min(...corners.map(p => p[1])) + EPS);
    const right = Math.ceil(Math.max(...corners.map(p => p[0])) - EPS), bottom = Math.ceil(Math.max(...corners.map(p => p[1])) - EPS);
    // Conservative resampling: every source cell touched by this cell's bounds must belong to this block.
    let valid = left >= 0 && top >= 0 && right <= width && bottom <= height;
    for (let yy = top; valid && yy < bottom; yy++) for (let xx = left; valid && xx < right; xx++) valid = blocks.ids[yy * width + xx] === block.id;
    const [cx, cy] = toImage(x + 0.5, y + 0.5);
    free[y * w + x] = Number(valid);
    if (cx >= 0 && cy >= 0 && cx < width && cy < height) gradients[y * w + x] = edge[Math.floor(cy) * width + Math.floor(cx)];
  }
  const anchors = [...seedBounds].map(([id, b]) => ({ id, box: [Math.floor(b[0] + EPS) - x0, Math.floor(b[1] + EPS) - y0,
    Math.ceil(b[2] - EPS) - x0, Math.ceil(b[3] - EPS) - y0] }));
  return { w, h, free, gradients, anchors, toImage };
}

function splitAt(box, axis, cut) {
  const a = box.slice(), b = box.slice(); a[axis + 2] = cut; b[axis] = cut; return [a, b];
}

function chooseCut(box, anchors, frame, sensitivity, minWidth, targetArea) {
  const parentArea = area(box), one = anchors.length <= 1;
  if (one && parentArea <= targetArea * 1.8) return null;
  let best;
  for (const axis of [0, 1]) {
    const other = 1 - axis;
    for (let cut = box[axis] + minWidth; cut <= box[axis + 2] - minWidth; cut++) {
      if (anchors.some(a => a.box[axis] < cut && a.box[axis + 2] > cut)) continue;
      const left = anchors.filter(a => a.box[axis + 2] <= cut), right = anchors.filter(a => a.box[axis] >= cut);
      // A cut separates whole anchors, or removes a sizeable empty field from a lone anchor.
      if (!one && (!left.length || !right.length)) continue;
      const children = splitAt(box, axis, cut);
      if (one && children.some((r, i) => !(i ? right : left).length && area(r) < targetArea * 0.6)) continue;
      const aspect = r => Math.max((r[2] - r[0]) / (r[3] - r[1]), (r[3] - r[1]) / (r[2] - r[0]));
      let sum = 0, length = 0;
      for (let q = box[other]; q < box[other + 2]; q++) {
        const p = axis ? (cut - 1) * frame.w + q : q * frame.w + cut - 1;
        const next = p + (axis ? frame.w : 1);
        if (frame.free[p] && frame.free[next]) { sum += Math.max(frame.gradients[p], frame.gradients[next]); length++; }
      }
      const evidence = length ? sum / length : 0;
      const balance = one ? 0 : Math.abs(left.length - right.length) / anchors.length;
      const shape = (Math.log(aspect(children[0])) + Math.log(aspect(children[1]))) / 2;
      // No seed-distance term: whole-line image support, compact child shapes and a balanced split hierarchy.
      const score = sensitivity / 100 * 3 * evidence - 0.32 * shape - 0.15 * balance;
      if (!best || score > best.score + EPS) best = { score, children, groups: [left, right] };
    }
  }
  return best;
}

function compactRectangle(candidate, required) {
  const r = candidate.slice(), max = CONSTRAINTS.max_aspect_ratio;
  for (const axis of [0, 1]) {
    const span = r[axis + 2] - r[axis], cap = max * (r[3 - axis] - r[1 - axis]);
    if (span <= cap) continue;
    if (required && required[axis + 2] - required[axis] > cap) return null;
    const low = required ? Math.max(r[axis], required[axis + 2] - cap) : r[axis];
    const high = required ? Math.min(r[axis + 2] - cap, required[axis]) : r[axis + 2] - cap;
    r[axis] = Math.floor((low + high) / 2); r[axis + 2] = r[axis] + cap;
  }
  return r;
}

function largestRectangle(box, required, frame, minWidth) {
  const heights = new Int32Array(box[2] - box[0]), { free, w } = frame;
  let best, bestScore = 0;
  // Histogram maximal-rectangle enumeration is linear in this leaf's area.
  for (let y = box[1]; y < box[3]; y++) {
    for (let j = 0; j < heights.length; j++) heights[j] = free[y * w + box[0] + j] ? heights[j] + 1 : 0;
    const stack = [];
    for (let j = 0; j <= heights.length; j++) {
      const h = j < heights.length ? heights[j] : 0;
      let start = j;
      while (stack.length && stack.at(-1).height > h) {
        const item = stack.pop(); start = item.start;
        const r = compactRectangle([box[0] + start, y + 1 - item.height, box[0] + j, y + 1], required);
        if (!r || (required && !contains(r, required)) || Math.min(r[2] - r[0], r[3] - r[1]) < minWidth) continue;
        const score = area(r);
        if (score > bestScore) { best = r; bestScore = score; }
      }
      if (h && (!stack.length || stack.at(-1).height < h)) stack.push({ start, height: h });
    }
  }
  return best;
}

function fillBox(mask, w, box, value) {
  for (let y = box[1]; y < box[3]; y++) mask.fill(value, y * w + box[0], y * w + box[2]);
}

function boxIsFree(box, frame) {
  for (let y = box[1]; y < box[3]; y++) for (let x = box[0]; x < box[2]; x++) if (!frame.free[y * frame.w + x]) return false;
  return true;
}

function fitAnchors(box, anchors, frame) {
  const groups = anchors.map(anchor => ({ anchors: [anchor], box: anchor.box }));
  // Overlapping oriented envelopes cannot belong to disjoint rectangles; join them before fitting.
  for (let i = 0; i < groups.length; i++) for (let j = i + 1; j < groups.length;) {
    const a = groups[i].box, b = groups[j].box;
    if (a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]) {
      groups[i].anchors.push(...groups[j].anchors); groups[i].box = bounds(groups[i].anchors);
      groups.splice(j, 1); i = -1; break;
    }
    j++;
  }
  const free = frame.free.slice(), fitted = [];
  for (const group of groups) fillBox(free, frame.w, group.box, 0);
  // In a non-slicing arrangement, fit one whole group at a time while reserving every other envelope.
  for (const group of groups.sort((a, b) => area(b.box) - area(a.box))) {
    for (let y = group.box[1]; y < group.box[3]; y++) for (let x = group.box[0]; x < group.box[2]; x++)
      free[y * frame.w + x] = frame.free[y * frame.w + x];
    const rect = largestRectangle(box, group.box, { ...frame, free }, 1);
    if (rect) fitted.push({ rect, anchors: group.anchors });
    fillBox(free, frame.w, rect || group.box, 0);
  }
  return fitted;
}

export function rectangularPartition(source) {
  const { blocks, width, height, metadata, cellM, settings } = source, plots = [], regions = [], missed = [], coveredSeeds = new Set();
  const cells = Array.from({ length: blocks.blocks.length }, () => []);
  for (let p = 0; p < width * height; p++) if (blocks.ids[p]) cells[blocks.ids[p]].push(p);
  const targetArea = 650 / cellM ** 2, minimumArea = CONSTRAINTS.minimum_open_area_m2 / cellM ** 2;
  for (const block of blocks.blocks.slice(1)) {
    if (block.cells < minimumArea && !cells[block.id].some(p => source.seedLabels[p])) continue;
    const frame = frameFor(block, cells[block.id], source), minimumWidth = Math.max(1, Math.ceil(CONSTRAINTS.minimum_open_width_m / cellM));
    // An impossible edge anchor must not veto divisions between all the other buildings in its block.
    let removed = true;
    while (removed) {
      removed = false;
      frame.anchors = frame.anchors.filter(anchor => {
        if (boxIsFree(anchor.box, frame)) return true;
        missed.push(anchor.id); fillBox(frame.free, frame.w, anchor.box, 0); removed = true; return false;
      });
    }
    const queue = [{ box: [0, 0, frame.w, frame.h], anchors: frame.anchors, depth: 0 }];
    while (queue.length) {
      const { box, anchors, depth } = queue.pop();
      const cut = depth < 20 ? chooseCut(box, anchors, frame, settings.sensitivity, minimumWidth, targetArea) : null;
      if (cut) {
        for (let i = 1; i >= 0; i--) queue.push({ box: cut.children[i], anchors: cut.groups[i], depth: depth + 1 });
        continue;
      }
      const rect = largestRectangle(box, anchors.length ? bounds(anchors) : null, frame, anchors.length ? 1 : minimumWidth);
      const fitted = rect ? [{ rect, anchors }] : anchors.length > 1 ? fitAnchors(box, anchors, frame) : [];
      for (const { rect, anchors } of fitted) {
        if (!anchors.length && area(rect) < minimumArea) continue;
        const id = plots.length + 1, [x0, y0, x1, y1] = rect;
        const ring = [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]].map(([x, y]) => frame.toImage(x, y));
        const originals = anchors.map(a => metadata[a.id]), sourceIds = originals.filter(a => a.kind === 'building').map(a => a.source_id);
        anchors.forEach(a => coveredSeeds.add(a.id));
        plots.push({ id, polygons: [[ring]] });
        regions.push({ id, kind: sourceIds.length ? 'building' : anchors.length ? 'manual' : 'generated', source_ids: sourceIds,
          anchor_count: anchors.length, area_m2: area(rect) * cellM ** 2, center: frame.toImage((x0 + x1) / 2, (y0 + y1) / 2) });
      }
      missed.push(...anchors.filter(a => !coveredSeeds.has(a.id)).map(a => a.id));
    }
  }
  return { plots, regions, boundaries: plots.map(p => p.polygons[0][0]), rectangle_constraints: CONSTRAINTS,
    coveredSeeds, missed: [...new Set(missed)] };
}
