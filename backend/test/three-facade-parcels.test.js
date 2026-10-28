// Exercises the real parcel slicing and facade shader wiring with Turf and small renderer doubles.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const turf = require('../../frontend/vendor/turf-6.5.0/turf.min.js');
const facades = require('../../frontend/js/three-building-facades.js');
const arrangement = require('../../frontend/js/proposals/parcel-arrangement.js');
const boundary = require('./fixtures/parcel-cut-boundary.json');
let previousTurf;
beforeEach(() => { previousTurf = globalThis.turf; globalThis.turf = turf; });
afterEach(() => { if (previousTurf === undefined) delete globalThis.turf; else globalThis.turf = previousTurf; });
const source = readFileSync(new URL('../../frontend/js/three-mode.js', import.meta.url), 'utf8');
const facadePreparation = source.slice(source.indexOf('    function prepareProceduralFacadeMeshes('),
    source.indexOf('    function createBuildingSlices('));
const sliceFunction = facadePreparation + source.slice(source.indexOf('    function createBuildingSlices('),
    source.indexOf('    function getBuildingParcelIntersectionPoints('));

class Color {
    constructor(value) { this.value = value; }
    clone() { return new Color(this.value); }
    getHSL(target) { Object.assign(target, { h: 0.4, s: 0.6, l: 0.4 }); }
    setHSL(h, s, l) { this.value = [h, s, l]; }
    set(color) { this.value = color.value; }
    multiplyScalar(tone) { this.tone = tone; return this; }
}
const THREE = {
    Color,
    Vector3: class { constructor(x, y, z) { Object.assign(this, { x, y, z }); } },
    Float32BufferAttribute: class { constructor(array) { this.array = array; } },
    EdgesGeometry: class {},
    LineSegments: class { constructor(geometry, material) { Object.assign(this, { geometry, material, userData: {} }); } }
};
const material = () => ({ color: new Color('#abcdef'), userData: {}, onBeforeCompile() {}, customProgramCacheKey() { return 'phong'; } });
const rectangle = (west, south, east, north, properties) => turf.polygon([
    [[west, south], [east, south], [east, north], [west, north], [west, south]]
], properties);
const parcels = [
    rectangle(15, 44, 15.001, 44.001, { parcelId: '123/4' }),
    rectangle(15.001, 44, 15.002, 44.001, { parcelId: '123/5' })
];
const volume = (buildingIndex = 1) => rectangle(15.0002, 44.0002, 15.0018, 44.0008,
    { parcelId: 'volume-owner-hint', proposalId: 42, buildingIndex, urbanRule: { floorHeightM: 3.5 } });

function viewer(parcelFeatures = parcels) {
    const context = {
        window: { LiveParcelFabric: { queryBounds: () => parcelFeatures }, CityConfigManager: { getCurrentCityId: () => 'zagreb' } },
        turf, THREE, buildingFacades: facades, facadeState: facades.createState(THREE),
        proposedBuildingsGroup: null, buildingMaterials: { massing: null },
        cloneBuildingMaterial: material, stringToColor: () => '#abcdef', materials: { sliceEdges: {} },
        addBuildingFloorLines: vi.fn(), console,
        markOwnedGeometry: (_object, geometry) => geometry,
        markOwnedMaterial: (_object, surface) => surface,
        polygonFeatureToMeshes: (_feature, surface) => [{
            userData: {}, material: surface,
            geometry: { attributes: { position: { array: new Float32Array(9) }, normal: { array: new Float32Array(9) } },
                setAttribute(name, value) { this.attributes[name] = value; } }
        }]
    };
    context.window.__parcelArrangement = arrangement;
    vm.runInNewContext(sliceFunction, context);
    return (feature, height = 21, facadeSource = feature) => {
        const objects = [];
        context.createBuildingSlices(feature, height, material(), { add: object => objects.push(object) }, facadeSource);
        return objects.filter(object => object.material.userData?.cbProceduralFacade).map(mesh => {
            const shader = { uniforms: {}, vertexShader: '#include <begin_vertex>', fragmentShader: '#include <color_fragment>\n#include <opaque_fragment>' };
            mesh.material.onBeforeCompile(shader);
            const uniforms = shader.uniforms;
            return { parcelId: mesh.userData.parcelId, style: uniforms.cbFacadeDesign.value,
                windows: uniforms.cbFacadeWindows.value, shutters: uniforms.cbFacadeShutterColor.value,
                glass: uniforms.cbFacadeGlassColor.value,
                building: uniforms.cbFacadeBuilding.value };
        });
    };
}

describe('facades on ownership slices', () => {
    it('does not invent a second facade between an authored footprint and its cut remainder', () => {
        const remainder = arrangement.clip('difference', boundary.host, boundary.footprint);
        remainder.properties.parcelId = 'remainder';
        const buildingParcel = structuredClone(boundary.footprint);
        buildingParcel.properties.parcelId = 'tower';
        // This is the reported precision mismatch, large enough to make full-height walls.
        expect(turf.area(turf.intersect(buildingParcel, remainder))).toBeGreaterThan(0.001);
        const slices = viewer([buildingParcel, remainder])(boundary.footprint, 81);
        expect(slices.map(slice => slice.parcelId)).toEqual(['tower']);
    });

    it('keeps one building style while changing its shade at the actual parcel seam', () => {
        const slices = viewer()(volume());
        expect(slices.map(slice => slice.parcelId)).toEqual(['123/4', '123/5']);
        expect(slices[0].style).not.toEqual(slices[1].style);
        expect(slices[0].style.x).toBe(slices[1].style.x);
        for (const slice of slices) {
            const expected = facades.buildingDesign(facades.buildingKey({ properties: { parcelId: slice.parcelId } }, 'zagreb'),
                21, 3.5, facades.buildingIdentityKey(volume(), 'zagreb'));
            expect(slice.style).toEqual({ x: expected.style, y: expected.bayWidth, z: expected.tone });
            expect(slice.building).toEqual({ x: 21, y: 3.5, z: expected.seed % 10000 });
        }
    });

    it('keeps parcel shades and each building tint across changed heights and reversed loading order', () => {
        const render = viewer();
        const first = render(volume());
        const secondVolume = rectangle(15.0003, 44.0003, 15.0017, 44.0007,
            { ...volume(9).properties, proposalId: 99, variationSeed: 12 });
        const second = render(secondVolume, 28);
        const parcelAppearance = ({ style: { x, ...shade }, building, glass, ...appearance }) => ({ shade, ...appearance });
        expect(second.map(parcelAppearance)).toEqual(first.map(parcelAppearance));
        expect(render(volume(), 28).map(slice => slice.style.x)).toEqual(first.map(slice => slice.style.x));
        expect(first[0].glass).toEqual(first[1].glass);
        expect(second[0].glass).toEqual(second[1].glass);
        expect(second[0].glass).not.toEqual(first[0].glass);
        expect(render(volume(), 28)[0].glass).toEqual(first[0].glass);
        expect(second.every(slice => slice.building.x === 28 && slice.building.y === 3.5)).toBe(true);
        expect(viewer([...parcels].reverse())(volume())).toEqual(first);
    });

    it('leaves envelope-only volumes without facade materials', () => {
        expect(viewer()(volume(), 21, null)).toEqual([]);
    });
});
