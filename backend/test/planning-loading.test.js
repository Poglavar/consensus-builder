// The loading ring around the Buildings and massing button: PlanningLoading records which code is
// still loading each role, PlanningScene.loadingArcs turns that into packed thirds of the rim.
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadingArcs } = require('../../frontend/js/planning/scene.js');

describe('loadingArcs', () => {
    it('gives each loading role a third of the rim, packed from the first slot in role order', () => {
        expect(loadingArcs({ existing: true, permitted: true, proposed: false })).toEqual([{ role: 'existing', slot: 0 }, { role: 'permitted', slot: 1 }]);
        expect(loadingArcs({ permitted: true })).toEqual([{ role: 'permitted', slot: 0 }]);
        expect(loadingArcs({ existing: true, permitted: true, proposed: true }).map(arc => arc.slot)).toEqual([0, 1, 2]);
        expect(loadingArcs({})).toEqual([]);
    });
    it('leaves out a role that is switched off', () => {
        expect(loadingArcs({ existing: true, proposed: true }, { existing: false, proposed: true })).toEqual([{ role: 'proposed', slot: 0 }]);
    });
});

describe('PlanningLoading', () => {
    function load() {
        const events = [];
        const win = { dispatchEvent: vi.fn(event => events.push(event.detail)) };
        vi.stubGlobal('window', win);
        vi.resetModules();
        const modulePath = require.resolve('../../frontend/js/planning/loading.js');
        delete require.cache[modulePath];
        const api = require(modulePath);
        vi.unstubAllGlobals();
        return { api, win, events };
    }
    it('keeps a role loading until every source holding it has ended, announcing each change once', () => {
        const { api, events } = load();
        api.set('existing', 'map', true);
        api.set('existing', 'model', true);
        api.set('existing', 'map', true);
        expect(api.state()).toEqual({ existing: true, permitted: false, proposed: false });
        api.set('existing', 'map', false);
        expect(api.state().existing).toBe(true);
        api.set('existing', 'model', false);
        expect(api.state().existing).toBe(false);
        expect(events.map(state => state.existing)).toEqual([true, true, true, false]);
    });
    it('refuses a role Buildings and massing does not have', () => {
        expect(() => load().api.set('trees', 'map', true)).toThrow('Unknown Buildings and massing role: trees');
    });
    it('keeps overlapping planning reads visible until both settle, including a failed read', async () => {
        const { api } = load();
        let complete;
        const overview = api.track('permitted', new Promise(resolve => { complete = resolve; }));
        await expect(api.track('permitted', Promise.reject(new Error('offline')))).rejects.toThrow('offline');
        expect(api.state().permitted).toBe(true);
        complete('loaded');
        await expect(overview).resolves.toBe('loaded');
        expect(api.state().permitted).toBe(false);
    });
});
