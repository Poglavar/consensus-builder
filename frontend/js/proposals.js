/*
    Proposals functionality for the cadastre application.
    This file contains the functionality for creating and managing proposals
    including persistence helpers, map highlighting, UI interactions, and
    dependency management between proposals.
*/

const PROPOSALS_STORAGE_KEY = 'cadastre_proposals';
const PROPOSALS_NEXT_ID_KEY = 'cadastre_proposals_nextId';
const PROPOSAL_HASH_PREFIX = 'prop_';

function normalizeParcelId(value) {
    if (value === undefined || value === null) return null;
    const str = value.toString().trim();
    return str.length > 0 ? str : null;
}

function normalizeParcelIdList(list) {
    if (!Array.isArray(list)) return [];
    const unique = new Set();
    list.forEach(value => {
        const normalized = normalizeParcelId(value);
        if (normalized) {
            unique.add(normalized);
        }
    });
    return Array.from(unique).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

function normalizeFeature(feature) {
    if (!feature || typeof feature !== 'object') return feature;
    if (feature.properties && 'CESTICA_ID' in feature.properties) {
        const normalizedId = normalizeParcelId(feature.properties.CESTICA_ID);
        if (normalizedId) {
            feature.properties.CESTICA_ID = normalizedId;
        }
    }
    return feature;
}

function normalizeOwnerAcceptances(ownerAcceptances = {}) {
    const normalized = {};
    if (!ownerAcceptances || typeof ownerAcceptances !== 'object') {
        return normalized;
    }
    Object.entries(ownerAcceptances).forEach(([parcelId, entry]) => {
        if (parcelId === undefined || parcelId === null) {
            return;
        }
        const normalizedParcelId = parcelId.toString();
        const owners = entry && typeof entry.owners === 'object' ? entry.owners : {};
        const ownerOrder = Array.isArray(entry && entry.ownerOrder)
            ? entry.ownerOrder.filter(key => typeof key === 'string' && key.length > 0)
            : Object.keys(owners);
        const acceptedOwnerKeys = Array.isArray(entry && entry.acceptedOwnerKeys)
            ? Array.from(new Set(entry.acceptedOwnerKeys.map(key => key && key.toString()).filter(Boolean)))
            : [];
        const acceptedBy = entry && typeof entry.acceptedBy === 'object' ? entry.acceptedBy : {};

        // Ensure ownerOrder also contains any accepted keys
        acceptedOwnerKeys.forEach(key => {
            if (!ownerOrder.includes(key)) {
                ownerOrder.push(key);
            }
        });

        normalized[normalizedParcelId] = {
            owners,
            ownerOrder,
            acceptedOwnerKeys,
            acceptedBy
        };
    });
    return normalized;
}

function getOwnerSlotsForParcel(parcelId) {
    if (typeof getParcelOwnerSlots === 'function') {
        try {
            const slots = getParcelOwnerSlots(parcelId);
            if (Array.isArray(slots) && slots.length > 0) {
                return slots;
            }
        } catch (error) {
            console.warn('getOwnerSlotsForParcel: failed to read slots from parcels module', error);
        }
    }
    const normalizedParcelId = parcelId ? parcelId.toString() : 'parcel';
    return [{
        key: `parcel:${normalizedParcelId}:owner`,
        displayName: 'Unknown owner',
        shareText: '1',
        shareDetail: '',
        type: 'unknown',
        agentId: null,
        placeholder: true
    }];
}

function setParcelInfoPanelTitle(titleText) {
    const panel = document.getElementById('parcel-info-panel');
    if (!panel) return;
    const titleEl = panel.querySelector('h3');
    if (!titleEl) return;
    titleEl.textContent = titleText;
}

function ensureOwnerAcceptanceEntry(proposal, parcelId, ownerSlots = [], options = {}) {
    if (!proposal) {
        return null;
    }
    if (!proposal.ownerAcceptances || typeof proposal.ownerAcceptances !== 'object') {
        proposal.ownerAcceptances = {};
    }

    const normalizedParcelId = parcelId ? parcelId.toString() : null;
    if (!normalizedParcelId) {
        return null;
    }

    if (!proposal.ownerAcceptances[normalizedParcelId]) {
        proposal.ownerAcceptances[normalizedParcelId] = {
            owners: {},
            ownerOrder: [],
            acceptedOwnerKeys: [],
            acceptedBy: {}
        };
    }

    const entry = proposal.ownerAcceptances[normalizedParcelId];
    const ownerOrderSet = new Set(entry.ownerOrder || []);

    const ownerSlotsArray = Array.isArray(ownerSlots) ? ownerSlots : [];
    ownerSlotsArray.forEach(slot => {
        if (!slot || !slot.key) {
            return;
        }
        const normalizedOwner = {
            key: slot.key,
            displayName: slot.displayName || slot.name || `Owner ${ownerOrderSet.size + 1}`,
            shareText: slot.shareText || '',
            shareDetail: slot.shareDetail || '',
            type: slot.type || 'unknown',
            agentId: slot.agentId || null,
            placeholder: !!slot.placeholder
        };
        entry.owners[slot.key] = {
            ...(entry.owners[slot.key] || {}),
            ...normalizedOwner
        };
        if (!ownerOrderSet.has(slot.key)) {
            entry.ownerOrder.push(slot.key);
            ownerOrderSet.add(slot.key);
        }
    });

    const hasNonPlaceholderSlots = ownerSlotsArray.some(slot => slot && !slot.placeholder);
    if (hasNonPlaceholderSlots) {
        const placeholderKeys = Object.keys(entry.owners || {}).filter(key => {
            const owner = entry.owners[key];
            if (!owner) return false;
            if (owner.placeholder) return true;
            const display = (owner.displayName || '').toLowerCase();
            const share = (owner.shareText || '').trim();
            const looksLegacyPlaceholder = owner.type === 'unknown'
                && !owner.agentId
                && (!display || display.includes('parcel owner') || display.includes('unknown owner'))
                && (!share || share === '100%' || share === '1');
            return looksLegacyPlaceholder;
        });
        if (placeholderKeys.length > 0) {
            placeholderKeys.forEach(key => {
                delete entry.owners[key];
                if (entry.acceptedBy && entry.acceptedBy[key]) {
                    delete entry.acceptedBy[key];
                }
            });
            entry.ownerOrder = (entry.ownerOrder || []).filter(key => !placeholderKeys.includes(key));
            entry.acceptedOwnerKeys = (entry.acceptedOwnerKeys || []).filter(key => !placeholderKeys.includes(key));
            placeholderKeys.forEach(key => ownerOrderSet.delete(key));
        }
    }

    if (!Array.isArray(entry.acceptedOwnerKeys)) {
        entry.acceptedOwnerKeys = [];
    }
    entry.acceptedOwnerKeys = Array.from(new Set(entry.acceptedOwnerKeys.map(key => key && key.toString()).filter(Boolean)));
    entry.acceptedOwnerKeys.forEach(key => {
        if (!ownerOrderSet.has(key)) {
            entry.ownerOrder.push(key);
            ownerOrderSet.add(key);
        }
    });

    if (!entry.acceptedBy || typeof entry.acceptedBy !== 'object') {
        entry.acceptedBy = {};
    }

    const shouldSync = options.syncWithParcelAcceptance !== false;
    const parcelAccepted = shouldSync
        ? Array.isArray(proposal.acceptedParcelIds) && proposal.acceptedParcelIds.includes(normalizedParcelId)
        : false;

    if (parcelAccepted && entry.acceptedOwnerKeys.length === 0 && entry.ownerOrder.length > 0) {
        entry.ownerOrder.forEach(key => {
            if (!entry.acceptedOwnerKeys.includes(key)) {
                entry.acceptedOwnerKeys.push(key);
                if (!entry.acceptedBy[key]) {
                    entry.acceptedBy[key] = {
                        agentId: null,
                        username: null,
                        acceptedAt: proposal.executedAt || proposal.updatedAt || new Date().toISOString()
                    };
                }
            }
        });
    }

    proposal.ownerAcceptances[normalizedParcelId] = entry;
    return entry;
}

function getProposalOwnerAcceptanceState(proposal, parcelId, options = {}) {
    if (!proposal) {
        return { entries: [] };
    }
    const ownerSlots = getOwnerSlotsForParcel(parcelId);
    const entry = ensureOwnerAcceptanceEntry(proposal, parcelId, ownerSlots);
    if (!entry) {
        return { entries: [] };
    }

    const acceptedKeys = new Set(entry.acceptedOwnerKeys || []);
    const currentUser = typeof getCurrentUserAgent === 'function' ? getCurrentUserAgent() : null;
    const entries = (entry.ownerOrder || []).map(ownerKey => {
        const slot = entry.owners[ownerKey] || ownerSlots.find(s => s.key === ownerKey) || { key: ownerKey };
        const acceptanceMeta = entry.acceptedBy[ownerKey] || {};
        const isAccepted = acceptedKeys.has(ownerKey);
        const slotType = slot.type || 'unknown';
        const slotAgentId = slot.agentId || null;
        let canAccept = !isAccepted && !!currentUser;
        if (slotType === 'agent' && slotAgentId && (!currentUser || slotAgentId !== currentUser.id)) {
            canAccept = false;
        }
        if (!currentUser && slotType !== 'oss') {
            canAccept = false;
        }
        let canUndo = false;
        if (isAccepted && currentUser && acceptanceMeta.agentId === currentUser.id) {
            canUndo = true;
            // If proposal is executed, only allow undo if there are no descendants
            const proposalStatus = (proposal.status || '').toLowerCase();
            if (proposalStatus === 'executed') {
                if (typeof ProposalManager !== 'undefined' && typeof ProposalManager._getProposalDescendants === 'function') {
                    const descendants = ProposalManager._getProposalDescendants(proposal.proposalHash);
                    if (descendants && descendants.length > 0) {
                        canUndo = false;
                    }
                }
            }
        }

        return {
            key: ownerKey,
            displayName: slot.displayName || `Owner ${ownerKey}`,
            shareText: slot.shareText || '',
            shareDetail: slot.shareDetail || '',
            accepted: isAccepted,
            acceptedAt: acceptanceMeta.acceptedAt || null,
            acceptedByName: acceptanceMeta.username || '',
            acceptedByAgentId: acceptanceMeta.agentId || null,
            slotType,
            agentId: slotAgentId,
            canAccept,
            canUndo
        };
    });

    return {
        entries,
        ownerEntry: entry
    };
}

function buildOwnerAcceptanceSectionHtml(proposal, parcelId, options = {}) {
    const proposalHash = proposal && proposal.proposalHash ? proposal.proposalHash : '';
    const acceptanceState = getProposalOwnerAcceptanceState(proposal, parcelId, options);
    const entries = acceptanceState.entries || [];
    if (!entries.length) {
        return '';
    }
    const compact = options.compact ? 'owner-acceptance-list compact' : 'owner-acceptance-list';
    const skipParcelPanelFocus = options && options.skipParcelPanelFocus === true;

    const rowsHtml = entries.map(entry => {
        const safeName = typeof escapeHtml === 'function' ? escapeHtml(entry.displayName || '') : (entry.displayName || 'Owner');
        const safeShare = entry.shareText ? (typeof escapeHtml === 'function' ? escapeHtml(entry.shareText) : entry.shareText) : '';
        const shareTitle = entry.shareDetail ? (typeof escapeHtml === 'function' ? escapeHtml(entry.shareDetail) : entry.shareDetail) : '';
        const shareHtml = safeShare ? `<span class="owner-share" style="color:#666; font-size:0.85em;"${shareTitle ? ` title="${shareTitle}"` : ''}>${safeShare}</span>` : '';

        let buttonsHtml = '';
        if (entry.accepted && entry.canUndo) {
            const rejectCall = skipParcelPanelFocus
                ? `rejectProposalFromParcelInfo('${proposalHash}','${parcelId}','${entry.key}',{skipParcelPanelFocus:true})`
                : `rejectProposalFromParcelInfo('${proposalHash}','${parcelId}','${entry.key}')`;
            buttonsHtml = `
                <button class="btn btn-sm btn-outline-danger" onclick="(function(e){e.stopPropagation();e.preventDefault();${rejectCall};return false;})(event)" style="font-size: 11px; padding: 2px 6px; min-width: 60px;">
                    Undo
                </button>`;
        } else if (!entry.accepted && entry.canAccept) {
            const acceptCall = skipParcelPanelFocus
                ? `acceptProposalFromParcelInfo('${proposalHash}','${parcelId}','${entry.key}',{skipParcelPanelFocus:true})`
                : `acceptProposalFromParcelInfo('${proposalHash}','${parcelId}','${entry.key}')`;
            buttonsHtml = `
                <button class="btn btn-sm btn-success" onclick="(function(e){e.stopPropagation();e.preventDefault();${acceptCall};return false;})(event)" style="font-size: 11px; padding: 2px 6px; min-width: 60px;">
                    Accept
                </button>`;
        }

        return `
            <div class="owner-acceptance-row" onclick="event.stopPropagation(); event.preventDefault(); return false;" style="display:grid; grid-template-columns: 1fr auto auto; align-items:center; gap:8px; padding:4px 0; border-bottom:1px solid rgba(0,0,0,0.05);">
                <div class="owner-identity" onclick="event.stopPropagation(); event.preventDefault(); return false;" style="font-size: 13px; font-weight:500;">
                    ${safeName}
                </div>
                <div class="owner-share" onclick="event.stopPropagation(); event.preventDefault(); return false;" style="font-size: 13px; color:#666; text-align:right;">
                    ${shareHtml || '-'}
                </div>
                <div class="owner-actions" onclick="event.stopPropagation(); event.preventDefault(); return false;" style="text-align:right;">
                    ${buttonsHtml}
                </div>
            </div>`;
    }).join('');

    return `<div class="${compact}" style="border:1px solid #eee; border-radius:6px; padding:4px 8px; width: 100%; box-sizing: border-box;">${rowsHtml}</div>`;
}

function buildProposalOwnerAcceptanceSummary(proposal) {
    const summary = {
        entries: [],
        totalOwners: 0,
        acceptedOwners: 0
    };
    if (!proposal || !Array.isArray(proposal.parcelIds) || typeof getProposalOwnerAcceptanceState !== 'function') {
        return summary;
    }

    const seen = new Set();
    proposal.parcelIds.forEach(parcelId => {
        const normalizedParcelId = parcelId !== undefined && parcelId !== null
            ? parcelId.toString()
            : '';
        if (!normalizedParcelId) {
            return;
        }
        try {
            const state = getProposalOwnerAcceptanceState(proposal, normalizedParcelId, { syncWithParcelAcceptance: false });
            const entries = state && Array.isArray(state.entries) ? state.entries : [];
            entries.forEach((entry, index) => {
                if (!entry) return;
                const entryKey = entry.key || `${normalizedParcelId}_${index}`;
                const uniqueKey = `${normalizedParcelId}_${entryKey}`;
                if (seen.has(uniqueKey)) {
                    return;
                }
                seen.add(uniqueKey);
                const aggregated = {
                    key: entryKey,
                    parcelId: normalizedParcelId,
                    displayName: entry.displayName || `Owner ${index + 1}`,
                    shareText: entry.shareText || '',
                    accepted: !!entry.accepted,
                    acceptedByName: entry.acceptedByName || '',
                    acceptanceMeta: entry
                };
                summary.entries.push(aggregated);
                if (aggregated.accepted) {
                    summary.acceptedOwners += 1;
                }
            });
        } catch (error) {
            console.warn('buildProposalOwnerAcceptanceSummary: failed to gather owners', error);
        }
    });

    summary.totalOwners = summary.entries.length;
    return summary;
}

function serialiseRoadCoordinates(coords = []) {
    return coords
        .map(pair => {
            if (!Array.isArray(pair) || pair.length < 2) return '0,0';
            const [lng, lat] = pair;
            const safeLng = Number.isFinite(lng) ? lng.toFixed(6) : '0.000000';
            const safeLat = Number.isFinite(lat) ? lat.toFixed(6) : '0.000000';
            return `${safeLng},${safeLat}`;
        })
        .join(';');
}

function serialiseGeometry(geometry) {
    if (!geometry) return '';
    try {
        return JSON.stringify(geometry);
    } catch (_) {
        return '';
    }
}

function serialiseRoadDefinition(definition) {
    if (!definition || typeof definition !== 'object') return '';

    const width = Number.isFinite(definition.width)
        ? definition.width.toFixed(2)
        : (definition.width !== undefined && definition.width !== null
            ? definition.width.toString()
            : '');

    const points = Array.isArray(definition.points)
        ? definition.points.map(point => {
            if (!point) return '0.000000,0.000000';
            const lat = Number.isFinite(point.lat) ? point.lat.toFixed(6) : '0.000000';
            const lng = Number.isFinite(point.lng) ? point.lng.toFixed(6) : '0.000000';
            return `${lng},${lat}`;
        }).join(';')
        : '';

    return `w=${width}|pts=${points}`;
}

const proposalStorage = {
    proposals: new Map(),
    nextProposalId: 0,
    _roadAssetSuffixes: {
        parents: 'roadParents',
        children: 'roadChildren',
        metadata: 'roadParentsKeep'
    },

    load() {
        if (typeof PersistentStorage === 'undefined') return;
        try {
            const raw = PersistentStorage.getItem(PROPOSALS_STORAGE_KEY);
            if (!raw) {
                this.proposals.clear();
                // Initialize next id from persisted key or 0
                const storedNext = parseInt(PersistentStorage.getItem(PROPOSALS_NEXT_ID_KEY), 10);
                this.nextProposalId = Number.isFinite(storedNext) && storedNext >= 0 ? storedNext : 0;
                return;
            }
            const parsed = JSON.parse(raw);
            this.proposals.clear();
            if (!Array.isArray(parsed)) return;

            parsed.forEach(entry => {
                if (!entry) return;
                const hash = entry.proposalHash || entry.hash || null;
                const normalized = this._normalizeProposal({ ...entry }, { existingHash: hash });
                const seed = this._buildHashSeed(normalized);
                if (!normalized.proposalHash) {
                    normalized.proposalHash = this._ensureUniqueHash(this._hashSeed(seed));
                }
                // Ensure timestamps exist
                normalized.createdAt = normalized.createdAt || new Date().toISOString();
                normalized.updatedAt = normalized.updatedAt || normalized.createdAt;
                // Ensure proposal_id is numeric if present
                if (normalized.proposal_id !== undefined && normalized.proposal_id !== null) {
                    const pid = parseInt(normalized.proposal_id, 10);
                    normalized.proposal_id = Number.isFinite(pid) ? pid : undefined;
                }
                if (normalized && normalized.roadProposal && normalized.roadProposal.__extractedRoadAssets) {
                    this.persistRoadAssets(normalized.proposalHash, normalized.roadProposal.__extractedRoadAssets);
                    delete normalized.roadProposal.__extractedRoadAssets;
                }
                this.proposals.set(normalized.proposalHash, normalized);
            });

            // Determine nextProposalId: prefer persisted value, else max(existing)+1
            const storedNext = parseInt(PersistentStorage.getItem(PROPOSALS_NEXT_ID_KEY), 10);
            if (Number.isFinite(storedNext) && storedNext >= 0) {
                this.nextProposalId = storedNext;
            } else {
                let maxId = -1;
                for (const p of this.proposals.values()) {
                    if (p.proposal_id !== undefined && p.proposal_id !== null) {
                        const pid = parseInt(p.proposal_id, 10);
                        if (Number.isFinite(pid) && pid > maxId) maxId = pid;
                    }
                }
                this.nextProposalId = maxId + 1;
            }
        } catch (error) {
            console.error('proposalStorage.load: Failed to parse proposals from storage', error);
            this.proposals.clear();
            const storedNext = parseInt(PersistentStorage.getItem(PROPOSALS_NEXT_ID_KEY), 10);
            this.nextProposalId = Number.isFinite(storedNext) && storedNext >= 0 ? storedNext : 0;
        }
    },

    save() {
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

    _roadAssetKey(proposalHash, suffix) {
        if (!proposalHash || !suffix) return null;
        return `proposal_${proposalHash}_${suffix}`;
    },

    persistRoadAssets(proposalHash, assets = {}) {
        if (!proposalHash || typeof PersistentStorage === 'undefined') return;
        const hash = String(proposalHash);
        const { parentFeatures, childFeatures, parentsKeepDetails } = assets || {};

        try {
            const parentKey = this._roadAssetKey(hash, this._roadAssetSuffixes.parents);
            if (parentKey) {
                if (Array.isArray(parentFeatures) && parentFeatures.length > 0) {
                    const serialisedParents = JSON.stringify(parentFeatures);
                    PersistentStorage.setItem(parentKey, serialisedParents);
                } else {
                    PersistentStorage.removeItem(parentKey);
                }
            }
        } catch (error) {
            console.warn('persistRoadAssets: failed to persist parent features', error);
        }

        try {
            const childKey = this._roadAssetKey(hash, this._roadAssetSuffixes.children);
            if (childKey) {
                if (Array.isArray(childFeatures) && childFeatures.length > 0) {
                    const serialisedChildren = JSON.stringify(childFeatures);
                    PersistentStorage.setItem(childKey, serialisedChildren);
                } else {
                    PersistentStorage.removeItem(childKey);
                }
            }
        } catch (error) {
            console.warn('persistRoadAssets: failed to persist child features', error);
        }

        try {
            const metaKey = this._roadAssetKey(hash, this._roadAssetSuffixes.metadata);
            if (!metaKey) return;
            if (parentsKeepDetails && typeof parentsKeepDetails === 'object' && Object.keys(parentsKeepDetails).length > 0) {
                PersistentStorage.setItem(metaKey, JSON.stringify(parentsKeepDetails));
            } else {
                PersistentStorage.removeItem(metaKey);
            }
        } catch (error) {
            console.warn('persistRoadAssets: failed to persist keep details', error);
        }
    },

    loadRoadAssets(proposalHash, options = {}) {
        const includeParents = options.includeParents !== false;
        const includeChildren = options.includeChildren !== false;
        const includeKeepDetails = options.includeKeepDetails !== false;
        const result = {
            parentFeatures: [],
            childFeatures: [],
            parentsKeepDetails: null
        };

        if (!proposalHash || typeof PersistentStorage === 'undefined') {
            return result;
        }

        const hash = String(proposalHash);

        if (includeParents) {
            try {
                const parentKey = this._roadAssetKey(hash, this._roadAssetSuffixes.parents);
                const rawParents = parentKey ? PersistentStorage.getItem(parentKey) : null;
                if (rawParents) {
                    result.parentFeatures = JSON.parse(rawParents);
                }
            } catch (error) {
                console.warn('loadRoadAssets: failed to load parent features', error);
            }
        }

        if (includeChildren) {
            try {
                const childKey = this._roadAssetKey(hash, this._roadAssetSuffixes.children);
                const rawChildren = childKey ? PersistentStorage.getItem(childKey) : null;
                if (rawChildren) {
                    result.childFeatures = JSON.parse(rawChildren);
                }
            } catch (error) {
                console.warn('loadRoadAssets: failed to load child features', error);
            }
        }

        if (includeKeepDetails) {
            try {
                const metaKey = this._roadAssetKey(hash, this._roadAssetSuffixes.metadata);
                const rawDetails = metaKey ? PersistentStorage.getItem(metaKey) : null;
                if (rawDetails) {
                    result.parentsKeepDetails = JSON.parse(rawDetails);
                }
            } catch (error) {
                console.warn('loadRoadAssets: failed to load keep details', error);
            }
        }

        return result;
    },

    clearRoadAssets(proposalHash) {
        if (!proposalHash || typeof PersistentStorage === 'undefined') return;
        const hash = String(proposalHash);
        const parentKey = this._roadAssetKey(hash, this._roadAssetSuffixes.parents);
        const childKey = this._roadAssetKey(hash, this._roadAssetSuffixes.children);
        const metaKey = this._roadAssetKey(hash, this._roadAssetSuffixes.metadata);
        try { if (parentKey) PersistentStorage.removeItem(parentKey); } catch (_) { }
        try { if (childKey) PersistentStorage.removeItem(childKey); } catch (_) { }
        try { if (metaKey) PersistentStorage.removeItem(metaKey); } catch (_) { }
    },

    getAllProposals() {
        return Array.from(this.proposals.values());
    },

    getProposal(hash) {
        return this.proposals.get(hash) || null;
    },

    getProposalsForParcel(parcelId, options = {}) {
        const id = normalizeParcelId(parcelId);
        if (!id) return [];
        const results = [];
        const hydrateRoadAssets = options && Object.prototype.hasOwnProperty.call(options, 'hydrateRoadAssets')
            ? !!options.hydrateRoadAssets
            : true;
        for (const proposal of this.proposals.values()) {
            const parcelMatch = Array.isArray(proposal.parcelIds) && proposal.parcelIds.some(value => normalizeParcelId(value) === id);

            let roadMatch = false;
            if (!parcelMatch && proposal.roadProposal) {
                const road = proposal.roadProposal;
                const parentIds = Array.isArray(road.parentParcelIds) ? road.parentParcelIds : [];
                const childIds = Array.isArray(road.childParcelIds) ? road.childParcelIds : [];
                const combinedIds = parentIds.concat(childIds);
                roadMatch = combinedIds.some(value => normalizeParcelId(value) === id);

                if (!roadMatch && proposal.proposalHash && hydrateRoadAssets) {
                    const assets = this.loadRoadAssets(proposal.proposalHash, {
                        includeParents: true,
                        includeChildren: true,
                        includeKeepDetails: false
                    });
                    if (assets) {
                        const foundInParents = Array.isArray(assets.parentFeatures) && assets.parentFeatures.some(feature => {
                            const featureId = feature?.properties?.CESTICA_ID;
                            return featureId && normalizeParcelId(featureId) === id;
                        });
                        const foundInChildren = !foundInParents && Array.isArray(assets.childFeatures) && assets.childFeatures.some(feature => {
                            const featureId = feature?.properties?.CESTICA_ID;
                            return featureId && normalizeParcelId(featureId) === id;
                        });
                        roadMatch = foundInParents || foundInChildren;

                        if (roadMatch) {
                            const updatedParentIds = Array.isArray(assets.parentFeatures)
                                ? assets.parentFeatures.map(feature => normalizeParcelId(feature?.properties?.CESTICA_ID)).filter(Boolean)
                                : [];
                            const updatedChildIds = Array.isArray(assets.childFeatures)
                                ? assets.childFeatures.map(feature => normalizeParcelId(feature?.properties?.CESTICA_ID)).filter(Boolean)
                                : [];

                            if (updatedParentIds.length) {
                                road.parentParcelIds = Array.from(new Set((road.parentParcelIds || []).concat(updatedParentIds))).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
                            }
                            if (updatedChildIds.length) {
                                road.childParcelIds = Array.from(new Set((road.childParcelIds || []).concat(updatedChildIds))).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
                            }
                            this.proposals.set(proposal.proposalHash, proposal);
                        }
                    }
                }
            }

            if (parcelMatch || roadMatch) {
                results.push(proposal);
            }
        }
        return results;
    },

    addProposal(proposal) {
        if (!proposal || typeof proposal !== 'object') return null;

        const normalized = this._normalizeProposal({ ...proposal });
        let pendingRoadAssets = null;
        if (normalized && normalized.roadProposal && normalized.roadProposal.__extractedRoadAssets) {
            pendingRoadAssets = normalized.roadProposal.__extractedRoadAssets;
            delete normalized.roadProposal.__extractedRoadAssets;
        }
        const seed = this._buildHashSeed(normalized);
        if (this._findDuplicateBySeed(seed)) {
            return null;
        }

        const baseHash = this._hashSeed(seed);
        const proposalHash = this._ensureUniqueHash(baseHash);

        normalized.proposalHash = proposalHash;
        normalized.createdAt = normalized.createdAt || new Date().toISOString();
        normalized.updatedAt = new Date().toISOString();

        // Assign a sequential proposal_id if not provided
        if (normalized.proposal_id === undefined || normalized.proposal_id === null || !Number.isFinite(parseInt(normalized.proposal_id, 10))) {
            normalized.proposal_id = this.nextProposalId;
            this.nextProposalId += 1;
        } else {
            // Normalize to integer
            normalized.proposal_id = parseInt(normalized.proposal_id, 10);
        }

        this.proposals.set(proposalHash, normalized);
        if (pendingRoadAssets) {
            this.persistRoadAssets(proposalHash, pendingRoadAssets);
        }
        this.save();
        return proposalHash;
    },

    importProposal(proposal, options = {}) {
        if (!proposal || typeof proposal !== 'object' || !proposal.proposalHash) {
            return null;
        }

        const { overwrite = true, preserveStatus = false } = options;
        const normalized = this._normalizeProposal({ ...proposal });
        let pendingRoadAssets = null;
        if (normalized && normalized.roadProposal && normalized.roadProposal.__extractedRoadAssets) {
            pendingRoadAssets = normalized.roadProposal.__extractedRoadAssets;
            delete normalized.roadProposal.__extractedRoadAssets;
        }
        normalized.proposalHash = proposal.proposalHash;
        // Preserve incoming proposal_id if present; do not allocate from our local counter
        if (normalized.proposal_id !== undefined && normalized.proposal_id !== null) {
            const pid = parseInt(normalized.proposal_id, 10);
            normalized.proposal_id = Number.isFinite(pid) ? pid : undefined;
        }

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

        if (!overwrite && this.proposals.has(normalized.proposalHash)) {
            return null;
        }

        this.proposals.set(normalized.proposalHash, normalized);
        this.save();
        if (pendingRoadAssets) {
            this.persistRoadAssets(normalized.proposalHash, pendingRoadAssets);
        }
        return normalized;
    },

    removeProposal(hash) {
        const existing = this.proposals.get(hash);
        const deleted = this.proposals.delete(hash);
        if (deleted) {
            this.clearRoadAssets(hash);
            this.save();
            if (typeof removeExecutedBuildingByProposalHash === 'function') {
                try {
                    removeExecutedBuildingByProposalHash(hash);
                } catch (error) {
                    console.warn('removeExecutedBuildingByProposalHash failed', error);
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

    updateProposalStatus(proposalHash, status) {
        const proposal = this.getProposal(proposalHash);
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

            this.proposals.set(proposalHash, proposal);
        }
    },

    _normalizeProposal(proposal, context = {}) {
        const { existingHash = null } = context || {};
        proposal.parcelIds = normalizeParcelIdList(proposal.parcelIds);
        proposal.acceptedParcelIds = normalizeParcelIdList(proposal.acceptedParcelIds || []);
        proposal.ownerAcceptances = normalizeOwnerAcceptances(proposal.ownerAcceptances || {});
        proposal.status = proposal.status || 'Active';

        if (proposal.proposal_id !== undefined && proposal.proposal_id !== null) {
            const pid = parseInt(proposal.proposal_id, 10);
            proposal.proposal_id = Number.isFinite(pid) ? pid : undefined;
        }

        if (!proposal.type) {
            if (proposal.roadProposal) {
                proposal.type = 'road';
            } else if (proposal.buildingProposal || proposal.buildingGeometry) {
                proposal.type = 'building';
            } else if (proposal.structureProposal) {
                proposal.type = 'structure';
            } else {
                proposal.type = 'parcel';
            }
        }

        if (proposal.roadProposal) {
            const rp = { ...proposal.roadProposal };
            const parentFeatures = Array.isArray(rp.parentFeatures)
                ? rp.parentFeatures.map(feature => normalizeFeature(deepClone(feature)))
                : [];
            const childFeatures = Array.isArray(rp.childFeatures)
                ? rp.childFeatures.map(feature => normalizeFeature(deepClone(feature)))
                : [];

            const parentIdSet = new Set(Array.isArray(rp.parentParcelIds)
                ? rp.parentParcelIds.map(id => normalizeParcelId(id)).filter(Boolean)
                : []);
            parentFeatures.forEach(feature => {
                const featureId = normalizeParcelId(feature?.properties?.CESTICA_ID);
                if (featureId) parentIdSet.add(featureId);
            });
            rp.parentParcelIds = Array.from(parentIdSet).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

            const childIdSet = new Set(Array.isArray(rp.childParcelIds)
                ? rp.childParcelIds.map(id => normalizeParcelId(id)).filter(Boolean)
                : []);
            childFeatures.forEach(feature => {
                const featureId = normalizeParcelId(feature?.properties?.CESTICA_ID);
                if (featureId) childIdSet.add(featureId);
            });
            rp.childParcelIds = Array.from(childIdSet).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

            const parentsKeepDetails = rp.parentsKeepDetails && typeof rp.parentsKeepDetails === 'object'
                ? rp.parentsKeepDetails
                : null;

            const hasParentAssets = parentFeatures.length > 0;
            const hasChildAssets = childFeatures.length > 0;
            const hasMeta = parentsKeepDetails && Object.keys(parentsKeepDetails).length > 0;

            if (existingHash && (hasParentAssets || hasChildAssets || hasMeta)) {
                this.persistRoadAssets(existingHash, {
                    parentFeatures: hasParentAssets ? parentFeatures : undefined,
                    childFeatures: hasChildAssets ? childFeatures : undefined,
                    parentsKeepDetails: hasMeta ? parentsKeepDetails : null
                });
            } else if (hasParentAssets || hasChildAssets || hasMeta) {
                Object.defineProperty(rp, '__extractedRoadAssets', {
                    value: {
                        parentFeatures: hasParentAssets ? parentFeatures : [],
                        childFeatures: hasChildAssets ? childFeatures : [],
                        parentsKeepDetails: hasMeta ? parentsKeepDetails : null
                    },
                    enumerable: false,
                    configurable: true
                });
            }

            delete rp.parentFeatures;
            delete rp.childFeatures;
            proposal.roadProposal = rp;
        }

        if (proposal.buildingProposal) {
            const bp = { ...proposal.buildingProposal };
            bp.parentParcelIds = normalizeParcelIdList(bp.parentParcelIds && bp.parentParcelIds.length > 0 ? bp.parentParcelIds : proposal.parcelIds);
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
            if (bp.buildingFeature && typeof bp.buildingFeature === 'object') {
                try { bp.buildingFeature = JSON.parse(JSON.stringify(bp.buildingFeature)); } catch (_) { }
            }
            if (!bp.ancestorKey) {
                bp.ancestorKey = (bp.parentParcelIds || []).join('|');
            }
            proposal.buildingProposal = bp;
        } else if (proposal.buildingGeometry || proposal.type === 'building') {
            const parentIds = normalizeParcelIdList(proposal.parcelIds);
            proposal.buildingProposal = {
                parentParcelIds: parentIds,
                parentParcelNumbers: parentIds.map(id => ({ id, number: id })),
                status: (proposal.status === 'Applied' || proposal.status === 'Executed') ? 'applied' : 'unapplied',
                ancestorKey: parentIds.join('|'),
                parameters: {}
            };
        }

        // Normalize structure proposals (parks/squares)
        if (proposal.structureProposal) {
            const sp = { ...proposal.structureProposal };
            sp.kind = (sp.kind === 'park' || sp.kind === 'square') ? sp.kind : 'square';
            sp.parentParcelIds = normalizeParcelIdList(Array.isArray(sp.parentParcelIds) && sp.parentParcelIds.length > 0 ? sp.parentParcelIds : proposal.parcelIds);
            sp.status = (sp.status === 'applied' || proposal.status === 'Applied') ? 'applied' : 'unapplied';
            if (sp.geometry) {
                try { sp.geometry = JSON.parse(JSON.stringify(sp.geometry)); } catch (_) { }
            }
            if (sp.blockName === undefined) {
                sp.blockName = null;
            }
            proposal.structureProposal = sp;
            proposal.type = 'structure';
        }

        return proposal;
    },

    _buildHashSeed(proposal) {
        const parts = [];
        parts.push(proposal.title || '');
        parts.push(proposal.type || '');
        parts.push(proposal.description || '');
        parts.push(proposal.author || '');
        parts.push(typeof proposal.offer === 'number' ? proposal.offer.toFixed(2) : (proposal.offer || ''));
        parts.push((proposal.parcelIds || []).join(','));

        if (proposal.roadProposal) {
            const parentIds = normalizeParcelIdList(proposal.roadProposal.parentParcelIds || []).join(',');
            const childIds = normalizeParcelIdList(proposal.roadProposal.childParcelIds || []).join(',');
            parts.push(`roadParents:${parentIds}`);
            parts.push(`roadChildren:${childIds}`);
            if (proposal.roadProposal.id) {
                parts.push(`roadId:${proposal.roadProposal.id}`);
            }

            const definition = proposal.roadProposal.definition || proposal.definition;
            if (definition) {
                parts.push(`roadDef:${serialiseRoadDefinition(definition)}`);
            }
        }

        if (proposal.definition && (!proposal.roadProposal || !proposal.roadProposal.definition)) {
            parts.push(`roadDef:${serialiseRoadDefinition(proposal.definition)}`);
        }

        if (proposal.roadGeometry && proposal.roadGeometry.polygon && Array.isArray(proposal.roadGeometry.polygon.coordinates)) {
            const coords = proposal.roadGeometry.polygon.coordinates[0] || [];
            parts.push(`roadGeom:${serialiseRoadCoordinates(coords)}`);
        }

        if (proposal.buildingGeometry) {
            parts.push(`building:${serialiseGeometry(proposal.buildingGeometry)}`);
            if (proposal.buildingProperties) {
                try {
                    parts.push(`buildingProps:${JSON.stringify(proposal.buildingProperties)}`);
                } catch (_) { }
            } else if (proposal.type === 'building' && proposal.properties) {
                try {
                    parts.push(`buildingProps:${JSON.stringify(proposal.properties)}`);
                } catch (_) { }
            }
        }

        // Structure proposals (park/square)
        if (proposal.structureProposal) {
            const sp = proposal.structureProposal;
            parts.push(`structureKind:${sp.kind || ''}`);
            parts.push(`structureParents:${normalizeParcelIdList(sp.parentParcelIds || proposal.parcelIds).join(',')}`);
            if (sp.blockName) parts.push(`structureBlock:${sp.blockName}`);
            if (sp.geometry) parts.push(`structureGeom:${serialiseGeometry(sp.geometry)}`);
        }

        return parts.join('|');
    },

    _hashSeed(seed) {
        let hash = 0;
        for (let i = 0; i < seed.length; i++) {
            hash = ((hash << 5) - hash) + seed.charCodeAt(i);
            hash |= 0; // Convert to 32bit integer
        }
        const safeHash = Math.abs(hash).toString(16);
        return `${PROPOSAL_HASH_PREFIX}${safeHash}`;
    },

    _ensureUniqueHash(baseHash) {
        let candidate = baseHash;
        let counter = 1;
        while (this.proposals.has(candidate)) {
            candidate = `${baseHash}_${counter++}`;
        }
        return candidate;
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
    activeProposalHash: null,
    pendingBlink: false
};

let currentProposalPreviewHash = null;

function ensureProposalOverlayGroups() {
    if (typeof map === 'undefined' || !map) {
        return {};
    }

    if (!window.proposalPreviewGroup) {
        window.proposalPreviewGroup = L.featureGroup().addTo(map);
    }
    if (!window.proposalBorderGroup) {
        window.proposalBorderGroup = L.featureGroup().addTo(map);
    }
    if (!window.proposalHoverGroup) {
        window.proposalHoverGroup = L.featureGroup().addTo(map);
    }
    if (!window.proposalHoverLabelGroup) {
        window.proposalHoverLabelGroup = L.featureGroup().addTo(map);
    }
    if (!window.proposalBackgroundGroup) {
        window.proposalBackgroundGroup = L.featureGroup().addTo(map);
    }
    if (!window.proposalAcceptedGroup) {
        window.proposalAcceptedGroup = L.featureGroup().addTo(map);
    }

    return {
        preview: window.proposalPreviewGroup,
        border: window.proposalBorderGroup,
        hover: window.proposalHoverGroup,
        hoverLabels: window.proposalHoverLabelGroup,
        background: window.proposalBackgroundGroup,
        accepted: window.proposalAcceptedGroup
    };
}

function clearProposalBackgroundLayers() {
    const groups = ensureProposalOverlayGroups();
    if (groups.background) groups.background.clearLayers();
}

function clearProposalAcceptedLayers() {
    const groups = ensureProposalOverlayGroups();
    if (groups.accepted) groups.accepted.clearLayers();
}

function clearProposalPreviewLayers() {
    const groups = ensureProposalOverlayGroups();
    if (groups.preview) groups.preview.clearLayers();
    if (groups.border) groups.border.clearLayers();
}

function clearProposalHoverLayers() {
    const groups = ensureProposalOverlayGroups();
    if (groups.hover) groups.hover.clearLayers();
    if (groups.hoverLabels) groups.hoverLabels.clearLayers();
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

function getFeatureCentroid(feature) {
    if (!feature || !feature.geometry) return null;
    try {
        if (typeof turf !== 'undefined' && typeof turf.centerOfMass === 'function') {
            const centroid = turf.centerOfMass(feature);
            const coords = centroid?.geometry?.coordinates;
            if (Array.isArray(coords) && coords.length >= 2) {
                const [lng, lat] = coords;
                if (Number.isFinite(lat) && Number.isFinite(lng)) {
                    return L.latLng(lat, lng);
                }
            }
        }
    } catch (_) { }

    try {
        const temp = L.geoJSON(feature);
        const bounds = temp.getBounds();
        if (bounds && bounds.isValid()) {
            return bounds.getCenter();
        }
    } catch (_) { }
    return null;
}

function highlightFeaturesForHover(features, { color = '#FFB300', weight = 5, dashArray = '4 4', showLabels = false } = {}) {
    const groups = ensureProposalOverlayGroups();
    if (!groups.hover || !groups.hoverLabels) return;

    groups.hover.clearLayers();
    groups.hoverLabels.clearLayers();

    if (!Array.isArray(features)) return;

    features.forEach(feature => {
        if (!feature || !feature.geometry) return;
        try {
            const outline = L.geoJSON(feature, {
                style: {
                    color,
                    weight,
                    fillOpacity: 0,
                    dashArray
                },
                interactive: false
            });
            outline.addTo(groups.hover);

            if (showLabels) {
                const broj = feature?.properties?.BROJ_CESTICE;
                const center = getFeatureCentroid(feature);
                if (broj && center) {
                    const label = L.marker(center, {
                        icon: L.divIcon({
                            className: 'proposal-hover-parcel-label',
                            html: `${broj}`,
                            iconSize: [46, 20],
                            iconAnchor: [23, 10]
                        }),
                        interactive: false
                    });
                    label.addTo(groups.hoverLabels);
                }
            }
        } catch (error) {
            console.warn('Failed to highlight feature for hover', error);
        }
    });

    if (groups.hover.bringToFront) groups.hover.bringToFront();
    if (groups.hoverLabels.bringToFront) groups.hoverLabels.bringToFront();
}

function getParcelFeatureForHighlight(parcelId) {
    if (!parcelId || typeof multiParcelSelection === 'undefined' || !multiParcelSelection.findParcelById) {
        return null;
    }

    try {
        const layer = multiParcelSelection.findParcelById(parcelId);
        if (layer && typeof layer.toGeoJSON === 'function') {
            return layer.toGeoJSON();
        }
    } catch (error) {
        console.warn('getParcelFeatureForHighlight: unable to locate parcel', parcelId, error);
    }
    return null;
}

function collectProposalHighlightFeatures(proposal, { includeParents = false, includeChildren = true } = {}) {
    const features = [];
    if (!proposal) return features;

    const isRoadProposal = proposal.type === 'road' && proposal.roadProposal;

    if (isRoadProposal && includeChildren !== false && Array.isArray(proposal.roadProposal.childFeatures)) {
        proposal.roadProposal.childFeatures.forEach(feature => {
            if (feature && feature.geometry) {
                features.push(feature);
            }
        });
    }

    if (includeParents && proposal.roadProposal && Array.isArray(proposal.roadProposal.parentFeatures)) {
        proposal.roadProposal.parentFeatures.forEach(feature => {
            if (feature && feature.geometry) {
                features.push(feature);
            }
        });
    }

    if ((!isRoadProposal || features.length === 0) && Array.isArray(proposal.parcelIds)) {
        proposal.parcelIds.forEach(parcelId => {
            const feature = getParcelFeatureForHighlight(parcelId);
            if (feature) {
                features.push(feature);
            }
        });
    }

    return features;
}

function highlightParcelHover(parcelId, options = {}) {
    const feature = getParcelFeatureForHighlight(parcelId);
    if (feature) {
        highlightFeaturesForHover([feature], {
            color: '#4FC3F7',
            weight: 5,
            showLabels: true,
            ...options
        });
    }
}

function highlightProposalHover(proposal, options = {}) {
    const features = collectProposalHighlightFeatures(proposal, options);
    if (features.length > 0) {
        highlightFeaturesForHover(features, options);
    }
}

function highlightProposalHoverByHash(proposalHash, options = {}) {
    if (!proposalHash || typeof proposalStorage === 'undefined') return;
    const proposal = proposalStorage.getProposal(proposalHash);
    if (proposal) {
        highlightProposalHover(proposal, options);
    }
}

// Global flag to suppress camera movements during certain flows (e.g., shared apply)
function isCameraMovementSuppressed() {
    try { return !!(window && window.suppressCameraMoves); } catch (_) { return false; }
}

function cloneGeoJSONFeature(feature) {
    try {
        return JSON.parse(JSON.stringify(feature));
    } catch (_) {
        return null;
    }
}

function normaliseToFeature(input, defaultProperties = {}) {
    if (!input) return null;

    if (input.type === 'Feature' && input.geometry) {
        const cloned = cloneGeoJSONFeature(input);
        if (cloned) {
            cloned.properties = { ...(cloned.properties || {}), ...defaultProperties };
        }
        return cloned;
    }

    if (input.type && input.coordinates) {
        const geometryClone = cloneGeoJSONFeature(input);
        if (!geometryClone) return null;
        return {
            type: 'Feature',
            geometry: geometryClone,
            properties: { ...defaultProperties }
        };
    }

    return null;
}

function collectProposalFeatureSets(proposal) {
    const parcelFeatures = [];
    const primaryFeatures = [];
    const parcelIds = Array.isArray(proposal?.parcelIds) ? proposal.parcelIds : [];

    parcelIds.forEach(parcelId => {
        const feature = getParcelFeatureForHighlight(parcelId);
        if (feature) {
            parcelFeatures.push(feature);
        }
    });

    if (proposal?.type === 'road' && proposal.roadProposal) {
        const childFeatures = Array.isArray(proposal.roadProposal.childFeatures) ? proposal.roadProposal.childFeatures : [];
        childFeatures.forEach(feature => {
            const normalised = normaliseToFeature(feature, { source: 'road-child' });
            if (normalised) {
                primaryFeatures.push(normalised);
            }
        });
    }
    if (proposal?.buildingProposal?.buildingFeature) {
        const buildingFeature = normaliseToFeature(proposal.buildingProposal.buildingFeature, { source: 'building' });
        if (buildingFeature) {
            primaryFeatures.push(buildingFeature);
        }
    } else if (proposal?.buildingGeometry) {
        const buildingGeometry = normaliseToFeature(proposal.buildingGeometry, { source: 'building' });
        if (buildingGeometry) {
            primaryFeatures.push(buildingGeometry);
        }
    }

    if (proposal?.structureProposal?.geometry) {
        const kind = (proposal.structureProposal.kind || '').toLowerCase();
        const structureFeature = normaliseToFeature(
            proposal.structureProposal.geometry,
            { source: `structure-${kind || 'generic'}` }
        );
        if (structureFeature) {
            primaryFeatures.push(structureFeature);
        }
    }

    if (Array.isArray(proposal?.reparcellization?.polygons)) {
        proposal.reparcellization.polygons.forEach(slice => {
            if (!slice || !slice.geometry) return;
            const featureInput = {
                type: 'Feature',
                geometry: slice.geometry,
                properties: {
                    ownerKey: slice.ownerKey || null,
                    displayName: slice.displayName || null,
                    color: slice.color || null,
                    percent: slice.percent || null
                }
            };
            const reparcelFeature = normaliseToFeature(featureInput, { source: 'reparcellization-slice' });
            if (reparcelFeature) {
                reparcelFeature.properties = {
                    ...(reparcelFeature.properties || {}),
                    ownerKey: slice.ownerKey || null,
                    displayName: slice.displayName || null,
                    color: slice.color || null,
                    percent: slice.percent || null
                };
                primaryFeatures.push(reparcelFeature);
            }
        });
    }

    if (Array.isArray(proposal?.childFeatures)) {
        proposal.childFeatures.forEach(feature => {
            const normalised = normaliseToFeature(feature, { source: 'proposal-child' });
            if (normalised) {
                primaryFeatures.push(normalised);
            }
        });
    }

    if (primaryFeatures.length === 0 && parcelFeatures.length > 0) {
        primaryFeatures.push(...parcelFeatures);
    }

    return {
        parcelFeatures,
        primaryFeatures,
        parcelIds: parcelIds.map(id => (id !== undefined && id !== null) ? id.toString() : null).filter(Boolean)
    };
}

function applyBlinkToLayerGroup(layerGroup, className) {
    if (!layerGroup || !className) return;
    if (typeof layerGroup.eachLayer !== 'function') return;

    layerGroup.eachLayer(layer => {
        if (layer && typeof layer.getElement === 'function') {
            const el = layer.getElement();
            if (el) {
                el.classList.remove(className);
                // Force reflow to restart animation
                // eslint-disable-next-line no-unused-expressions
                el.offsetWidth;
                el.classList.add(className);
            }
        }
    });
}

function addFeatureToGroup(feature, group, styleOptions, blinkClass) {
    if (!feature || !group) return null;
    try {
        const layer = L.geoJSON(feature, {
            style: typeof styleOptions === 'function' ? styleOptions : () => ({ ...styleOptions }),
            interactive: false
        });
        layer.addTo(group);
        if (blinkClass) {
            requestAnimationFrame(() => applyBlinkToLayerGroup(layer, blinkClass));
        }
        return layer;
    } catch (error) {
        console.warn('addFeatureToGroup: unable to render feature', error);
        return null;
    }
}

function renderAppliedProposalHighlight(proposal, { blink = false } = {}) {
    const groups = ensureProposalOverlayGroups();
    if (!groups.border) {
        return { activeIds: new Set(), primaryFeatures: [] };
    }

    groups.border.clearLayers();

    if (!proposal) {
        return { activeIds: new Set(), primaryFeatures: [] };
    }

    const { parcelFeatures, primaryFeatures, parcelIds } = collectProposalFeatureSets(proposal);

    const parcelStyle = {
        color: '#1E3A8A',
        weight: 3,
        opacity: 0.9,
        dashArray: '8 6',
        fillOpacity: 0,
        className: 'proposal-parcel-outline'
    };

    const primaryStyle = {
        color: '#2563EB',
        weight: 4,
        opacity: 1,
        dashArray: null,
        fillOpacity: 0.2,
        className: 'proposal-primary-outline'
    };

    parcelFeatures.forEach(feature => {
        addFeatureToGroup(feature, groups.border, parcelStyle, blink ? 'proposal-blink-twice' : null);
    });

    primaryFeatures.forEach(feature => {
        addFeatureToGroup(feature, groups.border, primaryStyle, blink ? 'proposal-blink-twice' : null);
    });

    if (groups.border.bringToFront) {
        groups.border.bringToFront();
    }

    return {
        activeIds: new Set(parcelIds),
        primaryFeatures
    };
}

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

    const parcelStyle = {
        color: '#00897B',
        weight: 3,
        opacity: 1,
        dashArray: '4 6',
        fillOpacity: 0,
        className: 'proposal-preview-parcel'
    };

    const primaryStyle = {
        color: '#8E24AA',
        weight: 4,
        opacity: 0.95,
        dashArray: '2 8',
        fillOpacity: 0.25,
        className: 'proposal-preview-outline'
    };

    parcelFeatures.forEach(feature => {
        addFeatureToGroup(feature, groups.preview, parcelStyle, blink ? 'proposal-preview-blink' : null);
    });

    const featuresToDraw = hasPrimary ? primaryFeatures : parcelFeatures;

    featuresToDraw.forEach(feature => {
        addFeatureToGroup(feature, groups.preview, primaryStyle, blink ? 'proposal-preview-blink' : null);
    });

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
    currentProposalPreviewHash = null;
}

function getFirstSelectableParcel(proposal) {
    if (!proposal || !Array.isArray(proposal.parcelIds)) {
        return null;
    }

    for (const parcelId of proposal.parcelIds) {
        try {
            const layer = multiParcelSelection.findParcelById(parcelId);
            if (layer) {
                return parcelId;
            }
        } catch (_) {
            // Ignore lookup issues and continue searching
        }
    }

    return proposal.parcelIds.length > 0 ? proposal.parcelIds[0] : null;
}

function previewProposalOnMap(proposalHash, { center = true, blink = true } = {}) {
    if (!proposalHash || typeof proposalStorage === 'undefined') {
        return;
    }

    const proposal = proposalStorage.getProposal(proposalHash);
    if (!proposal) {
        return;
    }

    currentProposalPreviewHash = proposalHash;

    const { parcelFeatures, primaryFeatures } = renderPreviewOverlay(proposal, { blink });

    if (!center || typeof map === 'undefined' || !map) {
        return;
    }

    const featuresForBounds = primaryFeatures.length > 0 ? primaryFeatures : parcelFeatures;
    let bounds = computeBoundsFromFeatures(featuresForBounds);

    if (!bounds && Array.isArray(proposal.parcelIds) && proposal.parcelIds.length > 0) {
        const calculated = calculateProposalBounds(proposal.parcelIds);
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
        map.fitBounds(bounds.pad(0.08), { maxZoom: 19 });
    } else if (proposal.bounds && proposal.bounds.center) {
        const { lat, lng } = proposal.bounds.center;
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
            map.setView([lat, lng], map.getZoom());
        }
    }
}

function getFeatureByParcelId(features, parcelId) {
    if (!Array.isArray(features) || !parcelId) return null;
    const target = parcelId.toString();
    return features.find(f => f?.properties?.CESTICA_ID && f.properties.CESTICA_ID.toString() === target) || null;
}

function computeBoundsFromFeatures(features) {
    if (!Array.isArray(features) || features.length === 0 || typeof L === 'undefined') {
        return null;
    }
    try {
        const combined = L.featureGroup(features.map(f => L.geoJSON(f)));
        const bounds = combined.getBounds();
        if (bounds && bounds.isValid()) {
            return bounds;
        }
    } catch (error) {
        console.warn('computeBoundsFromFeatures failed', error);
    }
    return null;
}
// Multi-parcel selection state
function syncMultiSelectCheckboxes(isChecked) {
    const checkboxIds = ['multiSelectCheckbox', 'multiSelectCheckboxTools'];
    checkboxIds.forEach(id => {
        const checkbox = document.getElementById(id);
        if (checkbox) {
            checkbox.checked = !!isChecked;
        }
    });
}

const multiParcelSelection = {
    isActive: false,
    selectedParcels: new Set(),
    syntheticParcelLayers: new Map(),
    syntheticLayerGroup: null,
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
                    layer: hasCurrentParcel
                        ? (currentParcel.layer || this.findParcelById(currentParcel.id))
                        : this.findParcelById(fallbackParcelId)
                }
                : null;

            this.selectedParcels.clear();

            if (preservedParcelInfo && preservedParcelInfo.id) {
                this.clearSingleParcelSelection({ preservePanel: true });
                this.selectedParcels.add(preservedParcelInfo.id);
                this.lastSelectedParcelId = preservedParcelInfo.id;
                const targetLayer = preservedParcelInfo.layer || this.findParcelById(preservedParcelInfo.id);
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
                if (layer.feature && layer.feature.properties &&
                    layer.feature.properties.CESTICA_ID.toString() === selectedParcelId) {

                    // Reset style
                    const parcelIdValue = layer.feature.properties.CESTICA_ID;
                    const baseStyle = (typeof getParcelBaseStyle === 'function')
                        ? getParcelBaseStyle(parcelIdValue)
                        : (() => {
                            const isRoad = PersistentStorage.getItem(`parcel_${parcelIdValue}_isRoad`) === 'true';
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
                panelTitle && panelTitle.textContent === 'Parcel Info') {
                if (typeof hideParcelInfoPanel === 'function') {
                    hideParcelInfoPanel();
                }
            }
        }
    },

    // Add or remove parcel from selection
    toggleParcel(parcel) {
        if (!this.isActive) return false;

        const parcelId = parcel.feature.properties.CESTICA_ID.toString();

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
                if (layer.feature && layer.feature.properties && layer.feature.properties.CESTICA_ID.toString() === selectedParcelId) {
                    const baseStyle = (typeof getParcelBaseStyle === 'function')
                        ? getParcelBaseStyle(selectedParcelId)
                        : (() => {
                            const isRoad = PersistentStorage.getItem(`parcel_${selectedParcelId}_isRoad`) === 'true';
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
        let checkedCount = 0;

        // First, try to find in the existing parcelLayer
        if (typeof parcelLayer !== 'undefined' && parcelLayer) {
            parcelLayer.eachLayer(layer => {
                checkedCount++;
                if (layer.feature && layer.feature.properties &&
                    layer.feature.properties.CESTICA_ID) {
                    const layerId = layer.feature.properties.CESTICA_ID.toString();
                    if (layerId === targetId) {
                        foundParcel = layer;
                    }
                }
            });
        } else {
            console.warn('findParcelById: parcelLayer not available');
        }

        // If not found in parcelLayer, try to recover from cache
        if (!foundParcel && typeof parcelCache !== 'undefined') {
            foundParcel = this.recoverParcelFromCache(targetId);
            if (foundParcel) {
                // console.log(`findParcelById: Recovered parcel ${parcelId} from cache and added to parcelLayer`);
            }
        }

        // Final fallback: try PersistentStorage
        if (!foundParcel) {
            foundParcel = this.recoverParcelFromPersistentStorage(targetId);
            if (foundParcel) {
                //console.log(`findParcelById: Recovered parcel ${parcelId} from PersistentStorage and added to parcelLayer`);
            }
        }

        // Try to recover from proposal data (unapplied descendants)
        if (!foundParcel) {
            foundParcel = this.recoverParcelFromProposals(targetId);
        }

        if (!foundParcel) {
            console.warn('findParcelById: Could not find parcel with ID:', parcelId, 'in parcelLayer, cache, PersistentStorage, or proposals');
        }

        return foundParcel;
    },

    // Recover parcel from grid cache and instantiate as layer
    recoverParcelFromCache(parcelId) {
        if (!parcelCache || !parcelCache.grid) return null;

        // Search all grid cells for the parcel
        for (const [gridKey, cellData] of parcelCache.grid) {
            if (cellData && cellData.features) {
                const feature = cellData.features.find(f =>
                    f.properties && f.properties.CESTICA_ID &&
                    f.properties.CESTICA_ID.toString() === parcelId.toString()
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
        const geometryStr = PersistentStorage.getItem(`parcel_${parcelId}_geometry`);
        const propertiesStr = PersistentStorage.getItem(`parcel_${parcelId}_properties`);

        if (geometryStr && propertiesStr) {
            try {
                const geometry = JSON.parse(geometryStr);
                const properties = JSON.parse(propertiesStr);

                // Reconstruct the feature
                const feature = {
                    type: 'Feature',
                    properties: properties,
                    geometry: {
                        type: 'Polygon',
                        coordinates: [geometry]
                    }
                };

                // Ensure calculatedArea is set
                if (!feature.properties.calculatedArea) {
                    // Use the calculateArea function if available
                    if (typeof calculateArea === 'function') {
                        feature.properties.calculatedArea = calculateArea([geometry]);
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
        if (typeof proposalStorage === 'undefined' || !proposalStorage.getAllProposals) {
            return null;
        }

        const proposals = proposalStorage.getAllProposals();
        if (!Array.isArray(proposals) || proposals.length === 0) {
            return null;
        }

        const targetId = parcelId.toString();
        const findFeatureById = (features) => {
            if (!Array.isArray(features)) return null;
            for (const feature of features) {
                const featureId = feature?.properties?.CESTICA_ID;
                if (featureId && featureId.toString() === targetId) {
                    return feature;
                }
            }
            return null;
        };

        for (const proposal of proposals) {
            if (!proposal || proposal.type !== 'road') continue;
            const roadProposal = proposal.roadProposal;
            if (!roadProposal) continue;

            let candidateFeature = findFeatureById(roadProposal.parentFeatures);
            if (!candidateFeature) {
                candidateFeature = findFeatureById(roadProposal.childFeatures);
            }

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
    },

    // Create a Leaflet layer from a feature and add it to parcelLayer
    createParcelLayerFromFeature(feature, options = {}) {
        if (!feature || !feature.geometry || !feature.properties) {
            console.error('createParcelLayerFromFeature: Invalid feature provided');
            return null;
        }

        const { addToParcelLayer = true, makeInteractive = true } = options;

        try {
            // Convert coordinates if needed (same logic as in fetchParcelData)
            let convertedFeature = feature;
            if (typeof convertGeoJSON === 'function') {
                const featureCollection = {
                    type: 'FeatureCollection',
                    features: [feature]
                };
                const converted = convertGeoJSON(featureCollection);
                convertedFeature = converted.features[0];
            }

            // Create the Leaflet layer
            const layer = L.geoJSON(convertedFeature, {
                style: (feature) => {
                    const parcelId = feature.properties.CESTICA_ID;
                    const storedRoad = PersistentStorage.getItem(`parcel_${parcelId}_isRoad`) === 'true';
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
                const parcelId = feature.properties.CESTICA_ID;
                const storedRoad = PersistentStorage.getItem(`parcel_${parcelId}_isRoad`) === 'true';
                const propertyRoad = parcelLayerInstance?.feature?.properties?.isRoad === true || feature?.properties?.isRoad === true;
                const isRoad = storedRoad || propertyRoad;
                parcelLayerInstance.feature.properties.isRoad = !!isRoad;
                if (isRoad) {
                    const roadName = feature?.properties?.roadName || PersistentStorage.getItem(`parcel_${parcelId}_roadName`) || 'Unnamed Road';
                    parcelLayerInstance.bindTooltip(roadName, {
                        permanent: false,
                        direction: 'center',
                        className: 'road-name-tooltip'
                    });
                    parcelLayerInstance.feature.properties.roadName = roadName;
                    parcelLayerInstance.feature.properties.roadId = feature?.properties?.roadId || PersistentStorage.getItem(`parcel_${parcelId}_roadId`) || '';
                    parcelLayerInstance.feature.properties.roadConfidence = feature?.properties?.roadConfidence || PersistentStorage.getItem(`parcel_${parcelId}_roadConfidence`) || '0';
                }

                // Add to parcelLayer if it exists
                if (addToParcelLayer && typeof parcelLayer !== 'undefined' && parcelLayer) {
                    parcelLayer.addLayer(parcelLayerInstance);
                    if (typeof window.indexParcelLayer === 'function') {
                        window.indexParcelLayer(parcelLayerInstance);
                    }
                    // Add to map if parcel layer is currently visible
                    if (map && map.hasLayer(parcelLayer)) {
                        parcelLayerInstance.addTo(map);
                    }
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
        const parcelId = parcel?.feature?.properties?.CESTICA_ID;
        const baseStyle = (typeof getParcelBaseStyle === 'function')
            ? getParcelBaseStyle(parcelId)
            : (() => {
                const isRoad = PersistentStorage.getItem(`parcel_${parcelId}_isRoad`) === 'true';
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
        console.log('getSelectedParcels called, selectedParcels size:', this.selectedParcels.size, 'found parcels:', parcels.length);
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
                    setParcelInfoPanelTitle('Multiparcel selection');
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
                setParcelInfoPanelTitle('Multiparcel selection');
            }
        }
    },

    // Show multi-parcel info panel
    showMultiParcelInfo() {
        const parcels = this.getSelectedParcels();
        const totalArea = parcels.reduce((sum, parcel) =>
            sum + (parcel.feature.properties.calculatedArea || 0), 0);
        const totalEstimatedPrice = totalArea * (typeof SQM_AVG_PRICE !== 'undefined' ? SQM_AVG_PRICE : 133);

        setParcelInfoPanelTitle('Multiparcel selection');

        // Hide parcel-specific buttons when showing multiple parcels
        const parcelButtons = document.querySelector('.parcel-info-buttons');
        if (parcelButtons) {
            parcelButtons.style.display = 'none';
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
                <button class="btn btn-secondary" onclick="cancelMultiParcelSelection()" style="padding: 8px 16px;">
                    Cancel Selection
                </button>
            </div>
            <div class="metric-group">
                <div class="metric-label">Selected Parcels:</div>
                <div class="metric-value">${parcels.length}</div>
            </div>
            <div class="metric-group">
                <div class="metric-label">Total Area:</div>
                <div class="metric-value">${Math.round(totalArea).toLocaleString('hr-HR')} m²</div>
            </div>
            <div class="metric-group">
                <div class="metric-label">Est. Total Value:</div>
                <div class="metric-value">${Math.round(totalEstimatedPrice).toLocaleString('hr-HR')} €</div>
            </div>
            <hr style="border: 0; height: 1px; background-color: #ddd; margin: 10px 0;">
            <div class="metric-group">
                <div class="metric-label">Selected Parcels:</div>
                <div class="selected-parcels-list">
                    ${parcels.map(parcel => {
            const area = parcel.feature.properties.calculatedArea || 0;
            const price = area * (typeof SQM_AVG_PRICE !== 'undefined' ? SQM_AVG_PRICE : 133);
            const isRoad = PersistentStorage.getItem(`parcel_${parcel.feature.properties.CESTICA_ID}_isRoad`) === 'true';
            return `
                            <div class="selected-parcel-item">
                                <div class="parcel-number">Parcel ${parcel.feature.properties.BROJ_CESTICE}</div>
                                <div class="parcel-details">
                                    ${Math.round(area).toLocaleString('hr-HR')} m² • 
                                    ${Math.round(price).toLocaleString('hr-HR')} €
                                    ${isRoad ? ' • <span style="color: #28a745;">Road</span>' : ''}
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
            <div class="metric-group">
                <div class="metric-label">Proposals:</div>
                <div class="metric-value">Create a proposal that includes all the selected parcels.</div>
            </div>
            <div id="parcel-proposal-actions" class="parcel-proposal-actions"></div>
        `;
        document.getElementById('proposals-content').innerHTML = proposalsContent;
        if (typeof renderParcelProposalActions === 'function') {
            renderParcelProposalActions();
        }

        document.getElementById('parcel-info-panel').classList.add('visible');
    },

    // Hide parcel info panel
    hideParcelInfo() {
        // Reset the panel title back to original
        const panelTitle = document.querySelector('#parcel-info-panel h3');
        if (panelTitle) {
            panelTitle.textContent = 'Parcel Info';
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
    }
};

// Proposal layer management
let proposalLayer = null;

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
function updateProposalLayer() { /* intentionally empty */ }

// Refresh the proposals layer (called when proposals are updated)
function refreshProposalsLayer() {
    // No special layer to refresh anymore, keep count and indicator in sync
    try { if (typeof updateShowProposalsButton === 'function') updateShowProposalsButton(); } catch (_) { }
    try { if (typeof syncProposalsIndicator === 'function') syncProposalsIndicator(); } catch (_) { }
}

// Lightweight function to refresh proposal data without rebuilding visual layers
function refreshProposalData() {
    // This function updates proposal-related data without touching the visual layers
    // It's called during game turns when there are active highlights to avoid flicker

    // Update proposal counts and status if needed
    if (typeof updateShowProposalsButton === 'function') updateShowProposalsButton();
    if (typeof syncProposalsIndicator === 'function') syncProposalsIndicator();

    // Only refresh proposal info if the modal is currently open
    if (window.currentlyHighlightedProposal && window.selectedParcelInProposal) {
        // Check if the proposal details panel is actually visible
        const proposalPanel = document.getElementById('parcel-info-panel');
        const isProposalModalOpen = proposalPanel &&
            proposalPanel.classList.contains('visible') &&
            proposalPanel.querySelector('h3')?.textContent === 'Proposal Details';

        if (isProposalModalOpen) {
            const updatedProposal = proposalStorage.getProposal(window.currentlyHighlightedProposal.proposalHash);
            if (updatedProposal) {
                // Update the proposal info only if modal is open
                showProposalInfo(updatedProposal, window.selectedParcelInProposal);
            }
        }
    }
}

// Handle clicks on road proposals
function showRoadProposalInfo(proposal) {
    // Clear any existing highlights
    clearProposalHighlights();

    // Show road proposal info in the parcel info panel (reusing existing UI)
    const roadGeometry = proposal.roadGeometry;
    const infoHTML = `
        <div class="proposal-info">
            <h4>Road Proposal</h4>
            <div class="proposal-hash">ID: ${proposal.proposalHash.substring(0, 8)}</div>
            <div class="metric-group">
                <div class="metric-label">Type:</div>
                <div class="metric-value">${proposal.type}</div>
            </div>
            <div class="metric-group">
                <div class="metric-label">Road Name:</div>
                <div class="metric-value">${roadGeometry.name}</div>
            </div>
            <div class="metric-group">
                <div class="metric-label">Road Width:</div>
                <div class="metric-value">${roadGeometry.width}m</div>
            </div>
            <div class="metric-group">
                <div class="metric-label">Author:</div>
                <div class="metric-value">${proposal.username}</div>
            </div>
            <div class="metric-group">
                <div class="metric-label">Date:</div>
                <div class="metric-value">${new Date(proposal.timestamp).toLocaleDateString()}</div>
            </div>
            <div class="metric-group">
                <div class="metric-label">Description:</div>
                <div class="metric-value">${proposal.description}</div>
            </div>
            ${proposal.offer ? `
                <div class="metric-group">
                    <div class="metric-label">Offer:</div>
                    <div class="metric-value">${proposal.offer}</div>
                </div>
            ` : ''}
        </div>
    `;

    // Show in parcel info panel (Info tab)
    const parcelInfoPanel = document.getElementById('parcel-info-panel');
    const infoContent = document.getElementById('info-content');

    if (parcelInfoPanel && infoContent) {
        infoContent.innerHTML = infoHTML;
        parcelInfoPanel.classList.add('visible');

        // Update the panel title
        const panelTitle = parcelInfoPanel.querySelector('h3');
        if (panelTitle) {
            panelTitle.textContent = 'Road Proposal Info';
        }
    }
}

// Handle clicks on proposal parcels
function handleProposalParcelClick(parcelId) {
    // Clear any currently selected single parcel to avoid conflicts
    multiParcelSelection.clearSingleParcelSelection();

    let proposals = proposalStorage.getProposalsForParcel(parcelId, { hydrateRoadAssets: false }).filter(p => p.status !== 'Executed');
    if (proposals.length === 0) {
        proposals = proposalStorage.getProposalsForParcel(parcelId).filter(p => p.status !== 'Executed');
    }

    if (proposals.length === 1) {
        const proposal = proposals[0];
        selectAndHighlightProposal(proposal.proposalHash, parcelId, true);
    } else if (proposals.length > 1) {
        // If there are multiple proposals, show a simple choice modal
        showProposalChoiceModal(proposals, parcelId);
    }
}

// Proposal highlighting state
window.currentlyHighlightedProposal = null;
window.selectedParcelInProposal = null;
window.isApplyingProposalHighlights = false;

// Apply proposal highlights (can be called repeatedly)
function applyProposalHighlights() {
    if (!window.currentlyHighlightedProposal) return;

    const proposal = window.currentlyHighlightedProposal;
    const shouldBlink = !!proposalHighlightState.pendingBlink;
    const { activeIds, primaryFeatures } = renderAppliedProposalHighlight(proposal, { blink: shouldBlink });

    proposalHighlightState.pendingBlink = false;
    proposalHighlightState.activeChildFeatures = primaryFeatures;
    proposalHighlightState.activeParentFeatures = Array.isArray(proposal?.roadProposal?.parentFeatures)
        ? proposal.roadProposal.parentFeatures
        : [];
    proposalHighlightState.activeProposalHash = proposal.proposalHash || null;

    updateParcelNumberFilterForProposal(activeIds);
}

// Clear proposal highlights
function clearProposalHighlights() {
    window.currentlyHighlightedProposal = null;
    window.selectedParcelInProposal = null;

    clearProposalPreviewLayers();
    clearProposalHoverLayers();
    updateParcelNumberFilterForProposal(null);
    proposalHighlightState.activeChildFeatures = [];
    proposalHighlightState.activeParentFeatures = [];
    proposalHighlightState.activeProposalHash = null;
    currentProposalPreviewHash = null;

    if (multiParcelSelection.syntheticParcelLayers && multiParcelSelection.syntheticParcelLayers.size > 0) {
        multiParcelSelection.syntheticParcelLayers.forEach(layer => {
            try {
                if (multiParcelSelection.syntheticLayerGroup && multiParcelSelection.syntheticLayerGroup.hasLayer(layer)) {
                    multiParcelSelection.syntheticLayerGroup.removeLayer(layer);
                } else if (typeof map !== 'undefined' && map && map.hasLayer(layer)) {
                    map.removeLayer(layer);
                }
            } catch (error) {
                console.warn('clearProposalHighlights: unable to remove synthetic layer', error);
            }
        });
        multiParcelSelection.syntheticParcelLayers.clear();
    }

    if (multiParcelSelection.syntheticLayerGroup) {
        try {
            if (multiParcelSelection.syntheticLayerGroup.getLayers().length === 0 && typeof map !== 'undefined' && map && map.hasLayer(multiParcelSelection.syntheticLayerGroup)) {
                map.removeLayer(multiParcelSelection.syntheticLayerGroup);
                multiParcelSelection.syntheticLayerGroup = null;
            }
        } catch (_) {
            multiParcelSelection.syntheticLayerGroup = null;
        }
    }
}

// Function to re-apply highlights after parcel layer updates
function reapplyProposalHighlights() {
    if (window.currentlyHighlightedProposal && !window.isApplyingProposalHighlights) {
        // Apply highlights immediately - no delay needed with proper event handling
        applyProposalHighlights();
    }
}

// Show a modal to choose between multiple proposals for a parcel
function showProposalChoiceModal(proposals, parcelId) {
    // Get parcel info for display
    const parcel = multiParcelSelection.findParcelById(parcelId);
    const parcelNumber = parcel?.feature?.properties?.BROJ_CESTICE || parcelId;

    // Remove any existing modal
    const existingModal = document.querySelector('.proposal-choice-modal');
    if (existingModal) {
        existingModal.remove();
    }

    // Create modal
    const modal = document.createElement('div');
    modal.className = 'proposal-choice-modal';
    modal.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background-color: rgba(0, 0, 0, 0.5);
        display: flex;
        justify-content: center;
        align-items: center;
        z-index: 10000;
    `;

    modal.innerHTML = `
        <div class="proposal-choice-content" style="
            background: white;
            border-radius: 8px;
            padding: 20px;
            max-width: 500px;
            width: 90%;
            max-height: 80vh;
            overflow-y: auto;
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
        ">
            <div class="proposal-choice-header" style="
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 20px;
                border-bottom: 1px solid #ddd;
                padding-bottom: 15px;
            ">
                <h3 style="margin: 0; color: #333;">Choose Proposal</h3>
                <button class="proposal-choice-close" onclick="closeProposalChoiceModal()" style="
                    background: none;
                    border: none;
                    font-size: 24px;
                    cursor: pointer;
                    color: #666;
                    padding: 0;
                    width: 30px;
                    height: 30px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                ">&times;</button>
            </div>
            <div class="proposal-choice-info" style="
                margin-bottom: 20px;
                padding: 10px;
                background-color: #f8f9fa;
                border-radius: 4px;
                color: #666;
                font-size: 14px;
            ">
                Parcel ${parcelNumber} is part of ${proposals.length} proposals. Choose which one to view:
            </div>
            <div class="proposal-choice-list">
                ${proposals.map(proposal => `
                    <div class="proposal-choice-item" onclick="selectProposalFromChoice('${proposal.proposalHash}', '${parcelId}')" style="
                        border: 1px solid #ddd;
                        border-radius: 6px;
                        padding: 15px;
                        margin-bottom: 10px;
                        cursor: pointer;
                        transition: all 0.2s ease;
                        border-left: 4px solid ${getProposalColor(proposal.proposalHash)};
                    " onmouseover="this.style.backgroundColor='#f8f9fa'; this.style.borderColor='#007bff';" 
                       onmouseout="this.style.backgroundColor='white'; this.style.borderColor='#ddd';">
                        <div class="proposal-choice-title" style="
                            font-weight: 600;
                            color: #333;
                            margin-bottom: 8px;
                            display: flex;
                            align-items: center;
                            gap: 10px;
                        ">
                            <div class="proposal-color-dot" style="
                                width: 12px;
                                height: 12px;
                                border-radius: 50%;
                                background-color: ${getProposalColor(proposal.proposalHash)};
                            "></div>
                            ${proposal.title}
                        </div>
                        <div class="proposal-choice-details" style="
                            color: #666;
                            font-size: 14px;
                            line-height: 1.4;
                        ">
                            <div>Author: ${proposal.author}</div>
                            ${proposal.offer ? `<div>Offer: €${proposal.offer.toLocaleString('hr-HR')}</div>` : ''}
                            <div>Parcels: ${proposal.parcelIds.length}</div>
                            <div>Accepted: ${proposal.acceptedParcelIds ? proposal.acceptedParcelIds.length : 0}/${proposal.parcelIds.length}</div>
                        </div>
                    </div>
                `).join('')}
            </div>
        </div>
    `;

    document.body.appendChild(modal);

    // Close modal when clicking outside
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            closeProposalChoiceModal();
        }
    });

    // Close modal with Escape key
    const handleEscape = (e) => {
        if (e.key === 'Escape') {
            closeProposalChoiceModal();
            document.removeEventListener('keydown', handleEscape);
        }
    };
    document.addEventListener('keydown', handleEscape);
}

// Close the proposal choice modal
function closeProposalChoiceModal() {
    const modal = document.querySelector('.proposal-choice-modal');
    if (modal) {
        modal.remove();
    }
}

// Select a proposal from the choice modal
function selectProposalFromChoice(proposalHash, parcelId) {
    closeProposalChoiceModal();
    selectAndHighlightProposal(proposalHash, parcelId, true);
}

// Unified function to select and highlight a proposal with proper sequencing
function selectAndHighlightProposal(proposalHash, parcelId, shouldCenter = false, showDetails = true) {
    const proposal = proposalStorage.getProposal(proposalHash);
    if (!proposal) {
        console.error('Proposal not found:', proposalHash);
        updateStatus('Error: Proposal not found');
        return;
    }

    proposalListState.selectedHash = proposalHash;

    // Clear any existing proposal highlights
    clearProposalHighlights();

    // Set the new state for the proposal and the selected parcel
    window.currentlyHighlightedProposal = proposal;
    window.selectedParcelInProposal = parcelId;

    // Show proposal info immediately (no visual changes yet)
    if (showDetails) {
        showProposalInfo(proposal, parcelId);
    } else {
        hideProposalDetailsPanel();
    }

    // Update status
    updateStatus(`Selected proposal "${proposal.title}" (contains ${proposal.parcelIds.length} parcels)`);

    // If we will center the map, suppress overlay reapplication during movement
    if (shouldCenter && !isCameraMovementSuppressed()) {
        window.isApplyingProposalHighlights = true;
    }

    // Refresh base proposal styling across all parcels to reflect the newly selected proposal
    // This ensures the previous proposal regains hatched styling and the new one uses transparent stroke
    if (typeof updateProposalLayer === 'function') {
        updateProposalLayer();
    }

    if (shouldCenter) {
        // Center map first, then apply overlays when movement is complete
        const parcels = proposal.parcelIds.map(id => multiParcelSelection.findParcelById(id))
            .filter(p => {
                if (!p) return false;
                if (typeof p.getBounds !== 'function') return false;
                try {
                    const center = p.getBounds().getCenter();
                    if (!center || isNaN(center.lat) || isNaN(center.lng)) return false;
                    if (Math.abs(center.lat) > 90 || Math.abs(center.lng) > 180) return false;
                    return true;
                } catch (e) {
                    return false;
                }
            });
        if (parcels.length > 0) {
            // Calculate bounds of all parcels in the proposal
            const bounds = L.latLngBounds();
            parcels.forEach(parcel => {
                bounds.extend(parcel.getBounds());
            });

            // Listen for moveend event to know when centering is complete
            const onMoveEnd = () => {
                map.off('moveend', onMoveEnd); // Remove listener
                window.isApplyingProposalHighlights = false;
                // Apply overlays after centering is complete
                applyProposalHighlights();
            };

            map.on('moveend', onMoveEnd);

            // Start the map centering
            map.fitBounds(bounds, { padding: [50, 50] });
        } else {
            // No parcels found, just apply overlays immediately
            window.isApplyingProposalHighlights = false;
            applyProposalHighlights();
        }
    } else {
        // Not centering; overlays already reapplied by updateProposalLayer via reapplyProposalHighlights
        // Nothing else to do here
    }

    // Safety: if proposal UI isn't actually visible, clear any proposal-specific visuals
    try {
        if (typeof isProposalUIActive === 'function' && !isProposalUIActive()) {
            clearProposalHighlights();
            clearProposalInfoHoverOverlay();
        }
    } catch (_) { }
}

function focusProposalDetails(proposalHash, options = {}) {
    if (typeof proposalStorage === 'undefined') return false;
    const proposal = proposalStorage.getProposal(proposalHash);
    if (!proposal) return false;

    const parcelIds = Array.isArray(proposal.parcelIds) ? proposal.parcelIds : [];
    const fallbackParcelId = options.parcelId || (parcelIds.length > 0 ? parcelIds[0] : null);

    selectAndHighlightProposal(
        proposalHash,
        fallbackParcelId,
        options.centerOnProposal !== false,
        options.showDetails !== false
    );
    return true;
}

function applyProposalToMap(proposalHash, options = {}) {
    if (!proposalHash || typeof ProposalManager === 'undefined' || typeof ProposalManager.applyProposal !== 'function') {
        return false;
    }
    const applied = ProposalManager.applyProposal(proposalHash);
    if (applied === false) {
        return false;
    }

    if (options.revealDetails !== false && typeof proposalStorage !== 'undefined') {
        const proposal = proposalStorage.getProposal(proposalHash);
        if (proposal) {
            const parcelIds = Array.isArray(proposal.parcelIds) ? proposal.parcelIds : [];
            const fallbackParcelId = options.parcelId || (parcelIds.length > 0 ? parcelIds[0] : null);
            focusProposalDetails(proposalHash, {
                parcelId: fallbackParcelId,
                centerOnProposal: options.centerOnProposal !== false,
                showDetails: options.showDetails !== false
            });
        }
    }

    return true;
}

function removeProposalFromMap(proposalHash, options = {}) {
    if (!proposalHash || typeof ProposalManager === 'undefined' || typeof ProposalManager.unapplyProposal !== 'function') {
        return false;
    }
    const unapplied = ProposalManager.unapplyProposal(proposalHash);
    if (unapplied === false) {
        return false;
    }

    if (options.refreshDetails !== false && typeof proposalStorage !== 'undefined') {
        const proposal = proposalStorage.getProposal(proposalHash);
        if (proposal && window.currentlyHighlightedProposal && window.currentlyHighlightedProposal.proposalHash === proposalHash) {
            window.currentlyHighlightedProposal = proposal;
            showProposalInfo(proposal, window.selectedParcelInProposal);
            applyProposalHighlights();
        }
    }

    return true;
}

window.focusProposalDetails = focusProposalDetails;
window.applyProposalToMap = applyProposalToMap;
window.removeProposalFromMap = removeProposalFromMap;



// Override the parcel click when proposals are shown
let originalOnParcelClick = null;

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
function proposalAwareParcelClickHandler(e) {
    // Pass-through to the original click handler to ensure parcels are always selectable
    if (!originalOnParcelClick || typeof originalOnParcelClick !== 'function') {
        if (typeof window !== 'undefined' && typeof window.onParcelClick === 'function') {
            originalOnParcelClick = window.onParcelClick;
        }
    }
    if (originalOnParcelClick && typeof originalOnParcelClick === 'function') {
        originalOnParcelClick.call(this, e);
    }
}

// Show proposal info panel
function showProposalInfo(proposal, currentParcelId = null) {
    const parcels = proposal.parcelIds.map(id => multiParcelSelection.findParcelById(id))
        .filter(p => {
            if (!p) return false;
            if (typeof p.getBounds !== 'function') return false;
            try {
                const center = p.getBounds().getCenter();
                if (!center || isNaN(center.lat) || isNaN(center.lng)) return false;
                if (Math.abs(center.lat) > 90 || Math.abs(center.lng) > 180) return false;
                return true;
            } catch (e) {
                return false;
            }
        });
    const totalArea = parcels.reduce((sum, parcel) =>
        sum + (parcel.feature.properties.calculatedArea || 0), 0);

    // Determine current parcel - try passed parameter first, then global selectedParcelId
    const ownerAcceptanceSummary = buildProposalOwnerAcceptanceSummary(proposal);

    let ownerAcceptanceStatusHtml = '';
    if (ownerAcceptanceSummary.totalOwners > 0) {
        try {
            const circlesHtml = ownerAcceptanceSummary.entries.map(entry => {
                if (!entry) return '';
                const parts = [];
                if (entry.displayName) parts.push(entry.displayName);
                if (entry.shareText) parts.push(entry.shareText);
                if (entry.parcelId) parts.push(`Parcel ${entry.parcelId}`);
                parts.push(entry.accepted ? 'Accepted' : 'Pending');
                const title = parts.join(' • ');
                const safeTitle = typeof escapeHtml === 'function' ? escapeHtml(title) : title;
                return `<div class="acceptance-circle ${entry.accepted ? 'accepted' : 'pending'}" title="${safeTitle}"></div>`;
            }).join('');
            ownerAcceptanceStatusHtml = `
            <div class="proposal-acceptance-status owner">
                <div class="acceptance-label">Owner Acceptance Status:</div>
                <div class="acceptance-circles">${circlesHtml}</div>
            </div>`;
        } catch (error) {
            console.warn('showProposalInfo: failed to build owner acceptance summary', error);
        }
    }

    // Update the proposal details panel title
    const proposalPanelTitle = document.getElementById('proposal-details-title');
    if (proposalPanelTitle) {
        proposalPanelTitle.textContent = 'Proposal Details';
    }

    // Check proposal category for map application controls
    // Ensure we have the full proposal from storage if needed
    let fullProposal = proposal;
    if (proposal.proposalHash && typeof proposalStorage !== 'undefined' && typeof proposalStorage.getProposal === 'function') {
        try {
            const stored = proposalStorage.getProposal(proposal.proposalHash);
            if (stored) {
                fullProposal = stored;
            }
        } catch (_) { }
    }

    const {
        isRoadProposal,
        isBuildingProposal,
        isStructureProposal,
        isReparcellizationProposal,
        supportsMapToggle
    } = computeProposalCategoryFlags(fullProposal, { fallbackProposal: proposal });

    const appliedState = isProposalApplied(fullProposal);
    const lifecycleKey = getProposalLifecycleKey(fullProposal);
    const statusBadgeClass = getProposalLifecycleClass(lifecycleKey);
    const statusBadgeLabel = getProposalLifecycleLabel(lifecycleKey);
    const mapStatusBadgeClass = appliedState ? 'applied' : 'not-applied';
    const mapStatusBadgeLabel = appliedState ? 'Applied' : 'Not Applied';

    let actionButtons = '';
    if (supportsMapToggle) {
        const proposalHash = fullProposal.proposalHash || proposal.proposalHash;
        const buttonLabel = appliedState ? 'Remove from map' : 'Apply to map';
        const iconClass = appliedState ? 'fa-eye-slash' : 'fa-check';
        const buttonClass = appliedState ? 'btn btn-warning' : 'btn btn-success';
        const handler = appliedState
            ? `removeProposalFromMap('${proposalHash}')`
            : `applyProposalToMap('${proposalHash}')`;
        actionButtons = `
            <div class="proposal-actions" style="margin: 15px 0;">
                <button class="${buttonClass}" onclick="${handler}" style="width: 100%;">
                    <i class="fas ${iconClass}"></i> ${buttonLabel}
                </button>
            </div>
        `;
    }

    const shareButtonHtml = `
        <div class="proposal-actions share-proposal-action">
            <button class="btn btn-outline-primary btn-share-proposal" onclick="shareSingleProposal('${proposal.proposalHash}')">
                <i class="fas fa-share-alt"></i> Share Proposal
            </button>
        </div>
    `;

    const content = `
        <div class="proposal-info">
            <div class="proposal-header">
                <div class="proposal-title-row">
                    <h4>${proposal.title}${isRoadProposal ? ' (Road)' : ''}</h4>
                    <div class="proposal-badge-group">
                        <div class="proposal-status ${statusBadgeClass}">${statusBadgeLabel}</div>
                        <div class="proposal-application-status ${mapStatusBadgeClass}">
                            ${mapStatusBadgeLabel}
                        </div>
                    </div>
                </div>
                <div class="proposal-hash">ID: ${typeof proposal.proposal_id === 'number' ? `#${proposal.proposal_id} · ` : ''}${proposal.proposalHash}</div>
            </div>
            ${actionButtons}
            <div class="proposal-acceptance-status">
                <div class="acceptance-label">Parcel Acceptance Status:</div>
                <div class="acceptance-circles">
                    ${(() => {
            const total = proposal.parcelIds.length;
            const accepted = proposal.acceptedParcelIds ? proposal.acceptedParcelIds.length : 0;
            let html = '';
            // Add green circles for accepted parcels
            for (let i = 0; i < accepted; i++) {
                html += '<div class="acceptance-circle accepted" title="Accepted"></div>';
            }
            // Add grey circles for pending parcels
            for (let i = 0; i < total - accepted; i++) {
                html += '<div class="acceptance-circle pending" title="Pending"></div>';
            }
            return html;
        })()}
                </div>
            </div>
            ${ownerAcceptanceStatusHtml}

            <hr style="border: 0; height: 1px; background-color: #ddd; margin: 15px 0;">
            <div class="metric-group">
                <div class="metric-label">Author:</div>
                <div class="metric-value author-with-avatar">
                    ${(() => {
            // Find the agent with matching name
            if (typeof agentStorage !== 'undefined') {
                const agents = agentStorage.getAllAgents();
                const agent = agents.find(a => a.name === proposal.author);
                if (agent && typeof getAvatarImagePath === 'function') {
                    return `
                                        <img src="${getAvatarImagePath(agent.avatarIndex)}" class="author-avatar" style="width: 24px; height: 24px; border-radius: 50%; border: 2px solid #007bff; margin-right: 8px; vertical-align: middle;">
                                        <a href="#" data-agent-id="${agent.id}" class="agent-link agent-link-clickable" style="text-decoration: none; color: #007bff; font-weight: 500;">${proposal.author}</a>
                                    `;
                }
            }
            return proposal.author;
        })()}
                </div>
            </div>
            <div class="metric-group">
                <span class="metric-label">Description:</span> <span class="metric-value">${proposal.description}</span>
            </div>
            ${proposal.offer ? `
            <div class="metric-group">
                <span class="metric-label">Offer:</span> <span class="metric-value">€${proposal.offer.toLocaleString('hr-HR')}</span>
            </div>
            ` : ''}
            <div class="metric-group">
                <span class="metric-label">Parcels in Proposal:</span> <span class="metric-value">${proposal.parcelIds.length}</span>
            </div>
            <div class="metric-group">
                <span class="metric-label">Owners in Proposal:</span> <span class="metric-value">${ownerAcceptanceSummary.totalOwners}</span>
            </div>
            <div class="metric-group">
                <span class="metric-label">Total Area:</span> <span class="metric-value">${Math.round(totalArea).toLocaleString('hr-HR')} m²</span>
            </div>
            <div class="metric-group">
                <span class="metric-label">Created:</span> <span class="metric-value">${new Date(proposal.createdAt).toLocaleDateString()}</span>
            </div>
            <hr style="border: 0; height: 1px; background-color: #ddd; margin: 10px 0;">
            <div class="metric-group">
                <div class="metric-label">Ancestors (Parcels):</div>
                <div class="proposal-parcels-list">
                    ${parcels.map(parcel => {
            const parcelId = parcel.feature.properties.CESTICA_ID;
            const hasAccepted = proposal.acceptedParcelIds && proposal.acceptedParcelIds.includes(parcelId.toString());

            // Get parcel owner information
            const ownerId = PersistentStorage.getItem(`parcel_${parcelId}_owner`);
            let ownerAvatarHtml = '';

            if (ownerId && typeof agentStorage !== 'undefined') {
                const owner = agentStorage.getAgent(ownerId);
                if (owner && typeof getAvatarImagePath === 'function') {
                    ownerAvatarHtml = `<img src="${getAvatarImagePath(owner.avatarIndex)}" class="parcel-owner-avatar" style="width: 24px; height: 24px; border-radius: 50%; border: 2px solid #007bff; margin-right: 8px;" title="Owner: ${owner.name}">`;
                }
            }

            const ownerAcceptanceHtml = (typeof buildOwnerAcceptanceSectionHtml === 'function')
                ? buildOwnerAcceptanceSectionHtml(proposal, parcelId, { compact: true, skipParcelPanelFocus: true })
                : '';

            return `
                            <div class="proposal-parcel-item" data-parcel-id="${parcelId}" onclick="handleProposalParcelClick('${parcelId}', event)" style="display: flex; flex-direction: column; gap:6px; padding: 8px; border: 1px solid #ddd; margin-bottom: 5px; border-radius: 4px; cursor: pointer; ${hasAccepted ? 'background-color: #f8fff8;' : ''}" title="Click to view parcel details">
                                <div class="parcel-info" style="display: flex; align-items: center; justify-content: space-between;">
                                    <div style="display:flex; align-items:center; gap:8px;">
                                        ${ownerAvatarHtml}
                                        <div>
                                            <span class="parcel-number" style="font-weight: 500;">Parcel ${parcel.feature.properties.BROJ_CESTICE}</span>
                                            <span style="margin: 0 4px; color: #999;">·</span>
                                            ${hasAccepted ?
                    `<span style="color: #28a745; font-size: 12px; font-weight: 500;">✓ Accepted</span>` :
                    `<span style="color: #666; font-size: 12px;">Pending</span>`
                }
                                        </div>
                                    </div>
                                </div>
                                ${ownerAcceptanceHtml ? `<div class="parcel-owner-acceptance" onclick="event.stopPropagation(); event.preventDefault(); return false;">${ownerAcceptanceHtml}</div>` : ''}
                            </div>
                        `;
        }).join('')}
                </div>
            </div>
            
            <!-- Ancestors (Proposals) Section -->
            <div class="metric-group">
                <div class="metric-label">Ancestors (Proposals):</div>
                <div class="proposal-ancestors-list">
                    ${(() => {
            if (typeof ProposalManager !== 'undefined') {
                const ancestors = [];
                proposal.parcelIds.forEach(parcelId => {
                    const parcelAncestors = ProposalManager._getParcelAncestors(parcelId);
                    parcelAncestors.forEach(ancestorHash => {
                        if (!ancestors.includes(ancestorHash)) {
                            ancestors.push(ancestorHash);
                        }
                    });
                });

                if (ancestors.length > 0) {
                    return ancestors.map(ancestorHash => {
                        const ancestorData = proposalStorage.getProposal(ancestorHash);
                        if (ancestorData) {
                            return `<div class="ancestor-item" data-proposal-hash="${ancestorData.proposalHash || ancestorHash}" tabindex="0" style="padding: 5px; border: 1px solid #ddd; margin: 2px 0; border-radius: 3px; cursor: pointer;">
                                            <strong>${ancestorData.title}</strong> (${ancestorData.type || 'proposal'})
                                        </div>`;
                        }
                        return null;
                    }).filter(Boolean).join('');
                }
            }
            return '<p style="color: #666; font-style: italic;">No ancestor proposals found.</p>';
        })()}
                </div>
            </div>
            
            <!-- Descendants Section -->
            <div class="metric-group">
                <div class="metric-label">Descendants (parcels):</div>
                <div class="proposal-descendants-list">
                    ${(() => {
            if (typeof ProposalManager !== 'undefined') {
                const descendants = ProposalManager._getProposalDescendants(proposal.proposalHash);
                if (descendants.length > 0) {
                    return descendants.map(descendant => {
                        const descendantData = proposalStorage.getProposal(descendant);
                        if (descendantData) {
                            const descendantHash = descendantData.proposalHash || descendant;
                            return `<div class="descendant-item" data-descendant-type="proposal" data-proposal-hash="${descendantHash}" tabindex="0" style="padding: 5px; border: 1px solid #ddd; margin: 2px 0; border-radius: 3px; cursor: pointer;">
                                            <strong>${descendantData.title}</strong> (${descendantData.type || 'proposal'})
                                        </div>`;
                        } else {
                            let parcelNumber = null;
                            let isRoad = false;
                            let roadName = null;
                            const descendantKey = (descendant !== undefined && descendant !== null) ? String(descendant) : '';
                            try {
                                const layer = multiParcelSelection.findParcelById(descendantKey);
                                if (layer && layer.feature?.properties) {
                                    parcelNumber = layer.feature.properties.BROJ_CESTICE || parcelNumber;
                                    isRoad = isRoad || !!layer.feature.properties.isRoad;
                                    roadName = roadName || layer.feature.properties.roadName || null;
                                }
                            } catch (_) { }

                            if (!parcelNumber) {
                                try {
                                    const propsStr = PersistentStorage.getItem(`parcel_${descendantKey}_properties`);
                                    if (propsStr) {
                                        const props = JSON.parse(propsStr);
                                        parcelNumber = props?.BROJ_CESTICE || parcelNumber;
                                        isRoad = isRoad || !!props?.isRoad;
                                        roadName = roadName || props?.roadName || null;
                                    }
                                } catch (_) { }
                            }

                            const label = parcelNumber ? `Parcel ${parcelNumber}` : `Parcel ${descendantKey}`;
                            const roadSuffix = isRoad ? (roadName ? ` • Road: ${roadName}` : ' • Road') : '';
                            return `<div class="descendant-item" data-descendant-type="parcel" data-parcel-id="${descendantKey}" tabindex="0" style="padding: 5px; border: 1px solid #ddd; margin: 2px 0; border-radius: 3px; cursor: pointer;">
                                            ${label}${roadSuffix}
                                        </div>`;
                        }
                    }).join('');
                }
            }
            return '<p style="color: #666; font-style: italic;">No descendant parcels found.</p>';
        })()}
                </div>
            </div>
            ${shareButtonHtml}
        </div>
    `;

    document.getElementById('proposal-details-content').innerHTML = content;

    // Add hover-based map highlighting for parcels listed in the proposal details
    try {
        // Clear any previous hover overlay when rendering
        clearProposalInfoHoverOverlay();
        const proposalDetailsContainer = document.getElementById('proposal-details-content');
        const proposalParcelItems = proposalDetailsContainer
            ? proposalDetailsContainer.querySelectorAll('.proposal-parcel-item[data-parcel-id]')
            : [];
        proposalParcelItems.forEach(item => {
            const hoveredParcelId = item.getAttribute('data-parcel-id');
            if (!hoveredParcelId) return;
            item.addEventListener('mouseenter', () => {
                try {
                    showProposalInfoHoverOverlay(hoveredParcelId);
                } catch (_) { }
            });
            item.addEventListener('mouseleave', () => {
                try {
                    clearProposalInfoHoverOverlay();
                } catch (_) { }
            });
        });

        const descendantItems = proposalDetailsContainer
            ? proposalDetailsContainer.querySelectorAll('.descendant-item[data-descendant-type]')
            : [];
        descendantItems.forEach(item => {
            item.addEventListener('mouseenter', () => {
                try {
                    handleDescendantItemHover(item);
                } catch (_) { }
            });
            item.addEventListener('mouseleave', () => {
                try {
                    clearProposalHoverLayers();
                } catch (_) { }
            });
            item.addEventListener('focus', () => {
                try {
                    handleDescendantItemHover(item);
                } catch (_) { }
            });
            item.addEventListener('blur', () => {
                try {
                    clearProposalHoverLayers();
                } catch (_) { }
            });
            item.addEventListener('click', event => {
                event.preventDefault();
                event.stopPropagation();
                try {
                    handleDescendantItemClick(item);
                } catch (_) { }
            });
            item.addEventListener('keydown', event => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    event.stopPropagation();
                    try {
                        handleDescendantItemClick(item);
                    } catch (_) { }
                }
            });
        });

        const ancestorItems = proposalDetailsContainer
            ? proposalDetailsContainer.querySelectorAll('.ancestor-item[data-proposal-hash]')
            : [];
        ancestorItems.forEach(item => {
            item.addEventListener('mouseenter', () => {
                try {
                    handleAncestorItemHover(item);
                } catch (_) { }
            });
            item.addEventListener('mouseleave', () => {
                try {
                    clearProposalHoverLayers();
                } catch (_) { }
            });
            item.addEventListener('focus', () => {
                try {
                    handleAncestorItemHover(item);
                } catch (_) { }
            });
            item.addEventListener('blur', () => {
                try {
                    clearProposalHoverLayers();
                } catch (_) { }
            });
            item.addEventListener('click', event => {
                event.preventDefault();
                event.stopPropagation();
                try {
                    handleAncestorItemClick(item);
                } catch (_) { }
            });
            item.addEventListener('keydown', event => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    event.stopPropagation();
                    try {
                        handleAncestorItemClick(item);
                    } catch (_) { }
                }
            });
        });
    } catch (_) { }

    document.getElementById('proposal-details-panel').classList.add('visible');

    // Setup click listeners for any clickable links in the proposal info
    if (typeof setupGameLogClickListeners === 'function') {
        setupGameLogClickListeners();
    }
}


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

function handleDescendantItemHover(element) {
    if (!element) return;
    const type = element.getAttribute('data-descendant-type');
    if (type === 'proposal') {
        const proposalHash = element.getAttribute('data-proposal-hash');
        if (proposalHash) {
            highlightProposalHoverByHash(proposalHash, {
                color: '#4DB6AC',
                weight: 4,
                dashArray: '4 4',
                showLabels: true,
                includeParents: false
            });
        }
    } else if (type === 'parcel') {
        const parcelId = element.getAttribute('data-parcel-id');
        if (parcelId) {
            highlightParcelHover(parcelId, {
                color: '#64B5F6',
                weight: 5,
                dashArray: '',
                showLabels: true
            });
        }
    }
}

function handleDescendantItemClick(element) {
    if (!element) return;
    clearProposalHoverLayers();

    const type = element.getAttribute('data-descendant-type');
    if (type === 'proposal') {
        const proposalHash = element.getAttribute('data-proposal-hash');
        if (!proposalHash) return;
        const descendantProposal = proposalStorage.getProposal(proposalHash);
        if (!descendantProposal) return;
        const parcelIds = Array.isArray(descendantProposal.parcelIds) ? descendantProposal.parcelIds : [];
        const fallbackParcel = parcelIds.length > 0 ? parcelIds[0] : null;
        selectAndHighlightProposal(proposalHash, fallbackParcel, true);
    } else if (type === 'parcel') {
        const parcelId = element.getAttribute('data-parcel-id');
        if (!parcelId) return;
        focusParcelInMap(parcelId);
        highlightParcelHover(parcelId, {
            color: '#64B5F6',
            weight: 5,
            dashArray: '',
            showLabels: true
        });
    }
}

function handleAncestorItemHover(element) {
    if (!element) return;
    const proposalHash = element.getAttribute('data-proposal-hash');
    if (!proposalHash) return;
    highlightProposalHoverByHash(proposalHash, {
        color: '#FFB74D',
        weight: 4,
        dashArray: '6 3',
        showLabels: true,
        includeParents: false
    });
}

function handleAncestorItemClick(element) {
    if (!element) return;
    clearProposalHoverLayers();

    const proposalHash = element.getAttribute('data-proposal-hash');
    if (!proposalHash) return;
    const ancestorProposal = proposalStorage.getProposal(proposalHash);
    if (!ancestorProposal) return;
    const parcelIds = Array.isArray(ancestorProposal.parcelIds) ? ancestorProposal.parcelIds : [];
    const fallbackParcel = parcelIds.length > 0 ? parcelIds[0] : null;
    selectAndHighlightProposal(proposalHash, fallbackParcel, true);
}



/**
 * Return to parcel info when clicking a parcel in the proposal details
 * @param {string} parcelId - The parcel ID to show info for
 */
function handleProposalParcelClick(parcelId, event) {
    if (event) {
        let node = event.target || event.srcElement || null;
        if (node && node.nodeType === Node.TEXT_NODE) {
            node = node.parentElement;
        }

        let hasOwnerAcceptanceTarget = false;
        while (node && node !== event.currentTarget) {
            if (node.classList && (
                node.classList.contains('owner-acceptance-row') ||
                node.classList.contains('owner-acceptance-list') ||
                node.classList.contains('owner-actions') ||
                node.classList.contains('owner-share') ||
                node.classList.contains('owner-identity') ||
                node.classList.contains('parcel-owner-acceptance')
            )) {
                hasOwnerAcceptanceTarget = true;
                break;
            }
            node = node.parentElement;
        }

        if (hasOwnerAcceptanceTarget) {
            event.stopPropagation();
            event.preventDefault();
            return false;
        }

        event.stopPropagation();
        event.preventDefault();
    }

    returnToParcelInfo(parcelId, event);
    return false;
}

function returnToParcelInfo(parcelId, event) {
    // Prevent event bubbling to avoid triggering parcel click handlers
    if (event) {
        event.stopPropagation();
        event.preventDefault();
    }
    // 1) Close Proposal UI (details/modal/list) and leave proposal mode
    if (typeof hideProposalDetailsPanel === 'function') hideProposalDetailsPanel(true);
    if (typeof closeProposalList === 'function') closeProposalList();
    if (typeof hideProposalCompareModal === 'function') hideProposalCompareModal();
    if (typeof closeProposalInfoDialog === 'function') closeProposalInfoDialog();

    // 2) Disable proposal mode by unchecking the checkbox and updating layers immediately
    const showProposalsCheckbox = document.getElementById('showProposalsCheckbox');
    if (showProposalsCheckbox && showProposalsCheckbox.checked) {
        showProposalsCheckbox.checked = false;
        if (typeof updateProposalLayer === 'function') {
            updateProposalLayer();
        }
    }

    // 3) Exit Parcel Block mode fully (uncheck, collapse, and clear related UI)
    const parcelBlocksCheckbox = document.getElementById('parcelBlocksCheckbox');
    if (parcelBlocksCheckbox && parcelBlocksCheckbox.checked) {
        parcelBlocksCheckbox.checked = false;
        if (typeof toggleAccordion === 'function') {
            toggleAccordion(parcelBlocksCheckbox);
        } else {
            if (typeof hideBlocksList === 'function') hideBlocksList();
            if (typeof hideBlockInfo === 'function') hideBlockInfo();
            if (typeof updateBlockLayer === 'function') updateBlockLayer();
        }
    }

    // 4) Select the parcel and show Parcel Info immediately (switch to parcel mode)
    if (typeof selectParcel === 'function') {
        selectParcel(parcelId);
    }
}

// Make returnToParcelInfo globally available
window.returnToParcelInfo = returnToParcelInfo;

/**
 * Hide the proposal details panel
 */
function hideProposalDetailsPanel(clearHighlights = false) {
    const proposalPanel = document.getElementById('proposal-details-panel');
    if (proposalPanel) {
        proposalPanel.classList.remove('visible');
    }
    // Clear hover overlay when closing
    try { clearProposalInfoHoverOverlay(); } catch (_) { }

    // Clear any proposal highlights when closing
    if (clearHighlights && typeof clearProposalHighlights === 'function') {
        clearProposalHighlights();
    }
}

// Make hideProposalDetailsPanel globally available
window.hideProposalDetailsPanel = hideProposalDetailsPanel;

const DEFAULT_PROPOSAL_TYPE = 'Square';
let currentProposalTool = null;

function getSelectedProposalTool() {
    return currentProposalTool;
}

function setProposalModalDimmed(dimmed) {
    const modal = document.querySelector('.proposal-modal');
    if (!modal) return;
    if (dimmed) {
        modal.classList.add('dimmed-behind-overlay');
    } else {
        modal.classList.remove('dimmed-behind-overlay');
    }
}

function getCurrentParcelSelectionContext() {
    const context = { layers: [], ids: [] };
    try {
        if (typeof multiParcelSelection !== 'undefined' && multiParcelSelection && multiParcelSelection.selectedParcels && multiParcelSelection.selectedParcels.size > 0) {
            context.ids = Array.from(multiParcelSelection.selectedParcels).map(id => id.toString());
            if (typeof multiParcelSelection.getSelectedParcels === 'function') {
                context.layers = (multiParcelSelection.getSelectedParcels() || []).filter(Boolean);
            } else if (typeof multiParcelSelection.findParcelById === 'function') {
                context.layers = context.ids.map(id => multiParcelSelection.findParcelById(id)).filter(Boolean);
            }
        } else if (typeof selectedParcelId !== 'undefined' && selectedParcelId && currentParcel && currentParcel.layer) {
            context.ids = [selectedParcelId.toString()];
            context.layers = [currentParcel.layer];
        }
    } catch (e) {
        console.warn('Failed to resolve parcel selection context', e);
    }
    return context;
}

function formatParcelSelectionLabel(parcelIds = []) {
    if (!parcelIds || parcelIds.length === 0) return 'Selected Parcels';
    if (parcelIds.length === 1) {
        return `Parcel ${parcelIds[0]}`;
    }
    return `${parcelIds.length} Parcels`;
}

function setProposalType(type) {
    const effectiveType = type || DEFAULT_PROPOSAL_TYPE;
    const input = document.getElementById('proposalType');
    if (input) {
        input.value = effectiveType;
    }
    const buttons = document.querySelectorAll('.proposal-tool-button');
    let resolvedTool = null;
    buttons.forEach(btn => {
        const btnType = btn.getAttribute('data-proposal-type');
        if (btnType === effectiveType) {
            btn.classList.add('selected');
            resolvedTool = btn.getAttribute('data-proposal-tool') || null;
        } else {
            btn.classList.remove('selected');
        }
    });
    currentProposalTool = resolvedTool;
}

function setProposalMainType(type) {
    const buttons = document.querySelectorAll('.proposal-type-button');
    buttons.forEach(btn => {
        const btnType = btn.getAttribute('data-proposal-main-type');
        if (btnType === type) {
            btn.classList.add('selected');
        } else {
            btn.classList.remove('selected');
        }
    });

    const input = document.getElementById('proposalMainType');
    if (input) {
        input.value = type || 'Purchase';
    }

    const goalGroup = document.getElementById('proposalGoalGroup');
    const algorithmGroup = document.getElementById('reparcellizationAlgorithmGroup');
    const typeHint = document.getElementById('proposalTypeHint');
    const isReparcellization = type === 'Reparcellization';

    if (goalGroup) {
        goalGroup.style.display = isReparcellization ? 'none' : '';
    }
    if (algorithmGroup) {
        algorithmGroup.style.display = isReparcellization ? '' : 'none';
    }

    const toolButtons = document.querySelectorAll('.proposal-tool-button');
    toolButtons.forEach(btn => {
        if (isReparcellization) {
            btn.classList.remove('selected');
            btn.setAttribute('disabled', 'disabled');
        } else {
            btn.removeAttribute('disabled');
        }
    });

    if (isReparcellization) {
        currentProposalTool = null;
        const typeInput = document.getElementById('proposalType');
        if (typeInput) {
            typeInput.value = 'Reparcellization';
        }
    } else if (!currentProposalTool) {
        setProposalType(DEFAULT_PROPOSAL_TYPE);
    }
}

function handleReparcellizationAlgorithmClick(algorithmKey = 'sweep-line') {
    const normalizedKey = algorithmKey || 'sweep-line';
    const buttons = document.querySelectorAll('.reparcel-alg-button');
    let targetButton = null;
    buttons.forEach(btn => {
        if (btn.getAttribute('data-reparcel-algorithm') === normalizedKey) {
            targetButton = btn;
            btn.classList.add('selected');
        } else {
            btn.classList.remove('selected');
        }
    });

    if (targetButton && targetButton.disabled) {
        return;
    }

    currentProposalTool = 'reparcellization';
    const typeInput = document.getElementById('proposalType');
    if (typeInput) {
        typeInput.value = 'Reparcellization';
    }

    if (typeof openReparcellizationModal === 'function') {
        openReparcellizationModal({ algorithm: normalizedKey });
    } else {
        console.warn('Reparcellization modal is not yet available.');
    }
}

function resolveProposalAuthorName() {
    let authorName = '';
    if (typeof getCurrentUsername === 'function') {
        try {
            authorName = getCurrentUsername() || '';
        } catch (e) {
            console.warn('Failed to resolve username for proposal author', e);
        }
    }
    if (!authorName && typeof getCurrentUserAgent === 'function') {
        try {
            const agent = getCurrentUserAgent();
            if (agent && agent.name) {
                authorName = agent.name;
            }
        } catch (e) {
            console.warn('Failed to resolve agent for proposal author', e);
        }
    }
    return authorName;
}

function populateProposalAuthorUI({ inputId = 'proposalAuthor', avatarId = 'proposalAuthorAvatar' } = {}) {
    const input = document.getElementById(inputId);
    const avatarImg = document.getElementById(avatarId);
    const authorName = resolveProposalAuthorName();

    if (input) {
        input.value = authorName;
        input.disabled = true;
    }

    if (avatarImg) {
        let avatarApplied = false;
        if (typeof getCurrentUserAgent === 'function' && typeof getAvatarImagePath === 'function') {
            try {
                const agent = getCurrentUserAgent();
                if (agent && typeof agent.avatarIndex !== 'undefined') {
                    const src = getAvatarImagePath(agent.avatarIndex);
                    if (src) {
                        avatarImg.src = src;
                        avatarImg.alt = `${agent.name || authorName || 'Author'} avatar`;
                        avatarImg.style.display = 'block';
                        avatarApplied = true;
                    }
                }
            } catch (e) {
                console.warn('Failed to set proposal author avatar', e);
            }
        }
        if (!avatarApplied) {
            avatarImg.style.display = 'none';
        }
    }

    return authorName;
}

function getProposalAuthorValue(inputId = 'proposalAuthor') {
    const input = document.getElementById(inputId);
    const value = (input && typeof input.value === 'string') ? input.value.trim() : '';
    return value || resolveProposalAuthorName();
}

function buildGeometryFromParcels(parcelLayers = []) {
    if (!parcelLayers.length) return null;
    if (typeof turf !== 'undefined') {
        try {
            let merged = null;
            parcelLayers.forEach(layer => {
                const feature = layer?.feature;
                if (!feature || !feature.geometry) return;
                merged = merged ? turf.union(merged, feature) : feature;
            });
            if (merged && merged.geometry) {
                return merged.geometry.type === 'Polygon'
                    ? { type: 'MultiPolygon', coordinates: [merged.geometry.coordinates] }
                    : merged.geometry;
            }
        } catch (e) {
            console.warn('turf.union failed for parcel selection geometry, falling back to raw coordinates', e);
        }
    }

    const multiCoords = [];
    parcelLayers.forEach(layer => {
        const geom = layer?.feature?.geometry;
        if (!geom || !geom.coordinates) return;
        if (geom.type === 'Polygon') {
            multiCoords.push(geom.coordinates);
        } else if (geom.type === 'MultiPolygon') {
            geom.coordinates.forEach(rings => multiCoords.push(rings));
        }
    });
    return multiCoords.length ? { type: 'MultiPolygon', coordinates: multiCoords } : null;
}

function launchStructureToolForSelection(kind) {
    const selection = getCurrentParcelSelectionContext();
    if (!selection.layers.length) {
        updateStatus('Select parcels before launching the structure tool.');
        return;
    }
    const geometry = buildGeometryFromParcels(selection.layers);
    if (!geometry) {
        updateStatus('Could not build geometry for the selected parcels.');
        return;
    }
    if (typeof showStructureProposalDialog !== 'function') {
        updateStatus('Structure proposal dialog is unavailable.');
        return;
    }
    closeProposalDialog();
    showStructureProposalDialog({
        kind,
        parcelIds: selection.ids,
        geometry,
        blockName: formatParcelSelectionLabel(selection.ids)
    });
}

function launchBlockifyToolForSelection() {
    const selection = getCurrentParcelSelectionContext();
    if (!selection.layers.length) {
        updateStatus('Select parcels before launching the buildings tool.');
        return;
    }
    if (typeof openBlockifyForParcels !== 'function') {
        updateStatus('Building generator is unavailable.');
        return;
    }
    openBlockifyForParcels({
        blockName: formatParcelSelectionLabel(selection.ids),
        parcels: selection.layers
    });
}

function launchSingleBuildingToolForSelection() {
    const selection = getCurrentParcelSelectionContext();
    if (!selection.layers.length) {
        updateStatus('Select parcels before launching the single building tool.');
        return;
    }
    if (typeof openSingleBuildingForParcels !== 'function') {
        updateStatus('Single building tool is unavailable.');
        return;
    }
    openSingleBuildingForParcels({
        blockName: formatParcelSelectionLabel(selection.ids),
        parcels: selection.layers
    });
}

function handleProposalToolButton(toolKey) {
    const button = document.querySelector(`.proposal-tool-button[data-proposal-tool="${toolKey}"]`);
    const mappedType = button ? button.getAttribute('data-proposal-type') : null;
    setProposalType(mappedType || DEFAULT_PROPOSAL_TYPE);

    switch (toolKey) {
        case 'buildings':
            launchBlockifyToolForSelection();
            break;
        case 'single':
            launchSingleBuildingToolForSelection();
            break;
        default:
            break;
    }
}

// Show proposal creation dialog
function showProposalDialog() {
    const selection = getCurrentParcelSelectionContext();
    const selectedParcels = selection.layers;
    const parcelIds = selection.ids;

    currentProposalTool = null;

    if (!selectedParcels.length) {
        updateStatus('Please select at least one parcel to create a proposal.');
        return;
    }

    const totalArea = selectedParcels.reduce((sum, parcel) => {
        const area = parcel.feature?.properties?.calculatedArea || 0;
        return sum + area;
    }, 0);

    // Create parcel list HTML with error handling
    const parcelListHTML = selectedParcels.map(parcel => {
        const parcelNumber = parcel.feature?.properties?.BROJ_CESTICE || 'Unknown';
        const area = parcel.feature?.properties?.calculatedArea || 0;
        const parcelId = parcel.feature?.properties?.CESTICA_ID;

        // Get parcel owner information
        let ownerAvatarHtml = '';
        if (parcelId) {
            const ownerId = PersistentStorage.getItem(`parcel_${parcelId}_owner`);
            if (ownerId && typeof agentStorage !== 'undefined') {
                const owner = agentStorage.getAgent(ownerId);
                if (owner && typeof getAvatarImagePath === 'function') {
                    ownerAvatarHtml = `<img src="${getAvatarImagePath(owner.avatarIndex)}" class="parcel-owner-avatar" style="width: 20px; height: 20px; border-radius: 50%; border: 2px solid #007bff; margin-right: 6px;" title="Owner: ${owner.name}">`;
                }
            }
        }

        return `
            <div class="proposal-parcel-item" style="display: flex; align-items: center;">
                ${ownerAvatarHtml}
                <div>
                    <span class="parcel-number">Parcel ${parcelNumber}</span>
                    <span class="parcel-area">(${Math.round(area).toLocaleString('hr-HR')} m²)</span>
                </div>
            </div>
        `;
    }).join('');

    // Create modal dialog
    const modal = document.createElement('div');
    modal.className = 'proposal-modal';
    modal.innerHTML = `
        <div class="proposal-modal-content">
            <div class="proposal-modal-header">
                <h2>Create Proposal</h2>
                <button class="proposal-modal-close" onclick="closeProposalDialog()">&times;</button>
            </div>
            <div class="proposal-modal-body">
                <div class="form-group">
                    <label for="proposalAuthor">Author:</label>
                    <div class="proposal-author-row">
                        <img id="proposalAuthorAvatar" class="proposal-author-avatar" alt="Author avatar" />
                        <input type="text" id="proposalAuthor" placeholder="Your name" disabled>
                    </div>
                </div>
                <div class="form-group">
                    <label>Proposal Type:</label>
                    <div class="proposal-type-group">
                        <button type="button" class="btn proposal-type-button selected" data-proposal-main-type="Purchase" onclick="setProposalMainType('Purchase')">Purchase</button>
                        <button type="button" class="btn proposal-type-button" data-proposal-main-type="Urban Rule" disabled>Urban Rule</button>
                        <button type="button" class="btn proposal-type-button" data-proposal-main-type="Reparcellization" onclick="setProposalMainType('Reparcellization')">Reparcellization</button>
                        <button type="button" class="btn proposal-type-button" data-proposal-main-type="Joint Investment" disabled>Joint Investment</button>
                    </div>
                </div>
                <input type="hidden" id="proposalMainType" value="Purchase">
                <div class="form-group" id="proposalGoalGroup">
                    <label>Proposal Goal:</label>
                    <div class="btn-grid-2x2 block-additions proposal-tool-grid">
                        <button type="button" class="btn btn-success proposal-tool-button" data-proposal-tool="buildings" data-proposal-type="Residences" onclick="handleProposalToolButton('buildings')">Buildings</button>
                        <button type="button" class="btn btn-success proposal-tool-button" data-proposal-tool="single" data-proposal-type="Single Building" onclick="handleProposalToolButton('single')">Single Building</button>
                        <button type="button" class="btn btn-success proposal-tool-button" data-proposal-tool="park" data-proposal-type="Park" onclick="handleProposalToolButton('park')">Park</button>
                        <button type="button" class="btn btn-success proposal-tool-button" data-proposal-tool="square" data-proposal-type="Square" onclick="handleProposalToolButton('square')">Square</button>
                    </div>
                </div>
                <div class="form-group" id="reparcellizationAlgorithmGroup" style="display:none;">
                    <label>Algorithm:</label>
                    <div class="btn-grid-2x2 reparcellization-alg-grid">
                        <button type="button" class="btn btn-primary reparcel-alg-button" data-reparcel-algorithm="sweep-line" onclick="handleReparcellizationAlgorithmClick('sweep-line')">Sweep line</button>
                        <button type="button" class="btn btn-secondary reparcel-alg-button" data-reparcel-algorithm="centroidal-voronoi" disabled>Centroidal Voronoi</button>
                        <button type="button" class="btn btn-secondary reparcel-alg-button" data-reparcel-algorithm="wasserstein" disabled>Wasserstein</button>
                        <button type="button" class="btn btn-secondary reparcel-alg-button" data-reparcel-algorithm="manual" disabled>Manual</button>
                    </div>
                    <p class="proposal-type-hint" style="margin-top:10px;">Additional algorithms are visible for planning purposes; Sweep line is currently available.</p>
                </div>
                <input type="hidden" id="proposalType" value="">
                <div class="form-group">
                    <label for="proposalDescription">Description:</label>
                    <textarea id="proposalDescription" rows="4" placeholder="Describe your proposal..."></textarea>
                </div>
                <div class="form-group">
                    <label for="proposalOffer">Offer (EUR):</label>
                    <input type="number" id="proposalOffer" placeholder="0" min="0" step="0.01">
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
                        <h3 style="display:inline; font-size: 1.1em; font-weight: 600; margin:0;">Proposal Summary</h3>
                        <i id="proposalSummaryChevron" class="fas fa-chevron-down" style="margin-left: 8px;"></i>
                    </div>
                    <div id="proposalSummaryContent" style="display:none;">
                        <div class="summary-stats">
                            <p><strong>Parcels Selected:</strong> ${selectedParcels.length}</p>
                            <p><strong>Total Area:</strong> ${Math.round(totalArea).toLocaleString('hr-HR')} m²</p>
                        </div>
                        <div class="parcel-list">
                            <h4>Selected Parcels:</h4>
                            ${parcelListHTML}
                        </div>
                    </div>
                </div>
            </div>
            <div class="proposal-modal-footer">
                <button class="btn btn-proposal" onclick="createProposal()">Create Proposal</button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);
    setProposalMainType('Purchase');
    setProposalType(DEFAULT_PROPOSAL_TYPE);

    // Pre-fill the offer amount with a random value between 1 and 1,000,000 EUR
    const offerInput = document.getElementById('proposalOffer');
    if (offerInput) {
        const minOfferEur = 1;
        const maxOfferEur = 1000000;
        const randomOffer = Math.floor(Math.random() * (maxOfferEur - minOfferEur + 1)) + minOfferEur;
        offerInput.value = randomOffer;
    }

    // Pre-fill the author field and avatar with the current user
    populateProposalAuthorUI();

    // Focus on description field since author and type are pre-filled
    document.getElementById('proposalDescription').focus();
}

// Close proposal dialog
function closeProposalDialog() {
    const modal = document.querySelector('.proposal-modal');
    if (modal) {
        modal.remove();
    }
    currentProposalTool = null;
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
    }
}

// Utilities for random names
function _randomFrom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function generateStructureName(kind) {
    const adj = ['Green', 'Sunny', 'Central', 'Liberty', 'Unity', 'Riverside', 'Grand', 'Heritage', 'Harmony', 'Oak'];
    const nounPark = ['Park', 'Garden', 'Commons', 'Meadow', 'Grove'];
    const nounSquare = ['Square', 'Plaza', 'Forum', 'Court', 'Terrace'];
    const noun = kind === 'square' ? nounSquare : nounPark;
    return `${_randomFrom(adj)} ${_randomFrom(noun)}`;
}

// Show proposal dialog for structures (Park/Square) with provided parcelIds and geometry
function showStructureProposalDialog({ kind, parcelIds, geometry, blockName }) {
    const validKind = (kind === 'park' || kind === 'square') ? kind : 'square';
    const selectedParcels = (parcelIds || []).map(id => multiParcelSelection.findParcelById(id)).filter(Boolean);
    if (selectedParcels.length === 0) {
        updateStatus('Could not determine parcels for this block.');
        return;
    }

    const totalArea = selectedParcels.reduce((sum, layer) => sum + (layer?.feature?.properties?.calculatedArea || 0), 0);
    const parcelListHTML = selectedParcels.map(parcel => {
        const number = parcel.feature?.properties?.BROJ_CESTICE || 'Unknown';
        const area = Math.round(parcel.feature?.properties?.calculatedArea || 0).toLocaleString('hr-HR');
        return `<div class="proposal-parcel-item"><span class="parcel-number">Parcel ${number}</span> <span class="parcel-area">(${area} m²)</span></div>`;
    }).join('');

    const modal = document.createElement('div');
    modal.className = 'proposal-modal';
    const defaultName = generateStructureName(validKind);
    modal.innerHTML = `
        <div class="proposal-modal-content">
            <div class="proposal-modal-header">
                <h2>Create ${validKind === 'park' ? 'Park' : 'Square'} Proposal</h2>
                <button class="proposal-modal-close" onclick="closeProposalDialog()">&times;</button>
            </div>
            <div class="proposal-modal-body">
                <div class="form-group">
                    <label for="proposalAuthor">Author:</label>
                    <div class="proposal-author-row">
                        <img id="proposalAuthorAvatar" class="proposal-author-avatar" alt="Author avatar" />
                        <input type="text" id="proposalAuthor" placeholder="Your name" disabled>
                    </div>
                </div>
                <div class="form-group">
                    <label for="proposalName">Name:</label>
                    <input type="text" id="proposalName" value="${defaultName}" placeholder="Name your ${validKind}">
                </div>
                <div class="form-group">
                    <label for="proposalType">Type:</label>
                    <input type="text" id="proposalType" value="${validKind === 'park' ? 'Park' : 'Square'}" disabled>
                </div>
                <div class="form-group">
                    <label for="proposalDescription">Description:</label>
                    <textarea id="proposalDescription" rows="3" placeholder="Describe your ${validKind}..."></textarea>
                </div>
                <div class="form-group">
                    <label for="proposalOffer">Offer (EUR):</label>
                    <input type="number" id="proposalOffer" placeholder="0" min="0" step="0.01">
                </div>
                <div class="proposal-summary">
                    <div class="summary-stats">
                        <p><strong>Parcels Selected:</strong> ${selectedParcels.length}</p>
                        <p><strong>Total Area:</strong> ${Math.round(totalArea).toLocaleString('hr-HR')} m²</p>
                    </div>
                    <div class="parcel-list">
                        <h4>Selected Parcels:</h4>
                        ${parcelListHTML}
                    </div>
                </div>
            </div>
            <div class="proposal-modal-footer">
                <button type="button" class="btn btn-proposal" id="create-structure-proposal-btn">Create Proposal</button>
            </div>
        </div>`;

    document.body.appendChild(modal);

    // Prefill author and random offer
    populateProposalAuthorUI();
    const offerInput = document.getElementById('proposalOffer');
    if (offerInput) {
        const minOfferEur = 1000, maxOfferEur = 100000;
        offerInput.value = Math.floor(Math.random() * (maxOfferEur - minOfferEur + 1)) + minOfferEur;
    }
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

function createStructureProposalFromDialog(kind, parcelIds, geometry, blockName) {
    const author = getProposalAuthorValue();
    const title = (document.getElementById('proposalName')?.value || '').trim();
    const description = (document.getElementById('proposalDescription')?.value || '').trim();
    const offer = parseFloat(document.getElementById('proposalOffer')?.value) || 0;
    if (!author || !title || offer <= 0) {
        alert('Please provide author, name, and a valid offer.');
        return;
    }
    if (!Array.isArray(parcelIds) || parcelIds.length === 0 || !geometry) {
        alert('Missing parcels or geometry for this proposal.');
        return;
    }

    const proposal = {
        author,
        title,
        description,
        offer,
        parcelIds: parcelIds,
        type: 'structure',
        structureProposal: {
            kind: (kind === 'park' || kind === 'square') ? kind : 'square',
            status: 'unapplied',
            geometry,
            parentParcelIds: parcelIds,
            blockName: blockName || null
        },
        createdAt: new Date().toISOString()
    };

    const hash = proposalStorage.addProposal(proposal);
    if (!hash) {
        alert('An identical proposal already exists.');
        return;
    }
    const primaryParcelId = parcelIds.length ? parcelIds[0] : null;
    // Link proposal to ancestors
    try { if (typeof ProposalManager !== 'undefined' && ProposalManager._linkProposalToAncestors) ProposalManager._linkProposalToAncestors(hash, parcelIds); } catch (_) { }

    // Close and update UI
    closeProposalDialog();
    try { if (typeof updateShowProposalsButton === 'function') updateShowProposalsButton(); } catch (_) { }
    try { if (typeof enableShowProposalsMode === 'function') enableShowProposalsMode(); } catch (_) { }

    let applied = false;
    if (typeof applyProposalToMap === 'function') {
        applied = applyProposalToMap(hash, { parcelId: primaryParcelId, centerOnProposal: true }) !== false;
    } else if (typeof ProposalManager !== 'undefined' && typeof ProposalManager.applyProposal === 'function') {
        try {
            applied = ProposalManager.applyProposal(hash) !== false;
        } catch (_) {
            applied = false;
        }
    }

    if (!applied && typeof focusProposalDetails === 'function') {
        focusProposalDetails(hash, { parcelId: primaryParcelId, centerOnProposal: true });
    }
}

// Expose helpers
window.showStructureProposalDialog = showStructureProposalDialog;
window.handleProposalToolButton = handleProposalToolButton;
window.setProposalType = setProposalType;
window.setProposalMainType = setProposalMainType;
window.handleReparcellizationAlgorithmClick = handleReparcellizationAlgorithmClick;
window.populateProposalAuthorUI = populateProposalAuthorUI;
window.getProposalAuthorValue = getProposalAuthorValue;
window.getSelectedProposalTool = getSelectedProposalTool;
window.buildGeometryFromParcels = buildGeometryFromParcels;
window.getCurrentParcelSelectionContext = getCurrentParcelSelectionContext;

document.addEventListener('blockifyModalOpened', () => setProposalModalDimmed(true));
document.addEventListener('blockifyModalClosed', () => setProposalModalDimmed(false));

/**
 * Calculate and return bounds for a set of parcels
 * @param {Array} parcelIds - Array of parcel IDs
 * @returns {Object|null} Bounds object with center, north, south, east, west
 */
function calculateProposalBounds(parcelIds) {
    if (!parcelIds || parcelIds.length === 0) return null;

    const positions = [];
    const missingParcels = [];

    parcelIds.forEach(parcelId => {
        const parcel = multiParcelSelection.findParcelById(parcelId);
        if (parcel && typeof parcel.getBounds === 'function') {
            try {
                const bounds = parcel.getBounds();
                if (bounds && typeof bounds.getCenter === 'function') {
                    const center = bounds.getCenter();
                    if (center && !isNaN(center.lat) && !isNaN(center.lng)) {
                        positions.push(center);
                    }
                }
            } catch (e) {
                console.warn(`Error getting bounds for parcel ${parcelId}:`, e);
                missingParcels.push(parcelId);
            }
        } else {
            missingParcels.push(parcelId);
        }
    });

    if (positions.length === 0) {
        console.warn('Cannot calculate bounds - no valid parcel positions found');
        return null;
    }

    // Calculate bounding box
    let north = positions[0].lat;
    let south = positions[0].lat;
    let east = positions[0].lng;
    let west = positions[0].lng;

    positions.forEach(pos => {
        north = Math.max(north, pos.lat);
        south = Math.min(south, pos.lat);
        east = Math.max(east, pos.lng);
        west = Math.min(west, pos.lng);
    });

    // Calculate center
    const centerLat = (north + south) / 2;
    const centerLng = (east + west) / 2;

    const bounds = {
        center: { lat: centerLat, lng: centerLng },
        north: north,
        south: south,
        east: east,
        west: west,
        calculatedAt: new Date().toISOString(),
        parcelCount: positions.length,
        totalParcels: parcelIds.length
    };

    if (missingParcels.length > 0) {
        bounds.missingParcels = missingParcels;
        console.warn(`Bounds calculated from ${positions.length}/${parcelIds.length} parcels. Missing: ${missingParcels.join(', ')}`);
    }

    return bounds;
}

// Create proposal from dialog
function createProposal() {
    const selectedTool = getSelectedProposalTool();
    if (!selectedTool) {
        alert('Select a proposal goal before creating a proposal.');
        return;
    }

    if (selectedTool === 'buildings') {
        if (typeof createProposalWithBuilding === 'function') {
            createProposalWithBuilding();
        } else {
            alert('Building proposal workflow is unavailable.');
        }
        return;
    }

    if (selectedTool === 'single') {
        if (typeof createSingleBuildingProposal === 'function') {
            createSingleBuildingProposal();
        } else {
            alert('Single building workflow is unavailable.');
        }
        return;
    }

    const author = getProposalAuthorValue();
    const proposalTypeInput = document.getElementById('proposalType');
    const proposalType = proposalTypeInput && proposalTypeInput.value ? proposalTypeInput.value : DEFAULT_PROPOSAL_TYPE;
    const proposalMainTypeInput = document.getElementById('proposalMainType');
    const proposalMainType = proposalMainTypeInput && proposalMainTypeInput.value ? proposalMainTypeInput.value : 'Purchase';
    const pendingReparcelPlan = (typeof window !== 'undefined') ? window.pendingReparcellizationPlan : null;
    if (proposalMainType === 'Reparcellization') {
        if (!pendingReparcelPlan || !Array.isArray(pendingReparcelPlan.polygons) || pendingReparcelPlan.polygons.length === 0) {
            alert('Run the reparcellization algorithm and click Done before creating this proposal.');
            return;
        }
    }
    const description = document.getElementById('proposalDescription').value.trim();
    const offer = parseFloat(document.getElementById('proposalOffer').value) || 0;

    // Validation
    if (!author) {
        alert('Please enter an author name.');
        return;
    }
    if (!description) {
        alert('Please enter a description.');
        return;
    }
    if (offer <= 0) {
        alert('Please enter a valid offer amount.');
        return;
    }

    try {
        // Get the parcelIds that were determined in showProposalDialog
        let finalParcelIds = [];

        const createdFromMultiSelect = multiParcelSelection.isActive && multiParcelSelection.selectedParcels.size > 1;

        if (multiParcelSelection.selectedParcels.size > 0) {
            finalParcelIds = Array.from(multiParcelSelection.selectedParcels);
        } else if (typeof selectedParcelId !== 'undefined' && selectedParcelId) {
            finalParcelIds = [selectedParcelId];
        }

        if (finalParcelIds.length === 0) {
            alert('No parcels selected. Please select parcels before creating a proposal.');
            return;
        }

        // Calculate bounds for the proposal (for reliable positioning)
        const bounds = calculateProposalBounds(finalParcelIds);

        const proposal = {
            author,
            title: proposalType, // Use proposal type as the title
            description,
            offer,
            budget: offer, // Add budget field - initially same as offer
            parcelIds: finalParcelIds,
            type: 'parcel', // For future extension to road/building proposals
            primaryType: proposalMainType,
            acceptedParcelIds: [], // Track which parcels have accepted the proposal
            ownerAcceptances: {},
            bounds: bounds, // Store bounds for reliable positioning
            createdAt: new Date().toISOString() // Add creation timestamp
        };

        if (proposalMainType === 'Reparcellization') {
            if (!pendingReparcelPlan || !Array.isArray(pendingReparcelPlan.parcelIds)) {
                alert('Reparcellization plan is missing. Please rerun the algorithm.');
                return;
            }
            const planParcelSet = new Set((pendingReparcelPlan.parcelIds || []).map(id => id && id.toString()));
            const finalParcelSet = new Set(finalParcelIds.map(id => id && id.toString()));
            const parcelsMatch = planParcelSet.size === finalParcelSet.size && Array.from(planParcelSet).every(id => finalParcelSet.has(id));
            if (!parcelsMatch) {
                alert('Selected parcels changed after running reparcellization. Please rerun the algorithm.');
                return;
            }
            proposal.type = 'reparcellization';
            proposal.reparcellization = JSON.parse(JSON.stringify(pendingReparcelPlan));
            proposal.reparcellization.parcelIds = finalParcelIds.slice();
        }

        const hash = proposalStorage.addProposal(proposal);
        if (hash === null) {
            alert('This exact proposal already exists');
            return;
        }

        // Update the show proposals button count
        updateShowProposalsButton();
        // Log user action for proposal creation
        const userAgent = getCurrentUserAgent();
        if (userAgent && typeof addUserActionToGameLog === 'function') {
            addUserActionToGameLog(`<a href="#" data-agent-id="${userAgent.id}" class="agent-link agent-link-clickable">${userAgent.name}</a> created a ${proposalType} proposal (<a href="#" data-proposal-hash="${hash.substring(0, 8)}" class="proposal-link proposal-link-clickable">${hash.substring(0, 8)}</a>) for ${proposal.parcelIds.length} parcel(s) with budget ${offer} ETH.`);

            // Update user agent's created proposals
            if (!userAgent.proposalsCreated) {
                userAgent.proposalsCreated = [];
            }
            if (!userAgent.proposalsCreated.includes(hash)) {
                userAgent.proposalsCreated.push(hash);
                agentStorage.updateAgent(userAgent.id, { proposalsCreated: userAgent.proposalsCreated });
            }
        }

        // Enable show proposals mode and clear multi-selection
        enableShowProposalsMode();

        // Hide parcel info panel if needed
        if (typeof hideParcelInfoPanel === 'function') {
            hideParcelInfoPanel();
        }

        // Close dialog
        closeProposalDialog();

        // Update proposal list if open
        updateProposalList();

        updateStatus(`Proposal "${proposalType}" created successfully with ${proposal.parcelIds.length} parcels.`);

        if (proposalMainType === 'Reparcellization' && typeof window !== 'undefined') {
            window.pendingReparcellizationPlan = null;
        }

        if (typeof multiParcelSelection !== 'undefined') {
            if (createdFromMultiSelect && multiParcelSelection.isActive) {
                multiParcelSelection.toggle({ restoreSingleSelection: false });
            } else if (multiParcelSelection.selectedParcels) {
                multiParcelSelection.selectedParcels.clear();
                multiParcelSelection.lastSelectedParcelId = null;
                if (typeof multiParcelSelection.updateUI === 'function') {
                    multiParcelSelection.updateUI();
                }
            }
        }

        const focusParcelId = proposal.parcelIds[0] || null;
        if (typeof selectAndHighlightProposal === 'function') {
            selectAndHighlightProposal(hash, focusParcelId, true, true);
        } else {
            showProposalDetailsModal(hash);
        }

    } catch (error) {
        alert(error.message);
    }
}

const proposalListState = {
    activeTab: 'active',
    filterType: 'all',
    authorFilter: '',
    searchText: '',
    sortKey: 'created-desc',
    selectedHash: null
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

const PROPOSAL_TYPE_FILTERS = [
    { value: 'all', label: 'All types' },
    { value: 'road', label: 'Roads' },
    { value: 'building', label: 'Buildings' },
    { value: 'park', label: 'Parks' },
    { value: 'square', label: 'Squares' },
    { value: 'structure', label: 'Other structures' },
    { value: 'reparcellization', label: 'Reparcellization' },
    { value: 'parcel', label: 'Parcel proposals' },
    { value: 'other', label: 'Other' }
];

const PROPOSAL_TYPE_LABELS = {
    road: 'Road',
    building: 'Building',
    park: 'Park',
    square: 'Square',
    structure: 'Structure',
    reparcellization: 'Reparcellization',
    parcel: 'Parcel',
    other: 'Other'
};

function resolveStructureProposal(proposal, options = {}) {
    if (!proposal) return null;
    if (proposal.structureProposal && typeof proposal.structureProposal === 'object') {
        return proposal.structureProposal;
    }

    const fallbackToStorage = options && Object.prototype.hasOwnProperty.call(options, 'fallbackToStorage')
        ? options.fallbackToStorage !== false
        : true;
    if (!fallbackToStorage) {
        return null;
    }

    if (!proposal.proposalHash || typeof proposalStorage === 'undefined' || typeof proposalStorage.getProposal !== 'function') {
        return null;
    }

    try {
        const stored = proposalStorage.getProposal(proposal.proposalHash);
        if (stored && stored.structureProposal && typeof stored.structureProposal === 'object') {
            return stored.structureProposal;
        }
    } catch (_) { }
    return null;
}

if (typeof window !== 'undefined') {
    window.resolveStructureProposal = resolveStructureProposal;
}

function computeProposalCategoryFlags(proposal, options = {}) {
    const fallback = options && options.fallbackProposal ? options.fallbackProposal : null;
    const subject = proposal || fallback || {};
    const normalizedType = ((subject.type || (fallback && fallback.type) || '') + '').toLowerCase();
    const originalNormalizedType = ((fallback && fallback.type) || subject.type || '').toLowerCase();
    const normalizedPrimaryType = ((subject.primaryType || (fallback && fallback.primaryType) || '') + '').toLowerCase();

    let structureProposal = resolveStructureProposal(subject, { fallbackToStorage: options.fallbackToStorage !== false });
    if (!structureProposal && fallback && fallback !== subject) {
        structureProposal = resolveStructureProposal(fallback, { fallbackToStorage: options.fallbackToStorage !== false });
    }
    if (!structureProposal && subject.structureProposal) {
        structureProposal = subject.structureProposal;
    }
    if (!structureProposal && fallback && fallback.structureProposal) {
        structureProposal = fallback.structureProposal;
    }

    const hasStructureProposal = !!structureProposal;
    const structureKind = ((structureProposal && structureProposal.kind) || (subject.structureProposal && subject.structureProposal.kind) || (fallback && fallback.structureProposal && fallback.structureProposal.kind) || '').toLowerCase();

    const typeMatchesStructure = ['structure', 'square', 'park'].includes(normalizedType) || ['structure', 'square', 'park'].includes(originalNormalizedType);
    const primaryTypeMatchesStructure = ['park', 'square'].includes(normalizedPrimaryType);
    const kindMatchesStructure = ['park', 'square'].includes(structureKind);
    const combinedLabelSource = [
        subject.title,
        subject.primaryType,
        subject.type,
        fallback && fallback !== subject ? fallback.title : '',
        fallback && fallback !== subject ? fallback.primaryType : '',
        fallback && fallback !== subject ? fallback.type : ''
    ].map(value => (value || '').toString().toLowerCase()).join(' ');
    const textualStructureHint = combinedLabelSource.includes('park') || combinedLabelSource.includes('square');

    const isRoadProposal = normalizedType === 'road' || !!subject.roadProposal;
    let isBuildingProposal = (!isRoadProposal) && (normalizedType === 'building' || !!subject.buildingProposal || !!subject.buildingGeometry || !!(fallback && (fallback.buildingProposal || fallback.buildingGeometry)));
    const isReparcellizationProposal = !!subject.reparcellization || normalizedType === 'reparcellization' || !!(fallback && fallback.reparcellization);

    const structureCandidate = hasStructureProposal || typeMatchesStructure || primaryTypeMatchesStructure || kindMatchesStructure || textualStructureHint;
    let isStructureProposal = structureCandidate && !isRoadProposal && !isBuildingProposal;
    if (!isStructureProposal && structureCandidate && !isRoadProposal) {
        isStructureProposal = true;
        if (typeMatchesStructure || primaryTypeMatchesStructure || kindMatchesStructure) {
            isBuildingProposal = false;
        }
    }

    const supportsMapToggle = isRoadProposal || isBuildingProposal || isStructureProposal || isReparcellizationProposal;

    return {
        structureProposal: structureProposal || null,
        isRoadProposal,
        isBuildingProposal,
        isStructureProposal,
        isReparcellizationProposal,
        supportsMapToggle
    };
}

function getProposalDisplayType(proposal) {
    if (!proposal) return 'other';

    if (proposal.type === 'road' || proposal.roadProposal) {
        return 'road';
    }

    if (proposal.buildingProposal || proposal.type === 'building' || proposal.buildingGeometry) {
        return 'building';
    }

    const structureData = resolveStructureProposal(proposal);
    if (structureData) {
        const kind = (structureData.kind || '').toLowerCase();
        if (kind === 'park') return 'park';
        if (kind === 'square') return 'square';
        return 'structure';
    }

    if (proposal.reparcellization || (proposal.type || '').toLowerCase() === 'reparcellization') {
        return 'reparcellization';
    }

    if ((proposal.type || '').toLowerCase() === 'structure') {
        return 'structure';
    }

    if ((proposal.type || '').toLowerCase() === 'parcel') {
        return 'parcel';
    }

    return 'other';
}

function formatProposalTypeLabel(typeKey) {
    return PROPOSAL_TYPE_LABELS[typeKey] || typeKey.charAt(0).toUpperCase() + typeKey.slice(1);
}

function isProposalApplied(proposal) {
    if (!proposal) return false;

    const globalStatus = (proposal.status || '').toLowerCase();
    if (globalStatus === 'applied' || globalStatus === 'executed') {
        return true;
    }

    const roadStatus = (proposal.roadProposal && proposal.roadProposal.status) ? proposal.roadProposal.status.toLowerCase() : '';
    if (roadStatus === 'applied' || roadStatus === 'executed') {
        return true;
    }

    const buildingStatus = (proposal.buildingProposal && proposal.buildingProposal.status)
        ? proposal.buildingProposal.status.toLowerCase()
        : '';
    if (buildingStatus === 'applied' || buildingStatus === 'executed') {
        return true;
    }

    const structureData = resolveStructureProposal(proposal);
    const structureStatus = structureData && structureData.status
        ? structureData.status.toLowerCase()
        : '';
    if (structureStatus === 'applied' || structureStatus === 'executed') {
        return true;
    }

    const reparcelStatus = (proposal.reparcellization && proposal.reparcellization.status)
        ? proposal.reparcellization.status.toLowerCase()
        : '';
    if (reparcelStatus === 'applied' || reparcelStatus === 'executed') {
        return true;
    }

    return false;
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

function getProposalLifecycleKey(proposal) {
    if (!proposal) return 'active';
    const lifecycleField = (proposal.lifecycleStatus || proposal.status || '').toLowerCase();
    if (lifecycleField === 'executed') return 'executed';
    if (PROPOSAL_INACTIVE_STATUSES.has(lifecycleField)) return 'inactive';
    return 'active';
}

function getProposalLifecycleLabel(key) {
    switch (key) {
        case 'executed':
            return 'Executed';
        case 'inactive':
            return 'Inactive';
        default:
            return 'Active';
    }
}

function getProposalLifecycleClass(key) {
    switch (key) {
        case 'executed':
            return 'executed';
        case 'inactive':
            return 'inactive';
        default:
            return 'active';
    }
}

if (typeof window !== 'undefined') {
    window.getProposalLifecycleKey = getProposalLifecycleKey;
    window.getProposalLifecycleLabel = getProposalLifecycleLabel;
    window.getProposalLifecycleClass = getProposalLifecycleClass;
}

function getParcelAreaById(parcelId) {
    if (parcelId === undefined || parcelId === null) return 0;
    let area = 0;

    try {
        const layer = multiParcelSelection.findParcelById(parcelId);
        if (layer && layer.feature?.properties && Number.isFinite(layer.feature.properties.calculatedArea)) {
            area = Number(layer.feature.properties.calculatedArea) || 0;
        }
    } catch (_) {
        // parcel not currently on map, fall back to stored metadata
    }

    if (!area) {
        try {
            const stored = PersistentStorage.getItem(`parcel_${parcelId}_properties`);
            if (stored) {
                const props = JSON.parse(stored);
                if (props && Number.isFinite(props.calculatedArea)) {
                    area = Number(props.calculatedArea) || 0;
                }
            }
        } catch (_) {
            // ignore storage issues
        }
    }

    return area;
}

function computeProposalArea(proposal) {
    if (!proposal) return 0;

    if (Array.isArray(proposal.parcelIds) && proposal.parcelIds.length > 0) {
        return proposal.parcelIds.reduce((sum, id) => sum + getParcelAreaById(id), 0);
    }

    try {
        if (proposal.structureProposal?.geometry && typeof turf !== 'undefined' && typeof turf.area === 'function') {
            return turf.area(proposal.structureProposal.geometry);
        }
        if (proposal.buildingProposal?.buildingFeature && typeof turf !== 'undefined' && typeof turf.area === 'function') {
            return turf.area(proposal.buildingProposal.buildingFeature);
        }
    } catch (_) {
        // fall back silently when turf measurement fails
    }

    return 0;
}

function computeProposalMetrics(proposal) {
    const createdAt = Date.parse(proposal.createdAt) || 0;
    const executedAt = proposal.executedAt ? (Date.parse(proposal.executedAt) || 0) : 0;
    const parcelCount = Array.isArray(proposal.parcelIds) ? proposal.parcelIds.length : 0;
    const acceptedCount = Array.isArray(proposal.acceptedParcelIds) ? proposal.acceptedParcelIds.length : 0;
    const acceptanceRatio = parcelCount > 0 ? acceptedCount / parcelCount : 0;
    const offerValue = Number.isFinite(Number(proposal.offer)) ? Number(proposal.offer) : (Number.isFinite(Number(proposal.budget)) ? Number(proposal.budget) : 0);
    const area = computeProposalArea(proposal);
    const typeKey = getProposalDisplayType(proposal);
    const author = (proposal.author || '').trim();
    const title = (proposal.title || '').trim();

    return {
        createdAt,
        executedAt,
        parcelCount,
        acceptedCount,
        acceptanceRatio,
        acceptancePercent: acceptanceRatio * 100,
        offerValue,
        area,
        typeKey,
        author,
        authorLower: author.toLowerCase(),
        titleLower: title.toLowerCase(),
        isApplied: isProposalApplied(proposal)
    };
}

function formatAreaMetric(area) {
    if (!Number.isFinite(area) || area <= 0) {
        return '—';
    }
    return `${Math.round(area).toLocaleString('hr-HR')} m²`;
}

function formatCurrencyMetric(value) {
    if (!Number.isFinite(value) || value <= 0) {
        return '—';
    }
    return `€${Math.round(value).toLocaleString('hr-HR')}`;
}

function applyProposalListFilters(dataset) {
    const typeFilter = proposalListState.filterType;
    const authorFilter = proposalListState.authorFilter.trim().toLowerCase();
    const searchFilter = proposalListState.searchText.trim().toLowerCase();

    return dataset.filter(entry => {
        const { metrics } = entry;
        if (typeFilter !== 'all' && metrics.typeKey !== typeFilter) {
            return false;
        }

        if (authorFilter && !metrics.authorLower.includes(authorFilter)) {
            return false;
        }

        if (searchFilter) {
            const haystack = `${metrics.authorLower} ${metrics.titleLower}`;
            if (!haystack.includes(searchFilter)) {
                return false;
            }
        }

        return true;
    });
}

function sortProposalDataset(dataset) {
    const sortKey = proposalListState.sortKey || 'created-desc';

    const sorted = dataset.slice();
    sorted.sort((a, b) => {
        const am = a.metrics;
        const bm = b.metrics;

        switch (sortKey) {
            case 'created-asc':
                return am.createdAt - bm.createdAt;
            case 'acceptance-desc':
                return bm.acceptanceRatio - am.acceptanceRatio;
            case 'acceptance-asc':
                return am.acceptanceRatio - bm.acceptanceRatio;
            case 'value-desc':
                return bm.offerValue - am.offerValue;
            case 'value-asc':
                return am.offerValue - bm.offerValue;
            case 'parcels-desc':
                return bm.parcelCount - am.parcelCount;
            case 'parcels-asc':
                return am.parcelCount - bm.parcelCount;
            case 'area-desc':
                return bm.area - am.area;
            case 'area-asc':
                return am.area - bm.area;
            case 'author-asc':
                return am.authorLower.localeCompare(bm.authorLower);
            case 'author-desc':
                return bm.authorLower.localeCompare(am.authorLower);
            case 'created-desc':
            default:
                return bm.createdAt - am.createdAt;
        }
    });

    return sorted;
}

function buildProposalActionButtons(proposal, isExecuted = false) {
    if (isExecuted) {
        return '';
    }

    const categoryFlags = computeProposalCategoryFlags(proposal);
    const {
        structureProposal,
        isRoadProposal,
        isBuildingProposal,
        isStructureProposal,
        isReparcellizationProposal
    } = categoryFlags;

    let actionButtons = '';

    if (isRoadProposal) {
        const status = (proposal.roadProposal.status || '').toLowerCase();
        if (status === 'applied') {
            actionButtons = `
                <button class="proposal-action-btn" onclick="event.stopPropagation(); removeProposalFromMap('${proposal.proposalHash}')" title="Remove this road proposal from the map">
                    <i class="fas fa-eye-slash"></i> Remove from map
                </button>
            `;
        } else {
            actionButtons = `
                <button class="proposal-action-btn" onclick="event.stopPropagation(); applyProposalToMap('${proposal.proposalHash}')" title="Apply this road proposal to the map">
                    <i class="fas fa-check"></i> Apply to map
                </button>
            `;
        }
    } else if (isBuildingProposal) {
        const status = (proposal.buildingProposal?.status || proposal.status || '').toLowerCase();
        if (status === 'applied' || status === 'executed') {
            actionButtons = `
                <button class="proposal-action-btn" onclick="event.stopPropagation(); removeProposalFromMap('${proposal.proposalHash}')" title="Remove this building proposal from the map">
                    <i class="fas fa-eye-slash"></i> Remove from map
                </button>
            `;
        } else {
            actionButtons = `
                <button class="proposal-action-btn" onclick="event.stopPropagation(); applyProposalToMap('${proposal.proposalHash}')" title="Apply this building proposal to the map">
                    <i class="fas fa-check"></i> Apply to map
                </button>
            `;
        }
    } else if (isStructureProposal) {
        const status = (structureProposal?.status || proposal.status || '').toLowerCase();
        if (status === 'applied') {
            actionButtons = `
                <button class="proposal-action-btn" onclick="event.stopPropagation(); removeProposalFromMap('${proposal.proposalHash}')" title="Remove this structure proposal from the map">
                    <i class="fas fa-eye-slash"></i> Remove from map
                </button>
            `;
        } else {
            actionButtons = `
                <button class="proposal-action-btn" onclick="event.stopPropagation(); applyProposalToMap('${proposal.proposalHash}')" title="Apply this structure proposal to the map">
                    <i class="fas fa-check"></i> Apply to map
                </button>
            `;
        }
    } else if (isReparcellizationProposal) {
        const status = (proposal.reparcellization?.status || proposal.status || '').toLowerCase();
        if (status === 'applied') {
            actionButtons = `
                <button class="proposal-action-btn" onclick="event.stopPropagation(); removeProposalFromMap('${proposal.proposalHash}')" title="Remove this reparcellization proposal from the map">
                    <i class="fas fa-eye-slash"></i> Remove from map
                </button>
            `;
        } else {
            actionButtons = `
                <button class="proposal-action-btn" onclick="event.stopPropagation(); applyProposalToMap('${proposal.proposalHash}')" title="Apply this reparcellization proposal to the map">
                    <i class="fas fa-check"></i> Apply to map
                </button>
            `;
        }
    }

    return actionButtons;
}

function buildProposalListItemsHtml(dataset) {
    if (!dataset || dataset.length === 0) {
        return '<p class="empty-proposals">No proposals match the current filters.</p>';
    }

    return dataset.map(entry => {
        const { proposal, metrics } = entry;
        const hash = proposal.proposalHash;
        const color = typeof getProposalColor === 'function' ? getProposalColor(hash) : '#007bff';
        const lifecycleKey = getProposalLifecycleKey(proposal);
        const statusLabel = getProposalLifecycleLabel(lifecycleKey);
        const statusClass = getProposalLifecycleClass(lifecycleKey);
        const typeLabel = formatProposalTypeLabel(metrics.typeKey);
        const acceptanceText = metrics.parcelCount > 0
            ? `${metrics.acceptedCount}/${metrics.parcelCount} (${Math.round(metrics.acceptancePercent)}%)`
            : '—';
        const areaText = formatAreaMetric(metrics.area);
        const offerText = formatCurrencyMetric(metrics.offerValue);
        const createdDate = metrics.createdAt ? new Date(metrics.createdAt).toLocaleDateString() : '—';
        const isExecuted = (proposal.status || '').toLowerCase() === 'executed';
        const classes = ['proposal-list-item'];

        if (metrics.isApplied) classes.push('is-applied');
        if (isExecuted) classes.push('is-executed');
        if (proposalHighlightState.activeProposalHash === hash || proposalListState.selectedHash === hash) {
            classes.push('is-selected');
        }
        if (currentProposalPreviewHash === hash) classes.push('is-previewing');

        const classAttr = classes.join(' ');
        const safeTitle = escapeHtml(proposal.title || 'Untitled proposal');
        const safeAuthor = escapeHtml(metrics.author || 'Unknown');

        return `
            <div class="${classAttr}" data-proposal-hash="${hash}" style="border-left: 4px solid ${color};">
                <div class="proposal-list-header">
                    <div class="proposal-list-heading">
                        <div class="proposal-color-dot" style="background-color: ${color};"></div>
                        <div class="proposal-list-title-text">
                            <span class="proposal-list-title">${safeTitle}</span>
                            <span class="proposal-type-pill">${typeLabel}</span>
                        </div>
                    </div>
                    <div class="proposal-actions">
                        ${buildProposalActionButtons(proposal, isExecuted)}
                        <button class="proposal-list-details-btn" data-proposal-hash="${hash}" title="View details">
                            <i class="fas fa-circle-info"></i> Details
                        </button>
                        <div class="proposal-status-indicator ${statusClass}">${statusLabel}</div>
                        <button class="proposal-delete-btn" onclick="event.stopPropagation(); deleteProposal('${hash}')" title="Delete proposal">
                            <i class="fas fa-trash"></i>
                        </button>
                    </div>
                </div>
                <div class="proposal-list-meta">
                    <span><strong>Author:</strong> ${safeAuthor}</span>
                    <span><strong>Created:</strong> ${createdDate}</span>
                    <span><strong>Acceptance:</strong> ${acceptanceText}</span>
                    <span><strong>Parcels:</strong> ${metrics.parcelCount}</span>
                    <span><strong>Area:</strong> ${areaText}</span>
                    <span><strong>Offer:</strong> ${offerText}</span>
                </div>
                ${proposal.description ? `<div class="proposal-list-description">${escapeHtml(proposal.description)}</div>` : ''}
            </div>
        `;
    }).join('');
}

function renderProposalListModal() {
    let modal = document.querySelector('.proposal-list-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.className = 'proposal-list-modal';
        document.body.appendChild(modal);
    }

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

    const allProposals = proposalStorage.getAllProposals();
    const augmented = allProposals.map(proposal => ({
        proposal,
        metrics: computeProposalMetrics(proposal)
    }));

    const activeDataset = augmented.filter(entry => (entry.proposal.status || '').toLowerCase() !== 'executed');
    const executedDataset = augmented.filter(entry => (entry.proposal.status || '').toLowerCase() === 'executed');

    const filteredActive = applyProposalListFilters(activeDataset);
    const filteredExecuted = applyProposalListFilters(executedDataset);

    const sortedActive = sortProposalDataset(filteredActive);
    const sortedExecuted = sortProposalDataset(filteredExecuted);

    const selectedHash = proposalListState.selectedHash;
    if (selectedHash) {
        const isSelectedVisible = sortedActive.some(entry => entry.proposal.proposalHash === selectedHash)
            || sortedExecuted.some(entry => entry.proposal.proposalHash === selectedHash);
        if (!isSelectedVisible) {
            proposalListState.selectedHash = null;
        }
    }

    const controlsHtml = `
        <div class="proposal-list-controls">
            <div class="proposal-filter-group">
                <label for="proposal-filter-type">Type</label>
                <select id="proposal-filter-type">
                    ${PROPOSAL_TYPE_FILTERS.map(option => `
                        <option value="${option.value}" ${option.value === proposalListState.filterType ? 'selected' : ''}>${option.label}</option>
                    `).join('')}
                </select>
            </div>
            <div class="proposal-filter-group">
                <label for="proposal-filter-author">Author</label>
                <input type="text" id="proposal-filter-author" placeholder="All authors" value="${escapeHtml(proposalListState.authorFilter)}">
            </div>
            <div class="proposal-filter-group">
                <label for="proposal-filter-search">Search</label>
                <input type="text" id="proposal-filter-search" placeholder="Search title or author" value="${escapeHtml(proposalListState.searchText)}">
            </div>
            <div class="proposal-filter-group">
                <label for="proposal-sort">Sort by</label>
                <select id="proposal-sort">
                    ${PROPOSAL_SORT_OPTIONS.map(option => `
                        <option value="${option.value}" ${option.value === proposalListState.sortKey ? 'selected' : ''}>${option.label}</option>
                    `).join('')}
                </select>
            </div>
            <button class="proposal-filter-reset" id="proposal-filter-reset" title="Reset filters">Reset</button>
        </div>
    `;

    modal.innerHTML = `
        <div class="proposal-list-modal-content">
            <div class="proposal-list-modal-header">
                <h2>Parcel Proposals</h2>
                <button class="proposal-list-modal-close" onclick="closeProposalList()">&times;</button>
            </div>
            ${controlsHtml}
            <div class="proposal-list-tabs">
                <button class="proposal-tab-btn ${proposalListState.activeTab === 'active' ? 'active' : ''}" data-tab="active">
                    Active (${filteredActive.length}${filteredActive.length !== activeDataset.length ? `/${activeDataset.length}` : ''})
                </button>
                <button class="proposal-tab-btn ${proposalListState.activeTab === 'executed' ? 'active' : ''}" data-tab="executed">
                    Executed (${filteredExecuted.length}${filteredExecuted.length !== executedDataset.length ? `/${executedDataset.length}` : ''})
                </button>
            </div>
            <div class="proposal-list-modal-body">
                <div id="active-proposals-tab" class="proposal-tab-content ${proposalListState.activeTab === 'active' ? 'active' : ''}">
                    ${buildProposalListItemsHtml(sortedActive)}
                </div>
                <div id="executed-proposals-tab" class="proposal-tab-content ${proposalListState.activeTab === 'executed' ? 'active' : ''}">
                    ${buildProposalListItemsHtml(sortedExecuted)}
                </div>
            </div>
        </div>
    `;

    const typeSelect = modal.querySelector('#proposal-filter-type');
    if (typeSelect) {
        typeSelect.addEventListener('change', event => {
            proposalListState.filterType = event.target.value;
            renderProposalListModal();
        });
    }

    const authorInput = modal.querySelector('#proposal-filter-author');
    if (authorInput) {
        authorInput.addEventListener('input', event => {
            proposalListState.authorFilter = event.target.value;
            renderProposalListModal();
        });
    }

    const searchInput = modal.querySelector('#proposal-filter-search');
    if (searchInput) {
        searchInput.addEventListener('input', event => {
            proposalListState.searchText = event.target.value;
            renderProposalListModal();
        });
    }

    const sortSelect = modal.querySelector('#proposal-sort');
    if (sortSelect) {
        sortSelect.addEventListener('change', event => {
            proposalListState.sortKey = event.target.value;
            renderProposalListModal();
        });
    }

    const resetButton = modal.querySelector('#proposal-filter-reset');
    if (resetButton) {
        resetButton.addEventListener('click', event => {
            event.preventDefault();
            proposalListState.filterType = 'all';
            proposalListState.authorFilter = '';
            proposalListState.searchText = '';
            proposalListState.sortKey = 'created-desc';
            renderProposalListModal();
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

    modal.querySelectorAll('.proposal-list-details-btn').forEach(button => {
        button.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            const hash = event.currentTarget.getAttribute('data-proposal-hash');
            if (hash) {
                showProposalDetailsModal(hash);
            }
        });
    });

    const activeTabEl = modal.querySelector('#active-proposals-tab');
    if (activeTabEl) {
        activeTabEl.scrollTop = scrollPositions.active;
    }

    const executedTabEl = modal.querySelector('#executed-proposals-tab');
    if (executedTabEl) {
        executedTabEl.scrollTop = scrollPositions.executed;
    }

    if (proposalListState.selectedHash) {
        const selectedEl = modal.querySelector(`.proposal-list-item[data-proposal-hash="${proposalListState.selectedHash}"]`);
        if (selectedEl && typeof selectedEl.scrollIntoView === 'function') {
            selectedEl.scrollIntoView({ block: 'nearest' });
        }
    }
}

function resetParcelSelectionForProposalListInteraction() {
    try {
        if (typeof multiParcelSelection !== 'undefined' && multiParcelSelection) {
            if (typeof multiParcelSelection.clearSelection === 'function') {
                multiParcelSelection.clearSelection();
            }
            if (typeof multiParcelSelection.clearSingleParcelSelection === 'function') {
                multiParcelSelection.clearSingleParcelSelection();
            }
        }
    } catch (_) { }

    try {
        if (typeof hideParcelInfoPanel === 'function') {
            hideParcelInfoPanel();
        } else {
            const panel = document.getElementById('parcel-info-panel');
            if (panel) {
                panel.classList.remove('visible');
            }
        }
    } catch (_) { }

    try {
        if (typeof refreshParcelStylesForAppliedProposals === 'function') {
            refreshParcelStylesForAppliedProposals();
        }
    } catch (_) { }
}

function handleProposalListItemClick(event) {
    const item = event.currentTarget;
    if (!item) return;

    const hash = item.getAttribute('data-proposal-hash');
    if (!hash) return;

    const proposal = proposalStorage.getProposal(hash);
    if (!proposal) {
        updateStatus('Proposal not found');
        return;
    }

    const isExecuted = (proposal.status || '').toLowerCase() === 'executed';
    const isApplied = isProposalApplied(proposal);

    proposalListState.selectedHash = hash;

    resetParcelSelectionForProposalListInteraction();

    if (isExecuted || isApplied) {
        clearProposalPreview();
        const parcelId = getFirstSelectableParcel(proposal);
        proposalHighlightState.pendingBlink = true;
        selectAndHighlightProposal(hash, parcelId, true, false);
    } else {
        clearProposalHighlights();
        previewProposalOnMap(hash, { center: true, blink: true });
        hideProposalDetailsPanel();
    }

    renderProposalListModal();
}

function showProposalDetailsModal(proposalHash) {
    if (!proposalHash) return;

    const proposal = proposalStorage.getProposal(proposalHash);
    if (!proposal) {
        updateStatus('Proposal not found');
        return;
    }

    proposalListState.selectedHash = proposalHash;

    resetParcelSelectionForProposalListInteraction();

    const isExecuted = (proposal.status || '').toLowerCase() === 'executed';
    const isApplied = isProposalApplied(proposal);

    if (isExecuted || isApplied) {
        clearProposalPreview();
        const parcelId = getFirstSelectableParcel(proposal);
        proposalHighlightState.pendingBlink = true;
        selectAndHighlightProposal(proposalHash, parcelId, false);
    } else {
        clearProposalHighlights();
        previewProposalOnMap(proposalHash, { center: false, blink: false });
        showProposalInfo(proposal);
    }

    renderProposalListModal();
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
function switchProposalTab(clickedTabOrName, maybeTabName) {
    const tabName = typeof maybeTabName === 'string'
        ? maybeTabName
        : (typeof clickedTabOrName === 'string' ? clickedTabOrName : null);

    if (!tabName) return;

    if (proposalListState.activeTab !== tabName) {
        proposalListState.activeTab = tabName;
        renderProposalListModal();
    }
}

// Close proposal list dialog
function closeProposalList() {
    const modal = document.querySelector('.proposal-list-modal');
    if (modal) {
        modal.style.display = 'none';
        // When the Proposal List closes, clear any proposal-specific overlays/highlights
        try { clearProposalInfoHoverOverlay(); } catch (_) { }
        try { clearProposalHighlights(); } catch (_) { }
        proposalListState.selectedHash = null;
    }
}

// Update proposal list (if open)
function updateProposalList() {
    const modal = document.querySelector('.proposal-list-modal');
    if (modal && modal.style.display === 'block') {
        showAllProposalsModal();
    }

    if (typeof refreshBlockInfoProposalTab === 'function') {
        try { refreshBlockInfoProposalTab(); } catch (_) { }
    }
}

// Update the "Proposals List" button text with current count
function updateShowProposalsButton() {
    const button = document.getElementById('showProposalsButton');
    if (button) {
        const totalProposals = proposalStorage.getAllProposals().length;
        button.textContent = `Proposals List (${totalProposals})`;
    }

    // Also sync the proposals presence indicator
    if (typeof syncProposalsIndicator === 'function') {
        syncProposalsIndicator();
    }

    if (typeof refreshBlockInfoProposalTab === 'function') {
        try { refreshBlockInfoProposalTab(); } catch (_) { }
    }
}

// Keep the disabled proposals checkbox in sync with whether proposals exist
function syncProposalsIndicator() {
    const checkbox = document.getElementById('showProposalsCheckbox');
    if (!checkbox) return;
    const total = proposalStorage.getAllProposals().length;
    checkbox.checked = total > 0;
    checkbox.disabled = true; // Always disabled (indicator only)
    if (checkbox.parentElement) {
        checkbox.parentElement.style.opacity = total > 0 ? '1.0' : '0.6';
    }
}

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
function deleteProposal(proposalHash) {
    try {
        const proposal = proposalStorage.getProposal(proposalHash);
        if (!proposal) {
            updateStatus('Error: Proposal not found');
            return;
        }

        const managedByProposalManager = (proposal.type === 'road' && proposal.roadProposal) || (proposal.type === 'building' || !!proposal.buildingProposal);
        if (managedByProposalManager && typeof ProposalManager !== 'undefined' && ProposalManager.deleteProposal) {
            ProposalManager.deleteProposal(proposalHash);
            return;
        }

        // Remove the proposal from storage
        proposalStorage.removeProposal(proposalHash);

        // Clear any proposal highlights if this was the currently highlighted proposal
        if (window.currentlyHighlightedProposal && window.currentlyHighlightedProposal.proposalHash === proposalHash) {
            clearProposalHighlights();
        }

        // Update the proposal layer to remove visual representation
        updateProposalLayer();

        // Update the proposal list if it's open
        updateProposalList();

        // Update the show proposals button count
        updateShowProposalsButton();

        // Hide proposal info panel if it's showing the deleted proposal
        const parcelInfoPanel = document.getElementById('parcel-info-panel');
        if (parcelInfoPanel && parcelInfoPanel.classList.contains('visible')) {
            const panelTitle = document.querySelector('#parcel-info-panel h3');
            if (panelTitle && panelTitle.textContent === 'Proposal Details') {
                hideParcelInfoPanel();
            }
        }

        updateStatus(`Proposal "${proposal.title}" deleted`);

    } catch (error) {
        console.error('Error deleting proposal:', error);
        updateStatus('Error deleting proposal. Please try again.');
    }
}

// Center map on proposal (unified function)
function centerOnProposal(proposalHash) {
    const proposal = proposalStorage.getProposal(proposalHash);
    if (!proposal) return;

    // Use the first parcel as the selected parcel for highlighting
    const firstParcelId = proposal.parcelIds[0];
    if (!firstParcelId) return;

    selectAndHighlightProposal(proposalHash, firstParcelId, true);
}

// Clear all proposals from PersistentStorage
function clearLocalProposalData() {
    try {
        // Get count of proposals before clearing
        const proposalCount = proposalStorage.getAllProposals().length;

        // Clear all proposals from storage
        proposalStorage.clear();

        // Clear any proposal highlights
        clearProposalHighlights();

        // Hide and clear the proposal layer
        if (proposalLayer) {
            map.removeLayer(proposalLayer);
            proposalLayer = null;
        }

        // Uncheck the show proposals checkbox
        const showProposalsCheckbox = document.getElementById('showProposalsCheckbox');
        if (showProposalsCheckbox) {
            showProposalsCheckbox.checked = false;
        }

        // Hide any open proposal info panel
        const parcelInfoPanel = document.getElementById('parcel-info-panel');
        if (parcelInfoPanel && parcelInfoPanel.classList.contains('visible')) {
            const panelTitle = document.querySelector('#parcel-info-panel h3');
            if (panelTitle && panelTitle.textContent === 'Proposal Details') {
                if (typeof hideParcelInfoPanel === 'function') {
                    hideParcelInfoPanel();
                } else {
                    // Fallback manual hiding
                    parcelInfoPanel.classList.remove('visible');
                    const infoContent = document.getElementById('info-content');
                    const proposalsContent = document.getElementById('proposals-content');
                    if (infoContent) infoContent.innerHTML = '';
                    if (proposalsContent) proposalsContent.innerHTML = '';
                }
            }
        }

        // Close proposal list modal if open
        closeProposalList();

        // Update status
        updateStatus(`Cleared ${proposalCount} proposal${proposalCount !== 1 ? 's' : ''} from local storage`);

        // Update the show proposals button count
        updateShowProposalsButton();

    } catch (error) {
        console.error('Error clearing proposal data:', error);
        updateStatus('Error clearing proposal data. Please try again.');
    }
}

function initialiseProposalStorage() {
    proposalStorage.load();
}

if (typeof PersistentStorage !== 'undefined' && PersistentStorage.ensureReady) {
    PersistentStorage.ensureReady(initialiseProposalStorage);
} else {
    initialiseProposalStorage();
}

/**
 * Handle multi-select checkbox change with mutual exclusivity
 */
function handleMultiSelectChange(checked, source) {
    const desiredState = typeof checked === 'boolean'
        ? checked
        : !!(document.getElementById('multiSelectCheckbox') && document.getElementById('multiSelectCheckbox').checked);

    syncMultiSelectCheckboxes(desiredState);

    const showProposalsCheckbox = document.getElementById('showProposalsCheckbox');
    if (desiredState && showProposalsCheckbox && showProposalsCheckbox.checked) {
        showProposalsCheckbox.checked = false;
        updateProposalLayer();
    }

    if (!!multiParcelSelection.isActive !== desiredState) {
        if (desiredState) {
            const preserveSelected = source === 'tools';
            multiParcelSelection.toggle({ preserveSelectedParcel: preserveSelected });
        } else {
            multiParcelSelection.toggle();
        }
    }
}

/**
 * Handle show proposals checkbox change with mutual exclusivity
 */
function handleShowProposalsChange() {
    // No-op: proposal mode removed
}

/**
 * Helper function to enable show proposals mode and clear multi-selection
 * This ensures consistent behavior across all places that enable show proposals
 */
function enableShowProposalsMode() {
    // No-op retained for backward compatibility
}

const SHARE_URL_MAX_LENGTH = 32000;
const SHARE_PAYLOAD_VERSION = 1;

function shareAppliedProposals() {
    try {
        const applied = proposalStorage.getAllProposals().filter(isProposalCurrentlyApplied);
        if (applied.length === 0) {
            if (typeof showEphemeralMessage === 'function') {
                showEphemeralMessage('No applied proposals to share yet.');
            }
            return;
        }

        const payload = buildSharedProposalsPayload(applied);
        if (!payload || !Array.isArray(payload.proposals) || payload.proposals.length === 0) {
            if (typeof showEphemeralMessage === 'function') {
                showEphemeralMessage('Unable to prepare proposals for sharing.', 5000, 'error');
            }
            return;
        }

        const encoded = encodeSharedPayload(payload);
        if (!encoded) {
            if (typeof showEphemeralMessage === 'function') {
                showEphemeralMessage('Failed to encode shared proposal data.', 5000, 'error');
            }
            return;
        }

        const baseUrl = `${window.location.origin}${window.location.pathname}`;
        const shareUrl = `${baseUrl}?shared=${encoded}`;
        const tooLong = shareUrl.length > SHARE_URL_MAX_LENGTH;

        // Always show the share link modal; if too long, include a warning but still allow copying
        showShareLinkModal(shareUrl, payload, { tooLong });
    } catch (error) {
        console.error('shareAppliedProposals failed', error);
        if (typeof showEphemeralMessage === 'function') {
            showEphemeralMessage('Failed to generate share link.', 5000, 'error');
        }
    }
}

function shareSingleProposal(proposalHash) {
    try {
        if (!proposalHash || typeof proposalStorage === 'undefined') {
            return;
        }
        const proposal = proposalStorage.getProposal(proposalHash);
        if (!proposal) {
            if (typeof showEphemeralMessage === 'function') {
                showEphemeralMessage('Cannot share this proposal right now.', 4000, 'error');
            }
            return;
        }

        const payload = buildSharedProposalsPayload([proposal]);
        if (!payload || !Array.isArray(payload.proposals) || payload.proposals.length === 0) {
            if (typeof showEphemeralMessage === 'function') {
                showEphemeralMessage('Unable to prepare proposal for sharing.', 5000, 'error');
            }
            return;
        }

        const encoded = encodeSharedPayload(payload);
        if (!encoded) {
            if (typeof showEphemeralMessage === 'function') {
                showEphemeralMessage('Failed to encode share data.', 5000, 'error');
            }
            return;
        }

        const baseUrl = `${window.location.origin}${window.location.pathname}`;
        const shareUrl = `${baseUrl}?proposalShare=${encoded}`;
        const tooLong = shareUrl.length > SHARE_URL_MAX_LENGTH;
        const introHtml = `Share this link to load proposal <strong>${escapeHtml(proposal.title || 'Untitled')}</strong>.`;
        showShareLinkModal(shareUrl, payload, { tooLong, introHtml });
    } catch (error) {
        console.error('shareSingleProposal failed', error);
        if (typeof showEphemeralMessage === 'function') {
            showEphemeralMessage('Unable to generate share link.', 5000, 'error');
        }
    }
}

function isProposalCurrentlyApplied(proposal) {
    if (!proposal) return false;
    if (proposal.status === 'Executed') return false;
    if (proposal.status === 'Applied') return true;
    if (proposal.roadProposal && proposal.roadProposal.status === 'applied') return true;
    if (proposal.buildingProposal && proposal.buildingProposal.status === 'applied') return true;
    if (proposal.structureProposal && proposal.structureProposal.status === 'applied') return true;
    return false;
}

function buildSharedProposalsPayload(appliedProposals) {
    if (!Array.isArray(appliedProposals) || appliedProposals.length === 0) {
        return null;
    }

    const featuresForBounds = [];
    const sanitized = appliedProposals.map(proposal => {
        const ancestorIdsSet = new Set();

        const sanitizedProposal = {
            proposalHash: proposal.proposalHash,
            proposal_id: (proposal.proposal_id !== undefined && proposal.proposal_id !== null && Number.isFinite(parseInt(proposal.proposal_id, 10))) ? parseInt(proposal.proposal_id, 10) : undefined,
            type: proposal.type || 'parcel',
            title: proposal.title || '',
            description: proposal.description || '',
            author: proposal.author || '',
            createdAt: proposal.createdAt || new Date().toISOString(),
            updatedAt: proposal.updatedAt || proposal.createdAt || new Date().toISOString(),
            offer: typeof proposal.offer === 'number' ? proposal.offer : (proposal.offer || null),
            parcelIds: ensureArrayOfStrings(proposal.parcelIds),
            acceptedParcelIds: ensureArrayOfStrings(proposal.acceptedParcelIds),
            color: proposal.color || null,
            status: 'Applied'
        };

        // Ancestors will be computed per proposal type below (prefer true parents)

        if (proposal.roadProposal) {
            const childFeatures = deepCloneArray(proposal.roadProposal.childFeatures);
            childFeatures.forEach(feature => {
                if (feature) featuresForBounds.push(feature);
            });

            const parentIds = Array.isArray(proposal.roadProposal.parentFeatures)
                ? proposal.roadProposal.parentFeatures.map(feature => feature?.properties?.CESTICA_ID)
                : [];
            ensureArrayOfStrings(parentIds).forEach(id => ancestorIdsSet.add(id));

            sanitizedProposal.roadProposal = {
                definition: deepClone(proposal.roadProposal.definition),
                childFeatures,
                roadGeometry: deepClone(proposal.roadProposal.roadGeometry),
                metadata: deepClone(proposal.roadProposal.metadata),
                id: proposal.roadProposal.id || proposal.roadProposal.proposalId || undefined,
                // Provide explicit parent parcel ids for robust import ordering
                parentParcelIds: (function () {
                    const idsFromParents = Array.isArray(proposal.roadProposal.parentFeatures)
                        ? ensureArrayOfStrings(proposal.roadProposal.parentFeatures.map(f => f?.properties?.CESTICA_ID))
                        : [];
                    if (idsFromParents.length > 0) return idsFromParents;
                    // Fallback: derive from child features' parentParcelId
                    const set = new Set();
                    (childFeatures || []).forEach(f => {
                        const pid = f?.properties?.parentParcelId;
                        if (pid !== undefined && pid !== null) set.add(String(pid));
                    });
                    return Array.from(set);
                })()
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
            parentIds.forEach(id => ancestorIdsSet.add(id));

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
            const parentIds = ensureArrayOfStrings(proposal.parcelIds);
            parentIds.forEach(id => ancestorIdsSet.add(id));
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
            const parentIds = ensureArrayOfStrings(sp.parentParcelIds && sp.parentParcelIds.length ? sp.parentParcelIds : proposal.parcelIds);
            parentIds.forEach(id => ancestorIdsSet.add(id));

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
                : sanitizedProposal.parcelIds);
            reparcelParcelIds.forEach(id => ancestorIdsSet.add(id));

            const clonedOwnerShares = deepCloneArray(proposal.reparcellization.ownerShares);
            const clonedPolygons = deepCloneArray(proposal.reparcellization.polygons);

            sanitizedProposal.type = proposal.type || 'reparcellization';
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

        // If no explicit parents were collected, fall back to this proposal's parcelIds
        if (ancestorIdsSet.size === 0) {
            ensureArrayOfStrings(sanitizedProposal.parcelIds).forEach(id => ancestorIdsSet.add(id));
        }
        const ancestorIds = Array.from(ancestorIdsSet).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
        sanitizedProposal.ancestorParcelIds = ancestorIds;

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

function encodeSharedPayload(payload) {
    try {
        const json = JSON.stringify(payload);
        if (typeof TextEncoder !== 'undefined' && typeof btoa === 'function') {
            const bytes = new TextEncoder().encode(json);
            let binary = '';
            bytes.forEach(byte => {
                binary += String.fromCharCode(byte);
            });
            return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        }
        return encodeURIComponent(json);
    } catch (error) {
        console.error('encodeSharedPayload failed', error);
        return '';
    }
}

function decodeSharedPayload(encoded) {
    if (!encoded) return null;
    let working = encoded.trim();
    try {
        if (/^[A-Za-z0-9_-]+$/.test(working)) {
            working = working.replace(/-/g, '+').replace(/_/g, '/');
            while (working.length % 4 !== 0) {
                working += '=';
            }
            const binary = atob(working);
            if (typeof TextDecoder !== 'undefined') {
                const bytes = new Uint8Array(binary.length);
                for (let i = 0; i < binary.length; i++) {
                    bytes[i] = binary.charCodeAt(i);
                }
                const json = new TextDecoder().decode(bytes);
                return JSON.parse(json);
            }
            const json = decodeURIComponent(escape(binary));
            return JSON.parse(json);
        }

        const json = decodeURIComponent(encoded);
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

function collectCoordinatesFromGeometry(geometry, visitor) {
    if (!geometry || typeof visitor !== 'function') return;
    const { type, coordinates } = geometry;
    if (!type) return;

    switch (type) {
        case 'Point':
            if (Array.isArray(coordinates)) {
                visitor(coordinates[0], coordinates[1]);
            }
            break;
        case 'MultiPoint':
        case 'LineString':
            if (Array.isArray(coordinates)) {
                coordinates.forEach(coord => {
                    if (Array.isArray(coord)) visitor(coord[0], coord[1]);
                });
            }
            break;
        case 'MultiLineString':
        case 'Polygon':
            if (Array.isArray(coordinates)) {
                coordinates.forEach(ring => {
                    if (Array.isArray(ring)) {
                        ring.forEach(coord => {
                            if (Array.isArray(coord)) visitor(coord[0], coord[1]);
                        });
                    }
                });
            }
            break;
        case 'MultiPolygon':
            if (Array.isArray(coordinates)) {
                coordinates.forEach(polygon => {
                    if (Array.isArray(polygon)) {
                        polygon.forEach(ring => {
                            if (Array.isArray(ring)) {
                                ring.forEach(coord => {
                                    if (Array.isArray(coord)) visitor(coord[0], coord[1]);
                                });
                            }
                        });
                    }
                });
            }
            break;
        case 'GeometryCollection':
            if (Array.isArray(geometry.geometries)) {
                geometry.geometries.forEach(inner => collectCoordinatesFromGeometry(inner, visitor));
            }
            break;
        default:
            break;
    }
}

function showShareLinkModal(shareUrl, payload, options = {}) {
    if (typeof document === 'undefined') return;

    const fragment = document.createDocumentFragment();

    if (options && options.tooLong) {
        const warning = document.createElement('p');
        warning.style.color = '#b00020';
        warning.style.fontWeight = '600';
        warning.textContent = 'This URL is probably too large to share';
        fragment.appendChild(warning);
    }

    const intro = document.createElement('p');
    if (options && options.introHtml) {
        intro.innerHTML = options.introHtml;
    } else {
        intro.innerHTML = `Share this link to load ${payload.proposals.length} applied proposal${payload.proposals.length === 1 ? '' : 's'}.`;
    }
    fragment.appendChild(intro);

    const textarea = document.createElement('textarea');
    textarea.className = 'share-modal-link';
    textarea.value = shareUrl;
    textarea.setAttribute('readonly', 'readonly');
    fragment.appendChild(textarea);

    const info = document.createElement('p');
    const zoomValue = payload.camera && typeof payload.camera.zoom === 'number' ? payload.camera.zoom : 'N/A';
    const sizeStats = (function () {
        try {
            const totalProposals = payload.proposals.length;
            const roadCount = payload.proposals.filter(p => p.roadProposal).length;
            const buildingCount = payload.proposals.filter(p => p.buildingProposal).length;
            const parcelCount = payload.proposals.reduce((sum, p) => sum + (Array.isArray(p.parcelIds) ? p.parcelIds.length : 0), 0);
            const bytes = new TextEncoder().encode(JSON.stringify(payload)).length;
            const kb = (bytes / 1024).toFixed(1);
            const maxKb = (SHARE_URL_MAX_LENGTH / 1.33 / 1024).toFixed(0); // rough base64/url-safe overhead estimate
            return `<br><strong>Content:</strong> ${totalProposals} proposals • ${roadCount} roads • ${buildingCount} buildings • ${parcelCount} parcels` +
                `<br><strong>Size:</strong> ~${kb} KB of payload (rough max ~${maxKb} KB before URL limit)`;
        } catch (_) { return ''; }
    })();
    info.innerHTML = `<strong>Author:</strong> ${payload.author || 'Unknown'}<br><strong>Camera zoom:</strong> ${zoomValue}<br><strong>Proposals:</strong> ${payload.proposals.length}${sizeStats}`;
    fragment.appendChild(info);

    const note = document.createElement('p');
    note.style.color = '#555';
    note.innerHTML = 'Server-backed sharing is coming soon. JSON export is provided for archival/manual sharing; future compatibility is not guaranteed.';
    fragment.appendChild(note);

    const modal = showSimpleShareModal({
        title: 'Share Current Plan',
        body: fragment,
        actions: [
            {
                label: 'Copy Link',
                primary: true,
                onClick: () => {
                    if (navigator.clipboard && navigator.clipboard.writeText) {
                        navigator.clipboard.writeText(shareUrl).then(() => {
                            if (typeof showEphemeralMessage === 'function') {
                                showEphemeralMessage('Share link copied to clipboard!');
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
            },
            {
                label: 'Save as JSON',
                onClick: () => {
                    try { savePlanPayloadAsJson(payload); } catch (e) { console.warn('Save JSON failed', e); }
                }
            },
            {
                label: 'Close'
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
    showSimpleShareModal({
        title: 'Proposal Set Too Large',
        body: '<p>Proposal is too large to share via URL -- working on server side sharing, in the meantime, share screenshots or fewer proposals!</p>',
        actions: [{ label: 'Close', primary: true }]
    });
}

function showSimpleShareModal(options = {}) {
    if (typeof document === 'undefined') return null;

    const overlay = document.createElement('div');
    overlay.className = 'share-modal-overlay';

    const modal = document.createElement('div');
    modal.className = 'share-modal';

    const header = document.createElement('div');
    header.className = 'share-modal-header';

    const titleEl = document.createElement('h2');
    titleEl.className = 'share-modal-title';
    titleEl.textContent = options.title || '';
    header.appendChild(titleEl);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'share-modal-close';
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

    const actions = Array.isArray(options.actions) && options.actions.length > 0
        ? options.actions
        : [{ label: 'Close', primary: true }];

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
        button.textContent = action.label || 'Close';
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
            closeModal();
            if (typeof action.onClick === 'function') {
                action.onClick();
            }
        });
        actionsContainer.appendChild(button);
    });

    modal.appendChild(actionsContainer);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    function onOverlayClick(event) {
        if (event.target === overlay) {
            closeModal();
        }
    }

    function onKeyDown(event) {
        if (event.key === 'Escape') {
            closeModal();
        }
    }

    function closeModal() {
        try { overlay.removeEventListener('click', onOverlayClick); } catch (_) { }
        try { document.removeEventListener('keydown', onKeyDown); } catch (_) { }
        try { overlay.remove(); } catch (_) { }
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

let singleProposalShareHandled = false;
let sharedProposalsHandled = false;

function handleSingleProposalShareFromUrl(attempt = 0) {
    try {
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
                title: 'Invalid Share Link',
                body: '<p>We could not decode this shared proposal link. Please ask the sender to regenerate it.</p>',
                actions: [{ label: 'Close', primary: true }]
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
                title: 'No Proposal Found',
                body: '<p>The shared link did not contain a proposal to load.</p>',
                actions: [{ label: 'Close', primary: true }]
            });
            return;
        }

        const sharedProposal = payload.proposals[0];
        (async () => {
            try {
                await loadSharedProposalFromLink(sharedProposal, payload);
            } catch (error) {
                const message = error && error.message
                    ? escapeHtml(error.message)
                    : 'An unknown error occurred while loading the shared proposal.';
                showSimpleShareModal({
                    title: 'Unable to Load Shared Proposal',
                    body: `<p>${message}</p>`,
                    actions: [{ label: 'Close', primary: true }]
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
        if (typeof fetchParcelData === 'function') {
            const bounds = buildBoundsFromSharedPayload(payload);
            await fetchParcelData(bounds || undefined);
        }

        const ancestorIds = computeRequiredAncestorIdsForSharedProposal(sharedProposal);
        const missing = findMissingAncestorParcels(ancestorIds);
        if (missing.length > 0) {
            throw new Error(`Missing required parcels: ${missing.join(', ')}`);
        }

        const normalized = prepareProposalForImport(sharedProposal);
        if (!normalized) {
            throw new Error('Unable to normalise shared proposal data.');
        }

        if (!ensureRoadParentFeaturesForImport(sharedProposal, normalized)) {
            throw new Error('Missing parcel geometry required for this proposal.');
        }

        normalized.status = 'Active';
        normalized.acceptedParcelIds = [];

        const targetHash = normalized.proposalHash || sharedProposal.proposalHash || `shared_${Date.now()}`;
        normalized.proposalHash = targetHash;

        let stored = proposalStorage.getProposal(targetHash);
        if (!stored) {
            const imported = proposalStorage.importProposal(normalized, { overwrite: false, preserveStatus: true });
            stored = imported || proposalStorage.getProposal(targetHash);
        }

        if (!stored) {
            const addedHash = proposalStorage.addProposal({ ...normalized, proposalHash: undefined });
            stored = addedHash ? proposalStorage.getProposal(addedHash) : null;
        }

        if (!stored) {
            throw new Error('Failed to store the shared proposal locally.');
        }

        if (normalized.roadProposal && normalized.roadProposal.parentFeatures && stored.proposalHash) {
            stored.roadProposal = stored.roadProposal || {};
            stored.roadProposal.parentFeatures = normalized.roadProposal.parentFeatures;
            stored.roadProposal.parentParcelIds = ensureArrayOfStrings(normalized.roadProposal.parentFeatures.map(feature => feature?.properties?.CESTICA_ID));
            proposalStorage.proposals.set(stored.proposalHash, stored);
            proposalStorage.save();
        }

        if (suppressedHere) {
            try {
                window.suppressCameraMoves = false;
                suppressedHere = false;
            } catch (_) { }
        }

        await preloadProposalParcelOwners(stored.parcelIds, { forceRefresh: true });

        const focusParcelId = stored.parcelIds?.[0] || (Array.isArray(stored.ancestorParcelIds) ? stored.ancestorParcelIds[0] : null);
        selectAndHighlightProposal(stored.proposalHash, focusParcelId, true);
        showProposalInfo(stored, focusParcelId);
        const panel = document.getElementById('proposal-details-panel');
        if (panel) {
            panel.classList.add('visible');
        }
        if (typeof showEphemeralMessage === 'function') {
            showEphemeralMessage('Shared proposal loaded.');
        }
    } finally {
        if (suppressedHere) {
            try { window.suppressCameraMoves = false; } catch (_) { }
        }
    }
}

async function preloadProposalParcelOwners(parcelIds, options = {}) {
    if (!Array.isArray(parcelIds) || parcelIds.length === 0) {
        return;
    }
    if (typeof ensureParcelOwnerSlots !== 'function') {
        return;
    }
    const forceRefresh = options && options.forceRefresh === true;
    const uniqueIds = Array.from(new Set(
        parcelIds
            .map(id => (id && id.toString ? id.toString() : id))
            .filter(Boolean)
    ));
    if (!uniqueIds.length) {
        return;
    }

    await Promise.allSettled(uniqueIds.map(async parcelId => {
        try {
            await ensureParcelOwnerSlots(parcelId, { forceRefresh });
        } catch (error) {
            console.warn('preloadProposalParcelOwners: failed to fetch owners for', parcelId, error);
        }
    }));
}

function buildBoundsFromSharedPayload(payload) {
    try {
        if (payload && payload.bbox && typeof L !== 'undefined' && L && typeof L.latLngBounds === 'function') {
            const { south, west, north, east } = payload.bbox;
            if ([south, west, north, east].every(value => Number.isFinite(value))) {
                return L.latLngBounds([
                    [south, west],
                    [north, east]
                ]);
            }
        }
    } catch (_) { }
    return null;
}

function handleSharedProposalsFromUrl(attempt = 0) {
    try {
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
                title: 'Invalid Shared Proposals Link',
                body: '<p>We could not decode the shared proposals link. Please ask the sender to regenerate it.</p>',
                actions: [{ label: 'Close', primary: true }]
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
                title: 'No Proposals Found',
                body: '<p>The shared link did not contain any proposals to apply.</p>',
                actions: [{ label: 'Close', primary: true }]
            });
            return;
        }

        // Before applying anything, show a full payload inspector with per-proposal checkboxes
        ; (async () => {
            try {
                const selected = await showSharedPayloadInspector(payload);
                if (!selected || !(selected instanceof Set)) {
                    if (typeof showEphemeralMessage === 'function') {
                        showEphemeralMessage('Shared proposal import cancelled.');
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

async function applySharedProposalsFromPayload(payload, selectedHashes) {
    try {
        // Suppress camera moves for the duration of shared apply
        try { window.suppressCameraMoves = true; } catch (_) { }
        let proposals = Array.isArray(payload.proposals) ? payload.proposals.slice() : [];
        if (selectedHashes && selectedHashes.size >= 0) {
            proposals = proposals.filter(p => selectedHashes.has(p.proposalHash));
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

        const sorted = proposals.slice().sort((a, b) => {
            const aId = parseInt(a.proposal_id, 10);
            const bId = parseInt(b.proposal_id, 10);
            const aHasId = Number.isFinite(aId);
            const bHasId = Number.isFinite(bId);
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

        const actuallyApplied = [];
        const skipped = [];
        const failures = [];

        for (const proposal of sorted) {
            try { if (typeof updateStatus === 'function') updateStatus(`Applying shared proposal ${proposal.title || ''} #${parseInt(proposal.proposal_id, 10) || '?'}…`); } catch (_) { }
            const result = await importAndApplySharedProposal(proposal);
            if (result && result.skipped) {
                skipped.push(proposal.proposalHash);
            } else if (result && result.applied) {
                actuallyApplied.push(proposal.proposalHash);
            } else {
                failures.push(proposal.proposalHash);
                // On first failure, compute missing ancestors for this proposal and stop processing
                const required = computeRequiredAncestorIdsForSharedProposal(proposal);
                const missingForThis = findMissingAncestorParcels(required);
                const title = `${proposal.title || '(Untitled)'}${Number.isFinite(parseInt(proposal.proposal_id, 10)) ? ` (ID #${parseInt(proposal.proposal_id, 10)})` : ''}`;
                const successCount = actuallyApplied.length;
                const bodyLines = [];
                bodyLines.push(`<p>Stopped applying at proposal: <strong>${escapeHtml(title)}</strong> · ${escapeHtml(proposal.proposalHash || '')}</p>`);
                if (missingForThis.length > 0) {
                    bodyLines.push(`<p>Missing ancestor parcels for this proposal:</p><ul>${missingForThis.slice(0, 10).map(id => `<li>${id}</li>`).join('')}${missingForThis.length > 10 ? '<li>…</li>' : ''}</ul>`);
                } else {
                    bodyLines.push(`<p>The proposal could not be applied. Check console for details.</p>`);
                }
                if (successCount > 0) {
                    bodyLines.push(`<p>Successfully applied ${successCount} proposal${successCount === 1 ? '' : 's'} so far.</p>`);
                }
                const modal = showSimpleShareModal({
                    title: 'Stopped Applying Proposals',
                    body: bodyLines.join(''),
                    actions: [
                        {
                            label: 'Leave as is'
                        },
                        {
                            label: 'Unapply successful proposals',
                            primary: true,
                            onClick: () => {
                                try {
                                    actuallyApplied.forEach(hash => { try { ProposalManager.unapplyProposal(hash); } catch (_) { } });
                                    if (typeof updateProposalLayer === 'function') updateProposalLayer();
                                    if (typeof updateShowProposalsButton === 'function') updateShowProposalsButton();
                                } catch (_) { }
                            }
                        }
                    ]
                });
                return; // stop processing further proposals
            }
            // Wait 3 seconds between applications to visualize the process
            await new Promise(res => setTimeout(res, 3000));
        }

        if (actuallyApplied.length > 0 || skipped.length > 0) {
            if (typeof updateProposalLayer === 'function') {
                updateProposalLayer();
            }
            if (typeof updateShowProposalsButton === 'function') {
                updateShowProposalsButton();
            }
            // Do not auto-enable proposals mode; keep interactions normal
            const bodyLines = [];
            bodyLines.push(`<p>Applied proposals from ${payload.author || 'a collaborator'}.</p>`);
            if (actuallyApplied.length > 0) {
                bodyLines.push(`<p>${actuallyApplied.length} applied.</p>`);
            }
            if (skipped.length > 0) {
                bodyLines.push(`<p>Skipped ${skipped.length} duplicate proposal${skipped.length === 1 ? '' : 's'} (already present).</p>`);
            }
            if (failures.length > 0) {
                bodyLines.push(`<p>${failures.length} failed.</p>`);
            }
            showSimpleShareModal({
                title: 'Applied Shared Proposals',
                body: bodyLines.join(''),
                actions: [
                    { label: 'Close', primary: true },
                    ...(actuallyApplied.length > 0 ? [{
                        label: 'Unapply applied',
                        onClick: () => {
                            try {
                                actuallyApplied.forEach(hash => { try { ProposalManager.unapplyProposal(hash); } catch (_) { } });
                                if (typeof updateProposalLayer === 'function') updateProposalLayer();
                                if (typeof updateShowProposalsButton === 'function') updateShowProposalsButton();
                            } catch (_) { }
                        }
                    }] : [])
                ]
            });

            // Firmly return to parcel-mode hover/leave behavior
            try { clearProposalInfoHoverOverlay(); } catch (_) { }
            try { clearProposalHighlights(); } catch (_) { }
            try { if (typeof setParcelNumberLabelFilter === 'function') setParcelNumberLabelFilter(null); } catch (_) { }
        }

        if (failures.length > 0 && typeof showEphemeralMessage === 'function') {
            showEphemeralMessage(`Failed to apply ${failures.length} shared proposal${failures.length === 1 ? '' : 's'}. Check console for details.`, 6000, 'error');
        }
    } catch (error) {
        console.error('applySharedProposalsFromPayload failed', error);
        if (typeof showEphemeralMessage === 'function') {
            showEphemeralMessage('Failed to apply shared proposals.', 6000, 'error');
        }
    } finally {
        // Re-enable camera moves after shared apply completes
        try { window.suppressCameraMoves = false; } catch (_) { }
    }
}

function computeRequiredAncestorIdsForSharedProposal(sp) {
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
    if (Array.isArray(sp.ancestorParcelIds) && sp.ancestorParcelIds.length > 0) {
        return ensureArrayOfStrings(sp.ancestorParcelIds);
    }
    return ensureArrayOfStrings(sp.parcelIds);
}

// Show a modal that displays the fully decoded shared payload and allows selecting proposals to apply
function showSharedPayloadInspector(payload) {
    return new Promise(resolve => {
        try {
            const container = document.createElement('div');
            container.className = 'shared-payload-inspector';

            // Summary
            const summary = document.createElement('div');
            summary.className = 'spi-summary';
            const total = Array.isArray(payload.proposals) ? payload.proposals.length : 0;
            const bytes = (() => { try { return new TextEncoder().encode(JSON.stringify(payload)).length; } catch (_) { return 0; } })();
            const kb = (bytes / 1024).toFixed(1);
            summary.innerHTML = `
                <p><strong>Author:</strong> ${escapeHtml(payload.author || 'Unknown')}
                &nbsp;•&nbsp;<strong>Version:</strong> ${String(payload.version ?? '')}
                &nbsp;•&nbsp;<strong>Generated:</strong> ${escapeHtml(payload.generatedAt || '')}
                &nbsp;•&nbsp;<strong>Proposals:</strong> ${total}
                &nbsp;•&nbsp;<strong>Payload:</strong> ~${kb} KB</p>
            `;
            container.appendChild(summary);

            // Full JSON view (collapsible)
            const detailsWrap = document.createElement('details');
            const detailsSum = document.createElement('summary');
            detailsSum.textContent = 'View full decoded payload JSON';
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

                const id = `spi-prop-${idx}-${(p.proposalHash || '').slice(0, 8)}`;
                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.id = id;
                checkbox.checked = true;
                checkbox.dataset.hash = p.proposalHash || '';
                checkbox.addEventListener('change', () => {
                    const h = checkbox.dataset.hash;
                    if (!h) return;
                    if (checkbox.checked) selected.add(h); else selected.delete(h);
                });

                // Default add to selection
                if (p.proposalHash) selected.add(p.proposalHash);

                const label = document.createElement('label');
                label.setAttribute('for', id);
                const title = `${p.title || '(Untitled)'}${Number.isFinite(parseInt(p.proposal_id, 10)) ? ` (ID #${parseInt(p.proposal_id, 10)})` : ''}`;
                label.innerHTML = `<strong>${escapeHtml(title)}</strong> • ${escapeHtml(p.type || 'parcel')} • ${escapeHtml(p.proposalHash || '')}`;

                const meta = document.createElement('div');
                meta.className = 'spi-proposal-meta';
                const parcelIds = Array.isArray(p.parcelIds) ? p.parcelIds.join(', ') : '';
                const ancestorIds = Array.isArray(p.ancestorParcelIds) ? p.ancestorParcelIds.join(', ') : '';
                const roadParents = (p.roadProposal && Array.isArray(p.roadProposal.parentParcelIds)) ? p.roadProposal.parentParcelIds.join(', ') : '';
                const buildingParents = (p.buildingProposal && Array.isArray(p.buildingProposal.parentParcelIds)) ? p.buildingProposal.parentParcelIds.join(', ') : '';
                meta.innerHTML = `
                    <small>
                        Parcel IDs: ${escapeHtml(parcelIds)}<br>
                        Ancestor Parcel IDs: ${escapeHtml(ancestorIds)}<br>
                        Road parents: ${escapeHtml(roadParents)}<br>
                        Building parents: ${escapeHtml(buildingParents)}
                    </small>
                `;

                const propDetails = document.createElement('details');
                const propSummary = document.createElement('summary');
                propSummary.textContent = 'Details';
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

            const modal = showSimpleShareModal({
                title: 'Review Shared Proposals',
                body: container,
                actions: [
                    {
                        label: 'Cancel',
                        onClick: () => resolve(null)
                    },
                    {
                        id: 'apply',
                        label: 'Parcels still loading...',
                        primary: true,
                        disabled: true,
                        onClick: () => resolve(selected)
                    }
                ]
            });

            // Extra safety: ensure button starts disabled right after modal mount
            try {
                const applyBtn = modal && typeof modal.getActionButton === 'function' ? modal.getActionButton('apply') : null;
                if (applyBtn) {
                    applyBtn.disabled = true;
                    applyBtn.classList.add('disabled');
                    applyBtn.textContent = 'Parcels still loading...';
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
                            applyBtn.textContent = 'Apply Selected';
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
                        applyBtn.textContent = 'Apply Selected';
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

function savePlanPayloadAsJson(payload) {
    try {
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        a.download = `consensus-plan-${ts}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    } catch (e) {
        console.error('Failed to save plan JSON', e);
        alert('Failed to save JSON.');
    }
}

function gatherAncestorIdsFromSharedProposals(proposals) {
    // Only use the explicit ancestorParcelIds field from each proposal
    const ids = new Set();
    proposals.forEach(p => {
        const list = Array.isArray(p.ancestorParcelIds) ? p.ancestorParcelIds : [];
        ensureArrayOfStrings(list).forEach(id => ids.add(id));
    });
    return ids;
}

function findMissingAncestorParcels(ancestorIds) {
    if (!Array.isArray(ancestorIds) || ancestorIds.length === 0) return [];
    const missing = [];
    ancestorIds.forEach(id => {
        const parcelId = id && id.toString ? id.toString() : String(id);
        if (!parcelId) return;
        const layer = (typeof multiParcelSelection !== 'undefined' && typeof multiParcelSelection.findParcelById === 'function')
            ? multiParcelSelection.findParcelById(parcelId)
            : null;
        if (!layer || !layer.feature) {
            missing.push(parcelId);
        }
    });
    return missing;
}

// Intentionally a no-op to avoid camera movement during shared apply
async function focusMapForSharedPayload(_payload) { return; }

function waitForMapIdle() {
    return new Promise(resolve => {
        if (typeof map === 'undefined' || !map || typeof map.once !== 'function') {
            resolve();
            return;
        }
        let settled = false;
        const timeout = setTimeout(() => {
            if (!settled) {
                settled = true;
                resolve();
            }
        }, 800);
        map.once('moveend', () => {
            if (!settled) {
                settled = true;
                clearTimeout(timeout);
                resolve();
            }
        });
    });
}

function promptMissingAncestorsModal(missing, author, problem) {
    return new Promise(resolve => {
        const limited = missing.slice(0, 8);
        const listHtml = limited.length > 0
            ? `<ul>${limited.map(id => `<li>${id}</li>`).join('')}${missing.length > limited.length ? '<li>…</li>' : ''}</ul>`
            : '';
        const modal = showSimpleShareModal({
            title: 'Missing Ancestor Parcels',
            body: `<p>We could not find ${missing.length} ancestor parcel${missing.length === 1 ? '' : 's'} required to apply the shared proposals${author ? ` from ${author}` : ''}.</p>${problem ? `<p><strong>Problem proposal:</strong> ${problem.title ? escapeHtml(problem.title) : '(Untitled)'}${Number.isFinite(problem.proposal_id) ? ` (ID #${problem.proposal_id})` : ''}${problem.proposalHash ? ` · ${problem.proposalHash}` : ''}</p>` : ''}<p>You can cancel loading or refresh parcel data (this will clear local work) and try again.</p>${listHtml}`,
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
            const confirmRefresh = confirm('Missing ancestor parcels are required to load shared proposals. Refresh parcel data (clears local work)?');
            resolve(confirmRefresh ? 'refresh' : 'cancel');
        }
    });
}

function prepareProposalForImport(sharedProposal) {
    if (!sharedProposal || typeof sharedProposal !== 'object') return null;

    let ancestorIds = ensureArrayOfStrings(sharedProposal.ancestorParcelIds);
    if (ancestorIds.length === 0) {
        ancestorIds = ensureArrayOfStrings(sharedProposal.parcelIds);
    }

    const base = {
        proposalHash: sharedProposal.proposalHash,
        title: sharedProposal.title || sharedProposal.name || null,
        type: sharedProposal.type || sharedProposal.proposalType || null,
        proposal_id: sharedProposal.proposal_id,
        parcelIds: ensureArrayOfStrings(sharedProposal.parcelIds),
        acceptedParcelIds: ensureArrayOfStrings(sharedProposal.acceptedParcelIds),
        author: sharedProposal.author || sharedProposal.createdBy || sharedProposal.owner || null,
        description: typeof sharedProposal.description === 'string' ? sharedProposal.description : '',
        offer: (typeof sharedProposal.offer === 'number') ? sharedProposal.offer : (sharedProposal.offer || null),
        createdAt: sharedProposal.createdAt || new Date().toISOString(),
        updatedAt: sharedProposal.updatedAt || sharedProposal.createdAt || new Date().toISOString(),
        status: sharedProposal.status || 'Active',
        color: sharedProposal.color || null,
        ancestorParcelIds: ancestorIds
    };

    if (base.parcelIds.length === 0 && base.ancestorParcelIds.length > 0) {
        base.parcelIds = base.ancestorParcelIds.slice();
    }

    if (sharedProposal.roadProposal) {
        base.roadProposal = {
            definition: deepClone(sharedProposal.roadProposal.definition),
            childFeatures: deepCloneArray(sharedProposal.roadProposal.childFeatures),
            roadGeometry: deepClone(sharedProposal.roadProposal.roadGeometry),
            metadata: deepClone(sharedProposal.roadProposal.metadata),
            status: 'unapplied',
            parentFeatures: [],
            parentParcelIds: ensureArrayOfStrings(sharedProposal.roadProposal.parentParcelIds)
        };
    }

    if (sharedProposal.buildingProposal) {
        const buildingFeature = sharedProposal.buildingProposal.buildingFeature
            ? deepClone(sharedProposal.buildingProposal.buildingFeature)
            : null;
        base.buildingProposal = {
            parameters: deepClone(sharedProposal.buildingProposal.parameters) || {},
            parentParcelIds: ensureArrayOfStrings(sharedProposal.buildingProposal.parentParcelIds),
            parentParcelNumbers: deepCloneArray(sharedProposal.buildingProposal.parentParcelNumbers),
            ancestorKey: sharedProposal.buildingProposal.ancestorKey || ensureArrayOfStrings(sharedProposal.buildingProposal.parentParcelIds).join('|'),
            buildingFeature,
            status: 'unapplied'
        };
        if (base.buildingProposal.parentParcelIds.length === 0) {
            base.buildingProposal.parentParcelIds = base.ancestorParcelIds.slice();
        }
    } else if (sharedProposal.buildingGeometry) {
        const buildingFeature = {
            type: 'Feature',
            geometry: deepClone(sharedProposal.buildingGeometry),
            properties: deepClone(sharedProposal.buildingProperties) || {}
        };
        base.buildingProposal = {
            parameters: {},
            parentParcelIds: base.ancestorParcelIds.slice(),
            parentParcelNumbers: [],
            ancestorKey: base.ancestorParcelIds.join('|'),
            buildingFeature,
            status: 'unapplied'
        };
    }

    // Structure proposals (parks/squares)
    if (sharedProposal.structureProposal) {
        base.type = 'structure';
        base.structureProposal = {
            kind: (sharedProposal.structureProposal.kind === 'park' || sharedProposal.structureProposal.kind === 'square') ? sharedProposal.structureProposal.kind : 'square',
            geometry: deepClone(sharedProposal.structureProposal.geometry),
            blockName: sharedProposal.structureProposal.blockName || null,
            parentParcelIds: ensureArrayOfStrings(sharedProposal.structureProposal.parentParcelIds && sharedProposal.structureProposal.parentParcelIds.length ? sharedProposal.structureProposal.parentParcelIds : base.ancestorParcelIds)
        };
    }

    if (sharedProposal.reparcellization && Array.isArray(sharedProposal.reparcellization.polygons) && sharedProposal.reparcellization.polygons.length > 0) {
        const reparcelParcelIds = (sharedProposal.reparcellization.parcelIds && sharedProposal.reparcellization.parcelIds.length > 0)
            ? ensureArrayOfStrings(sharedProposal.reparcellization.parcelIds)
            : (base.ancestorParcelIds.length > 0 ? base.ancestorParcelIds.slice() : base.parcelIds.slice());
        const ownerShares = deepCloneArray(sharedProposal.reparcellization.ownerShares);
        const polygons = deepCloneArray(sharedProposal.reparcellization.polygons);

        base.type = 'reparcellization';
        base.reparcellization = {
            algorithm: sharedProposal.reparcellization.algorithm || 'sweep-line',
            generatedAt: sharedProposal.reparcellization.generatedAt || sharedProposal.generatedAt || new Date().toISOString(),
            parcelIds: reparcelParcelIds.slice(),
            totalArea: Number.isFinite(Number(sharedProposal.reparcellization.totalArea))
                ? Number(sharedProposal.reparcellization.totalArea)
                : null,
            ownerShares,
            polygons,
            status: 'unapplied'
        };

        if (base.ancestorParcelIds.length === 0 && reparcelParcelIds.length > 0) {
            base.ancestorParcelIds = reparcelParcelIds.slice();
        }
    }

    return base;
}

function ensureRoadParentFeaturesForImport(sharedProposal, normalized) {
    if (!normalized.roadProposal) return true;
    // Prefer explicit parentParcelIds from shared payload; fallback to childFeatures.parentParcelId; final fallback to ancestorParcelIds
    let candidateIds = [];
    const explicitParents = sharedProposal.roadProposal && Array.isArray(sharedProposal.roadProposal.parentParcelIds)
        ? ensureArrayOfStrings(sharedProposal.roadProposal.parentParcelIds)
        : [];
    if (explicitParents.length > 0) {
        candidateIds = explicitParents;
    } else if (sharedProposal.roadProposal && Array.isArray(sharedProposal.roadProposal.childFeatures)) {
        const set = new Set();
        sharedProposal.roadProposal.childFeatures.forEach(f => {
            const pid = f?.properties?.parentParcelId;
            if (pid !== undefined && pid !== null) set.add(String(pid));
        });
        candidateIds = Array.from(set);
    }
    if (candidateIds.length === 0) {
        candidateIds = ensureArrayOfStrings(sharedProposal.ancestorParcelIds.length ? sharedProposal.ancestorParcelIds : normalized.parcelIds);
    }
    const parentFeatures = [];
    candidateIds.forEach(id => {
        const layer = (typeof multiParcelSelection !== 'undefined' && typeof multiParcelSelection.findParcelById === 'function')
            ? multiParcelSelection.findParcelById(id)
            : null;
        // Also attempt resolving on the exact id if a base id was used
        let resolved = layer;
        if (!resolved) {
            const exactIds = new Set();
            // Try known child suffixes  _1, _2 just in case data source encodes parents like children
            ['_1', '_2', '_3'].forEach(sfx => exactIds.add(`${id}${sfx}`));
            for (const ex of exactIds) {
                const alt = (typeof multiParcelSelection !== 'undefined' && typeof multiParcelSelection.findParcelById === 'function')
                    ? multiParcelSelection.findParcelById(ex)
                    : null;
                if (alt && alt.feature) { resolved = alt; break; }
            }
        }
        if (resolved && resolved.feature) {
            parentFeatures.push(deepClone(resolved.feature));
        }
    });
    if (parentFeatures.length === 0) {
        return false;
    }
    normalized.roadProposal.parentFeatures = parentFeatures;
    return true;
}

async function importAndApplySharedProposal(sharedProposal) {
    if (!sharedProposal || !sharedProposal.proposalHash) return { applied: false, skipped: false };

    const normalized = prepareProposalForImport(sharedProposal);
    if (!normalized) return { applied: false, skipped: false };

    // Ensure parents for road proposals before any attempt
    if (!ensureRoadParentFeaturesForImport(sharedProposal, normalized)) {
        console.warn('Missing parent features for road proposal', sharedProposal.proposalHash);
        return { applied: false, skipped: false };
    }

    const existing = proposalStorage.getProposal(normalized.proposalHash);
    if (existing) {
        // If already applied or executed, skip as duplicate
        const alreadyApplied = isProposalCurrentlyApplied(existing) || existing.status === 'Executed';
        if (alreadyApplied) {
            try { if (typeof syncProposalsIndicator === 'function') syncProposalsIndicator(); } catch (_) { }
            return { applied: false, skipped: true };
        }
        // Try applying existing without re-importing (idempotent)
        // For roads, ensure parent features exist on stored object
        if (normalized.roadProposal && normalized.roadProposal.parentFeatures) {
            existing.roadProposal = existing.roadProposal || {};
            existing.roadProposal.parentFeatures = normalized.roadProposal.parentFeatures;
            existing.roadProposal.parentParcelIds = ensureArrayOfStrings(normalized.roadProposal.parentFeatures.map(feature => feature?.properties?.CESTICA_ID));
            proposalStorage.proposals.set(existing.proposalHash, existing);
            proposalStorage.save();
        }
        const appliedExisting = ProposalManager.applyProposal(existing.proposalHash);
        try { if (typeof syncProposalsIndicator === 'function') syncProposalsIndicator(); } catch (_) { }
        return { applied: !!appliedExisting, skipped: false };
    }

    // Fresh import then apply
    const imported = proposalStorage.importProposal(normalized, { overwrite: true });
    if (!imported) {
        return { applied: false, skipped: false };
    }

    if (normalized.roadProposal && normalized.roadProposal.parentFeatures) {
        imported.roadProposal = imported.roadProposal || {};
        imported.roadProposal.parentFeatures = normalized.roadProposal.parentFeatures;
        imported.roadProposal.parentParcelIds = ensureArrayOfStrings(imported.roadProposal.parentFeatures.map(feature => feature?.properties?.CESTICA_ID));
        proposalStorage.proposals.set(imported.proposalHash, imported);
        proposalStorage.save();
    }

    const applied = ProposalManager.applyProposal(normalized.proposalHash);
    try { if (typeof syncProposalsIndicator === 'function') syncProposalsIndicator(); } catch (_) { }
    return { applied: !!applied, skipped: false };
}

// Make functions available globally
window.showProposalDialog = showProposalDialog;
window.closeProposalDialog = closeProposalDialog;
window.createProposal = createProposal;
window.showAllProposalsModal = showAllProposalsModal;
window.switchProposalTab = switchProposalTab;
window.closeProposalList = closeProposalList;
window.showProposalDetailsModal = showProposalDetailsModal;
window.updateShowProposalsButton = updateShowProposalsButton;
window.updateProposalLayer = updateProposalLayer;
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

window.addEventListener('load', () => {
    setTimeout(() => handleSingleProposalShareFromUrl(), 200);
    setTimeout(() => handleSharedProposalsFromUrl(), 250);
    // Initialize proposals indicator at startup
    setTimeout(() => { try { syncProposalsIndicator(); } catch (_) { } }, 300);
});

// Handle selection of a proposal from the multiple proposals list
function selectProposalFromList(proposalHash, parcelId) {
    const proposal = proposalStorage.getProposal(proposalHash);
    if (!proposal) {
        console.error('Proposal not found:', proposalHash);
        updateStatus('Error: Proposal not found');
        return;
    }

    selectAndHighlightProposal(proposalHash, parcelId, true);
}

// Cancel multi-parcel selection
function cancelMultiParcelSelection() {
    multiParcelSelection.clearSelection();
    updateStatus('Multi-parcel selection cleared');
}

// Set up map event listeners to reapply multi-parcel highlights after move/zoom
function setupMultiParcelHighlightListeners() {
    if (typeof map !== 'undefined' && map && typeof map.on === 'function') {
        map.on('moveend zoomend', function () {
            if (multiParcelSelection.isActive && multiParcelSelection.selectedParcels.size > 0) {
                multiParcelSelection.reapplyMultiParcelHighlights();
            }
        });
        return true;
    }
    return false;
}

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
function acceptProposal(proposalHash, parcelId, ownerKey, metadata = {}) {
    try {
        const proposal = proposalStorage.getProposal(proposalHash);
        if (!proposal) {
            alert('Proposal not found.');
            return null;
        }

        const normalizedParcelId = normalizeParcelId(parcelId);
        if (!normalizedParcelId) {
            alert('Invalid parcel identifier.');
            return null;
        }

        const parcelIds = (proposal.parcelIds || []).map(id => normalizeParcelId(id));
        if (!parcelIds.includes(normalizedParcelId)) {
            alert('This parcel is not part of the proposal.');
            return null;
        }

        proposal.acceptedParcelIds = normalizeParcelIdList(proposal.acceptedParcelIds || []);

        const ownerSlots = getOwnerSlotsForParcel(normalizedParcelId);
        const entry = ensureOwnerAcceptanceEntry(proposal, normalizedParcelId, ownerSlots, { syncWithParcelAcceptance: false });
        if (!entry) {
            alert('Unable to determine owner shares for this parcel.');
            return null;
        }

        let effectiveOwnerKey = ownerKey;
        if (!effectiveOwnerKey) {
            if (entry.ownerOrder.length === 1) {
                effectiveOwnerKey = entry.ownerOrder[0];
            } else {
                alert('Select which owner share you are accepting for.');
                return null;
            }
        }

        if (entry.acceptedOwnerKeys.includes(effectiveOwnerKey)) {
            alert('This owner has already accepted the proposal.');
            return null;
        }

        entry.acceptedOwnerKeys.push(effectiveOwnerKey);
        entry.acceptedBy[effectiveOwnerKey] = {
            agentId: metadata.acceptedByAgentId || null,
            username: metadata.acceptedByName || null,
            acceptedAt: new Date().toISOString()
        };

        proposal.ownerAcceptances[normalizedParcelId] = entry;

        const ownerOrder = entry.ownerOrder.length > 0 ? entry.ownerOrder : entry.acceptedOwnerKeys;
        const parcelFullyAccepted = ownerOrder.length > 0
            ? ownerOrder.every(key => entry.acceptedOwnerKeys.includes(key))
            : entry.acceptedOwnerKeys.length > 0;

        if (parcelFullyAccepted) {
            if (!proposal.acceptedParcelIds.includes(normalizedParcelId)) {
                proposal.acceptedParcelIds.push(normalizedParcelId);
            }
        } else {
            proposal.acceptedParcelIds = proposal.acceptedParcelIds.filter(id => id !== normalizedParcelId);
        }

        proposalStorage.proposals.set(proposalHash, proposal);
        proposalStorage.save();

        const parcelLayer = multiParcelSelection.findParcelById(normalizedParcelId);
        const parcelNumber = parcelLayer?.feature?.properties?.BROJ_CESTICE || normalizedParcelId;

        let proposalExecuted = false;
        if (proposal.acceptedParcelIds.length === parcelIds.length && parcelIds.length > 0) {
            proposal.status = 'Executed';
            proposal.executedAt = new Date().toISOString();
            proposalStorage.proposals.set(proposalHash, proposal);
            proposalStorage.save();
            updateShowProposalsButton();

            if (proposal.type === 'road' && proposal.roadGeometry) {
                const affectedParcels = parcelIds.map(id => {
                    const layer = multiParcelSelection.findParcelById(id);
                    return {
                        id,
                        number: layer?.feature?.properties?.BROJ_CESTICE || id,
                        layer
                    };
                });

                if (proposal.roadGeometry.polygon && proposal.roadGeometry.polygon.coordinates) {
                    const coordinates = proposal.roadGeometry.polygon.coordinates[0];
                    const roadPolygon = coordinates.map(coord => ({ lat: coord[1], lng: coord[0] }));
                    const roadName = proposal.roadGeometry.name || 'New Road';
                    if (typeof updateParcelsWithRoad === 'function') {
                        updateParcelsWithRoad(roadPolygon, affectedParcels, roadName);
                    }
                }
                showEphemeralMessage(`Proposal ${proposal.proposalHash.substring(0, 6)} executed! All ${proposal.parcelIds.length} parcels accepted`);
            } else if (proposal.buildingGeometry && (proposal.buildingGeometry.type === 'Polygon' || proposal.buildingGeometry.type === 'MultiPolygon' || proposal.buildingGeometry.type === 'Feature')) {
                if (typeof ProposalManager !== 'undefined' && typeof ProposalManager.applyProposal === 'function') {
                    try { ProposalManager.applyProposal(proposal.proposalHash); } catch (err) { console.warn('Failed to reapply building proposal on execution', err); }
                }
                if (proposal.buildingProposal) {
                    proposal.buildingProposal.status = 'executed';
                }
                if (typeof markProposedBuildingState === 'function') {
                    markProposedBuildingState(proposal.proposalHash, 'executed', { updateLayer: true, save: true });
                } else if (typeof saveExecutedBuildingsToStorage === 'function') {
                    saveExecutedBuildingsToStorage();
                }
                showEphemeralMessage(`Proposal ${proposal.proposalHash.substring(0, 6)} executed! All ${proposal.parcelIds.length} parcels accepted`);
            }
            proposalExecuted = true;
        }

        return {
            ownerAccepted: true,
            parcelAccepted: parcelFullyAccepted,
            proposalExecuted,
            parcelNumber
        };
    } catch (error) {
        console.error('Error accepting proposal:', error);
        alert('Error accepting proposal. Please try again.');
        return null;
    }
}

// Accept proposal function (for specific parcel)
function handleUserAcceptProposal(proposalHash, parcelId, ownerKey = null) {
    const userAgent = typeof getCurrentUserAgent === 'function' ? getCurrentUserAgent() : null;
    if (!userAgent) {
        alert('You must be logged in to accept proposals.');
        return;
    }

    const ownerSlots = getOwnerSlotsForParcel(parcelId);
    let targetSlot = ownerSlots.find(slot => slot.key === ownerKey);
    if (!targetSlot && !ownerKey && ownerSlots.length === 1) {
        targetSlot = ownerSlots[0];
    }

    if (!targetSlot) {
        alert('Please choose which owner share you are accepting for.');
        return;
    }

    if (targetSlot.type === 'agent' && targetSlot.agentId && targetSlot.agentId !== userAgent.id) {
        alert('You can only accept proposals for parcels you own.');
        return;
    }

    const result = acceptProposal(proposalHash, parcelId, targetSlot.key, {
        acceptedByAgentId: userAgent.id,
        acceptedByName: userAgent.name
    });

    if (!result) {
        return;
    }

    const ownerLabel = targetSlot.shareText
        ? `${targetSlot.displayName} (${targetSlot.shareText})`
        : targetSlot.displayName;

    if (result.proposalExecuted) {
        showEphemeralMessage(`Proposal ${proposalHash.substring(0, 8)} executed!`);
        if (typeof addUserActionToGameLog === 'function') {
            addUserActionToGameLog(`<a href="#" data-agent-id="${userAgent.id}" class="agent-link agent-link-clickable">${userAgent.name}</a> executed proposal <a href="#" data-proposal-hash="${proposalHash.substring(0, 8)}" class="proposal-link proposal-link-clickable">${proposalHash.substring(0, 8)}</a> after confirming acceptance for ${ownerLabel}.`);
        }
        if (!userAgent.proposalsExecuted) {
            userAgent.proposalsExecuted = [];
        }
        if (!userAgent.proposalsExecuted.includes(proposalHash)) {
            userAgent.proposalsExecuted.push(proposalHash);
            agentStorage.updateAgent(userAgent.id, { proposalsExecuted: userAgent.proposalsExecuted });
        }
    } else {
        if (typeof addUserActionToGameLog === 'function') {
            addUserActionToGameLog(`<a href="#" data-agent-id="${userAgent.id}" class="agent-link agent-link-clickable">${userAgent.name}</a> recorded acceptance from ${ownerLabel} for parcel ${result.parcelNumber || parcelId} (<a href="#" data-proposal-hash="${proposalHash.substring(0, 8)}" class="proposal-link proposal-link-clickable">${proposalHash.substring(0, 8)}</a>).`);
        }
        if (!userAgent.proposalsAccepted) {
            userAgent.proposalsAccepted = [];
        }
        if (!userAgent.proposalsAccepted.includes(proposalHash)) {
            userAgent.proposalsAccepted.push(proposalHash);
            agentStorage.updateAgent(userAgent.id, { proposalsAccepted: userAgent.proposalsAccepted });
        }
    }

    const updatedProposal = proposalStorage.getProposal(proposalHash);
    if (updatedProposal) {
        showProposalInfo(updatedProposal, parcelId);
    }
}

// Reject proposal function (for specific parcel)
function handleUserRejectProposal(proposalHash, parcelId, ownerKey = null) {
    const userAgent = typeof getCurrentUserAgent === 'function' ? getCurrentUserAgent() : null;
    if (!userAgent) {
        alert('You must be logged in to undo an acceptance.');
        return;
    }

    const proposal = proposalStorage.getProposal(proposalHash);
    if (!proposal) {
        alert('Proposal not found.');
        return;
    }

    // Check if proposal is executed and has descendants
    const proposalStatus = (proposal.status || '').toLowerCase();
    if (proposalStatus === 'executed') {
        if (typeof ProposalManager !== 'undefined' && typeof ProposalManager._getProposalDescendants === 'function') {
            const descendants = ProposalManager._getProposalDescendants(proposalHash);
            if (descendants && descendants.length > 0) {
                alert('Cannot undo acceptance from an executed proposal that has descendant parcels.');
                return;
            }
        }
    }

    const acceptanceState = getProposalOwnerAcceptanceState(proposal, parcelId);
    if (!acceptanceState.entries.length) {
        alert('No recorded owner acceptance to undo.');
        return;
    }

    let targetEntry = acceptanceState.entries.find(entry => entry.key === ownerKey);
    if (!targetEntry) {
        targetEntry = acceptanceState.entries.find(entry => entry.accepted && entry.acceptedByAgentId === userAgent.id);
    }

    if (!targetEntry) {
        alert('Unable to determine which acceptance to undo.');
        return;
    }

    if (targetEntry.acceptedByAgentId && targetEntry.acceptedByAgentId !== userAgent.id) {
        alert('Only the user who recorded this acceptance can undo it.');
        return;
    }

    const result = rejectProposal(proposalHash, parcelId, targetEntry.key);
    if (!result) {
        return;
    }

    const ownerLabel = targetEntry.shareText
        ? `${targetEntry.displayName} (${targetEntry.shareText})`
        : targetEntry.displayName;

    if (typeof addUserActionToGameLog === 'function') {
        addUserActionToGameLog(`<a href="#" data-agent-id="${userAgent.id}" class="agent-link agent-link-clickable">${userAgent.name}</a> revoked acceptance recorded for ${ownerLabel} on parcel ${parcelId}.`);
    }

    if (typeof updateStatus === 'function') {
        updateStatus(`Revoked acceptance for ${ownerLabel} on parcel ${parcelId}.`);
    }

    setTimeout(() => {
        const updatedProposal = proposalStorage.getProposal(proposalHash);
        if (updatedProposal) {
            showProposalInfo(updatedProposal, parcelId);
        }
    }, 0);
}

function rejectProposal(proposalHash, parcelId, ownerKey = null) {
    try {
        const proposal = proposalStorage.getProposal(proposalHash);
        if (!proposal) {
            alert('Proposal not found.');
            return null;
        }

        const normalizedParcelId = normalizeParcelId(parcelId);
        if (!normalizedParcelId) {
            alert('Invalid parcel identifier.');
            return null;
        }

        proposal.ownerAcceptances = normalizeOwnerAcceptances(proposal.ownerAcceptances || {});
        const entry = ensureOwnerAcceptanceEntry(proposal, normalizedParcelId, getOwnerSlotsForParcel(normalizedParcelId), { syncWithParcelAcceptance: false });
        if (!entry || !entry.acceptedOwnerKeys || entry.acceptedOwnerKeys.length === 0) {
            alert('This parcel has not accepted the proposal yet.');
            return null;
        }

        let targetOwnerKey = ownerKey;
        if (!targetOwnerKey) {
            if (entry.acceptedOwnerKeys.length === 1) {
                targetOwnerKey = entry.acceptedOwnerKeys[0];
            } else {
                alert('Please specify which owner acceptance to undo.');
                return null;
            }
        }

        if (!entry.acceptedOwnerKeys.includes(targetOwnerKey)) {
            alert('This owner has not accepted the proposal yet.');
            return null;
        }

        entry.acceptedOwnerKeys = entry.acceptedOwnerKeys.filter(key => key !== targetOwnerKey);
        if (entry.acceptedBy && entry.acceptedBy[targetOwnerKey]) {
            delete entry.acceptedBy[targetOwnerKey];
        }
        proposal.ownerAcceptances[normalizedParcelId] = entry;

        const ownerOrder = entry.ownerOrder.length > 0 ? entry.ownerOrder : entry.acceptedOwnerKeys;
        const parcelFullyAccepted = ownerOrder.length > 0
            ? ownerOrder.every(key => entry.acceptedOwnerKeys.includes(key))
            : entry.acceptedOwnerKeys.length > 0;

        if (!parcelFullyAccepted) {
            proposal.acceptedParcelIds = normalizeParcelIdList((proposal.acceptedParcelIds || []).filter(id => id !== normalizedParcelId));
        }

        // If proposal was executed and now has no descendants, change status back to Active
        const proposalStatus = (proposal.status || '').toLowerCase();
        if (proposalStatus === 'executed') {
            if (typeof ProposalManager !== 'undefined' && typeof ProposalManager._getProposalDescendants === 'function') {
                const descendants = ProposalManager._getProposalDescendants(proposalHash);
                if (!descendants || descendants.length === 0) {
                    proposal.status = 'Active';
                    delete proposal.executedAt;
                }
            }
        }

        proposalStorage.proposals.set(proposalHash, proposal);
        proposalStorage.save();

        setTimeout(() => {
            if (typeof applyProposalHighlights === 'function') {
                applyProposalHighlights();
            }
        }, 10);

        return { ownerKey: targetOwnerKey, parcelAccepted: parcelFullyAccepted };
    } catch (error) {
        console.error('Error rejecting proposal:', error);
        alert('Error rejecting proposal. Please try again.');
        return null;
    }
}

// Ensure this runs after the main DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    // Event listener for the "Show Proposals" checkbox
    const showProposalsCheckbox = document.getElementById('showProposalsCheckbox');
    if (showProposalsCheckbox) {
        showProposalsCheckbox.addEventListener('change', updateProposalLayer);
    }

    // Initialize the show proposals button count
    updateShowProposalsButton();
});

// Make objects globally available
window.proposalStorage = proposalStorage;
window.multiParcelSelection = multiParcelSelection;
window.getProposalOwnerAcceptanceState = getProposalOwnerAcceptanceState;
window.buildOwnerAcceptanceSectionHtml = buildOwnerAcceptanceSectionHtml;
window.handleUserRejectProposal = handleUserRejectProposal;
window.handleProposalParcelClick = handleProposalParcelClick;

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
window.addEventListener('parcelDataLoaded', () => {
    // 1) If proposal mode is active, restyle parcels & handlers
    const showProposalsCheckbox = document.getElementById('showProposalsCheckbox');
    if (showProposalsCheckbox && showProposalsCheckbox.checked && typeof updateProposalLayer === 'function') {
        updateProposalLayer();
    }

    // 2) If a single parcel is selected (parcel mode), restore its highlight
    if (window.selectedParcelId && typeof parcelLayer !== 'undefined' && parcelLayer) {
        const layer = parcelLayer.getLayers().find(l => l.feature && l.feature.properties && l.feature.properties.CESTICA_ID.toString() === window.selectedParcelId.toString());
        if (layer && typeof selectedParcelStyle !== 'undefined') {
            layer.setStyle(selectedParcelStyle);
            layer.bringToFront();
        }
    }

    // 3) If block layer logic needs refresh it can listen separately; we keep focus on proposals/selection here
});

// Proposal Info hover overlay helpers
function showProposalInfoHoverOverlay(parcelId) {
    try {
        if (!parcelId) return;
        if (typeof isProposalUIActive === 'function' && !isProposalUIActive()) {
            // Proposal UI is not active; do not show proposal-style hover
            return;
        }
        highlightParcelHover(parcelId, {
            color: '#00FFFF',
            weight: 6,
            dashArray: '',
            showLabels: true
        });
    } catch (error) {
        console.warn('showProposalInfoHoverOverlay failed', error);
    }
}

function clearProposalInfoHoverOverlay() {
    try {
        clearProposalHoverLayers();
    } catch (error) {
        console.warn('clearProposalInfoHoverOverlay failed', error);
    }
}