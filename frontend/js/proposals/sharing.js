/*
 * Proposal Sharing functionality
 * 
 * This file contains functions for:
 * - Encoding/decoding shared proposal payloads (base64, compression)
 * - Share plan modal and share single proposal modal
 * - Upload proposal to server
 * - URL-based proposal loading (deep links, shared plans)
 * - Proposal load overlay UI
 * 
 * Dependencies (from proposals.js, must be loaded first):
 * - getProposalI18nHelper, getProposalKey, isProposalMinted, getProposalNftInfo
 * - normalizeLensEntries, getProposalLensEntries, resolveProposalGoalKey
 * - proposalStorage, currentProposalDetailsContext
 * - getParcelIdFromFeature, getParcelIdFromProperties, findParcelLayerById
 * - showEphemeralMessage, applyProposalToMap, showProposalInfo
 * - selectAndHighlightProposal, getParcelFeatureForHighlight
 * - isLocalProposalId, buildChainProposalId
 * - ProposalManager (from proposal-manager.js)
 */

// ============================================================================
// Constants
// ============================================================================

const SHARE_URL_MAX_LENGTH = 7500;
const SHARE_PAYLOAD_VERSION = 1;
const SHARE_ENCODING_PREFIX_COMPRESSED = 'z.';
const SHARE_ENCODING_PREFIX_RAW = 'u.';
const SHARE_BASE64_ALLOWED = /^[A-Za-z0-9_-]+$/;

// ============================================================================
// Encoding/Decoding Utilities
// ============================================================================

function base64UrlEncodeBytes(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
        return '';
    }
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
    while (working.length % 4 !== 0) {
        working += '=';
    }
    const binary = atob(working);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

function compressBytes(bytes) {
    if (!(bytes instanceof Uint8Array)) {
        return { bytes, compressed: false };
    }
    if (typeof pako === 'undefined' || typeof pako.deflate !== 'function') {
        return { bytes, compressed: false };
    }
    try {
        const compressedBytes = pako.deflate(bytes, { level: 9 });
        return { bytes: compressedBytes, compressed: true };
    } catch (error) {
        console.warn('pako.deflate failed, falling back to raw payload', error);
        return { bytes, compressed: false };
    }
}

function inflateBytes(bytes, { strict = false } = {}) {
    if (typeof pako === 'undefined' || typeof pako.inflate !== 'function') {
        if (strict) {
            throw new Error('Compressed share links require compression support.');
        }
        return null;
    }
    try {
        return pako.inflate(bytes);
    } catch (error) {
        if (strict) {
            throw error;
        }
        console.warn('pako.inflate failed, falling back to raw payload', error);
        return null;
    }
}

function decodeBytesToJson(bytes) {
    if (typeof TextDecoder !== 'undefined') {
        const decoder = new TextDecoder();
        return decoder.decode(bytes);
    }
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
        const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
        binary += String.fromCharCode.apply(null, chunk);
    }
    return decodeURIComponent(escape(binary));
}

// ============================================================================
// Geometry/Bounds Helpers
// ============================================================================

function computeBoundsFromGeoJSONFeatures(features) {
    if (typeof L === 'undefined' || !Array.isArray(features) || features.length === 0) {
        return null;
    }
    let combined = null;
    features.forEach(feature => {
        if (!feature) return;
        try {
            const layer = L.geoJSON(feature);
            if (layer && typeof layer.getBounds === 'function') {
                const bounds = layer.getBounds();
                if (bounds && bounds.isValid()) {
                    combined = combined ? combined.extend(bounds) : bounds;
                }
            }
        } catch (error) {
            console.warn('computeBoundsFromGeoJSONFeatures skipped feature', error);
        }
    });
    return combined;
}

function buildLeafletBoundsFromArray(bboxArray) {
    if (!Array.isArray(bboxArray) || bboxArray.length !== 4 || typeof L === 'undefined') {
        return null;
    }
    const [minX, minY, maxX, maxY] = bboxArray.map(Number);
    if (![minX, minY, maxX, maxY].every(v => Number.isFinite(v))) {
        return null;
    }
    try {
        return L.latLngBounds([minY, minX], [maxY, maxX]);
    } catch (error) {
        console.warn('buildLeafletBoundsFromArray failed', error, bboxArray);
        return null;
    }
}

