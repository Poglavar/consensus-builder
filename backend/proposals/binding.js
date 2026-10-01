// Server side of a proposal's site → parcel binding (PARCEL-OPTIONAL.md): which cadastral parcels a
// site reaches into, how far (intrusion width), and how much of the site is open ground. PostGIS
// over the full cadastre mirrors the pure rule in frontend/js/proposals/site-binding.js exactly:
// bound ⇔ site ∩ parcel survives ST_Buffer(-max(toleranceM, noise)/2) in EPSG:3765; intrusion is
// found by the same inward-buffer bisection (not ST_MaximumInscribedCircle, whose fixed tolerance of
// 1/1000 of the extent mis-measures a long thin sliver, and which needs GEOS >= 3.9).
//
// Only the Croatian cadastre (`parcel`, countrywide, ids HR-<ko>-<number>) is bindable here. A site
// outside every cadastral municipality (`cadastral_municipality`) gets coverage 'unknown' — the
// server cannot see that region's cadastre, which is not the same as there being none — except for
// a city configured with no cadastre at all (explore), which gets 'none'.
//
// Used by POST /proposals/binding, the create precheck (free and paid routes) and the site
// migration.

import { createRequire } from 'node:module';
import { INVALID_FOOTPRINT, footprintParts, footprintQueryParams, hasFootprint } from './footprint.js';
import { wgs84BboxAreaKm2 } from '../utils/helpers.js';

const requireCjs = createRequire(import.meta.url);
const siteBindingApi = requireCjs('../../frontend/js/proposals/site-binding.js');

export const {
    DEFAULT_INTRUSION_TOLERANCE_M,
    INTRUSION_NOISE_M,
    MAX_INTRUSION_TOLERANCE_M,
    PARCEL_ACT_GOALS,
    COVERAGE,
    isParcelAct,
    requiresParcels,
    compareDeclaration
} = siteBindingApi;

// Input bounds for a site, checked before any SQL. A proposal site is at most a long corridor; the
// vertex cap matches the footprint cap, the extent cap (bbox) leaves room for a 20 km corridor.
export const MAX_SITE_VERTICES = 100000;
export const MAX_SITE_EXTENT_KM2 = 500;
// More bound or touched parcels than this is not a proposal (same cap as /parcels/under).
export const MAX_BINDING_PARCELS = 5000;
// City ids configured with no cadastre at all (frontend/js/city-config.js parcels.source 'none').
export const NO_CADASTRE_CITIES = Object.freeze(['explore']);

// Stable error codes. Routes put them in `code`; agent docs list them.
export const BINDING_CODES = Object.freeze({
    invalidSite: 'invalid-site',
    invalidTolerance: 'invalid-tolerance',
    tooManyParcels: 'too-many-parcels',
    footprintOutsideSite: 'footprint-outside-site',
    undeclaredParcels: 'undeclared-parcels', // bound by the site, missing from cadastreParcelIds
    unboundParcels: 'unbound-parcels', // in cadastreParcelIds, not bound by the site
    parcelsRequired: 'parcels-required',
    siteRequired: 'site-required'
});

export const SERVER_CADASTRE_SOURCE = 'server:hr-cadastre';

