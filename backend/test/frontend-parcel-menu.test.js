// The parcel menu's actions and facts (frontend/js/ui/parcel-menu-model.js + its UiCommands entries),
// shown in the click stack's parcel section since the popover was removed (click-stack.md), and the
// parcel click chain (frontend/js/parcels/ui/parcel-selection.js): onParcelClick keeps its gates and
// hands an ordinary click to ClickStack.handleClick; selectParcelFromStack selects the parcel and
// opens its panel when the stack's parcel section expands.
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const Model = require('../../frontend/js/ui/parcel-menu-model.js');
const UiCommands = require('../../frontend/js/ui/commands.js');

const parcelSelectionSource = readFileSync(
    new URL('../../frontend/js/parcels/ui/parcel-selection.js', import.meta.url), 'utf8');

const baseFacts = (overrides = {}) => ({
    parcelId: 'HR-335550-1234',
    isRoad: false,
    multiSelectActive: false,
    selectionCount: 0,
    historyIds: ['HR-335550-1234'],
    blocksEnabled: true,
    ...overrides
});

describe('parcel menu actions', () => {
    it('offers every action, in menu order, for an ordinary parcel', () => {
        expect(Model.availableActions(baseFacts()))
            .toEqual(['propose', 'selectMore', 'details', 'proposals', 'history', 'tools', 'detectBlock']);
    });

    it('offers nothing without a parcel', () => {
        expect(Model.availableActions(baseFacts({ parcelId: null }))).toEqual([]);
        expect(Model.availableActions(baseFacts({ parcelId: '' }))).toEqual([]);
        expect(Model.availableActions(null)).toEqual([]);
    });

    it('does not grow a block from a road parcel, nor in a city without blocks', () => {
        expect(Model.availableActions(baseFacts({ isRoad: true }))).not.toContain('detectBlock');
        expect(Model.availableActions(baseFacts({ isRoad: true }))).toContain('propose');
        expect(Model.availableActions(baseFacts({ blocksEnabled: false }))).not.toContain('detectBlock');
        expect(Model.availableActions(baseFacts({ blocksEnabled: undefined }))).not.toContain('detectBlock');
    });

    it('does not duplicate the mode buttons, and leaves History out without a parcel uid', () => {
        expect(Model.availableActions(baseFacts({ can3d: true }))).not.toContain('view3d');
        expect(Model.availableActions(baseFacts({ historyIds: [] }))).not.toContain('history');
        expect(Model.availableActions(baseFacts({ historyIds: [null, ''] }))).not.toContain('history');
    });

    it('offers Compare proposals here only with two or more proposals on the parcel', () => {
        expect(Model.availableActions(baseFacts({ compareCount: 2 })))
            .toEqual(['propose', 'selectMore', 'details', 'proposals', 'history', 'compare', 'tools', 'detectBlock']);
        expect(Model.availableActions(baseFacts({ compareCount: 1 }))).not.toContain('compare');
        expect(Model.availableActions(baseFacts({ compareCount: null }))).not.toContain('compare');
        // Open ground is no cadastral parcel: nothing to compare "on my parcel".
        expect(Model.availableActions(baseFacts({ compareCount: 3, isGround: true }))).not.toContain('compare');
    });

    it('does not offer Select more while multi-select is already on', () => {
        expect(Model.availableActions(baseFacts({ multiSelectActive: true, selectionCount: 3 }))).not.toContain('selectMore');
    });

    it('has a build palette exactly when there is a parcel context, and no Offer action (M2: owner offers are gone)', () => {
        expect(Model.buildPaletteAvailable({ parcelContextId: 'HR-1' })).toBe(true);
        expect(Model.buildPaletteAvailable({ multiSelectActive: true, selectionCount: 2 })).toBe(true);
        expect(Model.buildPaletteAvailable({ multiSelectActive: true, selectionCount: 0 })).toBe(false);
        expect(Model.buildPaletteAvailable({ multiSelectActive: false, selectionCount: 4 })).toBe(false);
        expect(Model.buildPaletteAvailable({ parcelContextId: null })).toBe(false);
        expect(Model.buildPaletteAvailable(undefined)).toBe(false);
        expect(Model.ACTIONS).not.toContain('offer');
        expect(Model.isActionAvailable('offer', baseFacts())).toBe(false);
        expect(Model.isActionAvailable('no-such-action', baseFacts())).toBe(false);
    });

    it('renders the palette from the same predicate, with no Offer tile', () => {
        const source = readFileSync(new URL('../../frontend/js/parcels/ui/proposal-actions.js', import.meta.url), 'utf8');
        const render = (state) => {
            const container = { innerHTML: '' };
            const liveIds = state.liveParcelIds ? new Set(state.liveParcelIds) : null;
            const window = {
                document: { querySelector: () => null, getElementById: id => (id === 'parcel-proposal-primary-actions' ? container : null) },
                console,
                ParcelMenuModel: Model,
                LiveParcelFabric: { get: id => (!liveIds || liveIds.has(String(id)) ? { id: String(id) } : null) },
                ...state
            };
            window.window = window;
            vm.runInNewContext(source, { window, globalThis: window, document: window.document, console });
            window.renderParcelProposalActions();
            return container.innerHTML;
        };
        const single = render({ currentParcel: { id: 'HR-1' } });
        expect(single).toContain('parcel-build-btn--park');
        expect(single).toContain('parcel-build-btn--parcel-layout');
        expect(single).not.toContain('parcel-build-btn--offer');
        expect(render({ currentParcel: null })).toBe('');
        expect(render({ multiParcelSelection: { isActive: true, selectedParcels: new Set() } })).toBe('');
        const multi = render({ multiParcelSelection: { isActive: true, selectedParcels: new Set(['a', 'b']) } });
        expect(multi).toContain('parcel-build-btn--park');
        expect(multi).not.toContain('parcel-build-btn--offer');
        expect(render({ multiParcelSelection: { isActive: false, selectedParcels: new Set(['a', 'b']) } }))
            .toContain('parcel-build-btn--park');
    });

    it('renders for valid selected parcels even when currentParcel is stale', () => {
        const source = readFileSync(new URL('../../frontend/js/parcels/ui/proposal-actions.js', import.meta.url), 'utf8');
        const container = { innerHTML: '' };
        const calls = [];
        const window = {
            document: { querySelector: () => null, getElementById: id => (id === 'parcel-proposal-primary-actions' ? container : null) },
            console,
            ParcelMenuModel: Model,
            currentParcel: { id: 'consumed-source' },
            multiParcelSelection: { isActive: true, selectedParcels: new Set(['live-a', 'live-b']) },
            LiveParcelFabric: { get: id => { calls.push(String(id)); return ['live-a', 'live-b'].includes(String(id)) ? { id: String(id) } : null; } }
        };
        window.window = window;
        vm.runInNewContext(source, { window, globalThis: window, document: window.document, console });
        window.renderParcelProposalActions();
        expect(container.innerHTML).toContain('parcel-build-btn--park');
        expect(container.innerHTML).not.toContain('data-parcel-build-state');
        expect(calls).toEqual(['live-a', 'live-b']);
    });
});

