import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { createJsonBodyValidator, isPlainObject, validators } from '../utils/request-validation.js';

const UPLOAD_ROOT = path.resolve('uploads');
const IMAGE_DIR = path.join(UPLOAD_ROOT, 'images');
const METADATA_DIR = path.join(UPLOAD_ROOT, 'metadata');
const STATIC_PROPOSAL_IMAGE_URL = 'https://urbangametheory.xyz/images/consensus-builder-logo.png';
const MAX_FILE_NAME_LENGTH = 255;

function sanitizeFileName(raw, fallbackPrefix) {
    const base = (raw || '').toString().trim();
    const safe = base
        .toLowerCase()
        .replace(/[^a-z0-9-_]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
    if (safe) return safe;
    return `${fallbackPrefix}-${Date.now()}-${randomUUID()}`;
}

function ensureUploadDirectories() {
    [UPLOAD_ROOT, IMAGE_DIR, METADATA_DIR].forEach(dir => {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    });
}

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
    ensureUploadDirectories();

    app.post('/assets/upload', assetsUploadBodyValidator, async (req, res) => {
        try {
            const { imageData, metadata, fileName } = req.validatedBody;

            const matches = imageData.match(/^data:(.+);base64,(.+)$/);
            if (!matches || matches.length < 3) {
                return res.status(400).json({ error: 'imageData must be a base64 data URL.' });
            }

            const contentType = matches[1];
            const base64Payload = matches[2];
            const buffer = Buffer.from(base64Payload, 'base64');
            if (!buffer.length) {
                return res.status(400).json({ error: 'Decoded image data is empty.' });
            }

            const extension = (() => {
                const typeParts = contentType.split('/');
                if (typeParts.length === 2 && typeParts[1]) {
                    const ext = typeParts[1].split('+')[0];
                    if (ext) return ext.toLowerCase();
                }
                return 'png';
            })();

            const safeBase = sanitizeFileName(fileName, 'road-proposal');
            const imageFilename = `${safeBase}.${extension}`;
            const metadataFilename = `${safeBase}.json`;

            ensureUploadDirectories();
            fs.writeFileSync(path.join(IMAGE_DIR, imageFilename), buffer);

            const baseUrl = resolveBaseUrl(req);
            const uploadedImageUrl = `${baseUrl}/uploads/images/${imageFilename}`;
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



