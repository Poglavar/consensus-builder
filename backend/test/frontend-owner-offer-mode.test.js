// Characterize the real create.js owner-offer toggle: enabling it chooses an open sale recipient
// only when no goal exists, and disabling it leaves the proposal's selected goal/facets alone.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';

const createSource = readFileSync(fileURLToPath(new URL('../../frontend/js/proposals/create.js', import.meta.url)), 'utf8');

function loadOwnerOfferToggle({ checked, disabled = false, goal = null, facets = {} }) {
    const calls = [];
    const checkbox = { checked, disabled };
    const explain = { hidden: false };
    const window = { proposalOwnerOfferMode: false, proposalFacets: { ...facets } };
    const context = createContext({
        window,
        document: {
            getElementById(id) {
                if (id === 'proposalOwnerOfferCheckbox') return checkbox;
                if (id === 'proposalOwnerOfferExplain') return explain;
                return null;
            }
        },
        getSelectedProposalTool: () => goal,
        setProposalOwnershipMode(mode) {
            calls.push(['setProposalOwnershipMode', mode]);
            window.proposalFacets.ownership = mode;
        },
        syncProposalFacets() {
            calls.push(['syncProposalFacets', window.proposalFacets.ownership]);
        },
        console
    });
    runInContext(createSource, context, { filename: 'frontend/js/proposals/create.js' });
    context.onProposalOwnerOfferChange();
    return { window, calls, explain, checkbox };
}

describe('create.js owner-offer mode', () => {
    it('sets the real open-sale ownership facet when enabled with no selected goal', () => {
        const result = loadOwnerOfferToggle({ checked: true });

        expect(result.window.proposalOwnerOfferMode).toBe(true);
        expect(result.window.proposalFacets.ownership).toBe('third-party');
        expect(result.explain.hidden).toBe(false);
        expect(result.calls).toEqual([
            ['setProposalOwnershipMode', 'third-party'],
            ['syncProposalFacets', 'third-party']
        ]);
    });

    it('preserves an existing selected proposal goal when owner-offer mode is enabled', () => {
        const result = loadOwnerOfferToggle({ checked: true, goal: 'park', facets: { ownership: 'no-change' } });

        expect(result.window.proposalOwnerOfferMode).toBe(true);
        expect(result.window.proposalFacets.ownership).toBe('no-change');
        expect(result.calls).toEqual([]);
    });

    it('clears owner-offer mode without changing the goal or ownership facet when disabled', () => {
        const result = loadOwnerOfferToggle({ checked: false, goal: 'park', facets: { ownership: 'third-party' } });

        expect(result.window.proposalOwnerOfferMode).toBe(false);
        expect(result.window.proposalFacets.ownership).toBe('third-party');
        expect(result.explain.hidden).toBe(true);
        expect(result.calls).toEqual([]);
    });
});
