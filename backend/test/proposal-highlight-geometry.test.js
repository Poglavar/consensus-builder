import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../frontend/js/proposals/geometry.js', import.meta.url), 'utf8');

function loadGeometry(deriveCorridor) {
    const context = {
        console,
        Set,
        buildProposalFeatureCache: vi.fn(() => ({})),
        resolveProposalGoalKey: vi.fn(() => 'road-track'),
        corridorIsTrack: vi.fn(() => false),
        corridorSurfaceFootprintForDefinition: deriveCorridor
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
        const left = { feature: { properties: { parcelId: 'HR-A#left' } } };
        const right = { feature: { properties: { parcelId: 'HR-A#right' } } };
        const geometry = loadGeometry();
        geometry.map = { getBounds: () => bounds };
        geometry.resolveLiveParcelLayers = vi.fn(() => [left, right]);
        const visited = [];

        const count = geometry.forEachProposalParcelInViewport(
            new Set(['HR-A']),
            (_layer, id) => visited.push(id)
        );

        expect(count).toBe(2);
        expect(visited).toEqual(['HR-A#left', 'HR-A#right']);
        expect(geometry.resolveLiveParcelLayers).toHaveBeenCalledWith(
            new Set(['HR-A']),
            { bounds, includeCorridors: false }
        );
    });
});
