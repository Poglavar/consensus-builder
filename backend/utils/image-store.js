// Single writer for uploaded/generated images. Both the /assets/upload route and the server-side
// proposal thumbnail renderer store PNGs here, so there is exactly one place that decides where
// image bytes live (uploads/images) and what URL they are served at (/uploads/images/<file>).
import fs from 'fs';
import path from 'path';
import { randomBytes, randomUUID } from 'crypto';

const UPLOAD_ROOT = path.resolve('uploads');
const IMAGE_DIR = path.join(UPLOAD_ROOT, 'images');
const METADATA_DIR = path.join(UPLOAD_ROOT, 'metadata');

// The only image types we store, keyed by sniffed mime → on-disk extension. The extension is
// chosen HERE from the real bytes, never from the client's declared data-URL mime: a declared
// `text/html` or `image/svg+xml` used to become a `.html`/`.svg` file served from the API origin.
const IMAGE_EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

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

// Stored names always end in a server-generated random id, so a client that knows (or guesses)
// a name — proposal-thumb-<id>-<ts> is public in screenshot_url — can never overwrite that file.
export function uniqueFileBase(raw, fallbackPrefix) {
    return `${sanitizeFileName(raw, fallbackPrefix)}-${randomBytes(6).toString('hex')}`;
}

// Sniff the real bytes: PNG, JPEG or WEBP, else null.
export function sniffImageType(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
    if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
    return null;
}

/**
 * Write image bytes into uploads/images and return the file name plus the path it is served at.
 * The bytes must sniff as PNG/JPEG/WEBP (throws otherwise); the extension comes from the sniff.
 * The name gets a random suffix and is written with `wx`, so an existing file is never replaced.
 * @param {Buffer} buffer - image bytes
 * @param {string} fileNameBase - unsanitized base name (no extension)
 * @returns {{ fileName: string, imagePath: string, absolutePath: string, contentType: string }}
 */
export function saveImageBuffer(buffer, fileNameBase) {
    if (!Buffer.isBuffer(buffer) || !buffer.length) {
        throw new Error('saveImageBuffer requires a non-empty Buffer.');
    }
    const contentType = sniffImageType(buffer);
    if (!contentType) {
        throw new Error('saveImageBuffer: bytes are not a PNG, JPEG or WEBP image.');
    }
    ensureImageDirectories();
    const fileName = `${uniqueFileBase(fileNameBase, 'image')}.${IMAGE_EXTENSIONS[contentType]}`;
    const absolutePath = path.join(IMAGE_DIR, fileName);
    fs.writeFileSync(absolutePath, buffer, { flag: 'wx' });
    return { fileName, imagePath: `/uploads/images/${fileName}`, absolutePath, contentType };
}

/**
 * Decode a base64 data URL into { buffer, contentType, extension }, where contentType/extension
 * come from sniffing the bytes (null when they are not an allowlisted image) — the declared mime
 * is ignored. Returns null only when the input is not a data URL at all; a data URL that decodes
 * to zero bytes still comes back (with an empty buffer), because callers report that separately.
 */
export function decodeImageDataUrl(dataUrl) {
    if (typeof dataUrl !== 'string') return null;
    const matches = dataUrl.match(/^data:(.+);base64,(.+)$/);
    if (!matches || matches.length < 3) return null;
    const buffer = Buffer.from(matches[2], 'base64');
    const contentType = sniffImageType(buffer);
    return { buffer, contentType, extension: contentType ? IMAGE_EXTENSIONS[contentType] : null };
}

export function imageFileExists(fileName) {
    if (!fileName) return false;
    return fs.existsSync(path.join(IMAGE_DIR, path.basename(fileName)));
}

export { IMAGE_DIR, METADATA_DIR, UPLOAD_ROOT };
