// Behavioral regressions for the on-map building editor's shared-map lifecycle.
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from '@babel/parser';

const source = readFileSync(new URL('../../frontend/js/single-building.js', import.meta.url), 'utf8');
const ast = parse(source, { sourceType: 'script', plugins: ['optionalChaining', 'nullishCoalescingOperator'] });
const functions = new Map();
(function collect(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'FunctionDeclaration' && node.id) functions.set(node.id.name, source.slice(node.start, node.end));
    Object.keys(node).forEach(key => {
        if (['loc', 'start', 'end'].includes(key)) return;
        const value = node[key];
        if (Array.isArray(value)) value.forEach(collect); else collect(value);
    });
})(ast);

function extract(name, variables, stubs) {
    const locallyDeclared = new Set(['singleMap', 'singleEditor', 'singleBlockLayer', 'singleParcelBorderLayer', 'singleRectGroup', 'singleGroundPreviewLayer', 'singleRectLayer', 'singleActivePolygonLayer', 'singleDragMarker', 'singlePendingVertexActionIndex', 'singleBuildingDesignChangeTracker', 'disabledViewButtons', 'suspendedPanels', 'threeControls', 'editorFocusReturn', 'currentGroundTreatment', 'currentTakeWholeParcels']);
    const bindings = Object.keys(stubs).filter(key => !locallyDeclared.has(key)).map(key => `const ${key}=this.${key};`).join('\n');
    const context = { console, ...stubs };
    vm.runInNewContext(`${variables}\n${bindings}\n${functions.get(name)}\nthis.fn=${name};`, context);
    return context.fn;
}

function closeHarness(options = {}) {
    const calls = { removedLayers: [], offs: [], removedEvents: [], windowEvents: [], classChanges: [], discarded: 0, finished: 0, released: 0, previewEvents: [] };
    const map = {
        removeLayer: vi.fn(layer => calls.removedLayers.push(layer)),
        off: vi.fn((...args) => calls.offs.push(args)),
        remove: vi.fn(), invalidateSize: vi.fn()
    };
    const editor = {};
    const panel = { isConnected: true, style: { display: 'none' } };
    const body = { removeChild: vi.fn(), classList: { remove: name => calls.classChanges.push(name) } };
    const document = {
        body, removeEventListener: (...args) => calls.removedEvents.push(args),
        dispatchEvent: event => calls.previewEvents.push(event)
    };
    const window = {
        removeEventListener: (...args) => calls.windowEvents.push(args),
        __mapEditLock: { release: vi.fn(() => { calls.released += 1; }) },
        confirmDiscardProposalDesignSession: vi.fn(async () => true),
        discardProposalDraftDesignSession: vi.fn(() => { calls.discarded += 1; }),
        finishProposalDraftDesignSession: vi.fn(() => { calls.finished += 1; })
    };
    const stubs = {
        document, window, map, singleMap: map, singleEditor: editor,
        singleBlockLayer: 'block', singleParcelBorderLayer: 'border', singleRectGroup: 'footprints',
        singleGroundPreviewLayer: 'ground', singleRectLayer: {}, singleActivePolygonLayer: {}, singleDragMarker: {},
        singleBuildingDesignChangeTracker: { stop: vi.fn() }, singlePendingVertexActionIndex: 3,
        handleSingleBuildingKeydown() {}, syncSingleBuildingView() {}, handleRectDragEnd: vi.fn(), destroySinglePolygonEditor: vi.fn(),
        tryStartDragFromMap() {}, positionSingleBuildingToolbar() {}, clearSingleBuildingPendingState: vi.fn(() => { calls.cleared = true; }),
        refreshSingleBuildingDensityStats: vi.fn(), cloneSingleFeature: feature => feature,
        singleBuildingDesignChanges: () => ({ changed: () => true }),
        currentGroundSurface: () => null, buildingEntries: [], currentGroundTreatment: 'none', currentTakeWholeParcels: false,
        disabledViewButtons: [{ button: { disabled: true }, disabled: false }], suspendedPanels: [{ panel, display: 'block' }],
        threeControls: { removeEventListener: vi.fn() }, editorFocusReturn: null,
        EDIT_LOCK_OWNER: 'single-building-editor', CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } }
    };
    const variables = `let singleMap=this.singleMap, singleEditor=this.singleEditor, singleBlockLayer=this.singleBlockLayer, singleParcelBorderLayer=this.singleParcelBorderLayer, singleRectGroup=this.singleRectGroup, singleGroundPreviewLayer=this.singleGroundPreviewLayer, singleRectLayer=this.singleRectLayer, singleActivePolygonLayer=this.singleActivePolygonLayer, singleDragMarker=this.singleDragMarker, singlePendingVertexActionIndex=this.singlePendingVertexActionIndex, singleBuildingDesignChangeTracker=this.singleBuildingDesignChangeTracker, disabledViewButtons=this.disabledViewButtons, suspendedPanels=this.suspendedPanels, threeControls=this.threeControls, editorFocusReturn=this.editorFocusReturn, singleBlockFeature={geometry:{}}, singleRectFeature={geometry:{}}, currentRotationDeg=90, currentGroundTreatment='paved', currentTakeWholeParcels=true;`;
    const names = ['singleBuildingPreview', 'updateSingleBuildingPreview', 'closeSingleBuildingMapEditor', 'requestCloseSingleBuildingMapEditor'];
    const context = { console, ...stubs };
    const locallyDeclared = new Set(['singleMap', 'singleEditor', 'singleBlockLayer', 'singleParcelBorderLayer', 'singleRectGroup', 'singleGroundPreviewLayer', 'singleRectLayer', 'singleActivePolygonLayer', 'singleDragMarker', 'singlePendingVertexActionIndex', 'singleBuildingDesignChangeTracker', 'disabledViewButtons', 'suspendedPanels', 'threeControls', 'editorFocusReturn', 'currentGroundTreatment', 'currentTakeWholeParcels']);
    const bindings = Object.keys(stubs).filter(key => !locallyDeclared.has(key)).map(key => `const ${key}=this.${key};`).join('\n');
    vm.runInNewContext(`${variables}\n${bindings}\n${names.map(name => functions.get(name)).join('\n')}\nthis.close=closeSingleBuildingMapEditor; this.cancel=requestCloseSingleBuildingMapEditor;`, context);
    return { close: context.close, cancel: context.cancel, calls, map, editor, panel, body, stubs, window, document };
}

