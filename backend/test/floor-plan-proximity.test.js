// X-ray floor-model loading by proximity: nothing while X-ray is off or far away, nearest first, a
// bounded number in flight, and drops only well beyond the load radius (hysteresis).
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const { planFloorPlanLoads, DEFAULTS } = createRequire(import.meta.url)('../../frontend/js/floor-plan-proximity.js');
const at = (key, x, y = 0) => ({ key, x, y });
const ground = [0, 0, 30];
const plan = (extra = {}) => planFloorPlanLoads({ enabled: true, camera: ground, candidates: [], loaded: new Map(), pending: new Map(), ...extra });

describe('which floor models X-ray loads', () => {
    it('loads nothing and drops everything while X-ray is off', () => {
        const result = plan({ enabled: false, candidates: [at('a', 10)], loaded: new Map([['b', {}]]), pending: new Map([['c', {}]]) });
        expect(result).toEqual({ load: [], cancel: ['c'], unload: ['b'] });
    });

    it('loads only buildings within the radius, nearest first, at most two in flight', () => {
        const candidates = [at('far', 450), at('mid', 120), at('near', 40), at('edge', 0, 195), at('next', 80)];
        expect(plan({ candidates }).load).toEqual(['near', 'next']);
        expect(plan({ candidates, pending: new Map([['near', {}]]) }).load).toEqual(['next']);
        expect(plan({ candidates, loaded: new Map([['near', null], ['next', {}]]) }).load).toEqual(['mid', 'edge']);
        expect(plan({ candidates, loaded: new Map([['near', null], ['next', {}], ['mid', {}], ['edge', {}]]) }).load).toEqual([]);
        expect(DEFAULTS).toEqual({ loadRadiusM: 200, unloadRadiusM: 300, maxConcurrent: 2 });
    });

    it('counts the camera height, so a high overview loads nothing', () => {
        expect(plan({ camera: [0, 0, 400], candidates: [at('below', 0)] }).load).toEqual([]);
    });

    it('keeps a building between the load and unload radii, and drops it or its request beyond', () => {
        const loaded = new Map([['kept', {}], ['gone', {}], ['vanished', {}]]);
        const pending = new Map([['waiting', {}], ['left', {}]]);
        const candidates = [at('kept', 250), at('gone', 320), at('waiting', 260), at('left', 0, 500)];
        const result = plan({ candidates, loaded, pending });
        expect(result.unload).toEqual(['gone', 'vanished']);
        expect(result.cancel).toEqual(['left']);
        // 'kept' is not re-requested; one slot is busy with 'waiting'.
        expect(result.load).toEqual([]);
    });
});
