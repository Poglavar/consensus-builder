// proposals/data.js — proposal data layer: config tables (colors, goal/sort/filter maps),
// storage-key constants, and the stateful singletons proposalStorage (storage API) and
// multiParcelSelection (selection controller) + caches. Extracted from proposals.js; loaded before
// the proposals.js bootstrap so its load-time init can reference these.

// One atomic envelope is the only durable local proposal state. Keep the key stable so an upgrade
// replaces the old array in place instead of leaving two stores that can disagree.
const PROPOSALS_STORAGE_KEY = 'cadastre_proposals';
const PROPOSALS_STATE_VERSION = 2;
const PROPOSALS_CUTOVER_KEY = 'cadastre_proposals_cutover_v2';

// Kept as names only so the one-time cutover can remove the split counter and parked legacy copy.
// Normal proposal writes never touch either key.
const PROPOSALS_NEXT_ID_KEY = 'cadastre_proposals_nextId';

// Where a READ-ONLY (secondary) tab parks work it is not allowed to write to the shared key above.
// Separate key on purpose: the primary tab's blob stays untouched, so nothing can be clobbered, and
// the work survives the reload that used to destroy it. Per-city already, since PersistentStorage
// opens one database per city.
const PROPOSALS_RECOVERY_KEY = 'cadastre_proposals_recovery';

// These are disposable materializations/registries from the pre-fabric runtime. Do not use a
// store-wide clear here: ownership, language, chain and server/shared records live beside these
// keys and must survive the local geometry cutover.
const LEGACY_DERIVED_PARCEL_KEYS = Object.freeze([
    'cadastre_blocks',
    'roadParcels',
    'cb_parks',
    'cb_squares',
    'cb_lakes',
    'cb_transit_stations'
]);

function isServerOrSharedProposal(record) {
    if (!record || typeof record !== 'object') return false;
    return record.serverProposalId !== undefined && record.serverProposalId !== null
        || record.source === 'server'
        || record.source === 'shared'
        || record.isShared === true
        || record.shared === true
        || record.isMinted === true;
}

function isLegacyDerivedParcelKey(key) {
    const value = String(key || '');
    if (LEGACY_DERIVED_PARCEL_KEYS.includes(value)) return true;
    if (['parcel_nft_address', 'parcelNFTAddress', 'parcelNftAddress'].includes(value)) return false;
    // parcel_<id> stores local geometry; parcel_<id>_owner is ownership state and is deliberately
    // outside this cutover's authority.
    return /^parcel_.+/.test(value) && !/_owner$/.test(value);
}

function proposalStateEnvelope(nextProposalId, records) {
    return {
        version: PROPOSALS_STATE_VERSION,
        nextProposalId: Number.isFinite(Number(nextProposalId)) && Number(nextProposalId) >= 0
            ? Math.floor(Number(nextProposalId))
            : 0,
        records: Array.isArray(records) ? records : []
    };
}

function declaredCadastreAnchors(parcelIds) {
    const output = [];
    const seen = new Set();
    Array.from(parcelIds || []).forEach(value => {
        const id = String(value || '').trim();
        if (!id || seen.has(id)) return;
        seen.add(id);
        output.push(id);
    });
    return output;
}

function requireExactCadastreAnchors(record, action) {
    const values = record?.cadastreParcelIds;
    if (!Array.isArray(values) || !values.length) {
        throw new Error(`Cannot ${action} proposal: cadastreParcelIds is required.`);
    }
    const ids = values.map(value => typeof value === 'string' ? value : '');
    if (ids.some((id, index) => !id || id !== id.trim() || id !== values[index])) {
        throw new Error(`Cannot ${action} proposal: cadastreParcelIds must contain non-empty strings.`);
    }
    if (new Set(ids).size !== ids.length) {
        throw new Error(`Cannot ${action} proposal: cadastreParcelIds must not contain duplicates.`);
    }
    return ids;
}

function explicitCadastreAnchors(parcelIds) {
    const root = typeof window !== 'undefined' ? window : globalThis;
    const fabric = root && root.LiveParcelFabric;
    if (!fabric || typeof fabric.cadastreIdsForParcelIds !== 'function') {
        const error = new Error('Live parcel fabric is required to resolve authored parcel selections.');
        error.code = 'live-parcel-fabric-unavailable';
        throw error;
    }
    return fabric.cadastreIdsForParcelIds(parcelIds);
}

function canonicalizeProposalCadastreAnchors(record) {
    if (!record || typeof record !== 'object') return record;
    const out = JSON.parse(JSON.stringify(record));
    const declared = Array.isArray(out.cadastreParcelIds) && out.cadastreParcelIds.length
        ? declaredCadastreAnchors(out.cadastreParcelIds)
        : [];
    if (declared.length) out.cadastreParcelIds = declared;
    return out;
}

function proposalWithAuthoredSelection(record, selectedParcelIds) {
    const out = canonicalizeProposalCadastreAnchors(record);
    const selected = declaredCadastreAnchors(selectedParcelIds);
    if (!selected.length) return out;
    const projected = declaredCadastreAnchors(explicitCadastreAnchors(selected));
    if (!projected.length) {
        throw new Error('The selected live parcels have no cadastral provenance.');
    }
    const declared = declaredCadastreAnchors(out.cadastreParcelIds);
    if (declared.length) {
        const expected = new Set(declared);
        const same = expected.size === projected.length && projected.every(id => expected.has(id));
        if (!same) throw new Error('Local parcel selection conflicts with cadastreParcelIds.');
    }
    out.cadastreParcelIds = projected;
    return out;
}

// `parentParcelIds` used to mean both current live input and durable land identity. A local
// authoring/persistence boundary may still project an explicit live selection through
// LiveParcelFabric, but remote import rejects an unstamped record instead of guessing its origin.
// Never write the alias back. A persisted proposal has exactly one land declaration: flat,
// original cadastral IDs in `cadastreParcelIds`. Compatibility views for old authoring code are not
// state and cannot form a replay dependency graph.
function stripProposalCadastreAliases(record) {
    if (!record || typeof record !== 'object') return record;
    delete record.parentParcelIds;
    delete record.parcelIds;
    ['roadProposal', 'reparcellization', 'decideLaterProposal', 'buildingProposal', 'structureProposal']
        .forEach(key => {
            const sub = record[key];
            if (!sub || typeof sub !== 'object' || Array.isArray(sub)) return;
            delete sub.parentParcelIds;
            if (key === 'reparcellization') delete sub.parcelIds;
            if (key === 'buildingProposal') {
                delete sub.blockParcelIds;
                delete sub.parentParcelNumbers;
                delete sub.ancestorKey;
                if (Array.isArray(sub.ineligibleParcels)) {
                    sub.ineligibleParcels = sub.ineligibleParcels.map(entry => {
                        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
                        const clean = { ...entry };
                        delete clean.parcelId;
                        delete clean.parcel_id;
                        delete clean.parentParcelId;
                        delete clean.parentParcelIds;
                        return clean;
                    });
                }
            }
        });
    return record;
}

const proposalMetadataFetchPromises = new Map();

const proposalListTranslationsHydrated = new Set();

// proposalStorage is the durable authored log, not a snapshot of the current browser's replay.
// Persist only authored fields + applied/order state. Child ids, formation receipts, parent feature
// snapshots and demolition scans are disposable materialization output and are regenerated from
// cadastre on boot. Keeping them in the durable blob is how dead generations became prerequisites.
function proposalRecordForPersistence(record) {
    if (!record || typeof record !== 'object') return record;
    const root = typeof window !== 'undefined' ? window : globalThis;
    const depthApi = root && root.__formationDepth;
    if (!depthApi || typeof depthApi.stripDerivedRecordData !== 'function') {
        throw new Error('Cannot persist proposal: the authored-record projection is unavailable.');
    }
    requireExactCadastreAnchors(record, 'persist');
    // Inspect the record as supplied before compatibility aliases are synchronized.  Syncing first
    // would hide the exact malformed declaration this boundary exists to reject.
    const invalid = typeof depthApi.findNonCadastralReference === 'function'
        ? depthApi.findNonCadastralReference(record)
        : null;
    if (invalid) {
        throw new Error(`Cannot persist proposal: ${invalid.path} contains live parcel id ${invalid.id}.`);
    }
    const verdict = typeof depthApi.conformanceOf === 'function'
        ? depthApi.conformanceOf(record)
        : { flat: true };
    if (!verdict.flat) {
        const conflict = verdict.violations?.[0];
        throw new Error(`Cannot persist proposal: ${conflict?.field || conflict?.code || 'cadastral declaration'} is invalid.`);
    }
    const canonical = canonicalizeProposalCadastreAnchors(record);
    const out = depthApi.stripDerivedRecordData(canonical);
    return stripProposalCadastreAliases(out);
}

