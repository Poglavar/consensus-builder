// proposals/execution.js — extracted from proposals.js (behavior-preserving relocation).

// normalizeOwnerAcceptances and ensureOwnerAcceptanceEntry moved to
// frontend/js/proposals/owner-acceptance.js (loaded first) so they are unit-tested. The globals
// they define are used here and in proposals/core.js and data.js.

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
                    const descendants = ProposalManager._getProposalDescendants(proposal.proposalId);
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
    // In Canton mode the EVM owner-acceptance UI doesn't apply — Canton proposals
    // are accepted (by the owner) from the dedicated "Canton proposals" section.
    if (window.CantonMode && typeof window.CantonMode.isActive === 'function' && window.CantonMode.isActive()) {
        return '';
    }
    const proposalId = proposal && proposal.proposalId ? proposal.proposalId : '';
    const acceptanceState = getProposalOwnerAcceptanceState(proposal, parcelId, options);
    const entries = acceptanceState.entries || [];
    if (!entries.length) {
        return '';
    }
    const compact = options.compact ? 'owner-acceptance-list compact' : 'owner-acceptance-list';
    const skipParcelPanelFocus = options && options.skipParcelPanelFocus === true;

    // Check if proposal is expired - disable buttons if so
    const proposalExpired = isProposalExpired(proposal);

    // Vote proposals relabel the owner-row actions: Accept -> Vote yes, Undo -> Rescind.
    // The onclick handlers are unchanged (handleUserAcceptProposal / handleUserRejectProposal
    // detect the vote proposal and route to castVote / rescindVote on-chain).
    const isVote = typeof isVoteProposal === 'function' && isVoteProposal(proposal);

    // Compute parcel and owner payout shares
    const offerAmount = Number.isFinite(Number(proposal.offer)) ? Number(proposal.offer) : 0;
    const offerCurrency = proposal.offerCurrency || proposal.currency || '';
    const { areaMap, totalArea } = options.areaContext || getProposalAreaMap(proposal);

    const parcelKey = parcelId?.toString ? parcelId.toString() : String(parcelId || '');
    const parcelArea = areaMap.get(parcelKey) || 0;
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
            const expiredTitle = isVote
                ? tProposalUI('panel.proposal.voting.concluded', 'Vote concluded')
                : tProposalUI('panel.proposal.expiry.expired', 'Proposal Expired');
            if (entry.accepted) {
                const undoLabel = isVote
                    ? tProposalUI('panel.proposal.voting.rescind', 'Rescind')
                    : tProposalUI('panel.proposal.acceptance.undo', 'Undo');
                buttonsHtml = `
                    <button class="btn btn-sm btn-outline-secondary" disabled style="font-size: 11px; padding: 2px 6px; min-width: 60px; opacity: 0.5; cursor: not-allowed;" title="${expiredTitle}">
                        ${undoLabel}
                    </button>`;
            }
            else {
                const acceptLabel = isVote
                    ? tProposalUI('panel.proposal.voting.voteYes', 'Vote yes')
                    : tProposalUI('panel.proposal.acceptance.accept', 'Accept');
                buttonsHtml = `
                    <button class="btn btn-sm btn-secondary" disabled style="font-size: 11px; padding: 2px 6px; min-width: 60px; opacity: 0.5; cursor: not-allowed;" title="${expiredTitle}">
                        ${acceptLabel}
                    </button>`;
            }
        } else if (entry.accepted && entry.canUndo) {
            const rejectCall = skipParcelPanelFocus
                ? `rejectProposalFromParcelInfo('${proposalId}','${parcelId}','${entry.key}',{skipParcelPanelFocus:true})`
                : `rejectProposalFromParcelInfo('${proposalId}','${parcelId}','${entry.key}')`;
            const undoLabel = isVote
                ? tProposalUI('panel.proposal.voting.rescind', 'Rescind')
                : tProposalUI('panel.proposal.acceptance.undo', 'Undo');
            buttonsHtml = `
                <button class="btn btn-sm btn-outline-danger" data-owner-key="${entry.key}" onclick="(function(e){e.stopPropagation();e.preventDefault();${rejectCall};return false;})(event)" style="font-size: 11px; padding: 2px 6px; min-width: 60px;">
                    ${undoLabel}
                </button>`;
        } else if (!entry.accepted && entry.canAccept) {
            const acceptCall = skipParcelPanelFocus
                ? `acceptProposalFromParcelInfo('${proposalId}','${parcelId}','${entry.key}',{skipParcelPanelFocus:true})`
                : `acceptProposalFromParcelInfo('${proposalId}','${parcelId}','${entry.key}')`;
            const acceptLabel = isVote
                ? tProposalUI('panel.proposal.voting.voteYes', 'Vote yes')
                : tProposalUI('panel.proposal.acceptance.accept', 'Accept');
            buttonsHtml = `
                <button class="btn btn-sm ${isVote ? 'btn-primary' : 'btn-success'}" data-owner-key="${entry.key}" onclick="(function(e){e.stopPropagation();e.preventDefault();${acceptCall};return false;})(event)" style="font-size: 11px; padding: 2px 6px; min-width: 60px;">
                    ${acceptLabel}
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

    // Recipient consent line item (rendered once, on the first parcel): a directed external
    // recipient (City / third-party) shown alongside the owners, with its own Accept.
    let recipientRowHtml = '';
    const consentRow = proposalRecipientConsentRow(proposal);
    const firstParcel = Array.isArray(proposal.parentParcelIds) && proposal.parentParcelIds.length
        ? String(proposal.parentParcelIds[0]) : null;
    if (consentRow && (!firstParcel || firstParcel === parcelKey)) {
        const tUI = getProposalI18nHelper();
        const recipLabel = typeof escapeHtml === 'function' ? escapeHtml(consentRow.label) : consentRow.label;
        const recipTag = tUI('panel.proposal.acceptance.recipient', 'recipient');
        const actionHtml = consentRow.accepted
            ? `<span style="color:#16a34a; font-size:12px;">✓ ${tUI('panel.proposal.acceptance.accepted', 'Accepted')}</span>`
            : (proposalExpired
                ? `<button class="btn btn-sm btn-secondary" disabled style="font-size:11px; padding:2px 6px; min-width:60px; opacity:0.5; cursor:not-allowed;">${tUI('panel.proposal.acceptance.accept', 'Accept')}</button>`
                : `<button class="btn btn-sm btn-success" onclick="(function(e){e.stopPropagation();e.preventDefault();acceptAsRecipient('${proposalId}');return false;})(event)" style="font-size:11px; padding:2px 6px; min-width:60px;">${tUI('panel.proposal.acceptance.accept', 'Accept')}</button>`);
        recipientRowHtml = `
            <div class="owner-acceptance-row owner-acceptance-recipient" style="display:grid; grid-template-columns: 1fr auto auto; align-items:center; gap:8px; padding:4px 0; border-bottom:1px dashed #e5e7eb;">
                <div class="owner-identity" style="font-size:13px; font-weight:600;">🏛️ ${recipLabel} <span style="color:#6b7280; font-weight:400; font-size:11px;">(${recipTag})</span></div>
                <div class="owner-share" style="font-size:13px; color:#666; text-align:right;">-</div>
                <div class="owner-actions" style="text-align:right;">${actionHtml}</div>
            </div>`;
    }

    return `<div class="${compact}" style="width: 100%; box-sizing: border-box;">${recipientRowHtml}${rowsHtml}</div>`;
}

function buildParcelAcceptanceStatusHtml(proposal) {
    const tProposalUI = getProposalI18nHelper();
    const parcelIds = Array.isArray(proposal?.parentParcelIds) ? proposal.parentParcelIds : [];
    const total = parcelIds.length;
    if (!total) {
        return '';
    }

    const acceptedCount = Math.min(
        Array.isArray(proposal.acceptedParcelIds) ? proposal.acceptedParcelIds.length : 0,
        total
    );

    // For vote proposals this same bar reads as support: parcels where every owner voted yes.
    const isVote = typeof isVoteProposal === 'function' && isVoteProposal(proposal);
    const titleText = isVote
        ? tProposalUI('panel.proposal.voting.parcelTitle', 'Parcel Support:')
        : tProposalUI('panel.proposal.acceptance.parcelTitle', 'Parcel Acceptance Status:');
    const labelText = `${titleText} (${acceptedCount}/${total})`;

    // If more than 65 parcels, show progress bar instead of circles
    if (total > 65) {
        const percentage = total > 0 ? (acceptedCount / total) * 100 : 0;
        return `
            <div class="proposal-acceptance-status">
                <div class="acceptance-label">${labelText}</div>
                <div class="acceptance-progress-bar" style="
                    width: 100%;
                    height: 20px;
                    background-color: #e0e0e0;
                    border-radius: 4px;
                    overflow: hidden;
                    position: relative;
                ">
                    <div class="acceptance-progress-fill" style="
                        width: ${percentage}%;
                        height: 100%;
                        background-color: #4caf50;
                        transition: width 0.3s ease;
                    "></div>
                </div>
            </div>`;
    }

    // For 65 or fewer parcels, show circles
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
            <div class="acceptance-label">${labelText}</div>
            <div class="acceptance-circles">${circlesHtml}</div>
        </div>`;
}