function collectCoordinatesFromGeometry(geometry, visitor) {
    if (!geometry || typeof visitor !== 'function') return;
    const { type, coordinates } = geometry;
    if (!type) return;

    switch (type) {
        case 'Point':
            if (Array.isArray(coordinates)) {
                visitor(coordinates[0], coordinates[1]);
            }
            break;
        case 'MultiPoint':
        case 'LineString':
            if (Array.isArray(coordinates)) {
                coordinates.forEach(coord => {
                    if (Array.isArray(coord)) visitor(coord[0], coord[1]);
                });
            }
            break;
        case 'MultiLineString':
        case 'Polygon':
            if (Array.isArray(coordinates)) {
                coordinates.forEach(ring => {
                    if (Array.isArray(ring)) {
                        ring.forEach(coord => {
                            if (Array.isArray(coord)) visitor(coord[0], coord[1]);
                        });
                    }
                });
            }
            break;
        case 'MultiPolygon':
            if (Array.isArray(coordinates)) {
                coordinates.forEach(polygon => {
                    if (Array.isArray(polygon)) {
                        polygon.forEach(ring => {
                            if (Array.isArray(ring)) {
                                ring.forEach(coord => {
                                    if (Array.isArray(coord)) visitor(coord[0], coord[1]);
                                });
                            }
                        });
                    }
                });
            }
            break;
        case 'GeometryCollection':
            if (Array.isArray(geometry.geometries)) {
                geometry.geometries.forEach(inner => collectCoordinatesFromGeometry(inner, visitor));
            }
            break;
        default:
            break;
    }
}

function computeSharedBoundingBoxFromFeatures(features) {
    if (!Array.isArray(features) || features.length === 0) {
        return null;
    }

    let west = Infinity;
    let east = -Infinity;
    let south = Infinity;
    let north = -Infinity;

    features.forEach(feature => {
        if (!feature) return;
        const geometry = feature.type === 'Feature' ? feature.geometry : feature;
        collectCoordinatesFromGeometry(geometry, (lng, lat) => {
            if (!Number.isFinite(lng) || !Number.isFinite(lat)) return;
            if (lng < west) west = lng;
            if (lng > east) east = lng;
            if (lat < south) south = lat;
            if (lat > north) north = lat;
        });
    });

    if (!Number.isFinite(west) || !Number.isFinite(east) || !Number.isFinite(south) || !Number.isFinite(north)) {
        return null;
    }

    const padding = 0.0005;
    return {
        west: west - padding,
        south: south - padding,
        east: east + padding,
        north: north + padding
    };
}

function buildBoundsFromSharedPayload(payload) {
    if (!payload || !payload.bbox) return null;
    const { west, south, east, north } = payload.bbox;
    if (!Number.isFinite(west) || !Number.isFinite(south) || !Number.isFinite(east) || !Number.isFinite(north)) {
        return null;
    }
    if (typeof L === 'undefined') return null;
    try {
        return L.latLngBounds([south, west], [north, east]);
    } catch (_) {
        return null;
    }
}

// ============================================================================
// I18n Helpers
// ============================================================================

function getShareI18nHelper() {
    const t = typeof getProposalI18nHelper === 'function' ? getProposalI18nHelper() : ((k, f) => f);
    const namespace = 'modal.roadWidth.share';
    return (key, fallback, params = {}) => t(`${namespace}.${key}`, fallback, params);
}

function getSharedInspectorI18nHelper() {
    const t = typeof getProposalI18nHelper === 'function' ? getProposalI18nHelper() : ((k, f) => f);
    const namespace = 'modal.roadWidth.sharedInspector';
    return (key, fallback, params = {}) => t(`${namespace}.${key}`, fallback, params);
}

// ============================================================================
// URL Resolution Helpers
// ============================================================================

function resolveBackendBaseUrl() {
    if (typeof global !== 'undefined' && typeof global.getBackendBase === 'function') {
        return global.getBackendBase();
    }
    if (typeof window !== 'undefined' && typeof window.getBackendBase === 'function') {
        return window.getBackendBase();
    }
    const hostname = (typeof window !== 'undefined' && window.location && window.location.hostname)
        ? window.location.hostname.toLowerCase()
        : '';
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0' || hostname.endsWith('.local')) {
        return 'http://localhost:3000';
    }
    return 'https://api.urbangametheory.xyz';
}

