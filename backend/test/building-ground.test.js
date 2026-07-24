// Unit tests for frontend/js/building-ground.js — the paved/green surround of a freeform building
// proposal. turf is set on the global in THIS realm (not a vm context) so turf's internal
// instanceof checks work across the boundary.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import * as turf from '@turf/turf';

globalThis.turf = turf;

const require = createRequire(import.meta.url);
const BuildingGround = require('../../frontend/js/building-ground.js');

// ~0.0009° ≈ 100 m around Zagreb.
function square(west, south, side) {
    return turf.polygon([[
        [west, south], [west + side, south], [west + side, south + side], [west, south + side], [west, south]
    ]]);
}

const BLOCK = square(15.97, 45.81, 0.0009);          // ~100 x 100 m parcel block
const BUILDING = square(15.9702, 45.8102, 0.0002);   // ~22 x 22 m building inside it

describe('normalizeTreatment', () => {
    it('accepts the two real treatments', () => {
        expect(BuildingGround.normalizeTreatment('paved')).toBe('paved');
        expect(BuildingGround.normalizeTreatment('GREEN')).toBe('green');
    });

    it('falls back to none for anything else', () => {
        expect(BuildingGround.normalizeTreatment(undefined)).toBe('none');
        expect(BuildingGround.normalizeTreatment('none')).toBe('none');
        expect(BuildingGround.normalizeTreatment('lawn')).toBe('none');
        expect(BuildingGround.normalizeTreatment(null)).toBe('none');
    });
});

describe('computeSurfacePolygon', () => {
    it('returns the block minus the building footprints', () => {
        const polygon = BuildingGround.computeSurfacePolygon(BLOCK, [BUILDING]);
        expect(polygon).toBeTruthy();
        const blockArea = turf.area(BLOCK);
        const buildingArea = turf.area(BUILDING);
        const surfaceArea = turf.area({ type: 'Feature', properties: {}, geometry: polygon });
        expect(surfaceArea).toBeCloseTo(blockArea - buildingArea, 0);
    });

    it('cuts every building, not just the first', () => {
        const second = square(15.9705, 45.8105, 0.0002);
        const polygon = BuildingGround.computeSurfacePolygon(BLOCK, [BUILDING, second]);
        const surfaceArea = turf.area({ type: 'Feature', properties: {}, geometry: polygon });
        expect(surfaceArea).toBeCloseTo(turf.area(BLOCK) - turf.area(BUILDING) - turf.area(second), 0);
    });

    it('accepts bare geometries as well as features', () => {
        const polygon = BuildingGround.computeSurfacePolygon(BLOCK.geometry, [BUILDING.geometry]);
        expect(polygon).toBeTruthy();
        expect(polygon.type).toBe('Polygon');
    });

    it('returns null when the buildings cover the whole block', () => {
        expect(BuildingGround.computeSurfacePolygon(BLOCK, [BLOCK])).toBeNull();
    });

    it('returns null when only a sliver is left over', () => {
        // A building 1 mm short of the block leaves far less than the 2 m² floor.
        const almostAll = square(15.97, 45.81, 0.0008999);
        expect(BuildingGround.computeSurfacePolygon(BLOCK, [almostAll])).toBeNull();
    });

    it('returns null without a usable block', () => {
        expect(BuildingGround.computeSurfacePolygon(null, [BUILDING])).toBeNull();
        expect(BuildingGround.computeSurfacePolygon(turf.point([15.97, 45.81]), [BUILDING])).toBeNull();
    });

    it('ignores unusable building entries instead of dropping the surface', () => {
        const polygon = BuildingGround.computeSurfacePolygon(BLOCK, [null, turf.point([15.97, 45.81]), BUILDING]);
        const surfaceArea = turf.area({ type: 'Feature', properties: {}, geometry: polygon });
        expect(surfaceArea).toBeCloseTo(turf.area(BLOCK) - turf.area(BUILDING), 0);
    });
});

describe('buildSurface', () => {
    it('builds a persisted surface for a real treatment', () => {
        const surface = BuildingGround.buildSurface('paved', BLOCK, [BUILDING]);
        expect(surface.treatment).toBe('paved');
        expect(surface.polygon.type).toBe('Polygon');
    });

    it('builds nothing when the surroundings are left unchanged', () => {
        expect(BuildingGround.buildSurface('none', BLOCK, [BUILDING])).toBeNull();
        expect(BuildingGround.buildSurface(undefined, BLOCK, [BUILDING])).toBeNull();
    });

    it('does not alias the source geometry', () => {
        const surface = BuildingGround.buildSurface('green', BLOCK, [BUILDING]);
        surface.polygon.coordinates[0][0][0] = 0;
        expect(BLOCK.geometry.coordinates[0][0][0]).toBe(15.97);
    });
});

describe('surfaceOf / treatmentOf', () => {
    const proposal = {
        proposalId: 'p1',
        buildingProposal: {},
        geometry: { groundSurface: { treatment: 'paved', polygon: BLOCK.geometry } }
    };

    it('reads a persisted surface back', () => {
        expect(BuildingGround.surfaceOf(proposal).treatment).toBe('paved');
        expect(BuildingGround.treatmentOf(proposal)).toBe('paved');
    });

    it('treats a proposal without a surface as unchanged', () => {
        expect(BuildingGround.surfaceOf({ geometry: {} })).toBeNull();
        expect(BuildingGround.surfaceOf({})).toBeNull();
        expect(BuildingGround.treatmentOf({ geometry: {} })).toBe('none');
    });

    it('rejects a surface with an unusable polygon', () => {
        expect(BuildingGround.surfaceOf({
            geometry: { groundSurface: { treatment: 'paved', polygon: { type: 'Point', coordinates: [1, 2] } } }
        })).toBeNull();
        expect(BuildingGround.surfaceOf({
            geometry: { groundSurface: { treatment: 'paved', polygon: null } }
        })).toBeNull();
    });

    it('rejects a surface whose treatment is not a real one', () => {
        expect(BuildingGround.surfaceOf({
            geometry: { groundSurface: { treatment: 'none', polygon: BLOCK.geometry } }
        })).toBeNull();
    });
});

describe('appliedSurfaces', () => {
    const isApplied = (proposal, sub) => !!(sub && sub.applied);
    const paved = {
        proposalId: 'a',
        buildingProposal: { applied: true },
        geometry: { groundSurface: { treatment: 'paved', polygon: BLOCK.geometry } }
    };
    const unapplied = {
        proposalId: 'b',
        buildingProposal: { applied: false },
        geometry: { groundSurface: { treatment: 'green', polygon: BLOCK.geometry } }
    };
    const structure = {
        proposalId: 'c',
        structureProposal: { applied: true, kind: 'square' },
        geometry: { groundSurface: { treatment: 'paved', polygon: BLOCK.geometry } }
    };

    it('returns only applied building proposals that have a surface', () => {
        const surfaces = BuildingGround.appliedSurfaces([paved, unapplied, structure, {}], isApplied);
        expect(surfaces).toHaveLength(1);
        expect(surfaces[0]).toMatchObject({ proposalId: 'a', treatment: 'paved' });
        expect(surfaces[0].geometry.type).toBe('Polygon');
    });

    it('survives an applied predicate that throws', () => {
        const surfaces = BuildingGround.appliedSurfaces([paved], () => { throw new Error('boom'); });
        expect(surfaces).toEqual([]);
    });

    it('returns nothing without a usable input', () => {
        expect(BuildingGround.appliedSurfaces(null, isApplied)).toEqual([]);
        expect(BuildingGround.appliedSurfaces([paved], null)).toEqual([]);
    });
});
