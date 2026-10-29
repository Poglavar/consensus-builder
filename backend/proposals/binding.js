// Server side of a proposal's site → parcel binding (PARCEL-OPTIONAL.md): which cadastral parcels a
// site reaches into, how far (intrusion width), and how much of the site is open ground. The server
// runs the browser's own function (frontend/js/proposals/site-binding.js bindingFromParcels) over the
// candidate parcels its source finds (parcels/source-binding.js), so the two cannot disagree
// (docs/geometry-tolerances.md). The site is the browser's too (site-binding.js siteOf: the authored
// site, else the union of the record's own footprint), and so is the footprint-inside-site test
// (geometry-tolerances.js uncoveredBy + isGround).
//
// Every source finds candidates its own way: the Croatian cadastre (`parcel`, countrywide, ids
// HR-<ko>-<number>) by an indexed PostGIS search that also reports the cadastral municipalities the
// site meets (parcels/oss-binding-source.js); imported NYC footprints and executable live sources by
// their adapters. A site outside every cadastral municipality gets coverage 'unknown' — the server
// cannot see that region's cadastre, which is not the same as there being none — except for an
// explicit 'none' source selection, which gets 'none'.
//
// Used by the design index (the parcels a published design's site takes), the agents' candidate
// preflight and the site migration.

import { createRequire } from 'node:module';
import { INVALID_FOOTPRINT, footprintParts, hasFootprint } from './footprint.js';
import { wgs84BboxAreaKm2 } from '../utils/helpers.js';
import { parcelSourceById } from '../parcels/sources.js';
import { computeSourceBinding, computeSourceParcelActBinding, MAX_SOURCE_BINDING_PARCELS } from '../parcels/source-binding.js';

import { NYC_DATABASE_SOURCE_ID } from '../parcels/nyc-database-source.js';
import { openDatabaseParcelSource } from '../parcels/database-sources.js';
import { HR_CADASTRE_SOURCE_ID, parseHrParcelId } from '../parcels/oss-binding-source.js';
export { parseHrParcelId };

const requireCjs = createRequire(import.meta.url);
const siteBindingApi = requireCjs('../../frontend/js/proposals/site-binding.js');
const ground = requireCjs('../../frontend/js/geometry-tolerances.js');
const planOrder = requireCjs('../../frontend/js/proposals/plan-order.js');
const turf = requireCjs('@turf/turf');
const metricFrame = requireCjs('../../frontend/js/metric-frame.js');

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
// More candidate parcels than this is not a proposal (same cap as /parcels/under).
export const MAX_BINDING_PARCELS = MAX_SOURCE_BINDING_PARCELS;


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

export const SERVER_CADASTRE_SOURCE = `server:${HR_CADASTRE_SOURCE_ID}`;

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

// The metric frame of a site (or of a footprint's parts): refuses a site outside the frame's domain
// (|lat| > 85°, more than 60 km from its anchor) as an invalid site, before anything is read.
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

// The selected source as { descriptor, adapter }, or null for an explicit 'none'. The imported HR
// cadastre ('oss-wfs') records its parcels as 'hr-cadastre'.
function bindingSource(db, sourceId) {
    if (sourceId === 'oss-wfs') return { descriptor: { id: HR_CADASTRE_SOURCE_ID }, adapter: openDatabaseParcelSource(sourceId, db) };
    if (sourceId === NYC_DATABASE_SOURCE_ID) return { descriptor: { id: sourceId }, adapter: openDatabaseParcelSource(sourceId, db) };
    if (sourceId === 'none') return null;
    return parcelSourceById(sourceId);
}

/**
 * The server binding of a site: the selected source's candidate parcels, decided by site-binding.js.
 * @param db pg pool/client
 * @param {{ site: object, toleranceM?: number, city?: string|null, parcelSourceId?: string|null, now?: () => Date }} input
 *   `site` GeoJSON Polygon/MultiPolygon, EPSG:4326.
 * @returns {Promise<{ binding: object, site: object }>} binding as in site-binding.js plus
 *   `computedAt` and, for 'unknown'/'none', a `reason`. `site` is the site as bound (MultiPolygon,
 *   on the 9-decimal grid).
 * Throws a binding error (code, status) for a site over MAX_BINDING_PARCELS candidates.
 */