// Returns an error message, or null when `geometry` is a usable WGS84 site.
export function validateSiteGeometry(geometry) {
    const g = geometry && geometry.type === 'Feature' ? geometry.geometry : geometry;
    if (!g || typeof g !== 'object' || !['Polygon', 'MultiPolygon'].includes(g.type)) {
        return 'site must be a GeoJSON Polygon or MultiPolygon (EPSG:4326).';
    }
    const polygons = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
    if (!Array.isArray(polygons) || !polygons.length) return 'site has no coordinates.';
    let vertices = 0;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const rings of polygons) {
        if (!Array.isArray(rings) || !rings.length) return 'site has an empty polygon.';
        for (const ring of rings) {
            if (!Array.isArray(ring) || ring.length < 4) return 'Every site ring needs at least 4 positions.';
            vertices += ring.length;
            if (vertices > MAX_SITE_VERTICES) return `site has more than ${MAX_SITE_VERTICES} vertices.`;
            for (const position of ring) {
                const x = Array.isArray(position) ? position[0] : undefined;
                const y = Array.isArray(position) ? position[1] : undefined;
                if (typeof x !== 'number' || !Number.isFinite(x) || typeof y !== 'number' || !Number.isFinite(y)) {
                    return 'site coordinates must be finite numbers.';
                }
                if (x < minX) minX = x;
                if (y < minY) minY = y;
                if (x > maxX) maxX = x;
                if (y > maxY) maxY = y;
            }
        }
    }
    if (minX < -180 || maxX > 180 || minY < -90 || maxY > 90) return 'site coordinates are out of WGS84 range.';
    const extentKm2 = wgs84BboxAreaKm2(minX, minY, maxX, maxY);
    if (extentKm2 > MAX_SITE_EXTENT_KM2) {
        return `site extent ${Math.round(extentKm2)} km² exceeds ${MAX_SITE_EXTENT_KM2} km².`;
    }
    return null;
}

export function normalizeSiteGeometry(geometry) {
    const g = geometry && geometry.type === 'Feature' ? geometry.geometry : geometry;
    return g.type === 'MultiPolygon'
        ? { type: 'MultiPolygon', coordinates: g.coordinates }
        : { type: 'MultiPolygon', coordinates: [g.coordinates] };
}

// Returns { ok: true, value } or { ok: false, error } for a request's toleranceM.
export function parseTolerance(value) {
    if (value === undefined || value === null) return { ok: true, value: DEFAULT_INTRUSION_TOLERANCE_M };
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_INTRUSION_TOLERANCE_M) {
        return { ok: false, error: `toleranceM must be a number of metres between 0 and ${MAX_INTRUSION_TOLERANCE_M}.` };
    }
    return { ok: true, value };
}

// The site as footprint-style query params ($1 polygons, $2 buffered centrelines).
export function siteQueryParams({ site, parts }) {
    if (site) return [JSON.stringify([normalizeSiteGeometry(site)]), '[]'];
    return footprintQueryParams(parts);
}

// $1/$2 as PARCEL_OVERLAP_SQL (footprint.js): the site in EPSG:3765, valid, unioned.
const SITE_CTE = `
    parts AS (
        SELECT ST_CollectionExtract(ST_MakeValid(ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(value), 4326), 3765)), 3) AS geom
        FROM jsonb_array_elements_text($1::jsonb)
        UNION ALL
        SELECT ST_Buffer(ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(value->>'line'), 4326), 3765),
                         (value->>'halfWidthM')::float8, 'endcap=flat join=round') AS geom
        FROM jsonb_array_elements($2::jsonb)
    ), site AS (
        SELECT ST_CollectionExtract(ST_MakeValid(ST_UnaryUnion(ST_Collect(geom))), 3) AS g
        FROM parts WHERE NOT ST_IsEmpty(geom)
    )`;

export const BINDING_COUNT_SQL = `
    WITH ${SITE_CTE}
    SELECT count(*)::int AS parcels
    FROM site s JOIN parcel p ON p.current = true AND p.geom && s.g AND ST_Intersects(p.geom, s.g)
`;

