// Bounded, read-only Zagreb screening data. Point-sampled plan extracts are research evidence,
// and transit proximity is explicitly not a walking route, timetable, or jobs-access calculation.
export const housingSitesSql = `
WITH search AS (
    SELECT ST_Transform(ST_MakeEnvelope($1,$2,$3,$4,4326),3765) AS geom
), sized AS MATERIALIZED (
    SELECT p.cestica_id,p.maticni_broj_ko,p.broj_cestice,p.geom,p.date_added,
           ST_PointOnSurface(p.geom) AS anchor,
           ST_Area(ST_Transform(p.geom,4326)::geography)::float8 AS area_m2,
           cm.naziv AS ko_name
    FROM public.parcel p
    JOIN public.cadastral_municipality cm ON cm.maticni_broj=p.maticni_broj_ko
    CROSS JOIN search a
    WHERE p.current AND p.geom && a.geom AND ST_Intersects(p.geom,a.geom)
      AND cm.grad_opcina='ZAGREB'
      AND ST_Area(ST_Transform(p.geom,4326)::geography) BETWEEN $5 AND $6
    ORDER BY p.cestica_id LIMIT $7
), current_feed AS (
    SELECT id,fetched_at,active_from FROM zet.gtfs_feeds
    WHERE active_to IS NULL AND active_from<=CURRENT_DATE
    ORDER BY active_from DESC,id DESC LIMIT 1
)
SELECT s.cestica_id,s.maticni_broj_ko,s.broj_cestice,s.ko_name,s.area_m2,
       s.date_added AS parcel_date_added,
       ST_AsGeoJSON(ST_Transform(s.geom,4326))::json AS geometry,
       ST_X(ST_Transform(s.anchor,4326)) AS lng,ST_Y(ST_Transform(s.anchor,4326)) AS lat,
       b.building_count,scope.sensitive_use,road.classification AS road_classification,
       lu.oznaka AS land_use_mark,lu.namjena AS land_use_name,lu.updated_at AS land_use_updated_at,
       r.rule_short_name,r.rule_id,r.variables,r.updated_at AS rule_updated_at,
       f.id AS feed_id,f.fetched_at AS feed_fetched_at,
       stop.stop_id,stop.stop_name,stop.stop_lon,stop.stop_lat,stop.distance_m
FROM sized s
LEFT JOIN public.road_parcel_classification road ON road.cestica_id=s.cestica_id
LEFT JOIN LATERAL (
    SELECT count(*)::int AS building_count FROM public.gdi_building_footprint b
    WHERE b.geom && s.geom AND ST_Intersects(b.geom,s.geom)
      AND ST_Area(ST_Transform(ST_Intersection(b.geom,s.geom),4326)::geography)>5
) b ON TRUE
LEFT JOIN LATERAL (
    SELECT bool_or(l.oznaka ~ '^(Z|R|V|Š|IS|D)') AS sensitive_use
    FROM public.planned_land_use l
    WHERE l.city_id=1 AND l.gup_version='2025' AND l.razina_plana='GUP'
      AND l.geom && s.geom AND ST_Intersects(l.geom,s.geom)
      AND ST_Area(ST_Transform(ST_Intersection(l.geom,s.geom),4326)::geography)>1
) scope ON TRUE
LEFT JOIN LATERAL (
    SELECT l.oznaka,l.namjena,l.updated_at FROM public.planned_land_use l
    WHERE l.city_id=1 AND l.gup_version='2025'
      AND l.razina_plana='GUP'
      AND l.geom && s.anchor AND ST_Covers(l.geom,s.anchor)
    ORDER BY l.objectid LIMIT 1
) lu ON TRUE
LEFT JOIN LATERAL (
    SELECT COALESCE(u.short_name,u.title) AS rule_short_name,v.rule_id,v.variables,v.updated_at
    FROM consensus.urban_rule u
    LEFT JOIN consensus.urban_rule_variable v
      ON v.rule_short_name=COALESCE(u.short_name,u.title) AND v.gup_id=2025
      AND v.exception_paragraph IS NOT DISTINCT FROM u.exception_para
      AND (lu.oznaka=ANY(v.land_uses_marks) OR v.land_uses_marks IS NULL)
    WHERE u.current AND u.gup='2025' AND u.geom && s.anchor AND ST_Covers(u.geom,s.anchor)
    ORDER BY (v.variables IS NULL),v.rule_id LIMIT 1
) r ON TRUE
LEFT JOIN current_feed f ON TRUE
LEFT JOIN LATERAL (
    SELECT t.stop_id,t.stop_name,t.stop_lon,t.stop_lat,
           ST_DistanceSphere(ST_SetSRID(ST_MakePoint(t.stop_lon,t.stop_lat),4326),ST_Transform(s.anchor,4326)) AS distance_m
    FROM zet.stops t
    WHERE t.feed_id=f.id AND COALESCE(t.location_type,0)=0
      AND t.stop_lon BETWEEN ST_X(ST_Transform(s.anchor,4326))-.03 AND ST_X(ST_Transform(s.anchor,4326))+.03
      AND t.stop_lat BETWEEN ST_Y(ST_Transform(s.anchor,4326))-.02 AND ST_Y(ST_Transform(s.anchor,4326))+.02
    ORDER BY distance_m,t.stop_id LIMIT 1
) stop ON TRUE
ORDER BY s.cestica_id
`;
const numberOrNull = value => value === null || value === undefined || value === '' ? null
    : Number.isFinite(Number(value)) ? Number(value) : null;
