// Parks, squares and lakes carrying an uploaded glTF model: the record fields, the footprint an
// upload places on the site, the 3D model branch with its procedural fallback, and the GeoJSON
// area import the structure editor and site tool share.

import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from '@babel/parser';
import * as turf from '@turf/turf';

const require = createRequire(import.meta.url);
const Structures = require('../../frontend/js/proposals/apply/structures.js');
const SingleBuildingGeometry = require('../../frontend/js/single-building-geometry.js');
const { areaGeometryFromGeoJSON } = require('../../frontend/js/polygon-geometry-editor.js');

const footprint = { type: 'Polygon', coordinates: [[[-10, -5], [10, -5], [10, 5], [-10, 5], [-10, -5]]] };
const site = {
    type: 'MultiPolygon',
    coordinates: [[[[16, 45.8], [16.002, 45.8], [16.002, 45.801], [16, 45.801], [16, 45.8]]]]
};
const deps = { turf, placeModelFootprint: SingleBuildingGeometry.placeModelFootprint };
const upload = { footprint, modelUrl: ' /models/park.glb ', modelName: 'x'.repeat(200), rotation: 35 };

describe('structure model record fields', () => {
    it('normalizes the uploaded model fields and refuses a missing model reference', () => {
        expect(Structures.structureModelFields(upload)).toEqual({
            modelUrl: '/models/park.glb', modelName: 'x'.repeat(120), rotation: 35, source: 'upload'
        });
        expect(Structures.structureModelFields({ modelUrl: '/m.glb', rotation: 'bad' }).rotation).toBe(0);
        expect(Structures.structureModelFields({ modelUrl: '' })).toBeNull();
        expect(Structures.structureModelFields(null)).toBeNull();
    });

    it('places the model footprint unrotated at a point on the site, in true ground metres', () => {
        const geometry = Structures.structureModelGeometry(footprint, site, deps);
        expect(geometry.type).toBe('Polygon');
        expect(turf.area(geometry)).toBeCloseTo(200, 0);
        expect(turf.booleanPointInPolygon(turf.centroid(geometry), turf.feature(site))).toBe(true);
        const [minX, minY, maxX, maxY] = turf.bbox(geometry);
        // Unrotated: the 20 m side runs east-west.
        expect(turf.distance([minX, minY], [maxX, minY], { units: 'meters' })).toBeCloseTo(20, 0);
        expect(turf.distance([minX, minY], [minX, maxY], { units: 'meters' })).toBeCloseTo(10, 0);
        expect(Structures.structureModelGeometry(footprint, { type: 'Point', coordinates: [16, 45] }, deps)).toBeNull();
    });

    it('creates the structure from an upload with rotation 0 and an explicit empty furniture design', () => {
        const geometry = Structures.structureModelGeometry(footprint, site, deps);
        const park = Structures.structureFromModelUpload('park', geometry, upload);
        expect(park).toMatchObject({ geometry, modelUrl: '/models/park.glb', rotation: 0, source: 'upload' });
        expect(park.decorationDesign).toEqual({ trees: [], flowerbeds: [], ponds: [], paths: [], benches: [], stalls: [], lamps: [], version: 3 });
        expect(Structures.structureFromModelUpload('square', geometry, upload).decorationDesign.version).toBe(2);
        expect(Structures.structureFromModelUpload('lake', geometry, upload)).not.toHaveProperty('decorationDesign');
        expect(Structures.structureFromModelUpload('park', geometry, { footprint })).toBeNull();
    });

    it('gives 3D the authored geometry with the model fields and no height', () => {
        const geometry = Structures.structureModelGeometry(footprint, site, deps);
        const feature = Structures.structureModelFeature({ kind: 'park', geometry, modelUrl: '/m.glb', modelName: 'Park', rotation: 10 });
        expect(feature).toEqual({ type: 'Feature', geometry, properties: { modelUrl: '/m.glb', modelName: 'Park', rotation: 10 } });
        expect(Structures.structureModelFeature({ kind: 'park', geometry })).toBeNull();
    });
});

const source = readFileSync(new URL('../../frontend/js/three-mode.js', import.meta.url), 'utf8');
const ast = parse(source, { sourceType: 'script', plugins: ['optionalChaining', 'nullishCoalescingOperator'] });
const declarations = new Map();
(function collect(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'FunctionDeclaration' && node.id) declarations.set(node.id.name, source.slice(node.start, node.end));
    Object.keys(node).forEach(key => {
        if (key === 'loc' || key === 'start' || key === 'end') return;
        const value = node[key];
        if (Array.isArray(value)) value.forEach(collect);
        else collect(value);
    });
})(ast);

