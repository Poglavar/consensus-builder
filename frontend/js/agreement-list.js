// Agreement list wording and the entry point into the shared Lists panel.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root && typeof root.document !== 'undefined') {
        root.AgreementList = Object.freeze({ open: () => api.open(root), openMinted: () => api.openMinted(root) });
    }
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';

    const panelApi = () => root.AgreementPanel || (typeof require === 'function' ? require('./agreement-panel.js') : null);

    function t(key, fallback, params = {}) {
        let value = null;
        try {
            if (root.i18n && typeof root.i18n.t === 'function') {
                value = root.i18n.t(key, params);
                if (value === key) value = null;
            }
        } catch (_) { }
        let output = value || fallback;
        Object.keys(params).forEach(name => {
            output = String(output).replace(new RegExp(`\\{\\{\\s*${name}\\s*\\}\\}|\\{${name}\\}`, 'g'), String(params[name]));
        });
        return output;
    }

    function esc(value) {
        return String(value === undefined || value === null ? '' : value)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    const idOf = value => (value === undefined || value === null ? '' : String(value).trim());

    // A row in words: the agreement's title (or "Agreement of <date>"), then its designs and its rule.
    function rowLabel(agreement, tr = t) {
        const panel = panelApi();
        const count = agreement && Array.isArray(agreement.designs) ? agreement.designs.length : 0;
        const designs = tr('agreement.list.designs', count === 1 ? '{{count}} design' : '{{count}} designs', { count });
        return { title: panel.titleOf(agreement, tr), meta: `${designs} · ${panel.ruleShort(agreement && agreement.rule, tr)}` };
    }

    // What a new agreement starts from: every applied design held here.
    function appliedDesignIds(records, isApplied) {
        if (typeof isApplied !== 'function') throw new TypeError('appliedDesignIds needs isApplied.');
        return (Array.isArray(records) ? records : [])
            .filter(record => record && idOf(record.proposalId) && isApplied(record))
            .map(record => idOf(record.proposalId));
    }

    function rowsHtml(agreements, tr = t) {
        if (!agreements.length) return `<p class="agreement-list-empty">${esc(tr('agreement.list.empty', 'No agreements yet. Apply designs, then create one.'))}</p>`;
        return '<ul class="agreement-list">' + agreements.map(agreement => {
            const label = rowLabel(agreement, tr);
            return `<li><button type="button" class="btn btn-quiet agreement-item" data-agreement-id="${esc(agreement.id)}">`
                + `<span class="agreement-item__text"><span class="agreement-item__title">${esc(label.title)}</span>`
                + `<span class="agreement-item__meta">${esc(label.meta)}</span></span></button></li>`;
        }).join('') + '</ul>';
    }

    // A minted agreement as the index lists it: its title, its designs, its status on chain and its account.
    function mintedRowLabel(row, tr = t) {
        const panel = panelApi();
        const content = (row && row.content) || {};
        const count = Array.isArray(row?.designCids) ? row.designCids.length : 0;
        const designs = tr('agreement.list.designs', count === 1 ? '{{count}} design' : '{{count}} designs', { count });
        const onchain = (row && row.onchain) || {};
        return {
            title: panel.titleOf({ title: (row && row.title) || content.title || null, createdAt: content.createdAt || (row && row.createdAt) || null }, tr),
            meta: `${designs} · ${panel.chainStatusText(onchain.status, tr)} · ${panel.shortKey(onchain.account)}`
        };
    }

    function mintedRowsHtml(rows, tr = t) {
        if (!rows.length) return `<p class="agreement-list-empty">${esc(tr('agreement.minted.empty', 'No agreement of this city is minted yet.'))}</p>`;
        return '<ul class="agreement-list">' + rows.map(row => {
            const label = mintedRowLabel(row, tr);
            return `<li><button type="button" class="btn btn-quiet agreement-item" data-agreement-cid="${esc(row.cid)}">`
                + `<span class="agreement-item__text"><span class="agreement-item__title">${esc(label.title)}</span>`
                + `<span class="agreement-item__meta">${esc(label.meta)}</span></span></button></li>`;
        }).join('') + '</ul>';
    }

    function bodyHtml(rows, tr = t) {
        return '<div class="agreement-list-actions">'
            + `<button type="button" class="btn btn-primary" data-agreement-action="create"><i class="fas fa-plus" aria-hidden="true"></i> ${esc(tr('agreement.list.create', 'Create agreement'))}</button>`
            + `<button type="button" class="btn btn-secondary" data-agreement-action="community">${esc(tr('agreement.rule.community', 'Ask the community'))}</button>`
            + `<button type="button" class="btn btn-secondary" data-agreement-action="minted">${esc(tr('agreement.minted.title', 'Minted agreements'))}</button>`
            + '</div>'
            + `<div class="agreement-list-rows" data-agreement-list-rows>${rows}</div>`;
    }

    // ---- the browser layer -----------------------------------------------------------------------

    function open(win) { return win.openDesignsTab('agreements'); }
    function openMinted(win) { return open(win); }

    return { rowLabel, appliedDesignIds, rowsHtml, bodyHtml, mintedRowLabel, mintedRowsHtml, open, openMinted };
});
