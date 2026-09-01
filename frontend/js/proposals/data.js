// proposals/data.js — proposal data layer: config tables (colors, goal/sort/filter maps),
// storage-key constants, and the stateful singletons proposalStorage (storage API) and
// multiParcelSelection (selection controller) + caches. Extracted from proposals.js; loaded before
// the proposals.js bootstrap so its load-time init can reference these.

const PROPOSALS_STORAGE_KEY = 'cadastre_proposals';

const PROPOSALS_NEXT_ID_KEY = 'cadastre_proposals_nextId';

// Where a READ-ONLY (secondary) tab parks work it is not allowed to write to the shared key above.
// Separate key on purpose: the primary tab's blob stays untouched, so nothing can be clobbered, and
// the work survives the reload that used to destroy it. Per-city already, since PersistentStorage
// opens one database per city.
const PROPOSALS_RECOVERY_KEY = 'cadastre_proposals_recovery';

const proposalMetadataFetchPromises = new Map();

const proposalListTranslationsHydrated = new Set();

const proposalAreaCache = new Map();

// proposalStorage is the durable authored log, not a snapshot of the current browser's replay.
// Persist only authored fields + applied/order state. Child ids, formation receipts, parent feature
// snapshots and demolition scans are disposable materialization output and are regenerated from
// cadastre on boot. Keeping them in the durable blob is how dead generations became prerequisites.
function proposalRecordForPersistence(record) {
    if (!record || typeof record !== 'object') return record;
    const root = typeof window !== 'undefined' ? window : globalThis;
    const depthApi = root && root.__formationDepth;
    let out = null;
    if (depthApi && typeof depthApi.stripDerivedRecordData === 'function') {
        out = depthApi.stripDerivedRecordData(record);
    } else {
        // data.js is also evaluated alone by storage tests. Keep the fallback deliberately small and
        // conservative, but never let a missing optional module make replay output durable.
        out = JSON.parse(JSON.stringify(record));
        const governmentPlan = out.tags?.governmentPlan === true
            || out.roadProposal?.definition?.kind === 'government_plan';
        delete out.childParcelIds;
        delete out.descendantParcelIds;
        delete out.parentFeatures;
        if (!governmentPlan) delete out.childFeatures;
        ['roadProposal', 'reparcellization', 'decideLaterProposal', 'buildingProposal', 'structureProposal']
            .forEach(key => {
                const sub = out[key];
                if (!sub || typeof sub !== 'object' || Array.isArray(sub)) return;
                delete sub.childParcelIds;
                delete sub.parentFeatures;
                delete sub.parentsToRemove;
                delete sub.formation;
                if (!(key === 'roadProposal' && governmentPlan)) delete sub.childFeatures;
                if (key === 'buildingProposal' || key === 'structureProposal') {
                    delete sub.demolishedBuildings;
                    delete sub.demolitionScanned;
                }
            });
    }

    const order = root && root.__planOrder;
    const flatten = values => {
        const declared = Array.isArray(values) ? values : [];
        if (order && typeof order.cadastreIdsFromDeclared === 'function') {
            return order.cadastreIdsFromDeclared(declared);
        }
        return Array.from(new Set(declared
            .map(value => String(value || '').split('#')[0])
            .filter(Boolean)));
    };
    const anchors = flatten(Array.isArray(out.cadastreParcelIds) && out.cadastreParcelIds.length
        ? out.cadastreParcelIds
        : out.parentParcelIds);
    if (anchors.length) {
        out.cadastreParcelIds = anchors.slice();
        out.parentParcelIds = anchors.slice();
        ['roadProposal', 'reparcellization', 'decideLaterProposal', 'buildingProposal', 'structureProposal']
            .forEach(key => {
                const sub = out[key];
                if (!sub || typeof sub !== 'object' || Array.isArray(sub)) return;
                sub.parentParcelIds = anchors.slice();
            });
        if (out.reparcellization && Array.isArray(out.reparcellization.parcelIds)) {
            out.reparcellization.parcelIds = anchors.slice();
        }
    }
    return out;
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
        this._normalizeProposalIdentity(proposal);
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
            lifecycleStatus: raw.lifecycleStatus || raw.status || 'Active',
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
                const storedNext = parseInt(PersistentStorage.getItem(PROPOSALS_NEXT_ID_KEY), 10);
                this.nextProposalId = Number.isFinite(storedNext) && storedNext >= 0 ? storedNext : 0;
                return;
            }

            const parsed = JSON.parse(raw);
            this.proposals.clear();
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
            const storedNext = parseInt(PersistentStorage.getItem(PROPOSALS_NEXT_ID_KEY), 10);
            this.nextProposalId = Number.isFinite(storedNext) && storedNext >= 0 ? storedNext : 0;
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
            PersistentStorage.setItem(PROPOSALS_STORAGE_KEY, JSON.stringify(serialisable));
            // Persist the next proposal id counter
            PersistentStorage.setItem(PROPOSALS_NEXT_ID_KEY, String(this.nextProposalId));
        } catch (error) {
            console.error('proposalStorage.save: Failed to persist proposals', error);
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
            PersistentStorage.setItem(PROPOSALS_RECOVERY_KEY, JSON.stringify({
                savedAt: new Date().toISOString(),
                proposals: serialisable
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
            const proposals = Array.isArray(parsed && parsed.proposals) ? parsed.proposals : null;
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
        // A derived parcel also shows proposals declared on its one cadastral root. Flat records
        // keep the authoritative parent and child lists at the proposal root; sub-record mirrors
        // never participate in lookup.
        const matchIds = new Set([id]);
        const hashAt = id.indexOf('#');
        if (hashAt > 0) matchIds.add(id.slice(0, hashAt));
        const matchesId = value => {
            const normalized = normalizeParcelId(value);
            return normalized !== null && matchIds.has(normalized);
        };
        const results = [];
        for (const proposal of this.proposals.values()) {
            const parentIds = Array.isArray(proposal.parentParcelIds) ? proposal.parentParcelIds : [];
            const parcelMatch = parentIds.some(matchesId);

            const childIds = Array.isArray(proposal.childParcelIds) ? proposal.childParcelIds : [];
            const childMatch = childIds.some(matchesId);

            if (parcelMatch || childMatch) {
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
        this.save();
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
        // Ancestors-only contract: proposals never persist parcel geometries locally — they
        // carry ancestor IDs + the rule (road definition, structure definition, building rule).
        // Descendants are always re-derived deterministically from (ancestors, rule) on apply.
        // Inbound payloads from server / chain / share links may still include these blobs;
        // strip them at the storage boundary so they cannot leak into local proposal records.
        //
        // EXCEPTION: government road-plan proposals. Their definition holds no geometry
        // (kind: 'government_plan', no polygon/points) and childParcelIds is empty, so the
        // descendant road geometry cannot be re-derived — it lives solely in childFeatures.
        // Preserve it, otherwise apply reads back an empty child set and returns false.
        const isGovernmentPlan = proposal?.tags?.governmentPlan === true
            || proposal?.roadProposal?.definition?.kind === 'government_plan';
        const preservedChildFeatures = isGovernmentPlan
            ? (Array.isArray(proposal.childFeatures) && proposal.childFeatures.length
                ? proposal.childFeatures
                : (Array.isArray(proposal.roadProposal?.childFeatures) ? proposal.roadProposal.childFeatures : null))
            : null;

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
        if (preservedChildFeatures && preservedChildFeatures.length) {
            proposal.childFeatures = preservedChildFeatures;
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
        // Canonical current-record shape. Missing application state means locally unapplied;
        // legacy interpretation belongs exclusively to migrate-tessellation.js.
        normalizeProposalStatusAxes(proposal);
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
                proposal.goal = (kind === 'park' || kind === 'square' || kind === 'lake' || kind === 'station') ? kind : 'square';
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
                ancestorKey: parentIds.join('|'),
                parameters: {}
            };
            if (!proposal.geometry) proposal.geometry = {};
            if (proposal.buildingGeometry && !proposal.geometry.buildings) {
                proposal.geometry.buildings = [deepClone(proposal.buildingGeometry)];
            }
        }

        // Normalize structure proposals (parks/squares/lakes/stations)
        if (proposal.structureProposal) {
            const sp = { ...proposal.structureProposal };
            sp.kind = (sp.kind === 'park' || sp.kind === 'square' || sp.kind === 'lake' || sp.kind === 'station') ? sp.kind : 'square';
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
        const roadDef = proposal.roadProposal?.definition || null;
        if (roadDef) {
            parts.push(`roadDef:${serialiseRoadDefinition(roadDef)}`);
        }
        if (proposal.roadProposal?.mode) {
            parts.push(`roadMode:${proposal.roadProposal.mode}`);
        }

        // Building proposals
        if (proposal.buildingProposal) {
            parts.push(`buildingParents:${normalizeParcelIdList(proposal.buildingProposal.parentParcelIds || parentIds).join(',')}`);
            if (proposal.buildingProposal.parameters) {
                // stableStringify (shared-utils.js) sorts keys at every level and keeps nested keys.
                // The old JSON.stringify(params, sortedKeys) used an array replacer, which drops any
                // nested key not in the top-level list — so two building proposals differing only in
                // a nested param hashed identically and one silently overwrote the other. For today's
                // flat params it yields the identical string, so existing ids are unchanged.
                try { parts.push(`buildingParams:${stableStringify(proposal.buildingProposal.parameters)}`); } catch (_) { }
            }
        }
        if (proposal.buildingGeometry) {
            parts.push(`buildingGeom:${serialiseGeometry(proposal.buildingGeometry)}`);
        }

        // Structure (park/square/lake/station)
        if (proposal.structureProposal) {
            const sp = proposal.structureProposal;
            parts.push(`structureKind:${sp.kind || ''}`);
            parts.push(`structureParents:${normalizeParcelIdList(sp.parentParcelIds || parentIds).join(',')}`);
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

const proposalFeatureCache = new Map();

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
        // Generated parcel ids name the CURRENT materialization only. If one is not in the live
        // layer, it is gone; recovering yesterday's copy from a grid/persistence cache would turn
        // disposable proposal output back into ground. That is how an unapplied park could appear
        // selectable again and become the source geometry of the next park.
        const isGeneratedId = (typeof isSyntheticParcelId === 'function' && isSyntheticParcelId(targetId))
            || (typeof ProposalManager !== 'undefined'
                && typeof ProposalManager.isSyntheticParcelId === 'function'
                && ProposalManager.isSyntheticParcelId(targetId));

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

            // The index is invalidated on a COUNT, and a count is not a fingerprint: deriving a
            // parcel's pieces removes layers and adds layers, so the total comes back identical
            // while the ids under it have changed completely. The index then answers for a map that
            // no longer exists — in both directions. A parcel plainly on screen cannot be found, so
            // a caller resolving a selection through it concludes nothing is selected (block
            // detection said "Select a parcel first" with a parcel selected in front of you); and a
            // hit can hand back a layer the map has already taken off.
            //
            // So a hit is verified against the live layer group, and a miss is worth one rebuild
            // before it is believed. Both are the slow path — the common case is a hit on a layer
            // that is still there, which costs one hasLayer call.
            const stillOnMap = layer => {
                if (!layer) return false;
                if (typeof parcelLayer.hasLayer !== 'function') return true;
                try { return parcelLayer.hasLayer(layer); } catch (_) { return true; }
            };
            const rebuildIndex = () => {
                this.parcelIdIndex.clear();
                parcelLayer.eachLayer(layer => {
                    const layerId = getParcelIdFromFeature(layer.feature);
                    if (layerId !== undefined && layerId !== null) {
                        this.parcelIdIndex.set(layerId.toString(), layer);
                    }
                });
                this.parcelIdIndexSize = typeof parcelLayer.getLayers === 'function'
                    ? parcelLayer.getLayers().length
                    : this.parcelIdIndex.size;
            };

            foundParcel = this.parcelIdIndex.get(targetId) || null;
            if (!indexStale && !stillOnMap(foundParcel)) {
                rebuildIndex();
                foundParcel = this.parcelIdIndex.get(targetId) || null;
            }
        } else {
            console.warn('findParcelById: parcelLayer not available (initialization pending)');
        }

        // If not found in parcelLayer, try to recover from cache
        if (!foundParcel && !isGeneratedId && typeof parcelCache !== 'undefined') {
            foundParcel = this.recoverParcelFromCache(targetId);
            if (foundParcel) {
                // Sync cache into the index for future lookups
                this.parcelIdIndex.set(targetId, foundParcel);
                this.parcelIdIndexSize = this.parcelIdIndex.size;
            }
        }

        // Final fallback: try PersistentStorage
        if (!foundParcel && !isGeneratedId) {
            foundParcel = this.recoverParcelFromPersistentStorage(targetId);
            if (foundParcel) {
                // Sync cache into the index for future lookups
                this.parcelIdIndex.set(targetId, foundParcel);
                this.parcelIdIndexSize = this.parcelIdIndex.size;
            }
        }

        if (!foundParcel) {
            // Only escalate when there is no known way to recover the parcel.
            const hasFetchers = typeof CadastralGroundService !== 'undefined'
                && CadastralGroundService
                && typeof CadastralGroundService.ensureIds === 'function';
            const isSynth = isGeneratedId;
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
        const id = parcelId === undefined || parcelId === null ? '' : String(parcelId);
        const isGeneratedId = (typeof isSyntheticParcelId === 'function' && isSyntheticParcelId(id))
            || (typeof ProposalManager !== 'undefined'
                && typeof ProposalManager.isSyntheticParcelId === 'function'
                && ProposalManager.isSyntheticParcelId(id));
        if (isGeneratedId) return null;
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
        const id = parcelId === undefined || parcelId === null ? '' : String(parcelId);
        const isGeneratedId = (typeof isSyntheticParcelId === 'function' && isSyntheticParcelId(id))
            || (typeof ProposalManager !== 'undefined'
                && typeof ProposalManager.isSyntheticParcelId === 'function'
                && ProposalManager.isSyntheticParcelId(id));
        if (isGeneratedId) return null;
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
