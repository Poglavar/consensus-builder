// Server side of a proposal's site → parcel binding (PARCEL-OPTIONAL.md): which cadastral parcels a
// site reaches into, how far (intrusion width), and how much of the site is open ground. PostGIS
// over the full cadastre mirrors the pure rule in frontend/js/proposals/site-binding.js exactly:
// bound ⇔ site ∩ parcel survives ST_Buffer(-max(toleranceM, noise)/2); intrusion is found by the
// same inward-buffer bisection (not ST_MaximumInscribedCircle, whose fixed tolerance of 1/1000 of
// the extent mis-measures a long thin sliver, and which needs GEOS >= 3.9).
//
// Every metric operation runs in the site's own operation frame (projections.md §2 and §4): a local
// transverse Mercator at the site's canonical anchor, passed to PostGIS as its canonical projection
// string. The dataset CRS (EPSG:3765 for the HR cadastre) is used only for the indexed candidate
// search. Source edges are split before transforming — the site's into ≤ SEGMENT_DEG pieces (its
// edges are straight in lon/lat), the cadastre's into ≤ 50 m pieces (straight in 3765) — so no
// transformed edge strays by more than a micrometre. Buffers use 64 segments per quarter circle
// (0.0075 % of the radius). A parcel whose intrusion lies within BINDING_UNCERTAINTY of the
// threshold is reported as `unresolved`, never silently bound or unbound, and a publish refuses it.
//
// The Croatian cadastre (`parcel`, countrywide, ids HR-<ko>-<number>) uses PostGIS. Imported NYC
// footprints and executable live sources resolve their own parcels and use the shared binding rule. A site
// outside every cadastral municipality (`cadastral_municipality`) gets coverage 'unknown' — the
// server cannot see that region's cadastre, which is not the same as there being none — except for
// an explicit 'none' source selection, which gets 'none'.
//
// Used by the design index (the parcels a published design's site takes), the agents' candidate
// preflight and the site migration.

import { createRequire } from 'node:module';
import { INVALID_FOOTPRINT, footprintParts, footprintQueryParams, hasFootprint } from './footprint.js';
import { wgs84BboxAreaKm2 } from '../utils/helpers.js';
import { parcelSourceById } from '../parcels/sources.js';
import { computeSourceBinding, computeSourceParcelActBinding } from '../parcels/source-binding.js';

import { NYC_DATABASE_SOURCE_ID } from '../parcels/nyc-database-source.js';
import { openDatabaseParcelSource } from '../parcels/database-sources.js';

import { HR_PARCEL_SRID, SEGMENT_DEG, DATASET_SEGMENT_M, CANDIDATE_SLACK_M, BINDING_COUNT_SQL, BINDING_SQL, FOOTPRINT_OUTSIDE_SITE_SQL, FOOTPRINT_SITE_SQL, PARCEL_ACT_SITE_SQL } from '../parcels/oss-binding-source.js';
export { HR_PARCEL_SRID, SEGMENT_DEG, DATASET_SEGMENT_M, CANDIDATE_SLACK_M, BINDING_COUNT_SQL, BINDING_SQL, FOOTPRINT_OUTSIDE_SITE_SQL, FOOTPRINT_SITE_SQL, PARCEL_ACT_SITE_SQL };

const requireCjs = createRequire(import.meta.url);
const siteBindingApi = requireCjs('../../frontend/js/proposals/site-binding.js');
const turf = requireCjs('@turf/turf');
const metricFrame = requireCjs('../../frontend/js/metric-frame.js');

// The decision band around a binding threshold r (= floor / 2): projection scale ≤ 5e-5, polygonised
// buffer arcs ≤ 7.5e-5, plus a micrometre of arithmetic. Within it the answer is `unresolved`.
export const BINDING_UNCERTAINTY = Object.freeze({ RELATIVE: 1.5e-4, ABSOLUTE_M: 1e-6 });
export const bindingUncertaintyM = radiusM => Math.max(BINDING_UNCERTAINTY.ABSOLUTE_M, radiusM * BINDING_UNCERTAINTY.RELATIVE);

