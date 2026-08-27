// Applying a shared PLAN must not stand down work the reader already had applied.
//
// Superseding is what an explicit Apply click means — "this design, not that one" — and
// proposal-supersession.js implements it deliberately (one design per parcel). The bug was that the
// shared-plan route reached the very same path, so opening someone's plan link could quietly unapply
// your proposals and say so only in a toast. The plan path now runs the same holder validation in
// memory, then goes straight to the one-boundary replay materializer.
//
// Driven through the real validator in proposal-manager.js; the route contract is pinned from its
// shipped source so removing either half fails these tests.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ProposalManager } = require('../../frontend/js/proposal-manager.js');

const sharingSource = readFileSync(
    fileURLToPath(new URL('../../frontend/js/proposals/sharing-routes.js', import.meta.url)), 'utf8');

// Exercise the shipped validator with its collaborators replaced for one synchronous call.
function runGuard({ supersede, held, planMemberIds }) {
    const failures = [];
    if (supersede !== false) return { refused: false, failures };
    const priorStorage = globalThis.proposalStorage;
    const priorCollect = ProposalManager._collectAppliedAlternativesForExplicitApply;
    const priorFailure = ProposalManager._setLastApplyFailure;
    globalThis.proposalStorage = { getProposal: () => ({ proposalId: 'p-1', title: 'Mine' }) };
    ProposalManager._collectAppliedAlternativesForExplicitApply = () => held;
    ProposalManager._setLastApplyFailure = (id, failure) => failures.push({ id, failure });
    try {
        const validation = ProposalManager.validateSharedProposalGround('p-1', planMemberIds);
        return { refused: validation.ok !== true, failures };
    } finally {
        if (priorStorage === undefined) delete globalThis.proposalStorage;
        else globalThis.proposalStorage = priorStorage;
        ProposalManager._collectAppliedAlternativesForExplicitApply = priorCollect;
        ProposalManager._setLastApplyFailure = priorFailure;
    }
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
    it('validates external holders before materializing an ordinary member', () => {
        expect(sharingSource, 'the plan route no longer checks unrelated holders')
            .toMatch(/validateSharedProposalGround\(\s*id,\s*planMemberIds,\s*preexistingAppliedRecords\s*\)/);
    });

    it('uses the direct replay path without the interactive supersession transaction', () => {
        expect(sharingSource).toMatch(/\{ replay: true, silent: true, deferPresentation: true \}/);
        expect(sharingSource).not.toMatch(/\{ silent: true, supersede: false, planMemberIds \}/);
    });
});
