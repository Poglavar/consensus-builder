// Server side of the proposal footprint: which cadastral parcels a proposal's own geometry lies on.
// The parts come from the shared pure builder (frontend/js/proposals/footprint-parts.js, the same
// one the browser publish gate uses); PostGIS unions them and measures each parcel's overlap in
// EPSG:3765 metres. The strict declaration rule for new records (declared == binding) lives in
// binding.js; parcelOverlaps here serves the legacy-declaration migration.

import { createRequire } from 'node:module';

const requireCjs = createRequire(import.meta.url);
const footprintPartsApi = requireCjs('../../frontend/js/proposals/footprint-parts.js');

export const { footprintParts, hasFootprint, MAX_FOOTPRINT_VERTICES } = footprintPartsApi;

// Below 1 m² an overlap is boundary noise (coordinate rounding, a shared edge), not ground the
// proposal lies on. The browser gate uses the same floor.
export const MIN_PARCEL_OVERLAP_M2 = 1;

export const INVALID_FOOTPRINT = 'invalid-footprint';

// A stored row keeps sub-proposals both in their own columns and inside proposal_data; the column
// is authoritative (the serializer reads it the same way).
export function proposalGeometryView(row) {
    const data = row && row.proposal_data && typeof row.proposal_data === 'object' ? row.proposal_data : {};
    return {
        ...data,
        roadProposal: row?.road_proposal ?? data.roadProposal,
        buildingProposal: row?.building_proposal ?? data.buildingProposal,
        structureProposal: row?.structure_proposal ?? data.structureProposal,
        reparcellization: row?.reparcellization ?? data.reparcellization
    };
}

export function footprintQueryParams(parts) {
    const lines = parts.centerline
        ? parts.centerline.segments.map(coordinates => ({
            line: { type: 'LineString', coordinates },
            halfWidthM: parts.centerline.halfWidthM
        }))
        : [];
    return [JSON.stringify(parts.polygons), JSON.stringify(lines)];
}

// One statement: build the footprint (valid polygons, centrelines buffered with flat ends so the
// approximation never reaches past the drawn road), then join current parcels through the GiST
// index (`&&` bbox prefilter, ST_Intersects on the raw indexed geometry) and measure the overlap.
export const PARCEL_OVERLAP_SQL = `
    WITH parts AS (
        SELECT ST_CollectionExtract(ST_MakeValid(ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(value), 4326), 3765)), 3) AS geom
        FROM jsonb_array_elements_text($1::jsonb)
        UNION ALL
        SELECT ST_Buffer(ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(value->>'line'), 4326), 3765),
                         (value->>'halfWidthM')::float8, 'endcap=flat join=round') AS geom
        FROM jsonb_array_elements($2::jsonb)
    ), footprint AS (
        SELECT ST_UnaryUnion(ST_Collect(geom)) AS geom FROM parts WHERE NOT ST_IsEmpty(geom)
    ), hits AS (
        SELECT DISTINCT ON (1)
            'HR-' || p.maticni_broj_ko || '-' || p.broj_cestice AS id,
            ST_Area(ST_MakeValid(p.geom)) AS parcel_area_m2,
            ST_Area(ST_Intersection(ST_MakeValid(p.geom), f.geom)) AS overlap_m2
        FROM footprint f
        JOIN parcel p ON p.current = true AND p.geom && f.geom AND ST_Intersects(p.geom, f.geom)
        ORDER BY 1, 3 DESC
    )
    SELECT id, parcel_area_m2, overlap_m2 FROM hits WHERE overlap_m2 >= $3 ORDER BY overlap_m2 DESC, id
`;

// [{ id, parcelAreaM2, overlapM2 }] for every current parcel the footprint covers by >= minAreaM2.
export async function parcelOverlaps(db, parts, { minAreaM2 = MIN_PARCEL_OVERLAP_M2 } = {}) {
    if (!hasFootprint(parts)) return [];
    const { rows } = await db.query(PARCEL_OVERLAP_SQL, [...footprintQueryParams(parts), minAreaM2]);
    return rows.map(row => ({
        id: String(row.id),
        parcelAreaM2: Number(row.parcel_area_m2),
        overlapM2: Number(row.overlap_m2)
    }));
}
