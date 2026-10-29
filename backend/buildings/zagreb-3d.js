// Zagreb 3D building provider. Source: the `gdi_building_3d` table (LOD2 MultiPolygonZ meshes in
// EPSG:3765) — the same city model the Zagreb codechecker uses. Its `object_id` is the same key as
// `gdi_building_footprint` (the 2D footprint of the SAME GDI feature, 1:1), which is what the map
// serves and what cut/tunnel/demolish detection scans — so a demolition record names a mesh here
// exactly, by id. The heavy per-mesh work (dump into faces, reproject 3765→4326, serialize to
// GeoJSON) is PRECOMPUTED once into columns, since the dataset is static (captured 2022):
//   faces_4326  jsonb                        — the face polygons already in EPSG:4326 (precision 7)
//   z_min, z_max real                        — vertical extent
//   geom2d_3765 geometry(Geometry,3765)      — 2D footprint for the spatial filter (GiST-indexed)
// So a query is just "spatial filter + read JSONB" — no ST_Dump/ST_Transform/ST_AsGeoJSON at request
// time. This took /buildings/near from ~11s to ~60ms. See backend/buildings/building-3d-precompute.sql.

export function createZagrebProvider(pool) {
    async function near(geometry, bufferMeters) {
        const sql = `
            WITH q AS (
                SELECT ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON($1), 4326), 3765) AS g
            )
            SELECT b.object_id, b.z_min, b.z_max, b.faces_4326 AS faces
            FROM gdi_building_3d b, q
            WHERE ST_DWithin(b.geom2d_3765, q.g, $2)
            ORDER BY b.geom2d_3765 <-> q.g
            LIMIT 4001
        `;

        const { rows: found } = await pool.query(sql, [JSON.stringify(geometry), bufferMeters]);
        // One row past the cap says the area holds more than 4,000: the answer is truncated, so a
        // cell reader splits the cell (split-read.js) instead of drawing the nearest 4,000.
        const truncated = found.length > 4000;
        const rows = truncated ? found.slice(0, 4000) : found;
        const buildings = rows.map(row => ({
            object_id: row.object_id,
            z_min: row.z_min,
            z_max: row.z_max,
            faces: row.faces || []
        }));
        return { buildings, count: buildings.length, source: 'zagreb-3d', ...(truncated ? { truncated: true } : {}) };
    }

    // 2D footprints (with measured heights) of existing buildings mostly inside a GeoJSON polygon.
    // Backs the urban-rule "based on existing buildings" mode, which reasons about the LEGAL
    // building stock — so this one deliberately stays on the CADASTRE (`dgu_building`, zgrada_id),
    // unlike the map/detection/3D path, which works with GDI objects.
    //
    // Ridge height comes from the matched GDI object. It is a property of the GDI OBJECT, so it
    // lives on `gdi_building` — the hop is dgu_building → dgu_gdi_building_match → gdi_building.
    // (It used to sit on the match table itself, duplicated up to 164x per object; the rename
    // migration moved it. Reading it off the match table now only works through a compat view.)
    // Height is null when no GDI match exists or the value is implausible (outside 2..250 m).
    // Floors are unknown for Zagreb, always null.
    // "Mostly inside" = >=50% of the footprint area, so neighbours merely touching the parcel
    // boundary don't get swept into "raise all existing buildings" proposals.
    async function footprints(geometry) {
        const sql = `
            WITH q AS (
                SELECT ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON($1), 4326), 3765) AS g
            )
            SELECT b.zgrada_id AS id,
                   CASE WHEN g.height_m BETWEEN 2 AND 250 THEN g.height_m::float END AS height_m,
                   ST_AsGeoJSON(ST_Transform(b.geom, 4326), 7)::json AS geometry
            FROM dgu_building b
            JOIN q ON ST_Intersects(b.geom, q.g)
            LEFT JOIN dgu_gdi_building_match m ON m.zgrada_id = b.zgrada_id
            LEFT JOIN gdi_building g ON g.object_id = m.object_id
            WHERE b.current
              -- Ratio, so the projection cancels: this compares an area with an area in the
              -- same CRS and never leaves the server as an absolute m². Areas that DO reach a
              -- client are measured geodesically (WGS84), the same way the browser measures.
              AND ST_Area(ST_Intersection(b.geom, q.g)) >= 0.5 * ST_Area(b.geom)
            ORDER BY b.zgrada_id
            LIMIT 500
        `;

        const { rows } = await pool.query(sql, [JSON.stringify(geometry)]);
        const footprints = rows.map(row => ({
            id: row.id,
            geometry: row.geometry,
            height_m: row.height_m,
            floors: null
        }));
        return { footprints, count: footprints.length, source: 'zagreb-cadastre' };
    }

    // Demolition follows the observed GDI objects rendered by near(), not the legal-cadastre
    // stock used by footprints(). Include every intersection, even a sliver of a building.
    async function footprintsUnder(regions) {
        const byKey = new Map(regions.map(region => [String(region.key), []]));
        const { rows } = await pool.query(`
            WITH regions AS (
                SELECT r.key, ST_CollectionExtract(ST_MakeValid(ST_Transform(
                    ST_SetSRID(ST_GeomFromGeoJSON(r.geometry::text), 4326), 3765)), 3) AS geom
                FROM jsonb_to_recordset($1::jsonb) AS r(key text, geometry jsonb)
            )
            -- The same height rule as footprints above: a plausible survey height, as a number
            -- (numeric comes back from pg as a string, which every consumer reads as no height).
            SELECT r.key, f.object_id AS id,
                   CASE WHEN g.height_m BETWEEN 2 AND 250 THEN g.height_m::float END AS height_m,
                   ST_AsGeoJSON(ST_Transform(v.geom, 4326), 7)::json AS geometry
            FROM regions r
            JOIN gdi_building_footprint f ON f.geom && r.geom
            CROSS JOIN LATERAL (
                SELECT ST_CollectionExtract(ST_MakeValid(f.geom), 3) AS geom
            ) v
            LEFT JOIN gdi_building g ON g.object_id = f.object_id
            WHERE ST_Intersects(v.geom, r.geom)
            ORDER BY r.key, f.object_id
            LIMIT 4001
        `, [JSON.stringify(regions)]);
        const truncated = rows.length > 4000;
        if (!truncated) for (const row of rows) {
            byKey.get(String(row.key)).push({ id: row.id, geometry: row.geometry,
                height_m: row.height_m ?? null, floors: null });
        }
        return { regions: byKey, truncated, source: 'gdi' };
    }

    return { near, footprints, footprintsUnder };
}
