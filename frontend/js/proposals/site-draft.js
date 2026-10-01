// The pure half of site-first proposal authoring (PARCEL-OPTIONAL.md, phase 2): turning a drawn ring
// or a parcel selection into a site, checking a draft has the ground its goal needs, snapping a
// drawn vertex to nearby parcel/building edges, and summarising a binding (preview or server) into
// the rows and warnings the binding preview shows. No DOM, no Leaflet, no fetch; UMD so
// backend/test/site-draft.test.js loads it headlessly. The map half is js/site-drawing.js.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__siteDraft = api;
})(typeof window !== 'undefined' ? window : globalThis, function (global) {
    'use strict';

    // A bound parcel reached into by less than this is flagged: it is usually a design traced from
    // a boundary that leaks across it, not land the author means to take (PARCEL-OPTIONAL.md).
    const SMALL_INTRUSION_M = 0.5;
    // Smallest site worth a proposal, and the vertex cap a hand-drawn site may carry.
    const MIN_SITE_AREA_M2 = 1;
    const MAX_SITE_VERTICES = 500;
    // Snapping radius for a drawn vertex, in screen pixels (converted by the caller to metres).
    const SNAP_RADIUS_PX = 12;

    function T(options) {
        if (options && options.turf) return options.turf;
        if (typeof turf !== 'undefined' && turf) return turf; // eslint-disable-line no-undef
        if (global && global.turf) return global.turf;
        try { return typeof require === 'function' ? require('@turf/turf') : null; } catch (_) { return null; }
    }

    function siteBinding() {
        if (global && global.__siteBinding) return global.__siteBinding;
        try { return typeof require === 'function' ? require('./site-binding.js') : null; } catch (_) { return null; }
    }

    function isPolygonal(value) {
        const g = value && value.type === 'Feature' ? value.geometry : value;
        return !!(g && (g.type === 'Polygon' || g.type === 'MultiPolygon') && Array.isArray(g.coordinates) && g.coordinates.length);
    }

    function geometryOf(value) {
        return value && value.type === 'Feature' ? value.geometry : value;
    }

    function toMultiPolygon(value) {
        const g = geometryOf(value);
        if (!isPolygonal(g)) return null;
        return g.type === 'MultiPolygon' ? { type: 'MultiPolygon', coordinates: g.coordinates } : { type: 'MultiPolygon', coordinates: [g.coordinates] };
    }

    const finite = value => typeof value === 'number' && Number.isFinite(value);
    const validCoordinate = c => Array.isArray(c) && finite(c[0]) && finite(c[1]) && Math.abs(c[0]) <= 180 && Math.abs(c[1]) <= 90;

    // Open ring (no closing vertex), consecutive duplicates removed.
    function openRing(ring) {
        const out = [];
        (Array.isArray(ring) ? ring : []).forEach(c => {
            if (!validCoordinate(c)) return;
            const prev = out[out.length - 1];
            if (prev && prev[0] === c[0] && prev[1] === c[1]) return;
            out.push([c[0], c[1]]);
        });
        if (out.length > 1 && out[0][0] === out[out.length - 1][0] && out[0][1] === out[out.length - 1][1]) out.pop();
        return out;
    }

    /**
     * A drawn ring ([lng, lat] vertices, open or closed) as a site.
     * @returns {{ ok: true, site, areaM2 } | { ok: false, reason: 'too-few-vertices'|'too-many-vertices'|'self-intersecting'|'too-small' }}
     */
    function siteFromRing(ring, options) {
        const t = T(options);
        if (!t) throw new Error('site-draft: turf is not available');
        const points = openRing(ring);
        if (points.length < 3) return { ok: false, reason: 'too-few-vertices' };
        if (points.length > MAX_SITE_VERTICES) return { ok: false, reason: 'too-many-vertices' };
        const polygon = t.polygon([points.concat([points[0].slice()])]);
        let kinks = null;
        try { kinks = t.kinks(polygon); } catch (_) { kinks = null; }
        if (kinks && Array.isArray(kinks.features) && kinks.features.length) return { ok: false, reason: 'self-intersecting' };
        const rewound = t.rewind(polygon, { reverse: false });
        const areaM2 = t.area(rewound);
        if (!(areaM2 >= MIN_SITE_AREA_M2)) return { ok: false, reason: 'too-small' };
        return { ok: true, site: toMultiPolygon(rewound.geometry), areaM2 };
    }

    // The union of the given polygon features as a site (a parcel selection "used as site").
    function siteFromFeatures(features, options) {
        const t = T(options);
        if (!t) throw new Error('site-draft: turf is not available');
        let acc = null;
        (Array.isArray(features) ? features : []).forEach(feature => {
            const g = geometryOf(feature);
            if (!isPolygonal(g)) return;
            const f = t.feature(g);
            if (!acc) { acc = f; return; }
            try { acc = t.union(acc, f) || acc; } catch (_) { /* keep what we have */ }
        });
        return acc ? toMultiPolygon(acc.geometry) : null;
    }

    function siteAreaM2(site, options) {
        const t = T(options);
        const g = toMultiPolygon(site);
        return t && g ? t.area(t.feature(g)) : 0;
    }

    // The bounds shape calculateProposalBounds returns (centre, N/S/E/W), from a site's extent.
    function siteBounds(site) {
        const g = toMultiPolygon(site);
        if (!g) return null;
        let west = Infinity; let south = Infinity; let east = -Infinity; let north = -Infinity;
        g.coordinates.forEach(polygon => (polygon[0] || []).forEach(c => {
            if (!validCoordinate(c)) return;
            west = Math.min(west, c[0]); east = Math.max(east, c[0]);
            south = Math.min(south, c[1]); north = Math.max(north, c[1]);
        }));
        if (!finite(west) || !finite(north)) return null;
        return {
            center: { lat: (north + south) / 2, lng: (east + west) / 2 },
            north, south, east, west,
            calculatedAt: new Date().toISOString(),
            parcelCount: 0,
            totalParcels: 0,
            fromSite: true
        };
    }

    // Draft ground: the authored site of a draft, or null.
    function draftSite(draft) {
        const site = draft && draft.fields ? draft.fields.site : null;
        return isPolygonal(site) ? toMultiPolygon(site) : null;
    }

    // Whether a draft already holds its own design geometry (a drawn corridor, a station footprint,
    // a building, a readjustment plan): those are material proposals whose site is their footprint.
    function draftHasDesignGeometry(draft) {
        const payload = (draft && draft.editorPayload) || {};
        const definition = payload.definition || null;
        if (definition) {
            const points = Array.isArray(definition.points) ? definition.points : (Array.isArray(definition.segments) ? definition.segments : []);
            if (points.length || isPolygonal(definition.polygon)) return true;
        }
        if (payload.structureProposal && isPolygonal(payload.structureProposal.geometry)) return true;
        if (isPolygonal(payload.geometry)) return true;
        const context = payload.context || {};
        if (Array.isArray(context.buildings) && context.buildings.some(f => isPolygonal(f))) return true;
        if (context.buildingFeature && isPolygonal(context.buildingFeature)) return true;
        if (payload.plan && Array.isArray(payload.plan.polygons) && payload.plan.polygons.length) return true;
        return false;
    }

    function draftRecordShape(draft) {
        const fields = (draft && draft.fields) || {};
        const facets = fields.facets || {};
        return {
            goal: draft && draft.goal,
            isVote: facets.ownership === 'no-change' && facets.parcels === 'as-is',
            proposalRole: fields.proposalRole || null
        };
    }

    /**
     * The ground issue of a draft, or null. A parcel act needs parcels (`missing-parcels`); a
     * material proposal needs a site, parcels, or its own design geometry (`missing-site`).
     */
    function draftGroundIssue(draft) {
        const fields = (draft && draft.fields) || {};
        const hasParcels = Array.isArray(fields.selectedParcelIds) && fields.selectedParcelIds.length > 0;
        if (hasParcels) return null;
        const api = siteBinding();
        const parcelAct = api && typeof api.isParcelAct === 'function' ? api.isParcelAct(draftRecordShape(draft)) : true;
        if (parcelAct) {
            return { code: 'missing-parcels', message: 'Select at least one parcel.', path: 'fields.selectedParcelIds' };
        }
        if (draftSite(draft) || draftHasDesignGeometry(draft)) return null;
        return { code: 'missing-site', message: 'Draw a site or select parcels.', path: 'fields.site' };
    }

    // ---- snapping ----

    // Nearest point to `p` on segment ab in a local equirectangular metre frame around p.
    function nearestOnSegment(p, a, b, mx, my) {
        const ax = (a[0] - p[0]) * mx;
        const ay = (a[1] - p[1]) * my;
        const bx = (b[0] - p[0]) * mx;
        const by = (b[1] - p[1]) * my;
        const dx = bx - ax;
        const dy = by - ay;
        const len2 = dx * dx + dy * dy;
        let u = len2 > 0 ? -(ax * dx + ay * dy) / len2 : 0;
        u = Math.max(0, Math.min(1, u));
        const x = ax + u * dx;
        const y = ay + u * dy;
        return { coordinate: [p[0] + x / mx, p[1] + y / my], distanceM: Math.sqrt(x * x + y * y) };
    }

    function ringsOf(value) {
        const g = geometryOf(value);
        if (!g) return [];
        if (g.type === 'Polygon') return g.coordinates;
        if (g.type === 'MultiPolygon') return g.coordinates.flat();
        if (g.type === 'LineString') return [g.coordinates];
        if (g.type === 'MultiLineString') return g.coordinates;
        return [];
    }

    /**
     * Snap a drawn coordinate to the nearest vertex (preferred) or edge of `targets` within
     * `radiusM`. Vertices win within the radius even when an edge is nearer, so corners land exactly
     * on parcel corners. Targets: GeoJSON features/geometries (parcels, building outlines).
     * @returns {{ coordinate: [lng, lat], snapped: false } | { coordinate, snapped: 'vertex'|'edge', distanceM, targetIndex }}
     */
    function snapCoordinate(coordinate, targets, options) {
        const opts = options || {};
        if (!validCoordinate(coordinate)) return { coordinate, snapped: false };
        const radiusM = finite(opts.radiusM) && opts.radiusM > 0 ? opts.radiusM : 1;
        const my = 111320;
        const mx = 111320 * Math.cos(coordinate[1] * Math.PI / 180);
        let bestVertex = null;
        let bestEdge = null;
        (Array.isArray(targets) ? targets : []).forEach((target, targetIndex) => {
            ringsOf(target).forEach(ring => {
                if (!Array.isArray(ring)) return;
                for (let i = 0; i < ring.length; i++) {
                    const a = ring[i];
                    if (!validCoordinate(a)) continue;
                    const vx = (a[0] - coordinate[0]) * mx;
                    const vy = (a[1] - coordinate[1]) * my;
                    const vd = Math.sqrt(vx * vx + vy * vy);
                    if (vd <= radiusM && (!bestVertex || vd < bestVertex.distanceM)) {
                        bestVertex = { coordinate: [a[0], a[1]], distanceM: vd, targetIndex };
                    }
                    const b = ring[i + 1];
                    if (!validCoordinate(b)) continue;
                    const hit = nearestOnSegment(coordinate, a, b, mx, my);
                    if (hit.distanceM <= radiusM && (!bestEdge || hit.distanceM < bestEdge.distanceM)) {
                        bestEdge = { coordinate: hit.coordinate, distanceM: hit.distanceM, targetIndex };
                    }
                }
            });
        });
        if (bestVertex) return { ...bestVertex, snapped: 'vertex' };
        if (bestEdge) return { ...bestEdge, snapped: 'edge' };
        return { coordinate: [coordinate[0], coordinate[1]], snapped: false };
    }

    /**
     * The open ground of a site over the given parcels: site minus every parcel, keeping only
     * components wider than max(toleranceM, 1 mm) (the binding rule's floor, so cadastral
     * micro-gaps are not open ground). regionHasCadastre false = the whole site. MultiPolygon or null.
     * This is what the preview hatches; like any client preview it cannot tell a cadastral hole
     * from the edge of what was loaded.
     */
    function openGroundOf(site, parcels, options) {
        const opts = options || {};
        const t = T(opts);
        const siteGeometry = toMultiPolygon(site);
        if (!t || !siteGeometry) return null;
        if (opts.regionHasCadastre === false) return siteGeometry;
        const api = siteBinding();
        const floorM = Math.max(Number(opts.toleranceM) || 0, api ? api.INTRUSION_NOISE_M : 0.001);
        let open = t.feature(siteGeometry);
        for (const parcel of parcels || []) {
            const g = geometryOf(parcel && (parcel.geometry || parcel));
            if (!open || !isPolygonal(g)) continue;
            try { open = t.difference(open, t.feature(g)); } catch (_) { /* keep the larger estimate */ }
        }
        if (!open || !open.geometry) return null;
        const polygons = (open.geometry.type === 'Polygon' ? [open.geometry.coordinates] : open.geometry.coordinates)
            .filter(rings => {
                const piece = t.polygon(rings);
                let eroded = null;
                try { eroded = t.buffer(piece, -floorM / 2, { units: 'meters' }); } catch (_) { eroded = null; }
                return !!(eroded && eroded.geometry && t.area(eroded) > 0);
            });
        return polygons.length ? { type: 'MultiPolygon', coordinates: polygons } : null;
    }

    // ---- binding summary ----

    const COVERAGE_KEYS = Object.freeze({
        complete: 'complete',
        partial: 'partial',
        none: 'none',
        unknown: 'unknown'
    });

    // "4 cm", "0.42 m", "12 m" — the width in the unit a person reads it in.
    function formatWidth(widthM) {
        if (!finite(widthM) || widthM < 0) return '';
        if (widthM < 0.01) return `${Math.max(1, Math.round(widthM * 1000))} mm`;
        if (widthM < 1) return `${Math.round(widthM * 100)} cm`;
        if (widthM < 10) return `${(Math.round(widthM * 10) / 10).toFixed(1)} m`;
        return `${Math.round(widthM)} m`;
    }

    /**
     * What the binding preview shows for a binding (client preview or server answer).
     * @returns {{ coverage, source, isPreview, bound: [], touched: [], warnings: [{parcelId, intrusionM, kind, width}],
     *   openGround: boolean, unsurveyedM2, siteM2, parcelCount }}
     *  kind 'touched' — reaches in below a tolerance > 0 (not bound; at tolerance 0 it is noise);
     *  kind 'small'   — bound, but by less than SMALL_INTRUSION_M ("include it, or change the design").
     */
    function bindingSummary(binding, options) {
        const opts = options || {};
        const smallM = finite(opts.smallIntrusionM) ? opts.smallIntrusionM : SMALL_INTRUSION_M;
        const b = binding || {};
        const bound = Array.isArray(b.parcels) ? b.parcels.slice() : [];
        const touched = Array.isArray(b.touched) ? b.touched.slice() : [];
        const coverage = COVERAGE_KEYS[b.coverage] || 'unknown';
        const warnings = [];
        // Touched parcels matter only under a tolerance: at tolerance 0 "touched" means a sliver
        // below the 1 mm arithmetic floor — a shared edge or a snapped corner, not a reach.
        const tolerance = finite(b.toleranceM) ? b.toleranceM : 0;
        touched.forEach(hit => {
            if (!hit || !(tolerance > 0)) return;
            warnings.push({ parcelId: String(hit.parcelId), intrusionM: hit.intrusionM, kind: 'touched', width: formatWidth(hit.intrusionM) });
        });
        bound.forEach(hit => {
            if (!hit || !finite(hit.intrusionM) || hit.intrusionM >= smallM) return;
            warnings.push({ parcelId: String(hit.parcelId), intrusionM: hit.intrusionM, kind: 'small', width: formatWidth(hit.intrusionM) });
        });
        warnings.sort((x, y) => (x.intrusionM || 0) - (y.intrusionM || 0));
        const unsurveyedM2 = finite(b.unsurveyedM2) ? b.unsurveyedM2 : 0;
        return {
            coverage,
            source: b.source || null,
            isPreview: b.source === 'client-preview',
            bound,
            touched,
            warnings,
            openGround: coverage === 'partial' || coverage === 'none' || unsurveyedM2 > 0,
            // A site inside a surveyed region that no parcel touches at all (an unsurveyed hole):
            // still 'partial' by the binding's definition, but all of it is open ground.
            allOpen: coverage === 'none' || (coverage === 'partial' && finite(b.siteM2) && b.siteM2 > 0 && unsurveyedM2 >= b.siteM2 * 0.999),
            unsurveyedM2,
            siteM2: finite(b.siteM2) ? b.siteM2 : null,
            parcelCount: bound.length
        };
    }

    // Which bound parcels a publish takes with only a small intrusion and the author has not
    // already accepted (the list the publish confirmation asks about).
    function unconfirmedSmallIntrusions(binding, acceptedIds, options) {
        const accepted = new Set((acceptedIds || []).map(String));
        return bindingSummary(binding, options).warnings
            .filter(w => w.kind === 'small' && !accepted.has(w.parcelId));
    }

    return {
        SMALL_INTRUSION_M,
        MIN_SITE_AREA_M2,
        MAX_SITE_VERTICES,
        SNAP_RADIUS_PX,
        isPolygonal,
        toMultiPolygon,
        openRing,
        siteFromRing,
        siteFromFeatures,
        siteAreaM2,
        siteBounds,
        draftSite,
        draftHasDesignGeometry,
        draftGroundIssue,
        snapCoordinate,
        openGroundOf,
        formatWidth,
        bindingSummary,
        unconfirmedSmallIntrusions
    };
});
