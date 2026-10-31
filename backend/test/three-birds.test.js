// Birds over the 3D model view (frontend/js/three-birds.js): deterministic flocks, flight along
// the ring, flapping wings, and one instanced draw shown only by day.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const birds = require('../../frontend/js/three-birds.js');
const THREE = require('three');

describe('birds', () => {
    it('give a place the same flocks every time, and another place other flocks', () => {
        expect(birds.createFlocks(42)).toEqual(birds.createFlocks(42));
        expect(birds.createFlocks(43)[0].cx).not.toBe(birds.createFlocks(42)[0].cx);
        const flocks = birds.createFlocks(7);
        expect(flocks).toHaveLength(birds.FLOCKS);
        flocks.forEach(flock => {
            expect(flock.birds).toHaveLength(birds.BIRDS_PER_FLOCK);
            expect(flock.height).toBeGreaterThan(20);
            expect(Math.hypot(flock.cx, flock.cy)).toBeLessThan(400);
        });
    });

    it('keep a cell\'s flocks while the view moves inside it, and take the next cell\'s beyond', () => {
        const a = birds.cellOf(10, 20, 5), b = birds.cellOf(250, -200, 5), c = birds.cellOf(700, 20, 5);
        expect(b.key).toBe(a.key);
        expect(c.key).not.toBe(a.key);
        expect(c.seed).not.toBe(a.seed);
        const layer = birds.create(THREE, { seed: 5 });
        expect(layer.follow(10, 20)).toBe(true);
        expect(layer.follow(250, -200)).toBe(false);
        expect(layer.follow(700, 20)).toBe(true);
        layer.update(1);
        const matrix = new THREE.Matrix4();
        layer.group.children[0].getMatrixAt(0, matrix);
        expect(Math.abs(new THREE.Vector3().setFromMatrixPosition(matrix).x - birds.CELL_M)).toBeLessThan(400);
    });

    it('fly at their speed, heading along their path', () => {
        const [flock] = birds.createFlocks(3);
        const bird = flock.birds[0];
        const a = birds.birdPose(flock, bird, 10);
        const b = birds.birdPose(flock, bird, 10.05);
        const speed = Math.hypot(b.x - a.x, b.y - a.y) / 0.05;
        expect(speed).toBeGreaterThan(birds.SPEED_M_PER_S * 0.8);
        expect(speed).toBeLessThan(birds.SPEED_M_PER_S * 1.4);
        const along = Math.atan2(b.y - a.y, b.x - a.x);
        const off = Math.atan2(Math.sin(along - a.heading), Math.cos(along - a.heading));
        expect(Math.abs(off)).toBeLessThan(0.2);
        expect(b.flap).toBeGreaterThan(a.flap);
    });

    it('are one instanced draw whose wings lift from the body, shown only by day outside photo view', () => {
        const layer = birds.create(THREE, { seed: 9 });
        const mesh = layer.group.children[0];
        expect(mesh.isInstancedMesh).toBe(true);
        expect(mesh.count).toBe(birds.FLOCKS * birds.BIRDS_PER_FLOCK);
        layer.update(5);
        const matrix = new THREE.Matrix4();
        mesh.getMatrixAt(0, matrix);
        expect(new THREE.Vector3().setFromMatrixPosition(matrix).z).toBeGreaterThan(20);
        const shader = { vertexShader: '#include <common>\nvoid main() {\n#include <begin_vertex>\n}' };
        mesh.material.onBeforeCompile(shader);
        expect(shader.vertexShader).toContain('attribute float cbFlap;');
        expect(shader.vertexShader).toContain('transformed.z += abs(transformed.y) * 0.9 * sin(cbFlap);');
        expect(layer.setShown(0, false)).toBe(true);
        expect(layer.setShown(0.8, false)).toBe(false);
        expect(layer.setShown(0, true)).toBe(false);
        expect(layer.visible).toBe(false);
        layer.dispose();
    });
});
