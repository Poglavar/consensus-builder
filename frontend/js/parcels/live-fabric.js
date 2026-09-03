// Authoritative in-memory parcel fabric. Cadastral facts stay immutable; authored materialization
// exists only in a private mutation draft and is published as one revision.
(function attachLiveParcelFabric(root, factory) {
    const api = factory(root || globalThis);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) {
        root.createLiveParcelFabric = api.createLiveParcelFabric;
        root.LiveParcelFabric = api.createLiveParcelFabric();
    }
})(typeof window !== 'undefined' ? window : globalThis, function liveParcelFabricFactory(root) {
    'use strict';

    const GEOMETRY_EPSILON_M2 = 0.01;

    function clone(value) {
        if (value === undefined || value === null) return value;
        if (typeof structuredClone === 'function') {
            try { return structuredClone(value); } catch (_) { /* JSON fallback */ }
        }
        return JSON.parse(JSON.stringify(value));
    }

    function deepFreeze(value, seen = new WeakSet()) {
        if (!value || typeof value !== 'object' || seen.has(value)) return value;
        seen.add(value);
        Object.getOwnPropertyNames(value).forEach(key => deepFreeze(value[key], seen));
        return Object.freeze(value);
    }

    function normalizeId(value) {
        return value === undefined || value === null ? '' : String(value).trim();
    }

    function featureId(feature) {
        const props = feature && feature.properties;
        return normalizeId(props && (props.parcelId ?? props.parcel_id ?? props.PARCEL_ID ?? props.id));
    }

    function explicitCadastreIds(feature) {
        const raw = Array.isArray(feature?.properties?.cadastreParcelIds)
            ? feature.properties.cadastreParcelIds
            : [];
        return Array.from(new Set(raw.map(normalizeId).filter(Boolean)));
    }

    function producerId(feature) {
        return normalizeId(feature?.properties?.producedByProposalId);
    }

    function formedByIds(feature) {
        const raw = Array.isArray(feature?.properties?.formedByProposalIds)
            ? feature.properties.formedByProposalIds
            : [];
        return Array.from(new Set(raw.map(normalizeId).filter(Boolean)));
    }

    function bboxOf(feature) {
        const coordinates = feature?.geometry?.coordinates;
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
                south = Math.min(south, y);
                east = Math.max(east, x);
                north = Math.max(north, y);
                return;
            }
            value.forEach(visit);
        };
        visit(coordinates);
        return Number.isFinite(west) ? Object.freeze([west, south, east, north]) : null;
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

    function isCorridor(feature) {
        const props = feature?.properties || {};
        return props.isCorridor === true || props.isRoad === true || props.isTrack === true;
    }

    function resolveGeometryApi(options) {
        if (options.geometry) return options.geometry;
        if (root?.turf) return root.turf;
        if (typeof require === 'function') {
            try { return require('@turf/turf'); } catch (_) {
                // Unit tests load this browser module from the repository root while Turf belongs
                // to the backend package. Production always takes the root.turf branch above.
                try { return require('../../../backend/node_modules/@turf/turf'); }
                catch (_) { /* caller receives explicit error */ }
            }
        }
        return null;
    }

    function createLiveParcelFabric(options = {}) {
        const geometry = resolveGeometryApi(options);
        const trusted = new WeakSet();
        const subscribers = new Set();
        const participants = new Set();
        const metrics = { normalized: 0, indexUpdates: 0 };
        let active = null;
        let committed = {
            revision: 0,
            byId: new Map(),
            bboxById: new Map(),
            byCadastreId: new Map(),
            byProducerId: new Map(),
            cadastreFacts: new Map()
        };

        function normalizeFeature(input, config = {}) {
            if (trusted.has(input)) return input;
            if (!input || input.type !== 'Feature' || !input.geometry || !/Polygon$/.test(String(input.geometry.type || ''))) {
                const error = new TypeError('Live parcel fabric accepts polygon GeoJSON Features only.');
                error.code = 'invalid-live-parcel-feature';
                throw error;
            }
            const feature = clone(input);
            const sourceId = featureId(feature);
            if (!sourceId) {
                const error = new TypeError(config.cadastreSeed
                    ? 'Cadastral seed has no parcelId.'
                    : 'Live parcel feature has no parcelId.');
                error.code = config.cadastreSeed ? 'cadastral-seed-id-missing' : 'live-parcel-id-missing';
                throw error;
            }
            if (feature.geometry.type === 'MultiPolygon') {
                const components = Array.isArray(feature.geometry.coordinates)
                    ? feature.geometry.coordinates.filter(Array.isArray)
                    : [];
                if (components.length !== 1) {
                    const error = new TypeError('One live parcel must be one connected polygon.');
                    error.code = 'live-parcel-disconnected';
                    error.parcelId = sourceId;
                    error.components = components.length;
                    throw error;
                }
                feature.geometry = { type: 'Polygon', coordinates: components[0] };
            }
            const props = feature.properties || (feature.properties = {});
            const cadastreIds = config.cadastreSeed ? [normalizeId(config.cadastreId || sourceId)] : explicitCadastreIds(feature);
            if (!cadastreIds.length) {
                const error = new TypeError(`Generated live parcel ${sourceId} has no explicit cadastral provenance.`);
                error.code = 'live-parcel-provenance-missing';
                error.parcelId = sourceId;
                throw error;
            }
            props.parcelId = sourceId;
            props.id = sourceId;
            props.cadastreParcelIds = cadastreIds;
            if (formedByIds(feature).length) props.formedByProposalIds = formedByIds(feature);
            else delete props.formedByProposalIds;
            delete props.proposalId;
            delete props.baseParcelIds;
            delete props.parentParcelIds;
            delete props.parentParcelId;
            delete props.ancestorProposal;
            metrics.normalized += 1;
            deepFreeze(feature);
            trusted.add(feature);
            return feature;
        }

        function connectedFeatures(input, config = {}) {
            const geometryValue = input?.geometry;
            const components = geometryValue?.type === 'MultiPolygon' && Array.isArray(geometryValue.coordinates)
                ? geometryValue.coordinates.filter(Array.isArray)
                : null;
            if (!components || components.length <= 1) return [normalizeFeature(input, config)];
            if (!config.cadastreSeed) return [normalizeFeature(input, config)];

            const cadastralId = featureId(input);
            if (!cadastralId) return [normalizeFeature(input, config)];
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
            return ordered.map((component, index) => normalizeFeature({
                ...input,
                properties: {
                    ...(input.properties || {}),
                    parcelId: `${cadastralId}#cadastre-${index + 1}`,
                    id: `${cadastralId}#cadastre-${index + 1}`,
                    cadastralPart: true,
                    cadastralPartIndex: index + 1
                },
                geometry: { type: 'Polygon', coordinates: component.coordinates }
            }, { cadastreSeed: true, cadastreId: cadastralId }));
        }

        function normalizeCadastreFact(input) {
            if (!input || input.type !== 'Feature' || !input.geometry || !/Polygon$/.test(String(input.geometry.type || ''))) {
                const error = new TypeError('Cadastral repository supplied an invalid polygon feature.');
                error.code = 'invalid-cadastral-feature';
                throw error;
            }
            const id = featureId(input);
            if (!id) {
                const error = new Error('Repository seed has no cadastral parcel id.');
                error.code = 'cadastral-seed-id-missing';
                throw error;
            }
            const fact = clone(input);
            const props = fact.properties || (fact.properties = {});
            props.parcelId = id;
            props.id = id;
            props.cadastreParcelIds = [id];
            return deepFreeze(fact);
        }

        function assertActive(draft) {
            if (!active || active !== draft || draft.state !== 'active') {
                const error = new Error('Live parcel fabric mutation is no longer active.');
                error.code = 'live-fabric-mutation-inactive';
                throw error;
            }
        }

        function mutableIndexSet(draft, indexName, key) {
            const index = draft.data[indexName];
            let values = index.get(key);
            if (!values) {
                values = new Set();
                index.set(key, values);
            } else if (values === committed[indexName].get(key)) {
                values = new Set(values);
                index.set(key, values);
            }
            return values;
        }

        function removeFromIndex(draft, indexName, key, id) {
            const values = draft.data[indexName].get(key);
            if (!values || !values.has(id)) return;
            const mutable = mutableIndexSet(draft, indexName, key);
            mutable.delete(id);
            if (!mutable.size) draft.data[indexName].delete(key);
            metrics.indexUpdates += 1;
        }

        function addToIndex(draft, indexName, key, id) {
            const values = mutableIndexSet(draft, indexName, key);
            if (values.has(id)) return;
            values.add(id);
            metrics.indexUpdates += 1;
        }

        function noteCadastre(draft, feature) {
            explicitCadastreIds(feature).forEach(id => draft.changedCadastreIds.add(id));
        }

        function removeOne(draft, id) {
            const before = draft.data.byId.get(id);
            if (!before) return null;
            draft.data.byId.delete(id);
            draft.data.bboxById.delete(id);
            explicitCadastreIds(before).forEach(key => removeFromIndex(draft, 'byCadastreId', key, id));
            const producer = producerId(before);
            if (producer) removeFromIndex(draft, 'byProducerId', producer, id);
            draft.changedIds.add(id);
            noteCadastre(draft, before);
            return before;
        }

        function putOne(draft, feature, replaceExisting = true) {
            const id = featureId(feature);
            const before = draft.data.byId.get(id);
            if (before && !replaceExisting) return false;
            if (before) removeOne(draft, id);
            draft.data.byId.set(id, feature);
            draft.data.bboxById.set(id, bboxOf(feature));
            explicitCadastreIds(feature).forEach(key => addToIndex(draft, 'byCadastreId', key, id));
            const producer = producerId(feature);
            if (producer) addToIndex(draft, 'byProducerId', producer, id);
            draft.changedIds.add(id);
            noteCadastre(draft, feature);
            return true;
        }

        function unionAll(features) {
            if (!geometry?.union || !geometry?.area || !geometry?.difference || !geometry?.intersect) {
                const error = new Error('Geometry operations are required to validate a cadastral replacement.');
                error.code = 'live-fabric-geometry-unavailable';
                throw error;
            }
            let merged = null;
            for (const feature of features) merged = merged ? geometry.union(merged, feature) : feature;
            return merged;
        }

        function measuredArea(feature) {
            return feature ? Math.max(0, Number(geometry.area(feature)) || 0) : 0;
        }

        function differenceArea(left, right) {
            if (!left) return 0;
            if (!right) return measuredArea(left);
            return measuredArea(geometry.difference(left, right));
        }

        function validateReplacement(draft, scope, replacements) {
            if (!scope.size) {
                const error = new Error('Cadastral replacement scope cannot be empty.');
                error.code = 'live-fabric-scope-empty';
                throw error;
            }
            if (!replacements.length) {
                const error = new Error('A cadastral replacement must contain at least one live parcel.');
                error.code = 'live-fabric-empty-replacement';
                throw error;
            }
            const replacementIds = new Set();
            replacements.forEach(feature => {
                const id = featureId(feature);
                if (replacementIds.has(id)) {
                    const error = new Error(`Cadastral replacement contains duplicate id ${id}.`);
                    error.code = 'duplicate-live-parcel-id';
                    throw error;
                }
                replacementIds.add(id);
                const provenance = explicitCadastreIds(feature);
                if (!provenance.length || !provenance.every(value => scope.has(value))) {
                    const error = new Error(`Replacement parcel ${id} has provenance outside the requested cadastral scope.`);
                    error.code = 'live-fabric-scope-violation';
                    error.parcelId = id;
                    throw error;
                }
            });
            for (let left = 0; left < replacements.length; left += 1) {
                for (let right = left + 1; right < replacements.length; right += 1) {
                    if (!intersects(bboxOf(replacements[left]), bboxOf(replacements[right]))) continue;
                    const overlap = geometry.intersect(replacements[left], replacements[right]);
                    const overlapM2 = measuredArea(overlap);
                    if (overlapM2 > GEOMETRY_EPSILON_M2) {
                        const error = new Error(`Replacement parcels overlap by ${overlapM2.toFixed(3)} m².`);
                        error.code = 'live-fabric-replacement-overlap';
                        error.overlapM2 = overlapM2;
                        throw error;
                    }
                }
            }
            const facts = Array.from(scope, id => draft.data.cadastreFacts.get(id));
            const missing = Array.from(scope).filter((_id, index) => !facts[index]);
            if (missing.length) {
                const error = new Error(`Immutable cadastral ground is missing for: ${missing.join(', ')}.`);
                error.code = 'live-fabric-cadastre-facts-missing';
                error.missingIds = missing;
                throw error;
            }
            const cadastralUnion = unionAll(facts);
            const replacementUnion = unionAll(replacements);
            const outsideM2 = differenceArea(replacementUnion, cadastralUnion);
            const missingM2 = differenceArea(cadastralUnion, replacementUnion);
            const symmetricDifferenceM2 = outsideM2 + missingM2;
            if (outsideM2 > GEOMETRY_EPSILON_M2) {
                const error = new Error(`Replacement lies ${outsideM2.toFixed(3)} m² outside immutable cadastral ground.`);
                error.code = 'live-fabric-replacement-outside';
                error.outsideM2 = outsideM2;
                throw error;
            }
            if (missingM2 > GEOMETRY_EPSILON_M2) {
                const error = new Error(`Replacement leaves ${missingM2.toFixed(3)} m² of cadastral ground uncovered.`);
                error.code = 'live-fabric-replacement-hole';
                error.missingM2 = missingM2;
                throw error;
            }
            if (symmetricDifferenceM2 > GEOMETRY_EPSILON_M2) {
                const error = new Error(`Replacement symmetric difference is ${symmetricDifferenceM2.toFixed(3)} m².`);
                error.code = 'live-fabric-replacement-mismatch';
                error.symmetricDifferenceM2 = symmetricDifferenceM2;
                throw error;
            }
        }

        function readFrom(data, id) {
            const feature = data.byId.get(normalizeId(id));
            return feature ? clone(feature) : null;
        }

        function getManyFrom(data, ids, query = {}) {
            const features = [];
            const missingIds = [];
            const seen = new Set();
            Array.from(ids || []).forEach(raw => {
                const id = normalizeId(raw);
                if (!id || seen.has(id)) return;
                seen.add(id);
                const feature = data.byId.get(id);
                if (feature) features.push(clone(feature));
                else missingIds.push(id);
            });
            if (missingIds.length && query.allowMissing !== true) {
                const error = new Error(`Live parcel fabric is missing: ${missingIds.join(', ')}`);
                error.code = 'live-parcel-missing';
                error.missingIds = missingIds;
                throw error;
            }
            return { features, missingIds };
        }

        function entriesForCadastreFrom(data, ids, query = {}) {
            const parcelIds = new Set();
            Array.from(ids || []).map(normalizeId).filter(Boolean).forEach(id => {
                data.byCadastreId.get(id)?.forEach(parcelId => parcelIds.add(parcelId));
            });
            return Array.from(parcelIds)
                .map(id => data.byId.get(id))
                .filter(feature => query.includeCorridors === true || !isCorridor(feature))
                .map(clone);
        }

        function queryBoundsFrom(data, bounds, query = {}) {
            const box = boundsArray(bounds);
            if (!box) return [];
            const result = [];
            data.byId.forEach((feature, id) => {
                if (!intersects(box, data.bboxById.get(id))) return;
                if (query.includeCorridors !== true && isCorridor(feature)) return;
                result.push(clone(feature));
            });
            return result;
        }

        function cadastreIdsForParcelIdsFrom(data, ids, query = {}) {
            const result = [];
            const seen = new Set();
            const append = raw => {
                const id = normalizeId(raw);
                if (!id || seen.has(id)) return;
                seen.add(id);
                result.push(id);
            };
            Array.from(ids || []).forEach(raw => {
                const id = normalizeId(raw);
                if (!id) return;
                const feature = data.byId.get(id);
                if (feature) return explicitCadastreIds(feature).forEach(append);
                if (data.byCadastreId.has(id) || data.cadastreFacts.has(id)) return append(id);
                if (query.allowMissing === true) return;
                const error = new Error(`Live parcel fabric cannot resolve cadastral provenance for ${id}.`);
                error.code = 'live-parcel-provenance-unavailable';
                error.parcelId = id;
                throw error;
            });
            return result;
        }

        function deltaFor(draft) {
            const addedIds = [];
            const updatedIds = [];
            const removedIds = [];
            draft.changedIds.forEach(id => {
                const before = committed.byId.get(id);
                const after = draft.data.byId.get(id);
                if (!before && after) addedIds.push(id);
                else if (before && !after) removedIds.push(id);
                else if (before !== after) updatedIds.push(id);
            });
            const sort = values => Object.freeze(values.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })));
            return Object.freeze({
                revision: committed.revision + 1,
                fromRevision: committed.revision,
                addedIds: sort(addedIds),
                updatedIds: sort(updatedIds),
                removedIds: sort(removedIds),
                changedCadastreIds: sort(Array.from(draft.changedCadastreIds))
            });
        }

        function participantView(draft) {
            return Object.freeze({
                get: id => readFrom(draft.data, id),
                getMany: (ids, query) => getManyFrom(draft.data, ids, query),
                list: () => Array.from(draft.data.byId.values(), clone),
                snapshot: () => ({ revision: committed.revision + 1, parcelIds: Array.from(draft.data.byId.keys()) })
            });
        }

        function beginMutation(meta = {}) {
            if (active) {
                const error = new Error('A live parcel fabric mutation is already active.');
                error.code = 'live-fabric-transaction-active';
                throw error;
            }
            const draft = {
                meta: Object.freeze({ ...meta }),
                state: 'active',
                data: {
                    revision: committed.revision,
                    byId: new Map(committed.byId),
                    bboxById: new Map(committed.bboxById),
                    byCadastreId: new Map(committed.byCadastreId),
                    byProducerId: new Map(committed.byProducerId),
                    cadastreFacts: new Map(committed.cadastreFacts)
                },
                changedIds: new Set(),
                changedCadastreIds: new Set(),
                prepared: [],
                delta: null
            };
            active = draft;

            const mutation = {
                seedCadastre(features) {
                    assertActive(draft);
                    for (const raw of Array.isArray(features) ? features : []) {
                        const fact = normalizeCadastreFact(raw);
                        const cadastralId = featureId(fact);
                        const existingFact = draft.data.cadastreFacts.get(cadastralId);
                        if (existingFact && JSON.stringify(existingFact.geometry) !== JSON.stringify(fact.geometry)) {
                            const error = new Error(`Conflicting immutable cadastral geometry for ${cadastralId}.`);
                            error.code = 'cadastral-geometry-conflict';
                            throw error;
                        }
                        if (!existingFact) draft.data.cadastreFacts.set(cadastralId, fact);
                        if (draft.data.byCadastreId.get(cadastralId)?.size) continue;
                        connectedFeatures(raw, { cadastreSeed: true }).forEach(feature => putOne(draft, feature));
                    }
                    return Array.from(draft.changedIds);
                },
                upsertFeatures(features, config = {}) {
                    assertActive(draft);
                    for (const raw of Array.isArray(features) ? features : []) {
                        connectedFeatures(raw).forEach(feature => putOne(draft, feature, config.replaceExisting !== false));
                    }
                    return Array.from(draft.changedIds);
                },
                removeIds(ids) {
                    assertActive(draft);
                    return Array.from(ids || []).map(normalizeId).filter(id => !!removeOne(draft, id));
                },
                replaceCadastreScope(cadastreIds, features) {
                    assertActive(draft);
                    const scope = new Set(Array.from(cadastreIds || []).map(normalizeId).filter(Boolean));
                    draft.data.byId.forEach(feature => {
                        const occupied = explicitCadastreIds(feature);
                        if (!occupied.some(id => scope.has(id))) return;
                        const escaped = occupied.filter(id => !scope.has(id));
                        if (!escaped.length) return;
                        const error = new Error(`Cadastral replacement scope is not closed: ${featureId(feature)} also occupies ${escaped.join(', ')}`);
                        error.code = 'live-fabric-scope-not-closed';
                        error.parcelId = featureId(feature);
                        error.requestedCadastreIds = Array.from(scope);
                        error.requiredCadastreIds = occupied;
                        throw error;
                    });
                    const replacements = (Array.isArray(features) ? features : []).flatMap(raw => connectedFeatures(raw));
                    validateReplacement(draft, scope, replacements);
                    Array.from(draft.data.byId.entries()).forEach(([id, feature]) => {
                        if (explicitCadastreIds(feature).some(value => scope.has(value))) removeOne(draft, id);
                    });
                    replacements.forEach(feature => {
                        const existing = draft.data.byId.get(featureId(feature));
                        if (existing) {
                            const error = new Error(`Replacement id ${featureId(feature)} already exists outside its cadastral scope.`);
                            error.code = 'duplicate-live-parcel-id';
                            throw error;
                        }
                        putOne(draft, feature);
                    });
                    return Array.from(draft.changedIds);
                },
                releaseCadastreScope(cadastreIds, reason, config = {}) {
                    assertActive(draft);
                    const scope = new Set(Array.from(cadastreIds || []).map(normalizeId).filter(Boolean));
                    if (!scope.size || !normalizeId(reason)) {
                        const error = new Error('Releasing cadastral scope requires IDs and an explicit repository reset/unload reason.');
                        error.code = 'live-fabric-release-reason-required';
                        throw error;
                    }
                    Array.from(draft.data.byId.entries()).forEach(([id, feature]) => {
                        if (explicitCadastreIds(feature).some(value => scope.has(value))) removeOne(draft, id);
                    });
                    if (config.unloadFacts === true) scope.forEach(id => draft.data.cadastreFacts.delete(id));
                    scope.forEach(id => draft.changedCadastreIds.add(id));
                    return Array.from(draft.changedIds);
                },
                get: id => (assertActive(draft), readFrom(draft.data, id)),
                getMany: (ids, query) => (assertActive(draft), getManyFrom(draft.data, ids, query)),
                list: () => (assertActive(draft), Array.from(draft.data.byId.values(), clone)),
                entriesForCadastre: (ids, query) => (assertActive(draft), entriesForCadastreFrom(draft.data, ids, query)),
                producedBy(proposalId) {
                    assertActive(draft);
                    const ids = draft.data.byProducerId.get(normalizeId(proposalId));
                    return ids ? Array.from(ids, id => clone(draft.data.byId.get(id))) : [];
                },
                queryBounds: (bounds, query) => (assertActive(draft), queryBoundsFrom(draft.data, bounds, query)),
                cadastreIdsForParcelIds: (ids, query) => (assertActive(draft), cadastreIdsForParcelIdsFrom(draft.data, ids, query)),
                snapshot: () => (assertActive(draft), {
                    revision: draft.data.revision,
                    featureCount: draft.data.byId.size,
                    parcelIds: Array.from(draft.data.byId.keys())
                }),
                async prepare() {
                    assertActive(draft);
                    draft.delta = deltaFor(draft);
                    const view = participantView(draft);
                    try {
                        for (const participant of participants) {
                            const value = typeof participant.prepare === 'function'
                                ? await participant.prepare(draft.delta, view)
                                : draft.delta;
                            draft.prepared.push({ participant, value });
                        }
                        draft.state = 'prepared';
                        return draft.delta;
                    } catch (error) {
                        throw error;
                    }
                },
                publish() {
                    if (!active || active !== draft || draft.state !== 'prepared') {
                        const error = new Error('Live parcel fabric mutation must be prepared before publication.');
                        error.code = 'live-fabric-mutation-not-prepared';
                        throw error;
                    }
                    const previous = committed;
                    const next = { ...draft.data, revision: draft.delta.revision };
                    committed = next;
                    try {
                        for (const entry of draft.prepared) {
                            if (typeof entry.participant.commit !== 'function') continue;
                            const result = entry.participant.commit(entry.value, draft.delta);
                            if (result && typeof result.then === 'function') {
                                throw new Error('Live-fabric participant publication must be synchronous.');
                            }
                        }
                    } catch (error) {
                        committed = previous;
                        for (let index = draft.prepared.length - 1; index >= 0; index -= 1) {
                            try { draft.prepared[index].participant.rollback?.(draft.prepared[index].value, draft.delta); }
                            catch (_) { /* preserve primary failure */ }
                        }
                        active = null;
                        draft.state = 'rolled-back';
                        throw error;
                    }
                    active = null;
                    draft.state = 'published';
                    subscribers.forEach(listener => {
                        try { listener(draft.delta); }
                        catch (error) { console.error('[LiveParcelFabric] subscriber failed', error); }
                    });
                    return draft.delta;
                },
                rollback() {
                    if (draft.state === 'published' || draft.state === 'rolled-back') return false;
                    if (active === draft) active = null;
                    for (let index = draft.prepared.length - 1; index >= 0; index -= 1) {
                        try { draft.prepared[index].participant.rollback?.(draft.prepared[index].value, draft.delta); }
                        catch (_) { }
                    }
                    draft.state = 'rolled-back';
                    return true;
                }
            };
            return Object.freeze(mutation);
        }

        function queriedData(query) {
            if (query?.transaction && legacyToken && query.transaction === legacyToken && active) return active.data;
            return committed;
        }
        function get(id, query) { return readFrom(queriedData(query), id); }
        function getMany(ids, query) { return getManyFrom(queriedData(query), ids, query); }
        function list(query) { return Array.from(queriedData(query).byId.values(), clone); }
        function entriesForCadastre(ids, query) { return entriesForCadastreFrom(queriedData(query), ids, query); }
        function producedBy(proposalId, query) {
            const data = queriedData(query);
            const ids = data.byProducerId.get(normalizeId(proposalId));
            return ids ? Array.from(ids, id => clone(data.byId.get(id))) : [];
        }
        function queryBounds(bounds, query) { return queryBoundsFrom(queriedData(query), bounds, query); }
        function cadastreIdsForParcelIds(ids, query) { return cadastreIdsForParcelIdsFrom(queriedData(query), ids, query); }
        function claimedCadastreIds() {
            const claimed = new Set();
            committed.byId.forEach(feature => {
                const id = featureId(feature);
                const bases = explicitCadastreIds(feature);
                const produced = !!producerId(feature) || feature.properties?.cadastralPart === true
                    || bases.length !== 1 || bases[0] !== id;
                if (produced) bases.forEach(base => claimed.add(base));
            });
            return claimed;
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
        function snapshot() {
            return {
                revision: committed.revision,
                featureCount: committed.byId.size,
                parcelIds: Array.from(committed.byId.keys()),
                transactionActive: !!active
            };
        }
        function diagnostics() { return { ...metrics }; }

        // Phase-two compatibility adapter. The next migration phase removes these token-shaped
        // methods after all production paths use beginMutation()'s scoped object.
        let legacyMutation = null;
        let legacyToken = null;
        function beginTransaction(meta) {
            legacyMutation = beginMutation(meta);
            legacyToken = Object.freeze({ id: normalizeId(meta?.id) || `legacy-${committed.revision + 1}` });
            return legacyToken;
        }
        function requireLegacy(config = {}) {
            if (!legacyMutation || config.transaction !== legacyToken) {
                const error = new Error('Live parcel fabric mutation requires its active transaction token.');
                error.code = 'live-fabric-transaction-mismatch';
                throw error;
            }
            return legacyMutation;
        }
        function upsertFeatures(features, config) { return requireLegacy(config).upsertFeatures(features, config); }
        function removeIds(ids, config) { return requireLegacy(config).removeIds(ids); }
        function replaceCadastreScope(ids, features, config) { return requireLegacy(config).replaceCadastreScope(ids, features); }
        function seedCadastre(features, config) { return requireLegacy(config).seedCadastre(features); }
        function replaceAll(features, config) {
            const mutation = requireLegacy(config);
            const scope = Array.from(mutation.list().flatMap(explicitCadastreIds));
            if (scope.length) mutation.releaseCadastreScope(scope, 'legacy replace-all');
            if (Array.isArray(features) && features.length) mutation.upsertFeatures(features);
            return mutation.snapshot().parcelIds;
        }
        async function commit(token) {
            const mutation = requireLegacy({ transaction: token });
            await mutation.prepare();
            const change = mutation.publish();
            legacyMutation = null;
            legacyToken = null;
            return change;
        }
        function rollback(token) {
            const mutation = requireLegacy({ transaction: token });
            const result = mutation.rollback();
            legacyMutation = null;
            legacyToken = null;
            return result;
        }
        async function transact(meta, operation) {
            const token = beginTransaction(meta);
            try {
                const result = await operation(token);
                if (result === false) { rollback(token); return false; }
                await commit(token);
                return result;
            } catch (error) {
                if (legacyToken === token) rollback(token);
                throw error;
            }
        }
        function currentTransaction() { return legacyToken; }

        return Object.freeze({
            beginMutation,
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
            diagnostics,
            currentTransaction,
            featureId,
            explicitCadastreIds
        });
    }

    return Object.freeze({ createLiveParcelFabric, featureId, explicitCadastreIds, GEOMETRY_EPSILON_M2 });
});
