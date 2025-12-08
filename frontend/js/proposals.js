/*
    Proposals functionality for the cadastre application.
    This file contains the functionality for creating and managing proposals
    including persistence helpers, map highlighting, UI interactions, and
    dependency management between proposals.
*/

const PROPOSALS_STORAGE_KEY = 'cadastre_proposals';
const PROPOSALS_NEXT_ID_KEY = 'cadastre_proposals_nextId';
const PROPOSAL_HASH_PREFIX = 'prop_';

function isLocalProposalId(value) {
    if (value === undefined || value === null) return false;
    const str = String(value);
    return str.startsWith('local-') || str.startsWith('local_prop') || str.startsWith('local-prop');
}

function normalizeParcelId(value) {
    if (value === undefined || value === null) return null;
    const str = value.toString().trim();
    return str.length > 0 ? str : null;
}

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

// --- Translation hydration (pulls from JSON source to avoid hardcoding strings) ---
const proposalListTranslationsHydrated = new Set();

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

async function ensureProposalListTranslations(lang) {
    const api = (typeof window !== 'undefined') ? window.i18n : null;
    if (!api || typeof api.registerTranslations !== 'function') return false;
    const targetLang = lang || (typeof api.getLanguage === 'function' ? api.getLanguage() : 'en');
    if (proposalListTranslationsHydrated.has(targetLang)) return false;
    const cacheBust = (typeof window !== 'undefined' && Array.isArray(window.APP_VERSIONS) && window.APP_VERSIONS.length > 0)
        ? window.APP_VERSIONS[0].version_number
        : Date.now();
    try {
        const response = await fetch(`i18n/${targetLang}.json?proposalListHydrate=${cacheBust}`, { credentials: 'same-origin' });
        if (!response.ok) throw new Error(`Failed to load i18n/${targetLang}.json: ${response.status}`);
        const json = await response.json();
        const flat = flattenObject(json);
        // Only register the proposal list subtree to avoid clobbering other runtime translations
        const subset = {};
        const prefix = 'modal.roadWidth.proposalList.';
        Object.entries(flat).forEach(([k, v]) => {
            if (k.startsWith(prefix)) {
                subset[k] = v;
            }
        });
        if (Object.keys(subset).length > 0) {
            api.registerTranslations(targetLang, subset);
            proposalListTranslationsHydrated.add(targetLang);
            if (typeof api.applyTranslations === 'function') {
                api.applyTranslations();
            }
            return true;
        }
    } catch (err) {
        console.warn('[i18n] Failed to hydrate proposal list translations', err);
    }
    return false;
}
function showProposalAlertMessage(key, fallback, params = {}) {
    const translate = getProposalI18nHelper();
    const message = translate(`alerts.messages.${key}`, fallback, params);
    if (typeof window !== 'undefined' && typeof window.showStyledAlert === 'function') {
        window.showStyledAlert(message);
    } else {
        alert(message);
    }
    return message;
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

    // Check if proposal is expired - disable buttons if so
    const proposalExpired = isProposalExpired(proposal);

    // Compute parcel and owner payout shares
    const offerAmount = Number.isFinite(Number(proposal.offer)) ? Number(proposal.offer) : 0;
    const offerCurrency = proposal.offerCurrency || proposal.currency || '';
    const parcelIds = Array.isArray(proposal?.parcelIds) ? proposal.parcelIds : [];
    const areaMap = new Map();
    let totalArea = 0;
    parcelIds.forEach(id => {
        const layer = multiParcelSelection.findParcelById(id);
        const area = layer?.feature?.properties?.calculatedArea || 0;
        areaMap.set(id, area);
        totalArea += area;
    });
    // Fallback: if no area data, assume equal shares
    if (totalArea <= 0 && parcelIds.length > 0) {
        totalArea = parcelIds.length;
        parcelIds.forEach(id => areaMap.set(id, 1));
    }
    const parcelArea = areaMap.get(parcelId) || 0;
    const parcelAreaShare = totalArea > 0 ? parcelArea / totalArea : 0;
    const parcelPayout = offerAmount * parcelAreaShare;

    const formatPayout = (value) => {
        if (!Number.isFinite(value) || value <= 0) return '';
        const rounded = Math.round(value);
        const roundedText = rounded.toLocaleString(undefined, { maximumFractionDigits: 0 });
        return `${roundedText}${offerCurrency ? ' ' + offerCurrency : ''}`;
    };

    const rowsHtml = entries.map(entry => {
        const safeName = typeof escapeHtml === 'function' ? escapeHtml(entry.displayName || '') : (entry.displayName || getProposalI18nHelper()('panel.proposal.metrics.ownerFallback', 'Owner'));
        const safeShare = entry.shareText ? (typeof escapeHtml === 'function' ? escapeHtml(entry.shareText) : entry.shareText) : '';
        const shareTitle = entry.shareDetail ? (typeof escapeHtml === 'function' ? escapeHtml(entry.shareDetail) : entry.shareDetail) : '';
        const ownerFraction = parseOwnerShareFraction(entry.shareText);
        const ownerPayoutText = formatPayout(parcelPayout * ownerFraction);
        const payoutHtml = ownerPayoutText ? `<span class="owner-payout" style="color:#444; font-size:0.85em;">· ${ownerPayoutText}</span>` : '';
        const shareHtml = safeShare
            ? `<span class="owner-share" style="color:#666; font-size:0.85em;"${shareTitle ? ` title="${shareTitle}"` : ''}>${safeShare}</span>${payoutHtml}`
            : (payoutHtml || '');

        let buttonsHtml = '';
        const tProposalUI = getProposalI18nHelper();
        if (proposalExpired) {
            // Show disabled buttons for expired proposals
            if (entry.accepted) {
                buttonsHtml = `
                    <button class="btn btn-sm btn-outline-secondary" disabled style="font-size: 11px; padding: 2px 6px; min-width: 60px; opacity: 0.5; cursor: not-allowed;" title="${tProposalUI('panel.proposal.expiry.expired', 'Proposal Expired')}">
                        ${tProposalUI('panel.proposal.acceptance.undo', 'Undo')}
                    </button>`;
            } else {
                buttonsHtml = `
                    <button class="btn btn-sm btn-secondary" disabled style="font-size: 11px; padding: 2px 6px; min-width: 60px; opacity: 0.5; cursor: not-allowed;" title="${tProposalUI('panel.proposal.expiry.expired', 'Proposal Expired')}">
                        ${tProposalUI('panel.proposal.acceptance.accept', 'Accept')}
                    </button>`;
            }
        } else if (entry.accepted && entry.canUndo) {
            const rejectCall = skipParcelPanelFocus
                ? `rejectProposalFromParcelInfo('${proposalHash}','${parcelId}','${entry.key}',{skipParcelPanelFocus:true})`
                : `rejectProposalFromParcelInfo('${proposalHash}','${parcelId}','${entry.key}')`;
            buttonsHtml = `
                <button class="btn btn-sm btn-outline-danger" data-owner-key="${entry.key}" onclick="(function(e){e.stopPropagation();e.preventDefault();${rejectCall};return false;})(event)" style="font-size: 11px; padding: 2px 6px; min-width: 60px;">
                    Undo
                </button>`;
        } else if (!entry.accepted && entry.canAccept) {
            const acceptCall = skipParcelPanelFocus
                ? `acceptProposalFromParcelInfo('${proposalHash}','${parcelId}','${entry.key}',{skipParcelPanelFocus:true})`
                : `acceptProposalFromParcelInfo('${proposalHash}','${parcelId}','${entry.key}')`;
            buttonsHtml = `
                <button class="btn btn-sm btn-success" data-owner-key="${entry.key}" onclick="(function(e){e.stopPropagation();e.preventDefault();${acceptCall};return false;})(event)" style="font-size: 11px; padding: 2px 6px; min-width: 60px;">
                    ${tProposalUI('panel.proposal.acceptance.accept', 'Accept')}
                </button>`;
        }

        return `
            <div class="owner-acceptance-row" data-owner-key="${entry.key}" onclick="event.stopPropagation(); event.preventDefault(); return false;" style="display:grid; grid-template-columns: 1fr auto auto; align-items:center; gap:8px; padding:4px 0;">
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

    return `<div class="${compact}" style="width: 100%; box-sizing: border-box;">${rowsHtml}</div>`;
}

function buildParcelAcceptanceStatusHtml(proposal) {
    const tProposalUI = getProposalI18nHelper();
    const parcelIds = Array.isArray(proposal?.parcelIds) ? proposal.parcelIds : [];
    const total = parcelIds.length;
    if (!total) {
        return '';
    }

    const acceptedCount = Math.min(
        Array.isArray(proposal.acceptedParcelIds) ? proposal.acceptedParcelIds.length : 0,
        total
    );

    let circlesHtml = '';
    const acceptedTitle = tProposalUI('panel.proposal.acceptance.accepted', 'Accepted');
    const pendingTitle = tProposalUI('panel.proposal.acceptance.pending', 'Pending');
    for (let i = 0; i < acceptedCount; i++) {
        circlesHtml += `<div class="acceptance-circle accepted" title="${acceptedTitle}"></div>`;
    }
    for (let i = acceptedCount; i < total; i++) {
        circlesHtml += `<div class="acceptance-circle pending" title="${pendingTitle}"></div>`;
    }

    return `
        <div class="proposal-acceptance-status">
            <div class="acceptance-label">${tProposalUI('panel.proposal.acceptance.parcelTitle', 'Parcel Acceptance Status:')}</div>
            <div class="acceptance-circles">${circlesHtml}</div>
        </div>`;
}

function buildOwnerAcceptanceStatusHtml(proposal) {
    const tProposalUI = getProposalI18nHelper();
    const ownerAcceptanceSummary = buildProposalOwnerAcceptanceSummary(proposal);
    if (!ownerAcceptanceSummary.totalOwners) {
        return '';
    }
    try {
        const circlesHtml = ownerAcceptanceSummary.entries.map(entry => {
            if (!entry) return '';
            const parts = [];
            if (entry.displayName) parts.push(entry.displayName);
            if (entry.shareText) parts.push(entry.shareText);
            if (entry.parcelId) parts.push(tProposalUI('panel.proposal.parcels.label', 'Parcel {{id}}', { id: entry.parcelId }));
            parts.push(entry.accepted ? tProposalUI('panel.proposal.acceptance.accepted', 'Accepted') : tProposalUI('panel.proposal.acceptance.pending', 'Pending'));
            const title = parts.join(' • ');
            const safeTitle = typeof escapeHtml === 'function' ? escapeHtml(title) : title;
            return `<div class="acceptance-circle ${entry.accepted ? 'accepted' : 'pending'}" title="${safeTitle}"></div>`;
        }).join('');
        return `
            <div class="proposal-acceptance-status owner">
                <div class="acceptance-label">${tProposalUI('panel.proposal.acceptance.ownerTitle', 'Owner Acceptance Status:')}</div>
                <div class="acceptance-circles">${circlesHtml}</div>
            </div>`;
    } catch (error) {
        console.warn('buildOwnerAcceptanceStatusHtml: failed to build summary', error);
        return '';
    }
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

function autoApplyExecutedProposalToMap(proposal) {
    if (!proposal || !proposal.proposalHash) {
        return false;
    }
    if (typeof ProposalManager === 'undefined' || typeof ProposalManager.applyProposal !== 'function') {
        return false;
    }
    try {
        const applied = ProposalManager.applyProposal(proposal.proposalHash);
        if (applied && typeof window !== 'undefined' && window.currentlyHighlightedProposal && window.currentlyHighlightedProposal.proposalHash === proposal.proposalHash) {
            let refreshed = proposal;
            if (typeof proposalStorage !== 'undefined' && typeof proposalStorage.getProposal === 'function') {
                const stored = proposalStorage.getProposal(proposal.proposalHash);
                if (stored) {
                    refreshed = stored;
                }
            }
            window.currentlyHighlightedProposal = refreshed;
            if (typeof showProposalInfo === 'function') {
                try {
                    showProposalInfo(refreshed, window.selectedParcelInProposal);
                } catch (error) {
                    console.warn('autoApplyExecutedProposalToMap: failed to refresh proposal details', error);
                }
            }
            if (typeof applyProposalHighlights === 'function') {
                try { applyProposalHighlights(); } catch (error) { console.warn('autoApplyExecutedProposalToMap: failed to refresh highlights', error); }
            }
        }
        return applied;
    } catch (error) {
        console.warn('autoApplyExecutedProposalToMap: failed to apply executed proposal', { proposalHash: proposal.proposalHash, error });
        return false;
    }
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

    findProposalByIdOrHash(idOrHash) {
        if (!idOrHash) return null;
        // Direct key lookup
        if (this.proposals.has(idOrHash)) {
            return this.proposals.get(idOrHash);
        }
        const needle = String(idOrHash);
        for (const p of this.proposals.values()) {
            if (p.proposalHash && String(p.proposalHash) === needle) return p;
            if (p.proposalId && String(p.proposalId) === needle) return p;
            if (p.proposal_id !== undefined && p.proposal_id !== null && String(p.proposal_id) === needle) return p;
        }
        return null;
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
            const proposalHashKey = proposal.similarityHash || this._computeSimilarityHash(proposal.parcelIds);
            if (proposalHashKey && proposalHashKey === targetHash) {
                matches.push(proposal);
            }
        }
        return matches;
    },

    importOnChainProposal(raw) {
        if (!raw || !raw.proposalId) return null;
        const proposalId = String(raw.proposalId);
        const parcelIds = Array.isArray(raw.parcelIds) ? raw.parcelIds : [];

        // Try to reuse any already-known record (by id OR hash) to avoid losing richer metadata/titles
        const existing =
            (typeof this.findProposalByIdOrHash === 'function' ? this.findProposalByIdOrHash(proposalId) : null)
            || (raw.proposalHash && typeof this.findProposalByIdOrHash === 'function' ? this.findProposalByIdOrHash(raw.proposalHash) : null)
            || this.proposals.get(proposalId)
            || null;

        // Prefer any already known human-friendly title/name before falling back to raw chain data
        const pickPreferredString = (...candidates) => {
            const typeLabels = Object.values(PROPOSAL_TYPE_LABELS || {}).map(v => String(v).toLowerCase());
            try {
                Object.keys(PROPOSAL_TYPE_LABELS || {}).forEach(key => {
                    const localized = getProposalTypeLabel(key);
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
        const similarityHash = raw.similarityHash || this._computeSimilarityHash(parcelIds);
        let similar = null;
        try {
            for (const p of this.proposals.values()) {
                if (!p) continue;
                const hash = this._computeSimilarityHash(p.parcelIds || []);
                if (hash === similarityHash) {
                    similar = p;
                    break;
                }
            }
        } catch (_) { /* ignore */ }

        const title = pickPreferredString(
            existing && existing.title,
            existing && existing.name,
            existing && existing.blockName,
            existing && existing.structureProposal && existing.structureProposal.blockName,
            existing && existing.metadata && existing.metadata.name,
            existing && existing.metadata && existing.metadata.title,
            existing && existing.onchain && existing.onchain.metadata && existing.onchain.metadata.name,
            existing && existing.onchain && existing.onchain.metadata && existing.onchain.metadata.title,
            similar && similar.title,
            similar && similar.name,
            similar && similar.blockName,
            similar && similar.structureProposal && similar.structureProposal.blockName,
            raw.title,
            raw.name,
            raw.blockName,
            raw.structureProposal && raw.structureProposal.blockName,
            raw.metadata && raw.metadata.name,
            raw.metadata && raw.metadata.title,
            raw.onchain && raw.onchain.metadata && raw.onchain.metadata.name,
            raw.onchain && raw.onchain.metadata && raw.onchain.metadata.title,
            raw.description,
            `Proposal ${proposalId}`
        );

        const description = pickPreferredString(
            raw.description,
            existing && existing.description,
            raw.metadata && raw.metadata.description,
            existing && existing.metadata && existing.metadata.description,
            raw.onchain && raw.onchain.metadata && raw.onchain.metadata.description,
            existing && existing.onchain && existing.onchain.metadata && existing.onchain.metadata.description,
            `Proposal ${proposalId}`
        );
        const author = raw.author || raw.owner || raw.creator || (existing && existing.author) || '';
        const normalizedChainId = typeof normalizeChainId === 'function'
            ? normalizeChainId(raw.chainId || (raw.onchain && raw.onchain.chainId))
            : (raw.chainId || (raw.onchain && raw.onchain.chainId) || null);
        const normalized = {
            proposalId,
            proposalHash: raw.proposalHash || (existing && existing.proposalHash) || proposalId, // legacy compatibility key
            proposal_id: undefined, // on-chain; no local numeric id
            parcelIds,
            title,
            description,
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
            createdAt: raw.createdAt || new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            acceptedParcels: Array.isArray(raw.acceptedParcels) ? raw.acceptedParcels : [],
            similarityHash,
            isMinted: true,
            metadata: raw.metadata || (existing && existing.metadata) || null,
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
            proposalId,
            transactionHash: incomingOnchain.transactionHash || existingOnchain.transactionHash || raw.transactionHash || null,
            contractAddress: incomingOnchain.contractAddress || existingOnchain.contractAddress || raw.contractAddress || null
        };
        if (mergedOnchain.chainId || mergedOnchain.transactionHash || mergedOnchain.contractAddress) {
            normalized.onchain = mergedOnchain;
        }

        // Merge with existing (preserve local extras if any)
        const merged = existing ? { ...existing, ...normalized } : normalized;
        merged.isMinted = true; // ensure minted flag stays true

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
        // The smart contract stores balances in Wei (for ETH) and token units
        if (!merged.offer || typeof merged.offer !== 'number' || merged.offer === 0) {
            // Try to derive offer from ethBalance (in Wei)
            const ethBalanceStr = String(raw.ethBalance || normalized.ethBalance || '0');
            try {
                const ethBalanceWei = BigInt(ethBalanceStr);

                if (ethBalanceWei > 0n) {
                    // Convert Wei to ETH (divide by 10^18)
                    const ethAmount = Number(ethBalanceWei) / 1e18;
                    merged.offer = ethAmount;
                    if (!merged.offerCurrency) {
                        merged.offerCurrency = 'ETH';
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

        this.proposals.set(merged.proposalHash, merged);
        this.save();
        return merged;
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

            // Persist migrated isMinted flags (tokenId-based proposals => minted)
            this.save();
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
        for (const [hash, proposal] of this.proposals.entries()) {
            if (!proposal || proposal.isMinted !== true) continue;
            const proposalChain = typeof normalizeChainId === 'function'
                ? normalizeChainId(proposal.chainId || (proposal.onchain && proposal.onchain.chainId))
                : (proposal.chainId || (proposal.onchain && proposal.onchain.chainId) || null);

            const keep = normalizedTarget && proposalChain === normalizedTarget;
            if (!keep) {
                this.removeProposal(hash);
                removed += 1;
            }
        }
        if (removed > 0 && typeof this.save === 'function') {
            this.save();
        }
        return removed;
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

        // Ensure local proposals have a stable human-friendly ID
        if (!normalized.proposalId || isLocalProposalId(normalized.proposalId)) {
            normalized.proposalId = `local-${normalized.proposal_id}`;
        }

        // Local proposals default to not minted
        if (normalized.isMinted === undefined || normalized.isMinted === null) {
            normalized.isMinted = false;
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
        proposal.similarityHash = proposal.similarityHash || this._computeSimilarityHash(proposal.parcelIds);

        // Normalise numeric local ids and derive a human-readable local proposalId
        if (proposal.proposal_id !== undefined && proposal.proposal_id !== null) {
            const pid = parseInt(proposal.proposal_id, 10);
            if (Number.isFinite(pid)) {
                proposal.proposal_id = pid;
                if (!proposal.proposalId) {
                    proposal.proposalId = `local-${pid}`;
                }
            } else {
                proposal.proposal_id = undefined;
            }
        }

        // Minted flag default
        if (proposal.isMinted === undefined || proposal.isMinted === null) {
            if (proposal.proposalId && !isLocalProposalId(proposal.proposalId)) {
                proposal.isMinted = true;
            } else {
                proposal.isMinted = !!(proposal.onchain && proposal.onchain.transactionHash);
            }
        } else {
            proposal.isMinted = !!proposal.isMinted;
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
                const broj = getParcelDisplayNumberFromFeature(feature);
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
    const checkboxIds = ['multiSelectCheckbox', 'multiSelectCheckboxInfo'];
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
            // Only escalate when there is no known way to recover the parcel.
            const hasFetchers = typeof fetchSingleParcelById === 'function' || typeof fetchParcelsForIds === 'function';
            if (!hasFetchers) {
                console.error('findParcelById: Could not find parcel with ID:', parcelId, 'and no fetcher is available');
            } else {
                // Expected when hydration/fetch will run later (e.g., showProposalInfo).
                console.debug('findParcelById: Parcel missing for now, awaiting hydration for ID:', parcelId);
            }
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

        // Calculate total owners across all parcels
        let totalOwners = 0;
        const ownerKeys = new Set();
        if (typeof getParcelOwnerSlots === 'function') {
            for (const parcel of parcels) {
                const parcelId = parcel.feature?.properties?.CESTICA_ID;
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
            <div style="display: flex; gap: 8px;">
                <div class="metric-group" style="flex: 1;">
                    <div class="metric-label">Selected Parcels:</div>
                    <div class="metric-value">${parcels.length}</div>
                </div>
                <div class="metric-group" style="flex: 1;">
                    <div class="metric-label">Total Area:</div>
                    <div class="metric-value">${Math.round(totalArea).toLocaleString('hr-HR')} m²</div>
                </div>
            </div>
            <div style="display: flex; gap: 8px;">
                <div class="metric-group" style="flex: 1;">
                    <div class="metric-label">Est. Val.:</div>
                    <div class="metric-value">${Math.round(totalEstimatedPrice).toLocaleString('hr-HR')}</div>
                </div>
                <div class="metric-group" style="flex: 1;">
                    <div class="metric-label">Total owners:</div>
                    <div class="metric-value">${totalOwners}</div>
                </div>
            </div>
            <hr style="border: 0; height: 1px; background-color: #ddd; margin: 10px 0;">
            <div class="selected-parcels-section">
                <div class="metric-label">Selected Parcels:</div>
                <div class="selected-parcels-list">
                    ${parcels.map(parcel => {
            const area = parcel.feature.properties.calculatedArea || 0;
            const price = area * (typeof SQM_AVG_PRICE !== 'undefined' ? SQM_AVG_PRICE : 133);
            const isRoad = PersistentStorage.getItem(`parcel_${parcel.feature.properties.CESTICA_ID}_isRoad`) === 'true';
            const parcelNumberDisplay = getParcelDisplayNumberFromProperties(parcel?.feature?.properties, parcel.feature.properties.CESTICA_ID);
            return `
                            <div class="selected-parcel-item">
                                <div class="parcel-number">Parcel ${parcelNumberDisplay || parcel.feature.properties.CESTICA_ID}</div>
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
                <div class="metric-label">${tProposal('panel.proposal.metrics.author', 'Author:')}</div>
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
    const parcelNumber = getParcelDisplayNumberFromProperties(parcel?.feature?.properties, parcelId) || parcelId;

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
                <button type="button" class="proposal-choice-close close-circle-btn close-circle-btn--lg" aria-label="Close proposal chooser" onclick="closeProposalChoiceModal()">&times;</button>
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

function openProposalFromList(proposalHash, options = {}) {
    if (!proposalHash || typeof proposalStorage === 'undefined') {
        return false;
    }

    const normalized = options && typeof options === 'object' ? options : {};
    const proposal = normalized.proposal || proposalStorage.getProposal(proposalHash);
    if (!proposal) {
        updateStatus('Proposal not found');
        return false;
    }

    const parcelIds = Array.isArray(proposal.parcelIds) ? proposal.parcelIds : [];
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

    focusProposalDetails(proposalHash, {
        parcelId: fallbackParcel,
        centerOnProposal: normalized.centerOnProposal !== false,
        showDetails: normalized.showDetails !== false
    });

    return true;
}

window.openProposalFromList = openProposalFromList;

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
const proposalParcelHydrationInFlight = new Set();
function collapseSidebarIfOpen() {
    const sidebar = document.getElementById('sidebar');
    if (!sidebar || sidebar.classList.contains('collapsed')) return;
    if (typeof toggleSidebar === 'function') {
        try { toggleSidebar(); } catch (_) { }
    }
}

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
function showProposalInfo(proposal, currentParcelId = null, preserveScrollPosition = null, skipParcelHydration = false) {
    const i18nProposal = (typeof window !== 'undefined') ? window.i18n : null;
    const formatProposalString = (template, params = {}) => {
        if (!template) return '';
        return String(template).replace(/\{\{\s*(\w+)\s*\}\}|\{(\w+)\}/g, (match, k1, k2) => {
            const key = k1 || k2;
            return Object.prototype.hasOwnProperty.call(params, key) ? params[key] : match;
        });
    };
    const tProposal = (key, fallback, params = {}) => {
        if (i18nProposal && typeof i18nProposal.t === 'function') {
            return i18nProposal.t(key, params);
        }
        return formatProposalString(fallback, params);
    };
    collapseSidebarIfOpen();
    const parcelIds = ensureArrayOfStrings(proposal.parcelIds);

    // If any parcels for this proposal are not loaded, fetch them and re-render once.
    if (!skipParcelHydration && typeof fetchSingleParcelById === 'function') {
        const missingForHydration = parcelIds.filter(id => {
            if (typeof multiParcelSelection === 'undefined' || typeof multiParcelSelection.findParcelById !== 'function') {
                return true;
            }
            const layer = multiParcelSelection.findParcelById(id);
            return !layer || !layer.feature;
        });

        if (missingForHydration.length) {
            const hydrationKey = proposal.proposalHash || `proposal:${parcelIds.join(',')}`;
            if (!proposalParcelHydrationInFlight.has(hydrationKey)) {
                proposalParcelHydrationInFlight.add(hydrationKey);
                (async () => {
                    try {
                        if (typeof fetchParcelsForIds === 'function') {
                            await fetchParcelsForIds(missingForHydration, { forceRefresh: false });
                        } else {
                            await Promise.allSettled(missingForHydration.map(id => fetchSingleParcelById(id)));
                        }
                    } catch (error) {
                        console.warn('showProposalInfo: failed to hydrate missing parcels', missingForHydration, error);
                    } finally {
                        proposalParcelHydrationInFlight.delete(hydrationKey);
                    }
                    // Re-render after attempting to hydrate missing parcels to fill Ancestors list
                    showProposalInfo(proposal, currentParcelId, preserveScrollPosition, true);
                })();
            }
        }
    }

    const parcels = parcelIds.map(id => multiParcelSelection.findParcelById(id))
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
    const ownerAcceptanceStatusHtml = buildOwnerAcceptanceStatusHtml(proposal);
    const ownerAcceptanceSummary = buildProposalOwnerAcceptanceSummary(proposal);
    const parcelAcceptanceStatusHtml = buildParcelAcceptanceStatusHtml(proposal);

    // Update the proposal details panel title
    const proposalPanelTitle = document.getElementById('proposal-details-title');
    if (proposalPanelTitle) {
        proposalPanelTitle.textContent = tProposal('panel.proposal.title', 'Proposal Details');
    }

    const formatAuthorForDisplay = (authorRaw) => {
        const author = authorRaw || '';
        const isHexAddress = author.startsWith('0x') && author.length > 12;
        const truncated = isHexAddress
            ? `${author.slice(0, 6)}...${author.slice(-4)}`
            : author;
        const safeText = typeof escapeHtml === 'function' ? escapeHtml(truncated) : truncated;
        const safeTitle = typeof escapeHtml === 'function' ? escapeHtml(author) : author;
        return `<span class="author-text" style="display: inline-block; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${safeTitle}">${safeText}</span>`;
    };

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
    // Check multiple signals for minted state: explicit flag, onchain data, or tokenId-style proposalId
    const isMinted = fullProposal.isMinted === true
        || !!(fullProposal.onchain && fullProposal.onchain.transactionHash)
        || (fullProposal.proposalId && !isLocalProposalId(fullProposal.proposalId));
    const lifecycleKey = getProposalLifecycleKey(fullProposal);
    const statusBadgeClass = getProposalLifecycleClass(lifecycleKey);
    const statusBadgeLabel = getProposalLifecycleLabel(lifecycleKey);
    const mapStatusBadgeClass = appliedState ? 'applied' : 'not-applied';
    const mapStatusBadgeLabel = appliedState
        ? tProposal('panel.proposal.mapStatus.applied', 'Applied')
        : tProposal('panel.proposal.mapStatus.notApplied', 'Not Applied');
    const disbursementModeRaw = (fullProposal.disbursementMode || proposal.disbursementMode || '').toLowerCase();
    const isConditional = fullProposal.isConditional === true || proposal.isConditional === true || disbursementModeRaw === 'conditional';
    const conditionalBadgeClass = isConditional ? 'conditional' : 'partial';
    const conditionalBadgeLabel = isConditional ? 'Conditional' : 'Partial payouts';
    const conditionalBadgeTitle = isConditional
        ? 'All owners must accept before payout'
        : 'Payout released as each owner accepts';

    let mapActionButtonHtml = '';
    if (supportsMapToggle) {
        const proposalHash = fullProposal.proposalHash || proposal.proposalHash;
        const buttonLabel = appliedState
            ? tProposal('panel.proposal.actions.remove', 'Remove from map')
            : tProposal('panel.proposal.actions.apply', 'Apply to map');
        const iconClass = appliedState ? 'fa-eye-slash' : 'fa-check';
        const buttonClass = appliedState ? 'btn btn-warning' : 'btn btn-success';
        const handler = appliedState
            ? `removeProposalFromMap('${proposalHash}')`
            : `applyProposalToMap('${proposalHash}')`;
        mapActionButtonHtml = `
            <button class="${buttonClass}" onclick="${handler}" style="width: 100%;">
                <i class="fas ${iconClass}"></i> ${buttonLabel}
            </button>
        `;
    }

    const shareButtonHtml = `
        <button class="btn btn-outline-primary btn-share-proposal" onclick="shareSingleProposal('${proposal.proposalHash}')" style="width: 100%;">
            <i class="fas fa-share-alt"></i> ${tProposal('panel.proposal.actions.share', 'Share Proposal')}
        </button>
    `;

    const primaryActionsHtml = `
        <div class="proposal-actions proposal-actions-group" style="display: flex; flex-direction: column; gap: 8px; margin: 12px 0;">
            ${mapActionButtonHtml ? mapActionButtonHtml : ''}
            ${shareButtonHtml}
        </div>
    `;

    const escapedProposalDescription = typeof escapeHtml === 'function'
        ? escapeHtml(proposal.description || '')
        : (proposal.description || '');

    const proposalDisplayId = (() => {
        const hasLegacyId = proposal.proposal_id !== undefined && proposal.proposal_id !== null;
        const parsedLegacyId = hasLegacyId ? parseInt(proposal.proposal_id, 10) : NaN;
        if (Number.isFinite(parsedLegacyId)) return `#${parsedLegacyId}`;

        if (proposal.proposalId) {
            const idStr = String(proposal.proposalId);
            const parsedProposalId = parseInt(idStr, 10);
            return Number.isFinite(parsedProposalId) ? `#${parsedProposalId}` : idStr;
        }

        if (proposal.proposalHash) {
            return String(proposal.proposalHash);
        }

        return null;
    })();

    const escapedProposalDisplayId = proposalDisplayId && typeof escapeHtml === 'function'
        ? escapeHtml(proposalDisplayId)
        : proposalDisplayId;

    // Build expiry countdown HTML if proposal has an expiry set and is not executed
    let expiryCountdownHtml = '';
    const proposalStatus = (proposal.status || '').toLowerCase();
    if (proposal.expiresAt && proposalStatus !== 'executed') {
        const expiresAt = new Date(proposal.expiresAt).getTime();
        const now = Date.now();
        const isExpired = expiresAt <= now;

        if (isExpired) {
            expiryCountdownHtml = `
                <div class="proposal-expiry-countdown expired" style="background: #f8d7da; border: 1px solid #f5c6cb; padding: 10px; border-radius: 6px; margin-bottom: 10px; text-align: center;">
                    <i class="fas fa-clock" style="margin-right: 6px;"></i>
                    <span class="expiry-label" style="color: #721c24; font-weight: 600;">${tProposal('panel.proposal.expiry.expired', 'Proposal Expired')}</span>
                </div>
            `;
        } else {
            expiryCountdownHtml = `
                <div class="proposal-expiry-countdown" data-expires-at="${proposal.expiresAt}" data-proposal-hash="${proposal.proposalHash}" style="background: #fff3cd; border: 1px solid #ffeaa8; padding: 10px; border-radius: 6px; margin-bottom: 10px; text-align: center;">
                    <i class="fas fa-hourglass-half" style="margin-right: 6px; color: #856404;"></i>
                    <span class="expiry-label" style="color: #856404; font-weight: 500;">${tProposal('panel.proposal.expiry.countdown', 'Expires in:')} </span>
                    <span class="expiry-timer" style="color: #856404; font-weight: 700; font-family: monospace;"></span>
                </div>
            `;
        }
    }

    const createdAtLabel = fullProposal.createdAt
        ? new Date(fullProposal.createdAt).toLocaleString(undefined, {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit'
        })
        : '—';

    const content = `
        <div class="proposal-info">
            ${expiryCountdownHtml}
            <div class="proposal-badges-row" style="display: flex; justify-content: center; align-items: center; gap: 6px; margin: 10px 0;">
                <div class="proposal-status ${statusBadgeClass}">${statusBadgeLabel}</div>
                <div class="proposal-application-status ${mapStatusBadgeClass}">
                    ${mapStatusBadgeLabel}
                </div>
                <div class="proposal-conditionality ${conditionalBadgeClass}" title="${conditionalBadgeTitle}">
                    ${conditionalBadgeLabel}
                </div>
                <div class="proposal-mint-state" style="
                    display: inline-flex;
                    align-items: center;
                    gap: 4px;
                    padding: 2px 6px;
                    border-radius: 10px;
                    font-size: 11px;
                    font-weight: 500;
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
                    color: ${isMinted ? '#065f46' : '#7a6000'};
                    background: ${isMinted ? '#d1fae5' : '#fff7d6'};
                    border: 1px solid ${isMinted ? '#34d399' : '#ffe08a'};
                ">
                    ${isMinted ? tProposal('panel.proposal.lifecycle.minted', 'Minted') : tProposal('panel.proposal.lifecycle.inMemory', 'In-memory')}
                </div>
            </div>
            <div class="proposal-description-row" style="text-align: center; margin: 10px 0; padding: 0 10px;">
                ${escapedProposalDescription}
                ${escapedProposalDisplayId ? `<div class="proposal-id-label" style="font-size: 12px; color: #666; margin-top: 4px;">ID: ${escapedProposalDisplayId}</div>` : ''}
            </div>
            ${parcelAcceptanceStatusHtml}
            ${ownerAcceptanceStatusHtml}

            <hr style="border: 0; height: 1px; background-color: #ddd; margin: 15px 0;">
            <div class="metric-group">
                <div class="metric-label">${tProposal('panel.proposal.metrics.author', 'Author:')}</div>
                <div class="metric-value author-with-avatar">
                    ${(() => {
            // Find the agent with matching name
            if (typeof agentStorage !== 'undefined') {
                const agents = agentStorage.getAllAgents();
                const agent = agents.find(a => a.name === proposal.author);
                if (agent && typeof getAvatarImagePath === 'function') {
                    return `
                                        <img src="${getAvatarImagePath(agent.avatarIndex)}" class="author-avatar" style="width: 24px; height: 24px; border-radius: 50%; border: 2px solid #007bff; margin-right: 8px; vertical-align: middle;">
                                        <a href="#" data-agent-id="${agent.id}" class="agent-link agent-link-clickable" style="text-decoration: none; color: #007bff; font-weight: 500;">${formatAuthorForDisplay(proposal.author)}</a>
                                    `;
                }
            }
            return formatAuthorForDisplay(proposal.author);
        })()}
                </div>
            </div>
            ${proposal.offer ? (() => {
            const currentOffer = typeof calculateDecayedOffer === 'function' ? calculateDecayedOffer(proposal) : proposal.offer;
            const decayProgress = proposal.decayEnabled && typeof getDecayProgress === 'function' ? getDecayProgress(proposal) : 0;
            const hasDecay = proposal.decayEnabled && proposal.decayPercent > 0 && proposal.decayDurationMs > 0;
            const decayedPercent = hasDecay ? (proposal.decayPercent * decayProgress) : 0;
            const remainingPercent = 100 - decayedPercent;
            const targetPercent = hasDecay ? (100 - proposal.decayPercent) : 100;
            const currencySymbol = proposal.offerCurrency === 'EUR' ? '€' : '';
            const currencySuffix = proposal.offerCurrency && proposal.offerCurrency !== 'EUR' ? ' ' + proposal.offerCurrency : '';
            const originalAmountText = tProposal('panel.proposal.metrics.offerOriginal', '(was {{amount}})', {
                amount: `${currencySymbol}${proposal.offer.toLocaleString('hr-HR')}${currencySuffix}`
            });

            // Deposit indicator - bars inside offer bar, warning text only if no deposit
            const hasDeposit = proposal.depositEnabled && proposal.depositPercent > 0;
            const depositPercent = hasDeposit ? proposal.depositPercent : 0;

            // Generate deposit bars HTML (to go inside offer bar)
            let depositBarsHtml = '';
            if (hasDeposit) {
                const fullRows = Math.floor(depositPercent / 100);
                const partialPercent = depositPercent % 100;

                for (let i = 0; i < fullRows; i++) {
                    depositBarsHtml += `<div class="deposit-bar-row"><div class="deposit-bar-fill" style="width: 100%;"></div></div>`;
                }
                if (partialPercent > 0 || fullRows === 0) {
                    depositBarsHtml += `<div class="deposit-bar-row"><div class="deposit-bar-fill${fullRows > 0 ? ' overflow' : ''}" style="width: ${partialPercent || depositPercent}%;"></div></div>`;
                }
            }

            // Warning text only shown when no deposit
            const noDepositWarningHtml = !hasDeposit ? `
            <div class="proposal-no-deposit-warning">⚠️ ${tProposal('panel.proposal.offer.noDepositWarning', 'No deposit - proposal not backed by funds')}</div>` : '';
            const boostLabel = tProposal('panel.proposal.boost.buttonLabel', 'Boost this proposal');

            if (hasDecay) {
                return `
            <div class="proposal-offer-bar with-decay${hasDeposit ? ' with-deposit' : ''}" data-proposal-hash="${proposal.proposalHash || ''}" data-original-offer="${proposal.offer}" data-decay-percent="${proposal.decayPercent}" data-decay-duration="${proposal.decayDurationMs}" data-created-at="${proposal.createdAt}">
                <div class="offer-bar-background">
                    <div class="offer-bar-remaining" style="width: ${remainingPercent}%;"></div>
                    <div class="offer-bar-decayed" style="width: ${decayedPercent}%;"></div>
                    <div class="offer-bar-target-line" style="left: ${targetPercent}%;"></div>
                </div>
                <div class="offer-bar-content">
                    <div class="offer-bar-main">
                        <span class="offer-label">${tProposal('panel.proposal.metrics.offer', 'Offer:')}</span>
                        <span class="offer-amount decaying">${currencySymbol}${Math.round(currentOffer).toLocaleString('hr-HR')}${currencySuffix}</span>
                        <span class="offer-original">${originalAmountText}</span>
                    </div>
                    <button type="button" class="offer-boost-button" title="${boostLabel}" aria-label="${boostLabel}" onclick="openProposalBoostDialog('${proposal.proposalHash || proposal.proposalId || ''}')">💪</button>
                </div>
                ${hasDeposit ? `<div class="offer-bar-deposit-container">${depositBarsHtml}</div>` : ''}
            </div>${noDepositWarningHtml}`;
            } else {
                return `
            <div class="proposal-offer-bar${hasDeposit ? ' with-deposit' : ''}">
                <div class="offer-bar-content-simple">
                    <div class="offer-bar-main">
                        <span class="offer-label">${tProposal('panel.proposal.metrics.offer', 'Offer:')}</span>
                        <span class="offer-amount">${currencySymbol}${proposal.offer.toLocaleString('hr-HR')}${currencySuffix}</span>
                    </div>
                    <button type="button" class="offer-boost-button" title="${boostLabel}" aria-label="${boostLabel}" onclick="openProposalBoostDialog('${proposal.proposalHash || proposal.proposalId || ''}')">💪</button>
                </div>
                ${hasDeposit ? `<div class="offer-bar-deposit-container">${depositBarsHtml}</div>` : ''}
            </div>${noDepositWarningHtml}`;
            }
        })() : ''}
            <div class="metric-group">
                <span class="metric-label">${tProposal('panel.proposal.metrics.parcels', 'Parcels in Proposal:')}</span> <span class="metric-value">${proposal.parcelIds.length}</span>
            </div>
            <div class="metric-group">
                <span class="metric-label">${tProposal('panel.proposal.metrics.owners', 'Owners in Proposal:')}</span> <span class="metric-value">${ownerAcceptanceSummary.totalOwners}</span>
            </div>
            <div class="metric-group">
                <span class="metric-label">${tProposal('panel.proposal.metrics.area', 'Total Area:')}</span> <span class="metric-value">${Math.round(totalArea).toLocaleString('hr-HR')} m²</span>
            </div>
            <div class="metric-group">
                <span class="metric-label">${tProposal('panel.proposal.metrics.created', 'Created:')}</span> <span class="metric-value">${createdAtLabel}</span>
            </div>
            <hr style="border: 0; height: 1px; background-color: #ddd; margin: 10px 0;">
            <div class="metric-group">
                <div class="metric-label">${tProposal('panel.proposal.sections.ancestorsParcels', 'Ancestors (Parcels):')}</div>
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

            const parcelNumberDisplay = getParcelDisplayNumberFromProperties(parcel?.feature?.properties, parcelId);
            const parcelLabelText = tProposal('panel.proposal.parcels.label', 'Parcel {{id}}', { id: parcelNumberDisplay || parcelId });
            const parcelTooltip = tProposal('panel.proposal.parcels.tooltip', 'Click to view parcel details');
            const acceptedLabel = tProposal('panel.proposal.acceptance.accepted', 'Accepted');
            const pendingLabel = tProposal('panel.proposal.acceptance.pending', 'Pending');
            return `
                                <div class="proposal-parcel-item" data-parcel-id="${parcelId}" onclick="handleProposalParcelClick('${parcelId}', event)" style="display: flex; flex-direction: column; gap:6px; padding: 8px; border: 1px solid #ddd; margin-bottom: 5px; border-radius: 4px; cursor: pointer; ${hasAccepted ? 'background-color: #f8fff8;' : ''}" title="${parcelTooltip}">
                                <div class="parcel-info" style="display: flex; align-items: center; justify-content: space-between;">
                                    <div style="display:flex; align-items:center; gap:8px;">
                                        ${ownerAvatarHtml}
                                        <div>
                                            <span class="parcel-number" style="font-weight: 500;">${parcelLabelText}</span>
                                            <span style="margin: 0 4px; color: #999;">·</span>
                                            ${hasAccepted ?
                    `<span class="parcel-status parcel-status-accepted" style="color: #28a745; font-size: 12px; font-weight: 500;">✓ ${acceptedLabel}</span>` :
                    `<span class="parcel-status parcel-status-pending" style="color: #666; font-size: 12px;">${pendingLabel}</span>`
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
                    return `
            <div class="metric-group">
                <div class="metric-label">${tProposal('panel.proposal.sections.ancestorsProposals', 'Ancestors (Proposals):')}</div>
                <div class="proposal-ancestors-list">
                    ${ancestors.map(ancestorHash => {
                        const ancestorData = proposalStorage.getProposal(ancestorHash);
                        if (ancestorData) {
                            return `<div class="ancestor-item" data-proposal-hash="${ancestorData.proposalHash || ancestorHash}" tabindex="0" style="padding: 5px; border: 1px solid #ddd; margin: 2px 0; border-radius: 3px; cursor: pointer;">
                                            <strong>${ancestorData.title}</strong> (${ancestorData.type || 'proposal'})
                                        </div>`;
                        }
                        return null;
                    }).filter(Boolean).join('')}
                </div>
            </div>`;
                } else {
                    return `
            <div class="metric-group">
                <div class="metric-label">Ancestors (Proposals):</div>
                <div class="metric-value">0</div>
            </div>`;
                }
            }
            return `
            <div class="metric-group">
                <div class="metric-label">Ancestors (Proposals):</div>
                <div class="metric-value">0</div>
            </div>`;
        })()}
            
            <!-- Descendants Section -->
            ${(() => {
            if (typeof ProposalManager !== 'undefined') {
                const descendants = ProposalManager._getProposalDescendants(proposal.proposalHash);
                if (descendants.length > 0) {
                    return `
            <div class="metric-group">
                <div class="metric-label">${tProposal('panel.proposal.sections.descendantsParcels', 'Descendants (parcels):')}</div>
                <div class="proposal-descendants-list">
                    ${descendants.map(descendant => {
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
                                    parcelNumber = getParcelDisplayNumberFromProperties(layer.feature.properties, parcelNumber);
                                    isRoad = isRoad || !!layer.feature.properties.isRoad;
                                    roadName = roadName || layer.feature.properties.roadName || null;
                                }
                            } catch (_) { }

                            if (!parcelNumber) {
                                try {
                                    const propsStr = PersistentStorage.getItem(`parcel_${descendantKey}_properties`);
                                    if (propsStr) {
                                        const props = JSON.parse(propsStr);
                                        parcelNumber = getParcelDisplayNumberFromProperties(props, parcelNumber);
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
                    }).join('')}
                </div>
            </div>`;
                } else {
                    return `
            <div class="metric-group">
                <div class="metric-label">Descendants (parcels):</div>
                <div class="metric-value">0</div>
            </div>`;
                }
            }
            return `
            <div class="metric-group">
                <div class="metric-label">Descendants (parcels):</div>
                <div class="metric-value">0</div>
            </div>`;
        })()}
            ${primaryActionsHtml}
        </div>
    `;

    // Preserve scroll/anchor before the DOM rewrite
    const panel = document.getElementById('proposal-details-panel');
    const panelBody = panel ? panel.querySelector('.panel-body') : null;
    let preservedScrollTop = panelBody ? panelBody.scrollTop : 0;
    let anchorKey = null;
    let anchorOffset = null;

    if (preserveScrollPosition && typeof preserveScrollPosition === 'object') {
        if (typeof preserveScrollPosition.scrollTop === 'number') {
            preservedScrollTop = preserveScrollPosition.scrollTop;
        }
        if (typeof preserveScrollPosition.anchorKey === 'string') {
            anchorKey = preserveScrollPosition.anchorKey;
        }
        if (typeof preserveScrollPosition.anchorOffset === 'number') {
            anchorOffset = preserveScrollPosition.anchorOffset;
        }
    } else if (typeof preserveScrollPosition === 'number') {
        preservedScrollTop = preserveScrollPosition;
    }

    // Set innerHTML which resets scroll to 0
    document.getElementById('proposal-details-content').innerHTML = content;

    // Restore scroll position or anchor row after the DOM rewrite
    const combinedPreserveState = {
        scrollTop: preservedScrollTop,
        anchorKey,
        anchorOffset,
        parcelId: preserveScrollPosition && typeof preserveScrollPosition === 'object'
            ? preserveScrollPosition.parcelId || currentParcelId || null
            : currentParcelId
    };
    restoreProposalDetailsScroll(combinedPreserveState);

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

    // Initialize expiry countdown timer if present
    initializeExpiryCountdown();

    // Initialize decay countdown animation if present
    initializeDecayCountdown();

    const detailsPanel = document.getElementById('proposal-details-panel');
    if (detailsPanel) detailsPanel.classList.add('visible');
    document.body.classList.add('proposal-details-open');

    // Setup click listeners for any clickable links in the proposal info
    if (typeof setupGameLogClickListeners === 'function') {
        setupGameLogClickListeners();
    }
}

function resolveProposalForBoost(idOrHash) {
    if (typeof proposalStorage !== 'undefined' && typeof proposalStorage.findProposalByIdOrHash === 'function') {
        const found = proposalStorage.findProposalByIdOrHash(idOrHash);
        if (found) return found;
    }
    if (window.currentlyHighlightedProposal) return window.currentlyHighlightedProposal;
    return null;
}

function openProposalBoostDialog(idOrHash = null) {
    const tProposalUI = getProposalI18nHelper();
    const proposal = resolveProposalForBoost(idOrHash);
    if (!proposal) {
        showProposalAlertMessage('proposal_not_found', 'Proposal not found.');
        return;
    }

    const existing = document.getElementById('proposalBoostOverlay');
    if (existing && existing.parentNode) {
        existing.parentNode.removeChild(existing);
    }

    const boostKey = proposal.proposalHash || proposal.proposalId || '';
    const overlay = document.createElement('div');
    overlay.id = 'proposalBoostOverlay';
    overlay.className = 'proposal-boost-overlay';
    overlay.addEventListener('click', event => {
        if (event.target === overlay) {
            closeProposalBoostDialog();
        }
    });

    const modalTitle = tProposalUI('panel.proposal.boost.title', 'Boost the proposal');
    const modalCloseLabel = tProposalUI('panel.proposal.boost.closeLabel', 'Close boost dialog');
    const modalCopy = tProposalUI('panel.proposal.boost.copy', 'The proposal creator, but also anyone else, can boost any proposal by sending money to it. If the proposal expires before executing the donations will be refunded.');
    const sendLabel = tProposalUI('panel.proposal.boost.send', 'Send');

    overlay.innerHTML = `
        <div class="proposal-boost-modal" role="dialog" aria-modal="true">
            <div class="proposal-boost-header">
                <h3>${modalTitle}</h3>
                <button type="button" class="proposal-boost-close" aria-label="${modalCloseLabel}" onclick="closeProposalBoostDialog()">×</button>
            </div>
            <div class="proposal-boost-body">
                <p class="proposal-boost-copy">${modalCopy}</p>
                <div class="proposal-offer-row proposal-boost-row" style="display:flex; gap:8px; align-items:center;">
                    <input type="text" id="proposalBoostAmount" placeholder="0" inputmode="numeric" style="flex:1 1 auto;" oninput="handleProposalOfferInput(this)">
                    <select id="proposalBoostCurrency" style="flex:0 0 112px; max-width:112px; min-width:112px;">
                        <option value="EUR">EUR</option>
                        <option value="USD">USD</option>
                        <option value="ARS">ARS</option>
                        <option value="USDC">USDC</option>
                        <option value="USDT" selected>USDT</option>
                    </select>
                </div>
                <div class="proposal-boost-actions">
                    <button type="button" class="proposal-boost-send" onclick="submitProposalBoost('${boostKey}')">${sendLabel}</button>
                </div>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);

    const currencySelect = overlay.querySelector('#proposalBoostCurrency');
    const defaultCurrency = proposal.offerCurrency || 'USDT';
    if (currencySelect) {
        const optionExists = Array.from(currencySelect.options).some(opt => opt.value === defaultCurrency);
        if (optionExists) {
            currencySelect.value = defaultCurrency;
        }
    }

    const amountInput = overlay.querySelector('#proposalBoostAmount');
    if (amountInput) {
        amountInput.focus();
        if (typeof amountInput.select === 'function') {
            amountInput.select();
        }
    }
}

