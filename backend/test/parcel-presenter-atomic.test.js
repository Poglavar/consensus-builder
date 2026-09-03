import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { createLiveParcelFabric } = require('../../frontend/js/parcels/live-fabric.js');
const presenterSource = readFileSync(new URL('../../frontend/js/parcels/presenter.js', import.meta.url), 'utf8');

function polygon(id, properties = {}) {
    return {
        type: 'Feature',
        properties: { parcelId: id, ...properties },
        geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] }
    };
}

function environment() {
    const fabric = createLiveParcelFabric();
    const members = new Set();
    let failNextAddFor = null;
    const group = {
        addLayer(layer) {
            if (failNextAddFor && layer.feature?.properties?.parcelId === failNextAddFor) {
                failNextAddFor = null;
                throw new Error('Leaflet add failed');
            }
            members.add(layer);
        },
        removeLayer: layer => members.delete(layer),
        hasLayer: layer => members.has(layer)
    };
    const context = {
        console,
        Map,
        Set,
        Promise,
        structuredClone,
        LiveParcelFabric: fabric,
        parcelLayer: group,
        selectedParcelStyle: { color: 'blue' },
        L: {
            geoJSON(feature) {
                const layer = {
                    feature,
                    options: {},
                    on() {},
                    setStyle() {},
                    getBounds() {
                        return { getWest: () => 0, getSouth: () => 0, getEast: () => 1, getNorth: () => 1 };
                    }
                };
                return { getLayers: () => [layer] };
            }
        }
    };
    context.window = context;
    context.globalThis = context;
    vm.runInNewContext(presenterSource, context);
    return {
        fabric,
        presenter: context.ParcelPresenter,
        members,
        failAddFor: id => { failNextAddFor = id; }
    };
}

describe('parcel presenter atomic projection', () => {
    it('projects exactly one layer for each committed live feature', async () => {
        const { fabric, presenter, members } = environment();
        await fabric.transact({}, token => fabric.seedCadastre([polygon('HR-A')], { transaction: token }));

        expect(presenter.snapshot()).toEqual({ revision: 1, layerCount: 1, parcelIds: ['HR-A'] });
        expect(members.size).toBe(1);
        expect(presenter.getLayer('HR-A').feature.properties.parcelId).toBe('HR-A');
        expect(presenter.layerMap).toBeUndefined();
    });

    it('restores the complete previous projection after a mid-swap Leaflet failure', async () => {
        const { fabric, presenter, members, failAddFor } = environment();
        await fabric.transact({}, token => fabric.seedCadastre([polygon('HR-A')], { transaction: token }));
        const originalLayer = presenter.getLayer('HR-A');
        failAddFor('HR-A#park-1');

        await expect(fabric.transact({}, token => {
            fabric.replaceCadastreScope(['HR-A'], [polygon('HR-A#park-1', {
                cadastreParcelIds: ['HR-A'], producedByProposalId: 'park'
            })], { transaction: token });
        })).rejects.toThrow('Leaflet add failed');

        expect(fabric.get('HR-A')).not.toBeNull();
        expect(fabric.get('HR-A#park-1')).toBeNull();
        expect(presenter.getLayer('HR-A')).toBe(originalLayer);
        expect(presenter.getLayer('HR-A#park-1')).toBeNull();
        expect(members).toEqual(new Set([originalLayer]));
    });
});

describe('parcel presenter ownership boundary', () => {
    const frontendJsRoot = fileURLToPath(new URL('../../frontend/js', import.meta.url));
    const presenterPath = fileURLToPath(new URL('../../frontend/js/parcels/presenter.js', import.meta.url));
    const walk = directory => readdirSync(directory).flatMap(name => {
        const absolute = join(directory, name);
        return statSync(absolute).isDirectory() ? walk(absolute) : [absolute];
    });
    const sourceFiles = walk(frontendJsRoot)
        .filter(path => path.endsWith('.js'))
        .filter(path => path !== presenterPath);
    const parcelGroupMutation = /(?:\bparcelLayer|\bglobal\.parcelLayer|\bwindow\.parcelLayer)\s*\.\s*(?:addLayer|removeLayer|clearLayers|addData)\s*\(/;

    it.each(sourceFiles)('%s does not mutate the parcel Leaflet group', absolutePath => {
        const source = readFileSync(absolutePath, 'utf8');
        expect(source, relative(frontendJsRoot, absolutePath)).not.toMatch(parcelGroupMutation);
    });
});
