// Serve the ids of the classified road parcels that touch a viewport bbox.
// Accepts WGS84 (EPSG:4326) bbox for easy integration with Leaflet maps. Ids only: the one consumer
// (fetchRoadIds in frontend/js/parcels/fetch.js) marks parcels it already has by id.

import { MAX_VIEW_BBOX_KM2, wgs84BboxAreaKm2 } from '../utils/helpers.js';
import { createRoadClassificationRegistry, NETWORK_ENVIRONMENT_SOURCES, MAX_ROAD_PARCEL_IDS } from '../sources/network-environment.js';

// Row ceilings. The frontend asks with its map view (road parcels are auto-fetched after parcels
// load at z17+; the sidebar button can ask at any zoom), so the bbox cap bounds the area and these
// bound the payload. `truncated: true` in the response says the id list is not complete.
export { MAX_ROAD_PARCEL_IDS };

function parseWgs84Bbox(raw) {
    if (!raw || typeof raw !== 'string') return null;
    const parts = String(raw).split(',').map(v => Number(v.trim()));
    if (parts.length !== 4) return null;
    if (parts.some(v => !Number.isFinite(v))) return null;
    const [minLng, minLat, maxLng, maxLat] = parts;
    if (minLng >= maxLng || minLat >= maxLat) return null;
    return parts;
}

function bboxTooLarge(bbox) {
    const areaKm2 = wgs84BboxAreaKm2(...bbox);
    return areaKm2 > MAX_VIEW_BBOX_KM2
        ? `bbox too large (${Math.round(areaKm2)} km², max ${MAX_VIEW_BBOX_KM2} km²). Zoom in.`
        : null;
}

export function setupRoadParcelsRoute(app, pool) {
    const sources = createRoadClassificationRegistry();
    app.get('/road-parcels', async (req, res) => {
        const bbox = parseWgs84Bbox(req.query.bbox);
        if (!bbox) {
            return res.status(400).json({ error: 'bbox required. Expected minLng,minLat,maxLng,maxLat in WGS84.' });
        }
        const bboxError = bboxTooLarge(bbox);
        if (bboxError) return res.status(400).json({ error: bboxError });

        let client;
        try {
            client = await pool.connect();
            const fetched = await sources.open(NETWORK_ENVIRONMENT_SOURCES.classifications, { client }).readIds(bbox);
            const truncated = fetched.length > MAX_ROAD_PARCEL_IDS;
            const rows = truncated ? fetched.slice(0, MAX_ROAD_PARCEL_IDS) : fetched;
            res.json({ ids: rows.map(r => r.parcel_id), truncated });
        } catch (err) {
            console.error('Error in /road-parcels:', err);
            res.status(500).json({ error: 'Internal server error' });
        } finally {
            client?.release();
        }
    });
    return sources;
}
