// Unit tests for the deterministic, staggered paving pattern used by square proposals in 3D.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildSquarePavingLayout, paintSquarePavingCanvas } = require('../../frontend/js/three-square-paving.js');

describe('square paving texture', () => {
    it('lays staggered running-bond courses with narrow mortar joints', () => {
        const layout = buildSquarePavingLayout(256);
        const firstRow = layout.stones.filter(stone => stone.y < 32);
        const secondRow = layout.stones.filter(stone => stone.y >= 32 && stone.y < 64);

        expect(layout.size).toBe(256);
        expect(layout.stones.length).toBeGreaterThan(30);
        expect(firstRow[0].x).toBeCloseTo(1);
        expect(secondRow[0].x).toBeCloseTo(-31);
        expect(firstRow[0].width).toBeCloseTo(62);
        expect(firstRow[0].height).toBeCloseTo(30);
        expect(new Set(layout.stones.map(stone => stone.color)).size).toBeGreaterThan(3);
    });

    it('paints the generated stones onto one reusable canvas tile', () => {
        const operations = [];
        const context = {
            fillStyle: '',
            strokeStyle: '',
            lineWidth: 0,
            fillRect: (...args) => operations.push(['fill', ...args]),
            strokeRect: (...args) => operations.push(['stroke', ...args])
        };
        const canvas = { width: 0, height: 0, getContext: () => context };
        const documentRef = { createElement: name => name === 'canvas' ? canvas : null };

        expect(paintSquarePavingCanvas(documentRef, 128)).toBe(canvas);
        expect(canvas.width).toBe(128);
        expect(canvas.height).toBe(128);
        expect(operations.filter(operation => operation[0] === 'fill').length).toBeGreaterThan(30);
        expect(operations.filter(operation => operation[0] === 'stroke').length).toBeGreaterThan(30);
    });
});
