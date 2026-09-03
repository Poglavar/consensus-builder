import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const geometrySource = readFileSync(
    new URL('../../frontend/js/proposals/geometry.js', import.meta.url),
    'utf8'
);
function validBounds(label, center = { lat: 43.75, lng: 15.86 }) {
    return {
        label,
        isValid: () => true,
        getCenter: () => center
    };
}

function buildingFeature() {
    return {
        type: 'Feature',
        properties: {},
        geometry: {
            type: 'Polygon',
            coordinates: [[
                [15.86, 43.75],
                [15.87, 43.75],
                [15.87, 43.76],
                [15.86, 43.75]
            ]]
        }
    };
}

function loadBoundsHarness(proposal, findParcelById = () => null, producedFeatures = []) {
    const geometryBounds = validBounds('geometry');
    const parcelBounds = validBounds('parcel-result');
    const warn = vi.fn();
    const find = vi.fn(findParcelById);
    const context = {
        console: { ...console, debug: vi.fn(), warn },
        proposalStorage: {},
        getProposalByIdOrHash: vi.fn(() => proposal),
        ensureArrayOfStrings: value => Array.isArray(value) ? value.map(String) : [],
        L: {
            geoJSON: vi.fn(() => ({ getBounds: () => geometryBounds })),
            latLngBounds: vi.fn(() => parcelBounds)
        },
        resolveProposalGoalKey: vi.fn(() => ''),
        corridorIsTrack: vi.fn(() => false),
        corridorSurfaceFootprintForDefinition: vi.fn(() => null)
    };
    context.window = context;
    const featuresById = new Map();
    const idsByLayer = new WeakMap();
    context.LiveParcelFabric = {
        featureId: feature => feature?.properties?.parcelId || null,
        explicitCadastreIds: feature => feature?.properties?.cadastreParcelIds || [],
        get: id => featuresById.get(String(id)) || null,
        producedBy: proposalId => proposalId === String(proposal?.proposalId)
            ? producedFeatures
            : []
    };
    context.ParcelPresenter = {
        resolveLiveLayers: ids => ids.map(id => {
            const layer = find(id);
            if (!layer) return null;
            idsByLayer.set(layer, String(id));
            featuresById.set(String(id), {
                type: 'Feature',
                properties: { parcelId: String(id), cadastreParcelIds: [String(id)] },
                geometry: { type: 'Polygon', coordinates: [] }
            });
            return layer;
        }).filter(Boolean),
        getIdForLayer: layer => idsByLayer.get(layer) || null
    };
    vm.runInNewContext(geometrySource, context);
    return { context, geometryBounds, parcelBounds, find, warn };
}

describe('last-applied proposal focus bounds', () => {
    it('uses authored building geometry before retired parents when there are no children', () => {
        const proposal = {
            proposalId: 'block',
            cadastreParcelIds: ['retired-a', 'retired-b'],
            geometry: { buildings: [buildingFeature()] }
        };
        const { context, geometryBounds, find, warn } = loadBoundsHarness(proposal);

        const result = context.calculateBoundsForLastAppliedProposal('block');

        expect(result).toBe(geometryBounds);
        expect(find).not.toHaveBeenCalled();
        expect(warn).not.toHaveBeenCalled();
    });

    it('silently falls back to stored geometry when current child layers are unavailable', () => {
        const proposal = {
            proposalId: 'formation',
            cadastreParcelIds: ['retired-parent'],
            geometry: { buildings: [buildingFeature()] }
        };
        const produced = [{
            type: 'Feature',
            properties: { parcelId: 'derived-child', cadastreParcelIds: ['retired-parent'] },
            geometry: { type: 'Polygon', coordinates: [] }
        }];
        const { context, geometryBounds, find, warn } = loadBoundsHarness(proposal, () => null, produced);

        const result = context.calculateBoundsForLastAppliedProposal('formation');

        expect(find).toHaveBeenCalledWith('derived-child');
        expect(result).toBe(geometryBounds);
        expect(warn).not.toHaveBeenCalled();
    });

    it('uses a live parent only when a zero-child proposal has no stored geometry', () => {
        const liveLayerBounds = validBounds('live-parent');
        const proposal = {
            proposalId: 'metadata-only',
            cadastreParcelIds: ['live-parent']
        };
        const { context, parcelBounds, find, warn } = loadBoundsHarness(
            proposal,
            id => id === 'live-parent' ? { getBounds: () => liveLayerBounds } : null
        );

        const result = context.calculateBoundsForLastAppliedProposal('metadata-only');

        expect(find).toHaveBeenCalledWith('live-parent');
        expect(result).toBe(parcelBounds);
        expect(warn).not.toHaveBeenCalled();
    });

    it('warns once only after live parcels and stored geometry all fail', () => {
        const proposal = {
            proposalId: 'unframeable',
            cadastreParcelIds: ['missing-parent']
        };
        const { context, warn } = loadBoundsHarness(proposal);

        expect(context.calculateBoundsForLastAppliedProposal('unframeable')).toBeNull();
        expect(warn).toHaveBeenCalledOnce();
        expect(warn.mock.calls[0][0]).toContain('no live parcels or stored geometry');
    });
});
