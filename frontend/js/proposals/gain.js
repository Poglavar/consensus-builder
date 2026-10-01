// The € value-gain math for the 3D view: built vs proposed floor area per parcel, and the gain a
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
    function dedupeCoincidentBuildings(buildings) {
        if (!Array.isArray(buildings) || buildings.length < 2) return buildings || [];
        const CELL_M = 5, MERGE_DIST_M = 2;
        const grid = new Map();
        const keep = [];
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
            const x = lng * 111320 * Math.cos(lat * Math.PI / 180);
            const y = lat * 110540;
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
    function computeParcelMetrics(parcelFeature, builtBuildings, proposedFeatures, opts = {}) {
        const { floorHeightM, turf, footprintOf, heightOf } = opts;
        if (!parcelFeature || !turf) return null;

        let builtVolume = 0;
        const builtList = Array.isArray(builtBuildings) ? builtBuildings : [];
        for (const bld of builtList) {
            const h = (Number.isFinite(bld.z_max) && Number.isFinite(bld.z_min)) ? (bld.z_max - bld.z_min) : 0;
            if (!(h > 0)) continue;
            const fp = footprintOf ? footprintOf(bld) : null;
            if (!fp) continue;
            let inter = null;
            try { inter = turf.intersect(fp, parcelFeature); } catch (_) { inter = null; }
            if (!inter) continue;
            let a = 0;
            try { a = turf.area(inter); } catch (_) { a = 0; }
            builtVolume += a * h;
        }

        let proposedVolume = 0;
        const proposed = Array.isArray(proposedFeatures) ? proposedFeatures : [];
        for (const feat of proposed) {
            if (!feat || !feat.geometry) continue;
            const h = heightOf ? heightOf(feat) : 0;
            if (!(h > 0)) continue;
            let inter = null;
            try { inter = turf.intersect(feat, parcelFeature); } catch (_) { inter = null; }
            if (!inter) continue;
            let a = 0;
            try { a = turf.area(inter); } catch (_) { a = 0; }
            proposedVolume += a * h;
        }

        const builtFloorArea = builtVolume / floorHeightM;
        const proposedFloorArea = proposedVolume / floorHeightM;
        return { builtVolume, proposedVolume, builtFloorArea, proposedFloorArea };
    }

    // The € figures for the panel. When there is no proposed massing (proposed <= 0) there is no
    // "gain" to show — the panel shows the current built value instead of a negative delta. avg is
    // the per-parcel gain for the whole-proposal panel (null unless there is proposed massing, and
    // null with no parcels: a proposal on open ground has no per-parcel figure). When the totals
    // cover open ground beside the parcels, `parcelFloorAreas` ({ built, proposed } over the bound
    // parcels only) is what the per-parcel average divides, so open ground is not credited to owners.
    function computeGain({ builtFloorArea = 0, proposedFloorArea = 0, priceEurPerM2 = 0, parcelCount = null, parcelFloorAreas = null } = {}) {
        const gain = (proposedFloorArea - builtFloorArea) * priceEurPerM2;
        const currentValue = builtFloorArea * priceEurPerM2;
        const hasProposed = proposedFloorArea > 0;
        const parcelGain = parcelFloorAreas
            ? ((Number(parcelFloorAreas.proposed) || 0) - (Number(parcelFloorAreas.built) || 0)) * priceEurPerM2
            : gain;
        const avg = (typeof parcelCount === 'number' && parcelCount > 0 && hasProposed) ? parcelGain / parcelCount : null;
        return { gain, currentValue, hasProposed, avg };
    }

    const METRIC_KEYS = ['builtVolume', 'proposedVolume', 'builtFloorArea', 'proposedFloorArea'];

    function sumMetrics(list) {
        const out = {};
        METRIC_KEYS.forEach(key => {
            out[key] = list.reduce((total, m) => total + ((typeof m[key] === 'number' && Number.isFinite(m[key])) ? m[key] : 0), 0);
        });
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
            parcelCount: unbound ? null : parcels.length,
            parcelFloorAreas: (useSite && parcels.length)
                ? { built: parcelTotals.builtFloorArea, proposed: parcelTotals.proposedFloorArea }
                : null,
            siteM2: ground ? finiteOrNull(ground.siteM2) : null,
            openGroundM2: (ground && (unbound || ground.partial)) ? finiteOrNull(ground.openGroundM2) : null
        };
    }

    const api = { dedupeCoincidentBuildings, computeParcelMetrics, computeGain, needsSiteMetrics, summarizeProposalGround };

    if (typeof window !== 'undefined') {
        window.ProposalGain = api;
        window.dedupeCoincidentBuildings = dedupeCoincidentBuildings;
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
})(typeof window !== 'undefined' ? window : globalThis);
