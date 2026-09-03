// Authoritative in-memory parcel fabric.
//
// This module deliberately knows nothing about Leaflet, IndexedDB, proposal UI, or the
// cadastral transport.  It owns exactly one thing: the current, committed partition of live
// parcel features.  Every mutation is prepared in a private draft and becomes visible in one
// revision.  Renderers subscribe to committed revisions; they never participate in domain reads.
(function attachLiveParcelFabric(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) {
        root.createLiveParcelFabric = api.createLiveParcelFabric;
        root.LiveParcelFabric = api.createLiveParcelFabric();
    }
})(typeof window !== 'undefined' ? window : globalThis, function liveParcelFabricFactory() {
    'use strict';

    function clone(value) {
        if (value === undefined || value === null) return value;
        if (typeof structuredClone === 'function') {
            try { return structuredClone(value); } catch (_) { /* JSON fallback */ }
        }
        return JSON.parse(JSON.stringify(value));
    }

    function normalizeId(value) {
        if (value === undefined || value === null) return '';
        return String(value).trim();
    }

    function featureId(feature) {
        const props = feature && feature.properties;
        return normalizeId(props && (props.parcelId ?? props.parcel_id ?? props.PARCEL_ID ?? props.id));
    }

    function explicitCadastreIds(feature) {
        const props = feature && feature.properties || {};
        const raw = Array.isArray(props.cadastreParcelIds) ? props.cadastreParcelIds : [];
        return Array.from(new Set(raw.map(normalizeId).filter(Boolean)));
    }

    function producerId(feature) {
        const props = feature && feature.properties || {};
        return normalizeId(props.producedByProposalId || '');
    }

    function bboxOf(feature) {
        const coordinates = feature && feature.geometry && feature.geometry.coordinates;
        if (!Array.isArray(coordinates)) return null;
        let west = Infinity;
        let south = Infinity;
        let east = -Infinity;
        let north = -Infinity;
        const visit = value => {
            if (!Array.isArray(value)) return;
            if (value.length >= 2 && Number.isFinite(Number(value[0])) && Number.isFinite(Number(value[1]))) {
                const x = Number(value[0]);
                const y = Number(value[1]);
                west = Math.min(west, x);
                east = Math.max(east, x);
                south = Math.min(south, y);
                north = Math.max(north, y);
                return;
            }
            value.forEach(visit);
        };
        visit(coordinates);
        return Number.isFinite(west) ? [west, south, east, north] : null;
    }

    function normalizedFeature(input) {
        if (!input || input.type !== 'Feature' || !input.geometry || !/Polygon$/.test(String(input.geometry.type || ''))) {
            const error = new TypeError('Live parcel fabric accepts polygon GeoJSON Features only.');
            error.code = 'invalid-live-parcel-feature';
            throw error;
        }
        const feature = clone(input);
        if (feature.geometry.type === 'MultiPolygon') {
            const components = Array.isArray(feature.geometry.coordinates)
                ? feature.geometry.coordinates.filter(Array.isArray)
                : [];
            if (components.length !== 1) {
                const disconnected = new TypeError('One live parcel must be one connected polygon.');
                disconnected.code = 'live-parcel-disconnected';
                disconnected.parcelId = featureId(feature) || null;
                disconnected.components = components.length;
                throw disconnected;
            }
            feature.geometry = { type: 'Polygon', coordinates: components[0] };
        }
        const id = featureId(feature);
        if (!id) {
            const error = new TypeError('Live parcel feature has no parcelId.');
            error.code = 'live-parcel-id-missing';
            throw error;
        }
        const cadastreIds = explicitCadastreIds(feature);
        if (!cadastreIds.length) {
            const error = new TypeError(`Generated live parcel ${id} has no explicit cadastral provenance.`);
            error.code = 'live-parcel-provenance-missing';
            error.parcelId = id;
            throw error;
        }
        const props = feature.properties || (feature.properties = {});
        props.parcelId = id;
        props.id = id;
        props.cadastreParcelIds = cadastreIds.slice();
        // Authored/content features use `proposalId`; a live parcel instead has one explicit
        // materialization owner. Keeping both recreated the retired ancestry model.
        delete props.proposalId;
        delete props.baseParcelIds;
        delete props.parentParcelIds;
        delete props.parentParcelId;
        delete props.ancestorProposal;
        return feature;
    }

    function connectedFeatures(input, options = {}) {
        let source = input;
        if (options.cadastreSeed === true) {
            source = clone(input);
            const sourceId = featureId(source);
            if (!sourceId) {
                const error = new Error('Cadastral seed has no parcelId.');
                error.code = 'cadastral-seed-id-missing';
                throw error;
            }
            const props = source.properties || (source.properties = {});
            props.parcelId = sourceId;
            props.id = sourceId;
            props.cadastreParcelIds = [sourceId];
        }
        const geometry = source && source.geometry;
        const components = geometry?.type === 'MultiPolygon' && Array.isArray(geometry.coordinates)
            ? geometry.coordinates.filter(Array.isArray)
            : null;
        if (!components || components.length <= 1) return [normalizedFeature(source)];

        if (options.cadastreSeed !== true) return [normalizedFeature(source)];
        const sourceId = featureId(source);

        const ordered = components.map(coordinates => ({
            coordinates,
            box: bboxOf({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates } })
        })).sort((left, right) => {
            for (let index = 0; index < 4; index += 1) {
                const delta = Number(left.box?.[index]) - Number(right.box?.[index]);
                if (Number.isFinite(delta) && delta !== 0) return delta;
            }
            return JSON.stringify(left.coordinates).localeCompare(JSON.stringify(right.coordinates));
        });

        return ordered.map((component, index) => {
            const feature = clone(source);
            const id = `${sourceId}#cadastre-${index + 1}`;
            feature.geometry = { type: 'Polygon', coordinates: component.coordinates };
            feature.properties = {
                ...(feature.properties || {}),
                parcelId: id,
                id,
                cadastreParcelIds: [sourceId],
                cadastralPart: true,
                cadastralPartIndex: index + 1
            };
            return normalizedFeature(feature);
        });
    }

    function stateFrom(features, revision) {
        const byId = new Map();
        const bboxById = new Map();
        const byCadastreId = new Map();
        const byProducerId = new Map();
        for (const raw of features || []) {
            const feature = normalizedFeature(raw);
            const id = featureId(feature);
            if (byId.has(id)) {
                const error = new Error(`Live parcel fabric contains duplicate id ${id}.`);
                error.code = 'duplicate-live-parcel-id';
                throw error;
            }
            byId.set(id, feature);
            bboxById.set(id, bboxOf(feature));
            explicitCadastreIds(feature).forEach(cadastralId => {
                let ids = byCadastreId.get(cadastralId);
                if (!ids) {
                    ids = new Set();
                    byCadastreId.set(cadastralId, ids);
                }
                ids.add(id);
            });
            const producer = producerId(feature);
            if (producer) {
                let ids = byProducerId.get(producer);
                if (!ids) {
                    ids = new Set();
                    byProducerId.set(producer, ids);
                }
                ids.add(id);
            }
        }
        return { revision, byId, bboxById, byCadastreId, byProducerId };
    }

    function boundsArray(bounds) {
        if (Array.isArray(bounds) && bounds.length >= 4) return bounds.map(Number);
        if (!bounds || typeof bounds.getSouthWest !== 'function' || typeof bounds.getNorthEast !== 'function') return null;
        const sw = bounds.getSouthWest();
        const ne = bounds.getNorthEast();
        return [Number(sw.lng), Number(sw.lat), Number(ne.lng), Number(ne.lat)];
    }

    function intersects(left, right) {
        return !!left && !!right
            && left[0] <= right[2] && left[2] >= right[0]
            && left[1] <= right[3] && left[3] >= right[1];
    }

    function createLiveParcelFabric(options = {}) {
        let committed = stateFrom([], 0);
        let active = null;
        const subscribers = new Set();
        const participants = new Set();

        // Ordinary readers see only the committed revision. Domain code participating in a
        // mutation may opt into that mutation's private draft with its exact transaction token.
        // This is the isolation boundary that keeps clicks and pans on the old complete fabric
        // until the new complete fabric and its presentation commit together.
        const readable = options => {
            const token = options && options.transaction;
            if (!token) return committed;
            assertTransaction(token);
            return active.state;
        };

        function beginTransaction(meta = {}) {
            if (active) {
                const error = new Error('A live parcel fabric transaction is already active.');
                error.code = 'live-fabric-transaction-active';
                throw error;
            }
            const token = Object.freeze({
                id: normalizeId(meta.id) || `fabric-${committed.revision + 1}`,
                baseRevision: committed.revision
            });
            active = {
                token,
                state: stateFrom(Array.from(committed.byId.values()), committed.revision),
                changedIds: new Set()
            };
            return token;
        }

        function assertTransaction(token) {
            if (!active || active.token !== token) {
                const error = new Error('Live parcel fabric mutation requires its active transaction token.');
                error.code = 'live-fabric-transaction-mismatch';
                throw error;
            }
        }

        function rebuildDraft(features) {
            active.state = stateFrom(features, committed.revision);
        }

        function upsertFeatures(features, mutation = {}) {
            const token = mutation.transaction;
            assertTransaction(token);
            const next = new Map(active.state.byId);
            for (const raw of Array.isArray(features) ? features : []) {
                for (const feature of connectedFeatures(raw)) {
                    const id = featureId(feature);
                    if (mutation.replaceExisting === false && next.has(id)) continue;
                    next.set(id, feature);
                    active.changedIds.add(id);
                }
            }
            rebuildDraft(Array.from(next.values()));
            return Array.from(active.changedIds);
        }

        function removeIds(ids, mutation = {}) {
            const token = mutation.transaction;
            assertTransaction(token);
            const next = new Map(active.state.byId);
            const removed = [];
            for (const raw of ids || []) {
                const id = normalizeId(raw);
                if (!id || !next.delete(id)) continue;
                active.changedIds.add(id);
                removed.push(id);
            }
            rebuildDraft(Array.from(next.values()));
            return removed;
        }

        function replaceCadastreScope(cadastreIds, features, mutation = {}) {
            const token = mutation.transaction;
            assertTransaction(token);
            const scope = new Set(Array.from(cadastreIds || []).map(normalizeId).filter(Boolean));
            const next = [];
            active.state.byId.forEach(feature => {
                const occupiedCadastreIds = explicitCadastreIds(feature);
                const occupiesScope = occupiedCadastreIds.some(id => scope.has(id));
                const escapesScope = occupiesScope && occupiedCadastreIds.some(id => !scope.has(id));
                if (escapesScope) {
                    const error = new Error(
                        `Cadastral replacement scope is not closed: ${featureId(feature)} also occupies `
                        + occupiedCadastreIds.filter(id => !scope.has(id)).join(', ')
                    );
                    error.code = 'live-fabric-scope-not-closed';
                    error.parcelId = featureId(feature);
                    error.requestedCadastreIds = Array.from(scope);
                    error.requiredCadastreIds = occupiedCadastreIds.slice();
                    throw error;
                }
                if (!occupiesScope) next.push(feature);
                else active.changedIds.add(featureId(feature));
            });
            for (const raw of Array.isArray(features) ? features : []) {
              for (const feature of connectedFeatures(raw)) {
                const bases = explicitCadastreIds(feature);
                if (!bases.every(id => scope.has(id))) {
                    const error = new Error(`Replacement parcel ${featureId(feature)} lies outside the requested cadastral scope.`);
                    error.code = 'live-fabric-scope-violation';
                    throw error;
                }
                next.push(feature);
                active.changedIds.add(featureId(feature));
              }
            }
            rebuildDraft(next);
            return Array.from(active.changedIds);
        }

        function replaceAll(features, mutation = {}) {
            const token = mutation.transaction;
            assertTransaction(token);
            active.state.byId.forEach((_feature, id) => active.changedIds.add(id));
            const normalized = (Array.isArray(features) ? features : []).flatMap(connectedFeatures);
            normalized.forEach(feature => active.changedIds.add(featureId(feature)));
            rebuildDraft(normalized);
            return Array.from(active.changedIds);
        }

        function seedCadastre(features, mutation = {}) {
            const token = mutation.transaction;
            assertTransaction(token);
            const next = new Map(active.state.byId);
            for (const raw of Array.isArray(features) ? features : []) {
                const sourceId = featureId(raw);
                if (!sourceId) {
                    const error = new Error('Repository seed has no cadastral parcel id.');
                    error.code = 'cadastral-seed-id-missing';
                    throw error;
                }
                const currentlyOccupied = active.state.byCadastreId.get(sourceId);
                if (currentlyOccupied && currentlyOccupied.size) continue;
                for (const feature of connectedFeatures(raw, { cadastreSeed: true })) {
                    const id = featureId(feature);
                    next.set(id, feature);
                    active.changedIds.add(id);
                }
            }
            rebuildDraft(Array.from(next.values()));
            return Array.from(active.changedIds);
        }

        function changeSet(nextState, changedIds) {
            const added = [];
            const removed = [];
            const updated = [];
            const ids = new Set(changedIds || []);
            committed.byId.forEach((_feature, id) => {
                if (!nextState.byId.has(id)) ids.add(id);
            });
            nextState.byId.forEach((_feature, id) => {
                if (!committed.byId.has(id)) ids.add(id);
            });
            ids.forEach(id => {
                const before = committed.byId.get(id) || null;
                const after = nextState.byId.get(id) || null;
                if (!before && after) added.push(clone(after));
                else if (before && !after) removed.push(id);
                else if (before && after && JSON.stringify(before) !== JSON.stringify(after)) updated.push(clone(after));
            });
            return Object.freeze({
                fromRevision: committed.revision,
                toRevision: committed.revision + 1,
                added: Object.freeze(added),
                updated: Object.freeze(updated),
                removed: Object.freeze(removed),
                features: Object.freeze(Array.from(nextState.byId.values(), clone))
            });
        }

        async function commit(token) {
            assertTransaction(token);
            const draft = active;
            const nextState = stateFrom(Array.from(draft.state.byId.values()), committed.revision + 1);
            const change = changeSet(nextState, draft.changedIds);
            const prepared = [];
            const previousState = committed;
            try {
                for (const participant of participants) {
                    const value = typeof participant.prepare === 'function'
                        ? await participant.prepare(change)
                        : change;
                    prepared.push({ participant, value });
                }
                // Preparation may be asynchronous while every reader still sees the old revision.
                // Publication and projection swap are then one synchronous critical section: event
                // handlers invoked by a presenter commit already read the new committed fabric.
                committed = nextState;
                active = null;
                for (const entry of prepared) {
                    if (typeof entry.participant.commit === 'function') {
                        const result = entry.participant.commit(entry.value, change);
                        if (result && typeof result.then === 'function') {
                            committed = previousState;
                            throw new Error('Live-fabric participant commit must be synchronous after prepare.');
                        }
                    }
                }
            } catch (error) {
                // `committed` may already have been published for the synchronous swap. Restore the
                // previous immutable state before rolling presentation participants back.
                if (committed === nextState) committed = previousState;
                for (let index = prepared.length - 1; index >= 0; index -= 1) {
                    const entry = prepared[index];
                    try {
                        if (typeof entry.participant.rollback === 'function') {
                            const result = entry.participant.rollback(entry.value, change);
                            if (result && typeof result.then === 'function') {
                                throw new Error('Live-fabric participant rollback must be synchronous.');
                            }
                        }
                    } catch (_) { /* preserve primary failure */ }
                }
                active = null;
                throw error;
            }
            subscribers.forEach(listener => {
                try { listener(change); } catch (error) { console.error('[LiveParcelFabric] subscriber failed', error); }
            });
            return change;
        }

        function rollback(token) {
            assertTransaction(token);
            active = null;
            return true;
        }

        async function transact(meta, operation) {
            const token = beginTransaction(meta);
            try {
                const result = await operation(token);
                if (result === false) {
                    rollback(token);
                    return false;
                }
                await commit(token);
                return result;
            } catch (error) {
                if (active && active.token === token) rollback(token);
                throw error;
            }
        }

        function get(id, options = {}) {
            const feature = readable(options).byId.get(normalizeId(id));
            return feature ? clone(feature) : null;
        }

        function getMany(ids, options = {}) {
            const found = [];
            const missingIds = [];
            const seen = new Set();
            for (const raw of ids || []) {
                const id = normalizeId(raw);
                if (!id || seen.has(id)) continue;
                seen.add(id);
                const feature = readable(options).byId.get(id);
                if (feature) found.push(clone(feature));
                else missingIds.push(id);
            }
            if (missingIds.length && options.allowMissing !== true) {
                const error = new Error(`Live parcel fabric is missing: ${missingIds.join(', ')}`);
                error.code = 'live-parcel-missing';
                error.missingIds = missingIds;
                throw error;
            }
            return { features: found, missingIds };
        }

        function list(options = {}) {
            return Array.from(readable(options).byId.values(), clone);
        }

        function entriesForCadastre(ids, options = {}) {
            const state = readable(options);
            const wanted = new Set(Array.from(ids || []).map(normalizeId).filter(Boolean));
            const parcelIds = new Set();
            wanted.forEach(id => {
                const members = state.byCadastreId.get(id);
                if (members) members.forEach(parcelId => parcelIds.add(parcelId));
            });
            return Array.from(parcelIds)
                .map(id => state.byId.get(id))
                .filter(feature => options.includeCorridors === true || !isCorridor(feature))
                .map(clone);
        }

        function isCorridor(feature) {
            const props = feature && feature.properties || {};
            return props.isCorridor === true || props.isRoad === true || props.isTrack === true;
        }

        function producedBy(proposalId, options = {}) {
            const state = readable(options);
            const ids = state.byProducerId.get(normalizeId(proposalId));
            return ids ? Array.from(ids, id => clone(state.byId.get(id))) : [];
        }

        function queryBounds(bounds, options = {}) {
            const box = boundsArray(bounds);
            if (!box) return [];
            const result = [];
            const state = readable(options);
            state.byId.forEach((feature, id) => {
                if (!intersects(box, state.bboxById.get(id))) return;
                if (options.includeCorridors !== true && isCorridor(feature)) return;
                result.push(clone(feature));
            });
            return result;
        }

        function claimedCadastreIds(options = {}) {
            const claimed = new Set();
            const state = readable(options);
            state.byId.forEach(feature => {
                const id = featureId(feature);
                const bases = explicitCadastreIds(feature);
                const props = feature && feature.properties || {};
                const isProduced = !!producerId(feature) || props.cadastralPart === true
                    || bases.length !== 1 || bases[0] !== id;
                if (isProduced) bases.forEach(base => claimed.add(base));
            });
            return claimed;
        }

        function cadastreIdsForParcelIds(ids, options = {}) {
            const state = readable(options);
            const result = [];
            const seen = new Set();
            const append = value => {
                const id = normalizeId(value);
                if (!id || seen.has(id)) return;
                seen.add(id);
                result.push(id);
            };
            Array.from(ids || []).forEach(value => {
                const id = normalizeId(value);
                if (!id) return;
                const feature = state.byId.get(id);
                if (feature) {
                    explicitCadastreIds(feature).forEach(append);
                    return;
                }
                if (state.byCadastreId.has(id)) {
                    append(id);
                    return;
                }
                if (options.allowMissing === true) return;
                const error = new Error(`Live parcel fabric cannot resolve cadastral provenance for ${id}.`);
                error.code = 'live-parcel-provenance-unavailable';
                error.parcelId = id;
                throw error;
            });
            return result;
        }

        function subscribe(listener) {
            if (typeof listener !== 'function') return () => {};
            subscribers.add(listener);
            return () => subscribers.delete(listener);
        }

        function addCommitParticipant(participant) {
            if (!participant || typeof participant !== 'object') throw new TypeError('Commit participant must be an object.');
            participants.add(participant);
            return () => participants.delete(participant);
        }

        function snapshot(options = {}) {
            const state = readable(options);
            return {
                revision: state.revision,
                featureCount: state.byId.size,
                parcelIds: Array.from(state.byId.keys()),
                transactionActive: !!active
            };
        }

        function currentTransaction() {
            return active ? active.token : null;
        }

        return Object.freeze({
            beginTransaction,
            upsertFeatures,
            removeIds,
            replaceCadastreScope,
            replaceAll,
            seedCadastre,
            commit,
            rollback,
            transact,
            get,
            getMany,
            list,
            entriesForCadastre,
            producedBy,
            queryBounds,
            claimedCadastreIds,
            cadastreIdsForParcelIds,
            subscribe,
            addCommitParticipant,
            snapshot,
            currentTransaction,
            featureId,
            explicitCadastreIds
        });
    }

    return { createLiveParcelFabric, featureId, explicitCadastreIds };
});
