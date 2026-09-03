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

const proposalClaims = (typeof window !== 'undefined' && window.__claims)
    ? window.__claims
    : require('./proposals/claims.js');

const proposalMutationTransactions = (typeof window !== 'undefined' && window.ProposalMutationTransactions)
    ? window.ProposalMutationTransactions
    : require('./proposals/apply/transaction.js');

// The parcel-identity + ownership helpers moved to proposal-parcel-identity.js (a sibling classic
// script the browser loads first, so they are globals there). Under node they are module-scoped, so
// load that file to publish them onto globalThis before the ProposalManager literal below references
// them by bare name.
if (typeof module !== 'undefined' && module.exports && typeof require === 'function') {
    require('./proposal-parcel-identity.js');
}

function _normalizeProposalId(value) {
    if (value === undefined || value === null) return null;
    try {
        return String(value);
    } catch (_) {
        return null;
    }
}

function _coordinatedPlanIdOf(record) {
    if (!record || record.coordinatedPlanId === undefined || record.coordinatedPlanId === null) return '';
    return String(record.coordinatedPlanId).trim();
}

function _getProposalApplyLabel(proposalId, proposalData) {
    const title = proposalData && typeof proposalData.title === 'string'
        ? proposalData.title.trim()
        : '';
    return title || _normalizeProposalId(proposalId) || 'unknown-proposal';
}

// What KIND of thing is being applied, in one word, for the status log. A reload replays the whole
// plan, and "Applying road Ilica" says far more about what the app is busy with than a row of
// identical lines would.
const _APPLY_KIND_WORDS = {
    'road-track': 'road',
    reparcellization: 'land readjustment',
    'decide-later': 'merge',
    park: 'park',
    square: 'square',
    lake: 'lake',
    station: 'station',
    buildings: 'building',
    single: 'building',
    row: 'row houses',
    parcelBased: 'buildings',
    parcelbased: 'buildings',
    'urban-rule': 'urban rule',
    parcel: 'parcel'
};

function _proposalApplyKind(proposalData) {
    let key = '';
    try {
        key = (applyRoute && typeof applyRoute.normalizeGoalKey === 'function')
            ? applyRoute.normalizeGoalKey(proposalData && proposalData.goal)
            : String((proposalData && proposalData.goal) || '');
    } catch (_) { key = ''; }
    if (Object.prototype.hasOwnProperty.call(_APPLY_KIND_WORDS, key)) return _APPLY_KIND_WORDS[key];
    // A track is a road-track record with the flag on its definition, not a goal of its own.
    return key || 'proposal';
}

function _cadastralParcelRepository() {
    if (typeof CadastralParcelRepository !== 'undefined' && CadastralParcelRepository) {
        return CadastralParcelRepository;
    }
    const root = (typeof window !== 'undefined') ? window : globalThis;
    if (root && root.CadastralParcelRepository) return root.CadastralParcelRepository;
    if (typeof require === 'function') {
        return require('./parcels/ground-service.js').CadastralParcelRepository;
    }
    return null;
}

function _emitProposalProgress(listener, event) {
    if (typeof listener !== 'function') return;
    try { listener(Object.freeze({ ...event })); } catch (_) { /* progress is observational */ }
}

// A parcel selection is valid only while that exact parcel belongs to the live fabric. Whenever a
// parcel is hidden or removed because another formation consumed it, clear references to that id;
// otherwise a later Build click can reinterpret one dead cadastral id as unrelated live remnants.
// Proposal selection is independent and stays open.
function _clearNonLiveParcelInteractionState(parcelIds) {
    const root = (typeof window !== 'undefined') ? window : null;
    if (!root) return;
    const removed = new Set(Array.from(parcelIds || []).map(String).filter(Boolean));
    if (!removed.size) return;

    // Capture the exact live layers before their caller hides or unregisters them. Selection state
    // must be cleared before restoring style (restoreParcelLayerStyle deliberately preserves the
    // orange multi-select style while an id is still selected).
    const multi = root.multiParcelSelection;
    const layersToRestore = new Set();
    removed.forEach(id => {
        let layer = root.ParcelPresenter?.getLayer?.(id) || null;
        if (!layer && root.currentParcel?.layer && String(root.currentParcel.id || '') === id) {
            layer = root.currentParcel.layer;
        }
        if (layer) layersToRestore.add(layer);
    });

    const selectedId = root.selectedParcelId !== undefined && root.selectedParcelId !== null
        ? String(root.selectedParcelId)
        : null;
    const currentId = root.currentParcel?.id !== undefined && root.currentParcel?.id !== null
        ? String(root.currentParcel.id)
        : null;
    const selectedProposalParcel = root.selectedParcelInProposal !== undefined
        && root.selectedParcelInProposal !== null
        ? String(root.selectedParcelInProposal)
        : null;

    if (selectedProposalParcel && removed.has(selectedProposalParcel)) {
        root.selectedParcelInProposal = null;
    }

    let multiChanged = false;
    if (multi?.selectedParcels && typeof multi.selectedParcels.delete === 'function') {
        removed.forEach(id => { if (multi.selectedParcels.delete(id)) multiChanged = true; });
        if (multi.lastSelectedParcelId && removed.has(String(multi.lastSelectedParcelId))) {
            multi.lastSelectedParcelId = multi.selectedParcels.size
                ? Array.from(multi.selectedParcels).slice(-1)[0]
                : null;
        }
    }

    if ((selectedId && removed.has(selectedId)) || (currentId && removed.has(currentId))) {
        root.selectedParcelId = null;
        root.currentParcel = null;
        root.currentParcelCoordinates = null;
    }

    layersToRestore.forEach(layer => {
        try {
            if (typeof root.restoreParcelLayerStyle === 'function') root.restoreParcelLayerStyle(layer);
            else multi?.removeParcelHighlight?.(layer);
        } catch (_) { }
    });

    if ((selectedId && removed.has(selectedId)) || (currentId && removed.has(currentId))) {
        try {
            if (typeof root.hideParcelInfoPanel === 'function') root.hideParcelInfoPanel();
            else root.document?.getElementById('parcel-info-panel')?.classList.remove('visible');
        } catch (_) { }
    }
    if (multiChanged) {
        try { multi.updateUI?.(); } catch (_) { }
    }
}

// `proposalId` rides along as DATA rather than being parsed back out of the sentence later. A
// status line reads "Applied block Block 1108-0116", and recovering the proposal from that would
// mean matching titles — which are not unique, are translated, and are chosen by users.
function _announceApply(message, proposalId) {
    if (typeof updateStatus !== 'function') return;
    try { updateStatus(message, proposalId ? { proposalId } : undefined); } catch (_) { }
}

// "112 roads", "3 tracks", "112 roads and 3 tracks" — a track is a road-track record with a flag,
// not a goal of its own, so the two are counted apart only here, where the number is the message.
function _corridorCountPhrase(takes) {
    const list = Array.isArray(takes) ? takes : [];
    const tracks = list.filter(take => take && take.isTrack).length;
    const roads = list.length - tracks;
    const parts = [];
    if (roads) parts.push(`${roads} road${roads === 1 ? '' : 's'}`);
    if (tracks) parts.push(`${tracks} track${tracks === 1 ? '' : 's'}`);
    return parts.join(' and ') || '0 roads';
}

