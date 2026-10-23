// The selection section's count and total area (frontend/js/click-stack/click-stack-model.js summarizeSelection):
// every selected parcel counts, only measurable ones add area, and an unknown total is null, not 0.
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { summarizeSelection } = require('../../frontend/js/click-stack/click-stack-model.js');

// Real controller, with UI effects stubbed so selection lifetime is checked without a map.
function selectionController() {
    const source = readFileSync(new URL('../../frontend/js/proposals/data.js', import.meta.url), 'utf8');
    const context = { currentParcel: null, selectedParcelId: null };
    vm.runInNewContext(source.slice(source.indexOf('const multiParcelSelection = {'),
        source.indexOf('const PROPOSAL_COLORS = [')) + '\nthis.selection = multiParcelSelection;', context);
    const multi = context.selection;
    multi.updateUI = vi.fn();
    multi.findParcelById = vi.fn();
    multi.clearSingleParcelSelection = vi.fn();
    multi.removeParcelHighlight = vi.fn();
    return multi;
}

describe('Manual selection lifetime', () => {
    it('finishes and resumes without dropping selected land or its highlights', () => {
        const multi = selectionController();
        multi.isActive = true;
        multi.selectedParcels.add('a');
        multi.selectedParcels.add('b');
        multi.lastSelectedParcelId = 'b';
        multi.toggle();
        expect(multi.isActive).toBe(false);
        expect([...multi.selectedParcels]).toEqual(['a', 'b']);
        expect(multi.lastSelectedParcelId).toBe('b');
        expect(multi.removeParcelHighlight).not.toHaveBeenCalled();
        multi.toggle();
        expect(multi.isActive).toBe(true);
        expect([...multi.selectedParcels]).toEqual(['a', 'b']);
        expect(multi.clearSingleParcelSelection).not.toHaveBeenCalled();
        expect(multi.updateUI).toHaveBeenCalledTimes(2);
    });
    it('Clear removes selected land while keeping Manual active', () => {
        const multi = selectionController();
        multi.isActive = true;
        multi.selectedParcels.add('a');
        const layer = {};
        multi.findParcelById.mockReturnValue(layer);
        multi.clearSelection();
        expect(multi.isActive).toBe(true);
        expect(multi.selectedParcels.size).toBe(0);
        expect(multi.removeParcelHighlight).toHaveBeenCalledWith(layer);
    });
});

const features = {
    a: { geometry: { type: 'Polygon' }, area: 400 },
    b: { geometry: { type: 'Polygon' }, area: 250.5 },
    nogeom: { geometry: null, area: null },
    nan: { geometry: { type: 'Polygon' }, area: NaN },
    negative: { geometry: { type: 'Polygon' }, area: -3 },
    throws: { geometry: { type: 'Polygon' }, area: 'throw' }
};
const featureFor = id => features[id] || null;
const areaOf = feature => {
    if (feature.area === 'throw') throw new Error('bad ring');
    return feature.area;
};

describe('selection section summary', () => {
    it('counts the parcels and sums their measured area', () => {
        expect(summarizeSelection(['a', 'b'], { featureFor, areaOf })).toEqual({ count: 2, area: 650.5, unmeasured: 0 });
    });

    it('counts parcels it cannot measure without adding anything for them', () => {
        expect(summarizeSelection(['a', 'missing', 'nogeom', 'nan', 'negative', 'throws'], { featureFor, areaOf }))
            .toEqual({ count: 6, area: 400, unmeasured: 5 });
    });

    it('reports an unknown total as null, never 0', () => {
        expect(summarizeSelection(['missing', 'nan'], { featureFor, areaOf })).toEqual({ count: 2, area: null, unmeasured: 2 });
        expect(summarizeSelection(['a'], { featureFor })).toEqual({ count: 1, area: null, unmeasured: 1 });
        expect(summarizeSelection([], { featureFor, areaOf })).toEqual({ count: 0, area: null, unmeasured: 0 });
    });

    it('survives no selection and no collaborators', () => {
        expect(summarizeSelection(null)).toEqual({ count: 0, area: null, unmeasured: 0 });
        expect(summarizeSelection(['a', 'b'])).toEqual({ count: 2, area: null, unmeasured: 2 });
    });
});
