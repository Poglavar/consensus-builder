// Browser-owned source choices. The portable gateway ID contains only public adapter configuration.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) { root.ParcelSourceSettings = api; root.openParcelSourceSettings = () => api.open(root); }
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';
    const TELEGRAM_URL = 'https://t.me/urbangametheory';
    function backend(global) {
        const param = new URLSearchParams(global.location?.search || '').get('backend');
        return String(global.getBackendBase?.() || param || 'https://api.urbangametheory.xyz').replace(/\/+$/, '');
    }
    function storageKey(city, global) { return 'cb_parcel_source:' + backend(global) + ':' + city; }
    function decodeChoice(sourceId, city) {
        try {
            if (!/^custom\.[A-Za-z0-9_-]{1,3400}$/.test(sourceId)) return null;
            const encoded = sourceId.slice(7).replace(/-/g, '+').replace(/_/g, '/');
            const json = typeof atob === 'function' ? atob(encoded) : Buffer.from(encoded, 'base64').toString('utf8');
            const value = JSON.parse(json);
            if (!['arcgis', 'wfs', 'ogc-api', 'socrata', 'geojson-snapshot'].includes(value.adapter)) return null;
            if (value.cityIds?.length !== 1 || value.cityIds[0] !== city || !/^CUSTOM-[0-9a-f]{20}-$/.test(value.idPrefix)) return null;
            const url = new URL(value.endpoint);
            if (url.protocol !== 'https:' || url.username || url.password) return null;
            return { ...value, id: sourceId, name: url.hostname + ' (' + value.adapter + ')' };
        } catch (_) { return null; }
    }
    // The key's backend comes from getBackendBase(), which reads the city config, which asks for this
    // choice again. That nested ask gets "no custom choice", so the backend resolves from the city's
    // base config; recursing instead spun every page load that had no ?backend= override.
    let resolvingChoice = false;
    function choiceForCity(city, global) {
        const requested = new URLSearchParams(global.location?.search || '').get('parcelSource');
        if (requested) return decodeChoice(requested, city);
        if (resolvingChoice) return null;
        resolvingChoice = true;
        try { return decodeChoice(global.localStorage.getItem(storageKey(city, global)) || '', city); }
        catch (_) { return null; }
        finally { resolvingChoice = false; }
    }
    function saveChoice(city, source, global) {
        if (!decodeChoice(source.id, city)) throw new Error('Invalid source choice.');
        global.localStorage.setItem(storageKey(city, global), source.id);
        if (global.localStorage.getItem(storageKey(city, global)) !== source.id) throw new Error('Source choice could not be saved.');
    }
    function recentChecks(city, global) {
        try {
            const value = JSON.parse(global.localStorage.getItem(storageKey(city, global) + ':checks') || '[]');
            return Array.isArray(value) ? value.slice(-10) : [];
        } catch (_) { return []; }
    }
    function recordCheck(city, url, data, global) {
        try {
            const parsed = new URL(url);
            if (parsed.protocol !== 'https:' || parsed.username || parsed.password
                || [...parsed.searchParams.keys()].some(key => /token|key|password|secret|signature|authorization/i.test(key))) return;
            const checks = recentChecks(city, global);
            checks.push({ url: parsed.href, at: new Date().toISOString(), code: data.code || 'verified',
                attempts: Array.isArray(data.attempts) ? data.attempts.map(item => ({ adapter: item.adapter,
                    status: item.status, code: item.error?.code, message: item.error?.message })) : [] });
            global.localStorage.setItem(storageKey(city, global) + ':checks', JSON.stringify(checks.slice(-10)));
        } catch (_) { /* Source availability does not depend on optional audit storage. */ }
    }
    function smallProbeBounds(map) {
        const center = map.getCenter();
        if (!Number.isFinite(center.lat) || !Number.isFinite(center.lng)) throw new Error('Invalid map center.');
        const latitude = Math.max(-89.9, Math.min(89.9, center.lat));
        const longitude = ((center.lng + 180) % 360 + 360) % 360 - 180;
        const halfLat = 0.0005, halfLon = Math.min(0.05, halfLat / Math.max(0.01, Math.cos(latitude * Math.PI / 180)));
        return [Math.max(-180, longitude - halfLon), latitude - halfLat, Math.min(180, longitude + halfLon), latitude + halfLat];
    }
    function reloadWithChoice(global, sourceId) {
        const url = new URL(global.location.href);
        if (sourceId) url.searchParams.set('parcelSource', sourceId); else url.searchParams.delete('parcelSource');
        const center = global.map?.getCenter?.();
        if (center && global.map?.getZoom) url.searchParams.set('at', [center.lat, center.lng, global.map.getZoom()].join(','));
        global.location.assign(url.href);
    }
    function open(global) {
        global.document.getElementById('parcel-source-settings')?.remove();
        const city = global.CityConfigManager.getCurrentCityConfig();
        const t = (key, fallback, params = {}) => {
            const full = 'parcelSources.' + key, translated = global.i18n?.t?.(full, params);
            return translated && translated !== full ? translated : fallback.replace(/\{\{(\w+)\}\}/g, (_, key) => params[key] ?? '');
        };
        const dialog = global.document.createElement('dialog');
        dialog.id = 'parcel-source-settings'; dialog.className = 'parcel-source-settings';
        const element = (tag, text, parent = dialog) => {
            const node = global.document.createElement(tag); if (text) node.textContent = text; parent.append(node); return node;
        };
        const title = element('h2', t('title', 'Choose a parcel source')); title.id = 'parcel-source-settings-title';
        dialog.setAttribute('aria-labelledby', title.id);
        element('p', t('intro', 'Add a public HTTPS parcel URL for this city. We try each supported format and check that it can return complete parcel boundaries.'));
        const active = choiceForCity(city.id, global);
        element('p', t('current', 'Current source: {{source}}', { source: active?.name || city.parcels?.sourceId || city.parcels?.source || city.label }));
        const form = element('form');
        const label = element('label', t('url', 'Parcel source URL'), form); label.htmlFor = 'parcel-source-url';
        const input = element('input', '', form); input.id = 'parcel-source-url'; input.type = 'url'; input.required = true;
        input.maxLength = 2000;
        input.autocomplete = 'url'; input.placeholder = 'https://'; input.value = active?.endpoint || '';
        const check = element('button', t('check', 'Check URL'), form); check.type = 'submit'; check.className = 'btn';
        const result = element('div'); result.className = 'parcel-source-settings__result'; result.setAttribute('role', 'status'); result.setAttribute('aria-live', 'polite');
        const checks = recentChecks(city.id, global);
        if (checks.length) {
            const history = element('details'); element('summary', t('recent', 'Recent source checks'), history);
            for (const item of checks.slice().reverse()) {
                element('p', String(item.at || '') + ' · ' + String(item.url || '') + ' · ' + String(item.code || ''), history);
                for (const attempt of item.attempts || []) element('p', String(attempt.adapter || '') + ': ' + String(attempt.message || attempt.status || ''), history);
            }
        }
        let candidate = null, controller = null;
        const use = element('button', t('use', 'Use this source')); use.type = 'button'; use.className = 'btn'; use.hidden = true;
        use.addEventListener('click', () => {
            try { saveChoice(city.id, candidate, global); reloadWithChoice(global, candidate.id); }
            catch (_) { result.textContent = t('storageFailed', 'The source choice could not be saved in this browser.'); }
        });
        const alternatives = element('div'); alternatives.hidden = true;
        element('p', t('noAdapter', 'No available adapter.'), alternatives);
        const options = element('ol', '', alternatives);
        const conform = element('li', t('conform', 'Conform your source so it can be read by one of the adapters. '), options);
        const formats = element('a', t('formats', 'See the source formats we understand'), conform);
        formats.href = 'parcel-source-formats.html'; formats.target = '_blank'; formats.rel = 'noopener noreferrer';
        const request = element('li', t('request', 'Ask us to add another adapter, which we sometimes do. '), options);
        const telegram = element('a', t('telegram', 'Telegram group'), request);
        telegram.href = TELEGRAM_URL; telegram.target = '_blank'; telegram.rel = 'noopener noreferrer';
        form.addEventListener('submit', async event => {
            event.preventDefault(); candidate = null; use.hidden = true; alternatives.hidden = true;
            check.disabled = true; input.disabled = true; result.textContent = t('checking', 'Checking supported adapters…');
            controller?.abort(); controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 90000);
            try {
                const response = await global.fetch(backend(global) + '/parcel-sources/discover', { method: 'POST',
                    headers: { 'Content-Type': 'application/json' }, cache: 'no-store', signal: controller.signal,
                    body: JSON.stringify({ url: input.value, city: city.id, bbox: smallProbeBounds(global.map) }) });
                const data = await response.json();
                recordCheck(city.id, input.value, data, global);
                if (!response.ok) {
                    const error = Object.assign(new Error(data.error || 'Source check failed.'), data, { status: response.status });
                    if (error.code === 'no-available-adapter') { result.textContent = ''; alternatives.hidden = false; }
                    else result.textContent = error.code === 'invalid-source-url'
                        ? t('invalidUrl', 'Use a public HTTPS URL without credentials or access keys.')
                        : global.ParcelSourceHealth?.describeFailure?.(error, { offline: global.navigator?.onLine === false, translate: global.i18n?.t?.bind(global.i18n) }) || error.message;
                    if (Array.isArray(data.attempts)) element('p', t('attempts', 'Tried: {{adapters}}', { adapters: data.attempts.map(item => item.adapter).join(', ') }), result);
                    for (const attempt of data.attempts || []) {
                        if (attempt.error?.message) element('p', attempt.adapter + ': ' + attempt.error.message, result);
                    }
                    return;
                }
                candidate = data.source;
                result.textContent = t('matched', 'Adapter found: {{adapter}}. {{count}} parcels in the test area. Coverage outside this area depends on the source.', { adapter: candidate.adapter, count: data.parcelCount });
                use.hidden = false;
            } catch (error) {
                recordCheck(city.id, input.value, { code: 'parcel-source-unavailable' }, global);
                result.textContent = t('checkFailed', 'Could not finish checking the URL. Check your connection and try again.');
            }
            finally { clearTimeout(timer); check.disabled = false; input.disabled = false; }
        });
        const reset = element('button', t('default', 'Use the city default')); reset.type = 'button'; reset.className = 'btn btn-secondary';
        reset.addEventListener('click', () => {
            try { global.localStorage.removeItem(storageKey(city.id, global)); reloadWithChoice(global, null); }
            catch (_) { result.textContent = t('storageFailed', 'The source choice could not be saved in this browser.'); }
        });
        const close = element('button', t('close', 'Close')); close.type = 'button'; close.className = 'btn btn-secondary';
        close.addEventListener('click', () => dialog.close());
        dialog.addEventListener('close', () => { controller?.abort(); dialog.remove(); });
        global.document.body.append(dialog); dialog.showModal(); input.focus();
        return dialog;
    }
    function reportFailure(global, message) {
        let banner = global.document?.getElementById('parcel-source-status');
        if (!global.document) return;
        if (!banner) {
            banner = global.document.createElement('aside'); banner.id = 'parcel-source-status';
            banner.className = 'parcel-source-status'; banner.setAttribute('role', 'status');
            const text = global.document.createElement('p'); text.className = 'parcel-source-status__message'; banner.append(text);
            const button = (key, fallback, action) => {
                const node = global.document.createElement('button'); node.type = 'button'; node.className = 'btn btn-secondary';
                const value = global.i18n?.t?.('parcelSources.' + key); node.textContent = value && value !== 'parcelSources.' + key ? value : fallback;
                node.addEventListener('click', action); banner.append(node);
            };
            button('retry', 'Retry parcel source', () => global.fetchParcelDataReported?.(undefined, 'source status retry'));
            button('title', 'Choose a parcel source', () => open(global));
            button('dismiss', 'Dismiss source warning', () => banner.remove());
            global.document.body.append(banner);
        }
        banner.querySelector('p').textContent = message;
    }
    function clearFailure(global) { global.document?.getElementById('parcel-source-status')?.remove(); }
    return Object.freeze({ TELEGRAM_URL, decodeChoice, choiceForCity, saveChoice, recentChecks, recordCheck, smallProbeBounds, storageKey, open, reportFailure, clearFailure });
});
