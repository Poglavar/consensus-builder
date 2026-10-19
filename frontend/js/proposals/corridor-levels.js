// Relative vertical levels on a corridor centreline, and the one rule that reads them: which
// stretches of a corridor take the cadastral surface.
//
// A level is -1 (underground), 0 (surface) or +1 (elevated), with fractional values in between
// describing a ramp. It is deliberately RELATIVE, so consensus-builder needs no terrain model to
// consume a corridor imported from a system that does have one — the absolute profile stays where
// the DEM is. See corridor-elevation.md, ruling of 2026-07-12: only a fully underground stretch
// skips land acquisition; ramps, portals and +1 acquire exactly like level 0.
//
// A corridor whose vertices carry no level at all acquires along its whole length, so every
// hand-drawn corridor behaves exactly as it did before this file existed.

(function attachCorridorLevels(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__corridorLevels = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createCorridorLevels() {
    const UNDERGROUND = -1;
    // Levels arrive as stored numbers, not as the result of arithmetic, so this only absorbs
    // representation noise — it is not a band that would swallow a steep ramp end.
    const LEVEL_EPSILON = 1e-6;

    function levelOf(point) {
        const value = Number(point && point.level);
        return Number.isFinite(value) ? value : 0;
    }

    function isUnderground(point) {
        return levelOf(point) <= UNDERGROUND + LEVEL_EPSILON;
    }

    // An edge is exempt only when BOTH its ends are underground. One end at the surface makes it a
    // portal or a ramp, which acquires.
    function edgeAcquires(from, to) {
        return !(isUnderground(from) && isUnderground(to));
    }

    // The contiguous runs of a centreline that take the surface. Cutting an edge out splits the run,
    // so a tunnel leaves a gap in the FOOTPRINT while the centreline itself stays whole — which is
    // what keeps a part-underground corridor one proposal under the one-contiguous-stretch ruling.
    function acquiringSpans(points) {
        const list = Array.isArray(points) ? points : [];
        if (list.length < 2) return list.length ? [list.slice()] : [];

        const spans = [];
        let current = [list[0]];
        for (let index = 1; index < list.length; index += 1) {
            if (edgeAcquires(list[index - 1], list[index])) {
                current.push(list[index]);
                continue;
            }
            if (current.length >= 2) spans.push(current);
            current = [list[index]];
        }
        if (current.length >= 2) spans.push(current);
        return spans;
    }

    function hasLevels(points) {
        return (Array.isArray(points) ? points : []).some(point => {
            const value = Number(point && point.level);
            return Number.isFinite(value) && value !== 0;
        });
    }

    // Pair a transit-project track's parallel latlngs/levels arrays into centreline vertices.
    // A missing or short levels array is read as level 0 rather than as absent geometry.
    function verticesFromTrack(track) {
        const latlngs = (track && Array.isArray(track.latlngs)) ? track.latlngs : [];
        const levels = (track && Array.isArray(track.levels)) ? track.levels : [];
        const vertices = [];
        // typeof, not Number(): Number(null) is 0, so a null latitude would coerce to a perfectly
        // finite point off the coast of Africa and be imported as real geometry.
        const coordinate = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);
        latlngs.forEach((pair, index) => {
            if (!Array.isArray(pair) || pair.length < 2) return;
            const lat = coordinate(pair[0]);
            const lng = coordinate(pair[1]);
            if (lat === null || lng === null) return;
            const rawLevel = coordinate(levels[index]);
            vertices.push({ lat, lng, level: rawLevel === null ? 0 : rawLevel });
        });
        return vertices;
    }

    // Per-edge classification, for reporting what an import is about to do.
    function summarizeLevels(points) {
        const list = Array.isArray(points) ? points : [];
        const summary = { edges: 0, surface: 0, elevated: 0, underground: 0, ramp: 0 };
        for (let index = 1; index < list.length; index += 1) {
            const from = levelOf(list[index - 1]);
            const to = levelOf(list[index]);
            summary.edges += 1;
            if (from === 0 && to === 0) summary.surface += 1;
            else if (from === 1 && to === 1) summary.elevated += 1;
            else if (isUnderground(list[index - 1]) && isUnderground(list[index])) summary.underground += 1;
            else summary.ramp += 1;
        }
        return summary;
    }

    return {
        UNDERGROUND,
        LEVEL_EPSILON,
        levelOf,
        isUnderground,
        edgeAcquires,
        acquiringSpans,
        hasLevels,
        verticesFromTrack,
        summarizeLevels
    };
});
