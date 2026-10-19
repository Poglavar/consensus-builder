// A selected road's actions (frontend/js/proposals/road-actions-model.js + road-actions.js + the
// `road.*` UiCommands entries): Edit cross-section applies to an applied road that carries a lane
// cross-section — published or not, as the node handles do — never to a designation, an unapplied
// road, or while a corridor is being drawn; the palette offers it only for the selected road, and
// running it opens the cross-section editor on that road.
import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Model = require('../../frontend/js/proposals/road-actions-model.js');
const UiCommands = require('../../frontend/js/ui/commands.js');

const road = extra => ({ proposalKey: 'p-road', hasEditableCorridor: true, applied: true, drawing: false, ...extra });

describe('road action availability', () => {
    it('offers Edit cross-section on an applied road with a cross-section', () => {
        expect(Model.availableActions(road())).toEqual(['crossSection']);
    });

    it('does not offer it on a designation, an unapplied road, while drawing, or without a key', () => {
        expect(Model.isActionAvailable('crossSection', road({ hasEditableCorridor: false }))).toBe(false);
        expect(Model.isActionAvailable('crossSection', road({ applied: false }))).toBe(false);
        expect(Model.isActionAvailable('crossSection', road({ drawing: true }))).toBe(false);
        expect(Model.isActionAvailable('crossSection', road({ proposalKey: '' }))).toBe(false);
        expect(Model.isActionAvailable('crossSection', road({ proposalKey: null }))).toBe(false);
    });

    it('treats missing facts as unavailable, and unknown actions as unavailable', () => {
        expect(Model.availableActions({ proposalKey: 'p-road' })).toEqual([]);
        expect(Model.availableActions(null)).toEqual([]);
        expect(Model.isActionAvailable('bulldoze', road())).toBe(false);
    });
});

describe('RoadActions (browser half) on a fake page', () => {
    const store = new Map();
    const win = {
        RoadActionsModel: Model,
        roadDrawingMode: false,
        getProposalByIdOrHash: key => store.get(String(key)) || null,
        getProposalKey: proposal => proposal.proposalId,
        proposalHasEditableCorridor: proposal => !!proposal.roadProposal?.definition?.profile,
        isProposalApplied: proposal => proposal.applied === true,
        ProposalSelection: { getKey: () => null },
        openCorridorProfileEditor: vi.fn()
    };
    let RoadActions;

    beforeAll(() => {
        globalThis.window = win;
        require('../../frontend/js/proposals/road-actions.js');
        RoadActions = win.RoadActions;
        delete globalThis.window;
    });
    afterAll(() => { delete globalThis.window; });

    // A road that was published: it still carries its server/chain pointers.
    store.set('p-pub', { proposalId: 'p-pub', applied: true, serverProposalId: 42, tokenId: '7', roadProposal: { definition: { profile: { strips: [] } } } });
    store.set('p-designation', { proposalId: 'p-designation', applied: true, roadProposal: { definition: {} } });

    it('reads the facts of a published road and opens the editor on it', () => {
        const facts = RoadActions.factsFor('p-pub');
        expect(facts).toEqual({ proposalKey: 'p-pub', hasEditableCorridor: true, applied: true, drawing: false });
        RoadActions.runAction('crossSection', facts);
        expect(win.openCorridorProfileEditor).toHaveBeenCalledWith('p-pub');
    });

    it('refuses a designation instead of opening an editor with nothing to edit', () => {
        win.openCorridorProfileEditor.mockClear();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        RoadActions.runAction('crossSection', RoadActions.factsFor('p-designation'));
        expect(win.openCorridorProfileEditor).not.toHaveBeenCalled();
        warn.mockRestore();
    });

    it('takes the selected proposal as the palette context', () => {
        expect(RoadActions.contextFacts()).toBeNull();
        win.ProposalSelection.getKey = () => 'p-pub';
        expect(RoadActions.contextFacts().proposalKey).toBe('p-pub');
        win.ProposalSelection.getKey = () => null;
    });

    it('lets the details panel pass a fact it already knows', () => {
        expect(RoadActions.factsFor('p-pub', { applied: false }).applied).toBe(false);
    });
});

describe('road commands in the palette', () => {
    const ctx = (extra = {}) => ({ global: {}, isControlAvailable: () => true, ...extra });

    it('is a palette command, available only with an eligible selected road', () => {
        const entry = UiCommands.findCommand('road.crossSection');
        expect(entry.surfaces).toEqual(['palette']);
        expect(entry.labelKey).toBe('panel.road.crossSectionButton');
        expect(UiCommands.searchCommands('cross-section', ctx({ road: road() })).map(e => e.id)).toContain('road.crossSection');
        expect(UiCommands.searchCommands('cross-section', ctx({ road: road({ applied: false }) })).map(e => e.id)).not.toContain('road.crossSection');
        expect(UiCommands.searchCommands('cross-section', ctx()).map(e => e.id)).not.toContain('road.crossSection');
    });

    it('runs through RoadActions.runAction with the selected road', () => {
        const runAction = vi.fn();
        const facts = road();
        UiCommands.runCommand('road.crossSection', ctx({ road: facts, global: { RoadActions: { runAction } } }));
        expect(runAction).toHaveBeenCalledWith('crossSection', facts);
    });
});
