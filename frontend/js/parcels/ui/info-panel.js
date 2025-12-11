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
        if (!proposal || !Array.isArray(proposal.parcelIds) || proposal.parcelIds.length === 0) {
            return '';
        }
        const acceptedSet = new Set(
            (proposal.acceptedParcelIds || []).map(id => (id !== undefined && id !== null) ? id.toString() : '')
        );
        const entries = proposal.parcelIds.map((id, index) => {
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
        return buildCompactAcceptanceRow(
            tParcel('panel.parcel.acceptance.parcelTitle', {}, 'Parcel acceptance'),
            entries,
            {
                summary: `${acceptedCount}/${entries.length}`
            }
        );
    }

    function buildOwnerAcceptanceIndicators(proposal) {
        if (typeof global.buildProposalOwnerAcceptanceSummary === 'function') {
            const summary = global.buildProposalOwnerAcceptanceSummary(proposal);
            if (summary && summary.totalOwners > 0) {
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
                        tParcel('panel.parcel.acceptance.ownerTitle', {}, 'Owner acceptance'),
                        entries,
                        {
                            summary: `${summary.acceptedOwners}/${summary.totalOwners}`
                        }
                    );
                }
            }
        }

        if (typeof global.getProposalOwnerAcceptanceState !== 'function') {
            return '';
        }
        const targetParcelId = Array.isArray(proposal && proposal.parcelIds) && proposal.parcelIds.length > 0
            ? proposal.parcelIds[0]
            : null;
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
        const acceptedCount = mappedEntries.filter(entry => entry.accepted).length;
        return buildCompactAcceptanceRow(
            tParcel('panel.parcel.acceptance.ownerTitle', {}, 'Owner acceptance'),
            mappedEntries,
            {
                summary: `${acceptedCount}/${mappedEntries.length}`
            }
        );
    }

    global.buildCompactAcceptanceRow = buildCompactAcceptanceRow;
    global.buildParcelAcceptanceIndicators = buildParcelAcceptanceIndicators;
    global.buildOwnerAcceptanceIndicators = buildOwnerAcceptanceIndicators;
})(typeof window !== 'undefined' ? window : globalThis);

