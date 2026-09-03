import { describe, expect, it } from 'vitest';
import {
    baseParcelIds,
    centerlineSegmentsOf,
    meaningfulPartCount,
    normalizeOwnerAcceptances,
    normalizeOwnershipFlow,
    normalizeProposalRow,
    normalizePolygonGeometry,
    normalizeStoredProposal,
    proposalColumns,
    roadDisconnection,
    splitDefinitionByComponents
} from '../scripts/migrate-tessellation.js';

const square = (x, y, size = 0.001) => [[
    [x, y],
    [x + size, y],
    [x + size, y + size],
    [x, y + size],
    [x, y]
]];

describe('ground-model migration', () => {
    it('flattens legacy underscore-derived parcel ids', () => {
        expect(baseParcelIds(['HR-339270-824_proposal_9'])).toEqual(['HR-339270-824']);
    });

    it('moves parcel consent from generated pieces to the cadastral parcel', () => {
        const migrated = normalizeOwnerAcceptances({
            'HR-1#piece-a': {
                owners: {
                    'parcel:HR-1#piece-a:owner:alice': {
                        key: 'parcel:HR-1#piece-a:owner:alice',
                        displayName: 'Alice'
                    }
                },
                ownerOrder: ['parcel:HR-1#piece-a:owner:alice'],
                acceptedOwnerKeys: ['parcel:HR-1#piece-a:owner:alice'],
                acceptedBy: { 'parcel:HR-1#piece-a:owner:alice': { agentId: 'a' } }
            },
            'HR-1#piece-b': {
                owners: {
                    'parcel:HR-1#piece-b:owner:bob': {
                        key: 'parcel:HR-1#piece-b:owner:bob',
                        displayName: 'Bob'
                    }
                },
                ownerOrder: ['parcel:HR-1#piece-b:owner:bob'],
                acceptedOwnerKeys: []
            }
        });

        expect(Object.keys(migrated)).toEqual(['HR-1']);
        expect(Object.keys(migrated['HR-1'].owners)).toEqual([
            'parcel:HR-1:owner:alice',
            'parcel:HR-1:owner:bob'
        ]);
        expect(migrated['HR-1'].acceptedOwnerKeys).toEqual(['parcel:HR-1:owner:alice']);
        expect(migrated['HR-1'].acceptedBy).toHaveProperty('parcel:HR-1:owner:alice');
    });

    it('aggregates ownership-flow pieces by cadastral parcel and destination', () => {
        expect(normalizeOwnershipFlow([
            { parcelId: 'HR-1#piece-a', cededM2: 12, destination: 'public' },
            { parcelId: 'HR-1#piece-b', cededM2: 8, destination: 'public' },
            { parcelId: 'HR-2', cededM2: 5, destination: 'proposer' }
        ])).toEqual([
            { parcelId: 'HR-1', cededM2: 20, destination: 'public' },
            { parcelId: 'HR-2', cededM2: 5, destination: 'proposer' }
        ]);
    });

    it('repairs a legacy road Polygon whose ring is one level too shallow', () => {
        const ring = square(15, 45)[0];
        expect(normalizePolygonGeometry({ type: 'Polygon', coordinates: ring }))
            .toEqual({ type: 'Polygon', coordinates: [ring] });
        const migrated = normalizeStoredProposal({
            roadProposal: { definition: { polygon: { type: 'Polygon', coordinates: ring } } }
        });
        expect(migrated.value.roadProposal.definition.polygon.coordinates).toEqual([ring]);
    });

    it('moves legacy road geometry mirrors into the one authored definition', () => {
        const polygon = { type: 'Polygon', coordinates: square(15, 45) };
        const migrated = normalizeStoredProposal({
            definition: { points: [[{ lat: 45, lng: 15 }, { lat: 45.1, lng: 15.1 }]] },
            geometry: { roadPlan: { width: 9 }, roadGeometry: { polygon } },
            roadProposal: { parentParcelIds: ['HR-1'], roadGeometry: { polygon } }
        });

        expect(migrated.value.roadProposal.definition).toMatchObject({
            width: 9,
            points: [[{ lat: 45, lng: 15 }, { lat: 45.1, lng: 15.1 }]],
            polygon
        });
        expect(migrated.value).not.toHaveProperty('definition');
        expect(migrated.value).not.toHaveProperty('geometry');
        expect(migrated.value.roadProposal).not.toHaveProperty('roadGeometry');
    });

    it('creates the canonical road container when an old row has mirrors only', () => {
        const polygon = { type: 'Polygon', coordinates: square(15, 45) };
        const migrated = normalizeStoredProposal({
            goal: 'road-track',
            definition: { width: 8 },
            geometry: { roadGeometry: { polygon } }
        });
        expect(migrated.value.roadProposal.definition).toEqual({ width: 8, polygon });
        expect(migrated.value).not.toHaveProperty('definition');
        expect(migrated.value).not.toHaveProperty('geometry');
    });

    it('flattens parent hints and strips all replay output', () => {
        const source = {
            proposalId: 'road-1',
            applied: true,
            localEditAt: 'yesterday',
            parentParcelIds: ['HR-1#old-1', 'HR-1#other-2'],
            childParcelIds: ['HR-1#road-1'],
            childProposalIds: ['square-2'],
            parentFeatures: [{ type: 'Feature' }],
            roadProposal: {
                parentParcelIds: ['HR-1#old-1'],
                childParcelIds: ['HR-1#road-1'],
                formation: { mode: 'cut' },
                definition: {
                    points: [[{ lat: 1, lng: 2 }, { lat: 2, lng: 3 }]],
                    demolishedBuildings: [{ id: 'building-1' }],
                    demolitionScanned: true
                }
            },
            reparcellization: {
                parentParcelIds: ['HR-2#old-1'],
                parcelIds: ['HR-2#old-1'],
                childParcelIds: ['HR-2#plot-1'],
                formation: { mode: 'plots' },
                polygons: [{
                    ownerKey: 'owner-a',
                    geometry: {
                        type: 'MultiPolygon',
                        coordinates: [square(15, 45), square(15.01, 45.01)]
                    }
                }]
            }
        };

        const result = normalizeStoredProposal(source);
        expect(result.changed).toBe(true);
        expect(result.value.cadastreParcelIds).toEqual(['HR-1', 'HR-2']);
        expect(result.value).not.toHaveProperty('parentParcelIds');
        expect(result.value.roadProposal).not.toHaveProperty('parentParcelIds');
        expect(result.value.reparcellization).not.toHaveProperty('parentParcelIds');
        expect(result.value.reparcellization).not.toHaveProperty('parcelIds');
        expect(result.value.reparcellization.polygons).toHaveLength(2);
        expect(result.value).not.toHaveProperty('childParcelIds');
        expect(result.value).not.toHaveProperty('childProposalIds');
        expect(result.value.roadProposal).not.toHaveProperty('childParcelIds');
        expect(result.value.roadProposal).not.toHaveProperty('formation');
        expect(result.value.roadProposal.definition).not.toHaveProperty('demolishedBuildings');
        expect(result.value.reparcellization).not.toHaveProperty('formation');
    });

    it('flattens legacy block membership metadata without deriving it at runtime', () => {
        const result = normalizeStoredProposal({
            cadastreParcelIds: ['HR-330264-502'],
            parentParcelIds: ['HR-330264-502#old-parent'],
            buildingProposal: {
                parentParcelIds: ['HR-330264-502#old-parent'],
                blockParcelIds: [
                    'HR-330264-502#p173qvvu',
                    'HR-330264-504#phb1r45',
                    'HR-330264-502#another-piece'
                ],
                parentParcelNumbers: [
                    { id: 'HR-330264-502#p173qvvu', number: '502' },
                    { id: 'HR-330264-504#phb1r45', number: 'HR-330264-504#phb1r45' }
                ],
                ineligibleParcels: [
                    { parcelId: 'HR-330264-502#p173qvvu', status: 'narrow' },
                    { parcelId: 'HR-330264-504#phb1r45', status: 'small' }
                ],
                ancestorKey: 'HR-330264-502#old-parent'
            }
        });

        expect(result.value.cadastreParcelIds).toEqual(['HR-330264-502', 'HR-330264-504']);
        expect(result.value.buildingProposal.ineligibleParcels).toEqual([
            { status: 'narrow' },
            { status: 'small' }
        ]);
        expect(result.value.buildingProposal).not.toHaveProperty('parentParcelIds');
        expect(result.value.buildingProposal).not.toHaveProperty('blockParcelIds');
        expect(result.value.buildingProposal).not.toHaveProperty('parentParcelNumbers');
        expect(result.value.buildingProposal).not.toHaveProperty('ancestorKey');
    });

    it('converts legacy lifecycle state once instead of leaving a live fallback', () => {
        const result = normalizeStoredProposal({ status: 'Executed', applied: true });
        expect(result.value).toEqual({ lifecycleStatus: 'Executed' });
    });

    it('collapses government-plan child pieces to authored geometry and removes the pieces', () => {
        const geometry = { type: 'Polygon', coordinates: square(15, 45) };
        const result = normalizeStoredProposal({
            tags: { governmentPlan: true },
            childFeatures: [{ type: 'Feature', properties: { isRoad: true }, geometry }],
            roadProposal: {
                childFeatures: [{ type: 'Feature', properties: { isRoad: true }, geometry }],
                definition: { kind: 'government_plan' }
            }
        });
        expect(result.value).not.toHaveProperty('childFeatures');
        expect(result.value.roadProposal).not.toHaveProperty('childFeatures');
        expect(result.value.roadProposal.definition.polygon).toEqual(geometry);
    });

    it('recognizes a government plan stored only in the road column', () => {
        const child = {
            type: 'Feature',
            properties: { isRoad: true },
            geometry: { type: 'Polygon', coordinates: square(15, 45) }
        };
        const row = {
            ancestor_parcel_ids: ['HR-1'],
            cadastre_parcel_ids: null,
            descendant_parcel_ids: null,
            parent_features: null,
            child_features: [child],
            parent_proposal_ids: null,
            child_proposal_ids: null,
            road_proposal: { definition: { kind: 'government_plan' }, childFeatures: [child] },
            building_proposal: null,
            structure_proposal: null,
            reparcellization: null,
            proposal_data: null
        };
        const updates = normalizeProposalRow(row);
        expect(updates.child_features).toBeNull();
        expect(updates.road_proposal).not.toHaveProperty('childFeatures');
        expect(updates.road_proposal.definition.polygon).toEqual(child.geometry);
    });

    it('backfills cadastre ids from the best flat declaration', () => {
        const row = {
            ancestor_parcel_ids: null,
            cadastre_parcel_ids: null,
            descendant_parcel_ids: null,
            parent_features: null,
            child_features: null,
            parent_proposal_ids: null,
            child_proposal_ids: null,
            road_proposal: null,
            building_proposal: null,
            structure_proposal: null,
            reparcellization: null,
            proposal_data: { parentParcelIds: ['HR-7#old-2', 'HR-8'] }
        };
        const updates = normalizeProposalRow(row);
        expect(updates.ancestor_parcel_ids).toBeUndefined();
        expect(updates.cadastre_parcel_ids).toEqual(['HR-7', 'HR-8']);
        expect(updates.proposal_data.cadastreParcelIds).toEqual(['HR-7', 'HR-8']);
        expect(updates.proposal_data).not.toHaveProperty('parentParcelIds');
    });

    it('nulls legacy row columns and is idempotent', () => {
        const row = {
            ancestor_parcel_ids: ['HR-1#old-1'],
            cadastre_parcel_ids: ['HR-1'],
            descendant_parcel_ids: ['HR-1#road-1'],
            parent_features: [{ type: 'Feature' }],
            child_features: [{ type: 'Feature' }],
            parent_proposal_ids: ['older'],
            child_proposal_ids: ['newer'],
            road_proposal: {
                parentParcelIds: ['HR-1#old-1'],
                childParcelIds: ['HR-1#road-1'],
                definition: {
                    surfaceFootprint: { type: 'Polygon', coordinates: [] },
                    demolishedBuildings: [{ id: 1 }]
                }
            },
            building_proposal: null,
            structure_proposal: null,
            reparcellization: null,
            proposal_data: {
                parentParcelIds: ['HR-1#old-1'],
                childParcelIds: ['HR-1#road-1'],
                roadProposal: {
                    parentParcelIds: ['HR-1#old-1'],
                    childParcelIds: ['HR-1#road-1'],
                    definition: {
                        surfaceFootprint: { type: 'Polygon', coordinates: [] },
                        demolishedBuildings: [{ id: 1 }]
                    }
                }
            }
        };
        const updates = normalizeProposalRow(row);
        expect(updates.descendant_parcel_ids).toBeNull();
        expect(updates.parent_features).toBeNull();
        expect(updates.child_features).toBeNull();
        expect(updates.parent_proposal_ids).toBeNull();
        expect(updates.child_proposal_ids).toBeNull();
        expect(updates.ancestor_parcel_ids).toBeNull();
        expect(updates.cadastre_parcel_ids).toBeUndefined();
        expect(updates.road_proposal).not.toHaveProperty('parentParcelIds');
        expect(updates.road_proposal.definition).not.toHaveProperty('surfaceFootprint');
        expect(updates.proposal_data.cadastreParcelIds).toEqual(['HR-1']);
        expect(updates.proposal_data).not.toHaveProperty('parentParcelIds');

        const migrated = { ...row, ...updates };
        expect(normalizeProposalRow(migrated)).toEqual({});
    });

    it('deduplicates base cadastral ids in order', () => {
        expect(baseParcelIds(['HR-1#a', 'HR-1#b', 'HR-2'])).toEqual(['HR-1', 'HR-2']);
    });
});

