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

    // What unionFootprints answers when the clipper threw: the footprint is unknown.
    const UNKNOWN_UNION = Object.freeze({ unknown: true });

    function unionFootprints(turfApi, features) {
        if (!features.length) return null;
        let combined = features[0];
        for (let index = 1; index < features.length; index += 1) {
            try {
                combined = turfApi.union(combined, features[index]) || combined;
            } catch (error) {
                // Was: null, which summarizeDensity read as "no union" and reported the SUMMED
                // footprints — overlaps counted twice — as the coverage. Now the footprint, its
                // overlap and the coverage are unknown (shown as "—"), and the failure is reported
                // and counted in clipHealth() (parcel-arrangement.js).
                const clips = (typeof window !== 'undefined' && window.__parcelArrangement)
                    || (typeof require === 'function' ? require('./proposals/parcel-arrangement.js') : null);
                if (!clips || typeof clips.reportClipFailure !== 'function') throw error;
                clips.reportClipFailure('union', error, { site: 'building-density-stats.unionFootprints' }, [combined, features[index]]);
                return UNKNOWN_UNION;
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
        const footprintAreaM2 = union === UNKNOWN_UNION ? null
            : (union ? safeArea(turfApi, union) : summedFootprintAreaM2);
        const aboveGroundGbpM2 = measured.reduce(
            (sum, item) => sum + (item.footprintAreaM2 * item.floors),
            0
        );

        return {
            buildingCount: measured.length,
            parcelAreaM2,
            footprintAreaM2,
            summedFootprintAreaM2,
            overlapAreaM2: footprintAreaM2 === null ? null : Math.max(0, summedFootprintAreaM2 - footprintAreaM2),
            // Ratios over the ground (a parcel, or a drawn site on open ground). With no ground
            // polygon there is nothing to divide by: null, not a 0 that reads like an empty plot.
            siteCoveragePercent: parcelAreaM2 > 0 && footprintAreaM2 !== null ? (footprintAreaM2 / parcelAreaM2) * 100 : null,
            aboveGroundGbpM2,
            kin: parcelAreaM2 > 0 ? aboveGroundGbpM2 / parcelAreaM2 : null
        };
    }

    // The Geometry statistics disclosure the urban-rule editors (Block, Row, Detached) share. Its
    // summary is the only heading; `prefix` namespaces the element ids. English fallbacks only:
    // each editor translates its panel through the data-i18n keys.
    function cardMarkup(prefix) {
        const row = (key, suffix, fallback) =>
            `<div><dt data-i18n-key="densityStats.${key}" data-i18n-attr="text">${fallback}</dt><dd id="${prefix}-density-${suffix}">\u2014</dd></div>`;
        return `<details>
            <summary data-i18n-key="densityStats.title" data-i18n-attr="text">Geometry statistics</summary>
            <section id="${prefix}-density-stats" class="building-density-card" aria-live="polite">
                <dl class="building-density-grid">
                    ${row('parcelArea', 'parcel', 'Parcel area')}
                    ${row('footprint', 'footprint', 'Building footprint')}
                    ${row('siteCoverage', 'coverage', 'Site coverage')}
                    ${row('gbp', 'gbp', 'Above-ground floor area')}
                    ${row('kin', 'kin', 'Floor area ratio (above ground)')}
                </dl>
                <p id="${prefix}-density-hint" class="building-density-hint"></p>
            </section>
        </details>`;
    }

    // Display strings for one summary, formatted with js/format.js (CbFormat). The ratios need
    // ground to divide by, so without it they show a dash rather than a 0 that reads as empty.
    function cardValues(stats, format) {
        const dash = '\u2014';
        const ground = Boolean(stats && stats.parcelAreaM2 > 0);
        const area = value => (stats && Number.isFinite(value) ? format.formatArea(value) : dash);
        return {
            parcel: ground ? area(stats.parcelAreaM2) : dash,
            footprint: area(stats && stats.footprintAreaM2),
            coverage: ground ? format.formatPercent(stats.siteCoveragePercent, { ofHundred: true, maxFractionDigits: 1, missing: dash }) : dash,
            gbp: area(stats && stats.aboveGroundGbpM2),
            kin: ground ? format.formatNumber(stats.kin, { maxFractionDigits: 3, missing: dash }) : dash
        };
    }

    // Fill a card made by cardMarkup. A geometry the summary cannot measure shows dashes.
    function refreshCard(doc, prefix, input, { format, hint } = {}) {
        let stats = null;
        try { stats = summarizeDensity({ preferHeight: true, ...input }); } catch (_) { }
        const values = cardValues(stats, format);
        for (const [suffix, value] of Object.entries(values)) {
            const element = doc.getElementById(`${prefix}-density-${suffix}`);
            if (element) element.textContent = value;
        }
        const hintElement = doc.getElementById(`${prefix}-density-hint`);
        if (hintElement && typeof hint === 'string') hintElement.textContent = hint;
        return values;
    }

    return {
        DEFAULT_FLOOR_HEIGHT_M,
        summarizeDensity,
        cardMarkup,
        cardValues,
        refreshCard
    };
});
