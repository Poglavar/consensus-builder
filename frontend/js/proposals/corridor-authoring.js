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

    const PUBLISHED_IDENTITY_KEYS = [
        'serverProposalId', 'chainProposalId', 'tokenId', 'onchain', 'nft', 'isMinted', 'hash'
    ];

    function cloneValue(value) {
        if (value === null || value === undefined) return value;
        if (typeof structuredClone === 'function') {
            try { return structuredClone(value); } catch (_) { /* JSON fallback */ }
        }
        return JSON.parse(JSON.stringify(value));
    }

    function recordId(record) {
        const value = record && (record.proposalId || record.id || record.hash || record.tokenId);
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

    function entryFor(record, options = {}) {
        const definition = cloneValue(definitionOf(record));
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

    // The record IS its OSM form (roads.md §11): every definition authoring writes carries one,
    // and publication refuses a record whose stretches and form disagree.
    function osmFormApi() {
        if (global && global.__corridorOsmForm) return global.__corridorOsmForm;
        if (typeof require === 'function') return require('../corridor-osm-form.js');
        throw new Error('corridor-osm-form is not available');
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
        return osmFormApi().withOsmForm(definition);
    }

    function writeDefinition(record, definition) {
        if (!record || !definition) return false;
        record.roadProposal = {
            ...(record.roadProposal || {}),
            definition: cloneValue(definition)
        };
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
                if (!samePoint(point, node)) return;
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
            if (nodes.some(node => samePoint(node, point))) return;
            if (b.segments.some(other => other.some(candidate => samePoint(candidate, point)))) nodes.push({ lat: point.lat, lng: point.lng });
        }));
        return nodes;
    }

    // Write `arms` (another road's) into `entry.definition.junctions` at `node`; true when it changed.
    function recordJunction(entry, node, arms) {
        if (!arms.length) return false;
        const junctions = Array.isArray(entry.definition.junctions) ? entry.definition.junctions : [];
        let junction = junctions.find(candidate => samePoint(candidate, node));
        let changed = false;
        if (!junction) {
            junction = { lat: node.lat, lng: node.lng, arms: [] };
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

    return {
        PUBLISHED_IDENTITY_KEYS: PUBLISHED_IDENTITY_KEYS.slice(),
        cloneValue,
        recordId,
        centerlineOf,
        isTrackDefinition,
        planCorridorAuthoring,
        writeDefinition,
        detachPublishedIdentity
    };
});
