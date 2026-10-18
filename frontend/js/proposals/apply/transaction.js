// One serialized, durable mutation boundary for authored proposal state and the live parcel
// fabric. Operation bodies receive private drafts; ordinary application readers continue to see
// the previous committed revision until persistence and every publication participant succeed.
(function attachParcelMutation(root, factory) {
    const api = factory(root || globalThis);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ParcelMutation = api.ParcelMutation;
})(typeof window !== 'undefined' ? window : globalThis, function parcelMutationFactory(root) {
    'use strict';

    const COLLECTION_NAMES = Object.freeze([
        'parks', 'squares', 'lakes', 'transitStations', 'proposedBuildings'
    ]);
    // Deadline for the pre-commit phase (operation body + fabric prepare). A body that never
    // settles — a hung ground fetch — used to block every later mutation in the FIFO forever.
    // Generous on purpose: a 661-parcel corridor apply once profiled at 47 s. Override per call
    // with `overrides.timeoutMs` (ProposalManager: `options.mutationTimeoutMs`) or globally with
    // `window.PARCEL_MUTATION_TIMEOUT_MS`.
    const PARCEL_MUTATION_TIMEOUT_MS = 120000;
    // A mutation that reports its progress (`overrides.progressTimeoutMs`: the boot replay) has no
    // total limit instead: it is rolled back only when `context.progress()` has not been called for
    // that long. A slow phone finishing a long replay is not a stall; a hung ground fetch is.
    let mutationSequence = 1;
    const workSlicer = (root && root.__workSlicer) || (typeof require === 'function' ? require('../../work-slicer.js') : null);
    let mutationTail = Promise.resolve();

    function positiveMs(value) {
        return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
    }

    function resolveTimeoutMs(overrides, runtime) {
        return positiveMs(overrides?.timeoutMs)
            ?? positiveMs(runtime?.PARCEL_MUTATION_TIMEOUT_MS)
            ?? PARCEL_MUTATION_TIMEOUT_MS;
    }

    function clock() {
        return typeof performance !== 'undefined' && performance && typeof performance.now === 'function'
            ? performance.now()
            : Date.now();
    }

    function clone(value) {
        if (value === undefined || value === null) return value;
        if (typeof structuredClone === 'function') {
            try { return structuredClone(value); } catch (_) { /* JSON fallback */ }
        }
        return JSON.parse(JSON.stringify(value));
    }

    function cloneMap(source) {
        return source instanceof Map
            ? new Map(Array.from(source, ([key, value]) => [key, clone(value)]))
            : new Map();
    }

    function replaceMap(target, source) {
        if (!(target instanceof Map) || !(source instanceof Map)) return;
        target.clear();
        source.forEach((value, key) => target.set(key, clone(value)));
    }

    function defaultStoreSnapshot(store, mapKey) {
        if (!store || !(store[mapKey] instanceof Map)) return null;
        return {
            records: cloneMap(store[mapKey]),
            nextProposalId: store.nextProposalId,
            blockedWriteCount: store._blockedWriteCount
        };
    }

    function snapshotStore(store, mapKey) {
        if (!store) return null;
        if (typeof store.snapshotForMutation === 'function') return store.snapshotForMutation();
        return defaultStoreSnapshot(store, mapKey);
    }

    function draftStore(store, mapKey, snapshot) {
        if (!store || !snapshot) return null;
        if (typeof store.createMutationDraft === 'function') return store.createMutationDraft(snapshot);
        const draft = Object.create(store);
        draft[mapKey] = cloneMap(snapshot.records);
        if (snapshot.nextProposalId !== undefined) draft.nextProposalId = snapshot.nextProposalId;
        draft._suspendSaveCount = 0;
        draft._hasPendingSave = false;
        draft.save = () => { draft._hasPendingSave = true; };
        draft._persist = draft.save;
        draft.beginBatch = () => {};
        draft.endBatch = () => {};
        return draft;
    }

    // A store with many records serializes in steps (proposals/data.js): in slices when the
    // mutation carries a slicer (the boot replay), in one go otherwise.
    async function serializeStore(store, draft, slicer) {
        if (!store || !draft) return null;
        if (typeof store.serializeMutationDraftSteps === 'function') {
            const steps = store.serializeMutationDraftSteps(draft);
            return slicer ? workSlicer.runSliced(steps, slicer) : workSlicer.runToCompletion(steps);
        }
        if (typeof store.serializeMutationDraft !== 'function') return null;
        return store.serializeMutationDraft(draft);
    }

    function publishStore(store, mapKey, draft) {
        if (!store || !draft) return;
        if (typeof store.publishMutationDraft === 'function') {
            store.publishMutationDraft(draft);
            return;
        }
        replaceMap(store[mapKey], draft[mapKey]);
        if (draft.nextProposalId !== undefined) store.nextProposalId = draft.nextProposalId;
    }

    function restoreStore(store, mapKey, snapshot) {
        if (!store || !snapshot) return;
        if (typeof store.restoreMutationSnapshot === 'function') {
            store.restoreMutationSnapshot(snapshot);
            return;
        }
        replaceMap(store[mapKey], snapshot.records);
        if (snapshot.nextProposalId !== undefined) store.nextProposalId = snapshot.nextProposalId;
        if (snapshot.blockedWriteCount !== undefined) store._blockedWriteCount = snapshot.blockedWriteCount;
    }

    function createCollectionDraft(runtime) {
        const before = {};
        const draft = {};
        COLLECTION_NAMES.forEach(name => {
            before[name] = runtime ? runtime[name] : undefined;
            draft[name] = Array.isArray(runtime && runtime[name]) ? runtime[name].slice() : [];
        });
        return { before, draft };
    }

    function publishCollections(runtime, collections) {
        Object.entries(collections.draft).forEach(([name, entries]) => {
            runtime[name] = entries.slice();
        });
    }

    function restoreCollections(runtime, collections) {
        Object.entries(collections.before).forEach(([name, entries]) => {
            if (entries === undefined) delete runtime[name];
            else runtime[name] = entries;
        });
    }

    function createStorageDraft(storage) {
        const puts = new Map();
        const deletes = new Set();
        const touchedPreimage = new Map();

        const remember = key => {
            if (!touchedPreimage.has(key)) touchedPreimage.set(key, storage?.getItem?.(key));
        };
        const getItem = rawKey => {
            const key = String(rawKey == null ? '' : rawKey);
            if (deletes.has(key)) return null;
            if (puts.has(key)) return puts.get(key);
            return storage?.getItem?.(key) ?? null;
        };
        // A value equal to the committed one is not a change. A replay re-serializes every record
        // it re-derived and rewrote ~4 MB of identical rows on each reload; now it writes none.
        const setItem = (rawKey, rawValue) => {
            const key = String(rawKey == null ? '' : rawKey);
            if (!key) throw new TypeError('Mutation storage key cannot be empty.');
            const value = String(rawValue == null ? '' : rawValue);
            deletes.delete(key);
            if ((storage?.getItem?.(key) ?? null) === value) {
                puts.delete(key);
                return;
            }
            remember(key);
            puts.set(key, value);
        };
        const removeItem = rawKey => {
            const key = String(rawKey == null ? '' : rawKey);
            if (!key) throw new TypeError('Mutation storage key cannot be empty.');
            remember(key);
            puts.delete(key);
            deletes.add(key);
        };
        const entries = () => {
            const result = new Map();
            storage?.forEach?.((value, key) => result.set(String(key), value));
            deletes.forEach(key => result.delete(key));
            puts.forEach((value, key) => result.set(key, value));
            return result;
        };

        return Object.freeze({
            getItem,
            setItem,
            removeItem,
            forEach(iterator) { entries().forEach((value, key) => iterator(value, key)); },
            key(index) { return Array.from(entries().keys())[Number(index)] ?? null; },
            get length() { return entries().size; },
            _change: { puts, deletes },
            _preimage: touchedPreimage
        });
    }

    function addSerializedChange(serialized, storageDraft) {
        if (!serialized) return;
        const entries = Array.isArray(serialized) ? serialized : [serialized];
        entries.forEach(entry => {
            if (!entry || !entry.key) return;
            if (entry.delete === true) storageDraft.removeItem(entry.key);
            else storageDraft.setItem(entry.key, entry.value);
        });
    }

    function compensationFor(storageDraft) {
        const puts = new Map();
        const deletes = [];
        storageDraft._preimage.forEach((value, key) => {
            if (value === null || value === undefined) deletes.push(key);
            else puts.set(key, value);
        });
        return { puts, deletes };
    }

    function resolveDependencies(overrides = {}) {
        const runtime = overrides.runtime || root;
        const own = key => Object.prototype.hasOwnProperty.call(overrides, key);
        return {
            runtime,
            storage: own('storage') ? overrides.storage : (runtime?.PersistentStorage || null),
            proposalStore: own('proposalStore') ? overrides.proposalStore : (runtime?.proposalStorage || null),
            agentStore: own('agentStore') ? overrides.agentStore : (runtime?.agentStorage || null),
            fabric: own('fabric') ? overrides.fabric : (runtime?.LiveParcelFabric || null)
        };
    }

    async function execute(meta, operation, overrides) {
        const dependencies = resolveDependencies(overrides);
        const proposalBefore = snapshotStore(dependencies.proposalStore, 'proposals');
        const agentBefore = snapshotStore(dependencies.agentStore, 'agents');
        const proposalDraft = draftStore(dependencies.proposalStore, 'proposals', proposalBefore);
        const agentDraft = draftStore(dependencies.agentStore, 'agents', agentBefore);
        const collectionDraft = createCollectionDraft(dependencies.runtime);
        const storageDraft = createStorageDraft(dependencies.storage);
        const fabricMutation = dependencies.fabric?.beginMutation?.({
            ...meta,
            id: `parcel-mutation-${mutationSequence++}`
        }) || null;
        const afterCommitCallbacks = [];
        let preparedFabric = false;
        let durableCommitted = false;
        let published = false;

        // Cancellation token. Once the deadline fires this mutation is dead: the fabric draft is
        // rolled back (its writes then throw `live-fabric-mutation-inactive`), `signal` aborts,
        // afterCommit refuses, and execute() has already rejected — so a body that resolves late
        // has nothing left that could publish or persist its drafts.
        const progressTimeoutMs = positiveMs(overrides?.progressTimeoutMs);
        const timeoutMs = progressTimeoutMs ?? resolveTimeoutMs(overrides, dependencies.runtime);
        // The boot replay's slicer (work-slicer.js): every step of the mutation, the fabric's
        // prepare and the serialization below run in its clock-checked, background-priority slices.
        const slicer = overrides?.slicer || null;
        const abortController = typeof AbortController === 'function' ? new AbortController() : null;
        let timeoutError = null;
        let deadlineTimer = null;
        let lastProgressAt = clock();
        const deadline = new Promise((_, reject) => {
            const expire = () => {
                // Progress since the timer was armed moves the deadline instead of firing it.
                const idleMs = clock() - lastProgressAt;
                if (progressTimeoutMs && idleMs < progressTimeoutMs) {
                    deadlineTimer = setTimeout(expire, progressTimeoutMs - idleMs);
                    return;
                }
                const kind = meta?.kind || 'unknown';
                timeoutError = new Error(progressTimeoutMs
                    ? `Parcel mutation "${kind}" made no progress for ${timeoutMs} ms; it was rolled back and the mutation queue moved on.`
                    : `Parcel mutation "${kind}" did not settle within ${timeoutMs} ms; it was rolled back and the mutation queue moved on.`);
                timeoutError.code = progressTimeoutMs ? 'parcel-mutation-stalled' : 'parcel-mutation-timeout';
                timeoutError.timeoutMs = timeoutMs;
                timeoutError.meta = { ...(meta || {}) };
                console.error(`[${new Date().toISOString()}] [ParcelMutation] ${timeoutError.message}`, timeoutError.meta);
                try { fabricMutation?.rollback?.(); } catch (_) { /* the rejection below is the failure */ }
                try { abortController?.abort(timeoutError); } catch (_) { /* best-effort signal */ }
                reject(timeoutError);
            };
            deadlineTimer = setTimeout(expire, timeoutMs);
        });
        const withinDeadline = work => Promise.race([work, deadline]);
        const stopDeadline = () => {
            if (deadlineTimer !== null) clearTimeout(deadlineTimer);
            deadlineTimer = null;
        };

        const context = Object.freeze({
            meta: Object.freeze({ ...(meta || {}) }),
            proposals: proposalDraft,
            agents: agentDraft,
            fabric: fabricMutation,
            storage: storageDraft,
            collections: collectionDraft.draft,
            signal: abortController ? abortController.signal : null,
            get cancelled() { return timeoutError !== null; },
            slicer,
            // Moves a progress deadline (`progressTimeoutMs`); a total deadline ignores it.
            progress() { lastProgressAt = clock(); },
            afterCommit(callback) {
                if (typeof callback !== 'function') throw new TypeError('afterCommit requires a function.');
                if (timeoutError) throw timeoutError;
                afterCommitCallbacks.push(callback);
            }
        });

        try {
            const result = await withinDeadline(Promise.resolve().then(() => operation(context)));
            if (result === false) {
                stopDeadline();
                fabricMutation?.rollback?.();
                return false;
            }

            if (fabricMutation) {
                await withinDeadline(fabricMutation.prepare({ slicer }));
                preparedFabric = true;
            }
            // Past this point the change is durable-bound. An IndexedDB write cannot be withdrawn,
            // so the deadline does not race it (a late durable commit would diverge from memory).
            stopDeadline();
            if (timeoutError) throw timeoutError;

            addSerializedChange(await serializeStore(dependencies.proposalStore, proposalDraft, slicer), storageDraft);
            addSerializedChange(await serializeStore(dependencies.agentStore, agentDraft, slicer), storageDraft);
            const durableChange = {
                puts: storageDraft._change.puts,
                deletes: Array.from(storageDraft._change.deletes)
            };
            // A read-only tab (multi-tab-guard.js: this city is open in another tab) must not write the
            // shared rows — the other tab would never see the change and its next save would clobber
            // or be clobbered. The mutation still applies here, and is parked for recovery, as a
            // read-only tab's ordinary saves are (proposals/data.js _persist).
            const readOnly = !!dependencies.runtime?.__cbSecondaryTab;
            if (readOnly && (durableChange.puts.size || durableChange.deletes.length)) {
                console.error(`[${new Date().toISOString()}] [ParcelMutation] This tab is read-only (the city is open in another tab): `
                    + `${durableChange.puts.size} write(s) of this change are parked for recovery, not saved.`);
                afterCommitCallbacks.push(() => {
                    dependencies.proposalStore?._persistRecovery?.();
                    try { dependencies.runtime?.__cbReportSecondaryWriteBlocked?.(); } catch (_) { }
                });
            } else if (durableChange.puts.size || durableChange.deletes.length) {
                if (!dependencies.storage || typeof dependencies.storage.atomicWrite !== 'function') {
                    const error = new Error('PersistentStorage.atomicWrite is required for parcel mutations.');
                    error.code = 'parcel-mutation-atomic-storage-unavailable';
                    throw error;
                }
                await dependencies.storage.atomicWrite(durableChange);
                durableCommitted = true;
            }

            try {
                publishStore(dependencies.proposalStore, 'proposals', proposalDraft);
                publishStore(dependencies.agentStore, 'agents', agentDraft);
                publishCollections(dependencies.runtime, collectionDraft);
                fabricMutation?.publish();
                published = true;
            } catch (publicationError) {
                restoreStore(dependencies.proposalStore, 'proposals', proposalBefore);
                restoreStore(dependencies.agentStore, 'agents', agentBefore);
                restoreCollections(dependencies.runtime, collectionDraft);
                try { fabricMutation?.rollback?.(); } catch (_) { /* preserve publication failure */ }
                if (durableCommitted) {
                    try {
                        await dependencies.storage.atomicWrite(compensationFor(storageDraft));
                    } catch (compensationError) {
                        publicationError.compensationError = compensationError;
                    }
                }
                throw publicationError;
            }

            for (const callback of afterCommitCallbacks) {
                // A slice ends between the publication and each presentation step. Committed: a
                // cancelled slicer no longer stops anything, the presentation finishes.
                if (slicer && slicer.due() && !slicer.cancelled) {
                    try { await slicer.pause(); } catch (_) { /* cancelled while yielding */ }
                }
                try { await callback(result); }
                catch (error) { console.error('[ParcelMutation] after-commit callback failed', error); }
            }
            return result;
        } catch (error) {
            if (!published) {
                try { fabricMutation?.rollback?.(); } catch (_) { /* preserve primary failure */ }
            }
            throw error;
        } finally {
            stopDeadline();
            if (preparedFabric && !published) {
                try { fabricMutation?.rollback?.(); } catch (_) { }
            }
        }
    }

    const ParcelMutation = Object.freeze({
        run(meta, operation, overrides) {
            if (typeof operation !== 'function') {
                return Promise.reject(new TypeError('ParcelMutation.run requires an operation function.'));
            }
            const queued = mutationTail.then(
                () => execute(meta || {}, operation, overrides),
                () => execute(meta || {}, operation, overrides)
            );
            mutationTail = queued.catch(() => undefined);
            return queued;
        }
    });

    return Object.freeze({ ParcelMutation });
});
