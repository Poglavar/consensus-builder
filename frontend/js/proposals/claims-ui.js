// Browser layer of the claims model (rethink-proposals.md §13). Three thin pieces over the pure
// __claims module:
//   1. the breadcrumb — every proposal panel names the BASE parcels it stands on, so the
//      ownership anchor is always one tap away (invariant #3 restored);
//   2. the dossier — the parcel info panel lists every proposal claiming this parcel's ground;
//   3. cadastre view — a map view where only the original cadastral parcels are interactive and
//      everything proposed is dimmed context (the §11 frame ladder's first rung).
// All logic lives in claims.js; this file only touches DOM/Leaflet.

(function (global) {
    'use strict';

    const CADASTRE_PANE = 'cadastreViewPane';

    const t = () => (typeof getProposalI18nHelper === 'function')
        ? getProposalI18nHelper()
        : ((key, fallback) => fallback);

    const claims = () => global.__claims || null;

    function cadastreParcelIdsFor(proposal) {
        const api = claims();
        if (!api || !proposal) return [];
        try { return api.cadastreParcelIdsOf(proposal); } catch (_) { return []; }
    }

    function openBaseParcel(parcelId) {
        try {
            const id = String(parcelId);
            const liveFeature = global.LiveParcelFabric?.get?.(id) || null;

            // A cadastral anchor is selectable only when it is itself a live parcel.
            if (liveFeature && typeof global.selectParcel === 'function') {
                global.selectParcel(id, true);
                return;
            }
            // Consumed cadastral ground stays available as an immutable repository fact for the
            // ownership breadcrumb; it is never retained as a hidden interactive Leaflet layer.
            const feature = global.CadastralParcelRepository?.get?.(id) || null;
            if (feature && typeof global.showParcelInfoPanel === 'function') {
                try {
                    const box = global.turf?.bbox?.(feature);
                    if (Array.isArray(box) && box.length >= 4 && typeof map !== 'undefined' && map) {
                        const bounds = [[box[1], box[0]], [box[3], box[2]]];
                        if (!map.getBounds().contains(bounds)) {
                            map.fitBounds(bounds, { padding: [60, 60], maxZoom: 18, animate: false });
                        }
                    }
                } catch (_) { }
                global.showParcelInfoPanel(feature);
                try { document.getElementById('parcel-info-panel')?.classList.add('visible'); } catch (_) { }
                return;
            }
            if (typeof global.selectParcel === 'function') {
                global.selectParcel(id, true);
                return;
            }
            console.warn('[claims-ui] no way to open parcel', parcelId);
        } catch (error) {
            console.warn('[claims-ui] failed to open base parcel', parcelId, error);
        }
    }

    // --- 1. Breadcrumb -------------------------------------------------------------------------

    // Idempotent: re-rendering the panel calls this again, so the previous crumb is replaced.
    function injectProposalBreadcrumb(containerEl, proposal) {
        try {
            if (!containerEl || !proposal) return;
            const api = claims();
            const existing = containerEl.querySelector('.claim-breadcrumb');
            if (existing) existing.remove();

            const ids = cadastreParcelIdsFor(proposal);
            if (!ids.length) return;

            const wrap = document.createElement('div');
            wrap.className = 'claim-breadcrumb';
            const label = document.createElement('span');
            label.className = 'claim-breadcrumb-label';
            label.textContent = t()('claims.onParcels', 'On parcels:');
            wrap.appendChild(label);

            ids.forEach(id => {
                const link = document.createElement('button');
                link.type = 'button';
                link.className = 'claim-breadcrumb-link';
                link.textContent = api ? api.shortParcelLabel(id) : String(id);
                link.title = String(id);
                link.addEventListener('click', (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    openBaseParcel(id);
                });
                wrap.appendChild(link);
            });

            containerEl.insertBefore(wrap, containerEl.firstChild);
        } catch (error) {
            console.warn('[claims-ui] breadcrumb render failed', error);
        }
    }

    // (The dossier — "every proposal claiming this parcel's ground" — lives in the parcel info
    // panel's existing Proposals tab, fed by a claims rescue in parcel-panel.js. One surface.)

    // --- 2. Cadastre view ----------------------------------------------------------------------

    let cadastreLayer = null;

    function ensureCadastrePane() {
        if (typeof map === 'undefined' || !map || typeof map.getPane !== 'function') return null;
        let pane = map.getPane(CADASTRE_PANE);
        if (!pane && typeof map.createPane === 'function') {
            pane = map.createPane(CADASTRE_PANE);
            // Above markers (600), below tooltips (650): clones must catch every click.
            pane.style.zIndex = 640;
        }
        return pane;
    }

    // Clones every retained BASE cadastral fact. Consumed parents are absent from the live fabric
    // and its presentation by design, so the immutable repository is the only complete source.
    function buildCadastreLayer() {
        ensureCadastrePane();
        const group = L.layerGroup([], { pane: CADASTRE_PANE });
        const repository = global.CadastralParcelRepository;
        const features = repository && typeof repository.list === 'function' ? repository.list() : [];
        features.forEach(feature => {
            const key = String(feature?.properties?.parcelId || '');
            if (!key) return;
            try {
                if (!feature || !feature.geometry || !/Polygon/.test(feature.geometry.type || '')) return;
                const baseStyle = { color: '#b91c1c', weight: 1.4, opacity: 0.9, fillColor: '#fef3c7', fillOpacity: 0.28 };
                const hoverStyle = { color: '#7f1d1d', weight: 2.5, opacity: 1, fillColor: '#fde68a', fillOpacity: 0.5 };
                const clone = L.geoJSON(feature, {
                    pane: CADASTRE_PANE,
                    style: baseStyle,
                    onEachFeature: (_f, lyr) => {
                        lyr.on('click', (event) => {
                            try { if (event && event.originalEvent) L.DomEvent.stop(event); } catch (_) { }
                            openBaseParcel(key);
                        });
                        // Hover highlight: the clones are the only interactive surface in this
                        // view, so the affordance lives here rather than on the hidden originals.
                        lyr.on('mouseover', () => { try { lyr.setStyle(hoverStyle); lyr.bringToFront?.(); } catch (_) { } });
                        lyr.on('mouseout', () => { try { lyr.setStyle(baseStyle); } catch (_) { } });
                    }
                });
                group.addLayer(clone);
            } catch (_) { /* a layer that cannot serialise is simply not shown */ }
        });
        return group;
    }

    function setCadastreView(active) {
        const on = active === true;
        if (on === (global.cadastreViewActive === true)) return on;
        global.cadastreViewActive = on;
        try { document.body.classList.toggle('cadastre-view', on); } catch (_) { }
        const button = document.getElementById('cadastre-view-toggle');
        if (button) button.classList.toggle('active', on);
        try {
            if (on) {
                cadastreLayer = buildCadastreLayer();
                cadastreLayer.addTo(map);
            } else if (cadastreLayer) {
                map.removeLayer(cadastreLayer);
                cadastreLayer = null;
            }
        } catch (error) {
            console.warn('[claims-ui] cadastre view toggle failed', error);
        }
        try { window.dispatchEvent(new CustomEvent('cadastreViewChanged', { detail: { active: on } })); } catch (_) { }
        return on;
    }

    function toggleCadastreView() {
        return setCadastreView(!(global.cadastreViewActive === true));
    }

    function initCadastreViewToggle() {
        const button = document.getElementById('cadastre-view-toggle');
        if (!button) return;
        button.addEventListener('click', () => toggleCadastreView());
    }

    if (typeof document !== 'undefined') {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', initCadastreViewToggle, { once: true });
        } else {
            initCadastreViewToggle();
        }
    }

    const api = {
        injectProposalBreadcrumb,
        openBaseParcel,
        setCadastreView,
        toggleCadastreView
    };

    if (typeof window !== 'undefined') window.__claimsUi = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
