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
    const locallyDeclared = new Set(['singleMap', 'singleEditor', 'singleSession', 'singleUploadOnConfirm', 'singleBlockLayer', 'singleParcelBorderLayer', 'singleRectGroup', 'singleGroundPreviewLayer', 'singleRectLayer', 'singleActivePolygonLayer', 'singleDragMarker', 'singlePendingVertexActionIndex', 'singleBuildingDesignChangeTracker', 'disabledViewButtons', 'suspendedPanels', 'threeControls', 'editorFocusReturn', 'currentGroundTreatment', 'currentTakeWholeParcels', 'singleHistory', 'singleBuildingLayers']);
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
        singleHistory: { destroy: vi.fn() }, singleBuildingLayers: new Map(),
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
    const variables = `let singlePlacement=null, singleLandTakeReview=null, singleGroundBoundary=null, singleHistory=this.singleHistory, singleBuildingLayers=this.singleBuildingLayers, singleSession=this.singleSession, singleMap=this.singleMap, singleEditor=this.singleEditor, singleUploadOnConfirm=this.singleUploadOnConfirm, singleBlockLayer=this.singleBlockLayer, singleParcelBorderLayer=this.singleParcelBorderLayer, singleRectGroup=this.singleRectGroup, singleGroundPreviewLayer=this.singleGroundPreviewLayer, singleRectLayer=this.singleRectLayer, singleActivePolygonLayer=this.singleActivePolygonLayer, singleDragMarker=this.singleDragMarker, singlePendingVertexActionIndex=this.singlePendingVertexActionIndex, singleBuildingDesignChangeTracker=this.singleBuildingDesignChangeTracker, disabledViewButtons=this.disabledViewButtons, suspendedPanels=this.suspendedPanels, threeControls=this.threeControls, editorFocusReturn=this.editorFocusReturn, singleBlockFeature={geometry:{}}, singleRectFeature={geometry:{}}, currentRotationDeg=90, currentGroundTreatment='paved', currentTakeWholeParcels=true;`;
    const names = ['singleBuildingPreview', 'updateSingleBuildingPreview', 'closeSingleBuildingMapEditor', 'requestCloseSingleBuildingMapEditor'];
    const context = { console, ...stubs };
    const locallyDeclared = new Set(['singleMap', 'singleEditor', 'singleSession', 'singleUploadOnConfirm', 'singleBlockLayer', 'singleParcelBorderLayer', 'singleRectGroup', 'singleGroundPreviewLayer', 'singleRectLayer', 'singleActivePolygonLayer', 'singleDragMarker', 'singlePendingVertexActionIndex', 'singleBuildingDesignChangeTracker', 'disabledViewButtons', 'suspendedPanels', 'threeControls', 'editorFocusReturn', 'currentGroundTreatment', 'currentTakeWholeParcels', 'singleHistory', 'singleBuildingLayers']);
    const bindings = Object.keys(stubs).filter(key => !locallyDeclared.has(key)).map(key => `const ${key}=this.${key};`).join('\n');
    vm.runInNewContext(`${variables}\n${bindings}\n${names.map(name => functions.get(name)).join('\n')}\nthis.close=closeSingleBuildingMapEditor; this.cancel=requestCloseSingleBuildingMapEditor;`, context);
    return { close: context.close, cancel: context.cancel, calls, map, editor, panel, body, stubs, window, document };
}

