// Immutable cadastral parcel repository.
//
// All consumers ask this repository for ground. It alone decides whether the answer comes from
// retained memory, an in-flight request, or the transport. A missing parcel is cached only when
// the transport explicitly says it is absent; unavailable/partial responses are errors and are
// always retryable. The repository never reads or writes Leaflet.
(function attachCadastralRepository(global, factory) {
    const exported = factory(global);
    if (typeof module === 'object' && module.exports) module.exports = exported;
    if (global) {
        const fabric = global.LiveParcelFabric;
        const service = exported.createCadastralParcelRepository({
            root: global,
            transport: global.__cadastralGroundTransport,
            convertFeatures: global.convertGeoJSON,
            footprintOf: record => global.__planOrder && typeof global.__planOrder.footprintOf === 'function'
                ? global.__planOrder.footprintOf(record)
                : null,
            cadastreParcelIdsOf: record => global.__claims && typeof global.__claims.cadastreParcelIdsOf === 'function'
                ? global.__claims.cadastreParcelIdsOf(record)
                : (record && record.cadastreParcelIds) || [],
            boundsKeysOf: bounds => typeof global.getRequiredGridCells === 'function'
                ? Array.from(global.getRequiredGridCells(bounds, 0))
                : [],
            onFeatures: async (features, context = {}) => {
                if (!fabric || !features.length) return;
                // A repository consumer may write only to the fabric draft it was
                // explicitly given. An unrelated viewport request must never leak into whichever
                // proposal happens to be applying at the time.
                if (context.mutation) {
                    context.mutation.seedCadastre(features);
                    return;
                }

                // Outside a domain transaction, do not open an empty revision for facts whose
                // cadastral ground is already represented by the committed partition. This check
                // is an integration concern at the repository/fabric adapter — never a cache or
                // renderer fallback.
                const unpublished = features.filter(feature => {
                    const id = fabric.featureId(feature);
                    return id && fabric.entriesForCadastre([id], { includeCorridors: true }).length === 0;
                });
                if (!unpublished.length) return;
                if (global.ProposalManager && typeof global.ProposalManager.integrateCadastralGround === 'function') {
                    const integrated = await global.ProposalManager.integrateCadastralGround(unpublished);
                    if (!integrated || integrated.ok !== true) {
                        throw new Error('Cadastral ground could not be integrated into the live parcel fabric.');
                    }
                } else throw new Error('ParcelMutation is unavailable for cadastral integration.');
            }
        });
        try { delete global.__cadastralGroundTransport; } catch (_) { global.__cadastralGroundTransport = undefined; }
        global.CadastralParcelRepository = service;
        exported.CadastralParcelRepository = service;
    }
})(typeof window !== 'undefined' ? window : globalThis, function cadastralRepositoryFactory(defaultRoot) {
    'use strict';

    const COMPLETE_COVERAGE = 0.999;
    const FOOTPRINT_BATCH_SIZE = 20;
    const FOOTPRINT_CONCURRENCY = 6;

    function clone(value) {
        if (value === undefined || value === null) return value;
        if (typeof structuredClone === 'function') {
            try { return structuredClone(value); } catch (_) { /* JSON fallback */ }
        }
        return JSON.parse(JSON.stringify(value));
    }

    function now() {
        return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
    }

    function normalizeId(value) {
        return value === undefined || value === null ? '' : String(value).trim();
    }

    function assertCadastralIds(values) {
        // This API is the cadastral boundary. IDs are opaque; their role comes from this contract
        // and the provenance stamped on accepted features, never from punctuation in the value.
        return Array.from(new Set(Array.from(values || []).map(normalizeId).filter(Boolean)));
    }

    function featureId(feature) {
        const props = feature && feature.properties || {};
        return normalizeId(props.parcelId ?? props.parcel_id ?? props.PARCEL_ID ?? props.id);
    }

    function geometryFingerprint(geometry) {
        const geom = geometry && geometry.type === 'Feature' ? geometry.geometry : geometry;
        return geom && geom.type ? JSON.stringify(geom) : '';
    }

    function multiPolygonOfFootprints(footprints) {
        const polygons = [];
        (footprints || []).forEach(value => {
            const geom = value && value.type === 'Feature' ? value.geometry : value;
            if (!geom) return;
            if (geom.type === 'Polygon') polygons.push(clone(geom.coordinates));
            else if (geom.type === 'MultiPolygon') clone(geom.coordinates).forEach(coords => polygons.push(coords));
        });
        if (!polygons.length) return null;
        return polygons.length === 1
            ? { type: 'Polygon', coordinates: polygons[0] }
            : { type: 'MultiPolygon', coordinates: polygons };
    }

    function createCadastralParcelRepository(dependencies = {}) {
        const root = dependencies.root || defaultRoot || {};
        const source = dependencies.transport || null;
        const featureStores = new Map();
        const absentStores = new Map();
        const idInFlight = new Map();
        const footprintInFlight = new Map();
        const footprintResults = new Map();
        const boundsInFlight = new Map();
        const loadedBounds = new Map();
        const roadIdsInFlight = new Map();
        const roadIdsByBounds = new Map();

        const cityKey = () => {
            try {
                const manager = root.CityConfigManager;
                const value = manager && typeof manager.getCurrentCityId === 'function'
                    ? manager.getCurrentCityId()
                    : (typeof root.getCurrentCityId === 'function' ? root.getCurrentCityId() : root.CURRENT_CITY_ID);
                return normalizeId(value) || 'default';
            } catch (_) {
                return 'default';
            }
        };
        const scoped = (city, key) => `${city}\u0000${key}`;
        const storeFor = (collection, city) => {
            if (!collection.has(city)) collection.set(city, new Map());
            return collection.get(city);
        };
        const featureStore = city => storeFor(featureStores, city);
        const absentStore = city => {
            if (!absentStores.has(city)) absentStores.set(city, new Set());
            return absentStores.get(city);
        };
        const transport = () => dependencies.transport || source;
        const emit = (handler, detail) => {
            if (typeof handler === 'function') {
                try { handler(detail); } catch (_) { /* progress cannot alter the result */ }
            }
        };
        const pendingForCity = (registry, city) => {
            const prefix = `${city}\u0000`;
            return Array.from(new Set(Array.from(registry.entries())
                .filter(([key]) => key.startsWith(prefix))
                .map(([, task]) => task)));
        };

        function normalizeFeatures(input, options = {}) {
            const raw = Array.isArray(input) ? input : [];
            let features = raw;
            if (options.skipConversion !== true) {
                const convert = dependencies.convertFeatures;
                if (typeof convert !== 'function') throw new Error('Cadastral coordinate conversion is unavailable.');
                const converted = convert({ type: 'FeatureCollection', features: raw });
                if (!converted || !Array.isArray(converted.features)) {
                    throw new Error('Cadastral coordinate conversion returned no FeatureCollection.');
                }
                features = converted.features;
            }
            return features.map(rawFeature => {
                const feature = clone(rawFeature);
                const id = featureId(feature);
                if (!id) {
                    const error = new Error('Cadastral transport returned a feature without parcelId.');
                    error.code = 'cadastral-feature-id-missing';
                    throw error;
                }
                assertCadastralIds([id]);
                if (!feature.geometry || !/Polygon$/.test(String(feature.geometry.type || ''))) {
                    const error = new Error(`Cadastral parcel ${id} has no polygon geometry.`);
                    error.code = 'cadastral-feature-geometry-invalid';
                    throw error;
                }
                const props = feature.properties || (feature.properties = {});
                props.parcelId = id;
                props.id = id;
                props.cadastreParcelIds = [id];
                return feature;
            });
        }

        async function provideFeatures(features, options = {}) {
            const list = (Array.isArray(features) ? features : []).filter(Boolean).map(clone);
            if (!list.length || typeof dependencies.onFeatures !== 'function') return;
            await dependencies.onFeatures(list, {
                city: normalizeId(options.city) || cityKey(),
                mutation: options.mutation || null
            });
        }

        function retainTransportFeatures(features, city) {
            const store = featureStore(city);
            const absent = absentStore(city);
            const staged = new Map();
            for (const feature of features) {
                const id = featureId(feature);
                const current = staged.get(id) || store.get(id);
                if (current) {
                    // Cadastral facts are immutable for a session. Conflicting geometry is an
                    // upstream data error, not permission to replace the ground under proposals.
                    if (JSON.stringify(current.geometry) !== JSON.stringify(feature.geometry)) {
                        const error = new Error(`Conflicting cadastral geometry received for ${id}.`);
                        error.code = 'cadastral-feature-conflict';
                        error.parcelId = id;
                        throw error;
                    }
                    continue;
                }
                staged.set(id, feature);
            }
            staged.forEach((feature, id) => store.set(id, feature));
            staged.forEach((_feature, id) => absent.delete(id));
            return Array.from(new Set(features.map(featureId)));
        }

        function explicitTransportResult(result, requestedIds) {
            if (!result || result.status === 'unavailable') {
                const error = new Error(result && result.message || 'Cadastral transport is unavailable.');
                error.code = 'cadastral-transport-unavailable';
                throw error;
            }
            if (result.status === 'partial') {
                const error = new Error(result.message || 'Cadastral transport returned a partial response.');
                error.code = 'cadastral-transport-partial';
                throw error;
            }
            const absentIds = assertCadastralIds(result.absentIds || []);
            if (requestedIds && !Array.isArray(result.absentIds) && result.complete !== true) {
                const error = new Error('Cadastral id transport did not declare whether its result is complete.');
                error.code = 'cadastral-transport-ambiguous';
                throw error;
            }
            return {
                ...result,
                status: result.status || 'ready',
                features: Array.isArray(result.features) ? result.features : [],
                absentIds
            };
        }

        async function acceptTransportResult(rawResult, options = {}) {
            const result = explicitTransportResult(rawResult, options.requestedIds);
            // Normalize and validate the complete response before either repository or fabric sees
            // it. A transport that claims completeness but omits an id must not partially publish
            // the facts it happened to return.
            const normalized = normalizeFeatures(result.features, {
                skipConversion: options.skipConversion === true
            });
            const responseIds = normalized.map(featureId);
            if (options.requestedIds && result.complete === true) {
                const found = new Set(responseIds);
                const explicitAbsent = new Set(result.absentIds);
                const undeclared = options.requestedIds.filter(id => !found.has(id) && !explicitAbsent.has(id));
                if (undeclared.length) {
                    const error = new Error(`Cadastral transport omitted ${undeclared.length} id(s) from a complete response.`);
                    error.code = 'cadastral-transport-inconsistent';
                    error.parcelIds = undeclared;
                    throw error;
                }
            }
            const city = normalizeId(options.city) || cityKey();
            const ids = retainTransportFeatures(normalized, city);
            const absent = absentStore(city);
            result.absentIds.forEach(id => absent.add(id));
            return { ...result, ids };
        }

        async function ensureIds(parcelIds, options = {}) {
            const started = now();
            const city = normalizeId(options.city) || cityKey();
            const ids = assertCadastralIds(parcelIds);
            const store = featureStore(city);
            const absent = absentStore(city);
            emit(options.onProgress, { phase: 'ground-check-ids', total: ids.length });

            // A footprint request can return the same immutable cadastral facts. Join requests that
            // were already running before this call, then decide what is actually missing. The
            // reverse path in ensureFootprint follows the same rule; whichever request starts first
            // owns the transport and the other observes its repository commit.
            const footprintWaits = pendingForCity(footprintInFlight, city);
            if (footprintWaits.length) await Promise.all(footprintWaits);

            const cachedIds = ids.filter(id => store.has(id));
            const knownAbsent = ids.filter(id => absent.has(id));
            const waitingIds = [];
            const requestedIds = [];
            const waits = new Set();

            ids.forEach(id => {
                if (store.has(id) || absent.has(id)) return;
                const pending = idInFlight.get(scoped(city, id));
                if (pending) {
                    waitingIds.push(id);
                    waits.add(pending);
                } else requestedIds.push(id);
            });

            let ownRequest = null;
            if (requestedIds.length) {
                const requestTransport = transport();
                const fetchByIds = requestTransport && requestTransport.fetchByIds;
                if (typeof fetchByIds !== 'function') throw new Error('Cadastral id transport is unavailable.');
                emit(options.onProgress, { phase: 'ground-load-ids', done: 0, total: requestedIds.length });
                ownRequest = Promise.resolve()
                    .then(() => fetchByIds(requestedIds, {
                        city,
                        onProgress: progress => emit(options.onProgress, {
                            phase: 'ground-load-ids-progress',
                            done: typeof progress === 'number' ? progress : progress && progress.done,
                            total: requestedIds.length
                        })
                    }))
                    .then(result => acceptTransportResult(result, {
                        city,
                        requestedIds,
                        skipConversion: result && result.returnsWGS84 === true,
                        mutation: options.mutation || null
                    }))
                    .finally(() => {
                        requestedIds.forEach(id => {
                            const key = scoped(city, id);
                            if (idInFlight.get(key) === ownRequest) idInFlight.delete(key);
                        });
                    });
                requestedIds.forEach(id => idInFlight.set(scoped(city, id), ownRequest));
                waits.add(ownRequest);
            }
            if (waits.size) await Promise.all(waits);

            const foundIds = ids.filter(id => store.has(id));
            const absentIds = ids.filter(id => absent.has(id));
            const unavailableIds = ids.filter(id => !store.has(id) && !absent.has(id));
            if (unavailableIds.length) {
                const error = new Error(`Cadastral ground remains unavailable for: ${unavailableIds.join(', ')}`);
                error.code = 'cadastral-ground-unavailable';
                error.parcelIds = unavailableIds;
                throw error;
            }
            emit(options.onProgress, {
                phase: 'ground-ids-ready',
                cached: cachedIds.length,
                loaded: foundIds.filter(id => !cachedIds.includes(id)).length,
                absent: absentIds.length,
                total: ids.length
            });
            const features = foundIds.map(id => clone(store.get(id)));
            await provideFeatures(features, { city, mutation: options.mutation || null });
            return {
                status: absentIds.length ? 'partial' : 'ready',
                ids,
                features,
                foundIds,
                cachedIds,
                requestedIds,
                waitingIds,
                knownAbsent,
                absentIds,
                missingIds: absentIds.slice(),
                unavailableIds: [],
                requestCount: ownRequest ? 1 : 0,
                elapsed: now() - started
            };
        }

        function footprintOf(record) {
            if (typeof dependencies.footprintOf === 'function') {
                try { return dependencies.footprintOf(record); } catch (_) { return null; }
            }
            const geometry = record && record.geometry;
            if (!geometry) return null;
            if (geometry.type === 'Feature') return geometry;
            return geometry.type ? { type: 'Feature', properties: {}, geometry } : null;
        }

        function cadastreIdsOf(record) {
            const raw = typeof dependencies.cadastreParcelIdsOf === 'function'
                ? dependencies.cadastreParcelIdsOf(record)
                : (record && record.cadastreParcelIds);
            return assertCadastralIds(raw || []);
        }

        function retainedCoverageOf(geometry, city, options = {}) {
            const geom = geometry && geometry.type === 'Feature' ? geometry.geometry : geometry;
            const footprint = geom && geom.type
                ? { type: 'Feature', properties: {}, geometry: clone(geom) }
                : null;
            if (!footprint) return { ids: [], coverage: 0 };
            const requestedIds = assertCadastralIds(options.ids || []);
            const stored = requestedIds.length
                ? requestedIds.map(id => featureStore(city).get(id)).filter(Boolean).map(clone)
                : Array.from(featureStore(city).values(), clone);
            const supplied = dependencies.coverageOf;
            if (typeof supplied === 'function') {
                const answer = supplied(footprint, stored, { city }) || {};
                return {
                    ids: assertCadastralIds(answer.ids || []),
                    coverage: Math.max(0, Math.min(1, Number(answer.coverage) || 0))
                };
            }
            const order = root.__planOrder;
            const turf = root.turf;
            if (!order || typeof order.computeBaseAncestry !== 'function'
                || !turf || typeof turf.area !== 'function') {
                return { ids: [], coverage: 0 };
            }
            try {
                const footprintArea = Number(turf.area(footprint)) || 0;
                if (!(footprintArea > 0)) return { ids: [], coverage: 0 };
                const hits = order.computeBaseAncestry(footprint, stored.map(feature => ({
                    id: featureId(feature),
                    feature
                })));
                const coveredArea = hits.reduce((sum, hit) => sum + (Number(hit.area) || 0), 0);
                return {
                    ids: assertCadastralIds(hits.map(hit => hit.id)),
                    coverage: Math.max(0, Math.min(1, coveredArea / footprintArea))
                };
            } catch (_) {
                return { ids: [], coverage: 0 };
            }
        }

        function footprintSummary(geometry, city, transportResult = null) {
            const retained = retainedCoverageOf(geometry, city);
            const resultIds = assertCadastralIds(transportResult && transportResult.ids || []);
            const ids = retained.ids.length ? retained.ids : resultIds;
            const hasTransportCoverage = transportResult
                && transportResult.coverage !== undefined
                && transportResult.coverage !== null
                && Number.isFinite(Number(transportResult.coverage));
            const transportCoverage = hasTransportCoverage ? Number(transportResult.coverage) : null;
            const coverage = hasTransportCoverage
                ? Math.max(0, Math.min(1, transportCoverage))
                : retained.coverage;
            return {
                status: 'ready',
                ids,
                features: ids.map(id => clone(featureStore(city).get(id))).filter(Boolean),
                coverage,
                count: ids.length,
                queryMs: Number(transportResult && transportResult.queryMs) || null
            };
        }

        async function ensureFootprint(geometry, options = {}) {
            const started = now();
            const city = normalizeId(options.city) || cityKey();
            const geom = geometry && geometry.type === 'Feature' ? geometry.geometry : geometry;
            const fingerprint = geometryFingerprint(geom);
            if (!fingerprint) throw new Error('Cannot request cadastral ground without a polygon footprint.');
            const key = scoped(city, fingerprint);
            if (footprintResults.has(key)) {
                const result = clone(footprintResults.get(key));
                await provideFeatures(result.features, { city, mutation: options.mutation || null });
                return { members: 1, coveredMembers: 1, requests: 0, result, elapsed: now() - started };
            }
            const pending = footprintInFlight.get(key);
            if (pending) {
                const shared = clone(await pending);
                await provideFeatures(shared.result?.features, { city, mutation: options.mutation || null });
                return shared;
            }
            const requestTransport = transport();
            const fetchUnderGeometry = requestTransport && requestTransport.fetchUnderGeometry;
            const task = Promise.resolve()
                .then(async () => {
                    const idWaits = pendingForCity(idInFlight, city);
                    if (idWaits.length) await Promise.all(idWaits);
                    const cached = footprintSummary(geom, city);
                    if (cached.coverage >= COMPLETE_COVERAGE) {
                        footprintResults.set(key, clone(cached));
                        return { cached };
                    }
                    if (typeof fetchUnderGeometry !== 'function') {
                        throw new Error('Cadastral footprint transport is unavailable.');
                    }
                    return fetchUnderGeometry(geom, {
                    city,
                    parcelsOnly: options.parcelsOnly !== false
                    });
                })
                .then(async outcome => {
                    if (outcome && outcome.cached) {
                        return {
                            members: 1,
                            coveredMembers: 1,
                            fetchedMembers: 0,
                            requests: 0,
                            result: clone(outcome.cached),
                            elapsed: now() - started
                        };
                    }
                    const result = await acceptTransportResult(outcome, {
                        city,
                        skipConversion: outcome && outcome.returnsWGS84 === true
                    });
                    const summary = footprintSummary(geom, city, result);
                    footprintResults.set(key, clone(summary));
                    return { members: 1, coveredMembers: 0, fetchedMembers: 1, requests: 1, result: summary, elapsed: now() - started };
                })
                .finally(() => { if (footprintInFlight.get(key) === task) footprintInFlight.delete(key); });
            footprintInFlight.set(key, task);
            const result = clone(await task);
            await provideFeatures(result.result?.features, { city, mutation: options.mutation || null });
            return result;
        }

        async function ensureProposalGround(records, options = {}) {
            const started = now();
            const city = normalizeId(options.city) || cityKey();
            const members = (Array.isArray(records) ? records : []).filter(Boolean);
            const purpose = String(options.purpose || 'application');
            const declared = new Map(members.map(record => [record, cadastreIdsOf(record)]));
            const byIds = purpose === 'publish' ? [] : members.filter(record => declared.get(record).length);
            const allIds = assertCadastralIds(byIds.flatMap(record => declared.get(record)));
            emit(options.onProgress, { phase: 'ground-check', members: members.length, parcelIds: allIds.length, purpose });

            const idResult = allIds.length ? await ensureIds(allIds, {
                city,
                onProgress: options.onProgress,
                mutation: options.mutation || null
            }) : {
                cachedIds: [], requestedIds: [], waitingIds: [], missingIds: [], requestCount: 0, features: []
            };
            const profile = {
                members: members.length,
                cachedMembers: 0,
                loadedMembers: 0,
                coveredMembers: 0,
                fetchedMembers: 0,
                waitingMembers: 0,
                unavailableMembers: 0,
                requests: idResult.requestCount,
                idRequests: idResult.requestCount,
                footprintRequests: 0,
                parcels: idResult.features.length,
                serverMs: 0,
                slowestMs: 0,
                slowest: null,
                refused: [],
                failed: 0,
                missingIds: idResult.missingIds.slice()
            };
            const resolvedIds = new Set(idResult.foundIds || []);
            const cached = new Set(idResult.cachedIds);
            const requested = new Set(idResult.requestedIds);
            const waiting = new Set(idResult.waitingIds);
            byIds.forEach(record => {
                const ids = declared.get(record);
                if (ids.some(id => requested.has(id))) profile.loadedMembers += 1;
                else if (ids.some(id => waiting.has(id))) profile.waitingMembers += 1;
                else if (ids.every(id => cached.has(id))) profile.cachedMembers += 1;
            });

            const footprintGroups = new Map();
            const cachedFootprintFeatures = [];
            members.forEach(record => {
                if (purpose !== 'publish' && declared.get(record).length) return;
                const footprint = footprintOf(record);
                const fingerprint = geometryFingerprint(footprint);
                if (!footprint || !fingerprint) {
                    const error = new Error(`Proposal ${record.proposalId || record.title || ''} has neither cadastral ids nor a usable footprint.`);
                    error.code = 'proposal-cadastral-ground-unspecified';
                    throw error;
                }
                const key = scoped(city, fingerprint);
                if (footprintResults.has(key)) {
                    profile.cachedMembers += 1;
                    const cachedResult = footprintResults.get(key);
                    (cachedResult?.ids || []).forEach(id => resolvedIds.add(String(id)));
                    cachedFootprintFeatures.push(...(cachedResult?.features || []));
                } else if (footprintGroups.has(key)) {
                    footprintGroups.get(key).records.push(record);
                } else {
                    footprintGroups.set(key, { records: [record], footprint, key });
                }
            });
            // A cached answer is still an answer to this transaction. Repository retention and
            // live-fabric membership are deliberately independent, so each consumer gets the
            // immutable facts provisioned into its own explicit draft even when transport is not
            // involved.
            if (cachedFootprintFeatures.length) {
                await provideFeatures(cachedFootprintFeatures, {
                    city,
                    mutation: options.mutation || null
                });
            }

            const footprintEntries = Array.from(footprintGroups.values());

            const chunks = [];
            for (let i = 0; i < footprintEntries.length; i += FOOTPRINT_BATCH_SIZE) {
                chunks.push(footprintEntries.slice(i, i + FOOTPRINT_BATCH_SIZE));
            }
            if (chunks.length) emit(options.onProgress, {
                phase: 'ground-load-footprints',
                members: footprintEntries.reduce((sum, entry) => sum + entry.records.length, 0),
                batches: chunks.length,
                cachedMembers: profile.cachedMembers
            });
            let cursor = 0;
            const worker = async () => {
                while (cursor < chunks.length) {
                    const chunk = chunks[cursor++];
                    const geometry = multiPolygonOfFootprints(chunk.map(entry => entry.footprint));
                    const requestStarted = now();
                    const result = await ensureFootprint(geometry, {
                        city,
                        parcelsOnly: true,
                        mutation: options.mutation || null
                    });
                    const elapsed = now() - requestStarted;
                    profile.footprintRequests += result.requests || 0;
                    profile.requests += result.requests || 0;
                    profile.parcels += Number(result.result && result.result.count) || 0;
                    profile.serverMs += Number(result.result && result.result.queryMs) || 0;
                    profile.slowestMs = Math.max(profile.slowestMs, elapsed);
                    let chunkMembers = 0;
                    chunk.forEach(entry => {
                        const summary = footprintSummary(entry.footprint, city, result.result);
                        footprintResults.set(entry.key, clone(summary));
                        summary.ids.forEach(id => resolvedIds.add(String(id)));
                        chunkMembers += entry.records.length;
                    });
                    if ((result.requests || 0) > 0) {
                        profile.loadedMembers += chunkMembers;
                        profile.fetchedMembers += chunkMembers;
                    } else {
                        profile.cachedMembers += chunkMembers;
                    }
                    emit(options.onProgress, {
                        phase: 'ground-load-footprints-progress',
                        done: cursor,
                        total: chunks.length,
                        members: footprintEntries.reduce((sum, entry) => sum + entry.records.length, 0),
                        parcels: profile.parcels
                    });
                }
            };
            await Promise.all(Array.from({ length: Math.min(FOOTPRINT_CONCURRENCY, chunks.length) }, worker));
            profile.coveredMembers = members.length;
            const elapsed = now() - started;
            emit(options.onProgress, {
                phase: 'ground-ready', members: members.length, cachedMembers: profile.cachedMembers,
                loadedMembers: profile.loadedMembers, waitingMembers: profile.waitingMembers,
                unavailableMembers: 0, idRequests: profile.idRequests,
                footprintRequests: profile.footprintRequests, missingIds: profile.missingIds.length, elapsed
            });
            profile.featureIds = Array.from(resolvedIds);
            profile.features = profile.featureIds.map(id => featureStore(city).get(id)).filter(Boolean).map(clone);
            return { ...profile, elapsed };
        }

        async function ensureBounds(bounds, options = {}) {
            const city = normalizeId(options.city) || cityKey();
            const rawKeys = typeof dependencies.boundsKeysOf === 'function'
                ? dependencies.boundsKeysOf(bounds)
                : [];
            const fallbackKey = (() => {
                if (!bounds || typeof bounds.getSouthWest !== 'function') return geometryFingerprint(bounds);
                const sw = bounds.getSouthWest();
                const ne = bounds.getNorthEast();
                return [sw.lng, sw.lat, ne.lng, ne.lat].map(value => Number(value).toFixed(6)).join(',');
            })();
            const keys = Array.from(new Set((rawKeys && rawKeys.length ? rawKeys : [fallbackKey]).map(normalizeId).filter(Boolean)));
            const loaded = loadedBounds.get(city) || new Map();
            loadedBounds.set(city, loaded);
            const pendingKeys = keys.filter(key => !loaded.has(key));
            if (!pendingKeys.length) {
                const cachedIds = new Set(keys.flatMap(key => Array.from(loaded.get(key) || [])));
                const result = {
                    status: 'ready', cached: true, keys,
                    features: Array.from(cachedIds, id => featureStore(city).get(id)).filter(Boolean).map(clone),
                    requestCount: 0
                };
                await provideFeatures(result.features, { city, mutation: options.mutation || null });
                return result;
            }

            const waits = new Set();
            const ownKeys = [];
            pendingKeys.forEach(key => {
                const pending = boundsInFlight.get(scoped(city, key));
                if (pending) waits.add(pending);
                else ownKeys.push(key);
            });
            let own = null;
            if (ownKeys.length) {
                const requestTransport = transport();
                const fetchBounds = requestTransport && requestTransport.fetchBounds;
                if (typeof fetchBounds !== 'function') throw new Error('Cadastral bounds transport is unavailable.');
                own = Promise.resolve()
                    .then(() => fetchBounds(bounds, { city, keys: ownKeys, onProgress: options.onProgress }))
                    .then(result => acceptTransportResult(result, {
                        city,
                        skipConversion: result && result.returnsWGS84 === true
                    }))
                    .then(result => {
                        const ids = new Set((result.ids || []).map(String));
                        ownKeys.forEach(key => loaded.set(key, new Set(ids)));
                        return result;
                    })
                    .finally(() => ownKeys.forEach(key => {
                        const cacheKey = scoped(city, key);
                        if (boundsInFlight.get(cacheKey) === own) boundsInFlight.delete(cacheKey);
                    }));
                ownKeys.forEach(key => boundsInFlight.set(scoped(city, key), own));
                waits.add(own);
            }
            await Promise.all(waits);
            const resolvedIds = new Set(keys.flatMap(key => Array.from(loaded.get(key) || [])));
            const result = {
                status: 'ready', cached: false, keys,
                features: Array.from(resolvedIds, id => featureStore(city).get(id)).filter(Boolean).map(clone),
                requestCount: own ? 1 : 0
            };
            await provideFeatures(result.features, { city, mutation: options.mutation || null });
            return result;
        }

        function get(id, options = {}) {
            const city = normalizeId(options.city) || cityKey();
            const value = featureStore(city).get(normalizeId(id));
            return value ? clone(value) : null;
        }

        function getMany(ids, options = {}) {
            const city = normalizeId(options.city) || cityKey();
            return assertCadastralIds(ids).map(id => featureStore(city).get(id)).filter(Boolean).map(clone);
        }

        function list(options = {}) {
            const city = normalizeId(options.city) || cityKey();
            return Array.from(featureStore(city).values(), clone);
        }

        // Pure repository query used after `ensure*` has made ground available.  Consumers never
        // scan a second cache or a renderer: the same service that owns retrieval owns the answer.
        function coverageOf(geometry, options = {}) {
            const city = normalizeId(options.city) || cityKey();
            return clone(retainedCoverageOf(geometry, city, { ids: options.ids }));
        }

        function boundsArray(bounds) {
            if (Array.isArray(bounds) && bounds.length >= 4) return bounds.slice(0, 4).map(Number);
            if (!bounds || typeof bounds.getWest !== 'function') return null;
            return [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()].map(Number);
        }

        function roadClassificationAvailable(options = {}) {
            const city = normalizeId(options.city) || cityKey();
            const requestTransport = transport();
            return Boolean(requestTransport && typeof requestTransport.supportsRoadIds === 'function'
                && requestTransport.supportsRoadIds({ city }));
        }

        async function ensureRoadIds(bounds, options = {}) {
            const city = normalizeId(options.city) || cityKey();
            const box = boundsArray(bounds);
            if (!box || box.some(value => !Number.isFinite(value))) {
                throw new TypeError('Road classification bounds are invalid.');
            }
            const requestTransport = transport();
            if (!requestTransport || typeof requestTransport.supportsRoadIds !== 'function'
                || !requestTransport.supportsRoadIds({ city })) {
                return { status: 'unsupported', city, ids: [], cached: false, requestCount: 0 };
            }
            if (typeof requestTransport.fetchRoadIds !== 'function') {
                throw new Error('Road classification transport is unavailable.');
            }
            const key = scoped(city, box.map(value => Number(value).toFixed(7)).join(','));
            const cached = roadIdsByBounds.get(key);
            if (cached) {
                return { status: 'ready', city, ids: cached.slice(), cached: true, requestCount: 0 };
            }
            let task = roadIdsInFlight.get(key);
            let requested = false;
            if (!task) {
                requested = true;
                task = Promise.resolve()
                    .then(() => requestTransport.fetchRoadIds(box, {
                        city,
                        onProgress: progress => emit(options.onProgress, progress)
                    }))
                    .then(result => {
                        if (!result || result.status !== 'ready' || !Array.isArray(result.ids)) {
                            throw new Error('Road classification transport returned an invalid result.');
                        }
                        const ids = Array.from(new Set(result.ids.map(normalizeId).filter(Boolean)));
                        roadIdsByBounds.set(key, ids);
                        return ids;
                    })
                    .finally(() => {
                        if (roadIdsInFlight.get(key) === task) roadIdsInFlight.delete(key);
                    });
                roadIdsInFlight.set(key, task);
            }
            const ids = await task;
            return { status: 'ready', city, ids: ids.slice(), cached: !requested, requestCount: requested ? 1 : 0 };
        }

        function reset() {
            featureStores.clear();
            absentStores.clear();
            idInFlight.clear();
            footprintInFlight.clear();
            footprintResults.clear();
            boundsInFlight.clear();
            loadedBounds.clear();
            roadIdsInFlight.clear();
            roadIdsByBounds.clear();
        }

        function snapshot() {
            const city = cityKey();
            return {
                city,
                featureCount: featureStore(city).size,
                loadedIds: new Set(featureStore(city).keys()),
                absentIds: new Set(absentStore(city)),
                footprintCount: Array.from(footprintResults.keys()).filter(key => key.startsWith(`${city}\u0000`)).length,
                boundsCount: (loadedBounds.get(city) || new Map()).size,
                boundsKeys: Array.from((loadedBounds.get(city) || new Map()).keys()),
                roadBoundsCount: Array.from(roadIdsByBounds.keys()).filter(key => key.startsWith(`${city}\u0000`)).length
            };
        }

        return Object.freeze({
            ensureIds,
            ensureProposalGround,
            ensureFootprint,
            ensureBounds,
            get,
            getMany,
            list,
            coverageOf,
            roadClassificationAvailable,
            ensureRoadIds,
            reset,
            snapshot
        });
    }

    const service = defaultRoot && defaultRoot.CadastralParcelRepository || null;
    return {
        COMPLETE_COVERAGE,
        createCadastralParcelRepository,
        CadastralParcelRepository: service
    };
});
