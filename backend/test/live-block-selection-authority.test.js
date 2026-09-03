// Block enumeration must fail closed without road-aware topology, and editor selection must use
// the committed fabric for domain features plus the presenter for Leaflet layers.
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { prepareParcelSelection } = require('../../frontend/js/proposal-editor-adapters.js');

const touched = new Map();
function install(name, value) {
    if (!touched.has(name)) touched.set(name, { existed: name in globalThis, value: globalThis[name] });
    globalThis[name] = value;
}
afterEach(() => {
    touched.forEach((prior, name) => {
        if (prior.existed) globalThis[name] = prior.value;
        else delete globalThis[name];
    });
    touched.clear();
});

const rectangle = (id, extra = {}) => ({
    type: 'Feature',
    properties: { parcelId: id, ...extra },
    geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }
});

describe('strict block and editor parcel authority', () => {
    it('does not use raw adjacency when block topology is unavailable', () => {
        const source = readFileSync(new URL('../../frontend/js/proposals/block-enumeration.js', import.meta.url), 'utf8');
        const context = {
            module: { exports: {} },
            require: request => request.includes('parcel-adjacency') ? { neighborPairs: () => [
                { a: 'A', b: 'B', sharedM: 10 }
            ] } : null,
            console,
            Set,
            Map,
            Array,
            Math,
            JSON,
            String,
            Number,
            Object
        };
        vm.runInNewContext(source, context);
        const result = context.module.exports.enumerateBlocks([
            { id: 'A', rings: [[[0, 0], [10, 0], [10, 10], [0, 0]]], areaM2: 100, isCorridor: false },
            { id: 'B', rings: [[[10, 0], [20, 0], [20, 10], [10, 0]]], areaM2: 100, isCorridor: false }
        ]);
        expect(result.blocks).toEqual([]);
    });

    it('does not substitute stale editor ids without a footprint', async () => {
        const base = 'HR-BASE';
        const child = `${base}#west`;
        const baseFeature = rectangle(base);
        const childFeature = rectangle(child, { baseParcelIds: [base] });
        const childLayer = { feature: childFeature };
        install('LiveParcelFabric', {
            get: id => ({ [base]: baseFeature, [child]: childFeature }[String(id)] || null),
            entriesForCadastre: () => [childFeature],
            featureId: feature => feature.properties.parcelId
        });
        install('ParcelPresenter', { getLayer: id => String(id) === child ? childLayer : null });
        install('parcelLayer', { hasLayer: layer => layer === childLayer });
        install('CadastralParcelRepository', { ensureIds: async () => {} });
        const selectedParcels = new Set();
        install('multiParcelSelection', { selectedParcels, addParcelHighlight: () => {}, updateUI: () => {} });

        const result = await prepareParcelSelection([base]);
        expect(result.complete).toBe(false);
        expect(result.ids).toEqual([]);
        expect(result.unresolvedIds).toEqual([base]);
    });
});