describe('single-building map editor lifecycle', () => {
    it('removes only editor layers and listeners, releases the lock, and leaves the main map controls intact', () => {
        const h = closeHarness();
        h.close();
        expect(h.calls.removedLayers).toEqual(['block', 'border', 'footprints', 'ground']);
        expect(h.calls.offs.map(args => args[0])).toEqual(['mousedown', 'touchstart', 'move zoom resize']);
        expect(h.map.remove).not.toHaveBeenCalled();
        expect(h.calls.released).toBe(1);
        expect(h.calls.discarded).toBe(1);
        expect(h.calls.finished).toBe(1);
        expect(h.calls.cleared).toBe(true);
        expect(h.calls.previewEvents.at(-1)).toMatchObject({ type: 'single-building-preview-change', detail: null });
        expect(h.stubs.handleRectDragEnd).toHaveBeenCalledOnce();
        expect(h.stubs.destroySinglePolygonEditor).toHaveBeenCalledOnce();
        expect(h.stubs.disabledViewButtons[0].button.disabled).toBe(false);
        expect(h.panel.style.display).toBe('block');
    });

    it('syncs mode controls without losing geometry or draft preview state', () => {
        const event = [];
        const controls = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
        const feature = { type: 'Feature', geometry: { type: 'Polygon', coordinates: [] } };
        const buttons = ['2d', 'model'].map(buildingView => ({
            dataset: { buildingView }, attributes: {},
            setAttribute(name, value) { this.attributes[name] = value; }
        }));
        const hint = {};
        const editor = { querySelectorAll: () => buttons, querySelector: () => hint };
        const window = { __mapModeState: { desired: 'model' }, getThreeModeInternals: () => ({ controls }), addEventListener() {} };
        const document = { dispatchEvent: e => event.push(e) };
        const oldControls = { removeEventListener: vi.fn() };
        const stubs = { window, document, singleEditor: editor, threeControls: oldControls, buildingEntries: [{ feature }],
            singleBlockFeature: { geometry: {} }, currentGroundSurface: () => ({ treatment: 'green', polygon: {} }),
            cloneSingleFeature: value => JSON.parse(JSON.stringify(value)), currentHeightM: 30, currentGroundTreatment: 'green', currentTakeWholeParcels: false,
            translateSingleBuildingText: (_key, fallback) => fallback, renderSharedPolygonEditor: vi.fn(), refreshSingleBuildingDensityStats: vi.fn(), positionSingleBuildingToolbar: vi.fn(), CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } } };
        const variables = `let singleEditor=this.singleEditor, threeControls=this.threeControls, buildingEntries=this.buildingEntries, singleBlockFeature=this.singleBlockFeature, currentHeightM=this.currentHeightM, currentGroundTreatment=this.currentGroundTreatment, currentTakeWholeParcels=this.currentTakeWholeParcels;`;
        const bindings = Object.keys(stubs).filter(key => !['singleEditor', 'threeControls', 'buildingEntries', 'singleBlockFeature', 'currentHeightM', 'currentGroundTreatment', 'currentTakeWholeParcels'].includes(key)).map(key => `const ${key}=this.${key};`).join('\n');
        const code = `${variables}\n${bindings}\n${functions.get('singleBuildingPreview')}\n${functions.get('updateSingleBuildingPreview')}\n${functions.get('syncSingleBuildingView')}\nthis.sync=syncSingleBuildingView;`;
        const context = { ...stubs };
        vm.runInNewContext(code, context);
        context.sync();
        expect(buttons.map(button => button.attributes['aria-pressed'])).toEqual(['false', 'true']);
        expect(oldControls.removeEventListener).toHaveBeenCalledOnce();
        expect(controls.addEventListener).toHaveBeenCalledOnce();
        expect(stubs.renderSharedPolygonEditor).toHaveBeenCalledOnce();
        expect(JSON.parse(JSON.stringify(event[0].detail.draftPreview.features))).toEqual([feature]);
        expect(event[0].detail.groundSurface.treatment).toBe('green');
    });

    it('does not claim the map lock or replace an incumbent editor when opening is refused', () => {
        const incumbent = { id: 'already-open' };
        const claim = vi.fn(() => false);
        const window = { __mapEditLock: { claim } };
        const stubs = {
            window, singleEditor: incumbent, EDIT_LOCK_OWNER: 'single-building-editor',
            translateSingleBuildingText: (_key, fallback) => fallback,
            mountSingleBuildingMapEditor: vi.fn(), closeSingleBuildingMapEditor: vi.fn()
        };
        const variables = `let singleEditor=this.singleEditor;`;
        const bindings = Object.keys(stubs).filter(key => key !== 'singleEditor').map(key => `const ${key}=this.${key};`).join('\n');
        const context = { ...stubs };
        vm.runInNewContext(`${variables}\n${bindings}\n${functions.get('showSingleBuildingMapEditor')}\nthis.open=showSingleBuildingMapEditor;`, context);
        expect(context.open()).toBe(false);
        expect(claim).not.toHaveBeenCalled();
        expect(stubs.mountSingleBuildingMapEditor).not.toHaveBeenCalled();
        expect(stubs.closeSingleBuildingMapEditor).not.toHaveBeenCalled();
        expect(context.singleEditor).toBe(incumbent);
    });

    it('Done preserves pending context; Cancel runs the normal discard path', async () => {
        const feature = { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [] } };
        const entry = { id: 'building-1', name: 'One', color: '#abc', feature, height: 14, rotation: 20 };
        const pendingContexts = [];
        const close = vi.fn();
        const stubs = {
            getActiveBuilding: () => entry, getSingleBuildingContext: () => ({ blockName: 'Block', parcels: [{ feature: { properties: { BROJ_CESTICE: '77' } } }] }),
            setSingleBuildingStatus: vi.fn(), resolveParcelId: () => 'parcel-77', describeSingleBuildingSelection: () => 'Block',
            multiParcelSelection: { clearSelection: vi.fn(), selectedParcels: new Set(), updateUI: vi.fn() },
            window: { SingleBuildingGeometry: { clipFootprintToBoundary: value => value } }, turf: {},
            currentGroundSurface: () => ({ treatment: 'green' }), setPendingBuildingProposalContext: value => pendingContexts.push(value),
            closeSingleBuildingMapEditor: close, document: { getElementById: () => null }
        };
        const variables = `let buildingEntries=[this.entry], singleBlockFeature={geometry:{}}, currentTakeWholeParcels=true, pendingSingleBuildingMeta=null; const DEFAULT_HEIGHT_M=12;`;
        const context = { ...stubs, entry };
        const bindings = Object.keys(stubs).map(key => `const ${key}=this.${key};`).join('\n');
        vm.runInNewContext(`${variables}\n${bindings}\n${functions.get('confirmSingleBuilding')}\nthis.confirm=confirmSingleBuilding;`, context);
        context.confirm();
        expect(pendingContexts).toHaveLength(1);
        expect(pendingContexts[0]).toMatchObject({ parcelIds: ['parcel-77'], blockName: 'Block', takeWholeParcels: true });
        expect(pendingContexts[0].buildings).toHaveLength(1);
        expect(close).toHaveBeenCalledWith({ preservePending: true });

        const done = closeHarness();
        done.close({ preservePending: true });
        expect(done.calls.cleared).toBeUndefined();
        expect(done.calls.discarded).toBe(0);
        expect(done.calls.finished).toBe(1);

        const cancel = closeHarness();
        await cancel.cancel();
        expect(cancel.calls.cleared).toBe(true);
        expect(cancel.calls.discarded).toBe(1);
    });
});
