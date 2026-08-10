// A replay loads its ground all at once, then folds in order.
//
// The fold has to stay ordered — each member cuts what the one before it left — but the fetches
// that put the ground on the map are independent reads, and they used to sit INSIDE the fold, one
// await per member. So finishing a single road cost one HTTP round-trip for every proposal already
// applied, in series, before any geometry ran: a plan of twenty roads paid twenty trips, and every
// road drawn made the next one slower.
//
// Concurrency is the whole point of the change, so it is asserted directly — a lane count of one
// would pass every behavioural test while restoring exactly the cost that was removed.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ProposalManager } = require('../../frontend/js/proposal-manager.js');
const planOrder = require('../../frontend/js/proposals/plan-order.js');
const turf = require('@turf/turf');
const { readFileSync } = require('node:fs');

const managerSource = readFileSync(new URL('../../frontend/js/proposal-manager.js', import.meta.url), 'utf8');

const saved = new Map();
function installGlobal(name, value) {
    if (!saved.has(name)) {
        saved.set(name, {
            existed: Object.prototype.hasOwnProperty.call(globalThis, name),
            value: globalThis[name]
        });
    }
    globalThis[name] = value;
}

afterEach(() => {
    for (const [name, prior] of saved) {
        if (prior.existed) globalThis[name] = prior.value;
        else delete globalThis[name];
    }
    saved.clear();
    vi.restoreAllMocks();
});

const square = (w, s, e, n) => turf.polygon([[[w, s], [e, s], [e, n], [w, n], [w, s]]]);

const member = index => ({
    proposalId: `road-${index}`,
    goal: 'road-track',
    roadProposal: {
        definition: { polygon: square(16 + index / 1000, 46, 16.0005 + index / 1000, 46.001).geometry }
    }
});

// A fetch that never resolves on its own, so the number of lanes open at once is observable.
function gatedFetch() {
    const state = { inFlight: 0, peak: 0, calls: 0, pending: [] };
    const fetcher = () => {
        state.inFlight += 1;
        state.calls += 1;
        state.peak = Math.max(state.peak, state.inFlight);
        return new Promise(resolve => {
            state.pending.push(() => { state.inFlight -= 1; resolve({ ids: [], count: 0 }); });
        });
    };
    return { state, fetcher };
}

// Release everything currently waiting, repeatedly, until the pass finishes.
async function drain(promise, state, members) {
    let settled = false;
    promise.then(() => { settled = true; }, () => { settled = true; });
    for (let round = 0; round < members + 5 && !settled; round += 1) {
        while (state.pending.length) state.pending.shift()();
        await new Promise(resolve => setImmediate(resolve));
    }
    return promise;
}

function harness() {
    installGlobal('window', { __planOrder: planOrder, __formationEdit: null });
    installGlobal('getProposalKey', proposal => proposal.proposalId);
    installGlobal('turf', turf);
    // A fresh memo per harness: it is per-session state, and a shared one would let one test's
    // fetches silently satisfy the next test's.
    return { _loadReplayGround: ProposalManager._loadReplayGround, _replayGroundFetched: new Set() };
}

