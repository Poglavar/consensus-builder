// A full replay presents itself once: every member is replayed with deferPresentation, and the
// rebuild registers one after-commit refresh (styles, list, button, corridor strips) for the
// whole applied set instead of one per member (rebuildAppliedFabric / _rebuildPass).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ProposalManager } = require('../../frontend/js/proposal-manager.js');

const saved = new Map();
function installGlobal(name, value) {
    if (!saved.has(name)) {
        saved.set(name, { existed: Object.prototype.hasOwnProperty.call(globalThis, name), value: globalThis[name] });
    }
    globalThis[name] = value;
}

afterEach(() => {
    for (const [name, prior] of saved) {
        if (prior.existed) globalThis[name] = prior.value;
        else delete globalThis[name];
    }
    saved.clear();
    vi.restoreAllMocks();
});

const building = index => ({
    proposalId: `b-${index}`,
    goal: 'buildings',
    applied: true,
    createdAt: `2026-01-0${index + 1}T00:00:00Z`,
    cadastreParcelIds: [`HR-${index}`]
});

function replayHarness(records) {
    const presentation = {
        refreshParcelStylesForAppliedProposals: vi.fn(),
        updateProposalList: vi.fn(),
        updateShowProposalsButton: vi.fn(),
        refreshAppliedCorridorStripsSliced: vi.fn(async () => {})
    };
    Object.entries(presentation).forEach(([name, fn]) => installGlobal(name, fn));
    installGlobal('isProposalCurrentlyApplied', record => record && record.applied === true);
    const afterCommit = [];
    const store = {
        getAllProposals: () => records.slice(),
        peekAllProposals: () => records,
        beginBatch: vi.fn(),
        endBatch: vi.fn(),
        save: vi.fn()
    };
    const context = { proposals: store, afterCommit: callback => afterCommit.push(callback) };
    const applyOptions = [];
    const manager = {
        ...ProposalManager,
        _lastApplyFailureByProposalId: new Map(),
        _rebuildInProgress: false,
        _loadReplayGround: vi.fn(async () => 0),
        _prefetchDemolitionBuildings: vi.fn(async () => new Map()),
        _resetDerivedFabricSliced: vi.fn(async () => ({ parcels: 0 })),
        _appliedCorridorTakes: vi.fn(() => []),
        _deriveCorridorFabric: vi.fn(async () => ({ parcels: 0, added: 0, removed: 0, unchanged: 0, failed: [] })),
        _reconcileStructurePresentation: vi.fn(),
        applyProposal: vi.fn(async (_id, options) => {
            applyOptions.push(options);
            // What a member's own apply does when presentation is NOT deferred.
            if (options.deferPresentation !== true) {
                context.afterCommit(() => {
                    globalThis.refreshParcelStylesForAppliedProposals();
                    globalThis.updateProposalList();
                    globalThis.updateShowProposalsButton();
                });
            }
            return true;
        })
    };
    return { manager, context, afterCommit, applyOptions, presentation };
}

describe('replay presentation', () => {
    it('rebuilds parcel-free geometry regardless of city text and scopes bound designs by cadastral references', async () => {
        const records = [
            { ...building(0), cadastreParcelIds: [], city: 'site-label', goal: 'park' },
            { ...building(1), cadastreParcelIds: [], city: 'same-source-city', goal: 'square' },
            { ...building(2), cadastreParcelIds: [], city: 'foreign-city', goal: 'lake' },
            { ...building(3), cadastreParcelIds: ['foreign-p1'], city: 'site-label' },
            { ...building(4), cadastreParcelIds: ['here-p1'], city: 'foreign-city' }
        ];
        installGlobal('isInCity', (id, city) => id.startsWith(city + '-'));
        const foreignCityFor = vi.fn(() => { throw new Error('Descriptive city labels must not gate replay'); });
        const CityConfigManager = { getCurrentCityId: () => 'here', foreignCityFor };
        installGlobal('CityConfigManager', CityConfigManager);
        installGlobal('window', { CityConfigManager });
        const { manager, context } = replayHarness(records);
        const result = await manager.rebuildAppliedFabric({ silent: true, _parcelMutation: context });
        expect(result.ok).toBe(true);
        expect(manager.applyProposal.mock.calls.map(([id]) => id)).toEqual(['b-0', 'b-1', 'b-2', 'b-4']);
        expect(foreignCityFor).not.toHaveBeenCalled();
        expect(records.every(record => record.applied)).toBe(true);
    });

    it('replays every member with deferPresentation and refreshes the UI once after commit', async () => {
        const records = [building(0), building(1), building(2), building(3)];
        const { manager, context, afterCommit, applyOptions, presentation } = replayHarness(records);

        const summary = await manager.rebuildAppliedFabric({ silent: true, _parcelMutation: context });
        expect(summary.ok).toBe(true);
        expect(applyOptions).toHaveLength(4);
        expect(applyOptions.every(options => options.deferPresentation === true)).toBe(true);

        for (const callback of afterCommit) await callback();
        expect(presentation.refreshParcelStylesForAppliedProposals).toHaveBeenCalledTimes(1);
        expect(presentation.updateProposalList).toHaveBeenCalledTimes(1);
        expect(presentation.updateShowProposalsButton).toHaveBeenCalledTimes(1);
        expect(presentation.refreshAppliedCorridorStripsSliced).toHaveBeenCalledTimes(1);
    });
});
