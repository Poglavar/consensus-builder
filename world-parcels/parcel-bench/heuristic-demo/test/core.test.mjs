// Small synthetic scenes verify the browser-independent segmentation contract and its controls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compute, DEFAULTS, grow, imageEdges, paintPolygon } from '../public/core.mjs';

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

function block(width, height, angle = 0, coherence = 0) {
  const n = width * height;
  return { ids: new Int32Array(n).fill(1), blocks: [null, { id: 1, cells: n, center: [width / 2, height / 2], angle, coherence }] };
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

test('manual seed survives automatic open-ground seeding and has a distinct manual region', () => {
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

test('a strong RGB boundary changes which seed reaches pixels on the far side', () => {
  const width = 40, height = 24, n = width * height;
  const seeds = new Int32Array(n), barrier = new Uint8Array(n);
  seeds[12 * width + 6] = 1;
  seeds[12 * width + 33] = 2;
  const blocks = block(width, height);
  const flat = flatRgba(width, height), divided = flat.slice();
  for (let y = 0; y < height; y++) for (let x = 13; x < width; x++) {
    const i = (y * width + x) * 4;
    divided[i] = divided[i + 1] = divided[i + 2] = 0;
  }
  const noEdge = imageEdges(flat, width, height), rgbEdge = imageEdges(divided, width, height);
  assert(Math.max(...rgbEdge) > Math.max(...noEdge), 'the RGB transition contributes a detectable edge cost');
  const settings = { sensitivity: 100, rectangularity: 0 };
  const plain = grow(seeds, barrier, noEdge, width, height, blocks, settings);
  const edgeAware = grow(seeds, barrier, rgbEdge, width, height, blocks, settings);
  assert.notDeepEqual(Array.from(edgeAware), Array.from(plain), 'the color boundary shifts the plot frontier');
  assert.notEqual(edgeAware[10 * width + 15], plain[10 * width + 15]);
});

test('rectangularity changes the partition in a street-aligned angled block', () => {
  const width = 28, height = 20, n = width * height;
  const seeds = new Int32Array(n), barrier = new Uint8Array(n), edge = new Float32Array(n);
  seeds[10 * width + 4] = 1;
  seeds[15 * width + 20] = 2;
  const blocks = block(width, height, Math.PI / 4, 1);
  const compact = grow(seeds, barrier, edge, width, height, blocks, { sensitivity: 0, rectangularity: 0 });
  const streetAligned = grow(seeds, barrier, edge, width, height, blocks, { sensitivity: 0, rectangularity: 100 });
  assert.notDeepEqual(Array.from(streetAligned), Array.from(compact));
  assert.notEqual(streetAligned[0 * width + 17], compact[0 * width + 17]);
});
