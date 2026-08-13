import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(
    new URL('../../frontend/js/proposals/sharing-routes.js', import.meta.url),
    'utf8'
);

function loadSharedImportHelpers(overrides = {}) {
    const context = {
        console,
        prepareProposalForImport: proposal => structuredClone(proposal),
        computeRequiredParentIdsForSharedProposal: () => [],
        ensureArrayOfStrings: value => Array.isArray(value) ? value.map(String) : [],
        setProposalApplied: (proposal, applied) => { proposal.applied = applied; },
        ...overrides
    };
    vm.createContext(context);
    vm.runInContext(
        `${source}\nthis.sharedImportHelpersForTest = { importAndApplySharedProposal, materializeQueuedSharedProposals };`,
        context
    );
    return context.sharedImportHelpersForTest;
}

describe('shared-plan import boundary', () => {
    it('imports a missing proposal parked, ready for the scoped apply pass', async () => {
        const imported = [];
        const proposalStorage = {
            getProposal: vi.fn(() => null),
            importProposal: vi.fn(proposal => {
                const stored = structuredClone(proposal);
                imported.push(stored);
                return stored;
            }),
            _indexProposal: vi.fn(),
            save: vi.fn()
        };
        const { importAndApplySharedProposal: importProposal } = loadSharedImportHelpers({ proposalStorage });

        const result = await importProposal({
            proposalId: 'shared-building',
            goal: 'building',
            buildingProposal: { parentParcelIds: ['HR-1'] }
        }, { skipDependencyFetch: true });

        expect(result).toEqual({
            applied: true,
            skipped: false,
            proposalId: 'shared-building',
            queued: true
        });
        expect(imported).toHaveLength(1);
        expect(imported[0].applied).toBe(false);
        expect(proposalStorage._indexProposal).toHaveBeenCalledWith(imported[0]);
        expect(proposalStorage.save).toHaveBeenCalledOnce();
    });

    it('materialises only the queued ids through scoped apply, never a whole-plan rebuild', async () => {
        const applyProposal = vi.fn(async id => id !== 'bad');
        const ProposalManager = { applyProposal };
        const { materializeQueuedSharedProposals } = loadSharedImportHelpers({ ProposalManager });

        const result = await materializeQueuedSharedProposals(['new-a', 'bad', 'new-b', 'new-a']);

        expect(result).toEqual({
            appliedIds: ['new-a', 'new-b'],
            failedIds: ['bad']
        });
        expect(applyProposal.mock.calls).toEqual([
            ['new-a', { silent: true }],
            ['bad', { silent: true }],
            ['new-b', { silent: true }]
        ]);
        expect(ProposalManager.rebuildAppliedFabric).toBeUndefined();
    });
});
