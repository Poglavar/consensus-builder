// The world view inside the app: opens the globe (js/world/globe.js) from the city chip, the
// Settings button, the palette or on a first visit, and lands a pick — in place when it is the city
// already loaded, else by reloading into the city (or the explore city) carrying the view as ?at=
// with the handoff frame (js/world/handoff.js). Also owns the explore city's chip name and its
// banner. Decisions live in js/world/world-entry-model.js; this file wires them to the page.
//
// API (window.WorldEntry)
//   open(opts) -> Promise    opts: { closable?: false, focus: { lat, lon, zoom? } | Place }
//   ownsBoot() -> boolean    true while a first-visit globe is (about to be) open; the site intro
//                            waits for the 'worldview:landed' event instead of stacking on it
//   explorePlaceName() -> string   the explored place for the city chip ('' until known)
(function (global) {
    'use strict';

    const Model = global.WorldEntryModel;
    const doc = global.document;
    const BANNER_DISMISSED_KEY = 'cb_explore_banner_dismissed';
    const state = {
        opening: null,
        focus: null,
        landing: false,
        bootOpen: false,
        explorePlace: null,
        coveragePromise: null,
        banner: null,
        request: 'idle',          // explore banner: idle | sending | done | error
        userZoomIntentUntil: 0
    };

    const log = message => console.log(`[${new Date().toISOString()}] [world-entry] ${message}`);
    const t = (key, fallback, params) => {
        const i18n = global.i18n;
        if (i18n && typeof i18n.t === 'function') {
            const value = i18n.t(key, params || {});
            if (value && value !== key) return value;
        }
        if (!params) return fallback;
        return String(fallback).replace(/\{\{\s*(\w+)\s*\}\}/g, (m, name) => (name in params ? params[name] : m));
    };
    const manager = () => global.CityConfigManager || null;
    const finite = value => typeof value === 'number' && Number.isFinite(value);

    function landed(reason) {
        state.bootOpen = false;
        log(`landed (${reason})`);
        global.dispatchEvent(new CustomEvent('worldview:landed', { detail: { reason } }));
    }

    // The app's own route detectors, on top of the model's list: a link they recognise is never
    // covered by a first-visit globe.
    function sharedRouteNow() {
        if (Model.isSharedRoute(global.location)) return true;
        try { if (typeof global.isProposalDeepLink === 'function' && global.isProposalDeepLink()) return true; } catch (_) { /* fall through */ }
        try {
            const routing = global.AreaMonitorRouting;
            if (routing && typeof routing.parseMonitorRoute === 'function' && routing.parseMonitorRoute() !== null) return true;
        } catch (_) { /* fall through */ }
        return false;
    }

    function cityView(cityId) {
        const m = manager();
        const config = m.getCityConfig(cityId);
        if (!config) throw new Error(`WorldEntry: unknown city ${cityId}`);
        return { center: m.getCityCenter(config), zoom: config.map && config.map.defaultZoom };
    }

    function sameCadastre(a, b) {
        const m = manager();
        const source = id => { const c = m.getCityConfig(id); return c && c.parcels ? c.parcels.source : null; };
        const sa = source(a);
        return !!sa && sa !== 'none' && sa === source(b);
    }

    function coverage() {
        if (!state.coveragePromise) {
            state.coveragePromise = global.WorldCoverage.load().catch(error => {
                state.coveragePromise = null;
                throw error;
            });
        }
        return state.coveragePromise;
    }

    // ---- landing a pick ----
    function land(input) {
        if (state.landing) return;
        try {
            const url = new URL(global.location.href);
            if (url.searchParams.has('focusProposal')) {
                url.searchParams.delete('focusProposal');
                global.history.replaceState(global.history.state, '', url.toString());
            }
        } catch (error) { console.warn('[world-entry] could not clear proposal focus from the URL', error); }
        const m = manager();
        const decision = Model.resolveLanding({
            cityId: input.cityId,
            point: input.point,
            currentCityId: m.getCurrentCityId(),
            cityView: input.explore ? null : cityView(input.cityId),
            focus: state.focus,
            explore: input.explore
        });
        state.landing = true;
        log(`${input.explore ? 'explore' : 'open ' + input.cityId} at ${input.point.lat.toFixed(4)},${input.point.lon.toFixed(4)} -> `
            + `${decision.cityId} ${decision.inPlace ? 'in place' : 'by reload'} (${Model.formatAt(decision.view)}${decision.carryAt ? ', via ?at=' : ''})`);
        // A city pick arrives on that city's latest proposal, in 3D (js/world/arrival.js); the lookup
        // runs during the flight. No proposal, or a failed lookup, lands on the city as before.
        const latest = input.explore || !global.WorldArrival
            ? Promise.resolve(null)
            : global.WorldArrival.fetchLatestProposalId(decision.cityId).catch(error => {
                console.warn(`[${new Date().toISOString()}] [world-entry] latest proposal lookup failed`, error);
                return null;
            });
        global.WorldView.flyTo(input.point).then(async camera => {
            if (!camera) { state.landing = false; return null; } // the view was closed mid-flight
            const proposalId = await latest;
            if (proposalId) {
                const event = { proposalId, cityId: decision.cityId, href: `/?focusProposal=${encodeURIComponent(proposalId)}` };
                return global.WorldProposalEntry.open(event, { arrive: 'latest' }).finally(() => { state.landing = false; });
            }
            const dataUrl = global.WorldView.captureHandoffFrame();
            if (decision.inPlace) { landInPlace(decision, dataUrl); return null; }
            global.WorldHandoff.store({ dataUrl, cityId: decision.cityId, center: [decision.view.lat, decision.view.lon], zoom: decision.view.zoom });
            return m.switchCity(decision.cityId, { requireConfirmation: false, clearRoute: true, at: decision.carryAt ? decision.view : null })
                .then(navigating => {
                    if (!navigating) throw new Error(`switchCity(${decision.cityId}) refused`);
                });
        }).catch(error => {
            state.landing = false;
            console.error(`[${new Date().toISOString()}] [world-entry] landing failed`, error);
        });
    }

    // The pick is the city already loaded: fade the globe's last frame over the map as it moves.
    function landInPlace(decision, dataUrl) {
        const m = manager();
        const view = decision.view;
        global.WorldHandoff.play({ dataUrl });
        global.WorldView.close();
        state.landing = false;
        global.map.setView([view.lat, view.lon], view.zoom, { animate: false });
        if (m.isExplore()) {
            m.rememberExploreView(view);
            identifyExplorePlace(view);
            state.request = 'idle';
            renderBanner();
        } else {
            m.rememberCurrentCity();
        }
        landed('in place');
    }

    function requestCity(place) {
        if (typeof global.getBackendBase !== 'function') return Promise.reject(new Error('getBackendBase() is not defined'));
        return fetch(`${global.getBackendBase()}/cities/requests`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                placeKey: place.placeKey, name: place.name || place.country, country: place.country, lat: place.lat, lon: place.lon
            })
        }).then(response => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            log(`city request noted for ${place.placeKey}`);
        });
    }

    function validFocus(focus) {
        if (!focus || !finite(focus.lat) || !finite(focus.lon)) return null;
        return { lat: focus.lat, lon: focus.lon, zoom: finite(focus.zoom) ? focus.zoom : null };
    }

    function open(opts) {
        const options = opts || {};
        const view = global.WorldView;
        if (!view) throw new Error('WorldEntry: js/world/globe.js is not loaded');
        const focus = validFocus(options.focus);
        if (view.isOpen()) {
            state.focus = focus;
            return focus ? view.selectPlace(focus.lat, focus.lon) : Promise.resolve();
        }
        if (state.opening) return state.opening;
        state.focus = focus;
        try { if (global.MapShell && typeof global.MapShell.closeSheets === 'function') global.MapShell.closeSheets(); } catch (_) { /* no sheet open */ }
        try { if (global.ParcelMenu && typeof global.ParcelMenu.close === 'function') global.ParcelMenu.close(); } catch (_) { /* no menu */ }
        const map = global.map;
        let initialView;
        if (focus) initialView = { lat: focus.lat, lon: focus.lon };
        else if (!options.firstVisit && map && typeof map.getCenter === 'function') {
            const center = map.getCenter();
            initialView = { lat: center.lat, lon: center.lng };
        }
        const closable = options.closable !== false
            && Model.canReturnToMap(map && typeof map.getZoom === 'function' ? map.getZoom() : null);
        state.opening = view.open({
            closable,
            closeLabel: closable ? 'world.backToMap' : null,
            initialView,
            chooseCity: place => {
                const current = manager().getCurrentCityId();
                return Model.liveCityFor({ place, currentCityId: current, sameCadastre: sameCadastre(current, place.cityId) });
            },
            onOpenCity: (cityId, point) => land({ cityId, point, explore: false }),
            onExplore: point => land({ point, explore: true }),
            onRequestCity: requestCity,
            onClose: () => landed('closed')
        }).then(() => {
            log(`opened${focus ? ` on ${focus.lat.toFixed(3)},${focus.lon.toFixed(3)}` : ''}`);
            if (focus) return view.selectPlace(focus.lat, focus.lon);
            return undefined;
        }).finally(() => { state.opening = null; });
        return state.opening;
    }

    // ---- first visit / ?world=1 ----
    function stripWorldParam() {
        try {
            const url = new URL(global.location.href);
            if (!url.searchParams.has('world')) return;
            url.searchParams.delete('world');
            global.history.replaceState(global.history.state, '', url.toString());
        } catch (error) {
            console.warn('[world-entry] could not strip ?world= from the URL', error);
        }
    }

    function boot() {
        const m = manager();
        const decision = Model.bootDecision({
            cityChosen: m.wasCityChosenAtBoot(),
            sharedRoute: Model.isSharedRoute(global.location),
            search: global.location.search
        });
        if (!decision.open) return;
        state.bootOpen = true;
        // A dark cover until the globe's first frame, so the default city never flashes first.
        doc.body.classList.add('world-view-pending');
        const start = () => {
            if (!decision.forced && sharedRouteNow()) {
                doc.body.classList.remove('world-view-pending');
                landed('shared route');
                return;
            }
            stripWorldParam();
            log(`boot: ${decision.forced ? '?world=1' : 'first visit'}, closable=${decision.closable}`);
            open({ closable: decision.closable, firstVisit: decision.firstVisit }).then(() => {
                doc.body.classList.remove('world-view-pending');
            }, error => {
                doc.body.classList.remove('world-view-pending');
                console.error(`[${new Date().toISOString()}] [world-entry] the world view failed to open; staying in ${m.getCurrentCityId()}`, error);
                landed('globe failed');
            });
        };
        if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start, { once: true });
        else start();
    }

    // ---- explore city: chip name and banner ----
    // The chip follows the map: named from local coverage data only (WorldCoverage.nameAt: the
    // nearest city in range, else the country, '' on open water or a continent-wide view), never
    // from the network. It used to be named once, from the boot centre, so a pan or a search jump
    // kept the first place (the default world view centre is in Libya).
    const EXPLORE_NAME_DEBOUNCE_MS = 250;

    function placeName(place) {
        return place && place.name ? place.name : '';
    }

    function identifyExplorePlace(view) {
        return coverage().then(cov => {
            const place = cov.nameAt(view.lat, view.lon, view.zoom);
            // A request sent for one place says nothing about the next one.
            if (state.request === 'done' && placeName(place) !== placeName(state.explorePlace)) state.request = 'idle';
            state.explorePlace = place;
            if (global.MapSearch && typeof global.MapSearch.refreshChip === 'function') global.MapSearch.refreshChip();
            renderBanner();
        }).catch(error => console.warn('[world-entry] world coverage did not load; the explored place stays unnamed', error));
    }

    function bannerDismissed() {
        try { return global.sessionStorage.getItem(BANNER_DISMISSED_KEY) === '1'; } catch (_) { return false; }
    }

    function el(tag, className, attrs) {
        const node = doc.createElement(tag);
        if (className) node.className = className;
        Object.entries(attrs || {}).forEach(([key, value]) => {
            if (key === 'text') node.textContent = value;
            else node.setAttribute(key, value);
        });
        return node;
    }

    function askLabel(place) {
        if (state.request === 'sending') return t('world.request.sending', 'Sending…');
        if (state.request === 'done') return t('world.request.done', 'Request noted, thank you');
        return place && place.kind === 'country'
            ? t('world.action.askArea', 'Ask for this area')
            : t('world.action.askCity', 'Ask for this city');
    }

    function askFromBanner() {
        const center = global.map.getCenter();
        state.request = 'sending';
        renderBanner();
        coverage().then(cov => {
            const place = cov.tierAt(center.lat, center.lng);
            if (place.kind === 'ocean') throw new Error('no place to ask for at the map centre (open water)');
            return requestCity(place);
        }).then(() => { state.request = 'done'; renderBanner(); }, error => {
            console.error(`[${new Date().toISOString()}] [world-entry] city request failed`, error);
            state.request = 'error';
            renderBanner();
        });
    }

    function renderBanner() {
        const m = manager();
        if (!m || !m.isExplore()) return;
        if (bannerDismissed()) {
            if (state.banner) { state.banner.remove(); state.banner = null; }
            return;
        }
        const slot = doc.getElementById('map-search-slot');
        if (!slot || !slot.parentNode) return;
        if (!state.banner) {
            state.banner = el('div', 'explore-banner', { id: 'explore-banner', role: 'status' });
            slot.parentNode.insertBefore(state.banner, slot.nextSibling);
        }
        const banner = state.banner;
        banner.textContent = '';
        const place = state.explorePlace;
        banner.appendChild(el('p', 'explore-banner__text', {
            text: t('world.explore.banner', 'No parcels here: you can draw a site and propose, but a proposal can only execute through an authority\'s verdict.')
        }));
        const actions = el('div', 'explore-banner__actions');
        if (!place || place.kind !== 'ocean') {
            const ask = el('button', 'explore-banner__btn explore-banner__btn--primary', { type: 'button', id: 'explore-banner-ask', text: askLabel(place) });
            ask.disabled = state.request === 'sending' || state.request === 'done';
            ask.addEventListener('click', askFromBanner);
            actions.appendChild(ask);
        }
        const world = el('button', 'explore-banner__btn', { type: 'button', id: 'explore-banner-world', text: t('world.explore.worldView', 'World view') });
        world.addEventListener('click', () => open({}).catch(error => console.error('[world-entry] world view failed to open', error)));
        actions.appendChild(world);
        banner.appendChild(actions);
        if (state.request === 'error') {
            banner.appendChild(el('p', 'explore-banner__error', { text: t('world.request.error', 'Could not send the request. Try again?') }));
        }
        const dismissLabel = t('world.explore.dismiss', 'Dismiss');
        const close = el('button', 'explore-banner__close', { type: 'button', 'aria-label': dismissLabel, title: dismissLabel, text: '×' });
        close.addEventListener('click', () => {
            try { global.sessionStorage.setItem(BANNER_DISMISSED_KEY, '1'); } catch (_) { /* the banner just closes for now */ }
            banner.remove();
            state.banner = null;
        });
        banner.appendChild(close);
    }

    function initExplore() {
        const m = manager();
        if (!m.isExplore()) return;
        // Early, so the controls that cannot work here (mode strip, parcel sheets) never flash.
        doc.body.classList.add('explore-city');
        // map-core.js (whenAppBooted) loads after this file; until then the appBooted event is the signal.
        const booted = typeof global.whenAppBooted === 'function'
            ? global.whenAppBooted()
            : new Promise(resolve => global.addEventListener('appBooted', resolve, { once: true }));
        booted.then(() => {
            const map = global.map;
            const center = map.getCenter();
            identifyExplorePlace({ lat: center.lat, lon: center.lng, zoom: map.getZoom() });
            renderBanner();
            // The status line's boot text says parcels are loading; here none ever will.
            if (typeof global.updateStatus === 'function') global.updateStatus(t('world.explore.status', 'No parcel data here: click the map to draw a site and propose.'));
            let renameTimer = null;
            map.on('moveend', () => {
                const c = map.getCenter();
                const view = { lat: c.lat, lon: c.lng, zoom: map.getZoom() };
                m.rememberExploreView(view);
                // Debounced: a drag or a fly ends in several moveends; name the place it settles on.
                clearTimeout(renameTimer);
                renameTimer = setTimeout(() => identifyExplorePlace(view), EXPLORE_NAME_DEBOUNCE_MS);
            });
            global.addEventListener('i18n:translationsLoaded', renderBanner);
            if (global.i18n && typeof global.i18n.onChange === 'function') global.i18n.onChange(renderBanner);
        });
    }

    function wireSettingsButton() {
        const button = doc.getElementById('world-view-button');
        if (!button) return;
        button.addEventListener('click', () => {
            open({}).catch(error => console.error('[world-entry] world view failed to open', error));
        });
    }

    // Arm only on native map inputs. Leaflet emits zoomend for boot fitBounds, route cameras and
    // proposal previews too, so zoom direction alone cannot decide whether to open the globe.
    function wireZoomOutToGlobe() {
        const map = global.map;
        if (!map || typeof map.on !== 'function') return;
        let previousZoom = map.getZoom();
        const mark = event => {
            if (event && event.isTrusted === false) return;
            state.userZoomIntentUntil = Date.now() + 1200;
        };
        const container = map.getContainer && map.getContainer();
        if (container) container.addEventListener('wheel', mark, { capture: true, passive: true });
        global.addEventListener('keydown', event => {
            const target = event.target;
            if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName || ''))) return;
            if (event.key === '-' || event.key === '_' || event.code === 'NumpadSubtract') mark(event);
        }, true);
        if (container) {
            container.addEventListener('touchstart', event => { if (event.touches && event.touches.length >= 2) mark(event); }, { capture: true, passive: true });
            container.addEventListener('touchmove', event => { if (event.touches && event.touches.length >= 2) mark(event); }, { capture: true, passive: true });
        }
        map.on('zoomend', () => {
            const zoom = map.getZoom();
            const userInitiated = Date.now() <= state.userZoomIntentUntil;
            state.userZoomIntentUntil = 0;
            const blocked = !!(global.WorldView && (global.WorldView.isOpen() || state.opening))
                || state.landing || state.bootOpen || global.roadDrawingMode === true || !!global.sharePlanMode
                || !!global.suppressCameraMoves || !!(global.WorldProposalEntry && global.WorldProposalEntry.isOpening && global.WorldProposalEntry.isOpening())
                || doc.body.classList.contains('three-mode-active') || doc.body.classList.contains('realistic-mode-active')
                || !!(global.MapShell && global.MapShell.isBlockingDialogOpen && global.MapShell.isBlockingDialogOpen());
            if (Model.shouldReturnToGlobe({ fromZoom: previousZoom, toZoom: zoom, userInitiated, blocked })) {
                const center = map.getCenter();
                open({ focus: { lat: center.lat, lon: center.lng, zoom } }).catch(error => console.error('[world-entry] world view failed to open', error));
            }
            previousZoom = zoom;
        });
    }

    global.WorldEntry = {
        open,
        finishNavigation: () => landed('proposal'),
        ownsBoot: () => state.bootOpen,
        explorePlaceName: () => placeName(state.explorePlace)
    };

    if (!Model || !manager()) {
        console.error('[world-entry] WorldEntryModel or CityConfigManager missing; the world view is not wired');
        return;
    }
    boot();
    initExplore();
    const booted = typeof global.whenAppBooted === 'function'
        ? global.whenAppBooted()
        : new Promise(resolve => global.addEventListener('appBooted', resolve, { once: true }));
    booted.then(wireZoomOutToGlobe);
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', wireSettingsButton, { once: true });
    else wireSettingsButton();
})(window);
