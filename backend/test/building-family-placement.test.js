// Exercise the family editors' real placement, mode, history, and save functions without a browser.
// Block and Row are rules on their parcels (user decision 2026-10-18, MEMORY.md): they are never a
// free placement. A move inside the parcels is the rule's own offset; a drop off them asks whether
// to convert to one Freeform building kept there, run the same rule on the parcels there, or put it
// back (proposal-editor-shell.js chooseRuleDrop).
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { parse } from '@babel/parser';

const require = createRequire(import.meta.url);
globalThis.proj4 ||= require('proj4');
const turf = require('@turf/turf');
globalThis.turf ||= turf;
const geometry = require('../../frontend/js/single-building-geometry.js');
const localFrame = require('../../frontend/js/local-frame.js');
const History = require('../../frontend/js/geometry-edit/history.js');

function functionSources(path) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');
    const ast = parse(source, { sourceType: 'script', plugins: ['optionalChaining', 'nullishCoalescingOperator'] });
    const functions = new Map();
    (function walk(node) {
        if (!node || typeof node !== 'object') return;
        if (node.type === 'FunctionDeclaration' && node.id) functions.set(node.id.name, source.slice(node.start, node.end));
        Object.keys(node).forEach(key => {
            if (['loc', 'start', 'end'].includes(key)) return;
            const value = node[key];
            if (Array.isArray(value)) value.forEach(walk); else walk(value);
        });
    })(ast);
    return functions;
}

function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
function rect(west, south, east, north, props = {}) {
    return { type: 'Feature', properties: { height: 12, ...props }, geometry: {
        type: 'Polygon', coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]]
    } };
}
function center(feature) {
    const [lng, lat] = turf.centroid(feature).geometry.coordinates;
    return { lng, lat };
}
function boundsCenter(feature) {
    const coordinates = feature?.geometry?.coordinates?.[0] || [];
    const open = coordinates.slice(0, -1);
    const lngs = open.map(point => point[0]);
    const lats = open.map(point => point[1]);
    return {
        lng: (Math.min(...lngs) + Math.max(...lngs)) / 2,
        lat: (Math.min(...lats) + Math.max(...lats)) / 2
    };
}

