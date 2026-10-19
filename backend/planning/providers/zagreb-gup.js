// Read Zagreb's existing solved-envelope table directly. No solver, proposal import or second cache.
// Source-specific fields stop here; map and model consume the same city-neutral representation.
import { createHash } from 'node:crypto';
import { validateGeometry } from '../../parcels/source-contract.js';

export const zagrebGupSource = Object.freeze({
    id: 'zagreb-gup-2025', label: 'Zagreb GUP 2025', city: 'zagreb',
    url: 'https://www.zagreb.hr/izmjene-i-dopune-generalnogurbanistickog-plana-gr/187664',
    coverage: 'cached-results', kind: 'regulation', storage: 'public.parcel_build_envelope'
});
const finite = value => typeof value === 'number' && Number.isFinite(value);

export function gupRepresentation(row) {
    if (!row.parcel_id || !Array.isArray(row.floors) || !row.floors.length) return null;
    if (['geometry_failed', 'condition_failed'].includes(row.result_status)
        || row.geometry_status === 'failed' || row.zero_capacity_bound === true) return null;
    const id = `${zagrebGupSource.id}:${row.parcel_id}`;
    const volumes = [];
    // Adjacent floors with identical outlines form one prism; setbacks and overhangs retain
    // their actual elevations. Never substitute a ground-based column or an estimated footprint.
    let previousGeometry;
    for (const [index, floor] of row.floors.entries()) {
        if (!floor || typeof floor !== 'object') return null;
        const baseM = floor.base_elevation_m, topM = floor.top_elevation_m;
        if (!validateGeometry(floor.geometry) || !finite(baseM) || !finite(topM) || topM <= baseM
            || !finite(floor.height_m) || Math.abs(topM - baseM - floor.height_m) > 0.001) return null;
        const geometryKey = JSON.stringify(floor.geometry), previous = volumes.at(-1);
        if (previous && previousGeometry === geometryKey && Math.abs(previous.topM - baseM) < 0.001) previous.topM = topM;
        else volumes.push({ id: `${id}:floor:${index}`, geometry: floor.geometry, baseM, topM });
        previousGeometry = geometryKey;
    }
    const { floors, parcel_geometry, ...evidence } = row;
    const stockEstimate = row.result_status === 'existing_stock_estimate' || row.source === 'empirical';
    return {
        id, role: 'permitted', proposalId: null,
        title: `GUP 2025 · ${row.zone || ''}`.trim(),
        site: validateGeometry(parcel_geometry) ? parcel_geometry : null,
        volumes,
        spatialReference: { horizontal: 'OGC:CRS84', vertical: 'relative-ground', unit: 'm' },
        source: { ...zagrebGupSource, recordId: `${row.gup_id}:${row.cestica_id}`,
            version: createHash('sha256').update(JSON.stringify(row)).digest('hex'),
            computedAt: row.computed_at, solverVersion: row.solver_version, rule: row.rule_id, parcel: row.parcel_id },
        authority: { effect: 'obligatory', basis: 'solver-cache', applicability: row.applicability_status || 'unresolved' },
        assessment: { geometry: row.geometry_status || 'unknown',
            meaning: stockEstimate ? 'existing-stock-estimate' : 'one-calculated-option',
            constraints: 'not-evaluated', status: row.result_status, reason: row.reason,
            regime: row.build_regime, zeroCapacityBound: row.zero_capacity_bound },
        metrics: { floorAreaM2: finite(row.gbp_m2) ? row.gbp_m2 : null,
            heightM: Math.max(...volumes.map(volume => volume.topM)) },
        constraints: finite(row.max_units) ? [{ quantity: 'dwellings', value: row.max_units, unit: 'count',
            bound: 'maximum', evaluation: 'not-evaluated' }] : [],
        // These are the cached facts, including independent new-build and retained-stock
        // quantities. Joining today's rule variables would mix different source revisions.
        sourceEvidence: evidence
    };
}

// One spatial read provides both the viewport's result counts and a bounded set of drawable
// profiles. Rows without geometry cannot consume the geometry limit or disappear from coverage.
export const ZAGREB_CACHE_QUERY = `WITH visible AS MATERIALIZED (
    SELECT e.* FROM public.parcel_build_envelope e
    WHERE e.current AND e.gup_id = 2025
      AND e.geom && ST_Transform(ST_MakeEnvelope($1,$2,$3,$4,4326),3765)
      AND ST_Intersects(e.geom, ST_Transform(ST_MakeEnvelope($1,$2,$3,$4,4326),3765))
), profiles AS (
    SELECT * FROM visible WHERE CASE WHEN jsonb_typeof(floors) = 'array' THEN jsonb_array_length(floors) > 0 ELSE false END
), selected AS (
    SELECT * FROM profiles ORDER BY parcel_id LIMIT $5
)
SELECT (SELECT count(*)::int FROM visible) AS cached_count,
    (SELECT count(*)::int FROM profiles) AS profile_count,
    (SELECT coalesce(jsonb_object_agg(status, count), '{}'::jsonb) FROM (
        SELECT coalesce(result_status, 'unknown') AS status, count(*)::int AS count
        FROM visible GROUP BY result_status
    ) counts) AS status_counts,
    (SELECT coalesce(jsonb_agg(record ORDER BY record->>'parcel_id'), '[]'::jsonb) FROM (
        SELECT (to_jsonb(s) - 'geom' - 'footprint_geom') || jsonb_build_object(
            'parcel_geometry', ST_AsGeoJSON(ST_Transform(s.geom,4326),9)::jsonb) AS record
        FROM selected s
    ) records) AS profiles`;

export async function queryZagrebGup(pool, { bbox, limit }) {
    const { rows } = await pool.query(ZAGREB_CACHE_QUERY, [...bbox, limit + 1]);
    const result = rows[0];
    const candidates = result.profiles.slice(0, limit);
    const items = candidates.map(gupRepresentation).filter(Boolean);
    return { items, truncated: result.profile_count > limit, omitted: candidates.length - items.length,
        summary: { sourceId: zagrebGupSource.id, cachedResults: result.cached_count,
            withGeometry: result.profile_count, withoutGeometry: result.cached_count - result.profile_count,
            statuses: result.status_counts } };
}
