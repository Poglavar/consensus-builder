-- DDL for overture_tree: per-city individual trees from the Overture Maps base/land theme
-- (subtype/class = tree), used as toggleable 3D scenery for cities without a bespoke local source.
-- One row per tree POINT; the renderer places an instanced trunk+crown and assigns a deterministic
-- per-tree height (Overture carries no tree height). Re-ingestion upserts on (city, overture_id).

CREATE TABLE IF NOT EXISTS overture_tree (
    city              TEXT NOT NULL,                  -- CityConfigManager id, e.g. 'belgrade'
    overture_id       TEXT NOT NULL,                  -- stable Overture feature id (GERS)
    geom              GEOMETRY(Point, 4326) NOT NULL, -- tree location (lng/lat)
    overture_release  TEXT,                           -- Overture release the row came from

    created_at        TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at        TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (city, overture_id)
);

-- Spatial index drives the provider's ST_DWithin radius query and the <-> nearest ordering.
CREATE INDEX IF NOT EXISTS overture_tree_geom_idx ON overture_tree USING GIST (geom);
-- City filter precedes the spatial test in the provider's WHERE clause.
CREATE INDEX IF NOT EXISTS overture_tree_city_idx ON overture_tree (city);
