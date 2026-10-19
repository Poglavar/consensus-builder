// POST /walrus/upload — stores a proposal/parcel image + metadata JSON on Walrus (Sui) and
// returns the same response shape as /ipfs/upload, with walrus://<blobId> canonical URIs plus
// aggregator gateway URLs so the rest of the app stays storage-agnostic.

import { createJsonBodyValidator, validators } from '../utils/request-validation.js';
import { putBlob } from '../storage/walrus.js';
import { createUploadRateLimiter, decodeUploadImage, validateNftMetadata } from '../utils/nft-asset-upload.js';

const MAX_FILE_NAME_LENGTH = 255;

const walrusUploadBodyValidator = createJsonBodyValidator({
    schema: {
        imageData: {
            required: true,
            validate: validators.string({
                label: 'imageData',
                minLength: 1,
                minLengthMessage: 'imageData is required.'
            })
        },
        metadata: {
            required: true,
            missingMessage: 'metadata object is required.',
            validate: validators.plainObject({
                label: 'metadata',
                typeMessage: 'metadata object is required.'
            })
        },
        fileName: {
            required: false,
            validate: validators.optional(validators.string({
                label: 'fileName',
                maxLength: MAX_FILE_NAME_LENGTH,
                disallowControlChars: true
            }))
        }
    }
});

// Stores on OUR Walrus publisher budget; restricted to exactly what the mint flows send (a sniffed
// image + NFT metadata, size-capped, per-IP rate limited) — see utils/nft-asset-upload.js.
export function setupWalrusRoute(app) {
    const uploadRateLimiter = createUploadRateLimiter();
    app.post('/walrus/upload', uploadRateLimiter, walrusUploadBodyValidator, async (req, res) => {
        try {
            const { imageData, metadata } = req.validatedBody;

            const image = decodeUploadImage(imageData);
            if (image.error) {
                return res.status(400).json({ error: image.error });
            }
            const metadataError = validateNftMetadata(metadata);
            if (metadataError) {
                return res.status(400).json({ error: metadataError });
            }

            const imageUpload = await putBlob(image.buffer);

            // Point the metadata at the stored image (canonical walrus:// + browser gateway URL).
            const enrichedMetadata = { ...metadata };
            enrichedMetadata.image = imageUpload.walrusUri;
            enrichedMetadata.image_url = imageUpload.gatewayUrl;
            if (!enrichedMetadata.external_url) {
                enrichedMetadata.external_url = imageUpload.gatewayUrl;
            }

            const metadataBuffer = Buffer.from(JSON.stringify(enrichedMetadata), 'utf8');
            const metadataUpload = await putBlob(metadataBuffer);

            res.json({
                imageUri: imageUpload.walrusUri,
                imageGatewayUrl: imageUpload.gatewayUrl,
                metadataUri: metadataUpload.walrusUri,
                metadataGatewayUrl: metadataUpload.gatewayUrl,
                storage: 'walrus',
                suiObjectId: metadataUpload.suiObjectId,
                endEpoch: metadataUpload.endEpoch,
                cost: metadataUpload.cost
            });
        } catch (error) {
            console.error('Walrus upload failed:', error);
            res.status(500).json({ error: 'Failed to upload assets to Walrus.' });
        }
    });
}
