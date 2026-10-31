// The one fountain model of the 3D model view (frontend/js/three-fountains.js), shared by fountains
// placed in squares and fountains mapped in OSM: sizes, four draws, the pulsing jet.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const fountains = require('../../frontend/js/three-fountains.js');
const atmosphere = require('../../frontend/js/three-atmosphere.js');
const THREE = require('three');

describe('fountains', () => {
    it('size the basin, water, column and jet from the radius, within limits', () => {
        const small = fountains.fountainParts(2), big = fountains.fountainParts(8);
        expect(small.basin.radius).toBe(2);
        expect(small.water.radius).toBeLessThan(small.basin.radius);
        expect(small.water.z).toBeGreaterThan(small.basin.height - 1e-9);
        expect(small.jet.z).toBeCloseTo(small.column.z + small.column.height, 9);
        expect(big.jet.height).toBeGreaterThan(small.jet.height);
        expect(fountains.fountainParts(500).basin.radius).toBe(15);
        expect(fountains.fountainParts(undefined).basin.radius).toBe(fountains.PLACED_RADIUS_M);
    });

    it('draw any number of fountains in four instanced draws, with the scene\'s water', () => {
        const water = new THREE.MeshPhongMaterial();
        const layer = fountains.create(THREE, {
            fountains: [{ x: 0, y: 0, radiusM: 2 }, { x: 30, y: 5, z: 0.06, radiusM: 6 }, { x: NaN, y: 1 }],
            waterMaterial: water, clock: atmosphere.createState()
        });
        expect(layer.count).toBe(2);
        const meshes = layer.group.children;
        expect(meshes).toHaveLength(4);
        meshes.forEach(mesh => { expect(mesh.isInstancedMesh).toBe(true); expect(mesh.count).toBe(2); });
        expect(layer.meshes.water.material).toBe(water);
        const matrix = new THREE.Matrix4();
        layer.meshes.basin.getMatrixAt(1, matrix);
        const position = new THREE.Vector3(), scale = new THREE.Vector3();
        matrix.decompose(position, new THREE.Quaternion(), scale);
        expect(position.x).toBe(30);
        expect(position.z).toBeCloseTo(0.06, 6);
        expect(scale.x).toBe(6);
        layer.dispose();
        expect(fountains.create(THREE, { fountains: [], waterMaterial: water, clock: atmosphere.createState() }).count).toBe(0);
    });

    it('pulse the jet on the weather\'s clock', () => {
        const clock = atmosphere.createState();
        const layer = fountains.create(THREE, { fountains: [{ x: 0, y: 0 }], waterMaterial: new THREE.MeshPhongMaterial(), clock });
        const shader = { uniforms: {}, vertexShader: '#include <common>\nvoid main() {\n#include <begin_vertex>\n}' };
        layer.meshes.jet.material.onBeforeCompile(shader);
        expect(shader.uniforms.cbCloudTime).toBe(clock.cbCloudTime);
        expect(shader.vertexShader).toContain('transformed.z *= cbPulse;');
    });
});
