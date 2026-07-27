// proposals/storage.js — extracted from proposals.js (behavior-preserving relocation).

function resolveProposalResourceUrl(url) {
    const value = typeof url === 'string' ? url.trim() : '';
    if (!value) return '';
    if (/^(https?:|data:|blob:)/i.test(value)) return value;
    if (value.startsWith('ipfs://')) {
        const ipfsPath = value.slice('ipfs://'.length).replace(/^ipfs\//i, '');
        return ipfsPath ? `https://ipfs.io/ipfs/${ipfsPath}` : '';
    }
    if (value.startsWith('walrus://')) {
        const blobId = value.slice('walrus://'.length).replace(/^\/+/, '');
        return blobId ? `${walrusAggregatorBase()}/v1/blobs/${blobId}` : '';
    }
    if (typeof window === 'undefined' || !window.location) return value;
    try {
        if (value.startsWith('//')) {
            return `${window.location.protocol}${value}`;
        }
        if (value.startsWith('/')) {
            return new URL(value, window.location.origin).toString();
        }
        return new URL(value, window.location.href).toString();
    } catch (_) {
        return value;
    }
}

function isInCity(parcelId, cityId) {
    if (!parcelId) return false;
    const id = parcelId.toString().trim();
    if (!id) return false;
    const upper = id.toUpperCase();
    const city = (cityId || '').toString().toLowerCase();

    if (city === 'zagreb') {
        return upper.startsWith('HR-');
    }
    if (city === 'belgrade') {
        return upper.startsWith('SR-');
    }
    if (city === 'ljubljana') {
        return upper.startsWith('SI-');
    }
    if (city === 'buenos_aires') {
        const baPattern = /^\d{3}-\d{3}-[0-9A-Z]+$/;
        return upper.startsWith('AR-') || baPattern.test(upper);
    }
    if (city === 'colorado') {
        return upper.startsWith('US-CO-');
    }
    if (city === 'new_york') {
        return upper.startsWith('US-NY-');
    }

    // Unknown city: refuse the parcel rather than silently letting cross-city
    // ids through. Every configured city is enumerated above, so reaching
    // this point means either an unconfigured city or a caller passing junk.
    return false;
}

function normalizeLensEntries(entries) {
    const sanitized = [];
    if (!Array.isArray(entries)) return sanitized;
    const seen = new Set();
    entries.forEach(item => {
        const address = typeof item === 'string'
            ? item
            : (item && (item.address || item.addr || item.value || item.wallet));
        const name = item && typeof item === 'object'
            ? (item.name || item.label || item.title || '')
            : '';
        const normalizedAddress = address ? String(address).trim() : '';
        const normalizedName = name ? String(name).trim() : '';
        const key = normalizedAddress.toLowerCase();
        if (!normalizedAddress && !normalizedName) {
            return;
        }
        if (normalizedAddress) {
            if (seen.has(key)) {
                return;
            }
            seen.add(key);
        }
        sanitized.push({ address: normalizedAddress, name: normalizedName });
    });
    return sanitized;
}

function getProposalLensEntries(proposal, options = {}) {
    const preferFallback = options.fallbackToGlobal === true;
    if (!proposal || typeof proposal !== 'object') return [];
    const candidates = [
        proposal.lens,
        proposal.lensEntries,
        proposal.lensAddresses,
        proposal.trustedLens
    ];
    for (const candidate of candidates) {
        const normalized = normalizeLensEntries(candidate);
        if (normalized.length) return normalized;
    }
    if (preferFallback && typeof getLensEntries === 'function') {
        return normalizeLensEntries(getLensEntries());
    }
    return [];
}

function getOwnerSlotsForParcel(parcelId) {
    const tProposalUI = getProposalI18nHelper();
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
        displayName: tProposalUI('panel.parcel.owner.single', 'Single owner'),
        shareText: '1',
        shareDetail: '',
        type: 'unknown',
        agentId: null,
        placeholder: true
    }];
}

function getProposalI18nHelper() {
    const api = (typeof window !== 'undefined') ? window.i18n : null;
    const format = (template, values = {}) => {
        if (!template) return '';
        return String(template).replace(/\{\{\s*(\w+)\s*\}\}|\{(\w+)\}/g, (match, k1, k2) => {
            const k = k1 || k2;
            return Object.prototype.hasOwnProperty.call(values, k) ? values[k] : match;
        });
    };
    return (key, fallback, params = {}) => {
        if (api && typeof api.t === 'function') {
            const translated = api.t(key, params);
            if (translated && translated !== key) {
                return translated;
            }
        }
        return format(fallback, params);
    };
}

