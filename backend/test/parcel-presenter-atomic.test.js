import { describe, expect, it, vi } from 'vitest';
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

function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    Object.values(value).forEach(deepFreeze);
    return Object.freeze(value);
}

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

function environment(options = {}) {
    const fabric = createLiveParcelFabric();
    const members = new Set(options.initialLayers || []);
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
        hasLayer: layer => members.has(layer),
        getLayers: () => Array.from(members)
    };
    const context = {
        MapHighlight: require('../../frontend/js/shared-utils.js').MapHighlight,
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
    // presenter.js slices its prepare with work-slicer.js, loaded before it in the browser.
    context.__workSlicer = require('../../frontend/js/work-slicer.js');
    // Post-commit notices need a timer and an event target; the atomic-projection tests run
    // without either, which keeps their commits observable synchronously.
    const timers = [];
    if (options.events) {
        context.dispatchEvent = vi.fn();
        context.CustomEvent = class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } };
    }
    if (options.timers) context.setTimeout = callback => { timers.push(callback); return timers.length; };
    vm.runInNewContext(presenterSource, context);
    return {
        fabric,
        context,
        timers,
        flushTimers: () => { const due = timers.splice(0); due.forEach(callback => callback()); },
        presenter: context.ParcelPresenter,
        members,
        failAddFor: id => { failNextAddFor = id; }
    };
}

