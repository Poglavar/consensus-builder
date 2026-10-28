// The road-drawing STATE transitions, as pure reducers over an explicit state bag: undo, lifting
// the pen, and the obstacles recorded per edge while drawing and decided once at Finish
// (road-editor.md decision 5).
//
// In road-drawing.js the active stroke is `roadPoints`, which is the SAME array object as one entry
// inside `roadSegments` (an alias), and each segment's id lives at the matching index of
// `roadSegmentIds`. The one invariant that must always hold is segments.length === segmentIds.length
// — a per-segment cross-section override is filed under its id, so a mis-aligned splice orphans it or
// attaches it to the wrong road. This module isolates the array surgery so a headless test can throw
// any sequence of push/undo/lift at it and assert the lengths stay locked together.
//
// Faithful to the original: it MUTATES the passed segments/segmentIds in place (so their identity is
// preserved, exactly as the live code relies on) and returns the new scalar state + the edges it
// removed (the UI feeds those to the tunnel-record cleanup). `activeIndex` is where `roadPoints`
// aliases into `segments`, or -1 when the pen is up. removedEdges are [from, to] point pairs.

(function (global) {
    'use strict';

    // Lift the pen: every point the stroke placed STAYS. Escape used to cancel the stroke (pop back
    // to where the pen went down), which threw away work with no undo; a lifted pen keeps it, and a
    // later click on a node continues from there. Only a stroke of fewer than 2 points — a lone
    // click, no line — is dropped, with its id. The pen goes up (activeIndex -1, hasStarted false).
    // Returns { removedEdges, activeIndex, hasStarted, lifted, dropped }; a dropped
    // stub has no edge, so removedEdges is always empty — kept for the same shape as applyRoadUndo.
    function applyPenLift(state) {
        const { segments, segmentIds, activeIndex, hasStarted } = state;
        const done = (lifted, dropped) => ({
            removedEdges: [], activeIndex: -1, hasStarted: false, lifted, dropped
        });

        if (!hasStarted || !Array.isArray(segments) || activeIndex < 0 || activeIndex >= segments.length) {
            return done(false, false);
        }
        const active = segments[activeIndex];
        if (!Array.isArray(active)) return done(false, false);
        if (active.length < 2) {
            segments.splice(activeIndex, 1);
            segmentIds.splice(activeIndex, 1);
            return done(true, true);
        }
        return done(true, false);
    }

    // Undo one vertex. If the pen is up, resume the last segment first. Pop its last point; if that
    // empties the segment, drop it and put the pen up — so the first (even the only) point of a
    // stroke is undoable too, leaving an empty drawing that is still in draw mode. Returns { removedEdges, activeIndex, hasStarted,
    // undone }. activeIndex/hasStarted describe the state AFTER the undo.
    function applyRoadUndo(state) {
        const { segments, segmentIds } = state;
        let { activeIndex, hasStarted } = state;
        const removedEdges = [];
        const result = (undone) => ({ removedEdges, activeIndex, hasStarted, undone });

        if (!Array.isArray(segments)) return result(false);

        // Pen up: resume the last segment if it has something to undo.
        if (!hasStarted) {
            const last = segments[segments.length - 1];
            if (!segments.length || !Array.isArray(last) || !last.length) {
                return result(false); // nothing to undo
            }
            activeIndex = segments.length - 1;
            hasStarted = true;
        }

        const active = (activeIndex >= 0 && activeIndex < segments.length) ? segments[activeIndex] : null;
        if (!hasStarted || !Array.isArray(active) || !active.length) {
            return result(false); // no point to undo
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

    // A click on the stroke's own last vertex (a double-click, or a snap back onto it) would add a
    // zero-length edge: no direction, so no cross-section, and a stroke made only of such an edge
    // draws as a bare centreline ("no strips for a drawn segment"). Such a click adds nothing.
    // Distance on a local equirectangular plane — exact enough at centimetre scale.
    const MIN_STROKE_EDGE_M = 0.01;
    function isRepeatedStrokeVertex(previous, point, minMeters = MIN_STROKE_EDGE_M) {
        if (!previous || !point) return false;
        const lat0 = Number(previous.lat), lng0 = Number(previous.lng);
        const lat1 = Number(point.lat), lng1 = Number(point.lng);
        if (![lat0, lng0, lat1, lng1].every(Number.isFinite)) return false;
        const metresPerDegree = 111320;
        const dy = (lat1 - lat0) * metresPerDegree;
        const dx = (lng1 - lng0) * metresPerDegree * Math.cos(((lat0 + lat1) / 2) * Math.PI / 180);
        return Math.hypot(dx, dy) < minMeters;
    }

    // The second click of a double-click. Its first click already placed the point and the double-
    // click finishes the road, so the second must add nothing — not even the edge of a pixel or two a
    // hand puts between the clicks, which isRepeatedStrokeVertex (1 cm) would let through. Mirrors
    // how Leaflet 1.9 decides that a dblclick happened: the browser's own click count for a mouse or
    // a pen, and for touch two taps within DOUBLE_TAP_MS (Leaflet simulates the dblclick there).
    // `previousTapAt` is the time of the click before this one, `now` this one's (ms).
    const DOUBLE_TAP_MS = 200;
    function isDoubleClickFollowUp(event, previousTapAt, now) {
        if (!event) return false;
        const detail = Number(event.detail);
        if (detail >= 2) return true;
        if (detail !== 1) return false;
        const mouse = event.pointerType === 'mouse'
            || !!(event.sourceCapabilities && !event.sourceCapabilities.firesTouchEvents);
        if (mouse) return false;
        return Number.isFinite(previousTapAt) && Number.isFinite(now)
            && now >= previousTapAt && now - previousTapAt <= DOUBLE_TAP_MS;
    }

    // ---- Obstacles recorded while drawing, decided once at Finish ---------------------------------
    //
    // A click no longer stops to ask about the buildings, plots, parks or roads its new edge runs
    // into: road-drawing.js records them against that edge and Finish asks once, for the whole
    // drawing (road-editor.md decision 5). `conflicts` is a Map edgeKey → entry, one per centre-line
    // edge:
    //   { key, from, to, buildings: [hit], plots: { plots: [], blocked: [] }, structures: [hit],
    //     crossings: [hit], markers: [{ lat, lng }] }
    // `from`/`to` are the edge as it was drawn; a pedestrian crossing's `t` runs along that direction.
    // `edgeKeyOf` is corridor-tunnel.js corridorTunnelEdgeKey (direction-free, 1e-7°).

    const pointKey = point => `${Number(point.lat).toFixed(7)},${Number(point.lng).toFixed(7)}`;

    function liveEdgeKeys(segments, edgeKeyOf) {
        const keys = new Set();
        (Array.isArray(segments) ? segments : []).forEach(segment => {
            if (!Array.isArray(segment)) return;
            for (let index = 0; index < segment.length - 1; index += 1) {
                const key = edgeKeyOf(segment[index], segment[index + 1]);
                if (key) keys.add(key);
            }
        });
        return keys;
    }

    // Only the conflicts of edges the drawing still has. Undo and a lifted one-click stroke take the
    // conflicts of the edges they removed with them; so does anything else that drops an edge.
    function retainLiveEdgeConflicts(segments, conflicts, edgeKeyOf) {
        const live = liveEdgeKeys(segments, edgeKeyOf);
        const kept = new Map();
        if (conflicts instanceof Map) {
            conflicts.forEach((entry, key) => { if (live.has(key)) kept.set(key, entry); });
        }
        return kept;
    }

    function edgeConflictCount(entry) {
        if (!entry) return 0;
        const plots = entry.plots || {};
        return (entry.buildings || []).length + (entry.structures || []).length + (entry.crossings || []).length
            + (plots.plots || []).length + (plots.blocked || []).length;
    }

    const crossingId = hit => `${hit.proposalId}:${pointKey(hit.point)}`;

    // One list per kind of obstacle for the whole drawing — what each Finish dialog is asked about.
    // A building, park or crossing met by several edges is listed once. A plot record's piece count
    // and area are summed over the edges, so a piece under the joint of two edges counts for both.
    function mergeEdgeConflicts(conflicts) {
        const buildings = new Map();
        const structures = new Map();
        const crossings = new Map();
        const plots = new Map();
        const blocked = new Map();
        const entries = conflicts instanceof Map ? [...conflicts.values()] : [];
        entries.forEach(entry => {
            (entry.buildings || []).forEach(hit => {
                const id = String(hit.id);
                if (!buildings.has(id)) buildings.set(id, hit);
            });
            (entry.structures || []).forEach(hit => {
                const id = String(hit.id);
                if (!structures.has(id)) structures.set(id, hit);
            });
            (entry.crossings || []).forEach(hit => {
                const id = crossingId(hit);
                if (!crossings.has(id)) crossings.set(id, hit);
            });
            ((entry.plots && entry.plots.plots) || []).forEach(plot => {
                const id = String(plot.proposalId);
                const known = plots.get(id);
                if (known) {
                    known.count += Number(plot.count) || 0;
                    known.areaM2 += Number(plot.areaM2) || 0;
                } else {
                    plots.set(id, { ...plot, proposalId: id, count: Number(plot.count) || 0, areaM2: Number(plot.areaM2) || 0 });
                }
            });
            ((entry.plots && entry.plots.blocked) || []).forEach(house => {
                const id = String(house.proposalId);
                const known = blocked.get(id);
                if (known) known.areaM2 += Number(house.areaM2) || 0;
                else blocked.set(id, { ...house, proposalId: id, areaM2: Number(house.areaM2) || 0 });
            });
        });
        return {
            buildings: [...buildings.values()],
            structures: [...structures.values()],
            crossings: [...crossings.values()],
            plots: {
                plots: [...plots.values()].sort((a, b) => b.areaM2 - a.areaM2 || a.proposalId.localeCompare(b.proposalId)),
                blocked: [...blocked.values()].sort((a, b) => a.proposalId.localeCompare(b.proposalId))
            }
        };
    }

    // How many of each kind are in the way, for the status line ("2 buildings and 1 park in the
    // way"). A house blocked on a plot is one of the buildings, so it is not counted twice.
    function summarizeEdgeConflicts(conflicts) {
        const merged = mergeEdgeConflicts(conflicts);
        const byKind = kind => merged.structures.filter(hit => hit.kind === kind).length;
        const summary = {
            buildings: merged.buildings.length,
            plots: merged.plots.plots.length,
            parks: byKind('park'),
            squares: byKind('square'),
            lakes: byKind('lake'),
            crossings: merged.crossings.length
        };
        summary.total = Object.values(summary).reduce((sum, count) => sum + count, 0);
        return summary;
    }

    // Where an edge is now: { segmentIndex, index } of its first point, or null when it is gone.
    function locateEdge(segments, key, edgeKeyOf) {
        for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
            const segment = segments[segmentIndex];
            if (!Array.isArray(segment)) continue;
            for (let index = 0; index < segment.length - 1; index += 1) {
                if (edgeKeyOf(segment[index], segment[index + 1]) === key) return { segmentIndex, index };
            }
        }
        return null;
    }

    // The Finish review's answers applied to the drawing, exactly as the click handler used to apply
    // them one edge at a time. A tunnel answer clips every edge through its buildings and inserts the
    // facade portals as real vertices, with tunnel records for the inside sub-edges only; an
    // underpass or overpass inserts each crossing's ramp ends and records the grade separation; a
    // surface answer names the buildings the road stays on top of. Portals and ramp ends of one edge
    // go in with ONE ordered splice, so neither invalidates the other's edge keys. Mutates `segments`
    // in place; `answers` null — a cancelled review — changes nothing.
    //   state:   { segments, segmentIds, conflicts }
    //   answers: { buildings: 'surface' | 'tunnel' | null, crossings: 'at-grade' | 'underpass' | 'overpass' | null }
    //   deps:    { edgeKeyOf, widthOf(segmentIndex), clipEdgeThroughBuildings(from, to, hits, width),
    //              makeTunnelRecord(from, to, hits, { segmentId }),
    //              buildGradeSeparationRecords(hits, mode, from, to, width),
    //              refreshGradeSeparationEdgeKeys(record, points), gradeSeparationFootprint?(record, width) }
    // Returns { tunnels, gradeSeparations, surfaceBuildingIds, insertedPoints }.
    function applyRoadConflictAnswers(state, answers, deps) {
        const out = { tunnels: [], gradeSeparations: [], surfaceBuildingIds: [], insertedPoints: 0 };
        if (!answers || !state || !Array.isArray(state.segments)) return out;
        const segments = state.segments;
        const segmentIds = Array.isArray(state.segmentIds) ? state.segmentIds : [];
        const conflicts = state.conflicts instanceof Map ? state.conflicts : new Map();
        const tunnel = answers.buildings === 'tunnel';
        const ramps = answers.crossings === 'underpass' || answers.crossings === 'overpass';
        const surface = new Set();

        conflicts.forEach((entry, key) => {
            const buildings = Array.isArray(entry.buildings) ? entry.buildings : [];
            const crossings = Array.isArray(entry.crossings) ? entry.crossings : [];
            if (answers.buildings === 'surface') buildings.forEach(hit => surface.add(String(hit.id)));
            if (!(tunnel && buildings.length) && !(ramps && crossings.length)) return;
            const at = locateEdge(segments, key, deps.edgeKeyOf);
            if (!at) return;
            const segment = segments[at.segmentIndex];
            const from = segment[at.index];
            const to = segment[at.index + 1];
            const width = deps.widthOf(at.segmentIndex);
            const segmentId = segmentIds[at.segmentIndex] ?? null;
            const interior = [];

            if (tunnel && buildings.length) {
                // Tunnel ONLY while inside the buildings. No interior crossing found (degenerate
                // geometry): the whole edge, as the click handler did.
                const subEdges = deps.clipEdgeThroughBuildings(from, to, buildings, width)
                    || [{ from, to, inside: true, hits: buildings }];
                subEdges.forEach((sub, index) => {
                    if (index < subEdges.length - 1) interior.push(sub.to);
                    if (!sub.inside) return;
                    const record = deps.makeTunnelRecord(sub.from, sub.to, sub.hits, { segmentId });
                    if (record) out.tunnels.push(record);
                });
            }

            const records = [];
            if (ramps && crossings.length) {
                // `t` was measured along the edge as drawn; a segment resumed from its first vertex
                // has since been reversed, so it is turned to the edge's live direction.
                const reversed = entry.from && entry.to
                    && pointKey(entry.from) === pointKey(to) && pointKey(entry.to) === pointKey(from);
                const hits = reversed ? crossings.map(hit => ({ ...hit, t: 1 - hit.t })) : crossings;
                (deps.buildGradeSeparationRecords(hits, answers.crossings, from, to, width) || []).forEach(record => {
                    record.segmentId = segmentId;
                    if (typeof deps.gradeSeparationFootprint === 'function') {
                        record.footprint = deps.gradeSeparationFootprint(record, width);
                    }
                    interior.push(record.from, record.to);
                    records.push(record);
                });
            }

            const dx = to.lng - from.lng;
            const dy = to.lat - from.lat;
            const lengthSq = dx * dx + dy * dy;
            const along = point => (lengthSq > 0
                ? ((point.lng - from.lng) * dx + (point.lat - from.lat) * dy) / lengthSq
                : 0);
            const ordered = interior
                .filter(point => point && along(point) > 1e-9 && along(point) < 1 - 1e-9)
                .sort((a, b) => along(a) - along(b))
                .filter((point, index, list) => index === 0
                    || Math.abs(point.lat - list[index - 1].lat) > 1e-9
                    || Math.abs(point.lng - list[index - 1].lng) > 1e-9);
            segment.splice(at.index + 1, 0, ...ordered);
            out.insertedPoints += ordered.length;
            records.forEach(record => {
                deps.refreshGradeSeparationEdgeKeys(record, segment);
                out.gradeSeparations.push(record);
            });
        });

        out.surfaceBuildingIds = [...surface];
        return out;
    }

    const api = {
        applyPenLift,
        applyRoadUndo,
        isRepeatedStrokeVertex,
        MIN_STROKE_EDGE_M,
        isDoubleClickFollowUp,
        DOUBLE_TAP_MS,
        retainLiveEdgeConflicts,
        edgeConflictCount,
        mergeEdgeConflicts,
        summarizeEdgeConflicts,
        applyRoadConflictAnswers
    };

    if (typeof window !== 'undefined') {
        window.RoadStrokeState = api;
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
})(typeof window !== 'undefined' ? window : globalThis);
