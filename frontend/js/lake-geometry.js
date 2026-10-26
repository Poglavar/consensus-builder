// Shared lake graphics for the map editor and granular agent edits.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.LakeGeometry = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';
    const LAKE_GRAPHICS_VERSION = 3;
    const LAKE_SHORE_TARGET_RATIO = 0.2;

    function isEditable(geometry, isSimpleRing) {
        const polygon = geometry?.type === 'Polygon' ? geometry.coordinates
            : geometry?.type === 'MultiPolygon' && geometry.coordinates?.length === 1 ? geometry.coordinates[0] : null;
        const ring = polygon?.[0];
        try { return Array.isArray(ring) && ring.length >= 4 && !!isSimpleRing(ring); }
        catch (_) { return false; }
    }

    function computeLakeZonesForGeometry(baseFeature, options, turf, reportClipFailure) {
        const targetRatio = typeof options.targetShoreRatio === 'number'
            ? Math.max(0.05, Math.min(0.45, options.targetShoreRatio))
            : LAKE_SHORE_TARGET_RATIO;
        const baseArea = Math.max(0, turf.area(baseFeature) || 0);
        if (!baseArea) return null;

        let bbox = null;
        try { bbox = turf.bbox(baseFeature); } catch (_) { bbox = null; }
        const [minLng, minLat, maxLng, maxLat] = Array.isArray(bbox) && bbox.length === 4 ? bbox : [0, 0, 0, 0];
        let widthMeters = 0;
        let heightMeters = 0;
        try { widthMeters = turf.distance([minLng, minLat], [maxLng, minLat], { units: 'meters' }); } catch (_) { widthMeters = 0; }
        try { heightMeters = turf.distance([minLng, minLat], [minLng, maxLat], { units: 'meters' }); } catch (_) { heightMeters = 0; }
        const minDim = Math.max(1, Math.min(Math.max(widthMeters, 0), Math.max(heightMeters, 0)));
        const minWidth = 0.5;
        const maxWidth = Math.max(minWidth, minDim * 0.45);
        const areaGuess = Math.sqrt(baseArea / Math.PI) * 0.105;
        const widthHint = Math.max(minWidth, Math.min(maxWidth, typeof options.widthHintMeters === 'number' ? options.widthHintMeters : areaGuess));
        let low = minWidth;
        let high = maxWidth;
        let best = null;
        let bestBelow = null;

        for (let i = 0; i < 7; i++) {
            const width = (i === 0) ? widthHint : (low + high) / 2;
            let water = null;
            try { water = turf.buffer(baseFeature, -width, { units: 'meters', steps: 32 }); } catch (_) { water = null; }
            if (!water || !water.geometry || !water.geometry.coordinates || !water.geometry.coordinates.length) {
                high = Math.max(minWidth, width * 0.8);
                continue;
            }
            const waterArea = Math.max(0, turf.area(water) || 0);
            if (!waterArea) {
                high = Math.max(minWidth, width * 0.8);
                continue;
            }
            let shore = null;
            try { shore = turf.difference(baseFeature, water); } catch (error) {
                // Lake graphics only: the shore falls back to the whole lake, reported.
                reportClipFailure('difference', error, { site: 'proposals-geometry.lakeShore' }, [baseFeature, water]);
                shore = null;
            }
            if (!shore) shore = baseFeature;
            const ratio = Math.max(0, Math.min(1, (baseArea - waterArea) / baseArea));
            const delta = Math.abs(ratio - targetRatio);
            const current = { water, shore, width, ratio, delta };
            if (ratio <= targetRatio && (!bestBelow || ratio > bestBelow.ratio)) bestBelow = current;
            if (!best || delta < best.delta) best = current;
            if (ratio > targetRatio) {
                high = width;
            } else {
                low = width;
            }
        }

        const chosen = bestBelow || best;
        if (!chosen) return null;

        let transition = null;
        try {
            const outerWidth = Math.max(minWidth, chosen.width * 0.55);
            const outer = turf.buffer(baseFeature, -outerWidth, { units: 'meters', steps: 32 });
            if (outer && outer.geometry && chosen.water && chosen.water.geometry) {
                try { transition = turf.difference(outer, chosen.water); } catch (error) {
                    // Lake graphics only: no transition band, reported.
                    reportClipFailure('difference', error, { site: 'proposals-geometry.lakeTransition' }, [outer, chosen.water]);
                    transition = null;
                }
            }
        } catch (_) { transition = null; }

        return {
            water: chosen.water,
            shore: chosen.shore,
            transition,
            width: chosen.width,
            ratio: chosen.ratio
        };
    }

    function build(geometry, options = {}) {
        const { turf, reportClipFailure = () => {} } = options;
        if (!geometry || !geometry.type || !geometry.coordinates || !turf) return null;
        const polygons = [];
        try {
            if (geometry.type === 'Polygon') {
                polygons.push(turf.polygon(geometry.coordinates));
            } else if (geometry.type === 'MultiPolygon') {
                geometry.coordinates.forEach(rings => polygons.push(turf.polygon(rings)));
            }
        } catch (_) { }
        if (!polygons.length) return null;

        let merged = polygons[0];
        for (let i = 1; i < polygons.length; i++) {
            try {
                const next = turf.union(merged, polygons[i]);
                if (next && next.geometry) merged = next;
            } catch (error) {
                // Lake graphics only: the parts stay separate, reported.
                reportClipFailure('union', error, { site: 'proposals-geometry.lakeUnion' }, [merged, polygons[i]]);
            }
        }
        const base = merged && merged.geometry ? merged : polygons[0];

        const zones = computeLakeZonesForGeometry(base, {
            targetShoreRatio: LAKE_SHORE_TARGET_RATIO,
            widthHintMeters: typeof options.shoreWidthMeters === 'number' ? Math.max(0.5, options.shoreWidthMeters) : null
        }, turf, reportClipFailure) || null;
        const shore = zones && zones.shore ? zones.shore : base;
        const water = zones && zones.water ? zones.water : null;
        const transition = zones && zones.transition ? zones.transition : null;
        const shoreWidth = zones && zones.width ? zones.width : (typeof options.shoreWidthMeters === 'number' ? Math.max(0.5, options.shoreWidthMeters) : 6);

        const fish = [];
        const fishArea = water && water.geometry ? water : base;
        try {
            const bbox = turf.bbox(fishArea);
            const desired = Math.max(2, Math.min(8, Math.round((turf.area(fishArea) || 0) / 8000)));
            const candidates = turf.randomPoint(desired * 3, { bbox });
            candidates.features.forEach(pt => {
                try {
                    if (turf.booleanPointInPolygon(pt, fishArea) && fish.length < desired) {
                        fish.push(pt.geometry.coordinates);
                    }
                } catch (_) { /* skip invalid */ }
            });
        } catch (_) { }

        return {
            geometry: base.geometry || geometry,
            shore: shore && shore.geometry ? shore.geometry : (shore.geometry ? shore.geometry : shore),
            water: water && water.geometry ? water.geometry : null,
            transition: transition && transition.geometry ? transition.geometry : null,
            fish,
            version: LAKE_GRAPHICS_VERSION,
            shoreWidthMeters: shoreWidth,
            shoreRatio: zones && typeof zones.ratio === 'number' ? zones.ratio : null
        };
    }

    return { build, isEditable };
});
