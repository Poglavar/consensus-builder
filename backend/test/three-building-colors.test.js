// Exercises actual 3D slicing materials so role tints cannot erase building hues or parcel shades.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from '@babel/parser';
import * as THREE from 'three';

const require = createRequire(import.meta.url);
const turf = require('../../frontend/vendor/turf-6.5.0/turf.min.js');
const arrangement = require('../../frontend/js/proposals/parcel-arrangement.js');
let previousTurf;
beforeEach(() => { previousTurf = globalThis.turf; globalThis.turf = turf; });
afterEach(() => { if (previousTurf === undefined) delete globalThis.turf; else globalThis.turf = previousTurf; });
const source = readFileSync(new URL('../../frontend/js/three-mode.js', import.meta.url), 'utf8');
const declarations = new Map();
function collect(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'FunctionDeclaration') declarations.set(node.id.name, source.slice(node.start, node.end));
    for (const [key, value] of Object.entries(node)) {
        if (key === 'loc' || key === 'start' || key === 'end') continue;
        if (Array.isArray(value)) value.forEach(collect); else collect(value);
    }
}
collect(parse(source, { sourceType: 'script' }));
const rectangle = (west, east, parcelId) => turf.polygon([[
    [west, 51.5], [east, 51.5], [east, 51.501], [west, 51.501], [west, 51.5]
]], parcelId ? { parcelId } : {});
const parcels = [rectangle(-0.130, -0.129, 'A'), rectangle(-0.129, -0.128, 'B'),
    rectangle(-0.126, -0.125, 'C'), rectangle(-0.125, -0.124, 'D')];
const buildings = [rectangle(-0.1298, -0.1282), rectangle(-0.1258, -0.1242)];

function viewer({ parcelFeatures = parcels, fabric = true, proposed = true, envelope = false, opacity = 1, staged = false } = {}) {
    const group = new THREE.Group();
    if (staged) group.userData.buildingFamily = 'planned';
    const material = new THREE.MeshPhongMaterial({ color: '#9aa4ad', opacity });
    const massing = envelope ? material : new THREE.MeshPhongMaterial({ color: '#7f95b3' });
    const context = {
        window: { __parcelArrangement: arrangement, PlanningViews: { color: () => '#c26336' },
            ...(fabric ? { LiveParcelFabric: { queryBounds: () => parcelFeatures } } : {}) },
        turf, THREE, proposedBuildingsGroup: proposed && !staged ? group : new THREE.Group(), buildingMaterials: { massing },
        cloneBuildingMaterial: original => original.clone(), materials: { sliceEdges: new THREE.LineBasicMaterial() },
        polygonFeatureToMeshes: (_feature, surface) => [new THREE.Mesh(new THREE.BoxGeometry(), surface)],
        markOwnedMaterial() {}, markOwnedGeometry() {}, addBuildingFloorLines() {},
        prepareProceduralFacadeMeshes: meshes => meshes, console
    };
    vm.runInNewContext(['stringToColor', 'createBuildingSlices'].map(name => declarations.get(name)).join('\n'), context);
    return {
        material,
        render(feature) {
            group.clear();
            context.createBuildingSlices(feature, 12, material, group);
            return group.children.filter(child => child.isMesh).map(mesh => ({
                parcelId: mesh.userData.parcelId, color: mesh.material.color.clone(), opacity: mesh.material.opacity
            }));
        }
    };
}

describe('3D building and parcel colors', () => {
    it('keeps different building hues when the planning role color is available', () => {
        const scene = viewer();
        const first = scene.render(buildings[0])[0].color.getHSL({});
        const second = scene.render(buildings[1])[0].color.getHSL({});
        expect(first.h).not.toBeCloseTo(second.h, 3);
    });

    it('uses the building hue with distinct shades across adjoining parcels', () => {
        const slices = viewer().render(buildings[0]);
        expect(slices.map(slice => slice.parcelId)).toEqual(['A', 'B']);
        const [first, second] = slices.map(slice => slice.color.getHSL({}));
        expect(first.h).toBeCloseTo(second.h, 8);
        expect(Math.abs(first.l - second.l)).toBeCloseTo(0.2, 8);
    });

    it('retains colors and parcel shades after parcel loading order changes', () => {
        const colors = slices => slices.map(slice => [slice.parcelId, slice.color.getHex()]);
        expect(colors(viewer({ parcelFeatures: [...parcels].reverse() }).render(buildings[0])))
            .toEqual(colors(viewer().render(buildings[0])));
    });

    it('keeps distinct building colors without parcel data or on an uncovered fallback', () => {
        for (const options of [{ fabric: false }, { parcelFeatures: [] }]) {
            const scene = viewer(options);
            expect(scene.render(buildings[0])[0].color.getHex())
                .not.toBe(scene.render(buildings[1])[0].color.getHex());
        }
    });

    it('retains transparency and leaves the shared material unchanged', () => {
        const scene = viewer({ opacity: 0.5 });
        const originalColor = scene.material.color.getHex();
        expect(scene.render(buildings[0]).every(slice => slice.opacity === 0.5)).toBe(true);
        expect(scene.material.color.getHex()).toBe(originalColor);
    });

    it('preserves unsliced context and envelope materials', () => {
        for (const options of [{ proposed: false }, { envelope: true }]) {
            const scene = viewer({ ...options, fabric: false });
            expect(scene.render(buildings[0])[0].color.getHex()).toBe(scene.material.color.getHex());
        }
    });

    it('keeps the same proposed tint while preparing a replacement off-scene', () => {
        const color = staged => viewer({ fabric: false, staged }).render(buildings[0])[0].color.getHex();
        expect(color(true)).toBe(color(false));
    });
});
