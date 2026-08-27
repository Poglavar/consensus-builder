// The replay's demolition ground in ONE request.
//
// Applying a building or structure proposal scans for the buildings it would demolish; the scan
// fetched footprints from the server once per proposal, so a 300-member replay was hundreds of
// round trips. The regions are all known up front, so they go to POST /buildings/under together
// and each member's scan receives its slice as `preloadedBuildings`.
//
// The failure contract matters more than the speed: an entry present (even empty) means "scanned,
// nothing there"; an entry ABSENT means "not covered — fetch for yourself". Collapsing those two is
// how a proposal gets stored as demolishing nothing, which was this session's original 429 bug in
// a new coat. These tests execute the real modules end to end with a stubbed fetch.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const turf = require('@turf/turf');

const prefetchApi = require('../../frontend/js/proposals/demolition-prefetch.js');

const square = (lng, lat, side = 0.0004) => ({
    type: 'Polygon',
    coordinates: [[[lng, lat], [lng + side, lat], [lng + side, lat + side], [lng, lat + side], [lng, lat]]]
});

describe('collecting the regions', () => {
    it('a building member contributes the union of its authored buildings, as Step 4 will', () => {
        const proposal = {
            proposalId: 'p-1',
            buildingProposal: {},
            geometry: { buildings: [square(15.87, 43.75), { type: 'Feature', geometry: square(15.88, 43.76) }] }
        };
        const regions = prefetchApi.collectDemolitionRegions([proposal]);
        expect(regions).toHaveLength(1);
        expect(regions[0].key).toBe('p-1');
        expect(regions[0].geometry.type).toBe('MultiPolygon');
        expect(regions[0].geometry.coordinates).toHaveLength(2);
    });

    it('a structure member asks the resolver, so the canonical fallback stays in one place', () => {
        const proposal = { proposalId: 'p-2', structureProposal: { kind: 'park' } };
        const canonical = square(15.87, 43.75);
        const regions = prefetchApi.collectDemolitionRegions([proposal], { structureGeometry: () => canonical });
        expect(regions).toHaveLength(1);
        expect(regions[0].geometry).toBe(canonical);
    });

    it('a road contributes NOTHING — roads keep their stored records on replay', () => {
        const road = { proposalId: 'p-3', roadProposal: { definition: {} } };
        expect(prefetchApi.collectDemolitionRegions([road])).toEqual([]);
    });

    it('a member with no geometry is skipped rather than sent as an empty region', () => {
        expect(prefetchApi.collectDemolitionRegions([{ proposalId: 'p-4', buildingProposal: {} }])).toEqual([]);
    });
});

describe('mapping the answer', () => {
    it('shapes entries exactly as the footprint pool does, id on properties.id', () => {
        // corridor-tunnel keys demolition records on properties.id; a different shape here would
        // mint records no other consumer could ever match back to a building.
        const byKey = prefetchApi.buildingFeaturesFromBulk(
            { 'p-1': [{ id: '77', geometry: square(15.87, 43.75), height_m: 9.5, floors: null }], 'p-2': [] },
            'overture-footprints'
        );
        const feature = byKey.get('p-1')[0];
        expect(feature.type).toBe('Feature');
        expect(feature.properties).toEqual({ id: '77', height_m: 9.5, floors: null, source: 'overture-footprints' });
        // The empty key survives the mapping — it is the "scanned, nothing there" answer.
        expect(byKey.get('p-2')).toEqual([]);
    });
});

