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

// A proposal clears the ground it takes (2026-10-22): a block or rule its parcels, a Freeform
// building its footprint, a rule that raises the existing buildings only what it redraws.
describe('the ground a building proposal clears', () => {
    const parcelA = { type: 'Feature', properties: { parcelId: 'HR-A' }, geometry: square(15.869, 43.749, 0.002) };
    const parcelB = { type: 'Feature', properties: { parcelId: 'HR-B' }, geometry: square(15.879, 43.759, 0.002) };
    const block = () => ({
        proposalId: 'p-1', goal: 'buildings', cadastreParcelIds: ['HR-A', 'HR-B'],
        buildingProposal: { typologyType: 'block' },
        geometry: { buildings: [square(15.87, 43.75), { type: 'Feature', geometry: square(15.88, 43.76) }] }
    });

    it('a block takes its parcels: the region is the parcels plus the authored buildings', () => {
        expect(prefetchApi.buildingClearsParcels(block())).toBe(true);
        const geometry = prefetchApi.buildingDemolitionGeometry(block(), [parcelA, parcelB]);
        expect(geometry.type).toBe('MultiPolygon');
        expect(geometry.coordinates).toEqual([parcelA.geometry.coordinates, parcelB.geometry.coordinates, square(15.87, 43.75).coordinates, square(15.88, 43.76).coordinates]);
    });

    it('a rule that raises the existing buildings clears only what it redraws', () => {
        const raise = block();
        raise.buildingProposal.parameters = { mode: 'existing', rule: 'additional' };
        expect(prefetchApi.buildingClearsParcels(raise)).toBe(false);
        expect(prefetchApi.buildingDemolitionGeometry(raise, [parcelA, parcelB]).coordinates).toHaveLength(2);
    });

    it('a Freeform building forms its own parcel: its footprint, unless it takes the whole parcels', () => {
        const single = { ...block(), goal: 'single', geometry: { buildings: [square(15.87, 43.75)] } };
        expect(prefetchApi.buildingClearsParcels(single)).toBe(false);
        expect(prefetchApi.buildingDemolitionGeometry(single, [parcelA])).toEqual(square(15.87, 43.75));
        // Any 'building…' goal is the single key, as proposals/core.js normalizes it.
        expect(prefetchApi.buildingClearsParcels({ ...single, goal: 'Building' })).toBe(false);
        const whole = { ...single, geometry: { ...single.geometry, landTake: parcelA } };
        expect(prefetchApi.buildingClearsParcels(whole)).toBe(false);
        expect(prefetchApi.buildingDemolitionGeometry(whole, [parcelA])).toEqual(parcelA.geometry || parcelA);
    });

    it('nothing to scan without footprints or parcels', () => {
        expect(prefetchApi.buildingDemolitionGeometry({ proposalId: 'p-0', buildingProposal: {} }, [])).toBeNull();
    });
});

describe('collecting the regions', () => {
    const parcel = { type: 'Feature', properties: { parcelId: 'HR-A' }, geometry: square(15.869, 43.749, 0.02) };
    const block = () => ({
        proposalId: 'p-1', goal: 'buildings', cadastreParcelIds: ['HR-A'],
        buildingProposal: { typologyType: 'block' },
        geometry: { buildings: [square(15.87, 43.75), { type: 'Feature', geometry: square(15.88, 43.76) }] }
    });

    it('a block member contributes its parcels plus its authored buildings, as Step 4 will', () => {
        const asked = [];
        const regions = prefetchApi.collectDemolitionRegions([block()], { parcelFeatures: proposal => { asked.push(proposal.proposalId); return [parcel]; } });
        expect(asked).toEqual(['p-1']);
        expect(regions).toHaveLength(1);
        expect(regions[0].key).toBe('p-1');
        expect(regions[0].geometry.type).toBe('MultiPolygon');
        expect(regions[0].geometry.coordinates).toHaveLength(3);
        expect(regions[0].geometry.coordinates[0]).toEqual(parcel.geometry.coordinates);
    });

    it('a block member whose parcels cannot be resolved is LEFT OUT, never sent as its footprints alone', () => {
        // A prefetched region smaller than the scan's would answer without the courtyard buildings.
        expect(prefetchApi.collectDemolitionRegions([block()])).toEqual([]);
        expect(prefetchApi.collectDemolitionRegions([block()], { parcelFeatures: () => [] })).toEqual([]);
    });

    it('a member that clears only its footprints needs no parcels', () => {
        const raise = block();
        raise.buildingProposal.parameters = { mode: 'existing' };
        const regions = prefetchApi.collectDemolitionRegions([raise]);
        expect(regions).toHaveLength(1);
        expect(regions[0].geometry.coordinates).toHaveLength(2);
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
        expect(prefetchApi.collectDemolitionRegions([{ proposalId: 'p-4', buildingProposal: {} }])).toEqual([]);
    });
});
