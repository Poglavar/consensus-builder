// Shared helper functions for the backend

export const POSTGIS_SRID = 3765;

// ArcGIS API configuration
export const ARCGIS_BASE_URL = 'https://services8.arcgis.com/Usi0jGQwMmBUpFjr/arcgis/rest/services/ZG3D_2022_3d_model_GZ/FeatureServer/0/query';

// An error that carries its own HTTP status. The global error handler answers `status` + message
// for 4xx (instead of a blanket 500), so a validation helper can throw from anywhere in a handler.
export class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.name = 'HttpError';
        this.status = status;
        this.expose = status < 500;
    }
}

// A single query-string value, trimmed. Express parses `?a=1&a=2` into an ARRAY and `?a[b]=1` into
// an object, so `(req.query.a || '').trim()` throws on either — and an async handler that throws
// used to take the whole process down. A repeated or nested parameter is the caller's mistake: 400.
export function queryString(query, name) {
    const value = query?.[name];
    if (value === undefined || value === null) return '';
    if (typeof value !== 'string') {
        throw new HttpError(400, `Query parameter "${name}" must be given once, as a plain value.`);
    }
    return value.trim();
}

// Approximate area of a WGS84 bbox in km² (equirectangular at the mid latitude — plenty for a cap).
export function wgs84BboxAreaKm2(minLon, minLat, maxLon, maxLat) {
    const midLatRad = ((minLat + maxLat) / 2) * Math.PI / 180;
    const widthKm = Math.abs(maxLon - minLon) * 111.32 * Math.cos(midLatRad);
    const heightKm = Math.abs(maxLat - minLat) * 110.57;
    return widthKm * heightKm;
}

// Viewport-sized reads. The frontend asks for its map view (planned roads, road parcels — z13 on a
// large screen is ~370 km²) or for 500 m grid cells (city parcel sources), so anything bigger is
// not the app asking. Row caps back these up: a bbox inside the cap can still be dense.
export const MAX_VIEW_BBOX_KM2 = 400;
export const MAX_CELL_BBOX_KM2 = 100;

export function parseBboxParam(raw) {
    if (!raw) return null;
    const parts = String(raw).split(',').map(v => Number(v.trim()));
    if (parts.length !== 4) return null;
    if (parts.some(v => !Number.isFinite(v))) return null;
    const [minX, minY, maxX, maxY] = parts;
    if (minX >= maxX || minY >= maxY) return null;
    return parts;
}

// Helper function to convert GeoJSON to Esri rings format
export function geoJsonToEsriRings(geojson) {
    if (!geojson || !geojson.coordinates) return [];

    if (geojson.type === 'Polygon') {
        return geojson.coordinates;
    } else if (geojson.type === 'MultiPolygon') {
        return geojson.coordinates.flat();
    }
    return [];
}

// Helper function to compute bounds from rings
export function computeBoundsFromRings(rings) {
    if (!rings.length) return null;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

    rings.forEach(ring => {
        ring.forEach(coord => {
            const [x, y] = coord;
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
        });
    });

    return { minX, minY, maxX, maxY };
}

// Transform coordinates from one CRS to another using PostGIS
export async function transformCoordinates(coordinates, fromSRID, toSRID, pool) {
    if (fromSRID === toSRID) {
        return coordinates;
    }

    try {
        // Create a temporary table to transform coordinates
        const transformedCoords = [];

        for (const ring of coordinates) {
            const transformedRing = [];
            for (const coord of ring) {
                const [x, y] = coord;
                // Use a more robust approach with explicit SRID casting
                const sql = `SELECT ST_X(ST_Transform(ST_SetSRID(ST_MakePoint($1, $2)::geometry, $3), $4)) as x, ST_Y(ST_Transform(ST_SetSRID(ST_MakePoint($1, $2)::geometry, $3), $4)) as y`;
                const result = await pool.query(sql, [x, y, fromSRID, toSRID]);
                const transformedCoord = [result.rows[0].x, result.rows[0].y];
                transformedRing.push(transformedCoord);
            }
            transformedCoords.push(transformedRing);
        }

        return transformedCoords;
    } catch (error) {
        console.error('Coordinate transformation failed:', error);
        // Fallback: return original coordinates if transformation fails
        return coordinates;
    }
}

