// Exercises the real parcel slicing and facade shader wiring with Turf and small renderer doubles.
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const turf = require('../../frontend/vendor/turf-6.5.0/turf.min.js');
const facades = require('../../frontend/js/three-building-facades.js');
const source = readFileSync(new URL('../../frontend/js/three-mode.js', import.meta.url), 'utf8');
const sliceFunction = source.slice(source.indexOf('    function createBuildingSlices('),
    source.indexOf('    function getBuildingParcelIntersectionPoints('));

class Color {
    constructor(value) { this.value = value; }
    clone() { return new Color(this.value); }
    getHSL(target) { Object.assign(target, { h: 0.4, s: 0.6, l: 0.4 }); }
    setHSL(h, s, l) { this.value = [h, s, l]; }
    set(color) { this.value = color.value; }
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
        cloneBuildingMaterial: material, stringToColor: () => '#abcdef', materials: { sliceEdges: {} },
        addBuildingFloorLines: vi.fn(), console,
        polygonFeatureToMeshes: (_feature, surface) => [{
            userData: {}, material: surface,
            geometry: { attributes: { position: { array: new Float32Array(9) }, normal: { array: new Float32Array(9) } },
                setAttribute(name, value) { this.attributes[name] = value; } }
        }]
    };
    vm.runInNewContext(sliceFunction, context);
    return (feature, height = 21, facadeSource = feature) => {
        const objects = [];
        context.createBuildingSlices(feature, height, material(), { add: object => objects.push(object) }, facadeSource);
        return objects.filter(object => object.material.userData?.cbProceduralFacade).map(mesh => {
            const shader = { uniforms: {}, vertexShader: '#include <begin_vertex>', fragmentShader: '#include <color_fragment>' };
            mesh.material.onBeforeCompile(shader);
            const uniforms = shader.uniforms;
            return { parcelId: mesh.userData.parcelId, style: uniforms.cbFacadeDesign.value,
                windows: uniforms.cbFacadeWindows.value, shutters: uniforms.cbFacadeShutterColor.value,
                building: uniforms.cbFacadeBuilding.value };
        });
    };
}

describe('facades on ownership slices', () => {
    it('changes the facade at the actual parcel seam within one volume', () => {
        const slices = viewer()(volume());
        expect(slices.map(slice => slice.parcelId)).toEqual(['123/4', '123/5']);
        expect(slices[0].style).not.toEqual(slices[1].style);
        for (const slice of slices) {
            const expected = facades.buildingDesign(facades.buildingKey({ properties: { parcelId: slice.parcelId } }, 'zagreb'), 21, 3.5);
            expect(slice.style).toEqual({ x: expected.style, y: expected.bayWidth, z: expected.tone });
            expect(slice.building).toEqual({ x: 21, y: 3.5, z: expected.seed % 10000 });
        }
    });

    it('keeps each parcel design across separate volumes, changed heights and reversed loading order', () => {
        const render = viewer();
        const first = render(volume());
        const secondVolume = rectangle(15.0003, 44.0003, 15.0017, 44.0007,
            { ...volume(9).properties, proposalId: 99, variationSeed: 12 });
        const second = render(secondVolume, 28);
        expect(second.map(({ building, ...appearance }) => appearance))
            .toEqual(first.map(({ building, ...appearance }) => appearance));
        expect(second.every(slice => slice.building.x === 28 && slice.building.y === 3.5)).toBe(true);
        expect(viewer([...parcels].reverse())(volume())).toEqual(first);
    });

    it('leaves envelope-only volumes without facade materials', () => {
        expect(viewer()(volume(), 21, null)).toEqual([]);
    });
});
