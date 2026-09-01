// Proposal authoring must use the visible parcel fabric. parcelLayerById deliberately retains
// hidden/consumed ancestors, so resolving a stale selection from that registry can otherwise union
// old cadastral ground with its current descendants and author a footprint that no longer exists.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { prepareParcelSelection } = require('../../frontend/js/proposal-editor-adapters.js');

const touched = new Map();

function install(name, value) {
    if (!touched.has(name)) {
        touched.set(name, {
            existed: Object.prototype.hasOwnProperty.call(globalThis, name),
            value: globalThis[name]
        });
    }
    globalThis[name] = value;
}

function parcel(id, properties = {}) {
    return {
        feature: {
            type: 'Feature',
            properties: { parcelId: id, ...properties },
            geometry: { type: 'Polygon', coordinates: [] }
        }
    };
}

afterEach(() => {
    for (const [name, prior] of touched) {
        if (prior.existed) globalThis[name] = prior.value;
        else delete globalThis[name];
    }
    touched.clear();
});

describe('proposal editor selection follows the live fabric', () => {
    it('substitutes visible descendants for a stale hidden cadastral parent', async () => {
        const baseId = 'HR-330264-574';
        const hiddenBase = parcel(baseId);
        const west = parcel(`${baseId}#west`, {
            parentParcelId: baseId,
            rootParcelId: baseId
        });
        const east = parcel(`${baseId}#east`, {
            parentParcelIds: [`${baseId}#older`],
            rootParcelId: baseId
        });
        const road = parcel(`${baseId}#road`, {
            parentParcelId: baseId,
            rootParcelId: baseId,
            isCorridor: true
        });
        const byId = new Map([
            [baseId, hiddenBase],
            [`${baseId}#west`, west],
            [`${baseId}#east`, east],
            [`${baseId}#road`, road]
        ]);
        const visible = new Set([west, east, road]);
        const selectedParcels = new Set([baseId, `${baseId}#west`]);
        const addParcelHighlight = vi.fn();

        install('parcelLayer', { hasLayer: layer => visible.has(layer) });
        install('parcelLayerById', byId);
        install('resolveParcelLayerById', id => byId.get(String(id)) || null);
        install('CadastralGroundService', { ensureIds: vi.fn(async () => {}) });
        install('multiParcelSelection', {
            isActive: true,
            selectedParcels,
            findParcelById: id => byId.get(String(id)) || null,
            addParcelHighlight,
            updateUI: vi.fn()
        });

        const result = await prepareParcelSelection([baseId, `${baseId}#west`]);

        expect(result.substituted).toBe(true);
        expect(result.ids).toEqual([`${baseId}#west`, `${baseId}#east`]);
        expect(result.layers).toEqual([west, east]);
        expect(result.layers).not.toContain(hiddenBase);
        expect(result.layers).not.toContain(road);
        expect([...selectedParcels]).toEqual(result.ids);
        expect(addParcelHighlight.mock.calls.map(([layer]) => layer)).toEqual([west, east]);
    });
});
