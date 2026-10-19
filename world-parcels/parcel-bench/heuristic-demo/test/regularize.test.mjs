// Shared-border tests check straightness, coverage, topology and retained building ownership.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { buildPlotGeometry, pointInPolygons, polygonArea } from '../public/regularize.mjs';

const require = createRequire(new URL('../../../../backend/package.json', import.meta.url));
const topology = require('topojson-server').topology;
const feature = require('topojson-client').feature;
const { union, intersection } = require('polygon-clipping');

function resultFrom(width, height, cellAt, seedSpecs) {
  const labels = new Int32Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) labels[y * width + x] = cellAt(x, y);
  const ids = [...new Set(labels)].filter(id => id > 0).sort((a, b) => a - b);
  const seeds = seedSpecs.map(([id, x, y]) => ({ id, point: [x, y] }));
  return {
    width, height, labels, seeds, buildings: new Uint8Array(labels.length), barrier: new Uint8Array(labels.length),
    regions: ids.map(id => ({ id, area_m2: labels.filter(value => value === id).length,
      center: seeds.find(seed => seed.id === id)?.point })),
  };
}

function sample(width, height) {
  return { bbox: [500000, 6000000, 500000 + width, 6000000 + height] };
}

const build = result => buildPlotGeometry(result, sample(result.width, result.height), { union, topology, feature });

function maxPointDisplacement(points, arcs) {
  const distance = (p, a, b) => {
    const dx = b[0] - a[0], dy = b[1] - a[1], len = dx * dx + dy * dy;
    const t = len ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len)) : 0;
    return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
  };
  const segments = arcs.flatMap(arc => arc.slice(1).map((b, i) => [arc[i], b]));
  return Math.max(...points.map(p => Math.min(...segments.map(([a, b]) => distance(p, a, b)))));
}

function wavyThreePlots(withBuilding = false) {
  const width = 48, height = 32, junctionY = 16;
  const border = y => y === junctionY ? 24 : 24 + (Math.floor(y / 2) % 2 ? 2 : -2);
  const result = resultFrom(width, height, (x, y) => x < border(y) ? 1 : y < junctionY ? 2 : 3,
    [[1, 12, 8], [2, 34, 8], [3, 34, 24]]);
  if (withBuilding) result.buildings[2 * width + 24] = 1;
  return { result, border, junctionY };
}

test('shared wavy borders simplify together, retain the T junction, area, seeds, and 2 m bound', () => {
  const { result, border, junctionY } = wavyThreePlots();
  const output = build(result);
  assert.deepEqual(output.plots.map(plot => plot.id), [1, 2, 3], 'every seeded plot survives');
  assert(output.straightening.output_vertices < output.straightening.input_vertices,
    'the internal shared arcs lose vertices');
  assert(output.straightening.output_vertices <= output.straightening.input_vertices * 0.7,
    'the long shared boundaries become a small number of straight segments');

  const arcAtJunction = output.boundaries.filter(arc => [arc[0], arc.at(-1)].some(([x, y]) => x === border(junctionY - 1) && y === junctionY));
  assert.equal(arcAtJunction.length, 3, 'all three shared arcs retain the original T-junction endpoint');
  assert(Math.abs(output.regions.reduce((sum, region) => sum + region.area_m2, 0)
    - result.regions.reduce((sum, region) => sum + region.area_m2, 0)) < 1e-7,
  'the shared-border change preserves the combined area and outer envelope');
  for (const seed of result.seeds) {
    const plot = output.plots.find(candidate => candidate.id === seed.id);
    assert(pointInPolygons(seed.point, plot.polygons), `seed ${seed.id} remains inside its plot`);
  }

  const plot1 = output.plots.find(plot => plot.id === 1);
  const sourceBorder = Array.from({ length: result.height + 1 }, (_, y) => [border(Math.min(y, result.height - 1)), y]);
  assert(maxPointDisplacement(sourceBorder, output.boundaries) <= 2,
    'source border vertices stay within the 2 m displacement limit');
  assert(plot1 && polygonArea(plot1.polygons) > 0);
  for (let i = 0; i < output.plots.length; i++) for (let j = i + 1; j < output.plots.length; j++) {
    assert.equal(intersection(output.plots[i].polygons, output.plots[j].polygons).length, 0,
      `plots ${output.plots[i].id} and ${output.plots[j].id} share arcs without overlapping`);
  }
});

test('building protection preserves the owning plot around a candidate shortcut', () => {
  const { result } = wavyThreePlots(true);
  const output = build(result);
  const plot = output.plots.find(candidate => candidate.id === 1);
  assert(pointInPolygons([24.5, 2.5], plot.polygons), 'the protected building cell remains in its source plot');
  const cell = [[[[24, 2], [25, 2], [25, 3], [24, 3], [24, 2]]]];
  assert(Math.abs(polygonArea(intersection(plot.polygons, cell)) - 1) < 1e-9, 'the entire building cell survives, not just its centre');
  assert(output.boundaries.some(arc => arc.some(([x, y]) => x === 26 && y === 2)),
    'the border vertex beside the protected cell is not erased by a shortcut');
});

test('holes and disconnected islands retain their topology and area', () => {
  const width = 40, height = 28;
  const result = resultFrom(width, height, (x, y) => {
    if (x >= 8 && x < 14 && y >= 8 && y < 14) return 0;
    if (x >= 28 && x < 33 && y >= 10 && y < 15) return 1;
    return x < 23 ? 1 : 0;
  }, [[1, 4, 4]]);
  const output = build(result), plot = output.plots.find(candidate => candidate.id === 1);
  assert.equal(plot.polygons.length, 2, 'the separate component remains an island');
  assert.equal(plot.polygons[0].length, 2, 'the main component retains its hole');
  assert.equal(polygonArea(plot.polygons), result.regions[0].area_m2, 'cell area is preserved');
  assert(!pointInPolygons([10.5, 10.5], plot.polygons), 'the hole stays empty');
  assert(pointInPolygons([30.5, 12.5], plot.polygons), 'the disconnected island remains part of the plot');
});

test('stair-stepped road frontage becomes linework without entering excluded road cells', () => {
  const width = 48, height = 32;
  const result = resultFrom(width, height, (x, y) => x < 10 + Math.floor(y / 2) ? 1 : 0, [[1, 4, 10]]);
  const output = build(result), plot = output.plots[0];
  assert(output.straightening.output_vertices < output.straightening.input_vertices / 2, 'frontage loses its repeated raster steps');
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (!result.labels[y * width + x]) assert(!pointInPolygons([x + 0.5, y + 0.5], plot.polygons), 'no excluded road cell centre enters a plot');
  }
  assert(polygonArea(plot.polygons) > result.regions[0].area_m2 * 0.96, 'the tightened frontage stays near its original position');
  assert.equal(output.straightening.exterior_max_deviation_m, 1);
});
