import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
const require = createRequire(import.meta.url);
const { sidewalkMaterial, fencePositions } = require('../../frontend/js/three-site-ground.js');

describe('site ground', () => {
    it('uses the ordinary sidewalk shader rather than the square texture', () => {
        const THREE = { MeshLambertMaterial: class { constructor(options) { Object.assign(this, options); } } };
        const ground = { paveTexture: vi.fn(material => material) };
        const material = sidewalkMaterial(THREE, ground, 0.7);
        expect(ground.paveTexture).toHaveBeenCalledWith(material, 0.7);
        expect(material.color).toBe(0xcdccc8);
        expect(material.map).toBeUndefined();
    });
    it('closes a fence with metre heights and posts at most three metres apart', () => {
        const geometry = { type: 'Polygon', coordinates: [[[0, 0], [24, 0], [24, 24], [0, 24], [0, 0]]] };
        const positions = fencePositions(geometry, point => point, 0.5);
        const segments = Array.from({ length: positions.length / 6 }, (_, i) => positions.slice(i * 6, i * 6 + 6));
        const posts = segments.filter(([x, y, , endX, endY]) => x === endX && y === endY);
        expect(posts).toHaveLength(16);
        expect(posts.every(post => post[2] === 0.08 && post[5] === 1.3)).toBe(true);
        expect(segments).toContainEqual([0, 24, 1.3, 0, 0, 1.3]);
        expect(posts.slice(0, 4).map(post => post[0])).toEqual([0, 6, 12, 18]);
    });
    it('supports disconnected plots and skips zero-length boundary segments', () => {
        const ring = [[0, 0], [0, 0], [3, 0], [0, 3], [0, 0]];
        const geometry = { type: 'MultiPolygon', coordinates: [[ring], [ring]] };
        const positions = fencePositions(geometry, point => point);
        expect(positions.every(Number.isFinite)).toBe(true);
        expect(positions.length).toBe(2 * fencePositions({ type: 'Polygon', coordinates: [ring] }, point => point).length);
    });
});
