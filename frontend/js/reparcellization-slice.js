// Sweep-line subdivision of a super-parcel into per-owner slices sized by each owner's share.
// Pure turf geometry — no DOM, no Leaflet — so it is unit-tested headless. The interactive editor
// (reparcellization.js) supplies the parcel, the owner list and the sweep bearing.
//
// It lives in its own module because sliceWithSweepLine had a live land-allocation bug: a 0%-share
// owner had no cut generated for it, yet slices were mapped to owners BY INDEX — and
// slicePolygonByXCoordinates additionally dropped empty slices from its result, shifting every
// later owner. Together, owners [A 50%, B 0%, C 50%] handed B the entire right half and C nothing.
// The fix keeps slice i aligned to owner i by construction: a cut is generated for every owner
// (a 0% owner's cut coincides with its predecessor → a zero-width, empty slice), and the slicer
// returns a POSITIONALLY-aligned array (empty slots kept as null) so the index mapping is honest.

(function (global) {
    'use strict';

    function resolveTurf(deps) {
        return (deps && deps.turf) || global.turf;
    }
    function resolveArea(deps, turf) {
        if (deps && typeof deps.computeFeatureArea === 'function') return deps.computeFeatureArea;
        if (typeof global.computeFeatureArea === 'function') return global.computeFeatureArea;
        return (feature) => {
            if (!turf || !feature) return 0;
            try { return turf.area(feature); } catch (_) { return 0; }
        };
    }

    function getPolygonCoordinates(feature) {
        if (!feature?.geometry?.coordinates) return null;
        if (feature.geometry.type === 'Polygon') {
            return feature.geometry.coordinates[0];
        }
        if (feature.geometry.type === 'MultiPolygon') {
            return feature.geometry.coordinates[0][0];
        }
        return null;
    }

    function buildSlicePolygon(turf, minLng, maxLng, minLat, maxLat, cutLng) {
        if (!isFinite(cutLng) || cutLng <= minLng) return null;
        const epsilon = 1e-6;
        const constrainedCut = Math.min(Math.max(cutLng, minLng + epsilon), maxLng - epsilon);
        const latMargin = Math.max((maxLat - minLat) * 0.05, 0.0005);
        const coords = [
            [minLng, minLat - latMargin],
            [constrainedCut, minLat - latMargin],
            [constrainedCut, maxLat + latMargin],
            [minLng, maxLat + latMargin],
            [minLng, minLat - latMargin]
        ];
        return turf.polygon([coords]);
    }

    // Slice `feature` into vertical bands at the given X coordinates. Returns an array of length
    // cutXValues.length + 1 that is POSITIONALLY aligned to the bands (empty bands are null, never
    // dropped) so callers can map band i to their item i. cutXValues must be non-decreasing (as the
    // sweep produces them); a repeated value yields a zero-width, null band.
    function slicePolygonByXCoordinates(turf, computeFeatureArea, feature, cutXValues) {
        if (!feature || !feature.geometry) return [];
        if (!Array.isArray(cutXValues) || cutXValues.length === 0) {
            return [feature];
        }

        const ringCoords = getPolygonCoordinates(feature);
        if (!ringCoords || ringCoords.length < 4) return [feature];

        const bbox = turf.bbox(feature);
        const minX = bbox[0];
        const maxX = bbox[2];
        const minY = bbox[1];
        const maxY = bbox[3];
        const padY = Math.max((maxY - minY) * 0.1, 0.001);

        // Keep EVERY cut, clamped into the bbox, so the result stays positionally aligned to the
        // caller's items. (The old code filtered out-of-range cuts, which shifted the mapping and
        // was half of the 0%-owner land bug.) Input is already non-decreasing; sort is defensive.
        const cuts = cutXValues
            .slice()
            .sort((a, b) => a - b)
            .map(x => Math.min(Math.max(x, minX), maxX));

        // Pre-compute EXACT intersection points for each cut X on the ORIGINAL polygon
        const ring = ringCoords.slice(0, -1);
        const cutPointsMap = new Map();

        for (const cutX of cuts) {
            const points = [];
            for (let i = 0; i < ring.length; i++) {
                const p1 = ring[i];
                const p2 = ring[(i + 1) % ring.length];
                const x1 = p1[0], y1 = p1[1];
                const x2 = p2[0], y2 = p2[1];

                if ((x1 < cutX && cutX < x2) || (x2 < cutX && cutX < x1)) {
                    const t = (cutX - x1) / (x2 - x1);
                    const y = y1 + t * (y2 - y1);
                    points.push({ x: cutX, y: y });
                }
            }
            points.sort((a, b) => a.y - b.y);
            cutPointsMap.set(cutX, points);
        }

        const boundaries = [minX, ...cuts, maxX];

        const sliceSlots = new Array(boundaries.length - 1).fill(null);
        for (let s = 0; s < boundaries.length - 1; s++) {
            const leftX = boundaries[s];
            const rightX = boundaries[s + 1];
            if (!(rightX > leftX)) continue; // zero-width band → null slot (e.g. a 0%-share owner)

            const band = turf.polygon([[
                [leftX, minY - padY],
                [rightX, minY - padY],
                [rightX, maxY + padY],
                [leftX, maxY + padY],
                [leftX, minY - padY]
            ]]);

            try {
                const sliced = turf.intersect(feature, band);
                if (sliced && computeFeatureArea(sliced) > 0) {
                    sliceSlots[s] = { feature: sliced, leftX, rightX, index: s };
                }
            } catch (err) {
                console.warn('slicePolygonByXCoordinates: intersect failed', err);
            }
        }

        // POST-PROCESS: adjacent slices must share the SAME vertex segmentation along the cut line
        // so the floodfill neighbour detection (edge match after HTRS96 + 1 cm quantization) sees
        // them as neighbours, not just "close".
        const xTolerance = Math.max((maxX - minX) * 1e-4, 1e-7);

        function closeRingInPlace(coords) {
            if (!Array.isArray(coords) || coords.length < 3) return;
            const first = coords[0];
            const last = coords[coords.length - 1];
            if (!Array.isArray(first) || !Array.isArray(last)) return;
            if (first[0] === last[0] && first[1] === last[1]) return;
            coords.push([first[0], first[1]]);
        }

        function findBestCutRun(ringCoordsArg, cutX) {
            const n = ringCoordsArg.length - 1;
            if (n < 3) return null;
            const onCut = (pt) => Array.isArray(pt) && Math.abs(pt[0] - cutX) < xTolerance;
            const runs = [];
            let start = null;
            for (let i = 0; i < n; i++) {
                if (onCut(ringCoordsArg[i])) {
                    if (start === null) start = i;
                } else if (start !== null) {
                    runs.push({ start, end: i - 1 });
                    start = null;
                }
            }
            if (start !== null) {
                runs.push({ start, end: n - 1 });
            }
            if (runs.length === 0) return null;
            let best = null;
            for (const r of runs) {
                let yMin = Infinity;
                let yMax = -Infinity;
                for (let i = r.start; i <= r.end; i++) {
                    const y = ringCoordsArg[i][1];
                    if (y < yMin) yMin = y;
                    if (y > yMax) yMax = y;
                }
                const span = yMax - yMin;
                const len = r.end - r.start + 1;
                const score = span * 1e6 + len;
                if (!best || score > best.score) {
                    best = { ...r, yMin, yMax, len, score };
                }
            }
            if (!best || best.len < 2) return null;
            const yStart = ringCoordsArg[best.start][1];
            const yEnd = ringCoordsArg[best.end][1];
            best.direction = yEnd >= yStart ? 'asc' : 'desc';
            return best;
        }

        function replaceRunWithCanonical(ringCoordsArg, run, cutX, canonicalYs, direction) {
            const points = canonicalYs.map(y => [cutX, y]);
            if (direction === 'desc') points.reverse();
            if (points.length < 2) return;
            const deleteCount = (run.end - run.start + 1);
            ringCoordsArg.splice(run.start, deleteCount, ...points);
            if (run.start === 0 && ringCoordsArg.length >= 2) {
                ringCoordsArg.pop();
            }
            closeRingInPlace(ringCoordsArg);
        }

        function dedupeSortedYs(ys) {
            const out = [];
            const eps = 1e-12;
            for (const y of ys) {
                if (!Number.isFinite(y)) continue;
                if (out.length === 0 || Math.abs(out[out.length - 1] - y) > eps) out.push(y);
            }
            return out;
        }

        for (let c = 0; c < cuts.length; c++) {
            const cutX = cuts[c];
            const leftSlice = sliceSlots[c];
            const rightSlice = sliceSlots[c + 1];
            if (!leftSlice || !rightSlice) continue;

            const leftRing = getPolygonCoordinates(leftSlice.feature);
            const rightRing = getPolygonCoordinates(rightSlice.feature);
            if (!leftRing || !rightRing) continue;

            closeRingInPlace(leftRing);
            closeRingInPlace(rightRing);

            const leftRun = findBestCutRun(leftRing, cutX);
            const rightRun = findBestCutRun(rightRing, cutX);
            if (!leftRun || !rightRun) continue;

            const yMin = Math.max(leftRun.yMin, rightRun.yMin);
            const yMax = Math.min(leftRun.yMax, rightRun.yMax);
            if (!(yMax > yMin)) continue;

            const ys = [];
            for (let i = leftRun.start; i <= leftRun.end; i++) {
                const y = leftRing[i][1];
                if (y >= yMin - 1e-12 && y <= yMax + 1e-12) ys.push(y);
            }
            for (let i = rightRun.start; i <= rightRun.end; i++) {
                const y = rightRing[i][1];
                if (y >= yMin - 1e-12 && y <= yMax + 1e-12) ys.push(y);
            }
            const precomputed = cutPointsMap.get(cutX) || [];
            for (const pt of precomputed) {
                if (!pt) continue;
                const y = pt.y;
                if (y >= yMin - 1e-12 && y <= yMax + 1e-12) ys.push(y);
            }
            ys.sort((a, b) => a - b);
            const canonicalYs = dedupeSortedYs(ys);
            if (canonicalYs.length < 2) continue;

            replaceRunWithCanonical(leftRing, leftRun, cutX, canonicalYs, leftRun.direction);
            replaceRunWithCanonical(rightRing, rightRun, cutX, canonicalYs, rightRun.direction);
        }

        // Positionally aligned: slot s is band s (null if empty). Callers rely on this.
        return sliceSlots.map(s => (s ? s.feature : null));
    }

    // Subdivide `superParcel` into per-owner slices. owners: [{ ownerKey, displayName, color,
    // percent }] where percent is a fraction in [0,1]. Returns [{ ownerKey, displayName, percent,
    // color, geometry, owners, source }] — one entry per owner that receives non-empty land.
    function sliceWithSweepLine(superParcel, owners, deps = {}) {
        const turf = resolveTurf(deps);
        if (!turf) {
            console.warn('turf is required for reparcellization.');
            return [];
        }
        const computeFeatureArea = resolveArea(deps, turf);
        if (!Array.isArray(owners) || !owners.length) return [];

        const baseFeature = JSON.parse(JSON.stringify(superParcel));
        const totalArea = computeFeatureArea(baseFeature);
        if (!totalArea) return [];

        const bbox = turf.bbox(baseFeature);
        const minX = bbox[0];
        const maxX = bbox[2];

        // One cut per owner boundary [0 .. n-2]. A 0%-share owner advances the cumulative area by
        // nothing, so its cut coincides with its predecessor's — a zero-width, empty slice — which
        // keeps slice i aligned to owner i. (Skipping the cut, as the old code did, is what handed
        // a later owner's land to a 0% owner.)
        const cutXValues = [];
        let cumulativePercent = 0;

        for (let i = 0; i < owners.length - 1; i++) {
            const owner = owners[i];
            cumulativePercent += (owner.percent || 0);
            const targetCumulativeArea = totalArea * cumulativePercent;

            let lower = minX;
            let upper = maxX;
            let bestCut = (lower + upper) / 2;
            let bestDiff = Infinity;

            for (let iter = 0; iter < 30; iter++) {
                const cut = (lower + upper) / 2;
                const sliceRect = buildSlicePolygon(turf, minX, maxX, bbox[1], bbox[3], cut);
                if (!sliceRect) break;

                let sliceFeature = null;
                try {
                    sliceFeature = turf.intersect(baseFeature, sliceRect);
                } catch (_) { /* ignore */ }

                const area = sliceFeature ? computeFeatureArea(sliceFeature) : 0;
                const diff = Math.abs(area - targetCumulativeArea);

                if (diff < bestDiff) {
                    bestDiff = diff;
                    bestCut = cut;
                }

                if (area < targetCumulativeArea) {
                    lower = cut;
                } else {
                    upper = cut;
                }

                if (targetCumulativeArea > 0 && Math.abs(diff / targetCumulativeArea) <= 0.005) {
                    break;
                }
            }

            cutXValues.push(bestCut);
        }

        // Positionally aligned: slicedFeatures[i] is owner i's band (null if empty).
        const slicedFeatures = slicePolygonByXCoordinates(turf, computeFeatureArea, baseFeature, cutXValues);

        const slices = [];
        for (let i = 0; i < owners.length && i < slicedFeatures.length; i++) {
            const owner = owners[i];
            const sliceFeature = slicedFeatures[i];
            if (sliceFeature && sliceFeature.geometry) {
                slices.push({
                    ownerKey: owner.ownerKey,
                    displayName: owner.displayName,
                    percent: owner.percent,
                    color: owner.color,
                    geometry: sliceFeature.geometry,
                    owners: [{ ownerKey: owner.ownerKey, displayName: owner.displayName, color: owner.color, share: 1 }],
                    source: 'sweep'
                });
            }
        }

        return slices.filter(slice => slice.geometry);
    }

    const api = { sliceWithSweepLine, slicePolygonByXCoordinates, buildSlicePolygon, getPolygonCoordinates };

    if (typeof window !== 'undefined') {
        window.ReparcellizationSlice = api;
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
})(typeof window !== 'undefined' ? window : globalThis);
