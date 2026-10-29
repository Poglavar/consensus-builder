// A proposal's SITE (the ground it occupies) and its BINDING (the cadastral parcels that site reaches
// into), as one pure rule shared by the browser preview and the server. See PARCEL-OPTIONAL.md.
// The server runs this same function over the candidate parcels its source finds (an indexed
// search, backend/parcels/source-binding.js), so the browser and the server cannot disagree
// (docs/geometry-tolerances.md).
//
// THE RULE. A parcel is bound when `site ∩ parcel` is ground (geometry-tolerances.js isGround: wider
// than max(toleranceM, NOISE_M), the test reachesInto runs), i.e. when the widest circle that fits
// inside the intersection is wider than the tolerance. Intrusion is that width (the diameter of the
// largest inscribed circle), so a 0.3 m sliver along a boundary intrudes 0.3 m whatever its length
// or area. Site, parcels and regions are put on the shared grid first.
//
// Width is reported, not decided on: measured by bisection on the inward-buffer radius r ("does
// buffer(I, -r) still exist?", which is monotone in r), started from [0, sqrt(area/π)] (no inscribed
// circle can have more area than the polygon). It stops when the bracket is within max(0.5 mm,
// 0.05 % of r), so the reported width is within ±1 mm below 2 m and ±0.1 % above. turf.buffer runs
// in an azimuthal-equidistant metric frame centred on the geometry, so all distances here are
// ground metres.
//
// Pure: no DOM, no fetch. `turf` is the browser global, globalThis.turf in node tests, or an
// explicit `options.turf`.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__siteBinding = api;
})(typeof window !== 'undefined' ? window : globalThis, function (global) {
    'use strict';

    // Polygon-clip failures are typed and counted in one place (parcel-arrangement.js clipHealth).
    // The shared grid, noise value and inward-buffer test (geometry-tolerances.js).
    function gridApi() {
        return (typeof window !== 'undefined' && window.GeometryTolerances)
            || (typeof require === 'function' ? require('../geometry-tolerances.js') : null);
    }

    function clipFailureApi() {
        const api = (typeof window !== 'undefined' && window.__parcelArrangement)
            || (typeof require === 'function' ? require('./parcel-arrangement.js') : null);
        if (!api || typeof api.clipFailure !== 'function') throw new Error('parcel-arrangement.js (clip failures) is not loaded');
        return api;
    }

    // Policy default: any reach into a parcel binds it (PARCEL-OPTIONAL.md, MEMORY 2026-10-01).
    const DEFAULT_INTRUSION_TOLERANCE_M = 0;
    // Arithmetic floor, not policy: shared edges and coordinate rounding produce sub-millimetre
    // slivers. Anything narrower than this is not ground.
    const INTRUSION_NOISE_M = gridApi().NOISE_M;
    // A tolerance is measurement error, never a design allowance; above this it is refused.
    const MAX_INTRUSION_TOLERANCE_M = 1;


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

    // A design is never an act on parcels: it names none, its agreement does (plan-design-agreement.md,
    // simplification 1). A road designation (a polygon and no centreline) is a footprint like any
    // other, and the parcels it covers come from the binding.
    function asPolygonGeometry(value) {
        const geometry = value && value.type === 'Feature' ? value.geometry : value;
        return geometry && (geometry.type === 'Polygon' || geometry.type === 'MultiPolygon') ? geometry : null;
    }

    function hasOwnFootprint(record) {
        const api = footprintPartsApi();
        if (!api || !record) return false;
        return api.hasFootprint(api.footprintParts(record));
    }

    // A corridor drawn but not yet built: its land comes from preparation, so it is still a
    // material proposal on ground of its own, not a record about nothing.
    function isUnpreparedCorridor(record) {
        const api = footprintPartsApi();
        return !!api && !!record && !!api.footprintParts(record).corridorUnprepared;
    }

    // Whether this record is about nothing: neither its own geometry nor an authored site. Such a
    // record cannot be bound to ground, and a design must have one or the other.
    function requiresParcels(record) {
        if (!record || typeof record !== 'object') return true;
        return !asPolygonGeometry(record.site) && !hasOwnFootprint(record) && !isUnpreparedCorridor(record);
    }

    function toMultiPolygon(geometry) {
        const g = asPolygonGeometry(geometry);
        if (!g) return null;
        return g.type === 'MultiPolygon' ? g : { type: 'MultiPolygon', coordinates: [g.coordinates] };
    }

    /**
     * The proposal's site as a GeoJSON MultiPolygon (EPSG:4326), or null.
     *   1. an authored `record.site`;
     *   2. else the record's own footprint (plan-order.footprintOf: union of footprintParts).
     */
    function siteOf(record, options) {
        const opts = options || {};
        if (!record || typeof record !== 'object') return null;
        const authored = toMultiPolygon(record.site);
        if (authored) return authored;
        const t = T(opts);
        const plan = planOrderApi();
        if (t && plan && typeof plan.footprintOf === 'function' && hasOwnFootprint(record)) {
            const footprint = plan.footprintOf(record, { turf: t });
            const geometry = toMultiPolygon(footprint && (footprint.geometry || footprint));
            if (geometry) return geometry;
        }
        return null;
    }

    // The inward-buffer test lives in the shared module, so binding and every other stage run one function.
    const survivesInwardBuffer = (t, feature, radiusM) => gridApi().survivesInwardBuffer(t, feature, radiusM);

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

    // A provider identity is claimable only when the caller supplies its descriptor. The preview
    // label (`source`) is explanatory text and never identifies the cadastral source.
    function parcelSourceOf(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
        if (Object.keys(value).some(key => !['sourceId', 'snapshotId'].includes(key))) return null;
        const sourceId = typeof value.sourceId === 'string' ? value.sourceId.trim() : '';
        if (!sourceId) return null;
        const snapshotId = value.snapshotId == null ? null
            : (typeof value.snapshotId === 'string' ? value.snapshotId.trim() : '');
        if (snapshotId === '') return null;
        return { sourceId, snapshotId };
    }

    /**
     * The binding of `site` over the given parcels.
     * @param {object} site GeoJSON Polygon/MultiPolygon (or Feature), EPSG:4326.
     * @param {{id: string, geometry: object}[]} parcels every cadastral parcel the caller has near
     *   the site (unbound ones are needed too: they decide what is open ground).
     * @param {{toleranceM?: number, regionHasCadastre?: boolean, regions?: {id, geometry}[], source?: string, turf?: object}} options
     *   regionHasCadastre false = the region has no cadastre at all (coverage 'none', parcels ignored).
     *   regions = the surveyed regions (cadastral municipalities) the site meets, when the caller
     *   knows them: open ground inside one is unsurveyed, outside every one unknown.
     * @returns {{ parcels: {parcelId, overlapM2, intrusionM}[], touched: {parcelId, overlapM2, intrusionM}[],
     *   toleranceM: number, coverage: string, unsurveyedM2: number, unknownM2: number, siteM2: number, source: string }}
     *
     * Coverage:
     *   complete — every part of the site wider than the floor lies on some cadastral parcel;
     *   partial  — some ground wider than the floor lies on no parcel (unsurveyedM2 + unknownM2 > 0).
     *              A site in a surveyed region with no parcel under it at all is partial with
     *              unsurveyedM2 = siteM2;
     *   unknown  — `regions` is given and empty: the site lies outside every region the source
     *              surveys, so its cadastre cannot be read here (parcels ignored);
     *   none     — the caller says the region has no cadastre (explore): the whole site is open ground.
     * Open ground is measured against ALL given parcels, not only bound ones: a parcel the site
     * touches by less than the tolerance is within measurement error, not ground without an owner.
     * Its components count only if they are ground (isGround at toleranceM, the same test as
     * binding), so cadastral micro-gaps between abutting parcels are not open ground.
     */
    function bindingFromParcels(site, parcels, options) {
        const opts = options || {};
        const t = T(opts);
        if (!t) throw new Error('site-binding: turf is not available');
        const ground = gridApi();
        const clips = clipFailureApi();
        const toleranceM = normalizeTolerance(opts.toleranceM);
        const siteGeometry = asPolygonGeometry(site);
        if (!siteGeometry) throw new TypeError('site must be a GeoJSON Polygon or MultiPolygon');
        const siteFeature = t.feature(ground.snapGeometry(siteGeometry));
        const siteM2 = t.area(siteFeature);
        const source = opts.source || 'client-preview';
        const parcelSource = opts.regionHasCadastre === false ? null : parcelSourceOf(opts.parcelSource);
        const regions = Array.isArray(opts.regions)
            ? opts.regions.map(region => asPolygonGeometry(region && region.geometry)).filter(Boolean)
                .map(geometry => t.feature(ground.snapGeometry(geometry)))
            : null;
        const unbound = (coverage, unsurveyedM2, unknownM2) => ({ parcels: [], touched: [], toleranceM, coverage,
            unsurveyedM2: round(unsurveyedM2, 2), unknownM2: round(unknownM2, 2), siteM2: round(siteM2, 2), source, parcelSource });

        if (opts.regionHasCadastre === false) return unbound(COVERAGE.none, siteM2, 0);
        if (regions && !regions.length) return unbound(COVERAGE.unknown, 0, siteM2);

        const bound = [];
        const touched = [];
        const siteBox = t.bbox(siteFeature);
        let open = siteFeature;
        for (const parcel of parcels || []) {
            const geometry = parcel && asPolygonGeometry(parcel.geometry);
            if (!geometry) continue;
            const parcelFeature = t.feature(ground.snapGeometry(geometry));
            // Boxes apart share no ground (reachesInto's own first test); four comparisons save two clips.
            if (boxesApart(siteBox, t.bbox(parcelFeature))) continue;
            // reachesInto(site, parcel, toleranceM), with its intersection kept for the measurements.
            // A failed clip throws a typed ClipFailure: null would leave a parcel the site reaches
            // into unbound — stored on the record.
            const intersection = clips.clipWith(t, 'intersect', siteFeature, parcelFeature, { site: 'site-binding.bindingFromParcels', parcelId: parcel.id });
            if (open) {
                // Thrown too: "the larger estimate" overstated the unsurveyed ground the binding records.
                open = clips.clipWith(t, 'difference', open, parcelFeature, { site: 'site-binding.unsurveyed', parcelId: parcel.id });
            }
            if (!intersection || !polygonsOf(intersection).length) continue;
            const overlapM2 = t.area(intersection);
            if (!(overlapM2 > 0)) continue;
            const entry = {
                parcelId: String(parcel.id),
                overlapM2: round(overlapM2, 3),
                intrusionM: round(intrusionWidth(intersection, { turf: t }), 4)
            };
            if (ground.isGround(t, intersection, toleranceM)) bound.push(entry);
            else touched.push(entry);
        }

        // Open ground in a surveyed region is unsurveyed; outside every region it is unknown.
        const outside = open && regions ? ground.uncoveredBy(t, open, regions, { site: 'site-binding.unknown' }) : null;
        const inside = open && outside ? ground.uncoveredBy(t, open, [outside], { site: 'site-binding.unsurveyed' }) : open;
        const groundM2 = feature => polygonsOf(feature).reduce((sum, rings) => {
            const piece = t.polygon(rings);
            return ground.isGround(t, piece, toleranceM) ? sum + t.area(piece) : sum;
        }, 0);
        const unsurveyedM2 = groundM2(inside);
        const unknownM2 = groundM2(outside);
        const byId = (a, b) => (a.parcelId < b.parcelId ? -1 : a.parcelId > b.parcelId ? 1 : 0);
        bound.sort(byId);
        touched.sort(byId);
        return {
            parcels: bound,
            touched,
            toleranceM,
            coverage: unsurveyedM2 > 0 || unknownM2 > 0 ? COVERAGE.partial : COVERAGE.complete,
            unsurveyedM2: round(unsurveyedM2, 2),
            unknownM2: round(unknownM2, 2),
            siteM2: round(siteM2, 2),
            source,
            parcelSource
        };
    }

    const boxesApart = (a, b) => a[0] > b[2] || b[0] > a[2] || a[1] > b[3] || b[1] > a[3];

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
        COVERAGE,
        normalizeGoal,
        normalizeTolerance,
        hasOwnFootprint,
        requiresParcels,
        siteOf,
        survivesInwardBuffer: (feature, radiusM, options) => survivesInwardBuffer(T(options), feature, radiusM),
        intrusionWidth,
        bindingFromParcels,
        normalizeParcelSource: parcelSourceOf,
        boundParcelIds,
        compareDeclaration
    };
});
