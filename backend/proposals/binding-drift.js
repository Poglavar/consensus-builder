// Binding drift of a published record (PARCEL-OPTIONAL.md rule 5): recompute the binding of the
// record's STORED site at the record's own tolerance against today's cadastre and compare it with
// the binding fixed at publish. A read: nothing is written, the record stays as published; a
// re-bind is a new derived record published through the ordinary create path.
//
// Parcel acts with no geometry of their own (binding subject 'declared-parcels') are re-checked as
// such: their parcels either are still current cadastral parcels or have gone (removed); nothing
// can be added to a transfer of named titles. Used by GET /proposals/:id/binding-drift.

import { createRequire } from 'node:module';
import { computeBinding, parcelActBinding, parseTolerance, validateSiteGeometry, COVERAGE, SERVER_CADASTRE_SOURCE } from './binding.js';

const requireCjs = createRequire(import.meta.url);
const driftApi = requireCjs('../../frontend/js/proposals/binding-drift.js');

export const { bindingDrift, boundParcelIds } = driftApi;

// One row by its serial id or its proposal_id (the serial id wins, as GET /proposals/:id).
export const BINDING_DRIFT_ROW_SQL = `
    SELECT id, proposal_id, city,
           COALESCE(binding, proposal_data->'binding') AS binding,
           CASE WHEN site IS NOT NULL THEN ST_AsGeoJSON(site, 9) END AS site_geojson,
           proposal_data->'site' AS data_site
    FROM proposal
    WHERE (proposal_id = $1 OR id::text = $1)
    ORDER BY (id::text = $1) DESC
    LIMIT 1
`;

// Why a record cannot be checked: no stored binding (never published under the binding rule), no
// stored site, or a site in a cadastre the server does not hold.
export const DRIFT_UNCHECKABLE = Object.freeze({
    noBinding: 'no-binding',
    noSite: 'no-site',
    unknownCoverage: 'unknown-coverage'
});

function parseJson(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'object') return value;
    try { return JSON.parse(value); } catch (_) { return null; }
}

/**
 * @returns {Promise<null | { id, proposalId, checkable, reason?, stored, current?, drift? }>}
 *   null when no such record. Throws binding errors (code, status) from computeBinding.
 */
export async function computeBindingDrift(db, idParam, { now } = {}) {
    const row = (await db.query(BINDING_DRIFT_ROW_SQL, [String(idParam)])).rows[0];
    if (!row) return null;
    const base = { id: String(row.id), proposalId: row.proposal_id ? String(row.proposal_id) : null };
    const stored = parseJson(row.binding);
    if (!stored || !Array.isArray(stored.parcels)) {
        return { ...base, checkable: false, reason: DRIFT_UNCHECKABLE.noBinding, stored: stored || null };
    }
    const tolerance = parseTolerance(typeof stored.toleranceM === 'number' ? stored.toleranceM : undefined);
    const toleranceM = tolerance.ok ? tolerance.value : 0;
    // Recheck the provider that supplied the published evidence, even when the city defaults to DB.
    const parcelSourceId = typeof stored.source === 'string' && stored.source.startsWith('server:')
        && stored.source !== SERVER_CADASTRE_SOURCE ? stored.source.slice('server:'.length) : null;

    let current;
    if (stored.subject === 'declared-parcels') {
        current = (await parcelActBinding(db, boundParcelIds(stored), { toleranceM, city: row.city || null, parcelSourceId, now })).binding;
    } else {
        const site = parseJson(row.site_geojson) || parseJson(row.data_site);
        if (!site || validateSiteGeometry(site)) {
            return { ...base, checkable: false, reason: DRIFT_UNCHECKABLE.noSite, stored };
        }
        current = (await computeBinding(db, { site, toleranceM, city: row.city || null, parcelSourceId, now })).binding;
        if (current.coverage === COVERAGE.unknown) {
            return { ...base, checkable: false, reason: DRIFT_UNCHECKABLE.unknownCoverage, stored, current };
        }
    }
    return { ...base, checkable: true, stored, current, drift: bindingDrift(stored, current) };
}
