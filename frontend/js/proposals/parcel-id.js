// proposals/parcel-id.js — parcel identity + parcel-record persistence cache.
// Parcel-id normalization (from props/feature), display numbers, and the localStorage parcel-record
// read/write/clear + write-cache helpers (which read _parcelRecordWriteCache from state.js).
// Extracted from proposals.js; leaf helpers, cross-module calls resolve as runtime globals.

// Display-number schema belongs beside the display-number accessor. This used to live in the much
// later-loaded sharing bundle; when that bundle's duplicate parcel helpers were removed, the accessor
// retained a hidden global dependency and every proposal/block details render began throwing.
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

function normalizeParcelId(value) {
    if (value === undefined || value === null) return null;
    const str = value.toString().trim();
    return str.length > 0 ? str : null;
}

function getParcelIdFromProperties(props) {
    if (!props || typeof props !== 'object') return null;
    try {
        if (typeof ensureParcelId === 'function') {
            const ensured = ensureParcelId({ properties: props });
            const normalized = normalizeParcelId(ensured);
            if (normalized) return normalized;
        }
    } catch (_) { /* ignore */ }
    const candidates = [props.parcelId, props.parcel_id, props.id];
    for (const candidate of candidates) {
        const normalized = normalizeParcelId(candidate);
        if (normalized) return normalized;
    }
    return null;
}

function getParcelIdFromFeature(feature) {
    if (!feature || typeof feature !== 'object') return null;
    if (typeof ensureParcelId === 'function') {
        try {
            const ensured = ensureParcelId(feature);
            const normalized = normalizeParcelId(ensured);
            if (normalized) return normalized;
        } catch (_) { /* ignore */ }
    }
    return getParcelIdFromProperties(feature.properties);
}

function ensureParcelIdOnFeature(feature, preferredId = null) {
    if (!feature || typeof feature !== 'object') return null;
    const props = feature.properties || (feature.properties = {});
    const resolved = normalizeParcelId(preferredId) || getParcelIdFromProperties(props);
    if (!resolved) return null;
    props.parcelId = resolved;
    return resolved;
}