function resolveFrontendBaseUrl() {
    if (typeof window === 'undefined' || !window.location) {
        return 'https://urbangametheory.xyz';
    }
    const hostname = window.location.hostname.toLowerCase();
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0' || hostname.endsWith('.local')) {
        return `${window.location.protocol}//${window.location.host}`;
    }
    return 'https://urbangametheory.xyz';
}

function buildCityQueryParam() {
    const mgr = (typeof window !== 'undefined') ? window.CityConfigManager : null;
    if (!mgr) return '';

    const cfg = mgr.getCurrentCityConfig && typeof mgr.getCurrentCityConfig === 'function' ? mgr.getCurrentCityConfig() : null;
    if (!cfg || !cfg.id) return '';

    const getCityCode = mgr.getCityCodeForCityId && typeof mgr.getCityCodeForCityId === 'function' ? mgr.getCityCodeForCityId : null;
    if (!getCityCode) return '';

    const code = getCityCode(cfg.id);
    if (!code) return '';

    return `?city=${encodeURIComponent(code)}`;
}

// Language flag for share URLs. Encodes the language the app is currently displayed in, so a
// first-time recipient (one with no saved language preference) opens the proposal in that language.
// Returning visitors who have explicitly picked a language keep it (see i18n.js precedence).
// Always emitted with a leading '&' — callers append it after an existing query param (e.g. 3d).
function shareLangParam() {
    try {
        const api = (typeof window !== 'undefined') ? window.i18n : null;
        const lang = api && typeof api.getLanguage === 'function' ? api.getLanguage() : null;
        if (lang) return `&lang=${encodeURIComponent(lang)}`;
    } catch (_) { }
    return '';
}

// ============================================================================
// Parcel Collection/Validation for Sharing
// ============================================================================

function collectProposalParentParcelIdsForShare(proposal) {
    const ids = new Set();
    const normalize = (value) => {
        if (value === undefined || value === null) return null;
        const str = value && value.toString ? value.toString() : String(value);
        return str.trim() || null;
    };
    const addValue = (value) => {
        const normalized = normalize(value);
        if (normalized) ids.add(normalized);
    };
    const addMany = (list) => {
        if (!list) return;
        (Array.isArray(list) ? list : [list]).forEach(addValue);
    };

    if (!proposal) return [];

    addMany(proposal.parentParcelIds);

    if (proposal.roadProposal) {
        addMany(proposal.roadProposal.parentParcelIds);
    }

    if (proposal.buildingProposal) {
        addMany(proposal.buildingProposal.parentParcelIds);
    }

    if (proposal.structureProposal) {
        addMany(proposal.structureProposal.parentParcelIds);
    }

    if (proposal.reparcellization && Array.isArray(proposal.reparcellization.parcelIds)) {
        addMany(proposal.reparcellization.parcelIds);
    }

    if (ids.size === 0) {
        addMany(proposal.parentParcelIds);
    }

    return Array.from(ids);
}

function checkParcelsOriginal(parcelList) {
    const nonOriginal = [];
    const seen = new Set();
    if (!parcelList) return nonOriginal;

    const list = Array.isArray(parcelList) ? parcelList : Array.from(parcelList);
    list.forEach(entry => {
        let parcelId = null;
        if (entry === undefined || entry === null) return;
        if (typeof entry === 'string' || typeof entry === 'number') {
            parcelId = entry;
        } else if (typeof entry === 'object') {
            parcelId = entry.parcelId || entry.id || entry.parcel_id;
            if (!parcelId && entry.feature && typeof getParcelIdFromFeature === 'function') {
                parcelId = getParcelIdFromFeature(entry.feature);
            }
            if (!parcelId && entry.properties) {
                parcelId = entry.properties.parcelId || entry.properties.parcel_id || entry.properties.id;
            }
        }

        const normalized = parcelId !== undefined && parcelId !== null
            ? (parcelId.toString ? parcelId.toString() : String(parcelId))
            : null;
        if (!normalized || seen.has(normalized)) return;
        seen.add(normalized);

        let ancestors = [];
        try {
            if (typeof ProposalManager !== 'undefined' && ProposalManager && typeof ProposalManager._getParcelAncestors === 'function') {
                ancestors = ProposalManager._getParcelAncestors(normalized) || [];
            } else if (typeof readPersistedParcelRecord === 'function') {
                const props = readPersistedParcelRecord(normalized)?.properties;
                if (props && props.ancestorProposal) {
                    ancestors = [props.ancestorProposal];
                }
            }
        } catch (_) {
            ancestors = [];
        }

        if (Array.isArray(ancestors) && ancestors.length > 0) {
            nonOriginal.push(normalized);
        }
    });

    return nonOriginal;
}

