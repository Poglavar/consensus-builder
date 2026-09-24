// Shared guard for the decentralized-storage relays (/ipfs/upload, /walrus/upload). Both pin
// content on OUR paid accounts, so they accept exactly what the mint flows send — one PNG/JPEG/WEBP
// screenshot plus ERC-721-style NFT metadata (see frontend/js/proposals/create.js,
// proposals/dialog-upload.js, parcels/ui/claim.js) — within tight size caps and a per-IP rate limit.

import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { decodeImageDataUrl } from './image-store.js';
import { isPlainObject } from './request-validation.js';

// A tile-stitched proposal screenshot is at most ~6x6 256px tiles plus padding (a few MB as PNG);
// the parcel mint captures 640px. 5 MB leaves room for either and nothing much else.
export const MAX_UPLOAD_IMAGE_BYTES = 5 * 1024 * 1024;
// Metadata carries the proposal's full geometry (so the NFT alone can reconstruct it), which is
// the only large part. 1 MB of JSON is far beyond any real proposal.
export const MAX_METADATA_BYTES = 1024 * 1024;
export const MAX_ATTRIBUTES = 50;

// Per IP, per window, on top of the global write limiter. A mint is one upload; a parcel batch
// mint is one per parcel.
export const UPLOAD_RATE_WINDOW_MS = 15 * 60 * 1000;
export const UPLOAD_RATE_MAX = 30;

// Top-level keys the mint flows actually send. Anything else is not NFT metadata.
const ALLOWED_METADATA_KEYS = new Set([
    'name', 'title', 'description', 'image', 'image_url', 'external_url',
    'attributes', 'properties', 'parcelId', 'areaSquareMeters', 'geometry'
]);
const ALLOWED_ATTRIBUTE_KEYS = new Set(['trait_type', 'value', 'display_type']);

const isShortString = (v, max) => typeof v === 'string' && v.length <= max;

/**
 * Validate the NFT metadata object. Returns an error string, or null when it is acceptable.
 * @param {object} metadata - already known to be a plain object (body validator)
 */
export function validateNftMetadata(metadata) {
    if (!isPlainObject(metadata)) return 'metadata object is required.';
    const unknown = Object.keys(metadata).filter(k => !ALLOWED_METADATA_KEYS.has(k));
    if (unknown.length) return `metadata contains unsupported fields: ${unknown.slice(0, 5).join(', ')}.`;
    if (typeof metadata.name !== 'string' || !metadata.name.trim() || metadata.name.length > 200) {
        return 'metadata.name must be a non-empty string (max 200 chars).';
    }
    for (const key of ['title', 'parcelId']) {
        if (metadata[key] !== undefined && !isShortString(metadata[key], 200)) return `metadata.${key} must be a string (max 200 chars).`;
    }
    if (metadata.description !== undefined && !isShortString(metadata.description, 10000)) {
        return 'metadata.description must be a string (max 10000 chars).';
    }
    for (const key of ['image', 'image_url']) {
        // Overwritten with the stored image's URI; the client value is never kept.
        if (metadata[key] !== undefined && !isShortString(metadata[key], 2048)) return `metadata.${key} must be a string.`;
    }
    if (metadata.external_url !== undefined && metadata.external_url !== '') {
        if (!isShortString(metadata.external_url, 2048) || !/^https?:\/\//i.test(metadata.external_url)) {
            return 'metadata.external_url must be an http(s) URL.';
        }
    }
    if (metadata.areaSquareMeters !== undefined && metadata.areaSquareMeters !== null
        && !(typeof metadata.areaSquareMeters === 'number' && Number.isFinite(metadata.areaSquareMeters))) {
        return 'metadata.areaSquareMeters must be a number or null.';
    }
    if (metadata.geometry !== undefined && metadata.geometry !== null && !isPlainObject(metadata.geometry)) {
        return 'metadata.geometry must be an object or null.';
    }
    if (metadata.properties !== undefined && !isPlainObject(metadata.properties)) {
        return 'metadata.properties must be an object.';
    }
    if (metadata.attributes !== undefined) {
        if (!Array.isArray(metadata.attributes) || metadata.attributes.length > MAX_ATTRIBUTES) {
            return `metadata.attributes must be an array (max ${MAX_ATTRIBUTES}).`;
        }
        for (const attr of metadata.attributes) {
            if (!isPlainObject(attr) || Object.keys(attr).some(k => !ALLOWED_ATTRIBUTE_KEYS.has(k))) {
                return 'metadata.attributes entries must be { trait_type, value, display_type? }.';
            }
            if (!isShortString(attr.trait_type, 100)) return 'metadata.attributes[].trait_type must be a string (max 100 chars).';
            const v = attr.value;
            const okValue = v === null || typeof v === 'boolean'
                || (typeof v === 'number' && Number.isFinite(v)) || isShortString(v, 1000);
            if (!okValue) return 'metadata.attributes[].value must be a string, number, boolean or null.';
            if (attr.display_type !== undefined && !isShortString(attr.display_type, 50)) {
                return 'metadata.attributes[].display_type must be a string.';
            }
        }
    }
    if (Buffer.byteLength(JSON.stringify(metadata), 'utf8') > MAX_METADATA_BYTES) {
        return `metadata too large (max ${MAX_METADATA_BYTES / 1024} KB).`;
    }
    return null;
}

/**
 * Decode and PROVE the upload image: a base64 data URL whose bytes sniff as PNG/JPEG/WEBP, within
 * the size cap. The declared mime type is ignored. Returns { buffer, contentType, extension } or
 * { error }.
 */
export function decodeUploadImage(imageData) {
    const decoded = decodeImageDataUrl(imageData);
    if (!decoded) return { error: 'imageData must be a base64 data URL.' };
    if (!decoded.buffer.length) return { error: 'Decoded image data is empty.' };
    if (decoded.buffer.length > MAX_UPLOAD_IMAGE_BYTES) {
        return { error: `Image too large (max ${MAX_UPLOAD_IMAGE_BYTES / 1024 / 1024} MB).` };
    }
    if (!decoded.contentType) return { error: 'imageData must be a PNG, JPEG or WEBP image.' };
    return decoded;
}

// req.ip, never the CF-Connecting-IP header (forgeable by anyone reaching the origin directly):
// nginx maps Cloudflare's header to the connecting address and the app trusts that one hop. IPv6
// is bucketed to its allocation so one visitor cannot walk their /56 for a fresh allowance.
function uploadClientKey(req) {
    const address = String(req.ip || '').trim();
    return address ? ipKeyGenerator(address) : 'unknown';
}

/** A fresh per-IP limiter for one relay route (each route gets its own budget). */
export function createUploadRateLimiter({ windowMs = UPLOAD_RATE_WINDOW_MS, limit = UPLOAD_RATE_MAX } = {}) {
    return rateLimit({
        windowMs,
        limit,
        standardHeaders: true,
        legacyHeaders: false,
        keyGenerator: uploadClientKey,
        handler: (req, res) => res.status(429).json({ error: 'Too many uploads, please try again later.' })
    });
}