export async function computeBinding(db, { site, toleranceM = DEFAULT_INTRUSION_TOLERANCE_M, city = null, parcelSourceId = null, now = () => new Date() } = {}) {
    if (!site) throw bindingError(BINDING_CODES.invalidSite, 'The site has no area.');
    const provider = bindingSource(db, parcelSourceId);
    if (!provider) {
        const footprint = ground.snapGeometry(normalizeSiteGeometry(site));
        const siteM2 = turf.area(turf.feature(footprint));
        return { site: footprint, binding: unboundBinding({ coverage: COVERAGE.none, toleranceM,
            siteM2, computedAt: now().toISOString(), reason: 'The consumer explicitly selected no cadastral source.' }) };
    }
    const result = await computeSourceBinding(provider.adapter, {
        site, toleranceM, sourceId: provider.descriptor.id,
        snapshotId: provider.descriptor.snapshotId || null, now
    });
    if (result.binding.coverage !== COVERAGE.unknown) return result;
    return {
        site: result.site,
        binding: unboundBinding({
            coverage: COVERAGE.unknown,
            toleranceM,
            siteM2: result.binding.siteM2,
            computedAt: result.binding.computedAt,
            reason: 'The site is outside every cadastral municipality in the selected dataset; its cadastre cannot be bound here.'
        })
    };
}

/**
 * The binding of a parcel act with no geometry of its own: its site IS its declared parcels, so the
 * binding is the declaration by construction. The selected source resolves the ids (an id it does
 * not hold as a current parcel comes back as `extra`).
 */
export async function parcelActBinding(db, declaredIds, { toleranceM = DEFAULT_INTRUSION_TOLERANCE_M, city = null, parcelSourceId = null, now = () => new Date() } = {}) {
    const provider = bindingSource(db, parcelSourceId);
    if (provider) return computeSourceParcelActBinding(provider.adapter, declaredIds, {
        toleranceM, sourceId: provider.descriptor.id, snapshotId: provider.descriptor.snapshotId || null, now
    });
    return { site: null, extra: declaredIds.map(String), binding: unboundBinding({
        coverage: COVERAGE.none, toleranceM, siteM2: 0, computedAt: now().toISOString(),
        reason: 'No cadastral source was selected for these declared parcels.' }) };
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
        return { ok: false, status: 400, code: INVALID_FOOTPRINT, error: `Design geometry is invalid: ${parts.invalid}.` };
    }
    const withSite = site ? { ...proposal, site } : proposal;
    const needsParcels = requiresParcels(withSite);
    if (needsParcels && !declared.length) {
        return {
            ok: false,
            status: 400,
            code: BINDING_CODES.parcelsRequired,
            error: 'This design acts on parcels (offer, ownership transfer, vote, road designation, or no geometry of its own): cadastreParcelIds must name them.'
        };
    }

    // The consumer supplies record metadata and source selection. The backend never replaces either.
    let publicationCity = city || null;
    if (site || hasFootprint(parts)) {
        ({ city: publicationCity, parcelSourceId } = publicationCityOf({ site, parts: site ? null : parts, city, parcelSourceId }));
    }

    let result;
    if (site || hasFootprint(parts)) {
        // A legacy centre line is buffered only by the browser's corridor builder; the server has
        // no second way to build its land.
        if (parts.centerline) {
            return { ok: false, status: 400, code: INVALID_FOOTPRINT,
                error: 'The road has only a legacy centre line: its corridor land (roadProposal.definition.polygon) must be rebuilt before it can be bound.' };
        }
        // The browser's site (site-binding.js siteOf) and footprint (plan-order.js footprintOf) on the grid.
        const footprint = hasFootprint(parts) ? planOrder.footprintOf(withSite, { turf }) : null;
        const siteGeometry = site ? normalizeSiteGeometry(site) : siteBindingApi.siteOf(withSite, { turf });
        if (!siteGeometry) throw bindingError(BINDING_CODES.invalidSite, 'The site has no area.');
        if (site && footprint) {
            // The footprint lies inside the authored site, as the browser checks it (proposal-manager.js
            // _footprintInsideSite): what the site leaves of it must not be ground.
            const outside = ground.uncoveredBy(turf, ground.snapFeature(footprint), [turf.feature(ground.snapGeometry(siteGeometry))],
                { site: 'binding.footprintInsideSite' });
            if (ground.isGround(turf, outside, toleranceM)) {
                const outsideM2 = turf.area(outside);
                return {
                    ok: false,
                    status: 400,
                    code: BINDING_CODES.footprintOutsideSite,
                    error: `The design extends ${round(outsideM2, 1)} m² beyond its saved land boundary. Edit the design's land boundary to include this area, or move the geometry inside it.`,
                    outsideM2: round(outsideM2, 1),
                    outsideGeometry: outside.geometry,
                    site: siteGeometry
                };
            }
        }
        result = await computeBinding(db, { site: siteGeometry, toleranceM, city: publicationCity, parcelSourceId, now });
        // The authored site is stored as sent (normalised), not as bound on the grid.
        if (site) result.site = siteGeometry;
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
            error: 'This design acts on parcels, but its land boundary lies on no cadastral parcel.'
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
