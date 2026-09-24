const PINATA_FILE_ENDPOINT = 'https://api.pinata.cloud/pinning/pinFileToIPFS';
const PINATA_JSON_ENDPOINT = 'https://api.pinata.cloud/pinning/pinJSONToIPFS';

import { createJsonBodyValidator, validators } from '../utils/request-validation.js';
import { createUploadRateLimiter, decodeUploadImage, validateNftMetadata } from '../utils/nft-asset-upload.js';

const MAX_FILE_NAME_LENGTH = 255;

function ensurePinataCredentials() {
    const apiKey = process.env.PINATA_API_KEY;
    const apiSecret = process.env.PINATA_API_SECRET;
    if (!apiKey || !apiSecret) {
        throw new Error('Pinata API credentials are not configured. Set PINATA_API_KEY and PINATA_API_SECRET.');
    }
    return { apiKey, apiSecret };
}

async function uploadImageToPinata({ buffer, fileName, contentType }) {
    const { apiKey, apiSecret } = ensurePinataCredentials();
    const blob = new Blob([buffer], { type: contentType || 'application/octet-stream' });
    const formData = new FormData();
    formData.append('file', blob, fileName);

    const response = await fetch(PINATA_FILE_ENDPOINT, {
        method: 'POST',
        headers: {
            'pinata_api_key': apiKey,
            'pinata_secret_api_key': apiSecret
        },
        body: formData
    });

    if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Failed to upload image to Pinata: ${response.status} ${errorBody}`);
    }

    const result = await response.json();
    const ipfsHash = result?.IpfsHash;
    if (!ipfsHash) {
        throw new Error('Pinata response did not include IpfsHash for the image upload.');
    }

    return {
        ipfsUri: `ipfs://${ipfsHash}`,
        gatewayUrl: `https://gateway.pinata.cloud/ipfs/${ipfsHash}`,
        ipfsHash
    };
}

async function uploadMetadataToPinata(metadata, pinName) {
    const { apiKey, apiSecret } = ensurePinataCredentials();

    const body = {
        pinataContent: metadata,
        pinataMetadata: {
            name: `${pinName || metadata?.name || 'proposal-nft'}-metadata.json`
        }
    };

    const response = await fetch(PINATA_JSON_ENDPOINT, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'pinata_api_key': apiKey,
            'pinata_secret_api_key': apiSecret
        },
        body: JSON.stringify(body)
    });

    if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Failed to upload metadata to Pinata: ${response.status} ${errorBody}`);
    }

    const result = await response.json();
    const ipfsHash = result?.IpfsHash;
    if (!ipfsHash) {
        throw new Error('Pinata response did not include IpfsHash for metadata upload.');
    }

    return {
        ipfsUri: `ipfs://${ipfsHash}`,
        gatewayUrl: `https://gateway.pinata.cloud/ipfs/${ipfsHash}`,
        ipfsHash
    };
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

// This route pins on OUR Pinata account and used to be an open relay (origin check only, 15 MB of
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

            const imageUpload = await uploadImageToPinata({
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

            const metadataUpload = await uploadMetadataToPinata(enrichedMetadata, metadata?.name || safeFileName);

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

