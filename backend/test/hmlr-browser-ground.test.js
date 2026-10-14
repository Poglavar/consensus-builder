import { afterAll, beforeAll, test } from 'vitest';
import assert from 'node:assert/strict';
import { area as geoArea, intersect } from '@turf/turf';
import { createHmlrBrowserGroundEngine, HMLR_BROWSER_GROUND_POLICY, HMLR_BROWSER_GROUND_PREFIX } from '../parcels/hmlr-browser-ground.js';
import { toWgs84 } from '../parcels/osgb36-projection.js';

let engine;
beforeAll(async () => { engine = await createHmlrBrowserGroundEngine(); });
afterAll(() => { engine = null; });

const ring = (x, y, size) => [[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]];
const feature = (id, coordinates) => ({ type: 'Feature', properties: { INSPIREID: id }, geometry: { type: 'Polygon', coordinates } });
const square = (id, x, y, size) => feature(id, [ring(x, y, size)]);
const areaOverlap = (a, b) => {
    const overlap = intersect(a, b);
    return overlap ? geoArea(overlap) : 0;
};

test('projects before overlay, preserves exact decimal IDs, and is input-order independent', async () => {
    const large = square('900719925474099312345', 530000, 180000, 20);
    const small = square('9', 530010, 180005, 20);
    const a = await engine.resolve([large, small]);
    const b = await engine.resolve([small, large]);
    assert.equal(a.complete, true);
    assert.equal(a.sourceId, 'gb-hmlr-browser-v1');
    assert.equal(a.normalizationPolicy, HMLR_BROWSER_GROUND_POLICY);
    assert.deepEqual(a.features.map(item => item.id).sort(), [
        `${HMLR_BROWSER_GROUND_PREFIX}9`, `${HMLR_BROWSER_GROUND_PREFIX}900719925474099312345`
    ].sort());
    const map = result => Object.fromEntries(result.features.map(item => [item.id, item]));
    assert.deepEqual(map(a), map(b));
    assert.equal(areaOverlap(a.features[0], a.features[1]), 0);
    assert.ok(a.features.every(item => item.geometry.type === 'MultiPolygon' && item.properties.derivation.policy === HMLR_BROWSER_GROUND_POLICY));
});

test('normalizes IDs and coalesces topologically equal duplicates, while rejecting conflicts', async () => {
    const original = square('00042', 530000, 180000, 10);
    const reversed = feature('42', [ring(530000, 180000, 10).reverse()]);
    const result = await engine.resolve([original, reversed]);
    assert.deepEqual(result.features.map(item => item.id), [`${HMLR_BROWSER_GROUND_PREFIX}42`]);
    await assert.rejects(engine.resolve([original, square('42', 530020, 180000, 10)]), /Conflicting geometry/);
    await assert.rejects(engine.resolve([square('43', 530000, 180000, 10), square('43', 530000.0004, 180000, 10)]), /Conflicting geometry/);
});

test('repairs self intersections and preserves multipart shells and holes', async () => {
    const bowtie = feature('10', [[[530000, 180000], [530010, 180010], [530000, 180010], [530010, 180000], [530000, 180000]]]);
    const repaired = await engine.resolve([bowtie]);
    assert.equal(repaired.features[0].properties.derivation.inputRepaired, true);
    assert.equal(repaired.features[0].geometry.type, 'MultiPolygon');
    const shellA = ring(530000, 180000, 20), holeA = ring(530005, 180005, 5).reverse(), shellB = ring(530030, 180000, 10);
    const multipart = feature('11', [shellA, holeA, shellB]);
    const result = await engine.resolve([multipart]);
    const polygons = result.features[0].geometry.coordinates;
    assert.equal(polygons.length, 2);
    assert.ok(polygons.some(polygon => polygon.length === 2));
    assert.ok(polygons.some(polygon => polygon.length === 1));
});

