import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from '@babel/parser';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../../frontend/js/three-resources.js', import.meta.url), 'utf8');
const threeModeSource = readFileSync(new URL('../../frontend/js/three-mode.js', import.meta.url), 'utf8');
const meshSanitizeSource = readFileSync(new URL('../../frontend/js/three-mesh-sanitize.js', import.meta.url), 'utf8');

function loadResources() {
    const context = vm.createContext({});
    vm.runInContext(source, context);
    return context.__threeResources;
}

function resource() {
    return { disposed: 0, dispose() { this.disposed++; } };
}

function group(...children) {
    return { children, userData: {} };
}

function loadNearbyMeshBuilder(ownership) {
    const names = new Set(['buildMeshFromBuilding3D', 'nearbyBuildingMeshFromGeometry']);
    const ast = parse(threeModeSource, { sourceType: 'script' });
    // The functions live inside the module IIFE; find their declarations by walking the AST.
    const found = [];
    const visit = node => {
        if (!node || typeof node !== 'object') return;
        if (node.type === 'FunctionDeclaration' && names.has(node.id.name)) found.push(node);
        Object.values(node).forEach(value => {
            if (Array.isArray(value)) value.forEach(visit);
            else if (value && typeof value === 'object') visit(value);
        });
    };
    visit(ast.program);
    expect(found.map(node => node.id.name).sort()).toEqual([...names].sort());
    const meshContext = vm.createContext({
        THREE: {
            DoubleSide: 2,
            Vector2: class Vector2 { constructor(x, y) { this.x = x; this.y = y; } },
            ShapeUtils: { triangulateShape: () => [[0, 1, 2]] },
            Float32BufferAttribute: class Float32BufferAttribute {
                constructor(array, itemSize) { this.array = Float32Array.from(array); this.itemSize = itemSize; }
            },
            BufferGeometry: class BufferGeometry {
                constructor() { this.attributes = {}; }
                setAttribute(name, value) { this.attributes[name] = value; }
                computeVertexNormals() { this.attributes.normal = { array: new Float32Array(this.attributes.position.array.length) }; }
            },
            Mesh: class Mesh {
                constructor(geometry, material) { this.geometry = geometry; this.material = material; this.userData = {}; }
            }
        },
        meshSanitize: null,
        latLngToXY: (lat, lng) => [lng, lat],
        xyToLatLng: (x, y) => ({ lng: x, lat: y }),
        cloneBuildingMaterial: material => ({ ...material }),
        markOwnedGeometry: (object, geometry) => ownership.markOwned(object, 'geometries', geometry),
        markOwnedMaterial: (object, material) => ownership.markOwnedMaterials(object, material),
        attachBuildingDepthPrepass: () => null
    });
    const sanitizeContext = vm.createContext({});
    vm.runInContext(meshSanitizeSource, sanitizeContext);
    meshContext.meshSanitize = sanitizeContext.__threeMeshSanitize;
    found.forEach(node => vm.runInContext(`${threeModeSource.slice(node.start, node.end)}\nthis.${node.id.name} = ${node.id.name};`, meshContext));
    return meshContext;
}

