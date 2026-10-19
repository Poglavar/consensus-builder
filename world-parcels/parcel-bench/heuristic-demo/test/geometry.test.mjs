// Displayed polygon export must preserve holes, disjoint areas, winding and geographic coordinates.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { vectorize, PROJECTIONS } from '../public/geometry.mjs';
import { buildPlotGeometry } from '../public/regularize.mjs';
const require = createRequire(new URL('../../../../backend/package.json', import.meta.url));
const { union, intersection } = require('polygon-clipping'), project = require('proj4');
const { topology } = require('topojson-server'), { feature } = require('topojson-client');
const signedArea = ring => ring.slice(1).reduce((sum, p, i) => sum + ring[i][0] * p[1] - p[0] * ring[i][1], 0) / 2;

for (const [crs, origin] of [['EPSG:32736', [460150, 7140500]], ['EPSG:32645', [334380, 3070550]], ['EPSG:3765', [396590, 4888620]]]) {
  test(`export preserves a hole, neighbouring plot and exact area in ${crs}`, () => {
    const [x, y] = origin;
    const sample = { id: 'fixture', crs, bbox: [x, y, x + 5, y + 5], warnings: [], provenance: {}, image_sha256: 'fixture' };
    const result = { width: 5, height: 5, labels: Int32Array.from([
      1, 1, 1, 2, 2,
      1, 0, 1, 2, 2,
      1, 1, 1, 2, 2,
      1, 1, 1, 2, 2,
      1, 1, 1, 2, 2,
    ]), regions: [{ id: 1, area_m2: 14 }, { id: 2, area_m2: 10 }], warnings: [], recipe: 'test' };
    const shaped = buildPlotGeometry(result, sample, { union, topology, feature });
    const collection = vectorize(shaped, sample, { sensitivity: 10 }, { seeds: [], dividers: [] }, { project });
    const coordinates = collection.features.map(f => f.geometry.coordinates);
    assert.equal(coordinates[0][0].length, 2, 'a missing interior cell stays a polygon hole');
    assert(signedArea(coordinates[0][0][0]) > 0, 'GeoJSON exterior is counterclockwise');
    assert(signedArea(coordinates[0][0][1]) < 0, 'GeoJSON hole is clockwise');
    assert.equal(intersection(...coordinates).length, 0, 'adjacent plots never overlap');
    for (const [index, polygons] of coordinates.entries()) {
      let area = 0;
      for (const polygon of polygons) for (const ring of polygon) {
        const local = ring.map(p => project('EPSG:4326', PROJECTIONS[crs], p).map((v, axis) => v - origin[axis]));
        area += signedArea(local);
      }
      assert(Math.abs(area - result.regions[index].area_m2) < 1e-5, `round-trip area ${area} preserves cell area`);
      assert.equal(collection.features[index].properties.estimated, true);
      assert.equal(collection.features[index].properties.accuracy, 'unvalidated');
    }
  });
}
