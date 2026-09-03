// What a plan yields: floor area, apartments, people, per epoch.
//
// Two things these tests exist to stop. First, an area formula that is subtly wrong — so the ring
// area is checked against turf on real Šibenik coordinates rather than against itself. Second, a
// missing measurement turning into a real-looking number: a building with no height must leave a
// hole in the totals, not contribute a confidently wrong floor area.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import * as turf from '@turf/turf';

const require = createRequire(import.meta.url);
const {
    DEFAULTS,
    geometryAreaM2,
    heightMetresOf,
    measureBuilding,
    buildingFeaturesOf,
    planYield,
    rederive,
    cadastreIdsOf,
    resultingParcels
} = require('../../frontend/js/proposals/plan-yield.js');

// A rectangle in lon/lat around Šibenik, closed. Small enough that the sphere is a good model and
// big enough that a formula error shows up in the first significant digits.
function rect(lon0, lat0, lon1, lat1) {
    return [[[lon0, lat0], [lon1, lat0], [lon1, lat1], [lon0, lat1], [lon0, lat0]]];
}

const polygon = (coordinates, properties = {}) => ({
    type: 'Feature',
    properties,
    geometry: { type: 'Polygon', coordinates }
});

const SIBENIK = rect(15.8850, 43.7350, 15.8870, 43.7365);

const blockRule = {
    kind: 'exact',
    typology: 'block',
    minHeightM: 17.5,
    maxHeightM: 17.5,
    floorHeightM: 3.5
};

/** A rule-driven building proposal, in the shape the server row has. */
function ruleProposal({ epoch = null, applied = true, heights = [17.5], rings = SIBENIK } = {}) {
    return {
        applied,
        epoch_year: epoch,
        building_proposal: {
            parameters: { rule: blockRule },
            buildings: heights.map(height => polygon(rings, {
                type: 'proposedBuilding',
                height,
                urbanRule: blockRule
            }))
        }
    };
}

describe('area is measured, not approximated', () => {
    it('agrees with turf on a real polygon', () => {
        const mine = geometryAreaM2(polygon(SIBENIK));
        const theirs = turf.area(polygon(SIBENIK));
        expect(theirs).toBeGreaterThan(1000);
        expect(Math.abs(mine - theirs) / theirs).toBeLessThan(1e-9);
    });

    it('subtracts a hole and sums a MultiPolygon', () => {
        const outer = rect(15.8850, 43.7350, 15.8870, 43.7365);
        const hole = rect(15.8855, 43.7354, 15.8860, 43.7358);
        const withHole = { type: 'Polygon', coordinates: [outer[0], hole[0]] };
        const solid = geometryAreaM2(polygon(outer));
        const holeArea = geometryAreaM2(polygon(hole));
        expect(geometryAreaM2(withHole)).toBeCloseTo(solid - holeArea, 3);

        const multi = {
            type: 'MultiPolygon',
            coordinates: [outer, rect(15.8880, 43.7350, 15.8890, 43.7360)]
        };
        expect(geometryAreaM2(multi)).toBeCloseTo(
            solid + geometryAreaM2(polygon(rect(15.8880, 43.7350, 15.8890, 43.7360))),
            3
        );
    });

    it('is 0 for a line or a missing geometry rather than throwing', () => {
        expect(geometryAreaM2(null)).toBe(0);
        expect(geometryAreaM2({ type: 'LineString', coordinates: [[15.88, 43.73], [15.89, 43.74]] })).toBe(0);
    });
});

