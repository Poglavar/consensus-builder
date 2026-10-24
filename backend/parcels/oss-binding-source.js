// Native optimized reads for imported cadastral binding; geometry policy and answer assembly stay with the caller.
// The HR cadastre's storage CRS: candidate search and the dataset side of transforms only.
export const HR_PARCEL_SRID = 3765;
// The site's own edges are straight in lon/lat; split them into pieces of at most this many degrees
// (≈ 44 m of latitude) before they are transformed into the operation frame.
export const SEGMENT_DEG = 0.0004;
// Cadastre edges are straight in their dataset CRS; split into pieces of at most this many metres.
export const DATASET_SEGMENT_M = 50;
// Candidate search slack in the dataset CRS: generous, since candidates only need to be a superset.
export const CANDIDATE_SLACK_M = 0.05;

// The site in the operation frame (SRID 0, metres), valid and unioned, and — for statements that
// search the HR cadastre — the same site in its CRS and the current parcels near it. $1 polygons,
// $2 centrelines (legacy footprints: buffered in the frame), `proj` the frame's projection string.
//
// MATERIALIZED and subdivided on purpose (2026-10-16): a CTE used once is inlined, so the planner
// rebuilt the transformed, repaired, unioned site for every row of the parcel index scan, and one
// bbox around a long track met 33k parcels it then tested against the whole site. Proposal 486 (a
// 9 ha railway in Šibenik, 662 parcels) counted in 53 s and its binding-drift read hit nginx's 60 s.
// Each piece of ST_Subdivide has a tight bbox and few vertices; the pieces cover exactly the site,
// so the candidate set is unchanged (ctid deduplicates a parcel that meets several pieces).
function siteCte(proj, { dataset = false } = {}) {
    return `
    parts AS (
        SELECT ST_CollectionExtract(ST_MakeValid(ST_Transform(
                   ST_Segmentize(ST_SetSRID(ST_GeomFromGeoJSON(value), 4326), ${SEGMENT_DEG}), ${proj}::text)), 3) AS geom
        FROM jsonb_array_elements_text($1::jsonb)
        UNION ALL
        SELECT ST_Buffer(ST_Transform(ST_Segmentize(ST_SetSRID(ST_GeomFromGeoJSON(value->>'line'), 4326), ${SEGMENT_DEG}), ${proj}::text),
                         (value->>'halfWidthM')::float8, 'endcap=flat join=round quad_segs=64') AS geom
        FROM jsonb_array_elements($2::jsonb)
    ), site AS MATERIALIZED (
        SELECT ST_CollectionExtract(ST_MakeValid(ST_UnaryUnion(ST_Collect(geom))), 3) AS g
        FROM parts WHERE NOT ST_IsEmpty(geom)
    )${dataset ? `, site_ds AS MATERIALIZED (
        -- valid again after the transform: a vertex moved by the reprojection can make a ring touch itself
        SELECT ST_CollectionExtract(ST_MakeValid(ST_Transform(g, ${proj}::text, ${HR_PARCEL_SRID})), 3) AS g
        FROM site WHERE g IS NOT NULL AND NOT ST_IsEmpty(g)
    ), site_pieces AS MATERIALIZED (
        SELECT ST_Subdivide(g, ${SITE_PIECE_VERTICES}) AS g FROM site_ds
    ), candidate_parcels AS MATERIALIZED (
        -- current HR parcels near the site: indexed bbox search in 3765 with slack, per piece
        SELECT DISTINCT ON (p.ctid) p.maticni_broj_ko, p.broj_cestice, p.geom
        FROM site_pieces s
        JOIN parcel p ON p.current = true AND p.geom && ST_Expand(s.g, ${CANDIDATE_SLACK_M}) AND ST_DWithin(p.geom, s.g, ${CANDIDATE_SLACK_M})
    )` : ''}`;
}

// Vertex cap of one site piece in the candidate search (ST_Subdivide's max_vertices).
const SITE_PIECE_VERTICES = 64;

// A cadastre geometry in the operation frame: split into ≤ 50 m pieces in its own CRS first.
const inFrame = (geometrySql, proj) => `ST_Transform(ST_Segmentize(${geometrySql}, ${DATASET_SEGMENT_M}), ${proj}::text)`;
// The ellipsoidal area of a frame geometry.
const frameArea = (geometrySql, proj) => `ST_Area(ST_Transform(${geometrySql}, ${proj}::text, 4326)::geography)`;
// $1 polygons, $2 centrelines, $3 the frame's projection string.
export const BINDING_COUNT_SQL = `
    WITH ${siteCte('$3', { dataset: true })}
    SELECT count(*)::int AS parcels FROM candidate_parcels
`;

