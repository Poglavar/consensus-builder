// Park planting (frontend/js/park-planting.js): a tree keeps the look it is stored with, a click
// re-rolls it into a visibly different one, and a flowerbed is filled with plants that stay inside
// its edging, coloured in rings, the same way on every rebuild.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Planting = require('../../frontend/js/park-planting.js');

const sequence = values => { let i = 0; return () => values[i++ % values.length]; };

describe('tree looks', () => {
    it('keeps a stored look and clamps its height to the kind', () => {
        expect(Planting.treeOf({ coordinate: [15.9, 45.8], kind: 'conifer', heightM: 12 }))
            .toEqual({ coordinate: [15.9, 45.8], kind: 'conifer', heightM: 12 });
        expect(Planting.treeOf({ coordinate: [15.9, 45.8], kind: 'ornamental', heightM: 30 }).heightM)
            .toBe(Planting.TREE_KINDS.ornamental.maxHeightM);
    });

    // Every park drawn before trees carried a look stores bare positions; each still grows one
    // fixed tree, and neighbouring positions grow different ones.
    it('gives a bare position the same look every time, and varies it across positions', () => {
        const a = Planting.treeOf([15.9001, 45.8001]);
        expect(Planting.treeOf([15.9001, 45.8001])).toEqual(a);
        expect(Object.keys(Planting.TREE_KINDS)).toContain(a.kind);
        const looks = new Set();
        for (let i = 0; i < 40; i++) looks.add(Planting.treeOf([15.9 + i * 0.00013, 45.8 + i * 0.00007]).kind);
        expect(looks.size).toBeGreaterThan(2);
    });

    it('refuses an entry without a position', () => {
        expect(Planting.treeOf(null)).toBeNull();
        expect(Planting.treeOf({ kind: 'conifer', heightM: 10 })).toBeNull();
        expect(Planting.treeOf(['x', 45])).toBeNull();
    });

    it('re-rolls a tree into a visibly different one at the same spot', () => {
        const tree = { coordinate: [15.9, 45.8], kind: 'broadleaf', heightM: 10 };
        for (let seed = 0; seed < 50; seed++) {
            const next = Planting.rerollTree(tree, sequence([((seed * 7) % 10) / 10, ((seed * 3) % 10) / 10, 0.1, 0.95]));
            expect(next.coordinate).toEqual(tree.coordinate);
            expect(next.kind !== tree.kind || Math.abs(next.heightM - tree.heightM) >= 2).toBe(true);
        }
    });

    // A random source that keeps answering "broadleaf, the same height" still ends in a change.
    it('changes the kind when the random draws never differ enough', () => {
        const tree = { coordinate: [15.9, 45.8], kind: 'broadleaf', heightM: 10 };
        // 0.1 picks broadleaf, 0.5 its 10 m height: the same tree on every draw.
        expect(Planting.rerollTree(tree, sequence([0.1, 0.5])).kind).not.toBe('broadleaf');
    });

    it('shapes each kind: a conifer is tiered cones, the others round crowns, all as tall as stored', () => {
        const shape = kind => Planting.treeShape({ coordinate: [0, 0], kind, heightM: Planting.TREE_KINDS[kind].maxHeightM });
        expect(shape('conifer').crown.map(piece => piece.shape)).toEqual(['cone', 'cone', 'cone']);
        for (const kind of Object.keys(Planting.TREE_KINDS)) {
            const s = shape(kind);
            const top = Math.max(...s.crown.map(piece => piece.baseM + piece.heightM));
            expect(top).toBeLessThanOrEqual(Planting.TREE_KINDS[kind].maxHeightM + 1e-9);
            expect(top).toBeGreaterThan(Planting.TREE_KINDS[kind].maxHeightM * 0.6);
        }
        expect(shape('columnar').crown[0].radiusM).toBeLessThan(shape('broadleaf').crown[0].radiusM);
    });

    it('draws a conifer as one on the map and every other kind as a leafy tree', () => {
        expect(Planting.treeGlyph({ coordinate: [0, 0], kind: 'conifer', heightM: 10 })).toBe('🌲');
        expect(Planting.treeGlyph({ coordinate: [0, 0], kind: 'ornamental', heightM: 4 })).toBe('🌳');
    });

    it('sizes and centres the 2D icon from the same height the 3D tree uses', () => {
        const icon = heightM => Planting.treeIcon({ coordinate: [0, 0], kind: 'columnar', heightM });
        expect(icon(10).iconSize).toEqual([24, 24]);
        expect(icon(20).iconSize).toEqual([38, 38]);
        expect(icon(20).iconAnchor).toEqual([19, 19]);
        expect(icon(20).html).toContain('--tree-icon-size: 38px');
        expect(icon(10).html).toContain('--tree-icon-size: 24px');
    });
});

describe('flowerbed planting', () => {
    const circle = (r, n = 32) => Array.from({ length: n + 1 }, (_, i) => [r * Math.cos((i / n) * 2 * Math.PI), r * Math.sin((i / n) * 2 * Math.PI)]);

    it('fills a bed densely, inside its edging, the same way every time', () => {
        const ring = circle(3);
        const plants = Planting.flowerbedPlanting(ring, 42);
        expect(plants.length).toBeGreaterThan(120);
        expect(plants.every(p => Math.hypot(p.x, p.y) < 3 - 0.2)).toBe(true);
        expect(Planting.flowerbedPlanting(ring, 42)).toEqual(plants);
        expect(Planting.flowerbedPlanting(ring, 43)).not.toEqual(plants);
    });

    it('colours the bed in rings from the edge inwards, mostly in bloom', () => {
        const plants = Planting.flowerbedPlanting(circle(4), 7);
        const colours = new Set(plants.filter(p => p.color !== null).map(p => p.color));
        expect(colours.size).toBeGreaterThanOrEqual(2);
        expect(colours.size).toBeLessThanOrEqual(3);
        expect(plants.filter(p => p.color !== null).length / plants.length).toBeGreaterThan(0.7);
        const outer = plants.filter(p => Math.hypot(p.x, p.y) > 3.5 && p.color !== null).map(p => p.color);
        // The second ring: 1.2–1.8 m in from the edge of a 4 m bed.
        const middle = plants.filter(p => Math.hypot(p.x, p.y) < 2.8 && Math.hypot(p.x, p.y) > 2.2 && p.color !== null).map(p => p.color);
        expect(new Set(outer).size).toBe(1);
        expect(middle.every(c => c !== outer[0])).toBe(true);
    });

    it('caps a huge bed instead of drawing tens of thousands of plants', () => {
        expect(Planting.flowerbedPlanting(circle(60), 1).length).toBeLessThanOrEqual(900);
    });

    it('plants nothing in a degenerate ring', () => {
        expect(Planting.flowerbedPlanting([[0, 0], [1, 1]], 1)).toEqual([]);
        expect(Planting.flowerbedPlanting(null, 1)).toEqual([]);
    });

    it('seeds a bed from its own vertices', () => {
        const ring = [[15.9, 45.8], [15.9001, 45.8], [15.9001, 45.8001], [15.9, 45.8]];
        expect(Planting.ringSeed(ring)).toBe(Planting.ringSeed(ring.map(p => p.slice())));
        expect(Planting.ringSeed(ring)).not.toBe(Planting.ringSeed(ring.map(([x, y]) => [x + 0.00001, y])));
    });
});