export function siteFromRow(row) {
    const read = key => numberOrNull(row.variables?.[key]);
    const mark = typeof row.land_use_mark === 'string' ? row.land_use_mark.trim().toUpperCase() : null;
    const housingUse = mark === null ? null : /^(S|M|M0|M1|M2|MGP)$/.test(mark) ? true
        : /^(K\d*|I\d*|G\d*|T\d*|D\d*|P\d*|Z\d*|R\d*|V\d*|IS|Š\d*)$/.test(mark) ? false : null;
    return {
        parcelId: `HR-${row.maticni_broj_ko}-${row.broj_cestice}`, koName: row.ko_name,
        areaM2: numberOrNull(row.area_m2), geometry: row.geometry,
        centroid: { lng: numberOrNull(row.lng), lat: numberOrNull(row.lat) },
        buildingCount: numberOrNull(row.building_count),
        roadClassification: row.road_classification ?? null,
        planning: {
            vintage: '2025', sampling: 'parcel-point-on-surface', housingUse,
            sensitiveUse: row.sensitive_use === true || (!!mark && /^(Z|R|V|Š|IS|D)/.test(mark)),
            landUse: { mark, name: row.land_use_name ?? null, updatedAt: row.land_use_updated_at ?? null },
            rule: row.rule_short_name ? {
                shortName: row.rule_short_name, ruleId: row.rule_id ?? null,
                maxFloors: read('max_etage'), minSetbackM: read('min_distance_from_buildable_parcels'),
                maxCoveragePct: read('max_izgradenost'), maxDetachedCoveragePct: read('max_izgradenost_detached'),
                maxUnits: read('max_units'), maxKisn: read('max_kisn'), maxDetachedKisn: read('max_kisn_detached'),
                minParkingPerUnit: read('min_parking_spaces_per_unit'), allowedTypologies: row.variables?.allowed_building_typologies ?? null,
                maxGfaM2: read('max_gbp'), minPlotM2: read('min_plot_size'),
                variables: row.variables, updatedAt: row.rule_updated_at ?? null,
                url: `https://zagreb.lol/urbana-pravila/?gup=2025&zone=${encodeURIComponent(row.rule_short_name)}`
            } : null
        },
        accessibility: {
            method: 'straight-line-stop-proximity', feedId: numberOrNull(row.feed_id), feedFetchedAt: row.feed_fetched_at ?? null,
            nearestStop: row.stop_id ? { id: row.stop_id, name: row.stop_name,
                lng: numberOrNull(row.stop_lon), lat: numberOrNull(row.stop_lat), distanceM: numberOrNull(row.distance_m) } : null
        },
        source: { parcelDateAdded: row.parcel_date_added ?? null, cadastre: 'public.parcel',
            buildings: 'public.gdi_building_footprint', roads: 'public.road_parcel_classification', planning: '2025-plan-extract', transit: 'zet.stops / zet.gtfs_feeds' }
    };
}
export const scanDefaults = Object.freeze({ bbox: [15.93,45.78,15.97,45.81], minAreaM2: 1200, maxAreaM2: 20000, sampleLimit: 100, limit: 10 });
export function validateScan(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid scan');
    const allowed = new Set(['bbox','minAreaM2','maxAreaM2','sampleLimit','limit','assumptions','reform']);
    for (const key of Object.keys(input)) if (!allowed.has(key)) throw new Error(`Unknown scan option: ${key}`);
    const config = { ...scanDefaults, ...input };
    const b=config.bbox;
    if (!Array.isArray(b)||b.length!==4||b.some(n=>typeof n!=='number'||!Number.isFinite(n))
        ||b[0]<15.75||b[2]>16.15||b[1]<45.65||b[3]>45.95||b[0]>=b[2]||b[1]>=b[3]
        ||b[2]-b[0]>.061||b[3]-b[1]>.061) throw new Error('Choose a Zagreb search area at most 0.06 degrees wide and high');
    for (const key of ['minAreaM2','maxAreaM2','sampleLimit','limit']) if (!Number.isInteger(config[key])) throw new Error(`Invalid scan option: ${key}`);
    if(config.minAreaM2<400||config.maxAreaM2>50000||config.minAreaM2>config.maxAreaM2
        ||config.sampleLimit<1||config.sampleLimit>150||config.limit<1||config.limit>20) throw new Error('Invalid scan limits');
    return config;
}
export async function fetchHousingSites(pool, config) {
    const { bbox, minAreaM2, maxAreaM2, sampleLimit } = validateScan(config);
    const client = await pool.connect();
    try {
        await client.query('BEGIN READ ONLY');
        await client.query("SET LOCAL statement_timeout = '25s'");
        const result = await client.query(housingSitesSql, [...bbox,minAreaM2,maxAreaM2,sampleLimit]);
        await client.query('COMMIT');
        return result.rows.map(siteFromRow);
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally { client.release(); }
}