// EVERY type funnels through here — roads, readjustments, merges, buildings, structures — so this
// is the one place that can say what is happening, and it says it twice: once on the way in and once
// on the way out. Applying used to reach the status log only from the per-type tails, and the road
// path has no tail at all, so a reload replaying a hundred corridors looked like the app had simply
// stopped responding.
// A REPLAY says so. Every path through here — a fresh apply, a plan apply, and the boot replay
// re-deriving the fabric — printed the identical "Applied building X" line, so a console showing
// 299 of them said nothing about which had happened. On a plan whose members were already applied
// the replay's lines read as the plan applying, and the plan's own summary then reported skipping
// everything: two true statements that look like a contradiction.
async function _runProposalApplyWithSummary(proposalId, proposalData, runApply, options = {}) {
    const label = _getProposalApplyLabel(proposalId, proposalData);
    const kind = _proposalApplyKind(proposalData);
    // `_rebuildInProgress` is also the recursion guard used by a small, local materialization.
    // It does not by itself mean that the user is watching a boot replay. A freshly-created or
    // explicitly-applied proposal goes through that same local engine, and calling it
    // "Re-derived" made a successful create look like the old proposal had mysteriously returned.
    // The initiating operation can therefore name the user-facing verb explicitly; true plan-wide
    // replay keeps the default below.
    const replaying = options.statusMode === 'rederive'
        || (options.statusMode !== 'apply'
            && !!(ProposalManager && ProposalManager._rebuildInProgress === true));
    const verb = replaying ? 'Re-derived' : 'Applied';
    const gerund = replaying ? 'Re-deriving' : 'Applying';
    const deferPresentation = options && options.deferPresentation === true;
    // The ONE line per proposal. The per-type step traces are behind window.DEBUG_APPLY, because
    // six lines each is how you watch a single apply and how you lose a replay of three hundred.
    const startedAt = _now();
    if (!deferPresentation) _announceApply(`${gerund} ${kind} ${label}...`, proposalId);
    try {
        const result = await runApply();
        if (result === false) {
            console.warn(`${gerund} proposal ${label} ... failed`);
            if (!deferPresentation) _announceApply(`Could not apply ${kind} ${label}`, proposalId);
            return false;
        }
        console.log(`${verb} ${kind} ${label} — ${Math.round(_now() - startedAt)} ms`);
        if (!deferPresentation) _announceApply(`${verb} ${kind} ${label}`, proposalId);
        return result;
    } catch (error) {
        console.warn(`${gerund} proposal ${label} ... failed`);
        if (!deferPresentation) _announceApply(`Could not apply ${kind} ${label}`, proposalId);
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
        const mutatesMap = !options || options._mapMutation !== false;
        const store = typeof proposalStorage !== 'undefined' ? proposalStorage : null;
        const proposalSnapshot = store && store.proposals instanceof Map
            ? proposalMutationTransactions.snapshotRecordMap(store.proposals)
            : null;
        const nextProposalId = store ? store.nextProposalId : undefined;
        const browserRoot = typeof window !== 'undefined' ? window : globalThis;
        const fabric = mutatesMap ? browserRoot.LiveParcelFabric : null;
        const fabricTransaction = fabric && typeof fabric.beginTransaction === 'function'
            ? fabric.beginTransaction({ id: `proposal-${transaction.id}`, kind, proposalId })
            : null;
        const collectionSnapshot = browserRoot ? Object.fromEntries(
            ['parks', 'squares', 'lakes', 'transitStations', 'proposedBuildings']
                .filter(name => Array.isArray(browserRoot[name]))
                .map(name => [name, browserRoot[name].slice()])
        ) : null;

        let proposalBatchOpen = false;
        if (store && typeof store.beginBatch === 'function' && typeof store.endBatch === 'function') {
            store.beginBatch();
            proposalBatchOpen = true;
            // Flush the one authored-state envelope before publishing the new fabric revision.
            // A failed write therefore leaves the draft invisible; a later presenter failure is
            // compensated by the rollback journal writing the original envelope back.
            transaction.deferCommit('commit authored proposal state', () => {
                try { return store.endBatch(); }
                finally { proposalBatchOpen = false; }
            });
            transaction.deferFinally('close proposal storage batch', () => {
                if (!proposalBatchOpen) return;
                try { return store.endBatch(); }
                finally { proposalBatchOpen = false; }
            });
        }

        if (fabricTransaction) {
            transaction.deferCommit('commit live parcel fabric', () => fabric.commit(fabricTransaction));
            transaction.deferRollback('discard live parcel fabric draft', () => {
                if (fabric.currentTransaction?.() === fabricTransaction) fabric.rollback(fabricTransaction);
            });
        }

        transaction.deferRollback('restore authored proposal state', () => {
            if (store && proposalSnapshot) {
                proposalMutationTransactions.restoreRecordMap(store.proposals, proposalSnapshot);
                if (nextProposalId !== undefined) store.nextProposalId = nextProposalId;
                if (typeof store.save === 'function') store.save();
            }
            if (browserRoot && collectionSnapshot) {
                Object.entries(collectionSnapshot).forEach(([name, entries]) => {
                    browserRoot[name] = entries.slice();
                });
            }
            try {
                if (manager && typeof manager._refreshUIAfterProposalChange === 'function') {
                    manager._refreshUIAfterProposalChange(store && typeof store.getProposal === 'function'
                        ? store.getProposal(proposalId)
                        : null);
                }
            } catch (_) { /* rollback must continue */ }
        });

        return operation(transaction, {
            ...(options || {}),
            _mutationTransaction: transaction,
            ...(fabricTransaction ? { _fabricTransaction: fabricTransaction } : {})
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
function _createForeignIndexAllocator(transaction) {
    const next = new Map();
    return (cadastreId, token) => {
        const base = String(cadastreId || '').trim();
        const producerToken = String(token || '').trim();
        if (!base || !producerToken) {
            throw new Error('Foreign identity allocation requires explicit cadastral and producer provenance.');
        }
        const key = JSON.stringify([base, producerToken]);
        if (!next.has(key)) {
            let max = 0;
            const scan = feature => {
                const props = feature && feature.properties || {};
                const anchors = Array.isArray(props.cadastreParcelIds)
                    ? props.cadastreParcelIds.map(String)
                    : [];
                const index = Number(props.syntheticIndex);
                if (!anchors.includes(base) || String(props.syntheticToken || '') !== producerToken
                    || !Number.isInteger(index) || index < 1) return;
                if (index > max) max = index;
            };
            const fabric = (typeof window !== 'undefined' ? window : globalThis).LiveParcelFabric;
            if (!fabric || !transaction) {
                throw new Error('Derived parcel identity allocation requires the active live-fabric transaction.');
            }
            fabric.list({ transaction }).forEach(scan);
            next.set(key, max + 1);
        }
        const value = next.get(key);
        next.set(key, value + 1);
        return value;
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
        const declaredBaseIds = Array.isArray(props.cadastreParcelIds) ? props.cadastreParcelIds : [];
        const flatBaseIds = Array.from(new Set(declaredBaseIds.map(String).filter(Boolean)));
        if (!flatBaseIds.length) {
            const error = new Error('Cannot mint a live parcel without explicit original cadastral parcel ids.');
            error.code = 'live-parcel-provenance-missing';
            throw error;
        }
        const rootId = flatBaseIds[0];
        const rootNumber = _resolveRootParcelNumberFromProperties(props) || 'parcel';

        // Flat anchor: every minted piece records only the original cadastral parcel(s) under it.
        // Immediate live ids are useful while this apply is cutting them, but they are not durable
        // lineage and must not become the next operation's parent chain.
        props.cadastreParcelIds = flatBaseIds.slice();
        delete props.baseParcelIds;
        delete props.parentParcelIds;
        delete props.parentParcelId;
        const outputProducer = props.producedByProposalId !== undefined
            && props.producedByProposalId !== null
            ? props.producedByProposalId
            : proposalId;
        if (outputProducer !== undefined && outputProducer !== null) {
            props.producedByProposalId = String(outputProducer);
        }
        delete props.proposalId;
        delete props.ancestorProposal;

        const carried = props.__carryIdentity;
        if (carried !== undefined) delete props.__carryIdentity;
        if (carried) {
            if (!formationEdit || typeof formationEdit.applyCarriedIdentity !== 'function') {
                throw new Error('Formation identity carry-over service is unavailable.');
            }
            if (formationEdit.applyCarriedIdentity(props, carried, carriedIds)) {
                props.rootParcelId = rootId;
                props.rootParcelNumber = rootNumber;
                return;
            }
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

// Same completeness bar as finishing a corridor. Below this, even a tiny unloaded edge
// may contain a cadastral parcel that changes the cut, so replay still asks the backend.
const FLAT_GROUND_COMPLETE_COVERAGE = 0.999;

const _now = () => ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now());

// Derivations of the corridor fabric run one at a time — see _deriveCorridorFabric.
let _corridorFabricQueue = Promise.resolve();

const ProposalManager = {
    _lastApplyFailureByProposalId: new Map(),
    // Where the last rebuild's time went. A rebuild is the expensive half of finishing a road, and
    // "it takes a few seconds" is unanswerable without a breakdown — so it keeps one, always, and
    // prints a single line per rebuild rather than needing a profiler attached after the fact.
    _lastRebuildProfile: { members: 0, resetMs: 0, groundMs: 0, foldMs: 0, stripsMs: 0, passes: 0, slowest: null },
    _initialReapplyDone: false,
    _reapplyInFlight: false,
    _reapplyProgressListeners: new Set(),

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
        const selectedParcelIds = Array.from(new Set((Array.isArray(input.parentParcelIds)
            ? input.parentParcelIds.map(String).filter(Boolean)
            : [])));
        const fabric = _liveFabric();
        if (!fabric || typeof fabric.cadastreIdsForParcelIds !== 'function') {
            throw new Error('Live parcel fabric provenance is unavailable while creating the corridor.');
        }
        const cadastreParcelIds = fabric.cadastreIdsForParcelIds(selectedParcelIds);
        let definition = input.definition || {};
        try { definition = JSON.parse(JSON.stringify(definition)); } catch (_) { definition = { ...definition }; }

        const proposalData = {
            type: 'road',
            title: name,
            author: normalizedAuthor,
            description: normalizedDescription,
            proposalId: initialProposalId,
            cadastreParcelIds,
            roadProposal: {
                id: initialProposalId,
                proposalId: initialProposalId,
                definition
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

    // Finish a newly drawn corridor as one authored transaction. A T/X junction changes both the
    // new definition and the already-applied road it meets; those records, the applied-state flip,
    // persistence, and the local parcel derivation either all commit or all roll back.
    async createCorridorProposalAtomically(proposal, options = {}) {
        const opts = options || {};
        const requestedAt = _now();
        const browserRoot = (typeof window !== 'undefined') ? window : globalThis;
        const authoring = browserRoot && browserRoot.CorridorAuthoring;
        if (!proposal?.roadProposal?.definition) {
            return { ok: false, proposalId: null, reason: 'The new corridor has no authored definition.' };
        }
        if (!authoring || typeof authoring.planCorridorAuthoring !== 'function') {
            return { ok: false, proposalId: null, reason: 'The corridor topology engine is unavailable.' };
        }
        if (typeof proposalStorage === 'undefined' || typeof proposalStorage.addProposal !== 'function') {
            return { ok: false, proposalId: null, reason: 'Proposal storage is unavailable.' };
        }

        // All proposal mutations acquire these in the same order: root transaction, then fabric
        // queue. Taking the fabric queue first can deadlock against a replay that already owns the
        // transaction and is waiting to derive fabric.
        const suppliedTransaction = proposalMutationTransactions.isActiveTransaction(opts._mutationTransaction);
        if (suppliedTransaction) {
            if (opts._fabricQueue === true) {
                return this._createCorridorProposalTransactionBody(proposal, opts);
            }
            return this._enqueueFabricChange(() => this._createCorridorProposalTransactionBody(proposal, {
                ...opts,
                _fabricQueue: true
            }));
        }

        let result = null;
        try {
            result = await _runProposalMutationBoundary(
                this,
                'corridor-create',
                null,
                opts,
                (_transaction, transactionOptions) => this._enqueueFabricChange(
                    () => this._createCorridorProposalTransactionBody(proposal, {
                        ...transactionOptions,
                        _fabricQueue: true
                    })
                )
            );
        } catch (error) {
            const reason = String(error && error.message || error || 'Could not finish the corridor transaction.');
            console.warn('[createCorridorProposalAtomically] transaction rolled back', reason);
            return {
                ok: false,
                proposalId: null,
                reason
            };
        }

        if (result?.ok) {
            result.timings = {
                ...(result.timings || {}),
                totalMs: _now() - requestedAt,
                queueAndCommitMs: Math.max(0, (_now() - requestedAt) - Number(result.timings?.bodyMs || 0))
            };
            console.info(
                `[corridor-authoring] ${result.proposalId} committed in ${Math.round(result.timings.totalMs)} ms`
                + ` — topology ${Math.round(result.timings.topologyMs || 0)}`
                + ` · records ${Math.round(result.timings.recordsMs || 0)}`
                + ` · local fabric ${Math.round(result.timings.fabricMs || 0)}`
                + ` · queue/commit ${Math.round(result.timings.queueAndCommitMs || 0)}`
                + ` · ${result.topology.changedProposalIds.length} existing corridor record(s) changed`
            );
            try {
                if (typeof document !== 'undefined' && typeof CustomEvent === 'function') {
                    document.dispatchEvent(new CustomEvent('proposalCreated', {
                        detail: { proposalId: result.proposalId }
                    }));
                }
            } catch (_) { }
            result.topology.changedProposalIds.forEach(id => {
                try { this._refreshUIAfterProposalChange?.(_getProposalRecord(id)); } catch (_) { }
            });
            try { this._refreshUIAfterProposalChange?.(_getProposalRecord(result.proposalId)); } catch (_) { }
            try { browserRoot.refreshRoadNodeHandles?.(); } catch (_) { }
            if (result.supersession && typeof showEphemeralMessage === 'function') {
                showEphemeralMessage(
                    `Applied the replacement and removed “${result.supersession.sourceName}” from the map.`,
                    5000,
                    'success'
                );
            }
        }
        return result;
    },

    async _createCorridorProposalTransactionBody(proposal, options = {}) {
        const startedAt = _now();
        const fail = message => {
            const error = new Error(String(message || 'Could not finish the corridor transaction.'));
            error.code = 'corridor-authoring-failed';
            throw error;
        };
        const browserRoot = (typeof window !== 'undefined') ? window : globalThis;
        const authoring = browserRoot.CorridorAuthoring;
        const excludedIds = Array.from(new Set(
            [proposal.sourceProposalId, proposal.replacementOfProposalId]
                .filter(value => value !== undefined && value !== null && String(value))
                .map(String)
        ));
        const allRecords = typeof proposalStorage.getAllProposals === 'function'
            ? proposalStorage.getAllProposals()
            : Array.from(proposalStorage.proposals?.values?.() || []);

        _announceApply('Planning the new corridor junctions…');
        const topologyStarted = _now();
        let plan = null;
        try {
            plan = authoring.planCorridorAuthoring(proposal, allRecords, {
                geometry: browserRoot.CorridorGeometry,
                centerlineOf: browserRoot.corridorCenterlineOf,
                isTrack: browserRoot.corridorIsTrack,
                isApplied: appliedOf,
                protectedEdgeKeysOf: definition => (
                    typeof browserRoot.corridorProtectedEdgeKeySet === 'function'
                        ? browserRoot.corridorProtectedEdgeKeySet(
                            definition?.tunnels,
                            definition?.gradeSeparations
                        )
                        : null
                ),
                excludeProposalIds: excludedIds
            });
        } catch (error) {
            fail(error && error.message || error || 'Could not build corridor topology.');
        }
        const topologyMs = _now() - topologyStarted;
        const topologyCount = plan.existingChanges.length;
        _announceApply(topologyCount
            ? `Saving the new corridor and ${topologyCount} connected corridor${topologyCount === 1 ? '' : 's'}…`
            : 'Saving the new corridor…');

        const recordsStarted = _now();
        const changedRecords = [];
        const changedAt = new Date().toISOString();
        for (const change of plan.existingChanges) {
            const target = _getProposalRecord(change.proposalId);
            if (!target?.roadProposal?.definition) {
                fail(`A road needed by this junction disappeared (${change.proposalId}).`);
            }
            authoring.writeDefinition(target, change.definition);
            authoring.detachPublishedIdentity(target);
            target.updatedAt = changedAt;
            proposalStorage._indexProposal?.(target);
            changedRecords.push(target);
        }

        const proposalId = proposalStorage.addProposal(plan.proposal, { emitEvent: false });
        if (!proposalId) fail('Could not save the new corridor.');
        const stored = _getProposalRecord(proposalId);
        if (!stored) fail('The new corridor was not available after it was saved.');

        // A replacement and the source it parks belong to this same transaction. Use the
        // state-only primitive here; its success toast is emitted only after commit above.
        const supersededRecords = excludedIds
            .map(id => _getProposalRecord(id))
            .filter(Boolean);
        const supersession = (typeof commitReplacementSupersession === 'function')
            ? commitReplacementSupersession(stored, proposalId, id => _getProposalRecord(id))
            : null;

        try { setProposalApplied(stored, true); } catch (_) { stored.applied = true; }
        proposalStorage._indexProposal?.(stored);
        const recordsMs = _now() - recordsStarted;

        const label = stored.title || stored.name || (plan.isTrack ? 'the new track' : 'the new road');
        _announceApply(`Checking cadastral ground for ${label}…`, proposalId);
        const announceFabricProgress = event => {
            try { options.onProgress?.(event); } catch (_) { }
            const phase = event && event.phase;
            if (phase === 'ground-load-ids' || phase === 'ground-load-footprints') {
                _announceApply(`Loading missing cadastral ground for ${label}…`, proposalId);
            } else if (phase === 'ground-wait-ids' || phase === 'ground-wait-footprints') {
                _announceApply(`Waiting for cadastral ground already being loaded for ${label}…`, proposalId);
            } else if (phase === 'ground-ready' || phase === 'ground-ids-ready') {
                _announceApply(`Cadastral ground ready for ${label}…`, proposalId);
            } else if (phase === 'fabric-scope-ready') {
                const parcels = Number(event.parcels) || 0;
                _announceApply(`Preparing ${parcels} cadastral parcel${parcels === 1 ? '' : 's'} under ${label}…`, proposalId);
            } else if (phase === 'fabric-arrange') {
                const done = Number(event.done) || 0;
                const total = Number(event.total) || 0;
                _announceApply(total
                    ? `Cutting cadastral parcels for ${label}: ${done}/${total}…`
                    : `Cutting cadastral parcels for ${label}…`, proposalId);
            } else if (phase === 'map-update') {
                _announceApply(`Updating the map for ${label}…`, proposalId);
            } else if (phase === 'proposal-apply') {
                _announceApply(`Restoring affected proposal ${event.done || 0}/${event.total || 0}: ${event.label || ''}…`, proposalId);
            } else if (phase === 'fabric-ready') {
                _announceApply(`Cadastral parcel borders ready for ${label}…`, proposalId);
            }
        };
        const fabricStarted = _now();
        const derived = await this.rematerializeCorridorScope(
            [stored, ...supersededRecords],
            {
                _fabricQueue: true,
                _mutationTransaction: options._mutationTransaction,
                deferSave: true,
                purpose: 'apply',
                statusMode: 'apply',
                onProgress: announceFabricProgress
            }
        );
        const fabricMs = _now() - fabricStarted;
        if (!derived || derived.ok !== true) {
            fail((derived?.failed?.[0]?.reason) || 'The corridor ground could not be derived locally.');
        }

        _announceApply(`Saving the completed corridor ${label}…`, proposalId);
        proposalStorage.save?.();
        this._clearLastApplyFailure?.(proposalId);
        return {
            ok: true,
            proposalId: String(proposalId),
            applied: true,
            topology: {
                junctionRecords: plan.junctionRecords,
                changedProposalIds: changedRecords.map(record => String(record.proposalId))
            },
            supersession: supersession ? {
                sourceId: supersession.sourceId,
                sourceName: supersession.source?.title
                    || supersession.source?.name
                    || supersession.sourceId
            } : null,
            timings: {
                topologyMs,
                recordsMs,
                fabricMs,
                bodyMs: _now() - startedAt
            }
        };
    },

    reapplyAppliedProposals(options = {}) {
        if (this._initialReapplyDone) {
            return this._initialReapplyPromise || Promise.resolve(this._initialReapplyResult);
        }
        if (!(this._reapplyProgressListeners instanceof Set)) this._reapplyProgressListeners = new Set();
        if (typeof options.onProgress === 'function') this._reapplyProgressListeners.add(options.onProgress);
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
                        const ids = proposalClaims.cadastreParcelIdsOf(p);
                        if (!ids.length) return true;
                        return ids.some(id => isInCity(id, currentCityId));
                    })
                    : applied;

                if (!appliedInCity.length) return undefined;

                // Boot/recovery deliberately uses a complete cadastre-first ordered replay. Local
                // apply/edit/unapply mutations use their own original cadastral anchors instead.
                // The former stored-order `_reapplyAppliedProposal` loop was a second
                // implementation with different precedence and restore semantics; whichever happened
                // to run first could establish a different fabric. Non-conforming stored records are
                // handled by the explicit migration script, never by a live healing pass here.
                const result = await this.rebuildAppliedFabric({
                    silent: true,
                    onProgress: event => {
                        this._reapplyProgressListeners.forEach(listener => _emitProposalProgress(listener, event));
                    }
                });
                this._initialReapplyResult = result;
                return result;
            } finally {
                this._reapplyInFlight = false;
                this._initialReapplyDone = true;
                this._reapplyProgressListeners.clear();
            }
        })();
        this._initialReapplyPromise = replayPromise;
        return replayPromise;
    },

    // Canonical boot/recovery derivation: cadastre first (the physical ground fact), then every
    // standing formation in order, each cutting what stands. Ordinary mutations do not call this;
    // they rederive only their flat cadastral anchors. Nothing is ever "restored" from a historical
    // parent — a cadastral parcel
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
        if (!proposalMutationTransactions.isActiveTransaction(opts._mutationTransaction)) {
            return _runProposalMutationBoundary(this, 'rebuild-applied-fabric', null, opts,
                async (_transaction, transactionOptions) => {
                    const result = await this.rebuildAppliedFabric({
                        ...transactionOptions,
                        _fabricQueue: true
                    });
                    // A boot replay is one materialization of one applied-set snapshot. A member
                    // failure rolls the entire draft back; it may never commit an `applied=true`
                    // record without its live output.
                    if (!result || result.ok !== true) {
                        this._lastFailedRebuildSummary = result || null;
                        return false;
                    }
                    return result;
                });
        }
        if (this._rebuildInProgress) {
            console.warn('[rebuildAppliedFabric] re-entered — skipped');
            return { ok: false, reentered: true };
        }
        this._rebuildInProgress = true;
        // A whole-plan derivation is the longest thing this app does — several seconds of ground
        // fetching before the first proposal can even be applied. The status LINES describe it, but
        // each is superseded within a second; the spinner is the part that stays on screen for as
        // long as the work does.
        const spinnerHeld = (typeof window !== 'undefined' && typeof window.beginStatusActivity === 'function')
            ? window.beginStatusActivity()
            : null;
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
                const ids = proposalClaims.cadastreParcelIdsOf(p);
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

            // Boot/recovery is a materialization of ONE immutable applied-set snapshot. It must not
            // discover a second record-state policy while rebuilding the map: explicit apply/edit
            // transactions are the only writers of `applied`. The old corridor sweep parked records
            // merely because a road divided their cadastral anchor, even when the canonical live-
            // ground resolver could place them. That changed 298 -> 296 mid-pass, forced a complete
            // second replay, and the shared-route loader then applied the same two records again.
            const standing = appliedNow();
            let summary = { ok: true, applied: 0, failed: [] };
            const runReplay = async () => {
                summary = await this._rebuildPass(standing, {
                    ...opts,
                    preserveAppliedSet: true,
                    _mutationTransaction: opts._mutationTransaction,
                    _fabricTransaction: opts._fabricTransaction
                });
            };
            // One redraw of the proposed buildings and each structure layer for the whole replay
            // instead of one per member. Surveyed-building outcomes are updated separately and
            // locally by changed building id; they are never rebuilt as a side effect of this.
            const holdBuildings = (typeof window !== 'undefined')
                ? window.withProposedBuildingsRefreshHeld
                : null;
            const holdStructures = (typeof window !== 'undefined')
                ? window.withStructureLayersRefreshHeld
                : null;
            const runWithStructuresHeld = () => (typeof holdStructures === 'function')
                ? holdStructures(runReplay)
                : runReplay();
            if (typeof holdBuildings === 'function') await holdBuildings(runWithStructuresHeld);
            else await runWithStructuresHeld();

            const stripsStarted = _now();
            _emitProposalProgress(opts.onProgress, { phase: 'corridor-strips' });
            try { if (typeof refreshAppliedCorridorStrips === 'function') refreshAppliedCorridorStrips(); } catch (_) { }
            try { if (typeof syncProposalsIndicator === 'function') syncProposalsIndicator(); } catch (_) { }
            // Built by _rebuildPass; defaulted here so a caller that supplies its own pass (tests
            // do) is not broken by the reporting.
            const profile = this._lastRebuildProfile || { members: 0, resetMs: 0, groundMs: 0, foldMs: 0, failed: 0, slowest: null };
            profile.stripsMs = _now() - stripsStarted;
            profile.passes = 1;
            this._lastRebuildProfile = profile;
            try {
                const p = profile;
                const total = p.resetMs + p.groundMs + p.foldMs + p.stripsMs;
                const worst = p.slowest ? `, slowest member ${Math.round(p.slowest.ms)} ms (${p.slowest.key})` : '';
                const cut = p.fabric
                    ? ` · fabric ${p.fabric.parcels} parcel(s): +${p.fabric.added} −${p.fabric.removed} =${p.fabric.unchanged}`
                    : '';
                console.info(`[rebuildAppliedFabric] ${p.members} member(s), ${p.corridors || 0} corridor(s) in ${Math.round(total)} ms`
                    + ` — reset ${Math.round(p.resetMs)} · ground ${Math.round(p.groundMs)}`
                    + ` · replay ${Math.round(p.foldMs)}`
                    + ` · strips ${Math.round(p.stripsMs)}${cut}${worst}`
                    + `${p.passes > 1 ? ` · ${p.passes} passes` : ''}${p.failed ? ` · ${p.failed} set aside` : ''}`);
            } catch (_) { }
            _emitProposalProgress(opts.onProgress, {
                phase: 'rebuild-ready',
                members: profile.members,
                corridors: profile.corridors || 0,
                failed: profile.failed || 0,
                elapsed: profile.resetMs + profile.groundMs + profile.foldMs + profile.stripsMs
            });
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
            if (hasStorageBatch) proposalStorage.endBatch();
            // In `finally`, so a derivation that throws does not leave the bar spinning for ever.
            try { if (typeof spinnerHeld === 'function') spinnerHeld(); } catch (_) { }
        }
    },

    _orderedStandingProposals() {
        if (typeof proposalStorage === 'undefined' || typeof proposalStorage.getAllProposals !== 'function') return [];
        const currentCityId = (typeof window !== 'undefined' && window.CityConfigManager
                && typeof window.CityConfigManager.getCurrentCityId === 'function')
            ? window.CityConfigManager.getCurrentCityId()
            : null;
        const records = proposalStorage.getAllProposals().filter(record => {
            if (!record || !isProposalCurrentlyApplied(record)) return false;
            if (!currentCityId || typeof isInCity !== 'function') return true;
            const ids = proposalClaims.cadastreParcelIdsOf(record);
            return !ids.length || ids.some(id => isInCity(id, currentCityId));
        });
        const order = (typeof window !== 'undefined') ? window.__planOrder : null;
        if (order && typeof order.orderFormations === 'function') return order.orderFormations(records);
        return records.sort((left, right) => {
            const lt = Date.parse(left.createdAt) || 0;
            const rt = Date.parse(right.createdAt) || 0;
            return lt - rt || String(left.proposalId || '').localeCompare(String(right.proposalId || ''));
        });
    },

    // Validate the ONE durable land relationship a proposal record may carry. The declaration is
    // immutable authored intent: apply/replay may verify that its own cadastral parcels cover the
    // footprint, but may never discover a different relationship from whatever else is loaded.
    _resolveAndStampFlatCadastreAnchors(record) {
        if (!record || typeof record !== 'object') return { cadastreParcelIds: [], complete: true };
        const browserRoot = typeof window !== 'undefined' ? window : globalThis;
        const repository = _cadastralParcelRepository();
        const order = browserRoot.__planOrder;
        const declared = proposalClaims.cadastreParcelIdsOf(record);
        let footprint = null;
        try {
            footprint = order && typeof order.footprintOf === 'function'
                ? order.footprintOf(record)
                : null;
        } catch (_) { footprint = null; }

        let complete = true;
        if (footprint && footprint.geometry) {
            let resolved = null;
            try {
                resolved = repository && typeof repository.coverageOf === 'function'
                    ? repository.coverageOf(footprint, { ids: declared })
                    : null;
            } catch (_) { resolved = null; }
            const coverage = Number(resolved && resolved.coverage) || 0;
            complete = declared.length > 0 && coverage > FLAT_GROUND_COMPLETE_COVERAGE;
        }

        const flat = Array.from(new Set((declared || []).map(String).filter(Boolean)));
        return { cadastreParcelIds: flat, complete };
    },

    async _flatScopeSeeds(records, extraCadastreParcelIds = [], options = {}) {
        const members = (Array.isArray(records) ? records : []).filter(Boolean);
        if (members.length) {
            const groundOptions = {};
            if (typeof options.onProgress === 'function') groundOptions.onProgress = options.onProgress;
            if (options.purpose && options.purpose !== 'application') groundOptions.purpose = options.purpose;
            if (options._fabricTransaction) groundOptions._fabricTransaction = options._fabricTransaction;
            await this._loadReplayGround(members, groundOptions);
        }
        const ids = new Set(proposalClaims.cadastreParcelIdsOf({ cadastreParcelIds: extraCadastreParcelIds }));
        let complete = true;

        members.forEach(record => {
            const resolution = this._resolveAndStampFlatCadastreAnchors(record);
            resolution.cadastreParcelIds.forEach(id => ids.add(id));
            if (!resolution.complete) complete = false;
        });
        return { cadastreParcelIds: Array.from(ids), complete };
    },

    // State removal never rediscovers a proposal's land relationship from today's map geometry.
    // The immutable record already carries that relationship as flat original-cadastre ids; those
    // ids are the complete mutation scope even when their layers are currently hidden or have not
    // been materialized. Geometry coverage remains an apply/edit validation concern in _flatScopeSeeds.
    _recordedCadastreScope(records, extraCadastreParcelIds = []) {
        const ids = new Set(proposalClaims.cadastreParcelIdsOf({ cadastreParcelIds: extraCadastreParcelIds }));
        (Array.isArray(records) ? records : []).filter(Boolean).forEach(record => {
            proposalClaims.cadastreParcelIdsOf(record).forEach(id => ids.add(String(id)));
        });
        return { cadastreParcelIds: Array.from(ids), complete: true };
    },

    // Minimal deterministic dependency closure. Formations interact only when their explicit,
    // original cadastral anchors overlap. If one formation spans additional anchors, those anchors
    // join the scope and may bring in another standing formation; roads never expand the closure —
    // they are simply recomputed as geometric takes over the final local set.
    _localFormationClosure(seedRecords, initialCadastreParcelIds = []) {
        const seeds = (Array.isArray(seedRecords) ? seedRecords : [seedRecords]).filter(Boolean);
        const seedIds = new Set(seeds.map(record => String(record?.proposalId || '')).filter(Boolean));
        const cadastreIds = new Set(Array.from(initialCadastreParcelIds || []).map(String).filter(Boolean));
        seeds.forEach(record => proposalClaims.cadastreParcelIdsOf(record).forEach(id => cadastreIds.add(String(id))));

        const candidates = (typeof proposalStorage !== 'undefined' && proposalStorage?.getAllProposals)
            ? proposalStorage.getAllProposals().filter(record => {
                if (!record) return false;
                const goalKey = applyRoute?.normalizeGoalKey?.(record.goal) || String(record.goal || '');
                return goalKey !== 'road-track' && (appliedOf(record) || seedIds.has(String(record.proposalId || '')));
            })
            : seeds.slice();
        const included = new Map();
        let changed = true;
        while (changed) {
            changed = false;
            candidates.forEach(record => {
                const id = String(record?.proposalId || '');
                if (!id || included.has(id)) return;
                const anchors = proposalClaims.cadastreParcelIdsOf(record).map(String);
                if (!seedIds.has(id) && !anchors.some(anchor => cadastreIds.has(anchor))) return;
                included.set(id, record);
                anchors.forEach(anchor => {
                    if (!cadastreIds.has(anchor)) {
                        cadastreIds.add(anchor);
                        changed = true;
                    }
                });
            });
        }
        seeds.forEach(record => {
            const id = String(record?.proposalId || '');
            if (id && !id.startsWith('old-footprint-') && !included.has(id)) included.set(id, record);
        });
        return { records: Array.from(included.values()), cadastreParcelIds: Array.from(cadastreIds) };
    },

    // A corridor's land relationship is the same immutable, flat declaration as every other
    // proposal. Its ribbon may legitimately cross a cadastral gap, but that does not authorize the
    // runtime to scan today's repository and silently acquire more parcels. Publication/import owns
    // discovery; application merely provisions and materializes the declared cadastral ids.
    async _corridorScopeSeeds(records, extraCadastreParcelIds = [], options = {}) {
        const members = (Array.isArray(records) ? records : []).filter(Boolean);
        if (members.length) {
            const groundOptions = {};
            if (typeof options.onProgress === 'function') groundOptions.onProgress = options.onProgress;
            if (options.purpose && options.purpose !== 'application') groundOptions.purpose = options.purpose;
            if (options._fabricTransaction) groundOptions._fabricTransaction = options._fabricTransaction;
            await this._loadReplayGround(members, groundOptions);
        }
        const ids = new Set(proposalClaims.cadastreParcelIdsOf({ cadastreParcelIds: extraCadastreParcelIds }));
        members.forEach(record => {
            proposalClaims.cadastreParcelIdsOf(record).forEach(id => ids.add(String(id)));
        });

        return { cadastreParcelIds: Array.from(ids), complete: true };
    },

    // Corridor mutations share the resolved-scope materializer (owned-output removal,
    // per-cadastral-parcel arrangement, rollback), but use corridor scope semantics above instead
    // of the strict host-ground proof required by buildings and structures.
    async rematerializeCorridorScope(seedRecords, options = {}) {
        const opts = options || {};
        if (opts._fabricQueue !== true) {
            return this._enqueueFabricChange(() => this.rematerializeCorridorScope(seedRecords, {
                ...opts,
                _fabricQueue: true
            }));
        }
        if (!proposalMutationTransactions.isActiveTransaction(opts._mutationTransaction)) {
            const first = (Array.isArray(seedRecords) ? seedRecords : [seedRecords]).find(Boolean);
            return _runProposalMutationBoundary(this, 'rematerialize-corridor', first?.proposalId, opts,
                (_transaction, transactionOptions) => this.rematerializeCorridorScope(seedRecords, {
                    ...transactionOptions,
                    _fabricQueue: true
                }));
        }
        if (this._rebuildInProgress) {
            return { ok: false, reentered: true, failed: [] };
        }
        const seeds = (Array.isArray(seedRecords) ? seedRecords : [seedRecords]).filter(Boolean);
        const seedResolution = await this._corridorScopeSeeds(seeds, opts.extraCadastreParcelIds || [], opts);
        return this._rematerializeResolvedScope(seeds, seedResolution, opts);
    },

    // Re-materialise only the authored non-corridor records named by this mutation, over only the
    // original cadastral parcels under their old/new footprints.
    //
    // A cadastral id is an anchor, never a dependency edge. A track sharing one parcel with a park
    // is consulted as a take on that parcel but does not bring the other 660 parcels along. Corridor
    // mutations enter through rematerializeCorridorScope because uncovered ribbon is valid; this
    // strict path refuses a building/structure whose complete host ground cannot be proved.
    async rematerializeFlatScope(seedRecords, options = {}) {
        const opts = options || {};
        if (opts._fabricQueue !== true) {
            return this._enqueueFabricChange(() => this.rematerializeFlatScope(seedRecords, {
                ...opts,
                _fabricQueue: true
            }));
        }
        if (!proposalMutationTransactions.isActiveTransaction(opts._mutationTransaction)) {
            const first = (Array.isArray(seedRecords) ? seedRecords : [seedRecords]).find(Boolean);
            return _runProposalMutationBoundary(this, 'rematerialize-formation', first?.proposalId, opts,
                (_transaction, transactionOptions) => this.rematerializeFlatScope(seedRecords, {
                    ...transactionOptions,
                    _fabricQueue: true
                }));
        }
        if (this._rebuildInProgress) {
            return { ok: false, reentered: true, failed: [] };
        }

        const seeds = (Array.isArray(seedRecords) ? seedRecords : [seedRecords]).filter(Boolean);
        const seedResolution = await this._flatScopeSeeds(seeds, opts.extraCadastreParcelIds || [], opts);
        if (!seedResolution.complete) {
            console.warn('[flat-rematerialize] incomplete local cadastral coverage — mutation refused');
            return {
                ok: false,
                applied: 0,
                failed: [{ reason: 'cadastral ground is incomplete' }],
                cadastreParcelIds: seedResolution.cadastreParcelIds,
                proposalIds: []
            };
        }
        return this._rematerializeResolvedScope(seeds, seedResolution, opts);
    },

    // Execute a local mutation after its domain-specific scope resolver has answered. Keeping the
    // resolver outside this method makes the distinction structural: formations prove complete
    // host ground; corridors accept uncovered ribbon but still name an immutable published scope.
    async _rematerializeResolvedScope(seeds, seedResolution, options = {}) {
        const opts = options || {};
        if (!proposalMutationTransactions.isActiveTransaction(opts._mutationTransaction)
            || !opts._fabricTransaction) {
            throw new Error('Local parcel materialization requires the active proposal and live-fabric transaction.');
        }
        if (!seedResolution.cadastreParcelIds.length) {
            return { ok: true, applied: 0, failed: [], cadastreParcelIds: [], proposalIds: [] };
        }

        this._rebuildInProgress = true;
        try {
            const closure = this._localFormationClosure(seeds, seedResolution.cadastreParcelIds);
            const cadastreParcelIds = closure.cadastreParcelIds;
            _emitProposalProgress(opts.onProgress, {
                phase: 'fabric-scope-ready',
                parcels: cadastreParcelIds.length,
                members: closure.records.length
            });
            const seedById = new Map();
            seeds.forEach(seed => {
                const id = seed && seed.proposalId;
                if (id === undefined || id === null || !String(id)) return;
                const key = String(id);
                const live = _getProposalRecord(key);
                // Geometry-only old-footprint seeds are not authored records and own no output.
                if (!live && key.startsWith('old-footprint-')) return;
                if (!seedById.has(key)) seedById.set(key, live || seed);
            });
            closure.records.forEach(record => {
                const id = String(record?.proposalId || '');
                if (id && !seedById.has(id)) seedById.set(id, record);
            });

            const replay = [];
            const replayStamps = new Map();
            seedById.forEach((record, id) => {
                const live = _getProposalRecord(id) || record;
                const goalKey = (applyRoute && typeof applyRoute.normalizeGoalKey === 'function')
                    ? applyRoute.normalizeGoalKey(live.goal)
                    : String(live.goal || '');
                if (!appliedOf(live) || goalKey === 'road-track') return;
                replayStamps.set(id, {
                    hadAppliedAt: Object.prototype.hasOwnProperty.call(live, 'appliedAt'),
                    appliedAt: live.appliedAt,
                    hadUpdatedAt: Object.prototype.hasOwnProperty.call(live, 'updatedAt'),
                    updatedAt: live.updatedAt
                });
                replay.push(live);
            });
            const order = (typeof window !== 'undefined') ? window.__planOrder : null;
            const orderedReplay = order && typeof order.orderFormations === 'function'
                ? order.orderFormations(replay)
                : replay;

            const removedOutputs = [];
            seedById.forEach(record => removedOutputs.push(this._removeProposalOwnedOutput(record, {
                _fabricTransaction: opts._fabricTransaction
            })));

            const fabric = await this._deriveCorridorFabric({
                parcelIds: cadastreParcelIds,
                takes: this._appliedCorridorTakes(),
                onProgress: opts.onProgress,
                _fabricTransaction: opts._fabricTransaction
            });
            const failed = [];
            if (fabric && Array.isArray(fabric.failed)) {
                fabric.failed.forEach(entry => failed.push({
                    proposalId: null,
                    title: entry.parcelId || 'Cadastral parcel',
                    reason: entry.error || 'corridor arrangement failed'
                }));
            }

            let appliedCount = 0;
            if (!failed.length) {
                for (let replayIndex = 0; replayIndex < orderedReplay.length; replayIndex += 1) {
                    const record = orderedReplay[replayIndex];
                    const id = String(record.proposalId || '');
                    _emitProposalProgress(opts.onProgress, {
                        phase: 'proposal-apply',
                        label: _getProposalApplyLabel(id, record),
                        done: replayIndex + 1,
                        total: orderedReplay.length
                    });
                    let stood = false;
                    try {
                        const replayOptions = {
                            replay: true,
                            forceMaterialize: true,
                            deferPresentation: opts.silent === true,
                            _mutationTransaction: opts._mutationTransaction,
                            _fabricTransaction: opts._fabricTransaction
                        };
                        if (opts.statusMode === 'apply' || opts.statusMode === 'rederive') {
                            replayOptions.statusMode = opts.statusMode;
                        }
                        stood = await this.applyProposal(id, replayOptions);
                    } catch (error) {
                        failed.push({
                            proposalId: id,
                            title: record.title || record.name || id,
                            reason: String(error && error.message || error)
                        });
                    }
                    if (!stood) {
                        if (!failed.some(entry => String(entry.proposalId || '') === id)) {
                            const failure = this.getLastApplyFailure?.(id);
                            failed.push({
                                proposalId: id,
                                title: record.title || record.name || id,
                                reason: failure?.message || 'proposal could not be materialized locally'
                            });
                        }
                        continue;
                    }
                    const stamp = replayStamps.get(id);
                    if (stamp) {
                        if (stamp.hadAppliedAt) record.appliedAt = stamp.appliedAt;
                        else delete record.appliedAt;
                        if (stamp.hadUpdatedAt) record.updatedAt = stamp.updatedAt;
                        else delete record.updatedAt;
                    }
                    appliedCount += 1;
                }
            }

            if (!failed.length) {
                const publishPresentation = () => {
                    removedOutputs.forEach(output => {
                        this._commitRemovedProposalOutput(output);
                        _clearNonLiveParcelInteractionState(output.removedParcelIds || []);
                    });
                    try { if (typeof scheduleCorridorStripRefresh === 'function') scheduleCorridorStripRefresh(); } catch (_) { }
                    try { if (typeof syncProposalsIndicator === 'function') syncProposalsIndicator(); } catch (_) { }
                };
                if (proposalMutationTransactions.isActiveTransaction(opts._mutationTransaction)) {
                    opts._mutationTransaction.deferCommit('publish local parcel presentation', publishPresentation);
                } else {
                    publishPresentation();
                }
            }
            if (opts.deferSave !== true) {
                _emitProposalProgress(opts.onProgress, { phase: 'save' });
                try { if (typeof proposalStorage !== 'undefined' && proposalStorage.save) proposalStorage.save(); } catch (_) { }
            }
            return {
                ok: failed.length === 0,
                applied: appliedCount,
                failed,
                fabric,
                cadastreParcelIds,
                proposalIds: orderedReplay.map(record => String(record.proposalId))
            };
        } finally {
            this._rebuildInProgress = false;
        }
    },

    // Fetching cadastral ground and demolition buildings are independent reads, so the latter runs
    // alongside CadastralParcelRepository. The repository is the only owner of ground cache/transport
    // policy; this prefetch deals solely in building features that may need to be removed.
    // One request for every scanning member's demolition ground. Runs CONCURRENTLY with the
    // ground load — both are independent reads over the same member list — so its latency
    // usually disappears behind cadastral-ground preparation.
    //
    // Failure here is never an answer: on any error, unsupported city, or truncation the map keeps
    // only the keys a good response covered, and uncovered members fall back to their own
    // per-region fetch. The one outcome this must never produce is an empty list standing in for
    // "could not ask" — that is how a proposal gets stored as demolishing nothing.
    async _prefetchDemolitionBuildings(appliedList, options = {}) {
        const prefetched = new Map();
        const profile = { regions: 0, requests: 0, coveredRegions: 0, fallbackRegions: 0, elapsed: 0 };
        const started = _now();
        const prefetchApi = (typeof window !== 'undefined') ? window.__demolitionPrefetch : null;
        if (!prefetchApi || typeof fetch !== 'function') {
            this._lastDemolitionPrefetchProfile = { ...profile, elapsed: _now() - started };
            return prefetched;
        }
        const regions = prefetchApi.collectDemolitionRegions(appliedList, {
            structureGeometry: (proposal) => {
                const sp = proposal.structureProposal || {};
                if (sp.geometry && sp.geometry.type && Array.isArray(sp.geometry.coordinates)) return sp.geometry;
                try {
                    const kind = (sp.kind === 'park' || sp.kind === 'square' || sp.kind === 'lake' || sp.kind === 'station') ? sp.kind : 'square';
                    return typeof this._getCanonicalStructureGeometry === 'function'
                        ? this._getCanonicalStructureGeometry(proposal, kind)
                        : null;
                } catch (_) { return null; }
            }
        });
        profile.regions = regions.length;
        if (!regions.length) {
            this._lastDemolitionPrefetchProfile = { ...profile, elapsed: _now() - started };
            return prefetched;
        }

        const backendBase = (() => {
            try {
                if (typeof getBackendBase === 'function') {
                    const base = getBackendBase();
                    if (base && typeof base === 'string') return base.replace(/\/$/, '');
                }
            } catch (_) { }
            return 'https://api.urbangametheory.xyz';
        })();
        const city = (typeof CityConfigManager !== 'undefined' && CityConfigManager.getCurrentCityId)
            ? CityConfigManager.getCurrentCityId() : undefined;

        // Chunked to stay under the endpoint's 400-region cap; each chunk's answer stands alone.
        const PREFETCH_CHUNK = 200;
        const batchCount = Math.ceil(regions.length / PREFETCH_CHUNK);
        _emitProposalProgress(options.onProgress, {
            phase: 'building-ground-load',
            regions: regions.length,
            batches: batchCount
        });
        for (let index = 0; index < regions.length; index += PREFETCH_CHUNK) {
            const chunk = regions.slice(index, index + PREFETCH_CHUNK);
            try {
                profile.requests += 1;
                const response = await fetch(`${backendBase}/buildings/under`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                    body: JSON.stringify({ regions: chunk, city })
                });
                if (!response.ok) { console.warn('[replay] bulk building fetch HTTP', response.status); continue; }
                const payload = await response.json();
                if (!payload || payload.supported === false || payload.truncated === true) {
                    if (payload && payload.truncated) console.warn('[replay] bulk building fetch truncated — falling back per proposal');
                    continue;
                }
                const mapped = prefetchApi.buildingFeaturesFromBulk(payload.regions, payload.source);
                mapped.forEach((features, key) => prefetched.set(key, features));
            } catch (error) {
                console.warn('[replay] bulk building fetch failed — members fall back to their own', error);
            }
            _emitProposalProgress(options.onProgress, {
                phase: 'building-ground-progress',
                done: Math.floor(index / PREFETCH_CHUNK) + 1,
                total: batchCount,
                regions: regions.length,
                covered: prefetched.size
            });
        }
        profile.coveredRegions = prefetched.size;
        profile.fallbackRegions = Math.max(0, regions.length - prefetched.size);
        profile.elapsed = _now() - started;
        this._lastDemolitionPrefetchProfile = profile;
        _emitProposalProgress(options.onProgress, {
            phase: 'building-ground-ready',
            regions: regions.length,
            covered: profile.coveredRegions,
            fallback: profile.fallbackRegions
        });
        return prefetched;
    },

    async _loadReplayGround(appliedList, options = {}) {
        const members = (Array.isArray(appliedList) ? appliedList : []).filter(Boolean);
        if (!members.length) return 0;
        const purpose = String(options.purpose || 'application');
        const service = _cadastralParcelRepository();
        if (!service || typeof service.ensureProposalGround !== 'function') {
            throw new Error('Cadastral ground service is unavailable.');
        }

        const profile = await service.ensureProposalGround(members, {
            purpose,
            onProgress: options.onProgress,
            transaction: options._fabricTransaction || undefined
        });
        if (Array.isArray(profile?.missingIds) && profile.missingIds.length) {
            const error = new Error(`Cadastral ground is absent for: ${profile.missingIds.join(', ')}`);
            error.code = 'cadastral-ground-absent';
            error.parcelIds = profile.missingIds.slice();
            throw error;
        }
        const elapsed = Number(profile && profile.elapsed) || 0;
        this._lastReplayGroundProfile = profile;
        try {
            console.info(`[cadastralGround:${purpose}] ${members.length} member(s) in ${Math.round(elapsed)} ms`
                + ` — ${Number(profile.cachedMembers) || 0} cached member(s),`
                + ` ${Number(profile.loadedMembers) || 0} loaded member(s),`
                + ` ${Number(profile.idRequests) || 0} id request(s),`
                + ` ${Number(profile.footprintRequests) || 0} footprint request(s),`
                + ` ${Number(profile.parcels) || 0} parcel(s)`
                + (profile.missingIds?.length ? ` · ${profile.missingIds.length} declared id(s) absent` : '')
                + (profile.failed ? ` · ${profile.failed} failed` : ''));
        } catch (_) { }
        _announceApply(`Cadastral ground ready for ${members.length} proposal${members.length === 1 ? '' : 's'}`
            + ` (${(elapsed / 1000).toFixed(1)} s)`);
        return elapsed;
    },

    // Every corridor standing on the map, as a take. Roads and tracks are the ONLY things that
    // divide a cadastral parcel — a building sits on a piece and a readjustment reforms whole
    // parcels, so neither appears here.
    _appliedCorridorTakes(appliedList) {
        const planOrderApi = (typeof window !== 'undefined') ? window.__planOrder : null;
        if (!planOrderApi || typeof planOrderApi.footprintOf !== 'function') return [];
        const route = applyRoute;
        const source = Array.isArray(appliedList)
            ? appliedList
            : ((typeof proposalStorage !== 'undefined' && proposalStorage.getAllProposals)
                ? proposalStorage.getAllProposals().filter(record => appliedOf(record))
                : []);
        const takes = [];
        source.forEach(record => {
            if (!record) return;
            const goalKey = route && typeof route.normalizeGoalKey === 'function'
                ? route.normalizeGoalKey(record.goal)
                : String(record.goal || '');
            if (goalKey !== 'road-track') return;
            let footprint = null;
            try { footprint = planOrderApi.footprintOf(record); } catch (_) { footprint = null; }
            if (!footprint || !footprint.geometry) return;
            const definition = record.roadProposal && record.roadProposal.definition;
            takes.push({
                id: String(record.proposalId),
                geometry: footprint.geometry,
                cadastreParcelIds: proposalClaims.cadastreParcelIdsOf(record).map(String),
                isTrack: !!(definition && definition.metadata && definition.metadata.isTrack),
                name: record.title || record.name || 'Road',
                coordinatedPlanId: _coordinatedPlanIdOf(record) || null
            });
        });
        return takes;
    },

    // Non-road plots authored by an explicitly coordinated plan. Its road records are published
    // separately, but the two geometries are one tessellation: road bands occupy the intentional
    // gaps between these plots. Corridor derivation starts from the cadastre, so its ordinary
    // remainders must be clipped around the standing plots instead of duplicated over them.
    //
    // The authored records are the source here, never the current map layers. During canonical
    // replay every generated layer has already been purged and every target record is temporarily
    // marked unapplied, so discovering plots through generated parcel ownership was both
    // architecturally backwards and ineffective exactly when replay needed it most.
    _coordinatedReadjustmentGroundByParcel(takes, appliedList = null) {
        const planIds = new Set((Array.isArray(takes) ? takes : [])
            .map(take => take && take.coordinatedPlanId ? String(take.coordinatedPlanId) : '')
            .filter(Boolean));
        const occupied = new Map();
        if (!planIds.size) return occupied;

        const explicitRecords = Array.isArray(appliedList);
        const records = explicitRecords
            ? appliedList
            : ((typeof proposalStorage !== 'undefined' && proposalStorage
                && typeof proposalStorage.getAllProposals === 'function')
                ? proposalStorage.getAllProposals().filter(record => appliedOf(record))
                : []);
        records.filter(Boolean).forEach(record => {
            const planId = _coordinatedPlanIdOf(record);
            if (!planId || !planIds.has(planId)) return;
            const goalKey = (applyRoute && typeof applyRoute.normalizeGoalKey === 'function')
                ? applyRoute.normalizeGoalKey(record.goal)
                : String(record.goal || '');
            if (goalKey !== 'reparcellization' || !record.reparcellization) return;

            const plots = (Array.isArray(record.reparcellization.polygons)
                ? record.reparcellization.polygons
                : [])
                .map(slice => {
                    const geometry = slice && slice.geometry ? slice.geometry : slice;
                    if (!geometry || !/Polygon/.test(String(geometry.type || ''))) return null;
                    return { type: 'Feature', properties: {}, geometry };
                })
                .filter(Boolean);
            if (!plots.length) return;

            // Anchors were projected from the author's explicit live selection and stamped before
            // publication. Assigning all authored plots to each declared base is safe: clipping a
            // parcel by a plot outside it is a no-op, while guessing a plot-to-base relationship
            // from a generated child id would recreate the lineage dependency this materializer is
            // designed to eliminate.
            proposalClaims.cadastreParcelIdsOf(record).forEach(baseId => {
                if (!occupied.has(baseId)) occupied.set(baseId, []);
                occupied.get(baseId).push(...plots);
            });
        });
        return occupied;
    },

    // Derive the parcel fabric from the cadastre and the corridors over it.
    //
    // This is the whole model in one method: a cadastral parcel's pieces are a FUNCTION of that
    // parcel and the takes that cross it, so nothing here is sequential, nothing is a child of
    // anything, and recomputing one parcel cannot disturb another. `parcelIds` is an explicit local
    // scope; when omitted, the scope is the union of the takes' published cadastral declarations.
    // The same materializer serves both paths, which keeps the incremental path honest.
    //
    // Because a piece is named by a hash of its own outline, a piece whose shape did not change
    // keeps its id, so the map update is a set difference: untouched pieces are never removed and
    // re-added, and a road drawn at one end of town does not disturb anything at the other.
    // A cadastral parcel that ARRIVES after the corridors were applied.
    //
    // Pieces were materialised when a road was applied, over whatever cadastre happened to be loaded
    // at that moment — and tile arrivals were presentation-only. So panning in a parcel afterwards
    // left it whole under a road that plainly crossed it, with no error and nothing to suggest it
    // had been missed (HR-330264-519 sat uncut under two). A parcel's pieces are a function of that
    // parcel and its explicitly declared takes, so a late arrival has the same answer as any other
    // parcel: it just had not been materialized yet. Repository provision seeds the declared ID;
    // only corridors indexed under that ID are consulted, and exact clipping then decides whether
    // the geometry changes.
    async integrateCadastralGround(features, options = {}) {
        const list = Array.isArray(features) ? features.filter(Boolean) : [];
        if (!list.length) return { ok: true, parcels: 0, fabric: null };
        const opts = options || {};
        if (opts._fabricQueue !== true && !proposalMutationTransactions.isActiveTransaction(opts._mutationTransaction)) {
            return this._enqueueFabricChange(() => this.integrateCadastralGround(list, {
                ...opts,
                _fabricQueue: true
            }));
        }
        if (!proposalMutationTransactions.isActiveTransaction(opts._mutationTransaction)) {
            return _runProposalMutationBoundary(this, 'cadastral-ground-arrived', null, opts,
                (_transaction, transactionOptions) => this.integrateCadastralGround(list, {
                    ...transactionOptions,
                    _fabricQueue: true
                }));
        }

        const fabric = (typeof window !== 'undefined' ? window : globalThis).LiveParcelFabric;
        const transaction = opts._fabricTransaction;
        if (!fabric || !transaction) throw new Error('Cadastral integration requires a live-fabric transaction.');
        fabric.seedCadastre(list, { transaction });

        const ids = list.map(_getParcelIdFromFeature).filter(Boolean).map(String);
        const takes = this._appliedCorridorTakes();
        let derived = { added: 0, removed: 0, unchanged: 0, parcels: ids.length, parcelIds: ids, failed: [] };
        if (takes.length) {
            derived = await this._deriveCorridorFabric({
                parcelIds: ids,
                takes,
                _fabricTransaction: transaction
            });
            if (Array.isArray(derived?.failed) && derived.failed.length) return false;
        }
        const refresh = () => {
            try { if (typeof scheduleCorridorStripRefresh === 'function') scheduleCorridorStripRefresh(); } catch (_) { }
        };
        opts._mutationTransaction.deferCommit('refresh corridors after cadastral arrival', refresh);
        return { ok: true, parcels: ids.length, fabric: derived };
    },

    // knowing to copy a field.
    async _deriveCorridorFabric(options = {}) {
        const ahead = _corridorFabricQueue;
        let done;
        _corridorFabricQueue = new Promise(resolve => { done = resolve; });
        // A failure ahead must not stop everything behind it.
        try { await ahead; } catch (_) { }
        try {
            return await this._deriveCorridorFabricBody(options);
        } finally {
            done();
        }
    },

    async _deriveCorridorFabricBody(options = {}) {
        const browserRoot = (typeof window !== 'undefined') ? window : globalThis;
        const breathe = async () => {
            if (typeof browserRoot.yieldToBrowser === 'function') await browserRoot.yieldToBrowser();
        };
        // Breathing on the CLOCK, not a count. A fixed chunk of 40 was 40 clips — half a
        // millisecond each on simple parcels and several on corridor-dense ones, so the same chunk
        // was either nothing or several dropped frames depending on where the pan landed.
        const CHUNK = 40;
        const _sliceNow = () => ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now());
        let _sliceStarted = _sliceNow();
        const breatheIfDue = async () => {
            if (_sliceNow() - _sliceStarted >= 12) {
                await breathe();
                _sliceStarted = _sliceNow();
            }
        };
        const A = browserRoot.__parcelArrangement;
        const repository = _cadastralParcelRepository();
        if (!A || typeof A.takeHitsOn !== 'function' || typeof A.fabricOver !== 'function') {
            throw new Error('Parcel arrangement service is unavailable.');
        }
        if (!repository || typeof repository.getMany !== 'function') {
            throw new Error('Cadastral parcel repository is unavailable.');
        }

        const takes = Array.isArray(options.takes) ? options.takes : this._appliedCorridorTakes(options.appliedList);
        const takeById = new Map(takes.map(take => [take.id, take]));
        const takesByCadastreId = new Map();
        const undeclaredTakes = [];
        takes.forEach(take => {
            const declared = proposalClaims.cadastreParcelIdsOf({
                cadastreParcelIds: take && take.cadastreParcelIds
            }).map(String);
            if (!declared.length) {
                undeclaredTakes.push(String(take?.id || 'unknown corridor'));
                return;
            }
            declared.forEach(cadastreId => {
                if (!takesByCadastreId.has(cadastreId)) takesByCadastreId.set(cadastreId, []);
                takesByCadastreId.get(cadastreId).push(take);
            });
        });
        if (undeclaredTakes.length) {
            const error = new Error(`Corridor proposal(s) have no published cadastral scope: ${undeclaredTakes.join(', ')}`);
            error.code = 'corridor-cadastre-scope-missing';
            error.proposalIds = undeclaredTakes.slice();
            throw error;
        }

        const scope = new Set((options.parcelIds
            ? Array.from(options.parcelIds)
            : Array.from(takesByCadastreId.keys()))
            .map(String)
            .filter(Boolean));
        // The exact overlaps the filter below computes, kept for the clip loop. Filtering used to
        // call takesOverlapping and throw the intersections away, so every (parcel × take) exact
        // clip ran twice — once to decide, once to arrange. Half the derivation's turf work was
        // repeats. A scoped caller (deriveArrivingParcels) may hand its own map in the same way.
        const hitsById = (options.hitsById && typeof options.hitsById.get === 'function')
            ? options.hitsById
            : new Map();
        const candidateFeatures = repository.getMany(scope);
        const candidates = candidateFeatures.map(feature => ({
            id: String(_getParcelIdFromFeature(feature) || ''),
            feature
        })).filter(entry => entry.id);
        const foundIds = new Set(candidates.map(entry => entry.id));
        const missingIds = Array.from(scope).filter(id => !foundIds.has(id));
        if (missingIds.length) {
            const error = new Error(`Cadastral ground is absent for: ${missingIds.join(', ')}`);
            error.code = 'cadastral-ground-absent';
            error.parcelIds = missingIds;
            throw error;
        }
        const parcels = [];
        _emitProposalProgress(options.onProgress, {
            phase: 'fabric-scan',
            done: 0,
            total: candidates.length
        });
        for (let i = 0; i < candidates.length; i += CHUNK) {
            for (const entry of candidates.slice(i, i + CHUNK)) {
                const id = String(entry.id);
                const relevantTakes = takesByCadastreId.get(id) || [];
                if (!hitsById.has(id)) {
                    hitsById.set(id, A.takeHitsOn(entry.feature, relevantTakes));
                }
                parcels.push(entry);
            }
            _emitProposalProgress(options.onProgress, {
                phase: 'fabric-scan',
                done: Math.min(i + CHUNK, candidates.length),
                total: candidates.length
            });
            if (i + CHUNK < candidates.length) await breatheIfDue();
        }
        if (!parcels.length) {
            _emitProposalProgress(options.onProgress, { phase: 'fabric-ready', parcels: 0, added: 0, removed: 0 });
            return { added: 0, removed: 0, unchanged: 0, parcels: 0, parcelIds: [], failed: [] };
        }

        let pieces = [];
        const failed = [];
        _emitProposalProgress(options.onProgress, {
            phase: 'fabric-arrange',
            done: 0,
            total: parcels.length
        });
        // The clip loop goes ONE PARCEL at a time so the clock can be consulted between clips —
        // fabricOver over a 40-parcel slice was itself an unbreakable 20-120 ms block, which is a
        // budget consulted every 40th step bounding nothing.
        for (let i = 0; i < parcels.length; i += 1) {
            const part = A.fabricOver(parcels.slice(i, i + 1), takes, hitsById);
            if (part && Array.isArray(part.pieces)) pieces.push(...part.pieces);
            if (part && Array.isArray(part.failed)) failed.push(...part.failed);
            if ((i + 1) % 25 === 0 || i + 1 === parcels.length) {
                _emitProposalProgress(options.onProgress, {
                    phase: 'fabric-arrange',
                    done: i + 1,
                    total: parcels.length
                });
            }
            if (i + 1 < parcels.length) await breatheIfDue();
        }
        // A parcel whose arrangement could not be computed keeps whatever it already has. Treating
        // it as "no pieces" would delete its ground from the map on the strength of a failure.
        const undecided = new Set((failed || []).map(entry => String(entry.parcelId)));
        if (undecided.size) {
            console.error('[deriveCorridorFabric] left untouched — could not arrange:', Array.from(undecided), failed);
        }
        const parcelById = new Map(parcels
            .filter(entry => !undecided.has(String(entry.id)))
            .map(entry => [String(entry.id), entry.feature]));

        // An untouched parcel comes back as the cadastral feature itself. Every changed parcel is
        // replaced as one fabric partition below; Leaflet is not consulted and cannot affect the
        // result.
        const coordinatedGround = typeof this._coordinatedReadjustmentGroundByParcel === 'function'
            ? this._coordinatedReadjustmentGroundByParcel(takes, options.appliedList)
            : new Map();
        if (coordinatedGround.size && typeof A.remaindersOutsideOccupiedGround === 'function') {
            pieces = A.remaindersOutsideOccupiedGround(pieces, coordinatedGround);
        }
        const fabricStore = browserRoot.LiveParcelFabric;
        if (!fabricStore || typeof fabricStore.replaceCadastreScope !== 'function') {
            throw new Error('Live parcel fabric is unavailable.');
        }
        const transaction = options._fabricTransaction;
        if (!transaction) {
            throw new Error('Corridor parcel derivation requires the active live-fabric transaction.');
        }
        const currentIds = fabricStore.entriesForCadastre(parcelById.keys(), {
            includeCorridors: true,
            ...(transaction ? { transaction } : {})
        })
            .filter(feature => A.isArrangementFeature(feature))
            .map(_getParcelIdFromFeature)
            .filter(Boolean)
            .map(String);
        const derived = pieces.filter(piece => piece.id !== piece.parcelId);
        const diff = A.diffPieces(currentIds, derived);
        _emitProposalProgress(options.onProgress, {
            phase: 'fabric-commit-ready',
            added: diff.added.length,
            removed: diff.removed.length,
            parcels: parcels.length
        });

        const features = pieces.map(piece => {
            const base = parcelById.get(String(piece.parcelId));
            if (piece.id === piece.parcelId) return base;
            const take = piece.takers.length ? takeById.get(piece.takers[0]) : null;
            return A.featureForPiece(piece, base, {
                isTrack: !!(take && take.isTrack),
                roadName: take ? take.name : null
            });
        }).filter(Boolean);
        fabricStore.replaceCadastreScope(parcelById.keys(), features, { transaction });

        _emitProposalProgress(options.onProgress, {
            phase: 'fabric-ready',
            parcels: parcels.length,
            added: diff.added.length,
            removed: diff.removed.length
        });

        return {
            added: diff.added.length,
            removed: diff.removed.length,
            unchanged: diff.unchanged.length,
            parcels: parcels.length,
            parcelIds: Array.from(parcelById.keys()),
            failed: failed || []
        };
    },

    // Remove exactly the disposable output authored by ONE proposal.
    //
    // Cadastral ids are durable anchors, not dependency edges. Sharing one of those anchors with
    // a long corridor does not make every proposal along that corridor part of this mutation. The
    // producer stamp written by _assignSyntheticChildIdentities is the complete ownership boundary
    // for generated parcels; presentation collections carry the same proposalId boundary.
    //
    // Generated-parcel ownership is separate authored/account state, not parcel geometry. Capture
    // only the affected owner ids so their indexes can be refreshed after the fabric commits; the
    // geometry itself exists exclusively in the fabric draft.
    _removeProposalOwnedOutput(record, options = {}) {
        const browserRoot = (typeof window !== 'undefined') ? window : globalThis;
        if (!record) return { proposalId: '', removedParcelIds: [], ownership: new Map() };
        const proposalId = String(record.proposalId || '');
        if (!proposalId) return { proposalId: '', removedParcelIds: [], ownership: new Map() };

        const fabric = browserRoot.LiveParcelFabric;
        const fabricTransaction = options._fabricTransaction;
        if (!fabric || !fabricTransaction) {
            throw new Error('Removing proposal output requires an active live-fabric transaction.');
        }
        const removedParcelIds = (fabric.producedBy?.(proposalId, { transaction: fabricTransaction }) || [])
            .map(_getParcelIdFromFeature)
            .filter(Boolean)
            .map(String);
        const ownership = new Map();
        removedParcelIds.forEach(id => {
            try {
                const owner = (typeof PersistentStorage !== 'undefined')
                    ? PersistentStorage.getItem(`parcel_${id}_owner`)
                    : null;
                if (owner) ownership.set(id, String(owner));
            } catch (_) { }
        });
        fabric.removeIds(removedParcelIds, { transaction: fabricTransaction });

        const dropAuthored = name => {
            if (!Array.isArray(browserRoot[name])) return;
            browserRoot[name] = browserRoot[name].filter(feature => (
                String(feature?.properties?.proposalId || '') !== proposalId
            ));
        };
        dropAuthored('parks');
        dropAuthored('squares');
        dropAuthored('lakes');
        dropAuthored('transitStations');
        dropAuthored('proposedBuildings');

        this._clearDerivedRecordState(record);
        return { proposalId, removedParcelIds, ownership };
    },

    _commitRemovedProposalOutput(removed) {
        if (!removed || !removed.proposalId) return;
        (removed.removedParcelIds || []).forEach(id => {
            try {
                if (typeof PersistentStorage !== 'undefined') {
                    PersistentStorage.removeItem(`parcel_${id}_owner`);
                }
            } catch (_) { }
        });
        const affectedAgents = new Set(Array.from((removed.ownership || new Map()).values()));
        affectedAgents.forEach(agentId => {
            try { if (typeof updateAgentOwnedParcels === 'function') updateAgentOwnedParcels(agentId); } catch (_) { }
        });
    },

    // Materialise a new or edited record over only its old/new local cadastral scope.
    async deriveForNewProposal(proposal, options = {}) {
        if (!proposal) return null;
        if (options._fabricQueue !== true) {
            return this._enqueueFabricChange(() => this.deriveForNewProposal(proposal, {
                ...options,
                _fabricQueue: true
            }));
        }
        const goalKey = (applyRoute && typeof applyRoute.normalizeGoalKey === 'function')
            ? applyRoute.normalizeGoalKey(proposal.goal)
            : String(proposal.goal || '');
        const supersededFootprints = (Array.isArray(options.supersededFootprints) ? options.supersededFootprints : [])
            .filter(footprint => footprint && footprint.geometry);
        const planOrderApi = (typeof window !== 'undefined') ? window.__planOrder : null;
        (Array.isArray(options.supersededIds) ? options.supersededIds : []).forEach(id => {
            const record = _getProposalRecord(id);
            if (!record || !planOrderApi || typeof planOrderApi.footprintOf !== 'function') return;
            try {
                const footprint = planOrderApi.footprintOf(record);
                if (footprint && footprint.geometry) supersededFootprints.push(footprint);
            } catch (_) { /* a record with no readable footprint freed no ground */ }
        });

        const priorAppliedAt = Object.prototype.hasOwnProperty.call(proposal, 'appliedAt')
            ? proposal.appliedAt
            : null;
        try { setProposalApplied(proposal, true, priorAppliedAt ? { appliedAt: priorAppliedAt } : {}); }
        catch (_) { proposal.applied = true; }

        const oldFootprintSeeds = supersededFootprints.map((footprint, index) => ({
            proposalId: `old-footprint-${index}`,
            geometry: footprint.geometry
        }));
        // Alternatives were parked as record-state changes above. Name the records as seeds so
        // their proposal-owned output is removed; their flat anchors stay local and no other
        // proposal sharing those anchors is pulled into the operation.
        const supersededRecords = (Array.isArray(options.supersededRecords)
            ? options.supersededRecords
            : []).filter(Boolean);
        const localSeeds = [proposal, ...supersededRecords, ...oldFootprintSeeds];
        const materialize = goalKey === 'road-track'
            ? this.rematerializeCorridorScope
            : this.rematerializeFlatScope;
        const summary = await materialize.call(this, localSeeds, {
            _fabricQueue: true,
            _mutationTransaction: options._mutationTransaction,
            _fabricTransaction: options._fabricTransaction,
            silent: options.silent === true,
            purpose: 'apply',
            // This may use the replay engine internally, but to the person who just created or
            // explicitly applied the record it is an APPLY. Reserve "Re-derived" for recovery and
            // replay of something that already stood on the map.
            statusMode: 'apply'
        });
        const key = String(proposal.proposalId || '');
        const targetFailed = !summary || summary.ok !== true
            || (Array.isArray(summary.failed) && summary.failed.some(entry => String(entry.proposalId) === key));
        if (targetFailed) return null;
        return { applied: true, goalKey, ...summary };
    },

    // Several consecutive corridors in one shared package are one change to the cadastral fabric,
    // not a sequence of unrelated clicks. Materialise their complete take set in one pass, exactly
    // as a canonical rebuild does. The package phase decides whether this batch runs before an
    // ordinary readjustment or after a coordinated, pre-tessellated one.
    async materializeCorridorBatch(proposalIds, options = {}) {
        const ids = Array.from(new Set((Array.isArray(proposalIds) ? proposalIds : [])
            .map(id => String(id || '')).filter(Boolean)));
        if (!ids.length) return { ok: true, appliedIds: [], failedIds: [] };
        const opts = options || {};

        if (opts._fabricQueue !== true && !proposalMutationTransactions.isActiveTransaction(opts._mutationTransaction)) {
            return this._enqueueFabricChange(() => this.materializeCorridorBatch(ids, {
                ...opts,
                _fabricQueue: true
            }));
        }

        let failure = null;
        const run = async (_transaction, transactionOptions) => {
            const records = [];
            const missingIds = [];
            ids.forEach(id => {
                const record = _getProposalRecord(id);
                const goalKey = record && applyRoute?.normalizeGoalKey?.(record.goal);
                if (!record || goalKey !== 'road-track') missingIds.push(id);
                else records.push(record);
            });
            if (missingIds.length) {
                failure = {
                    ok: false,
                    appliedIds: [],
                    failedIds: ids,
                    reason: `Missing corridor record(s): ${missingIds.join(', ')}`
                };
                return false;
            }

            const tracks = records.filter(record => !!record?.roadProposal?.definition?.metadata?.isTrack).length;
            const roads = records.length - tracks;
            _emitProposalProgress(opts.onProgress, {
                phase: 'corridor-start',
                members: records.length,
                roads,
                tracks
            });
            records.forEach(record => {
                try { setProposalApplied(record, true); } catch (_) { record.applied = true; }
                proposalStorage._indexProposal?.(record);
            });

            const derived = await this.rematerializeCorridorScope(records, {
                ...transactionOptions,
                _fabricQueue: true,
                silent: opts.deferPresentation === true,
                deferSave: true,
                onProgress: opts.onProgress
            });
            if (!derived || derived.ok !== true) {
                const reason = derived?.failed?.[0]?.reason || 'The corridor ground could not be derived locally.';
                records.forEach(record => this._setLastApplyFailure?.(String(record.proposalId), {
                    code: 'corridor-batch-failed',
                    message: reason
                }));
                failure = {
                    ok: false,
                    appliedIds: [],
                    failedIds: records.map(record => String(record.proposalId)),
                    reason
                };
                return false;
            }

            if (opts.deferSave !== true) proposalStorage.save?.();
            const result = {
                ok: true,
                appliedIds: records.map(record => String(record.proposalId)),
                failedIds: [],
                scope: derived
            };
            const announceReady = () => _emitProposalProgress(opts.onProgress, {
                phase: 'corridor-ready',
                members: records.length,
                roads,
                tracks
            });
            if (proposalMutationTransactions.isActiveTransaction(transactionOptions._mutationTransaction)) {
                transactionOptions._mutationTransaction.deferCommit('announce corridor batch ready', announceReady);
            } else {
                announceReady();
            }
            return result;
        };

        if (proposalMutationTransactions.isActiveTransaction(opts._mutationTransaction)) {
            return run(opts._mutationTransaction, opts);
        }
        const result = await _runProposalMutationBoundary(this, 'corridor-batch', ids.join(','), opts, run);
        return result === false ? failure : result;
    },

    async _rebuildPass(appliedList, opts) {
        const passOptions = opts || {};
        const failed = [];
        let appliedCount = 0;
        // A replay is an ordered fold of disposable output. Authored `applied` flags remain stable
        // throughout; forceMaterialize bypasses the idempotence shortcut below. UI readers can thus
        // never observe a temporary all-unapplied plan while this private fabric draft is built.
        const replayStamps = new Map();
        (appliedList || []).forEach(proposal => {
            if (!proposal) return;
            replayStamps.set(String(proposal.proposalId), {
                hadAppliedAt: Object.prototype.hasOwnProperty.call(proposal, 'appliedAt'),
                appliedAt: proposal.appliedAt,
                hadUpdatedAt: Object.prototype.hasOwnProperty.call(proposal, 'updatedAt'),
                updatedAt: proposal.updatedAt
            });
        });
        // Every member's ground is loaded BEFORE anything derives, all of it at once. The fetches
        // are independent reads, and asking for them one member at a time made finishing one road
        // cost a full HTTP round-trip for every proposal already on the map — the cost that grew
        // with the plan, in series, before any geometry ran at all.
        const [groundMs, demolitionBuildings] = await Promise.all([
            this._loadReplayGround(appliedList, {
                onProgress: passOptions.onProgress,
                purpose: 'replay',
                _fabricTransaction: passOptions._fabricTransaction
            }),
            this._prefetchDemolitionBuildings(appliedList, { onProgress: passOptions.onProgress })
        ]);
        // Only after every cadastral prerequisite is available do we replace the target partition.
        // The old implementation reset Leaflet first and fetched second, exposing an empty/partial
        // map for the entire replay and making a failed request destructive.
        const resetStarted = _now();
        this._resetDerivedFabric(appliedList, {
            cadastreParcelIds: passOptions.cadastreParcelIds,
            proposalIds: passOptions.resetProposalIds,
            recordsToClear: passOptions.recordsToClear,
            _mutationTransaction: passOptions._mutationTransaction,
            _fabricTransaction: passOptions._fabricTransaction
        });
        const resetMs = _now() - resetStarted;
        _emitProposalProgress(passOptions.onProgress, {
            phase: 'rebuild-reset',
            members: (appliedList || []).length
        });
        const foldStarted = _now();

        // The corridors divide the cadastre in ONE derivation, not one member at a time. A parcel's
        // pieces are a function of that parcel and the takes over it, so there is nothing to fold:
        // no order, no parentage, no junction rule. What remains for the fold is everything that
        // stands ON the resulting ground.
        const componentTakes = this._appliedCorridorTakes(appliedList);
        const takes = Array.isArray(passOptions.corridorTakes)
            ? passOptions.corridorTakes
            : componentTakes;
        // ...which is also why a reload of a plan with a hundred roads passed through here in
        // silence: there is no per-corridor apply to announce. The derivation announces itself
        // instead, and says what it covers — one pair of lines for the whole set, because that is
        // honestly what it is.
        if (componentTakes.length) {
            const tracks = componentTakes.filter(take => take && take.isTrack).length;
            _emitProposalProgress(passOptions.onProgress, {
                phase: 'corridor-start',
                members: componentTakes.length,
                roads: componentTakes.length - tracks,
                tracks
            });
            _announceApply(`Applying ${_corridorCountPhrase(componentTakes)}...`);
        }
        const fabric = await this._deriveCorridorFabric({
            appliedList,
            takes,
            onProgress: passOptions.onProgress,
            _fabricTransaction: passOptions._fabricTransaction,
            ...(passOptions.cadastreParcelIds ? { parcelIds: passOptions.cadastreParcelIds } : {})
        });
        if (Array.isArray(fabric?.failed) && fabric.failed.length) {
            fabric.failed.forEach(entry => failed.push({
                proposalId: null,
                title: entry.parcelId || 'Cadastral parcel',
                code: 'corridor-arrangement-failed',
                reason: entry.error || 'corridor arrangement failed'
            }));
        }
        if (componentTakes.length) _announceApply(`Applied ${_corridorCountPhrase(componentTakes)}`);
        const corridorIds = new Set(componentTakes.map(take => take.id));
        const replayMembersTotal = (appliedList || []).filter(proposal => {
            const id = String(proposal && proposal.proposalId || '');
            return id && !corridorIds.has(id);
        }).length;

        // Which member cost the most. A replay of twenty proposals that takes three seconds is a
        // very different problem depending on whether that is twenty × 150 ms or one × 2,800 ms.
        let slowest = null;
        let replayDone = 0;

        // ONE batch around the whole replay, not one per member. Each apply already opens its own
        // batch, so without an outer one the store re-serialises EVERY proposal it holds after
        // every single apply: 299 members means 299 full JSON writes of a collection that is
        // growing as it goes. A CPU profile of 26 s of replay put _persist and its garbage among
        // the top costs; the batch counter is designed for exactly this — inner endBatch calls
        // decrement to 1 and write nothing, and the single write happens here at the end.
        // Same reasoning as the game turn loop (game.js), which batches for the same reason.
        const batchStore = (typeof proposalStorage !== 'undefined') ? proposalStorage : null;
        const replayBatched = !!(batchStore
            && typeof batchStore.beginBatch === 'function'
            && typeof batchStore.endBatch === 'function');
        if (replayBatched) batchStore.beginBatch();
        try {

        for (const proposal of appliedList) {
            const key = (typeof getProposalKey === 'function' && getProposalKey(proposal)) || proposal.proposalId;
            const memberStarted = _now();
            let ok = false;
            // A corridor's ground is already derived above; it stands by virtue of being a take.
            if (corridorIds.has(String(proposal.proposalId))) {
                appliedCount += 1;
                const priorCorridorStamp = replayStamps.get(String(proposal.proposalId));
                if (priorCorridorStamp) {
                    if (priorCorridorStamp.hadAppliedAt) proposal.appliedAt = priorCorridorStamp.appliedAt;
                    else delete proposal.appliedAt;
                    if (priorCorridorStamp.hadUpdatedAt) proposal.updatedAt = priorCorridorStamp.updatedAt;
                    else delete proposal.updatedAt;
                }
                continue;
            }
            replayDone += 1;
            _emitProposalProgress(passOptions.onProgress, {
                phase: 'proposal-apply',
                label: _getProposalApplyLabel(key, proposal),
                done: replayDone,
                total: replayMembersTotal
            });
            try {
                const replayOptions = {
                    replay: true,
                    forceMaterialize: true,
                    preserveAppliedSet: passOptions.preserveAppliedSet === true,
                    _mutationTransaction: passOptions._mutationTransaction,
                    _fabricTransaction: passOptions._fabricTransaction
                };
                if (demolitionBuildings && demolitionBuildings.has(String(key))) {
                    replayOptions.preloadedBuildings = demolitionBuildings.get(String(key));
                }
                ok = await this.applyProposal(key, replayOptions);
            } catch (error) {
                console.error('[rebuildAppliedFabric] apply threw for', key, error);
                ok = false;
            }
            // Between members, not inside one: a replay of 180 proposals is a minute of work, and
            // without a macrotask boundary the whole minute is one frame. Costs ~4 ms a member and
            // buys back a map you can pan while it runs.
            if (typeof window !== 'undefined' && typeof window.yieldToBrowser === 'function') {
                await window.yieldToBrowser();
            }
            const memberMs = _now() - memberStarted;
            if (!slowest || memberMs > slowest.ms) slowest = { key: String(key), ms: memberMs };
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

        } finally {
            // finally, not after the loop: a throw mid-replay must still leave the store's batch
            // depth where it found it, or every later save in the session is silently suppressed.
            if (replayBatched) batchStore.endBatch();
        }
        // Recorded, not yet printed: the caller adds the strip refresh and the pass count, so a
        // rebuild reports itself in ONE line instead of one per phase.
        this._lastRebuildProfile = {
            members: (appliedList || []).length,
            corridors: corridorIds.size,
            fabric,
            resetMs,
            groundMs,
            foldMs: _now() - foldStarted,
            stripsMs: 0,
            passes: 0,
            failed: failed.length,
            slowest
        };

        _emitProposalProgress(passOptions.onProgress, { phase: 'save' });
        try { if (typeof proposalStorage.save === 'function') proposalStorage.save(); } catch (_) { }
        return { ok: failed.length === 0, applied: appliedCount, failed, invalidated: [] };
    },

    _clearDerivedRecordState(proposal) {
        if (!proposal || typeof proposal !== 'object') return proposal;
        delete proposal.childParcelIds;
        delete proposal.descendantParcelIds;
        delete proposal.parentFeatures;
        delete proposal.childFeatures;
        ['roadProposal', 'reparcellization', 'decideLaterProposal', 'buildingProposal', 'structureProposal'].forEach(key => {
            const sub = proposal[key];
            if (!sub || typeof sub !== 'object' || Array.isArray(sub)) return;
            delete sub.childParcelIds;
            delete sub.parentFeatures;
            delete sub.parentsToRemove;
            delete sub.formation;
            delete sub.childFeatures;
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
    // pristine live registry, not merely a different presentation: stale derived entries in the
    // former map-owned registry could put old ground back into the next cut. Derived parcels are
    // regenerated by applied records;
    // an unknown/orphan token has no standing claim and is purged as well.
    _resetDerivedFabric(appliedList, options = {}) {
        const browserRoot = typeof window !== 'undefined' ? window : globalThis;
        const fabric = browserRoot.LiveParcelFabric;
        const repository = _cadastralParcelRepository();
        const fabricTransaction = options._fabricTransaction;
        if (!fabric || !fabricTransaction) {
            throw new Error('Resetting derived parcels requires an active live-fabric transaction.');
        }
        if (!repository || typeof repository.list !== 'function' || typeof repository.getMany !== 'function') {
            throw new Error('Resetting derived parcels requires the cadastral repository.');
        }

        const requestedScope = Array.isArray(options.cadastreParcelIds)
            ? options.cadastreParcelIds
            : (options.cadastreParcelIds instanceof Set ? Array.from(options.cadastreParcelIds) : null);
        const scope = new Set((requestedScope || []).map(String).filter(Boolean));
        if (!requestedScope) {
            repository.list().forEach(feature => {
                const id = _getParcelIdFromFeature(feature);
                if (id) scope.add(String(id));
            });
            fabric.list({ transaction: fabricTransaction }).forEach(feature => {
                fabric.explicitCadastreIds(feature).forEach(id => scope.add(String(id)));
            });
        }
        const ids = Array.from(scope);
        const canonical = repository.getMany(ids);
        const found = new Set(canonical.map(_getParcelIdFromFeature).filter(Boolean).map(String));
        const missing = ids.filter(id => !found.has(id));
        if (missing.length) {
            const error = new Error(`Cadastral ground is unavailable for reset: ${missing.join(', ')}`);
            error.code = 'cadastral-reset-incomplete';
            error.parcelIds = missing;
            throw error;
        }
        // Register the repository facts in this same draft before asking the fabric to prove that
        // the replacement is an exact partition. Existing derived occupants prevent seedCadastre
        // from adding duplicate live parcels; it still records their immutable source geometry.
        fabric.seedCadastre(canonical, { transaction: fabricTransaction });
        fabric.replaceCadastreScope(ids, canonical, { transaction: fabricTransaction });

        const proposalIds = new Set((Array.isArray(options.proposalIds)
            ? options.proposalIds
            : (requestedScope ? [] : (Array.isArray(appliedList) ? appliedList : [])))
            .map(value => (value && typeof value === 'object') ? value.proposalId : value)
            .filter(value => value !== undefined && value !== null)
            .map(String));
        const resetCollection = name => {
            if (!Array.isArray(browserRoot[name])) return;
            browserRoot[name] = browserRoot[name].filter(feature => {
                const owner = String(feature?.properties?.proposalId || '');
                if (!owner) return true;
                return requestedScope ? !proposalIds.has(owner) : false;
            });
        };
        resetCollection('parks');
        resetCollection('squares');
        resetCollection('lakes');
        resetCollection('transitStations');
        resetCollection('proposedBuildings');

        (Array.isArray(options.recordsToClear) ? options.recordsToClear : (Array.isArray(appliedList) ? appliedList : []))
            .forEach(proposal => this._clearDerivedRecordState(proposal));

        const refresh = () => {
            try { if (typeof updateParksLayer === 'function') updateParksLayer(); } catch (_) { }
            try { if (typeof updateSquaresLayer === 'function') updateSquaresLayer(); } catch (_) { }
            try { if (typeof updateLakesLayer === 'function') updateLakesLayer(); } catch (_) { }
            try { if (typeof updateTransitStationsLayer === 'function') updateTransitStationsLayer(); } catch (_) { }
            try { if (typeof updateProposedBuildingsLayer === 'function') updateProposedBuildingsLayer(); } catch (_) { }
        };
        if (proposalMutationTransactions.isActiveTransaction(options._mutationTransaction)) {
            options._mutationTransaction.deferCommit('refresh derived presentation collections', refresh);
        } else {
            refresh();
        }
        return { parcels: ids.length };
    },

    _upsertParcelProperties(parcelId, mutator, options = {}) {
        if (!parcelId) return;
        const idStr = parcelId && parcelId.toString ? parcelId.toString() : String(parcelId);
        if (!idStr) return;

        const fabric = (typeof window !== 'undefined' ? window : globalThis).LiveParcelFabric;
        const transaction = options._fabricTransaction;
        if (!fabric || !transaction) {
            throw new Error('Parcel property mutation requires the active live-fabric transaction.');
        }
        const feature = fabric.get(idStr, { transaction });
        if (!feature) return;
        try { mutator(feature.properties || (feature.properties = {})); } catch (_) { return; }
        fabric.upsertFeatures([feature], { transaction, replaceExisting: true });
    },

    _resolveParcelFeaturesByIds(parcelIds, options = {}) {
        const allowMissing = options.allowMissing === true;
        const browserRoot = typeof window !== 'undefined' ? window : globalThis;
        const fabric = browserRoot.LiveParcelFabric;
        if (!fabric || typeof fabric.getMany !== 'function') {
            throw new Error('Live parcel fabric is unavailable.');
        }
        const transaction = options._fabricTransaction;
        return fabric.getMany(parcelIds, {
            allowMissing,
            ...(transaction ? { transaction } : {})
        }).features;
    },

   _assignSyntheticChildIdentities(proposalId, childFeatures, options = {}) {
        _assignSyntheticChildIdentitiesImpl(proposalId, childFeatures, options);
    },

    _createForeignIndexAllocator(options = {}) {
        if (!options._fabricTransaction) {
            throw new Error('Foreign parcel identity allocation requires an explicit live-fabric transaction.');
        }
        return _createForeignIndexAllocator(options._fabricTransaction);
    },

    _buildSyntheticToken,
    _composeSyntheticParcelNumber,
    _composeSyntheticParcelId,

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

    _collectAppliedAlternativesForExplicitApply(proposalData, candidateRecords = null) {
        if (!proposalData || typeof proposalStorage === 'undefined') return [];
        const runtime = typeof window !== 'undefined' ? window : globalThis;
        const collect = runtime && runtime.collectAppliedProposalAlternatives;
        if (typeof collect !== 'function') return [];
        if (!Array.isArray(candidateRecords) && typeof proposalStorage.getAllProposals !== 'function') return [];
        try {
            // Shared-plan application supplies the records that were already standing before the
            // plan began. Include the target so replacement-family links originating on it remain
            // visible, without rescanning every parked/incoming record for every member.
            const records = Array.isArray(candidateRecords)
                ? [proposalData, ...candidateRecords.filter(record => record && record !== proposalData)]
                : proposalStorage.getAllProposals();
            return collect(proposalData, records, {
                planOrder: runtime.__planOrder || null
            });
        } catch (error) {
            console.warn('[applyProposal] could not inspect applied alternatives', error);
            return [];
        }
    },

    // Shared plans never supersede unrelated work. This is the same live check the ordinary
    // supersede:false path uses, exposed so a parked shared record can go straight through the
    // one-boundary replay apply instead of first paying a separate mark-state transaction.
    validateSharedProposalGround(proposalId, planMemberIds, candidateRecords = null) {
        const proposal = _getProposalRecord(proposalId);
        if (!proposal) return { ok: false, blockers: [], missing: true };
        const membership = planMemberIds;
        const inPlan = (membership && typeof membership.has === 'function')
            ? id => membership.has(id)
            : () => false;
        const blockers = this._collectAppliedAlternativesForExplicitApply(proposal, candidateRecords)
            .filter(alternative => !inPlan(String(alternative.proposalId || '')));
        if (!blockers.length) return { ok: true, blockers: [] };

        const names = blockers
            .map(alternative => alternative.title || alternative.name || String(alternative.proposalId))
            .join('; ');
        try {
            this._setLastApplyFailure(proposalId, {
                code: 'ground-held-by-proposal',
                message: `The ground is held by ${blockers.length} applied proposal(s): ${names}. `
                    + 'Apply this one directly to choose it over them.',
                conflictTitles: blockers.map(alternative => alternative.title || alternative.name || '').filter(Boolean),
                conflictProposalIds: blockers.map(alternative => String(alternative.proposalId || '')).filter(Boolean)
            });
        } catch (_) { /* reporting must not change the refusal */ }
        return { ok: false, blockers };
    },

    async applyProposal(proposalId, options = {}) {
        const applyOptions = options || {};
        if (applyOptions.replay !== true) {
            return this._enqueueFabricChange(async () => {
                if (typeof proposalStorage === 'undefined') return false;
                const proposal = _getProposalRecord(proposalId);
                if (!proposal) return false;
                if (appliedOf(proposal)) return true;

                // Superseding is what an explicit Apply CLICK means: "this design, not that one."
                // A plan apply is not that — opening someone's plan link should never quietly stand
                // down work you had applied — so callers that are not a deliberate choice pass
                // supersede:false and get a refusal instead, reported with everything else the plan
                // could not apply. Checked here, before any mutation: it is read-only.
                if (applyOptions.supersede === false) {
                    const validation = this.validateSharedProposalGround(proposalId, applyOptions.planMemberIds);
                    if (!validation.ok) return false;
                }
                let switchedAlternatives = [];
                const applied = await _runProposalMutationBoundary(
                    this,
                    'apply',
                    proposalId,
                    applyOptions,
                    async (_transaction, transactionOptions) => {
                        const parkedFootprints = [];
                        switchedAlternatives = this._collectAppliedAlternativesForExplicitApply(proposal);
                        switchedAlternatives.forEach(alternative => {
                            try {
                                const order = (typeof window !== 'undefined') ? window.__planOrder : null;
                                const footprint = order && typeof order.footprintOf === 'function'
                                    ? order.footprintOf(alternative)
                                    : null;
                                if (footprint && footprint.geometry) parkedFootprints.push(footprint);
                            } catch (_) { }
                            setProposalApplied(alternative, false, { stamp: false });
                            proposalStorage._indexProposal?.(alternative);
                        });
                        setProposalApplied(proposal, true);
                        proposalStorage._indexProposal?.(proposal);
                        const derived = await this.deriveForNewProposal(proposal, {
                            ...transactionOptions,
                            _fabricQueue: true,
                            supersededFootprints: parkedFootprints,
                            supersededRecords: switchedAlternatives
                        });
                        if (!derived || derived.ok !== true) return false;
                        // Success means the requested authored record and its prepared fabric
                        // output agree. Committing a draft after a nested rule parked the target
                        // would return `false` to the caller only after making the conflicting
                        // partial state visible.
                        if (!appliedOf(proposal)) return false;
                        proposalStorage.save?.();
                        return true;
                    }
                );
                if (applied !== true) return false;

                // Standing another proposal down is not a detail. It used not to happen at all for
                // two block designs over the same parcels — both stayed applied — and now that it
                // does, doing it in silence would be the next surprise.
                if (switchedAlternatives.length) {
                    const names = switchedAlternatives
                        .map(alternative => alternative.title || alternative.name || String(alternative.proposalId))
                        .join('; ');
                    const message = `${switchedAlternatives.length} proposal(s) taken off the map — they stand on the same ground: ${names}`;
                    try {
                        if (typeof showEphemeralMessage === 'function') showEphemeralMessage(message, 10000, 'warning');
                        else if (typeof updateStatus === 'function') updateStatus(message);
                    } catch (_) { }
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
        if (isAlreadyApplied && applyOptions.forceMaterialize !== true) return true;
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
                // During boot replay corridors were already folded together by _rebuildPass. A
                // direct low-level call derives only this road's local corridor scope against the
                // complete standing take set. Corridor ribbon may legitimately cross water,
                // bridges, or cadastral gaps, so it uses the corridor scope resolver rather than
                // the strict complete-host proof used by buildings and structures.
                try { setProposalApplied(proposalData, true, { stamp: false }); } catch (_) { proposalData.applied = true; }
                if (this._rebuildInProgress) return true;
                const derived = await this.rematerializeCorridorScope([proposalData]);
                if (derived && derived.ok === true) return true;
                try { setProposalApplied(proposalData, false, { stamp: false }); } catch (_) { proposalData.applied = false; }
                const message = 'Cannot apply road: its footprint could not be read.';
                try { this._setLastApplyFailure(safeId, { code: 'corridor-footprint-missing', message }); } catch (_) { }
                return false;
            }
            if (route === 'reparcellization') {
                return await this._applyReparcellizationProposal(safeId, proposalData, applyOptions);
            }
            if (route === 'decide-later') {
                return await this._applyDecideLaterProposal(safeId, proposalData, applyOptions);
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
        }, applyOptions);

        if (result && applyOptions.preserveAppliedSet !== true) {
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
        const opts = options || {};
        const suppliedTransaction = proposalMutationTransactions.isActiveTransaction(opts._mutationTransaction);

        // A structure can park an earlier building while the structure itself is being derived.
        // That state change belongs to the enclosing scope fold, so it must neither enqueue behind
        // its own root transaction nor start a second parcel derivation.
        if (suppliedTransaction && opts.skipRebuild === true) {
            return this._unapplyProposalTransactionBody(proposalId, opts);
        }

        if (!suppliedTransaction && opts._fabricQueue !== true) {
            return this._enqueueFabricChange(() => this.unapplyProposal(proposalId, {
                ...opts,
                _fabricQueue: true
            }));
        }

        const seed = _getProposalRecord(proposalId);
        if (!seed) return false;
        if (!appliedOf(seed)) return true;
        const startedAt = _now();
        const label = _getProposalApplyLabel(proposalId, seed);
        const kind = _proposalApplyKind(seed);
        const scope = this._recordedCadastreScope([seed]);
        let summary = null;

        _emitProposalProgress(opts.onProgress, {
            phase: 'unapply-start',
            proposalId: String(proposalId),
            label,
            kind,
            parcels: scope.cadastreParcelIds.length
        });

        const changed = await _runProposalMutationBoundary(
            this,
            'unapply',
            proposalId,
            opts,
            async (_transaction, transactionOptions) => {
                // Ground is a prerequisite, not a repair step. If it is unavailable, nothing —
                // neither the proposal record nor the live fabric nor Leaflet — is committed.
                if (scope.cadastreParcelIds.length) {
                    await this._loadReplayGround([seed], {
                        onProgress: opts.onProgress,
                        purpose: 'unapply',
                        _fabricTransaction: transactionOptions._fabricTransaction
                    });
                    const profile = this._lastReplayGroundProfile || {};
                    if ((profile.missingIds || []).length || Number(profile.unavailableMembers) > 0) {
                        return false;
                    }
                }

                const stateChanged = await this._unapplyProposalTransactionBody(proposalId, {
                    ...transactionOptions,
                    deferSave: true
                });
                if (stateChanged !== true) return false;

                // Removal never rediscovers land from the proposal footprint. The durable record
                // already names the original cadastral facts it owns; the local fabric restorer
                // folds the remaining standing proposals over exactly that closed scope.
                summary = await this._rematerializeResolvedScope([seed], scope, {
                    ...transactionOptions,
                    _fabricQueue: true,
                    purpose: 'unapply',
                    statusMode: 'rederive',
                    onProgress: opts.onProgress
                });
                if (!summary || summary.ok !== true) return false;
                proposalStorage.save?.();
                return true;
            }
        );
        if (changed !== true) return false;

        this._refreshUIAfterProposalChange(_getProposalRecord(proposalId));
        console.info(`[unapplyProposal] Unapplied ${kind} ${label} — ${Math.round(_now() - startedAt)} ms`
            + ` · ${scope.cadastreParcelIds.length} cadastral parcel(s)`
            + ` · ${Number(summary?.fabric?.parcels) || 0} local live parcel piece(s)`);
        return true;
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

        // This transaction changes authored state only. A direct user action separately asks the
        // local fabric restorer to remove proposal-owned output on the recorded cadastral anchors;
        // nested/replay callers already have an enclosing materialization for that presentation work.
        this._clearDerivedRecordState(proposalData);
        setProposalApplied(proposalData, false, { stamp: false });
        proposalStorage._indexProposal?.(proposalData);
        if (options.deferSave !== true) proposalStorage.save?.();
        return true;
    },

    /**
     * Refresh all UI elements after a proposal state change.
     * This is called after the record change and canonical replay.
     */
    _refreshUIAfterProposalChange(proposalData) {
        const refreshAll = !proposalData;
        let route = null;
        let goalKey = '';
        try {
            const classified = proposalData ? applyRoute.classifyApplyRoute(proposalData) : null;
            route = classified?.route || null;
            goalKey = classified?.goalKey || '';
        } catch (_) { }

        // Core proposal UI
        // Corridors are expensive derived presentation. A building/park change cannot alter their
        // cross-sections, so scheduling all strips after every unapply merely moves a global rebuild
        // into the next event-loop turn — exactly the one the user's first pan then collides with.
        if (refreshAll || route === 'road-track') {
            try { if (typeof scheduleCorridorStripRefresh === 'function') scheduleCorridorStripRefresh(); } catch (_) { }
        }
        try { if (typeof refreshParcelStylesForAppliedProposals === 'function') refreshParcelStylesForAppliedProposals(); } catch (_) { }
        try { if (typeof updateProposalLayer === 'function') updateProposalLayer(); } catch (_) { }
        try { if (typeof updateProposalList === 'function') updateProposalList(); } catch (_) { }
        try { if (typeof updateShowProposalsButton === 'function') updateShowProposalsButton(); } catch (_) { }
        try { if (typeof syncProposalsIndicator === 'function') syncProposalsIndicator(); } catch (_) { }

        // Refresh only the presentation cache owned by the changed proposal.
        if (refreshAll || goalKey === 'park') {
            try { if (typeof updateParksLayer === 'function') updateParksLayer(); } catch (_) { }
        }
        if (refreshAll || goalKey === 'lake') {
            try { if (typeof updateLakesLayer === 'function') updateLakesLayer(); } catch (_) { }
        }
        if (refreshAll || goalKey === 'square') {
            try { if (typeof updateSquaresLayer === 'function') updateSquaresLayer(); } catch (_) { }
        }
        if (refreshAll || goalKey === 'station') {
            try { if (typeof updateTransitStationsLayer === 'function') updateTransitStationsLayer(); } catch (_) { }
        }

        if (refreshAll || route === 'building') {
            try { if (typeof updateProposedBuildingsLayer === 'function') updateProposedBuildingsLayer(); } catch (_) { }
        }

        if (refreshAll || route === 'reparcellization') {
            try { if (typeof updateReparcellizationLayers === 'function') updateReparcellizationLayers(); } catch (_) { }
        }

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
                const fabric = window.LiveParcelFabric;
                const selectedFeature = fabric?.get?.(window.selectedParcelId);
                const selectedCadastreIds = selectedFeature
                    ? fabric.explicitCadastreIds(selectedFeature)
                    : [];
                const affectedCadastreIds = new Set(proposalClaims.cadastreParcelIdsOf(proposalData));
                if (selectedCadastreIds.some(id => affectedCadastreIds.has(String(id)))) {
                    if (typeof showParcelInfoPanel === 'function') {
                        const parcelLayer = window.ParcelPresenter?.getLayer?.(window.selectedParcelId);
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
        const scope = this._recordedCadastreScope([proposalData]);

        // Delete is the same local mutation as unapply, followed by removing the authored record.
        // The record remains available as the immutable scope seed until the new local fabric has
        // been prepared; only then is it removed from the proposal store. The root boundary commits
        // the store, fabric, and presenter together or restores all three.
        const deleted = await _runProposalMutationBoundary(
            this,
            'delete-local',
            proposalId,
            options,
            async (_transaction, transactionOptions) => {
                if (wasApplied && !this._rebuildInProgress) {
                    if (scope.cadastreParcelIds.length) {
                        await this._loadReplayGround([proposalData], {
                            purpose: 'delete',
                            _fabricTransaction: transactionOptions._fabricTransaction
                        });
                    }
                    setProposalApplied(proposalData, false, { stamp: false });
                    const restored = await this._rematerializeResolvedScope([proposalData], scope, {
                        ...transactionOptions,
                        _fabricQueue: true,
                        purpose: 'delete',
                        statusMode: 'rederive'
                    });
                    if (!restored || restored.ok !== true) return false;
                }
                return !!proposalStorage.removeProposal(proposalId);
            }
        );
        if (deleted !== true) return false;
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

    _removeFeaturesFromMap(features, options = {}) {
        const list = Array.isArray(features) ? features : [];
        const ids = list.map(_getParcelIdFromFeature).filter(Boolean).map(String);
        if (!ids.length) return [];
        const fabric = (typeof window !== 'undefined' ? window : globalThis).LiveParcelFabric;
        const transaction = options._fabricTransaction;
        if (!fabric || !transaction) {
            throw new Error('Removing live parcels requires an active live-fabric transaction.');
        }
        return fabric.removeIds(ids, { transaction });
    },

    // Consume live input parcels after their replacement has been minted. Original cadastral
    // parcels remain registered (hidden) because they are durable ground facts. Generated parcels
    // are disposable replay output: remove them from every registry instead of retaining a hidden
    // parent chain for some future operation to resurrect.
    _consumeFeaturesFromLiveFabric(features, options = {}) {
        return this._removeFeaturesFromMap(features, options);
    },

    // Async because it is chunked. A replay hands this 3,672 derived pieces in ONE call, and the
    // whole insert — building every Leaflet layer, then adding and indexing each — used to run as
    // a single task. That is the one remaining block big enough to freeze a pan on its own, and no
    // amount of yielding BETWEEN proposals helps when one call inside a proposal is the problem.
    async _addFeaturesToMap(features, useNormalStyle = false, proposalData = null, options = {}) {
        void useNormalStyle;
        void proposalData;
        const list = Array.isArray(features) ? features.filter(Boolean) : [];
        if (!list.length) return [];

        const fabric = (typeof window !== 'undefined' ? window : globalThis).LiveParcelFabric;
        const transaction = options._fabricTransaction;
        if (!fabric || !transaction) {
            throw new Error('Adding live parcels requires an active live-fabric transaction.');
        }

        // Domain code publishes GeoJSON into the draft fabric. Leaflet layers are prepared only
        // when that draft commits, by ParcelPresenter, so no click/pan can observe half an apply.
        fabric.upsertFeatures(list, { transaction, replaceExisting: true });
        return list.map(feature => _getParcelIdFromFeature(feature)).filter(Boolean).map(String);
    },
    // One slice of the bulk insert: unchanged from what the single call did per layer.
    // it is not proposal ancestry and never participates in replay scope or apply order.
    _markParcelProducedByProposal(parcelId, proposalId, options = {}) {
        if (!parcelId || !proposalId) return;
        const normalized = String(proposalId);
        this._upsertParcelProperties(parcelId, props => {
            props.producedByProposalId = normalized;
            delete props.ancestorProposal;
        }, { ...options, persistIfMissing: true });
    },

    _getProposalChildParcels(proposalId, options = {}) {
        const fabric = _liveFabric();
        if (!fabric || typeof fabric.producedBy !== 'function' || typeof fabric.featureId !== 'function') return [];
        return fabric.producedBy(proposalId, {
            transaction: options._fabricTransaction || options.transaction || null
        }).map(feature => fabric.featureId(feature)).filter(Boolean).map(String);
    },

    // Demolition is an apply-time derivation, never authored or imported state. A boot replay passes
    // `preserveAppliedSet`: it may rebuild demolition records, but it never turns another authored
    // proposal on or off. State conflicts are settled by the explicit mutation that created them.
    async _deriveDemolishedBuildings(geometry, options = {}) {
        const browserRoot = typeof window !== 'undefined' ? window : globalThis;
        if (!geometry || !geometry.type || typeof browserRoot.demolishBuildingsUnderFootprint !== 'function') {
            return [];
        }
        const records = await browserRoot.demolishBuildingsUnderFootprint(geometry, options);
        return Array.isArray(records) ? records : [];
    },

    // The only parent resolver used by formation application. The proposal's flat cadastral
    // declaration defines the complete candidate scope. Its authored footprint then selects the
    // current, non-corridor live pieces within that scope and proves coverage. Geometry may never
    // expand or rewrite the durable proposal-to-cadastre relationship.
    _resolveLiveFormationParents(proposalData, idLabel, formationLabel = 'formation', options = {}) {
        const browserRoot = typeof window !== 'undefined' ? window : globalThis;
        const fabric = browserRoot.LiveParcelFabric;
        const order = browserRoot.__planOrder;
        const t = browserRoot.turf || (typeof turf !== 'undefined' ? turf : null);
        const transaction = options && options._fabricTransaction;
        if (!fabric || !order || !t || !transaction
            || typeof fabric.entriesForCadastre !== 'function'
            || typeof order.footprintOf !== 'function'
            || typeof order.computeBaseAncestry !== 'function') {
            const message = `Cannot apply ${formationLabel}: the scoped live-fabric resolver is unavailable.`;
            try { this._setLastApplyFailure(idLabel, { code: 'formation-resolver-unavailable', message }); } catch (_) { }
            return { ok: false, ids: [], features: [], coverage: 0, message };
        }

        const cadastreIds = proposalClaims.cadastreParcelIdsOf(proposalData).map(String).filter(Boolean);
        if (!cadastreIds.length) {
            const message = `Cannot apply ${formationLabel}: the proposal declares no cadastral ground.`;
            try { this._setLastApplyFailure(idLabel, { code: 'formation-cadastre-unresolved', message }); } catch (_) { }
            return { ok: false, ids: [], features: [], cadastreIds: [], coverage: 0, message };
        }

        let footprint = null;
        let candidates = [];
        let hits = [];
        let coverage = 0;
        try {
            footprint = order.footprintOf(proposalData);
            const footprintArea = footprint && typeof t.area === 'function' ? Number(t.area(footprint)) : 0;
            if (!(footprintArea > 0)) throw new Error('authored footprint is empty');
            // entriesForCadastre excludes corridors by default: roads are takes from ground, never
            // host parcels a park/building/readjustment may consume.
            candidates = fabric.entriesForCadastre(cadastreIds, { transaction });
            hits = order.computeBaseAncestry(footprint, candidates.map(feature => ({
                id: String(fabric.featureId(feature)),
                feature
            })));
            const coveredArea = hits.reduce((sum, hit) => sum + (Number(hit.area) || 0), 0);
            coverage = Math.max(0, Math.min(1, coveredArea / footprintArea));
        } catch (error) {
            const message = `Cannot apply ${formationLabel}: cadastral-scope coverage could not be evaluated.`;
            try { this._setLastApplyFailure(idLabel, { code: 'formation-ground-evaluation-failed', message, error: error?.message }); } catch (_) { }
            return { ok: false, ids: [], features: [], cadastreIds, coverage: 0, message };
        }

        const ids = Array.from(new Set(hits.map(hit => String(hit.id || '')).filter(Boolean)));
        if (!ids.length || coverage < 0.95) {
            const message = `The live fabric covers only ${Math.round(coverage * 100)}% of this ${formationLabel}'s footprint; nothing was cut.`;
            try { this._setLastApplyFailure(idLabel, { code: 'formation-ground-unresolved', message, coverage, missingIds: [] }); } catch (_) { }
            try { if (typeof updateStatus === 'function') updateStatus(message); } catch (_) { }
            return { ok: false, ids, features: [], coverage, message };
        }

        const features = fabric.getMany(ids, { transaction, allowMissing: true }).features;
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
                // Live pieces are produced by parcel-arrangement's snapped/retrying clipper. Read
                // them through that SAME clipper here. Calling raw turf.intersect reintroduced the
                // exact sweep-line failure the arrangement engine already hardens against: two
                // honest neighbouring pieces around Sibenik can differ only in their last binary
                // digits, raw polygon-clipping throws, and this guard then calls a valid partition
                // corrupt. The guard remains strict — clip() still throws after all of its measured
                // grids fail — but numerical noise no longer becomes a false refusal.
                const arrangement = (typeof window !== 'undefined') ? window.__parcelArrangement : null;
                const intersectParents = arrangement && typeof arrangement.clip === 'function'
                    ? (left, right) => arrangement.clip('intersect', left, right)
                    : (left, right) => turf.intersect(left, right);
                // Bounding boxes first. Two polygons whose boxes are disjoint CANNOT intersect, so
                // this skips nothing a real overlap could hide behind — it only replaces a boolean
                // op with four number comparisons. Parcels tile the plane, so almost every pair is
                // disjoint: a 661-parcel corridor is 218,130 pairs, of which a few hundred are
                // neighbours. Measured on that corridor, this pass was 3.3 s of a 5.1 s apply.
                const boxes = features.map(feature => {
                    try { return turf.bbox(feature); } catch (_) { return null; }
                });
                const boxesDisjoint = (a, b) => (!!a && !!b)
                    && (a[0] > b[2] || b[0] > a[2] || a[1] > b[3] || b[1] > a[3]);
                for (let i = 0; i < features.length; i += 1) {
                    for (let j = i + 1; j < features.length; j += 1) {
                        if (boxesDisjoint(boxes[i], boxes[j])) continue;
                        const hit = intersectParents(features[i], features[j]);
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

function _resolveRootParcelIdFromProperties(props) {
    const declared = Array.isArray(props?.cadastreParcelIds)
        ? props.cadastreParcelIds.map(value => String(value || '').trim()).filter(Boolean)
        : [];
    if (declared.length) return declared[0];
    if (props?.rootParcelId !== undefined && props?.rootParcelId !== null
        && String(props.rootParcelId).trim()) return String(props.rootParcelId).trim();
    return '';
}

function _resolveRootParcelNumberFromProperties(props) {
    const candidates = [
        props?.rootParcelNumber,
        props?.BROJ_CESTICE,
        props?.parcelNumber,
        props?.parcel_number
    ];

    for (const candidate of candidates) {
        if (candidate !== undefined && candidate !== null && String(candidate).trim()) {
            return String(candidate).trim();
        }
    }
    return '';
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