describe('the scan uses what was fetched for it', () => {
    let saved;
    let ensureCalls;
    let tunnel;

    beforeEach(() => {
        saved = {
            window: globalThis.window,
            turf: globalThis.turf,
            fetch: globalThis.fetch,
            ProposalManager: globalThis.ProposalManager
        };
        ensureCalls = [];
        globalThis.window = globalThis;
        globalThis.turf = turf;
        globalThis.buildingFeaturePool = [];
        globalThis.proposedBuildings = [];
        globalThis.proposalStorage = { getAllProposals: () => [] };
        globalThis.ensureBuildingFootprintsForBounds = async (bounds) => { ensureCalls.push(bounds); };
        vi.spyOn(console, 'warn').mockImplementation(() => { });
        delete require.cache[require.resolve('../../frontend/js/corridor-tunnel.js')];
        tunnel = require('../../frontend/js/corridor-tunnel.js');
    });

    afterEach(() => {
        globalThis.window = saved.window; globalThis.turf = saved.turf; globalThis.fetch = saved.fetch;
        delete globalThis.buildingFeaturePool; delete globalThis.proposedBuildings;
        delete globalThis.demolishedBuildingRecordsFrom;
        delete globalThis.proposalStorage; delete globalThis.ensureBuildingFootprintsForBounds;
        if (saved.ProposalManager === undefined) delete globalThis.ProposalManager;
        else globalThis.ProposalManager = saved.ProposalManager;
        vi.restoreAllMocks();
    });

    const buildingUnder = (region) => ({
        type: 'Feature',
        properties: { id: 'bld-9', height_m: null, floors: null, source: 'overture-footprints' },
        geometry: square(region.coordinates[0][0][0] + 0.0001, region.coordinates[0][0][1] + 0.0001, 0.0002)
    });

    it('with preloaded buildings it makes NO network request and still finds the demolition', async () => {
        const region = square(15.87, 43.75, 0.0008);
        const records = await tunnel.demolishBuildingsUnderFootprint(region, {
            preloadedBuildings: [buildingUnder(region)]
        });
        expect(ensureCalls, 'the per-region fetch ran despite a preloaded answer').toHaveLength(0);
        expect(records).toHaveLength(1);
        expect(records[0].id).toBe('bld-9');
    });

    it('an EMPTY preloaded list means "scanned, nothing there" — still no network', async () => {
        const region = square(15.87, 43.75, 0.0008);
        // Deliberately put an overlapping building in the viewport pool. The exact server answer
        // for this proposal is empty, so replay must not scan the unrelated loaded-city pool.
        globalThis.buildingFeaturePool = [buildingUnder(region)];
        const records = await tunnel.demolishBuildingsUnderFootprint(region, {
            preloadedBuildings: []
        });
        expect(ensureCalls).toHaveLength(0);
        expect(records).toEqual([]);
    });

    it('an exact stock answer still checks proposal-owned buildings', async () => {
        const region = square(15.87, 43.75, 0.0008);
        globalThis.proposedBuildings = [{
            type: 'Feature',
            properties: { id: 'proposal-building', proposalId: 'older-proposal' },
            geometry: buildingUnder(region).geometry
        }];
        const unapplied = [];
        globalThis.ProposalManager = {
            unapplyProposal: async id => { unapplied.push(id); }
        };

        const records = await tunnel.demolishBuildingsUnderFootprint(region, {
            preloadedBuildings: [],
            proposalId: 'new-proposal'
        });

        expect(records).toEqual([]);
        expect(unapplied).toEqual(['older-proposal']);
    });

    it('with NO preloaded entry it fetches for itself, as before', async () => {
        await tunnel.demolishBuildingsUnderFootprint(square(15.87, 43.75, 0.0008), {});
        expect(ensureCalls).toHaveLength(1);
    });

    it('preloaded buildings still lose ground to existing demolition records', async () => {
        // A building an earlier proposal already fully demolished must not be found again by a
        // later member, wherever its geometry arrived from. The record filter runs INSIDE the
        // collector, which is why extraPool is injected there and not at the call site.
        const region = square(15.87, 43.75, 0.0008);
        // A record without geometry is dropped by consolidation — real records always carry the
        // demolished footprint.
        globalThis.demolishedBuildingRecordsFrom = () => [{ id: 'bld-9', geometry: square(15.87, 43.75, 0.0002) }];
        const records = await tunnel.demolishBuildingsUnderFootprint(region, {
            preloadedBuildings: [buildingUnder(region)]
        });
        expect(records).toEqual([]);
    });
});

