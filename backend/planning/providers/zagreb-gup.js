// Read Zagreb's existing solved-envelope table directly. No solver, proposal import or second cache.
// Source-specific fields stop here; map and model consume the same city-neutral representation.
import { validateGeometry } from '../../parcels/source-contract.js';
import { withSourceProposal, sourceRevision } from '../source-proposal.js';

export const zagrebGupSource = Object.freeze({
    id: 'zagreb-gup-2025', label: 'Zagreb GUP 2025', city: 'zagreb', edition: '2025', default: true,
    url: 'https://www.zagreb.hr/izmjene-i-dopune-generalnogurbanistickog-plana-gr/187664',
    coverage: 'cached-results', kind: 'regulation', storage: 'public.parcel_build_envelope',
    capabilities: { volumes: true, parcelEvidence: true, constraintEvaluation: false },
    scenario: 'cached-calculation'
});
export const zagrebGup2016Source = Object.freeze({ ...zagrebGupSource,
    id: 'zagreb-gup-2016', label: 'Zagreb GUP 2016', edition: '2016', default: false,
    url: 'https://geoportal.zagreb.hr/' });
const sourceFor = row => Number(row.gup_id) === 2016 ? zagrebGup2016Source : zagrebGupSource;
const finite = value => typeof value === 'number' && Number.isFinite(value);

export function gupRepresentation(row) {
    if (!row.parcel_id || !Array.isArray(row.floors) || !row.floors.length) return null;
    if (['geometry_failed', 'condition_failed'].includes(row.result_status)
        || row.geometry_status === 'failed' || row.zero_capacity_bound === true) return null;
    const id = `${sourceFor(row).id}:${row.parcel_id}`;
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
    return gupRecord(row, volumes);
}

// A saved outcome is useful evidence even when it contains no renderable volume. Its reason
// comes verbatim from the cache; absence is not reclassified by the application.
export function gupRecord(row, volumes = []) {
    const source = sourceFor(row);
    const id = `${source.id}:${row.parcel_id}`;
    const { floors, parcel_geometry, refresh_pending, ...evidence } = row;
    const { current, ...calculation } = evidence;
    const stockEstimate = row.result_status === 'existing_stock_estimate' || row.source === 'empirical';
    return withSourceProposal({
        id, role: 'permitted', proposalId: null,
        title: `GUP ${source.edition} · ${row.zone || ''}`.trim(),
        site: validateGeometry(parcel_geometry) ? parcel_geometry : null,
        volumes,
        spatialReference: { horizontal: 'OGC:CRS84', vertical: 'relative-ground', unit: 'm' },
        source: { ...source, recordId: row.parcel_id,
            version: sourceRevision({ ...calculation, floors, parcel_geometry }),
            computedAt: row.computed_at, solverVersion: row.solver_version, rule: row.rule_id, parcel: row.parcel_id },
        authority: { effect: 'obligatory', basis: 'solver-cache', applicability: row.applicability_status || 'unresolved' },
        assessment: { geometry: row.geometry_status || 'unknown',
            meaning: stockEstimate ? 'existing-stock-estimate' : 'one-calculated-option',
            constraints: 'not-evaluated', status: row.result_status, reason: row.reason,
            regime: row.build_regime, zeroCapacityBound: row.zero_capacity_bound,
            current: row.current !== false, refresh: refresh_pending || null },
        metrics: { floorAreaM2: finite(row.gbp_m2) ? row.gbp_m2 : null,
            heightM: volumes.length ? Math.max(...volumes.map(volume => volume.topM)) : null },
        constraints: finite(row.max_units) ? [{ quantity: 'dwellings', value: row.max_units, unit: 'count',
            bound: 'maximum', evaluation: 'not-evaluated' }] : [],
        // These are the cached facts, including independent new-build and retained-stock
        // quantities. Joining today's rule variables would mix different source revisions.
        sourceEvidence: evidence
    });
}

