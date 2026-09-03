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
    let mutationSequence = 1;
    let mutationTail = Promise.resolve();

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

    function serializeStore(store, draft) {
        if (!store || !draft || typeof store.serializeMutationDraft !== 'function') return null;
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
        const setItem = (rawKey, rawValue) => {
            const key = String(rawKey == null ? '' : rawKey);
            if (!key) throw new TypeError('Mutation storage key cannot be empty.');
            remember(key);
            deletes.delete(key);
            puts.set(key, String(rawValue == null ? '' : rawValue));
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

        const context = Object.freeze({
            meta: Object.freeze({ ...(meta || {}) }),
            proposals: proposalDraft,
            agents: agentDraft,
            fabric: fabricMutation,
            storage: storageDraft,
            collections: collectionDraft.draft,
            afterCommit(callback) {
                if (typeof callback !== 'function') throw new TypeError('afterCommit requires a function.');
                afterCommitCallbacks.push(callback);
            }
        });

        try {
            const result = await operation(context);
            if (result === false) {
                fabricMutation?.rollback?.();
                return false;
            }

            if (fabricMutation) {
                await fabricMutation.prepare();
                preparedFabric = true;
            }

            addSerializedChange(serializeStore(dependencies.proposalStore, proposalDraft), storageDraft);
            addSerializedChange(serializeStore(dependencies.agentStore, agentDraft), storageDraft);
            const durableChange = {
                puts: storageDraft._change.puts,
                deletes: Array.from(storageDraft._change.deletes)
            };
            if (durableChange.puts.size || durableChange.deletes.length) {
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
