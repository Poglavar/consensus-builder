// GET /osm-public-spaces?bbox=minLon,minLat,maxLon,maxLat&crs=EPSG:4326 — OpenStreetMap parks and
// squares in a box, for the public land of Plan stats and Compare plans
// (frontend/js/proposals/present-state.js). Answered through the backend's Overpass chain (the paid
// instance first, cached per grid cell, buildings/osm-reference.js), which the browser asks first;
// public Overpass is the browser's fallback when this server cannot answer (user decision
// 2026-10-28). The query and the element reader are the browser's own, so both paths agree.
import { createRequire } from 'node:module';
import { createOverpassCellSource } from '../buildings/osm-reference.js';
import { parseWgs84Bbox } from '../utils/helpers.js';

const require = createRequire(import.meta.url);
const presentState = require('../../frontend/js/proposals/present-state.js');

// The browser asks for one plan's land at a time; the reader refuses anything wider anyway.
const MAX_SPAN_DEG = 0.05;
const CAP = 5000;

// Overpass can answer HTTP 200 with a timeout remark and only some elements: that is a failure.
function convert(elements, cap = CAP, json = null) {
    if (!Array.isArray(elements) || (json && json.remark)) throw new Error(`Overpass answer is incomplete${json && json.remark ? `: ${json.remark}` : ''}`);
    const { features, skipped } = presentState.publicSpacesFromOverpass(elements);
    if (skipped) console.warn(`[${new Date().toISOString()}] [osm public-spaces] ${skipped} park or square relations did not close and were left out`);
    return { features: features.slice(0, cap), truncated: features.length > cap };
}

const fetchDefault = createOverpassCellSource({ label: 'public-spaces', buildQuery: presentState.publicSpaceQuery, convert, featureCap: CAP });

export function setupOsmPublicSpacesRoute(app, options = {}) {
    const fetchSpaces = options.fetchSpaces || fetchDefault;
    app.get('/osm-public-spaces', async (req, res) => {
        const boxes = parseWgs84Bbox(req.query.bbox, req.query.crs);
        if (!boxes || boxes.length !== 1) {
            return res.status(400).json({ error: 'bbox must be minLon,minLat,maxLon,maxLat with crs=EPSG:4326, not crossing the antimeridian.' });
        }
        const [box] = boxes;
        if (box[2] - box[0] > MAX_SPAN_DEG || box[3] - box[1] > MAX_SPAN_DEG) {
            return res.status(400).json({ error: `bbox is wider than ${MAX_SPAN_DEG}°; ask for one plan's land at a time.` });
        }
        try {
            const fc = await fetchSpaces(box, options);
            // A partial or capped answer would undercount public land, so it is no answer.
            if (fc.partial || fc.truncated) {
                return res.status(503).json({ error: fc.truncated ? 'Too many parks and squares in this box.' : 'OpenStreetMap answered only part of this box; try again.' });
            }
            return res.json({ type: 'FeatureCollection', features: fc.features, source: 'overpass' });
        } catch (error) {
            console.error(`[${new Date().toISOString()}] [osm public-spaces] ${error.message}`);
            if (error.retryAfter) res.set('Retry-After', String(error.retryAfter));
            return res.status(error.status && error.status >= 400 ? error.status : 502).json({ error: 'OpenStreetMap parks and squares could not be read.' });
        }
    });
}
