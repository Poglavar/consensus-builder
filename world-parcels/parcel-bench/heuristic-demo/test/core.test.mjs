// Small synthetic scenes verify the browser-independent segmentation contract and its controls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compute, DEFAULTS, imageEdges, paintPolygon } from '../../../../frontend/js/parcels/estimate/core.mjs';
import { pointInPolygons } from '../../../../frontend/js/parcels/estimate/geometry.mjs';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../../../backend/package.json', import.meta.url));
const { intersection } = require('polygon-clipping');

function flatRgba(width, height, rgb = [128, 128, 128]) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = rgb[0]; rgba[i * 4 + 1] = rgb[1]; rgba[i * 4 + 2] = rgb[2]; rgba[i * 4 + 3] = 255;
  }
  return rgba;
}

function sample(width = 32, height = 32, features = {}) {
  return {
    width, height, bbox: [0, 0, width, height],
    features: { buildings: [], roads: [], water: [], waterways: [], ...features },
  };
}

function regionAt(result, width, x, y) {
  return result.labels[y * width + x];
}

test('mapped roads and water remain unassigned barriers while a building seed stays intact', () => {
  const width = 32, height = 32;
  const building = { id: 'building-a', rings: [[[3, 3], [9, 3], [9, 9], [3, 9], [3, 3]]] };
  const road = { id: 'road-a', points: [[16.5, 0], [16.5, 32]], width_m: 1, highway: 'residential' };
  const water = { id: 'water-a', rings: [[[22, 4], [28, 4], [28, 10], [22, 10], [22, 4]]] };
  const result = compute({ sample: sample(width, height, { buildings: [building], roads: [road], water: [water] }),
    rgba: flatRgba(width, height), width, height, settings: DEFAULTS });

  const roadCell = 12 * width + 16, waterCell = 6 * width + 24;
  assert.equal(result.barrier[roadCell], 1, 'the road was rasterized as a barrier');
  assert.equal(result.barrier[waterCell], 2, 'the water polygon was rasterized as a barrier');
  for (let i = 0; i < result.labels.length; i++) {
    if (result.barrier[i]) assert.equal(result.labels[i], 0, 'barrier pixels never belong to a plot');
  }

  const buildingCells = [];
  for (let y = 4; y < 8; y++) for (let x = 4; x < 8; x++) buildingCells.push(regionAt(result, width, x, y));
  assert(buildingCells.every(Boolean), 'the interior building pixels all retain a plot label');
  assert.equal(new Set(buildingCells).size, 1, 'a building is not split into multiple plot identities');
  assert.equal(result.regions.find(r => r.id === buildingCells[0])?.kind, 'building');
});

test('polygon interior rings leave a usable hole instead of filling it as water', () => {
  const width = 24, height = 24, mask = new Uint8Array(width * height);
  paintPolygon(mask, width, height, [
    [[2, 2], [22, 2], [22, 22], [2, 22], [2, 2]],
    [[8, 8], [16, 8], [16, 16], [8, 16], [8, 8]],
  ], 2);
  assert.equal(mask[12 * width + 4], 2, 'the polygon shell is painted');
  assert.equal(mask[12 * width + 12], 0, 'the interior ring remains open');
  assert.equal(mask[1 * width + 12], 0, 'pixels outside the outer ring remain untouched');
});

test('a manual divider separates one open block and a divider crossing a building is rejected', () => {
  const width = 32, height = 32, rgba = flatRgba(width, height);
  const separated = compute({ sample: sample(width, height), rgba, width, height, settings: DEFAULTS,
    edits: { seeds: [[8, 16], [24, 16]], dividers: [[[16, 10], [16, 13]]] } });
  assert.equal(separated.stats.blocks, 2, 'the divider creates two connected ground blocks');
  assert.notEqual(regionAt(separated, width, 8, 16), regionAt(separated, width, 24, 16));
  for (let y = 0; y < height; y++) assert.equal(separated.labels[y * width + 16], 0, 'the divider remains unassigned');

  const building = { id: 'building-crossed', rings: [[[13, 12], [19, 12], [19, 20], [13, 20], [13, 12]]] };
  assert.throws(() => compute({ sample: sample(width, height, { buildings: [building] }), rgba, width, height,
    settings: DEFAULTS, edits: { seeds: [], dividers: [[[4, 16], [7, 16]]] } }), /crosses a mapped building/);
});