// One statement. $1 polygons, $2 centrelines, $3 = max(toleranceM, INTRUSION_NOISE_M), $4 the frame's
// projection string, $5 the decision band (bindingUncertaintyM($3 / 2)). All geometry below `site`
// is in the operation frame (SRID 0, metres):
//   candidates   current parcels near the site (indexed search in 3765), split into ≤ 50 m pieces and
//                transformed into the frame;
//   hits         site ∩ parcel per id (a duplicated current id keeps its largest piece);
//   search       the bisection on the inward-buffer radius, bracket [0, sqrt(area/π)], stopping at
//                max(0.5 mm, 0.05 % of r) — byte-for-byte the loop in site-binding.js;
//   bound        the rule itself, with its band: the intersection survives ST_Buffer(-($3/2 + $5))
//                → bound; it does not survive ST_Buffer(-($3/2 - $5)) → not bound; in between →
//                unresolved;
//   open ground  site minus every candidate parcel, split by the union of the cadastral
//                municipalities the site meets: inside = unsurveyed, outside = unknown. A component
//                counts only if it survives the same inward buffer (micro-gaps are not ground).
// Areas are measured on the ellipsoid (geography), lengths in frame metres.
export const BINDING_SQL = `
    WITH RECURSIVE ${siteCte('$4', { dataset: true })},
    region AS (
        SELECT ${inFrame('ST_UnaryUnion(ST_Collect(ST_MakeValid(k.geom)))', '$4')} AS g
        FROM cadastral_municipality k, site_ds s
        WHERE k.geom && s.g AND ST_Intersects(k.geom, s.g)
    ), candidates AS (
        SELECT 'HR-' || p.maticni_broj_ko || '-' || p.broj_cestice AS id,
               ST_CollectionExtract(ST_MakeValid(${inFrame('ST_MakeValid(p.geom)', '$4')}), 3) AS pg
        FROM candidate_parcels p
    ), hits AS (
        SELECT DISTINCT ON (id) id, i FROM (
            SELECT c.id, ST_CollectionExtract(ST_Intersection(c.pg, s.g), 3) AS i FROM candidates c, site s
        ) x
        ORDER BY id, ST_Area(i) DESC
    ), search(id, i, lo, hi, n) AS (
        SELECT id, i, 0::float8, sqrt(ST_Area(i) / pi()), 0 FROM hits WHERE ST_Area(i) > 0
        UNION ALL
        SELECT s.id, s.i,
               CASE WHEN b.ok THEN m.mid ELSE s.lo END,
               CASE WHEN b.ok THEN s.hi ELSE m.mid END,
               s.n + 1
        FROM search s
        CROSS JOIN LATERAL (SELECT (s.lo + s.hi) / 2 AS mid) m
        CROSS JOIN LATERAL (SELECT NOT ST_IsEmpty(ST_Buffer(s.i, -m.mid, 'quad_segs=64')) AS ok) b
        WHERE s.hi - s.lo > greatest(0.0005, s.lo * 0.0005) AND s.n < 60
    ), widths AS (
        SELECT DISTINCT ON (id) id, lo + hi AS intrusion_m FROM search ORDER BY id, n DESC
    ), measured AS (
        SELECT h.id,
               ${frameArea('h.i', '$4')} AS overlap_m2,
               w.intrusion_m,
               NOT ST_IsEmpty(ST_Buffer(h.i, -($3::float8 / 2 + $5::float8), 'quad_segs=64')) AS bound,
               NOT ST_IsEmpty(ST_Buffer(h.i, -greatest($3::float8 / 2 - $5::float8, 0), 'quad_segs=64')) AS bound_lo
        FROM hits h JOIN widths w USING (id)
    ), open_ground AS (
        SELECT ST_Difference(s.g, COALESCE((SELECT ST_UnaryUnion(ST_Collect(pg)) FROM candidates),
                                           ST_GeomFromText('POLYGON EMPTY', 0))) AS g
        FROM site s
    ), split AS (
        SELECT ST_CollectionExtract(ST_Intersection(o.g, r.g), 3) AS inside,
               ST_CollectionExtract(ST_Difference(o.g, r.g), 3) AS outside
        FROM open_ground o, region r
    )
    SELECT
        (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                    'parcelId', id, 'overlapM2', overlap_m2, 'intrusionM', intrusion_m, 'bound', bound,
                    'unresolved', bound_lo AND NOT bound
                ) ORDER BY id), '[]'::jsonb) FROM measured) AS parcels,
        (SELECT ${frameArea('g', '$4')} FROM site) AS site_m2,
        (SELECT g IS NOT NULL FROM region) AS in_region,
        (SELECT COALESCE(sum(${frameArea('d.geom', '$4')}), 0)
           FROM split, ST_Dump(split.inside) d
          WHERE NOT ST_IsEmpty(ST_Buffer(d.geom, -$3::float8 / 2, 'quad_segs=64'))) AS unsurveyed_m2,
        (SELECT COALESCE(sum(${frameArea('d.geom', '$4')}), 0)
           FROM split, ST_Dump(split.outside) d
          WHERE NOT ST_IsEmpty(ST_Buffer(d.geom, -$3::float8 / 2, 'quad_segs=64'))) AS unknown_m2,
        (SELECT ST_AsGeoJSON(ST_Multi(ST_Transform(g, $4::text, 4326)), 9) FROM site WHERE g IS NOT NULL AND NOT ST_IsEmpty(g)) AS site_geojson
`;

