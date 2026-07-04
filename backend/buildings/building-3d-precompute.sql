-- Precompute the expensive per-request geometry work for the Zagreb 3D building model.
--
-- building_3d stores LOD2 meshes as MultiPolygonZ in EPSG:3765. /buildings/near used to, per request,
-- ST_Dump each mesh into faces, ST_Transform them 3765->4326, and ST_AsGeoJSON-serialize each face —
-- ~11s per query. The dataset is static (captured 2022), so we do that work ONCE here and store it.
-- The endpoint then just spatial-filters and reads the precomputed JSONB (~60ms). See zagreb-3d.js.
--
-- Safe/resumable: columns + index use IF NOT EXISTS; the backfill only touches rows not yet done and
-- commits in batches (so it never holds a giant transaction / bloats the table). Requires PG11+ for
-- procedure-level COMMIT (prod & local are PG17).
--
-- Apply on prod BEFORE deploying the new zagreb-3d.js query (which reads these columns).

ALTER TABLE building_3d
  ADD COLUMN IF NOT EXISTS z_min real,
  ADD COLUMN IF NOT EXISTS z_max real,
  ADD COLUMN IF NOT EXISTS faces_4326 jsonb,
  ADD COLUMN IF NOT EXISTS geom2d_3765 geometry(Geometry, 3765);

-- Batched backfill. Each iteration processes 2000 buildings and commits, so progress is durable and
-- the table doesn't accumulate one enormous transaction's worth of dead tuples.
CREATE OR REPLACE PROCEDURE backfill_building_3d_faces()
LANGUAGE plpgsql AS $$
DECLARE
    n integer;
    done integer := 0;
BEGIN
    LOOP
        WITH batch AS (
            SELECT object_id FROM building_3d WHERE faces_4326 IS NULL LIMIT 2000
        ),
        faces AS (
            SELECT object_id, (ST_Dump(shape)).geom AS geom
            FROM building_3d
            WHERE object_id IN (SELECT object_id FROM batch)
        ),
        agg AS (
            SELECT object_id, jsonb_agg(ST_AsGeoJSON(ST_Transform(geom, 4326), 7)::jsonb) AS faces
            FROM faces GROUP BY object_id
        )
        UPDATE building_3d b SET
            z_min = ST_ZMin(b.shape),
            z_max = ST_ZMax(b.shape),
            geom2d_3765 = ST_Force2D(b.shape),
            faces_4326 = a.faces
        FROM agg a
        WHERE b.object_id = a.object_id;

        GET DIAGNOSTICS n = ROW_COUNT;
        EXIT WHEN n = 0;
        done := done + n;
        COMMIT;
        RAISE NOTICE 'building_3d faces backfilled: % total', done;
    END LOOP;
END $$;

CALL backfill_building_3d_faces();

-- GiST index on the 2D footprint drives the /buildings/near spatial filter + KNN ordering.
CREATE INDEX IF NOT EXISTS idx_building_3d_geom2d ON building_3d USING gist (geom2d_3765);

ANALYZE building_3d;
