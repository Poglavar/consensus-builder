// Satellite/OSM illustrative rectangles: an independent, temporary map overlay and its controls.
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
        const [{ makeArea, SIZES }, { generate, ATTRIBUTION }] = await Promise.all([
            import('./estimate/area.mjs?v=20261020'), import('./estimate/runtime.mjs?v=20261020')
        ]);
        if (opening !== token || active) return;
        const map = global.map, L = global.L;
        if (!map || !L) throw new Error(tr('errors.map'));
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
        for (const value of SIZES) { const option = node('option', null, `${value} × ${value} m`); option.value = value; size.appendChild(option); }
        size.value = '256'; sizeLabel.appendChild(size); root.appendChild(sizeLabel);
        const settings = {};
        for (const [key, initial] of [['sensitivity', 55], ['rectangularity', 65]]) {
            const label = node('label', 'parcel-estimate-field', tr(key)), input = node('input');
            input.type = 'range'; input.min = '0'; input.max = '100'; input.value = initial;
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
        const state = { map, control, group, controller: null, area: null, collection: null, image: null, plots: null,
            erase: false, removed: [], attribution: ATTRIBUTION, updateArea };
        active = state;
        document.body.classList.add('parcel-estimate-open');
        map.attributionControl?.addAttribution(ATTRIBUTION);
        function updateArea() {
            if (state.controller) return;
            try {
                state.area = makeArea(map.getCenter(), Number(size.value));
                const [w, s, e, n] = state.area.bounds;
                frame.setBounds([[s, w], [n, e]]);
                start.disabled = false;
            } catch (_) { state.area = null; start.disabled = true; status.textContent = tr('errors.area'); }
        }
        function showSummary() {
            const stats = state.collection.demo.stats;
            status.textContent = tr('result', { count: state.collection.features.length,
                coverage: Math.round(stats.groundCoverage * 100), unassigned: stats.unassignedBuildings,
                removed: state.removed.length });
        }
        size.addEventListener('change', updateArea);
        map.on('moveend', updateArea); updateArea();
        if (state.area) map.fitBounds(frame.getBounds(), { padding: [28, 28], maxZoom: 18, animate: false });
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
                state.image?.remove(); state.plots?.remove();
                const [w, s, e, n] = area.bounds;
                state.image = L.imageOverlay(result.imageUrl, [[s, w], [n, e]], { opacity: 1, pane: 'parcelEstimateImagery' }).addTo(group);
                state.collection = result.collection; state.removed = [];
                state.collection.demo.removed_plot_ids = state.removed;
                state.plots = L.geoJSON(result.collection, {
                    style: { className: 'parcel-estimate-plot' },
                    onEachFeature: (feature, layer) => {
                        layer.bindTooltip(tr('plot', { area: Math.round(feature.properties.area_m2) }));
                        layer.on('click', event => {
                            if (!state.erase) return;
                            L.DomEvent.stopPropagation(event);
                            state.plots.removeLayer(layer);
                            state.collection.features = state.collection.features.filter(item => item.id !== feature.id);
                            state.removed.push(feature.id); showSummary();
                        });
                    }
                }).addTo(group);
                download.disabled = erase.disabled = false;
                showSummary();
            } catch (error) {
                if (active === state) status.textContent = tr(controller.signal.aborted ? 'cancelled' :
                    `errors.${['area', 'context', 'imagery', 'busy', 'processing'].includes(error.message) ? error.message : 'network'}`);
            } finally {
                if (active === state) {
                    state.controller = null; start.disabled = size.disabled = false; cancel.hidden = true; updateArea();
                }
            }
        });
    }
    global.ParcelEstimates = { open, close, isOpen: () => Boolean(active) };
    global.addEventListener('cityChanged', close);
})(window);
