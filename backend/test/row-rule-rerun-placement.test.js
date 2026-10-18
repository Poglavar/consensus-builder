// A Row placed by the editor and the same Row re-run on its parcels ("Apply the same rule to the
// parcels here", row-house.js rowHouseRuleAtOutline) follow one placement rule (placeRowHouseBar).
// On an L-shaped site the generated bar overhangs the site; the re-run used to demand strict
// containment instead, so it refused even on the very parcels the editor had just built on.
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
function lParcel() {
    const frame = localFrame.makeLocalFrame(16, 45);
    const toDeg = ([x, y]) => [16 + x / frame.metersPerDegLng, 45 + y / frame.metersPerDegLat];
    const ring = [[0, 0], [60, 0], [60, 12], [12, 12], [12, 60], [0, 60], [0, 0]].map(toDeg);
    return { type: 'Feature', properties: { parcelId: 'L' }, geometry: { type: 'Polygon', coordinates: [ring] } };
}

const USED = ['cloneRowHouseFeature', 'rowHouseGeneratorSite', 'robustUnionLocal', 'toSingleLargestPolygonLocal', 'getActiveRowHouseBlock',
    'describeRowHouseParcelSelection', 'generateRowHousePolygon', 'pointInPolygon', 'distanceToPolygonBoundary', 'checkBuildingFitsInSuperparcel',
    'placeRowHouseBar', 'rowHouseSiteCache', 'restoreRowHouseSiteCache', 'rowHouseRuleAtOutline', 'generateRowHouseInModal'];

function harness(parcel) {
    const functions = functionSources();
    const context = {
        turf, console,
        window: { SingleBuildingGeometry: geometry, LocalFrame: localFrame, moveActiveDesignToParcels() {} },
        document: { getElementById: () => ({ disabled: false }) },
        parcel
    };
    vm.createContext(context);
    const body = USED.filter(name => functions.has(name)).map(name => functions.get(name)).join('\n');
    vm.runInContext(`
        let rowHouseBlock = { parcels: [{ id: 'L', feature: parcel }], parcelIds: ['L'], site: parcel, valid: true };
        let currentBuildingLength = 40, currentBuildingWidth = 10, currentBuildingHeight = 12, currentChamfer = 0;
        let currentOffsetX = 0, currentOffsetY = 0, currentRotation = 0, baseRotation = 0, rowHouseManualMode = false;
        let cachedSuperparcel = null, cachedSuperparcelMeters = null, cachedCentroid = null, cachedMetersPerDegLng = null, cachedMetersPerDegLat = null;
        let generatedRowHouseFeature = null, rowHouseBlockNameOverride = null;
        const DEFAULT_BUILDING_HEIGHT = 12;
        const translateRowHouseText = (_key, fallback) => fallback;
        const getRowHouseDisplayName = () => 'L row';
        const applyChamferToPolygon = feature => feature;
        const setRowHouseInfo = () => {};
        const displayRowHouseBuildingInModal = () => {};
        const displayBlockOnRowHouseMap = () => {};
        const autosaveRowHouseDraft = () => {};
        const syncRowHouseGeometryControls = () => {};
        const rowHouseParcelsUnderOutline = () => ['L'];
        const rowHouseParcelsForIds = ids => ids.map(id => ({ id, feature: parcel }));
        ${body}
        this.api = {
            generate: generateRowHouseInModal,
            rerun: rowHouseRuleAtOutline,
            bar: () => generatedRowHouseFeature
        };
    `, context);
    return context.api;
}

describe('Row placement: editor generation and the re-run on the same parcels', () => {
    it('a bar the editor draws overhanging an L-shaped parcel is accepted by Apply the same rule on that parcel', () => {
        const parcel = lParcel();
        const api = harness(parcel);
        api.generate();
        const generated = api.bar();
        expect(generated?.geometry).toBeTruthy();
        // The case at issue: the editor's bar does not fit inside the L.
        expect(geometry.footprintWithinBoundary(generated, parcel, turf)).toBe(false);

        const result = api.rerun(parcel);
        expect(result).toEqual({ ok: true });
        expect(api.bar().geometry).toEqual(generated.geometry);
    });
});
