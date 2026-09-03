// Cadastral anchors resolve through the committed fabric and presenter, never through hidden
// source layers. A source replaced by a road cut cannot be returned by hover/click.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { createLiveParcelFabric } = require('../../frontend/js/parcels/live-fabric.js');
const presenterSource = readFileSync(new URL('../../frontend/js/parcels/presenter.js', import.meta.url), 'utf8');

const polygon = (id, x0, x1, properties = {}) => ({
    type: 'Feature',
    properties: { parcelId: id, ...properties },
    geometry: { type: 'Polygon', coordinates: [[[x0, 0], [x1, 0], [x1, 1], [x0, 1], [x0, 0]]] }
});

async function mutate(fabric, operation) {
    const mutation = fabric.beginMutation({});
    try {
        await operation(mutation);
        await mutation.prepare();
        mutation.publish();
    } catch (error) {
        mutation.rollback();
        throw error;
    }
}

function environment() {
    const fabric = createLiveParcelFabric();
    const members = new Set();
    const context = {
        console, Map, Set, Promise, structuredClone, LiveParcelFabric: fabric,
        parcelLayer: {
            addLayer: layer => members.add(layer),
            removeLayer: layer => members.delete(layer),
            hasLayer: layer => members.has(layer)
        },
        L: {
            geoJSON(feature) {
                const layer = {
                    feature, options: {}, on() {}, setStyle() {},
                    getBounds() {
                        const xs = feature.geometry.coordinates[0].map(point => point[0]);
                        return {
                            getWest: () => Math.min(...xs), getSouth: () => 0,
                            getEast: () => Math.max(...xs), getNorth: () => 1
                        };
                    }
                };
                return { getLayers: () => [layer] };
            }
        }
    };
    context.window = context;
    context.globalThis = context;
    vm.runInNewContext(presenterSource, context);
    return { fabric, presenter: context.ParcelPresenter };
}

describe('ParcelPresenter.resolveLiveLayers', () => {
    it('expands a cadastral anchor to live land pieces and excludes its corridor piece', async () => {
        const { fabric, presenter } = environment();
        await mutate(fabric, mutation => {
            mutation.seedCadastre([polygon('HR-A', 0, 3)]);
            mutation.replaceCadastreScope(['HR-A'], [
                polygon('HR-A#left', 0, 1, { cadastreParcelIds: ['HR-A'] }),
                polygon('HR-A#road', 1, 2, { cadastreParcelIds: ['HR-A'], isCorridor: true, isRoad: true }),
                polygon('HR-A#right', 2, 3, { cadastreParcelIds: ['HR-A'] })
            ]);
        });

        expect(presenter.resolveLiveLayers(['HR-A']).map(layer => layer.feature.properties.parcelId))
            .toEqual(['HR-A#left', 'HR-A#right']);
        expect(fabric.get('HR-A')).toBeNull();
    });

    it('returns a generated corridor only when that exact live id is requested', async () => {
        const { fabric, presenter } = environment();
        await mutate(fabric, mutation => mutation.upsertFeatures([
            polygon('HR-A#road', 0, 1, { cadastreParcelIds: ['HR-A'], isCorridor: true, isRoad: true })
        ]));

        expect(presenter.resolveLiveLayers(['HR-A'])).toEqual([]);
        expect(presenter.resolveLiveLayers(['HR-A#road']).map(layer => layer.feature.properties.parcelId))
            .toEqual(['HR-A#road']);
    });

    it('returns the original cadastral parcel while it is the live partition', async () => {
        const { fabric, presenter } = environment();
        await mutate(fabric, mutation => mutation.seedCadastre([polygon('HR-A', 0, 1)]));

        expect(presenter.resolveLiveLayers(['HR-A']).map(layer => layer.feature.properties.parcelId))
            .toEqual(['HR-A']);
    });
});