describe('parcel presenter atomic projection', () => {
    it('removes stale layers when adopting an existing group at startup', () => {
        const stale = { feature: polygon('HR-STALE') };
        const { presenter, members } = environment({ initialLayers: [stale] });

        expect(members.size).toBe(0);
        expect(presenter.getIdForLayer(stale)).toBeNull();
        expect(presenter.snapshot()).toEqual({ city: 'default', revision: 0, layerCount: 0, parcelIds: [] });
    });

    it('projects exactly one layer for each committed live feature', async () => {
        const { fabric, presenter, members } = environment();
        await mutate(fabric, mutation => mutation.seedCadastre([polygon('HR-A')]));

        expect(presenter.snapshot()).toEqual({ city: 'default', revision: 1, layerCount: 1, parcelIds: ['HR-A'] });
        expect(members.size).toBe(1);
        expect(presenter.getLayer('HR-A').feature.properties.parcelId).toBe('HR-A');
        expect(presenter.getIdForLayer(presenter.getLayer('HR-A'))).toBe('HR-A');
        expect(presenter.layerMap).toBeUndefined();
    });

    it('restores the complete previous projection after a mid-swap Leaflet failure', async () => {
        const { fabric, presenter, members, failAddFor } = environment();
        await mutate(fabric, mutation => mutation.seedCadastre([polygon('HR-A')]));
        const originalLayer = presenter.getLayer('HR-A');
        failAddFor('HR-A#park-1');

        await expect(mutate(fabric, mutation => {
            mutation.replaceCadastreScope(['HR-A'], [polygon('HR-A#park-1', {
                cadastreParcelIds: ['HR-A'], producedByProposalId: 'park'
            })]);
        })).rejects.toThrow('Leaflet add failed');

        expect(fabric.get('HR-A')).not.toBeNull();
        expect(fabric.get('HR-A#park-1')).toBeNull();
        expect(presenter.getLayer('HR-A')).toBe(originalLayer);
        expect(presenter.getIdForLayer(originalLayer)).toBe('HR-A');
        expect(presenter.getLayer('HR-A#park-1')).toBeNull();
        expect(members).toEqual(new Set([originalLayer]));
    });

    it('projects a mutable owned clone from immutable draft peek and preserves rollback', async () => {
        const { fabric, presenter, context, members } = environment();
        await mutate(fabric, mutation => mutation.seedCadastre([polygon('HR-A')]));
        const originalLayer = presenter.getLayer('HR-A');
        const source = deepFreeze(polygon('HR-A', { sourceLabel: 'immutable' }));
        const cloneFeature = vi.fn(value => structuredClone(value));
        context.structuredClone = cloneFeature;
        const draftView = {
            peek: vi.fn(id => id === 'HR-A' ? source : undefined),
            get: vi.fn(() => { throw new Error('clone-producing get must not be used'); })
        };

        const prepared = await presenter.prepare({
            addedIds: [], updatedIds: ['HR-A'], removedIds: [], revision: 2
        }, draftView);

        expect(draftView.peek).toHaveBeenCalledWith('HR-A');
        expect(draftView.get).not.toHaveBeenCalled();
        expect(cloneFeature).toHaveBeenCalledTimes(1);
        const replacement = prepared.replacements.get('HR-A');
        expect(replacement.__parcelPresenterOwned).toBe(true);
        expect(replacement.feature).not.toBe(source);
        expect(Object.isFrozen(replacement.feature)).toBe(false);
        replacement.feature.properties.presentationLabel = 'owned by presenter';
        expect(source.properties).toEqual({ parcelId: 'HR-A', sourceLabel: 'immutable' });

        presenter.commit(prepared);
        expect(presenter.getLayer('HR-A')).toBe(replacement);
        expect(members).toEqual(new Set([replacement]));
        presenter.rollback(prepared);
        expect(presenter.getLayer('HR-A')).toBe(originalLayer);
        expect(members).toEqual(new Set([originalLayer]));
        expect(presenter.snapshot().revision).toBe(1);
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

// The swap is synchronous; the notices it raises are not. Commits landing in one tick share one
// deferred notice with the union of their ids, so per-cell ground arrivals wake the whole-map
// listeners once instead of once per cell, and never inside the commit task.
describe('parcel presenter post-commit notices', () => {
    it('coalesces the commits of one tick into one deferred notice carrying the union of ids', async () => {
        const { fabric, context, timers, flushTimers } = environment({ events: true, timers: true });
        await mutate(fabric, mutation => mutation.seedCadastre([polygon('HR-A')]));
        await mutate(fabric, mutation => mutation.seedCadastre([polygon('HR-B')]));

        expect(context.dispatchEvent).not.toHaveBeenCalled();
        expect(timers).toHaveLength(1);

        flushTimers();
        const events = context.dispatchEvent.mock.calls.map(call => call[0]);
        expect(events.map(event => event.type)).toEqual(['parcelFabricCommitted', 'parcelDataLoaded', 'parcelCoverageUpdated']);
        expect(events[1].detail.parcelIds.sort()).toEqual(['HR-A', 'HR-B']);
        expect(events[1].detail.revision).toBe(2);
        expect(events[0].detail.addedIds.sort()).toEqual(['HR-A', 'HR-B']);

        await mutate(fabric, mutation => mutation.seedCadastre([polygon('HR-C')]));
        expect(timers).toHaveLength(1);
        flushTimers();
        expect(context.dispatchEvent).toHaveBeenCalledTimes(6);
        expect(context.dispatchEvent.mock.calls[4][0].detail.parcelIds).toEqual(['HR-C']);
    });

    it('reports a piece added then replaced within one tick once, as removed', async () => {
        const { fabric, context, flushTimers } = environment({ events: true, timers: true });
        await mutate(fabric, mutation => mutation.seedCadastre([polygon('HR-A')]));
        await mutate(fabric, mutation => mutation.replaceCadastreScope(['HR-A'], [polygon('HR-A#park-1', {
            cadastreParcelIds: ['HR-A'], producedByProposalId: 'park'
        })]));
        flushTimers();
        const committed = context.dispatchEvent.mock.calls[0][0].detail;
        expect(committed.addedIds).toEqual(['HR-A#park-1']);
        expect(committed.updatedIds).toEqual([]);
        expect(committed.removedIds).toEqual(['HR-A']);
    });

    it('dispatches synchronously where no timer exists', async () => {
        const { fabric, context } = environment({ events: true });
        await mutate(fabric, mutation => mutation.seedCadastre([polygon('HR-A')]));
        expect(context.dispatchEvent).toHaveBeenCalledTimes(3);
        expect(context.dispatchEvent.mock.calls[1][0].detail.parcelIds).toEqual(['HR-A']);
    });
});
