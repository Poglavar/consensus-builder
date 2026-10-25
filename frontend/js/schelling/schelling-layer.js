// The Schelling plan layer: the meridians-and-parallels plan (parcels/schelling-grid.js) drawn over
// any map, over a parcel register or where there is none. Layers only switches it on; its settings
// are in its own panel (#schelling-panel), open exactly while the plan is shown, and in the address
// bar (?schelling=, schelling-settings.js), remembered per viewer. Folding the panel keeps the plan
// drawn, closing it hides the plan. "Propose from this plan" opens the painting tool
// (schelling-propose.js) in the panel's spot. Drawing only: the layer never takes clicks.
(function (win) {
    'use strict';
    if (!win?.document) return;

    const doc = win.document;
    const PANE = 'schellingPlanPane';
    const STORAGE_KEY = 'cb.schelling.settings';
    const PARAM = 'schelling';
    // Below these zooms the plan would be thousands of shapes: arterials first, then streets and
    // blocks, then plots.
    const ZOOM = Object.freeze({ arterials: 11, streets: 15, plots: 17 });
    const state = { enabled: false, settings: null, planAt: null, layer: null, renderer: null, wired: false };
    const el = id => doc.getElementById(id);
    const storage = () => win.BrowserWorkspace?.storage || win.localStorage;

    function t(key, fallback, params) {
        const text = win.i18n?.t?.(`schellingPlan.${key}`, params);
        if (text && text !== `schellingPlan.${key}`) return text;
        return fallback.replace(/\{\{(\w+)\}\}/g, (_, name) => String(params?.[name] ?? ''));
    }
    const number = (value, digits = 0) => win.CbFormat?.formatNumber(value, { maxFractionDigits: digits })
        ?? new Intl.NumberFormat(doc.documentElement.lang || 'en', { maximumFractionDigits: digits }).format(value);

    function readStored() {
        try { return JSON.parse(storage().getItem(STORAGE_KEY) || 'null'); } catch (_) { return null; }
    }
    function writeStored(settings) {
        try { storage().setItem(STORAGE_KEY, JSON.stringify(settings)); } catch (_) { /* storage blocked: settings stay for this page */ }
    }

    function writeAddress() {
        const url = new URL(win.location.href);
        if (state.enabled) url.searchParams.set(PARAM, win.SchellingSettings.format(state.settings));
        else url.searchParams.delete(PARAM);
        win.history.replaceState(win.history.state, '', url);
    }

    function setSettings(next) {
        state.settings = win.SchellingSettings.normalize(next);
        state.planAt = win.SchellingGrid.plansFor(state.settings);
        writeStored(state.settings);
        if (state.enabled) writeAddress();
        syncControls();
        render();
        doc.dispatchEvent(new win.CustomEvent('schelling-plan-change', { detail: { settings: { ...state.settings } } }));
    }

    function setEnabled(value) {
        state.enabled = !!value;
        el('showSchellingPlan').checked = state.enabled;
        writeAddress();
        render();
        el('schelling-panel').hidden = !state.enabled;
        if (state.enabled) setCollapsed(false);
        else win.SchellingPropose?.close();
    }

    // ---- the panel -----------------------------------------------------------------------------

    // The fold control speaks the on-map editors' words, as it is their control.
    function editorText(key, fallback) {
        const text = win.i18n?.t?.(`onMapEditor.${key}`);
        return text && text !== `onMapEditor.${key}` ? text : fallback;
    }

    // Folding hides the settings only: the plan stays drawn and Propose stays at hand.
    function setCollapsed(value) {
        const collapsed = value === true;
        const toggle = el('schelling-panel-collapse');
        if (collapsed && el('schelling-panel-body').contains(doc.activeElement)) toggle.focus({ preventScroll: true });
        el('schelling-panel-body').hidden = collapsed;
        el('schelling-panel').classList.toggle('is-collapsed', collapsed);
        toggle.setAttribute('aria-expanded', String(!collapsed));
        const label = collapsed ? editorText('showControls', 'Show controls') : editorText('hideControls', 'Hide controls');
        toggle.setAttribute('aria-label', label);
        toggle.title = label;
    }

    const planHere = () => state.planAt(win.SchellingGrid.bandOf(win.map.getCenter().lat));

    // ---- drawing ---------------------------------------------------------------------------------

    function ensureLayer() {
        if (state.layer) return;
        const pane = win.map.getPane(PANE) || win.map.createPane(PANE);
        pane.classList.add('schelling-plan-pane');
        state.renderer = win.L.svg({ pane: PANE });
        state.layer = win.L.layerGroup().addTo(win.map);
    }

    function viewBox() {
        const bounds = win.map.getBounds().pad(0.1);
        return [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()];
    }

    function render() {
        if (!win.map || !win.SchellingGrid) return;
        ensureLayer();
        state.layer.clearLayers();
        if (!state.enabled) { renderStatus(''); return; }
        const zoom = win.map.getZoom();
        if (zoom < ZOOM.arterials) { renderStatus(t('zoomIn', 'Zoom in to see the plan.')); return; }
        const grid = win.SchellingGrid;
        const box = viewBox();
        // One GeoJSON layer per class: a path's class is fixed when it is created.
        const draw = (features, className) => {
            if (features.length) state.layer.addLayer(win.L.geoJSON({ type: 'FeatureCollection', features },
                { pane: PANE, renderer: state.renderer, interactive: false, className }));
        };
        try {
            if (zoom < ZOOM.streets) {
                draw(grid.inBands(state.planAt, box, grid.arterialLinesInBbox), 'schelling-plan__arterial-line');
                renderStatus(t('zoomForStreets', 'Arterials only at this scale; zoom in for the local streets and blocks.'));
                return;
            }
            const pieces = grid.inBands(state.planAt, box, grid.featuresInBbox);
            draw(pieces.filter(feature => feature.properties.kind === 'block'), 'schelling-plan__block');
            draw(pieces.filter(feature => feature.properties.roadClass === 'local'), 'schelling-plan__street is-local');
            draw(pieces.filter(feature => feature.properties.roadClass === 'arterial'), 'schelling-plan__street is-arterial');
            if (state.settings.plotLevel !== null && zoom >= ZOOM.plots) {
                draw(grid.inBands(state.planAt, box, (plan, part) => grid.plotsInBbox(plan, part, state.settings.plotLevel)), 'schelling-plan__plot');
                renderStatus('');
            } else {
                renderStatus(state.settings.plotLevel === null ? '' : t('zoomForPlots', 'Zoom in further to see the plots.'));
            }
        } catch (error) {
            if (!(error instanceof RangeError)) throw error;
            state.layer.clearLayers();
            renderStatus(t('tooLarge', 'The plan cannot be drawn here: {{reason}}', { reason: error.message }));
        }
    }

    // ---- the settings --------------------------------------------------------------------------

    function renderStatus(message) {
        const node = el('schelling-plan-status');
        if (node) node.textContent = message;
    }

    function syncControls() {
        if (!el('schelling-plan-block')) return;
        const settings = state.settings;
        el('schelling-plan-block').value = String(settings.targetBlockM);
        el('schelling-plan-street').value = String(settings.streetWidthM);
        el('schelling-plan-plots').value = String(win.SchellingSettings.denominatorOfLevel(settings.plotLevel));
        el('schelling-plan-block-value').textContent = `${number(settings.targetBlockM)} m`;
        el('schelling-plan-street-value').textContent = `${number(settings.streetWidthM)} m`;
        renderFacts();
    }

    // The numbers of the plan where the map is: the fixed arterials, the blocks the settings make,
    // the plot size, and why the fixed part is fixed.
    function renderFacts() {
        if (!win.map || !el('schelling-plan-fixed')) return;
        let plan;
        try { plan = planHere(); } catch (error) {
            el('schelling-plan-fixed').textContent = String(error.message);
            return;
        }
        const d = win.SchellingGrid.describe(plan, win.map.getCenter());
        el('schelling-plan-fixed').textContent = t('fixed', 'Arterials every {{stepLon}}″ of longitude and {{stepLat}}″ of latitude here ({{spacingLon}} × {{spacingLat}} m), {{width}} m wide. They are fixed: that is what makes this plan the same for everyone.', {
            stepLon: d.arterialStepLonSec, stepLat: d.arterialStepLatSec, spacingLon: number(d.arterialSpacingLonM), spacingLat: number(d.arterialSpacingLatM), width: d.arterialWidthM
        });
        const plot = win.SchellingGrid.plotSize(plan, state.settings.plotLevel);
        el('schelling-plan-blocks').textContent = t('blocks', '{{nLon}} × {{nLat}} blocks to a superblock, {{width}} × {{depth}} m each.', {
            nLon: d.nLon, nLat: d.nLat, width: number(d.blockWidthM), depth: number(d.blockDepthM)
        });
        el('schelling-plan-plot-size').textContent = state.settings.plotLevel === null
            ? t('wholeBlocks', 'Whole blocks, no plots.')
            : t('plotSize', 'Plots of {{frontage}} × {{depth}} m ({{area}} m²), facing the north and south streets.', {
                frontage: number(plot.frontageM, 1), depth: number(plot.depthM), area: number(plot.areaM2)
            });
        el('schelling-plan-code').textContent = t('code', 'Plan {{code}}', { code: plan.code });
        el('schelling-plan-why').textContent = [
            t('whyAngel', 'Shlomo Angel and colleagues (Making Room for a Planet of Cities, 2011) argue that a growing city should fix its arterial roads before the land is built on: about 30 m wide and about 1 km apart, so that every point is within a ten-minute walk of a road that can carry public transport.'),
            t('whyGraticule', 'Here the arterials follow the meridians and parallels, counted from Greenwich and the Equator, on the whole-arcsecond step closest to 1 km. Anyone with a GPS fix gets the same lines, so two strangers arrive at the same plan.'),
            t('whyLocal', 'The local streets divide each superblock evenly; their spacing and width, and the plot size, are yours to choose.')
        ].join(' ');
    }

    function wire() {
        // Switched on from Layers, the plan's panel takes the sheet's place.
        el('showSchellingPlan').addEventListener('change', event => {
            setEnabled(event.target.checked);
            if (!state.enabled) return;
            win.MapShell?.closeSheet?.({ restoreFocus: false });
            el('schelling-panel-title').focus({ preventScroll: true });
        });
        // The whole header folds the panel, as an editor's does; the chevron is its keyboard handle.
        el('schelling-panel').querySelector('.on-map-editor__header').addEventListener('click', event => {
            if (event.target.closest('#schelling-panel-close')) return;
            setCollapsed(!el('schelling-panel-body').hidden);
        });
        el('schelling-panel-close').addEventListener('click', () => setEnabled(false));
        el('schelling-plan-block').addEventListener('input', event => setSettings({ ...state.settings, targetBlockM: Number(event.target.value) }));
        el('schelling-plan-street').addEventListener('input', event => setSettings({ ...state.settings, streetWidthM: Number(event.target.value) }));
        el('schelling-plan-plots').addEventListener('change', event => setSettings({
            ...state.settings, plotLevel: win.SchellingSettings.levelOfDenominator(Number(event.target.value))
        }));
        el('schelling-plan-propose').addEventListener('click', () => win.SchellingPropose.open());
        win.map.on('moveend', () => { render(); renderFacts(); });
        const translate = () => { syncControls(); render(); setCollapsed(el('schelling-panel-body').hidden); };
        win.addEventListener('i18n:translationsLoaded', translate);
        win.i18n?.onChange?.(translate);
    }

    function initialize() {
        if (state.wired || !win.map || !el('showSchellingPlan')) return;
        state.wired = true;
        const fromAddress = win.SchellingSettings.parse(new URLSearchParams(win.location.search).get(PARAM));
        state.settings = win.SchellingSettings.normalize(fromAddress || readStored() || win.SchellingSettings.DEFAULTS);
        state.planAt = win.SchellingGrid.plansFor(state.settings);
        state.enabled = !!fromAddress;
        el('showSchellingPlan').checked = state.enabled;
        el('schelling-panel').hidden = !state.enabled;
        setCollapsed(false);
        wire();
        // The facts and the drawing read the map centre, which exists once the map has a view.
        win.map.whenReady(() => { syncControls(); render(); });
    }

    win.SchellingLayer = Object.freeze({
        initialize,
        setEnabled,
        isEnabled: () => state.enabled,
        settings: () => ({ ...state.settings }),
        planAt: band => state.planAt(band),
        planHere: () => planHere()
    });
})(typeof window !== 'undefined' ? window : null);
