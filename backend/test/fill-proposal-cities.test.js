// Filling in a known city for proposals that have none (scripts/fill-proposal-cities.mjs): placed by
// their own site, footprint or Croatian parcels, by the rule new publications follow; never guessed.
import { describe, it, expect, vi } from 'vitest';
import { hasKnownCity, placeByGeometry } from '../scripts/fill-proposal-cities.mjs';

const square = (lat, lon, d = 0.0003) => ({ type: 'Polygon', coordinates: [[[lon - d, lat - d], [lon + d, lat - d], [lon + d, lat + d], [lon - d, lat + d], [lon - d, lat - d]]] });
const noLocation = vi.fn(async () => null);

describe('which proposals need a city', () => {
    it('is every one without a configured city', () => {
        expect(hasKnownCity('zagreb')).toBe(true);
        expect(hasKnownCity('explore')).toBe(true);
        for (const city of [null, undefined, '', 'city', 'zg', 'atlantis']) expect(hasKnownCity(city)).toBe(false);
    });
});

describe('placing a proposal by its own geometry', () => {
    it('by its site, else its footprint', async () => {
        expect(await placeByGeometry({ site_geojson: JSON.stringify(square(45.8155, 15.9819)), proposal_data: {} }, noLocation)).toMatchObject({ city: 'zagreb', from: 'site' });
        const park = { goal: 'park', structureProposal: { kind: 'park', geometry: square(43.5081, 16.4402) } };
        expect(await placeByGeometry({ site_geojson: null, proposal_data: park }, noLocation)).toMatchObject({ city: 'split', from: 'footprint' });
    });

    it('outside every city\'s cadastre: explore', async () => {
        expect(await placeByGeometry({ site_geojson: JSON.stringify(square(48.0, 70.0)), proposal_data: {} }, noLocation)).toMatchObject({ city: 'explore' });
    });

    it('a parcel act by where its Croatian parcels are, and never by a guess', async () => {
        const act = { goal: 'ownership-transfer', cadastreParcelIds: ['HR-335649-1021/3'] };
        const located = vi.fn(async () => [15.9775, 45.8131]);
        expect(await placeByGeometry({ site_geojson: null, proposal_data: act }, located)).toMatchObject({ city: 'zagreb', from: 'parcels' });
        expect(located).toHaveBeenCalledWith(['HR-335649-1021/3']);
        expect(await placeByGeometry({ site_geojson: null, proposal_data: act }, noLocation)).toMatchObject({ why: expect.stringMatching(/cannot be located/) });
        expect(await placeByGeometry({ site_geojson: null, proposal_data: { goal: 'vote' } }, noLocation)).toMatchObject({ why: 'no geometry and no parcels' });
    });
});
