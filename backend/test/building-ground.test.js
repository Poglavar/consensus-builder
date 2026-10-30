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

describe('surroundings within the land take', () => {
    it('removes the surface for a footprint-only take and keeps it for a whole parcel', () => {
        const surface = BuildingGround.buildSurface('green', BLOCK, [BUILDING]);
        expect(BuildingGround.clipSurfaceToLandTake(surface, BUILDING, turf)).toBeNull();
        const whole = BuildingGround.clipSurfaceToLandTake(surface, BLOCK, turf);
        expect(turf.area(turf.feature(whole.polygon))).toBeCloseTo(turf.area(BLOCK) - turf.area(BUILDING), 3);
    });
    it('clips a mixed take without moving its original boundary', () => {
        const surface = BuildingGround.buildSurface('paved', BLOCK, [BUILDING]);
        const take = square(15.9701, 45.8101, 0.0004);
        const clipped = BuildingGround.clipSurfaceToLandTake(surface, take, turf);
        expect(turf.difference(turf.feature(clipped.polygon), take)).toBeNull();
        expect(turf.intersect(turf.feature(clipped.polygon), BUILDING)).toBeNull();
        expect(surface.polygon).toEqual(BuildingGround.buildSurface('paved', BLOCK, [BUILDING]).polygon);
    });
});