test('manual seed anchors a distinct manual rectangle', () => {
  const width = 32, height = 32;
  const result = compute({ sample: sample(width, height), rgba: flatRgba(width, height), width, height,
    settings: DEFAULTS, edits: { seeds: [[6, 6]], dividers: [] } });
  assert(result.seeds.some(seed => seed.kind === 'manual' && seed.point[0] === 6 && seed.point[1] === 6));
  const regionId = regionAt(result, width, 6, 6);
  assert(regionId > 0);
  assert.equal(result.regions.find(region => region.id === regionId)?.kind, 'manual');
});

test('same image, features, and controls produce the same raster labels', () => {
  const width = 40, height = 32;
  const features = {
    buildings: [{ id: 'b1', rings: [[[4, 4], [10, 4], [10, 11], [4, 11], [4, 4]]] }],
    roads: [{ id: 'r1', points: [[20, 0], [20, 32]], width_m: 1, highway: 'service' }],
  };
  const input = { sample: sample(width, height, features), rgba: flatRgba(width, height), width, height,
    settings: { sensitivity: 45, rectangularity: 70 }, edits: { seeds: [[30, 16]], dividers: [] } };
  const first = compute(input), second = compute(input);
  assert.deepEqual(Array.from(first.labels), Array.from(second.labels));
  assert.deepEqual(first.stats, second.stats);
});

function assertRectangles(result) {
  const geometries = result.plots.map(plot => plot.polygons);
  for (const [index, plot] of result.plots.entries()) {
    const ring = plot.polygons[0][0];
    assert.equal(ring.length, 5, `plot ${plot.id} has four corners and closure`);
    assert.deepEqual(ring[0], ring.at(-1));
    const edges = ring.slice(1).map((point, i) => [point[0] - ring[i][0], point[1] - ring[i][1]]);
    const lengths = edges.map(([x, y]) => Math.hypot(x, y));
    for (let i = 0; i < 4; i++) {
      const [ax, ay] = edges[i], [bx, by] = edges[(i + 1) % 4];
      assert(Math.abs(ax * bx + ay * by) < 1e-6, `plot ${plot.id} has right-angle corners`);
      assert(Math.abs(lengths[i] - lengths[(i + 2) % 4]) < 1e-6, `plot ${plot.id} has equal opposite sides`);
    }
    assert(Math.max(...lengths) / Math.min(...lengths) <= 4 + 1e-6, `plot ${plot.id} respects max aspect ratio`);
    assert.equal(result.regions[index].id, plot.id);
  }
  for (let i = 0; i < geometries.length; i++) for (let j = i + 1; j < geometries.length; j++) {
    assert.equal(intersection(geometries[i], geometries[j]).length, 0, `plots ${i + 1} and ${j + 1} do not overlap`);
  }
}

test('computed output is non-overlapping rectangles, protects whole buildings, and excludes barriers', () => {
  const width = 48, height = 32;
  const building = { id: 'whole-building', rings: [[[3, 3], [11, 3], [11, 11], [3, 11], [3, 3]]] };
  const road = { id: 'road-a', points: [[22, 0], [22, height]], width_m: 1, highway: 'service' };
  const water = { id: 'water-a', rings: [[[35, 4], [41, 4], [41, 12], [35, 12], [35, 4]]] };
  const result = compute({ sample: sample(width, height, { buildings: [building], roads: [road], water: [water] }),
    rgba: flatRgba(width, height), width, height, settings: DEFAULTS });
  assertRectangles(result);
  for (let i = 0; i < result.labels.length; i++) if (result.barrier[i]) assert.equal(result.labels[i], 0, 'barrier cells stay unassigned');
  const cells = [];
  for (let y = 3; y < 11; y++) for (let x = 3; x < 11; x++) cells.push(result.labels[y * width + x]);
  assert(cells.every(Boolean), 'every cell of the mapped building belongs to a rectangle');
  assert.equal(new Set(cells).size, 1, 'the building remains in one plot');
  const id = cells[0], plot = result.plots.find(item => item.id === id);
  assert(result.regions.find(region => region.id === id).source_ids.includes('whole-building'));
  for (let y = 3; y < 11; y++) for (let x = 3; x < 11; x++) {
    for (const point of [[x + 0.01, y + 0.01], [x + 0.99, y + 0.01], [x + 0.99, y + 0.99], [x + 0.01, y + 0.99]]) {
      assert(pointInPolygons(point, plot.polygons), 'the rectangle covers the whole building pixel');
    }
  }
});

