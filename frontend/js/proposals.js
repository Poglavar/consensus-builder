/*
    Proposals functionality for the cadastre application.
    This file contains the functionality for creating and managing proposals
    including persistence helpers, map highlighting, UI interactions, and
    dependency management between proposals.
*/

const PROPOSALS_STORAGE_KEY = 'cadastre_proposals';
const PROPOSALS_NEXT_ID_KEY = 'cadastre_proposals_nextId';
const proposalMetadataFetchPromises = new Map();

function isLocalProposalId(value) {
    if (value === undefined || value === null) return false;
    const str = String(value);
    return str.startsWith('local-') || str.startsWith('local_prop') || str.startsWith('local-prop');
}











// Check contiguity and disable buttons that require contiguous parcels
// This applies to: Urban Rule's Block/Row buttons and Purchase's Park/Square/Lake buttons







function parseOwnerShareFraction(shareText = '') {
    const raw = (shareText || '').trim();
    if (!raw) return 1;
    if (raw.endsWith('%')) {
        const pct = parseFloat(raw.slice(0, -1));
        if (Number.isFinite(pct)) return Math.max(0, pct) / 100;
    }
    if (raw.includes('/')) {
        const [a, b] = raw.split('/').map(v => parseFloat(v.trim()));
        if (Number.isFinite(a) && Number.isFinite(b) && b !== 0) {
            return Math.max(0, a / b);
        }
    }
    const num = parseFloat(raw);
    if (Number.isFinite(num)) {
        // Treat 0-1 as fraction, >1 as already a ratio of 1 (e.g., "100" means 100x, clamp to 1)
        if (num > 1) {
            return num > 100 ? 1 : num / 100;
        }
        return Math.max(0, num);
    }
    return 1;
}


function normalizeFeature(feature) {
    if (!feature || typeof feature !== 'object') return feature;
    ensureParcelIdOnFeature(feature);
    return feature;
}







function setParcelInfoPanelTitle(titleText, options = {}) {
    const panel = document.getElementById('parcel-info-panel');
    if (!panel) return;
    const titleEl = panel.querySelector('h3');
    if (!titleEl) return;
    const { i18nKey = null, i18nParams = null } = options;
    if (i18nKey) {
        titleEl.setAttribute('data-i18n-key', i18nKey);
        if (i18nParams) {
            titleEl.setAttribute('data-i18n-params', JSON.stringify(i18nParams));
        } else {
            titleEl.removeAttribute('data-i18n-params');
        }
    } else {
        titleEl.removeAttribute('data-i18n-key');
        titleEl.removeAttribute('data-i18n-params');
    }
    titleEl.textContent = titleText;
    if (typeof window !== 'undefined' && window.i18n && typeof window.i18n.applyTranslations === 'function') {
        try { window.i18n.applyTranslations(titleEl); } catch (_) { /* ignore */ }
    }
}

function tParcelMulti(key, params = {}, fallback = '') {
    const api = (typeof window !== 'undefined' && window.i18n) ? window.i18n : null;
    if (api && typeof api.t === 'function') {
        return api.t(key, params);
    }
    // simple template replacement for fallback
    return String(fallback || key || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (params && k in params) ? params[k] : m);
}






// --- Translation hydration (pulls from JSON source to avoid hardcoding strings) ---
const proposalListTranslationsHydrated = new Set();

// Cache parcel areas per proposal to avoid repeated lookups/hydration
const proposalAreaCache = new Map();

function flattenObject(node, prefix = '', out = {}) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return out;
    Object.entries(node).forEach(([key, value]) => {
        const path = prefix ? `${prefix}.${key}` : key;
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            flattenObject(value, path, out);
        } else {
            out[path] = value;
        }
    });
    return out;
}

function showProposalAlertMessage(key, fallback, params = {}, alertOptions = {}) {
    const translate = getProposalI18nHelper();
    const message = translate(`alerts.messages.${key}`, fallback, params);
    if (typeof window !== 'undefined' && typeof window.showStyledAlert === 'function') {
        window.showStyledAlert(message, alertOptions);
    } else {
        alert(message);
    }
    return message;
}

/**
 * Check if current user is a guest and needs to personalize their profile.
 * If guest, shows welcome modal and returns true; otherwise returns false.
 * Use this to gate functionality that requires a personalized profile.
 */

// PERFORMANCE: Write cache to batch localStorage operations
// When enabled, writes go to cache instead of storage, then flush at once




/**
 * Check if a parcel is a parent that was replaced by child parcels from an applied proposal.
 * Returns true if the parcel should be hidden (replaced by children), false if it should be visible.
 * This replaces the removedByProposal flag with logic based on parent/child relationships.
 */
/**
 * True if this parcel is hidden because an applied proposal replaced it with descendants.
 *
 * Contract: "applied + rule replaces parents + parcel listed as ancestor" → hide. We do NOT
 * gate on whether descendant geometries currently exist on the map; the apply contract is
 * authoritative. If a parcel is missing from the map after this returns true, the descendants
 * either exist in PersistentStorage or will be re-derived from the proposal's definition on
 * the next apply pass — we should never reveal a stale parent under a hole as a workaround.
 *
 * Hot path: called per parcel during ingest and pan, so backed by the proposalStorage
 * ancestor index (O(1) lookup, rebuilt lazily after any proposal mutation).
 */
function isParcelReplacedByChildren(parcelId) {
    if (!parcelId) return false;
    const idStr = String(parcelId);

    // Descendant parcels (carrying ancestorProposal) are themselves never hidden — they
    // are the result of a previous apply and must remain visible.
    const record = readPersistedParcelRecord(idStr);
    if (record && record.properties && record.properties.ancestorProposal) {
        return false;
    }

    if (typeof proposalStorage === 'undefined') return false;
    return proposalStorage.isParcelAncestorOfAppliedProposal(idStr);
}




if (typeof window !== 'undefined') {
    window.readPersistedParcelRecord = readPersistedParcelRecord;
    window.writePersistedParcelRecord = writePersistedParcelRecord;
    window.clearPersistedParcelRecord = clearPersistedParcelRecord;
    window._startParcelWriteCache = _startParcelWriteCache;
    window._flushParcelWriteCache = _flushParcelWriteCache;
    window._discardParcelWriteCache = _discardParcelWriteCache;
}

function getProposalAreaMap(proposal) {
    if (!proposal) return { areaMap: new Map(), totalArea: 0 };

    const cacheKey = getProposalKey(proposal) || proposal.proposalId || JSON.stringify(proposal.parentParcelIds || []);
    if (cacheKey && proposalAreaCache.has(cacheKey)) {
        return proposalAreaCache.get(cacheKey);
    }

    const areaMap = new Map();
    let totalArea = 0;
    const parcelIds = Array.isArray(proposal?.parentParcelIds) ? proposal.parentParcelIds : [];

    parcelIds.forEach(id => {
        const key = id?.toString ? id.toString() : String(id || '');
        if (!key) return;

        let area = 0;

        // Prefer cached proposal feature data (no map hydration)
        const cached = getCachedParcelFeature(key, proposal);
        const props = cached?.properties;
        if (props) {
            area = Number(props.calculatedArea || props.area || props.parcelArea || 0) || 0;
        }

        // Fallback to persisted properties
        if (!area) {
            try {
                const record = readPersistedParcelRecord(key);
                const storedProps = record?.properties || null;
                if (storedProps) {
                    area = Number(storedProps.calculatedArea || storedProps.area || storedProps.parcelArea || 0) || 0;
                }
            } catch (_) { }
        }

        // Final fallback: treat as unit area to avoid zero totals
        if (!area) {
            area = 1;
        }

        areaMap.set(key, area);
        totalArea += area;
    });

    const result = { areaMap, totalArea };
    if (cacheKey) {
        proposalAreaCache.set(cacheKey, result);
    }
    return result;
}






// On execution, move authoritative parcel ownership (parcel_<id>_owner) to the proposal's
// recipient. Merge/Readjust assign per-child owners in their appliers; every other goal
// (park/square/lake/road/building + pure ownership transfer) transfers the still-real parent
// parcels here. Open sale (Third party · Anyone) has no recipient yet → handled by the buyer claim.

// Tier 2.2 — recipient consent ("no force-gift"). Opt-in via window.PROPOSAL_REQUIRE_RECIPIENT_CONSENT
// so it doesn't block the demo by default; when on, a directed third-party transfer needs the
// named recipient to have consented (recordRecipientConsent). City/sale/to-me don't need it.


// Tier 2.1 — a buyer claims an open sale offer (Ownership: Third party · Anyone). Binds the buyer
// as recipient, marks it sold, and transfers the offered parcels to them. (Payment/settlement is
// a Tier-3 piece; this is the local "it actually executes" step.)

// Is this proposal an open offer to sell (Ownership: Third party · Anyone)?

// For a directed external recipient (to-city / third-party·specific) return {label, accepted}
// so the details dialog can show the recipient as a consent line item. null otherwise.

// Recipient accepts (records consent) and re-renders the open details dialog.

if (typeof window !== 'undefined') {
    window.claimSaleOffer = claimSaleOffer;
    window.recordRecipientConsent = recordRecipientConsent;
    window.isProposalOpenSaleOffer = isProposalOpenSaleOffer;
    window.acceptAsRecipient = acceptAsRecipient;
}




// Deterministic, order-insensitive hash (cyrb53) to produce stable proposal ids across clients.



const proposalStorage = {
    proposals: new Map(),
    proposalIndexByHash: new Map(),
    nextProposalId: 0,
    // Save-batching, same shape as agentStorage. Code paths that mutate proposals
    // call save() freely; if a batch is open save() just flags a pending write
    // and the actual JSON.stringify + IndexedDB write happens once at endBatch().
    // The game turn loop opens a batch around all agent actions — without this
    // we re-serialised the entire proposal store ~10-20 times per turn, which
    // is the bulk of the per-turn cost and the source of the flyTo choppiness.
    _suspendSaveCount: 0,
    _hasPendingSave: false,

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
    // Cached map: parcelId -> Set<proposalId> for applied proposals whose rule replaces
    // their parents (road, decideLater, reparcellization). Built lazily on first read
    // after invalidation. Lets isParcelReplacedByChildren stay O(1) per pan/ingest.
    _ancestorIndex: null,
    _ancestorIndexDirty: true,
    _roadAssetSuffixes: {
        parents: 'roadParents',
        children: 'roadChildren',
        metadata: 'roadParentsKeep'
    },

    _invalidateAncestorIndex() {
        this._ancestorIndexDirty = true;
    },

    /**
     * True if applying this proposal removes its parent parcels from the map. Building
     * and structure overlays draw on top of parents (parcelBased, single-building,
     * park, square, lake) and must NOT hide them.
     */
    _proposalRuleReplacesParents(proposal) {
        if (!proposal) return false;
        if (proposal.buildingProposal || proposal.structureProposal) return false;
        const goalKey = (typeof normalizeProposalGoalKey === 'function')
            ? (normalizeProposalGoalKey(proposal.goal) || '')
            : String(proposal.goal || '');
        if (['buildings', 'building(s)', 'single-building', 'parcelBased', 'park', 'square', 'lake'].includes(goalKey)) {
            return false;
        }
        return true;
    },

    /** Union of every parent-id list a proposal might carry across its sub-objects. */
    _collectProposalAncestorIds(proposal) {
        const ids = new Set();
        const push = (arr) => {
            if (!Array.isArray(arr)) return;
            for (const id of arr) {
                if (id == null) continue;
                const s = String(id);
                if (s) ids.add(s);
            }
        };
        push(proposal.parentParcelIds);
        if (proposal.roadProposal) push(proposal.roadProposal.parentParcelIds);
        if (proposal.decideLaterProposal) push(proposal.decideLaterProposal.parentParcelIds);
        if (proposal.reparcellization) push(proposal.reparcellization.parentParcelIds);
        if (proposal.buildingProposal) push(proposal.buildingProposal.parentParcelIds);
        if (proposal.structureProposal) push(proposal.structureProposal.parentParcelIds);
        return ids;
    },

    _rebuildAncestorIndex() {
        const idx = new Map();
        for (const proposal of this.proposals.values()) {
            if (!proposal) continue;
            if (typeof isProposalApplied !== 'function' || !isProposalApplied(proposal)) continue;
            if (!this._proposalRuleReplacesParents(proposal)) continue;
            const proposalKey = String(proposal.proposalId || '');
            if (!proposalKey) continue;
            const ancestorIds = this._collectProposalAncestorIds(proposal);
            for (const ancestorId of ancestorIds) {
                let bucket = idx.get(ancestorId);
                if (!bucket) {
                    bucket = new Set();
                    idx.set(ancestorId, bucket);
                }
                bucket.add(proposalKey);
            }
        }
        this._ancestorIndex = idx;
        this._ancestorIndexDirty = false;
    },

    /**
     * O(1) ancestor-membership lookup. True if any APPLIED proposal whose rule replaces
     * parents lists this parcel as an ancestor. Used by isParcelReplacedByChildren.
     */
    isParcelAncestorOfAppliedProposal(parcelId) {
        if (!parcelId) return false;
        if (this._ancestorIndexDirty || !this._ancestorIndex) {
            this._rebuildAncestorIndex();
        }
        const bucket = this._ancestorIndex.get(String(parcelId));
        return !!(bucket && bucket.size > 0);
    },

    _ensureIndexes() {
        if (!this.proposals || typeof this.proposals.clear !== 'function') {
            this.proposals = new Map();
        }
        if (!this.proposalIndexByHash || typeof this.proposalIndexByHash.clear !== 'function') {
            this.proposalIndexByHash = new Map();
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
        this._normalizeProposalIdentity(proposal);
        const id = this._coerceProposalId(
            proposal.proposalId
            || proposal.tokenId
        );
        if (!id) return null;
        this.proposals.set(id, proposal);
        this._invalidateAncestorIndex();
        return id;
    },

    _removeIndexForProposal(proposal) {
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
            const proposalIdKey = proposal.similarityHash || this._computeSimilarityHash(proposal.parentParcelIds);
            if (proposalIdKey && proposalIdKey === targetHash) {
                matches.push(proposal);
            }
        }
        return matches;
    },

    importOnChainProposal(raw) {
        if (!raw) return null;

        const metaProps = raw.metadata && raw.metadata.properties ? raw.metadata.properties : {};
        const chainTokenId = raw.proposalId ?? raw.tokenId ?? (raw.onchain && raw.onchain.proposalId) ?? metaProps.tokenId ?? null;
        const rawProposalId = chainTokenId !== undefined && chainTokenId !== null ? String(chainTokenId) : null;
        const metaProposalId = metaProps.proposalId || metaProps.id || null;
        const parentParcelIds = Array.isArray(raw.parentParcelIds) ? raw.parentParcelIds : [];
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
        const similarityHash = raw.similarityHash || this._computeSimilarityHash(parentParcelIds);
        let similar = null;
        try {
            for (const p of this.proposals.values()) {
                if (!p) continue;
                const hash = this._computeSimilarityHash(p.parentParcelIds || []);
                if (hash === similarityHash) {
                    similar = p;
                    break;
                }
            }
        } catch (_) { /* ignore */ }

        let proposalId = metaProposalId || (existing && existing.proposalId) || rawProposalId || (similar && similar.proposalId) || null;
        if ((!proposalId || isLocalProposalId(proposalId)) && typeof this._buildDeterministicId === 'function') {
            try {
                proposalId = this._buildDeterministicId({ ...(existing || {}), ...raw, parentParcelIds });
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
            parentParcelIds,
            title,
            description,
            name: title,
            proposalName: title,
            author,
            chainId: normalizedChainId || (existing && existing.chainId) || null,
            isConditional: !!raw.isConditional,
            imageURI: raw.imageURI || '',
            acceptancePossible: raw.acceptancePossible !== false,
            status: raw.status || 'Active',
            ethBalance: raw.ethBalance || '0',
            tokenBalance: raw.tokenBalance || '0',
            acceptanceCount: raw.acceptanceCount || '0',
            expiryTimestamp: raw.expiryTimestamp || '0',
            expiringPercentage: raw.expiringPercentage || '0',
            createdAt: raw.createdAt || metaProps.createdAt || new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            acceptedParcels: Array.isArray(raw.acceptedParcels) ? raw.acceptedParcels : [],
            similarityHash,
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
            if (Array.isArray(geometryPayload.childFeatures) && geometryPayload.childFeatures.length) {
                merged.childFeatures = safeClone(geometryPayload.childFeatures);
            }
            if (Array.isArray(geometryPayload.features) && geometryPayload.features.length && !merged.childFeatures) {
                merged.childFeatures = safeClone(geometryPayload.features);
            }
            if (Array.isArray(geometryPayload.roadChildFeatures) && geometryPayload.roadChildFeatures.length) {
                merged.roadProposal = Object.assign({}, merged.roadProposal || {}, { childFeatures: safeClone(geometryPayload.roadChildFeatures) });
            }
            if (geometryPayload.roadProposal) {
                merged.roadProposal = Object.assign({}, merged.roadProposal || {}, safeClone(geometryPayload.roadProposal));
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
        this._indexProposal(merged);
        this.save();
        return merged;
    },

    load() {
        this._ensureIndexes();
        if (typeof PersistentStorage === 'undefined') return;
        try {
            const raw = PersistentStorage.getItem(PROPOSALS_STORAGE_KEY);
            if (!raw) {
                this.proposals.clear();
                this.proposalIndexByHash.clear();
                const storedNext = parseInt(PersistentStorage.getItem(PROPOSALS_NEXT_ID_KEY), 10);
                this.nextProposalId = Number.isFinite(storedNext) && storedNext >= 0 ? storedNext : 0;
                return;
            }

            const parsed = JSON.parse(raw);
            this.proposals.clear();
            this.proposalIndexByHash.clear();
            if (!Array.isArray(parsed)) return;

            parsed.forEach(entry => {
                if (!entry) return;
                const normalized = this._normalizeProposal({ ...entry });
                if (!normalized.proposalId) {
                    const serverHintRaw = normalized.serverProposalId || normalized.id;
                    const serverHint = serverHintRaw && !isLocalProposalId(serverHintRaw) ? String(serverHintRaw) : null;
                    normalized.proposalId = serverHint || this._allocateProposalId();
                }
                this.proposals.set(normalized.proposalId, normalized);
                this._indexProposal(normalized);
            });

            const storedNext = parseInt(PersistentStorage.getItem(PROPOSALS_NEXT_ID_KEY), 10);
            if (Number.isFinite(storedNext) && storedNext >= 0) {
                this.nextProposalId = storedNext;
            } else {
                const maxLocalId = Math.max(0, ...Array.from(this.proposals.keys()).map(id => {
                    const match = String(id).match(/local-(\d+)/);
                    if (match && match[1]) return parseInt(match[1], 10) || 0;
                    const asNum = parseInt(id, 10);
                    return Number.isFinite(asNum) ? asNum : 0;
                }));
                this.nextProposalId = maxLocalId + 1;
            }

            this.save();
        } catch (error) {
            console.error('proposalStorage.load: Failed to parse proposals from storage', error);
            this._ensureIndexes();
            this.proposals.clear();
            this.proposalIndexByHash.clear();
            const storedNext = parseInt(PersistentStorage.getItem(PROPOSALS_NEXT_ID_KEY), 10);
            this.nextProposalId = Number.isFinite(storedNext) && storedNext >= 0 ? storedNext : 0;
        }
    },

    save() {
        // Always invalidate the in-memory ancestor index — callers rely on
        // this happening synchronously even when persistence is deferred.
        this._invalidateAncestorIndex();
        if (this._suspendSaveCount > 0) {
            this._hasPendingSave = true;
            return;
        }
        this._persist();
    },

    _persist() {
        if (typeof PersistentStorage === 'undefined') return;
        try {
            const serialisable = Array.from(this.proposals.values());
            PersistentStorage.setItem(PROPOSALS_STORAGE_KEY, JSON.stringify(serialisable));
            // Persist the next proposal id counter
            PersistentStorage.setItem(PROPOSALS_NEXT_ID_KEY, String(this.nextProposalId));
        } catch (error) {
            console.error('proposalStorage.save: Failed to persist proposals', error);
        }
    },

    _roadAssetKey(proposalId, suffix) {
        if (!proposalId || !suffix) return null;
        return `proposal_${proposalId}_${suffix}`;
    },

    _resolveRoadAssetKey(idOrHash) {
        const resolved = this._resolveProposalId(idOrHash);
        return resolved ? String(resolved) : null;
    },

    persistRoadAssets(proposalIdOrHash) {
        // Road assets now live on-demand; clear any legacy sidecars when touched.
        this.clearRoadAssets(proposalIdOrHash);
    },

    loadRoadAssets() {
        // Sidecars removed; keep signature for backward compatibility.
        return { parentFeatures: [], parentsKeepDetails: null };
    },

    clearRoadAssets(proposalIdOrHash) {
        if (typeof PersistentStorage === 'undefined') return;
        const key = this._resolveRoadAssetKey(proposalIdOrHash);
        if (!key) return;
        const parentKey = this._roadAssetKey(key, this._roadAssetSuffixes.parents);
        const childKey = this._roadAssetKey(key, this._roadAssetSuffixes.children);
        const metaKey = this._roadAssetKey(key, this._roadAssetSuffixes.metadata);
        try { if (parentKey) PersistentStorage.removeItem(parentKey); } catch (_) { }
        try { if (childKey) PersistentStorage.removeItem(childKey); } catch (_) { }
        try { if (metaKey) PersistentStorage.removeItem(metaKey); } catch (_) { }
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

    getProposalsForParcel(parcelId, options = {}) {
        const id = normalizeParcelId(parcelId);
        if (!id) {
            return [];
        }
        const results = [];
        const hydrateRoadAssets = options && Object.prototype.hasOwnProperty.call(options, 'hydrateRoadAssets')
            ? !!options.hydrateRoadAssets
            : true;
        for (const proposal of this.proposals.values()) {
            const parentIds = Array.isArray(proposal.parentParcelIds) ? proposal.parentParcelIds : [];
            const parcelMatch = parentIds.some(value => normalizeParcelId(value) === id);

            const childIds = Array.isArray(proposal.childParcelIds) ? proposal.childParcelIds : [];
            const decideLaterChildIds = Array.isArray(proposal.decideLaterProposal?.childParcelIds) ? proposal.decideLaterProposal.childParcelIds : [];
            const allChildIds = childIds.concat(decideLaterChildIds);
            const childMatch = allChildIds.some(value => normalizeParcelId(value) === id);

            let roadMatch = false;
            if (!parcelMatch && proposal.roadProposal) {
                const road = proposal.roadProposal;
                const roadParentIds = Array.isArray(road.parentParcelIds) ? road.parentParcelIds : [];
                const roadChildIds = Array.isArray(road.childParcelIds) ? road.childParcelIds : [];
                const combinedIds = roadParentIds.concat(roadChildIds);
                roadMatch = combinedIds.some(value => normalizeParcelId(value) === id);

                if (!roadMatch && hydrateRoadAssets) {
                    // With road assets stored in-proposal, only ids are available; rely on parent/child id lists
                    roadMatch = roadParentIds.some(value => normalizeParcelId(value) === id)
                        || roadChildIds.some(value => normalizeParcelId(value) === id);
                }
            }

            if (parcelMatch || childMatch || roadMatch) {
                results.push(proposal);
            }
        }
        return results;
    },

    addProposal(proposal) {
        if (!proposal || typeof proposal !== 'object') return null;

        if (typeof this._ensureIndexes === 'function') {
            this._ensureIndexes();
        }

        const normalized = this._normalizeProposal({ ...proposal });
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
        this.save();
        try {
            if (typeof document !== 'undefined' && typeof CustomEvent === 'function') {
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

        const { overwrite = true, preserveStatus = false } = options;
        const normalized = this._normalizeProposal({ ...proposal });

        if (!preserveStatus) {
            normalized.status = normalized.status === 'Executed' ? 'Executed' : 'Active';
            if (normalized.roadProposal) {
                normalized.roadProposal.status = 'unapplied';
            }
            if (normalized.buildingProposal) {
                normalized.buildingProposal.status = normalized.buildingProposal.status === 'executed' ? 'executed' : 'unapplied';
            }
        }

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
        this.save();
        return normalized;
    },

    removeProposal(idOrHash) {
        const resolvedId = this._resolveProposalId(idOrHash);
        const existing = resolvedId ? this.proposals.get(resolvedId) : null;
        const deleted = resolvedId ? this.proposals.delete(resolvedId) : false;
        if (deleted) {
            this._removeIndexForProposal(existing);
            this._invalidateAncestorIndex();
            this.clearRoadAssets(resolvedId || idOrHash);
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
        this._invalidateAncestorIndex();
        if (typeof PersistentStorage !== 'undefined') {
            PersistentStorage.removeItem(PROPOSALS_STORAGE_KEY);
        }
    },

    updateProposalStatus(proposalId, status) {
        const proposal = this.getProposal(proposalId);
        if (proposal) {
            proposal.status = status;
            proposal.updatedAt = new Date().toISOString();

            if (proposal.roadProposal) {
                const nextStatus = status === 'Applied' ? 'applied' : status === 'Executed' ? 'executed' : 'unapplied';
                proposal.roadProposal.status = nextStatus;
            }

            if (proposal.buildingProposal) {
                const nextStatus = status === 'Executed' ? 'executed' : status === 'Applied' ? 'applied' : 'unapplied';
                proposal.buildingProposal.status = nextStatus;
            }

            this._indexProposal(proposal);
        }
    },

    _normalizeProposal(proposal, context = {}) {
        const { existingHash = null } = context || {};
        // Ancestors-only contract: proposals never persist parcel geometries locally — they
        // carry ancestor IDs + the rule (road definition, structure definition, building rule).
        // Descendants are always re-derived deterministically from (ancestors, rule) on apply.
        // Inbound payloads from server / chain / share links may still include these blobs;
        // strip them at the storage boundary so they cannot leak into local proposal records.
        delete proposal.parentFeatures;
        delete proposal.childFeatures;
        if (proposal.geometry && typeof proposal.geometry === 'object') {
            delete proposal.geometry.parentFeatures;
            delete proposal.geometry.childFeatures;
        }
        const normalizedParentParcelIds = normalizeParcelIdList(
            (proposal.parentParcelIds && proposal.parentParcelIds.length ? proposal.parentParcelIds : proposal.parcelIds) || []
        );
        proposal.parentParcelIds = normalizedParentParcelIds;
        if (proposal.parcelIds) {
            delete proposal.parcelIds;
        }
        proposal.acceptedParcelIds = normalizeParcelIdList(proposal.acceptedParcelIds || []);
        proposal.ownerAcceptances = normalizeOwnerAcceptances(proposal.ownerAcceptances || {});
        proposal.status = proposal.status || 'Active';
        proposal.similarityHash = proposal.similarityHash || this._computeSimilarityHash(proposal.parentParcelIds);
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
                proposal.goal = (kind === 'park' || kind === 'square' || kind === 'lake') ? kind : 'square';
            } else if (proposal.buildingProposal || proposal.buildingGeometry) {
                proposal.goal = 'buildings';
            } else {
                proposal.goal = 'parcel';
            }
        }

        if (proposal.roadProposal) {
            const rp = { ...proposal.roadProposal };
            rp.parentParcelIds = normalizeParcelIdList(rp.parentParcelIds || proposal.parentParcelIds || []);
            rp.childParcelIds = normalizeParcelIdList(rp.childParcelIds || []);
            if (rp.parentsKeepDetails && typeof rp.parentsKeepDetails !== 'object') {
                rp.parentsKeepDetails = null;
            }
            delete rp.parentFeatures;
            delete rp.childFeatures;
            proposal.roadProposal = rp;
        }

        if (proposal.buildingProposal) {
            const bp = { ...proposal.buildingProposal };
            bp.parentParcelIds = normalizeParcelIdList(bp.parentParcelIds && bp.parentParcelIds.length > 0 ? bp.parentParcelIds : proposal.parentParcelIds || []);
            if (Array.isArray(bp.parentParcelNumbers)) {
                bp.parentParcelNumbers = bp.parentParcelNumbers.map(entry => ({
                    id: normalizeParcelId(entry?.id) || (entry?.id ? String(entry.id) : null),
                    number: entry && entry.number ? String(entry.number) : (normalizeParcelId(entry?.id) || null)
                })).filter(entry => entry.id);
            }
            bp.status = bp.status === 'executed' ? 'executed' : (bp.status === 'applied' ? 'applied' : 'unapplied');
            bp.parameters = bp.parameters && typeof bp.parameters === 'object' ? { ...bp.parameters } : {};
            Object.keys(bp.parameters).forEach(key => {
                if (bp.parameters[key] === undefined || bp.parameters[key] === null) {
                    delete bp.parameters[key];
                }
            });

            if (!proposal.geometry) proposal.geometry = {};

            // Legacy buildingFeatures/buildingFeature intentionally ignored; left untouched

            if (Array.isArray(bp.buildings)) {
                bp.buildings = bp.buildings
                    .map(entry => {
                        if (!entry || typeof entry !== 'object') return null;
                        const clone = { ...entry };
                        if (clone.feature) {
                            try { clone.feature = JSON.parse(JSON.stringify(clone.feature)); } catch (_) { }
                        }
                        return clone;
                    })
                    .filter(Boolean);
            }
            if (!bp.ancestorKey) {
                bp.ancestorKey = (bp.parentParcelIds || []).join('|');
            }
            proposal.buildingProposal = bp;
        } else if (proposal.buildingGeometry || ['buildings', 'building(s)', 'single-building', 'parcelBased'].includes(normalizeProposalGoalKey(proposal.goal) || '')) {
            const parentIds = normalizeParcelIdList(proposal.parentParcelIds || []);
            proposal.buildingProposal = {
                parentParcelIds: parentIds,
                parentParcelNumbers: parentIds.map(id => ({ id, number: id })),
                status: (proposal.status === 'Applied' || proposal.status === 'Executed') ? 'applied' : 'unapplied',
                ancestorKey: parentIds.join('|'),
                parameters: {}
            };
            if (!proposal.geometry) proposal.geometry = {};
            if (proposal.buildingGeometry && !proposal.geometry.buildings) {
                proposal.geometry.buildings = [deepClone(proposal.buildingGeometry)];
            }
        }

        // Normalize structure proposals (parks/squares)
        if (proposal.structureProposal) {
            const sp = { ...proposal.structureProposal };
            sp.kind = (sp.kind === 'park' || sp.kind === 'square' || sp.kind === 'lake') ? sp.kind : 'square';
            sp.parentParcelIds = normalizeParcelIdList(Array.isArray(sp.parentParcelIds) && sp.parentParcelIds.length > 0 ? sp.parentParcelIds : proposal.parentParcelIds || []);
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
        const parentIds = normalizeParcelIdList(proposal.parentParcelIds || (proposal.roadProposal && proposal.roadProposal.parentParcelIds) || []);

        parts.push(`city:${city}`);
        parts.push(`goal:${goal}`);
        parts.push(`parents:${parentIds.join(',')}`);

        // Road / track
        const roadDef = proposal.roadProposal?.definition || proposal.definition || null;
        if (roadDef) {
            parts.push(`roadDef:${serialiseRoadDefinition(roadDef)}`);
        }
        if (proposal.roadProposal?.mode) {
            parts.push(`roadMode:${proposal.roadProposal.mode}`);
        }
        const roadGeom = proposal.roadGeometry?.polygon?.coordinates?.[0];
        if (roadGeom) {
            parts.push(`roadGeom:${serialiseRoadCoordinates(roadGeom)}`);
        }

        // Building proposals
        if (proposal.buildingProposal) {
            parts.push(`buildingParents:${normalizeParcelIdList(proposal.buildingProposal.parentParcelIds || parentIds).join(',')}`);
            if (proposal.buildingProposal.parameters) {
                try { parts.push(`buildingParams:${JSON.stringify(proposal.buildingProposal.parameters, Object.keys(proposal.buildingProposal.parameters).sort())}`); } catch (_) { }
            }
        }
        if (proposal.buildingGeometry) {
            parts.push(`buildingGeom:${serialiseGeometry(proposal.buildingGeometry)}`);
        }

        // Structure (park/square/lake)
        if (proposal.structureProposal) {
            const sp = proposal.structureProposal;
            parts.push(`structureKind:${sp.kind || ''}`);
            parts.push(`structureParents:${normalizeParcelIdList(sp.parentParcelIds || parentIds).join(',')}`);
            if (sp.geometry) parts.push(`structureGeom:${serialiseGeometry(sp.geometry)}`);
        }

        // Reparcellization
        if (proposal.reparcellization) {
            const rep = proposal.reparcellization;
            parts.push(`reparcAlg:${rep.algorithm || ''}`);
            parts.push(`reparcParcels:${normalizeParcelIdList(rep.parcelIds || parentIds).join(',')}`);
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



function resolveProposalIdKey(idOrHash) {
    if (idOrHash === undefined || idOrHash === null || typeof proposalStorage === 'undefined') {
        return null;
    }
    if (typeof proposalStorage._resolveProposalId === 'function') {
        const resolved = proposalStorage._resolveProposalId(idOrHash);
        if (resolved !== null && resolved !== undefined) {
            return resolved;
        }
    }
    return String(idOrHash);
}






function clearProposalPreviewLayers() {
    const groups = ensureProposalOverlayGroups();
    if (groups.preview) groups.preview.clearLayers();
    if (groups.border) groups.border.clearLayers();
    if (groups.buildingPreview) groups.buildingPreview.clearLayers();
}


function updateParcelNumberFilterForProposal(ids) {
    proposalHighlightState.activeParcelIds = ids ? new Set(Array.from(ids)) : new Set();
    if (typeof setParcelNumberLabelFilter === 'function') {
        if (proposalHighlightState.activeParcelIds.size > 0) {
            setParcelNumberLabelFilter(proposalHighlightState.activeParcelIds);
        } else {
            setParcelNumberLabelFilter(null);
        }
    }
}








function renderProposalBuildingPreview(proposal) {
    const groups = ensureProposalOverlayGroups();
    if (!groups.buildingPreview) return;
    groups.buildingPreview.clearLayers();

    const panes = window.__proposalHighlightPanes || null;

    if (!proposal || !collectProposalBuildingFeatures) return;
    const buildingFeatures = collectProposalBuildingFeatures(proposal);
    if (!buildingFeatures.length) return;

    buildingFeatures.forEach(feature => {
        if (!feature || !feature.geometry) return;
        try {
            L.geoJSON(feature, {
                pane: panes?.highlight || undefined,
                style: {
                    color: '#6c63ff',
                    weight: 2,
                    dashArray: '6 4',
                    fillOpacity: 0
                },
                interactive: false
            }).addTo(groups.buildingPreview);
        } catch (error) {
            console.warn('renderProposalBuildingPreview failed for feature', error);
        }
    });

    if (groups.buildingPreview.bringToFront) groups.buildingPreview.bringToFront();
}


// Global flag to suppress camera movements during certain flows (e.g., shared apply)
function isCameraMovementSuppressed() {
    try { return !!(window && window.suppressCameraMoves); } catch (_) { return false; }
}



// Cache proposal-provided parcel features to avoid re-hydrating from the map layer
const proposalFeatureCache = new Map();

function getProposalFeatureCacheKey(proposal) {
    if (!proposal) return null;
    if (typeof getProposalKey === 'function') {
        const key = getProposalKey(proposal);
        if (key) return key;
    }
    return proposal.proposalId || null;
}


function buildProposalFeatureCache(proposal) {
    if (!proposal) return null;
    const cacheKey = getProposalFeatureCacheKey(proposal);
    if (cacheKey && proposalFeatureCache.has(cacheKey)) {
        const existing = proposalFeatureCache.get(cacheKey);
        // Check if parentParcelIds changed (not parentFeatures - we don't cache those)
        const existingParentIds = Array.isArray(existing?.parentParcelIds) ? existing.parentParcelIds : [];
        const currentParentIds = Array.isArray(proposal?.roadProposal?.parentParcelIds) ? proposal.roadProposal.parentParcelIds : [];
        const parentIdsChanged = existingParentIds.length !== currentParentIds.length ||
            !existingParentIds.every((id, i) => String(id) === String(currentParentIds[i]));
        if (!parentIdsChanged) {
            return existing;
        }
        proposalFeatureCache.delete(cacheKey);
    }

    const parcelsById = new Map();
    const parentFeatures = [];

    const addFeaturesToCache = (features, targetList, defaultSource) => {
        if (!Array.isArray(features)) return;
        features.forEach(feature => {
            const normalised = normaliseToFeature(feature, defaultSource ? { source: defaultSource } : {});
            if (!normalised || !normalised.geometry) return;
            const parcelId = getParcelIdFromFeature(normalised);
            if (parcelId) {
                parcelsById.set(parcelId.toString(), normalised);
            }
            targetList.push(normalised);
        });
    };

    // Prefer proposal-provided road assets (parent features)
    const roadAssets = loadRoadAssetsForCache(proposal);
    addFeaturesToCache(roadAssets.parentFeatures, parentFeatures, 'road-parent');

    // Cache any other parcels listed on the proposal (e.g., building proposals)
    const parcelIds = Array.isArray(proposal.parentParcelIds) ? proposal.parentParcelIds : [];
    parcelIds.forEach(parcelId => {
        const key = parcelId && parcelId.toString ? parcelId.toString() : (parcelId ? String(parcelId) : null);
        if (!key || parcelsById.has(key)) {
            return;
        }
        // Only index placeholders here; actual feature resolution happens lazily
        parcelsById.set(key, parcelsById.get(key) || null);
    });

    const cacheValue = { parcelsById, parentFeatures, childFeatures: [] };
    if (cacheKey) {
        proposalFeatureCache.set(cacheKey, cacheValue);
    }
    return cacheValue;
}

function getCachedParcelFeature(parcelId, proposal) {
    if (!parcelId || !proposal) return null;
    const cache = buildProposalFeatureCache(proposal);
    if (!cache || !cache.parcelsById) return null;
    const key = parcelId && parcelId.toString ? parcelId.toString() : String(parcelId);
    const cached = cache.parcelsById.get(key);
    if (cached && cached.geometry) {
        const clone = cloneGeoJSONFeature(cached);
        return clone || cached;
    }
    return null;
}

/**
 * Resolve proposal-related parcel features for the current viewport only.
 *
 * Same code path for 3 ancestors and 3,000: instead of iterating the proposal's id list,
 * we walk the parcel-layer spatial index restricted to the current map bounds and pick out
 * those whose id appears in the proposal's id set. Cost is O(viewport tile count), bounded
 * by what the user can actually see — proposal size has no effect on this loop.
 *
 * Off-screen parcel outlines are intentionally not drawn: they cannot be visible anyway,
 * and primary geometry (road corridor, structure polygon) keeps drawing regardless.
 */
/**
 * Walk the parcel-layer spatial index restricted to the current viewport and invoke
 * `callback(layer, idStr)` for every layer whose id is in `proposalIdSet`.
 *
 * This is the hot path for proposal highlights: for a road proposal with 1438 descendants
 * the old implementation called `multiParcelSelection.findParcelById` + `layer.toGeoJSON()`
 * per match — ~1400 redundant lookups and deep clones — then handed the features back to
 * `L.geoJSON` overlay creation. Walking the viewport index once and mutating existing
 * layers in place is orders of magnitude cheaper (we already HAVE each layer).
 */

/**
 * Legacy shim: some paths still want Feature objects (e.g. overlay construction for
 * non-parcel primary geometry). Uses forEachProposalParcelInViewport + toGeoJSON on
 * the hit layers; callers that just need setStyle should call forEachProposalParcelInViewport
 * directly and avoid the toGeoJSON clone.
 */
function resolveProposalParcelsInViewport(proposalIdSet /* , proposal */) {
    const out = [];
    forEachProposalParcelInViewport(proposalIdSet, (layer) => {
        if (!layer || typeof layer.toGeoJSON !== 'function') return;
        try {
            const feature = layer.toGeoJSON();
            if (feature) out.push(feature);
        } catch (_) { /* ignore */ }
    });
    return out;
}

/**
 * Build the set of parcel ids a proposal wants highlighted (parents + road descendants).
 * The in-place style path walks the viewport spatial index once against this set and
 * mutates matching layers directly — no feature extraction, no overlay layer creation.
 */




/**
 * Parcel-layer style override registry for proposal highlights.
 *
 * Proposal highlights used to create a duplicate L.geoJSON overlay layer per parcel on a
 * dedicated highlight pane. For road proposals with hundreds/thousands of descendant
 * slivers this meant adding hundreds of new Leaflet layers on every repaint — expensive
 * enough to bog the UI down completely.
 *
 * The new approach: never create overlay layers for parcel-shaped highlights. Instead,
 * walk the parcel layers that are already in parcelLayerById and call setStyle() on them
 * directly. Leaflet mutates the existing SVG paths in place — cheap, and the parcels
 * remain clickable because interactivity is unchanged. We stash each layer's
 * pre-highlight style so clear can restore it.
 *
 * _stash is a Map<Layer, { stashedStyle }>. Using a Map (not WeakMap) because we need
 * to iterate it on restore; Leaflet layers live as long as the parcel is on the map.
 */
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

// Expose so selection.js can query/restore proposal highlights without importing this module.
if (typeof window !== 'undefined') {
    window.proposalHighlightStyleOverride = proposalHighlightStyleOverride;
}

/**
 * Highlight a parcel feature by mutating its existing Leaflet layer in place.
 * Returns true if the style was applied, false if the parcel layer could not be
 * resolved — in which case the caller may fall back to creating an overlay layer
 * (for the rare case where a feature was resolved from PersistentStorage but has
 * not yet been ingested into parcelLayerById).
 */


function renderPreviewOverlay(proposal, { blink = false } = {}) {
    const groups = ensureProposalOverlayGroups();
    if (!groups.preview) {
        return { parcelFeatures: [], primaryFeatures: [] };
    }

    groups.preview.clearLayers();

    if (!proposal) {
        return { parcelFeatures: [], primaryFeatures: [] };
    }

    const { parcelFeatures, primaryFeatures } = collectProposalFeatureSets(proposal);
    const hasPrimary = primaryFeatures.length > 0;

    // Check if this is a road proposal to style road geometry differently
    const isRoadProposal = resolveProposalGoalKey(proposal, null) === 'road-track' || !!proposal?.roadProposal;
    const isTrack = isRoadProposal && (
        proposal?.roadProposal?.definition?.metadata?.isTrack === true ||
        proposal?.definition?.metadata?.isTrack === true
    );

    // CRITICAL: Check zoom level before rendering parcel features
    // When zoomed out (below parcel display threshold), we should NOT render individual parcel outlines
    const isZoomWithinRange = isTrack
        ? true // Always show parcel outlines for tracks so borders are visible in preview
        : (typeof window !== 'undefined' && typeof window.isZoomWithinParcelRange === 'function')
            ? window.isZoomWithinParcelRange()
            : (typeof map !== 'undefined' && map ? map.getZoom() >= 17 : true);

    const parcelStyle = {
        color: '#2563EB',
        weight: 3,
        opacity: 1,
        dashArray: '4 6',
        fillOpacity: 0,
        className: 'proposal-preview-parcel'
    };

    // For road proposals, style road geometry with dashed lines and no fill
    // For other proposals, use the standard primary style
    const primaryStyle = isTrack ? {
        color: '#FF8A00',
        weight: 4,
        opacity: 0.95,
        dashArray: '8 6',
        fillOpacity: 0,
        className: 'proposal-preview-track-outline'
    } : isRoadProposal ? {
        color: '#2563EB',
        weight: 4,
        opacity: 0.95,
        dashArray: '10 5',
        fillOpacity: 0,
        className: 'proposal-preview-road-outline'
    } : {
        color: '#8E24AA',
        weight: 4,
        opacity: 0.95,
        dashArray: '2 8',
        fillOpacity: 0.25,
        className: 'proposal-preview-outline'
    };

    // Only render parcel outlines if zoom is within parcel display range
    if (isZoomWithinRange) {
        parcelFeatures.forEach(feature => {
            addFeatureToGroup(feature, groups.preview, parcelStyle, blink ? 'proposal-preview-blink' : null);
        });
    }

    // For road proposals, always show the road geometry (primaryFeatures) even when zoomed out
    // For non-road proposals without primary features, show parcel outlines if zoom is appropriate
    const featuresToDraw = hasPrimary ? primaryFeatures : (isZoomWithinRange ? parcelFeatures : []);

    if (isRoadProposal || isZoomWithinRange) {
        featuresToDraw.forEach(feature => {
            addFeatureToGroup(feature, groups.preview, primaryStyle, blink ? 'proposal-preview-blink' : null);
        });
    }

    if (isTrack) {
        const definition = proposal?.roadProposal?.definition || proposal?.definition;
        const trackPoints = Array.isArray(definition?.points) ? definition.points : null;
        const trackWidth = Number.isFinite(definition?.width) ? definition.width : DEFAULT_CORRIDOR_WIDTHS.track;
        if (trackPoints && trackPoints.length >= 2) {
            const normalizedPoints = trackPoints.map(p => {
                if (p && typeof p.lat === 'function' && typeof p.lng === 'function') return p;
                if (p && typeof p === 'object' && 'lat' in p && 'lng' in p) return L.latLng(Number(p.lat), Number(p.lng));
                if (Array.isArray(p) && p.length >= 2) {
                    const val1 = Number(p[0]);
                    const val2 = Number(p[1]);
                    return Math.abs(val1) <= 90 && Math.abs(val2) <= 180 ? L.latLng(val1, val2) : L.latLng(val2, val1);
                }
                return null;
            }).filter(Boolean);

            if (normalizedPoints.length >= 2) {
                const renderFn = typeof renderTrackWithRails === 'function'
                    ? renderTrackWithRails
                    : (typeof window !== 'undefined' && typeof window.renderTrackWithRails === 'function')
                        ? window.renderTrackWithRails
                        : null;
                if (renderFn) {
                    const trackRailsLayer = renderFn(normalizedPoints, false, {
                        railColor: '#FF8A00',
                        sleeperColor: '#FFC266',
                        trackWidth: trackWidth,
                        pane: groups.preview?.__paneName || (window.__proposalHighlightPanes && window.__proposalHighlightPanes.preview) || undefined
                    });
                    if (trackRailsLayer) {
                        trackRailsLayer.addTo(groups.preview);
                    }
                }
            }
        }
    }

    if (groups.preview.bringToFront) {
        groups.preview.bringToFront();
    }

    return { parcelFeatures, primaryFeatures };
}

function clearProposalPreview() {
    const groups = ensureProposalOverlayGroups();
    if (groups.preview) {
        groups.preview.clearLayers();
    }
    currentProposalPreviewId = null;
}


function previewProposalOnMap(proposalIdOrHash, { center = true, blink = true } = {}) {
    if (!proposalIdOrHash || typeof proposalStorage === 'undefined') {
        return;
    }

    const proposal = getProposalByIdOrHash(proposalIdOrHash);
    if (!proposal) {
        return;
    }

    const proposalKey = getProposalKey(proposal) || resolveProposalIdKey(proposalIdOrHash);
    currentProposalPreviewId = proposalKey;

    const { parcelFeatures, primaryFeatures } = renderPreviewOverlay(proposal, { blink });

    if (!center || typeof map === 'undefined' || !map) {
        return;
    }

    const featuresForBounds = primaryFeatures.length > 0 ? primaryFeatures : parcelFeatures;
    let bounds = computeBoundsFromFeatures(featuresForBounds);

    if (!bounds && Array.isArray(proposal.parentParcelIds) && proposal.parentParcelIds.length > 0) {
        const calculated = calculateProposalBounds(proposal.parentParcelIds, { proposal });
        if (calculated && calculated.north !== undefined && calculated.west !== undefined) {
            try {
                bounds = L.latLngBounds(
                    [calculated.south, calculated.west],
                    [calculated.north, calculated.east]
                );
            } catch (_) {
                bounds = null;
            }
        }
    }

    if (bounds && bounds.isValid && bounds.isValid()) {
        // Suppress parcel fetching when showing proposal contours
        try { window.suppressCameraMoves = true; } catch (_) { }

        // Hide parcel layer if zoomed out too far (to prevent showing all parcels in memory)
        const parcelLayer = (typeof window !== 'undefined' && window.parcelLayer) ? window.parcelLayer : null;
        const wasParcelLayerVisible = parcelLayer && map.hasLayer(parcelLayer);
        if (parcelLayer && wasParcelLayerVisible) {
            try { map.removeLayer(parcelLayer); } catch (_) { }
        }

        map.fitBounds(bounds.pad(0.08), { maxZoom: 19 });

        // Re-enable after map movement completes
        const onMoveEnd = () => {
            map.off('moveend', onMoveEnd);
            try { window.suppressCameraMoves = false; } catch (_) { }

            // Restore parcel layer only if zoom is appropriate
            const finalZoom = map.getZoom();
            const isZoomAppropriate = typeof isZoomWithinParcelRange === 'function'
                ? isZoomWithinParcelRange()
                : finalZoom >= 15; // Default threshold

            if (parcelLayer && wasParcelLayerVisible && isZoomAppropriate) {
                try {
                    if (!map.hasLayer(parcelLayer)) {
                        parcelLayer.addTo(map);
                    }
                } catch (_) { }
            }
        };
        map.on('moveend', onMoveEnd);
    } else if (proposal.bounds && proposal.bounds.center) {
        const { lat, lng } = proposal.bounds.center;
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
            // Suppress parcel fetching when showing proposal contours
            try { window.suppressCameraMoves = true; } catch (_) { }

            // Hide parcel layer if zoomed out too far
            const parcelLayer = (typeof window !== 'undefined' && window.parcelLayer) ? window.parcelLayer : null;
            const wasParcelLayerVisible = parcelLayer && map.hasLayer(parcelLayer);
            if (parcelLayer && wasParcelLayerVisible) {
                try { map.removeLayer(parcelLayer); } catch (_) { }
            }

            map.setView([lat, lng], map.getZoom());

            const onMoveEnd = () => {
                map.off('moveend', onMoveEnd);
                try { window.suppressCameraMoves = false; } catch (_) { }

                // Restore parcel layer only if zoom is appropriate
                const finalZoom = map.getZoom();
                const isZoomAppropriate = typeof isZoomWithinParcelRange === 'function'
                    ? isZoomWithinParcelRange()
                    : finalZoom >= 15;

                if (parcelLayer && wasParcelLayerVisible && isZoomAppropriate) {
                    try {
                        if (!map.hasLayer(parcelLayer)) {
                            parcelLayer.addTo(map);
                        }
                    } catch (_) { }
                }
            };
            map.on('moveend', onMoveEnd);
        }
    }
}

function getFeatureByParcelId(features, parcelId) {
    if (!Array.isArray(features) || !parcelId) return null;
    const target = parcelId.toString();
    return features.find(f => {
        const id = getParcelIdFromFeature(f);
        return id && id.toString() === target;
    }) || null;
}

// Multi-parcel selection state

const multiParcelSelection = {
    isActive: false,
    selectedParcels: new Set(),
    syntheticParcelLayers: new Map(),
    syntheticLayerGroup: null,
    lastSelectedParcelId: null,
    parcelIdIndex: new Map(),
    parcelIdIndexSize: 0,

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
                    layer: hasCurrentParcel
                        ? (currentParcel.layer || this.findParcelById(currentParcel.id))
                        : this.findParcelById(fallbackParcelId)
                }
                : null;

            // Always seed multi-select with the currently viewed parcel (or the last single selection)
            let seedInfo = preservedParcelInfo;
            if (!seedInfo) {
                const seedId = hasCurrentParcel
                    ? currentParcel.id.toString()
                    : (fallbackParcelId || null);
                if (seedId) {
                    const seedLayer = hasCurrentParcel
                        ? (currentParcel.layer || this.findParcelById(seedId))
                        : this.findParcelById(seedId);
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
        if (typeof selectedParcelId !== 'undefined' && selectedParcelId && typeof parcelLayer !== 'undefined' && parcelLayer) {
            parcelLayer.eachLayer(layer => {
                const layerId = getParcelIdFromFeature(layer.feature);
                if (layer.feature && layer.feature.properties &&
                    layerId && layerId.toString() === selectedParcelId) {

                    // Reset style
                    const parcelIdValue = layerId;
                    const baseStyle = (typeof getParcelBaseStyle === 'function')
                        ? getParcelBaseStyle(parcelIdValue)
                        : (() => {
                            const isRoad = (typeof window.isRoadParcel === 'function') ? window.isRoadParcel(parcelIdValue) : false;
                            const globalRoadStyle = window.roadStyle || { fillColor: '#00ff00', fillOpacity: 0.2, color: '#00ff00', weight: 1 };
                            const globalNormalStyle = window.normalStyle || { fillColor: 'red', fillOpacity: 0.2, color: 'red', weight: 1 };
                            return isRoad ? globalRoadStyle : globalNormalStyle;
                        })();
                    layer.setStyle(baseStyle);

                    // ALWAYS use the authoritative function to re-attach the click handler
                    layer.off('click').on('click', getCorrectClickHandler());
                }
            });

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

        const parcelId = getParcelIdFromFeature(parcel.feature)?.toString();
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
        if (typeof selectedParcelId !== 'undefined' && selectedParcelId && typeof parcelLayer !== 'undefined' && parcelLayer) {
            parcelLayer.eachLayer(layer => {
                const layerId = getParcelIdFromFeature(layer.feature);
                if (layer.feature && layer.feature.properties && layerId && layerId.toString() === selectedParcelId) {
                    const baseStyle = (typeof getParcelBaseStyle === 'function')
                        ? getParcelBaseStyle(selectedParcelId)
                        : (() => {
                            const isRoad = (typeof window.isRoadParcel === 'function') ? window.isRoadParcel(selectedParcelId) : false;
                            const globalRoadStyle = window.roadStyle || {
                                fillColor: '#00ff00', fillOpacity: 0.2, color: '#00ff00', weight: 1
                            };
                            const globalNormalStyle = window.normalStyle || {
                                fillColor: 'red', fillOpacity: 0.2, color: 'red', weight: 1
                            };
                            return isRoad ? globalRoadStyle : globalNormalStyle;
                        })();
                    layer.setStyle(baseStyle);
                }
            });
            window.selectedParcelId = null;
        }

        this.updateUI();
    },

    getSyntheticLayerGroup() {
        if (this.syntheticLayerGroup && typeof map !== 'undefined' && map && map.hasLayer(this.syntheticLayerGroup)) {
            return this.syntheticLayerGroup;
        }

        if (!this.syntheticLayerGroup) {
            this.syntheticLayerGroup = L.featureGroup();
        }

        if (typeof map !== 'undefined' && map && !map.hasLayer(this.syntheticLayerGroup)) {
            this.syntheticLayerGroup.addTo(map);
        }

        return this.syntheticLayerGroup;
    },

    // Find parcel layer by ID with fallback to cache
    findParcelById(parcelId) {
        if (parcelId === undefined || parcelId === null) return null;
        const targetId = parcelId.toString();
        if (!targetId) return null;

        if (this.syntheticParcelLayers.has(targetId)) {
            const syntheticLayer = this.syntheticParcelLayers.get(targetId);
            if (syntheticLayer) {
                return syntheticLayer;
            } else {
                this.syntheticParcelLayers.delete(targetId);
            }
        }

        let foundParcel = null;

        // Ensure the parcel layer is initialized/attached before trying to index
        if ((typeof parcelLayer === 'undefined' || !parcelLayer) && typeof ensureParcelLayerInitialized === 'function') {
            ensureParcelLayerInitialized();
        }
        if ((typeof parcelLayer === 'undefined' || !parcelLayer) && typeof addParcelLayerToMapIfAppropriate === 'function') {
            addParcelLayerToMapIfAppropriate();
        }

        // Keep an index of parcelId -> layer for O(1) lookups
        if (typeof parcelLayer !== 'undefined' && parcelLayer) {
            const currentLayerCount = typeof parcelLayer.getLayers === 'function'
                ? parcelLayer.getLayers().length
                : 0;
            const indexStale = this.parcelIdIndexSize !== currentLayerCount || currentLayerCount === 0;
            if (indexStale) {
                this.parcelIdIndex.clear();
                parcelLayer.eachLayer(layer => {
                    const layerId = getParcelIdFromFeature(layer.feature);
                    if (layerId !== undefined && layerId !== null) {
                        this.parcelIdIndex.set(layerId.toString(), layer);
                    }
                });
                this.parcelIdIndexSize = currentLayerCount;
            }

            if (this.parcelIdIndex.has(targetId)) {
                foundParcel = this.parcelIdIndex.get(targetId) || null;
            }
        } else {
            console.warn('findParcelById: parcelLayer not available (initialization pending)');
        }

        // If not found in parcelLayer, try to recover from cache
        if (!foundParcel && typeof parcelCache !== 'undefined') {
            foundParcel = this.recoverParcelFromCache(targetId);
            if (foundParcel) {
                // Sync cache into the index for future lookups
                this.parcelIdIndex.set(targetId, foundParcel);
                this.parcelIdIndexSize = this.parcelIdIndex.size;
            }
        }

        // Final fallback: try PersistentStorage
        if (!foundParcel) {
            foundParcel = this.recoverParcelFromPersistentStorage(targetId);
            if (foundParcel) {
                // Sync cache into the index for future lookups
                this.parcelIdIndex.set(targetId, foundParcel);
                this.parcelIdIndexSize = this.parcelIdIndex.size;
            }
        }

        // Try to recover from proposal data (unapplied descendants)
        if (!foundParcel) {
            foundParcel = this.recoverParcelFromProposals(targetId);
            if (foundParcel) {
                this.parcelIdIndex.set(targetId, foundParcel);
                this.parcelIdIndexSize = this.parcelIdIndex.size;
            }
        }

        if (!foundParcel) {
            // Only escalate when there is no known way to recover the parcel.
            const hasFetchers = typeof fetchSingleParcelById === 'function' || typeof fetchParcelsForIds === 'function';
            const isSynth = typeof ProposalManager !== 'undefined' && typeof ProposalManager.isSyntheticParcelId === 'function'
                && ProposalManager.isSyntheticParcelId(parcelId);
            if (!hasFetchers) {
                console.error('findParcelById: Could not find parcel with ID:', parcelId, 'and no fetcher is available');
            } else if (!isSynth && typeof window !== 'undefined' && window.__DEBUG_PARCEL_HYDRATION__) {
                console.debug('findParcelById: Parcel missing for now, awaiting hydration for ID:', parcelId);
            }
        }

        return foundParcel;
    },

    // Recover parcel from grid cache and instantiate as layer
    recoverParcelFromCache(parcelId) {
        // Don't recover parcels that have been removed by a proposal (e.g., parent parcels replaced by children)
        if (typeof isParcelReplacedByChildren === 'function' && isParcelReplacedByChildren(parcelId)) {
            return null;
        }

        if (!parcelCache || !parcelCache.grid) return null;

        // Search all grid cells for the parcel
        for (const [gridKey, cellData] of parcelCache.grid) {
            if (cellData && cellData.features) {
                const feature = cellData.features.find(f =>
                    getParcelIdFromFeature(f)?.toString() === parcelId.toString()
                );

                if (feature) {
                    return this.createParcelLayerFromFeature(feature);
                }
            }
        }
        return null;
    },

    // Recover parcel from PersistentStorage and instantiate as layer
    recoverParcelFromPersistentStorage(parcelId) {
        // Don't recover parcels that have been removed by a proposal (e.g., parent parcels replaced by children)
        if (typeof isParcelReplacedByChildren === 'function' && isParcelReplacedByChildren(parcelId)) {
            return null;
        }

        const record = typeof readPersistedParcelRecord === 'function'
            ? readPersistedParcelRecord(parcelId)
            : null;

        if (record && record.geometry && record.properties) {
            try {
                const rawGeometry = record.geometry;
                const properties = record.properties;

                const geometry = (rawGeometry && typeof rawGeometry === 'object' && rawGeometry.type && rawGeometry.coordinates)
                    ? JSON.parse(JSON.stringify(rawGeometry))
                    : null;

                if (!geometry) return null;

                const feature = ensureParcelIdOnFeature({
                    type: 'Feature',
                    properties: properties && typeof properties === 'object' ? { ...properties } : {},
                    geometry
                });

                if (!feature || !feature.properties) {
                    return null;
                }

                // Ensure calculatedArea is set when possible, but don't fail if unavailable
                if (feature.properties.calculatedArea === undefined || feature.properties.calculatedArea === null) {
                    if (typeof calculateArea === 'function') {
                        try {
                            feature.properties.calculatedArea = calculateArea([geometry]);
                        } catch (_) {
                            // Ignore area calculation failure; allow layer creation to proceed
                        }
                    }
                }

                return this.createParcelLayerFromFeature(feature);
            } catch (e) {
                console.error(`Error reconstructing parcel ${parcelId} from PersistentStorage:`, e);
            }
        }
        return null;
    },

    recoverParcelFromProposals(parcelId) {
        // Guard against infinite recursion
        if (this._recoveringParcels && this._recoveringParcels.has(parcelId.toString())) {
            return null;
        }
        if (!this._recoveringParcels) {
            this._recoveringParcels = new Set();
        }
        this._recoveringParcels.add(parcelId.toString());

        try {
            // Don't recover parcels that have been removed by a proposal (e.g., parent parcels replaced by children)
            if (typeof isParcelReplacedByChildren === 'function' && isParcelReplacedByChildren(parcelId)) {
                return null;
            }

            if (typeof proposalStorage === 'undefined' || !proposalStorage.getAllProposals) {
                return null;
            }

            const proposals = proposalStorage.getAllProposals();
            if (!Array.isArray(proposals) || proposals.length === 0) {
                return null;
            }

            const targetId = parcelId.toString();

            for (const proposal of proposals) {
                if (!proposal || normalizeProposalGoalKey(proposal.goal) !== 'road-track') continue;
                const roadProposal = proposal.roadProposal;
                if (!roadProposal) continue;

                const parentIds = ensureArrayOfStrings(roadProposal.parentParcelIds || proposal.parentParcelIds || proposal.parentParcelIds || []);
                const childIds = ensureArrayOfStrings(roadProposal.childParcelIds || []);

                const isParent = parentIds.includes(targetId);
                const isChild = childIds.includes(targetId);

                if (!isParent && !isChild) continue;

                // Skip recovery to prevent infinite recursion (we're already in recoverParcelFromProposals)
                const candidateFeature = getParcelFeatureForHighlight(targetId, proposal, { skipRecovery: true });
                if (!candidateFeature) continue;

                try {
                    const featureClone = JSON.parse(JSON.stringify(candidateFeature));
                    const layer = this.createParcelLayerFromFeature(featureClone, {
                        addToParcelLayer: false,
                        makeInteractive: false
                    });

                    if (!layer) {
                        continue;
                    }

                    layer._isSynthetic = true;
                    const group = this.getSyntheticLayerGroup();
                    if (group) {
                        group.addLayer(layer);
                    } else if (typeof map !== 'undefined' && map) {
                        layer.addTo(map);
                    }
                    this.syntheticParcelLayers.set(targetId, layer);
                    return layer;
                } catch (error) {
                    console.error('recoverParcelFromProposals: unable to instantiate feature', error);
                }
            }

            return null;
        } finally {
            // Always remove from recovering set, even if we return early
            if (this._recoveringParcels) {
                this._recoveringParcels.delete(parcelId.toString());
            }
        }
    },

    // Create a Leaflet layer from a feature and add it to parcelLayer
    createParcelLayerFromFeature(feature, options = {}) {
        if (!feature || !feature.geometry || !feature.properties) {
            console.error('createParcelLayerFromFeature: Invalid feature provided');
            return null;
        }

        const { addToParcelLayer = true, makeInteractive = true } = options;

        const normalizedFeature = ensureParcelIdOnFeature(feature);

        // Don't add parcels that have been removed by a proposal (e.g., parent parcels replaced by children)
        const parcelId = getParcelIdFromFeature(normalizedFeature);
        const persistedRecord = parcelId ? readPersistedParcelRecord(parcelId) : null;
        if (addToParcelLayer && parcelId) {
            if (typeof isParcelReplacedByChildren === 'function' && isParcelReplacedByChildren(parcelId)) {
                // Return null to prevent re-adding a removed parcel
                return null;
            }
        }

        try {
            // Convert coordinates if needed (same logic as in fetchParcelData)
            let convertedFeature = normalizedFeature;
            if (typeof convertGeoJSON === 'function') {
                const featureCollection = {
                    type: 'FeatureCollection',
                    features: [normalizedFeature]
                };
                const converted = convertGeoJSON(featureCollection);
                convertedFeature = converted.features[0];
            }

            // Create the Leaflet layer
            const layer = L.geoJSON(convertedFeature, {
                style: (feature) => {
                    const parcelId = getParcelIdFromFeature(feature);
                    const storedRoad = (parcelId && typeof window.isRoadParcel === 'function') ? window.isRoadParcel(parcelId) : false;
                    const propertyRoad = feature?.properties?.isRoad === true;
                    const isRoad = storedRoad || propertyRoad;
                    // Use global styles if available
                    const roadStyleToUse = typeof roadStyle !== 'undefined' ? roadStyle : {
                        fillColor: '#00ff00', fillOpacity: 0.2, color: '#00ff00', weight: 1
                    };
                    const normalStyleToUse = typeof normalStyle !== 'undefined' ? normalStyle : {
                        fillColor: 'red', fillOpacity: 0.2, color: 'red', weight: 1
                    };
                    return isRoad ? roadStyleToUse : normalStyleToUse;
                },
                onEachFeature: function (feature, layer) {
                    if (makeInteractive && typeof onParcelClick === 'function') {
                        layer.on({
                            mouseover: typeof highlightFeature === 'function' ? highlightFeature : () => { },
                            mouseout: typeof resetHighlight === 'function' ? resetHighlight : () => { },
                            click: onParcelClick
                        });
                    }
                }
            });

            // Extract the actual parcel layer (geoJSON creates a layer group)
            let parcelLayerInstance = null;
            layer.eachLayer(l => {
                if (!parcelLayerInstance) parcelLayerInstance = l;
            });

            if (parcelLayerInstance) {
                // Add road properties if applicable
                const parcelId = getParcelIdFromFeature(feature);
                const storedRoad = (parcelId && typeof window.isRoadParcel === 'function') ? window.isRoadParcel(parcelId) : false;
                const persistedProps = persistedRecord?.properties || {};
                const propertyRoad = parcelLayerInstance?.feature?.properties?.isRoad === true
                    || feature?.properties?.isRoad === true
                    || persistedProps.isRoad === true;
                const isRoad = storedRoad || propertyRoad;
                parcelLayerInstance.feature.properties.isRoad = !!isRoad;
                if (isRoad) {
                    const roadName = feature?.properties?.roadName
                        || persistedProps.roadName
                        || 'Unnamed Road';
                    parcelLayerInstance.bindTooltip(roadName, {
                        permanent: false,
                        direction: 'center',
                        className: 'road-name-tooltip'
                    });
                    parcelLayerInstance.feature.properties.roadName = roadName;
                    parcelLayerInstance.feature.properties.roadId = feature?.properties?.roadId
                        || persistedProps.roadId
                        || '';
                    parcelLayerInstance.feature.properties.roadConfidence = feature?.properties?.roadConfidence
                        || persistedProps.roadConfidence
                        || '0';
                }

                // Add to parcelLayer if it exists
                if (addToParcelLayer && typeof parcelLayer !== 'undefined' && parcelLayer) {
                    parcelLayer.addLayer(parcelLayerInstance);
                    if (typeof window.indexParcelLayer === 'function') {
                        window.indexParcelLayer(parcelLayerInstance);
                    }
                    // Don't add directly to map - layers in parcelLayer are automatically rendered
                    // when parcelLayer is on the map. Adding directly causes double rendering.
                }

                // Validate that the layer has getBounds before returning
                if (typeof parcelLayerInstance.getBounds === 'function') {
                    return parcelLayerInstance;
                } else {
                    console.error('createParcelLayerFromFeature: Created layer does not have getBounds method');
                    return null;
                }
            }
        } catch (e) {
            console.error('Error creating parcel layer from feature:', e);
        }

        return null;
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
        const parcelId = getParcelIdFromFeature(parcel?.feature);
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

        // Hide single-parcel proposal button when multi-select is active
        const singleParcelButton = document.getElementById('createProposalFromParcelButton');
        if (singleParcelButton) {
            if (this.isActive) {
                singleParcelButton.style.display = 'none';
            }
            // When multi-select is off, the button visibility is controlled by single parcel selection
        }

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

                    // Ensure road checkbox is visible for single parcel view
                    const roadCheckboxGroup = document.querySelector('#parcel-info-panel .road-checkbox');
                    if (roadCheckboxGroup) {
                        roadCheckboxGroup.style.display = '';
                    }

                    // Clear all tab content
                    const infoContent = document.getElementById('info-content');
                    const proposalsContent = document.getElementById('proposals-content');
                    if (infoContent) infoContent.innerHTML = '';
                    if (proposalsContent) proposalsContent.innerHTML = '';

                    showParcelInfoPanel(parcel.feature);
                    document.getElementById('parcel-info-panel').classList.add('visible');
                    setParcelInfoPanelTitle(
                        window.i18n ? window.i18n.t('panel.parcel.multiSelectionTitle', {}) : 'Multiparcel selection',
                        { i18nKey: 'panel.parcel.multiSelectionTitle' }
                    );
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
            const props = parcel?.feature?.properties || {};
            const areaSource = props.calculatedArea
                || props.area
                || props.parcelArea
                || props.informationTechnical?.superficie_total;
            const area = Number.isFinite(Number(areaSource)) ? Number(areaSource) : 0;
            const explicitPrice = Number(props.estimatedMarketPrice);
            const price = Number.isFinite(explicitPrice) ? explicitPrice : (area ? area * avgSqmPrice : 0);
            const currency = props.estimatedMarketPriceCurrency || props.currency || 'EUR';
            return { parcel, area, price, currency };
        });

        const totalArea = parcelSummaries.reduce((sum, p) => sum + (p.area || 0), 0);
        const totalEstimatedPrice = parcelSummaries.reduce((sum, p) => sum + (p.price || 0), 0);

        // Calculate total owners across all parcels
        let totalOwners = 0;
        const ownerKeys = new Set();
        if (typeof getParcelOwnerSlots === 'function') {
            for (const parcel of parcels) {
                const parcelId = getParcelIdFromFeature(parcel?.feature);
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

        // Hide road checkbox section
        const roadCheckboxGroup = document.querySelector('#parcel-info-panel .road-checkbox');
        if (roadCheckboxGroup) {
            roadCheckboxGroup.style.display = 'none';
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
                        ${parcelSummaries.map(({ parcel, area, price, currency }) => {
            const parcelId = getParcelIdFromFeature(parcel?.feature);
            const isRoad = parcelId && typeof window.isRoadParcel === 'function' ? window.isRoadParcel(parcelId) : false;
            const parcelNumberDisplay = getParcelDisplayNumberFromProperties(parcel?.feature?.properties, parcelId);
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

        // Show road checkbox section again
        const roadCheckboxGroup = document.querySelector('#parcel-info-panel .road-checkbox');
        if (roadCheckboxGroup) {
            roadCheckboxGroup.style.display = '';
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

        // Use a small delay to ensure parcel layer updates are complete
        setTimeout(() => {
            this.selectedParcels.forEach(parcelId => {
                const parcel = this.findParcelById(parcelId);
                if (parcel) {
                    this.addParcelHighlight(parcel);
                }
            });
        }, 50);
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
            if (layer && layer.feature && layer.feature.properties) {
                const parcelId = getParcelIdFromFeature(layer.feature);
                if (parcelId) {
                    const parcelIdStr = parcelId.toString();
                    this.selectedParcels.add(parcelIdStr);
                    this.addParcelHighlight(layer);
                }
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

// Proposal layer management

// --- Proposal Color Palette ---
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
function getProposalColor(hash) {
    // Simple hash to color mapping
    let sum = 0;
    for (let i = 0; i < hash.length; i++) sum += hash.charCodeAt(i);
    return PROPOSAL_COLORS[sum % PROPOSAL_COLORS.length];
}
function blendColors(colors) {
    // Simple average RGB blend
    if (colors.length === 1) return colors[0];
    let r = 0, g = 0, b = 0;
    colors.forEach(hex => {
        const c = hex.replace('#', '');
        r += parseInt(c.substring(0, 2), 16);
        g += parseInt(c.substring(2, 4), 16);
        b += parseInt(c.substring(4, 6), 16);
    });
    r = Math.floor(r / colors.length);
    g = Math.floor(g / colors.length);
    b = Math.floor(b / colors.length);
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

// With no separate proposal mode, this becomes a no-op kept for compatibility.

// Refresh the proposals layer (called when proposals are updated)

// Lightweight function to refresh proposal data without rebuilding visual layers

// Handle clicks on road proposals

// Handle clicks on proposal parcels
// Proposal highlighting state
window.currentlyHighlightedProposal = null;
window.selectedParcelInProposal = null;
window.isApplyingProposalHighlights = false;

// Apply proposal highlights (can be called repeatedly)

// Clear proposal highlights

// Function to re-apply highlights after parcel layer updates

/** Bounds from road centerline / stored polygon — avoids hundreds of findParcelById calls for huge parent lists. */


// Unified function to select and highlight a proposal with proper sequencing

/**
 * Single-path proposal opener — same code for 3 ancestors and 3,000.
 *
 * Contract:
 *   1. The details panel + highlights paint immediately, using whatever bounds we can derive
 *      from proposal metadata (road definition / structure geometry / stored bounds / in-memory
 *      ancestor parcels). We never await parcel hydration before showing the panel.
 *   2. Ancestor parcels load in the background (fire-and-forget). As tiles arrive, the
 *      parcelDataLoaded → scheduleHighlightRefresh path repaints highlights and fills in the
 *      lazy ancestor list. The proposal becomes visually complete progressively, without
 *      blocking the main thread.
 *
 * This means there is no "mega proposal" branch — proposal size only changes how much data
 * the background fetch pulls, not which functions run.
 */

function openProposalFromList(proposalIdOrHash, options = {}) {
    if (!proposalIdOrHash || typeof proposalStorage === 'undefined') {
        return false;
    }

    const normalized = options && typeof options === 'object' ? options : {};
    const proposal = normalized.proposal || getProposalByIdOrHash(proposalIdOrHash);
    if (!proposal) {
        updateStatus('Proposal not found');
        return false;
    }

    const parcelIds = Array.isArray(proposal.parentParcelIds) ? proposal.parentParcelIds : [];
    const fallbackParcel = normalized.parcelId
        || getFirstSelectableParcel(proposal)
        || (parcelIds.length > 0 ? parcelIds[0] : null);

    if (normalized.closeAgentDialog !== false && typeof closeAgentDialog === 'function') {
        closeAgentDialog();
    }

    if (normalized.closeParcelInfo !== false && typeof hideParcelInfoPanel === 'function') {
        hideParcelInfoPanel();
    }

    if (normalized.closeProposalList !== false) {
        closeProposalList({ clearHighlights: false });
    }

    if (normalized.collapseSidebar) {
        const sidebar = document.getElementById('sidebar');
        if (sidebar && !sidebar.classList.contains('collapsed') && typeof toggleSidebar === 'function') {
            try { toggleSidebar(); } catch (_) { }
        }
    }

    const proposalKey = getProposalKey(proposal) || resolveProposalIdKey(proposalIdOrHash);

    focusProposalDetails(proposalKey, {
        parcelId: fallbackParcel,
        centerOnProposal: normalized.centerOnProposal !== false,
        showDetails: normalized.showDetails !== false
    });

    return true;
}

window.openProposalFromList = openProposalFromList;

const APPLY_DISABLED_TYPE_KEYS = new Set();



if (typeof window !== 'undefined') {
    window.normalizeProposalGoalKey = normalizeProposalGoalKey;
    window.resolveProposalGoalKey = resolveProposalGoalKey;
}

function resolveProposalActionTypeKey(proposal, fallbackProposal) {
    return resolveProposalGoalKey(proposal, fallbackProposal);
}



window.focusProposalDetails = focusProposalDetails;
window.applyProposalToMap = applyProposalToMap;
window.removeProposalFromMap = removeProposalFromMap;



// Override the parcel click when proposals are shown


/**
 * Returns the correct parcel click handler based on the current UI state.
 * This is the single source of truth for parcel click behavior.
 */
function getCorrectClickHandler() {
    // Always allow normal parcel clicking; proposals display should never block interactions
    // Fallback to the global handler if the original has not been captured yet
    if (!originalOnParcelClick || typeof originalOnParcelClick !== 'function') {
        if (typeof window !== 'undefined' && typeof window.onParcelClick === 'function') {
            originalOnParcelClick = window.onParcelClick;
        }
    }
    // Ensure we always return a function to avoid Leaflet listener errors
    return (typeof originalOnParcelClick === 'function')
        ? originalOnParcelClick
        : (typeof window !== 'undefined' && typeof window.onParcelClick === 'function'
            ? window.onParcelClick
            : function () { });
}

/**
 * A robust click handler that is aware of the proposal mode.
 * It checks if a clicked parcel is part of a proposal and routes
 * the click to the appropriate handler.
 * @param {L.LeafletEvent} e The Leaflet click event.
 */

// Show proposal info panel
// NOTE: This is a pure display function. It expects the proposal to contain all necessary data
// (parentFeatures, childFeatures, parcelIds). No data fetching should happen here.
// Proposals are created from loaded parcels, so all data should already be present.










function focusParcelInMap(parcelId) {
    if (!parcelId || typeof map === 'undefined' || !map) return;
    if (typeof multiParcelSelection === 'undefined' || !multiParcelSelection.findParcelById) return;

    try {
        const layer = multiParcelSelection.findParcelById(parcelId);
        if (!layer) return;

        if (!isCameraMovementSuppressed() && typeof layer.getBounds === 'function') {
            const bounds = layer.getBounds();
            if (bounds && bounds.isValid()) {
                map.fitBounds(bounds, { padding: [50, 50] });
                return;
            }
        }

        if (!isCameraMovementSuppressed() && typeof layer.getLatLng === 'function') {
            map.panTo(layer.getLatLng());
        }
    } catch (error) {
        console.warn('focusParcelInMap: unable to focus parcel', parcelId, error);
    }
}











// Make returnToParcelInfo globally available
window.returnToParcelInfo = returnToParcelInfo;

/**
 * Hide the proposal details panel
 */




// Make hideProposalDetailsPanel globally available
window.hideProposalDetailsPanel = hideProposalDetailsPanel;
window.toggleProposalDetailsPanelMinimized = toggleProposalDetailsPanelMinimized;



const DEFAULT_PROPOSAL_TYPE = 'Square';
const PROPOSAL_GOAL_ICON_MAP = {
    'as-is': { icon: '🟰', label: 'No change' },
    'square': { icon: '⛲️', label: 'Square' },
    'park': { icon: '🌳', label: 'Park' },
    'lake': { icon: '🐟', label: 'Lake' },
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
// Track ownership transfer direction: 'to-me' or 'from-me'
// Stored screenshot data URL captured when proposal modal opens


function normalizeGoalKey(value) {
    const raw = (value || '').toString().trim().toLowerCase();
    if (!raw) return '';
    if (raw.startsWith('building')) return 'single';
    if (raw === 'road track') return 'road-track';
    if (raw === 'ownership transfer to me' || raw === 'ownership-transfer-to-me') return 'ownership-transfer-to-me';
    if (raw === 'ownership transfer from me' || raw === 'ownership-transfer-from-me') return 'ownership-transfer-from-me';
    if (raw === 'ownership transfer' || raw === 'ownership-transfer') return 'ownership-transfer';
    return raw;
}

function updateProposalScreenshotGoalIcon(toolKey) {
    const container = document.querySelector('#proposalScreenshotContainer .map-screenshot-container');
    if (!container) return;

    const iconConfig = getProposalGoalBadge(toolKey);

    let badge = container.querySelector('.proposal-goal-badge');
    if (!iconConfig) {
        if (badge) {
            badge.style.display = 'none';
            badge.textContent = '';
            badge.removeAttribute('aria-label');
            badge.removeAttribute('title');
        }
        return;
    }

    if (!badge) {
        badge = document.createElement('div');
        badge.className = 'proposal-goal-badge';
        container.appendChild(badge);
    }

    badge.style.display = 'flex';
    badge.textContent = iconConfig.text;
    badge.setAttribute('aria-label', iconConfig.label);
    badge.setAttribute('title', iconConfig.label);
}

function getProposalGoalBadge(goalKey) {
    const normalizedKey = normalizeGoalKey(goalKey);
    const iconConfig = PROPOSAL_GOAL_ICON_MAP[normalizedKey];
    if (!iconConfig) return null;
    return {
        text: iconConfig.icon,
        label: iconConfig.label
    };
}

// Goals that don't have meaningful map geometry, so a screenshot would just be a placeholder.
// Note: decide-later and reparcellization are intentionally NOT in this set — they have parent
// parcels (or per-slice geometry) we can frame.
const PROPOSAL_SCREENSHOT_SKIP_GOALS = new Set([
    'urban-rule',
    'ownership-transfer',
    'ownership-transfer-to-me',
    'ownership-transfer-from-me'
]);

function shouldSkipProposalScreenshot(proposal) {
    if (!proposal) return true;
    const goalKey = normalizeGoalKey(proposal.goal || proposal.proposalType || proposal.type || '');
    return PROPOSAL_SCREENSHOT_SKIP_GOALS.has(goalKey);
}

function getStoredProposalById(proposalId) {
    if (!proposalId || typeof proposalStorage === 'undefined') return null;
    if (typeof proposalStorage.getProposal === 'function') {
        const found = proposalStorage.getProposal(proposalId);
        if (found) return found;
    }
    if (proposalStorage.proposals && typeof proposalStorage.proposals.get === 'function') {
        return proposalStorage.proposals.get(proposalId) || null;
    }
    return null;
}

function getBackendBaseUrl() {
    try {
        if (typeof window.getBackendBase === 'function') {
            const base = window.getBackendBase();
            if (base) return base.replace(/\/$/, '');
        }
    } catch (_) { }
    if (typeof window !== 'undefined' && window.location) {
        return `${window.location.protocol}//${window.location.host}`.replace(/\/$/, '');
    }
    return '';
}

// Upload a thumbnail data URL to the backend (no IPFS fallback). Used by the mint flow when
// converting a local thumbnail into a shareable one. NOT used during ordinary proposal creation —
// thumbnails stay as data URLs in localStorage until the proposal is minted.
async function uploadProposalScreenshotDataUrl(proposal, dataUrl) {
    if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) return null;
    const proposalId = proposal?.proposalId || proposal?.id || `unknown-${Date.now()}`;
    const fileNameBase = `proposal-thumb-${proposalId}-${Date.now()}`;
    const metadataPayload = {
        name: proposal?.title || proposal?.name || `Proposal ${proposalId}`,
        description: 'Proposal map thumbnail',
        properties: { proposalId: String(proposalId), kind: 'thumbnail' }
    };
    try {
        const base = getBackendBaseUrl();
        const response = await fetch(`${base}/assets/upload`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                imageData: dataUrl,
                metadata: metadataPayload,
                fileName: fileNameBase
            })
        });
        if (!response.ok) {
            console.warn('[proposal screenshot] backend upload returned', response.status);
            return null;
        }
        const result = await response.json();
        return result?.imageGatewayUrl || result?.imageUrl || result?.uploadedImageUrl || null;
    } catch (err) {
        console.warn('[proposal screenshot] Upload failed:', err);
        return null;
    }
}

async function patchProposalScreenshotOnServer(proposal, screenshotUrl) {
    const serialId = (typeof getSerialProposalId === 'function') ? getSerialProposalId(proposal) : null;
    if (!serialId) return false;
    try {
        const base = getBackendBaseUrl();
        const response = await fetch(`${base}/proposals/${encodeURIComponent(serialId)}/screenshot`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ screenshotUrl })
        });
        if (!response.ok) {
            console.warn('[proposal screenshot] PATCH returned', response.status);
            return false;
        }
        return true;
    } catch (err) {
        console.warn('[proposal screenshot] PATCH failed:', err);
        return false;
    }
}

function persistProposalScreenshotUrl(proposalId, url) {
    if (!proposalId || !url) return false;
    const stored = getStoredProposalById(proposalId);
    if (!stored) return false;
    stored.screenshotUrl = url;
    stored.updatedAt = new Date().toISOString();
    try {
        if (typeof proposalStorage.save === 'function') proposalStorage.save();
    } catch (_) { }
    try {
        if (typeof document !== 'undefined' && typeof CustomEvent === 'function') {
            document.dispatchEvent(new CustomEvent('proposalScreenshotUpdated', {
                detail: { proposalId, screenshotUrl: url }
            }));
        }
    } catch (_) { }
    return true;
}

// Save the captured data URL on the local proposal so it can be rendered as a thumbnail
// without going through the backend. Used during proposal creation and click-to-generate.
function persistProposalScreenshotDataUrl(proposalId, dataUrl) {
    if (!proposalId || !dataUrl) return false;
    const stored = getStoredProposalById(proposalId);
    if (!stored) return false;
    stored.screenshotDataUrl = dataUrl;
    stored.updatedAt = new Date().toISOString();
    try {
        if (typeof proposalStorage.save === 'function') proposalStorage.save();
    } catch (err) {
        // localStorage quota exceeded or similar — drop the data URL so we don't keep failing.
        console.warn('[proposal screenshot] Failed to save data URL locally (likely quota):', err);
        delete stored.screenshotDataUrl;
        return false;
    }
    try {
        if (typeof document !== 'undefined' && typeof CustomEvent === 'function') {
            document.dispatchEvent(new CustomEvent('proposalScreenshotUpdated', {
                detail: { proposalId, screenshotDataUrl: dataUrl }
            }));
        }
    } catch (_) { }
    return true;
}

// Capture (or accept) a thumbnail data URL for the given proposal and store it locally.
// By default the data URL is kept in localStorage only — uploads to the backend happen later
// (currently only on mint). Pass { uploadToServer: true } to force an upload.
async function captureAndPersistProposalScreenshot(proposalId, options = {}) {
    if (!proposalId) return null;
    const proposal = getStoredProposalById(proposalId);
    if (!proposal) return null;
    if (shouldSkipProposalScreenshot(proposal)) return null;

    const force = !!options.force;
    if (!force && (proposal.screenshotUrl || proposal.screenshotDataUrl)) {
        return proposal.screenshotUrl || proposal.screenshotDataUrl;
    }

    // If the proposal was just minted, copy the on-chain image url onto the proposal
    // so list rendering uses the canonical URL.
    if (!force) {
        const onchainImage = proposal.onchain?.imageUrl || proposal.onchainData?.imageUrl;
        if (onchainImage) {
            persistProposalScreenshotUrl(proposalId, onchainImage);
            patchProposalScreenshotOnServer(proposal, onchainImage);
            return onchainImage;
        }
    }

    let dataUrl = options.screenshotDataUrl || null;

    // Prefer a cached modal preview if the modal is still open / just closed.
    if (!dataUrl && options.allowModalCache !== false) {
        if (proposalModalScreenshotDataUrl) {
            dataUrl = proposalModalScreenshotDataUrl;
        } else if (options.modalPromise) {
            try { dataUrl = await options.modalPromise; } catch (_) { dataUrl = null; }
        } else if (proposalModalScreenshotPromise) {
            try { dataUrl = await proposalModalScreenshotPromise; } catch (_) { dataUrl = null; }
        }
    }

    if (!dataUrl && typeof reconstructProposalScreenshotDataUrl === 'function') {
        try {
            dataUrl = await reconstructProposalScreenshotDataUrl(proposal);
        } catch (err) {
            console.warn('[proposal screenshot] Reconstruction failed:', err);
            dataUrl = null;
        }
    }

    if (!dataUrl) return null;

    persistProposalScreenshotDataUrl(proposalId, dataUrl);

    // Optional upload path — used by mint flow when a permanent URL is needed.
    if (options.uploadToServer) {
        const url = await uploadProposalScreenshotDataUrl(proposal, dataUrl);
        if (url) {
            persistProposalScreenshotUrl(proposalId, url);
            patchProposalScreenshotOnServer(proposal, url);
            return url;
        }
    }

    return dataUrl;
}

if (typeof document !== 'undefined') {
    document.addEventListener('proposalCreated', (event) => {
        const detail = event && event.detail ? event.detail : {};
        const proposalId = detail.proposalId;
        if (!proposalId) return;
        // Snapshot any pending modal-preview capture synchronously, before closeProposalDialog clears it.
        const snapshotDataUrl = proposalModalScreenshotDataUrl;
        const snapshotPromise = proposalModalScreenshotPromise;
        captureAndPersistProposalScreenshot(proposalId, {
            screenshotDataUrl: snapshotDataUrl,
            modalPromise: snapshotPromise
        }).catch(err => {
            console.warn('[proposalCreated] background capture failed', err);
        });
    });
}

// Pull a [lng, lat] coordinate ring out of whatever the proposal stored.
// Returns { polygon, polygonOrder, fitToPolygonOnly } in the shape captureViaTileStitch expects.
function resolveProposalPolygonForScreenshot(proposal) {
    if (!proposal) return { polygon: null };
    const goalKey = normalizeGoalKey(proposal.goal || proposal.proposalType || '');

    const fromGeometry = (geom) => {
        if (!geom || !geom.coordinates) return null;
        if (geom.type === 'Polygon') return { polygon: geom.coordinates, polygonOrder: 'lnglat' };
        if (geom.type === 'MultiPolygon') return { polygon: geom.coordinates[0], polygonOrder: 'lnglat' };
        return null;
    };

    if (goalKey === 'road-track') {
        const rp = proposal.roadProposal || {};
        const def = rp.definition || proposal.definition || {};
        const candidates = [
            rp.polygon,
            rp.superGeometry,
            rp.geometry,
            def.polygon,
            proposal.geometry && proposal.geometry.roadGeometry && proposal.geometry.roadGeometry.polygon
        ];
        for (const candidate of candidates) {
            const resolved = fromGeometry(candidate);
            if (resolved) return { ...resolved, fitToPolygonOnly: true };
        }

        // Last resort: buffer the centerline by half the road width to synthesise a polygon.
        const points = Array.isArray(def.points) ? def.points : [];
        const width = Number.isFinite(Number(def.width)) ? Number(def.width) : 0;
        if (points.length >= 2 && width > 0 && typeof turf !== 'undefined' && typeof turf.lineString === 'function' && typeof turf.buffer === 'function') {
            try {
                const coords = points
                    .map(p => {
                        const lng = Number(p && (p.lng ?? p.lon ?? p.longitude ?? p[0]));
                        const lat = Number(p && (p.lat ?? p.latitude ?? p[1]));
                        return Number.isFinite(lat) && Number.isFinite(lng) ? [lng, lat] : null;
                    })
                    .filter(Boolean);
                if (coords.length >= 2) {
                    const line = turf.lineString(coords);
                    const buffered = turf.buffer(line, width / 2, { units: 'meters' });
                    const resolved = fromGeometry(buffered && buffered.geometry);
                    if (resolved) return { ...resolved, fitToPolygonOnly: true };
                }
            } catch (err) {
                console.warn('[proposal screenshot] Failed to buffer road centerline:', err);
            }
        }
    }

    if (proposal.buildingGeometry) {
        const resolved = fromGeometry(proposal.buildingGeometry);
        if (resolved) return resolved;
    }

    if (proposal.structureProposal && proposal.structureProposal.geometry) {
        const resolved = fromGeometry(proposal.structureProposal.geometry);
        if (resolved) return resolved;
    }

    // Reparcellization: union the slice geometries so the screenshot frames the whole carve-up.
    if (proposal.reparcellization && Array.isArray(proposal.reparcellization.polygons) && proposal.reparcellization.polygons.length) {
        const slices = proposal.reparcellization.polygons
            .map(s => s && s.geometry)
            .filter(g => g && g.coordinates && (g.type === 'Polygon' || g.type === 'MultiPolygon'));
        if (slices.length === 1) {
            const resolved = fromGeometry(slices[0]);
            if (resolved) return resolved;
        } else if (slices.length > 1 && typeof turf !== 'undefined' && typeof turf.union === 'function') {
            try {
                let merged = null;
                slices.forEach(geom => {
                    const feature = { type: 'Feature', properties: {}, geometry: geom };
                    merged = merged ? (turf.union(merged, feature) || merged) : feature;
                });
                if (merged && merged.geometry) {
                    const resolved = fromGeometry(merged.geometry);
                    if (resolved) return resolved;
                }
            } catch (err) {
                console.warn('[proposal screenshot] turf.union failed for reparcellization slices:', err);
                const resolved = fromGeometry(slices[0]);
                if (resolved) return resolved;
            }
        }
    }

    if (proposal.geometry && (proposal.geometry.type === 'Polygon' || proposal.geometry.type === 'MultiPolygon')) {
        const resolved = fromGeometry(proposal.geometry);
        if (resolved) return resolved;
    }

    // Generic geometry collection fallback (e.g. parcel-only or reparcellization proposals)
    if (proposal.geometry && proposal.geometry.buildings && Array.isArray(proposal.geometry.buildings)) {
        for (const f of proposal.geometry.buildings) {
            const resolved = fromGeometry(f && f.geometry);
            if (resolved) return resolved;
        }
    }

    return { polygon: null };
}




// Rebuild a tile-stitched screenshot from the persisted proposal data only — no live selection required.
async function reconstructProposalScreenshotDataUrl(proposal) {
    if (!proposal) return null;
    if (!window.MapScreenshot || typeof window.MapScreenshot.captureViaTileStitch !== 'function') return null;

    const goalKey = normalizeGoalKey(proposal.goal || proposal.proposalType || '');

    // Best-effort: load parent parcel *features only* — without ingesting them into the map layer.
    // This avoids any side effects on the map view while we generate the thumbnail.
    const parentParcelIds = Array.isArray(proposal.parentParcelIds)
        ? proposal.parentParcelIds.map(String).filter(Boolean)
        : (Array.isArray(proposal.roadProposal?.parentParcelIds)
            ? proposal.roadProposal.parentParcelIds.map(String).filter(Boolean)
            : []);

    let parentFeatures = [];
    if (parentParcelIds.length && typeof window.fetchParcelFeaturesByIds === 'function') {
        try { parentFeatures = await window.fetchParcelFeaturesByIds(parentParcelIds); } catch (_) { }
    }

    const parentPolygonsFromFeatures = (() => {
        const polys = [];
        for (const f of parentFeatures || []) {
            const geom = f && f.geometry;
            if (!geom || !geom.coordinates) continue;
            if (geom.type === 'Polygon') polys.push(geom.coordinates);
            else if (geom.type === 'MultiPolygon') geom.coordinates.forEach(p => polys.push(p));
        }
        return polys;
    })();

    let { polygon, polygonOrder, fitToPolygonOnly } = resolveProposalPolygonForScreenshot(proposal);

    // For plain parcel-only proposals (no building/structure/road), use the union of parent parcels
    // as the highlighted polygon so the screenshot frames them.
    if (!polygon && parentParcelIds.length) {
        const parentPolys = parentPolygonsFromFeatures.length
            ? parentPolygonsFromFeatures
            : collectParcelPolygonsFromParcelLayer(parentParcelIds);
        if (parentPolys.length === 1) {
            polygon = parentPolys[0];
            polygonOrder = 'lnglat';
        } else if (parentPolys.length > 1 && typeof turf !== 'undefined' && typeof turf.union === 'function') {
            try {
                let merged = null;
                parentPolys.forEach(coords => {
                    const feature = { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: coords } };
                    merged = merged ? (turf.union(merged, feature) || merged) : feature;
                });
                if (merged && merged.geometry) {
                    if (merged.geometry.type === 'Polygon') polygon = merged.geometry.coordinates;
                    else if (merged.geometry.type === 'MultiPolygon') polygon = merged.geometry.coordinates[0];
                    polygonOrder = 'lnglat';
                }
            } catch (err) {
                console.warn('[proposal screenshot] turf.union failed for parent parcels:', err);
                polygon = parentPolys[0];
                polygonOrder = 'lnglat';
            }
        }
    }

    if (!polygon) {
        console.warn('[proposal screenshot] No polygon could be resolved for proposal', proposal.proposalId);
        return null;
    }

    const bounds = computeLatLngBoundsFromGeoJsonPolygon(polygon);
    if (!bounds || (typeof bounds.isValid === 'function' && !bounds.isValid())) {
        console.warn('[proposal screenshot] Could not derive bounds for proposal', proposal.proposalId);
        return null;
    }

    // Decide what goes into parcelPolygons (these expand the bbox so they're fully framed) vs neighbours
    // (drawn as outlines only, never expand bbox):
    //   - Building proposals: parent parcel(s) go in parcelPolygons so the parcel stays in view.
    //     The building footprint is the highlighted `polygon`.
    //   - Other proposals: don't add parent parcels to parcelPolygons (they're already in `polygon` or
    //     are the road corridor's context). Just pull surrounding parcels in as neighbours.
    const isBuildingProposal = !!(proposal.buildingGeometry || proposal.buildingProposal);
    let parcelPolygons = [];
    if (isBuildingProposal) {
        parcelPolygons = parentPolygonsFromFeatures.length
            ? parentPolygonsFromFeatures
            : collectParcelPolygonsFromParcelLayer(parentParcelIds);
    }

    // For road proposals where parent parcels weren't pre-loaded, surrounding parcels still help
    // to give borders. Don't expand the bounds — they're context only via the neighbours channel.
    const boundsForContext = (() => {
        if (!bounds || typeof bounds.pad !== 'function') return bounds;
        try { return bounds.pad(0.5); } catch (_) { return bounds; }
    })();
    const neighbours = collectNeighbourPolygonsByBounds(boundsForContext || bounds, {
        limit: 200,
        excludeIds: new Set(parentParcelIds)
    });

    const badge = getProposalGoalBadge(goalKey);

    try {
        return await window.MapScreenshot.captureViaTileStitch({
            polygon,
            parcelPolygons,
            neighbours,
            bounds,
            padding: 0.12,
            zoom: 19,
            badge,
            polygonOrder: polygonOrder || 'auto',
            parcelPolygonOrder: 'auto',
            fitToPolygonOnly: !!fitToPolygonOnly
        });
    } catch (err) {
        console.warn('[proposal screenshot] captureViaTileStitch failed:', err);
        return null;
    }
}

// Track which proposals have an in-flight regeneration so repeat clicks no-op.
const _proposalScreenshotInFlight = new Set();

async function triggerProposalScreenshotRegeneration(proposalId) {
    if (!proposalId) return null;
    if (_proposalScreenshotInFlight.has(proposalId)) return null;
    _proposalScreenshotInFlight.add(proposalId);

    // Mark placeholders as busy
    document.querySelectorAll(`.proposal-thumb[data-proposal-id="${CSS.escape(String(proposalId))}"]`)
        .forEach(node => node.classList.add('proposal-thumb-loading'));

    try {
        return await captureAndPersistProposalScreenshot(proposalId, {
            force: true,
            allowModalCache: false
        });
    } finally {
        _proposalScreenshotInFlight.delete(proposalId);
        document.querySelectorAll(`.proposal-thumb[data-proposal-id="${CSS.escape(String(proposalId))}"]`)
            .forEach(node => node.classList.remove('proposal-thumb-loading'));
    }
}

if (typeof window !== 'undefined') {
    window.captureAndPersistProposalScreenshot = captureAndPersistProposalScreenshot;
    window.shouldSkipProposalScreenshot = shouldSkipProposalScreenshot;
    window.reconstructProposalScreenshotDataUrl = reconstructProposalScreenshotDataUrl;
    window.triggerProposalScreenshotRegeneration = triggerProposalScreenshotRegeneration;
}

// When a proposal's screenshot URL is set or replaced, upgrade any placeholder thumbnails in the DOM
// without re-rendering the whole list.
if (typeof document !== 'undefined') {
    document.addEventListener('proposalScreenshotUpdated', (event) => {
        const detail = event && event.detail ? event.detail : {};
        const { proposalId } = detail;
        const imageSrc = detail.screenshotUrl || detail.screenshotDataUrl;
        if (!proposalId || !imageSrc) return;
        const sel = `.proposal-thumb[data-proposal-id="${(typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(String(proposalId)) : String(proposalId)}"]`;
        document.querySelectorAll(sel).forEach(node => {
            node.classList.remove('proposal-thumb-empty', 'proposal-thumb-loading');
            node.classList.add('proposal-thumb-has-image');
            node.removeAttribute('onclick');
            node.removeAttribute('title');
            node.innerHTML = `
                <img class="proposal-thumb-img" src="${imageSrc}" alt="" loading="lazy">
                <div class="proposal-thumb-large"><img src="${imageSrc}" alt=""></div>
            `;
        });
    });
}

function setProposalModalDimmed(dimmed) {
    const modal = document.querySelector('.create-proposal-modal');
    if (!modal) return;
    if (dimmed) {
        modal.classList.add('dimmed-behind-overlay');
    } else {
        modal.classList.remove('dimmed-behind-overlay');
    }
}







const DEFAULT_CORRIDOR_WIDTHS = {
    road: 7.5,
    track: 3.0
};


function openConstrainedCorridorModal() {
    const selection = (typeof getCurrentParcelSelectionContext === 'function')
        ? getCurrentParcelSelectionContext()
        : { layers: [], ids: [] };
    const parcelIds = Array.isArray(selection.ids) ? selection.ids.filter(Boolean) : [];
    const parcels = Array.isArray(selection.layers) ? selection.layers.filter(Boolean) : [];
    const t = typeof getProposalI18nHelper === 'function' ? getProposalI18nHelper() : null;
    const tCorridor = getConstrainedCorridorTranslator(t);

    if (!parcels.length) {
        if (typeof updateStatus === 'function') {
            updateStatus(tCorridor('statusSelectParcels', 'Select parcels before opening the constrained corridor tool.'));
        }
        return;
    }

    const contiguity = (typeof areParcelsContiguous === 'function')
        ? areParcelsContiguous(parcels)
        : { contiguous: true };

    if (!contiguity.contiguous) {
        const message = (typeof t === 'function')
            ? t('proposals.contiguityDisabledReason', 'Disabled because the parcels in the proposal are not contiguous')
            : tCorridor('statusContiguity', 'Parcels must be contiguous to draw a constrained corridor.');
        if (typeof showProposalAlertMessage === 'function') {
            showProposalAlertMessage('parcels_not_contiguous', message);
        } else if (typeof alert === 'function') {
            alert(message);
        }
        return;
    }

    const superGeometry = (typeof buildGeometryFromParcels === 'function')
        ? buildGeometryFromParcels(parcels)
        : null;

    if (!superGeometry) {
        if (typeof updateStatus === 'function') {
            updateStatus(tCorridor('statusBoundaryFailed', 'Could not build a corridor boundary from the selected parcels.'));
        }
        return;
    }

    const superFeature = { type: 'Feature', properties: {}, geometry: superGeometry };
    const superTurfFeature = (typeof turf !== 'undefined' && turf.feature)
        ? turf.feature(superGeometry)
        : superFeature;

    // Clone parcel features to avoid mutating the live map layers
    const parcelFeatures = parcels
        .map(layer => {
            const feature = layer?.feature;
            if (!feature || !feature.geometry) return null;
            try { return JSON.parse(JSON.stringify(feature)); } catch (_) { return null; }
        })
        .filter(Boolean);

    if (!parcelFeatures.length) {
        if (typeof updateStatus === 'function') {
            updateStatus(tCorridor('statusGeometryFailed', 'Could not resolve parcel geometries for the constrained corridor modal.'));
        }
        return;
    }

    // Remove any existing modal before opening a new one
    if (constrainedCorridorState && constrainedCorridorState.close) {
        constrainedCorridorState.close();
    }

    const overlay = document.createElement('div');
    overlay.className = 'constrained-corridor-overlay';

    const mapId = `constrained-corridor-map-${Date.now()}`;
    const corridorText = {
        ariaLabel: tCorridor('ariaLabel', 'Constrained corridor'),
        title: tCorridor('title', 'Constrained corridor'),
        closeLabel: tCorridor('closeLabel', 'Close'),
        mapAriaLabel: tCorridor('mapAriaLabel', 'Constrained corridor map'),
        modeAriaLabel: tCorridor('modeAriaLabel', 'Corridor mode'),
        modeFull: tCorridor('modeFull', 'Full parcel'),
        modeDraw: tCorridor('modeDraw', 'Draw'),
        typeAriaLabel: tCorridor('typeAriaLabel', 'Corridor type'),
        typeRoad: tCorridor('typeRoad', 'Road'),
        typeTrack: tCorridor('typeTrack', 'Track'),
        panelHeader: tCorridor('panelHeader', 'Road Info'),
        undo: tCorridor('undo', '(U)ndo'),
        finish: tCorridor('finish', '(F)inish'),
        metricLength: tCorridor('metricLength', 'Length'),
        metricArea: tCorridor('metricArea', 'Area'),
        hintFullMode: tCorridor('hintFullMode', 'Full parcel mode will use the merged parcel outline as the corridor geometry.'),
        done: tCorridor('done', 'Done')
    };

    overlay.innerHTML = `
        <div class="constrained-corridor-modal" role="dialog" aria-modal="true" aria-label="${corridorText.ariaLabel}">
            <div class="corridor-header">
                <div class="corridor-title">${corridorText.title}</div>
                <button type="button" class="close-circle-btn close-circle-btn--lg" aria-label="${corridorText.closeLabel}" data-corridor-close>&times;</button>
            </div>
            <div class="corridor-layout">
                <div class="corridor-map-panel">
                    <div id="${mapId}" class="corridor-map" aria-label="${corridorText.mapAriaLabel}"></div>
                </div>
                <div class="corridor-sidebar">
                    <div class="corridor-toggle-row" role="group" aria-label="${corridorText.modeAriaLabel}">
                        <button type="button" class="btn proposal-type-button selected" data-corridor-mode="full">${corridorText.modeFull}</button>
                        <button type="button" class="btn proposal-type-button" data-corridor-mode="draw">${corridorText.modeDraw}</button>
                    </div>
                    <div class="corridor-toggle-row" role="group" aria-label="${corridorText.typeAriaLabel}" data-corridor-type-row>
                        <button type="button" class="btn proposal-type-button selected" data-corridor-type="road">${corridorText.typeRoad}</button>
                        <button type="button" class="btn proposal-type-button" data-corridor-type="track">${corridorText.typeTrack}</button>
                    </div>
                    <div class="corridor-draw-controls" data-corridor-draw-controls>
                        <div class="corridor-width-picker" data-corridor-width-picker style="display:flex; flex-direction:column; gap:6px;">
                            <div class="corridor-width-header" data-corridor-width-header>Choose road width</div>
                            <div class="roadwidth-grid" data-corridor-road-grid style="max-height:160px; overflow:auto;"></div>
                            <label class="corridor-sidewalk" data-corridor-sidewalk style="display:flex; align-items:center; gap:8px;">
                                <span data-corridor-sidewalk-label>Sidewalk width</span>
                                <input type="range" min="0" max="5" step="0.1" value="1" data-corridor-sidewalk-slider style="flex:1;">
                                <span data-corridor-sidewalk-value>1.0 m</span>
                            </label>
                            <div class="corridor-track-controls" data-corridor-track-controls style="display:none; gap:8px; flex-direction:column; max-height:220px; overflow:auto;">
                                <div class="roadwidth-grid" data-corridor-track-grid></div>
                                <label class="corridor-track-width" style="display:flex; align-items:center; gap:8px;">
                                    <span data-corridor-track-label>Track width</span>
                                    <input type="range" min="3" max="15" step="0.1" value="3" data-corridor-track-slider style="flex:1;">
                                    <span data-corridor-track-value>3.0 m</span>
                                </label>
                            </div>
                        </div>
                        <div class="corridor-panel">
                            <div class="corridor-panel__header">${corridorText.panelHeader}</div>
                            <div class="corridor-undo-row">
                                <button type="button" class="btn btn-secondary" data-corridor-undo disabled>${corridorText.undo}</button>
                                <button type="button" class="btn btn-secondary" data-corridor-finish disabled>${corridorText.finish}</button>
                            </div>
                            <div class="corridor-metrics" aria-live="polite">
                                <div class="corridor-metric">
                                    <div class="corridor-metric__label">${corridorText.metricLength}</div>
                                    <div class="corridor-metric__value" data-corridor-length>0 m</div>
                                </div>
                                <div class="corridor-metric">
                                    <div class="corridor-metric__label">${corridorText.metricArea}</div>
                                    <div class="corridor-metric__value" data-corridor-area>0 m²</div>
                                </div>
                            </div>
                        </div>
                    </div>
                    <div class="corridor-hint" data-corridor-hint>${corridorText.hintFullMode}</div>
                    <div class="corridor-actions">
                        <button type="button" class="btn btn-proposal" data-corridor-done>${corridorText.done}</button>
                    </div>
                </div>
            </div>
        </div>`;

    document.body.appendChild(overlay);

    const map = (typeof L !== 'undefined' && L.map) ? L.map(mapId, { zoomControl: true, scrollWheelZoom: true }) : null;
    if (!map) {
        overlay.remove();
        if (typeof updateStatus === 'function') {
            updateStatus(tCorridor('statusMapUnavailable', 'Map library unavailable.'));
        }
        return;
    }

    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '© OpenStreetMap contributors'
    }).addTo(map);

    const parcelLayer = L.geoJSON(parcelFeatures, {
        style: () => ({
            color: '#1f2937',
            weight: 1.4,
            fillColor: '#e5e7eb',
            fillOpacity: 0.12
        })
    }).addTo(map);

    const boundaryLayer = L.geoJSON(superFeature, {
        style: () => ({
            color: '#0f172a',
            weight: 6,
            dashArray: '8 6',
            fillOpacity: 0
        })
    }).addTo(map);

    const bounds = parcelLayer.getBounds();
    if (bounds && bounds.isValid()) {
        map.fitBounds(bounds.pad(0.1));
    }

    let drawMode = 'full';
    let corridorType = 'road';
    let corridorWidth = DEFAULT_CORRIDOR_WIDTHS.road;
    const drawnPoints = [];
    let drawingFinalized = false;
    let lineLayer = null;
    let polygonLayer = null;
    let previewLine = null;
    let previewPolygon = null;

    const drawControls = overlay.querySelector('[data-corridor-draw-controls]');
    const modeButtons = overlay.querySelectorAll('[data-corridor-mode]');
    const typeButtons = overlay.querySelectorAll('[data-corridor-type]');
    const undoButton = overlay.querySelector('[data-corridor-undo]');
    const finishButton = overlay.querySelector('[data-corridor-finish]');
    const doneButton = overlay.querySelector('[data-corridor-done]');
    const lengthEl = overlay.querySelector('[data-corridor-length]');
    const areaEl = overlay.querySelector('[data-corridor-area]');
    const hintEl = overlay.querySelector('[data-corridor-hint]');
    const widthPicker = overlay.querySelector('[data-corridor-width-picker]');
    const widthHeader = overlay.querySelector('[data-corridor-width-header]');
    const roadGrid = overlay.querySelector('[data-corridor-road-grid]');
    const trackControls = overlay.querySelector('[data-corridor-track-controls]');
    const trackGrid = overlay.querySelector('[data-corridor-track-grid]');
    const trackSlider = overlay.querySelector('[data-corridor-track-slider]');
    const trackValue = overlay.querySelector('[data-corridor-track-value]');
    const trackLabel = overlay.querySelector('[data-corridor-track-label]');
    const sidewalkControls = overlay.querySelector('[data-corridor-sidewalk]');
    const sidewalkSlider = overlay.querySelector('[data-corridor-sidewalk-slider]');
    const sidewalkValue = overlay.querySelector('[data-corridor-sidewalk-value]');
    const sidewalkLabel = overlay.querySelector('[data-corridor-sidewalk-label]');

    const closeModal = () => {
        map.off('click', handleMapClick);
        map.off('mousemove', handleMouseMove);
        if (lineLayer) map.removeLayer(lineLayer);
        if (polygonLayer) map.removeLayer(polygonLayer);
        if (previewLine) map.removeLayer(previewLine);
        if (previewPolygon) map.removeLayer(previewPolygon);
        map.removeLayer(parcelLayer);
        map.removeLayer(boundaryLayer);
        map.remove();
        overlay.removeEventListener('click', handleOverlayClick);
        overlay.removeEventListener('keydown', handleKeydown, true);
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        constrainedCorridorState = null;
    };

    constrainedCorridorState = {
        close: closeModal,
        overlay
    };

    // Corridor width picker (inline, mirrors road/track width dialogs)
    const persistGet = (key, fallback) => {
        try {
            const val = (typeof PersistentStorage !== 'undefined' && PersistentStorage.getItem)
                ? PersistentStorage.getItem(key)
                : null;
            return val !== null && val !== undefined && val !== '' ? val : fallback;
        } catch (_) {
            return fallback;
        }
    };
    const persistSet = (key, val) => {
        try {
            if (typeof PersistentStorage !== 'undefined' && PersistentStorage.setItem) {
                PersistentStorage.setItem(key, String(val));
            }
        } catch (_) { /* ignore */ }
    };

    const roadWidthOptions = [
        { id: 'roadwidth6', label: 'Alley ~7.5 m', width: 7.5 },
        { id: 'roadwidth5', label: 'Local ~10 m', width: 10 },
        { id: 'roadwidth4', label: 'Collector ~18 m', width: 18 },
        { id: 'roadwidth3', label: 'Main street ~26 m', width: 26 },
        { id: 'roadwidth2', label: 'Avenue ~40 m', width: 40 },
        { id: 'roadwidth1', label: 'Boulevard ~80 m', width: 80 }
    ];

    const trackSpeedOptions = [
        { id: 'trackspeed1', speed: 50, label: '50 km/h', minRadius: 300 },
        { id: 'trackspeed2', speed: 80, label: '80 km/h', minRadius: 500 },
        { id: 'trackspeed3', speed: 120, label: '120 km/h', minRadius: 1000 },
        { id: 'trackspeed4', speed: 160, label: '160 km/h', minRadius: 2000 },
        { id: 'trackspeed5', speed: 200, label: '200 km/h', minRadius: 3500 },
        { id: 'trackspeed6', speed: 250, label: '250 km/h', minRadius: 5000 }
    ];

    let selectedRoadWidthId = persistGet('lastRoadWidthId', 'roadwidth6');
    let selectedTrackSpeedId = persistGet('lastTrackSpeedId', 'trackspeed1');
    let corridorSidewalkWidth = parseFloat(persistGet('lastSidewalkWidth', 1));
    if (!Number.isFinite(corridorSidewalkWidth)) corridorSidewalkWidth = 1;
    let roadBaseWidth = (roadWidthOptions.find(o => o.id === selectedRoadWidthId) || roadWidthOptions[0]).width;
    let trackWidthValue = parseFloat(persistGet('lastTrackWidth', DEFAULT_CORRIDOR_WIDTHS.track));
    if (!Number.isFinite(trackWidthValue)) trackWidthValue = DEFAULT_CORRIDOR_WIDTHS.track;

    const getRoadThumb = (id) => {
        if (typeof getRoadWidthThumbDataURI === 'function') {
            try { return getRoadWidthThumbDataURI(id); } catch (_) { }
        }
        // Fallback simple placeholder
        return 'data:image/svg+xml;utf8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 120"><rect width="200" height="120" fill="#cfd8dc"/><rect x="20" y="40" width="160" height="40" rx="6" fill="#616161"/><rect x="20" y="58" width="160" height="4" fill="#ffffff"/></svg>`);
    };

    function setCorridorWidth(newWidth) {
        if (!Number.isFinite(newWidth)) return;
        corridorWidth = newWidth;
        updatePreview();
    }

    function syncSidewalkUI() {
        if (sidewalkSlider) sidewalkSlider.value = corridorSidewalkWidth;
        if (sidewalkValue) sidewalkValue.textContent = `${Number(corridorSidewalkWidth).toFixed(1)} m`;
    }

    if (sidewalkLabel) sidewalkLabel.textContent = 'Sidewalk width';
    syncSidewalkUI();
    if (sidewalkSlider) {
        sidewalkSlider.addEventListener('input', (e) => {
            const val = parseFloat(e.target.value);
            if (!Number.isFinite(val)) return;
            corridorSidewalkWidth = val;
            persistSet('lastSidewalkWidth', val);
            syncSidewalkUI();
            if (corridorType === 'road') {
                setCorridorWidth(roadBaseWidth); // Sidewalk is contained within road width
            }
        });
    }

    function renderRoadWidthGrid() {
        if (!roadGrid) return;
        roadGrid.innerHTML = '';
        roadGrid.style.display = 'grid';
        roadGrid.style.gridTemplateColumns = 'repeat(auto-fill, minmax(120px, 1fr))';
        roadGrid.style.gap = '8px';
        roadWidthOptions.forEach(opt => {
            const card = document.createElement('div');
            card.className = 'roadwidth-card' + (opt.id === selectedRoadWidthId ? ' selected' : '');
            card.setAttribute('role', 'button');
            card.setAttribute('tabindex', '0');
            card.dataset.id = opt.id;
            card.dataset.width = String(opt.width);

            const img = document.createElement('img');
            img.className = 'roadwidth-thumb';
            img.alt = opt.label;
            img.src = getRoadThumb(opt.id);

            const lbl = document.createElement('div');
            lbl.className = 'roadwidth-label';
            lbl.textContent = opt.label;

            card.appendChild(img);
            card.appendChild(lbl);

            const selectFn = () => {
                selectedRoadWidthId = opt.id;
                persistSet('lastRoadWidthId', opt.id);
                roadBaseWidth = opt.width;
                roadGrid.querySelectorAll('.roadwidth-card').forEach(el => el.classList.remove('selected'));
                card.classList.add('selected');
                if (corridorType === 'road') {
                    setCorridorWidth(roadBaseWidth); // Sidewalk is contained within road width
                }
            };

            card.addEventListener('click', selectFn);
            card.addEventListener('keydown', (ev) => {
                if (ev.key === 'Enter' || ev.key === ' ') {
                    ev.preventDefault();
                    selectFn();
                }
            });

            roadGrid.appendChild(card);
        });
    }

    function renderTrackGrid() {
        if (!trackGrid) return;
        trackGrid.innerHTML = '';
        trackGrid.style.display = 'grid';
        trackGrid.style.gridTemplateColumns = 'repeat(auto-fill, minmax(140px, 1fr))';
        trackGrid.style.gap = '8px';
        trackSpeedOptions.forEach(opt => {
            const card = document.createElement('div');
            card.className = 'roadwidth-card' + (opt.id === selectedTrackSpeedId ? ' selected' : '');
            card.setAttribute('role', 'button');
            card.setAttribute('tabindex', '0');
            card.dataset.id = opt.id;
            card.dataset.speed = String(opt.speed);
            card.dataset.minRadius = String(opt.minRadius);

            const lbl = document.createElement('div');
            lbl.className = 'roadwidth-label';
            lbl.textContent = `${opt.label} (min radius: ${opt.minRadius}m)`;
            card.appendChild(lbl);

            const selectFn = () => {
                selectedTrackSpeedId = opt.id;
                persistSet('lastTrackSpeedId', opt.id);
                trackGrid.querySelectorAll('.roadwidth-card').forEach(el => el.classList.remove('selected'));
                card.classList.add('selected');
            };

            card.addEventListener('click', selectFn);
            card.addEventListener('keydown', (ev) => {
                if (ev.key === 'Enter' || ev.key === ' ') {
                    ev.preventDefault();
                    selectFn();
                }
            });

            trackGrid.appendChild(card);
        });
    }

    function syncTrackWidthUI() {
        if (!trackSlider || !trackValue) return;
        trackSlider.value = trackWidthValue;
        trackValue.textContent = `${Number(trackWidthValue).toFixed(1)} m`;
    }

    if (trackSlider) {
        syncTrackWidthUI();
        trackSlider.addEventListener('input', (e) => {
            const val = parseFloat(e.target.value);
            if (!Number.isFinite(val)) return;
            trackWidthValue = val;
            persistSet('lastTrackWidth', val);
            syncTrackWidthUI();
            if (corridorType === 'track') {
                setCorridorWidth(trackWidthValue);
            }
        });
    }

    // Build pickers once
    renderRoadWidthGrid();
    renderTrackGrid();

    function applyMode(mode) {
        drawMode = mode;
        modeButtons.forEach(btn => {
            const isActive = btn.getAttribute('data-corridor-mode') === mode;
            btn.classList.toggle('selected', isActive);
        });
        if (drawControls) {
            drawControls.style.display = mode === 'draw' ? 'flex' : 'none';
        }
        if (hintEl) {
            hintEl.textContent = mode === 'draw'
                ? 'Draw a road or track inside the merged parcels.'
                : 'Full parcel mode will use the merged parcel outline as the corridor geometry.';
        }
        const mapContainer = map.getContainer();
        if (mapContainer) {
            mapContainer.style.cursor = mode === 'draw' ? 'crosshair' : '';
            mapContainer.classList.toggle('corridor-draw-mode', mode === 'draw');
        }
        drawingFinalized = false;
        if (mode === 'full') {
            clearDrawnGeometry();
        }
        updateButtons();
    }

    function applyType(type) {
        corridorType = type === 'track' ? 'track' : 'road';
        if (widthHeader) {
            widthHeader.textContent = corridorType === 'track' ? 'Choose track width' : 'Choose road width';
        }
        if (trackControls) trackControls.style.display = corridorType === 'track' ? 'flex' : 'none';
        if (roadGrid) roadGrid.style.display = corridorType === 'road' ? 'grid' : 'none';
        if (trackLabel) trackLabel.textContent = 'Track width';
        if (sidewalkControls) sidewalkControls.style.display = corridorType === 'road' ? 'flex' : 'none';
        if (sidewalkLabel) sidewalkLabel.textContent = 'Sidewalk width';

        if (corridorType === 'track') {
            corridorWidth = Number.isFinite(trackWidthValue) ? trackWidthValue : DEFAULT_CORRIDOR_WIDTHS.track;
        } else {
            const sel = roadWidthOptions.find(o => o.id === selectedRoadWidthId) || roadWidthOptions[0];
            roadBaseWidth = sel?.width || DEFAULT_CORRIDOR_WIDTHS.road;
            corridorWidth = roadBaseWidth; // Sidewalk sits inside road width
        }
        typeButtons.forEach(btn => {
            const active = btn.getAttribute('data-corridor-type') === corridorType;
            btn.classList.toggle('selected', active);
        });
        updatePreview();
    }

    function handleOverlayClick(event) {
        if (event.target && event.target.matches('[data-corridor-close]')) {
            closeModal();
        }
    }

    function handleKeydown(event) {
        const targetTag = (event.target?.tagName || '').toLowerCase();
        const isFormField = targetTag === 'input' || targetTag === 'textarea' || targetTag === 'select';
        if (event.key === 'Escape') {
            event.preventDefault();
            closeModal();
            return;
        }
        if (isFormField) return;
        if ((event.key === 'u' || event.key === 'U') && !undoButton?.disabled) {
            event.preventDefault();
            handleUndo();
        }
        if ((event.key === 'f' || event.key === 'F') && !finishButton?.disabled) {
            event.preventDefault();
            finalizeCorridorDrawing();
        }
    }

    function pointInsideSuperparcel(latlng) {
        if (!latlng) return false;
        if (typeof turf === 'undefined') return true;
        try {
            return turf.booleanPointInPolygon(turf.point([latlng.lng, latlng.lat]), superTurfFeature);
        } catch (_) {
            return true;
        }
    }

    function clearDrawnGeometry() {
        drawnPoints.length = 0;
        drawingFinalized = false;
        if (lineLayer) { map.removeLayer(lineLayer); lineLayer = null; }
        if (polygonLayer) { map.removeLayer(polygonLayer); polygonLayer = null; }
        if (previewLine) { map.removeLayer(previewLine); previewLine = null; }
        if (previewPolygon) { map.removeLayer(previewPolygon); previewPolygon = null; }
        setMetrics(0, 0);
    }

    function handleMapClick(event) {
        if (drawMode !== 'draw' || !event || !event.latlng) return;
        if (drawingFinalized) {
            clearDrawnGeometry();
        }
        if (!pointInsideSuperparcel(event.latlng)) {
            if (typeof showProposalAlertMessage === 'function') {
                showProposalAlertMessage('corridor_point_outside', 'Clicks must stay within the selected parcels.');
            }
            return;
        }
        drawnPoints.push(event.latlng);
        updatePreview();
    }

    function handleMouseMove(event) {
        if (drawMode !== 'draw' || drawingFinalized || !event || !event.latlng) return;
        updatePreview(event.latlng);
    }

    function toClosedRing(latlngs) {
        if (!Array.isArray(latlngs) || !latlngs.length) return [];
        const ring = latlngs.map(pt => [pt.lng, pt.lat]);
        const first = ring[0];
        const last = ring[ring.length - 1];
        if (first && last && (first[0] !== last[0] || first[1] !== last[1])) {
            ring.push([first[0], first[1]]);
        }
        return ring;
    }

    function computeMetrics(points, polygonLatLngs) {
        let length = 0;
        let area = 0;
        if (typeof turf !== 'undefined') {
            if (points && points.length >= 2) {
                try {
                    const line = turf.lineString(points.map(pt => [pt.lng, pt.lat]));
                    length = turf.length(line, { units: 'kilometers' }) * 1000;
                } catch (_) { }
            }
            if (polygonLatLngs && polygonLatLngs.length >= 3) {
                try {
                    const ring = toClosedRing(polygonLatLngs);
                    if (ring.length >= 4) {
                        const poly = turf.polygon([ring]);
                        area = turf.area(poly);
                    }
                } catch (_) { }
            }
        }
        return { length, area };
    }

    function setMetrics(length, area) {
        if (lengthEl) lengthEl.textContent = `${length.toFixed(1)} m`;
        if (areaEl) areaEl.textContent = `${area.toFixed(1)} m²`;
    }

    function updatePreview(hoverPoint) {
        if (previewLine) { map.removeLayer(previewLine); previewLine = null; }
        if (previewPolygon) { map.removeLayer(previewPolygon); previewPolygon = null; }
        if (lineLayer) { map.removeLayer(lineLayer); lineLayer = null; }
        if (polygonLayer) { map.removeLayer(polygonLayer); polygonLayer = null; }

        const points = drawnPoints.slice();
        const useHover = hoverPoint && !drawingFinalized;
        if (useHover) points.push(hoverPoint);

        if (!points.length) {
            setMetrics(0, 0);
            updateButtons();
            return;
        }

        const line = L.polyline(points, { color: '#2563eb', weight: 3 }).addTo(map);
        if (drawingFinalized) {
            lineLayer = line;
        } else {
            previewLine = line;
        }

        let polygonLatLngs = null;
        if (points.length >= 2) {
            polygonLatLngs = (typeof calculateRoadPolygon === 'function')
                ? calculateRoadPolygon(points, corridorWidth)
                : null;
            if (polygonLatLngs && polygonLatLngs.length >= 3) {
                const polygon = L.polygon(polygonLatLngs, {
                    color: '#34d399',
                    weight: 2,
                    fillColor: '#34d399',
                    fillOpacity: 0.25
                }).addTo(map);
                if (drawingFinalized) {
                    polygonLayer = polygon;
                } else {
                    previewPolygon = polygon;
                }
            }
        }

        const metrics = computeMetrics(points, polygonLatLngs);
        setMetrics(metrics.length, metrics.area);
        updateButtons();
    }

    function updateButtons() {
        const hasLine = drawnPoints.length >= 2;
        const drawDisabled = drawMode !== 'draw';
        if (undoButton) {
            undoButton.disabled = drawnPoints.length === 0 || drawDisabled;
        }
        if (finishButton) {
            finishButton.disabled = !hasLine || drawDisabled;
        }
        if (doneButton) {
            doneButton.disabled = (drawMode === 'draw' && !hasLine);
        }
    }

    function handleUndo() {
        if (!drawnPoints.length || drawMode !== 'draw') return;
        drawnPoints.pop();
        drawingFinalized = false;
        updatePreview();
    }

    function finalizeCorridorDrawing() {
        if (drawMode !== 'draw' || drawnPoints.length < 2) return;
        drawingFinalized = true;
        updatePreview();
    }

    function persistGeometryAndClose() {
        if (drawMode === 'full') {
            pendingConstrainedCorridor = {
                mode: 'full',
                type: corridorType,
                width: corridorWidth,
                parentParcelIds: parcelIds.slice(),
                superGeometry: superGeometry,
                polygon: superGeometry,
                centerline: []
            };
            if (typeof window !== 'undefined') {
                window.pendingConstrainedCorridor = pendingConstrainedCorridor;
            }
            if (typeof setGeometryStatus === 'function') {
                const submittedLabel = (typeof t === 'function')
                    ? t('modal.createProposal.geometry.status.submitted', '✔️ geometry submitted')
                    : '✔️ geometry submitted';
                setGeometryStatus(submittedLabel, { submitted: true });
            }
            closeModal();
            return;
        }

        if (drawnPoints.length < 2) {
            if (typeof showProposalAlertMessage === 'function') {
                showProposalAlertMessage('corridor_draw_more_points', 'Add at least two points to draw a corridor.');
            }
            return;
        }

        const polygonLatLngs = (typeof calculateRoadPolygon === 'function')
            ? calculateRoadPolygon(drawnPoints, corridorWidth)
            : null;

        if (!polygonLatLngs || !polygonLatLngs.length) {
            if (typeof showProposalAlertMessage === 'function') {
                showProposalAlertMessage('corridor_polygon_missing', 'Could not build a corridor polygon.');
            }
            return;
        }

        const ring = toClosedRing(polygonLatLngs);
        if (!ring.length) {
            if (typeof showProposalAlertMessage === 'function') {
                showProposalAlertMessage('corridor_polygon_missing', 'Could not build a corridor polygon.');
            }
            return;
        }

        if (typeof turf !== 'undefined') {
            try {
                const corridorPoly = turf.polygon([ring]);
                const paddedSuper = turf.buffer(superTurfFeature, 0.15, { units: 'meters' }) || superTurfFeature;
                const within = turf.booleanWithin(corridorPoly, paddedSuper);
                let outsideArea = 0;
                if (!within && typeof turf.difference === 'function' && typeof turf.area === 'function') {
                    const outside = turf.difference(corridorPoly, paddedSuper);
                    outsideArea = outside ? turf.area(outside) : 0;
                }
                if (!within && outsideArea > 0.5) {
                    if (typeof showProposalAlertMessage === 'function') {
                        showProposalAlertMessage('corridor_outside_bounds', 'The corridor must stay within the selected parcels.');
                    }
                    return;
                }
            } catch (_) { /* best effort */ }
        }

        const geoPolygon = { type: 'Polygon', coordinates: [ring] };
        const centerline = drawnPoints.map(pt => [pt.lng, pt.lat]);

        pendingConstrainedCorridor = {
            mode: 'draw',
            type: corridorType,
            width: corridorWidth,
            parentParcelIds: parcelIds.slice(),
            superGeometry: superGeometry,
            polygon: geoPolygon,
            centerline
        };

        if (typeof window !== 'undefined') {
            window.pendingConstrainedCorridor = pendingConstrainedCorridor;
        }

        if (typeof setGeometryStatus === 'function') {
            const submittedLabel = (typeof t === 'function')
                ? t('modal.createProposal.geometry.status.submitted', '✔️ geometry submitted')
                : '✔️ geometry submitted';
            setGeometryStatus(submittedLabel, { submitted: true });
        }

        closeModal();
    }

    modeButtons.forEach(btn => {
        btn.addEventListener('click', () => applyMode(btn.getAttribute('data-corridor-mode') === 'draw' ? 'draw' : 'full'));
    });

    typeButtons.forEach(btn => {
        btn.addEventListener('click', () => applyType(btn.getAttribute('data-corridor-type')));
    });

    if (undoButton) {
        undoButton.addEventListener('click', handleUndo);
    }

    if (finishButton) {
        finishButton.addEventListener('click', finalizeCorridorDrawing);
    }

    if (doneButton) {
        doneButton.addEventListener('click', persistGeometryAndClose);
    }

    if (map) {
        map.on('click', handleMapClick);
        map.on('mousemove', handleMouseMove);
    }

    overlay.addEventListener('click', handleOverlayClick);
    overlay.addEventListener('keydown', handleKeydown, true);

    // Initialize state
    applyMode('full');
    applyType('road');
    setTimeout(() => {
        try { map.invalidateSize(); } catch (_) { }
    }, 50);
}

if (typeof window !== 'undefined') {
    window.openConstrainedCorridorModal = openConstrainedCorridorModal;
}








// ---- Proposal facets: Land use / Parcels / Ownership ----------------------
// The create-proposal dialog exposes three persistent, independent facets, all
// visible until "Create" is clicked. They are mapped onto the existing goal-key
// machinery (setProposalType / updateGoalDependentSections / geometry / submit)
// so the rest of the flow is unchanged. See feature-proposal-goals.md.
const proposalFacetState = { landUse: 'as-is', parcels: 'as-is', ownership: 'no-change' };
const PROPOSAL_PUBLIC_GOOD_USES = new Set(['park', 'square', 'lake', 'road-track']);
const PROPOSAL_GOAL_TYPE_LABELS = {
    'square': 'Square', 'park': 'Park', 'lake': 'Lake', 'single': 'Building(s)',
    'road-track': 'Road/Track', 'urban-rule': 'Urban Rule',
    'decide-later': 'Decide later', 'reparcellization': 'Reparcellization'
};


// Set the Parcels radio + state. lock => disable the other options (intrinsic to
// the land use); unlock => re-enable all (per-slice stays gated to Readjust).
// The localized pill label for a facet value (read from its rendered pill).
function facetModeLabel(name, value) {
    const input = document.querySelector(`input[name="${name}"][value="${value}"]`);
    const radio = input ? input.closest('.proposal-radio') : null;
    const span = radio ? radio.querySelector('span') : null;
    return span ? span.textContent.trim() : value;
}

// Shared lock UI: when a facet is forced by another choice, hide its pill group and
// show a quiet static line ("🔒 <value> · <reason>") instead of dead/disabled pills.

function setProposalParcelsMode(mode, { lock = false, unlock = false, reason = '' } = {}) {
    proposalFacetState.parcels = mode;
    applyFacetLockUI('proposalParcelsGroup', 'proposalParcelsStatic', 'proposalParcelsMode', mode, lock, reason);
    // Merge requires ≥2 parcels — disable it (greyed pill) for a single-parcel selection.
    const mergeRadio = document.querySelector('input[name="proposalParcelsMode"][value="merge"]');
    if (mergeRadio) mergeRadio.disabled = proposalSingleParcelSelection;
}


// The address field only applies to a Specific third-party recipient (not Anyone).


// Name/description "type" reflecting the chosen ownership recipient (so the auto title
// isn't always "Ownership transfer to me"). Distinct from the to-me/from-me mechanic.

function showProposalPerSliceOption(show) {
    const el = document.querySelector('.proposal-ownership-perslice');
    if (el) el.style.display = show ? '' : 'none';
}



// Move the geometry control (and, for Urban Rule, the typology selector) inline, right
// after the section that requires it — so "Edit" appears next to Building/Road/Urban Rule
// in Land use, or next to Readjust in Parcels — instead of far down the form.

// Land-use selection applies the constraint matrix (lock the hard ones, default
// the soft ones), then resyncs the derived goal.

function onProposalParcelsChange() {
    const sel = document.querySelector('input[name="proposalParcelsMode"]:checked');
    proposalFacetState.parcels = sel ? sel.value : 'as-is';
    if (proposalFacetState.parcels === 'readjust') {
        showProposalPerSliceOption(true);
        setProposalOwnershipMode('per-slice', { lock: true, reason: facetModeLabel('proposalParcelsMode', 'readjust') }); // slices carry their owners
    } else {
        showProposalPerSliceOption(false);
        const next = (proposalFacetState.ownership === 'per-slice') ? 'no-change' : proposalFacetState.ownership;
        setProposalOwnershipMode(next, { unlock: true });
    }
    syncProposalFacets();
}


// Collapse the three facets into the legacy goal key that drives geometry + submit.
function deriveProposalGoalKey() {
    const { landUse, parcels, ownership } = proposalFacetState;
    if (landUse === 'urban-rule') return 'urban-rule';
    if (parcels === 'readjust') return 'reparcellization';
    if (landUse && landUse !== 'as-is') return landUse; // park/square/lake/single/road-track
    if (parcels === 'merge') return 'decide-later';
    if (ownership && ownership !== 'no-change') return 'ownership-transfer';
    return null; // as-is / as-is / no-change: nothing to propose yet
}


// Initialize the three facets, optionally from an override goal (e.g. a road draw).


function setProposalModalInteractivity(enabled) {
    const modal = document.querySelector('.create-proposal-modal');
    if (!modal) return;
    const controls = modal.querySelectorAll('input, textarea, select, button');

    controls.forEach(control => {
        const isCloseButton = control.classList && control.classList.contains('proposal-modal-close');
        if (enabled) {
            if (control.dataset.disabledByCreate === '1') {
                control.disabled = false;
                delete control.dataset.disabledByCreate;
            }
        } else {
            if (!isCloseButton && !control.disabled) {
                control.dataset.disabledByCreate = '1';
                control.disabled = true;
            }
        }
    });

    modal.classList.toggle('proposal-modal-disabled', !enabled);
}

function showProposalWaitingPopup(message = 'Waiting for transaction...') {
    let popup = document.getElementById('proposal-waiting-popup');
    if (!popup) {
        popup = document.createElement('div');
        popup.id = 'proposal-waiting-popup';
        // Full-screen blocking overlay (styling in css/modals.css). It must NOT be
        // pointer-events:none — it's what stops clicks from reaching the map/parcels
        // behind the dimmed dialog while the transaction is pending.
        popup.className = 'proposal-waiting-overlay';

        const card = document.createElement('div');
        card.className = 'proposal-waiting-card';

        const indicator = document.createElement('span');
        indicator.className = 'proposal-waiting-spinner';
        indicator.setAttribute('aria-hidden', 'true');

        const text = document.createElement('span');
        text.className = 'proposal-waiting-text';
        text.textContent = message;

        card.appendChild(indicator);
        card.appendChild(text);
        popup.appendChild(card);
        document.body.appendChild(popup);
    } else {
        popup.style.display = 'flex';
    }

    const textEl = popup.querySelector('.proposal-waiting-text');
    if (textEl) {
        textEl.textContent = message;
    }
}

function hideProposalWaitingPopup() {
    const popup = document.getElementById('proposal-waiting-popup');
    if (popup && popup.parentNode) {
        popup.parentNode.removeChild(popup);
    }
}

function showProposalWaitingPopupTemporary(message = 'Transaction rejected', duration = 2000) {
    showProposalWaitingPopup(message);
    setTimeout(() => {
        hideProposalWaitingPopup();
    }, Math.max(500, duration));
}











function buildProposalScreenshotContext(parcelLayers = [], options = {}) {
    if (window?.__DEBUG_SCREENSHOT_CONTEXT__) {
        console.debug('[buildProposalScreenshotContext]', {
            parcelLayersCount: parcelLayers?.length,
            options: { goal: options.goal, hasRoadContext: !!options.roadContext }
        });
    }
    const goalKey = (typeof normalizeGoalKey === 'function') ? normalizeGoalKey(options.goal) : (options.goal || '');
    const roadContext = options.roadContext || null;
    const hasParcels = Array.isArray(parcelLayers) && parcelLayers.length > 0;
    if (!hasParcels && !roadContext) {
        return null;
    }

    const parcelPolygons = [];
    let polygonOrder = 'auto';
    let parcelPolygonOrder = 'auto';
    if (hasParcels) {
        parcelLayers.forEach(layer => {
            const geom = layer?.feature?.geometry;
            if (!geom || !geom.coordinates) return;
            if (geom.type === 'Polygon' && Array.isArray(geom.coordinates)) {
                parcelPolygons.push(geom.coordinates);
            } else if (geom.type === 'MultiPolygon' && Array.isArray(geom.coordinates)) {
                geom.coordinates.forEach(poly => {
                    if (Array.isArray(poly)) {
                        parcelPolygons.push(poly);
                    }
                });
            }
        });
    }

    let polygon = null;
    const geometry = hasParcels ? buildGeometryFromParcels(parcelLayers) : null;
    if (geometry && Array.isArray(geometry.coordinates) && geometry.coordinates.length) {
        polygon = geometry.coordinates;
    } else if (parcelPolygons.length) {
        polygon = parcelPolygons[0];
    }

    const buildBoundsFromCoords = (coords) => {
        if (!coords || typeof L === 'undefined' || !L.latLngBounds) return null;
        const latLngs = [];
        const collect = (node) => {
            if (!Array.isArray(node) || !node.length) return;
            if (node.length >= 2 && Number.isFinite(node[0]) && Number.isFinite(node[1])) {
                const lat = Math.abs(node[0]) <= 90 ? node[0] : node[1];
                const lng = Math.abs(node[0]) <= 90 ? node[1] : node[0];
                latLngs.push(L.latLng(lat, lng));
                return;
            }
            node.forEach(collect);
        };
        collect(coords);
        return latLngs.length ? L.latLngBounds(latLngs) : null;
    };

    let bounds = null;
    if (hasParcels && typeof L !== 'undefined' && L.latLngBounds) {
        parcelLayers.forEach(layer => {
            try {
                if (layer && typeof layer.getBounds === 'function') {
                    const layerBounds = layer.getBounds();
                    if (layerBounds && typeof layerBounds.isValid === 'function' && layerBounds.isValid()) {
                        if (!bounds) {
                            bounds = layerBounds.clone ? layerBounds.clone() : L.latLngBounds(layerBounds);
                        } else {
                            bounds.extend(layerBounds);
                        }
                    }
                }
            } catch (err) {
                console.warn('Failed to extend screenshot bounds from parcel layer', err);
            }
        });
    }

    let fitToPolygonOnly = false;

    if (goalKey === 'road-track' && roadContext) {
        // roadContext.polygon is a GeoJSON object with coordinates in [lng, lat] order
        // Use it directly - no conversion needed
        const roadPolygon = roadContext.polygon || roadContext.superGeometry || roadContext.geometry || null;

        if (roadPolygon && roadPolygon.coordinates) {
            // GeoJSON polygon - coordinates are already in [lng, lat] order
            polygon = roadPolygon.coordinates;
            // Use explicit order from roadContext if provided, otherwise assume GeoJSON standard
            polygonOrder = roadContext.polygonOrder || 'lnglat';
            fitToPolygonOnly = true;

            // Build bounds from GeoJSON coordinates [lng, lat]
            const flatCoords = Array.isArray(roadPolygon.coordinates[0]) && Array.isArray(roadPolygon.coordinates[0][0])
                ? roadPolygon.coordinates[0] // Polygon: [[ring]]
                : roadPolygon.coordinates;   // Simple array
            if (Array.isArray(flatCoords) && flatCoords.length > 0) {
                let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
                flatCoords.forEach(coord => {
                    if (Array.isArray(coord) && coord.length >= 2) {
                        // GeoJSON order: [lng, lat]
                        const lng = coord[0], lat = coord[1];
                        if (Number.isFinite(lng) && Number.isFinite(lat)) {
                            if (lng < minLng) minLng = lng;
                            if (lng > maxLng) maxLng = lng;
                            if (lat < minLat) minLat = lat;
                            if (lat > maxLat) maxLat = lat;
                        }
                    }
                });
                if (Number.isFinite(minLat) && Number.isFinite(maxLat) && Number.isFinite(minLng) && Number.isFinite(maxLng)) {
                    bounds = L.latLngBounds([[minLat, minLng], [maxLat, maxLng]]);
                }
            }
            parcelPolygonOrder = 'auto';

            if (window?.__DEBUG_SCREENSHOT_CONTEXT__) {
                console.debug('[buildProposalScreenshotContext] road polygon resolved', {
                    type: roadPolygon.type,
                    coordsLength: roadPolygon.coordinates?.[0]?.length,
                    firstCoord: roadPolygon.coordinates?.[0]?.[0],
                    polygonOrder,
                    expectedForZagreb: 'firstCoord should be [lng ~15.97, lat ~45.80]',
                    bounds: bounds ? { sw: bounds.getSouthWest(), ne: bounds.getNorthEast() } : null
                });
            }
        }
    }

    // Fallback: if the road/track flow did not seed parcel selection, derive parcel outlines from the parent parcel ids
    if (goalKey === 'road-track' && roadContext && parcelPolygons.length === 0 && Array.isArray(roadContext.parentParcelIds) && roadContext.parentParcelIds.length) {
        const ids = roadContext.parentParcelIds
            .map(id => (id ? id.toString() : null))
            .filter(Boolean);

        const findLayerById = (parcelId) => {
            if (typeof multiParcelSelection !== 'undefined' && multiParcelSelection && typeof multiParcelSelection.findParcelById === 'function') {
                const layer = multiParcelSelection.findParcelById(parcelId);
                if (layer) return layer;
            }
            if (typeof parcelLayer !== 'undefined' && parcelLayer && typeof parcelLayer.getLayers === 'function') {
                const layers = parcelLayer.getLayers();
                for (const layer of layers) {
                    const id = getParcelIdFromFeature(layer?.feature);
                    if (id && id.toString() === parcelId) {
                        return layer;
                    }
                }
            }
            return null;
        };

        ids.forEach(id => {
            const layer = findLayerById(id);
            if (!layer) return;
            try {
                const geom = layer?.feature?.geometry;
                if (geom?.type === 'Polygon' && Array.isArray(geom.coordinates)) {
                    parcelPolygons.push(geom.coordinates);
                } else if (geom?.type === 'MultiPolygon' && Array.isArray(geom.coordinates)) {
                    geom.coordinates.forEach(coords => {
                        if (Array.isArray(coords)) parcelPolygons.push(coords);
                    });
                }

                if (!bounds && typeof layer.getBounds === 'function') {
                    const b = layer.getBounds();
                    if (b && typeof b.isValid === 'function' && b.isValid()) {
                        bounds = b.clone ? b.clone() : b;
                    }
                }
            } catch (err) {
                console.warn('Failed to derive parcel outline for road/track screenshot', err);
            }
        });
    }
    if (window?.__DEBUG_SCREENSHOT_CONTEXT__) {
        console.debug('[buildProposalScreenshotContext] summary', {
            hasPolygon: !!polygon,
            polygonLength: polygon?.length || polygon?.[0]?.length,
            parcelPolygonsCount: parcelPolygons.length,
            hasBounds: !!bounds,
            polygonOrder,
            parcelPolygonOrder,
            fitToPolygonOnly
        });
    }

    const appendParcelsFromLayer = (target = [], targetBounds = null, limit = 150) => {
        const parcelLayer = (typeof window !== 'undefined' && window.parcelLayer)
            || (typeof window !== 'undefined' && window.parcelState && typeof window.parcelState.getParcelLayer === 'function' && window.parcelState.getParcelLayer())
            || null;
        if (!parcelLayer || !targetBounds || typeof targetBounds.intersects !== 'function' || typeof parcelLayer.getLayers !== 'function') return target;
        const layers = parcelLayer.getLayers();
        for (const layer of layers) {
            if (target.length >= limit) break;
            const lb = (layer && typeof layer.getBounds === 'function') ? layer.getBounds() : null;
            if (!lb || !targetBounds.intersects(lb)) continue;
            const geom = layer?.feature?.geometry;
            if (!geom || !geom.coordinates) continue;
            if (geom.type === 'Polygon' && Array.isArray(geom.coordinates)) {
                target.push(geom.coordinates);
            } else if (geom.type === 'MultiPolygon' && Array.isArray(geom.coordinates)) {
                geom.coordinates.forEach(poly => {
                    if (Array.isArray(poly)) target.push(poly);
                });
            }
        }
        return target;
    };

    // If we have a road geometry but no parcel outlines yet, pull nearby parcels from the current layer so borders are visible.
    if (fitToPolygonOnly && parcelPolygons.length === 0 && bounds && typeof bounds.isValid === 'function' && bounds.isValid()) {
        appendParcelsFromLayer(parcelPolygons, bounds, 200);
    }

    if (!polygon) return null;

    // Compute neighbour polygons from the client-side parcel cache
    let neighbours = [];
    if (hasParcels && typeof window.findNeighbourPolygonsFromCache === 'function') {
        const selectedIds = new Set();
        parcelLayers.forEach(layer => {
            const id = getParcelIdFromFeature(layer?.feature);
            if (id) selectedIds.add(id.toString());
        });
        selectedIds.forEach(parcelId => {
            const found = window.findNeighbourPolygonsFromCache(parcelId);
            if (Array.isArray(found)) {
                found.forEach(ring => neighbours.push(ring));
            }
        });
    }

    // For road geometry we convert to [lat, lng] pairs; otherwise let downstream normalize
    return { polygon, parcelPolygons, neighbours, bounds, fitToPolygonOnly, polygonOrder, parcelPolygonOrder };
}



if (typeof window !== 'undefined') {
    window.areParcelsContiguous = areParcelsContiguous;
}



// Backward compatibility alias







function updateProposalDescription(proposalType, forceUpdate = false) {
    // Legacy function - redirect to new function
    updateProposalNameAndDescription(proposalType, forceUpdate);
}


// Collapse the proposal-goal grid down to the selected goal (a chevron bar the
// user clicks to re-expand). Expanding shows all goals again.


// When collapsed, a click on the selected goal re-expands the grid instead of
// re-launching the tool. Capture-phase so it pre-empts the button's onclick.
if (typeof document !== 'undefined' && !window.__proposalGoalCollapseInstalled) {
    document.addEventListener('click', (e) => {
        const group = document.getElementById('proposalGoalGroup');
        if (!group || !group.classList.contains('is-collapsed') || !group.contains(e.target)) return;
        const btn = e.target.closest('.proposal-type-button[data-proposal-tool]');
        if (btn && btn.classList.contains('selected')) {
            e.stopPropagation();
            e.preventDefault();
            expandProposalGoalGroup();
        }
    }, true);
    window.__proposalGoalCollapseInstalled = true;
}




function readEnvLikeValue(key) {
    const globalScope = typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : null);
    if (!globalScope || !key) return null;
    const sources = [
        globalScope,
        globalScope.process && globalScope.process.env,
        globalScope.ENV,
        globalScope.env,
        globalScope.CONFIG,
        globalScope.config
    ];
    for (const source of sources) {
        if (!source || typeof source !== 'object') continue;
        if (Object.prototype.hasOwnProperty.call(source, key) && source[key] !== undefined && source[key] !== null) {
            const value = source[key];
            if (typeof value === 'string') {
                const trimmed = value.trim();
                if (trimmed) return trimmed;
            } else {
                return String(value);
            }
        }
    }
    return null;
}







// Show proposal creation dialog
function showProposalDialog(overrides = null) {
    // Gate: require personalized profile to create proposals
    if (requirePersonalizedUser()) {
        return;
    }

    // Stash overrides for this session
    proposalDialogOverrides = overrides || null;

    const t = getProposalI18nHelper();
    const parcelLabel = t('modal.roadWidth.proposalList.typeLabels.parcel', 'Parcel');
    const noParcelsMessage = t(
        'status.messages.please_select_at_least_one_parcel_to_create_a_proposal',
        'Please select at least one parcel to create a proposal.'
    );
    const modalTitle = t('modal.createProposal.title', 'Create Proposal');
    const closeAriaLabel = t('modal.createProposal.closeAria', 'Close proposal dialog');
    const authorLabel = t('modal.createProposal.authorLabel', 'Author:');
    const authorPlaceholder = t('modal.createProposal.authorPlaceholder', 'Your name');
    const authorAvatarAlt = t('modal.createProposal.authorAvatarAlt', 'Author avatar');
    const proposalTypeLabel = t('modal.createProposal.proposalTypeLabel', 'Proposal Type:');
    const proposalGoalLabel = t('modal.createProposal.proposalGoalLabel', 'Proposal Goal:');
    const proposalTypologyLabel = t('modal.createProposal.typologyLabel', 'Typology');
    const acquisitionLabel = t('modal.createProposal.acquisitionLabel', 'Acquisition strategy');
    const acquisitionOptions = {
        full: t('modal.createProposal.acquisitionOptions.full', 'Full acquisition'),
        partial: t('modal.createProposal.acquisitionOptions.partial', 'Partial acquisition'),
        partialPreferred: t('modal.createProposal.acquisitionOptions.partialPreferred', 'Partial acquisition preferred')
    };
    const ownershipLabel = t('modal.createProposal.ownershipLabel', 'Ownership');
    const ownershipOptions = {
        single: t('modal.createProposal.ownershipOptions.single', 'Single owner'),
        multiple: t('modal.createProposal.ownershipOptions.multiple', 'Multiple owners')
    };
    const nameLabel = t('modal.createProposal.nameLabel', 'Name:');
    const namePlaceholder = t('modal.createProposal.namePlaceholderProposal', 'Proposal name');
    const unknownParcelLabel = t('modal.createProposal.unknownParcel', 'Unknown');
    const unknownOwnerLabel = t('modal.createProposal.ownerUnknown', 'Unknown');
    const formatOwnerTooltip = (name) => t('modal.createProposal.ownerTooltip', 'Owner: {{name}}', { name });
    const proposalTypeLabels = {
        Purchase: t('modal.createProposal.proposalTypeOptions.purchase', 'Purchase'),
        'Urban Rule': t('modal.createProposal.proposalTypeOptions.urbanRule', 'Urban Rule'),
        Reparcellization: t('modal.createProposal.proposalTypeOptions.reparcellization', 'Reparcellization'),
        'Joint Investment': t('modal.createProposal.proposalTypeOptions.jointInvestment', 'Joint Investment')
    };
    const goalLabels = {
        buildings: t('modal.createProposal.goalOptions.buildings', 'Buildings'),
        single: t('modal.createProposal.goalOptions.single', 'Building(s)'),
        park: t('modal.createProposal.goalOptions.park', 'Park'),
        square: t('modal.createProposal.goalOptions.square', 'Square'),
        lake: t('modal.createProposal.goalOptions.lake', 'Lake'),
        roadTrack: t('modal.createProposal.goalOptions.roadTrack', 'Road/Track'),
        decideLater: t('modal.createProposal.goalOptions.decideLater', 'Decide later'),
        urbanRule: t('modal.createProposal.goalOptions.urbanRule', 'Urban Rule'),
        reparcellization: t('modal.createProposal.goalOptions.reparcellization', 'Reparcellization'),
        ownershipTransfer: t('modal.createProposal.goalOptions.ownershipTransfer', 'Ownership transfer')
    };
    const goalSectionLabels = {
        landUse: t('modal.createProposal.goalSections.landUse', 'Land use'),
        parcels: t('modal.createProposal.goalSections.parcels', 'Parcels'),
        ownership: t('modal.createProposal.goalSections.ownership', 'Ownership')
    };
    const asIsLandUseLabel = t('modal.createProposal.goalOptions.asIs', 'As is');
    const parcelsOptions = {
        asIs: t('modal.createProposal.parcelsOptions.asIs', 'As is'),
        merge: t('modal.createProposal.parcelsOptions.merge', 'Merge'),
        readjust: t('modal.createProposal.parcelsOptions.readjust', 'Readjust')
    };
    const ownershipRecipients = {
        noChange: t('modal.createProposal.ownershipRecipients.noChange', 'No change'),
        toMe: t('modal.createProposal.ownershipRecipients.toMe', 'To me'),
        toCity: t('modal.createProposal.ownershipRecipients.toCity', 'To city'),
        thirdParty: t('modal.createProposal.ownershipRecipients.thirdParty', 'Third party'),
        perSlice: t('modal.createProposal.ownershipRecipients.perSlice', 'Per slice')
    };
    const recipientPlaceholder = t('modal.createProposal.recipientPlaceholder', 'Recipient name or 0x address');
    const recipientScopeLabels = {
        specific: t('modal.createProposal.recipientScope.specific', 'Specific address'),
        any: t('modal.createProposal.recipientScope.any', 'Anyone')
    };
    const ownershipTransferLabels = {
        toMe: t('modal.createProposal.ownershipTransfer.toMe', 'To me'),
        fromMe: t('modal.createProposal.ownershipTransfer.fromMe', 'From me')
    };
    proposalAcquisitionLabels = {
        full: acquisitionOptions.full,
        partial: acquisitionOptions.partial,
        partialPreferred: acquisitionOptions.partialPreferred
    };
    const typologyOptions = {
        block: t('modal.createProposal.typologyOptions.block', 'Block'),
        row: t('modal.createProposal.typologyOptions.row', 'Row'),
        parcelBased: t('modal.createProposal.typologyOptions.parcelBased', 'Parcel-based')
    };
    const descriptionLabel = t('modal.createProposal.descriptionLabel', 'Description:');
    const descriptionPlaceholder = t('modal.createProposal.descriptionPlaceholder', 'Describe your proposal...');
    const offerLabel = t('modal.createProposal.offerLabel', 'Offer:');
    const offerPlaceholder = t('modal.createProposal.offerPlaceholder', '0');
    const optionsLabel = t('modal.createProposal.optionsLabel', 'Options:');
    const conditionalLabel = t('modal.createProposal.options.conditional', 'Conditional');
    const conditionalHelperOnText = t('modal.createProposal.options.conditionalHelperOn', 'Pay reward only if/when all owners accept');
    const conditionalHelperOffText = t('modal.createProposal.options.conditionalHelperOff', 'Payout only when all parcels accept');
    const expireAfterLabel = t('modal.createProposal.options.expireAfter', 'Expire after');
    const expiryPlaceholder = t('modal.createProposal.options.expiryPlaceholder', '00h:05m:00s');
    const decayLabel = t('modal.createProposal.options.decay', 'Offer Decay');
    const decayHelperText = t('modal.createProposal.options.decayHelper', 'Offer amount will decrease with time to entice acceptance.');
    const decayPercentSuffix = t('modal.createProposal.options.decayPercentSuffix', '% over');
    const decayTimePlaceholder = t('modal.createProposal.options.decayTimePlaceholder', '00h:05m:00s');
    const depositLabel = t('modal.createProposal.options.deposit', 'Deposit');
    const depositHelperText = t('modal.createProposal.options.depositHelper', '% of offer');
    const areaProportionalText = t('modal.createProposal.options.areaProportional', 'Payouts are proportional to parcel area');
    const summaryTitle = t('modal.createProposal.summary.title', 'Proposal Summary');
    const summaryParcelsLabel = t('modal.createProposal.summary.parcels', 'Parcels Selected:');
    const summaryAreaLabel = t('modal.createProposal.summary.area', 'Total Area:');
    const summaryOwnersLabel = t('modal.createProposal.summary.owners', 'Total owners:');
    const summarySelectedLabel = t('modal.createProposal.summary.selected', 'Selected Parcels:');
    const similarTitle = t('modal.createProposal.similar.title', 'Similar proposals:');
    const similarUnknownTitle = t('modal.createProposal.similar.unknownTitle', 'Untitled proposal');
    const similarUnknownAuthor = t('modal.createProposal.similar.unknownAuthor', 'Unknown');
    const lensTooltip = t('modal.createProposal.lensTooltip', 'Open lens modal');
    const submitLabel = t('modal.createProposal.submit', 'Create Proposal');

    const overrideGoal = normalizeGoalKey(proposalDialogOverrides?.goal) || null;
    const overrideAcquisition = proposalDialogOverrides?.acquisitionMode || null;
    const overridePrefill = proposalDialogOverrides?.prefill || {};
    const overrideSummaryStats = proposalDialogOverrides?.summaryStats || null;
    const overrideGeometryPreset = proposalDialogOverrides?.geometryPreset || null;
    const goalLocked = !!(proposalDialogOverrides && proposalDialogOverrides.lockGoal);
    const acquisitionLocked = !!(proposalDialogOverrides && proposalDialogOverrides.lockAcquisition);

    const selection = getCurrentParcelSelectionContext();
    const selectedParcels = selection.layers;
    const parcelIds = selection.ids;
    const isSingleParcelSelection = selectedParcels.length === 1;
    const roadScreenshotContext = ((typeof window !== 'undefined' && window.pendingRoadDrawingProposal)
        ? window.pendingRoadDrawingProposal
        : pendingRoadDrawingProposal) || null;
    const screenshotContext = buildProposalScreenshotContext(selectedParcels, {
        goal: overrideGoal,
        roadContext: roadScreenshotContext
    });

    currentProposalTool = null;

    if (!selectedParcels.length) {
        updateStatus(noParcelsMessage);
        return;
    }

    const totalArea = selectedParcels.reduce((sum, parcel) => {
        const area = parcel.feature?.properties?.calculatedArea || 0;
        return sum + area;
    }, 0);

    const ownershipStats = computeOwnershipStatsFromSelection(selection);
    const totalOwners = ownershipStats.ownerCount || selectedParcels.length;
    const ownershipMode = ownershipStats.mode;
    currentOwnershipMode = ownershipMode;
    proposalSingleParcelSelection = isSingleParcelSelection;

    // Create parcel list HTML with error handling
    const parcelListHTML = selectedParcels.map(parcel => {
        const parcelId = getParcelIdFromFeature(parcel?.feature);
        const parcelNumber = getParcelDisplayNumberFromProperties(parcel?.feature?.properties, parcelId || unknownParcelLabel) || unknownParcelLabel;

        // Get parcel owner information
        let ownerAvatarHtml = '';
        if (parcelId) {
            const ownerId = PersistentStorage.getItem(`parcel_${parcelId}_owner`);
            if (ownerId && typeof agentStorage !== 'undefined') {
                const owner = agentStorage.getAgent(ownerId);
                if (owner && typeof getAvatarImagePath === 'function') {
                    const ownerName = owner.name || unknownOwnerLabel;
                    const ownerTooltip = formatOwnerTooltip(ownerName);
                    ownerAvatarHtml = `<img src="${getAvatarImagePath(owner.avatarIndex)}" class="parcel-owner-avatar" style="width: 20px; height: 20px; border-radius: 50%; border: 2px solid #007bff; margin-right: 6px;" title="${ownerTooltip}">`;
                }
            }
        }

        return `
            <div class="proposal-parcel-item" style="display: flex; align-items: center;">
                ${ownerAvatarHtml}
                <div>
                    <span class="parcel-number">${parcelLabel} ${parcelNumber}</span>
                </div>
            </div>
        `;
    }).join('');

    // Shared inline style for helper text in the options column
    const optionHelperStyle = 'color:#6b7280; font-size:12px; line-height:1.3;';

    // Create modal dialog
    const modal = document.createElement('div');
    modal.className = 'create-proposal-modal';
    modal.innerHTML = `
        <div class="proposal-modal-content">
            <div class="proposal-modal-header">
                <h2>${modalTitle}</h2>
                <button type="button" class="proposal-modal-close close-circle-btn close-circle-btn--lg" aria-label="${closeAriaLabel}" onclick="closeProposalDialog()">&times;</button>
            </div>
            <div class="proposal-modal-body">
                ${screenshotContext ? '<div class="form-group" id="proposalScreenshotContainer" style="margin-bottom: 15px;"></div>' : ''}
                <div class="form-group proposal-author-row">
                    <img id="proposalAuthorAvatar" class="proposal-author-avatar" alt="${authorAvatarAlt}" />
                    <input type="text" id="proposalAuthor" class="proposal-author-name" placeholder="${authorPlaceholder}" disabled>
                </div>
                <div class="form-group" id="proposalMainTypeGroup" style="display:none;">
                    <label>${proposalTypeLabel}</label>
                    <div class="proposal-type-group">
                        <button type="button" class="btn proposal-type-button selected" data-proposal-main-type="Purchase" onclick="setProposalMainType('Purchase')">${proposalTypeLabels.Purchase}</button>
                        <button type="button" class="btn proposal-type-button" data-proposal-main-type="Urban Rule" onclick="handleUrbanRuleMainTypeClick()">${proposalTypeLabels['Urban Rule']}</button>
                        <button type="button" class="btn proposal-type-button" data-proposal-main-type="Reparcellization" onclick="setProposalMainType('Reparcellization')">${proposalTypeLabels.Reparcellization}</button>
                        <button type="button" class="btn proposal-type-button" data-proposal-main-type="Joint Investment" disabled>${proposalTypeLabels['Joint Investment']}</button>
                    </div>
                </div>
                <input type="hidden" id="proposalMainType" value="Purchase">
                <div class="form-group" id="proposalGoalGroup">
                    <div class="proposal-goal-section" data-goal-section="land-use">
                        <span class="proposal-goal-subhead">${goalSectionLabels.landUse}</span>
                        <div class="proposal-radio-group" id="proposalLandUseGroup">
                            <label class="proposal-radio"><input type="radio" name="proposalLandUse" value="as-is" checked onchange="onProposalLandUseChange()"><span>${asIsLandUseLabel}</span></label>
                            <label class="proposal-radio"><input type="radio" name="proposalLandUse" value="square" onchange="onProposalLandUseChange()"><span>⛲️ ${goalLabels.square}</span></label>
                            <label class="proposal-radio"><input type="radio" name="proposalLandUse" value="park" onchange="onProposalLandUseChange()"><span>🌳 ${goalLabels.park}</span></label>
                            <label class="proposal-radio"><input type="radio" name="proposalLandUse" value="lake" onchange="onProposalLandUseChange()"><span>🐟 ${goalLabels.lake}</span></label>
                            <label class="proposal-radio"><input type="radio" name="proposalLandUse" value="single" onchange="onProposalLandUseChange()"><span>🏠 ${goalLabels.single}</span></label>
                            <label class="proposal-radio"><input type="radio" name="proposalLandUse" value="road-track" onchange="onProposalLandUseChange()"><span>🛣️ ${goalLabels.roadTrack}</span></label>
                            <label class="proposal-radio"><input type="radio" name="proposalLandUse" value="urban-rule" onchange="onProposalLandUseChange()"><span>📜 ${goalLabels.urbanRule}</span></label>
                        </div>
                    </div>
                    <div class="proposal-goal-section" data-goal-section="parcels">
                        <span class="proposal-goal-subhead">${goalSectionLabels.parcels}</span>
                        <div class="proposal-radio-group" id="proposalParcelsGroup">
                            <label class="proposal-radio"><input type="radio" name="proposalParcelsMode" value="as-is" checked onchange="onProposalParcelsChange()"><span>${parcelsOptions.asIs}</span></label>
                            <label class="proposal-radio"><input type="radio" name="proposalParcelsMode" value="merge" onchange="onProposalParcelsChange()"><span>🪡 ${parcelsOptions.merge}</span></label>
                            <label class="proposal-radio"><input type="radio" name="proposalParcelsMode" value="readjust" onchange="onProposalParcelsChange()"><span>✂️ ${parcelsOptions.readjust}</span></label>
                        </div>
                        <div class="proposal-facet-static" id="proposalParcelsStatic" style="display:none;"></div>
                    </div>
                    <div class="proposal-goal-section" data-goal-section="ownership">
                        <span class="proposal-goal-subhead">${goalSectionLabels.ownership}</span>
                        <div class="proposal-radio-group" id="proposalOwnershipGroup">
                            <label class="proposal-radio"><input type="radio" name="proposalOwnership" value="no-change" checked onchange="onProposalOwnershipChange()"><span>${ownershipRecipients.noChange}</span></label>
                            <label class="proposal-radio"><input type="radio" name="proposalOwnership" value="to-me" onchange="onProposalOwnershipChange()"><span>${ownershipRecipients.toMe}</span></label>
                            <label class="proposal-radio"><input type="radio" name="proposalOwnership" value="to-city" onchange="onProposalOwnershipChange()"><span>${ownershipRecipients.toCity}</span></label>
                            <label class="proposal-radio"><input type="radio" name="proposalOwnership" value="third-party" onchange="onProposalOwnershipChange()"><span>${ownershipRecipients.thirdParty}</span></label>
                            <label class="proposal-radio proposal-ownership-perslice" style="display:none;"><input type="radio" name="proposalOwnership" value="per-slice" onchange="onProposalOwnershipChange()"><span>${ownershipRecipients.perSlice}</span></label>
                        </div>
                        <div class="proposal-facet-static" id="proposalOwnershipStatic" style="display:none;"></div>
                        <div class="proposal-inset" id="proposalRecipientOptions" style="display:none;">
                            <div class="proposal-radio-group">
                                <label class="proposal-radio"><input type="radio" name="proposalRecipientScope" value="any" checked onchange="onProposalRecipientScopeChange()"><span>${recipientScopeLabels.any}</span></label>
                                <label class="proposal-radio"><input type="radio" name="proposalRecipientScope" value="specific" onchange="onProposalRecipientScopeChange()"><span>${recipientScopeLabels.specific}</span></label>
                            </div>
                            <input type="text" id="proposalRecipientAddress" class="proposal-recipient-input" placeholder="${recipientPlaceholder}" oninput="onProposalOwnershipChange()">
                        </div>
                    </div>
                </div>
                <div class="form-group" id="proposalOwnershipTransferGroup" style="display:none;">
                    <label>${t('modal.createProposal.ownershipTransfer.label', 'Transfer direction:')}</label>
                    <div class="proposal-type-group">
                        <button type="button" class="btn proposal-type-button proposal-ownership-transfer-button selected" data-transfer-direction="to-me" onclick="setOwnershipTransferDirection('to-me')">${ownershipTransferLabels.toMe}</button>
                        <button type="button" class="btn proposal-type-button proposal-ownership-transfer-button" data-transfer-direction="from-me" onclick="setOwnershipTransferDirection('from-me')">${ownershipTransferLabels.fromMe}</button>
                    </div>
                </div>
                <div class="form-group" id="proposalAcquisitionGroup">
                    <span class="proposal-goal-subhead">${acquisitionLabel}</span>
                    <div class="proposal-radio-group">
                        <label class="proposal-radio"><input type="radio" name="proposalAcquisition" value="full" checked onchange="setProposalAcquisitionMode('full')"><span>${acquisitionOptions.full}</span></label>
                        <label class="proposal-radio"><input type="radio" name="proposalAcquisition" value="partial" onchange="setProposalAcquisitionMode('partial')"><span class="proposal-acquisition-partial-label">${acquisitionOptions.partial}</span></label>
                    </div>
                </div>
                <div class="form-group proposal-inset" id="proposalTypologyGroup" style="display:none;">
                    <label>${proposalTypologyLabel}</label>
                    <div class="proposal-type-group">
                        <button type="button" class="btn proposal-type-button proposal-typology-button" data-proposal-typology="block" onclick="handleUrbanRuleTypologyClick('block', { skipLaunch: true })">${typologyOptions.block}</button>
                        <button type="button" class="btn proposal-type-button proposal-typology-button" data-proposal-typology="row" onclick="handleUrbanRuleTypologyClick('row', { skipLaunch: true })">${typologyOptions.row}</button>
                        <button type="button" class="btn proposal-type-button proposal-typology-button" data-proposal-typology="parcelBased" onclick="handleUrbanRuleTypologyClick('parcelBased', { skipLaunch: true })">${typologyOptions.parcelBased}</button>
                    </div>
                </div>
                <div class="form-group proposal-inset" id="proposalGeometryGroup" style="display:none;">
                    <div id="proposalGeometryStatus" class="proposal-geometry-status" style="font-size:12px; color:#4b5563; margin-bottom:6px;">${t('modal.createProposal.geometry.status.noGeometry', 'No geometry: please define a geometry')}</div>
                    <div class="proposal-type-group proposal-geometry-buttons" id="proposalGeometryButtons" style="display:grid; grid-template-columns: repeat(3, 1fr); gap:8px;"></div>
                </div>
                <input type="hidden" id="proposalType" value="">
                <input type="hidden" id="proposalAcquisitionMode" value="full">
                <input type="hidden" id="proposalBoundaryMode" value="multiple">
                <hr class="proposal-section-divider">
                <div class="form-group">
                    <label for="proposalName" style="display: flex; align-items: center; gap: 8px;">
                        <span>${nameLabel}</span>
                        <input type="text" id="proposalName" style="flex: 1;" placeholder="${namePlaceholder}">
                    </label>
                </div>
                <div class="form-group">
                    <label for="proposalDescription">${descriptionLabel}</label>
                    <input type="text" id="proposalDescription" class="proposal-description-input" placeholder="${descriptionPlaceholder}">
                </div>
                <div class="form-group">
                    <label for="proposalOffer">${offerLabel}</label>
                    <div class="proposal-offer-row" style="display:flex; gap:8px; align-items:center;">
                        <input type="text" id="proposalOffer" placeholder="${offerPlaceholder}" inputmode="numeric" style="flex:1 1 auto;" oninput="handleProposalOfferInput(this)">
                        <select id="proposalCurrency" style="flex:0 0 112px; max-width:112px; min-width:112px;">
                            <option value="EUR">EUR</option>
                            <option value="USD">USD</option>
                            <option value="ETH">ETH</option>
                            <option value="ARS">ARS</option>
                            <option value="USDC">USDC</option>
                            <option value="USDT" selected>USDT</option>
                        </select>
                    </div>
                </div>
                <div class="form-group proposal-options-section">
                    <label>${optionsLabel}</label>
                    <div class="proposal-option-row" id="proposalOptionConditional" style="display:flex; align-items:center; gap:8px; margin-bottom:6px;">
                        <div style="flex:1; display:flex; align-items:center; gap:6px;">
                            <input type="checkbox" id="proposalConditionalCheckbox" checked>
                            <label for="proposalConditionalCheckbox" style="margin:0; cursor:pointer;">${conditionalLabel}</label>
                        </div>
                        <div id="proposalConditionalHelperText" style="${optionHelperStyle} flex:1;">
                            ${conditionalHelperOnText}
                        </div>
                    </div>
                    <div class="proposal-option-row" id="proposalOptionExpire" style="display:grid; grid-template-columns: 1fr 1fr; align-items:center; gap:8px;">
                        <div style="display:flex; align-items:center; gap:6px;">
                            <input type="checkbox" id="proposalExpireCheckbox" onchange="toggleExpiryInput()">
                            <label for="proposalExpireCheckbox" style="margin:0; cursor:pointer;">${expireAfterLabel}</label>
                        </div>
                        <div>
                            <input type="text" id="proposalExpiryTime" value="${expiryPlaceholder}" placeholder="${expiryPlaceholder}" style="width:100%; text-align:center;" disabled>
                        </div>
                    </div>
                    <div class="proposal-option-row" id="proposalOptionDecay" style="display:flex; align-items:center; gap:8px; margin-top:6px;">
                        <div style="flex:1; display:flex; align-items:center; gap:6px;">
                            <input type="checkbox" id="proposalDecayCheckbox" onchange="toggleDecayInput()">
                            <label for="proposalDecayCheckbox" style="margin:0; cursor:pointer;">${decayLabel}</label>
                        </div>
                        <div style="flex:1; ${optionHelperStyle}">${decayHelperText}</div>
                    </div>
                    <div class="proposal-option-row proposal-decay-inputs" id="proposalOptionDecayInputs" style="display:grid; grid-template-columns: 1fr 1fr; align-items:center; gap:8px; margin-top:4px;">
                        <div style="display:flex; align-items:center; gap:4px; padding-left:28px;">
                            <input type="text" id="proposalDecayPercent" value="50" pattern="[0-9]*" inputmode="numeric" style="width:40px; text-align:center;" disabled>
                            <span style="color:#666;">${decayPercentSuffix}</span>
                        </div>
                        <div>
                            <input type="text" id="proposalDecayTime" value="${decayTimePlaceholder}" placeholder="${decayTimePlaceholder}" style="width:100%; text-align:center;" disabled>
                        </div>
                    </div>
                    <div class="proposal-option-row" id="proposalOptionDeposit" style="display:flex; align-items:center; gap:8px; margin-top:6px;">
                        <div style="flex:1; display:flex; align-items:center; gap:6px;">
                            <input type="checkbox" id="proposalDepositCheckbox" onchange="toggleDepositInput()">
                            <label for="proposalDepositCheckbox" style="margin:0; cursor:pointer;">${depositLabel}</label>
                        </div>
                        <div style="flex:1; display:flex; align-items:center; gap:4px;">
                            <input type="text" id="proposalDepositPercent" value="100" pattern="[0-9]*" inputmode="numeric" style="width:55px; text-align:center;" disabled>
                            <span style="color:#666;">${depositHelperText}</span>
                        </div>
                    </div>
                    <div class="proposal-option-row" id="proposalOptionAreaProportional" style="grid-column: 1 / span 2; display:flex; align-items:center; gap:8px; margin-top:8px;">
                        <div style="display:flex; align-items:center; gap:6px;">
                            <input type="checkbox" id="proposalAreaProportionalCheckbox" checked disabled>
                            <label for="proposalAreaProportionalCheckbox" style="margin:0;">${areaProportionalText}</label>
                        </div>
                    </div>
                </div>
                <div class="proposal-summary collapsible collapsed" id="proposalSummarySection">
                    <div class="collapsible-header" tabindex="0" role="button" aria-expanded="false" aria-controls="proposalSummaryContent" onclick="(function(e){
                        var section = document.getElementById('proposalSummarySection');
                        var content = document.getElementById('proposalSummaryContent');
                        var icon = document.getElementById('proposalSummaryChevron');
                        var expanded = section.classList.toggle('collapsed');
                        if (section.classList.contains('collapsed')) {
                            content.style.display = 'none';
                            icon.classList.remove('fa-chevron-up');
                            icon.classList.add('fa-chevron-down');
                            section.setAttribute('aria-expanded', 'false');
                        } else {
                            content.style.display = '';
                            icon.classList.remove('fa-chevron-down');
                            icon.classList.add('fa-chevron-up');
                            section.setAttribute('aria-expanded', 'true');
                        }
                    })(event)">
                        <h3 style="display:inline; font-size: 1.1em; font-weight: 600; margin:0;">${summaryTitle}</h3>
                        <i id="proposalSummaryChevron" class="fas fa-chevron-down" style="margin-left: 8px;"></i>
                    </div>
                    <div id="proposalSummaryContent" style="display:none;">
                        <div class="summary-stats">
                            <p><strong>${summaryParcelsLabel}</strong> ${selectedParcels.length}</p>
                            <p><strong>${summaryAreaLabel}</strong> ${Math.round(totalArea).toLocaleString('hr-HR')} m²</p>
                            <p><strong>${summaryOwnersLabel}</strong> ${totalOwners}</p>
                        </div>
                        <div class="parcel-list">
                            <h4>${summarySelectedLabel}</h4>
                            ${parcelListHTML}
                        </div>
                    </div>
                </div>
                <div class="proposal-similar-section" id="proposalSimilarSection" style="margin-top:12px; display:none;">
                    <h4 style="margin-bottom:6px;">${similarTitle}</h4>
                    <div id="proposalSimilarList" class="proposal-similar-list" style="display:flex; flex-direction:column; gap:6px;"></div>
                </div>
            </div>
            <div class="proposal-modal-footer lens-footer-layout">
                <div class="lens-footer-row">
                    <button type="button" class="lens-pattern-button" data-lens-pattern onclick="showLensModal()" title="${lensTooltip}">👓</button>
                </div>
                <div style="display:flex; flex-direction:column; align-items:flex-end; gap:4px; width:100%;">
                    <button id="createProposalSubmitButton" class="btn btn-proposal" onclick="createProposal()">${submitLabel}</button>
                    <div id="proposalGeometryRequirementHint" style="font-size:11px; color:#c00; min-height:14px; text-align:right;"></div>
                </div>
            </div>
        </div>
    `;

    document.body.appendChild(modal);

    // Reset stored screenshot
    proposalModalScreenshotDataUrl = null;
    proposalModalScreenshotPromise = null;

    if (screenshotContext && screenshotContext.polygon && window.MapScreenshot && typeof window.MapScreenshot.renderPolygonPreview === 'function') {
        const screenshotContainer = modal.querySelector('#proposalScreenshotContainer');
        if (screenshotContainer) {
            (async () => {
                try {
                    const previewWrapper = document.createElement('div');
                    previewWrapper.className = 'map-screenshot-container';
                    previewWrapper.style.margin = '0 auto';
                    screenshotContainer.appendChild(previewWrapper);

                    const resolveGoalBadge = () => getProposalGoalBadge(currentProposalTool || 'square');
                    updateProposalScreenshotGoalIcon(currentProposalTool || 'square');

                    window.MapScreenshot.renderPolygonPreview(previewWrapper, {
                        polygon: screenshotContext.polygon,
                        bounds: screenshotContext.bounds || null,
                        padding: 0.05,
                        parcelPolygons: screenshotContext.parcelPolygons,
                        neighbours: screenshotContext.neighbours || [],
                        fitToPolygonOnly: !!screenshotContext.fitToPolygonOnly,
                        polygonOrder: screenshotContext.polygonOrder || 'auto',
                        parcelPolygonOrder: screenshotContext.parcelPolygonOrder || 'auto'
                    });

                    // Capture the screenshot after tiles have loaded and store it for minting
                    const captureScreenshot = () => {
                        if (proposalModalScreenshotPromise) return proposalModalScreenshotPromise;
                        if (!previewWrapper._leafletPreviewMap) {
                            console.warn('[proposal-modal] Preview map not ready for capture');
                            return null;
                        }
                        if (!window.MapScreenshot.captureViaTileStitch || !screenshotContext?.polygon) {
                            console.warn('[proposal-modal] Tile stitch capture unavailable; skipping preview capture');
                            return null;
                        }

                        if (window?.__DEBUG_SCREENSHOT_CONTEXT__) {
                            console.debug('[proposal-modal] capturing screenshot', {
                                polygonLength: screenshotContext.polygon?.length,
                                parcelPolygonsCount: screenshotContext.parcelPolygons?.length,
                                hasBounds: !!screenshotContext.bounds,
                                fitToPolygonOnly: !!screenshotContext.fitToPolygonOnly
                            });
                        }

                        const stitchStart = (performance && performance.now) ? performance.now() : Date.now();
                        const capturePromise = (async () => {
                            try {
                                const dataUrl = await window.MapScreenshot.captureViaTileStitch({
                                    polygon: screenshotContext.polygon,
                                    parcelPolygons: screenshotContext.parcelPolygons || [],
                                    neighbours: screenshotContext.neighbours || [],
                                    bounds: screenshotContext.bounds || null,
                                    padding: 0.12,
                                    zoom: 19,
                                    badge: resolveGoalBadge(),
                                    polygonOrder: screenshotContext.polygonOrder || 'auto',
                                    parcelPolygonOrder: screenshotContext.parcelPolygonOrder || 'auto',
                                    fitToPolygonOnly: !!screenshotContext.fitToPolygonOnly
                                });
                                const stitchMs = ((performance && performance.now ? performance.now() : Date.now()) - stitchStart).toFixed(1);

                                let byteSize = 0;
                                if (dataUrl && dataUrl.startsWith('data:image/')) {
                                    const base64Part = dataUrl.split(',')[1];
                                    byteSize = base64Part ? Math.ceil(base64Part.length * 3 / 4) : 0;
                                }

                                if (byteSize >= 5000) {
                                    proposalModalScreenshotDataUrl = dataUrl;
                                    console.debug('[proposal-modal] Tile stitch captured', { byteSize, stitchMs });
                                    return dataUrl;
                                }

                                console.warn('[proposal-modal] Tile stitch produced small image:', byteSize, 'bytes');
                                return null;
                            } catch (err) {
                                console.warn('[proposal-modal] Failed to capture screenshot for storage:', err);
                                return null;
                            }
                        })();

                        proposalModalScreenshotPromise = capturePromise;
                        return capturePromise;
                    };

                    // Wait for map to be ready and tiles to load
                    let waitForMapAttempts = 0;
                    const waitForMapAndCapture = () => {
                        waitForMapAttempts++;
                        const map = previewWrapper._leafletPreviewMap;
                        if (!map) {
                            if (waitForMapAttempts > 100) {
                                console.error('[proposal-modal] Gave up waiting for map after 100 attempts');
                                return;
                            }
                            // Map not set yet, try again shortly
                            setTimeout(waitForMapAndCapture, 100);
                            return;
                        }

                        // Find tile layer and wait for it to load
                        let tileLayer = null;
                        map.eachLayer(layer => {
                            if (layer._url && !tileLayer) {
                                tileLayer = layer;
                            }
                        });

                        if (tileLayer) {
                            // Listen for tile load completion
                            let captured = false;
                            const onLoad = () => {
                                if (captured) return;
                                captured = true;
                                tileLayer.off('load', onLoad);
                                // Small delay after load event to ensure rendering is complete
                                setTimeout(captureScreenshot, 300);
                            };
                            tileLayer.on('load', onLoad);
                            // Timeout fallback - capture after 4 seconds regardless
                            setTimeout(() => {
                                if (!captured) {
                                    captured = true;
                                    tileLayer.off('load', onLoad);
                                    captureScreenshot();
                                }
                            }, 4000);
                        } else {
                            // No tile layer found, just wait and capture
                            setTimeout(captureScreenshot, 2000);
                        }
                    };

                    // Start waiting for map
                    setTimeout(waitForMapAndCapture, 50);
                } catch (error) {
                    console.warn('Failed to render proposal screenshot preview', error);
                    screenshotContainer.innerHTML = '';
                    const fallbackDiv = document.createElement('div');
                    fallbackDiv.className = 'map-screenshot-container';
                    fallbackDiv.style.color = '#999';
                    fallbackDiv.textContent = 'Preview unavailable';
                    screenshotContainer.appendChild(fallbackDiv);
                }
            })();
        }
    }

    // Lock secondary selectors that are derived from the selected goal.
    // Urban Rule typology is a user choice and must remain selectable because the Geometry → Edit action
    // opens different modals depending on the selected typology (block/row/parcelBased).
    const lockSecondarySelectors = () => {
        const secondaryGroupIds = ['proposalAcquisitionGroup', 'proposalBoundaryGroup'];
        secondaryGroupIds.forEach(groupId => {
            const groupEl = modal.querySelector(`#${groupId}`);
            if (!groupEl) return;
            groupEl.classList.add('proposal-secondary-locked');
            const buttons = groupEl.querySelectorAll('.proposal-type-button, input[type="radio"]');
            buttons.forEach(btn => {
                btn.disabled = true;
                btn.classList.add('proposal-selection-static');
                btn.setAttribute('aria-disabled', 'true');
            });
        });
    };

    lockSecondarySelectors();

    if (typeof refreshLensPatternPreviews === 'function') {
        refreshLensPatternPreviews();
    }
    const initialGoal = overrideGoal || 'as-is';
    // Initialize the three facets (Land use / Parcels / Ownership). Defaults to
    // As is / As is / No change unless a goal was preset (e.g. from a road drawing).
    // This drives the legacy goal-key machinery via syncProposalFacets().
    initProposalFacets(overrideGoal);
    setProposalAcquisitionMode(overrideAcquisition || 'full', { force: true });
    setProposalBoundaryMode(ownershipMode || 'multiple', { lock: true });

    if (goalLocked) {
        // The three facets are now radio groups; lock them all to the preset selection.
        modal.querySelectorAll('#proposalGoalGroup input[type="radio"]').forEach(r => {
            r.disabled = true;
            r.setAttribute('aria-disabled', 'true');
        });
    }

    if (acquisitionLocked) {
        const desired = overrideAcquisition === 'partial-preferred' ? 'partial' : (overrideAcquisition || null);
        modal.querySelectorAll('#proposalAcquisitionGroup input[type="radio"]').forEach(radio => {
            if (desired) radio.checked = (radio.value === desired);
            radio.disabled = true;
            radio.classList.add('proposal-selection-static');
            radio.setAttribute('aria-disabled', 'true');
        });
        if (overrideAcquisition === 'partial-preferred') {
            const partialLabel = modal.querySelector('.proposal-acquisition-partial-label');
            if (partialLabel) partialLabel.textContent = proposalAcquisitionLabels.partialPreferred || partialLabel.textContent;
        }
        const acquisitionInput = document.getElementById('proposalAcquisitionMode');
        if (acquisitionInput) {
            acquisitionInput.value = overrideAcquisition || acquisitionInput.value || 'full';
        }
    }

    // Check contiguity and disable buttons that require contiguous parcels
    applyContiguityConstraints();

    const conditionalCheckbox = document.getElementById('proposalConditionalCheckbox');
    const conditionalHelper = document.getElementById('proposalConditionalHelperText');
    const conditionalRow = conditionalCheckbox ? conditionalCheckbox.closest('.proposal-option-row') : null;
    const updateConditionalHelper = () => {
        if (!conditionalHelper || !conditionalCheckbox) return;
        conditionalHelper.textContent = conditionalCheckbox.checked
            ? conditionalHelperOnText
            : conditionalHelperOffText;
    };
    if (conditionalCheckbox) {
        const disableConditional = isSingleParcelSelection;
        conditionalCheckbox.checked = !disableConditional;
        conditionalCheckbox.disabled = disableConditional;
        if (conditionalRow) {
            conditionalRow.style.opacity = disableConditional ? '0.6' : '';
            conditionalRow.style.cursor = '';
        }
        conditionalCheckbox.addEventListener('change', updateConditionalHelper);
    }
    updateConditionalHelper();

    if (overrideGeometryPreset) {
        const geometryStatusText = overrideGeometryPreset.statusText
            || (t ? t('modal.createProposal.geometry.status.drawing', 'Geometry created by drawing') : 'Geometry created by drawing');
        // Ensure geometry is treated as submitted when coming from a preset (e.g. road drawing)
        proposalGeometrySubmitted = overrideGeometryPreset.submitted !== false;
        setGeometryStatus(geometryStatusText, { submitted: proposalGeometrySubmitted });
        const buttonsRow = document.getElementById('proposalGeometryButtons');
        if (buttonsRow) {
            const preferredAction = overrideGeometryPreset.selectedAction || 'upload';
            const disableButtons = overrideGeometryPreset.disableButtons !== false;
            buttonsRow.querySelectorAll('button').forEach(btn => {
                const action = btn.getAttribute('data-geometry-action') || btn.dataset.geometryAction;
                if (action === preferredAction) {
                    btn.classList.add('selected');
                } else {
                    btn.classList.remove('selected');
                }
                if (disableButtons) {
                    btn.disabled = true;
                    btn.classList.add('proposal-selection-static');
                    btn.setAttribute('aria-disabled', 'true');
                }
            });
            if (disableButtons) {
                buttonsRow.style.pointerEvents = 'none';
            }
        }
        // Re-run submit state guard after presetting geometry to avoid stale "No geometry" hint
        updateCreateProposalSubmitState();
    }

    if (overrideSummaryStats) {
        const summarySection = document.getElementById('proposalSummarySection');
        const summaryContent = document.getElementById('proposalSummaryContent');
        if (summarySection && summaryContent) {
            summarySection.classList.remove('collapsed');
            summaryContent.style.display = '';
            const chevron = document.getElementById('proposalSummaryChevron');
            if (chevron) {
                chevron.classList.remove('fa-chevron-down');
                chevron.classList.add('fa-chevron-up');
            }

            const labelMap = {
                individual: 'Individuals',
                company: 'Companies',
                government: 'Government',
                institution: 'Institutions',
                mixed: 'Mixed'
            };
            const formatNumber = (value) => {
                const num = Number(value);
                return Number.isFinite(num) ? Math.round(num).toLocaleString('hr-HR') : value;
            };

            const lines = [];
            if (overrideSummaryStats.individualOwners !== null && overrideSummaryStats.individualOwners !== undefined) {
                lines.push(`<p><strong>Individual owners:</strong> ${formatNumber(overrideSummaryStats.individualOwners)}</p>`);
            }
            const counts = overrideSummaryStats.ownershipCounts || {};
            const countEntries = Object.entries(counts).filter(([, value]) => value !== null && value !== undefined);
            if (countEntries.length) {
                const countText = countEntries
                    .map(([key, value]) => `${labelMap[key] || key}: ${formatNumber(value)}`)
                    .join(' • ');
                lines.push(`<p><strong>Ownership mix:</strong> ${countText}</p>`);
            }
            if (overrideSummaryStats.totalMarketPrice !== null && overrideSummaryStats.totalMarketPrice !== undefined) {
                lines.push(`<p><strong>Total market price:</strong> ${formatNumber(overrideSummaryStats.totalMarketPrice)} EUR</p>`);
            }
            if (overrideSummaryStats.totalAcquiringDifficulty !== null && overrideSummaryStats.totalAcquiringDifficulty !== undefined) {
                lines.push(`<p><strong>Acquiring difficulty:</strong> ${formatNumber(overrideSummaryStats.totalAcquiringDifficulty)}</p>`);
            }

            if (lines.length) {
                const statsBlock = document.createElement('div');
                statsBlock.className = 'proposal-summary-extra';
                statsBlock.style.marginTop = '8px';
                statsBlock.innerHTML = `
                    <div class="summary-stats">
                        <h4 style="margin: 6px 0 4px;">Ownership & Acquisition Stats</h4>
                        ${lines.join('')}
                    </div>
                `;
                summaryContent.appendChild(statsBlock);
            }
        }
    }

    // Pre-fill the offer amount with a random value between 1 and 1,000,000 EUR
    const offerInput = document.getElementById('proposalOffer');
    if (offerInput) {
        const minOfferEur = 1;
        const maxOfferEur = 1000000;
        const randomOffer = Math.floor(Math.random() * (maxOfferEur - minOfferEur + 1)) + minOfferEur;
        offerInput.value = window.formatProposalOfferValue(randomOffer);
    }

    // Apply user-provided defaults when available
    const authorInput = document.getElementById('proposalAuthor');
    if (authorInput && overridePrefill.author) {
        authorInput.value = overridePrefill.author;
    }

    // Pre-fill the author field and avatar with the current user
    populateProposalAuthorUI();

    // Pre-fill name and description with default text (facets already set it for a chosen goal;
    // this only fills the empty do-nothing default).
    updateProposalNameAndDescription(DEFAULT_PROPOSAL_TYPE);

    const nameInputEl = document.getElementById('proposalName');
    const descriptionInputEl = document.getElementById('proposalDescription');
    if (nameInputEl && overridePrefill.name) {
        nameInputEl.value = overridePrefill.name;
    }
    if (descriptionInputEl && overridePrefill.description) {
        descriptionInputEl.value = overridePrefill.description;
    }
    if (offerInput && Number.isFinite(overridePrefill.offer)) {
        offerInput.value = window.formatProposalOfferValue ? window.formatProposalOfferValue(overridePrefill.offer) : overridePrefill.offer;
    }

    // Update description when name changes
    const nameInputField = document.getElementById('proposalName');
    const descriptionInputField = document.getElementById('proposalDescription');
    if (nameInputField && descriptionInputField) {
        nameInputField.addEventListener('input', () => {
            const proposalType = document.getElementById('proposalType')?.value || DEFAULT_PROPOSAL_TYPE;
            const proposalName = nameInputField.value.trim() || generateDefaultProposalName(proposalType);
            descriptionInputField.value = generateDefaultProposalDescription(proposalType, proposalName);
        });
    }

    attachProposalCurrencyHandlers();

    // Focus the default Land use radio (not a text input) to avoid triggering mobile keyboards
    const defaultLandUseRadio = modal.querySelector('input[name="proposalLandUse"]:checked')
        || modal.querySelector('input[name="proposalLandUse"]');
    if (defaultLandUseRadio) {
        defaultLandUseRadio.focus();
    }

    updateCreateProposalSubmitState();

    // Show similar proposals for the selected parcel set
    const similarSection = document.getElementById('proposalSimilarSection');
    const similarList = document.getElementById('proposalSimilarList');
    if (similarSection && similarList && typeof proposalStorage !== 'undefined' && typeof proposalStorage.getSimilarProposalsByParcelIds === 'function') {
        const similarProposals = proposalStorage.getSimilarProposalsByParcelIds(parcelIds);
        if (similarProposals && similarProposals.length > 0) {
            similarSection.style.display = '';
            const itemsHtml = similarProposals.map(p => {
                const proposalId = p.proposalId || '';
                const title = typeof escapeHtml === 'function' ? escapeHtml(p.title || similarUnknownTitle) : (p.title || similarUnknownTitle);
                const author = typeof escapeHtml === 'function' ? escapeHtml(p.author || similarUnknownAuthor) : (p.author || similarUnknownAuthor);
                const goalKey = resolveProposalGoalKey ? resolveProposalGoalKey(p, null) : (p.goal || p.type || 'other');
                const typeLabel = typeof formatProposalTypeLabel === 'function'
                    ? formatProposalTypeLabel(goalKey)
                    : (goalKey || '');
                const createdDate = p.createdAt ? new Date(p.createdAt).toLocaleDateString() : '';
                return `
                    <div class="proposal-similar-item" data-proposal-id="${proposalId}" style="display:flex; flex-direction:column; gap:2px; padding:8px; border:1px solid #ddd; border-radius:6px; cursor:pointer; background:#fafafa;">
                        <span style="font-weight:600;">${title}</span>
                        <span style="font-size:12px; color:#555;">${author}${createdDate ? ` • ${createdDate}` : ''}</span>
                        <span style="font-size:12px; color:#555;">${typeLabel}</span>
                    </div>
                `;
            }).join('');
            similarList.innerHTML = itemsHtml;
            similarList.querySelectorAll('.proposal-similar-item').forEach(item => {
                const proposalId = item.getAttribute('data-proposal-id');
                item.addEventListener('click', () => {
                    if (proposalId && typeof openProposalFromList === 'function') {
                        openProposalFromList(proposalId, {
                            closeProposalList: false,
                            closeParcelInfo: false,
                            collapseSidebar: false
                        });
                    }
                });
            });
        } else {
            similarSection.style.display = 'none';
        }
    }
}

// Close proposal dialog
function closeProposalDialog() {
    clearProposalBalanceWatcher();
    const modal = document.querySelector('.create-proposal-modal');
    if (modal) {
        modal.remove();
    }
    currentProposalTool = null;
    proposalModalScreenshotDataUrl = null; // Clear stored screenshot
    proposalModalScreenshotPromise = null;

    // If this was a road/track proposal, the multi-parcel selection was seeded just for the modal;
    // disable it now so we don't leave the UI stuck in multi-select mode.
    const wasRoadTrackProposal = !!pendingRoadDrawingProposal || !!(typeof window !== 'undefined' && window.pendingRoadDrawingProposal);
    if (wasRoadTrackProposal && typeof multiParcelSelection !== 'undefined' && multiParcelSelection && multiParcelSelection.isActive) {
        try {
            if (typeof multiParcelSelection.clearSelection === 'function') {
                multiParcelSelection.clearSelection();
            }
            multiParcelSelection.isActive = false;
            if (typeof multiParcelSelection.updateUI === 'function') {
                multiParcelSelection.updateUI();
            }
            if (typeof syncMultiSelectCheckboxes === 'function') {
                syncMultiSelectCheckboxes(false);
            }
        } catch (_) { /* ignore */ }
    }

    proposalDialogOverrides = null;
    pendingRoadDrawingProposal = null;
    if (typeof window !== 'undefined') {
        window.pendingRoadDrawingProposal = null;
    }
    setProposalModalDimmed(false);
    if (typeof setPendingBuildingProposalContext === 'function') {
        setPendingBuildingProposalContext(null);
    } else if (typeof window !== 'undefined') {
        window.pendingBuildingProposalContext = null;
        window.pendingBuildingFromBlockify = null;
    }
    if (typeof window !== 'undefined') {
        window.pendingReparcellizationPlan = null;
    }
    if (typeof clearSingleBuildingPendingState === 'function') {
        clearSingleBuildingPendingState();
    } else if (typeof window !== 'undefined') {
        window.pendingSingleBuildingFeature = null;
        window.pendingSingleBuildingFeatures = null;
    }
}

// Toggle expiry time input when checkbox is changed

// Toggle decay inputs when checkbox is changed

// Toggle deposit input when checkbox is changed

// Calculate current offer amount considering decay

// Get decay progress (0 to 1) for visual representation

// Parse expiry time string (format: XXh:YYm:ZZs) and return milliseconds

// Check if a proposal has expired based on its expiresAt timestamp

// Update proposal status to Expired if it has expired

// Store the interval ID for the expiry countdown so we can clear it

// Format remaining time as XXh:YYm:ZZs
function formatRemainingTime(ms) {
    if (ms <= 0) return '00h:00m:00s';
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return `${String(hours).padStart(2, '0')}h:${String(minutes).padStart(2, '0')}m:${String(seconds).padStart(2, '0')}s`;
}

// Initialize expiry countdown timer in the proposal details panel

// Interval for decay countdown

// Initialize decay countdown animation for the offer bar

// Utilities for random names
function _randomFrom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function generateStructureName(kind) {
    const adj = ['Green', 'Sunny', 'Central', 'Liberty', 'Unity', 'Riverside', 'Grand', 'Heritage', 'Harmony', 'Oak'];
    const nounPark = ['Park', 'Garden', 'Commons', 'Meadow', 'Grove'];
    const nounSquare = ['Square', 'Plaza', 'Forum', 'Court', 'Terrace'];
    const nounLake = ['Lake', 'Lagoon', 'Harbor', 'Bay', 'Pond'];
    const noun = kind === 'square' ? nounSquare : (kind === 'lake' ? nounLake : nounPark);
    return `${_randomFrom(adj)} ${_randomFrom(noun)}`;
}

// Show proposal dialog for structures (Park/Square) with provided parcelIds and geometry
function showStructureProposalDialog({ kind, parcelIds, geometry, blockName }) {
    const t = getProposalI18nHelper();
    const parcelLookupError = t('modal.createProposal.errors.couldNotDetermineParcels', 'Could not determine parcels for this block.');
    const parcelsNotContiguous = t('modal.createProposal.errors.parcelsNotContiguous', 'Parcels not contiguous');
    const unknownParcelLabel = t('modal.createProposal.unknownParcel', 'Unknown');
    const validKind = (kind === 'park' || kind === 'square' || kind === 'lake') ? kind : 'square';
    const selectedParcels = (parcelIds || []).map(id => multiParcelSelection.findParcelById(id)).filter(Boolean);
    if (selectedParcels.length === 0) {
        updateStatus(parcelLookupError);
        return;
    }

    if (validKind === 'lake') {
        const contiguity = (typeof areParcelsContiguous === 'function') ? areParcelsContiguous(selectedParcels) : { contiguous: true };
        if (!contiguity.contiguous) {
            if (typeof showProposalAlertMessage === 'function') {
                showProposalAlertMessage('parcels_not_contiguous', parcelsNotContiguous);
            } else {
                updateStatus(parcelsNotContiguous);
            }
            return;
        }
    }

    const totalArea = selectedParcels.reduce((sum, layer) => sum + (layer?.feature?.properties?.calculatedArea || 0), 0);
    const parcelLabel = t('modal.roadWidth.proposalList.typeLabels.parcel', 'Parcel');
    const parcelListHTML = selectedParcels.map(parcel => {
        const number = getParcelDisplayNumberFromProperties(parcel?.feature?.properties, unknownParcelLabel) || unknownParcelLabel;
        const area = Math.round(parcel.feature?.properties?.calculatedArea || 0).toLocaleString('hr-HR');
        return `<div class="proposal-parcel-item"><span class="parcel-number">${parcelLabel} ${number}</span> <span class="parcel-area">(${area} m²)</span></div>`;
    }).join('');

    // Shared inline style for helper text in the options column
    const optionHelperStyle = 'color:#6b7280; font-size:12px; line-height:1.3;';

    const modalTitle = validKind === 'park'
        ? t('modal.createProposal.titlePark', 'Create Park Proposal')
        : validKind === 'square'
            ? t('modal.createProposal.titleSquare', 'Create Square Proposal')
            : t('modal.createProposal.titleLake', 'Create Lake Proposal');
    const closeAriaLabel = t('modal.createProposal.closeAria', 'Close proposal dialog');
    const authorLabel = t('modal.createProposal.authorLabel', 'Author:');
    const authorPlaceholder = t('modal.createProposal.authorPlaceholder', 'Your name');
    const authorAvatarAlt = t('modal.createProposal.authorAvatarAlt', 'Author avatar');
    const nameLabel = t('modal.createProposal.nameLabel', 'Name:');
    const typeLabel = t('modal.createProposal.typeLabel', 'Type:');
    const typeDisplay = validKind === 'park'
        ? t('modal.createProposal.typePark', 'Park')
        : validKind === 'square'
            ? t('modal.createProposal.typeSquare', 'Square')
            : t('modal.createProposal.typeLake', 'Lake');
    const namePlaceholder = t('modal.createProposal.namePlaceholder', 'Name your {{kind}}', { kind: typeDisplay.toLowerCase() });
    const descriptionLabel = t('modal.createProposal.descriptionLabel', 'Description:');
    const descriptionPlaceholder = t('modal.createProposal.descriptionPlaceholderStructure', 'Describe your {{kind}}...', { kind: typeDisplay.toLowerCase() });
    const offerLabel = t('modal.createProposal.offerLabel', 'Offer:');
    const offerPlaceholder = t('modal.createProposal.offerPlaceholder', '0');
    const optionsLabel = t('modal.createProposal.optionsLabel', 'Options:');
    const expireAfterLabel = t('modal.createProposal.options.expireAfter', 'Expire after');
    const expiryPlaceholder = t('modal.createProposal.options.expiryPlaceholder', '00h:05m:00s');
    const decayLabel = t('modal.createProposal.options.decay', 'Offer Decay');
    const decayHelperText = t('modal.createProposal.options.decayHelper', 'Offer amount will decrease with time to entice acceptance.');
    const decayPercentSuffix = t('modal.createProposal.options.decayPercentSuffix', '% over');
    const decayTimePlaceholder = t('modal.createProposal.options.decayTimePlaceholder', '00h:05m:00s');
    const depositLabel = t('modal.createProposal.options.deposit', 'Deposit');
    const depositHelperText = t('modal.createProposal.options.depositHelper', '% of offer');
    const areaProportionalText = t('modal.createProposal.options.areaProportional', 'Payouts are proportional to parcel area');
    const summaryParcelsLabel = t('modal.createProposal.summary.parcels', 'Parcels Selected:');
    const summaryAreaLabel = t('modal.createProposal.summary.area', 'Total Area:');
    const summarySelectedLabel = t('modal.createProposal.summary.selected', 'Selected Parcels:');
    const lensTooltip = t('modal.createProposal.lensTooltip', 'Open lens modal');
    const submitLabel = t('modal.createProposal.submit', 'Create Proposal');

    const modal = document.createElement('div');
    modal.className = 'create-proposal-modal';
    const defaultName = generateStructureName(validKind);
    modal.innerHTML = `
        <div class="proposal-modal-content">
            <div class="proposal-modal-header">
                <h2>${modalTitle}</h2>
                <button type="button" class="proposal-modal-close close-circle-btn close-circle-btn--lg" aria-label="${closeAriaLabel}" onclick="closeProposalDialog()">&times;</button>
            </div>
            <div class="proposal-modal-body">
                <div class="form-group">
                    <div class="proposal-author-row">
                        <label for="proposalAuthor">${authorLabel}</label>
                        <img id="proposalAuthorAvatar" class="proposal-author-avatar" alt="${authorAvatarAlt}" />
                        <input type="text" id="proposalAuthor" placeholder="${authorPlaceholder}" disabled>
                    </div>
                </div>
                <div class="form-group">
                    <label for="proposalName">${nameLabel}</label>
                    <input type="text" id="proposalName" value="${defaultName}" placeholder="${namePlaceholder}">
                </div>
                <div class="form-group">
                    <label for="proposalType">${typeLabel}</label>
                    <input type="text" id="proposalType" value="${typeDisplay}" disabled>
                </div>
                <div class="form-group">
                    <label for="proposalDescription">${descriptionLabel}</label>
                    <textarea id="proposalDescription" class="proposal-description-input" rows="2" placeholder="${descriptionPlaceholder}"></textarea>
                </div>
                <div class="form-group">
                    <label for="proposalOffer">${offerLabel}</label>
                    <div class="proposal-offer-row" style="display:flex; gap:8px; align-items:center;">
                        <input type="text" id="proposalOffer" placeholder="${offerPlaceholder}" inputmode="numeric" style="flex:1 1 auto;" oninput="handleProposalOfferInput(this)">
                        <select id="proposalCurrency" style="flex:0 0 112px; max-width:112px; min-width:112px;">
                            <option value="EUR">EUR</option>
                            <option value="USD">USD</option>
                            <option value="ETH">ETH</option>
                            <option value="ARS">ARS</option>
                            <option value="USDC">USDC</option>
                            <option value="USDT" selected>USDT</option>
                        </select>
                    </div>
                </div>
                <div class="form-group proposal-options-section">
                    <label>${optionsLabel}</label>
                    <div class="proposal-option-row" style="display:grid; grid-template-columns: 1fr 1fr; align-items:center; gap:8px;">
                        <div style="display:flex; align-items:center; gap:6px;">
                            <input type="checkbox" id="proposalExpireCheckbox" onchange="toggleExpiryInput()">
                            <label for="proposalExpireCheckbox" style="margin:0; cursor:pointer;">${expireAfterLabel}</label>
                        </div>
                        <div>
                            <input type="text" id="proposalExpiryTime" value="${expiryPlaceholder}" placeholder="${expiryPlaceholder}" style="width:100%; text-align:center;" disabled>
                        </div>
                    </div>
                    <div class="proposal-option-row" style="display:flex; align-items:center; gap:8px; margin-top:6px;">
                        <div style="flex:1; display:flex; align-items:center; gap:6px;">
                            <input type="checkbox" id="proposalDecayCheckbox" onchange="toggleDecayInput()">
                            <label for="proposalDecayCheckbox" style="margin:0; cursor:pointer;">${decayLabel}</label>
                        </div>
                        <div style="flex:1; ${optionHelperStyle}">${decayHelperText}</div>
                    </div>
                    <div class="proposal-option-row proposal-decay-inputs" style="display:grid; grid-template-columns: 1fr 1fr; align-items:center; gap:8px; margin-top:4px;">
                        <div style="display:flex; align-items:center; gap:4px; padding-left:28px;">
                            <input type="text" id="proposalDecayPercent" value="50" pattern="[0-9]*" inputmode="numeric" style="width:40px; text-align:center;" disabled>
                            <span style="color:#666;">${decayPercentSuffix}</span>
                        </div>
                        <div>
                            <input type="text" id="proposalDecayTime" value="${decayTimePlaceholder}" placeholder="${decayTimePlaceholder}" style="width:100%; text-align:center;" disabled>
                        </div>
                    </div>
                    <div class="proposal-option-row" style="display:flex; align-items:center; gap:8px; margin-top:6px;">
                        <div style="flex:1; display:flex; align-items:center; gap:6px;">
                            <input type="checkbox" id="proposalDepositCheckbox" onchange="toggleDepositInput()">
                            <label for="proposalDepositCheckbox" style="margin:0; cursor:pointer;">${depositLabel}</label>
                        </div>
                        <div style="flex:1; display:flex; align-items:center; gap:4px;">
                            <input type="text" id="proposalDepositPercent" value="100" pattern="[0-9]*" inputmode="numeric" style="width:55px; text-align:center;" disabled>
                            <span style="color:#666;">${depositHelperText}</span>
                        </div>
                    </div>
                    <div class="proposal-option-row" style="grid-column: 1 / span 2; display:flex; align-items:center; gap:8px; margin-top:8px;">
                        <div style="display:flex; align-items:center; gap:6px;">
                            <input type="checkbox" id="proposalAreaProportionalCheckbox" checked disabled>
                            <label for="proposalAreaProportionalCheckbox" style="margin:0;">${areaProportionalText}</label>
                        </div>
                    </div>
                </div>
                <div class="proposal-summary">
                    <div class="summary-stats">
                        <p><strong>${summaryParcelsLabel}</strong> ${selectedParcels.length}</p>
                        <p><strong>${summaryAreaLabel}</strong> ${Math.round(totalArea).toLocaleString('hr-HR')} m²</p>
                    </div>
                    <div class="parcel-list">
                        <h4>${summarySelectedLabel}</h4>
                        ${parcelListHTML}
                    </div>
                </div>
                <div class="proposal-actions-block">
                    <div class="lens-inline-control lens-footer-control lens-footer-row">
                        <button type="button" class="lens-pattern-button" data-lens-pattern onclick="showLensModal()" title="${lensTooltip}">👓</button>
                    </div>
                    <button type="button" class="btn btn-proposal" id="create-structure-proposal-btn">${submitLabel}</button>
                </div>
            </div>
        </div>`;

    document.body.appendChild(modal);
    if (typeof refreshLensPatternPreviews === 'function') {
        refreshLensPatternPreviews();
    }

    // Prefill author and random offer
    populateProposalAuthorUI();

    // Pre-fill description with default text
    const proposalTypeName = typeDisplay;
    updateProposalDescription(proposalTypeName);
    const offerInput = document.getElementById('proposalOffer');
    if (offerInput) {
        const minOfferEur = 1000, maxOfferEur = 100000;
        offerInput.value = window.formatProposalOfferValue(Math.floor(Math.random() * (maxOfferEur - minOfferEur + 1)) + minOfferEur);
    }
    attachProposalCurrencyHandlers();
    document.getElementById('proposalName').focus();

    const confirmButton = document.getElementById('create-structure-proposal-btn');
    if (confirmButton) {
        confirmButton.addEventListener('click', () => {
            createStructureProposalFromDialog(
                validKind,
                Array.isArray(parcelIds) ? parcelIds : [],
                geometry || null,
                blockName || ''
            );
        });
    }
}

const LAKE_GRAPHICS_VERSION = 3;
const LAKE_SHORE_TARGET_RATIO = 0.2;




// Expose helpers
window.showStructureProposalDialog = showStructureProposalDialog;
window.handleProposalToolButton = handleProposalToolButton;
window.selectLandUse = selectLandUse;
window.onProposalLandUseChange = onProposalLandUseChange;
window.onProposalParcelsChange = onProposalParcelsChange;
window.onProposalOwnershipChange = onProposalOwnershipChange;
window.onProposalRecipientScopeChange = onProposalRecipientScopeChange;
window.setProposalType = setProposalType;
window.setProposalMainType = setProposalMainType;
window.setProposalAcquisitionMode = setProposalAcquisitionMode;
window.setProposalBoundaryMode = setProposalBoundaryMode;
window.handleUrbanRuleMainTypeClick = handleUrbanRuleMainTypeClick;
window.handleUrbanRuleTypologyClick = handleUrbanRuleTypologyClick;
window.handleReparcellizationAlgorithmClick = handleReparcellizationAlgorithmClick;
window.applyContiguityConstraints = applyContiguityConstraints;
window.populateProposalAuthorUI = populateProposalAuthorUI;
window.getProposalAuthorValue = getProposalAuthorValue;
window.getSelectedProposalTool = getSelectedProposalTool;
window.buildGeometryFromParcels = buildGeometryFromParcels;
window.getCurrentParcelSelectionContext = getCurrentParcelSelectionContext;

document.addEventListener('blockifyModalOpened', () => setProposalModalDimmed(true));
document.addEventListener('blockifyModalClosed', () => setProposalModalDimmed(false));
document.addEventListener('urbanRuleModalOpened', () => setProposalModalDimmed(true));
document.addEventListener('urbanRuleModalClosed', () => setProposalModalDimmed(false));

/**
 * Find the visible descendant proposal by traversing down from a proposal
 * until we find one whose child parcels are actually visible on the map
 * (i.e., they have no further descendant proposal markers).
 * 
 * @param {string} proposalId - The starting proposal ID
 * @returns {string|null} - The proposal ID whose children are visible, or the original if none found
 */

/**
 * Calculate and return bounds for the visible descendant of a proposal.
 * Simply uses the child parcels of the visible descendant - no recursive collection.
 * @param {string} proposalId - The proposal ID to calculate bounds for
 * @returns {L.LatLngBounds|null} Leaflet bounds or null
 */



// Check if parcels have NFTs on Solana

// Check if parcels have NFTs on-chain

// Show modal for wallet not connected

// Show modal for missing parcel NFTs
async function showMissingParcelsModal(missingParcels, chainName) {
    return new Promise((resolve) => {
        const t = getProposalI18nHelper();
        setProposalModalDimmed(true);

        const overlay = document.createElement('div');
        overlay.className = 'cb-confirm-overlay';
        // Must sit above create-proposal-modal (z-index 11000)
        overlay.style.position = 'fixed';
        overlay.style.inset = '0';
        overlay.style.zIndex = '50000';
        overlay.style.background = 'rgba(15, 23, 42, 0.45)';
        overlay.style.display = 'flex';
        overlay.style.alignItems = 'center';
        overlay.style.justifyContent = 'center';

        const dialog = document.createElement('div');
        dialog.className = 'cb-confirm-dialog';
        dialog.style.maxWidth = '600px';
        dialog.style.position = 'relative';
        dialog.style.zIndex = '50001';

        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'close-circle-btn close-circle-btn--lg';
        closeBtn.setAttribute('aria-label', t('modal.createProposal.walletNotConnected.cancel', 'Cancel'));
        closeBtn.innerHTML = '&times;';
        closeBtn.style.position = 'absolute';
        closeBtn.style.top = '8px';
        closeBtn.style.right = '8px';

        const message = document.createElement('div');
        message.className = 'cb-confirm-message';
        message.style.marginBottom = '20px';

        const chainDisplay = chainName || t('modal.createProposal.missingParcels.defaultChain', 'the blockchain');
        const overflowLabel = missingParcels.length > 10
            ? t('modal.createProposal.missingParcels.more', ', and {{count}} more...', {
                count: missingParcels.length - 10
            })
            : '';
        const parcelList = missingParcels.length > 10
            ? `${missingParcels.slice(0, 10).join(', ')}${overflowLabel}`
            : missingParcels.join(', ');
        const messageKey = missingParcels.length === 1 ? 'messageSingle' : 'messagePlural';
        const introMessage = t(
            `modal.createProposal.missingParcels.${messageKey}`,
            missingParcels.length === 1
                ? 'The following parcel is not represented as an NFT on <strong>{{chain}}</strong>, so a proposal for it cannot be minted on-chain:'
                : 'The following parcels are not represented as NFTs on <strong>{{chain}}</strong>, so a proposal for them cannot be minted on-chain:',
            { chain: chainDisplay }
        );
        const proceedPrompt = t(
            'modal.createProposal.missingParcels.proceedQuestion',
            'Proceed to create an in-memory proposal?'
        );
        const explainerText = t(
            'modal.createProposal.missingParcels.explainer',
            "You can create an in-memory proposal or proceed to mint the prerequisite parcels. Minting does not confer ownership, it only creates an on-chain representation. Anyone can mint any parcel to onboard it onto the platform. You can also mint them from the Parcel Info panel's Tools tab."
        );

        message.innerHTML = `
            <p style="margin-bottom: 12px;">${introMessage}</p>
            <div style="background: #f5f5f5; padding: 12px; border-radius: 6px; margin: 12px 0; max-height: 200px; overflow-y: auto; font-family: monospace; font-size: 12px;">
                ${parcelList}
            </div>
            <p style="margin-top: 12px; margin-bottom: 12px; padding: 12px; background: #e3f2fd; border-left: 4px solid #2196f3; border-radius: 4px; color: #1565c0;">
                ${explainerText}
            </p>
            <p style="margin-top: 12px;">${proceedPrompt}</p>
        `;

        const buttons = document.createElement('div');
        buttons.className = 'cb-confirm-buttons';
        buttons.style.display = 'flex';
        buttons.style.gap = '10px';
        buttons.style.justifyContent = 'flex-end';

        const createInMemoryBtn = document.createElement('button');
        createInMemoryBtn.type = 'button';
        createInMemoryBtn.className = 'btn btn-secondary';
        createInMemoryBtn.textContent = t('modal.createProposal.missingParcels.createInMemory', 'Create in memory');

        const mintPrereqBtn = document.createElement('button');
        mintPrereqBtn.type = 'button';
        mintPrereqBtn.className = 'btn btn-action';
        mintPrereqBtn.textContent = t('modal.createProposal.missingParcels.mintPrerequisites', 'Mint the prerequisites');

        function cleanup(result) {
            if (overlay && overlay.parentNode) {
                overlay.parentNode.removeChild(overlay);
            }
            setProposalModalDimmed(false);
            resolve(result);
        }

        createInMemoryBtn.addEventListener('click', () => cleanup('memory'));
        mintPrereqBtn.addEventListener('click', () => cleanup('mint'));
        closeBtn.addEventListener('click', () => cleanup('cancel'));
        overlay.addEventListener('click', (event) => {
            if (event.target === overlay) {
                cleanup('cancel');
            }
        });

        buttons.appendChild(createInMemoryBtn);
        buttons.appendChild(mintPrereqBtn);
        dialog.appendChild(closeBtn);
        dialog.appendChild(message);
        dialog.appendChild(buttons);
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);
    });
}

// Show modal when on-chain minting fails and ask whether to proceed in-memory

// Create proposal from dialog

const proposalListState = {
    activeTab: 'active',
    source: 'local',
    filterType: 'all',
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
    lastFetchedAt: 0
};


function normalizeCityCodeForApi(code) {
    const raw = (code || '').toString().trim().toLowerCase();
    if (!raw) return 'city';
    if (raw === 'zg' || raw === 'zgb') return 'zagreb';
    if (raw === 'bg') return 'belgrade';
    if (raw === 'ba' || raw === 'caba' || raw === 'ar-ba') return 'buenos_aires';
    return raw;
}







async function handleProposalDownloadClick(event) {
    event.preventDefault();
    event.stopPropagation();

    const button = event.currentTarget;
    if (!button) return;

    const proposalId = button.getAttribute('data-server-id') || button.getAttribute('data-proposal-id');
    if (!proposalId) return;

    const cardKey = button.getAttribute('data-proposal-id') || proposalId;

    const t = getProposalI18nHelper();
    const originalLabel = button.textContent || '';
    button.disabled = true;
    button.textContent = `${originalLabel}…`;

    try {
        const proposal = await fetchServerProposalById(proposalId, resolveCurrentCityCode());
        // preserveStatus: false → resets `Applied` to `Active` (Executed stays Executed) and nested
        // road/building/structure/reparcel statuses to `unapplied`. Prevents the parcelDataLoaded
        // auto-apply from immediately re-applying a freshly downloaded server proposal.
        const imported = proposalStorage.importProposal(proposal, { overwrite: true, preserveStatus: false });
        if (!imported) {
            throw new Error('Unable to store proposal locally');
        }
        updateShowProposalsButton();

        // Surgical DOM update — no full rerender, so the user's scroll position and selection stay
        // exactly where they are. We only update what actually changed for this card:
        //   - the Download button becomes "Downloaded" disabled
        //   - the thumbnail upgrades from placeholder to the local image (if any)
        //   - the source-toggle Local count goes up by one
        const downloadedLabel = t('modal.roadWidth.proposalList.actions.downloaded', 'Downloaded');
        button.textContent = downloadedLabel;
        button.disabled = true;

        const thumbImage = imported.screenshotUrl
            || (imported.onchain && imported.onchain.imageUrl)
            || (imported.onchainData && imported.onchainData.imageUrl)
            || imported.screenshotDataUrl
            || null;
        if (thumbImage) {
            try {
                document.dispatchEvent(new CustomEvent('proposalScreenshotUpdated', {
                    detail: {
                        proposalId: cardKey,
                        screenshotUrl: imported.screenshotUrl
                            || (imported.onchain && imported.onchain.imageUrl)
                            || (imported.onchainData && imported.onchainData.imageUrl)
                            || null,
                        screenshotDataUrl: imported.screenshotDataUrl || null
                    }
                }));
            } catch (_) { }
        }

        const localToggleBtn = document.querySelector('.proposal-source-btn[data-source="local"]');
        if (localToggleBtn && typeof proposalStorage.getAllProposals === 'function') {
            const newLocalCount = proposalStorage.getAllProposals().length;
            const localBaseLabel = t('modal.roadWidth.proposalList.sources.local', 'Local');
            localToggleBtn.textContent = `${localBaseLabel} (${newLocalCount})`;
        }
    } catch (error) {
        console.error('Failed to download proposal', proposalId, error);
        button.disabled = false;
        button.textContent = originalLabel;
        const message = t('modal.roadWidth.proposalList.downloadError', 'Failed to download proposal');
        try {
            updateStatus(message);
        } catch (_) {
            alert(message);
        }
    }
}


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
    { value: 'urban-rule', label: 'Urban rule' },
    { value: 'reparcellization', label: 'Reparcellization' },
    { value: 'decide-later', label: 'Decide later' },
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
    'urban-rule': 'urbanRule',
    reparcellization: 'reparcellization',
    'decide-later': 'decideLater',
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
    'urban-rule': 'Urban rule',
    reparcellization: 'Reparcellization',
    'decide-later': 'Decide later',
    parcelBased: 'Parcel-based',
    other: 'Other'
};

function getLocalizedProposalSortOptions() {
    const t = getProposalI18nHelper();
    return PROPOSAL_SORT_OPTIONS.map(option => {
        const i18nKey = PROPOSAL_SORT_I18N_KEYS[option.value] || option.value;
        return {
            ...option,
            label: t(`modal.roadWidth.proposalList.sort.${i18nKey}`, option.label)
        };
    });
}

function getLocalizedProposalGoalFilters() {
    const t = getProposalI18nHelper();
    return PROPOSAL_GOAL_FILTERS.map(option => {
        const i18nKey = PROPOSAL_GOAL_FILTER_I18N_KEYS[option.value] || option.value;
        return {
            ...option,
            label: t(`modal.roadWidth.proposalList.filters.goals.${i18nKey}`, option.label)
        };
    });
}

function getProposalGoalLabel(goalKey) {
    const t = getProposalI18nHelper();
    const normalizedKey = normalizeProposalGoalKey(goalKey) || 'other';
    const fallback = PROPOSAL_GOAL_LABELS[normalizedKey]
        || (normalizedKey ? normalizedKey.charAt(0).toUpperCase() + normalizedKey.slice(1) : '');
    return t(`modal.roadWidth.proposalList.goalLabels.${normalizedKey}`, fallback);
}

// Backwards compatibility for existing helpers
function getProposalTypeLabel(typeKey) {
    return getProposalGoalLabel(typeKey);
}


if (typeof window !== 'undefined') {
    window.resolveStructureProposal = resolveStructureProposal;
}



function formatProposalTypeLabel(typeKey) {
    return getProposalTypeLabel(typeKey);
}

function isGenericProposalDisplayText(value) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text) return true;
    const lower = text.toLowerCase();
    if (lower === 'proposal' || lower === 'minted proposal from blockchain' || lower === 'minted proposal from solana') {
        return true;
    }
    return /^proposal(?:\s+#?[a-z0-9._:-]+)?$/i.test(text);
}







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




if (typeof window !== 'undefined') {
    window.getProposalLifecycleKey = getProposalLifecycleKey;
    window.getProposalLifecycleLabel = getProposalLifecycleLabel;
    window.getProposalLifecycleClass = getProposalLifecycleClass;
    window.getParcelAreaById = getParcelAreaById;
}




function formatAreaMetric(area) {
    if (!Number.isFinite(area) || area <= 0) {
        return '—';
    }
    return `${Math.round(area).toLocaleString('hr-HR')} m²`;
}





// Build the small thumbnail markup shown on each proposal card. Returns '' when the proposal's goal
// has no meaningful map screenshot (urban-rule, ownership-transfer, decide-later, etc.).

if (typeof window !== 'undefined') {
    window.buildProposalThumbHtml = buildProposalThumbHtml;
}



// Debounce filter input renders so typing doesn't drop input focus mid-keystroke.
const PROPOSAL_LIST_FILTER_INPUT_DEBOUNCE_MS = 280;
function scheduleDebouncedProposalListModalRender() {
    clearProposalListFilterInputDebounce();
    _proposalListFilterInputDebounceTimer = setTimeout(() => {
        _proposalListFilterInputDebounceTimer = null;
        renderProposalListModal();
    }, PROPOSAL_LIST_FILTER_INPUT_DEBOUNCE_MS);
}

function renderProposalListModal() {
    // A full render supersedes any pending debounced re-render from search/author typing.
    clearProposalListFilterInputDebounce();
    // If i18n is present but not yet ready, wait for it before rendering to avoid key flicker
    try {
        const api = (typeof window !== 'undefined') ? window.i18n : null;
        if (api && api.ready && typeof api.ready.then === 'function' && !api.__proposalListWaited) {
            api.__proposalListWaited = true;
            return api.ready.then(() => renderProposalListModal()).catch(() => renderProposalListModal());
        }
    } catch (_) { }

    let modal = document.querySelector('.proposal-list-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.className = 'proposal-list-modal';
        document.body.appendChild(modal);
    }

    // Ensure proposal list translations are loaded from JSON; if newly hydrated, re-render once.
    try {
        const api = (typeof window !== 'undefined') ? window.i18n : null;
        const currentLang = api && typeof api.getLanguage === 'function' ? api.getLanguage() : null;
        ensureProposalListTranslations(currentLang).then(hydrated => {
            if (hydrated) {
                // Avoid infinite loop: only re-render on the first hydration per language
                renderProposalListModal();
            }
        });
    } catch (_) { }

    const t = getProposalI18nHelper();

    const modalStrings = {
        title: t('modal.roadWidth.proposalList.title', 'Proposals'),
        closeAria: t('modal.roadWidth.proposalList.closeAria', 'Close proposals list'),
        tabs: {
            active: t('modal.roadWidth.proposalList.tabs.active', 'Active'),
            executed: t('modal.roadWidth.proposalList.tabs.executed', 'Executed')
        },
        filters: {
            goal: t('modal.roadWidth.proposalList.filters.goal', 'Goal'),
            author: t('modal.roadWidth.proposalList.filters.author', 'Author'),
            search: t('modal.roadWidth.proposalList.filters.search', 'Search'),
            sort: t('modal.roadWidth.proposalList.filters.sort', 'Sort by'),
            authorPlaceholder: t('modal.roadWidth.proposalList.filters.authorPlaceholder', 'All authors'),
            searchPlaceholder: t('modal.roadWidth.proposalList.filters.searchPlaceholder', 'Search title or author'),
            reset: t('modal.roadWidth.proposalList.filters.reset', 'Reset'),
            resetTooltip: t('modal.roadWidth.proposalList.filters.resetTooltip', 'Reset filters')
        },
        sources: {
            local: t('modal.roadWidth.proposalList.sources.local', 'Local'),
            server: t('modal.roadWidth.proposalList.sources.server', 'Server')
        },
        loadingServer: t('modal.roadWidth.proposalList.loadingServer', 'Loading server proposals...'),
        serverError: t('modal.roadWidth.proposalList.serverError', 'Failed to load server proposals.'),
        retry: t('modal.roadWidth.proposalList.retry', 'Retry'),
        downloadError: t('modal.roadWidth.proposalList.downloadError', 'Failed to download proposal')
    };

    const goalOptions = getLocalizedProposalGoalFilters();
    const sortOptions = getLocalizedProposalSortOptions();

    const scrollPositions = {
        active: 0,
        executed: 0
    };

    const existingActiveTab = modal.querySelector('#active-proposals-tab');
    if (existingActiveTab) {
        scrollPositions.active = existingActiveTab.scrollTop;
    }

    const existingExecutedTab = modal.querySelector('#executed-proposals-tab');
    if (existingExecutedTab) {
        scrollPositions.executed = existingExecutedTab.scrollTop;
    }

    const source = proposalListState.source || 'local';
    const cityCode = resolveCurrentCityCode();
    const allProposals = proposalStorage.getAllProposals();

    // Check and update expiry status for all proposals
    allProposals.forEach(proposal => {
        checkAndUpdateProposalExpiry(proposal);
    });

    const buildDatasets = (augmentedList) => {
        const active = augmentedList.filter(entry => (entry.proposal.status || '').toLowerCase() !== 'executed');
        const executed = augmentedList.filter(entry => (entry.proposal.status || '').toLowerCase() === 'executed');
        const filteredActive = applyProposalListFilters(active);
        const filteredExecuted = applyProposalListFilters(executed);
        const sortedActive = sortProposalDataset(filteredActive);
        const sortedExecuted = sortProposalDataset(filteredExecuted);
        return {
            augmented: augmentedList,
            active,
            executed,
            filteredActive,
            filteredExecuted,
            sortedActive,
            sortedExecuted
        };
    };

    const localAugmented = allProposals.map(proposal => ({
        proposal,
        metrics: computeProposalMetrics(proposal)
    }));
    const localDatasets = buildDatasets(localAugmented);

    // Server dataset handling
    const normalizedCity = normalizeCityCodeForApi(cityCode);
    if (serverProposalCache.lastCity && serverProposalCache.lastCity !== normalizedCity) {
        resetServerProposalCache(normalizedCity);
    }
    // Always fetch count/summaries once per city so the server tab badge is populated immediately
    const needsFetch = serverProposalCache.lastCity !== normalizedCity || serverProposalCache.count === null;
    if (!serverProposalCache.loading && needsFetch) {
        fetchServerProposalSummaries(normalizedCity);
    } else if (source === 'server') {
        ensureServerProposals(normalizedCity);
    }

    const serverAugmented = (serverProposalCache.proposals || []).map(proposal => ({
        proposal,
        metrics: computeProposalMetrics(proposal)
    }));
    const serverDatasets = buildDatasets(serverAugmented);

    const chosen = source === 'server' ? serverDatasets : localDatasets;

    const selectedId = proposalListState.selectedId;
    if (selectedId) {
        const isSelectedVisible = chosen.sortedActive.some(entry => getProposalKey(entry.proposal) === selectedId)
            || chosen.sortedExecuted.some(entry => getProposalKey(entry.proposal) === selectedId);
        if (!isSelectedVisible) {
            proposalListState.selectedId = null;
        }
    }

    const localCount = allProposals.length;
    const serverCount = serverProposalCache.count !== null && serverProposalCache.count !== undefined
        ? serverProposalCache.count
        : (serverDatasets.augmented.length || null);
    const serverCountLabel = serverProposalCache.loading && !serverCount
        ? '…'
        : (serverCount !== null ? serverCount : 0);

    const runtimeGlobal = typeof globalThis !== 'undefined'
        ? globalThis
        : ((typeof window !== 'undefined') ? window : {});

    const hasEvmBlockchainSync = runtimeGlobal.BlockchainSync &&
        typeof runtimeGlobal.BlockchainSync.sync === 'function';
    const hasSolanaBlockchainSync = runtimeGlobal.SolanaBlockchainSync &&
        typeof runtimeGlobal.SolanaBlockchainSync.sync === 'function';
    const syncBlockchainAvailable = hasEvmBlockchainSync || hasSolanaBlockchainSync;

    // Check if wallet is connected (EVM or Solana)
    const isEvmWalletConnected = runtimeGlobal.walletManager &&
        typeof runtimeGlobal.walletManager.getProvider === 'function' &&
        runtimeGlobal.walletManager.getProvider() !== null;
    const isSolanaWalletConnected = hasSolanaBlockchainSync && runtimeGlobal.SolanaBlockchainSync.isWalletConnected();
    const isWalletConnected = isEvmWalletConnected || isSolanaWalletConnected;

    const syncStatus = syncBlockchainAvailable && typeof runtimeGlobal.BlockchainSync.getStatus === 'function'
        ? runtimeGlobal.BlockchainSync.getStatus()
        : { isSyncing: false };

    console.debug('[ProposalListModal] sync controls context', {
        source,
        cityCode: normalizedCity,
        localCount,
        serverCount,
        syncBlockchainAvailable,
        isWalletConnected,
        isSyncing: !!syncStatus.isSyncing
    });

    const syncDisabled = syncStatus.isSyncing || !isWalletConnected;
    const syncTitle = !isWalletConnected
        ? t('modal.roadWidth.proposalList.syncBlockchainNoWallet', 'Connect wallet to sync from blockchain')
        : t('modal.roadWidth.proposalList.syncBlockchain', 'Refresh from blockchain');

    const syncButtonHtml = source === 'local' && syncBlockchainAvailable ? `
        <button
            id="sync-blockchain-proposals-btn"
            class="btn btn-action"
            ${syncDisabled ? 'disabled' : ''}
            data-i18n-key="${!isWalletConnected ? 'modal.roadWidth.proposalList.syncBlockchainNoWallet' : 'modal.roadWidth.proposalList.syncBlockchain'}"
            data-i18n-attr="title"
            title="${escapeHtml(syncTitle)}"
            onclick="handleBlockchainSyncClick(event)">
            <i class="fas fa-sync${syncStatus.isSyncing ? ' fa-spin' : ''}"></i>
            <span data-i18n-key="modal.roadWidth.proposalList.syncBlockchainLabel">${t('modal.roadWidth.proposalList.syncBlockchainLabel', 'Sync')}</span>
        </button>
    ` : '';

    const controlsHtml = `
        <div class="proposal-list-controls">
            <div class="proposal-filter-group">
                <label for="proposal-filter-type" data-i18n-key="modal.roadWidth.proposalList.filters.goal">${escapeHtml(modalStrings.filters.goal)}</label>
                <select id="proposal-filter-type">
                    ${goalOptions.map(option => `
                        <option value="${option.value}" ${option.value === proposalListState.filterType ? 'selected' : ''} data-i18n-key="modal.roadWidth.proposalList.filters.goals.${option.value}">${escapeHtml(option.label)}</option>
                    `).join('')}
                </select>
            </div>
            <div class="proposal-filter-group">
                <label for="proposal-filter-author" data-i18n-key="modal.roadWidth.proposalList.filters.author">${escapeHtml(modalStrings.filters.author)}</label>
                <input type="text" id="proposal-filter-author" placeholder="${escapeHtml(modalStrings.filters.authorPlaceholder)}" data-i18n-key="modal.roadWidth.proposalList.filters.authorPlaceholder" data-i18n-attr="placeholder" value="${escapeHtml(proposalListState.authorFilter)}">
            </div>
            <div class="proposal-filter-group">
                <label for="proposal-filter-search" data-i18n-key="modal.roadWidth.proposalList.filters.search">${escapeHtml(modalStrings.filters.search)}</label>
                <input type="text" id="proposal-filter-search" placeholder="${escapeHtml(modalStrings.filters.searchPlaceholder)}" data-i18n-key="modal.roadWidth.proposalList.filters.searchPlaceholder" data-i18n-attr="placeholder" value="${escapeHtml(proposalListState.searchText)}">
            </div>
            <div class="proposal-filter-group">
                <label for="proposal-sort" data-i18n-key="modal.roadWidth.proposalList.filters.sort">${escapeHtml(modalStrings.filters.sort)}</label>
                <select id="proposal-sort">
                    ${sortOptions.map(option => `
                        <option value="${option.value}" ${option.value === proposalListState.sortKey ? 'selected' : ''} data-i18n-key="modal.roadWidth.proposalList.sort.${PROPOSAL_SORT_I18N_KEYS[option.value] || option.value}">${escapeHtml(option.label)}</option>
                    `).join('')}
                </select>
            </div>
            ${syncButtonHtml ? `<div class="proposal-filter-group proposal-sync-group">${syncButtonHtml}</div>` : ''}
        </div>
    `;

    const sourceToggleHtml = `
        <div class="proposal-source-toggle">
            <button class="proposal-source-btn ${source === 'local' ? 'active' : ''}" data-source="local">
                ${escapeHtml(modalStrings.sources.local)} (${localCount})
            </button>
            <button class="proposal-source-btn ${source === 'server' ? 'active' : ''}" data-source="server">
                ${escapeHtml(modalStrings.sources.server)} (${serverCountLabel !== null ? serverCountLabel : '0'})
            </button>
        </div>
    `;

    const showServerLoading = source === 'server' && serverProposalCache.loading && chosen.sortedActive.length === 0 && chosen.sortedExecuted.length === 0;
    const showServerError = source === 'server' && !serverProposalCache.loading && serverProposalCache.error;

    const loadingHtml = `<div class="proposal-list-loading">${escapeHtml(modalStrings.loadingServer)}</div>`;
    const errorHtml = `<div class="proposal-list-error">${escapeHtml(modalStrings.serverError)} <button class="proposal-server-retry">${escapeHtml(modalStrings.retry)}</button></div>`;

    const buildTabContent = (sortedList) => {
        if (showServerError) return errorHtml;
        if (showServerLoading) return loadingHtml;
        return buildProposalListItemsHtml(sortedList, {
            source,
            downloadedLookup: isServerProposalDownloaded
        });
    };

    const activeCountDisplay = `${chosen.sortedActive.length}`;

    const executedCountDisplay = `${chosen.sortedExecuted.length}`;

    modal.innerHTML = `
        <div class="proposal-list-modal-content">
            <div class="proposal-list-modal-header">
                <h2 data-i18n-key="modal.roadWidth.proposalList.title">${escapeHtml(modalStrings.title)}</h2>
                <button type="button" class="proposal-list-modal-close close-circle-btn close-circle-btn--lg" aria-label="${escapeHtml(modalStrings.closeAria)}" data-i18n-key="modal.roadWidth.proposalList.closeAria" data-i18n-attr="aria-label" onclick="closeProposalList()">&times;</button>
            </div>
            ${sourceToggleHtml}
            ${controlsHtml}
            <div class="proposal-list-tabs">
                <button class="proposal-tab-btn ${proposalListState.activeTab === 'active' ? 'active' : ''}" data-tab="active" data-i18n-key="modal.roadWidth.proposalList.tabs.active">
                    ${escapeHtml(modalStrings.tabs.active)} (${activeCountDisplay})
                </button>
                <button class="proposal-tab-btn ${proposalListState.activeTab === 'executed' ? 'active' : ''}" data-tab="executed" data-i18n-key="modal.roadWidth.proposalList.tabs.executed">
                    ${escapeHtml(modalStrings.tabs.executed)} (${executedCountDisplay})
                </button>
            </div>
            <div class="proposal-list-modal-body">
                <div id="active-proposals-tab" class="proposal-tab-content ${proposalListState.activeTab === 'active' ? 'active' : ''}">
                    ${buildTabContent(chosen.sortedActive)}
                </div>
                <div id="executed-proposals-tab" class="proposal-tab-content ${proposalListState.activeTab === 'executed' ? 'active' : ''}">
                    ${buildTabContent(chosen.sortedExecuted)}
                </div>
            </div>
        </div>
    `;

    // Run DOM-based translations to mirror agent modal behavior
    try {
        if (typeof window !== 'undefined' && window.i18n && typeof window.i18n.applyTranslations === 'function') {
            window.i18n.applyTranslations(modal);
        }
    } catch (_) { }

    // Fix any nodes that still show raw keys by falling back to the strings we already resolved
    try {
        const fallbackMap = new Map();
        fallbackMap.set('modal.roadWidth.proposalList.title', modalStrings.title);
        fallbackMap.set('modal.roadWidth.proposalList.closeAria', modalStrings.closeAria);
        fallbackMap.set('modal.roadWidth.proposalList.tabs.active', modalStrings.tabs.active);
        fallbackMap.set('modal.roadWidth.proposalList.tabs.executed', modalStrings.tabs.executed);
        fallbackMap.set('modal.roadWidth.proposalList.filters.goal', modalStrings.filters.goal);
        fallbackMap.set('modal.roadWidth.proposalList.filters.author', modalStrings.filters.author);
        fallbackMap.set('modal.roadWidth.proposalList.filters.search', modalStrings.filters.search);
        fallbackMap.set('modal.roadWidth.proposalList.filters.sort', modalStrings.filters.sort);
        fallbackMap.set('modal.roadWidth.proposalList.filters.authorPlaceholder', modalStrings.filters.authorPlaceholder);
        fallbackMap.set('modal.roadWidth.proposalList.filters.searchPlaceholder', modalStrings.filters.searchPlaceholder);
        fallbackMap.set('modal.roadWidth.proposalList.sources.local', modalStrings.sources.local);
        fallbackMap.set('modal.roadWidth.proposalList.sources.server', modalStrings.sources.server);
        fallbackMap.set('modal.roadWidth.proposalList.loadingServer', modalStrings.loadingServer);
        fallbackMap.set('modal.roadWidth.proposalList.serverError', modalStrings.serverError);
        fallbackMap.set('modal.roadWidth.proposalList.retry', modalStrings.retry);
        fallbackMap.set('modal.roadWidth.proposalList.downloadError', modalStrings.downloadError);
        // Goal options
        goalOptions.forEach(option => {
            const key = `modal.roadWidth.proposalList.filters.goals.${option.value}`;
            fallbackMap.set(key, option.label);
        });
        // Sort options
        sortOptions.forEach(option => {
            const mapKey = PROPOSAL_SORT_I18N_KEYS[option.value] || option.value;
            const key = `modal.roadWidth.proposalList.sort.${mapKey}`;
            fallbackMap.set(key, option.label);
        });

        const nodes = modal.querySelectorAll('[data-i18n-key]');
        nodes.forEach(node => {
            const key = node.getAttribute('data-i18n-key') || '';
            if (!key) return;
            const currentText = node.textContent ? node.textContent.trim() : '';
            if (currentText === key && fallbackMap.has(key)) {
                node.textContent = fallbackMap.get(key);
            }
            const attrList = (node.getAttribute('data-i18n-attr') || '').split(',').map(s => s.trim()).filter(Boolean);
            attrList.forEach(attr => {
                if (node.getAttribute && node.getAttribute(attr) === key && fallbackMap.has(key)) {
                    node.setAttribute(attr, fallbackMap.get(key));
                }
            });
        });
    } catch (_) { }

    // Keep the sidebar button count in sync when server data arrives
    try { updateShowProposalsButton(); } catch (_) { }

    const typeSelect = modal.querySelector('#proposal-filter-type');
    if (typeSelect) {
        typeSelect.addEventListener('change', event => {
            proposalListState.filterType = event.target.value;
            renderProposalListModal();
        });
    }

    // Debounce filter typing: full re-render replaces innerHTML and would drop input focus
    // mid-keystroke. 280ms is below "feels laggy" but coalesces typing bursts comfortably.
    const authorInput = modal.querySelector('#proposal-filter-author');
    if (authorInput) {
        authorInput.addEventListener('input', event => {
            proposalListState.authorFilter = event.target.value;
            scheduleDebouncedProposalListModalRender();
        });
    }

    const searchInput = modal.querySelector('#proposal-filter-search');
    if (searchInput) {
        searchInput.addEventListener('input', event => {
            proposalListState.searchText = event.target.value;
            scheduleDebouncedProposalListModalRender();
        });
    }

    const sortSelect = modal.querySelector('#proposal-sort');
    if (sortSelect) {
        sortSelect.addEventListener('change', event => {
            proposalListState.sortKey = event.target.value;
            renderProposalListModal();
        });
    }

    modal.querySelectorAll('.proposal-source-btn').forEach(button => {
        button.addEventListener('click', event => {
            const nextSource = event.currentTarget.getAttribute('data-source');
            if (!nextSource || proposalListState.source === nextSource) return;
            proposalListState.source = nextSource;
            if (nextSource === 'server') {
                ensureServerProposals(resolveCurrentCityCode());
            }
            renderProposalListModal();
        });
    });

    const retryButton = modal.querySelector('.proposal-server-retry');
    if (retryButton) {
        retryButton.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            ensureServerProposals(resolveCurrentCityCode());
        });
    }

    modal.querySelectorAll('.proposal-tab-btn').forEach(button => {
        button.addEventListener('click', event => {
            const tab = event.currentTarget.getAttribute('data-tab');
            if (tab && proposalListState.activeTab !== tab) {
                proposalListState.activeTab = tab;
                renderProposalListModal();
            }
        });
    });

    modal.querySelectorAll('.proposal-list-item').forEach(item => {
        item.addEventListener('click', handleProposalListItemClick);
    });

    modal.querySelectorAll('.proposal-download-btn').forEach(button => {
        button.addEventListener('click', handleProposalDownloadClick);
    });

    const activeTabEl = modal.querySelector('#active-proposals-tab');
    if (activeTabEl) {
        activeTabEl.scrollTop = scrollPositions.active;
    }

    const executedTabEl = modal.querySelector('#executed-proposals-tab');
    if (executedTabEl) {
        executedTabEl.scrollTop = scrollPositions.executed;
    }

    if (proposalListState.selectedId) {
        const selectedEl = modal.querySelector(`.proposal-list-item[data-proposal-id="${proposalListState.selectedId}"]`);
        if (selectedEl && typeof selectedEl.scrollIntoView === 'function') {
            selectedEl.scrollIntoView({ block: 'nearest' });
        }
    }
}


function showProposalDownloadConfirm() {
    return new Promise((resolve) => {
        const t = getProposalI18nHelper();

        const overlay = document.createElement('div');
        overlay.className = 'cb-confirm-overlay';

        const dialog = document.createElement('div');
        dialog.className = 'cb-confirm-dialog';

        const message = document.createElement('div');
        message.className = 'cb-confirm-message';
        message.textContent = t('modal.roadWidth.proposalList.downloadConfirm', 'Proposal is not in local storage yet. Download?');

        const buttons = document.createElement('div');
        buttons.className = 'cb-confirm-buttons';

        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'btn btn-secondary';
        cancelBtn.textContent = t('common.cancel', 'Cancel');

        const downloadBtn = document.createElement('button');
        downloadBtn.type = 'button';
        downloadBtn.className = 'btn btn-action';
        downloadBtn.textContent = t('common.download', 'Download');

        function cleanup(result) {
            if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
            resolve(result);
        }

        cancelBtn.addEventListener('click', () => cleanup(false));
        downloadBtn.addEventListener('click', () => cleanup(true));
        overlay.addEventListener('click', (event) => {
            if (event.target === overlay) cleanup(false);
        });

        buttons.appendChild(cancelBtn);
        buttons.appendChild(downloadBtn);
        dialog.appendChild(message);
        dialog.appendChild(buttons);
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);
    });
}



// Show proposal list dialog
function showAllProposalsModal() {
    resetParcelSelectionForProposalListInteraction();
    try { clearProposalInfoHoverOverlay(); } catch (_) { }

    let modal = document.querySelector('.proposal-list-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.className = 'proposal-list-modal';
        document.body.appendChild(modal);
    }

    modal.style.display = 'block';
    renderProposalListModal();
}

// Switch between proposal tabs (legacy helper retained for backwards compatibility)

// Close proposal list dialog

// Update proposal list (if open)

// Update the "Proposals List" button text with current count

// Proposals section no longer has a checkbox - this function is kept for compatibility
// but does nothing since proposals are always shown





// Determine if proposal-specific UI is active (Proposal List open or Parcel Details showing a proposal)
function isProposalUIActive() {
    try {
        const list = document.querySelector('.proposal-list-modal');
        const listOpen = !!(list && list.style && list.style.display === 'block');
        if (listOpen) return true;
        const detailsPanel = document.getElementById('proposal-details-panel');
        if (detailsPanel && detailsPanel.classList.contains('visible')) {
            return true;
        }
        const panel = document.getElementById('parcel-info-panel');
        if (panel && panel.classList.contains('visible')) {
            const titleEl = panel.querySelector('h3');
            const title = titleEl ? titleEl.textContent : '';
            if (title && title.trim() === 'Proposal Details') return true;
        }
    } catch (_) { }
    return false;
}

// Expose helper
window.isProposalUIActive = isProposalUIActive;

// Delete a single proposal

// Center map on proposal (unified function)

// Clear all proposals from PersistentStorage


if (typeof PersistentStorage !== 'undefined' && PersistentStorage.ensureReady) {
    PersistentStorage.ensureReady(initialiseProposalStorage);
} else {
    initialiseProposalStorage();
}

// Re-render proposal list when language or translations load so modal text updates live

try {
    if (typeof window !== 'undefined') {
        if (window.i18n && typeof window.i18n.onChange === 'function') {
            window.i18n.onChange(rerenderProposalListIfOpen);
        }
        if (typeof window.addEventListener === 'function') {
            window.addEventListener('i18n:translationsLoaded', rerenderProposalListIfOpen);
        }
    }
} catch (_) { }

/**
 * Handle multi-select checkbox change with mutual exclusivity
 */

/**
 * Handle show proposals checkbox change with mutual exclusivity
 */

/**
 * Helper function to enable show proposals mode and clear multi-selection
 * This ensures consistent behavior across all places that enable show proposals
 */

// Sharing constants (SHARE_URL_MAX_LENGTH, SHARE_PAYLOAD_VERSION, etc.)
// are defined in proposals/sharing.js which is loaded after this file.


function base64UrlEncodeBytes(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
        return '';
    }
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
        const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
        binary += String.fromCharCode.apply(null, chunk);
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecodeToBytes(input) {
    let working = input || '';
    working = working.replace(/-/g, '+').replace(/_/g, '/');
    while (working.length % 4 !== 0) {
        working += '=';
    }
    const binary = atob(working);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

function compressBytes(bytes) {
    if (!(bytes instanceof Uint8Array)) {
        return { bytes, compressed: false };
    }
    if (typeof pako === 'undefined' || typeof pako.deflate !== 'function') {
        return { bytes, compressed: false };
    }
    try {
        const compressedBytes = pako.deflate(bytes, { level: 9 });
        return { bytes: compressedBytes, compressed: true };
    } catch (error) {
        console.warn('pako.deflate failed, falling back to raw payload', error);
        return { bytes, compressed: false };
    }
}

function inflateBytes(bytes, { strict = false } = {}) {
    if (typeof pako === 'undefined' || typeof pako.inflate !== 'function') {
        if (strict) {
            throw new Error('Compressed share links require compression support.');
        }
        return null;
    }
    try {
        return pako.inflate(bytes);
    } catch (error) {
        if (strict) {
            throw error;
        }
        console.warn('pako.inflate failed, falling back to raw payload', error);
        return null;
    }
}

function decodeBytesToJson(bytes) {
    if (typeof TextDecoder !== 'undefined') {
        const decoder = new TextDecoder();
        return decoder.decode(bytes);
    }
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
        const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
        binary += String.fromCharCode.apply(null, chunk);
    }
    return decodeURIComponent(escape(binary));
}



function focusMapOnSharedProposal(proposal, payload) {
    if (!proposal || typeof map === 'undefined' || !map) {
        return false;
    }

    const restoreSuppression = (() => {
        const wasSuppressed = isCameraMovementSuppressed();
        if (wasSuppressed) {
            try { window.suppressCameraMoves = false; } catch (_) { }
        }
        return () => {
            if (wasSuppressed) {
                try { window.suppressCameraMoves = true; } catch (_) { }
            }
        };
    })();

    const applyBounds = (bounds, padding = [120, 120]) => {
        if (!bounds || !bounds.isValid()) return false;
        try {
            map.fitBounds(bounds, { padding, maxZoom: 16 });
            return true;
        } catch (error) {
            console.warn('focusMapOnSharedProposal fitBounds failed', error);
            return false;
        }
    };

    try {
        if (payload && payload.camera && Number.isFinite(payload.camera.lat) && Number.isFinite(payload.camera.lng)) {
            const zoom = Number.isFinite(payload.camera.zoom) ? payload.camera.zoom : map.getZoom();
            map.setView([payload.camera.lat, payload.camera.lng], zoom);
            return true;
        }

        // Prefer explicit bounds from payload/proposal (already in WGS84)
        const candidateBounds = buildLeafletBoundsFromArray(payload && payload.bbox ? payload.bbox : null)
            || buildLeafletBoundsFromArray(proposal.bounds)
            || buildLeafletBoundsFromArray(proposal.roadProposal && proposal.roadProposal.bounds);
        if (candidateBounds && applyBounds(candidateBounds, [100, 100])) {
            return true;
        }

        const geometryFeatures = [];
        if (proposal.roadProposal) {
            const childIds = ensureArrayOfStrings(proposal.roadProposal.childParcelIds || []);
            childIds.forEach(id => {
                const feature = getParcelFeatureForHighlight(id, proposal);
                if (feature && feature.geometry) {
                    geometryFeatures.push(feature);
                }
            });
        }
        if (proposal.buildingProposal && proposal.buildingProposal.buildingFeature) {
            geometryFeatures.push(proposal.buildingProposal.buildingFeature);
        }
        if (proposal.structureProposal && proposal.structureProposal.geometry) {
            geometryFeatures.push({ type: 'Feature', geometry: proposal.structureProposal.geometry });
        }
        if (proposal.reparcellization && Array.isArray(proposal.reparcellization.polygons)) {
            proposal.reparcellization.polygons.forEach(polygon => {
                if (polygon && polygon.geometry) {
                    geometryFeatures.push({ type: 'Feature', geometry: polygon.geometry });
                }
            });
        }

        if (geometryFeatures.length) {
            const geoBounds = computeBoundsFromGeoJSONFeatures(geometryFeatures);
            if (applyBounds(geoBounds)) {
                return true;
            }
        }

        const parcelLayers = ensureArrayOfStrings(proposal.parentParcelIds)
            .map(id => findParcelLayerById(id))
            .filter(layer => layer && typeof layer.getBounds === 'function');
        if (parcelLayers.length) {
            let bounds = null;
            parcelLayers.forEach(layer => {
                const layerBounds = layer.getBounds();
                if (layerBounds && layerBounds.isValid()) {
                    bounds = bounds ? bounds.extend(layerBounds) : layerBounds;
                }
            });
            if (applyBounds(bounds)) {
                return true;
            }
        }

        if (payload && payload.bbox) {
            const sharedBounds = buildBoundsFromSharedPayload(payload);
            if (applyBounds(sharedBounds, [120, 120])) {
                return true;
            }
        }
    } finally {
        restoreSuppression();
    }

    return false;
}

function getShareI18nHelper() {
    const t = getProposalI18nHelper();
    const namespace = 'modal.roadWidth.share';
    return (key, fallback, params = {}) => t(`${namespace}.${key}`, fallback, params);
}

function getSharedInspectorI18nHelper() {
    const t = getProposalI18nHelper();
    const namespace = 'modal.roadWidth.sharedInspector';
    return (key, fallback, params = {}) => t(`${namespace}.${key}`, fallback, params);
}

function collectProposalParentParcelIdsForShare(proposal) {
    const ids = new Set();
    const normalize = (value) => {
        if (value === undefined || value === null) return null;
        const str = value && value.toString ? value.toString() : String(value);
        return str.trim() || null;
    };
    const addValue = (value) => {
        const normalized = normalize(value);
        if (normalized) ids.add(normalized);
    };
    const addMany = (list) => {
        if (!list) return;
        (Array.isArray(list) ? list : [list]).forEach(addValue);
    };

    if (!proposal) return [];

    addMany(proposal.parentParcelIds);

    if (proposal.roadProposal) {
        addMany(proposal.roadProposal.parentParcelIds);
    }

    if (proposal.buildingProposal) {
        addMany(proposal.buildingProposal.parentParcelIds);
    }

    if (proposal.structureProposal) {
        addMany(proposal.structureProposal.parentParcelIds);
    }

    if (proposal.reparcellization && Array.isArray(proposal.reparcellization.parcelIds)) {
        addMany(proposal.reparcellization.parcelIds);
    }

    if (ids.size === 0) {
        addMany(proposal.parentParcelIds);
    }

    return Array.from(ids);
}



function showNonOriginalParcelShareBlockedModal(proposal, parcelList) {
    const t = getProposalI18nHelper();
    const tShare = getShareI18nHelper();

    const pairs = collectParcelProposalPairs(parcelList);

    const container = document.createElement('div');
    const message = document.createElement('p');
    message.setAttribute('data-i18n-key', 'modal.roadWidth.share.ancestorNote');
    message.textContent = tShare('ancestorNote', 'Note: this proposal includes parcels created by other proposals. For it to be applied on a target map the ancestor proposals will have to be applied first. Instead of sharing this one proposal you might want to share the entire plan using "Share entire plan" button in the Proposals section of the sidebar. The parcel list:');
    container.appendChild(message);

    const listWrapper = document.createElement('div');
    listWrapper.style.maxHeight = '240px';
    listWrapper.style.overflowY = 'auto';
    listWrapper.style.border = '1px solid #d8ddf0';
    listWrapper.style.borderRadius = '8px';
    listWrapper.style.padding = '8px';
    listWrapper.style.background = '#f9fafb';

    // Create table with two columns
    const table = document.createElement('table');
    table.style.width = '100%';
    table.style.borderCollapse = 'collapse';
    table.style.margin = '0';

    // Table header
    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    headerRow.style.borderBottom = '1px solid #d8ddf0';

    const headerParcel = document.createElement('th');
    headerParcel.setAttribute('data-i18n-key', 'modal.roadWidth.share.parcelIdHeader');
    headerParcel.textContent = tShare('parcelIdHeader', 'Parcel ID');
    headerParcel.style.padding = '6px 8px';
    headerParcel.style.textAlign = 'left';
    headerParcel.style.fontWeight = '600';
    headerRow.appendChild(headerParcel);

    const headerProposal = document.createElement('th');
    headerProposal.setAttribute('data-i18n-key', 'modal.roadWidth.share.proposalIdHeader');
    headerProposal.textContent = tShare('proposalIdHeader', 'Proposal ID');
    headerProposal.style.padding = '6px 8px';
    headerProposal.style.textAlign = 'left';
    headerProposal.style.fontWeight = '600';
    headerRow.appendChild(headerProposal);

    thead.appendChild(headerRow);
    table.appendChild(thead);

    // Table body
    const tbody = document.createElement('tbody');
    pairs.forEach(pair => {
        const row = document.createElement('tr');
        row.style.borderBottom = '1px solid #f0f0f0';

        const cellParcel = document.createElement('td');
        cellParcel.textContent = pair.parcelId;
        cellParcel.style.padding = '6px 8px';
        row.appendChild(cellParcel);

        const cellProposal = document.createElement('td');
        cellProposal.textContent = pair.proposalId || '?';
        cellProposal.style.padding = '6px 8px';
        row.appendChild(cellProposal);

        tbody.appendChild(row);
    });
    table.appendChild(tbody);

    listWrapper.appendChild(table);
    container.appendChild(listWrapper);

    // Apply translations
    if (typeof window !== 'undefined' && window.i18n && typeof window.i18n.applyTranslations === 'function') {
        window.i18n.applyTranslations(container);
    }

    const modal = showSimpleShareModal({
        title: tShare('title', 'Share Proposal'),
        body: container,
        actions: [
            {
                label: tShare('ancestorUploadButton', 'Upload'),
                primary: true,
                onClick: () => {
                    if (proposal) {
                        showUploadProposalModal(proposal);
                    }
                }
            }
        ]
    });
}

if (typeof window !== 'undefined') {
    window.checkParcelsOriginal = checkParcelsOriginal;
}


/**
 * Get the serial ID (numeric database ID) for a proposal, if available.
 * Returns null if only a hash is available (hashes should not be used in share links).
 */
function getSerialProposalId(proposal) {
    if (!proposal) return null;
    // Prefer serverProposalId if it's numeric (serial ID)
    if (proposal.serverProposalId) {
        const id = String(proposal.serverProposalId);
        if (/^\d+$/.test(id)) {
            return id;
        }
    }
    // Check if proposalId is numeric
    if (proposal.proposalId) {
        const id = String(proposal.proposalId);
        if (/^\d+$/.test(id)) {
            return id;
        }
    }
    // Check if id is numeric
    if (proposal.id) {
        const id = String(proposal.id);
        if (/^\d+$/.test(id)) {
            return id;
        }
    }
    return null;
}

function sortProposalIdsForShare(ids) {
    return ids.slice().sort((a, b) => {
        const na = Number(a);
        const nb = Number(b);
        const aNum = Number.isFinite(na);
        const bNum = Number.isFinite(nb);
        if (aNum && bNum) return na - nb;
        if (aNum && !bNum) return -1;
        if (!aNum && bNum) return 1;
        return String(a).localeCompare(String(b), undefined, { numeric: true });
    });
}

function shareAppliedProposals() {
    showSharePlanModal();
}

function showSharePlanModal() {
    try {
        const t = getProposalI18nHelper();
        const tShare = getShareI18nHelper();
        if (typeof proposalStorage === 'undefined') return;
        const applied = proposalStorage.getAllProposals().filter(isProposalCurrentlyApplied);
        if (applied.length === 0) {
            if (typeof showEphemeralMessage === 'function') {
                showEphemeralMessage(t('ephemeral.messages.no_applied_proposals_to_share_yet', 'No applied proposals to share yet.'));
            }
            return;
        }

        const proposalsByHash = new Map();
        applied.forEach(proposal => {
            const key = proposal.proposalId || getProposalKey(proposal);
            if (!key) return;
            proposalsByHash.set(String(key), proposal);
        });
        if (proposalsByHash.size === 0) {
            if (typeof showEphemeralMessage === 'function') {
                showEphemeralMessage(t('ephemeral.messages.unable_to_prepare_proposals_for_sharing', 'Unable to prepare proposals for sharing.'), 5000, 'error');
            }
            return;
        }

        const selected = new Set(proposalsByHash.keys());
        const uploadState = new Map(); // key -> { uploaded, uploading, serverId }
        const rowControls = new Map();

        const container = document.createElement('div');
        container.style.display = 'flex';
        container.style.flexDirection = 'column';
        container.style.gap = '12px';

        const totalInPlan = proposalsByHash.size;
        const countLine = document.createElement('div');
        countLine.style.fontSize = '13px';
        countLine.style.color = '#475569';
        countLine.textContent = tShare('plan.countHeading', 'There are {{count}} proposal{{suffix}} in the current plan', {
            count: totalInPlan,
            suffix: totalInPlan === 1 ? '' : 's'
        });
        container.appendChild(countLine);

        const statusLine = document.createElement('div');
        statusLine.style.minHeight = '18px';
        statusLine.style.color = '#b3261e';
        statusLine.style.fontSize = '12px';
        container.appendChild(statusLine);

        const listWrap = document.createElement('div');
        listWrap.style.maxHeight = '320px';
        listWrap.style.overflowY = 'auto';
        listWrap.style.border = '1px solid #d8ddf0';
        listWrap.style.borderRadius = '8px';
        listWrap.style.padding = '8px';
        listWrap.style.background = '#f9fafb';
        container.appendChild(listWrap);

        const shareArea = document.createElement('div');
        shareArea.style.display = 'flex';
        shareArea.style.flexDirection = 'column';
        shareArea.style.gap = '8px';
        shareArea.style.marginTop = '4px';

        const linkRow = document.createElement('div');
        linkRow.style.display = 'flex';
        linkRow.style.alignItems = 'center';
        linkRow.style.gap = '8px';

        const linkInput = document.createElement('input');
        linkInput.type = 'text';
        linkInput.readOnly = true;
        linkInput.className = 'share-modal-link';
        linkInput.style.flex = '1';
        linkInput.style.padding = '0.5rem 0.75rem';
        linkInput.style.border = '1px solid #d8ddf0';
        linkInput.style.borderRadius = '8px';
        linkInput.style.background = '#f7f8fb';
        linkInput.style.fontSize = '13px';
        linkInput.style.color = '#212744';
        linkInput.style.boxSizing = 'border-box';
        linkInput.style.height = 'auto';
        linkInput.style.minHeight = '38px';
        linkRow.appendChild(linkInput);

        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'btn share-modal-secondary';
        copyBtn.textContent = tShare('copyUrlButton', 'Copy URL');
        copyBtn.addEventListener('click', () => {
            if (!linkInput.value) return;
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(linkInput.value).then(() => {
                    if (typeof showEphemeralMessage === 'function') {
                        showEphemeralMessage(tShare('copySuccess', 'Share link copied to clipboard!'));
                    }
                }).catch(() => {
                    linkInput.focus();
                    linkInput.select();
                });
            } else {
                linkInput.focus();
                linkInput.select();
            }
        });
        linkRow.appendChild(copyBtn);

        shareArea.appendChild(linkRow);

        // --- Named plan (ENS): give this plan a globally-unique, mutable name
        // resolvable as <name>.proposals.urbangametheory.eth ---
        const planNameWrap = document.createElement('div');
        planNameWrap.style.display = 'flex';
        planNameWrap.style.flexDirection = 'column';
        planNameWrap.style.gap = '6px';
        planNameWrap.style.marginTop = '6px';
        planNameWrap.style.paddingTop = '8px';
        planNameWrap.style.borderTop = '1px solid #e5e9f5';

        const planNameLabel = document.createElement('div');
        planNameLabel.style.fontSize = '13px';
        planNameLabel.style.color = '#475569';
        planNameLabel.textContent = tShare('plan.nameHeading', 'Or give this plan a memorable name (ENS):');
        planNameWrap.appendChild(planNameLabel);

        const planNameRow = document.createElement('div');
        planNameRow.style.display = 'flex';
        planNameRow.style.gap = '8px';
        planNameRow.style.alignItems = 'center';
        planNameRow.style.flexWrap = 'wrap';

        const planNameInput = document.createElement('input');
        planNameInput.type = 'text';
        planNameInput.placeholder = tShare('plan.namePlaceholder', 'e.g. harbor-redevelopment');
        planNameInput.style.flex = '1';
        planNameInput.style.minWidth = '140px';
        planNameInput.style.padding = '0.4rem 0.6rem';
        planNameInput.style.border = '1px solid #d8ddf0';
        planNameInput.style.borderRadius = '8px';
        planNameInput.style.fontSize = '13px';
        planNameInput.style.boxSizing = 'border-box';

        const planSuffix = document.createElement('span');
        planSuffix.textContent = '.proposals.urbangametheory.eth';
        planSuffix.style.fontSize = '12px';
        planSuffix.style.color = '#64748b';
        planSuffix.style.whiteSpace = 'nowrap';

        const planNameBtn = document.createElement('button');
        planNameBtn.type = 'button';
        planNameBtn.className = 'btn share-modal-secondary';
        planNameBtn.textContent = tShare('plan.nameButton', 'Save name');

        planNameRow.append(planNameInput, planSuffix, planNameBtn);
        planNameWrap.appendChild(planNameRow);

        const planNameStatus = document.createElement('div');
        planNameStatus.style.fontSize = '12px';
        planNameStatus.style.minHeight = '16px';
        planNameWrap.appendChild(planNameStatus);

        const planNameToken = (slug) => `cb_plan_token_${slug}`;
        const slugifyPlanName = (s) => (s || '').toString().trim().toLowerCase()
            .replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');

        async function submitNamedPlan() {
            const idMatch = (linkInput.value || '').match(/\/proposals\/([0-9,]+)/);
            if (!idMatch) {
                planNameStatus.style.color = '#b3261e';
                planNameStatus.textContent = tShare('plan.namePrepFirst', 'Prepare the share link above first (upload all selected proposals).');
                return;
            }
            const slug = slugifyPlanName(planNameInput.value);
            if (slug.length < 3) {
                planNameStatus.style.color = '#b3261e';
                planNameStatus.textContent = tShare('plan.nameInvalid', 'Use at least 3 characters: a–z, 0–9, hyphens.');
                return;
            }
            const proposalIds = idMatch[1].split(',');
            const base = (typeof window.getBackendBase === 'function') ? window.getBackendBase().replace(/\/$/, '') : '';
            const city = (window.CityConfigManager && typeof window.CityConfigManager.getCurrentCityId === 'function')
                ? window.CityConfigManager.getCurrentCityId() : null;
            let existingToken = null;
            try { existingToken = localStorage.getItem(planNameToken(slug)); } catch (_) { /* ignore */ }

            planNameBtn.disabled = true;
            planNameStatus.style.color = '#475569';
            planNameStatus.textContent = tShare('plan.nameSaving', 'Saving…');
            try {
                let resp;
                if (existingToken) {
                    resp = await fetch(`${base}/plans/${slug}`, {
                        method: 'PUT', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ editToken: existingToken, proposalIds })
                    });
                } else {
                    resp = await fetch(`${base}/plans`, {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ slug, proposalIds, city })
                    });
                }
                const data = await resp.json().catch(() => ({}));
                if (resp.status === 409) {
                    planNameStatus.style.color = '#b3261e';
                    planNameStatus.textContent = tShare('plan.nameTaken', 'That name is taken — pick another.');
                    return;
                }
                if (!resp.ok) {
                    planNameStatus.style.color = '#b3261e';
                    planNameStatus.textContent = data.error || tShare('plan.nameError', 'Could not save the name.');
                    return;
                }
                if (data.editToken) {
                    try { localStorage.setItem(planNameToken(slug), data.editToken); } catch (_) { /* ignore */ }
                }
                planNameStatus.style.color = '#0a7d28';
                planNameStatus.textContent = (data.name || `${slug}.proposals.urbangametheory.eth`)
                    + ' — ' + tShare('plan.nameSaved', 'saved (resolves to this plan).');
            } catch (_) {
                planNameStatus.style.color = '#b3261e';
                planNameStatus.textContent = tShare('plan.nameError', 'Could not save the name.');
            } finally {
                planNameBtn.disabled = false;
            }
        }
        planNameBtn.addEventListener('click', submitNamedPlan);
        planNameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitNamedPlan(); });

        shareArea.appendChild(planNameWrap);
        container.appendChild(shareArea);

        const setStatus = (message) => {
            statusLine.textContent = message || '';
        };

        const getDescendantsInPlan = (hash) => {
            if (typeof ProposalManager === 'undefined' || typeof ProposalManager.findDescendantTree !== 'function') return [];
            const nodes = ProposalManager.findDescendantTree(hash, { depthLimit: 64 }) || [];
            return nodes.map(n => n.proposalId).filter(h => proposalsByHash.has(h));
        };

        const getAncestorsInPlan = (hash) => {
            if (typeof ProposalManager === 'undefined' || typeof ProposalManager.findAncestorTree !== 'function') return [];
            const nodes = ProposalManager.findAncestorTree(hash, { depthLimit: 64 }) || [];
            return nodes.map(n => n.proposalId).filter(h => proposalsByHash.has(h));
        };

        const updateShareUrl = () => {
            const hasSelection = selected.size > 0;
            if (!hasSelection) {
                linkInput.value = '';
                linkRow.style.display = 'none';
                setStatus(tShare('plan.selectHint', 'Select at least one proposal to share.'));
                return;
            }

            const selectedKeys = Array.from(selected);
            const selectedProposals = selectedKeys.map(key => proposalsByHash.get(key)).filter(Boolean);

            const selectedStates = selectedKeys
                .map(key => uploadState.get(key))
                .filter(Boolean);

            const anyUploading = selectedStates.some(s => !!s.uploading);
            if (anyUploading) {
                linkInput.value = '';
                linkRow.style.display = 'none';
                setStatus(tShare('plan.checkingHint', 'Checking upload status…'));
                return;
            }

            const uploadedIds = selectedKeys
                .map(key => uploadState.get(key))
                .filter(state => state && state.uploaded && state.serverId)
                .map(state => state.serverId)
                .filter(id => {
                    // Only include numeric serial IDs, never hashes
                    return id && /^\d+$/.test(String(id));
                });

            if (uploadedIds.length !== selectedKeys.length) {
                linkInput.value = '';
                linkRow.style.display = 'none';
                const anyUploaded = uploadedIds.length > 0;
                setStatus(anyUploaded
                    ? tShare('plan.uploadHint', 'Upload all selected proposals to enable sharing, or deselect some.')
                    : tShare('plan.noUploadedHint', 'Upload at least one proposal to enable sharing.')
                );
                return;
            }

            const sortedIds = sortProposalIdsForShare(uploadedIds);
            const cityParam = buildCityQueryParam();
            const queryJoiner = cityParam ? '&' : '?';
            const shareUrl = `${resolveFrontendBaseUrl()}/proposals/${sortedIds.join(',')}${cityParam}${queryJoiner}3d`;
            linkInput.value = shareUrl;
            linkRow.style.display = 'flex';
            setStatus('');
        };

        const updateRowState = (key) => {
            const controls = rowControls.get(key);
            const state = uploadState.get(key) || { uploaded: false, uploading: false };
            if (!controls) return;
            if (state.uploaded) {
                controls.uploadBtn.style.display = 'none';
                controls.uploadedLabel.style.display = 'inline-flex';
                controls.uploadedLabel.textContent = tShare('plan.uploaded', 'Uploaded');
            } else {
                controls.uploadedLabel.style.display = 'none';
                controls.uploadBtn.style.display = 'inline-flex';
                controls.uploadBtn.disabled = state.uploading;
                controls.uploadBtn.textContent = state.uploading
                    ? tShare('plan.uploading', 'Uploading…')
                    : tShare('plan.upload', 'Upload');
            }
            controls.checkbox.checked = selected.has(key);
        };

        const toggleCheckbox = (key, checked) => {
            const controls = rowControls.get(key);
            if (controls) {
                controls.checkbox.checked = checked;
            }
        };

        const onCheckboxChange = (key, checked) => {
            if (checked) {
                const ancestors = getAncestorsInPlan(key);
                const added = [];
                selected.add(key);
                ancestors.forEach(hash => {
                    if (!selected.has(hash)) added.push(hash);
                    selected.add(hash);
                });
                selected.forEach(hash => toggleCheckbox(hash, true));
                if (added.length > 0) {
                    const summary = added.slice(0, 5).join(', ');
                    setStatus(tShare('plan.addedAncestors', 'Also added {{count}} ancestor proposals: {{list}}', {
                        count: added.length,
                        list: summary
                    }));
                } else {
                    setStatus('');
                }
            } else {
                const descendants = getDescendantsInPlan(key);
                const removed = [];
                selected.delete(key);
                descendants.forEach(hash => {
                    if (selected.delete(hash)) removed.push(hash);
                });
                selected.forEach(hash => toggleCheckbox(hash, selected.has(hash)));
                toggleCheckbox(key, false);
                descendants.forEach(hash => toggleCheckbox(hash, false));
                if (removed.length > 0) {
                    const summary = removed.slice(0, 5).join(', ');
                    setStatus(tShare('plan.removedDescendants', 'Also removed {{count}} descendant proposals: {{list}}', {
                        count: removed.length,
                        list: summary
                    }));
                } else {
                    setStatus('');
                }
            }
            updateShareUrl();
        };

        const attachRow = (proposal, key) => {
            const row = document.createElement('div');
            row.style.display = 'flex';
            row.style.alignItems = 'center';
            row.style.justifyContent = 'space-between';
            row.style.gap = '8px';
            row.style.padding = '6px 4px';

            const left = document.createElement('div');
            left.style.display = 'flex';
            left.style.alignItems = 'center';
            left.style.gap = '8px';

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = true;
            checkbox.addEventListener('change', () => onCheckboxChange(key, checkbox.checked));
            left.appendChild(checkbox);

            const title = document.createElement('div');
            title.style.display = 'flex';
            title.style.flexDirection = 'column';
            title.style.gap = '2px';

            const name = document.createElement('span');
            name.textContent = proposal.title || proposal.name || tShare('untitled', '(Untitled)');
            name.style.fontWeight = '600';
            name.style.fontSize = '13px';
            title.appendChild(name);

            const meta = document.createElement('span');
            meta.style.fontSize = '12px';
            meta.style.color = '#475569';
            const displayId = proposal.proposalId || getProposalKey(proposal) || 'local';
            meta.textContent = `${displayId} · ${(resolveProposalGoalKey(proposal) || 'proposal')}`;
            title.appendChild(meta);

            left.appendChild(title);

            const right = document.createElement('div');
            right.style.display = 'flex';
            right.style.alignItems = 'center';
            right.style.gap = '8px';

            const uploadBtn = document.createElement('button');
            uploadBtn.type = 'button';
            uploadBtn.className = 'btn share-modal-secondary';
            uploadBtn.textContent = tShare('plan.upload', 'Upload');

            const uploadedLabel = document.createElement('span');
            uploadedLabel.style.fontSize = '12px';
            uploadedLabel.style.color = '#0f766e';
            uploadedLabel.style.display = 'none';

            uploadBtn.addEventListener('click', async () => {
                const gate = await ensureAncestorProposalsUploaded(proposal);
                if (!gate.ok) {
                    const missingList = gate.missing.map(entry => entry.id || (entry.hash ? entry.hash.slice(0, 8) : '?')).filter(Boolean);
                    setStatus(tShare('plan.uploadAncestorsMissing', 'Upload ancestor proposals first: {{list}}', {
                        list: missingList.join(', ')
                    }));
                    return;
                }

                uploadState.set(key, { uploaded: false, uploading: true, serverId: getServerProposalId(proposal) });
                updateRowState(key);
                try {
                    const result = await uploadProposalToServer(proposal);
                    if (!result.ok) {
                        throw new Error(result.message || tShare('uploadError', 'Failed to upload proposal. Please try again.'));
                    }
                    // Always use the serial ID (numeric) from the server response, never a hash
                    const serverId = result.id ? String(result.id) : (result.proposalId ? String(result.proposalId) : null);
                    if (!serverId || !/^\d+$/.test(serverId)) {
                        throw new Error(tShare('uploadError', 'Server did not return a valid serial ID. Please try again.'));
                    }

                    // syncProposalWithServerId updates the stored proposal with serverProposalId.
                    // Keep using the local proposal key for UI/state to avoid collisions with on-chain numeric ids.
                    const updatedProposal = proposalStorage.getProposal(key) || proposal;

                    // Update the proposal in our map with fresh data
                    proposalsByHash.set(key, updatedProposal);

                    // Update the meta display with new ID
                    const controls = rowControls.get(key);
                    if (controls && controls.meta) {
                        const displayId = updatedProposal.proposalId || getProposalKey(updatedProposal) || 'local';
                        controls.meta.textContent = `${displayId} · ${(resolveProposalGoalKey(updatedProposal) || 'proposal')}`;
                    }

                    uploadState.set(key, { uploaded: true, uploading: false, serverId });
                    updateRowState(key);
                    updateShareUrl();
                } catch (error) {
                    console.error('plan upload failed', error);
                    uploadState.set(key, { uploaded: false, uploading: false, serverId: getServerProposalId(proposal) });
                    updateRowState(key);
                    setStatus(error.message || tShare('uploadError', 'Failed to upload proposal. Please try again.'));
                }
            });

            right.appendChild(uploadBtn);
            right.appendChild(uploadedLabel);

            row.appendChild(left);
            row.appendChild(right);

            listWrap.appendChild(row);
            rowControls.set(key, { checkbox, uploadBtn, uploadedLabel, meta });
        };

        proposalsByHash.forEach(attachRow);

        const refreshUploadState = async (key, proposal) => {
            const serverId = getServerProposalId(proposal);
            if (!serverId) {
                uploadState.set(key, { uploaded: false, uploading: false, serverId: null });
                updateRowState(key);
                return;
            }
            uploadState.set(key, { uploaded: false, uploading: true, serverId });
            updateRowState(key);
            const exists = await headProposalExists(serverId, proposal.city, proposal);

            // After headProposalExists, the proposal may have been synced with serverProposalId
            // Get the serial ID (numeric) if available
            // headProposalExists syncs the proposal when checking by hash, so refresh our reference
            const refreshedProposal = proposalStorage.getProposal(key) || proposal;
            let serialId = getSerialProposalId(refreshedProposal);

            // If proposal exists but we still don't have serial ID, try fetching it directly
            if (!serialId && exists) {
                const isNumericId = /^\d+$/.test(String(serverId));
                if (!isNumericId) {
                    // We checked by hash, need to fetch the full proposal to get serial ID
                    try {
                        const backendBase = resolveBackendBaseUrl();
                        const url = `${backendBase}/proposals/${encodeURIComponent(serverId)}`;
                        const response = await fetch(url);
                        if (response.ok) {
                            const payload = await response.json();
                            if (payload && payload.id) {
                                serialId = String(payload.id);
                                // Sync the proposal with the serial ID
                                syncProposalWithServerId(refreshedProposal, serialId);
                            }
                        }
                    } catch (error) {
                        console.warn('Failed to fetch serial ID for proposal', serverId, error);
                    }
                } else {
                    // serverId is already numeric, use it
                    serialId = String(serverId);
                }
            }

            // Only use serial ID for share links, never hashes
            const shareId = serialId && /^\d+$/.test(serialId) ? serialId : null;
            uploadState.set(key, { uploaded: !!exists, uploading: false, serverId: shareId });
            updateRowState(key);
            updateShareUrl();
        };

        const initializeUploadChecks = async () => {
            for (const [key, proposal] of proposalsByHash.entries()) {
                await refreshUploadState(key, proposal);
            }
            updateShareUrl();
        };

        showSimpleShareModal({
            title: tShare('plan.title', 'Share Plan'),
            body: container
        });

        initializeUploadChecks();
    } catch (error) {
        console.error('showSharePlanModal failed', error);
        if (typeof showEphemeralMessage === 'function') {
            const t = getProposalI18nHelper();
            showEphemeralMessage(t('ephemeral.messages.failed_to_generate_share_link', 'Failed to generate share link.'), 5000, 'error');
        }
    }
}

function shareSingleProposal(proposalIdOrProposal) {
    try {
        const t = getProposalI18nHelper();
        const tShare = getShareI18nHelper();
        const hasStorage = typeof proposalStorage !== 'undefined';

        // Accept either a proposal object or an identifier
        const requestedId = (proposalIdOrProposal && typeof proposalIdOrProposal === 'object')
            ? (getProposalKey(proposalIdOrProposal)
                || proposalIdOrProposal.serverProposalId
                || proposalIdOrProposal.id
                || proposalIdOrProposal.proposalId)
            : proposalIdOrProposal;

        // Prefer the proposal object if provided directly
        let proposal = (proposalIdOrProposal && typeof proposalIdOrProposal === 'object')
            ? proposalIdOrProposal
            : null;

        // Next, prefer the proposal currently rendered in the details panel
        if (!proposal && currentProposalDetailsContext) {
            const currentId = getProposalKey(currentProposalDetailsContext)
                || currentProposalDetailsContext.serverProposalId
                || currentProposalDetailsContext.id;
            if (!requestedId || String(currentId) === String(requestedId)) {
                proposal = currentProposalDetailsContext;
            }
        }

        // Finally, fall back to storage lookups when needed
        if (!proposal && requestedId && hasStorage) {
            proposal = proposalStorage.getProposal(requestedId);
        }
        if (!proposal && requestedId && hasStorage) {
            const all = typeof proposalStorage.getAllProposals === 'function' ? proposalStorage.getAllProposals() : [];
            proposal = all.find(p => String(p.serverProposalId || p.id || p.proposalId) === String(requestedId));
        }
        if (!proposal && requestedId && typeof getProposalByIdOrHash === 'function') {
            proposal = getProposalByIdOrHash(requestedId);
        }
        if (!proposal) {
            if (typeof showEphemeralMessage === 'function') {
                showEphemeralMessage(t('ephemeral.messages.cannot_share_this_proposal_right_now', 'Cannot share this proposal right now.'), 4000, 'error');
            }
            return;
        }

        // If the proposal is already minted, still show the full share modal
        // (the upload modal handles minted state in the mint row UI)

        const parentParcelIdsForShare = collectProposalParentParcelIdsForShare(proposal);
        const nonOriginalParcels = checkParcelsOriginal(parentParcelIdsForShare);
        if (nonOriginalParcels.length > 0) {
            showNonOriginalParcelShareBlockedModal(proposal, parentParcelIdsForShare);
            return;
        }

        showUploadProposalModal(proposal);
    } catch (error) {
        console.error('shareSingleProposal failed', error);
        if (typeof showEphemeralMessage === 'function') {
            const t = getProposalI18nHelper();
            showEphemeralMessage(t('ephemeral.messages.unable_to_generate_share_link', 'Unable to generate share link.'), 5000, 'error');
        }
    }
}

// Share helper for Proposal Details: always prefer the proposal currently shown
function shareProposalFromDetails() {
    try {
        if (currentProposalDetailsContext) {
            shareSingleProposal(currentProposalDetailsContext);
            return;
        }

        const panel = document.getElementById('proposal-details-content');
        const idElement = panel ? panel.querySelector('[data-proposal-id]') : null;
        const fallbackId = idElement ? idElement.getAttribute('data-proposal-id') : null;
        shareSingleProposal(fallbackId);
    } catch (error) {
        console.error('shareProposalFromDetails failed', error);
        shareSingleProposal(null);
    }
}
window.shareProposalFromDetails = shareProposalFromDetails;

// Focused dialog used as a gate before the 3D walk-mode launcher: lists every
// applied proposal that does not yet have a numeric server-side ID, lets the
// user upload one-by-one or all-at-once, and auto-closes + fires `onComplete`
// the moment the list is empty so the walk pick can start without an extra click.
function showWalkUploadGateModal(options = {}) {
    try {
        if (typeof proposalStorage === 'undefined' || typeof showSimpleShareModal !== 'function') return null;
        const onComplete = typeof options.onComplete === 'function' ? options.onComplete : null;

        const isUploaded = (proposal) => {
            try { return !!getSerialProposalId(proposal); } catch (_) { return false; }
        };

        const allApplied = proposalStorage.getAllProposals().filter(isProposalCurrentlyApplied);
        const initialNonUploaded = allApplied.filter(p => !isUploaded(p));
        if (initialNonUploaded.length === 0) {
            if (onComplete) { try { onComplete(); } catch (_) { } }
            return null;
        }

        const proposalsByKey = new Map();
        initialNonUploaded.forEach(p => {
            const key = (p && p.proposalId) ? String(p.proposalId) : getProposalKey(p);
            if (!key) return;
            proposalsByKey.set(String(key), p);
        });

        const container = document.createElement('div');
        container.style.display = 'flex';
        container.style.flexDirection = 'column';
        container.style.gap = '12px';

        const intro = document.createElement('div');
        intro.style.fontSize = '13px';
        intro.style.color = '#475569';
        intro.textContent = 'These applied proposals are not yet on the server. The walk view loads proposals by their server ID, so they need to be uploaded first. The dialog will close and the walk will start as soon as they all have a server ID.';
        container.appendChild(intro);

        const statusLine = document.createElement('div');
        statusLine.style.minHeight = '18px';
        statusLine.style.color = '#b3261e';
        statusLine.style.fontSize = '12px';
        container.appendChild(statusLine);
        const setStatus = (msg) => { statusLine.textContent = msg || ''; };

        const listWrap = document.createElement('div');
        listWrap.style.maxHeight = '320px';
        listWrap.style.overflowY = 'auto';
        listWrap.style.border = '1px solid #d8ddf0';
        listWrap.style.borderRadius = '8px';
        listWrap.style.padding = '8px';
        listWrap.style.background = '#f9fafb';
        container.appendChild(listWrap);

        const uploadAllRow = document.createElement('div');
        uploadAllRow.style.display = 'flex';
        uploadAllRow.style.justifyContent = 'flex-end';
        uploadAllRow.style.marginTop = '4px';
        const uploadAllBtn = document.createElement('button');
        uploadAllBtn.type = 'button';
        uploadAllBtn.className = 'btn share-modal-primary';
        uploadAllBtn.textContent = 'Upload all';
        uploadAllRow.appendChild(uploadAllBtn);
        container.appendChild(uploadAllRow);

        const modalApi = showSimpleShareModal({
            title: 'Upload before walking',
            body: container
        });

        const rowControls = new Map(); // key -> { row, uploadBtn }
        const rowState = new Map();    // key -> { uploading, uploaded }

        const checkAllUploaded = () => {
            const remaining = Array.from(rowState.values()).filter(s => !s.uploaded);
            if (remaining.length === 0) {
                if (modalApi && typeof modalApi.close === 'function') modalApi.close();
                if (onComplete) {
                    try { onComplete(); } catch (e) { console.warn('walk gate onComplete failed', e); }
                }
            }
        };

        const updateRowVisual = (key) => {
            const ctrl = rowControls.get(key);
            const state = rowState.get(key) || {};
            if (!ctrl) return;
            if (state.uploaded) {
                ctrl.row.style.opacity = '0.55';
                ctrl.uploadBtn.disabled = true;
                ctrl.uploadBtn.textContent = 'Uploaded';
                return;
            }
            ctrl.uploadBtn.disabled = !!state.uploading;
            ctrl.uploadBtn.textContent = state.uploading ? 'Uploading…' : 'Upload';
        };

        const uploadOne = async (key) => {
            const proposal = proposalsByKey.get(key);
            if (!proposal) return false;
            const state = rowState.get(key) || {};
            if (state.uploading || state.uploaded) return !!state.uploaded;

            const gate = await ensureAncestorProposalsUploaded(proposal);
            if (!gate.ok) {
                const missingList = gate.missing.map(e => e.id || (e.hash ? e.hash.slice(0, 8) : '?')).filter(Boolean);
                setStatus(`Upload ancestor proposals first: ${missingList.join(', ')}`);
                return false;
            }

            rowState.set(key, { uploading: true, uploaded: false });
            updateRowVisual(key);
            try {
                const result = await uploadProposalToServer(proposal);
                if (!result || !result.ok) throw new Error((result && result.message) || 'Upload failed');
                const serverId = result.id ? String(result.id) : (result.proposalId ? String(result.proposalId) : null);
                if (!serverId || !/^\d+$/.test(serverId)) throw new Error('Server did not return a numeric id');
                rowState.set(key, { uploading: false, uploaded: true });
                updateRowVisual(key);
                setStatus('');
                return true;
            } catch (error) {
                console.error('walk gate upload failed', error);
                rowState.set(key, { uploading: false, uploaded: false });
                updateRowVisual(key);
                setStatus(error.message || 'Upload failed');
                return false;
            }
        };

        const renderRow = (key, proposal) => {
            const row = document.createElement('div');
            row.style.display = 'flex';
            row.style.alignItems = 'center';
            row.style.justifyContent = 'space-between';
            row.style.gap = '8px';
            row.style.padding = '6px 4px';
            row.style.borderBottom = '1px solid #e7e9f0';

            const left = document.createElement('div');
            left.style.flex = '1';
            left.style.minWidth = '0';
            const title = document.createElement('div');
            title.style.fontSize = '13px';
            title.style.fontWeight = '600';
            title.style.color = '#212744';
            title.style.overflow = 'hidden';
            title.style.textOverflow = 'ellipsis';
            title.style.whiteSpace = 'nowrap';
            title.textContent = proposal.name || proposal.title || (proposal.proposalId || key);
            left.appendChild(title);

            const meta = document.createElement('div');
            meta.style.fontSize = '11px';
            meta.style.color = '#64748b';
            const displayId = proposal.proposalId || getProposalKey(proposal) || 'local';
            meta.textContent = `${displayId} · ${(resolveProposalGoalKey(proposal) || 'proposal')}`;
            left.appendChild(meta);

            const right = document.createElement('div');
            right.style.flexShrink = '0';
            const uploadBtn = document.createElement('button');
            uploadBtn.type = 'button';
            uploadBtn.className = 'btn share-modal-secondary';
            uploadBtn.textContent = 'Upload';
            uploadBtn.addEventListener('click', async () => {
                const ok = await uploadOne(key);
                if (ok) checkAllUploaded();
            });
            right.appendChild(uploadBtn);

            row.appendChild(left);
            row.appendChild(right);
            listWrap.appendChild(row);

            rowControls.set(key, { row, uploadBtn });
            rowState.set(key, { uploading: false, uploaded: false });
        };

        proposalsByKey.forEach((p, k) => renderRow(k, p));

        uploadAllBtn.addEventListener('click', async () => {
            uploadAllBtn.disabled = true;
            try {
                const pending = Array.from(rowState.entries())
                    .filter(([, s]) => !s.uploaded && !s.uploading)
                    .map(([k]) => k);
                for (const key of pending) {
                    if (!rowState.get(key).uploaded) await uploadOne(key);
                }
            } finally {
                uploadAllBtn.disabled = false;
            }
            checkAllUploaded();
        });

        return modalApi;
    } catch (error) {
        console.error('showWalkUploadGateModal failed', error);
        if (typeof showEphemeralMessage === 'function') {
            showEphemeralMessage('Failed to open upload dialog.', 5000, 'error');
        }
        return null;
    }
}

if (typeof window !== 'undefined') {
    window.showWalkUploadGateModal = showWalkUploadGateModal;
}


/**
 * True only when a proposal is marked applied AND its listed descendants are actually on the map.
 *
 * This matters for the /proposals/:id deep-link flow: a proposal can sit in localStorage with
 * status=applied from a prior session, but on a fresh page load parcelLayerById starts empty
 * and the descendants exist only as ids in the stored proposal. In that state, treating the
 * proposal as "already applied" causes handleSharedPlanRoute to skip apply entirely — the
 * descendants never materialize. Callers on the apply-gating path should use this helper
 * instead of isProposalCurrentlyApplied so the short-circuit only fires when there is
 * actually nothing to do.
 */

function buildSharedProposalsPayload(appliedProposals) {
    if (!Array.isArray(appliedProposals) || appliedProposals.length === 0) {
        return null;
    }

    const featuresForBounds = [];
    const sanitized = appliedProposals.map(proposal => {
        const parentIdsSet = new Set();

        const goalKey = resolveProposalGoalKey(proposal) || null;

        const sanitizedProposal = {
            proposalId: proposal.proposalId,
            goal: goalKey,
            title: proposal.title || '',
            description: proposal.description || '',
            author: proposal.author || '',
            createdAt: proposal.createdAt || new Date().toISOString(),
            updatedAt: proposal.updatedAt || proposal.createdAt || new Date().toISOString(),
            offer: typeof proposal.offer === 'number' ? proposal.offer : (proposal.offer || null),
            parcelIds: ensureArrayOfStrings(proposal.parentParcelIds),
            acceptedParcelIds: ensureArrayOfStrings(proposal.acceptedParcelIds),
            color: proposal.color || null,
            status: 'Applied',
            minted: isProposalMinted(proposal),
            onchain: proposal.onchain ? {
                transactionHash: proposal.onchain.transactionHash || null,
                proposalId: proposal.onchain.proposalId || null,
                chainId: proposal.onchain.chainId || null,
                contractAddress: proposal.onchain.contractAddress || null,
                metadataUri: proposal.onchain.metadataUri || null,
                metadataUrl: proposal.onchain.metadataUrl || null,
                imageUri: proposal.onchain.imageUri || null,
                imageUrl: proposal.onchain.imageUrl || null
            } : null
        };

        // Ancestors will be computed per proposal type below (prefer true parents)
        const lensEntries = normalizeLensEntries(proposal.lens || proposal.lensEntries || proposal.lensAddresses);
        if (lensEntries.length) {
            sanitizedProposal.lens = lensEntries;
        }

        if (proposal.roadProposal) {
            const childParcelIds = ensureArrayOfStrings(proposal.roadProposal.childParcelIds || []);
            childParcelIds.forEach(id => {
                const feature = getParcelFeatureForHighlight(id, proposal);
                if (feature) featuresForBounds.push(feature);
            });

            // Extract parent parcel IDs (not full geometries)
            const parentIds = (function () {
                if (Array.isArray(proposal.roadProposal.parentParcelIds)) {
                    return ensureArrayOfStrings(proposal.roadProposal.parentParcelIds);
                }
                return [];
            })();
            parentIds.forEach(id => parentIdsSet.add(id));

            sanitizedProposal.roadProposal = {
                definition: deepClone(proposal.roadProposal.definition),
                childParcelIds,
                roadGeometry: deepClone(proposal.roadProposal.roadGeometry),
                metadata: deepClone(proposal.roadProposal.metadata),
                id: proposal.roadProposal.id || proposal.roadProposal.proposalId || undefined,
                parentParcelIds: parentIds // IDs only, not full geometries
                // Note: parentFeatures is intentionally excluded - will be fetched on load
            };
        }

        if (proposal.buildingProposal) {
            const buildingFeature = proposal.buildingProposal.buildingFeature
                ? deepClone(proposal.buildingProposal.buildingFeature)
                : null;
            if (buildingFeature) {
                featuresForBounds.push(buildingFeature);
            }

            const parentIds = ensureArrayOfStrings(proposal.buildingProposal.parentParcelIds);
            parentIds.forEach(id => parentIdsSet.add(id));

            sanitizedProposal.buildingProposal = {
                parameters: deepClone(proposal.buildingProposal.parameters) || {},
                parentParcelIds: parentIds,
                parentParcelNumbers: deepCloneArray(proposal.buildingProposal.parentParcelNumbers),
                ancestorKey: proposal.buildingProposal.ancestorKey || parentIds.join('|'),
                buildingFeature,
                metadata: deepClone(proposal.buildingProposal.metadata)
            };
        } else if (proposal.buildingGeometry) {
            const buildingFeature = {
                type: 'Feature',
                geometry: deepClone(proposal.buildingGeometry),
                properties: deepClone(proposal.buildingProperties) || {}
            };
            featuresForBounds.push(buildingFeature);
            const parentIds = ensureArrayOfStrings(proposal.parentParcelIds);
            parentIds.forEach(id => parentIdsSet.add(id));
            sanitizedProposal.buildingProposal = {
                parameters: {},
                parentParcelIds: parentIds,
                parentParcelNumbers: [],
                ancestorKey: parentIds.join('|'),
                buildingFeature
            };
        }

        // Structure proposals
        if (proposal.structureProposal) {
            const sp = proposal.structureProposal;
            // Collect for bounds
            if (sp.geometry) {
                try { featuresForBounds.push({ type: 'Feature', geometry: deepClone(sp.geometry), properties: { structureKind: sp.kind || 'square' } }); } catch (_) { }
            }
            // Parents
            const parentIds = ensureArrayOfStrings(sp.parentParcelIds && sp.parentParcelIds.length ? sp.parentParcelIds : proposal.parentParcelIds);
            parentIds.forEach(id => parentIdsSet.add(id));

            sanitizedProposal.structureProposal = {
                kind: sp.kind || 'square',
                geometry: deepClone(sp.geometry),
                blockName: sp.blockName || null,
                parentParcelIds: parentIds
            };
        }

        if (proposal.reparcellization && Array.isArray(proposal.reparcellization.polygons) && proposal.reparcellization.polygons.length > 0) {
            const reparcelParcelIds = ensureArrayOfStrings(proposal.reparcellization.parcelIds && proposal.reparcellization.parcelIds.length > 0
                ? proposal.reparcellization.parcelIds
                : proposal.parentParcelIds);
            reparcelParcelIds.forEach(id => parentIdsSet.add(id));

            const clonedOwnerShares = deepCloneArray(proposal.reparcellization.ownerShares);
            const clonedPolygons = deepCloneArray(proposal.reparcellization.polygons);

            sanitizedProposal.goal = 'reparcellization';
            sanitizedProposal.reparcellization = {
                algorithm: proposal.reparcellization.algorithm || 'sweep-line',
                generatedAt: proposal.reparcellization.generatedAt || proposal.updatedAt || proposal.createdAt || new Date().toISOString(),
                parcelIds: reparcelParcelIds.slice(),
                totalArea: Number.isFinite(Number(proposal.reparcellization.totalArea))
                    ? Number(proposal.reparcellization.totalArea)
                    : null,
                ownerShares: clonedOwnerShares,
                polygons: clonedPolygons,
                status: 'unapplied'
            };

            clonedPolygons.forEach(slice => {
                if (!slice || !slice.geometry) return;
                try {
                    featuresForBounds.push({
                        type: 'Feature',
                        properties: {
                            ownerKey: slice.ownerKey || null,
                            displayName: slice.displayName || null,
                            color: slice.color || null,
                            percent: slice.percent || null
                        },
                        geometry: deepClone(slice.geometry)
                    });
                } catch (err) {
                    console.warn('Failed to include reparcellization slice in shared payload bounds', err);
                }
            });
        }

        // If no explicit parents were collected, fall back to this proposal's parentParcelIds
        if (parentIdsSet.size === 0) {
            ensureArrayOfStrings(proposal.parentParcelIds).forEach(id => parentIdsSet.add(id));
        }
        const parentIds = Array.from(parentIdsSet).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
        sanitizedProposal.parentParcelIds = parentIds;

        return sanitizedProposal;
    });

    const camera = (typeof map !== 'undefined' && map && typeof map.getCenter === 'function')
        ? { lat: map.getCenter().lat, lng: map.getCenter().lng, zoom: map.getZoom() }
        : null;

    const bbox = computeSharedBoundingBoxFromFeatures(featuresForBounds) || (function () {
        if (typeof map !== 'undefined' && map && typeof map.getBounds === 'function') {
            const bounds = map.getBounds();
            return {
                west: bounds.getWest(),
                south: bounds.getSouth(),
                east: bounds.getEast(),
                north: bounds.getNorth()
            };
        }
        return null;
    })();

    return {
        version: SHARE_PAYLOAD_VERSION,
        generatedAt: new Date().toISOString(),
        author: (typeof getCurrentUsername === 'function' && getCurrentUsername())
            ? getCurrentUsername()
            : (appliedProposals[0]?.author || 'Unknown'),
        proposals: sanitized,
        bbox,
        camera
    };
}

function deepClone(value) {
    try {
        if (value === undefined) return undefined;
        return JSON.parse(JSON.stringify(value));
    } catch (_) {
        return null;
    }
}

function deepCloneArray(values) {
    if (!Array.isArray(values)) return [];
    return values.map(item => deepClone(item));
}

function ensureArrayOfStrings(list) {
    if (!Array.isArray(list)) return [];
    return list
        .map(value => {
            if (value === null || value === undefined) return '';
            try {
                return value.toString();
            } catch (_) {
                return '';
            }
        })
        .filter(Boolean);
}

// Note: Do not normalize parcel IDs here; suffixes carry semantic meaning in this dataset

// Simple HTML escape to safely insert dynamic strings into innerHTML
function escapeHtml(str) {
    try {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    } catch (_) {
        return '';
    }
}

// PARCEL_NUMBER_PROPERTY_CANDIDATES is defined in proposals/sharing.js



function decodeSharedPayload(encoded) {
    if (!encoded) return null;
    let working = encoded.trim();
    let compressionMode = 'legacy';
    if (working.startsWith(SHARE_ENCODING_PREFIX_COMPRESSED)) {
        compressionMode = 'compressed';
        working = working.slice(SHARE_ENCODING_PREFIX_COMPRESSED.length);
    } else if (working.startsWith(SHARE_ENCODING_PREFIX_RAW)) {
        compressionMode = 'raw';
        working = working.slice(SHARE_ENCODING_PREFIX_RAW.length);
    }
    try {
        if (SHARE_BASE64_ALLOWED.test(working)) {
            const bytes = base64UrlDecodeToBytes(working);
            let decodedBytes = bytes;
            if (compressionMode === 'compressed') {
                decodedBytes = inflateBytes(bytes, { strict: true });
            } else if (compressionMode === 'legacy') {
                const inflated = inflateBytes(bytes, { strict: false });
                if (inflated && inflated.length) {
                    decodedBytes = inflated;
                }
            }
            const json = decodeBytesToJson(decodedBytes);
            return JSON.parse(json);
        }

        if (compressionMode === 'compressed') {
            throw new Error('Compressed shared payload is not base64 encoded.');
        }

        const json = decodeURIComponent(working);
        return JSON.parse(json);
    } catch (error) {
        console.error('decodeSharedPayload failed', error);
        throw error;
    }
}

function computeSharedBoundingBoxFromFeatures(features) {
    if (!Array.isArray(features) || features.length === 0) {
        return null;
    }

    let west = Infinity;
    let east = -Infinity;
    let south = Infinity;
    let north = -Infinity;

    features.forEach(feature => {
        if (!feature) return;
        const geometry = feature.type === 'Feature' ? feature.geometry : feature;
        collectCoordinatesFromGeometry(geometry, (lng, lat) => {
            if (!Number.isFinite(lng) || !Number.isFinite(lat)) return;
            if (lng < west) west = lng;
            if (lng > east) east = lng;
            if (lat < south) south = lat;
            if (lat > north) north = lat;
        });
    });

    if (!Number.isFinite(west) || !Number.isFinite(east) || !Number.isFinite(south) || !Number.isFinite(north)) {
        return null;
    }

    const padding = 0.0005;
    return {
        west: west - padding,
        south: south - padding,
        east: east + padding,
        north: north + padding
    };
}


function showShareLinkModal(shareUrl, payload, options = {}) {
    if (typeof document === 'undefined') return;

    const t = getProposalI18nHelper();
    const tShare = getShareI18nHelper();
    const proposals = Array.isArray(payload?.proposals) ? payload.proposals : [];
    const proposalCount = proposals.length;
    const proposalSuffix = proposalCount === 1 ? '' : 's';
    const fragment = document.createDocumentFragment();

    if (options && options.nearLimit) {
        const warning = document.createElement('p');
        warning.style.color = '#b00020';
        warning.style.fontWeight = '600';
        warning.textContent = tShare('sizeWarning', 'Warning: This link is close to the maximum size the server accepts. Consider sharing fewer parcels if it fails.');
        fragment.appendChild(warning);
    }

    const intro = document.createElement('p');
    const introParams = (options && options.introParams) || { count: proposalCount, suffix: proposalSuffix };
    intro.innerHTML = (options && options.introHtml)
        ? options.introHtml
        : tShare('defaultIntro', 'Share this link to load {{count}} applied proposal{{suffix}}.', introParams);
    fragment.appendChild(intro);

    const textarea = document.createElement('textarea');
    textarea.className = 'share-modal-link';
    textarea.value = shareUrl;
    textarea.setAttribute('readonly', 'readonly');
    fragment.appendChild(textarea);

    const info = document.createElement('p');
    const unknownText = t('common.unknown', 'Unknown');
    const zoomValue = payload?.camera && typeof payload.camera.zoom === 'number'
        ? payload.camera.zoom
        : unknownText;
    const encodedLength = (options && typeof options.encodedLength === 'number') ? options.encodedLength : null;
    const contentLabel = tShare('stats.contentLabel', 'Content:');
    const sizeLabel = tShare('stats.sizeLabel', 'Size:');
    const authorLabel = tShare('authorLabel', 'Author:');
    const cameraLabel = tShare('cameraLabel', 'Camera zoom:');
    const proposalsLabel = tShare('proposalsLabel', 'Proposals:');
    const sizeStats = (function () {
        try {
            const totalProposals = proposalCount;
            const roadCount = proposals.filter(p => p.roadProposal).length;
            const buildingCount = proposals.filter(p => p.buildingProposal).length;
            const parcelCount = proposals.reduce((sum, p) => sum + (Array.isArray(p.parentParcelIds) ? p.parentParcelIds.length : 0), 0);
            const estimatedBytes = encodedLength !== null
                ? encodedLength
                : (typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(JSON.stringify(payload)).length : JSON.stringify(payload).length);
            const kb = (estimatedBytes / 1024).toFixed(1);
            const maxKb = (SHARE_URL_MAX_LENGTH / 1024).toFixed(1);
            const contentSummary = tShare('stats.contentSummary', '{{total}} proposals • {{roads}} roads • {{buildings}} buildings • {{parcels}} parcels', {
                total: totalProposals,
                roads: roadCount,
                buildings: buildingCount,
                parcels: parcelCount
            });
            const sizeSummary = tShare('stats.sizeSummary', '~{{kb}} KB of encoded link (server limit ~{{maxKb}} KB)', {
                kb,
                maxKb
            });
            return `<br><strong>${contentLabel}</strong> ${contentSummary}` +
                `<br><strong>${sizeLabel}</strong> ${sizeSummary}`;
        } catch (_) { return ''; }
    })();
    const authorText = payload?.author || unknownText;
    const safeAuthor = typeof escapeHtml === 'function' ? escapeHtml(authorText) : authorText;
    info.innerHTML = `<strong>${authorLabel}</strong> ${safeAuthor}<br><strong>${cameraLabel}</strong> ${zoomValue}<br><strong>${proposalsLabel}</strong> ${proposalCount}${sizeStats}`;
    fragment.appendChild(info);

    const note = document.createElement('p');
    note.style.color = '#555';
    note.innerHTML = tShare('note', 'Server-backed sharing is coming soon. JSON export is provided for archival/manual sharing; future compatibility is not guaranteed.');
    fragment.appendChild(note);

    const modal = showSimpleShareModal({
        title: tShare('title', 'Share Proposal'),
        body: fragment,
        actions: [
            {
                label: tShare('saveJson', 'Save as JSON'),
                onClick: () => {
                    try { savePlanPayloadAsJson(payload); } catch (e) { console.warn('Save JSON failed', e); }
                }
            },
            {
                label: tShare('copyLink', 'Copy Link'),
                primary: true,
                onClick: () => {
                    if (navigator.clipboard && navigator.clipboard.writeText) {
                        navigator.clipboard.writeText(shareUrl).then(() => {
                            if (typeof showEphemeralMessage === 'function') {
                                showEphemeralMessage(tShare('copySuccess', 'Share link copied to clipboard!'));
                            }
                        }).catch(() => {
                            textarea.focus();
                            textarea.select();
                        });
                    } else {
                        textarea.focus();
                        textarea.select();
                    }
                }
            }
        ]
    });

    if (modal && textarea) {
        setTimeout(() => {
            textarea.focus();
            textarea.select();
        }, 75);
    }
}

function showShareTooLargeModal() {
    const t = getProposalI18nHelper();
    const tShare = getShareI18nHelper();
    showSimpleShareModal({
        title: tShare('tooLargeTitle', 'Proposal Set Too Large'),
        body: `<p>${tShare('tooLargeBody', 'Links are limited to roughly 7.5 KB on the server, so this proposal set cannot be embedded in the URL. Reduce the number of parcels/proposals or use the JSON export while we finish server-side sharing.')}</p>`,
        actions: [{ label: t('modal.common.close', 'Close'), primary: true }]
    });
}

function resolveBackendBaseUrl() {
    if (typeof global !== 'undefined' && typeof global.getBackendBase === 'function') {
        return global.getBackendBase();
    }
    if (typeof window !== 'undefined' && typeof window.getBackendBase === 'function') {
        return window.getBackendBase();
    }
    const hostname = (typeof window !== 'undefined' && window.location && window.location.hostname)
        ? window.location.hostname.toLowerCase()
        : '';
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0' || hostname.endsWith('.local')) {
        return 'http://localhost:3000';
    }
    return 'https://api.urbangametheory.xyz';
}

function resolveFrontendBaseUrl() {
    if (typeof window === 'undefined' || !window.location) {
        return 'https://urbangametheory.xyz';
    }
    const hostname = window.location.hostname.toLowerCase();
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0' || hostname.endsWith('.local')) {
        return `${window.location.protocol}//${window.location.host}`;
    }
    return 'https://urbangametheory.xyz';
}









function showUploadProposalModal(proposal) {
    if (typeof document === 'undefined' || !proposal) return;

    const t = getProposalI18nHelper();
    const tShare = getShareI18nHelper();

    // Get frontend base URL (urbangametheory.xyz or localhost)
    const fragment = document.createDocumentFragment();

    const uploadSuccessText = tShare('uploadSuccess', 'Proposal uploaded! You can now share it with others');
    const uploadButtonLabel = tShare('uploadButton', 'Upload');
    const connectWalletLabel = tShare('connectWalletButton', 'Connect Wallet');
    const mintActionLabel = tShare('mintButton', 'Mint');
    const downloadButtonLabel = tShare('downloadButton', 'Download');

    // Rows container for stable layout
    const rowsContainer = document.createElement('div');
    rowsContainer.style.display = 'flex';
    rowsContainer.style.flexDirection = 'column';
    rowsContainer.style.gap = '0.75rem';
    rowsContainer.style.marginBottom = '1.25rem';

    // Upload row
    const uploadRow = document.createElement('div');
    uploadRow.style.display = 'flex';
    uploadRow.style.gap = '0.5rem';
    uploadRow.style.alignItems = 'center';
    uploadRow.style.width = '100%';

    const uploadButton = document.createElement('button');
    uploadButton.type = 'button';
    uploadButton.className = 'btn share-modal-primary';
    uploadButton.textContent = uploadButtonLabel;
    uploadButton.style.flex = '1';
    uploadButton.style.display = 'flex';
    uploadButton.style.justifyContent = 'center';
    uploadButton.style.alignItems = 'center';
    uploadButton.style.textAlign = 'center';
    uploadRow.appendChild(uploadButton);

    const uploadLinkGroup = document.createElement('div');
    uploadLinkGroup.style.display = 'none';
    uploadLinkGroup.style.flex = '1';
    uploadLinkGroup.style.gap = '0.5rem';
    uploadLinkGroup.style.alignItems = 'center';
    uploadLinkGroup.style.minWidth = '0';
    uploadLinkGroup.style.width = '100%';

    const urlInput = document.createElement('input');
    urlInput.type = 'text';
    urlInput.readOnly = true;
    urlInput.className = 'share-modal-link';
    urlInput.style.flex = '1';
    urlInput.style.padding = '0.5rem 0.75rem';
    urlInput.style.border = '1px solid #d8ddf0';
    urlInput.style.borderRadius = '8px';
    urlInput.style.height = 'auto';
    urlInput.style.lineHeight = '1.5';
    urlInput.style.minHeight = '38px';
    urlInput.style.maxHeight = '38px';
    urlInput.style.fontSize = '13px';
    urlInput.style.fontFamily = 'inherit';
    urlInput.style.background = '#f7f8fb';
    urlInput.style.color = '#212744';
    urlInput.style.boxSizing = 'border-box';

    const copyButton = document.createElement('button');
    copyButton.type = 'button';
    copyButton.className = 'btn share-modal-secondary';
    copyButton.textContent = tShare('copyUrlButton', 'Copy URL');
    copyButton.style.height = '38px';
    copyButton.style.minHeight = '38px';
    copyButton.style.maxHeight = '38px';
    copyButton.style.padding = '0.5rem 1rem';
    copyButton.style.lineHeight = '1.5';
    copyButton.style.whiteSpace = 'nowrap';
    copyButton.style.textAlign = 'center';
    copyButton.addEventListener('click', () => {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(urlInput.value).then(() => {
                if (typeof showEphemeralMessage === 'function') {
                    showEphemeralMessage(tShare('copySuccess', 'Share link copied to clipboard!'));
                }
            }).catch(() => {
                urlInput.focus();
                urlInput.select();
            });
        } else {
            urlInput.focus();
            urlInput.select();
        }
    });

    uploadLinkGroup.appendChild(urlInput);
    uploadLinkGroup.appendChild(copyButton);
    uploadRow.appendChild(uploadLinkGroup);
    rowsContainer.appendChild(uploadRow);

    // Mint row
    const mintRow = document.createElement('div');
    mintRow.style.display = 'flex';
    mintRow.style.gap = '0.5rem';
    mintRow.style.alignItems = 'center';
    mintRow.style.width = '100%';

    const mintButton = document.createElement('button');
    mintButton.type = 'button';
    mintButton.className = 'btn share-modal-primary';
    mintButton.style.flex = '1';
    mintButton.style.display = 'flex';
    mintButton.style.justifyContent = 'center';
    mintButton.style.alignItems = 'center';
    mintButton.style.textAlign = 'center';
    mintRow.appendChild(mintButton);

    const mintedLinkGroup = document.createElement('div');
    mintedLinkGroup.style.display = 'none';
    mintedLinkGroup.style.flex = '1';
    mintedLinkGroup.style.gap = '0.5rem';
    mintedLinkGroup.style.alignItems = 'center';
    mintedLinkGroup.style.minWidth = '0';
    mintedLinkGroup.style.width = '100%';

    const mintedLinkInput = document.createElement('input');
    mintedLinkInput.type = 'text';
    mintedLinkInput.readOnly = true;
    mintedLinkInput.className = 'share-modal-link';
    mintedLinkInput.style.flex = '1';
    mintedLinkInput.style.padding = '0.5rem 0.75rem';
    mintedLinkInput.style.border = '1px solid #d8ddf0';
    mintedLinkInput.style.borderRadius = '8px';
    mintedLinkInput.style.height = 'auto';
    mintedLinkInput.style.lineHeight = '1.5';
    mintedLinkInput.style.minHeight = '38px';
    mintedLinkInput.style.maxHeight = '38px';
    mintedLinkInput.style.fontSize = '13px';
    mintedLinkInput.style.fontFamily = 'inherit';
    mintedLinkInput.style.background = '#f7f8fb';
    mintedLinkInput.style.color = '#212744';
    mintedLinkInput.style.boxSizing = 'border-box';

    const mintedCopyButton = document.createElement('button');
    mintedCopyButton.type = 'button';
    mintedCopyButton.className = 'btn share-modal-secondary';
    mintedCopyButton.textContent = tShare('copyUrlButton', 'Copy URL');
    mintedCopyButton.style.height = '38px';
    mintedCopyButton.style.minHeight = '38px';
    mintedCopyButton.style.maxHeight = '38px';
    mintedCopyButton.style.padding = '0.5rem 1rem';
    mintedCopyButton.style.lineHeight = '1.5';
    mintedCopyButton.style.whiteSpace = 'nowrap';
    mintedCopyButton.style.textAlign = 'center';
    mintedCopyButton.addEventListener('click', () => {
        if (!mintedLinkInput.value) return;
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(mintedLinkInput.value).then(() => {
                if (typeof showEphemeralMessage === 'function') {
                    showEphemeralMessage(tShare('copySuccess', 'Share link copied to clipboard!'));
                }
            }).catch(() => {
                mintedLinkInput.focus();
                mintedLinkInput.select();
            });
        } else {
            mintedLinkInput.focus();
            mintedLinkInput.select();
        }
    });

    mintedLinkGroup.appendChild(mintedLinkInput);
    mintedLinkGroup.appendChild(mintedCopyButton);
    mintRow.appendChild(mintedLinkGroup);
    rowsContainer.appendChild(mintRow);

    // Download row
    const downloadRow = document.createElement('div');
    downloadRow.style.display = 'flex';
    downloadRow.style.alignItems = 'center';
    downloadRow.style.width = '100%';

    const downloadButton = document.createElement('button');
    downloadButton.type = 'button';
    downloadButton.className = 'btn share-modal-secondary';
    downloadButton.textContent = downloadButtonLabel;
    downloadButton.style.flex = '1';
    downloadButton.style.textAlign = 'center';
    downloadRow.appendChild(downloadButton);

    rowsContainer.appendChild(downloadRow);
    fragment.appendChild(rowsContainer);

    // Status message container
    const uploadStatus = document.createElement('div');
    uploadStatus.style.marginBottom = '0.75rem';
    uploadStatus.style.fontSize = '12px';
    uploadStatus.style.color = '#b3261e';
    uploadStatus.style.lineHeight = '1.4';
    fragment.appendChild(uploadStatus);

    const shareActionsContainer = document.createElement('div');
    shareActionsContainer.className = 'share-modal-share-actions';
    shareActionsContainer.style.display = 'none';
    shareActionsContainer.style.marginTop = '1rem';
    shareActionsContainer.style.width = '100%';

    const shareLabel = document.createElement('div');
    shareLabel.textContent = tShare('shareViaLabel', 'Share via');
    shareLabel.style.fontWeight = '600';
    shareLabel.style.marginBottom = '0.5rem';
    shareActionsContainer.appendChild(shareLabel);

    const shareButtonsRow = document.createElement('div');
    shareButtonsRow.style.display = 'flex';
    shareButtonsRow.style.gap = '0.5rem';
    shareButtonsRow.style.flexWrap = 'wrap';
    shareButtonsRow.style.width = '100%';

    const tweetButton = document.createElement('button');
    tweetButton.type = 'button';
    tweetButton.className = 'btn share-modal-secondary';
    tweetButton.textContent = tShare('tweetButton', 'Tweet this proposal');
    tweetButton.style.flex = '1 1 0';
    tweetButton.style.minWidth = '0';
    tweetButton.style.textAlign = 'center';
    tweetButton.addEventListener('click', () => {
        const urlToShare = urlInput.value || '';
        if (!urlToShare) return;
        const tweetText = tShare('tweetText', 'I have created a new urban proposal!');
        const tweetUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(tweetText)}&url=${encodeURIComponent(urlToShare)}`;
        window.open(tweetUrl, '_blank', 'noopener,noreferrer');
    });
    shareButtonsRow.appendChild(tweetButton);

    const nativeShareButton = document.createElement('button');
    nativeShareButton.type = 'button';
    nativeShareButton.className = 'btn share-modal-secondary';
    nativeShareButton.textContent = tShare('nativeShareButton', 'Share...');
    nativeShareButton.style.flex = '1 1 0';
    nativeShareButton.style.minWidth = '0';
    nativeShareButton.style.textAlign = 'center';
    nativeShareButton.addEventListener('click', async () => {
        const urlToShare = urlInput.value || '';
        const shareText = tShare('tweetText', 'I have created a new urban proposal!');
        if (navigator.share && urlToShare) {
            try {
                await navigator.share({
                    title: tShare('title', 'Share Proposal'),
                    text: shareText,
                    url: urlToShare
                });
            } catch (err) {
                console.warn('Native share failed', err);
            }
            return;
        }

        if (navigator.clipboard && navigator.clipboard.writeText && urlToShare) {
            navigator.clipboard.writeText(urlToShare).then(() => {
                if (typeof showEphemeralMessage === 'function') {
                    showEphemeralMessage(tShare('copySuccess', 'Share link copied to clipboard!'));
                }
            }).catch(() => {
                urlInput.focus();
                urlInput.select();
            });
        } else {
            urlInput.focus();
            urlInput.select();
        }
    });
    shareButtonsRow.appendChild(nativeShareButton);

    shareActionsContainer.appendChild(shareButtonsRow);
    fragment.appendChild(shareActionsContainer);

    const cityQueryParam = buildCityQueryParam();
    let uploadedId = null;
    let shareUrl = null;
    let mintedExplorerUrl = null;

    const isWalletConnected = () => {
        if (!window.walletManager || typeof window.walletManager.getState !== 'function') return false;
        const walletState = window.walletManager.getState();
        return walletState && walletState.status === 'connected'
            && Array.isArray(walletState.accounts) && walletState.accounts.length > 0;
    };

    const computeShareUrlFromProposal = () => {
        try {
            const serverId = typeof getServerProposalId === 'function'
                ? getServerProposalId(proposal)
                : (proposal && (proposal.serverProposalId || proposal.id));
            if (serverId && /^\d+$/.test(String(serverId))) {
                return `${resolveFrontendBaseUrl()}/proposals/${serverId}${cityQueryParam}`;
            }
            return null;
        } catch (err) {
            console.warn('Failed to compute share URL', err);
            return null;
        }
    };

    const updateUploadRowUi = () => {
        shareUrl = computeShareUrlFromProposal() || shareUrl;
        const hasShareUrl = !!shareUrl;
        uploadButton.style.display = hasShareUrl ? 'none' : 'inline-flex';
        uploadLinkGroup.style.display = hasShareUrl ? 'flex' : 'none';
        urlInput.value = shareUrl || '';
        shareActionsContainer.style.display = hasShareUrl ? 'block' : 'none';
    };

    const refreshMintRowUi = () => {
        const existingNft = typeof getProposalNftInfo === 'function' ? getProposalNftInfo(proposal) : null;
        const hasMinted = existingNft && existingNft.tokenId;
        if (hasMinted) {
            mintedExplorerUrl = typeof buildProposalNftExplorerUrl === 'function' ? buildProposalNftExplorerUrl(proposal) : '';
            const fallbackLink = existingNft && existingNft.tokenId ? String(existingNft.tokenId) : '';
            mintedLinkInput.value = mintedExplorerUrl || fallbackLink;
            mintButton.style.display = 'none';
            mintedLinkGroup.style.display = 'flex';
            mintButton.disabled = true;
            return;
        }

        mintedExplorerUrl = null;
        mintedLinkInput.value = '';
        mintButton.style.display = 'inline-flex';
        mintedLinkGroup.style.display = 'none';
        mintButton.disabled = false;

        const connected = isWalletConnected();
        mintButton.textContent = connected
            ? tShare('mintButton', 'Mint')
            : tShare('connectWalletButton', 'Connect Wallet');
    };

    refreshMintRowUi();
    updateUploadRowUi();

    // Keep mint button label in sync with wallet state (only if not minted)
    let detachWalletStateListener = null;
    let lastWalletConnected = isWalletConnected();
    const handleWalletStateChange = () => {
        const connected = isWalletConnected();
        const justConnected = connected && !lastWalletConnected;
        lastWalletConnected = connected;
        refreshMintRowUi();
        if (justConnected && uploadStatus) {
            uploadStatus.style.color = '#2b3954';
            uploadStatus.textContent = tShare('walletConnectedStatus', 'Wallet connected. You can proceed to mint the proposal');
        }
    };
    if (window.walletManager && typeof window.walletManager.on === 'function') {
        detachWalletStateListener = window.walletManager.on('stateChanged', () => handleWalletStateChange());
    }

    async function enforceUploadAncestryGate() {
        try {
            const gate = await ensureAncestorProposalsUploaded(proposal);
            if (!gate.ok) {
                const ancestorList = gate.missing.map(item => item.id || (item.hash ? item.hash.slice(0, 8) : '?')).filter(Boolean);
                const suffix = ancestorList.length === 1 ? '' : 's';
                uploadButton.disabled = true;
                uploadButton.classList.add('disabled');
                uploadButton.title = tShare('uploadAncestorsMissingTitle', 'Upload ancestor proposals first.');
                uploadStatus.textContent = tShare('uploadAncestorsMissing', 'Upload ancestor proposal{{suffix}} first: {{list}}', {
                    suffix,
                    list: ancestorList.join(', ')
                });
            } else {
                uploadButton.disabled = false;
                uploadButton.classList.remove('disabled');
                uploadButton.title = '';
                uploadStatus.textContent = '';
            }
        } catch (error) {
            console.warn('Failed to enforce upload ancestor gate', error);
            uploadButton.disabled = true;
            uploadButton.classList.add('disabled');
            uploadStatus.textContent = tShare('uploadAncestorsCheckFailed', 'Could not verify ancestor uploads. Please retry.');
        }
    }

    enforceUploadAncestryGate();

    // Upload handler
    uploadButton.addEventListener('click', async () => {
        if (uploadButton.disabled) return;

        uploadButton.disabled = true;
        uploadButton.textContent = tShare('uploading', 'Uploading...');
        uploadButton.style.opacity = '0.7';
        uploadButton.style.cursor = 'not-allowed';

        try {
            const uploadProposal = buildUploadReadyProposal(proposal);

            console.log('[showUploadProposalModal] Proposal before upload:', {
                hasRoadProposal: !!uploadProposal?.roadProposal,
                proposalId: uploadProposal?.proposalId,
                city: uploadProposal?.city
            });

            const uploadResult = await uploadProposalToServer(uploadProposal);

            if (!uploadResult.ok) {
                throw new Error(uploadResult.message || tShare('uploadError', 'Failed to upload proposal. Please try again.'));
            }

            // Always use the serial ID (numeric) from the server response, never a hash
            uploadedId = uploadResult.id ? String(uploadResult.id) : (uploadResult.proposalId ? String(uploadResult.proposalId) : null);
            if (!uploadedId || !/^\d+$/.test(uploadedId)) {
                throw new Error(tShare('uploadError', 'Server did not return a valid serial ID. Please try again.'));
            }
            uploadStatus.textContent = uploadSuccessText;
            uploadStatus.style.color = '#2b3954'; // Success: dark text instead of red
            shareUrl = `${resolveFrontendBaseUrl()}/proposals/${uploadedId}${cityQueryParam}`;
            proposal.serverProposalId = uploadedId;

            if (typeof proposalStorage !== 'undefined') {
                const localKey = proposal && (proposal.proposalId || (typeof getProposalKey === 'function' ? getProposalKey(proposal) : null));
                const storedProposal = localKey ? proposalStorage.getProposal(localKey) : null;
                if (storedProposal) {
                    storedProposal.serverProposalId = uploadedId;
                    if (typeof proposalStorage.save === 'function') {
                        proposalStorage.save();
                    }
                }
            }

            urlInput.value = shareUrl;
            updateUploadRowUi();

            // --- NEW: Update details panel and state after upload ---
            // Do not select by numeric server id here (it can collide with on-chain token ids).
            if (typeof proposalStorage !== 'undefined' && typeof proposalStorage.getProposal === 'function') {
                const localKey = proposal && (proposal.proposalId || (typeof getProposalKey === 'function' ? getProposalKey(proposal) : null));
                const newProposal = localKey ? proposalStorage.getProposal(localKey) : null;
                if (newProposal) {
                    // Use the first parent parcel for context; no child fallback
                    const firstParcelId = Array.isArray(newProposal.parentParcelIds) && newProposal.parentParcelIds.length > 0
                        ? newProposal.parentParcelIds[0]
                        : null;
                    const proposalKey = (typeof getProposalKey === 'function' ? getProposalKey(newProposal) : null) || newProposal.proposalId || localKey;
                    if (typeof selectAndHighlightProposal === 'function') {
                        selectAndHighlightProposal(proposalKey, firstParcelId, false, true);
                    } else if (typeof showProposalInfo === 'function') {
                        showProposalInfo(newProposal, firstParcelId);
                    }
                }
            }
            // --- END NEW ---

        } catch (error) {
            console.error('Upload failed:', error);
            uploadButton.disabled = false;
            uploadButton.textContent = uploadButtonLabel;
            uploadButton.style.opacity = '1';
            uploadButton.style.cursor = 'pointer';

            enforceUploadAncestryGate();

            if (typeof showEphemeralMessage === 'function') {
                showEphemeralMessage(error.message || tShare('uploadError', 'Failed to upload proposal. Please try again.'), 5000, 'error');
            }
        }
    });

    // Download JSON handler
    downloadButton.addEventListener('click', () => {
        try {
            const proposalData = buildUploadReadyProposal(proposal);
            if (!proposalData) {
                throw new Error(tShare('downloadError', 'Failed to download proposal'));
            }

            const jsonString = JSON.stringify(proposalData, null, 2);
            const blob = new Blob([jsonString], { type: 'application/json' });
            const url = URL.createObjectURL(blob);

            const downloadLink = document.createElement('a');
            downloadLink.href = url;

            // Generate filename
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const proposalId = proposal.proposalId || 'proposal';
            downloadLink.download = `proposal-${proposalId}-${timestamp}.json`;

            document.body.appendChild(downloadLink);
            downloadLink.click();
            document.body.removeChild(downloadLink);
            URL.revokeObjectURL(url);

            if (typeof showEphemeralMessage === 'function') {
                showEphemeralMessage(tShare('downloadSuccess', 'Proposal downloaded as JSON'), 3000, 'success');
            }
        } catch (error) {
            console.error('Download failed:', error);
            if (typeof showEphemeralMessage === 'function') {
                showEphemeralMessage(error.message || tShare('downloadError', 'Failed to download proposal'), 5000, 'error');
            }
        }
    });

    // Mint / Connect wallet handler
    mintButton.addEventListener('click', async () => {
        try {
            // If already minted, block re-mint and surface link
            const existingNft = typeof getProposalNftInfo === 'function' ? getProposalNftInfo(proposal) : null;
            if (existingNft && existingNft.tokenId) {
                refreshMintRowUi();
                mintButton.disabled = true;
                mintButton.textContent = tShare('alreadyMinted', 'Already minted');
                const explorerUrl = typeof buildProposalNftExplorerUrl === 'function' ? buildProposalNftExplorerUrl(proposal) : null;
                if (uploadStatus) {
                    uploadStatus.style.color = '#2b3954';
                    uploadStatus.innerHTML = explorerUrl
                        ? `${tShare('alreadyMinted', 'Already minted')}. <a href="${explorerUrl}" target="_blank" rel="noopener noreferrer">${tShare('viewOnExplorer', 'View on explorer')}</a>`
                        : tShare('alreadyMinted', 'Already minted');
                }
                return;
            }

            const setMintStatus = (message, opts = {}) => {
                if (!uploadStatus) return;
                const { isError = false, html = false } = opts;
                uploadStatus.style.color = isError ? '#b3261e' : '#2b3954';
                if (html) {
                    uploadStatus.innerHTML = message;
                } else {
                    uploadStatus.textContent = message;
                }
            };

            const walletManager = window.walletManager;

            // Check wallet connection
            const walletConnected = isWalletConnected();

            if (!walletConnected) {
                // Show wallet selector modal (same flow as Agent Details)
                if (window.walletManager && typeof window.walletManager.openConnectorModal === 'function') {
                    window.walletManager.openConnectorModal();
                } else if (typeof showWalletConnectModal === 'function') {
                    showWalletConnectModal();
                } else if (window.walletManager && typeof window.walletManager.connect === 'function') {
                    await window.walletManager.connect();
                } else {
                    throw new Error('Wallet connection functionality not available');
                }
                return;
            }

            // Resolve lens list for minting; rely solely on the current proposal's lens data
            const lensEntries = getProposalLensEntries(proposal, { fallbackToGlobal: false });
            const lensAddresses = lensEntries.map(e => e && e.address).filter(addr => typeof addr === 'string' && addr.trim().length > 0);
            if (!lensAddresses.length) {
                throw new Error('Lens list is required for minting proposals on-chain.');
            }

            // Persist lens on proposal and storage copy
            proposal.lens = lensEntries;
            proposal.lensAddresses = lensAddresses;
            if (typeof proposalStorage !== 'undefined') {
                const key = proposal.proposalId || (typeof getProposalKey === 'function' ? getProposalKey(proposal) : null);
                const stored = key ? proposalStorage.getProposal(key) : null;
                if (stored) {
                    stored.lens = lensEntries;
                    stored.lensAddresses = lensAddresses;
                    if (typeof proposalStorage.save === 'function') {
                        proposalStorage.save();
                    }
                }
            }

            // Trigger the same mint flow as "Create Proposal" button
            // We need to get the parcel IDs from the proposal
            const parcelIds = proposal.parentParcelIds || [];
            if (parcelIds.length === 0) {
                throw new Error('No parcels associated with this proposal');
            }

            // Build a feature map for parcels (used when minting prerequisites to get parcel names)
            const parcelFeatureById = new Map();
            for (const parcelId of parcelIds) {
                const idStr = parcelId && parcelId.toString ? parcelId.toString() : String(parcelId);
                let parcelLayer = null;
                if (typeof multiParcelSelection !== 'undefined' && multiParcelSelection.findParcelById) {
                    parcelLayer = multiParcelSelection.findParcelById(idStr);
                }
                if (!parcelLayer && typeof resolveParcelLayerById === 'function') {
                    parcelLayer = resolveParcelLayerById(idStr);
                }
                if (parcelLayer && parcelLayer.feature) {
                    parcelFeatureById.set(idStr, parcelLayer.feature);
                }
            }

            // Check prerequisite parcel NFTs before minting (mirrors Create Proposal flow)
            if (typeof window.ProposalChainBridge !== 'undefined' && window.ProposalChainBridge.isSupported()) {
                let chainId = null;
                if (walletManager && typeof walletManager.getState === 'function') {
                    const walletState = walletManager.getState();
                    chainId = walletState?.chainId || null;
                }

                if (!chainId) {
                    const globalScope = typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : null);
                    if (globalScope && globalScope.DEFAULT_CHAIN_ID !== undefined && globalScope.DEFAULT_CHAIN_ID !== null) {
                        chainId = globalScope.DEFAULT_CHAIN_ID;
                    } else {
                        const env = globalScope?.current_environment || 'production';
                        chainId = env === 'development' ? '31337' : '84532';
                    }
                }

                try {
                    setMintStatus(tShare('checkingPrereqParcels', 'Checking prerequisite parcels on-chain...'));
                    const parcelCheckResult = await checkParcelsHaveNFTs(parcelIds, chainId);

                    if (!parcelCheckResult.allHaveNFTs && parcelCheckResult.missingParcels.length > 0) {
                        const chainDisplay = parcelCheckResult.chainName || parcelCheckResult.chainId || 'the blockchain';
                        const action = await showMissingParcelsModal(parcelCheckResult.missingParcels, chainDisplay);

                        if (action === 'mint') {
                            const mintableParcels = parcelCheckResult.missingParcels.map((parcelId) => {
                                const idStr = parcelId && parcelId.toString ? parcelId.toString() : String(parcelId);
                                const feature = parcelFeatureById.get(idStr) || null;
                                const props = feature && feature.properties ? feature.properties : {};
                                const parcelName = props.name || props.parcel_name || props.parcel || props.BROJ_CESTICE || `Parcel ${idStr}`;
                                return { parcelId: idStr, parcelName, feature };
                            });

                            try {
                                await openParcelMintModal({
                                    parcels: mintableParcels,
                                    onExit: () => {
                                        setMintStatus(tShare('mintPrereqReminder', 'Mint the prerequisite parcel NFTs, then mint the proposal.'));
                                    }
                                });
                                setMintStatus(tShare('mintPrereqReminder', 'Mint the prerequisite parcel NFTs, then mint the proposal.'));
                            } catch (mintModalError) {
                                console.error('Unable to open mint modal for missing parcels', mintModalError);
                                setMintStatus(tShare('mintPrereqModalFailed', 'Could not open parcel minting. Please mint prerequisites first.'), { isError: true });
                            }
                        } else if (action === 'memory') {
                            setMintStatus(tShare('mintSkippedInMemory', 'Mint skipped. Proposal remains in memory.'), { isError: true });
                        } else {
                            setMintStatus(tShare('mintCancelled', 'Mint cancelled.'), { isError: true });
                        }
                        return;
                    }
                } catch (checkError) {
                    console.error('Failed to verify prerequisite parcel NFTs', checkError);
                    setMintStatus(tShare('mintPrereqCheckFailed', 'Could not verify parcel NFTs. Mint cancelled.'), { isError: true });
                    return;
                }
            }

            // Call the blockchain minting function
            if (typeof window.ProposalChainBridge !== 'undefined' && window.ProposalChainBridge.isSupported()) {
                // Set up the proposal for minting - full flow like Create Proposal
                const blockchainSupported = window.ProposalChainBridge.isSupported();

                if (blockchainSupported) {
                    try {
                        // Step 1: Capture screenshot for the proposal
                        setMintStatus(tShare('mintCapturingImage', 'Capturing proposal image...'));
                        console.log('[shareMint] Starting screenshot capture for proposal:', proposal.proposalId);

                        let screenshotDataUrl = null;

                        // Check if we have a cached screenshot on the proposal
                        if (proposal.screenshotDataUrl && proposal.screenshotDataUrl.startsWith('data:image/')) {
                            screenshotDataUrl = proposal.screenshotDataUrl;
                            console.log('[shareMint] Using cached screenshot from proposal, size:', screenshotDataUrl.length);
                        }

                        // If no cached screenshot, try to capture one
                        if (!screenshotDataUrl) {
                            // Build polygon from parent features or fetch them
                            let parentFeatures = proposal.parentFeatures || [];
                            console.log('[shareMint] Initial parentFeatures count:', parentFeatures.length, 'parcelIds:', parcelIds);

                            if (!parentFeatures.length && Array.isArray(parcelIds) && parcelIds.length > 0) {
                                // Try to get features from parcel layer index
                                for (const pid of parcelIds) {
                                    let layer = null;
                                    // Try findParcelLayerById first (local function)
                                    if (typeof findParcelLayerById === 'function') {
                                        layer = findParcelLayerById(pid);
                                    }
                                    // Fallback to resolveParcelLayerById (global)
                                    if (!layer && typeof resolveParcelLayerById === 'function') {
                                        layer = resolveParcelLayerById(pid);
                                    }
                                    if (layer && layer.feature && layer.feature.geometry) {
                                        parentFeatures.push(layer.feature);
                                        console.log('[shareMint] Found feature for parcel:', pid);
                                    } else {
                                        console.log('[shareMint] No feature found for parcel:', pid);
                                    }
                                }
                            }

                            console.log('[shareMint] Final parentFeatures count:', parentFeatures.length);

                            if (parentFeatures.length > 0 && window.MapScreenshot?.captureViaTileStitch) {
                                // Build combined polygon for screenshot
                                let combinedPolygon = null;
                                const parcelPolygons = [];
                                for (const feature of parentFeatures) {
                                    if (feature && feature.geometry && feature.geometry.coordinates) {
                                        const coords = feature.geometry.coordinates;
                                        if (feature.geometry.type === 'Polygon' && coords[0]) {
                                            parcelPolygons.push(coords[0].map(c => [c[1], c[0]])); // [lat, lng]
                                        } else if (feature.geometry.type === 'MultiPolygon') {
                                            for (const poly of coords) {
                                                if (poly[0]) {
                                                    parcelPolygons.push(poly[0].map(c => [c[1], c[0]]));
                                                }
                                            }
                                        }
                                    }
                                }
                                if (parcelPolygons.length > 0) {
                                    combinedPolygon = parcelPolygons.flat();
                                }

                                if (combinedPolygon && combinedPolygon.length > 0) {
                                    const goalKey = resolveProposalGoalKey(proposal, null) || 'proposal';
                                    const goalBadge = goalKey.replace(/-/g, ' ');
                                    try {
                                        screenshotDataUrl = await window.MapScreenshot.captureViaTileStitch({
                                            polygon: combinedPolygon,
                                            parcelPolygons: parcelPolygons,
                                            padding: 0.12,
                                            zoom: 19,
                                            badge: goalBadge
                                        });
                                        console.log('[shareMint] Screenshot captured, size:', screenshotDataUrl?.length || 0);
                                    } catch (captureErr) {
                                        console.warn('[shareMint] Screenshot capture failed:', captureErr);
                                    }
                                }
                            }
                        } // end of: if (!screenshotDataUrl)

                        // Step 2: Build metadata and upload to the configured storage backend
                        const shareStorageLabel = (typeof window.getStorageProviderLabel === 'function') ? window.getStorageProviderLabel() : 'decentralized storage';
                        setMintStatus(tShare('mintUploadingStorage', `Uploading to ${shareStorageLabel}...`));
                        console.log(`[shareMint] Building metadata for ${shareStorageLabel} upload`);

                        const createdAtIso = proposal.createdAt || new Date().toISOString();
                        const goalKey = resolveProposalGoalKey(proposal, null) || 'proposal';
                        const goalLabel = goalKey.replace(/-/g, ' ');
                        const proposalName = proposal.name || proposal.title || `${goalLabel} Proposal`;
                        const proposalDescription = proposal.description || '';
                        const proposalAuthor = proposal.author || '';
                        const isConditional = Boolean(proposal.conditional || proposal.isConditional);

                        const metadataPayload = {
                            name: proposalName,
                            title: proposalName,
                            description: proposalDescription,
                            image: '', // populated after image upload
                            attributes: [
                                { trait_type: 'Goal', value: goalLabel },
                                { trait_type: 'Conditional', value: isConditional ? 'Yes' : 'No' },
                                { trait_type: 'Parcel Count', value: parcelIds.length },
                                { trait_type: 'Author', value: proposalAuthor }
                            ],
                            properties: {
                                proposalId: proposal.proposalId || '',
                                goal: goalKey,
                                title: proposalName,
                                parcelIds: parcelIds,
                                conditional: isConditional,
                                lens: lensAddresses,
                                createdAt: createdAtIso,
                                author: proposalAuthor,
                                description: proposalDescription
                            }
                        };

                        let metadataUri = '';
                        let assetUploadResult = null;

                        // Only attempt IPFS upload if we have a screenshot
                        if (screenshotDataUrl && window.AssetService && typeof window.AssetService.uploadProposalAssets === 'function') {
                            const fileNameBase = `proposal-${Date.now()}`;
                            const uploadChainId = (window.walletManager && typeof window.walletManager.getState === 'function')
                                ? window.walletManager.getState()?.chainId
                                : null;

                            try {
                                assetUploadResult = await window.AssetService.uploadProposalAssets({
                                    imageData: screenshotDataUrl,
                                    metadata: metadataPayload,
                                    fileName: fileNameBase,
                                    chainId: uploadChainId,
                                    target: 'auto'
                                });
                                metadataUri = assetUploadResult?.metadataUri || assetUploadResult?.metadataUrl || '';
                                console.log('[shareMint] IPFS upload result:', { metadataUri, imageUri: assetUploadResult?.imageUri });
                            } catch (ipfsErr) {
                                console.warn('[shareMint] IPFS upload failed, minting without metadata:', ipfsErr);
                            }
                        } else if (!screenshotDataUrl) {
                            console.warn('[shareMint] No screenshot available, minting without IPFS metadata');
                        } else {
                            console.warn('[shareMint] AssetService not available, minting without IPFS metadata');
                        }

                        // Step 3: Mint on blockchain
                        setMintStatus(tShare('mintWaitingSignature', 'Waiting for wallet signature...'));
                        console.log('[shareMint] Calling mintProposal with metadataUri:', metadataUri);

                        const mintResult = await window.ProposalChainBridge.mintProposal({
                            parcelIds: parcelIds,
                            isConditional: isConditional,
                            ethAmount: 0,
                            tokenAmount: 0n,
                            imageURI: metadataUri,
                            lens: lensAddresses,
                            onSubmitted: (tx) => {
                                const baseUrl = typeof getExplorerBaseUrlForChain === 'function' ? getExplorerBaseUrlForChain(tx?.chainId) : null;
                                const txUrl = baseUrl && tx?.hash ? `${baseUrl}/tx/${tx.hash}` : null;
                                setMintStatus(txUrl
                                    ? `${tShare('mintingOnChain', 'Minting on chain...')} <a href="${txUrl}" target="_blank" rel="noopener noreferrer">${tShare('viewTransaction', 'Transaction')}</a>`
                                    : tShare('mintingOnChain', 'Minting on chain...'), { html: true });
                            }
                        });

                        const txHash = mintResult && mintResult.transactionHash ? mintResult.transactionHash : null;
                        const chainId = mintResult && mintResult.chainId ? mintResult.chainId : null;
                        const contractAddress = mintResult && mintResult.contractAddress ? mintResult.contractAddress : null;
                        const tokenId = mintResult && mintResult.proposalId != null ? String(mintResult.proposalId) : null;

                        // Update proposal with on-chain data including IPFS metadata URIs
                        proposal.onchain = proposal.onchain || {};
                        proposal.onchain.transactionHash = txHash || proposal.onchain.transactionHash || null;
                        proposal.onchain.proposalId = tokenId || proposal.onchain.proposalId || null;
                        proposal.onchain.chainId = chainId || proposal.onchain.chainId || null;
                        proposal.onchain.contractAddress = contractAddress || proposal.onchain.contractAddress || null;
                        proposal.onchain.metadataUri = metadataUri || proposal.onchain.metadataUri || null;
                        proposal.onchain.metadataUrl = assetUploadResult?.metadataGatewayUrl || proposal.onchain.metadataUrl || null;
                        proposal.onchain.imageUri = assetUploadResult?.imageUri || proposal.onchain.imageUri || null;
                        proposal.onchain.imageUrl = assetUploadResult?.imageGatewayUrl || proposal.onchain.imageUrl || null;

                        proposal.nft = {
                            chain: chainId || null,
                            contract: contractAddress || null,
                            tokenId: tokenId || null
                        };

                        const chainProposalIdValue = (typeof buildChainProposalId === 'function')
                            ? buildChainProposalId(chainId, contractAddress, tokenId)
                            : null;
                        proposal.chainProposalId = chainProposalIdValue || proposal.chainProposalId || null;
                        if (proposal.onchain) {
                            proposal.onchain.chainProposalId = proposal.onchain.chainProposalId || chainProposalIdValue || null;
                        }

                        if (typeof proposalStorage !== 'undefined') {
                            const localKey = proposal.proposalId || (typeof getProposalKey === 'function' ? getProposalKey(proposal) : null);
                            const storedProposal = localKey ? proposalStorage.getProposal(localKey) : null;
                            if (storedProposal) {
                                storedProposal.onchain = { ...proposal.onchain };
                                storedProposal.nft = { ...proposal.nft };
                                storedProposal.chainProposalId = chainProposalIdValue || storedProposal.chainProposalId || null;
                                storedProposal.tokenId = storedProposal.tokenId || tokenId;
                                if (typeof proposalStorage._indexProposal === 'function') {
                                    proposalStorage._indexProposal(storedProposal);
                                }
                                if (typeof proposalStorage.save === 'function') {
                                    proposalStorage.save();
                                }
                            }
                        }

                        // Persist the minted proposal to the server so its ENS name
                        // (the on-chain tokenId) resolves through the gateway, which
                        // reads Postgres. The server keys the row on proposalId, so
                        // upload it under the tokenId; otherwise the /proposals/<tokenId>
                        // link the ENS name points at would 404. Minting only writes
                        // to chain + localStorage, so without this step the name is a
                        // dead link until the proposal is uploaded separately.
                        if (tokenId) {
                            try {
                                setMintStatus(tShare('mintSavingServer', 'Saving proposal to server...'));
                                const persistResult = await uploadProposalToServer({ ...proposal, proposalId: tokenId });
                                if (!persistResult || !persistResult.ok) {
                                    throw new Error((persistResult && persistResult.message) || 'server save failed');
                                }
                            } catch (persistErr) {
                                console.error('[shareMint] Server persist after mint failed:', persistErr);
                                if (typeof showEphemeralMessage === 'function') {
                                    showEphemeralMessage(tShare('mintSavedChainOnly', 'Minted on-chain, but saving to the server failed — the ENS link may not resolve until you retry.'), 8000, 'error');
                                }
                            }
                        }

                        // Status updates in modal
                        const explorerUrl = typeof buildProposalNftExplorerUrl === 'function' ? buildProposalNftExplorerUrl(proposal) : null;
                        if (txHash) {
                            const baseUrl = typeof getExplorerBaseUrlForChain === 'function' ? getExplorerBaseUrlForChain(chainId) : null;
                            const txUrl = baseUrl && txHash ? `${baseUrl}/tx/${txHash}` : null;
                            setMintStatus(txUrl
                                ? `${tShare('minting', 'Minting...')} <a href="${txUrl}" target="_blank" rel="noopener noreferrer">${tShare('viewTransaction', 'Transaction')}</a>`
                                : tShare('minting', 'Minting...'), { html: true });
                        }

                        setMintStatus(explorerUrl
                            ? `${tShare('mintSuccess', 'Success! You can see the proposal minted')} <a href="${explorerUrl}" target="_blank" rel="noopener noreferrer">${tShare('here', 'here')}</a>`
                            : tShare('mintSuccess', 'Success! Proposal minted.'), { html: true });

                        mintedExplorerUrl = explorerUrl || mintedExplorerUrl;
                        mintedLinkInput.value = mintedExplorerUrl || '';
                        refreshMintRowUi();

                        mintButton.disabled = true;
                        mintButton.textContent = tShare('alreadyMinted', 'Already minted');
                        if (typeof showEphemeralMessage === 'function') {
                            showEphemeralMessage(tShare('mintSuccess', 'Proposal minted successfully!'), 5000, 'success');
                        }

                        // Update currentProposalDetailsContext so Share button uses updated NFT data
                        if (typeof currentProposalDetailsContext !== 'undefined' && currentProposalDetailsContext) {
                            currentProposalDetailsContext.nft = { ...proposal.nft };
                            currentProposalDetailsContext.onchain = { ...proposal.onchain };
                            currentProposalDetailsContext.chainProposalId = proposal.chainProposalId;
                        }
                    } catch (mintError) {
                        console.error('Minting failed:', mintError);
                        throw mintError;
                    }
                }
            } else {
                throw new Error('Blockchain functionality not available');
            }
        } catch (error) {
            console.error('Mint action failed:', error);
            if (uploadStatus) {
                uploadStatus.textContent = error.message || tShare('mintError', 'Failed to mint proposal');
                uploadStatus.style.color = '#b3261e';
            }
            if (typeof showEphemeralMessage === 'function') {
                showEphemeralMessage(error.message || tShare('mintError', 'Failed to mint proposal'), 5000, 'error');
            }
        }
    });

    const modal = showSimpleShareModal({
        title: tShare('shareModalTitle', 'Share one proposal'),
        body: fragment,
        actions: [],
        closeOnOverlay: false,
        closeOnEscape: false,
        autoCloseActions: false
    });
}

function showSimpleShareModal(options = {}) {
    if (typeof document === 'undefined') return null;

    const t = getProposalI18nHelper();
    const closeLabel = t('modal.common.close', 'Close');

    const overlay = document.createElement('div');
    overlay.className = 'share-modal-overlay';

    const modal = document.createElement('div');
    modal.className = 'share-modal';

    const closeOnOverlay = options.closeOnOverlay !== false;
    const closeOnEscape = options.closeOnEscape !== false;
    const autoCloseActions = options.autoCloseActions !== false;

    const header = document.createElement('div');
    header.className = 'share-modal-header';

    const titleEl = document.createElement('h2');
    titleEl.className = 'share-modal-title';
    titleEl.textContent = options.title || '';
    header.appendChild(titleEl);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'share-modal-close close-circle-btn close-circle-btn--lg';
    closeBtn.setAttribute('aria-label', closeLabel);
    closeBtn.innerHTML = '&times;';
    header.appendChild(closeBtn);

    modal.appendChild(header);

    const bodyContainer = document.createElement('div');
    bodyContainer.className = 'share-modal-body';

    if (Array.isArray(options.body)) {
        options.body.forEach(node => appendModalBody(bodyContainer, node));
    } else if (options.body) {
        appendModalBody(bodyContainer, options.body);
    }

    modal.appendChild(bodyContainer);

    const actionsContainer = document.createElement('div');
    actionsContainer.className = 'share-modal-actions';

    const actions = Array.isArray(options.actions) ? options.actions : [];

    let didClose = false;
    const modalApi = {
        close: closeModal,
        overlay,
        modal,
        body: bodyContainer,
        getActionButton: (id) => {
            try { return actionsContainer.querySelector(`button[data-action-id="${id}"]`); } catch (_) { return null; }
        }
    };

    actions.forEach(action => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `btn ${action.primary ? 'share-modal-primary' : 'share-modal-secondary'}`;
        button.textContent = action.label || closeLabel;
        if (action && action.id) {
            button.setAttribute('data-action-id', String(action.id));
        }
        if (action && action.disabled) {
            button.disabled = true;
            button.classList.add('disabled');
        }
        button.addEventListener('click', (e) => {
            // If disabled, do nothing
            if (button.disabled || button.classList.contains('disabled')) {
                e.preventDefault();
                e.stopPropagation();
                return;
            }
            if (autoCloseActions) {
                closeModal();
            }
            if (typeof action.onClick === 'function') {
                action.onClick(modalApi);
            }
        });
        actionsContainer.appendChild(button);
    });

    if (actions.length > 0) {
        modal.appendChild(actionsContainer);
    }
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    function onOverlayClick(event) {
        if (!closeOnOverlay) return;
        if (event.target === overlay) {
            closeModal();
        }
    }

    function onKeyDown(event) {
        if (!closeOnEscape) return;
        if (event.key === 'Escape') {
            closeModal();
        }
    }

    function closeModal() {
        if (didClose) return;
        didClose = true;
        try { overlay.removeEventListener('click', onOverlayClick); } catch (_) { }
        try { document.removeEventListener('keydown', onKeyDown); } catch (_) { }
        try { overlay.remove(); } catch (_) { }

        try {
            if (typeof options.onClose === 'function') {
                options.onClose();
            }
        } catch (_) { }
    }

    closeBtn.addEventListener('click', closeModal);
    overlay.addEventListener('click', onOverlayClick);
    document.addEventListener('keydown', onKeyDown);

    return modalApi;
}

function appendModalBody(container, content) {
    if (!container || !content) return;
    if (content instanceof Node) {
        container.appendChild(content);
    } else if (typeof content === 'string') {
        const paragraph = document.createElement('p');
        paragraph.innerHTML = content;
        container.appendChild(paragraph);
    }
}

// URL-driven 3D mode (e.g. ?mode3d or ?3d=1). We keep it here (near share/deep-link handlers)
// so proposal-loading flows can enter 3D after the map has been focused.

function isTruthyUrlFlag(params, key) {
    try {
        if (!params || typeof params.has !== 'function') return false;
        if (!params.has(key)) return false;
        const raw = params.get(key);
        if (raw === null || raw === undefined) return false;
        const value = String(raw).trim().toLowerCase();
        if (value === '') return true; // e.g. ?mode3d
        if (value === '0' || value === 'false' || value === 'no' || value === 'off') return false;
        if (value === '1' || value === 'true' || value === 'yes' || value === 'on') return true;
        // Any other value: presence is treated as enabled.
        return true;
    } catch (_) {
        return false;
    }
}

function is3DModeRequestedFromUrl(params) {
    try {
        const p = params || new URLSearchParams(window.location.search || '');
        return isTruthyUrlFlag(p, 'mode3d') || isTruthyUrlFlag(p, '3d');
    } catch (_) {
        return false;
    }
}

function roughlyEqualLatLng(a, b, eps = 1e-12) {
    try {
        if (!a || !b) return false;
        return Math.abs(a.lat - b.lat) <= eps && Math.abs(a.lng - b.lng) <= eps;
    } catch (_) {
        return false;
    }
}


function tryEnterThreeMode(options = {}) {
    try {
        if (typeof window !== 'undefined' && typeof window.enterThreeMode === 'function') {
            window.enterThreeMode(options);
            return true;
        }
    } catch (_) { }
    return false;
}



function handleSingleProposalShareFromUrl(attempt = 0) {
    try {
        const t = getProposalI18nHelper();
        const tShare = getShareI18nHelper();
        if (singleProposalShareHandled) return;
        const params = new URLSearchParams(window.location.search);
        const encoded = params.get('proposalShare');
        if (!encoded) return;

        if (typeof map === 'undefined' || !map) {
            if (attempt < 15) {
                setTimeout(() => handleSingleProposalShareFromUrl(attempt + 1), 400);
            }
            return;
        }

        let payload;
        try {
            payload = decodeSharedPayload(encoded);
        } catch (_) {
            showSimpleShareModal({
                title: tShare('invalidTitle', 'Invalid Share Link'),
                body: `<p>${tShare('invalidBody', 'We could not decode this shared proposal link. Please ask the sender to regenerate it.')}</p>`,
                actions: [{ label: t('modal.common.close', 'Close'), primary: true }]
            });
            params.delete('proposalShare');
            cleanSharedQuery(params);
            singleProposalShareHandled = true;
            return;
        }

        params.delete('proposalShare');
        cleanSharedQuery(params);
        singleProposalShareHandled = true;

        if (!payload || !Array.isArray(payload.proposals) || payload.proposals.length === 0) {
            showSimpleShareModal({
                title: tShare('emptyTitle', 'No Proposal Found'),
                body: `<p>${tShare('emptyBody', 'The shared link did not contain a proposal to load.')}</p>`,
                actions: [{ label: t('modal.common.close', 'Close'), primary: true }]
            });
            return;
        }

        const sharedProposal = payload.proposals[0];

        // Update Open Graph metadata for social sharing
        if (typeof updateProposalOGMetadata === 'function') {
            updateProposalOGMetadata(sharedProposal);
        }

        (async () => {
            try {
                await loadSharedProposalFromLink(sharedProposal, payload);
            } catch (error) {
                const message = error && error.message
                    ? escapeHtml(error.message)
                    : tShare('unknownError', 'An unknown error occurred while loading the shared proposal.');
                showSimpleShareModal({
                    title: tShare('failureTitle', 'Unable to Load Shared Proposal'),
                    body: `<p>${message}</p>`,
                    actions: [{ label: t('modal.common.close', 'Close'), primary: true }]
                });
            }
        })();
    } catch (error) {
        console.error('handleSingleProposalShareFromUrl failed', error);
    }
}

async function loadSharedProposalFromLink(sharedProposal, payload) {
    if (!sharedProposal) {
        throw new Error('Shared proposal data is missing.');
    }

    let suppressedHere = false;
    if (!isCameraMovementSuppressed()) {
        try {
            window.suppressCameraMoves = true;
            suppressedHere = true;
        } catch (_) { }
    }

    try {
        const normalized = prepareProposalForImport(sharedProposal);
        if (!normalized) {
            throw new Error('Unable to normalise shared proposal data.');
        }

        // Ensure parent parcels are fetched (this replaces the old stageSharedProposalDependencies logic)
        const fetchedParentIds = await ensureParentParcelsFetched(sharedProposal, normalized);

        // For road proposals, resolve and store parentFeatures (needed for rebuilding road geometry)
        if (normalized.roadProposal && !resolveRoadParentFeatures(sharedProposal, normalized, fetchedParentIds)) {
            throw new Error('Missing parcel geometry required for this proposal.');
        }

        normalized.status = 'Active';
        normalized.acceptedParcelIds = [];

        const targetHash = normalized.proposalId || sharedProposal.proposalId || `shared_${Date.now()}`;
        normalized.proposalId = targetHash;

        let stored = proposalStorage.getProposal(targetHash);
        if (!stored) {
            const imported = proposalStorage.importProposal(normalized, { overwrite: false, preserveStatus: true });
            stored = imported || proposalStorage.getProposal(targetHash);
        }

        if (!stored) {
            const addedId = proposalStorage.addProposal({ ...normalized, proposalId: undefined });
            stored = addedId ? proposalStorage.getProposal(addedId) : null;
        }

        if (!stored) {
            throw new Error('Failed to store the shared proposal locally.');
        }

        if (normalized.roadProposal && stored.proposalId) {
            stored.roadProposal = stored.roadProposal || {};
            // Only store parentParcelIds - geometries fetched when needed
            if (normalized.roadProposal.parentParcelIds) {
                stored.roadProposal.parentParcelIds = normalized.roadProposal.parentParcelIds;
            } else if (normalized.roadProposal.parentFeatures) {
                // Legacy: extract IDs from parentFeatures if they exist (from old data)
                stored.roadProposal.parentParcelIds = ensureArrayOfStrings(normalized.roadProposal.parentFeatures.map(feature => getParcelIdFromFeature(feature)));
            }
            if (typeof proposalStorage._indexProposal === 'function') {
                proposalStorage._indexProposal(stored);
            }
            proposalStorage.save();
        }

        if (suppressedHere) {
            try {
                window.suppressCameraMoves = false;
                suppressedHere = false;
            } catch (_) { }
        }

        await preloadProposalParcelOwners(stored.parentParcelIds, { forceRefresh: true });

        const focusParcelId = Array.isArray(stored.parentParcelIds) ? stored.parentParcelIds[0] : null;
        const storedKey = getProposalKey(stored);
        selectAndHighlightProposal(storedKey, focusParcelId, true);
        showProposalInfo(stored, focusParcelId);
        const panel = document.getElementById('proposal-details-panel');
        if (panel) {
            panel.classList.add('visible');
            document.body.classList.add('proposal-details-open');
        }
        await focusMapThenMaybeEnter3D(() => focusMapOnSharedProposal(stored, payload));
        if (typeof showEphemeralMessage === 'function') {
            const t = getProposalI18nHelper();
            showEphemeralMessage(t('ephemeral.messages.shared_proposal_loaded', 'Shared proposal loaded.'));
        }
    } finally {
        if (suppressedHere) {
            try { window.suppressCameraMoves = false; } catch (_) { }
        }
    }
}




async function stageSharedProposalDependencies(parcelIds, options = {}) {
    const ids = ensureArrayOfStrings(parcelIds);
    if (!ids.length) {
        return;
    }
    const suppressStatus = options && options.suppressStatus === true;
    const label = (options && options.label) ? options.label : 'shared proposal';
    const updateStageStatus = (message) => {
        if (options && typeof options.onStatusUpdate === 'function') {
            options.onStatusUpdate(message);
        } else if (!suppressStatus && typeof updateStatus === 'function' && message) {
            updateStatus(message);
        }
    };

    updateStageStatus(`Fetching parent parcels for ${label}…`);
    await ensureParentParcelsLoaded(ids, {
        preloadOwners: false,
        forceRefreshParcels: !!(options && options.forceRefreshParcels),
        onProgress: (current, total) => {
            updateStageStatus(`Fetching parent parcels for ${label} (${current}/${total})…`);
        }
    });
    await waitForParcelLayersReady(ids, {
        timeoutMs: options && Number.isFinite(options.renderTimeoutMs) ? options.renderTimeoutMs : undefined
    });

    updateStageStatus(`Fetching parcel owners for ${label}…`);
    await preloadProposalParcelOwners(ids, { forceRefresh: !!(options && options.forceOwnerRefresh) });

    updateStageStatus(`Parents ready for ${label}.`);
}




function handleSharedProposalsFromUrl(attempt = 0) {
    try {
        const t = getProposalI18nHelper();
        const tShare = getShareI18nHelper();
        if (sharedProposalsHandled) return;
        const params = new URLSearchParams(window.location.search);
        const encoded = params.get('shared');
        if (!encoded) return;

        if (typeof map === 'undefined' || !map) {
            if (attempt < 15) {
                setTimeout(() => handleSharedProposalsFromUrl(attempt + 1), 400);
            }
            return;
        }

        let payload;
        try {
            payload = decodeSharedPayload(encoded);
        } catch (error) {
            showSimpleShareModal({
                title: tShare('invalidBulkTitle', 'Invalid Shared Proposals Link'),
                body: `<p>${tShare('invalidBulkBody', 'We could not decode the shared proposals link. Please ask the sender to regenerate it.')}</p>`,
                actions: [{ label: t('modal.common.close', 'Close'), primary: true }]
            });
            params.delete('shared');
            cleanSharedQuery(params);
            sharedProposalsHandled = true;
            return;
        }

        params.delete('shared');
        cleanSharedQuery(params);
        sharedProposalsHandled = true;

        if (!payload || !Array.isArray(payload.proposals) || payload.proposals.length === 0) {
            showSimpleShareModal({
                title: tShare('noBulkTitle', 'No Proposals Found'),
                body: `<p>${tShare('noBulkBody', 'The shared link did not contain any proposals to apply.')}</p>`,
                actions: [{ label: t('modal.common.close', 'Close'), primary: true }]
            });
            return;
        }

        // Update Open Graph metadata for social sharing (use first proposal or create summary)
        if (typeof updateProposalOGMetadata === 'function' && payload.proposals.length > 0) {
            const firstProposal = payload.proposals[0];
            // Enhance with summary info if multiple proposals
            if (payload.proposals.length > 1) {
                const summaryProposal = {
                    ...firstProposal,
                    title: `${firstProposal.title || 'Proposal'} (+${payload.proposals.length - 1} more)`,
                    description: `A collection of ${payload.proposals.length} proposals shared on Consensus Builder. ${firstProposal.description || ''}`
                };
                updateProposalOGMetadata(summaryProposal);
            } else {
                updateProposalOGMetadata(firstProposal);
            }
        }

        // Before applying anything, show a full payload inspector with per-proposal checkboxes
        ; (async () => {
            try {
                const selected = await showSharedPayloadInspector(payload);
                if (!selected || !(selected instanceof Set)) {
                    if (typeof showEphemeralMessage === 'function') {
                        showEphemeralMessage(tShare('importCancelled', 'Shared proposal import cancelled.'));
                    }
                    return;
                }
                await applySharedProposalsFromPayload(payload, selected);
            } catch (e) {
                console.error('Shared payload inspector error:', e);
            }
        })();
    } catch (error) {
        console.error('handleSharedProposalsFromUrl failed', error);
    }
}

function cleanSharedQuery(params) {
    try {
        const entries = params.toString();
        const newUrl = `${window.location.origin}${window.location.pathname}${entries ? `?${entries}` : ''}${window.location.hash || ''}`;
        if (window.history && typeof window.history.replaceState === 'function') {
            window.history.replaceState({}, document.title, newUrl);
        }
    } catch (error) {
        console.warn('Failed to clean shared query params', error);
    }
}

async function applySharedProposalsFromPayload(payload, selectedIds) {
    try {
        // Suppress camera moves for the duration of shared apply
        try { window.suppressCameraMoves = true; } catch (_) { }
        let proposals = Array.isArray(payload.proposals) ? payload.proposals.slice() : [];
        if (selectedIds && selectedIds.size >= 0) {
            proposals = proposals.filter(p => selectedIds.has(getProposalKey(p)));
        }
        if (proposals.length === 0) return;

        if (typeof updateStatus === 'function') {
            updateStatus(`Applying ${proposals.length} shared proposal${proposals.length === 1 ? '' : 's'}...`);
        }

        // Do not move camera; if bbox is provided, fetch parcels for that area explicitly
        if (typeof fetchParcelData === 'function') {
            const bounds = (function () {
                try {
                    if (payload && payload.bbox && isFinite(payload.bbox.south) && isFinite(payload.bbox.north) && isFinite(payload.bbox.west) && isFinite(payload.bbox.east) && typeof L !== 'undefined') {
                        return L.latLngBounds([
                            [payload.bbox.south, payload.bbox.west],
                            [payload.bbox.north, payload.bbox.east]
                        ]);
                    }
                } catch (_) { }
                return null;
            })();
            await fetchParcelData(bounds || undefined);
        }

        // No global ancestor pre-check; proceed proposal by proposal

        const t = getProposalI18nHelper();
        const tShare = getShareI18nHelper();

        const sorted = proposals.slice().sort((a, b) => {
            // Extract numeric ID from proposalId (e.g., "58" or "local-3" -> 3)
            const extractNumericId = (proposal) => {
                if (!proposal || !proposal.proposalId) return null;
                const str = String(proposal.proposalId);
                if (/^\d+$/.test(str)) {
                    return parseInt(str, 10);
                }
                const match = str.match(/^local-(\d+)$/);
                if (match) {
                    return parseInt(match[1], 10);
                }
                return null;
            };
            const aId = extractNumericId(a);
            const bId = extractNumericId(b);
            const aHasId = aId !== null && Number.isFinite(aId);
            const bHasId = bId !== null && Number.isFinite(bId);
            if (aHasId && bHasId) {
                return aId - bId; // includes 0
            }
            if (aHasId && !bHasId) return -1;
            if (!aHasId && bHasId) return 1;
            const aRaw = new Date(a.createdAt || 0).getTime();
            const bRaw = new Date(b.createdAt || 0).getTime();
            const aTime = Number.isFinite(aRaw) ? aRaw : 0;
            const bTime = Number.isFinite(bRaw) ? bRaw : 0;
            return aTime - bTime;
        });

        // Position of each proposal in the sorted payload (oldest-first), so the view can end
        // up framing the most recently created loaded proposal regardless of the chronological
        // order dependency requeueing applied them in.
        const payloadOrder = new Map();
        sorted.forEach((p, idx) => {
            [getProposalKey(p), p.proposalId].forEach(key => {
                if (key) payloadOrder.set(String(key), idx);
            });
        });

        const actuallyApplied = [];
        const skipped = [];
        const failures = [];
        const blockedAncestors = new Map();
        let lastLoadedProposalIdFor3D = null;

        let pending = sorted.slice();
        const maxPasses = 8;
        let pass = 0;

        while (pending.length && pass < maxPasses) {
            pass += 1;
            let progress = false;
            const nextPending = [];

            for (const proposal of pending) {
                try {
                    if (typeof updateStatus === 'function') {
                        const displayId = proposal.proposalId ? String(proposal.proposalId) : '?';
                        updateStatus(t('status.messages.applying_specific_shared_proposal', `Applying shared proposal ${proposal.title || ''} #${displayId}...`, {
                            title: proposal.title || '',
                            id: displayId
                        }));
                    }
                } catch (_) { }

                const result = await importAndApplySharedProposal(proposal);
                const proposalId = (result && result.proposalId) || getProposalKey(proposal) || proposal.proposalId;

                if (result && result.skipped) {
                    skipped.push(proposalId);
                    if (proposalId) lastLoadedProposalIdFor3D = proposalId;
                    blockedAncestors.delete(proposalId);
                    progress = true;
                    continue;
                }

                if (result && result.applied) {
                    actuallyApplied.push(proposalId);
                    if (proposalId) lastLoadedProposalIdFor3D = proposalId;
                    blockedAncestors.delete(proposalId);
                    progress = true;
                    await new Promise(res => setTimeout(res, 3000));
                    continue;
                }

                const ancestryCheck = (proposalId && typeof ProposalManager !== 'undefined' && typeof ProposalManager.canApplyProposal === 'function')
                    ? ProposalManager.canApplyProposal(proposalId)
                    : { ok: true, missing: [] };

                if (!ancestryCheck.ok && ancestryCheck.missing.length) {
                    blockedAncestors.set(proposalId || proposal.title || `pending-${pass}-${nextPending.length}`, {
                        missing: ancestryCheck.missing.slice(),
                        proposal
                    });
                    nextPending.push(proposal);
                    continue;
                }

                failures.push(proposalId || proposal.proposalId || '');
                progress = true;
            }

            pending = nextPending;
            if (!progress) break;
        }

        pending.forEach(proposal => {
            const hash = getProposalKey(proposal) || proposal.proposalId || proposal.title || 'unknown';
            if (!blockedAncestors.has(hash)) {
                blockedAncestors.set(hash, { missing: [], proposal });
            }
        });

        if (actuallyApplied.length > 0 || skipped.length > 0 || failures.length > 0 || blockedAncestors.size > 0) {
            if (typeof updateProposalLayer === 'function') {
                updateProposalLayer();
            }
            if (typeof updateShowProposalsButton === 'function') {
                updateShowProposalsButton();
            }

            // Center map on the most recently loaded proposal (latest in payload order among
            // applied and skipped-as-duplicate), framed as if it had been loaded alone:
            // fit its visible descendant's bounds and open its details panel.
            let lastProposalId = null;
            let lastProposalOrd = -1;
            [...actuallyApplied, ...skipped].forEach(pid => {
                if (!pid) return;
                const key = String(pid);
                const ord = payloadOrder.has(key) ? payloadOrder.get(key) : -1;
                if (ord >= lastProposalOrd) {
                    lastProposalOrd = ord;
                    lastProposalId = pid;
                }
            });
            if (!lastProposalId) {
                lastProposalId = lastLoadedProposalIdFor3D
                    || (actuallyApplied.length > 0 ? actuallyApplied[actuallyApplied.length - 1] : null)
                    || (skipped.length > 0 ? skipped[skipped.length - 1] : null);
            }
            if (lastProposalId && typeof map !== 'undefined' && map) {
                try {
                    const visibleId = (typeof findVisibleDescendant === 'function')
                        ? (findVisibleDescendant(lastProposalId) || lastProposalId)
                        : lastProposalId;
                    const bounds = calculateBoundsForLastAppliedProposal(visibleId);
                    if (bounds && bounds.isValid && bounds.isValid()) {
                        map.fitBounds(bounds, { padding: [80, 80], maxZoom: 18 });
                    }
                    if (typeof focusProposalDetails === 'function') {
                        await focusProposalDetails(visibleId, {
                            centerOnProposal: false, // camera has already been fit to bounds above
                            showDetails: true
                        });
                    }
                } catch (error) {
                    console.warn('Failed to center map on last applied proposal:', error);
                }
            }

            // Do not auto-enable proposals mode; keep interactions normal
            const bodyLines = [];
            const authorName = payload.author || t('common.userFallback', 'User');
            bodyLines.push(`<p>${tShare('summary.appliedFrom', 'Applied proposals from {{author}}.', { author: escapeHtml(authorName) })}</p>`);
            if (actuallyApplied.length > 0) {
                bodyLines.push(`<p>${tShare('summary.appliedCount', '{{count}} applied.', {
                    count: actuallyApplied.length,
                    suffix: actuallyApplied.length === 1 ? '' : 's'
                })}</p>`);
            }
            if (skipped.length > 0) {
                bodyLines.push(`<p>${tShare('summary.skippedCount', 'Skipped {{count}} duplicate proposal{{suffix}} (already present).', {
                    count: skipped.length,
                    suffix: skipped.length === 1 ? '' : 's'
                })}</p>`);
            }
            if (failures.length > 0) {
                bodyLines.push(`<p>${tShare('summary.failedCount', '{{count}} failed.', {
                    count: failures.length,
                    suffix: failures.length === 1 ? '' : 's'
                })}</p>`);
            }
            if (blockedAncestors.size > 0) {
                const blockedList = Array.from(blockedAncestors.entries());
                const limitedBlocked = blockedList.slice(0, 5);
                const escape = typeof escapeHtml === 'function' ? escapeHtml : (value => value);
                bodyLines.push(`<p>${tShare('summary.blockedAncestors', 'Blocked by missing applied ancestors:')}</p><ul>${limitedBlocked.map(([hash, info]) => {
                    const label = info && info.proposal && info.proposal.title
                        ? `${escape(info.proposal.title)}${hash ? ` (${escape(hash)})` : ''}`
                        : escape(hash || '');
                    const missingList = info && info.missing && info.missing.length ? escape(info.missing.join(', ')) : '';
                    return `<li>${label}${missingList ? ` · ${missingList}` : ''}</li>`;
                }).join('')}${blockedList.length > limitedBlocked.length ? '<li>…</li>' : ''}</ul>`);
            }
            showSimpleShareModal({
                title: tShare('summary.title', 'Applied Shared Proposals'),
                body: bodyLines.join(''),
                actions: [
                    { label: t('modal.common.close', 'Close'), primary: true },
                    ...(actuallyApplied.length > 0 ? [{
                        label: tShare('summary.unapplyApplied', 'Unapply applied'),
                        onClick: () => {
                            try {
                                const hasFamilyUnapply = typeof ProposalManager !== 'undefined' && typeof ProposalManager.unapplyWholeFamily === 'function';
                                actuallyApplied.forEach(hash => {
                                    try {
                                        if (hasFamilyUnapply) {
                                            ProposalManager.unapplyWholeFamily(hash);
                                        } else if (typeof ProposalManager.unapplyProposal === 'function') {
                                            ProposalManager.unapplyProposal(hash, { skipConfirm: true });
                                        }
                                    } catch (_) { }
                                });
                                // Refresh UI once after all bulk unapplies
                                if (typeof ProposalManager._refreshUIAfterProposalChange === 'function') {
                                    ProposalManager._refreshUIAfterProposalChange(null);
                                }
                            } catch (_) { }
                        }
                    }] : [])
                ]
            });

            // Nothing was loaded (only failures/blocked): firmly return to parcel-mode
            // hover/leave behavior. When a proposal was loaded we keep its highlight and
            // details panel, matching the single shared-proposal flow.
            if (!lastProposalId) {
                try { clearProposalInfoHoverOverlay(); } catch (_) { }
                try { clearProposalHighlights(); } catch (_) { }
                try { if (typeof setParcelNumberLabelFilter === 'function') setParcelNumberLabelFilter(null); } catch (_) { }
            }
        }

        if ((failures.length > 0 || blockedAncestors.size > 0) && typeof showEphemeralMessage === 'function') {
            const blockedCount = blockedAncestors.size;
            const failureCount = failures.length;
            const total = failureCount + blockedCount;
            showEphemeralMessage(t('ephemeral.messages.failed_to_apply_shared_proposals_summary', `Unable to apply ${total} shared proposal${total === 1 ? '' : 's'} (missing ancestors or errors).`, {
                count: total,
                suffix: total === 1 ? '' : 's'
            }), 6000, 'error');
        }

        // Optional URL-driven 3D mode: after shared apply completes, center on all proposals then enter 3D.
        try {
            if (!url3DModeHandled && is3DModeRequestedFromUrl()) {
                // Wait for map centering to complete (if we centered on proposals above)
                const allProposalIds = [...actuallyApplied, ...skipped].filter(Boolean);
                if (allProposalIds.length > 0) {
                    await createLeafletViewSettlePromise(null, null);
                }
                // Enter 3D mode - camera will rotate around the current map center (which is the center of proposals)
                const entered = tryEnterThreeMode({ fromUrl: true });
                if (entered) url3DModeHandled = true;
            }
        } catch (_) { }
    } catch (error) {
        console.error('applySharedProposalsFromPayload failed', error);
        if (typeof showEphemeralMessage === 'function') {
            const t = getProposalI18nHelper();
            showEphemeralMessage(t('ephemeral.messages.failed_to_apply_shared_proposals', 'Failed to apply shared proposals.'), 6000, 'error');
        }
    } finally {
        // Re-enable camera moves after shared apply completes
        try { window.suppressCameraMoves = false; } catch (_) { }
    }
}

function computeRequiredParentIdsForSharedProposal(sp) {
    if (!sp || typeof sp !== 'object') return [];
    if (sp.reparcellization && Array.isArray(sp.reparcellization.polygons) && sp.reparcellization.polygons.length > 0) {
        // Reparcellization plans render their own geometry and do not depend on ancestor parcels being present locally.
        return [];
    }
    if (sp.roadProposal && Array.isArray(sp.roadProposal.parentParcelIds) && sp.roadProposal.parentParcelIds.length > 0) {
        return ensureArrayOfStrings(sp.roadProposal.parentParcelIds);
    }
    if (sp.buildingProposal && Array.isArray(sp.buildingProposal.parentParcelIds) && sp.buildingProposal.parentParcelIds.length > 0) {
        return ensureArrayOfStrings(sp.buildingProposal.parentParcelIds);
    }
    if (Array.isArray(sp.parentParcelIds) && sp.parentParcelIds.length > 0) {
        return ensureArrayOfStrings(sp.parentParcelIds);
    }
    return [];
}

// Show a modal that displays the fully decoded shared payload and allows selecting proposals to apply
function showSharedPayloadInspector(payload) {
    return new Promise(resolve => {
        try {
            const t = getProposalI18nHelper();
            const tShare = getShareI18nHelper();
            const tShared = getSharedInspectorI18nHelper();
            const unknownText = t('common.unknown', 'Unknown');
            const container = document.createElement('div');
            container.className = 'shared-payload-inspector';

            // Summary
            const summary = document.createElement('div');
            summary.className = 'spi-summary';
            const total = Array.isArray(payload.proposals) ? payload.proposals.length : 0;
            const bytes = (() => { try { return new TextEncoder().encode(JSON.stringify(payload)).length; } catch (_) { return 0; } })();
            const kb = (bytes / 1024).toFixed(1);
            summary.innerHTML = `
                <p><strong>${tShared('author', 'Author:')}</strong> ${escapeHtml(payload.author || unknownText)}
                &nbsp;•&nbsp;<strong>${tShared('version', 'Version:')}</strong> ${String(payload.version ?? '')}
                &nbsp;•&nbsp;<strong>${tShared('generated', 'Generated:')}</strong> ${escapeHtml(payload.generatedAt || '')}
                &nbsp;•&nbsp;<strong>${tShared('count', 'Proposals:')}</strong> ${total}
                &nbsp;•&nbsp;<strong>${tShared('payload', 'Payload:')}</strong> ~${kb} KB</p>
            `;
            container.appendChild(summary);

            // Full JSON view (collapsible)
            const detailsWrap = document.createElement('details');
            const detailsSum = document.createElement('summary');
            detailsSum.textContent = tShared('viewJson', 'View full decoded payload JSON');
            detailsWrap.appendChild(detailsSum);
            const pre = document.createElement('pre');
            pre.style.maxHeight = '240px';
            pre.style.overflow = 'auto';
            pre.textContent = (() => { try { return JSON.stringify(payload, null, 2); } catch (_) { return '[unserializable]'; } })();
            detailsWrap.appendChild(pre);
            container.appendChild(detailsWrap);

            // Proposal selection list
            const list = document.createElement('div');
            list.className = 'spi-proposal-list';
            const selected = new Set();
            (payload.proposals || []).forEach((p, idx) => {
                const item = document.createElement('div');
                item.className = 'spi-proposal-item';
                item.style.border = '1px solid #ddd';
                item.style.borderRadius = '6px';
                item.style.padding = '8px';
                item.style.marginBottom = '8px';

                const id = `spi-prop-${idx}-${(p.proposalId || '').slice(0, 8)}`;
                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.id = id;
                checkbox.checked = true;
                checkbox.dataset.hash = p.proposalId || '';
                checkbox.addEventListener('change', () => {
                    const h = checkbox.dataset.hash;
                    if (!h) return;
                    if (checkbox.checked) selected.add(h); else selected.delete(h);
                });

                // Default add to selection
                if (p.proposalId) selected.add(p.proposalId);

                const label = document.createElement('label');
                label.setAttribute('for', id);
                const displayId = p.proposalId ? String(p.proposalId) : '';
                const title = `${p.title || tShare('untitled', '(Untitled)')}${displayId ? ` (ID #${displayId})` : ''}`;
                label.innerHTML = `<strong>${escapeHtml(title)}</strong> • ${escapeHtml(p.type || 'parcel')} • ${escapeHtml(p.proposalId || '')}`;

                const meta = document.createElement('div');
                meta.className = 'spi-proposal-meta';
                const parentIdsDisplay = Array.isArray(p.parentParcelIds) ? p.parentParcelIds.join(', ') : '';
                const roadParents = (p.roadProposal && Array.isArray(p.roadProposal.parentParcelIds)) ? p.roadProposal.parentParcelIds.join(', ') : '';
                const buildingParents = (p.buildingProposal && Array.isArray(p.buildingProposal.parentParcelIds)) ? p.buildingProposal.parentParcelIds.join(', ') : '';
                meta.innerHTML = `
                    <small>
                        ${tShared('ancestorIds', 'Parent Parcel IDs:')} ${escapeHtml(parentIdsDisplay)}<br>
                        ${tShared('roadParents', 'Road parents:')} ${escapeHtml(roadParents)}<br>
                        ${tShared('buildingParents', 'Building parents:')} ${escapeHtml(buildingParents)}
                    </small>
                `;

                const propDetails = document.createElement('details');
                const propSummary = document.createElement('summary');
                propSummary.textContent = tShared('details', 'Details');
                propDetails.appendChild(propSummary);
                const propPre = document.createElement('pre');
                propPre.style.maxHeight = '180px';
                propPre.style.overflow = 'auto';
                try { propPre.textContent = JSON.stringify(p, null, 2); } catch (_) { propPre.textContent = '[unserializable]'; }
                propDetails.appendChild(propPre);

                item.appendChild(checkbox);
                item.appendChild(label);
                item.appendChild(meta);
                item.appendChild(propDetails);
                list.appendChild(item);
            });
            container.appendChild(list);

            // autoCloseActions is off so each action resolves before closing (closeModal fires
            // onClose, whose resolve(null) is then a no-op). Dismissing the modal any other way
            // (×, Escape, overlay click) resolves as a cancel instead of hanging the caller.
            const modal = showSimpleShareModal({
                title: tShared('title', 'Review Shared Proposals'),
                body: container,
                autoCloseActions: false,
                actions: [
                    {
                        label: t('modal.common.cancel', 'Cancel'),
                        onClick: (modalApi) => {
                            resolve(null);
                            if (modalApi && typeof modalApi.close === 'function') modalApi.close();
                        }
                    },
                    {
                        id: 'apply',
                        label: tShared('loading', 'Parcels still loading...'),
                        primary: true,
                        disabled: true,
                        onClick: (modalApi) => {
                            resolve(selected);
                            if (modalApi && typeof modalApi.close === 'function') modalApi.close();
                        }
                    }
                ],
                onClose: () => resolve(null)
            });

            // Extra safety: ensure button starts disabled right after modal mount
            try {
                const applyBtn = modal && typeof modal.getActionButton === 'function' ? modal.getActionButton('apply') : null;
                if (applyBtn) {
                    applyBtn.disabled = true;
                    applyBtn.classList.add('disabled');
                    applyBtn.textContent = tShared('loading', 'Parcels still loading...');
                }
            } catch (_) { }

            // Kick off parcel fetching for bbox only (no camera move); enable Apply once done
            (async () => {
                try {
                    try { window.suppressCameraMoves = true; } catch (_) { }
                    if (typeof fetchParcelData === 'function') {
                        const bounds = (function () {
                            try {
                                if (payload && payload.bbox && isFinite(payload.bbox.south) && isFinite(payload.bbox.north) && isFinite(payload.bbox.west) && isFinite(payload.bbox.east) && typeof L !== 'undefined') {
                                    return L.latLngBounds([
                                        [payload.bbox.south, payload.bbox.west],
                                        [payload.bbox.north, payload.bbox.east]
                                    ]);
                                }
                            } catch (_) { }
                            return null;
                        })();
                        await fetchParcelData(bounds || undefined);
                    }
                } catch (e) {
                    console.warn('Prefetch parcels for shared payload failed (continuing):', e);
                } finally {
                    try {
                        const applyBtn = modal && typeof modal.getActionButton === 'function' ? modal.getActionButton('apply') : null;
                        if (applyBtn) {
                            applyBtn.disabled = false;
                            applyBtn.classList.remove('disabled');
                            applyBtn.textContent = tShared('applySelected', 'Apply Selected');
                        }
                    } catch (_) { }
                    try { window.suppressCameraMoves = false; } catch (_) { }
                }
            })();

            // As a fallback, also enable on parcelDataLoaded event (in case of cached data or fast path)
            const onParcelLoaded = () => {
                try {
                    const applyBtn = modal && typeof modal.getActionButton === 'function' ? modal.getActionButton('apply') : null;
                    if (applyBtn) {
                        applyBtn.disabled = false;
                        applyBtn.classList.remove('disabled');
                        applyBtn.textContent = tShared('applySelected', 'Apply Selected');
                    }
                } catch (_) { }
                try { window.removeEventListener('parcelDataLoaded', onParcelLoaded); } catch (_) { }
            };
            try { window.addEventListener('parcelDataLoaded', onParcelLoaded, { once: true }); } catch (_) { }
        } catch (e) {
            console.error('showSharedPayloadInspector failed', e);
            resolve(null);
        }
    });
}


function gatherParentParcelIdsFromSharedProposals(proposals) {
    // Only use the explicit parentParcelIds field from each proposal
    const ids = new Set();
    proposals.forEach(p => {
        const list = Array.isArray(p.parentParcelIds) ? p.parentParcelIds : [];
        ensureArrayOfStrings(list).forEach(id => ids.add(id));
    });
    return ids;
}


// Intentionally a no-op to avoid camera movement during shared apply


function promptMissingParentParcelsModal(missing, author, problem) {
    return new Promise(resolve => {
        const limited = missing.slice(0, 8);
        const listHtml = limited.length > 0
            ? `<ul>${limited.map(id => `<li>${id}</li>`).join('')}${missing.length > limited.length ? '<li>…</li>' : ''}</ul>`
            : '';
        const modal = showSimpleShareModal({
            title: 'Missing Parent Parcels',
            body: `<p>We could not find ${missing.length} parent parcel${missing.length === 1 ? '' : 's'} required to apply the shared proposals${author ? ` from ${author}` : ''}.</p>${problem ? `<p><strong>Problem proposal:</strong> ${problem.title ? escapeHtml(problem.title) : '(Untitled)'}${problem.proposalId ? ` (ID #${escapeHtml(String(problem.proposalId))})` : ''}</p>` : ''}<p>You can cancel loading or refresh parcel data (this will clear local work) and try again.</p>${listHtml}`,
            actions: [
                {
                    label: 'Cancel load',
                    onClick: () => resolve('cancel')
                },
                {
                    label: 'Lose local work, refresh & apply',
                    primary: true,
                    onClick: () => resolve('refresh')
                }
            ]
        });

        if (!modal) {
            const confirmRefresh = confirm('Missing parent parcels are required to load shared proposals. Refresh parcel data (clears local work)?');
            resolve(confirmRefresh ? 'refresh' : 'cancel');
        }
    });
}


/**
 * Ensures ancestor parcels are fetched and available for a proposal.
 * This is needed for ALL proposal types, not just roads.
 * Returns the list of ancestor parcel IDs that were fetched.
 */

/**
 * Ensures parentParcelIds are set on road proposals.
 * The geometries will be fetched by ID when needed by the reconstruction algorithm.
 */
function ensureRoadParentParcelIds(sharedProposal, normalized, parentIds) {
    if (!normalized.roadProposal) return true;

    // Prefer explicit parentParcelIds from shared payload; fallback to ancestor/parcel ids
    let candidateIds = [];
    const explicitParents = sharedProposal.roadProposal && Array.isArray(sharedProposal.roadProposal.parentParcelIds)
        ? ensureArrayOfStrings(sharedProposal.roadProposal.parentParcelIds)
        : [];
    if (explicitParents.length > 0) {
        candidateIds = explicitParents;
    }
    if (candidateIds.length === 0) {
        candidateIds = parentIds.length > 0 ? parentIds : [];
    }

    if (candidateIds.length === 0) {
        console.warn('No parent parcel IDs found for road proposal', sharedProposal.proposalId);
        return false;
    }

    // Just store the IDs - geometries will be fetched when needed
    normalized.roadProposal.parentParcelIds = candidateIds;
    return true;
}


function sameStringArrays(left, right) {
    const a = ensureArrayOfStrings(left);
    const b = ensureArrayOfStrings(right);
    if (a.length !== b.length) return false;
    for (let index = 0; index < a.length; index += 1) {
        if (a[index] !== b[index]) return false;
    }
    return true;
}

function syncCanonicalSharedProposalState(existing, normalized) {
    if (!existing || !normalized) return false;

    let changed = false;
    const syncArrayField = (target, field, value) => {
        const canonical = ensureArrayOfStrings(value);
        if (!canonical.length) return;
        if (!sameStringArrays(target[field], canonical)) {
            target[field] = canonical.slice();
            changed = true;
        }
    };

    syncArrayField(existing, 'parentParcelIds', normalized.parentParcelIds);
    syncArrayField(existing, 'childParcelIds', normalized.childParcelIds);

    if (normalized.roadProposal) {
        existing.roadProposal = existing.roadProposal || {};
        syncArrayField(existing.roadProposal, 'parentParcelIds', normalized.roadProposal.parentParcelIds);
        syncArrayField(existing.roadProposal, 'childParcelIds', normalized.roadProposal.childParcelIds);
    }

    if (normalized.decideLaterProposal) {
        existing.decideLaterProposal = existing.decideLaterProposal || {};
        syncArrayField(existing.decideLaterProposal, 'parentParcelIds', normalized.decideLaterProposal.parentParcelIds);
        syncArrayField(existing.decideLaterProposal, 'childParcelIds', normalized.decideLaterProposal.childParcelIds);
    }

    if (normalized.reparcellization) {
        existing.reparcellization = existing.reparcellization || {};
        syncArrayField(existing.reparcellization, 'parcelIds', normalized.reparcellization.parcelIds);
        syncArrayField(existing.reparcellization, 'childParcelIds', normalized.reparcellization.childParcelIds);
    }

    return changed;
}

async function importAndApplySharedProposal(sharedProposal, options = {}) {
    const fallbackHash = sharedProposal ? (sharedProposal.proposalId || getProposalKey(sharedProposal)) : null;
    if (!sharedProposal || !sharedProposal.proposalId) return { applied: false, skipped: false, proposalId: fallbackHash, reason: 'Missing proposal payload' };

    const normalized = prepareProposalForImport(sharedProposal);
    const proposalId = normalized?.proposalId || fallbackHash;
    if (!normalized) return { applied: false, skipped: false, proposalId, reason: 'Unable to normalize shared proposal' };

    // If this proposal is already present AND already applied AND its descendants are actually
    // on the map, there is nothing to do — skip. Critically, we do NOT early-skip when the
    // proposal is marked applied but its descendants are missing, because that is exactly the
    // case we need to handle: a cross-client or cross-session deep-link where the local copy
    // has stale childParcelIds but no materialized geometry. For that case we must fall through
    // to applyProposal, which rebuilds children from definition via _restoreFromAlreadyAppliedState.
    const existing = proposalStorage.getProposal(normalized.proposalId);
    if (existing && syncCanonicalSharedProposalState(existing, normalized)) {
        if (typeof proposalStorage._indexProposal === 'function') {
            proposalStorage._indexProposal(existing);
        }
        if (typeof proposalStorage.save === 'function') {
            proposalStorage.save();
        }
    }
    if (existing) {
        const alreadyApplied = isProposalCurrentlyApplied(existing) || existing.status === 'Executed';
        if (alreadyApplied) {
            const descendantsMaterialized = (() => {
                try {
                    const mapById = (typeof window !== 'undefined' && window.parcelLayerById instanceof Map)
                        ? window.parcelLayerById
                        : null;
                    if (!mapById) return false;
                    const descendantIds = [];
                    const push = (arr) => {
                        if (!Array.isArray(arr)) return;
                        for (const id of arr) {
                            if (id != null) descendantIds.push(String(id));
                        }
                    };
                    push(existing.childParcelIds);
                    push(existing.roadProposal && existing.roadProposal.childParcelIds);
                    push(existing.decideLaterProposal && existing.decideLaterProposal.childParcelIds);
                    if (descendantIds.length === 0) {
                        // Nothing stored to verify; treat as "needs apply" so we re-derive from definition.
                        return false;
                    }
                    return descendantIds.every(id => mapById.has(id));
                } catch (_) {
                    return false;
                }
            })();
            if (descendantsMaterialized) {
                try { if (typeof syncProposalsIndicator === 'function') syncProposalsIndicator(); } catch (_) { }
                return { applied: false, skipped: true, proposalId, reason: 'Already applied' };
            }
            console.debug('[importAndApplySharedProposal] Proposal marked applied but descendants not on map — falling through to re-apply', { proposalId: normalized.proposalId });
        }
    }

    const skipDependencyFetch = options && options.skipDependencyFetch === true;
    const applyOptions = skipDependencyFetch ? { suppressMissingParentAlerts: true } : {};

    // Some flows (notably /proposals/:id1,id2,...) want to apply a queue where missing parcels
    // are expected to appear after other proposals apply. In that case do NOT fetch parcels here;
    // let ProposalManager apply or throw, and let the caller requeue.
    let parentIds = [];
    if (!skipDependencyFetch) {
        try {
            parentIds = await ensureParentParcelsFetched(sharedProposal, normalized);
        } catch (error) {
            console.warn('Failed to fetch parent parcels for shared proposal', sharedProposal.proposalId, error);
            return { applied: false, skipped: false, proposalId, reason: `Failed to fetch parent parcels: ${error && error.message ? error.message : 'unknown error'}` };
        }
    } else {
        try {
            parentIds = ensureArrayOfStrings(computeRequiredParentIdsForSharedProposal(sharedProposal));
        } catch (_) {
            parentIds = [];
        }
    }

    // For road proposals: ensure parentParcelIds are set
    // (geometries will be fetched by ID when needed for reconstruction)
    if (normalized.roadProposal) {
        if (!ensureRoadParentParcelIds(sharedProposal, normalized, parentIds)) {
            console.warn('Missing parent parcel IDs for road proposal', sharedProposal.proposalId);
            return { applied: false, skipped: false, proposalId, reason: 'Missing parent parcel IDs for road proposal' };
        }
    }

    if (existing) {
        // Try applying existing without re-importing (idempotent)
        // For roads, ensure parent features exist on stored object
        if (normalized.roadProposal && normalized.roadProposal.parentParcelIds) {
            existing.roadProposal = existing.roadProposal || {};
            existing.roadProposal.parentParcelIds = normalized.roadProposal.parentParcelIds;
            if (typeof proposalStorage._indexProposal === 'function') {
                proposalStorage._indexProposal(existing);
            }
            proposalStorage.save();
        }
        const appliedExisting = await ProposalManager.applyProposal(existing.proposalId, applyOptions);
        try { if (typeof syncProposalsIndicator === 'function') syncProposalsIndicator(); } catch (_) { }
        if (appliedExisting) {
            return { applied: true, skipped: false, proposalId };
        }

        if (skipDependencyFetch) {
            try {
                const lastInfo = getStoredApplyFailureInfo(existing.proposalId);
                if (lastInfo && lastInfo.message) {
                    return {
                        applied: false,
                        skipped: false,
                        proposalId,
                        reason: lastInfo.message,
                        failureInfo: lastInfo
                    };
                }
            } catch (_) { }
        }

        // If apply failed and we *did* do dependency fetch, provide a reason that upstream
        // can treat as retryable. (When skipDependencyFetch=true, caller will handle via thrown errors.)
        if (!skipDependencyFetch) {
            try {
                const required = ensureArrayOfStrings(parentIds);
                const missing = findMissingParentParcels(required);
                if (missing && missing.length > 0) {
                    const sample = missing.slice(0, 10).join(', ');
                    const suffix = missing.length > 10 ? '…' : '';
                    return { applied: false, skipped: false, proposalId, reason: `Missing required parcels: ${sample}${suffix}` };
                }
            } catch (_) { }
        }

        return { applied: false, skipped: false, proposalId, reason: 'Proposal did not apply' };
    }

    // Fresh import then apply
    const imported = proposalStorage.importProposal(normalized, { overwrite: true });
    if (!imported) {
        return { applied: false, skipped: false, proposalId, reason: 'Failed to import proposal' };
    }

    if (normalized.roadProposal && normalized.roadProposal.parentParcelIds) {
        imported.roadProposal = imported.roadProposal || {};
        imported.roadProposal.parentParcelIds = normalized.roadProposal.parentParcelIds;
        if (typeof proposalStorage._indexProposal === 'function') {
            proposalStorage._indexProposal(imported);
        }
        proposalStorage.save();
    }

    const applied = await ProposalManager.applyProposal(normalized.proposalId, applyOptions);
    try { if (typeof syncProposalsIndicator === 'function') syncProposalsIndicator(); } catch (_) { }
    if (applied) {
        return { applied: true, skipped: false, proposalId };
    }

    if (skipDependencyFetch) {
        try {
            const lastInfo = getStoredApplyFailureInfo(normalized.proposalId);
            if (lastInfo && lastInfo.message) {
                return {
                    applied: false,
                    skipped: false,
                    proposalId,
                    reason: lastInfo.message,
                    failureInfo: lastInfo
                };
            }
        } catch (_) { }
    }

    if (!skipDependencyFetch) {
        try {
            const required = ensureArrayOfStrings(parentIds);
            const missing = findMissingParentParcels(required);
            if (missing && missing.length > 0) {
                const sample = missing.slice(0, 10).join(', ');
                const suffix = missing.length > 10 ? '…' : '';
                return { applied: false, skipped: false, proposalId, reason: `Missing required parcels: ${sample}${suffix}` };
            }
        } catch (_) { }
    }

    return { applied: false, skipped: false, proposalId, reason: 'Proposal did not apply' };
}

// Make functions available globally
window.requirePersonalizedUser = requirePersonalizedUser;
window.showProposalDialog = showProposalDialog;
window.closeProposalDialog = closeProposalDialog;
window.createProposal = createProposal;
window.showAllProposalsModal = showAllProposalsModal;
window.switchProposalTab = switchProposalTab;
window.closeProposalList = closeProposalList;
window.showProposalDetailsModal = showProposalDetailsModal;
window.updateShowProposalsButton = updateShowProposalsButton;
window.updateProposalLayer = updateProposalLayer;
window.toggleExpiryInput = toggleExpiryInput;
window.toggleDecayInput = toggleDecayInput;
window.calculateDecayedOffer = calculateDecayedOffer;
window.getDecayProgress = getDecayProgress;
window.initializeDecayCountdown = initializeDecayCountdown;
window.isProposalExpired = isProposalExpired;
window.checkAndUpdateProposalExpiry = checkAndUpdateProposalExpiry;
window.initializeExpiryCountdown = initializeExpiryCountdown;
window.clearLocalProposalData = clearLocalProposalData;
window.centerOnProposal = centerOnProposal;
window.reapplyProposalHighlights = reapplyProposalHighlights;
window.selectProposalFromList = selectProposalFromList;
window.cancelMultiParcelSelection = cancelMultiParcelSelection;
window.deleteProposal = deleteProposal;
window.handleMultiSelectChange = handleMultiSelectChange;
window.handleShowProposalsChange = handleShowProposalsChange;
window.enableShowProposalsMode = enableShowProposalsMode;
window.refreshProposalData = refreshProposalData;
window.selectAndHighlightProposal = selectAndHighlightProposal;
window.calculateProposalBounds = calculateProposalBounds;
window.shareAppliedProposals = shareAppliedProposals;


function ensureProposalLoadOverlay() {
    if (proposalLoadOverlay) return proposalLoadOverlay;

    const styleId = 'proposal-load-overlay-style';
    if (!document.getElementById(styleId)) {
        const style = document.createElement('style');
        style.id = styleId;
        style.textContent = `
            @keyframes proposal-load-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
            .proposal-load-spinner { width: 28px; height: 28px; border: 3px solid #d0d7de; border-top-color: #0d3b66; border-radius: 50%; animation: proposal-load-spin 0.9s linear infinite; margin-bottom: 12px; }
        `;
        document.head.appendChild(style);
    }

    proposalLoadOverlay = document.createElement('div');
    proposalLoadOverlay.style.position = 'fixed';
    proposalLoadOverlay.style.inset = '0';
    proposalLoadOverlay.style.background = 'rgba(0,0,0,0.35)';
    proposalLoadOverlay.style.zIndex = '12050';
    proposalLoadOverlay.style.display = 'none';
    proposalLoadOverlay.style.alignItems = 'center';
    proposalLoadOverlay.style.justifyContent = 'center';

    const card = document.createElement('div');
    card.style.background = '#fff';
    card.style.borderRadius = '12px';
    card.style.padding = '20px 22px';
    card.style.width = '320px';
    card.style.boxShadow = '0 10px 30px rgba(0,0,0,0.25)';
    card.style.fontFamily = 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    card.style.textAlign = 'center';

    proposalLoadTitleEl = document.createElement('div');
    const initialTitle = (typeof tShare === 'function')
        ? tShare('plan.fetchingPlanTitle', 'Fetching proposal')
        : 'Fetching proposal';
    proposalLoadTitleEl.textContent = initialTitle;
    proposalLoadTitleEl.style.fontWeight = '700';
    proposalLoadTitleEl.style.fontSize = '16px';
    proposalLoadTitleEl.style.marginBottom = '6px';

    const spinner = document.createElement('div');
    spinner.className = 'proposal-load-spinner';
    spinner.setAttribute('aria-hidden', 'true');

    proposalLoadStatusEl = document.createElement('div');
    proposalLoadStatusEl.style.fontSize = '13px';
    proposalLoadStatusEl.style.color = '#334155';
    proposalLoadStatusEl.style.marginBottom = '6px';
    proposalLoadStatusEl.textContent = 'Preparing…';

    proposalLoadBytesEl = document.createElement('div');
    proposalLoadBytesEl.style.fontSize = '12px';
    proposalLoadBytesEl.style.color = '#64748b';
    proposalLoadBytesEl.textContent = '0.00 MB';

    proposalLoadProgressTextEl = document.createElement('div');
    proposalLoadProgressTextEl.style.fontSize = '12px';
    proposalLoadProgressTextEl.style.color = '#334155';
    proposalLoadProgressTextEl.style.marginTop = '8px';
    proposalLoadProgressTextEl.textContent = '';

    const progressBar = document.createElement('div');
    progressBar.style.position = 'relative';
    progressBar.style.height = '8px';
    progressBar.style.background = '#e5e7eb';
    progressBar.style.borderRadius = '999px';
    progressBar.style.overflow = 'hidden';
    progressBar.style.marginTop = '6px';
    progressBar.style.display = 'none';

    const progressFill = document.createElement('div');
    progressFill.style.position = 'absolute';
    progressFill.style.left = '0';
    progressFill.style.top = '0';
    progressFill.style.height = '100%';
    progressFill.style.width = '0%';
    progressFill.style.background = '#0d3b66';
    progressFill.style.transition = 'width 0.2s ease';

    progressBar.appendChild(progressFill);
    proposalLoadProgressBarEl = progressBar;
    proposalLoadProgressFillEl = progressFill;

    card.appendChild(proposalLoadTitleEl);
    card.appendChild(spinner);
    card.appendChild(proposalLoadStatusEl);
    card.appendChild(proposalLoadBytesEl);
    card.appendChild(proposalLoadProgressTextEl);
    card.appendChild(progressBar);
    proposalLoadOverlay.appendChild(card);
    document.body.appendChild(proposalLoadOverlay);

    return proposalLoadOverlay;
}


function showProposalLoadOverlay(status, options = {}) {
    ensureProposalLoadOverlay();
    const defaultTitle = (typeof tShare === 'function')
        ? tShare('plan.fetchingPlanTitle', 'Fetching proposal')
        : 'Fetching proposal';
    const titleText = (options && typeof options.title === 'string' && options.title.trim())
        ? options.title.trim()
        : defaultTitle;
    if (proposalLoadTitleEl) proposalLoadTitleEl.textContent = titleText;
    proposalLoadBytes = 0;
    if (proposalLoadStatusEl) proposalLoadStatusEl.textContent = status || 'Loading…';
    if (proposalLoadBytesEl) proposalLoadBytesEl.textContent = '0.00 MB';
    const total = (options && Number.isFinite(Number(options.total))) ? Number(options.total) : 0;
    proposalLoadProgressTotal = total > 0 ? total : 0;
    proposalLoadProgressDone = 0;
    renderProposalLoadProgress();
    if (proposalLoadOverlay) proposalLoadOverlay.style.display = 'flex';
}

function updateProposalLoadOverlay(options = {}) {
    if (!proposalLoadOverlay) return;
    if (options.status && proposalLoadStatusEl) {
        proposalLoadStatusEl.textContent = options.status;
    }
    if (Number.isFinite(options.bytesDelta) && options.bytesDelta > 0) {
        proposalLoadBytes += options.bytesDelta;
        if (proposalLoadBytesEl) {
            proposalLoadBytesEl.textContent = `${(proposalLoadBytes / (1024 * 1024)).toFixed(2)} MB`;
        }
    }
    if (options.progress) {
        if (Number.isFinite(options.progress.total)) {
            proposalLoadProgressTotal = Math.max(0, Number(options.progress.total));
        }
        if (Number.isFinite(options.progress.done)) {
            proposalLoadProgressDone = Math.max(0, Number(options.progress.done));
        }
        renderProposalLoadProgress();
    }
}

function hideProposalLoadOverlay(finalStatus) {
    if (proposalLoadOverlay) {
        proposalLoadOverlay.style.display = 'none';
    }
    if (finalStatus && typeof updateStatus === 'function') {
        updateStatus(finalStatus);
    }
}

async function addResponseBytes(response) {
    if (!response) return;
    try {
        const lenHeader = response.headers ? response.headers.get('content-length') : null;
        if (lenHeader && Number.isFinite(Number(lenHeader))) {
            updateProposalLoadOverlay({ bytesDelta: Number(lenHeader) });
            return;
        }
        const clone = response.clone();
        const buf = await clone.arrayBuffer();
        updateProposalLoadOverlay({ bytesDelta: buf.byteLength });
    } catch (_) { /* ignore */ }
}

function formatSharedProposalLabel(proposal, fallbackId) {
    const title = proposal && proposal.title ? String(proposal.title) : '';
    const pid = proposal && proposal.proposalId
        ? String(proposal.proposalId)
        : (fallbackId !== undefined && fallbackId !== null ? String(fallbackId) : '');
    if (title && pid) return `${title} (#${pid})`;
    if (title) return title;
    if (pid) return `#${pid}`;
    return 'proposal';
}

function formatSharedProposalTypeLabel(proposal) {
    try {
        if (!proposal) return '';
        return resolveProposalGoalKey(proposal, null);
    } catch (_) {
        return '';
    }
}

async function handleSharedPlanRoute(idParts, attempt = 0) {
    try {
        const t = getProposalI18nHelper();
        const tShare = getShareI18nHelper();

        console.log('[handleSharedPlanRoute] Starting with IDs:', idParts, 'attempt:', attempt);

        if (typeof map === 'undefined' || !map) {
            if (attempt < 15) {
                console.log('[handleSharedPlanRoute] Map not ready, retrying... attempt:', attempt);
                setTimeout(() => handleSharedPlanRoute(idParts, attempt + 1), 400);
            } else {
                console.error('[handleSharedPlanRoute] Map not ready after 15 attempts');
            }
            return;
        }

        const skipWelcomeGate = typeof window.shouldSkipWelcomeForProposalLink === 'function'
            ? window.shouldSkipWelcomeForProposalLink()
            : false;

        if (!skipWelcomeGate) {
            const welcomeModal = document.getElementById('welcome-modal');
            const isWelcomeModalVisible = welcomeModal && welcomeModal.style.display !== 'none';
            const hasUserAgent = typeof currentUserAgent !== 'undefined' && currentUserAgent !== null;

            console.log('[handleSharedPlanRoute] Welcome gate check:', {
                skipWelcomeGate,
                isWelcomeModalVisible,
                hasUserAgent
            });

            if (isWelcomeModalVisible || !hasUserAgent) {
                console.log('[handleSharedPlanRoute] Waiting for welcome modal to complete...');
                await new Promise((resolve) => {
                    if (!isWelcomeModalVisible && hasUserAgent) {
                        resolve();
                        return;
                    }
                    const onWelcomeComplete = () => {
                        console.log('[handleSharedPlanRoute] Welcome modal completed');
                        window.removeEventListener('welcomeModalComplete', onWelcomeComplete);
                        resolve();
                    };
                    window.addEventListener('welcomeModalComplete', onWelcomeComplete, { once: true });
                });
            }
        }

        // Apply many proposals robustly:
        // - descendant-only prerequisites: do NOT fetch, just requeue until available
        // - base-only prerequisites: fetch base parcels before applying
        // - mixed base + descendant prerequisites: kick off base fetch, then requeue
        const normalizeId = (raw) => {
            const s = (raw !== undefined && raw !== null) ? String(raw).trim() : '';
            return s;
        };

        const totalProposals = Array.from(new Set(idParts.map(normalizeId).filter(Boolean))).length;

        console.log('[handleSharedPlanRoute] Showing load overlay and fetching proposals...', { totalProposals });
        showProposalLoadOverlay(tShare('plan.fetchingPlan', 'Fetching plan…'), {
            total: totalProposals,
            title: tShare('plan.fetchingPlanTitle', 'Fetching proposal')
        });

        const backendBase = resolveBackendBaseUrl();
        const applied = [];
        const skipped = [];
        const failed = [];
        let lastLoadedProposalIdFor3D = null;

        const fetchProgressIds = new Set();
        const markFetchProgress = (rawId) => {
            const normalized = normalizeId(rawId);
            if (!normalized || fetchProgressIds.has(normalized)) return;
            fetchProgressIds.add(normalized);
            updateProposalLoadOverlay({ progress: { done: fetchProgressIds.size, total: totalProposals } });
        };
        const getFetchOrdinal = (rawId) => {
            const normalized = normalizeId(rawId);
            if (!normalized) return fetchProgressIds.size + 1;
            return fetchProgressIds.has(normalized) ? fetchProgressIds.size : fetchProgressIds.size + 1;
        };
        const getFailureMessage = (value) => {
            if (value && value.message) return String(value.message);
            if (typeof value === 'string') return value;
            return '';
        };
        const getDependencyFailureInfo = (value) => {
            if (!value) return null;
            const message = getFailureMessage(value);
            const code = (value && typeof value === 'object' && value.code) ? String(value.code) : '';
            const missingIds = (value && typeof value === 'object' && Array.isArray(value.missingIds))
                ? ensureArrayOfStrings(value.missingIds)
                : [];
            if (code === 'dependency-missing') {
                return { message, code, missingIds };
            }
            if (!message) return null;
            // Typical failure when parcels aren't yet available in parcelLayerById / cache.
            if (/Missing\s+parcel\s+.+\s+in\s+parcelLayerById/i.test(message)) return { message, code, missingIds };
            if (/missing\s+in\s+parcelLayerById/i.test(message)) return { message, code, missingIds };
            if (/prerequisite\s+parcels\s+are\s+missing/i.test(message)) return { message, code, missingIds };
            if (/Cannot\s+apply\s+proposal:\s+missing\s+parent\s+parcel\s+geometries/i.test(message)) return { message, code, missingIds };
            if (/Cannot\s+apply\s+proposal:\s+missing\s+parcel\s+geometries/i.test(message)) return { message, code, missingIds };
            return null;
        };
        const extractMissingParcelId = (value) => {
            const structuredMissingIds = (value && typeof value === 'object' && Array.isArray(value.missingIds))
                ? ensureArrayOfStrings(value.missingIds)
                : [];
            if (structuredMissingIds.length > 0) return structuredMissingIds[0];
            const msg = getFailureMessage(value);
            if (!msg) return null;
            const match = msg.match(/Missing\s+parcel\s+([^\s]+)\s+in\s+parcelLayerById/i);
            return match && match[1] ? String(match[1]) : null;
        };
        const isDerivedParcelId = (parcelId) => {
            const s = parcelId ? String(parcelId) : '';
            return s.includes('#p-');
        };

        const getPrerequisiteParcelIdsForProposal = (proposal) => {
            try {
                // Keep this minimal: only consult explicit parentParcelIds fields.
                // Do NOT attempt parcel feature resolution here.
                const ids = [];
                const computed = (typeof computeRequiredParentIdsForSharedProposal === 'function')
                    ? computeRequiredParentIdsForSharedProposal(proposal)
                    : [];
                ensureArrayOfStrings(computed).forEach(id => ids.push(id));

                // Some payloads keep ids under nested objects; include them defensively.
                if (proposal && proposal.roadProposal && Array.isArray(proposal.roadProposal.parentParcelIds)) {
                    ensureArrayOfStrings(proposal.roadProposal.parentParcelIds).forEach(id => ids.push(id));
                }
                if (proposal && proposal.buildingProposal && Array.isArray(proposal.buildingProposal.parentParcelIds)) {
                    ensureArrayOfStrings(proposal.buildingProposal.parentParcelIds).forEach(id => ids.push(id));
                }
                if (proposal && proposal.structureProposal && Array.isArray(proposal.structureProposal.parentParcelIds)) {
                    ensureArrayOfStrings(proposal.structureProposal.parentParcelIds).forEach(id => ids.push(id));
                }
                if (proposal && proposal.decideLaterProposal && Array.isArray(proposal.decideLaterProposal.parentParcelIds)) {
                    ensureArrayOfStrings(proposal.decideLaterProposal.parentParcelIds).forEach(id => ids.push(id));
                }
                if (proposal && Array.isArray(proposal.parentParcelIds)) {
                    ensureArrayOfStrings(proposal.parentParcelIds).forEach(id => ids.push(id));
                }

                return Array.from(new Set(ids.map(x => String(x)).filter(Boolean)));
            } catch (_) {
                return [];
            }
        };

        const splitBaseAndDerivedIds = (ids) => {
            const baseIds = [];
            const derivedIds = [];
            (Array.isArray(ids) ? ids : []).forEach(id => {
                const s = id && id.toString ? id.toString() : String(id || '');
                if (!s) return;
                (isDerivedParcelId(s) ? derivedIds : baseIds).push(s);
            });
            return {
                baseIds: Array.from(new Set(baseIds)),
                derivedIds: Array.from(new Set(derivedIds))
            };
        };
        const isDependencyFailure = (value) => {
            return Boolean(getDependencyFailureInfo(value));
        };

        let queue = idParts.map(normalizeId).filter(Boolean);
        // Position of each id in the link. Share URLs list proposals oldest-first, so the
        // highest position is the most recently created proposal — the one the view should
        // end up framing, exactly as if it had been loaded alone.
        const linkOrder = new Map();
        queue.forEach((id, idx) => linkOrder.set(id, idx));
        const cleanPlanUrl = () => {
            try {
                const newUrl = window.location.pathname.replace(/\/proposals\/[^/?#]+$/, '') + window.location.search + window.location.hash;
                if (window.history && typeof window.history.replaceState === 'function') {
                    window.history.replaceState({}, document.title, newUrl);
                }
            } catch (_) { }
        };
        updateProposalLoadOverlay({ progress: { done: fetchProgressIds.size, total: totalProposals } });
        const loadedById = new Map();
        const proposalTypeById = new Map();
        const basePrereqIdsById = new Map();
        const lastUnfetchedBasePrereqIdsById = new Map();
        const prereqIdsById = new Map();
        const lastMissingPrereqsById = new Map();
        const attemptById = new Map();
        const lastReasonById = new Map();
        const fetchedBaseParcels = new Set();
        const baseParcelFetchInFlight = new Map();
        const maxAttemptsPerId = 120;
        let stepsSinceProgress = 0;
        const attemptedSinceProgress = new Set();

        // Wait for PersistentStorage to be ready before checking local proposals.
        if (typeof PersistentStorage !== 'undefined' && PersistentStorage && typeof PersistentStorage.ensureReady === 'function') {
            await new Promise(resolve => PersistentStorage.ensureReady(resolve));
        }

        const urlRequests3D = is3DModeRequestedFromUrl();

        // Analyze what's currently applied vs what's incoming
        const incomingIds = new Set(queue.map(normalizeId).filter(Boolean));
        let allAppliedProposals = [];
        let incomingAlreadyApplied = [];
        let otherAppliedProposals = [];

        console.log('[handleSharedPlanRoute] Incoming IDs from URL:', Array.from(incomingIds));

        if (typeof proposalStorage !== 'undefined' && proposalStorage) {
            const allProposals = proposalStorage.getAllProposals() || [];
            // Only treat as "applied" for conflict analysis if descendants are actually on the map.
            // A proposal marked status=applied but with no descendants on parcelLayerById (e.g. a
            // fresh page reload before any apply has run) must NOT be skipped — we need to reach
            // the apply path so _applyRoadProposal can rebuild children from the definition.
            allAppliedProposals = allProposals.filter(p => isProposalAppliedAndMaterialized(p));

            // Categorize applied proposals
            allAppliedProposals.forEach(p => {
                const serverId = p.serverProposalId ? String(p.serverProposalId) : null;
                const hashId = p.proposalId ? String(p.proposalId) : null;
                // Also check using getServerProposalId helper which may extract from nested structures
                const extractedServerId = typeof getServerProposalId === 'function' ? getServerProposalId(p) : null;

                const isIncoming = (serverId && incomingIds.has(serverId))
                    || (hashId && incomingIds.has(hashId))
                    || (extractedServerId && incomingIds.has(String(extractedServerId)));

                console.log('[handleSharedPlanRoute] Checking applied proposal:',
                    'serverId=' + serverId,
                    'hashId=' + hashId,
                    'extractedServerId=' + extractedServerId,
                    'isIncoming=' + isIncoming
                );

                if (isIncoming) {
                    incomingAlreadyApplied.push(p);
                } else {
                    otherAppliedProposals.push(p);
                }
            });
        }

        const linkOrderForProposal = (p) => {
            if (!p) return -1;
            const candidates = [];
            if (p.serverProposalId) candidates.push(String(p.serverProposalId));
            if (p.proposalId) candidates.push(String(p.proposalId));
            try {
                const extracted = typeof getServerProposalId === 'function' ? getServerProposalId(p) : null;
                if (extracted) candidates.push(String(extracted));
            } catch (_) { }
            let best = -1;
            candidates.forEach(c => {
                if (linkOrder.has(c) && linkOrder.get(c) > best) best = linkOrder.get(c);
            });
            return best;
        };

        const mostRecentIncomingApplied = () => {
            let best = null;
            let bestOrd = -1;
            incomingAlreadyApplied.forEach(p => {
                const ord = linkOrderForProposal(p);
                if (ord >= bestOrd) {
                    bestOrd = ord;
                    best = p;
                }
            });
            return best;
        };

        const allIncomingApplied = incomingAlreadyApplied.length === totalProposals;
        const hasOtherApplied = otherAppliedProposals.length > 0;
        const noProposalsApplied = allAppliedProposals.length === 0;

        console.log('[handleSharedPlanRoute] Conflict analysis:',
            'totalProposals=' + totalProposals,
            'incomingAlreadyApplied=' + incomingAlreadyApplied.length,
            'otherApplied=' + otherAppliedProposals.length,
            'allIncomingApplied=' + allIncomingApplied,
            'hasOtherApplied=' + hasOtherApplied
        );

        // Helper: focus on applied proposals — frame and open them the same way a
        // single-proposal link would (center on visible descendant + details panel).
        const focusOnAppliedProposals = async (proposalIdToFocus) => {
            hideProposalLoadOverlay();
            if (proposalIdToFocus && typeof map !== 'undefined' && map) {
                try {
                    const visibleId = (typeof findVisibleDescendant === 'function')
                        ? (findVisibleDescendant(proposalIdToFocus) || proposalIdToFocus)
                        : proposalIdToFocus;
                    const bounds = calculateBoundsForLastAppliedProposal(visibleId);
                    if (bounds && bounds.isValid && bounds.isValid()) {
                        map.fitBounds(bounds, { padding: [80, 80], maxZoom: 18 });
                    }
                    if (typeof focusProposalDetails === 'function') {
                        await focusProposalDetails(visibleId, {
                            centerOnProposal: false,
                            showDetails: true
                        });
                    }
                } catch (err) {
                    console.warn('[handleSharedPlanRoute] Failed to focus on applied proposal:', err);
                }
            }
            if (urlRequests3D) {
                try { tryEnterThreeMode({ fromUrl: true }); } catch (_) { }
            }
        };

        // Helper: unapply all applied proposals
        const unapplyAllProposals = async () => {
            if (allAppliedProposals.length === 0) return;
            console.log('[handleSharedPlanRoute] Unapplying all', allAppliedProposals.length, 'applied proposals...');
            if (typeof ProposalManager !== 'undefined') {
                for (const p of allAppliedProposals) {
                    const pid = p.proposalId || p.serverProposalId;
                    if (!pid) continue;
                    try {
                        console.info('[handleSharedPlanRoute] Unapplying proposal', pid);
                        if (typeof ProposalManager.unapplyWholeFamily === 'function') {
                            await ProposalManager.unapplyWholeFamily(pid);
                        } else if (typeof ProposalManager.unapplyProposal === 'function') {
                            await ProposalManager.unapplyProposal(pid, { skipConfirm: true });
                        }
                        console.info('[handleSharedPlanRoute] Unapplied proposal', pid);
                    } catch (err) {
                        console.warn('[handleSharedPlanRoute] Failed to unapply proposal:', pid, err);
                    }
                }
                if (typeof ProposalManager._refreshUIAfterProposalChange === 'function') {
                    ProposalManager._refreshUIAfterProposalChange(null);
                }
            }
            console.log('[handleSharedPlanRoute] Finished unapplying all proposals');
        };

        // Scenario 1: Plan already fully applied, no other proposals
        // → "Plan Already Applied [Show me] [OK]"
        if (allIncomingApplied && !hasOtherApplied) {
            hideProposalLoadOverlay();
            const lastApplied = mostRecentIncomingApplied() || incomingAlreadyApplied[0];
            const focusId = lastApplied ? (lastApplied.proposalId || lastApplied.serverProposalId) : null;
            // Resolve via onClose so dismissing the modal (×, Escape, overlay click)
            // does not leave this promise — and the whole route handler — hanging.
            await new Promise(resolve => {
                showSimpleShareModal({
                    title: tShare('plan.alreadyAppliedTitle', 'Plan Already Applied'),
                    body: `<p>${tShare('plan.alreadyAppliedMessage', 'This shared plan is already applied to the map.')}</p>`,
                    actions: [
                        {
                            label: tShare('plan.showMe', 'Show me'),
                            primary: true,
                            onClick: () => { focusOnAppliedProposals(focusId); }
                        },
                        {
                            label: t('modal.common.ok', 'OK'),
                            primary: false
                        }
                    ],
                    onClose: () => resolve()
                });
            });
            cleanPlanUrl();
            return;
        }

        // Scenario 2: Some incoming proposals are already applied OR other proposals exist
        // → Show dialog with scrollable list and ask user what to do
        const someIncomingApplied = incomingAlreadyApplied.length > 0 && incomingAlreadyApplied.length < totalProposals;
        if (someIncomingApplied || hasOtherApplied) {
            hideProposalLoadOverlay();

            // Build scrollable list of already-applied proposals
            const appliedListItems = [...incomingAlreadyApplied, ...otherAppliedProposals].map(p => {
                const title = escapeHtml(p.title || p.proposalId || p.serverProposalId || 'Untitled');
                const serverId = p.serverProposalId || (typeof getServerProposalId === 'function' ? getServerProposalId(p) : null);
                const idSuffix = serverId ? ` (#${escapeHtml(String(serverId))})` : '';
                return `<li>${title}${idSuffix}</li>`;
            }).join('');

            const listHtml = `
                <p>${tShare('plan.someAlreadyAppliedMessage', 'Some proposals are already applied on the map:')}</p>
                <ul class="applied-proposals-list" style="max-height: 120px; overflow-y: auto; margin: 8px 0; padding-left: 20px; border: 1px solid var(--border-color, #ccc); border-radius: 4px; background: var(--bg-secondary, #f5f5f5);">
                    ${appliedListItems}
                </ul>
                <p>${tShare('plan.whatToDo', 'What would you like to do?')}</p>
            `;

            // autoCloseActions is off so each action can resolve before closing; closing the
            // modal any other way (×, Escape, overlay click) resolves as a cancel instead of
            // leaving the promise hanging.
            const userChoice = await new Promise(resolve => {
                showSimpleShareModal({
                    title: tShare('plan.someAlreadyAppliedTitle', 'Some Proposals Already Applied'),
                    body: listHtml,
                    autoCloseActions: false,
                    actions: [
                        {
                            label: tShare('plan.applyRemaining', 'Apply remaining'),
                            primary: true,
                            onClick: (modal) => {
                                resolve('apply-remaining');
                                if (modal && typeof modal.close === 'function') modal.close();
                            }
                        },
                        {
                            label: tShare('plan.unapplyThenApply', 'Unapply existing, then apply'),
                            primary: false,
                            onClick: (modal) => {
                                resolve('unapply');
                                if (modal && typeof modal.close === 'function') modal.close();
                            }
                        }
                    ],
                    onClose: () => resolve('cancel')
                });
            });

            if (userChoice === 'cancel') {
                cleanPlanUrl();
                if (typeof showEphemeralMessage === 'function') {
                    showEphemeralMessage(tShare('importCancelled', 'Shared proposal import cancelled.'));
                }
                return;
            }

            if (userChoice === 'unapply') {
                await unapplyAllProposals();
                // After unapply, reset the already-applied tracking since we cleared them
                incomingAlreadyApplied = [];
            }

            // Re-show loading overlay and continue with applying
            showProposalLoadOverlay(tShare('plan.fetchingPlan', 'Fetching plan…'), {
                total: totalProposals,
                title: tShare('plan.fetchingPlanTitle', 'Fetching proposal')
            });
        }

        // Scenario 3: No proposals on map → proceed silently (no dialog needed)

        // Build set of already-applied server IDs to exclude from queue
        const alreadyAppliedServerIds = new Set();
        incomingAlreadyApplied.forEach(p => {
            if (p.serverProposalId) alreadyAppliedServerIds.add(String(p.serverProposalId));
            const extracted = typeof getServerProposalId === 'function' ? getServerProposalId(p) : null;
            if (extracted) alreadyAppliedServerIds.add(String(extracted));
        });

        // Queue only proposals that are NOT already applied (deduplicated)
        queue = Array.from(new Set(idParts.map(normalizeId).filter(id => {
            if (!id) return false;
            if (alreadyAppliedServerIds.has(id)) {
                console.log('[handleSharedPlanRoute] Skipping already-applied proposal:', id);
                return false;
            }
            return true;
        })));

        console.log('[handleSharedPlanRoute] Queue after filtering out already-applied:', queue.length, 'of', totalProposals);
        updateProposalLoadOverlay({ progress: { done: fetchProgressIds.size, total: totalProposals } });

        // If nothing left to apply after filtering, focus on what's already applied and we're done
        if (queue.length === 0) {
            console.log('[handleSharedPlanRoute] All proposals already applied, focusing on them');
            const lastApplied = mostRecentIncomingApplied() || incomingAlreadyApplied[0];
            const focusId = lastApplied ? (lastApplied.proposalId || lastApplied.serverProposalId) : null;
            await focusOnAppliedProposals(focusId);
            cleanPlanUrl();
            return;
        }

        const startFetchBaseParcels = async (parcelIds, options = {}) => {
            const ids = ensureArrayOfStrings(parcelIds);
            if (!ids.length) return { attempted: [], missingAfter: [] };

            const unique = Array.from(new Set(ids));
            const toFetch = [];
            unique.forEach(id => {
                if (!id) return;
                if (fetchedBaseParcels.has(id)) return;
                if (baseParcelFetchInFlight.has(id)) return;
                // Skip parcels already consumed by an earlier applied proposal; ingest
                // would skip them anyway and waiting for them causes an infinite loop.
                if (typeof isParcelReplacedByChildren === 'function' && isParcelReplacedByChildren(id)) return;
                toFetch.push(id);
            });

            // If nothing new to fetch, optionally await any in-flight fetches for these ids.
            if (!toFetch.length) {
                if (options.await === true) {
                    const inflight = unique.map(id => baseParcelFetchInFlight.get(id)).filter(Boolean);
                    if (inflight.length) {
                        await Promise.allSettled(inflight);
                    }
                }
                const missingAfter = unique.filter(id => {
                    if (typeof isParcelLayerReady === 'function' && isParcelLayerReady(id)) return false;
                    if (typeof isParcelReplacedByChildren === 'function' && isParcelReplacedByChildren(id)) return false;
                    return true;
                });
                return { attempted: [], missingAfter };
            }

            // Bulk fetch (per proposal): one request chain for the full list.
            const batchPromise = (async () => {
                try {
                    if (typeof fetchParcelsForIds === 'function') {
                        await fetchParcelsForIds(toFetch, { forceRefresh: true });
                    } else if (typeof ensureParentParcelsLoaded === 'function') {
                        await ensureParentParcelsLoaded(toFetch, { forceRefreshParcels: true });
                    }
                    if (typeof waitForParcelLayersReady === 'function') {
                        await waitForParcelLayersReady(toFetch, { timeoutMs: 15000, pollIntervalMs: 200 });
                    }
                } catch (err) {
                    console.warn('[handleSharedPlanRoute] Failed to bulk fetch base parcels for apply plan', { ids: toFetch, err });
                } finally {
                    toFetch.forEach(id => baseParcelFetchInFlight.delete(id));
                }
            })();

            // Track per-id promise for this batch so later proposals can await without duplicating work.
            toFetch.forEach(id => baseParcelFetchInFlight.set(id, batchPromise));

            if (options.await === true) {
                await Promise.allSettled([batchPromise]);
            }

            // Mark fetched ids that are now ready.
            toFetch.forEach(id => {
                try {
                    if (typeof isParcelLayerReady === 'function' && isParcelLayerReady(id)) {
                        fetchedBaseParcels.add(id);
                    }
                } catch (_) { }
            });

            const missingAfter = unique.filter(id => {
                try {
                    if (typeof isParcelLayerReady === 'function' && isParcelLayerReady(id)) return false;
                    if (typeof isParcelReplacedByChildren === 'function' && isParcelReplacedByChildren(id)) return false;
                    return true;
                } catch (_) {
                    return true;
                }
            });

            return { attempted: toFetch, missingAfter };
        };

        while (queue.length > 0) {
            const id = queue.shift();
            try { attemptedSinceProgress.add(normalizeId(id)); } catch (_) { }
            const priorAttempts = attemptById.get(id) || 0;
            attemptById.set(id, priorAttempts + 1);

            // Hard stop for a single proposal to avoid infinite loops.
            if (attemptById.get(id) > maxAttemptsPerId) {
                const cachedProposal = loadedById.get(id) || null;
                const cachedType = proposalTypeById.get(id) || formatSharedProposalTypeLabel(cachedProposal);
                const key = String(id);

                const missingPrereqs = (() => {
                    try {
                        const explicitMissing = lastMissingPrereqsById.get(key) || lastUnfetchedBasePrereqIdsById.get(key);
                        if (Array.isArray(explicitMissing) && explicitMissing.length) return explicitMissing;
                        const storedFailure = getStoredApplyFailureInfo(key);
                        if (storedFailure && Array.isArray(storedFailure.missingIds) && storedFailure.missingIds.length) {
                            return ensureArrayOfStrings(storedFailure.missingIds);
                        }
                        const basePrereqs = basePrereqIdsById.get(key) || [];
                        return ensureArrayOfStrings(basePrereqs)
                            .filter(pid => !(typeof isParcelLayerReady === 'function' && isParcelLayerReady(pid)));
                    } catch (_) {
                        return [];
                    }
                })();

                const fallbackReason = (() => {
                    try {
                        const cached = lastReasonById.get(key);
                        if (cached) return String(cached);
                        const storedFailure = getStoredApplyFailureInfo(key);
                        return storedFailure && storedFailure.message ? String(storedFailure.message) : '';
                    } catch (_) {
                        return '';
                    }
                })();

                const reasonParts = [];
                if (fallbackReason) reasonParts.push(fallbackReason);
                if (missingPrereqs.length) reasonParts.push(`Missing prerequisite parcels: ${missingPrereqs.join(', ')}`);
                const reason = reasonParts.length
                    ? reasonParts.join(' · ') + ` (too many retries: ${maxAttemptsPerId})`
                    : tShare('plan.applyUnknownFailure', 'Unknown error while applying.') + ` (too many retries: ${maxAttemptsPerId})`;

                console.warn('[handleSharedPlanRoute] Giving up after max retries', { id, reason, missingPrereqs });

                failed.push({
                    id,
                    label: formatSharedProposalLabel(cachedProposal, id),
                    type: cachedType,
                    missingPrereqs,
                    reason
                });
                stepsSinceProgress += 1;
                continue;
            }

            try {
                let proposal = loadedById.get(id);
                if (!proposal) {
                    const baseStatus = tShare('plan.fetching', 'Fetching proposal #{{id}}…', { id });
                    const ordinal = getFetchOrdinal(id);
                    const fetchingStatus = (totalProposals > 0)
                        ? `${baseStatus} (${ordinal}/${totalProposals})`
                        : baseStatus;
                    updateProposalLoadOverlay({
                        status: fetchingStatus,
                        progress: { done: fetchProgressIds.size, total: totalProposals }
                    });
                    const response = await fetch(`${backendBase}/proposals/${encodeURIComponent(id)}`);
                    await addResponseBytes(response);
                    if (!response.ok) {
                        let reason;
                        if (response.status === 404) {
                            reason = tShare('plan.notFoundOnServer', 'Not found on server');
                        } else {
                            reason = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`.trim();
                        }
                        failed.push({ id, label: formatSharedProposalLabel(null, id), reason });
                        markFetchProgress(id);
                        stepsSinceProgress += 1;
                        continue;
                    }
                    proposal = await response.json();
                    loadedById.set(id, proposal);
                    try {
                        const inferredType = formatSharedProposalTypeLabel(proposal);
                        if (inferredType) proposalTypeById.set(id, inferredType);
                    } catch (_) { }
                }

                markFetchProgress(id);

                // Decide whether to fetch base parcels before applying.
                // - only base prerequisites: fetch and wait, then apply now
                // - mixed base+derived: kick off base fetch, then requeue without applying
                // - only derived: do not fetch; attempt apply
                const prereqIds = getPrerequisiteParcelIdsForProposal(proposal);
                const { baseIds, derivedIds } = splitBaseAndDerivedIds(prereqIds);
                try {
                    const queueKey = String(id);
                    const payloadKey = (proposal && proposal.proposalId) ? String(proposal.proposalId) : '';

                    prereqIdsById.set(queueKey, prereqIds);
                    basePrereqIdsById.set(queueKey, baseIds);
                    if (payloadKey) {
                        prereqIdsById.set(payloadKey, prereqIds);
                        basePrereqIdsById.set(payloadKey, baseIds);
                    }
                } catch (_) { }

                const computeMissingParentsNow = () => {
                    try {
                        const unique = Array.from(new Set(ensureArrayOfStrings(prereqIds)));
                        return unique.filter(pid => !(typeof isParcelLayerReady === 'function' && isParcelLayerReady(pid)));
                    } catch (_) {
                        return [];
                    }
                };

                const parseMissingFromString = (text) => {
                    try {
                        if (!text || typeof text !== 'string') return [];
                        const match = text.match(/missing[^:]*:\s*(.+)$/i);
                        if (match && match[1]) {
                            return match[1].split(/[,\s]+/).map(x => x.trim()).filter(Boolean);
                        }
                        return [];
                    } catch (_) { return []; }
                };

                if (baseIds.length > 0 && derivedIds.length > 0) {
                    // Mixed: fetch base parents and wait once before deciding whether to apply or requeue.
                    const fetchResult = await startFetchBaseParcels(baseIds, { await: true });
                    try {
                        lastUnfetchedBasePrereqIdsById.set(String(id), fetchResult.missingAfter);
                        if (proposal && proposal.proposalId) lastUnfetchedBasePrereqIdsById.set(String(proposal.proposalId), fetchResult.missingAfter);
                    } catch (_) { }

                    try {
                        const missingNow = computeMissingParentsNow();
                        lastMissingPrereqsById.set(String(id), missingNow);
                        if (proposal && proposal.proposalId) lastMissingPrereqsById.set(String(proposal.proposalId), missingNow);

                        const baseMissingNow = baseIds.filter(pid => {
                            if (typeof isParcelLayerReady === 'function' && isParcelLayerReady(pid)) return false;
                            // Parcel consumed by an earlier applied proposal — not missing, just off-map by design.
                            if (typeof isParcelReplacedByChildren === 'function' && isParcelReplacedByChildren(pid)) return false;
                            return true;
                        });
                        const derivedMissingNow = derivedIds.filter(pid => !(typeof isParcelLayerReady === 'function' && isParcelLayerReady(pid)));
                        const hint = baseMissingNow.length
                            ? `Waiting for base prerequisites (${baseMissingNow.slice(0, 6).join(', ')}${baseMissingNow.length > 6 ? ', …' : ''})`
                            : (derivedMissingNow.length
                                ? `Waiting for derived prerequisites (${derivedMissingNow.slice(0, 6).join(', ')}${derivedMissingNow.length > 6 ? ', …' : ''})`
                                : 'Waiting for prerequisites (mixed base + derived).');
                        lastReasonById.set(String(id), hint);
                        if (proposal && proposal.proposalId) lastReasonById.set(String(proposal.proposalId), hint);

                        // If base parents are still missing, requeue (do not apply yet).
                        if (baseMissingNow.length > 0) {
                            queue.push(id);
                            stepsSinceProgress += 1;
                            continue;
                        }
                        // Base parents are present; proceed to apply now (derived can still cause requeue on failure).
                    } catch (_) {
                        queue.push(id);
                        stepsSinceProgress += 1;
                        continue;
                    }
                }
                if (baseIds.length > 0 && derivedIds.length === 0) {
                    // Base-only: fetch before attempting apply.
                    const fetchResult = await startFetchBaseParcels(baseIds, { await: true });
                    try {
                        lastUnfetchedBasePrereqIdsById.set(String(id), fetchResult.missingAfter);
                        if (proposal && proposal.proposalId) lastUnfetchedBasePrereqIdsById.set(String(proposal.proposalId), fetchResult.missingAfter);
                        const missingNow = computeMissingParentsNow();
                        lastMissingPrereqsById.set(String(id), missingNow);
                        if (proposal && proposal.proposalId) lastMissingPrereqsById.set(String(proposal.proposalId), missingNow);
                    } catch (_) { }
                }

                updateProposalLoadOverlay({ status: tShare('plan.applying', 'Applying proposal #{{id}}…', { id }) });
                let result;
                try {
                    // For /proposals/:id1,id2,… we intentionally do NOT fetch/resolve parcels here.
                    // Missing parcels are expected to be created by earlier applies.
                    result = await importAndApplySharedProposal(proposal, { skipDependencyFetch: true });
                } catch (err) {
                    // Convert thrown dependency errors into retryable results.
                    if (isDependencyFailure(err)) {
                        result = { applied: false, skipped: false, proposalId: proposal?.proposalId || id, reason: err.message || String(err) };
                    } else {
                        throw err;
                    }
                }

                const proposalId = (result && result.proposalId) || proposal?.proposalId || id;
                const label = formatSharedProposalLabel(proposal, proposalId);
                try {
                    const inferredType = proposalTypeById.get(id) || formatSharedProposalTypeLabel(proposal);
                    if (inferredType) {
                        proposalTypeById.set(id, inferredType);
                        if (proposalId) proposalTypeById.set(String(proposalId), inferredType);
                    }
                } catch (_) { }

                // Ensure prereq maps are also keyed by the final resolved proposal id.
                try {
                    const pidKey = proposalId ? String(proposalId) : '';
                    if (pidKey && prereqIds && Array.isArray(prereqIds)) {
                        prereqIdsById.set(pidKey, prereqIds);
                        basePrereqIdsById.set(pidKey, baseIds);
                        const baseMissing = lastUnfetchedBasePrereqIdsById.get(String(id))
                            || lastUnfetchedBasePrereqIdsById.get((proposal && proposal.proposalId) ? String(proposal.proposalId) : '')
                            || [];
                        if (Array.isArray(baseMissing) && baseMissing.length) {
                            lastUnfetchedBasePrereqIdsById.set(pidKey, baseMissing);
                        }
                    }
                } catch (_) { }

                if (result && result.skipped) {
                    skipped.push({ id: proposalId, label, ord: linkOrder.has(normalizeId(id)) ? linkOrder.get(normalizeId(id)) : -1 });
                    if (proposalId) lastLoadedProposalIdFor3D = proposalId;
                    stepsSinceProgress = 0;
                    attemptedSinceProgress.clear();
                    continue;
                }

                if (result && result.applied) {
                    applied.push({ id: proposalId, label, ord: linkOrder.has(normalizeId(id)) ? linkOrder.get(normalizeId(id)) : -1 });
                    if (proposalId) lastLoadedProposalIdFor3D = proposalId;
                    stepsSinceProgress = 0;
                    attemptedSinceProgress.clear();
                    continue;
                }

                const reason = (result && result.reason) || tShare('plan.applyUnknownFailure', 'Unknown error while applying.');
                const dependencyFailure = getDependencyFailureInfo((result && result.failureInfo) ? result.failureInfo : reason);
                try { if (proposalId) lastReasonById.set(String(proposalId), String(reason || '')); } catch (_) { }
                if (dependencyFailure) {
                    const dependencyMissingIds = ensureArrayOfStrings(dependencyFailure.missingIds || []);
                    if (dependencyMissingIds.length > 0) {
                        const existingMissing = ensureArrayOfStrings(lastMissingPrereqsById.get(String(id)) || []);
                        const combinedMissing = Array.from(new Set(existingMissing.concat(dependencyMissingIds)));
                        lastMissingPrereqsById.set(String(id), combinedMissing);
                        if (proposalId) lastMissingPrereqsById.set(String(proposalId), combinedMissing);
                    }
                    // If the dependency is a *base* parcel (no #p- suffix), try fetching it once.
                    const missingParcelId = extractMissingParcelId(dependencyFailure);
                    if (missingParcelId && !isDerivedParcelId(missingParcelId) && !fetchedBaseParcels.has(missingParcelId)) {
                        fetchedBaseParcels.add(missingParcelId);
                        try {
                            const fetchResult = await startFetchBaseParcels([missingParcelId], { await: true });
                            try {
                                const key = String(proposalId || id);
                                const basePrereqs = basePrereqIdsById.get(key) || [];
                                const missingNow = Array.from(new Set([...(fetchResult.missingAfter || []), ...basePrereqs]))
                                    .filter(pid => pid && !(typeof isParcelLayerReady === 'function' && isParcelLayerReady(pid)));
                                lastUnfetchedBasePrereqIdsById.set(key, missingNow);
                            } catch (_) { }
                        } catch (fetchErr) {
                            // Best-effort only; still requeue.
                            console.warn('[handleSharedPlanRoute] Failed to fetch missing base parcel for apply plan', { missingParcelId, fetchErr });
                        }
                    }

                    // Bump to end of queue and try others; a later proposal may load required parcels.
                    try {
                        const missingNow = (() => {
                            try {
                                const full = prereqIdsById.get(String(id)) || prereqIdsById.get(String(proposalId)) || [];
                                const unique = Array.from(new Set(ensureArrayOfStrings(full)));
                                return unique.filter(pid => !(typeof isParcelLayerReady === 'function' && isParcelLayerReady(pid)));
                            } catch (_) { return []; }
                        })();
                        lastMissingPrereqsById.set(String(id), missingNow);
                        if (proposalId) lastMissingPrereqsById.set(String(proposalId), missingNow);
                    } catch (_) { }
                    queue.push(id);
                    stepsSinceProgress += 1;
                } else {
                    failed.push({
                        id: proposalId,
                        label,
                        type: (proposalTypeById.get(String(proposalId)) || proposalTypeById.get(String(id)) || formatSharedProposalTypeLabel(proposal) || ''),
                        missingPrereqs: (() => {
                            try {
                                const key = String(proposalId || id);
                                const explicitMissing = lastUnfetchedBasePrereqIdsById.get(key);
                                if (Array.isArray(explicitMissing) && explicitMissing.length) return explicitMissing;
                                const storedFailure = getStoredApplyFailureInfo(key);
                                if (storedFailure && Array.isArray(storedFailure.missingIds) && storedFailure.missingIds.length) {
                                    return ensureArrayOfStrings(storedFailure.missingIds);
                                }
                                const basePrereqs = basePrereqIdsById.get(key) || [];
                                const missing = ensureArrayOfStrings(basePrereqs)
                                    .filter(pid => !(typeof isParcelLayerReady === 'function' && isParcelLayerReady(pid)));
                                return missing;
                            } catch (_) {
                                return [];
                            }
                        })(),
                        reason
                    });
                    stepsSinceProgress += 1;
                }
            } catch (error) {
                console.error('apply plan item failed', id, error);
                const reason = (error && error.message) ? error.message : 'Unexpected error';
                try { lastReasonById.set(String(id), String(reason || '')); } catch (_) { }
                if (isDependencyFailure(error) || isDependencyFailure(reason)) {
                    queue.push(id);
                } else {
                    const cachedProposal = loadedById.get(id) || null;
                    failed.push({
                        id,
                        label: formatSharedProposalLabel(cachedProposal, id),
                        type: (proposalTypeById.get(id) || formatSharedProposalTypeLabel(cachedProposal) || ''),
                        missingPrereqs: (() => {
                            try {
                                const key = String(id);
                                const explicitMissing = lastUnfetchedBasePrereqIdsById.get(key);
                                if (Array.isArray(explicitMissing) && explicitMissing.length) return explicitMissing;
                                const storedFailure = getStoredApplyFailureInfo(key);
                                if (storedFailure && Array.isArray(storedFailure.missingIds) && storedFailure.missingIds.length) {
                                    return ensureArrayOfStrings(storedFailure.missingIds);
                                }
                                const basePrereqs = basePrereqIdsById.get(key) || [];
                                const missing = ensureArrayOfStrings(basePrereqs)
                                    .filter(pid => !(typeof isParcelLayerReady === 'function' && isParcelLayerReady(pid)));
                                return missing;
                            } catch (_) {
                                return [];
                            }
                        })(),
                        reason
                    });
                }
                markFetchProgress(id);
                stepsSinceProgress += 1;
            }

            // If we've attempted every remaining unique id since last progress and still made no progress,
            // stop to avoid an infinite loop. (This also ensures we capture at least one failure reason per id.)
            if (queue.length > 0) {
                const remainingUnique = new Set(queue.map(normalizeId).filter(Boolean));
                let allAttempted = true;
                for (const rem of remainingUnique) {
                    if (!attemptedSinceProgress.has(rem)) {
                        allAttempted = false;
                        break;
                    }
                }
                if (allAttempted && stepsSinceProgress >= remainingUnique.size) {
                    break;
                }
            }
        }

        // Anything left in the queue after the loop is considered blocked.
        if (queue.length > 0) {
            const seen = new Set();
            queue.forEach(id => {
                const norm = normalizeId(id);
                if (!norm || seen.has(norm)) return;
                seen.add(norm);
                const cachedProposal = loadedById.get(norm) || null;
                const cachedType = proposalTypeById.get(norm) || formatSharedProposalTypeLabel(cachedProposal);
                const missingPrereqs = (() => {
                    try {
                        const combined = new Set();
                        const explicitMissing = lastMissingPrereqsById.get(norm) || lastUnfetchedBasePrereqIdsById.get(norm);
                        ensureArrayOfStrings(explicitMissing).forEach(id => combined.add(id));
                        const storedFailure = getStoredApplyFailureInfo(norm);
                        ensureArrayOfStrings(storedFailure && storedFailure.missingIds ? storedFailure.missingIds : []).forEach(id => combined.add(id));

                        const basePrereqs = basePrereqIdsById.get(norm) || [];
                        ensureArrayOfStrings(basePrereqs)
                            .filter(pid => !(typeof isParcelLayerReady === 'function' && isParcelLayerReady(pid)))
                            .forEach(id => combined.add(id));

                        const allPrereqs = prereqIdsById.get(norm) || [];
                        ensureArrayOfStrings(allPrereqs)
                            .filter(pid => !(typeof isParcelLayerReady === 'function' && isParcelLayerReady(pid)))
                            .forEach(id => combined.add(id));

                        const fallback = (() => {
                            try {
                                const reason = lastReasonById.get(norm) || fallbackReason;
                                return parseMissingFromString(reason);
                            } catch (_) { return []; }
                        })();
                        ensureArrayOfStrings(fallback).forEach(id => combined.add(id));

                        return Array.from(combined);
                    } catch (_) {
                        return [];
                    }
                })();
                const lastReason = (() => {
                    try {
                        const cached = lastReasonById.get(norm);
                        return cached ? String(cached) : '';
                    } catch (_) {
                        return '';
                    }
                })();

                const fallbackReason = (() => {
                    try {
                        if (lastReason) return '';
                        const storedFailure = getStoredApplyFailureInfo(norm);
                        return storedFailure && storedFailure.message ? String(storedFailure.message) : '';
                    } catch (_) {
                        return '';
                    }
                })();

                const reasonParts = [tShare('plan.applyBlockedByDependencies', 'Blocked: dependencies not satisfied after retries.')];
                if (lastReason) reasonParts.push(lastReason);
                else if (fallbackReason) reasonParts.push(fallbackReason);
                if (missingPrereqs.length) {
                    reasonParts.push(`Missing prerequisite parcels: ${missingPrereqs.join(', ')}`);
                }

                failed.push({
                    id: norm,
                    label: formatSharedProposalLabel(cachedProposal, norm),
                    type: cachedType,
                    missingPrereqs,
                    reason: reasonParts.join(' · ')
                });
            });
        }

        hideProposalLoadOverlay();

        cleanPlanUrl();

        const escape = typeof escapeHtml === 'function' ? escapeHtml : (value => value);
        const renderList = (items, formatter) => {
            const content = items.map(formatter).join('');
            return `<div class="shared-plan-list" style="max-height: 320px; overflow-y: auto; padding-right: 4px;"><ul style="margin: 0; padding-left: 18px;">${content}</ul></div>`;
        };

        const bodyLines = [];
        if (applied.length > 0) {
            const appliedItems = renderList(applied, item => `<li>${escape(item.label || formatSharedProposalLabel(null, item.id))}</li>`);
            bodyLines.push(`<p>${tShare('plan.appliedCountDetailed', 'Applied {{count}} proposal{{suffix}}:', {
                count: applied.length,
                suffix: applied.length === 1 ? '' : 's'
            })}</p>${appliedItems}`);
        }
        if (skipped.length > 0) {
            if (bodyLines.length > 0) bodyLines.push('<br>');
            const skippedItems = renderList(skipped, item => `<li>${escape(item.label || formatSharedProposalLabel(null, item.id))}</li>`);
            bodyLines.push(`<p>${tShare('plan.skippedCountDetailed', 'Skipped {{count}} duplicate proposal{{suffix}} (already present):', {
                count: skipped.length,
                suffix: skipped.length === 1 ? '' : 's'
            })}</p>${skippedItems}`);
        }
        if (failed.length > 0) {
            if (bodyLines.length > 0) bodyLines.push('<br>');
            const failedItems = renderList(failed, item => {
                const label = escape(item.label || formatSharedProposalLabel(null, item.id));
                const type = item.type ? ` (${escape(item.type)})` : '';
                const reason = item.reason ? ` · ${escape(item.reason)}` : '';
                const missing = ensureArrayOfStrings(item.missingPrereqs || []);
                const missingBlock = missing.length
                    ? `<ul style="margin: 4px 0 0 16px; padding-left: 16px; list-style-type: circle;">
                        ${missing.map(pid => `<li>${escape(pid)}</li>`).join('')}
                    </ul>`
                    : '';
                return `<li>${label}${type}${reason}${missingBlock}</li>`;
            });
            bodyLines.push(`<p>${tShare('plan.failedCountDetailed', 'Failed to apply {{count}} proposal{{suffix}}:', {
                count: failed.length,
                suffix: failed.length === 1 ? '' : 's'
            })}</p>${failedItems}`);
        }

        const wants3DFromUrl = (!url3DModeHandled && is3DModeRequestedFromUrl());

        if (applied.length > 0) {
            if (typeof updateProposalLayer === 'function') updateProposalLayer();
            if (typeof updateShowProposalsButton === 'function') updateShowProposalsButton();
        }

        // Center map on the visible descendant of the most recently loaded proposal — the one
        // latest in link order among everything now on the map (applied, skipped as duplicate,
        // or filtered out earlier because it was already applied) — as if it were loaded alone.
        // Link order is used instead of chronological apply order because dependency requeueing
        // can apply an older proposal after a newer one.
        let rawLastProposalId = null;
        let rawLastOrd = -1;
        const considerFocusCandidate = (candidateId, ord) => {
            if (!candidateId) return;
            const effectiveOrd = Number.isFinite(ord) ? ord : -1;
            if (effectiveOrd >= rawLastOrd) {
                rawLastOrd = effectiveOrd;
                rawLastProposalId = candidateId;
            }
        };
        applied.forEach(item => considerFocusCandidate(item.id, item.ord));
        skipped.forEach(item => considerFocusCandidate(item.id, item.ord));
        incomingAlreadyApplied.forEach(p => considerFocusCandidate(p.proposalId || p.serverProposalId, linkOrderForProposal(p)));
        if (!rawLastProposalId) {
            rawLastProposalId = lastLoadedProposalIdFor3D
                || (applied.length > 0 ? applied[applied.length - 1].id : null)
                || (skipped.length > 0 ? skipped[skipped.length - 1].id : null);
        }
        const lastProposalId = rawLastProposalId ? findVisibleDescendant(rawLastProposalId) : null;
        console.log('[handleSharedPlanRoute] Centering on proposal:', rawLastProposalId, '→ visible descendant:', lastProposalId);

        if (lastProposalId && typeof map !== 'undefined' && map) {
            try {
                const beforeCenter = (typeof map.getCenter === 'function') ? map.getCenter() : null;
                const beforeZoom = (typeof map.getZoom === 'function') ? map.getZoom() : null;
                const settlePromise = createLeafletViewSettlePromise(beforeCenter, beforeZoom);
                const bounds = calculateBoundsForLastAppliedProposal(lastProposalId);
                if (bounds && bounds.isValid && bounds.isValid()) {
                    map.fitBounds(bounds, { padding: [80, 80], maxZoom: 18 });
                }
                await settlePromise;
            } catch (error) {
                console.warn('Failed to center map on last applied proposal:', error);
            }
        }

        // Highlight the loaded proposal + open details panel. handleSharedPlanRoute only applied
        // the proposal and centered the map; without this call, window.currentlyHighlightedProposal
        // stays null and no overlays are drawn. For a multi-id share we highlight the last one
        // (same semantics as centering, which uses the last applied id).
        if (lastProposalId && typeof focusProposalDetails === 'function') {
            try {
                await focusProposalDetails(lastProposalId, {
                    centerOnProposal: false, // camera has already been fit to bounds above
                    showDetails: true
                });
            } catch (error) {
                console.warn('[handleSharedPlanRoute] focusProposalDetails failed', error);
            }
        }

        let planSummaryModal = null;
        if (bodyLines.length > 0) {
            planSummaryModal = showSimpleShareModal({
                title: tShare('plan.summary', 'Shared Plan Result'),
                body: bodyLines.join(''),
                actions: [
                    { label: t('modal.common.close', 'Close'), primary: true }
                ],
                onClose: () => {
                    // URL-driven 3D mode: only enter after the user dismisses the results dialog.
                    try {
                        if (wants3DFromUrl && !url3DModeHandled) {
                            const entered = tryEnterThreeMode({ fromUrl: true });
                            if (entered) url3DModeHandled = true;
                        }
                    } catch (_) { }
                }
            });
        }

        // No dialog shown -> honor URL-driven 3D immediately after focusing.
        if (!planSummaryModal) {
            try {
                if (wants3DFromUrl && !url3DModeHandled) {
                    const entered = tryEnterThreeMode({ fromUrl: true });
                    if (entered) url3DModeHandled = true;
                }
            } catch (_) { }
        }
    } catch (error) {
        console.error('handleSharedPlanRoute failed', error);
        hideProposalLoadOverlay();
    } finally {
        if (typeof window !== 'undefined') {
            window.skipParcelFetchUntilProposalLoaded = false;
        }
    }
}

async function handleProposalRouteFromUrl(attempt = 0) {
    try {
        const pathname = window.location.pathname || '';
        const isProposalPath = pathname.startsWith('/proposals/');

        // Ignore non-proposal routes entirely
        if (!isProposalPath) {
            return;
        }

        // Handle bare /proposals/ route (no ids) by opening the appropriate dialog
        const isBareProposalsRoute = /^\/proposals\/?$/.test(pathname);
        if (isBareProposalsRoute) {
            const wm = typeof window !== 'undefined' ? window.walletManager : null;
            const walletState = wm && typeof wm.getState === 'function' ? wm.getState() : null;
            const walletConnected = Boolean(
                walletState &&
                walletState.status === 'connected' &&
                Array.isArray(walletState.accounts) &&
                walletState.accounts.length > 0
            );

            if (walletConnected && typeof window.openMintedProposalsModal === 'function') {
                console.debug('[handleProposalRouteFromUrl] Opening minted proposals modal for /proposals/');
                window.openMintedProposalsModal();
            } else if (typeof showAllProposalsModal === 'function') {
                console.debug('[handleProposalRouteFromUrl] Opening local proposals list for /proposals/');
                showAllProposalsModal();
            }
            return;
        }

        // Check if URL matches /proposals/:id or comma-separated ids
        const pathMatch = pathname.match(/^\/proposals\/([0-9,]+)$/);
        if (!pathMatch) {
            console.debug('[handleProposalRouteFromUrl] Proposal path did not match expected pattern:', pathname);
            return;
        }
        console.log('[handleProposalRouteFromUrl] Matched path:', pathMatch[1], 'attempt:', attempt);

        const idSegment = pathMatch[1];
        const idParts = idSegment.split(',').map(v => v.trim()).filter(Boolean);
        if (idParts.length === 0) {
            console.log('[handleProposalRouteFromUrl] No valid ID parts found');
            return;
        }

        // Single proposal is just an array of one - use the same handler
        console.log('[handleProposalRouteFromUrl] Delegating to handleSharedPlanRoute:', idParts);
        await handleSharedPlanRoute(idParts);
    } catch (error) {
        console.error('handleProposalRouteFromUrl failed:', error);
    }
}

function handleStandalone3DModeFromUrl(attempt = 0) {
    try {
        if (url3DModeHandled) return;
        const wants3D = is3DModeRequestedFromUrl();
        if (!wants3D) return;

        // Check if there are proposal-related URL params - if so, let proposal handlers deal with 3D
        const params = new URLSearchParams(window.location.search || '');
        const hasProposalParams = params.has('proposalShare') || params.has('shared') || window.location.pathname.startsWith('/proposals/');
        if (hasProposalParams) {
            // Proposal handlers will handle 3D mode, so we don't need to do anything here
            return;
        }

        if (typeof map === 'undefined' || !map) {
            if (attempt < 15) {
                setTimeout(() => handleStandalone3DModeFromUrl(attempt + 1), 400);
            }
            return;
        }

        // No proposal params, so enter 3D mode directly after map is ready
        // Wait a short moment to ensure map is fully initialized
        setTimeout(() => {
            if (!url3DModeHandled && is3DModeRequestedFromUrl()) {
                const entered = tryEnterThreeMode({ fromUrl: true });
                if (entered) url3DModeHandled = true;
            }
        }, 300);
    } catch (error) {
        console.error('handleStandalone3DModeFromUrl failed', error);
    }
}

window.addEventListener('load', () => {
    setTimeout(() => handleProposalRouteFromUrl(), 100);
    setTimeout(() => handleSingleProposalShareFromUrl(), 200);
    setTimeout(() => handleSharedProposalsFromUrl(), 250);
    setTimeout(() => handleStandalone3DModeFromUrl(), 500);
    // Initialize proposals indicator at startup
    setTimeout(() => { try { syncProposalsIndicator(); } catch (_) { } }, 300);
});

// Handle selection of a proposal from the multiple proposals list
function selectProposalFromList(proposalIdOrHash, parcelId) {
    const proposal = getProposalByIdOrHash(proposalIdOrHash);
    if (!proposal) {
        console.error('Proposal not found:', proposalIdOrHash);
        updateStatus('Error: Proposal not found');
        return;
    }

    selectAndHighlightProposal(getProposalKey(proposal) || proposalIdOrHash, parcelId, true);
}

// Cancel multi-parcel selection

/**
 * Coalesced repaint of the currently-selected proposal's highlights. Used by every event
 * that can change which parcels need to be drawn or which descendants now exist on the map:
 * pan/zoom (moveend/zoomend), and parcel ingest completion (parcelDataLoaded). One handle
 * for all sources, so a burst of events causes one repaint, not N.
 */
const PROPOSAL_HIGHLIGHT_REFRESH_DEBOUNCE_MS = 120;


// Set up map event listeners to reapply multi-parcel highlights AND proposal highlights after move/zoom.
// Same handler for both — a single coalesced repaint of whatever overlay is currently active.

// Try to set up listeners immediately, or retry until map is available
if (!setupMultiParcelHighlightListeners()) {
    document.addEventListener('DOMContentLoaded', function () {
        let attempts = 0;
        const maxAttempts = 20;
        const interval = setInterval(() => {
            if (setupMultiParcelHighlightListeners() || ++attempts > maxAttempts) {
                clearInterval(interval);
            }
        }, 200);
    });
}

// Accept proposal function (for specific parcel) - pure data function


// Accept proposal function (for specific parcel)
async function handleUserAcceptProposal(proposalId, parcelId, ownerKey = null) {
    const userAgent = typeof getCurrentUserAgent === 'function' ? getCurrentUserAgent() : null;
    if (!userAgent) {
        showProposalAlertMessage('you_must_be_logged_in_to_accept_proposals', 'You must be logged in to accept proposals.');
        return;
    }

    // Get the proposal to check stored owner acceptance data
    const proposal = proposalStorage.getProposal(proposalId);
    if (!proposal) {
        showProposalAlertMessage('proposal_not_found', 'Proposal not found.');
        return;
    }

    const normalizedParcelId = normalizeParcelId(parcelId);
    if (!normalizedParcelId) {
        showProposalAlertMessage('invalid_parcel_identifier', 'Invalid parcel identifier.');
        return;
    }

    // Ensure owner acceptance entry exists and get owner slots
    const ownerSlots = getOwnerSlotsForParcel(parcelId);
    const entry = ensureOwnerAcceptanceEntry(proposal, normalizedParcelId, ownerSlots, { syncWithParcelAcceptance: false });
    if (!entry) {
        showProposalAlertMessage('unable_to_determine_owner_shares_for_this_parcel', 'Unable to determine owner shares for this parcel.');
        return;
    }

    // Determine the effective owner key
    let effectiveOwnerKey = ownerKey;
    let targetSlot = null;

    if (effectiveOwnerKey) {
        // If ownerKey is provided, check if it exists in the proposal's stored owner data
        if (entry.owners[effectiveOwnerKey]) {
            // Found in stored data, try to find in current slots for display, but use stored data if not found
            targetSlot = ownerSlots.find(slot => slot.key === effectiveOwnerKey) || entry.owners[effectiveOwnerKey];
        } else if (entry.ownerOrder.includes(effectiveOwnerKey)) {
            // Key exists in ownerOrder but not in owners, use it anyway
            targetSlot = ownerSlots.find(slot => slot.key === effectiveOwnerKey) || { key: effectiveOwnerKey };
        } else {
            // Key not found in stored data, try to find in current slots
            targetSlot = ownerSlots.find(slot => slot.key === effectiveOwnerKey);
            if (targetSlot) {
                // Found in current slots, add to stored data
                entry.owners[effectiveOwnerKey] = {
                    key: targetSlot.key,
                    displayName: targetSlot.displayName || `Owner`,
                    shareText: targetSlot.shareText || '',
                    shareDetail: targetSlot.shareDetail || '',
                    type: targetSlot.type || 'unknown',
                    agentId: targetSlot.agentId || null
                };
            }
        }
    } else if (ownerSlots.length === 1) {
        // No ownerKey provided, but only one slot available
        targetSlot = ownerSlots[0];
        effectiveOwnerKey = targetSlot.key;
    } else if (entry.ownerOrder.length === 1) {
        // No ownerKey provided, but only one owner in stored data
        effectiveOwnerKey = entry.ownerOrder[0];
        targetSlot = entry.owners[effectiveOwnerKey] || ownerSlots.find(slot => slot.key === effectiveOwnerKey) || { key: effectiveOwnerKey };
    }

    if (!targetSlot || !effectiveOwnerKey) {
        showProposalAlertMessage('please_choose_which_owner_share_you_are_accepting_for', 'Please choose which owner share you are accepting for.');
        return;
    }

    // Validate ownership for agent-type slots
    if (targetSlot.type === 'agent' && targetSlot.agentId && targetSlot.agentId !== userAgent.id) {
        showProposalAlertMessage('you_can_only_accept_proposals_for_parcels_you_own', 'You can only accept proposals for parcels you own.');
        return;
    }

    // Check if this proposal is minted on-chain — if so, submit on-chain first
    const nftInfo = typeof getProposalNftInfo === 'function' ? getProposalNftInfo(proposal) : null;
    const isOnChain = nftInfo && window.ProposalChainBridge && typeof window.ProposalChainBridge.acceptProposal === 'function';

    if (isOnChain) {
        try {
            if (typeof updateStatus === 'function') {
                updateStatus('Submitting acceptance on chain...');
            }
            await window.ProposalChainBridge.acceptProposal({
                proposalId: nftInfo.tokenId,
                parcelId: normalizedParcelId,
                chainId: nftInfo.chain,
                contractAddress: nftInfo.contract
            });
        } catch (onchainErr) {
            console.warn('On-chain acceptance failed:', onchainErr);
            const friendlyMessage = parseOnChainErrorMessage(onchainErr);
            showProposalAlertMessage('on_chain_acceptance_failed', friendlyMessage);
            return;
        }
    }

    // On-chain succeeded (or not on-chain) — now record locally
    const result = acceptProposal(proposalId, parcelId, effectiveOwnerKey, {
        acceptedByAgentId: userAgent.id,
        acceptedByName: userAgent.name
    });

    if (!result) {
        return;
    }

    if (isOnChain && typeof updateStatus === 'function') {
        updateStatus('Acceptance recorded on chain.');
    }

    const ownerLabel = targetSlot.shareText
        ? `${targetSlot.displayName} (${targetSlot.shareText})`
        : targetSlot.displayName;

    const storedProposal = typeof proposalStorage !== 'undefined' && typeof proposalStorage.getProposal === 'function'
        ? proposalStorage.getProposal(proposalId)
        : null;
    const proposalIdForLog = storedProposal && storedProposal.proposalId !== undefined && storedProposal.proposalId !== null
        ? String(storedProposal.proposalId)
        : String(proposalId);
    const proposalIdAttr = storedProposal && storedProposal.proposalId !== undefined && storedProposal.proposalId !== null
        ? String(storedProposal.proposalId)
        : String(proposalId);
    const proposalLinkHtml = `<a href="#" data-proposal-id="${proposalIdAttr}" class="proposal-link proposal-link-clickable">${proposalIdForLog}</a>`;

    if (result.proposalExecuted) {
        if (typeof addUserActionToGameLog === 'function') {
            addUserActionToGameLog(`<a href="#" data-agent-id="${userAgent.id}" class="agent-link agent-link-clickable">${userAgent.name}</a> executed proposal ${proposalLinkHtml} after confirming acceptance for ${ownerLabel}.`);
        }
        if (!userAgent.proposalsExecuted) {
            userAgent.proposalsExecuted = [];
        }
        if (!userAgent.proposalsExecuted.includes(proposalId)) {
            userAgent.proposalsExecuted.push(proposalId);
            agentStorage.updateAgent(userAgent.id, { proposalsExecuted: userAgent.proposalsExecuted });
        }
    } else {
        if (typeof addUserActionToGameLog === 'function') {
            addUserActionToGameLog(`<a href="#" data-agent-id="${userAgent.id}" class="agent-link agent-link-clickable">${userAgent.name}</a> recorded acceptance from ${ownerLabel} for parcel ${result.parcelNumber || parcelId} (${proposalLinkHtml}).`);
        }
        if (!userAgent.proposalsAccepted) {
            userAgent.proposalsAccepted = [];
        }
        if (!userAgent.proposalsAccepted.includes(proposalId)) {
            userAgent.proposalsAccepted.push(proposalId);
            agentStorage.updateAgent(userAgent.id, { proposalsAccepted: userAgent.proposalsAccepted });
        }
    }

    // Preserve exact scroll/anchor position BEFORE any updates
    const panel = document.getElementById('proposal-details-panel');
    const panelBody = panel ? panel.querySelector('.panel-body') : null;
    const scrollTop = panelBody ? panelBody.scrollTop : 0;
    const anchorKey = effectiveOwnerKey || targetSlot.key || ownerKey || null;
    let anchorOffset = null;
    if (panelBody && anchorKey) {
        const ownerRow = panelBody.querySelector(`.owner-acceptance-row[data-owner-key="${anchorKey}"]`);
        if (ownerRow) {
            const bodyRect = panelBody.getBoundingClientRect();
            const rowRect = ownerRow.getBoundingClientRect();
            anchorOffset = rowRect.top - bodyRect.top;
        }
    }

    const updatedProposal = proposalStorage.getProposal(proposalId);
    if (updatedProposal) {
        const preserveState = {
            scrollTop,
            anchorKey,
            anchorOffset,
            parcelId: normalizedParcelId
        };

        if (typeof updateAgentDialogAfterAcceptance === 'function') {
            updateAgentDialogAfterAcceptance(proposalId);
        }

        refreshProposalOwnerAcceptanceUI(updatedProposal, parcelId);
        restoreProposalDetailsScroll(preserveState);

        if (typeof renderProposalListModal === 'function') {
            const modal = document.querySelector('.proposal-list-modal');
            if (modal && modal.style.display === 'block') {
                renderProposalListModal();
            }
        }

        if (typeof refreshProposalsLayer === 'function') {
            refreshProposalsLayer();
        }
    }
}

// Reject proposal function (for specific parcel)


// Ensure this runs after the main DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    // Proposals are always shown now, no checkbox event listener needed

    // Initialize the show proposals button count
    updateShowProposalsButton();
});

// Helper function to check if the active element is an editable field (input, textarea, etc.)
function isEditableElement(target) {
    if (!target) return false;
    const tagName = target.tagName;
    return target.isContentEditable
        || tagName === 'INPUT'
        || tagName === 'TEXTAREA'
        || tagName === 'SELECT'
        || tagName === 'OPTION';
}

// Keyboard shortcut handler for 'C' key to open Create Proposal modal



// Attach the 'C' key shortcut on DOM ready
if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', attachCreateProposalHotkey, { once: true });
    } else {
        attachCreateProposalHotkey();
    }
}

// Make objects globally available
window.proposalStorage = proposalStorage;
window.multiParcelSelection = multiParcelSelection;
window.getProposalOwnerAcceptanceState = getProposalOwnerAcceptanceState;
window.buildOwnerAcceptanceSectionHtml = buildOwnerAcceptanceSectionHtml;
window.handleUserRejectProposal = handleUserRejectProposal;
window.handleProposalParcelClick = handleProposalParcelClick;
window.openProposalBoostDialog = openProposalBoostDialog;
window.submitProposalBoost = submitProposalBoost;
window.closeProposalBoostDialog = closeProposalBoostDialog;

// Ensure count is correct once DOM is ready
if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', () => {
        if (typeof updateShowProposalsButton === 'function') {
            updateShowProposalsButton();
        }
    });
}

// --- Cross-module coordination ---
// When fresh parcel data arrive, restore whichever visual layers are currently active
window.addEventListener('parcelDataLoaded', async () => {
    // Background hydration finished a chunk — repaint the currently-selected proposal so any
    // newly-arrived ancestor parcels show up in highlights / lazy ancestor list. Coalesced.
    scheduleHighlightRefresh('parcels-loaded');

    // 1) Auto-apply executed and applied proposals to ensure parent parcels are removed and child parcels are clickable
    // This is critical: without this, parent parcels remain on the map and block child parcel clicks
    // applyProposal is idempotent - it checks roadProposal.status === 'applied' and returns early if already applied
    if (typeof proposalStorage !== 'undefined' && typeof ProposalManager !== 'undefined' && typeof ProposalManager.applyProposal === 'function') {
        try {
            const allProposals = proposalStorage.getAllProposals();
            const isAppliedLike = (p) => {
                const status = (p.status || '').toLowerCase();
                const roadStatus = (p.roadProposal && p.roadProposal.status) ? p.roadProposal.status.toLowerCase() : '';
                const structureStatus = (p.structureProposal && p.structureProposal.status) ? p.structureProposal.status.toLowerCase() : '';
                const buildingStatus = (p.buildingProposal && p.buildingProposal.status) ? p.buildingProposal.status.toLowerCase() : '';
                const reparcelStatus = (p.reparcellization && p.reparcellization.status) ? p.reparcellization.status.toLowerCase() : '';
                const decideLaterStatus = (p.decideLaterProposal && p.decideLaterProposal.status) ? p.decideLaterProposal.status.toLowerCase() : '';
                return status === 'executed' || status === 'applied'
                    || roadStatus === 'applied' || roadStatus === 'executed'
                    || structureStatus === 'applied' || structureStatus === 'executed'
                    || buildingStatus === 'applied' || buildingStatus === 'executed'
                    || reparcelStatus === 'applied' || reparcelStatus === 'executed'
                    || decideLaterStatus === 'applied' || decideLaterStatus === 'executed';
            };

            // Filter for both executed and applied proposals
            const proposalsToRestore = allProposals.filter(p => {
                const status = (p.status || '').toLowerCase();
                const roadStatus = (p.roadProposal && p.roadProposal.status) ? p.roadProposal.status.toLowerCase() : '';
                const structureStatus = (p.structureProposal && p.structureProposal.status) ? p.structureProposal.status.toLowerCase() : '';
                const buildingStatus = (p.buildingProposal && p.buildingProposal.status) ? p.buildingProposal.status.toLowerCase() : '';
                const reparcelStatus = (p.reparcellization && p.reparcellization.status) ? p.reparcellization.status.toLowerCase() : '';
                const decideLaterStatus = (p.decideLaterProposal && p.decideLaterProposal.status) ? p.decideLaterProposal.status.toLowerCase() : '';
                // Include executed proposals and applied proposals (for roads, buildings, structures, reparcellizations, etc.)
                return status === 'executed' || status === 'applied'
                    || roadStatus === 'applied' || roadStatus === 'executed'
                    || structureStatus === 'applied' || structureStatus === 'executed'
                    || buildingStatus === 'applied' || buildingStatus === 'executed'
                    || reparcelStatus === 'applied' || reparcelStatus === 'executed'
                    || decideLaterStatus === 'applied' || decideLaterStatus === 'executed';
            });

            // Drop ancestor proposals when any of their children are already applied/executed in the same restore set
            const proposalsById = new Map();
            proposalsToRestore.forEach(p => {
                const key = getProposalKey(p);
                if (!key) return;
                proposalsById.set(String(key), p);
            });

            const restoreCandidates = proposalsToRestore.filter(p => {
                const id = getProposalKey(p);
                if (!id) return false;
                const children = Array.isArray(p.childProposalIds)
                    ? p.childProposalIds.map(c => String(c)).filter(c => proposalsById.has(c))
                    : [];
                const hasAppliedChild = children.some(childId => {
                    const child = proposalsById.get(childId);
                    return child && isAppliedLike(child);
                });
                return !hasAppliedChild;
            });

            const toposortAppliedProposals = (list) => {
                const proposalMap = new Map();
                const indegree = new Map();
                const edges = new Map();

                list.forEach(p => {
                    const key = getProposalKey(p);
                    if (!key) return;
                    const id = String(key);
                    proposalMap.set(id, p);
                    if (!indegree.has(id)) indegree.set(id, 0);
                });

                // Skip ancestors that already have an applied/executed descendant in the same set
                const idSet = new Set(proposalMap.keys());
                const memoHasDesc = new Map();
                const hasAppliedDescendant = (id, visiting = new Set()) => {
                    if (!id || visiting.has(id)) return false;
                    if (memoHasDesc.has(id)) return memoHasDesc.get(id);
                    visiting.add(id);
                    const proposal = proposalMap.get(id);
                    const children = Array.isArray(proposal?.childProposalIds)
                        ? proposal.childProposalIds.map(c => String(c)).filter(c => idSet.has(c))
                        : [];
                    const result = children.some(childId => isAppliedLike(proposalMap.get(childId))
                        || hasAppliedDescendant(childId, visiting));
                    visiting.delete(id);
                    memoHasDesc.set(id, result);
                    return result;
                };

                Array.from(proposalMap.keys()).forEach(id => {
                    if (hasAppliedDescendant(id)) {
                        proposalMap.delete(id);
                        indegree.delete(id);
                    }
                });

                proposalMap.forEach((proposal, id) => {
                    const children = Array.isArray(proposal.childProposalIds)
                        ? proposal.childProposalIds.map(c => String(c)).filter(c => proposalMap.has(c))
                        : [];
                    edges.set(id, children);
                    children.forEach(child => indegree.set(child, (indegree.get(child) || 0) + 1));
                });

                const queue = Array.from(indegree.entries())
                    .filter(([, deg]) => deg === 0)
                    .map(([id]) => id);
                const orderedIds = [];

                while (queue.length) {
                    const id = queue.shift();
                    orderedIds.push(id);
                    (edges.get(id) || []).forEach(child => {
                        const next = (indegree.get(child) || 0) - 1;
                        indegree.set(child, next);
                        if (next === 0) queue.push(child);
                    });
                }

                const unresolved = Array.from(proposalMap.keys()).filter(id => !orderedIds.includes(id));
                const finalOrder = orderedIds.concat(unresolved);
                return finalOrder.map(id => proposalMap.get(id)).filter(Boolean);
            };

            const orderedProposals = toposortAppliedProposals(restoreCandidates);

            // Precondition: don't try to apply a proposal if its prerequisite parcels aren't loaded.
            // For road proposals especially, applying with missing parents emits a wall of
            // `Invalid inputs to calculateChildFeatures` / `expected N child parcels but generated 0`
            // errors. We'd rather skip silently and let the proposal apply later when parents arrive,
            // or stay unapplied until the user explicitly retries.
            const arePrerequisitesAvailable = (proposal) => {
                const parentIds = Array.isArray(proposal.parentParcelIds) ? proposal.parentParcelIds : [];
                if (parentIds.length === 0) return true; // nothing to check (e.g. Decide later with no parents)
                if (typeof parcelLayer === 'undefined' || !parcelLayer || typeof parcelLayer.eachLayer !== 'function') {
                    return false;
                }
                const found = new Set();
                parcelLayer.eachLayer(layer => {
                    const id = (typeof getParcelIdFromFeature === 'function')
                        ? getParcelIdFromFeature(layer && layer.feature)
                        : null;
                    if (id) found.add(String(id));
                });
                // All parents must be on the map. Partial availability still produces the noisy
                // `expected N but generated <N` failure, so require complete parent presence.
                return parentIds.every(id => found.has(String(id)));
            };

            let appliedCount = 0;
            let skippedForMissingPrereqs = 0;
            for (const proposal of orderedProposals) {
                if (!proposal || !proposal.proposalId) continue;
                if (!arePrerequisitesAvailable(proposal)) {
                    skippedForMissingPrereqs++;
                    continue;
                }
                try {
                    // This will remove parent parcels if they exist and add child parcels, ensuring everything is restored correctly
                    const result = await ProposalManager.applyProposal(proposal.proposalId);
                    if (result !== false) {
                        appliedCount++;
                    }
                } catch (error) {
                    console.warn('Failed to auto-apply proposal on parcel data load:', proposal.proposalId, error);
                }
            }
            if (skippedForMissingPrereqs > 0) {
                console.debug(`[parcelDataLoaded] Skipped ${skippedForMissingPrereqs} proposal(s) — parent parcels not (yet) on the map.`);
            }

            if (appliedCount > 0) {
                setTimeout(() => {
                    if (typeof parcelLayer !== 'undefined' && parcelLayer) {
                        parcelLayer.eachLayer(layer => {
                            if (!layer || !layer.feature || !layer.feature.properties) return;
                            const parcelId = getParcelIdFromFeature(layer.feature);
                            if (!parcelId) return;

                            const hasClickHandler = layer._events && layer._events.click && layer._events.click.length > 0;
                            if (!hasClickHandler && typeof window.onEachFeature === 'function') {
                                try {
                                    window.onEachFeature(layer.feature, layer);
                                } catch (error) {
                                    console.warn('Failed to attach handlers to parcel after proposal apply:', parcelId, error);
                                }
                            }

                            if (layer.options) {
                                layer.options.interactive = true;
                            }
                            if (typeof layer.setInteractive === 'function') {
                                layer.setInteractive(true);
                            }
                            if (typeof layer.bringToFront === 'function') {
                                layer.bringToFront();
                            }
                        });

                        if (typeof parcelLayer.bringToFront === 'function') {
                            parcelLayer.bringToFront();
                        }
                    }
                }, 100);
            }
        } catch (error) {
            console.warn('Error auto-applying executed proposals on parcel data load:', error);
        }
    }

    // 2) Proposals are always shown now, so always update proposal layer
    if (typeof updateProposalLayer === 'function') {
        updateProposalLayer();
    }

    // 3) If a single parcel is selected (parcel mode), restore its highlight
    if (window.selectedParcelId && typeof parcelLayer !== 'undefined' && parcelLayer) {
        const layer = parcelLayer.getLayers().find(l => {
            const candidateId = getParcelIdFromFeature(l?.feature);
            return candidateId && candidateId.toString() === window.selectedParcelId.toString();
        });
        if (layer) {
            const isTrackSelected = (layer?.feature?.properties?.isTrack === true) || Boolean(layer?._trackStyle);
            if (isTrackSelected) {
                const styleFn = typeof getParcelStyle === 'function' ? getParcelStyle : getParcelBaseStyle;
                const trackStyle = styleFn ? styleFn(window.selectedParcelId, layer, { isTrack: true }) : (trackStyle || {});
                layer.setStyle({ ...trackStyle, weight: 4 });
            } else if (typeof selectedParcelStyle !== 'undefined') {
                layer.setStyle(selectedParcelStyle);
            }
            layer.bringToFront();
        }
    }

    // 4) If block layer logic needs refresh it can listen separately; we keep focus on proposals/selection here
});

// Proposal Info hover overlay helpers

function clearProposalInfoHoverOverlay() {
    try {
        clearProposalHoverLayers();
    } catch (error) {
        console.warn('clearProposalInfoHoverOverlay failed', error);
    }
}



window.formatProposalOfferValue = formatProposalOfferValue;
window.handleProposalOfferInput = handleProposalOfferInput;
window.parseProposalOfferValue = parseProposalOfferValue;