test('suppresses fully covered lower-ranked titles and resolves only selected targets', async () => {
    const enclosing = square('1', 530000, 180000, 30);
    const contained = square('2', 530005, 180005, 5);
    const result = await engine.resolve([contained, enclosing]);
    assert.deepEqual(result.suppressedIds, [`${HMLR_BROWSER_GROUND_PREFIX}2`]);
    assert.deepEqual(result.features.map(item => item.id), [`${HMLR_BROWSER_GROUND_PREFIX}1`]);
    const selected = await engine.resolve([contained, enclosing], { selectedIds: [`${HMLR_BROWSER_GROUND_PREFIX}2`] });
    assert.deepEqual(selected.features, []);
    assert.deepEqual(selected.suppressedIds, [`${HMLR_BROWSER_GROUND_PREFIX}2`]);
    const selectedWinner = await engine.resolve([contained, enclosing], { selectedIds: ['0001'] });
    assert.deepEqual(selectedWinner.features.map(item => item.id), [`${HMLR_BROWSER_GROUND_PREFIX}1`]);
    assert.deepEqual(selectedWinner.suppressedIds, []);
});

test('packed bbox search finds higher-ranked obstacles in both branches beyond a leaf', async () => {
    const features = [square('1', 530000, 180000, 100), square('2', 530300, 180000, 100)];
    for (let i = 0; i < 12; i++) {
        const baseX = i < 6 ? 530010 : 530310;
        const x = baseX + (i % 3) * 20, y = 180010 + Math.floor((i % 6) / 3) * 30;
        features.push(square(String(100 + i), x, y, 15));
    }
    const result = await engine.resolve(features);
    assert.equal(result.features.length, 2);
    assert.equal(result.suppressedIds.length, 12);
    assert.deepEqual(result.features.map(item => item.id).sort(), [
        `${HMLR_BROWSER_GROUND_PREFIX}1`, `${HMLR_BROWSER_GROUND_PREFIX}2`
    ].sort());
});

test('rejects non-finite or unclosed native rings before GEOS conversion', async () => {
    await assert.rejects(engine.resolve([feature('1', [[[1, 2], [2, 2], [2, 3], [1, 2.5]]])]), /Invalid native HMLR ring/);
    await assert.rejects(engine.resolve([feature('1', [[[1, 2], [2, 2], [2, Infinity], [1, 2]]])]), /Invalid native HMLR ring/);
});

test('rectangle tests use the policy input: an L around the rectangle misses it, a parcel inside meets it', async () => {
    const [x, y] = toWgs84([530810, 180210]);
    const bounds = [x - 0.00002, y - 0.00002, x + 0.00002, y + 0.00002];
    const ell = feature('7', [[[530790, 180150], [531000, 180150], [531000, 180160], [530800, 180160], [530800, 180300], [530790, 180300], [530790, 180150]]]);
    const inside = square('8', 530805, 180205, 10);
    const far = square('9', 531500, 180205, 10);
    assert.deepEqual(await engine.intersectsBounds([ell, inside, far], bounds), [false, true, false]);
    await assert.rejects(engine.intersectsBounds([ell], [1, 2, 0, 3]), /WGS84 bounds/);
});

test('actual ground output uses the official OS control point and records the operation', async () => {
    const result = await engine.resolve([square('17', 91492.146, 11318.804, 10)]);
    const expected = [-6.29977752014, 49.92226393730];
    const vertices = result.features[0].geometry.coordinates.flat(2);
    const nearest = Math.min(...vertices.map(point => Math.hypot((point[0] - expected[0]) * 111320 * Math.cos(expected[1] * Math.PI / 180),
        (point[1] - expected[1]) * 111320)));
    assert.ok(nearest < 0.01);
    assert.equal(result.features[0].properties.coordinateOperation.nativeCrs, 'EPSG:27700');
    assert.equal(result.features[0].properties.coordinateOperation.fittedOffsetApplied, false);
});

