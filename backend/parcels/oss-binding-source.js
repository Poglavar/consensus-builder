// Candidate reads for binding a site over the imported HR cadastre (`parcel`, countrywide, ids
// HR-<ko>-<number>): an indexed search finds the current parcels and the cadastral municipalities a
// site meets and serves them in WGS84 on the shared 9-decimal grid. Nothing is decided here: the
// browser's site-binding.js decides (parcels/source-binding.js), so there is no second implementation.
import { MAX_SOURCE_BINDING_PARCELS } from './source-binding.js';

// The HR cadastre's storage CRS: the candidate search only.
export const HR_PARCEL_SRID = 3765;
// The source id a binding over this cadastre records (binding.parcelSource.sourceId).
export const HR_CADASTRE_SOURCE_ID = 'hr-cadastre';
// The site's edges are straight in lon/lat; split them into pieces of at most this many degrees
// (≈ 44 m of latitude) before the transform into 3765, so the searched shape strays by far less
// than the slack below.
export const SEGMENT_DEG = 0.0004;
// Search slack in 3765 metres: the candidates only need to be a superset of what binding decides on.
export const CANDIDATE_SLACK_M = 0.05;
// A cadastral municipality is cut to the site's box grown by this many metres: its edges far from
// the site never decide whether open ground is inside or outside it.
const REGION_MARGIN_M = 10;
// Vertex cap of one site piece in the search (ST_Subdivide's max_vertices).
const SITE_PIECE_VERTICES = 64;
// geometry-tolerances.js GRID_DECIMALS: what the browser receives and snaps to.
const GRID_DECIMALS = 9;

// One parcel per id: the 65 ids that are current twice in the source are one parcel of both pieces.
const parcelGeometry = 'CASE WHEN count(*) = 1 THEN (array_agg(p.geom))[1] ELSE ST_UnaryUnion(ST_Collect(p.geom)) END';
const asWgs84 = geometrySql => `ST_AsGeoJSON(ST_Transform(${geometrySql}, 4326), ${GRID_DECIMALS})::jsonb`;

// $1 the site (GeoJSON, EPSG:4326), $2 the most parcel ids to return (the cap + 1: one more is too many).
// MATERIALIZED and subdivided on purpose (2026-10-16): a CTE used once is inlined, so the planner
// rebuilt the transformed site for every row of the parcel index scan, and one bbox around a long
// track met 33k parcels it then tested against the whole site (a 9 ha railway in Šibenik counted in
// 53 s). Each piece of ST_Subdivide has a tight bbox and few vertices; the pieces cover exactly the
// site, so the candidate set is unchanged (ctid deduplicates a parcel that meets several pieces).
export const HR_SITE_CANDIDATES_SQL = `
    WITH site AS MATERIALIZED (
        SELECT ST_CollectionExtract(ST_MakeValid(ST_Transform(
                   ST_Segmentize(ST_SetSRID(ST_GeomFromGeoJSON($1), 4326), ${SEGMENT_DEG}), ${HR_PARCEL_SRID})), 3) AS g
    ), pieces AS MATERIALIZED (
        SELECT ST_Subdivide(g, ${SITE_PIECE_VERTICES}) AS g FROM site WHERE NOT ST_IsEmpty(g)
    ), hits AS MATERIALIZED (
        SELECT DISTINCT ON (p.ctid) p.maticni_broj_ko, p.broj_cestice, p.geom
        FROM pieces s
        JOIN parcel p ON p.current = true AND p.geom && ST_Expand(s.g, ${CANDIDATE_SLACK_M}) AND ST_DWithin(p.geom, s.g, ${CANDIDATE_SLACK_M})
    ), keys AS (
        SELECT DISTINCT maticni_broj_ko, broj_cestice FROM hits ORDER BY 1, 2 LIMIT $2
    ), parcels AS (
        SELECT 'HR-' || p.maticni_broj_ko || '-' || p.broj_cestice AS id, ${parcelGeometry} AS geom
        FROM hits p JOIN keys k USING (maticni_broj_ko, broj_cestice)
        GROUP BY p.maticni_broj_ko, p.broj_cestice
    ), regions AS (
        SELECT k.maticni_broj::text AS id,
               ST_CollectionExtract(ST_Intersection(k.geom, ST_Expand(ST_Envelope(s.g), ${REGION_MARGIN_M})), 3) AS geom
        FROM site s JOIN cadastral_municipality k ON k.geom && s.g AND ST_Intersects(k.geom, s.g)
    )
    SELECT
        (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', id, 'geometry', ${asWgs84('geom')}) ORDER BY id), '[]'::jsonb)
           FROM parcels) AS parcels,
        (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', id, 'geometry', ${asWgs84('geom')}) ORDER BY id), '[]'::jsonb)
           FROM regions WHERE NOT ST_IsEmpty(geom)) AS regions
`;

// $1 = [{ id, ko, number }]: the current parcels with those ids.
export const HR_PARCEL_IDS_SQL = `
    WITH ids AS (
        SELECT value->>'id' AS id, (value->>'ko')::int AS ko, value->>'number' AS number
        FROM jsonb_array_elements($1::jsonb)
    )
    SELECT ids.id, ${asWgs84(parcelGeometry)} AS geometry
    FROM ids JOIN parcel p ON p.current = true AND p.maticni_broj_ko = ids.ko AND p.broj_cestice = ids.number
    GROUP BY ids.id
    ORDER BY ids.id
`;

const HR_PARCEL_ID = /^HR-(\d+)-(.+)$/;

export function parseHrParcelId(id) {
    const match = typeof id === 'string' ? HR_PARCEL_ID.exec(id) : null;
    return match ? { id, ko: Number(match[1]), number: match[2] } : null;
}

const featureOf = ({ id, geometry }) => ({ type: 'Feature', properties: { parcelId: id, sourceId: HR_CADASTRE_SOURCE_ID }, geometry });

// The candidate parcels for a site and the cadastral municipalities it meets (`regions`: open ground
// inside one is unsurveyed, outside every one unknown). More than the cap is `truncated`.
export async function queryGeometry(pool, site) {
    const row = (await pool.query(HR_SITE_CANDIDATES_SQL, [JSON.stringify(site), MAX_SOURCE_BINDING_PARCELS + 1])).rows[0] || {};
    const parcels = Array.isArray(row.parcels) ? row.parcels : [];
    if (parcels.length > MAX_SOURCE_BINDING_PARCELS) return { complete: false, truncated: true, features: [], regions: [] };
    return { complete: true, features: parcels.map(featureOf), regions: Array.isArray(row.regions) ? row.regions : [] };
}

// The current parcels with these ids; an id that is not an HR cadastral id, or not current, is absent.
export async function queryIds(pool, ids) {
    const parsed = ids.map(parseHrParcelId).filter(Boolean);
    const rows = parsed.length ? (await pool.query(HR_PARCEL_IDS_SQL, [JSON.stringify(parsed)])).rows : [];
    const found = new Set(rows.map(row => row.id));
    return { complete: true, features: rows.map(featureOf), absentIds: ids.filter(id => !found.has(id)) };
}
