import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const { MapHighlight } = createRequire(import.meta.url)('../../frontend/js/shared-utils.js');

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
        id, options: {}, styled: 0, setStyle(style) { this.styled += 1; Object.assign(this.options, style); }
    }]));
    const events = [];
    const writes = [];
    const context = {
        MapHighlight,
        console: { log() {} },
        addEventListener() {},
        CustomEvent,
        dispatchEvent: event => events.push(event),
        PersistentStorage: { getItem: () => null, setItem: (key, value) => writes.push([key, JSON.parse(value)]) },
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
    // The registry and the curated fetch always load (road-parcels.js); the detectors do not.
    for (const file of ['parcels/styles.js', 'road-parcels.js']) {
        vm.runInContext(readFileSync(new URL(`../../frontend/js/${file}`, import.meta.url), 'utf8'), context);
    }
    return { context, layers, events, writes };
}

describe('background curated road styling after plan application', () => {
    it('does not turn building plots, parks or remnants into roads through cadastral provenance', async () => {
        const { context, layers, events } = environment();
        expect(await context.fetchCuratedRoadParcels()).toBe(1);
        // Blocks listen for this to re-form around the newly known road.
        expect(events.map(e => [e.type, e.detail.parcelIds])).toEqual([['roadParcelsMarked', ['road-root']]]);
        for (const id of ['building-plot', 'park-plot', 'remainder']) {
            expect(context.isRoadParcel(id), id).toBe(false);
            expect(context.getParcelBaseStyle(id).fillOpacity, id).toBe(0);
        }
    });

    it('repaints only the parcel that became a road, and writes the registry once', async () => {
        const { context, layers, writes } = environment();
        await context.fetchCuratedRoadParcels();
        expect(layers.get('road-root').options).toMatchObject(context.roadStyle);
        // Every other layer was styled from the registry when it was drawn; repainting the whole
        // fabric on every fetch was a long task that grew with the ground loaded.
        for (const id of ['building-plot', 'park-plot', 'remainder', 'corridor', 'track', 'road-piece']) {
            expect(layers.get(id).styled, id).toBe(0);
        }
        expect(writes).toEqual([['roadParcels', ['road-root']]]);
        // Explicitly classified pieces keep their own class when they are drawn.
        expect(context.getParcelBaseStyle('road-piece')).toMatchObject(context.roadStyle);
        expect(context.getParcelBaseStyle('corridor')).toMatchObject(context.corridorParcelStyle);
        expect(context.getParcelBaseStyle('track')).toMatchObject(context.trackStyle);

        // A second fetch that finds nothing new repaints and writes nothing.
        expect(await context.fetchCuratedRoadParcels()).toBe(0);
        expect(layers.get('road-root').styled).toBe(1);
        expect(writes.length).toBe(1);
    });
});