function rowHarness() {
    const functions = functionSources('../../frontend/js/row-house.js');
    const feature = rect(15.9999, 44.99995, 16.0001, 45.00005, { type: 'proposedRowHouse', length: 16, width: 8 });
    const site = rect(15.999, 44.999, 16.001, 45.001, { id: 'site' });
    const movedFeatures = [];
    const documentHandlers = new Map();
    let polygonEditorOptions = null;
    const domElements = new Map();
    const document = {
        getElementById: id => {
            if (!domElements.has(id)) domElements.set(id, { disabled: false, value: '', textContent: '', setAttribute() {} });
            return domElements.get(id);
        },
        addEventListener(name, handler) { documentHandlers.set(name, handler); },
        removeEventListener(name, handler) { if (documentHandlers.get(name) === handler) documentHandlers.delete(name); }
    };
    const window = {
        SingleBuildingGeometry: geometry,
        LocalFrame: localFrame,
        GeometryEditHistory: History,
        PolygonGeometryEditor: {
            openRing: ring => ring.slice(0, -1),
            create: options => { window.__polygonOptions = options; return { destroy() {} }; }
        }
    };
    const context = {
        window, document, documentHandlers, turf, CbFormat: { formatNumber: value => String(value) },
        L: { DomEvent: { stopPropagation() {} } },
        translateRowHouseText: (_key, fallback) => fallback,
        rowHouseModal: { handlePane: 'handles', setPreview() {} },
        rowHouseMap: {
            dragging: { disable() {}, enable() {} },
            mouseEventToContainerPoint: event => event,
            containerPointToLatLng: point => (Number.isFinite(point.lat) && Number.isFinite(point.lng) ? point : { lat: 45 + point.clientY * 0.00001, lng: 16 + point.clientX * 0.00001 })
        },
        rowHouseBuildingLayer: { eachLayer: fn => fn({ setLatLngs() {} }) },
        generatedRowHouseFeature: clone(feature), rowHouseBlock: { site, generatorSite: site, parcels: [{ feature: site }] },
        rowHousePolygonEditor: null, rowHousePendingVertexActionIndex: null,
        rowHouseHistory: null, rowHouseManualMode: false,
        currentBuildingLength: 16, currentBuildingWidth: 8, currentBuildingHeight: 12, currentChamfer: 0,
        currentOffsetX: 0, currentOffsetY: 0, currentRotation: 0, baseRotation: 0,
        cachedCentroid: [16.0001, 45.00005], cachedMetersPerDegLng: localFrame.makeLocalFrame(16.0001, 45.00005).metersPerDegLng,
        cachedMetersPerDegLat: localFrame.makeLocalFrame(16.0001, 45.00005).metersPerDegLat,
        dragStartLatLng: null, dragStartOffset: null, dragStartFeature: null, dragLastValidFeature: null,
        isDragging: false, rowHouseGenerationTimer: null,
        rowHouseBuildingLayer: null,
        currentRowRule: () => ({ kind: 'exact', maxHeightM: 12 }),
        getRowHouseDisplayName: () => 'row test',
        displayRowHouseBuildingInModal: vi.fn(), autosaveRowHouseDraft: vi.fn(), updateBuildingMetrics: vi.fn(),
        setRowHouseInfo() {},
        CbFormat: { formatNumber: value => String(value) },
        rowHousePlacementUpdates: movedFeatures,
        turf,
        console
    };
    const source = `
        let window=this.window, document=this.document, documentHandlers=this.documentHandlers, turf=this.turf, L=this.L, CbFormat=this.CbFormat;
        let rowHouseModal=this.rowHouseModal, rowHouseMap=this.rowHouseMap, rowHouseBuildingLayer=this.rowHouseBuildingLayer;
        let generatedRowHouseFeature=this.generatedRowHouseFeature, rowHouseBlock=this.rowHouseBlock;
        let rowHousePolygonEditor=null, rowHousePendingVertexActionIndex=null, rowHouseHistory=null, rowHouseManualMode=false;
        let currentBuildingLength=this.currentBuildingLength, currentBuildingWidth=this.currentBuildingWidth;
        let currentBuildingHeight=this.currentBuildingHeight, currentChamfer=this.currentChamfer;
        let currentOffsetX=this.currentOffsetX, currentOffsetY=this.currentOffsetY, currentRotation=this.currentRotation;
        let baseRotation=this.baseRotation, cachedCentroid=this.cachedCentroid, cachedSuperparcel=this.rowHouseBlock.site, rowVariationSeed=1;
        let cachedMetersPerDegLng=this.cachedMetersPerDegLng, cachedMetersPerDegLat=this.cachedMetersPerDegLat;
        let dragStartLatLng=null, dragEndLatLng=null, dragStartOffset=null, dragStartFeature=null, dragLastValidFeature=null, isDragging=false;
        const DEFAULT_BUILDING_LENGTH=40, DEFAULT_BUILDING_WIDTH=10, DEFAULT_BUILDING_HEIGHT=12;
        const DEFAULT_CHAMFER=0;
        const cloneRowHouseFeature=${functions.get('cloneRowHouseFeature')};
        const rowHouseOuterRing=${functions.get('rowHouseOuterRing')};
        const rowHouseFeatureWithRing=${functions.get('rowHouseFeatureWithRing')};
        const rowHouseFeatureValid=${functions.get('rowHouseFeatureValid')};
        const rowHousePointerEvent=${functions.get('rowHousePointerEvent')};
        const rowHouseSiteBoundary=${functions.get('rowHouseSiteBoundary')};
        let cachedSuperparcelMeters=null;
        const ROW_SITE_OVERLAP_MIN_M2=1;
        const pointInPolygon=${functions.get('pointInPolygon')};
        const pointToSegmentDistance=${functions.get('pointToSegmentDistance')};
        const distanceToPolygonBoundary=${functions.get('distanceToPolygonBoundary')};
        const checkBuildingFitsInSuperparcel=${functions.get('checkBuildingFitsInSuperparcel')};
        const rowHouseSiteHasFit=${functions.get('rowHouseSiteHasFit')};
        const rowHouseOverlapsSite=${functions.get('rowHouseOverlapsSite')};
        const rowHouseFitsSite=${functions.get('rowHouseFitsSite')};
        const resolveRowHouseDrop=${functions.get('resolveRowHouseDrop')};
        const closeRowHouseModal=(...args)=>this.closed.push(args);
        const rowHouseGeometrySnapshot=${functions.get('rowHouseGeometrySnapshot')};
        const restoreRowHouseGeometrySnapshot=${functions.get('restoreRowHouseGeometrySnapshot')};
        const syncRowHouseGeometryControls=${functions.get('syncRowHouseGeometryControls')};
        const rotateRowHouseFootprint=${functions.get('rotateRowHouseFootprint')};
        const latLngToMeters=${functions.get('latLngToMeters')};
        const startDrag=${functions.get('startDrag')};
        const onDragMove=${functions.get('onDragMove')};
        const onDragEnd=${functions.get('onDragEnd')};
        const destroyRowHousePolygonEditor=${functions.get('destroyRowHousePolygonEditor')};
        const renderRowHousePolygonEditor=${functions.get('renderRowHousePolygonEditor')};
        const commitRowHousePolygonRing=${functions.get('commitRowHousePolygonRing')};
        const displayRowHouseBuildingInModal=this.displayRowHouseBuildingInModal;
        const autosaveRowHouseDraft=this.autosaveRowHouseDraft;
        const updateBuildingMetrics=this.updateBuildingMetrics;
        const currentRowRule=this.currentRowRule, getRowHouseDisplayName=this.getRowHouseDisplayName;
        const translateRowHouseText=this.translateRowHouseText, setRowHouseInfo=this.setRowHouseInfo;
        const rowHouseHistoryFactory=window.GeometryEditHistory;
        rowHouseHistory=rowHouseHistoryFactory.create({capture:rowHouseGeometrySnapshot,restore:restoreRowHouseGeometrySnapshot});
        this.state=()=>({feature:generatedRowHouseFeature,manual:rowHouseManualMode,offsetX:currentOffsetX,offsetY:currentOffsetY,rotation:currentRotation});
        this.useFeature=feature=>{ generatedRowHouseFeature=cloneRowHouseFeature(feature); };
        this.move=(start,to)=>{ startDrag({latlng:start,originalEvent:{target:null}}); onDragMove(to); return onDragEnd(); };
        this.touchDrag=async (start,coord)=>{ const native={target:null,touches:[coord],changedTouches:[coord],preventDefault(){this.prevented=true;}}; startDrag({latlng:start,originalEvent:native}); documentHandlers.get('touchmove')(native); await documentHandlers.get('touchend')({}); return {prevented:native.prevented,feature:generatedRowHouseFeature}; };
        this.rotate=delta=>rotateRowHouseFootprint(delta);
        this.edit=ring=>{ renderRowHousePolygonEditor(); window.__polygonOptions.onDragStart(); return window.__polygonOptions.onCommit({ring,reason:'move',vertexIndex:1}); };
        this.undo=()=>rowHouseHistory.undo();
        this.history=()=>rowHouseHistory;
        this.control=id=>document.getElementById(id);
        this.generate=(block,length,width,chamfer,x,y,rotation)=>generateRowHousePolygon(block,length,width,chamfer,x,y,rotation);
    `;
    const dependencies = `
        const rowHouseGeneratorSite=${functions.get('rowHouseGeneratorSite')};
        const robustUnionLocal=${functions.get('robustUnionLocal')};
        const toSingleLargestPolygonLocal=${functions.get('toSingleLargestPolygonLocal')};
        const generateRowHousePolygon=${functions.get('generateRowHousePolygon')};
    `;
    context.closed = [];
    context.window.UrbanRuleVariation = { massingWithRule: value => clone(value) };
    context.window.__siteDraft = require('../../frontend/js/proposals/site-draft.js');
    vm.runInNewContext(source + dependencies, context);
    return context;
}




