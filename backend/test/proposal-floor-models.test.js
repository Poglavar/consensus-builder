// Proposal buildings' floor models: read from the frozen consensus.building_floor_model registry, attached only to
// the proposal building and footprint they were drawn for, and never stored back with a published proposal.
import { describe, expect, it } from 'vitest';
import { stripLocalProposalState } from '../proposals/archive-state.js';
import { canonicalJson, fingerprint, attachProposalFloorModels, nativeFloorModelSource } from '../buildings/floor-models.js';

const footprint = (x = 15) => ({ type: 'Polygon', coordinates: [[[x, 45], [x + .001, 45], [x + .001, 45.001], [x, 45]]] });
const plans = () => ({ schema: 'consensus-builder.building-floor-plans.v3', registration: { basis: 'corners', corners: [[15, 45], [15.001, 45], [15.001, 45.001], [15, 45.001]] },
    layouts: [{ id: 'a', source: { url: 'https://example.test/scan.jpg', sha256: 'fixture-sha256' }, architecture: { schema: 'consensus-builder.floor-architecture.v1', dimensionsM: [10, 8],
        wallHeightM: 2.8, slabThicknessM: .2, walls: [[[[0, 0], [1, 0], [1, .1], [0, .1]]]], slabs: [[[[0, 0], [1, 0], [1, 1], [0, 1]]]], landings: [], openings: [], stairs: [], railings: [] } }],
    storeys: [{ id: 'f1', level: 1, elevationM: 0, elevationBasis: 'documented', layoutId: 'a', units: [] }] });
const registryRow = (extra = {}) => ({ city: 'city_a', source: 'proposal', owner_id: 'p1', building_id: 'b1', version: 1,
    updated_at: '2026-10-07T00:00:00.000Z', geom_hash: fingerprint(footprint()), footprint: footprint(), floor_plans: plans(), ...extra });
// Answers only the rows whose identity the query asked for, as the registry's join does.
const registryPool = rows => {
    const seen = [];
    return { seen, query: async (sql, params) => {
        seen.push({ sql, params });
        const keys = new Set(JSON.parse(params[0]).map(key => canonicalJson([key.city, key.source, key.owner_id, key.building_id])));
        return { rows: rows.filter(row => keys.has(canonicalJson([row.city, row.source, row.owner_id, row.building_id]))) };
    } };
};
const proposal = (buildings, extra = {}) => ({ city: 'city_a', proposalId: 'p1', geometry: { buildings }, ...extra });

describe('proposal floor models', () => {
    it('attaches a model only while the building keeps the footprint it was drawn for', async () => {
        const pool = registryPool([registryRow()]);
        const target = proposal([{ geometry: footprint(), properties: { sourceFeatureId: 'b1' } }, { geometry: footprint(16), properties: { sourceFeatureId: 'b2' } }]);
        await attachProposalFloorModels(pool, [target]);
        const [drawn, other] = target.geometry.buildings;
        expect(drawn.properties.floorPlans).toEqual(plans());
        expect(drawn.properties.floorModel).toEqual({ city: 'city_a', source: 'proposal', ownerId: 'p1', buildingId: 'b1', version: 1,
            updatedAt: '2026-10-07T00:00:00.000Z', footprint: footprint() });
        expect(other.properties.floorPlans).toBeUndefined();
        const moved = proposal([{ geometry: footprint(17), properties: { sourceFeatureId: 'b1' } }]);
        await attachProposalFloorModels(pool, [moved]);
        expect(moved.geometry.buildings[0].properties.floorPlans).toBeUndefined();
    });

    it('never attaches a same-numbered building of another proposal or city', async () => {
        const pool = registryPool([registryRow()]);
        for (const extra of [{ proposalId: 'p2' }, { city: 'city_b' }]) {
            const other = proposal([{ geometry: footprint(), properties: { sourceFeatureId: 'b1' } }], extra);
            await attachProposalFloorModels(pool, [other]);
            expect(other.geometry.buildings[0].properties.floorPlans).toBeUndefined();
        }
        expect(nativeFloorModelSource('building.feed-a', 'custom-3d')).not.toBe(nativeFloorModelSource('building.feed-b', 'custom-3d'));
        expect(nativeFloorModelSource(undefined, 'survey-3d')).toBe('survey-3d');
    });

    it('asks for provider-prefixed DGU and ISPU identities in one query', async () => {
        const pool = registryPool([]);
        await attachProposalFloorModels(pool, [proposal([{ geometry: footprint(), properties: { dguBuildingId: 123 } },
            { geometry: footprint(16), properties: { sourceLayerId: 123 } }])]);
        expect(pool.seen).toHaveLength(1);
        expect(JSON.parse(pool.seen[0].params[0]).map(key => [key.source, key.owner_id, key.building_id]))
            .toEqual([['proposal', 'p1', 'dgu-building:123'], ['proposal', 'p1', 'source-layer:123']]);
    });

    it('does not persist API-enriched models when publishing a proposal again', () => {
        const record = { geometry: { buildings: [{ geometry: footprint(), properties: { sourceFeatureId: 'b1', floorPlans: plans(), floorModel: { version: 1 }, height: 12 } }] } };
        const saved = stripLocalProposalState(record);
        expect(saved.geometry.buildings[0].properties).toEqual({ sourceFeatureId: 'b1', height: 12 });
        expect(record.geometry.buildings[0].properties.floorPlans).toEqual(plans());
    });
});
