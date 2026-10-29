// A plan as a Compare side without applying it (frontend/js/compare-unapplied.js): which members a
// plan side draws itself, the footprints a member draws, the ground each member clears, and what
// those members do to one standing building. The read and the renderers are checked in the browser.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const unapplied = require('../../frontend/js/compare-unapplied.js');
const compare = require('../../frontend/js/three-compare.js');

const square = (x, y, size) => ({ type: 'Polygon', coordinates: [[[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]]] });

describe('the members a plan side shows', () => {
    const plan = { content: { designCids: ['cidA', 'cidB', 'cidC'] }, designs: [{ cid: 'cidB', proposalId: 'local-b' }] };

    it('names an applied copy by its id and the rest by CID, which the plan draws itself', () => {
        expect(unapplied.membersOf(plan, [{ id: '7', cid: 'cidA' }, { id: 'local-b', cid: null }]))
            .toEqual({ members: ['7', 'local-b', 'cidC'], unapplied: ['cidC'] });
        expect(unapplied.membersOf(plan, [])).toEqual({ members: ['cidA', 'cidB', 'cidC'], unapplied: ['cidA', 'cidB', 'cidC'] });
        expect(unapplied.membersOf({ content: {} }, [{ id: '7', cid: 'cidA' }])).toEqual({ members: [], unapplied: [] });
    });

    it('is what a plan side applies: its applied members and its own unapplied ones, never on Proposed or a design side', () => {
        const options = compare.sideOptions({ designs: [{ id: '7', title: 'Block' }],
            plans: [{ id: 'p', title: 'P', ...unapplied.membersOf(plan, [{ id: '7', cid: 'cidA' }]) }] });
        const side = value => compare.parseSide(value, options);
        const own = { role: 'proposed', designId: 'cidC', unapplied: true };
        expect(compare.showsOn(side('plan:p'), own)).toBe(true);
        expect(compare.showsOn(side('proposed'), own)).toBe(false);
        expect(compare.showsOn(side('design:7'), own)).toBe(false);
        expect(compare.showsOn(side('built'), own)).toBe(false);
        // A building the unapplied member clears is gone on the plan's side alone.
        const cleared = { role: 'existing', demolishedBy: [{ id: 'cidC', unapplied: true }] };
        expect(['built', 'permitted', 'proposed', 'design:7'].map(value => compare.showsOn(side(value), cleared))).toEqual([true, true, true, true]);
        expect(compare.showsOn(side('plan:p'), cleared)).toBe(false);
    });
});

describe('what an unapplied member draws and clears', () => {
    const building = { type: 'Feature', properties: { floors: 4 }, geometry: square(0, 0, 10) };
    const rows = [
        { proposalId: 'cidA', buildingProposal: {}, geometry: { buildings: [building] }, cadastreParcelIds: ['p1'] },
        { proposalId: 'cidR', roadProposal: { definition: { polygon: square(20, 0, 5) } } },
        { proposalId: 'cidS', structureProposal: { kind: 'park', geometry: square(40, 0, 8) } },
        { proposalId: 'applied', buildingProposal: {}, geometry: { buildings: [building] } }
    ];

    it('lists its buildings, its road corridor and its space ground as footprints', () => {
        expect(unapplied.footprintsOf(rows[0])).toEqual([{ kind: 'building', feature: building }]);
        expect(unapplied.footprintsOf(rows[1])).toEqual([{ kind: 'road', feature: { type: 'Feature', properties: {}, geometry: square(20, 0, 5) } }]);
        expect(unapplied.footprintsOf(rows[2])).toEqual([{ kind: 'structure', feature: { type: 'Feature', properties: { kind: 'park' }, geometry: square(40, 0, 8) } }]);
        expect(unapplied.footprintsOf({})).toEqual([]);
    });

    it('keeps only the unapplied members, with the scan regions of buildings and structures and a road corridor as its own region', () => {
        const scanned = [];
        const collectRegions = (members, pieces) => {
            scanned.push(members.map(row => row.proposalId), pieces);
            return [{ key: 'cidA', geometry: square(0, 0, 12) }, { key: 'cidS', geometry: square(40, 0, 8) }];
        };
        const snapshot = { records: rows, materializedFeatures: ['piece'], corridorFeatures: [] };
        const part = unapplied.unappliedPart(snapshot, ['cidA', 'cidR', 'cidS'], collectRegions);
        expect(part.rows.map(row => row.proposalId)).toEqual(['cidA', 'cidR', 'cidS']);
        expect(scanned).toEqual([['cidA', 'cidR', 'cidS'], ['piece']]);
        expect(part.clearing.map(member => [member.id, member.regions.map(region => region.geometry)])).toEqual([
            ['cidA', [square(0, 0, 12)]], ['cidR', [square(20, 0, 5)]], ['cidS', [square(40, 0, 8)]]]);
    });

    it('reports one cut per member that cuts or clears a standing building', () => {
        const part = { clearing: [{ id: 'cidA', regions: ['covers'] }, { id: 'cidR', regions: ['halves'] }, { id: 'cidS', regions: ['misses'] }] };
        const clearance = (footprint, regions) => regions[0] === 'covers' ? { outcome: 'gone', feature: null }
            : regions[0] === 'halves' ? { outcome: 'cut', feature: { type: 'Feature', geometry: 'rest' } } : { outcome: 'kept', feature: footprint };
        expect(unapplied.cutsOf(part, { type: 'Feature', geometry: 'whole' }, clearance)).toEqual([
            { by: { id: 'cidA', unapplied: true }, remainder: null },
            { by: { id: 'cidR', unapplied: true }, remainder: 'rest' }
        ]);
        expect(unapplied.cutsOf({ clearing: [] }, { type: 'Feature', geometry: 'whole' }, clearance)).toEqual([]);
    });
});
