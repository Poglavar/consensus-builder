// proposals/roads.js — extracted from proposals.js (behavior-preserving relocation).

function getRoadDesignationTranslator(baseHelper) {
    return (key, fallback, params = {}) => {
        if (typeof baseHelper === 'function') {
            return baseHelper(`proposals.roadDesignation.${key}`, fallback, params);
        }
        return fallback;
    };
}

function getCorridorI18nHelper() {
    const baseHelper = (typeof getProposalI18nHelper === 'function') ? getProposalI18nHelper() : null;
    return getRoadDesignationTranslator(baseHelper);
}

function serialiseRoadCoordinates(coords = []) {
    return coords
        .map(pair => {
            if (!Array.isArray(pair) || pair.length < 2) return '0,0';
            const [lng, lat] = pair;
            const safeLng = Number.isFinite(lng) ? lng.toFixed(6) : '0.000000';
            const safeLat = Number.isFinite(lat) ? lat.toFixed(6) : '0.000000';
            return `${safeLng},${safeLat}`;
        })
        .join(';');
}

function serialiseGeometry(geometry) {
    if (!geometry) return '';
    try {
        return JSON.stringify(geometry);
    } catch (_) {
        return '';
    }
}

function serialiseRoadDefinition(definition) {
    if (!definition || typeof definition !== 'object') return '';

    const width = Number.isFinite(definition.width)
        ? definition.width.toFixed(2)
        : (definition.width !== undefined && definition.width !== null
            ? definition.width.toString()
            : '');

    const points = Array.isArray(definition.points)
        ? definition.points.map(point => {
            if (!point) return '0.000000,0.000000';
            const lat = Number.isFinite(point.lat) ? point.lat.toFixed(6) : '0.000000';
            const lng = Number.isFinite(point.lng) ? point.lng.toFixed(6) : '0.000000';
            return `${lng},${lat}`;
        }).join(';')
        : '';

    return `w=${width}|pts=${points}`;
}
