// Zagreb 3D building provider. Source: the `building_3d` table (LOD2 MultiPolygonZ meshes in
// EPSG:3765) — the same city model the Zagreb codechecker uses. The heavy per-mesh work (dump into
// faces, reproject 3765→4326, serialize to GeoJSON) is PRECOMPUTED once into columns, since the
// dataset is static (captured 2022, never changes):
//   faces_4326  jsonb                        — the face polygons already in EPSG:4326 (precision 7)
//   z_min, z_max real                        — vertical extent
//   geom2d_3765 geometry(Geometry,3765)      — 2D footprint for the spatial filter (GiST-indexed)
// So a query is just "spatial filter + read JSONB" — no ST_Dump/ST_Transform/ST_AsGeoJSON at request
// time. This took /buildings/near from ~11s to ~60ms. See db/precompute-building-3d-faces.sql.

export function createZagrebProvider(pool) {
    async function near(geometry, bufferMeters) {
        const sql = `
            WITH q AS (
                SELECT ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON($1), 4326), 3765) AS g
            )
            SELECT b.object_id, b.z_min, b.z_max, b.faces_4326 AS faces
            FROM building_3d b, q
            WHERE ST_DWithin(b.geom2d_3765, q.g, $2)
            ORDER BY b.geom2d_3765 <-> q.g
            LIMIT 4000
        `;

        const { rows } = await pool.query(sql, [JSON.stringify(geometry), bufferMeters]);
        const buildings = rows.map(row => ({
            object_id: row.object_id,
            z_min: row.z_min,
            z_max: row.z_max,
            faces: row.faces || []
        }));
        return { buildings, count: buildings.length, source: 'zagreb-3d' };
    }

    return { near };
}
