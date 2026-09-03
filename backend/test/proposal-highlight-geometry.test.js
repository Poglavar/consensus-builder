import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../frontend/js/proposals/geometry.js', import.meta.url), 'utf8');

function loadGeometry(deriveCorridor, producedFeatures = []) {
    const context = {
        console,
        Set,
        buildProposalFeatureCache: vi.fn(() => ({})),
        resolveProposalGoalKey: vi.fn(() => 'road-track'),
        corridorIsTrack: vi.fn(() => false),
        corridorSurfaceFootprintForDefinition: deriveCorridor
    };
    context.LiveParcelFabric = {
        producedBy: () => producedFeatures,
        featureId: feature => feature?.properties?.parcelId || null
    };
    context.ParcelPresenter = {
        resolveLiveLayers: vi.fn(() => []),
        getIdForLayer: layer => layer?.liveParcelId || null
    };
    context.window = context;
    vm.runInNewContext(source, context);
    return context;
}

const multiPolygon = {
    type: 'MultiPolygon',
    coordinates: [
        [[[15.9633, 45.8034], [15.9634, 45.8034], [15.9634, 45.8035], [15.9633, 45.8034]]],
        [[[15.9643, 45.8044], [15.9644, 45.8044], [15.9644, 45.8045], [15.9643, 45.8044]]]
    ]
};

describe('road proposal highlight geometry', () => {
    it('preserves a trimmed definition MultiPolygon instead of relabelling it as Polygon', () => {
        const geometry = loadGeometry();
        const result = geometry.collectProposalFeatureSets({
            proposalId: 'road', goal: 'road-track',
            roadProposal: { definition: { polygon: multiPolygon } }
        }, { includeBuildingGeometry: false });

        expect(result.primaryFeatures).toHaveLength(1);
        expect(result.primaryFeatures[0].geometry.type).toBe('MultiPolygon');
        expect(result.primaryFeatures[0].geometry.coordinates).toEqual(multiPolygon.coordinates);
    });

    it('uses the canonical corridor derivation when the authored polygon is absent', () => {
        const derive = vi.fn(() => multiPolygon);
        const geometry = loadGeometry(derive);
        const result = geometry.collectProposalFeatureSets({
            proposalId: 'road', goal: 'road-track',
            roadProposal: { definition: { points: [{ lat: 1, lng: 2 }, { lat: 2, lng: 3 }] } }
        }, { includeBuildingGeometry: false });

        expect(derive).toHaveBeenCalledOnce();
        expect(result.primaryFeatures).toHaveLength(1);
        expect(result.primaryFeatures[0].geometry.type).toBe('MultiPolygon');
    });
});

describe('proposal parcel outlines', () => {
    it('styles the live road-cut pieces returned for a durable cadastral anchor', () => {
        const bounds = { pad: vi.fn(function () { return this; }) };
        const left = { liveParcelId: 'HR-A#left' };
        const right = { liveParcelId: 'HR-A#right' };
        const geometry = loadGeometry();
        geometry.map = { getBounds: () => bounds };
        geometry.ParcelPresenter.resolveLiveLayers.mockReturnValue([left, right]);
        const visited = [];

        const count = geometry.forEachProposalParcelInViewport(
            new Set(['HR-A']),
            (_layer, id) => visited.push(id)
        );

        expect(count).toBe(2);
        expect(visited).toEqual(['HR-A#left', 'HR-A#right']);
        expect(geometry.ParcelPresenter.resolveLiveLayers).toHaveBeenCalledWith(
            new Set(['HR-A']),
            { bounds, includeCorridors: false }
        );
    });

    it('does not select cadastral inputs when a building proposal has its own geometry', () => {
        const geometry = loadGeometry();
        const ids = geometry.collectProposalSelectionParcelIds(
            {
                proposalId: 'block',
                cadastreParcelIds: ['HR-A', 'HR-B'],
                buildingProposal: {}
            },
            [{ type: 'Feature', properties: {}, geometry: multiPolygon }]
        );

        expect(Array.from(ids)).toEqual([]);
    });

    it('uses live output parcels, never inputs, when a geometry-less proposal formed parcels', () => {
        const produced = [
            { type: 'Feature', properties: { parcelId: 'HR-A#formation-1' }, geometry: multiPolygon },
            { type: 'Feature', properties: { parcelId: 'HR-A#formation-2' }, geometry: multiPolygon }
        ];
        const geometry = loadGeometry(undefined, produced);
        const ids = geometry.collectProposalSelectionParcelIds({
            proposalId: 'formation',
            cadastreParcelIds: ['HR-A']
        });

        expect(Array.from(ids)).toEqual(['HR-A#formation-1', 'HR-A#formation-2']);
    });

    it('uses current subject parcels only for a parcel proposal with no body or outputs', () => {
        const geometry = loadGeometry();
        const ids = geometry.collectProposalSelectionParcelIds({
            proposalId: 'ownership-change',
            cadastreParcelIds: ['HR-A', 'HR-A', 'HR-B']
        });

        expect(Array.from(ids)).toEqual(['HR-A', 'HR-B']);
    });

    it('does not disguise a malformed body proposal as its source cadastre', () => {
        const geometry = loadGeometry();
        const ids = geometry.collectProposalSelectionParcelIds({
            proposalId: 'broken-block',
            cadastreParcelIds: ['HR-A'],
            buildingProposal: {}
        });

        expect(Array.from(ids)).toEqual([]);
    });
});
