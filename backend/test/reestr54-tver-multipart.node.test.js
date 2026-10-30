// Characterize the real native-ID -> connected app components contract behind the integration timeout.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { reestr54Feature } from '../parcels/reestr54-source.js';

const require = createRequire(import.meta.url);
const { createLiveParcelFabric } = require('../../frontend/js/parcels/live-fabric.js');
const workSlicer = require('../../frontend/js/work-slicer.js');
const geometryGrid = require('../../frontend/js/geometry-tolerances.js');
const presenterSource = readFileSync(new URL('../../frontend/js/parcels/presenter.js', import.meta.url), 'utf8');

test('Tver full native MultiPolygon resolves to both rendered app component IDs without modifying source geometry', async () => {
    const nativeId = '69:40:0000000:7394';
    const descriptor = { id: 'ru-tver-reestr54-tver-cadastral', idPrefix: 'RU-REESTR54-TVER-', idField: 'cad_num', outFields: ['cad_num'] };
    const square = x => [[[x, 7730000], [x + 100, 7730000], [x + 100, 7730100], [x, 7730100], [x, 7730000]]];
    const source = reestr54Feature(descriptor, { type: 'Feature', properties: { category: 36368, options: { cad_num: nativeId } },
        geometry: { type: 'MultiPolygon', coordinates: [square(3995600), square(3996000)] } }, nativeId);
    const original = JSON.stringify(source);
    const fabric = createLiveParcelFabric();
    const members = new Set();
    const context = { Map, Set, Promise, structuredClone, __workSlicer: workSlicer, LiveParcelFabric: fabric,
        parcelLayer: { addLayer: layer => members.add(layer), removeLayer: layer => members.delete(layer), hasLayer: layer => members.has(layer) },
        L: { geoJSON: feature => ({ getLayers: () => [{ feature, options: {}, on() {}, setStyle() {},
            getBounds: () => ({ getWest: () => 35, getSouth: () => 56, getEast: () => 36, getNorth: () => 57 }) }] }) } };
    context.window = context;
    context.globalThis = context;
    vm.runInNewContext(presenterSource, context);
    const transaction = fabric.beginMutation({});
    transaction.seedCadastre([source]);
    await transaction.prepare();
    transaction.publish();
    const presenter = context.ParcelPresenter;
    const resolved = presenter.resolveLiveLayers([source.id]);
    assert.equal(presenter.getLayer(source.id), null);
    assert.equal(resolved.length, 2);
    assert.deepEqual(Array.from(resolved, layer => presenter.getIdForLayer(layer)).sort(),
        [source.id + '#cadastre-1', source.id + '#cadastre-2']);
    assert.ok(resolved.every(layer => members.has(layer)));
    // The fabric keeps each component on the shared coordinate grid (docs/geometry-tolerances.md).
    assert.deepEqual(Array.from(resolved, layer => layer.feature.geometry.coordinates).sort((a, b) => a[0][0][0] - b[0][0][0]),
        source.geometry.coordinates.map(part => geometryGrid.snapCoordinates(part)));
    assert.equal(JSON.stringify(source), original);
});