function requirePersonalizedUser() {
    const t = getProposalI18nHelper();
    if (typeof getCurrentUserAgent !== 'function') {
        return false; // Can't check, allow through
    }
    const agent = getCurrentUserAgent();
    if (!agent || !agent.isGuest) {
        return false; // Not a guest, allow through
    }
    // User is a guest - prompt them to personalize
    if (typeof showWelcomeModal === 'function') {
        showWelcomeModal();
    }
    if (typeof showEphemeralMessage === 'function') {
        const message = t(
            'ephemeral.messages.personalize_to_create_proposal',
            'Please personalize your profile to create proposals.'
        );
        showEphemeralMessage(message);
    }
    return true; // Blocked - user is guest
}

function hashStringDeterministic(str, seed = 0) {
    let h1 = 0xdeadbeef ^ seed;
    let h2 = 0x41c6ce57 ^ seed;
    for (let i = 0; i < str.length; i++) {
        const ch = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    const combined = 4294967296 * (2097151 & h2) + (h1 >>> 0);
    return combined.toString(36);
}

function getProposalKey(proposal) {
    if (!proposal) return null;
    if (proposal.proposalId !== undefined && proposal.proposalId !== null) {
        return String(proposal.proposalId);
    }
    if (proposal.proposalId) {
        return String(proposal.proposalId);
    }
    return null;
}

function getProposalByIdOrHash(idOrHash) {
    if (typeof proposalStorage === 'undefined') return null;
    const resolved = resolveProposalIdKey(idOrHash);
    return resolved ? proposalStorage.getProposal(resolved) : null;
}

function loadRoadAssetsForCache(proposal) {
    const roadProposal = proposal?.roadProposal || {};
    const manager = (typeof ProposalManager !== 'undefined') ? ProposalManager : null;

    // Always fetch by ID - never cache parentFeatures on proposal objects
    let parentFeatures = [];
    if (manager && typeof manager._loadRoadProposalAssets === 'function') {
        try {
            // Get parent IDs from the proposal data directly (don't call _collectParentParcelIds which might fail)
            const parentIds = Array.isArray(roadProposal.parentParcelIds) && roadProposal.parentParcelIds.length > 0
                ? roadProposal.parentParcelIds
                : (Array.isArray(proposal.parentParcelIds) && proposal.parentParcelIds.length > 0
                    ? proposal.parentParcelIds
                    : (Array.isArray(proposal.parentParcelIds) ? proposal.parentParcelIds : []));
            if (parentIds.length > 0) {
                const loaded = manager._loadRoadProposalAssets(proposal, {
                    includeParents: true,
                    includeChildren: false,
                    includeKeepDetails: false,
                    allowMissing: true
                }) || {};
                if (Array.isArray(loaded.parentFeatures)) {
                    parentFeatures = loaded.parentFeatures;
                }
            }
        } catch (error) {
            // Silently fail - this is just for caching, not critical
            console.debug('loadRoadAssetsForCache: failed to load assets for proposal', error);
        }
    }

    return { parentFeatures };
}

function getFirstSelectableParcel(proposal) {
    if (!proposal || !Array.isArray(proposal.parentParcelIds)) {
        return null;
    }

    for (const parcelId of proposal.parentParcelIds) {
        try {
            const layer = multiParcelSelection.findParcelById(parcelId);
            if (layer) {
                return parcelId;
            }
        } catch (_) {
            // Ignore lookup issues and continue searching
        }
    }

    return proposal.parentParcelIds.length > 0 ? proposal.parentParcelIds[0] : null;
}

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
            const updatedProposal = proposalStorage.getProposal(window.currentlyHighlightedProposal.proposalId);
            if (updatedProposal) {
                // Update the proposal info only if modal is open
                showProposalInfo(updatedProposal, window.selectedParcelInProposal);
            }
        }
    }
}

async function loadAddressesJson() {
    if (addressesJsonCache) return addressesJsonCache;
    if (addressesJsonPromise) return addressesJsonPromise;
    addressesJsonPromise = (async () => {
        try {
            const resp = await fetch('/contracts/addresses.json');
            if (resp && resp.ok) {
                const data = await resp.json();
                addressesJsonCache = data || {};
                return addressesJsonCache;
            }
        } catch (error) {
            console.warn('Failed to load addresses.json', error);
        }
        addressesJsonCache = {};
        return addressesJsonCache;
    })();
    return addressesJsonPromise;
}