function collectParcelProposalPairs(parcelList) {
    const pairs = [];
    const seen = new Set();
    if (!parcelList) return pairs;

    const list = Array.isArray(parcelList) ? parcelList : Array.from(parcelList);
    list.forEach(entry => {
        let parcelId = null;
        if (entry === undefined || entry === null) return;
        if (typeof entry === 'string' || typeof entry === 'number') {
            parcelId = entry;
        } else if (typeof entry === 'object') {
            parcelId = entry.parcelId || entry.id || entry.parcel_id;
            if (!parcelId && entry.feature && typeof getParcelIdFromFeature === 'function') {
                parcelId = getParcelIdFromFeature(entry.feature);
            }
            if (!parcelId && entry.properties) {
                parcelId = entry.properties.parcelId || entry.properties.parcel_id || entry.properties.id;
            }
        }

        const normalized = parcelId !== undefined && parcelId !== null
            ? (parcelId.toString ? parcelId.toString() : String(parcelId))
            : null;
        if (!normalized || seen.has(normalized)) return;
        seen.add(normalized);

        let ancestors = [];
        try {
            if (typeof ProposalManager !== 'undefined' && ProposalManager && typeof ProposalManager._getParcelAncestors === 'function') {
                ancestors = ProposalManager._getParcelAncestors(normalized) || [];
            } else if (typeof readPersistedParcelRecord === 'function') {
                const props = readPersistedParcelRecord(normalized)?.properties;
                if (props && props.ancestorProposal) {
                    ancestors = [props.ancestorProposal];
                }
            }
        } catch (_) {
            ancestors = [];
        }

        if (Array.isArray(ancestors) && ancestors.length > 0) {
            ancestors.forEach(ancestorProposalId => {
                pairs.push({
                    parcelId: normalized,
                    proposalId: ancestorProposalId
                });
            });
        }
    });

    return pairs;
}

// Make checkParcelsOriginal available globally
if (typeof window !== 'undefined') {
    window.checkParcelsOriginal = checkParcelsOriginal;
}

// ============================================================================
// Server Proposal ID Helpers
// ============================================================================

function getServerProposalId(proposal) {
    if (!proposal) return null;
    const candidates = [proposal.serverProposalId, proposal.proposalId, proposal.id];
    for (const candidate of candidates) {
        if (!candidate) continue;
        const id = String(candidate);
        if (/^local-\d+$/i.test(id)) return null;
        return id;
    }
    return null;
}

function getSerialProposalId(proposal) {
    if (!proposal) return null;
    if (proposal.serverProposalId) {
        const id = String(proposal.serverProposalId);
        if (/^\d+$/.test(id)) {
            return id;
        }
    }
    if (proposal.proposalId) {
        const id = String(proposal.proposalId);
        if (/^\d+$/.test(id)) {
            return id;
        }
    }
    if (proposal.id) {
        const id = String(proposal.id);
        if (/^\d+$/.test(id)) {
            return id;
        }
    }
    return null;
}

function sortProposalIdsForShare(ids) {
    return ids.slice().sort((a, b) => {
        const na = Number(a);
        const nb = Number(b);
        const aNum = Number.isFinite(na);
        const bNum = Number.isFinite(nb);
        if (aNum && bNum) return na - nb;
        if (aNum && !bNum) return -1;
        if (!aNum && bNum) return 1;
        return String(a).localeCompare(String(b), undefined, { numeric: true });
    });
}

// ============================================================================
// Clone Helpers
// ============================================================================

function deepClone(value) {
    try {
        if (value === undefined) return undefined;
        return JSON.parse(JSON.stringify(value));
    } catch (_) {
        return null;
    }
}