export const {
    DEFAULT_INTRUSION_TOLERANCE_M,
    INTRUSION_NOISE_M,
    MAX_INTRUSION_TOLERANCE_M,
    COVERAGE,
    requiresParcels,
    compareDeclaration
} = siteBindingApi;

// Input bounds for a site, checked before any SQL. A proposal site is at most a long corridor; the
// vertex cap matches the footprint cap, the extent cap (bbox) leaves room for a 20 km corridor.
export const MAX_SITE_VERTICES = 100000;
export const MAX_SITE_EXTENT_KM2 = 500;
// More bound or touched parcels than this is not a proposal (same cap as /parcels/under).
export const MAX_BINDING_PARCELS = 5000;


// Stable error codes. Routes put them in `code`; agent docs list them.
export const BINDING_CODES = Object.freeze({
    invalidSite: 'invalid-site',
    invalidTolerance: 'invalid-tolerance',
    tooManyParcels: 'too-many-parcels',
    footprintOutsideSite: 'footprint-outside-site',
    undeclaredParcels: 'undeclared-parcels', // bound by the site, missing from cadastreParcelIds
    unboundParcels: 'unbound-parcels', // in cadastreParcelIds, not bound by the site
    parcelsRequired: 'parcels-required',
    siteRequired: 'site-required',
    unresolved: 'binding-unresolved' // an intrusion within the measurement band of the threshold
});

export const SERVER_CADASTRE_SOURCE = 'server:hr-cadastre';
const HR_PARCEL_SOURCE = Object.freeze({ sourceId: 'hr-cadastre', snapshotId: null });

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

// The operation frame of a binding: anchored on the site (or, for a footprint-only legacy record, on
// its parts). Refuses a site outside the frame's domain (|lat| > 85°, more than 60 km from its anchor)
// as an invalid site, before any SQL runs.
export function bindingFrame({ site = null, parts = null } = {}) {
    const input = site ? normalizeSiteGeometry(site) : [...(parts?.polygons || []), ...(parts?.centerline?.segments || [])];
    try {
        const frame = metricFrame.frameFor(input);
        frame.assertWithin(input);
        return frame;
    } catch (error) {
        throw bindingError(BINDING_CODES.invalidSite, `The site cannot be measured: ${String(error.message).replace(/^metric-frame: /, '')}.`);
    }
}

// A publication keeps the consumer's metadata and explicit source. Validate the geometry,
// but never substitute another source because the site lies in a configured city.
export function publicationCityOf({ site = null, parts = null, city = null, parcelSourceId = null } = {}) {
    bindingFrame({ site, parts });
    return { city, parcelSourceId };
}

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
        source: 'server:unbound',
        parcelSource: null,
        computedAt,
        reason
    };
}