function normalizeParcelIdList(list) {
    if (!Array.isArray(list)) return [];
    const unique = new Set();
    list.forEach(value => {
        const normalized = normalizeParcelId(value);
        if (normalized) {
            unique.add(normalized);
        }
    });
    return Array.from(unique).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

function _startParcelWriteCache() {
    _parcelRecordWriteCache = new Map();
}

function _flushParcelWriteCache() {
    if (!_parcelRecordWriteCache) return;
    const cache = _parcelRecordWriteCache;
    _parcelRecordWriteCache = null;
    if (typeof PersistentStorage === 'undefined') return;
    cache.forEach((record, parcelId) => {
        const key = `parcel_${parcelId}`;
        try { PersistentStorage.setItem(key, JSON.stringify(record)); } catch (_) { }
    });
}

function _discardParcelWriteCache() {
    _parcelRecordWriteCache = null;
}

function isParcelWriteBatchActive() {
    return typeof _parcelRecordWriteCache !== 'undefined' && _parcelRecordWriteCache instanceof Map;
}

async function withParcelWriteBatch(operation) {
    if (typeof operation !== 'function') {
        throw new TypeError('withParcelWriteBatch requires an operation function');
    }

    const ownsBatch = !isParcelWriteBatchActive();
    if (ownsBatch) _startParcelWriteCache();
    let committed = false;

    try {
        const result = await operation();
        if (result === false) return false;
        if (ownsBatch) _flushParcelWriteCache();
        committed = true;
        return result;
    } finally {
        if (ownsBatch && !committed) _discardParcelWriteCache();
    }
}

function readPersistedParcelRecord(parcelId) {
    if (!parcelId) return null;
    const idStr = String(parcelId);

    // Check write cache first
    if (_parcelRecordWriteCache && _parcelRecordWriteCache.has(idStr)) {
        return _parcelRecordWriteCache.get(idStr);
    }

    if (typeof PersistentStorage === 'undefined') return null;
    const key = `parcel_${parcelId}`;
    try {
        const raw = PersistentStorage.getItem(key);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return null;
        if (!parsed.properties) parsed.properties = {};
        return parsed;
    } catch (_) { }
    return null;
}

function writePersistedParcelRecord(parcelId, updater) {
    if (!parcelId) return null;
    const idStr = String(parcelId);

    // Get existing record from cache or storage
    let record = null;
    if (_parcelRecordWriteCache && _parcelRecordWriteCache.has(idStr)) {
        record = _parcelRecordWriteCache.get(idStr);
    } else {
        record = readPersistedParcelRecord(parcelId) || { id: idStr, properties: {}, geometry: null };
    }

    if (typeof updater === 'function') {
        try { updater(record); } catch (_) { /* ignore */ }
    }

    // If caching is enabled, store in cache instead of writing immediately
    if (_parcelRecordWriteCache) {
        _parcelRecordWriteCache.set(idStr, record);
        return record;
    }

    // No cache - write immediately
    if (typeof PersistentStorage !== 'undefined') {
        const key = `parcel_${parcelId}`;
        try { PersistentStorage.setItem(key, JSON.stringify(record)); } catch (_) { }
    }
    return record;
}

function clearPersistedParcelRecord(parcelId) {
    if (!parcelId) return;
    const idStr = String(parcelId);

    // Remove from cache if present
    if (_parcelRecordWriteCache) {
        _parcelRecordWriteCache.delete(idStr);
    }

    if (typeof PersistentStorage === 'undefined') return;
    try { PersistentStorage.removeItem(`parcel_${parcelId}`); } catch (_) { }
}

// A parcel's area, remembered.
//
// This is asked once per parent parcel per proposal, by the metrics the proposals list computes for
// EVERY row before anything is clicked. With 621 proposals that is a couple of thousand lookups, and
// the fallback below is a full walk of every parcel on the map — so a miss cost a 13,000-layer scan,
// and misses are the common case, because applying rewrites a proposal's parents to CADASTRAL ids
// while the map holds the pieces those parcels were cut into.
//
// Caching by id is sound rather than merely convenient: a piece id is a content hash of its ring, so
// the same id always means the same shape, and a cadastral parcel's surveyed area does not change
// inside a session. Only successful answers are cached; a miss is remembered against the parcel
// count that produced it, so it is retried once more ground has loaded.
const _parcelAreaById = new Map();
const _parcelAreaMissAt = new Map();
let _parcelAreaScanAt = -1;

function _liveParcelCount() {
    try {
        if (typeof parcelLayerById !== 'undefined' && parcelLayerById instanceof Map) return parcelLayerById.size;
    } catch (_) { }
    return -1;
}

// One walk fills the cache for EVERY parcel on the map, so the first miss pays for the scan and no
// later one does. Scanning once per id was the same walk repeated a thousand times over.
function _primeParcelAreaCache(count) {
    if (_parcelAreaScanAt === count) return;
    _parcelAreaScanAt = count;
    try {
        if (typeof parcelLayer === 'undefined' || !parcelLayer || typeof parcelLayer.eachLayer !== 'function') return;
        parcelLayer.eachLayer(layer => {
            const candidate = getParcelIdFromFeature(layer?.feature);
            if (candidate === undefined || candidate === null) return;
            const maybeArea = layer.feature?.properties?.calculatedArea;
            if (!Number.isFinite(maybeArea)) return;
            const key = candidate.toString();
            if (!_parcelAreaById.has(key)) _parcelAreaById.set(key, Number(maybeArea) || 0);
        });
    } catch (err) {
        console.warn('[getParcelAreaById] parcelLayer.eachLayer error:', err);
    }
}

function getParcelAreaById(parcelId) {
    if (parcelId === undefined || parcelId === null) return 0;
    const key = parcelId.toString();
    const remembered = _parcelAreaById.get(key);
    if (remembered !== undefined) return remembered;

    let area = 0;
    let source = 'none';

    try {
        const layer = typeof resolveParcelLayerById === 'function'
            ? resolveParcelLayerById(parcelId)
            : (typeof multiParcelSelection !== 'undefined' && multiParcelSelection && typeof multiParcelSelection.findParcelById === 'function'
                ? multiParcelSelection.findParcelById(parcelId)
                : null);
        if (layer && layer.feature?.properties && Number.isFinite(layer.feature.properties.calculatedArea)) {
            area = Number(layer.feature.properties.calculatedArea) || 0;
            source = 'resolveParcelLayerById';
        }
    } catch (err) {
        console.warn('[getParcelAreaById] resolveParcelLayerById error:', err);
    }

    const count = _liveParcelCount();
    if (!area) {
        if (_parcelAreaMissAt.get(key) === count) return 0;
        _primeParcelAreaCache(count);
        const scanned = _parcelAreaById.get(key);
        if (scanned !== undefined) {
            area = scanned;
            source = 'parcelLayer.eachLayer';
        }
    }

    if (!area) {
        try {
            const record = readPersistedParcelRecord(parcelId);
            const props = record?.properties;
            if (props && Number.isFinite(props.calculatedArea)) {
                area = Number(props.calculatedArea) || 0;
                source = 'PersistentStorage';
            }
        } catch (_) {
            // ignore storage issues
        }
    }

    if (area) _parcelAreaById.set(key, area);
    else _parcelAreaMissAt.set(key, count);
    return area;
}

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
        const fallbackId = getParcelIdFromProperties(properties);
        if (fallbackId !== undefined && fallbackId !== null) {
            const candidate = fallbackId.toString().trim();
            if (candidate) {
                return candidate;
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

if (typeof window !== 'undefined') {
    window.withParcelWriteBatch = withParcelWriteBatch;
    window.isParcelWriteBatchActive = isParcelWriteBatchActive;
}

if (typeof module === 'object' && module.exports) {
    module.exports = {
        normalizeParcelId,
        getParcelIdFromProperties,
        getParcelIdFromFeature,
        ensureParcelIdOnFeature,
        normalizeParcelIdList,
        readPersistedParcelRecord,
        writePersistedParcelRecord,
        clearPersistedParcelRecord,
        getParcelAreaById,
        getParcelDisplayNumberFromProperties,
        getParcelDisplayNumberFromFeature,
        _startParcelWriteCache,
        _flushParcelWriteCache,
        _discardParcelWriteCache,
        withParcelWriteBatch,
        isParcelWriteBatchActive,
        PARCEL_NUMBER_PROPERTY_CANDIDATES
    };
}