describe('a building with no height stays unmeasured', () => {
    it('reports gfaM2 as null, not 0', () => {
        const measured = measureBuilding(polygon(SIBENIK, { type: 'proposedBuilding' }), null, DEFAULTS);
        expect(measured.footprintM2).toBeGreaterThan(0);
        expect(measured.heightM).toBeNull();
        expect(measured.floors).toBeNull();
        expect(measured.gfaM2).toBeNull();
    });

    it('never lets a null height become a storey', () => {
        expect(heightMetresOf(polygon(SIBENIK, { height: null }), null)).toBeNull();
        expect(heightMetresOf(polygon(SIBENIK, { height: 0 }), null)).toBeNull();
        expect(heightMetresOf(polygon(SIBENIK, { height: 'tall' }), null)).toBeNull();
    });

    it('keeps its footprint in the totals but leaves the floor area out, and says how many', () => {
        const result = planYield([{
            applied: true,
            building_proposal: { buildings: [polygon(SIBENIK, { type: 'proposedBuilding' })] }
        }]);
        expect(result.total.buildings).toBe(1);
        expect(result.total.unmeasuredBuildings).toBe(1);
        expect(result.total.footprintM2).toBeGreaterThan(0);
        expect(result.total.grossFloorAreaM2).toBe(0);
        expect(result.total.apartments).toBe(0);
    });
});

describe('height and storeys', () => {
    it('reads the built height first', () => {
        const measured = measureBuilding(polygon(SIBENIK, { height: 17.5, urbanRule: blockRule }), null, DEFAULTS);
        expect(measured.floors).toBe(5);
        expect(measured.gfaM2).toBeCloseTo(measured.footprintM2 * 5, 6);
    });

    it('takes the midpoint of a rule band when the building states nothing', () => {
        const band = { minHeightM: 10, maxHeightM: 20, floorHeightM: 3 };
        expect(heightMetresOf(polygon(SIBENIK, {}), band)).toBe(15);
    });

    it('derives a height from storeys when only those are given', () => {
        expect(heightMetresOf(polygon(SIBENIK, { floors: 4, floorHeightM: 3.2 }), null)).toBeCloseTo(12.8, 6);
    });

    it('falls back to the assumed storey height only when neither building nor rule says', () => {
        const freeform = measureBuilding(polygon(SIBENIK, { height: 19 }), null, { floorHeightM: 3 });
        expect(freeform.floorHeightM).toBe(3);
        expect(freeform.floors).toBe(6);
    });
});

describe('proposals arrive in both shapes', () => {
    it('reads the server row and the client object alike', () => {
        const feature = polygon(SIBENIK, { height: 17.5, urbanRule: blockRule });
        expect(buildingFeaturesOf({ building_proposal: { buildings: [feature] } })).toHaveLength(1);
        expect(buildingFeaturesOf({ buildingProposal: { buildings: [feature] } })).toHaveLength(1);
        // The older client shape wrapped each entry.
        expect(buildingFeaturesOf({ buildingProposal: { buildings: [{ feature }] } })).toHaveLength(1);
        expect(buildingFeaturesOf({ geometry: { buildings: [feature] } })).toHaveLength(1);
        expect(buildingFeaturesOf({})).toEqual([]);
    });

    it('reads the epoch from either casing', () => {
        const byRow = planYield([ruleProposal({ epoch: 2045 })]);
        expect(byRow.byEpoch.map(b => b.year)).toEqual([2045]);
        const client = { applied: true, epochYear: 2045, buildingProposal: { buildings: [] } };
        expect(planYield([client]).byEpoch.map(b => b.year)).toEqual([2045]);
    });
});

describe('the plan splits by period', () => {
    const plan = () => [
        ruleProposal({ epoch: 2035 }),
        ruleProposal({ epoch: 2035 }),
        ruleProposal({ epoch: 2045 }),
        ruleProposal({ epoch: null })
    ];

    it('reports what each period adds', () => {
        const result = planYield(plan());
        expect(result.byEpoch.map(b => b.year)).toEqual([2035, 2045]);
        expect(result.byEpoch[0].proposals).toBe(2);
        expect(result.byEpoch[1].proposals).toBe(1);
        expect(result.unassigned.proposals).toBe(1);
        expect(result.total.proposals).toBe(4);
    });

    it('carries proposals with no epoch into every cumulative year', () => {
        const result = planYield(plan());
        const [first, second] = result.cumulative;
        expect(first.year).toBe(2035);
        expect(first.proposals).toBe(3);     // two 2035 + the undated one
        expect(second.year).toBe(2045);
        expect(second.proposals).toBe(4);
        expect(second.grossFloorAreaM2).toBeCloseTo(result.total.grossFloorAreaM2, 6);
    });

    it('counts only applied proposals unless asked otherwise', () => {
        const list = [ruleProposal({ applied: true }), ruleProposal({ applied: false })];
        expect(planYield(list, { appliedOnly: true }).total.proposals).toBe(1);
        expect(planYield(list).total.proposals).toBe(2);
    });
});

