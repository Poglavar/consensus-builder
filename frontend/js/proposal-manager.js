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

// Many footprints as ONE geometry, without unioning them.
//
// The replay needs the ground under every member, and asking per member is 165 round trips that
// mostly re-fetch each other's parcels — adjacent proposals share ground, and the client remembers
// per PROPOSAL, not per parcel. One MultiPolygon asks the same question once.
//
// Deliberately not turf.union: a union of 165 scattered polygons is expensive, can fail on
// self-touching input, and buys nothing. The server runs ST_MakeValid and ST_Subdivide over
// whatever arrives, and DISTINCTs the parcels it finds, so overlapping parts are already handled —
// and a MultiPolygon of disjoint pieces subdivides BETTER than one welded blob would.
function _multiPolygonOfFootprints(footprints) {
    const polygons = [];
    (Array.isArray(footprints) ? footprints : []).forEach(entry => {
        const geometry = entry && (entry.type === 'Feature' ? entry.geometry : entry);
        if (!geometry || !Array.isArray(geometry.coordinates)) return;
        if (geometry.type === 'Polygon') polygons.push(geometry.coordinates);
        else if (geometry.type === 'MultiPolygon') geometry.coordinates.forEach(part => polygons.push(part));
    });
    return polygons.length ? { type: 'MultiPolygon', coordinates: polygons } : null;
}