describe('contiguity rulings (2026-08-07)', () => {
    const seg = (a, b) => [{ lat: a[0], lng: a[1] }, { lat: b[0], lng: b[1] }];

    it('reads modern graphs and the legacy flat single-segment shape', () => {
        expect(centerlineSegmentsOf({ segments: [seg([45, 16], [45, 16.001])] }).length).toBe(1);
        expect(centerlineSegmentsOf({ points: seg([45, 16], [45, 16.001]) }).length).toBe(1);
        expect(centerlineSegmentsOf({})).toEqual([]);
    });

    it('flags a disconnected graph and leaves a connected one alone', () => {
        const chain = {
            segments: [seg([45, 16], [45, 16.001]), seg([45, 16.001], [45, 16.002])]
        };
        expect(roadDisconnection(chain)).toBeNull();
        const broken = {
            segments: [seg([45, 16], [45, 16.001]), seg([45.01, 16], [45.01, 16.001])]
        };
        const found = roadDisconnection(broken);
        expect(found).not.toBeNull();
        expect(found.components.length).toBe(2);
    });

    it('splits a definition per component, filtering id-keyed profiles and dropping the stale polygon', () => {
        const definition = {
            segments: [seg([45, 16], [45, 16.001]), seg([45.01, 16], [45.01, 16.001])],
            segmentIds: ['a', 'b'],
            segmentProfiles: { a: { strips: [] }, b: { strips: [] } },
            polygon: { type: 'Polygon', coordinates: square(15, 45) },
            width: 12
        };
        const found = roadDisconnection(definition);
        const parts = splitDefinitionByComponents(definition, found.segments, found.components);
        expect(parts.length).toBe(2);
        parts.forEach(part => {
            expect(part.points.length).toBe(1);
            expect(part.polygon).toBeNull();
            expect(Object.keys(part.segmentProfiles)).toEqual(part.segmentIds.map(String));
            expect(part.width).toBe(12);
        });
    });

    it('counts meaningful pool parts on the crumb floor', () => {
        expect(meaningfulPartCount({ type: 'Polygon', coordinates: square(15, 45) })).toBe(1);
        expect(meaningfulPartCount({
            type: 'MultiPolygon',
            coordinates: [square(15, 45), square(15.01, 45)]
        })).toBe(2);
        // a sliver far below ~1 m² does not count as a part
        expect(meaningfulPartCount({
            type: 'MultiPolygon',
            coordinates: [square(15, 45), square(15.01, 45, 0.0000001)]
        })).toBe(1);
    });
});

describe('proposalColumns', () => {
    const poolReturning = rows => ({ query: async sql => { poolReturning.lastSql = sql; return { rows }; } });

    it('resolves the table through the search_path, not a hardcoded schema', async () => {
        const pool = poolReturning([{ column_name: 'proposal_id' }, { column_name: 'proposal_data' }]);
        await expect(proposalColumns(pool)).resolves.toEqual(['proposal_id', 'proposal_data']);
        expect(poolReturning.lastSql).toContain("to_regclass('proposal')");
        expect(poolReturning.lastSql).not.toContain("'public'");
    });

    it('refuses to build an insert when the table is not visible', async () => {
        // The server keeps proposal in the `consensus` schema; asking for `public` returned no rows
        // and produced `INSERT INTO proposal () SELECT`, which failed 12 rows into an apply as an
        // opaque syntax error. An empty column list must announce itself instead.
        await expect(proposalColumns(poolReturning([]))).rejects.toThrow(/search_path/);
    });
});
