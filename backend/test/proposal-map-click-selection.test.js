import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const parcelSelectionSource = readFileSync(
    new URL('../../frontend/js/parcels/ui/parcel-selection.js', import.meta.url),
    'utf8'
);
const layerRenderSource = readFileSync(
    new URL('../../frontend/js/proposals/layer-render.js', import.meta.url),
    'utf8'
);

function loadParcelSelection() {
    const clearSingleParcelSelection = vi.fn();
    const clearSelection = vi.fn();
    const showParcelInfoPanel = vi.fn();
    const stopPropagation = vi.fn();
    const context = {
        console,
        document: {
            addEventListener: vi.fn(),
            getElementById: vi.fn(() => null),
            querySelector: vi.fn(() => null)
        },
        ParcelsUIParcelPanel: { showParcelInfoPanel },
        multiParcelSelection: {
            isActive: false,
            selectedParcels: new Set(),
            clearSelection,
            clearSingleParcelSelection
        },
        ClickStack: { handleClick: vi.fn(() => true) },
        selectAndHighlightProposal: vi.fn(),
        isRoadParcel: vi.fn(() => false),
        map: { hasLayer: vi.fn(() => false) },
        L: { DomEvent: { stopPropagation } }
    };
    context.window = context;
    vm.runInNewContext(parcelSelectionSource, context);
    return {
        context,
        bindLiveLayer(layer) {
            context.LiveParcelFabric = {
                get: id => String(id) === String(layer.feature.properties.parcelId) ? layer.feature : null
            };
            context.ParcelPresenter = {
                getLayer: id => String(id) === String(layer.feature.properties.parcelId) ? layer : null,
                getIdForLayer: candidate => candidate === layer ? String(layer.feature.properties.parcelId) : null
            };
        },
        clearSingleParcelSelection,
        clearSelection,
        showParcelInfoPanel,
        stopPropagation
    };
}

describe('map click selection ownership', () => {
    // The click stack owns what a click selects: a parcel under a design is neither selected nor
    // painted by the parcel layer; the stack's Designs section answers it (click-stack.md).
    it('hands a click on a parcel under a proposal to the click stack without selecting the ground', () => {
        const harness = loadParcelSelection();
        const targetLayer = {
            feature: {
                type: 'Feature',
                properties: { parcelId: 'HR-330264-628' },
                geometry: { type: 'Polygon', coordinates: [] }
            },
            setStyle: vi.fn(),
            bringToFront: vi.fn()
        };
        const event = {
            target: targetLayer,
            latlng: { lat: 43.7, lng: 15.8 },
            originalEvent: { shiftKey: false }
        };
        harness.bindLiveLayer(targetLayer);

        harness.context.onParcelClick(event);

        expect(harness.context.ClickStack.handleClick).toHaveBeenCalledWith(event.latlng);
        expect(targetLayer.setStyle).not.toHaveBeenCalled();
        expect(targetLayer.bringToFront).not.toHaveBeenCalled();
        expect(harness.showParcelInfoPanel).not.toHaveBeenCalled();
        expect(harness.context.selectAndHighlightProposal).not.toHaveBeenCalled();
        expect(harness.context.selectedParcelId).toBeUndefined();
        expect(harness.stopPropagation).toHaveBeenCalledWith(event);
    });

    it('ignores a click from a layer the fabric has already replaced', () => {
        const harness = loadParcelSelection();
        const current = { feature: { type: 'Feature', properties: { parcelId: 'HR-1' }, geometry: { type: 'Polygon', coordinates: [] } } };
        harness.bindLiveLayer(current);
        const stale = { feature: current.feature };
        harness.context.ParcelPresenter.getIdForLayer = () => 'HR-1';
        harness.context.onParcelClick({ target: stale, latlng: { lat: 1, lng: 2 }, originalEvent: {} });
        expect(harness.context.ClickStack.handleClick).not.toHaveBeenCalled();
    });

    it('renders a body proposal without walking its cadastral parents', () => {
        const render = layerRenderSource.slice(
            layerRenderSource.indexOf('function renderAppliedProposalHighlight('),
            layerRenderSource.indexOf('function updateProposalLayer(')
        );
        expect(render).toContain('collectProposalSelectionParcelIds(proposal, primaryFeatures)');
        expect(render).not.toContain('collectProposalHighlightParcelIdSet');
        expect(render).not.toContain('new Set(parcelIds)');
    });
});
