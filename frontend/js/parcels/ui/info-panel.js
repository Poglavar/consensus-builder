(function (global) {
    'use strict';

    const tParcel = (key, params = {}, fallback = '') => {
        if (typeof global.tParcel === 'function') {
            return global.tParcel(key, params, fallback);
        }
        try {
            const api = global.i18n;
            if (api && typeof api.t === 'function') {
                const translated = api.t(key, params || {});
                if (translated !== undefined && translated !== null) {
                    return translated;
                }
            }
        } catch (_) { }
        return fallback || key || '';
    };

    const ACCEPTANCE_BAR_THRESHOLD = 20;

    function buildAcceptanceBar(labelText, acceptedCount, total, options = {}) {
        const percentage = total > 0 ? (acceptedCount / total) * 100 : 0;
        const height = Number.isFinite(options.height) ? options.height : 12;
        return `
                <div class="proposal-acceptance-status">
                    <div class="acceptance-label">${labelText} (${acceptedCount}/${total})</div>
                    <div class="acceptance-progress-bar" style="
                        width: 100%;
                        height: ${height}px;
                        background-color: #e0e0e0;
                        border-radius: 4px;
                        overflow: hidden;
                        position: relative;
                    ">
                        <div class="acceptance-progress-fill" style="
                            width: ${percentage}%;
                            height: 100%;
                            background-color: #4caf50;
                            transition: width 0.25s ease;
                        "></div>
                    </div>
                </div>`;
    }

    function buildCompactAcceptanceRow(label, entries, options = {}) {
        if (!entries || entries.length === 0) {
            return '';
        }
        const safeLabel = typeof global.escapeHtml === 'function'
            ? global.escapeHtml(label || 'Acceptance')
            : (label || 'Acceptance');
        const summaryText = options.summary || '';
        const summaryHtml = summaryText
            ? `<span class="compact-acceptance-summary">${typeof global.escapeHtml === 'function' ? global.escapeHtml(summaryText) : summaryText}</span>`
            : '';
        const circlesHtml = entries.map(entry => {
            const statusClass = entry && entry.accepted ? 'accepted' : 'pending';
            const title = entry && entry.title ? entry.title : '';
            const safeTitle = title && typeof global.escapeHtml === 'function' ? global.escapeHtml(title) : title;
            return `<span class="acceptance-circle ${statusClass} compact"${safeTitle ? ` title="${safeTitle}"` : ''}></span>`;
        }).join('');

        return `
        <div class="compact-acceptance-row">
            <div class="compact-acceptance-label">
                ${safeLabel}${summaryHtml ? ` ${summaryHtml}` : ''}
            </div>
            <div class="acceptance-circles compact">${circlesHtml}</div>
        </div>
    `;
    }

    function buildParcelAcceptanceIndicators(proposal) {
        if (!proposal || !Array.isArray(proposal.parentParcelIds) || proposal.parentParcelIds.length === 0) {
            return '';
        }
        const acceptedSet = new Set(
            (proposal.acceptedParcelIds || []).map(id => (id !== undefined && id !== null) ? id.toString() : '')
        );
        const entries = proposal.parentParcelIds.map((id, index) => {
            const normalizedId = (id !== undefined && id !== null) ? id.toString() : `parcel_${index + 1}`;
            const isAccepted = acceptedSet.has(normalizedId);
            const parcelLabel = normalizedId
                ? tParcel('panel.parcel.acceptance.parcelLabel', { id: normalizedId }, `Parcel ${normalizedId}`)
                : '';
            const statusLabel = tParcel(
                isAccepted ? 'panel.parcel.acceptance.accepted' : 'panel.parcel.acceptance.pending',
                {},
                isAccepted ? 'accepted' : 'pending'
            );
            const title = parcelLabel ? `${parcelLabel} ${statusLabel}` : '';
            return {
                accepted: isAccepted,
                title
            };
        });
        const acceptedCount = entries.filter(entry => entry.accepted).length;
        const total = entries.length;
        const label = tParcel('panel.parcel.acceptance.parcelTitle', {}, 'Parcel acceptance');

        // Use a bar for large sets to avoid rendering a circle swarm in the parcel info tab
        if (total > ACCEPTANCE_BAR_THRESHOLD) {
            return buildAcceptanceBar(label, acceptedCount, total, { height: 12 });
        }

        return buildCompactAcceptanceRow(
            label,
            entries,
            {
                summary: `${acceptedCount}/${entries.length}`
            }
        );
    }

    function buildOwnerAcceptanceIndicators(proposal) {
        const ownerLabel = tParcel('panel.parcel.acceptance.ownerTitle', {}, 'Owner acceptance');
        if (typeof global.buildProposalOwnerAcceptanceSummary === 'function') {
            const summary = global.buildProposalOwnerAcceptanceSummary(proposal);
            if (summary && summary.totalOwners > 0) {
                const totalOwners = summary.totalOwners;
                const acceptedOwners = summary.acceptedOwners || 0;
                if (totalOwners > ACCEPTANCE_BAR_THRESHOLD) {
                    return buildAcceptanceBar(ownerLabel, acceptedOwners, totalOwners, { height: 12 });
                }
                const entries = summary.entries.map(entry => {
                    if (!entry) return null;
                    const parts = [];
                    if (entry.displayName) parts.push(entry.displayName);
                    if (entry.shareText) parts.push(entry.shareText);
                    if (entry.parcelId) parts.push(`Parcel ${entry.parcelId}`);
                    parts.push(tParcel(
                        entry.accepted ? 'panel.parcel.acceptance.accepted' : 'panel.parcel.acceptance.pending',
                        {},
                        entry.accepted ? 'accepted' : 'pending'
                    ));
                    return {
                        accepted: !!entry.accepted,
                        title: parts.join(' • ')
                    };
                }).filter(Boolean);
                if (entries.length > 0) {
                    return buildCompactAcceptanceRow(
                        ownerLabel,
                        entries,
                        {
                            summary: `${acceptedOwners}/${totalOwners}`
                        }
                    );
                }
            }
        }

        if (typeof global.getProposalOwnerAcceptanceState !== 'function') {
            return '';
        }
        const targetParcelId = Array.isArray(proposal?.parentParcelIds) && proposal.parentParcelIds.length > 0
            ? proposal.parentParcelIds[0]
            : (Array.isArray(proposal?.childParcelIds) && proposal.childParcelIds.length > 0 ? proposal.childParcelIds[0] : null);
        if (!targetParcelId) {
            return '';
        }
        const fallbackState = global.getProposalOwnerAcceptanceState(proposal, targetParcelId, { syncWithParcelAcceptance: false });
        const fallbackEntries = fallbackState && Array.isArray(fallbackState.entries) ? fallbackState.entries : [];
        if (!fallbackEntries.length) {
            return '';
        }
        const mappedEntries = fallbackEntries.map(entry => {
            const parts = [];
            if (entry && entry.displayName) parts.push(entry.displayName);
            if (entry && entry.shareText) parts.push(entry.shareText);
            parts.push(tParcel(
                entry && entry.accepted ? 'panel.parcel.acceptance.accepted' : 'panel.parcel.acceptance.pending',
                {},
                entry && entry.accepted ? 'accepted' : 'pending'
            ));
            return {
                accepted: !!(entry && entry.accepted),
                title: parts.join(' • ')
            };
        });
        const totalOwners = mappedEntries.length;
        const acceptedCount = mappedEntries.filter(entry => entry.accepted).length;
        if (totalOwners > ACCEPTANCE_BAR_THRESHOLD) {
            return buildAcceptanceBar(ownerLabel, acceptedCount, totalOwners, { height: 12 });
        }
        return buildCompactAcceptanceRow(
            ownerLabel,
            mappedEntries,
            {
                summary: `${acceptedCount}/${totalOwners}`
            }
        );
    }

    global.buildCompactAcceptanceRow = buildCompactAcceptanceRow;
    global.buildParcelAcceptanceIndicators = buildParcelAcceptanceIndicators;
    global.buildOwnerAcceptanceIndicators = buildOwnerAcceptanceIndicators;
})(typeof window !== 'undefined' ? window : globalThis);