describe('the ground for a whole replay is fetched concurrently', () => {
    it('opens several lanes at once rather than one member at a time', async () => {
        const members = Array.from({ length: 8 }, (_, i) => member(i));
        const { state, fetcher } = gatedFetch();
        installGlobal('fetchParcelsUnderGeometry', fetcher);
        const manager = harness();

        const pass = manager._loadReplayGround(members);
        // The lanes open synchronously, before anything can resolve.
        expect(state.peak).toBeGreaterThan(1);
        await drain(pass, state, members.length);
        expect(state.calls).toBe(8);
    });

    it('caps the fan-out so a big plan is not a burst against a rate-limited API', async () => {
        const members = Array.from({ length: 40 }, (_, i) => member(i));
        const { state, fetcher } = gatedFetch();
        installGlobal('fetchParcelsUnderGeometry', fetcher);
        const manager = harness();

        const pass = manager._loadReplayGround(members);
        expect(state.peak).toBeLessThanOrEqual(8);
        await drain(pass, state, members.length);
        expect(state.calls).toBe(40);
    });

    it('never opens more lanes than there are members', async () => {
        const { state, fetcher } = gatedFetch();
        installGlobal('fetchParcelsUnderGeometry', fetcher);
        const manager = harness();

        const pass = manager._loadReplayGround([member(0), member(1)]);
        expect(state.peak).toBe(2);
        await drain(pass, state, 2);
    });

    it('asks for each member by its own footprint', async () => {
        const seen = [];
        installGlobal('fetchParcelsUnderGeometry', async footprint => { seen.push(turf.area(footprint)); return { ids: [] }; });
        const manager = harness();
        await manager._loadReplayGround([member(0), member(1), member(2)]);
        expect(seen).toHaveLength(3);
        seen.forEach(area => expect(area).toBeGreaterThan(0));
    });

    it('reports what it cost, so a slow rebuild can say which half was slow', async () => {
        installGlobal('fetchParcelsUnderGeometry', async () => ({ ids: [] }));
        const manager = harness();
        const ms = await manager._loadReplayGround([member(0)]);
        expect(typeof ms).toBe('number');
        expect(ms).toBeGreaterThanOrEqual(0);
    });

    it('costs nothing when there is nothing applied', async () => {
        const manager = harness();
        await expect(manager._loadReplayGround([])).resolves.toBe(0);
        await expect(manager._loadReplayGround(null)).resolves.toBe(0);
    });
});

describe('ground already on the map is not fetched again', () => {
    it('asks once per formation, however many rebuilds follow', async () => {
        // This is the cost that scaled with the plan: N members × one round-trip, on EVERY finish.
        let calls = 0;
        installGlobal('fetchParcelsUnderGeometry', async () => { calls += 1; return { ids: [] }; });
        const manager = harness();
        const members = [member(0), member(1), member(2)];

        await manager._loadReplayGround(members);
        expect(calls).toBe(3);
        await manager._loadReplayGround(members);
        await manager._loadReplayGround(members);
        expect(calls).toBe(3);
    });

    it('still fetches a formation joining an already-loaded plan', async () => {
        let calls = 0;
        installGlobal('fetchParcelsUnderGeometry', async () => { calls += 1; return { ids: [] }; });
        const manager = harness();

        await manager._loadReplayGround([member(0), member(1)]);
        await manager._loadReplayGround([member(0), member(1), member(2)]);
        expect(calls).toBe(3);
    });

    it('retries one whose fetch failed rather than leaving it short of ground', async () => {
        // A 429 or a dropped connection must not be remembered as "loaded" — that would strand the
        // formation below the coverage gate for the rest of the session.
        let attempts = 0;
        installGlobal('fetchParcelsUnderGeometry', async () => {
            attempts += 1;
            if (attempts === 1) throw new Error('429');
            return { ids: [] };
        });
        vi.spyOn(console, 'warn').mockImplementation(() => { });
        const manager = harness();

        await manager._loadReplayGround([member(0)]);
        await manager._loadReplayGround([member(0)]);
        expect(attempts).toBe(2);
        await manager._loadReplayGround([member(0)]);
        expect(attempts).toBe(2);
    });
});

describe('when the footprint question cannot be asked', () => {
    it('falls back to the declared ids, never to a bounding box', async () => {
        const asked = [];
        installGlobal('fetchParcelsUnderGeometry', async () => null);
        installGlobal('fetchParcelsForIds', async ids => { asked.push(...ids); });
        const manager = harness();
        await manager._loadReplayGround([{
            proposalId: 'no-geometry',
            cadastreParcelIds: ['HR-1-1'],
            parentParcelIds: ['HR-1-2#p-road-1']
        }]);
        expect(asked).toContain('HR-1-1');
        expect(asked).toContain('HR-1-2#p-road-1');
    });

    it('one member whose fetch throws does not abandon the rest', async () => {
        const done = [];
        installGlobal('fetchParcelsUnderGeometry', async footprint => {
            if (turf.area(footprint) > 0 && done.length === 0) { done.push('threw'); throw new Error('network'); }
            done.push('ok');
            return { ids: [] };
        });
        vi.spyOn(console, 'warn').mockImplementation(() => { });
        const manager = harness();
        await manager._loadReplayGround([member(0), member(1), member(2)]);
        expect(done).toEqual(['threw', 'ok', 'ok']);
    });
});