function buildProposalOwnerAcceptanceSummaryFast(proposal) {
    const summary = {
        entries: [],
        totalOwners: 0,
        acceptedOwners: 0
    };
    if (!proposal || !Array.isArray(proposal.parentParcelIds)) {
        return summary;
    }

    const acceptances = proposal.ownerAcceptances || {};
    let includeEntries = true;

    proposal.parentParcelIds.forEach(parcelId => {
        const normalizedParcelId = parcelId !== undefined && parcelId !== null
            ? parcelId.toString()
            : '';
        if (!normalizedParcelId) return;

        const entry = acceptances[normalizedParcelId];
        if (!entry) return;

        const ownerOrder = Array.isArray(entry.ownerOrder)
            ? entry.ownerOrder
            : Object.keys(entry.owners || {});
        const acceptedKeysArray = Array.isArray(entry.acceptedOwnerKeys)
            ? entry.acceptedOwnerKeys
            : Object.keys(entry.acceptedBy || {});
        const acceptedSet = new Set(acceptedKeysArray.map(key => key && key.toString()).filter(Boolean));

        summary.totalOwners += ownerOrder.length;
        summary.acceptedOwners += acceptedSet.size;

        if (includeEntries) {
            ownerOrder.forEach(ownerKey => {
                if (!ownerKey) return;
                const ownerMeta = entry.owners && entry.owners[ownerKey] ? entry.owners[ownerKey] : {};
                summary.entries.push({
                    key: ownerKey,
                    displayName: ownerMeta.displayName || `Owner ${ownerKey}`,
                    shareText: ownerMeta.shareText || '',
                    parcelId: normalizedParcelId,
                    accepted: acceptedSet.has(ownerKey.toString())
                });
            });
            if (summary.totalOwners > 65) {
                summary.entries = [];
                includeEntries = false;
            }
        }
    });

    return summary;
}

