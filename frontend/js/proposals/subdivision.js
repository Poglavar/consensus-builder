// Subdivision of a site (PARCEL-OPTIONAL.md phase 4): land readjustment generalised to ground that
// is partly or wholly open. The pool is the site; the bound parcels' part of it is contributed by
// their modeled owners; the rest is open ground, whose ownership is unknown. A subdivision
// takes land and outputs only plots; a public strip is a plot assigned to public land.
//
// Pure: no DOM. turf is options.turf, the browser global, globalThis.turf or require('@turf/turf').
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__subdivision = api;
})(typeof window !== 'undefined' ? window : globalThis, function (global) {
    'use strict';

    // The accounting placeholder for open ground, with no represented ownership party. It is
    // never an agent, cash recipient or ownership transfer; it makes no title finding.
    const OPEN_GROUND_OWNER_KEY = 'open-ground';
    // Whether a piece is ground or clipping debris is the shared rule (geometry-tolerances.js isGround).
    function groundApi() {
        return (typeof window !== 'undefined' && window.GeometryTolerances)
            || (typeof require === 'function' ? require('../geometry-tolerances.js') : null);
    }

    // Polygon-clip failures are typed and counted in one place (parcel-arrangement.js clipHealth).
    function clipFailureApi() {
        const api = (typeof window !== 'undefined' && window.__parcelArrangement)
            || (typeof require === 'function' ? require('./parcel-arrangement.js') : null);
        if (!api || typeof api.clipFailure !== 'function') throw new Error('parcel-arrangement.js (clip failures) is not loaded');
        return api;
    }

    function T(options) {
        if (options && options.turf) return options.turf;
        if (typeof turf !== 'undefined' && turf) return turf; // eslint-disable-line no-undef
        if (global && global.turf) return global.turf;
        try { return typeof require === 'function' ? require('@turf/turf') : null; } catch (_) { return null; }
    }

    function finite(value) {
        return typeof value === 'number' && Number.isFinite(value);
    }

    function geometryOf(value) {
        const g = value && value.type === 'Feature' ? value.geometry : value;
        return g && (g.type === 'Polygon' || g.type === 'MultiPolygon') ? g : null;
    }

    function asFeature(value) {
        const g = geometryOf(value);
        return g ? { type: 'Feature', properties: {}, geometry: g } : null;
    }

    function areaOf(t, value) {
        const f = asFeature(value);
        if (!f) return 0;
        try { return Number(t.area(f)) || 0; } catch (_) { return 0; }
    }

    // A one-part MultiPolygon as a Polygon (the editor and the slicer read Polygons best).
    function simplestGeometry(value) {
        const g = geometryOf(value);
        if (g && g.type === 'MultiPolygon' && g.coordinates.length === 1) return { type: 'Polygon', coordinates: g.coordinates[0] };
        return g;
    }

    function isOpenGroundOwnerKey(key) {
        return key === OPEN_GROUND_OWNER_KEY;
    }

    /**
     * The pool of a subdivision: the site, split into the bound parcels' parts (site ∩ parcel) and
     * open ground (site minus every given parcel). Parcels are subtracted one at a time (turf's
     * difference against a union of many real parcels is the known stack-overflow trap).
     * @param {object} site Polygon/MultiPolygon (or Feature).
     * @param {{id: string, geometry: object}[]} parcels the bound parcels' current geometry.
     * @returns {{pool: object, totalAreaM2: number, parts: {parcelId: string, geometry: object,
     *   areaM2: number}[], openGround: object|null, openGroundM2: number}}
     */
    function sitePool(site, parcels, options) {
        const t = T(options);
        if (!t) throw new Error('subdivision: turf is not available');
        const siteFeature = asFeature(site);
        if (!siteFeature) throw new TypeError('site must be a GeoJSON Polygon or MultiPolygon');
        const totalAreaM2 = areaOf(t, siteFeature);
        const parts = [];
        let open = siteFeature;
        for (const parcel of parcels || []) {
            const g = geometryOf(parcel && parcel.geometry);
            if (!g) continue;
            const parcelFeature = { type: 'Feature', properties: {}, geometry: g };
            // A failed clip throws, not "this parcel contributes nothing": its owner's share of the pool would vanish.
            const hit = clipFailureApi().clipWith(t, 'intersect', siteFeature, parcelFeature, { site: 'subdivision.sitePool', parcelId: parcel.id });
            if (hit && groundApi().isGround(t, hit)) parts.push({ parcelId: String(parcel.id), geometry: hit.geometry, areaM2: areaOf(t, hit) });
            if (open) {
                // A failed subtraction is not "no parcel here": the open ground would be overstated.
                open = clipFailureApi().clipWith(t, 'difference', open, parcelFeature, { site: 'subdivision.sitePool', parcelId: parcel.id });
            }
        }
        const openIsGround = !!open && groundApi().isGround(t, open);
        return {
            pool: simplestGeometry(siteFeature.geometry),
            totalAreaM2,
            parts,
            openGround: openIsGround ? open.geometry : null,
            openGroundM2: openIsGround ? areaOf(t, open) : 0
        };
    }

    /**
     * Owner shares of a pool with open ground. `contributions` are the bound parcels' owners
     * ({ownerKey, displayName, area, value|null, parcelIds}); open ground contributes area with
     * unknown ownership and value, so a pool with open ground is measured by AREA (a value basis
     * would rate unknown ground at zero). Percent = contributed area / pool area, open ground
     * included as its own entry. Zero owners and zero open ground → no shares (never NaN).
     * @returns {{shares: object[], basis: 'value'|'area', totalArea: number, totalValue: number|null,
     *   poolUnitValue: number|null}}
     */
    function poolShares(contributions, options) {
        const opts = options || {};
        const list = (contributions || []).filter(entry => entry && finite(entry.area) && entry.area > 0);
        const openGroundM2 = finite(opts.openGroundM2) && opts.openGroundM2 > 0 ? opts.openGroundM2 : 0;
        const ownedArea = list.reduce((sum, entry) => sum + entry.area, 0);
        const totalArea = ownedArea + openGroundM2;
        if (!(totalArea > 0)) return { shares: [], basis: 'area', totalArea: 0, totalValue: null, poolUnitValue: null };
        const values = list.map(entry => (finite(entry.value) && entry.value > 0 ? entry.value : null));
        const useValue = openGroundM2 === 0 && list.length > 0 && values.every(value => value !== null);
        const totalValue = useValue ? values.reduce((sum, value) => sum + value, 0) : null;
        const shares = list.map((entry, index) => ({
            ownerKey: entry.ownerKey,
            displayName: entry.displayName,
            parcelIds: Array.isArray(entry.parcelIds) ? entry.parcelIds.slice() : [],
            area: entry.area,
            value: values[index],
            percent: useValue ? values[index] / totalValue : entry.area / totalArea
        }));
        if (openGroundM2 > 0) {
            shares.push({
                ownerKey: OPEN_GROUND_OWNER_KEY,
                displayName: opts.openGroundLabel || 'Open ground (unrepresented allocation)',
                parcelIds: [],
                area: openGroundM2,
                value: null,
                percent: openGroundM2 / totalArea,
                unrepresentedGround: true // Accounting exclusion, not a title finding.
            });
        }
        return {
            shares: shares.filter(entry => entry.percent > 0).sort((a, b) => (a.unrepresentedGround === b.unrepresentedGround ? b.percent - a.percent : (a.unrepresentedGround ? 1 : -1))),
            basis: useValue ? 'value' : 'area',
            totalArea,
            totalValue,
            poolUnitValue: useValue ? totalValue / totalArea : null
        };
    }

    /**
     * Readjustment ledger of one share entry. The open-ground placeholder has no represented
     * party, so this model leaves its balance and cash offer null. Null is not a settled debt of 0.
     * @param {object} entry a share ({area, value, unrepresentedGround})
     * @param {{basis: string, poolUnitValue: number|null, contributionRatio?: number, assignedArea: number}} context
     */
    function ledgerOf(entry, context) {
        if (Object.prototype.hasOwnProperty.call(entry || {}, 'noOwner')) {
            throw new Error('The noOwner marker is retired; use unrepresentedGround');
        }
        if (entry?.unrepresentedGround === true && entry.ownerKey !== OPEN_GROUND_OWNER_KEY) {
            throw new Error('Unrepresented ground cannot also name a represented owner');
        }
        const ctx = context || {};
        const useMoney = ctx.basis === 'value' && finite(ctx.poolUnitValue) && ctx.poolUnitValue > 0;
        const unit = useMoney ? ctx.poolUnitValue : 1;
        const area = finite(entry && entry.area) ? entry.area : 0;
        const contributed = useMoney ? (finite(entry.value) ? entry.value : area * unit) : area;
        const ratio = finite(ctx.contributionRatio) && ctx.contributionRatio > 0 ? ctx.contributionRatio : 1;
        const entitled = contributed * ratio;
        const assignedArea = finite(ctx.assignedArea) && ctx.assignedArea > 0 ? ctx.assignedArea : 0;
        const assigned = assignedArea * unit;
        const unrepresentedGround = !!(entry && (entry.unrepresentedGround === true || isOpenGroundOwnerKey(entry.ownerKey)));
        return {
            contributed,
            entitled,
            assigned,
            assignedArea,
            cashBalance: unrepresentedGround ? null : assigned - entitled,
            unrepresentedGround
        };
    }

    /**
     * The contributor a plot belongs to by its ground: the share whose bound-parcel parts cover the
     * most of it, or open ground when the open part covers more. `parts` are sitePool().parts;
     * `shares` the poolShares() entries (with parcelIds). Null when nothing covers it.
     */
    function ownerKeyByGround(plotGeometry, pool, shares, options) {
        const t = T(options);
        const plot = asFeature(plotGeometry);
        if (!t || !plot || !pool) return null;
        const overlap = geometry => {
            const other = asFeature(geometry);
            if (!other) return 0;
            // A failed clip throws: zero would hand the plot to whichever contributor's overlap did compute.
            const hit = clipFailureApi().clipWith(t, 'intersect', plot, other, { site: 'subdivision.ownerKeyByGround' });
            // Debris along a shared edge covers nothing (geometry-tolerances.js isGround).
            return hit && groundApi().isGround(t, hit) ? areaOf(t, hit) : 0;
        };
        const byParcel = new Map((pool.parts || []).map(part => [String(part.parcelId), overlap(part.geometry)]));
        let best = null;
        let bestArea = 0;
        for (const share of shares || []) {
            const area = share.unrepresentedGround || isOpenGroundOwnerKey(share.ownerKey)
                ? overlap(pool.openGround)
                : (share.parcelIds || []).reduce((sum, id) => sum + (byParcel.get(String(id)) || 0), 0);
            if (area > bestArea) { best = share.ownerKey; bestArea = area; }
        }
        return best;
    }

    /**
     * May the create path turn this pending plan into a proposal? A readjustment pooled from a
     * parcel selection must still be on the same selection. A subdivision (poolSource 'site') is
     * pooled from its SITE: its parcels are the site's binding (possibly none, on open ground), not
     * a selection, so the selection is never compared; the plan's pool must be the dialog's site.
     * @param {object} plan window.pendingParcelLayout
     * @param {{selectedParcelIds?: string[], site?: object}} context the create dialog's selection
     *   and site (the site context, null for a parcel-selection proposal).
     * @returns {{ok: boolean, reason: null|'missing'|'parcels-changed'|'site-missing'|'site-changed'}}
     */
    function planCreateVerdict(plan, context, options) {
        const ctx = context || {};
        const verdict = reason => ({ ok: !reason, reason: reason || null });
        if (!plan || !Array.isArray(plan.polygons) || !plan.polygons.length) return verdict('missing');
        // Saved parcel readjustments also reopen with an authored site after their inputs
        // have been replaced. Compare that immutable pool, not an empty live selection.
        if (plan.poolSource === 'site' || ctx.site) {
            const site = geometryOf(ctx.site);
            if (!site) return verdict('site-missing');
            const pool = geometryOf(plan.poolGeometry);
            if (!pool) return verdict('missing');
            const t = T(options);
            if (!t) throw new Error('subdivision: turf is not available');
            // Same ground, within clipping noise: the site was not redrawn after the plots were laid.
            const outside = (a, b) => {
                const rest = clipFailureApi().clipWith(t, 'difference', asFeature(a), asFeature(b), { site: 'subdivision.planCreateVerdict' });
                return rest ? areaOf(t, rest) : 0;
            };
            const tolerance = Math.max(1, areaOf(t, site) * 0.001);
            return verdict(outside(site, pool) + outside(pool, site) > tolerance ? 'site-changed' : null);
        }
        if (!Array.isArray(plan.parcelIds)) return verdict('missing');
        const planned = new Set(plan.parcelIds.map(String));
        const selected = new Set((ctx.selectedParcelIds || []).map(String));
        const same = planned.size === selected.size && Array.from(planned).every(id => selected.has(id));
        return verdict(same ? null : 'parcels-changed');
    }

    return {
        OPEN_GROUND_OWNER_KEY,
        isOpenGroundOwnerKey,
        sitePool,
        poolShares,
        ledgerOf,
        ownerKeyByGround,
        planCreateVerdict
    };
});
