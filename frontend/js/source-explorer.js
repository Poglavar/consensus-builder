// Read-only developer reference. Every displayed registration comes from the selected backend.
(function attachSourceExplorer(root) {
    'use strict';
    function backendBase(location, savedOverride = null) {
        const local = ['localhost', '127.0.0.1', '0.0.0.0'].includes(location.hostname) || location.protocol === 'file:';
        const override = local && (new URLSearchParams(location.search).get('backend') || savedOverride);
        if (override) {
            const url = new URL(override);
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid backend URL.');
            return url.href.replace(/\/+$/, '');
        }
        return local ? `http://${location.hostname === '127.0.0.1' ? '127.0.0.1' : 'localhost'}:3000` : 'https://api.urbangametheory.xyz';
    }
    async function loadMetadata(base, fetchImpl) {
        async function read(path) {
            const response = await fetchImpl(base + path, { signal: AbortSignal.timeout(15000) });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return response.json();
        }
        const [catalogue, contracts] = await Promise.all([read('/source-system'), read('/source-system/contracts')]);
        if (catalogue?.schema !== 'source-catalogue/v1' || !Array.isArray(catalogue.abstractions)
            || contracts?.schema !== 'source-contracts/v1' || !Array.isArray(contracts.abstractions)) throw new Error('Invalid source metadata.');
        return { catalogue, contracts };
    }
    function operationNames(adapter) {
        return new Set([...(adapter.implementations || []).flatMap(implementation => implementation.required || []),
            ...(adapter.required || adapter.contract?.required || []),
            ...(adapter.contract?.optional || []), ...(adapter.contract?.optionalMethods || [])]);
    }
    function operationEntries(adapter, contract) {
        const supported = operationNames(adapter);
        return Object.entries({ ...contract?.operations, ...adapter.contract?.operations })
            .filter(([name]) => supported.has(name));
    }
    const api = Object.freeze({ backendBase, loadMetadata, operationNames, operationEntries });
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (!root?.document) return;
    root.SourceExplorer = api;
    const document = root.document;
    const byId = id => document.getElementById(id);
    const text = (key, values = {}) => root.i18n?.t('sourceSystem.' + key, values) || key;
    const json = value => JSON.stringify(value, null, 2);
    const node = (tag, content, className) => {
        const out = document.createElement(tag);
        if (content !== undefined) out.textContent = content;
        if (className) out.className = className;
        return out;
    };
    let data = null;
    let base = '';
    let lastFailure = null;
    let loading = false;
    const familySelect = byId('source-family');
    const adapterSelect = byId('source-adapter');
    const sourceSelect = byId('source-config');
    const status = byId('source-status');
    function options(select, values, preferred) {
        select.replaceChildren(...values.map(value => {
            const option = node('option', value.label || value.id);
            option.value = value.id;
            return option;
        }));
        select.disabled = !values.length;
        if (values.some(value => value.id === preferred)) select.value = preferred;
    }
    function updateStatus() {
        status.classList.toggle('source-explorer__failure', !!lastFailure);
        if (loading) status.textContent = text('loading');
        else if (lastFailure) status.textContent = text('loadFailed', { error: lastFailure });
        else if (data) status.textContent = text('ready', {
            families: data.catalogue.abstractions.length,
            sources: data.catalogue.abstractions.reduce((count, family) => count + family.sources.length, 0)
        });
    }
    function currentFamily() { return data?.catalogue.abstractions.find(family => family.id === familySelect.value); }
    function renderSource() {
        const family = currentFamily();
        const source = family?.sources.find(source => source.id === sourceSelect.value);
        const example = byId('source-config-json');
        example.hidden = !source;
        example.textContent = source ? json(source) : '';
        byId('source-config-note').textContent = text(source ? 'configNote' : family?.registered === false ? 'browserSources' : 'noSources');
    }
    function renderAdapter(preferredSource) {
        const family = currentFamily();
        if (!family) return;
        const adapter = family.adapters.find(adapter => adapter.id === adapterSelect.value);
        if (!adapter) return;
        const sources = family.sources.filter(source => source.adapter === adapter.id);
        options(sourceSelect, sources, preferredSource);
        sourceSelect.hidden = !sources.length;
        const configSchema = adapter.configSchema || adapter.contract?.configSchema;
        const example = adapter.example || adapter.contract?.example;
        const preparation = adapter.preparation || adapter.contract?.preparation;
        byId('source-preparation').textContent = Array.isArray(preparation) ? preparation.join('\n') : preparation || '';
        byId('source-preparation').hidden = !preparation;
        byId('source-adapter-spec').hidden = !configSchema && !example && !preparation;
        byId('source-config-schema-section').hidden = !configSchema;
        byId('source-example-section').hidden = !example;
        byId('source-config-schema-json').textContent = configSchema ? json(configSchema) : '';
        byId('source-example-json').textContent = example ? json(example) : '';
        const runtimes = new Set((adapter.implementations || []).map(implementation => implementation.runtime));
        const runtime = runtimes.size > 1 ? 'mixed' : [...runtimes][0] || adapter.runtime || family.runtime;
        byId('source-runtime').textContent = text(family.registered === false ? 'browserContract'
            : runtime === 'browser' ? 'browserRegistry' : runtime === 'shared' ? 'sharedRegistry'
                : runtime === 'mixed' ? 'mixedRegistry' : 'serverRegistry');
        byId('source-custom').textContent = text(adapter.custom ? 'customAllowed' : 'configuredOnly');
        byId('source-configuration').textContent = adapter.contract?.configuration || '';
        const contract = family.contract || data.contracts.abstractions.find(item => item.id === family.id);
        const operationArea = byId('source-operations');
        const operations = operationEntries(adapter, contract);
        operationArea.replaceChildren();
        if (!operations.length) operationArea.append(node('p', text('noContract'), 'source-explorer__note'));
        for (const [name, operation] of operations) {
            const section = node('article', undefined, 'source-explorer__operation');
            section.append(node('h3', name));
            section.append(node('p', operation.semantics));
            section.append(node('p', text('arguments') + ': ' + (operation.argumentList || []).join(', '), 'source-explorer__note'));
            section.append(node('p', text('runtimeType') + ': ' + operation.runtimeType, 'source-explorer__note'));
            const details = node('details');
            details.open = operations.length === 1;
            details.append(node('summary', text('schemas')));
            const schemas = node('div', undefined, 'source-explorer__schemas');
            for (const [label, value] of [['input', operation.input], ['output', operation.outputSchema ?? operation.output]]) {
                const column = node('div');
                column.append(node('h4', text(label)));
                const pre = node('pre', json(value));
                pre.tabIndex = 0;
                column.append(pre);
                schemas.append(column);
            }
            details.append(schemas);
            section.append(details);
            operationArea.append(section);
        }
        const params = new URLSearchParams(root.location.search);
        params.set('abstraction', family.id);
        params.set('adapter', adapter.id);
        root.history.replaceState(null, '', '?' + params.toString());
        renderSource();
    }
    function renderFamily(preferredAdapter, preferredSource) {
        const family = currentFamily();
        if (!family) return;
        options(adapterSelect, family.adapters, preferredAdapter);
        byId('source-contract-link').href = base + '/source-system/contracts/' + encodeURIComponent(family.id);
        renderAdapter(preferredSource);
    }
    async function load() {
        if (loading) return;
        loading = true;
        lastFailure = null;
        updateStatus();
        byId('source-retry').hidden = true;
        byId('source-content').hidden = true;
        byId('source-download').disabled = true;
        try {
            let saved;
            try { saved = root.localStorage.getItem('cb_dev_backend_base'); } catch (_) { }
            base = backendBase(root.location, saved);
            byId('source-api-base').textContent = base;
            const mapUrl = new URL('/', root.location.href);
            if (new URLSearchParams(root.location.search).has('backend')) mapUrl.searchParams.set('backend', base);
            byId('source-back-link').href = mapUrl.href;
            data = await loadMetadata(base, (...args) => root.fetch(...args));
            const params = new URLSearchParams(root.location.search);
            options(familySelect, data.catalogue.abstractions, params.get('abstraction'));
            renderFamily(params.get('adapter'), params.get('source'));
            byId('source-wrapper-schema').href = base + '/source-system/schemas/source';
            byId('source-operations-schema').href = base + '/source-system/schemas/operations';
            byId('source-content').hidden = false;
            byId('source-download').disabled = false;
        } catch (error) {
            data = null;
            lastFailure = error.message;
            byId('source-retry').hidden = false;
        } finally {
            loading = false;
            updateStatus();
        }
    }
    function translate() {
        byId('source-language').value = root.i18n?.getLanguage() || 'en';
        byId('source-language').setAttribute('aria-label', text('language'));
        document.title = text('title') + ' · Consensus Builder';
        updateStatus();
        if (data) renderFamily(adapterSelect.value, sourceSelect.value);
    }
    familySelect.addEventListener('change', () => renderFamily());
    adapterSelect.addEventListener('change', () => renderAdapter());
    sourceSelect.addEventListener('change', renderSource);
    byId('source-retry').addEventListener('click', load);
    byId('source-language').addEventListener('change', event => root.i18n?.setLanguage(event.target.value));
    byId('source-download').addEventListener('click', () => {
        if (!data) return;
        const url = URL.createObjectURL(new Blob([json(data.contracts)], { type: 'application/json' }));
        const link = node('a');
        link.href = url;
        link.download = 'source-contracts.v1.json';
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 0);
    });
    root.addEventListener('i18n:translationsLoaded', translate);
    const backParams = new URLSearchParams(root.location.search);
    for (const key of [...backParams.keys()]) if (!['backend', 'lang'].includes(key)) backParams.delete(key);
    byId('source-back-link').href = '/' + (backParams.size ? '?' + backParams.toString() : '');
    Promise.resolve(root.i18n?.translationsReady || root.i18n?.ready).then(() => { translate(); return load(); });
})(typeof window !== 'undefined' ? window : null);
