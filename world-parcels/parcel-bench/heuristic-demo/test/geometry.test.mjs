// Oriented rectangle exports retain metric shape, provenance, coverage and geographic coordinates.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { vectorize, PROJECTIONS } from '../public/geometry.mjs';

const require = createRequire(new URL('../../../../backend/package.json', import.meta.url));
const { intersection } = require('polygon-clipping');
const project = require('proj4');
const signedArea = ring => ring.slice(1).reduce((sum, p, i) => sum + ring[i][0] * p[1] - p[0] * ring[i][1], 0) / 2;
const area = ring => Math.abs(ring.slice(1).reduce((sum, p, i) => sum + ring[i][0] * p[1] - p[0] * ring[i][1], 0) / 2);

const gridPlots = [
  { id: 1, polygons: [[[[1, 1], [4, 2], [3, 5], [0, 4], [1, 1]]]] },
  { id: 2, polygons: [[[[5, 1], [8, 2], [7, 5], [4, 4], [5, 1]]]] },
];

for (const [crs, origin] of [['EPSG:32736', [460150, 7140500]], ['EPSG:32645', [334380, 3070550]], ['EPSG:3765', [396590, 4888620]]]) {
  test(`oriented rectangles export as disjoint four-sided polygons in ${crs}`, () => {
    const [x, y] = origin;
    const sample = { id: 'fixture', crs, bbox: [x, y, x + 10, y + 10], warnings: [], provenance: {}, image_sha256: 'fixture' };
    const result = { width: 10, height: 10, plots: gridPlots,
      regions: [
        { id: 1, kind: 'building', source_ids: ['building-a', 'building-b'], area_m2: 10, center: [2, 3], anchor_count: 2 },
        { id: 2, kind: 'generated', source_ids: [], area_m2: 10, center: [6, 3], anchor_count: 0 },
      ], recipe: 'browser-heuristic-v3', stats: { unassigned_m2: 80, groundCoverage: 0.2 },
      rectangle_constraints: { sides: 4, max_aspect_ratio: 4 }, warnings: [] };
    const collection = vectorize(result, sample, { sensitivity: 50, rectangularity: 70 }, { seeds: [], dividers: [] }, { project });
    assert.equal(collection.demo.schema, 'illustrative-plots-v3');
    assert.equal(collection.demo.recipe, 'browser-heuristic-v3');
    assert.deepEqual(collection.demo.rectangle_constraints, result.rectangle_constraints);
    assert.equal(collection.demo.stats.unassigned_m2, 80, 'unassigned ground is reported');
    assert.equal(collection.demo.stats.groundCoverage, 0.2, 'ground coverage statistic is exported');
    assert.equal(collection.features.length, 2);

    const metric = collection.features.map((feature, index) => {
      assert.equal(feature.geometry.type, 'Polygon');
      const [ring, ...holes] = feature.geometry.coordinates;
      assert.equal(holes.length, 0, 'each exported footprint is one solid rectangle');
      assert.equal(ring.length, 5, 'rectangle ring has four corners and closure');
      assert.deepEqual(ring[0], ring.at(-1), 'rectangle ring is closed');
      const local = ring.map(point => project('EPSG:4326', PROJECTIONS[crs], point).map((value, axis) => value - origin[axis]));
      const edges = local.slice(1).map((point, i) => [point[0] - local[i][0], point[1] - local[i][1]]);
      const lengths = edges.map(([dx, dy]) => Math.hypot(dx, dy));
      for (let i = 0; i < 4; i++) {
        const [ax, ay] = edges[i], [bx, by] = edges[(i + 1) % 4];
        assert(Math.abs(ax * bx + ay * by) < 1e-4, 'adjacent sides meet at right angles in source metric');
        assert(Math.abs(lengths[i] - lengths[(i + 2) % 4]) < 1e-4, 'opposite sides have equal lengths');
      }
      const metricArea = area(local);
      assert(Math.abs(metricArea - result.regions[index].area_m2) < 1e-4, 'projected area matches the region area');
      assert.equal(Math.sign(signedArea(ring)), 1, 'GeoJSON exterior is counterclockwise');
      assert.equal(feature.properties.shape, 'rectangle');
      assert.equal(feature.properties.anchor_count, result.regions[index].anchor_count);
      assert.deepEqual(feature.properties.source_feature_ids, result.regions[index].source_ids,
        'all grouped source buildings are recorded, and generated plots use an empty array');
      assert.equal(feature.properties.estimated, true);
      assert.equal(feature.properties.accuracy, 'unvalidated');
      return [[local]];
    });
    assert.equal(intersection(metric[0], metric[1]).length, 0, 'exported rectangles do not overlap');
  });
}
