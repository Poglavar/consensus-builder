// Shared helper functions for the backend

export const POSTGIS_SRID = 3765;

// ArcGIS API configuration
export const ARCGIS_BASE_URL = 'https://services8.arcgis.com/Usi0jGQwMmBUpFjr/arcgis/rest/services/ZG3D_2022_3d_model_GZ/FeatureServer/0/query';

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

export async function getExistingRoadUnion(client, bboxParts) {
    const hasBbox = Array.isArray(bboxParts) && bboxParts.length === 4;
    const params = hasBbox ? [...bboxParts, true] : [0, 0, 0, 0, false];

    // Primary source: road_parcel_classification materialized view (scoring-based)
    const sql = `
        SELECT ST_AsBinary(ST_UnaryUnion(ST_Collect(r.geom))) AS geom
        FROM road_parcel_classification r
        WHERE r.classification = 'road'
          AND r.geom IS NOT NULL
          AND (NOT $5::boolean OR r.geom && ST_MakeEnvelope($1,$2,$3,$4, ${POSTGIS_SRID}))
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
          AND (NOT $5::boolean OR d.geom && ST_MakeEnvelope($1,$2,$3,$4, ${POSTGIS_SRID}))
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
