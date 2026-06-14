// Client-side ENS name helpers: derive a parcel/proposal's ENS name (mirrors
// backend/ens/slug.js) and render a compact, copy-on-click line for the panels.
// Names resolve via parcels/proposals.urbangametheory.eth (see feature-ens.md).
(function (global) {
    'use strict';

    const PARCELS_PARENT = 'parcels.urbangametheory.eth';
    const PROPOSALS_PARENT = 'proposals.urbangametheory.eth';

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

    // Only minted proposals (numeric on-chain ids) have a resolvable name.
    function proposalEnsName(proposalId) {
        const id = (proposalId === undefined || proposalId === null) ? '' : String(proposalId).trim();
        return /^[0-9]+$/.test(id) ? `${id}.${PROPOSALS_PARENT}` : '';
    }

    // The ENS manager app page for a name (view/manage its records).
    function ensAppUrl(name) {
        return name ? `https://app.ens.domains/${encodeURIComponent(name)}` : '';
    }

    // Copy the full name; briefly flip the chip to a check for feedback. `el` is
    // the value span, so reach the chip via the shared `.ens-name-line` parent.
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

    // Compact one-liner: the "ENS" chip links to the ENS app (new tab), the name
    // value is click-to-copy. (HTML string; click handler is the global below.)
    function ensNameLineHtml(name) {
        if (!name) return '';
        const safe = name.replace(/'/g, "\\'");
        return '<div class="ens-name-line">'
            + `<a class="ens-name-chip" href="${ensAppUrl(name)}" target="_blank"`
            + ` rel="noopener noreferrer" title="View ${name} on the ENS app">ENS ↗</a>`
            + `<span class="ens-name-value" title="${name} — click to copy"`
            + ` onclick="copyEnsName('${safe}', this)">${name}</span></div>`;
    }

    global.parcelToSlug = parcelToSlug;
    global.parcelEnsName = parcelEnsName;
    global.proposalEnsName = proposalEnsName;
    global.ensAppUrl = ensAppUrl;
    global.copyEnsName = copyEnsName;
    global.ensNameLineHtml = ensNameLineHtml;
})(typeof window !== 'undefined' ? window : globalThis);
