// Client-side ENS name helpers: derive a parcel/proposal's ENS name (mirrors
// backend/ens/slug.js) and render a compact, copy-on-click line for the panels.
// Names resolve via parcels/proposals.urbangametheory.eth (see feature-ens.md).
(function (global) {
    'use strict';

    const PARCELS_PARENT = 'parcels.urbangametheory.eth';
    const PROPOSALS_PARENT = 'proposals.urbangametheory.eth';
    const MAX_COMPACT_NAME_LENGTH = 36;

    function escapeHtml(value) {
        if (typeof global.escapeHtml === 'function') return global.escapeHtml(value);
        if (value === null || value === undefined) return '';
        return String(value).replace(/[&<>"']/g, char => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        })[char]);
    }

    function inlineJsArg(value) {
        if (typeof global.inlineJsArg === 'function') return global.inlineJsArg(value);
        return escapeHtml(JSON.stringify(String(value ?? '')));
    }

    function t(key, fallback) {
        try {
            const translated = global.i18n?.t?.(key);
            if (translated && translated !== key) return translated;
        } catch (_) { /* use the English fallback */ }
        return fallback;
    }

    // ENSIP-15-safe label, same transform as the backend slug.
    function parcelToSlug(parcelId) {
        const raw = (parcelId === undefined || parcelId === null) ? '' : String(parcelId).trim();
        if (!raw) return '';
        return raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    }

    function parcelEnsName(parcelId) {
        const slug = parcelToSlug(parcelId);
        return slug ? `${slug}.${PARCELS_PARENT}` : '';
    }

    // Legacy numeric proposal names remain supported. Chain mirrors use a short
    // prefix of their canonical chain_<sha256(ref)> id; the gateway checks that
    // the prefix identifies exactly one mirrored proposal before resolving it.
    function proposalEnsName(proposal) {
        const id = (proposal === undefined || proposal === null) ? '' : String(proposal).trim();
        if (/^[0-9]+$/.test(id)) return `${id}.${PROPOSALS_PARENT}`;

        const mirrorId = proposal && typeof proposal === 'object'
            ? String(proposal.chainMirrorProposalId || proposal.proposalId || '').trim()
            : id;
        const match = mirrorId.match(/^chain_([0-9a-f]{64})$/i);
        return match ? `chain-${match[1].slice(0, 48).toLowerCase()}.${PROPOSALS_PARENT}` : '';
    }

    // Display-only shortening. The canonical name remains untouched for links and copying.
    function compactEnsName(name) {
        const full = (name === undefined || name === null) ? '' : String(name);
        if (full.length <= MAX_COMPACT_NAME_LENGTH) return full;
        const chain = full.match(/^chain-([0-9a-f]{48})\.proposals\.urbangametheory\.eth$/i);
        if (chain) return `chain-${chain[1].slice(0, 8).toLowerCase()}…proposals…eth`;

        const labels = full.split('.');
        if (labels.length < 2) return `${full.slice(0, MAX_COMPACT_NAME_LENGTH - 1)}…`;
        const suffixTail = labels.length >= 3
            ? `…${labels[1]}…${labels[labels.length - 1]}`
            : `…${labels[labels.length - 1]}`;
        const firstLabelRoom = Math.max(1, MAX_COMPACT_NAME_LENGTH - suffixTail.length);
        const firstIsTruncated = labels[0].length > firstLabelRoom;
        const firstLabel = firstIsTruncated ? `${labels[0].slice(0, firstLabelRoom - 1)}…` : labels[0];
        const tail = firstIsTruncated ? suffixTail.slice(1) : suffixTail;
        const compact = `${firstLabel}${tail}`;
        return compact.length <= MAX_COMPACT_NAME_LENGTH
            ? compact
            : `${compact.slice(0, MAX_COMPACT_NAME_LENGTH - 1)}…`;
    }

    // The ENS manager app page for a name (view/manage its records).
    function ensAppUrl(name) {
        return name ? `https://app.ens.domains/${encodeURIComponent(name)}` : '';
    }

    // Copy the full name; briefly flip the chip to a check for feedback. `el` is
    // the value button, so reach the chip via the shared `.ens-name-line` parent.
    function copyEnsName(name, el) {
        if (!name) return;
        const flip = () => {
            const line = el && el.closest ? el.closest('.ens-name-line') : null;
            const chip = line ? line.querySelector('.ens-name-chip') : null;
            if (!chip) return;
            const prev = chip.textContent;
            chip.textContent = '✓';
            setTimeout(() => { chip.textContent = prev; }, 1200);
        };
        if (global.navigator && global.navigator.clipboard && global.navigator.clipboard.writeText) {
            global.navigator.clipboard.writeText(name).then(flip).catch(() => {});
        }
    }

    // The ENS badge links out to the manager (cb-link--external adds the one ↗); the value is a
    // quiet script link that copies the full name.
    function ensNameLineHtml(name) {
        if (!name) return '';
        const fullName = escapeHtml(name);
        const viewLabel = escapeHtml(t('ens.viewName', 'View ENS name'));
        const copyLabel = escapeHtml(t('ens.copyName', 'Copy ENS name'));
        return '<div class="ens-name-line">'
            + `<a class="cb-badge cb-link--external ens-name-chip" href="${escapeHtml(ensAppUrl(name))}" target="_blank"`
            + ` rel="noopener noreferrer" title="${viewLabel}: ${fullName}">ENS</a>`
            + `<button type="button" class="cb-link cb-link--quiet ens-name-value" title="${copyLabel}: ${fullName}"`
            + ` aria-label="${copyLabel}: ${fullName}"`
            + ` onclick="copyEnsName(${inlineJsArg(name)}, this)">${escapeHtml(compactEnsName(name))}</button></div>`;
    }

    global.parcelToSlug = parcelToSlug;
    global.parcelEnsName = parcelEnsName;
    global.proposalEnsName = proposalEnsName;
    global.compactEnsName = compactEnsName;
    global.ensAppUrl = ensAppUrl;
    global.copyEnsName = copyEnsName;
    global.ensNameLineHtml = ensNameLineHtml;
})(typeof window !== 'undefined' ? window : globalThis);