describe('apartments and people follow from floor area', () => {
    it('applies the housing share, then the efficiency, then the apartment size', () => {
        const footprint = geometryAreaM2(polygon(SIBENIK));
        const result = planYield([ruleProposal({ heights: [17.5] })], {
            housingShare: 0.5,
            efficiency: 0.8,
            avgApartmentM2: 50,
            personsPerApartment: 2
        });
        const gfa = footprint * 5;
        expect(result.total.grossFloorAreaM2).toBeCloseTo(gfa, 6);
        expect(result.total.housingFloorAreaM2).toBeCloseTo(gfa * 0.5, 6);
        expect(result.total.housingNetM2).toBeCloseTo(gfa * 0.5 * 0.8, 6);
        expect(result.total.apartments).toBe(Math.floor((gfa * 0.5 * 0.8) / 50));
        expect(result.total.people).toBe(result.total.apartments * 2);
    });

    it('splits the remainder into workplace and jobs', () => {
        const result = planYield([ruleProposal()], { housingShare: 0.75, efficiency: 0.8, m2PerJob: 30 });
        expect(result.total.workFloorAreaM2).toBeCloseTo(result.total.grossFloorAreaM2 * 0.25, 6);
        expect(result.total.jobs).toBe(Math.floor(result.total.workNetM2 / 30));
    });

    it('does not invent people from an empty plan', () => {
        const empty = planYield([]);
        expect(empty.total.apartments).toBe(0);
        expect(empty.total.people).toBe(0);
        expect(empty.byEpoch).toEqual([]);
    });
});

describe('changing an assumption re-derives without re-measuring', () => {
    const plan = () => [
        ruleProposal({ epoch: 2035 }),
        ruleProposal({ epoch: 2045 }),
        ruleProposal({ epoch: null })
    ];
    const A = { housingShare: 0.75, efficiency: 0.8, avgApartmentM2: 65, personsPerApartment: 2.4, m2PerJob: 30 };
    const B = { housingShare: 0.5, efficiency: 0.7, avgApartmentM2: 90, personsPerApartment: 3, m2PerJob: 25 };

    it('lands on exactly what a full run under the new assumptions gives', () => {
        expect(rederive(planYield(plan(), A), B)).toEqual(planYield(plan(), B));
    });

    it('is reversible, so nothing is lost by re-deriving', () => {
        expect(rederive(rederive(planYield(plan(), A), B), A)).toEqual(planYield(plan(), A));
    });

    it('leaves the measured figures untouched', () => {
        const measured = planYield(plan(), A);
        const again = rederive(measured, B);
        expect(again.total.grossFloorAreaM2).toBe(measured.total.grossFloorAreaM2);
        expect(again.total.footprintM2).toBe(measured.total.footprintM2);
        expect(again.total.buildings).toBe(measured.total.buildings);
        // …and does move the derived ones, or it would not be doing anything.
        expect(again.total.apartments).not.toBe(measured.total.apartments);
    });
});

