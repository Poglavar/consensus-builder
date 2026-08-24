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
        isProposalCurrentlyApplied: proposal => proposal?.applied === true,
        setProposalApplied: (proposal, applied) => { proposal.applied = applied; },
        ...overrides
    };
    vm.createContext(context);
    vm.runInContext(
        `${source}\nthis.sharedImportHelpersForTest = { importAndApplySharedProposal, materializeQueuedSharedProposals, resetPartiallyAppliedSharedPlan };`,
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
        expect(proposalStorage.importProposal).toHaveBeenCalledWith(
            expect.objectContaining({ proposalId: 'shared-building' }),
            { overwrite: true }
        );
        expect(proposalStorage._indexProposal).toHaveBeenCalledWith(imported[0]);
        expect(proposalStorage.save).toHaveBeenCalledOnce();
    });

    it('replaces a stale parked copy with the current server definition', async () => {
        const stale = {
            proposalId: 'shared-road',
            goal: 'road-track',
            applied: false,
            roadProposal: { definition: { width: 30 }, parentParcelIds: ['OLD'] }
        };
        const proposalStorage = {
            getProposal: vi.fn(() => stale),
            importProposal: vi.fn(proposal => structuredClone(proposal)),
            _indexProposal: vi.fn(),
            save: vi.fn()
        };
        const ensureRoadParentParcelIds = vi.fn(() => true);
        const { importAndApplySharedProposal: importProposal } = loadSharedImportHelpers({
            proposalStorage,
            ensureRoadParentParcelIds
        });

        const result = await importProposal({
            proposalId: 'shared-road',
            goal: 'road-track',
            roadProposal: { definition: { width: 12 }, parentParcelIds: ['HR-1'] }
        }, { skipDependencyFetch: true });

        expect(result.queued).toBe(true);
        expect(proposalStorage.importProposal).toHaveBeenCalledWith(
            expect.objectContaining({
                proposalId: 'shared-road',
                roadProposal: expect.objectContaining({ definition: { width: 12 } })
            }),
            { overwrite: true }
        );
    });

    it('materialises only the queued ids through scoped apply, never a whole-plan rebuild', async () => {
        const applyProposal = vi.fn(async id => id !== 'bad');
        const ProposalManager = { applyProposal };
        const proposalStorage = {
            getProposal: id => ({ proposalId: id, goal: id === 'new-b' ? 'road-track' : 'building' })
        };
        const applyRoute = { normalizeGoalKey: goal => goal };
        const { materializeQueuedSharedProposals } = loadSharedImportHelpers({ ProposalManager, proposalStorage, applyRoute });

        const result = await materializeQueuedSharedProposals(['new-a', 'bad', 'new-b', 'new-a']);

        expect(result).toEqual({
            appliedIds: ['new-b', 'new-a'],
            failedIds: ['bad']
        });
        // Each member is applied silently AND without the explicit-Apply supersede sweep: applying
        // a shared plan is not the "this design, not that one" a click is, so ground held by the
        // reader's own applied work is refused and reported rather than stood down. The plan's own
        // membership rides along, because a member on a plan-mate's ground is the plan working.
        expect(applyProposal.mock.calls.map(([id]) => id)).toEqual(['new-b', 'new-a', 'bad']);
        applyProposal.mock.calls.forEach(([id, options]) => {
            expect(options.silent, id).toBe(true);
            expect(options.supersede, id).toBe(false);
            // Duck-typed on purpose — the helper builds its Set in another realm, and the
            // production guard accepts any membership with .has() for exactly that reason.
            expect(typeof options.planMemberIds.has, id).toBe('function');
            expect([...options.planMemberIds].sort(), id).toEqual(['bad', 'new-a', 'new-b']);
        });
        expect(ProposalManager.rebuildAppliedFabric).toBeUndefined();
    });

    it('materialises package roads in one batch, then readjustment, buildings and public spaces', async () => {
        const applyProposal = vi.fn(async () => true);
        const materializeCorridorBatch = vi.fn(async ids => ({
            ok: true,
            appliedIds: ids,
            failedIds: []
        }));
        const records = new Map([
            ['plots', { goal: 'reparcellization' }],
            ['park', { goal: 'park' }],
            ['building-a', { goal: 'single', buildingProposal: {} }],
            ['building-b', { goal: 'single', buildingProposal: {} }],
            ['road-a', { goal: 'road-track' }],
            ['road-b', { roadProposal: { definition: {} } }]
        ]);
        const { materializeQueuedSharedProposals } = loadSharedImportHelpers({
            ProposalManager: { applyProposal, materializeCorridorBatch },
            proposalStorage: { getProposal: id => records.get(id) || null },
            applyRoute: { normalizeGoalKey: goal => goal }
        });

        const result = await materializeQueuedSharedProposals([
            'park', 'building-a', 'road-a', 'building-b', 'plots', 'road-b'
        ]);

        expect(materializeCorridorBatch).toHaveBeenCalledWith(['road-a', 'road-b']);
        expect(applyProposal.mock.calls.map(call => call[0]))
            .toEqual(['plots', 'building-a', 'building-b', 'park']);
        expect(result).toEqual({
            appliedIds: ['road-a', 'road-b', 'plots', 'building-a', 'building-b', 'park'],
            failedIds: []
        });
    });

    it('materialises a coordinated readjustment before its reserved road bands', async () => {
        const events = [];
        const applyProposal = vi.fn(async id => { events.push(id); return true; });
        const materializeCorridorBatch = vi.fn(async ids => {
            events.push(`roads:${ids.join('+')}`);
            return { ok: true, appliedIds: ids, failedIds: [] };
        });
        const coordinatedPlanId = 'plan-one';
        const records = new Map([
            ['plots', { goal: 'reparcellization', coordinatedPlanId }],
            ['park', { goal: 'park', coordinatedPlanId }],
            ['building', { goal: 'single', buildingProposal: {}, coordinatedPlanId }],
            ['road-a', { goal: 'road-track', coordinatedPlanId }],
            ['road-b', { roadProposal: { definition: {} }, coordinatedPlanId }]
        ]);
        const { materializeQueuedSharedProposals } = loadSharedImportHelpers({
            ProposalManager: { applyProposal, materializeCorridorBatch },
            proposalStorage: { getProposal: id => records.get(id) || null },
            applyRoute: {
                normalizeGoalKey: goal => goal,
                isBuildingGoal: goal => goal === 'single'
            }
        });

        const result = await materializeQueuedSharedProposals([
            'park', 'road-a', 'building', 'plots', 'road-b'
        ]);

        expect(events).toEqual(['plots', 'roads:road-a+road-b', 'building', 'park']);
        expect(applyProposal.mock.calls).toEqual([
            ['plots', { replay: true, silent: true }],
            ['building', { replay: true, silent: true }],
            ['park', { replay: true, silent: true }]
        ]);
        expect(result).toEqual({
            appliedIds: ['plots', 'road-a', 'road-b', 'building', 'park'],
            failedIds: []
        });
    });

    it('takes a partial package off in reverse dependency order before refreshing it', async () => {
        const records = new Map([
            ['plots', { proposalId: 'plots', goal: 'reparcellization' }],
            ['park', { proposalId: 'park', goal: 'park' }],
            ['building', { proposalId: 'building', goal: 'single', buildingProposal: {} }],
            ['road', { proposalId: 'road', goal: 'road-track' }]
        ]);
        const unapplyProposal = vi.fn(async () => true);
        const { resetPartiallyAppliedSharedPlan } = loadSharedImportHelpers({
            ProposalManager: { unapplyProposal },
            proposalStorage: { getProposal: id => records.get(id) || null },
            applyRoute: {
                normalizeGoalKey: goal => goal,
                isBuildingGoal: goal => goal === 'single'
            }
        });

        const result = await resetPartiallyAppliedSharedPlan([
            records.get('road'), records.get('building'), records.get('plots'), records.get('park')
        ]);

        expect(result.failedIds).toEqual([]);
        expect(unapplyProposal.mock.calls.map(call => call[0]))
            .toEqual(['park', 'building', 'plots', 'road']);
    });
});
