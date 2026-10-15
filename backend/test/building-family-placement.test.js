// Exercise the family editors' real placement, mode, history, and save functions without a browser.
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { parse } from '@babel/parser';

const require = createRequire(import.meta.url);
globalThis.proj4 ||= require('proj4');
const turf = require('@turf/turf');
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
        rowHouseModal: { placement: {
            locked: false,
            accepts: () => true,
            update: vi.fn(value => movedFeatures.push(clone(value))),
            moveGeometry: vi.fn((value, from, to, event) => geometry.moveGeometry(value, from, to, event))
        }, handlePane: 'handles', setPreview() {} },
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
        let dragStartLatLng=null, dragStartOffset=null, dragStartFeature=null, dragLastValidFeature=null, isDragging=false;
        const DEFAULT_BUILDING_LENGTH=40, DEFAULT_BUILDING_WIDTH=10, DEFAULT_BUILDING_HEIGHT=12;
        const DEFAULT_CHAMFER=0;
        const cloneRowHouseFeature=${functions.get('cloneRowHouseFeature')};
        const rowHouseOuterRing=${functions.get('rowHouseOuterRing')};
        const rowHouseFeatureWithRing=${functions.get('rowHouseFeatureWithRing')};
        const rowHouseFeatureValid=${functions.get('rowHouseFeatureValid')};
        const rowHousePointerEvent=${functions.get('rowHousePointerEvent')};
        const rowHousePlacementLocked=${functions.get('rowHousePlacementLocked')};
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
        this.move=(start,to)=>{ startDrag({latlng:start,originalEvent:{target:null}}); onDragMove(to); onDragEnd(); };
        this.touchDrag=(start,coord)=>{ const native={target:null,touches:[coord],changedTouches:[coord],preventDefault(){this.prevented=true;}}; startDrag({latlng:start,originalEvent:native}); documentHandlers.get('touchmove')(native); documentHandlers.get('touchend')({}); return {prevented:native.prevented,feature:generatedRowHouseFeature}; };
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
        let blockifyPlacementSite=null, blockifyBlock=null, blockifyBlockNameOverride=null;
        const updateStatus=this.updateStatus, translateBuildingText=this.translateBuildingText;
        const robustUnion=this.robustUnion, describeParcelSelection=this.describeParcelSelection;
        const showBlockifyModal=this.showBlockifyModal, deepCloneBuildingFeature=this.deepCloneBuildingFeature;
        const normalizeBlockifySite=${functions.get('normalizeBlockifySite')};
        const blockifyGenerationBaseSite=${functions.get('blockifyGenerationBaseSite')};
        const openUrbanRuleForParcels=${functions.get('openUrbanRuleForParcels')};
        this.open=options=>openUrbanRuleForParcels(options);
        this.block=()=>blockifyBlock;
        this.show=showBlockifyModal;
    `;
    vm.runInNewContext(source, context);
    return context;
}

function blockTouchHarness() {
    const functions = functionSources('../../frontend/js/building-blocks.js');
    const documentHandlers = new Map();
    const feature = rect(15.9999, 44.99995, 16.0001, 45.00005, { height: 18 });
    const dragging = { active: true, enabled() { return this.active; }, disable() { this.active = false; }, enable() { this.active = true; } };
    const moveGeometry = vi.fn((value, from, to) => geometry.moveGeometry(value, from, to));
    const context = {
        turf, console,
        window: { SingleBuildingGeometry: geometry, LocalFrame: localFrame },
        generatedBuildingFeature: clone(feature), blockifyDragState: null,
        blockifyModal: { placement: { moveGeometry, accepts: () => true, update: vi.fn() } },
        blockifyMap: {
            dragging,
            mouseEventToContainerPoint: event => event,
            containerPointToLatLng: point => ({ lat: 45 + point.clientY * 0.00001, lng: 16 + point.clientX * 0.00001 })
        },
        blockifyHistory: { record: vi.fn(), discardLast: vi.fn() },
        blockifyPlacementTransform: { translationMeters: [0, 0], rotationDegrees: 0 },
        blockifyMode: 'parametric', manualOuterRing: [],
        blockifyPolygonEditor: null,
        blockifyBuildingLayer: { eachLayer: () => {} },
        blockifyPointerEvent: null,
        document: {
            addEventListener(name, fn) { documentHandlers.set(name, fn); },
            removeEventListener(name, fn) { if (documentHandlers.get(name) === fn) documentHandlers.delete(name); }
        },
        L: { DomEvent: { stopPropagation() {} } },
        clearGapWingHandles() {}, displayBuildingInModal() {}, renderManualPolygonEditor() {}, renderGapWingHandles() {}, autosaveBlockifyDraft() {}
    };
    const source = `
        let window=this.window, turf=this.turf, console=this.console, document=this.document, L=this.L;
        let generatedBuildingFeature=this.generatedBuildingFeature, blockifyDragState=this.blockifyDragState;
        let blockifyModal=this.blockifyModal, blockifyMap=this.blockifyMap, blockifyHistory=this.blockifyHistory;
        let blockifyPlacementTransform=this.blockifyPlacementTransform, blockifyMode=this.blockifyMode;
        let manualOuterRing=this.manualOuterRing, blockifyPolygonEditor=this.blockifyPolygonEditor;
        let blockifyBuildingLayer=this.blockifyBuildingLayer;
        const clearGapWingHandles=this.clearGapWingHandles, displayBuildingInModal=this.displayBuildingInModal;
        const renderManualPolygonEditor=this.renderManualPolygonEditor, renderGapWingHandles=this.renderGapWingHandles;
        const autosaveBlockifyDraft=this.autosaveBlockifyDraft;
        const blockifyClone=${functions.get('blockifyClone')};
        const blockifyOuterRing=${functions.get('blockifyOuterRing')};
        const blockifyPointerEvent=${functions.get('blockifyPointerEvent')};
        const startBlockifyMassMove=${functions.get('startBlockifyMassMove')};
        const moveBlockifyMass=${functions.get('moveBlockifyMass')};
        const finishBlockifyMassMove=${functions.get('finishBlockifyMassMove')};
        this.touchDrag=(start,coordinate)=>{
            const native={target:null,touches:[coordinate],changedTouches:[coordinate],preventDefault(){this.prevented=true;}};
            startBlockifyMassMove({latlng:start,originalEvent:native});
            documentHandlers.get('touchmove')(native);
            documentHandlers.get('touchend')({});
            return {prevented:native.prevented,feature:generatedBuildingFeature,dragging:this.blockifyMap.dragging.active};
        };
        this.moveGeometry=this.blockifyModal.placement.moveGeometry;
    `;
    context.documentHandlers = documentHandlers;
    vm.runInNewContext(source, context);
    return context;
}

function blockHarness() {
    const functions = functionSources('../../frontend/js/building-blocks.js');
    const copyFunctions = functionSources('../../frontend/js/proposals/copy.js');
    const moveGeometry = vi.fn((value, from, to) => geometry.moveGeometry(value, from, to));
    const placementMove = vi.fn(() => { throw new Error('Regeneration must not invoke snapping'); });
    const context = {
        turf,
        window: { SingleBuildingGeometry: geometry, LocalFrame: localFrame },
        blockifyClone: clone,
        normalizeBlockifySite: site => site?.type === 'Feature' ? clone(site) : null,
        blockifyModal: { placement: { moveGeometry: placementMove } },
        blockifyPlacementTransform: { translationMeters: [38, -12], rotationDegrees: 5 },
        blockifyGenerationSite: null,
        geometryMove: moveGeometry
    };
    const source = `
        let window=this.window, turf=this.turf;
        let blockifyClone=this.blockifyClone, normalizeBlockifySite=this.normalizeBlockifySite;
        let blockifyModal=this.blockifyModal;
        let blockifyPlacementTransform=this.blockifyPlacementTransform;
        let blockifyGenerationSite=null, blockifyMode='parametric';
        let currentSetback=2, currentBuildingWidth=15, currentBuildingHeight=17.5, currentChamferM=0, currentSimplifyM=0;
        let gapPositions=[], wingPositions=[], blockRuleKind='exact', blockMinHeightM=0, blockMinDepthM=0, blockMinPlotAreaM2=50, blockVariationSeed=1;
        let existingRule='exact', currentProposedHeightFloors=5, currentAdditionalFloors=0, currentFloorHeightM=3.5, manualOuterRing=[];
        const document={getElementById:()=>null};
        const syncBlockifyControlsFromState=()=>{}, setFootprintSlidersEnabled=()=>{}, updateManualToggleLabel=()=>{};
        const blockifyGenerationBaseSite=${functions.get('blockifyGenerationBaseSite')};
        const applyBlockifySeedState=${functions.get('applyBlockifySeedState')};
        const buildBlockifySeed=${copyFunctions.get('buildBlockifySeed')};
        const applyBlockifyPlacementTransform=${functions.get('applyBlockifyPlacementTransform')};
        this.reopen=(parameters,currentSite)=>{
            const seed=buildBlockifySeed({parameters,buildingFeature:currentSite});
            blockifyGenerationSite=blockifyGenerationBaseSite(seed.placementBaseSite,currentSite,currentSite);
            applyBlockifySeedState(seed);
            return blockifyClone(blockifyGenerationSite);
        };
        this.regenerate=(width=currentBuildingWidth)=>{
            const [lng,lat]=turf.centroid(blockifyGenerationSite).geometry.coordinates;
            const frame=window.LocalFrame.makeLocalFrame(lng,lat);
            const halfX=width/(2*frame.metersPerDegLng), halfY=8/(2*frame.metersPerDegLat);
            const feature={type:'Feature',properties:{width},geometry:{type:'Polygon',coordinates:[[[lng-halfX,lat-halfY],[lng+halfX,lat-halfY],[lng+halfX,lat+halfY],[lng-halfX,lat+halfY],[lng-halfX,lat-halfY]]]}};
            return applyBlockifyPlacementTransform(feature);
        };
        this.sliderRegenerate=(width)=>{ currentBuildingWidth=width; return this.regenerate(); };
        this.snappedMove=blockifyModal.placement.moveGeometry;
    `;
    vm.runInNewContext(source, context);
    return context;
}

describe('building-family free placement', () => {
    it('stores block typology on both draft autosaves and completed non-existing designs', () => {
        const source = readFileSync(new URL('../../frontend/js/building-blocks.js', import.meta.url), 'utf8');
        const autosave = source.slice(source.indexOf('function autosaveBlockifyDraft('), source.indexOf('// Function to display the building in the modal'));
        const save = source.slice(source.indexOf('async function saveBlockifyDesignForProposal()'));
        expect(autosave.match(/typology: 'block'/g)).toHaveLength(2);
        expect(save.match(/typology: 'block'/g)).toHaveLength(2);
        expect(autosave).toContain("...(blockifyMode !== 'existing' ? { placement:");
        expect(save).toContain("...(blockifyMode !== 'existing' ? { placement:");
        expect(autosave).toContain('free: true');
        expect(save).toContain('free: true');
    });

    it('opens the block editor with an authored site and no parcel IDs', () => {
        const h = openBlockHarness();
        const site = rect(15.999, 44.999, 16.001, 45.001);
        expect(h.open({ parcelIds: [], site })).toBe(true);
        expect(h.show).toHaveBeenCalledTimes(1);
        expect(h.block().syntheticSite).toBe(true);
        expect(h.block().parcelIds).toEqual([]);
    });

    it('autosaves the current moved row as a fresh free site even while the optional lock is enabled', () => {
        const functions = functionSources('../../frontend/js/row-house.js');
        const site = rect(15.999, 44.999, 16.001, 45.001);
        const feature = rect(16.0003, 45, 16.0004, 45.00005, { type: 'proposedRowHouse' });
        const sync = vi.fn();
        const rule = { kind: 'exact' };
        const context = {
            window: {
                getActiveProposalDesignDraft: () => ({ adapterKey: 'row' }),
                syncActiveProposalDraftFromEditor: sync,
                UrbanRuleVariation: {
                    massingWithRule: (value, urbanRule, seed) => ({
                        ...value,
                        properties: {
                            ...(value.properties || {}),
                            massing: true,
                            urbanRule,
                            variationSeed: seed
                        }
                    })
                }
            },
            turf,
            feature, block: { parcels: [{ feature: site }], syntheticSite: true, site, generatorSite: site }
        };
        const source = `
            let window=this.window, turf=this.turf, generatedRowHouseFeature=this.feature, rowHouseBlock=this.block;
            let currentBuildingLength=16, currentBuildingWidth=13, currentBuildingHeight=12, currentChamfer=0;
            let currentOffsetX=31, currentOffsetY=4, currentRotation=0, rowVariationSeed=9, rowHouseManualMode=false;
            let cachedSuperparcel=this.block.generatorSite;
            const getActiveRowHouseBlock=()=>rowHouseBlock, getRowHouseDisplayName=()=> 'test row';
            const rowHousePlacementLocked=()=>true, currentRowRule=()=>({kind:'exact'});
            const cloneRowHouseFeature=${functions.get('cloneRowHouseFeature')};
            const autosaveRowHouseDraft=${functions.get('autosaveRowHouseDraft')};
            this.save=()=>autosaveRowHouseDraft();
        `;
        vm.runInNewContext(source, context);
        context.save();
        expect(sync).toHaveBeenCalledOnce();
        const payload = sync.mock.calls[0][1];
        expect(payload.placement.free).toBe(true);
        expect(payload.placement.site.geometry).toEqual(feature.geometry);
        expect(payload.placement.site.properties.massing).toBe(true);
        expect(payload.placement.site.properties.urbanRule).toEqual(rule);
        expect(payload.placement.site.properties.variationSeed).toBe(9);
        expect(payload.buildingFeature.geometry).toEqual(feature.geometry);
        expect(payload.buildingFeature.properties.urbanRule).toEqual(rule);
        expect(payload.parameters.placementBaseSite).toEqual(site);
    });

    it('reopens a serialized moved generated row from its base site and width changes preserve its center', () => {
        const h = rowHarness();
        const baseSite = rect(15.999, 44.999, 16.001, 45.001);
        const original = h.generate({ site: baseSite, generatorSite: baseSite, parcels: [{ feature: baseSite }] }, 16, 13, 0, 0, 0, 0);
        h.useFeature(original);
        const originalCenter = center(original);
        h.move({ lat: originalCenter.lat, lng: originalCenter.lng }, { lat: originalCenter.lat, lng: originalCenter.lng + 0.0005 });
        const moved = h.state().feature;
        const context = {
            parameters: { length: 16, width: 13, height: 12, offsetX: h.state().offsetX, offsetY: h.state().offsetY,
                rotation: h.state().rotation, manualMode: false, placementBaseSite: baseSite },
            placement: { site: moved, free: true },
            buildings: [moved]
        };
        const reopenedBlock = {
            site: context.placement.site,
            generatorSite: context.parameters.placementBaseSite,
            parcels: [{ feature: context.placement.site }]
        };
        const resized = h.generate(reopenedBlock, context.parameters.length, 15, 0,
            context.parameters.offsetX, context.parameters.offsetY, context.parameters.rotation);
        expect(center(resized).lng).toBeCloseTo(center(moved).lng, 6);
        expect(center(resized).lat).toBeCloseTo(center(moved).lat, 6);
        expect(resized.properties.width).toBe(15);
        expect(context.parameters.manualMode).toBe(false);

        const source = readFileSync(new URL('../../frontend/js/row-house.js', import.meta.url), 'utf8');
        expect(source).toContain('placementBaseSite: cloneRowHouseFeature(block.generatorSite || block.site || cachedSuperparcel)');
    });

    it('stores accepted snapped row movement in offsets and preserves its center after width regeneration', () => {
        const h = rowHarness();
        const baseSite = rect(15.999, 44.999, 16.001, 45.001);
        const original = h.generate({ site: baseSite, generatorSite: baseSite, parcels: [{ feature: baseSite }] }, 16, 13, 0, 0, 0, 0);
        h.useFeature(original);
        const originalCentroid = center(original);
        const snap = { lng: 0.00011, lat: 0.00007 };
        h.rowHouseModal.placement.moveGeometry.mockImplementation((geometryValue, from) => geometry.moveGeometry(
            geometryValue,
            from,
            { lng: from.lng + snap.lng, lat: from.lat + snap.lat }
        ));

        // The raw gesture is deliberately farther than the accepted snapped placement.
        h.move(
            originalCentroid,
            { lng: originalCentroid.lng + 0.00042, lat: originalCentroid.lat + 0.00031 }
        );
        const moved = h.state().feature;
        const movedCentroid = center(moved);
        const frame = localFrame.makeLocalFrame(
            turf.centroid(baseSite).geometry.coordinates[0],
            turf.centroid(baseSite).geometry.coordinates[1]
        );
        const acceptedOffsetX = (movedCentroid.lng - originalCentroid.lng) * frame.metersPerDegLng;
        const acceptedOffsetY = (movedCentroid.lat - originalCentroid.lat) * frame.metersPerDegLat;
        expect(h.state().offsetX).toBeCloseTo(acceptedOffsetX, 6);
        expect(h.state().offsetY).toBeCloseTo(acceptedOffsetY, 6);

        const saved = {
            parameters: { length: 16, width: 13, offsetX: h.state().offsetX, offsetY: h.state().offsetY, rotation: h.state().rotation },
            placement: { site: moved, free: true },
            buildings: [moved]
        };
        const reopened = rowHarness();
        const resized = reopened.generate({
            site: saved.placement.site,
            generatorSite: baseSite,
            parcels: [{ feature: saved.placement.site }]
        }, saved.parameters.length, 15, 0, saved.parameters.offsetX, saved.parameters.offsetY, saved.parameters.rotation);
        expect(boundsCenter(resized).lng).toBeCloseTo(boundsCenter(moved).lng, 10);
        expect(boundsCenter(resized).lat).toBeCloseTo(boundsCenter(moved).lat, 10);
    });

    it('moves and rotates a generated row without entering manual mode and regenerates at its moved frame', () => {
        const h = rowHarness();
        const before = center(h.state().feature);
        h.move({ lat: before.lat, lng: before.lng }, { lat: before.lat + 0.0004, lng: before.lng + 0.0005 });
        expect(h.state().manual).toBe(false);
        expect(h.state().offsetX).not.toBe(0);
        const moved = h.state().feature;
        const site = rect(15.999, 44.999, 16.001, 45.001);
        const regenerated = h.generate({ site, parcels: [{ feature: site }] },
            16, 8, 0, h.state().offsetX, h.state().offsetY, h.state().rotation);
        expect(center(regenerated).lng).toBeCloseTo(center(moved).lng, 6);
        expect(center(regenerated).lat).toBeCloseTo(center(moved).lat, 6);
        h.rotate(5);
        expect(h.state().manual).toBe(false);
        expect(h.state().rotation).toBeCloseTo(5 * Math.PI / 180);
        expect(h.state().feature.geometry).not.toEqual(moved.geometry);
    });

    it('moves a row from document touch events and restores map dragging at touchend', () => {
        const h = rowHarness();
        const before = center(h.state().feature);
        const result = h.touchDrag({ lat: before.lat, lng: before.lng }, { clientX: 30, clientY: 10 });
        expect(result.prevented).toBe(true);
        expect(h.state().manual).toBe(false);
        expect(center(result.feature).lng).toBeGreaterThan(before.lng);
        expect(h.rowHouseModal.placement.moveGeometry).toHaveBeenCalled();
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


    it('moves block massing from document touch events and restores map dragging at touchend', () => {
        const h = blockTouchHarness();
        const before = center(h.generatedBuildingFeature);
        const result = h.touchDrag({ lat: before.lat, lng: before.lng }, { clientX: 30, clientY: 10 });
        expect(result.prevented).toBe(true);
        expect(center(result.feature).lng).toBeGreaterThan(before.lng);
        expect(h.moveGeometry).toHaveBeenCalled();
        expect(result.dragging).toBe(true);
    });

    it('reopens a moved block from its saved generator site and slider regeneration preserves the moved frame', () => {
        const baseSite = rect(15.999, 44.999, 16.001, 45.001);
        const first = blockHarness();
        const savedParameters = { placementBaseSite: baseSite, placementTransform: { translationMeters: [38, -12], rotationDegrees: 5 }, width: 16, mode: 'parametric' };
        first.reopen(savedParameters, baseSite);
        const savedMovedFootprint = first.regenerate();

        // A relocated draft reopens with the moved massing as its visible site and the original
        // generator site/transform retained in parameters.
        const reopened = blockHarness();
        const reopenSite = reopened.reopen(savedParameters, savedMovedFootprint);
        expect(center(reopenSite).lng).toBeCloseTo(center(baseSite).lng, 6);
        const afterSlider = reopened.sliderRegenerate(22);
        expect(center(afterSlider).lng).toBeCloseTo(center(savedMovedFootprint).lng, 6);
        expect(center(afterSlider).lat).toBeCloseTo(center(savedMovedFootprint).lat, 6);
        expect(afterSlider.properties.width).toBe(22);
        expect(afterSlider.geometry).not.toEqual(savedMovedFootprint.geometry);
        expect(reopened.snappedMove).not.toHaveBeenCalled();
        const source = readFileSync(new URL('../../frontend/js/building-blocks.js', import.meta.url), 'utf8');
        const save = source.slice(source.indexOf('async function saveBlockifyDesignForProposal()'));
        expect(save).toContain('placementBaseSite: blockifyClone(blockifyGenerationSite || blockifyDesignBoundary())');
    });
});
