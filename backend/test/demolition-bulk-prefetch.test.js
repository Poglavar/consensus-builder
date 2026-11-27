// The land a building or structure design clears (frontend/js/proposals/demolition-prefetch.js):
// the region the apply path registers with demolition-index.js, and that plan stats, Compare and
// MCP compare measure the existing buildings against.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const turf = require('@turf/turf');

const prefetchApi = require('../../frontend/js/proposals/demolition-prefetch.js');

const square = (lng, lat, side = 0.0004) => ({
    type: 'Polygon',
    coordinates: [[[lng, lat], [lng + side, lat], [lng + side, lat + side], [lng, lat + side], [lng, lat]]]
});

// A design clears the ground it takes (2026-10-22): a block or rule its site, a Freeform building
// its land take or footprint, a rule that raises the existing buildings only what it redraws —
// never the rest of the parcels it stands on, however large they are.
describe('the ground a building design clears', () => {
    // A large parcel (about 2 km across) with a block site in one corner and another design's in the other.
    const parcel = { type: 'Feature', properties: { parcelId: 'HR-A' }, geometry: square(15.86, 43.74, 0.02) };
    const site = square(15.861, 43.741, 0.001);
    const block = () => ({
        proposalId: 'p-1', goal: 'buildings', cadastreParcelIds: ['HR-A'], site,
        buildingProposal: { typologyType: 'block' },
        geometry: { buildings: [square(15.8612, 43.7412), { type: 'Feature', geometry: square(15.8615, 43.7415) }] }
    });

    it('a block takes its site and its buildings, not the rest of the parcel it stands on', () => {
        const geometry = prefetchApi.buildingDemolitionGeometry(block());
        expect(geometry.type).toBe('MultiPolygon');
        expect(geometry.coordinates).toEqual([site.coordinates, square(15.8612, 43.7412).coordinates, square(15.8615, 43.7415).coordinates]);
        expect(turf.area(geometry)).toBeLessThan(turf.area(parcel) / 100);
        // A second block in the parcel's other corner: neither design's land reaches the other's buildings.
        const other = { ...block(), proposalId: 'p-2', site: square(15.878, 43.758, 0.001), geometry: { buildings: [square(15.8782, 43.7582)] } };
        const otherLand = turf.feature(prefetchApi.buildingDemolitionGeometry(other));
        expect(turf.booleanIntersects(otherLand, turf.feature(geometry))).toBe(false);
        expect(prefetchApi.buildingLandOf({ ...block(), site: { type: 'Feature', properties: {}, geometry: site } })).toEqual({ land: site });
    });

    // Its binding was computed on its footprints (site-binding.js siteOf), so that is its land.
    it('a design without a site clears its footprints, never the parcels it stands on', () => {
        const { site: _site, ...siteless } = block();
        expect(prefetchApi.buildingLandOf({ ...siteless, site: null })).toEqual({ land: null });
        expect(prefetchApi.buildingDemolitionGeometry(siteless).coordinates).toEqual([square(15.8612, 43.7412).coordinates, square(15.8615, 43.7415).coordinates]);
    });

    it('a rule that raises the existing buildings clears only what it redraws', () => {
        const raise = block();
        raise.buildingProposal.parameters = { mode: 'existing', rule: 'additional' };
        expect(prefetchApi.buildingLandOf(raise)).toEqual({ land: null });
        expect(prefetchApi.buildingDemolitionGeometry(raise).coordinates).toHaveLength(2);
    });

    it('a Freeform building forms its own parcel: its footprint or stepped parts, or its land take', () => {
        const single = { ...block(), goal: 'single', geometry: { buildings: [square(15.87, 43.75)] } };
        expect(prefetchApi.buildingDemolitionGeometry(single)).toEqual(square(15.87, 43.75));
        // The single key's aliases, as apply/route.js normalizes them.
        expect(prefetchApi.buildingDemolitionGeometry({ ...single, goal: 'Single building' })).toEqual(square(15.87, 43.75));
        // A stepped building (two parts) is still one building on its own land: its parts, never the parcel.
        const stepped = { ...single, geometry: { buildings: [square(15.87, 43.75), square(15.8702, 43.7502)] } };
        expect(prefetchApi.buildingDemolitionGeometry(stepped).coordinates).toEqual([square(15.87, 43.75).coordinates, square(15.8702, 43.7502).coordinates]);
        const whole = { ...single, geometry: { ...single.geometry, landTake: parcel } };
        expect(prefetchApi.buildingDemolitionGeometry(whole)).toEqual(parcel.geometry);
    });

    it('nothing to scan without footprints or land', () => {
        expect(prefetchApi.buildingDemolitionGeometry({ proposalId: 'p-0', goal: 'single', buildingProposal: {} })).toBeNull();
    });
});

describe('collecting the regions', () => {
    const site = square(15.869, 43.749, 0.002);
    const block = () => ({
        proposalId: 'p-1', goal: 'buildings', cadastreParcelIds: ['HR-A'], site,
        buildingProposal: { typologyType: 'block' },
        geometry: { buildings: [square(15.87, 43.75), { type: 'Feature', geometry: square(15.88, 43.76) }] }
    });

    it('a block member contributes its site plus its authored buildings, as Step 4 will', () => {
        const regions = prefetchApi.collectDemolitionRegions([block()]);
        expect(regions).toHaveLength(1);
        expect(regions[0].key).toBe('p-1');
        expect(regions[0].geometry.type).toBe('MultiPolygon');
        expect(regions[0].geometry.coordinates).toHaveLength(3);
        expect(regions[0].geometry.coordinates[0]).toEqual(site.coordinates);
    });

    it('a member that clears only its footprints contributes them', () => {
        const raise = block();
        raise.buildingProposal.parameters = { mode: 'existing' };
        const regions = prefetchApi.collectDemolitionRegions([raise]);
        expect(regions).toHaveLength(1);
        expect(regions[0].geometry.coordinates).toHaveLength(2);
        // It redraws existing buildings: its ground extends them and replaces none.
        expect(regions[0].extending).toBe(true);
        expect(prefetchApi.extendsExisting(raise)).toBe(true);
        expect(prefetchApi.extendsExisting(block())).toBe(false);
        expect(prefetchApi.collectDemolitionRegions([block()])[0]).not.toHaveProperty('extending');
    });

    it('a structure member asks the resolver, so the canonical fallback stays in one place', () => {
        const proposal = { proposalId: 'p-2', structureProposal: { kind: 'park' } };
        const canonical = square(15.87, 43.75);
        const regions = prefetchApi.collectDemolitionRegions([proposal], { structureGeometry: () => canonical });
        expect(regions).toHaveLength(1);
        expect(regions[0].geometry).toBe(canonical);
    });

    it('a road contributes NOTHING here — its land is its stored footprint', () => {
        const road = { proposalId: 'p-3', roadProposal: { definition: {} } };
        expect(prefetchApi.collectDemolitionRegions([road])).toEqual([]);
    });

    it('a member with no geometry is skipped rather than sent as an empty region', () => {
        expect(prefetchApi.collectDemolitionRegions([{ proposalId: 'p-4', goal: 'single', buildingProposal: {} }])).toEqual([]);
    });
});
