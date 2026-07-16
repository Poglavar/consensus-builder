// proposals/parcel-id.js — parcel identity + parcel-record persistence cache.
// Parcel-id normalization (from props/feature), display numbers, and the localStorage parcel-record
// read/write/clear + write-cache helpers (which read _parcelRecordWriteCache from state.js).
// Extracted from proposals.js; leaf helpers, cross-module calls resolve as runtime globals.

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

function findVisibleDescendant(proposalId) {
    if (!proposalId) return null;
    if (typeof proposalStorage === 'undefined' || !proposalStorage) return proposalId;

    const visited = new Set();
    let currentId = proposalId;

    while (currentId && !visited.has(currentId)) {
        visited.add(currentId);

        const proposal = getProposalByIdOrHash(currentId);
        if (!proposal) {
            console.debug('[findVisibleDescendant] No proposal found for', currentId);
            break;
        }

        // Get child parcel IDs for this proposal
        const childParcelIds = [];
        const addIds = (list) => {
            (Array.isArray(list) ? list : []).forEach(id => {
                const val = id && id.toString ? id.toString() : String(id || '');
                if (val) childParcelIds.push(val);
            });
        };
        addIds(proposal.childParcelIds);
        addIds(proposal?.roadProposal?.childParcelIds);
        addIds(proposal?.reparcellization?.childParcelIds);
        addIds(proposal?.decideLaterProposal?.childParcelIds);
        addIds(proposal?.structureProposal?.childParcelIds);

        if (childParcelIds.length === 0) {
            // No children, this is a leaf - return it
            console.debug('[findVisibleDescendant] No children for', currentId, '- returning it');
            return currentId;
        }

        // Check if any child parcel has a descendantProposal marker
        let descendantProposalId = null;
        for (const childId of childParcelIds) {
            // Check in layer index first
            let layer = null;
            if (typeof resolveParcelLayerById === 'function') {
                layer = resolveParcelLayerById(childId);
            }

            const props = layer?.feature?.properties || layer?.options || null;
            if (props) {
                const marker = props.descendantProposal || props.descendantProposals;
                if (marker) {
                    // Found a descendant - continue traversing
                    descendantProposalId = Array.isArray(marker) ? marker[0] : marker;
                    console.debug('[findVisibleDescendant] Child', childId, 'has descendant marker:', descendantProposalId);
                    break;
                }
            }

            // Also check in storage
            if (!descendantProposalId && typeof readPersistedParcelRecord === 'function') {
                const record = readPersistedParcelRecord(childId);
                if (record && record.properties) {
                    const marker = record.properties.descendantProposal || record.properties.descendantProposals;
                    if (marker) {
                        descendantProposalId = Array.isArray(marker) ? marker[0] : marker;
                        console.debug('[findVisibleDescendant] Child', childId, 'has descendant marker in storage:', descendantProposalId);
                        break;
                    }
                }
            }
        }

        if (!descendantProposalId) {
            // No descendants found - this proposal's children are visible
            console.debug('[findVisibleDescendant] No descendant markers found for', currentId, '- returning it');
            return currentId;
        }

        // Continue traversing to the descendant
        currentId = descendantProposalId;
    }

    // If we exhausted the loop (cycle or end), return the last valid ID
    console.debug('[findVisibleDescendant] Exhausted traversal, returning', currentId || proposalId);
    return currentId || proposalId;
}

function getParcelAreaById(parcelId) {
    if (parcelId === undefined || parcelId === null) return 0;
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

    if (!area) {
        try {
            if (typeof parcelLayer !== 'undefined' && parcelLayer && typeof parcelLayer.eachLayer === 'function') {
                parcelLayer.eachLayer(l => {
                    if (area) return;
                    const candidate = getParcelIdFromFeature(l?.feature);
                    if (candidate !== undefined && candidate !== null && candidate.toString() === parcelId.toString()) {
                        const maybeArea = l.feature?.properties?.calculatedArea;
                        if (Number.isFinite(maybeArea)) {
                            area = Number(maybeArea) || 0;
                            source = 'parcelLayer.eachLayer';
                        }
                    }
                });
            }
        } catch (err) {
            console.warn('[getParcelAreaById] parcelLayer.eachLayer error:', err);
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
        isParcelWriteBatchActive
    };
}
