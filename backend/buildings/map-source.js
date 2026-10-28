import { createRequire } from 'node:module';
import { databaseSourceError, isDatabaseSourceError } from '../parcels/database-source-error.js';
const SourceRuntime = createRequire(import.meta.url)('../../frontend/js/source-runtime.js');

// The bbox layer caps how many footprints one request may return. A request that HITS the cap was
// truncated — it does not cover its bbox, and the caller must be told, because a building that
// never loaded can never be detected and so can never be demolished (see corridor-tunnel.js).
const BUILDING_BBOX_LIMIT = 4000;

// Buildings mostly (>= 90 %) inside one parcel. gdi_building_footprint holds invalid rings (344 on
// prod, 2026-09, e.g. "Hole lies outside shell"), and ST_Intersection on those throws a GEOS
// TopologyException that 500'd the whole request. Area math therefore runs on ST_MakeValid'd
// polygons (CollectionExtract drops the line/point debris MakeValid can emit, which would also
// make ST_Intersection reject a GeometryCollection), while the join keeps the RAW geoms so the
// GiST index still drives it. NULLIF guards the ratio against a zero-area footprint.
// Areas are geodesic: footprint_area is returned as an absolute m², measured the way the browser
// measures (WGS84 ellipsoid via turf), not in projected metres.
export const PARCEL_BUILDINGS_SQL = `
    SELECT
        bf.object_id,
        bf.metadata,
        bf.source,
        -- GeoJSON precision: 2 decimals of EPSG:3765 metres is 1 cm; the default 9 only adds bytes.
        ST_AsGeoJSON(bf.geom, 2)::json AS geometry,
        a.footprint_area,
        a.intersection_area,
        a.intersection_area / NULLIF(a.footprint_area, 0) AS containment_ratio,
        p.cestica_id,
        p.broj_cestice
    FROM parcel p
    JOIN gdi_building_footprint bf
      ON bf.geom && p.geom
     AND ST_Intersects(p.geom, bf.geom)
    CROSS JOIN LATERAL (
        SELECT ST_CollectionExtract(ST_MakeValid(p.geom), 3) AS parcel_geom,
               ST_CollectionExtract(ST_MakeValid(bf.geom), 3) AS building_geom
    ) v
    CROSS JOIN LATERAL (
        SELECT ST_Area(ST_Transform(v.building_geom, 4326)::geography) AS footprint_area,
               ST_Area(ST_Transform(ST_Intersection(v.parcel_geom, v.building_geom), 4326)::geography) AS intersection_area
    ) a
    WHERE p.cestica_id = $1
      AND p.current
      AND a.intersection_area / NULLIF(a.footprint_area, 0) >= 0.9
    ORDER BY containment_ratio DESC, bf.object_id
`;

