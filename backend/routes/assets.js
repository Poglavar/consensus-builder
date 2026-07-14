import fs from 'fs';
import path from 'path';
import { createJsonBodyValidator, isPlainObject, validators } from '../utils/request-validation.js';
import {
    saveImageBuffer,
    sanitizeFileName,
    decodeImageDataUrl,
    ensureImageDirectories,
    METADATA_DIR
} from '../utils/image-store.js';

const STATIC_PROPOSAL_IMAGE_URL = 'https://urbangametheory.xyz/images/consensus-builder-logo.png';
const MAX_FILE_NAME_LENGTH = 255;

function resolveBaseUrl(req) {
    const protocol = req.protocol;
    const host = req.get('host');
    return `${protocol}://${host}`;
}

const assetsUploadBodyValidator = createJsonBodyValidator({
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

export function setupAssetsRoute(app) {
    ensureImageDirectories();

    app.post('/assets/upload', assetsUploadBodyValidator, async (req, res) => {
        try {
            const { imageData, metadata, fileName } = req.validatedBody;

            // Same decode + write helpers the server-side thumbnail renderer uses, so images land in
            // one place with one URL scheme no matter who produced them.
            const decoded = decodeImageDataUrl(imageData);
            if (!decoded) {
                return res.status(400).json({ error: 'imageData must be a base64 data URL.' });
            }
            if (!decoded.buffer.length) {
                return res.status(400).json({ error: 'Decoded image data is empty.' });
            }

            const safeBase = sanitizeFileName(fileName, 'road-proposal');
            const metadataFilename = `${safeBase}.json`;
            const { imagePath } = saveImageBuffer(decoded.buffer, safeBase, decoded.extension);

            const baseUrl = resolveBaseUrl(req);
            const uploadedImageUrl = `${baseUrl}${imagePath}`;
            const imageUrl = uploadedImageUrl || STATIC_PROPOSAL_IMAGE_URL;
            const existingProperties = isPlainObject(metadata.properties)
                ? metadata.properties
                : {};
            const metadataToSave = {
                ...metadata,
                image: imageUrl,
                image_url: imageUrl,
                external_url: metadata?.external_url || imageUrl,
                properties: {
                    ...existingProperties,
                    uploadedImageUrl
                }
            };
            fs.writeFileSync(path.join(METADATA_DIR, metadataFilename), JSON.stringify(metadataToSave, null, 2), 'utf8');

            const metadataUrl = `${baseUrl}/uploads/metadata/${metadataFilename}`;

            res.json({
                imageUri: imageUrl,
                imageUrl,
                imageGatewayUrl: imageUrl,
                uploadedImageUrl,
                metadataUri: metadataUrl,
                metadataUrl,
                metadataGatewayUrl: metadataUrl
            });
        } catch (error) {
            console.error('Assets upload failed:', error);
            res.status(500).json({ error: 'Failed to store uploaded assets.' });
        }
    });
}



