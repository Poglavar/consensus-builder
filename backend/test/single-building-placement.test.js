// Exercise the real single-building drag and placement-site functions without a browser map.
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { parse } from '@babel/parser';

const require = createRequire(import.meta.url);
const turf = require('@turf/turf');
const geometry = require('../../frontend/js/single-building-geometry.js');
const History = require('../../frontend/js/geometry-edit/history.js');
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

function polygon(west, south, east, north) {
    return {
        type: 'Polygon',
        coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]]
    };
}

function feature(id, west, south, east, north) {
    return { type: 'Feature', properties: { id }, geometry: polygon(west, south, east, north) };
}

function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function movementHarness({ moveTogether = true, treatment = 'paved', locked = false } = {}) {
    const buildingEntries = [
        { id: 'building-a', feature: feature('building-a', 0.0002, 0.0002, 0.0004, 0.0004) },
        { id: 'building-b', feature: feature('building-b', 0.0007, 0.0002, 0.0009, 0.0004) }
    ];
    const groundBoundary = feature('source-site', 0, 0, 0.0012, 0.0008);
    const sourceSnapshot = {
        site: clone(groundBoundary.geometry),
        buildings: clone(buildingEntries.map(entry => entry.feature))
    };
    const placementUpdates = [];
    const renderEvents = { ground: vi.fn(), preview: vi.fn(), selectors: vi.fn(), layers: vi.fn() };
    const map = {
        // Leaflet layer points are pixels, so keep movement deltas comfortably over the
        // editor's one-pixel drag threshold while translating back to small GeoJSON offsets.
        latLngToLayerPoint: ({ lat, lng }) => point(lng * 100000, lat * 100000),
        layerPointToLatLng: ({ x, y }) => ({ lng: x / 100000, lat: y / 100000 }),
        off: vi.fn(), on: vi.fn(),
        dragging: { enabled: () => true, enable: vi.fn(), disable: vi.fn() },
        boxZoom: { enabled: () => false, enable: vi.fn(), disable: vi.fn() },
        doubleClickZoom: { enabled: () => true, enable: vi.fn(), disable: vi.fn() }
    };
    const placement = {
        locked,
        moveTarget: (_geometry, _from, to) => to,
        accepts(candidate) {
            return !locked || require('../../frontend/js/single-building-geometry.js')
                .footprintWithinBoundary(candidate, groundBoundary, turf);
        },
        update: vi.fn(value => placementUpdates.push(clone(value)))
    };
    const layers = new Map(buildingEntries.map(entry => [entry.id, {
        eachLayer: callback => callback({ setLatLngs: vi.fn() }),
        getTooltip: () => ({ setLatLng: vi.fn() })
    }]));
    const document = {
        removeEventListener: vi.fn(),
        addEventListener: vi.fn(),
        getElementById: () => null
    };
    const window = {
        GeometryEditHistory: History,
        SingleBuildingGeometry: geometry,
        BuildingGround: { moveDecorationDesign: vi.fn(design => clone(design)) }
    };
    const setActiveFeature = candidate => {
        singleRectFeature = clone(candidate);
        const active = buildingEntries.find(entry => entry.id === activeBuildingId);
        if (active) active.feature = clone(candidate);
    };
    const stubs = {
        document, window, turf, L: { latLng: (lat, lng) => ({ lat, lng }) },
        singleMap: map,
        singleSession: { placement, setPreview: vi.fn() },
        singleEditor: {},
        buildingEntries,
        singleBuildingLayers: layers,
        singleDragMarker: null,
        currentGroundTreatment: treatment,
        currentGroundDecorationDesign: null,
        singleGroundBoundary: groundBoundary,
        singleBlockFeature: clone(groundBoundary),
        singleRectFeature: clone(buildingEntries[0].feature),
        activeBuildingId: 'building-a',
        singleMoveTogether: moveTogether,
        singleHistory: null,
        rectDragActive: true,
        rectDragHistoryRecorded: false,
        rectDragStartDesign: null,
        rectDragStartFeature: clone(buildingEntries[0].feature),
        rectDragLastValidFeature: clone(buildingEntries[0].feature),
        rectDragStartPointerPt: null,
        rectDragStartCenterPt: null,
        dragMapHandlers: null,
        singlePendingVertexActionIndex: null,
        sourceSnapshot,
        placementUpdates,
        renderEvents,
        cloneSingleFeature: clone,
        featureCenterLatLng: value => {
            const [lng, lat] = turf.centroid(value).geometry.coordinates;
            return { lng, lat };
        },
        currentSurroundings: () => null,
        updateGroundPreview: renderEvents.ground,
        updateSingleBuildingPreview: renderEvents.preview,
        refreshBuildingSelector: renderEvents.selectors,
        setActiveBuilding: vi.fn(),
        updateRectangleLayers: renderEvents.layers,
        bindRectangleLayerEvents: vi.fn(),
        singleBuildingLayers: layers,
        rectDragStartCenterPt: null,
        activeBuildingId: 'building-a',
        currentHeightM: 12,
        lastValidCenter: null,
        singleMap: map,
        ensureSingleBuildingHistory: null
    };
    const declared = new Set([
        'singleMap', 'singleEditor', 'singleSession', 'buildingEntries', 'singleBuildingLayers',
        'singleDragMarker', 'currentGroundTreatment', 'currentGroundDecorationDesign', 'singleGroundBoundary',
        'singleBlockFeature', 'singleRectFeature', 'activeBuildingId', 'singleMoveTogether',
        'singleHistory', 'rectDragActive', 'rectDragHistoryRecorded', 'rectDragStartDesign',
        'rectDragStartFeature', 'rectDragLastValidFeature', 'rectDragStartPointerPt',
        'rectDragStartCenterPt', 'dragMapHandlers', 'singlePendingVertexActionIndex',
        'currentHeightM', 'lastValidCenter', 'rectDragStartCenterPt'
    ]);
    const bindings = Object.keys(stubs).filter(key => !declared.has(key)
        && !['sourceSnapshot', 'placementUpdates', 'renderEvents', 'ensureSingleBuildingHistory'].includes(key))
        .map(key => `const ${key}=this.${key};`).join('\n');
    const variables = `
        let singleMap=this.singleMap, singleEditor=this.singleEditor, singleSession=this.singleSession, singleLandTakeReview=null;
        let buildingEntries=this.buildingEntries, singleBuildingLayers=this.singleBuildingLayers;
        let singleDragMarker=this.singleDragMarker, currentGroundTreatment=this.currentGroundTreatment;
        let currentGroundDecorationDesign=this.currentGroundDecorationDesign;
        let singleGroundBoundary=this.singleGroundBoundary;
        let singleBlockFeature=this.singleBlockFeature, singleRectFeature=this.singleRectFeature;
        let activeBuildingId=this.activeBuildingId, singleMoveTogether=this.singleMoveTogether;
        let singleHistory=null, rectDragActive=this.rectDragActive, rectDragHistoryRecorded=this.rectDragHistoryRecorded;
        let rectDragStartDesign=null, rectDragStartFeature=this.rectDragStartFeature;
        let rectDragLastValidFeature=this.rectDragLastValidFeature, rectDragStartPointerPt=null;
        let rectDragStartCenterPt=null, dragMapHandlers=null, singlePendingVertexActionIndex=null;
        let currentHeightM=12, lastValidCenter=null;
        let sourceSnapshot=this.sourceSnapshot;
        const EDIT_PANE='test-pane';
        function point(x,y) { return { x,y, add(other) { return point(x+other.x,y+other.y); }, subtract(other) { return point(x-other.x,y-other.y); } }; }
        function getActiveBuilding() { return buildingEntries.find(entry => entry.id === activeBuildingId) || null; }
        function buildingGroundApi() { return window.BuildingGround; }
        function setActiveFeature(candidate) {
            singleRectFeature=cloneSingleFeature(candidate);
            const active=getActiveBuilding();
            if (active) active.feature=cloneSingleFeature(candidate);
        }
        this.state=()=>({ buildingEntries, singleGroundBoundary, singleRectFeature, activeBuildingId,
            currentGroundTreatment, currentGroundDecorationDesign, rectDragActive, rectDragHistoryRecorded,
            rectDragStartDesign, rectDragStartPointerPt, rectDragStartCenterPt, sourceSnapshot });
        this.getHistory=()=>singleHistory;
        this.prepareDrag=()=>{ const [lng,lat]=turf.centroid(buildingEntries[0].feature).geometry.coordinates;
            rectDragStartDesign=captureSingleBuildingDesign(); rectDragStartCenterPt=point(lng,lat);
            rectDragStartPointerPt=point(lng,lat); return { lng,lat }; };
        this.reviewTake=take=>{ singleLandTakeReview={ take, snapshot:()=>({ take }) }; };
        this.valid=editableFootprintValid;
    `;
    const context = { ...stubs };
    vm.runInNewContext(`${variables}\n${bindings}\n${functions.get('captureSingleBuildingDesign')}\n${functions.get('ensureSingleBuildingHistory')}\n${functions.get('editableOuterRing')}\n${functions.get('editableFootprintValid')}\n${functions.get('featureWithGeometry')}\n${functions.get('handleRectDragMove')}\n${functions.get('handleRectDragEnd')}\n${functions.get('currentPlacementSite')}\nthis.ensure=ensureSingleBuildingHistory; this.move=handleRectDragMove; this.end=handleRectDragEnd; this.site=currentPlacementSite;`, context);
    return { context, stubs, map, placement, sourceSnapshot, groundBoundary, buildingEntries, renderEvents, placementUpdates };
}