function deepCloneArray(values) {
    if (!Array.isArray(values)) return [];
    return values.map(item => deepClone(item));
}

function ensureArrayOfStrings(list) {
    if (!Array.isArray(list)) return [];
    return list
        .map(value => {
            if (value === null || value === undefined) return '';
            try {
                return value.toString();
            } catch (_) {
                return '';
            }
        })
        .filter(Boolean);
}

function escapeHtml(str) {
    try {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    } catch (_) {
        return '';
    }
}

// ============================================================================
// Parcel Display Helpers
// ============================================================================

const PARCEL_NUMBER_PROPERTY_CANDIDATES = [
    'BROJ_CESTICE',
    'smp',
    'SMP',
    'parcelNumber',
    'parcel_number',
    'parcel',
    'parcelNo',
    'parcel_no',
    'parcelId',
    'parcel_id'
];

function getParcelDisplayNumberFromProperties(properties, fallback = '') {
    if (properties) {
        for (const key of PARCEL_NUMBER_PROPERTY_CANDIDATES) {
            const value = properties[key];
            if (value !== undefined && value !== null) {
                const text = value.toString().trim();
                if (text) {
                    return text;
                }
            }
        }
        if (typeof getParcelIdFromProperties === 'function') {
            const fallbackId = getParcelIdFromProperties(properties);
            if (fallbackId !== undefined && fallbackId !== null) {
                const candidate = fallbackId.toString().trim();
                if (candidate) {
                    return candidate;
                }
            }
        }
    }
    return fallback ? fallback.toString() : '';
}

function getParcelDisplayNumberFromFeature(feature, fallback = '') {
    if (!feature || typeof feature !== 'object') {
        return fallback ? fallback.toString() : '';
    }
    const properties = feature.properties || feature;
    return getParcelDisplayNumberFromProperties(properties, fallback);
}

// ============================================================================
// Decode Shared Payload
// ============================================================================

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
                const inflated = inflateBytes(bytes, { strict: false });
                if (inflated && inflated.length) {
                    decodedBytes = inflated;
                }
            }
            const json = decodeBytesToJson(decodedBytes);
            return JSON.parse(json);
        }

        if (compressionMode === 'compressed') {
            throw new Error('Compressed shared payload is not base64 encoded.');
        }

        const json = decodeURIComponent(working);
        return JSON.parse(json);
    } catch (error) {
        console.error('decodeSharedPayload failed', error);
        throw error;
    }
}

// ============================================================================
// Proposal Upload Helpers
// ============================================================================

function migrateRoadAssetsToNewId(oldId, newId) {
    if (!oldId || !newId || oldId === newId) return;
    if (typeof proposalStorage !== 'undefined' && typeof proposalStorage.clearRoadAssets === 'function') {
        proposalStorage.clearRoadAssets(oldId);
        proposalStorage.clearRoadAssets(newId);
    }
}

function mapGoalToBackendType(goalKey) {
    switch (goalKey) {
        case 'road-track':
            return 'road';
        case 'buildings':
        case 'single':
        case 'row':
            return 'building';
        case 'parcelbased':
        case 'parcel-based':
        case 'parcel':
            return 'parcel';
        case 'park':
        case 'square':
        case 'lake':
            return 'structure';
        default:
            return null;
    }
}

function buildUploadReadyProposal(proposal) {
    if (!proposal) return null;
    const uploadProposal = { ...proposal };

    const rawType = uploadProposal.type ? String(uploadProposal.type).trim().toLowerCase() : '';
    const goalKey = typeof resolveProposalGoalKey === 'function' ? resolveProposalGoalKey(uploadProposal, null) : null;
    const derivedType = mapGoalToBackendType(goalKey);
    uploadProposal.type = derivedType || rawType || 'parcel';

    const currentCityId = typeof getCurrentCityId === 'function'
        ? getCurrentCityId()
        : (typeof window !== 'undefined' && window.getCurrentCityId && typeof window.getCurrentCityId === 'function' ? window.getCurrentCityId() : 'city');
    uploadProposal.city = uploadProposal.city || currentCityId;

    if (uploadProposal.parentFeatures) {
        delete uploadProposal.parentFeatures;
    }
    if (uploadProposal.roadProposal) {
        if (uploadProposal.roadProposal.parentFeatures) {
            delete uploadProposal.roadProposal.parentFeatures;
        }
        if (uploadProposal.roadProposal.childFeatures) {
            delete uploadProposal.roadProposal.childFeatures;
        }
        if (!uploadProposal.roadProposal.parentParcelIds || uploadProposal.roadProposal.parentParcelIds.length === 0) {
            const parentIds = uploadProposal.parentParcelIds || [];
            uploadProposal.roadProposal.parentParcelIds = ensureArrayOfStrings(parentIds);
        }
    }
    return uploadProposal;
}