describe('parcel build target ids', () => {
    it('prefers selected live parcels to a stale current parcel', () => {
        expect(Model.buildTargetIds({ parcelId: 'consumed-source', selectionIds: ['live-a', 'live-b'] }))
            .toEqual(['live-a', 'live-b']);
    });

    it('uses an explicit parcel override alone, even with another selection', () => {
        expect(Model.buildTargetIds({ parcelId: 'current', parcelIdOverride: 'exact-source', selectionIds: ['live-a', 'live-b'] }))
            .toEqual(['exact-source']);
    });

    it('does not fall back to currentParcel while manually selecting an empty set', () => {
        expect(Model.buildTargetIds({ parcelId: 'consumed-source', selectionIds: [], selecting: true })).toEqual([]);
    });

    it('uses the current parcel only when there is no override or active selection', () => {
        expect(Model.buildTargetIds({ parcelId: 'current' })).toEqual(['current']);
        expect(Model.buildTargetIds({})).toEqual([]);
    });
});

describe('parcel menu facts', () => {
    it('takes the stated area first, then the measured one, and never invents zero', () => {
        expect(Model.parcelArea({ area: 812.4 }, 900)).toBe(812.4);
        expect(Model.parcelArea({ calculatedArea: '1234.5' }, null)).toBe(1234.5);
        expect(Model.parcelArea({ informationTechnical: { superficie_total: 77 } })).toBe(77);
        expect(Model.parcelArea({ area: '0' }, 640)).toBe(640);
        expect(Model.parcelArea({ area: '' }, 640)).toBe(640);
        expect(Model.parcelArea({ area: null }, null)).toBeNull();
        expect(Model.parcelArea({}, NaN)).toBeNull();
        expect(Model.parcelArea(null, -5)).toBeNull();
        expect(Model.parcelArea(undefined, undefined)).toBeNull();
    });

    it('reports owner type and count only from what is loaded', () => {
        const classify = label => (/grad|republika/i.test(label) ? 'government' : 'individual');
        expect(Model.ownershipFacts({ owners: [{ ownerLabel: 'Grad Zagreb' }, { name: 'Republika Hrvatska' }], classify }))
            .toEqual({ ownershipType: 'government', ownerCount: 2 });
        expect(Model.ownershipFacts({ owners: [{ ownerLabel: 'Grad Zagreb' }, { name: 'Ana' }], classify }))
            .toEqual({ ownershipType: 'mixed', ownerCount: 2 });
        expect(Model.ownershipFacts({ ownershipType: 'Company', owners: [] })).toEqual({ ownershipType: 'company', ownerCount: null });
        expect(Model.ownershipFacts({ ownershipType: 'private' }).ownershipType).toBe('individual');
        expect(Model.ownershipFacts({ ownershipSummary: { government: true, company: true } }).ownershipType).toBe('mixed');
        expect(Model.ownershipFacts({ ownershipType: 'nonsense' })).toEqual({ ownershipType: null, ownerCount: null });
        // Owners without a classifier: the count is known, the type is not.
        expect(Model.ownershipFacts({ owners: ['a', 'b', 'c'] })).toEqual({ ownershipType: null, ownerCount: 3 });
        expect(Model.ownershipFacts()).toEqual({ ownershipType: null, ownerCount: null });
    });

    it('shows the id the parcel panel title shows', () => {
        expect(Model.displayParcelId({ BROJ_CESTICE: 1234, MATICNI_BROJ_KO: '335550' }, 'live-7')).toBe('live-7');
        expect(Model.displayParcelId({ broj_cestice: '12/3', cadastralMunicipality: { id: 335550 } }, null)).toBe('HR-335550-12/3');
        expect(Model.displayParcelId({ BROJ_CESTICE: 1234 }, 'live-7')).toBe('live-7');
        expect(Model.displayParcelId(null, null)).toBe('');
    });
});

