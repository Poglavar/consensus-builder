import fs from 'fs';
import path from 'path';
import { createJsonBodyValidator, isPlainObject, validators } from '../utils/request-validation.js';
import {
    saveImageBuffer,
    decodeImageDataUrl,
    ensureImageDirectories,
    METADATA_DIR
} from '../utils/image-store.js';
import { publicFileUrl } from '../utils/public-base-url.js';

const MAX_FILE_NAME_LENGTH = 255;

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
            if (!decoded.contentType) {
                return res.status(400).json({ error: 'imageData must be a PNG, JPEG or WEBP image.' });
            }

            // saveImageBuffer picks the extension from the sniffed bytes and appends a random id; the
            // metadata file reuses that exact base, so neither can be named (and overwritten) by a client.
            const { fileName: imageFileName, imagePath } = saveImageBuffer(decoded.buffer, fileName || 'road-proposal');
            const metadataFilename = `${imageFileName.replace(/\.[a-z]+$/, '')}.json`;

            // Pinned public base (or the bare path) — never the request's Host header, which the
            // client controls and which would otherwise be baked into metadata that minted tokens point to.
            const uploadedImageUrl = publicFileUrl(imagePath);
            const imageUrl = uploadedImageUrl;
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
            fs.writeFileSync(
                path.join(METADATA_DIR, metadataFilename),
                JSON.stringify(metadataToSave, null, 2),
                { encoding: 'utf8', flag: 'wx' }
            );

            const metadataUrl = publicFileUrl(`/uploads/metadata/${metadataFilename}`);

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