describe('the parcels a plan leaves standing', () => {
    // Proposal records say only that both proposals affect cadastre 101. A separate committed
    // fabric snapshot says which disposable live pieces currently stand there.
    const road = {
        applied: true,
        cadastreParcelIds: ['101'],
        roadProposal: { definition: { width: 8, points: [] } }
    };
    const rule = {
        applied: true,
        cadastreParcelIds: ['101'],
        buildingProposal: { parameters: { floors: 4 } }
    };
    const piece = (parcelId, producer = 'road-1') => ({
        type: 'Feature',
        properties: {
            parcelId,
            cadastreParcelIds: ['101'],
            ...(producer ? { producedByProposalId: producer } : {})
        },
        geometry: { type: 'Polygon', coordinates: [] }
    });
    const roadFabric = [piece('live-0'), piece('live-1'), piece('live-2')];

    it('uses an explicit fabric snapshot instead of child IDs stored on proposals', () => {
        const result = resultingParcels([road, rule], { materializedFeatures: roadFabric });
        expect(result.resulting.sort()).toEqual(['live-0', 'live-1', 'live-2']);
        expect(result.produced.sort()).toEqual(['live-0', 'live-1', 'live-2']);
        expect(result.materialized).toBe(true);
    });

    it('is independent of proposal order because the snapshot is authoritative', () => {
        const forwards = resultingParcels([road, rule], { materializedFeatures: roadFabric }).resulting.sort();
        const backwards = resultingParcels([rule, road], { materializedFeatures: roadFabric }).resulting.sort();
        expect(backwards).toEqual(forwards);
        expect(forwards).not.toContain('101');
    });

    it('does not reconstruct a chain when a later proposal changes the same cadastral ground', () => {
        const second = {
            applied: true,
            cadastreParcelIds: ['101'],
            roadProposal: { definition: { width: 6, points: [] } }
        };
        const finalFabric = [piece('final-a', 'road-2'), piece('final-b', 'road-2')];
        const { resulting } = resultingParcels([road, second], { materializedFeatures: finalFabric });
        expect(resulting.sort()).toEqual(['final-a', 'final-b']);
    });

    it('keeps original cadastral ground when a building only overlays it', () => {
        const original = piece('101', null);
        const { resulting, builtOn, produced } = resultingParcels([rule], { materializedFeatures: [original] });
        expect(resulting).toEqual(['101']);
        expect(builtOn).toEqual(['101']);
        expect(produced).toHaveLength(0);
    });

    it('reads only the canonical public proposal shape', () => {
        const row = { applied: true, cadastreParcelIds: ['A', 'B'] };
        expect(cadastreIdsOf(row)).toEqual(['A', 'B']);
        expect(cadastreIdsOf({ ancestor_parcel_ids: ['A'] })).toEqual([]);
        expect(resultingParcels([row]).resulting).toEqual(['A', 'B']);
    });

    it('honours appliedOnly', () => {
        const draft = { applied: false, cadastreParcelIds: ['999'], buildingProposal: {} };
        expect(resultingParcels([rule, draft], { appliedOnly: true }).resulting).not.toContain('999');
        expect(resultingParcels([rule, draft]).resulting).toContain('999');
    });

    it('is empty for an empty plan rather than throwing', () => {
        expect(resultingParcels([]).resulting).toEqual([]);
        expect(resultingParcels(null).resulting).toEqual([]);
        expect(cadastreIdsOf(null)).toEqual([]);
    });
});

describe('freeform structures', () => {
    it('counts a hand-drawn building as freeform, not rule-driven', () => {
        const freeform = {
            applied: true,
            building_proposal: { buildings: [polygon(SIBENIK, { type: 'proposedBuildingSingle', height: 19 })] }
        };
        const result = planYield([freeform, ruleProposal()]);
        expect(result.total.freeformProposals).toBe(1);
        expect(result.total.ruleProposals).toBe(1);
    });

    it('measures a park as open space, with no floor area', () => {
        const park = {
            applied: true,
            epoch_year: 2035,
            structure_proposal: { kind: 'park', geometry: { type: 'Polygon', coordinates: SIBENIK } }
        };
        const result = planYield([park]);
        expect(result.total.openSpaces).toBe(1);
        expect(result.total.openSpaceM2).toBeCloseTo(geometryAreaM2(polygon(SIBENIK)), 3);
        expect(result.total.grossFloorAreaM2).toBe(0);
        expect(result.byEpoch[0].openSpaceM2).toBeGreaterThan(0);
    });
});
