// POST /walrus/upload — stores a proposal/parcel image + metadata JSON on Walrus (Sui) and
// returns the same response shape as /ipfs/upload, with walrus://<blobId> canonical URIs plus
// aggregator gateway URLs so the rest of the app stays storage-agnostic.

import { createJsonBodyValidator, validators } from '../utils/request-validation.js';
import { putBlob } from '../storage/walrus.js';

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

export function setupWalrusRoute(app) {
    app.post('/walrus/upload', walrusUploadBodyValidator, async (req, res) => {
        try {
            const { imageData, metadata } = req.validatedBody;

            const matches = imageData.match(/^data:(.+);base64,(.+)$/);
            if (!matches || matches.length < 3) {
                return res.status(400).json({ error: 'imageData must be a base64 data URL.' });
            }

            const base64Payload = matches[2];
            const imageBuffer = Buffer.from(base64Payload, 'base64');
            if (!imageBuffer.length) {
                return res.status(400).json({ error: 'Decoded image data is empty.' });
            }

            const imageUpload = await putBlob(imageBuffer);

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
