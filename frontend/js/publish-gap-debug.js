// Purpose: answer "the publish gate says the cadastre covers only 90% of this proposal — WHERE is
// the other 10%?" from the console, in one call, and draw it on the map:
//
//     await whereIsThePublishGap('p-rtkui0dh52')
//
// The gate measures the authored footprint against the parcels the browser has loaded, and reports
// one number. A number cannot be argued with: it does not say whether the missing ground is a
// genuine hole in the cadastre, a strip the fetch never delivered, or a sliver of rounding along
// one edge. This subtracts the parcels from the footprint and hands back what is left — each piece
// with its area and its centre — then paints them so the answer is on screen, not in a percentage.

(function attachPublishGapDebug(global) {
    'use strict';

    // Pure: footprint minus the parcels under it. ops is injected so node can test it.
    // Returns { footprintM2, coveredM2, coverage, gaps: [{ feature, areaM2 }] }, largest gap first.
    function computeCoverageGap(footprint, parcelFeatures, ops) {
        const empty = { footprintM2: 0, coveredM2: 0, coverage: 0, gaps: [] };
        if (!footprint || !ops || typeof ops.area !== 'function' || typeof ops.difference !== 'function') return empty;
        const footprintM2 = ops.area(footprint) || 0;
        if (!(footprintM2 > 0)) return empty;

        let remainder = footprint;
        let coveredM2 = 0;
        (Array.isArray(parcelFeatures) ? parcelFeatures : []).forEach(parcel => {
            if (!parcel || !remainder) return;
            const shared = (typeof ops.intersectionArea === 'function') ? (ops.intersectionArea(footprint, parcel) || 0) : 0;
            if (shared <= 0) return;                 // not under the footprint at all
            coveredM2 += shared;
            // Subtract as we go: what survives every parcel is ground no parcel covers.
            try { remainder = ops.difference(remainder, parcel); } catch (_) { /* keep what we have */ }
        });

        const gaps = [];
        if (remainder) {
            const parts = (typeof ops.explode === 'function') ? ops.explode(remainder) : [remainder];
            parts.forEach(part => {
                const areaM2 = ops.area(part) || 0;
                // Under a square metre it is a rounding sliver along a shared edge, not a hole.
                if (areaM2 >= 1) gaps.push({ feature: part, areaM2 });
            });
            gaps.sort((a, b) => b.areaM2 - a.areaM2);
        }
        return {
            footprintM2,
            coveredM2: Math.min(coveredM2, footprintM2),
            coverage: Math.min(1, coveredM2 / footprintM2),
            gaps
        };
    }

    const api = { computeCoverageGap };
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (typeof window === 'undefined') return;       // node test: only the pure part
    global.__publishGap = api;

    let gapLayer = null;

    function clearGapLayer() {
        try { if (gapLayer && typeof map !== 'undefined' && map) map.removeLayer(gapLayer); } catch (_) { }
        gapLayer = null;
    }

    function turfOps(t) {
        return {
            area: shape => { try { return t.area(shape) || 0; } catch (_) { return 0; } },
            difference: (a, b) => { try { return t.difference(a, b); } catch (_) { return a; } },
            intersectionArea: (a, b) => {
                try { const hit = t.intersect(a, b); return hit ? (t.area(hit) || 0) : 0; } catch (_) { return 0; }
            },
            // A MultiPolygon remainder is several separate holes; report them one by one.
            explode: shape => {
                const geom = shape && shape.type === 'Feature' ? shape.geometry : shape;
                if (!geom) return [];
                if (geom.type !== 'MultiPolygon') return [shape];
                return geom.coordinates.map(rings => t.polygon(rings));
            }
        };
    }

    global.whereIsThePublishGap = async function whereIsThePublishGap(proposalId) {
        const planOrder = global.__planOrder;
        const ancestry = global.__cadastreAncestry;
        const t = global.turf;
        const out = { proposalId: String(proposalId || '') };
        if (!planOrder || !ancestry || !t) {
            out.verdict = 'The cadastral resolver is not loaded in this page.';
            return out;
        }
        const record = (typeof getProposalByIdOrHash === 'function')
            ? getProposalByIdOrHash(proposalId)
            : (global.proposalStorage && global.proposalStorage.getProposal
                ? global.proposalStorage.getProposal(proposalId) : null);
        if (!record) {
            out.verdict = 'No such proposal in local storage.';
            return out;
        }

        const footprint = planOrder.footprintOf(record);
        if (!footprint) {
            out.verdict = 'This proposal has no authored footprint to measure.';
            return out;
        }

        // Ask for the ground first, exactly as publish does — otherwise this reports the viewport.
        if (typeof fetchParcelsUnderGeometry === 'function') {
            try { await fetchParcelsUnderGeometry(footprint); out.groundFetched = true; }
            catch (error) { out.groundFetched = false; out.groundError = error && error.message; }
        }

        const parcels = ancestry.loadedCadastreParcels();
        const report = computeCoverageGap(footprint, parcels.map(entry => entry.feature), turfOps(t));
        out.loadedCadastreParcels = parcels.length;
        out.footprintM2 = Math.round(report.footprintM2);
        out.coveredM2 = Math.round(report.coveredM2);
        out.coveragePercent = Math.round(report.coverage * 1000) / 10;
        out.gaps = report.gaps.map(gap => {
            let centre = null;
            try {
                const c = t.centroid(gap.feature).geometry.coordinates;
                centre = { lat: Math.round(c[1] * 1e6) / 1e6, lng: Math.round(c[0] * 1e6) / 1e6 };
            } catch (_) { }
            return { areaM2: Math.round(gap.areaM2), centre };
        });

        clearGapLayer();
        if (report.gaps.length && typeof L !== 'undefined' && typeof map !== 'undefined' && map) {
            gapLayer = L.geoJSON(
                { type: 'FeatureCollection', features: report.gaps.map(gap => gap.feature) },
                { style: { color: '#b3261e', weight: 2, fillColor: '#b3261e', fillOpacity: 0.45 } }
            ).addTo(map);
            report.gaps.forEach((gap, index) => { /* label each hole with its size */
                try {
                    const c = t.centroid(gap.feature).geometry.coordinates;
                    L.marker([c[1], c[0]], { opacity: 0 })
                        .bindTooltip(`gap ${index + 1}: ${Math.round(gap.areaM2)} m²`, { permanent: true, direction: 'top' })
                        .addTo(gapLayer);
                } catch (_) { }
            });
            try { map.fitBounds(gapLayer.getBounds().pad(0.4), { animate: false }); } catch (_) { }
            out.verdict = `${report.gaps.length} hole(s) painted in red — ${out.coveragePercent}% covered. `
                + 'Call clearPublishGap() to remove them.';
        } else {
            out.verdict = report.gaps.length
                ? 'Holes found but the map is not available to draw them.'
                : `No hole worth a square metre — the cadastre covers ${out.coveragePercent}% of this footprint.`;
        }
        console.info('[publish-gap]', out);
        return out;
    };

    global.clearPublishGap = clearGapLayer;
}(typeof window !== 'undefined' ? window : globalThis));
