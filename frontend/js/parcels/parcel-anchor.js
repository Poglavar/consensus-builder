// A parcel's anchor on the parcel_nft program, as the parcel panel's "Mint anchor", the agreement
// mint and an agent's ugt_anchor_parcels make it: the id the anchor PDA ["parcel", sha256(id)] is seeded with
// and its URI, the parcel's page on the public site (nothing is pinned). Pure, UMD: window.ParcelAnchor
// in the browser (parcels/blockchain.js, parcels/ui/claim.js, solana/parcel-mint.js), module.exports
// for node (backend/agents/ugt-agent-tools.js).
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ParcelAnchor = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    const text = value => (value === undefined || value === null ? '' : String(value).trim());
    const hrId = (municipality, number) => (text(municipality) && text(number) ? `HR-${text(municipality)}-${text(number)}` : null);

    // The id a parcel anchor is minted under: HR-<cadastral municipality>-<parcel number> from the
    // Croatian cadastre's own fields, else the feature's parcelId, else the same HR form from the wider
    // field names other sources use (parcel_number, cadastralMunicipality.id).
    function anchorIdOf(feature) {
        if (!feature || typeof feature !== 'object') return null;
        const props = feature.properties || {};
        const parcelId = text(props.parcelId);
        if (feature.properties) {
            const canonical = hrId(props.MATICNI_BROJ_KO ?? props.maticni_broj_ko, props.BROJ_CESTICE ?? props.broj_cestice);
            if (canonical) return canonical;
            if (parcelId) return parcelId;
        }
        return hrId(
            props.MATICNI_BROJ_KO ?? props.maticni_broj_ko ?? (props.cadastralMunicipality && props.cadastralMunicipality.id),
            props.BROJ_CESTICE ?? props.broj_cestice ?? props.parcel_number ?? props.parcelNumber
        ) || parcelId || null;
    }

    // The public site an anchor's URI names. Pinned, never the page's own origin: an anchor is written
    // once and kept forever, so a localhost or preview origin must never reach the chain. The server
    // passes its PUBLIC_BASE_URL instead (backend/agents/ugt-agent-tools.js).
    const PUBLIC_SITE_URL = 'https://urbangametheory.xyz';
    // parcel_nft's Parcel account reserves 4 + 256 bytes each for parcel_id and metadata_uri; the PDA
    // is seeded by the id's sha256, so any id that fits the account has an anchor
    // (blockchain/solana/programs/parcel_nft/src/lib.rs).
    const MAX_URI_BYTES = 256;
    const MAX_ID_BYTES = 256;
    const byteLength = value => new TextEncoder().encode(String(value)).length;

    // The anchor's URI: the parcel's page, /parcel/<anchorId> (parcels/route.js opens it, switching to
    // the parcel's city). Each path segment is encoded; the slash of a Croatian number (1234/2) stays.
    function anchorUri(anchorId, { base = PUBLIC_SITE_URL } = {}) {
        const id = text(anchorId);
        if (!id) return null;
        const origin = text(base).replace(/\/+$/, '') || PUBLIC_SITE_URL;
        return `${origin}/parcel/${id.split('/').map(encodeURIComponent).join('/')}`;
    }

    // Parcel ids → what an anchor batch takes: [{ anchorId, metadataUri }], first occurrence kept, and
    // the ids that cannot be anchored with the reason (an id or a URI over 256 bytes does not fit the
    // account). A skipped id is reported, never fatal.
    function anchorTargets(parcelIds, { base = PUBLIC_SITE_URL } = {}) {
        const parcels = [];
        const skipped = [];
        const seen = new Set();
        for (const raw of parcelIds || []) {
            const anchorId = text(raw);
            if (!anchorId || seen.has(anchorId)) continue;
            seen.add(anchorId);
            const metadataUri = anchorUri(anchorId, { base });
            if (byteLength(anchorId) > MAX_ID_BYTES) skipped.push({ parcelId: anchorId, reason: 'id-too-long' });
            else if (byteLength(metadataUri) > MAX_URI_BYTES) skipped.push({ parcelId: anchorId, reason: 'uri-too-long' });
            else parcels.push({ anchorId, metadataUri });
        }
        return { parcels, skipped };
    }

    return { PUBLIC_SITE_URL, MAX_URI_BYTES, MAX_ID_BYTES, anchorIdOf, anchorUri, anchorTargets };
});
