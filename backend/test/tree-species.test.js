// Tree species (frontend/js/tree-species.js): the procedural species geometry, a tree's species,
// size and turn from its position and stored kind, the region that picks the species mix, the far
// tier's blob proportions and the near-tier selection.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const TreeSpecies = require('../../frontend/js/tree-species.js');

describe('species geometry', () => {
    it.each(TreeSpecies.SPECIES_IDS)('%s is a valid unit-height mesh within the instancing budget', id => {
        const g = TreeSpecies.buildSpecies(id);
        const vertices = g.positions.length / 3;
        expect(g.normals.length).toBe(g.positions.length);
        expect(g.colors.length).toBe(g.positions.length);
        expect(g.indices.length).toBe(g.triangles * 3);
        expect(Math.max(...g.indices)).toBeLessThan(vertices);
        expect(g.triangles).toBeGreaterThan(100);
        expect(g.triangles).toBeLessThanOrEqual(900);
        let top = -Infinity, bottom = Infinity;
        for (let i = 2; i < g.positions.length; i += 3) { top = Math.max(top, g.positions[i]); bottom = Math.min(bottom, g.positions[i]); }
        expect(top).toBeCloseTo(1, 6);
        expect(bottom).toBeGreaterThan(-0.02);
        for (let i = 0; i < g.normals.length; i += 3) expect(Math.hypot(g.normals[i], g.normals[i + 1], g.normals[i + 2])).toBeCloseTo(1, 4);
        expect([...g.colors].every(c => c >= 0 && c <= 1.5)).toBe(true);
    });

    it('is deterministic and gives each species its own shape', () => {
        expect(TreeSpecies.buildSpecies('linden').positions).toEqual(TreeSpecies.buildSpecies('linden').positions);
        const width = id => { const p = TreeSpecies.buildSpecies(id).positions; let r = 0; for (let i = 0; i < p.length; i += 3) r = Math.max(r, Math.hypot(p[i], p[i + 1])); return r; };
        expect(width('cypress')).toBeLessThan(width('linden') / 2);
        expect(() => TreeSpecies.buildSpecies('palm')).toThrow(/unknown tree species/);
    });
});

describe('species choice', () => {
    it('reads the eastern Adriatic coast and the Mediterranean basin as mediterranean, inland as temperate', () => {
        expect(TreeSpecies.regionOf(16.44, 43.51)).toBe('mediterranean'); // Split
        expect(TreeSpecies.regionOf(15.89, 43.73)).toBe('mediterranean'); // Šibenik
        expect(TreeSpecies.regionOf(14.44, 45.33)).toBe('mediterranean'); // Rijeka
        expect(TreeSpecies.regionOf(18.09, 42.65)).toBe('mediterranean'); // Dubrovnik
        expect(TreeSpecies.regionOf(23.73, 37.98)).toBe('mediterranean'); // Athens
        expect(TreeSpecies.regionOf(15.98, 45.81)).toBe('temperate'); // Zagreb
        expect(TreeSpecies.regionOf(20.46, 44.81)).toBe('temperate'); // Belgrade
        expect(TreeSpecies.regionOf(18.41, 43.85)).toBe('temperate'); // Sarajevo
        expect(TreeSpecies.regionOf(-74.0, 40.7)).toBe('temperate'); // New York
    });

    it('rolls an OSM tree from its region mix, stable for the same position', () => {
        const a = TreeSpecies.treeInstance(15.98, 45.81);
        expect(TreeSpecies.treeInstance(15.98, 45.81)).toEqual(a);
        const inland = new Set(), coast = new Set();
        for (let i = 0; i < 400; i++) {
            inland.add(TreeSpecies.treeInstance(15.9 + i * 0.0001, 45.8 + i * 0.00013).species);
            coast.add(TreeSpecies.treeInstance(16.4 + i * 0.0001, 43.5 + i * 0.00013).species);
        }
        expect([...inland].sort()).toEqual(['chestnut', 'linden', 'plane', 'spruce']);
        expect([...coast].sort()).toEqual(['cypress', 'linden', 'olive', 'pine', 'plane']);
    });

    it('keeps a tree inside its species height range, turned and tinted mildly', () => {
        for (let i = 0; i < 200; i++) {
            const look = TreeSpecies.treeInstance(15.9 + i * 0.0003, 45.8 + i * 0.0002);
            const [lo, hi] = TreeSpecies.SPECIES[look.species].heightM;
            expect(look.heightM).toBeGreaterThanOrEqual(lo);
            expect(look.heightM).toBeLessThanOrEqual(hi);
            expect(look.yaw).toBeGreaterThanOrEqual(0);
            expect(look.yaw).toBeLessThan(Math.PI * 2);
            look.tint.forEach(c => { expect(c).toBeGreaterThan(0.8); expect(c).toBeLessThan(1.2); });
        }
    });

    it('draws a park tree as its stored kind and height, the region choosing the species', () => {
        expect(TreeSpecies.treeInstance(15.98, 45.81, { kind: 'conifer', heightM: 11 })).toMatchObject({ species: 'spruce', heightM: 11 });
        expect(TreeSpecies.treeInstance(16.44, 43.51, { kind: 'conifer', heightM: 11 }).species).toBe('pine');
        expect(TreeSpecies.treeInstance(15.98, 45.81, { kind: 'columnar', heightM: 9 }).species).toBe('cypress');
        expect(TreeSpecies.treeInstance(15.98, 45.81, { kind: 'ornamental', heightM: 5 }).species).toBe('cherry');
        expect(['linden', 'plane', 'chestnut']).toContain(TreeSpecies.treeInstance(15.98, 45.81, { kind: 'broadleaf', heightM: 12 }).species);
        // A missing height is not zero: the species range applies.
        expect(TreeSpecies.treeInstance(15.98, 45.81, { kind: 'conifer', heightM: null }).heightM).toBeGreaterThanOrEqual(10);
    });
});

