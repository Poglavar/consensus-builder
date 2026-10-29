// A footprint drawn over parcels whose union really covers it must be accepted; one that really
// sticks out must still be refused. Reproduced 2026-10-17 with real Zagreb parcels: a park moved with
// Snap to edges onto parcel 2629 lay wholly inside its five declared parcels, but touched one of them
// (2626) by about 0.09 m². Coverage was the sum of the ANCESTORS' overlaps, and an ancestor needs at
// least 0.25 m², so that sliver dropped out of the covered area and the park read as sticking out by
// more than the 0.01 m² the flat-ground check allows ("The proposal geometry extends beyond its
// selected cadastral parcels"). plan-order.js measureCoverage now counts every overlap, and the
// completeness check asks whether the uncovered part is ground (geometry-tolerances.js). That
// 0.09 m² touch reaches 27 cm into 2626, so by the shared rule it is real ground and 2626 an ancestor.
import { describe, expect, it } from 'vitest';
import * as turf from '@turf/turf';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
globalThis.turf = turf;
const planOrder = require('../../frontend/js/proposals/plan-order.js');
const { createCadastralParcelRepository } = require('../../frontend/js/parcels/ground-service.js');
const { ProposalManager } = require('../../frontend/js/proposal-manager.js');

const fixture = JSON.parse(readFileSync(new URL('./fixtures/park-snap-coverage.json', import.meta.url), 'utf8'));

async function repositoryWithFixtureParcels() {
    const repository = createCadastralParcelRepository({
        root: { __planOrder: planOrder, turf },
        onFeatures: async () => {},
        convertFeatures: collection => collection,
        transport: {
            fetchByIds: async ids => ({
                status: 'ready', complete: true, ids: ids.map(String), absentIds: [],
                features: fixture.parcels.filter(feature => ids.includes(feature.properties.parcelId))
            }),
            fetchUnderGeometry: async () => ({ status: 'ready', features: [], absentIds: [], count: 0 }),
            fetchRoadIds: async () => ({ status: 'ready', ids: [] }),
            supportsRoadIds: () => false
        },
        footprintOf: record => record.footprint || null,
        cadastreParcelIdsOf: record => record.cadastreParcelIds || []
    });
    await repository.ensureIds(fixture.declared);
    return repository;
}

// The park as a record: its structure geometry is the footprint, its declaration the five parcels.
const park = geometry => ({
    proposalId: 'moved-park', goal: 'park', applied: true,
    cadastreParcelIds: fixture.declared.slice(),
    structureProposal: { kind: 'park', geometry }
});

function groundFailure(record, repository) {
    const prior = { repo: globalThis.CadastralParcelRepository, order: globalThis.__planOrder };
    globalThis.CadastralParcelRepository = repository;
    globalThis.__planOrder = planOrder;
    try {
        return ProposalManager.getProposalGroundFailure(record);
    } finally {
        globalThis.CadastralParcelRepository = prior.repo;
        globalThis.__planOrder = prior.order;
    }
}

describe('flat ground coverage of a footprint over its declared parcels', () => {
    it('the fixture really is inside its parcels, and touches one of them by a small area', () => {
        let union = null;
        fixture.parcels.forEach(parcel => { union = union ? turf.union(union, parcel) : parcel; });
        const outside = turf.difference(fixture.footprint, union);
        expect(outside ? turf.area(outside) : 0).toBeLessThan(0.001);
        const sliver = turf.area(turf.intersect(fixture.footprint, fixture.parcels.find(p => p.properties.parcelId === 'HR-339164-2626')));
        expect(sliver).toBeGreaterThan(0);
        expect(sliver).toBeLessThan(0.25);
    });

    // Was: the 0.09 m² touch was left out of the ancestors by a 0.25 m² floor. It is 27 cm wide,
    // real ground by the shared rule, so 2626 is an ancestor; the covered area counts it either way.
    it('counts the small touch in the covered area and, being real ground, among the ancestors', () => {
        const { hits, coveredArea } = planOrder.measureCoverage(fixture.footprint,
            fixture.parcels.map(feature => ({ id: feature.properties.parcelId, feature })));
        expect(hits.map(hit => hit.id)).toContain('HR-339164-2626');
        expect(turf.area(fixture.footprint) - coveredArea).toBeLessThan(0.01);
    });

    it('accepts the park the editor refused: the repository reads it as fully covered', async () => {
        const repository = await repositoryWithFixtureParcels();
        const coverage = repository.coverageOf(fixture.footprint, { ids: fixture.declared });
        expect(turf.area(fixture.footprint) * (1 - coverage.coverage)).toBeLessThan(0.01);
        expect(groundFailure(park(fixture.footprint.geometry), repository)).toBeNull();
    });

    it('still refuses the same park moved three metres south, past its parcels', async () => {
        const repository = await repositoryWithFixtureParcels();
        // About 6 m² of it now lies on ground no declared parcel holds.
        const moved = turf.transformTranslate(fixture.footprint, 3, 180, { units: 'meters' });
        let union = null;
        fixture.parcels.forEach(parcel => { union = union ? turf.union(union, parcel) : parcel; });
        const outside = turf.difference(moved, union);
        expect(outside ? turf.area(outside) : 0).toBeGreaterThan(0.5);
        expect(groundFailure(park(moved.geometry), repository)).toMatchObject({ code: 'proposal-footprint-outside-cadastre' });
    });
});
