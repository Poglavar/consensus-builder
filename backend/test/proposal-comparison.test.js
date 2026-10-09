// Shared-area quantities, incomplete evidence, composition conflicts and reproducible comparison snapshots.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const turf = require('@turf/turf');
const engine = require('../../frontend/js/proposals/proposal-comparison.js');
const yieldApi = require('../../frontend/js/proposals/plan-yield.js');
const codec = require('../../frontend/js/proposals/comparison-snapshot.js');
const point = (x, y) => [15.97 + x / 78000, 45.8 + y / 111000];
const rect = (x, y, w, h) => ({ type: 'Polygon', coordinates: [[point(x, y), point(x + w, y), point(x + w, y + h), point(x, y + h), point(x, y)]] });
const feature = (geometry, properties = {}) => ({ type: 'Feature', properties, geometry });
const site = rect(0, 0, 100, 100);
const area = geometry => yieldApi.geometryAreaM2(geometry);
const building = (id, geometry = rect(10, 10, 20, 20), height = 12) => ({ proposalId: id, title: id, city: 'zagreb', site,
    goal: 'buildings', buildingProposal: { buildings: [feature(geometry, height === null ? {} : { height })] } });
const park = (id, geometry = site) => ({ proposalId: id, goal: 'park', structureProposal: { kind: 'park', geometry } });
const input = (a, b, rest = {}) => ({ alternatives: [{ name: 'A', proposals: a }, { name: 'B', proposals: b }], ...rest });
const compare = (a, b, rest) => engine.compare(input(a, b, rest), { turf });
const codes = alternative => alternative.issues.map(issue => issue.code);