function closeProposalBoostDialog() {
    const overlay = document.getElementById('proposalBoostOverlay');
    if (overlay && overlay.parentNode) {
        overlay.parentNode.removeChild(overlay);
    }
}

function submitProposalBoost(idOrHash = null) {
    const tProposalUI = getProposalI18nHelper();
    const amountInput = document.getElementById('proposalBoostAmount');
    const currencySelect = document.getElementById('proposalBoostCurrency');
    const rawAmount = amountInput ? amountInput.value : '';
    const amount = typeof parseProposalOfferValue === 'function'
        ? parseProposalOfferValue(rawAmount)
        : 0;

    if (!amount || amount <= 0) {
        showProposalAlertMessage('please_enter_a_valid_boost_amount', 'Please enter a valid boost amount.');
        return;
    }

    const currency = (currencySelect && currencySelect.value) ? currencySelect.value : 'USDT';
    const proposal = resolveProposalForBoost(idOrHash);
    if (!proposal) {
        showProposalAlertMessage('proposal_not_found', 'Proposal not found.');
        return;
    }

    const baseOffer = typeof proposal.offer === 'number'
        ? proposal.offer
        : parseProposalOfferValue(proposal.offer);
    const updatedOffer = (baseOffer || 0) + amount;

    // Placeholder for future on-chain donate(proposalId) integration
    console.info('Boost proposal - pending on-chain donate integration', {
        proposalId: proposal.proposalId || proposal.proposalHash || idOrHash,
        boostAmount: amount,
        newOffer: updatedOffer,
        currency
    });

    const updatedProposal = {
        ...proposal,
        offer: updatedOffer,
        offerCurrency: currency,
        updatedAt: new Date().toISOString()
    };

    const key = proposal.proposalHash || proposal.proposalId || idOrHash;
    if (key && typeof proposalStorage !== 'undefined' && proposalStorage.proposals) {
        proposalStorage.proposals.set(key, updatedProposal);
        if (typeof proposalStorage.save === 'function') {
            proposalStorage.save();
        }
    }

    window.currentlyHighlightedProposal = updatedProposal;

    closeProposalBoostDialog();

    try {
        showProposalInfo(updatedProposal, window.selectedParcelInProposal);
    } catch (error) {
        console.warn('Failed to refresh proposal details after boost', error);
    }

    if (typeof refreshProposalsLayer === 'function') {
        try { refreshProposalsLayer(); } catch (_) { }
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
    document.body.classList.remove('proposal-details-open');

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
    const modal = document.querySelector('.create-proposal-modal');
    if (!modal) return;
    if (dimmed) {
        modal.classList.add('dimmed-behind-overlay');
    } else {
        modal.classList.remove('dimmed-behind-overlay');
    }
}

function setProposalCreateButtonState(isCreating) {
    const modal = document.querySelector('.create-proposal-modal');
    if (!modal) return;
    const createButton = modal.querySelector('.proposal-actions-block .btn-proposal');
    if (!createButton) return;

    if (isCreating) {
        if (!createButton.dataset.originalText) {
            createButton.dataset.originalText = createButton.textContent || 'Create Proposal';
        }
        createButton.textContent = 'Creating...';
        createButton.disabled = true;
        createButton.classList.add('is-creating');
    } else {
        const originalText = createButton.dataset.originalText || 'Create Proposal';
        createButton.textContent = originalText;
        createButton.disabled = false;
        createButton.classList.remove('is-creating');
        delete createButton.dataset.originalText;
    }
}

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
        popup.style.position = 'fixed';
        popup.style.inset = '0';
        popup.style.zIndex = '12050';
        popup.style.display = 'flex';
        popup.style.alignItems = 'center';
        popup.style.justifyContent = 'center';
        popup.style.pointerEvents = 'none';

        const card = document.createElement('div');
        card.style.background = '#0d3b66';
        card.style.color = '#fff';
        card.style.padding = '12px 16px';
        card.style.borderRadius = '12px';
        card.style.boxShadow = '0 12px 36px rgba(0,0,0,0.25)';
        card.style.display = 'flex';
        card.style.alignItems = 'center';
        card.style.gap = '10px';
        card.style.fontFamily = 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
        card.style.fontSize = '14px';
        card.style.pointerEvents = 'none';

        const indicator = document.createElement('span');
        indicator.textContent = '⏳';
        indicator.style.fontSize = '16px';
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
    // Support both old .proposal-tool-button and new .proposal-type-button classes
    const buttons = document.querySelectorAll('.proposal-tool-button, .proposal-type-button[data-proposal-tool]');
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

    // Update description with default text if empty
    updateProposalDescription(effectiveType);
}