// Query ArcGIS Feature Service to get object_id from geometry
export async function queryFeatureService(geometry, baseUrl, options = {}) {
    const params = new URLSearchParams();
    params.set('where', '1=1');
    params.set('outFields', 'OBJECTID');
    params.set('geometryType', 'esriGeometryPolygon');
    params.set('inSR', geometry.spatialReference?.wkid?.toString() || '4326');

    // Use Intersects instead of Contains for better overlap detection
    params.set('spatialRel', options.spatialRel || 'esriSpatialRelIntersects');

    // Add tolerance for coordinate precision issues
    if (options.tolerance) {
        params.set('tolerance', options.tolerance.toString());
    }

    params.set('outSR', '4326');
    params.set('returnGeometry', 'false');
    params.set('f', 'json');
    params.set('geometry', JSON.stringify(geometry));

    const url = `${baseUrl}?${params.toString()}`;
    const response = await fetch(url, { headers: { 'Accept-Encoding': 'identity' } });
    if (!response.ok) {
        throw new Error(`Feature service request failed with HTTP ${response.status}`);
    }
    const json = await response.json();
    if (json.error) {
        const message = json.error?.message || 'Unknown ArcGIS error';
        const details = Array.isArray(json.error?.details) && json.error.details.length
            ? ` Details: ${json.error.details.join(' ')}`
            : '';
        throw new Error(`Feature service error: ${message}${details}`);
    }
    return Array.isArray(json.features) ? json.features : [];
}

// Union of existing road parcels inside a (required) EPSG:3765 bbox. There is deliberately no
// "whole city" mode: unioning every road parcel city-wide held a pooled client for the length of a
// city-sized ST_UnaryUnion on any anonymous GET.
export async function getExistingRoadUnion(client, bboxParts) {
    if (!Array.isArray(bboxParts) || bboxParts.length !== 4) {
        throw new Error('getExistingRoadUnion requires a bbox [minX, minY, maxX, maxY].');
    }
    const params = [...bboxParts];

    // Primary source: road_parcel_classification materialized view (scoring-based)
    const sql = `
        SELECT ST_AsBinary(ST_UnaryUnion(ST_Collect(r.geom))) AS geom
        FROM road_parcel_classification r
        WHERE r.classification = 'road'
          AND r.geom IS NOT NULL
          AND r.geom && ST_MakeEnvelope($1,$2,$3,$4, ${POSTGIS_SRID})
    `;

    try {
        const { rows } = await client.query(sql, params);
        const geom = rows?.[0]?.geom || null;
        if (geom) return geom;
    } catch (err) {
        // If the materialized view doesn't exist yet, fall back to DGU road usage directly
        if (err?.code === '42P01') {
            console.warn('road_parcel_classification view not found, trying dgu_road_usage fallback');
        } else {
            throw err;
        }
    }

    // Fallback: DGU road usage polygons directly (works before the view is created)
    const fallbackSql = `
        SELECT ST_AsBinary(ST_UnaryUnion(ST_Collect(d.geom))) AS geom
        FROM dgu_road_usage d
        WHERE d.current = true
          AND d.geom IS NOT NULL
          AND d.geom && ST_MakeEnvelope($1,$2,$3,$4, ${POSTGIS_SRID})
    `;

    try {
        const { rows } = await client.query(fallbackSql, params);
        return rows?.[0]?.geom || null;
    } catch (err) {
        if (err?.code === '42P01') {
            console.warn('dgu_road_usage table not found either, no existing road data available');
            return null;
        }
        throw err;
    }
}