function bindingSource(db, sourceId) {
    if (sourceId === NYC_DATABASE_SOURCE_ID || sourceId === 'oss-wfs') return {
        descriptor: { id: sourceId }, adapter: openDatabaseParcelSource(sourceId, db)
    };
    if (sourceId === 'none') return null;
    return parcelSourceById(sourceId);
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
export async function computeBinding(db, { site = null, parts = null, toleranceM = DEFAULT_INTRUSION_TOLERANCE_M, city = null, parcelSourceId = null, now = () => new Date() } = {}) {
    const params = siteQueryParams({ site, parts });
    const frame = bindingFrame({ site, parts });
    const provider = bindingSource(db, parcelSourceId);
    if (provider && typeof provider.adapter.bindingMeasurements !== 'function') {
        const footprint = site || JSON.parse((await db.query(FOOTPRINT_SITE_SQL, [...params, frame.proj])).rows[0]?.geometry || 'null');
        if (!footprint) throw bindingError(BINDING_CODES.invalidSite, 'The site has no area after validation.');
        return computeSourceBinding(provider.adapter, {
            site: footprint, toleranceM, sourceId: provider.descriptor.id,
            snapshotId: provider.descriptor.snapshotId || null, now
        });
    }
    if (parcelSourceId === 'none') {
        const footprint = site || JSON.parse((await db.query(FOOTPRINT_SITE_SQL, [...params, frame.proj])).rows[0]?.geometry || 'null');
        if (!footprint) throw bindingError(BINDING_CODES.invalidSite, 'The site has no area after validation.');
        const siteM2 = turf.area(turf.feature(footprint));
        return { site: footprint, binding: unboundBinding({ coverage: COVERAGE.none, toleranceM,
            siteM2, computedAt: now().toISOString(), reason: 'The consumer explicitly selected no cadastral source.' }) };
    }
    const floorM = Math.max(toleranceM, INTRUSION_NOISE_M);
    const cadastre = provider.adapter;
    const counted = Number(await cadastre.countBindingCandidates({ polygons: params[0], lines: params[1], projection: frame.proj }));
    if (counted > MAX_BINDING_PARCELS) {
        throw bindingError(BINDING_CODES.tooManyParcels,
            `The site meets ${counted} parcels, over the ${MAX_BINDING_PARCELS} limit.`, 413, { count: counted });
    }
    const row = await cadastre.bindingMeasurements({ polygons: params[0], lines: params[1], floorM,
        projection: frame.proj, uncertaintyM: bindingUncertaintyM(floorM / 2) });
    const computedAt = now().toISOString();
    const siteGeometry = row.site_geojson ? JSON.parse(row.site_geojson) : null;
    if (!siteGeometry) {
        throw bindingError(BINDING_CODES.invalidSite, 'The site has no area after validation.');
    }
    const siteM2 = Number(row.site_m2) || 0;
    if (!row.in_region) {
        return {
            site: siteGeometry,
            binding: unboundBinding({
                coverage: COVERAGE.unknown,
                toleranceM,
                siteM2,
                computedAt,
                reason: 'The site is outside every cadastral municipality in the selected dataset; its cadastre cannot be bound here.'
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
            touched: measured.filter(hit => !hit.bound && !hit.unresolved).map(entry),
            // Within the measurement band of the threshold: neither bound nor touched. A publish refuses.
            ...(measured.some(hit => hit.unresolved) ? { unresolved: measured.filter(hit => hit.unresolved).map(entry) } : {}),
            toleranceM,
            coverage: unsurveyedM2 > 0 || unknownM2 > 0 ? COVERAGE.partial : COVERAGE.complete,
            unsurveyedM2,
            unknownM2,
            siteM2: round(siteM2, 2),
            source: SERVER_CADASTRE_SOURCE,
            parcelSource: HR_PARCEL_SOURCE,
            computedAt
        }
    };
}

/**
 * The binding of a parcel act with no geometry of its own: its site IS its declared parcels, so the
 * binding is the declaration by construction. The server only checks that every declared id is a
 * current HR parcel (unknown ids come back as `extra`). Executable sources resolve their own IDs.
 * Other declarations remain unverified: coverage 'unknown', declaration kept as sent.
 */
export async function parcelActBinding(db, declaredIds, { toleranceM = DEFAULT_INTRUSION_TOLERANCE_M, city = null, parcelSourceId = null, now = () => new Date() } = {}) {
    const provider = bindingSource(db, parcelSourceId);
    if (provider && typeof provider.adapter.declaredParcelSite !== 'function') return computeSourceParcelActBinding(provider.adapter, declaredIds, {
        toleranceM, sourceId: provider.descriptor.id, snapshotId: provider.descriptor.snapshotId || null, now
    });
    const computedAt = now().toISOString();
    if (parcelSourceId === 'none') return { site: null, extra: declaredIds.map(String), binding: unboundBinding({
        coverage: COVERAGE.none, toleranceM, siteM2: 0, computedAt,
        reason: 'No cadastral source was selected for these declared parcels.' }) };
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
    const row = await provider.adapter.declaredParcelSite({ parcels: parsed });
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
            parcelSource: HR_PARCEL_SOURCE,
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
 *   - coverage 'unknown' (cadastre not held here): the declaration is accepted unverified;
 *   - `city` is the publication's city and `parcelSourceId` the source that bound it, both placed by
 *     its site (publicationCityOf); a parcel act is placed where its parcels are.
 * @returns {Promise<{ ok: true, site, binding, city, parcelSourceId } | { ok: false, status, code, error, missing?, extra?, parcels? }>}
 */
// `derive: true`: a material proposal's declaration is not compared but
// DERIVED from the binding and returned as `cadastreParcelIds`; parcel acts still name their parcels.
export async function checkProposalBinding(db, proposal, declaredIds, { site = null, toleranceM = DEFAULT_INTRUSION_TOLERANCE_M, city = null, parcelSourceId = null, now, derive = false } = {}) {
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

    // The consumer supplies record metadata and source selection. The backend never replaces either.
    let publicationCity = city || null;
    if (site || hasFootprint(parts)) {
        ({ city: publicationCity, parcelSourceId } = publicationCityOf({ site, parts: site ? null : parts, city, parcelSourceId }));
    }

    let result;
    if (site) {
        if (hasFootprint(parts)) {
            const floorM = Math.max(toleranceM, INTRUSION_NOISE_M);
            const [polygons, lines] = footprintQueryParams(parts);
            const frame = bindingFrame({ site });
            const outside = Number((await db.query(FOOTPRINT_OUTSIDE_SITE_SQL,
                [polygons, lines, JSON.stringify(normalizeSiteGeometry(site)), floorM, frame.proj])).rows[0]?.outside_m2 || 0);
            if (outside > 0) {
                return {
                    ok: false,
                    status: 400,
                    code: BINDING_CODES.footprintOutsideSite,
                    error: `The proposal's geometry reaches ${round(outside, 1)} m² outside its site. Keep the design inside the site, or widen the site.`
                };
            }
        }
        result = await computeBinding(db, { site, toleranceM, city: publicationCity, parcelSourceId, now });
        // The authored site is stored as sent (normalised), not the reprojected union.
        result.site = normalizeSiteGeometry(site);
    } else if (hasFootprint(parts)) {
        result = await computeBinding(db, { parts, toleranceM, city: publicationCity, parcelSourceId, now });
    } else {
        const act = await parcelActBinding(db, declared, { toleranceM, city, parcelSourceId, now });
        // an act naming no city is placed where its parcels are
        if (!publicationCity && act.site) publicationCity = publicationCityOf({ site: act.site, city: null }).city;
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
        return { ok: true, site: act.site, binding: act.binding, city: publicationCity, parcelSourceId, ...(derive ? { cadastreParcelIds: declared.slice().sort() } : {}) };
    }

    const { binding } = result;
    if (Array.isArray(binding.unresolved) && binding.unresolved.length) {
        const ids = binding.unresolved.map(hit => hit.parcelId);
        return {
            ok: false,
            status: 409,
            code: BINDING_CODES.unresolved,
            error: `The site reaches into ${ids.join(', ')} by within measurement error of the ${binding.toleranceM} m tolerance, so whether it binds cannot be decided. Move the design a millimetre into or away from ${ids.length === 1 ? 'that parcel' : 'those parcels'}.`,
            unresolved: binding.unresolved.map(hit => ({ id: hit.parcelId, intrusionM: hit.intrusionM }))
        };
    }
    if (binding.coverage === COVERAGE.unknown) {
        binding.parcels = declared.map(id => ({ parcelId: id, overlapM2: null, intrusionM: null }));
        binding.subject = 'declared-unverified';
        return { ok: true, site: result.site, binding, city: publicationCity, parcelSourceId, ...(derive ? { cadastreParcelIds: declared } : {}) };
    }
    if (needsParcels && !binding.parcels.length) {
        return {
            ok: false,
            status: 400,
            code: BINDING_CODES.parcelsRequired,
            error: 'This proposal acts on parcels, but its site lies on no cadastral parcel.'
        };
    }
    if (derive && !needsParcels) {
        return { ok: true, site: result.site, binding, city: publicationCity, parcelSourceId, cadastreParcelIds: binding.parcels.map(hit => String(hit.parcelId)).sort() };
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
    return { ok: true, site: result.site, binding, city: publicationCity, parcelSourceId, ...(derive ? { cadastreParcelIds: declared.slice().sort() } : {}) };
}
