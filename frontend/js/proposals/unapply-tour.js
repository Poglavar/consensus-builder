// The unapply/delete dependents panel — the impact tour pointed backwards in time. Where the road
// impact tour asks "what happens to each building this road hits", this panel shows what happens
// to each dependent item if a proposal is un-applied or deleted: a right-docked list over the
// live map, each entry clickable — the map focuses and blinks the item — so "the following will
// be removed" stops being a wall of ids and becomes places you can look at. Dismissal is the
// non-destructive cancel; only the explicit action button proceeds.
//
// The item MODEL (buildUnapplyItems) is pure and node-tested: it classifies each descendant id as
// a dependent proposal (with its claim kind — fabric vs content) or a parcel slice, with display
// labels. The panel half is browser-only and reuses the cb-impact-tour chrome (panels.css).

(function (global) {
    'use strict';

    const claims = () => (global && global.__claims)
        ? global.__claims
        : (typeof require === 'function' ? require('./claims.js') : null);

    // Fabric dependents genuinely lose their ground; content overlays stand on it. Listed fabric
    // first — they are the entries whose removal cascades furthest.
    const KIND_ORDER = Object.freeze({ fabric: 0, content: 1, ground: 2 });

    // Pure: classify raw descendant ids into display items. `accessors`:
    //   getProposal(id)   -> proposal record | null
    //   getParcelInfo(id) -> { broj, isRoad, roadName } | null   (best-effort display info)
    function buildUnapplyItems(descendants, accessors) {
        const acc = accessors || {};
        const getProposal = typeof acc.getProposal === 'function' ? acc.getProposal : () => null;
        const getParcelInfo = typeof acc.getParcelInfo === 'function' ? acc.getParcelInfo : () => null;
        const claimsApi = claims();

        const items = [];
        const seen = new Set();
        (Array.isArray(descendants) ? descendants : []).forEach(raw => {
            const id = raw === undefined || raw === null ? '' : String(raw);
            if (!id || seen.has(id)) return;
            seen.add(id);

            const record = getProposal(id);
            if (record) {
                const claimKind = claimsApi ? claimsApi.claimKindForGoal(record.goal) : 'content';
                items.push({
                    kind: 'proposal',
                    claimKind,
                    id,
                    label: record.title || record.name || id,
                    extra: record.goal ? String(record.goal) : ''
                });
                return;
            }

            const info = getParcelInfo(id) || {};
            items.push({
                kind: 'parcel',
                claimKind: 'ground',
                id,
                label: info.broj ? String(info.broj) : id,
                extra: info.isRoad ? (info.roadName ? String(info.roadName) : 'road') : ''
            });
        });

        items.sort((a, b) => (KIND_ORDER[a.claimKind] - KIND_ORDER[b.claimKind])
            || String(a.label).localeCompare(String(b.label)));
        return items;
    }

    // ── browser half ─────────────────────────────────────────────────────────────────────────

    function t(key, fallback, params = {}) {
        try {
            const helper = (typeof getProposalI18nHelper === 'function') ? getProposalI18nHelper() : null;
            if (helper) return helper(key, fallback, params);
        } catch (_) { }
        return Object.keys(params).reduce(
            (out, name) => out.replace(new RegExp(`{{${name}}}`, 'g'), String(params[name])),
            String(fallback || ''));
    }

    // Same snapshot/restore discipline as the road impact tour: the map stays visible and driven,
    // but the user cannot wander off mid-decision.
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

    function ensurePane(map) {
        const L = global.L;
        if (!map || !L || typeof map.createPane !== 'function') return null;
        let pane = map.getPane && map.getPane('unapplyTourPane');
        if (!pane) {
            pane = map.createPane('unapplyTourPane');
            pane.style.zIndex = 650;
            pane.style.pointerEvents = 'none';
        }
        return 'unapplyTourPane';
    }

    // Fit the focused feature into the screen area the dock does not cover (compact copy of the
    // impact tour's rule: right dock → pad right, bottom sheet → pad bottom).
    function fitAvoidingPanel(map, bounds, panelEl) {
        if (!map || !bounds || !bounds.isValid || !bounds.isValid()) return;
        let padTL = [24, 24];
        let padBR = [24, 24];
        try {
            const rect = panelEl && panelEl.getBoundingClientRect ? panelEl.getBoundingClientRect() : null;
            const vw = global.innerWidth || 0;
            const vh = global.innerHeight || 0;
            if (rect && vw && vh) {
                if (rect.width >= vw * 0.6 && rect.top > vh * 0.35) padBR = [24, Math.round(vh - rect.top) + 24];
                else if ((rect.left + rect.right) / 2 > vw / 2) padBR = [Math.round(vw - rect.left) + 24, 24];
                else padTL = [Math.round(rect.right) + 24, 24];
            }
        } catch (_) { }
        try { map.fitBounds(bounds, { paddingTopLeft: padTL, paddingBottomRight: padBR, maxZoom: 19, animate: true }); } catch (_) { }
    }

    // The geometry to blink for one item. Proposals: their footprint (buildings fall back to the
    // stored building feature footprintOf does not read). Parcels: the layer's own polygon —
    // resolved with includeRemoved, since a consumed slice is exactly what an unapply talks about.
    function featureForItem(item) {
        try {
            if (item.kind === 'proposal') {
                const record = (typeof proposalStorage !== 'undefined' && proposalStorage.getProposal)
                    ? proposalStorage.getProposal(item.id) : null;
                if (!record) return null;
                const planOrderApi = global.__planOrder;
                let footprint = null;
                if (planOrderApi) { try { footprint = planOrderApi.footprintOf(record); } catch (_) { } }
                if (footprint) return footprint;
                const bf = record.buildingProposal && record.buildingProposal.buildingFeature;
                if (bf && bf.geometry) return bf;
                return null;
            }
            const layer = (typeof global.resolveParcelLayerById === 'function')
                ? global.resolveParcelLayerById(item.id, { includeRemoved: true })
                : null;
            if (layer && typeof layer.toGeoJSON === 'function') {
                const gj = layer.toGeoJSON();
                return gj && gj.type === 'FeatureCollection' ? gj.features[0] : gj;
            }
        } catch (_) { }
        return null;
    }

    // The panel. Returns a promise resolving true (action confirmed and onConfirm finished) or
    // false (any way out that is not the action button). Falls back to `null` return — meaning
    // "cannot run here, use your old dialog" — when the map/Leaflet are unavailable.
    function showUnapplyDependentsPanel({ action, proposalId, descendants, onConfirm }) {
        const map = global.map;
        const L = global.L;
        if (!map || !L || typeof L.geoJSON !== 'function' || typeof document === 'undefined') return null;

        const items = buildUnapplyItems(descendants, {
            getProposal: (id) => {
                try {
                    return (typeof proposalStorage !== 'undefined' && proposalStorage.getProposal)
                        ? proposalStorage.getProposal(id) : null;
                } catch (_) { return null; }
            },
            getParcelInfo: (id) => {
                try {
                    const layer = (typeof global.resolveParcelLayerById === 'function')
                        ? global.resolveParcelLayerById(id, { includeRemoved: true }) : null;
                    const props = layer && layer.feature && layer.feature.properties;
                    if (!props) return null;
                    return { broj: props.BROJ_CESTICE || null, isRoad: !!props.isRoad, roadName: props.roadName || null };
                } catch (_) { return null; }
            }
        });
        if (!items.length) return null;

        const isDelete = action === 'delete';
        const sourceTitle = (() => {
            try {
                const record = (typeof proposalStorage !== 'undefined' && proposalStorage.getProposal)
                    ? proposalStorage.getProposal(proposalId) : null;
                return (record && (record.title || record.name)) || String(proposalId || '');
            } catch (_) { return String(proposalId || ''); }
        })();

        return new Promise(resolve => {
            const restoreInteraction = freezeMapInteraction(map);
            const paneName = ensurePane(map);
            const isMobile = !!(global.matchMedia && global.matchMedia('(max-width: 768px)').matches);
            let highlightLayer = null;
            let blinkTimer = null;
            let selectedIndex = -1;
            let busy = false;

            const panel = document.createElement('div');
            panel.className = 'cb-impact-tour cb-unapply-tour '
                + (isMobile ? 'cb-impact-tour-sheet' : 'cb-impact-tour-dock right-dock-panel');
            panel.setAttribute('role', 'dialog');
            panel.setAttribute('aria-modal', 'true');

            const body = document.createElement('div');
            body.className = 'cb-impact-tour-body';

            const title = document.createElement('div');
            title.className = 'cb-unapply-tour-title';
            title.textContent = isDelete
                ? t('modal.unapplyTour.titleDelete', 'Delete “{{title}}”', { title: sourceTitle })
                : t('modal.unapplyTour.titleUnapply', 'Un-apply “{{title}}”', { title: sourceTitle });
            body.appendChild(title);

            const message = document.createElement('div');
            message.className = 'cb-impact-tour-message';
            message.textContent = t('modal.unapplyTour.message',
                'This proposal has dependent items. The following will be removed from the map and storage. Click an item to see it.');
            body.appendChild(message);

            const counts = items.reduce((acc, it) => { acc[it.kind]++; return acc; }, { parcel: 0, proposal: 0 });
            const countsEl = document.createElement('div');
            countsEl.className = 'cb-unapply-tour-counts';
            countsEl.textContent = t('modal.unapplyTour.counts', '{{proposals}} proposal(s) · {{parcels}} parcel slice(s)', {
                proposals: counts.proposal, parcels: counts.parcel
            });
            body.appendChild(countsEl);

            const listEl = document.createElement('div');
            listEl.className = 'cb-unapply-tour-list';
            const rows = items.map((item, index) => {
                const row = document.createElement('button');
                row.type = 'button';
                row.className = 'cb-unapply-tour-item';
                const badge = document.createElement('span');
                badge.className = `cb-unapply-tour-badge cb-unapply-tour-badge-${item.kind === 'proposal' ? item.claimKind : 'parcel'}`;
                badge.textContent = item.kind === 'proposal'
                    ? t('modal.unapplyTour.badgeProposal', 'proposal')
                    : t('modal.unapplyTour.badgeParcel', 'parcel');
                const label = document.createElement('span');
                label.className = 'cb-unapply-tour-label';
                label.textContent = item.label;
                const extra = document.createElement('span');
                extra.className = 'cb-unapply-tour-extra';
                extra.textContent = item.extra || '';
                row.appendChild(badge);
                row.appendChild(label);
                if (item.extra) row.appendChild(extra);
                row.addEventListener('click', () => selectItem(index));
                listEl.appendChild(row);
                return row;
            });
            body.appendChild(listEl);
            panel.appendChild(body);

            const actions = document.createElement('div');
            actions.className = 'cb-impact-tour-actions';
            const cancelBtn = document.createElement('button');
            cancelBtn.type = 'button';
            cancelBtn.className = 'btn btn-secondary';
            cancelBtn.textContent = t('modal.unapplyTour.cancel', 'Cancel');
            cancelBtn.addEventListener('click', () => finish(false));
            const confirmBtn = document.createElement('button');
            confirmBtn.type = 'button';
            confirmBtn.className = 'btn btn-danger cb-unapply-tour-confirm';
            confirmBtn.textContent = isDelete
                ? t('modal.unapplyTour.confirmDelete', 'Delete')
                : t('modal.unapplyTour.confirmUnapply', 'Un-apply');
            confirmBtn.addEventListener('click', async () => {
                if (busy) return;
                busy = true;
                confirmBtn.disabled = true;
                cancelBtn.disabled = true;
                confirmBtn.textContent = t('modal.unapplyTour.working', 'Working…');
                try {
                    if (typeof onConfirm === 'function') await onConfirm();
                    finish(true);
                } catch (error) {
                    // The refusal must reach the user — a silent close reads as "the button does
                    // nothing" (invariant #6 applied to the UI).
                    console.error('[unapply-tour] action failed', error);
                    try {
                        const message = t('modal.unapplyTour.failed', 'Could not complete: {{reason}}', {
                            reason: (error && error.message) ? error.message : 'unknown error'
                        });
                        if (typeof global.showStyledAlert === 'function') global.showStyledAlert(message);
                        else if (typeof global.showEphemeralMessage === 'function') global.showEphemeralMessage(message, 6000, 'error');
                    } catch (_) { }
                    finish(false);
                }
            });
            actions.appendChild(cancelBtn);
            actions.appendChild(confirmBtn);
            panel.appendChild(actions);

            function drawHighlights() {
                if (highlightLayer) { try { map.removeLayer(highlightLayer); } catch (_) { } highlightLayer = null; }
                const paneOpts = paneName ? { pane: paneName } : {};
                const group = L.layerGroup();
                let focusedLayer = null;
                items.forEach((item, index) => {
                    const feature = featureForItem(item);
                    if (!feature) return;
                    const focused = index === selectedIndex;
                    const color = item.kind === 'proposal' ? '#dc2626' : '#ea580c';
                    const layer = L.geoJSON(feature, {
                        ...paneOpts,
                        interactive: false,
                        style: () => ({
                            color,
                            weight: focused ? 4 : 1.5,
                            opacity: 1,
                            fillColor: color,
                            fillOpacity: focused ? 0.4 : 0.15,
                            dashArray: focused ? null : '4 3'
                        })
                    });
                    group.addLayer(layer);
                    if (focused) focusedLayer = layer;
                });
                highlightLayer = group;
                highlightLayer.addTo(map);
                return focusedLayer;
            }

            // Three quick pulses on the focused feature — enough to catch the eye, cheap to stop.
            function blink(layer) {
                if (blinkTimer) { clearInterval(blinkTimer); blinkTimer = null; }
                if (!layer || typeof layer.setStyle !== 'function') return;
                let ticks = 0;
                blinkTimer = setInterval(() => {
                    ticks += 1;
                    const dim = ticks % 2 === 1;
                    try { layer.setStyle({ fillOpacity: dim ? 0.08 : 0.4, weight: dim ? 2 : 4 }); } catch (_) { }
                    if (ticks >= 6) { clearInterval(blinkTimer); blinkTimer = null; }
                }, 220);
            }

            function selectItem(index) {
                selectedIndex = index;
                rows.forEach((row, i) => row.classList.toggle('selected', i === index));
                const focusedLayer = drawHighlights();
                const feature = featureForItem(items[index]);
                if (feature) {
                    try {
                        const bounds = L.geoJSON(feature).getBounds();
                        fitAvoidingPanel(map, bounds, panel);
                    } catch (_) { }
                }
                blink(focusedLayer);
            }

            function onKeydown(event) {
                if (event.key === 'Escape') { event.preventDefault(); finish(false); }
            }

            function finish(confirmed) {
                try { document.removeEventListener('keydown', onKeydown, true); } catch (_) { }
                if (blinkTimer) { clearInterval(blinkTimer); blinkTimer = null; }
                if (highlightLayer) { try { map.removeLayer(highlightLayer); } catch (_) { } highlightLayer = null; }
                try { panel.remove(); } catch (_) { }
                try { restoreInteraction(); } catch (_) { }
                resolve(!!confirmed);
            }

            document.addEventListener('keydown', onKeydown, true);
            document.body.appendChild(panel);
            drawHighlights();
        });
    }

    const api = { buildUnapplyItems, showUnapplyDependentsPanel };

    // Namespaced only — a bare global here could shadow a top-level function in the classic
    // scripts that load alongside this file.
    if (typeof window !== 'undefined') window.__unapplyTour = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
