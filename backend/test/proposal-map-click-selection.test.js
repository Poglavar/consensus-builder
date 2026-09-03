import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const parcelSelectionSource = readFileSync(
    new URL('../../frontend/js/parcels/ui/parcel-selection.js', import.meta.url),
    'utf8'
);
const drillUiSource = readFileSync(
    new URL('../../frontend/js/proposals/drill-ui.js', import.meta.url),
    'utf8'
);
const layerRenderSource = readFileSync(
    new URL('../../frontend/js/proposals/layer-render.js', import.meta.url),
    'utf8'
);

function loadParcelSelection(drillResult) {
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
        __drillUi: {
            handleParcelClick: vi.fn(() => drillResult)
        },
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
                getLayer: id => String(id) === String(layer.feature.properties.parcelId) ? layer : null
            };
        },
        clearSingleParcelSelection,
        clearSelection,
        showParcelInfoPanel,
        stopPropagation
    };
}

describe('map click selection ownership', () => {
    it('selects a topmost proposal without selecting its ground parcel first', () => {
        const harness = loadParcelSelection({
            handled: true,
            selectedKind: 'proposal',
            selectedRef: 'p:block-1'
        });
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

        expect(harness.context.__drillUi.handleParcelClick)
            .toHaveBeenCalledWith(event.latlng, 'HR-330264-628');
        expect(harness.clearSingleParcelSelection).toHaveBeenCalledOnce();
        expect(targetLayer.setStyle).not.toHaveBeenCalled();
        expect(targetLayer.bringToFront).not.toHaveBeenCalled();
        expect(harness.showParcelInfoPanel).not.toHaveBeenCalled();
        expect(harness.context.selectedParcelId).toBeUndefined();
        expect(harness.stopPropagation).toHaveBeenCalledWith(event);
    });

    it('makes the drill result identify which level won the click', () => {
        const handleParcelClick = drillUiSource.slice(
            drillUiSource.indexOf('function handleParcelClick('),
            drillUiSource.indexOf('function handleSurfaceClick(')
        );
        expect(handleParcelClick).toContain('selectedKind: top.kind');
        expect(handleParcelClick).toContain('return null;');
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
