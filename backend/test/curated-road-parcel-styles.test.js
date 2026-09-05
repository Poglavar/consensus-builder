import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function environment() {
    const features = new Map([
        ['road-root', { parcelId: 'road-root' }],
        ['building-plot', { parcelId: 'building-plot', cadastreParcelIds: ['road-root'], producedByProposalId: 'readjustment' }],
        ['park-plot', { parcelId: 'park-plot', cadastreParcelIds: ['road-root'], structureType: 'park' }],
        ['remainder', { parcelId: 'remainder', cadastreParcelIds: ['road-root'], liveParcelDerivation: 'corridor-arrangement' }],
        ['corridor', { parcelId: 'corridor', cadastreParcelIds: ['road-root'], isRoad: true, isCorridor: true }],
        ['track', { parcelId: 'track', cadastreParcelIds: ['road-root'], isRoad: false, isTrack: true, isCorridor: true }],
        ['road-piece', { parcelId: 'road-piece', cadastreParcelIds: ['road-root'], isRoad: true }]
    ].map(([id, properties]) => [id, { type: 'Feature', properties }]));
    const layers = new Map([...features.keys()].map(id => [id, {
        id, options: {}, setStyle(style) { Object.assign(this.options, style); }
    }]));
    const context = {
        console: { log() {} },
        addEventListener() {},
        PersistentStorage: { getItem: () => null, setItem() {} },
        map: { getBounds: () => [0, 0, 1, 1] },
        CadastralParcelRepository: {
            roadClassificationAvailable: () => true,
            ensureRoadIds: async () => ({ ids: ['road-root'] })
        },
        LiveParcelFabric: {
            get: id => features.get(id),
            list: () => [...features.values()],
            queryBounds: () => [...features.values()],
            cadastreIdsForParcelIds: ids => ids.flatMap(id => features.get(id).properties.cadastreParcelIds || [id])
        },
        ParcelPresenter: { getLayer: id => layers.get(id), getIdForLayer: layer => layer?.id },
        isRoad: id => context.isRoadParcel(id)
    };
    context.window = context;
    vm.createContext(context);
    for (const file of ['parcels/styles.js', 'road-detection.js']) {
        vm.runInContext(readFileSync(new URL(`../../frontend/js/${file}`, import.meta.url), 'utf8'), context);
    }
    return { context, layers };
}

describe('background curated road styling after plan application', () => {
    it('does not turn building plots, parks or remnants into roads through cadastral provenance', async () => {
        const { context, layers } = environment();
        expect(await context.fetchCuratedRoadParcels()).toBe(1);
        for (const id of ['building-plot', 'park-plot', 'remainder']) {
            expect(layers.get(id).options.fillOpacity, id).toBe(0);
            expect(layers.get(id).options, id).toMatchObject(context.getParcelBaseStyle(id));
        }
    });

    it('preserves curated roads and explicitly classified road and track pieces', async () => {
        const { context, layers } = environment();
        await context.fetchCuratedRoadParcels();
        expect(layers.get('road-root').options).toMatchObject(context.roadStyle);
        expect(layers.get('road-piece').options).toMatchObject(context.roadStyle);
        expect(layers.get('corridor').options).toMatchObject(context.corridorParcelStyle);
        expect(layers.get('track').options).toMatchObject(context.trackStyle);
    });
});