function buildOwnerAcceptanceStatusHtml(proposal, summaryOverride) {
    const tProposalUI = getProposalI18nHelper();
    const ownerAcceptanceSummary = summaryOverride || buildProposalOwnerAcceptanceSummary(proposal);
    if (!ownerAcceptanceSummary.totalOwners) {
        return '';
    }
    try {
        const total = ownerAcceptanceSummary.totalOwners;
        const acceptedCount = ownerAcceptanceSummary.acceptedOwners || 0;
        const labelText = `${tProposalUI('panel.proposal.acceptance.ownerTitle', 'Owner Acceptance Status:')} (${acceptedCount}/${total})`;

        // If more than 65 owners, show progress bar instead of circles
        if (total > 65) {
            const percentage = total > 0 ? (acceptedCount / total) * 100 : 0;
            return `
                <div class="proposal-acceptance-status owner">
                    <div class="acceptance-label">${labelText}</div>
                    <div class="acceptance-progress-bar" style="
                        width: 100%;
                        height: 20px;
                        background-color: #e0e0e0;
                        border-radius: 4px;
                        overflow: hidden;
                        position: relative;
                    ">
                        <div class="acceptance-progress-fill" style="
                            width: ${percentage}%;
                            height: 100%;
                            background-color: #4caf50;
                            transition: width 0.3s ease;
                        "></div>
                    </div>
                </div>`;
        }

        // For 65 or fewer owners, show circles
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
                <div class="acceptance-label">${labelText}</div>
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
    if (!proposal || !Array.isArray(proposal.parentParcelIds) || typeof getProposalOwnerAcceptanceState !== 'function') {
        return summary;
    }

    const entries = [];
    proposal.parentParcelIds.forEach(parcelId => {
        const normalizedParcelId = parcelId !== undefined && parcelId !== null
            ? parcelId.toString()
            : '';
        if (!normalizedParcelId) {
            return;
        }
        try {
            const parcelAcceptance = typeof getProposalOwnerAcceptanceState === 'function'
                ? getProposalOwnerAcceptanceState(proposal, normalizedParcelId)
                : { entries: [] };
            const parcelEntries = Array.isArray(parcelAcceptance.entries) ? parcelAcceptance.entries.slice() : [];
            const entriesForParcel = parcelEntries;

            entriesForParcel.forEach((entry, index) => {
                if (!entry) return;
                const entryKey = (entry.key || `${normalizedParcelId}_${index}`).toString();
                entries.push({
                    key: entryKey,
                    parcelId: normalizedParcelId,
                    displayName: entry.displayName || `Owner ${index + 1}`,
                    shareText: entry.shareText || '',
                    accepted: !!entry.accepted,
                    acceptedByName: entry.acceptedByName || '',
                    acceptanceMeta: entry
                });
            });
        } catch (error) {
            console.warn('buildProposalOwnerAcceptanceSummary: failed to gather owners', error);
        }
    });

    // Total owners = sum of per-parcel owner slots (no metadata shortcuts)
    summary.totalOwners = entries.length;
    summary.entries = entries;
    summary.acceptedOwners = Math.min(entries.filter(entry => entry.accepted).length, summary.totalOwners);
    return summary;
}

function applyProposalOwnershipTransfer(proposal) {
    if (!proposal || typeof resolveProposalRecipientAgentId !== 'function') return;
    const toAgentId = resolveProposalRecipientAgentId(proposal);
    if (!toAgentId) return; // no-change / open sale / unknown
    const goalKey = (proposal.goal || '').toString().toLowerCase();
    if (goalKey === 'decide-later' || goalKey === 'reparcellization') return; // owners set in appliers
    const ids = Array.isArray(proposal.parentParcelIds) ? proposal.parentParcelIds : [];
    ids.forEach(pid => {
        const key = `parcel_${pid}_owner`;
        const from = (typeof PersistentStorage !== 'undefined') ? PersistentStorage.getItem(key) : null;
        if (from !== toAgentId && typeof transferParcelOwnership === 'function') {
            transferParcelOwnership(pid, from, toAgentId);
        }
    });
}

function proposalRecipientConsentSatisfied(proposal) {
    try {
        if (typeof window === 'undefined' || !window.PROPOSAL_REQUIRE_RECIPIENT_CONSENT) return true;
        const otp = proposal.ownershipTransferProposal || {};
        const recipient = otp.recipient || (proposal.facets || {}).ownership;
        if (recipient !== 'third-party' || otp.recipientScope === 'any') return true;
        return proposal.recipientConsented === true;
    } catch (_) { return true; }
}

function recordRecipientConsent(proposalId) {
    const all = (proposalStorage && proposalStorage.getAllProposals) ? (proposalStorage.getAllProposals() || []) : [];
    const p = all.find(x => (x.proposalId || x.id) === proposalId);
    if (!p) return false;
    p.recipientConsented = true;
    if (proposalStorage._indexProposal) proposalStorage._indexProposal(p);
    proposalStorage.save();
    return true;
}

function claimSaleOffer(proposalId, buyerAgentId) {
    const all = (proposalStorage && proposalStorage.getAllProposals) ? (proposalStorage.getAllProposals() || []) : [];
    const proposal = all.find(p => (p.proposalId || p.id) === proposalId);
    const buyer = buyerAgentId
        || ((typeof getCurrentUserAgent === 'function' && getCurrentUserAgent()) ? getCurrentUserAgent().id : null);
    if (!proposal || !buyer) return false;
    if (!isProposalOpenSaleOffer(proposal)) return false;
    const otp = proposal.ownershipTransferProposal || {};

    proposal.ownershipTransferProposal = {
        ...otp, direction: 'to-buyer', recipient: 'third-party', recipientScope: 'specific',
        recipientAddress: buyer, buyer, status: 'sold'
    };
    proposal.funded = true;
    proposal.status = 'Executed';
    proposal.executedAt = new Date().toISOString();

    const ids = Array.isArray(proposal.parentParcelIds) ? proposal.parentParcelIds : [];
    ids.forEach(pid => {
        const from = (typeof PersistentStorage !== 'undefined') ? PersistentStorage.getItem(`parcel_${pid}_owner`) : null;
        if (typeof transferParcelOwnership === 'function') transferParcelOwnership(pid, from, buyer);
    });
    if (proposalStorage._indexProposal) proposalStorage._indexProposal(proposal);
    proposalStorage.save();

    // Confirm, and refresh whatever's open so the offer is no longer buyable (it's sold now —
    // isProposalOpenSaleOffer() returns false once status is Executed). Only re-render views that
    // are already open; don't pop a dialog/list on click.
    const buyerAgent = (typeof agentStorage !== 'undefined') ? agentStorage.getAgent(buyer) : null;
    const buyerName = (buyerAgent && buyerAgent.name) || 'you';
    const n = ids.length;
    const msg = `✅ Purchase successful — proposal executed. ${n} parcel${n === 1 ? '' : 's'} transferred to ${buyerName}.`;
    if (typeof showEphemeralMessage === 'function') showEphemeralMessage(msg, 4000, 'success');
    else if (typeof updateStatus === 'function') updateStatus(msg);

    try {
        if (document.getElementById('proposal-details-content') && typeof showProposalInfo === 'function') {
            showProposalInfo(proposal, null, true);
        }
    } catch (_) { }
    try {
        if (document.querySelector('.proposal-list-modal') && typeof renderProposalListModal === 'function') {
            renderProposalListModal();
        }
    } catch (_) { }
    try { if (typeof applyProposalHighlights === 'function') applyProposalHighlights(); } catch (_) { }
    try { if (typeof updateShowProposalsButton === 'function') updateShowProposalsButton(); } catch (_) { }

    return true;
}

function proposalRecipientConsentRow(proposal) {
    const otp = (proposal && proposal.ownershipTransferProposal) || {};
    const recipient = otp.recipient || ((proposal && proposal.facets) || {}).ownership;
    if (recipient === 'to-city') return { label: 'City', accepted: proposal.recipientConsented === true };
    if (recipient === 'third-party' && otp.recipientScope !== 'any') {
        return { label: otp.recipientAddress || 'Third party', accepted: proposal.recipientConsented === true };
    }
    return null;
}

function acceptAsRecipient(proposalId) {
    if (typeof recordRecipientConsent === 'function') recordRecipientConsent(proposalId);
    try {
        const all = (proposalStorage && proposalStorage.getAllProposals) ? (proposalStorage.getAllProposals() || []) : [];
        const p = all.find(x => (x.proposalId || x.id) === proposalId);
        if (p && typeof showProposalInfo === 'function') showProposalInfo(p, null, true);
    } catch (_) { }
}

async function autoApplyExecutedProposalToMap(proposal) {
    if (!proposal || !proposal.proposalId) {
        return false;
    }
    if (typeof ProposalManager === 'undefined' || typeof ProposalManager.applyProposal !== 'function') {
        return false;
    }
    try {
        const applied = await ProposalManager.applyProposal(proposal.proposalId);
        if (applied && typeof window !== 'undefined' && window.currentlyHighlightedProposal &&
            (window.currentlyHighlightedProposal.proposalId === proposal.proposalId)) {
            let refreshed = proposal;
            if (typeof proposalStorage !== 'undefined' && typeof proposalStorage.getProposal === 'function') {
                const stored = proposalStorage.getProposal(proposal.proposalId);
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
        console.warn('autoApplyExecutedProposalToMap: failed to apply executed proposal', { proposalId: proposal.proposalId, error });
        return false;
    }
}

async function applyProposalToMap(proposalIdOrHash, options = {}) {
    const startTime = performance.now();
    const safeId = proposalIdOrHash ? String(proposalIdOrHash) : '';
    console.debug(`[applyProposalToMap] Starting application for proposal ${safeId}...`);

    if (!safeId || typeof ProposalManager === 'undefined' || typeof ProposalManager.applyProposal !== 'function') {
        console.warn(`[applyProposalToMap] Invalid proposal id/hash or ProposalManager unavailable`);
        return false;
    }

    const step1Time = performance.now();
    const proposal = (typeof proposalStorage !== 'undefined' && typeof proposalStorage.getProposal === 'function')
        ? proposalStorage.getProposal(safeId)
        : null;
    console.debug(`[applyProposalToMap] Step 1: Retrieved proposal from storage (${(performance.now() - step1Time).toFixed(2)}ms)`);

    const { supportsMapToggle, isRoadProposal } = computeProposalCategoryFlags(proposal, { fallbackProposal: proposal });
    if (!supportsMapToggle) {
        console.debug(`[applyProposalToMap] Skipping unsupported map apply action for proposal ${safeId}`);
        return false;
    }

    const normalizedType = resolveProposalActionTypeKey(proposal, null);
    if (!isRoadProposal && APPLY_DISABLED_TYPE_KEYS.has(normalizedType)) {
        const t = typeof getProposalI18nHelper === 'function' ? getProposalI18nHelper() : null;
        const message = t
            ? t('panel.proposal.actions.apply_disabled_for_type', 'Apply is disabled for this proposal type.')
            : 'Apply is disabled for this proposal type.';
        if (typeof showEphemeralMessage === 'function') {
            showEphemeralMessage(message, 3500, 'info');
        }
        console.debug(`[applyProposalToMap] Apply disabled for proposal type: ${normalizedType}`);
        return false;
    }

    const step2Time = performance.now();
    // Update button to show loading state
    const buttonId = `proposal-action-btn-${safeId}`;
    const button = document.getElementById(buttonId);
    let originalButtonContent = null;
    if (button) {
        originalButtonContent = button.innerHTML;
        const t = typeof getProposalI18nHelper === 'function' ? getProposalI18nHelper() : null;
        const applyingText = t
            ? t('panel.proposal.actions.applying', 'Applying...')
            : 'Applying...';
        button.disabled = true;
        button.innerHTML = `<span class="metric-spinner" aria-hidden="true"></span> ${applyingText}`;
        button.style.opacity = '0.7';
        button.style.cursor = 'wait';
    }
    console.debug(`[applyProposalToMap] Step 2: Updated button UI (${(performance.now() - step2Time).toFixed(2)}ms)`);

    try {
        const step3Time = performance.now();
        // Use setTimeout to allow UI to update before heavy operation
        await new Promise(resolve => setTimeout(resolve, 0));
        console.debug(`[applyProposalToMap] Step 3: UI update delay (${(performance.now() - step3Time).toFixed(2)}ms)`);

        const step4Time = performance.now();
        console.debug(`[applyProposalToMap] Step 4: Calling ProposalManager.applyProposal...`);
        const applied = await ProposalManager.applyProposal(safeId);
        const step4Duration = performance.now() - step4Time;
        console.debug(`[applyProposalToMap] Step 4: ProposalManager.applyProposal completed (${step4Duration.toFixed(2)}ms)`);

        if (applied === false) {
            console.warn(`[applyProposalToMap] Proposal application returned false`);
            // Restore button on failure
            if (button && originalButtonContent) {
                button.innerHTML = originalButtonContent;
                button.disabled = false;
                button.style.opacity = '';
                button.style.cursor = '';
            }
            return false;
        }
    } catch (error) {
        console.error(`[applyProposalToMap] Error applying proposal to map (${(performance.now() - startTime).toFixed(2)}ms):`, error);
        // Restore button on error
        if (button && originalButtonContent) {
            button.innerHTML = originalButtonContent;
            button.disabled = false;
            button.style.opacity = '';
            button.style.cursor = '';
        }
        return false;
    }

    const step5Time = performance.now();
    // Clear the preview overlay (dashed outline) when proposal is applied
    // The actual parcels are now on the map with normal styling, so preview is no longer needed
    if (typeof clearProposalPreviewLayers === 'function') {
        clearProposalPreviewLayers();
    }
    console.debug(`[applyProposalToMap] Step 5: Cleared preview layers (${(performance.now() - step5Time).toFixed(2)}ms)`);

    // Immediately restore button state to prevent it from being stuck in loading state
    // The button will be updated to "Remove from map" by showProposalInfo below
    const currentButton = document.getElementById(buttonId);
    if (currentButton) {
        currentButton.disabled = false;
        currentButton.style.opacity = '';
        currentButton.style.cursor = '';
        // Temporarily show a success state, will be replaced by showProposalInfo
        const t = typeof getProposalI18nHelper === 'function' ? getProposalI18nHelper() : null;
        const appliedText = t
            ? t('panel.proposal.actions.remove', 'Remove from map')
            : 'Remove from map';
        currentButton.innerHTML = `<i class="fas fa-eye-slash"></i> ${appliedText}`;
        currentButton.className = 'btn btn-warning';
        currentButton.setAttribute('onclick', `removeProposalFromMap('${safeId}')`);
    }

    const step6Time = performance.now();
    let step6Label = 'Revealed details';
    // Do not auto-refresh proposal details during apply by default; it is expensive for large proposals.
    // Callers can opt-in with options.revealDetails = true.
    const revealDetails = options.revealDetails === true;

    let proposalUpdated = false;
    if (revealDetails && typeof proposalStorage !== 'undefined') {
        const proposalForRefresh = proposalStorage.getProposal(safeId);
        if (proposalForRefresh) {
            const parcelIds = Array.isArray(proposalForRefresh.parentParcelIds) ? proposalForRefresh.parentParcelIds : [];
            const fallbackParcelId = options.parcelId || (parcelIds.length > 0 ? parcelIds[0] : null);
            const proposalKey = typeof getProposalKey === 'function' ? getProposalKey(proposalForRefresh) : null;
            const alreadyHighlighted = proposalKey && window.currentlyHighlightedProposalId === proposalKey;
            const resolvedParcel = options.parcelId || window.selectedParcelInProposal || fallbackParcelId;

            if (alreadyHighlighted && options.forceRefocus !== true) {
                // When the proposal is already selected (common when clicking Apply inside its panel),
                // avoid re-running highlight + fitBounds work; just update button state.
                // Don't call showProposalInfo during apply - it's expensive and not needed.
                // The button will be updated by the fallback code below.
                proposalUpdated = true;
                step6Label = 'Reused existing selection (skipped refocus)';
            } else {
                focusProposalDetails(safeId, {
                    parcelId: resolvedParcel,
                    centerOnProposal: options.centerOnProposal !== false,
                    showDetails: options.showDetails !== false
                });
                proposalUpdated = true;

                // Clear overlays again after focusProposalDetails (which may have re-added them via applyProposalHighlights)
                // For applied proposals, we want normal parcel styling, not dashed outline overlays
                if (typeof clearProposalPreviewLayers === 'function') {
                    clearProposalPreviewLayers();
                }
            }
        }
    }

    // Fallback: If showProposalInfo wasn't called, ensure button is still updated
    if (!proposalUpdated) {
        const fallbackButton = document.getElementById(buttonId);
        if (fallbackButton && (fallbackButton.innerHTML.includes('Applying') || fallbackButton.innerHTML.includes('metric-spinner'))) {
            const t = typeof getProposalI18nHelper === 'function' ? getProposalI18nHelper() : null;
            const appliedText = t
                ? t('panel.proposal.actions.remove', 'Remove from map')
                : 'Remove from map';
            fallbackButton.innerHTML = `<i class="fas fa-eye-slash"></i> ${appliedText}`;
            fallbackButton.className = 'btn btn-warning';
            fallbackButton.disabled = false;
            fallbackButton.style.opacity = '';
            fallbackButton.style.cursor = '';
            fallbackButton.setAttribute('onclick', `removeProposalFromMap('${safeId}')`);
        }
    }

    console.debug(`[applyProposalToMap] Step 6: ${step6Label} (${(performance.now() - step6Time).toFixed(2)}ms)`);

    // An applied road becomes a corridor parcel; draw its cross-section over it.
    if (typeof scheduleCorridorStripRefresh === 'function') scheduleCorridorStripRefresh();

    const totalTime = performance.now() - startTime;
    console.debug(`[applyProposalToMap] ✓ Application completed successfully in ${totalTime.toFixed(2)}ms`);
    return true;
}

function openAcceptOwnershipTransferDialog(idOrHash = null) {
    const tProposalUI = getProposalI18nHelper();
    const proposal = resolveProposalForBoost(idOrHash);
    if (!proposal) {
        showProposalAlertMessage('proposal_not_found', 'Proposal not found.');
        return;
    }

    const existing = document.getElementById('acceptOwnershipTransferOverlay');
    if (existing && existing.parentNode) {
        existing.parentNode.removeChild(existing);
    }

    const overlay = document.createElement('div');
    overlay.id = 'acceptOwnershipTransferOverlay';
    overlay.className = 'proposal-boost-overlay';
    overlay.addEventListener('click', event => {
        if (event.target === overlay) {
            closeAcceptOwnershipTransferDialog();
        }
    });

    const modalTitle = tProposalUI('panel.proposal.acceptTransfer.title', 'Accept ownership transfer');
    const modalCloseLabel = tProposalUI('panel.proposal.acceptTransfer.closeLabel', 'Close dialog');
    const modalCopy = tProposalUI('panel.proposal.acceptTransfer.copy', 'Fund the amount missing in the proposal to accept ownership claim to you.');
    const fundLabel = tProposalUI('panel.proposal.acceptTransfer.fund', 'Fund');
    const amountNeededLabel = tProposalUI('panel.proposal.acceptTransfer.amountNeeded', 'Amount still needed');

    // Calculate amount still needed
    const offerValue = Number.isFinite(Number(proposal.offer)) ? Number(proposal.offer) : (Number.isFinite(Number(proposal.budget)) ? Number(proposal.budget) : 0);
    const fundedValue = Number.isFinite(Number(proposal.funded)) ? Number(proposal.funded) : 0;
    const amountNeeded = Math.max(0, offerValue - fundedValue);
    const currency = proposal.offerCurrency || proposal.currency || 'EUR';
    const formattedAmount = `${amountNeeded.toLocaleString('hr-HR')} ${currency}`;

    overlay.innerHTML = `
        <div class="proposal-boost-modal" role="dialog" aria-modal="true">
            <div class="proposal-boost-header">
                <h3>${modalTitle}</h3>
                <button type="button" class="proposal-boost-close" aria-label="${modalCloseLabel}" onclick="closeAcceptOwnershipTransferDialog()">×</button>
            </div>
            <div class="proposal-boost-body">
                <p class="proposal-boost-copy">${modalCopy}</p>
                <div class="accept-transfer-amount-row" style="display:flex; flex-direction:column; align-items:center; gap:8px; margin:16px 0;">
                    <span class="accept-transfer-amount-label" style="font-size:13px; color:#666;">${amountNeededLabel}:</span>
                    <span class="accept-transfer-amount-value" style="font-size:20px; font-weight:600; color:#2e7d32;">${formattedAmount}</span>
                </div>
                <div class="proposal-boost-actions" style="display:flex; flex-direction:column; align-items:center; gap:6px;">
                    <button type="button" class="btn proposal-boost-send" style="min-width:100px; width:120px;" onclick="submitAcceptOwnershipTransfer('${proposal.proposalId || ''}')">${fundLabel}</button>
                    <div class="accept-transfer-status" id="acceptTransferStatus" aria-live="polite" style="font-size:12px; text-align:center; min-height:18px;"></div>
                </div>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);
}

function closeAcceptOwnershipTransferDialog() {
    const overlay = document.getElementById('acceptOwnershipTransferOverlay');
    if (overlay && overlay.parentNode) {
        overlay.parentNode.removeChild(overlay);
    }
}

function submitAcceptOwnershipTransfer(idOrHash = null) {
    // For now, this does nothing as per the requirements
    // Future implementation will handle the funding transaction
    console.log('Accept ownership transfer clicked for proposal:', idOrHash);
    closeAcceptOwnershipTransferDialog();
}

function computeOwnershipStatsFromSelection(selection) {
    const result = {
        ownerKeys: new Set(),
        ownerCount: 0,
        mode: 'multiple'
    };
    const layers = selection && Array.isArray(selection.layers) ? selection.layers : [];

    if (!layers.length) {
        return result;
    }

    layers.forEach((parcel, index) => {
        const parcelId = getParcelIdFromFeature(parcel?.feature);
        let addedOwnerForParcel = false;

        if (parcelId && typeof getParcelOwnerSlots === 'function') {
            try {
                const slots = getParcelOwnerSlots(String(parcelId));
                if (Array.isArray(slots) && slots.length) {
                    slots.forEach(slot => {
                        const key = slot && (slot.key || slot.ownerKey || slot.displayName || slot.name);
                        if (key) {
                            result.ownerKeys.add(String(key));
                            addedOwnerForParcel = true;
                        }
                    });
                }
            } catch (error) {
                console.warn('Failed to resolve owner slots for parcel', parcelId, error);
            }
        }

        if (!addedOwnerForParcel) {
            const fallbackKey = parcelId ? `parcel:${parcelId}:owner` : `parcel:index:${index}`;
            result.ownerKeys.add(fallbackKey);
        }
    });

    result.ownerCount = result.ownerKeys.size;
    result.mode = result.ownerCount <= 1 ? 'single' : 'multiple';
    return result;
}

function setOwnershipTransferDirection(direction) {
    currentOwnershipTransferDirection = direction;
    const buttons = document.querySelectorAll('.proposal-ownership-transfer-button');
    buttons.forEach(btn => {
        btn.classList.toggle('selected', btn.getAttribute('data-transfer-direction') === direction);
    });

    // Update proposal type based on direction - directly set currentProposalTool
    // Don't call setProposalType() as it would reset currentProposalTool to null
    // (there's no button with data-proposal-type matching the direction-specific goal)
    const effectiveGoal = direction === 'from-me' ? 'ownership-transfer-from-me' : 'ownership-transfer-to-me';
    currentProposalTool = effectiveGoal;

    // Update the hidden input for the proposal type
    const typeInput = document.getElementById('proposalType');
    if (typeInput) {
        typeInput.value = effectiveGoal;
    }

    // Update name and description
    updateProposalNameAndDescription(effectiveGoal, true);

    // Update screenshot icon
    updateProposalScreenshotGoalIcon('ownership-transfer');

    // Update options section visibility - "from-me" only shows Expire after
    updateOwnershipTransferOptions(direction);

    // No geometry for ownership transfer
    renderGeometrySection('ownership-transfer');

    // Update submit state
    updateCreateProposalSubmitState();
}

function updateOwnershipTransferOptions(direction) {
    const isFromMe = direction === 'from-me';

    // For "from-me", only show "Expire after" option
    const conditionalRow = document.getElementById('proposalOptionConditional');
    const decayRow = document.getElementById('proposalOptionDecay');
    const decayInputsRow = document.getElementById('proposalOptionDecayInputs');
    const depositRow = document.getElementById('proposalOptionDeposit');
    const areaProportionalRow = document.getElementById('proposalOptionAreaProportional');

    if (conditionalRow) conditionalRow.style.display = isFromMe ? 'none' : '';
    if (decayRow) decayRow.style.display = isFromMe ? 'none' : '';
    if (decayInputsRow) decayInputsRow.style.display = isFromMe ? 'none' : '';
    if (depositRow) depositRow.style.display = isFromMe ? 'none' : '';
    if (areaProportionalRow) areaProportionalRow.style.display = isFromMe ? 'none' : '';

    // For "from-me", uncheck conditional (makes it unconditionally accepted)
    const conditionalCheckbox = document.getElementById('proposalConditionalCheckbox');
    if (conditionalCheckbox && isFromMe) {
        conditionalCheckbox.checked = false;
    }

    // For "from-me", hide the lens button (no lens for ownership transfer from me)
    const lensFooterRow = document.querySelector('#proposalModal .lens-footer-row');
    if (lensFooterRow) {
        lensFooterRow.style.display = isFromMe ? 'none' : '';
    }
}

function resetOwnershipTransferOptions() {
    // Reset all option rows to visible
    const rows = ['proposalOptionConditional', 'proposalOptionDecay', 'proposalOptionDecayInputs', 'proposalOptionDeposit', 'proposalOptionAreaProportional'];
    rows.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = '';
    });

    // Reset conditional checkbox to checked
    const conditionalCheckbox = document.getElementById('proposalConditionalCheckbox');
    if (conditionalCheckbox) {
        conditionalCheckbox.checked = true;
    }

    // Reset lens button visibility
    const lensFooterRow = document.querySelector('#proposalModal .lens-footer-row');
    if (lensFooterRow) {
        lensFooterRow.style.display = '';
    }
}

function getProposalRecipientAddress() {
    const el = document.getElementById('proposalRecipientAddress');
    return el && el.value ? el.value.trim() : '';
}

function setProposalOwnershipMode(mode, { lock = false, unlock = false, reason = '' } = {}) {
    proposalFacetState.ownership = mode;
    applyFacetLockUI('proposalOwnershipGroup', 'proposalOwnershipStatic', 'proposalOwnership', mode, lock, reason);
    // Third party reveals the Specific-address / Anyone sub-choice (Anyone = open sale offer).
    const opts = document.getElementById('proposalRecipientOptions');
    if (opts) opts.style.display = (!lock && mode === 'third-party') ? '' : 'none';
    updateRecipientAddressVisibility();
}

function updateRecipientAddressVisibility() {
    const addr = document.getElementById('proposalRecipientAddress');
    if (!addr) return;
    const opts = document.getElementById('proposalRecipientOptions');
    const optsVisible = !!opts && opts.style.display !== 'none';
    const scopeSel = document.querySelector('input[name="proposalRecipientScope"]:checked');
    const scope = scopeSel ? scopeSel.value : 'any';
    addr.style.display = (optsVisible && scope === 'specific') ? '' : 'none';
}

function onProposalRecipientScopeChange() {
    updateRecipientAddressVisibility();
    syncProposalFacets();
}

function ownershipNameType() {
    const o = proposalFacetState.ownership;
    const scope = (window.proposalFacets && window.proposalFacets.recipientScope) || 'any';
    if (o === 'to-city') return 'ownership-transfer-to-city';
    if (o === 'third-party') return (scope === 'any') ? 'offer-to-sell' : 'ownership-transfer-third-party';
    return 'ownership-transfer-to-me';
}

function onProposalOwnershipChange() {
    const sel = document.querySelector('input[name="proposalOwnership"]:checked');
    // Route through setProposalOwnershipMode so the Third-party inset (Specific/Anyone)
    // and the address field show/hide correctly.
    setProposalOwnershipMode(sel ? sel.value : 'no-change');
    syncProposalFacets();
}

function isProposalApplied(proposal) {
    if (!proposal) return false;

    const structureData = resolveStructureProposal(proposal);
    const goalKey = resolveProposalGoalKey(proposal, null);
    const hasSpatialComponent = Boolean(
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
        || (proposal.roadProposal && proposal.roadProposal.roadGeometry)
        || proposal.roadGeometry
        || proposal.buildingProposal
        || proposal.buildingGeometry
        || structureData
        || proposal.reparcellization
        || proposal.decideLaterProposal
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

    const decideLaterStatus = (proposal.decideLaterProposal && proposal.decideLaterProposal.status)
        ? proposal.decideLaterProposal.status.toLowerCase()
        : '';
    if (decideLaterStatus === 'applied' || decideLaterStatus === 'executed') {
        return true;
    }

    return false;
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

function isProposalCurrentlyApplied(proposal) {
    if (!proposal) return false;
    const isAppliedLike = (value) => {
        const normalized = (value || '').toString().toLowerCase();
        return normalized === 'applied' || normalized === 'executed';
    };

    // Executed proposals are considered immutable and should be skipped for re-apply.
    if (isAppliedLike(proposal.status)) return true;
    if (proposal.roadProposal && isAppliedLike(proposal.roadProposal.status)) return true;
    if (proposal.buildingProposal && isAppliedLike(proposal.buildingProposal.status)) return true;
    if (proposal.structureProposal && isAppliedLike(proposal.structureProposal.status)) return true;
    if (proposal.reparcellization && isAppliedLike(proposal.reparcellization.status)) return true;
    if (proposal.decideLaterProposal && isAppliedLike(proposal.decideLaterProposal.status)) return true;
    return false;
}

function isProposalAppliedAndMaterialized(proposal) {
    if (!isProposalCurrentlyApplied(proposal)) return false;
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
        push(proposal.childParcelIds);
        push(proposal.roadProposal && proposal.roadProposal.childParcelIds);
        push(proposal.decideLaterProposal && proposal.decideLaterProposal.childParcelIds);
        if (descendantIds.length === 0) {
            // No children stored — can't verify materialization. Treat as "needs apply" so the
            // rebuild-from-definition path runs. Building/structure overlays don't hit this
            // helper because they are gated on descendant-producing rules elsewhere.
            return false;
        }
        return descendantIds.every(id => mapById.has(id));
    } catch (_) {
        return false;
    }
}

function createLeafletViewSettlePromise(beforeCenter, beforeZoom) {
    return new Promise(resolve => {
        try {
            if (typeof map === 'undefined' || !map || typeof map.once !== 'function') {
                resolve();
                return;
            }

            let settled = false;
            const timeoutId = setTimeout(() => {
                // Safety net: if we missed moveend (e.g., listener attached too late), do not hang.
                done();
            }, 1200);
            const done = () => {
                if (settled) return;
                settled = true;
                try { map.off('moveend', done); } catch (_) { }
                try { clearTimeout(timeoutId); } catch (_) { }
                resolve();
            };

            // Subscribe before the view change so we don't miss immediate (non-animated) updates.
            try { map.once('moveend', done); } catch (_) { /* ignore */ }

            // If there's no actual view change, Leaflet may not emit moveend; settle on the next frame.
            requestAnimationFrame(() => {
                if (settled) return;
                try {
                    const afterCenter = map.getCenter();
                    const afterZoom = map.getZoom();
                    if (Number.isFinite(beforeZoom) && beforeCenter) {
                        const unchanged = (afterZoom === beforeZoom) && roughlyEqualLatLng(afterCenter, beforeCenter);
                        if (unchanged) done();
                    }
                } catch (_) {
                    done();
                }
            });
        } catch (_) {
            resolve();
        }
    });
}

function acceptProposal(proposalId, parcelId, ownerKey, metadata = {}) {
    try {
        const suppressAlerts = metadata && metadata.suppressAlerts === true;
        const notifyAcceptIssue = (key, fallback) => {
            if (suppressAlerts) {
                console.debug('[acceptProposal] Suppressed user alert for automated acceptance', {
                    key,
                    proposalId,
                    parcelId,
                    ownerKey
                });
                return;
            }
            showProposalAlertMessage(key, fallback);
        };

        const proposal = proposalStorage.getProposal(proposalId);
        if (!proposal) {
            notifyAcceptIssue('proposal_not_found', 'Proposal not found.');
            return null;
        }

        const normalizedParcelId = normalizeParcelId(parcelId);
        if (!normalizedParcelId) {
            notifyAcceptIssue('invalid_parcel_identifier', 'Invalid parcel identifier.');
            return null;
        }

        const parcelIds = (proposal.parentParcelIds || []).map(id => normalizeParcelId(id));
        if (!parcelIds.includes(normalizedParcelId)) {
            notifyAcceptIssue('this_parcel_is_not_part_of_the_proposal', 'This parcel is not part of the proposal.');
            return null;
        }

        proposal.acceptedParcelIds = normalizeParcelIdList(proposal.acceptedParcelIds || []);

        const ownerSlots = getOwnerSlotsForParcel(normalizedParcelId);
        const entry = ensureOwnerAcceptanceEntry(proposal, normalizedParcelId, ownerSlots, { syncWithParcelAcceptance: false });
        if (!entry) {
            notifyAcceptIssue('unable_to_determine_owner_shares_for_this_parcel', 'Unable to determine owner shares for this parcel.');
            return null;
        }

        let effectiveOwnerKey = ownerKey;
        if (!effectiveOwnerKey) {
            if (entry.ownerOrder.length === 1) {
                effectiveOwnerKey = entry.ownerOrder[0];
            } else if (suppressAlerts) {
                const firstUnacceptedOwnerKey = entry.ownerOrder.find(key => !entry.acceptedOwnerKeys.includes(key));
                effectiveOwnerKey = firstUnacceptedOwnerKey || null;
            } else {
                notifyAcceptIssue('select_which_owner_share_you_are_accepting_for', 'Select which owner share you are accepting for.');
                return null;
            }
        }

        if (!effectiveOwnerKey) {
            notifyAcceptIssue('unable_to_determine_which_owner_share_to_accept', 'Unable to determine which owner share to accept.');
            return null;
        }

        if (entry.acceptedOwnerKeys.includes(effectiveOwnerKey)) {
            notifyAcceptIssue('this_owner_has_already_accepted_the_proposal', 'This owner has already accepted the proposal.');
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

        if (typeof proposalStorage._indexProposal === 'function') {
            proposalStorage._indexProposal(proposal);
        }
        proposalStorage.save();

        const parcelLayer = multiParcelSelection.findParcelById(normalizedParcelId);
        const parcelNumber = parcelLayer?.feature?.properties?.BROJ_CESTICE || normalizedParcelId;

        let proposalExecuted = false;
        // Proposals marked as not funded (e.g., ownership-transfer-from-me) cannot be executed.
        // Vote proposals never execute or transfer — they only accumulate yes-votes in this same
        // structure (so the tally UI is shared), staying "Open for voting" until they conclude.
        const canExecute = proposal.funded !== false
            && !isVoteProposal(proposal)
            && proposalRecipientConsentSatisfied(proposal);
        if (canExecute && proposal.acceptedParcelIds.length === parcelIds.length && parcelIds.length > 0) {
            proposal.status = 'Executed';
            proposal.executedAt = new Date().toISOString();
            if (typeof proposalStorage._indexProposal === 'function') {
                proposalStorage._indexProposal(proposal);
            }
            proposalStorage.save();
            updateShowProposalsButton();

            autoApplyExecutedProposalToMap(proposal);
            applyProposalOwnershipTransfer(proposal);

            const t = typeof getProposalI18nHelper === 'function' ? getProposalI18nHelper() : null;
            const executedMessage = (() => {
                const fullId = proposal.proposalId;
                const parcelCount = proposal.parentParcelIds.length;
                const fallback = `Proposal ${fullId} executed! All ${parcelCount} parcels accepted`;
                if (t) {
                    return t(
                        'ephemeral.messages.proposal_executed_all_parcels',
                        'Proposal {{hash}} executed! All {{count}} parcels accepted.',
                        { hash: fullId, count: parcelCount }
                    );
                }
                return fallback;
            })();

            if (resolveProposalGoalKey(proposal, null) === 'road-track' && proposal.roadGeometry) {
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
            } else if (proposal.buildingGeometry && (proposal.buildingGeometry.type === 'Polygon' || proposal.buildingGeometry.type === 'MultiPolygon' || proposal.buildingGeometry.type === 'Feature')) {
                if (proposal.buildingProposal) {
                    proposal.buildingProposal.status = 'executed';
                }
                if (typeof markProposedBuildingState === 'function') {
                    markProposedBuildingState(proposal.proposalId, 'executed', { updateLayer: true, save: true });
                } else if (typeof saveExecutedBuildingsToStorage === 'function') {
                    saveExecutedBuildingsToStorage();
                }
            } else if (proposal.structureProposal && (proposal.structureProposal.kind === 'park' || proposal.structureProposal.kind === 'square' || proposal.structureProposal.kind === 'lake')) {
                if (proposal.structureProposal) {
                    proposal.structureProposal.status = 'executed';
                }
            }

            if (typeof showEphemeralMessage === 'function') {
                showEphemeralMessage(executedMessage);
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

async function handleUserRejectProposal(proposalId, parcelId, ownerKey = null) {
    const userAgent = typeof getCurrentUserAgent === 'function' ? getCurrentUserAgent() : null;
    if (!userAgent) {
        showProposalAlertMessage('you_must_be_logged_in_to_undo_an_acceptance', 'You must be logged in to undo an acceptance.');
        return;
    }

    const proposal = proposalStorage.getProposal(proposalId);
    if (!proposal) {
        showProposalAlertMessage('proposal_not_found', 'Proposal not found.');
        return;
    }

    // Check if proposal is executed and has descendants
    const proposalStatus = (proposal.status || '').toLowerCase();
    if (proposalStatus === 'executed') {
        if (typeof ProposalManager !== 'undefined' && typeof ProposalManager._getProposalDescendants === 'function') {
            const descendants = ProposalManager._getProposalDescendants(proposalId);
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

    // A vote proposal rescinds its yes-vote (rescindVote) instead of withdrawing an acceptance;
    // rescission is always allowed while voting is open, so the conditional/executed guards don't apply.
    const isVote = typeof isVoteProposal === 'function' && isVoteProposal(proposal);

    // Check if this proposal is minted on-chain — if so, withdraw/rescind on-chain first
    const rejectNftInfo = typeof getProposalNftInfo === 'function' ? getProposalNftInfo(proposal) : null;
    const rejectBridge = window.ProposalChainBridge;
    const rejectMethod = isVote ? 'rescindVote' : 'withdrawAcceptance';
    const isOnChain = rejectNftInfo && rejectBridge && typeof rejectBridge[rejectMethod] === 'function';
    const normalizedParcelIdForChain = normalizeParcelId(parcelId);

    if (isOnChain) {
        if (!isVote) {
            // Pre-check: on-chain withdrawal is only possible for conditional, active proposals
            if (proposalStatus === 'executed' || proposalStatus === 'applied') {
                showProposalAlertMessage('cannot_withdraw_executed_proposal',
                    'This acceptance cannot be withdrawn because the proposal has been executed.');
                return;
            }
            if (!proposal.isConditional) {
                showProposalAlertMessage('cannot_withdraw_non_conditional',
                    'This acceptance cannot be withdrawn because the proposal is not conditional.');
                return;
            }
        }
        try {
            if (typeof updateStatus === 'function') {
                updateStatus(isVote ? 'Rescinding vote on chain...' : 'Withdrawing acceptance on chain...');
            }
            await rejectBridge[rejectMethod]({
                proposalId: rejectNftInfo.tokenId,
                parcelId: normalizedParcelIdForChain,
                chainId: rejectNftInfo.chain,
                contractAddress: rejectNftInfo.contract
            });
        } catch (onchainErr) {
            console.warn(isVote ? 'On-chain vote rescind failed:' : 'On-chain withdrawal failed:', onchainErr);
            const friendlyMessage = parseOnChainErrorMessage(onchainErr);
            showProposalAlertMessage(isVote ? 'on_chain_vote_rescind_failed' : 'on_chain_withdrawal_failed', friendlyMessage);
            return;
        }
    }

    // On-chain succeeded (or not on-chain) — now record locally
    const result = rejectProposal(proposalId, parcelId, targetEntry.key);
    if (!result) {
        return;
    }

    if (isOnChain && typeof updateStatus === 'function') {
        updateStatus(isVote ? 'Vote rescinded on chain.' : 'Acceptance withdrawn on chain.');
    }

    const ownerLabel = targetEntry.shareText
        ? `${targetEntry.displayName} (${targetEntry.shareText})`
        : targetEntry.displayName;

    if (typeof addUserActionToGameLog === 'function') {
        const logMsg = isVote
            ? `<a href="#" data-agent-id="${userAgent.id}" class="agent-link agent-link-clickable">${userAgent.name}</a> rescinded the yes-vote as ${ownerLabel} on proposal ${proposalId}.`
            : `<a href="#" data-agent-id="${userAgent.id}" class="agent-link agent-link-clickable">${userAgent.name}</a> revoked acceptance recorded for ${ownerLabel} on parcel ${parcelId}.`;
        addUserActionToGameLog(logMsg);
    }

    if (typeof updateStatus === 'function') {
        updateStatus(isVote
            ? `Rescinded vote for ${ownerLabel}.`
            : `Revoked acceptance for ${ownerLabel} on parcel ${parcelId}.`);
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
        const updatedProposal = proposalStorage.getProposal(proposalId);
        if (updatedProposal) {
            refreshProposalOwnerAcceptanceUI(updatedProposal, parcelId);
            restoreProposalDetailsScroll(preserveState);
        }
    }, 0);
}

function rejectProposal(proposalId, parcelId, ownerKey = null) {
    try {
        const proposal = proposalStorage.getProposal(proposalId);
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
                const descendants = ProposalManager._getProposalDescendants(proposalId);
                if (!descendants || descendants.length === 0) {
                    proposal.status = 'Active';
                    delete proposal.executedAt;
                }
            }
        }

        if (typeof proposalStorage._indexProposal === 'function') {
            proposalStorage._indexProposal(proposal);
        }
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
