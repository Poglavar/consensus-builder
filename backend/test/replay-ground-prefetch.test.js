// A replay loads its ground in ONE request, then folds in order.
//
// The fold has to stay ordered — each member cuts what the one before it left — but the fetches that
// put the ground on the map are independent reads. They used to sit INSIDE the fold, one await per
// member, so finishing a single road cost a round trip for every proposal already applied. Pulling
// them out and running them concurrently fixed the series; it did not fix the COUNT, and on a
// 165-member plan 165 concurrent-ish trips were still ~7 s of silence — mostly re-fetching each
// other's parcels, since adjacent proposals share ground and the memo is per PROPOSAL.
//
// Now every pending member's footprint goes into one MultiPolygon and the server answers once, with
// the parcels under all of them, DISTINCT. The per-member path stays as the fallback, so a footprint
// the batch cannot carry still gets its ground — and that path is still concurrent.

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

describe('the ground for a whole replay is fetched in one request', () => {
    it('asks in bounded batches, not once per member and not all at once', async () => {
        const seen = [];
        installGlobal('fetchParcelsUnderGeometry', async geometry => { seen.push(geometry); return { ids: [] }; });
        const manager = harness();

        await manager._loadReplayGround(Array.from({ length: 40 }, (_, i) => member(i)));

        // 40 members, 20 per request: two requests, not forty — and not one giant ask, which is how
        // a real plan blew the endpoint's parcel cap and paid 17 s for a 413.
        expect(seen).toHaveLength(2);
        seen.forEach(geometry => {
            expect(geometry.type).toBe('MultiPolygon');
            expect(geometry.coordinates.length).toBeLessThanOrEqual(20);
        });
        // Every member's footprint is in one of them — the answer must cover all their ground.
        expect(seen.reduce((sum, geometry) => sum + geometry.coordinates.length, 0)).toBe(40);
    });

    it('never sends more footprints in one request than the measured-safe batch', () => {
        expect(managerSource).toContain('const REPLAY_GROUND_BATCH_SIZE = 20;');
        expect(managerSource).toContain('index += REPLAY_GROUND_BATCH_SIZE');
    });

    it('carries each member\'s own footprint, not a box around them all', async () => {
        const seen = [];
        installGlobal('fetchParcelsUnderGeometry', async geometry => { seen.push(geometry); return { ids: [] }; });
        const manager = harness();
        await manager._loadReplayGround([member(0), member(1), member(2)]);

        // The asked-for area is the SUM of the three footprints, to the square metre. A bounding box
        // around them — the approximation this endpoint exists to avoid — could only ever be larger.
        const asked = turf.area({ type: 'Feature', properties: {}, geometry: seen[0] });
        const parts = [0, 1, 2].reduce((sum, i) => sum + turf.area({
            type: 'Feature', properties: {}, geometry: member(i).roadProposal.definition.polygon
        }), 0);
        expect(asked).toBeCloseTo(parts, 0);
        const box = turf.area(turf.bboxPolygon(turf.bbox({ type: 'Feature', properties: {}, geometry: seen[0] })));
        expect(asked).toBeLessThan(box);
    });

    it('halves and retries when the server refuses the batch, rather than losing the replay', async () => {
        // Over the parcel cap (413), or a dropped connection. Splitting keeps the win for the half
        // that fits instead of falling all the way back to one request per member.
        const sizes = [];
        installGlobal('fetchParcelsUnderGeometry', async geometry => {
            sizes.push(geometry.coordinates.length);
            if (geometry.coordinates.length > 2) throw new Error('413');
            return { ids: [] };
        });
        vi.spyOn(console, 'warn').mockImplementation(() => { });
        const manager = harness();

        await manager._loadReplayGround(Array.from({ length: 4 }, (_, i) => member(i)));

        expect(sizes[0]).toBe(4);          // the whole plan first
        expect(sizes.slice(1)).toEqual([2, 2]);
    });

    it('still fetches concurrently on the fallback path', async () => {
        // Members with no readable footprint cannot be batched; they must not go back to a series.
        const { state, fetcher } = gatedFetch();
        installGlobal('fetchParcelsUnderGeometry', fetcher);
        installGlobal('fetchParcelsForIds', fetcher);
        const manager = harness();
        const idOnly = index => ({ proposalId: `plain-${index}`, cadastreParcelIds: [`HR-1-${index}`] });

        const pass = manager._loadReplayGround(Array.from({ length: 8 }, (_, i) => idOnly(i)));
        await new Promise(resolve => setImmediate(resolve));
        expect(state.peak).toBeGreaterThan(1);
        expect(state.peak).toBeLessThanOrEqual(8);
        await drain(pass, state, 8);
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
        expect(calls).toBe(1);              // one request for all three
        await manager._loadReplayGround(members);
        await manager._loadReplayGround(members);
        expect(calls).toBe(1);
    });

    it('still fetches a formation joining an already-loaded plan', async () => {
        let calls = 0;
        installGlobal('fetchParcelsUnderGeometry', async () => { calls += 1; return { ids: [] }; });
        const manager = harness();

        await manager._loadReplayGround([member(0), member(1)]);
        await manager._loadReplayGround([member(0), member(1), member(2)]);
        // One request for the first pair, one for the newcomer alone.
        expect(calls).toBe(2);
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

describe('a shared corridor package materialises as one cadastral mutation', () => {
    it('marks every road first and derives their combined take set once', async () => {
        const roadA = member(0);
        const roadB = member(1);
        installGlobal('turf', turf);
        const records = new Map([[roadA.proposalId, roadA], [roadB.proposalId, roadB]]);
        installGlobal('proposalStorage', {
            getProposal: id => records.get(String(id)) || null,
            save: vi.fn()
        });
        installGlobal('setProposalApplied', (record, applied) => { record.applied = applied === true; });
        installGlobal('window', {
            __planOrder: planOrder,
            __parcelArrangement: {
                takeHitsOn: () => [{ take: {}, hit: square(16, 46, 16.0001, 46.0001) }]
            },
            __cadastreAncestry: {
                loadedCadastreParcels: () => [{ id: 'HR-1-1', feature: square(15.9, 45.9, 16.2, 46.2) }]
            },
            CorridorNetworkNodes: { normalize: vi.fn() }
        });

        const combinedTakes = [
            { id: roadA.proposalId, geometry: roadA.roadProposal.definition.polygon },
            { id: roadB.proposalId, geometry: roadB.roadProposal.definition.polygon }
        ];
        const derive = vi.fn(async () => ({ added: 3, removed: 0, unchanged: 0, parcels: 1, failed: [] }));
        const manager = {
            materializeCorridorBatch: ProposalManager.materializeCorridorBatch,
            _enqueueFabricChange: operation => operation(),
            _loadReplayGround: vi.fn(async () => 0),
            _appliedCorridorTakes: vi.fn(() => combinedTakes),
            _deriveCorridorFabric: derive,
            _sweepGroundNoLongerWhole: vi.fn(async () => ({ unapplied: [] })),
            _setLastApplyFailure: vi.fn()
        };

        const result = await manager.materializeCorridorBatch([roadA.proposalId, roadB.proposalId]);

        expect(result.ok, result.reason).toBe(true);
        expect(result.appliedIds).toEqual([roadA.proposalId, roadB.proposalId]);
        expect(roadA.applied).toBe(true);
        expect(roadB.applied).toBe(true);
        expect(derive).toHaveBeenCalledOnce();
        expect(derive).toHaveBeenCalledWith({ parcelIds: ['HR-1-1'], takes: combinedTakes });
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
