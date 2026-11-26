// The parcel anchor's id and URI (frontend/js/parcels/parcel-anchor.js), shared by the parcel panel's
// "Anchor on chain", the agreement mint and the MCP's ugt_anchor_parcels, and by the page's
// deriveParcelIdentifier (parcels/blockchain.js).
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

    it('points the anchor at the parcel page on the public site, never pinned metadata', () => {
        expect(ParcelAnchor.anchorUri('HR-335754-1234/2')).toBe('https://urbangametheory.xyz/parcel/HR-335754-1234/2');
        expect(ParcelAnchor.anchorUri('a b#c', { base: 'https://app.test/' })).toBe('https://app.test/parcel/a%20b%23c');
        expect(ParcelAnchor.anchorUri(' ')).toBeNull();
        expect(ParcelAnchor.anchorMetadata).toBeUndefined();
    });

    it('turns parcel ids into anchor targets, once each, and reports ids that cannot be anchored', () => {
        const long = 'X'.repeat(33);
        const longUri = 'p'.repeat(32);
        expect(ParcelAnchor.anchorTargets(['HR-1-7', ' HR-1-7 ', long, '', 'gb-42'])).toEqual({
            parcels: [{ anchorId: 'HR-1-7', metadataUri: 'https://urbangametheory.xyz/parcel/HR-1-7' },
                { anchorId: 'gb-42', metadataUri: 'https://urbangametheory.xyz/parcel/gb-42' }],
            skipped: [{ parcelId: long, reason: 'id-too-long' }]
        });
        expect(ParcelAnchor.anchorTargets([longUri], { base: `https://${'h'.repeat(240)}.test` }).skipped)
            .toEqual([{ parcelId: longUri, reason: 'uri-too-long' }]);
        // The longest id that seeds a PDA still fits the program's 256-byte URI on the public site.
        const uri = ParcelAnchor.anchorUri('Ž'.repeat(16));
        expect(new TextEncoder().encode(uri).length).toBeLessThanOrEqual(ParcelAnchor.MAX_URI_BYTES);
    });

});