function syncProposalWithServerId(proposal, serverProposalId) {
    if (!serverProposalId || typeof proposalStorage === 'undefined') return null;
    const oldProposalId = proposal.proposalId;
    const proposalId = proposal.proposalId;
    let storedProposal = oldProposalId ? proposalStorage.getProposal(oldProposalId) : null;
    if (!storedProposal && proposalId) {
        storedProposal = proposalStorage.getProposal(proposalId);
    }
    if (!storedProposal) return null;

    storedProposal.serverProposalId = String(serverProposalId);
    storedProposal.id = storedProposal.id || storedProposal.proposalId;

    if (proposalStorage.proposals) {
        const serverKey = String(serverProposalId);
        const canonicalKey = storedProposal.proposalId ? String(storedProposal.proposalId) : null;
        if (serverKey && canonicalKey && serverKey !== canonicalKey) {
            const aliased = proposalStorage.proposals.get(serverKey);
            if (aliased === storedProposal) {
                proposalStorage.proposals.delete(serverKey);
            }
        }
    }

    migrateRoadAssetsToNewId(oldProposalId, serverProposalId);

    if (typeof proposalStorage._indexProposal === 'function') {
        proposalStorage._indexProposal(storedProposal);
    }

    if (typeof proposalStorage.save === 'function') {
        proposalStorage.save();
    }

    return storedProposal;
}

async function uploadProposalToServer(proposal) {
    const uploadProposal = buildUploadReadyProposal(proposal);
    if (!uploadProposal) {
        return { ok: false, message: 'Invalid proposal.' };
    }

    const backendBase = resolveBackendBaseUrl();
    try {
        const response = await fetch(`${backendBase}/proposals/`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(uploadProposal)
        });

        let errorBody = null;
        if (!response.ok) {
            try { errorBody = await response.json(); } catch (_) { }

            if (response.status === 409 && errorBody && errorBody.id) {
                const serverProposalId = errorBody.id ? String(errorBody.id) : (errorBody.proposalId ? String(errorBody.proposalId) : null);
                if (serverProposalId) {
                    syncProposalWithServerId(proposal, serverProposalId);
                }
                return { ok: true, id: errorBody.id, proposalId: serverProposalId || errorBody.id };
            }

            const errorMessage = errorBody && errorBody.error
                ? errorBody.error
                : 'Failed to upload proposal. Please try again.';
            return { ok: false, message: errorMessage };
        }

        const result = await response.json();
        const serverProposalId = result && result.id ? String(result.id) : String(result.proposalId);
        syncProposalWithServerId(proposal, serverProposalId);
        return { ok: true, id: result.id, proposalId: serverProposalId };
    } catch (error) {
        console.error('uploadProposalToServer failed', error);
        return { ok: false, message: error.message || 'Upload failed.' };
    }
}

async function headProposalExists(proposalId, _city, proposalForSync) {
    if (!proposalId) return false;
    const backendBase = resolveBackendBaseUrl();
    const id = String(proposalId).trim();
    const isNumericId = /^\d+$/.test(id);

    const url = `${backendBase}/proposals/${encodeURIComponent(id)}`;

    try {
        const response = await fetch(url, { method: isNumericId ? 'HEAD' : 'GET' });
        if (response.ok) {
            if (!isNumericId && proposalForSync) {
                try {
                    const payload = await response.clone().json();
                    const serverDbId = payload && payload.id ? String(payload.id) : null;
                    if (serverDbId && typeof isLocalProposalId === 'function' && !isLocalProposalId(serverDbId)) {
                        syncProposalWithServerId(proposalForSync, serverDbId);
                    }
                } catch (_) { /* ignore json parse */ }
            }
            return true;
        }
        if (response.status === 404) return false;
    } catch (error) {
        console.warn('headProposalExists failed', error);
    }
    return false;
}

