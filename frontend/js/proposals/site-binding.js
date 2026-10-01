// A proposal's SITE (the ground it occupies) and its BINDING (the cadastral parcels that site reaches
// into), as one pure rule shared by the browser preview and the server. See PARCEL-OPTIONAL.md.
// The server answer (backend/proposals/binding.js, PostGIS over the whole cadastre) is authoritative;
// this module computes the same rule over whatever parcel geometries the caller passes in.
//
// THE RULE. A parcel is bound when `site ∩ parcel` survives an inward buffer of
// max(toleranceM, INTRUSION_NOISE_M) / 2 metres, i.e. when the widest circle that fits inside the
// intersection is wider than the tolerance. Intrusion is that width (the diameter of the largest
// inscribed circle), so a 0.3 m sliver along a boundary intrudes 0.3 m whatever its length or area.
//
// Width is measured by bisection on the inward-buffer radius r ("does buffer(I, -r) still exist?",
// which is monotone in r), started from [0, sqrt(area/π)] (no inscribed circle can have more area
// than the polygon). It stops when the bracket is within max(0.5 mm, 0.05 % of r), so the reported
// width is within ±1 mm below 2 m and ±0.1 % above. turf.buffer runs in an azimuthal-equidistant
// metric frame centred on the geometry, so all distances here are ground metres. The server runs
// the same bisection with ST_Buffer in EPSG:3765 (ST_MaximumInscribedCircle's fixed 1/1000-of-extent
// tolerance is too coarse for a long thin sliver).
//
// Pure: no DOM, no fetch. `turf` is the browser global, globalThis.turf in node tests, or an
// explicit `options.turf`.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__siteBinding = api;
})(typeof window !== 'undefined' ? window : globalThis, function (global) {
    'use strict';

    // Policy default: any reach into a parcel binds it (PARCEL-OPTIONAL.md, MEMORY 2026-10-01).
    const DEFAULT_INTRUSION_TOLERANCE_M = 0;
    // Arithmetic floor, not policy: shared edges and coordinate rounding produce sub-millimetre
    // slivers. Anything narrower than this is not ground.
    const INTRUSION_NOISE_M = 0.001;
    // A tolerance is measurement error, never a design allowance; above this it is refused.
    const MAX_INTRUSION_TOLERANCE_M = 1;

    // Goals that ARE acts on parcels: their subject is the parcels themselves, so their binding
    // must not be empty. (Votes are flagged with isVote, owner offers with proposalRole
    // 'owner-offer'; road designations are recognised by shape.)
    const PARCEL_ACT_GOALS = Object.freeze([
        'offer',
        'ownership-transfer',
        'ownership-transfer-to-me',
        'ownership-transfer-from-me',
        'parcel',
        'as-is',
        'decide-later'
    ]);
    const PARCEL_ACT_GOAL_SET = new Set(PARCEL_ACT_GOALS);

    const COVERAGE = Object.freeze({ complete: 'complete', partial: 'partial', none: 'none', unknown: 'unknown' });

    function T(options) {
        if (options && options.turf) return options.turf;
        if (typeof turf !== 'undefined' && turf) return turf; // eslint-disable-line no-undef
        if (global && global.turf) return global.turf;
        try { return typeof require === 'function' ? require('@turf/turf') : null; } catch (_) { return null; }
    }

    function footprintPartsApi() {
        if (global && global.__footprintParts) return global.__footprintParts;
        try { return typeof require === 'function' ? require('./footprint-parts.js') : null; } catch (_) { return null; }
    }

    function planOrderApi() {
        if (global && global.__planOrder) return global.__planOrder;
        try { return typeof require === 'function' ? require('./plan-order.js') : null; } catch (_) { return null; }
    }

    function normalizeGoal(goal) {
        if (goal === undefined || goal === null) return '';
        return String(goal).trim().toLowerCase().replace(/\s+/g, '-').replace(/\//g, '-');
    }

    // A designation names existing parcels as road land: a polygon and no centreline
    // (corridor-profile.js corridorIsDesignation).
    function isRoadDesignation(record) {
        const definition = record && record.roadProposal && record.roadProposal.definition;
        if (!definition || typeof definition !== 'object' || !definition.polygon) return false;
        const points = Array.isArray(definition.points) ? definition.points : [];
        const segments = Array.isArray(definition.segments) ? definition.segments : [];
        const centerline = Array.isArray(definition.centerline) ? definition.centerline : [];
        return points.length < 2 && !segments.some(s => Array.isArray(s) && s.length >= 2) && centerline.length < 2;
    }

    function isParcelAct(record) {
        if (!record || typeof record !== 'object') return false;
        if (record.isVote === true) return true;
        if (record.proposalRole === 'owner-offer') return true;
        if (PARCEL_ACT_GOAL_SET.has(normalizeGoal(record.goal))) return true;
        return isRoadDesignation(record);
    }

    function asPolygonGeometry(value) {
        const geometry = value && value.type === 'Feature' ? value.geometry : value;
        return geometry && (geometry.type === 'Polygon' || geometry.type === 'MultiPolygon') ? geometry : null;
    }

    function hasOwnFootprint(record) {
        const api = footprintPartsApi();
        if (!api || !record) return false;
        return api.hasFootprint(api.footprintParts(record));
    }

    // Whether this record can only exist with a non-empty parcel declaration: a parcel act, or a
    // record that has neither its own geometry nor an authored site (it would be about nothing).
    function requiresParcels(record) {
        if (!record || typeof record !== 'object') return true;
        if (isParcelAct(record)) return true;
        return !asPolygonGeometry(record.site) && !hasOwnFootprint(record);
    }

    function toMultiPolygon(geometry) {
        const g = asPolygonGeometry(geometry);
        if (!g) return null;
        return g.type === 'MultiPolygon' ? g : { type: 'MultiPolygon', coordinates: [g.coordinates] };
    }

    function unionAll(t, features) {
        let acc = null;
        for (const feature of features) {
            if (!feature) continue;
            if (!acc) { acc = feature; continue; }
            try { acc = t.union(acc, feature) || acc; } catch (_) { /* keep what we have */ }
        }
        return acc;
    }

    /**
     * The proposal's site as a GeoJSON MultiPolygon (EPSG:4326), or null.
     *   1. an authored `record.site`;
     *   2. else the record's own footprint (plan-order.footprintOf: union of footprintParts);
     *   3. else, for a parcel act, the union of its declared parcels' geometries from
     *      `options.parcels` ([{ id, geometry }]).
     */
    function siteOf(record, options) {
        const opts = options || {};
        if (!record || typeof record !== 'object') return null;
        const authored = toMultiPolygon(record.site);
        if (authored) return authored;
        const t = T(opts);
        const plan = planOrderApi();
        if (t && plan && typeof plan.footprintOf === 'function' && hasOwnFootprint(record)) {
            const footprint = plan.footprintOf(record);
            const geometry = toMultiPolygon(footprint && (footprint.geometry || footprint));
            if (geometry) return geometry;
        }
        if (!t || !Array.isArray(opts.parcels) || !isParcelAct(record)) return null;
        const declared = new Set((record.cadastreParcelIds || []).map(String));
        const features = opts.parcels
            .filter(parcel => parcel && declared.has(String(parcel.id)) && asPolygonGeometry(parcel.geometry))
            .map(parcel => t.feature(asPolygonGeometry(parcel.geometry)));
        const union = unionAll(t, features);
        return union ? toMultiPolygon(union.geometry) : null;
    }

    // turf.buffer (JSTS) returns nothing for a polygon only centimetres across — exactly the 3 cm
    // fillet a design reaches into a neighbour with — so a small piece is first scaled up about its
    // bbox centre (uniform in ground metres, since one degree of lng/lat is a constant number of
    // metres locally) and eroded by the scaled radius. Erosion commutes with uniform scaling.
    const MIN_BUFFER_EXTENT_M = 50;

    function scaledForBuffer(t, feature) {
        const [minX, minY, maxX, maxY] = t.bbox(feature);
        const cx = (minX + maxX) / 2;
        const cy = (minY + maxY) / 2;
        const extentM = Math.max((maxX - minX) * 111320 * Math.cos(cy * Math.PI / 180), (maxY - minY) * 110540);
        if (!(extentM > 0) || extentM >= MIN_BUFFER_EXTENT_M) return { feature, k: 1 };
        const k = MIN_BUFFER_EXTENT_M / extentM;
        const walk = c => (typeof c[0] === 'number' ? [cx + (c[0] - cx) * k, cy + (c[1] - cy) * k] : c.map(walk));
        const g = feature.geometry || feature;
        return { feature: { type: 'Feature', properties: {}, geometry: { type: g.type, coordinates: walk(g.coordinates) } }, k };
    }

    function survivesInwardBuffer(t, feature, radiusM) {
        if (!(radiusM > 0)) return !!feature && t.area(feature) > 0;
        const scaled = scaledForBuffer(t, feature);
        let eroded = null;
        try { eroded = t.buffer(scaled.feature, -radiusM * scaled.k, { units: 'meters' }); } catch (_) { eroded = null; }
        return !!(eroded && eroded.geometry && t.area(eroded) > 0);
    }

    // Diameter of the largest circle inside `feature` (ground metres), by bisection; see the header.
    function intrusionWidth(feature, options) {
        const t = T(options);
        if (!t || !feature) return 0;
        const area = t.area(feature);
        if (!(area > 0)) return 0;
        let lo = 0;
        let hi = Math.sqrt(area / Math.PI);
        for (let n = 0; n < 60 && hi - lo > Math.max(0.0005, lo * 0.0005); n++) {
            const mid = (lo + hi) / 2;
            if (survivesInwardBuffer(t, feature, mid)) lo = mid; else hi = mid;
        }
        return lo + hi; // 2 × the bracket midpoint
    }

    function polygonsOf(feature) {
        const g = feature && (feature.geometry || feature);
        if (!g) return [];
        if (g.type === 'Polygon') return [g.coordinates];
        if (g.type === 'MultiPolygon') return g.coordinates;
        return [];
    }

    const round = (value, digits) => {
        const f = Math.pow(10, digits);
        return Math.round(value * f) / f;
    };

    function normalizeTolerance(toleranceM) {
        const value = toleranceM === undefined || toleranceM === null ? DEFAULT_INTRUSION_TOLERANCE_M : Number(toleranceM);
        if (!Number.isFinite(value) || value < 0 || value > MAX_INTRUSION_TOLERANCE_M) {
            throw new RangeError(`toleranceM must be between 0 and ${MAX_INTRUSION_TOLERANCE_M} m`);
        }
        return value;
    }

    /**
     * The binding of `site` over the given parcels.
     * @param {object} site GeoJSON Polygon/MultiPolygon (or Feature), EPSG:4326.
     * @param {{id: string, geometry: object}[]} parcels every cadastral parcel the caller has near
     *   the site (unbound ones are needed too: they decide what is open ground).
     * @param {{toleranceM?: number, regionHasCadastre?: boolean, source?: string, turf?: object}} options
     *   regionHasCadastre false = the region has no cadastre at all (coverage 'none', parcels ignored).
     * @returns {{ parcels: {parcelId, overlapM2, intrusionM}[], touched: {parcelId, overlapM2, intrusionM}[],
     *   toleranceM: number, coverage: string, unsurveyedM2: number, siteM2: number, source: string }}
     *
     * Coverage:
     *   complete — every part of the site wider than the floor lies on some cadastral parcel;
     *   partial  — some ground wider than the floor lies on no parcel (unsurveyedM2 > 0). A site in a
     *              surveyed region with no parcel under it at all is partial with unsurveyedM2 = siteM2;
     *   none     — the caller says the region has no cadastre (explore): the whole site is open ground.
     * Open ground is measured against ALL given parcels, not only bound ones: a parcel the site
     * touches by less than the tolerance is within measurement error, not ground without an owner.
     * Its components count only if they are wider than max(toleranceM, INTRUSION_NOISE_M), the same
     * linear floor as binding, so cadastral micro-gaps between abutting parcels are not open ground.
     */
    function bindingFromParcels(site, parcels, options) {
        const opts = options || {};
        const t = T(opts);
        if (!t) throw new Error('site-binding: turf is not available');
        const toleranceM = normalizeTolerance(opts.toleranceM);
        const floorM = Math.max(toleranceM, INTRUSION_NOISE_M);
        const siteGeometry = asPolygonGeometry(site);
        if (!siteGeometry) throw new TypeError('site must be a GeoJSON Polygon or MultiPolygon');
        const siteFeature = t.feature(siteGeometry);
        const siteM2 = t.area(siteFeature);
        const source = opts.source || 'client-preview';

        if (opts.regionHasCadastre === false) {
            return { parcels: [], touched: [], toleranceM, coverage: COVERAGE.none, unsurveyedM2: round(siteM2, 2), siteM2: round(siteM2, 2), source };
        }

        const bound = [];
        const touched = [];
        let open = siteFeature;
        for (const parcel of parcels || []) {
            const geometry = parcel && asPolygonGeometry(parcel.geometry);
            if (!geometry) continue;
            const parcelFeature = t.feature(geometry);
            let intersection = null;
            try { intersection = t.intersect(siteFeature, parcelFeature); } catch (_) { intersection = null; }
            if (open) {
                try { open = t.difference(open, parcelFeature); } catch (_) { /* keep the larger estimate */ }
            }
            if (!intersection || !polygonsOf(intersection).length) continue;
            const overlapM2 = t.area(intersection);
            if (!(overlapM2 > 0)) continue;
            const entry = {
                parcelId: String(parcel.id),
                overlapM2: round(overlapM2, 3),
                intrusionM: round(intrusionWidth(intersection, { turf: t }), 4)
            };
            if (survivesInwardBuffer(t, intersection, floorM / 2)) bound.push(entry); else touched.push(entry);
        }

        let unsurveyedM2 = 0;
        for (const rings of polygonsOf(open)) {
            const piece = t.polygon(rings);
            if (survivesInwardBuffer(t, piece, floorM / 2)) unsurveyedM2 += t.area(piece);
        }
        const byId = (a, b) => (a.parcelId < b.parcelId ? -1 : a.parcelId > b.parcelId ? 1 : 0);
        bound.sort(byId);
        touched.sort(byId);
        return {
            parcels: bound,
            touched,
            toleranceM,
            coverage: unsurveyedM2 > 0 ? COVERAGE.partial : COVERAGE.complete,
            unsurveyedM2: round(unsurveyedM2, 2),
            siteM2: round(siteM2, 2),
            source
        };
    }

    // The declaration a binding implies, and how a declared list differs from it.
    function boundParcelIds(binding) {
        return ((binding && binding.parcels) || []).map(entry => String(entry.parcelId)).sort();
    }

    function compareDeclaration(declaredIds, binding) {
        const declared = new Set((declaredIds || []).map(String));
        const boundIds = new Set(boundParcelIds(binding));
        return {
            missing: [...boundIds].filter(id => !declared.has(id)).sort(),
            extra: [...declared].filter(id => !boundIds.has(id)).sort()
        };
    }

    return {
        DEFAULT_INTRUSION_TOLERANCE_M,
        INTRUSION_NOISE_M,
        MAX_INTRUSION_TOLERANCE_M,
        PARCEL_ACT_GOALS,
        COVERAGE,
        normalizeGoal,
        normalizeTolerance,
        isRoadDesignation,
        isParcelAct,
        requiresParcels,
        siteOf,
        survivesInwardBuffer: (feature, radiusM, options) => survivesInwardBuffer(T(options), feature, radiusM),
        intrusionWidth,
        bindingFromParcels,
        boundParcelIds,
        compareDeclaration
    };
});
