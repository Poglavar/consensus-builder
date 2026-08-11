// findParcelById keeps an id → layer index, and decided it was stale by comparing LAYER COUNT.
//
// A count is not a fingerprint. Deriving a parcel's pieces removes layers and adds layers, so the
// total comes back identical while the ids under it have changed completely — and the index then
// answers for a map that no longer exists. A parcel plainly visible on screen could not be found,
// and callers that resolve a selection through it concluded nothing was selected: block detection
// answered "Select a parcel first" with a parcel selected and highlighted in front of you.
//
// These run the shipped function with its collaborators stubbed.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(fileURLToPath(new URL('../../frontend/js/proposals/data.js', import.meta.url)), 'utf8');

function loadFindParcelById(parcelLayer) {
    const start = source.indexOf('    findParcelById(parcelId) {');
    expect(start, 'findParcelById not found').toBeGreaterThan(-1);
    const end = source.indexOf('\n    },', start);
    expect(end, 'end of findParcelById not found').toBeGreaterThan(start);
    const body = source.slice(start + 4, end + 6);

    // eslint-disable-next-line no-new-func
    const factory = new Function(
        'parcelLayer', 'getParcelIdFromFeature', 'parcelCache', 'console',
        'fetchSingleParcelById', 'fetchParcelsForIds', 'ProposalManager', 'window',
        `return function ${body}`
    );
    return factory(
        parcelLayer,
        feature => feature?.properties?.parcelId ?? null,
        undefined,
        { warn() { }, error() { }, debug() { } },
        () => { },
        () => { },
        undefined,
        {}
    );
}

const layerFor = id => ({ feature: { properties: { parcelId: id } } });

function mapOf(ids) {
    let layers = ids.map(layerFor);
    return {
        getLayers: () => layers,
        eachLayer: fn => layers.forEach(fn),
        hasLayer: layer => layers.includes(layer),
        replaceWith: nextIds => { layers = nextIds.map(layerFor); }
    };
}

function stateFor() {
    return {
        syntheticParcelLayers: new Map(),
        parcelIdIndex: new Map(),
        parcelIdIndexSize: 0,
        recoverParcelFromCache: () => null,
        recoverParcelFromPersistentStorage: () => null
    };
}

describe('the parcel id index and layers that change without changing count', () => {
    it('finds a parcel whose layer replaced another one — same count, different ids', () => {
        const parcelLayer = mapOf(['HR-1', 'HR-2', 'HR-3']);
        const findParcelById = loadFindParcelById(parcelLayer);
        const state = stateFor();

        // Warm the index against the map as it was.
        expect(findParcelById.call(state, 'HR-1')).toBeTruthy();

        // A derivation swaps a cadastral parcel for a piece: one layer out, one in, count unchanged.
        parcelLayer.replaceWith(['HR-1#p7a2', 'HR-2', 'HR-3']);

        expect(findParcelById.call(state, 'HR-1#p7a2')).toBeTruthy();
    });

    it('stops answering for a layer that is no longer on the map', () => {
        const parcelLayer = mapOf(['HR-1', 'HR-2', 'HR-3']);
        const findParcelById = loadFindParcelById(parcelLayer);
        const state = stateFor();

        expect(findParcelById.call(state, 'HR-1')).toBeTruthy();
        parcelLayer.replaceWith(['HR-1#p7a2', 'HR-2', 'HR-3']);

        // The cadastral parcel was replaced by its piece; handing back the old layer would put a
        // shape on screen that the map has already taken off.
        expect(findParcelById.call(state, 'HR-1')).toBeNull();
    });

    it('returns null for an id that was never there, without rebuilding forever', () => {
        const parcelLayer = mapOf(['HR-1', 'HR-2']);
        const findParcelById = loadFindParcelById(parcelLayer);
        const state = stateFor();

        expect(findParcelById.call(state, 'HR-9')).toBeNull();
        expect(findParcelById.call(state, 'HR-9')).toBeNull();
        expect(findParcelById.call(state, 'HR-2')).toBeTruthy();
    });
});
