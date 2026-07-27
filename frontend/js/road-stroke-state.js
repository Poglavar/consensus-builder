// The road-drawing undo/cancel STATE transitions, as pure reducers over an explicit state bag.
//
// In road-drawing.js the active stroke is `roadPoints`, which is the SAME array object as one entry
// inside `roadSegments` (an alias), and each segment's id lives at the matching index of
// `roadSegmentIds`. The one invariant that must always hold is segments.length === segmentIds.length
// — a per-segment cross-section override is filed under its id, so a mis-aligned splice orphans it or
// attaches it to the wrong road. This module isolates the array surgery so a headless test can throw
// any sequence of push/undo/cancel at it and assert the lengths stay locked together.
//
// Faithful to the original: it MUTATES the passed segments/segmentIds in place (so their identity is
// preserved, exactly as the live code relies on) and returns the new scalar state + the edges it
// removed (the UI feeds those to the tunnel-record cleanup). `activeIndex` is where `roadPoints`
// aliases into `segments`, or -1 when the pen is up. removedEdges are [from, to] point pairs.

(function (global) {
    'use strict';

    // Cancel the active stroke: pop back to strokeBaseCount (what THIS stroke added), then drop the
    // segment entirely if it no longer has ≥2 points. The pen goes up (activeIndex -1, hasStarted
    // false). Returns { removedEdges, activeIndex, hasStarted, strokeBaseCount, cancelled }.
    function applyStrokeCancel(state) {
        const { segments, segmentIds } = state;
        const { activeIndex, hasStarted, strokeBaseCount } = state;
        const removedEdges = [];
        const done = (cancelled) => ({ removedEdges, activeIndex: -1, hasStarted: false, strokeBaseCount: 0, cancelled });

        if (!hasStarted || !Array.isArray(segments) || activeIndex < 0 || activeIndex >= segments.length) {
            return done(false);
        }
        const active = segments[activeIndex];
        if (!Array.isArray(active)) return done(false);

        const base = Math.max(strokeBaseCount, 0);
        while (active.length > base) {
            const removed = active[active.length - 1];
            const prev = active[active.length - 2];
            if (prev) removedEdges.push([prev, removed]);
            active.pop();
        }
        if (active.length < 2) {
            segments.splice(activeIndex, 1);
            segmentIds.splice(activeIndex, 1);
        }
        return done(true);
    }

    // Undo one vertex. If the pen is up, resume the last segment first. Pop its last point; if that
    // empties the segment, drop it. Returns { removedEdges, activeIndex, hasStarted, strokeBaseCount,
    // undone }. activeIndex/hasStarted/strokeBaseCount describe the state AFTER the undo.
    function applyRoadUndo(state) {
        const { segments, segmentIds } = state;
        let { activeIndex, hasStarted, strokeBaseCount } = state;
        const removedEdges = [];
        const result = (undone) => ({ removedEdges, activeIndex, hasStarted, strokeBaseCount, undone });

        if (!Array.isArray(segments)) return result(false);

        // Pen up: resume the last segment if it has something to undo.
        if (!hasStarted) {
            const last = segments[segments.length - 1];
            if (!segments.length || (last && last.length ? last.length : 0) <= 1) {
                return result(false); // nothing to undo
            }
            activeIndex = segments.length - 1;
            hasStarted = true;
            strokeBaseCount = segments[activeIndex].length;
        }

        const active = (activeIndex >= 0 && activeIndex < segments.length) ? segments[activeIndex] : null;
        if (!hasStarted || !Array.isArray(active) || active.length <= 1) {
            return result(false); // can't undo a single point or none
        }

        const removed = active[active.length - 1];
        const prev = active[active.length - 2];
        if (prev) removedEdges.push([prev, removed]);
        active.pop();

        if (active.length === 0) {
            // Drop the now-empty segment (splice ids in lockstep) and put the pen up.
            segments.splice(activeIndex, 1);
            segmentIds.splice(activeIndex, 1);
            activeIndex = -1;
            hasStarted = false;
        }
        return result(true);
    }

    const api = { applyStrokeCancel, applyRoadUndo };

    if (typeof window !== 'undefined') {
        window.RoadStrokeState = api;
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
})(typeof window !== 'undefined' ? window : globalThis);