describe('parcel identity presentation', () => {
    it.each([
        [{ cadastreParcelIds: ['opaque#source'] }, 'opaque#source', 'source'],
        [{ estimated: true, cadastreParcelIds: ['EST-1'] }, 'EST-1', 'estimated'],
        [{ cadastralPart: true, cadastreParcelIds: ['source'] }, 'component', 'sourcePart'],
        [{ producedByProposalId: 'design', cadastralPart: true }, 'piece', 'formed'],
        [{ producedByProposalId: 'design', readjustmentPiece: { role: 'plot', plotFingerprint: 'plot-a' } }, 'piece', 'plotPiece'],
        [{ producedByProposalId: 'design', readjustmentPiece: { role: 'remainder' } }, 'piece', 'remainder'],
        [{ liveParcelDerivation: 'corridor-arrangement' }, 'remainder', 'formed'],
        [{ cadastreParcelIds: ['source'] }, 'slice', 'formed'],
        [{ formedByProposalIds: ['design'] }, 'piece', 'formed'],
        [{ isProposed: true }, 'opaque#not-evidence', 'unknown']
    ])('classifies provenance %j with id %s as %s', (props, id, expected) => {
        expect(Model.parcelIdentityKind(props, id)).toBe(expected);
    });

    it('does not display a formed piece using its source geometry reference', () => {
        expect(Model.displayParcelId({
            producedByProposalId: 'design', parcelIdentityKind: 'geometry-sha256-v1', geometryDisplayId: 'G1-source'
        }, 'piece')).toBe('piece');
        expect(Model.displayParcelId({
            producedByProposalId: 'design', readjustmentPiece: { role: 'plot', plotFingerprint: 'plot-a' },
            parcelIdentityKind: 'geometry-sha256-v1', geometryDisplayId: 'G1-source'
        }, 'plot-piece')).toBe('plot-piece');
        expect(Model.displayParcelId({
            estimated:true, parcelIdentityKind:'geometry-sha256-v1', geometryDisplayId:'EST-short'
        }, 'EST-long-hash')).toBe('EST-short');
        expect(Model.parcelIdentityTitle('estimated').fallback).toBe('Estimated parcel {{number}}');
    });
});

