// Proposal area measurements: site extent, source coverage and usable whole-source totals.
// Pure inputs and outputs; callers supply geometry measurement and handle unavailable sources.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ProposalArea = api;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';
    const positiveArea = value => Number.isFinite(value) && value > 0 ? value : null;

    function sourceAreaM2(feature, measureGeometry) {
        const stored = feature?.properties?.calculatedArea ?? feature?.properties?.calculated_area;
        if (positiveArea(stored) !== null) return stored;
        if (!feature?.geometry || typeof measureGeometry !== 'function') return null;
        return positiveArea(measureGeometry(feature.geometry));
    }

    function areaSummary({ hasSite = false, siteAreaM2 = null, sourceAreas = [], declaredCount = 0 } = {}) {
        const knownAreas = sourceAreas.filter(area => positiveArea(area) !== null);
        return {
            hasSite,
            siteAreaM2: hasSite ? positiveArea(siteAreaM2) : null,
            sourceAreaM2: knownAreas.length ? positiveArea(knownAreas.reduce((sum, area) => sum + area, 0)) : null,
            sourceCount: knownAreas.length,
            declaredCount,
            sourceComplete: declaredCount > 0 && knownAreas.length === declaredCount
        };
    }

    function sourceAreaMap(parcelIds = [], features = [], measureGeometry) {
        const areaMap = new Map(parcelIds.map(id => [id, null]));
        for (const feature of features) {
            const id = feature?.properties?.parcelId;
            if (areaMap.has(id)) areaMap.set(id, sourceAreaM2(feature, measureGeometry));
        }
        const summary = areaSummary({ sourceAreas: [...areaMap.values()], declaredCount: areaMap.size });
        return { areaMap, totalArea: summary.sourceComplete ? summary.sourceAreaM2 : null, ...summary };
    }

    function primaryArea(summary) {
        return summary.hasSite ? summary.siteAreaM2 : summary.sourceComplete ? summary.sourceAreaM2 : null;
    }

    // Unknown or incomplete extents sort last in either direction, never as zero-sized sites.
    function compareAreas(a, b, ascending = false) {
        const left = positiveArea(a), right = positiveArea(b);
        if (left === null) return right === null ? 0 : 1;
        if (right === null) return -1;
        return ascending ? left - right : right - left;
    }

    return Object.freeze({ sourceAreaM2, areaSummary, sourceAreaMap, primaryArea, compareAreas });
});
