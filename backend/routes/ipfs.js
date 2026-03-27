const PINATA_FILE_ENDPOINT = 'https://api.pinata.cloud/pinning/pinFileToIPFS';
const PINATA_JSON_ENDPOINT = 'https://api.pinata.cloud/pinning/pinJSONToIPFS';

import { createJsonBodyValidator, isPlainObject, validators } from '../utils/request-validation.js';

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

export function setupIpfsRoute(app) {
    app.post('/ipfs/upload', ipfsUploadBodyValidator, async (req, res) => {
        try {
            const { imageData, metadata, fileName } = req.validatedBody;

            const matches = imageData.match(/^data:(.+);base64,(.+)$/);
            if (!matches || matches.length < 3) {
                return res.status(400).json({ error: 'imageData must be a base64 data URL.' });
            }

            const contentType = matches[1];
            const base64Payload = matches[2];
            const imageBuffer = Buffer.from(base64Payload, 'base64');
            if (!imageBuffer.length) {
                return res.status(400).json({ error: 'Decoded image data is empty.' });
            }

            const safeFileName = (fileName && String(fileName).trim()) || `road-proposal-${Date.now()}.png`;

            const imageUpload = await uploadImageToPinata({
                buffer: imageBuffer,
                fileName: safeFileName,
                contentType
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