function openBlockHarness() {
    const functions = functionSources('../../frontend/js/building-blocks.js');
    const showBlockifyModal = vi.fn(() => true);
    const blockifyClone = clone;
    const context = {
        window: {},
        updateStatus: vi.fn(),
        translateBuildingText: (_key, fallback) => fallback,
        robustUnion: features => features[0] || null,
        describeParcelSelection: () => 'Placement site',
        showBlockifyModal,
        deepCloneBuildingFeature: blockifyClone
    };
    const source = `
        let window=this.window, blockifySeedState=null, blockifyAuthoredSite=null, blockifyGenerationSite=null;
        let blockifyBlock=null, blockifyBlockNameOverride=null;
        const updateStatus=this.updateStatus, translateBuildingText=this.translateBuildingText;
        const robustUnion=this.robustUnion, describeParcelSelection=this.describeParcelSelection;
        const showBlockifyModal=this.showBlockifyModal, deepCloneBuildingFeature=this.deepCloneBuildingFeature;
        const normalizeBlockifySite=${functions.get('normalizeBlockifySite')};
        const openUrbanRuleForParcels=${functions.get('openUrbanRuleForParcels')};
        this.open=options=>openUrbanRuleForParcels(options);
        this.block=()=>blockifyBlock;
        this.show=showBlockifyModal;
    `;
    vm.runInNewContext(source, context);
    return context;
}

