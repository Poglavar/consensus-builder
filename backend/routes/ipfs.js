import { createJsonBodyValidator, validators } from '../utils/request-validation.js';
import { createUploadRateLimiter, decodeUploadImage, validateNftMetadata } from '../utils/nft-asset-upload.js';
import { pinFile, ipfsGatewayUrl } from '../storage/pinning.js';
import { canonicalBytes } from '../cid.js';

const MAX_FILE_NAME_LENGTH = 255;

async function uploadFile(input) {
    const { cid } = await pinFile(input);
    return { ipfsUri: `ipfs://${cid}`, gatewayUrl: ipfsGatewayUrl(cid), ipfsHash: cid };
}

export function uploadImage({ buffer, fileName, contentType }) {
    return uploadFile({ bytes: buffer, fileName, contentType: contentType || 'application/octet-stream' });
}

export function uploadMetadata(metadata, pinName) {
    const name = `${pinName || metadata?.name || 'proposal-nft'}-metadata.json`;
    return uploadFile({ bytes: canonicalBytes(metadata), fileName: name, contentType: 'application/json', name });
}

const ipfsUploadBodyValidator = createJsonBodyValidator({
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

// This route pins on OUR configured storage account and used to be an open relay (origin check only, 15 MB of
// anything). It now takes exactly what the mint flows send — see utils/nft-asset-upload.js.
export function setupIpfsRoute(app) {
    const uploadRateLimiter = createUploadRateLimiter();
    app.post('/ipfs/upload', uploadRateLimiter, ipfsUploadBodyValidator, async (req, res) => {
        try {
            const { imageData, metadata, fileName } = req.validatedBody;

            const image = decodeUploadImage(imageData);
            if (image.error) {
                return res.status(400).json({ error: image.error });
            }
            const metadataError = validateNftMetadata(metadata);
            if (metadataError) {
                return res.status(400).json({ error: metadataError });
            }

            // The extension follows the sniffed bytes, never the client's name or declared mime.
            const baseName = ((fileName && String(fileName).trim()) || `road-proposal-${Date.now()}`)
                .replace(/\.[A-Za-z0-9]{1,5}$/, '');
            const safeFileName = `${baseName}.${image.extension}`;

            const imageUpload = await uploadImage({
                buffer: image.buffer,
                fileName: safeFileName,
                contentType: image.contentType
            });

            const enrichedMetadata = { ...metadata };
            enrichedMetadata.image = imageUpload.ipfsUri;
            enrichedMetadata.image_url = imageUpload.gatewayUrl;
            if (!enrichedMetadata.external_url) {
                enrichedMetadata.external_url = imageUpload.gatewayUrl;
            }

            const metadataUpload = await uploadMetadata(enrichedMetadata, metadata?.name || safeFileName);

            res.json({
                imageUri: imageUpload.ipfsUri,
                imageGatewayUrl: imageUpload.gatewayUrl,
                metadataUri: metadataUpload.ipfsUri,
                metadataGatewayUrl: metadataUpload.gatewayUrl
            });
        } catch (error) {
            console.error('IPFS upload failed:', error);
            res.status(500).json({ error: 'Failed to upload assets to IPFS.' });
        }
    });
}