async function lookup(pool, query) {
        try {
            const cesticaId = query.cestica_id;
            const bbox = String(query.bbox || '').trim();
            const parts = bbox.split(',').map(n => Number(n));
            const source = String(query.source || 'gdi').trim().toLowerCase();

            if (bbox && (parts.length !== 4 || parts.some(v => !isFinite(v)))) {
                throw databaseSourceError(400, { error: 'Invalid bbox. Expected minX,minY,maxX,maxY in EPSG:3765.' });
            }
            if (source !== 'gdi' && source !== 'dgu') {
                throw databaseSourceError(400, { error: `Unknown source '${source}'. Expected 'gdi' or 'dgu'.` });
            }

            if (cesticaId !== undefined && !/^\d{1,18}$/.test(String(cesticaId))) {
                throw databaseSourceError(400, { error: 'Invalid cestica_id. Expected a numeric parcel id.' });
            }

            if (cesticaId) {
                // Buildings inside a parcel: GDI footprints, the working set.
                const { rows } = await pool.query(PARCEL_BUILDINGS_SQL, [cesticaId]);

                // Explicit columns only: `bf.*` used to ship the raw hex `geom` alongside the
                // GeoJSON, and `row.CESTICA_ID` (pg lowercases unquoted names) spread undefined
                // over the real cestica_id.
                const features = rows.map(row => ({
                    type: 'Feature',
                    properties: {
                        object_id: row.object_id,
                        metadata: row.metadata,
                        source: row.source,
                        footprint_area: row.footprint_area,
                        intersection_area: row.intersection_area,
                        containment_ratio: row.containment_ratio,
                        cestica_id: row.cestica_id,
                        broj_cestice: row.broj_cestice
                    },
                    geometry: row.geometry
                }));

                return {
                    type: 'FeatureCollection',
                    features,
                    cestica_id: cesticaId,
                    count: features.length
                };
            } else {
                if (!bbox) {
                    throw databaseSourceError(400, { error: 'Invalid bbox. Expected minX,minY,maxX,maxY in EPSG:3765.' });
                }
                const [minX, minY, maxX, maxY] = parts;

                // GDI (default): the objects we actually work with. `object_id` is the id every
                // demolition record is keyed by, so it must be in the properties.
                // DGU: the cadastre reference layer, keyed by zgrada_id, current rows only.
                const sql = source === 'dgu'
                    ? `
                        SELECT
                            -- GeoJSON precision: 2 decimals of EPSG:3765 metres is 1 cm; the default 9 only adds bytes.
                            ST_AsGeoJSON(b.geom, 2)::json AS geometry,
                            (to_jsonb(b) - 'geom' - 'bbox') AS properties
                        FROM dgu_building b
                        WHERE b.current
                          AND b.geom && ST_MakeEnvelope($1,$2,$3,$4, 3765)
                          AND ST_Intersects(b.geom, ST_MakeEnvelope($1,$2,$3,$4, 3765))
                        LIMIT ${BUILDING_BBOX_LIMIT}
                      `
                    : `
                        SELECT
                            -- GeoJSON precision: 2 decimals of EPSG:3765 metres is 1 cm; the default 9 only adds bytes.
                            ST_AsGeoJSON(f.geom, 2)::json AS geometry,
                            jsonb_build_object(
                                'object_id',     f.object_id,
                                'area_m2',       g.area_m2,
                                'height_m',      g.height_m,
                                'eave_height_m', g.eave_height_m,
                                'survey_year',   g.survey_year
                            ) AS properties
                        FROM gdi_building_footprint f
                        LEFT JOIN gdi_building g ON g.object_id = f.object_id
                        WHERE f.geom && ST_MakeEnvelope($1,$2,$3,$4, 3765)
                          AND ST_Intersects(f.geom, ST_MakeEnvelope($1,$2,$3,$4, 3765))
                        LIMIT ${BUILDING_BBOX_LIMIT}
                      `;

                const { rows } = await pool.query(sql, [minX, minY, maxX, maxY]);

                const features = rows.map(row => ({
                    type: 'Feature',
                    properties: row.properties || {},
                    geometry: row.geometry
                }));

                return {
                    type: 'FeatureCollection',
                    features,
                    source,
                    truncated: features.length >= BUILDING_BBOX_LIMIT
                };
            }
        } catch (err) {
            if (isDatabaseSourceError(err)) throw err;
            console.error('Error in /buildings:', err);
            throw databaseSourceError(500, { error: 'Internal server error' });
        }

}

export const buildingMapSourceRegistry = SourceRuntime.createRegistry({
    abstraction: 'buildings',
    adapters: {
        'gdi-map': { custom: false, create: (config, { pool }) => ({ lookup: query => lookup(pool, { ...query, source: config.id }) }) },
        'dgu-map': { custom: false, create: (config, { pool }) => ({ lookup: query => lookup(pool, { ...query, source: config.id }) }) }
    },
    sources: [
        SourceRuntime.source('buildings', 'gdi-map', { id: 'gdi', storage: 'gdi_building_footprint' }),
        SourceRuntime.source('buildings', 'dgu-map', { id: 'dgu', storage: 'dgu_building' })
    ],
    required: ['lookup']
});
export function buildingMapLookup(pool, query) {
    const source = String(query.source || 'gdi').trim().toLowerCase();
    // Invalid selections still use the native validator, including its bbox-first error order.
    if (source !== 'gdi' && source !== 'dgu') return lookup(pool, query);
    return buildingMapSourceRegistry.open(source, { pool }).lookup(query);
}
import { fetchOsmBuildings } from './osm-reference.js';
import { fetchStagedOsmBuildings } from './osm-staged.js';

export const osmReferenceSourceRegistry = SourceRuntime.createRegistry({
    abstraction: 'buildings', required: ['fetchBbox'],
    adapters: { 'osm-reference': { custom: false, create: (_config, {
        pool, staged = fetchStagedOsmBuildings, live = fetchOsmBuildings
    }) => ({ async fetchBbox(bbox) {
        const cached = await staged(pool, bbox).catch(err => {
            console.warn('[buildings/osm] staged lookup failed, falling back to Overpass:', err.message);
            return null;
        });
        return cached || await live(bbox);
    } }) } },
    sources: [SourceRuntime.source('buildings', 'osm-reference', {
        id: 'osm-reference', storage: 'osm_building', fallback: 'overpass'
    })]
});
