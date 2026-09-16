// Candidate parcels for the agent runner: every current cadastral parcel in a persona's bbox with
// its geodesic area, WGS84 geometry, the GDI buildings that sit on it, and the urban rule covering
// it. SQL only — no scoring, no geometry work, no rule interpretation; planner.js does all of that
// on what this returns.

// The parcel ids the app speaks are composed, not stored: 'HR-<maticni_broj_ko>-<broj_cestice>'.
const PARCEL_ID_PREFIX = 'HR';

// Existing buildings are converted to floors at this storey height. It is the GDI mesh's own
// convention (gdi_building.height_m is a roof height in metres), not the planner's floor height.
const EXISTING_FLOOR_HEIGHT_M = 3.5;

// The app's containment rule for "a building on this parcel": at least 90% of the footprint's area
// falls inside the parcel (backend/routes/buildings.js, the cestica_id branch). Anything less is a
// neighbour's building clipping the boundary.
const CONTAINMENT_RATIO = 0.9;

// One statement, so a caller cannot half-apply it and a test can assert its shape.
//
// $1..$4  bbox in WGS84 (minLng, minLat, maxLng, maxLat)
// $5      grad_opcina to restrict the cadastral municipality to, or NULL for every KO in the bbox
// $6,$7   area band in m² (geodesic)
// $8      row cap
//
// Notes on the two laterals:
//
//  * Buildings are counted with the SAME geodesic containment ratio the /buildings route uses, so a
//    parcel's building list here and in the app agree. height_m is nullable — a building with no
//    height counts as ONE floor rather than zero, because a footprint that exists is at least a
//    storey of built volume and a 0 there would understate what is already on the ground.
//
//  * The rule lateral picks ONE rule for the parcel, because urban_rule holds two GUP vintages
//    (2016 and 2025) whose polygons overlap, and a short name maps to several land-use regimes.
//    The order is: newest GUP first, a row that actually carries variables before one that does
//    not, then the base residential/mixed regime ('stambene i mješovite namjene') before the
//    public/sport/industrial variants — the personas propose buildings, so that is the regime they
//    build under. `COALESCE(ur.short_name, ur.title)` matters: EVERY 2025 rule row has a NULL
//    short_name and carries the short name in `title`, so joining on short_name alone (as
//    routes/urban-rules.js does) silently returns no variables at all for the current GUP.
export const candidateParcelsSql = `
WITH area AS (
    SELECT ST_Transform(ST_MakeEnvelope($1::float8, $2::float8, $3::float8, $4::float8, 4326), 3765) AS geom
),
candidate AS (
    SELECT
        p.cestica_id,
        p.maticni_broj_ko,
        p.broj_cestice,
        cm.naziv AS ko_name,
        p.geom,
        ST_Area(ST_Transform(p.geom, 4326)::geography)::float8 AS area_m2
    FROM public.parcel p
    JOIN public.cadastral_municipality cm ON cm.maticni_broj = p.maticni_broj_ko
    CROSS JOIN area a
    WHERE p.current = true
      AND p.geom && a.geom
      AND ST_Intersects(p.geom, a.geom)
      AND ($5::text IS NULL OR cm.grad_opcina = $5::text)
),
sized AS (
    SELECT * FROM candidate
    WHERE area_m2 >= $6::float8 AND area_m2 <= $7::float8
    ORDER BY cestica_id
    LIMIT $8::int
)
SELECT
    s.cestica_id,
    s.maticni_broj_ko,
    s.broj_cestice,
    s.ko_name,
    s.area_m2,
    ST_X(ST_Transform(ST_PointOnSurface(s.geom), 4326))::float8 AS centroid_lng,
    ST_Y(ST_Transform(ST_PointOnSurface(s.geom), 4326))::float8 AS centroid_lat,
    ST_AsGeoJSON(ST_Transform(s.geom, 4326))::json AS geometry,
    COALESCE(b.building_count, 0) AS building_count,
    COALESCE(b.built_footprint_m2, 0)::float8 AS built_footprint_m2,
    COALESCE(b.built_gfa_m2, 0)::float8 AS built_gfa_m2,
    r.rule_geom_hash,
    r.rule_id,
    r.rule_short_name,
    r.rule_variables
FROM sized s
LEFT JOIN LATERAL (
    SELECT
        count(*) AS building_count,
        SUM(f.footprint_m2)::float8 AS built_footprint_m2,
        SUM(f.footprint_m2 * f.floors)::float8 AS built_gfa_m2
    FROM (
        SELECT
            ST_Area(ST_Transform(bf.geom, 4326)::geography)::float8 AS footprint_m2,
            CASE WHEN bg.height_m IS NULL THEN 1
                 ELSE GREATEST(1, ROUND(bg.height_m / ${EXISTING_FLOOR_HEIGHT_M})) END AS floors
        FROM public.gdi_building_footprint bf
        LEFT JOIN public.gdi_building bg ON bg.object_id = bf.object_id
        WHERE bf.geom && s.geom
          AND ST_Intersects(bf.geom, s.geom)
          AND ST_Area(ST_Transform(bf.geom, 4326)::geography) > 0
          AND ST_Area(ST_Transform(ST_Intersection(bf.geom, s.geom), 4326)::geography)
              / ST_Area(ST_Transform(bf.geom, 4326)::geography) >= ${CONTAINMENT_RATIO}
    ) f
) b ON TRUE
LEFT JOIN LATERAL (
    SELECT
        ur.geom_hash AS rule_geom_hash,
        COALESCE(ur.short_name, ur.title) AS rule_short_name,
        urv.rule_id AS rule_id,
        urv.variables AS rule_variables
    FROM consensus.urban_rule ur
    LEFT JOIN consensus.urban_rule_variable urv
        ON urv.rule_short_name = COALESCE(ur.short_name, ur.title)
       AND urv.gup_id::text = ur.gup
       AND (ur.exception_para = urv.exception_paragraph
            OR (ur.exception_para IS NULL AND urv.exception_paragraph IS NULL))
    WHERE ur.current
      AND ST_Contains(ur.geom, ST_PointOnSurface(s.geom))
    ORDER BY ur.gup DESC,
             (urv.variables IS NULL),
             (urv.rule_id LIKE '%stambene-i-mješovite-namjene') DESC,
             urv.rule_id
    LIMIT 1
) r ON TRUE
ORDER BY s.cestica_id
`;

