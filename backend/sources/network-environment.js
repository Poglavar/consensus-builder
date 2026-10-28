// Provider readers use the shared registration contract; HTTP validation and response policy stay
// with the routes. Dependencies are service-local closures, never public source configuration.
import { createRequire } from 'node:module';
import { wgs84BboxFilterSql, POSTGIS_SRID, getExistingRoadUnion } from '../utils/helpers.js';
import { fetchOverpassRoads, fetchOverpassRoadsAndRailways } from '../roads/osm-road-overpass.js';
import { streetsNear } from '../streets/near.js';
import { fetchBlockRoads } from '../streets/block-roads.js';
import { createOvertureTreesProvider } from '../decor/overture-trees.js';
import { createWaterProvider } from '../decor/openfreemap-water.js';
const require = createRequire(import.meta.url);
const SourceRuntime = require('../../frontend/js/source-runtime.js');

export const NETWORK_ENVIRONMENT_SOURCES = Object.freeze({
    roads: 'osm-road', frontage: 'osm-frontage', blocks: 'osm-block-roads',
    streets: 'street-register', planned: 'government-road-plan', classifications: 'classified-road-parcels',
    trees: 'overture-trees', water: 'openfreemap-water'
});

function registry(abstraction, adapter, id, config, create, required, { custom = false } = {}) {
    return SourceRuntime.createRegistry({ abstraction,
        adapters: { [adapter]: { create, custom,
            validateConfig(value) {
                if (Object.keys(value).length !== Object.keys(config).length
                    || Object.keys(config).some(key => JSON.stringify(value[key]) !== JSON.stringify(config[key]))) {
                    throw Object.assign(new Error('Unsupported source configuration.'), { status: 400, code: 'invalid-data-source' });
                }
            } } },
        sources: [SourceRuntime.source(abstraction, adapter, config, { id })], required });
}

export const MAX_FEATURES = 8000;
export const MAX_PLANNED_ROAD_FEATURES = 5000;
export const MIN_PLAN_PIECE_M2 = 5;
export const MAX_ROAD_PARCEL_IDS = 20000;

