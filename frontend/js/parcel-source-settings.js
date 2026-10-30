// Browser-owned source choices for the layers a person may point at their own data: parcels, buildings and
// imagery (OpenStreetMap stays the default for everything). The portable gateway ID contains only
// public adapter configuration. Every function takes a `kind` ('parcel' by default), which picks the
// storage key, the id prefix, the discover endpoint, the URL parameter and the strings.
// Parcels and imagery are one choice each, applied by a reload. Buildings are an ordered list
// (source-list.js): the dialog's building kind is the list editor, saved at once with no reload, and
// the same list renderer serves the B-key dialog (building-layers-dialog.js).
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) {
        root.ParcelSourceSettings = api;
        root.openParcelSourceSettings = () => api.open(root, 'parcel');
        root.openBuildingSourceSettings = () => api.open(root, 'building');
        root.openImagerySourceSettings = () => api.open(root, 'imagery');
    }
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';
    const TELEGRAM_URL = 'https://t.me/urbangametheory';
    const KINDS = {
        parcel: { storage: 'cb_parcel_source:', idPrefix: 'custom.', idPattern: /^CUSTOM-[0-9a-f]{20}-$/,
            discover: '/parcel-sources/discover', param: 'parcelSource', strings: 'parcelSources', countField: 'parcelCount' },
        // Buildings keep a storage key only for the recent-checks history; the list is source-list.js's.
        building: { storage: 'cb_building_source:', idPrefix: 'building.', idPattern: /^CUSTOM-B-[0-9a-f]{20}-$/,
            discover: '/building-sources/discover', strings: 'buildingSources', countField: 'buildingCount' },
        imagery: { storage: 'cb_imagery_source:', idPrefix: 'imagery.', idPattern: /^CUSTOM-I-[0-9a-f]{20}-$/,
            discover: '/imagery-sources/discover', param: 'imagerySource', strings: 'imagerySources' }
    };
    const kindOf = kind => KINDS[kind] || KINDS.parcel;
    // Strings whose parcel wording would be wrong for buildings: never borrowed from parcelSources.
    const BUILDING_ONLY = new Set(['title', 'intro', 'url', 'matched', 'levelsOnly', 'noHeights', 'heightField', 'heightUnit', 'metres', 'feet', 'overpass', 'retry', 'add']);
    function backend(global) {
        const param = new URLSearchParams(global.location?.search || '').get('backend');
        return String(global.getBackendBase?.() || param || 'https://api.urbangametheory.xyz').replace(/\/+$/, '');
    }
    function storage(global) { return global.BrowserWorkspace?.storage || global.localStorage; }
    function storageKey(city, global, kind = 'parcel') { return kindOf(kind).storage + backend(global) + ':' + city; }
    function decodeChoice(sourceId, city, kind = 'parcel') {
        const spec = kindOf(kind);
        if (kind === 'imagery') {
            const imagery = typeof window !== 'undefined' ? window.ImagerySource : require('./imagery-source.js');
            return imagery?.decode(sourceId, city) || null;
        }
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
    // The single choice of a parcel or imagery source (buildings have a list: source-list.js).
    function choiceForCity(city, global, kind = 'parcel') {
        const requested = new URLSearchParams(global.location?.search || '').get(kindOf(kind).param);
        if (requested) return decodeChoice(requested, city, kind);
        if (resolvingChoice) return null;
        resolvingChoice = true;
        try { return decodeChoice(storage(global).getItem(storageKey(city, global, kind)) || '', city, kind); }
        catch (_) { return null; }
        finally { resolvingChoice = false; }
    }
    function saveChoice(city, source, global, kind = 'parcel') {
        if (!decodeChoice(source.id, city, kind)) throw new Error('Invalid source choice.');
        storage(global).setItem(storageKey(city, global, kind), source.id);
        if (storage(global).getItem(storageKey(city, global, kind)) !== source.id) throw new Error('Source choice could not be saved.');
    }
    function recentChecks(city, global, kind = 'parcel') {
        try {
            const value = JSON.parse(storage(global).getItem(storageKey(city, global, kind) + ':checks') || '[]');
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
            storage(global).setItem(storageKey(city, global, kind) + ':checks', JSON.stringify(checks.slice(-10)));
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
    // What the city uses when the person has chosen nothing (parcels and imagery).
    function defaultName(city, kind, t) {
        if (kind === 'imagery') return t('standard', 'Standard base map');
        return city.parcels?.sourceId || city.parcels?.source || city.label;
    }
    // A kind's strings. Building strings fall back to the parcel ones where the wording is the same.
    function translator(global, kind) {
        const spec = kindOf(kind);
        return (key, fallback, params = {}) => {
            for (const space of [spec.strings, 'parcelSources']) {
                const full = space + '.' + key, translated = global.i18n?.t?.(full, params);
                if (translated && translated !== full) return translated;
                if (space === spec.strings && (kind === 'building' && BUILDING_ONLY.has(key) || kind === 'imagery' && ['title', 'intro', 'url', 'matched', 'retry', 'default', 'noAdapter'].includes(key))) break;
            }
            return fallback.replace(/\{\{(\w+)\}\}/g, (_, key) => params[key] ?? '');
        };
    }

    // One edit of a source list ([{ id, name, use, outline, city }], effective order), as a new list.
    // `action`: 'use' and 'outline' flip that switch, 'up' and 'down' move the source, 'remove' drops a
    // source the person added. One source always stays in use; Outline is for a source not in use,
    // so turning Use on clears it.
    function editSourceList(list, action, id) {
        const entries = (list || []).map(entry => ({ ...entry }));
        const index = entries.findIndex(entry => entry.id === id);
        if (index < 0) return entries;
        const entry = entries[index];
        const lastInUse = entry.use && entries.filter(item => item.use).length === 1;
        const swap = other => { [entries[index], entries[other]] = [entries[other], entries[index]]; };
        if (action === 'use' && !lastInUse) { entry.use = !entry.use; if (entry.use) entry.outline = false; }
        else if (action === 'outline' && !entry.use) entry.outline = !entry.outline;
        else if (action === 'up' && index > 0) swap(index - 1);
        else if (action === 'down' && index < entries.length - 1) swap(index + 1);
        else if (action === 'remove' && entry.city === false && !lastInUse) entries.splice(index, 1);
        return entries;
    }
    // A verified source the person adds: first in the list, in use.
    function addToSourceList(list, id) {
        return [{ id, use: true, outline: false, city: false }, ...(list || []).filter(entry => entry.id !== id)];
    }
    // One line naming the list: the sources in use in order, then the outlined ones.
    function sourceListSummary(list, t) {
        const used = (list || []).filter(entry => entry.use).map(entry => entry.name);
        const outlined = (list || []).filter(entry => entry.outline && !entry.use)
            .map(entry => t('outlinedName', '{{name}} outlined', { name: entry.name }));
        return [...used, ...outlined].join(' · ');
    }
    function buildingSourceList(global) {
        return global.CityConfigManager.getBuildingSources();
    }
    function buildingSourceSummary(global) {
        return sourceListSummary(buildingSourceList(global), translator(global, 'building'));
    }

    // The building source list as editable rows, in `host`: name, Use and Outline switches, move up and
    // down, and Remove for a source the person added. Every change is saved at once (SourceList.save
    // announces it; the map reacts) and the rows are drawn again, keeping focus on the same control.
    // Shared by the Building sources dialog and the B-key dialog.
    function renderBuildingSourceList(host, global, focus = null) {
        const doc = global.document, t = translator(global, 'building');
        const city = global.CityConfigManager.getCurrentCityConfig();
        const list = buildingSourceList(global);
        const inUse = list.filter(entry => entry.use).length;
        const node = (tag, className, text, parent) => {
            const created = doc.createElement(tag); if (className) created.className = className;
            if (text) created.textContent = text; if (parent) parent.append(created); return created;
        };
        const status = node('p', 'source-list-editor__status'); status.setAttribute('role', 'status');
        const rows = node('ol', 'source-list-editor');
        rows.setAttribute('aria-label', t('listTitle', 'Building sources'));
        list.forEach((entry, index) => {
            const row = node('li', 'source-list-editor__row', '', rows); row.dataset.sourceId = entry.id;
            if (!entry.use) row.classList.add('source-list-editor__row--unused');
            const name = node('div', 'source-list-editor__name', '', row);
            node('span', 'source-list-editor__title', entry.name, name);
            if (entry.attribution) node('small', 'source-list-editor__attribution', new global.DOMParser().parseFromString(entry.attribution, 'text/html').body.textContent, name);
            const toggles = node('div', 'source-list-editor__switches', '', row);
            const toggle = (action, label, checked, disabled, hint) => {
                const wrap = node('label', 'cb-switch', '', toggles);
                const input = node('input', '', '', wrap); input.type = 'checkbox'; input.setAttribute('role', 'switch');
                input.dataset.action = action; input.checked = checked; input.disabled = disabled;
                if (hint) wrap.title = hint;
                node('span', '', label, wrap);
            };
            const lastInUse = entry.use && inUse === 1;
            toggle('use', t('useSwitch', 'Use'), entry.use, lastInUse, lastInUse ? t('keepOne', 'One source always stays in use.') : '');
            toggle('outline', t('outlineSwitch', 'Outline'), entry.outline && !entry.use, entry.use,
                entry.use ? t('outlineHint', 'Outline draws a source that is not in use, for comparison.') : '');
            const actions = node('div', 'source-list-editor__actions', '', row);
            const button = (action, icon, label, disabled, className = 'btn btn-sm btn-icon') => {
                const control = node('button', className, '', actions); control.type = 'button';
                control.dataset.action = action; control.disabled = disabled;
                control.setAttribute('aria-label', label); control.title = label;
                const glyph = node('i', icon, '', control); glyph.setAttribute('aria-hidden', 'true');
            };
            button('up', 'fas fa-arrow-up', t('moveUp', 'Move {{name}} up', { name: entry.name }), index === 0);
            button('down', 'fas fa-arrow-down', t('moveDown', 'Move {{name}} down', { name: entry.name }), index === list.length - 1);
            if (entry.city === false) button('remove', 'fas fa-trash', t('remove', 'Remove {{name}}', { name: entry.name }), lastInUse, 'btn btn-sm btn-icon btn-danger');
        });
        host.replaceChildren(rows, status);
        const apply = (action, id) => {
            try { global.SourceList.save(city.id, editSourceList(list, action, id), global); }
            catch (_) { status.textContent = t('storageFailed', 'The source choice could not be saved in this browser.'); return; }
            renderBuildingSourceList(host, global, { id, action });
        };
        rows.addEventListener('change', event => {
            const input = event.target.closest('input[data-action]');
            if (input) apply(input.dataset.action, input.closest('[data-source-id]').dataset.sourceId);
        });
        rows.addEventListener('click', event => {
            const control = event.target.closest('button[data-action]');
            if (control) apply(control.dataset.action, control.closest('[data-source-id]').dataset.sourceId);
        });
        if (focus) {
            const row = [...rows.children].find(item => item.dataset.sourceId === focus.id);
            const control = row?.querySelector(`[data-action="${focus.action}"]`);
            (control && !control.disabled ? control : row?.querySelector('input, button:not(:disabled)'))?.focus();
        }
        return rows;
    }

    function open(global, kind = 'parcel') {
        const spec = kindOf(kind);
        global.document.getElementById('parcel-source-settings')?.remove();
        const city = global.CityConfigManager.getCurrentCityConfig();
        const t = translator(global, kind);
        // A native <dialog> (showModal) wearing the dialog primitive (css/primitives.css): header
        // with the title and one close button, body, footer; css/parcel-sources.css adds what a
        // native dialog needs (no UA border or padding, centring, the token backdrop).
        const dialog = global.document.createElement('dialog');
        dialog.id = 'parcel-source-settings'; dialog.className = 'cb-dialog cb-dialog--md parcel-source-settings';
        const header = global.document.createElement('div'); header.className = 'cb-dialog__header'; dialog.append(header);
        const body = global.document.createElement('div'); body.className = 'cb-dialog__body parcel-source-settings__body'; dialog.append(body);
        const footer = global.document.createElement('div'); footer.className = 'cb-dialog__footer'; dialog.append(footer);
        const element = (tag, text, parent = body) => {
            const node = global.document.createElement(tag); if (text) node.textContent = text; parent.append(node); return node;
        };
        const building = kind === 'building', imagery = kind === 'imagery';
        const title = element('h2', imagery ? t('title', 'Choose an imagery source') : building ? t('listTitle', 'Building sources') : t('title', 'Choose a parcel source'), header);
        title.id = 'parcel-source-settings-title'; title.className = 'cb-dialog__title';
        dialog.setAttribute('aria-labelledby', title.id);
        const close = element('button', '×', header); close.type = 'button'; close.className = 'close-circle-btn';
        close.setAttribute('aria-label', t('close', 'Close'));
        close.addEventListener('click', () => dialog.close());
        // Buildings: the source list first, then adding a source of one's own (folded away).
        let listHost = null, adding = body;
        if (building) {
            element('p', t('listIntro', 'Sources in use fill each area in this order: where one has no buildings, the next stands in. A source with Outline on is drawn for comparison only.'));
            listHost = element('div'); listHost.className = 'source-list-editor-host';
            renderBuildingSourceList(listHost, global);
            adding = element('details'); adding.className = 'source-list-add';
            element('summary', t('addSource', 'Add a source'), adding);
        }
        element('p', imagery ? t('intro', 'Add a public HTTPS XYZ tile URL (with {z}, {x}, {y}) or WMS service for this area. Imagery is a visual background; it does not change parcels or buildings.') : building
            ? t('intro', 'Add a public HTTPS URL of building footprints for this city, or of an OpenStreetMap mirror (an Overpass API address ending in /interpreter). We try each supported format and read a height or storey field when it has one; other heights are estimated.')
            : t('intro', 'Add a public HTTPS parcel URL for this city. We try each supported format and check that it can return complete parcel boundaries.'), adding);
        const active = building ? null : choiceForCity(city.id, global, kind);
        if (!building) element('p', t('current', 'Current source: {{source}}', { source: active?.name || defaultName(city, kind, t) }));
        const form = element('form', '', adding); form.className = 'parcel-source-settings__form';
        const label = element('label', imagery ? t('url', 'Imagery source URL') : building ? t('url', 'Building source URL') : t('url', 'Parcel source URL'), form); label.htmlFor = 'parcel-source-url';
        const input = element('input', '', form); input.id = 'parcel-source-url'; input.type = 'url'; input.required = true;
        input.maxLength = 2000;
        input.autocomplete = 'url'; input.placeholder = 'https://'; input.value = active?.endpoint || '';
        const check = element('button', t('check', 'Check URL'), form); check.type = 'submit'; check.className = 'btn';
        const result = element('div', '', adding); result.className = 'parcel-source-settings__result'; result.setAttribute('role', 'status'); result.setAttribute('aria-live', 'polite');
        const checks = recentChecks(city.id, global, kind);
        if (checks.length) {
            const history = element('details', '', adding); element('summary', t('recent', 'Recent source checks'), history);
            for (const item of checks.slice().reverse()) {
                element('p', String(item.at || '') + ' · ' + String(item.url || '') + ' · ' + String(item.code || ''), history);
                for (const attempt of item.attempts || []) element('p', String(attempt.adapter || '') + ': ' + String(attempt.message || attempt.status || ''), history);
            }
        }
        let candidate = null, controller = null;
        // Building sources: the unit the person picked for the height field, sent with a re-check.
        let chosenUnit = null, chosenLayers = active?.layers || undefined;
        if (imagery) {
            const presets = global.ImagerySource.suggestions(city, global.map?.getCenter?.());
            if (presets.length) {
                const group = element('div'); group.className = 'imagery-source-presets';
                element('p', t('presets', 'Suggested for this area'), group);
                element('p', t('dguCoverage', 'Western Croatia only; coverage varies within this area.'), group);
                for (const preset of presets) {
                    const button = element('button', t(preset.key, preset.name), group); button.type = 'button'; button.className = 'btn';
                    button.addEventListener('click', () => { input.value = preset.endpoint; chosenLayers = preset.layers; form.requestSubmit(); });
                }
            }
        }
        input.addEventListener('input', () => { chosenUnit = null; chosenLayers = undefined; candidate = null; use.hidden = true; });
        const use = element('button', building ? t('add', 'Add this source') : t('use', 'Use this source'), footer); use.type = 'button'; use.className = 'btn btn-primary'; use.hidden = true;
        use.addEventListener('click', () => {
            try {
                if (!building) { saveChoice(city.id, candidate, global, kind); reloadWithChoice(global, candidate.id, kind); return; }
                // A verified building source goes first in the list, in use; the map follows without a reload.
                global.SourceList.save(city.id, addToSourceList(buildingSourceList(global), candidate.id), global);
                result.textContent = t('added', '{{name}} is now first in the list, in use.', { name: decodeChoice(candidate.id, city.id, kind).name });
                candidate = null; use.hidden = true; input.value = '';
                renderBuildingSourceList(listHost, global);
            } catch (_) { result.textContent = t('storageFailed', 'The source choice could not be saved in this browser.'); }
        });
        const alternatives = element('div', '', adding); alternatives.hidden = true;
        element('p', t('noAdapter', 'No available adapter.'), alternatives);
        const options = element('ol', '', alternatives);
        const conform = element('li', t('conform', 'Conform your source so it can be read by one of the adapters. '), options);
        const formats = element('a', t('formats', 'See the source formats we understand'), conform);
        formats.href = 'parcel-source-formats.html' + (imagery ? '#imagery' : ''); formats.target = '_blank'; formats.rel = 'noopener noreferrer';
        formats.className = 'cb-link cb-link--external';
        const request = element('li', t('request', 'Ask us to add another adapter, which we sometimes do. '), options);
        const telegram = element('a', t('telegram', 'Telegram group'), request);
        telegram.href = TELEGRAM_URL; telegram.target = '_blank'; telegram.rel = 'noopener noreferrer';
        telegram.className = 'cb-link cb-link--external';
        // Check URL spins (BusyControl) for as long as the check runs.
        form.addEventListener('submit', event => {
            event.preventDefault();
            const work = checkSource();
            if (global.BusyControl) global.BusyControl.track(check, work); else work.catch(() => {});
        });
        async function checkSource() {
            candidate = null; use.hidden = true; alternatives.hidden = true;
            check.disabled = true; input.disabled = true; result.textContent = t('checking', 'Checking supported adapters…');
            controller?.abort(); controller = new AbortController();
            const requestController = controller;
            const timer = setTimeout(() => requestController.abort(), 90000);
            try {
                // A check stores nothing: a GET with the source, the label and a small probe box.
                const query = new URLSearchParams({ url: input.value, bbox: smallProbeBounds(global.map).join(',') });
                if (city.id) query.set('city', city.id);
                if (chosenUnit) query.set('heightUnit', chosenUnit);
                if (chosenLayers && chosenLayers.length) query.set('layers', chosenLayers.join(','));
                const response = await global.fetch(`${backend(global)}${spec.discover}?${query}`, {
                    cache: 'no-store', signal: requestController.signal });
                const data = await response.json();
                if (requestController.signal.aborted || requestController !== controller) return;
                recordCheck(city.id, input.value, data, global, kind);
                if (!response.ok) {
                    const error = Object.assign(new Error(data.error || 'Source check failed.'), data, { status: response.status });
                    // A source the browser may not read (no CORS) cannot be used: sources are read in the browser.
                    const cors = [error.code, ...(data.attempts || []).map(item => item.error?.code)].some(code => String(code || '').includes('cors'));
                    if (error.code === 'no-available-adapter' && !cors) { result.textContent = ''; alternatives.hidden = false; }
                    else result.textContent = cors ? t('cors', 'This service does not allow browsers to read it directly.')
                        : error.code === 'invalid-source-url'
                        ? t('invalidUrl', 'Use a public HTTPS URL without credentials or access keys.')
                        : imagery ? error.code === 'imagery-crs-unsupported' ? t('unsupportedCrs', 'This WMS needs a supported geographic or Web Mercator coordinate system.') : error.message : global.ParcelSourceHealth?.describeFailure?.(error, { offline: global.navigator?.onLine === false, translate: global.i18n?.t?.bind(global.i18n) }) || error.message;
                    if (Array.isArray(data.attempts)) element('p', t('attempts', 'Tried: {{adapters}}', { adapters: data.attempts.map(item => item.adapter).join(', ') }), result);
                    for (const attempt of data.attempts || []) {
                        if (attempt.error?.message) element('p', attempt.adapter + ': ' + attempt.error.message, result);
                    }
                    return;
                }
                if (imagery && data.selectionRequired) {
                    result.textContent = t('selectLayer', 'Choose a WMS layer, then check again.');
                    const select = element('select', '', result); select.setAttribute('aria-label', t('layer', 'WMS layer'));
                    for (const layer of data.layers || []) { const option = element('option', layer.title || layer.name, select); option.value = layer.name; }
                    chosenLayers = select.value ? [select.value] : undefined;
                    select.addEventListener('change', () => { chosenLayers = [select.value]; });
                    return;
                }
                candidate = data.source;
                if (!decodeChoice(candidate?.id, city.id, kind)) throw new Error('Invalid source choice.');
                result.textContent = imagery ? t('matched', 'Image verified using {{adapter}}. Coverage outside the test area depends on the source.', { adapter: candidate.adapter }) : building
                    ? t('matched', 'Adapter found: {{adapter}}. {{count}} buildings in the test area. Coverage outside this area depends on the source.', { adapter: candidate.adapter, count: data[spec.countField] })
                    : t('matched', 'Adapter found: {{adapter}}. {{count}} parcels in the test area. Coverage outside this area depends on the source.', { adapter: candidate.adapter, count: data[spec.countField] });
                if (building) describeHeights(candidate);
                use.hidden = false;
            } catch (error) {
                if (requestController !== controller || !dialog.isConnected) return;
                recordCheck(city.id, input.value, { code: 'parcel-source-unavailable' }, global, kind);
                result.textContent = t('checkFailed', 'Could not finish checking the URL. Check your connection and try again.');
            }
            finally { clearTimeout(timer); if (requestController === controller) { check.disabled = false; input.disabled = false; } }
        }
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
        const reset = global.document.createElement('button');
        reset.textContent = building ? t('resetList', 'Reset to the city\'s list') : t('default', 'Use the city default');
        reset.type = 'button'; reset.className = 'btn'; footer.prepend(reset);
        reset.addEventListener('click', () => {
            try {
                if (!building) { storage(global).removeItem(storageKey(city.id, global, kind)); reloadWithChoice(global, null, kind); return; }
                global.SourceList.reset(city.id, global);
                renderBuildingSourceList(listHost, global);
            } catch (_) { result.textContent = t('storageFailed', 'The source choice could not be saved in this browser.'); }
        });
        dialog.addEventListener('close', () => { controller?.abort(); dialog.remove(); });
        global.document.body.append(dialog); dialog.showModal();
        if (!building) input.focus();
        return dialog;
    }
    // The failure banners, one per kind, are sections of the shared banner card (design-language.md, Messages): both
    // failing at once reads as one card with one line per source. Parcel choices live in the ground
    // fallback dialog; building failures retain their own retry/source actions.
    const BANNERS = {
        parcel: { id: 'parcel-source-status', title: ['parcelSources.unavailableTitle', 'Parcels unavailable'], icon: 'fas fa-draw-polygon', choose: ['groundFallback.reopen', 'Choose how to continue'] },
        imagery: { id: 'imagery-source-status', title: ['imagerySources.unavailableTitle', 'Imagery unavailable'], icon: 'fas fa-satellite', retry: ['imagerySources.retry', 'Retry imagery'], choose: ['imagerySources.title', 'Choose an imagery source'], defaultRetry: () => {} },
        building: { id: 'building-source-status', title: ['buildingSources.unavailableTitle', 'Buildings unavailable'], icon: 'fas fa-building', retry: ['buildingSources.retry', 'Retry buildings'], choose: ['buildingSources.title', 'Choose a building source'],
            defaultRetry: () => {} }
    };
    function reportFailure(global, message, kind = 'parcel', retry = null) {
        const doc = global.document;
        if (!doc) return;
        const spec = BANNERS[kind] || BANNERS.parcel;
        let banner = doc.getElementById(spec.id);
        if (!banner) {
            banner = doc.createElement('aside'); banner.id = spec.id;
            banner.className = 'source-status cb-banner'; banner.setAttribute('role', 'status');
            const title = doc.createElement('h3'); title.className = 'cb-banner__title';
            const icon = doc.createElement('i'); icon.className = spec.icon; icon.setAttribute('aria-hidden', 'true');
            const label = doc.createElement('span'); label.setAttribute('data-i18n-key', spec.title[0]);
            const translatedTitle = global.i18n?.t?.(spec.title[0]);
            label.textContent = translatedTitle && translatedTitle !== spec.title[0] ? translatedTitle : spec.title[1];
            title.append(icon, label); banner.append(title);
            const text = doc.createElement('p'); text.className = 'source-status__message'; banner.append(text);
            const button = ([key, fallback], action) => {
                const node = doc.createElement('button'); node.type = 'button'; node.className = 'btn';
                const value = global.i18n?.t?.(key); node.textContent = value && value !== key ? value : fallback;
                node.addEventListener('click', action); banner.append(node);
            };
            if (kind === 'parcel') {
                button(spec.choose, () => global.ParcelGroundFallback.openOptions());
            } else {
                // A retry is an attempt, not recovery. Only this source's successful load clears it.
                button(spec.retry, () => { const again = banner.retry || spec.defaultRetry; again(global); });
                button(spec.choose, () => open(global, kind));
            }
            button(['parcelSources.dismiss', 'Dismiss source warning'], () => banner.remove());
            // The shared banner card (js/ui/banner-stack.js); a bare document gets a plain stack.
            const stackApi = global.__BannerStack;
            if (!(stackApi && typeof stackApi.mount === 'function' && stackApi.mount(banner))) {
                let stack = doc.getElementById('cb-banner-stack');
                if (!stack) { stack = doc.createElement('div'); stack.id = 'cb-banner-stack'; stack.className = 'cb-banner-stack'; doc.body.append(stack); }
                stack.append(banner);
            }
        }
        banner.querySelector('p').textContent = message;
        if (typeof retry === 'function') banner.retry = retry;
    }
    function clearFailure(global, kind = 'parcel') { global.document?.getElementById((BANNERS[kind] || BANNERS.parcel).id)?.remove(); }
    // The building banner's text: whose data failed, and when asking again is worth it.
    // `origin`: 'custom', 'osm' or anything else. HTTP failures describe our request path directly.
    function buildingFailureMessage(global, { retryAfter = null, origin = 'other', status = null } = {}) {
        const t = (key, fallback, params = {}) => {
            const full = 'buildingSources.' + key, value = global.i18n?.t?.(full, params);
            return (value && value !== full ? value : fallback).replace(/\{\{(\w+)\}\}/g, (_, name) => params[name] ?? '');
        };
        const minutes = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.max(1, Math.ceil(retryAfter / 60)) : null;
        const head = Number.isInteger(status) && status >= 400 && status <= 599
            ? t('requestFailed', 'Our server could not complete the building-data request (HTTP {{status}}).', { status })
            : origin === 'custom'
                ? t('customUnavailable', 'Building data from your selected source could not be loaded.')
                : origin === 'osm'
                    ? t('osmUnavailable', 'OpenStreetMap building data could not be loaded through our server.')
                    : t('unavailable', 'Building data could not be loaded right now.');
        const tail = minutes
            ? t('tryAgainIn', 'Try again in about {{minutes}} min, or plug in your own mirror or source.', { minutes })
            : t('tryAgainLater', 'Try again later, or plug in your own mirror or source.');
        return head + ' ' + tail;
    }
    return Object.freeze({ TELEGRAM_URL, KINDS, defaultName, decodeChoice, choiceForCity, saveChoice, recentChecks, recordCheck, smallProbeBounds, storageKey, open, reportFailure, clearFailure, buildingFailureMessage,
        editSourceList, addToSourceList, sourceListSummary, buildingSourceSummary, renderBuildingSourceList });
});
