// The parcel menu (frontend/js/ui/parcel-menu-model.js + its UiCommands entries) and the end of the
// parcel click chain (frontend/js/parcels/ui/parcel-selection.js onParcelClick), which now opens the
// menu at the click point instead of the parcel panel (UI-REWORK.md, "Parcel interaction").
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
    can3d: true,
    ...overrides
});

describe('parcel menu actions', () => {
    it('offers every action, in menu order, for an ordinary parcel', () => {
        expect(Model.availableActions(baseFacts()))
            .toEqual(['propose', 'selectMore', 'details', 'history', 'tools', 'offer', 'view3d', 'detectBlock']);
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

    it('leaves View in 3D out when 3D is not available, and History out without a parcel uid', () => {
        expect(Model.availableActions(baseFacts({ can3d: false }))).not.toContain('view3d');
        expect(Model.availableActions(baseFacts({ can3d: undefined }))).not.toContain('view3d');
        expect(Model.availableActions(baseFacts({ historyIds: [] }))).not.toContain('history');
        expect(Model.availableActions(baseFacts({ historyIds: [null, ''] }))).not.toContain('history');
    });

    it('offers Compare proposals here only with two or more proposals on the parcel', () => {
        expect(Model.availableActions(baseFacts({ compareCount: 2 })))
            .toEqual(['propose', 'selectMore', 'details', 'history', 'compare', 'tools', 'offer', 'view3d', 'detectBlock']);
        expect(Model.availableActions(baseFacts({ compareCount: 1 }))).not.toContain('compare');
        expect(Model.availableActions(baseFacts({ compareCount: null }))).not.toContain('compare');
        // Open ground is no cadastral parcel: nothing to compare "on my parcel".
        expect(Model.availableActions(baseFacts({ compareCount: 3, isGround: true }))).not.toContain('compare');
    });

    it('does not offer Select more while multi-select is already on', () => {
        expect(Model.availableActions(baseFacts({ multiSelectActive: true, selectionCount: 3 }))).not.toContain('selectMore');
    });

    it('offers the land exactly when the build palette (and its Offer tool) renders', () => {
        expect(Model.buildPaletteAvailable({ parcelContextId: 'HR-1' })).toBe(true);
        expect(Model.buildPaletteAvailable({ multiSelectActive: true, selectionCount: 2 })).toBe(true);
        expect(Model.buildPaletteAvailable({ multiSelectActive: true, selectionCount: 0 })).toBe(false);
        expect(Model.buildPaletteAvailable({ multiSelectActive: false, selectionCount: 4 })).toBe(false);
        expect(Model.buildPaletteAvailable({ parcelContextId: null })).toBe(false);
        expect(Model.buildPaletteAvailable(undefined)).toBe(false);
        expect(Model.isActionAvailable('offer', baseFacts())).toBe(true);
        expect(Model.isActionAvailable('offer', baseFacts({ parcelId: undefined }))).toBe(false);
        expect(Model.isActionAvailable('no-such-action', baseFacts())).toBe(false);
    });

    it('renders the palette from the same predicate (no palette, no Offer)', () => {
        const source = readFileSync(new URL('../../frontend/js/parcels/ui/proposal-actions.js', import.meta.url), 'utf8');
        const render = (state) => {
            const container = { innerHTML: '' };
            const window = {
                document: { querySelector: () => null, getElementById: id => (id === 'parcel-proposal-primary-actions' ? container : null) },
                console,
                ParcelMenuModel: Model,
                ...state
            };
            window.window = window;
            vm.runInNewContext(source, { window, globalThis: window, document: window.document, console });
            window.renderParcelProposalActions();
            return container.innerHTML;
        };
        expect(render({ currentParcel: { id: 'HR-1' } })).toContain('parcel-build-btn--offer');
        expect(render({ currentParcel: null })).toBe('');
        expect(render({ multiParcelSelection: { isActive: true, selectedParcels: new Set() } })).toBe('');
        expect(render({ multiParcelSelection: { isActive: true, selectedParcels: new Set(['a', 'b']) } })).toContain('parcel-build-btn--offer');
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
        expect(Model.displayParcelId({ BROJ_CESTICE: 1234, MATICNI_BROJ_KO: '335550' }, 'live-7')).toBe('HR-335550-1234');
        expect(Model.displayParcelId({ broj_cestice: '12/3', cadastralMunicipality: { id: 335550 } }, 'x')).toBe('HR-335550-12/3');
        expect(Model.displayParcelId({ BROJ_CESTICE: 1234 }, 'live-7')).toBe('live-7');
        expect(Model.displayParcelId(null, null)).toBe('');
    });
});

describe('parcel menu placement', () => {
    const viewport = { width: 1000, height: 700 };
    const size = { width: 230, height: 300 };

    it('opens right of and below the click point', () => {
        expect(Model.placeMenuAtPoint({ x: 100, y: 100 }, size, viewport))
            .toEqual({ left: 110, top: 110, flippedX: false, flippedY: false });
    });

    it('flips left near the right edge and up near the bottom edge', () => {
        expect(Model.placeMenuAtPoint({ x: 900, y: 600 }, size, viewport))
            .toEqual({ left: 660, top: 290, flippedX: true, flippedY: true });
    });

    it('stays inside a container smaller than it would like', () => {
        const place = Model.placeMenuAtPoint({ x: 150, y: 120 }, size, { width: 300, height: 260 });
        expect(place.left).toBeGreaterThanOrEqual(8);
        expect(place.top).toBe(8);
        expect(place.left + size.width).toBeLessThanOrEqual(300 - 8 + 0.5);
    });
});

describe('parcel menu and selection tray commands', () => {
    const ctx = (extra = {}) => ({ global: {}, isControlAvailable: () => true, ...extra });

    it('are unavailable without a parcel or a selection (e.g. in the palette)', () => {
        const ids = UiCommands.commandsFor('palette', ctx()).map(c => c.id);
        expect(ids.filter(id => id.startsWith('parcel.') || id.startsWith('selection.'))).toEqual([]);
        expect(UiCommands.commandsFor('parcel-menu', ctx())).toEqual([]);
    });

    it('lists the parcel menu in menu order, following the model', () => {
        expect(UiCommands.commandsFor('parcel-menu', ctx({ parcel: baseFacts({ isRoad: true, can3d: false }) })).map(c => c.id))
            .toEqual(['parcel.propose', 'parcel.selectMore', 'parcel.details', 'parcel.history', 'parcel.tools', 'parcel.offer']);
        // The same commands appear in the palette once a parcel is in hand.
        expect(UiCommands.commandsFor('palette', ctx({ parcel: baseFacts() })).map(c => c.id)).toContain('parcel.view3d');
    });

    it('runs a parcel action through ParcelMenu with the parcel it was offered for', () => {
        const runAction = vi.fn();
        const facts = baseFacts();
        UiCommands.runCommand('parcel.propose', { global: { ParcelMenu: { runAction } }, parcel: facts });
        expect(runAction).toHaveBeenCalledWith('propose', facts);
        expect(() => UiCommands.runCommand('parcel.details', { global: {}, parcel: facts })).toThrow(/ParcelMenu/);
    });

    it('shows Done alone on an empty selection and every tray action once parcels are picked', () => {
        expect(UiCommands.commandsFor('selection-tray', ctx({ selection: { active: true, count: 0 } })).map(c => c.id))
            .toEqual(['selection.done']);
        expect(UiCommands.commandsFor('selection-tray', ctx({ selection: { active: true, count: 2 } })).map(c => c.id))
            .toEqual(['blocks.fromSelected', 'selection.propose', 'selection.clear', 'selection.done']);
        expect(UiCommands.commandsFor('selection-tray', ctx({ selection: { active: false, count: 0 } })).map(c => c.id))
            .toEqual(['blocks.fromSelected']);
    });

    it('runs the tray actions on the existing selection functions', () => {
        const clearSelection = vi.fn();
        const cancelMultiParcelSelection = vi.fn();
        const propose = vi.fn();
        const global = { multiParcelSelection: { clearSelection }, cancelMultiParcelSelection, SelectionTray: { propose } };
        UiCommands.runCommand('selection.clear', { global });
        UiCommands.runCommand('selection.done', { global });
        UiCommands.runCommand('selection.propose', { global });
        expect(clearSelection).toHaveBeenCalledOnce();
        expect(cancelMultiParcelSelection).toHaveBeenCalledOnce();
        expect(propose).toHaveBeenCalledOnce();
    });
});

// Characterization of the end of onParcelClick: a fake page around the real function, every
// collaborator a spy, asserting what it calls and what state it leaves.
function loadClickChain({ multiActive = false, panelOpen = false, appliedProposal = null } = {}) {
    const panelClasses = new Set(panelOpen ? ['visible'] : []);
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
        clearSelection: vi.fn(() => { panelClasses.delete('visible'); }), // its updateUI hides the panel
        clearSingleParcelSelection: vi.fn(),
        toggle: vi.fn(function () { this.isActive = !this.isActive; }),
        toggleParcel: vi.fn(() => true)
    };
    const showParcelInfoPanel = vi.fn(() => panelClasses.add('visible'));
    const open = vi.fn();
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
        ParcelMenu: { open },
        multiParcelSelection: multi,
        isRoadParcel: () => false,
        map: { hasLayer: () => false },
        selectedParcelStyle,
        proposalStorage: { getProposalsForParcel: () => (appliedProposal ? [appliedProposal] : []) },
        isProposalApplied: proposal => proposal === appliedProposal,
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
    return { context, multi, layer, feature, open, showParcelInfoPanel, stopPropagation, selectedParcelStyle, panelClasses, click };
}

describe('the parcel click chain ends in the parcel menu', () => {
    it('opens the menu at the click point — not the panel — and selects the parcel as before', () => {
        const h = loadClickChain();
        const event = h.click();
        expect(h.open).toHaveBeenCalledOnce();
        expect(h.open).toHaveBeenCalledWith({ parcelId: 'HR-335550-1234', feature: h.feature, layer: h.layer, latlng: event.latlng });
        expect(h.showParcelInfoPanel).not.toHaveBeenCalled();
        expect(h.panelClasses.has('visible')).toBe(false);
        expect(h.context.selectedParcelId).toBe('HR-335550-1234');
        expect(h.context.currentParcel).toEqual({ id: 'HR-335550-1234', layer: h.layer, isRoad: false });
        expect(h.layer.setStyle).toHaveBeenCalledWith(h.selectedParcelStyle);
        expect(h.multi.clearSelection).toHaveBeenCalledOnce();
        expect(h.stopPropagation).toHaveBeenCalledWith(event);
    });

    it('toggles the parcel in multi-select without opening the menu', () => {
        const h = loadClickChain({ multiActive: true });
        h.click();
        expect(h.multi.toggleParcel).toHaveBeenCalledWith(h.layer);
        expect(h.open).not.toHaveBeenCalled();
        expect(h.context.selectedParcelId).toBeUndefined();
    });

    it('enters multi-select on Shift+click, seeded with the current parcel, without the menu', () => {
        const h = loadClickChain();
        h.click(true);
        expect(h.multi.toggle).toHaveBeenCalledWith({ preserveSelectedParcel: true });
        expect(h.multi.toggleParcel).toHaveBeenCalledWith(h.layer);
        expect(h.open).not.toHaveBeenCalled();
    });

    it('keeps an already open parcel panel as the inspector and moves it to the clicked parcel', () => {
        const h = loadClickChain({ panelOpen: true });
        h.click();
        expect(h.showParcelInfoPanel).toHaveBeenCalledWith(h.feature);
        expect(h.panelClasses.has('visible')).toBe(true);
        expect(h.open).not.toHaveBeenCalled();
        expect(h.context.selectedParcelId).toBe('HR-335550-1234');
    });

    it('answers a parcel under an applied proposal with that proposal, as before', () => {
        const applied = { proposalId: 'p-7' };
        const h = loadClickChain({ appliedProposal: applied });
        h.click();
        expect(h.context.selectAndHighlightProposal).toHaveBeenCalledWith('p-7', 'HR-335550-1234', false, true);
        expect(h.multi.clearSingleParcelSelection).toHaveBeenCalledOnce();
        expect(h.open).not.toHaveBeenCalled();
    });
});
