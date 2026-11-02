// Boundary analysis failures are user-visible and leave both selection and camera untouched.
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

function harness({ result, error }) {
    const feature = { type: 'Feature', id: 'seed', properties: { parcelId: 'seed' }, geometry: null };
    const layer = { id: 'seed' };
    const detector = { detect: vi.fn(async () => {
        if (error) throw error;
        return result;
    }) };
    const createBrowser = vi.fn(() => detector);
    const selectedParcels = new Set(['previous']);
    const selection = { isActive: true, selectedParcels, lastSelectedParcelId: 'seed',
        clearSelection: vi.fn(() => selectedParcels.clear()), updateUI: vi.fn(), addParcelHighlight: vi.fn() };
    const alert = vi.fn(), updateStatus = vi.fn(), reveal = vi.fn();
    const map = { fitBounds: vi.fn(), setView: vi.fn() };
    const context = {
        console: { warn: vi.fn(), error: vi.fn() },
        window: { __parcelBlockTopology: { MAX_BLOCK_PARCELS: 100 }, ParcelBlockDetection: { createBrowser },
            i18n: { t: key => key }, showStyledAlert: alert },
        document: { querySelector: () => null }, map, multiParcelSelection: selection,
        currentParcel: null, selectedParcelId: null,
        liveBlockServices: () => ({}), parcelIdFromLayer: value => value?.id || value?.properties?.parcelId || null,
        liveBlockLayerForId: id => String(id) === 'seed' ? layer : null,
        liveBlockPeek: id => String(id) === 'seed' ? feature : null,
        revealBlockParcels: reveal, updateStatus
    };
    vm.createContext(context);
    vm.runInContext(`let parcelBlockDetector = null;\n${detection}`, context);
    return { detect: () => context.selectCurrentBlockIntoMultiSelection(layer, { replaceSelection: true }),
        alert, createBrowser, detector, map, reveal, selection, updateStatus };
}

describe('a block that cannot be formed', () => {
    it('shows an unbounded source result in an alert and preserves selection and camera', async () => {
        const h = harness({ result: { isValid: false, invalidReason: 'unbounded', ids: [], previewIds: [] } });
        h.selection.isActive = false;
        const before = [...h.selection.selectedParcels];

        expect(await h.detect()).toBe(true);
        expect(h.selection.isActive).toBe(false);
        expect(h.createBrowser).toHaveBeenCalledOnce();
        expect(h.detector.detect).toHaveBeenCalledOnce();
        expect(h.alert).toHaveBeenCalledOnce();
        expect(h.alert.mock.calls[0][0]).toContain('No complete block surrounds this parcel');
        expect(h.updateStatus).toHaveBeenCalledOnce();
        expect([...h.selection.selectedParcels]).toEqual(before);
        expect(h.selection.clearSelection).not.toHaveBeenCalled();
        expect(h.reveal).not.toHaveBeenCalled();
        expect(h.map.fitBounds).not.toHaveBeenCalled();
        expect(h.map.setView).not.toHaveBeenCalled();
    });

    it.each([
        ['block-boundaries-incomplete', 'Could not load complete OSM roads, paths, railways and waterways. Please retry.'],
        ['block-parcels-incomplete', 'Could not load all parcels inside this block. Please retry.']
    ])('shows %s as a loud failure while retaining the selection', async (code, message) => {
        const h = harness({ error: Object.assign(new Error('source data was incomplete'), { code }) });
        h.selection.isActive = false;
        const before = [...h.selection.selectedParcels];

        expect(await h.detect()).toBe(true);
        expect(h.selection.isActive).toBe(false);
        expect(h.detector.detect).toHaveBeenCalledOnce();
        expect(h.alert).toHaveBeenCalledExactlyOnceWith(message, { title: 'Detect block' });
        expect(h.updateStatus).toHaveBeenCalledExactlyOnceWith(message);
        expect([...h.selection.selectedParcels]).toEqual(before);
        expect(h.selection.clearSelection).not.toHaveBeenCalled();
        expect(h.reveal).not.toHaveBeenCalled();
        expect(h.map.fitBounds).not.toHaveBeenCalled();
        expect(h.map.setView).not.toHaveBeenCalled();
    });
});