function deleteProposal(proposalId) {
    try {
        const proposal = proposalStorage.getProposal(proposalId);
        if (!proposal) {
            updateStatus('Error: Proposal not found');
            return;
        }

        // An edited object remembers what it replaced: deleting it offers a one-jump restore of
        // the original (e.g. the proposal loaded from a shared link) instead of losing both.
        if (proposal.revertSnapshot && typeof window !== 'undefined'
            && typeof window.showStyledChoice === 'function'
            && typeof window.revertProposalToSnapshot === 'function'
            && !proposal.__deleteChoiceResolved) {
            const tHelper = (typeof getProposalI18nHelper === 'function') ? getProposalI18nHelper() : ((k, f) => f);
            const originalName = proposal.revertSnapshot.title || proposal.revertSnapshot.name || '';
            window.showStyledChoice(
                tHelper('modal.deleteProposal.withRevert', 'This object replaced “{{name}}”. Restore that version, or delete everything?', { name: originalName }),
                [
                    { value: 'revert', label: tHelper('modal.deleteProposal.restore', 'Restore previous version'), primary: true },
                    { value: 'delete', label: tHelper('modal.deleteProposal.deleteAll', 'Delete everything') },
                    { value: 'cancel', label: tHelper('modal.deleteProposal.cancel', 'Cancel') }
                ]
            ).then(answer => {
                if (answer === 'revert') {
                    window.revertProposalToSnapshot(proposalId);
                } else if (answer === 'delete') {
                    proposal.__deleteChoiceResolved = true;
                    try { deleteProposal(proposalId); } finally { delete proposal.__deleteChoiceResolved; }
                }
            });
            return;
        }

        const goalKey = resolveProposalGoalKey(proposal, null);
        const managedByProposalManager = (
            goalKey === 'road-track'
            || goalKey === 'buildings'
            || goalKey === 'single'
            || goalKey === 'row'
            || goalKey === 'parcelBased'
            || goalKey === 'park'
            || goalKey === 'square'
            || goalKey === 'lake'
            || goalKey === 'reparcellization'
            || goalKey === 'decide-later'
            || !!proposal.roadProposal
            || !!proposal.buildingProposal
            || !!proposal.structureProposal
            || !!proposal.reparcellization
            || !!proposal.decideLaterProposal
        );
        if (managedByProposalManager && typeof ProposalManager !== 'undefined' && ProposalManager.deleteProposal) {
            ProposalManager.deleteProposal(proposalId);
            return;
        }

        // Remove the proposal from storage
        proposalStorage.removeProposal(proposalId);

        // Clear any proposal highlights if this was the currently highlighted proposal
        if (window.currentlyHighlightedProposal && window.currentlyHighlightedProposal.proposalId === proposalId) {
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
    // Update the button count after loading proposals
    if (typeof updateShowProposalsButton === 'function') {
        updateShowProposalsButton();
    }
}

function checkParcelsOriginal(parcelList) {
    const nonOriginal = [];
    const seen = new Set();
    if (!parcelList) return nonOriginal;

    const list = Array.isArray(parcelList) ? parcelList : Array.from(parcelList);
    list.forEach(entry => {
        let parcelId = null;
        if (entry === undefined || entry === null) return;
        if (typeof entry === 'string' || typeof entry === 'number') {
            parcelId = entry;
        } else if (typeof entry === 'object') {
            parcelId = entry.parcelId || entry.id || entry.parcel_id;
            if (!parcelId && entry.feature && typeof getParcelIdFromFeature === 'function') {
                parcelId = getParcelIdFromFeature(entry.feature);
            }
            if (!parcelId && entry.properties) {
                parcelId = entry.properties.parcelId || entry.properties.parcel_id || entry.properties.id;
            }
        }

        const normalized = parcelId !== undefined && parcelId !== null
            ? (parcelId.toString ? parcelId.toString() : String(parcelId))
            : null;
        if (!normalized || seen.has(normalized)) return;
        seen.add(normalized);

        let ancestors = [];
        try {
            if (typeof ProposalManager !== 'undefined' && ProposalManager && typeof ProposalManager._getParcelAncestors === 'function') {
                ancestors = ProposalManager._getParcelAncestors(normalized) || [];
            } else if (typeof readPersistedParcelRecord === 'function') {
                const props = readPersistedParcelRecord(normalized)?.properties;
                if (props && props.ancestorProposal) {
                    ancestors = [props.ancestorProposal];
                }
            }
        } catch (_) {
            ancestors = [];
        }

        if (Array.isArray(ancestors) && ancestors.length > 0) {
            nonOriginal.push(normalized);
        }
    });

    return nonOriginal;
}

function collectParcelProposalPairs(parcelList) {
    const pairs = [];
    const seen = new Set();
    if (!parcelList) return pairs;

    const list = Array.isArray(parcelList) ? parcelList : Array.from(parcelList);
    list.forEach(entry => {
        let parcelId = null;
        if (entry === undefined || entry === null) return;
        if (typeof entry === 'string' || typeof entry === 'number') {
            parcelId = entry;
        } else if (typeof entry === 'object') {
            parcelId = entry.parcelId || entry.id || entry.parcel_id;
            if (!parcelId && entry.feature && typeof getParcelIdFromFeature === 'function') {
                parcelId = getParcelIdFromFeature(entry.feature);
            }
            if (!parcelId && entry.properties) {
                parcelId = entry.properties.parcelId || entry.properties.parcel_id || entry.properties.id;
            }
        }

        const normalized = parcelId !== undefined && parcelId !== null
            ? (parcelId.toString ? parcelId.toString() : String(parcelId))
            : null;
        if (!normalized || seen.has(normalized)) return;
        seen.add(normalized);

        let ancestors = [];
        try {
            if (typeof ProposalManager !== 'undefined' && ProposalManager && typeof ProposalManager._getParcelAncestors === 'function') {
                ancestors = ProposalManager._getParcelAncestors(normalized) || [];
            } else if (typeof readPersistedParcelRecord === 'function') {
                const props = readPersistedParcelRecord(normalized)?.properties;
                if (props && props.ancestorProposal) {
                    ancestors = [props.ancestorProposal];
                }
            }
        } catch (_) {
            ancestors = [];
        }

        if (Array.isArray(ancestors) && ancestors.length > 0) {
            // Get the first ancestor proposal ID (or all if multiple)
            ancestors.forEach(ancestorProposalId => {
                pairs.push({
                    parcelId: normalized,
                    proposalId: ancestorProposalId
                });
            });
        }
    });

    return pairs;
}

function migrateRoadAssetsToNewId(oldId, newId) {
    if (!oldId || !newId || oldId === newId) return;
    if (typeof proposalStorage !== 'undefined' && typeof proposalStorage.clearRoadAssets === 'function') {
        proposalStorage.clearRoadAssets(oldId);
        proposalStorage.clearRoadAssets(newId);
    }
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
        try {
            const tShare = getShareI18nHelper();
            const message = tShare('saveJsonError', 'Failed to save JSON.');
            const alertFn = (typeof window !== 'undefined' && typeof window.showStyledAlert === 'function') ? window.showStyledAlert : window.alert;
            if (typeof alertFn === 'function') {
                alertFn(message);
            }
        } catch (_) {
            const alertFn = (typeof window !== 'undefined' && typeof window.showStyledAlert === 'function') ? window.showStyledAlert : window.alert;
            if (typeof alertFn === 'function') {
                alertFn('Failed to save JSON.');
            }
        }
    }
}

function getStoredApplyFailureInfo(proposalId) {
    try {
        if (typeof ProposalManager === 'undefined' || !ProposalManager || !proposalId) return null;
        if (typeof ProposalManager.getLastApplyFailureInfo === 'function') {
            const info = ProposalManager.getLastApplyFailureInfo(proposalId);
            if (info && info.message) {
                return {
                    message: String(info.message),
                    code: info.code ? String(info.code) : null,
                    missingIds: ensureArrayOfStrings(info.missingIds || []),
                    // Occupier identity rides along so the shared-plan route can tell intra-plan
                    // occupancy (retry) from a genuine cross-plan conflict (park as overlapped).
                    conflictTitles: ensureArrayOfStrings(info.conflictTitles || []),
                    conflictProposalIds: ensureArrayOfStrings(info.conflictProposalIds || []),
                    at: info.at || null
                };
            }
        }
        if (typeof ProposalManager.getLastApplyFailure === 'function') {
            const message = ProposalManager.getLastApplyFailure(proposalId);
            if (message) {
                return {
                    message: String(message),
                    code: null,
                    missingIds: [],
                    at: null
                };
            }
        }
    } catch (_) { }
    return null;
}
