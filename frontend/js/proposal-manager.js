// Canonical two-axis status accessors from proposals/status.js. Globals in the browser (status.js
// loads first); required directly in node tests. `typeof` on the undeclared global is safe, and the
// require branch is never evaluated in the browser. Named with an -Of suffix so they never shadow
// (and thereby re-declare / throw over) the browser globals themselves.
const appliedOf = (typeof isApplied === 'function')
    ? isApplied
    : require('./proposals/status.js').isApplied;
const lifecycleOf = (typeof getLifecycleStatus === 'function')
    ? getLifecycleStatus
    : require('./proposals/status.js').getLifecycleStatus;

// Pure apply-routing (goal normalisation + which apply path a proposal takes), extracted to
// proposals/apply/route.js as the first decomposition of this file. It exposes a namespaced
// window.__applyRoute in the browser (no global-shadowing) and a CommonJS export in node.
const applyRoute = (typeof window !== 'undefined' && window.__applyRoute)
    ? window.__applyRoute
    : require('./proposals/apply/route.js');

const proposalMutationTransactions = (typeof window !== 'undefined' && window.ProposalMutationTransactions)
    ? window.ProposalMutationTransactions
    : require('./proposals/apply/transaction.js');

// The parcel-identity + ownership helpers moved to proposal-parcel-identity.js (a sibling classic
// script the browser loads first, so they are globals there). Under node they are module-scoped, so
// load that file to publish them onto globalThis before the ProposalManager literal below references
// them by bare name, and expose the two root-extractors this file still owns so those helpers — which
// call back into them — resolve in node exactly as they do in the browser.
if (typeof module !== 'undefined' && module.exports && typeof require === 'function') {
    require('./proposal-parcel-identity.js');
    globalThis._extractRootParcelId = _extractRootParcelId;
    globalThis._extractRootParcelNumber = _extractRootParcelNumber;
}

function _normalizeProposalId(value) {
    if (value === undefined || value === null) return null;
    try {
        return String(value);
    } catch (_) {
        return null;
    }
}

function _getProposalApplyLabel(proposalId, proposalData) {
    const title = proposalData && typeof proposalData.title === 'string'
        ? proposalData.title.trim()
        : '';
    return title || _normalizeProposalId(proposalId) || 'unknown-proposal';
}

async function _runProposalApplyWithSummary(proposalId, proposalData, runApply) {
    const label = _getProposalApplyLabel(proposalId, proposalData);
    try {
        const result = await runApply();
        if (result === false) {
            console.warn(`Applying proposal ${label} ... failed`);
            return false;
        }
        console.log(`Applying proposal ${label} ... done`);
        return result;
    } catch (error) {
        console.warn(`Applying proposal ${label} ... failed`);
        throw error;
    }
}

async function _runProposalMutationBoundary(manager, kind, proposalId, options, operation) {
    const supplied = options && options._mutationTransaction;
    if (proposalMutationTransactions.isActiveTransaction(supplied)) {
        return operation(supplied, { ...(options || {}), _mutationTransaction: supplied });
    }

    return proposalMutationTransactions.enqueue({
        kind,
        proposalId: _normalizeProposalId(proposalId)
    }, async transaction => {
        const store = typeof proposalStorage !== 'undefined' ? proposalStorage : null;
        const proposalSnapshot = store && store.proposals instanceof Map
            ? proposalMutationTransactions.snapshotRecordMap(store.proposals)
            : null;
        const nextProposalId = store ? store.nextProposalId : undefined;
        const browserRoot = typeof window !== 'undefined' ? window : null;
        const presentationSnapshot = proposalMutationTransactions.snapshotParcelPresentation(browserRoot);

        if (store && typeof store.beginBatch === 'function' && typeof store.endBatch === 'function') {
            store.beginBatch();
            transaction.deferFinally('close proposal storage batch', () => store.endBatch());
        }

        transaction.deferRollback('restore proposal and map state', () => {
            if (store && proposalSnapshot) {
                proposalMutationTransactions.restoreRecordMap(store.proposals, proposalSnapshot);
                if (nextProposalId !== undefined) store.nextProposalId = nextProposalId;
                if (typeof store.save === 'function') store.save();
            }
            proposalMutationTransactions.restoreParcelPresentation(browserRoot, presentationSnapshot);
            try {
                if (manager && typeof manager._refreshUIAfterProposalChange === 'function') {
                    manager._refreshUIAfterProposalChange(store && typeof store.getProposal === 'function'
                        ? store.getProposal(proposalId)
                        : null);
                }
            } catch (_) { /* rollback must continue */ }
        });

        const ownsParcelBatch = !!(
            browserRoot
            && typeof browserRoot._startParcelWriteCache === 'function'
            && typeof browserRoot._flushParcelWriteCache === 'function'
            && typeof browserRoot._discardParcelWriteCache === 'function'
            && !(typeof browserRoot.isParcelWriteBatchActive === 'function' && browserRoot.isParcelWriteBatchActive())
        );
        if (ownsParcelBatch) {
            browserRoot._startParcelWriteCache();
            transaction.deferCommit('flush parcel writes', () => browserRoot._flushParcelWriteCache());
            transaction.deferRollback('discard parcel writes', () => browserRoot._discardParcelWriteCache());
        }

        return operation(transaction, {
            ...(options || {}),
            _mutationTransaction: transaction,
            ...(ownsParcelBatch ? { _parcelWriteBatchActive: true } : {})
        });
    });
}

function _resolveProposalId(source) {
    if (!source || typeof source !== 'object') return null;
    const candidate = source.proposalId
        || source.id
        || source.tokenId;
    const normalized = _normalizeProposalId(candidate);
    if (normalized) {
        source.proposalId = normalized;
        return normalized;
    }
    return null;
}

function _getProposalRecord(proposalId) {
    if (!proposalId || typeof proposalStorage === 'undefined') return null;
    const normalized = _normalizeProposalId(proposalId) || null;
    if (!normalized) return null;
    const direct = typeof proposalStorage.getProposal === 'function'
        ? proposalStorage.getProposal(normalized)
        : null;
    if (direct) return direct;
    if (typeof proposalStorage.findProposalByIdOrHash === 'function') {
        return proposalStorage.findProposalByIdOrHash(normalized);
    }
    return null;
}

function _childGeometrySortKey(feature) {
    const geometry = feature?.geometry;
    if (!geometry || !Array.isArray(geometry.coordinates)) return 'z';
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let sumX = 0;
    let sumY = 0;
    let count = 0;
    const visit = value => {
        if (!Array.isArray(value)) return;
        if (value.length >= 2 && Number.isFinite(Number(value[0])) && Number.isFinite(Number(value[1]))) {
            const x = Number(value[0]);
            const y = Number(value[1]);
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
            sumX += x;
            sumY += y;
            count += 1;
            return;
        }
        value.forEach(visit);
    };
    visit(geometry.coordinates);
    if (!count) return `z:${geometry.type || ''}`;
    const fixed = value => value.toFixed(12);
    return [
        geometry.type || '',
        fixed(minX), fixed(minY), fixed(maxX), fixed(maxY),
        fixed(sumX / count), fixed(sumY / count),
        String(count),
        JSON.stringify(geometry.coordinates)
    ].join('|');
}

// Assign each child parcel a synthetic id, deterministically, from the CURRENT id rules only.
// The token is derived from the proposalId; the index is a running per-root-parcel counter in
// geometric order. We deliberately do NOT read the proposal's stored childParcelIds to reproduce
// prior tokens/indices — children are derived data, so if the geometry or rules change they simply
// get different ids. Because token (from proposalId) and per-root ordering are stable, a stable
// parent set still reproduces identical ids naturally; a drifted split yields different ids, as it
// should. No canonical list is honored anywhere. `options.startIndexByRootId` lets a second mint
// phase (for example structure remainders after its body) continue the same proposal's numbering.
// Allocates the next child index under ANOTHER proposal's token — §15b identity carry-over.
// Only the fabric built in this derivation participates. Reading stored child lists made every
// reload continue after yesterday's derived ids, so identical input produced -4, then -5, then
// -6. The registry is purged before replay; its entries therefore describe this fold only.
function _createForeignIndexAllocator() {
    const next = {};
    return (base, token) => {
        const key = base + '#' + token;
        if (next[key] === undefined) {
            let max = 0;
            const prefix = key + '-';
            const scan = id => {
                const text = String(id);
                if (!text.startsWith(prefix)) return;
                const n = Number(text.slice(prefix.length));
                if (Number.isFinite(n) && n > max) max = n;
            };
            try {
                if (typeof window !== 'undefined' && window.parcelLayerById instanceof Map) {
                    window.parcelLayerById.forEach((_, id) => scan(id));
                }
            } catch (_) { }
            next[key] = max + 1;
        }
        return next[key]++;
    };
}

function _assignSyntheticChildIdentitiesImpl(proposalId, childFeatures, options = {}) {
    if (!proposalId || !Array.isArray(childFeatures)) {
        return;
    }
    const startIndexByRootId = (options && options.startIndexByRootId) || null;

    // A parcel is ONE connected piece of ground. A cut whose result falls in two disconnected
    // areas mints two parcels — never one parcel in two places, which cannot be owned or
    // transferred as a unit and breaks "which parcel is under this point". Enforced here because
    // every mint path funnels through identity assignment, so nothing can route around it.
    // In place: callers hold this array and return it.
    try {
        const contiguity = (typeof window !== 'undefined') ? window.__parcelContiguity : null;
        if (contiguity && childFeatures.some(f => contiguity.partCount(f) > 1)) {
            const turf = (typeof window !== 'undefined') ? window.turf : null;
            const exploded = contiguity.explodeAll(childFeatures, {
                minAreaM2: 1,
                areaOf: turf && typeof turf.area === 'function' ? f => turf.area(f) : null
            });
            console.debug('[_assignSyntheticChildIdentities] split non-contiguous child parcels',
                { proposalId, before: childFeatures.length, after: exploded.length });
            childFeatures.splice(0, childFeatures.length, ...exploded);
        }
    } catch (error) {
        console.warn('[_assignSyntheticChildIdentities] contiguity split failed', error);
    }

    // Layer ingestion order depends on tile timing. Numbering in that order made identical replay
    // geometry swap ids across reloads, so a later taker could hide the wrong piece. Establish one
    // total geometric order before allocating any id.
    const identityOrder = childFeatures.map((feature, position) => ({ feature, position }));
    identityOrder.sort((leftEntry, rightEntry) => {
        const left = leftEntry.feature;
        const right = rightEntry.feature;
        const leftProps = left?.properties || {};
        const rightProps = right?.properties || {};
        const leftRoot = _resolveRootParcelIdFromProperties(leftProps) || '';
        const rightRoot = _resolveRootParcelIdFromProperties(rightProps) || '';
        return String(leftRoot).localeCompare(String(rightRoot), undefined, { numeric: true })
            || _childGeometrySortKey(left).localeCompare(_childGeometrySortKey(right))
            || leftEntry.position - rightEntry.position;
    });

    const token = _buildSyntheticToken(proposalId, 'proposal');
    const counters = new Map();
    // Identity carry-over (formation-edit.js): a piece the partition diff matched to the previous
    // apply keeps that identity — the ground survived the edit, so its name must too. Consumed
    // HERE so every mint path stays funneled through identity assignment. `carriedIds` guards
    // against a contiguity split cloning one stamp onto several parts.
    const formationEdit = (typeof window !== 'undefined') ? window.__formationEdit : null;
    const carriedIds = new Set();

    identityOrder.forEach(({ feature }) => {
        if (!feature || !feature.properties) {
            return;
        }

        const props = feature.properties;
        const rootNumber = _resolveRootParcelNumberFromProperties(props) || 'parcel';
        const rootId = _resolveRootParcelIdFromProperties(props) || 'parcel';

        // Flat anchor: every minted piece records the base cadastral parcel(s) under it, one hop —
        // `cadastral parcel(s) → one formation → content`, never a reference chain. The corridor
        // feature arrives with its full multi-root list already stamped; leave that richer truth.
        if ((!Array.isArray(props.baseParcelIds) || !props.baseParcelIds.length) && rootId && rootId !== 'parcel') {
            props.baseParcelIds = [rootId];
        }

        const carried = props.__carryIdentity;
        if (carried !== undefined) delete props.__carryIdentity;
        if (carried && formationEdit && formationEdit.applyCarriedIdentity(props, carried, carriedIds)) {
            props.rootParcelId = rootId;
            props.rootParcelNumber = rootNumber;
            return;
        }

        const key = `${rootNumber || ''}__${rootId || ''}`;
        let state = counters.get(key);
        if (!state) {
            const resumeAt = startIndexByRootId ? Number(startIndexByRootId[rootId]) : NaN;
            state = { nextIndex: Number.isFinite(resumeAt) && resumeAt > 1 ? resumeAt : 1 };
            counters.set(key, state);
        }
        const index = state.nextIndex++;

        props.syntheticIndex = index;
        props.syntheticToken = token;
        props.BROJ_CESTICE = _composeSyntheticParcelNumber(rootNumber, token, index);
        const parcelId = _composeSyntheticParcelId(rootId, token, index);
        _ensureParcelIdOnProperties(props, parcelId);
        // Ensure rootParcelId is persisted to avoid re-extraction
        props.rootParcelId = rootId;
        props.rootParcelNumber = rootNumber;
    });
}

