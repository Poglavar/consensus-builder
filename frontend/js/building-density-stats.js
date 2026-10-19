// Computes live parcel-density indicators from the geometry shown in the building editors.
// The browser editors and fast unit tests share this module so coverage, GBP and kin stay consistent.

(function attachBuildingDensityStats(root, factory) {
    const api = factory();

    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }

    if (root) root.BuildingDensityStats = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createBuildingDensityStats() {
    const DEFAULT_FLOOR_HEIGHT_M = 3;

    function positiveNumber(value) {
        const number = Number(value);
        return Number.isFinite(number) && number > 0 ? number : null;
    }

    function featureFrom(value) {
        const candidate = value && value.feature ? value.feature : value;
        if (!candidate || candidate.type !== 'Feature' || !candidate.geometry) return null;
        if (!['Polygon', 'MultiPolygon'].includes(candidate.geometry.type)) return null;
        return candidate;
    }

    function floorCountFor(value, feature, options) {
        const properties = feature.properties || {};
        const explicit = positiveNumber(
            value?.floors
            ?? value?.storeys
            ?? properties.floors
            ?? properties.storeys
            ?? properties.aboveGroundStoreys
        );
        const height = positiveNumber(
            value?.height
            ?? value?.heightM
            ?? properties.height
            ?? properties.heightM
        );
        const floorHeightM = positiveNumber(options.floorHeightM) || DEFAULT_FLOOR_HEIGHT_M;

        if (options.preferHeight === true && height) return height / floorHeightM;
        if (explicit) return explicit;
        return height ? height / floorHeightM : 0;
    }

    function safeArea(turfApi, feature) {
        try {
            const area = turfApi.area(feature);
            return Number.isFinite(area) && area > 0 ? area : 0;
        } catch (_) {
            return 0;
        }
    }

    function unionFootprints(turfApi, features) {
        if (!features.length) return null;
        let combined = features[0];
        for (let index = 1; index < features.length; index += 1) {
            try {
                combined = turfApi.union(combined, features[index]) || combined;
            } catch (_) {
                return null;
            }
        }
        return combined;
    }

    function summarizeDensity({ parcelFeature, buildings = [], turf: turfApi, floorHeightM, preferHeight = false } = {}) {
        if (!turfApi || typeof turfApi.area !== 'function') {
            throw new Error('A Turf-compatible area function is required.');
        }

        const parcel = featureFrom(parcelFeature);
        const parcelAreaM2 = parcel ? safeArea(turfApi, parcel) : 0;
        const options = { floorHeightM, preferHeight };
        const measured = buildings
            .map(value => {
                const feature = featureFrom(value);
                if (!feature) return null;
                const footprintAreaM2 = safeArea(turfApi, feature);
                if (!footprintAreaM2) return null;
                return {
                    feature,
                    footprintAreaM2,
                    floors: floorCountFor(value, feature, options)
                };
            })
            .filter(Boolean);

        const summedFootprintAreaM2 = measured.reduce((sum, item) => sum + item.footprintAreaM2, 0);
        const union = typeof turfApi.union === 'function'
            ? unionFootprints(turfApi, measured.map(item => item.feature))
            : null;
        const footprintAreaM2 = union ? safeArea(turfApi, union) : summedFootprintAreaM2;
        const aboveGroundGbpM2 = measured.reduce(
            (sum, item) => sum + (item.footprintAreaM2 * item.floors),
            0
        );

        return {
            buildingCount: measured.length,
            parcelAreaM2,
            footprintAreaM2,
            summedFootprintAreaM2,
            overlapAreaM2: Math.max(0, summedFootprintAreaM2 - footprintAreaM2),
            // Ratios over the ground (a parcel, or a drawn site on open ground). With no ground
            // polygon there is nothing to divide by: null, not a 0 that reads like an empty plot.
            siteCoveragePercent: parcelAreaM2 > 0 ? (footprintAreaM2 / parcelAreaM2) * 100 : null,
            aboveGroundGbpM2,
            kin: parcelAreaM2 > 0 ? aboveGroundGbpM2 / parcelAreaM2 : null
        };
    }

    // Display formatting is not here: the editors render these numbers with js/format.js (CbFormat).
    return {
        DEFAULT_FLOOR_HEIGHT_M,
        summarizeDensity
    };
});
