import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

const UPLOAD_ROOT = path.resolve('uploads');
const IMAGE_DIR = path.join(UPLOAD_ROOT, 'images');
const METADATA_DIR = path.join(UPLOAD_ROOT, 'metadata');
const STATIC_PROPOSAL_IMAGE_URL = 'https://urbangametheory.xyz/images/consensus-builder-logo.png';

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

export function setupAssetsRoute(app) {
    ensureUploadDirectories();

    app.post('/assets/upload', async (req, res) => {
        try {
            const { imageData, metadata, fileName } = req.body || {};
            if (!imageData || typeof imageData !== 'string') {
                return res.status(400).json({ error: 'imageData is required.' });
            }
            if (!metadata || typeof metadata !== 'object') {
                return res.status(400).json({ error: 'metadata object is required.' });
            }

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

            const safeBase = (fileName && String(fileName).trim()) || `road-proposal-${Date.now()}-${randomUUID()}`;
            const imageFilename = `${safeBase}.${extension}`;
            const metadataFilename = `${safeBase}.json`;

            ensureUploadDirectories();
            fs.writeFileSync(path.join(IMAGE_DIR, imageFilename), buffer);

            const baseUrl = resolveBaseUrl(req);
            const uploadedImageUrl = `${baseUrl}/uploads/images/${imageFilename}`;
            const staticImageUrl = STATIC_PROPOSAL_IMAGE_URL;
            const existingProperties = metadata?.properties && typeof metadata.properties === 'object'
                ? metadata.properties
                : {};
            const metadataToSave = {
                ...metadata,
                image: staticImageUrl,
                image_url: staticImageUrl,
                external_url: metadata?.external_url || staticImageUrl,
                properties: {
                    ...existingProperties,
                    uploadedImageUrl
                }
            };
            fs.writeFileSync(path.join(METADATA_DIR, metadataFilename), JSON.stringify(metadataToSave, null, 2), 'utf8');

            const metadataUrl = `${baseUrl}/uploads/metadata/${metadataFilename}`;

            res.json({
                imageUri: staticImageUrl,
                imageUrl: staticImageUrl,
                imageGatewayUrl: staticImageUrl,
                uploadedImageUrl,
                metadataUri: metadataUrl,
                metadataUrl,
                metadataGatewayUrl: metadataUrl
            });
        } catch (error) {
            console.error('Assets upload failed:', error);
            res.status(500).json({ error: error.message || 'Failed to store uploaded assets.' });
        }
    });
}



