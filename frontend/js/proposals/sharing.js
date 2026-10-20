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
const sharingProposalOrigin = (typeof window !== 'undefined' && window.ProposalOrigin)
    || (typeof require === 'function' ? require('./origin.js') : null);

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

function getSerialProposalId(proposal) {
    // Browser records carry publication explicitly. Local keys, authored IDs and generic `id`
    // fields cannot establish a published row; API rows acquire this reference during import.
    const currentBase = sharingProposalOrigin.apiBase(typeof getBackendBase === 'function' ? getBackendBase() : null);
    const publishedBase = sharingProposalOrigin.apiBase(proposal?.publicationApiBase);
    if (!currentBase || publishedBase !== currentBase) return null;
    const id = String(proposal?.serverProposalId ?? '');
    return /^[1-9]\d*$/.test(id) ? id : null;
}

// A ~64-bit content hash (two djb2 variants) rendered base36 — stable across sessions, no crypto.
function proposalContentHash(str) {
    let h1 = 5381;
    let h2 = 52711;
    for (let i = 0; i < str.length; i += 1) {
        const c = str.charCodeAt(i);
        h1 = ((h1 << 5) + h1 + c) | 0;
        h2 = (((h2 << 5) + h2) ^ c) | 0;
    }
    return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
}

function approvalApiForFingerprint() {
    if (typeof window !== 'undefined' && window.ProposalApproval) return window.ProposalApproval;
    if (typeof globalThis !== 'undefined' && globalThis.ProposalApproval) return globalThis.ProposalApproval;
    // The API server and the focused Node tests load this classic-script module through CommonJS.
    // Resolve lazily so geometry-only fingerprints keep working without an approval config.
    if (typeof require === 'function') return require('./approval.js');
    return null;
}

function approvalContextSource(proposal) {
    if (!Array.isArray(proposal?.lens)) return proposal;
    // Names are display labels, not member identities. Keep them out of approval commitments.
    return { ...proposal, lens: proposal.lens.filter(entry => !(entry && typeof entry === 'object'
        && !entry.address && !entry.key && entry.name)) };
}

// A stable fingerprint of a proposal's IMPORTANT content — the geometry payload + the terms that
// define what it IS — excluding view/identity/lifecycle state (applied, ids, timestamps, carved
// children). Used as the dedup id when publishing: each edited local snapshot has its own local
// record, while byte-identical snapshots may share the same immutable server artifact.
//
// Upload identity keeps the established c2 geometry/content hash. Consent additionally binds to
// the proposal's one cadastral declaration. Runtime parcel pieces participate in neither.
function proposalContentPayload(proposal, includeCadastre = false) {
    const cleanPayload = (payload) => {
        if (!payload || typeof payload !== 'object') return null;
        const copy = { ...payload };
        ['applied', 'appliedAt', 'childParcelIds', 'childFeatures', 'parentFeatures', 'hash']
            .forEach(key => { delete copy[key]; });
        return copy;
    };
    const goal = (typeof resolveProposalGoalKey === 'function')
        ? resolveProposalGoalKey(proposal, null) : (proposal.goal || null);
    const content = {
        goal,
        offer: (proposal.offer === undefined || proposal.offer === null) ? null : Number(proposal.offer),
        offerCurrency: proposal.offerCurrency || null,
        isConditional: !!proposal.isConditional,
        geometry: proposal.geometry || null,
        roadProposal: cleanPayload(proposal.roadProposal),
        buildingProposal: cleanPayload(proposal.buildingProposal),
        structureProposal: cleanPayload(proposal.structureProposal),
        reparcellization: cleanPayload(proposal.reparcellization),
        decideLaterProposal: cleanPayload(proposal.decideLaterProposal)
    };
    // The authored site is content (two designs on different drawn sites are different proposals).
    // Only present on site-first records, so older fingerprints and share ids do not move.
    if (proposal.site) content.site = proposal.site;
    // The kind is chosen at publish (proposal-kinds.md); only records that have one commit it, so
    // fingerprints of records published before kinds existed do not move.
    if (proposal.kind) content.kind = proposal.kind;
    if (proposal.proposalOrigin) {
        const origin = sharingProposalOrigin.portable(proposal.proposalOrigin, {
            findLocal: id => typeof proposalStorage !== 'undefined' ? proposalStorage.proposals?.get(id) : null,
            backendBase: typeof getBackendBase === 'function' ? getBackendBase() : null
        });
        // Derivation changes the published record. The source's display title is not identity.
        content.proposalOrigin = { relation: origin.relation, source: origin.source };
    }
    if (Number(proposal.toleranceM) > 0) content.toleranceM = Number(proposal.toleranceM);
    // A re-bind (binding-drift.js) carries the same site and design as its source; the binding it
    // was derived for makes it a different record, so its upload is not deduplicated onto the source.
    if (proposal.rebind && proposal.rebind.bindingKey) content.rebind = String(proposal.rebind.bindingKey);
    if (includeCadastre) {
        content.cadastreParcelIds = (Array.isArray(proposal.cadastreParcelIds)
            ? proposal.cadastreParcelIds : []).map(String).slice().sort();
    }
    const hasApprovalConfig = Object.prototype.hasOwnProperty.call(proposal, 'approvalConfig')
        && proposal.approvalConfig !== undefined;
    const lens = Array.isArray(proposal.lens) ? proposal.lens.slice() : [];
    if (hasApprovalConfig || lens.length) {
        const approval = approvalApiForFingerprint();
        if (!approval?.contextContent) throw new Error('Proposal approval canonicalizer is unavailable.');
        const contextSource = approvalContextSource(proposal);
        const lensKeys = approval.lensKeys(contextSource);
        if (hasApprovalConfig || lensKeys.length) {
            // The shared context drops display labels and canonicalizes rights, policy, lens keys
            // and the cadastral declaration together. Its presence is conditional to preserve old hashes.
            content.approvalContext = approval.contextContent(contextSource);
        }
    }
    return content;
}

