// Validate request bounds and tree identities without relying on the live municipal service.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBbox, readTrees } from '../../frontend/js/tree-viewer-data.mjs';

test('bounds preserve longitude/latitude order and limit the request area', () => {
  assert.deepEqual(parseBbox('15.983,45.798,15.992,45.804'), [15.983,45.798,15.992,45.804]);
  for (const bounds of [null, ',1,2,3', '0,0,1,1', '16,46,15,45', 'NaN,45,16,46', '181,45,182,46']) {
    assert.throws(() => parseBbox(bounds));
  }
});
const feature = { type: 'Feature', geometry: { type: 'Point', coordinates: [15.990220873147123, 45.800437463466885] }, properties: { sifra: 96584 } };
const collection = features => ({ type: 'FeatureCollection', features });
test('tree records retain source IDs and convert GeoJSON ordering for the map', () => {
  assert.deepEqual(readTrees(collection([feature])), [{ id: 96584, lat: 45.800437463466885, lon: 15.990220873147123 }]);
  assert.deepEqual(readTrees(collection([])), []);
});
test('missing coordinates, duplicate identities and service failures never become a successful empty map', () => {
  for (const data of [{ error: 'unavailable' }, collection([feature, feature]), collection([{ ...feature, geometry: { type: 'Point', coordinates: [null, 45] } }])]) {
    assert.throws(() => readTrees(data));
  }
});