describe('three resource ownership', () => {
    it('disposes owned subtree resources once while preserving unowned shared resources', () => {
        const ownership = loadResources();
        const geometry = resource();
        const clonedMaterial = resource();
        const sharedGeometry = resource();
        const sharedMaterial = resource();
        const body = { userData: {}, children: [] };
        const depthPass = { userData: {}, children: [], geometry, material: clonedMaterial };
        const sibling = { userData: {}, children: [], geometry, material: clonedMaterial };
        const shared = { userData: {}, children: [], geometry: sharedGeometry, material: sharedMaterial };
        ownership.markOwned(body, 'geometries', geometry);
        ownership.markOwned(body, 'materials', clonedMaterial);
        ownership.markOwned(depthPass, 'materials', clonedMaterial);
        const root = group(body, depthPass, sibling, shared);

        expect(ownership.disposeOwnedSubtree(root)).toEqual({ geometries: 1, materials: 1 });
        expect(geometry.disposed).toBe(1);
        expect(clonedMaterial.disposed).toBe(1);
        expect(sharedGeometry.disposed).toBe(0);
        expect(sharedMaterial.disposed).toBe(0);
    });

    it('leaves facade-owned subtrees to the facade resource owner', () => {
        const ownership = loadResources();
        const facadeGeometry = resource();
        const facadeMaterial = resource();
        const facade = { userData: { cbFacadeOwned: true }, children: [] };
        const depthPass = { userData: {}, children: [] };
        ownership.markOwned(facade, 'geometries', facadeGeometry);
        ownership.markOwned(depthPass, 'materials', facadeMaterial);
        facade.children.push(depthPass);

        expect(ownership.disposeOwnedSubtree(facade)).toEqual({ geometries: 0, materials: 0 });
        expect(facadeGeometry.disposed).toBe(0);
        expect(facadeMaterial.disposed).toBe(0);
    });

    it('evicts resolved scene geometry, materials, and textures once', () => {
        const ownership = loadResources();
        const geometry = resource();
        const texture = { isTexture: true, disposed: 0, dispose() { this.disposed++; } };
        const material = { map: texture, disposed: 0, dispose() { this.disposed++; } };
        const source = group(
            { geometry, material, userData: {}, children: [] },
            { geometry, material, userData: {}, children: [] }
        );

        expect(ownership.disposeSharedSubtree(source)).toEqual({ geometries: 1, materials: 1, textures: 1 });
        expect(geometry.disposed).toBe(1);
        expect(material.disposed).toBe(1);
        expect(texture.disposed).toBe(1);
    });

    it('disposes instanced mesh buffers once when the same scene object is reached twice', () => {
        const ownership = loadResources();
        const instanceMesh = {
            isInstancedMesh: true,
            children: [],
            userData: {},
            disposed: 0,
            dispose() { this.disposed++; }
        };
        expect(ownership.disposeSharedSubtree([instanceMesh, instanceMesh])).toEqual({
            geometries: 0, materials: 0, textures: 0
        });
        expect(instanceMesh.disposed).toBe(1);
    });

    it('disposes a load that resolves after cache eviction and returns no stale scene', async () => {
        const ownership = loadResources();
        const cache = ownership.createSceneCache(ownership.disposeSharedSubtree);
        let finish;
        const geometry = resource();
        const pending = cache.load('model.glb', () => new Promise(resolve => { finish = resolve; }));
        await Promise.resolve();
        cache.clear();
        finish(group({ geometry, userData: {}, children: [] }));

        await expect(pending).resolves.toBeNull();
        expect(cache.size).toBe(0);
        expect(geometry.disposed).toBe(1);
    });

    it('keeps GLTF geometry and textures with the cache owner while placements are disposed', async () => {
        const ownership = loadResources();
        const cache = ownership.createSceneCache(ownership.disposeSharedSubtree);
        const geometry = resource();
        const texture = { isTexture: true, disposed: 0, dispose() { this.disposed++; } };
        const sourceMaterial = { map: texture, disposed: 0, dispose() { this.disposed++; } };
        const source = group({ geometry, material: sourceMaterial, children: [], userData: {} });
        await cache.load('shared.glb', () => Promise.resolve(source));
        const placementMaterial = { map: texture, disposed: 0, dispose() { this.disposed++; } };
        const placement = group({ geometry, material: placementMaterial, children: [], userData: {} });

        ownership.disposeSharedSubtree(placement);
        expect(placementMaterial.disposed).toBe(1);
        expect(geometry.disposed).toBe(0);
        expect(texture.disposed).toBe(0);
        cache.clear();
        expect(sourceMaterial.disposed).toBe(1);
        expect(geometry.disposed).toBe(1);
        expect(texture.disposed).toBe(1);
    });

    it('removes rejected loads so a later request can retry', async () => {
        const ownership = loadResources();
        const cache = ownership.createSceneCache(ownership.disposeSharedSubtree);
        await expect(cache.load('bad.glb', () => Promise.reject(new Error('load failed')))).rejects.toThrow('load failed');
        expect(cache.size).toBe(0);
        const scene = group();
        await expect(cache.load('bad.glb', () => Promise.resolve(scene))).resolves.toBe(scene);
        expect(cache.size).toBe(1);
        cache.clear();
    });

    it('reuses ordered building geometry and replays dedupe deltas for duplicate neighbors', () => {
        const ownership = loadResources();
        const cache = ownership.createBuildingGeometryCache();
        const buildings = [{ id: 'a' }, { id: 'b' }];
        const pass = {
            buildings,
            carveRecords: [{ id: 'carve-1' }],
            structureRegions: [],
            visibility: { showSurviving: true, showDemolished: true },
            xrayEnabled: false,
            suggestedPlansEnabled: false,
            suggestedExistingEnabled: false,
            origin: { x: 10, y: 20 }
        };
        const firstState = cache.beginPass(pass);
        const firstA = firstState.geometryCacheSession.beginEntry(firstState);
        firstState.seenFaceKeys.add('shared-face');
        firstState.seenTriangleKeys.add('shared-triangle');
        const geometry = { attributes: { position: { array: new Float32Array([1, 2, 3]) } }, disposed: 0, dispose() { this.disposed++; } };
        expect(firstA.finish(geometry)).toBe(true);
        const firstB = firstState.geometryCacheSession.beginEntry(firstState);
        // Building B has the same face and is omitted by the pass-wide dedupe sets.
        expect(firstState.seenFaceKeys.has('shared-face')).toBe(true);
        expect(firstB.finish(null)).toBe(true);

        const secondState = cache.beginPass(pass);
        const secondA = secondState.geometryCacheSession.beginEntry(secondState);
        const secondB = secondState.geometryCacheSession.beginEntry(secondState);
        expect(secondA.hit).toBe(true);
        expect(secondA.geometry.attributes.position.array).toEqual(geometry.attributes.position.array);
        expect(secondB).toMatchObject({ hit: true, geometry: null });
        expect(secondState.seenFaceKeys.has('shared-face')).toBe(true);
        expect(secondState.seenTriangleKeys.has('shared-triangle')).toBe(true);
        expect(secondState.seenFaceKeys.size).toBe(firstState.seenFaceKeys.size);
        expect(secondState.seenTriangleKeys.size).toBe(firstState.seenTriangleKeys.size);
        ownership.disposeSharedSubtree({
            geometry,
            userData: {},
            children: []
        });
        expect(geometry.disposed).toBe(0);
        cache.clear();
        expect(geometry.disposed).toBe(1);
    });

    it('produces the same nearby mesh outputs on a pass cache hit with a duplicate second building', () => {
        const ownership = loadResources();
        const builder = loadNearbyMeshBuilder(ownership);
        const cache = ownership.createBuildingGeometryCache();
        const buildings = [{ object_id: 'a' }, { object_id: 'b' }];
        const face = {
            type: 'Polygon',
            coordinates: [[
                [0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 0]
            ]]
        };
        const records = buildings.map(building => ({ ...building, z_min: 0, faces: [face] }));
        const pass = { buildings, carveRecords: [], structureRegions: [], visibility: {}, origin: { x: 0, y: 0 } };
        const material = { color: 1 };
        const firstState = cache.beginPass(pass);
        const firstRun = records.map(record => builder.buildMeshFromBuilding3D(record, material, firstState));
        expect(firstRun[0]).not.toBeNull();
        expect(firstRun[1]).toBeNull();
        const expectedPositions = Array.from(firstRun[0].geometry.attributes.position.array);

        const secondState = cache.beginPass(pass);
        const secondRun = records.map(record => builder.buildMeshFromBuilding3D(record, material, secondState));
        expect(Array.from(secondRun[0].geometry.attributes.position.array)).toEqual(expectedPositions);
        expect(secondRun[1]).toBeNull();
        expect(secondState.seenFaceKeys.size).toBe(firstState.seenFaceKeys.size);
        expect(secondState.seenTriangleKeys.size).toBe(firstState.seenTriangleKeys.size);
        cache.clear();
    });

    it('does not retain geometry past the byte budget and disposes retained geometry on pass change', () => {
        const ownership = loadResources();
        const cache = ownership.createBuildingGeometryCache({ maxBytes: 12 });
        const buildings = [];
        const state = cache.beginPass({ buildings });
        const entry = state.geometryCacheSession.beginEntry(state);
        const geometry = { attributes: { position: { array: new Float32Array([1, 2, 3, 4]) } }, disposed: 0, dispose() { this.disposed++; } };
        expect(entry.finish(geometry)).toBe(false);
        expect(cache.bytes).toBe(0);
        expect(geometry.disposed).toBe(0);

        const fittingCache = ownership.createBuildingGeometryCache();
        const retainedState = fittingCache.beginPass({ buildings });
        const retained = retainedState.geometryCacheSession.beginEntry(retainedState);
        expect(retained.finish(geometry)).toBe(true);
        const nextBuildings = [];
        fittingCache.beginPass({ buildings: nextBuildings });
        expect(geometry.disposed).toBe(1);
    });

    it('invalidates the pass when source array identity or carve signature changes', () => {
        const ownership = loadResources();
        const cache = ownership.createBuildingGeometryCache();
        const source = [{ id: 'a' }];
        const pass = { buildings: source, carveRecords: [{ id: 'c1' }] };
        const state = cache.beginPass(pass);
        const geometry = { attributes: {}, disposed: 0, dispose() { this.disposed++; } };
        expect(state.geometryCacheSession.beginEntry(state).finish(geometry)).toBe(true);
        cache.beginPass({ ...pass, buildings: [...source] });
        expect(geometry.disposed).toBe(1);

        const secondState = cache.beginPass(pass);
        const secondGeometry = { attributes: {}, disposed: 0, dispose() { this.disposed++; } };
        expect(secondState.geometryCacheSession.beginEntry(secondState).finish(secondGeometry)).toBe(true);
        cache.beginPass({ ...pass, carveRecords: [{ id: 'c2' }] });
        expect(secondGeometry.disposed).toBe(1);
    });
});