const proposalStorage = {
    proposals: new Map(),
    nextProposalId: 0,
    // Save-batching, same shape as agentStorage. Code paths that mutate proposals
    // call save() freely; if a batch is open save() just flags a pending write
    // and the actual JSON.stringify + IndexedDB write happens once at endBatch().
    // The game turn loop opens a batch around all agent actions — without this
    // we re-serialised the entire proposal store ~10-20 times per turn, which
    // is the bulk of the per-turn cost and the source of the flyTo choppiness.
    _suspendSaveCount: 0,
    _hasPendingSave: false,

    // Pure transaction protocol used by ParcelMutation. A draft inherits all normal store
    // methods, but its save hooks are inert; serialization and publication are explicit steps at
    // the coordinator boundary.
    snapshotForMutation() {
        return {
            records: new Map(Array.from(this.proposals, ([id, record]) => [id, JSON.parse(JSON.stringify(record))])),
            nextProposalId: this.nextProposalId,
            blockedWriteCount: this._blockedWriteCount
        };
    },

    createMutationDraft(snapshot) {
        const draft = Object.create(this);
        draft.proposals = new Map(Array.from(snapshot.records || [], ([id, record]) => [id, JSON.parse(JSON.stringify(record))]));
        draft.nextProposalId = snapshot.nextProposalId;
        draft._suspendSaveCount = 0;
        draft._hasPendingSave = false;
        draft.save = () => { draft._hasPendingSave = true; };
        draft._persist = draft.save;
        draft.beginBatch = () => {};
        draft.endBatch = () => {};
        return draft;
    },

    serializeMutationDraft(draft) {
        const serialisable = Array.from(draft.proposals.values()).map(proposalRecordForPersistence);
        const state = proposalStateEnvelope(draft.nextProposalId, serialisable);
        return { key: PROPOSALS_STORAGE_KEY, value: JSON.stringify(state) };
    },

    publishMutationDraft(draft) {
        const next = draft.proposals;
        for (const id of Array.from(this.proposals.keys())) {
            if (!next.has(id)) this.proposals.delete(id);
        }
        next.forEach((record, id) => {
            const current = this.proposals.get(id);
            if (current && typeof current === 'object' && !Array.isArray(current)) {
                Object.keys(current).forEach(key => { delete current[key]; });
                Object.assign(current, JSON.parse(JSON.stringify(record)));
            } else {
                this.proposals.set(id, JSON.parse(JSON.stringify(record)));
            }
        });
        this.nextProposalId = draft.nextProposalId;
        this._hasPendingSave = false;
    },

    restoreMutationSnapshot(snapshot) {
        this.publishMutationDraft({
            proposals: snapshot.records,
            nextProposalId: snapshot.nextProposalId
        });
        this._blockedWriteCount = snapshot.blockedWriteCount;
    },

    beginBatch() {
        this._suspendSaveCount += 1;
    },

    endBatch() {
        if (this._suspendSaveCount > 0) {
            this._suspendSaveCount -= 1;
        }
        if (this._suspendSaveCount === 0 && this._hasPendingSave) {
            this._hasPendingSave = false;
            this._persist();
        }
    },
    _ensureIndexes() {
        if (!this.proposals || typeof this.proposals.clear !== 'function') {
            this.proposals = new Map();
        }
    },

    _normalizeProposalIdentity(proposal, context = {}) {
        if (!proposal || typeof proposal !== 'object') return proposal;
        const { existingHash = null } = context;
        const candidate = proposal.proposalId
            || proposal.tokenId
            || existingHash;
        if (candidate !== undefined && candidate !== null) {
            proposal.proposalId = String(candidate);
        }
        return proposal;
    },

    _coerceProposalId(value) {
        if (value === undefined || value === null) return null;
        return String(value);
    },

    _indexProposal(proposal) {
        this._ensureIndexes();
        if (!proposal) return null;
        // This is the single ingress to the authored log. Callers historically mutated objects
        // returned by getProposal() and then called _indexProposal(), which let live-fabric fields
        // bypass addProposal()/importProposal() and poison the next whole-store save. Normalize the
        // complete record here too, and only touch the caller's object after validation succeeds.
        // Preserving the object identity keeps the existing mutation journal/UI references valid.
        const canonical = this._normalizeProposal({ ...proposal });
        Object.keys(proposal).forEach(key => { delete proposal[key]; });
        Object.assign(proposal, canonical);
        const id = this._coerceProposalId(
            proposal.proposalId
            || proposal.tokenId
        );
        if (!id) return null;
        this.proposals.set(id, proposal);
        return id;
    },

    _resolveProposalId(idOrHash) {
        this._ensureIndexes();
        if (idOrHash === undefined || idOrHash === null) return null;
        const key = String(idOrHash);
        if (this.proposals.has(key)) {
            return key;
        }
        for (const [id, proposal] of this.proposals.entries()) {
            if (!proposal) continue;
            const candidates = [
                proposal.proposalId,
                proposal.tokenId,
                proposal.chainProposalId,
                proposal.onchain && proposal.onchain.chainProposalId,
                proposal.serverProposalId,
                proposal.id
            ]
                .filter(value => value !== undefined && value !== null && String(value).trim() !== '')
                .map(String);
            if (candidates.includes(key)) {
                return id;
            }
        }
        return null;
    },

    findProposalByIdOrHash(idOrHash) {
        const resolved = this._resolveProposalId(idOrHash);
        return resolved ? this.proposals.get(resolved) : null;
    },

    _computeSimilarityHash(parcelIds = []) {
        const ids = Array.from(new Set((parcelIds || []).map(id => String(id).trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
        return ids.join('|');
    },

    getSimilarProposalsByParcelIds(parcelIds = []) {
        const normalizedIds = normalizeParcelIdList(parcelIds);
        const targetHash = this._computeSimilarityHash(normalizedIds);
        if (!targetHash || !this.proposals || this.proposals.size === 0) {
            return [];
        }

        const matches = [];
        for (const proposal of this.proposals.values()) {
            if (!proposal) continue;
            const proposalIdKey = this._computeSimilarityHash(proposal.cadastreParcelIds);
            if (proposalIdKey && proposalIdKey === targetHash) {
                matches.push(proposal);
            }
        }
        return matches;
    },

    importOnChainProposal(raw) {
        if (!raw) return null;

        const metaProps = raw.metadata && raw.metadata.properties ? raw.metadata.properties : {};
        const owns = (value, key) => value && typeof value === 'object'
            && Object.prototype.hasOwnProperty.call(value, key);
        if (owns(raw, 'parentParcelIds') || owns(metaProps, 'parcelIds')) {
            throw new Error('Cannot import chain proposal: cadastreParcelIds is the only parcel declaration.');
        }
        const declaredCadastreIds = owns(raw, 'cadastreParcelIds')
            ? raw.cadastreParcelIds
            : metaProps.cadastreParcelIds;
        if (!Array.isArray(declaredCadastreIds) || !declaredCadastreIds.length) {
            throw new Error('Cannot import chain proposal: cadastreParcelIds is required.');
        }
        const chainTokenId = raw.proposalId ?? raw.tokenId ?? (raw.onchain && raw.onchain.proposalId) ?? metaProps.tokenId ?? null;
        const rawProposalId = chainTokenId !== undefined && chainTokenId !== null ? String(chainTokenId) : null;
        const metaProposalId = metaProps.proposalId || metaProps.id || null;
        const cadastreParcelIds = normalizeParcelIdList(
            declaredCadastreIds
        );
        const authoredApi = (typeof window !== 'undefined' ? window : globalThis).ProposalAuthoredRecord;
        if (!authoredApi || typeof authoredApi.isDerivedParcelId !== 'function') {
            throw new Error('Cannot import chain proposal: authored proposal validation is unavailable.');
        }
        const generatedId = cadastreParcelIds.find(id => authoredApi.isDerivedParcelId(id));
        if (generatedId) {
            throw new Error(`Cannot import chain proposal: ${generatedId} is a generated parcel id.`);
        }
        const normalizedChainId = typeof normalizeChainId === 'function'
            ? normalizeChainId(raw.chainId || (raw.onchain && raw.onchain.chainId))
            : (raw.chainId || (raw.onchain && raw.onchain.chainId) || null);
        const contractAddress = raw.contractAddress || (raw.onchain && raw.onchain.contractAddress) || metaProps.contractAddress || null;
        const chainProposalId = buildChainProposalId(normalizedChainId, contractAddress, rawProposalId);

        // Try to reuse any already-known record (by id OR hash) to avoid losing richer metadata/titles
        const existing =
            (rawProposalId && typeof this.findProposalByIdOrHash === 'function' ? this.findProposalByIdOrHash(rawProposalId) : null)
            || (metaProposalId && typeof this.findProposalByIdOrHash === 'function' ? this.findProposalByIdOrHash(metaProposalId) : null)
            || (rawProposalId ? this.proposals.get(rawProposalId) : null)
            || (metaProposalId ? this.proposals.get(metaProposalId) : null)
            || null;

        // Prefer any already known human-friendly title/name before falling back to raw chain data
        const pickPreferredString = (...candidates) => {
            const typeLabels = Object.values(PROPOSAL_GOAL_LABELS || {}).map(v => String(v).toLowerCase());
            try {
                Object.keys(PROPOSAL_GOAL_LABELS || {}).forEach(key => {
                    const localized = getProposalGoalLabel(key);
                    if (localized) {
                        typeLabels.push(String(localized).toLowerCase());
                    }
                });
            } catch (_) { }
            let best = '';
            let bestScore = -Infinity;
            const seen = new Set();
            candidates.forEach(c => {
                const trimmed = typeof c === 'string' ? c.trim() : '';
                if (!trimmed || seen.has(trimmed)) return;
                seen.add(trimmed);
                const lower = trimmed.toLowerCase();
                let score = trimmed.length;
                if (typeLabels.includes(lower)) {
                    score -= 100; // heavily de-prioritise pure type labels like "Square"
                }
                if (score > bestScore) {
                    bestScore = score;
                    best = trimmed;
                }
            });
            return best;
        };

        // Try to match an existing local proposal by similarity (parcel set) to borrow its richer title/name
        const similarityHash = this._computeSimilarityHash(cadastreParcelIds);
        let similar = null;
        try {
            for (const p of this.proposals.values()) {
                if (!p) continue;
                const hash = this._computeSimilarityHash(p.cadastreParcelIds || []);
                if (hash === similarityHash) {
                    similar = p;
                    break;
                }
            }
        } catch (_) { /* ignore */ }

        let proposalId = metaProposalId || (existing && existing.proposalId) || rawProposalId || (similar && similar.proposalId) || null;
        if ((!proposalId || isLocalProposalId(proposalId)) && typeof this._buildDeterministicId === 'function') {
            try {
                proposalId = this._buildDeterministicId({ ...(existing || {}), ...raw, cadastreParcelIds });
            } catch (_) { /* best-effort */ }
        }
        if (!proposalId && rawProposalId) {
            proposalId = rawProposalId;
        }

        const rawGoal = raw.goal
            || metaProps.goal
            || (raw.metadata && raw.metadata.attributes && raw.metadata.attributes.find && (() => {
                const goalAttr = raw.metadata.attributes.find(a => a && a.trait_type && String(a.trait_type).toLowerCase() === 'goal');
                return goalAttr && goalAttr.value;
            })());
        const normalizedGoal = normalizeProposalGoalKey(rawGoal || (existing && existing.goal) || '');
        const fallbackTitle = normalizedGoal
            ? getProposalGoalLabel(normalizedGoal)
            : `Proposal ${proposalId}`;

        const title = pickPreferredString(
            existing && existing.title,
            existing && existing.name,
            existing && existing.proposalName,
            existing && existing.blockName,
            existing && existing.structureProposal && existing.structureProposal.blockName,
            existing && existing.metadata && existing.metadata.name,
            existing && existing.metadata && existing.metadata.title,
            existing && existing.onchain && existing.onchain.metadata && existing.onchain.metadata.name,
            existing && existing.onchain && existing.onchain.metadata && existing.onchain.metadata.title,
            similar && similar.title,
            similar && similar.name,
            similar && similar.proposalName,
            similar && similar.blockName,
            similar && similar.structureProposal && similar.structureProposal.blockName,
            raw.title,
            raw.name,
            raw.proposalName,
            raw.blockName,
            raw.structureProposal && raw.structureProposal.blockName,
            raw.metadata && raw.metadata.name,
            raw.metadata && raw.metadata.title,
            raw.onchain && raw.onchain.metadata && raw.onchain.metadata.name,
            raw.onchain && raw.onchain.metadata && raw.onchain.metadata.title,
            raw.description,
            fallbackTitle
        );

        const description = pickPreferredString(
            raw.description,
            existing && existing.description,
            raw.metadata && raw.metadata.description,
            existing && existing.metadata && existing.metadata.description,
            raw.onchain && raw.onchain.metadata && raw.onchain.metadata.description,
            existing && existing.onchain && existing.onchain.metadata && existing.onchain.metadata.description
        );
        const author = raw.author || raw.owner || raw.creator || (existing && existing.author) || '';
        const lensEntries = normalizeLensEntries(
            raw.lens
            || raw.lensAddresses
            || (raw.onchain && raw.onchain.lens)
            || (existing && existing.lens)
        );

        const normalized = {
            proposalId,
            tokenId: rawProposalId || (existing && existing.tokenId) || null,
            chainProposalId: chainProposalId || (existing && existing.chainProposalId) || null,
            cadastreParcelIds,
            title,
            description,
            name: title,
            proposalName: title,
            author,
            chainId: normalizedChainId || (existing && existing.chainId) || null,
            isConditional: !!raw.isConditional,
            imageURI: raw.imageURI || '',
            acceptancePossible: raw.acceptancePossible !== false,
            lifecycleStatus: raw.lifecycleStatus || raw.status || 'Active',
            ethBalance: raw.ethBalance || '0',
            tokenBalance: raw.tokenBalance || '0',
            acceptanceCount: raw.acceptanceCount || '0',
            expiryTimestamp: raw.expiryTimestamp || '0',
            expiringPercentage: raw.expiringPercentage || '0',
            createdAt: raw.createdAt || metaProps.createdAt || new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            acceptedParcels: Array.isArray(raw.acceptedParcels) ? raw.acceptedParcels : [],
            isMinted: true,
            metadata: raw.metadata || (existing && existing.metadata) || null,
            lens: lensEntries.length ? lensEntries : (existing && existing.lens ? existing.lens : undefined),
            goal: normalizedGoal || (existing && existing.goal) || null,
            onchain: {
                ...(existing && existing.onchain ? existing.onchain : {}),
                ...(raw.onchain ? raw.onchain : {})
            }
        };

        const incomingOnchain = raw.onchain || {};
        const existingOnchain = (existing && existing.onchain) || {};
        const mergedOnchain = {
            ...existingOnchain,
            ...incomingOnchain,
            chainId: normalizedChainId || existingOnchain.chainId || raw.chainId || incomingOnchain.chainId || null,
            proposalId: rawProposalId || proposalId,
            chainProposalId: chainProposalId || existingOnchain.chainProposalId || incomingOnchain.chainProposalId || null,
            transactionHash: incomingOnchain.transactionHash || existingOnchain.transactionHash || raw.transactionHash || null,
            contractAddress: incomingOnchain.contractAddress || existingOnchain.contractAddress || raw.contractAddress || null,
            metadataUri: incomingOnchain.metadataUri || existingOnchain.metadataUri || raw.metadataUri || raw.metadataUrl || null
        };
        if (mergedOnchain.chainId || mergedOnchain.transactionHash || mergedOnchain.contractAddress) {
            normalized.onchain = mergedOnchain;
        }

        // Merge with existing (preserve local extras if any)
        const merged = existing ? { ...existing, ...normalized } : normalized;
        merged.isMinted = true; // ensure minted flag stays true

        const safeClone = (value) => {
            try { return JSON.parse(JSON.stringify(value)); } catch (_) { return null; }
        };

        // Map metadata-driven offer details and geometry
        const metaOffer = metaProps.offer || metaProps.budget || null;
        const metaOfferAmount = metaOffer && metaOffer.amount !== undefined ? metaOffer.amount
            : (metaOffer && metaOffer.value !== undefined ? metaOffer.value
                : (metaProps.offerAmount !== undefined ? metaProps.offerAmount : metaProps.ethAmount));
        if (metaOfferAmount !== undefined && metaOfferAmount !== null) {
            const numericOffer = Number(metaOfferAmount);
            if (Number.isFinite(numericOffer) && numericOffer > 0 && (!merged.offer || merged.offer === 0)) {
                merged.offer = numericOffer;
            }
        }
        const metaOfferCurrency = (metaOffer && (metaOffer.currency || metaOffer.curr)) || metaProps.offerCurrency || metaProps.currency;
        if (metaOfferCurrency && !merged.offerCurrency) {
            merged.offerCurrency = metaOfferCurrency;
        }

        const geometryPayload = metaProps.geometry;
        if (geometryPayload) {
            if (geometryPayload.hash && !merged.geometryHash) {
                merged.geometryHash = geometryPayload.hash;
            }
            if (geometryPayload.geometry) {
                merged.geometry = merged.geometry || safeClone(geometryPayload.geometry);
            } else if (!merged.geometry) {
                merged.geometry = safeClone(geometryPayload);
            }
            if (geometryPayload.roadProposal) {
                merged.roadProposal = Object.assign({}, merged.roadProposal || {}, safeClone(geometryPayload.roadProposal));
            }
            if (geometryPayload.buildingProposal) {
                merged.buildingProposal = Object.assign({}, merged.buildingProposal || {}, safeClone(geometryPayload.buildingProposal));
            }
            if (geometryPayload.structureProposal) {
                merged.structureProposal = Object.assign({}, merged.structureProposal || {}, safeClone(geometryPayload.structureProposal));
            }
            if (geometryPayload.reparcellization) {
                merged.reparcellization = Object.assign({}, merged.reparcellization || {}, safeClone(geometryPayload.reparcellization));
            }
        }

        // Ensure we preserve chain-specific identifiers
        if (chainProposalId && !merged.chainProposalId) {
            merged.chainProposalId = chainProposalId;
        }
        if (rawProposalId && !merged.tokenId) {
            merged.tokenId = rawProposalId;
        }

        // Preserve offer-related fields from existing proposal or raw input
        // These fields are not returned by the smart contract, so we must preserve them
        if (existing) {
            // Preserve offer fields from existing proposal (only if they exist)
            if (typeof existing.offer === 'number' && existing.offer > 0) {
                merged.offer = existing.offer;
            }
            if (existing.offerCurrency) {
                merged.offerCurrency = existing.offerCurrency;
            }
            if (typeof existing.decayEnabled === 'boolean') {
                merged.decayEnabled = existing.decayEnabled;
            }
            if (typeof existing.decayPercent === 'number') {
                merged.decayPercent = existing.decayPercent;
            }
            if (typeof existing.decayDurationMs === 'number') {
                merged.decayDurationMs = existing.decayDurationMs;
            }
            if (typeof existing.depositEnabled === 'boolean') {
                merged.depositEnabled = existing.depositEnabled;
            }
            if (typeof existing.depositPercent === 'number') {
                merged.depositPercent = existing.depositPercent;
            }
        } else if (raw) {
            // If no existing proposal, try to get offer fields from raw input
            if (typeof raw.offer === 'number' && raw.offer > 0) {
                merged.offer = raw.offer;
            }
            if (raw.offerCurrency) {
                merged.offerCurrency = raw.offerCurrency;
            }
            if (typeof raw.decayEnabled === 'boolean') {
                merged.decayEnabled = raw.decayEnabled;
            }
            if (typeof raw.decayPercent === 'number') {
                merged.decayPercent = raw.decayPercent;
            }
            if (typeof raw.decayDurationMs === 'number') {
                merged.decayDurationMs = raw.decayDurationMs;
            }
            if (typeof raw.depositEnabled === 'boolean') {
                merged.depositEnabled = raw.depositEnabled;
            }
            if (typeof raw.depositPercent === 'number') {
                merged.depositPercent = raw.depositPercent;
            }
        }

        // Derive offer from chain balances if not already set
        // The smart contract stores balances in Wei (for ETH) or lamports (for SOL)
        const isSolanaProposal = typeof normalizedChainId === 'string' && normalizedChainId.startsWith('solana');
        if (!merged.offer || typeof merged.offer !== 'number' || merged.offer === 0) {
            // Try to derive offer from ethBalance (Wei for EVM, lamports for Solana)
            const ethBalanceStr = String(raw.ethBalance || normalized.ethBalance || '0');
            try {
                const nativeBalanceRaw = BigInt(ethBalanceStr);

                if (nativeBalanceRaw > 0n) {
                    // Convert Wei to ETH (10^18) or lamports to SOL (10^9)
                    const divisor = isSolanaProposal ? 1e9 : 1e18;
                    const ethAmount = Number(nativeBalanceRaw) / divisor;
                    merged.offer = ethAmount;
                    if (!merged.offerCurrency) {
                        merged.offerCurrency = isSolanaProposal ? 'SOL' : 'ETH';
                    }
                } else {
                    // Check tokenBalance as fallback
                    const tokenBalanceStr = String(raw.tokenBalance || normalized.tokenBalance || '0');
                    const tokenBalance = BigInt(tokenBalanceStr);

                    if (tokenBalance > 0n) {
                        // For tokens, we'd need to know the token decimals, but for now
                        // we'll assume 18 decimals (standard) and use a generic currency
                        const tokenAmount = Number(tokenBalance) / 1e18;
                        merged.offer = tokenAmount;
                        if (!merged.offerCurrency) {
                            merged.offerCurrency = 'USDT'; // Default to USDT for tokens
                        }
                    }
                }
            } catch (e) {
                console.warn('Failed to parse balance for proposal', proposalId, e);
            }
        }

        merged.proposalId = this._coerceProposalId(merged.proposalId);
        const authored = this._normalizeProposal(merged);
        this._indexProposal(authored);
        this.save();
        return authored;
    },

    load() {
        this._ensureIndexes();
        if (typeof PersistentStorage === 'undefined') return;
        let parsed = null;
        let hasValidEnvelope = false;
        let cutoverNeeded = false;
        try {
            const raw = PersistentStorage.getItem(PROPOSALS_STORAGE_KEY);
            parsed = raw ? JSON.parse(raw) : null;
            hasValidEnvelope = !!(parsed && !Array.isArray(parsed)
                && parsed.version === PROPOSALS_STATE_VERSION
                && Array.isArray(parsed.records));
            cutoverNeeded = PersistentStorage.getItem(PROPOSALS_CUTOVER_KEY) !== '1';
            this.proposals.clear();
            // An old array is intentionally not treated as authoritative local replay state. Keep
            // only records that are explicitly server/shared or minted; stale local materialization
            // is exactly what this cutover removes. Shared links are re-imported through their
            // normal server/shared path when no provenance is present in an old blob.
            const legacyRecords = Array.isArray(parsed)
                ? parsed
                : (Array.isArray(parsed?.records) ? parsed.records : []);
            const records = hasValidEnvelope
                ? parsed.records
                : (cutoverNeeded ? legacyRecords.filter(isServerOrSharedProposal) : []);
            records.forEach((entry, index) => {
                if (!entry) return;
                try {
                    const normalized = this._normalizeProposal({ ...entry });
                    if (!normalized.proposalId) {
                        const serverHintRaw = normalized.serverProposalId || normalized.id;
                        const serverHint = serverHintRaw && !isLocalProposalId(serverHintRaw)
                            ? String(serverHintRaw)
                            : null;
                        normalized.proposalId = serverHint || this._allocateProposalId();
                    }
                    this._indexProposal(normalized);
                } catch (error) {
                    const identity = entry.proposalId || entry.serverProposalId || entry.id || `record ${index + 1}`;
                    // One malformed authored record cannot erase every other local proposal. It is
                    // rejected at the record boundary and never enters replay or the proposal UI.
                    console.error(`[proposalStorage] Ignoring invalid stored proposal ${identity}`, error);
                }
            });

            if (hasValidEnvelope) {
                const storedNext = Number(parsed.nextProposalId);
                this.nextProposalId = Number.isFinite(storedNext) && storedNext >= 0
                    ? Math.floor(storedNext)
                    : 0;
            } else {
                const maxLocalId = Math.max(0, ...Array.from(this.proposals.keys()).map(id => {
                    const match = String(id).match(/local-(\d+)/);
                    if (match && match[1]) return parseInt(match[1], 10) || 0;
                    const asNum = parseInt(id, 10);
                    return Number.isFinite(asNum) ? asNum : 0;
                }));
                this.nextProposalId = maxLocalId + 1;
            }

            if (cutoverNeeded && !(typeof window !== 'undefined' && window.__cbSecondaryTab)) {
                this._runFreshLocalCutover();
                this._persist();
            }
        } catch (error) {
            console.error('proposalStorage.load: Failed to read the proposal-state envelope', error);
            this._ensureIndexes();
            this.proposals.clear();
            this.nextProposalId = 0;
            if (!(typeof window !== 'undefined' && window.__cbSecondaryTab)) {
                this._runFreshLocalCutover();
                this._persist();
            }
        }
    },

    _runFreshLocalCutover() {
        if (typeof PersistentStorage === 'undefined') return false;
        if (typeof window !== 'undefined' && window.__cbSecondaryTab) return false;
        try {
            // Never call PersistentStorage.clear(): server/shared proposal data, ownership, chain,
            // language and other city-scoped state live in the same key/value store.
            PersistentStorage.removeItem(PROPOSALS_NEXT_ID_KEY);
            PersistentStorage.removeItem(PROPOSALS_RECOVERY_KEY);
            const derivedKeys = [];
            if (typeof PersistentStorage.forEach === 'function') {
                PersistentStorage.forEach((_value, key) => {
                    if (isLegacyDerivedParcelKey(key)) derivedKeys.push(String(key));
                });
            } else if (typeof PersistentStorage.length === 'number'
                && typeof PersistentStorage.key === 'function') {
                for (let index = 0; index < PersistentStorage.length; index += 1) {
                    const key = PersistentStorage.key(index);
                    if (isLegacyDerivedParcelKey(key)) derivedKeys.push(String(key));
                }
            }
            derivedKeys.forEach(key => PersistentStorage.removeItem(key));
            PersistentStorage.setItem(PROPOSALS_CUTOVER_KEY, '1');
            return true;
        } catch (error) {
            console.warn('[proposalStorage] fresh local cutover failed', error);
            return false;
        }
    },

    save() {
        if (this._suspendSaveCount > 0) {
            this._hasPendingSave = true;
            return;
        }
        this._persist();
    },

    _persist() {
        if (typeof PersistentStorage === 'undefined') return;
        // Secondary tab (app already open elsewhere): skip writes so we don't clobber the primary
        // tab's data. All tabs share one blob with no cross-tab merge — see multi-tab-guard.js.
        // Say so every time: this used to return in complete silence, so a read-only tab looked
        // like a working one — proposals could be created, applied and rendered, and then simply
        // were not there after a reload, with nothing in the console to explain it. The guard's
        // banner is dismissable, so it cannot be the only signal that work is being dropped.
        if (typeof window !== 'undefined' && window.__cbSecondaryTab) {
            this._blockedWriteCount = (this._blockedWriteCount || 0) + 1;
            // Warning the user that work MIGHT be lost was never a licence to throw it away. The
            // reason a secondary tab must not write is that all tabs share ONE proposals blob with
            // no cross-tab merge, so saving here would clobber the primary tab's work. That argument
            // only covers the SHARED key — writing our own is harmless (PersistentStorage is a
            // key/value store; each key is its own record), so the work is parked under a private
            // recovery key and offered back the next time this city opens as the primary tab.
            this._persistRecovery();
            console.error('[proposalStorage] This tab is read-only because the app is open in another tab,'
                + ` so nothing here is saved to the shared store (dropped writes: ${this._blockedWriteCount}).`
                + ' Your work has been parked and will be offered back when you reload with the other tabs closed.');
            try { window.__cbReportSecondaryWriteBlocked?.(); } catch (_) { }
            return;
        }
        try {
            const serialisable = Array.from(this.proposals.values()).map(proposalRecordForPersistence);
            const state = proposalStateEnvelope(this.nextProposalId, serialisable);
            PersistentStorage.setItem(PROPOSALS_STORAGE_KEY, JSON.stringify(state));
        } catch (error) {
            console.error('proposalStorage.save: Failed to persist proposals', error);
            throw error;
        }
    },

    // Park this read-only tab's proposals under its own key so a reload cannot destroy them. Safe
    // against the primary: a different key is a different record, so the shared blob is untouched.
    // Best-effort by construction — a rescue that throws must never break the edit the user is
    // making, and it is only ever a second chance at work the tab could not save anyway.
    _persistRecovery() {
        if (typeof PersistentStorage === 'undefined') return;
        try {
            const serialisable = Array.from(this.proposals.values()).map(proposalRecordForPersistence);
            if (!serialisable.length) return;
            const state = proposalStateEnvelope(this.nextProposalId, serialisable);
            PersistentStorage.setItem(PROPOSALS_RECOVERY_KEY, JSON.stringify({
                ...state,
                savedAt: new Date().toISOString()
            }));
        } catch (error) {
            console.error('[proposalStorage] could not park read-only work for recovery', error);
        }
    },

    // What a previous read-only tab parked, or null. Read on load by the PRIMARY tab only — a
    // secondary tab offering to restore would just park it again on the next keystroke.
    readRecovery() {
        if (typeof PersistentStorage === 'undefined') return null;
        if (typeof window !== 'undefined' && window.__cbSecondaryTab) return null;
        try {
            const raw = PersistentStorage.getItem(PROPOSALS_RECOVERY_KEY);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            const proposals = Array.isArray(parsed && parsed.records) ? parsed.records : null;
            if (!proposals || !proposals.length) return null;
            // Only what this store does NOT already have: the usual case is that the user gave up
            // and redrew the road in the primary tab, and re-adding the parked copy would duplicate it.
            const missing = proposals.filter(entry => {
                const id = entry && (entry.proposalId || entry.id);
                return id && !this.proposals.has(String(id));
            });
            return missing.length ? { savedAt: parsed.savedAt || null, proposals: missing } : null;
        } catch (error) {
            console.error('[proposalStorage] could not read parked work', error);
            return null;
        }
    },

    // Merge parked work back in and clear the slot. Returns how many were restored.
    restoreRecovery() {
        const parked = this.readRecovery();
        if (!parked) return 0;
        parked.proposals.forEach(entry => {
            try { this.addProposal({ ...entry }); } catch (error) {
                console.error('[proposalStorage] could not restore a parked proposal', error);
            }
        });
        this.discardRecovery();
        return parked.proposals.length;
    },

    discardRecovery() {
        if (typeof PersistentStorage === 'undefined') return;
        try { PersistentStorage.removeItem(PROPOSALS_RECOVERY_KEY); } catch (_) { }
    },

    getAllProposals() {
        return Array.from(this.proposals.values());
    },

    /**
     * Remove minted proposals that are not on the provided chain (or have unknown chain)
     * Used when the active chain changes to prevent cross-chain mixing in UI caches.
     * @param {string|number|null} chainId - normalized chain id to keep
     * @returns {number} removed count
     */
    purgeMintedProposalsNotOnChain(chainId) {
        const normalizedTarget = typeof normalizeChainId === 'function'
            ? normalizeChainId(chainId)
            : (chainId !== undefined && chainId !== null ? String(chainId) : null);

        let removed = 0;
        for (const [id, proposal] of this.proposals.entries()) {
            if (!proposal || proposal.isMinted !== true) continue;
            const proposalChain = typeof normalizeChainId === 'function'
                ? normalizeChainId(proposal.chainId || (proposal.onchain && proposal.onchain.chainId))
                : (proposal.chainId || (proposal.onchain && proposal.onchain.chainId) || null);

            const keep = normalizedTarget && proposalChain === normalizedTarget;
            if (!keep) {
                this.removeProposal(id);
                removed += 1;
            }
        }
        if (removed > 0 && typeof this.save === 'function') {
            this.save();
        }
        return removed;
    },

    getProposal(idOrHash) {
        const resolvedId = this._resolveProposalId(idOrHash);
        return resolvedId ? this.proposals.get(resolvedId) || null : null;
    },

    getProposalsForParcel(parcelId) {
        const id = normalizeParcelId(parcelId);
        if (!id) {
            return [];
        }
        // Project a live parcel through its explicit fabric provenance. Generated-id syntax carries
        // no semantics: two disconnected pieces may deliberately share one cadastral source and a
        // future id format must not change which authored records claim the clicked ground.
        const runtimeRoot = typeof window !== 'undefined' ? window : globalThis;
        const fabric = runtimeRoot && runtimeRoot.LiveParcelFabric;
        const liveFeature = fabric && typeof fabric.get === 'function' ? fabric.get(id) : null;
        const cadastralFeature = !liveFeature && runtimeRoot?.CadastralParcelRepository?.get
            ? runtimeRoot.CadastralParcelRepository.get(id)
            : null;
        const cadastreIds = liveFeature && typeof fabric.explicitCadastreIds === 'function'
            ? fabric.explicitCadastreIds(liveFeature)
            : (cadastralFeature ? [id] : []);
        const matchIds = new Set(cadastreIds.map(String));
        const matchesId = value => {
            const normalized = normalizeParcelId(value);
            return normalized !== null && matchIds.has(normalized);
        };
        const results = [];
        for (const proposal of this.proposals.values()) {
            const cadastreIds = Array.isArray(proposal.cadastreParcelIds) ? proposal.cadastreParcelIds : [];
            if (cadastreIds.some(matchesId)) {
                results.push(proposal);
            }
        }
        return results;
    },

    addProposal(proposal, options = {}) {
        if (!proposal || typeof proposal !== 'object') return null;

        if (typeof this._ensureIndexes === 'function') {
            this._ensureIndexes();
        }

        // A live selection is authoring input, not proposal data. Project it exactly once here and
        // keep generated parcel ids out of the record passed to normalization/persistence.
        const candidate = proposalWithAuthoredSelection(
            { ...proposal },
            options.selectedParcelIds
        );
        const normalized = this._normalizeProposal(candidate);
        const seed = this._buildHashSeed(normalized);
        const duplicate = this._findDuplicateBySeed(seed);
        if (duplicate) {
            console.debug('[proposalStorage] Duplicate seed detected; allowing insert', { seed, existingId: duplicate.proposalId });
        }

        normalized.createdAt = normalized.createdAt || new Date().toISOString();
        normalized.updatedAt = new Date().toISOString();

        // Ensure proposals get a deterministic, stable ID derived from immutable inputs
        if (!normalized.proposalId || isLocalProposalId(normalized.proposalId)) {
            normalized.proposalId = this._buildDeterministicId(normalized);
        }

        // Local proposals default to not minted
        if (normalized.isMinted === undefined || normalized.isMinted === null) {
            normalized.isMinted = false;
        }

        // Ensure legacy hash fields are removed

        normalized.proposalId = this._coerceProposalId(normalized.proposalId);
        if (this.proposals && this.proposals.has(normalized.proposalId)) {
            const suffix = Date.now().toString(36);
            normalized.proposalId = `${normalized.proposalId}-${suffix}`;
        }
        if (normalized.roadProposal) {
            normalized.roadProposal.id = normalized.proposalId;
            normalized.roadProposal.proposalId = normalized.proposalId;
        }

        this._indexProposal(normalized);
        if (options.deferSave !== true) this.save();
        try {
            if (options.emitEvent !== false && typeof document !== 'undefined' && typeof CustomEvent === 'function') {
                document.dispatchEvent(new CustomEvent('proposalCreated', {
                    detail: { proposalId: normalized.proposalId }
                }));
            }
        } catch (_) { }
        return normalized.proposalId;
    },

    importProposal(proposal, options = {}) {
        if (!proposal || typeof proposal !== 'object') {
            return null;
        }

        const { overwrite = true, preserveStatus = false, deferSave = false } = options;
        const normalized = this._normalizeProposal({ ...proposal });

        if (!preserveStatus) {
            const executed = getLifecycleStatus(normalized) === 'Executed';
            normalized.lifecycleStatus = executed ? 'Executed' : 'Active';
            // childParcelIds arriving on an imported proposal are just the uploader's produced-ids
            // cache; they are NOT reproduced. On apply, children are re-derived from (parents +
            // rule) and get freshly minted ids from the id subsystem. Child-id identity is a local
            // concern of each apply — the consensus layer is parent-keyed — so we do not try to
            // match the uploader's ids.
        }

        // Importing only stores a definition. Even an Executed proposal has not been materialised
        // in this browser yet; an explicit single-proposal or shared-plan flow applies it afterward.
        parkProposalForImport(normalized);

        normalized.createdAt = normalized.createdAt || new Date().toISOString();
        normalized.updatedAt = new Date().toISOString();

        // Preserve the original server ID before potentially replacing with hash-based ID.
        const incomingId = this._coerceProposalId(normalized.proposalId);
        const isNumericServerId = incomingId && /^\d+$/.test(incomingId);
        if (isNumericServerId && !normalized.serverProposalId) {
            normalized.serverProposalId = incomingId;
        }

        let idKey = incomingId;
        if (!idKey || isLocalProposalId(idKey)) {
            idKey = this._buildDeterministicId(normalized);
        }
        normalized.proposalId = idKey;

        if (!overwrite && idKey && this.proposals.has(idKey)) {
            return null;
        }

        this._indexProposal(normalized);
        if (!deferSave) this.save();
        return normalized;
    },

    removeProposal(idOrHash) {
        const resolvedId = this._resolveProposalId(idOrHash);
        const existing = resolvedId ? this.proposals.get(resolvedId) : null;
        const deleted = resolvedId ? this.proposals.delete(resolvedId) : false;
        if (deleted) {
            this.save();
            if (typeof removeExecutedBuildingByProposalId === 'function') {
                try {
                    removeExecutedBuildingByProposalId(existing?.proposalId || idOrHash);
                } catch (error) {
                    console.warn('removeExecutedBuildingByProposalId failed', error);
                }
            }
        }
        return deleted && existing ? existing : null;
    },

    clear() {
        this.proposals.clear();
        if (typeof PersistentStorage !== 'undefined') {
            PersistentStorage.removeItem(PROPOSALS_STORAGE_KEY);
            PersistentStorage.removeItem(PROPOSALS_NEXT_ID_KEY);
            PersistentStorage.removeItem(PROPOSALS_CUTOVER_KEY);
            PersistentStorage.removeItem(PROPOSALS_RECOVERY_KEY);
        }
    },

    // Lifecycle-only mutation. It deliberately does not infer or change local map visibility.
    setProposalLifecycleStatus(proposalId, lifecycleStatus) {
        const proposal = this.getProposal(proposalId);
        if (!proposal) return false;
        proposal.lifecycleStatus = getLifecycleStatus({ lifecycleStatus });
        proposal.updatedAt = new Date().toISOString();
        this._indexProposal(proposal);
        return true;
    },

    // Epoch bucket ("Kumulativno do godine" timeline) — shared plan metadata, ne lokalna vidljivost.
    setProposalEpochYear(proposalId, epochYear) {
        const proposal = this.getProposal(proposalId);
        if (!proposal) return false;
        proposal.epochYear = (typeof epochYear === 'number' && Number.isInteger(epochYear)) ? epochYear : null;
        proposal.updatedAt = new Date().toISOString();
        this._indexProposal(proposal);
        this.save();
        return true;
    },

    // Label-only mutation. name and title move together because the lists read `title || name`;
    // setting one and not the other renames the proposal in some views and not in others.
    setProposalName(proposalId, name) {
        const proposal = this.getProposal(proposalId);
        if (!proposal) return false;
        const text = (name === undefined || name === null) ? '' : String(name).trim();
        if (!text) return false;
        proposal.name = text;
        proposal.title = text;
        proposal.updatedAt = new Date().toISOString();
        this._indexProposal(proposal);
        this.save();
        return true;
    },

    setProposalApplied(proposalId, applied) {
        const proposal = this.getProposal(proposalId);
        if (!proposal) return false;
        if (typeof window !== 'undefined' && typeof window.setProposalApplied === 'function') {
            window.setProposalApplied(proposal, applied);
        } else {
            proposal.applied = applied === true;
        }
        proposal.updatedAt = new Date().toISOString();
        this._indexProposal(proposal);
        return true;
    },

    _normalizeProposal(proposal, context = {}) {
        const { existingHash = null } = context || {};
        const root = typeof window !== 'undefined' ? window : globalThis;
        const depthApi = root && root.__formationDepth;
        if (!depthApi || typeof depthApi.stripDerivedRecordData !== 'function') {
            throw new Error('Cannot normalize proposal: the authored-record projection is unavailable.');
        }
        requireExactCadastreAnchors(proposal, 'load');
        // Remote, stored and newly authored records all enter the same strict representation.
        // Local live selection is a separate addProposal option and has already been projected.
        // This function never interprets an alias or asks the live fabric to explain record data.
        const candidate = canonicalizeProposalCadastreAnchors(proposal);
        const invalid = typeof depthApi.findNonCadastralReference === 'function'
            ? depthApi.findNonCadastralReference(candidate)
            : null;
        if (invalid) {
            throw new Error(`Cannot load proposal: ${invalid.path} contains live parcel id ${invalid.id}; migrate the record first.`);
        }
        const verdict = typeof depthApi.conformanceOf === 'function'
            ? depthApi.conformanceOf(candidate)
            : { flat: true };
        if (!verdict.flat) {
            const conflict = verdict.violations?.[0];
            throw new Error(`Cannot load proposal: ${conflict?.field || conflict?.code || 'cadastral declaration'} conflicts with cadastreParcelIds; migrate the record first.`);
        }
        proposal = canonicalizeProposalCadastreAnchors(candidate);
        proposal = depthApi.stripDerivedRecordData(proposal);
        // Authored records contain definitions and authored geometry only. Runtime materialized
        // features live exclusively in LiveParcelFabric and are looked up by proposal id.
        delete proposal.parentFeatures;
        delete proposal.childFeatures;
        if (proposal.geometry && typeof proposal.geometry === 'object') {
            delete proposal.geometry.parentFeatures;
            delete proposal.geometry.childFeatures;
            if (proposal.roadProposal) {
                delete proposal.geometry.roadPlan;
                delete proposal.geometry.roadGeometry;
                if (Object.keys(proposal.geometry).length === 0) delete proposal.geometry;
            }
        }
        if (proposal.roadProposal) {
            delete proposal.definition;
            delete proposal.roadProposal.roadGeometry;
        }
        const normalizedCadastreParcelIds = normalizeParcelIdList(proposal.cadastreParcelIds || []);
        proposal.cadastreParcelIds = normalizedCadastreParcelIds;
        proposal.acceptedParcelIds = normalizeParcelIdList(proposal.acceptedParcelIds || []);
        proposal.ownerAcceptances = normalizeOwnerAcceptances(proposal.ownerAcceptances || {});
        // Canonical current-record shape. Missing application state means locally unapplied;
        // legacy interpretation belongs exclusively to migrate-tessellation.js.
        normalizeProposalStatusAxes(proposal);
        delete proposal.similarityHash;
        proposal.lens = normalizeLensEntries(
            proposal.lens
            || proposal.lensEntries
            || proposal.lensAddresses
            || proposal.trustedLens
            || []
        );

        // Normalize identity to proposalId and drop legacy hash fields
        this._normalizeProposalIdentity(proposal, { existingHash });

        // Minted flag default (keep local-only proposals as not minted)
        if (proposal.isMinted === undefined || proposal.isMinted === null) {
            proposal.isMinted = !!(proposal.onchain && proposal.onchain.transactionHash);
        } else {
            proposal.isMinted = !!proposal.isMinted;
        }

        // Ensure proposalId is preserved (it is the canonical key used across the UI and persistence).
        // IMPORTANT: Do NOT delete proposal.proposalId here, otherwise uploaded proposals lose their server id on save,
        // and reload will re-wrap them as local-*.
        const derivedId = proposal.proposalId
            ?? proposal.serverProposalId
            ?? proposal.id
            ?? proposal.tokenId
            ?? existingHash;
        if (derivedId !== undefined && derivedId !== null && String(derivedId).trim().length > 0) {
            proposal.proposalId = String(derivedId);
        }

        // If still missing or local-like, assign deterministic hash-based id
        if (!proposal.proposalId || isLocalProposalId(proposal.proposalId)) {
            try {
                proposal.proposalId = proposalStorage._buildDeterministicId(proposal);
            } catch (_) { /* fallback handled elsewhere */ }
        }
        proposal.goal = normalizeProposalGoalKey(proposal.goal);
        if (!proposal.goal) {
            if (proposal.decideLaterProposal) {
                proposal.goal = 'decide-later';
            } else if (proposal.roadProposal) {
                proposal.goal = 'road-track';
            } else if (proposal.reparcellization) {
                proposal.goal = 'reparcellization';
            } else if (proposal.structureProposal && proposal.structureProposal.kind) {
                const kind = normalizeProposalGoalKey(proposal.structureProposal.kind);
                proposal.goal = (kind === 'park' || kind === 'square' || kind === 'lake' || kind === 'station') ? kind : 'square';
            } else if (proposal.buildingProposal || proposal.buildingGeometry) {
                proposal.goal = 'buildings';
            } else {
                proposal.goal = 'parcel';
            }
        }

        if (proposal.roadProposal) {
            const rp = { ...proposal.roadProposal };
            if (rp.parentsKeepDetails && typeof rp.parentsKeepDetails !== 'object') {
                rp.parentsKeepDetails = null;
            }
            delete rp.parentFeatures;
            delete rp.childFeatures;
            proposal.roadProposal = rp;
        }

        if (proposal.buildingProposal) {
            const bp = { ...proposal.buildingProposal };
            bp.parameters = bp.parameters && typeof bp.parameters === 'object' ? { ...bp.parameters } : {};
            Object.keys(bp.parameters).forEach(key => {
                if (bp.parameters[key] === undefined || bp.parameters[key] === null) {
                    delete bp.parameters[key];
                }
            });

            if (!proposal.geometry) proposal.geometry = {};

            proposal.buildingProposal = bp;
        } else if (['buildings', 'building(s)', 'single-building', 'parcelBased'].includes(normalizeProposalGoalKey(proposal.goal) || '')) {
            proposal.buildingProposal = {
                parameters: {}
            };
            if (!proposal.geometry) proposal.geometry = {};
        }

        // Normalize structure proposals (parks/squares/lakes/stations)
        if (proposal.structureProposal) {
            const sp = { ...proposal.structureProposal };
            sp.kind = (sp.kind === 'park' || sp.kind === 'square' || sp.kind === 'lake' || sp.kind === 'station') ? sp.kind : 'square';
            if (sp.geometry) {
                try { sp.geometry = JSON.parse(JSON.stringify(sp.geometry)); } catch (_) { }
            }
            if (sp.blockName === undefined) {
                sp.blockName = null;
            }
            proposal.structureProposal = sp;
            proposal.goal = normalizeProposalGoalKey(sp.kind) || proposal.goal;
        }

        return proposal;
    },

    _buildHashSeed(proposal) {
        // Canonical, immutable inputs only (no titles/offers/lens). Used for stable proposalId.
        const parts = [];
        const city = (typeof getCurrentCityId === 'function') ? getCurrentCityId() : (proposal.city || '');
        const goal = normalizeProposalGoalKey(proposal.goal) || 'parcel';
        const parentIds = normalizeParcelIdList(proposal.cadastreParcelIds || []);

        parts.push(`city:${city}`);
        parts.push(`goal:${goal}`);
        parts.push(`parents:${parentIds.join(',')}`);

        // Road / track
        const roadDef = proposal.roadProposal?.definition || null;
        if (roadDef) {
            parts.push(`roadDef:${serialiseRoadDefinition(roadDef)}`);
        }
        if (proposal.roadProposal?.mode) {
            parts.push(`roadMode:${proposal.roadProposal.mode}`);
        }

        // Building proposals
        if (proposal.buildingProposal) {
            if (proposal.buildingProposal.parameters) {
                // stableStringify (shared-utils.js) sorts keys at every level and keeps nested keys.
                // The old JSON.stringify(params, sortedKeys) used an array replacer, which drops any
                // nested key not in the top-level list — so two building proposals differing only in
                // a nested param hashed identically and one silently overwrote the other. For today's
                // flat params it yields the identical string, so existing ids are unchanged.
                try { parts.push(`buildingParams:${stableStringify(proposal.buildingProposal.parameters)}`); } catch (_) { }
            }
        }
        // Structure (park/square/lake/station)
        if (proposal.structureProposal) {
            const sp = proposal.structureProposal;
            parts.push(`structureKind:${sp.kind || ''}`);
            if (sp.geometry) parts.push(`structureGeom:${serialiseGeometry(sp.geometry)}`);
            if (sp.kind === 'station') {
                parts.push(`stationType:${sp.stationType || ''}`);
                parts.push(`stationCenter:${Array.isArray(sp.center) ? sp.center.join(',') : ''}`);
                parts.push(`stationBearing:${Number.isFinite(Number(sp.bearing)) ? Number(sp.bearing).toFixed(3) : ''}`);
                parts.push(`stationPlatformHeight:${Number.isFinite(Number(sp.platformHeightM)) ? Number(sp.platformHeightM).toFixed(2) : ''}`);
            }
        }

        // Reparcellization
        if (proposal.reparcellization) {
            const rep = proposal.reparcellization;
            parts.push(`reparcAlg:${rep.algorithm || ''}`);
            if (Array.isArray(rep.polygons)) {
                try { parts.push(`reparcPolys:${JSON.stringify(rep.polygons)}`); } catch (_) { }
            }
        }

        // Fallback geometry if present
        if (proposal.geometry) {
            try { parts.push(`geom:${JSON.stringify(proposal.geometry)}`); } catch (_) { }
        }

        return parts.join('|');
    },

    _buildDeterministicId(proposal) {
        const seed = this._buildHashSeed(proposal);
        const digest = hashStringDeterministic(seed);
        return `p-${digest}`;
    },

    _findDuplicateBySeed(seed) {
        for (const proposal of this.proposals.values()) {
            if (this._buildHashSeed(proposal) === seed) {
                return proposal;
            }
        }
        return null;
    }
};

const proposalHighlightState = {
    activeParcelIds: new Set(),
    activeChildFeatures: [],
    activeParentFeatures: [],
    activeProposalId: null,
    pendingBlink: false
};

const proposalHighlightStyleOverride = {
    _stash: new Map(), // Map<layer, {original, applied}>

    _snapshotLayerStyle(layer) {
        const opts = layer && layer.options ? layer.options : {};
        return {
            color: opts.color,
            weight: opts.weight,
            opacity: opts.opacity,
            fillColor: opts.fillColor,
            fillOpacity: opts.fillOpacity,
            dashArray: opts.dashArray,
            className: opts.className
        };
    },

    apply(layer, styleOptions) {
        if (!layer || typeof layer.setStyle !== 'function') return false;
        if (!this._stash.has(layer)) {
            this._stash.set(layer, { original: this._snapshotLayerStyle(layer), applied: styleOptions });
        } else {
            // Update the applied style so reapply() always restores the latest proposal style.
            this._stash.get(layer).applied = styleOptions;
        }
        try {
            layer.setStyle(styleOptions);
            return true;
        } catch (_) {
            return false;
        }
    },

    // Returns true if this layer currently has a proposal highlight stashed.
    has(layer) {
        return this._stash.has(layer);
    },

    // Re-applies the most recently set proposal style on this layer.
    // Called from selection.js resetHighlight to undo hover styling.
    reapply(layer) {
        const entry = this._stash.get(layer);
        if (!entry || !entry.applied) return false;
        try {
            layer.setStyle(entry.applied);
            return true;
        } catch (_) {
            return false;
        }
    },

    restoreAll() {
        if (this._stash.size === 0) return;
        const entries = Array.from(this._stash.entries());
        this._stash.clear();
        for (const [layer, entry] of entries) {
            if (!layer || typeof layer.setStyle !== 'function') continue;
            try {
                layer.setStyle(entry.original);
            } catch (_) { /* best-effort */ }
        }
    }
};

const multiParcelSelection = {
    isActive: false,
    selectedParcels: new Set(),
    lastSelectedParcelId: null,

    // Toggle multi-selection mode
    toggle(options = {}) {
        const preserveSelectedParcel = !!options.preserveSelectedParcel;
        const restoreSingleSelection = options.restoreSingleSelection !== false;
        const wasActive = this.isActive;
        this.isActive = !this.isActive;

        if (wasActive && !this.isActive) {
            const fallbackParcelId = this.lastSelectedParcelId ||
                (this.selectedParcels.size > 0 ? Array.from(this.selectedParcels).slice(-1)[0] : null) ||
                (typeof selectedParcelId !== 'undefined' && selectedParcelId ? selectedParcelId.toString() : null);

            this.clearSelection();
            if (restoreSingleSelection) {

                if (fallbackParcelId && typeof selectParcel === 'function') {
                    try {
                        selectParcel(fallbackParcelId, true);
                    } catch (error) {
                        console.warn('multiParcelSelection.toggle: failed to reselect fallback parcel', error);
                        this.hideParcelInfo();
                    }
                } else {
                    this.hideParcelInfo();
                }
            }
        } else if (!wasActive && this.isActive) {
            const hasCurrentParcel = typeof currentParcel !== 'undefined' && currentParcel && currentParcel.id;
            const fallbackParcelId = !hasCurrentParcel && typeof selectedParcelId !== 'undefined' && selectedParcelId
                ? selectedParcelId.toString()
                : null;
            const preservedParcelInfo = (preserveSelectedParcel && (hasCurrentParcel || fallbackParcelId))
                ? {
                    id: hasCurrentParcel ? currentParcel.id.toString() : fallbackParcelId,
                    layer: this.findParcelById(hasCurrentParcel ? currentParcel.id : fallbackParcelId)
                }
                : null;

            // Always seed multi-select with the currently viewed parcel (or the last single selection)
            let seedInfo = preservedParcelInfo;
            if (!seedInfo) {
                const seedId = hasCurrentParcel
                    ? currentParcel.id.toString()
                    : (fallbackParcelId || null);
                if (seedId) {
                    const seedLayer = this.findParcelById(seedId);
                    if (seedLayer) {
                        seedInfo = { id: seedId, layer: seedLayer };
                    }
                }
            }

            this.selectedParcels.clear();

            if (seedInfo && seedInfo.id) {
                this.clearSingleParcelSelection({ preservePanel: true });
                this.selectedParcels.add(seedInfo.id);
                this.lastSelectedParcelId = seedInfo.id;
                const targetLayer = seedInfo.layer || this.findParcelById(seedInfo.id);
                if (targetLayer) {
                    this.addParcelHighlight(targetLayer);
                }
            } else {
                this.clearSingleParcelSelection();
            }
        }

        this.updateUI();
    },

    // Clear any currently selected single parcel
    clearSingleParcelSelection(options = {}) {
        const preservePanel = !!options.preservePanel;
        if (typeof selectedParcelId !== 'undefined' && selectedParcelId) {
            const selectedLayer = window.LiveParcelFabric?.get?.(selectedParcelId)
                ? window.ParcelPresenter?.getLayer?.(selectedParcelId)
                : null;
            if (selectedLayer) this.removeParcelHighlight(selectedLayer);

            // Clear the global selected parcel state
            window.selectedParcelId = null;
            if (typeof currentParcel !== 'undefined') {
                window.currentParcel = null;
            }

            // Hide single parcel info panel if it's showing and showing parcel info
            const parcelInfoPanel = document.getElementById('parcel-info-panel');
            const panelTitle = document.querySelector('#parcel-info-panel h3');
            if (!preservePanel && parcelInfoPanel && parcelInfoPanel.classList.contains('visible') &&
                panelTitle && panelTitle.textContent.trim().startsWith('Parcel')) {
                if (typeof hideParcelInfoPanel === 'function') {
                    hideParcelInfoPanel();
                }
            }
        }
    },

    // Add or remove parcel from selection
    toggleParcel(parcel) {
        if (!this.isActive) return false;

        const parcelId = window.ParcelPresenter?.getIdForLayer?.(parcel)?.toString();
        if (!parcelId) return false;

        if (this.selectedParcels.has(parcelId)) {
            this.selectedParcels.delete(parcelId);
            this.removeParcelHighlight(parcel);
            if (this.lastSelectedParcelId === parcelId) {
                this.lastSelectedParcelId = this.selectedParcels.size > 0
                    ? Array.from(this.selectedParcels).slice(-1)[0]
                    : null;
            }
        } else {
            this.selectedParcels.add(parcelId);
            this.lastSelectedParcelId = parcelId;
            this.addParcelHighlight(parcel);
        }

        this.updateUI();
        return true;
    },

    // Clear all selected parcels
    clearSelection() {
        // Remove highlights from all selected parcels
        this.selectedParcels.forEach(parcelId => {
            const parcel = this.findParcelById(parcelId);
            if (parcel) {
                this.removeParcelHighlight(parcel);
            }
        });
        this.selectedParcels.clear();
        this.lastSelectedParcelId = null;

        // Also clear any currently selected single parcel to avoid conflicts
        if (typeof selectedParcelId !== 'undefined' && selectedParcelId) {
            const selectedLayer = window.LiveParcelFabric?.get?.(selectedParcelId)
                ? window.ParcelPresenter?.getLayer?.(selectedParcelId)
                : null;
            if (selectedLayer) this.removeParcelHighlight(selectedLayer);
            window.selectedParcelId = null;
        }

        this.updateUI();
    },

    // Resolve one exact current live identity. Expanding a cadastral anchor into whatever happens
    // to occupy it is a set operation, not a singular lookup; callers that need that operation use
    // ParcelPresenter.resolveLiveLayers explicitly. Keeping this exact prevents a click/selection
    // from silently changing meaning after a parcel is cut.
    findParcelById(parcelId) {
        if (parcelId === undefined || parcelId === null) return null;
        const targetId = parcelId.toString();
        if (!targetId) return null;
        const root = typeof globalThis !== 'undefined' ? globalThis : {};
        const fabric = root.LiveParcelFabric
            || (typeof window !== 'undefined' ? window.LiveParcelFabric : null);
        const presenter = root.ParcelPresenter
            || (typeof window !== 'undefined' ? window.ParcelPresenter : null);
        if (!fabric || !presenter) return null;

        return typeof fabric.get === 'function' && fabric.get(targetId)
            && typeof presenter.getLayer === 'function'
            ? (presenter.getLayer(targetId) || null)
            : null;
    },

    // Selection is a view of one committed fabric revision. When a commit replaces parcel
    // identities, remove identities that no longer exist and synchronously repaint the survivors.
    // We deliberately do not guess which new piece should inherit a removed selection.
    reconcileWithFabric() {
        const fabric = window.LiveParcelFabric;
        const presenter = window.ParcelPresenter;
        if (!fabric || !presenter) return false;

        let changed = false;
        for (const id of Array.from(this.selectedParcels)) {
            if (fabric.get(id)) continue;
            this.selectedParcels.delete(id);
            changed = true;
        }
        if (this.lastSelectedParcelId && !fabric.get(this.lastSelectedParcelId)) {
            this.lastSelectedParcelId = this.selectedParcels.size
                ? Array.from(this.selectedParcels).slice(-1)[0]
                : null;
            changed = true;
        }

        const singleId = window.selectedParcelId === undefined || window.selectedParcelId === null
            ? null
            : String(window.selectedParcelId);
        if (singleId && !fabric.get(singleId)) {
            window.selectedParcelId = null;
            window.currentParcel = null;
            changed = true;
        } else if (singleId) {
            const layer = presenter.getLayer(singleId);
            if (layer) window.currentParcel = { ...(window.currentParcel || {}), id: singleId, layer };
        }

        this.selectedParcels.forEach(id => {
            const layer = presenter.getLayer(id);
            if (layer) this.addParcelHighlight(layer);
        });
        if (changed) this.updateUI();
        return changed;
    },

    // Add highlight to selected parcel
    addParcelHighlight(parcel) {
        // Apply multi-selection style (matches .parcel-layer.multi-selected CSS)
        parcel.setStyle({
            fillColor: '#ff9800',
            fillOpacity: 0.6,
            color: '#f57c00',
            weight: 3
        });
        parcel.bringToFront();
    },

    // Remove highlight from parcel
    removeParcelHighlight(parcel) {
        const parcelId = window.ParcelPresenter?.getIdForLayer?.(parcel) || null;
        const baseStyle = (typeof getParcelBaseStyle === 'function')
            ? getParcelBaseStyle(parcelId)
            : (() => {
                const isRoad = (parcelId && typeof window.isRoadParcel === 'function') ? window.isRoadParcel(parcelId) : false;
                const globalRoadStyle = window.roadStyle || {
                    fillColor: '#00ff00', fillOpacity: 0.2, color: '#00ff00', weight: 1
                };
                const globalNormalStyle = window.normalStyle || {
                    fillColor: 'red', fillOpacity: 0.2, color: 'red', weight: 1
                };
                return isRoad ? globalRoadStyle : globalNormalStyle;
            })();
        parcel.setStyle(baseStyle);
    },

    // Get selected parcels as array
    getSelectedParcels() {
        const parcels = Array.from(this.selectedParcels).map(id => this.findParcelById(id)).filter(p => p);
        console.debug('getSelectedParcels called, selectedParcels size:', this.selectedParcels.size, 'found parcels:', parcels.length);
        return parcels;
    },

    // Update UI based on current selection
    updateUI() {
        syncMultiSelectCheckboxes(this.isActive);


        const count = this.selectedParcels.size;
        if (count >= 2) {
            this.showMultiParcelInfo();
        } else if (count === 1 && this.isActive) {
            // Show single parcel info even in multi-select mode
            const parcels = this.getSelectedParcels();
            if (parcels.length === 1) {
                const parcel = parcels[0];
                if (typeof showParcelInfoPanel === 'function') {
                    // Ensure parcel-specific buttons are visible for single parcel view
                    const parcelButtons = document.querySelector('.parcel-info-buttons');
                    if (parcelButtons) {
                        parcelButtons.style.display = '';
                    }

                    // Clear all tab content
                    const infoContent = document.getElementById('info-content');
                    const proposalsContent = document.getElementById('proposals-content');
                    if (infoContent) infoContent.innerHTML = '';
                    if (proposalsContent) proposalsContent.innerHTML = '';

                    const parcelId = window.ParcelPresenter?.getIdForLayer?.(parcel);
                    const feature = parcelId ? window.LiveParcelFabric?.get?.(parcelId) : null;
                    if (feature) {
                        showParcelInfoPanel(feature);
                        document.getElementById('parcel-info-panel').classList.add('visible');
                        setParcelInfoPanelTitle(
                            window.i18n ? window.i18n.t('panel.parcel.multiSelectionTitle', {}) : 'Multiparcel selection',
                            { i18nKey: 'panel.parcel.multiSelectionTitle' }
                        );
                    }
                }
            }
        } else if (count === 0 && this.isActive) {
            this.hideParcelInfo();
        } else if (!this.isActive && count === 0) {
            // Multi-select is off and no selection - hide panel
            this.hideParcelInfo();
        }

        // Update create proposal button visibility
        this.updateCreateProposalButton();

        if (typeof renderParcelProposalActions === 'function') {
            renderParcelProposalActions();
        }

        if (this.isActive) {
            const panel = document.getElementById('parcel-info-panel');
            if (panel && panel.classList.contains('visible')) {
                setParcelInfoPanelTitle(
                    window.i18n ? window.i18n.t('panel.parcel.multiSelectionTitle', {}) : 'Multiparcel selection',
                    { i18nKey: 'panel.parcel.multiSelectionTitle' }
                );
            }

            if (typeof window !== 'undefined' && window.ParcelsUIClaim && typeof window.ParcelsUIClaim.setParcelClaimButtonsState === 'function') {
                window.ParcelsUIClaim.setParcelClaimButtonsState('not-minted');
            }
        }
    },

    // Show multi-parcel info panel
    showMultiParcelInfo() {
        const parcels = this.getSelectedParcels();
        const avgSqmPrice = (typeof SQM_AVG_PRICE !== 'undefined' ? SQM_AVG_PRICE : 133);

        const parcelSummaries = parcels.map(parcel => {
            const parcelId = window.ParcelPresenter?.getIdForLayer?.(parcel) || null;
            const feature = parcelId ? window.LiveParcelFabric?.get?.(String(parcelId)) : null;
            const props = feature?.properties || {};
            const areaSource = props.calculatedArea
                || props.area
                || props.parcelArea
                || props.informationTechnical?.superficie_total;
            const area = Number.isFinite(Number(areaSource)) ? Number(areaSource) : 0;
            const explicitPrice = Number(props.estimatedMarketPrice);
            const price = Number.isFinite(explicitPrice) ? explicitPrice : (area ? area * avgSqmPrice : 0);
            const currency = props.estimatedMarketPriceCurrency || props.currency || 'EUR';
            return { parcel, parcelId, feature, area, price, currency };
        }).filter(summary => summary.feature);

        const totalArea = parcelSummaries.reduce((sum, p) => sum + (p.area || 0), 0);
        const totalEstimatedPrice = parcelSummaries.reduce((sum, p) => sum + (p.price || 0), 0);

        // Calculate total owners across all parcels
        let totalOwners = 0;
        const ownerKeys = new Set();
        if (typeof getParcelOwnerSlots === 'function') {
            for (const parcel of parcels) {
                const parcelId = window.ParcelPresenter?.getIdForLayer?.(parcel) || null;
                if (parcelId) {
                    try {
                        const slots = getParcelOwnerSlots(parcelId.toString());
                        if (Array.isArray(slots) && slots.length > 0) {
                            slots.forEach(slot => {
                                const key = slot.key || slot.displayName || `parcel:${parcelId}:${slot.displayName || 'owner'}`;
                                if (key && !ownerKeys.has(key)) {
                                    ownerKeys.add(key);
                                    totalOwners++;
                                }
                            });
                        } else {
                            // If no slots found, count as 1 owner per parcel
                            const fallbackKey = `parcel:${parcelId}:fallback`;
                            if (!ownerKeys.has(fallbackKey)) {
                                ownerKeys.add(fallbackKey);
                                totalOwners++;
                            }
                        }
                    } catch (error) {
                        // If owner slots can't be retrieved, count as 1 owner per parcel
                        const fallbackKey = `parcel:${parcelId}:error`;
                        if (!ownerKeys.has(fallbackKey)) {
                            ownerKeys.add(fallbackKey);
                            totalOwners++;
                        }
                    }
                }
            }
        }
        // Fallback: if we couldn't calculate, use parcel count as estimate
        if (totalOwners === 0) {
            totalOwners = parcels.length;
        }

        setParcelInfoPanelTitle(
            window.i18n ? window.i18n.t('panel.parcel.multiSelectionTitle', {}) : 'Multiparcel selection',
            { i18nKey: 'panel.parcel.multiSelectionTitle' }
        );

        // Keep parcel tools visible so multi-select mint remains accessible
        const parcelButtons = document.querySelector('.parcel-info-buttons');
        if (parcelButtons) {
            parcelButtons.style.display = '';
        }

        // Clear the regular info content and use parcel-info-content for multi-parcel display
        document.getElementById('info-content').innerHTML = '';

        const content = `
            <div class="multi-parcel-actions" style="margin-bottom: 15px; text-align: center;">
                <button class="btn btn-secondary" onclick="cancelMultiParcelSelection()" style="padding: 8px 16px;"
                    data-i18n-key="panel.parcel.multi.cancelSelection">
                    ${tParcelMulti('panel.parcel.multi.cancelSelection', {}, 'Cancel Selection')}
                </button>
            </div>
            <div style="display: flex; gap: 8px;">
                <div class="metric-group" style="flex: 1;">
                    <div class="metric-label" data-i18n-key="panel.parcel.multi.selectedParcels">${tParcelMulti('panel.parcel.multi.selectedParcels', {}, 'Selected Parcels:')}</div>
                    <div class="metric-value">${parcels.length}</div>
                </div>
                <div class="metric-group" style="flex: 1;">
                    <div class="metric-label" data-i18n-key="panel.parcel.multi.totalArea">${tParcelMulti('panel.parcel.multi.totalArea', {}, 'Total Area:')}</div>
                    <div class="metric-value">${Math.round(totalArea).toLocaleString('hr-HR')} m²</div>
                </div>
            </div>
            <div style="display: flex; gap: 8px;">
                <div class="metric-group" style="flex: 1;">
                    <div class="metric-label" data-i18n-key="panel.parcel.multi.estValue">${tParcelMulti('panel.parcel.multi.estValue', {}, 'Est. Val.:')}</div>
                    <div class="metric-value">${Math.round(totalEstimatedPrice).toLocaleString('hr-HR')}</div>
                </div>
                <div class="metric-group" style="flex: 1;">
                    <div class="metric-label" data-i18n-key="panel.parcel.multi.totalOwners">${tParcelMulti('panel.parcel.multi.totalOwners', {}, 'Total owners:')}</div>
                    <div class="metric-value">${totalOwners}</div>
                </div>
            </div>
            <hr style="border: 0; height: 1px; background-color: #ddd; margin: 10px 0;">
            <div class="selected-parcels-section">
                <div class="metric-label" data-i18n-key="panel.parcel.multi.selectedParcelsHeading">${tParcelMulti('panel.parcel.multi.selectedParcelsHeading', {}, 'Selected Parcels:')}</div>
                <div class="selected-parcels-list">
                        ${parcelSummaries.map(({ parcelId, feature, area, price, currency }) => {
            const isRoad = parcelId && typeof window.isRoadParcel === 'function' ? window.isRoadParcel(parcelId) : false;
            const parcelNumberDisplay = getParcelDisplayNumberFromProperties(feature.properties, parcelId);
            const parcelLabel = tParcelMulti('panel.parcel.multi.parcelLabel', { number: parcelNumberDisplay || parcelId }, `Parcel ${parcelNumberDisplay || parcelId}`);
            const roadLabel = tParcelMulti('panel.parcel.multi.roadTag', {}, 'Road');
            const currencyLabel = currency === 'EUR' ? '€' : currency || '';
            return `
                            <div class="selected-parcel-item">
                                <div class="parcel-number">${parcelLabel}</div>
                                <div class="parcel-details">
                                            ${Math.round(area).toLocaleString('hr-HR')} m² • 
                                            ${Math.round(price).toLocaleString('hr-HR')} ${currencyLabel}
                                    ${isRoad ? ` • <span style="color: #28a745;">${roadLabel}</span>` : ''}
                                </div>
                            </div>
                        `;
        }).join('')}
                </div>
            </div>
        `;

        // Show multi-parcel content in the Info tab
        document.getElementById('info-content').innerHTML = content;

        const proposalsContent = `
            <div class="metric-group multi-parcel-proposal-hint">
                <div class="metric-value" data-i18n-key="panel.parcel.multi.proposalsHint">${tParcelMulti('panel.parcel.multi.proposalsHint', {}, 'Create a proposal that includes all the selected parcels.')}</div>
            </div>
            <div id="parcel-proposal-actions" class="parcel-proposal-actions"></div>
        `;
        document.getElementById('proposals-content').innerHTML = proposalsContent;
        if (typeof renderParcelProposalActions === 'function') {
            renderParcelProposalActions();
        }

        const infoPanelEl = document.getElementById('parcel-info-panel');
        if (infoPanelEl) {
            infoPanelEl.classList.add('visible');
            if (typeof window !== 'undefined' && window.i18n && typeof window.i18n.applyTranslations === 'function') {
                try {
                    window.i18n.applyTranslations(infoPanelEl);
                } catch (_) { /* ignore */ }
            }
        }
    },

    // Hide parcel info panel
    hideParcelInfo() {
        // Reset the panel title back to original
        const panelTitle = document.querySelector('#parcel-info-panel h3');
        if (panelTitle) {
            panelTitle.textContent = 'Parcel';
        }

        // Show parcel-specific buttons again (they might have been hidden for proposal view)
        const parcelButtons = document.querySelector('.parcel-info-buttons');
        if (parcelButtons) {
            parcelButtons.style.display = '';
        }

        // Clear all tab content areas
        const infoContent = document.getElementById('info-content');
        const proposalsContent = document.getElementById('proposals-content');

        if (infoContent) infoContent.innerHTML = '';
        if (proposalsContent) proposalsContent.innerHTML = '';

        document.getElementById('parcel-info-panel').classList.remove('visible');

        // Clear any proposal highlights
        clearProposalHighlights();
    },

    // Update create proposal button visibility
    updateCreateProposalButton() {
        const button = document.getElementById('createProposalButton');
        if (button) {
            // Show button if we have multiple parcels selected OR a single parcel selected
            const hasMultipleParcels = this.selectedParcels.size > 0;
            const hasSingleParcel = typeof selectedParcelId !== 'undefined' && selectedParcelId &&
                typeof currentParcel !== 'undefined' && currentParcel;
            button.style.display = (hasMultipleParcels || hasSingleParcel) ? 'inline-block' : 'none';
        }
    },

    // Reapply highlights to all currently selected parcels
    reapplyMultiParcelHighlights() {
        if (!this.isActive || !this.selectedParcels || this.selectedParcels.size === 0) return;
        if (typeof window.ParcelPresenter?.restoreSelectionStyles === 'function') {
            window.ParcelPresenter.restoreSelectionStyles();
            return;
        }
        this.selectedParcels.forEach(parcelId => {
            const parcel = this.findParcelById(parcelId);
            if (parcel) this.addParcelHighlight(parcel);
        });
    },

    // Select all parcels in a block (used for Buenos Aires block selection)
    selectBlockLayers(blockLayers) {
        if (!Array.isArray(blockLayers) || blockLayers.length === 0) {
            return;
        }

        // Enable multi-selection mode if not already active
        if (!this.isActive) {
            this.toggle({ preserveSelectedParcel: false });
        }

        // Clear existing selection
        this.clearSelection();

        // Add all block layers to selection
        blockLayers.forEach(layer => {
            const parcelId = window.ParcelPresenter?.getIdForLayer?.(layer);
            if (parcelId && window.LiveParcelFabric?.get?.(String(parcelId))) {
                const parcelIdStr = parcelId.toString();
                this.selectedParcels.add(parcelIdStr);
                this.addParcelHighlight(layer);
            }
        });

        // Update the last selected parcel ID
        if (this.selectedParcels.size > 0) {
            this.lastSelectedParcelId = Array.from(this.selectedParcels).slice(-1)[0];
        }

        // Update UI to show the selected parcels
        this.updateUI();

        // Show ephemeral message
        if (typeof showEphemeralMessage === 'function') {
            const message = (typeof window !== 'undefined' && window.i18n && typeof window.i18n.t === 'function')
                ? window.i18n.t('ephemeral.messages.all_parcels_in_block_selected', 'All parcels in the block selected!')
                : 'All parcels in the block selected!';
            showEphemeralMessage(message, 4000);
        }
    }
};

const PROPOSAL_COLORS = [
    '#4caf50', // green
    '#2196f3', // blue
    '#ff9800', // orange
    '#e91e63', // pink
    '#9c27b0', // purple
    '#f44336', // red
    '#00bcd4', // cyan
    '#8bc34a', // light green
    '#ffc107', // amber
    '#795548', // brown
    '#607d8b', // blue grey
];

const APPLY_DISABLED_TYPE_KEYS = new Set();

const DEFAULT_PROPOSAL_TYPE = 'Square';

const PROPOSAL_GOAL_ICON_MAP = {
    'as-is': { icon: '🟰', label: 'No change' },
    'square': { icon: '⛲️', label: 'Square' },
    'park': { icon: '🌳', label: 'Park' },
    'lake': { icon: '🐟', label: 'Lake' },
    'station': { icon: '🚉', label: 'Transit station' },
    'single': { icon: '🏠', label: 'Building' },
    'buildings': { icon: '🏠', label: 'Building' },
    'road-track': { icon: '🛣️🛤️', label: 'Road/Track' },
    'road/track': { icon: '🛣️🛤️', label: 'Road/Track' },
    'urban-rule': { icon: '📜📐', label: 'Urban rule' },
    'urban rule': { icon: '📜📐', label: 'Urban rule' },
    'decide-later': { icon: '🪡', label: 'Merge' },
    'decide later': { icon: '🪡', label: 'Merge' },
    'reparcellization': { icon: '✂️', label: 'Subdivide' },
    'ownership-transfer': { icon: '🔄', label: 'Ownership transfer' },
    'ownership-transfer-to-me': { icon: '🔄', label: 'Ownership transfer to me' },
    'ownership-transfer-from-me': { icon: '🔄', label: 'Ownership transfer from me' }
};

const PROPOSAL_SCREENSHOT_SKIP_GOALS = new Set([
    'urban-rule',
    'ownership-transfer',
    'ownership-transfer-to-me',
    'ownership-transfer-from-me'
]);

const DEFAULT_CORRIDOR_WIDTHS = {
    road: 7.5,
    track: 3.0
};

const proposalFacetState = { landUse: 'as-is', parcels: 'as-is', ownership: 'no-change' };

const PROPOSAL_PUBLIC_GOOD_USES = new Set(['park', 'square', 'lake', 'station', 'road-track']);

const PROPOSAL_GOAL_TYPE_LABELS = {
    'square': 'Square', 'park': 'Park', 'lake': 'Lake', 'station': 'Transit station', 'single': 'Building(s)',
    'road-track': 'Road/Track', 'urban-rule': 'Urban Rule',
    'reparcellization': 'Reparcellization'
};

const LAKE_GRAPHICS_VERSION = 3;

const LAKE_SHORE_TARGET_RATIO = 0.2;

const proposalListState = {
    source: 'local',
    filterType: 'all',
    lifecycleFilter: 'all', // 'all' | any getProposalLifecycleKey value (replaced the Active/Executed tabs)
    appliedFilter: 'all',   // 'all' | 'applied' | 'not-applied'
    authorFilter: '',
    searchText: '',
    sortKey: 'created-desc',
    selectedId: null
};

const SERVER_PROPOSAL_SUMMARY_LIMIT = 250;

const serverProposalCache = {
    proposals: [],
    count: null,
    loading: false,
    error: null,
    lastCity: null,
    lastFetchedAt: 0,
    // Signature of the search/sort the cached rows answer; a change re-queries the server.
    lastQuery: null,
    // The sidebar count is refreshed on its own, from the cheap /proposals/count. Kept apart from
    // lastFetchedAt on purpose: that one means "have we asked for the SUMMARIES yet", and stamping
    // it here would convince the list it already had rows it has never fetched.
    countRefreshedAt: 0,
    countLoading: false
};

const PROPOSAL_SORT_OPTIONS = [
    { value: 'created-desc', label: 'Created (newest first)' },
    { value: 'created-asc', label: 'Created (oldest first)' },
    { value: 'acceptance-desc', label: 'Acceptance (high to low)' },
    { value: 'acceptance-asc', label: 'Acceptance (low to high)' },
    { value: 'value-desc', label: 'Offer (high to low)' },
    { value: 'value-asc', label: 'Offer (low to high)' },
    { value: 'parcels-desc', label: 'Parcels (many to few)' },
    { value: 'parcels-asc', label: 'Parcels (few to many)' },
    { value: 'area-desc', label: 'Area (large to small)' },
    { value: 'area-asc', label: 'Area (small to large)' },
    { value: 'author-asc', label: 'Author (A → Z)' },
    { value: 'author-desc', label: 'Author (Z → A)' }
];

const PROPOSAL_SORT_I18N_KEYS = {
    'created-desc': 'createdDesc',
    'created-asc': 'createdAsc',
    'acceptance-desc': 'acceptanceDesc',
    'acceptance-asc': 'acceptanceAsc',
    'value-desc': 'valueDesc',
    'value-asc': 'valueAsc',
    'parcels-desc': 'parcelsDesc',
    'parcels-asc': 'parcelsAsc',
    'area-desc': 'areaDesc',
    'area-asc': 'areaAsc',
    'author-asc': 'authorAsc',
    'author-desc': 'authorDesc'
};

const PROPOSAL_GOAL_FILTERS = [
    { value: 'all', label: 'All goals' },
    { value: 'road-track', label: 'Road/Track' },
    { value: 'buildings', label: 'Buildings' },
    { value: 'single', label: 'Single building' },
    { value: 'park', label: 'Park' },
    { value: 'square', label: 'Square' },
    { value: 'lake', label: 'Lake' },
    { value: 'station', label: 'Transit station' },
    { value: 'urban-rule', label: 'Urban rule' },
    { value: 'reparcellization', label: 'Reparcellization' },
    { value: 'row', label: 'Row' },
    { value: 'other', label: 'Other' }
];

const PROPOSAL_GOAL_FILTER_I18N_KEYS = {
    all: 'all',
    'road-track': 'roadTrack',
    buildings: 'buildings',
    single: 'single',
    park: 'park',
    square: 'square',
    lake: 'lake',
    station: 'station',
    'urban-rule': 'urbanRule',
    reparcellization: 'reparcellization',
    row: 'row',
    other: 'other'
};

const PROPOSAL_GOAL_LABELS = {
    'road-track': 'Road/Track',
    buildings: 'Buildings',
    single: 'Single building',
    row: 'Row',
    park: 'Park',
    square: 'Square',
    lake: 'Lake',
    station: 'Transit station',
    'urban-rule': 'Urban rule',
    reparcellization: 'Reparcellization',
    'decide-later': 'Decide later',
    parcelBased: 'Parcel-based',
    other: 'Other'
};

const PROPOSAL_INACTIVE_STATUSES = new Set([
    'inactive',
    'expired',
    'cancelled',
    'canceled',
    'rejected',
    'declined',
    'void',
    'archived'
]);

const PROPOSAL_LIST_FILTER_INPUT_DEBOUNCE_MS = 280;

const PROPOSAL_HIGHLIGHT_REFRESH_DEBOUNCE_MS = 120;
