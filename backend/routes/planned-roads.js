// GET /planned-road: the government road plan in a map view, as the land it reserves for roads that
// is not road yet. Zagreb's GUP street widening reservations and new GUP streets, minus the existing
// road parcels; "Draw/Apply government road plan" (frontend/js/government-roads.js) reads it.
import { parseBboxParam, MAX_VIEW_BBOX_KM2 } from '../utils/helpers.js';
import { createPlannedRoadRegistry, NETWORK_ENVIRONMENT_SOURCES, MAX_PLANNED_ROAD_FEATURES, MIN_PLAN_PIECE_M2 } from '../sources/network-environment.js';

// Hard ceiling on features per response. The bbox cap bounds the area; this bounds the payload
// when that area is dense. `truncated: true` tells the caller the list is not the whole answer.
export { MAX_PLANNED_ROAD_FEATURES };
// Pieces left after subtracting existing road parcels that are smaller than this are slivers from
// the two sources' edges not lining up (18% of pieces, 0.1% of the area in central Zagreb), not plan.
export { MIN_PLAN_PIECE_M2 };

export function setupPlannedRoadRoute(app, pool) {
    const sources = createPlannedRoadRegistry();
    app.get('/planned-road', async (req, res) => {
        // A bbox is required: the frontend always sends its map view, and without one this unioned
        // every road parcel in the city on an anonymous GET while holding a pooled client.
        const bboxParts = parseBboxParam(typeof req.query.bbox === 'string' ? req.query.bbox : '');
        if (!bboxParts) {
            return res.status(400).json({ error: 'Invalid bbox. Expected minX,minY,maxX,maxY in EPSG:3765.' });
        }
        const areaKm2 = ((bboxParts[2] - bboxParts[0]) * (bboxParts[3] - bboxParts[1])) / 1e6;
        if (areaKm2 > MAX_VIEW_BBOX_KM2) {
            return res.status(400).json({ error: `bbox too large (${Math.round(areaKm2)} km², max ${MAX_VIEW_BBOX_KM2} km²). Zoom in.` });
        }

        let client;
        try {
            client = await pool.connect();
            const fetchedRows = await sources.open(NETWORK_ENVIRONMENT_SOURCES.planned, { client }).readReservations(bboxParts);
            const truncated = fetchedRows.length > MAX_PLANNED_ROAD_FEATURES;
            const rows = truncated ? fetchedRows.slice(0, MAX_PLANNED_ROAD_FEATURES) : fetchedRows;
            const features = rows
                .map(row => {
                    if (!row || !row.geometry) return null;
                    const props = (row.props && typeof row.props === 'object' && !Array.isArray(row.props)) ? { ...row.props } : {};
                    props.planStatus = props.planStatus || 'planned';
                    props.source = props.source || 'government_plan';
                    props.displayColor = props.displayColor || '#ffd54f';
                    props.strokeColor = props.strokeColor || '#c98a00';
                    props.strokeWeight = props.strokeWeight || 2;
                    props.fillOpacity = props.fillOpacity ?? 0.35;
                    return {
                        type: 'Feature',
                        properties: props,
                        geometry: row.geometry
                    };
                })
                .filter(Boolean);

            res.json({ type: 'FeatureCollection', features, truncated });
        } catch (err) {
            console.error('Error in /planned-road:', err);
            res.status(500).json({ error: 'Internal server error' });
        } finally {
            client?.release();
        }
    });
    return sources;
}