describe('parcel menu and parcel selection commands', () => {
    const ctx = (extra = {}) => ({ global: {}, isControlAvailable: () => true, ...extra });

    it('are unavailable without a parcel or a selection (e.g. in the palette)', () => {
        const ids = UiCommands.commandsFor('palette', ctx()).map(c => c.id);
        expect(ids.filter(id => id.startsWith('parcel.') || id.startsWith('selection.'))).toEqual([]);
        expect(UiCommands.commandsFor('parcel-menu', ctx())).toEqual([]);
    });

    it('shows in the parcel section only what the hosted parcel panel does not offer; the rest stays in the palette', () => {
        const parcel = baseFacts({ compareCount: 2, siteToolAvailable: true });
        expect(UiCommands.commandsFor('parcel-menu', ctx({ parcel })).map(c => c.id))
            .toEqual(['parcel.compare', 'parcel.useAsSite']);
        expect(UiCommands.commandsFor('parcel-menu', ctx({ parcel: baseFacts({ isRoad: true, can3d: false }) }))).toEqual([]);
        expect(UiCommands.commandsFor('palette', ctx({ parcel })).map(c => c.id)).toEqual(expect.arrayContaining([
            'parcel.propose', 'parcel.selectMore', 'parcel.details', 'parcel.proposals', 'parcel.history', 'parcel.tools', 'parcel.detectBlock']));
        // The same commands appear in the palette once a parcel is in hand.
        expect(UiCommands.commandsFor('palette', ctx({ parcel: baseFacts() })).map(c => c.id)).not.toContain('parcel.view3d');
    });

    it('runs a parcel action through ParcelMenu with the parcel it was offered for', () => {
        const runAction = vi.fn();
        const facts = baseFacts();
        UiCommands.runCommand('parcel.propose', { global: { ParcelMenu: { runAction } }, parcel: facts });
        expect(runAction).toHaveBeenCalledWith('propose', facts);
        expect(() => UiCommands.runCommand('parcel.details', { global: {}, parcel: facts })).toThrow(/ParcelMenu/);
    });

    it('shows only Done for an empty selection and selection commands for picked parcels', () => {
        const selectionContext = ctx({ global: { SiteTool: { isActive: () => false } } });
        expect(UiCommands.findCommand('selection.useAsSite')).toMatchObject({ labelKey: 'parcelMenu.actions.useAsSite', fallbackLabel: 'Custom site' });
        expect(UiCommands.commandsFor('parcel-selection', { ...selectionContext, selection: { active: true, count: 0 } }).map(c => c.id))
            .toEqual(['selection.done']);
        expect(UiCommands.commandsFor('parcel-selection', { ...selectionContext, selection: { active: true, count: 2 } }).map(c => c.id))
            .toEqual(['selection.useAsSite', 'selection.clear', 'selection.done']);
        expect(UiCommands.commandsFor('parcel-selection', { ...selectionContext, selection: { active: false, count: 2 } }).map(c => c.id))
            .toEqual(['selection.useAsSite', 'selection.clear']);
        expect(UiCommands.commandsFor('parcel-selection', { ...selectionContext, selection: { active: false, count: 0 } }).map(c => c.id))
            .toEqual([]);
        expect(UiCommands.commandsFor('layers', { ...selectionContext, selection: { active: true, count: 2 } }).map(c => c.id))
            .toContain('blocks.fromSelected');
    });

    it('runs selection commands on the existing selection functions', () => {
        const selectedParcels = new Set(['parcel-1']);
        const clearSelection = vi.fn(() => selectedParcels.clear());
        const finish = vi.fn();
        const startFromSelection = vi.fn();
        const global = {
            document: { body: { classList: { contains: () => false } }, getElementById: () => null, querySelectorAll: () => [] },
            multiParcelSelection: { isActive: true, selectedParcels, clearSelection, finish },
            SiteTool: { isActive: () => false, startFromSelection }
        };
        const context = UiCommands.createBrowserContext(global, { mode: '2d' });

        UiCommands.runCommand('selection.useAsSite', context);
        UiCommands.runCommand('selection.clear', context);
        UiCommands.runCommand('selection.done', context);
        expect(clearSelection).toHaveBeenCalledOnce();
        expect(finish).toHaveBeenCalledOnce();
        expect(startFromSelection).toHaveBeenCalledOnce();

        expect(UiCommands.runCommand('selection.clear', context)).toBe(false);
        expect(UiCommands.runCommand('selection.useAsSite', context)).toBe(false);
        expect(clearSelection).toHaveBeenCalledOnce();
        expect(startFromSelection).toHaveBeenCalledOnce();
    });
});

