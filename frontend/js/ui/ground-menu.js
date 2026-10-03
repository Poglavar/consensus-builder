// ui/ground-menu.js — the ground menu: the sibling of the parcel menu that a map click opens where
// there is no parcel (an unsurveyed hole, a gap between parcels, or anywhere in a city without a
// cadastre). Same component family and styling as ui/parcel-menu.js (a popover at the click point,
// a bottom-sheet peek on phones); its actions are the UiCommands of the 'ground-menu' surface:
// "Draw a site here" (js/site-drawing.js) and the transport tools that need no selection. Which
// ground a click hit is decided by the pure ui/ground-menu-model.js; "not loaded yet" never opens it.
(function (win) {
    'use strict';

    const doc = win.document;
    const model = win.GroundMenuModel;
    const MOBILE_QUERY = '(max-width: 767.98px)';
    const PANEL_IDS = ['parcel-info-panel', 'proposal-details-panel', 'block-info-panel', 'road-info-panel', 'road-analysis-panel'];

    const state = { el: null, latlng: null, facts: null, wired: false };

    const t = (key, fallback, params) => {
        const i18n = win.i18n;
        if (i18n && typeof i18n.t === 'function') {
            const value = i18n.t(key, params || {});
            if (typeof value === 'string' && value && value !== key) return value;
        }
        if (!params) return fallback;
        return String(fallback).replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name) => (name in params ? params[name] : match));
    };
    const log = (...args) => console.info(`[${new Date().toISOString()}] [GroundMenu]`, ...args);

    const isMobile = () => !!(win.matchMedia && win.matchMedia(MOBILE_QUERY).matches);
    const isOpen = () => !!(state.el && !state.el.hidden);

    function ensureElement() {
        if (state.el) return state.el;
        const host = doc.getElementById('map-container') || doc.body;
        const el = doc.createElement('div');
        el.id = 'ground-menu';
        el.className = 'parcel-menu ground-menu';
        el.hidden = true;
        el.tabIndex = -1;
        el.setAttribute('role', 'group');
        el.innerHTML = `
            <div class="parcel-menu__head">
                <div class="parcel-menu__title"></div>
                <button type="button" class="parcel-menu__close close-circle-btn" data-ground-menu-close>×</button>
            </div>
            <div class="parcel-menu__facts"></div>
            <div class="parcel-menu__actions" role="menu"></div>`;
        el.querySelector('[data-ground-menu-close]').addEventListener('click', () => close());
        el.addEventListener('click', onMenuClick);
        host.appendChild(el);
        state.el = el;
        return el;
    }

    // ---- facts ----

    function cityHasCadastre() {
        const config = win.CityConfigManager;
        if (config && typeof config.hasParcelData === 'function') return !!config.hasParcelData();
        return true;
    }

    function roadToolsEnabled() {
        const config = win.CityConfigManager;
        const enabled = config && typeof config.isFeatureEnabled === 'function' ? config.isFeatureEnabled('roadTools') : true;
        return enabled !== false && typeof win.startParcelTransportTool === 'function';
    }

    function factsAt(latlng) {
        const repository = win.CadastralParcelRepository;
        const kind = model.classifyGroundClick({
            hasParcelAtPoint: false,
            cityHasCadastre: cityHasCadastre(),
            pointLoaded: !!(repository && typeof repository.isPointLoaded === 'function'
                && repository.isPointLoaded(latlng.lng, latlng.lat))
        });
        return {
            kind,
            lat: latlng.lat,
            lng: latlng.lng,
            roadToolsEnabled: roadToolsEnabled(),
            stationsEnabled: typeof win.startTransitStationPlacement === 'function'
        };
    }

    function contextFacts() {
        return isOpen() ? state.facts : null;
    }

    // ---- rendering and placement ----

    function commandContext(facts) {
        return win.UiCommands.createBrowserContext(win, { ground: facts, parcel: null });
    }

    function render(facts) {
        const el = ensureElement();
        el.setAttribute('aria-label', t('groundMenu.label', 'Ground actions'));
        const close = el.querySelector('[data-ground-menu-close]');
        const closeLabel = t('modal.common.close', 'Close');
        close.setAttribute('aria-label', closeLabel);
        close.title = closeLabel;
        const text = model.describeGround(facts.kind);
        el.querySelector('.parcel-menu__title').textContent = t(text.titleKey, text.title);
        el.querySelector('.parcel-menu__facts').textContent = t(text.factsKey, text.facts);
        const translate = key => (win.i18n && typeof win.i18n.t === 'function' ? win.i18n.t(key) : key);
        const actions = el.querySelector('.parcel-menu__actions');
        actions.textContent = '';
        win.UiCommands.commandsFor('ground-menu', commandContext(facts)).forEach(entry => {
            const button = doc.createElement('button');
            button.type = 'button';
            button.className = 'parcel-menu__action';
            button.setAttribute('role', 'menuitem');
            button.setAttribute('data-command', entry.id);
            const icon = doc.createElement('i');
            icon.className = entry.icon;
            icon.setAttribute('aria-hidden', 'true');
            const label = doc.createElement('span');
            label.textContent = win.UiCommands.labelOf(entry, translate);
            button.appendChild(icon);
            button.appendChild(label);
            actions.appendChild(button);
        });
    }

    function position() {
        const el = state.el;
        if (!el || el.hidden) return;
        if (isMobile() || !state.latlng || !win.map) {
            el.classList.remove('is-offscreen');
            el.style.removeProperty('--parcel-menu-left');
            el.style.removeProperty('--parcel-menu-top');
            return;
        }
        const size = win.map.getSize();
        const point = win.map.latLngToContainerPoint(state.latlng);
        const offscreen = point.x < 0 || point.y < 0 || point.x > size.x || point.y > size.y;
        el.classList.toggle('is-offscreen', offscreen);
        if (offscreen) return;
        const place = win.ParcelMenuModel.placeMenuAtPoint(point, { width: el.offsetWidth, height: el.offsetHeight },
            { width: size.x, height: size.y });
        el.style.setProperty('--parcel-menu-left', `${place.left}px`);
        el.style.setProperty('--parcel-menu-top', `${place.top}px`);
    }

    function wire() {
        if (state.wired || !win.map || typeof win.map.on !== 'function') return;
        state.wired = true;
        win.map.on('move zoomend viewreset resize', position);
        win.map.on('zoomstart', () => { if (state.el) state.el.classList.add('is-zooming'); });
        win.map.on('zoomend', () => { if (state.el) state.el.classList.remove('is-zooming'); });
        win.addEventListener('resize', position);
        doc.addEventListener('keydown', event => {
            if (event.key !== 'Escape' || event.defaultPrevented || !isOpen()) return;
            if (typeof win.isEditableTarget === 'function' && win.isEditableTarget(event.target)) return;
            event.preventDefault();
            close();
        });
        if (typeof win.MutationObserver === 'function') {
            const observer = new win.MutationObserver(records => {
                if (!isOpen()) return;
                if (records.some(record => record.target.classList.contains('visible'))) close();
            });
            PANEL_IDS.forEach(id => {
                const panel = doc.getElementById(id);
                if (panel) observer.observe(panel, { attributes: true, attributeFilter: ['class'] });
            });
            new win.MutationObserver(() => {
                if (!isOpen()) return;
                const body = doc.body.classList;
                if (body.contains('map-sheet-open') || body.contains('three-mode-active')) close();
            }).observe(doc.body, { attributes: true, attributeFilter: ['class'] });
        }
        const relabel = () => { if (isOpen() && state.facts) render(state.facts); };
        win.addEventListener('i18n:translationsLoaded', relabel);
        if (win.i18n && typeof win.i18n.onChange === 'function') win.i18n.onChange(relabel);
    }

    function onMenuClick(event) {
        const button = event.target.closest('[data-command]');
        if (!button || !state.facts) return;
        const facts = state.facts;
        close();
        win.UiCommands.runCommand(button.getAttribute('data-command'), commandContext(facts));
    }

    // ---- public ----

    // A map click that no parcel, proposal or other layer took (proposals/drill-ui.js). Opens the
    // menu on bare ground or in a city without a cadastre; says why not when the cadastre here has
    // not loaded. Returns the ground kind.
    function openForEmptyClick(latlng) {
        if (!latlng || !Number.isFinite(latlng.lat) || !Number.isFinite(latlng.lng)) return null;
        if (win.SiteTool && typeof win.SiteTool.isActive === 'function' && win.SiteTool.isActive()) return null;
        const facts = factsAt(latlng);
        if (!model.opensMenu(facts.kind)) {
            close();
            log(`no menu at ${latlng.lat.toFixed(6)},${latlng.lng.toFixed(6)}: ground ${facts.kind}`);
            if (facts.kind === 'not-loaded' && typeof win.updateStatus === 'function') {
                win.updateStatus(t('groundMenu.notLoaded', 'Parcels are not loaded here yet — zoom in or wait for them to load.'));
            }
            return facts.kind;
        }
        wire();
        const el = ensureElement();
        state.latlng = latlng;
        state.facts = facts;
        render(facts);
        el.classList.remove('is-zooming');
        el.hidden = false;
        el.classList.add('visible');
        position();
        try { el.focus({ preventScroll: true }); } catch (_) { }
        log(`opened on ${facts.kind} ground at ${latlng.lat.toFixed(6)},${latlng.lng.toFixed(6)}`);
        return facts.kind;
    }

    function close() {
        if (!state.el || state.el.hidden) return;
        state.el.hidden = true;
        state.el.classList.remove('visible');
        state.facts = null;
        state.latlng = null;
    }

    const RUNNERS = {
        drawSite: facts => win.SiteTool.start({ ground: facts.kind }),
        road: () => win.startParcelTransportTool('road'),
        track: () => win.startParcelTransportTool('track')
    };

    function runAction(action, facts) {
        if (!facts) throw new Error(`GroundMenu: ${action} needs ground facts`);
        const station = model.STATION_ACTIONS[action];
        if (station) return win.startTransitStationPlacement(station);
        const runner = RUNNERS[action];
        if (!runner) throw new Error(`GroundMenu: unknown action ${action}`);
        return runner(facts);
    }

    win.GroundMenu = { openForEmptyClick, close, isOpen, contextFacts, runAction, factsAt };
})(window);
