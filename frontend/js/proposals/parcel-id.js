// proposals/parcel-id.js — parcel identity and display helpers.

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
    const candidates = [props.parcelId, props.parcel_id, props.id];
    for (const candidate of candidates) {
        const normalized = normalizeParcelId(candidate);
        if (normalized) return normalized;
    }
    return null;
}

function getParcelIdFromFeature(feature) {
    if (!feature || typeof feature !== 'object') return null;
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

// A parcel's area, remembered by immutable identity. Live generated parcels come from the fabric;
// original cadastral parcels come from the repository. Leaflet and legacy local records are never
// geometry lookup fallbacks.
const _parcelAreaById = new Map();
let _parcelAreaScope = null;

function parcelAreaScope(root) {
    let city = 'default';
    try { city = String(root.CityConfigManager?.getCurrentCityId?.() || 'default'); } catch (_) { }
    const revision = root.LiveParcelFabric?.snapshot?.().revision ?? 'none';
    return `${city}|${revision}`;
}

function getParcelAreaById(parcelId) {
    if (parcelId === undefined || parcelId === null) return 0;
    const root = typeof window !== 'undefined' ? window : globalThis;
    const scope = parcelAreaScope(root);
    if (_parcelAreaScope !== scope) {
        _parcelAreaById.clear();
        _parcelAreaScope = scope;
    }
    const id = parcelId.toString();
    const key = `${scope}\u0000${id}`;
    const remembered = _parcelAreaById.get(key);
    if (remembered !== undefined) return remembered;

    let area = 0;
    const feature = root.LiveParcelFabric?.get?.(id)
        || root.CadastralParcelRepository?.get?.(id)
        || null;
    const calculated = feature?.properties?.calculatedArea;
    if (Number.isFinite(calculated)) area = Number(calculated) || 0;
    else if (feature && root.turf && typeof root.turf.area === 'function') {
        try { area = Number(root.turf.area(feature)) || 0; } catch (_) { }
    }

    if (area) _parcelAreaById.set(key, area);
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

if (typeof module === 'object' && module.exports) {
    module.exports = {
        normalizeParcelId,
        getParcelIdFromProperties,
        getParcelIdFromFeature,
        ensureParcelIdOnFeature,
        normalizeParcelIdList,
        getParcelAreaById,
        getParcelDisplayNumberFromProperties,
        getParcelDisplayNumberFromFeature,
        PARCEL_NUMBER_PROPERTY_CANDIDATES
    };
}
