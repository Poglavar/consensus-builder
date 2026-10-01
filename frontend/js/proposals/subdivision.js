// Subdivision of a site (PARCEL-OPTIONAL.md phase 4): land readjustment generalised to ground that
// is partly or wholly open. The pool is the site; the bound parcels' part of it is contributed by
// their owners, the rest is open ground, which contributes area and has no owner. Also the quick
// "plots along a street" layout: a street band parallel to a frontage edge, plots cut on either side
// of it with the site-plots frontage cutter.
//
// Pure: no DOM. turf is options.turf, the browser global, globalThis.turf or require('@turf/turf');
// the frontage cutter is options.sitePlots, window.__sitePlots or require('./site-plots.js').
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__subdivision = api;
})(typeof window !== 'undefined' ? window : globalThis, function (global) {
    'use strict';

    // The pseudo-owner of open ground in a readjustment plan: a plot assigned to it stays ground
    // nobody can consent for. It is never an agent, never paid, and never given ownership on apply.
    const OPEN_GROUND_OWNER_KEY = 'open-ground';
    const STREET_WIDTH_M = 10;
    const PLOT_WIDTH_M = 20;
    // The widths a user may choose in the editor (metres, inclusive). Outside them a layout is
    // refused, never clamped: a 2 m "street" or a 200 m "plot" is a typo, not a design.
    const STREET_WIDTH_LIMITS_M = Object.freeze({ min: 4, max: 30 });
    const PLOT_WIDTH_LIMITS_M = Object.freeze({ min: 6, max: 60 });
    // A band of plots shallower than this is not worth a second row: the street then runs along
    // the frontage instead of through the middle.
    const MIN_PLOT_DEPTH_M = 15;
    // Below this a piece is clipping noise, not ground.
    const MIN_PIECE_M2 = 0.5;

    function T(options) {
        if (options && options.turf) return options.turf;
        if (typeof turf !== 'undefined' && turf) return turf; // eslint-disable-line no-undef
        if (global && global.turf) return global.turf;
        try { return typeof require === 'function' ? require('@turf/turf') : null; } catch (_) { return null; }
    }

    function sitePlotsApi(options) {
        if (options && options.sitePlots) return options.sitePlots;
        if (global && global.__sitePlots) return global.__sitePlots;
        try { return typeof require === 'function' ? require('./site-plots.js') : null; } catch (_) { return null; }
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
            let hit = null;
            try { hit = t.intersect(siteFeature, parcelFeature); } catch (_) { hit = null; }
            const areaM2 = hit ? areaOf(t, hit) : 0;
            if (areaM2 >= MIN_PIECE_M2) parts.push({ parcelId: String(parcel.id), geometry: hit.geometry, areaM2 });
            if (open) {
                // A failed subtraction is not "no parcel here": the open ground would be overstated.
                open = t.difference(open, parcelFeature);
            }
        }
        const openGroundM2 = open ? areaOf(t, open) : 0;
        return {
            pool: simplestGeometry(siteFeature.geometry),
            totalAreaM2,
            parts,
            openGround: open && openGroundM2 >= MIN_PIECE_M2 ? open.geometry : null,
            openGroundM2: openGroundM2 >= MIN_PIECE_M2 ? openGroundM2 : 0
        };
    }

    /**
     * Owner shares of a pool with open ground. `contributions` are the bound parcels' owners
     * ({ownerKey, displayName, area, value|null, parcelIds}); open ground contributes area and has
     * no owner and no known value, so a pool with open ground is measured by AREA (a value basis
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
                displayName: opts.openGroundLabel || 'Open ground (no owner)',
                parcelIds: [],
                area: openGroundM2,
                value: null,
                percent: openGroundM2 / totalArea,
                noOwner: true
            });
        }
        return {
            shares: shares.filter(entry => entry.percent > 0).sort((a, b) => (a.noOwner === b.noOwner ? b.percent - a.percent : (a.noOwner ? 1 : -1))),
            basis: useValue ? 'value' : 'area',
            totalArea,
            totalValue,
            poolUnitValue: useValue ? totalValue / totalArea : null
        };
    }

    /**
     * Readjustment ledger of one share entry. Open ground has no owner: nothing is owed or paid,
     * so its balance and cash offer are null (not 0 — "no one to pay" is not "even").
     * @param {object} entry a share ({area, value, noOwner})
     * @param {{basis: string, poolUnitValue: number|null, contributionRatio?: number, assignedArea: number}} context
     */
    function ledgerOf(entry, context) {
        const ctx = context || {};
        const useMoney = ctx.basis === 'value' && finite(ctx.poolUnitValue) && ctx.poolUnitValue > 0;
        const unit = useMoney ? ctx.poolUnitValue : 1;
        const area = finite(entry && entry.area) ? entry.area : 0;
        const contributed = useMoney ? (finite(entry.value) ? entry.value : area * unit) : area;
        const ratio = finite(ctx.contributionRatio) && ctx.contributionRatio > 0 ? ctx.contributionRatio : 1;
        const entitled = contributed * ratio;
        const assignedArea = finite(ctx.assignedArea) && ctx.assignedArea > 0 ? ctx.assignedArea : 0;
        const assigned = assignedArea * unit;
        const noOwner = !!(entry && (entry.noOwner || isOpenGroundOwnerKey(entry.ownerKey)));
        return {
            contributed,
            entitled,
            assigned,
            assignedArea,
            cashBalance: noOwner ? null : assigned - entitled,
            noOwner
        };
    }

    // A refused "plots along a street" layout: `code` is 'invalid-width' (details.errors from
    // streetPlotsWidths) or 'no-whole-plot' (details.frontageM, details.plotWidthM).
    function streetPlotsError(code, details) {
        const error = new RangeError(`subdivision: street plots refused (${code})`);
        error.code = code;
        error.details = details || {};
        return error;
    }

    /**
     * The street and plot widths of a "plots along a street" layout, checked against their limits.
     * A missing value (undefined/null) takes the default; anything else must be a number (or a
     * numeric string, as an input gives it) inside the limits.
     * @returns {{ok: boolean, streetWidthM: number|null, plotWidthM: number|null,
     *   errors: {field: 'streetWidthM'|'plotWidthM', reason: 'not-a-number'|'range', min: number, max: number}[]}}
     */
    function streetPlotsWidths(input) {
        const values = input || {};
        const errors = [];
        const read = (field, fallback, limits) => {
            const raw = values[field];
            if (raw === undefined || raw === null) return fallback;
            const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
            if (!finite(value)) { errors.push({ field, reason: 'not-a-number', min: limits.min, max: limits.max }); return null; }
            if (value < limits.min || value > limits.max) { errors.push({ field, reason: 'range', min: limits.min, max: limits.max }); return null; }
            return value;
        };
        const streetWidthM = read('streetWidthM', STREET_WIDTH_M, STREET_WIDTH_LIMITS_M);
        const plotWidthM = read('plotWidthM', PLOT_WIDTH_M, PLOT_WIDTH_LIMITS_M);
        return { ok: errors.length === 0, streetWidthM, plotWidthM, errors };
    }

    // The settings a saved plan carries for "plots along a street" (persisted next to
    // streetFrontageIndex) and back. A saved value that no longer passes the limits reads as the
    // default rather than reopening a plan the editor would refuse to lay out.
    function streetPlotsPlanFields(settings) {
        const checked = streetPlotsWidths(settings);
        const out = {
            streetWidthM: checked.streetWidthM !== null ? checked.streetWidthM : STREET_WIDTH_M,
            plotWidthM: checked.plotWidthM !== null ? checked.plotWidthM : PLOT_WIDTH_M
        };
        if (settings && Number.isInteger(settings.streetFrontageIndex)) out.streetFrontageIndex = settings.streetFrontageIndex;
        return out;
    }

    function streetPlotsSettingsOf(plan) {
        const saved = plan || {};
        const checked = streetPlotsWidths({ streetWidthM: saved.streetWidthM, plotWidthM: saved.plotWidthM });
        return {
            streetWidthM: checked.streetWidthM !== null ? checked.streetWidthM : STREET_WIDTH_M,
            plotWidthM: checked.plotWidthM !== null ? checked.plotWidthM : PLOT_WIDTH_M,
            streetFrontageIndex: Number.isInteger(saved.streetFrontageIndex) ? saved.streetFrontageIndex : null
        };
    }

    /**
     * Plots along a street. The street (streetWidthM, default STREET_WIDTH_M) runs parallel to the
     * frontage edge: through the middle when the site is deep enough for a row of plots on each
     * side, else along the frontage, else (too shallow for a street and minPlotDepthM of plots) not
     * at all. Plots run from the street to the site edge, so their depth is the site's, not a
     * setting. They are cut perpendicular to the street with the site-plots cutter, using the same
     * cut positions on both sides.
     *
     * Remainder rule (site-plots cutPlots): the site's whole extent along the frontage is split
     * into round(extent / plotWidthM) equal strips, so the remainder is spread over every plot
     * (each is between 0.75× and 1.5× plotWidthM on a rectangle) rather than left as a last odd
     * plot; a piece of an irregular site narrower than half a plot joins its neighbour.
     *
     * Refused (RangeError with .code, see streetPlotsError): widths outside STREET_WIDTH_LIMITS_M /
     * PLOT_WIDTH_LIMITS_M ('invalid-width'), and a site whose frontage extent is shorter than one
     * plot ('no-whole-plot') — that would otherwise be one sliver of a plot, not a layout.
     * @returns {{frontageEdgeIndex: number, placement: 'middle'|'frontage'|'none', street: object|null,
     *   plots: object[], streetWidthM: number, plotWidthM: number, frontageM: number}} geometries in
     *   EPSG:4326; street + plots tile the site.
     */
    function streetPlotsLayout(site, options) {
        const opts = options || {};
        const t = T(opts);
        const plotsApi = sitePlotsApi(opts);
        if (!t || !plotsApi) throw new Error('subdivision: turf or the frontage cutter is not available');
        const siteGeometry = geometryOf(site);
        if (!siteGeometry) throw new TypeError('site must be a GeoJSON Polygon or MultiPolygon');
        const widths = streetPlotsWidths({ streetWidthM: opts.streetWidthM, plotWidthM: opts.plotWidthM });
        if (!widths.ok) throw streetPlotsError('invalid-width', { errors: widths.errors });
        const { streetWidthM, plotWidthM } = widths;
        const minDepthM = finite(opts.minPlotDepthM) && opts.minPlotDepthM > 0 ? opts.minPlotDepthM : MIN_PLOT_DEPTH_M;
        const extent = plotsApi.frontageExtent(siteGeometry, { frontageEdgeIndex: opts.frontageEdgeIndex, turf: t });
        const edge = extent.frontageEdgeIndex;
        const depth = extent.vMax - extent.vMin;
        const frontageM = extent.uMax - extent.uMin;
        if (frontageM < plotWidthM) {
            throw streetPlotsError('no-whole-plot', { frontageEdgeIndex: edge, frontageM: Math.round(frontageM * 10) / 10, plotWidthM });
        }
        const sized = result => ({ ...result, streetWidthM, plotWidthM, frontageM });
        // Too shallow for a street and a row of plots: the whole site is cut into plots.
        if (depth < streetWidthM + minDepthM) {
            const plots = plotsApi.cutPlots(siteGeometry, { frontageEdgeIndex: edge, plotWidthM, turf: t });
            return sized({ frontageEdgeIndex: edge, placement: 'none', street: null, plots: plots.map(f => f.geometry) });
        }
        const middle = depth >= 2 * minDepthM + streetWidthM;
        const low = middle ? extent.vMin + (depth - streetWidthM) / 2 : extent.vMin;
        const high = low + streetWidthM;
        const street = plotsApi.bandOf(siteGeometry, { frontageEdgeIndex: edge, vFromM: middle ? low : undefined, vToM: high, turf: t });
        const cut = range => plotsApi.cutPlots(siteGeometry, { frontageEdgeIndex: edge, plotWidthM, turf: t, ...range })
            .map(f => f.geometry);
        const plots = (middle ? cut({ vToM: low }) : []).concat(cut({ vFromM: high }));
        return sized({
            frontageEdgeIndex: edge,
            placement: middle ? 'middle' : 'frontage',
            street: street ? simplestGeometry(street) : null,
            plots: plots.filter(g => areaOf(t, g) >= MIN_PIECE_M2)
        });
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
            try { const hit = t.intersect(plot, other); return hit ? areaOf(t, hit) : 0; } catch (_) { return 0; }
        };
        const byParcel = new Map((pool.parts || []).map(part => [String(part.parcelId), overlap(part.geometry)]));
        let best = null;
        let bestArea = MIN_PIECE_M2;
        for (const share of shares || []) {
            const area = share.noOwner || isOpenGroundOwnerKey(share.ownerKey)
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
     * @param {object} plan window.pendingReparcellizationPlan
     * @param {{selectedParcelIds?: string[], site?: object}} context the create dialog's selection
     *   and site (the site context, null for a parcel-selection proposal).
     * @returns {{ok: boolean, reason: null|'missing'|'parcels-changed'|'site-missing'|'site-changed'}}
     */
    function planCreateVerdict(plan, context, options) {
        const ctx = context || {};
        const verdict = reason => ({ ok: !reason, reason: reason || null });
        if (!plan || !Array.isArray(plan.polygons) || !plan.polygons.length) return verdict('missing');
        if (plan.poolSource === 'site') {
            const site = geometryOf(ctx.site);
            if (!site) return verdict('site-missing');
            const pool = geometryOf(plan.poolGeometry);
            if (!pool) return verdict('missing');
            const t = T(options);
            if (!t) throw new Error('subdivision: turf is not available');
            // Same ground, within clipping noise: the site was not redrawn after the plots were laid.
            const outside = (a, b) => {
                const rest = t.difference(asFeature(a), asFeature(b));
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
        STREET_WIDTH_M,
        PLOT_WIDTH_M,
        MIN_PLOT_DEPTH_M,
        STREET_WIDTH_LIMITS_M,
        PLOT_WIDTH_LIMITS_M,
        isOpenGroundOwnerKey,
        streetPlotsWidths,
        streetPlotsPlanFields,
        streetPlotsSettingsOf,
        sitePool,
        poolShares,
        ledgerOf,
        streetPlotsLayout,
        ownerKeyByGround,
        planCreateVerdict
    };
});
