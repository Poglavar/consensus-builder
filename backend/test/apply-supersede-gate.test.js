// Applying a shared PLAN must not stand down work the reader already had applied.
//
// Superseding is what an explicit Apply click means — "this design, not that one" — and
// proposal-supersession.js implements it deliberately (one design per parcel). The bug was that the
// shared-plan route reached the very same path, so opening someone's plan link could quietly unapply
// your proposals and say so only in a toast. The plan path now passes supersede:false and gets a
// refusal it can report instead.
//
// Driven through the real branch in proposal-manager.js rather than restated: the guard is lifted
// from the source, so deleting it fails these tests.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const managerSource = readFileSync(
    fileURLToPath(new URL('../../frontend/js/proposal-manager.js', import.meta.url)), 'utf8');
const sharingSource = readFileSync(
    fileURLToPath(new URL('../../frontend/js/proposals/sharing-routes.js', import.meta.url)), 'utf8');

// The guard is a self-contained block inside applyProposal. Lift it and run it against a fake
// manager, so the branch under test is the shipped text.
function runGuard({ supersede, held, planMemberIds }) {
    const start = managerSource.indexOf('if (applyOptions.supersede === false) {');
    if (start < 0) throw new Error('proposal-manager.js no longer guards on applyOptions.supersede');
    const end = managerSource.indexOf('\n                }\n', start);
    const block = managerSource.slice(start, end + 18);

    const failures = [];
    const sandbox = {
        applyOptions: { supersede, planMemberIds },
        Set,
        proposalId: 'p-1',
        proposal: { proposalId: 'p-1', title: 'Mine' },
        console: { warn() {} },
        self: {
            _collectAppliedAlternativesForExplicitApply: () => held,
            _setLastApplyFailure: (id, failure) => failures.push({ id, failure })
        }
    };
    sandbox.globalThis = sandbox;
    const context = vm.createContext(sandbox);
    // `this` inside the block is the manager; wrap it in a function called with our fake.
    const refused = vm.runInContext(
        `(function () {\n${block}\n  return 'not-refused';\n}).call(self)`,
        context,
        { filename: 'supersede-guard.js' }
    );
    return { refused: refused === false, failures };
}

const alternative = (id, title) => ({ proposalId: id, title });

describe('a plan apply refuses ground another proposal holds', () => {
    it('refuses instead of standing the holder down', () => {
        const { refused, failures } = runGuard({
            supersede: false,
            held: [alternative('other-1', 'Block 1108-0112')]
        });

        expect(refused, 'applied over an existing proposal during a plan apply').toBe(true);
        expect(failures).toHaveLength(1);
        expect(failures[0].failure.code).toBe('ground-held-by-proposal');
        expect(failures[0].failure.message).toContain('Block 1108-0112');
        // The holder's identity rides along so the report can name it, not just count it.
        expect(failures[0].failure.conflictProposalIds).toEqual(['other-1']);
    });

    it('names every holder, so the report is not "1 of several"', () => {
        const { failures } = runGuard({
            supersede: false,
            held: [alternative('a', 'Block A'), alternative('b', 'Block B')]
        });
        expect(failures[0].failure.message).toContain('Block A');
        expect(failures[0].failure.message).toContain('Block B');
        expect(failures[0].failure.conflictTitles).toEqual(['Block A', 'Block B']);
    });

    it('does not refuse when the ground is free', () => {
        const { refused, failures } = runGuard({ supersede: false, held: [] });
        expect(refused).toBe(false);
        expect(failures).toEqual([]);
    });

    // The click path must keep superseding: that is what choosing a design means, and it is the
    // behaviour proposal-supersession.js exists to provide.
    it('leaves an explicit apply free to supersede', () => {
        const { refused, failures } = runGuard({
            supersede: undefined,
            held: [alternative('other-1', 'Block 1108-0112')]
        });
        expect(refused, 'blocked an explicit Apply from choosing its design').toBe(false);
        expect(failures).toEqual([]);
    });
});

// The case the unit tests missed and a live run caught: re-opening an applied plan finds every
// member's ground held by its own plan-mates. Refusing on that refused 100+ of 299 members.
describe('a plan\'s own members are not blockers', () => {
    it('ignores holders that belong to the plan being applied', () => {
        const { refused, failures } = runGuard({
            supersede: false,
            held: [alternative('mate-1', 'Block A'), alternative('mate-2', 'Block B')],
            planMemberIds: new Set(['mate-1', 'mate-2'])
        });
        expect(refused, 'refused a member on its own plan-mates').toBe(false);
        expect(failures).toEqual([]);
    });

    it('still refuses on ground held from outside the plan', () => {
        const { refused, failures } = runGuard({
            supersede: false,
            held: [alternative('mate-1', 'Block A'), alternative('stranger', 'Someone else')],
            planMemberIds: new Set(['mate-1'])
        });
        expect(refused).toBe(true);
        expect(failures[0].failure.conflictProposalIds).toEqual(['stranger']);
        expect(failures[0].failure.message, 'named a plan-mate as a blocker').not.toContain('Block A');
    });

    it('refuses as before when the caller names no plan', () => {
        const { refused } = runGuard({ supersede: false, held: [alternative('x', 'Block X')] });
        expect(refused).toBe(true);
    });
});

describe('the shared-plan route asks for that behaviour', () => {
    it('passes supersede:false for members that are not part of a coordinated plan', () => {
        expect(sharingSource, 'the plan route no longer opts out of superseding')
            .toMatch(/\{ silent: true, supersede: false, planMemberIds \}/);
    });

    // Coordinated members are complementary parts of one published plan and already bypass the
    // sweep via replay; if that ever changed they would start refusing each other.
    it('leaves coordinated members on the replay path', () => {
        expect(sharingSource).toMatch(/coordinatedPlanIdOfSharedRecord\(record\)\s*\n\s*\?\s*\{ replay: true, silent: true \}/);
    });
});
