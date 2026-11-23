import { describe, expect, it, vi } from 'vitest';
const water = require('../../frontend/js/three-regional-water.js');

describe('regional water tiles', () => {
    it('selects a bounded coarse and detailed set, including across the antimeridian', () => {
        expect(water.tilesForBounds([76, 43, 78, 44], 6).length).toBeGreaterThan(0);
        expect(new Set(water.tilesForBounds([179, -1, -179, 1], 4).map(tile => tile.x))).toEqual(new Set([15, 0]));
        const levels = water.levelsForView([76, 43, 78, 44], 1200, 800);
        expect(levels[1]).toBeGreaterThanOrEqual(levels[0]);
        expect(water.tilesForBounds([76, 43, 78, 44], 12, 1)).toEqual([]);
        expect(water.boundedTiles([76, 43, 78, 44], 14, 2, 0.12).length).toBeGreaterThan(0);
        expect(water.boundedTiles([76, 43, 78, 44], 14, 2, 0.12)[0].z).toBeLessThan(14);
    });

    it('swaps a complete coarse cover for a complete detail cover without drawing both', async () => {
        const calls = [];
        const changes = [];
        const detailResolvers = [];
        const view = water.create({
            fetchTile: (tile) => {
                calls.push(tile);
                if (tile.z < 14) return { areas: [{ geometry: { type: 'Polygon' } }] };
                return new Promise(resolve => { detailResolvers.push(resolve); });
            },
            onChange: state => changes.push(state), concurrency: 8
        });
        view.update({ bounds: [76, 43, 76.01, 43.01], width: 1200, height: 800 });
        await vi.waitFor(() => expect(detailResolvers.length).toBeGreaterThan(0));
        expect(new Set(changes.at(-1).tiles.map(value => value.tile.z))).toEqual(new Set([12]));
        detailResolvers.forEach(resolve => resolve({ areas: [] }));
        await vi.waitFor(() => expect(view.state().loading).toBe(0));
        expect(new Set(changes.at(-1).tiles.map(value => value.tile.z))).toEqual(new Set([14]));
        view.destroy();
    });

    it('retains the last complete view through failed detail and ignores a superseded late response', async () => {
        const pending = [];
        const changes = [];
        const view = water.create({
            fetchTile: (tile, { signal }) => new Promise((resolve, reject) => {
                pending.push({ tile, resolve, reject, signal });
            }),
            onChange: state => changes.push(state), concurrency: 1
        });
        view.update({ bounds: [76, 43, 76.001, 43.001], width: 1000, height: 700 });
        await vi.waitFor(() => expect(pending.length).toBe(1));
        pending[0].resolve({ areas: [{ id: 'coarse-a' }] });
        await vi.waitFor(() => expect(pending.length).toBe(2));
        expect(changes.at(-1).tiles[0].areas[0].id).toBe('coarse-a');

        view.update({ bounds: [77, 44, 77.001, 44.001], width: 1000, height: 700 });
        await vi.waitFor(() => expect(pending.length).toBe(3));
        // A request that began for the previous camera position cannot replace the current view.
        pending[1].resolve({ areas: [{ id: 'late-a' }] });
        expect(changes.at(-1).tiles[0].areas[0].id).toBe('coarse-a');
        pending[2].resolve({ areas: [{ id: 'coarse-b' }] });
        await vi.waitFor(() => expect(changes.at(-1).tiles[0].areas[0].id).toBe('coarse-b'));
        await vi.waitFor(() => expect(pending.length).toBe(4));
        pending[3].reject(new Error('network'));
        await vi.waitFor(() => expect(view.state().loading).toBe(0));
        expect(changes.at(-1).tiles[0].areas[0].id).toBe('coarse-b');
        view.destroy();
    });

    it('retries a missing detail tile while the coarse lake remains visible', async () => {
        const pending = [];
        const changes = [];
        const view = water.create({
            fetchTile: tile => new Promise((resolve, reject) => pending.push({ tile, resolve, reject })),
            onChange: state => changes.push(state), concurrency: 1, retryDelayMs: 1, retryLimit: 1
        });
        view.update({ bounds: [76, 43, 76.001, 43.001], width: 1000, height: 700 });
        await vi.waitFor(() => expect(pending.length).toBe(1));
        pending[0].resolve({ areas: [{ id: 'coarse' }] });
        await vi.waitFor(() => expect(pending.length).toBe(2));
        pending[1].reject(new Error('temporary missing tile'));
        await vi.waitFor(() => expect(pending.length).toBe(3));
        expect(changes.at(-1).tiles[0].areas[0].id).toBe('coarse');
        pending[2].resolve({ areas: [{ id: 'detail' }] });
        await vi.waitFor(() => expect(changes.at(-1).tiles[0].areas[0].id).toBe('detail'));
        view.destroy();
    });

    it('cancels a scheduled retry when the controller is cleared', async () => {
        let requests = 0;
        const view = water.create({
            fetchTile: () => { requests++; return Promise.reject(new Error('missing')); },
            concurrency: 1, retryDelayMs: 10_000, retryLimit: 1
        });
        view.update({ bounds: [76, 43, 76.001, 43.001], width: 1000, height: 700 });
        // The current view has one coarse and one detail candidate. Clear after both failures,
        // before the first scheduled retry can run.
        await vi.waitFor(() => expect(requests).toBe(2));
        view.clear();
        await new Promise(resolve => setTimeout(resolve, 45));
        expect(requests).toBe(2);
        view.destroy();
    });

    it('retries an in-flight tile retained by a nearby camera update', async () => {
        const pending = [];
        const view = water.create({
            fetchTile: tile => new Promise((resolve, reject) => pending.push({ tile, resolve, reject })),
            concurrency: 1, retryDelayMs: 1, retryLimit: 1
        });
        view.update({ bounds: [76, 43, 76.001, 43.001], width: 1000, height: 700 });
        await vi.waitFor(() => expect(pending.length).toBe(1));
        // This moves into a neighbouring detailed tile while retaining the same coarse one.
        view.update({ bounds: [76.005, 43, 76.006, 43.001], width: 1000, height: 700 });
        pending[0].reject(new Error('temporary'));
        await vi.waitFor(() => expect(pending.length).toBe(2));
        expect(pending[1].tile.z).toBe(14);
        pending[1].resolve({ areas: [{ id: 'detail-before-retry' }] });
        await vi.waitFor(() => expect(pending.length).toBe(3));
        expect(pending[2].tile.z).toBe(12);
        pending[2].resolve({ areas: [{ id: 'new-coarse' }] });
        await vi.waitFor(() => expect(view.state().visible).toBe(1));
        view.destroy();
    });
});
