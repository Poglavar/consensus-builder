import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

const UPLOAD_ROOT = path.resolve('uploads');
const IMAGE_DIR = path.join(UPLOAD_ROOT, 'images');
const METADATA_DIR = path.join(UPLOAD_ROOT, 'metadata');

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

export function setupFileStorageRoutes(app) {
    ensureDirectories();

    app.post('/images', (req, res) => {
        try {
            const { imageData, fileName } = req.body || {};
            if (typeof imageData !== 'string' || !imageData.trim()) {
                return res.status(400).json({ error: 'imageData (base64 data URL) is required.' });
            }

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
            res.status(500).json({ error: error.message || 'Failed to store image.' });
        }
    });

    app.post('/metadata', (req, res) => {
        try {
            const { metadata, fileName } = req.body || {};
            const metadataObject = typeof metadata === 'string'
                ? JSON.parse(metadata)
                : metadata;
            if (typeof metadataObject !== 'object' || metadataObject === null) {
                return res.status(400).json({ error: 'metadata object is required.' });
            }

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
            res.status(500).json({ error: error.message || 'Failed to store metadata.' });
        }
    });
}