// The authored footprint must lie inside an authored site: footprint − site may only leave
// components no wider than the noise floor. $1/$2 the footprint, $3 = site GeoJSON, $4 = floor,
// $5 the frame's projection string.
export const FOOTPRINT_OUTSIDE_SITE_SQL = `
    WITH ${siteCte('$5')},
    authored AS (
        SELECT ST_CollectionExtract(ST_MakeValid(ST_Transform(
                   ST_Segmentize(ST_SetSRID(ST_GeomFromGeoJSON($3), 4326), ${SEGMENT_DEG}), $5::text)), 3) AS g
    )
    SELECT COALESCE(sum(${frameArea('d.geom', '$5')}), 0) AS outside_m2
    FROM site s, authored a, ST_Dump(ST_CollectionExtract(ST_Difference(s.g, a.g), 3)) d
    WHERE NOT ST_IsEmpty(ST_Buffer(d.geom, -$4::float8 / 2, 'quad_segs=64'))
`;

// A legacy footprint (polygons + buffered centrelines) as WGS84, for a parcel-source binding.
// $1/$2 the footprint, $3 the frame's projection string.
export const FOOTPRINT_SITE_SQL = `
    WITH ${siteCte('$3')}
    SELECT ST_AsGeoJSON(ST_Multi(ST_Transform(g, $3::text, 4326)), 9) AS geometry FROM site WHERE g IS NOT NULL AND NOT ST_IsEmpty(g)
`;

// Declared HR parcels that exist as current parcels, with their union as the act's site.
// $1 = [{ id, ko, number }].
export const PARCEL_ACT_SITE_SQL = `
    WITH ids AS (
        SELECT value->>'id' AS id, (value->>'ko')::int AS ko, value->>'number' AS number
        FROM jsonb_array_elements($1::jsonb)
    ), found AS (
        SELECT DISTINCT ON (ids.id) ids.id, ST_MakeValid(p.geom) AS g
        FROM ids JOIN parcel p
          ON p.current = true AND p.maticni_broj_ko = ids.ko AND p.broj_cestice = ids.number
        ORDER BY ids.id, ST_Area(p.geom) DESC
    )
    SELECT
        (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                    'parcelId', id, 'overlapM2', ST_Area(ST_Transform(g, 4326)::geography)) ORDER BY id), '[]'::jsonb)
           FROM found) AS parcels,
        (SELECT ST_AsGeoJSON(ST_Multi(ST_Transform(ST_CollectionExtract(ST_UnaryUnion(ST_Collect(g)), 3), 4326)), 9)
           FROM found) AS site_geojson,
        (SELECT ST_Area(ST_Transform(ST_UnaryUnion(ST_Collect(g)), 4326)::geography) FROM found) AS site_m2
`;


export async function countBindingCandidates(pool, { polygons, lines, projection }) {
    return (await pool.query(BINDING_COUNT_SQL, [polygons, lines, projection])).rows[0]?.parcels || 0;
}
export async function bindingMeasurements(pool, { polygons, lines, floorM, projection, uncertaintyM }) {
    return (await pool.query(BINDING_SQL, [polygons, lines, floorM, projection, uncertaintyM])).rows[0] || {};
}
export async function declaredParcelSite(pool, { parcels }) {
    return (await pool.query(PARCEL_ACT_SITE_SQL, [JSON.stringify(parcels)])).rows[0] || {};
}