export function createRoadNetworkRegistry(pool, options = {}) {
    const liveRoads = options.fetchOverpassRoads || fetchOverpassRoads;
    const liveRoadsAndRailways = options.fetchOverpassRoadsAndRailways || fetchOverpassRoadsAndRailways;
    return registry('road-network', 'osm-road-network', NETWORK_ENVIRONMENT_SOURCES.roads,
        { resource: 'osm_road', fallback: 'overpass' }, () => ({
        async readNetwork(boxes, railways) {
            const hasBbox = Array.isArray(boxes);
            let sql = `
                SELECT
                    -- GeoJSON precision: 7 decimals of WGS84 degrees is about 1 cm; the default 9 only adds bytes.
                    ST_AsGeoJSON(r.geom, 7)::json AS geometry,
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

            return features;
        },
        readLiveNetwork(bbox, railways) { return (railways ? liveRoadsAndRailways : liveRoads)(bbox); }
    }), ['readNetwork', 'readLiveNetwork']);
}

export function createFrontageStreetRegistry(pool, options = {}) {
    return registry('frontage-streets', 'osm-street-frontage', NETWORK_ENVIRONMENT_SOURCES.frontage,
        { resource: 'osm_road', fallback: 'overpass', policy: 'frontage' },
        () => ({ near: bbox => streetsNear(pool, bbox, options) }), ['near']);
}

export function createBlockBarrierRegistry({ fetchRoads = fetchBlockRoads } = {}) {
    return registry('block-barriers', 'overpass-block-roads', NETWORK_ENVIRONMENT_SOURCES.blocks,
        { resource: 'overpass', policy: 'block-barriers' },
        () => ({ readBarriers: bbox => fetchRoads(bbox) }), ['readBarriers'], { custom: true });
}

export function createStreetRegisterRegistry(pool) {
    return registry('street-register', 'postgis-street-register', NETWORK_ENVIRONMENT_SOURCES.streets,
        { resource: 'street' }, () => ({ async readStreets(bboxParts) {
            const hasBbox = Array.isArray(bboxParts);
            let sql = `
                SELECT
                    -- GeoJSON precision: 7 decimals of WGS84 degrees is about 1 cm; the default 9 only adds bytes.
                    ST_AsGeoJSON(ST_Transform(s.geom, 4326), 7)::json AS geometry,
                    (to_jsonb(s) - 'geom') AS properties
                FROM street s
                WHERE s.geom IS NOT NULL
            `;

            const params = [];
            if (hasBbox) {
                sql += ` AND s.geom && ST_MakeEnvelope($1,$2,$3,$4, ${POSTGIS_SRID})`;
                params.push(bboxParts[0], bboxParts[1], bboxParts[2], bboxParts[3]);
            }

            sql += '\n            LIMIT 5000\n        ';

            const { rows } = await pool.query(sql, params);
            const features = rows.map(row => ({
                type: 'Feature',
                properties: row.properties || {},
                geometry: row.geometry
            }));

            return { type: 'FeatureCollection', features };
    } }), ['readStreets']);
}

export function createPlannedRoadRegistry() {
    return registry('planned-roads', 'postgis-road-reservations', NETWORK_ENVIRONMENT_SOURCES.planned,
        { resource: 'government-road-reservations' }, (_config, { client }) => ({ async readReservations(bboxParts) {
            const existingRoadUnion = await getExistingRoadUnion(client, bboxParts);

            const sql = `
                WITH envelope AS (
                    SELECT ST_MakeEnvelope($1,$2,$3,$4, ${POSTGIS_SRID}) AS geom
                ),
                existing_roads AS (
                    SELECT CASE
                        WHEN $5::bytea IS NULL THEN NULL::geometry
                        ELSE ST_SetSRID(ST_GeomFromWKB($5::bytea), ${POSTGIS_SRID})
                    END AS geom
                ),
                -- The GUP's road land in view (Zagreb GUP, PrometGUP layers 3-6 and 10, built into
                -- road_widening_segment by cadastre-data street-expansion-viewer/build-widening-data.js):
                -- widening: each measured street's reservation, the corridor between the drawn
                --   reservation lines where both sides are drawn, else the čl. 38 target profile
                --   around its axis (only where the street is narrower than the target);
                -- new_street: the stretches of the GUP street network with no measured street within
                --   30 m (streets the plan adds), as a corridor of the category's čl. 38 width.
                widening AS (
                    SELECT 'widening'::text AS kind, s.street_name AS label, s.regime, s.category, s.target_m,
                           ST_Transform(COALESCE(s.drawn_corridor_geom, s.outline_geom), ${POSTGIS_SRID}) AS geom
                    FROM road_widening_segment s
                    WHERE COALESCE(s.drawn_corridor_geom, s.outline_geom) && ST_Transform((SELECT geom FROM envelope), 4326)
                ),
                measured_zone AS (
                    SELECT ST_Union(ST_Buffer(ST_Transform(s.geom, ${POSTGIS_SRID}), 30, 'quad_segs=2')) AS geom
                    FROM road_widening_segment s
                    WHERE s.geom && ST_Transform(ST_Expand((SELECT geom FROM envelope), 100), 4326)
                ),
                new_streets AS (
                    SELECT 'new_street'::text AS kind, l.label, 'osnovna'::text AS regime, l.layer_name AS category, t.target_m,
                           ST_Buffer(
                               ST_Difference(
                                   ST_Intersection(l.geom, ST_Expand((SELECT geom FROM envelope), 50)),
                                   COALESCE((SELECT geom FROM measured_zone), ST_SetSRID('GEOMETRYCOLLECTION EMPTY'::geometry, ${POSTGIS_SRID}))
                               ),
                               t.target_m / 2, 'endcap=flat join=round'
                           ) AS geom
                    FROM gup_street_line l
                    JOIN (VALUES ('gradska_ulica', 18), ('glavna_gradska_ulica', 26), ('gradska_avenija', 40), ('gradska_autocesta', 80))
                        AS t(layer_name, target_m) USING (layer_name)
                    WHERE l.current AND l.geom && ST_Expand((SELECT geom FROM envelope), 50)
                ),
                planned AS (
                    SELECT kind, label, regime, category, target_m,
                           ST_Intersection(ST_MakeValid(geom), (SELECT geom FROM envelope)) AS geom
                    FROM (SELECT * FROM widening UNION ALL SELECT * FROM new_streets) gup
                    WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom)
                ),
                prepared AS (
                    SELECT
                        kind,
                        label,
                        regime,
                        category,
                        target_m,
                        CASE
                            WHEN (SELECT geom FROM existing_roads) IS NULL THEN geom
                            ELSE ST_MakeValid(ST_Difference(geom, (SELECT geom FROM existing_roads)))
                        END AS geom
                    FROM planned
                ),
                exploded AS (
                    SELECT
                        kind,
                        label,
                        regime,
                        category,
                        target_m,
                        (ST_Dump(geom)).geom AS geom
                    FROM prepared
                ),
                filtered AS (
                    SELECT
                        kind,
                        label,
                        regime,
                        category,
                        target_m,
                        geom
                    FROM exploded
                    WHERE geom IS NOT NULL
                      AND NOT ST_IsEmpty(geom)
                      AND GeometryType(geom) IN ('POLYGON', 'MULTIPOLYGON')
                      AND ST_Area(geom) >= ${MIN_PLAN_PIECE_M2}
                )
                SELECT
                    jsonb_build_object(
                        'kind', kind,
                        'label', label,
                        'regime', regime,
                        'category', category,
                        'target_m', target_m
                    ) AS props,
                    -- GeoJSON precision: 2 decimals of EPSG:3765 metres is 1 cm; the default 9 only adds bytes.
                    ST_AsGeoJSON(geom, 2)::json AS geometry
                FROM filtered
                LIMIT $6;
            `;

            const params = [
                bboxParts[0],
                bboxParts[1],
                bboxParts[2],
                bboxParts[3],
                existingRoadUnion,
                MAX_PLANNED_ROAD_FEATURES + 1
            ];

            const { rows: fetchedRows } = await client.query(sql, params);
            return fetchedRows;
    } }), ['readReservations']);
}

export function createRoadClassificationRegistry() {
    return registry('road-classification', 'postgis-road-classification', NETWORK_ENVIRONMENT_SOURCES.classifications,
        { resource: 'road_parcel_classification' }, (_config, { client }) => ({ async readIds(bbox) {
            const sql = `
                WITH envelope AS (
                    SELECT ST_Transform(
                        ST_MakeEnvelope($1, $2, $3, $4, 4326),
                        ${POSTGIS_SRID}
                    ) AS geom
                )
                -- parcelId matches the id the frontend's /parcels features carry, so the client
                -- marks road parcels by id instead of geometry matching.
                SELECT 'HR-' || p.maticni_broj_ko || '-' || p.broj_cestice AS parcel_id
                FROM road_parcel_classification rpc
                JOIN parcel p ON p.cestica_id = rpc.cestica_id AND p.current = true
                CROSS JOIN envelope e
                WHERE rpc.classification = 'road'
                  AND rpc.geom IS NOT NULL
                  AND rpc.geom && e.geom
                LIMIT $5
            `;

            const { rows: fetched } = await client.query(sql, [...bbox, MAX_ROAD_PARCEL_IDS + 1]);
            return fetched;
    } }), ['readIds']);
}

export function createDecorSources(pool, { waterProvider = createWaterProvider() } = {}) {
    const treesProvider = createOvertureTreesProvider(pool);
    const trees = registry('trees', 'osm-decor-trees', NETWORK_ENVIRONMENT_SOURCES.trees,
        { resource: 'osm_decor', kinds: ['trees', 'greenery'] }, () => ({
            near: (...args) => treesProvider.near(...args),
            async layers(bbox, kinds) {
                const { rows } = await pool.query(
                    `SELECT k AS kind FROM unnest($5::text[]) AS k
                     WHERE EXISTS (SELECT 1 FROM osm_decor d
                                   WHERE d.kind = k AND d.geom && ST_MakeEnvelope($1, $2, $3, $4, 4326))`,
                    [...bbox, kinds]
                );
                return rows.map(row => row.kind);
            }
        }), ['near', 'layers']);
    const water = registry('water', 'openfreemap-water', NETWORK_ENVIRONMENT_SOURCES.water,
        { tilejson: 'https://tiles.openfreemap.org/planet' }, () => waterProvider, ['near'], { custom: true });
    return { trees, water };
}
