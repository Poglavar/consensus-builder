const EARTH_RADIUS_M = 6_371_008.8;
const MAX_OBSERVATIONS = 250;
const MAX_POINTS = 80;
const LINE_KINDS = new Set(['road_edge', 'lane_divider', 'median_edge', 'stop_line', 'lane_width']);
const POINT_KINDS = new Set(['taper_start', 'merge_point', 'split_point']);

function radians(value) {
    return value * Math.PI / 180;
}

function distanceMeters([lon1, lat1], [lon2, lat2]) {
    const phi1 = radians(lat1);
    const phi2 = radians(lat2);
    const deltaPhi = radians(lat2 - lat1);
    const deltaLambda = radians(lon2 - lon1);
    const a = Math.sin(deltaPhi / 2) ** 2
        + Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda / 2) ** 2;
    return 2 * EARTH_RADIUS_M * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function normalizedPoint(value) {
    if (!Array.isArray(value) || value.length !== 2) return null;
    const x = Number(value[0]);
    const y = Number(value[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) {
        return null;
    }
    return [x, y];
}

function geographicPoint([x, y], bbox) {
    const [west, south, east, north] = bbox;
    return [
        Number((west + x * (east - west)).toFixed(9)),
        Number((north - y * (north - south)).toFixed(9))
    ];
}

function stringArray(value, maxItems = 20) {
    return [...new Set(
        (Array.isArray(value) ? value : [])
            .map(item => String(item || '').trim())
            .filter(Boolean)
            .slice(0, maxItems)
    )];
}

export function normalizeImageryObservations(raw, imagery, provider = 'model') {
    if (!imagery?.bbox || !Array.isArray(raw)) return [];
    const bbox = imagery.bbox.map(Number);
    if (bbox.length !== 4 || bbox.some(value => !Number.isFinite(value))) return [];

    const observations = [];
    raw.slice(0, MAX_OBSERVATIONS).forEach((candidate, index) => {
        const kind = String(candidate?.kind || '').trim();
        if (!LINE_KINDS.has(kind) && !POINT_KINDS.has(kind)) return;
        const normalizedPoints = (Array.isArray(candidate?.points) ? candidate.points : [])
            .slice(0, MAX_POINTS)
            .map(normalizedPoint)
            .filter(Boolean);
        const minimumPoints = POINT_KINDS.has(kind) ? 1 : 2;
        if (normalizedPoints.length < minimumPoints) return;
        const selectedPoints = POINT_KINDS.has(kind)
            ? [normalizedPoints[0]]
            : normalizedPoints;
        const coordinates = selectedPoints.map(point => geographicPoint(point, bbox));
        const confidence = Number(candidate?.confidence);
        const properties = {
            id: `imagery:${provider}:${index}`,
            kind,
            source: provider,
            imagerySource: imagery.source?.key || null,
            capturedAt: imagery.source?.capturedAt || null,
            confidence: Number.isFinite(confidence)
                ? Math.max(0, Math.min(1, confidence))
                : 0.5,
            normalizedPoints: selectedPoints,
            sourceWayIds: stringArray(candidate?.sourceWayIds),
            sectionIds: stringArray(candidate?.sectionIds),
            laneIds: stringArray(candidate?.laneIds),
            reason: String(candidate?.reason || '').slice(0, 1000)
        };
        if (kind === 'lane_width' && coordinates.length === 2) {
            properties.measuredWidthM = Number(distanceMeters(coordinates[0], coordinates[1]).toFixed(2));
        }
        observations.push({
            type: 'Feature',
            id: properties.id,
            geometry: POINT_KINDS.has(kind)
                ? { type: 'Point', coordinates: coordinates[0] }
                : { type: 'LineString', coordinates },
            properties
        });
    });
    return observations;
}
