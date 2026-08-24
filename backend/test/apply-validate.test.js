// The precheck's one dangerous failure mode is a FALSE refusal: it would silently drop work the
// apply would have accepted, and nobody would ever see the proposal that was never attempted. So
// these tests lean on that direction — it must stay quiet whenever it is unsure — and they check
// its counting against the real rule in apply/buildings.js rather than restating it loosely.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { validateApply, validatePlan, CODE_INVALID, CODE_NO_BUILDING_GEOMETRY } =
    require('../../frontend/js/proposals/apply/validate.js');
const applyRoute = require('../../frontend/js/proposals/apply/route.js');

// The real classifier, so "is this a building" means the same here as in the apply.
const deps = { classify: (record) => applyRoute.classifyApplyRoute(record) };

const building = (buildings) => ({
    proposalId: 'b1',
    title: 'Block A',
    goal: 'buildings',
    buildingProposal: {},
    geometry: { buildings }
});
const footprint = () => ({
    type: 'Feature',
    properties: {},
    geometry: { type: 'Polygon', coordinates: [[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]] }
});

describe('validateApply', () => {
    it('refuses an empty record, with the apply\'s own code', () => {
        expect(validateApply(null, deps).code).toBe(CODE_INVALID);
        expect(validateApply(undefined, deps).code).toBe(CODE_INVALID);
        expect(validateApply('nonsense', deps).code).toBe(CODE_INVALID);
    });

    it('passes a building proposal that has a usable footprint', () => {
        expect(validateApply(building([footprint()]), deps).ok).toBe(true);
    });

    it('refuses a building proposal storing no footprints', () => {
        const verdict = validateApply(building([]), deps);
        expect(verdict.ok).toBe(false);
        expect(verdict.code).toBe(CODE_NO_BUILDING_GEOMETRY);
    });

    // Same counting rule as apply/buildings.js: an entry without `.geometry` is dropped there too,
    // so a record holding only those has no footprints by either count.
    it('does not count entries the apply itself would drop', () => {
        expect(validateApply(building([{ type: 'Feature' }, null]), deps).code).toBe(CODE_NO_BUILDING_GEOMETRY);
        expect(validateApply(building([{ type: 'Feature' }, footprint()]), deps).ok).toBe(true);
    });

    // The safety direction. Every one of these is a case where the precheck cannot be sure, so it
    // must defer to the apply rather than refuse.
    describe('stays quiet when it cannot be sure', () => {
        it('passes kinds it has no record-level rule for', () => {
            for (const goal of ['road-track', 'reparcellization', 'decide-later', 'park', 'square']) {
                expect(validateApply({ proposalId: 'x', goal }, deps).ok, goal).toBe(true);
            }
        });

        it('passes when no classifier is available — a rule aimed at the wrong kind is a false refusal', () => {
            expect(validateApply(building([]), undefined).ok).toBe(true);
            expect(validateApply(building([]), {}).ok).toBe(true);
        });

        it('passes when the classifier throws', () => {
            const throwing = { classify: () => { throw new Error('classifier exploded'); } };
            expect(validateApply(building([]), throwing).ok).toBe(true);
        });
    });
});

describe('validatePlan', () => {
    it('splits a plan before any member is applied', () => {
        const report = validatePlan([
            building([footprint()]),
            { ...building([]), proposalId: 'b2', title: 'Block B' },
            { proposalId: 'r1', title: 'Road', goal: 'road-track' }
        ], deps);

        expect(report.total).toBe(3);
        expect(report.applicable.map(e => e.proposalId)).toEqual(['b1', 'r1']);
        expect(report.blocked.map(e => e.proposalId)).toEqual(['b2']);
        expect(report.blocked[0].title).toBe('Block B');
        expect(report.blocked[0].verdict.code).toBe(CODE_NO_BUILDING_GEOMETRY);
    });

    it('accepts {proposalId, record} pairs as well as bare records', () => {
        const report = validatePlan([{ proposalId: 'given', record: building([]) }], deps);
        expect(report.blocked[0].proposalId).toBe('given');
    });

    it('handles an empty plan without inventing work', () => {
        expect(validatePlan([], deps)).toEqual({ applicable: [], blocked: [], total: 0 });
        expect(validatePlan(null, deps).total).toBe(0);
    });
});

// A precheck that disagrees with the apply is worse than none: it either blocks good work or lets
// bad work through with a reassuring green. This pins the two to the same source text.
describe('the precheck and the apply agree on what a footprint is', () => {
    it('reads geometry.buildings, filtered on .geometry, exactly as the apply does', () => {
        const source = readFileSync(
            fileURLToPath(new URL('../../frontend/js/proposals/apply/buildings.js', import.meta.url)), 'utf8');
        expect(source, 'apply/buildings.js no longer reads geometry.buildings')
            .toMatch(/proposalData\?\.geometry\?\.buildings/);
        expect(source, 'apply/buildings.js no longer keeps entries on .geometry')
            .toMatch(/cloned && cloned\.geometry \? cloned : null/);
        expect(source, "apply/buildings.js no longer refuses with this precheck's code")
            .toContain(CODE_NO_BUILDING_GEOMETRY);
    });
});
