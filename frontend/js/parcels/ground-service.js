// The one application-level boundary for cadastral ground reads.
//
// Consumers describe the ground they need. This service alone decides whether that ground is
// already in the immutable parcel registry, is being loaded by another consumer, was previously
// found to be absent, or must be requested from the server. Keeping those decisions here prevents
// a shared-plan import, replay, editor, block selection, and financial calculation from each
// maintaining a subtly different cache and fetching the same parcels again. parcels/fetch.js is
// the transport/ingest implementation below this boundary; no feature consumer calls it directly.
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
    // service policy and therefore belongs here, beside the cache and transport decision. A stale
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
        const knownLoadedIds = new Set();
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
        const isReady = (id, scope = cityKey()) => {
            const key = String(id || '');
            if (!key) return false;
            const cacheKey = scopedId(scope, key);
            if (knownLoadedIds.has(cacheKey)) return true;
            // The registry represents the current city. Never let a city switch satisfy an older
            // request with a coincidentally identical local id from the new city.
            if (scope !== cityKey()) return false;
            try {
                const resolve = dependency('resolveParcelLayerById');
                if (typeof resolve === 'function' && resolve(key)) {
                    knownLoadedIds.add(cacheKey);
                    knownMissingIds.delete(cacheKey);
                    return true;
                }
            } catch (_) { }
            return false;
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
        const loadedCoverageOf = record => {
            try {
                if (typeof dependencies.loadedCoverageOf === 'function') {
                    return dependencies.loadedCoverageOf(record);
                }
                const ancestry = browserRoot()?.__cadastreAncestry || dependency('__cadastreAncestry');
                if (ancestry && typeof ancestry.loadedCadastreCoverage === 'function') {
                    return ancestry.loadedCadastreCoverage(record);
                }
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
                    ids: [], cachedIds: [], requestedIds: [], waitingIds: [], missingIds: [], requestCount: 0,
                    elapsed: now() - started
                };
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
            }

            const cachedIds = ids.filter(id => isReady(id, scope));
            const knownAbsent = ids.filter(id => (
                !isReady(id, scope) && knownMissingIds.has(scopedId(scope, id))
            ));
            const waiting = new Set();
            const waitingIds = [];
            const requestedIds = [];
            ids.forEach(id => {
                const cacheKey = scopedId(scope, id);
                if (isReady(id, scope) || knownMissingIds.has(cacheKey)) return;
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
                })).then(result => {
                    const responseIds = normalizeIds(result && Array.isArray(result.ids) ? result.ids : []);
                    responseIds.forEach(id => {
                        knownLoadedIds.add(scopedId(scope, id));
                        knownMissingIds.delete(scopedId(scope, id));
                    });
                    requestedIds.forEach(id => {
                        const cacheKey = scopedId(scope, id);
                        if (isReady(id, scope)) knownMissingIds.delete(cacheKey);
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

                const resolved = loadedCoverageOf(record);
                const coverage = Number(resolved && resolved.coverage);
                if (Number.isFinite(coverage) && coverage > COMPLETE_COVERAGE) {
                    normalizeIds(resolved.ids).forEach(id => knownLoadedIds.add(scopedId(scope, id)));
                    if (key) successfulFootprints.add(key);
                    profile.cachedMembers += 1;
                    return;
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
                        knownLoadedIds.add(scopedId(scope, id));
                        knownMissingIds.delete(scopedId(scope, id));
                    });
                    entries.forEach(entry => successfulFootprints.add(entry.key));
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

                const local = loadedCoverageOf(record);
                const localCoverage = Number(local && local.coverage);
                if (Number.isFinite(localCoverage) && localCoverage > COMPLETE_COVERAGE) {
                    const result = {
                        ids: normalizeIds(local.ids),
                        coverage: localCoverage,
                        count: normalizeIds(local.ids).length,
                        queryMs: null
                    };
                    result.ids.forEach(id => knownLoadedIds.add(scopedId(scope, id)));
                    successfulFootprints.add(key);
                    footprintResults.set(key, result);
                    return { members: 1, coveredMembers: 1, requests: 0, result, elapsed: 0 };
                }
                if (successfulFootprints.has(key)) {
                    return {
                        members: 1,
                        coveredMembers: 1,
                        requests: 0,
                        result: footprintResults.get(key) || null,
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
                    .then(result => {
                        if (!result) throw new Error('Cadastral footprint transport returned no result.');
                        successfulFootprints.add(key);
                        footprintResults.set(key, result);
                        normalizeIds(result && result.ids)
                            .forEach(id => knownLoadedIds.add(scopedId(scope, id)));
                        return { members: 1, coveredMembers: 0, fetchedMembers: 1, requests: 1, result, elapsed: now() - started };
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
            knownLoadedIds.clear();
            knownMissingIds.clear();
        }

        return Object.freeze({
            ensureIds,
            ensureProposalGround,
            ensureFootprint,
            reset,
            snapshot: () => {
                const prefix = `${cityKey()}\u0000`;
                const currentIds = values => new Set(Array.from(values)
                    .filter(value => String(value).startsWith(prefix))
                    .map(value => String(value).slice(prefix.length)));
                return {
                    loadedIds: currentIds(knownLoadedIds),
                    missingIds: currentIds(knownMissingIds),
                    footprintCount: successfulFootprints.size,
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