describe('the manager end to end: prefetch returns exact apply options', () => {
    let saved;

    beforeEach(() => {
        saved = { window: globalThis.window, fetch: globalThis.fetch, turf: globalThis.turf };
        globalThis.window = globalThis;
        // proposal-manager registers reapply hooks with window.addEventListener at require time,
        // and this vitest worker's globalThis is not an EventTarget.
        if (typeof globalThis.addEventListener !== 'function') {
            globalThis.addEventListener = () => { };
            globalThis.removeEventListener = () => { };
        }
        globalThis.turf = turf;
        // The module self-registers on window at REQUIRE time, and the top-of-file require ran
        // before this window existed — put the cached api where the manager will look for it.
        globalThis.__demolitionPrefetch = prefetchApi;
        globalThis.getBackendBase = () => 'http://backend.test';
        globalThis.CityConfigManager = { getCurrentCityId: () => 'sibenik' };
        globalThis.proposalStorage = { getAllProposals: () => [] };
        vi.spyOn(console, 'warn').mockImplementation(() => { });
    });

    afterEach(() => {
        globalThis.window = saved.window; globalThis.fetch = saved.fetch; globalThis.turf = saved.turf;
        delete globalThis.getBackendBase; delete globalThis.CityConfigManager; delete globalThis.proposalStorage;
        delete globalThis.__demolitionPrefetch;
        delete globalThis.demolishBuildingsUnderFootprint;
        vi.restoreAllMocks();
    });

    const member = (id, lng) => ({
        proposalId: id,
        buildingProposal: {},
        geometry: { buildings: [square(lng, 43.75)] }
    });

    it('one POST covers every member, and each scan receives exactly its slice', async () => {
        const { ProposalManager } = require('../../frontend/js/proposal-manager.js');
        const posts = [];
        globalThis.fetch = async (url, init) => {
            posts.push({ url, body: JSON.parse(init.body) });
            const regions = {};
            JSON.parse(init.body).regions.forEach(region => {
                regions[region.key] = region.key === 'p-a'
                    ? [{ id: 'bld-1', geometry: square(15.87, 43.75, 0.0002), height_m: null, floors: null }]
                    : [];
            });
            return { ok: true, json: async () => ({ supported: true, truncated: false, source: 'overture-footprints', regions }) };
        };

        const fakeThis = {};
        const prefetched = await ProposalManager._prefetchDemolitionBuildings.call(
            fakeThis,
            [member('p-a', 15.87), member('p-b', 15.88)]
        );
        expect(posts).toHaveLength(1);
        expect(posts[0].url).toBe('http://backend.test/buildings/under');
        expect(posts[0].body.regions.map(region => region.key)).toEqual(['p-a', 'p-b']);

        const scans = [];
        globalThis.demolishBuildingsUnderFootprint = async (geometry, options) => {
            scans.push(options.preloadedBuildings);
            return [];
        };
        await ProposalManager._deriveDemolishedBuildings.call(fakeThis, square(15.87, 43.75), {
            proposalId: 'p-a',
            preloadedBuildings: prefetched.get('p-a')
        });
        await ProposalManager._deriveDemolishedBuildings.call(fakeThis, square(15.88, 43.75), {
            proposalId: 'p-b',
            preloadedBuildings: prefetched.get('p-b')
        });
        expect(scans[0]).toHaveLength(1);
        expect(scans[0][0].properties.id).toBe('bld-1');
        // Covered-but-empty arrives as [], which the scan reads as "nothing there, no fetch".
        expect(scans[1]).toEqual([]);
    });

    it('a failed bulk fetch leaves NO entries, so every member fetches for itself', async () => {
        const { ProposalManager } = require('../../frontend/js/proposal-manager.js');
        globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
        const fakeThis = {};
        const prefetched = await ProposalManager._prefetchDemolitionBuildings.call(fakeThis, [member('p-a', 15.87)]);
        expect(prefetched.has('p-a')).toBe(false);

        const scans = [];
        globalThis.demolishBuildingsUnderFootprint = async (geometry, options) => {
            scans.push(options.preloadedBuildings);
            return [];
        };
        await ProposalManager._deriveDemolishedBuildings.call(fakeThis, square(15.87, 43.75), { proposalId: 'p-a' });
        expect(scans[0], 'a failed prefetch must not masquerade as empty ground').toBeUndefined();
    });

    it('a member the bulk answer did NOT cover falls back, even when others were covered', async () => {
        // The sharpest edge of the contract. With a PARTIALLY filled map (one chunk failed, or a
        // member joined after the prefetch), an uncovered member must read as "not scanned" — not
        // as empty ground. Handing it [] here would store it as demolishing nothing.
        const { ProposalManager } = require('../../frontend/js/proposal-manager.js');
        globalThis.fetch = async (url, init) => {
            const regions = {};
            JSON.parse(init.body).regions.forEach(region => { regions[region.key] = []; });
            return { ok: true, json: async () => ({ supported: true, truncated: false, source: 'x', regions }) };
        };
        const fakeThis = {};
        const prefetched = await ProposalManager._prefetchDemolitionBuildings.call(fakeThis, [member('p-a', 15.87)]);
        expect(prefetched.has('p-a')).toBe(true);
        expect(prefetched.has('p-zz')).toBe(false);

        const scans = [];
        globalThis.demolishBuildingsUnderFootprint = async (geometry, options) => {
            scans.push(options.preloadedBuildings);
            return [];
        };
        // p-zz was never prefetched. The map is non-empty (p-a is in it), so the injection block
        // runs — and must pass NOTHING through for the uncovered key.
        await ProposalManager._deriveDemolishedBuildings.call(fakeThis, square(15.9, 43.75), { proposalId: 'p-zz' });
        expect(scans[0]).toBeUndefined();
    });

    it('a TRUNCATED bulk answer is discarded whole, not half-trusted', async () => {
        const { ProposalManager } = require('../../frontend/js/proposal-manager.js');
        globalThis.fetch = async () => ({
            ok: true,
            json: async () => ({ supported: true, truncated: true, source: 'overture-footprints', regions: { 'p-a': [] } })
        });
        const fakeThis = {};
        const prefetched = await ProposalManager._prefetchDemolitionBuildings.call(fakeThis, [member('p-a', 15.87)]);
        expect(prefetched.has('p-a')).toBe(false);

        const scans = [];
        globalThis.demolishBuildingsUnderFootprint = async (geometry, options) => {
            scans.push(options.preloadedBuildings);
            return [];
        };
        await ProposalManager._deriveDemolishedBuildings.call(fakeThis, square(15.87, 43.75), { proposalId: 'p-a' });
        expect(scans[0]).toBeUndefined();
    });
});
