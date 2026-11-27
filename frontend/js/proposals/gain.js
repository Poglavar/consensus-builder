// The value-gain math for the 3D view, in the city's currency: built vs proposed floor area per parcel, and the gain a
// proposal creates. This is the money number the panel shows, so it lives in its own module with
// unit tests — the arithmetic used to be welded into DOM writes in three-mode.js with no coverage.
//
// Pure: geometry ops and the building footprint/height lookups are injected. The browser layer in
// three-mode.js resolves the parcel feature and the built/proposed building lists and hands them in.

(function (global) {
    'use strict';

    // Drop coincident duplicate meshes from a nearby-buildings response. Some city 3D models
    // (notably Zagreb gdi_building_3d) store a building twice under different object_ids with the
    // same footprint — this double-counts existing volume in the gain calc. Two buildings are the
    // same when their vertex-mean centroids are within ~2 m and their vertical extents match within
    // 1 m. A ~5 m grid with a 3x3 neighbour scan keeps this O(vertices).
    // Polygon-clip failures are typed and counted in one place (parcel-arrangement.js clipHealth).
    function clipFailureApi() {
        const api = (typeof window !== 'undefined' && window.__parcelArrangement)
            || (typeof require === 'function' ? require('./parcel-arrangement.js') : null);
        if (!api || typeof api.clipFailure !== 'function') throw new Error('parcel-arrangement.js (clip failures) is not loaded');
        return api;
    }

    function localFrameApi() {
        if (global && global.LocalFrame) return global.LocalFrame;
        if (typeof require === 'function') return require('../local-frame.js');
        throw new Error('gain: local-frame.js is not loaded');
    }

    function dedupeCoincidentBuildings(buildings) {
        if (!Array.isArray(buildings) || buildings.length < 2) return buildings || [];
        const CELL_M = 5, MERGE_DIST_M = 2;
        const grid = new Map();
        const keep = [];
        // One plane for the whole response: the affine local frame on the first building's centroid,
        // with the ellipsoid's true scales (local-frame.js), so every centroid is measured alike.
        let frame = null;
        for (const bld of buildings) {
            let sx = 0, sy = 0, n = 0;
            if (Array.isArray(bld.faces)) {
                for (const face of bld.faces) {
                    const coords = face && face.coordinates;
                    if (!Array.isArray(coords)) continue;
                    for (const ring of coords) {
                        if (!Array.isArray(ring)) continue;
                        for (const c of ring) {
                            if (c && c.length >= 2 && isFinite(c[0]) && isFinite(c[1])) { sx += c[0]; sy += c[1]; n++; }
                        }
                    }
                }
            }
            if (!n) { keep.push(bld); continue; }
            const lng = sx / n, lat = sy / n;
            if (!frame) frame = localFrameApi().makeLocalFrame(lng, lat);
            const [x, y] = frame.toMeters(lng, lat);
            const ci = Math.floor(x / CELL_M), cj = Math.floor(y / CELL_M);
            const zmin = Number(bld.z_min), zmax = Number(bld.z_max);
            let dup = false;
            for (let di = -1; di <= 1 && !dup; di++) {
                for (let dj = -1; dj <= 1 && !dup; dj++) {
                    const arr = grid.get((ci + di) + ':' + (cj + dj));
                    if (!arr) continue;
                    for (const e of arr) {
                        if (Math.hypot(e.x - x, e.y - y) < MERGE_DIST_M
                            && Math.abs(e.zmax - zmax) < 1 && Math.abs(e.zmin - zmin) < 1) { dup = true; break; }
                    }
                }
            }
            if (dup) continue;
            const key = ci + ':' + cj;
            let cell = grid.get(key);
            if (!cell) { cell = []; grid.set(key, cell); }
            cell.push({ x, y, zmin, zmax });
            keep.push(bld);
        }
        return keep;
    }

    // Built/proposed volume (m³) and derived floor area (m²) for one parcel.
    // Built volume: each existing building's footprint ∩ parcel × its z-extent height.
    // Proposed volume: each proposed feature ∩ parcel × its estimated height.
    // opts: { floorHeightM, turf, footprintOf(bld)->polygon|null, heightOf(feature)->metres }.
    // The lng/lat box of every coordinate pair under `value` (a geometry, faces, any nesting), or
    // null. Cached per geometry object: the same buildings are measured against parcel after parcel,
    // and an edit that moves one replaces its geometry.
    const roughBoundsCache = new WeakMap();
    function roughBounds(value) {
        if (!value || typeof value !== 'object') return null;
        if (roughBoundsCache.has(value)) return roughBoundsCache.get(value);
        const box = [Infinity, Infinity, -Infinity, -Infinity];
        const walk = function (node) {
            if (!Array.isArray(node)) {
                if (node && typeof node === 'object') {
                    if (node.geometry) walk(node.geometry);
                    else if (node.coordinates) walk(node.coordinates);
                    else if (node.faces) walk(node.faces);
                    else if (node.geometries) walk(node.geometries);
                }
                return;
            }
            if (typeof node[0] === 'number' && typeof node[1] === 'number') {
                if (node[0] < box[0]) box[0] = node[0]; if (node[0] > box[2]) box[2] = node[0];
                if (node[1] < box[1]) box[1] = node[1]; if (node[1] > box[3]) box[3] = node[1];
                return;
            }
            for (let i = 0; i < node.length; i++) walk(node[i]);
        };
        walk(value);
        const bounds = box[0] <= box[2] && box[1] <= box[3] ? box : null;
        roughBoundsCache.set(value, bounds);
        return bounds;
    }
    // Boxes that do not touch cannot intersect; an unknown box is never ruled out.
    function mayOverlap(a, b) {
        return !a || !b || !(a[2] < b[0] || b[2] < a[0] || a[3] < b[1] || b[3] < a[1]);
    }

    function computeParcelMetrics(parcelFeature, builtBuildings, proposedFeatures, opts = {}) {
        const { floorHeightM, turf, footprintOf, heightOf } = opts;
        if (!parcelFeature || !turf) return null;
        // Most listed buildings are nowhere near the parcel: skip their footprint and clip.
        const parcelBox = roughBounds(parcelFeature.geometry || parcelFeature);

        let builtVolume = 0;
        const builtList = Array.isArray(builtBuildings) ? builtBuildings : [];
        for (const bld of builtList) {
            const h = (Number.isFinite(bld.z_max) && Number.isFinite(bld.z_min)) ? (bld.z_max - bld.z_min) : 0;
            if (!(h > 0)) continue;
            if (!mayOverlap(parcelBox, roughBounds(bld.faces || bld.geometry || bld))) continue;
            const fp = footprintOf ? footprintOf(bld) : null;
            if (!fp) continue;
            let inter = null;
            try { inter = turf.intersect(fp, parcelFeature); } catch (error) {
                // A panel figure: the building is left out of it, and the failure is reported.
                clipFailureApi().reportClipFailure('intersect', error, { site: 'gain.builtVolume' }, [fp, parcelFeature]);
                inter = null;
            }
            if (!inter) continue;
            let a = 0;
            try { a = turf.area(inter); } catch (_) { a = 0; }
            builtVolume += a * h;
        }

        // Proposed buildings redrawn from existing ones (basedOnExisting) extend them: the volume
        // they already had is kept, unknown when one states no existing height.
        let proposedVolume = 0, keptVolume = 0, keptUnknown = false, proposedCount = 0, extendedCount = 0;
        const proposed = Array.isArray(proposedFeatures) ? proposedFeatures : [];
        for (const feat of proposed) {
            if (!feat || !feat.geometry) continue;
            const h = heightOf ? heightOf(feat) : 0;
            if (!(h > 0)) continue;
            if (!mayOverlap(parcelBox, roughBounds(feat.geometry))) continue;
            let inter = null;
            try { inter = turf.intersect(feat, parcelFeature); } catch (error) {
                // A panel figure: the proposed volume is left out of it, and the failure is reported.
                clipFailureApi().reportClipFailure('intersect', error, { site: 'gain.proposedVolume' }, [feat, parcelFeature]);
                inter = null;
            }
            if (!inter) continue;
            let a = 0;
            try { a = turf.area(inter); } catch (_) { a = 0; }
            proposedVolume += a * h;
            if (!(a > 0)) continue;
            proposedCount += 1;
            if (feat.properties && feat.properties.basedOnExisting === true) {
                extendedCount += 1;
                const was = Number(feat.properties.existingHeight);
                if (Number.isFinite(was) && was > 0) keptVolume += a * Math.min(h, was);
                else keptUnknown = true;
            }
        }

        const builtFloorArea = builtVolume / floorHeightM;
        const proposedFloorArea = proposedVolume / floorHeightM;
        // The land measured: what a new building here pays for (plotOf, computeValueComparison plots).
        const landM2 = turf.area(parcelFeature);
        // Ground whose every proposed building extends an existing one pays for no land.
        const acquiredLandM2 = proposedCount > 0 && extendedCount === proposedCount ? 0 : landM2;
        return { builtVolume, proposedVolume, builtFloorArea, proposedFloorArea, landM2,
            keptFloorArea: keptVolume / floorHeightM, keptUnknown, acquiredLandM2 };
    }

    // The modeled figures for the panel apply a user-selected rate per m² of gross floor area, in
    // `currency` (the city's, city-money.js), to measured built and proposed GFA. They are not parcel appraisals or cash consideration. When
    // there is no proposed massing (proposed <= 0) there is no "gain" to show — the panel shows the
    // current modeled built value instead of a negative delta. avg is
    // the per-parcel gain for the whole-proposal panel (null unless there is proposed massing, and
    // null with no parcels: a proposal on open ground has no per-parcel figure). When the totals
    // cover open ground beside the parcels, `parcelFloorAreas` ({ built, proposed } over the bound
    // parcels only) is what the per-parcel average divides, so open ground is not credited to owners.
    function computeGain({ builtFloorArea = 0, proposedFloorArea = 0, pricePerM2 = 0, currency = null, parcelCount = null, parcelFloorAreas = null } = {}) {
        if (typeof currency !== 'string' || !currency) throw new Error('computeGain needs the currency its price per m² is in.');
        const gain = (proposedFloorArea - builtFloorArea) * pricePerM2;
        const currentValue = builtFloorArea * pricePerM2;
        const hasProposed = proposedFloorArea > 0;
        const parcelGain = parcelFloorAreas
            ? ((Number(parcelFloorAreas.proposed) || 0) - (Number(parcelFloorAreas.built) || 0)) * pricePerM2
            : gain;
        const avg = (typeof parcelCount === 'number' && parcelCount > 0 && hasProposed) ? parcelGain / parcelCount : null;
        const model = {
            kind: 'modeled-floor-area-value',
            quantity: 'gross-floor-area',
            areaUnit: 'm²',
            currency,
            amountUnit: currency,
            ratePerM2GrossFloorArea: pricePerM2
        };
        return { gain, currentValue, hasProposed, avg, model };
    }

    const METRIC_KEYS = ['builtVolume', 'proposedVolume', 'builtFloorArea', 'proposedFloorArea', 'landM2', 'keptFloorArea', 'acquiredLandM2'];

    // One plot of computeValueComparison from a computeParcelMetrics result: its land, the land a new
    // building pays for, the floor area standing on it and what extensions keep of that (null: unknown).
    function plotOf(m) {
        const finiteOrNull = value => (typeof value === 'number' && Number.isFinite(value)) ? value : null;
        return { landM2: finiteOrNull(m.landM2), acquiredLandM2: finiteOrNull(m.acquiredLandM2 ?? m.landM2),
            builtFloorArea: finiteOrNull(m.builtFloorArea), keptFloorArea: m.keptUnknown === true ? null : (finiteOrNull(m.keptFloorArea) ?? 0) };
    }

    function sumMetrics(list) {
        const out = {};
        METRIC_KEYS.forEach(key => {
            out[key] = list.reduce((total, m) => total + ((typeof m[key] === 'number' && Number.isFinite(m[key])) ? m[key] : 0), 0);
        });
        out.keptUnknown = list.some(m => m.keptUnknown === true);
        return out;
    }

    // Whether a proposal's totals must be measured over its site: it binds no parcel, or its site
    // reaches onto open ground beside the bound parcels. `ground` is site-stats.js groundOf(record).
    function needsSiteMetrics(ground) {
        return !!ground && (ground.hasBinding === false || ground.partial === true);
    }

    /**
     * A whole proposal's built/proposed totals and the ground they cover.
     *   parcelMetrics: computeParcelMetrics results for its cadastral parcels/pieces (pieces minted on
     *     open ground are not parcels and belong to the site, not this list);
     *   siteMetrics: computeParcelMetrics over the site, or null;
     *   ground: site-stats.js groundOf(record), or null when unknown (then: the old parcel sum).
     * A fully bound proposal keeps the per-parcel sum. With no bound parcels or with open ground the
     * totals are the site's. parcelCount is null — never 0 — when the proposal binds no parcel.
     * Returns null when nothing could be measured for a proposal on open ground.
     */
    function summarizeProposalGround({ parcelMetrics = [], siteMetrics = null, ground = null } = {}) {
        const parcels = (Array.isArray(parcelMetrics) ? parcelMetrics : []).filter(m => m && typeof m === 'object');
        const parcelTotals = sumMetrics(parcels);
        const unbound = !!ground && ground.hasBinding === false;
        const useSite = needsSiteMetrics(ground) && !!siteMetrics;
        if (unbound && !useSite) return null;
        const totals = useSite ? sumMetrics([siteMetrics]) : parcelTotals;
        const finiteOrNull = value => (typeof value === 'number' && Number.isFinite(value)) ? value : null;
        return {
            ...totals,
            source: useSite ? 'site' : 'parcels',
            // The plots the money buys (computeValueComparison plots): each parcel, or the site as one.
            plots: (useSite ? [siteMetrics] : parcels).map(plotOf),
            parcelCount: unbound ? null : parcels.length,
            parcelFloorAreas: (useSite && parcels.length)
                ? { built: parcelTotals.builtFloorArea, proposed: parcelTotals.proposedFloorArea, plots: parcels.map(plotOf) }
                : null,
            siteM2: ground ? finiteOrNull(ground.siteM2) : null,
            openGroundM2: (ground && (unbound || ground.partial)) ? finiteOrNull(ground.openGroundM2) : null
        };
    }

    // The 3D panel's value comparison, one column per layer: Built (what stands), Planned (the
    // permitted massing) and Proposed. A column whose floor area is not a number is not available
    // and stays empty (the panel greys it). Every figure is a model at the prices the user slides,
    // in `currency`, not an appraisal:
    // - value = floor area × sale price;
    // - Planned and Proposed are new construction, counted by CityMoney.newBuildMoney (the rule of
    //   Plan stats and the MCP comparison): the all-in cost is construction (floor area × construction
    //   cost), the development charge (floor area × `devChargePerM2`), the acquisition of the plots,
    //   the sale tax inside the value, less the tax reclaimed on a tax-inclusive construction cost
    //   (`constructionTaxIncluded`); profit = value − all-in cost. Unknown while any of those is.
    //   Proposed with no massing is not available.
    // - `plots` (plotOf: each parcel, or the site) are bought once each, at the higher of their land
    //   (`landM2` × land price) and the floor area standing on them at the sale price.
    // - Proposed buildings that extend existing ones keep `keptFloorArea` of a plot's built floor area
    //   (null: unknown): construction and the development charge are on the rest, the kept floor area
    //   is not bought, and their ground pays for no land (`acquiredLandM2`). The column still shows
    //   the whole proposed value against the whole built value, so the two rows read alike.
    // `avgProfitPerParcel` divides the proposed profit over the bound parcels (`parcelFloorAreas`, with
    // their plots, when the totals also cover open ground), null without parcels or proposed massing.
    const finite = value => typeof value === 'number' && Number.isFinite(value);
    const cityMoney = () => (typeof window !== 'undefined' && window.CityMoney)
        || (typeof require === 'function' ? require('../city-money.js') : null);
    const UNAVAILABLE = Object.freeze({ available: false, floorArea: null, value: null, constructionCost: null, devCharge: null, acquisitionCost: null,
        saleTax: null, taxReclaimed: null, totalCost: null, profit: null });

    function computeValueComparison({ floorAreas = {}, plots = null, salePerM2, constructionPerM2,
        landPerM2 = null, saleTaxShare = null, constructionTaxIncluded = false, devChargePerM2 = 0, currency, parcelCount = null, parcelFloorAreas = null } = {}) {
        if (typeof currency !== 'string' || !currency) throw new Error('computeValueComparison needs the currency its prices are in.');
        // A source may have no usable rate for one metric. Missing prices keep their dependent
        // amounts unknown; they do not prevent the geometry or the other metric from being shown.
        const sale = finite(salePerM2) && salePerM2 >= 0 ? salePerM2 : null;
        const cost = finite(constructionPerM2) && constructionPerM2 >= 0 ? constructionPerM2 : null;
        const area = value => (finite(value) && value >= 0 ? value : null);
        const builtArea = area(floorAreas.built);
        const builtValue = builtArea === null || sale === null ? null : builtArea * sale;
        // extending: whether the floor area keeps what extended buildings had (Proposed) or replaces
        // every built floor area on its plots (Planned, the permitted massing).
        const money = (floorArea, plotList, extending) => {
            const list = Array.isArray(plotList) ? plotList : null;
            const keptOf = plot => (extending ? (plot.keptFloorArea === null ? null : (area(plot.keptFloorArea) ?? 0)) : 0);
            const kept = !list ? 0 : list.some(plot => keptOf(plot) === null) ? null : list.reduce((total, plot) => total + keptOf(plot), 0);
            const bought = list && list.map(plot => {
                const built = area(plot.builtFloorArea), plotKept = keptOf(plot);
                return { landAreaM2: area(extending ? plot.acquiredLandM2 : plot.landM2),
                    replacedFloorAreaM2: built === null || plotKept === null ? null : Math.max(0, built - plotKept) };
            });
            const figures = cityMoney().newBuildMoney({ floorAreaM2: floorArea, keptFloorAreaM2: kept, plots: bought,
                salePerM2: sale, constructionPerM2: cost, landPerM2, saleTaxShare, constructionTaxIncluded, devChargePerM2 });
            // Shown whole: the kept floor area's value on both sides, which leaves the profit as it is.
            const keptValue = kept === null || sale === null ? null : kept * sale;
            const plus = amount => (amount === null || keptValue === null ? null : amount + keptValue);
            return kept === 0 ? figures : { ...figures, value: plus(figures.value), acquisitionCost: plus(figures.acquisitionCost), totalCost: plus(figures.totalCost) };
        };
        const newBuild = (floorArea, available, extending) => {
            if (!available) return UNAVAILABLE;
            const { value, constructionCost, devCharge, acquisitionCost, saleTax, taxReclaimed, totalCost, profit } = money(floorArea, plots, extending);
            return { available: true, floorArea, value, constructionCost, devCharge, acquisitionCost, saleTax, taxReclaimed, totalCost, profit };
        };
        const plannedArea = area(floorAreas.planned);
        const proposedArea = area(floorAreas.proposed);
        const columns = {
            built: builtArea === null ? UNAVAILABLE
                : { ...UNAVAILABLE, available: true, floorArea: builtArea, value: builtValue },
            planned: newBuild(plannedArea, plannedArea !== null, false),
            proposed: newBuild(proposedArea, proposedArea !== null && proposedArea > 0, true)
        };
        let avgProfitPerParcel = null;
        if (columns.proposed.available && columns.proposed.profit !== null && typeof parcelCount === 'number' && parcelCount > 0) {
            const profit = parcelFloorAreas
                ? money(area(parcelFloorAreas.proposed), parcelFloorAreas.plots, true).profit
                : columns.proposed.profit;
            if (profit !== null) avgProfitPerParcel = profit / parcelCount;
        }
        return { currency, salePerM2: sale, constructionPerM2: cost, columns, avgProfitPerParcel };
    }

    const api = { dedupeCoincidentBuildings, computeParcelMetrics, computeGain, computeValueComparison, needsSiteMetrics, summarizeProposalGround, plotOf };

    if (typeof window !== 'undefined') {
        window.ProposalGain = api;
        window.dedupeCoincidentBuildings = dedupeCoincidentBuildings;
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
})(typeof window !== 'undefined' ? window : globalThis);
