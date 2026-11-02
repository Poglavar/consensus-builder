// The source-enclosure limit is enforced by the shared detector; the UI previews its bounded
// sample without replacing the visitor's existing selection.
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { parse } from '@babel/parser';

const require = createRequire(import.meta.url);
const topology = require('../../frontend/js/parcels/block-topology.js');

function functionsFrom(file, names) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    const ast = parse(source, { sourceType: 'script', plugins: ['optionalChaining', 'nullishCoalescingOperator'] });
    return names.map(name => {
        const node = ast.program.body.find(item => item.type === 'FunctionDeclaration' && item.id?.name === name);
        if (!node) throw new Error(`Missing function ${name}`);
        return source.slice(node.start, node.end);
    }).join('\n');
}

const detection = functionsFrom('../../frontend/js/parcel-blocks.js', [
    'formatBlockText', 'tBlock', 'failBlockDetection', 'failBlockParcelLimit', 'sourceBlockDetector',
    'selectCurrentBlockIntoMultiSelection'
]);
const busyHelper = functionsFrom('../../frontend/js/ui-helpers.js', ['runWithButtonBusyState']);

function harness(result, { detectPromise } = {}) {
    const featureRows = Array.from({ length: 120 }, (_, index) => ({ type: 'Feature', id: `P${index}`, properties: { parcelId: `P${index}` }, geometry: null }));
    const layerRows = featureRows.map(feature => ({ id: feature.id }));
    const featuresById = new Map(featureRows.map(feature => [feature.id, feature]));
    const layersById = new Map(layerRows.map(layer => [layer.id, layer]));
    const detector = { detect: vi.fn(() => detectPromise || Promise.resolve(result)) };
    const createBrowser = vi.fn(() => detector);
    const selectionRows = new Set(['previous']);
    const selection = { isActive: true, selectedParcels: selectionRows, lastSelectedParcelId: 'P0',
        clearSelection: vi.fn(() => selectionRows.clear()), updateUI: vi.fn(), addParcelHighlight: vi.fn() };
    const alert = vi.fn();
    const preview = vi.fn(() => Promise.resolve('ok'));
    const reveal = vi.fn();
    const classes = new Set();
    const attrs = new Map();
    const button = {
        innerHTML: 'Detect block', disabled: false,
        classList: { contains: key => classes.has(key), add: key => classes.add(key), remove: key => classes.delete(key) },
        getAttribute: key => attrs.get(key) ?? null,
        setAttribute: (key, value) => attrs.set(key, value), removeAttribute: key => attrs.delete(key),
        set textContent(value) { this.innerHTML = value; }
    };
    const seed = layerRows[0];
    const context = {
        console: { warn: vi.fn(), error: vi.fn() },
        window: { __parcelBlockTopology: topology, ParcelBlockDetection: { createBrowser },
            BlockDetectionPreview: { show: preview }, i18n: { t: key => key }, showStyledAlert: alert },
        document: { querySelector: selector => selector === '.multi-select-detect-btn' ? button : null },
        multiParcelSelection: selection, currentParcel: null, selectedParcelId: null,
        liveBlockServices: () => ({}), parcelIdFromLayer: layer => layer?.id || layer?.properties?.parcelId || null,
        liveBlockLayerForId: id => layersById.get(String(id)) || null,
        liveBlockPeek: id => featuresById.get(String(id)) || null,
        revealBlockParcels: reveal, updateStatus: vi.fn()
    };
    vm.createContext(context);
    vm.runInContext(`let parcelBlockDetector = null;\n${busyHelper}\n${detection}`, context);
    return { detect: () => context.selectCurrentBlockIntoMultiSelection(seed, { replaceSelection: true }),
        alert, button, createBrowser, detector, featuresById, preview, reveal, selection, updateStatus: context.updateStatus };
}

describe('Detect block parcel limit', () => {
    it('previews exactly the first 100 features and leaves the prior selection unchanged', async () => {
        const previewIds = Array.from({ length: 100 }, (_, index) => `P${index}`);
        const h = harness({ isValid: false, invalidReason: 'parcel_limit_exceeded', ids: [], previewIds, count: 120 });
        const before = [...h.selection.selectedParcels];

        expect(await h.detect()).toBe(true);
        expect(h.createBrowser).toHaveBeenCalledOnce();
        expect(h.detector.detect).toHaveBeenCalledOnce();
        expect(h.preview).toHaveBeenCalledOnce();
        expect(h.preview.mock.calls[0][0]).toHaveLength(100);
        expect(h.preview.mock.calls[0][0].map(feature => feature.id)).toEqual(previewIds);
        expect(h.preview.mock.calls[0][1].message).toContain('100');
        expect([...h.selection.selectedParcels]).toEqual(before);
        expect(h.selection.clearSelection).not.toHaveBeenCalled();
        expect(h.selection.addParcelHighlight).not.toHaveBeenCalled();
        expect(h.reveal).not.toHaveBeenCalled();
        expect(h.alert).not.toHaveBeenCalled();
        expect(h.button.disabled).toBe(false);
        expect(h.button.classList.contains('cb-busy')).toBe(false);
    });

    it('bounds a wide queue before inspecting a parcel beyond the limit', () => {
        const inside = vi.fn(() => true);
        const neighbors = vi.fn(() => Array.from({ length: 1000 }, (_, index) => `N${index}`));
        const result = topology.growBlock({ seedId: 'seed', neighborsOf: neighbors, isInside: inside });
        expect(result).toMatchObject({ isValid: false, invalidReason: 'parcel_limit_exceeded', invalidId: 'N99' });
        expect(inside).toHaveBeenCalledTimes(100);
        expect(neighbors).toHaveBeenCalledOnce();
    });

    it('does not count repeated neighbours as new parcels', () => {
        const result = topology.growBlock({ seedId: 'seed', isInside: () => true,
            neighborsOf: id => id === 'seed' ? Array(1000).fill('other') : ['seed'] });
        expect(result.isValid).toBe(true);
        expect(result.ids).toEqual(['seed', 'other']);
    });

    it('keeps the Detect button busy until the shared detector settles', async () => {
        let resolve;
        const pending = new Promise(done => { resolve = done; });
        const h = harness({ isValid: true, ids: ['P0', 'P1'] }, { detectPromise: pending });
        const work = h.detect();
        expect(h.button.disabled).toBe(true);
        expect(h.button.classList.contains('cb-busy')).toBe(true);
        expect(h.button.getAttribute('aria-busy')).toBe('true');
        resolve({ isValid: true, ids: ['P0', 'P1'] });
        await work;
        expect(h.button.disabled).toBe(false);
        expect(h.button.classList.contains('cb-busy')).toBe(false);
        expect(h.button.getAttribute('aria-busy')).toBe(null);
        expect(h.button.innerHTML).toBe('Detect block');
    });
});
