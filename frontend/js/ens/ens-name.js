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
        return '<div class="ens-name-line">'
            + `<a class="ens-name-chip" href="${ensAppUrl(name)}" target="_blank"`
            + ` rel="noopener noreferrer" title="View ${name} on the ENS app">ENS ↗</a>`
            + `<span class="ens-name-value" title="${name} — click to copy"`
            + ` onclick="copyEnsName(${inlineJsArg(name)}, this)">${name}</span></div>`;
    }

    global.parcelToSlug = parcelToSlug;
    global.parcelEnsName = parcelEnsName;
    global.proposalEnsName = proposalEnsName;
    global.ensAppUrl = ensAppUrl;
    global.copyEnsName = copyEnsName;
    global.ensNameLineHtml = ensNameLineHtml;
})(typeof window !== 'undefined' ? window : globalThis);
