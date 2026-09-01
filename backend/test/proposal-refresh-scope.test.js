import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ProposalManager } = require('../../frontend/js/proposal-manager.js');

const previous = new Map();
function install(name, value) {
    if (!previous.has(name)) {
        previous.set(name, {
            existed: Object.prototype.hasOwnProperty.call(globalThis, name),
            value: globalThis[name]
        });
    }
    globalThis[name] = value;
}

function presentationSpies() {
    const names = [
        'scheduleCorridorStripRefresh', 'refreshParcelStylesForAppliedProposals',
        'updateProposalLayer', 'updateProposalList', 'updateShowProposalsButton',
        'syncProposalsIndicator', 'updateParksLayer', 'updateLakesLayer',
        'updateSquaresLayer', 'updateTransitStationsLayer', 'updateProposedBuildingsLayer',
        'updateReparcellizationLayers'
    ];
    const spies = Object.fromEntries(names.map(name => [name, vi.fn()]));
    Object.entries(spies).forEach(([name, fn]) => install(name, fn));
    install('window', {});
    install('document', { querySelector: () => null });
    return spies;
}

afterEach(() => {
    for (const [name, saved] of previous) {
        if (saved.existed) globalThis[name] = saved.value;
        else delete globalThis[name];
    }
    previous.clear();
    vi.restoreAllMocks();
});

describe('proposal presentation refresh scope', () => {
    it('refreshes a building without scheduling a global corridor rebuild', () => {
        const spies = presentationSpies();

        ProposalManager._refreshUIAfterProposalChange({ proposalId: 'block', goal: 'buildings' });

        expect(spies.updateProposedBuildingsLayer).toHaveBeenCalledOnce();
        expect(spies.scheduleCorridorStripRefresh).not.toHaveBeenCalled();
        expect(spies.updateParksLayer).not.toHaveBeenCalled();
        expect(spies.updateReparcellizationLayers).not.toHaveBeenCalled();
    });

    it('refreshes only the changed structure kind', () => {
        const spies = presentationSpies();

        ProposalManager._refreshUIAfterProposalChange({ proposalId: 'park', goal: 'park' });

        expect(spies.updateParksLayer).toHaveBeenCalledOnce();
        expect(spies.updateLakesLayer).not.toHaveBeenCalled();
        expect(spies.updateSquaresLayer).not.toHaveBeenCalled();
        expect(spies.scheduleCorridorStripRefresh).not.toHaveBeenCalled();
    });

    it('rebuilds corridor presentation only for a road or track', () => {
        const spies = presentationSpies();

        ProposalManager._refreshUIAfterProposalChange({ proposalId: 'road', goal: 'road-track' });

        expect(spies.scheduleCorridorStripRefresh).toHaveBeenCalledOnce();
        expect(spies.updateProposedBuildingsLayer).not.toHaveBeenCalled();
        expect(spies.updateParksLayer).not.toHaveBeenCalled();
    });
});
