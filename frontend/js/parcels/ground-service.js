// The one application-level boundary for cadastral ground reads.
//
// Consumers describe the ground they need. This service alone decides whether that ground is
// already retained as cadastral data, is being loaded by another consumer, was previously found
// to be absent, or must be requested from the server. Keeping those decisions here prevents
// a shared-plan import, replay, editor, block selection, and financial calculation from each
// maintaining a subtly different cache and fetching the same parcels again. parcels/fetch.js is
// the private transport below this boundary and parcels/ingest.js is its presentation adapter; no
// feature consumer chooses between either of them directly.
(function (global) {
    'use strict';

    const COMPLETE_COVERAGE = 0.999;
    const FOOTPRINT_BATCH_SIZE = 20;
    const FOOTPRINT_CONCURRENCY = 6;

    const now = () => ((typeof performance !== 'undefined' && performance.now)
        ? performance.now()
        : Date.now());

    function normalizeIds(values) {
        return Array.from(new Set((Array.isArray(values) ? values : [])
            .map(value => (value === undefined || value === null ? '' : String(value)))
            .filter(Boolean)));
    }

    // The transport serves cadastral facts, never proposal-generated parcel identities. Callers
    // are allowed to ask with whichever live piece they currently hold; flattening that request is
    // service policy and therefore belongs here, beside the cache and transport decision. A derived
    // `…#proposal-1` must not become an HTTP request merely because a proposal was just unapplied.
    function cadastralRequestId(value) {
        let id = value === undefined || value === null ? '' : String(value).trim();
        if (!id) return '';
        let previous = '';
        while (id && id !== previous) {
            previous = id;
            id = id.replace(/#[A-Za-z0-9_-]+-\d+$/i, '');
        }
        // Legacy government-road output used `${root}_${token}_${index}` rather than `#`.
        if (/^HR-\d+-.+_[A-Za-z0-9]+_\d+$/i.test(id)) {
            id = id.replace(/_[A-Za-z0-9]+_\d+$/i, '');
        }
        return id.split('#')[0];
    }

    function normalizeCadastralIds(values) {
        return normalizeIds(normalizeIds(values).map(cadastralRequestId));
    }

    function geometryFingerprint(value) {
        let json = '';
        try { json = JSON.stringify(value || null); } catch (_) { json = ''; }
        let hash = 2166136261;
        for (let index = 0; index < json.length; index += 1) {
            hash ^= json.charCodeAt(index);
            hash = Math.imul(hash, 16777619);
        }
        return `${json.length}:${(hash >>> 0).toString(36)}`;
    }

    function multiPolygonOfFootprints(footprints) {
        const polygons = [];
        (Array.isArray(footprints) ? footprints : []).forEach(entry => {
            const geometry = entry && (entry.type === 'Feature' ? entry.geometry : entry);
            if (!geometry || !Array.isArray(geometry.coordinates)) return;
            if (geometry.type === 'Polygon') polygons.push(geometry.coordinates);
            else if (geometry.type === 'MultiPolygon') geometry.coordinates.forEach(part => polygons.push(part));
        });
        return polygons.length ? { type: 'MultiPolygon', coordinates: polygons } : null;
    }

    function createCadastralGroundService(dependencies = {}) {
        const successfulFootprints = new Set();
        const footprintResults = new Map();
        const footprintInFlight = new Map();
        const idInFlight = new Map();
        // Cadastral facts live here, independently of Leaflet layers. A map layer can be hidden,
        // removed, or rebuilt without changing whether the application already owns the parcel's
        // geometry. Values are canonical WGS84 features retained before the presentation adapter;
        // maps are city-scoped because local parcel ids are not globally unique.
        const featuresByCity = new Map();
        const presentationInFlight = new Map();
        const knownMissingIds = new Set();

        const browserRoot = () => dependencies.root
            || ((global && global.window) ? global.window : global);
        const dependency = name => {
            if (Object.prototype.hasOwnProperty.call(dependencies, name)) return dependencies[name];
            const root = browserRoot();
            if (root && root[name] !== undefined) return root[name];
            return global ? global[name] : undefined;
        };
        // Capture the bridge once during service construction. The browser singleton deletes the
        // temporary global immediately afterwards, so feature code cannot discover or call the raw
        // transport even accidentally.
        const privateTransport = dependencies.transport || dependency('__cadastralGroundTransport') || null;
        const transport = () => privateTransport;
        const emit = (listener, event) => {
            if (typeof listener !== 'function') return;
            try { listener(Object.freeze({ ...event })); } catch (_) { /* progress is observational */ }
        };
        const cityKey = () => {
            try {
                const manager = dependency('CityConfigManager');
                const id = manager && typeof manager.getCurrentCityId === 'function'
                    ? manager.getCurrentCityId()
                    : null;
                if (id) return String(id);
            } catch (_) { }
            return 'current-city';
        };
        const scopedId = (scope, id) => `${scope}\u0000${String(id || '')}`;
        const footprintPrefix = scope => `${scope}:`;
        const inFlightForScope = (requests, scope, prefix) => Array.from(requests.entries())
            .filter(([key]) => String(key).startsWith(prefix(scope)))
            .map(([, request]) => request);
        const featureStore = scope => {
            const key = String(scope || cityKey());
            let store = featuresByCity.get(key);
            if (!store) {
                store = new Map();
                featuresByCity.set(key, store);
            }
            return store;
        };
        const featureId = feature => {
            if (!feature || typeof feature !== 'object') return '';
            const props = feature.properties || {};
            let value = props.parcelId ?? props.parcel_id ?? props.PARCEL_ID ?? props.id;
            if (value === undefined || value === null || value === '') {
                try {
                    const normalize = dependency('normalizeFeatureParcelId');
                    if (typeof normalize === 'function') value = normalize(feature);
                } catch (_) { }
            }
            if (value === undefined || value === null || value === '') return '';
            const raw = String(value);
            const cadastral = cadastralRequestId(raw);
            // Proposal output is disposable presentation, never cadastral ground.
            return cadastral && cadastral === raw ? cadastral : '';
        };
        const cloneFeature = feature => {
            if (!feature) return feature;
            if (typeof structuredClone === 'function') {
                try { return structuredClone(feature); } catch (_) { }
            }
            try { return JSON.parse(JSON.stringify(feature)); } catch (_) { return feature; }
        };
        const rememberFeatures = (features, options = {}) => {
            const scope = String(options.city || cityKey());
            const store = featureStore(scope);
            const remembered = [];
            (Array.isArray(features) ? features : []).forEach(feature => {
                const id = featureId(feature);
                if (!id) return;
                // First cadastral fact wins for the life of this city cache. Take ownership of a
                // copy: neither the transport response nor presentation code may later mutate the
                // retained ground identity/geometry.
                if (!store.has(id)) store.set(id, cloneFeature(feature));
                knownMissingIds.delete(scopedId(scope, id));
                remembered.push(id);
            });
            return normalizeIds(remembered);
        };
        const presentedLayer = (id, scope = cityKey()) => {
            const key = String(id || '');
            if (!key) return null;
            // The registry represents the current city. Never let a city switch satisfy an older
            // request with a coincidentally identical local id from the new city.
            if (scope !== cityKey()) return null;
            try {
                const resolve = dependency('resolveParcelLayerById');
                return typeof resolve === 'function' ? (resolve(key) || null) : null;
            } catch (_) { }
            return null;
        };
        const cachedFeature = (id, scope = cityKey()) => featureStore(scope).get(String(id || '')) || null;
        const presentCachedIds = async (values, options = {}) => {
            const scope = String(options.city || cityKey());
            if (scope !== cityKey()) return [];
            const ids = normalizeCadastralIds(values);
            const waiting = new Set();
            const toPresent = [];
            ids.forEach(id => {
                if (presentedLayer(id, scope)) return;
                const pending = presentationInFlight.get(scopedId(scope, id));
                if (pending) waiting.add(pending);
                else if (cachedFeature(id, scope)) toPresent.push(id);
            });
            if (toPresent.length) {
                const ingest = dependencies.ingestFeatures || dependency('ingestParcelFeatures');
                if (typeof ingest !== 'function') {
                    throw new Error('Cadastral ground presentation adapter is unavailable.');
                }
                emit(options.onProgress, {
                    phase: 'ground-present-cached-ids',
                    cached: toPresent.length,
                    total: ids.length
                });
                const features = toPresent.map(id => cloneFeature(cachedFeature(id, scope))).filter(Boolean);
                const task = Promise.resolve().then(() => ingest(features, {
                    skipConversion: true,
                    replaceExisting: false,
                    fromGroundCache: true
                }));
                toPresent.forEach(id => presentationInFlight.set(scopedId(scope, id), task));
                waiting.add(task);
                task.finally(() => {
                    toPresent.forEach(id => {
                        const key = scopedId(scope, id);
                        if (presentationInFlight.get(key) === task) presentationInFlight.delete(key);
                    });
                }).catch(() => undefined);
            }
            if (waiting.size) await Promise.all(Array.from(waiting));
            return ids.filter(id => !!presentedLayer(id, scope));
        };
        const acceptFeatures = async (features, options = {}) => {
            const values = Array.isArray(features) ? features.filter(Boolean) : [];
            if (!values.length) return [];
            const scope = String(options.city || cityKey());
            // A city changed while its request was in flight. Its source projection belongs to
            // the old city, so do not convert or present it using the new city's configuration.
            if (scope !== cityKey()) return [];
            let canonical = values;
            if (options.skipConversion !== true) {
                const convert = dependencies.convertFeatures || dependency('convertGeoJSON');
                if (typeof convert !== 'function') {
                    throw new Error('Cadastral ground conversion adapter is unavailable.');
                }
                const converted = convert({ type: 'FeatureCollection', features: values });
                canonical = Array.isArray(converted && converted.features) ? converted.features : [];
            }
            const ids = rememberFeatures(canonical, { city: scope });
            if (!ids.length) return [];
            const presentationIds = options.replaceExisting === true
                ? ids
                : ids.filter(id => !presentedLayer(id, scope));
            if (!presentationIds.length) return ids;
            const ingest = dependencies.ingestFeatures || dependency('ingestParcelFeatures');
            if (typeof ingest !== 'function') throw new Error('Cadastral ground presentation adapter is unavailable.');
            // The service keeps ownership of canonical facts. Leaflet receives independent copies,
            // so removing or mutating a map layer cannot corrupt the cache or cause a refetch.
            const presentationFeatures = presentationIds
                .map(id => cloneFeature(cachedFeature(id, scope)))
                .filter(Boolean);
            const { city: _city, ...presentationOptions } = options;
            await ingest(presentationFeatures, {
                ...presentationOptions,
                skipConversion: true
            });
            // Producers receive accepted cadastral ids, never renderer objects. This keeps the
            // transport/cache contract independent of Leaflet while still allowing viewport cells
            // to memoize membership without retaining another feature array.
            return ids;
        };
        const acceptTransportResult = async (result, ingestOptions = {}) => {
            if (!result || typeof result !== 'object') return result;
            const features = Array.isArray(result.features) ? result.features : [];
            if (features.length) {
                await acceptFeatures(features, { ...ingestOptions, ...(result.ingestOptions || {}) });
            }
            return result;
        };
        const summarizeTransportResult = result => {
            const ids = Object.freeze(normalizeIds(result?.ids));
            return Object.freeze({
                ids,
                coverage: result?.coverage === undefined ? null : result.coverage,
                count: Number(result?.count) || ids.length,
                queryMs: Number(result?.queryMs) || null
            });
        };
        const isReady = (id, scope = cityKey()) => {
            const key = String(id || '');
            if (!key || scope !== cityKey()) return false;
            return !!cachedFeature(key, scope) && !!presentedLayer(key, scope);
        };
        const footprintOf = record => {
            if (!record) return null;
            try {
                if (typeof dependencies.footprintOf === 'function') return dependencies.footprintOf(record);
                const order = browserRoot()?.__planOrder || dependency('__planOrder');
                return order && typeof order.footprintOf === 'function' ? order.footprintOf(record) : null;
            } catch (_) { return null; }
        };
        const baseIdsOf = record => {
            if (!record) return [];
            try {
                if (typeof dependencies.baseParcelIdsOf === 'function') {
                    return normalizeIds(dependencies.baseParcelIdsOf(record));
                }
                const claims = browserRoot()?.__claims || dependency('__claims');
                if (claims && typeof claims.baseParcelIdsOf === 'function') {
                    return normalizeIds(claims.baseParcelIdsOf(record));
                }
            } catch (_) { }
            return normalizeIds(normalizeIds([
                ...(Array.isArray(record.cadastreParcelIds) ? record.cadastreParcelIds : []),
                ...(Array.isArray(record.parentParcelIds) ? record.parentParcelIds : [])
            ]).map(id => id.split('#')[0]));
        };
        const footprintKeyOf = record => {
            const footprint = footprintOf(record);
            const geometry = footprint && (footprint.type === 'Feature' ? footprint.geometry : footprint);
            if (!geometry || !geometry.type) return { footprint: null, key: '' };
            return {
                footprint,
                key: `${cityKey()}:${geometryFingerprint(geometry)}`
            };
        };
        const retainedCoverageOf = record => {
            const scope = cityKey();
            const candidates = Array.from(featureStore(scope).entries())
                .map(([id, feature]) => ({ id, feature }));
            try {
                if (typeof dependencies.loadedCoverageOf === 'function') {
                    return dependencies.loadedCoverageOf(record, candidates);
                }
                const order = browserRoot()?.__planOrder || dependency('__planOrder');
                const t = dependency('turf');
                const footprint = footprintOf(record);
                if (!order || typeof order.computeBaseAncestry !== 'function'
                    || !t || typeof t.area !== 'function' || !footprint) return null;
                const footprintArea = Number(t.area(footprint));
                if (!(footprintArea > 0)) return null;
                const hits = order.computeBaseAncestry(footprint, candidates);
                const coveredArea = hits.reduce((sum, hit) => sum + (Number(hit?.area) || 0), 0);
                return {
                    ids: hits.map(hit => String(hit.id)),
                    coverage: Math.min(1, coveredArea / footprintArea)
                };
            } catch (_) { }
            return null;
        };

        async function ensureIds(parcelIds, options = {}) {
            const started = now();
            const ids = normalizeCadastralIds(parcelIds);
            const onProgress = options.onProgress;
            const scope = cityKey();
            emit(onProgress, { phase: 'ground-check-ids', total: ids.length });
            if (!ids.length) {
                return {
                    ids: [], cachedIds: [], restoredPresentationIds: [], requestedIds: [], waitingIds: [], missingIds: [], requestCount: 0,
                    elapsed: now() - started
                };
            }

            // Cached geometry is authoritative. Recreate a missing presentation only when the
            // service already retains the cadastral fact. Keeping the empty-cache path synchronous
            // registers the id request before another consumer can race it with a footprint request.
            const presentedBefore = new Set(ids.filter(id => !!presentedLayer(id, scope)));
            const needsPresentation = ids.some(id => (
                !presentedLayer(id, scope)
                && (cachedFeature(id, scope) || presentationInFlight.has(scopedId(scope, id)))
            ));
            if (needsPresentation) {
                await presentCachedIds(ids, { city: scope, onProgress });
            }

            // A footprint request may already be loading some or all of these ids. It cannot expose
            // that mapping before the server answers, so join it once and check the registry again
            // rather than racing it with a duplicate id request.
            const footprintRequests = inFlightForScope(footprintInFlight, scope, footprintPrefix);
            if (footprintRequests.length) {
                emit(onProgress, {
                    phase: 'ground-wait-footprints',
                    waiting: new Set(footprintRequests).size,
                    total: ids.length
                });
                await Promise.allSettled(Array.from(new Set(footprintRequests)));
                await presentCachedIds(ids, { city: scope, onProgress });
            }

            const cachedIds = ids.filter(id => !!cachedFeature(id, scope));
            const restoredPresentationIds = cachedIds.filter(id => (
                !presentedBefore.has(id) && !!presentedLayer(id, scope)
            ));
            const knownAbsent = ids.filter(id => (
                !cachedFeature(id, scope) && knownMissingIds.has(scopedId(scope, id))
            ));
            const waiting = new Set();
            const waitingIds = [];
            const requestedIds = [];
            ids.forEach(id => {
                const cacheKey = scopedId(scope, id);
                if (cachedFeature(id, scope) || knownMissingIds.has(cacheKey)) return;
                const pending = idInFlight.get(cacheKey);
                if (pending) {
                    waiting.add(pending);
                    waitingIds.push(id);
                }
                else requestedIds.push(id);
            });

            let ownRequest = null;
            if (requestedIds.length) {
                const fetchByIds = transport()?.fetchByIds;
                if (typeof fetchByIds !== 'function') {
                    throw new Error('Cadastral ground transport is unavailable.');
                }
                emit(onProgress, {
                    phase: 'ground-load-ids',
                    cached: cachedIds.length,
                    requested: requestedIds.length,
                    total: ids.length
                });
                ownRequest = Promise.resolve().then(() => fetchByIds(requestedIds, {
                    onProgress: (done, total) => emit(onProgress, {
                        phase: 'ground-load-ids-progress', done, total, requested: requestedIds.length
                    })
                })).then(async result => {
                    await acceptTransportResult(result, { city: scope, replaceExisting: true });
                    const responseIds = normalizeIds(result && Array.isArray(result.ids) ? result.ids : []);
                    responseIds.forEach(id => {
                        knownMissingIds.delete(scopedId(scope, id));
                    });
                    requestedIds.forEach(id => {
                        const cacheKey = scopedId(scope, id);
                        if (cachedFeature(id, scope)) knownMissingIds.delete(cacheKey);
                        else knownMissingIds.add(cacheKey);
                    });
                    return result;
                });
                requestedIds.forEach(id => idInFlight.set(scopedId(scope, id), ownRequest));
                waiting.add(ownRequest);
                ownRequest.finally(() => {
                    requestedIds.forEach(id => {
                        const cacheKey = scopedId(scope, id);
                        if (idInFlight.get(cacheKey) === ownRequest) idInFlight.delete(cacheKey);
                    });
                }).catch(() => undefined);
            } else if (waiting.size) {
                emit(onProgress, { phase: 'ground-wait-ids', waiting: waiting.size, total: ids.length });
            }

            if (waiting.size) await Promise.all(Array.from(waiting));
            await presentCachedIds(ids, { city: scope, onProgress });
            const missingIds = ids.filter(id => !isReady(id, scope));
            emit(onProgress, {
                phase: 'ground-ids-ready',
                cached: cachedIds.length,
                loaded: Math.max(0, ids.length - cachedIds.length - missingIds.length),
                missing: missingIds.length,
                total: ids.length
            });
            return {
                ids,
                cachedIds,
                restoredPresentationIds,
                requestedIds,
                waitingIds,
                knownAbsent,
                missingIds,
                requestCount: ownRequest ? 1 : 0,
                elapsed: now() - started
            };
        }

        async function ensureProposalGround(records, options = {}) {
            const members = (Array.isArray(records) ? records : []).filter(Boolean);
            const started = now();
            const onProgress = options.onProgress;
            const purpose = options.purpose || 'application';
            const scope = cityKey();
            const declaredByRecord = new Map(members.map(record => [record, baseIdsOf(record)]));
            // A flat applied record names its cadastral ground exactly. Publishing is the one
            // exception: it asks by authored footprint in order to ESTABLISH/verify that stamp.
            // This distinction prevents an application from first fetching declared ids and then
            // fetching the same ground again by geometry.
            const recordsUsingIds = purpose === 'publish'
                ? []
                : members.filter(record => (declaredByRecord.get(record) || []).length > 0);
            const allDeclaredIds = normalizeIds(recordsUsingIds.flatMap(record => declaredByRecord.get(record) || []));
            emit(onProgress, {
                phase: 'ground-check',
                members: members.length,
                parcelIds: allDeclaredIds.length,
                purpose
            });

            const idResult = allDeclaredIds.length
                ? await ensureIds(allDeclaredIds, { onProgress })
                : {
                    cachedIds: [], requestedIds: [], waitingIds: [], knownAbsent: [], missingIds: [],
                    requestCount: 0
                };

            // Another consumer may already be loading ids that cover an unstamped/publish
            // footprint. Join that one service-owned request, then measure local coverage below;
            // otherwise the same parcel can be requested once by id and once by geometry merely
            // because the two callers arrived a few milliseconds apart.
            const hasFootprintMembers = members.some(record => (
                purpose === 'publish' || !(declaredByRecord.get(record) || []).length
            ));
            if (hasFootprintMembers) {
                const idRequests = Array.from(new Set(inFlightForScope(
                    idInFlight,
                    scope,
                    currentScope => `${currentScope}\u0000`
                )));
                if (idRequests.length) {
                    emit(onProgress, {
                        phase: 'ground-wait-ids',
                        waiting: idRequests.length,
                        total: members.length
                    });
                    await Promise.allSettled(idRequests);
                }
            }
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
                parcels: 0,
                serverMs: 0,
                slowestMs: 0,
                slowest: null,
                refused: [],
                failed: 0,
                missingIds: idResult.missingIds.slice()
            };
            if (!members.length) return { ...profile, elapsed: now() - started };

            const pending = [];
            const pendingByKey = new Map();
            const existing = new Set();
            const waitingFootprints = [];
            const cachedIds = new Set(idResult.cachedIds || []);
            const requestedIds = new Set(idResult.requestedIds || []);
            const waitingIds = new Set(idResult.waitingIds || []);
            const missingIds = new Set(idResult.missingIds || []);
            const cachedFootprintIds = normalizeIds(members.flatMap(record => {
                const declared = declaredByRecord.get(record) || [];
                if (purpose !== 'publish' && declared.length) return [];
                const { key } = footprintKeyOf(record);
                const result = key ? footprintResults.get(key) : null;
                return result && Array.isArray(result.ids) ? result.ids : [];
            }));
            if (cachedFootprintIds.length) {
                await presentCachedIds(cachedFootprintIds, { city: scope, onProgress });
            }
            members.forEach(record => {
                const declared = declaredByRecord.get(record) || [];
                if (purpose !== 'publish' && declared.length) {
                    if (declared.some(id => requestedIds.has(id))) profile.loadedMembers += 1;
                    else if (declared.some(id => waitingIds.has(id))) profile.waitingMembers += 1;
                    else if (declared.every(id => cachedIds.has(id))) profile.cachedMembers += 1;
                    if (declared.some(id => missingIds.has(id))) profile.unavailableMembers += 1;
                    return;
                }

                const { footprint, key } = footprintKeyOf(record);
                if (key && successfulFootprints.has(key)) {
                    profile.cachedMembers += 1;
                    return;
                }

                const resolved = retainedCoverageOf(record);
                const coverage = Number(resolved && resolved.coverage);
                if (Number.isFinite(coverage) && coverage > COMPLETE_COVERAGE) {
                    const retainedIds = normalizeIds(resolved.ids)
                        .filter(id => !!cachedFeature(id, scope));
                    // The map may be a useful spatial index, but it is never a second source of
                    // cadastral facts. Coverage is reusable only when every contributing parcel is
                    // already retained by this service.
                    if (retainedIds.length === normalizeIds(resolved.ids).length) {
                        if (key) successfulFootprints.add(key);
                        if (key) footprintResults.set(key, summarizeTransportResult({
                            ids: retainedIds,
                            coverage,
                            count: retainedIds.length,
                            queryMs: null
                        }));
                        profile.cachedMembers += 1;
                        return;
                    }
                }

                // With no footprint, the exact ids above are the only honest request. Do not turn
                // them into a bounding box or invent a second fetch path.
                if (!footprint || !key) {
                    profile.unavailableMembers += 1;
                    return;
                }
                const inFlight = footprintInFlight.get(key);
                if (inFlight) {
                    existing.add(inFlight);
                    waitingFootprints.push({ key, request: inFlight });
                    profile.waitingMembers += 1;
                    return;
                }
                const queued = pendingByKey.get(key);
                if (queued) {
                    queued.memberCount += 1;
                    profile.waitingMembers += 1;
                    return;
                }
                const entry = { record, footprint, key, memberCount: 1 };
                pendingByKey.set(key, entry);
                pending.push(entry);
            });

            const loadBatch = async entries => {
                if (!entries.length) return;
                const geometry = multiPolygonOfFootprints(entries.map(entry => entry.footprint));
                const fetchUnderGeometry = transport()?.fetchUnderGeometry;
                if (!geometry || typeof fetchUnderGeometry !== 'function') {
                    profile.failed += entries.reduce((sum, entry) => sum + entry.memberCount, 0);
                    return;
                }
                const requestStarted = now();
                try {
                    const loaded = await fetchUnderGeometry(geometry, { parcelsOnly: true });
                    await acceptTransportResult(loaded, {
                        city: scope,
                        skipConversion: true,
                        replaceExisting: false
                    });
                    const took = now() - requestStarted;
                    profile.requests += 1;
                    profile.footprintRequests += 1;
                    if (took > profile.slowestMs) {
                        profile.slowestMs = took;
                        profile.slowest = entries.length;
                    }
                    if (!loaded) {
                        profile.failed += entries.reduce((sum, entry) => sum + entry.memberCount, 0);
                        return;
                    }
                    profile.parcels += Number(loaded.count) || 0;
                    profile.serverMs += Number(loaded.queryMs) || 0;
                    normalizeIds(loaded.ids).forEach(id => {
                        knownMissingIds.delete(scopedId(scope, id));
                    });
                    const summary = summarizeTransportResult(loaded);
                    entries.forEach(entry => {
                        successfulFootprints.add(entry.key);
                        footprintResults.set(entry.key, summary);
                    });
                } catch (error) {
                    const took = now() - requestStarted;
                    profile.requests += 1;
                    profile.footprintRequests += 1;
                    if (took > profile.slowestMs) {
                        profile.slowestMs = took;
                        profile.slowest = entries.length;
                    }
                    const overCap = /\b413\b/.test(String(error && error.message));
                    if (overCap) profile.refused.push(entries.length);
                    if (entries.length > 1) {
                        const middle = Math.ceil(entries.length / 2);
                        await loadBatch(entries.slice(0, middle));
                        await loadBatch(entries.slice(middle));
                        return;
                    }
                    profile.failed += entries[0].memberCount;
                    console.warn('[cadastral-ground] footprint request failed for', entries[0].key, error);
                }
            };

            const chunks = [];
            for (let index = 0; index < pending.length; index += FOOTPRINT_BATCH_SIZE) {
                chunks.push(pending.slice(index, index + FOOTPRINT_BATCH_SIZE));
            }
            const pendingMembers = pending.reduce((sum, entry) => sum + entry.memberCount, 0);
            if (chunks.length) {
                emit(onProgress, {
                    phase: 'ground-load-footprints',
                    members: pendingMembers,
                    batches: chunks.length,
                    cachedMembers: profile.cachedMembers
                });
            }

            let cursor = 0;
            let completedBatches = 0;
            const worker = async () => {
                while (cursor < chunks.length) {
                    const entries = chunks[cursor++];
                    const task = loadBatch(entries);
                    entries.forEach(entry => footprintInFlight.set(entry.key, task));
                    try { await task; }
                    finally {
                        entries.forEach(entry => {
                            if (footprintInFlight.get(entry.key) === task) footprintInFlight.delete(entry.key);
                        });
                    }
                    completedBatches += 1;
                    emit(onProgress, {
                        phase: 'ground-load-footprints-progress',
                        done: completedBatches,
                        total: chunks.length,
                        members: pendingMembers,
                        parcels: profile.parcels
                    });
                }
            };
            if (chunks.length) {
                const lanes = Math.min(FOOTPRINT_CONCURRENCY, chunks.length);
                await Promise.all(Array.from({ length: lanes }, worker));
            }
            if (existing.size) await Promise.all(Array.from(existing));

            const loadedFootprints = pending
                .filter(entry => successfulFootprints.has(entry.key))
                .reduce((sum, entry) => sum + entry.memberCount, 0);
            const joinedFootprints = waitingFootprints.filter(entry => successfulFootprints.has(entry.key)).length;
            const failedPendingMembers = pending
                .filter(entry => !successfulFootprints.has(entry.key))
                .reduce((sum, entry) => sum + entry.memberCount, 0);
            profile.loadedMembers += loadedFootprints;
            profile.unavailableMembers += failedPendingMembers
                + (waitingFootprints.length - joinedFootprints);
            profile.coveredMembers = profile.cachedMembers + joinedFootprints;
            profile.fetchedMembers = profile.loadedMembers;
            const elapsed = now() - started;
            emit(onProgress, {
                phase: 'ground-ready',
                members: members.length,
                cachedMembers: profile.cachedMembers,
                loadedMembers: profile.loadedMembers,
                waitingMembers: profile.waitingMembers,
                unavailableMembers: profile.unavailableMembers,
                idRequests: profile.idRequests,
                footprintRequests: profile.footprintRequests,
                missingIds: profile.missingIds.length,
                elapsed
            });
            return { ...profile, elapsed };
        }

        async function ensureFootprint(geometry, options = {}) {
            const geom = geometry && geometry.type === 'Feature' ? geometry.geometry : geometry;
            const record = options.record || { geometry: geom };
            if (!options.record) {
                const scope = cityKey();
                const key = `${scope}:${geometryFingerprint(geom)}`;

                // An id request may be loading the same ground. Once it settles, local coverage can
                // answer this footprint without a second server request.
                const idRequests = inFlightForScope(idInFlight, scope, currentScope => `${currentScope}\u0000`);
                if (idRequests.length) await Promise.allSettled(Array.from(new Set(idRequests)));

                const local = retainedCoverageOf(record);
                const localCoverage = Number(local && local.coverage);
                if (Number.isFinite(localCoverage) && localCoverage > COMPLETE_COVERAGE) {
                    const result = summarizeTransportResult({
                        ids: normalizeIds(local.ids),
                        coverage: localCoverage,
                        count: normalizeIds(local.ids).length,
                        queryMs: null
                    });
                    const retainedIds = result.ids.filter(id => !!cachedFeature(id, scope));
                    if (retainedIds.length === result.ids.length) {
                        const retained = summarizeTransportResult({
                            ...result,
                            ids: retainedIds,
                            count: retainedIds.length
                        });
                        successfulFootprints.add(key);
                        footprintResults.set(key, retained);
                        return { members: 1, coveredMembers: 1, requests: 0, result: retained, elapsed: 0 };
                    }
                }
                if (successfulFootprints.has(key)) {
                    const result = footprintResults.get(key) || null;
                    if (result && Array.isArray(result.ids)) {
                        await presentCachedIds(result.ids, { city: scope, onProgress: options.onProgress });
                    }
                    return {
                        members: 1,
                        coveredMembers: 1,
                        requests: 0,
                        result,
                        elapsed: 0
                    };
                }
                const pending = footprintInFlight.get(key);
                if (pending) return pending;
                const fetchUnderGeometry = transport()?.fetchUnderGeometry;
                if (typeof fetchUnderGeometry !== 'function') throw new Error('Cadastral ground transport is unavailable.');
                const started = now();
                const task = Promise.resolve()
                    .then(() => fetchUnderGeometry(geometry, { parcelsOnly: options.parcelsOnly !== false }))
                    .then(async result => {
                        if (!result) throw new Error('Cadastral footprint transport returned no result.');
                        await acceptTransportResult(result, {
                            city: scope,
                            skipConversion: true,
                            replaceExisting: false
                        });
                        const summary = summarizeTransportResult(result);
                        successfulFootprints.add(key);
                        footprintResults.set(key, summary);
                        return { members: 1, coveredMembers: 0, fetchedMembers: 1, requests: 1, result: summary, elapsed: now() - started };
                    })
                    .finally(() => { if (footprintInFlight.get(key) === task) footprintInFlight.delete(key); });
                footprintInFlight.set(key, task);
                return task;
            }
            return ensureProposalGround([record], { ...options, purpose: options.purpose || 'publish' });
        }

        function reset() {
            successfulFootprints.clear();
            footprintResults.clear();
            footprintInFlight.clear();
            idInFlight.clear();
            presentationInFlight.clear();
            featuresByCity.clear();
            knownMissingIds.clear();
        }

        return Object.freeze({
            ensureIds,
            ensureProposalGround,
            ensureFootprint,
            acceptFeatures,
            reset,
            snapshot: () => {
                const prefix = `${cityKey()}\u0000`;
                const currentIds = values => new Set(Array.from(values)
                    .filter(value => String(value).startsWith(prefix))
                    .map(value => String(value).slice(prefix.length)));
                return {
                    loadedIds: new Set(featureStore(cityKey()).keys()),
                    missingIds: currentIds(knownMissingIds),
                    footprintCount: successfulFootprints.size,
                    featureCount: featureStore(cityKey()).size,
                    idRequestsInFlight: idInFlight.size,
                    footprintRequestsInFlight: footprintInFlight.size
                };
            }
        });
    }

    const service = createCadastralGroundService();
    if (global) {
        try { delete global.__cadastralGroundTransport; } catch (_) { global.__cadastralGroundTransport = undefined; }
        global.CadastralGroundService = service;
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = {
            COMPLETE_COVERAGE,
            FOOTPRINT_BATCH_SIZE,
            FOOTPRINT_CONCURRENCY,
            createCadastralGroundService,
            CadastralGroundService: service,
            cadastralRequestId,
            geometryFingerprint,
            multiPolygonOfFootprints
        };
    }
})(typeof window !== 'undefined' ? window : globalThis);
