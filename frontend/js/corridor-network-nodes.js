// Purpose: make junctions BETWEEN road/track proposals real. normalizeCorridorGraph only ever saw
// one record's own strokes, so two roads drawn as two proposals could cross with no shared node —
// the crossing existed only as a rendering treatment, and the node editor (which reads one record)
// could drag one road's leg out of the junction and leave the other behind. This runs the same
// topology boundary across every applied corridor and writes the result back.
//
// It does NOT ask whether a corridor was minted or uploaded. The editor works on local records only
// — everything in it is already a local derivation, and every edit saves as a new derived record —
// so a published/local split here bought nothing and cost the feature: with 17 of a plan's roads
// published, a junction's node went into the road being edited and never into the one it met, and
// no amount of precise snapping could make the T form. A record's provenance is the publishing
// layer's business, not the geometry editor's.
//
// Inserting a vertex that lies on an existing edge, and re-splitting a polyline at its nodes, changes
// only how a centreline is written down — never where it runs. So an applied road can be upgraded in
// place: no unapply, no re-cut of the parcels it crosses, no change to its footprint. Both of those
// invariants are ASSERTED per corridor before anything is written (see `writeBackIsSafe`), and a
// corridor that fails is left exactly as it was.
(function attachCorridorNetworkNodes(global) {
    'use strict';

    // A vertex may be healed onto a neighbour within the 1e-7 degrees every corridor consumer already
    // treats as "the same node" (~1 cm). Anything beyond that is geometry moving, which this pass is
    // not allowed to do.
    const LENGTH_TOLERANCE_DEG = 1e-6;

    let running = false;
    let suppressed = 0;

    function corridorGeometry() {
        return global.CorridorGeometry || null;
    }

    function centerlineOf(definition) {
        if (typeof global.corridorCenterlineOf !== 'function') return [];
        // corridorCenterlineOf already yields fresh point objects, but take a working copy of the
        // arrays too: nothing is written back until the result has been checked.
        return (global.corridorCenterlineOf(definition) || [])
            .filter(segment => Array.isArray(segment) && segment.length >= 2)
            .map(segment => segment.map(point => ({ ...point })));
    }

    function protectedEdgeKeysOf(definition) {
        if (typeof global.corridorProtectedEdgeKeySet === 'function') {
            try { return global.corridorProtectedEdgeKeySet(definition.tunnels, definition.gradeSeparations); }
            catch (_) { /* fall through */ }
        }
        const keys = new Set();
        (Array.isArray(definition.tunnels) ? definition.tunnels : []).forEach(record => {
            if (record && record.edgeKey) keys.add(record.edgeKey);
        });
        (Array.isArray(definition.gradeSeparations) ? definition.gradeSeparations : []).forEach(record => {
            if (record && record.edgeKey) keys.add(record.edgeKey);
            (Array.isArray(record && record.edgeKeys) ? record.edgeKeys : []).forEach(key => { if (key) keys.add(key); });
        });
        return keys;
    }

    function edgeKeysOf(segments) {
        const keys = new Set();
        if (typeof global.corridorTunnelEdgeKey !== 'function') return keys;
        (segments || []).forEach(segment => {
            for (let index = 0; index < segment.length - 1; index += 1) {
                const key = global.corridorTunnelEdgeKey(segment[index], segment[index + 1]);
                if (key) keys.add(key);
            }
        });
        return keys;
    }

    // Total planar length of a centreline, in degrees. Splitting an edge at a point ON it preserves
    // this exactly; moving any vertex does not. It is the cheapest complete statement of "the road
    // still runs where it ran", and it needs no projection and no turf.
    function planarLength(segments) {
        let total = 0;
        (segments || []).forEach(segment => {
            for (let index = 0; index < segment.length - 1; index += 1) {
                const dLat = segment[index + 1].lat - segment[index].lat;
                const dLng = segment[index + 1].lng - segment[index].lng;
                total += Math.hypot(dLat, dLng);
            }
        });
        return total;
    }

    // Refuse the write unless the corridor still runs exactly where it ran and still carries every
    // tunnel/grade-separation edge it carried. A pass that silently shortened a road or orphaned a
    // tunnel record would be far worse than one that left a junction unnoded.
    function writeBackIsSafe(before, after, protectedKeys) {
        const lengthBefore = planarLength(before);
        const lengthAfter = planarLength(after);
        if (Math.abs(lengthAfter - lengthBefore) > Math.max(LENGTH_TOLERANCE_DEG, lengthBefore * 1e-6)) {
            return { ok: false, reason: `centreline length moved by ${(lengthAfter - lengthBefore).toExponential(2)}°` };
        }
        if (protectedKeys && protectedKeys.size) {
            const live = edgeKeysOf(after);
            const lost = [...protectedKeys].filter(key => !live.has(key));
            if (lost.length) return { ok: false, reason: `${lost.length} tunnel/grade-separation edge(s) would be orphaned` };
        }
        return { ok: true };
    }

    function appliedCorridors() {
        const store = global.proposalStorage;
        if (!store || typeof store.getAllProposals !== 'function') return [];
        const isAppliedFn = (typeof global.isApplied === 'function') ? global.isApplied : (p => p && p.applied === true);
        return (store.getAllProposals() || [])
            .filter(proposal => {
                const definition = proposal && proposal.roadProposal && proposal.roadProposal.definition;
                if (!definition) return false;
                return isAppliedFn(proposal, proposal.roadProposal);
            })
            .map(proposal => {
                const definition = proposal.roadProposal.definition;
                const isTrack = (typeof global.corridorIsTrack === 'function')
                    ? global.corridorIsTrack(definition)
                    : !!(definition.metadata && definition.metadata.isTrack === true);
                return { proposal, definition, isTrack };
            })
            .filter(record => record.definition && centerlineOf(record.definition).length);
    }

    function cloneValue(value) {
        if (value === null || value === undefined) return value;
        try { return JSON.parse(JSON.stringify(value)); } catch (_) { return value; }
    }

    // Node one KIND of corridor against itself. Roads and tracks are separate networks here, exactly
    // as they are for drawing-time snapping (road-node-edit's snapDropLatLng filters on the same
    // question): a road crossing a railway is a level crossing, a different object from a junction,
    // and fusing the two networks' nodes is not something this pass gets to decide.
    function nodeOneNetwork(records, report) {
        const geometry = corridorGeometry();
        if (!geometry || typeof geometry.normalizeCorridorNetwork !== 'function' || records.length < 2) return;

        const entries = records.map(record => ({
            record,
            before: centerlineOf(record.definition),
            segments: centerlineOf(record.definition),
            segmentIds: (Array.isArray(record.definition.segmentIds) ? record.definition.segmentIds : []).slice(),
            segmentProfiles: cloneValue(record.definition.segmentProfiles) || null,
            protectedEdgeKeys: protectedEdgeKeysOf(record.definition)
        }));

        geometry.normalizeCorridorNetwork(entries);

        entries.forEach(entry => {
            const { record } = entry;
            const label = record.proposal.title || record.proposal.proposalId;
            const vertexDelta = entry.segments.reduce((n, s) => n + s.length, 0)
                - entry.before.reduce((n, s) => n + s.length, 0);
            const stretchDelta = entry.segments.length - entry.before.length;
            if (!vertexDelta && !stretchDelta) return;

            const safety = writeBackIsSafe(entry.before, entry.segments, entry.protectedEdgeKeys);
            if (!safety.ok) {
                report.skipped.push({ label, kind: 'unsafe', detail: safety.reason });
                console.warn('[corridorNetworkNodes] refused to rewrite', label, safety.reason);
                return;
            }

            const definition = record.definition;
            definition.points = entry.segments;
            definition.segments = entry.segments;
            definition.segmentIds = entry.segmentIds;
            if (entry.segmentProfiles && Object.keys(entry.segmentProfiles).length) {
                const live = new Set(entry.segmentIds.filter(id => id !== null && id !== undefined).map(String));
                Object.keys(entry.segmentProfiles).forEach(id => {
                    if (!live.has(String(id))) delete entry.segmentProfiles[id];
                });
                definition.segmentProfiles = entry.segmentProfiles;
            }
            report.corridorsChanged += 1;
            report.nodesInserted += vertexDelta;
            report.stretchesSplit += stretchDelta;
            report.changedTitles.push(label);
        });
    }

    // Run the topology boundary across the whole applied corridor network. Convergent: a second run
    // reports nothing, because every crossing already carries its node.
    function normalize(options = {}) {
        const report = { corridorsChanged: 0, nodesInserted: 0, stretchesSplit: 0, changedTitles: [], skipped: [] };
        if (running || suppressed) return report;
        running = true;
        try {
            const records = appliedCorridors();
            nodeOneNetwork(records.filter(record => !record.isTrack), report);
            nodeOneNetwork(records.filter(record => record.isTrack), report);

            if (report.corridorsChanged) {
                try { global.proposalStorage?.save?.(); } catch (error) { console.error('[corridorNetworkNodes] could not persist', error); }
                try { global.scheduleCorridorStripRefresh?.(); } catch (_) { }
                try { global.refreshRoadNodeHandles?.(); } catch (_) { }
                try { global.dispatchEvent?.(new CustomEvent('corridorNetworkNoded', { detail: report })); } catch (_) { }
            }
            if (options.verbose || report.corridorsChanged || report.skipped.length) {
                // The skip REASONS go in the line, not inside a collapsed object. A run that reports
                // "17 skipped" and nothing else says a junction failed to form without saying why,
                // which is the same silence this whole pass exists to remove.
                const byKind = new Map();
                report.skipped.forEach(entry => {
                    if (!byKind.has(entry.kind)) byKind.set(entry.kind, []);
                    byKind.get(entry.kind).push(entry.label);
                });
                const why = [...byKind.entries()].map(([kind, labels]) => {
                    const named = labels.slice(0, 3).map(label => `"${label}"`).join(', ');
                    const rest = labels.length > 3 ? `, +${labels.length - 3} more` : '';
                    return `${labels.length} ${kind}: ${named}${rest}`;
                }).join(' · ');
                console.log(
                    `[corridorNetworkNodes] ${report.corridorsChanged} corridor(s) noded · `
                    + `${report.nodesInserted} node(s) added · ${report.stretchesSplit} stretch split(s)`
                    + (report.skipped.length ? ` · SKIPPED ${why}` : ''),
                    report
                );
            }
            if (options.verbose && typeof global.updateStatus === 'function') {
                global.updateStatus(report.corridorsChanged
                    ? `Noded ${report.corridorsChanged} road(s): ${report.nodesInserted} junction node(s) added.`
                    : 'Every crossing already carries its junction node.');
            }
            return report;
        } finally {
            running = false;
        }
    }

    // Run a multi-record edit with noding held back, then node ONCE at the end.
    //
    // Moving a junction is several records' edits in a row, and each one re-applies — which would
    // otherwise fire this pass while the junction is half-moved. It would then find the moved leg
    // crossing the legs still sitting at the old position, and node THOSE: junk vertices, at a
    // crossing that stops existing a moment later, left behind permanently.
    async function deferred(run) {
        suppressed += 1;
        try {
            return await run();
        } finally {
            suppressed -= 1;
            if (!suppressed) {
                try { normalize(); } catch (error) { console.error('[corridorNetworkNodes] deferred noding failed', error); }
            }
        }
    }

    global.CorridorNetworkNodes = { normalize, deferred };
    if (typeof module === 'object' && module.exports) {
        module.exports = { normalize, deferred, planarLength, writeBackIsSafe };
    }
    // The explicit one-off migration over an existing plan (the codebase keeps migrations explicit
    // rather than healing at boot — see ProposalManager's initial replay). Call it from the console.
    global.nodeRoadNetwork = () => normalize({ verbose: true });
})(typeof window !== 'undefined' ? window : globalThis);