// The Block editor's massing drag and drop, with the shell's choice and conversion stubbed.
function blockDropHarness(answer) {
    const functions = functionSources('../../frontend/js/building-blocks.js');
    const documentHandlers = new Map();
    const feature = rect(15.9999, 44.99995, 16.0001, 45.00005, { height: 18 });
    const site = rect(15.9998, 44.9999, 16.0002, 45.0001, { id: 'site' });
    const dragging = { active: true, enabled() { return this.active; }, disable() { this.active = false; }, enable() { this.active = true; } };
    const chooseRuleDrop = vi.fn(async options => {
        if (answer === 'convert') await options.tryConvert();
        return answer;
    });
    const convertActiveDesignToFreeform = vi.fn(() => ({ ok: true }));
    const context = {
        turf, console,
        window: {
            SingleBuildingGeometry: geometry, LocalFrame: localFrame, chooseRuleDrop, convertActiveDesignToFreeform,
            UrbanRuleVariation: { massingWithRule: value => clone(value) },
            __siteDraft: require('../../frontend/js/proposals/site-draft.js')
        },
        generatedBuildingFeature: clone(feature), blockifyDragState: null, blockifyGenerationSite: site,
        blockifyModal: {},
        blockifyMap: {
            dragging,
            mouseEventToContainerPoint: event => event,
            containerPointToLatLng: point => ({ lat: 45 + point.clientY * 0.00001, lng: 16 + point.clientX * 0.00001 })
        },
        blockifyMode: 'parametric',
        blockifyPolygonEditor: null,
        document: {
            addEventListener(name, fn) { documentHandlers.set(name, fn); },
            removeEventListener(name, fn) { if (documentHandlers.get(name) === fn) documentHandlers.delete(name); }
        },
        L: { DomEvent: { stopPropagation() {} } },
        closed: [],
        clearGapWingHandles() {}, displayBuildingInModal() {}, renderManualPolygonEditor() {}, renderGapWingHandles() {}
    };
    const source = `
        let window=this.window, turf=this.turf, console=this.console, document=this.document, L=this.L;
        const documentHandlers=this.documentHandlers;
        let generatedBuildingFeature=this.generatedBuildingFeature, blockifyDragState=this.blockifyDragState;
        let blockifyModal=this.blockifyModal, blockifyMap=this.blockifyMap, blockifyMode=this.blockifyMode;
        let blockifyPolygonEditor=this.blockifyPolygonEditor, blockifyGenerationSite=this.blockifyGenerationSite;
        let blockifyAuthoredSite=null, lastSuperparcel=null, blockVariationSeed=3;
        const clearGapWingHandles=this.clearGapWingHandles, displayBuildingInModal=this.displayBuildingInModal;
        const renderManualPolygonEditor=this.renderManualPolygonEditor, renderGapWingHandles=this.renderGapWingHandles;
        const currentBlockRule=()=>({ kind: 'exact', maxHeightM: 18 });
        const closeBlockifyModal=(...args)=>this.closed.push(args);
        const blockifyRuleAtOutline=outline=>({ ok: true, outline });
        const blockifyClone=${functions.get('blockifyClone')};
        const blockifyDesignBoundary=${functions.get('blockifyDesignBoundary')};
        const blockifyPointerEvent=${functions.get('blockifyPointerEvent')};
        const startBlockifyMassMove=${functions.get('startBlockifyMassMove')};
        const moveBlockifyMass=${functions.get('moveBlockifyMass')};
        const blockifyStopMassMoveListeners=${functions.get('blockifyStopMassMoveListeners')};
        const finishBlockifyMassMove=${functions.get('finishBlockifyMassMove')};
        this.touchDrag=async (start,coordinate)=>{
            const native={target:null,touches:[coordinate],changedTouches:[coordinate],preventDefault(){this.prevented=true;}};
            startBlockifyMassMove({latlng:start,originalEvent:native});
            documentHandlers.get('touchmove')(native);
            await documentHandlers.get('touchend')({});
            return {prevented:native.prevented,feature:generatedBuildingFeature,dragging:this.blockifyMap.dragging.active};
        };
    `;
    context.documentHandlers = documentHandlers;
    vm.runInNewContext(source, context);
    return context;
}

