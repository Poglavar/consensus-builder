// The drill's click entry points after the click stack replaced its panel (click-stack.md): every
// surface that used to open the drill panel (parcels, structures, corridors, the map background)
// now hands its click to ClickStack.handleClick, and the drill keeps only stackAt and hover. The
// drill panel beside the planning inspector is gone; the inspector is hosted by the click stack
// (click-stack-panel.test.js).
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../frontend/js/proposals/drill-ui.js', import.meta.url), 'utf8');

function loadDrill({ blocked = false, pickActive = false } = {}) {
    const mapHandlers = {};
    const feature = { type: 'Feature', properties: { parcelId: 'P-1' }, geometry: { type: 'Polygon', coordinates: [] } };
    const proposal = { kind: 'proposal', key: 'proposal-1', proposal: { proposalId: 'proposal-1', title: 'Proposal' } };
    const parcel = { kind: 'parcel', id: 'P-1', depth: 0, feature };
    const context = {
        console,
        document: { addEventListener: vi.fn(), getElementById: () => null },
        map: { on: (name, handler) => { mapHandlers[name] = handler; } },
        LiveParcelFabric: { queryBounds: vi.fn(() => [feature]), featureId: () => 'P-1' },
        turf: { booleanPointInPolygon: () => true },
        __drillStack: { buildDrillStack: vi.fn(() => [proposal, parcel]) },
        __mapEditLock: { blocksSelection: () => blocked },
        MapPick: { active: () => pickActive },
        ClickStack: { handleClick: vi.fn(() => true) },
        selectAndHighlightProposal: vi.fn(),
        selectParcel: vi.fn()
    };
    context.window = context;
    vm.runInNewContext(source, context);
    return { api: context.__drillUi, context, mapHandlers, proposal, parcel };
}

describe('drill entry points hand map clicks to the click stack', () => {
    it('does not erase an expanded section focus when the mouse leaves the map', () => {
        const h = loadDrill();
        const pending = [];
        h.context.requestAnimationFrame = callback => { pending.push(callback); return pending.length; };
        h.context.highlightFeaturesForHover = vi.fn();
        h.context.__drillStack.buildDrillStack.mockReturnValue([h.parcel]);
        h.api.notifyHover({ latlng: { lat: 2, lng: 1 } });
        pending.shift()();
        expect(h.context.highlightFeaturesForHover).toHaveBeenCalledWith([h.parcel.feature], { showLabels: true });
        h.context.ClickStack.holdsHighlight = () => true;
        h.context.highlightFeaturesForHover.mockClear();
        h.mapHandlers.mouseout();
        expect(h.context.highlightFeaturesForHover).not.toHaveBeenCalled();
        h.context.ClickStack.holdsHighlight = () => false;
        h.mapHandlers.mouseout();
        expect(h.context.highlightFeaturesForHover).toHaveBeenCalledWith([]);
    });

    it('exposes stackAt and hover only, without the old panel functions', () => {
        const { api } = loadDrill();
        expect(Object.keys(api).sort()).toEqual(['handleParcelClick', 'handleSurfaceClick', 'notifyHover', 'ownsHover', 'stackAt']);
    });

    it('still answers what stands at a point, topmost first', () => {
        const h = loadDrill();
        expect(h.api.stackAt({ lat: 2, lng: 1 })).toEqual([h.proposal, h.parcel]);
        expect(h.context.__drillStack.buildDrillStack).toHaveBeenCalledWith([1, 2], expect.objectContaining({
            parcels: [{ id: 'P-1', feature: h.parcel.feature, live: true }]
        }));
    });

    it('forwards a structure or corridor click to the click stack and selects nothing itself', () => {
        const h = loadDrill();
        const latlng = { lat: 2, lng: 1 };
        expect(h.api.handleSurfaceClick(latlng)).toBe(true);
        expect(h.context.ClickStack.handleClick).toHaveBeenCalledWith(latlng);
        expect(h.context.selectAndHighlightProposal).not.toHaveBeenCalled();
        expect(h.context.selectParcel).not.toHaveBeenCalled();
        // What the click stack did not take, the surface handles itself (it selects its own design).
        h.context.ClickStack.handleClick.mockReturnValueOnce(false);
        expect(h.api.handleSurfaceClick(latlng)).toBe(false);
        expect(h.api.handleSurfaceClick(null)).toBe(false);
    });

    it('keeps the parcel entry\'s result shape, naming no level of its own', () => {
        const h = loadDrill();
        expect(h.api.handleParcelClick({ lat: 2, lng: 1 })).toEqual({ handled: true, selectedKind: null, selectedRef: null });
        h.context.ClickStack.handleClick.mockReturnValueOnce(false);
        expect(h.api.handleParcelClick({ lat: 2, lng: 1 }).handled).toBe(false);
    });

    it('sends a map background click to the click stack unless selection is blocked', () => {
        const open = loadDrill();
        open.mapHandlers.click({ latlng: { lat: 3, lng: 4 } });
        expect(open.context.ClickStack.handleClick).toHaveBeenCalledWith({ lat: 3, lng: 4 });

        const locked = loadDrill({ blocked: true });
        locked.mapHandlers.click({ latlng: { lat: 3, lng: 4 } });
        expect(locked.context.ClickStack.handleClick).not.toHaveBeenCalled();

        const picker = loadDrill({ blocked: true, pickActive: true });
        picker.mapHandlers.click({ latlng: { lat: 3, lng: 4 } });
        expect(picker.context.ClickStack.handleClick).toHaveBeenCalledWith({ lat: 3, lng: 4 });
    });
});