// One statement, $3 = max(toleranceM, INTRUSION_NOISE_M):
//   candidates   current parcels whose geometry meets the site (GiST: && then ST_Intersects);
//   hits         site ∩ parcel per id (a duplicated current id keeps its largest piece);
//   search       the bisection on the inward-buffer radius, bracket [0, sqrt(area/π)], stopping at
//                max(0.5 mm, 0.05 % of r) — byte-for-byte the loop in site-binding.js;
//   bound        the rule itself: the intersection survives ST_Buffer(-$3/2);
//   open ground  site minus every candidate parcel, split by the union of the cadastral
//                municipalities the site meets: inside = unsurveyed, outside = unknown. A component
//                counts only if it survives the same inward buffer (micro-gaps are not ground).
// Absolute areas are measured on the ellipsoid (geography), lengths in EPSG:3765 metres.
export const BINDING_SQL = `
    WITH RECURSIVE ${SITE_CTE},
    region AS (
        SELECT ST_UnaryUnion(ST_Collect(ST_MakeValid(k.geom))) AS g
        FROM cadastral_municipality k, site s
        WHERE k.geom && s.g AND ST_Intersects(k.geom, s.g)
    ), candidates AS (
        SELECT 'HR-' || p.maticni_broj_ko || '-' || p.broj_cestice AS id, ST_MakeValid(p.geom) AS pg
        FROM site s JOIN parcel p ON p.current = true AND p.geom && s.g AND ST_Intersects(p.geom, s.g)
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
        CROSS JOIN LATERAL (SELECT NOT ST_IsEmpty(ST_Buffer(s.i, -m.mid)) AS ok) b
        WHERE s.hi - s.lo > greatest(0.0005, s.lo * 0.0005) AND s.n < 60
    ), widths AS (
        SELECT DISTINCT ON (id) id, lo + hi AS intrusion_m FROM search ORDER BY id, n DESC
    ), measured AS (
        SELECT h.id,
               ST_Area(ST_Transform(h.i, 4326)::geography) AS overlap_m2,
               w.intrusion_m,
               NOT ST_IsEmpty(ST_Buffer(h.i, -$3::float8 / 2)) AS bound
        FROM hits h JOIN widths w USING (id)
    ), open_ground AS (
        SELECT ST_Difference(s.g, COALESCE((SELECT ST_UnaryUnion(ST_Collect(pg)) FROM candidates),
                                           ST_GeomFromText('POLYGON EMPTY', 3765))) AS g
        FROM site s
    ), split AS (
        SELECT ST_CollectionExtract(ST_Intersection(o.g, r.g), 3) AS inside,
               ST_CollectionExtract(ST_Difference(o.g, r.g), 3) AS outside
        FROM open_ground o, region r
    )
    SELECT
        (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                    'parcelId', id, 'overlapM2', overlap_m2, 'intrusionM', intrusion_m, 'bound', bound
                ) ORDER BY id), '[]'::jsonb) FROM measured) AS parcels,
        (SELECT ST_Area(ST_Transform(g, 4326)::geography) FROM site) AS site_m2,
        (SELECT g IS NOT NULL FROM region) AS in_region,
        (SELECT COALESCE(sum(ST_Area(ST_Transform(d.geom, 4326)::geography)), 0)
           FROM split, ST_Dump(split.inside) d
          WHERE NOT ST_IsEmpty(ST_Buffer(d.geom, -$3::float8 / 2))) AS unsurveyed_m2,
        (SELECT COALESCE(sum(ST_Area(ST_Transform(d.geom, 4326)::geography)), 0)
           FROM split, ST_Dump(split.outside) d
          WHERE NOT ST_IsEmpty(ST_Buffer(d.geom, -$3::float8 / 2))) AS unknown_m2,
        (SELECT ST_AsGeoJSON(ST_Multi(ST_Transform(g, 4326)), 9) FROM site WHERE g IS NOT NULL AND NOT ST_IsEmpty(g)) AS site_geojson
`;