// Characterization of onParcelClick and selectParcelFromStack: a fake page around the real
// functions, every collaborator a spy, asserting what they call and what state they leave.
function loadClickChain({ multiActive = false } = {}) {
    const panelClasses = new Set();
    const parcelPanel = {
        classList: {
            contains: name => panelClasses.has(name),
            add: name => panelClasses.add(name),
            remove: name => panelClasses.delete(name)
        }
    };
    const multi = {
        isActive: multiActive,
        selectedParcels: new Set(),
        clearSelection: vi.fn(),
        clearSingleParcelSelection: vi.fn(),
        toggle: vi.fn(function () { this.isActive = !this.isActive; }),
        toggleParcel: vi.fn(() => true)
    };
    const showParcelInfoPanel = vi.fn(() => panelClasses.add('visible'));
    const handleClick = vi.fn(() => true);
    const stopPropagation = vi.fn();
    const selectedParcelStyle = { color: 'blue', weight: 3 };
    const context = {
        console,
        document: {
            addEventListener: vi.fn(),
            getElementById: id => (id === 'parcel-info-panel' ? parcelPanel : null),
            querySelector: () => null
        },
        ParcelsUIParcelPanel: { showParcelInfoPanel },
        ClickStack: { handleClick },
        multiParcelSelection: multi,
        isRoadParcel: () => false,
        map: { hasLayer: () => false },
        selectedParcelStyle,
        proposalStorage: { getProposalsForParcel: () => [] },
        selectAndHighlightProposal: vi.fn(),
        L: { DomEvent: { stopPropagation } }
    };
    context.window = context;
    vm.runInNewContext(parcelSelectionSource, context);

    const feature = { type: 'Feature', properties: { parcelId: 'HR-335550-1234' }, geometry: { type: 'Polygon', coordinates: [] } };
    const layer = { feature, setStyle: vi.fn(), bringToFront: vi.fn() };
    context.LiveParcelFabric = { get: id => (String(id) === 'HR-335550-1234' ? feature : null) };
    context.ParcelPresenter = {
        getLayer: id => (String(id) === 'HR-335550-1234' ? layer : null),
        getIdForLayer: candidate => (candidate === layer ? 'HR-335550-1234' : null)
    };
    const click = (shiftKey = false) => {
        const event = { target: layer, latlng: { lat: 45.8, lng: 15.97 }, originalEvent: { shiftKey } };
        context.onParcelClick(event);
        return event;
    };
    return { context, multi, layer, feature, handleClick, showParcelInfoPanel, stopPropagation, selectedParcelStyle, panelClasses, click };
}

