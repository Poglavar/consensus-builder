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
        const candidates = (Array.isArray(existingRecords) ? existingRecords : [])
            .filter(record => {
                const id = recordId(record);
                const definition = definitionOf(record);
                return !!id && !excluded.has(id) && !!definition
                    && isAppliedRecord(record, options)
                    && isTrackDefinition(definition, options) === newIsTrack;
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
            const existingChanged = entrySignature(existingEntry) !== beforeExisting;
            if (!newChanged && !existingChanged) return;

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
