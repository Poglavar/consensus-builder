// Demolitions derived from design geometry (docs/source-loading-plan.md, F4): which existing buildings
// the applied designs raze, cut or pass under, from the designs' land take against whichever buildings
// are shown. Nothing here is stored: a source switch or a stand-in cell derives again. The browser
// (demolition-index.js) and MCP compare (backend/agents/mcp-compare.js) read the same rule.
// Pure: turf is passed in; the corridor footprint and profile helpers resolve from globals or require().
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.DemolitionDerive = api;
})(typeof window !== 'undefined' ? window : globalThis, function (global) {
    'use strict';

    // A taker clipping less than this from a building leaves it alone; a building left with less than
    // max(10 m², 15 % of its footprint) is razed whole (docs/vocabulary.md, clearance).
    const MIN_TAKEN_M2 = 2;
    const MIN_REMAINDER_M2 = 10;
    const MIN_REMAINDER_FRACTION = 0.15;

    const fromGlobalOrRequire = (name, path, key = name) => (typeof global[name] === 'function' ? global[name] : require(path)[key]);
    const feature = geometry => ({ type: 'Feature', properties: {}, geometry });

    function bboxOf(geometry) {
        let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
        const walk = node => {
            if (!Array.isArray(node)) return;
            if (typeof node[0] === 'number') {
                if (node[0] < w) w = node[0]; if (node[0] > e) e = node[0];
                if (node[1] < s) s = node[1]; if (node[1] > n) n = node[1];
                return;
            }
            node.forEach(walk);
        };
        walk(geometry?.coordinates);
        return Number.isFinite(w) ? [w, s, e, n] : null;
    }
    const overlaps = (a, b) => !!a && !!b && a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];

    // A region as polygon parts with their boxes, so a long road meets a building only where it is.
    function partsOf(geometry) {
        if (!geometry) return [];
        if (geometry.type === 'Polygon') return [{ geometry, bbox: bboxOf(geometry) }];
        if (geometry.type === 'MultiPolygon') {
            return geometry.coordinates.map(coordinates => {
                const part = { type: 'Polygon', coordinates };
                return { geometry: part, bbox: bboxOf(part) };
            });
        }
        if (geometry.type === 'Feature') return partsOf(geometry.geometry);
        return [];
    }

    // The ground under a building tunnel: the corridor's width along the tunnel span (from → to) of
    // its segment, built in the definition's own metric frame (corridor-footprint.js).
    function tunnelRegionsOf(definition) {
        const tunnels = Array.isArray(definition?.tunnels) ? definition.tunnels.filter(record => record?.kind === 'building' && record.from && record.to) : [];
        if (!tunnels.length) return [];
        const footprint = typeof global.__corridorFootprint === 'object' ? global.__corridorFootprint : require('./corridor-footprint.js');
        const entries = fromGlobalOrRequire('corridorSegmentEntries', './corridor-profile.js')(definition);
        const frame = footprint.frameForDefinition(definition);
        const lngLat = point => Array.isArray(point) ? point : [Number(point.lng), Number(point.lat)];
        return tunnels.map(record => {
            const entry = entries.find(item => item.segmentId !== null && String(item.segmentId) === String(record.segmentId));
            const width = Number(entry?.width) || Math.max(...entries.map(item => Number(item.width) || 0));
            if (!(width > 0)) return null;
            const ring = footprint.rectangle(frame.toMetric(lngLat(record.from)), frame.toMetric(lngLat(record.to)), width)
                .map(xy => frame.toLngLat(xy));
            return { type: 'Polygon', coordinates: [ring] };
        }).filter(Boolean);
    }

    function area(turf, value) { return value ? (Number(turf.area(value)) || 0) : 0; }

    // Turf's clipping recurses deeply on near-degenerate rings; snapping and dropping redundant
    // vertices first keeps union/difference finite (Zagreb building 340664).
    function clean(turf, value) {
        let result = value;
        try { if (typeof turf.truncate === 'function') result = turf.truncate(result, { precision: 7, coordinates: 2 }); } catch (_) { }
        try { if (typeof turf.cleanCoords === 'function') result = turf.cleanCoords(result); } catch (_) { }
        return result || value;
    }

    /**
     * takers:   [{ proposalId, region: Polygon|MultiPolygon, tunnels?: [Polygon] }] — the land each
     *           applied design takes; a road's building tunnels take nothing.
     * buildings: [{ key, geometry }] — the buildings shown (key = `<source>:<id>`).
     * → { records: Map<key, { id, geometry, demolishedPart?, remainder?, proposalId, proposalIds }>,
     *     tunnelled: Map<key, { proposalIds }>, failures: [{ key, error }] }
     * A record without `remainder` is a raze; with one, a cut. Order of the takers does not matter:
     * a building is cut against the union of what every taker clips from it.
     */
    function derive({ takers, buildings }, turf) {
        const prepared = (takers || []).map(taker => ({
            proposalId: taker.proposalId == null ? null : String(taker.proposalId),
            parts: partsOf(taker.region),
            tunnels: (taker.tunnels || []).map(geometry => ({ geometry, bbox: bboxOf(geometry) })),
            bbox: bboxOf(taker.region)
        })).filter(taker => taker.parts.length);
        const records = new Map();
        const tunnelled = new Map();
        const failures = [];
        for (const building of buildings || []) {
            if (!building?.key || !building.geometry) continue;
            const box = bboxOf(building.geometry);
            const candidates = prepared.filter(taker => overlaps(taker.bbox, box));
            if (!candidates.length) continue;
            try {
                const outcome = deriveOne(building, box, candidates, turf);
                if (outcome?.record) records.set(building.key, outcome.record);
                else if (outcome?.tunnelledBy) tunnelled.set(building.key, { proposalIds: outcome.tunnelledBy });
            } catch (error) {
                failures.push({ key: building.key, error });
            }
        }
        return { records, tunnelled, failures };
    }

    function deriveOne(building, box, takers, turf) {
        const footprint = clean(turf, feature(building.geometry));
        const footprintArea = area(turf, footprint);
        let taken = null;
        const takenBy = [];
        const tunnelledBy = [];
        for (const taker of takers) {
            let clip = null;
            for (const part of taker.parts) {
                if (!overlaps(part.bbox, box)) continue;
                const piece = turf.intersect(footprint, clean(turf, feature(part.geometry)));
                if (!piece) continue;
                clip = clip ? turf.union(clip, piece) : piece;
            }
            if (!clip) continue;
            for (const tunnel of taker.tunnels) {
                if (!overlaps(tunnel.bbox, box) || !clip) continue;
                const under = turf.intersect(clip, feature(tunnel.geometry));
                if (!under || area(turf, under) < MIN_TAKEN_M2) continue;
                if (!tunnelledBy.includes(taker.proposalId)) tunnelledBy.push(taker.proposalId);
                clip = turf.difference(clip, feature(tunnel.geometry));
            }
            if (!clip || area(turf, clip) < MIN_TAKEN_M2) continue;
            takenBy.push(taker.proposalId);
            taken = taken ? turf.union(clean(turf, taken), clean(turf, clip)) : clip;
        }
        if (!taken) return tunnelledBy.length ? { tunnelledBy } : null;
        const remainder = turf.difference(footprint, clean(turf, taken));
        const proposalIds = takenBy.filter(id => id !== null);
        const base = { id: building.key, geometry: building.geometry, proposalId: proposalIds[proposalIds.length - 1] ?? null, proposalIds };
        if (!remainder || area(turf, remainder) < Math.max(MIN_REMAINDER_M2, footprintArea * MIN_REMAINDER_FRACTION)) return { record: base };
        return { record: { ...base, demolishedPart: taken.geometry, remainder: remainder.geometry } };
    }

    return { MIN_TAKEN_M2, MIN_REMAINDER_M2, MIN_REMAINDER_FRACTION, derive, tunnelRegionsOf, bboxOf };
});
