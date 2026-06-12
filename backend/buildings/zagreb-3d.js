// Zagreb 3D building provider. Source: the `building_3d` table (LOD2 MultiPolygonZ meshes in
// EPSG:3765) — the same city model the Zagreb codechecker uses. Each mesh is decomposed into
// its flat polygon faces and returned in EPSG:4326 with Z preserved in metres, the common
// face-mesh shape every city's provider yields.

export function createZagrebProvider(pool) {
    async function near(geometry, bufferMeters) {
        const sql = `
            WITH q AS (
                SELECT ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON($1), 4326), 3765) AS g
            ),
            candidates AS (
                SELECT b.object_id, b.shape, ST_ZMin(b.shape) AS z_min, ST_ZMax(b.shape) AS z_max
                FROM building_3d b, q
                WHERE ST_DWithin(b.shape, q.g, $2)
                LIMIT 500
            ),
            faces AS (
                SELECT
                    c.object_id,
                    c.z_min,
                    c.z_max,
                    ST_AsGeoJSON(ST_Transform((ST_Dump(c.shape)).geom, 4326), 7)::jsonb AS face
                FROM candidates c
            )
            SELECT object_id, z_min, z_max, jsonb_agg(face) AS faces
            FROM faces
            GROUP BY object_id, z_min, z_max
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
