// Unit tests for proposal-to-draft editor adapters and exact geometry round trips.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    CREATABLE_PROPOSAL_GOALS,
    registry,
    corridorAdapter,
    buildBuildingAdapter,
    reparcellizationAdapter
} = require('../../frontend/js/proposal-editor-adapters.js');

function draftFor(adapter, proposal, overrides = {}) {
    const seeded = adapter.draftFromProposal(proposal);
    return {
        id: 'draft-1',
        cityId: proposal.city || 'zagreb',
        goal: seeded.adapterKey || proposal.goal,
        adapterKey: seeded.adapterKey,
        sourceProposalId: proposal.proposalId,
        sourceSnapshot: proposal,
        fields: seeded.fields,
        editorPayload: seeded.editorPayload,
        ...overrides
    };
}

describe('proposal editor adapter registry', () => {
    it('registers every creatable proposal goal', () => {
        expect(registry.completeness(CREATABLE_PROPOSAL_GOALS)).toEqual({ complete: true, missing: [] });
    });

    it('normalizes aliases to the same adapter', () => {
        expect(registry.get('road')).toBe(registry.get('road-track'));
        expect(registry.get('parcel-based')).toBe(registry.get('parcelBased'));
        expect(registry.get('ownership-transfer-from-me')).toBe(registry.get('ownership-transfer'));
    });
});

describe('corridor proposal adapter', () => {
    const proposal = {
        proposalId: 'road-1',
        city: 'zagreb',
        goal: 'road-track',
        primaryType: 'Road',
        title: 'Green street',
        description: 'A calmer street',
        parentParcelIds: ['1', '2'],
        roadProposal: {
            definition: {
                points: [[{ lat: 45.8, lng: 15.9 }, { lat: 45.81, lng: 15.91 }]],
                segmentIds: ['segment-a'],
                width: 12,
                sidewalkWidth: 2,
                profile: { strips: [{ type: 'sidewalk', width: 2 }, { type: 'driving', width: 8 }, { type: 'sidewalk', width: 2 }] },
                tunnels: [{ id: 'tunnel-1', buildingIds: ['b1'] }],
                polygon: { type: 'Polygon', coordinates: [[[15.9, 45.8], [15.91, 45.81], [15.9, 45.8]]] },
                metadata: { isCorridor: true, isRoad: true, isTrack: false }
            }
        }
    };

    it('round-trips canonical centerline, profile, tunnels, and width exactly', () => {
        expect(corridorAdapter.canEdit(proposal)).toBe(true);
        const draft = draftFor(corridorAdapter, proposal);
        const replacement = corridorAdapter.serializeProposal(draft);

        expect(replacement.roadProposal.definition).toEqual(proposal.roadProposal.definition);
        expect(replacement.sourceProposalId).toBeUndefined();
        expect(replacement.proposalId).toBeUndefined();
    });

    it('reports a precise read-only reason for legacy corridors without centerlines', () => {
        expect(corridorAdapter.canEdit({ roadProposal: { definition: { width: 9 } } })).toEqual({
            editable: false,
            reason: 'This legacy corridor does not contain a recoverable centerline.'
        });
    });

    it('summarizes width and cross-section changes', () => {
        const draft = draftFor(corridorAdapter, proposal);
        draft.editorPayload.definition.width = 15;
        draft.editorPayload.definition.profile.strips[1].width = 11;
        const summary = corridorAdapter.summarizeChanges(proposal, draft);

        expect(summary.geometry).toMatchObject({ widthChange: 3, profileChanged: true });
        expect(summary.unchanged).toBe(false);
    });
});

