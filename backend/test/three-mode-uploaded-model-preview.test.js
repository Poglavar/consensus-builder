import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from '@babel/parser';

const source = readFileSync(new URL('../../frontend/js/three-mode.js', import.meta.url), 'utf8');
const ast = parse(source, { sourceType: 'script', plugins: ['optionalChaining', 'nullishCoalescingOperator'] });
const declarations = new Map();
function collect(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'FunctionDeclaration' && node.id) declarations.set(node.id.name, source.slice(node.start, node.end));
    Object.keys(node).forEach(key => {
        if (key === 'loc' || key === 'start' || key === 'end') return;
        const value = node[key];
        if (Array.isArray(value)) value.forEach(collect);
        else collect(value);
    });
}
collect(ast);

function geometryHarness() {
    const context = { latLngToXY: (lat, lng) => [lng, lat] };
    vm.runInNewContext(`${declarations.get('uploadedModelFit')}\nthis.fit=uploadedModelFit;`, context);
    return context.fit;
}

function loaderHarness(center = [0, 0]) {
    let finishLoad;
    const target = { children: [], add(object) { this.children.push(object); object.parent = this; } };
    class Group {
        constructor() {
            this.children = [];
            this.scale = { set: (...values) => { this.scale.values = values; } };
            this.rotation = { z: 0 };
            this.position = { set: (...values) => { this.position.values = values; } };
        }
        add(object) { this.children.push(object); object.parent = this; }
        traverse(callback) {
            callback(this);
            this.children.forEach(child => child.traverse ? child.traverse(callback) : callback(child));
        }
    }
    const context = {
        console,
        isActive: true,
        buildingsRenderGeneration: 4,
        pendingModelLoads: 0,
        proposedBuildingsGroup: {},
        THREE: {
            Group,
            Box3: class {
                constructor() { this.min = { z: 0 }; }
                setFromObject() { return this; }
                isEmpty() { return false; }
                getCenter(target) { target.set(2, 1, 2); }
                getSize(target) { target.set(2, 1, 4); }
            },
            Vector3: class { set(x, y, z) { Object.assign(this, { x, y, z }); } }
        },
        turf: { centroid: () => ({ geometry: { coordinates: center } }) },
        latLngToXY: (lat, lng) => [lng, lat],
        resolveBackendAssetUrl: value => value,
        buildingOpacityOf: () => 0.5,
        loadGltfScene: () => new Promise(resolve => { finishLoad = resolve; }),
        updateBuildingsLoader: vi.fn(),
        invalidateThreeView: vi.fn(),
        markOwnedMaterial: vi.fn(),
        markOwnedGeometry: (_node, geometry) => geometry,
        configureBuildingMaterial: material => material,
        attachBuildingDepthPrepass: vi.fn(),
        estimateBuildingHeightMeters: () => 10,
        createBuildingSlices: vi.fn()
    };
    const bindings = Object.keys(context).map(name => `const ${name}=this.${name};`).join('\n');
    vm.runInNewContext(`${bindings}\n${declarations.get('uploadedModelFit')}\n${declarations.get('placeUploadedModel')}\nthis.place=placeUploadedModel;`, context);
    const makeScene = () => {
        const mesh = {
            isMesh: true,
            geometry: { clone: vi.fn(() => ({ cloned: true })) },
            material: { userData: {}, clone() { return { userData: {} }; } },
            traverse(callback) { callback(this); }
        };
        return {
            clone() {
                return {
                    rotation: {},
                    position: { set() {} },
                    children: [mesh],
                    updateMatrixWorld() {},
                    traverse(callback) { callback(this); mesh.traverse(callback); }
                };
            }
        };
    };
    return { context, target, makeScene, resolveScene: () => finishLoad(makeScene()) };
}

const rectangle = rotation => ({
    type: 'Feature',
    properties: { rotation, height: 8 },
    geometry: { type: 'Polygon', coordinates: [[[-5, -10], [5, -10], [5, 10], [-5, 10], [-5, -10]]] }
});

const concaveL = rotation => {
    const center = [1.5, 1];
    const local = [[0, 0], [4, 0], [4, 1], [1, 1], [1, 3], [0, 3], [0, 0]];
    const radians = rotation * Math.PI / 180;
    const coordinates = local.map(([x, y]) => {
        const dx = x - center[0], dy = y - center[1];
        return [center[0] + dx * Math.cos(radians) - dy * Math.sin(radians),
            center[1] + dx * Math.sin(radians) + dy * Math.cos(radians)];
    });
    return {
        type: 'Feature',
        properties: { rotation, height: 8 },
        geometry: { type: 'Polygon', coordinates: [coordinates] }
    };
};

describe('uploaded model placement in shared 3D previews', () => {
    it('fits native model axes to the rotated authored footprint and scales height from metadata', () => {
        const fit = geometryHarness()(rectangle(90), [0, 0], { x: 2, y: 1, z: 4 });
        expect(fit.scale[0]).toBeCloseTo(10);
        expect(fit.scale[1]).toBeCloseTo(10);
        expect(fit.scale[2]).toBe(2);
        expect(fit.rotation).toBeCloseTo(Math.PI / 2);
    });

    it('aligns a rotated concave L model to the footprint bounding-box center, not its centroid', async () => {
        const feature = concaveL(90);
        const center = [1.5, 1];
        const fit = geometryHarness()(feature, center, { x: 4, y: 3, z: 8 });
        expect(fit.offset[0]).toBeCloseTo(-0.5);
        expect(fit.offset[1]).toBeCloseTo(0.5);

        const harness = loaderHarness(center);
        feature.properties.modelUrl = '/model.glb';
        harness.context.place(feature, harness.target, { userData: {} }, { fitToFootprint: true });
        harness.resolveScene();
        await Promise.resolve();
        await Promise.resolve();
        const wrapper = harness.target.children[0];
        expect(wrapper.position.values).toEqual([1, 1.5, 0]);
        expect(wrapper.rotation.z).toBeCloseTo(Math.PI / 2);
    });

    it('does not re-add a model when its preview generation becomes stale during loading', async () => {
        const harness = loaderHarness();
        let current = true;
        const feature = rectangle(0);
        feature.properties.modelUrl = '/model.glb';
        harness.context.place(feature, harness.target, { userData: {} }, {
            fitToFootprint: true,
            cloneGeometry: true,
            isCurrent: () => current
        });
        current = false;
        harness.resolveScene();
        await Promise.resolve();
        await Promise.resolve();
        expect(harness.target.children).toHaveLength(0);
    });

    it('clones cached geometry and applies footprint, height, and rotation to the preview wrapper', async () => {
        const harness = loaderHarness();
        const feature = rectangle(90);
        feature.properties.modelUrl = '/model.glb';
        harness.context.place(feature, harness.target, { userData: {} }, {
            cloneGeometry: true,
            isCurrent: () => true
        });
        harness.resolveScene();
        await Promise.resolve();
        await Promise.resolve();
        expect(harness.target.children).toHaveLength(1);
        const wrapper = harness.target.children[0];
        expect(wrapper.scale.values[0]).toBeCloseTo(10);
        expect(wrapper.scale.values[1]).toBeCloseTo(10);
        expect(wrapper.scale.values[2]).toBe(2);
        expect(wrapper.rotation.z).toBeCloseTo(Math.PI / 2);
        expect(wrapper.children[0].children[0].geometry).toEqual({ cloned: true });
    });
});
