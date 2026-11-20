// The Schelling plan layer, drawn over any map, over a parcel register or where there is none, in
// one of two types picked in its panel: the meridians-and-parallels plan (parcels/schelling-grid.js,
// the default) or a Burning Man city round a Man the author places (burning-man-plan.js). Layers
// only switches it on; its settings are in its own panel (#schelling-panel), open exactly while the
// plan is shown, and in the address bar (?schelling=, schelling-settings.js), remembered per viewer.
// Folding the panel keeps the plan drawn, closing it hides the plan. "Propose from this plan" opens
// the painting tool (schelling-propose.js) in the panel's spot. Drawing only: the layer never takes clicks.
(function (win) {
    'use strict';
    if (!win?.document) return;

    const doc = win.document;
    const PANE = 'schellingPlanPane';
    const STORAGE_KEY = 'cb.schelling.settings';
    const PARAM = 'schelling';
    const BURNING_MAN = 'burning-man';
    // Below these zooms the plan would be thousands of shapes: arterials first, then streets and
    // blocks, then plots. A Burning Man city is one city, drawn as centre lines below the streets' zoom.
    const ZOOM = Object.freeze({ arterials: 11, streets: 15, plots: 17 });
    // The painting tool's view of the meridian plan; a Burning Man plan's module offers the same.
    // The grid loads after this file, so it is looked up when used.
    const MERIDIANS = Object.freeze({
        cellsInBbox: (plan, box, limit) => win.SchellingGrid.cellsInBbox(plan, box, limit),
        blockOf: (plan, i, j) => win.SchellingGrid.blockOf(plan, i, j),
        defaultCells: (plan, lat, lng) => win.SchellingStreets.defaultCells(plan, lat, lng),
        streetsOf: (plan, cells) => win.SchellingStreets.streetsOf(plan, cells),
        streetPolygon: (plan, street) => win.SchellingStreets.streetPolygon(plan, street),
        summary: (plan, cells) => win.SchellingStreets.summary(plan, cells),
        importForm: (plan, cells, options) => win.SchellingStreets.importForm(plan, cells, options)
    });
    const state = { enabled: false, settings: null, planAt: null, manPlan: null, manError: null, layer: null, renderer: null, wired: false };
    const isBurningMan = () => state.settings?.type === BURNING_MAN;
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

    // A Burning Man city needs its Man: he stands where the map is until the author moves him.
    function withMan(settings) {
        if (settings.type !== BURNING_MAN || settings.burningMan.centre || !win.map) return settings;
        const { lat, lng } = win.map.getCenter();
        return win.SchellingSettings.merge(settings, { burningMan: { centre: { lat, lng } } });
    }

    function rebuild() {
        state.planAt = win.SchellingGrid.plansFor(state.settings);
        state.manPlan = null;
        state.manError = null;
        if (!isBurningMan() || !state.settings.burningMan.centre) return;
        try {
            state.manPlan = win.BurningManPlan.planFor(state.settings.burningMan);
        } catch (error) {
            if (!(error instanceof RangeError)) throw error;
            state.manError = error.message;
        }
    }

    // The whole city in view, when the type is chosen or the city is out of sight.
    function frameCity() {
        const plan = state.manPlan;
        if (!plan || !win.map) return;
        const { lat, lng } = plan.centre;
        const dLat = plan.outerRadiusM / plan.metersPerDegree.lat;
        const dLng = plan.outerRadiusM / plan.metersPerDegree.lon;
        win.map.fitBounds([[lat - dLat, lng - dLng], [lat + dLat, lng + dLng]]);
    }

    function setSettings(next) {
        state.settings = withMan(win.SchellingSettings.normalize(next));
        rebuild();
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

    // The plan the map shows: the Burning Man city, or the meridian plan of the band at the map centre.
    const planHere = () => (isBurningMan() ? state.manPlan : state.planAt(win.SchellingGrid.bandOf(win.map.getCenter().lat)));

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

    // One GeoJSON layer per class: a path's class is fixed when it is created.
    function draw(features, className) {
        if (features.length) state.layer.addLayer(win.L.geoJSON({ type: 'FeatureCollection', features },
            { pane: PANE, renderer: state.renderer, interactive: false, className }));
    }

    // A Burning Man city: the Man at every scale, centre lines when far out (the arterials as the
    // meridian plan draws its own), then the street land and blocks, then plots.
    function renderBurningMan(zoom, box) {
        const plan = state.manPlan;
        if (!plan) { renderStatus(state.manError ? t('tooLarge', 'The plan cannot be drawn here: {{reason}}', { reason: state.manError }) : ''); return; }
        const man = win.BurningManPlan;
        const ofClass = (features, roadClass) => features.filter(feature => feature.properties.roadClass === roadClass);
        if (zoom < ZOOM.streets) {
            const lines = man.centreLines(plan);
            draw(ofClass(lines, 'local'), 'schelling-plan__line');
            draw(ofClass(lines, 'arterial'), 'schelling-plan__arterial-line');
            renderStatus(t('burningMan.zoomForStreets', 'Street centre lines only at this scale; zoom in for the street land and blocks.'));
        } else {
            const streets = man.streetFeatures(plan, box);
            draw(man.blocksInBbox(plan, box), 'schelling-plan__block');
            draw(ofClass(streets, 'local'), 'schelling-plan__street is-local');
            draw(ofClass(streets, 'arterial'), 'schelling-plan__street is-arterial');
            const plots = state.settings.plotLevel !== null && zoom >= ZOOM.plots;
            if (plots) draw(man.plotsInBbox(plan, box, state.settings.plotLevel), 'schelling-plan__plot');
            renderStatus(plots || state.settings.plotLevel === null ? '' : t('zoomForPlots', 'Zoom in further to see the plots.'));
        }
        state.layer.addLayer(win.L.circleMarker([plan.centre.lat, plan.centre.lng],
            { pane: PANE, renderer: state.renderer, interactive: false, radius: 7, className: 'schelling-plan__man' }));
    }

    function render() {
        if (!win.map || !win.SchellingGrid) return;
        ensureLayer();
        state.layer.clearLayers();
        if (!state.enabled) { renderStatus(''); return; }
        const zoom = win.map.getZoom();
        const box = viewBox();
        if (isBurningMan()) { renderBurningMan(zoom, box); return; }
        if (zoom < ZOOM.arterials) { renderStatus(t('zoomIn', 'Zoom in to see the plan.')); return; }
        const grid = win.SchellingGrid;
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
        const man = settings.burningMan;
        el('schelling-plan-type').value = settings.type;
        el('schelling-plan-meridians').hidden = isBurningMan();
        el('schelling-plan-burning-man').hidden = !isBurningMan();
        el('schelling-plan-block').value = String(settings.targetBlockM);
        el('schelling-plan-street').value = String(settings.streetWidthM);
        el('schelling-plan-plots').value = String(win.SchellingSettings.denominatorOfLevel(settings.plotLevel));
        el('schelling-plan-block-value').textContent = `${number(settings.targetBlockM)} m`;
        el('schelling-plan-street-value').textContent = `${number(settings.streetWidthM)} m`;
        el('schelling-plan-esplanade').value = String(man.esplanadeM);
        el('schelling-plan-rings').value = String(man.rings);
        el('schelling-plan-depth').value = String(man.blockDepthM);
        el('schelling-plan-man-street').value = String(man.streetWidthM);
        el('schelling-plan-bearing').value = String(man.bearingDeg);
        el('schelling-plan-esplanade-value').textContent = `${number(man.esplanadeM)} m`;
        el('schelling-plan-rings-value').textContent = `A–${win.BurningManPlan.ringName(man.rings)}`;
        el('schelling-plan-depth-value').textContent = `${number(man.blockDepthM)} m`;
        el('schelling-plan-man-street-value').textContent = `${number(man.streetWidthM)} m`;
        el('schelling-plan-bearing-value').textContent = `${number(man.bearingDeg)}°`;
        renderFacts();
    }

    // The numbers of a Burning Man city: where the Man stands, the rings and radials, the blocks,
    // the plots, and where the idea comes from.
    function renderManFacts() {
        const plan = state.manPlan;
        const plotLevel = state.settings.plotLevel;
        if (!plan) {
            el('schelling-plan-man').textContent = state.manError || '';
            ['schelling-plan-man-layout', 'schelling-plan-man-arterials', 'schelling-plan-man-blocks', 'schelling-plan-plot-size', 'schelling-plan-code'].forEach(id => { el(id).textContent = ''; });
            return;
        }
        const man = win.BurningManPlan;
        const d = man.describe(plan);
        el('schelling-plan-man').textContent = t('burningMan.man', 'The Man stands at {{lat}}, {{lng}}; 12:00 points {{bearing}}° from north.', {
            lat: d.lat, lng: d.lng, bearing: number(d.bearingDeg)
        });
        el('schelling-plan-man-layout').textContent = [
            t('burningMan.rings', 'The Esplanade {{esplanade}} m from the Man, then ring streets A to {{last}}, out to {{outer}} m.', {
                esplanade: number(d.esplanadeM), last: d.lastRing, outer: number(d.outerRadiusM)
            }),
            t('burningMan.radials', 'Radial streets every half hour from 2:00 to 10:00; the open playa lies between 10:00 and 2:00.'),
            d.quarterHoursFrom ? t('burningMan.quarterHours', 'Quarter-hour streets from ring {{ring}} outward, where the blocks have doubled in length.', { ring: d.quarterHoursFrom }) : ''
        ].filter(Boolean).join(' ');
        el('schelling-plan-man-arterials').textContent = t('burningMan.arterials', 'Arterials {{width}} m wide, about 1 km apart: the rings {{rings}} and the radials at {{radials}}. They are fixed: a good city plan needs them, whatever its shape.', {
            width: number(d.arterialWidthM), rings: d.arterialRings.join(', '), radials: d.arterialRadials.join(', ')
        });
        el('schelling-plan-man-blocks').textContent = t('burningMan.blocks', '{{count}} blocks, {{depth}} m deep and {{shortest}} to {{longest}} m along their ring streets.', {
            count: number(d.blocks), depth: number(d.blockDepthM), shortest: number(d.shortestFaceM), longest: number(d.longestFaceM)
        });
        const plot = man.plotSize(plan, plotLevel);
        el('schelling-plan-plot-size').textContent = plotLevel === null
            ? t('wholeBlocks', 'Whole blocks, no plots.')
            : t('burningMan.plotSize', 'Plots of about {{frontage}} × {{depth}} m ({{area}} m²) by the Esplanade, facing the ring streets; wider further out.', {
                frontage: number(plot.frontageM, 1), depth: number(plot.depthM), area: number(plot.areaM2)
            });
        el('schelling-plan-code').textContent = t('code', 'Plan {{code}}', { code: plan.code });
        el('schelling-plan-why').textContent = [
            t('whyAngel', 'Shlomo Angel and colleagues (Making Room for a Planet of Cities, 2011) argue that a growing city should fix its arterial roads before the land is built on: about 30 m wide and about 1 km apart, so that every point is within a ten-minute walk of a road that can carry public transport.'),
            t('burningMan.whyArterials', 'In this city they are the Esplanade and every ring about 1 km further out, and the radials on the clock step whose spacing at the city’s edge is nearest 1 km.'),
            t('burningMan.whyCity', 'After Black Rock City, the city the Burning Man festival builds every year in the Nevada desert: ring streets round the Man and radial streets named by the hours of a clock, so every address is a time and a letter (4:30 and C) that anyone can find without a map.'),
            t('burningMan.whyClock', 'The city takes the clock from 2:00 to 10:00 and leaves the playa open towards 12:00. Where a block has grown to twice its length at the Esplanade, quarter-hour streets divide it.'),
            t('burningMan.whyChoices', 'Where the Man stands, how far out the Esplanade lies, how many ring streets follow it, the block depth, the local street width, where 12:00 points and the plot size are yours to choose.')
        ].join(' ');
    }

    // The numbers of the plan where the map is: the fixed arterials, the blocks the settings make,
    // the plot size, and why the fixed part is fixed.
    function renderFacts() {
        if (!win.map || !el('schelling-plan-fixed')) return;
        if (isBurningMan()) { renderManFacts(); return; }
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
        // Choosing Burning Man shows its whole city; the meridian plan is everywhere already.
        el('schelling-plan-type').addEventListener('change', event => {
            setSettings({ ...state.settings, type: event.target.value });
            if (isBurningMan()) frameCity();
        });
        const manSetting = (id, field) => el(id).addEventListener('input', event => setSettings({
            ...state.settings, burningMan: { ...state.settings.burningMan, [field]: Number(event.target.value) }
        }));
        manSetting('schelling-plan-esplanade', 'esplanadeM');
        manSetting('schelling-plan-rings', 'rings');
        manSetting('schelling-plan-depth', 'blockDepthM');
        manSetting('schelling-plan-man-street', 'streetWidthM');
        manSetting('schelling-plan-bearing', 'bearingDeg');
        el('schelling-plan-man-here').addEventListener('click', () => {
            const { lat, lng } = win.map.getCenter();
            setSettings({ ...state.settings, burningMan: { ...state.settings.burningMan, centre: { lat, lng } } });
        });
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
        // What the address says, over what this viewer had (their Man stays where they put him).
        state.settings = win.SchellingSettings.merge(readStored(), fromAddress);
        rebuild();
        state.enabled = !!fromAddress;
        el('showSchellingPlan').checked = state.enabled;
        el('schelling-panel').hidden = !state.enabled;
        setCollapsed(false);
        wire();
        // The facts and the drawing read the map centre, which exists once the map has a view; a
        // Burning Man city without its Man gets him there.
        win.map.whenReady(() => {
            if (isBurningMan() && !state.settings.burningMan.centre) setSettings(state.settings);
            syncControls();
            render();
        });
    }

    win.SchellingLayer = Object.freeze({
        initialize,
        setEnabled,
        isEnabled: () => state.enabled,
        settings: () => ({ ...state.settings }),
        planAt: band => state.planAt(band),
        planHere: () => planHere(),
        // The plan type's cells, blocks and streets, for the painting tool.
        kind: () => (isBurningMan() ? win.BurningManPlan : MERIDIANS)
    });
})(typeof window !== 'undefined' ? window : null);
