// proposals/sharing.js — the share-link codec and the few helpers that belong to that codec.
//
// This frontend still loads classic scripts, so every top-level declaration is global. Sharing
// previously carried second copies of geometry, storage, server-sync, i18n, and lifecycle helpers;
// because this file loads late, those copies silently replaced their canonical implementations.
// Keep this file deliberately small: feature ownership stays with the modules loaded before it.

const SHARE_URL_MAX_LENGTH = 7500;
const SHARE_PAYLOAD_VERSION = 1;
const SHARE_ENCODING_PREFIX_COMPRESSED = 'z.';
const SHARE_ENCODING_PREFIX_RAW = 'u.';
const SHARE_BASE64_ALLOWED = /^[A-Za-z0-9_-]+$/;

function base64UrlEncodeBytes(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length === 0) return '';
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
        const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
        binary += String.fromCharCode.apply(null, chunk);
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecodeToBytes(input) {
    let working = input || '';
    working = working.replace(/-/g, '+').replace(/_/g, '/');
    while (working.length % 4 !== 0) working += '=';
    const binary = atob(working);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

function compressBytes(bytes) {
    if (!(bytes instanceof Uint8Array)) return { bytes, compressed: false };
    if (typeof pako === 'undefined' || typeof pako.deflate !== 'function') {
        return { bytes, compressed: false };
    }
    try {
        return { bytes: pako.deflate(bytes, { level: 9 }), compressed: true };
    } catch (error) {
        console.warn('pako.deflate failed, falling back to raw payload', error);
        return { bytes, compressed: false };
    }
}

function inflateBytes(bytes, { strict = false } = {}) {
    if (typeof pako === 'undefined' || typeof pako.inflate !== 'function') {
        if (strict) throw new Error('Compressed share links require compression support.');
        return null;
    }
    try {
        return pako.inflate(bytes);
    } catch (error) {
        if (strict) throw error;
        console.warn('pako.inflate failed, falling back to raw payload', error);
        return null;
    }
}

function decodeBytesToJson(bytes) {
    if (typeof TextDecoder !== 'undefined') return new TextDecoder().decode(bytes);
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
        const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
        binary += String.fromCharCode.apply(null, chunk);
    }
    return decodeURIComponent(escape(binary));
}

// Encodes the currently displayed language in a share URL. Returning visitors who explicitly chose
// another language keep that preference (see i18n.js). Callers append this after another query arg.
function shareLangParam() {
    try {
        const api = typeof window !== 'undefined' ? window.i18n : null;
        const lang = api && typeof api.getLanguage === 'function' ? api.getLanguage() : null;
        if (lang) return `&lang=${encodeURIComponent(lang)}`;
    } catch (_) { /* best effort */ }
    return '';
}

function collectProposalParentParcelIdsForShare(proposal) {
    const ids = new Set();
    const addMany = (values) => {
        if (values === undefined || values === null) return;
        (Array.isArray(values) ? values : [values]).forEach(value => {
            const normalized = String(value == null ? '' : value).trim();
            if (normalized) ids.add(normalized);
        });
    };

    if (!proposal) return [];
    addMany(proposal.parentParcelIds);
    addMany(proposal.roadProposal && proposal.roadProposal.parentParcelIds);
    addMany(proposal.buildingProposal && proposal.buildingProposal.parentParcelIds);
    addMany(proposal.structureProposal && proposal.structureProposal.parentParcelIds);
    addMany(proposal.reparcellization && proposal.reparcellization.parcelIds);
    return Array.from(ids);
}

function getSerialProposalId(proposal) {
    if (!proposal) return null;
    for (const candidate of [proposal.serverProposalId, proposal.proposalId, proposal.id]) {
        const id = candidate === undefined || candidate === null ? '' : String(candidate);
        if (/^\d+$/.test(id)) return id;
    }
    return null;
}

function decodeSharedPayload(encoded) {
    if (!encoded) return null;
    let working = encoded.trim();
    let compressionMode = 'legacy';
    if (working.startsWith(SHARE_ENCODING_PREFIX_COMPRESSED)) {
        compressionMode = 'compressed';
        working = working.slice(SHARE_ENCODING_PREFIX_COMPRESSED.length);
    } else if (working.startsWith(SHARE_ENCODING_PREFIX_RAW)) {
        compressionMode = 'raw';
        working = working.slice(SHARE_ENCODING_PREFIX_RAW.length);
    }

    try {
        if (SHARE_BASE64_ALLOWED.test(working)) {
            const bytes = base64UrlDecodeToBytes(working);
            let decodedBytes = bytes;
            if (compressionMode === 'compressed') {
                decodedBytes = inflateBytes(bytes, { strict: true });
            } else if (compressionMode === 'legacy') {
                const inflated = inflateBytes(bytes);
                if (inflated && inflated.length) decodedBytes = inflated;
            }
            return JSON.parse(decodeBytesToJson(decodedBytes));
        }

        if (compressionMode === 'compressed') {
            throw new Error('Compressed shared payload is not base64 encoded.');
        }
        return JSON.parse(decodeURIComponent(working));
    } catch (error) {
        console.error('decodeSharedPayload failed', error);
        throw error;
    }
}

if (typeof window !== 'undefined') {
    window.getSerialProposalId = getSerialProposalId;
    window.decodeSharedPayload = decodeSharedPayload;
    window.base64UrlEncodeBytes = base64UrlEncodeBytes;
    window.base64UrlDecodeToBytes = base64UrlDecodeToBytes;
    window.compressBytes = compressBytes;
    window.inflateBytes = inflateBytes;
    window.collectProposalParentParcelIdsForShare = collectProposalParentParcelIdsForShare;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        base64UrlEncodeBytes,
        base64UrlDecodeToBytes,
        compressBytes,
        inflateBytes,
        decodeBytesToJson,
        decodeSharedPayload,
        collectProposalParentParcelIdsForShare,
        getSerialProposalId
    };
}