describe('proposal comparison on a common study area', () => {
    it('uses the same denominator and yield formula for different heights, without changing input', () => {
        const data = input([building('four')], [building('eight', undefined, 24)]);
        const before = JSON.stringify(data);
        const result = engine.compare(data, { turf });
        const [a, b] = result.alternatives.map(a => a.metrics);
        expect(JSON.stringify(data)).toBe(before);
        expect(result.scope.areaM2).toBeCloseTo(area(site), 5);
        expect(b.grossFloorAreaM2).toBeCloseTo(a.grossFloorAreaM2 * 2, 5);
        expect(b.floorAreaRatio).toBeCloseTo(b.grossFloorAreaM2 / area(site), 8);
        const expected = yieldApi.planYield(data.alternatives[1].proposals).total;
        expect(b.housingUnits).toBe(expected.apartments);
        expect(b.people).toBe(expected.people);
        expect(b.jobs).toBe(expected.jobs);
        expect(result.deltas.grossFloorAreaM2).toBeCloseTo(a.grossFloorAreaM2, 5);
    });

    it('unions sites shared by group members instead of summing their parcel areas', () => {
        const result = compare([building('west'), building('east', rect(60, 10, 20, 20))], [park('green')]);
        expect(result.alternatives[0].metrics.siteAreaM2).toBeCloseTo(area(site), 5);
        expect(result.alternatives[0].metrics.buildingCount).toBe(2);
        expect(result.alternatives[0].metrics.grossFloorAreaM2).toBeGreaterThan(0);
        expect(result.alternatives[1].metrics.parkAreaM2).toBeCloseTo(area(site), 5);
        expect(result.alternatives[0].issues).toEqual([]);
    });

    it('clips both alternatives to an explicit scope, including a partially included building', () => {
        const half = rect(0, 0, 20, 100);
        const result = compare([building('a')], [building('b', rect(60, 10, 20, 20))], { scope: { geometry: half, source: 'fixed' } });
        expect(result.alternatives[0].metrics.buildingFootprintM2).toBeCloseTo(area(rect(10, 10, 10, 20)), 4);
        expect(result.alternatives[0].metrics.grossFloorAreaM2).toBeCloseTo(area(rect(10, 10, 10, 20)) * 4, 4);
        expect(result.alternatives[1].metrics.buildingCount).toBe(0);
        expect(result.scope.areaM2).toBeCloseTo(area(half), 5);
        expect(codes(result.alternatives[0])).toContain('design-clipped');
    });

    it('keeps floor area and housing unknown if even one building has no usable height', () => {
        const result = compare([building('known'), building('unknown', rect(60, 10, 20, 20), null)], [building('other')]);
        const a = result.alternatives[0];
        expect(a.metrics.buildingCount).toBe(2);
        expect(a.metrics.buildingFootprintM2).toBeGreaterThan(0);
        expect(a.metrics.grossFloorAreaM2).toBeNull();
        expect(a.metrics.housingUnits).toBeNull();
        expect(result.deltas.housingUnits).toBeNull();
        expect(codes(a)).toContain('missing-height');
    });

    it('does not silently drop a missing building from an otherwise measurable proposal', () => {
        const proposal = building('partial');
        proposal.buildingProposal.buildings.push(feature(null));
        const a = compare([proposal], [park('green')]).alternatives[0];
        expect(a.metrics.buildingCount).toBeNull();
        expect(a.metrics.grossFloorAreaM2).toBeNull();
        expect(codes(a)).toContain('missing-buildings');
    });

    it('treats overlapping building alternatives as unresolved rather than adding their yield', () => {
        const a = compare([building('one'), building('two')], [park('green')]).alternatives[0];
        expect(a.metrics.grossFloorAreaM2).toBeNull();
        expect(a.metrics.buildingCount).toBeNull();
        expect(codes(a)).toContain('overlapping-designs');
        expect(a.features.features.filter(f => f.properties.kind === 'building')).toHaveLength(2);
    });

    it('counts overlapping road ribbons once but flags a park crossed by a road', () => {
        const road = { proposalId: 'road', roadProposal: { definition: { polygon: rect(0, 0, 100, 10) } } };
        const road2 = { proposalId: 'road2', roadProposal: { definition: { polygon: rect(0, 0, 10, 100) } } };
        const roadArea = area(site) * 0.19;
        const result = compare([road, road2], [park('green'), road]);
        expect(result.alternatives[0].metrics.roadAreaM2).toBeCloseTo(roadArea, -1);
        expect(result.alternatives[1].metrics.parkAreaM2).toBeNull();
        expect(result.alternatives[1].metrics.roadAreaM2).toBeNull();
        expect(codes(result.alternatives[1])).toContain('overlapping-designs');
    });

    it('uses replacement-family semantics even for disjoint siblings, except a land fork', () => {
        const a = building('a'); a.sourceProposalId = 'original';
        const b = building('b', rect(60, 10, 20, 20)); b.sourceProposalId = 'original';
        expect(codes(compare([a, b], [park('green')]).alternatives[0])).toContain('replacement-conflict');
        b.landFork = { changedLand: true };
        expect(compare([a, b], [park('green')]).alternatives[0].metrics.buildingCount).toBe(2);
    });

    it('gets parcel-act sites from pinned immutable cadastral geometry, stripping unrelated parcels', () => {
        const a = { proposalId: 'as-is', goal: 'as-is', cadastreParcelIds: ['base'] };
        const context = { parcels: [{ id: 'base', feature: feature(site) }, { id: 'unrelated', feature: feature(rect(1000, 0, 20, 20)) }] };
        const result = compare([a], [park('green')], { context });
        expect(result.alternatives[0].metrics.siteAreaM2).toBeCloseTo(area(site), 5);
        expect(result.alternatives[0].sources[0].site).toBe('cadastre');
        expect(engine.captureInput(input([a], [], { context })).context.parcels).toHaveLength(1);
    });

    it('does not pretend missing geometry is zero or complete, even after snapshot recalculation', () => {
        const result = compare([{ proposalId: 'lost', goal: 'park' }], [park('known')]);
        expect(result.scope.complete).toBe(false);
        expect(result.scope.areaM2).toBeNull();
        expect(result.alternatives[0].metrics.parkAreaM2).toBeNull();
        expect(result.alternatives[1].metrics.floorAreaRatio).toBeNull();
        const pinned = engine.captureInput(input([{ proposalId: 'lost', goal: 'park' }], [park('known')], { scope: result.scope }));
        expect(engine.compare(pinned, { turf }).scope.complete).toBe(false);
    });

    it('a failed geometric operation cannot turn into a zero quantity or a partial union', () => {
        const broken = { ...turf, union() { throw new Error('geometry engine failure'); } };
        const result = engine.compare(input([park('one', rect(0, 0, 20, 20))], [park('two', rect(30, 0, 20, 20))]), { turf: broken });
        expect(result.scope.areaM2).toBeNull();
        expect(result.alternatives[0].metrics.parkAreaM2).toBeNull();
        expect(result.deltas.parkAreaM2).toBeNull();
    });

    it('retains centerline roads and explicitly labels the width-based corridor estimate', () => {
        const road = { proposalId: 'centerline', roadProposal: { definition: { points: [point(0, 50), point(100, 50)], width: 6 } } };
        const captured = engine.captureInput(input([road], [park('green')]));
        expect(captured.alternatives[0].proposals[0].roadProposal.definition.points).toHaveLength(2);
        const a = engine.compare(captured, { turf }).alternatives[0];
        expect(a.metrics.roadAreaM2).toBeGreaterThan(590);
        expect(a.metrics.roadAreaM2).toBeLessThan(650);
        expect(codes(a)).toContain('approximate-corridor');
        expect(a.features.features.some(f => f.properties.kind === 'road')).toBe(true);
    });

    it('includes persisted green and paved building surrounds without calling them missing park geometry', () => {
        const a = building('green'); const b = building('paved');
        const surround = turf.difference(feature(site), a.buildingProposal.buildings[0]).geometry;
        a.geometry = { groundSurface: { treatment: 'green', polygon: surround } };
        b.geometry = { groundSurface: { treatment: 'paved', polygon: surround } };
        const result = compare([a], [b]);
        expect(result.alternatives[0].metrics.parkAreaM2).toBeCloseTo(area(surround), 4);
        expect(result.alternatives[1].metrics.squareAreaM2).toBeCloseTo(area(surround), 4);
        expect(result.alternatives[0].metrics.grossFloorAreaM2).toBeGreaterThan(0);
        expect(result.alternatives[0].issues).toEqual([]);
    });

    it('rejects duplicate selections, mixed cities and invalid shared assumptions', () => {
        const a = building('a');
        expect(() => compare([a, a], [])).toThrow(/twice/);
        expect(() => compare([a], [{ ...building('b'), city: 'split' }])).toThrow(/same city/);
        expect(() => compare([a], [], { assumptions: { housingShare: 75 } })).toThrow(/assumption/);
        expect(() => compare([a], [], { assumptions: { floorHeightM: 0 } })).toThrow(/assumption/);
    });

    it('pins only measurement data, and round-trips reproducible results without live storage', () => {
        const a = building('a');
        a.owner = 'private owner'; a.finance = { price: 99 }; a.applied = true;
        a.buildingProposal.demolitions = ['existing-stock'];
        a.buildingProposal.buildings[0].properties.ownerName = 'hidden';
        const data = engine.captureInput(input([a], [park('green')]));
        const text = JSON.stringify(data);
        expect(text).not.toMatch(/private owner|price|applied|demolitions|ownerName|hidden/);
        const result = engine.compare(data, { turf });
        const snapshot = codec.create({ ...data, scope: result.scope }, result);
        a.buildingProposal.buildings[0].properties.height = 99;
        const loaded = codec.fromHash(codec.toHash(snapshot));
        expect(engine.compare(loaded.input, { turf })).toEqual(result);
    });
});