// The authored footprint must lie inside an authored site: footprint − site may only leave
// components no wider than the noise floor. $3 = site GeoJSON, $4 = floor.
export const FOOTPRINT_OUTSIDE_SITE_SQL = `
    WITH ${SITE_CTE},
    authored AS (
        SELECT ST_CollectionExtract(ST_MakeValid(ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON($3), 4326), 3765)), 3) AS g
    )
    SELECT COALESCE(sum(ST_Area(ST_Transform(d.geom, 4326)::geography)), 0) AS outside_m2
    FROM site s, authored a, ST_Dump(ST_CollectionExtract(ST_Difference(s.g, a.g), 3)) d
    WHERE NOT ST_IsEmpty(ST_Buffer(d.geom, -$4::float8 / 2))
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

const HR_PARCEL_ID = /^HR-(\d+)-(.+)$/;

export function parseHrParcelId(id) {
    const match = typeof id === 'string' ? HR_PARCEL_ID.exec(id) : null;
    return match ? { id, ko: Number(match[1]), number: match[2] } : null;
}

const round = (value, digits) => {
    const f = Math.pow(10, digits);
    return Math.round(Number(value) * f) / f;
};

function bindingError(code, message, status = 400, extra = {}) {
    const error = new Error(message);
    error.code = code;
    error.status = status;
    Object.assign(error, extra);
    return error;
}

export function isBindingError(error) {
    return !!error && Object.values(BINDING_CODES).includes(error.code) && Number.isInteger(error.status);
}

function unboundBinding({ coverage, toleranceM, siteM2, reason, parcels = [], computedAt }) {
    return {
        parcels,
        touched: [],
        toleranceM,
        coverage,
        unsurveyedM2: coverage === COVERAGE.none ? round(siteM2 || 0, 2) : 0,
        unknownM2: coverage === COVERAGE.unknown ? round(siteM2 || 0, 2) : 0,
        siteM2: round(siteM2 || 0, 2),
        source: SERVER_CADASTRE_SOURCE,
        computedAt,
        reason
    };
}

/**
 * The server binding of a site.
 * @param db pg pool/client
 * @param {{ site?: object, parts?: object, toleranceM?: number, city?: string|null, now?: () => Date }} input
 *   either an authored `site` (GeoJSON, EPSG:4326) or footprint `parts` (footprint.js).
 * @returns {Promise<{ binding: object, site: object|null }>} binding as in site-binding.js plus
 *   `unknownM2` (site area outside every cadastral municipality), `computedAt` and, for
 *   'unknown'/'none', a `reason`. `site` is the unioned site as stored (MultiPolygon, 9 decimals).
 * Throws a binding error (code, status) for a site over MAX_BINDING_PARCELS.
 */
export async function computeBinding(db, { site = null, parts = null, toleranceM = DEFAULT_INTRUSION_TOLERANCE_M, city = null, now = () => new Date() } = {}) {
    const params = siteQueryParams({ site, parts });
    const floorM = Math.max(toleranceM, INTRUSION_NOISE_M);
    const counted = Number((await db.query(BINDING_COUNT_SQL, params)).rows[0]?.parcels || 0);
    if (counted > MAX_BINDING_PARCELS) {
        throw bindingError(BINDING_CODES.tooManyParcels,
            `The site meets ${counted} parcels, over the ${MAX_BINDING_PARCELS} limit.`, 413, { count: counted });
    }
    const row = (await db.query(BINDING_SQL, [...params, floorM])).rows[0] || {};
    const computedAt = now().toISOString();
    const siteGeometry = row.site_geojson ? JSON.parse(row.site_geojson) : null;
    if (!siteGeometry) {
        throw bindingError(BINDING_CODES.invalidSite, 'The site has no area after validation.');
    }
    const siteM2 = Number(row.site_m2) || 0;
    if (!row.in_region) {
        const none = city && NO_CADASTRE_CITIES.includes(String(city));
        return {
            site: siteGeometry,
            binding: unboundBinding({
                coverage: none ? COVERAGE.none : COVERAGE.unknown,
                toleranceM,
                siteM2,
                computedAt,
                reason: none
                    ? 'This city has no cadastre: the whole site is open ground.'
                    : 'The site is outside every cadastral municipality the server holds; its cadastre cannot be bound here.'
            })
        };
    }
    const measured = Array.isArray(row.parcels) ? row.parcels : [];
    const entry = hit => ({
        parcelId: String(hit.parcelId),
        overlapM2: round(hit.overlapM2, 3),
        intrusionM: round(hit.intrusionM, 4)
    });
    const unsurveyedM2 = round(row.unsurveyed_m2 || 0, 2);
    const unknownM2 = round(row.unknown_m2 || 0, 2);
    return {
        site: siteGeometry,
        binding: {
            parcels: measured.filter(hit => hit.bound).map(entry),
            touched: measured.filter(hit => !hit.bound).map(entry),
            toleranceM,
            coverage: unsurveyedM2 > 0 || unknownM2 > 0 ? COVERAGE.partial : COVERAGE.complete,
            unsurveyedM2,
            unknownM2,
            siteM2: round(siteM2, 2),
            source: SERVER_CADASTRE_SOURCE,
            computedAt
        }
    };
}

/**
 * The binding of a parcel act with no geometry of its own: its site IS its declared parcels, so the
 * binding is the declaration by construction. The server only checks that every declared id is a
 * current HR parcel (unknown ids come back as `extra`). Declarations naming non-HR parcels cannot be
 * verified here: coverage 'unknown', declaration kept as sent.
 */
export async function parcelActBinding(db, declaredIds, { toleranceM = DEFAULT_INTRUSION_TOLERANCE_M, now = () => new Date() } = {}) {
    const computedAt = now().toISOString();
    const parsed = declaredIds.map(parseHrParcelId);
    if (parsed.some(value => !value)) {
        return {
            site: null,
            extra: [],
            binding: unboundBinding({
                coverage: COVERAGE.unknown,
                toleranceM,
                siteM2: 0,
                computedAt,
                parcels: declaredIds.map(id => ({ parcelId: String(id), overlapM2: null, intrusionM: null })),
                reason: 'The declared parcels are not in a cadastre the server holds; the declaration is kept unverified.'
            })
        };
    }
    const row = (await db.query(PARCEL_ACT_SITE_SQL, [JSON.stringify(parsed)])).rows[0] || {};
    const found = (Array.isArray(row.parcels) ? row.parcels : []).map(hit => ({
        parcelId: String(hit.parcelId),
        overlapM2: round(hit.overlapM2, 3),
        intrusionM: null
    }));
    const foundIds = new Set(found.map(hit => hit.parcelId));
    return {
        site: row.site_geojson ? JSON.parse(row.site_geojson) : null,
        extra: declaredIds.filter(id => !foundIds.has(id)).sort(),
        binding: {
            parcels: found,
            touched: [],
            toleranceM,
            coverage: COVERAGE.complete,
            unsurveyedM2: 0,
            unknownM2: 0,
            siteM2: round(row.site_m2 || 0, 2),
            source: SERVER_CADASTRE_SOURCE,
            computedAt,
            subject: 'declared-parcels'
        }
    };
}

const describeMissing = hit => ({ id: hit.parcelId, overlapM2: round(hit.overlapM2, 1), intrusionM: round(hit.intrusionM, 3) });

/**
 * The strict land rule for a new record (generalised from "every covered parcel must be declared"):
 * cadastreParcelIds must EQUAL the server binding of the record's site at its toleranceM.
 *   - site: the authored `site` if sent (the footprint must lie inside it), else the footprint, else
 *     (parcel act without geometry) the declared parcels;
 *   - parcel acts need a non-empty binding;
 *   - coverage 'unknown' (cadastre not held here): the declaration is accepted unverified.
 * @returns {Promise<{ ok: true, site, binding } | { ok: false, status, code, error, missing?, extra?, parcels? }>}
 */
export async function checkProposalBinding(db, proposal, declaredIds, { site = null, toleranceM = DEFAULT_INTRUSION_TOLERANCE_M, city = null, now } = {}) {
    const declared = (declaredIds || []).map(String);
    const parts = footprintParts(proposal);
    if (parts.invalid) {
        return { ok: false, status: 400, code: INVALID_FOOTPRINT, error: `Proposal geometry is invalid: ${parts.invalid}.` };
    }
    const withSite = site ? { ...proposal, site } : proposal;
    const needsParcels = requiresParcels(withSite);
    if (needsParcels && !declared.length) {
        return {
            ok: false,
            status: 400,
            code: BINDING_CODES.parcelsRequired,
            error: 'This proposal acts on parcels (offer, ownership transfer, vote, road designation, or no geometry of its own): cadastreParcelIds must name them.'
        };
    }

    let result;
    if (site) {
        if (hasFootprint(parts)) {
            const floorM = Math.max(toleranceM, INTRUSION_NOISE_M);
            const [polygons, lines] = footprintQueryParams(parts);
            const outside = Number((await db.query(FOOTPRINT_OUTSIDE_SITE_SQL,
                [polygons, lines, JSON.stringify(normalizeSiteGeometry(site)), floorM])).rows[0]?.outside_m2 || 0);
            if (outside > 0) {
                return {
                    ok: false,
                    status: 400,
                    code: BINDING_CODES.footprintOutsideSite,
                    error: `The proposal's geometry reaches ${round(outside, 1)} m² outside its site. Keep the design inside the site, or widen the site.`
                };
            }
        }
        result = await computeBinding(db, { site, toleranceM, city, now });
        // The authored site is stored as sent (normalised), not the reprojected union.
        result.site = normalizeSiteGeometry(site);
    } else if (hasFootprint(parts)) {
        result = await computeBinding(db, { parts, toleranceM, city, now });
    } else {
        const act = await parcelActBinding(db, declared, { toleranceM, now });
        if (act.extra.length) {
            return {
                ok: false,
                status: 400,
                code: BINDING_CODES.unboundParcels,
                error: `cadastreParcelIds names ${act.extra.length} parcel(s) that are not current cadastral parcels: ${act.extra.join(', ')}.`,
                missing: [],
                extra: act.extra.map(id => ({ id }))
            };
        }
        return { ok: true, site: act.site, binding: act.binding };
    }

    const { binding } = result;
    if (binding.coverage === COVERAGE.unknown) {
        binding.parcels = declared.map(id => ({ parcelId: id, overlapM2: null, intrusionM: null }));
        binding.subject = 'declared-unverified';
        return { ok: true, site: result.site, binding };
    }
    if (needsParcels && !binding.parcels.length) {
        return {
            ok: false,
            status: 400,
            code: BINDING_CODES.parcelsRequired,
            error: 'This proposal acts on parcels, but its site lies on no cadastral parcel.'
        };
    }
    const { missing, extra } = compareDeclaration(declared, binding);
    if (missing.length || extra.length) {
        const bound = new Map(binding.parcels.map(hit => [hit.parcelId, hit]));
        const touched = new Map(binding.touched.map(hit => [hit.parcelId, hit]));
        const missingHits = missing.map(id => describeMissing(bound.get(id)));
        const extraHits = extra.map(id => {
            const hit = touched.get(id);
            return hit ? { id, intrusionM: round(hit.intrusionM, 4) } : { id, intrusionM: 0 };
        });
        const parts = [];
        if (missing.length) parts.push(`the site reaches into ${missing.length} parcel(s) not in cadastreParcelIds: ${missing.join(', ')}`);
        if (extra.length) parts.push(`cadastreParcelIds names ${extra.length} parcel(s) the site does not reach into at tolerance ${binding.toleranceM} m: ${extra.join(', ')}`);
        return {
            ok: false,
            status: 400,
            code: missing.length ? BINDING_CODES.undeclaredParcels : BINDING_CODES.unboundParcels,
            error: `The declaration must equal the site's binding: ${parts.join('; ')}. Declare exactly the bound parcels, or change the design.`,
            missing: missingHits,
            extra: extraHits,
            // Kept for clients of the old undeclared-parcels refusal.
            parcels: missingHits.map(hit => ({ id: hit.id, overlapM2: hit.overlapM2 }))
        };
    }
    return { ok: true, site: result.site, binding };
}
