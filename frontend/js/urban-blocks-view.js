// Standalone OSM urban-block overlay and inspector. Owns map clicks while enabled, keeps roads
// invisible, and reads loaded cadastral parcels only as an optional statistic.
(function (win) {
    'use strict';
    if (!win?.document) return;
    const doc = win.document;
    const PANE = 'urbanBlocksPane';
    let layer = null, selectionLayer = null, selected = null, wired = false, fitting = false;
    let targetSideM = 100;
    let linkedBlock = win.UrbanBlocksLinks.parse(win.location.href);
    const el = id => doc.getElementById(id);
    function t(key, fallback, params) {
        const text = win.i18n?.t?.(`urbanBlocks.${key}`, params);
        if (text && text !== `urbanBlocks.${key}`) return text;
        return fallback.replace(/\{\{(\w+)\}\}/g, (_, name) => String(params?.[name] ?? ''));
    }
    const format = (value, digits = 0) => new Intl.NumberFormat(doc.documentElement.lang || 'en', { maximumFractionDigits: digits }).format(value);

    async function fetchRoads(bbox, signal) {
        const base = win.getBackendBase().replace(/\/$/, '');
        const response = await win.fetch(`${base}/blocks/roads?bbox=${encodeURIComponent(bbox.join(','))}`, { signal });
        if (!response.ok) {
            if (response.status === 503) throw new Error(t('rateLimited', 'OSM is busy. Retry in {{seconds}} seconds.', { seconds: response.headers.get('Retry-After') || 60 }));
            throw new Error(t('loadError', 'Could not load OSM roads (HTTP {{status}}). Please retry.', { status: response.status }));
        }
        const roads = await response.json();
        if (!Array.isArray(roads.features)) throw new Error(t('invalidData', 'The road source returned invalid data.'));
        return roads;
    }

    function detect(roads, bbox, signal) {
        return new Promise((resolve, reject) => {
            const worker = new win.Worker(win.appendBuildToken('js/urban-blocks-worker.js'));
            const finish = (error, blocks) => {
                signal.removeEventListener('abort', abort);
                worker.terminate();
                if (error) reject(error); else resolve(blocks);
            };
            const abort = () => finish(new Error('Block analysis cancelled.'));
            signal.addEventListener('abort', abort, { once: true });
            worker.onmessage = ({ data }) => finish(data.error ? new Error(data.error) : null, data.blocks);
            worker.onerror = () => finish(new Error(t('workerError', 'Block analysis failed; please retry.')));
            if (signal.aborted) { abort(); return; }
            worker.postMessage({ roads, bbox });
        });
    }

    function style(feature) {
        const active = feature.id === selected?.id;
        return { color: '#ffffff', weight: 1, opacity: active ? 0 : 1,
            fillColor: feature.properties.color, fillOpacity: active ? 0 : 0.38 };
    }
    function clearSelection() {
        if (selected) clearBlockUrl();
        selected = null;
        if (selectionLayer) win.map.removeLayer(selectionLayer);
        selectionLayer = null;
        el('urban-block-panel').hidden = true;
        layer?.setStyle(style);
    }
    function render(state) {
        const messages = {
            off: t('hint', 'Load OSM roads, then colour the enclosed blocks. Parcel data is optional.'),
            idle: t('starting', 'Preparing block view…'),
            zoom: t('zoom', 'Zoom in to neighbourhood scale to detect complete blocks.'),
            roads: t('loadingRoads', '1/2 · Loading OSM roads…'),
            blocks: t('detecting', '2/2 · Detecting blocks from {{count}} road ways…', { count: format(state.roadCount) }),
            ready: state.blocks?.features.length
                ? t('ready', '{{count}} blocks · Click a coloured block to analyse it.', { count: format(state.blocks.features.length) })
                : t('empty', 'No fully enclosed blocks here. Move the map or zoom out slightly.'),
            error: state.error
        };
        el('urban-blocks-status').textContent = messages[state.phase];
        el('urban-blocks-status').setAttribute('role', state.phase === 'error' ? 'alert' : 'status');
        el('urban-blocks-refresh').disabled = !state.enabled || ['roads', 'blocks'].includes(state.phase);
        el('urban-blocks-refresh').textContent = t(state.phase === 'error' ? 'retry' : 'refresh', state.phase === 'error' ? 'Retry road loading' : 'Refresh this area');
        doc.body.classList.toggle('urban-blocks-active', state.enabled);
        if (state.phase === 'ready') {
            if (layer) win.map.removeLayer(layer);
            let pane = win.map.getPane(PANE);
            if (!pane) pane = win.map.createPane(PANE);
            pane.style.zIndex = 645;
            // Native capture below owns clicks even where no closed polygon exists. Rendering
            // itself is inert so it cannot swallow an editing tool's clicks.
            pane.style.pointerEvents = 'none';
            layer = win.L.geoJSON(state.blocks, { pane: PANE, interactive: false, style }).addTo(win.map);
            selectionLayer?.bringToFront();
            if (linkedBlock) {
                const link = linkedBlock;
                linkedBlock = null;
                const feature = state.blocks.features.find(block => block.id === link.blockId);
                if (feature) {
                    targetSideM = link.targetSideM;
                    showBlock(feature);
                } else {
                    clearBlockUrl();
                    win.showEphemeralMessage(t('linkMissing', 'This block’s outline has changed or is unavailable. Select a block on the map.'));
                }
            }
        } else if (!['roads', 'blocks'].includes(state.phase)) {
            // Inspection owns a separate polygon. Framing a large block can cross the loading
            // zoom limit or start another road request without losing the block being inspected.
            if (['off', 'idle'].includes(state.phase)) clearSelection();
            if (layer) win.map.removeLayer(layer);
            layer = null;
        }
    }

    const controller = win.UrbanBlocksController.create({ fetchRoads, detect, onChange: render });
    function viewport() {
        const b = win.map.getBounds();
        return { bbox: [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()], zoom: win.map.getZoom() };
    }
    function refresh(force = false) {
        if (linkedBlock) {
            // Finish the whole enclosure from the link, even when a phone viewport would cut it
            // off. Ordinary boot/resize move events must not supersede this targeted request.
            if (!force && ['roads', 'blocks'].includes(controller.snapshot().phase)) return;
            return controller.loadBounds(win.UrbanBlocksLinks.loadBounds(linkedBlock.bbox));
        }
        return controller.refresh(viewport(), force);
    }

    function selectedLink() {
        if (!selected) return null;
        return win.UrbanBlocksLinks.build({ baseUrl: win.location.href,
            city: win.CityConfigManager.getCurrentCityId(), blockId: selected.id,
            bbox: win.turf.bbox(selected), targetSideM });
    }
    function updateBlockUrl() {
        const link = selectedLink();
        if (link) win.history.replaceState(win.history.state, '', link);
        return link;
    }
    function clearBlockUrl() {
        const url = new URL(win.location.href);
        for (const key of ['block', 'blockBounds', 'blockSize']) url.searchParams.delete(key);
        win.history.replaceState(win.history.state, '', url);
    }
    async function copyBlockLink() {
        const link = updateBlockUrl();
        if (!link) return;
        try {
            await win.navigator.clipboard.writeText(link);
            win.showEphemeralMessage(t('linkCopied', 'Block link copied.'));
        } catch (error) {
            console.warn(`[${new Date().toISOString()}] [urban-blocks] Could not copy block link: ${error.message}`);
            win.showEphemeralMessage(t('copyFailed', 'Could not copy. Copy the link from your browser’s address bar.'));
        }
    }

    function ownsClicks() {
        return controller.snapshot().enabled && !win.__mapEditLock?.isHeld() && !win.measureMode
            && !win.roadDrawingMode && !win.isParcelDrawingModeActive?.()
            && !win.isStructureGeometryEditorActive?.() && !win.isTransitStationGeometryEditorActive?.()
            && !win.isTransitStationPlacementActive?.() && !win.AreaMonitorPaint?.isActive()
            && !win.sharePlanMode && !win.pinpointToolIsActive?.();
    }

    function fitSelected() {
        if (!selected || fitting || el('urban-block-panel').hidden) return;
        fitting = true;
        try {
            // Leaflet can still cache the previous viewport height during a phone resize. Fit
            // only after its projection size agrees with the DOM used to measure the sheet.
            win.map.invalidateSize({ pan: false, animate: false });
            const obstacles = [];
            const add = (selector, edge) => doc.querySelectorAll(selector).forEach(node => {
                if (!node.getClientRects().length) return;
                const rect = node.getBoundingClientRect();
                if (rect.width && rect.height) obstacles.push({ edge, rect });
            });
            add('#map-search-slot, #username-display, #map-shell-top-right', 'top');
            add('#map-shell-bottom-right, .leaflet-bottom', 'bottom');
            add('.map-mode-toggle, .map-mode-walk-btn, .map-mode-realistic-btn, .map-mode-ai-btn', 'left');
            add('#urban-block-panel', win.matchMedia('(max-width: 767.98px)').matches ? 'bottom' : 'right');
            const padding = win.UrbanBlocksLayout.fitPadding(win.map.getContainer().getBoundingClientRect(), obstacles);
            if (!padding) return;
            // Synchronous framing keeps moveend from triggering another road load. Parcel
            // viewport listeners still run normally, and the selected polygon stays available.
            win.map.fitBounds(selectionLayer.getBounds(), { ...padding, maxZoom: 19, animate: false });
        } finally { fitting = false; }
    }

    function updateCollapse() {
        const collapsed = el('urban-block-panel').classList.contains('is-collapsed');
        const button = el('urban-block-collapse');
        const icon = doc.createElement('i');
        icon.className = `fas fa-chevron-${collapsed ? 'up' : 'down'}`;
        icon.setAttribute('aria-hidden', 'true');
        button.replaceChildren(icon);
        button.title = button.ariaLabel = t(collapsed ? 'expand' : 'collapse', collapsed ? 'Expand block details' : 'Collapse block details');
        button.setAttribute('aria-expanded', String(!collapsed));
    }

    function updateParcelCount() {
        if (!selected || !el('urban-block-parcels-value')) return;
        let count = null;
        // Failure or absence of optional parcel data must never prevent geometry inspection.
        try {
            count = win.UrbanBlocksModel.loadedParcelCount(selected, win.CadastralParcelRepository?.list?.() || [], win.turf);
        } catch (error) {
            console.warn(`[${new Date().toISOString()}] [urban-blocks] Optional parcel count unavailable: ${error.message}`);
        }
        el('urban-block-parcels-label').hidden = el('urban-block-parcels-value').hidden = count === null;
        el('urban-block-parcels-value').textContent = count === null ? '' : format(count);
    }

    function targetContent(feature) {
        const section = doc.createElement('div'); section.className = 'urban-block-target';
        const summary = doc.createElement('div'); summary.className = 'urban-block-target-summary';
        const result = doc.createElement('strong'); result.setAttribute('aria-live', 'polite');
        const preview = doc.createElement('button');
        preview.id = 'urban-block-see-how'; preview.type = 'button'; preview.className = 'btn';
        preview.disabled = true;
        preview.textContent = t('seeHow', 'See how');
        preview.title = t('seeHowSoon', 'Block layout preview is coming soon.');
        summary.append(result, preview);
        const label = doc.createElement('label'); label.textContent = t('targetSize', 'Target block size');
        const input = doc.createElement('select'); input.id = 'urban-block-target-size';
        for (const size of [50, 100, 150, 200]) {
            const option = doc.createElement('option'); option.value = size;
            option.textContent = `${format(size)} × ${format(size)} m`;
            input.append(option);
        }
        input.value = targetSideM;
        const update = () => {
            targetSideM = Number(input.value);
            const count = win.UrbanBlocksModel.targetBlockCount(feature.properties.areaM2, targetSideM);
            result.textContent = count > 1
                ? t('targetCount', 'This should be {{count}} blocks instead', { count: format(count) })
                : t('targetOne', 'This fits within one target block');
        };
        input.addEventListener('change', () => { update(); updateBlockUrl(); }); update();
        const note = doc.createElement('p'); note.className = 'urban-block-info-note';
        note.textContent = t('targetNote', 'Area ÷ target area, rounded up. A size comparison; new streets and block shape will affect a real subdivision.');
        label.append(input); section.append(summary, label, note);
        return section;
    }

    function infoContent(feature) {
        const content = doc.createElement('div');
        const stats = doc.createElement('dl');
        const p = feature.properties;
        const add = (label, value, id) => {
            const dt = doc.createElement('dt'), dd = doc.createElement('dd');
            if (id) { dt.id = `${id}-label`; dd.id = `${id}-value`; }
            dt.textContent = label; dd.textContent = value; stats.append(dt, dd);
        };
        add(t('area', 'Block area'), `${format(p.areaM2)} m² · ${format(p.areaM2 / 10000, 2)} ha`);
        add(t('perimeter', 'Outer perimeter'), `${format(p.perimeterM)} m`);
        add(t('walk', 'Walk around'), t('minutes', '≈ {{minutes}} min at 5 km/h', { minutes: format(p.walkMinutes, 1) }));
        add(t('compactness', 'Compactness'), `${format(p.compactness * 100)}%`);
        add(t('parcels', 'Loaded parcels'), '', 'urban-block-parcels');
        content.append(stats, targetContent(feature));
        if (p.streets.length) {
            const streets = doc.createElement('p'); streets.textContent = p.streets.join(' · '); content.append(streets);
        }
        const note = doc.createElement('p'); note.className = 'urban-block-info-note';
        note.textContent = t('measurementNote', 'Measured between OSM road centrelines, including street space. Walking time is a perimeter estimate, not a routed walk.');
        content.append(note);
        return content;
    }

    function renderInfo() {
        if (!selected) return;
        el('urban-block-panel-title').textContent = t('blockTitle', 'Urban block');
        el('urban-block-panel-summary').textContent = `${format(selected.properties.areaM2)} m² · ${format(selected.properties.walkMinutes, 1)} min`;
        el('urban-block-panel-body').replaceChildren(infoContent(selected));
        updateParcelCount(); updateCollapse();
    }

    function selectAt(latlng) {
        if (!ownsClicks()) return;
        const point = win.turf.point([latlng.lng, latlng.lat]);
        const feature = controller.snapshot().blocks?.features.find(block => win.turf.booleanPointInPolygon(point, block))
            || (selected && win.turf.booleanPointInPolygon(point, selected) ? selected : null);
        if (linkedBlock) clearBlockUrl();
        linkedBlock = null;
        showBlock(feature);
    }

    function showBlock(feature) {
        clearSelection();
        if (!feature) return;
        win.MapShell?.closeSheets?.();
        win.ParcelMenu?.close?.(); win.GroundMenu?.close?.();
        win.hideParcelInfoPanel?.(); win.__drillUi?.hidePanel?.();
        selected = feature;
        layer?.setStyle(style);
        selectionLayer = win.L.geoJSON(feature, { pane: PANE, interactive: false,
            style: { color: '#173954', weight: 3, fillColor: feature.properties.color, fillOpacity: 0.65 } }).addTo(win.map);
        el('urban-block-panel').classList.remove('is-collapsed');
        el('urban-block-panel').hidden = false;
        renderInfo(); fitSelected(); updateBlockUrl();
    }

    function captureClick(event) {
        if (!ownsClicks()) return;
        if (event.target.closest?.('.leaflet-control, .leaflet-popup, .leaflet-tooltip')) return;
        if (!event.target.closest?.('.leaflet-pane') && event.target !== win.map.getContainer()) return;
        event.stopImmediatePropagation();
        selectAt(win.map.mouseEventToLatLng(event));
    }

    function initialize() {
        if (wired) return;
        wired = true;
        el('showUrbanBlocks').addEventListener('change', () => {
            linkedBlock = null;
            clearBlockUrl();
            controller.setEnabled(el('showUrbanBlocks').checked);
            const url = new URL(win.location.href);
            if (controller.snapshot().enabled) url.searchParams.set('blocks', '1');
            else url.searchParams.delete('blocks');
            win.history.replaceState(win.history.state, '', url);
            if (controller.snapshot().enabled) {
                win.ParcelMenu?.close?.(); win.GroundMenu?.close?.(); win.hideParcelInfoPanel?.();
                refresh();
            }
        });
        el('urban-blocks-refresh').addEventListener('click', () => refresh(true));
        el('urban-block-close').addEventListener('click', clearSelection);
        el('urban-block-copy').addEventListener('click', copyBlockLink);
        el('urban-block-fit').addEventListener('click', fitSelected);
        el('urban-block-collapse').addEventListener('click', () => {
            el('urban-block-panel').classList.toggle('is-collapsed');
            updateCollapse(); fitSelected();
        });
        win.map.on('moveend', () => { if (!fitting) refresh(); });
        win.map.on('resize', fitSelected);
        const resizeObserver = new win.ResizeObserver(fitSelected);
        resizeObserver.observe(el('urban-block-panel'));
        resizeObserver.observe(win.map.getContainer());
        win.addEventListener('parcelFabricCommitted', updateParcelCount);
        win.addEventListener('cityChanged', () => {
            if (linkedBlock?.city && linkedBlock.city !== win.CityConfigManager.getCurrentCityId()) {
                linkedBlock = null;
                clearBlockUrl();
            }
            controller.setEnabled(el('showUrbanBlocks').checked);
            if (controller.snapshot().enabled) refresh();
        });
        win.map.getContainer().addEventListener('click', captureClick, true);
        const translate = () => { render(controller.snapshot()); renderInfo(); };
        win.addEventListener('i18n:translationsLoaded', translate);
        win.i18n?.onChange?.(translate);
        render(controller.snapshot());
        if (linkedBlock || new URLSearchParams(win.location.search).get('blocks') === '1') {
            el('showUrbanBlocks').checked = true;
            controller.setEnabled(true); refresh();
        }
    }
    win.UrbanBlocksView = { initialize, isEnabled: () => controller.snapshot().enabled, ownsClicks, selectAt,
        refresh: () => refresh(true), snapshot: controller.snapshot };
})(typeof window !== 'undefined' ? window : null);