let reparcellizationModulePromise = null;

function ensureReparcellizationModuleLoaded() {
    if (typeof openReparcellizationModal === 'function') {
        return Promise.resolve(true);
    }
    if (reparcellizationModulePromise) {
        return reparcellizationModulePromise;
    }
    reparcellizationModulePromise = new Promise((resolve) => {
        const script = document.createElement('script');
        script.src = 'js/reparcellization.js';
        script.async = true;
        script.onload = () => resolve(typeof openReparcellizationModal === 'function');
        script.onerror = () => resolve(false);
        document.head.appendChild(script);
    });
    return reparcellizationModulePromise;
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

    // Support both old .proposal-tool-button and new .proposal-type-button classes
    const toolButtons = document.querySelectorAll('.proposal-tool-button, .proposal-type-button[data-proposal-tool]');
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

async function handleReparcellizationAlgorithmClick(algorithmKey = 'sweep-line') {
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
        return;
    }

    if (typeof updateStatus === 'function') {
        updateStatus('Loading reparcellization tools...');
    }
    const loaded = await ensureReparcellizationModuleLoaded();
    if (loaded && typeof openReparcellizationModal === 'function') {
        openReparcellizationModal({ algorithm: normalizedKey });
    } else {
        console.warn('Reparcellization modal is not yet available.');
        if (typeof showEphemeralMessage === 'function') {
            showEphemeralMessage('Reparcellization tools failed to load.', 5000, 'error');
        }
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

function generateDefaultProposalDescription(proposalType) {
    const authorName = resolveProposalAuthorName() || 'User';
    const now = new Date();
    const day = String(now.getDate()).padStart(2, '0');
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const hour = String(now.getHours()).padStart(2, '0');
    const minute = String(now.getMinutes()).padStart(2, '0');
    return `${authorName} ${proposalType} ${day}${month}-${hour}${minute}`;
}

function updateProposalDescription(proposalType, forceUpdate = false) {
    const descriptionInput = document.getElementById('proposalDescription');
    if (descriptionInput) {
        if (forceUpdate || !descriptionInput.value.trim()) {
            descriptionInput.value = generateDefaultProposalDescription(proposalType);
        }
    }
}

function handleProposalToolButton(toolKey) {
    // Support both old .proposal-tool-button and new .proposal-type-button classes
    const button = document.querySelector(`.proposal-tool-button[data-proposal-tool="${toolKey}"], .proposal-type-button[data-proposal-tool="${toolKey}"]`);
    const mappedType = button ? button.getAttribute('data-proposal-type') : null;
    const effectiveType = mappedType || DEFAULT_PROPOSAL_TYPE;
    setProposalType(effectiveType);

    // Update description with default text (force update when button is clicked)
    updateProposalDescription(effectiveType, true);

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
    const isSingleParcelSelection = selectedParcels.length === 1;

    currentProposalTool = null;

    if (!selectedParcels.length) {
        updateStatus('Please select at least one parcel to create a proposal.');
        return;
    }

    const totalArea = selectedParcels.reduce((sum, parcel) => {
        const area = parcel.feature?.properties?.calculatedArea || 0;
        return sum + area;
    }, 0);

    // Calculate total owners across all selected parcels
    let totalOwners = 0;
    const ownerKeys = new Set();
    if (typeof getParcelOwnerSlots === 'function') {
        for (const parcel of selectedParcels) {
            const parcelId = parcel.feature?.properties?.CESTICA_ID;
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
        totalOwners = selectedParcels.length;
    }

    // Create parcel list HTML with error handling
    const parcelListHTML = selectedParcels.map(parcel => {
        const parcelNumber = getParcelDisplayNumberFromProperties(parcel?.feature?.properties, 'Unknown') || 'Unknown';
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

    // Shared inline style for helper text in the options column
    const optionHelperStyle = 'color:#6b7280; font-size:12px; line-height:1.3;';

    // Create modal dialog
    const modal = document.createElement('div');
    modal.className = 'create-proposal-modal';
    modal.innerHTML = `
        <div class="proposal-modal-content">
            <div class="proposal-modal-header">
                <h2>Create Proposal</h2>
                <button type="button" class="proposal-modal-close close-circle-btn close-circle-btn--lg" aria-label="Close proposal dialog" onclick="closeProposalDialog()">&times;</button>
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
                    <div class="proposal-type-group">
                        <button type="button" class="btn proposal-type-button" data-proposal-tool="buildings" data-proposal-type="Residences" onclick="handleProposalToolButton('buildings')">Buildings</button>
                        <button type="button" class="btn proposal-type-button" data-proposal-tool="single" data-proposal-type="Single Building" onclick="handleProposalToolButton('single')">Single Building</button>
                        <button type="button" class="btn proposal-type-button" data-proposal-tool="park" data-proposal-type="Park" onclick="handleProposalToolButton('park')">Park</button>
                        <button type="button" class="btn proposal-type-button" data-proposal-tool="square" data-proposal-type="Square" onclick="handleProposalToolButton('square')">Square</button>
                    </div>
                </div>
                <div class="form-group" id="reparcellizationAlgorithmGroup" style="display:none;">
                    <label>Algorithm:</label>
                    <div class="proposal-type-group">
                        <button type="button" class="proposal-type-button reparcel-alg-button selected" data-reparcel-algorithm="sweep-line" onclick="handleReparcellizationAlgorithmClick('sweep-line')">Sweep line</button>
                        <button type="button" class="proposal-type-button reparcel-alg-button" data-reparcel-algorithm="centroidal-voronoi" disabled>Centroidal Voronoi</button>
                        <button type="button" class="proposal-type-button reparcel-alg-button" data-reparcel-algorithm="wasserstein" disabled>Wasserstein</button>
                        <button type="button" class="proposal-type-button reparcel-alg-button" data-reparcel-algorithm="manual" disabled>Manual</button>
                    </div>
                    <p class="proposal-type-hint" style="margin-top:10px;">Additional algorithms are visible for planning purposes; Sweep line is currently available.</p>
                </div>
                <input type="hidden" id="proposalType" value="">
                <div class="form-group">
                    <label for="proposalDescription">Description:</label>
                    <textarea id="proposalDescription" class="proposal-description-input" rows="2" placeholder="Describe your proposal..."></textarea>
                </div>
                <div class="form-group">
                    <label for="proposalOffer">Offer:</label>
                    <div class="proposal-offer-row" style="display:flex; gap:8px; align-items:center;">
                        <input type="text" id="proposalOffer" placeholder="0" inputmode="numeric" style="flex:1 1 auto;" oninput="handleProposalOfferInput(this)">
                        <select id="proposalCurrency" style="flex:0 0 112px; max-width:112px; min-width:112px;">
                            <option value="EUR">EUR</option>
                            <option value="USD">USD</option>
                            <option value="ARS">ARS</option>
                            <option value="USDC">USDC</option>
                            <option value="USDT" selected>USDT</option>
                        </select>
                    </div>
                </div>
                <div class="form-group proposal-options-section">
                    <label>Options:</label>
                    <div class="proposal-option-row" style="display:flex; align-items:center; gap:8px; margin-bottom:6px;">
                        <div style="flex:1; display:flex; align-items:center; gap:6px;">
                            <input type="checkbox" id="proposalConditionalCheckbox" checked>
                            <label for="proposalConditionalCheckbox" style="margin:0; cursor:pointer;">Conditional</label>
                        </div>
                        <div id="proposalConditionalHelperText" style="${optionHelperStyle} flex:1;">
                            Pay reward only if/when all ownersaccept
                        </div>
                    </div>
                    <div class="proposal-option-row" style="display:grid; grid-template-columns: 1fr 1fr; align-items:center; gap:8px;">
                        <div style="display:flex; align-items:center; gap:6px;">
                            <input type="checkbox" id="proposalExpireCheckbox" onchange="toggleExpiryInput()">
                            <label for="proposalExpireCheckbox" style="margin:0; cursor:pointer;">Expire after</label>
                        </div>
                        <div>
                            <input type="text" id="proposalExpiryTime" value="00h:05m:00s" placeholder="00h:05m:00s" style="width:100%; text-align:center;" disabled>
                        </div>
                    </div>
                    <div class="proposal-option-row" style="display:flex; align-items:center; gap:8px; margin-top:6px;">
                        <div style="flex:1; display:flex; align-items:center; gap:6px;">
                            <input type="checkbox" id="proposalDecayCheckbox" onchange="toggleDecayInput()">
                            <label for="proposalDecayCheckbox" style="margin:0; cursor:pointer;">Offer Decay</label>
                        </div>
                        <div style="flex:1; ${optionHelperStyle}">Offer amount will decrease with time to entice acceptance.</div>
                    </div>
                    <div class="proposal-option-row proposal-decay-inputs" style="display:grid; grid-template-columns: 1fr 1fr; align-items:center; gap:8px; margin-top:4px;">
                        <div style="display:flex; align-items:center; gap:4px; padding-left:28px;">
                            <input type="text" id="proposalDecayPercent" value="50" pattern="[0-9]*" inputmode="numeric" style="width:40px; text-align:center;" disabled>
                            <span style="color:#666;">% over</span>
                        </div>
                        <div>
                            <input type="text" id="proposalDecayTime" value="00h:05m:00s" placeholder="00h:05m:00s" style="width:100%; text-align:center;" disabled>
                        </div>
                    </div>
                    <div class="proposal-option-row" style="display:flex; align-items:center; gap:8px; margin-top:6px;">
                        <div style="flex:1; display:flex; align-items:center; gap:6px;">
                            <input type="checkbox" id="proposalDepositCheckbox" onchange="toggleDepositInput()">
                            <label for="proposalDepositCheckbox" style="margin:0; cursor:pointer;">Deposit</label>
                        </div>
                        <div style="flex:1; display:flex; align-items:center; gap:4px;">
                            <input type="text" id="proposalDepositPercent" value="100" pattern="[0-9]*" inputmode="numeric" style="width:55px; text-align:center;" disabled>
                            <span style="color:#666;">% of offer</span>
                        </div>
                    </div>
                    <div class="proposal-option-row" style="grid-column: 1 / span 2; display:flex; align-items:center; gap:8px; margin-top:8px;">
                        <div style="display:flex; align-items:center; gap:6px;">
                            <input type="checkbox" id="proposalAreaProportionalCheckbox" checked disabled>
                            <label for="proposalAreaProportionalCheckbox" style="margin:0;">Payouts are proportional to parcel area</label>
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
                        <h3 style="display:inline; font-size: 1.1em; font-weight: 600; margin:0;">Proposal Summary</h3>
                        <i id="proposalSummaryChevron" class="fas fa-chevron-down" style="margin-left: 8px;"></i>
                    </div>
                    <div id="proposalSummaryContent" style="display:none;">
                        <div class="summary-stats">
                            <p><strong>Parcels Selected:</strong> ${selectedParcels.length}</p>
                            <p><strong>Total Area:</strong> ${Math.round(totalArea).toLocaleString('hr-HR')} m²</p>
                            <p><strong>Total owners:</strong> ${totalOwners}</p>
                        </div>
                        <div class="parcel-list">
                            <h4>Selected Parcels:</h4>
                            ${parcelListHTML}
                        </div>
                    </div>
                </div>
                <div class="proposal-similar-section" id="proposalSimilarSection" style="margin-top:12px; display:none;">
                    <h4 style="margin-bottom:6px;">Similar proposals:</h4>
                    <div id="proposalSimilarList" class="proposal-similar-list" style="display:flex; flex-direction:column; gap:6px;"></div>
                </div>
                <div class="proposal-actions-block">
                    <div class="lens-inline-control lens-footer-control lens-footer-row">
                        <button type="button" class="lens-pattern-button" data-lens-pattern onclick="showLensModal()" title="Open lens modal">👓</button>
                    </div>
                    <button class="btn btn-proposal" onclick="createProposal()">Create Proposal</button>
                </div>
            </div>
        </div>
    `;

    document.body.appendChild(modal);
    if (typeof refreshLensPatternPreviews === 'function') {
        refreshLensPatternPreviews();
    }
    setProposalMainType('Purchase');
    setProposalType(DEFAULT_PROPOSAL_TYPE);

    const conditionalCheckbox = document.getElementById('proposalConditionalCheckbox');
    const conditionalHelper = document.getElementById('proposalConditionalHelperText');
    const conditionalRow = conditionalCheckbox ? conditionalCheckbox.closest('.proposal-option-row') : null;
    const updateConditionalHelper = () => {
        if (!conditionalHelper || !conditionalCheckbox) return;
        conditionalHelper.textContent = conditionalCheckbox.checked
            ? 'Pay reward only if/when all owners accept'
            : 'Pay reward to owner when/if he accepts';
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

    // Pre-fill the offer amount with a random value between 1 and 1,000,000 EUR
    const offerInput = document.getElementById('proposalOffer');
    if (offerInput) {
        const minOfferEur = 1;
        const maxOfferEur = 1000000;
        const randomOffer = Math.floor(Math.random() * (maxOfferEur - minOfferEur + 1)) + minOfferEur;
        offerInput.value = window.formatProposalOfferValue(randomOffer);
    }

    // Pre-fill the author field and avatar with the current user
    populateProposalAuthorUI();

    // Pre-fill description with default text based on default proposal type
    updateProposalDescription(DEFAULT_PROPOSAL_TYPE);

    // Focus the default Square goal button to avoid triggering mobile keyboards
    const squareButton = modal.querySelector('.proposal-type-button[data-proposal-tool="square"]');
    if (squareButton) {
        squareButton.focus();
    }

    // Show similar proposals for the selected parcel set
    const similarSection = document.getElementById('proposalSimilarSection');
    const similarList = document.getElementById('proposalSimilarList');
    if (similarSection && similarList && typeof proposalStorage !== 'undefined' && typeof proposalStorage.getSimilarProposalsByParcelIds === 'function') {
        const similarProposals = proposalStorage.getSimilarProposalsByParcelIds(parcelIds);
        if (similarProposals && similarProposals.length > 0) {
            similarSection.style.display = '';
            const itemsHtml = similarProposals.map(p => {
                const hash = p.proposalHash || '';
                const title = typeof escapeHtml === 'function' ? escapeHtml(p.title || 'Untitled proposal') : (p.title || 'Untitled proposal');
                const author = typeof escapeHtml === 'function' ? escapeHtml(p.author || 'Unknown') : (p.author || 'Unknown');
                const typeLabel = typeof formatProposalTypeLabel === 'function'
                    ? formatProposalTypeLabel(getProposalLifecycleKey ? getProposalLifecycleKey(p) : (p.type || 'parcel'))
                    : (p.type || 'parcel');
                const createdDate = p.createdAt ? new Date(p.createdAt).toLocaleDateString() : '';
                return `
                    <div class="proposal-similar-item" data-proposal-hash="${hash}" style="display:flex; flex-direction:column; gap:2px; padding:8px; border:1px solid #ddd; border-radius:6px; cursor:pointer; background:#fafafa;">
                        <span style="font-weight:600;">${title}</span>
                        <span style="font-size:12px; color:#555;">${author}${createdDate ? ` • ${createdDate}` : ''}</span>
                        <span style="font-size:12px; color:#555;">${typeLabel}</span>
                    </div>
                `;
            }).join('');
            similarList.innerHTML = itemsHtml;
            similarList.querySelectorAll('.proposal-similar-item').forEach(item => {
                const hash = item.getAttribute('data-proposal-hash');
                item.addEventListener('click', () => {
                    if (hash && typeof openProposalFromList === 'function') {
                        openProposalFromList(hash, {
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
    const modal = document.querySelector('.create-proposal-modal');
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

// Toggle expiry time input when checkbox is changed
function toggleExpiryInput() {
    const checkbox = document.getElementById('proposalExpireCheckbox');
    const timeInput = document.getElementById('proposalExpiryTime');
    if (checkbox && timeInput) {
        timeInput.disabled = !checkbox.checked;
        if (checkbox.checked) {
            timeInput.focus();
            timeInput.select();
        }
    }
}

// Toggle decay inputs when checkbox is changed
function toggleDecayInput() {
    const checkbox = document.getElementById('proposalDecayCheckbox');
    const percentInput = document.getElementById('proposalDecayPercent');
    const timeInput = document.getElementById('proposalDecayTime');
    if (checkbox && percentInput && timeInput) {
        const enabled = checkbox.checked;
        percentInput.disabled = !enabled;
        timeInput.disabled = !enabled;
        if (enabled) {
            percentInput.focus();
            percentInput.select();
        }
    }
}

// Toggle deposit input when checkbox is changed
function toggleDepositInput() {
    const checkbox = document.getElementById('proposalDepositCheckbox');
    const percentInput = document.getElementById('proposalDepositPercent');
    if (checkbox && percentInput) {
        const enabled = checkbox.checked;
        percentInput.disabled = !enabled;
        if (enabled) {
            percentInput.focus();
            percentInput.select();
        }
    }
}

// Calculate current offer amount considering decay
function calculateDecayedOffer(proposal) {
    if (!proposal || !proposal.offer) return proposal?.offer || 0;
    if (!proposal.decayEnabled || !proposal.decayPercent || !proposal.decayDurationMs) {
        return proposal.offer;
    }

    const createdAt = new Date(proposal.createdAt).getTime();
    const now = Date.now();
    const elapsed = now - createdAt;

    if (elapsed <= 0) return proposal.offer;
    if (elapsed >= proposal.decayDurationMs) {
        // Decay complete - return minimum amount
        const decayAmount = (proposal.offer * proposal.decayPercent) / 100;
        return proposal.offer - decayAmount;
    }

    // Linear decay over time
    const progress = elapsed / proposal.decayDurationMs;
    const decayAmount = (proposal.offer * proposal.decayPercent * progress) / 100;
    return proposal.offer - decayAmount;
}

// Get decay progress (0 to 1) for visual representation
function getDecayProgress(proposal) {
    if (!proposal || !proposal.decayEnabled || !proposal.decayDurationMs) {
        return 0;
    }

    const createdAt = new Date(proposal.createdAt).getTime();
    const now = Date.now();
    const elapsed = now - createdAt;

    if (elapsed <= 0) return 0;
    if (elapsed >= proposal.decayDurationMs) return 1;

    return elapsed / proposal.decayDurationMs;
}

// Parse expiry time string (format: XXh:YYm:ZZs) and return milliseconds
function parseExpiryTime(timeStr) {
    if (!timeStr) return 0;
    const match = timeStr.match(/^(\d{1,2})h:(\d{1,2})m:(\d{1,2})s$/);
    if (!match) return 0;
    const hours = parseInt(match[1], 10) || 0;
    const minutes = parseInt(match[2], 10) || 0;
    const seconds = parseInt(match[3], 10) || 0;
    return (hours * 3600 + minutes * 60 + seconds) * 1000;
}

// Check if a proposal has expired based on its expiresAt timestamp
function isProposalExpired(proposal) {
    if (!proposal || !proposal.expiresAt) return false;
    const status = (proposal.status || '').toLowerCase();
    if (status === 'executed') return false; // Executed proposals no longer expire
    return new Date(proposal.expiresAt).getTime() <= Date.now();
}

// Update proposal status to Expired if it has expired
function checkAndUpdateProposalExpiry(proposal) {
    if (!proposal) return proposal;
    if (isProposalExpired(proposal)) {
        const currentStatus = (proposal.status || '').toLowerCase();
        if (currentStatus !== 'expired' && currentStatus !== 'executed') {
            proposal.status = 'Expired';
            proposal.updatedAt = new Date().toISOString();
            if (proposal.proposalHash && typeof proposalStorage !== 'undefined') {
                proposalStorage.updateProposalStatus(proposal.proposalHash, 'Expired');
                proposalStorage.save();
            }
        }
    }
    return proposal;
}

// Store the interval ID for the expiry countdown so we can clear it
let expiryCountdownInterval = null;

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
function initializeExpiryCountdown() {
    // Clear any existing interval
    if (expiryCountdownInterval) {
        clearInterval(expiryCountdownInterval);
        expiryCountdownInterval = null;
    }

    const countdownEl = document.querySelector('.proposal-expiry-countdown[data-expires-at]');
    if (!countdownEl) return;

    const expiresAtStr = countdownEl.getAttribute('data-expires-at');
    const proposalHash = countdownEl.getAttribute('data-proposal-hash');
    if (!expiresAtStr) return;

    // If proposal is executed, do not start countdown
    if (proposalHash && typeof proposalStorage !== 'undefined') {
        const p = proposalStorage.getProposal(proposalHash);
        const status = (p && p.status ? p.status : '').toLowerCase();
        if (status === 'executed') {
            return;
        }
    }

    const expiresAt = new Date(expiresAtStr).getTime();
    const timerEl = countdownEl.querySelector('.expiry-timer');
    const labelEl = countdownEl.querySelector('.expiry-label');

    function updateCountdown() {
        const now = Date.now();
        const remaining = expiresAt - now;

        if (remaining <= 0) {
            // Proposal has expired
            if (expiryCountdownInterval) {
                clearInterval(expiryCountdownInterval);
                expiryCountdownInterval = null;
            }

            // Update the countdown display to show expired
            countdownEl.classList.add('expired');
            countdownEl.style.background = '#f8d7da';
            countdownEl.style.borderColor = '#f5c6cb';
            if (labelEl) {
                labelEl.textContent = 'Proposal Expired';
                labelEl.style.color = '#721c24';
            }
            if (timerEl) {
                timerEl.style.display = 'none';
            }
            const iconEl = countdownEl.querySelector('i');
            if (iconEl) {
                iconEl.className = 'fas fa-clock';
                iconEl.style.color = '#721c24';
            }

            // Update proposal status in storage
            if (proposalHash && typeof proposalStorage !== 'undefined') {
                const proposal = proposalStorage.getProposal(proposalHash);
                if (proposal) {
                    checkAndUpdateProposalExpiry(proposal);
                    // Refresh the UI
                    updateProposalList();
                    // Re-render the proposal info to update buttons
                    showProposalInfo(proposal);
                }
            }
        } else {
            // Update the timer display
            if (timerEl) {
                timerEl.textContent = formatRemainingTime(remaining);
            }

            // Change color to red when less than 1 minute remaining
            if (remaining < 60000) {
                countdownEl.style.background = '#f8d7da';
                countdownEl.style.borderColor = '#f5c6cb';
                if (labelEl) labelEl.style.color = '#721c24';
                if (timerEl) timerEl.style.color = '#721c24';
                const iconEl = countdownEl.querySelector('i');
                if (iconEl) iconEl.style.color = '#721c24';
            }
        }
    }

    // Run immediately and then every second
    updateCountdown();
    expiryCountdownInterval = setInterval(updateCountdown, 1000);
}

// Interval for decay countdown
let decayCountdownInterval = null;

// Initialize decay countdown animation for the offer bar
function initializeDecayCountdown() {
    // Clear any existing interval
    if (decayCountdownInterval) {
        clearInterval(decayCountdownInterval);
        decayCountdownInterval = null;
    }

    const offerBar = document.querySelector('.proposal-offer-bar.with-decay[data-proposal-hash]');
    if (!offerBar) return;

    const proposalHash = offerBar.getAttribute('data-proposal-hash');
    const originalOffer = parseFloat(offerBar.getAttribute('data-original-offer'));
    const decayPercent = parseFloat(offerBar.getAttribute('data-decay-percent'));
    const decayDurationMs = parseFloat(offerBar.getAttribute('data-decay-duration'));
    const createdAtStr = offerBar.getAttribute('data-created-at');

    if (!originalOffer || !decayPercent || !decayDurationMs || !createdAtStr) return;

    const createdAt = new Date(createdAtStr).getTime();
    const proposal = proposalHash && typeof proposalStorage !== 'undefined'
        ? proposalStorage.getProposal(proposalHash)
        : { offer: originalOffer, decayEnabled: true, decayPercent, decayDurationMs, createdAt: createdAtStr, offerCurrency: 'USDT' };

    const remainingBar = offerBar.querySelector('.offer-bar-remaining');
    const decayedBar = offerBar.querySelector('.offer-bar-decayed');
    const amountEl = offerBar.querySelector('.offer-amount');
    const currencySymbol = proposal.offerCurrency === 'EUR' ? '€' : '';
    const currencySuffix = proposal.offerCurrency && proposal.offerCurrency !== 'EUR' ? ' ' + proposal.offerCurrency : '';

    function updateDecay() {
        const now = Date.now();
        const elapsed = now - createdAt;

        let progress = 0;
        if (elapsed >= decayDurationMs) {
            progress = 1;
        } else if (elapsed > 0) {
            progress = elapsed / decayDurationMs;
        }

        const decayedPercent = decayPercent * progress;
        const remainingPercent = 100 - decayedPercent;
        const currentOffer = originalOffer - (originalOffer * decayedPercent / 100);

        if (remainingBar) remainingBar.style.width = remainingPercent + '%';
        if (decayedBar) decayedBar.style.width = decayedPercent + '%';
        if (amountEl) amountEl.textContent = currencySymbol + Math.round(currentOffer).toLocaleString('hr-HR') + currencySuffix;

        // Stop interval once fully decayed
        if (progress >= 1 && decayCountdownInterval) {
            clearInterval(decayCountdownInterval);
            decayCountdownInterval = null;
        }
    }

    // Run immediately and then every second
    updateDecay();
    decayCountdownInterval = setInterval(updateDecay, 1000);
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
        const number = getParcelDisplayNumberFromProperties(parcel?.feature?.properties, 'Unknown') || 'Unknown';
        const area = Math.round(parcel.feature?.properties?.calculatedArea || 0).toLocaleString('hr-HR');
        return `<div class="proposal-parcel-item"><span class="parcel-number">Parcel ${number}</span> <span class="parcel-area">(${area} m²)</span></div>`;
    }).join('');

    // Shared inline style for helper text in the options column
    const optionHelperStyle = 'color:#6b7280; font-size:12px; line-height:1.3;';

    const modal = document.createElement('div');
    modal.className = 'create-proposal-modal';
    const defaultName = generateStructureName(validKind);
    modal.innerHTML = `
        <div class="proposal-modal-content">
            <div class="proposal-modal-header">
                <h2>Create ${validKind === 'park' ? 'Park' : 'Square'} Proposal</h2>
                <button type="button" class="proposal-modal-close close-circle-btn close-circle-btn--lg" aria-label="Close proposal dialog" onclick="closeProposalDialog()">&times;</button>
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
                    <textarea id="proposalDescription" class="proposal-description-input" rows="2" placeholder="Describe your ${validKind}..."></textarea>
                </div>
                <div class="form-group">
                    <label for="proposalOffer">Offer:</label>
                    <div class="proposal-offer-row" style="display:flex; gap:8px; align-items:center;">
                        <input type="text" id="proposalOffer" placeholder="0" inputmode="numeric" style="flex:1 1 auto;" oninput="handleProposalOfferInput(this)">
                        <select id="proposalCurrency" style="flex:0 0 112px; max-width:112px; min-width:112px;">
                            <option value="EUR">EUR</option>
                            <option value="USD">USD</option>
                            <option value="ARS">ARS</option>
                            <option value="USDC">USDC</option>
                            <option value="USDT" selected>USDT</option>
                        </select>
                    </div>
                </div>
                <div class="form-group proposal-options-section">
                    <label>Options:</label>
                    <div class="proposal-option-row" style="display:grid; grid-template-columns: 1fr 1fr; align-items:center; gap:8px;">
                        <div style="display:flex; align-items:center; gap:6px;">
                            <input type="checkbox" id="proposalExpireCheckbox" onchange="toggleExpiryInput()">
                            <label for="proposalExpireCheckbox" style="margin:0; cursor:pointer;">Expire after</label>
                        </div>
                        <div>
                            <input type="text" id="proposalExpiryTime" value="00h:05m:00s" placeholder="00h:05m:00s" style="width:100%; text-align:center;" disabled>
                        </div>
                    </div>
                    <div class="proposal-option-row" style="display:flex; align-items:center; gap:8px; margin-top:6px;">
                        <div style="flex:1; display:flex; align-items:center; gap:6px;">
                            <input type="checkbox" id="proposalDecayCheckbox" onchange="toggleDecayInput()">
                            <label for="proposalDecayCheckbox" style="margin:0; cursor:pointer;">Offer Decay</label>
                        </div>
                        <div style="flex:1; ${optionHelperStyle}">Offer amount will decrease with time to entice acceptance.</div>
                    </div>
                    <div class="proposal-option-row proposal-decay-inputs" style="display:grid; grid-template-columns: 1fr 1fr; align-items:center; gap:8px; margin-top:4px;">
                        <div style="display:flex; align-items:center; gap:4px; padding-left:28px;">
                            <input type="text" id="proposalDecayPercent" value="50" pattern="[0-9]*" inputmode="numeric" style="width:40px; text-align:center;" disabled>
                            <span style="color:#666;">% over</span>
                        </div>
                        <div>
                            <input type="text" id="proposalDecayTime" value="00h:05m:00s" placeholder="00h:05m:00s" style="width:100%; text-align:center;" disabled>
                        </div>
                    </div>
                    <div class="proposal-option-row" style="display:flex; align-items:center; gap:8px; margin-top:6px;">
                        <div style="flex:1; display:flex; align-items:center; gap:6px;">
                            <input type="checkbox" id="proposalDepositCheckbox" onchange="toggleDepositInput()">
                            <label for="proposalDepositCheckbox" style="margin:0; cursor:pointer;">Deposit</label>
                        </div>
                        <div style="flex:1; display:flex; align-items:center; gap:4px;">
                            <input type="text" id="proposalDepositPercent" value="100" pattern="[0-9]*" inputmode="numeric" style="width:55px; text-align:center;" disabled>
                            <span style="color:#666;">% of offer</span>
                        </div>
                    </div>
                    <div class="proposal-option-row" style="grid-column: 1 / span 2; display:flex; align-items:center; gap:8px; margin-top:8px;">
                        <div style="display:flex; align-items:center; gap:6px;">
                            <input type="checkbox" id="proposalAreaProportionalCheckbox" checked disabled>
                            <label for="proposalAreaProportionalCheckbox" style="margin:0;">Payouts are proportional to parcel area</label>
                        </div>
                    </div>
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
                <div class="proposal-actions-block">
                    <div class="lens-inline-control lens-footer-control lens-footer-row">
                        <button type="button" class="lens-pattern-button" data-lens-pattern onclick="showLensModal()" title="Open lens modal">👓</button>
                    </div>
                    <button type="button" class="btn btn-proposal" id="create-structure-proposal-btn">Create Proposal</button>
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
    const proposalTypeName = validKind === 'park' ? 'Park' : 'Square';
    updateProposalDescription(proposalTypeName);
    const offerInput = document.getElementById('proposalOffer');
    if (offerInput) {
        const minOfferEur = 1000, maxOfferEur = 100000;
        offerInput.value = window.formatProposalOfferValue(Math.floor(Math.random() * (maxOfferEur - minOfferEur + 1)) + minOfferEur);
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
    const offer = window.parseProposalOfferValue(document.getElementById('proposalOffer')?.value) || 0;
    const offerCurrency = document.getElementById('proposalCurrency')?.value || 'USDT';
    if (!author || !title || offer <= 0) {
        showProposalAlertMessage('please_provide_author_name_and_a_valid_offer', 'Please provide author, name, and a valid offer.');
        return;
    }
    if (!Array.isArray(parcelIds) || parcelIds.length === 0 || !geometry) {
        showProposalAlertMessage('missing_parcels_or_geometry_for_this_proposal', 'Missing parcels or geometry for this proposal.');
        return;
    }

    // Check for expiry option
    const expireCheckbox = document.getElementById('proposalExpireCheckbox');
    const expiryTimeInput = document.getElementById('proposalExpiryTime');
    let expiresAt = null;
    if (expireCheckbox && expireCheckbox.checked && expiryTimeInput) {
        const expiryMs = parseExpiryTime(expiryTimeInput.value);
        if (expiryMs > 0) {
            expiresAt = new Date(Date.now() + expiryMs).toISOString();
        }
    }

    // Check for decay option
    const decayCheckbox = document.getElementById('proposalDecayCheckbox');
    const decayPercentInput = document.getElementById('proposalDecayPercent');
    const decayTimeInput = document.getElementById('proposalDecayTime');
    let decayEnabled = false;
    let decayPercent = 0;
    let decayDurationMs = 0;
    if (decayCheckbox && decayCheckbox.checked && decayPercentInput && decayTimeInput) {
        decayEnabled = true;
        decayPercent = Math.min(100, Math.max(1, parseInt(decayPercentInput.value, 10) || 50));
        decayDurationMs = parseExpiryTime(decayTimeInput.value);
    }

    // Check for deposit option
    const depositCheckbox = document.getElementById('proposalDepositCheckbox');
    const depositPercentInput = document.getElementById('proposalDepositPercent');
    let depositEnabled = false;
    let depositPercent = 0;
    if (depositCheckbox && depositCheckbox.checked && depositPercentInput) {
        depositEnabled = true;
        // Clamp between 10% and 200%
        depositPercent = Math.min(200, Math.max(10, parseInt(depositPercentInput.value, 10) || 100));
    }

    const proposal = {
        author,
        title,
        name: title,
        proposalName: title,
        description: description || title,
        offer,
        offerCurrency,
        budget: offer,
        budgetCurrency: offerCurrency,
        parcelIds: parcelIds,
        type: 'structure',
        structureProposal: {
            kind: (kind === 'park' || kind === 'square') ? kind : 'square',
            status: 'unapplied',
            geometry,
            parentParcelIds: parcelIds,
            blockName: blockName || null
        },
        createdAt: new Date().toISOString(),
        expiresAt: expiresAt,
        decayEnabled: decayEnabled,
        decayPercent: decayPercent,
        decayDurationMs: decayDurationMs,
        depositEnabled: depositEnabled,
        depositPercent: depositPercent
    };

    const hash = proposalStorage.addProposal(proposal);
    if (!hash) {
        showProposalAlertMessage('an_identical_proposal_already_exists', 'An identical proposal already exists.');
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

// Check if parcels have NFTs on-chain
async function checkParcelsHaveNFTs(parcelIds, chainId) {
    if (!parcelIds || parcelIds.length === 0) {
        return { allHaveNFTs: true, missingParcels: [], chainId: null, chainName: null };
    }

    const globalScope = typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : null);
    if (!globalScope || !globalScope.ethers) {
        // If blockchain library is not available, assume parcels don't have NFTs
        return { allHaveNFTs: false, missingParcels: parcelIds, chainId: null, chainName: null };
    }

    try {
        // Resolve ParcelNFT contract address
        let contractAddress = null;
        if (globalScope.ContractsLoader && typeof globalScope.ContractsLoader.getContractAddress === 'function') {
            try {
                contractAddress = await globalScope.ContractsLoader.getContractAddress(chainId, 'ParcelNFT');
            } catch (error) {
                console.warn('Failed to load ParcelNFT address from ContractsLoader:', error);
            }
        }

        if (!contractAddress && typeof resolveParcelNftAddress === 'function') {
            contractAddress = await resolveParcelNftAddress(chainId);
        }

        if (!contractAddress) {
            // Can't check, assume they don't have NFTs
            return { allHaveNFTs: false, missingParcels: parcelIds, chainId, chainName: null };
        }

        // Get provider
        let provider = null;
        const walletManager = globalScope.walletManager;
        const walletProvider = walletManager && typeof walletManager.getProvider === 'function' ? walletManager.getProvider() : null;

        if (walletProvider) {
            try {
                provider = new globalScope.ethers.BrowserProvider(walletProvider);
            } catch (error) {
                console.warn('Failed to create browser provider:', error);
            }
        }

        // Fallback to RPC provider
        if (!provider) {
            const rpcUrl = typeof resolveRpcUrlForChain === 'function' ? resolveRpcUrlForChain(chainId) : null;
            if (rpcUrl) {
                try {
                    const numericChainId = Number(chainId);
                    provider = Number.isFinite(numericChainId)
                        ? new globalScope.ethers.JsonRpcProvider(rpcUrl, numericChainId)
                        : new globalScope.ethers.JsonRpcProvider(rpcUrl);
                } catch (error) {
                    console.warn('Failed to create RPC provider:', error);
                }
            }
        }

        if (!provider) {
            return { allHaveNFTs: false, missingParcels: parcelIds, chainId, chainName: null };
        }

        // Create contract instance
        const PARCEL_NFT_ABI = [
            'function tokenIdForParcelId(string parcelId) public view returns (uint256)'
        ];
        const contract = new globalScope.ethers.Contract(contractAddress, PARCEL_NFT_ABI, provider);

        // Check each parcel
        const missingParcels = [];
        const checkPromises = parcelIds.map(async (parcelId) => {
            try {
                const tokenId = await contract.tokenIdForParcelId(parcelId);
                // If we get a result, the parcel has an NFT
                if (tokenId !== null && tokenId !== undefined) {
                    return { parcelId, hasNFT: true };
                }
                return { parcelId, hasNFT: false };
            } catch (error) {
                // Check if it's a "parcel does not exist" error (expected for unminted parcels)
                if (typeof isParcelTokenMissingError === 'function' && isParcelTokenMissingError(error)) {
                    return { parcelId, hasNFT: false };
                }

                // Handle RPC errors - MetaMask wraps revert errors in RPC error format
                const errorCode = error?.code || error?.data?.code;
                let errorMessage = error?.message || error?.data?.message || String(error);

                // For RPC errors (code -32603), check the data field for the actual revert reason
                if (errorCode === -32603 && error?.data) {
                    // MetaMask wraps contract reverts in RPC errors
                    // Check if the data contains the actual revert message
                    const dataMessage = error.data?.message || error.data?.originalError?.message ||
                        error.data?.data?.message || error.data?.originalError?.data?.message;
                    if (dataMessage) {
                        errorMessage = dataMessage;
                    }

                    // Check if the wrapped error indicates parcel doesn't exist
                    const dataMessageLower = String(dataMessage || '').toLowerCase();
                    if (dataMessageLower.includes('parcel does not exist')) {
                        return { parcelId, hasNFT: false };
                    }
                }

                // Check if error message indicates parcel doesn't exist
                const errorStr = String(errorMessage).toLowerCase();
                if (errorStr.includes('parcel does not exist') ||
                    errorStr.includes('nonexistent token') ||
                    (errorStr.includes('revert') && !errorStr.includes('internal json-rpc'))) {
                    return { parcelId, hasNFT: false };
                }

                // For RPC errors that don't indicate a missing parcel, log and assume no NFT
                // This is safer than assuming it does have one
                if (errorCode === -32603 || errorCode === -32602 || errorCode === -32000) {
                    console.warn(`RPC error checking parcel ${parcelId} (assuming not minted):`, {
                        code: errorCode,
                        message: errorMessage,
                        data: error?.data
                    });
                    return { parcelId, hasNFT: false, error: 'RPC_ERROR' };
                }

                // For other errors, log and assume no NFT (safer default)
                console.warn(`Unexpected error checking parcel ${parcelId}:`, {
                    code: errorCode,
                    message: errorMessage,
                    error
                });
                return { parcelId, hasNFT: false, error: 'UNKNOWN_ERROR' };
            }
        });

        const results = await Promise.all(checkPromises);
        results.forEach(result => {
            if (!result.hasNFT) {
                missingParcels.push(result.parcelId);
            }
        });

        const chainName = typeof resolveChainSlug === 'function' ? resolveChainSlug(chainId) : chainId;

        return {
            allHaveNFTs: missingParcels.length === 0,
            missingParcels,
            chainId,
            chainName: chainName || chainId
        };
    } catch (error) {
        console.error('Error checking parcel NFTs:', error);
        // On error, assume parcels don't have NFTs
        return { allHaveNFTs: false, missingParcels: parcelIds, chainId, chainName: null };
    }
}

// Show modal for missing parcel NFTs
async function showMissingParcelsModal(missingParcels, chainName) {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'cb-confirm-overlay';
        overlay.style.zIndex = '10000';

        const dialog = document.createElement('div');
        dialog.className = 'cb-confirm-dialog';
        dialog.style.maxWidth = '600px';

        const message = document.createElement('div');
        message.className = 'cb-confirm-message';
        message.style.marginBottom = '20px';

        const chainDisplay = chainName || 'the blockchain';
        const parcelList = missingParcels.length > 10
            ? missingParcels.slice(0, 10).join(', ') + `, and ${missingParcels.length - 10} more...`
            : missingParcels.join(', ');

        message.innerHTML = `
            <p style="margin-bottom: 12px;">The following parcel${missingParcels.length === 1 ? '' : 's'} ${missingParcels.length === 1 ? 'is' : 'are'} not represented as NFT${missingParcels.length === 1 ? '' : 's'} on <strong>${chainDisplay}</strong>, so a proposal for ${missingParcels.length === 1 ? 'it' : 'them'} can't be minted on-chain:</p>
            <div style="background: #f5f5f5; padding: 12px; border-radius: 6px; margin: 12px 0; max-height: 200px; overflow-y: auto; font-family: monospace; font-size: 12px;">
                ${parcelList}
            </div>
            <p style="margin-top: 12px;">Proceed to create an in-memory proposal?</p>
        `;

        const buttons = document.createElement('div');
        buttons.className = 'cb-confirm-buttons';
        buttons.style.display = 'flex';
        buttons.style.gap = '10px';
        buttons.style.justifyContent = 'flex-end';

        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'btn btn-secondary';
        cancelBtn.textContent = 'Cancel';

        const createBtn = document.createElement('button');
        createBtn.type = 'button';
        createBtn.className = 'btn btn-action';
        createBtn.textContent = 'Create';

        function cleanup(result) {
            if (overlay && overlay.parentNode) {
                overlay.parentNode.removeChild(overlay);
            }
            resolve(result);
        }

        cancelBtn.addEventListener('click', () => cleanup(false));
        createBtn.addEventListener('click', () => cleanup(true));
        overlay.addEventListener('click', (event) => {
            if (event.target === overlay) {
                cleanup(false);
            }
        });

        buttons.appendChild(cancelBtn);
        buttons.appendChild(createBtn);
        dialog.appendChild(message);
        dialog.appendChild(buttons);
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);
    });
}

// Create proposal from dialog
async function createProposal() {
    const t = getProposalI18nHelper();
    const selectedTool = getSelectedProposalTool();
    if (!selectedTool) {
        showProposalAlertMessage('select_a_proposal_goal_before_creating_a_proposal', 'Select a proposal goal before creating a proposal.');
        return;
    }

    if (selectedTool === 'buildings') {
        if (typeof createProposalWithBuilding === 'function') {
            createProposalWithBuilding();
        } else {
            showProposalAlertMessage('building_proposal_workflow_is_unavailable', 'Building proposal workflow is unavailable.');
        }
        return;
    }

    if (selectedTool === 'single') {
        if (typeof createSingleBuildingProposal === 'function') {
            createSingleBuildingProposal();
        } else {
            showProposalAlertMessage('single_building_workflow_is_unavailable', 'Single building workflow is unavailable.');
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
            showProposalAlertMessage('run_the_reparcellization_algorithm_and_click_done_before_creating_this_proposal', 'Run the reparcellization algorithm and click Done before creating this proposal.');
            return;
        }
    }
    const description = document.getElementById('proposalDescription').value.trim();
    const proposalName = (proposalType === 'Park' || proposalType === 'Square')
        ? (document.getElementById('proposalName') && document.getElementById('proposalName').value || '').trim()
        : description;
    const offer = window.parseProposalOfferValue(document.getElementById('proposalOffer').value) || 0;
    const offerCurrencySelect = document.getElementById('proposalCurrency');
    const offerCurrency = offerCurrencySelect && offerCurrencySelect.value ? offerCurrencySelect.value : 'USDT';

    // Validation
    if (!author) {
        showProposalAlertMessage('please_enter_an_author_name', 'Please enter an author name.');
        return;
    }
    if (!description) {
        showProposalAlertMessage('please_enter_a_description', 'Please enter a description.');
        return;
    }
    if (offer <= 0) {
        showProposalAlertMessage('please_enter_a_valid_offer_amount', 'Please enter a valid offer amount.');
        return;
    }

    // Lock UI while creating
    setProposalCreateButtonState(true);
    setProposalModalInteractivity(false);
    let waitingPopupVisible = false;
    const hideWaitingPopupSafe = () => {
        if (waitingPopupVisible) {
            hideProposalWaitingPopup();
            waitingPopupVisible = false;
        }
        setProposalModalDimmed(false);
    };

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
            showProposalAlertMessage('no_parcels_selected_please_select_parcels_before_creating_a_proposal', 'No parcels selected. Please select parcels before creating a proposal.');
            return;
        }

        // Check if parcels have NFTs on-chain before proceeding
        const blockchainSupported = typeof window.ProposalChainBridge !== 'undefined'
            && window.ProposalChainBridge.isSupported();
        let shouldMintOnchain = blockchainSupported && finalParcelIds.length > 0;
        let formattedParcelIds = null; // Store for later use in minting

        if (shouldMintOnchain) {
            // Get chain ID from wallet or use default
            let chainId = null;
            const walletManager = window.walletManager;
            if (walletManager && typeof walletManager.getState === 'function') {
                const walletState = walletManager.getState();
                chainId = walletState?.chainId || null;
            }

            // If no chain ID from wallet, try to get from default
            if (!chainId) {
                const globalScope = typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : null);
                if (globalScope && globalScope.DEFAULT_CHAIN_ID !== undefined && globalScope.DEFAULT_CHAIN_ID !== null) {
                    chainId = globalScope.DEFAULT_CHAIN_ID;
                } else {
                    const env = globalScope?.current_environment || 'production';
                    chainId = env === 'development' ? '31337' : '84532';
                }
            }

            // Format parcel IDs for checking
            const parcelFeatures = [];
            for (const parcelId of finalParcelIds) {
                let parcelLayer = null;
                if (typeof multiParcelSelection !== 'undefined' && multiParcelSelection.findParcelById) {
                    parcelLayer = multiParcelSelection.findParcelById(parcelId);
                }
                if (!parcelLayer && typeof resolveParcelLayerById === 'function') {
                    parcelLayer = resolveParcelLayerById(parcelId);
                }
                if (parcelLayer && parcelLayer.feature) {
                    parcelFeatures.push(parcelLayer.feature);
                }
            }

            // Derive formatted parcel IDs
            formattedParcelIds = parcelFeatures
                .map(feature => {
                    if (window.ProposalChainBridge && window.ProposalChainBridge.deriveParcelIdFromFeature) {
                        return window.ProposalChainBridge.deriveParcelIdFromFeature(feature);
                    }
                    // Fallback: try to format from properties
                    const props = feature.properties || {};
                    if (props.MATICNI_BROJ_KO && props.BROJ_CESTICE) {
                        return window.ProposalChainBridge ?
                            window.ProposalChainBridge.formatParcelId(props.MATICNI_BROJ_KO, props.BROJ_CESTICE) :
                            `HR-${props.MATICNI_BROJ_KO}-${props.BROJ_CESTICE}`;
                    }
                    return props.CESTICA_ID ? props.CESTICA_ID.toString() : null;
                })
                .filter(Boolean);

            // If we couldn't format parcel IDs, skip on-chain check
            if (formattedParcelIds.length === 0) {
                console.warn('Could not format parcel IDs for NFT check, skipping on-chain verification');
                shouldMintOnchain = false;
            } else {
                // Check if parcels have NFTs
                updateStatus('Checking if parcels have NFTs on-chain...');
                const parcelCheckResult = await checkParcelsHaveNFTs(formattedParcelIds, chainId);

                if (!parcelCheckResult.allHaveNFTs && parcelCheckResult.missingParcels.length > 0) {
                    // Some parcels don't have NFTs - show modal
                    const chainDisplay = parcelCheckResult.chainName || parcelCheckResult.chainId || 'the blockchain';
                    const proceed = await showMissingParcelsModal(parcelCheckResult.missingParcels, chainDisplay);

                    if (!proceed) {
                        // User cancelled
                        updateStatus('Proposal creation cancelled.');
                        return;
                    }

                    // User chose to proceed with local-only proposal
                    shouldMintOnchain = false;
                    updateStatus('Creating in-memory proposal (not minted on-chain)...');
                } else if (parcelCheckResult.allHaveNFTs) {
                    // All parcels have NFTs - proceed silently with on-chain minting
                    updateStatus('All parcels have NFTs. Proceeding with on-chain proposal...');
                }
            }
        }

        // Calculate bounds for the proposal (for reliable positioning)
        const bounds = calculateProposalBounds(finalParcelIds);

        // Check for expiry option
        const expireCheckbox = document.getElementById('proposalExpireCheckbox');
        const expiryTimeInput = document.getElementById('proposalExpiryTime');
        let expiresAt = null;
        if (expireCheckbox && expireCheckbox.checked && expiryTimeInput) {
            const expiryMs = parseExpiryTime(expiryTimeInput.value);
            if (expiryMs > 0) {
                expiresAt = new Date(Date.now() + expiryMs).toISOString();
            }
        }

        // Check for decay option
        const decayCheckbox = document.getElementById('proposalDecayCheckbox');
        const decayPercentInput = document.getElementById('proposalDecayPercent');
        const decayTimeInput = document.getElementById('proposalDecayTime');
        let decayEnabled = false;
        let decayPercent = 0;
        let decayDurationMs = 0;
        if (decayCheckbox && decayCheckbox.checked && decayPercentInput && decayTimeInput) {
            decayEnabled = true;
            decayPercent = Math.min(100, Math.max(1, parseInt(decayPercentInput.value, 10) || 50));
            decayDurationMs = parseExpiryTime(decayTimeInput.value);
        }

        // Check for deposit option
        const depositCheckbox = document.getElementById('proposalDepositCheckbox');
        const depositPercentInput = document.getElementById('proposalDepositPercent');
        let depositEnabled = false;
        let depositPercent = 0;
        if (depositCheckbox && depositCheckbox.checked && depositPercentInput) {
            depositEnabled = true;
            // Clamp between 10% and 200%
            depositPercent = Math.min(200, Math.max(10, parseInt(depositPercentInput.value, 10) || 100));
        }

        // Check for conditional proposal option (default to false if not available)
        const conditionalCheckbox = document.getElementById('proposalConditionalCheckbox');
        const isConditional = conditionalCheckbox ? conditionalCheckbox.checked : false;

        const proposal = {
            author,
            title: proposalName || proposalType, // Keep a stable human-readable title
            name: proposalName || proposalType,
            proposalName: proposalName || proposalType,
            description: description || proposalName || proposalType,
            offer,
            offerCurrency,
            budget: offer, // Add budget field - initially same as offer
            budgetCurrency: offerCurrency,
            parcelIds: finalParcelIds,
            type: 'parcel', // For future extension to road/building proposals
            primaryType: proposalMainType,
            acceptedParcelIds: [], // Track which parcels have accepted the proposal
            ownerAcceptances: {},
            bounds: bounds, // Store bounds for reliable positioning
            createdAt: new Date().toISOString(), // Add creation timestamp
            expiresAt: expiresAt, // Expiry timestamp (null if no expiry)
            decayEnabled: decayEnabled, // Whether amount decay is enabled
            decayPercent: decayPercent, // Percentage of offer that decays (e.g., 50 means 50%)
            decayDurationMs: decayDurationMs, // Duration over which decay happens (in ms)
            depositEnabled: depositEnabled, // Whether deposit is enabled
            depositPercent: depositPercent, // Percentage of offer deposited (10-200%)
            isConditional: isConditional,
            disbursementMode: isConditional ? 'conditional' : 'partial' // conditional = all must accept; partial = per-acceptance payouts
        };

        if (proposalMainType === 'Reparcellization') {
            if (!pendingReparcelPlan || !Array.isArray(pendingReparcelPlan.parcelIds)) {
                showProposalAlertMessage('reparcellization_plan_is_missing_please_rerun_the_algorithm', 'Reparcellization plan is missing. Please rerun the algorithm.');
                return;
            }
            const planParcelSet = new Set((pendingReparcelPlan.parcelIds || []).map(id => id && id.toString()));
            const finalParcelSet = new Set(finalParcelIds.map(id => id && id.toString()));
            const parcelsMatch = planParcelSet.size === finalParcelSet.size && Array.from(planParcelSet).every(id => finalParcelSet.has(id));
            if (!parcelsMatch) {
                showProposalAlertMessage('selected_parcels_changed_after_running_reparcellization_please_rerun_the_algorithm', 'Selected parcels changed after running reparcellization. Please rerun the algorithm.');
                return;
            }
            proposal.type = 'reparcellization';
            proposal.reparcellization = JSON.parse(JSON.stringify(pendingReparcelPlan));
            proposal.reparcellization.parcelIds = finalParcelIds.slice();
        }

        let hash = null;

        // Try to mint on-chain if blockchain is available and parcels have NFTs
        let onchainResult = null;
        const walletManager = window.walletManager;
        let hasWalletProvider = walletManager && walletManager.getProvider();

        // If blockchain is supported but wallet is not connected, prompt user to connect
        if (shouldMintOnchain && !hasWalletProvider) {
            if (walletManager && typeof walletManager.openConnectorModal === 'function') {
                updateStatus('Please connect your wallet to mint the proposal on blockchain...');

                // Open wallet connection modal and wait for connection
                walletManager.openConnectorModal();

                // Wait for wallet connection with a timeout
                const connectionPromise = new Promise((resolve) => {
                    let resolved = false;
                    const timeout = setTimeout(() => {
                        if (!resolved) {
                            resolved = true;
                            walletManager.off('connect', handleConnect);
                            walletManager.off('error', handleError);
                            walletManager.off('disconnect', handleDisconnect);
                            walletManager.closeConnectorModal();
                            updateStatus('Wallet connection timeout.');
                            resolve(false);
                        }
                    }, 60000); // 60 second timeout

                    const handleConnect = () => {
                        if (!resolved) {
                            resolved = true;
                            clearTimeout(timeout);
                            walletManager.off('connect', handleConnect);
                            walletManager.off('error', handleError);
                            walletManager.off('disconnect', handleDisconnect);
                            walletManager.closeConnectorModal();
                            updateStatus('Wallet connected! Proceeding with blockchain minting...');
                            resolve(true);
                        }
                    };

                    const handleError = () => {
                        if (!resolved) {
                            resolved = true;
                            clearTimeout(timeout);
                            walletManager.off('connect', handleConnect);
                            walletManager.off('error', handleError);
                            walletManager.off('disconnect', handleDisconnect);
                            walletManager.closeConnectorModal();
                            updateStatus('Wallet connection cancelled.');
                            resolve(false);
                        }
                    };

                    const handleDisconnect = () => {
                        // If disconnected while waiting, treat as cancellation
                        handleError();
                    };

                    walletManager.on('connect', handleConnect);
                    walletManager.on('error', handleError);
                    walletManager.on('disconnect', handleDisconnect);
                });

                const connected = await connectionPromise;
                if (!connected) {
                    // User cancelled or timeout - cancel creation entirely, keep modal filled
                    updateStatus('Proposal creation cancelled.');
                    hideWaitingPopupSafe();
                    setProposalModalInteractivity(true);
                    setProposalCreateButtonState(false);
                    return;
                } else {
                    // Wallet connected - check provider again
                    hasWalletProvider = walletManager && walletManager.getProvider();
                }
            } else {
                // Fallback: show alert if wallet manager is not available
                const walletPrompt = t('alerts.messages.blockchain_mint_wallet_prompt', 'Blockchain minting is available but no wallet is connected. Would you like to connect a wallet to mint this proposal on-chain?');
                const connectWallet = confirm(walletPrompt);
                if (connectWallet && walletManager && typeof walletManager.openConnectorModal === 'function') {
                    walletManager.openConnectorModal();
                    return; // User will need to click Create Proposal again after connecting
                }
            }
        }

        if (shouldMintOnchain && hasWalletProvider) {
            try {
                updateStatus('Preparing proposal for blockchain minting...');

                // Get parcel features for screenshot generation
                const parcelFeatures = [];
                const parcelPolygons = [];
                console.debug('[proposal-mint] Building parcel polygons for proposal', {
                    parcelIds: finalParcelIds.slice(0, 10),
                    parcelCount: finalParcelIds.length
                });

                for (const parcelId of finalParcelIds) {
                    let parcelLayer = null;
                    if (typeof multiParcelSelection !== 'undefined' && multiParcelSelection.findParcelById) {
                        parcelLayer = multiParcelSelection.findParcelById(parcelId);
                    }
                    if (!parcelLayer && typeof resolveParcelLayerById === 'function') {
                        parcelLayer = resolveParcelLayerById(parcelId);
                    }
                    // If still not resolved, fetch it to ensure geometry is available
                    if (!parcelLayer && typeof fetchSingleParcelById === 'function') {
                        try {
                            parcelLayer = await fetchSingleParcelById(parcelId, { forceRefresh: false });
                        } catch (err) {
                            console.warn(`[proposal-mint] Unable to fetch parcel ${parcelId} for proposal minting:`, err);
                        }
                    }
                    if (parcelLayer && parcelLayer.feature) {
                        parcelFeatures.push(parcelLayer.feature);
                        // Extract coordinates for polygon
                        if (parcelLayer.feature.geometry && parcelLayer.feature.geometry.coordinates) {
                            const coords = parcelLayer.feature.geometry.coordinates;
                            if (Array.isArray(coords) && coords.length > 0) {
                                // Handle different geometry types
                                if (coords[0][0] && Array.isArray(coords[0][0])) {
                                    // MultiPolygon or Polygon
                                    parcelPolygons.push(coords[0]);
                                } else if (coords[0] && typeof coords[0][0] === 'number') {
                                    // Simple polygon
                                    parcelPolygons.push(coords);
                                }
                            }
                        }
                    } else {
                        console.warn('[proposal-mint] Missing parcel layer or feature for', parcelId);
                    }
                }

                console.debug('[proposal-mint] Parcel polygon collection result', {
                    parcelFeaturesCount: parcelFeatures.length,
                    parcelPolygonsCount: parcelPolygons.length,
                    firstPolygonSample: parcelPolygons[0]
                });

                if (parcelFeatures.length === 0) {
                    console.warn('No parcel features found for screenshot generation');
                } else {
                    // Use formatted parcel IDs from earlier check, or derive them if not available
                    let parcelIdsForMinting = formattedParcelIds;
                    if (!parcelIdsForMinting || parcelIdsForMinting.length === 0) {
                        // Derive parcel IDs in the format expected by the contract
                        parcelIdsForMinting = parcelFeatures
                            .map(feature => {
                                if (window.ProposalChainBridge && window.ProposalChainBridge.deriveParcelIdFromFeature) {
                                    return window.ProposalChainBridge.deriveParcelIdFromFeature(feature);
                                }
                                // Fallback: try to format from properties
                                const props = feature.properties || {};
                                if (props.MATICNI_BROJ_KO && props.BROJ_CESTICE) {
                                    return window.ProposalChainBridge ?
                                        window.ProposalChainBridge.formatParcelId(props.MATICNI_BROJ_KO, props.BROJ_CESTICE) :
                                        `HR-${props.MATICNI_BROJ_KO}-${props.BROJ_CESTICE}`;
                                }
                                return props.CESTICA_ID ? props.CESTICA_ID.toString() : null;
                            })
                            .filter(Boolean);
                    }

                    if (parcelIdsForMinting.length === 0) {
                        console.warn('Could not derive formatted parcel IDs for on-chain minting');
                    } else {
                        // Generate screenshot
                        if (!window.MapScreenshot || typeof window.MapScreenshot.capturePolygonImage !== 'function') {
                            throw new Error('Map screenshot capture is not available.');
                        }
                        if (!window.AssetService || typeof window.AssetService.uploadProposalAssets !== 'function') {
                            throw new Error('Asset upload service is not available.');
                        }

                        // Build combined polygon from all parcels for screenshot
                        const combinedPolygon = [];
                        let minLat = Infinity;
                        let maxLat = -Infinity;
                        let minLng = Infinity;
                        let maxLng = -Infinity;

                        const addPoint = (lat, lng) => {
                            if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
                                return;
                            }
                            combinedPolygon.push([lat, lng]);
                            minLat = Math.min(minLat, lat);
                            maxLat = Math.max(maxLat, lat);
                            minLng = Math.min(minLng, lng);
                            maxLng = Math.max(maxLng, lng);
                        };

                        const addCoords = (segment) => {
                            if (!Array.isArray(segment)) return;
                            // If this looks like a point [lng, lat]
                            if (segment.length === 2 && Number.isFinite(segment[0]) && Number.isFinite(segment[1])) {
                                const lat = Math.abs(segment[0]) <= 90 ? segment[0] : segment[1];
                                const lng = Math.abs(segment[0]) <= 90 ? segment[1] : segment[0];
                                addPoint(lat, lng);
                                return;
                            }
                            // If this is a ring or nested array, recurse
                            segment.forEach(inner => addCoords(inner));
                        };

                        parcelPolygons.forEach(poly => addCoords(poly));

                        if (combinedPolygon.length < 3) {
                            // Derive a rectangle from min/max if we collected any coords
                            if (Number.isFinite(minLat) && Number.isFinite(maxLat) && Number.isFinite(minLng) && Number.isFinite(maxLng)) {
                                console.warn('[proposal-mint] Fallback rectangle from min/max bounds', { minLat, maxLat, minLng, maxLng });
                                combinedPolygon.length = 0;
                                combinedPolygon.push([minLat, minLng]);
                                combinedPolygon.push([minLat, maxLng]);
                                combinedPolygon.push([maxLat, maxLng]);
                                combinedPolygon.push([maxLat, minLng]);
                                combinedPolygon.push([minLat, minLng]);
                            }
                        }

                        if (combinedPolygon.length < 3) {
                            // Fallback: use map bounds if available
                            if (bounds && typeof bounds.getSouthWest === 'function') {
                                const sw = bounds.getSouthWest();
                                const ne = bounds.getNorthEast();
                                console.warn('[proposal-mint] Fallback rectangle from map bounds', { sw, ne });
                                combinedPolygon.push([sw.lat, sw.lng]);
                                combinedPolygon.push([sw.lat, ne.lng]);
                                combinedPolygon.push([ne.lat, ne.lng]);
                                combinedPolygon.push([ne.lat, sw.lng]);
                                combinedPolygon.push([sw.lat, sw.lng]);
                            }
                        }

                        if (combinedPolygon.length < 3) {
                            console.error('[proposal-mint] Unable to derive proposal polygon', {
                                parcelIds: finalParcelIds.slice(0, 10),
                                parcelPolygonsCount: parcelPolygons.length
                            });
                            throw new Error('Unable to derive proposal polygon for NFT metadata.');
                        }

                        updateStatus('Generating proposal image...');
                        const screenshotDataUrl = await window.MapScreenshot.capturePolygonImage({
                            polygon: combinedPolygon,
                            parcelPolygons: parcelPolygons,
                            padding: 0.05,
                            size: 600
                        });

                        // Convert offer to ETH amount
                        // If currency is ETH, use the offer amount directly (will be converted to Wei by mintRoadProposal)
                        // Otherwise, set to 0 (no ETH funding, but proposal can still be minted)
                        const ethAmount = offerCurrency === 'ETH' ? offer : 0;

                        updateStatus('Uploading proposal assets to IPFS...');
                        const metadataPayload = {
                            name: `${proposalType} Proposal`,
                            description: description,
                            image: '', // populated after image upload
                            attributes: [
                                {
                                    trait_type: 'Proposal Type',
                                    value: proposalType
                                },
                                {
                                    trait_type: 'Conditional',
                                    value: isConditional ? 'Yes' : 'No'
                                },
                                {
                                    trait_type: 'Parcel Count',
                                    value: parcelIdsForMinting.length
                                },
                                {
                                    trait_type: 'Author',
                                    value: author
                                }
                            ],
                            properties: {
                                parcelIds: parcelIdsForMinting,
                                conditional: isConditional,
                                ethAmount: ethAmount,
                                offer: offer,
                                offerCurrency: offerCurrency,
                                createdAt: new Date().toISOString(),
                                proposalHash: hash
                            }
                        };

                        const fileNameBase = `proposal-${Date.now()}`;
                        const assetUploadResult = await window.AssetService.uploadProposalAssets({
                            imageData: screenshotDataUrl,
                            metadata: metadataPayload,
                            fileName: `${fileNameBase}.png`
                        });
                        const metadataUri = assetUploadResult?.metadataUri || assetUploadResult?.metadataUrl || '';

                        if (!metadataUri) {
                            throw new Error('Metadata URI missing from asset upload response.');
                        }

                        showProposalWaitingPopup('Waiting for transaction...');
                        waitingPopupVisible = true;
                        setProposalModalDimmed(true);
                        updateStatus('Minting proposal on blockchain...');
                        onchainResult = await window.ProposalChainBridge.mintRoadProposal({
                            parcelIds: parcelIdsForMinting,
                            isConditional: isConditional,
                            ethAmount: ethAmount,
                            tokenAmount: 0n,
                            imageURI: metadataUri
                        });
                        hideWaitingPopupSafe();

                        proposal.onchain = {
                            transactionHash: onchainResult.transactionHash,
                            proposalId: onchainResult.proposalId,
                            chainId: onchainResult.chainId,
                            contractAddress: onchainResult.contractAddress,
                            metadataUri,
                            metadataUrl: assetUploadResult?.metadataGatewayUrl || null,
                            imageUri: assetUploadResult?.imageUri || null,
                            imageUrl: assetUploadResult?.imageGatewayUrl || null
                        };

                        // Update stored proposal with on-chain data
                        const stored = proposalStorage.getProposal(hash);
                        if (stored) {
                            stored.onchain = { ...proposal.onchain };
                            proposalStorage.proposals.set(hash, stored);
                            if (typeof proposalStorage.save === 'function') {
                                proposalStorage.save();
                            }
                        }

                        updateStatus(`Proposal minted on blockchain! Transaction: ${onchainResult.transactionHash.substring(0, 10)}...`);
                    }
                }
            } catch (error) {
                hideWaitingPopupSafe();
                console.error('On-chain mint failed:', error);

                const isUserCancelled = (err) => {
                    const code = err && (err.code || err.error?.code || err.data?.code || err.info?.error?.code);
                    const rawMessage = err && (err.message || err.error?.message || err.data?.message || err.shortMessage || err.info?.error?.message || '');
                    const message = (rawMessage || '').toLowerCase();
                    return code === 4001
                        || code === 'ACTION_REJECTED'
                        || code === 'TRANSACTION_REJECTED'
                        || message.includes('user rejected')
                        || message.includes('user denied')
                        || message.includes('user canceled')
                        || message.includes('user cancelled')
                        || message.includes('rejected by user')
                        || message.includes('transaction was rejected')
                        || message.includes('transaction rejected')
                        || message.includes('request rejected');
                };

                if (isUserCancelled(error)) {
                    showProposalWaitingPopupTemporary('Transaction rejected', 2000);
                    updateStatus('Proposal creation cancelled.');
                    setProposalModalInteractivity(true);
                    setProposalCreateButtonState(false);
                    return;
                }

                const mintFailedMessage = t('alerts.messages.onchain_mint_failed_saved_locally', 'On-chain mint failed: {{error}}. Proposal saved locally.', { error: error?.message || '' });
                if (typeof showEphemeralMessage === 'function') {
                    showEphemeralMessage(mintFailedMessage, 6000, 'error');
                } else {
                    showProposalAlertMessage('onchain_mint_failed_saved_locally', 'On-chain mint failed: {{error}}. Proposal saved locally.', { error: error?.message || '' });
                }
                // Continue with local proposal creation even if on-chain mint fails
            }
        }

        // Persist proposal after on-chain handling (or local-only)
        hash = proposalStorage.addProposal(proposal);
        if (hash === null) {
            showProposalAlertMessage('this_exact_proposal_already_exists', 'This exact proposal already exists');
            return;
        }

        // Update stored proposal with on-chain data if available
        if (onchainResult) {
            const stored = proposalStorage.getProposal(hash);
            if (stored) {
                stored.onchain = { ...(stored.onchain || {}), ...(proposal.onchain || {}) };
                proposalStorage.proposals.set(hash, stored);
                if (typeof proposalStorage.save === 'function') {
                    proposalStorage.save();
                }
            }
        }

        // Update the show proposals button count
        updateShowProposalsButton();
        // Log user action for proposal creation
        const userAgent = getCurrentUserAgent();
        if (userAgent && typeof addUserActionToGameLog === 'function') {
            const storedProposal = typeof proposalStorage !== 'undefined' && typeof proposalStorage.getProposal === 'function'
                ? proposalStorage.getProposal(hash)
                : null;
            const proposalIdForLog = storedProposal && storedProposal.proposal_id !== undefined && storedProposal.proposal_id !== null
                ? String(storedProposal.proposal_id)
                : (storedProposal && storedProposal.proposalId !== undefined && storedProposal.proposalId !== null
                    ? String(storedProposal.proposalId)
                    : hash.substring(0, 8));
            const proposalIdAttr = storedProposal && storedProposal.proposal_id !== undefined && storedProposal.proposal_id !== null
                ? String(storedProposal.proposal_id)
                : (storedProposal && storedProposal.proposalId !== undefined && storedProposal.proposalId !== null
                    ? String(storedProposal.proposalId)
                    : hash);
            const proposalLinkHtml = `<a href="#" data-proposal-id="${proposalIdAttr}" data-proposal-hash="${hash}" class="proposal-link proposal-link-clickable">${proposalIdForLog}</a>`;
            const budgetCurrencyLabel = offerCurrency || 'USDT';
            const onchainNote = onchainResult ? ' (on-chain)' : '';
            addUserActionToGameLog(`<a href="#" data-agent-id="${userAgent.id}" class="agent-link agent-link-clickable">${userAgent.name}</a> created a ${proposalType} proposal${onchainNote} (${proposalLinkHtml}) for ${proposal.parcelIds.length} parcel(s) with budget ${offer} ${budgetCurrencyLabel}.`);

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

        const statusMessage = onchainResult
            ? `Proposal "${proposalType}" created and minted on blockchain with ${proposal.parcelIds.length} parcels.`
            : `Proposal "${proposalType}" created successfully with ${proposal.parcelIds.length} parcels.`;
        updateStatus(statusMessage);

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
        const openProposalDetails = () => {
            if (typeof selectAndHighlightProposal === 'function') {
                selectAndHighlightProposal(hash, focusParcelId, true, true);
            } else if (typeof showProposalDetailsModal === 'function') {
                showProposalDetailsModal(hash);
            }
        };

        if (onchainResult) {
            showProposalMintSuccessModal({
                proposalId: onchainResult.proposalId,
                proposalHash: hash,
                txHash: onchainResult.transactionHash,
                chainId: onchainResult.chainId,
                onClose: openProposalDetails
            });
        } else {
            openProposalDetails();
        }

    } catch (error) {
        console.error('Error creating proposal:', error);
        const fallback = t('alerts.messages.failed_to_create_proposal', 'Failed to create proposal.');
        const message = (error && error.message) ? error.message : fallback;
        if (typeof window !== 'undefined' && typeof window.showStyledAlert === 'function') {
            window.showStyledAlert(message);
        } else {
            alert(message);
        }
    } finally {
        hideWaitingPopupSafe();
        setProposalModalInteractivity(true);
        setProposalCreateButtonState(false);
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

const PROPOSAL_TYPE_FILTER_I18N_KEYS = {
    all: 'all',
    road: 'road',
    building: 'building',
    park: 'park',
    square: 'square',
    structure: 'structure',
    reparcellization: 'reparcellization',
    parcel: 'parcel',
    other: 'other'
};

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

function getLocalizedProposalTypeFilters() {
    const t = getProposalI18nHelper();
    return PROPOSAL_TYPE_FILTERS.map(option => {
        const i18nKey = PROPOSAL_TYPE_FILTER_I18N_KEYS[option.value] || option.value;
        return {
            ...option,
            label: t(`modal.roadWidth.proposalList.filters.types.${i18nKey}`, option.label)
        };
    });
}

function getProposalTypeLabel(typeKey) {
    const t = getProposalI18nHelper();
    const normalizedKey = (typeKey || 'other').toLowerCase();
    const fallback = PROPOSAL_TYPE_LABELS[normalizedKey]
        || (normalizedKey ? normalizedKey.charAt(0).toUpperCase() + normalizedKey.slice(1) : '');
    return t(`modal.roadWidth.proposalList.typeLabels.${normalizedKey}`, fallback);
}

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
    return getProposalTypeLabel(typeKey);
}

function isProposalApplied(proposal) {
    if (!proposal) return false;

    const structureData = resolveStructureProposal(proposal);
    const hasSpatialComponent = Boolean(
        (proposal.roadProposal && proposal.roadProposal.roadGeometry)
        || proposal.roadGeometry
        || proposal.buildingProposal
        || proposal.buildingGeometry
        || structureData
        || proposal.reparcellization
        || ['road', 'building', 'park', 'square', 'structure', 'reparcellization'].includes((proposal.type || '').toLowerCase())
    );

    const globalStatus = (proposal.status || '').toLowerCase();
    if (hasSpatialComponent && (globalStatus === 'applied' || globalStatus === 'executed')) {
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
    if (lifecycleField === 'expired') return 'expired';
    if (PROPOSAL_INACTIVE_STATUSES.has(lifecycleField)) return 'inactive';
    return 'active';
}

function getProposalLifecycleLabel(key) {
    const t = getProposalI18nHelper();
    switch (key) {
        case 'executed':
            return t('panel.proposal.lifecycle.executed', 'Executed');
        case 'expired':
            return t('panel.proposal.lifecycle.expired', 'Expired');
        case 'inactive':
            return t('panel.proposal.lifecycle.inactive', 'Inactive');
        default:
            return t('panel.proposal.lifecycle.active', 'Active');
    }
}

function getProposalLifecycleClass(key) {
    switch (key) {
        case 'executed':
            return 'executed';
        case 'expired':
            return 'expired';
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
    window.getParcelAreaById = getParcelAreaById;
}

function getParcelAreaById(parcelId) {
    if (parcelId === undefined || parcelId === null) return 0;
    let area = 0;
    let source = 'none';

    try {
        const layer = typeof resolveParcelLayerById === 'function'
            ? resolveParcelLayerById(parcelId)
            : (typeof multiParcelSelection !== 'undefined' && multiParcelSelection && typeof multiParcelSelection.findParcelById === 'function'
                ? multiParcelSelection.findParcelById(parcelId)
                : null);
        if (layer && layer.feature?.properties && Number.isFinite(layer.feature.properties.calculatedArea)) {
            area = Number(layer.feature.properties.calculatedArea) || 0;
            source = 'resolveParcelLayerById';
        }
    } catch (err) {
        console.warn('[getParcelAreaById] resolveParcelLayerById error:', err);
    }

    if (!area) {
        try {
            if (typeof parcelLayer !== 'undefined' && parcelLayer && typeof parcelLayer.eachLayer === 'function') {
                parcelLayer.eachLayer(l => {
                    if (area) return;
                    const candidate = l?.feature?.properties?.CESTICA_ID;
                    if (candidate !== undefined && candidate !== null && candidate.toString() === parcelId.toString()) {
                        const maybeArea = l.feature?.properties?.calculatedArea;
                        if (Number.isFinite(maybeArea)) {
                            area = Number(maybeArea) || 0;
                            source = 'parcelLayer.eachLayer';
                        }
                    }
                });
            }
        } catch (err) {
            console.warn('[getParcelAreaById] parcelLayer.eachLayer error:', err);
        }
    }

    if (!area) {
        try {
            const stored = PersistentStorage.getItem(`parcel_${parcelId}_properties`);
            if (stored) {
                const props = JSON.parse(stored);
                if (props && Number.isFinite(props.calculatedArea)) {
                    area = Number(props.calculatedArea) || 0;
                    source = 'PersistentStorage';
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
    // Action buttons (Apply to map / Remove from map) are now only available in proposal details modal
    // Removed from proposal list cards to simplify the UI
    return '';
}

function buildProposalListItemsHtml(dataset) {
    const t = getProposalI18nHelper();
    const metaLabels = {
        author: t('modal.roadWidth.proposalList.meta.author', 'Author:'),
        created: t('modal.roadWidth.proposalList.meta.created', 'Created:'),
        acceptance: t('modal.roadWidth.proposalList.meta.acceptance', 'Acceptance:'),
        parcels: t('modal.roadWidth.proposalList.meta.parcels', 'Parcels:'),
        area: t('modal.roadWidth.proposalList.meta.area', 'Area:'),
        offer: t('modal.roadWidth.proposalList.meta.offer', 'Offer:')
    };
    const emptyText = t('modal.roadWidth.proposalList.empty', 'No proposals match the current filters.');
    const untitledLabel = t('modal.roadWidth.proposalList.untitled', 'Untitled proposal');
    const unknownAuthor = t('common.unknown', 'Unknown');
    const deleteTooltip = t('modal.roadWidth.proposalList.deleteTooltip', 'Delete proposal');

    if (!dataset || dataset.length === 0) {
        return `<p class="empty-proposals">${escapeHtml(emptyText)}</p>`;
    }

    return dataset.map(entry => {
        const { proposal, metrics } = entry;
        const hash = proposal.proposalHash;
        const color = typeof getProposalColor === 'function' ? getProposalColor(hash) : '#007bff';
        const lifecycleKey = getProposalLifecycleKey(proposal);
        const statusLabel = escapeHtml(getProposalLifecycleLabel(lifecycleKey));
        const statusClass = getProposalLifecycleClass(lifecycleKey);
        const typeLabel = escapeHtml(formatProposalTypeLabel(metrics.typeKey));
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
        const safeTitle = escapeHtml(proposal.title || untitledLabel);
        const safeAuthor = escapeHtml(metrics.author || unknownAuthor);

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
                        <div class="proposal-status-indicator ${statusClass}">${statusLabel}</div>
                        <button class="proposal-delete-btn" onclick="event.stopPropagation(); deleteProposal('${hash}')" title="${escapeHtml(deleteTooltip)}">
                            <i class="fas fa-trash"></i>
                        </button>
                    </div>
                </div>
                <div class="proposal-list-meta">
                    <span><strong>${escapeHtml(metaLabels.author)}</strong> <span class="proposal-meta-value">${safeAuthor}</span></span>
                    <span><strong>${escapeHtml(metaLabels.created)}</strong> <span class="proposal-meta-value">${escapeHtml(createdDate)}</span></span>
                    <span><strong>${escapeHtml(metaLabels.acceptance)}</strong> <span class="proposal-meta-value">${escapeHtml(acceptanceText)}</span></span>
                    <span><strong>${escapeHtml(metaLabels.parcels)}</strong> <span class="proposal-meta-value">${escapeHtml(String(metrics.parcelCount))}</span></span>
                    <span><strong>${escapeHtml(metaLabels.area)}</strong> <span class="proposal-meta-value">${escapeHtml(areaText)}</span></span>
                    <span><strong>${escapeHtml(metaLabels.offer)}</strong> <span class="proposal-meta-value">${escapeHtml(offerText)}</span></span>
                </div>
                ${proposal.description ? `<div class="proposal-list-description">${escapeHtml(proposal.description)}</div>` : ''}
            </div>
        `;
    }).join('');
}

function refreshProposalOwnerAcceptanceUI(proposal, parcelId) {
    if (!proposal) return;

    const parcelStatusHtml = buildParcelAcceptanceStatusHtml(proposal);
    const parcelStatusContainer = document.querySelector('.proposal-acceptance-status:not(.owner)');
    if (parcelStatusContainer) {
        if (parcelStatusHtml) {
            const temp = document.createElement('div');
            temp.innerHTML = parcelStatusHtml.trim();
            parcelStatusContainer.replaceWith(temp.firstElementChild);
        } else {
            parcelStatusContainer.remove();
        }
    } else if (parcelStatusHtml) {
        const ownerStatusContainer = document.querySelector('.proposal-acceptance-status.owner');
        if (ownerStatusContainer && ownerStatusContainer.parentNode) {
            const temp = document.createElement('div');
            temp.innerHTML = parcelStatusHtml.trim();
            ownerStatusContainer.parentNode.insertBefore(temp.firstElementChild, ownerStatusContainer);
        }
    }

    // Update owner acceptance summary
    const summaryHtml = buildOwnerAcceptanceStatusHtml(proposal);
    const summaryContainer = document.querySelector('.proposal-acceptance-status.owner');
    if (summaryContainer) {
        if (summaryHtml) {
            const temp = document.createElement('div');
            temp.innerHTML = summaryHtml.trim();
            summaryContainer.replaceWith(temp.firstElementChild);
        } else {
            summaryContainer.remove();
        }
    } else if (summaryHtml) {
        const reference = document.querySelector('.proposal-acceptance-status');
        if (reference && reference.parentNode) {
            const temp = document.createElement('div');
            temp.innerHTML = summaryHtml.trim();
            reference.parentNode.insertBefore(temp.firstElementChild, reference.nextSibling);
        }
    }

    const parcelIdStr = parcelId != null ? parcelId.toString() : '';
    const parcelItem = document.querySelector(`.proposal-parcel-item[data-parcel-id="${parcelIdStr}"]`);
    if (!parcelItem) {
        return;
    }

    const hasAccepted = Array.isArray(proposal.acceptedParcelIds) &&
        proposal.acceptedParcelIds.includes(parcelIdStr);

    const statusSpan = parcelItem.querySelector('.parcel-status');
    if (statusSpan) {
        statusSpan.textContent = hasAccepted ? '✓ Accepted' : 'Pending';
        statusSpan.classList.toggle('parcel-status-accepted', hasAccepted);
        statusSpan.classList.toggle('parcel-status-pending', !hasAccepted);
        statusSpan.style.color = hasAccepted ? '#28a745' : '#666';
        statusSpan.style.fontWeight = hasAccepted ? '500' : '';
    }

    const acceptanceHtml = buildOwnerAcceptanceSectionHtml(proposal, parcelId, { compact: true, skipParcelPanelFocus: true });
    let acceptanceContainer = parcelItem.querySelector('.parcel-owner-acceptance');

    if (acceptanceHtml) {
        if (!acceptanceContainer) {
            acceptanceContainer = document.createElement('div');
            acceptanceContainer.className = 'parcel-owner-acceptance';
            acceptanceContainer.setAttribute('onclick', 'event.stopPropagation(); event.preventDefault(); return false;');
            parcelItem.appendChild(acceptanceContainer);
        }
        acceptanceContainer.innerHTML = acceptanceHtml;
    } else if (acceptanceContainer) {
        acceptanceContainer.remove();
    }
}

function renderProposalListModal() {
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
            type: t('modal.roadWidth.proposalList.filters.type', 'Type'),
            author: t('modal.roadWidth.proposalList.filters.author', 'Author'),
            search: t('modal.roadWidth.proposalList.filters.search', 'Search'),
            sort: t('modal.roadWidth.proposalList.filters.sort', 'Sort by'),
            authorPlaceholder: t('modal.roadWidth.proposalList.filters.authorPlaceholder', 'All authors'),
            searchPlaceholder: t('modal.roadWidth.proposalList.filters.searchPlaceholder', 'Search title or author'),
            reset: t('modal.roadWidth.proposalList.filters.reset', 'Reset'),
            resetTooltip: t('modal.roadWidth.proposalList.filters.resetTooltip', 'Reset filters')
        }
    };

    const typeOptions = getLocalizedProposalTypeFilters();
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

    const allProposals = proposalStorage.getAllProposals();

    // Check and update expiry status for all proposals
    allProposals.forEach(proposal => {
        checkAndUpdateProposalExpiry(proposal);
    });

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
                <label for="proposal-filter-type" data-i18n-key="modal.roadWidth.proposalList.filters.type">${escapeHtml(modalStrings.filters.type)}</label>
                <select id="proposal-filter-type">
                    ${typeOptions.map(option => `
                        <option value="${option.value}" ${option.value === proposalListState.filterType ? 'selected' : ''} data-i18n-key="modal.roadWidth.proposalList.filters.types.${option.value}">${escapeHtml(option.label)}</option>
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
            <button class="proposal-filter-reset" id="proposal-filter-reset" title="${escapeHtml(modalStrings.filters.resetTooltip)}" data-i18n-key="modal.roadWidth.proposalList.filters.reset" data-i18n-attr="text,title">${escapeHtml(modalStrings.filters.reset)}</button>
        </div>
    `;

    modal.innerHTML = `
        <div class="proposal-list-modal-content">
            <div class="proposal-list-modal-header">
                <h2 data-i18n-key="modal.roadWidth.proposalList.title">${escapeHtml(modalStrings.title)}</h2>
                <button type="button" class="proposal-list-modal-close close-circle-btn close-circle-btn--lg" aria-label="${escapeHtml(modalStrings.closeAria)}" data-i18n-key="modal.roadWidth.proposalList.closeAria" data-i18n-attr="aria-label" onclick="closeProposalList()">&times;</button>
            </div>
            ${controlsHtml}
            <div class="proposal-list-tabs">
                <button class="proposal-tab-btn ${proposalListState.activeTab === 'active' ? 'active' : ''}" data-tab="active" data-i18n-key="modal.roadWidth.proposalList.tabs.active">
                    ${escapeHtml(modalStrings.tabs.active)} (${filteredActive.length}${filteredActive.length !== activeDataset.length ? `/${activeDataset.length}` : ''})
                </button>
                <button class="proposal-tab-btn ${proposalListState.activeTab === 'executed' ? 'active' : ''}" data-tab="executed" data-i18n-key="modal.roadWidth.proposalList.tabs.executed">
                    ${escapeHtml(modalStrings.tabs.executed)} (${filteredExecuted.length}${filteredExecuted.length !== executedDataset.length ? `/${executedDataset.length}` : ''})
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
        fallbackMap.set('modal.roadWidth.proposalList.filters.type', modalStrings.filters.type);
        fallbackMap.set('modal.roadWidth.proposalList.filters.author', modalStrings.filters.author);
        fallbackMap.set('modal.roadWidth.proposalList.filters.search', modalStrings.filters.search);
        fallbackMap.set('modal.roadWidth.proposalList.filters.sort', modalStrings.filters.sort);
        fallbackMap.set('modal.roadWidth.proposalList.filters.authorPlaceholder', modalStrings.filters.authorPlaceholder);
        fallbackMap.set('modal.roadWidth.proposalList.filters.searchPlaceholder', modalStrings.filters.searchPlaceholder);
        fallbackMap.set('modal.roadWidth.proposalList.filters.reset', modalStrings.filters.reset);
        // Type options
        typeOptions.forEach(option => {
            const key = `modal.roadWidth.proposalList.filters.types.${option.value}`;
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

    proposalListState.selectedHash = hash;

    resetParcelSelectionForProposalListInteraction();
    openProposalFromList(hash, {
        proposal,
        closeProposalList: true,
        closeParcelInfo: true,
        closeAgentDialog: false,
        collapseSidebar: true
    });
}

function showProposalDetailsModal(proposalHash, options = {}) {
    if (!proposalHash) return;
    openProposalFromList(proposalHash, options);
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
function closeProposalList(options = {}) {
    const normalized = options && typeof options === 'object' ? options : {};
    const clearHighlights = normalized.clearHighlights !== false;
    const modal = document.querySelector('.proposal-list-modal');
    if (modal) {
        modal.style.display = 'none';
        // When the Proposal List closes, clear any proposal-specific overlays/highlights
        try { clearProposalInfoHoverOverlay(); } catch (_) { }
        if (clearHighlights) {
            try { clearProposalHighlights(); } catch (_) { }
        }
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
        const i18nApi = (typeof window !== 'undefined') ? window.i18n : null;
        button.setAttribute('data-i18n-key', 'sidebar.proposals.listButton');
        button.setAttribute('data-i18n-params', JSON.stringify({ count: totalProposals }));
        if (i18nApi && typeof i18nApi.t === 'function') {
            button.textContent = i18nApi.t('sidebar.proposals.listButton', { count: totalProposals });
        } else {
            button.textContent = `Proposals List (${totalProposals})`;
        }
    }

    // Also sync the proposals presence indicator
    if (typeof syncProposalsIndicator === 'function') {
        syncProposalsIndicator();
    }

    if (typeof refreshBlockInfoProposalTab === 'function') {
        try { refreshBlockInfoProposalTab(); } catch (_) { }
    }
}

// Proposals section no longer has a checkbox - this function is kept for compatibility
// but does nothing since proposals are always shown
function syncProposalsIndicator() {
    // Proposals are always shown now, no checkbox to sync
    // Reset any previously set opacity on the Proposals header to keep it consistent
    const sections = document.querySelectorAll('.accordion-section[data-section="proposals"]');
    sections.forEach(section => {
        const header = section.querySelector('.accordion-header');
        if (header) {
            header.style.opacity = ''; // Clear inline opacity
        }
    });
}

function getExplorerBaseUrlForChain(chainId) {
    const id = chainId ? chainId.toString() : '';
    switch (id) {
        case '1':
            return 'https://etherscan.io';
        case '11155111':
            return 'https://sepolia.etherscan.io';
        case '8453':
            return 'https://basescan.org';
        case '84532':
        case '0x14a34':
            return 'https://sepolia.basescan.org';
        default:
            return null; // No explorer known (e.g., hardhat)
    }
}

function showProposalMintSuccessModal({ proposalId, proposalHash, txHash, chainId, onClose }) {
    try {
        const existing = document.getElementById('proposal-mint-success-modal');
        if (existing && existing.parentNode) {
            existing.parentNode.removeChild(existing);
        }

        const overlay = document.createElement('div');
        overlay.id = 'proposal-mint-success-modal';
        overlay.style.position = 'fixed';
        overlay.style.inset = '0';
        overlay.style.background = 'rgba(0,0,0,0.45)';
        overlay.style.display = 'flex';
        overlay.style.alignItems = 'center';
        overlay.style.justifyContent = 'center';
        overlay.style.zIndex = '12000';

        const card = document.createElement('div');
        card.style.background = '#fff';
        card.style.borderRadius = '12px';
        card.style.padding = '20px 24px';
        card.style.maxWidth = '340px';
        card.style.width = '90%';
        card.style.boxShadow = '0 10px 30px rgba(0,0,0,0.2)';
        card.style.fontFamily = 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

        const title = document.createElement('h3');
        title.textContent = 'Success!';
        title.style.margin = '0 0 8px 0';
        title.style.fontSize = '20px';
        title.style.fontWeight = '700';
        card.appendChild(title);

        const body = document.createElement('p');
        const label = proposalId ? `Proposal ${proposalId}` : (proposalHash ? `Proposal ${proposalHash.substring(0, 10)}…` : 'Proposal');
        body.textContent = `${label} has been minted!`;
        body.style.margin = '0 0 12px 0';
        body.style.fontSize = '14px';
        card.appendChild(body);

        const buttons = document.createElement('div');
        buttons.style.display = 'flex';
        buttons.style.flexDirection = 'column';
        buttons.style.gap = '10px';
        buttons.style.marginTop = '12px';

        const explorerBase = getExplorerBaseUrlForChain(chainId);
        const hasExplorer = explorerBase && txHash;
        const viewBtn = document.createElement('button');
        viewBtn.textContent = hasExplorer ? 'View on Etherscan' : 'View transaction';
        viewBtn.style.padding = '10px 12px';
        viewBtn.style.border = '1px solid #0d3b66';
        viewBtn.style.borderRadius = '8px';
        viewBtn.style.background = hasExplorer ? '#0d3b66' : '#cbd5e0';
        viewBtn.style.color = '#fff';
        viewBtn.style.cursor = hasExplorer ? 'pointer' : 'not-allowed';
        viewBtn.disabled = !hasExplorer;
        viewBtn.style.width = '100%';
        if (hasExplorer) {
            viewBtn.addEventListener('click', () => {
                const url = `${explorerBase}/tx/${txHash}`;
                window.open(url, '_blank', 'noopener,noreferrer');
            });
        }

        const okBtn = document.createElement('button');
        okBtn.textContent = 'OK';
        okBtn.style.padding = '10px 12px';
        okBtn.style.border = 'none';
        okBtn.style.borderRadius = '8px';
        okBtn.style.background = '#0d3b66';
        okBtn.style.color = '#fff';
        okBtn.style.cursor = 'pointer';
        okBtn.style.width = '100%';
        okBtn.addEventListener('click', () => {
            if (overlay.parentNode) {
                overlay.parentNode.removeChild(overlay);
            }
            if (typeof onClose === 'function') {
                try {
                    onClose();
                } catch (_) { }
            } else if (proposalHash && typeof showProposalDetailsModal === 'function') {
                try {
                    showProposalDetailsModal(proposalHash);
                } catch (_) { }
            }
        });

        buttons.appendChild(viewBtn);
        buttons.appendChild(okBtn);
        card.appendChild(buttons);
        overlay.appendChild(card);
        document.body.appendChild(overlay);
    } catch (err) {
        console.warn('Failed to show proposal mint success modal:', err);
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

// Re-render proposal list when language or translations load so modal text updates live
function rerenderProposalListIfOpen() {
    try {
        const modal = document.querySelector('.proposal-list-modal');
        if (modal && modal.style.display === 'block' && typeof renderProposalListModal === 'function') {
            renderProposalListModal();
        }
    } catch (_) { }
}

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
            const preserveSelected = source === 'tools' || source === 'info';
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

// Sharing via query params is limited by nginx's default 8 KB request line limit.
// Keep shareable links comfortably under that threshold to avoid HTTP 414 errors.
const SHARE_URL_MAX_LENGTH = 7500;
const SHARE_PAYLOAD_VERSION = 1;
const SHARE_ENCODING_PREFIX_COMPRESSED = 'z.';
const SHARE_ENCODING_PREFIX_RAW = 'u.';
const SHARE_BASE64_ALLOWED = /^[A-Za-z0-9_-]+$/;

function findParcelLayerById(parcelId) {
    const normalized = parcelId && parcelId.toString ? parcelId.toString() : parcelId;
    if (!normalized) return null;
    try {
        if (typeof multiParcelSelection !== 'undefined' && typeof multiParcelSelection.findParcelById === 'function') {
            const found = multiParcelSelection.findParcelById(normalized);
            if (found) return found;
        }
    } catch (_) { }
    try {
        const layerGroup = window.parcelLayer;
        if (layerGroup && typeof layerGroup.eachLayer === 'function') {
            let match = null;
            layerGroup.eachLayer(layer => {
                if (match || !layer || !layer.feature || !layer.feature.properties) return;
                const layerId = layer.feature.properties.CESTICA_ID;
                if (layerId && layerId.toString() === normalized) {
                    match = layer;
                }
            });
            if (match) return match;
        }
    } catch (error) {
        console.warn('findParcelLayerById failed', error);
    }
    return null;
}

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

function computeBoundsFromGeoJSONFeatures(features) {
    if (typeof L === 'undefined' || !Array.isArray(features) || features.length === 0) {
        return null;
    }
    let combined = null;
    features.forEach(feature => {
        if (!feature) return;
        try {
            const layer = L.geoJSON(feature);
            if (layer && typeof layer.getBounds === 'function') {
                const bounds = layer.getBounds();
                if (bounds && bounds.isValid()) {
                    combined = combined ? combined.extend(bounds) : bounds;
                }
            }
        } catch (error) {
            console.warn('computeBoundsFromGeoJSONFeatures skipped feature', error);
        }
    });
    return combined;
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

    const applyBounds = (bounds, padding = [80, 80]) => {
        if (!bounds || !bounds.isValid()) return false;
        try {
            map.fitBounds(bounds, { padding });
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

        const geometryFeatures = [];
        if (proposal.roadProposal && Array.isArray(proposal.roadProposal.childFeatures)) {
            proposal.roadProposal.childFeatures.forEach(feature => {
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

        const parcelLayers = ensureArrayOfStrings(proposal.parcelIds)
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
    return (key, fallback, params = {}) => t(`modal.share.${key}`, fallback, params);
}

function getSharedInspectorI18nHelper() {
    const t = getProposalI18nHelper();
    return (key, fallback, params = {}) => t(`modal.sharedInspector.${key}`, fallback, params);
}

function shareAppliedProposals() {
    try {
        const t = getProposalI18nHelper();
        const tShare = getShareI18nHelper();
        const applied = proposalStorage.getAllProposals().filter(isProposalCurrentlyApplied);
        if (applied.length === 0) {
            if (typeof showEphemeralMessage === 'function') {
                showEphemeralMessage(t('ephemeral.messages.no_applied_proposals_to_share_yet', 'No applied proposals to share yet.'));
            }
            return;
        }

        const payload = buildSharedProposalsPayload(applied);
        if (!payload || !Array.isArray(payload.proposals) || payload.proposals.length === 0) {
            if (typeof showEphemeralMessage === 'function') {
                showEphemeralMessage(t('ephemeral.messages.unable_to_prepare_proposals_for_sharing', 'Unable to prepare proposals for sharing.'), 5000, 'error');
            }
            return;
        }

        const encoded = encodeSharedPayload(payload);
        if (!encoded) {
            if (typeof showEphemeralMessage === 'function') {
                showEphemeralMessage(t('ephemeral.messages.failed_to_encode_shared_proposal_data', 'Failed to encode shared proposal data.'), 5000, 'error');
            }
            return;
        }

        const baseUrl = `${window.location.origin}${window.location.pathname}`;
        const shareUrl = `${baseUrl}?shared=${encoded}`;
        if (shareUrl.length > SHARE_URL_MAX_LENGTH) {
            showShareTooLargeModal();
            return;
        }
        const nearLimit = shareUrl.length > SHARE_URL_MAX_LENGTH * 0.9;
        const introHtml = tShare('defaultIntro', 'Share this link to load {{count}} applied proposal{{suffix}}.', {
            count: applied.length,
            suffix: applied.length === 1 ? '' : 's'
        });
        showShareLinkModal(shareUrl, payload, { nearLimit, introHtml, encodedLength: encoded.length });
    } catch (error) {
        console.error('shareAppliedProposals failed', error);
        if (typeof showEphemeralMessage === 'function') {
            const t = getProposalI18nHelper();
            showEphemeralMessage(t('ephemeral.messages.failed_to_generate_share_link', 'Failed to generate share link.'), 5000, 'error');
        }
    }
}

function shareSingleProposal(proposalHash) {
    try {
        const t = getProposalI18nHelper();
        const tShare = getShareI18nHelper();
        if (!proposalHash || typeof proposalStorage === 'undefined') {
            return;
        }
        const proposal = proposalStorage.getProposal(proposalHash);
        if (!proposal) {
            if (typeof showEphemeralMessage === 'function') {
                showEphemeralMessage(t('ephemeral.messages.cannot_share_this_proposal_right_now', 'Cannot share this proposal right now.'), 4000, 'error');
            }
            return;
        }

        const payload = buildSharedProposalsPayload([proposal]);
        if (!payload || !Array.isArray(payload.proposals) || payload.proposals.length === 0) {
            if (typeof showEphemeralMessage === 'function') {
                showEphemeralMessage(t('ephemeral.messages.unable_to_prepare_proposal_for_sharing', 'Unable to prepare proposal for sharing.'), 5000, 'error');
            }
            return;
        }

        const encoded = encodeSharedPayload(payload);
        if (!encoded) {
            if (typeof showEphemeralMessage === 'function') {
                showEphemeralMessage(t('ephemeral.messages.failed_to_encode_share_data', 'Failed to encode share data.'), 5000, 'error');
            }
            return;
        }

        const baseUrl = `${window.location.origin}${window.location.pathname}`;
        const shareUrl = `${baseUrl}?proposalShare=${encoded}`;
        if (shareUrl.length > SHARE_URL_MAX_LENGTH) {
            showShareTooLargeModal();
            return;
        }
        const nearLimit = shareUrl.length > SHARE_URL_MAX_LENGTH * 0.9;
        const rawTitle = proposal.title || (payload?.proposals?.[0]?.title) || '';
        const safeTitle = typeof escapeHtml === 'function' ? escapeHtml(rawTitle || '') : (rawTitle || '');
        const introHtml = tShare('singleIntro', 'Share this link to load proposal <strong>{{title}}</strong>.', {
            title: safeTitle || tShare('untitled', '(Untitled)')
        });
        showShareLinkModal(shareUrl, payload, { nearLimit, introHtml, encodedLength: encoded.length });
    } catch (error) {
        console.error('shareSingleProposal failed', error);
        if (typeof showEphemeralMessage === 'function') {
            const t = getProposalI18nHelper();
            showEphemeralMessage(t('ephemeral.messages.unable_to_generate_share_link', 'Unable to generate share link.'), 5000, 'error');
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
            status: 'Applied',
            minted: proposal.isMinted === true
                || !!(proposal.onchain && proposal.onchain.transactionHash)
                || (proposal.proposalId && !isLocalProposalId(proposal.proposalId)),
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

const PARCEL_NUMBER_PROPERTY_CANDIDATES = [
    'BROJ_CESTICE',
    'smp',
    'SMP',
    'parcelNumber',
    'parcel_number',
    'parcel',
    'parcelNo',
    'parcel_no',
    'parcelId',
    'parcel_id'
];

function getParcelDisplayNumberFromProperties(properties, fallback = '') {
    if (properties) {
        for (const key of PARCEL_NUMBER_PROPERTY_CANDIDATES) {
            const value = properties[key];
            if (value !== undefined && value !== null) {
                const text = value.toString().trim();
                if (text) {
                    return text;
                }
            }
        }
        const cestica = properties.CESTICA_ID;
        if (cestica !== undefined && cestica !== null) {
            const candidate = cestica.toString().trim();
            if (candidate) {
                return candidate;
            }
        }
    }
    return fallback ? fallback.toString() : '';
}

function getParcelDisplayNumberFromFeature(feature, fallback = '') {
    if (feature && feature.properties) {
        return getParcelDisplayNumberFromProperties(feature.properties, fallback);
    }
    return fallback ? fallback.toString() : '';
}

function encodeSharedPayload(payload) {
    try {
        const json = JSON.stringify(payload);
        if (typeof TextEncoder !== 'undefined') {
            const encoder = new TextEncoder();
            const rawBytes = encoder.encode(json);
            const { bytes: preparedBytes, compressed } = compressBytes(rawBytes);
            const prefix = compressed ? SHARE_ENCODING_PREFIX_COMPRESSED : SHARE_ENCODING_PREFIX_RAW;
            return prefix + base64UrlEncodeBytes(preparedBytes);
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
            const parcelCount = proposals.reduce((sum, p) => sum + (Array.isArray(p.parcelIds) ? p.parcelIds.length : 0), 0);
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

function showSimpleShareModal(options = {}) {
    if (typeof document === 'undefined') return null;

    const t = getProposalI18nHelper();
    const closeLabel = t('modal.common.close', 'Close');

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
        let ancestorIds = computeRequiredAncestorIdsForSharedProposal(sharedProposal);
        if (typeof fetchParcelData === 'function') {
            const bounds = buildBoundsFromSharedPayload(payload);
            await fetchParcelData(bounds || undefined);
        }

        ancestorIds = ensureArrayOfStrings(ancestorIds);
        if (ancestorIds.length) {
            await stageSharedProposalDependencies(ancestorIds, {
                label: sharedProposal.title || 'shared proposal',
                forceOwnerRefresh: true,
                forceRefreshParcels: true
            });
        }

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
            document.body.classList.add('proposal-details-open');
        }
        focusMapOnSharedProposal(stored, payload);
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

async function ensureAncestorParcelsLoaded(parcelIds, options = {}) {
    if (!Array.isArray(parcelIds) || parcelIds.length === 0) return;
    const missing = findMissingAncestorParcels(parcelIds);
    if (!missing.length) {
        if (options.preloadOwners) {
            await preloadProposalParcelOwners(parcelIds, { forceRefresh: !!options.forceOwnerRefresh });
        }
        return;
    }

    await fetchParcelsForIds(missing, { forceRefresh: options.forceRefreshParcels });

    const stillMissing = findMissingAncestorParcels(parcelIds);
    if (stillMissing.length && typeof fetchSingleParcelById === 'function') {
        await Promise.allSettled(stillMissing.map(id => fetchSingleParcelById(id)));
    }

    const finalMissing = findMissingAncestorParcels(parcelIds);
    if (!finalMissing.length && options.preloadOwners) {
        await preloadProposalParcelOwners(parcelIds, { forceRefresh: !!options.forceOwnerRefresh });
    }
}

async function waitForParcelLayersReady(parcelIds, options = {}) {
    const ids = ensureArrayOfStrings(parcelIds);
    if (!ids.length) return;
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 8000;
    const pollIntervalMs = Number.isFinite(options.pollIntervalMs) ? options.pollIntervalMs : 120;
    const pending = new Set(ids);
    const start = Date.now();
    while (pending.size && (Date.now() - start) < timeoutMs) {
        for (const id of Array.from(pending)) {
            if (isParcelLayerReady(id)) {
                pending.delete(id);
            }
        }
        if (!pending.size) {
            break;
        }
        await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }
    if (pending.size) {
        console.warn('waitForParcelLayersReady timed out for parcels', Array.from(pending));
    }
}

function isParcelLayerReady(parcelId) {
    const normalized = parcelId && parcelId.toString ? parcelId.toString() : '';
    if (!normalized) {
        return false;
    }
    if (typeof resolveParcelLayerById === 'function') {
        return !!resolveParcelLayerById(normalized);
    }
    try {
        if (typeof parcelLayer === 'undefined' || !parcelLayer || typeof parcelLayer.eachLayer !== 'function') {
            return false;
        }
        let found = false;
        parcelLayer.eachLayer(layer => {
            if (found) {
                return;
            }
            const candidate = layer?.feature?.properties?.CESTICA_ID;
            if (candidate !== undefined && candidate !== null && candidate.toString() === normalized) {
                found = true;
            }
        });
        return found;
    } catch (_) {
        return false;
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
        if (!suppressStatus && typeof updateStatus === 'function' && message) {
            updateStatus(message);
        }
    };

    updateStageStatus(`Fetching ancestor parcels for ${label}…`);
    await ensureAncestorParcelsLoaded(ids, {
        preloadOwners: false,
        forceRefreshParcels: !!(options && options.forceRefreshParcels)
    });
    await waitForParcelLayersReady(ids, {
        timeoutMs: options && Number.isFinite(options.renderTimeoutMs) ? options.renderTimeoutMs : undefined
    });

    updateStageStatus(`Fetching parcel owners for ${label}…`);
    await preloadProposalParcelOwners(ids, { forceRefresh: !!(options && options.forceOwnerRefresh) });

    updateStageStatus(`Ancestors ready for ${label}.`);
}

async function fetchParcelsForIds(parcelIds, options = {}) {
    if (!Array.isArray(parcelIds) || parcelIds.length === 0) return;
    const unique = Array.from(new Set(parcelIds.map(id => id && id.toString ? id.toString() : id).filter(Boolean)));
    if (!unique.length) return;

    if (typeof fetchParcelsByIds === 'function') {
        await fetchParcelsByIds(unique, { forceRefresh: !!options.forceRefresh });
        return;
    }

    if (typeof fetchSingleParcelById === 'function') {
        await Promise.allSettled(unique.map(id => fetchSingleParcelById(id)));
        return;
    }

    if (typeof fetchParcelData === 'function') {
        try {
            await fetchParcelData();
        } catch (error) {
            console.warn('fetchParcelsForIds fallback fetchParcelData failed', error);
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
            try {
                if (typeof updateStatus === 'function') {
                    updateStatus(t('status.messages.applying_specific_shared_proposal', `Applying shared proposal ${proposal.title || ''} #${parseInt(proposal.proposal_id, 10) || '?'}...`, {
                        title: proposal.title || '',
                        id: parseInt(proposal.proposal_id, 10) || '?'
                    }));
                }
            } catch (_) { }
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
                const title = `${proposal.title || tShare('untitled', '(Untitled)')}${Number.isFinite(parseInt(proposal.proposal_id, 10)) ? ` (ID #${parseInt(proposal.proposal_id, 10)})` : ''}`;
                const successCount = actuallyApplied.length;
                const bodyLines = [];
                bodyLines.push(`<p>${tShare('stopIntro', 'Stopped applying at proposal: <strong>{{title}}</strong> · {{hash}}', {
                    title: escapeHtml(title),
                    hash: escapeHtml(proposal.proposalHash || '')
                })}</p>`);
                if (missingForThis.length > 0) {
                    bodyLines.push(`<p>${tShare('stopMissingIntro', 'Missing ancestor parcels for this proposal:')}</p><ul>${missingForThis.slice(0, 10).map(id => `<li>${id}</li>`).join('')}${missingForThis.length > 10 ? '<li>…</li>' : ''}</ul>`);
                } else {
                    bodyLines.push(`<p>${tShare('stopGenericFailure', 'The proposal could not be applied. Check console for details.')}</p>`);
                }
                if (successCount > 0) {
                    bodyLines.push(`<p>${tShare('stopSuccessCount', 'Successfully applied {{count}} proposal{{suffix}} so far.', {
                        count: successCount,
                        suffix: successCount === 1 ? '' : 's'
                    })}</p>`);
                }
                const modal = showSimpleShareModal({
                    title: tShare('stopTitle', 'Stopped Applying Proposals'),
                    body: bodyLines.join(''),
                    actions: [
                        {
                            label: tShare('leaveAsIs', 'Leave as is')
                        },
                        {
                            label: tShare('unapplySuccessful', 'Unapply successful proposals'),
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
            showSimpleShareModal({
                title: tShare('summary.title', 'Applied Shared Proposals'),
                body: bodyLines.join(''),
                actions: [
                    { label: t('modal.common.close', 'Close'), primary: true },
                    ...(actuallyApplied.length > 0 ? [{
                        label: tShare('summary.unapplyApplied', 'Unapply applied'),
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
            showEphemeralMessage(t('ephemeral.messages.failed_to_apply_shared_proposals_summary', `Failed to apply ${failures.length} shared proposal${failures.length === 1 ? '' : 's'}. Check console for details.`, {
                count: failures.length,
                suffix: failures.length === 1 ? '' : 's'
            }), 6000, 'error');
        }
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
                const title = `${p.title || tShare('untitled', '(Untitled)')}${Number.isFinite(parseInt(p.proposal_id, 10)) ? ` (ID #${parseInt(p.proposal_id, 10)})` : ''}`;
                label.innerHTML = `<strong>${escapeHtml(title)}</strong> • ${escapeHtml(p.type || 'parcel')} • ${escapeHtml(p.proposalHash || '')}`;

                const meta = document.createElement('div');
                meta.className = 'spi-proposal-meta';
                const parcelIds = Array.isArray(p.parcelIds) ? p.parcelIds.join(', ') : '';
                const ancestorIds = Array.isArray(p.ancestorParcelIds) ? p.ancestorParcelIds.join(', ') : '';
                const roadParents = (p.roadProposal && Array.isArray(p.roadProposal.parentParcelIds)) ? p.roadProposal.parentParcelIds.join(', ') : '';
                const buildingParents = (p.buildingProposal && Array.isArray(p.buildingProposal.parentParcelIds)) ? p.buildingProposal.parentParcelIds.join(', ') : '';
                meta.innerHTML = `
                    <small>
                        ${tShared('parcelIds', 'Parcel IDs:')} ${escapeHtml(parcelIds)}<br>
                        ${tShared('ancestorIds', 'Ancestor Parcel IDs:')} ${escapeHtml(ancestorIds)}<br>
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

            const modal = showSimpleShareModal({
                title: tShared('title', 'Review Shared Proposals'),
                body: container,
                actions: [
                    {
                        label: t('modal.common.cancel', 'Cancel'),
                        onClick: () => resolve(null)
                    },
                    {
                        id: 'apply',
                        label: tShared('loading', 'Parcels still loading...'),
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

    const ancestorIds = computeRequiredAncestorIdsForSharedProposal(sharedProposal);
    if (ancestorIds.length) {
        try {
            await stageSharedProposalDependencies(ancestorIds, {
                suppressStatus: true,
                label: sharedProposal.title || sharedProposal.proposalHash || 'shared proposal',
                forceOwnerRefresh: true,
                forceRefreshParcels: true
            });
        } catch (error) {
            console.warn('Failed to load ancestor parcels for shared proposal', sharedProposal.proposalHash, error);
            return { applied: false, skipped: false };
        }

        const stillMissing = findMissingAncestorParcels(ancestorIds);
        if (stillMissing.length) {
            console.warn('Missing ancestor parcels for shared proposal', sharedProposal.proposalHash, stillMissing);
            return { applied: false, skipped: false };
        }
    }

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
    // Clear selection first
    multiParcelSelection.clearSelection();

    // Exit multi-select mode if it's active
    if (multiParcelSelection.isActive) {
        multiParcelSelection.toggle({ restoreSingleSelection: false });
    }

    // Update checkboxes to reflect that multi-select is off
    syncMultiSelectCheckboxes(false);

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
            showProposalAlertMessage('proposal_not_found', 'Proposal not found.');
            return null;
        }

        const normalizedParcelId = normalizeParcelId(parcelId);
        if (!normalizedParcelId) {
            showProposalAlertMessage('invalid_parcel_identifier', 'Invalid parcel identifier.');
            return null;
        }

        const parcelIds = (proposal.parcelIds || []).map(id => normalizeParcelId(id));
        if (!parcelIds.includes(normalizedParcelId)) {
            showProposalAlertMessage('this_parcel_is_not_part_of_the_proposal', 'This parcel is not part of the proposal.');
            return null;
        }

        proposal.acceptedParcelIds = normalizeParcelIdList(proposal.acceptedParcelIds || []);

        const ownerSlots = getOwnerSlotsForParcel(normalizedParcelId);
        const entry = ensureOwnerAcceptanceEntry(proposal, normalizedParcelId, ownerSlots, { syncWithParcelAcceptance: false });
        if (!entry) {
            showProposalAlertMessage('unable_to_determine_owner_shares_for_this_parcel', 'Unable to determine owner shares for this parcel.');
            return null;
        }

        let effectiveOwnerKey = ownerKey;
        if (!effectiveOwnerKey) {
            if (entry.ownerOrder.length === 1) {
                effectiveOwnerKey = entry.ownerOrder[0];
            } else {
                showProposalAlertMessage('select_which_owner_share_you_are_accepting_for', 'Select which owner share you are accepting for.');
                return null;
            }
        }

        if (entry.acceptedOwnerKeys.includes(effectiveOwnerKey)) {
            showProposalAlertMessage('this_owner_has_already_accepted_the_proposal', 'This owner has already accepted the proposal.');
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

            autoApplyExecutedProposalToMap(proposal);

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
                if (proposal.buildingProposal) {
                    proposal.buildingProposal.status = 'executed';
                }
                if (typeof markProposedBuildingState === 'function') {
                    markProposedBuildingState(proposal.proposalHash, 'executed', { updateLayer: true, save: true });
                } else if (typeof saveExecutedBuildingsToStorage === 'function') {
                    saveExecutedBuildingsToStorage();
                }
                showEphemeralMessage(`Proposal ${proposal.proposalHash.substring(0, 6)} executed! All ${proposal.parcelIds.length} parcels accepted`);
            } else if (proposal.structureProposal && (proposal.structureProposal.kind === 'park' || proposal.structureProposal.kind === 'square')) {
                if (proposal.structureProposal) {
                    proposal.structureProposal.status = 'executed';
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
        showProposalAlertMessage('error_accepting_proposal_please_try_again', 'Error accepting proposal. Please try again.');
        return null;
    }
}

function restoreProposalDetailsScroll(preserveState) {
    if (!preserveState) return;

    const { scrollTop, anchorKey, anchorOffset, parcelId } = preserveState;

    const resolvePanelBody = () => {
        const panel = document.getElementById('proposal-details-panel');
        return panel ? panel.querySelector('.panel-body') : null;
    };

    const apply = () => {
        const panelBody = resolvePanelBody();
        if (!panelBody) return;

        if (anchorKey && typeof anchorOffset === 'number') {
            const ownerRow = panelBody.querySelector(`.owner-acceptance-row[data-owner-key="${anchorKey}"]`);
            if (ownerRow) {
                const bodyRect = panelBody.getBoundingClientRect();
                const rowRect = ownerRow.getBoundingClientRect();
                const delta = (rowRect.top - bodyRect.top) - anchorOffset;
                if (!Number.isNaN(delta)) {
                    panelBody.scrollTop += delta;
                    return;
                }
            }
        }

        if (parcelId) {
            const parcelRow = panelBody.querySelector(`.proposal-parcel-item[data-parcel-id="${parcelId}"]`);
            if (parcelRow && typeof parcelRow.scrollIntoView === 'function') {
                parcelRow.scrollIntoView({ block: 'nearest' });
            }
        }

        if (typeof scrollTop === 'number') {
            panelBody.scrollTop = scrollTop;
        }
    };

    apply();
    requestAnimationFrame(apply);
    setTimeout(apply, 0);
    setTimeout(apply, 30);
    setTimeout(apply, 120);
}

// Accept proposal function (for specific parcel)
function handleUserAcceptProposal(proposalHash, parcelId, ownerKey = null) {
    const userAgent = typeof getCurrentUserAgent === 'function' ? getCurrentUserAgent() : null;
    if (!userAgent) {
        showProposalAlertMessage('you_must_be_logged_in_to_accept_proposals', 'You must be logged in to accept proposals.');
        return;
    }

    // Get the proposal to check stored owner acceptance data
    const proposal = proposalStorage.getProposal(proposalHash);
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

    const result = acceptProposal(proposalHash, parcelId, effectiveOwnerKey, {
        acceptedByAgentId: userAgent.id,
        acceptedByName: userAgent.name
    });

    if (!result) {
        return;
    }

    const ownerLabel = targetSlot.shareText
        ? `${targetSlot.displayName} (${targetSlot.shareText})`
        : targetSlot.displayName;

    const storedProposal = typeof proposalStorage !== 'undefined' && typeof proposalStorage.getProposal === 'function'
        ? proposalStorage.getProposal(proposalHash)
        : null;
    const proposalIdForLog = storedProposal && storedProposal.proposal_id !== undefined && storedProposal.proposal_id !== null
        ? String(storedProposal.proposal_id)
        : (storedProposal && storedProposal.proposalId !== undefined && storedProposal.proposalId !== null
            ? String(storedProposal.proposalId)
            : proposalHash.substring(0, 8));
    const proposalIdAttr = storedProposal && storedProposal.proposal_id !== undefined && storedProposal.proposal_id !== null
        ? String(storedProposal.proposal_id)
        : (storedProposal && storedProposal.proposalId !== undefined && storedProposal.proposalId !== null
            ? String(storedProposal.proposalId)
            : proposalHash);
    const proposalLinkHtml = `<a href="#" data-proposal-id="${proposalIdAttr}" data-proposal-hash="${proposalHash}" class="proposal-link proposal-link-clickable">${proposalIdForLog}</a>`;

    if (result.proposalExecuted) {
        showEphemeralMessage(`Proposal ${proposalHash.substring(0, 8)} executed!`);
        if (typeof addUserActionToGameLog === 'function') {
            addUserActionToGameLog(`<a href="#" data-agent-id="${userAgent.id}" class="agent-link agent-link-clickable">${userAgent.name}</a> executed proposal ${proposalLinkHtml} after confirming acceptance for ${ownerLabel}.`);
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
            addUserActionToGameLog(`<a href="#" data-agent-id="${userAgent.id}" class="agent-link agent-link-clickable">${userAgent.name}</a> recorded acceptance from ${ownerLabel} for parcel ${result.parcelNumber || parcelId} (${proposalLinkHtml}).`);
        }
        if (!userAgent.proposalsAccepted) {
            userAgent.proposalsAccepted = [];
        }
        if (!userAgent.proposalsAccepted.includes(proposalHash)) {
            userAgent.proposalsAccepted.push(proposalHash);
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

    const updatedProposal = proposalStorage.getProposal(proposalHash);
    if (updatedProposal) {
        const preserveState = {
            scrollTop,
            anchorKey,
            anchorOffset,
            parcelId: normalizedParcelId
        };

        if (typeof updateAgentDialogAfterAcceptance === 'function') {
            updateAgentDialogAfterAcceptance(proposalHash);
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
function handleUserRejectProposal(proposalHash, parcelId, ownerKey = null) {
    const userAgent = typeof getCurrentUserAgent === 'function' ? getCurrentUserAgent() : null;
    if (!userAgent) {
        showProposalAlertMessage('you_must_be_logged_in_to_undo_an_acceptance', 'You must be logged in to undo an acceptance.');
        return;
    }

    const proposal = proposalStorage.getProposal(proposalHash);
    if (!proposal) {
        showProposalAlertMessage('proposal_not_found', 'Proposal not found.');
        return;
    }

    // Check if proposal is executed and has descendants
    const proposalStatus = (proposal.status || '').toLowerCase();
    if (proposalStatus === 'executed') {
        if (typeof ProposalManager !== 'undefined' && typeof ProposalManager._getProposalDescendants === 'function') {
            const descendants = ProposalManager._getProposalDescendants(proposalHash);
            if (descendants && descendants.length > 0) {
                showProposalAlertMessage('cannot_undo_acceptance_from_an_executed_proposal_that_has_descendant_parcels', 'Cannot undo acceptance from an executed proposal that has descendant parcels.');
                return;
            }
        }
    }

    const acceptanceState = getProposalOwnerAcceptanceState(proposal, parcelId);
    if (!acceptanceState.entries.length) {
        showProposalAlertMessage('no_recorded_owner_acceptance_to_undo', 'No recorded owner acceptance to undo.');
        return;
    }

    let targetEntry = acceptanceState.entries.find(entry => entry.key === ownerKey);
    if (!targetEntry) {
        targetEntry = acceptanceState.entries.find(entry => entry.accepted && entry.acceptedByAgentId === userAgent.id);
    }

    if (!targetEntry) {
        showProposalAlertMessage('unable_to_determine_which_acceptance_to_undo', 'Unable to determine which acceptance to undo.');
        return;
    }

    if (targetEntry.acceptedByAgentId && targetEntry.acceptedByAgentId !== userAgent.id) {
        showProposalAlertMessage('only_the_user_who_recorded_this_acceptance_can_undo_it', 'Only the user who recorded this acceptance can undo it.');
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

    // Preserve exact scroll/anchor position before update
    const panel = document.getElementById('proposal-details-panel');
    const panelBody = panel ? panel.querySelector('.panel-body') : null;
    const scrollTop = panelBody ? panelBody.scrollTop : 0;
    const anchorKey = targetEntry.key || ownerKey || null;
    let anchorOffset = null;
    if (panelBody && anchorKey) {
        const ownerRow = panelBody.querySelector(`.owner-acceptance-row[data-owner-key="${anchorKey}"]`);
        if (ownerRow) {
            const bodyRect = panelBody.getBoundingClientRect();
            const rowRect = ownerRow.getBoundingClientRect();
            anchorOffset = rowRect.top - bodyRect.top;
        }
    }

    const preserveState = {
        scrollTop,
        anchorKey,
        anchorOffset,
        parcelId: parcelId ? parcelId.toString() : null
    };

    setTimeout(() => {
        const updatedProposal = proposalStorage.getProposal(proposalHash);
        if (updatedProposal) {
            refreshProposalOwnerAcceptanceUI(updatedProposal, parcelId);
            restoreProposalDetailsScroll(preserveState);
        }
    }, 0);
}

function rejectProposal(proposalHash, parcelId, ownerKey = null) {
    try {
        const proposal = proposalStorage.getProposal(proposalHash);
        if (!proposal) {
            showProposalAlertMessage('proposal_not_found', 'Proposal not found.');
            return null;
        }

        const normalizedParcelId = normalizeParcelId(parcelId);
        if (!normalizedParcelId) {
            showProposalAlertMessage('invalid_parcel_identifier', 'Invalid parcel identifier.');
            return null;
        }

        proposal.ownerAcceptances = normalizeOwnerAcceptances(proposal.ownerAcceptances || {});
        const entry = ensureOwnerAcceptanceEntry(proposal, normalizedParcelId, getOwnerSlotsForParcel(normalizedParcelId), { syncWithParcelAcceptance: false });
        if (!entry || !entry.acceptedOwnerKeys || entry.acceptedOwnerKeys.length === 0) {
            showProposalAlertMessage('this_parcel_has_not_accepted_the_proposal_yet', 'This parcel has not accepted the proposal yet.');
            return null;
        }

        let targetOwnerKey = ownerKey;
        if (!targetOwnerKey) {
            if (entry.acceptedOwnerKeys.length === 1) {
                targetOwnerKey = entry.acceptedOwnerKeys[0];
            } else {
                showProposalAlertMessage('please_specify_which_owner_acceptance_to_undo', 'Please specify which owner acceptance to undo.');
                return null;
            }
        }

        if (!entry.acceptedOwnerKeys.includes(targetOwnerKey)) {
            showProposalAlertMessage('this_owner_has_not_accepted_the_proposal_yet', 'This owner has not accepted the proposal yet.');
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
        showProposalAlertMessage('error_rejecting_proposal_please_try_again', 'Error rejecting proposal. Please try again.');
        return null;
    }
}

// Ensure this runs after the main DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    // Proposals are always shown now, no checkbox event listener needed

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
window.addEventListener('parcelDataLoaded', () => {
    // 1) Auto-apply executed proposals to ensure parent parcels are removed and child parcels are clickable
    // This is critical: without this, parent parcels remain on the map and block child parcel clicks
    // applyProposal is idempotent - it checks roadProposal.status === 'applied' and returns early if already applied
    if (typeof proposalStorage !== 'undefined' && typeof ProposalManager !== 'undefined' && typeof ProposalManager.applyProposal === 'function') {
        try {
            const allProposals = proposalStorage.getAllProposals();
            const executedProposals = allProposals.filter(p => {
                const status = (p.status || '').toLowerCase();
                return status === 'executed';
            });

            let appliedCount = 0;
            executedProposals.forEach(proposal => {
                if (proposal && proposal.proposalHash) {
                    try {
                        // This will remove parent parcels if they exist, ensuring child parcels are clickable
                        const result = ProposalManager.applyProposal(proposal.proposalHash);
                        if (result !== false) {
                            appliedCount++;
                        }
                    } catch (error) {
                        console.warn('Failed to auto-apply executed proposal on parcel data load:', proposal.proposalHash, error);
                    }
                }
            });

            if (appliedCount > 0) {
                setTimeout(() => {
                    if (typeof parcelLayer !== 'undefined' && parcelLayer) {
                        parcelLayer.eachLayer(layer => {
                            if (!layer || !layer.feature || !layer.feature.properties) return;
                            const parcelId = layer.feature.properties.CESTICA_ID;
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
        const layer = parcelLayer.getLayers().find(l => l.feature && l.feature.properties && l.feature.properties.CESTICA_ID.toString() === window.selectedParcelId.toString());
        if (layer && typeof selectedParcelStyle !== 'undefined') {
            layer.setStyle(selectedParcelStyle);
            layer.bringToFront();
        }
    }

    // 4) If block layer logic needs refresh it can listen separately; we keep focus on proposals/selection here
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
// Offer formatting helpers
function formatProposalOfferValue(value) {
    if (value === undefined || value === null || value === '') return '';
    const cleanValue = value.toString().replace(/\D/g, '');
    if (!cleanValue) return '';
    const number = parseInt(cleanValue, 10);
    return number.toLocaleString('hr-HR');
}

function handleProposalOfferInput(input) {
    const originalValue = input.value;
    const formatted = formatProposalOfferValue(originalValue);

    if (input.value !== formatted) {
        input.value = formatted;
    }
}

function parseProposalOfferValue(value) {
    if (!value) return 0;
    const cleanValue = value.toString().replace(/\D/g, '');
    return parseInt(cleanValue, 10) || 0;
}

window.formatProposalOfferValue = formatProposalOfferValue;
window.handleProposalOfferInput = handleProposalOfferInput;
window.parseProposalOfferValue = parseProposalOfferValue;