const ProposalManager = {
    _lastApplyFailureByProposalId: new Map(),
    _initialReapplyDone: false,
    _reapplyInFlight: false,

    _setLastApplyFailure(proposalId, failure) {
        try {
            const key = _normalizeProposalId(proposalId) || (proposalId && proposalId.toString ? proposalId.toString() : String(proposalId || ''));
            if (!key) return;
            const message = (failure && failure.message) ? String(failure.message)
                : (failure && failure.reason) ? String(failure.reason)
                    : (typeof failure === 'string' ? failure : (failure !== undefined && failure !== null ? String(failure) : ''));
            const code = (failure && failure.code) ? String(failure.code) : null;
            const missingIds = (failure && Array.isArray(failure.missingIds))
                ? Array.from(new Set(failure.missingIds
                    .map(id => id && id.toString ? id.toString() : String(id || ''))
                    .filter(Boolean)))
                : [];
            if (!message) return;
            this._lastApplyFailureByProposalId.set(key, {
                message,
                code,
                missingIds,
                at: Date.now()
            });
        } catch (_) { /* best-effort */ }
    },

    _clearLastApplyFailure(proposalId) {
        try {
            const key = _normalizeProposalId(proposalId) || (proposalId && proposalId.toString ? proposalId.toString() : String(proposalId || ''));
            if (!key) return;
            this._lastApplyFailureByProposalId.delete(key);
        } catch (_) { /* best-effort */ }
    },

    getLastApplyFailure(proposalId) {
        try {
            const key = _normalizeProposalId(proposalId) || (proposalId && proposalId.toString ? proposalId.toString() : String(proposalId || ''));
            if (!key) return null;
            const entry = this._lastApplyFailureByProposalId.get(key);
            return entry && entry.message ? entry.message : null;
        } catch (_) {
            return null;
        }
    },

    getLastApplyFailureInfo(proposalId) {
        try {
            const key = _normalizeProposalId(proposalId) || (proposalId && proposalId.toString ? proposalId.toString() : String(proposalId || ''));
            if (!key) return null;
            const entry = this._lastApplyFailureByProposalId.get(key);
            if (!entry || !entry.message) return null;
            return {
                message: String(entry.message),
                code: entry.code ? String(entry.code) : null,
                missingIds: Array.isArray(entry.missingIds) ? entry.missingIds.slice() : [],
                at: entry.at || null
            };
        } catch (_) {
            return null;
        }
    },
    createProposal(options) {
        const input = options || {};
        const nextLocalId = (typeof proposalStorage !== 'undefined' && Number.isFinite(proposalStorage.nextProposalId))
            ? proposalStorage.nextProposalId
            : Date.now();
        const initialProposalId = input.onchainProposal?.proposalId != null
            ? String(input.onchainProposal.proposalId)
            : `local-${nextLocalId}`;
        const name = String(input.name || 'Road');
        const normalizedAuthor = (input.author && String(input.author).trim()) || 'User';
        const normalizedDescription = (input.description && String(input.description).trim()) || `Road: ${name}`;
        const offerValue = Number.isFinite(Number(input.offer)) ? Number(input.offer) : null;
        const budgetValue = Number.isFinite(Number(input.budget)) ? Number(input.budget) : offerValue;
        const parentParcelIds = Array.isArray(input.parentFeatures)
            ? input.parentFeatures.map(feature => _getParcelIdFromFeature(feature)).filter(Boolean).map(String)
            : [];
        let definition = input.definition || {};
        try { definition = JSON.parse(JSON.stringify(definition)); } catch (_) { definition = { ...definition }; }

        const proposalData = {
            type: 'road',
            title: name,
            author: normalizedAuthor,
            description: normalizedDescription,
            proposalId: initialProposalId,
            parentParcelIds,
            childParcelIds: [],
            roadProposal: {
                id: initialProposalId,
                proposalId: initialProposalId,
                definition,
                parentParcelIds: parentParcelIds.slice(),
                childParcelIds: []
            },
            applied: false,
            createdAt: new Date().toISOString()
        };
        if (input.onchainProposal) {
            proposalData.onchain = { ...input.onchainProposal };
        }

        if (Number.isFinite(offerValue)) {
            proposalData.offer = offerValue;
            proposalData.budget = Number.isFinite(budgetValue) ? budgetValue : offerValue;
        }

        // Include lens from options or proposal object
        const lensToUse = input.lens;

        // Process lens if it exists and is not empty
        if (lensToUse !== undefined && lensToUse !== null) {
            let normalizedLens = null;
            if (typeof normalizeLensEntries === 'function') {
                normalizedLens = normalizeLensEntries(lensToUse);
            } else if (Array.isArray(lensToUse)) {
                normalizedLens = lensToUse;
            }

            // Only set lens if we have valid entries after normalization
            if (normalizedLens && Array.isArray(normalizedLens) && normalizedLens.length > 0) {
                proposalData.lens = normalizedLens;
                console.log('[createProposal] Lens included in proposalData:', normalizedLens.length, 'entries');
            }
        }

        if (typeof proposalStorage !== 'undefined') {
            const proposalId = proposalStorage.addProposal(proposalData);
            if (!proposalId) {
                // Duplicate proposal or invalid data - return null to indicate failure
                console.warn('[createProposal] Failed to add proposal to storage - duplicate or invalid data', { proposalData });
                return null;
            }
            proposalData.proposalId = String(proposalId);
            proposalData.roadProposal.id = String(proposalId);
            proposalData.roadProposal.proposalId = String(proposalId);

            // Update show proposals button
            if (typeof updateShowProposalsButton === 'function') {
                updateShowProposalsButton();
            }
        }

        return proposalData;
    },

    _enqueueFabricChange(operation) {
        const previous = this._fabricChangeTail || Promise.resolve();
        const queued = previous.catch(() => undefined).then(operation);
        this._fabricChangeTail = queued.catch(() => undefined);
        return queued;
    },

    reapplyAppliedProposals() {
        if (this._initialReapplyDone) {
            return this._initialReapplyPromise || Promise.resolve(this._initialReapplyResult);
        }
        // Single-flight barrier: every caller must await the SAME replay. Returning immediately
        // merely because one was in flight let the shared-link route inspect the interval after
        // `_rebuildPass` had marked every record unapplied but before the ordered prefix stood.
        // It then imported/applied into a half-built fabric and even synchronized canonical parent
        // lists onto those temporarily-unapplied local records. A reload is a reader of this
        // derivation, so it waits; it never becomes a second writer.
        if (this._initialReapplyPromise) return this._initialReapplyPromise;

        this._reapplyInFlight = true;
        const replayPromise = (async () => {
            try {
                // Wait for PersistentStorage to be ready before reading proposals and parcel data
                if (typeof PersistentStorage !== 'undefined' && PersistentStorage && typeof PersistentStorage.ensureReady === 'function') {
                    await new Promise(resolve => PersistentStorage.ensureReady(resolve));
                }

                if (typeof proposalStorage === 'undefined' || typeof proposalStorage.getAllProposals !== 'function') return undefined;

                const proposals = proposalStorage.getAllProposals() || [];
                const applied = proposals.filter(p => appliedOf(p));

                if (!applied.length) return undefined;

                // Only reapply proposals belonging to the active city. Applied proposals are
                // stored globally (not per-city), so without this an NYC session would try to
                // reapply Zagreb proposals — fetching HR-* ids from the NYC parcel endpoint (400)
                // and poisoning the nearby-3D-buildings query with cross-city geometry (→ "loaded
                // 0 nearby 3d buildings"). Mirrors the city filter in game.js.
                const currentCityId = (typeof window !== 'undefined' && window.CityConfigManager
                        && typeof window.CityConfigManager.getCurrentCityId === 'function')
                    ? window.CityConfigManager.getCurrentCityId()
                    : null;
                const appliedInCity = (currentCityId && typeof isInCity === 'function')
                    ? applied.filter(p => {
                        const ids = Array.isArray(p.cadastreParcelIds) && p.cadastreParcelIds.length
                            ? p.cadastreParcelIds
                            : (Array.isArray(p.parentParcelIds) ? p.parentParcelIds : []);
                        if (!ids.length) return true;
                        return ids.some(id => isInCity(id, currentCityId));
                    })
                    : applied;

                if (!appliedInCity.length) return undefined;

                // Boot uses the SAME derivation as an edit and an unapply: pristine cadastre, then one
                // ordered replay. The former stored-order `_reapplyAppliedProposal` loop was a second
                // implementation with different precedence and restore semantics; whichever happened
                // to run first could establish a different fabric. Non-conforming stored records are
                // handled by the explicit migration script, never by a live healing pass here.
                const result = await this.rebuildAppliedFabric({ silent: true });
                this._initialReapplyResult = result;
                return result;
            } finally {
                this._reapplyInFlight = false;
                this._initialReapplyDone = true;
            }
        })();
        this._initialReapplyPromise = replayPromise;
        return replayPromise;
    },

    // §15c (drawing board, 2026-08-06): the live fabric is a DERIVATION — cadastre first (the
    // physical ground fact), then the applied formations in order, each cutting what stands.
    // Every change operation (a road edit, an unapply, a severance destroy) flips the records
    // and calls THIS: reset the derived fabric to pristine cadastre, then replay the applied
    // list through the ordinary apply layer. Nothing is ever "restored" — a cadastral parcel
    // simply shows wherever no formation claims it, and a road's own remainders tile
    // parent-minus-corridor by construction. Identity stays stable because connected pieces are
    // sorted geometrically and numbered afresh from one for each proposal on every replay.
    async rebuildAppliedFabric(options = {}) {
        const opts = options || {};
        // All external record changes share one queue. Replay itself opts out because it invokes
        // the low-level apply path for each ordered member and must not enqueue behind itself.
        if (opts._fabricQueue !== true) {
            return this._enqueueFabricChange(() => this.rebuildAppliedFabric({
                ...opts,
                _fabricQueue: true
            }));
        }
        if (this._rebuildInProgress) {
            console.warn('[rebuildAppliedFabric] re-entered — skipped');
            return { ok: false, reentered: true };
        }
        this._rebuildInProgress = true;
        const hasStorageBatch = typeof proposalStorage !== 'undefined'
            && proposalStorage
            && typeof proposalStorage.beginBatch === 'function'
            && typeof proposalStorage.endBatch === 'function';
        if (hasStorageBatch) proposalStorage.beginBatch();
        try {
            const currentCityId = (typeof window !== 'undefined' && window.CityConfigManager
                    && typeof window.CityConfigManager.getCurrentCityId === 'function')
                ? window.CityConfigManager.getCurrentCityId()
                : null;
            const inCity = p => {
                if (!currentCityId || typeof isInCity !== 'function') return true;
                const ids = Array.isArray(p.cadastreParcelIds) && p.cadastreParcelIds.length
                    ? p.cadastreParcelIds
                    : (Array.isArray(p.parentParcelIds) ? p.parentParcelIds : []);
                if (!ids.length) return true;
                return ids.some(id => isInCity(id, currentCityId));
            };
            // §15c derivation order = the immutable record order. An edit is a new proposal, so
            // replay cannot change merely because a record was opened on this browser.
            const appliedNow = () => {
                const list = proposalStorage.getAllProposals()
                    .filter(p => p && isProposalCurrentlyApplied(p) && inCity(p));
                try {
                    const planOrderApi = (typeof window !== 'undefined') ? window.__planOrder : null;
                    if (planOrderApi && typeof planOrderApi.orderFormations === 'function') {
                        return planOrderApi.orderFormations(list);
                    }
                } catch (_) { /* fall through to the same total order */ }
                return list.sort((x, y) => {
                    const xt = Date.parse(x.createdAt) || 0;
                    const yt = Date.parse(y.createdAt) || 0;
                    return xt - yt || String(x.proposalId || '').localeCompare(String(y.proposalId || ''));
                });
            };

            let summary = { ok: true, applied: 0, failed: [] };
            // A severance or demolition can park an earlier record while a pass is running.
            // That invalidates the prefix already stamped on the map, so derive again from the
            // cadastre with the now-smaller applied set. These changes are monotonic; at most one
            // record can disappear per extra pass.
            const maxPasses = Math.max(2, appliedNow().length + 1);
            for (let pass = 0; pass < maxPasses; pass += 1) {
                this._severedThisRebuild = [];
                this._replayInvalidated = false;
                summary = await this._rebuildPass(appliedNow(), opts);
                if (!this._severedThisRebuild.length && !this._replayInvalidated) break;
                console.info('[rebuildAppliedFabric] applied set changed during replay — deriving again', {
                    severed: this._severedThisRebuild.slice()
                });
            }

            try { if (typeof refreshAppliedCorridorStrips === 'function') refreshAppliedCorridorStrips(); } catch (_) { }
            try { if (typeof syncProposalsIndicator === 'function') syncProposalsIndicator(); } catch (_) { }
            if (summary.failed.length && !(opts.silent === true)) {
                const names = summary.failed
                    .map(f => (f.reason ? `${f.title} — ${f.reason}` : f.title))
                    .join('; ');
                try {
                    if (typeof showEphemeralMessage === 'function') {
                        showEphemeralMessage(`Rebuild: ${summary.failed.length} proposal(s) could not re-apply and were set aside: ${names}`, 12000, 'warning');
                    }
                } catch (_) { }
            }
            return summary;
        } finally {
            this._rebuildInProgress = false;
            this._severedThisRebuild = [];
            this._replayInvalidated = false;
            if (hasStorageBatch) proposalStorage.endBatch();
        }
    },

    async _rebuildPass(appliedList, opts) {
        this._resetDerivedFabric(appliedList);
        const failed = [];
        let appliedCount = 0;
        // A replay is an ordered fold. Clear the ENTIRE target set before the first member runs;
        // then only the successfully replayed prefix is applied. Previously each record was flipped
        // off immediately before its own apply, so later records still looked applied to the first
        // taker, which reversed the order — the amend pass that exploited it is gone, but clearing
        // the whole set up front is still what makes a replay an ordered fold rather than a race.
        const replayStamps = new Map();
        (appliedList || []).forEach(proposal => {
            if (!proposal) return;
            replayStamps.set(String(proposal.proposalId), {
                hadAppliedAt: Object.prototype.hasOwnProperty.call(proposal, 'appliedAt'),
                appliedAt: proposal.appliedAt,
                hadUpdatedAt: Object.prototype.hasOwnProperty.call(proposal, 'updatedAt'),
                updatedAt: proposal.updatedAt
            });
            try { setProposalApplied(proposal, false, { stamp: false }); } catch (_) { }
        });
        for (const proposal of appliedList) {
            const key = (typeof getProposalKey === 'function' && getProposalKey(proposal)) || proposal.proposalId;
            // The derive is geometric against LOADED fabric — coverage must not depend on
            // where the viewport happens to be. Fetch the member's ground first: its declared
            // base anchors by id, and the footprint's bounds for ground an edit newly covers.
            try {
                const fe = (typeof window !== 'undefined') ? window.__formationEdit : null;
                const groundIds = Array.from(new Set([
                    ...(Array.isArray(proposal.cadastreParcelIds) ? proposal.cadastreParcelIds : []),
                    ...(Array.isArray(proposal.parentParcelIds) ? proposal.parentParcelIds : [])
                        .map(id => (fe && typeof fe.baseIdOf === 'function') ? fe.baseIdOf(String(id)) : String(id))
                ].map(String).filter(Boolean)));
                if (groundIds.length && typeof fetchParcelsForIds === 'function') {
                    await fetchParcelsForIds(groundIds);
                }
                const planOrderApi = (typeof window !== 'undefined') ? window.__planOrder : null;
                const footprint = (planOrderApi && typeof planOrderApi.footprintOf === 'function')
                    ? planOrderApi.footprintOf(proposal) : null;
                if (footprint && typeof fetchParcelData === 'function' && typeof L !== 'undefined') {
                    const bounds = L.geoJSON({ type: 'Feature', properties: {}, geometry: footprint.type === 'Feature' ? footprint.geometry : footprint }).getBounds();
                    await fetchParcelData(bounds.pad(0.1));
                }
            } catch (fetchError) {
                console.warn('[rebuildAppliedFabric] ground fetch failed for', key, fetchError);
            }
            let ok = false;
            try {
                ok = await this.applyProposal(key, { replay: true });
            } catch (error) {
                console.error('[rebuildAppliedFabric] apply threw for', key, error);
                ok = false;
            }
            // Re-derivation is not a proposal edit. Apply tails stamp `appliedAt`/`updatedAt`; put
            // the record metadata back so repeated rebuilds are byte-stable apart from genuinely
            // derived children and amendments made by a LATER standing taker.
            const priorStamp = replayStamps.get(String(proposal.proposalId));
            if (priorStamp) {
                if (priorStamp.hadAppliedAt) proposal.appliedAt = priorStamp.appliedAt;
                else delete proposal.appliedAt;
                if (priorStamp.hadUpdatedAt) proposal.updatedAt = priorStamp.updatedAt;
                else delete proposal.updatedAt;
            }
            if (ok) appliedCount += 1;
            else {
                // Carry the refusal REASON out with the failure. Without it the only place the
                // "why" existed was a console line, so a member vanishing from an applied plan
                // looked like the app losing it rather than a gate refusing it.
                const failure = this._lastApplyFailureByProposalId.get(String(proposal.proposalId)) || null;
                failed.push({
                    proposalId: String(proposal.proposalId),
                    title: proposal.title || String(proposal.proposalId),
                    code: (failure && failure.code) || null,
                    reason: (failure && failure.message) || null
                });
                console.warn('[rebuildAppliedFabric] could not re-apply', key, failure || '');
            }
        }
        // A derivation failure is not a user action and must never flip a standing record off.
        // Keep failed members absent while later members derive, then restore their record flags.
        // Initial apply callers explicitly roll back only the records they just requested.
        failed.forEach(entry => {
            const record = _getProposalRecord(entry.proposalId)
                || (appliedList || []).find(item => String(item?.proposalId) === entry.proposalId);
            if (!record) return;
            try { setProposalApplied(record, true, { stamp: false }); } catch (_) { record.applied = true; }
            const priorStamp = replayStamps.get(entry.proposalId);
            if (!priorStamp) return;
            if (priorStamp.hadAppliedAt) record.appliedAt = priorStamp.appliedAt;
            else delete record.appliedAt;
            if (priorStamp.hadUpdatedAt) record.updatedAt = priorStamp.updatedAt;
            else delete record.updatedAt;
        });
        try { if (typeof proposalStorage.save === 'function') proposalStorage.save(); } catch (_) { }
        return { ok: failed.length === 0, applied: appliedCount, failed };
    },

    _clearDerivedRecordState(proposal) {
        if (!proposal || typeof proposal !== 'object') return proposal;
        const isGovernmentPlan = proposal.tags?.governmentPlan === true
            || proposal.roadProposal?.definition?.kind === 'government_plan';
        delete proposal.childParcelIds;
        delete proposal.descendantParcelIds;
        delete proposal.parentFeatures;
        if (!isGovernmentPlan) delete proposal.childFeatures;
        ['roadProposal', 'reparcellization', 'decideLaterProposal', 'buildingProposal', 'structureProposal'].forEach(key => {
            const sub = proposal[key];
            if (!sub || typeof sub !== 'object' || Array.isArray(sub)) return;
            delete sub.childParcelIds;
            delete sub.parentFeatures;
            delete sub.parentsToRemove;
            delete sub.formation;
            if (!(key === 'roadProposal' && isGovernmentPlan)) delete sub.childFeatures;
            if (key === 'buildingProposal' || key === 'structureProposal') {
                delete sub.demolishedBuildings;
                delete sub.demolitionScanned;
            }
        });
        const clearRoadScan = definition => {
            if (!definition || typeof definition !== 'object') return;
            delete definition.demolishedBuildings;
            delete definition.demolitionScanned;
        };
        clearRoadScan(proposal.roadProposal?.definition);
        return proposal;
    },

    // Remove EVERY derived-fabric layer and show the cadastre. A full replay starts from a
    // pristine live registry, not merely an invisible group: retained `parcelLayerById` entries
    // were still accepted by materialization/feature-resolution gates and could put an old parcel
    // under a square back into the next cut. Derived parcels are regenerated by applied records;
    // an unknown/orphan token has no standing claim and is purged as well.
    _resetDerivedFabric(appliedList) {
        const browserRoot = typeof window !== 'undefined' ? window : globalThis;
        const byId = (browserRoot.parcelLayerById instanceof Map) ? browserRoot.parcelLayerById : null;
        if (byId) {
            const derivedIds = [];
            byId.forEach((layer, id) => {
                const props = layer?.feature?.properties || {};
                const derived = (typeof isSyntheticParcelId === 'function' && isSyntheticParcelId(id))
                    || !!props.ancestorProposal
                    || !!props.syntheticToken;
                if (derived) derivedIds.push(String(id));
            });
            derivedIds.forEach(id => {
                try { if (typeof browserRoot.removeParcelLayerById === 'function') browserRoot.removeParcelLayerById(id); } catch (_) { }
                byId.delete(id);
                try {
                    const cache = browserRoot.ParcelsState && typeof browserRoot.ParcelsState.getParcelCache === 'function'
                        ? browserRoot.ParcelsState.getParcelCache()
                        : browserRoot.parcelCache;
                    if (cache && cache.byId instanceof Map) cache.byId.delete(id);
                } catch (_) { }
                try { if (typeof clearPersistedParcelRecord === 'function') clearPersistedParcelRecord(id); } catch (_) { }
            });
            // The cadastre is the ground fact — everything that remains shows.
            byId.forEach((layer, id) => {
                if (String(id).indexOf('#') !== -1) return;
                try { if (typeof browserRoot.showParcelLayerById === 'function') browserRoot.showParcelLayerById(String(id)); } catch (_) { }
            });
        }

        // Structure/building collections are presentation caches of applied records, just like
        // derived parcel layers. Clear only proposal-authored entries; surveyed/base features stay.
        const resetCollection = (name, storageKey) => {
            if (!Array.isArray(browserRoot[name])) return;
            browserRoot[name] = browserRoot[name].filter(feature => !feature?.properties?.proposalId);
            if (storageKey) {
                try { PersistentStorage.setItem(storageKey, JSON.stringify(browserRoot[name])); } catch (_) { }
            }
        };
        resetCollection('parks', 'cb_parks');
        resetCollection('squares', 'cb_squares');
        resetCollection('lakes', 'cb_lakes');
        resetCollection('transitStations', 'cb_transit_stations');
        resetCollection('proposedBuildings', null);
        try { if (typeof proposalFeatureCache !== 'undefined') proposalFeatureCache.clear(); } catch (_) { }
        try { if (typeof proposalAreaCache !== 'undefined') proposalAreaCache.clear(); } catch (_) { }
        try { if (typeof updateParksLayer === 'function') updateParksLayer(); } catch (_) { }
        try { if (typeof updateSquaresLayer === 'function') updateSquaresLayer(); } catch (_) { }
        try { if (typeof updateLakesLayer === 'function') updateLakesLayer(); } catch (_) { }
        try { if (typeof updateTransitStationsLayer === 'function') updateTransitStationsLayer(); } catch (_) { }
        try { if (typeof updateProposedBuildingsLayer === 'function') updateProposedBuildingsLayer(); } catch (_) { }

        // Record-side children, formations and demolition results are the previous derivation.
        // Clear them before the fold; each apply repopulates only what stands in this replay.
        (Array.isArray(appliedList) ? appliedList : [])
            .forEach(proposal => this._clearDerivedRecordState(proposal));
    },

    _cloneFeatures(features) {
        if (!Array.isArray(features)) return [];
        const clones = [];
        features.forEach(feature => {
            try {
                if (feature === undefined || feature === null) return;

                // If it's a Leaflet layer, extract the GeoJSON feature from it
                let geoJsonFeature = feature;
                if (feature.feature && typeof feature.feature === 'object') {
                    // It's a Leaflet layer, extract the underlying feature
                    geoJsonFeature = feature.feature;
                } else if (feature.toGeoJSON && typeof feature.toGeoJSON === 'function') {
                    // It's a Leaflet layer with toGeoJSON method
                    geoJsonFeature = feature.toGeoJSON(false);
                }

                // Extract only GeoJSON properties (type, properties, geometry)
                // This ensures we don't include any Leaflet-specific circular references
                const cleanFeature = {
                    type: geoJsonFeature.type || 'Feature',
                    properties: geoJsonFeature.properties ? { ...geoJsonFeature.properties } : {},
                    geometry: geoJsonFeature.geometry ? {
                        type: geoJsonFeature.geometry.type,
                        coordinates: geoJsonFeature.geometry.coordinates
                    } : null
                };

                // Validate it's a proper GeoJSON feature
                if (cleanFeature.type === 'Feature' && cleanFeature.geometry) {
                    clones.push(cleanFeature);
                } else {
                    console.warn('ProposalManager._cloneFeatures: invalid feature structure', cleanFeature);
                }
            } catch (error) {
                console.warn('ProposalManager._cloneFeatures: failed to clone feature', error);
            }
        });
        return clones;
    },

    _collectParentParcelIds(_roadProposal = {}, proposalData = {}) {
        const sources = [];
        if (Array.isArray(proposalData.parentParcelIds)) sources.push(...proposalData.parentParcelIds);
        return Array.from(new Set(sources.map(id => id && id.toString ? id.toString() : String(id)).filter(Boolean)));
    },

    _getParcelFeatureFromMap(parcelId) {
        if (!parcelId || typeof window === 'undefined') return null;
        const idStr = parcelId && parcelId.toString ? parcelId.toString() : String(parcelId);
        if (!idStr) return null;

        let layer = null;
        try {
            if (typeof window.resolveParcelLayerById === 'function') {
                layer = window.resolveParcelLayerById(idStr);
            }
        } catch (error) {
            console.warn('Failed to read parcel from map', { parcelId: idStr, error });
        }

        if (!layer || !layer.feature) {
            console.error(`[ProposalManager] Parcel ${idStr} not present in parcelLayerById; aborting lookup.`);
            return null;
        }
        const feature = layer.feature;
        return {
            type: 'Feature',
            properties: feature.properties ? { ...feature.properties } : {},
            geometry: feature.geometry ? JSON.parse(JSON.stringify(feature.geometry)) : null
        };
    },

    _getParcelFeatureFromStorage(parcelId) {
        if (!parcelId) return null;
        const idStr = parcelId && parcelId.toString ? parcelId.toString() : String(parcelId);
        if (!idStr) return null;

        try {
            if (typeof readPersistedParcelRecord !== 'function') return null;
            const record = readPersistedParcelRecord(idStr);
            if (!record || !record.properties || !record.geometry) return null;
            return {
                type: 'Feature',
                properties: { ...record.properties },
                geometry: JSON.parse(JSON.stringify(record.geometry))
            };
        } catch (error) {
            console.warn('Failed to hydrate parcel from storage', { parcelId: idStr, error });
            return null;
        }
    },

    _getParcelLayerById(parcelId) {
        if (!parcelId || typeof window === 'undefined') return null;
        const idStr = parcelId && parcelId.toString ? parcelId.toString() : String(parcelId);
        if (!idStr) return null;

        try {
            if (typeof window.resolveParcelLayerById === 'function') {
                const direct = window.resolveParcelLayerById(idStr);
                if (direct) return direct;
            }
            if (window.parcelLayer && typeof window.parcelLayer.eachLayer === 'function') {
                let found = null;
                window.parcelLayer.eachLayer(layer => {
                    if (found) return;
                    const candidateId = _getParcelIdFromFeature(layer?.feature);
                    if (candidateId && String(candidateId) === idStr) {
                        found = layer;
                    }
                });
                if (found) return found;
            }
        } catch (error) {
            console.warn('Failed to resolve parcel layer', { parcelId: idStr, error });
        }
        return null;
    },

    _upsertParcelProperties(parcelId, mutator, options = {}) {
        if (!parcelId) return;
        const idStr = parcelId && parcelId.toString ? parcelId.toString() : String(parcelId);
        if (!idStr) return;

        const persistIfMissing = options.persistIfMissing === true;
        const record = (typeof readPersistedParcelRecord === 'function') ? readPersistedParcelRecord(idStr) : null;
        const hadStorage = !!record;
        const propsFromStorage = record?.properties || null;

        const layer = this._getParcelLayerById(idStr);
        const propsFromLayer = layer && layer.feature && layer.feature.properties ? layer.feature.properties : null;

        const working = propsFromStorage || (propsFromLayer ? { ...propsFromLayer } : {});
        try { mutator(working); } catch (_) { /* ignore mutator errors */ }

        if (propsFromLayer) {
            layer.feature.properties = { ...propsFromLayer, ...working };
        }

        if (hadStorage || persistIfMissing) {
            if (typeof writePersistedParcelRecord === 'function') {
                writePersistedParcelRecord(idStr, rec => {
                    rec.properties = { ...(rec.properties || {}), ...working };
                });
            }
        }
    },

    _persistParcelFeature(feature) {
        if (!feature || !feature.properties || !feature.geometry) return;
        const parcelId = _getParcelIdFromFeature(feature);
        if (parcelId === undefined || parcelId === null) return;
        const idStr = parcelId && parcelId.toString ? parcelId.toString() : String(parcelId);
        if (!idStr) return;

        if (typeof writePersistedParcelRecord === 'function') {
            writePersistedParcelRecord(idStr, rec => {
                rec.geometry = JSON.parse(JSON.stringify(feature.geometry));
                rec.properties = { ...feature.properties };
                // No longer need to clear removedByProposal - visibility is calculated from parent/child relationships
            });
        }
    },

    _resolveParcelFeaturesByIds(parcelIds, options = {}) {
        const preferMap = options.preferMap !== false;
        const allowStorage = options.allowStorage === true;
        const allowCache = options.allowCache !== false;
        const allowMissing = options.allowMissing === true;
        const ids = Array.isArray(parcelIds) ? parcelIds : [];
        const seen = new Set();
        const features = [];

        // Build a one-shot lookup to avoid N x parcelLayer scans when many ids are requested
        let mapLookup = null;
        if (preferMap && typeof window !== 'undefined') {
            const byId = window.parcelLayerById instanceof Map ? window.parcelLayerById : null;
            if (byId && byId.size > 0) {
                mapLookup = byId;
            } else if (window.parcelLayer && typeof window.parcelLayer.eachLayer === 'function') {
                mapLookup = new Map();
                window.parcelLayer.eachLayer(layer => {
                    const candidateId = _getParcelIdFromFeature(layer?.feature);
                    if (candidateId === undefined || candidateId === null) return;
                    mapLookup.set(candidateId.toString(), layer);
                });
            }
        }

        // Also consult the in-memory parcel cache for parcels that were fetched but intentionally not rendered
        // (e.g., ancestors replaced by applied descendants).
        let cacheLookup = null;
        if (allowCache) {
            try {
                const store = (typeof ParcelsState !== 'undefined' && ParcelsState && typeof ParcelsState.getParcelCache === 'function')
                    ? ParcelsState.getParcelCache()
                    : (typeof window !== 'undefined' ? window.parcelCache : null);
                const byId = store && store.byId instanceof Map ? store.byId : null;
                if (byId && byId.size > 0) {
                    cacheLookup = byId;
                }
            } catch (_) { /* best-effort */ }
        }

        ids.forEach(rawId => {
            const idStr = rawId && rawId.toString ? rawId.toString() : String(rawId || '');
            if (!idStr || seen.has(idStr)) return;
            seen.add(idStr);

            let feature = null;
            if (preferMap) {
                const layer = mapLookup && mapLookup.get(idStr);
                if (layer && layer.feature) {
                    feature = {
                        type: 'Feature',
                        properties: layer.feature.properties ? { ...layer.feature.properties } : {},
                        geometry: layer.feature.geometry ? JSON.parse(JSON.stringify(layer.feature.geometry)) : null
                    };
                }
            }

            // Fallback to parcel cache (loaded but not necessarily rendered)
            if (!feature && cacheLookup) {
                const cached = cacheLookup.get(idStr);
                if (cached && cached.geometry && cached.properties) {
                    feature = {
                        type: 'Feature',
                        properties: { ...cached.properties },
                        geometry: JSON.parse(JSON.stringify(cached.geometry))
                    };
                }
            }

            // Fallback to persisted storage if allowed
            if (!feature && allowStorage && typeof readPersistedParcelRecord === 'function') {
                try {
                    const rec = readPersistedParcelRecord(idStr);
                    if (rec && rec.geometry && rec.properties) {
                        feature = {
                            type: 'Feature',
                            properties: { ...rec.properties },
                            geometry: JSON.parse(JSON.stringify(rec.geometry))
                        };
                    }
                } catch (err) {
                    console.warn(`[ProposalManager] Failed to read persisted parcel ${idStr}`, err);
                }
            }

            if (!feature) {
                if (!allowMissing) {
                    console.error(`[ProposalManager] Parcel ${idStr} missing in parcelLayerById; stopping resolution.`);
                    throw new Error(`Missing parcel ${idStr} in parcelLayerById`);
                }
                return;
            }

            // Normalize id onto properties (some sources only set it on the layer mapping)
            try {
                if (feature.properties) {
                    _ensureParcelIdOnProperties(feature.properties, idStr);
                }
            } catch (_) { }

            features.push(feature);
        });

        return features;
    },

   _buildChildFeaturesFromDefinition(proposalId, proposalData, parentFeatures = [], buildOptions = {}) {
        if (!proposalData || !proposalData.roadProposal || !proposalData.roadProposal.definition) {
            return [];
        }
        const safeId = proposalId || _resolveProposalId(proposalData) || proposalData.id || 'unknown-proposal';
        const definition = proposalData.roadProposal.definition || {};
        const geometryFromDefinition = definition.polygon
            || ((typeof corridorSurfaceFootprintForDefinition === 'function')
                ? corridorSurfaceFootprintForDefinition(definition)
                : null);
        const polygonGeometry = geometryFromDefinition || null;

        // If a polygon was provided (e.g., full-parcel corridor), build road features directly from it.
        // The FULL Polygon/MultiPolygon is authoritative: selecting one "primary" component made a
        // distant extension change which component cut the cadastre, so old ground disappeared or
        // reappeared even though the edit never touched it.
        if (polygonGeometry && polygonGeometry.type && Array.isArray(polygonGeometry.coordinates)) {
            const normalizeCutGeometry = (geom) => {
                if (!geom || !geom.type || !Array.isArray(geom.coordinates)) return null;
                if (geom.type === 'Polygon') {
                    const rings = geom.coordinates
                        .map(ring => Array.isArray(ring) ? _ensurePolygonIsClosed(ring) : null)
                        .filter(ring => Array.isArray(ring) && ring.length >= 4);
                    return rings.length ? { type: 'Polygon', coordinates: rings } : null;
                }
                if (geom.type === 'MultiPolygon') {
                    const polygons = geom.coordinates
                        .map(poly => (Array.isArray(poly) ? poly : [])
                            .map(ring => Array.isArray(ring) ? _ensurePolygonIsClosed(ring) : null)
                            .filter(ring => Array.isArray(ring) && ring.length >= 4))
                        .filter(rings => rings.length);
                    return polygons.length ? { type: 'MultiPolygon', coordinates: polygons } : null;
                }
                return null;
            };

            let cutGeometry = normalizeCutGeometry(polygonGeometry);
            if (!cutGeometry) return [];
            // Crossroads (ruling 2026-08-07): ground held by another applied road never enters
            // this cut. Subtract the holders from the corridor so a run minted through a
            // junction comes out split around the box instead of double-covering the holder's
            // parcel — each resulting piece is its own contiguous parcel.
            const cutExclusions = Array.isArray(buildOptions.cutExclusionFeatures)
                ? buildOptions.cutExclusionFeatures.filter(f => f && f.geometry) : [];
            if (cutExclusions.length && typeof turf !== 'undefined' && typeof turf.difference === 'function') {
                let working = { type: 'Feature', properties: {}, geometry: cutGeometry };
                for (const held of cutExclusions) {
                    if (!working || !working.geometry) break;
                    try {
                        working = turf.difference(working, { type: 'Feature', properties: {}, geometry: held.geometry });
                    } catch (_) { /* an unsubtractable holder leaves the corridor as-is */ }
                }
                const reduced = working && working.geometry ? normalizeCutGeometry(working.geometry) : null;
                if (!reduced) return [];
                cutGeometry = reduced;
            }

            const proposalToken = _buildSyntheticToken(safeId || 'proposal');

            const getRootInfo = (feature) => {
                const props = feature?.properties || {};
                const parcelNumber = props.BROJ_CESTICE ? String(props.BROJ_CESTICE) : '';
                const parcelId = _getParcelIdFromFeature(feature) || '';
                const rootNumber = _resolveRootParcelNumberFromProperties(props, parcelId)
                    || _extractRootParcelNumber(parcelNumber);
                const rootParcelId = _resolveRootParcelIdFromProperties(props, parcelId)
                    || _extractRootParcelId(parcelId);
                return {
                    rootNumber,
                    rootParcelId
                };
            };

            const affectedParcels = parentFeatures.map(f => {
                const rootInfo = getRootInfo(f);
                const parcelId = _getParcelIdFromFeature(f);
                return {
                    id: parcelId,
                    number: f?.properties?.BROJ_CESTICE,
                    rootNumber: rootInfo.rootNumber,
                    rootParcelId: rootInfo.rootParcelId,
                    feature: f
                };
            }).filter(entry => entry && entry.id)
                .sort((left, right) => String(left.rootParcelId || left.id).localeCompare(
                    String(right.rootParcelId || right.id), undefined, { numeric: true }
                ) || String(left.id).localeCompare(String(right.id), undefined, { numeric: true }));

            if (!affectedParcels.length) return [];

            const primaryAffectedParcelNumber = affectedParcels[0]?.number;
            const primaryRootNumber = affectedParcels[0]?.rootNumber;
            const primaryRootParcelId = affectedParcels[0]?.rootParcelId;
            // Flat anchor (rethink-proposals.md, 2026-08-05): the base cadastral parcels this
            // formation consumes — every crossed parent's root, one hop, no reference chain. The
            // corridor id borrows the FIRST root (a naming accident, §9); this records the truth.
            // A consumed piece's rootParcelId property can itself be a DERIVED id (a recut
            // consuming another formation's slice inherits whatever "root" that slice carried),
            // and copying it raw put `823/1#c-…-1` into a corridor's base anchor — shown under
            // "Cadastral parcel" in the drill. The anchor is BASE ids by definition: flatten.
            const flattenToBaseId = (id) => {
                const fe = (typeof window !== 'undefined') ? window.__formationEdit : null;
                return (fe && typeof fe.baseIdOf === 'function') ? fe.baseIdOf(String(id)) : String(id);
            };
            const affectedRootParcelIds = Array.from(new Set(
                affectedParcels.map(p => p.rootParcelId).filter(Boolean).map(flattenToBaseId).filter(Boolean)
            ));
            const isTrack = corridorIsTrack(definition) || definition?.metadata?.type === 'track' || definition?.type === 'track';
            console.debug('[_buildChildFeaturesFromDefinition] Creating corridor feature', {
                proposalId: safeId,
                isTrack,
                metadataType: definition?.metadata?.type,
                metadataIsTrack: definition?.metadata?.isTrack,
                definitionType: definition?.type
            });

            // §15b identity flows with the ground: pieces cut from ANOTHER proposal's formed
            // plot stay that proposal's children (allocator continues the victim's numbering).
            const allocForeignIndex = _createForeignIndexAllocator();

            const normalizeParcelGeometry = (geometry) => {
                const polygons = _extractPolygonsWithHolesFromGeometry(geometry);
                if (!polygons.length) {
                    return null;
                }
                if (geometry.type === 'MultiPolygon') {
                    const coords = polygons.map(({ outer, holes }) => [outer, ...(holes || [])]);
                    return { type: 'MultiPolygon', coordinates: coords };
                }
                const primary = polygons[0];
                return { type: 'Polygon', coordinates: [primary.outer, ...(primary.holes || [])] };
            };

            const extractDiffPolygons = (geometry) => {
                if (!geometry) return [];
                const polygons = _extractPolygonsWithHolesFromGeometry(geometry);
                return polygons.map(({ outer, holes }) => {
                    const closedOuter = _ensurePolygonIsClosed(outer || []);
                    const closedHoles = Array.isArray(holes) ? holes.map(ring => _ensurePolygonIsClosed(ring || [])) : [];
                    const coords = [closedOuter, ...closedHoles];
                    const area = (typeof turf !== 'undefined' && turf.area) ? turf.area(turf.polygon(coords)) : 0;
                    return { coords, area };
                }).filter(item => Array.isArray(item.coords[0]) && item.coords[0].length >= 4 && item.area >= GEOMETRY_AREA_EPSILON_M2);
            };

            const roadFeatureProperties = {
                isRoad: !isTrack, // tracks are NOT roads
                isCorridor: true,
                isTrack: isTrack,
                calculatedArea: _calculateGeoJsonArea(cutGeometry),
                roadName: proposalData.title || proposalData.name || 'Road',
                isProposed: true,
                proposalId: safeId,
                parentParcelId: affectedParcels[0]?.id || null,
                parentParcelNumber: primaryAffectedParcelNumber || null,
                parentParcelIds: affectedParcels.map(p => p.id),
                parentParcelNumbers: affectedParcels.map(p => p.number),
                rootParcelNumber: primaryRootNumber,
                rootParcelId: primaryRootParcelId,
                baseParcelIds: affectedRootParcelIds.slice(),
                ownershipDetails: {
                    owners: [{
                        name: proposalData.author || 'User',
                        ownerLabel: proposalData.author || 'User',
                        percentageShare: 100,
                        actualShareText: '100%'
                    }]
                }
            };

            if (isTrack && Array.isArray(definition.points)) {
                roadFeatureProperties.trackPoints = definition.points;
            }

            const roadFeature = {
                type: 'Feature',
                properties: roadFeatureProperties,
                geometry: JSON.parse(JSON.stringify(cutGeometry))
            };

            _assignOwnershipDetails(roadFeature, {
                defaultOwnerName: proposalData?.author || 'User',
                overwriteExisting: true
            });

            const childFeatures = [roadFeature];

            // Every road uses one geometry for both its body and its cut. A legacy `mode: full`
            // bypass here used to paint the corridor but leave the parcels intact underneath it.
            if (typeof turf !== 'undefined' && turf.difference) {
                // Include every component and every hole; this feature is exactly the geometry the
                // road child above displays and `_takingFootprintOf` amends with.
                const roadTurf = cutGeometry.type === 'MultiPolygon'
                    ? turf.multiPolygon(cutGeometry.coordinates)
                    : turf.polygon(cutGeometry.coordinates);
                const holeCount = cutGeometry.type === 'MultiPolygon'
                    ? cutGeometry.coordinates.reduce((sum, rings) => sum + Math.max(0, rings.length - 1), 0)
                    : Math.max(0, cutGeometry.coordinates.length - 1);
                console.debug('[_buildChildFeaturesFromDefinition] Road footprint has',
                    cutGeometry.type === 'MultiPolygon' ? cutGeometry.coordinates.length : 1,
                    'component(s) and', holeCount, 'hole(s)');
                if (buildOptions && !Array.isArray(buildOptions.cutFailures)) buildOptions.cutFailures = [];

                affectedParcels.forEach(parcel => {
                    const originalFeature = parcel.feature;
                    const originalNumber = originalFeature.properties.BROJ_CESTICE;
                    const parcelId = _getParcelIdFromFeature(originalFeature);
                    const rootNumber = parcel.rootNumber;
                    const rootParcelId = parcel.rootParcelId;

                    try {
                        const parcelGeometry = normalizeParcelGeometry(originalFeature.geometry);
                        if (!parcelGeometry) throw new Error('Invalid parcel geometry');

                        const parcelTurf = parcelGeometry.type === 'MultiPolygon'
                            ? turf.multiPolygon(parcelGeometry.coordinates)
                            : turf.polygon(parcelGeometry.coordinates);
                        let parentParcelArea = 0;
                        try {
                            parentParcelArea = typeof turf.area === 'function' ? turf.area(parcelTurf) : 0;
                        } catch (_) { parentParcelArea = 0; }
                        let intersectionArea = 0;
                        try {
                            const hit = turf.intersect(parcelTurf, roadTurf);
                            intersectionArea = hit ? turf.area(hit) : 0;
                        } catch (error) {
                            throw new Error(`Could not intersect parent with corridor: ${error && error.message ? error.message : error}`);
                        }
                        if (intersectionArea <= GEOMETRY_AREA_EPSILON_M2) {
                            if (buildOptions && Array.isArray(buildOptions.uncutParentIds) && parcelId) {
                                buildOptions.uncutParentIds.push(String(parcelId));
                            }
                            return;
                        }
                        const difference = turf.difference(parcelTurf, roadTurf);
                        // Legacy (curated/DGU) road parcels carry NO isRoad property — their road
                        // status lives in the roadParcelsSet. Checking only the props flag wrote
                        // isRoad:false onto their remainder slices, stripping the grey the moment
                        // a drawn road connected to an existing road parcel.
                        const parentIsRoad = originalFeature?.properties?.isRoad === true
                            || originalFeature?.properties?.isRoad === 'true'
                            || (parcelId && typeof window.isRoadParcel === 'function' && window.isRoadParcel(String(parcelId)));

                        if (!difference) {
                            if (parentParcelArea - intersectionArea > GEOMETRY_AREA_EPSILON_M2) {
                                throw new Error(`Difference lost ${Math.round(parentParcelArea - intersectionArea)} m² of remainder`);
                            }
                            // Parcel fully consumed by corridor.
                            return;
                        }

                        const pieces = extractDiffPolygons(difference.geometry).sort((a, b) => (
                            b.area - a.area
                            || _childGeometrySortKey({ geometry: { type: 'Polygon', coordinates: a.coords } })
                                .localeCompare(_childGeometrySortKey({ geometry: { type: 'Polygon', coordinates: b.coords } }))
                        ));
                        const expectedRemainderArea = Math.max(0, parentParcelArea - intersectionArea);
                        const actualRemainderArea = pieces.reduce((sum, piece) => sum + piece.area, 0);
                        const conservationTolerance = Math.max(GEOMETRY_AREA_EPSILON_M2, parentParcelArea * 1e-7);
                        if (Math.abs(expectedRemainderArea - actualRemainderArea) > conservationTolerance) {
                            throw new Error(`Cut did not conserve parent ground (${Math.round(expectedRemainderArea)} m² expected, ${Math.round(actualRemainderArea)} m² minted)`);
                        }
                        // A parent that is ANOTHER proposal's formed plot: its remainders stay
                        // the VICTIM's children — the largest kept piece IS the plot (same
                        // parcel, smaller: it keeps the plot's id and everything else the clone
                        // already carries — proposalId, parents, roots, ownership; 2042's plot
                        // knows nothing about the road that cut it). Splits continue the
                        // victim's own numbering. Only the taker's corridor ground changes hands.
                        const formationEditForeign = (typeof window !== 'undefined') ? window.__formationEdit : null;
                        const foreignParts = (formationEditForeign && typeof formationEditForeign.derivedIdParts === 'function')
                            ? formationEditForeign.derivedIdParts(parcelId) : null;
                        const isForeignPlot = !!(foreignParts && foreignParts.token && foreignParts.token !== proposalToken);
                        let foreignKeptCount = 0;
                        pieces.forEach(piece => {
                            const newFeature = JSON.parse(JSON.stringify(originalFeature));
                            newFeature.geometry.type = 'Polygon';
                            newFeature.geometry.coordinates = piece.coords;
                            newFeature.properties.calculatedArea = piece.area;
                            if (isForeignPlot) {
                                const isPrimary = foreignKeptCount === 0;
                                foreignKeptCount += 1;
                                const carriedId = isPrimary
                                    ? String(parcelId)
                                    : `${foreignParts.base}#${foreignParts.token}-${allocForeignIndex(foreignParts.base, foreignParts.token)}`;
                                const carriedNumber = isPrimary
                                    ? (originalNumber !== undefined && originalNumber !== null ? String(originalNumber) : null)
                                    : _composeSyntheticParcelNumber(rootNumber, foreignParts.token, Number(carriedId.slice(carriedId.lastIndexOf('-') + 1)));
                                newFeature.properties.__carryIdentity = { parcelId: carriedId, parcelNumber: carriedNumber };
                                _ensureParcelIdOnProperties(newFeature.properties, carriedId);
                                childFeatures.push(newFeature);
                                return;
                            }
                            newFeature.properties.parentParcelId = parcelId;
                            newFeature.properties.parentParcelNumber = originalNumber;
                            newFeature.properties.rootParcelNumber = rootNumber;
                            newFeature.properties.rootParcelId = rootParcelId;
                            newFeature.properties.proposalId = safeId;
                            newFeature.properties.isRoad = parentIsRoad;
                            // Corridor-ness inherits the parent's own flag: a re-cut drawn-road slice
                            // stays a corridor, but a legacy road parcel's remainder is a plain grey
                            // road parcel, never a corridor strip.
                            newFeature.properties.isCorridor = originalFeature?.properties?.isCorridor === true
                                || originalFeature?.properties?.isCorridor === 'true';

                            _assignOwnershipDetails(newFeature, {
                                parentFeature: originalFeature,
                                defaultOwnerName: proposalData?.author || 'User'
                            });
                            childFeatures.push(newFeature);
                        });
                    } catch (error) {
                        console.error(`Error processing parcel ${parcelId} (Number: ${originalNumber}):`, error);
                        if (buildOptions && Array.isArray(buildOptions.cutFailures)) {
                            buildOptions.cutFailures.push({ parcelId: String(parcelId || ''), message: error && error.message ? error.message : String(error) });
                        }
                    }
                });
            }

            // Flat declaration, written where the cut is computed (§15.1): the base cadastral
            // parcels under this formation's footprint — one hop deep whatever generation the
            // consumed parents belonged to.
            if (affectedRootParcelIds.length) {
                proposalData.cadastreParcelIds = affectedRootParcelIds.slice();
            }

            this._assignSyntheticChildIdentities(safeId, childFeatures);
            // Contiguity assignment explodes a MultiPolygon corridor into one parcel per connected
            // component. Recompute the per-piece area after that split (the source feature carried
            // the full footprint area).
            childFeatures.forEach(feature => {
                if (!feature || !feature.geometry || !feature.properties) return;
                if (feature.properties.isCorridor === true || feature.properties.isTrack === true) {
                    feature.properties.calculatedArea = _calculateGeoJsonArea(feature.geometry);
                }
            });
            return childFeatures;
        }

        return [];
    },

   _assignSyntheticChildIdentities(proposalId, childFeatures, options = {}) {
        _assignSyntheticChildIdentitiesImpl(proposalId, childFeatures, options);
    },

    _createForeignIndexAllocator() {
        return _createForeignIndexAllocator();
    },

    _buildSyntheticToken,
    _composeSyntheticParcelNumber,
    _composeSyntheticParcelId,
    isSyntheticParcelId,

   _getCanonicalStructureGeometry(proposalData, kindHint = null) {
        if (!proposalData || !proposalData.geometry) return null;
        const geometry = proposalData.geometry;
        const kind = this._normalizeGoalKey(kindHint || proposalData.goal);
        if (kind === 'lake') {
            if (geometry.lakeGraphics && geometry.lakeGraphics.geometry) return geometry.lakeGraphics.geometry;
            if (geometry.lakeGraphics && geometry.lakeGraphics.type && geometry.lakeGraphics.coordinates) return geometry.lakeGraphics;
        }
        if (kind === 'park' && geometry.parkGraphics) return geometry.parkGraphics;
        if (kind === 'square' && geometry.squareGraphics) return geometry.squareGraphics;
        if (kind === 'station' && geometry.stationGraphics) return geometry.stationGraphics;
        if (geometry.squareGraphics) return geometry.squareGraphics;
        return null;
    },

    _commitReplacementSupersession(proposalId, proposalData) {
        if (typeof commitReplacementSupersession !== 'function') return null;
        const transaction = commitReplacementSupersession(proposalData, proposalId, id => _getProposalRecord(id));
        if (!transaction) return null;
        // The source may already have stamped its prefix in the current pass. Its explicit
        // replacement parks the record permanently, so derive once more without that source.
        if (this._rebuildInProgress) this._replayInvalidated = true;
        if (typeof proposalStorage.save === 'function') proposalStorage.save();
        const source = transaction.source;
        const sourceName = source.title || source.name || source.proposalName || source.proposalId || 'the previous proposal';
        try {
            if (typeof showEphemeralMessage === 'function') {
                showEphemeralMessage(`Applied the replacement and removed “${sourceName}” from the map.`, 5000, 'success');
            }
        } catch (_) { }
        return transaction;
    },

    // Ruling 2026-08-07 "(ask to) unapply": a land readjustment stands on cadastral parcels
    // only. When its ground is currently held by other proposals' fabric, offer to unapply the
    // holders — OUTSIDE the fabric queue, so the real unapply flow (dependents panel, rebuild)
    // runs unnested. Declining leaves the apply to the in-transaction gate, which refuses with
    // the same explanation; that gate in _applyReparcellizationProposal stays authoritative.
    async _offerToFreeReadjustmentGround(proposalId) {
        const record = _getProposalRecord(proposalId);
        if (!record || appliedOf(record)) return;
        if (this._rebuildInProgress === true) return;
        if (!(record.reparcellization && Array.isArray(record.reparcellization.polygons)
            && record.reparcellization.polygons.length)) return;
        const ancestry = (typeof window !== 'undefined') ? window.__cadastreAncestry : null;
        if (!ancestry || typeof ancestry.resolveParentsByGeometry !== 'function') return;
        const resolution = ancestry.resolveParentsByGeometry(record);
        const derived = (resolution && Array.isArray(resolution.ids) ? resolution.ids : [])
            .map(String).filter(id => id.includes('#'));
        if (!derived.length) return;
        const byId = (typeof getParcelLayerIdMap === 'function') ? getParcelLayerIdMap() : null;
        const formationEdit = (typeof window !== 'undefined') ? window.__formationEdit : null;
        const coverers = new Map();
        derived.forEach(id => {
            let ownerId = '';
            try {
                const layer = byId && typeof byId.get === 'function' ? byId.get(id) : null;
                const gj = layer && typeof layer.toGeoJSON === 'function' ? layer.toGeoJSON(false) : null;
                const feature = gj && gj.type === 'FeatureCollection' ? gj.features[0] : gj;
                if (feature && feature.properties && feature.properties.proposalId) {
                    ownerId = String(feature.properties.proposalId);
                }
            } catch (_) { }
            if (!ownerId && formationEdit && typeof formationEdit.derivedIdParts === 'function') {
                const parts = formationEdit.derivedIdParts(id);
                if (parts && parts.token && String(parts.token).startsWith('c-')) ownerId = String(parts.token).slice(2);
            }
            if (!ownerId) return;
            const holder = _getProposalRecord(ownerId);
            if (!holder) return;
            const standing = (typeof isProposalCurrentlyApplied === 'function')
                ? isProposalCurrentlyApplied(holder) : appliedOf(holder);
            if (standing) coverers.set(String(holder.proposalId), holder.title || holder.name || String(holder.proposalId));
        });
        if (!coverers.size) return;
        const names = Array.from(coverers.values()).map(n => `"${n}"`).join(', ');
        const question = `A land readjustment must stand on cadastral parcels. This ground is currently held by ${names}.\n\nUnapply ${coverers.size === 1 ? 'it' : 'them'} and continue?`;
        let confirmed = false;
        if (typeof window.showStyledConfirm === 'function') {
            try {
                confirmed = await window.showStyledConfirm(question, { okText: 'Unapply and continue', cancelText: 'Cancel' });
            } catch (_) { confirmed = typeof window.confirm === 'function' ? window.confirm(question) : false; }
        } else if (typeof window.confirm === 'function') {
            confirmed = window.confirm(question);
        }
        if (!confirmed) return;
        for (const holderId of coverers.keys()) {
            try {
                await this.unapplyProposal(holderId);
            } catch (error) {
                console.warn('[readjustment ground] could not unapply holder', holderId, error);
            }
        }
    },

    async applyProposal(proposalId, options = {}) {
        const applyOptions = options || {};
        if (applyOptions.replay !== true) {
            if (applyOptions.silent !== true) {
                try { await this._offerToFreeReadjustmentGround(proposalId); } catch (error) {
                    console.warn('[applyProposal] free-ground offer failed', error);
                }
            }
            return this._enqueueFabricChange(async () => {
                if (typeof proposalStorage === 'undefined') return false;
                const proposal = _getProposalRecord(proposalId);
                if (!proposal) return false;
                if (appliedOf(proposal)) return true;

                // Applying is a record flip followed by the same complete derivation used by
                // reload, edit and unapply. No external caller stamps into the current map.
                const marked = await _runProposalMutationBoundary(
                    this,
                    'apply-state',
                    proposalId,
                    applyOptions,
                    () => {
                        setProposalApplied(proposal, true);
                        proposalStorage._indexProposal?.(proposal);
                        proposalStorage.save?.();
                        return true;
                    }
                );
                if (marked !== true) return false;

                try {
                    const replay = await this.rebuildAppliedFabric({
                        silent: applyOptions.silent === true,
                        _fabricQueue: true
                    });
                    const failed = (replay?.failed || [])
                        .some(entry => String(entry?.proposalId || '') === String(proposal.proposalId));
                    if (failed) {
                        setProposalApplied(proposal, false, { stamp: false });
                        proposalStorage._indexProposal?.(proposal);
                        proposalStorage.save?.();
                        await this.rebuildAppliedFabric({ silent: true, _fabricQueue: true });
                        this._refreshUIAfterProposalChange(proposal);
                        return false;
                    }
                } catch (error) {
                    setProposalApplied(proposal, false, { stamp: false });
                    proposalStorage._indexProposal?.(proposal);
                    proposalStorage.save?.();
                    throw error;
                }
                const refreshed = _getProposalRecord(proposalId) || proposal;
                const standing = (typeof isProposalCurrentlyApplied === 'function')
                    ? isProposalCurrentlyApplied(refreshed)
                    : appliedOf(refreshed);
                this._refreshUIAfterProposalChange(refreshed);
                return standing;
            });
        }

        return _runProposalMutationBoundary(this, 'replay-apply', proposalId, applyOptions, (_transaction, transactionOptions) => (
                this._applyProposalTransactionBody(proposalId, transactionOptions)
        ));
    },

    async _applyProposalTransactionBody(proposalId, options = {}) {
        const safeId = _normalizeProposalId(proposalId) || '';
        const applyOptions = options || {};

        try { this._clearLastApplyFailure(safeId); } catch (_) { }

        if (typeof proposalStorage === 'undefined') {
            console.warn(`[ProposalManager.applyProposal] proposalStorage is undefined`);
            return false;
        }

        const proposalData = _getProposalRecord(safeId);
        if (!proposalData) {
            console.warn(`[ProposalManager.applyProposal] Proposal not found: ${safeId}`);
            return false;
        }

        // `applied` is authoritative only after the single boot replay barrier. A standing record
        // is already one stamp in the current derivation; missing cached children never trigger a
        // second restore path. Rebuild is the sole materializer.
        const isAlreadyApplied = appliedOf(proposalData);
        if (isAlreadyApplied) return true;
        // Route decision lives in the pure proposals/apply/route.js (unit-tested); this method keeps
        // only the I/O around it.
        const { route, goalKey } = applyRoute.classifyApplyRoute(proposalData);
        let result = false;

        // Ownership-transfer proposals (generic "parcel", ownership-transfer-to-me/from-me, and the
        // post-sale "to-buyer") have no visual map payload — ownership is moved at execute time by
        // the chokepoint, not here — so apply is an idempotent no-op success. Without this, every
        // parcel load re-applies these executed proposals and logs "Unsupported" once per pan.
        if (route === 'noop') {
            try { this._clearLastApplyFailure(safeId); } catch (_) { }
            return true;
        }

        if (route === 'unsupported') {
            const message = `Unsupported proposal goal: ${goalKey || 'missing goal'}`;
            try { this._setLastApplyFailure(safeId, message); } catch (_) { }
            console.warn(`[ProposalManager.applyProposal] ${message}`, { proposalId: safeId, goal: proposalData.goal });
            console.warn(`Applying proposal ${_getProposalApplyLabel(safeId, proposalData)} ... failed`);
            return false;
        }

        result = await _runProposalApplyWithSummary(safeId, proposalData, async () => {
            if (route === 'road-track') {
                return await this._applyRoadProposal(safeId, proposalData, applyOptions);
            }
            if (route === 'reparcellization') {
                return await this._applyReparcellizationProposal(safeId, proposalData, applyOptions);
            }
            if (route === 'decide-later') {
                return await this._applyDecideLaterProposal(safeId, proposalData);
            }
            if (route === 'building') {
                return await this._applyBuildingProposal(safeId, proposalData, applyOptions);
            }
            if (!proposalData.structureProposal) {
                const message = 'Cannot apply structure: the stored record has no authored structureProposal. Run the tessellation migration first.';
                this._setLastApplyFailure(safeId, { code: 'nonconforming-structure-record', message });
                return false;
            }
            return await this._applyStructureProposal(safeId, proposalData, applyOptions);
        });

        if (result) {
            this._commitReplacementSupersession(safeId, proposalData);
            try { this._clearLastApplyFailure(safeId); } catch (_) { }
        }
        return result;
    },

    _isBuildingProposal(proposalData) {
        if (!proposalData) return false;
        return applyRoute.isBuildingGoal(this._normalizeGoalKey(proposalData.goal));
    },

    _isDecideLaterProposal(proposalData) {
        if (!proposalData) return false;
        const goalKey = this._normalizeGoalKey(proposalData.goal);
        return goalKey === 'decide-later';
    },

    _normalizeGoalKey(rawGoal) {
        // Single source of truth in proposals/apply/route.js — this stays as a thin delegator so the
        // ~40 internal callers keep working.
        return applyRoute.normalizeGoalKey(rawGoal);
    },

    async unapplyProposal(proposalId, options = {}) {
        const suppliedTransaction = proposalMutationTransactions.isActiveTransaction(options._mutationTransaction);
        if (!suppliedTransaction && options.skipRebuild !== true && !this._rebuildInProgress) {
            return this._enqueueFabricChange(async () => {
                const result = await _runProposalMutationBoundary(
                    this,
                    'unapply-state',
                    proposalId,
                    options,
                    (_transaction, transactionOptions) => this._unapplyProposalTransactionBody(proposalId, transactionOptions)
                );
                if (result === true) {
                    await this.rebuildAppliedFabric({ _fabricQueue: true });
                    this._refreshUIAfterProposalChange(_getProposalRecord(proposalId));
                }
                return result;
            });
        }
        const result = await _runProposalMutationBoundary(this, 'unapply', proposalId, options, (_transaction, transactionOptions) => (
            this._unapplyProposalTransactionBody(proposalId, transactionOptions)
        ));
        if (result === true && !suppliedTransaction && !this._rebuildInProgress) {
            this._refreshUIAfterProposalChange(_getProposalRecord(proposalId));
        }
        return result;
    },

    async _unapplyProposalTransactionBody(proposalId, options = {}) {
        if (typeof proposalStorage === 'undefined') return false;

        const proposalData = _getProposalRecord(proposalId);
        if (!proposalData) return false;

        const supported = !!(
            proposalData.roadProposal
            || proposalData.buildingProposal
            || proposalData.structureProposal
            || proposalData.reparcellization
            || proposalData.decideLaterProposal
        );
        if (!supported) return false;
        if (!appliedOf(proposalData)) return true;

        // Unapply is only a record-state change. The following rebuild removes every derived
        // layer and starts from cadastre; there is no per-type reversal or restore algorithm.
        this._clearDerivedRecordState(proposalData);
        setProposalApplied(proposalData, false, { stamp: false });
        proposalStorage._indexProposal?.(proposalData);
        proposalStorage.save?.();
        return true;
    },

    /**
     * Refresh all UI elements after a proposal state change.
     * This is called after the record change and canonical replay.
     */
    _refreshUIAfterProposalChange(proposalData) {
        // Core proposal UI
        // The corridor parcel a road proposal creates has just appeared or vanished; its cross-section
        // has to follow. This is the one place both unapply paths meet — the direct one and the one
        // that runs later, inside the descendants-confirmation modal's callback.
        try { if (typeof scheduleCorridorStripRefresh === 'function') scheduleCorridorStripRefresh(); } catch (_) { }
        try { if (typeof refreshParcelStylesForAppliedProposals === 'function') refreshParcelStylesForAppliedProposals(); } catch (_) { }
        try { if (typeof updateProposalLayer === 'function') updateProposalLayer(); } catch (_) { }
        try { if (typeof updateProposalList === 'function') updateProposalList(); } catch (_) { }
        try { if (typeof updateShowProposalsButton === 'function') updateShowProposalsButton(); } catch (_) { }
        try { if (typeof syncProposalsIndicator === 'function') syncProposalsIndicator(); } catch (_) { }

        // Structure layers (parks, lakes, squares)
        try { if (typeof updateParksLayer === 'function') updateParksLayer(); } catch (_) { }
        try { if (typeof updateLakesLayer === 'function') updateLakesLayer(); } catch (_) { }
        try { if (typeof updateSquaresLayer === 'function') updateSquaresLayer(); } catch (_) { }

        // Building layers
        try { if (typeof updateProposedBuildingsLayer === 'function') updateProposedBuildingsLayer(); } catch (_) { }

        // Reparcellization layers
        try { if (typeof updateReparcellizationLayers === 'function') updateReparcellizationLayers(); } catch (_) { }

        // Refresh the proposals modal if it's open
        try {
            if (typeof showAllProposalsModal === 'function') {
                const modal = document.querySelector('.proposal-list-modal');
                if (modal && modal.style.display === 'block') {
                    showAllProposalsModal();
                }
            }
        } catch (_) { }

        // If a proposal is highlighted, update its panel/highlights
        if (proposalData && window.currentlyHighlightedProposalId &&
            String(window.currentlyHighlightedProposalId) === String(proposalData.proposalId)) {
            try {
                if (typeof selectAndHighlightProposal === 'function') {
                    selectAndHighlightProposal(proposalData.proposalId, window.selectedParcelInProposal, false, true);
                } else if (typeof showProposalInfo === 'function') {
                    showProposalInfo(proposalData, window.selectedParcelInProposal);
                }
                if (typeof applyProposalHighlights === 'function') {
                    applyProposalHighlights();
                }
            } catch (_) { }
        }

        // Refresh parcel info panel if it's open and showing an affected parcel
        try {
            if (proposalData && typeof window.selectedParcelId !== 'undefined' && window.selectedParcelId) {
                const affectedIds = [
                    ...(proposalData.parentParcelIds || []),
                    ...(proposalData.childParcelIds || [])
                ].map(id => id?.toString()).filter(Boolean);
                if (affectedIds.includes(window.selectedParcelId.toString())) {
                    if (typeof showParcelInfoPanel === 'function' && window.parcelLayer) {
                        const parcelLayer = window.parcelLayer.getLayers().find(l =>
                            _getParcelIdFromFeature(l.feature)?.toString() === window.selectedParcelId.toString()
                        );
                        if (parcelLayer) {
                            showParcelInfoPanel(parcelLayer.feature);
                        }
                    }
                }
            }
        } catch (_) { }
    },

    async deleteProposal(proposalId) {
        return this._enqueueFabricChange(() => this._deleteProposalConfirmed(proposalId, { _fabricQueue: true }));
    },

    async _deleteProposalConfirmed(proposalId, options = {}) {
        if (typeof proposalStorage === 'undefined') return false;
        const proposalData = _getProposalRecord(proposalId);
        if (!proposalData) return false;
        const title = proposalData.title || proposalData.name || 'Proposal';
        const wasApplied = appliedOf(proposalData);

        // Deleting a record has the same fabric semantics as unapplying it: remove the record,
        // then derive the remaining applied set once from cadastre. There is no descendant family.
        proposalStorage.removeProposal(proposalId);
        if (wasApplied && !this._rebuildInProgress) {
            try { await this.rebuildAppliedFabric({ _fabricQueue: options._fabricQueue === true }); }
            catch (error) {
                console.error('[deleteProposal] cadastre replay failed', error);
                return false;
            }
        }
        try {
            if (window.currentlyHighlightedProposalId
                && String(window.currentlyHighlightedProposalId) === String(proposalId)) {
                window.ProposalSelection?.clear?.();
                if (typeof clearProposalHighlights === 'function') clearProposalHighlights();
                if (typeof hideProposalDetailsPanel === 'function') hideProposalDetailsPanel();
            }
        } catch (_) { }
        this._refreshUIAfterProposalChange(null);
        if (typeof updateStatus === 'function') updateStatus('Proposal \"' + title + '\" deleted');
        return true;
    },

    _removeFeaturesFromMap(features) {
        // Use the standard removeParcelLayerById function for each feature
        // This is the same function used elsewhere in the codebase and works correctly
        if (!features || !Array.isArray(features)) {
            return;
        }

        features.forEach(feature => {
            const parcelId = _getParcelIdFromFeature(feature);
            if (parcelId !== undefined && parcelId !== null) {
                // A corridor's rails belong to the applied-corridor overlay, which is rebuilt wholesale
                // whenever a corridor changes — the parcel layer carries no rails to detach.
                if (typeof window.removeParcelLayerById === 'function') {
                    window.removeParcelLayerById(parcelId);
                }
            }
        });

        // Refresh parcel number labels if visible
        if (typeof refreshParcelNumberLabelsIfVisible === 'function') {
            refreshParcelNumberLabelsIfVisible();
        }

        // Update visible parcel count if function exists
        if (typeof updateVisibleParcelsCount === 'function') {
            updateVisibleParcelsCount();
        }
    },

    /**
     * Hide parent features from visible parcelLayer but keep them in parcelLayerById.
     * Use this when hiding parents that may still be needed as parents for descendant proposals.
     */
    _hideFeaturesFromMap(features) {
        if (!features || !Array.isArray(features)) {
            return;
        }

        features.forEach(feature => {
            const parcelId = _getParcelIdFromFeature(feature);
            if (parcelId !== undefined && parcelId !== null) {
                // Hide using the new function that keeps entry in parcelLayerById
                if (typeof window.hideParcelLayerById === 'function') {
                    window.hideParcelLayerById(parcelId);
                } else if (typeof window.parcelLayer !== 'undefined' && typeof window.resolveParcelLayerById === 'function') {
                    // Fallback: directly remove from parcelLayer only
                    const layer = window.resolveParcelLayerById(parcelId);
                    if (layer && window.parcelLayer && window.parcelLayer.hasLayer(layer)) {
                        window.parcelLayer.removeLayer(layer);
                    }
                }
            }
        });

        // Refresh parcel number labels if visible
        if (typeof refreshParcelNumberLabelsIfVisible === 'function') {
            refreshParcelNumberLabelsIfVisible();
        }

        // Update visible parcel count if function exists
        if (typeof updateVisibleParcelsCount === 'function') {
            updateVisibleParcelsCount();
        }
    },

    _addFeaturesToMap(features, useNormalStyle = false, proposalData = null) {
        if (!window.parcelLayer) {
            window.parcelLayer = L.featureGroup();
            // Only add to map if zoom is appropriate
            const isZoomAppropriate = typeof isZoomWithinParcelRange === 'function'
                ? isZoomWithinParcelRange()
                : map.getZoom() >= 15; // Default threshold
            if (isZoomAppropriate) {
                window.parcelLayer.addTo(map);
            }
        } else {
            // If parcelLayer exists but is not on map, check if we should add it
            if (!map.hasLayer(window.parcelLayer)) {
                const isZoomAppropriate = typeof isZoomWithinParcelRange === 'function'
                    ? isZoomWithinParcelRange()
                    : map.getZoom() >= 15; // Default threshold
                if (isZoomAppropriate) {
                    window.parcelLayer.addTo(map);
                }
            }
        }

        // Create SVG pattern for striped roads (only once)
        if (!document.getElementById('proposal-road-pattern')) {
            const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg.setAttribute('id', 'proposal-road-pattern-svg');
            svg.style.position = 'absolute';
            svg.style.width = '0';
            svg.style.height = '0';

            const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
            const pattern = document.createElementNS('http://www.w3.org/2000/svg', 'pattern');
            pattern.setAttribute('id', 'proposal-road-pattern');
            pattern.setAttribute('patternUnits', 'userSpaceOnUse');
            pattern.setAttribute('width', '10');
            pattern.setAttribute('height', '10');
            pattern.setAttribute('patternTransform', 'rotate(45)');

            const rect1 = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
            rect1.setAttribute('width', '5');
            rect1.setAttribute('height', '10');
            rect1.setAttribute('fill', '#2d5016'); // Dark green

            const rect2 = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
            rect2.setAttribute('x', '5');
            rect2.setAttribute('width', '5');
            rect2.setAttribute('height', '10');
            rect2.setAttribute('fill', '#3d6a1f'); // Lighter green

            pattern.appendChild(rect1);
            pattern.appendChild(rect2);
            defs.appendChild(pattern);
            svg.appendChild(defs);
            document.body.appendChild(svg);
        }

        const proposalRoadStyle = {
            fillColor: '#2d5016', // Dark green for proposed roads
            fillOpacity: 0.8,
            color: '#1a3d0a',
            weight: 2,
            dashArray: '5, 5'
        };

        const proposalParcelStyle = {
            fillColor: '#FFD700', // Gold for proposed parcels
            fillOpacity: 0.5,
            color: '#000',
            weight: 2,
            dashArray: '5, 5'
        };

        const trackPolygonStyle = {
            color: '#000000',
            weight: 2,
            opacity: 0.9,
            dashArray: '',
            fillColor: '#d3d3d3',
            fillOpacity: 0.35
        };

        const proposalId = proposalData?.proposalId || proposalData?.id || null;
        const trackDefinition = proposalData?.roadProposal?.definition || null;
        const flattenTrackPoints = (points) => {
            if (!Array.isArray(points)) return null;
            const result = [];
            const walk = (arr) => {
                if (!Array.isArray(arr)) return;
                arr.forEach(p => {
                    if (Array.isArray(p)) {
                        walk(p);
                    } else if (p !== undefined && p !== null) {
                        result.push(p);
                    }
                });
            };
            walk(points);
            return result;
        };
        const trackDefinitionPoints = flattenTrackPoints(trackDefinition?.points);
        const trackDefinitionWidth = trackDefinition?.width;

        try {
            const sample = Array.isArray(features)
                ? features.slice(0, 20).map(f => {
                    const pid = _getParcelIdFromFeature(f);
                    const props = f?.properties || {};
                    const hasTrackPts = Array.isArray(props.trackPoints);
                    return {
                        parcelId: pid,
                        isTrack: props.isTrack === true,
                        isRoad: props.isRoad === true,
                        hasTrackPoints: hasTrackPts,
                        trackPointCount: hasTrackPts ? props.trackPoints.length : 0
                    };
                })
                : [];
            console.debug('[_addFeaturesToMap] start', {
                featureCount: Array.isArray(features) ? features.length : 0,
                useNormalStyle,
                proposalId,
                trackDefinitionWidth,
                trackDefinitionPoints: trackDefinitionPoints ? trackDefinitionPoints.length : 0,
                sample
            });
        } catch (logErr) {
            console.warn('[_addFeaturesToMap] failed to log start', logErr);
        }

        const beforeCount = window.parcelLayer ? window.parcelLayer.getLayers().length : 0;

        // Partition features: bulk-add non-track parcels when using normal style; handle tracks separately
        const trackFeatures = Array.isArray(features)
            ? features.filter(f => f?.properties?.isTrack === true)
            : [];
        const bulkCandidates = Array.isArray(features)
            ? features.filter(f => !(f?.properties?.isTrack === true))
            : [];
        console.debug('[_addFeaturesToMap] partition', {
            totalFeatures: features.length,
            trackFeatures: trackFeatures.length,
            bulkCandidates: bulkCandidates.length,
            trackFeaturesIds: trackFeatures.map(f => _getParcelIdFromFeature(f)),
            trackProps: trackFeatures.map(f => ({ id: _getParcelIdFromFeature(f), isTrack: f?.properties?.isTrack, isRoad: f?.properties?.isRoad }))
        });
        const canBulkAdd = useNormalStyle && bulkCandidates.length > 0;

        if (canBulkAdd) {
            const featureCollection = { type: 'FeatureCollection', features: bulkCandidates };
            const selectionOnEach = (window.Parcels && window.Parcels.selection && window.Parcels.selection.onEachFeature)
                ? window.Parcels.selection.onEachFeature
                : window.onEachFeature;
            const onEachFeature = (feature, layer) => {
                const parcelId = _getParcelIdFromFeature(feature);
                if (parcelId && layer?.feature?.properties) {
                    _ensureParcelIdOnProperties(layer.feature.properties, parcelId);
                }

                // Ensure interaction handlers are wired even when bulk-adding
                if (typeof selectionOnEach === 'function') {
                    selectionOnEach(feature, layer);
                }
                if (layer?.options) {
                    layer.options.interactive = true;
                }
                if (typeof layer?.setInteractive === 'function') {
                    layer.setInteractive(true);
                }
            };

            const styleFn = (feat) => {
                const isRoad = feat?.properties?.isRoad;
                if (isRoad && feat?.properties?.isCorridor === true && window.corridorParcelStyle) {
                    return window.corridorParcelStyle;
                }
                return isRoad ? window.roadStyle : window.normalStyle;
            };

            try {
                const mapById = (typeof window.getParcelLayerIdMap === 'function')
                    ? window.getParcelLayerIdMap()
                    : (window.parcelLayerById instanceof Map ? window.parcelLayerById : null);
                const indexParcelLayer = (window.Parcels && window.Parcels.storage && window.Parcels.storage.indexParcelLayer)
                    ? window.Parcels.storage.indexParcelLayer
                    : window.indexParcelLayer;

                const geoJsonLayer = L.geoJSON(featureCollection, {
                    style: styleFn,
                    onEachFeature
                });
                geoJsonLayer.eachLayer(layer => {
                    const pid = _getParcelIdFromFeature(layer?.feature);
                    const idStr = pid !== undefined && pid !== null ? pid.toString() : null;
                    if (idStr && mapById && typeof window.removeParcelLayerById === 'function') {
                        const existing = mapById.get(idStr);
                        if (existing && existing !== layer && window.parcelLayer && window.parcelLayer.hasLayer(existing)) {
                            try { window.removeParcelLayerById(idStr); } catch (_) { }
                        }
                    }
                    window.parcelLayer.addLayer(layer);

                    // Register in id->layer map for O(1) lookup (do this AFTER any removals to keep mapping consistent)
                    if (idStr && typeof window.setParcelLayerById === 'function') {
                        try { window.setParcelLayerById(idStr, layer); } catch (_) { }
                    }

                    // Index for spatial lookups (only for layers we actually add)
                    if (typeof indexParcelLayer === 'function') {
                        indexParcelLayer(layer);
                    }

                });
            } catch (err) {
                console.warn('[_addFeaturesToMap] Bulk add failed, falling back to per-feature path', err);
            }
        }

        // Handle remaining features (tracks, or all if no bulk add)
        const featuresToProcess = canBulkAdd ? trackFeatures : features;

        featuresToProcess.forEach(feature => {
            // Check if this is a track - rely on the isTrack flag provided by upstream flow
            const isTrack = feature.properties.isTrack === true;

            // A track's corridor parcel gets the track's own fill. Its RAILS are not drawn here: rails
            // belong to the rail lanes of the corridor's cross-section, and corridor-render.js lays them
            // with the rest of the cross-section (see refreshAppliedCorridorStrips). Drawing them here
            // too would double every sleeper.
            if (isTrack) {
                const onEachFeature = (window.Parcels && window.Parcels.selection && window.Parcels.selection.onEachFeature)
                    ? window.Parcels.selection.onEachFeature
                    : window.onEachFeature;

                const newLayer = L.geoJSON(feature, {
                    style: () => ({ ...trackPolygonStyle }),
                    onEachFeature
                });

                newLayer.eachLayer(layer => {
                    const parcelId = _getParcelIdFromFeature(layer?.feature);
                    if (parcelId && layer?.feature?.properties) {
                        _ensureParcelIdOnProperties(layer.feature.properties, parcelId);
                    }
                    window.parcelLayer.addLayer(layer);
                    if (typeof window.setParcelLayerById === 'function') {
                        try { window.setParcelLayerById(parcelId, layer); } catch (_) { }
                    }
                    const indexParcelLayer = (window.Parcels && window.Parcels.storage && window.Parcels.storage.indexParcelLayer)
                        ? window.Parcels.storage.indexParcelLayer
                        : window.indexParcelLayer;
                    if (typeof indexParcelLayer === 'function') {
                        indexParcelLayer(layer);
                    }
                    // Store track style on layer so getParcelBaseStyle can find it
                    layer._trackStyle = { ...trackPolygonStyle };
                    // Force initial style application (fixes dark grey flicker)
                    if (layer.setStyle) {
                        layer.setStyle({ ...trackPolygonStyle });
                    }
                    console.debug('[_addFeaturesToMap] track layer created', {
                        parcelId,
                        hasTrackStyle: Boolean(layer._trackStyle),
                        isTrackProp: layer?.feature?.properties?.isTrack
                    });
                    // Hover: standard parcel style (weight 5, grey solid); mouseout: return to track style unless selected
                    if (layer.on) {
                        layer.on('mouseover', () => {
                            // Don't override selection style
                            const layerParcelId = _getParcelIdFromFeature(layer?.feature);
                            if (layerParcelId && window.selectedParcelId && layerParcelId.toString() === window.selectedParcelId.toString()) {
                                return;
                            }
                            if (layer.setStyle) layer.setStyle({ weight: 5, color: '#666', dashArray: '' });
                            if (!L.Browser.ie && !L.Browser.opera && !L.Browser.edge && typeof layer.bringToFront === 'function') {
                                layer.bringToFront();
                            }
                        });
                        layer.on('mouseout', () => {
                            // Don't reset if this is the selected parcel
                            const layerParcelId = _getParcelIdFromFeature(layer?.feature);
                            if (layerParcelId && window.selectedParcelId && layerParcelId.toString() === window.selectedParcelId.toString()) {
                                return;
                            }
                            if (layer.setStyle) layer.setStyle({ ...trackPolygonStyle });
                        });
                    }
                });
            } else {
                // Regular road or parcel - use normal styling
                let style;
                if (useNormalStyle) {
                    if (feature.properties.isRoad) {
                        style = (feature.properties.isCorridor === true && window.corridorParcelStyle)
                            ? window.corridorParcelStyle
                            : window.roadStyle;
                    } else if (feature.properties.color) {
                        // A non-road child carrying an explicit tint (e.g. a reparcellization
                        // slice re-cut by a road edit) keeps that tint instead of dropping to
                        // the transparent default - the slice identity survives the re-cut.
                        style = { color: '#333333', weight: 1, fillColor: feature.properties.color, fillOpacity: 0.35 };
                    } else {
                        style = window.normalStyle;
                    }
                } else {
                    // Use different styles for roads vs parcels in proposals
                    style = feature.properties.isRoad ? proposalRoadStyle : proposalParcelStyle;
                }

                // console.log(`Adding feature: ${_getParcelIdFromFeature(feature)}, isRoad: ${feature.properties.isRoad}`);

                const onEachFeature = (window.Parcels && window.Parcels.selection && window.Parcels.selection.onEachFeature)
                    ? window.Parcels.selection.onEachFeature
                    : window.onEachFeature;

                const newLayer = L.geoJSON(feature, {
                    style: style,
                    onEachFeature
                });

                newLayer.eachLayer(layer => {
                    const parcelId = _getParcelIdFromFeature(layer?.feature);
                    if (layer?.feature?.properties) {
                        _ensureParcelIdOnProperties(layer.feature.properties, parcelId);
                    }
                    const normalizedId = parcelId ? parcelId.toString() : null;
                    const debugAll = (typeof window !== 'undefined' && window.DEBUG_PROPOSAL_ADD_PARCELS === true);
                    const debugTarget = (typeof window !== 'undefined' && window.DEBUG_PROPOSAL_PARCEL_ID !== undefined && window.DEBUG_PROPOSAL_PARCEL_ID !== null)
                        ? String(window.DEBUG_PROPOSAL_PARCEL_ID)
                        : null;
                    const isDebugParcel = !!normalizedId && (debugAll || (debugTarget && debugTarget === normalizedId));

                    if (isDebugParcel) {
                        console.log(`[ProposalManager._addFeaturesToMap] DEBUG: Adding layer for parcel ${normalizedId}`, {
                            useNormalStyle,
                            inParcelLayer: window.parcelLayer && window.parcelLayer.hasLayer(layer),
                            onMap: window.map && window.map.hasLayer(layer),
                            stack: new Error().stack
                        });
                    }

                    // Check if already exists before adding (fast path: map lookup)
                    const mapById = (typeof window.getParcelLayerIdMap === 'function') ? window.getParcelLayerIdMap() : (window.parcelLayerById instanceof Map ? window.parcelLayerById : null);
                    const existing = mapById ? mapById.get(normalizedId) : (window.resolveParcelLayerById ? window.resolveParcelLayerById(normalizedId) : null);
                    if (existing && existing !== layer) {
                        if (isDebugParcel) {
                            console.log(`[ProposalManager._addFeaturesToMap] DEBUG: Parcel ${normalizedId} already exists, removing old layer first`);
                        }
                        if (typeof window.removeParcelLayerById === 'function') {
                            window.removeParcelLayerById(normalizedId);
                        }
                    }

                    // CRITICAL: Check if layer is already in parcelLayer before adding
                    // This prevents duplicates from being added through this code path
                    if (window.parcelLayer && window.parcelLayer.hasLayer(layer)) {
                        if (isDebugParcel) {
                            console.warn(`[ProposalManager._addFeaturesToMap] DEBUG: Layer for parcel ${normalizedId} is already in parcelLayer, skipping add`);
                        }
                        return; // Skip - already added
                    }

                    // Add to parcelLayer (which is already on the map)
                    window.parcelLayer.addLayer(layer);

                    // Keep id->layer map in sync for O(1) lookups
                    if (typeof window.setParcelLayerById === 'function') {
                        try { window.setParcelLayerById(normalizedId, layer); } catch (_) { }
                    }

                    // Verify it was actually added
                    if (!window.parcelLayer.hasLayer(layer)) {
                        console.error(`[ProposalManager._addFeaturesToMap] ERROR: Failed to add layer for parcel ${normalizedId} to parcelLayer`);
                        return;
                    }

                    const indexParcelLayer = (window.Parcels && window.Parcels.storage && window.Parcels.storage.indexParcelLayer)
                        ? window.Parcels.storage.indexParcelLayer
                        : window.indexParcelLayer;
                    if (typeof indexParcelLayer === 'function') {
                        indexParcelLayer(layer);
                    }

                    if (isDebugParcel) {
                        console.log(`[ProposalManager._addFeaturesToMap] DEBUG: After adding, parcelLayer.hasLayer=${window.parcelLayer && window.parcelLayer.hasLayer(layer)}, map.hasLayer=${window.map && window.map.hasLayer(layer)}`);
                    }

                    // Don't add directly to map - layers in parcelLayer are automatically rendered
                    // when parcelLayer is on the map. Adding directly causes double rendering.
                    // The check map.hasLayer(layer) doesn't work correctly for layers in FeatureGroups.

                    // Apply SVG pattern to proposed roads
                    if (!useNormalStyle && feature.properties.isRoad && layer._path) {
                        layer._path.style.fill = 'url(#proposal-road-pattern)';
                    }

                });
            }
        });

        const afterCount = window.parcelLayer ? window.parcelLayer.getLayers().length : 0;
        console.debug(`[_addFeaturesToMap] Done. Map now has ${afterCount} parcels (added ${afterCount - beforeCount})`);

        if (typeof refreshParcelNumberLabelsIfVisible === 'function') {
            refreshParcelNumberLabelsIfVisible();
        }
    },

    // Helper methods for dependency tracking
    // Record only the immediate creator proposal for a parcel.
    // Persisted shape remains an array for backward compatibility but will contain at most one hash.
    _addProposalAsAncestor(parcelId, proposalId) {
        if (!parcelId || !proposalId) return;
        const normalized = String(proposalId);
        this._upsertParcelProperties(parcelId, props => {
            props.ancestorProposal = normalized;
        }, { persistIfMissing: true });
    },

    _addChildParcels(proposalId, parcelIds, proposalData = null) {
        const proposal = proposalData || _getProposalRecord(proposalId);
        const normalizedIncoming = parcelIds.map(id => String(id)).filter(Boolean);
        const existing = Array.isArray(proposal?.childParcelIds) ? proposal.childParcelIds.map(id => String(id)) : [];
        const merged = Array.from(new Set([...existing, ...normalizedIncoming]));
        if (proposal) {
            proposal.childParcelIds = merged;
            if (typeof proposalStorage !== 'undefined') {
                if (typeof proposalStorage._indexProposal === 'function') {
                    proposalStorage._indexProposal(proposal);
                }
                if (typeof proposalStorage.save === 'function') {
                    proposalStorage.save();
                }
            }
        }
        return merged;
    },

    _getProposalChildParcels(proposalId) {
        const proposal = _getProposalRecord(proposalId);
        const base = Array.isArray(proposal?.childParcelIds) ? proposal.childParcelIds : [];
        return Array.from(new Set(base.map(id => String(id)).filter(Boolean)));
    },

    // Return the immediate creator(s) only; for compatibility we keep an array but cap it to one.
    _getParcelAncestors(parcelId) {
        if (!parcelId) return [];
        const idStr = parcelId && parcelId.toString ? parcelId.toString() : String(parcelId);
        if (!idStr) return [];

        let ancestor = null;
        try {
            const layer = this._getParcelLayerById(idStr);
            if (layer && layer.feature && layer.feature.properties && layer.feature.properties.ancestorProposal) {
                ancestor = layer.feature.properties.ancestorProposal;
            }
        } catch (_) { /* ignore */ }

        if (!ancestor) {
            try {
                const props = (typeof readPersistedParcelRecord === 'function')
                    ? readPersistedParcelRecord(idStr)?.properties
                    : null;
                if (props && props.ancestorProposal) {
                    ancestor = props.ancestorProposal;
                }
            } catch (_) { /* ignore */ }
        }

        return ancestor ? [String(ancestor)] : [];
    },

    // Demolition is an apply-time derivation, never authored or imported state. The scanner can
    // park an earlier proposed building; when that happens inside a replay, the already-stamped
    // prefix is invalid and the outer rebuild performs one more cadastre-first pass.
    async _deriveDemolishedBuildings(geometry, options = {}) {
        const browserRoot = typeof window !== 'undefined' ? window : globalThis;
        if (!geometry || !geometry.type || typeof browserRoot.demolishBuildingsUnderFootprint !== 'function') {
            return [];
        }
        const appliedBefore = new Set();
        if (this._rebuildInProgress && typeof proposalStorage !== 'undefined') {
            try {
                proposalStorage.getAllProposals().forEach(proposal => {
                    if (proposal && isProposalCurrentlyApplied(proposal)) {
                        appliedBefore.add(String(proposal.proposalId));
                    }
                });
            } catch (_) { }
        }
        const records = await browserRoot.demolishBuildingsUnderFootprint(geometry, options);
        if (appliedBefore.size) {
            for (const key of appliedBefore) {
                const proposal = proposalStorage.getProposal(key);
                if (proposal && !isProposalCurrentlyApplied(proposal)) {
                    this._replayInvalidated = true;
                    break;
                }
            }
        }
        return Array.isArray(records) ? records : [];
    },

    // The only parent resolver used by formation application. Declared ids never decide which
    // ground is cut: they are flat cadastral hints for loading/consent. The authored footprint is
    // intersected with the currently visible one-partition fabric, and anything below 95% coverage
    // refuses. There is deliberately no "apply anyway", stored-geometry recovery, occupation
    // genealogy, or descendant retry path.
    _resolveLiveFormationParents(proposalData, idLabel, formationLabel = 'formation') {
        const ancestry = (typeof window !== 'undefined') ? window.__cadastreAncestry : null;
        if (!ancestry || typeof ancestry.resolveParentsByGeometry !== 'function') {
            const message = `Cannot apply ${formationLabel}: the live-fabric geometry resolver is unavailable.`;
            try { this._setLastApplyFailure(idLabel, { code: 'formation-resolver-unavailable', message }); } catch (_) { }
            return { ok: false, ids: [], features: [], coverage: 0, message };
        }

        const resolution = ancestry.resolveParentsByGeometry(proposalData);
        const ids = Array.isArray(resolution && resolution.ids) ? resolution.ids.map(String).filter(Boolean) : [];
        const coverage = Number(resolution && resolution.coverage) || 0;
        if (!ids.length || coverage < 0.95) {
            const message = `The live fabric covers only ${Math.round(coverage * 100)}% of this ${formationLabel}'s footprint; nothing was cut.`;
            try { this._setLastApplyFailure(idLabel, { code: 'formation-ground-unresolved', message, coverage, missingIds: [] }); } catch (_) { }
            try { if (typeof updateStatus === 'function') updateStatus(message); } catch (_) { }
            return { ok: false, ids, features: [], coverage, message };
        }

        const features = this._resolveParcelFeaturesByIds(ids, {
            preferMap: true,
            allowStorage: false,
            fallbackToMap: false,
            allowMissing: true
        });
        if (!Array.isArray(features) || features.length !== ids.length
            || features.some(feature => !feature || !feature.geometry || !/Polygon/.test(String(feature.geometry.type || '')))) {
            const message = `Cannot apply ${formationLabel}: the resolved live parcel geometry is incomplete.`;
            try { this._setLastApplyFailure(idLabel, { code: 'formation-ground-incomplete', message, missingIds: ids }); } catch (_) { }
            return { ok: false, ids, features: [], coverage, message };
        }

        // One partition means selected live parents may touch at borders but may not overlap in
        // area. Refuse a corrupted fabric instead of multiplying its overlap into another replay.
        //
        // This was 5 m² to tolerate "kerf" — sliver debris along the boundaries turf had just cut.
        // That debris was never turf's: it came from reading geometry back through Leaflet's
        // 6-decimal rounding (see cadastre-ancestry.js). With the fabric read at full precision the
        // debris is GONE, measured, not assumed: across the whole live fabric (4,656 parcels,
        // ~21k adjacent pairs) exactly zero overlaps involve a parcel we cut, and the only two that
        // remain are defects in the cadastral source itself, at 1577 and 1855 m². So the floor goes
        // back to the measured-noise scale, and a genuine double-cover is caught instead of waved
        // through under 5 m².
        const OVERLAP_REFUSAL_M2 = 0.25;
        try {
            if (typeof turf !== 'undefined' && typeof turf.intersect === 'function' && typeof turf.area === 'function') {
                for (let i = 0; i < features.length; i += 1) {
                    for (let j = i + 1; j < features.length; j += 1) {
                        const hit = turf.intersect(features[i], features[j]);
                        if (hit && turf.area(hit) > OVERLAP_REFUSAL_M2) {
                            const message = `Cannot apply ${formationLabel}: live parcels ${ids[i]} and ${ids[j]} overlap.`;
                            try { this._setLastApplyFailure(idLabel, { code: 'live-fabric-overlap', message, parcelIds: [ids[i], ids[j]] }); } catch (_) { }
                            return { ok: false, ids, features: [], coverage, message };
                        }
                    }
                }
            }
        } catch (error) {
            const message = `Cannot apply ${formationLabel}: live-fabric overlap validation failed.`;
            try { this._setLastApplyFailure(idLabel, { code: 'live-fabric-invalid', message, error: error && error.message }); } catch (_) { }
            return { ok: false, ids, features: [], coverage, message };
        }

        const formationEdit = (typeof window !== 'undefined') ? window.__formationEdit : null;
        const cadastreIds = formationEdit && typeof formationEdit.baseIdsOfFeatures === 'function'
            ? formationEdit.baseIdsOfFeatures(features)
            : [];
        if (!cadastreIds.length) {
            const message = `Cannot apply ${formationLabel}: the resolved ground has no cadastral anchors.`;
            try { this._setLastApplyFailure(idLabel, { code: 'formation-cadastre-unresolved', message }); } catch (_) { }
            return { ok: false, ids, features: [], cadastreIds: [], coverage, message };
        }
        proposalData.cadastreParcelIds = cadastreIds.slice();
        return { ok: true, ids, features, cadastreIds, coverage };
    },
};

