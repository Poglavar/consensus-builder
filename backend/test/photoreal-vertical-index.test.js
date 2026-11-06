// Unit tests for the straight-down height index photo mode uses instead of raycasting the tiles.

import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import * as THREE from 'three';

const require = createRequire(import.meta.url);
const { buildVerticalIndex, verticalHeightsAt } = require('../../frontend/js/photoreal-vertical-index.js');

// A rough terrain sheet with a tree-like bump above it, as one indexed mesh, so a probe can
// pass through two surfaces.
function terrainMesh() {
    const n = 24, size = 60;
    const positions = [];
    const index = [];
    const z = (i, j) => Math.sin(i * 0.7) * 1.5 + Math.cos(j * 0.4) * 2;
    for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) positions.push(i * size / n - 30, j * size / n - 30, z(i, j));
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const a = j * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1;
        index.push(a, b, d, a, d, c);
    }
    // A crown: a coarse floating sheet 8 m up over part of the terrain.
    const base = positions.length / 3;
    positions.push(-5, -5, 8, 10, -5, 9, 10, 10, 7, -5, 10, 8.5);
    index.push(base, base + 1, base + 2, base, base + 2, base + 3);
    return { positions: new Float32Array(positions), index: new Uint32Array(index) };
}

describe('photoreal vertical index', () => {
    it('finds the same surfaces as a downward three Raycaster', () => {
        const { positions, index } = terrainMesh();
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        geometry.setIndex(new THREE.BufferAttribute(index, 1));
        const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
        const raycaster = new THREE.Raycaster(new THREE.Vector3(), new THREE.Vector3(0, 0, -1), 0, 9000);
        const grid = buildVerticalIndex(positions, index);

        let random = 7;
        const next = () => ((random = (random * 16807) % 2147483647) / 2147483647);
        for (let k = 0; k < 400; k++) {
            const x = next() * 70 - 35, y = next() * 70 - 35;
            raycaster.ray.origin.set(x, y, 4000);
            const expected = raycaster.intersectObject(mesh, false).map(hit => hit.point.z);
            const found = verticalHeightsAt(grid, x, y).sort((a, b) => b - a);
            // A point on a shared edge is reported once by three and once per triangle here.
            const unique = found.filter((z, i) => i === 0 || Math.abs(z - found[i - 1]) > 1e-6);
            expect(unique.length).toBe(expected.length);
            unique.forEach((z, i) => expect(z).toBeCloseTo(expected[i], 4));
        }
    });

    it('reports the crown above the ground, highest first once sorted', () => {
        const { positions, index } = terrainMesh();
        const heights = verticalHeightsAt(buildVerticalIndex(positions, index), 3, 1).sort((a, b) => b - a);

        expect(heights).toHaveLength(2);
        expect(heights[0]).toBeGreaterThan(7);
        expect(heights[1]).toBeLessThan(4);
    });

    it('returns nothing outside the mesh and handles a non-indexed mesh', () => {
        const flat = new Float32Array([0, 0, 1, 10, 0, 1, 0, 10, 1]);
        const grid = buildVerticalIndex(flat, null);

        expect(verticalHeightsAt(grid, 2, 2)).toEqual([1]);
        expect(verticalHeightsAt(grid, 9, 9)).toEqual([]);
        expect(verticalHeightsAt(grid, 50, 2)).toEqual([]);
        expect(buildVerticalIndex(new Float32Array(0), null)).toBeNull();
    });
});
