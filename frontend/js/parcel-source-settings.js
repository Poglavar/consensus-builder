// Browser-owned source choices for the layers a person may point at their own data: parcels and
// buildings (OpenStreetMap stays the default for everything). The portable gateway ID contains only
// public adapter configuration; the backend fetches the URL, never the browser. Every function takes
// a `kind` ('parcel' by default), which picks the storage key, the id prefix, the discover endpoint,
// the URL parameter and the strings.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) {
        root.ParcelSourceSettings = api;
        root.openParcelSourceSettings = () => api.open(root, 'parcel');
        root.openBuildingSourceSettings = () => api.open(root, 'building');
    }
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';
    const TELEGRAM_URL = 'https://t.me/urbangametheory';
    const KINDS = {
        parcel: { storage: 'cb_parcel_source:', idPrefix: 'custom.', idPattern: /^CUSTOM-[0-9a-f]{20}-$/,
            discover: '/parcel-sources/discover', param: 'parcelSource', strings: 'parcelSources', countField: 'parcelCount' },
        building: { storage: 'cb_building_source:', idPrefix: 'building.', idPattern: /^CUSTOM-B-[0-9a-f]{20}-$/,
            discover: '/building-sources/discover', param: 'buildingSource', strings: 'buildingSources', countField: 'buildingCount' }
    };
    const kindOf = kind => KINDS[kind] || KINDS.parcel;
    // Strings whose parcel wording would be wrong for buildings: never borrowed from parcelSources.
    const BUILDING_ONLY = new Set(['title', 'intro', 'url', 'matched', 'levelsOnly', 'noHeights', 'heightField', 'heightUnit', 'metres', 'feet', 'overpass', 'retry']);
    function backend(global) {
        const param = new URLSearchParams(global.location?.search || '').get('backend');
        return String(global.getBackendBase?.() || param || 'https://api.urbangametheory.xyz').replace(/\/+$/, '');
    }
    function storageKey(city, global, kind = 'parcel') { return kindOf(kind).storage + backend(global) + ':' + city; }
    function decodeChoice(sourceId, city, kind = 'parcel') {
        const spec = kindOf(kind);
        try {
            if (typeof sourceId !== 'string' || !sourceId.startsWith(spec.idPrefix)
                || !/^[A-Za-z0-9_-]{1,3400}$/.test(sourceId.slice(spec.idPrefix.length))) return null;
            const encoded = sourceId.slice(spec.idPrefix.length).replace(/-/g, '+').replace(/_/g, '/');
            const json = typeof atob === 'function' ? atob(encoded) : Buffer.from(encoded, 'base64').toString('utf8');
            const value = JSON.parse(json);
            // 'overpass' (an OpenStreetMap mirror) is a building source only; the kind check below holds it there.
            if (!['arcgis', 'wfs', 'ogc-api', 'socrata', 'geojson-snapshot', 'overpass'].includes(value.adapter)) return null;
            if (value.cityIds?.length !== 1 || value.cityIds[0] !== city || !spec.idPattern.test(value.idPrefix)) return null;
            if ((value.kind === 'building') !== (kind === 'building')) return null;
            const url = new URL(value.endpoint);
            if (url.protocol !== 'https:' || url.username || url.password) return null;
            return { ...value, id: sourceId, name: url.hostname + ' (' + value.adapter + ')' };
        } catch (_) { return null; }
    }
    // The key's backend comes from getBackendBase(), which reads the city config, which asks for this
    // choice again. That nested ask gets "no custom choice", so the backend resolves from the city's
    // base config; recursing instead spun every page load that had no ?backend= override.
    let resolvingChoice = false;
    function choiceForCity(city, global, kind = 'parcel') {
        const requested = new URLSearchParams(global.location?.search || '').get(kindOf(kind).param);
        if (requested) return decodeChoice(requested, city, kind);
        if (resolvingChoice) return null;
        resolvingChoice = true;
        try { return decodeChoice(global.localStorage.getItem(storageKey(city, global, kind)) || '', city, kind); }
        catch (_) { return null; }
        finally { resolvingChoice = false; }
    }
    function saveChoice(city, source, global, kind = 'parcel') {
        if (!decodeChoice(source.id, city, kind)) throw new Error('Invalid source choice.');
        global.localStorage.setItem(storageKey(city, global, kind), source.id);
        if (global.localStorage.getItem(storageKey(city, global, kind)) !== source.id) throw new Error('Source choice could not be saved.');
    }
    function recentChecks(city, global, kind = 'parcel') {
        try {
            const value = JSON.parse(global.localStorage.getItem(storageKey(city, global, kind) + ':checks') || '[]');
            return Array.isArray(value) ? value.slice(-10) : [];
        } catch (_) { return []; }
    }
    function recordCheck(city, url, data, global, kind = 'parcel') {
        try {
            const parsed = new URL(url);
            if (parsed.protocol !== 'https:' || parsed.username || parsed.password
                || [...parsed.searchParams.keys()].some(key => /token|key|password|secret|signature|authorization/i.test(key))) return;
            const checks = recentChecks(city, global, kind);
            checks.push({ url: parsed.href, at: new Date().toISOString(), code: data.code || 'verified',
                attempts: Array.isArray(data.attempts) ? data.attempts.map(item => ({ adapter: item.adapter,
                    status: item.status, code: item.error?.code, message: item.error?.message })) : [] });
            global.localStorage.setItem(storageKey(city, global, kind) + ':checks', JSON.stringify(checks.slice(-10)));
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
    function reloadWithChoice(global, sourceId, kind = 'parcel') {
        const url = new URL(global.location.href);
        const param = kindOf(kind).param;
        if (sourceId) url.searchParams.set(param, sourceId); else url.searchParams.delete(param);
        const center = global.map?.getCenter?.();
        if (center && global.map?.getZoom) url.searchParams.set('at', [center.lat, center.lng, global.map.getZoom()].join(','));
        global.location.assign(url.href);
    }
    // What the city uses when the person has chosen nothing.
    function defaultName(city, kind, t) {
        if (kind !== 'building') return city.parcels?.sourceId || city.parcels?.source || city.label;
        const source = city.buildings?.defaultSource || city.buildings?.source || 'gdi';
        return { osm: 'OpenStreetMap', overture: 'Overture Maps', nyc: 'NYC Open Data', gdi: t('defaultGdi', 'Zagreb 3D model (GDI)') }[source] || source;
    }

    function open(global, kind = 'parcel') {
        const spec = kindOf(kind);
        global.document.getElementById('parcel-source-settings')?.remove();
        const city = global.CityConfigManager.getCurrentCityConfig();
        // Building strings fall back to the parcel ones where the wording is the same.
        const t = (key, fallback, params = {}) => {
            for (const space of [spec.strings, 'parcelSources']) {
                const full = space + '.' + key, translated = global.i18n?.t?.(full, params);
                if (translated && translated !== full) return translated;
                if (space === spec.strings && kind === 'building' && BUILDING_ONLY.has(key)) break;
            }
            return fallback.replace(/\{\{(\w+)\}\}/g, (_, key) => params[key] ?? '');
        };
        const dialog = global.document.createElement('dialog');
        dialog.id = 'parcel-source-settings'; dialog.className = 'parcel-source-settings';
        const element = (tag, text, parent = dialog) => {
            const node = global.document.createElement(tag); if (text) node.textContent = text; parent.append(node); return node;
        };
        const building = kind === 'building';
        const title = element('h2', building ? t('title', 'Choose a building source') : t('title', 'Choose a parcel source'));
        title.id = 'parcel-source-settings-title';
        dialog.setAttribute('aria-labelledby', title.id);
        element('p', building
            ? t('intro', 'Add a public HTTPS URL of building footprints for this city, or of an OpenStreetMap mirror (an Overpass API address ending in /interpreter). We try each supported format and read a height or storey field when it has one; other heights are estimated.')
            : t('intro', 'Add a public HTTPS parcel URL for this city. We try each supported format and check that it can return complete parcel boundaries.'));
        const active = choiceForCity(city.id, global, kind);
        element('p', t('current', 'Current source: {{source}}', { source: active?.name || defaultName(city, kind, t) }));
        const form = element('form');
        const label = element('label', building ? t('url', 'Building source URL') : t('url', 'Parcel source URL'), form); label.htmlFor = 'parcel-source-url';
        const input = element('input', '', form); input.id = 'parcel-source-url'; input.type = 'url'; input.required = true;
        input.maxLength = 2000;
        input.autocomplete = 'url'; input.placeholder = 'https://'; input.value = active?.endpoint || '';
        const check = element('button', t('check', 'Check URL'), form); check.type = 'submit'; check.className = 'btn';
        const result = element('div'); result.className = 'parcel-source-settings__result'; result.setAttribute('role', 'status'); result.setAttribute('aria-live', 'polite');
        const checks = recentChecks(city.id, global, kind);
        if (checks.length) {
            const history = element('details'); element('summary', t('recent', 'Recent source checks'), history);
            for (const item of checks.slice().reverse()) {
                element('p', String(item.at || '') + ' · ' + String(item.url || '') + ' · ' + String(item.code || ''), history);
                for (const attempt of item.attempts || []) element('p', String(attempt.adapter || '') + ': ' + String(attempt.message || attempt.status || ''), history);
            }
        }
        let candidate = null, controller = null;
        // Building sources: the unit the person picked for the height field, sent with a re-check.
        let chosenUnit = null;
        input.addEventListener('input', () => { chosenUnit = null; });
        const use = element('button', t('use', 'Use this source')); use.type = 'button'; use.className = 'btn btn-primary'; use.hidden = true;
        use.addEventListener('click', () => {
            try { saveChoice(city.id, candidate, global, kind); reloadWithChoice(global, candidate.id, kind); }
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
                const response = await global.fetch(backend(global) + spec.discover, { method: 'POST',
                    headers: { 'Content-Type': 'application/json' }, cache: 'no-store', signal: controller.signal,
                    body: JSON.stringify({ url: input.value, city: city.id, bbox: smallProbeBounds(global.map), heightUnit: chosenUnit || undefined }) });
                const data = await response.json();
                recordCheck(city.id, input.value, data, global, kind);
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
                result.textContent = building
                    ? t('matched', 'Adapter found: {{adapter}}. {{count}} buildings in the test area. Coverage outside this area depends on the source.', { adapter: candidate.adapter, count: data[spec.countField] })
                    : t('matched', 'Adapter found: {{adapter}}. {{count}} parcels in the test area. Coverage outside this area depends on the source.', { adapter: candidate.adapter, count: data[spec.countField] });
                if (building) describeHeights(candidate);
                use.hidden = false;
            } catch (error) {
                recordCheck(city.id, input.value, { code: 'parcel-source-unavailable' }, global, kind);
                result.textContent = t('checkFailed', 'Could not finish checking the URL. Check your connection and try again.');
            }
            finally { clearTimeout(timer); check.disabled = false; input.disabled = false; }
        });
        // Which fields give the heights, and in what unit: names rarely say (NYC's HEIGHT_ROOF is feet).
        function describeHeights(source) {
            if (source.adapter === 'overpass') {
                element('p', t('overpass', 'An OpenStreetMap mirror: heights come from OpenStreetMap where mapped and are estimated elsewhere.'), result);
                return;
            }
            if (!source.heightField) {
                element('p', source.levelsField
                    ? t('levelsOnly', 'Heights from the storey field {{field}}, 3 m per storey.', { field: source.levelsField })
                    : t('noHeights', 'This source has no height field; heights are estimated.'), result);
                return;
            }
            const line = element('p', t('heightField', 'Heights from the field {{field}}, in', { field: source.heightField }) + ' ', result);
            const unit = element('select', '', line);
            unit.setAttribute('aria-label', t('heightUnit', 'Height unit'));
            for (const [value, text] of [['m', t('metres', 'metres')], ['ft', t('feet', 'feet')]]) {
                const option = element('option', text, unit); option.value = value;
            }
            unit.value = source.heightUnit || 'm';
            unit.addEventListener('change', () => { chosenUnit = unit.value; form.requestSubmit(); });
        }
        const reset = element('button', t('default', 'Use the city default')); reset.type = 'button'; reset.className = 'btn btn-secondary';
        reset.addEventListener('click', () => {
            try { global.localStorage.removeItem(storageKey(city.id, global, kind)); reloadWithChoice(global, null, kind); }
            catch (_) { result.textContent = t('storageFailed', 'The source choice could not be saved in this browser.'); }
        });
        const close = element('button', t('close', 'Close')); close.type = 'button'; close.className = 'btn btn-secondary';
        close.addEventListener('click', () => dialog.close());
        dialog.addEventListener('close', () => { controller?.abort(); dialog.remove(); });
        global.document.body.append(dialog); dialog.showModal(); input.focus();
        return dialog;
    }
    // The failure banners, one per kind. The building one waits in a corner stack; the parcel one is
    // `centred` — mounted on the body, outside the stack's banner layer, so css/parcel-sources.css can
    // put it mid-screen yet under dialogs. Each says what failed and offers Retry, a source of the
    // person's own, and Dismiss.
    const BANNERS = {
        parcel: { id: 'parcel-source-status', centred: true, retry: ['parcelSources.retry', 'Retry parcel source'], choose: ['parcelSources.title', 'Choose a parcel source'],
            defaultRetry: global => global.fetchParcelDataReported?.(undefined, 'source status retry') },
        building: { id: 'building-source-status', retry: ['buildingSources.retry', 'Retry buildings'], choose: ['buildingSources.title', 'Choose a building source'],
            defaultRetry: () => {} }
    };
    function reportFailure(global, message, kind = 'parcel', retry = null) {
        const doc = global.document;
        if (!doc) return;
        const spec = BANNERS[kind] || BANNERS.parcel;
        let banner = doc.getElementById(spec.id);
        if (!banner) {
            let stack = spec.centred ? doc.body : doc.getElementById('source-status-stack');
            if (!stack) { stack = doc.createElement('div'); stack.id = 'source-status-stack'; stack.className = 'source-status-stack'; doc.body.append(stack); }
            banner = doc.createElement('aside'); banner.id = spec.id;
            banner.className = 'source-status'; banner.setAttribute('role', 'status');
            const text = doc.createElement('p'); text.className = 'source-status__message'; banner.append(text);
            const button = ([key, fallback], action) => {
                const node = doc.createElement('button'); node.type = 'button'; node.className = 'btn btn-secondary';
                const value = global.i18n?.t?.(key); node.textContent = value && value !== key ? value : fallback;
                node.addEventListener('click', action); banner.append(node);
            };
            button(spec.retry, () => { const again = banner.retry || spec.defaultRetry; banner.remove(); again(global); });
            button(spec.choose, () => open(global, kind));
            button(['parcelSources.dismiss', 'Dismiss source warning'], () => banner.remove());
            stack.append(banner);
        }
        banner.querySelector('p').textContent = message;
        if (typeof retry === 'function') banner.retry = retry;
    }
    function clearFailure(global, kind = 'parcel') { global.document?.getElementById((BANNERS[kind] || BANNERS.parcel).id)?.remove(); }
    // The building banner's text: whose data failed, and when asking again is worth it.
    // `origin`: 'custom' (the person's own source), 'osm' (OpenStreetMap) or anything else.
    function buildingFailureMessage(global, { retryAfter = null, origin = 'osm' } = {}) {
        const t = (key, fallback, params = {}) => {
            const full = 'buildingSources.' + key, value = global.i18n?.t?.(full, params);
            return (value && value !== full ? value : fallback).replace(/\{\{(\w+)\}\}/g, (_, name) => params[name] ?? '');
        };
        const minutes = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.max(1, Math.ceil(retryAfter / 60)) : null;
        const head = origin === 'custom'
            ? t('customUnavailable', 'Your building source did not answer, so buildings could not be loaded here.')
            : origin === 'osm'
                ? t('osmUnavailable', 'Building data could not be loaded right now: the OpenStreetMap server is busy.')
                : t('unavailable', 'Building data could not be loaded right now.');
        const tail = minutes
            ? t('tryAgainIn', 'Try again in about {{minutes}} min, or plug in your own mirror or source.', { minutes })
            : t('tryAgainLater', 'Try again later, or plug in your own mirror or source.');
        return head + ' ' + tail;
    }
    return Object.freeze({ TELEGRAM_URL, KINDS, defaultName, decodeChoice, choiceForCity, saveChoice, recentChecks, recordCheck, smallProbeBounds, storageKey, open, reportFailure, clearFailure, buildingFailureMessage });
});