describe('building proposal adapters', () => {
    const manualRing = [[15.9, 45.8], [15.91, 45.8], [15.91, 45.81], [15.9, 45.81], [15.9, 45.8]];
    const feature = {
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [manualRing] },
        properties: { manual: true, height: 18 }
    };
    const proposal = {
        proposalId: 'building-1',
        city: 'zagreb',
        goal: 'buildings',
        typologyType: 'block',
        title: 'Courtyard block',
        parentParcelIds: ['p1'],
        geometry: { buildings: [feature] },
        buildingProposal: {
            parentParcelIds: ['p1'],
            blockName: 'Block A',
            parameters: {
                mode: 'manual',
                manualOuterRing: manualRing.slice(0, -1),
                gaps: [{ edge: 1, ratio: 0.4 }],
                wings: [{ edge: 2, depth: 8 }],
                setback: 4,
                height: 18
            },
            buildingFeature: feature,
            buildings: [feature]
        }
    };

    it('preserves manual footprints and every editor parameter', () => {
        const adapter = buildBuildingAdapter('buildings');
        const draft = draftFor(adapter, proposal);
        const replacement = adapter.serializeProposal(draft);

        expect(replacement.geometry.buildings).toEqual([feature]);
        expect(replacement.buildingProposal.parameters).toEqual(proposal.buildingProposal.parameters);
        expect(replacement.buildingProposal.buildingFeature.geometry.coordinates[0]).toEqual(manualRing);
    });

    it.each([
        ['row', { length: 22, width: 8, height: 12, offsetX: 3, offsetY: -2, rotation: 17, typology: 'row' }],
        ['parcelBased', { maxFloors: 5, minDistance: 6, typology: 'parcelBased' }],
        ['single', { width: 14, length: 18, height: 21, chamfer: 2, rotation: 33, typology: 'single' }]
    ])('round-trips %s geometry and parameters exactly', (typology, parameters) => {
        const source = {
            ...proposal,
            proposalId: `building-${typology}`,
            goal: typology === 'single' ? 'single' : 'buildings',
            typologyType: typology,
            buildingProposal: {
                ...proposal.buildingProposal,
                typologyType: typology,
                parameters,
                buildings: [feature],
                buildingFeature: feature
            }
        };
        const adapter = buildBuildingAdapter(typology);
        const draft = draftFor(adapter, source);
        const replacement = adapter.serializeProposal(draft);

        expect(draft.adapterKey).toBe(typology);
        expect(replacement.buildingProposal.parameters).toEqual(parameters);
        expect(replacement.buildingProposal.buildings).toEqual([feature]);
        expect(replacement.typologyType).toBe(typology);
    });

    it('classifies invalid legacy building data as read-only', () => {
        const adapter = buildBuildingAdapter('single');
        expect(adapter.canEdit({ goal: 'single', buildingProposal: { parameters: { height: 10 } } })).toEqual({
            editable: false,
            reason: 'This legacy building proposal does not contain recoverable footprint geometry.'
        });
    });
});

describe('reparcellization adapter', () => {
    const polygon = coordinates => ({
        geometry: { type: 'Polygon', coordinates: [coordinates] },
        ownerKey: 'owner-a',
        owners: [{ ownerKey: 'owner-a', share: 1 }],
        source: 'manual'
    });
    const polygons = [
        polygon([[15.9, 45.8], [15.905, 45.8], [15.905, 45.81], [15.9, 45.81], [15.9, 45.8]]),
        polygon([[15.905, 45.8], [15.91, 45.8], [15.91, 45.81], [15.905, 45.81], [15.905, 45.8]])
    ];
    const proposal = {
        proposalId: 'reparcel-1',
        city: 'zagreb',
        goal: 'reparcellization',
        title: 'Readjust block',
        parentParcelIds: ['p1', 'p2'],
        reparcellization: {
            parcelIds: ['p1', 'p2'],
            algorithm: 'manual',
            ownershipMode: 'multiple',
            polygons
        }
    };

    it('reopens and serializes saved manual polygons without rerunning an algorithm', () => {
        const draft = draftFor(reparcellizationAdapter, proposal);
        const replacement = reparcellizationAdapter.serializeProposal(draft);

        expect(replacement.reparcellization.polygons).toEqual(polygons);
        expect(replacement.reparcellization.algorithm).toBe('manual');
    });

    it('rejects malformed replacement polygons', () => {
        const draft = draftFor(reparcellizationAdapter, proposal);
        draft.editorPayload.plan.polygons.push({ geometry: { type: 'Polygon', coordinates: [[]] } });

        expect(reparcellizationAdapter.validate(draft)).toMatchObject({
            valid: false,
            errors: expect.arrayContaining([expect.objectContaining({ code: 'invalid-polygon' })])
        });
    });

    it('rejects gaps in required parent coverage and missing parent relationships', () => {
        const draft = draftFor(reparcellizationAdapter, proposal);
        draft.editorPayload.plan.totalArea = 100;
        draft.editorPayload.plan.polygons = [
            { ...polygons[0], area: 40 }
        ];
        draft.editorPayload.plan.parcelIds = ['p1'];

        expect(reparcellizationAdapter.validate(draft)).toMatchObject({
            valid: false,
            errors: expect.arrayContaining([
                expect.objectContaining({ code: 'coverage-gap' }),
                expect.objectContaining({ code: 'missing-parent-coverage' })
            ])
        });
    });
});
