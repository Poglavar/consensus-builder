// agreement-list.js — the Agreements dialog (plan-design-agreement.md, "M1 (b) build contract"): the
// agreements kept on this device for the current city, newest first, each opening its panel
// (agreement-panel.js), and Create agreement over every applied design. The Minted agreements dialog
// (M3) lists the city's agreements the index records as minted (GET /agreements?minted=1), each
// opening its panel, imported from its link when this device does not hold it. window.AgreementList;
// the row wording and the applied-design ids are pure and tested in backend/test/agreement-panel.test.js.
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
        const count = Array.isArray(content.designs) ? content.designs.length : 0;
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
            + `<button type="button" class="btn btn-secondary" data-agreement-action="minted">${esc(tr('agreement.minted.title', 'Minted agreements'))}</button>`
            + '</div>'
            + `<div class="agreement-list-rows" data-agreement-list-rows>${rows}</div>`;
    }

    // ---- the browser layer -----------------------------------------------------------------------

    function open(win) {
        const store = win.AgreementStore;
        const dialogs = win.CbDialog;
        if (!store || !dialogs || typeof dialogs.open !== 'function') throw new Error('AgreementList needs AgreementStore and CbDialog.');
        // A row that cannot be read is named in the list, not skipped.
        const rows = () => {
            try {
                return rowsHtml(store.list());
            } catch (error) {
                console.error(`[${new Date().toISOString()}] [AgreementList] the agreements could not be read`, error);
                return `<p class="agreement-list-error" role="alert">${esc(error && error.message ? error.message : String(error))}</p>`;
            }
        };
        const report = (what, error) => {
            console.error(`[${new Date().toISOString()}] [AgreementList] ${what}`, error);
            if (typeof win.showEphemeralMessage === 'function') win.showEphemeralMessage((error && error.message) || String(error), 6000, 'error');
        };
        const body = win.document.createElement('div');
        body.className = 'agreement-list-body';
        body.innerHTML = bodyHtml(rows());
        let unsubscribe = null;
        const dialog = dialogs.open({
            title: t('sidebar.proposals.agreementsButton', 'Agreements'),
            size: 'md',
            className: 'agreement-list-dialog',
            body,
            onClose: () => { if (typeof unsubscribe === 'function') unsubscribe(); }
        });
        if (!dialog) return null;
        // Saved, deleted or cleared while the list is open: the rows follow.
        unsubscribe = store.subscribe(() => {
            const list = body.querySelector('[data-agreement-list-rows]');
            if (list) list.innerHTML = rows();
        });
        body.addEventListener('click', event => {
            if (event.target.closest('[data-agreement-action="minted"]')) {
                dialog.close(null);
                openMinted(win);
                return;
            }
            if (event.target.closest('[data-agreement-action="create"]')) {
                const designIds = appliedDesignIds(win.proposalStorage.peekAllProposals(), win.isApplied);
                dialog.close(null);
                Promise.resolve(win.AgreementDialog.open({ designIds })).catch(error => report('the agreement dialog failed', error));
                return;
            }
            const row = event.target.closest('[data-agreement-id]');
            if (!row) return;
            dialog.close(null);
            Promise.resolve(win.AgreementPanel.open(row.getAttribute('data-agreement-id'))).catch(error => report('the agreement could not be opened', error));
        });
        return dialog;
    }

    // The Minted agreements dialog: the index's minted agreements of the current city, with Refresh.
    // A row opens the agreement's panel: this device's copy, or the agreement imported from its link.
    function openMinted(win) {
        const dialogs = win.CbDialog;
        if (!win.AgreementSync || !dialogs || typeof dialogs.open !== 'function') throw new Error('The minted agreements need AgreementSync and CbDialog.');
        const log = message => console.log(`[${new Date().toISOString()}] [AgreementList] ${message}`);
        const report = (what, error) => {
            console.error(`[${new Date().toISOString()}] [AgreementList] ${what}`, error);
            if (typeof win.showEphemeralMessage === 'function') win.showEphemeralMessage((error && error.message) || String(error), 6000, 'error');
        };
        const body = win.document.createElement('div');
        body.className = 'agreement-list-body';
        body.innerHTML = '<p class="agreement-list-status" role="status" data-agreement-minted-status></p>'
            + '<div class="agreement-list-rows" data-agreement-list-rows></div>';
        const status = body.querySelector('[data-agreement-minted-status]');
        const list = body.querySelector('[data-agreement-list-rows]');
        let token = 0;
        async function load() {
            const mine = ++token;
            status.hidden = false;
            status.textContent = t('agreement.minted.loading', 'Reading the minted agreements…');
            list.innerHTML = '';
            const code = typeof win.resolveCurrentCityCode === 'function' ? win.resolveCurrentCityCode() : null;
            const city = code && typeof win.normalizeCityCodeForApi === 'function' ? win.normalizeCityCodeForApi(code) : code;
            try {
                const rows = await win.AgreementSync.fetchMinted({ city });
                if (mine !== token) return;
                log(`${rows.length} minted agreement(s) in ${city || 'every city'}`);
                status.hidden = true;
                list.innerHTML = mintedRowsHtml(rows);
            } catch (error) {
                if (mine !== token) return;
                console.error(`[${new Date().toISOString()}] [AgreementList] the minted agreements could not be read`, error);
                status.textContent = t('agreement.minted.failed', 'The minted agreements could not be read: {{reason}}', { reason: (error && error.message) || String(error) });
            }
        }
        const dialog = dialogs.open({
            title: t('agreement.minted.title', 'Minted agreements'),
            size: 'md',
            className: 'agreement-list-dialog agreement-minted-dialog',
            body,
            actions: [{ id: 'refresh', label: t('agreement.minted.refresh', 'Refresh'), role: 'secondary', keepOpen: true, onClick: () => { load(); } }],
            onClose: () => { token += 1; }
        });
        if (!dialog) return null;
        body.addEventListener('click', event => {
            const row = event.target.closest('[data-agreement-cid]');
            if (!row) return;
            const cid = row.getAttribute('data-agreement-cid');
            dialog.close(null);
            const local = win.AgreementSync.localCopyOf(cid);
            Promise.resolve(local ? win.AgreementPanel.open(local.id) : win.AgreementSync.handleAgreementRoute(cid))
                .catch(error => report(`the minted agreement ${cid} could not be opened`, error));
        });
        load();
        return dialog;
    }

    return { rowLabel, appliedDesignIds, rowsHtml, bodyHtml, mintedRowLabel, mintedRowsHtml, open, openMinted };
});
