// Proposal authoring must use the committed live fabric and its presenter. A stale selection may
// never be resolved from a retained layer/cache or by parsing a generated parcel id.

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
            properties: { parcelId: id, id, ...properties },
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
    function installSplitFabric() {
        const baseId = 'HR-330264-574';
        const hiddenBase = parcel(baseId);
        const west = parcel(`${baseId}#west`, {
            cadastreParcelIds: [baseId],
            baseParcelIds: [baseId]
        });
        const east = parcel(`${baseId}#east`, {
            cadastreParcelIds: [baseId],
            baseParcelIds: [baseId]
        });
        const road = parcel(`${baseId}#road`, {
            cadastreParcelIds: [baseId],
            baseParcelIds: [baseId],
            isCorridor: true
        });
        const byId = new Map([
            [`${baseId}#west`, west],
            [`${baseId}#east`, east],
            [`${baseId}#road`, road]
        ]);
        const featureById = new Map(Array.from(byId, ([id, layer]) => [id, layer.feature]));
        const selectedParcels = new Set([baseId, `${baseId}#west`]);
        const addParcelHighlight = vi.fn();

        install('LiveParcelFabric', {
            get: id => featureById.get(String(id)) || null,
            featureId: feature => String(feature?.properties?.parcelId || ''),
            explicitCadastreIds: feature => (feature?.properties?.cadastreParcelIds || []).map(String),
            cadastreIdsForParcelIds: ids => Array.from(new Set((ids || []).flatMap(id => {
                const feature = featureById.get(String(id));
                if (feature) return feature.properties.cadastreParcelIds || [];
                return String(id) === baseId ? [baseId] : [];
            }))),
            entriesForCadastre: ids => {
                const wanted = new Set((ids || []).map(String));
                return Array.from(featureById.values()).filter(feature =>
                    (feature.properties.cadastreParcelIds || []).some(id => wanted.has(String(id))));
            }
        });
        install('ParcelPresenter', { getLayer: id => byId.get(String(id)) || null });
        install('CadastralParcelRepository', { ensureIds: vi.fn(async () => {}) });
        install('multiParcelSelection', {
            isActive: true,
            selectedParcels,
            findParcelById: id => byId.get(String(id)) || null,
            addParcelHighlight,
            updateUI: vi.fn()
        });

        return { baseId, hiddenBase, west, east, road, selectedParcels, addParcelHighlight };
    }

    it('does not guess descendants for a stale fresh selection', async () => {
        const { baseId, selectedParcels, addParcelHighlight } = installSplitFabric();

        const result = await prepareParcelSelection([baseId]);

        expect(result).toEqual({
            ids: [],
            layers: [],
            substituted: false,
            complete: false,
            unresolvedIds: [baseId]
        });
        expect([...selectedParcels]).toEqual([baseId, `${baseId}#west`]);
        expect(addParcelHighlight).not.toHaveBeenCalled();
    });

    it('refuses the entire fresh selection when only one requested id has gone stale', async () => {
        const { baseId, selectedParcels, addParcelHighlight } = installSplitFabric();

        const result = await prepareParcelSelection([`${baseId}#west`, baseId]);

        expect(result.complete).toBe(false);
        expect(result.ids).toEqual([]);
        expect(result.layers).toEqual([]);
        expect(result.unresolvedIds).toEqual([baseId]);
        expect([...selectedParcels]).toEqual([baseId, `${baseId}#west`]);
        expect(addParcelHighlight).not.toHaveBeenCalled();
    });

    it('uses an authored footprint to rebase a stale cadastral anchor onto only its matching live piece', async () => {
        const { baseId, west, selectedParcels, addParcelHighlight } = installSplitFabric();
        install('__planOrder', {
            intersectionArea: vi.fn(feature => feature.properties.parcelId.endsWith('#west') ? 10 : 0)
        });
        const footprint = {
            type: 'Polygon',
            coordinates: [[[15.8, 43.7], [15.9, 43.7], [15.9, 43.8], [15.8, 43.7]]]
        };

        const result = await prepareParcelSelection([baseId], footprint);

        expect(result.substituted).toBe(true);
        expect(result.complete).toBe(true);
        expect(result.unresolvedIds).toEqual([]);
        expect(result.ids).toEqual([`${baseId}#west`]);
        expect(result.layers).toEqual([west]);
        expect([...selectedParcels]).toEqual(result.ids);
        expect(addParcelHighlight).toHaveBeenCalledWith(west);
    });

    it('keeps an exact live child selection exact', async () => {
        const { baseId, east } = installSplitFabric();

        const result = await prepareParcelSelection([`${baseId}#east`]);

        expect(result.ids).toEqual([`${baseId}#east`]);
        expect(result.layers).toEqual([east]);
        expect(result.substituted).toBe(false);
        expect(result.complete).toBe(true);
    });
});