function point(x, y) {
    return {
        x, y,
        add(other) { return point(this.x + other.x, this.y + other.y); },
        subtract(other) { return point(this.x - other.x, this.y - other.y); }
    };
}

function center(featureValue) {
    const [lng, lat] = turf.centroid(featureValue).geometry.coordinates;
    return { lng, lat };
}

describe('single-building whole-proposal placement', () => {
    it('passes the placed L-shaped courtyard outline and model metadata into a new upload entry', () => {
        const placedAt = { lat: 45.81, lng: 15.98 };
        const localFootprint = {
            type: 'Polygon',
            coordinates: [
                [[-5,-5],[5,-5],[5,0],[0,0],[0,5],[-5,5],[-5,-5]],
                [[-4,-4],[-4,-2],[-2,-2],[-2,-4],[-4,-4]]
            ]
        };
        const addEntry = vi.fn((centerLatLng, options) => ({
            id: 1, name: 'Uploaded', feature: options.feature, height: options.height
        }));
        const context = {
            window: { OnMapEditor: null, SingleBuildingGeometry: geometry },
            turf,
            singleBuildingPlacementContext: () => ({}),
            getSelectedBlockFeature: () => feature('block', 15.97, 45.8, 16, 45.82),
            computeInitialPlacement: () => ({ center: placedAt, width: 10, length: 10 }),
            addNewBuildingEntry: addEntry,
            setSingleBuildingStatus: vi.fn(),
            showSingleBuildingMapEditor: () => 'opened'
        };
        const script = `
            const window=this.window, turf=this.turf, DEFAULT_HEIGHT_M=15;
            let singleEditor=null, singleSession=null, singleBuildingOverrideContext=null;
            let singleBlockFeature=null, buildingEntries=[], activeBuildingId=null, nextBuildingId=0;
            let singleBuildingSeedBuildings=null, singleUploadOnConfirm=null;
            const singleBuildingPlacementContext=this.singleBuildingPlacementContext;
            const getSelectedBlockFeature=this.getSelectedBlockFeature;
            const computeInitialPlacement=this.computeInitialPlacement;
            const addNewBuildingEntry=this.addNewBuildingEntry;
            const setSingleBuildingStatus=this.setSingleBuildingStatus;
            const showSingleBuildingMapEditor=this.showSingleBuildingMapEditor;
            ${functions.get('cloneSingleFeature')}
            ${functions.get('markAsEditablePolygon')}
            ${functions.get('editableFootprintValid')}
            ${functions.get('createSingleBuildingFromUpload')}
            this.invoke=createSingleBuildingFromUpload;
        `;
        vm.runInNewContext(script, context);
        const result = context.invoke({
            blockName: 'Test block', parcelIds: ['p1'], width: 10, length: 10, height: 18,
            footprint: localFootprint, modelName: 'L model', modelUrl: '/model.glb'
        });
        const passedFeature = addEntry.mock.calls[0][1].feature;
        expect(result).toBe('opened');
        expect(addEntry.mock.calls[0][0]).toEqual(placedAt);
        expect(passedFeature.geometry.type).toBe('Polygon');
        expect(passedFeature.geometry.coordinates.map(ring => ring.length)).toEqual([7, 5]);
        expect(passedFeature.geometry.coordinates[0][3][0]).toBeCloseTo(placedAt.lng, 8);
        expect(passedFeature.geometry.coordinates[0][3][1]).toBeCloseTo(placedAt.lat, 8);
        expect(passedFeature.properties).toMatchObject({
            type: 'proposedBuildingSingle', footprintMode: 'polygon', height: 18,
            source: 'upload', modelName: 'L model', modelUrl: '/model.glb'
        });
    });

    it('moves the active footprint, keeps its neighbor and ground anchored, and restores one drag with Undo', () => {
        const h = movementHarness({ moveTogether: true, treatment: 'paved' });
        const start = h.context.prepareDrag();
        const original = clone(h.context.state());

        h.context.move({ latlng: { lat: start.lat, lng: start.lng + 0.006 } });
        h.context.move({ latlng: { lat: start.lat, lng: start.lng + 0.012 } });
        h.context.move({ latlng: { lat: start.lat + 0.004, lng: start.lng + 0.012 } });
        h.context.end();

        const moved = h.context.state();
        expect(h.context.getHistory().depth()).toBe(1);
        expect(center(moved.buildingEntries[0].feature).lng).toBeGreaterThan(start.lng + 0.01);
        expect(moved.buildingEntries[1]).toEqual(original.buildingEntries[1]);
        expect(moved.singleGroundBoundary).toEqual(original.singleGroundBoundary);
        const movedSite = h.context.site();
        expect(movedSite.type).toBe('MultiPolygon');
        expect(movedSite.coordinates).toHaveLength(2);
        expect(turf.area(turf.feature(movedSite))).toBeCloseTo(moved.buildingEntries.reduce((sum, entry) => sum + turf.area(entry.feature), 0), 2);
        expect(h.sourceSnapshot).toEqual({ site: original.singleGroundBoundary.geometry, buildings: original.buildingEntries.map(entry => entry.feature) });

        expect(h.context.getHistory().undo()).toBe(true);
        const restored = h.context.state();
        expect(restored.buildingEntries).toEqual(original.buildingEntries);
        expect(restored.singleGroundBoundary).toEqual(original.singleGroundBoundary);
        expect(h.context.getHistory().depth()).toBe(0);
    });

    it('moves only the active footprint when Move whole proposal is off', () => {
        const h = movementHarness({ moveTogether: false, treatment: 'green' });
        const start = h.context.prepareDrag();
        const before = clone(h.context.state());

        h.context.move({ latlng: { lat: start.lat + 0.01, lng: start.lng + 0.01 } });
        h.context.end();

        const after = h.context.state();
        expect(center(after.buildingEntries[0].feature).lng).toBeGreaterThan(start.lng + 0.009);
        expect(after.buildingEntries[1]).toEqual(before.buildingEntries[1]);
        expect(after.singleGroundBoundary).toEqual(before.singleGroundBoundary);
        expect(h.context.getHistory().depth()).toBe(1);
    });

    it('refuses an outside drag when the starting site is explicitly locked', () => {
        const h = movementHarness({ moveTogether: true, locked: true });
        const start = h.context.prepareDrag();
        const before = clone(h.context.state());

        h.context.move({ latlng: { lat: start.lat, lng: start.lng + 0.01 } });
        h.context.end();

        const after = h.context.state();
        expect(after.buildingEntries).toEqual(before.buildingEntries);
        expect(after.singleGroundBoundary).toEqual(before.singleGroundBoundary);
        expect(h.context.getHistory()?.depth() || 0).toBe(0);
        expect(h.placementUpdates).toHaveLength(0);
    });

    it.each(['paved', 'green'])('uses the reviewed take independently of the %s treatment', treatment => {
        const h = movementHarness({ moveTogether: false, treatment });
        const bodies = h.context.state().buildingEntries.map(entry => entry.feature);
        h.context.reviewTake(turf.union(...bodies));
        const footprints = h.context.site();
        expect(footprints.type).toBe('MultiPolygon');
        expect(footprints.coordinates).toHaveLength(2);
        h.context.reviewTake(h.groundBoundary);
        const wholeSite = h.context.site();
        expect(wholeSite.coordinates).toHaveLength(1);
        expect(turf.area(wholeSite)).toBeCloseTo(turf.area(h.groundBoundary), 2);
    });
});