describe('single-building map editor lifecycle', () => {
    it.each(['2d', 'model'])('mounts placement without taking over the %s view', mode => {
        const feature = { type: 'Feature', geometry: { type: 'Polygon', coordinates: [] } };
        const entry = { id: 'building-1', feature };
        const view = { center: [12, 34], zoom: 18, queuedFit: false };
        const before = structuredClone(view);
        const session = {
            map: { on: vi.fn(), getContainer: () => ({ focus }) }, setPreview: vi.fn(),
            setCollapsed: vi.fn(), setHint: vi.fn(), body: {}, footer: {},
            fitFeature: vi.fn(() => {
                if (mode === 'model') view.queuedFit = true;
                else { view.center = [13, 35]; view.zoom = 21; }
            })
        };
        const draw = vi.fn(), sync = vi.fn(), focus = vi.fn();
        const stubs = {
            session, document: { getElementById: () => ({ focus }) },
            window: { FreeformLandTakeReview: { mount: vi.fn(() => ({})) }, FreeformPlacement: { start: vi.fn(() => ({ destroy: vi.fn() })) } },
            getSelectedBlockFeature: () => feature, cloneSingleFeature: value => value,
            translateSingleBuildingText: (_key, fallback) => fallback,
            drawBlockOnMap: draw, normalizeGroundTreatment: () => 'none',
            computeInitialPlacement: () => ({ center: [12, 34], width: 10, length: 10 }),
            addNewBuildingEntry: vi.fn(() => entry), refreshBuildingSelector: vi.fn(), setActiveBuilding: vi.fn(),
            syncSingleBuildingView: sync, ensureSingleBuildingHistory: vi.fn(),
            singleBuildingDesignChanges: () => ({ capture: vi.fn() }), tryStartDragFromMap: vi.fn(),
            refreshSingleLandTakePreview: vi.fn(), singleBuildingPreview: vi.fn()
        };
        const variables = `const DEFAULT_HEIGHT_M=12, EDIT_PANE='edit';
            let singleBlockFeature, singleGroundBoundary, singleBuildingSeedGroundBoundary=null, singleMoveTogether,
                singleEditor={dataset:{},querySelector:()=>({})}, singleSession=this.session, singlePlacement, singleMap, buildingEntries=[], activeBuildingId, nextBuildingId,
                currentGroundTreatment, currentGroundDecorationDesign, singleBuildingSeedDecorationDesign=null,
                singleBuildingSeedGroundTreatment=null, currentHeightM, currentRotationDeg, singleRectFeature,
                singleBuildingSeedBuildings=null, singleLandTakeReview, singleBuildingSeedLandTake=null;`;
        // Execute the real mount tail with an existing editor frame: only its UI shell is stubbed.
        const bindings = Object.keys(stubs).filter(key => key !== 'session').map(key => `const ${key}=this.${key};`).join('\n');
        const context = { ...stubs };
        vm.runInNewContext(`${variables}\n${bindings}\n${functions.get('mountSingleBuildingMapEditor')}\nthis.mount=mountSingleBuildingMapEditor;`, context);

        expect(context.mount()).toBe(true);
        expect(draw).toHaveBeenCalledWith(feature);
        expect(sync).not.toHaveBeenCalled();
        expect(stubs.window.FreeformPlacement.start).toHaveBeenCalledWith(expect.objectContaining({ map: session.map }));
        expect(focus).toHaveBeenCalledWith({ preventScroll: true });
        expect(view).toEqual(before);
    });

    it('includes authored surroundings and the reviewed land take in the placement site', () => {
        const ground = turf.bboxPolygon([0, 0, 4, 4]);
        const take = turf.bboxPolygon([3, 0, 5, 2]);
        const building = turf.bboxPolygon([1, 1, 2, 2]);
        const review = { take };
        const placement = extract('currentPlacementSite', '', {
            buildingEntries: [{ feature: building }], singleLandTakeReview: review,
            singleGroundBoundary: ground, turf, currentGroundSurface: () => ({ polygon: ground.geometry }),
            cloneSingleFeature: value => JSON.parse(JSON.stringify(value))
        });
        const site = turf.feature(placement());
        expect(turf.bbox(site)).toEqual([0, 0, 5, 4]);
        expect(turf.booleanWithin(ground, site)).toBe(true);
        expect(turf.booleanWithin(take, site)).toBe(true);
        expect(review.take).toBe(take);
    });

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
            cloneSingleFeature: feature => feature == null ? null : JSON.parse(JSON.stringify(feature)),
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
        const stubs = { singleLandTakeReview: null, singleSession, singleEditor: {}, buildingEntries: [{ feature }],
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

    it('refreshes land-take effects while preserving the authored ground boundary and decoration', () => {
        const take = { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[0, 0], [2, 0], [2, 2], [0, 0]]] } };
        const boundary = { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[0, 0], [3, 0], [3, 3], [0, 0]]] } };
        const decoration = { version: 1, details: [{ kind: 'tree', at: [1, 1] }] };
        const review = { take };
        const probe = {};
        const session = { placement: { update: vi.fn() }, setPreview: vi.fn() };
        const effects = {
            updateGroundPreview: vi.fn(), refreshSingleBuildingDensityStats: vi.fn(),
            currentPlacementSite: vi.fn(() => ({ take: review.take })),
            singleBuildingPreview: vi.fn(() => ({ take: review.take })), autosaveSingleBuildingDraft: vi.fn()
        };
        const refresh = extract('refreshSingleLandTakePreview', `
            let singleLandTakeReview=this.review, singleGroundBoundary=this.boundary,
                currentGroundDecorationDesign=this.decoration, singleSession=this.session;
            this.probe.read=()=>({ singleGroundBoundary, currentGroundDecorationDesign });`,
            { ...effects, review, boundary, decoration, session, probe, cloneSingleFeature: value => structuredClone(value) });

        refresh(take, true);

        expect(probe.read().singleGroundBoundary).toBe(boundary);
        expect(probe.read().currentGroundDecorationDesign).toBe(decoration);
        expect(effects.updateGroundPreview).toHaveBeenCalledOnce();
        expect(effects.refreshSingleBuildingDensityStats).toHaveBeenCalledOnce();
        expect(effects.currentPlacementSite).toHaveBeenCalledOnce();
        expect(session.placement.update).toHaveBeenCalledWith({ take });
        expect(session.setPreview).toHaveBeenCalledWith({ take });
        expect(effects.autosaveSingleBuildingDraft).toHaveBeenCalledOnce();
        refresh(take, true, true);
        expect(probe.read().singleGroundBoundary).toEqual(take);
        expect(probe.read().currentGroundDecorationDesign).toBe(decoration);
        refresh(take, false); // Leaving the last whole parcel also clears furniture without a menu change.
        expect(probe.read().currentGroundDecorationDesign).toBeNull();
        expect(review.take).toBe(take);
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

    it.each(['parcels', 'site'])('opens uploaded model geometry on its %s boundary without auto-confirming', boundary => {
        const entry = { feature: { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [] } } };
        const addEntry = vi.fn(() => entry);
        const openEditor = vi.fn(() => true);
        const confirm = vi.fn();
        const variables = `let singleEditor=null, singleBuildingOverrideContext=null, singleBlockFeature=null, buildingEntries=[], activeBuildingId=null, nextBuildingId=1, singleBuildingSeedBuildings=null, singleUploadOnConfirm=null; const DEFAULT_HEIGHT_M=12, DEFAULT_WIDTH_M=10; this.getSeed=()=>singleBuildingSeedBuildings; this.getContext=()=>singleBuildingOverrideContext;`;
        const stubs = {
            window: { OnMapEditor: { isActive: () => false }, SingleBuildingGeometry: { placeModelFootprint: () => entry.feature } },
            markAsEditablePolygon: vi.fn(), editableFootprintValid: () => true,
            singleBuildingParcelsForIds: ids => ids.map(id => ({ id })),
            describeSingleBuildingSelection: () => 'Parcel block',
            getSelectedBlockFeature: () => ({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [] } }),
            computeInitialPlacement: () => ({ center: [15, 45], width: 20, length: 18 }),
            addNewBuildingEntry: addEntry,
            cloneSingleFeature: feature => feature == null ? null : JSON.parse(JSON.stringify(feature)),
            showSingleBuildingMapEditor: openEditor,
            setSingleBuildingStatus: vi.fn(),
            confirmSingleBuilding: confirm
        };
        const declared = new Set(['singleEditor', 'singleBuildingOverrideContext', 'singleBlockFeature', 'buildingEntries', 'activeBuildingId', 'nextBuildingId', 'singleBuildingSeedBuildings', 'singleUploadOnConfirm']);
        const bindings = Object.keys(stubs).filter(key => !declared.has(key)).map(key => `const ${key}=this.${key};`).join('\n');
        const context = { ...stubs };
        vm.runInNewContext(`${variables}\n${bindings}\n${functions.get('singleBuildingPlacementContext')}\n${functions.get('createSingleBuildingFromUpload')}\nthis.create=createSingleBuildingFromUpload;`, context);
        const callback = vi.fn();

        const site = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] };
        expect(context.create({
            ...(boundary === 'site' ? { parcelIds: [], site } : { parcelIds: ['parcel-1'] }),
            blockName: 'Parcel block', width: 11, length: 13,
            height: 17, modelName: 'museum.glb', modelUrl: '/models/museum.glb', onConfirm: callback
        })).toBe(true);

        expect(context.getContext().parcelIds).toEqual(boundary === 'site' ? [] : ['parcel-1']);
        if (boundary === 'site') {
            expect(context.getContext().site).toEqual(site);
            expect(context.getContext().parcels[0].feature.geometry).toEqual(site);
        }
        expect(addEntry).toHaveBeenCalledWith([15, 45], { feature: entry.feature, height: 17, rotation: 0 });
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
            cloneSingleFeature: feature => feature == null ? null : JSON.parse(JSON.stringify(feature)),
            showSingleBuildingMapEditor: openEditor,
            setSingleBuildingStatus: vi.fn()
        };
        const declared = new Set(['singleEditor', 'singleBuildingOverrideContext', 'singleBlockFeature', 'buildingEntries', 'activeBuildingId', 'nextBuildingId', 'singleBuildingSeedBuildings', 'singleUploadOnConfirm']);
        const bindings = Object.keys(stubs).filter(key => !declared.has(key)).map(key => `const ${key}=this.${key};`).join('\n');
        const context = { ...stubs };
        vm.runInNewContext(`${variables}\n${bindings}\n${functions.get('singleBuildingPlacementContext')}\n${functions.get('createSingleBuildingFromUpload')}\nthis.create=createSingleBuildingFromUpload;`, context);

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
            singleLandTakeReview: { prepare: async () => true, take: feature },
            getActiveBuilding: () => entry, getSingleBuildingContext: () => ({ blockName: 'Block', parcels: [{ feature: { properties: { BROJ_CESTICE: '77' } } }] }),
            setSingleBuildingStatus: vi.fn(), resolveParcelId: () => 'parcel-77', describeSingleBuildingSelection: () => 'Block',
            multiParcelSelection: { clearSelection: vi.fn(), selectedParcels: new Set(), updateUI: vi.fn() },
            window: { SingleBuildingGeometry: { clipFootprintToBoundary: vi.fn(value => value) } }, turf: {},
            singleSession: { placement: { locked: false } }, currentPlacementSite: () => ({ type: 'MultiPolygon', coordinates: [] }),
            singleUploadOnConfirm: afterUploadDone, cloneSingleFeature: value => structuredClone(value),
            currentGroundSurface: () => ({ treatment: 'green' }), setPendingBuildingProposalContext: value => pendingContexts.push(value),
            closeSingleBuildingMapEditor: close, document: { getElementById: () => null }
        };
        const variables = `let buildingEntries=[this.entry], singleBlockFeature={geometry:{}}, singleGroundBoundary={geometry:{}}, currentTakeWholeParcels=true, pendingSingleBuildingMeta=null, singleUploadOnConfirm=this.singleUploadOnConfirm; const DEFAULT_HEIGHT_M=12;`;
        const context = { ...stubs, entry };
        const bindings = Object.keys(stubs).filter(key => key !== 'singleUploadOnConfirm').map(key => `const ${key}=this.${key};`).join('\n');
        vm.runInNewContext(`${variables}\n${bindings}\n${functions.get('confirmSingleBuilding')}\nthis.confirm=confirmSingleBuilding;`, context);
        await context.confirm();
        expect(pendingContexts).toHaveLength(1);
        expect(pendingContexts[0]).toMatchObject({ parcelIds: ['parcel-77'], blockName: 'Block', landTake: feature });
        expect(pendingContexts[0].buildings).toHaveLength(1);
        expect(stubs.window.SingleBuildingGeometry.clipFootprintToBoundary).not.toHaveBeenCalled();
        expect(pendingContexts[0].placement).toMatchObject({ free: true });
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
