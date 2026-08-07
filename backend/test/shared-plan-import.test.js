import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(
    new URL('../../frontend/js/proposals/sharing-routes.js', import.meta.url),
    'utf8'
);

function loadImporter(overrides = {}) {
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
        `${source}\nthis.importAndApplySharedProposalForTest = importAndApplySharedProposal;`,
        context
    );
    return context.importAndApplySharedProposalForTest;
}

describe('shared-plan import boundary', () => {
    it('imports a missing proposal before marking it applied', async () => {
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
        const importProposal = loadImporter({ proposalStorage });

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
        expect(imported[0].applied).toBe(true);
        expect(proposalStorage._indexProposal).toHaveBeenCalledWith(imported[0]);
        expect(proposalStorage.save).toHaveBeenCalledOnce();
    });
});
