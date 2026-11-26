// A parcel's anchor on the parcel_nft program, as the parcel panel's Mint and an agent's
// ugt_anchor_parcels make it: the id the anchor PDA ["parcel", id] is seeded with and the metadata its
// URI points to. Pure, UMD: window.ParcelAnchor in the browser (parcels/blockchain.js,
// parcels/ui/claim.js), module.exports for node (backend/agents/chain-actions.js).
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

    // The anchor's metadata JSON: its name, who minted it, the parcel's area (m², two decimals, when
    // known) and geometry. `image` stays empty unless a rendered picture was uploaded with it.
    function anchorMetadata({ anchorId, parcelName = null, minter, calculatedArea = null, geometry = null }) {
        const areaSquareMeters = Number.isFinite(calculatedArea) && calculatedArea > 0 ? Math.round(calculatedArea * 100) / 100 : null;
        const attributes = [
            { trait_type: 'Parcel ID', value: anchorId },
            { trait_type: 'Minted By', value: minter }
        ];
        if (areaSquareMeters !== null) attributes.push({ trait_type: 'Area (m²)', value: areaSquareMeters, display_type: 'number' });
        return {
            name: parcelName || `Parcel ${anchorId}`,
            description: `Digitized cadastral parcel ${anchorId}. Minted by ${minter}.`,
            image: '',
            attributes,
            parcelId: anchorId,
            areaSquareMeters,
            geometry: geometry || null
        };
    }

    return { anchorIdOf, anchorMetadata };
});