describe('normalizeTreatment', () => {
    it('accepts the two real treatments', () => {
        expect(BuildingGround.normalizeTreatment('paved')).toBe('paved');
        expect(BuildingGround.normalizeTreatment('GREEN')).toBe('green');
    });

    it('defaults new authoring choices to paving', () => {
        expect(BuildingGround.normalizeTreatment(undefined)).toBe('paved');
        expect(BuildingGround.normalizeTreatment('none')).toBe('paved');
        expect(BuildingGround.normalizeTreatment('lawn')).toBe('paved');
        expect(BuildingGround.normalizeTreatment(null)).toBe('paved');
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
    it('retains an independent authored furniture layout through storage and rendering projections', () => {
        const design = { version: 3, trees: [{ coordinate: [15.9701, 45.8101], kind: 'conifer', heightM: 12 }] };
        const surface = BuildingGround.buildSurface('green', BLOCK, [BUILDING], design);
        const proposal = { proposalId: 'building', buildingProposal: {}, geometry: { surroundings: surface } };
        expect(BuildingGround.surfaceOf(proposal).decorationDesign).toEqual(design);
        expect(BuildingGround.appliedSurfaces([proposal], () => true)[0].decorationDesign).toEqual(design);
        surface.decorationDesign.trees[0].heightM = 18;
        expect(design.trees[0].heightM).toBe(12);
    });

    it('moves furniture records and path coordinates without changing their authored attributes', () => {
        const source = { version: 3, trees: [{ coordinate: [1, 2], kind: 'conifer', heightM: 12 }], paths: [[[1, 2], [2, 3]]] };
        const shift = points => typeof points[0] === 'number' ? [points[0] + 1, points[1] + 2] : points.map(shift);
        const moved = BuildingGround.moveDecorationDesign(source, null, null, shift);
        expect(moved.trees).toEqual([{ coordinate: [2, 4], kind: 'conifer', heightM: 12 }]);
        expect(moved.paths).toEqual([[[2, 4], [3, 5]]]);
        expect(source.trees[0].coordinate).toEqual([1, 2]);
        // A fenced area moves its ring and gates; one around the whole ground has no ring to move.
        const fenced = BuildingGround.moveDecorationDesign({ enclosures: [{ fence: 'mesh', use: 'play', gates: [[1, 2]], ring: [[1, 2], [2, 2], [2, 3], [1, 2]] },
            { fence: 'iron', use: 'none', gates: [[0, 0]] }], swings: [{ coordinate: [1, 1], bearing: 90 }] }, null, null, shift);
        expect(fenced.enclosures).toEqual([{ fence: 'mesh', use: 'play', gates: [[2, 4]], ring: [[2, 4], [3, 4], [3, 5], [2, 4]] }, { fence: 'iron', use: 'none', gates: [[1, 2]] }]);
        expect(fenced.swings).toEqual([{ coordinate: [2, 3], bearing: 90 }]);
    });
    it('builds a persisted surface for a real treatment', () => {
        const surface = BuildingGround.buildSurface('paved', BLOCK, [BUILDING]);
        expect(surface.treatment).toBe('paved');
        expect(surface.polygon.type).toBe('Polygon');
    });

    it('persists paving when no authoring choice is supplied', () => {
        expect(BuildingGround.buildSurface(undefined, BLOCK, [BUILDING]).treatment).toBe('paved');
        expect(BuildingGround.TREATMENTS).toEqual(['paved', 'green']);
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
        geometry: { surroundings: { treatment: 'paved', polygon: BLOCK.geometry } }
    };

    it('reads a persisted surface back', () => {
        expect(BuildingGround.surfaceOf(proposal).treatment).toBe('paved');
        expect(BuildingGround.treatmentOf(proposal)).toBe('paved');
    });

    it('does not invent geometry for a saved design that has no surface', () => {
        expect(BuildingGround.surfaceOf({ geometry: {} })).toBeNull();
        expect(BuildingGround.surfaceOf({})).toBeNull();
        expect(BuildingGround.treatmentOf({ geometry: {} })).toBe('paved');
    });

    it('rejects a surface with an unusable polygon', () => {
        expect(BuildingGround.surfaceOf({
            geometry: { surroundings: { treatment: 'paved', polygon: { type: 'Point', coordinates: [1, 2] } } }
        })).toBeNull();
        expect(BuildingGround.surfaceOf({
            geometry: { surroundings: { treatment: 'paved', polygon: null } }
        })).toBeNull();
    });

    it('rejects a surface whose treatment is not a real one', () => {
        expect(BuildingGround.surfaceOf({
            geometry: { surroundings: { treatment: 'none', polygon: BLOCK.geometry } }
        })).toBeNull();
    });
});

describe('appliedSurfaces', () => {
    const isApplied = (proposal, sub) => !!(sub && sub.applied);
    const paved = {
        proposalId: 'a',
        buildingProposal: { applied: true },
        geometry: { surroundings: { treatment: 'paved', polygon: BLOCK.geometry } }
    };
    const unapplied = {
        proposalId: 'b',
        buildingProposal: { applied: false },
        geometry: { surroundings: { treatment: 'green', polygon: BLOCK.geometry } }
    };
    const structure = {
        proposalId: 'c',
        structureProposal: { applied: true, kind: 'square' },
        geometry: { surroundings: { treatment: 'paved', polygon: BLOCK.geometry } }
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

    it.each(['green', 'paved'])('carves applied roads out of %s surrounds without changing authored designs', treatment => {
        const surface = { ...paved, geometry: { surroundings: { treatment, polygon: BLOCK.geometry } } };
        // A road completely crosses the surround, leaving two disconnected visible parts.
        const corridor = turf.bboxPolygon([15.9704, 45.8099, 15.9705, 45.811]);
        const road = { roadProposal: { applied: true, definition: { polygon: corridor.geometry } } };
        const before = JSON.stringify([surface, road]);
        const [visible] = BuildingGround.appliedSurfaces([surface, road], isApplied);
        expect(visible.geometry.type).toBe('MultiPolygon');
        expect(turf.intersect(turf.feature(visible.geometry), corridor)).toBeNull();
        expect(turf.area(turf.feature(visible.geometry))).toBeCloseTo(
            turf.area(BLOCK) - turf.area(turf.intersect(BLOCK, corridor)), 3);
        expect(JSON.stringify([surface, road])).toBe(before);
        road.roadProposal.applied = false;
        expect(BuildingGround.appliedSurfaces([surface, road], isApplied)[0].geometry).toEqual(BLOCK.geometry);
    });

    it('subtracts every applied corridor, retains furniture intent, and omits fully covered ground', () => {
        const decorationDesign = { trees: [{ coordinate: [15.97045, 45.8103], kind: 'conifer' }] };
        const surface = { ...paved, geometry: { surroundings: {
            treatment: 'green', polygon: BLOCK.geometry, decorationDesign
        } } };
        const road = geometry => ({ roadProposal: { applied: true, definition: { polygon: geometry } } });
        const west = turf.bboxPolygon([15.9699, 45.8099, 15.9705, 45.811]);
        const east = turf.bboxPolygon([15.9705, 45.8099, 15.971, 45.811]);
        const [visible] = BuildingGround.appliedSurfaces([surface, road(west.geometry)], isApplied);
        expect(visible.decorationDesign).toEqual(decorationDesign);
        expect(turf.intersect(turf.feature(visible.geometry), west)).toBeNull();
        expect(BuildingGround.appliedSurfaces([surface, road(west.geometry), road(east.geometry)], isApplied)).toEqual([]);
    });
});


describe('vacant layout plots', () => {
    const plot = (id, west) => ({ ...square(west, 45.81, 0.0002), properties: {
        parcelId: id, producedByProposalId: 'layout', readjustmentPiece: { role: 'plot' }
    } });
    const west = plot('west', 15.97), east = plot('east', 15.9702);
    const layout = { proposalId: 'layout', applied: true, parcelLayout: {} };
    const applied = proposal => proposal.applied === true;
    const vacant = (proposals = [layout], existing = [], features = [west, east]) =>
        BuildingGround.vacantPlots(features, proposals, applied, turf, existing).map(f => f.properties.parcelId);

    it('finds empty current plot outputs without changing their records', () => {
        const before = JSON.stringify([west, east, layout]);
        expect(vacant()).toEqual(['west', 'east']);
        expect(JSON.stringify([west, east, layout])).toBe(before);
    });
    it('excludes cadastral land, remainders and unapplied layouts', () => {
        expect(vacant([{ ...layout, applied: false }])).toEqual([]);
        expect(vacant([layout], [], [BLOCK, { ...west, properties: { ...west.properties, readjustmentPiece: { role: 'remainder' } } }])).toEqual([]);
    });
    it.each(['buildings', 'park', 'road', 'surroundings'])('excludes a plot occupied by %s, independently of visibility', kind => {
        const geometry = square(15.97004, 45.81004, 0.00008).geometry;
        const content = { proposalId: 'content', applied: true,
            ...(kind === 'buildings' ? { geometry: { buildings: [turf.feature(geometry)] } } : {}),
            ...(kind === 'park' ? { structureProposal: { geometry } } : {}),
            ...(kind === 'road' ? { roadProposal: { definition: { polygon: geometry } } } : {}),
            ...(kind === 'surroundings' ? { geometry: { surroundings: { polygon: geometry } } } : {})
        };
        expect(vacant([layout, content])).toEqual(['east']);
        expect(vacant([layout, { ...content, applied: false }])).toEqual(['west', 'east']);
    });
    it('keeps adjacent plots empty while excluding a standing building', () => {
        expect(vacant([layout], [west])).toEqual(['east']);
        expect(vacant([layout], [square(15.9698, 45.81, 0.0002)])).toEqual(['west', 'east']);
    });
});

describe('fenceLines', () => {
    // A ~100 m block of four quarter parcels with a 15 m perimeter building and a paved courtyard.
    const W = 15.97, S = 45.81, SIDE = 0.0009, HALF = SIDE / 2, WING = SIDE * 0.15;
    const quarter = (x, y) => square(W + x * HALF, S + y * HALF, HALF);
    const quarters = [quarter(0, 0), quarter(1, 0), quarter(0, 1), quarter(1, 1)];
    const inner = square(W + WING, S + WING, SIDE - 2 * WING);
    const ring = turf.polygon([BLOCK.geometry.coordinates[0], [...inner.geometry.coordinates[0]].reverse()]);
    const courtyard = turf.difference(BLOCK, ring);
    const metres = lines => lines.reduce((sum, line) => sum + turf.length(turf.lineString(line), { units: 'meters' }), 0);

    it('fences the private parcel boundaries across a paved or green courtyard', () => {
        const lines = BuildingGround.fenceLines(courtyard, quarters, [ring], turf);
        expect(lines.length).toBe(4);
        // The two dividing lines, each across the courtyard, never along the building's walls.
        const [west, south, east, north] = turf.bbox(inner);
        const across = turf.distance([west, south], [east, south], { units: 'meters' })
            + turf.distance([west, south], [west, north], { units: 'meters' });
        expect(metres(lines)).toBeCloseTo(across, 0);
    });

    it('leaves a courtyard laid out as its own parcel open, as shared ground', () => {
        const plots = quarters.map(parcel => turf.difference(parcel, inner));
        expect(BuildingGround.fenceLines(courtyard, [...plots, inner], [ring], turf)).toEqual([]);
    });

    it('fences a front yard along the parcel edge, the street side included, but not along the walls', () => {
        const house = square(W + SIDE * 0.3, S + SIDE * 0.3, SIDE * 0.4);
        const yard = turf.difference(BLOCK, house);
        const lines = BuildingGround.fenceLines(yard, [BLOCK], [house], turf);
        expect(lines.length).toBe(4);
        expect(metres(lines)).toBeCloseTo(turf.length(turf.polygonToLine(BLOCK), { units: 'meters' }), 0);
    });

    it('draws nothing without open ground', () => {
        expect(BuildingGround.fenceLines(null, quarters, [ring], turf)).toEqual([]);
    });
});