describe('finishing a corridor asks the map before the database', () => {
    // Inherited from the retired corridor-ground-staging test: a corridor must not derive against
    // ground that is not there. The check moved rather than went away — the parcels under a ribbon
    // the user just drew are almost always already loaded (they were fetched to draw over), and the
    // round trip was the largest remaining cost of finishing a road (~270 ms against ~30 ms of
    // geometry). Anything short of complete cover still fetches.
    const corridor = {
        proposalId: 'road-new',
        goal: 'road-track',
        roadProposal: { definition: { polygon: square(16.0000, 46.0000, 16.0010, 46.0010).geometry } }
    };

    function corridorHarness(loadedParcels) {
        installGlobal('turf', turf);
        installGlobal('getProposalKey', proposal => proposal.proposalId);
        installGlobal('proposalStorage', { getAllProposals: () => [], save: () => { } });
        installGlobal('window', {
            __planOrder: planOrder,
            __formationEdit: null,
            __parcelArrangement: require('../../frontend/js/proposals/parcel-arrangement.js'),
            __cadastreAncestry: { loadedCadastreParcels: () => loadedParcels }
        });
        return {
            _loadReplayGround: ProposalManager._loadReplayGround,
            _replayGroundFetched: new Set(),
            _appliedCorridorTakes: () => [],
            _deriveCorridorFabric: () => ({ added: 0, removed: 0, unchanged: 0, parcels: 0, failed: [] }),
            _sweepGroundNoLongerWhole: () => ({ unapplied: [] }),
            deriveCorridorIncrementally: ProposalManager.deriveCorridorIncrementally
        };
    }

    it('does not fetch when the loaded cadastre already covers the ribbon', async () => {
        let calls = 0;
        installGlobal('fetchParcelsUnderGeometry', async () => { calls += 1; return { ids: [] }; });
        // One parcel that swallows the whole footprint.
        const manager = corridorHarness([{ id: 'HR-1-1', feature: square(15.999, 45.999, 16.002, 46.002) }]);
        const result = await manager.deriveCorridorIncrementally(corridor);
        expect(result).toBeTruthy();
        expect(calls).toBe(0);
    });

    it('fetches when the loaded cadastre covers only part of it', async () => {
        let calls = 0;
        installGlobal('fetchParcelsUnderGeometry', async () => { calls += 1; return { ids: [] }; });
        // Half the ribbon has no parcel under it.
        const manager = corridorHarness([{ id: 'HR-1-1', feature: square(16.0000, 46.0000, 16.0005, 46.0010) }]);
        await manager.deriveCorridorIncrementally(corridor);
        expect(calls).toBe(1);
    });

    it('fetches when nothing at all is loaded', async () => {
        let calls = 0;
        installGlobal('fetchParcelsUnderGeometry', async () => { calls += 1; return { ids: [] }; });
        const manager = corridorHarness([]);
        await manager.deriveCorridorIncrementally(corridor);
        expect(calls).toBe(1);
    });

    it('leaves anything that is not a corridor to the ordinary path', async () => {
        const manager = corridorHarness([]);
        await expect(manager.deriveCorridorIncrementally({ proposalId: 'p', goal: 'park' })).resolves.toBe(null);
        await expect(manager.deriveCorridorIncrementally(null)).resolves.toBe(null);
    });
});

describe('the fold itself no longer fetches', () => {
    const pass = (() => {
        const start = managerSource.indexOf('async _rebuildPass(');
        return managerSource.slice(start, managerSource.indexOf('\n    },', start));
    })();

    it('loads the ground before the ordered loop', () => {
        expect(pass.indexOf('_loadReplayGround')).toBeLessThan(pass.indexOf('for (const proposal of appliedList)'));
    });

    it('has no per-member fetch inside the loop', () => {
        const loop = pass.slice(pass.indexOf('for (const proposal of appliedList)'));
        expect(loop).not.toMatch(/fetchParcelsUnderGeometry/);
        expect(loop).not.toMatch(/fetchParcelsForIds/);
    });

    it('still applies members one at a time, in order', () => {
        const loop = pass.slice(pass.indexOf('for (const proposal of appliedList)'));
        expect(loop).toMatch(/await this\.applyProposal\(key, \{ replay: true \}\)/);
    });
});
