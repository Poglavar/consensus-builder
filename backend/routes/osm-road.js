// GET /osm-road?bbox=minLon,minLat,maxLon,maxLat&crs=EPSG:4326 — existing-road CENTRELINES from the osm_road
// table (true OSM linestrings, with tags/width/highway_type/city), for drawing a read-only reference
// layer and, later, snapping new roads onto them.
//
// osm_road stores the native OSM geometry in `geom` (EPSG:4326) and a GENERATED, indexed `geom_3765`
// for Croatian-TM spatial ops. Both dev and prod carry this schema (dev was realigned to prod on
// 2026-07-15). The bbox arrives in WGS84 and names its CRS (projections.md §4: a client's own
// projection never labels a bbox), and is filtered against the indexed `geom` in that same CRS:
// projecting it into Croatian TM fails outright for a box far from Croatia ("Point outside of
// projection domain" for Bogotá, 2026-10-17), which turned every such request into a 500 instead
// of the Overpass answer below. Output is geom (already 4326, ready for GeoJSON) — the heavy
// buffered columns are never returned.
//
// Outside the ingested table (any city without osm_road rows) a scene-sized bbox is answered from
// OpenStreetMap live, through the shared Overpass chain (roads/osm-road-overpass.js), in the same
// feature shape with `source: 'overpass'`. The 3D life layer and the 2D existing-roads layer thus
// see OSM streets everywhere without the browser ever holding an Overpass credential. A box larger
// than a scene is answered for a scene-sized box around its centre, and says `clipped: true`.
//
// `railways=1` adds railway ways (table rows with a railway_type, and Overpass `way["railway"]`) for
// the 2D road tools; the 3D life layer leaves it off and gets streets alone. Every feature carries
// `osm_node_ids`, the shared OSM nodes the road tools rebuild topology from.
import { parseWgs84Bbox, wgs84BboxFilterSql } from '../utils/helpers.js';
import {
    fetchOverpassRoads as defaultFetchOverpassRoads,
    fetchOverpassRoadsAndRailways as defaultFetchOverpassRoadsAndRailways,
    roadsBboxTooLarge, clipRoadsBbox
} from '../roads/osm-road-overpass.js';

const MAX_FEATURES = 8000;

export function setupOsmRoadRoute(app, pool, options = {}) {
    const fetchOverpassRoads = options.fetchOverpassRoads || defaultFetchOverpassRoads;
    const fetchOverpassRoadsAndRailways = options.fetchOverpassRoadsAndRailways || defaultFetchOverpassRoadsAndRailways;
    app.get('/osm-road', async (req, res) => {
        try {
            const railways = req.query.railways === '1' || req.query.railways === 'true';
            const boxes = parseWgs84Bbox(req.query.bbox, req.query.crs);
            const hasBbox = Array.isArray(boxes);

            if (req.query.bbox && !hasBbox) {
                return res.status(400).json({ error: 'Invalid bbox. Expected bbox=minLon,minLat,maxLon,maxLat&crs=EPSG:4326.' });
            }

            let sql = `
                SELECT
                    ST_AsGeoJSON(r.geom)::json AS geometry,
                    jsonb_build_object(
                        'osm_id', r.osm_id,
                        'highway_type', r.highway_type,
                        'railway_type', r.railway_type,
                        'name', r.name,
                        'width_meters', r.width_meters,
                        'city', r.city,
                        'tags', r.tags,
                        'osm_node_ids', r.osm_node_ids,
                        'source', 'osm_road'
                    ) AS properties
                FROM osm_road r
                WHERE r.current AND r.geom IS NOT NULL
                  AND ${railways ? '(r.highway_type IS NOT NULL OR r.railway_type IS NOT NULL)' : 'r.highway_type IS NOT NULL'}
            `;

            const params = [];
            if (hasBbox) {
                // Index-backed test on geom (osm_road_geom_gix) in the box's own CRS; no projection.
                const filter = wgs84BboxFilterSql('r.geom', boxes, 4326);
                sql += ` AND ${filter.sql}`;
                params.push(...filter.params);
            }

            sql += `\n            LIMIT ${MAX_FEATURES}\n        `;

            const { rows } = await pool.query(sql, params);
            const features = rows.map(row => ({
                type: 'Feature',
                properties: row.properties || {},
                geometry: row.geometry
            }));

            const liveBox = !features.length && hasBbox && boxes.length === 1
                ? (roadsBboxTooLarge(boxes[0]) ? clipRoadsBbox(boxes[0]) : boxes[0]) : null;
            if (liveBox) {
                const clipped = liveBox !== boxes[0];
                try {
                    const live = await (railways ? fetchOverpassRoadsAndRailways : fetchOverpassRoads)(liveBox);
                    return res.json({
                        type: 'FeatureCollection', features: live.features, source: 'overpass',
                        truncated: !!live.truncated, partial: !!live.partial,
                        ...(clipped ? { clipped: true, bbox: liveBox } : {})
                    });
                } catch (err) {
                    console.warn(`[${new Date().toISOString()}] /osm-road: no table rows and Overpass unavailable (${err && err.message ? err.message : err})`);
                    return res.json({ type: 'FeatureCollection', features: [], source: 'osm_road', truncated: false, overpass: 'unavailable' });
                }
            }
            res.json({ type: 'FeatureCollection', features, source: 'osm_road', truncated: features.length >= MAX_FEATURES });
        } catch (err) {
            console.error('Error in /osm-road:', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    });
}
