// A block's proposal rows offer Apply / Unapply exactly as every other proposal list does
// (proposals/display-state.js): a cancelled proposal is withdrawn and is offered neither, even when
// this browser still holds it as applied.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function blockPanelContext() {
    const context = {
        console,
        setTimeout: () => 1,
        clearTimeout() {},
        document: { getElementById: () => null, querySelectorAll: () => [] },
        ProposalManager: {},
        proposalLadderBadgesHtml: () => '',
        escapeHtml: value => String(value),
        CbFormat: { formatLength: value => `${value} m`, formatDate: () => '' }
    };
    context.window = context;
    context.addEventListener = () => {};
    vm.createContext(context);
    // Load the same pure lifecycle collaborator used by display-state in the browser.
    for (const file of ['shared-utils.js', 'proposals/status.js', 'proposals/lifecycle-evidence.js',
        'proposals/display-state.js', 'parcel-blocks.js']) {
        vm.runInContext(readFileSync(new URL(`../../frontend/js/${file}`, import.meta.url), 'utf8'), context);
    }
    return context;
}

const road = (overrides = {}) => ({
    proposalId: 'p-1',
    goal: 'road-track',
    roadProposal: {},
    lifecycleStatus: 'active',
    applied: false,
    ...overrides
});

describe('a block proposal row’s map action', () => {
    it('offers Apply to an active proposal and Remove from map once it is applied', () => {
        const context = blockPanelContext();
        expect(context.buildBlockProposalListItem(road())).toContain('applyProposalToMap(');
        const applied = context.buildBlockProposalListItem(road({ applied: true }));
        expect(applied).toContain('removeProposalFromMap(');
        expect(applied).not.toContain('applyProposalToMap(');
    });

    it('offers neither to a cancelled proposal, applied in this browser or not', () => {
        const context = blockPanelContext();
        for (const applied of [true, false]) {
            const row = context.buildBlockProposalListItem(road({ lifecycleStatus: 'cancelled', applied }));
            expect(row, `applied=${applied}`).not.toContain('applyProposalToMap(');
            expect(row, `applied=${applied}`).not.toContain('removeProposalFromMap(');
            expect(row).toContain('proposal-delete-btn');
        }
    });
});
