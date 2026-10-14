// Behavioral regressions for the on-map building editor's shared-map lifecycle.
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { parse } from '@babel/parser';

const require = createRequire(import.meta.url);
const turf = require('@turf/turf');
const { footprintWithinBoundary } = require('../../frontend/js/single-building-geometry.js');

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
    const locallyDeclared = new Set(['singleMap', 'singleEditor', 'singleSession', 'singleUploadOnConfirm', 'singleBlockLayer', 'singleParcelBorderLayer', 'singleRectGroup', 'singleGroundPreviewLayer', 'singleRectLayer', 'singleActivePolygonLayer', 'singleDragMarker', 'singlePendingVertexActionIndex', 'singleBuildingDesignChangeTracker', 'disabledViewButtons', 'suspendedPanels', 'threeControls', 'editorFocusReturn', 'currentGroundTreatment', 'currentTakeWholeParcels']);
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
        singleSession: { close: vi.fn(() => { calls.sessionClosed = true; }) },
        singleBlockLayer: 'block', singleParcelBorderLayer: 'border', singleRectGroup: 'footprints',
        singleGroundPreviewLayer: 'ground', singleRectLayer: {}, singleActivePolygonLayer: {}, singleDragMarker: {},
        singleBuildingDesignChangeTracker: { stop: vi.fn() }, singlePendingVertexActionIndex: 3,
        handleSingleBuildingKeydown() {}, syncSingleBuildingView() {}, handleRectDragEnd: vi.fn(), destroySinglePolygonEditor: vi.fn(),
        tryStartDragFromMap() {}, positionSingleBuildingToolbar() {}, clearSingleBuildingPendingState: vi.fn(() => { calls.cleared = true; }),
        refreshSingleBuildingDensityStats: vi.fn(), cloneSingleFeature: feature => feature,
        singleBuildingDesignChanges: () => ({ changed: () => true }),
        currentGroundSurface: () => null, buildingEntries: [], currentGroundTreatment: 'none', currentTakeWholeParcels: false,
        singleUploadOnConfirm: options.singleUploadOnConfirm || null,
        disabledViewButtons: [{ button: { disabled: true }, disabled: false }], suspendedPanels: [{ panel, display: 'block' }],
        threeControls: { removeEventListener: vi.fn() }, editorFocusReturn: null,
        EDIT_LOCK_OWNER: 'single-building-editor', CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } }
    };
    const variables = `let singleSession=this.singleSession, singleMap=this.singleMap, singleEditor=this.singleEditor, singleUploadOnConfirm=this.singleUploadOnConfirm, singleBlockLayer=this.singleBlockLayer, singleParcelBorderLayer=this.singleParcelBorderLayer, singleRectGroup=this.singleRectGroup, singleGroundPreviewLayer=this.singleGroundPreviewLayer, singleRectLayer=this.singleRectLayer, singleActivePolygonLayer=this.singleActivePolygonLayer, singleDragMarker=this.singleDragMarker, singlePendingVertexActionIndex=this.singlePendingVertexActionIndex, singleBuildingDesignChangeTracker=this.singleBuildingDesignChangeTracker, disabledViewButtons=this.disabledViewButtons, suspendedPanels=this.suspendedPanels, threeControls=this.threeControls, editorFocusReturn=this.editorFocusReturn, singleBlockFeature={geometry:{}}, singleRectFeature={geometry:{}}, currentRotationDeg=90, currentGroundTreatment='paved', currentTakeWholeParcels=true;`;
    const names = ['singleBuildingPreview', 'updateSingleBuildingPreview', 'closeSingleBuildingMapEditor', 'requestCloseSingleBuildingMapEditor'];
    const context = { console, ...stubs };
    const locallyDeclared = new Set(['singleMap', 'singleEditor', 'singleSession', 'singleUploadOnConfirm', 'singleBlockLayer', 'singleParcelBorderLayer', 'singleRectGroup', 'singleGroundPreviewLayer', 'singleRectLayer', 'singleActivePolygonLayer', 'singleDragMarker', 'singlePendingVertexActionIndex', 'singleBuildingDesignChangeTracker', 'disabledViewButtons', 'suspendedPanels', 'threeControls', 'editorFocusReturn', 'currentGroundTreatment', 'currentTakeWholeParcels']);
    const bindings = Object.keys(stubs).filter(key => !locallyDeclared.has(key)).map(key => `const ${key}=this.${key};`).join('\n');
    vm.runInNewContext(`${variables}\n${bindings}\n${names.map(name => functions.get(name)).join('\n')}\nthis.close=closeSingleBuildingMapEditor; this.cancel=requestCloseSingleBuildingMapEditor;`, context);
    return { close: context.close, cancel: context.cancel, calls, map, editor, panel, body, stubs, window, document };
}