function structureHarness(load) {
    const context = {
        console: { warn: vi.fn() },
        buildingMaterials: { solid: { userData: { cbBuildingMaterialRole: 'solid' } } },
        placeUploadedModel: vi.fn()
    };
    const bindings = Object.keys(context).map(name => `const ${name}=this.${name};`).join('\n');
    vm.runInNewContext(`${bindings}\n${declarations.get('placeStructureModel')}\nthis.place=placeStructureModel;`, context);
    if (load) context.placeUploadedModel = load;
    return context;
}

describe('3D structure model branch', () => {
    const modelFeature = Structures.structureModelFeature({
        geometry: Structures.structureModelGeometry(footprint, site, deps), modelUrl: '/m.glb', modelName: 'Park', rotation: 0
    });

    it('draws the procedural ground at once when the structure has no model', () => {
        const harness = structureHarness();
        const buildGround = vi.fn();
        expect(harness.place({ properties: {} }, {}, () => true, buildGround)).toBe(false);
        expect(buildGround).toHaveBeenCalledTimes(1);
        expect(harness.placeUploadedModel).not.toHaveBeenCalled();
    });

    it('places the model instead of the ground, and falls back to the ground when loading fails', () => {
        const harness = structureHarness();
        const buildGround = vi.fn();
        const target = {};
        const isCurrent = () => true;
        expect(harness.place({ properties: { structureModel: modelFeature } }, target, isCurrent, buildGround)).toBe(true);
        expect(buildGround).not.toHaveBeenCalled();
        const [feature, group, material, options] = harness.placeUploadedModel.mock.calls[0];
        expect(feature).toBe(modelFeature);
        expect(feature.properties).not.toHaveProperty('height');
        expect(group).toBe(target);
        expect(material.userData.cbBuildingMaterialRole).toBe('solid');
        expect(options.isCurrent).toBe(isCurrent);
        options.onLoadError(new Error('404'));
        expect(buildGround).toHaveBeenCalledTimes(1);
    });

    it('placeUploadedModel hands a failed load to the caller fallback instead of a building box', async () => {
        const createBuildingSlices = vi.fn();
        const context = {
            console: { warn: vi.fn() },
            isActive: true,
            buildingsRenderGeneration: 1,
            pendingModelLoads: 0,
            proposedBuildingsGroup: {},
            turf: { centroid: () => ({ geometry: { coordinates: [16, 45] } }) },
            latLngToXY: (lat, lng) => [lng, lat],
            resolveBackendAssetUrl: value => value,
            buildingOpacityOf: () => 1,
            loadGltfScene: () => Promise.reject(new Error('missing')),
            updateBuildingsLoader: vi.fn(),
            invalidateThreeView: vi.fn(),
            estimateBuildingHeightMeters: () => 10,
            cloneBuildingMaterial: material => material,
            createBuildingSlices
        };
        const bindings = Object.keys(context).map(name => `const ${name}=this.${name};`).join('\n');
        vm.runInNewContext(`${bindings}\n${declarations.get('uploadedModelFit')}\n${declarations.get('placeUploadedModel')}\nthis.load=placeUploadedModel;`, context);
        const onLoadError = vi.fn();
        let current = true;
        context.load(modelFeature, { userData: {} }, { userData: {} }, { isCurrent: () => current, onLoadError });
        await new Promise(resolve => setImmediate(resolve));
        expect(onLoadError).toHaveBeenCalledTimes(1);
        expect(createBuildingSlices).not.toHaveBeenCalled();

        // A rebuilt scene owns its own fallback: a stale load draws nothing.
        current = false;
        context.load(modelFeature, { userData: {} }, { userData: {} }, { isCurrent: () => current, onLoadError });
        await new Promise(resolve => setImmediate(resolve));
        expect(onLoadError).toHaveBeenCalledTimes(1);
    });
});

describe('GeoJSON area import', () => {
    const square = (x, y) => ({ type: 'Feature', properties: {}, geometry: { type: 'Polygon',
        coordinates: [[[x, y], [x + 0.001, y], [x + 0.001, y + 0.001], [x, y + 0.001], [x, y]]] } });

    it('joins touching polygons into one area', () => {
        const geometry = areaGeometryFromGeoJSON({ type: 'FeatureCollection', features: [square(16, 45.8), square(16.001, 45.8)] }, turf);
        expect(geometry.type).toBe('Polygon');
        const [minX, , maxX] = turf.bbox(geometry);
        expect(maxX - minX).toBeCloseTo(0.002, 9);
    });

    it('refuses separate areas and non-polygon content', () => {
        expect(() => areaGeometryFromGeoJSON({ type: 'FeatureCollection', features: [square(16, 45.8), square(16.01, 45.8)] }, turf))
            .toThrow(expect.objectContaining({ code: 'disconnected' }));
        expect(() => areaGeometryFromGeoJSON({ type: 'Point', coordinates: [16, 45] }, turf)).toThrow();
        expect(() => areaGeometryFromGeoJSON({ type: 'Polygon', coordinates: [[[1600000, 5000000], [1, 1], [2, 2]]] }, turf)).toThrow();
    });
});
