// ui/parcel-menu.js — the parcel menu: the compact popover a parcel click opens at the click point
// (a bottom-sheet peek on phones), with the parcel id, a line of facts already known about it and
// the actions UiCommands lists for the 'parcel-menu' surface. It follows the map on pan/zoom, flips
// to stay in view and closes on a map click elsewhere, Esc, or another panel opening. The actions
// open the existing parcel panel on the tab they need (window.ParcelMenu.runAction); which ones
// apply is decided by the pure ui/parcel-menu-model.js.
(function (win) {
    'use strict';

    const doc = win.document;
    const model = win.ParcelMenuModel;
    const MOBILE_QUERY = '(max-width: 767px)';
    // Panels whose opening takes over from the menu.
    const PANEL_IDS = ['parcel-info-panel', 'proposal-details-panel', 'block-info-panel', 'road-info-panel', 'road-analysis-panel'];

    const state = {
        el: null,
        parcelId: null,
        latlng: null,
        facts: null,
        observersWired: false,
        mapWired: false
    };

    const t = (key, fallback, params) => {
        const i18n = win.i18n;
        if (i18n && typeof i18n.t === 'function') {
            const value = i18n.t(key, params || {});
            if (typeof value === 'string' && value && value !== key) return value;
        }
        if (!params) return fallback;
        return String(fallback).replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name) => (name in params ? params[name] : match));
    };

    const isMobile = () => !!(win.matchMedia && win.matchMedia(MOBILE_QUERY).matches);
    const isOpen = () => !!(state.el && !state.el.hidden);

    function ensureElement() {
        if (state.el) return state.el;
        const host = doc.getElementById('map-container') || doc.body;
        const el = doc.createElement('div');
        el.id = 'parcel-menu';
        el.className = 'parcel-menu';
        el.hidden = true;
        el.tabIndex = -1;
        // A non-modal popover: not role=dialog, which isAnyModalOpen() (road-drawing.js) treats as
        // a blocking modal that silences every map shortcut.
        el.setAttribute('role', 'group');
        el.innerHTML = `
            <div class="parcel-menu__head">
                <div class="parcel-menu__title"></div>
                <button type="button" class="parcel-menu__close close-circle-btn" data-parcel-menu-close>×</button>
            </div>
            <div class="parcel-menu__facts"></div>
            <div class="parcel-menu__actions" role="menu"></div>`;
        el.querySelector('[data-parcel-menu-close]').addEventListener('click', () => dismiss());
        el.addEventListener('click', onMenuClick);
        host.appendChild(el);
        state.el = el;
        return el;
    }

    // ---- facts ----

    function ownersFor(parcelId, props) {
        if (Array.isArray(props.ownershipList) && props.ownershipList.length) return props.ownershipList;
        if (Array.isArray(props.owners) && props.owners.length) return props.owners;
        const cache = win.ParcelsOwnershipUi && win.ParcelsOwnershipUi.parcelOwnerDataCache;
        const cached = cache && typeof cache.get === 'function' ? cache.get(String(parcelId)) : null;
        return Array.isArray(cached) && cached.length ? cached : null;
    }

    function geometryArea(feature) {
        if (!feature || !feature.geometry || !win.turf || typeof win.turf.area !== 'function') return null;
        try { return win.turf.area(feature); } catch (_) { return null; }
    }

    function can3d() {
        const button = doc.getElementById('mode-3d-toggle');
        if (!button || button.hidden || button.disabled) return false;
        if (doc.body.classList.contains('three-mode-active')) return false;
        return !!(button.offsetWidth || button.offsetHeight || button.getClientRects().length);
    }

    function blocksEnabled() {
        const config = win.CityConfigManager;
        const enabled = config && typeof config.isFeatureEnabled === 'function' ? config.isFeatureEnabled('parcelBlocks') : true;
        return enabled && typeof win.animateFloodfillFromSelected === 'function';
    }

    // Everything the model and the menu need about one parcel, read synchronously from what is
    // already loaded.
    function factsFor(parcelId, feature) {
        const id = String(parcelId);
        const props = (feature && feature.properties) || {};
        const multi = win.multiParcelSelection;
        let historyIds = [];
        let groundIds = [];
        try {
            const fabric = win.LiveParcelFabric;
            if (fabric && typeof fabric.explicitCadastreIds === 'function') historyIds = fabric.explicitCadastreIds(feature);
            if (fabric && typeof fabric.explicitGroundIds === 'function') groundIds = fabric.explicitGroundIds(feature);
        } catch (_) { historyIds = []; }
        // A piece on open ground only (PARCEL-OPTIONAL.md phase 3) is no cadastral parcel: it has no
        // parcel history to show and must never be sent to the backend as a parcel id.
        const isGround = !historyIds.length && groundIds.length > 0;
        if (!historyIds.length && !isGround) historyIds = [id];
        const ownership = model.ownershipFacts({
            ownershipType: props.ownershipType,
            ownershipSummary: props.ownership_summary,
            owners: ownersFor(id, props),
            classify: typeof win.getOwnershipType === 'function' ? win.getOwnershipType : null
        });
        return {
            parcelId: id,
            displayId: model.displayParcelId(props, id),
            isRoad: typeof win.isRoadParcel === 'function' ? !!win.isRoadParcel(id) : false,
            multiSelectActive: !!(multi && multi.isActive),
            selectionCount: multi && multi.selectedParcels ? multi.selectedParcels.size : 0,
            historyIds,
            isGround,
            blocksEnabled: blocksEnabled(),
            can3d: can3d(),
            siteToolAvailable: !!(win.SiteTool && typeof win.SiteTool.isActive === 'function' && !win.SiteTool.isActive()),
            // Proposals touching this parcel, for "Compare proposals here" (null when not loaded).
            compareCount: !isGround && win.ParcelCompare ? win.ParcelCompare.countFor(id) : null,
            area: model.parcelArea(props, geometryArea(feature)),
            ownershipType: ownership.ownershipType,
            ownerCount: ownership.ownerCount
        };
    }

    // The parcel commands act on: the open menu's parcel, else a single selected parcel (so the
    // command palette can offer them too). Null without one — the commands are then unavailable.
    function contextFacts() {
        if (isOpen() && state.facts) return state.facts;
        const multi = win.multiParcelSelection;
        if (multi && multi.isActive) return null;
        const current = win.currentParcel;
        if (!current || current.id === undefined || current.id === null) return null;
        const feature = win.LiveParcelFabric && win.LiveParcelFabric.get ? win.LiveParcelFabric.get(String(current.id)) : null;
        return feature ? factsFor(current.id, feature) : null;
    }

    function factsLine(facts) {
        const parts = [];
        if (facts.area !== null) {
            parts.push(`${Math.round(facts.area).toLocaleString('hr-HR')} ${t('panel.parcel.metrics.areaUnit', 'm²')}`);
        }
        if (facts.isGround) parts.push(t('parcelMenu.groundNote', 'no cadastral parcel'));
        if (facts.isRoad) parts.push(t('panel.parcel.multi.roadTag', 'Road'));
        if (facts.ownershipType) {
            parts.push(t(`panel.parcel.ownershipType.${facts.ownershipType}`, facts.ownershipType));
        }
        if (facts.ownerCount !== null) {
            parts.push(t('parcelMenu.ownerCount', '{{count}} owner(s)', { count: facts.ownerCount }));
        }
        return parts.join(' · ');
    }

    // ---- rendering and placement ----

    function commandContext(facts) {
        return win.UiCommands.createBrowserContext(win, { parcel: facts });
    }

    function render(facts) {
        const el = ensureElement();
        el.setAttribute('aria-label', t('parcelMenu.label', 'Parcel actions'));
        const close = el.querySelector('[data-parcel-menu-close]');
        const closeLabel = t('modal.common.close', 'Close');
        close.setAttribute('aria-label', closeLabel);
        close.title = closeLabel;
        el.querySelector('.parcel-menu__title').textContent = facts.isGround
            ? t('parcelMenu.groundTitle', 'Open ground')
            : t('panel.parcel.multi.parcelLabel', 'Parcel {{number}}', { number: facts.displayId });
        const line = factsLine(facts);
        const factsEl = el.querySelector('.parcel-menu__facts');
        factsEl.textContent = line;
        factsEl.hidden = !line;

        const translate = key => (win.i18n && typeof win.i18n.t === 'function' ? win.i18n.t(key) : key);
        const actions = el.querySelector('.parcel-menu__actions');
        actions.textContent = '';
        win.UiCommands.commandsFor('parcel-menu', commandContext(facts)).forEach(entry => {
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
        // The parcel scrolled out of view: hide the menu rather than pin it to an edge, detached
        // from what it describes. It comes back when the parcel does.
        const offscreen = point.x < 0 || point.y < 0 || point.x > size.x || point.y > size.y;
        el.classList.toggle('is-offscreen', offscreen);
        if (offscreen) return;
        const place = model.placeMenuAtPoint(point, { width: el.offsetWidth, height: el.offsetHeight },
            { width: size.x, height: size.y });
        el.style.setProperty('--parcel-menu-left', `${place.left}px`);
        el.style.setProperty('--parcel-menu-top', `${place.top}px`);
    }

    function wireMap() {
        if (state.mapWired || !win.map || typeof win.map.on !== 'function') return;
        state.mapWired = true;
        win.map.on('move zoomend viewreset resize', position);
        win.map.on('zoomstart', () => { if (state.el) state.el.classList.add('is-zooming'); });
        win.map.on('zoomend', () => { if (state.el) state.el.classList.remove('is-zooming'); });
        // A click on the map background (no parcel took it) closes the menu; map-core clears the
        // selection on the same click.
        win.map.on('click', () => close());
        win.addEventListener('resize', position);
    }

    // Another panel or a sheet opening, or 3D starting, takes over from the menu.
    function wireObservers() {
        if (state.observersWired || typeof win.MutationObserver !== 'function') return;
        state.observersWired = true;
        const onPanelChange = records => {
            if (!isOpen()) return;
            const opened = records.some(record => record.target.classList.contains('visible')
                && !(record.oldValue || '').split(/\s+/).includes('visible'));
            if (opened) close();
        };
        const panelObserver = new win.MutationObserver(onPanelChange);
        PANEL_IDS.forEach(id => {
            const panel = doc.getElementById(id);
            if (panel) panelObserver.observe(panel, { attributes: true, attributeFilter: ['class'], attributeOldValue: true });
        });
        new win.MutationObserver(() => {
            if (!isOpen()) return;
            const body = doc.body.classList;
            if (body.contains('map-sheet-open') || body.contains('three-mode-active')) close();
        }).observe(doc.body, { attributes: true, attributeFilter: ['class'] });
        // Entering multi-select (Select more, Shift+click, Detect block) hands over to the tray.
        doc.addEventListener('multi-parcel-selection-change', event => {
            if (isOpen() && event.detail && event.detail.isActive) close();
        });
        doc.addEventListener('keydown', onKeyDown);
        // An open menu re-renders its labels on a live language switch.
        const relabel = () => { if (isOpen() && state.facts) render(state.facts); };
        win.addEventListener('i18n:translationsLoaded', relabel);
        if (win.i18n && typeof win.i18n.onChange === 'function') win.i18n.onChange(relabel);
    }

    // ArrowDown/ArrowUp (and Home/End) walk the actions while focus is in the menu, wrapping —
    // the menu opens focused on itself, so ArrowDown reaches the first action.
    function moveActionFocus(event) {
        const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
        if (!keys.includes(event.key) || !isOpen() || !state.el.contains(doc.activeElement)) return false;
        const actions = Array.from(state.el.querySelectorAll('[data-command]'));
        if (!actions.length) return false;
        const current = actions.indexOf(doc.activeElement);
        let next;
        if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = actions.length - 1;
        else if (current === -1) next = event.key === 'ArrowDown' ? 0 : actions.length - 1;
        else next = (current + (event.key === 'ArrowDown' ? 1 : -1) + actions.length) % actions.length;
        event.preventDefault();
        actions[next].focus();
        return true;
    }

    function onKeyDown(event) {
        if (moveActionFocus(event)) return;
        if (event.key !== 'Escape' || event.defaultPrevented || !isOpen()) return;
        if (typeof win.isEditableTarget === 'function' && win.isEditableTarget(event.target)) return;
        if (typeof win.isAnyModalOpen === 'function' && win.isAnyModalOpen()) return;
        event.preventDefault();
        dismiss();
    }

    function onMenuClick(event) {
        const button = event.target.closest('[data-command]');
        if (!button || !state.facts) return;
        const facts = state.facts;
        close();
        win.UiCommands.runCommand(button.getAttribute('data-command'), commandContext(facts));
    }

    // The click point, unless the map has already moved it out of view (the drill stack frames a
    // large parcel before the menu opens): then a point of the parcel that is in view.
    function anchorFor(latlng, feature) {
        if (!win.map) return latlng || null;
        const bounds = win.map.getBounds();
        if (latlng && bounds.contains(latlng)) return latlng;
        try {
            const [lng, lat] = win.turf.pointOnFeature(feature).geometry.coordinates;
            if (bounds.contains([lat, lng])) return win.L.latLng(lat, lng);
        } catch (_) { }
        return win.map.getCenter();
    }

    // ---- public ----

    function open({ parcelId, feature, latlng }) {
        if (parcelId === undefined || parcelId === null) throw new Error('ParcelMenu.open: parcelId is required');
        wireMap();
        wireObservers();
        const el = ensureElement();
        state.parcelId = String(parcelId);
        state.latlng = anchorFor(latlng, feature);
        state.facts = factsFor(parcelId, feature);
        render(state.facts);
        el.classList.remove('is-zooming');
        el.hidden = false;
        el.classList.add('visible');
        position();
        // Focus the menu itself (not its first action, which would paint a focus ring under the
        // pointer): Tab then walks the actions, Esc closes.
        try { el.focus({ preventScroll: true }); } catch (_) { }
    }

    // Close the menu; the parcel stays selected (an action is about to use it, or another surface
    // took over).
    function close() {
        if (!state.el || state.el.hidden) return;
        state.el.hidden = true;
        state.el.classList.remove('visible');
        state.facts = null;
        state.latlng = null;
        state.parcelId = null;
    }

    // Esc / the close button: the person is done with this parcel — close and deselect it, the
    // way closing the parcel panel does.
    function dismiss() {
        close();
        const panel = doc.getElementById('parcel-info-panel');
        if (panel && panel.classList.contains('visible')) return;
        if (typeof win.hideParcelInfoPanel === 'function') win.hideParcelInfoPanel();
    }

    function featureFor(facts) {
        const feature = win.LiveParcelFabric && win.LiveParcelFabric.get ? win.LiveParcelFabric.get(facts.parcelId) : null;
        if (!feature) throw new Error(`ParcelMenu: parcel ${facts.parcelId} is no longer on the map`);
        return feature;
    }

    function showPanelTab(facts, tabId) {
        const panelApi = (win.Parcels && win.Parcels.uiParcelPanel) || win.ParcelsUIParcelPanel || {};
        const showPanel = panelApi.showParcelInfoPanel || win.showParcelInfoPanel;
        showPanel(featureFor(facts));
        win.switchParcelTab(null, tabId);
    }

    // The per-parcel history card (proposals/parcel-history-card.js), mounted under the panel's Info
    // tab content with this parcel's row open. Not inside #info-content: that is re-rendered when
    // the owners arrive. The panel drops the card when it moves to another parcel (parcel-panel.js).
    function showHistory(facts) {
        showPanelTab(facts, 'info-tab');
        const content = doc.getElementById('info-content');
        const card = win.ProposalParcelHistoryCard;
        if (!content || !card) throw new Error('ParcelMenu: the parcel history card is not loaded');
        const section = card.mountAfter(content, { parcelIds: facts.historyIds });
        if (!section) return;
        section.dataset.parcelHistoryFor = facts.parcelId;
        const first = section.querySelector('details[data-parcel-history]');
        if (first) first.open = true;
        try { section.scrollIntoView({ block: 'start', behavior: 'auto' }); } catch (_) { }
    }

    function viewIn3d(facts) {
        const feature = featureFor(facts);
        // 3D frames the area around the map's centre; there is no parcel focus to pass it, so
        // centre the map on the parcel first, then press the mode strip's 3D button (which also
        // loads the 3D stack on first use).
        try {
            const bounds = win.L.geoJSON(feature).getBounds();
            if (bounds.isValid()) win.map.setView(bounds.getCenter(), win.map.getZoom(), { animate: false });
        } catch (error) {
            console.warn(`[${new Date().toISOString()}] [ParcelMenu] could not centre on ${facts.parcelId}`, error);
        }
        doc.getElementById('mode-3d-toggle').click();
    }

    const ACTION_RUNNERS = {
        propose: facts => showPanelTab(facts, 'proposals-tab'),
        details: facts => showPanelTab(facts, 'info-tab'),
        tools: facts => showPanelTab(facts, 'tools-tab'),
        history: showHistory,
        compare: facts => win.ParcelCompare.open(facts.parcelId),
        // Same seed as Shift+click: the selected parcel starts the multi-selection.
        selectMore: () => win.multiParcelSelection.toggle({ preserveSelectedParcel: true }),
        // The build palette's own Offer tool (it opens the ownership-only proposal dialog).
        offer: () => win.startParcelBuildTool('offer'),
        view3d: viewIn3d,
        detectBlock: () => win.animateFloodfillFromSelected(),
        // This parcel as the starting outline of an editable site (js/site-drawing.js).
        useAsSite: facts => win.SiteTool.startFromParcels([facts.parcelId])
    };

    function runAction(action, facts) {
        const runner = ACTION_RUNNERS[action];
        if (!runner) throw new Error(`ParcelMenu: unknown action ${action}`);
        if (!facts || !facts.parcelId) throw new Error(`ParcelMenu: ${action} needs a parcel`);
        return runner(facts);
    }

    // Created up front (hidden) so the panels that watch it — the drill stack treats it as a
    // neighbour, like the parcel panel — can find it before the first click.
    ensureElement();

    win.ParcelMenu = { open, close, dismiss, isOpen, contextFacts, runAction };
})(window);
