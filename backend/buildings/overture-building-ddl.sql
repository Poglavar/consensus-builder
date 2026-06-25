-- DDL for overture_building: per-city building footprints + heights pulled from the Overture Maps
-- `buildings` theme, used as the generic 3D source for cities without a bespoke local model.
-- One row per Overture building; the provider (buildings/overture-3d.js) extrudes the footprint to
-- a flat-top LOD1 block using height_m (or a floors/default fallback). Re-ingestion upserts on
-- (city, overture_id), so a city can be refreshed to a newer Overture release in place.

CREATE TABLE IF NOT EXISTS overture_building (
    city              TEXT NOT NULL,                 -- CityConfigManager id, e.g. 'belgrade'
    overture_id       TEXT NOT NULL,                 -- stable Overture feature id (GERS)
    geom              GEOMETRY(Geometry, 4326) NOT NULL, -- footprint Polygon/MultiPolygon (lng/lat)
    height_m          DOUBLE PRECISION,              -- measured roof height in metres, if Overture has one
    num_floors        INTEGER,                       -- storey count, if known (drives height fallback)
    overture_release  TEXT,                          -- Overture release the row came from, e.g. '2026-06-17.0'

    created_at        TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at        TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (city, overture_id)
);

-- Spatial index drives the provider's ST_DWithin radius query and the <-> nearest ordering.
CREATE INDEX IF NOT EXISTS overture_building_geom_idx ON overture_building USING GIST (geom);
-- City filter precedes the spatial test in the provider's WHERE clause.
CREATE INDEX IF NOT EXISTS overture_building_city_idx ON overture_building (city);
