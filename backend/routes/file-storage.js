import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { createJsonBodyValidator, isPlainObject, validators } from '../utils/request-validation.js';

const UPLOAD_ROOT = path.resolve('uploads');
const IMAGE_DIR = path.join(UPLOAD_ROOT, 'images');
const METADATA_DIR = path.join(UPLOAD_ROOT, 'metadata');
const MODEL_DIR = path.join(UPLOAD_ROOT, 'models');
const MAX_FILE_NAME_LENGTH = 255;
const MAX_MODEL_DATA_LENGTH = 14_000_000; // base64 data URL; ~10 MB binary, under the 15mb JSON body cap

function ensureDirectories() {
    [UPLOAD_ROOT, IMAGE_DIR, METADATA_DIR, MODEL_DIR].forEach(dir => {
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

const modelUploadBodyValidator = createJsonBodyValidator({
    schema: {
        modelData: {
            required: true,
            missingMessage: 'modelData (base64 data URL) is required.',
            validate: validators.string({
                label: 'modelData',
                minLength: 1,
                minLengthMessage: 'modelData (base64 data URL) is required.',
                maxLength: MAX_MODEL_DATA_LENGTH,
                maxLengthMessage: 'modelData exceeds the maximum allowed size (~10MB).'
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

    // Stores an uploaded 3D building model (glTF 2.0 .glb/.gltf) and returns its served URL.
    app.post('/models', modelUploadBodyValidator, (req, res) => {
        try {
            const { modelData, fileName } = req.validatedBody;

            const matches = modelData.match(/^data:(.*?);base64,(.+)$/);
            if (!matches || matches.length < 3) {
                return res.status(400).json({ error: 'modelData must be a base64-encoded data URL.' });
            }

            const contentType = matches[1] || 'model/gltf-binary';
            const buffer = Buffer.from(matches[2], 'base64');
            if (!buffer.length) {
                return res.status(400).json({ error: 'Decoded model data is empty.' });
            }

            // Only glb/gltf are supported; .gltf must be self-contained (embedded buffers).
            const requestedExt = (fileName || '').toLowerCase().endsWith('.gltf') ? 'gltf' : 'glb';
            const safeName = sanitizeFileName(fileName, 'model');
            const finalFileName = `${safeName}-${randomUUID().slice(0, 8)}.${requestedExt}`;
            fs.writeFileSync(path.join(MODEL_DIR, finalFileName), buffer);

            const baseUrl = buildBaseUrl(req);
            const modelUrl = `${baseUrl}/uploads/models/${finalFileName}`;

            res.json({ fileName: finalFileName, modelUrl, contentType });
        } catch (error) {
            console.error('Model upload failed:', error);
            res.status(500).json({ error: 'Failed to store model.' });
        }
    });

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

            const fallbackName = sanitizeFileName(fileName, 'image');
            const extension = (() => {
                const subtype = contentType.split('/')[1] || 'png';
                return subtype.split('+')[0] || 'png';
            })();
            const finalFileName = `${fallbackName}.${extension}`;
            fs.writeFileSync(path.join(IMAGE_DIR, finalFileName), buffer);

            const baseUrl = buildBaseUrl(req);
            const imageUrl = `${baseUrl}/images/${finalFileName}`;

            res.json({
                fileName: finalFileName,
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
            fs.writeFileSync(
                path.join(METADATA_DIR, finalFileName),
                JSON.stringify(metadataObject, null, 2),
                'utf8'
            );

            const baseUrl = buildBaseUrl(req);
            const metadataUrl = `${baseUrl}/metadata/${finalFileName}`;

            res.json({
                fileName: finalFileName,
                metadataUrl
            });
        } catch (error) {
            console.error('Metadata upload failed:', error);
            res.status(500).json({ error: 'Failed to store metadata.' });
        }
    });
}

