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

let ancestry;
let repository;

beforeAll(() => {
    globalThis.turf = turf;
    globalThis.__planOrder = planOrder;
    ancestry = require('../../frontend/js/proposals/cadastre-ancestry.js');
});

beforeEach(async () => {
    repository = createCadastralParcelRepository({
        root: globalThis,
        convertFeatures: collection => collection
    });
    globalThis.CadastralParcelRepository = repository;
    await repository.acceptFeatures([A, B], { skipConversion: true });
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
        const oneParcelRepository = createCadastralParcelRepository({
            root: globalThis, convertFeatures: collection => collection
        });
        globalThis.CadastralParcelRepository = oneParcelRepository;
        return oneParcelRepository.acceptFeatures([A], { skipConversion: true }).then(() => {
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

describe('computeCadastreParcelIds', () => {
    it('preserves and validates the authored cadastral declaration', () => {
        const proposal = {
            cadastreParcelIds: ['HR-1-1'],
            structureProposal: { geometry: A.geometry }
        };
        expect(ancestry.computeCadastreParcelIds(proposal)).toEqual(['HR-1-1']);
    });

    it('refuses when retained cadastre covers less than 95% of the footprint', async () => {
        repository = createCadastralParcelRepository({ root: globalThis, convertFeatures: value => value });
        globalThis.CadastralParcelRepository = repository;
        await repository.acceptFeatures([A], { skipConversion: true });
        const proposal = {
            cadastreParcelIds: ['HR-1-1'],
            structureProposal: { geometry: square('footprint', 16.000, 46.000, 16.002, 46.001).geometry }
        };
        expect(() => ancestry.computeCadastreParcelIds(proposal)).toThrow(/cover only 50%/);
    });

    it('refuses records without authored geometry instead of trusting the declaration alone', () => {
        expect(() => ancestry.computeCadastreParcelIds({ cadastreParcelIds: ['HR-1-1'] }))
            .toThrow(/no usable authored footprint/);
    });

    it('refuses records without an explicit cadastral declaration instead of deriving one', () => {
        expect(() => ancestry.computeCadastreParcelIds({ structureProposal: { geometry: A.geometry } }))
            .toThrow(/no explicit cadastral parcel declaration/);
    });
});
