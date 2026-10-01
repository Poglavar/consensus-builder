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

    /**
     * Plots along a street. The street (STREET_WIDTH_M) runs parallel to the frontage edge: through
     * the middle when the site is deep enough for a row of plots on each side, else along the
     * frontage. Plots (about PLOT_WIDTH_M wide) are cut perpendicular to it with the site-plots
     * cutter, using the same cut positions on both sides.
     * @returns {{frontageEdgeIndex: number, placement: 'middle'|'frontage'|'none', street: object|null,
     *   plots: object[]}} geometries in EPSG:4326; street + plots tile the site.
     */
    function streetPlotsLayout(site, options) {
        const opts = options || {};
        const t = T(opts);
        const plotsApi = sitePlotsApi(opts);
        if (!t || !plotsApi) throw new Error('subdivision: turf or the frontage cutter is not available');
        const siteGeometry = geometryOf(site);
        if (!siteGeometry) throw new TypeError('site must be a GeoJSON Polygon or MultiPolygon');
        const streetWidthM = finite(opts.streetWidthM) && opts.streetWidthM > 0 ? opts.streetWidthM : STREET_WIDTH_M;
        const plotWidthM = finite(opts.plotWidthM) && opts.plotWidthM > 0 ? opts.plotWidthM : PLOT_WIDTH_M;
        const minDepthM = finite(opts.minPlotDepthM) && opts.minPlotDepthM > 0 ? opts.minPlotDepthM : MIN_PLOT_DEPTH_M;
        const extent = plotsApi.frontageExtent(siteGeometry, { frontageEdgeIndex: opts.frontageEdgeIndex, turf: t });
        const edge = extent.frontageEdgeIndex;
        const depth = extent.vMax - extent.vMin;
        // Too shallow for a street and a row of plots: the whole site is cut into plots.
        if (depth < streetWidthM + minDepthM) {
            const plots = plotsApi.cutPlots(siteGeometry, { frontageEdgeIndex: edge, plotWidthM, turf: t });
            return { frontageEdgeIndex: edge, placement: 'none', street: null, plots: plots.map(f => f.geometry) };
        }
        const middle = depth >= 2 * minDepthM + streetWidthM;
        const low = middle ? extent.vMin + (depth - streetWidthM) / 2 : extent.vMin;
        const high = low + streetWidthM;
        const street = plotsApi.bandOf(siteGeometry, { frontageEdgeIndex: edge, vFromM: middle ? low : undefined, vToM: high, turf: t });
        const cut = range => plotsApi.cutPlots(siteGeometry, { frontageEdgeIndex: edge, plotWidthM, turf: t, ...range })
            .map(f => f.geometry);
        const plots = (middle ? cut({ vToM: low }) : []).concat(cut({ vFromM: high }));
        return {
            frontageEdgeIndex: edge,
            placement: middle ? 'middle' : 'frontage',
            street: street ? simplestGeometry(street) : null,
            plots: plots.filter(g => areaOf(t, g) >= MIN_PIECE_M2)
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

    return {
        OPEN_GROUND_OWNER_KEY,
        STREET_WIDTH_M,
        PLOT_WIDTH_M,
        MIN_PLOT_DEPTH_M,
        isOpenGroundOwnerKey,
        sitePool,
        poolShares,
        ledgerOf,
        streetPlotsLayout,
        ownerKeyByGround
    };
});