function _announceApply(message) {
    if (typeof updateStatus !== 'function') return;
    try { updateStatus(message); } catch (_) { }
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
async function _runProposalApplyWithSummary(proposalId, proposalData, runApply) {
    const label = _getProposalApplyLabel(proposalId, proposalData);
    const kind = _proposalApplyKind(proposalData);
    _announceApply(`Applying ${kind} ${label}...`);
    try {
        const result = await runApply();
        if (result === false) {
            console.warn(`Applying proposal ${label} ... failed`);
            _announceApply(`Could not apply ${kind} ${label}`);
            return false;
        }
        console.log(`Applying proposal ${label} ... done`);
        _announceApply(`Applied ${kind} ${label}`);
        return result;
    } catch (error) {
        console.warn(`Applying proposal ${label} ... failed`);
        _announceApply(`Could not apply ${kind} ${label}`);
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

// How many members of a replay may have their ground fetched at once. High enough that a plan of
// twenty roads costs roughly one round-trip of wall clock instead of twenty; low enough not to trip
// the API's rate limiter or open a connection per proposal.
const REPLAY_GROUND_CONCURRENCY = 6;
// How many member footprints ride in one /parcels/under request. Measured against the real API:
// 20 footprints → one request, 0.61 s, 840 parcels, where the same 20 asked one at a time cost 20
// requests and 5.7 s. Bounded rather than "all of them" because the endpoint refuses an over-cap
// result only AFTER doing the work, so an oversized ask is paid for and thrown away.
const REPLAY_GROUND_BATCH_SIZE = 20;

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

            let summary = { ok: true, applied: 0, failed: [] };
            // A severance or demolition can park an earlier record while a pass is running.
            // That invalidates the prefix already stamped on the map, so derive again from the
            // cadastre with the now-smaller applied set. These changes are monotonic; at most one
            // record can disappear per extra pass.
            const maxPasses = Math.max(2, appliedNow().length + 1);
            let passesRun = 0;
            const runPasses = async () => {
                for (let pass = 0; pass < maxPasses; pass += 1) {
                    this._severedThisRebuild = [];
                    this._replayInvalidated = false;
                    passesRun += 1;
                    summary = await this._rebuildPass(appliedNow(), opts);
                    if (!this._severedThisRebuild.length && !this._replayInvalidated) break;
                    console.info('[rebuildAppliedFabric] applied set changed during replay — deriving again', {
                        severed: this._severedThisRebuild.slice()
                    });
                }
            };
            // One redraw of the proposed buildings for the whole replay instead of one per member.
            // Rebuilding that layer redraws every building already on it, so leaving it unheld makes
            // the replay quadratic in its own output.
            const holdBuildings = (typeof window !== 'undefined')
                ? window.withProposedBuildingsRefreshHeld
                : null;
            if (typeof holdBuildings === 'function') await holdBuildings(runPasses);
            else await runPasses();

            const stripsStarted = _now();
            try { if (typeof refreshAppliedCorridorStrips === 'function') refreshAppliedCorridorStrips(); } catch (_) { }
            try { if (typeof syncProposalsIndicator === 'function') syncProposalsIndicator(); } catch (_) { }
            // Built by _rebuildPass; defaulted here so a caller that supplies its own pass (tests
            // do) is not broken by the reporting.
            const profile = this._lastRebuildProfile || { members: 0, resetMs: 0, groundMs: 0, foldMs: 0, failed: 0, slowest: null };
            profile.stripsMs = _now() - stripsStarted;
            profile.passes = passesRun;
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
                    + ` (${REPLAY_GROUND_CONCURRENCY} at a time) · replay ${Math.round(p.foldMs)}`
                    + ` · strips ${Math.round(p.stripsMs)}${cut}${worst}`
                    + `${p.passes > 1 ? ` · ${p.passes} passes` : ''}${p.failed ? ` · ${p.failed} set aside` : ''}`);
            } catch (_) { }
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
            // In `finally`, so a derivation that throws does not leave the bar spinning for ever.
            try { if (typeof spinnerHeld === 'function') spinnerHeld(); } catch (_) { }
        }
    },

    // The ground a whole replay stands on, fetched concurrently. Bounded: the API is rate-limited
    // and a big plan fanning out unbounded is a self-inflicted burst. Returns the wall-clock cost so
    // the caller can say where a slow rebuild went.
    //
    // The derive is geometric against LOADED fabric — coverage must not depend on where the viewport
    // happens to be. So the database is asked for the ground each member covers, by its FOOTPRINT.
    //
    // That used to be two approximations and both failed on a long line: a list of declared ids,
    // only as good as whatever the record happened to say, and then the footprint's BOUNDING BOX for
    // anything the list missed. The imported 17 km track occupies 9.35 ha in a 56.6 km² box — 605× —
    // so the box asked for 37,164 parcels to find the 661 actually under it, ingested ~98,000 layers,
    // and the tab never came back. /parcels/under asks the real question and subdivides the geometry
    // so the spatial index is not defeated by the same diagonal: 661 parcels, 618 ms.
    async _loadReplayGround(appliedList) {
        const members = (Array.isArray(appliedList) ? appliedList : []).filter(Boolean);
        if (!members.length) return 0;
        const started = (typeof performance !== 'undefined') ? performance.now() : 0;

        const loadOne = async proposal => {
            const key = (typeof getProposalKey === 'function' && getProposalKey(proposal)) || proposal.proposalId;
            // Ground already fetched stays on the map — a consumed parcel is hidden, never removed
            // from the registry, and a reset puts it back. So the answer cannot change, and asking
            // again is a round-trip per member per rebuild for nothing. Only a SUCCESSFUL fetch is
            // remembered, so a network failure or a 429 retries on the next rebuild instead of
            // leaving a formation permanently short of the ground it needs.
            const memo = String(proposal.proposalId || key || '');
            if (memo && this._replayGroundFetched.has(memo)) return;
            try {
                const planOrderApi = (typeof window !== 'undefined') ? window.__planOrder : null;
                const footprint = (planOrderApi && typeof planOrderApi.footprintOf === 'function')
                    ? planOrderApi.footprintOf(proposal) : null;
                let loaded = null;
                if (footprint && typeof fetchParcelsUnderGeometry === 'function') {
                    loaded = await fetchParcelsUnderGeometry(footprint);
                }
                if (!loaded) {
                    // No footprint to ask about, or the endpoint is unavailable: fall back to the
                    // declared ids. Never to a bounding box.
                    const fe = (typeof window !== 'undefined') ? window.__formationEdit : null;
                    const groundIds = Array.from(new Set([
                        ...(Array.isArray(proposal.cadastreParcelIds) ? proposal.cadastreParcelIds : []),
                        ...(Array.isArray(proposal.parentParcelIds) ? proposal.parentParcelIds : [])
                            .map(id => (fe && typeof fe.baseIdOf === 'function') ? fe.baseIdOf(String(id)) : String(id))
                    ].map(String).filter(Boolean)));
                    if (groundIds.length && typeof fetchParcelsForIds === 'function') {
                        await fetchParcelsForIds(groundIds);
                    }
                }
                if (memo) this._replayGroundFetched.add(memo);
            } catch (fetchError) {
                console.warn('[rebuildAppliedFabric] ground fetch failed for', key, fetchError);
            }
        };

        // This used to be the longest silence in a reload: one /parcels/under round trip per member,
        // six at a time. On a 165-proposal plan that was ~7 s — and mostly the SAME parcels over and
        // over, because adjacent proposals share ground while the memo above is per proposal.
        //
        // So the whole replay asks once. Every pending member's footprint goes into one MultiPolygon
        // and the server answers with the union of the parcels under all of them, DISTINCT. The
        // per-member path stays as the fallback for anything the batch could not carry.
        const memoOf = proposal => String(proposal.proposalId
            || ((typeof getProposalKey === 'function' && getProposalKey(proposal)) || '') || '');
        const pendingMembers = members.filter(proposal => {
            const memo = memoOf(proposal);
            return !memo || !this._replayGroundFetched.has(memo);
        });
        if (!pendingMembers.length) return _now() - started;
        _announceApply(`Loading ground for ${pendingMembers.length} proposal${pendingMembers.length === 1 ? '' : 's'}...`);

        const planOrderApi = (typeof window !== 'undefined') ? window.__planOrder : null;
        const batchable = [];
        const rest = [];
        pendingMembers.forEach(proposal => {
            let footprint = null;
            try {
                footprint = (planOrderApi && typeof planOrderApi.footprintOf === 'function')
                    ? planOrderApi.footprintOf(proposal) : null;
            } catch (_) { footprint = null; }
            if (footprint && footprint.geometry) batchable.push({ proposal, footprint });
            else rest.push(proposal);
        });

        // Over the server's parcel cap, or a transport failure: halve and retry. A single member
        // that still fails on its own is left to the per-member path, so one bad footprint can
        // never cost the whole replay its ground.
        // What the load actually did, printed once at the end. A reload that takes an unexpected
        // number of seconds is otherwise unanswerable: the difference between "one slow request",
        // "a hundred fast ones" and "a refusal that split and retried" is invisible from a duration.
        const profile = { requests: 0, parcels: 0, serverMs: 0, slowestMs: 0, slowest: null, refused: [], failed: 0 };

        const loadBatch = async entries => {
            if (!entries.length) return;
            const geometry = _multiPolygonOfFootprints(entries.map(entry => entry.footprint));
            if (!geometry || typeof fetchParcelsUnderGeometry !== 'function') return;
            const askStarted = _now();
            try {
                const loaded = await fetchParcelsUnderGeometry(geometry);
                const took = _now() - askStarted;
                profile.requests += 1;
                if (took > profile.slowestMs) { profile.slowestMs = took; profile.slowest = entries.length; }
                if (!loaded) return;
                profile.parcels += Number(loaded.count) || 0;
                profile.serverMs += Number(loaded.queryMs) || 0;
                entries.forEach(entry => {
                    const memo = memoOf(entry.proposal);
                    if (memo) this._replayGroundFetched.add(memo);
                });
            } catch (error) {
                const took = _now() - askStarted;
                profile.requests += 1;
                if (took > profile.slowestMs) { profile.slowestMs = took; profile.slowest = entries.length; }
                // A 413 is the endpoint saying the ask was too big — the one failure that a split
                // actually fixes. Recorded distinctly, because "it split and retried" is a very
                // different story from "the network dropped".
                const overCap = /\b413\b/.test(String(error && error.message));
                if (overCap) profile.refused.push(entries.length);
                else profile.failed += 1;
                if (entries.length > 1) {
                    const mid = Math.ceil(entries.length / 2);
                    await loadBatch(entries.slice(0, mid));
                    await loadBatch(entries.slice(mid));
                    return;
                }
                console.warn('[replayGround] batched ground fetch failed for',
                    memoOf(entries[0].proposal), error);
            }
        };

        // Chunked, NOT one request for the entire plan.
        //
        // /parcels/under refuses a result over its parcel cap — and it refuses AFTER running the
        // whole query and building the whole response, so an over-cap attempt costs full price for
        // nothing. One request carrying every footprint of a large plan is exactly that: it covers
        // the whole city, blows the cap, and the halve-and-retry above then pays that price again
        // for each half, sequentially. A plan that used to load in seconds appeared to hang.
        //
        // So the batch is bounded at a size measured to be comfortable (20 footprints ≈ 0.6 s,
        // ~840 parcels), and the chunks run over the same lanes the per-member path used. 165
        // members become ~9 requests instead of 165 — the win — with no attempt ever near the cap.
        const chunks = [];
        for (let index = 0; index < batchable.length; index += REPLAY_GROUND_BATCH_SIZE) {
            chunks.push(batchable.slice(index, index + REPLAY_GROUND_BATCH_SIZE));
        }
        let chunkCursor = 0;
        const chunkWorker = async () => {
            while (chunkCursor < chunks.length) await loadBatch(chunks[chunkCursor++]);
        };
        if (chunks.length) {
            const chunkLanes = Math.min(REPLAY_GROUND_CONCURRENCY, chunks.length);
            await Promise.all(Array.from({ length: chunkLanes }, chunkWorker));
        }

        // Whatever the batch did not cover — no readable footprint, or a member whose own request
        // failed — goes through the original per-member path, unchanged.
        const remaining = pendingMembers.filter(proposal => {
            const memo = memoOf(proposal);
            return !memo || !this._replayGroundFetched.has(memo);
        });
        let next = 0;
        const worker = async () => {
            while (next < remaining.length) await loadOne(remaining[next++]);
        };
        const lanes = Math.min(REPLAY_GROUND_CONCURRENCY, Math.max(1, remaining.length));
        if (remaining.length) await Promise.all(Array.from({ length: lanes }, worker));

        const elapsed = _now() - started;
        try {
            console.info(`[replayGround] ${pendingMembers.length} member(s) in ${Math.round(elapsed)} ms`
                + ` — ${profile.requests} batched request(s), ${profile.parcels} parcel(s),`
                + ` server ${Math.round(profile.serverMs)} ms, slowest ${Math.round(profile.slowestMs)} ms`
                + ` (${profile.slowest} footprint(s))`
                + (profile.refused.length ? ` · REFUSED over cap: ${profile.refused.join(', ')} footprint(s)` : '')
                + (profile.failed ? ` · ${profile.failed} failed` : '')
                + (remaining.length ? ` · ${remaining.length} fell back to per-member` : ''));
        } catch (_) { }
        _announceApply(`Ground loaded for ${pendingMembers.length} proposal${pendingMembers.length === 1 ? '' : 's'}`
            + ` (${(elapsed / 1000).toFixed(1)} s)`);
        return elapsed;
    },

    // Formations whose ground has been fetched successfully in this session. Nothing has to clear
    // it: the two ways the parcel fabric is torn down — switching city and wiping local data — both
    // reload the page, which is also the only way the map forgets parcels it has ingested.
    _replayGroundFetched: new Set(),

    // Every corridor standing on the map, as a take. Roads and tracks are the ONLY things that
    // divide a cadastral parcel — a building sits on a piece and a readjustment reforms whole
    // parcels, so neither appears here.
    _appliedCorridorTakes(appliedList) {
        const planOrderApi = (typeof window !== 'undefined') ? window.__planOrder : null;
        if (!planOrderApi || typeof planOrderApi.footprintOf !== 'function') return [];
        const route = applyRoute;
        const source = Array.isArray(appliedList) && appliedList.length
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
                name: record.title || record.name || 'Road'
            });
        });
        return takes;
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

        const scoped = ancestry.loadedCadastreParcels()
            .filter(entry => arriving.has(String(entry.id)))
            .filter(entry => A.takesOverlapping(entry.feature, takes).length > 0)
            .map(entry => String(entry.id));
        if (!scoped.length) return null;

        const fabric = await this._deriveCorridorFabric({ parcelIds: scoped, takes });
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
        const CHUNK = 40;
        const A = browserRoot.__parcelArrangement;
        const ancestry = browserRoot.__cadastreAncestry;
        if (!A || !ancestry || typeof ancestry.loadedCadastreParcels !== 'function') {
            return { added: 0, removed: 0, unchanged: 0, parcels: 0, failed: [] };
        }

        const takes = Array.isArray(options.takes) ? options.takes : this._appliedCorridorTakes(options.appliedList);
        const takeById = new Map(takes.map(take => [take.id, take]));

        const scope = options.parcelIds
            ? new Set(Array.from(options.parcelIds).map(String))
            : null;
        const candidates = ancestry.loadedCadastreParcels();
        const parcels = [];
        for (let i = 0; i < candidates.length; i += CHUNK) {
            for (const entry of candidates.slice(i, i + CHUNK)) {
                if (scope) { if (scope.has(String(entry.id))) parcels.push(entry); continue; }
                // Unscoped: only parcels a corridor actually reaches have anything to derive.
                if (A.takesOverlapping(entry.feature, takes).length > 0) parcels.push(entry);
            }
            if (i + CHUNK < candidates.length) await breathe();
        }
        if (!parcels.length) return { added: 0, removed: 0, unchanged: 0, parcels: 0, failed: [] };

        const pieces = [];
        const failed = [];
        for (let i = 0; i < parcels.length; i += CHUNK) {
            const part = A.fabricOver(parcels.slice(i, i + CHUNK), takes);
            if (part && Array.isArray(part.pieces)) pieces.push(...part.pieces);
            if (part && Array.isArray(part.failed)) failed.push(...part.failed);
            if (i + CHUNK < parcels.length) await breathe();
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
        if (features.length) this._addFeaturesToMap(features, true, null);

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

        return {
            added: features.length,
            removed: diff.removed.length,
            unchanged: diff.unchanged.length,
            parcels: parcels.length,
            failed: failed || []
        };
    },

    // Every cadastral parcel that some derived layer standing on the map declares as its parent.
    // That is the honest test of "is this ground already taken" for a derivation scoped to a few
    // parcels: whoever put the layer there is still standing, or the layer would not be there.
    _parcelsClaimedByDerivedGround() {
        const browserRoot = (typeof window !== 'undefined') ? window : globalThis;
        const byId = (browserRoot.parcelLayerById instanceof Map) ? browserRoot.parcelLayerById : null;
        const claimed = new Set();
        if (!byId) return claimed;
        byId.forEach((layer, id) => {
            // A cadastral parcel claims nothing — it IS the ground.
            if (String(id).indexOf('#') === -1) return;
            const props = (layer && layer.feature && layer.feature.properties) || {};
            const parents = [];
            if (Array.isArray(props.parentParcelIds)) parents.push(...props.parentParcelIds);
            if (Array.isArray(props.baseParcelIds)) parents.push(...props.baseParcelIds);
            if (props.parentParcelId) parents.push(props.parentParcelId);
            if (props.rootParcelId) parents.push(props.rootParcelId);
            parents.forEach(parent => { if (parent) claimed.add(String(parent)); });
        });
        return claimed;
    },

    // Take ONE record's result off the map, and nothing else's.
    //
    // Unapply used to be a record flip that leaned on the whole-plan rebuild — reset every derived
    // layer back to pristine cadastre, then replay whatever was still standing. Correct, and the
    // reason applying or unapplying one proposal cost the entire plan.
    //
    // A record's payload is knowable directly. Its derived parcels carry `ancestorProposal` (a
    // corridor's own strips carry `proposalId`); its buildings and structures carry `proposalId` in
    // the presentation collections; and the parents it hid come back on their own, because a parcel
    // shows exactly when nothing derived claims it — so re-deriving the ground it stood on is what
    // reveals them, with no per-type reversal to write.
    //
    // Returns the footprint it held, so the caller can re-derive that ground. Record STATE is the
    // caller's business: flip `applied` first, or the re-derivation will still count this take.
    _undoProposalPayload(record) {
        const browserRoot = (typeof window !== 'undefined') ? window : globalThis;
        if (!record) return null;
        const id = String(record.proposalId || '');
        if (!id) return null;

        const planOrderApi = browserRoot.__planOrder;
        let footprint = null;
        try {
            footprint = (planOrderApi && typeof planOrderApi.footprintOf === 'function')
                ? planOrderApi.footprintOf(record)
                : null;
        } catch (_) { footprint = null; }

        const byId = (browserRoot.parcelLayerById instanceof Map) ? browserRoot.parcelLayerById : null;
        if (byId) {
            const mine = [];
            byId.forEach((layer, layerId) => {
                const key = String(layerId);
                if (key.indexOf('#') === -1) return; // never touch the cadastre itself
                const props = (layer && layer.feature && layer.feature.properties) || {};
                const owner = String(props.ancestorProposal || props.proposalId || '');
                if (owner === id) mine.push(key);
            });
            mine.forEach(layerId => {
                try { browserRoot.removeParcelLayerById?.(layerId); } catch (_) { }
                try { byId.delete(layerId); } catch (_) { }
                try {
                    const cache = (browserRoot.ParcelsState && typeof browserRoot.ParcelsState.getParcelCache === 'function')
                        ? browserRoot.ParcelsState.getParcelCache()
                        : browserRoot.parcelCache;
                    if (cache && cache.byId instanceof Map) cache.byId.delete(layerId);
                } catch (_) { }
                try { if (typeof clearPersistedParcelRecord === 'function') clearPersistedParcelRecord(layerId); } catch (_) { }
            });
        }

        // Buildings and structures are presentation caches of the record that authored them.
        let collectionsChanged = false;
        const dropAuthored = (name, storageKey) => {
            if (!Array.isArray(browserRoot[name])) return;
            const kept = browserRoot[name].filter(feature => String(feature?.properties?.proposalId || '') !== id);
            if (kept.length === browserRoot[name].length) return;
            browserRoot[name] = kept;
            collectionsChanged = true;
            if (storageKey) {
                try { PersistentStorage.setItem(storageKey, JSON.stringify(browserRoot[name])); } catch (_) { }
            }
        };
        dropAuthored('parks', 'cb_parks');
        dropAuthored('squares', 'cb_squares');
        dropAuthored('lakes', 'cb_lakes');
        dropAuthored('transitStations', 'cb_transit_stations');
        dropAuthored('proposedBuildings', null);
        if (collectionsChanged) {
            try { if (typeof updateParksLayer === 'function') updateParksLayer(); } catch (_) { }
            try { if (typeof updateSquaresLayer === 'function') updateSquaresLayer(); } catch (_) { }
            try { if (typeof updateLakesLayer === 'function') updateLakesLayer(); } catch (_) { }
            try { if (typeof updateTransitStationsLayer === 'function') updateTransitStationsLayer(); } catch (_) { }
            try { if (typeof updateProposedBuildingsLayer === 'function') updateProposedBuildingsLayer(); } catch (_) { }
        }
        try { if (typeof proposalFeatureCache !== 'undefined') proposalFeatureCache.clear(); } catch (_) { }
        try { if (typeof proposalAreaCache !== 'undefined') proposalAreaCache.clear(); } catch (_) { }

        this._clearDerivedRecordState(record);
        return footprint;
    },

    // A record that no longer stands — unapplied, deleted or parked: take its payload off the map
    // and derive the ground it held without it.
    //
    // That is the whole of "unapply". The arrangement is a function of the cadastre and the takes
    // standing over it, so removing one take is a recomputation of the parcels it crossed and of
    // nothing else — no reset, no replay of the rest of the plan. The record must already read as
    // unapplied (or be gone from storage), or the derivation will still count its take.
    // Async because the ground it gives back is now cut cooperatively — and the caller must be able
    // to rely on it being back when this resolves. Deferring it instead would mean a record could
    // read as released while its ground was still missing from the map, which is the kind of gap
    // that only shows up as a parcel that vanished.
    async _releaseUnappliedRecord(record) {
        if (!record) return null;
        const freed = this._undoProposalPayload(record);
        if (freed && freed.geometry) await this._deriveGroundUnder([freed]);
        try { if (typeof refreshAppliedCorridorStrips === 'function') refreshAppliedCorridorStrips(); } catch (_) { }
        try { if (typeof syncProposalsIndicator === 'function') syncProposalsIndicator(); } catch (_) { }
        try { if (typeof proposalStorage !== 'undefined' && proposalStorage.save) proposalStorage.save(); } catch (_) { }
        return freed;
    },

    // Put records back on the map after a failed apply restored their state.
    //
    // They read as applied again by then, and both apply entry points short-circuit on a record
    // that already reads applied — `return true` without touching the map. deriveForNewProposal
    // handles exactly that: it unmarks for the length of the apply and marks again once the apply
    // has done the work, so this must NOT unmark them first.
    async _rematerializeParkedAlternatives(records) {
        for (const record of (Array.isArray(records) ? records : [])) {
            if (!record) continue;
            const live = _getProposalRecord(record.proposalId) || record;
            try {
                await this.deriveForNewProposal(live, { _fabricQueue: true });
            } catch (error) {
                console.error('[applyProposal] could not restore parked alternative', live.proposalId, error);
            }
        }
    },

    // Undo a switch that did not take. The target's apply may have written part of its payload
    // before failing, so that comes off first — while the record still reads unapplied, which is
    // how the failed apply left it — then the records go back, then the parked alternatives are
    // put back on the map and the ground both sides touched is re-derived.
    async _restoreAfterFailedApply(proposalId, proposal, switchedAlternatives, restorePreApplyState) {
        const halfDone = this._undoProposalPayload(_getProposalRecord(proposalId) || proposal);
        restorePreApplyState();
        if (halfDone && halfDone.geometry) await this._deriveGroundUnder([halfDone]);
        await this._rematerializeParkedAlternatives(switchedAlternatives);
    },

    // Finishing a corridor re-derives ONLY the cadastral parcels it crosses.
    //
    // Nothing else can be affected: a parcel's pieces are a function of that parcel and the takes
    // over it, so a parcel this ribbon does not reach has the same inputs it had a moment ago and
    // therefore the same pieces. That is the whole reason the cost stops growing with the plan —
    // there is no reset, no fold, and no need to prove anything about the rest of the map.
    //
    // Returns null for anything that is not a corridor, so the caller routes those to the ordinary
    // path rather than this one.
    // Derive the result of a record that has just been created or edited, touching only the ground
    // whose inputs actually changed.
    //
    // NOTHING re-applies the whole plan. A parcel's pieces are a function of that parcel and the
    // takes over it, so a parcel whose take set did not change has the same pieces it had a moment
    // ago and there is nothing to redo — whatever the proposal's type.
    //
    //   corridor      the parcels under its footprint change taker sets. On an EDIT the parcels
    //                 under the SUPERSEDED footprint change too — that take has just been parked —
    //                 so both are re-derived, or the old position keeps a corridor nothing claims.
    //   readjustment  takes ground, so its own parcels are re-derived and anything standing on
    //                 ground it divided is swept.
    //   everything else  stands ON the fabric without dividing it. The parcel arrangement is
    //                 untouched, so only the proposal itself is applied.
    async deriveForNewProposal(proposal, options = {}) {
        if (!proposal) return null;
        const goalKey = (applyRoute && typeof applyRoute.normalizeGoalKey === 'function')
            ? applyRoute.normalizeGoalKey(proposal.goal)
            : String(proposal.goal || '');

        // Ground a parked record has just released. Callers that parked it themselves already hold
        // its footprint (the record's derived state may be gone by then); callers that only know the
        // ids pass those instead.
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

        // Standing since when: a record that was already applied keeps its stamp across a
        // re-derivation, and one that was not gets a fresh one. Unmarking clears the field, so it is
        // read before anything touches the flag.
        const priorAppliedAt = Object.prototype.hasOwnProperty.call(proposal, 'appliedAt')
            ? proposal.appliedAt
            : null;
        const markStanding = () => {
            try {
                setProposalApplied(proposal, true, priorAppliedAt ? { appliedAt: priorAppliedAt } : {});
            } catch (_) {
                proposal.applied = true;
            }
        };

        if (goalKey === 'road-track') {
            // Announced like every other type. A corridor takes this branch instead of the ordinary
            // apply, so without this the one kind of proposal a plan has a hundred of was also the
            // one kind that said nothing while it was being applied.
            const corridorId = (typeof getProposalKey === 'function' && getProposalKey(proposal)) || proposal.proposalId;
            return _runProposalApplyWithSummary(corridorId, proposal, async () => {
                markStanding();
                const derived = await this.deriveCorridorIncrementally(proposal, { alsoDerive: supersededFootprints });
                if (derived) return derived;
                try { setProposalApplied(proposal, false, { stamp: false }); } catch (_) { proposal.applied = false; }
                return false;
            }).then(result => (result === false ? null : result));
        }

        // `applyProposal(id)` without `replay` marks the record and then runs a WHOLE-PLAN rebuild to
        // materialise it — which is the cost this method exists to avoid. `replay: true` is the same
        // apply without that: it runs this proposal's own type handler and nothing else, which is
        // all a formation standing on existing fabric needs. Still queued, so a create cannot
        // interleave with another change to the same fabric.
        // The record must be UNAPPLIED when the apply runs. Both entry points short-circuit on a
        // record that already reads as applied — `return true` without touching the map — so
        // pre-marking it turns the whole thing into a silent success that materialises nothing.
        // The flag goes on after the apply has actually done the work.
        const key = (typeof getProposalKey === 'function' && getProposalKey(proposal)) || proposal.proposalId;
        const materialize = async () => {
            try { setProposalApplied(proposal, false, { stamp: false }); } catch (_) { proposal.applied = false; }
            let applied = false;
            try {
                applied = await this.applyProposal(key, { replay: true });
            } catch (error) {
                console.error('[deriveForNewProposal] apply threw for', key, error);
                applied = false;
            }
            if (applied) markStanding();
            return applied;
        };
        // `_fabricQueue` means the caller is already inside a queue slot. Enqueueing again from
        // there would wait on the operation that is doing the waiting — a deadlock, not a delay.
        const ok = options._fabricQueue === true
            ? await materialize()
            : await this._enqueueFabricChange(materialize);
        if (!ok) return null;

        // Whatever this proposal is, ground a parked record released has a different take set than
        // it had and must be re-derived. (Re-deriving ground a non-taker released is a no-op: the
        // arrangement is unchanged, so every piece hashes to the id it already has.)
        if (supersededFootprints.length) await this._deriveGroundUnder(supersededFootprints);
        return { applied: true, goalKey };
    },

    // Re-derive the cadastral parcels under a set of footprints. Used when a take is PARKED — the
    // ground it held is free, and the parcels under it have a different taker set than they did.
    async _deriveGroundUnder(footprints) {
        const browserRoot = (typeof window !== 'undefined') ? window : globalThis;
        const A = browserRoot.__parcelArrangement;
        const ancestry = browserRoot.__cadastreAncestry;
        if (!A || !ancestry || !Array.isArray(footprints) || !footprints.length) return null;
        const ribbons = footprints
            .filter(f => f && f.geometry)
            .map((f, index) => ({ id: `freed-${index}`, geometry: f.geometry }));
        if (!ribbons.length) return null;
        const parcelIds = ancestry.loadedCadastreParcels()
            .filter(entry => A.takesOverlapping(entry.feature, ribbons).length > 0)
            .map(entry => String(entry.id));
        if (!parcelIds.length) return null;
        return await this._deriveCorridorFabric({ parcelIds });
    },

    async deriveCorridorIncrementally(proposal, options = {}) {
        const browserRoot = (typeof window !== 'undefined') ? window : globalThis;
        const A = browserRoot.__parcelArrangement;
        const ancestry = browserRoot.__cadastreAncestry;
        const planOrderApi = browserRoot.__planOrder;
        if (!proposal || !A || !ancestry || !planOrderApi) return null;
        const goalKey = (applyRoute && typeof applyRoute.normalizeGoalKey === 'function')
            ? applyRoute.normalizeGoalKey(proposal.goal)
            : String(proposal.goal || '');
        if (goalKey !== 'road-track') return null;

        const started = _now();
        let footprint = null;
        try { footprint = planOrderApi.footprintOf(proposal); } catch (_) { footprint = null; }
        if (!footprint || !footprint.geometry) return null;

        const ribbon = [{ id: String(proposal.proposalId), geometry: footprint.geometry }];
        const groundUnder = () => {
            const hits = [];
            let coveredM2 = 0;
            ancestry.loadedCadastreParcels().forEach(entry => {
                if (!A.takesOverlapping(entry.feature, ribbon).length) return;
                hits.push(String(entry.id));
                coveredM2 += planOrderApi.intersectionArea(footprint, entry.feature);
            });
            return { hits, coveredM2 };
        };

        // Ask the map before asking the database. The parcels under a ribbon the user just drew are
        // almost always already loaded — they were fetched to draw over — and the round trip was the
        // single largest remaining cost of finishing a road (~300 ms against ~30 ms of geometry).
        // Anything short of complete cover still fetches, so a corridor running past the loaded edge
        // is not quietly cut against ground that is not there.
        const footprintM2 = (typeof turf !== 'undefined' && turf.area) ? turf.area(footprint) : 0;
        let ground = groundUnder();
        let groundMs = 0;
        const alreadyCovered = footprintM2 > 0 && (ground.coveredM2 / footprintM2) > 0.999;
        if (!alreadyCovered) {
            const groundMs0 = _now();
            await this._loadReplayGround([proposal]);
            groundMs = _now() - groundMs0;
            ground = groundUnder();
        }

        // An EDIT also frees the ground its predecessor held, so those parcels are re-derived in the
        // same pass — otherwise the old position keeps a corridor that no standing take claims.
        const freedRibbons = (Array.isArray(options.alsoDerive) ? options.alsoDerive : [])
            .filter(f => f && f.geometry)
            .map((f, index) => ({ id: `freed-${index}`, geometry: f.geometry }));
        const scope = new Set(ground.hits);
        if (freedRibbons.length) {
            ancestry.loadedCadastreParcels().forEach(entry => {
                if (A.takesOverlapping(entry.feature, freedRibbons).length) scope.add(String(entry.id));
            });
        }
        const parcelIds = Array.from(scope);

        const fabric = await this._deriveCorridorFabric({ parcelIds });
        const sweep = await this._sweepGroundNoLongerWhole(parcelIds);

        // The corridor that just landed may cross corridors that were already standing. A junction is
        // a property of the NETWORK, not of one record, so the topology boundary runs across every
        // applied corridor here — the same insert-node-and-split normalizeCorridorGraph has always
        // run within a single record's own strokes. It rewrites only how a centreline is written
        // down, so no footprint moves and nothing is re-cut; a corridor whose rewrite would not be
        // provably neutral is left exactly as it was. Skipped during a whole-plan rebuild: every
        // corridor passes through here then, and the network is noded once at the end instead.
        if (!this._rebuildInProgress) {
            try {
                const browserRoot = (typeof window !== 'undefined') ? window : globalThis;
                browserRoot.CorridorNetworkNodes?.normalize?.();
            } catch (error) {
                console.error('[deriveCorridor] network noding failed', error);
            }
        }

        try { if (typeof refreshAppliedCorridorStrips === 'function') refreshAppliedCorridorStrips(); } catch (_) { }
        try { if (typeof syncProposalsIndicator === 'function') syncProposalsIndicator(); } catch (_) { }
        try { if (typeof proposalStorage !== 'undefined' && proposalStorage.save) proposalStorage.save(); } catch (_) { }

        const totalMs = _now() - started;
        try {
            console.info(`[deriveCorridor] ${Math.round(totalMs)} ms — ground ${Math.round(groundMs)}${alreadyCovered ? ' (already loaded)' : ''}`
                + ` · ${fabric.parcels} parcel(s): +${fabric.added} −${fabric.removed} =${fabric.unchanged}`
                + (sweep.unapplied.length ? ` · ${sweep.unapplied.length} unapplied (ground no longer whole)` : ''));
        } catch (_) { }
        return { ...fabric, sweep, totalMs };
    },

    // A cut is not negotiable, so anything standing on ground it divided is removed rather than
    // adjusted. A building usually survives — its footprint is typically well inside the parcel, and
    // if it still sits within one piece nothing about it changed. A park, square or lake takes whole
    // parcels by definition, so the moment its ground is divided it cannot stand at all.
    async _sweepGroundNoLongerWhole(parcelIds) {
        const browserRoot = (typeof window !== 'undefined') ? window : globalThis;
        const planOrderApi = browserRoot.__planOrder;
        const t = browserRoot.turf;
        const sweepApi = browserRoot.__groundSweep;
        const touched = new Set((parcelIds || []).map(String));
        const unapplied = [];
        if (!planOrderApi || !t || !sweepApi || !touched.size) return { unapplied };

        // The pieces those parcels are now made of.
        const byId = (browserRoot.parcelLayerById instanceof Map) ? browserRoot.parcelLayerById : new Map();
        const pieces = [];
        byId.forEach((layer, id) => {
            const key = String(id);
            const root = key.split('#')[0];
            if (key === root || !touched.has(root)) return;
            try { pieces.push(layer.toGeoJSON(false)); } catch (_) { }
        });

        const records = (typeof proposalStorage !== 'undefined' && proposalStorage.getAllProposals)
            ? proposalStorage.getAllProposals().filter(record => appliedOf(record))
            : [];

        // for..of rather than forEach: releasing a record is asynchronous now (it gives ground back,
        // and giving ground back is cut cooperatively), and an async callback inside forEach would
        // let every release start at once — several derivations racing on the same fabric, in a
        // method whose whole job is to leave the fabric consistent. Sequential, in record order.
        for (const record of records) {
            const goalKey = (applyRoute && typeof applyRoute.normalizeGoalKey === 'function')
                ? applyRoute.normalizeGoalKey(record.goal)
                : String(record.goal || '');
            if (goalKey === 'road-track') continue;

            let footprint = null;
            try { footprint = planOrderApi.footprintOf(record); } catch (_) { footprint = null; }
            if (!footprint || !footprint.geometry) continue;

            // Ask per BUILDING, not of the union. A block is one building per parcel, so the union
            // of them cannot fit inside a single piece of a single parcel once the block spans more
            // than one — which condemned whole blocks whenever a road divided any parcel they built
            // on, with the cut nowhere near a building. A design falls only when the cut runs
            // through one of its own parts.
            const isBuildingDesign = goalKey === 'building'
                || !!(applyRoute && applyRoute.isBuildingGoal && applyRoute.isBuildingGoal(goalKey));
            const parts = sweepApi.designParts(record, isBuildingDesign, footprint);
            const verdict = sweepApi.inspectDesignAgainstPieces(parts, pieces, {
                intersectionArea: (a, b) => {
                    try { const hit = t.intersect(a, b); return hit ? (t.area(hit) || 0) : 0; } catch (_) { return 0; }
                },
                area: shape => { try { return t.area(shape) || 0; } catch (_) { return 0; } }
            });
            if (!verdict.standsHere) continue;
            // A park, square or lake takes whole parcels by definition: divided ground is fatal to
            // it whatever the geometry says. A building design survives an untouched cut.
            if (isBuildingDesign && !verdict.severed) continue;

            try { setProposalApplied(record, false, { stamp: false }); } catch (_) { record.applied = false; }
            // Flipping the flag is not removal. A record's buildings, parks, squares and lakes live
            // in presentation collections keyed to it, and its derived parcels carry its id — none
            // of that comes off because `applied` went false. The sweep did only the flip, so a
            // block swept away by a road edit stayed drawn on the map, looking applied, while the
            // record read as unapplied everywhere else. This is the same release the ordinary
            // unapply path runs, so a swept record leaves exactly as thoroughly as a removed one.
            try { await this._releaseUnappliedRecord(record); }
            catch (error) { console.error('[sweepGround] could not take the swept record off the map', record.proposalId, error); }
            unapplied.push({ proposalId: String(record.proposalId), title: record.title || String(record.proposalId), goal: goalKey });
        }

        if (unapplied.length) {
            try {
                // Blocks are named after a parcel, so several distinct records share a title and the
                // list read as "Block X; Block X; Block X". Count the repeats instead of printing them.
                const byTitle = new Map();
                unapplied.forEach(entry => byTitle.set(entry.title, (byTitle.get(entry.title) || 0) + 1));
                const names = [...byTitle.entries()]
                    .map(([title, count]) => (count > 1 ? `${title} ×${count}` : title))
                    .join('; ');
                if (typeof showEphemeralMessage === 'function') {
                    showEphemeralMessage(`${unapplied.length} proposal(s) removed — the road divided ground they needed whole: ${names}`, 10000, 'warning');
                }
            } catch (_) { }
        }
        return { unapplied };
    },

    async _rebuildPass(appliedList, opts) {
        const resetStarted = _now();
        this._resetDerivedFabric(appliedList);
        const resetMs = _now() - resetStarted;
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
        const groundMs = await this._loadReplayGround(appliedList);
        const foldStarted = _now();

        // The corridors divide the cadastre in ONE derivation, not one member at a time. A parcel's
        // pieces are a function of that parcel and the takes over it, so there is nothing to fold:
        // no order, no parentage, no junction rule. What remains for the fold is everything that
        // stands ON the resulting ground.
        const takes = this._appliedCorridorTakes(appliedList);
        // ...which is also why a reload of a plan with a hundred roads passed through here in
        // silence: there is no per-corridor apply to announce. The derivation announces itself
        // instead, and says what it covers — one pair of lines for the whole set, because that is
        // honestly what it is.
        if (takes.length) _announceApply(`Applying ${_corridorCountPhrase(takes)}...`);
        const fabric = await this._deriveCorridorFabric({ appliedList, takes });
        if (takes.length) _announceApply(`Applied ${_corridorCountPhrase(takes)}`);
        const corridorIds = new Set(takes.map(take => take.id));

        // Which member cost the most. A replay of twenty proposals that takes three seconds is a
        // very different problem depending on whether that is twenty × 150 ms or one × 2,800 ms.
        let slowest = null;

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
            try {
                ok = await this.applyProposal(key, { replay: true });
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

    _collectAppliedAlternativesForExplicitApply(proposalData) {
        if (!proposalData || typeof proposalStorage === 'undefined') return [];
        const runtime = typeof window !== 'undefined' ? window : globalThis;
        const collect = runtime && runtime.collectAppliedProposalAlternatives;
        if (typeof collect !== 'function' || typeof proposalStorage.getAllProposals !== 'function') return [];
        try {
            return collect(proposalData, proposalStorage.getAllProposals(), {
                planOrder: runtime.__planOrder || null
            });
        } catch (error) {
            console.warn('[applyProposal] could not inspect applied alternatives', error);
            return [];
        }
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
                            setProposalApplied(alternative, false, { stamp: false });
                            const freed = this._undoProposalPayload(alternative);
                            if (freed && freed.geometry) parkedFootprints.push(freed);
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
                        supersededFootprints: parkedFootprints
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
                // A corridor does not cut anything itself: it becomes a TAKE, and the cadastral
                // parcels it crosses are re-derived from the cadastre and every take over them.
                // Same derivation whether the road arrives from the drawing tool, the proposal list
                // or a shared plan — there is only one way ground gets divided.
                try { setProposalApplied(proposalData, true, { stamp: false }); } catch (_) { proposalData.applied = true; }
                const derived = await this.deriveCorridorIncrementally(proposalData);
                if (derived) return true;
                try { setProposalApplied(proposalData, false, { stamp: false }); } catch (_) { proposalData.applied = false; }
                const message = 'Cannot apply road: its footprint could not be read.';
                try { this._setLastApplyFailure(safeId, { code: 'corridor-footprint-missing', message }); } catch (_) { }
                return false;
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
                    // The record is unapplied by now, so its payload comes off and the ground it
                    // held is derived again with one fewer take. Nothing else in the plan had an
                    // input change, so nothing else is recomputed.
                    await this._releaseUnappliedRecord(_getProposalRecord(proposalId));
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

        // Deleting a record has the same fabric semantics as unapplying it: its payload comes off
        // the map and the ground it held is derived again without it. There is no descendant family.
        proposalStorage.removeProposal(proposalId);
        if (wasApplied && !this._rebuildInProgress) {
            try { await this._releaseUnappliedRecord(proposalData); }
            catch (error) {
                console.error('[deleteProposal] could not release the deleted record\'s ground', error);
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
