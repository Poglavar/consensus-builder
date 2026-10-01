// Site and binding figures for the stats surfaces (plan stats, grain score, 3D gain panel).
// A proposal's SITE always has an area; its BINDING (cadastral parcels) may be empty, and then
// every parcel figure is null — "no parcels here" — never a 0 that reads like a measurement.
//
// Pure: records in, numbers out. No DOM, no map. Areas come from plan-yield's turf-free geodesic
// area, so node tests run the same code the browser runs. See PARCEL-OPTIONAL.md (phase 6, stats).
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__siteStats = api;
})(typeof window !== 'undefined' ? window : globalThis, function (global) {
    'use strict';

    function finite(value) {
        return typeof value === 'number' && Number.isFinite(value);
    }

    function yieldApi() {
        if (global && global.__planYield) return global.__planYield;
        try { return typeof require === 'function' ? require('./plan-yield.js') : null; } catch (_) { return null; }
    }

    function siteBindingApi() {
        return (global && global.__siteBinding) ? global.__siteBinding : null;
    }

    function geometryArea(geometry) {
        const plan = yieldApi();
        if (!plan || !geometry) return null;
        const area = plan.geometryAreaM2(geometry);
        return finite(area) && area > 0 ? area : null;
    }

    /**
     * The site's area in m², or null when nothing says. The server binding's `siteM2` (measured in
     * PostGIS over the authoritative site) wins; then the authored `record.site`; then the site
     * site-binding.js derives (the record's own footprint), when that module and turf are loaded
     * and `options.derive` is not false (deriving unions the footprint, so a plan-wide pass skips it
     * where the figure is not needed).
     */
    function siteAreaM2(record, options) {
        if (!record || typeof record !== 'object') return null;
        const binding = record.binding;
        if (binding && finite(binding.siteM2) && binding.siteM2 > 0) return binding.siteM2;
        const authored = geometryArea(record.site);
        if (authored !== null) return authored;
        const sb = siteBindingApi();
        if ((!options || options.derive !== false) && sb && typeof sb.siteOf === 'function') {
            let derived = null;
            try { derived = sb.siteOf(record); } catch (_) { derived = null; }
            return geometryArea(derived);
        }
        return null;
    }

    /** The bound parcel ids: the declaration (which IS the binding), else the binding's own list. */
    function boundParcelIds(record) {
        if (!record || typeof record !== 'object') return [];
        const list = Array.isArray(record.cadastreParcelIds)
            ? record.cadastreParcelIds
            : ((record.binding && Array.isArray(record.binding.parcels))
                ? record.binding.parcels.map(entry => entry && entry.parcelId)
                : []);
        const ids = new Set();
        list.forEach(id => {
            if (id === undefined || id === null) return;
            const text = String(id).trim();
            if (text) ids.add(text);
        });
        return [...ids];
    }

    /**
     * One proposal's ground.
     * @returns {{ siteM2: number|null, hasBinding: boolean, parcelIds: string[],
     *             parcelCount: number|null, coverage: string|null, openGroundM2: number|null,
     *             partial: boolean }}
     *   parcelCount is null — not 0 — with an empty binding. openGroundM2 is the binding's
     *   `unsurveyedM2`; with no binding object and no parcels the whole site is open ground; with
     *   parcels and no binding object (a record from before sites existed) it is unknown (null).
     */
    function groundOf(record, options) {
        const parcelIds = boundParcelIds(record);
        const siteM2 = siteAreaM2(record, { derive: !options || options.deriveSite !== false });
        const hasBinding = parcelIds.length > 0;
        const binding = record && record.binding && typeof record.binding === 'object' ? record.binding : null;
        let openGroundM2 = null;
        if (binding && finite(binding.unsurveyedM2) && binding.unsurveyedM2 >= 0) openGroundM2 = binding.unsurveyedM2;
        else if (!hasBinding && siteM2 !== null) openGroundM2 = siteM2;
        else if (binding && binding.coverage === 'complete') openGroundM2 = 0;
        return {
            siteM2,
            hasBinding,
            parcelIds,
            parcelCount: hasBinding ? parcelIds.length : null,
            coverage: binding && typeof binding.coverage === 'string' ? binding.coverage : null,
            openGroundM2,
            partial: hasBinding && finite(openGroundM2) && openGroundM2 > 0
        };
    }

    // Identical sites are one piece of ground; two proposals on it (one per epoch, say) must not
    // count its open ground twice. Sites wholly on open ground (no bound parcel) that overlap — a
    // road built through a subdivision, a square on a park — are one piece of ground too: they are
    // measured as their union when a union is available (turf in the browser, injected in tests).
    // A partly bound site keeps its binding's figure, added as it is.
    function siteKey(record) {
        const site = record && record.site;
        if (!site || !site.coordinates) return null;
        try { return JSON.stringify(site.coordinates); } catch (_) { return null; }
    }

    function derivedSite(record) {
        const sb = siteBindingApi();
        if (!sb || typeof sb.siteOf !== 'function') return null;
        try { return sb.siteOf(record) || null; } catch (_) { return null; }
    }

    // The area of the union of `geometries`, or null when no union is available or it fails.
    function unionAreaM2(geometries, options) {
        const union = options && typeof options.union === 'function'
            ? options.union
            : ((global && global.turf && typeof global.turf.union === 'function')
                ? (a, b) => global.turf.union(a, b)
                : null);
        if (!union) return geometries.length === 1 ? geometryArea(geometries[0]) : null;
        try {
            let acc = null;
            geometries.forEach(geometry => {
                const feature = { type: 'Feature', properties: {}, geometry };
                acc = acc ? union(acc, feature) : feature;
            });
            return acc && acc.geometry ? geometryArea(acc.geometry) : null;
        } catch (_) {
            return null;
        }
    }

    /**
     * A plan's ground.
     * @returns {{ proposals: number, boundProposals: number, bareProposals: number,
     *             partialProposals: number, hasBinding: boolean, openGroundM2: number|null }}
     *   openGroundM2 sums the proposals' open ground (identical sites once, overlapping bare sites as
     *   their union); null when no proposal states any. `options.union(a, b)` overrides turf.union.
     */
    function planGround(records, options) {
        const list = (Array.isArray(records) ? records : []).filter(r => r && typeof r === 'object');
        let boundProposals = 0;
        let bareProposals = 0;
        let partialProposals = 0;
        let openGroundM2 = null;
        const seenSites = new Set();
        const bareSites = [];
        list.forEach(record => {
            // A bound record's open ground comes from its binding, never from its derived site.
            const ground = groundOf(record, { deriveSite: boundParcelIds(record).length === 0 });
            if (ground.hasBinding) boundProposals += 1;
            else bareProposals += 1;
            if (ground.partial) partialProposals += 1;
            if (!finite(ground.openGroundM2)) return;
            const key = siteKey(record);
            if (key !== null) {
                if (seenSites.has(key)) return;
                seenSites.add(key);
            }
            // A bare record's ground is its whole site: the authored one, else the one site-binding
            // derives from its footprint (a road drawn with the road tool carries no `site`).
            const bareSite = ground.hasBinding ? null : (record.site || derivedSite(record));
            if (bareSite) bareSites.push({ geometry: bareSite, areaM2: ground.openGroundM2 });
            else openGroundM2 = (openGroundM2 || 0) + ground.openGroundM2;
        });
        if (bareSites.length) {
            // Each site's own figure (the server's, when it measured it), less the ground the
            // sites share — measured geometrically, so a single site keeps its figure exactly.
            const stated = bareSites.reduce((sum, entry) => sum + entry.areaM2, 0);
            let shared = 0;
            if (bareSites.length > 1) {
                const union = unionAreaM2(bareSites.map(entry => entry.geometry), options);
                const measured = bareSites.reduce((sum, entry) => sum + (geometryArea(entry.geometry) || 0), 0);
                if (finite(union)) shared = Math.max(0, measured - union);
            }
            openGroundM2 = (openGroundM2 || 0) + Math.max(0, stated - shared);
        }
        return {
            proposals: list.length,
            boundProposals,
            bareProposals,
            partialProposals,
            hasBinding: boundProposals > 0,
            openGroundM2
        };
    }

    /** A piece minted on open ground: provenance `groundIds`, no cadastral anchor. Not a parcel. */
    function isGroundPiece(feature) {
        const props = feature && feature.properties;
        if (!props) return false;
        const ground = Array.isArray(props.groundIds) && props.groundIds.length > 0;
        const cadastre = Array.isArray(props.cadastreParcelIds) && props.cadastreParcelIds.length > 0;
        return ground && !cadastre;
    }

    return {
        siteAreaM2,
        boundParcelIds,
        groundOf,
        planGround,
        isGroundPiece
    };
});
