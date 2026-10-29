// Publish-time cadastral discovery is computed from immutable repository facts. Runtime formation
// selection belongs to LiveParcelFabric and is deliberately not exposed as an ancestry fallback.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const turf = require('@turf/turf');
const planOrder = require('../../frontend/js/proposals/plan-order.js');
const { createCadastralParcelRepository } = require('../../frontend/js/parcels/ground-service.js');

const square = (id, w, s, e, n, properties = {}) => ({
    type: 'Feature',
    properties: { parcelId: id, ...properties },
    geometry: turf.polygon([[[w, s], [e, s], [e, n], [w, n], [w, s]]]).geometry
});

const A = square('HR-1-1', 16.000, 46.000, 16.001, 46.001);
const B = square('HR-1-2', 16.001, 46.000, 16.002, 46.001);

function repositoryWith(features) {
    const byId = new Map(features.map(feature => [feature.properties.parcelId, feature]));
    return createCadastralParcelRepository({
        root: globalThis,
        convertFeatures: collection => collection,
        transport: {
            fetchByIds: async ids => ({
                status: 'ready',
                complete: true,
                returnsWGS84: true,
                features: ids.map(id => byId.get(id)).filter(Boolean),
                absentIds: ids.filter(id => !byId.has(id))
            })
        }
    });
}

let ancestry;
let repository;

beforeAll(() => {
    globalThis.turf = turf;
    globalThis.__planOrder = planOrder;
    ancestry = require('../../frontend/js/proposals/cadastre-ancestry.js');
});

beforeEach(async () => {
    repository = repositoryWith([A, B]);
    globalThis.CadastralParcelRepository = repository;
    await repository.ensureIds(['HR-1-1', 'HR-1-2']);
});

describe('authoritative cadastral enumeration', () => {
    it('reads immutable source parcels from the repository', () => {
        expect(ancestry.loadedCadastreParcels().map(item => item.id).sort())
            .toEqual(['HR-1-1', 'HR-1-2']);
    });
});

describe('loaded cadastral coverage', () => {
    it('counts retained source ground independently of any live materialization', () => {
        const result = ancestry.loadedCadastreCoverage({ structureProposal: { geometry: A.geometry } });

        expect(result.ids).toEqual(['HR-1-1']);
        expect(result.coverage).toBeGreaterThan(0.999);
    });

    it('can prove coverage using only an immutable declared scope', () => {
        const footprint = square('footprint', 16.000, 46.000, 16.002, 46.001);
        const result = repository.coverageOf(footprint, { ids: ['HR-1-1'] });

        expect(result.ids).toEqual(['HR-1-1']);
        expect(result.coverage).toBeGreaterThan(0.45);
        expect(result.coverage).toBeLessThan(0.55);
    });

    it('reports actual retained coverage rather than trusting declared ids', () => {
        const footprint = square('footprint', 16.000, 46.000, 16.002, 46.001);
        const oneParcelRepository = repositoryWith([A]);
        globalThis.CadastralParcelRepository = oneParcelRepository;
        return oneParcelRepository.ensureIds(['HR-1-1']).then(() => {
            const result = ancestry.loadedCadastreCoverage({
                cadastreParcelIds: ['HR-1-1', 'HR-not-loaded'],
                structureProposal: { geometry: footprint.geometry }
            });
            expect(result.ids).toEqual(['HR-1-1']);
            expect(result.coverage).toBeGreaterThan(0.45);
            expect(result.coverage).toBeLessThan(0.55);
        });
    });
});

describe('the parcels a footprint lies on', () => {
    it('counts any reach wider than the 1 mm noise, and no debris or ground without cadastre', () => {
        // Was (validateCadastreParcelIds, removed as unused): a ~0.9 m² sliver (7.7 mm wide) into
        // HR-1-2 was ignored under a 1 m² floor. It is wider than the noise, so HR-1-2 is under it now.
        const reach = square('reach', 16.0003, 45.9999, 16.0010001, 46.001);
        expect(ancestry.undeclaredParcelsUnder(reach, ['HR-1-1']).map(hit => hit.id)).toEqual(['HR-1-2']);
        // ~0.4 mm into HR-1-2 is cutting debris; the strip south of both parcels has no cadastre.
        const debris = square('debris', 16.0003, 45.9999, 16.001000005, 46.001);
        expect(ancestry.undeclaredParcelsUnder(debris, ['HR-1-1'])).toEqual([]);
        // A record's own toleranceM widens the rule, as binding does.
        expect(ancestry.declarationCoveringFootprint({
            cadastreParcelIds: ['HR-1-1'], toleranceM: 0.05, roadProposal: { definition: { polygon: reach.geometry } }
        })).toEqual(['HR-1-1']);
    });

    it('publishes a corridor with every parcel it covers, and every other typology exactly as selected', () => {
        const spill = square('spill', 16.000, 46.000, 16.0015, 46.001).geometry;
        expect(ancestry.publishDeclaration({
            cadastreParcelIds: ['HR-1-1'],
            roadProposal: { definition: { polygon: spill } }
        })).toEqual(['HR-1-1', 'HR-1-2']);
        const park = { cadastreParcelIds: ['HR-1-1'], structureProposal: { geometry: spill } };
        expect(ancestry.publishDeclaration(park)).toEqual(['HR-1-1']);
    });

    it('extends a declaration by the parcels its geometry covers, for tools that legitimately take them', () => {
        const proposal = {
            cadastreParcelIds: ['HR-1-1'],
            roadProposal: { definition: { polygon: square('road', 16.000, 46.000, 16.0015, 46.001).geometry } }
        };
        expect(ancestry.declarationCoveringFootprint(proposal)).toEqual(['HR-1-1', 'HR-1-2']);
    });
});
