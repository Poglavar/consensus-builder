// Guided "impact tour" for the buildings a road/track runs into. Instead of one blanket choice for
// the whole set, it steps through each affected building (prev/next), zooming to and highlighting it
// on a live-but-non-interactive map, and lets the user keep one global default (Cut all / Demolish
// all / Tunnel all) while overriding individual buildings. Resolves to { action, perBuilding } (the
// global default plus a Map of per-building overrides), or the string 'cancel'.
//
// The pure decision model (createTourState + reducers) is exported separately so it can be unit
// tested without a DOM; the DOM/map layer below is a thin driver over it.
(function attachRoadImpactTour(global) {
    'use strict';

    const ACTION_COLORS = { cut: '#f97316', destroy: '#dc2626', tunnel: '#eab308' };

    // ---- Pure model (DOM-free, unit-tested) --------------------------------------------------

    function createTourState(hits, defaultAction) {
        return {
            count: Array.isArray(hits) ? hits.length : 0,
            index: 0,
            defaultAction: defaultAction || 'cut',
            overrides: {} // building id -> 'cut' | 'destroy' | 'tunnel'
        };
    }

    function tourClampIndex(index, count) {
        if (!count || count <= 0) return 0;
        return Math.max(0, Math.min(index, count - 1));
    }

    function tourGoTo(state, index) {
        return { ...state, index: tourClampIndex(index, state.count) };
    }

    // "Apply to all" is a reset: it sets the default AND clears every per-building override, so the
    // label ("Cut all") means exactly what it says. Overriding individuals is what re-diverges them.
    function tourSetDefault(state, action) {
        return { ...state, defaultAction: action, overrides: {} };
    }

    function tourSetOverride(state, id, action) {
        return { ...state, overrides: { ...state.overrides, [String(id)]: action } };
    }

    function tourEffectiveAction(state, id) {
        const key = String(id);
        if (state && state.overrides && Object.prototype.hasOwnProperty.call(state.overrides, key)) {
            return state.overrides[key];
        }
        return state ? state.defaultAction : 'cut';
    }

    // A proposal-owned building can't be sliced (proposals are only unapplied, tunnelled, or
    // destroyed — see impact-resolver.md), so its menu collapses to Unapply(=destroy) / Tunnel.
    function tourAllowedActions(isProposalOwned) {
        return isProposalOwned ? ['destroy', 'tunnel'] : ['cut', 'destroy', 'tunnel'];
    }

    function tourNormalizeAction(action, isProposalOwned) {
        if (isProposalOwned && action === 'cut') return 'destroy';
        return action;
    }

    // ---- DOM + map driver --------------------------------------------------------------------

    function t(key, fallback, params = {}) {
        try {
            if (global.i18n && typeof global.i18n.t === 'function') {
                const value = global.i18n.t(key, params);
                if (value && value !== key) return value;
            }
        } catch (_) { }
        return fallback.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name) => params[name] ?? '');
    }

    function hitId(hit) {
        return String(hit && hit.id != null ? hit.id : '');
    }

    function hitIsProposalOwned(hit) {
        try {
            return typeof global.corridorTunnelHitProposalId === 'function'
                && !!global.corridorTunnelHitProposalId(hit);
        } catch (_) {
            return false;
        }
    }

    function hitFeature(hit) {
        const feature = hit && hit.feature;
        if (feature && feature.type === 'Feature' && feature.geometry) return feature;
        if (feature && feature.geometry) return { type: 'Feature', properties: feature.properties || {}, geometry: feature.geometry };
        return null;
    }

    function hitLabel(hit, index) {
        const props = hitFeature(hit)?.properties || {};
        const name = props.name || props.title || props.building_name;
        if (name && String(name).trim()) return String(name).trim();
        const id = hitId(hit);
        return id ? `#${id}` : `${index + 1}`;
    }

    function renderMessageLines(container, message) {
        container.textContent = '';
        String(message || '').split('\n').forEach(line => {
            const div = document.createElement('div');
            div.textContent = line;
            if (!line.trim()) div.style.height = '6px';
            container.appendChild(div);
        });
    }

    // Snapshot which interaction handlers are on, disable them all, and hand back a restore fn so a
    // tour that opens mid-drawing leaves the map exactly as it found it.
    function freezeMapInteraction(map) {
        const handlers = ['dragging', 'touchZoom', 'doubleClickZoom', 'scrollWheelZoom', 'boxZoom', 'keyboard', 'tap'];
        const wasEnabled = {};
        handlers.forEach(name => {
            const handler = map && map[name];
            wasEnabled[name] = !!(handler && typeof handler.enabled === 'function' && handler.enabled());
            if (handler && typeof handler.disable === 'function') handler.disable();
        });
        return function restore() {
            handlers.forEach(name => {
                const handler = map && map[name];
                if (wasEnabled[name] && handler && typeof handler.enable === 'function') handler.enable();
            });
        };
    }

    function ensureTourPane(map) {
        const L = global.L;
        if (!map || !L || typeof map.createPane !== 'function') return null;
        let pane = map.getPane && map.getPane('impactTourPane');
        if (!pane) {
            pane = map.createPane('impactTourPane');
            pane.style.zIndex = 650; // above overlay panes, below markers
            pane.style.pointerEvents = 'none';
        }
        return 'impactTourPane';
    }

    // Fit the focused building into whatever screen area the panel does NOT cover: the map top half on
    // a mobile bottom-sheet, the left of a desktop right-dock. The panel need not touch the viewport
    // edge (the dock keeps a margin), so this is decided from where the panel sits, not from contact.
    function fitBoundsAvoidingPanel(map, bounds, panelEl) {
        if (!map || !bounds || !bounds.isValid || !bounds.isValid()) return;
        let padTL = [24, 24];
        let padBR = [24, 24];
        try {
            const rect = panelEl && panelEl.getBoundingClientRect ? panelEl.getBoundingClientRect() : null;
            const vw = global.innerWidth || 0;
            const vh = global.innerHeight || 0;
            if (rect && vw && vh) {
                const isBottomSheet = rect.width >= vw * 0.6 && rect.top > vh * 0.35;
                if (isBottomSheet) {
                    padBR = [24, Math.round(vh - rect.top) + 24]; // clear the sheet at the bottom
                } else {
                    const onRight = (rect.left + rect.right) / 2 > vw / 2;
                    if (onRight) padBR = [Math.round(vw - rect.left) + 24, 24]; // clear a right dock
                    else padTL = [Math.round(rect.right) + 24, 24];             // clear a left dock
                }
            }
        } catch (_) { }
        try {
            map.fitBounds(bounds, { paddingTopLeft: padTL, paddingBottomRight: padBR, maxZoom: 19, animate: true });
        } catch (_) { }
    }

    // Flat single-choice fallback when the map/Leaflet can't drive a tour (headless or a load-order
    // break): one blanket action for the whole set, so the road flow never silently paves through.
    async function flatFallback(options) {
        if (typeof global.showStyledChoice !== 'function') return 'cancel';
        const choices = [
            { value: 'cut', label: t('modal.corridorTunnel.cut', 'Cut through the buildings'), primary: true },
            { value: 'destroy', label: t('modal.corridorTunnel.destroy', 'Demolish the buildings') },
            { value: 'tunnel', label: t('modal.corridorTunnel.confirm', 'Tunnel through') },
            { value: 'cancel', label: t('modal.corridorTunnel.cancel', 'Choose another route') }
        ];
        const answer = await global.showStyledChoice(options.message || '', choices);
        return answer || 'cancel';
    }

    function showBuildingImpactTour(hits, corridorKind, options = {}) {
        const list = Array.isArray(hits) ? hits.filter(Boolean) : [];
        const map = global.map;
        const L = global.L;
        if (!list.length || !map || !L || typeof L.geoJSON !== 'function') {
            return flatFallback(options);
        }

        return new Promise(resolve => {
            let state = createTourState(list, options.defaultAction || 'cut');
            const restoreInteraction = freezeMapInteraction(map);
            const paneName = ensureTourPane(map);
            let highlightLayer = null;
            let captureOverlay = null;
            let lastZoomedIndex = -1;
            const cleanupFns = [];

            const isMobile = !!(global.matchMedia && global.matchMedia('(max-width: 600px)').matches);

            const panel = document.createElement('div');
            panel.className = 'cb-impact-tour' + (isMobile ? ' cb-impact-tour-sheet' : ' cb-impact-tour-dock');
            panel.setAttribute('role', 'dialog');
            panel.setAttribute('aria-modal', 'true');

            const body = document.createElement('div');
            body.className = 'cb-impact-tour-body';

            const message = document.createElement('div');
            message.className = 'cb-impact-tour-message';
            renderMessageLines(message, options.message || '');
            body.appendChild(message);

            // Global default row
            const globalRow = document.createElement('div');
            globalRow.className = 'cb-impact-tour-global';
            const globalLabel = document.createElement('div');
            globalLabel.className = 'cb-impact-tour-global-label';
            globalLabel.textContent = t('modal.impactTour.applyToAll', 'Apply to all:');
            globalRow.appendChild(globalLabel);
            const globalButtons = document.createElement('div');
            globalButtons.className = 'cb-impact-tour-global-buttons';
            const GLOBAL_CHOICES = [
                { value: 'cut', label: t('modal.impactTour.cutAll', 'Cut all') },
                { value: 'destroy', label: t('modal.impactTour.demolishAll', 'Demolish all') },
                { value: 'tunnel', label: t('modal.impactTour.tunnelAll', 'Tunnel all') }
            ];
            const globalButtonEls = {};
            GLOBAL_CHOICES.forEach(choice => {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'cb-impact-tour-chip';
                btn.textContent = choice.label;
                btn.addEventListener('click', () => { state = tourSetDefault(state, choice.value); render(); });
                globalButtons.appendChild(btn);
                globalButtonEls[choice.value] = btn;
            });
            globalRow.appendChild(globalButtons);
            body.appendChild(globalRow);

            // Per-building tour: nav + name + override radios
            const nav = document.createElement('div');
            nav.className = 'cb-impact-tour-nav';
            const prevBtn = document.createElement('button');
            prevBtn.type = 'button';
            prevBtn.className = 'cb-impact-tour-navbtn';
            prevBtn.setAttribute('aria-label', t('modal.impactTour.prev', 'Previous building'));
            prevBtn.textContent = '‹';
            prevBtn.addEventListener('click', () => { state = tourGoTo(state, state.index - 1); render(); });
            const counter = document.createElement('span');
            counter.className = 'cb-impact-tour-counter';
            const nextBtn = document.createElement('button');
            nextBtn.type = 'button';
            nextBtn.className = 'cb-impact-tour-navbtn';
            nextBtn.setAttribute('aria-label', t('modal.impactTour.next', 'Next building'));
            nextBtn.textContent = '›';
            nextBtn.addEventListener('click', () => { state = tourGoTo(state, state.index + 1); render(); });
            nav.appendChild(prevBtn);
            nav.appendChild(counter);
            nav.appendChild(nextBtn);
            body.appendChild(nav);

            const nameEl = document.createElement('div');
            nameEl.className = 'cb-impact-tour-name';
            body.appendChild(nameEl);

            const choicesEl = document.createElement('div');
            choicesEl.className = 'cb-impact-tour-choices';
            body.appendChild(choicesEl);

            const tally = document.createElement('div');
            tally.className = 'cb-impact-tour-tally';
            body.appendChild(tally);

            panel.appendChild(body);

            const actions = document.createElement('div');
            actions.className = 'cb-impact-tour-actions';
            const cancelBtn = document.createElement('button');
            cancelBtn.type = 'button';
            cancelBtn.className = 'btn btn-secondary';
            cancelBtn.textContent = t('modal.corridorTunnel.cancel', 'Choose another route');
            cancelBtn.addEventListener('click', () => finish('cancel'));
            const applyBtn = document.createElement('button');
            applyBtn.type = 'button';
            applyBtn.className = 'btn btn-action';
            applyBtn.textContent = t('modal.impactTour.apply', 'Apply');
            applyBtn.addEventListener('click', () => finish('apply'));
            actions.appendChild(cancelBtn);
            actions.appendChild(applyBtn);
            panel.appendChild(actions);

            const ACTION_LABELS = () => ({
                cut: t('modal.impactTour.cut', 'Cut'),
                destroy: t('modal.impactTour.demolish', 'Demolish'),
                tunnel: t('modal.impactTour.tunnel', 'Tunnel'),
                unapply: t('modal.corridorTunnel.unapply', 'Unapply existing proposal')
            });

            function effectiveActionOf(hit) {
                const owner = hitIsProposalOwned(hit);
                return tourNormalizeAction(tourEffectiveAction(state, hitId(hit)), owner);
            }

            // Which road geometry to draw as context: an explicit preview passed by the caller, else
            // the current drawing's live segments. Each segment is an array of {lat,lng}.
            function proposedRoadSegments() {
                if (Array.isArray(options.previewLatLngs) && options.previewLatLngs.length) return options.previewLatLngs;
                try {
                    if (typeof global.getAllRoadSegments === 'function') return global.getAllRoadSegments() || [];
                } catch (_) { }
                return [];
            }

            function drawHighlights() {
                if (highlightLayer) { try { map.removeLayer(highlightLayer); } catch (_) { } highlightLayer = null; }
                const paneOpts = paneName ? { pane: paneName } : {};
                const group = L.layerGroup();
                const features = [];
                list.forEach((hit, index) => {
                    const feature = hitFeature(hit);
                    if (!feature) return;
                    const action = effectiveActionOf(hit);
                    features.push({
                        type: 'Feature',
                        properties: { __focused: index === state.index, __color: ACTION_COLORS[action] || '#7c3aed' },
                        geometry: feature.geometry
                    });
                });
                if (features.length) {
                    group.addLayer(L.geoJSON({ type: 'FeatureCollection', features }, {
                        ...paneOpts,
                        interactive: false,
                        style: f => {
                            const focused = f.properties.__focused;
                            const color = f.properties.__color;
                            return {
                                color,
                                weight: focused ? 4 : 1.5,
                                opacity: 1,
                                fillColor: color,
                                fillOpacity: focused ? 0.45 : 0.2,
                                dashArray: focused ? null : '4 3'
                            };
                        }
                    }));
                }
                // The proposed road on top (white casing + blue line) so it reads clearly at every zoom.
                proposedRoadSegments().forEach(segment => {
                    const pts = (Array.isArray(segment) ? segment : [])
                        .filter(p => p && isFinite(p.lat) && isFinite(p.lng))
                        .map(p => [p.lat, p.lng]);
                    if (pts.length < 2) return;
                    group.addLayer(L.polyline(pts, { ...paneOpts, interactive: false, color: '#ffffff', weight: 6, opacity: 0.9 }));
                    group.addLayer(L.polyline(pts, { ...paneOpts, interactive: false, color: '#2563eb', weight: 3, opacity: 1 }));
                });
                highlightLayer = group;
                highlightLayer.addTo(map);
            }

            function zoomToFocused() {
                const hit = list[state.index];
                const feature = hit && hitFeature(hit);
                if (!feature) return;
                try {
                    const bounds = L.geoJSON(feature).getBounds();
                    fitBoundsAvoidingPanel(map, bounds, panel);
                } catch (_) { }
            }

            function render() {
                // Global chips reflect the current default.
                Object.keys(globalButtonEls).forEach(value => {
                    globalButtonEls[value].classList.toggle('is-active', state.defaultAction === value);
                });

                const hit = list[state.index];
                const owner = hitIsProposalOwned(hit);
                counter.textContent = t('modal.impactTour.counter', 'Building {{n}} / {{total}}', {
                    n: state.index + 1, total: state.count
                });
                prevBtn.disabled = state.index <= 0;
                nextBtn.disabled = state.index >= state.count - 1;

                nameEl.textContent = hitLabel(hit, state.index)
                    + (owner ? ` — ${t('modal.impactTour.existingProposal', 'existing proposal')}` : '');

                // Override radios for this building.
                choicesEl.textContent = '';
                const labels = ACTION_LABELS();
                const current = effectiveActionOf(hit);
                tourAllowedActions(owner).forEach(action => {
                    const label = document.createElement('label');
                    label.className = 'cb-impact-tour-choice';
                    const input = document.createElement('input');
                    input.type = 'radio';
                    input.name = 'cb-impact-tour-action';
                    input.value = action;
                    input.checked = current === action;
                    input.addEventListener('change', () => {
                        state = tourSetOverride(state, hitId(hit), action);
                        render();
                    });
                    const swatch = document.createElement('span');
                    swatch.className = 'cb-impact-tour-swatch';
                    swatch.style.background = ACTION_COLORS[action] || '#7c3aed';
                    const text = document.createElement('span');
                    // Proposal-owned "destroy" reads as "Unapply" — it's removed from the map, not razed.
                    text.textContent = (owner && action === 'destroy') ? labels.unapply : labels[action];
                    label.appendChild(input);
                    label.appendChild(swatch);
                    label.appendChild(text);
                    choicesEl.appendChild(label);
                });

                // Live tally across all buildings (effective actions).
                const counts = { cut: 0, destroy: 0, tunnel: 0 };
                list.forEach(h => { counts[effectiveActionOf(h)] = (counts[effectiveActionOf(h)] || 0) + 1; });
                const parts = [];
                if (counts.cut) parts.push(`${labels.cut} ${counts.cut}`);
                if (counts.destroy) parts.push(`${labels.destroy} ${counts.destroy}`);
                if (counts.tunnel) parts.push(`${labels.tunnel} ${counts.tunnel}`);
                tally.textContent = parts.join(' · ');

                drawHighlights();
                // Only re-fit the map when the focused building changes — not on every action toggle,
                // which would yank the view while the user is just picking a radio.
                if (lastZoomedIndex !== state.index) {
                    lastZoomedIndex = state.index;
                    zoomToFocused();
                }
            }

            function onKeydown(event) {
                if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish('cancel'); return; }
                // Enter is the default action: apply the impacts as chosen (Apply is the focused button).
                if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); finish('apply'); return; }
                if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
                    event.preventDefault(); event.stopPropagation();
                    state = tourGoTo(state, state.index + 1); render(); return;
                }
                if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
                    event.preventDefault(); event.stopPropagation();
                    state = tourGoTo(state, state.index - 1); render(); return;
                }
                // Keep drawing hotkeys (F/U/R) from leaking to the page behind the tour.
                event.stopPropagation();
            }

            // Swallow every pointer/scroll event over the map (and everything else behind the panel):
            // disabling Leaflet's handlers alone still lets clicks reach the map and its feature layers,
            // so a transparent full-screen overlay BELOW the panel captures them. The map stays visible
            // (the overlay is transparent) and the tour still drives it programmatically.
            const swallow = event => { event.preventDefault(); event.stopPropagation(); };

            let finished = false;
            function finish(kind) {
                if (finished) return;
                finished = true;
                document.removeEventListener('keydown', onKeydown, true);
                cleanupFns.forEach(fn => { try { fn(); } catch (_) { } });
                if (highlightLayer) { try { map.removeLayer(highlightLayer); } catch (_) { } highlightLayer = null; }
                try { restoreInteraction(); } catch (_) { }
                if (captureOverlay && captureOverlay.parentNode) captureOverlay.parentNode.removeChild(captureOverlay);
                if (panel.parentNode) panel.parentNode.removeChild(panel);
                if (kind === 'cancel') { resolve('cancel'); return; }
                const perBuilding = new Map(Object.entries(state.overrides));
                resolve({ action: state.defaultAction, perBuilding });
            }

            // Desktop dock: align the panel's right edge and width to the road info panel and sit it in
            // the space above, so the two read as one right-hand column instead of overlapping. Falls
            // back to the CSS top-right dock when the road info panel isn't shown. The mobile sheet is
            // laid out entirely by CSS.
            function positionDock() {
                if (isMobile) return;
                const info = document.getElementById('road-info-panel');
                const rect = (info && info.classList.contains('visible') && info.getBoundingClientRect)
                    ? info.getBoundingClientRect() : null;
                if (!rect || !rect.width) {
                    ['right', 'bottom', 'top', 'width', 'maxHeight'].forEach(prop => { panel.style[prop] = ''; });
                    return;
                }
                const vw = global.innerWidth || 0;
                const vh = global.innerHeight || 0;
                const gap = 12;
                const topPx = 16;
                // Sit just above the road info panel, but never let it shrink below a usable height (only
                // an unusually tall road info panel on a short screen would push it that far — then a
                // small overlap is better than an unreadable sliver).
                const bottomPx = Math.min(Math.round(vh - rect.top + gap), Math.max(0, vh - topPx - 260));
                panel.style.width = Math.round(rect.width) + 'px';
                panel.style.right = Math.round(vw - rect.right) + 'px';
                panel.style.top = topPx + 'px';
                panel.style.bottom = bottomPx + 'px';
                panel.style.maxHeight = 'none'; // top + bottom now define the height; the body scrolls
            }

            captureOverlay = document.createElement('div');
            captureOverlay.className = 'cb-impact-tour-capture';
            ['mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu', 'wheel', 'touchstart', 'touchmove', 'touchend']
                .forEach(type => captureOverlay.addEventListener(type, swallow, { passive: false }));

            document.addEventListener('keydown', onKeydown, true);
            global.addEventListener('resize', positionDock);
            cleanupFns.push(() => global.removeEventListener('resize', positionDock));
            document.body.appendChild(captureOverlay);
            document.body.appendChild(panel);
            positionDock();
            render();
            // Apply is the default: focus it so it reads as selected and Enter activates it (the
            // onKeydown Enter branch drives it regardless, but the focus ring shows which is default).
            requestAnimationFrame(() => { try { applyBtn.focus({ preventScroll: true }); } catch (_) { try { applyBtn.focus(); } catch (_) { } } });
        });
    }

    Object.assign(global, { showBuildingImpactTour });
    global.__roadImpactTour = {
        createTourState,
        tourClampIndex,
        tourGoTo,
        tourSetDefault,
        tourSetOverride,
        tourEffectiveAction,
        tourAllowedActions,
        tourNormalizeAction,
        ACTION_COLORS
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = {
            createTourState,
            tourClampIndex,
            tourGoTo,
            tourSetDefault,
            tourSetOverride,
            tourEffectiveAction,
            tourAllowedActions,
            tourNormalizeAction,
            ACTION_COLORS
        };
    }
})(typeof window !== 'undefined' ? window : globalThis);
