import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function loadSelection() {
    const source = readFileSync(new URL('../../frontend/js/proposals/data.js', import.meta.url), 'utf8');
    const context = {
        window: {
            MapHighlight: { color: '#369' },
            ParcelPresenter: { getLayer: id => layers[id] || null }
        },
        layers: null
    };
    const layers = context.layers = {
        a: { setStyle: vi.fn(), bringToFront: vi.fn() },
        b: { setStyle: vi.fn(), bringToFront: vi.fn() }
    };
    vm.runInNewContext(source.slice(source.indexOf('const multiParcelSelection = {'), source.indexOf('const PROPOSAL_COLORS = ['))
        + '\nthis.selection = multiParcelSelection;', context);
    return { selection: context.selection, layers };
}

describe('selected parcel Info list map emphasis', () => {
    it('emphasizes only a selected layer and restores the preceding layer between rows', () => {
        const { selection, layers } = loadSelection();
        selection.selectedParcels.add('a');
        selection.selectedParcels.add('b');
        selection.addParcelHighlight = vi.fn();
        selection.removeParcelHighlight = vi.fn();

        selection.highlightInfoListParcel('a');
        expect(layers.a.setStyle).toHaveBeenCalledWith(expect.objectContaining({ fillColor: '#ffb000', weight: 6 }));
        expect([...selection.selectedParcels]).toEqual(['a', 'b']);
        selection.highlightInfoListParcel('b');
        expect(selection.addParcelHighlight).toHaveBeenCalledWith(layers.a);
        expect(layers.b.setStyle).toHaveBeenCalledWith(expect.objectContaining({ fillColor: '#ffb000', weight: 6 }));
        selection.clearInfoListHighlight();
        expect(selection.addParcelHighlight).toHaveBeenCalledWith(layers.b);
    });

    it('restores transient emphasis when selection is cleared', () => {
        const { selection, layers } = loadSelection();
        selection.selectedParcels.add('a');
        selection.addParcelHighlight = vi.fn();
        selection.removeParcelHighlight = vi.fn();
        selection.findParcelById = vi.fn(() => layers.a);
        selection.updateUI = vi.fn();
        selection.highlightInfoListParcel('a');
        selection.clearSelection();
        expect(selection.addParcelHighlight).toHaveBeenCalledWith(layers.a);
        expect(selection.selectedParcels.size).toBe(0);
    });
});
