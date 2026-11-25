// Browser-owned economic source overrides. Local rate tables are validated before storage; applying
// a choice reloads the current view so every price consumer starts from the same source selection.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) {
        root.EconomicSourceSettings = api;
        root.document.getElementById('economic-source-settings-button')?.addEventListener('click', () => api.open(root));
    }
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';
    const key = cityId => 'cb_economic_source:' + cityId;
    const storage = global => global.BrowserWorkspace?.storage || global.localStorage;
    const contract = global => global.EconomicSources || (typeof require === 'function' ? require('./economic-sources.js') : null);
    function choiceForCity(cityId, global) {
        const raw = storage(global)?.getItem(key(cityId));
        if (!raw) return null;
        // Invalid evidence is surfaced to the caller rather than silently replaced by a default.
        return contract(global).rateTable(JSON.parse(raw));
    }
    function saveChoice(city, value, global) {
        const source = contract(global).rateTable(value);
        if (Object.hasOwn(contract(global).BUILT_INS, source.id)) throw new Error('A local source needs its own identity.');
        if (source.rates.some(row => row.currency !== city.currency?.code)) throw new Error('Economic source currency differs from the place.');
        const json = JSON.stringify(source);
        storage(global).setItem(key(city.id), json);
        if (storage(global).getItem(key(city.id)) !== json) throw new Error('Economic source could not be saved.');
        return source;
    }
    function resetChoice(cityId, global) { storage(global).removeItem(key(cityId)); }
    function text(global, name, params = {}) {
        const result = global.i18n?.t?.('economicSources.' + name, params);
        return result && result !== 'economicSources.' + name ? result : name;
    }
    function describe(row, global) {
        if (!row) return '';
        if (row.sourceId === 'scenario-assumptions') return text(global, 'assumption');
        return text(global, 'evidence', {
            source: row.sourceId === 'scenario-assumptions' ? text(global, 'assumption') : row.sourceName,
            basis: text(global, row.basis), date: row.asOf ? text(global, 'date', { date: row.asOf }) : ''
        }) + (row.scope ? ' · ' + row.scope : '');
    }
    // A rate's source as visible text in `element` (the 3D panel, Plan stats, Settings): "Source:", the
    // source's name linked to its document, its basis and date, and the place the rate is for (its
    // scope). `set` is a price the visitor slid or typed: that price is their assumption, not the source's.
    function renderSource(element, row, global, { set = false } = {}) {
        const document = element.ownerDocument;
        element.replaceChildren(text(global, 'sourceLabel') + ' ');
        if (set || !row || row.sourceId === 'scenario-assumptions') {
            element.append(text(global, set || row ? 'assumption' : 'unavailable'));
            return element;
        }
        let name = document.createTextNode(row.sourceName);
        if (row.sourceUrl) {
            name = document.createElement('a');
            name.className = 'cb-link cb-link--quiet cb-link--external';
            name.href = row.sourceUrl; name.target = '_blank'; name.rel = 'noopener';
            name.textContent = row.sourceName;
        }
        element.append(name, ' · ' + text(global, row.basis) + (row.asOf ? text(global, 'date', { date: row.asOf }) : '')
            + (row.scope ? ' · ' + row.scope : ''));
        return element;
    }
    function open(global) {
        global.document.getElementById('economic-source-settings')?.remove();
        const city = global.CityConfigManager.getCurrentCityConfig(), currency = city.currency.code;
        const t = (name, params) => text(global, name, params);
        const dialog = global.document.createElement('dialog');
        dialog.id = 'economic-source-settings';
        dialog.className = 'cb-dialog cb-dialog--md parcel-source-settings';
        const append = (tag, content, parent, className) => {
            const node = global.document.createElement(tag);
            if (content) node.textContent = content;
            if (className) node.className = className;
            parent.append(node); return node;
        };
        const header = append('div', '', dialog, 'cb-dialog__header');
        const title = append('h2', t('title'), header, 'cb-dialog__title'); title.id = 'economic-source-title';
        dialog.setAttribute('aria-labelledby', title.id);
        const close = append('button', '×', header, 'close-circle-btn'); close.type = 'button';
        close.setAttribute('aria-label', t('close')); close.addEventListener('click', () => dialog.close());
        const body = append('div', '', dialog, 'cb-dialog__body parcel-source-settings__body');
        append('p', t('intro'), body);
        const status = append('p', '', body); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
        let active = null;
        try { active = choiceForCity(city.id, global); } catch (_) { status.textContent = t('invalid'); }
        const rates = global.CityMoney.ratesFor(city, active);
        const list = append('dl', '', body, 'economic-source-list');
        list.setAttribute('aria-label', t('current'));
        for (const metric of Object.keys(contract(global).METRICS)) {
            append('dt', t(metric), list);
            const row = rates[metric];
            const amount = !row ? '' : row.unit === 'share-of-sale'
                ? global.CbFormat.formatPercent(row.amount, { maxFractionDigits: 1 })
                : global.CbFormat.formatMoney(row.amount, row.currency, { maxFractionDigits: 2 }) + (row.unit === 'm2-floor-month' ? t('perMonth') : ' / m²');
            const dd = append('dd', row ? amount + (row.taxIncluded ? ' · ' + t('taxIncluded') : '') : t('unavailable'), list);
            if (row) renderSource(append('span', '', dd, 'economic-source-note'), row, global);
        }
        append('h3', t('manual'), body);
        append('p', t('manualNote', { currency }), body);
        const form = append('form', '', body); form.id = 'economic-source-form';
        const label = append('label', t('name'), form); label.htmlFor = 'economic-source-name';
        const name = append('input', '', form); name.id = label.htmlFor; name.type = 'text'; name.maxLength = 160;
        name.value = active?.name || t('manual'); name.required = true;
        const fields = {};
        for (const [metric, unit] of Object.entries(contract(global).METRICS)) {
            const unitText = { 'm2-land': 'landUnit', 'm2-floor': 'floorUnit', 'm2-floor-month': 'rentUnit', 'share-of-sale': 'taxUnit' }[unit];
            const label = append('label', t(metric) + ' · ' + t(unitText, { currency }), form);
            const field = append('input', '', form); field.id = 'economic-rate-' + metric; label.htmlFor = field.id;
            field.type = 'number'; field.min = '0'; field.step = 'any';
            // The sale tax is typed as a percentage and stored as a share (16 → 0.16).
            field.placeholder = rates[metric]?.amount == null ? '—' : String(unit === 'share-of-sale' ? rates[metric].amount * 100 : rates[metric].amount);
            fields[metric] = field;
        }
        const footer = append('div', '', dialog, 'cb-dialog__footer');
        const use = append('button', t('use'), footer, 'btn btn-primary'); use.type = 'submit'; use.setAttribute('form', form.id);
        const reset = append('button', t('reset'), footer, 'btn'); reset.type = 'button';
        const reload = () => { status.textContent = t('saved'); global.location.reload(); };
        reset.addEventListener('click', () => {
            try { resetChoice(city.id, global); reload(); } catch (_) { status.textContent = t('invalid'); }
        });
        form.addEventListener('submit', event => {
            event.preventDefault();
            try {
                const changed = Object.entries(fields).filter(([, field]) => field.value.trim() !== '');
                const retained = active?.rates.filter(row => !changed.some(([metric]) => metric === row.metric)) || [];
                // A typed construction cost keeps the tax basis of the cost it replaces, as the slider does.
                saveChoice(city, { version: 1, id: 'local-rates', name: name.value, adapter: 'rate-table', url: active?.url,
                    rates: [...retained, ...changed.map(([metric, field]) => ({ metric, unit: contract(global).METRICS[metric],
                        amount: metric === 'saleTax' ? Number(field.value) / 100 : Number(field.value), currency, basis: 'assumption',
                        ...(metric === 'construction' && rates.construction?.taxIncluded ? { taxIncluded: true } : {}) }))] }, global);
                reload();
            } catch (_) { status.textContent = t('invalid'); }
        });
        const importLabel = append('label', t('import'), body); importLabel.htmlFor = 'economic-source-file';
        const file = append('input', '', body); file.id = importLabel.htmlFor; file.type = 'file'; file.accept = '.json,application/json';
        file.addEventListener('change', async () => {
            try {
                const selected = file.files?.[0]; if (!selected) return;
                if (selected.size > 100000) throw new Error('Rate table is too large.');
                saveChoice(city, JSON.parse(await selected.text()), global); reload();
            } catch (_) { status.textContent = t('invalid'); }
        });
        dialog.addEventListener('close', () => dialog.remove());
        global.document.body.append(dialog); dialog.showModal();
        return dialog;
    }
    return Object.freeze({ choiceForCity, saveChoice, resetChoice, describe, renderSource, open });
});
