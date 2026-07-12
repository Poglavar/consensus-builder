// Purpose: show saved road/track drafts on the 2D map as a sketchy dotted overlay — visually
// distinct from the blue-dashed proposal outlines — with click-to-resume. The draft currently
// being drawn is skipped (the drawing tool renders it live).
(function attachDraftRoadLayer(global) {
    'use strict';

    const DRAFT_STYLE = {
        color: '#64748b',
        weight: 3,
        dashArray: '2 8',
        lineCap: 'round',
        fillColor: '#64748b',
        fillOpacity: 0.08,
        className: 'draft-road-outline'
    };

    let group = null;

    function currentCityId() {
        try { return global.CityConfigManager?.getCurrentCityId?.() || null; } catch (_) { return null; }
    }

    function corridorDrawingActive() {
        return global.roadDrawingMode === true || global.trackDrawingMode === true;
    }

    function draftGeometry(draft) {
        const polygon = draft.editorPayload?.definition?.polygon || draft.previewGeometry || null;
        if (!polygon) return null;
        if (polygon.type) return polygon;
        return Array.isArray(polygon) ? { type: 'Polygon', coordinates: polygon } : null;
    }

    function tooltipText(draft) {
        const name = draft.fields?.name || 'Draft';
        let label = 'Draft — click to continue';
        try {
            const translated = global.i18n?.t?.('proposalDrafts.mapTooltip');
            if (translated && translated !== 'proposalDrafts.mapTooltip') label = translated;
        } catch (_) { }
        return `✏️ ${name} · ${label}`;
    }

    function refresh() {
        const map = global.map;
        if (!map || !global.L || !global.proposalDraftStore) return;
        // A dedicated pane above the parcel overlay, so the sketch stays visible and clickable
        // no matter how many parcel layers are re-added on pan/zoom.
        if (!map.getPane('draft-roads')) {
            map.createPane('draft-roads').style.zIndex = 460;
        }
        if (!group) group = global.L.layerGroup().addTo(map);
        group.clearLayers();
        const editingId = global.activeProposalDesignDraftId || null;
        global.proposalDraftStore.listDrafts({ cityId: currentCityId(), goal: 'road-track' }).forEach(draft => {
            if (draft.id === editingId) return;
            const geometry = draftGeometry(draft);
            if (!geometry) return;
            // The visible sketch is thin and dotted, so a separate invisible fat stroke provides a
            // forgiving click/hover target; the visual layer itself stays non-interactive.
            let visual = null;
            let hit = null;
            try {
                const feature = { type: 'Feature', properties: {}, geometry };
                visual = global.L.geoJSON(feature, { style: DRAFT_STYLE, interactive: false, pane: 'draft-roads' });
                hit = global.L.geoJSON(feature, {
                    pane: 'draft-roads',
                    style: { color: '#000000', opacity: 0, weight: 18, fillColor: '#000000', fillOpacity: 0 }
                });
            } catch (_) { return; }
            hit.bindTooltip(tooltipText(draft), { sticky: true });
            hit.on('click', (event) => {
                // While another corridor is being drawn, let the click fall through and add a point.
                if (corridorDrawingActive()) return;
                try { global.L.DomEvent.stop(event.originalEvent || event); } catch (_) { }
                // A draft road is an unfinished drawing — clicking it continues the drawing.
                if (typeof global.openProposalDraftDesign === 'function') {
                    Promise.resolve(global.openProposalDraftDesign(draft.id)).catch(() => { });
                }
            });
            group.addLayer(visual);
            group.addLayer(hit);
        });
    }

    let attempts = 0;
    function initWhenMapReady() {
        if (global.map && global.proposalDraftStore) { refresh(); return; }
        if (attempts++ < 40) setTimeout(initWhenMapReady, 250);
    }

    if (global.document) {
        global.document.addEventListener('proposal-drafts-changed', refresh);
        if (global.document.readyState === 'loading') global.document.addEventListener('DOMContentLoaded', initWhenMapReady);
        else initWhenMapReady();
    }

    global.refreshDraftRoadLayer = refresh;
})(typeof window !== 'undefined' ? window : globalThis);
