// Generate and persist an estimated parcel source; normal parcel presentation owns its boundaries.
(function (global) {
    'use strict';
    let active = null, opening = null;
    const tr = (key, vars = {}) => {
        const full = `parcelEstimate.${key}`;
        const text = global.i18n?.t?.(full, vars);
        return text && text !== full ? text : full;
    };
    const node = (tag, className, text) => {
        const value = document.createElement(tag);
        if (className) value.className = className;
        if (text) value.textContent = text;
        return value;
    };
    const cityId = () => String(global.CityConfigManager.getCurrentCityId());
    const store = () => global.EstimatedParcelSource.createStore(global.BrowserWorkspace?.storage || global.localStorage);
    function persist(collection, imageUrl, bounds) {
        const proposals = global.proposalStorage.getAllProposals();
        const referencedIds = proposals.flatMap(proposal => proposal.cadastreParcelIds || []);
        const record = store().save(cityId(), { collection, imageUrl, bounds }, { referencedIds });
        global.ParcelGroundFallback.installSource(record.city, global.EstimatedParcelSource.createSource(record));
        // Source changes use the existing reload boundary so old in-flight source reads cannot mix
        // into the new fabric. The saved source and controls restore before/after map boot.
        global.ParcelGroundFallback.reloadWithSource();
    }
    function consumeRemovalClick(id) {
        if (!active?.erase || !active.collection?.features.some(feature => feature.id === id)) return false;
        try {
            const collection = structuredClone(active.collection);
            collection.features = collection.features.filter(feature => feature.id !== id);
            collection.demo.removed_plot_ids.push(id);
            persist(collection, active.saved.imageUrl, active.saved.bounds);
        } catch (error) { active.showError(error); }
        return true;
    }
    function close() {
        opening = null;
        document.body.classList.remove('parcel-estimate-open');
        if (!active) return;
        active.controller?.abort();
        active.map.off('moveend', active.updateArea);
        active.group.remove(); active.control.remove();
        active.map.attributionControl?.removeAttribution(active.attribution);
        active = null;
    }
    async function open() {
        if (active) return;
        const token = {}; opening = token;
        const [{ makeArea, makeViewportArea, SIZES }, { generate, ATTRIBUTION }] = await Promise.all([
            import('./estimate/area.mjs?v=20261020-viewport'), import('./estimate/runtime.mjs?v=20261020-viewport')
        ]);
        if (opening !== token || active) return;
        const map = global.map, L = global.L;
        if (!map || !L) throw new Error(tr('errors.map'));
        const saved = global.ParcelGroundFallback.activeSource(cityId())?.kind === 'estimated-local'
            ? store().read(cityId()) : null;
        const root = node('section', 'parcel-estimate-panel cb-card');
        root.setAttribute('aria-label', tr('title'));
        const header = node('div', 'parcel-estimate-heading');
        header.appendChild(node('h3', null, tr('title')));
        const collapse = node('button', 'btn', '−'); collapse.type = 'button';
        collapse.setAttribute('aria-label', tr('collapse')); collapse.setAttribute('aria-expanded', 'true');
        collapse.addEventListener('click', () => {
            const collapsed = root.classList.toggle('is-collapsed');
            collapse.textContent = collapsed ? '+' : '−';
            collapse.setAttribute('aria-expanded', String(!collapsed));
            collapse.setAttribute('aria-label', tr(collapsed ? 'expand' : 'collapse'));
        });
        header.appendChild(collapse);
        const dismiss = node('button', 'btn', '×'); dismiss.type = 'button';
        dismiss.setAttribute('aria-label', tr('close')); dismiss.addEventListener('click', close);
        header.appendChild(dismiss); root.appendChild(header);
        root.appendChild(node('p', 'parcel-estimate-notice', tr('disclaimer')));
        root.appendChild(node('p', 'parcel-estimate-help', tr('help')));
        const sizeLabel = node('label', 'parcel-estimate-field', tr('size'));
        const size = node('select'); size.id = 'parcel-estimate-size';
        const viewport = node('option', null, tr('viewport')); viewport.value = 'viewport'; size.appendChild(viewport);
        for (const value of SIZES) { const option = node('option', null, `${value} × ${value} m`); option.value = value; size.appendChild(option); }
        size.value = 'viewport'; sizeLabel.appendChild(size); root.appendChild(sizeLabel);
        const settings = {};
        for (const [key, initial] of [['sensitivity', 55], ['rectangularity', 65]]) {
            const label = node('label', 'parcel-estimate-field', tr(key)), input = node('input');
            input.type = 'range'; input.min = '0'; input.max = '100'; input.value = saved?.collection.demo.settings[key] ?? initial;
            input.id = `parcel-estimate-${key}`; label.appendChild(input); root.appendChild(label); settings[key] = input;
        }
        const status = node('p', 'parcel-estimate-status', tr('ready'));
        status.setAttribute('role', 'status'); root.appendChild(status);
        const actions = node('div', 'parcel-estimate-actions');
        const start = node('button', 'btn btn-primary', tr('generate'));
        const cancel = node('button', 'btn', tr('cancel')); cancel.hidden = true;
        const download = node('button', 'btn', tr('export')); download.disabled = true;
        const erase = node('button', 'btn', tr('remove')); erase.disabled = true; erase.setAttribute('aria-pressed', 'false');
        for (const button of [start, cancel, download, erase]) { button.type = 'button'; actions.appendChild(button); }
        root.appendChild(actions);
        const attribution = node('p', 'parcel-estimate-attribution');
        for (const [text, href] of [['MapTiler', 'https://www.maptiler.com/copyright/'], ['OpenStreetMap contributors', 'https://www.openstreetmap.org/copyright']]) {
            const link = node('a', null, `© ${text}`); link.href = href; link.target = '_blank'; link.rel = 'noopener'; attribution.appendChild(link);
        }
        root.appendChild(attribution);
        L.DomEvent.disableClickPropagation(root); L.DomEvent.disableScrollPropagation(root);
        root.addEventListener('keydown', event => { event.stopPropagation(); if (event.key === 'Escape') close(); });
        const control = L.control({ position: 'topright' }); control.onAdd = () => root; control.addTo(map);
        const group = L.layerGroup().addTo(map);
        if (!map.getPane('parcelEstimateImagery')) map.createPane('parcelEstimateImagery');
        const frame = L.rectangle([[0, 0], [0, 0]], { className: 'parcel-estimate-frame', interactive: false }).addTo(group);
        const state = { map, control, group, controller: null, area: null, collection: saved?.collection || null, saved,
            erase: false, attribution: ATTRIBUTION, updateArea, showError };
        active = state;
        document.body.classList.add('parcel-estimate-open');
        map.attributionControl?.addAttribution(ATTRIBUTION);
        function updateArea() {
            if (state.controller) return;
            try {
                const bounds = map.getBounds();
                state.area = size.value === 'viewport'
                    ? makeViewportArea([bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()])
                    : makeArea(map.getCenter(), Number(size.value));
                const [w, s, e, n] = state.area.bounds;
                frame.setBounds([[s, w], [n, e]]);
                if (!group.hasLayer(frame)) frame.addTo(group);
                start.disabled = false;
                if (state.areaError) { state.areaError = false; state.collection ? showSummary() : status.textContent = tr('ready'); }
            } catch (error) {
                state.area = null; state.areaError = true; start.disabled = true; frame.remove();
                status.textContent = tr(error.message === 'extent' ? 'errors.extent' : 'errors.area');
            }
        }
        function showSummary() {
            const stats = state.collection.demo.stats;
            status.textContent = tr('result', { count: state.collection.features.length,
                coverage: Math.round(stats.groundCoverage * 100), unassigned: stats.unassignedBuildings,
                removed: state.collection.demo.removed_plot_ids?.length || 0 });
        }
        function showError(error) {
            const key = error.code === 'estimate-in-use' ? 'inUse' : error.code === 'estimate-storage' ? 'storage'
                : ['area', 'context', 'imagery', 'busy', 'processing'].includes(error.message) ? error.message : 'network';
            status.textContent = tr(`errors.${key}`);
        }
        size.addEventListener('change', updateArea);
        map.on('moveend', updateArea); updateArea();
        if (saved) {
            const [w, s, e, n] = saved.bounds;
            if (saved.imageUrl) L.imageOverlay(saved.imageUrl, [[s, w], [n, e]],
                { opacity: 1, pane: 'parcelEstimateImagery' }).addTo(group);
            download.disabled = erase.disabled = false;
            if (state.area) showSummary();
        }
        cancel.addEventListener('click', () => state.controller?.abort());
        erase.addEventListener('click', () => {
            state.erase = !state.erase; erase.setAttribute('aria-pressed', String(state.erase));
        });
        download.addEventListener('click', () => {
            if (!state.collection) return;
            const url = URL.createObjectURL(new Blob([JSON.stringify(state.collection)], { type: 'application/geo+json' }));
            const link = node('a'); link.href = url; link.download = 'illustrative-parcel-estimates.geojson';
            link.click(); URL.revokeObjectURL(url);
        });
        start.addEventListener('click', async () => {
            if (!state.area || state.controller) return;
            const controller = new AbortController(); state.controller = controller;
            start.disabled = size.disabled = true; cancel.hidden = false;
            const area = state.area, values = Object.fromEntries(Object.entries(settings).map(([key, input]) => [key, Number(input.value)]));
            const showProgress = key => { if (active === state) status.textContent = tr(key); };
            try {
                const result = await generate({ area, settings: values, signal: controller.signal,
                    base: typeof getBackendBase === 'function' ? getBackendBase() : '',
                    tileUrl: global.BasemapManager.satelliteTileUrl, onProgress: showProgress });
                if (active !== state || controller.signal.aborted) return;
                result.collection.demo.removed_plot_ids = [];
                persist(result.collection, result.imageUrl, area.bounds);
            } catch (error) {
                if (active === state) {
                    if (controller.signal.aborted) status.textContent = tr('cancelled');
                    else showError(error);
                }
            } finally {
                if (active === state) {
                    state.controller = null; start.disabled = size.disabled = false; cancel.hidden = true; updateArea();
                }
            }
        });
        // Opening the imagery option starts one estimate; subsequent changes remain explicit.
        if (!saved && state.area) start.click();
    }
    global.ParcelEstimates = { open, close, consumeRemovalClick, isOpen: () => Boolean(active) };
    global.addEventListener('cityChanged', close);
    document.addEventListener('DOMContentLoaded', () => {
        global.whenMapCoreReady().then(() => {
            if (global.ParcelGroundFallback.activeSource(cityId())?.kind === 'estimated-local') return open();
        }).catch(error => {
            console.error('[ParcelEstimates] saved estimates could not be opened', error);
            global.updateStatus?.(tr('errors.storage'));
        });
    }, { once: true });
})(window);