describe('tiers', () => {
    it('selects the trees within reach of the camera, at most the nearest count, ties included', () => {
        const points = [[10, 0], [1, 0], [5, 5], [2, 0], [2, 0], [-1, 0], [100, 100]];
        const mask = (...args) => [...TreeSpecies.nearTierMask(points, ...args)];
        expect(mask(0, 0, 0, 1000, 3)).toEqual([0, 1, 0, 1, 0, 1, 0]);
        expect(mask(0, 0, 0, 1000, 4)).toEqual([0, 1, 0, 1, 1, 1, 0]);
        expect(mask(0, 0, 0, 1000, 0)).toEqual([0, 0, 0, 0, 0, 0, 0]);
        expect(mask(0, 0, 0, 1000, 99)).toEqual([1, 1, 1, 1, 1, 1, 1]);
        expect(mask(100, 100, 0, 1000, 1)).toEqual([0, 0, 0, 0, 0, 0, 1]);
        // The radius bounds the tier even when the count would allow more.
        expect(mask(0, 0, 0, 3, 99)).toEqual([0, 1, 0, 1, 1, 1, 0]);
        // A camera 4 high reaches a ground disc of radius 3 within radius 5.
        expect(mask(0, 0, 4, 5, 99)).toEqual([0, 1, 0, 1, 1, 1, 0]);
        // From an orbit high above, nothing is near.
        expect(mask(0, 0, 900, 250, 99)).toEqual([0, 0, 0, 0, 0, 0, 0]);
    });

    it('keeps up to 2,500 trees within 250 m as meshes, 1,000 on a phone', () => {
        expect(TreeSpecies.NEAR_TIER_RADIUS_M).toBe(250);
        expect(TreeSpecies.nearTierSize()).toBe(2500);
        expect(TreeSpecies.nearTierSize({ coarsePointer: true })).toBe(1000);
    });

    it('gives the far blob the species proportions and the tree its own tinted colour', () => {
        const look = { species: 'cypress', heightM: 10, yaw: 0, tint: [1, 1, 1] };
        const blob = TreeSpecies.blobOf(look);
        expect(blob.crownRadius).toBeCloseTo(1, 6);
        expect(blob.crownZ).toBeCloseTo(5.2, 6);
        expect(blob.crownZ + blob.crownHeight).toBeLessThanOrEqual(10 + 1e-9);
        const tinted = TreeSpecies.blobOf({ ...look, tint: [1.1, 1, 0.9] });
        expect(tinted.color[0]).toBeCloseTo(blob.color[0] * 1.1, 9);
        expect(tinted.color[2]).toBeCloseTo(blob.color[2] * 0.9, 9);
    });
});