// A number or null — never a 0 conjured out of null by Number(), and never NaN. Every numeric field
// below goes through this, because a missing setback that arrives as 0 means "build to the
// boundary" and a missing floor count that arrives as 0 means "no building".
function num(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

// The rule's own variable names, mapped to the planner's vocabulary. `variables` is carried through
// whole so a caller can read anything this mapping leaves out.
function ruleFromRow(row) {
    if (!row.rule_geom_hash) return null;
    const variables = (row.rule_variables && typeof row.rule_variables === 'object') ? row.rule_variables : null;
    const read = key => (variables ? num(variables[key]) : null);
    return {
        ruleId: row.rule_id ?? null,
        shortName: row.rule_short_name ?? null,
        maxFloors: read('max_etage'),
        maxCoveragePct: read('max_izgradenost'),
        maxGfaM2: read('max_gbp'),
        minSetbackM: read('min_distance_from_buildable_parcels'),
        minPlotM2: read('min_plot_size'),
        variables
    };
}

function rowToParcel(row) {
    const cesticaId = num(row.cestica_id);
    const koCode = num(row.maticni_broj_ko);
    const brojCestice = row.broj_cestice === null || row.broj_cestice === undefined ? '' : String(row.broj_cestice);
    return {
        parcelId: `${PARCEL_ID_PREFIX}-${koCode === null ? '' : koCode}-${brojCestice}`,
        cesticaId,
        koCode,
        koName: row.ko_name ?? null,
        areaM2: num(row.area_m2),
        centroid: { lng: num(row.centroid_lng), lat: num(row.centroid_lat) },
        geometry: row.geometry ?? null,
        buildingCount: num(row.building_count) ?? 0,
        builtFootprintM2: num(row.built_footprint_m2) ?? 0,
        builtGfaM2: num(row.built_gfa_m2) ?? 0,
        rule: ruleFromRow(row)
    };
}

/**
 * Every buildable-sized parcel in one persona area, with what is already on it and the rule over it.
 *
 * A parcel qualifies by INTERSECTING the bbox, so a parcel straddling the edge is included and its
 * centroid may land just outside — the bbox is a search area, not a clip.
 *
 * @param {import('pg').Pool} pool
 * @param {{ city?: string, bbox: number[], minAreaM2?: number, maxAreaM2?: number, limit?: number }} options
 */
export async function fetchCandidateParcels(pool, { city, bbox, minAreaM2 = 400, maxAreaM2 = 2000, limit = 40 } = {}) {
    if (!Array.isArray(bbox) || bbox.length !== 4 || bbox.some(v => !Number.isFinite(v))) {
        throw new Error('fetchCandidateParcels: bbox must be [minLng, minLat, maxLng, maxLat] of finite numbers.');
    }
    // Only Zagreb has a known grad_opcina today; any other city searches every KO in the bbox
    // rather than silently returning nothing under a name the column does not use.
    const gradOpcina = String(city || '').toLowerCase() === 'zagreb' ? 'ZAGREB' : null;
    const params = [bbox[0], bbox[1], bbox[2], bbox[3], gradOpcina, minAreaM2, maxAreaM2, limit];
    const { rows } = await pool.query(candidateParcelsSql, params);
    return rows.map(rowToParcel);
}