test('a strong non-equidistant image edge attracts a straight cut between two anchors', () => {
  const width = 48, height = 32, rgba = flatRgba(width, height);
  for (let y = 0; y < height; y++) for (let x = 14; x < width; x++) {
    const i = (y * width + x) * 4; rgba[i] = rgba[i + 1] = rgba[i + 2] = 0;
  }
  const buildings = [
    { id: 'left-anchor', rings: [[[5, 10], [10, 10], [10, 15], [5, 15], [5, 10]]] },
    { id: 'right-anchor', rings: [[[34, 10], [39, 10], [39, 15], [34, 15], [34, 10]]] },
  ];
  const result = compute({ sample: sample(width, height, { buildings }), rgba, width, height,
    settings: { sensitivity: 100, rectangularity: 0 } });
  assertRectangles(result);
  const verticalCuts = result.boundaries.flatMap(ring => ring.slice(1).flatMap((point, i) =>
    Math.abs(ring[i][0] - point[0]) < 1e-6 ? [point[0]] : []));
  const interiorCuts = verticalCuts.filter(x => x > 0 && x < width);
  assert(Math.min(...interiorCuts.map(x => Math.abs(x - 14))) < Math.min(...interiorCuts.map(x => Math.abs(x - 22))),
    'the cut is closer to the non-equidistant image edge than the equidistant midpoint');
});

test('inseparable building anchors share one rectangle with all source IDs', () => {
  const width = 32, height = 32;
  const buildings = [
    { id: 'northwest', rings: [[[4, 4], [20, 4], [4, 20], [4, 4]]] },
    { id: 'southeast', rings: [[[20, 20], [20, 5], [5, 20], [20, 20]]] },
  ];
  const result = compute({ sample: sample(width, height, { buildings }), rgba: flatRgba(width, height), width, height, settings: DEFAULTS });
  assertRectangles(result);
  const grouped = result.regions.find(region => region.source_ids.length === 2);
  assert(grouped, 'both inseparable mapped buildings are kept together');
  assert.deepEqual([...grouped.source_ids].sort(), ['northwest', 'southeast']);
  assert.equal(grouped.anchor_count, 2);
});

test('an unfit mapped building stays explicit as unassigned', () => {
  const width = 20, height = 32;
  const building = { id: 'long-building', rings: [[[7, 2], [10, 2], [10, 30], [7, 30], [7, 2]]] };
  const roads = [
    { id: 'west-road', points: [[4, 0], [4, height]], width_m: 5, highway: 'secondary' },
    { id: 'east-road', points: [[13, 0], [13, height]], width_m: 5, highway: 'secondary' },
  ];
  const result = compute({ sample: sample(width, height, { buildings: [building], roads }), rgba: flatRgba(width, height), width, height, settings: DEFAULTS });
  assert(result.stats.unassignedBuildings > 0, 'the impossible building fit is counted as unassigned');
  assert(result.warnings.some(warning => /cannot fit a rectangle/.test(warning)), 'the unassigned building has a visible reason');
  assert(!result.regions.some(region => region.source_ids.includes('long-building')));
});

test('street alignment rotates the rectangular frame between building and road directions', () => {
  const width = 40, height = 40;
  const features = {
    buildings: [{ id: 'square', rings: [[[15, 15], [23, 15], [23, 23], [15, 23], [15, 15]]] }],
    roads: [{ id: 'nearby-diagonal', points: [[-30, 0], [0, -30]], highway: 'service' }],
  };
  const input = { sample: sample(width, height, features), rgba: flatRgba(width, height), width, height };
  const alignedToBuildings = compute({ ...input, settings: { sensitivity: 0, rectangularity: 0 } });
  const alignedToRoads = compute({ ...input, settings: { sensitivity: 0, rectangularity: 100 } });
  assertRectangles(alignedToBuildings);
  assertRectangles(alignedToRoads);
  const firstEdge = result => {
    const ring = result.plots[0].polygons[0][0]; return [ring[1][0] - ring[0][0], ring[1][1] - ring[0][1]];
  };
  assert(Math.abs(firstEdge(alignedToBuildings)[1]) < 1e-8, 'building direction is horizontal');
  const [dx, dy] = firstEdge(alignedToRoads);
  assert(Math.abs(Math.abs(dx) - Math.abs(dy)) < 1e-8, 'road direction is diagonal');
  assert.throws(() => compute({ ...input, sample: { ...input.sample, bbox: [0, 0, 40, 20] } }), /square metric/);
});
