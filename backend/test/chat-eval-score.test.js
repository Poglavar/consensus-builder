import { describe, expect, it } from 'vitest';
import { scoreTurn } from '../chat/eval-score.js';

describe('chat eval scoring', () => {
    it('scores tool use, outcome, plan changes, and dotted argument assertions', () => {
        expect(scoreTurn({ tools: ['ugt_draft_space'], outcome: 'reply', planChanged: true, args: { ugt_draft_space: { 'input.treeCount': 12 } } }, { outcome: { type: 'reply' }, planChanged: true }, [{ tool: 'ugt_draft_space', args: { input: { treeCount: 12 } } }])).toMatchObject({ passed: true });
    });
    it('requires explicitly preserved fields to exist and remain exact', () => {
        const before = { designs: [{ design: { site: { type: 'Polygon', coordinates: [] } } }] };
        const expected = { artifact: { unchangedPaths: ['site'] } };
        expect(scoreTurn(expected, {}, [], { before, after: before })).toMatchObject({ passed: true });
        expect(scoreTurn(expected, {}, [], { before, after: { designs: [{ design: { site: null } }] } })).toMatchObject({ passed: false, reason: 'artifact-preserved-path-changed' });
        expect(scoreTurn({ artifact: { unchangedPaths: ['missing'] } }, {}, [], { before, after: before })).toMatchObject({ passed: false, reason: 'artifact-unchanged-path-missing' });
    });
    it('reports missing, forbidden, and mismatched expectations', () => {
        expect(scoreTurn({ tools: ['ugt_find_place'] }, {}, [])).toMatchObject({ passed: false, reason: 'missing-tool' });
        expect(scoreTurn({ forbidTools: ['ugt_publish_design'] }, {}, [{ tool: 'ugt_publish_design' }])).toMatchObject({ passed: false, reason: 'forbidden-tool-used' });
        expect(scoreTurn({ outcome: 'question' }, { outcome: { type: 'reply' } }, [])).toMatchObject({ passed: false, reason: 'outcome-mismatch' });
    });

    it('accepts alternative public edit tools while scoring canonical artifact readback', () => {
        const site = y => ({ type: 'Polygon', coordinates: [[[0, y], [0.001, y], [0.001, y + 0.001], [0, y + 0.001], [0, y]]] });
        const building = y => ({ type: 'Feature', properties: { type: 'proposedBuildingSingle', floors: 4, rotation: 90 }, geometry: site(y) });
        const beforeDesign = { schema: 'design/v1', goal: 'single', site: site(0), geometry: { buildings: [building(0)] }, structureProposal: null };
        const afterDesign = { ...beforeDesign, site: site(15 / 111320), geometry: { buildings: [building(15 / 111320)] } };
        const before = { cid: 'plan-before', designs: [{ cid: 'design-before', designHash: 'hash-before', design: beforeDesign }] };
        const after = { cid: 'plan-after', designs: [{ cid: 'design-after', designHash: 'hash-after', design: afterDesign }] };
        const readback = { before, after, previous: structuredClone(before) };
        const expected = { anyTools: ['ugt_modify_design', 'ugt_edit_plan'], artifact: {
            designIndex: 0, paths: { goal: 'single' }, changedPaths: ['site', 'geometry.buildings.0'], building: { index: 0, floors: 4, rotation: 90 },
            moved: { paths: ['site', 'geometry.buildings.0'], eastM: 0, northM: 15, toleranceM: 0.5 }, previousUnchanged: true
        }};
        expect(readback.previous.designs[0].designHash).toBe('hash-before');
        expect(scoreTurn(expected, { outcome: { type: 'reply' }, planChanged: true }, [{ tool: 'ugt_edit_plan' }], readback)).toMatchObject({ passed: true, artifact: { passed: true, designIndex: 0 } });
        expect(scoreTurn(expected, { outcome: { type: 'reply' }, planChanged: true }, [{ tool: 'ugt_inspect_design' }], readback)).toMatchObject({ passed: false, reason: 'missing-tool' });
    });

    it('selects a uniquely named design goal independently in before and after plan ordering', () => {
        const road = { schema: 'design/v1', goal: 'road-track', title: 'Rail' };
        const stationBefore = { schema: 'design/v1', goal: 'station', structureProposal: { platformHeightM: 2 } };
        const stationAfter = { schema: 'design/v1', goal: 'station', structureProposal: { platformHeightM: 3 } };
        const before = { cid: 'before', designs: [
            { cid: 'road', designHash: 'road-hash', design: road },
            { cid: 'station-before', designHash: 'station-before-hash', design: stationBefore }
        ] };
        const after = { cid: 'after', designs: [
            { cid: 'station-after', designHash: 'station-after-hash', design: stationAfter },
            { cid: 'road', designHash: 'road-hash', design: road }
        ] };
        const artifact = { designGoal: 'station', paths: { 'structureProposal.platformHeightM': 3 },
            changedPaths: ['structureProposal.platformHeightM'], previousUnchanged: true };
        expect(scoreTurn({ artifact }, {}, [], { before, after, previous: structuredClone(before) }))
            .toMatchObject({ passed: true, artifact: { passed: true, designCid: 'station-after', designIndex: 0 } });
        const ambiguous = { cid: 'ambiguous', designs: [after.designs[0], { ...after.designs[0], cid: 'station-other' }] };
        expect(scoreTurn({ artifact }, {}, [], { before, after: ambiguous, previous: before }))
            .toMatchObject({ passed: false, reason: 'artifact-design-goal-ambiguous' });
        expect(scoreTurn({ artifact }, {}, [], { before, after: { cid: 'missing', designs: [after.designs[1]] }, previous: before }))
            .toMatchObject({ passed: false, reason: 'artifact-design-goal-missing' });
    });

    it('scores goal-based creation when the prior plan has no such design but still requires a prior target for moves', () => {
        const track = { schema: 'design/v1', goal: 'road-track' };
        const station = { schema: 'design/v1', goal: 'station', structureProposal: { platformHeightM: 3 } };
        const before = { cid: 'track-plan', designs: [{ cid: 'track', designHash: 'track-hash', design: track }] };
        const after = { cid: 'station-plan', designs: [
            { cid: 'station', designHash: 'station-hash', design: station },
            { cid: 'track', designHash: 'track-hash', design: track }
        ] };
        expect(scoreTurn({ artifact: { designGoal: 'station', paths: { 'structureProposal.platformHeightM': 3 }, previousUnchanged: true } }, {}, [],
            { before, after, previous: structuredClone(before) })).toMatchObject({ passed: true });
        expect(scoreTurn({ artifact: { designGoal: 'station', moved: { paths: ['site'], eastM: 2, northM: 0 } } }, {}, [], { before, after }))
            .toMatchObject({ passed: false, reason: 'artifact-before-design-goal-missing' });
    });

    it('fails artifact scoring when moved geometry, rotations, decoration counts, or old snapshots differ', () => {
        const beforeDesign = { geometry: { buildings: [{ type: 'Feature', properties: { rotation: 0 }, geometry: { type: 'Point', coordinates: [0, 0] } }] }, structureProposal: { kind: 'park', decorationDesign: { trees: [{}, {}] } } };
        const afterDesign = { geometry: { buildings: [{ type: 'Feature', properties: { rotation: 0 }, geometry: { type: 'Point', coordinates: [0, 0.001] } }] }, structureProposal: { kind: 'park', decorationDesign: { trees: [{}] } } };
        const before = { cid: 'p1', designs: [{ cid: 'd1', designHash: 'h1', design: beforeDesign }] };
        const after = { cid: 'p2', designs: [{ cid: 'd2', designHash: 'h2', design: afterDesign }] };
        const artifact = { building: { rotation: 90 }, proposalKind: 'park', decorationCounts: { trees: 2 }, moved: { paths: ['geometry.buildings.0'], eastM: 0, northM: 1, toleranceM: 0.1 }, previousUnchanged: true };
        expect(scoreTurn({ artifact }, {}, [], { before, after, previous: before })).toMatchObject({ passed: false, reason: 'artifact-building-mismatch', field: 'rotation' });
        expect(scoreTurn({ artifact: { proposalKind: 'park', decorationCounts: { trees: 2 } } }, {}, [], { before, after })).toMatchObject({ passed: false, reason: 'artifact-decoration-count-mismatch', name: 'trees' });
        expect(scoreTurn({ artifact: { previousUnchanged: true } }, {}, [], { before, after, previous: { ...before, cid: 'changed' } })).toMatchObject({ passed: false, reason: 'artifact-previous-snapshot-changed' });
    });

    it('verifies rotation from footprint geometry when rotation metadata is absent', () => {
        const rectangle = angle => {
            const u = [Math.cos(angle), Math.sin(angle)], v = [-Math.sin(angle), Math.cos(angle)];
            const point = (along, across) => [u[0] * along + v[0] * across, u[1] * along + v[1] * across];
            return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[point(-0.002, -0.0005), point(0.002, -0.0005), point(0.002, 0.0005), point(-0.002, 0.0005), point(-0.002, -0.0005)]] } };
        };
        const before = { cid: 'p1', designs: [{ design: { geometry: { buildings: [rectangle(0)] } } }] };
        const after = { cid: 'p2', designs: [{ design: { geometry: { buildings: [rectangle(Math.PI / 4)] } } }] };
        expect(scoreTurn({ artifact: { rotated: { path: 'geometry.buildings.0', degrees: 45, toleranceDegrees: 2 } } }, {}, [], { before, after })).toMatchObject({ passed: true });
    });

    it('fails movement and rotation scoring when any geometry coordinate is nonfinite or outside WGS84 bounds', () => {
        const polygon = y => ({ type: 'Polygon', coordinates: [[[0, y], [0.002, y], [0.002, y + 0.001], [0, y + 0.001], [0, y]]] });
        const beforeDesign = { site: polygon(0), geometry: { buildings: [{ geometry: polygon(0) }] } };
        const badNan = structuredClone(beforeDesign);
        badNan.site.coordinates[0][1][0] = NaN;
        const before = { cid: 'p1', designs: [{ design: beforeDesign }] };
        const afterNan = { cid: 'p2', designs: [{ design: badNan }] };
        expect(scoreTurn({ artifact: { moved: { paths: ['site'], eastM: 0, northM: 0 } } }, {}, [], { before, after: afterNan }))
            .toMatchObject({ passed: false, reason: 'artifact-movement-geometry-missing', path: 'site' });
        expect(scoreTurn({ artifact: { rotated: { path: 'site', degrees: 45 } } }, {}, [], { before, after: afterNan }))
            .toMatchObject({ passed: false, reason: 'artifact-rotation-geometry-missing', path: 'site' });

        const badLongitude = structuredClone(beforeDesign);
        badLongitude.site.coordinates[0][1][0] = 181;
        expect(scoreTurn({ artifact: { moved: { paths: ['site'], eastM: 0, northM: 0 } } }, {}, [], {
            before, after: { cid: 'p3', designs: [{ design: badLongitude }] }
        })).toMatchObject({ passed: false, reason: 'artifact-movement-geometry-missing', path: 'site' });
    });

    it('allows create-turn readback without a prior plan and rejects invalid movement expectations', () => {
        const created = { cid: 'created', designs: [{ cid: 'design', design: { goal: 'park' } }] };
        expect(scoreTurn({ artifact: { paths: { goal: 'park' } } }, {}, [], { after: created, error: 'No prior draft.' })).toMatchObject({ passed: true });
        expect(scoreTurn({ artifact: { moved: { paths: ['site'], eastM: null, northM: 0 } } }, {}, [], { before: created, after: created })).toMatchObject({ passed: false, reason: 'artifact-movement-expectation-invalid' });
        expect(scoreTurn({ artifact: { moved: { paths: [], eastM: 0, northM: 0 } } }, {}, [], { before: created, after: created })).toMatchObject({ passed: false, reason: 'artifact-movement-expectation-invalid' });
    });

    it('requires each changedPaths geometry to exist and change in the canonical readback', () => {
        const before = { site: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } };
        const after = { site: { type: 'Polygon', coordinates: [[[0, 0], [0.8, 0], [0.8, 0.8], [0, 0]]] } };
        const readback = { before: { cid: 'p1', designs: [{ design: before }] }, after: { cid: 'p2', designs: [{ design: after }] } };
        expect(scoreTurn({ artifact: { changedPaths: ['site'] } }, {}, [], readback)).toMatchObject({ passed: true });
        expect(scoreTurn({ artifact: { changedPaths: ['site'] } }, {}, [], { ...readback, after: readback.before })).toMatchObject({ passed: false, reason: 'artifact-path-unchanged', path: 'site' });
        expect(scoreTurn({ artifact: { changedPaths: ['structureProposal.geometry'] } }, {}, [], readback)).toMatchObject({ passed: false, reason: 'artifact-changed-path-missing' });
    });

    it('checks relative Polygon area and rejects wrong ratios, malformed expectations, or missing geometry', () => {
        const polygon = (west, south, east, north) => ({ type: 'Polygon', coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]] });
        const before = { cid: 'p1', designs: [{ design: { site: polygon(0, 0, 0.001, 0.001) } }] };
        const after = { cid: 'p2', designs: [{ design: { site: polygon(0.00015, 0.00015, 0.00085, 0.00085) } }] };
        const readback = { before, after };
        expect(scoreTurn({ artifact: { areaRatio: { path: 'site', ratio: 0.49, tolerance: 0.01 } } }, {}, [], readback))
            .toMatchObject({ passed: true });
        expect(scoreTurn({ artifact: { areaRatio: { path: 'site', ratio: 0.70, tolerance: 0.01 } } }, {}, [], readback))
            .toMatchObject({ passed: false, reason: 'artifact-area-ratio-mismatch' });
        expect(scoreTurn({ artifact: { areaRatio: { path: 'site', ratio: 0.49, tolerance: -1 } } }, {}, [], readback))
            .toMatchObject({ passed: false, reason: 'artifact-area-ratio-expectation-invalid' });
        expect(scoreTurn({ artifact: { areaRatio: { path: 'structureProposal.geometry', ratio: 0.49, tolerance: 0.01 } } }, {}, [], readback))
            .toMatchObject({ passed: false, reason: 'artifact-area-ratio-geometry-missing' });
    });

    it('measures movement of authored decoration coordinates as well as GeoJSON', () => {
        const beforeDesign = { structureProposal: { decorationDesign: { trees: [
            { coordinate: [0, 0] }, { coordinate: [0.001, 0] }
        ] } } };
        const afterDesign = { structureProposal: { decorationDesign: { trees: [
            { coordinate: [0, 10 / 111320] }, { coordinate: [0.001, 10 / 111320] }
        ] } } };
        const before = { cid: 'p1', designs: [{ design: beforeDesign }] }, after = { cid: 'p2', designs: [{ design: afterDesign }] };
        expect(scoreTurn({ artifact: { moved: { paths: ['structureProposal.decorationDesign.trees'], eastM: 0, northM: 10, toleranceM: 0.1 } } }, {}, [], { before, after })).toMatchObject({ passed: true });
        const unmoved = { cid: 'p3', designs: [{ design: beforeDesign }] };
        expect(scoreTurn({ artifact: { moved: { paths: ['structureProposal.decorationDesign.trees'], eastM: 0, northM: 10, toleranceM: 0.1 } } }, {}, [], { before, after: unmoved })).toMatchObject({ passed: false, reason: 'artifact-movement-mismatch' });
    });
});
