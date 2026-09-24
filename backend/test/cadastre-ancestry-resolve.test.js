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

describe('validateCadastreParcelIds', () => {
    it('preserves and validates the authored cadastral declaration', () => {
        const proposal = {
            cadastreParcelIds: ['HR-1-1'],
            structureProposal: { geometry: A.geometry }
        };
        expect(ancestry.validateCadastreParcelIds(proposal)).toEqual(['HR-1-1']);
    });

    it('refuses geometry that spills onto an undeclared parcel, naming the parcel', () => {
        const proposal = {
            cadastreParcelIds: ['HR-1-1'],
            structureProposal: { geometry: square('footprint', 16.000, 46.000, 16.0015, 46.001).geometry }
        };
        let error = null;
        try { ancestry.validateCadastreParcelIds(proposal); } catch (caught) { error = caught; }
        expect(error).not.toBeNull();
        expect(error.code).toBe('undeclared-parcels');
        expect(error.undeclaredParcelIds).toEqual(['HR-1-2']);
        expect(error.message).toMatch(/1 parcel\(s\) you did not select: HR-1-2/);
    });

    it('allows a declared parcel with no geometry on it (a whole-block selection)', () => {
        const proposal = {
            cadastreParcelIds: ['HR-1-1', 'HR-1-2'],
            structureProposal: { geometry: square('inner', 16.0002, 46.0002, 16.0008, 46.0008).geometry }
        };
        expect(ancestry.validateCadastreParcelIds(proposal)).toEqual(['HR-1-1', 'HR-1-2']);
    });

    it('ignores a boundary sliver under 1 m² and ground with no cadastral parcel at all', () => {
        // ~0.9 m² into HR-1-2 along the shared edge, and a strip south of both parcels (no cadastre).
        const sliver = square('sliver', 16.0003, 45.9999, 16.0010001, 46.001).geometry;
        const proposal = { cadastreParcelIds: ['HR-1-1'], structureProposal: { geometry: sliver } };
        expect(ancestry.validateCadastreParcelIds(proposal)).toEqual(['HR-1-1']);
    });

    it('publishes a corridor with every parcel it covers, and every other typology exactly as selected', () => {
        const spill = square('spill', 16.000, 46.000, 16.0015, 46.001).geometry;
        expect(ancestry.publishDeclaration({
            cadastreParcelIds: ['HR-1-1'],
            roadProposal: { definition: { polygon: spill } }
        })).toEqual(['HR-1-1', 'HR-1-2']);
        const park = { cadastreParcelIds: ['HR-1-1'], structureProposal: { geometry: spill } };
        expect(ancestry.publishDeclaration(park)).toEqual(['HR-1-1']);
        expect(() => ancestry.validateCadastreParcelIds({ ...park, cadastreParcelIds: ancestry.publishDeclaration(park) }))
            .toThrow(/HR-1-2/);
    });

    it('extends a declaration by the parcels its geometry covers, for tools that legitimately take them', () => {
        const proposal = {
            cadastreParcelIds: ['HR-1-1'],
            roadProposal: { definition: { polygon: square('road', 16.000, 46.000, 16.0015, 46.001).geometry } }
        };
        expect(ancestry.declarationCoveringFootprint(proposal)).toEqual(['HR-1-1', 'HR-1-2']);
        expect(ancestry.validateCadastreParcelIds({
            ...proposal,
            cadastreParcelIds: ancestry.declarationCoveringFootprint(proposal)
        })).toEqual(['HR-1-1', 'HR-1-2']);
    });

    it('refuses records without authored geometry instead of trusting the declaration alone', () => {
        expect(() => ancestry.validateCadastreParcelIds({ cadastreParcelIds: ['HR-1-1'] }))
            .toThrow(/no usable authored footprint/);
    });

    it('refuses records without an explicit cadastral declaration instead of deriving one', () => {
        expect(() => ancestry.validateCadastreParcelIds({ structureProposal: { geometry: A.geometry } }))
            .toThrow(/no explicit cadastral parcel declaration/);
    });
});