describe('building-family rules stay on their parcels', () => {
    it('stores block typology and never a free placement on draft autosaves and completed designs', () => {
        const source = readFileSync(new URL('../../frontend/js/building-blocks.js', import.meta.url), 'utf8');
        const autosave = source.slice(source.indexOf('function autosaveBlockifyDraft('), source.indexOf('// Function to display the building in the modal'));
        const save = source.slice(source.indexOf('async function saveBlockifyDesignForProposal()'));
        expect(autosave.match(/typology: 'block'/g)).toHaveLength(2);
        expect(save.match(/typology: 'block'/g)).toHaveLength(2);
        [autosave, save].forEach(text => {
            expect(text).toContain('placement: { free: false, site: blockifyClone(blockifyDesignBoundary()) }');
            expect(text).not.toContain('free: true');
            expect(text).not.toContain('placementBaseSite');
            expect(text).not.toContain('placementTransform');
        });
    });

    it('opens the block editor with an authored site and no parcel IDs', () => {
        const h = openBlockHarness();
        const site = rect(15.999, 44.999, 16.001, 45.001);
        expect(h.open({ parcelIds: [], site })).toBe(true);
        expect(h.show).toHaveBeenCalledTimes(1);
        expect(h.block().syntheticSite).toBe(true);
        expect(h.block().parcelIds).toEqual([]);
    });

    it('autosaves a row on its own site, never as a free placement', () => {
        const functions = functionSources('../../frontend/js/row-house.js');
        const site = rect(15.999, 44.999, 16.001, 45.001);
        const feature = rect(16.0003, 45, 16.0004, 45.00005, { type: 'proposedRowHouse' });
        const sync = vi.fn();
        const context = {
            window: {
                getActiveProposalDesignDraft: () => ({ adapterKey: 'row' }),
                syncActiveProposalDraftFromEditor: sync,
                UrbanRuleVariation: { massingWithRule: (value, urbanRule, seed) => ({ ...value, properties: { ...(value.properties || {}), massing: true, urbanRule, variationSeed: seed } }) }
            },
            turf,
            feature, block: { parcels: [{ feature: site }], syntheticSite: true, site }
        };
        const source = `
            let window=this.window, turf=this.turf, generatedRowHouseFeature=this.feature, rowHouseBlock=this.block;
            let currentBuildingLength=16, currentBuildingWidth=13, currentBuildingHeight=12, currentChamfer=0;
            let currentOffsetX=31, currentOffsetY=4, currentRotation=0, rowVariationSeed=9, rowHouseManualMode=false;
            let cachedSuperparcel=null, rowHouseSurroundings=null;
            const getActiveRowHouseBlock=()=>rowHouseBlock, getRowHouseDisplayName=()=> 'test row';
            const currentRowRule=()=>({kind:'exact'});
            const cloneRowHouseFeature=${functions.get('cloneRowHouseFeature')};
            const rowHouseSiteBoundary=${functions.get('rowHouseSiteBoundary')};
            const autosaveRowHouseDraft=${functions.get('autosaveRowHouseDraft')};
            this.save=()=>autosaveRowHouseDraft();
        `;
        vm.runInNewContext(source, context);
        context.save();
        expect(sync).toHaveBeenCalledOnce();
        const payload = sync.mock.calls[0][1];
        expect(payload.placement).toEqual({ free: false, site });
        expect(payload.parameters).not.toHaveProperty('placementBaseSite');
        expect(payload.parameters).toMatchObject({ offsetX: 31, offsetY: 4 });
        expect(payload.buildingFeature.properties.variationSeed).toBe(9);
    });

    it('a row moved inside its parcels keeps that offset through a width change, with no dialog', async () => {
        const h = rowHarness();
        const site = h.rowHouseBlock.site;
        const original = h.generate({ site, parcels: [{ feature: site }] }, 16, 13, 0, 0, 0, 0);
        h.useFeature(original);
        const start = center(original);
        h.window.chooseRuleDrop = vi.fn();
        await h.move(start, { lat: start.lat, lng: start.lng + 0.0002 });
        expect(h.window.chooseRuleDrop).not.toHaveBeenCalled();
        const moved = h.state().feature;
        expect(h.state().offsetX).toBeGreaterThan(0);
        const resized = h.generate({ site, parcels: [{ feature: site }] }, 16, 15, 0, h.state().offsetX, h.state().offsetY, h.state().rotation);
        expect(center(resized).lng).toBeCloseTo(center(moved).lng, 6);
        expect(center(resized).lat).toBeCloseTo(center(moved).lat, 6);
        expect(resized.properties.width).toBe(15);
    });

    it('a row dropped off its parcels asks, and Put it back restores the footprint and offset', async () => {
        const h = rowHarness();
        const before = clone(h.state().feature);
        h.window.chooseRuleDrop = vi.fn(async () => 'cancel');
        await h.move(center(before), { lat: center(before).lat, lng: center(before).lng + 0.01 });
        expect(h.window.chooseRuleDrop).toHaveBeenCalledOnce();
        expect(h.window.chooseRuleDrop.mock.calls[0][0].typology).toBe('row');
        expect(h.state().feature.geometry).toEqual(before.geometry);
        expect(h.state().offsetX).toBe(0);
        expect(h.closed).toEqual([]);
    });

    it('a row dropped off its parcels converts to Freeform at the drop and closes as Done', async () => {
        const h = rowHarness();
        const before = clone(h.state().feature);
        const convert = vi.fn(() => ({ ok: true }));
        h.window.convertActiveDesignToFreeform = convert;
        h.window.chooseRuleDrop = vi.fn(async options => { await options.tryConvert(); return 'convert'; });
        await h.move(center(before), { lat: center(before).lat, lng: center(before).lng + 0.01 });
        expect(convert).toHaveBeenCalledOnce();
        const { features, site } = convert.mock.calls[0][0];
        expect(center(features[0]).lng).toBeCloseTo(center(before).lng + 0.01, 6);
        expect(site.type).toBe('MultiPolygon');
        expect(h.closed).toEqual([[{ preservePending: true }]]);
    });

    it('moves and rotates a generated row inside its parcels without entering manual mode', async () => {
        const h = rowHarness();
        const before = center(h.state().feature);
        await h.move({ lat: before.lat, lng: before.lng }, { lat: before.lat + 0.0002, lng: before.lng + 0.0003 });
        expect(h.state().manual).toBe(false);
        expect(h.state().offsetX).not.toBe(0);
        const moved = h.state().feature;
        h.rotate(5);
        expect(h.state().manual).toBe(false);
        expect(h.state().rotation).toBeCloseTo(5 * Math.PI / 180);
        expect(h.state().feature.geometry).not.toEqual(moved.geometry);
    });

    it('moves a row from document touch events and restores map dragging at touchend', async () => {
        const h = rowHarness();
        const before = center(h.state().feature);
        const result = await h.touchDrag({ lat: before.lat, lng: before.lng }, { clientX: 30, clientY: 10 });
        expect(result.prevented).toBe(true);
        expect(h.state().manual).toBe(false);
        expect(center(result.feature).lng).toBeGreaterThan(before.lng);
        expect(h.control('rowhouse-length-slider').disabled).toBe(false);
    });

    it('marks an edited row manual, disables shape controls, and undo restores the original coordinates and generated mode', () => {
        const h = rowHarness();
        const before = clone(h.state().feature);
        const ring = clone(before.geometry.coordinates[0]);
        ring[1][0] += 0.00004;
        expect(h.edit(ring)).toBe(true);
        expect(h.state().manual).toBe(true);
        expect(h.control('rowhouse-length-slider').disabled).toBe(true);
        expect(h.control('rowhouse-width-slider').disabled).toBe(true);
        expect(h.control('rowhouse-chamfer-slider').disabled).toBe(true);
        expect(h.control('rowhouse-height-slider').disabled).toBe(false);
        expect(h.state().feature.geometry).not.toEqual(before.geometry);
        expect(h.undo()).toBe(true);
        expect(h.state().feature.geometry).toEqual(before.geometry);
        expect(h.state().manual).toBe(false);
        expect(h.control('rowhouse-length-slider').disabled).toBe(false);
        expect(h.history().depth()).toBe(0);
    });

    it('a block massing dropped anywhere asks; Put it back restores it and map dragging', async () => {
        const h = blockDropHarness('cancel');
        const before = clone(h.generatedBuildingFeature);
        const result = await h.touchDrag(center(before), { clientX: 30, clientY: 10 });
        expect(result.prevented).toBe(true);
        expect(h.window.chooseRuleDrop).toHaveBeenCalledOnce();
        expect(h.window.chooseRuleDrop.mock.calls[0][0].typology).toBe('block');
        expect(result.feature.geometry).toEqual(before.geometry);
        expect(result.dragging).toBe(true);
        expect(h.closed).toEqual([]);
    });

    it('a block massing dropped and converted becomes a Freeform at the drop, and the editor closes as Done', async () => {
        const h = blockDropHarness('convert');
        const before = clone(h.generatedBuildingFeature);
        await h.touchDrag(center(before), { clientX: 30, clientY: 10 });
        expect(h.window.convertActiveDesignToFreeform).toHaveBeenCalledOnce();
        const { features, site } = h.window.convertActiveDesignToFreeform.mock.calls[0][0];
        expect(center(features[0]).lng).toBeGreaterThan(center(before).lng);
        // The site moved with it: the old site's outline, translated to the drop.
        expect(turf.area(turf.feature(site))).toBeCloseTo(turf.area(h.blockifyGenerationSite), 0);
        expect(h.closed).toEqual([[{ preservePending: true }]]);
    });
});
