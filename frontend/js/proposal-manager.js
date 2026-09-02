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

function _cadastralGroundService() {
    if (typeof CadastralGroundService !== 'undefined' && CadastralGroundService) {
        return CadastralGroundService;
    }
    const root = (typeof window !== 'undefined') ? window : globalThis;
    if (root && root.CadastralGroundService) return root.CadastralGroundService;
    if (typeof require === 'function') {
        return require('./parcels/ground-service.js').CadastralGroundService;
    }
    return null;
}

function _emitProposalProgress(listener, event) {
    if (typeof listener !== 'function') return;
    try { listener(Object.freeze({ ...event })); } catch (_) { /* progress is observational */ }
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
        const browserRoot = typeof window !== 'undefined' ? window : null;
        const presentationSnapshot = mutatesMap
            ? proposalMutationTransactions.snapshotParcelPresentation(browserRoot)
            : null;

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
            if (presentationSnapshot) {
                proposalMutationTransactions.restoreParcelPresentation(browserRoot, presentationSnapshot);
            }
            try {
                if (manager && typeof manager._refreshUIAfterProposalChange === 'function') {
                    manager._refreshUIAfterProposalChange(store && typeof store.getProposal === 'function'
                        ? store.getProposal(proposalId)
                        : null);
                }
            } catch (_) { /* rollback must continue */ }
        });

        const ownsParcelBatch = !!(mutatesMap
            && browserRoot
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

        // Flat anchor: every minted piece records only the original cadastral parcel(s) under it.
        // Immediate live ids are useful while this apply is cutting them, but they are not durable
        // lineage and must not become the next operation's parent chain.
        if ((!Array.isArray(props.baseParcelIds) || !props.baseParcelIds.length) && rootId && rootId !== 'parcel') {
            props.baseParcelIds = [rootId];
        }
        const flatBaseIds = Array.from(new Set((Array.isArray(props.baseParcelIds) ? props.baseParcelIds : [])
            .map(id => formationEdit && typeof formationEdit.baseIdOf === 'function'
                ? formationEdit.baseIdOf(String(id))
                : String(id).split('#')[0])
            .filter(id => id && id !== 'parcel')));
        props.baseParcelIds = flatBaseIds;
        props.parentParcelIds = flatBaseIds.slice();
        props.parentParcelId = flatBaseIds[0] || null;
        const outputProducer = props.proposalId !== undefined && props.proposalId !== null
            ? props.proposalId
            : proposalId;
        if (outputProducer !== undefined && outputProducer !== null) {
            props.producedByProposalId = String(outputProducer);
        }
        // One release-cycle compatibility read remains at display boundaries, but new output never
        // writes the old ancestry key.
        delete props.ancestorProposal;

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
        const formationEdit = (typeof window !== 'undefined') ? window.__formationEdit : null;
        const parentParcelIds = Array.from(new Set((Array.isArray(input.parentFeatures)
            ? input.parentFeatures.map(feature => _getParcelIdFromFeature(feature)).filter(Boolean).map(String)
            : [])
            .map(id => formationEdit && typeof formationEdit.baseIdOf === 'function'
                ? formationEdit.baseIdOf(id)
                : id.split('#')[0])
            .filter(Boolean)));
        let definition = input.definition || {};
        try { definition = JSON.parse(JSON.stringify(definition)); } catch (_) { definition = { ...definition }; }

        const proposalData = {
            type: 'road',
            title: name,
            author: normalizedAuthor,
            description: normalizedDescription,
            proposalId: initialProposalId,
            parentParcelIds,
            cadastreParcelIds: parentParcelIds.slice(),
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
                        const ids = Array.isArray(p.cadastreParcelIds) && p.cadastreParcelIds.length
                            ? p.cadastreParcelIds
                            : (Array.isArray(p.parentParcelIds) ? p.parentParcelIds : []);
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
                    preserveAppliedSet: true
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
            const ids = proposalClaims.baseParcelIdsOf(record);
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

    // Resolve and write the ONE durable land relationship a local proposal record may carry:
    // original cadastral parcel ids. Generated parcel ids are replay output and never survive in
    // any declaration after this point. Geometry is authoritative when it is available; declared
    // ids are only the no-geometry fallback used by non-spatial records and deleted-record seeds.
    _resolveAndStampFlatCadastreAnchors(record) {
        if (!record || typeof record !== 'object') return { baseParcelIds: [], complete: true };
        const browserRoot = typeof window !== 'undefined' ? window : globalThis;
        const ancestry = browserRoot.__cadastreAncestry;
        const order = browserRoot.__planOrder;
        const declared = proposalClaims.baseParcelIdsOf(record);
        let footprint = null;
        try {
            footprint = order && typeof order.footprintOf === 'function'
                ? order.footprintOf(record)
                : null;
        } catch (_) { footprint = null; }

        let baseParcelIds = declared;
        let complete = true;
        if (footprint && footprint.geometry) {
            let resolved = null;
            try {
                resolved = ancestry && typeof ancestry.loadedCadastreCoverage === 'function'
                    ? ancestry.loadedCadastreCoverage(record)
                    : null;
            } catch (_) { resolved = null; }
            const coverage = Number(resolved && resolved.coverage) || 0;
            const geometryIds = Array.isArray(resolved && resolved.ids)
                ? proposalClaims.baseParcelIdsOf({ cadastreParcelIds: resolved.ids })
                : [];
            complete = coverage > FLAT_GROUND_COMPLETE_COVERAGE && geometryIds.length > 0;
            if (complete) baseParcelIds = geometryIds;
        }

        const flat = Array.from(new Set((baseParcelIds || []).map(String).filter(Boolean)));
        if (complete && flat.length) {
            record.cadastreParcelIds = flat.slice();
            record.parentParcelIds = flat.slice();
            ['roadProposal', 'buildingProposal', 'structureProposal', 'reparcellization', 'decideLaterProposal']
                .forEach(key => {
                    const sub = record[key];
                    if (!sub || typeof sub !== 'object' || Array.isArray(sub)) return;
                    sub.parentParcelIds = flat.slice();
                });
            if (record.reparcellization && Array.isArray(record.reparcellization.parcelIds)) {
                record.reparcellization.parcelIds = flat.slice();
            }
        }
        return { baseParcelIds: flat, complete };
    },

    async _flatScopeSeeds(records, extraBaseParcelIds = [], options = {}) {
        const members = (Array.isArray(records) ? records : []).filter(Boolean);
        if (members.length) {
            const groundOptions = {};
            if (typeof options.onProgress === 'function') groundOptions.onProgress = options.onProgress;
            if (options.purpose && options.purpose !== 'application') groundOptions.purpose = options.purpose;
            if (Object.keys(groundOptions).length) await this._loadReplayGround(members, groundOptions);
            else await this._loadReplayGround(members);
        }
        const ids = new Set(proposalClaims.baseParcelIdsOf({ cadastreParcelIds: extraBaseParcelIds }));
        let complete = true;

        members.forEach(record => {
            const resolution = this._resolveAndStampFlatCadastreAnchors(record);
            resolution.baseParcelIds.forEach(id => ids.add(id));
            if (!resolution.complete) complete = false;
        });
        return { baseParcelIds: Array.from(ids), complete };
    },

    // State removal never rediscovers a proposal's land relationship from today's map geometry.
    // The immutable record already carries that relationship as flat original-cadastre ids; those
    // ids are the complete mutation scope even when their layers are currently hidden or have not
    // been materialized. Geometry coverage remains an apply/edit validation concern in _flatScopeSeeds.
    _recordedCadastreScope(records, extraBaseParcelIds = []) {
        const ids = new Set(proposalClaims.baseParcelIdsOf({ cadastreParcelIds: extraBaseParcelIds }));
        (Array.isArray(records) ? records : []).filter(Boolean).forEach(record => {
            proposalClaims.baseParcelIdsOf(record).forEach(id => ids.add(String(id)));
        });
        return { baseParcelIds: Array.from(ids), complete: true };
    },

    // Corridors are geometric takes over whatever current cadastral ground exists; they are not
    // formations that require every square metre of their authored ribbon to have a parcel host.
    // A bridge, shoreline road, cadastral gap, or superseded parcel can therefore leave legitimate
    // uncovered ribbon. Load the footprint, then scope the mutation to the union of its published
    // flat anchors and the current cadastral parcels the loaded geometry actually reaches. Coverage
    // is intentionally not a validity gate here.
    async _corridorScopeSeeds(records, extraBaseParcelIds = [], options = {}) {
        const members = (Array.isArray(records) ? records : []).filter(Boolean);
        if (members.length) {
            const groundOptions = {};
            if (typeof options.onProgress === 'function') groundOptions.onProgress = options.onProgress;
            if (options.purpose && options.purpose !== 'application') groundOptions.purpose = options.purpose;
            if (Object.keys(groundOptions).length) await this._loadReplayGround(members, groundOptions);
            else await this._loadReplayGround(members);
        }
        const ids = new Set(proposalClaims.baseParcelIdsOf({ cadastreParcelIds: extraBaseParcelIds }));
        const browserRoot = (typeof window !== 'undefined') ? window : globalThis;
        const ancestry = browserRoot.__cadastreAncestry;

        members.forEach(record => {
            proposalClaims.baseParcelIdsOf(record).forEach(id => ids.add(String(id)));
            if (!ancestry || typeof ancestry.loadedCadastreCoverage !== 'function') return;
            let resolved = null;
            try { resolved = ancestry.loadedCadastreCoverage(record); } catch (_) { resolved = null; }
            const currentIds = Array.isArray(resolved && resolved.ids) ? resolved.ids : [];
            proposalClaims.baseParcelIdsOf({ cadastreParcelIds: currentIds })
                .forEach(id => ids.add(String(id)));
        });

        return { baseParcelIds: Array.from(ids), complete: true };
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
        if (this._rebuildInProgress) {
            return { ok: false, reentered: true, failed: [] };
        }
        const seeds = (Array.isArray(seedRecords) ? seedRecords : [seedRecords]).filter(Boolean);
        const seedResolution = await this._corridorScopeSeeds(seeds, opts.extraBaseParcelIds || [], opts);
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
        if (this._rebuildInProgress) {
            return { ok: false, reentered: true, failed: [] };
        }

        const seeds = (Array.isArray(seedRecords) ? seedRecords : [seedRecords]).filter(Boolean);
        const seedResolution = await this._flatScopeSeeds(seeds, opts.extraBaseParcelIds || [], opts);
        if (!seedResolution.complete) {
            console.warn('[flat-rematerialize] incomplete local cadastral coverage — mutation refused');
            return {
                ok: false,
                applied: 0,
                failed: [{ reason: 'cadastral ground is incomplete' }],
                baseParcelIds: seedResolution.baseParcelIds,
                proposalIds: []
            };
        }
        return this._rematerializeResolvedScope(seeds, seedResolution, opts);
    },

    // Execute a local mutation after its domain-specific scope resolver has answered. Keeping the
    // resolver outside this method makes the distinction structural: formations prove complete
    // host ground; corridors name the current cadastral parcels reached by their geometry.
    async _rematerializeResolvedScope(seeds, seedResolution, options = {}) {
        const opts = options || {};
        if (!seedResolution.baseParcelIds.length) {
            return { ok: true, applied: 0, failed: [], baseParcelIds: [], proposalIds: [] };
        }

        this._rebuildInProgress = true;
        const hasStorageBatch = typeof proposalStorage !== 'undefined'
            && proposalStorage
            && typeof proposalStorage.beginBatch === 'function'
            && typeof proposalStorage.endBatch === 'function';
        if (hasStorageBatch) proposalStorage.beginBatch();
        try {
            const baseParcelIds = Array.from(new Set(seedResolution.baseParcelIds.map(String).filter(Boolean)));
            _emitProposalProgress(opts.onProgress, {
                phase: 'fabric-scope-ready',
                parcels: baseParcelIds.length,
                members: seeds.length
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

            // Capture standing state before output cleanup clears derived record fields.
            orderedReplay.forEach(record => {
                try { setProposalApplied(record, false, { stamp: false }); } catch (_) { record.applied = false; }
            });
            const removedOutputs = [];
            seedById.forEach(record => removedOutputs.push(this._removeProposalOwnedOutput(record)));

            const fabric = await this._deriveCorridorFabric({
                parcelIds: baseParcelIds,
                takes: this._appliedCorridorTakes(),
                onProgress: opts.onProgress
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
                            deferPresentation: opts.silent === true
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

            if (!failed.length) removedOutputs.forEach(output => this._commitRemovedProposalOutput(output));
            try { if (typeof scheduleCorridorStripRefresh === 'function') scheduleCorridorStripRefresh(); } catch (_) { }
            try { if (typeof syncProposalsIndicator === 'function') syncProposalsIndicator(); } catch (_) { }
            if (opts.deferSave !== true) {
                _emitProposalProgress(opts.onProgress, { phase: 'save' });
                try { if (typeof proposalStorage !== 'undefined' && proposalStorage.save) proposalStorage.save(); } catch (_) { }
            }
            return {
                ok: failed.length === 0,
                applied: appliedCount,
                failed,
                fabric,
                baseParcelIds,
                proposalIds: orderedReplay.map(record => String(record.proposalId))
            };
        } finally {
            this._rebuildInProgress = false;
            if (hasStorageBatch) proposalStorage.endBatch();
        }
    },

    // Fetching cadastral ground and demolition buildings are independent reads, so the latter runs
    // alongside CadastralGroundService. The service is the only owner of ground cache/transport
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
        const service = _cadastralGroundService();
        if (!service || typeof service.ensureProposalGround !== 'function') {
            throw new Error('Cadastral ground service is unavailable.');
        }

        const profile = await service.ensureProposalGround(members, {
            purpose,
            onProgress: options.onProgress
        });
        const elapsed = Number(profile && profile.elapsed) || 0;
        this._lastReplayGroundProfile = profile;
        try {
            console.info(`[cadastralGround:${purpose}] ${members.length} member(s) in ${Math.round(elapsed)} ms`
                + ` — ${Number(profile.coveredMembers) || 0} cached,`
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

            // Anchors were geometry-resolved and stamped before the corridor phase. Assigning all
            // authored plots to each touched base is safe: clipping a parcel by a plot outside it
            // is a no-op, while guessing a plot-to-base relationship from a generated child id
            // would recreate the lineage dependency this materializer is designed to eliminate.
            proposalClaims.baseParcelIdsOf(record).forEach(baseId => {
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
    // anything, and recomputing one parcel cannot disturb another. Scope it with `parcelIds` and it
    // is the incremental path; leave it open and it is the canonical whole-plan derivation — the
    // same function either way, which is what keeps the fast path honest.
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
    // parcel and the takes over it, so a late arrival has the same answer as any other parcel: it
    // just had not been asked yet. Only arrivals a corridor actually reaches are derived, so a pan
    // across empty country costs one overlap test each and nothing more.
    async deriveArrivingParcels(parcelIds) {
        const browserRoot = (typeof window !== 'undefined') ? window : globalThis;
        const A = browserRoot.__parcelArrangement;
        const ancestry = browserRoot.__cadastreAncestry;
        if (!A || !ancestry || typeof ancestry.loadedCadastreParcels !== 'function') return null;
        // A rebuild is already deriving everything; joining in would fight it.
        if (this._rebuildInProgress) return null;

        const arriving = new Set((parcelIds || [])
            .map(id => (id === null || id === undefined) ? '' : String(id))
            .filter(id => id && id.indexOf('#') === -1));
        if (!arriving.size) return null;

        const takes = this._appliedCorridorTakes();
        if (!takes.length) return null;

        // The filter's exact overlaps travel with the scope, so the derivation arranges each
        // arrival from them instead of intersecting the same corridors a second time.
        const hitsById = new Map();
        const scoped = [];
        ancestry.loadedCadastreParcels().forEach(entry => {
            if (!arriving.has(String(entry.id))) return;
            const hits = A.takeHitsOn(entry.feature, takes);
            if (!hits.length) return;
            scoped.push(String(entry.id));
            hitsById.set(String(entry.id), hits);
        });
        if (!scoped.length) return null;

        const fabric = await this._deriveCorridorFabric({ parcelIds: scoped, takes, hitsById });
        if (fabric && fabric.added) {
            try { if (typeof refreshAppliedCorridorStrips === 'function') scheduleCorridorStripRefresh(); } catch (_) { }
        }
        return fabric;
    },

    // Cooperative, and one at a time.
    //
    // The ground under a pan is cut in chunks with a frame handed back between them, so the map
    // answers the mouse while the fabric catches up. A parcel's pieces are a function of that parcel
    // and the takes over it — nothing crosses parcels — so chunking computes exactly what one call
    // computed, in the same order.
    //
    // The moment it yields, another derivation can start: a moveend, a release, a replay. They all
    // mutate parcelLayerById and the map, so two interleaved runs would each see half of the other's
    // work. Hence the queue — which lives in the MODULE, not on `this`, because callers build
    // partial ProposalManager objects (the tests do) and serialisation must not depend on them
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
        const ancestry = browserRoot.__cadastreAncestry;
        if (!A || !ancestry || typeof ancestry.loadedCadastreParcels !== 'function') {
            return { added: 0, removed: 0, unchanged: 0, parcels: 0, parcelIds: [], failed: [] };
        }

        const takes = Array.isArray(options.takes) ? options.takes : this._appliedCorridorTakes(options.appliedList);
        const takeById = new Map(takes.map(take => [take.id, take]));

        const scope = options.parcelIds
            ? new Set(Array.from(options.parcelIds).map(String))
            : null;
        // The exact overlaps the filter below computes, kept for the clip loop. Filtering used to
        // call takesOverlapping and throw the intersections away, so every (parcel × take) exact
        // clip ran twice — once to decide, once to arrange. Half the derivation's turf work was
        // repeats. A scoped caller (deriveArrivingParcels) may hand its own map in the same way.
        const hitsById = (options.hitsById && typeof options.hitsById.get === 'function')
            ? options.hitsById
            : new Map();
        const candidates = ancestry.loadedCadastreParcels();
        const parcels = [];
        _emitProposalProgress(options.onProgress, {
            phase: 'fabric-scan',
            done: 0,
            total: candidates.length
        });
        for (let i = 0; i < candidates.length; i += CHUNK) {
            for (const entry of candidates.slice(i, i + CHUNK)) {
                if (scope) { if (scope.has(String(entry.id))) parcels.push(entry); continue; }
                // Unscoped: only parcels a corridor actually reaches have anything to derive.
                const hits = A.takeHitsOn(entry.feature, takes);
                if (hits.length > 0) {
                    parcels.push(entry);
                    hitsById.set(String(entry.id), hits);
                }
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

        // An untouched parcel comes back as itself; that is the base layer showing, not a piece to
        // mint. Everything else is derived ground.
        const coordinatedGround = typeof this._coordinatedReadjustmentGroundByParcel === 'function'
            ? this._coordinatedReadjustmentGroundByParcel(takes, options.appliedList)
            : new Map();
        if (coordinatedGround.size && typeof A.remaindersOutsideOccupiedGround === 'function') {
            pieces = A.remaindersOutsideOccupiedGround(pieces, coordinatedGround);
        }
        const derived = pieces.filter(piece => piece.id !== piece.parcelId);
        const untouched = new Set(pieces.filter(piece => piece.id === piece.parcelId).map(piece => piece.parcelId));

        // What is on the map right now for the parcels in scope — the arrangement's OWN pieces only.
        // A readjustment's plots and a carved building host are also derived ground under these
        // parcels, and they are not this derivation's to remove: the diff would delete a standing
        // plan's plots the moment a road was drawn across the same parcel.
        const byId = (browserRoot.parcelLayerById instanceof Map) ? browserRoot.parcelLayerById : new Map();
        const currentIds = [];
        byId.forEach((_layer, id) => {
            const key = String(id);
            const root = key.split('#')[0];
            if (key !== root && parcelById.has(root) && A.isPieceId(key)) currentIds.push(key);
        });

        const diff = A.diffPieces(currentIds, derived);
        _emitProposalProgress(options.onProgress, {
            phase: 'map-update',
            added: diff.added.length,
            removed: diff.removed.length,
            parcels: parcels.length
        });

        diff.removed.forEach(id => {
            try { if (typeof browserRoot.removeParcelLayerById === 'function') browserRoot.removeParcelLayerById(id); } catch (_) { }
            try { byId.delete(id); } catch (_) { }
        });

        const features = diff.added.map(piece => {
            const base = parcelById.get(String(piece.parcelId));
            const take = piece.takers.length ? takeById.get(piece.takers[0]) : null;
            return A.featureForPiece(piece, base, {
                isTrack: !!(take && take.isTrack),
                roadName: take ? take.name : null
            });
        }).filter(Boolean);
        if (features.length) await this._addFeaturesToMap(features, true, null);

        // A parcel shows exactly when nothing derived stands on it.
        //
        // Its own pieces are the usual case but not the only one: a readjustment's plots and a
        // building's taken host are derived ground too, and the arrangement model knows nothing
        // about them — takes are roads and tracks. Asking the MAP who claims this parcel covers all
        // three, which is what lets a scoped derivation run on its own. The whole-plan rebuild never
        // needed it: it re-applied every standing record, and each one re-hid its own parents.
        const claimed = this._parcelsClaimedByDerivedGround();
        parcelById.forEach((_feature, id) => {
            const spokenFor = !untouched.has(id) || claimed.has(String(id));
            try {
                if (spokenFor) browserRoot.hideParcelLayerById?.(id);
                else browserRoot.showParcelLayerById?.(id);
            } catch (_) { }
        });

        _emitProposalProgress(options.onProgress, {
            phase: 'fabric-ready',
            parcels: parcels.length,
            added: features.length,
            removed: diff.removed.length
        });

        return {
            added: features.length,
            removed: diff.removed.length,
            unchanged: diff.unchanged.length,
            parcels: parcels.length,
            parcelIds: Array.from(parcelById.keys()),
            failed: failed || []
        };
    },

    // Every original cadastral parcel occupied by live generated output. This is a presentation
    // query over flat base stamps, not a walk through retained parents.
    _parcelsClaimedByDerivedGround() {
        const browserRoot = (typeof window !== 'undefined') ? window : globalThis;
        const byId = (browserRoot.parcelLayerById instanceof Map) ? browserRoot.parcelLayerById : null;
        const live = browserRoot.parcelLayer && typeof browserRoot.parcelLayer.hasLayer === 'function'
            ? browserRoot.parcelLayer
            : null;
        const claimed = new Set();
        if (!byId) return claimed;
        byId.forEach((layer, id) => {
            // A cadastral parcel claims nothing — it IS the ground.
            if (String(id).indexOf('#') === -1) return;
            // Registry membership alone is not presence; only the live layer group occupies ground.
            if (live) {
                try { if (!live.hasLayer(layer)) return; } catch (_) { return; }
            }
            const props = (layer && layer.feature && layer.feature.properties) || {};
            const formationEdit = browserRoot.__formationEdit;
            const anchors = Array.isArray(props.baseParcelIds) && props.baseParcelIds.length
                ? props.baseParcelIds
                : [props.rootParcelId, id];
            anchors.forEach(anchor => {
                if (!anchor) return;
                const base = formationEdit && typeof formationEdit.baseIdOf === 'function'
                    ? formationEdit.baseIdOf(String(anchor))
                    : String(anchor).split('#')[0];
                if (base) claimed.add(String(base));
            });
        });
        return claimed;
    },

    // Remove exactly the disposable output authored by ONE proposal.
    //
    // Cadastral ids are durable anchors, not dependency edges. Sharing one of those anchors with
    // a long corridor does not make every proposal along that corridor part of this mutation. The
    // producer stamp written by _assignSyntheticChildIdentities is the complete ownership boundary
    // for generated parcels; presentation collections carry the same proposalId boundary.
    //
    // Persistent cleanup is returned to the caller and committed only after local ground
    // derivation succeeds. A failed clip can therefore roll the transaction's map/cache snapshot
    // back without discovering that the parcel records were already destroyed underneath it.
    _removeProposalOwnedOutput(record) {
        const browserRoot = (typeof window !== 'undefined') ? window : globalThis;
        if (!record) return { proposalId: '', removedParcelIds: [], ownership: new Map() };
        const proposalId = String(record.proposalId || '');
        if (!proposalId) return { proposalId: '', removedParcelIds: [], ownership: new Map() };

        const byId = browserRoot.parcelLayerById instanceof Map ? browserRoot.parcelLayerById : null;
        const removedParcelIds = [];
        const ownership = new Map();
        if (byId) {
            byId.forEach((layer, layerId) => {
                const id = String(layerId);
                if (id.indexOf('#') === -1) return; // original cadastre is never proposal output
                const props = layer?.feature?.properties || {};
                const producer = String(
                    props.producedByProposalId
                    || props.ancestorProposal // one-release compatibility with old cached output
                    || props.proposalId
                    || ''
                );
                if (producer !== proposalId) return;
                removedParcelIds.push(id);
                try {
                    const owner = (typeof PersistentStorage !== 'undefined')
                        ? PersistentStorage.getItem(`parcel_${id}_owner`)
                        : null;
                    if (owner) ownership.set(id, String(owner));
                } catch (_) { }
            });

            removedParcelIds.forEach(id => {
                try { browserRoot.removeParcelLayerById?.(id); } catch (_) { }
                try { byId.delete(id); } catch (_) { }
                try {
                    const cache = browserRoot.ParcelsState
                        && typeof browserRoot.ParcelsState.getParcelCache === 'function'
                        ? browserRoot.ParcelsState.getParcelCache()
                        : browserRoot.parcelCache;
                    if (cache && cache.byId instanceof Map) cache.byId.delete(id);
                } catch (_) { }
            });
        }

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
        try { if (typeof proposalFeatureCache !== 'undefined') proposalFeatureCache.clear(); } catch (_) { }
        try { if (typeof proposalAreaCache !== 'undefined') proposalAreaCache.clear(); } catch (_) { }

        this._clearDerivedRecordState(record);
        return { proposalId, removedParcelIds, ownership };
    },

    _commitRemovedProposalOutput(removed) {
        if (!removed || !removed.proposalId) return;
        const browserRoot = (typeof window !== 'undefined') ? window : globalThis;
        (removed.removedParcelIds || []).forEach(id => {
            try {
                if (typeof PersistentStorage !== 'undefined') {
                    PersistentStorage.removeItem(`parcel_${id}_owner`);
                }
            } catch (_) { }
            try { if (typeof clearPersistedParcelRecord === 'function') clearPersistedParcelRecord(id); } catch (_) { }
        });
        const affectedAgents = new Set(Array.from((removed.ownership || new Map()).values()));
        affectedAgents.forEach(agentId => {
            try { if (typeof updateAgentOwnedParcels === 'function') updateAgentOwnedParcels(agentId); } catch (_) { }
        });
        try {
            if (typeof PersistentStorage !== 'undefined') {
                if (Array.isArray(browserRoot.parks)) PersistentStorage.setItem('cb_parks', JSON.stringify(browserRoot.parks));
                if (Array.isArray(browserRoot.squares)) PersistentStorage.setItem('cb_squares', JSON.stringify(browserRoot.squares));
                if (Array.isArray(browserRoot.lakes)) PersistentStorage.setItem('cb_lakes', JSON.stringify(browserRoot.lakes));
                if (Array.isArray(browserRoot.transitStations)) {
                    PersistentStorage.setItem('cb_transit_stations', JSON.stringify(browserRoot.transitStations));
                }
            }
        } catch (_) { }
    },

    // Release one proposal from its flat cadastral anchors. The only derived fabric recomputed is
    // the arrangement of those original parcels against the corridor takes that still stand.
    // Other proposals are neither reset nor re-applied, even when a corridor shares one anchor and
    // continues through hundreds of parcels elsewhere.
    async _releaseProposalLocally(record, options = {}) {
        if (!record) return { ok: false, failed: [{ reason: 'missing proposal record' }] };
        const resolved = options.scope || this._recordedCadastreScope([record]);
        const baseParcelIds = Array.from(new Set((resolved.baseParcelIds || []).map(String).filter(Boolean)));
        _emitProposalProgress(options.onProgress, {
            phase: 'unapply-remove-output',
            members: 1,
            parcels: baseParcelIds.length
        });
        const removed = this._removeProposalOwnedOutput(record);
        let fabric = { added: 0, removed: 0, unchanged: 0, parcels: 0, parcelIds: [], failed: [] };
        if (baseParcelIds.length) {
            _emitProposalProgress(options.onProgress, {
                phase: 'unapply-restore-ground',
                members: 1,
                parcels: baseParcelIds.length,
                removedOutput: removed.removedParcelIds.length
            });
            fabric = await this._deriveCorridorFabric({
                parcelIds: baseParcelIds,
                takes: this._appliedCorridorTakes(),
                onProgress: options.onProgress
            });
        }
        if (fabric && Array.isArray(fabric.failed) && fabric.failed.length) {
            return { ok: false, failed: fabric.failed, baseParcelIds, removed };
        }

        // _deriveCorridorFabric normally performs this visibility reconciliation. Keep it explicit
        // for content-only records and test/minimal runtimes where the arrangement engine is not
        // installed: ground is visible exactly when no live generated output claims its base id.
        const browserRoot = (typeof window !== 'undefined') ? window : globalThis;
        const claimed = this._parcelsClaimedByDerivedGround();
        baseParcelIds.forEach(id => {
            try {
                if (claimed.has(String(id))) browserRoot.hideParcelLayerById?.(String(id));
                else browserRoot.showParcelLayerById?.(String(id));
            } catch (_) { }
        });

        const commitOutput = () => this._commitRemovedProposalOutput(removed);
        const transaction = options._mutationTransaction;
        if (proposalMutationTransactions.isActiveTransaction(transaction)) {
            transaction.deferCommit(`remove output for ${removed.proposalId}`, commitOutput);
        } else {
            commitOutput();
        }
        _emitProposalProgress(options.onProgress, {
            phase: 'unapply-ready',
            members: 1,
            parcels: baseParcelIds.length,
            removedOutput: removed.removedParcelIds.length,
            liveParcels: Number(fabric && fabric.parcels) || 0
        });
        return { ok: true, baseParcelIds, removedParcelIds: removed.removedParcelIds, fabric };
    },

    // Roll a failed state switch back, then rematerialise only the explicitly restored records over
    // their old/new cadastral anchors. There is no generated parent to reveal.
    async _restoreAfterFailedApply(proposalId, proposal, switchedAlternatives, restorePreApplyState) {
        restorePreApplyState();
        const seeds = [
            _getProposalRecord(proposalId) || proposal,
            ...(Array.isArray(switchedAlternatives) ? switchedAlternatives : [])
        ];
        const hasCorridor = seeds.some(record => {
            const goalKey = (applyRoute && typeof applyRoute.normalizeGoalKey === 'function')
                ? applyRoute.normalizeGoalKey(record && record.goal)
                : String(record?.goal || '');
            return goalKey === 'road-track' || !!record?.roadProposal;
        });
        const materialize = hasCorridor ? this.rematerializeCorridorScope : this.rematerializeFlatScope;
        await materialize.call(this, seeds, { _fabricQueue: true });
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
        if (targetFailed) {
            try { setProposalApplied(proposal, false, { stamp: false }); } catch (_) { proposal.applied = false; }
            await materialize.call(this, localSeeds, {
                _fabricQueue: true,
                silent: true
            });
            return null;
        }
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

        return this._enqueueFabricChange(async () => {
            const records = [];
            const missingIds = [];
            ids.forEach(id => {
                const record = _getProposalRecord(id);
                const goalKey = record && applyRoute && typeof applyRoute.normalizeGoalKey === 'function'
                    ? applyRoute.normalizeGoalKey(record.goal)
                    : String(record?.goal || '');
                if (!record || goalKey !== 'road-track') missingIds.push(id);
                else records.push(record);
            });
            if (missingIds.length) {
                return { ok: false, appliedIds: [], failedIds: ids, reason: `Missing corridor record(s): ${missingIds.join(', ')}` };
            }
            const tracks = records.filter(record => !!(
                record?.roadProposal?.definition?.metadata?.isTrack
            )).length;
            const roads = Math.max(0, records.length - tracks);
            _emitProposalProgress(options.onProgress, {
                phase: 'corridor-start',
                members: records.length,
                roads,
                tracks
            });

            const prior = new Map(records.map(record => [String(record.proposalId), {
                applied: appliedOf(record),
                hadAppliedAt: Object.prototype.hasOwnProperty.call(record, 'appliedAt'),
                appliedAt: record.appliedAt,
                hadUpdatedAt: Object.prototype.hasOwnProperty.call(record, 'updatedAt'),
                updatedAt: record.updatedAt
            }]));
            try {
                records.forEach(record => {
                    try { setProposalApplied(record, true); } catch (_) { record.applied = true; }
                });
                const derived = await this.rematerializeCorridorScope(records, {
                    _fabricQueue: true,
                    silent: options.deferPresentation === true,
                    deferSave: true,
                    ...(typeof options.onProgress === 'function' ? { onProgress: options.onProgress } : {})
                });
                if (!derived || derived.ok !== true) {
                    throw new Error((derived && derived.failed && derived.failed[0] && derived.failed[0].reason)
                        || 'The corridor ground could not be derived locally.');
                }
                if (options.deferSave !== true) {
                    _emitProposalProgress(options.onProgress, { phase: 'save' });
                    try { if (typeof proposalStorage !== 'undefined' && proposalStorage.save) proposalStorage.save(); } catch (_) { }
                }
                _emitProposalProgress(options.onProgress, {
                    phase: 'corridor-ready',
                    members: records.length,
                    roads,
                    tracks
                });
                return {
                    ok: true,
                    appliedIds: records.map(record => String(record.proposalId)),
                    failedIds: [],
                    scope: derived
                };
            } catch (error) {
                _emitProposalProgress(options.onProgress, { phase: 'rollback', roads, tracks });
                records.forEach(record => {
                    const snapshot = prior.get(String(record.proposalId));
                    if (!snapshot) return;
                    try { setProposalApplied(record, snapshot.applied, { stamp: false }); } catch (_) { record.applied = snapshot.applied; }
                    if (snapshot.hadAppliedAt) record.appliedAt = snapshot.appliedAt;
                    else delete record.appliedAt;
                    if (snapshot.hadUpdatedAt) record.updatedAt = snapshot.updatedAt;
                    else delete record.updatedAt;
                    try {
                        this._setLastApplyFailure(String(record.proposalId), {
                            code: 'corridor-batch-failed',
                            message: String(error && error.message || error)
                        });
                    } catch (_) { }
                });
                try { await this.rematerializeCorridorScope(records, { _fabricQueue: true, silent: true }); }
                catch (rollbackError) { console.error('[materializeCorridorBatch] rollback failed', rollbackError); }
                if (options.deferSave !== true) {
                    try { if (typeof proposalStorage !== 'undefined' && proposalStorage.save) proposalStorage.save(); } catch (_) { }
                }
                return {
                    ok: false,
                    appliedIds: [],
                    failedIds: records.map(record => String(record.proposalId)),
                    reason: String(error && error.message || error)
                };
            }
        });
    },

    async _rebuildPass(appliedList, opts) {
        const resetStarted = _now();
        const passOptions = opts || {};
        this._resetDerivedFabric(appliedList, {
            baseParcelIds: passOptions.baseParcelIds,
            proposalIds: passOptions.resetProposalIds,
            recordsToClear: passOptions.recordsToClear
        });
        const resetMs = _now() - resetStarted;
        _emitProposalProgress(passOptions.onProgress, {
            phase: 'rebuild-reset',
            members: (appliedList || []).length
        });
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
        // Every member's ground is loaded BEFORE anything derives, all of it at once. The fetches
        // are independent reads, and asking for them one member at a time made finishing one road
        // cost a full HTTP round-trip for every proposal already on the map — the cost that grew
        // with the plan, in series, before any geometry ran at all.
        const [groundMs, demolitionBuildings] = await Promise.all([
            this._loadReplayGround(appliedList, { onProgress: passOptions.onProgress, purpose: 'replay' }),
            this._prefetchDemolitionBuildings(appliedList, { onProgress: passOptions.onProgress })
        ]);
        // Establish the flat-record invariant on every successful replay, including boot. This is
        // deliberately in the canonical pass rather than in an editor/import special case: legacy
        // records and corridor records (whose apply is handled as one fabric phase) otherwise keep
        // stale generated ids indefinitely even though the map itself was rebuilt from cadastre.
        if (typeof this._resolveAndStampFlatCadastreAnchors === 'function') {
            (appliedList || []).forEach(record => this._resolveAndStampFlatCadastreAnchors(record));
        }
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
            ...(passOptions.baseParcelIds ? { parcelIds: passOptions.baseParcelIds } : {})
        });
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
                try { setProposalApplied(proposal, true, { stamp: false }); } catch (_) { proposal.applied = true; }
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
                    preserveAppliedSet: passOptions.preserveAppliedSet === true
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
        _emitProposalProgress(passOptions.onProgress, { phase: 'save' });
        try { if (typeof proposalStorage.save === 'function') proposalStorage.save(); } catch (_) { }
        return { ok: failed.length === 0, applied: appliedCount, failed, invalidated: [] };
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
    _resetDerivedFabric(appliedList, options = {}) {
        const browserRoot = typeof window !== 'undefined' ? window : globalThis;
        const formationEdit = browserRoot.__formationEdit;
        const toBaseId = value => {
            if (value === undefined || value === null) return '';
            try {
                return formationEdit && typeof formationEdit.baseIdOf === 'function'
                    ? String(formationEdit.baseIdOf(String(value)) || '')
                    : String(value).split('#')[0];
            } catch (_) { return String(value).split('#')[0]; }
        };
        const scope = options.baseParcelIds
            ? new Set(Array.from(options.baseParcelIds).map(toBaseId).filter(Boolean))
            : null;
        const proposalIds = new Set((Array.isArray(options.proposalIds)
            ? options.proposalIds
            : (scope ? [] : (Array.isArray(appliedList) ? appliedList : [])))
            .map(value => (value && typeof value === 'object') ? value.proposalId : value)
            .filter(value => value !== undefined && value !== null)
            .map(String));
        const layerBaseIds = (layer, id) => {
            const props = layer?.feature?.properties || {};
            const values = [id, props.rootParcelId];
            if (Array.isArray(props.baseParcelIds)) values.push(...props.baseParcelIds);
            return Array.from(new Set(values.map(toBaseId).filter(Boolean)));
        };
        const byId = (browserRoot.parcelLayerById instanceof Map) ? browserRoot.parcelLayerById : null;
        const ownershipAgents = new Set();
        if (byId) {
            const derivedIds = [];
            byId.forEach((layer, id) => {
                const props = layer?.feature?.properties || {};
                const derived = (typeof isSyntheticParcelId === 'function' && isSyntheticParcelId(id))
                    || !!props.producedByProposalId
                    || !!props.ancestorProposal
                    || !!props.syntheticToken;
                if (!derived) return;
                if (scope) {
                    const owner = String(props.producedByProposalId || props.ancestorProposal || props.proposalId || '');
                    const inScope = layerBaseIds(layer, id).some(baseId => scope.has(baseId));
                    if (!inScope && !(owner && proposalIds.has(owner))) return;
                }
                derivedIds.push(String(id));
            });
            derivedIds.forEach(id => {
                try {
                    const owner = (typeof PersistentStorage !== 'undefined')
                        ? PersistentStorage.getItem(`parcel_${id}_owner`)
                        : null;
                    if (owner) ownershipAgents.add(String(owner));
                    if (typeof PersistentStorage !== 'undefined') PersistentStorage.removeItem(`parcel_${id}_owner`);
                } catch (_) { }
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
            // The cadastre is the ground fact — everything in the reset scope shows.
            byId.forEach((layer, id) => {
                if (String(id).indexOf('#') !== -1) return;
                if (scope && !scope.has(toBaseId(id))) return;
                try { if (typeof browserRoot.showParcelLayerById === 'function') browserRoot.showParcelLayerById(String(id)); } catch (_) { }
            });
        }

        // Structure/building collections are presentation caches of applied records, just like
        // derived parcel layers. Clear only proposal-authored entries; surveyed/base features stay.
        const resetCollection = (name, storageKey) => {
            if (!Array.isArray(browserRoot[name])) return;
            browserRoot[name] = browserRoot[name].filter(feature => {
                const owner = feature?.properties?.proposalId;
                if (!owner) return true;
                return scope ? !proposalIds.has(String(owner)) : false;
            });
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
        (Array.isArray(options.recordsToClear) ? options.recordsToClear : (Array.isArray(appliedList) ? appliedList : []))
            .forEach(proposal => this._clearDerivedRecordState(proposal));

        // Derived ownership is output state too. Removing a child removes its key, then one scan
        // reconciles the affected agents after the replay writes whichever children still exist.
        ownershipAgents.forEach(agentId => {
            try { if (typeof updateAgentOwnedParcels === 'function') updateAgentOwnedParcels(agentId); } catch (_) { }
        });
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
                // Visibility is regenerated from live proposal-owned output, not persisted lineage.
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

                // Clicking Apply chooses this proposal over any currently-standing alternative.
                // Keep a complete record snapshot until the canonical replay proves that choice can
                // stand; if it cannot, restore both sides rather than leaving half of a switch.
                const recordSnapshot = proposalStorage.proposals instanceof Map
                    ? proposalMutationTransactions.snapshotRecordMap(proposalStorage.proposals)
                    : null;
                let switchedAlternatives = [];
                const parkedFootprints = [];
                const fallbackStates = [];
                const restorePreApplyState = () => {
                    if (recordSnapshot && proposalStorage.proposals instanceof Map) {
                        proposalMutationTransactions.restoreRecordMap(proposalStorage.proposals, recordSnapshot);
                    } else {
                        setProposalApplied(proposal, false, { stamp: false });
                        fallbackStates.forEach(({ record, appliedAt, hadAppliedAt }) => {
                            setProposalApplied(record, true, { stamp: false });
                            if (hadAppliedAt) record.appliedAt = appliedAt;
                        });
                    }
                    proposalStorage.save?.();
                };

                // Applying is a record flip followed by a derivation of the ground that changed —
                // the same one an edit and a fresh create use. Alternatives are parked as record
                // flips in the same state transaction, and their payload comes off the map with
                // them; no external caller stamps into the current map.
                const marked = await _runProposalMutationBoundary(
                    this,
                    'apply-state',
                    proposalId,
                    applyOptions,
                    () => {
                        switchedAlternatives = this._collectAppliedAlternativesForExplicitApply(proposal);
                        switchedAlternatives.forEach(alternative => {
                            fallbackStates.push({
                                record: alternative,
                                hadAppliedAt: Object.prototype.hasOwnProperty.call(alternative, 'appliedAt'),
                                appliedAt: alternative.appliedAt
                            });
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
                        proposalStorage.save?.();
                        return true;
                    }
                );
                if (marked !== true) return false;

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

                try {
                    // Already inside the fabric queue, so the derivation runs here rather than
                    // enqueueing behind the operation it is part of.
                    const derived = await this.deriveForNewProposal(proposal, {
                        _fabricQueue: true,
                        supersededFootprints: parkedFootprints,
                        supersededRecords: switchedAlternatives
                    });
                    const refreshed = _getProposalRecord(proposalId) || proposal;
                    const standing = !!derived && ((typeof isProposalCurrentlyApplied === 'function')
                        ? isProposalCurrentlyApplied(refreshed)
                        : appliedOf(refreshed));
                    if (!standing) {
                        await this._restoreAfterFailedApply(proposalId, proposal, switchedAlternatives, restorePreApplyState);
                        this._refreshUIAfterProposalChange(_getProposalRecord(proposalId) || proposal);
                        return false;
                    }
                } catch (error) {
                    try {
                        await this._restoreAfterFailedApply(proposalId, proposal, switchedAlternatives, restorePreApplyState);
                    } catch (restoreError) {
                        console.error('[applyProposal] could not re-derive the pre-apply state after failure', restoreError);
                    }
                    throw error;
                }
                try { proposalStorage.save?.(); } catch (_) { }
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
        const suppliedTransaction = proposalMutationTransactions.isActiveTransaction(options._mutationTransaction);
        if (!suppliedTransaction && options.skipRebuild !== true && !this._rebuildInProgress) {
            return this._enqueueFabricChange(async () => {
                const seed = _getProposalRecord(proposalId);
                if (!seed) return false;
                const startedAt = _now();
                const label = _getProposalApplyLabel(proposalId, seed);
                const kind = _proposalApplyKind(seed);
                let releaseSummary = null;
                let restorationError = null;

                // The record is the authority for WHAT changes. Unapply never asks current map
                // geometry to prove that the proposal is allowed to stop standing; it captures the
                // proposal's flat cadastral anchors before clearing disposable derived fields.
                const scope = this._recordedCadastreScope([seed]);

                _emitProposalProgress(options.onProgress, {
                    phase: 'unapply-start',
                    proposalId: String(proposalId),
                    label,
                    kind
                });

                // Phase one is only the authored proposal-state mutation. It commits independently
                // of presentation/fabric repair, so a missing layer can never silently re-apply the
                // proposal the user just unapplied.
                const changed = await _runProposalMutationBoundary(
                    this,
                    'unapply-state',
                    proposalId,
                    { ...options, _mapMutation: false },
                    (_transaction, transactionOptions) => this._unapplyProposalTransactionBody(proposalId, transactionOptions)
                );
                if (changed !== true) return changed;

                // Phase two is the map/fabric system reacting to the state change. It asks the one
                // cadastral-ground service to make the recorded ids available, then restores parcel
                // borders on only that scope. Its transaction starts from the already-unapplied
                // record, so rollback can repair a failed map mutation without undoing phase one.
                if (scope.baseParcelIds.length) {
                    try {
                        await this._loadReplayGround([seed], {
                            onProgress: options.onProgress,
                            purpose: 'unapply'
                        });
                        const groundProfile = this._lastReplayGroundProfile;
                        const unavailable = Number(groundProfile?.unavailableMembers) || 0;
                        const missing = Array.isArray(groundProfile?.missingIds) ? groundProfile.missingIds.length : 0;
                        if (unavailable || missing) {
                            restorationError = new Error(`${Math.max(unavailable, missing)} cadastral parcel request(s) remain unavailable`);
                        }
                    } catch (error) {
                        restorationError = error;
                    }
                }
                try {
                    const restored = await _runProposalMutationBoundary(
                        this,
                        'unapply-restore',
                        proposalId,
                        options,
                        async transaction => {
                            const released = await this._releaseProposalLocally(seed, {
                                scope,
                                onProgress: options.onProgress,
                                _mutationTransaction: transaction
                            });
                            releaseSummary = released;
                            return released && released.ok === true;
                        }
                    );
                    if (restored !== true) restorationError = new Error('local parcel restoration returned false');
                } catch (error) {
                    restorationError = error;
                }

                if (restorationError) {
                    console.warn(`[unapplyProposal] ${kind} ${label} is unapplied; local parcel restoration is pending`, restorationError);
                    _emitProposalProgress(options.onProgress, {
                        phase: 'unapply-restoration-failed',
                        proposalId: String(proposalId),
                        label,
                        kind,
                        reason: String(restorationError.message || restorationError)
                    });
                }

                this._refreshUIAfterProposalChange(_getProposalRecord(proposalId));
                const elapsed = _now() - startedAt;
                console.info(`[unapplyProposal] Unapplied ${kind} ${label} — ${Math.round(elapsed)} ms`
                    + ` · ${scope.baseParcelIds.length} cadastral parcel(s)`
                    + ` · removed ${releaseSummary?.removedParcelIds?.length || 0} generated parcel(s)`
                    + ` · restored ${Number(releaseSummary?.fabric?.parcels) || 0} live parcel piece(s)`
                    + (restorationError ? ' · parcel restoration pending' : ''));
                return true;
            });
        }
        const result = await _runProposalMutationBoundary(this, 'unapply', proposalId, {
            ...options,
            _mapMutation: false
        }, (_transaction, transactionOptions) => (
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

        // This transaction changes authored state only. A direct user action separately asks the
        // local fabric restorer to remove proposal-owned output on the recorded cadastral anchors;
        // nested/replay callers already have an enclosing materialization for that presentation work.
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
        const scope = wasApplied && !this._rebuildInProgress
            ? this._recordedCadastreScope([proposalData])
            : { complete: true, baseParcelIds: [] };

        // Delete is the same local mutation as unapply, followed by removing the authored record.
        // Keep both inside one transaction so a failed local clip restores record, layers, caches,
        // and presentation collections without a whole-plan replay.
        const deleted = await _runProposalMutationBoundary(
            this,
            'delete-local',
            proposalId,
            options,
            async transaction => {
                proposalStorage.removeProposal(proposalId);
                if (!wasApplied || this._rebuildInProgress) return true;
                const released = await this._releaseProposalLocally(proposalData, {
                    scope,
                    _mutationTransaction: transaction
                });
                return released && released.ok === true;
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

    // Consume live input parcels after their replacement has been minted. Original cadastral
    // parcels remain registered (hidden) because they are durable ground facts. Generated parcels
    // are disposable replay output: remove them from every registry instead of retaining a hidden
    // parent chain for some future operation to resurrect.
    _consumeFeaturesFromLiveFabric(features) {
        if (!features || !Array.isArray(features)) {
            return;
        }
        const browserRoot = typeof window !== 'undefined' ? window : globalThis;
        const byId = browserRoot.parcelLayerById instanceof Map ? browserRoot.parcelLayerById : null;
        const ownershipAgents = new Set();
        features.forEach(feature => {
            const parcelId = _getParcelIdFromFeature(feature);
            if (parcelId === undefined || parcelId === null) return;
            const id = String(parcelId);
            const props = feature?.properties || {};
            const generated = id.includes('#') || !!props.producedByProposalId
                || !!props.ancestorProposal || !!props.syntheticToken;
            if (!generated) {
                try { browserRoot.hideParcelLayerById?.(id); } catch (_) { }
                return;
            }

            try {
                const owner = (typeof PersistentStorage !== 'undefined')
                    ? PersistentStorage.getItem(`parcel_${id}_owner`)
                    : null;
                if (owner) ownershipAgents.add(String(owner));
                if (typeof PersistentStorage !== 'undefined') PersistentStorage.removeItem(`parcel_${id}_owner`);
            } catch (_) { }
            try { browserRoot.removeParcelLayerById?.(id); } catch (_) { }
            try { if (byId) byId.delete(id); } catch (_) { }
            try {
                const cache = browserRoot.ParcelsState && typeof browserRoot.ParcelsState.getParcelCache === 'function'
                    ? browserRoot.ParcelsState.getParcelCache()
                    : browserRoot.parcelCache;
                if (cache && cache.byId instanceof Map) cache.byId.delete(id);
            } catch (_) { }
            try { if (typeof clearPersistedParcelRecord === 'function') clearPersistedParcelRecord(id); } catch (_) { }
        });
        ownershipAgents.forEach(agentId => {
            try { if (typeof updateAgentOwnedParcels === 'function') updateAgentOwnedParcels(agentId); } catch (_) { }
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

    // Async because it is chunked. A replay hands this 3,672 derived pieces in ONE call, and the
    // whole insert — building every Leaflet layer, then adding and indexing each — used to run as
    // a single task. That is the one remaining block big enough to freeze a pan on its own, and no
    // amount of yielding BETWEEN proposals helps when one call inside a proposal is the problem.
    async _addFeaturesToMap(features, useNormalStyle = false, proposalData = null) {
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

                // In slices, with a frame handed back between them. The L.geoJSON container is
                // transient — every layer is moved into window.parcelLayer individually and the
                // container itself is discarded — so building it in pieces produces exactly the
                // layers one call produced, in the same order.
                const BULK_SLICE = 100;
                const sliceStartedAt = () => ((typeof performance !== 'undefined' && performance.now)
                    ? performance.now() : Date.now());
                let heldSince = sliceStartedAt();
                // Redraws held for the whole insert: each addLayer otherwise schedules a repaint
                // per frame, so a 3,672-piece insert repainted its dirtied region once per slice.
                // The dirty rect keeps growing under the hold and ONE repaint covers it on release;
                // pan/zoom repaints bypass the hold entirely. Released in a finally — a hold left
                // behind silently swallows every later add-triggered repaint in the session.
                const renderer = (typeof window !== 'undefined' && window.parcelCanvasRenderer)
                    ? window.parcelCanvasRenderer() : null;
                const canHold = renderer && typeof renderer.holdRedraws === 'function';
                if (canHold) renderer.holdRedraws();
                try {
                    for (let cursor = 0; cursor < bulkCandidates.length; cursor += BULK_SLICE) {
                        const slice = { type: 'FeatureCollection', features: bulkCandidates.slice(cursor, cursor + BULK_SLICE) };
                        this._addBulkSlice(slice, { styleFn, onEachFeature, mapById, indexParcelLayer });
                        // On the clock, not on the slice count: a slice of a hundred simple pieces
                        // is nothing, a hundred complex ones is a frame, and only the clock knows
                        // which this was.
                        if (sliceStartedAt() - heldSince >= 12) {
                            if (typeof window !== 'undefined' && typeof window.yieldToBrowser === 'function') {
                                await window.yieldToBrowser();
                            }
                            heldSince = sliceStartedAt();
                        }
                    }
                } finally {
                    if (canHold) renderer.releaseRedraws();
                }
            } catch (err) {
                console.warn('[_addFeaturesToMap] Bulk add failed, falling back to per-feature path', err);
            }
        }

        // Handle remaining features (tracks, or all if no bulk add)
        const featuresToProcess = canBulkAdd ? trackFeatures : features;
        // Tracks (and everything, when the bulk path did not run) keep the per-feature path: a
        // handful of features per proposal, each needing its own styling. Left INLINE — it reads
        // half a dozen consts from this scope (trackPolygonStyle, the proposal styles, the SVG
        // pattern defs), and extracting it put those out of reach.
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
                    renderer: (typeof window !== 'undefined' && window.parcelCanvasRenderer)
                        ? window.parcelCanvasRenderer() : undefined,
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
                    // Behind a flag because this is PER FEATURE: a pan that lands 45 track pieces
                    // makes 45 console calls, each serialising an object for DevTools, and the panel
                    // renders every one. With the console open — which is when anyone is looking at
                    // performance — that is a real cost paid on every pan, for a line nobody reads
                    // unless they are debugging tracks. window.DEBUG_TRACK_LAYERS = true to see them.
                    if (typeof window !== 'undefined' && window.DEBUG_TRACK_LAYERS === true) {
                        console.debug('[_addFeaturesToMap] track layer created', {
                            parcelId,
                            hasTrackStyle: Boolean(layer._trackStyle),
                            isTrackProp: layer?.feature?.properties?.isTrack
                        });
                    }
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
                    renderer: (typeof window !== 'undefined' && window.parcelCanvasRenderer)
                        ? window.parcelCanvasRenderer() : undefined,
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

                    // The hatch for proposed roads is an SVG pattern fill, and parcels now render
                    // on a canvas, where there is no element to fill and no <defs> to point at. The
                    // `layer._path` guard means this simply does nothing rather than throwing — but
                    // it does nothing, so a proposed road parcel is no longer hatched. It is still
                    // distinguished by its own fill from styleFn, and the corridor's own surface is
                    // drawn separately by corridor-render.js.
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

    // One slice of the bulk insert: unchanged from what the single call did per layer.
    _addBulkSlice(featureCollection, { styleFn, onEachFeature, mapById, indexParcelLayer }) {
        {
            {
                const geoJsonLayer = L.geoJSON(featureCollection, {
                    // Derived pieces go on the same shared canvas as the cadastre they were cut
                    // from — see parcels/ingest.js. After a plan of 130 roads these ARE most of the
                    // fabric, so leaving them in the SVG would leave the pan choppy.
                    renderer: (typeof window !== 'undefined' && window.parcelCanvasRenderer)
                        ? window.parcelCanvasRenderer() : undefined,
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
            }
        }
    },


    // One-hop provenance for disposable output. This is used by click/ownership presentation only;
    // it is not proposal ancestry and never participates in replay scope or apply order.
    _markParcelProducedByProposal(parcelId, proposalId) {
        if (!parcelId || !proposalId) return;
        const normalized = String(proposalId);
        this._upsertParcelProperties(parcelId, props => {
            props.producedByProposalId = normalized;
            delete props.ancestorProposal;
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
