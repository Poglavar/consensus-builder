import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { createJsonBodyValidator, isPlainObject, validators } from '../utils/request-validation.js';

const UPLOAD_ROOT = path.resolve('uploads');
const IMAGE_DIR = path.join(UPLOAD_ROOT, 'images');
const METADATA_DIR = path.join(UPLOAD_ROOT, 'metadata');
const MAX_FILE_NAME_LENGTH = 255;

const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB
const ALLOWED_MIME_TYPES = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp'
};

function ensureDirectories() {
    [UPLOAD_ROOT, IMAGE_DIR, METADATA_DIR].forEach(dir => {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    });
}

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

function buildBaseUrl(req) {
    const protocol = req.protocol;
    const host = req.get('host');
    return `${protocol}://${host}`;
}

const imageUploadBodyValidator = createJsonBodyValidator({
    schema: {
        imageData: {
            required: true,
            missingMessage: 'imageData (base64 data URL) is required.',
            validate: validators.string({
                label: 'imageData',
                minLength: 1,
                minLengthMessage: 'imageData (base64 data URL) is required.',
                maxLength: 5_500_000,
                maxLengthMessage: 'imageData exceeds the maximum allowed size (~4MB).'
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

const metadataUploadBodyValidator = createJsonBodyValidator({
    schema: {
        metadata: {
            required: true,
            missingMessage: 'metadata object is required.',
            validate: validators.custom((value) => {
                let metadataObject = value;
                if (typeof value === 'string') {
                    try {
                        metadataObject = JSON.parse(value);
                    } catch {
                        return validators.fail('metadata must be valid JSON when sent as a string.');
                    }
                }
                if (!isPlainObject(metadataObject)) {
                    return validators.fail('metadata object is required.');
                }
                return validators.ok(metadataObject);
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

export function setupFileStorageRoutes(app) {
    ensureDirectories();

    app.post('/images', imageUploadBodyValidator, (req, res) => {
        try {
            const { imageData, fileName } = req.validatedBody;

            const matches = imageData.match(/^data:(.+);base64,(.+)$/);
            if (!matches || matches.length < 3) {
                return res.status(400).json({ error: 'imageData must be a base64-encoded data URL.' });
            }

            const contentType = matches[1] || 'application/octet-stream';
            const base64Payload = matches[2];
            const buffer = Buffer.from(base64Payload, 'base64');
            if (!buffer.length) {
                return res.status(400).json({ error: 'Decoded image data is empty.' });
            }

            if (buffer.length > MAX_IMAGE_SIZE) {
                return res.status(400).json({ error: 'Image size exceeds 5MB limit.' });
            }

            const extension = ALLOWED_MIME_TYPES[contentType];
            if (!extension) {
                return res.status(400).json({ error: 'Unsupported image type. Allowed: png, jpg, gif, webp' });
            }

            const fallbackName = sanitizeFileName(fileName, 'image');
            const finalFileName = `${fallbackName}.${extension}`;
            const safeFileName = path.basename(finalFileName);
            const finalPath = path.join(IMAGE_DIR, safeFileName);

            fs.writeFileSync(finalPath, buffer);

            const baseUrl = buildBaseUrl(req);
            const imageUrl = `${baseUrl}/images/${safeFileName}`;

            res.json({
                fileName: safeFileName,
                imageUrl,
                contentType
            });
        } catch (error) {
            console.error('Image upload failed:', error);
            res.status(500).json({ error: 'Failed to store image.' });
        }
    });

    app.post('/metadata', metadataUploadBodyValidator, (req, res) => {
        try {
            const { metadata: metadataObject, fileName } = req.validatedBody;
            const safeName = sanitizeFileName(fileName, 'metadata');
            const finalFileName = safeName.endsWith('.json') ? safeName : `${safeName}.json`;
            const safeFileName = path.basename(finalFileName);
            const finalPath = path.join(METADATA_DIR, safeFileName);

            fs.writeFileSync(
                finalPath,
                JSON.stringify(metadataObject, null, 2),
                'utf8'
            );

            const baseUrl = buildBaseUrl(req);
            const metadataUrl = `${baseUrl}/metadata/${safeFileName}`;

            res.json({
                fileName: safeFileName,
                metadataUrl
            });
        } catch (error) {
            console.error('Metadata upload failed:', error);
            res.status(500).json({ error: 'Failed to store metadata.' });
        }
    });
}
