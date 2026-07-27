// Transaction coordinator for proposal map mutations. Apply/unapply touches three state surfaces:
// the proposal store, parcel records, and Leaflet presentation. This module supplies one serialized
// root boundary, a rollback journal, and dependency-light snapshot helpers. Nested proposal
// operations receive the root transaction explicitly through their options, so they either all
// commit or all roll back together.
(function attachProposalMutationTransactions(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ProposalMutationTransactions = api;
})(typeof window !== 'undefined' ? window : globalThis, function proposalMutationTransactionsFactory() {
    'use strict';

    let nextTransactionId = 1;
    let rootQueue = Promise.resolve();

    function cloneValue(value) {
        if (value === undefined || value === null) return value;
        if (typeof structuredClone === 'function') {
            try { return structuredClone(value); } catch (_) { /* JSON fallback */ }
        }
        return JSON.parse(JSON.stringify(value));
    }

    function replaceObjectContents(target, source) {
        if (!target || typeof target !== 'object' || Array.isArray(target)) return cloneValue(source);
        Object.keys(target).forEach(key => { delete target[key]; });
        Object.assign(target, cloneValue(source));
        return target;
    }

    function snapshotRecordMap(recordMap) {
        if (!(recordMap instanceof Map)) return null;
        return Array.from(recordMap.entries(), ([key, value]) => [key, cloneValue(value)]);
    }

    function restoreRecordMap(recordMap, snapshot) {
        if (!(recordMap instanceof Map) || !Array.isArray(snapshot)) return false;
        const wanted = new Map(snapshot);
        for (const key of Array.from(recordMap.keys())) {
            if (!wanted.has(key)) recordMap.delete(key);
        }
        for (const [key, saved] of snapshot) {
            const current = recordMap.get(key);
            if (current && typeof current === 'object' && !Array.isArray(current)) {
                replaceObjectContents(current, saved);
                recordMap.set(key, current);
            } else {
                recordMap.set(key, cloneValue(saved));
            }
        }
        return true;
    }

    function layerList(group) {
        if (!group) return [];
        if (typeof group.getLayers === 'function') {
            try { return group.getLayers().slice(); } catch (_) { return []; }
        }
        if (typeof group.eachLayer === 'function') {
            const layers = [];
            try { group.eachLayer(layer => layers.push(layer)); } catch (_) { return []; }
            return layers;
        }
        return [];
    }

    function snapshotParcelPresentation(browserRoot) {
        if (!browserRoot || typeof browserRoot !== 'object') return null;
        const index = browserRoot.parcelLayerById instanceof Map
            ? Array.from(browserRoot.parcelLayerById.entries())
            : null;
        const group = browserRoot.parcelLayer || null;
        return { index, group, visibleLayers: layerList(group) };
    }

    function restoreParcelPresentation(browserRoot, snapshot) {
        if (!browserRoot || !snapshot) return false;
        const group = snapshot.group;
        if (group) {
            const wanted = new Set(snapshot.visibleLayers || []);
            for (const layer of layerList(group)) {
                if (!wanted.has(layer) && typeof group.removeLayer === 'function') {
                    try { group.removeLayer(layer); } catch (_) { /* best effort */ }
                }
            }
            for (const layer of wanted) {
                const present = typeof group.hasLayer === 'function'
                    ? group.hasLayer(layer)
                    : layerList(group).includes(layer);
                if (!present && typeof group.addLayer === 'function') {
                    try { group.addLayer(layer); } catch (_) { /* best effort */ }
                }
            }
        }

        if (Array.isArray(snapshot.index) && browserRoot.parcelLayerById instanceof Map) {
            browserRoot.parcelLayerById.clear();
            snapshot.index.forEach(([key, layer]) => browserRoot.parcelLayerById.set(key, layer));
        }
        return true;
    }

    class MutationTransaction {
        constructor(meta = {}) {
            this.id = nextTransactionId++;
            this.meta = { ...meta };
            this.state = 'active';
            this.rollbackErrors = [];
            this._rollback = [];
            this._commit = [];
            this._finally = [];
        }

        deferRollback(label, action) {
            if (typeof label === 'function') {
                action = label;
                label = `rollback-${this._rollback.length + 1}`;
            }
            if (this.state !== 'active' || typeof action !== 'function') {
                throw new Error('Cannot register rollback work on an inactive transaction.');
            }
            this._rollback.push({ label: String(label || 'rollback'), action });
        }

        deferCommit(label, action) {
            if (typeof label === 'function') {
                action = label;
                label = `commit-${this._commit.length + 1}`;
            }
            if (this.state !== 'active' || typeof action !== 'function') {
                throw new Error('Cannot register commit work on an inactive transaction.');
            }
            this._commit.push({ label: String(label || 'commit'), action });
        }

        deferFinally(label, action) {
            if (typeof label === 'function') {
                action = label;
                label = `finally-${this._finally.length + 1}`;
            }
            if (this.state !== 'active' || typeof action !== 'function') {
                throw new Error('Cannot register final work on an inactive transaction.');
            }
            this._finally.push({ label: String(label || 'finally'), action });
        }

        async commit() {
            if (this.state !== 'active') return;
            this.state = 'committing';
            for (const entry of this._commit) await entry.action();
            this._rollback.length = 0;
            this.state = 'committed';
        }

        async rollback(cause) {
            if (this.state === 'rolled-back' || this.state === 'committed') return;
            this.state = 'rolling-back';
            for (let i = this._rollback.length - 1; i >= 0; i -= 1) {
                const entry = this._rollback[i];
                try {
                    await entry.action(cause);
                } catch (error) {
                    this.rollbackErrors.push({ label: entry.label, error });
                }
            }
            this._rollback.length = 0;
            this.state = 'rolled-back';
        }

        async finalize() {
            const errors = [];
            for (let i = this._finally.length - 1; i >= 0; i -= 1) {
                const entry = this._finally[i];
                try {
                    await entry.action();
                } catch (error) {
                    errors.push({ label: entry.label, error });
                }
            }
            this._finally.length = 0;
            if (errors.length) {
                const error = new Error(`Proposal mutation finalization failed: ${errors.map(item => item.label).join(', ')}`);
                error.finalizationErrors = errors;
                throw error;
            }
        }
    }

    function isActiveTransaction(value) {
        return value instanceof MutationTransaction && value.state === 'active';
    }

    async function executeRoot(meta, operation) {
        const transaction = new MutationTransaction(meta);
        let primaryError = null;
        try {
            const result = await operation(transaction);
            if (result === false) {
                await transaction.rollback(new Error('Proposal mutation returned false.'));
                return false;
            }
            await transaction.commit();
            return result;
        } catch (error) {
            primaryError = error;
            await transaction.rollback(error);
            if (transaction.rollbackErrors.length) error.rollbackErrors = transaction.rollbackErrors.slice();
            throw error;
        } finally {
            try {
                await transaction.finalize();
            } catch (finalizationError) {
                if (primaryError) {
                    primaryError.finalizationErrors = finalizationError.finalizationErrors || [finalizationError];
                } else {
                    throw finalizationError;
                }
            }
        }
    }

    function enqueue(meta, operation) {
        if (typeof operation !== 'function') {
            return Promise.reject(new TypeError('Proposal mutation requires an operation function.'));
        }
        const queued = rootQueue.then(
            () => executeRoot(meta, operation),
            () => executeRoot(meta, operation)
        );
        rootQueue = queued.catch(() => undefined);
        return queued;
    }

    return {
        MutationTransaction,
        enqueue,
        isActiveTransaction,
        snapshotRecordMap,
        restoreRecordMap,
        snapshotParcelPresentation,
        restoreParcelPresentation
    };
});