async function ensureAncestorProposalsUploaded(proposal) {
    const missing = [];
    if (!proposal || typeof ProposalManager === 'undefined' || typeof ProposalManager.findAncestorTree !== 'function' || typeof proposalStorage === 'undefined') {
        return { ok: true, missing };
    }

    const proposalKey = typeof getProposalKey === 'function' ? getProposalKey(proposal) : proposal.proposalId;
    if (!proposalKey) {
        return { ok: true, missing };
    }

    let ancestorNodes = [];
    try {
        ancestorNodes = ProposalManager.findAncestorTree(String(proposalKey), { depthLimit: 32 }) || [];
    } catch (error) {
        console.warn('ensureAncestorProposalsUploaded: failed to compute ancestor tree', error);
        return { ok: true, missing };
    }

    const ancestorHashes = Array.from(new Set(ancestorNodes.map(n => n.proposalId).filter(Boolean)));
    if (!ancestorHashes.length) {
        return { ok: true, missing };
    }

    const checks = await Promise.all(ancestorHashes.map(async hash => {
        const ancestor = proposalStorage.getProposal(hash);
        if (!ancestor) {
            return { hash, reason: 'missing-local', id: null };
        }
        const serverId = getServerProposalId(ancestor);
        if (!serverId) {
            return { hash, reason: 'local-only', id: null };
        }
        const exists = await headProposalExists(serverId, ancestor.city || proposal.city, ancestor);
        return exists ? null : { hash, reason: 'not-found', id: serverId };
    }));

    checks.filter(Boolean).forEach(entry => missing.push(entry));
    return { ok: missing.length === 0, missing };
}

// ============================================================================
// Applied Check
// ============================================================================

function isProposalCurrentlyApplied(proposal) {
    if (!proposal) return false;
    const isAppliedLike = (value) => {
        const normalized = (value || '').toString().toLowerCase();
        return normalized === 'applied' || normalized === 'executed';
    };

    if (isAppliedLike(proposal.status)) return true;
    if (proposal.roadProposal && isAppliedLike(proposal.roadProposal.status)) return true;
    if (proposal.buildingProposal && isAppliedLike(proposal.buildingProposal.status)) return true;
    if (proposal.structureProposal && isAppliedLike(proposal.structureProposal.status)) return true;
    if (proposal.reparcellization && isAppliedLike(proposal.reparcellization.status)) return true;
    if (proposal.decideLaterProposal && isAppliedLike(proposal.decideLaterProposal.status)) return true;
    return false;
}

// ============================================================================
// Global Exports
// ============================================================================

// Export for use by other modules
if (typeof window !== 'undefined') {
    window.shareAppliedProposals = typeof shareAppliedProposals === 'function' ? shareAppliedProposals : function() {
        if (typeof showSharePlanModal === 'function') showSharePlanModal();
    };
    
    // Export utility functions
    window.resolveBackendBaseUrl = resolveBackendBaseUrl;
    window.resolveFrontendBaseUrl = resolveFrontendBaseUrl;
    window.buildCityQueryParam = buildCityQueryParam;
    window.uploadProposalToServer = uploadProposalToServer;
    window.buildUploadReadyProposal = buildUploadReadyProposal;
    window.syncProposalWithServerId = syncProposalWithServerId;
    window.ensureAncestorProposalsUploaded = ensureAncestorProposalsUploaded;
    window.isProposalCurrentlyApplied = isProposalCurrentlyApplied;
    window.getServerProposalId = getServerProposalId;
    window.getSerialProposalId = getSerialProposalId;
    window.decodeSharedPayload = decodeSharedPayload;
    window.base64UrlEncodeBytes = base64UrlEncodeBytes;
    window.base64UrlDecodeToBytes = base64UrlDecodeToBytes;
    window.compressBytes = compressBytes;
    window.inflateBytes = inflateBytes;
    window.getShareI18nHelper = getShareI18nHelper;
    window.collectProposalParentParcelIdsForShare = collectProposalParentParcelIdsForShare;
    window.deepClone = deepClone;
    window.deepCloneArray = deepCloneArray;
    window.ensureArrayOfStrings = ensureArrayOfStrings;
    window.escapeHtml = escapeHtml;
}
