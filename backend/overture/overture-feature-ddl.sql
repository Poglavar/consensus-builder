-- DDL for overture_feature: ONE table holding every Overture-derived feature layer for every city,
-- used as the generic 3D source for cities without a bespoke local model. The `layer` column
-- discriminates the layer ('buildings', 'trees', and future 'parks'/'water'/…); adding a layer needs
-- no new table, and the whole dataset is a single table to copy from a local ingest to prod (prod has
-- no DuckDB). `height_m`/`num_floors` are promoted for the building render hot path; anything else a
-- future layer needs goes in `properties` (jsonb) without a migration.

CREATE TABLE IF NOT EXISTS overture_feature (
    city              TEXT NOT NULL,                     -- CityConfigManager id, e.g. 'belgrade'
    layer             TEXT NOT NULL,                     -- 'buildings' | 'trees' | (future) 'parks' | 'water'
    overture_id       TEXT NOT NULL,                     -- stable Overture feature id (GERS)
    geom              GEOMETRY(Geometry, 4326) NOT NULL, -- footprint polygon / tree point / etc. (lng/lat)
    height_m          DOUBLE PRECISION,                  -- promoted building attr (nullable)
    num_floors        INTEGER,                           -- promoted building attr (nullable)
    properties        JSONB,                             -- any other per-layer attrs, future-proof
    overture_release  TEXT,                              -- Overture release the row came from

    created_at        TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at        TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (city, layer, overture_id)
);

-- Spatial index drives every provider's ST_DWithin radius query and the <-> nearest ordering. The
-- KNN <-> scan walks nearest-first and stops at the LIMIT, so it stays fast even though all layers
-- share one table (the city+layer filter is applied as it walks).
CREATE INDEX IF NOT EXISTS overture_feature_geom_idx ON overture_feature USING GIST (geom);
-- City+layer narrowing for the providers' WHERE clause and the /decor/layers discovery query.
CREATE INDEX IF NOT EXISTS overture_feature_city_layer_idx ON overture_feature (city, layer);
