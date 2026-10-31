// Street furniture mapped in OSM in the 3D model view (three-mode.js rebuildFurnitureOnly): drawn
// with the very lamp and fountain models placed furniture uses, kept off applied corridors and out
// of the parks and squares shown in the scene.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { parse } from '@babel/parser';
import * as THREE from 'three';

const require = createRequire(import.meta.url);
const turf = require('@turf/turf');
const fountainsApi = require('../../frontend/js/three-fountains.js');
const atmosphere = require('../../frontend/js/three-atmosphere.js');
const source = readFileSync(new URL('../../frontend/js/three-mode.js', import.meta.url), 'utf8');
const declarations = new Map();
(function collect(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'FunctionDeclaration' && node.id) declarations.set(node.id.name, source.slice(node.start, node.end));
    for (const key of Object.keys(node)) {
        if (key === 'loc' || key === 'start' || key === 'end') continue;
        const value = node[key];
        if (Array.isArray(value)) value.forEach(collect); else collect(value);
    }
})(parse(source, { sourceType: 'script', plugins: ['optionalChaining', 'nullishCoalescingOperator'] }));

function harness({ parks = [], squares = [], furniture }) {
    const lampGlowObjects = new Set();
    const lampAssets = {
        pole: new THREE.BufferGeometry(), head: new THREE.BufferGeometry(), pool: new THREE.BufferGeometry(),
        poleMat: new THREE.MeshLambertMaterial(), headMat: new THREE.MeshLambertMaterial(),
        poolMat: new THREE.MeshBasicMaterial(), haloMat: new THREE.PointsMaterial()
    };
    const context = {
        THREE, turf, console, Object, Array, Float32Array,
        isActive: true,
        furnitureGroup: new THREE.Group(),
        nearbyFurniture: furniture,
        fountainWaterMaterial: null, sky: null,
        atmosphereState: atmosphere.createState(), atmosphereClouds: null,
        FURNITURE_GROUND_Z: 0.06, LAMP_HEAD_Z: 4.12, LAMP_POOL_RADIUS_M: 5,
        lampGlowObjects,
        window: {
            parks, squares,
            __threeFountains: fountainsApi,
            __threeWaterSheen: { apply: material => material },
            __threeSky: { SKY_COLOR_GLSL: '' },
            __threeSiteGround: { contextTreesOutsideCorridors: points => points }
        },
        threeResources: { disposeOwnedSubtree: vi.fn(), markOwned: () => { } },
        ensureLampAssets: () => lampAssets,
        furnitureApi: () => ({ instanceTransform: ({ x, y, z, k }) => ({ position: [x, y, z], rotationZ: 0, scale: [k, k, 1] }) }),
        lifeMercatorK: () => 1,
        latLngToXY: (lat, lng) => [lng * 1000, lat * 1000],
        displayedFeatures: features => features,
        displayedProposals: () => [],
        isAppliedCorridorProposal: () => false,
        collectProposalFeatureSets: () => ({ primaryFeatures: [] }),
        markOwnedGeometry: () => { }, markOwnedMaterial: () => { },
        invalidateThreeView: vi.fn()
    };
    const names = ['rebuildFurnitureOnly', 'outsideStructures', 'addFountains3D', 'fountainWater', 'addLamps3D',
        'addProceduralLamps3D', 'addLampGlow3D', 'furniturePlacements', 'ownInstances'];
    vm.createContext(context);
    vm.runInContext(`${names.map(name => declarations.get(name)).join('\n')}\n${names.map(name => `this.${name}=${name};`).join('\n')}`, context);
    return { context, lampAssets, lampGlowObjects };
}

const squareAround = (lng, lat, d) => ({ type: 'Feature', properties: {}, geometry: { type: 'Polygon',
    coordinates: [[[lng - d, lat - d], [lng + d, lat - d], [lng + d, lat + d], [lng - d, lat + d], [lng - d, lat - d]]] } });

describe('OSM street furniture in 3D', () => {
    it('draws mapped lamps with the placed lamps\' pole, head and glow, standing on the street', () => {
        const { context, lampAssets, lampGlowObjects } = harness({ furniture: { fountains: [[15.97, 45.81, 3]], lamps: [[15.971, 45.811], [15.972, 45.812]] } });
        context.rebuildFurnitureOnly();
        const children = context.furnitureGroup.children;
        const poles = children.find(child => child.material === lampAssets.poleMat);
        const heads = children.find(child => child.material === lampAssets.headMat);
        expect(poles.count).toBe(2);
        expect(heads.userData.lampGlow).toBe('head');
        const matrix = new THREE.Matrix4();
        poles.getMatrixAt(0, matrix);
        expect(new THREE.Vector3().setFromMatrixPosition(matrix).z).toBe(0);
        expect([...lampGlowObjects].map(object => object.userData.lampGlow).sort()).toEqual(['halo', 'head', 'pool']);
        const fountains = children.find(child => child.name === 'Fountains');
        expect(fountains.children).toHaveLength(4);
        expect(fountains.children[0].count).toBe(1);
    });

    it('leaves a park or square shown in the scene to its own design', () => {
        const { context, lampAssets } = harness({
            squares: [squareAround(15.97, 45.81, 0.0005)],
            furniture: { fountains: [[15.97, 45.81, 3]], lamps: [[15.9701, 45.8101], [15.98, 45.82]] }
        });
        context.rebuildFurnitureOnly();
        const children = context.furnitureGroup.children;
        expect(children.find(child => child.material === lampAssets.poleMat).count).toBe(1);
        expect(children.find(child => child.name === 'Fountains')).toBeUndefined();
    });

    it('clears the last build before drawing the next', () => {
        const { context } = harness({ furniture: { fountains: [], lamps: [[15.971, 45.811]] } });
        context.rebuildFurnitureOnly();
        context.rebuildFurnitureOnly();
        expect(context.threeResources.disposeOwnedSubtree).toHaveBeenCalledTimes(2);
        expect(context.furnitureGroup.children).toHaveLength(4);   // poles, heads, pools, halos
    });
});