// Per-formation stamp handlers live in proposals/apply/*.js and are mixed in here. Browser
// global or node require, same pattern as the status/route helpers above.
const __applyMixins = (typeof window !== 'undefined' && window.ProposalApplyRoad)
    ? [window.ProposalApplyRoad, window.ProposalApplyBuildings, window.ProposalApplyStructures, window.ProposalApplyParcels]
    : [require('./proposals/apply/road.js'), require('./proposals/apply/buildings.js'), require('./proposals/apply/structures.js'), require('./proposals/apply/parcels.js')];
__applyMixins.forEach(m => Object.assign(ProposalManager, m));

// --- HELPER FUNCTIONS (moved from road-drawing.js) ---

function _stripSyntheticSuffix(value) {
    let current = (value !== undefined && value !== null) ? String(value).trim() : '';
    if (!current) return '';

    let previous = '';
    while (current && current !== previous) {
        previous = current;
        current = current.replace(/#[A-Za-z0-9_-]+-\d+$/i, '');
    }

    return current;
}

function _extractRootParcelNumber(parcelNumber) {
    if (!parcelNumber && parcelNumber !== 0) return '';
    const str = _stripSyntheticSuffix(parcelNumber);
    if (str.length === 0) return '';
    return str.split('/')[0];
}

function _extractRootParcelId(parcelId) {
    if (!parcelId && parcelId !== 0) return '';
    return _stripSyntheticSuffix(parcelId);
}

function _deriveRootParcelNumberFromParcelId(parcelId) {
    const rootId = _extractRootParcelId(parcelId);
    if (!rootId) return '';

    const hrMatch = String(rootId).match(/^HR-\d+-([^#]+)$/i);
    if (hrMatch && hrMatch[1]) {
        return _extractRootParcelNumber(hrMatch[1]);
    }

    return '';
}

function _resolveRootParcelIdFromProperties(props, fallbackParcelId = null) {
    const candidates = [
        props?.rootParcelId,
        props?.parentParcelId,
        props?.parcelId,
        fallbackParcelId
    ];

    for (const candidate of candidates) {
        const rootId = _extractRootParcelId(candidate);
        if (rootId) return rootId;
    }

    return '';
}

function _resolveRootParcelNumberFromProperties(props, fallbackParcelId = null) {
    const candidates = [
        props?.rootParcelNumber,
        props?.parentParcelNumber,
        props?.BROJ_CESTICE,
        props?.parcelNumber,
        props?.parcel_number
    ];

    for (const candidate of candidates) {
        const rootNumber = _extractRootParcelNumber(candidate);
        if (rootNumber) return rootNumber;
    }

    return _deriveRootParcelNumberFromParcelId(fallbackParcelId);
}

// Only reject numerical zero. Real slivers are parcels and must remain in the tessellation.
const GEOMETRY_AREA_EPSILON_M2 = 0.01;

function _shouldSkipUncutRemainder(parentParcelArea, pieceArea) {
    const parentArea = Number(parentParcelArea);
    const remainderArea = Number(pieceArea);
    if (!Number.isFinite(parentArea) || !Number.isFinite(remainderArea) || parentArea <= 0 || remainderArea <= 0) {
        return false;
    }

    // "Uncut remainder" means the road did not actually intersect this parcel — turf.difference
    // handed back (essentially) the whole parent polygon. Detect that with a RELATIVE tolerance so
    // the threshold scales with parcel size instead of a flat 1 m² cliff. The old flat floor made
    // a genuine ~1 m² clip on a small parcel read as "uncut", so the parcel flipped between 0 and 1
    // child on sub-metre corridor differences. A tiny relative window (0.01% of the parent, with a
    // small absolute floor to absorb floating-point noise) skips only the true no-intersection case
    // and keeps real small cuts — matching this function's original stated intent.
    const tolerance = Math.max(0.01, parentArea * 1e-4);
    return Math.abs(parentArea - remainderArea) <= tolerance;
}

(function registerProposalReapplyHooks() {
    if (typeof window === 'undefined') return;

    // Full reapply once on load (after parcels start arriving)
    window.addEventListener('load', () => {
        setTimeout(() => {
            if (window.ProposalManager && typeof window.ProposalManager.reapplyAppliedProposals === 'function') {
                window.ProposalManager.reapplyAppliedProposals();
            }
        }, 300);
    });
})();


// Make it accessible globally
if (typeof window !== 'undefined') {
    window.ProposalManager = ProposalManager;
}

// Also export for node, so the pure id-composition and remainder-guard helpers can be unit-tested
// without a browser (backend/test/proposal-manager-ids.test.js). Everything above is unchanged for
// the browser, which still loads this as a classic script; the load hook above already no-ops when
// `window` is absent.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        ProposalManager,
        _shouldSkipUncutRemainder
    };
}
