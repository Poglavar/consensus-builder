// A corridor can be longer than any viewport, so the ground it declares has to be loaded before the
// live-fabric resolver is asked whether it can see enough of it.
//
// This is the failure it exists to stop, and it is the quietest kind: an imported 17 km track
// declares 661 parent parcels, the viewport holds a few dozen, the resolver correctly refuses a
// fabric that covers 12% of the footprint — and the proposal still draws on the map. It looks
// applied and cuts nothing, which reads as a broken cut rather than as absent ground.
//
// The staging is also on the hot path of every ordinary road, so the other half pinned here is that
// a corridor whose ground is already loaded pays nothing at all.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const roadApply = require('../../frontend/js/proposals/apply/road.js');

const IDS = ['HR-330264-628', 'HR-330264-680', 'HR-330264-685/1'];

let calls;
const originals = {};

const install = (name, value) => {
    if (!(name in originals)) originals[name] = globalThis[name];
    globalThis[name] = value;
};

beforeEach(() => {
    calls = { ensure: [], waited: [], missing: [], status: [] };
    install('findMissingParentParcels', ids => { calls.missing.push(ids); return calls.missingResult ?? []; });
    install('ensureParentParcelsLoaded', async ids => { calls.ensure.push(ids); });
    install('waitForParcelLayersReady', async (ids, options) => { calls.waited.push(ids); calls.waitOptions = options; });
    install('updateStatus', message => { calls.status.push(message); });
});

afterEach(() => {
    Object.keys(originals).forEach(name => {
        if (originals[name] === undefined) delete globalThis[name];
        else globalThis[name] = originals[name];
    });
});

const stage = (ids = IDS) => roadApply._stageCorridorGround.call(roadApply, ids, 'test-corridor');

describe('_stageCorridorGround', () => {
    it('loads the declared ground when the fabric is missing some of it', async () => {
        calls.missingResult = ['HR-330264-680'];
        await stage();
        expect(calls.ensure).toEqual([IDS]);
        expect(calls.waited).toEqual([IDS]);
    });

    it('fetches nothing when every declared parcel is already live', async () => {
        calls.missingResult = [];
        await stage();
        expect(calls.ensure).toEqual([]);
        expect(calls.waited).toEqual([]);
        expect(calls.status).toEqual([]);
    });

    it('waits for the layers, not just the fetch — a fetched parcel is not yet resolvable', async () => {
        calls.missingResult = IDS;
        const order = [];
        install('ensureParentParcelsLoaded', async () => { order.push('fetch'); });
        install('waitForParcelLayersReady', async () => { order.push('render'); });
        await stage();
        expect(order).toEqual(['fetch', 'render']);
    });

    it('says what it is doing, because the fetch is long enough to look like a hang', async () => {
        calls.missingResult = IDS;
        await stage();
        expect(calls.status.join(' ')).toMatch(/3 parcels/);
    });

    it('gives a large corridor longer than the default to finish rendering, but a bounded one', async () => {
        calls.missingResult = IDS;
        await roadApply._stageCorridorGround.call(roadApply, IDS, 'small');
        expect(calls.waitOptions.timeoutMs).toBeGreaterThan(8000);

        const many = Array.from({ length: 661 }, (_, index) => `HR-330264-${index}`);
        calls.missingResult = many;
        await roadApply._stageCorridorGround.call(roadApply, many, 'big');
        // A real imported track: comfortably longer than the default, and still finite.
        expect(calls.waitOptions.timeoutMs).toBeGreaterThan(20000);
        expect(calls.waitOptions.timeoutMs).toBeLessThanOrEqual(30000);

        // However long the corridor gets, the wait must never become unbounded.
        const absurd = Array.from({ length: 50000 }, (_, index) => `HR-1-${index}`);
        calls.missingResult = absurd;
        await roadApply._stageCorridorGround.call(roadApply, absurd, 'absurd');
        expect(calls.waitOptions.timeoutMs).toBe(30000);
    });

    it('is a no-op for a corridor that declares no parents', async () => {
        calls.missingResult = IDS;
        await stage([]);
        expect(calls.ensure).toEqual([]);
    });

    it('does not become fatal when the loader fails — the resolver still gets to refuse', async () => {
        calls.missingResult = IDS;
        install('ensureParentParcelsLoaded', async () => { throw new Error('network down'); });
        await expect(stage()).resolves.toBeUndefined();
    });

    it('survives a missing loader entirely', async () => {
        install('ensureParentParcelsLoaded', undefined);
        await expect(stage()).resolves.toBeUndefined();
    });

    it('treats an unusable missing-check as "assume missing" rather than skipping the load', async () => {
        install('findMissingParentParcels', () => { throw new Error('nope'); });
        await stage();
        expect(calls.ensure).toEqual([IDS]);
    });
});
