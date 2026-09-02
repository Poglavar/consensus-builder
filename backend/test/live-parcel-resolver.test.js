// Map interaction must resolve durable cadastral ids through the current visible tessellation.
// Hidden cadastral source geometry is ancestry, not something hover/click is allowed to draw: once
// a road has cut that source, drawing it would put a convincing parcel border straight across the
// road even though the live ground itself is correct.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../frontend/js/parcels/storage.js', import.meta.url), 'utf8');

function layer(parcelId, properties = {}) {
    const feature = {
        type: 'Feature',
        properties: { parcelId, ...properties },
        geometry: {
            type: 'Polygon',
            coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]]
        }
    };
    return {
        feature,
        toGeoJSON: () => feature
    };
}

function loadResolver(liveLayers, indexedLayers = liveLayers) {
    const live = new Set(liveLayers);
    const context = {
        console,
        window: {
            parcelLayer: {
                getLayers: () => [...live],
                hasLayer: candidate => live.has(candidate)
            },
            parcelLayerById: new Map(indexedLayers.map(candidate => [
                String(candidate.feature.properties.parcelId),
                candidate
            ])),
            isRoad: () => false
        }
    };
    vm.runInNewContext(source, context);
    return context.window.resolveLiveParcelLayers;
}

describe('resolveLiveParcelLayers', () => {
    it('expands one cadastral anchor to its visible land pieces and leaves road pieces out', () => {
        const base = layer('HR-A');
        const left = layer('HR-A#left', { baseParcelIds: ['HR-A'] });
        const road = layer('HR-A#road', { baseParcelIds: ['HR-A'], isCorridor: true, isRoad: true });
        const right = layer('HR-A#right', { baseParcelIds: ['HR-A'] });
        const resolve = loadResolver([left, road, right], [base, left, road, right]);

        expect(resolve(['HR-A'])).toEqual([left, right]);
    });

    it('does not expose a full cadastral source if it accidentally coexists with derived pieces', () => {
        const base = layer('HR-A');
        const left = layer('HR-A#left', { baseParcelIds: ['HR-A'] });
        const right = layer('HR-A#right', { baseParcelIds: ['HR-A'] });
        const resolve = loadResolver([base, left, right]);

        expect(resolve(['HR-A'])).toEqual([left, right]);
    });

    it('returns a generated road piece only when that exact live id was requested', () => {
        const road = layer('HR-A#road', { baseParcelIds: ['HR-A'], isCorridor: true, isRoad: true });
        const resolve = loadResolver([road]);

        expect(resolve(['HR-A'])).toEqual([]);
        expect(resolve(['HR-A#road'])).toEqual([road]);
    });

    it('returns the original cadastral layer when no derived tessellation replaced it', () => {
        const base = layer('HR-A');
        const resolve = loadResolver([base]);

        expect(resolve(['HR-A'])).toEqual([base]);
    });
});
