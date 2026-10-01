// Synthetic plots cut from a drawn site, for detached and row houses on bare ground (no cadastral
// parcels to build on; PARCEL-OPTIONAL.md "Tools on a site"). The site is sliced into strips
// perpendicular to a chosen frontage edge, each strip intersected with the site in WGS84, so every
// plot lies exactly inside the site and the plots together cover it.
//
// Geometry runs in a local ground-metre frame on turf's sphere, affine in lng/lat: the cut lines are
// straight in both, and two neighbouring strips are built from the SAME pair of cut points,
// so adjacent plots share their cut edge exactly.
//
// The default frontage is the edge that faces a real street (frontageFromStreets: scored on the
// distance from the edge's midpoint to the street, how parallel they run, and the edge's length),
// else the longest edge.
//
// Pure: no DOM. `turf` is options.turf, the browser global, globalThis.turf or require('@turf/turf').
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__sitePlots = api;
})(typeof window !== 'undefined' ? window : globalThis, function (global) {
    'use strict';

    const DETACHED_PLOT_WIDTH_M = 20;
    const ROW_PLOT_WIDTH_M = 7;
    // A strip narrower than this share of the plot width is a sliver and joins its neighbour.
    const MIN_PLOT_WIDTH_SHARE = 0.5;
    // Strips reach this far past the site so its extreme vertices are never on a strip edge.
    const PAD_M = 1;
    const PLOT_ID_PREFIX = 'site-plot:';
    // A street faces an edge when it runs within this distance of the edge's midpoint...
    const FRONTAGE_STREET_MAX_DISTANCE_M = 30;
    // ...within 30 degrees of parallel to it...
    const FRONTAGE_MIN_PARALLEL = Math.cos(30 * Math.PI / 180);
    // ...and outside the site (a street this far inside the edge runs through the site, not past it).
    const FRONTAGE_INSIDE_TOLERANCE_M = 2;

    function T(options) {
        if (options && options.turf) return options.turf;
        if (typeof turf !== 'undefined' && turf) return turf; // eslint-disable-line no-undef
        if (global && global.turf) return global.turf;
        try { return typeof require === 'function' ? require('@turf/turf') : null; } catch (_) { return null; }
    }

    // Ground metres about an anchor on turf's own sphere (turf.area / turf.distance use R = 6378137 m),
    // so plot widths here and areas from turf agree. Affine in lng/lat.
    const EARTH_RADIUS_M = 6378137;
    const M_PER_DEG = Math.PI * EARTH_RADIUS_M / 180;
    function makeFrame(anchorLng, anchorLat) {
        const mx = M_PER_DEG * Math.cos(anchorLat * Math.PI / 180);
        return {
            toMeters: (lng, lat) => [(lng - anchorLng) * mx, (lat - anchorLat) * M_PER_DEG],
            toDegrees: (x, y) => [anchorLng + x / mx, anchorLat + y / M_PER_DEG]
        };
    }

    function geometryOf(value) {
        const g = value && value.type === 'Feature' ? value.geometry : value;
        return g && (g.type === 'Polygon' || g.type === 'MultiPolygon') ? g : null;
    }

    function polygonsOf(value) {
        const g = geometryOf(value);
        if (!g) return [];
        return g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
    }

    function ringAreaM2(ring, frame) {
        let twice = 0;
        for (let i = 0; i < ring.length - 1; i++) {
            const [x1, y1] = frame.toMeters(ring[i][0], ring[i][1]);
            const [x2, y2] = frame.toMeters(ring[i + 1][0], ring[i + 1][1]);
            twice += x1 * y2 - x2 * y1;
        }
        return twice / 2; // > 0 counter-clockwise
    }

    // The exterior ring of the largest polygon: the frontage is chosen on it.
    function frontageRing(site, t) {
        let best = null;
        let bestArea = -Infinity;
        for (const rings of polygonsOf(site)) {
            const area = t.area(t.polygon([rings[0]]));
            if (area > bestArea) { bestArea = area; best = rings[0]; }
        }
        return best;
    }

    /**
     * The edges of the site's exterior ring (largest polygon), in ring order.
     * @returns {{index: number, a: number[], b: number[], lengthM: number}[]}
     */
    function frontageEdges(site, options) {
        const t = T(options);
        if (!t) throw new Error('site-plots: turf is not available');
        const ring = frontageRing(site, t);
        if (!ring) return [];
        const edges = [];
        for (let i = 0; i < ring.length - 1; i++) {
            const a = ring[i];
            const b = ring[i + 1];
            const frame = makeFrame(a[0], a[1]);
            const [x, y] = frame.toMeters(b[0], b[1]);
            edges.push({ index: i, a: a.slice(0, 2), b: b.slice(0, 2), lengthM: Math.hypot(x, y) });
        }
        return edges;
    }

    // Index of the longest edge: the default frontage.
    function defaultFrontageEdge(site, options) {
        const edges = frontageEdges(site, options);
        if (!edges.length) return -1;
        return edges.reduce((best, edge) => (edge.lengthM > best.lengthM ? edge : best), edges[0]).index;
    }

    function streetLinesOf(street) {
        const g = street && street.type === 'Feature' ? street.geometry : street;
        if (!g) return [];
        if (g.type === 'LineString') return [g.coordinates];
        if (g.type === 'MultiLineString') return g.coordinates;
        return [];
    }

    // What a street feature is called, from the street sources the app reads (osm_road / Overpass:
    // name, highway_type or highway; the Zagreb street register: street_name).
    function streetIdentity(street) {
        const p = (street && street.properties) || {};
        const name = [p.name, p.street_name].find(value => typeof value === 'string' && value.trim());
        const highway = [p.highway_type, p.highway].find(value => typeof value === 'string' && value.trim());
        return { name: name ? name.trim() : null, highway: highway || null, id: p.osm_id ?? p.street_id ?? null };
    }

    /**
     * How well each site edge faces a street. For every edge and every street segment within
     * FRONTAGE_STREET_MAX_DISTANCE_M of the edge's midpoint, running within 30 degrees of parallel
     * and not inside the site: score = parallel × (1 − distance / max) × (edge length / longest edge).
     * An edge's score is its best segment's.
     * @param {object} site GeoJSON Polygon/MultiPolygon (or Feature).
     * @param {object[]} streets GeoJSON LineString/MultiLineString features (properties name/highway).
     * @returns {{index, lengthM, score, distanceM, parallel, street: {name, highway, id}}[]} the edges
     *   that face a street, best first.
     */
    function frontageScores(site, streets, options) {
        const opts = options || {};
        const t = T(opts);
        if (!t) throw new Error('site-plots: turf is not available');
        const maxDistanceM = Number.isFinite(opts.maxDistanceM) && opts.maxDistanceM > 0 ? opts.maxDistanceM : FRONTAGE_STREET_MAX_DISTANCE_M;
        const ring = frontageRing(site, t);
        const edges = frontageEdges(site, { turf: t });
        if (!ring || !edges.length || !Array.isArray(streets) || !streets.length) return [];
        const longestM = edges.reduce((max, edge) => Math.max(max, edge.lengthM), 0);
        const interiorSide = ringAreaM2(ring, makeFrame(ring[0][0], ring[0][1])) >= 0 ? 1 : -1;
        const scored = [];
        for (const edge of edges) {
            if (!(edge.lengthM > 0)) continue;
            const mid = [(edge.a[0] + edge.b[0]) / 2, (edge.a[1] + edge.b[1]) / 2];
            const frame = makeFrame(mid[0], mid[1]);
            const [bx, by] = frame.toMeters(edge.b[0], edge.b[1]);
            const [ax, ay] = frame.toMeters(edge.a[0], edge.a[1]);
            const ux = (bx - ax) / edge.lengthM;
            const uy = (by - ay) / edge.lengthM;
            // Into the site: left of the edge on a counter-clockwise ring, right on a clockwise one.
            const nx = -uy * interiorSide;
            const ny = ux * interiorSide;
            let best = null;
            for (const street of streets) {
                for (const line of streetLinesOf(street)) {
                    if (!Array.isArray(line)) continue;
                    for (let i = 0; i < line.length - 1; i++) {
                        const p = line[i];
                        const q = line[i + 1];
                        if (!Array.isArray(p) || !Array.isArray(q)) continue;
                        const [px, py] = frame.toMeters(p[0], p[1]);
                        const [qx, qy] = frame.toMeters(q[0], q[1]);
                        const dx = qx - px;
                        const dy = qy - py;
                        const segM = Math.hypot(dx, dy);
                        if (!(segM > 0)) continue;
                        let k = -(px * dx + py * dy) / (segM * segM);
                        k = Math.max(0, Math.min(1, k));
                        const cx = px + k * dx;
                        const cy = py + k * dy;
                        const distanceM = Math.hypot(cx, cy);
                        if (distanceM > maxDistanceM) continue;
                        if (cx * nx + cy * ny > FRONTAGE_INSIDE_TOLERANCE_M) continue;
                        const parallel = Math.abs((dx * ux + dy * uy) / segM);
                        if (parallel < FRONTAGE_MIN_PARALLEL) continue;
                        const score = parallel * (1 - distanceM / maxDistanceM) * (edge.lengthM / longestM);
                        if (!best || score > best.score) best = { score, distanceM, parallel, street: streetIdentity(street) };
                    }
                }
            }
            if (best) scored.push({ index: edge.index, lengthM: edge.lengthM, ...best });
        }
        return scored.sort((x, y) => y.score - x.score);
    }

    /**
     * The default frontage of a site: the edge that best faces a street, else the longest edge.
     * @returns {{ frontageEdgeIndex, basis: 'street', street: {name, highway, id}, distanceM, score }
     *   | { frontageEdgeIndex, basis: 'longest' }}
     */
    function frontageFromStreets(site, streets, options) {
        const best = frontageScores(site, streets, options)[0];
        if (best) {
            return {
                frontageEdgeIndex: best.index,
                basis: 'street',
                street: best.street,
                distanceM: Math.round(best.distanceM * 10) / 10,
                score: best.score
            };
        }
        return { frontageEdgeIndex: defaultFrontageEdge(site, options), basis: 'longest' };
    }

    // Axes of the cut: u along the frontage edge, v perpendicular into the site.
    function frontageAxes(site, edgeIndex, t) {
        const ring = frontageRing(site, t);
        if (!ring || edgeIndex < 0 || edgeIndex >= ring.length - 1) throw new RangeError(`site-plots: no frontage edge ${edgeIndex}`);
        const a = ring[edgeIndex];
        const b = ring[edgeIndex + 1];
        const frame = makeFrame(a[0], a[1]);
        const [ex, ey] = frame.toMeters(b[0], b[1]);
        const len = Math.hypot(ex, ey);
        if (!(len > 0)) throw new RangeError(`site-plots: frontage edge ${edgeIndex} has no length`);
        const ux = ex / len;
        const uy = ey / len;
        // Interior is left of an edge of a counter-clockwise ring, right of a clockwise one.
        const side = ringAreaM2(ring, frame) >= 0 ? 1 : -1;
        const vx = -uy * side;
        const vy = ux * side;
        return {
            frontageM: len,
            toUV: ([lng, lat]) => {
                const [x, y] = frame.toMeters(lng, lat);
                return [x * ux + y * uy, x * vx + y * vy];
            },
            toLngLat: ([u, v]) => frame.toDegrees(u * ux + v * vx, u * uy + v * vy)
        };
    }

    function uExtent(feature, axes) {
        let lo = Infinity;
        let hi = -Infinity;
        for (const rings of polygonsOf(feature)) {
            for (const p of rings[0]) {
                const [u] = axes.toUV(p);
                if (u < lo) lo = u;
                if (u > hi) hi = u;
            }
        }
        return hi - lo;
    }

    function splitParts(feature) {
        return polygonsOf(feature).map(rings => ({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: rings } }));
    }

    function intersectOrNull(t, a, b) {
        try { return t.intersect(a, b); } catch (_) { return null; }
    }

    // Join `piece` to whichever neighbouring plot it shares an edge with; false when none does.
    function mergeIntoNeighbour(t, piece, plots, preferIndex) {
        const order = plots.map((_, i) => i).sort((i, j) => Math.abs(i - preferIndex) - Math.abs(j - preferIndex));
        for (const i of order) {
            let merged = null;
            try { merged = t.union(plots[i].feature, piece); } catch (_) { merged = null; }
            if (merged && merged.geometry && merged.geometry.type === 'Polygon') {
                plots[i].feature = merged;
                return true;
            }
        }
        return false;
    }

    /**
     * Cut `site` into plots along a frontage edge.
     * @param {object} site GeoJSON Polygon/MultiPolygon (or Feature), EPSG:4326.
     * @param {{frontageEdgeIndex?: number, plotWidthM: number, minPlotWidthM?: number, depthM?: number,
     *   turf?: object}} options frontageEdgeIndex indexes frontageEdges(site) (default the longest);
     *   the strips are spread evenly over the site's whole extent along the frontage, so a plot is
     *   about plotWidthM wide; a piece narrower than minPlotWidthM (default plotWidthM / 2) joins its
     *   neighbour. depthM limits the plots to that depth from the frontage line (default: all of it;
     *   only then do the plots cover the site).
     * @returns {object[]} Feature<Polygon>[] in frontage order, properties { id, parcelId
     *   ('site-plot:<n>'), plotIndex, frontageM, areaM2, synthetic: true }.
     */
    function cutPlots(site, options) {
        const opts = options || {};
        const t = T(opts);
        if (!t) throw new Error('site-plots: turf is not available');
        const siteGeometry = geometryOf(site);
        if (!siteGeometry) throw new TypeError('site must be a GeoJSON Polygon or MultiPolygon');
        const plotWidthM = Number(opts.plotWidthM);
        if (!(plotWidthM > 0)) throw new RangeError('plotWidthM must be a positive number of metres');
        const minPlotWidthM = Number.isFinite(opts.minPlotWidthM) ? opts.minPlotWidthM : plotWidthM * MIN_PLOT_WIDTH_SHARE;
        const depthM = Number.isFinite(opts.depthM) && opts.depthM > 0 ? opts.depthM : null;
        const siteFeature = { type: 'Feature', properties: {}, geometry: siteGeometry };
        const edgeIndex = Number.isInteger(opts.frontageEdgeIndex) ? opts.frontageEdgeIndex : defaultFrontageEdge(siteGeometry, { turf: t });
        const axes = frontageAxes(siteGeometry, edgeIndex, t);

        let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
        for (const rings of polygonsOf(siteGeometry)) {
            for (const p of rings[0]) {
                const [u, v] = axes.toUV(p);
                uMin = Math.min(uMin, u); uMax = Math.max(uMax, u);
                vMin = Math.min(vMin, v); vMax = Math.max(vMax, v);
            }
        }
        const span = uMax - uMin;
        const count = Math.max(1, Math.round(span / plotWidthM));
        const width = span / count;
        // A band [vFromM, vToM] across the frontage frame (subdivision.js cuts the plots on either
        // side of a street with it); the cut positions along the frontage do not depend on it, so
        // plots in two bands line up.
        const vFrom = Number.isFinite(opts.vFromM) ? opts.vFromM : null;
        const vTo = Number.isFinite(opts.vToM) ? opts.vToM : null;
        const vLow = vFrom !== null ? Math.max(vFrom, vMin - PAD_M) : vMin - PAD_M;
        let vHigh = depthM ? Math.min(depthM, vMax + PAD_M) : vMax + PAD_M;
        if (vTo !== null) vHigh = Math.min(vHigh, vTo);
        if (!(vHigh > vLow)) return [];
        // One pair of cut points per boundary, shared by the strips on both sides of it.
        const cuts = [];
        for (let i = 0; i <= count; i++) {
            const u = i === 0 ? uMin - PAD_M : i === count ? uMax + PAD_M : uMin + i * width;
            cuts.push([axes.toLngLat([u, vLow]), axes.toLngLat([u, vHigh])]);
        }

        const plots = [];
        const slivers = [];
        for (let i = 0; i < count; i++) {
            const [a0, a1] = cuts[i];
            const [b0, b1] = cuts[i + 1];
            const strip = t.polygon([[a0, b0, b1, a1, a0]]);
            const piece = intersectOrNull(t, strip, siteFeature);
            if (!piece || !piece.geometry) continue;
            for (const part of splitParts(piece)) {
                if (!(t.area(part) > 0)) continue;
                const entry = { feature: part, strip: i };
                if (uExtent(part, axes) < minPlotWidthM) slivers.push(entry); else plots.push(entry);
            }
        }
        if (!plots.length && slivers.length) plots.push(slivers.shift());
        for (const sliver of slivers) {
            const near = plots.reduce((best, p, idx) => (Math.abs(p.strip - sliver.strip) < Math.abs(plots[best].strip - sliver.strip) ? idx : best), 0);
            if (!mergeIntoNeighbour(t, sliver.feature, plots, near)) plots.push(sliver);
        }

        plots.sort((p, q) => p.strip - q.strip);
        return plots.map((plot, plotIndex) => {
            const id = `${PLOT_ID_PREFIX}${plotIndex}`;
            return {
                type: 'Feature',
                properties: {
                    id,
                    parcelId: id,
                    plotIndex,
                    frontageM: Math.round(uExtent(plot.feature, axes) * 100) / 100,
                    areaM2: Math.round(t.area(plot.feature) * 100) / 100,
                    synthetic: true
                },
                geometry: plot.feature.geometry
            };
        });
    }

    // The site's extent in the frontage frame of edge `frontageEdgeIndex`: u along the frontage, v
    // into the site (metres, v = 0 on the frontage line).
    function frontageExtent(site, options) {
        const opts = options || {};
        const t = T(opts);
        if (!t) throw new Error('site-plots: turf is not available');
        const siteGeometry = geometryOf(site);
        if (!siteGeometry) throw new TypeError('site must be a GeoJSON Polygon or MultiPolygon');
        const edgeIndex = Number.isInteger(opts.frontageEdgeIndex) ? opts.frontageEdgeIndex : defaultFrontageEdge(siteGeometry, { turf: t });
        const axes = frontageAxes(siteGeometry, edgeIndex, t);
        let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
        for (const rings of polygonsOf(siteGeometry)) {
            for (const p of rings[0]) {
                const [u, v] = axes.toUV(p);
                uMin = Math.min(uMin, u); uMax = Math.max(uMax, u);
                vMin = Math.min(vMin, v); vMax = Math.max(vMax, v);
            }
        }
        return { frontageEdgeIndex: edgeIndex, uMin, uMax, vMin, vMax };
    }

    /**
     * The part of `site` between v = vFromM and v = vToM in the frontage frame (a band parallel to
     * the frontage edge), or null when the band misses the site. Its long edges are built from the
     * same cut points cutPlots uses, so plots cut in the neighbouring bands meet it exactly.
     */
    function bandOf(site, options) {
        const opts = options || {};
        const t = T(opts);
        if (!t) throw new Error('site-plots: turf is not available');
        const siteGeometry = geometryOf(site);
        if (!siteGeometry) throw new TypeError('site must be a GeoJSON Polygon or MultiPolygon');
        const extent = frontageExtent(siteGeometry, { ...opts, turf: t });
        const axes = frontageAxes(siteGeometry, extent.frontageEdgeIndex, t);
        const vLow = Number.isFinite(opts.vFromM) ? opts.vFromM : extent.vMin - PAD_M;
        const vHigh = Number.isFinite(opts.vToM) ? opts.vToM : extent.vMax + PAD_M;
        if (!(vHigh > vLow)) return null;
        const u0 = extent.uMin - PAD_M;
        const u1 = extent.uMax + PAD_M;
        const band = t.polygon([[
            axes.toLngLat([u0, vLow]), axes.toLngLat([u1, vLow]),
            axes.toLngLat([u1, vHigh]), axes.toLngLat([u0, vHigh]), axes.toLngLat([u0, vLow])
        ]]);
        const piece = intersectOrNull(t, band, { type: 'Feature', properties: {}, geometry: siteGeometry });
        return piece && piece.geometry && t.area(piece) > 0 ? piece.geometry : null;
    }

    return {
        frontageExtent,
        bandOf,
        DETACHED_PLOT_WIDTH_M,
        ROW_PLOT_WIDTH_M,
        MIN_PLOT_WIDTH_SHARE,
        PLOT_ID_PREFIX,
        FRONTAGE_STREET_MAX_DISTANCE_M,
        frontageEdges,
        defaultFrontageEdge,
        frontageScores,
        frontageFromStreets,
        cutPlots
    };
});
