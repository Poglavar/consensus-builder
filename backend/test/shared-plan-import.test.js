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
        `${source}\nthis.sharedImportHelpersForTest = { importAndApplySharedProposal, materializeQueuedSharedProposals, fetchSharedProposalBatch, selectSharedPlanFocusId };`,
        context
    );
    return context.sharedImportHelpersForTest;
}

describe('shared-plan focus selection', () => {
    it('chooses only a final successful/present member, latest in link order', () => {
        const { selectSharedPlanFocusId } = loadSharedImportHelpers();
        const alreadyApplied = [{ serverProposalId: 'server-existing', ord: 3 }];

        const selected = selectSharedPlanFocusId(
            [{ id: 'local-success', ord: 1, childParcelIds: [] }],
            [{ id: 'local-duplicate', ord: 2 }],
            alreadyApplied,
            proposal => proposal.ord
        );

        expect(selected).toBe('server-existing');
    });

    it('returns no focus target when every parked import failed materialisation', () => {
        const { selectSharedPlanFocusId } = loadSharedImportHelpers();

        expect(selectSharedPlanFocusId([], [], [], () => 99)).toBeNull();
    });
});

describe('shared-plan import boundary', () => {
    it('loads a whole proposal id set through one ordered batch response', async () => {
        const fetch = vi.fn(async () => ({
            ok: true,
            json: async () => ({
                items: [
                    { id: 'a', proposal: { proposalId: 'a' } },
                    { id: 'missing', proposal: null },
                    { id: 'b', proposal: { proposalId: 'b' } }
                ]
            })
        }));
        const { fetchSharedProposalBatch } = loadSharedImportHelpers({ fetch });

        const result = await fetchSharedProposalBatch(['a', 'missing', 'b', 'a'], 'http://api.test');

        expect(fetch).toHaveBeenCalledOnce();
        expect(fetch).toHaveBeenCalledWith('http://api.test/proposals/batch', expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({ ids: ['a', 'missing', 'b'] })
        }));
        expect([...result.records.keys()]).toEqual(['a', 'b']);
        expect([...result.missing]).toEqual(['missing']);
        expect(result).toMatchObject({ supported: true, requests: 1 });
    });

    it('marks an unavailable batch endpoint for individual-request fallback', async () => {
        const fetch = vi.fn(async () => ({ ok: false, status: 404 }));
        const { fetchSharedProposalBatch } = loadSharedImportHelpers({ fetch });

        const result = await fetchSharedProposalBatch(['a'], 'http://api.test');

        expect(result.supported).toBe(false);
        expect(result.records.size).toBe(0);
        expect(result.requests).toBe(1);
    });

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
        // Shared members go straight through the one-boundary replay materializer. The live
        // unrelated-holder check is a separate in-memory gate, not the interactive supersede path.
        expect(applyProposal.mock.calls.map(([id]) => id)).toEqual(['new-b', 'new-a', 'bad']);
        applyProposal.mock.calls.forEach(([id, options]) => {
            expect(options.silent, id).toBe(true);
            expect(options.replay, id).toBe(true);
            expect(options.deferPresentation, id).toBe(true);
            expect(options.supersede, id).toBeUndefined();
        });
        expect(ProposalManager.rebuildAppliedFabric).toBeUndefined();
    });

    it('prefetches demolition stock once and passes exact covered-empty slices', async () => {
        const applyProposal = vi.fn(async () => true);
        const prefetch = vi.fn(async () => new Map([
            ['building', []],
            ['park', [{ type: 'Feature', properties: { id: 'surveyed-1' }, geometry: {} }]]
        ]));
        const records = new Map([
            ['building', { proposalId: 'building', goal: 'single', buildingProposal: {} }],
            ['park', { proposalId: 'park', goal: 'park', structureProposal: {} }]
        ]);
        const ProposalManager = {
            applyProposal,
            _prefetchDemolitionBuildings: prefetch,
            validateSharedProposalGround: () => ({ ok: true, blockers: [] })
        };
        const { materializeQueuedSharedProposals } = loadSharedImportHelpers({
            ProposalManager,
            proposalStorage: { getProposal: id => records.get(id) || null },
            applyRoute: { normalizeGoalKey: goal => goal, isBuildingGoal: goal => goal === 'single' }
        });

        await materializeQueuedSharedProposals(['building', 'park']);

        expect(prefetch).toHaveBeenCalledOnce();
        expect(prefetch).toHaveBeenCalledWith([records.get('building'), records.get('park')]);
        expect(applyProposal.mock.calls).toEqual([
            ['building', { replay: true, silent: true, deferPresentation: true, preloadedBuildings: [] }],
            ['park', {
                replay: true,
                silent: true,
                deferPresentation: true,
                preloadedBuildings: [{ type: 'Feature', properties: { id: 'surveyed-1' }, geometry: {} }]
            }]
        ]);
    });

    it('refuses an externally-held ordinary member before replay without stopping its siblings', async () => {
        const applyProposal = vi.fn(async () => true);
        const alreadyStanding = { proposalId: 'outside', goal: 'building', buildingProposal: {}, applied: true };
        const planMate = { proposalId: 'already-applied-plan-mate', goal: 'building', buildingProposal: {}, applied: true };
        const records = new Map([
            ['clear', { proposalId: 'clear', goal: 'building', buildingProposal: {} }],
            ['held', { proposalId: 'held', goal: 'building', buildingProposal: {} }],
            ['outside', alreadyStanding],
            ['already-applied-plan-mate', planMate]
        ]);
        const validateSharedProposalGround = vi.fn(id => ({ ok: id !== 'held', blockers: id === 'held' ? [{}] : [] }));
        const { materializeQueuedSharedProposals } = loadSharedImportHelpers({
            ProposalManager: { applyProposal, validateSharedProposalGround },
            proposalStorage: {
                getProposal: id => records.get(id) || null,
                getAllProposals: () => [...records.values()]
            },
            applyRoute: { normalizeGoalKey: goal => goal }
        });

        const result = await materializeQueuedSharedProposals(['clear', 'held'], {
            planMemberIds: new Set(['already-applied-plan-mate'])
        });

        expect(result).toEqual({ appliedIds: ['clear'], failedIds: ['held'] });
        expect(applyProposal).toHaveBeenCalledOnce();
        expect(applyProposal).toHaveBeenCalledWith('clear', {
            replay: true,
            silent: true,
            deferPresentation: true
        });
        expect(validateSharedProposalGround).toHaveBeenCalledTimes(2);
        const membership = validateSharedProposalGround.mock.calls[0][1];
        expect([...membership].sort()).toEqual(['already-applied-plan-mate', 'clear', 'held']);
        expect(validateSharedProposalGround.mock.calls[0][2], 'plan-mates were scanned as external holders')
            .toEqual([alreadyStanding]);
    });

    it('persists and refreshes presentation once for the whole materialization batch', async () => {
        let batchDepth = 0;
        let pending = false;
        let writes = 0;
        const records = new Map([
            ['a', { proposalId: 'a', goal: 'building', buildingProposal: {} }],
            ['b', { proposalId: 'b', goal: 'building', buildingProposal: {} }]
        ]);
        const proposalStorage = {
            getProposal: id => records.get(id) || null,
            beginBatch: vi.fn(() => { batchDepth += 1; }),
            save: vi.fn(() => {
                if (batchDepth) pending = true;
                else writes += 1;
            }),
            endBatch: vi.fn(() => {
                batchDepth -= 1;
                if (!batchDepth && pending) {
                    pending = false;
                    writes += 1;
                }
            })
        };
        const refresh = vi.fn();
        const applyProposal = vi.fn(async id => {
            proposalStorage.save();
            return id !== 'b';
        });
        const { materializeQueuedSharedProposals } = loadSharedImportHelpers({
            ProposalManager: {
                applyProposal,
                validateSharedProposalGround: () => ({ ok: true, blockers: [] }),
                _refreshUIAfterProposalChange: refresh
            },
            proposalStorage,
            applyRoute: { normalizeGoalKey: goal => goal }
        });

        const result = await materializeQueuedSharedProposals(['a', 'b']);

        expect(result).toEqual({ appliedIds: ['a'], failedIds: ['b'] });
        expect(proposalStorage.beginBatch).toHaveBeenCalledOnce();
        expect(proposalStorage.endBatch).toHaveBeenCalledOnce();
        expect(writes).toBe(1);
        expect(refresh).toHaveBeenCalledOnce();
        expect(refresh).toHaveBeenCalledWith(null);
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

        expect(materializeCorridorBatch).toHaveBeenCalledWith(
            ['road-a', 'road-b'],
            { deferPresentation: true }
        );
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
            ['plots', { replay: true, silent: true, deferPresentation: true }],
            ['building', { replay: true, silent: true, deferPresentation: true }],
            ['park', { replay: true, silent: true, deferPresentation: true }]
        ]);
        expect(result).toEqual({
            appliedIds: ['plots', 'road-a', 'road-b', 'building', 'park'],
            failedIds: []
        });
    });

    // Deleted behaviour, pinned so it cannot come back. A partly applied plan used to be taken off
    // the map entirely — every standing member unapplied one at a time — and then re-applied. It
    // could not converge: one member that can never apply leaves the plan permanently "partly
    // applied", so every re-open unapplied 298 members to re-derive the same 298 (measured on the
    // Sibenik plan). What is on the map now stays on the map; only the missing members are applied.
    it('never takes standing members off the map to refresh a partly applied plan', () => {
        expect(source, 'the partial-plan reset is back')
            .not.toMatch(/resetPartiallyAppliedSharedPlan/);
        expect(source, 'the plan route unapplies members again')
            .not.toMatch(/coveredIncomingIds\.size > 0 && coveredIncomingIds\.size < totalProposals/);
        // The remaining "Rebuilding applied plan" is the boot replay awaiting reapplyAppliedProposals,
        // which is a different phase that happens to share the wording.
        expect(source).toMatch(/await ProposalManager\.reapplyAppliedProposals\(\)/);
    });
});
