// The parcel anchor's id and metadata (frontend/js/parcels/parcel-anchor.js), shared by the parcel
// panel's Mint and the MCP's ugt_anchor_parcels, and by the page's deriveParcelIdentifier (parcels/blockchain.js).
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ParcelAnchor = require('../../frontend/js/parcels/parcel-anchor.js');
require('../../frontend/js/parcels/blockchain.js');

describe('parcel anchor', () => {
    it('seeds the anchor with the Croatian cadastre id, else the feature parcelId, as the panel always has', () => {
        expect(ParcelAnchor.anchorIdOf({ properties: { MATICNI_BROJ_KO: 335754, BROJ_CESTICE: '1234/2', parcelId: 'x' } })).toBe('HR-335754-1234/2');
        expect(ParcelAnchor.anchorIdOf({ properties: { parcelId: ' gb-42 ' } })).toBe('gb-42');
        expect(ParcelAnchor.anchorIdOf({ properties: { cadastralMunicipality: { id: '1' }, parcel_number: '7' } })).toBe('HR-1-7');
        expect(ParcelAnchor.anchorIdOf({ properties: {} })).toBeNull();
        // The page's deriveParcelIdentifier is the same function.
        expect(globalThis.deriveParcelIdentifier({ properties: { maticni_broj_ko: '9', broj_cestice: '3' } })).toBe('HR-9-3');
    });

    it('describes the anchor with its minter, rounded area and geometry', () => {
        const geometry = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] };
        expect(ParcelAnchor.anchorMetadata({ anchorId: 'HR-1-7', minter: 'Agent111', calculatedArea: 123.456, geometry })).toEqual({
            name: 'Parcel HR-1-7', description: 'Digitized cadastral parcel HR-1-7. Minted by Agent111.', image: '',
            attributes: [{ trait_type: 'Parcel ID', value: 'HR-1-7' }, { trait_type: 'Minted By', value: 'Agent111' },
                { trait_type: 'Area (m²)', value: 123.46, display_type: 'number' }],
            parcelId: 'HR-1-7', areaSquareMeters: 123.46, geometry
        });
        expect(ParcelAnchor.anchorMetadata({ anchorId: 'p', parcelName: 'Named', minter: 'm' })).toMatchObject({ name: 'Named', areaSquareMeters: null, geometry: null, attributes: [{}, {}] });
    });
});
