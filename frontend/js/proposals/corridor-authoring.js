// Pure authoring transaction planner for a newly drawn corridor.
//
// A road junction belongs to every road that meets there. Finishing a new road therefore plans
// the new record and the topology-only edits to the already-applied roads it touches as ONE change.
// Nothing in this module reads the map, writes storage, or mutates its inputs; ProposalManager owns
// the atomic commit/rollback around the returned plan.
(function attachCorridorAuthoring(root, factory) {
    const api = factory(root || globalThis);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.CorridorAuthoring = api;
})(typeof window !== 'undefined' ? window : globalThis, function corridorAuthoringFactory(global) {
    'use strict';

    // A design's publication identity: its publication mark, `published: { cid, publishedAt, apiBase }`
    // (proposals/design-sync.js). Designs are not minted (plan-design-agreement.md, M3), so a design
    // carries no chain identity to detach.
    const PUBLISHED_IDENTITY_KEYS = ['published'];

    function cloneValue(value) {
        if (value === null || value === undefined) return value;
        if (typeof structuredClone === 'function') {
            try { return structuredClone(value); } catch (_) { /* JSON fallback */ }
        }
        return JSON.parse(JSON.stringify(value));
    }

    function recordId(record) {
        const value = record && (record.proposalId || record.id);
        return value === null || value === undefined || !String(value) ? null : String(value);
    }

    function definitionOf(record) {
        return record && record.roadProposal && record.roadProposal.definition;
    }

    function centerlineOf(definition, options = {}) {
        const read = options.centerlineOf
            || (global && typeof global.corridorCenterlineOf === 'function' ? global.corridorCenterlineOf : null);
        if (read) {
            try { return cloneValue(read(definition) || []); } catch (_) { return []; }
        }
        const raw = definition && (
            (Array.isArray(definition.points) && definition.points.length && definition.points)
            || (Array.isArray(definition.segments) && definition.segments)
        );
        if (!raw || !raw.length) return [];
        const toPoint = point => {
            if (!point) return null;
            const lat = Number(point.lat !== undefined ? point.lat : (Array.isArray(point) ? point[1] : NaN));
            const lng = Number(point.lng !== undefined ? point.lng : (Array.isArray(point) ? point[0] : NaN));
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
            return (typeof point.level === 'number' && Number.isFinite(point.level))
                ? { lat, lng, level: point.level }
                : { lat, lng };
        };
        const segments = Array.isArray(raw[0]) ? raw : [raw];
        return segments
            .map(segment => (Array.isArray(segment) ? segment.map(toPoint).filter(Boolean) : []))
            .filter(segment => segment.length >= 2);
    }

    function isTrackDefinition(definition, options = {}) {
        const read = options.isTrack
            || (global && typeof global.corridorIsTrack === 'function' ? global.corridorIsTrack : null);
        if (read) {
            try { return !!read(definition); } catch (_) { /* stored flag fallback */ }
        }
        return !!(definition && definition.metadata && definition.metadata.isTrack === true);
    }

    function isAppliedRecord(record, options = {}) {
        if (typeof options.isApplied === 'function') {
            try { return !!options.isApplied(record, record && record.roadProposal); } catch (_) { return false; }
        }
        return !!(record && record.applied === true);
    }

    function protectedEdgeKeysOf(definition, options = {}) {
        const read = options.protectedEdgeKeysOf
            || (global && typeof global.corridorProtectedEdgeKeySet === 'function'
                ? (value => global.corridorProtectedEdgeKeySet(value.tunnels, value.gradeSeparations))
                : null);
        if (read) {
            try {
                const keys = read(definition);
                if (keys && typeof keys.forEach === 'function') return new Set(keys);
            } catch (_) { /* stored-key fallback */ }
        }
        const keys = new Set();
        const add = record => {
            if (record && record.edgeKey) keys.add(record.edgeKey);
            (Array.isArray(record && record.edgeKeys) ? record.edgeKeys : []).forEach(key => {
                if (key) keys.add(key);
            });
        };
        (Array.isArray(definition && definition.tunnels) ? definition.tunnels : []).forEach(add);
        (Array.isArray(definition && definition.gradeSeparations) ? definition.gradeSeparations : []).forEach(add);
        return keys;
    }

    // The planner works on the VIEW (stretch fields). A record arriving in its stored shape, the
    // OSM document alone (roads.md §11), is decoded first: the draft build already projects a new
    // road into that shape before the atomic create, and the store hands out views.
    function viewOf(definition) {
        if (!definition || !definition.osm) return definition;
        const form = (global && global.__corridorOsmForm)
            || (typeof require === 'function' ? require('../corridor-osm-form.js') : null);
        if (!form || typeof form.toView !== 'function') {
            throw new Error('The corridor record form is unavailable.');
        }
        return form.toView(definition);
    }

    function entryFor(record, options = {}) {
        const definition = viewOf(cloneValue(definitionOf(record)));
        if (!definition) return null;
        const segments = centerlineOf(definition, options);
        if (!segments.length) return null;
        const segmentIds = segments.map((_, index) => (
            Array.isArray(definition.segmentIds) && definition.segmentIds[index] !== undefined
                ? definition.segmentIds[index]
                : null
        ));
        return {
            record,
            definition,
            segments,
            segmentIds,
            segmentProfiles: definition.segmentProfiles ? cloneValue(definition.segmentProfiles) : null,
            protectedEdgeKeys: protectedEdgeKeysOf(definition, options)
        };
    }

    function entrySignature(entry) {
        return JSON.stringify({
            segments: entry.segments,
            segmentIds: entry.segmentIds,
            segmentProfiles: entry.segmentProfiles || null
        });
    }

    function definitionFromEntry(entry) {
        const definition = cloneValue(entry.definition);
        const segments = cloneValue(entry.segments);
        definition.points = segments;
        definition.segments = segments;
        definition.segmentIds = cloneValue(entry.segmentIds);
        if (entry.segmentProfiles) {
            const live = new Set(entry.segmentIds
                .filter(id => id !== null && id !== undefined)
                .map(String));
            const profiles = cloneValue(entry.segmentProfiles);
            Object.keys(profiles).forEach(id => {
                if (!live.has(String(id))) delete profiles[id];
            });
            definition.segmentProfiles = profiles;
        } else {
            delete definition.segmentProfiles;
        }
        return definition;
    }

    function writeDefinition(record, definition) {
        if (!record || !definition) return false;
        record.roadProposal = {
            ...(record.roadProposal || {}),
            definition: cloneValue(definition)
        };
        if (definition.polygon) {
            record.site = cloneValue(definition.polygon);
            delete record.binding;
        }
        return true;
    }

    function detachPublishedIdentity(record) {
        const removed = {};
        if (!record) return removed;
        PUBLISHED_IDENTITY_KEYS.forEach(key => {
            if (!Object.prototype.hasOwnProperty.call(record, key)) return;
            removed[key] = record[key];
            delete record[key];
        });
        return removed;
    }


    // ---- junctions between records -------------------------------------------------------------
    //
    // A junction belongs to every road that meets there, and each record's LAND must be buildable
    // from its own definition. So when two records are joined, each definition records the node and
    // the OTHER road's arms there (direction and cross-section): the footprint takes the corner land
    // the kerb returns need (corridor-footprint.js), and a narrower record widens back to the wider
    // road it continues (corridor-transition.js) — from what it knows, without reading its neighbour.
    const JUNCTION_NODE_EPS = 1e-7;

    function samePoint(a, b) {
        return !!a && !!b && Math.abs(a.lat - b.lat) < JUNCTION_NODE_EPS && Math.abs(a.lng - b.lng) < JUNCTION_NODE_EPS;
    }

    const pointLevel = point => typeof point?.level === 'number' && Number.isFinite(point.level) ? point.level : 0;
    const sameNode = (a, b) => samePoint(a, b) && pointLevel(a) === pointLevel(b);

    // The stretch's cross-section: its own override, the road's profile, or what the app derives
    // for a record that only knows its width (corridorProfileOf); null when nothing says.
    function segmentProfileOf(entry, index) {
        const id = entry.segmentIds[index];
        const override = entry.segmentProfiles && id !== null && id !== undefined ? entry.segmentProfiles[String(id)] : null;
        if (override) return cloneValue(override);
        if (entry.definition.profile) return cloneValue(entry.definition.profile);
        const derive = global && typeof global.corridorProfileOf === 'function' ? global.corridorProfileOf : null;
        if (derive) {
            try { return cloneValue(derive(entry.definition) || null); } catch (_) { return null; }
        }
        return null;
    }

    // The arms of `entry` at `node`: one per neighbouring vertex, with the stretch's cross-section
    // (or only its width, when that is all the record has).
    function armsAt(entry, node) {
        const arms = [];
        entry.segments.forEach((segment, index) => {
            segment.forEach((point, vertex) => {
                if (!sameNode(point, node)) return;
                [segment[vertex - 1], segment[vertex + 1]].forEach(neighbour => {
                    if (!neighbour || samePoint(neighbour, node)) return;
                    if (arms.some(arm => samePoint(arm.toward, neighbour))) return;
                    const profile = segmentProfileOf(entry, index);
                    const width = Number(entry.definition.width);
                    arms.push({
                        toward: { lat: neighbour.lat, lng: neighbour.lng },
                        ...(profile ? { profile } : {}),
                        ...(!profile && Number.isFinite(width) && width > 0 ? { width } : {})
                    });
                });
            });
        });
        return arms;
    }

    function sharedNodes(a, b) {
        const nodes = [];
        a.segments.forEach(segment => segment.forEach(point => {
            if (nodes.some(node => sameNode(node, point))) return;
            if (b.segments.some(other => other.some(candidate => sameNode(candidate, point)))) {
                nodes.push({ lat: point.lat, lng: point.lng, ...(pointLevel(point) ? { level: pointLevel(point) } : {}) });
            }
        }));
        return nodes;
    }

    // Write `arms` (another road's) into `entry.definition.junctions` at `node`; true when it changed.
    function recordJunction(entry, node, arms) {
        if (!arms.length) return false;
        const junctions = Array.isArray(entry.definition.junctions) ? entry.definition.junctions : [];
        let junction = junctions.find(candidate => sameNode(candidate, node));
        let changed = false;
        if (!junction) {
            junction = { ...node, arms: [] };
            junctions.push(junction);
            changed = true;
        }
        if (!Array.isArray(junction.arms)) { junction.arms = []; changed = true; }
        arms.forEach(arm => {
            const existing = junction.arms.find(candidate => samePoint(candidate.toward, arm.toward));
            if (existing) {
                if (JSON.stringify(existing.profile) !== JSON.stringify(arm.profile)) { existing.profile = arm.profile; changed = true; }
                return;
            }
            junction.arms.push(arm);
            changed = true;
        });
        entry.definition.junctions = junctions;
        return changed;
    }

    // Both records learn of every node they share and of each other's arms there.
    function recordSharedJunctions(a, b) {
        let changedA = false;
        let changedB = false;
        sharedNodes(a, b).forEach(node => {
            if (recordJunction(a, node, armsAt(b, node))) changedA = true;
            if (recordJunction(b, node, armsAt(a, node))) changedB = true;
        });
        return { changedA, changedB };
    }

    function removeJunctionAtNode(entry, node) {
        const junctions = Array.isArray(entry.definition.junctions) ? entry.definition.junctions : [];
        const retained = junctions.filter(junction => !sameNode(junction, node));
        if (retained.length === junctions.length) return false;
        if (retained.length) entry.definition.junctions = retained;
        else delete entry.definition.junctions;
        return true;
    }

    function recordSharedJunctionAtNode(a, b, node) {
        if (!a.segments.some(segment => segment.some(point => sameNode(point, node)))
            || !b.segments.some(segment => segment.some(point => sameNode(point, node)))) return;
        recordJunction(a, node, armsAt(b, node));
        recordJunction(b, node, armsAt(a, node));
    }

    // Refresh only the junction snapshots that an in-place edit can affect. The ordinary authoring
    // planner first nodes the edited graph against applied records; this pass then retires stale
    // snapshots at its old junctions and rebuilds the old/new node from every currently meeting
    // record. Geometry and every unrelated junction stay as they were.
    function planCorridorEdit(beforeProposal, editedProposal, records, options = {}) {
        const editedId = recordId(editedProposal);
        const authoringOptions = {
            ...options,
            excludeProposalIds: [
                ...(Array.isArray(options.excludeProposalIds) ? options.excludeProposalIds : []),
                ...(editedId ? [editedId] : [])
            ]
        };
        const planned = planCorridorAuthoring(editedProposal, records, authoringOptions);
        const edited = entryFor(planned.proposal, options);
        const impacted = new Map();
        const addNode = node => {
            if (!node || !Number.isFinite(Number(node.lat)) || !Number.isFinite(Number(node.lng))) return;
            const value = { lat: Number(node.lat), lng: Number(node.lng), ...(pointLevel(node) ? { level: pointLevel(node) } : {}) };
            if (!Array.from(impacted.values()).some(existing => sameNode(existing, value))) {
                impacted.set(`${value.lat},${value.lng},${pointLevel(value)}`, value);
            }
        };
        const addJunctionNodes = definition => {
            (Array.isArray(definition && definition.junctions) ? definition.junctions : []).forEach(addNode);
        };
        addJunctionNodes(definitionOf(beforeProposal));
        addJunctionNodes(edited.definition);

        const currentById = new Map();
        (Array.isArray(records) ? records : []).forEach(record => {
            const id = recordId(record);
            if (!id || id === editedId || !isAppliedRecord(record, options)) return;
            currentById.set(id, cloneValue(record));
        });
        planned.existingChanges.forEach(change => {
            const current = currentById.get(change.proposalId);
            if (current) writeDefinition(current, change.definition);
        });
        const entries = [...currentById.values()].map(record => entryFor(record, options)).filter(Boolean);
        entries.push(edited);

        for (const node of impacted.values()) {
            entries.forEach(entry => removeJunctionAtNode(entry, node));
            const atNode = entries.filter(entry => entry.segments.some(segment => segment.some(point => sameNode(point, node))));
            for (let i = 0; i < atNode.length; i += 1) {
                for (let j = i + 1; j < atNode.length; j += 1) recordSharedJunctionAtNode(atNode[i], atNode[j], node);
            }
        }

        writeDefinition(planned.proposal, definitionFromEntry(edited));
        const originalById = new Map((Array.isArray(records) ? records : [])
            .map(record => [recordId(record), record]).filter(([id]) => !!id));
        const authoringChangedIds = new Set(planned.existingChanges.map(change => String(change.proposalId)));
        const existingChanges = entries
            .filter(entry => recordId(entry.record) !== editedId)
            .map(entry => ({ proposalId: recordId(entry.record), definition: definitionFromEntry(entry) }))
            .filter(change => {
                if (!change.proposalId) return false;
                const original = definitionOf(originalById.get(change.proposalId));
                return authoringChangedIds.has(String(change.proposalId))
                    || JSON.stringify(original && original.junctions) !== JSON.stringify(change.definition.junctions);
            })
            .sort((a, b) => a.proposalId.localeCompare(b.proposalId));

        return {
            ...planned,
            proposal: planned.proposal,
            existingChanges,
            touchedProposalIds: existingChanges.map(change => change.proposalId)
        };
    }

    // Plan only junctions caused by THIS new corridor. Existing roads are visited one at a time,
    // in stable id order, against the evolving new road. Thus finishing one street cannot quietly
    // heal or rewrite an unrelated intersection elsewhere in the city.
    function planCorridorAuthoring(newProposal, existingRecords, options = {}) {
        const geometry = options.geometry || (global && global.CorridorGeometry);
        if (!geometry || typeof geometry.normalizeCorridorNetwork !== 'function') {
            throw new Error('Corridor topology engine is unavailable.');
        }
        const proposed = cloneValue(newProposal);
        const newEntry = entryFor(proposed, options);
        if (!newEntry) throw new Error('The new corridor has no valid centerline.');

        // The drawing tool already normalizes its own graph, but the transaction boundary repeats
        // the pure invariant so imports and future callers cannot commit a self-crossing stroke.
        geometry.normalizeCorridorNetwork([newEntry], { toleranceMeters: 0 });

        const excluded = new Set((Array.isArray(options.excludeProposalIds) ? options.excludeProposalIds : [])
            .map(String));
        const newIsTrack = isTrackDefinition(newEntry.definition, options);
        // Applied corridors of EITHER kind: a road and a tram line that cross meet at a level
        // crossing, one node shared by both, exactly as OSM models it. Roads used to node only with
        // roads and tracks only with tracks, so a street drawn over a track stayed two strangers.
        const candidates = (Array.isArray(existingRecords) ? existingRecords : [])
            .filter(record => {
                const id = recordId(record);
                const definition = definitionOf(record);
                return !!id && !excluded.has(id) && !!definition
                    && isAppliedRecord(record, options);
            })
            .sort((a, b) => recordId(a).localeCompare(recordId(b)));

        const existingChanges = [];
        let junctionRecords = 0;
        candidates.forEach(record => {
            const existingEntry = entryFor(record, options);
            if (!existingEntry) return;

            // Normalize the record's own graph only on a private clone. It is written back only if
            // the pair pass proves the new road actually forms a junction with this record.
            geometry.normalizeCorridorNetwork([existingEntry], { toleranceMeters: 0 });
            const beforeNew = entrySignature(newEntry);
            const beforeExisting = entrySignature(existingEntry);
            geometry.normalizeCorridorNetwork([newEntry, existingEntry], { toleranceMeters: 0 });
            const newChanged = entrySignature(newEntry) !== beforeNew;
            let existingChanged = entrySignature(existingEntry) !== beforeExisting;
            // A node the two now share is a junction both must know about (recordSharedJunctions);
            // an end-to-end join changes no geometry but is a junction all the same, and the
            // existing record is re-snapshotted to carry it.
            const shared = recordSharedJunctions(newEntry, existingEntry);
            if (shared.changedB) existingChanged = true;
            if (!newChanged && !existingChanged && !shared.changedA) return;

            junctionRecords += 1;
            if (existingChanged) {
                existingChanges.push({
                    proposalId: recordId(record),
                    definition: definitionFromEntry(existingEntry)
                });
            }
        });

        writeDefinition(proposed, definitionFromEntry(newEntry));
        return {
            proposal: proposed,
            existingChanges,
            touchedProposalIds: existingChanges.map(change => change.proposalId),
            junctionRecords,
            isTrack: newIsTrack
        };
    }

    // Author a complete isolated composition (MCP plans). Solve every crossing before recording
    // foreign arms: a later street can split an earlier arm, changing its available corner length.
    // Rebuild those references from the final graph so edits/removals cannot leave stale arms.
    function planCorridorComposition(records, options = {}) {
        const geometry = options.geometry || (global && global.CorridorGeometry);
        if (!geometry || typeof geometry.normalizeCorridorNetwork !== 'function') {
            throw new Error('Corridor topology engine is unavailable.');
        }
        const proposals = cloneValue(records);
        const entries = proposals.map(record => entryFor(record, options));
        if (entries.some(entry => !entry)) throw new Error('A corridor has no valid centerline.');
        entries.forEach(entry => { delete entry.definition.junctions; });
        geometry.normalizeCorridorNetwork(entries, { toleranceMeters: 0 });
        entries.forEach((entry, index) => {
            entries.slice(index + 1).forEach(other => recordSharedJunctions(entry, other));
        });
        entries.forEach(entry => writeDefinition(entry.record, definitionFromEntry(entry)));
        return proposals;
    }

    return {
        PUBLISHED_IDENTITY_KEYS: PUBLISHED_IDENTITY_KEYS.slice(),
        cloneValue,
        recordId,
        centerlineOf,
        isTrackDefinition,
        planCorridorAuthoring,
        planCorridorEdit,
        planCorridorComposition,
        writeDefinition,
        detachPublishedIdentity
    };
});
