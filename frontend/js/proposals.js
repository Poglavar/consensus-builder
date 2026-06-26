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



// Save the captured data URL on the local proposal so it can be rendered as a thumbnail
// without going through the backend. Used during proposal creation and click-to-generate.

// Capture (or accept) a thumbnail data URL for the given proposal and store it locally.
// By default the data URL is kept in localStorage only — uploads to the backend happen later
// (currently only on mint). Pass { uploadToServer: true } to force an upload.

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




// Rebuild a tile-stitched screenshot from the persisted proposal data only — no live selection required.

// Track which proposals have an in-flight regeneration so repeat clicks no-op.
const _proposalScreenshotInFlight = new Set();


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








const DEFAULT_CORRIDOR_WIDTHS = {
    road: 7.5,
    track: 3.0
};



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

// Close proposal dialog

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