describe('the parcel click chain ends in the click stack', () => {
    it('hands an ordinary click to the click stack and selects nothing until its parcel section expands', () => {
        const h = loadClickChain();
        const event = h.click();
        expect(h.handleClick).toHaveBeenCalledOnce();
        expect(h.handleClick).toHaveBeenCalledWith(event.latlng);
        expect(h.stopPropagation).toHaveBeenCalledWith(event);
        expect(h.showParcelInfoPanel).not.toHaveBeenCalled();
        expect(h.context.selectedParcelId).toBeUndefined();
        expect(h.layer.setStyle).not.toHaveBeenCalled();
        expect(h.multi.clearSelection).not.toHaveBeenCalled();
        // An applied proposal on the parcel is the stack's Designs section now, not a second selection.
        expect(h.context.selectAndHighlightProposal).not.toHaveBeenCalled();
    });

    it('delegates a multi-select click to the selection section', () => {
        const h = loadClickChain({ multiActive: true });
        h.click();
        expect(h.multi.toggleParcel).not.toHaveBeenCalled();
        expect(h.handleClick).toHaveBeenCalledWith({ lat: 45.8, lng: 15.97 });
        expect(h.context.selectedParcelId).toBeUndefined();
    });

    it('enters multi-select on Shift+click and delegates the added parcel to the selection section', () => {
        const h = loadClickChain();
        h.click(true);
        expect(h.multi.toggle).toHaveBeenCalledWith();
        expect(h.multi.toggleParcel).not.toHaveBeenCalled();
        expect(h.handleClick).toHaveBeenCalledWith({ lat: 45.8, lng: 15.97 });
    });

    it('stays out of a tool that owns map clicks', () => {
        const h = loadClickChain();
        h.context.measureMode = true;
        h.click();
        expect(h.handleClick).not.toHaveBeenCalled();
        expect(h.stopPropagation).not.toHaveBeenCalled();
    });

    it('selects the parcel and opens its panel when the stack\'s parcel section expands', () => {
        const h = loadClickChain();
        expect(h.context.ParcelsUISelection.selectParcelFromStack('HR-335550-1234')).toBe(true);
        expect(h.context.selectedParcelId).toBe('HR-335550-1234');
        expect(h.context.currentParcel).toEqual({ id: 'HR-335550-1234', layer: h.layer, isRoad: false });
        expect(h.layer.setStyle).toHaveBeenCalledWith(h.selectedParcelStyle);
        expect(h.layer.bringToFront).toHaveBeenCalledOnce();
        expect(h.showParcelInfoPanel).toHaveBeenCalledWith(h.feature);
        expect(h.panelClasses.has('visible')).toBe(true);
        // A parcel no longer on the map: nothing to select.
        expect(h.context.ParcelsUISelection.selectParcelFromStack('gone')).toBe(false);
        expect(h.showParcelInfoPanel).toHaveBeenCalledOnce();
    });

    it('restores the previously selected parcel\'s style when another one is selected from the stack', () => {
        const h = loadClickChain();
        const previous = { setStyle: vi.fn() };
        h.context.selectedParcelId = 'HR-335550-9';
        h.context.currentParcel = { id: 'HR-335550-9', layer: previous };
        h.context.restoreParcelLayerStyle = vi.fn();
        h.context.ParcelsUISelection.selectParcelFromStack('HR-335550-1234');
        expect(h.context.restoreParcelLayerStyle).toHaveBeenCalledWith(previous);
        expect(h.context.selectedParcelId).toBe('HR-335550-1234');
    });
});

describe('parcel history ids (the menu\'s History and the parcel panel\'s History section)', () => {
    it('uses the explicit cadastral sources, falls back to the parcel id, and gives open ground none', () => {
        expect(Model.parcelHistoryIds({ parcelId: 'live-1', cadastreIds: ['HR-1', 'HR-2'], groundIds: [] }))
            .toEqual({ historyIds: ['HR-1', 'HR-2'], isGround: false });
        expect(Model.parcelHistoryIds({ parcelId: 'HR-3', cadastreIds: [], groundIds: [] }))
            .toEqual({ historyIds: ['HR-3'], isGround: false });
        expect(Model.parcelHistoryIds({ parcelId: 'ground:abc', cadastreIds: [], groundIds: ['ground:abc'] }))
            .toEqual({ historyIds: [], isGround: true });
    });
});
