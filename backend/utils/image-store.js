// Single writer for uploaded/generated images. Both the /assets/upload route and the server-side
// proposal thumbnail renderer store PNGs here, so there is exactly one place that decides where
// image bytes live (uploads/images) and what URL they are served at (/uploads/images/<file>).
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

const UPLOAD_ROOT = path.resolve('uploads');
const IMAGE_DIR = path.join(UPLOAD_ROOT, 'images');
const METADATA_DIR = path.join(UPLOAD_ROOT, 'metadata');

export function ensureImageDirectories() {
    [UPLOAD_ROOT, IMAGE_DIR, METADATA_DIR].forEach(dir => {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    });
}

export function sanitizeFileName(raw, fallbackPrefix) {
    const base = (raw || '').toString().trim();
    const safe = base
        .toLowerCase()
        .replace(/[^a-z0-9-_]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
    if (safe) return safe;
    return `${fallbackPrefix}-${Date.now()}-${randomUUID()}`;
}

/**
 * Write image bytes into uploads/images and return the file name plus the path it is served at.
 * @param {Buffer} buffer - image bytes
 * @param {string} fileNameBase - unsanitized base name (no extension)
 * @param {string} [extension='png']
 * @returns {{ fileName: string, imagePath: string, absolutePath: string }}
 */
export function saveImageBuffer(buffer, fileNameBase, extension = 'png') {
    if (!Buffer.isBuffer(buffer) || !buffer.length) {
        throw new Error('saveImageBuffer requires a non-empty Buffer.');
    }
    ensureImageDirectories();
    const safeBase = sanitizeFileName(fileNameBase, 'image');
    const fileName = `${safeBase}.${extension}`;
    const absolutePath = path.join(IMAGE_DIR, fileName);
    fs.writeFileSync(absolutePath, buffer);
    return { fileName, imagePath: `/uploads/images/${fileName}`, absolutePath };
}

/**
 * Decode a base64 data URL into { buffer, extension, contentType }.
 * Returns null only when the input is not a data URL at all — a data URL that decodes to zero bytes
 * still comes back (with an empty buffer), because callers report that as a different error.
 */
export function decodeImageDataUrl(dataUrl) {
    if (typeof dataUrl !== 'string') return null;
    const matches = dataUrl.match(/^data:(.+);base64,(.+)$/);
    if (!matches || matches.length < 3) return null;
    const contentType = matches[1];
    const buffer = Buffer.from(matches[2], 'base64');
    const subtype = (contentType.split('/')[1] || 'png').split('+')[0].toLowerCase();
    return { buffer, extension: subtype || 'png', contentType };
}

export function imageFileExists(fileName) {
    if (!fileName) return false;
    return fs.existsSync(path.join(IMAGE_DIR, path.basename(fileName)));
}

export { IMAGE_DIR, METADATA_DIR, UPLOAD_ROOT };