function proposalContentFingerprint(proposal) {
    if (!proposal || typeof proposal !== 'object') return null;
    const content = proposalContentPayload(proposal, false);
    const str = (typeof stableStringify === 'function') ? stableStringify(content) : JSON.stringify(content);
    return 'c2-' + proposalContentHash(str);
}

function proposalConsentFingerprint(proposal) {
    if (!proposal || typeof proposal !== 'object') return null;
    const content = proposalContentPayload(proposal, true);
    if (proposal.approvalConfig != null) {
        // Commit the content itself with SHA-256, not an older short geometry fingerprint.
        // Approval is shared across tools, so financial/recipient/vote terms must travel with it.
        const terms = Object.fromEntries([
            'facets', 'proposalFacets', 'ownershipFlow', 'acquisitionMode', 'boundaryAdjustment',
            'disbursementMode', 'expiresAt', 'decayEnabled', 'decayPercent', 'decayDurationMs',
            // 'isVote' is no longer written (the kind replaced it, and sits in `content`); it stays
            // in this list so the consent hashes owners already signed keep their value.
            'depositEnabled', 'depositPercent', 'isVote', 'voteExpiryDays', 'ownershipTransferProposal'
        ].map(key => [key, proposal[key] ?? null]));
        const approval = approvalApiForFingerprint();
        return approval.consentHash(proposal, approval.stableStringify({ content, terms }));
    }
    const str = (typeof stableStringify === 'function') ? stableStringify(content) : JSON.stringify(content);
    return 'c-' + proposalContentHash(str);
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
    window.proposalContentFingerprint = proposalContentFingerprint;
    window.proposalConsentFingerprint = proposalConsentFingerprint;
    window.decodeSharedPayload = decodeSharedPayload;
    window.base64UrlEncodeBytes = base64UrlEncodeBytes;
    window.base64UrlDecodeToBytes = base64UrlDecodeToBytes;
    window.compressBytes = compressBytes;
    window.inflateBytes = inflateBytes;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        base64UrlEncodeBytes,
        base64UrlDecodeToBytes,
        compressBytes,
        inflateBytes,
        decodeBytesToJson,
        decodeSharedPayload,
        getSerialProposalId,
        proposalContentFingerprint,
        proposalConsentFingerprint
    };
}