// One spatial read provides both the viewport's result counts and a bounded set of drawable
// profiles. Rows without geometry cannot consume the geometry limit or disappear from coverage.
export const ZAGREB_CACHE_QUERY = `WITH visible AS MATERIALIZED (
    SELECT e.*, CASE WHEN f.cestica_id IS NOT NULL THEN jsonb_build_object(
        'code',f.error_code,'requestedAt',f.updated_at) END AS refresh_pending
    FROM public.parcel_build_envelope e
    LEFT JOIN public.envelope_cache_error f ON f.gup_id=e.gup_id AND f.cestica_id=e.cestica_id
    WHERE e.current AND e.gup_id = $7
      AND e.geom && ST_Transform(ST_MakeEnvelope($1,$2,$3,$4,4326),3765)
      AND ST_Intersects(e.geom, ST_Transform(ST_MakeEnvelope($1,$2,$3,$4,4326),3765))
), profiles AS (
    SELECT * FROM visible WHERE CASE WHEN jsonb_typeof(floors) = 'array' THEN jsonb_array_length(floors) > 0 ELSE false END
), selected AS (
    SELECT * FROM profiles WHERE ($6::integer IS NULL OR cestica_id > $6)
    ORDER BY cestica_id LIMIT $5
)
SELECT (SELECT count(*)::int FROM visible) AS cached_count,
    (SELECT count(*)::int FROM visible WHERE refresh_pending IS NOT NULL) AS refresh_count,
    (SELECT count(*)::int FROM profiles) AS profile_count,
    (SELECT coalesce(jsonb_object_agg(status, count), '{}'::jsonb) FROM (
        SELECT coalesce(result_status, 'unknown') AS status, count(*)::int AS count
        FROM visible GROUP BY result_status
    ) counts) AS status_counts,
    (SELECT coalesce(jsonb_agg(record ORDER BY (record->>'cestica_id')::integer), '[]'::jsonb) FROM (
        SELECT (to_jsonb(s) - 'geom' - 'footprint_geom') || jsonb_build_object(
            'parcel_geometry', ST_AsGeoJSON(ST_Transform(s.geom,4326),9)::jsonb) AS record
        FROM selected s
    ) records) AS profiles`;

export async function queryZagrebGup(pool, { bbox, limit, after = null, edition = '2025' }) {
    if (after !== null && (!/^\d{1,10}$/.test(after) || Number(after) > 2147483647)) {
        throw Object.assign(new Error('Invalid source cursor'), { status: 400 });
    }
    const { rows } = await pool.query(ZAGREB_CACHE_QUERY, [...bbox, limit + 1, after, Number(edition)]);
    const result = rows[0];
    const candidates = result.profiles.slice(0, limit);
    const items = candidates.map(gupRepresentation).filter(Boolean);
    // Advance past every candidate, including invalid geometry, using the unique cache key.
    const nextAfter = result.profiles.length > limit ? String(candidates.at(-1).cestica_id) : null;
    return { items, nextAfter, omitted: candidates.length - items.length,
        summary: { sourceId: sourceFor({ gup_id: edition }).id, cachedResults: result.cached_count,
            awaitingRefresh: result.refresh_count || 0,
            withGeometry: result.profile_count, withoutGeometry: result.cached_count - result.profile_count,
            statuses: result.status_counts } };
}

export async function readZagrebParcel(pool, { parcel, edition = '2025' }) {
    // Locate the current cadastral identity first so withdrawn cache records can be explained
    // without scanning the city cache or reviving geometry belonging to a retired identity.
    const match = /^HR-(\d+)-(.+)$/.exec(parcel);
    if (!match) return [];
    const { rows } = await pool.query(`SELECT (to_jsonb(e) - 'geom' - 'footprint_geom') || jsonb_build_object(
        'parcel_geometry', ST_AsGeoJSON(ST_Transform(e.geom,4326),9)::jsonb,
        'refresh_pending', CASE WHEN f.cestica_id IS NOT NULL THEN jsonb_build_object(
            'code', f.error_code, 'requestedAt', f.updated_at) END) AS record
        FROM public.parcel p JOIN public.parcel_build_envelope e ON e.cestica_id=p.cestica_id
        LEFT JOIN public.envelope_cache_error f ON f.cestica_id=e.cestica_id AND f.gup_id=e.gup_id
        WHERE p.current AND p.maticni_broj_ko=$1 AND p.broj_cestice=$2
          AND e.gup_id=$3 AND e.parcel_id=$4
        ORDER BY e.current DESC, e.computed_at DESC LIMIT 1`, [Number(match[1]), match[2], Number(edition), parcel]);
    return rows.map(({ record }) => record.current ? (gupRepresentation(record) || gupRecord(record)) : gupRecord(record));
}