describe('single-building map editor lifecycle', () => {
    it('uses the authored MultiPolygon site as the movable footprint boundary', () => {
        const ring = (west, south, east, north) => [[
            [west, south], [east, south], [east, north], [west, north], [west, south]
        ]];
        const site = {
            type: 'Feature', properties: { authored: true },
            geometry: { type: 'MultiPolygon', coordinates: [ring(0, 0, 2, 2), ring(10, 0, 12, 2)] }
        };
        const childParcel = turf.polygon(ring(0, 0, 2, 2));
        const union = vi.fn(() => childParcel);
        const boundary = extract('getSelectedBlockFeature', '', {
            getSingleBuildingContext: () => ({ site, parcels: [{ feature: childParcel }] }),
            cloneSingleFeature: feature => JSON.parse(JSON.stringify(feature)),
            robustUnion: union, turf, toSingleLargestPolygon: vi.fn(() => childParcel)
        });
        const editableBoundary = boundary();
        const movedInsideSecondIsland = turf.polygon(ring(10.5, 0.5, 11, 1));
        const movedOutsideSite = turf.polygon(ring(20, 0.5, 21, 1));

        expect(editableBoundary.geometry).toEqual(site.geometry);
        expect(editableBoundary.properties).toEqual(site.properties);
        expect(union).not.toHaveBeenCalled();
        expect(footprintWithinBoundary(movedInsideSecondIsland, editableBoundary, turf)).toBe(true);
        expect(footprintWithinBoundary(movedOutsideSite, editableBoundary, turf)).toBe(false);
    });

    it('removes only editor layers and listeners, releases the lock, and leaves the main map controls intact', () => {
        const h = closeHarness();
        h.close();
        expect(h.calls.removedLayers).toEqual(['block', 'border', 'footprints', 'ground']);
        expect(h.calls.offs.map(args => args[0])).toEqual(['mousedown', 'touchstart']);
        expect(h.map.remove).not.toHaveBeenCalled();
        expect(h.stubs.singleSession.close).toHaveBeenCalledOnce();
        expect(h.calls.discarded).toBe(1);
        expect(h.calls.finished).toBe(1);
        expect(h.calls.cleared).toBe(true);
        expect(h.stubs.handleRectDragEnd).toHaveBeenCalledOnce();
        expect(h.stubs.destroySinglePolygonEditor).toHaveBeenCalledOnce();
    });

    it('refreshes footprint handles and publishes the live geometry when the shared view changes', () => {
        const feature = { type: 'Feature', geometry: { type: 'Polygon', coordinates: [] } };
        const singleSession = { setPreview: vi.fn() };
        const stubs = { singleSession, singleEditor: {}, buildingEntries: [{ feature }],
            singleBlockFeature: { geometry: {} }, currentGroundSurface: () => ({ treatment: 'green', polygon: {} }),
            cloneSingleFeature: value => JSON.parse(JSON.stringify(value)),
            renderSharedPolygonEditor: vi.fn(), refreshSingleBuildingDensityStats: vi.fn(), positionSingleBuildingToolbar: vi.fn() };
        const bindings = Object.keys(stubs).filter(key => key !== 'singleUploadOnConfirm').map(key => `const ${key}=this.${key};`).join('\n');
        const context = { ...stubs };
        vm.runInNewContext(`${bindings}\n${functions.get('singleBuildingPreview')}\n${functions.get('updateSingleBuildingPreview')}\n${functions.get('syncSingleBuildingView')}\nthis.sync=syncSingleBuildingView;`, context);
        context.sync();
        expect(stubs.renderSharedPolygonEditor).toHaveBeenCalledOnce();
        expect(singleSession.setPreview).toHaveBeenCalledWith({
            draftPreview: { kind: 'buildings', features: [feature] }, boundary: { geometry: {} },
            groundSurface: { treatment: 'green', polygon: {} }
        });
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

    it('opens uploaded model geometry for editing with its model metadata and does not auto-confirm', () => {
        const entry = { feature: { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [] } } };
        const addEntry = vi.fn(() => entry);
        const openEditor = vi.fn(() => true);
        const confirm = vi.fn();
        const variables = `let singleEditor=null, singleBuildingOverrideContext=null, singleBlockFeature=null, buildingEntries=[], activeBuildingId=null, nextBuildingId=1, singleBuildingSeedBuildings=null, singleUploadOnConfirm=null; const DEFAULT_HEIGHT_M=12, DEFAULT_WIDTH_M=10; this.getSeed=()=>singleBuildingSeedBuildings;`;
        const stubs = {
            window: { OnMapEditor: { isActive: () => false } },
            singleBuildingParcelsForIds: ids => ids.map(id => ({ id })),
            describeSingleBuildingSelection: () => 'Parcel block',
            getSelectedBlockFeature: () => ({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [] } }),
            computeInitialPlacement: () => ({ center: [15, 45], width: 20, length: 18 }),
            addNewBuildingEntry: addEntry,
            cloneSingleFeature: feature => JSON.parse(JSON.stringify(feature)),
            showSingleBuildingMapEditor: openEditor,
            setSingleBuildingStatus: vi.fn(),
            confirmSingleBuilding: confirm
        };
        const declared = new Set(['singleEditor', 'singleBuildingOverrideContext', 'singleBlockFeature', 'buildingEntries', 'activeBuildingId', 'nextBuildingId', 'singleBuildingSeedBuildings', 'singleUploadOnConfirm']);
        const bindings = Object.keys(stubs).filter(key => !declared.has(key)).map(key => `const ${key}=this.${key};`).join('\n');
        const context = { ...stubs };
        vm.runInNewContext(`${variables}\n${bindings}\n${functions.get('createSingleBuildingFromUpload')}\nthis.create=createSingleBuildingFromUpload;`, context);
        const callback = vi.fn();

        expect(context.create({
            parcelIds: ['parcel-1'], blockName: 'Parcel block', width: 11, length: 13,
            height: 17, modelName: 'museum.glb', modelUrl: '/models/museum.glb', onConfirm: callback
        })).toBe(true);

        expect(addEntry).toHaveBeenCalledWith([15, 45], { width: 11, length: 13, height: 17, rotation: 0 });
        expect(entry.feature.properties).toMatchObject({ source: 'upload', modelName: 'museum.glb', modelUrl: '/models/museum.glb', height: 17 });
        expect(context.getSeed()[0].properties).toMatchObject({ source: 'upload', modelName: 'museum.glb', modelUrl: '/models/museum.glb', height: 17 });
        expect(openEditor).toHaveBeenCalledOnce();
        expect(confirm).not.toHaveBeenCalled();
        expect(callback).not.toHaveBeenCalled();
    });

    it('returns false and keeps the upload callback dormant when the editor lock refuses the upload', () => {
        const entry = { feature: { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [] } } };
        const callback = vi.fn();
        const openEditor = vi.fn();
        const variables = `let singleEditor=null, singleBuildingOverrideContext=null, singleBlockFeature=null, buildingEntries=[], activeBuildingId=null, nextBuildingId=1, singleBuildingSeedBuildings=null, singleUploadOnConfirm=null; const DEFAULT_HEIGHT_M=12, DEFAULT_WIDTH_M=10;`;
        const stubs = {
            window: { OnMapEditor: { isActive: () => true } },
            singleBuildingParcelsForIds: ids => ids.map(id => ({ id })),
            describeSingleBuildingSelection: () => 'Parcel block',
            getSelectedBlockFeature: () => ({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [] } }),
            computeInitialPlacement: () => ({ center: [15, 45], width: 20, length: 18 }),
            addNewBuildingEntry: () => entry,
            cloneSingleFeature: feature => JSON.parse(JSON.stringify(feature)),
            showSingleBuildingMapEditor: openEditor,
            setSingleBuildingStatus: vi.fn()
        };
        const declared = new Set(['singleEditor', 'singleBuildingOverrideContext', 'singleBlockFeature', 'buildingEntries', 'activeBuildingId', 'nextBuildingId', 'singleBuildingSeedBuildings', 'singleUploadOnConfirm']);
        const bindings = Object.keys(stubs).filter(key => !declared.has(key)).map(key => `const ${key}=this.${key};`).join('\n');
        const context = { ...stubs };
        vm.runInNewContext(`${variables}\n${bindings}\n${functions.get('createSingleBuildingFromUpload')}\nthis.create=createSingleBuildingFromUpload;`, context);

        expect(context.create({ parcelIds: ['parcel-1'], modelUrl: '/models/blocked.glb', onConfirm: callback })).toBe(false);
        expect(openEditor).not.toHaveBeenCalled();
        expect(callback).not.toHaveBeenCalled();
    });

    it('Done preserves pending context; Cancel runs the normal discard path', async () => {
        const feature = { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [] } };
        const entry = { id: 'building-1', name: 'One', color: '#abc', feature, height: 14, rotation: 20 };
        const pendingContexts = [];
        const close = vi.fn();
        const afterUploadDone = vi.fn();
        const stubs = {
            getActiveBuilding: () => entry, getSingleBuildingContext: () => ({ blockName: 'Block', parcels: [{ feature: { properties: { BROJ_CESTICE: '77' } } }] }),
            setSingleBuildingStatus: vi.fn(), resolveParcelId: () => 'parcel-77', describeSingleBuildingSelection: () => 'Block',
            multiParcelSelection: { clearSelection: vi.fn(), selectedParcels: new Set(), updateUI: vi.fn() },
            window: { SingleBuildingGeometry: { clipFootprintToBoundary: value => value } }, turf: {},
            singleUploadOnConfirm: afterUploadDone,
            currentGroundSurface: () => ({ treatment: 'green' }), setPendingBuildingProposalContext: value => pendingContexts.push(value),
            closeSingleBuildingMapEditor: close, document: { getElementById: () => null }
        };
        const variables = `let buildingEntries=[this.entry], singleBlockFeature={geometry:{}}, currentTakeWholeParcels=true, pendingSingleBuildingMeta=null, singleUploadOnConfirm=this.singleUploadOnConfirm; const DEFAULT_HEIGHT_M=12;`;
        const context = { ...stubs, entry };
        const bindings = Object.keys(stubs).filter(key => key !== 'singleUploadOnConfirm').map(key => `const ${key}=this.${key};`).join('\n');
        vm.runInNewContext(`${variables}\n${bindings}\n${functions.get('confirmSingleBuilding')}\nthis.confirm=confirmSingleBuilding;`, context);
        context.confirm();
        expect(pendingContexts).toHaveLength(1);
        expect(pendingContexts[0]).toMatchObject({ parcelIds: ['parcel-77'], blockName: 'Block', takeWholeParcels: true });
        expect(pendingContexts[0].buildings).toHaveLength(1);
        expect(close).toHaveBeenCalledWith({ preservePending: true });
        expect(afterUploadDone).toHaveBeenCalledOnce();

        const done = closeHarness();
        done.close({ preservePending: true });
        expect(done.calls.cleared).toBeUndefined();
        expect(done.calls.discarded).toBe(0);
        expect(done.calls.finished).toBe(1);

        const afterCancelledUpload = vi.fn();
        const cancel = closeHarness({ singleUploadOnConfirm: afterCancelledUpload });
        await cancel.cancel();
        expect(cancel.calls.cleared).toBe(true);
        expect(cancel.calls.discarded).toBe(1);
        expect(afterCancelledUpload).not.toHaveBeenCalled();
    });
});
