// The seed comes from the committed live fabric. Corridor identity is checked before the shared
// source detector is created, so a road can never become a block seed.
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from '@babel/parser';

const source = readFileSync(new URL('../../frontend/js/parcel-blocks.js', import.meta.url), 'utf8');

function functionSource(name) {
    const ast = parse(source, { sourceType: 'script', plugins: ['optionalChaining', 'nullishCoalescingOperator'] });
    const node = ast.program.body.find(statement => statement.type === 'FunctionDeclaration' && statement.id?.name === name);
    if (!node) throw new Error(`missing function ${name}`);
    return source.slice(node.start, node.end);
}

const detection = ['formatBlockText', 'tBlock', 'failBlockDetection', 'sourceBlockDetector', 'selectCurrentBlockIntoMultiSelection']
    .map(functionSource).join('\n');

function harness({ result, seedProperties = {} }) {
    const seedFeature = { type: 'Feature', id: 'seed', properties: { parcelId: 'seed', ...seedProperties }, geometry: null };
    const neighborFeature = { type: 'Feature', id: 'neighbor', properties: { parcelId: 'neighbor' }, geometry: null };
    const seed = { id: 'seed' }, neighbor = { id: 'neighbor' };
    const features = new Map([['seed', seedFeature], ['neighbor', neighborFeature]]);
    const layers = new Map([['seed', seed], ['neighbor', neighbor]]);
    const detector = { detect: vi.fn(async feature => {
        expect(feature).toBe(seedFeature);
        return result;
    }) };
    const createBrowser = vi.fn(() => detector);
    const selectedParcels = new Set(['already-selected']);
    const selection = { isActive: true, selectedParcels, lastSelectedParcelId: 'seed',
        clearSelection: vi.fn(() => selectedParcels.clear()), updateUI: vi.fn(), addParcelHighlight: vi.fn() };
    const alert = vi.fn(), reveal = vi.fn();
    const context = {
        console: { warn: vi.fn(), error: vi.fn() },
        window: { __parcelBlockTopology: { MAX_BLOCK_PARCELS: 100 }, ParcelBlockDetection: { createBrowser },
            i18n: { t: key => key }, showStyledAlert: alert },
        document: { querySelector: () => null }, multiParcelSelection: selection,
        currentParcel: null, selectedParcelId: null,
        liveBlockServices: () => ({}), parcelIdFromLayer: layer => layer?.id || layer?.properties?.parcelId || null,
        liveBlockLayerForId: id => layers.get(String(id)) || null,
        liveBlockPeek: id => features.get(String(id)) || null,
        revealBlockParcels: reveal, updateStatus: vi.fn()
    };
    vm.createContext(context);
    vm.runInContext(`let parcelBlockDetector = null;\n${detection}`, context);
    return { detect: () => context.selectCurrentBlockIntoMultiSelection(seed), alert, createBrowser, detector, reveal, seedFeature, selection };
}

describe('Detect block and live corridor identity', () => {
    it('refuses a corridor seed before creating or calling the shared detector', async () => {
        const h = harness({ result: { isValid: true, ids: ['seed'] }, seedProperties: { isCorridor: true } });
        const before = [...h.selection.selectedParcels];
        expect(await h.detect()).toBe(true);
        expect(h.alert).toHaveBeenCalledOnce();
        expect(h.alert.mock.calls[0][0]).toContain('road or track parcel');
        expect(h.createBrowser).not.toHaveBeenCalled();
        expect(h.detector.detect).not.toHaveBeenCalled();
        expect([...h.selection.selectedParcels]).toEqual(before);
        expect(h.reveal).not.toHaveBeenCalled();
    });

    it('uses the shared detector result for an ordinary seed', async () => {
        const h = harness({ result: { isValid: true, ids: ['seed', 'neighbor'], previewIds: [] } });
        expect(await h.detect()).toBe(true);
        expect(h.createBrowser).toHaveBeenCalledOnce();
        expect(h.detector.detect).toHaveBeenCalledExactlyOnceWith(h.seedFeature);
        expect([...h.selection.selectedParcels].sort()).toEqual(['already-selected', 'neighbor', 'seed']);
        expect(h.alert).not.toHaveBeenCalled();
        expect(h.reveal).toHaveBeenCalledOnce();
    });
});
