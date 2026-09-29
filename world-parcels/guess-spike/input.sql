-- EPSG:3765 input only. Deliberately does not access the parcel table.
WITH bounds AS (
  SELECT ST_MakeEnvelope(:'tile_x'::integer * 153.6, :'tile_y'::integer * 153.6,
    (:'tile_x'::integer + 1) * 153.6, (:'tile_y'::integer + 1) * 153.6, 3765) AS geom
), buildings AS (
  SELECT ob.osm_id AS source_id,
    json_build_object('type','Feature','geometry',ST_AsGeoJSON(ST_Transform(ob.geom,3765))::json,
    'properties',json_build_object('osm_id',ob.osm_id,'source','Overture/OSM')) AS feature
  FROM overture_building_footprint ob, bounds b
  WHERE ob.osm_id IS NOT NULL AND ob.geom && ST_Transform(b.geom,4326)
    AND ST_Intersects(ob.geom,ST_Transform(b.geom,4326))
), roads AS (
  SELECT r.osm_id AS source_id,
    json_build_object('type','Feature','geometry',ST_AsGeoJSON(ST_Intersection(r.geom_3765,b.geom))::json,
    'properties',json_build_object('osm_id',r.osm_id,'highway',r.highway_type,
      'width_meters',r.width_meters,'source','OpenStreetMap')) AS feature
  FROM osm_road r, bounds b
  WHERE r.current AND r.highway_type IS NOT NULL AND r.geom_3765 && b.geom
    AND ST_Intersects(r.geom_3765,b.geom)
), water AS (
  SELECT w.id AS source_id, json_build_object('type','Feature',
    'geometry',ST_AsGeoJSON(ST_Transform(ST_Intersection(w.geom,ST_Transform(b.geom,4326)),3765))::json,
    'properties',json_build_object('id',w.id,'class',w.class,'source','Overture')) AS feature
  FROM overture_water w, bounds b
  WHERE w.class IN ('river','lake','ocean','bay','strait','canal','stream','lagoon')
    AND w.geom && ST_Transform(b.geom,4326)
    AND ST_Intersects(w.geom,ST_Transform(b.geom,4326))
)
SELECT json_build_object(
  'tile',json_build_object('x',:'tile_x'::integer,'y',:'tile_y'::integer,
    'crs','EPSG:3765','bbox',ARRAY[ST_XMin(geom),ST_YMin(geom),ST_XMax(geom),ST_YMax(geom)]),
  'buildings',(SELECT coalesce(json_agg(feature ORDER BY source_id),'[]'::json) FROM buildings),
  'roads',(SELECT coalesce(json_agg(feature ORDER BY source_id),'[]'::json) FROM roads),
  'water',(SELECT coalesce(json_agg(feature ORDER BY source_id),'[]'::json) FROM water)
) FROM bounds;
