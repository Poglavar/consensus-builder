// IPFS upload for the parcel NFT mint (parcels/ui/claim.js): the parcel image and its NFT metadata go
// to the backend's POST /ipfs/upload (backend/routes/ipfs.js), which pins both on Pinata and answers
// their ipfs:// URIs and gateway URLs. window.AssetService is the browser API.
(function (root) {
    'use strict';
    if (!root) return;

    /**
     * Pins an image (a data: URL) and the NFT metadata that names it.
     * @returns {Promise<{ imageUri: string, imageGatewayUrl: string, metadataUri: string, metadataGatewayUrl: string }>}
     * Throws with the server's reason when the upload is refused or fails.
     */
    async function uploadProposalAssets({ imageData, metadata, fileName }) {
        if (typeof imageData !== 'string' || !imageData) throw new Error('imageData is required for an IPFS upload.');
        if (!metadata || typeof metadata !== 'object') throw new Error('A metadata object is required for an IPFS upload.');
        const base = String(root.getBackendBase()).replace(/\/+$/, '');
        const response = await root.fetch(`${base}/ipfs/upload`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ imageData, metadata, fileName })
        });
        let body = null;
        try { body = await response.json(); } catch (_) { body = null; }
        if (!response.ok) throw new Error((body && body.error) || `The IPFS upload failed (HTTP ${response.status}).`);
        return body;
    }

    root.AssetService = Object.freeze({ uploadProposalAssets });
})(typeof window !== 'undefined' ? window : null);
