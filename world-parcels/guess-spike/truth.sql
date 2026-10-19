-- Evaluation holdout only. This file must never be passed to guess.py.
WITH bounds AS (
  SELECT ST_MakeEnvelope(:'tile_x'::integer * 153.6, :'tile_y'::integer * 153.6,
    (:'tile_x'::integer + 1) * 153.6, (:'tile_y'::integer + 1) * 153.6, 3765) AS geom
), features AS (
  SELECT p.cestica_id AS source_id,
    json_build_object('type','Feature','geometry',ST_AsGeoJSON(ST_Intersection(p.geom,b.geom))::json,
    'properties',json_build_object('cestica_id',p.cestica_id)) AS feature
  FROM parcel p, bounds b
  WHERE p.current AND p.geom && b.geom AND ST_Intersects(p.geom,b.geom)
    AND ST_Area(ST_Intersection(p.geom,b.geom)) > 0.1
)
SELECT json_build_object('type','FeatureCollection',
  'features',(SELECT coalesce(json_agg(feature ORDER BY source_id),'[]'::json) FROM features)) FROM bounds;
