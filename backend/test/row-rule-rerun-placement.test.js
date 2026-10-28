// Rows require whole-footprint containment in their selected land.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { parse } from '@babel/parser';

const require = createRequire(import.meta.url);
const turf = require('@turf/turf');
const geometry = require('../../frontend/js/single-building-geometry.js');
const localFrame = require('../../frontend/js/local-frame.js');

const source = readFileSync(new URL('../../frontend/js/row-house.js', import.meta.url), 'utf8');
function functionSources() {
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

// An L of two 60 m arms, 12 m wide: its centroid lies in neither arm, so a 40 x 10 m bar centred
// on it cannot fit and is drawn overhanging.
function parcelFromMetres(points) {
    const frame = localFrame.makeLocalFrame(16, 45);
    const toDeg = ([x, y]) => [16 + x / frame.metersPerDegLng, 45 + y / frame.metersPerDegLat];
    return { type: 'Feature', properties: { parcelId: 'L' }, geometry: { type: 'Polygon', coordinates: [points.map(toDeg)] } };
}
const lParcel = () => parcelFromMetres([[0, 0], [60, 0], [60, 12], [12, 12], [12, 60], [0, 60], [0, 0]]);
const rectangleParcel = () => parcelFromMetres([[0, 0], [80, 0], [80, 40], [0, 40], [0, 0]]);
const moved = (feature, metres) => turf.transformTranslate(feature, metres / 1000, 90);

const USED = ['cloneRowHouseFeature', 'rowHouseGeneratorSite', 'robustUnionLocal', 'toSingleLargestPolygonLocal', 'getActiveRowHouseBlock',
    'describeRowHouseParcelSelection', 'generateRowHousePolygon', 'pointInPolygon', 'distanceToPolygonBoundary', 'checkBuildingFitsInSuperparcel',
    'placeRowHouseBar', 'rowHouseSiteCache', 'restoreRowHouseSiteCache', 'rowHouseRuleAtOutline', 'generateRowHouseInModal',
    'rowHouseSiteBoundary', 'rowHouseInteriorOffsets', 'rowHouseFitsSite', 'calculateMaxBuildingDimensions', 'saveRowHouseDesignForProposal', 'rowHouseFeatureValid', 'tryRowHouseDimensions', 'pointToSegmentDistance'];

function harness(parcel) {
    const functions = functionSources();
    const context = {
        turf, console,
        window: { SingleBuildingGeometry: geometry, LocalFrame: localFrame, moveActiveDesignToParcels() {} },
        document: { getElementById: () => ({ disabled: false }) },
        parcel
    };
    context.window.turf = turf;
    vm.createContext(context);
    for (const path of ['footprint-geometry.js', 'building-rule-geometry.js']) vm.runInContext(readFileSync(new URL(`../../frontend/js/${path}`, import.meta.url), 'utf8'), context, { filename: path });
    const body = USED.filter(name => functions.has(name)).map(name => functions.get(name)).join('\n');
    vm.runInContext(`
        let rowHouseBlock = { parcels: [{ id: 'L', feature: parcel }], parcelIds: ['L'], site: parcel, valid: true };
        let currentBuildingLength = 40, currentBuildingWidth = 10, currentBuildingHeight = 12, currentChamfer = 0;
        let currentOffsetX = 0, currentOffsetY = 0, currentRotation = 0, baseRotation = 0, rowHouseManualMode = false;
        let cachedSuperparcel = null, cachedSuperparcelMeters = null, cachedCentroid = null, cachedMetersPerDegLng = null, cachedMetersPerDegLat = null;
        let generatedRowHouseFeature = null, rowHouseBlockNameOverride = null;
        const DEFAULT_BUILDING_HEIGHT = 12, DEFAULT_BUILDING_LENGTH = 40, DEFAULT_BUILDING_WIDTH = 10;
        const translateRowHouseText = (_key, fallback) => fallback;
        const getRowHouseDisplayName = () => 'L row';
        const applyChamferToPolygon = feature => feature;
        const setRowHouseInfo = () => {};
        const displayRowHouseBuildingInModal = () => {};
        const syncRowDoneState = () => {};
        const displayBlockOnRowHouseMap = () => {};
        const autosaveRowHouseDraft = () => {};
        const syncRowHouseGeometryControls = () => {};
        const rowHouseParcelsUnderOutline = () => ['L'];
        const rowHouseParcelsForIds = ids => ids.map(id => ({ id, feature: parcel }));
        ${body}
        this.api = {
            generate: generateRowHouseInModal,
            rerun: rowHouseRuleAtOutline,
            bar: () => generatedRowHouseFeature,
            fits: feature => rowHouseFitsSite(feature),
            dimensions: (length, width) => tryRowHouseDimensions(length, width),
            size: () => [currentBuildingLength, currentBuildingWidth],
            generateDefaults: () => { const dimensions = calculateMaxBuildingDimensions(rowHouseBlock); currentBuildingLength = dimensions.maxLength; currentBuildingWidth = dimensions.maxWidth; generateRowHouseInModal(); },
            setFeature: feature => { generatedRowHouseFeature = feature; },
            offsets: () => rowHouseInteriorOffsets(parcel),
            save: saveRowHouseDesignForProposal
        };
    `, context);
    return context.api;
}

describe('Row placement: editor generation and the re-run on the same parcels', () => {
    it('finds a contained bar in an L arm and reruns it on the same parcel', () => {
        const parcel = lParcel();
        const api = harness(parcel);
        api.generate();
        const generated = api.bar();
        expect(generated?.geometry).toBeTruthy();
        expect(geometry.footprintWithinBoundary(generated, parcel, turf)).toBe(true);

        const result = api.rerun(parcel);
        expect(result).toEqual({ ok: true });
        expect(api.bar().geometry).toEqual(generated.geometry);
    });

    it('rejects movement outside the L even while part of the footprint overlaps land', () => {
        const parcel = lParcel();
        const api = harness(parcel);
        api.generate();
        const bar = api.bar();
        expect(api.fits(bar)).toBe(true);
        expect(api.fits(moved(bar, 20))).toBe(false);
        expect(api.fits(moved(bar, 300))).toBe(false);
    });

    it('where a bar of its size fits, a bar half off the site has left it', () => {
        const parcel = rectangleParcel();
        const api = harness(parcel);
        api.generate();
        const bar = api.bar();
        expect(geometry.footprintWithinBoundary(bar, parcel, turf)).toBe(true);
        expect(api.fits(moved(bar, 2))).toBe(true);
        expect(api.fits(moved(bar, 40))).toBe(false);
    });

    it('refuses dimensions that cannot fit an L arm', () => {
        const api = harness(lParcel());
        api.generate();
        expect(api.dimensions(40, 20)).toBe(false);
        expect(api.size()).toEqual([40, 10]);
    });
});


describe('Row initial placement on irregular land', () => {
    it('sizes and places a useful default inside a concavity', () => {
        const parcel = lParcel(), api = harness(parcel);
        api.generateDefaults();
        expect(api.size()[0]).toBeGreaterThan(10);
        expect(geometry.footprintWithinBoundary(api.bar(), parcel, turf)).toBe(true);
    });
    it('preserves regular rectangle default dimensions', () => {
        const parcel = rectangleParcel(), api = harness(parcel);
        api.generateDefaults();
        expect(api.size()[0]).toBeCloseTo(76, 0);
        expect(api.size()[1]).toBeCloseTo(38, 0);
        expect(geometry.footprintWithinBoundary(api.bar(), parcel, turf)).toBe(true);
    });
    it('searches disconnected components without bridging the gap', () => {
        const left = rectangleParcel(), right = moved(left, 200);
        const parcel = turf.multiPolygon([left.geometry.coordinates, right.geometry.coordinates]), api = harness(parcel);
        api.generateDefaults();
        expect(api.bar()?.geometry).toBeTruthy();
        expect(geometry.footprintWithinBoundary(api.bar(), parcel, turf)).toBe(true);
        expect(api.fits(moved(left, 100))).toBe(false);
    });
    it('keeps defaults out of courtyard holes and rejects a footprint surrounding a hole', () => {
        const outer = parcelFromMetres([[0,0],[100,0],[100,100],[0,100],[0,0]]);
        const hole = parcelFromMetres([[30,30],[30,70],[70,70],[70,30],[30,30]]);
        outer.geometry.coordinates.push(hole.geometry.coordinates[0]);
        const api = harness(outer);
        api.generateDefaults();
        expect(api.bar()?.geometry).toBeTruthy();
        expect(geometry.footprintWithinBoundary(api.bar(), outer, turf)).toBe(true);
        expect(api.fits(parcelFromMetres([[20,20],[80,20],[80,80],[20,80],[20,20]]))).toBe(false);
    });
    it('refuses Done before save or selection side effects for an invalid footprint', async () => {
        const api = harness(rectangleParcel());
        api.generate();
        api.setFeature(moved(api.bar(), 300));
        // No save/selection dependencies are provided: reaching one fails this regression.
        await expect(api.save()).resolves.toBeUndefined();
    });
});


it('bounds interior search on a densified cadastral ring without changing containment', () => {
    const sparse = lParcel();
    const dense = structuredClone(sparse);
    const ring = sparse.geometry.coordinates[0];
    dense.geometry.coordinates[0] = ring.slice(0, -1).flatMap((start, index) => {
        const end = ring[index + 1];
        return Array.from({ length: 80 }, (_, step) => [
            start[0] + (end[0] - start[0]) * step / 80,
            start[1] + (end[1] - start[1]) * step / 80
        ]);
    });
    dense.geometry.coordinates[0].push(dense.geometry.coordinates[0][0]);
    const api = harness(dense);
    api.generateDefaults();
    expect(api.size()[0]).toBeGreaterThan(10);
    expect(geometry.footprintWithinBoundary(api.bar(), dense, turf)).toBe(true);
    const offsets = api.offsets();
    expect(offsets.length).toBeGreaterThan(0);
    expect(offsets.length).toBeLessThanOrEqual(96);
    expect(new Set(offsets.map(({ offsetX, offsetY }) => `${Math.round(offsetX * 100)},${Math.round(offsetY * 100)}`)).size).toBe(offsets.length);
});
