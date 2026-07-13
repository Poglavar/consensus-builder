// Purpose: a small map editor for placing park and square furniture inside their parcel boundary.
(function attachStructureGeometryEditor(global) {
    'use strict';

    const state = {
        draftId: null,
        kind: null,
        boundary: null,
        decorations: null,
        tool: null,
        pathPoints: [],
        layer: null,
        panel: null,
        reselectKey: null
    };

    // Everything the editor draws lives in its own pane ABOVE the structure panes (squares
    // surface z=630, icons 632; parks 625/627) — default marker/overlay panes sit BELOW them,
    // which buried the editor's icons under the square's semi-transparent surface.
    const EDITOR_PANE = 'structureGeometryEditorPane';
    function ensureEditorPane() {
        if (!global.map || typeof global.map.getPane !== 'function') return;
        let pane = global.map.getPane(EDITOR_PANE);
        if (!pane && typeof global.map.createPane === 'function') {
            pane = global.map.createPane(EDITOR_PANE);
            if (pane) pane.style.zIndex = '655';
        }
    }

    function clone(value) {
        if (value === undefined || value === null) return value;
        try { return JSON.parse(JSON.stringify(value)); } catch (_) { return value; }
    }

    function coordinate(value) {
        if (!Array.isArray(value) || value.length < 2) return null;
        const lng = Number(value[0]);
        const lat = Number(value[1]);
        return Number.isFinite(lng) && Number.isFinite(lat) ? [lng, lat] : null;
    }

    function normalizeDecorations(kind, input) {
        const value = clone(input || {});
        if (kind === 'park') {
            return {
                trees: (Array.isArray(value.trees) ? value.trees : []).map(coordinate).filter(Boolean),
                flowerbeds: (Array.isArray(value.flowerbeds) ? value.flowerbeds : []).filter(Array.isArray),
                ponds: (Array.isArray(value.ponds) ? value.ponds : []).filter(Array.isArray),
                paths: (Array.isArray(value.paths) ? value.paths : []).map(path => (Array.isArray(path) ? path.map(coordinate).filter(Boolean) : [])).filter(path => path.length > 1),
                // Benches are first-class placeable objects (same as trees) — no orientation UI.
                benches: (Array.isArray(value.benches) ? value.benches : []).map(bench => {
                    const point = coordinate(bench?.coordinate || bench?.position || bench);
                    return point ? { coordinate: point, bearing: ((Number(bench?.bearing) || 0) % 360 + 360) % 360 } : null;
                }).filter(Boolean),
                version: 3
            };
        }
        const fountains = Array.isArray(value.fountains)
            ? value.fountains
            : (coordinate(value.fountain) ? [value.fountain] : []);
        return {
            fountains: fountains.map(coordinate).filter(Boolean),
            trees: (Array.isArray(value.trees) ? value.trees : []).map(coordinate).filter(Boolean),
            benches: (Array.isArray(value.benches) ? value.benches : []).map(bench => {
                const point = coordinate(bench?.coordinate || bench?.position || bench);
                return point ? { coordinate: point, bearing: ((Number(bench?.bearing) || 0) % 360 + 360) % 360 } : null;
            }).filter(Boolean),
            stalls: (Array.isArray(value.stalls) ? value.stalls : []).map(coordinate).filter(Boolean),
            statues: (Array.isArray(value.statues) ? value.statues : []).map(coordinate).filter(Boolean),
            version: 2
        };
    }

    function boundaryFeature(raw) {
        const geometry = raw?.type === 'Feature' ? raw.geometry : (raw?.geometry || raw);
        if (!geometry || !['Polygon', 'MultiPolygon'].includes(geometry.type)) return null;
        return { type: 'Feature', properties: {}, geometry: clone(geometry) };
    }

    function pointInside(coord) {
        try {
            return !!(state.boundary && global.turf?.booleanPointInPolygon(global.turf.point(coord), state.boundary));
        } catch (_) { return false; }
    }

    function ringInside(ring) {
        try {
            const polygon = global.turf.polygon([ring]);
            return global.turf.booleanWithin(polygon, state.boundary)
                || global.turf.booleanEqual?.(polygon, state.boundary) === true;
        } catch (_) { return false; }
    }

    function sourceDecorations(draft) {
        const direct = draft?.editorPayload?.structureProposal?.decorations;
        if (direct) return direct;
        const proposalId = draft?.sourceProposalId || draft?.sourceSnapshot?.proposalId || draft?.sourceSnapshot?.id;
        if (!proposalId) return null;
        const collection = state.kind === 'park' ? global.parks : global.squares;
        const feature = (Array.isArray(collection) ? collection : []).find(entry => String(entry?.properties?.proposalId || '') === String(proposalId));
        return feature?.properties?.decorations || null;
    }

    function makeIcon(className, html, size = 26) {
        return global.L.divIcon({
            className: `structure-geometry-icon ${className}`,
            html,
            iconSize: [size, size],
            iconAnchor: [size / 2, size / 2]
        });
    }

    function rejectOutside() {
        if (typeof global.updateStatus === 'function') global.updateStatus('Place items inside the structure boundary.');
    }

    function removeDecoration(type, index) {
        const list = state.decorations?.[type];
        if (!Array.isArray(list) || index < 0 || index >= list.length) return;
        list.splice(index, 1);
        render();
    }

    function bindErasable(layer, type, index) {
        layer.on('click', event => {
            global.L.DomEvent.stopPropagation(event);
            if (state.tool === 'erase') removeDecoration(type, index);
        });
        return layer;
    }

    function addPointMarker(group, type, coord, index, icon, options = {}) {
        const marker = global.L.marker([coord[1], coord[0]], {
            icon,
            draggable: true,
            keyboard: true,
            pane: EDITOR_PANE,
            zIndexOffset: options.zIndexOffset || 500
        }).addTo(group);
        marker.on('dragend', () => {
            const next = marker.getLatLng();
            const nextCoord = [next.lng, next.lat];
            if (!pointInside(nextCoord)) {
                marker.setLatLng([coord[1], coord[0]]);
                rejectOutside();
                return;
            }
            if (type === 'benches') state.decorations.benches[index].coordinate = nextCoord;
            else state.decorations[type][index] = nextCoord;
        });
        marker.on('click', event => {
            global.L.DomEvent.stopPropagation(event);
            if (state.tool === 'erase') removeDecoration(type, index);
        });
    }

    function renderPark(group) {
        state.decorations.paths.forEach((path, index) => bindErasable(global.L.polyline(path.map(([lng, lat]) => [lat, lng]), {
            color: '#f7edc8', weight: 5, opacity: 0.95, dashArray: '8 5', pane: EDITOR_PANE
        }).addTo(group), 'paths', index));
        state.decorations.ponds.forEach((ring, index) => bindErasable(global.L.polygon(ring.map(([lng, lat]) => [lat, lng]), {
            color: '#1d4ed8', fillColor: '#38bdf8', fillOpacity: 0.75, weight: 2, pane: EDITOR_PANE
        }).addTo(group), 'ponds', index));
        state.decorations.flowerbeds.forEach((ring, index) => bindErasable(global.L.polygon(ring.map(([lng, lat]) => [lat, lng]), {
            color: '#be185d', fillColor: '#f472b6', fillOpacity: 0.78, weight: 2, pane: EDITOR_PANE
        }).addTo(group), 'flowerbeds', index));
        state.decorations.trees.forEach((coord, index) => addPointMarker(group, 'trees', coord, index, makeIcon('is-tree', '🌳')));
        (state.decorations.benches || []).forEach((bench, index) => addPointMarker(group, 'benches', bench.coordinate, index, makeIcon('is-bench', '▰')));
        if (state.pathPoints.length) {
            global.L.polyline(state.pathPoints.map(([lng, lat]) => [lat, lng]), {
                color: '#f59e0b', weight: 4, dashArray: '5 5', pane: EDITOR_PANE
            }).addTo(group);
        }
    }

    function renderSquare(group) {
        state.decorations.fountains.forEach((coord, index) => addPointMarker(group, 'fountains', coord, index, makeIcon('is-fountain', '⛲', 30)));
        state.decorations.trees.forEach((coord, index) => addPointMarker(group, 'trees', coord, index, makeIcon('is-tree', '🌳')));
        state.decorations.benches.forEach((bench, index) => {
            const icon = makeIcon('is-bench', `<span style="transform:rotate(${bench.bearing || 0}deg)">▰</span>`);
            addPointMarker(group, 'benches', bench.coordinate, index, icon);
        });
        (state.decorations.stalls || []).forEach((coord, index) => addPointMarker(group, 'stalls', coord, index, makeIcon('is-stall', '🍽️')));
        (state.decorations.statues || []).forEach((coord, index) => addPointMarker(group, 'statues', coord, index, makeIcon('is-statue', '🗿')));
    }

    function render() {
        if (!state.layer || !global.map) return;
        state.layer.clearLayers();
        global.L.geoJSON(state.boundary, {
            style: {
                color: state.kind === 'park' ? '#15803d' : '#475569',
                fillColor: state.kind === 'park' ? '#86efac' : '#d1d5db',
                fillOpacity: 0.22,
                weight: 3,
                dashArray: '8 5'
            },
            interactive: false,
            pane: EDITOR_PANE
        }).addTo(state.layer);
        if (state.kind === 'park') renderPark(state.layer);
        else renderSquare(state.layer);
        updatePanelState();
    }

    function circleRing(center, radiusMeters) {
        try {
            return global.turf.circle(center, radiusMeters, { units: 'meters', steps: 32 }).geometry.coordinates[0];
        } catch (_) {
            const d = radiusMeters / 111320;
            const ring = [];
            for (let index = 0; index <= 32; index++) {
                const angle = (index / 32) * Math.PI * 2;
                ring.push([center[0] + Math.cos(angle) * d, center[1] + Math.sin(angle) * d]);
            }
            return ring;
        }
    }

    function footprintRadius() {
        const zoom = Number(global.map?.getZoom?.()) || 18;
        return Math.max(2, Math.min(10, 7 - (zoom - 17) * 0.8));
    }

    function placeAt(coord) {
        if (!pointInside(coord)) return rejectOutside();
        if (state.kind === 'park') {
            if (state.tool === 'tree') state.decorations.trees.push(coord);
            else if (state.tool === 'pond' || state.tool === 'flowerbed') {
                const ring = circleRing(coord, footprintRadius());
                if (!ringInside(ring)) return rejectOutside();
                state.decorations[state.tool === 'pond' ? 'ponds' : 'flowerbeds'].push(ring);
            } else if (state.tool === 'path') {
                state.pathPoints.push(coord);
            } else if (state.tool === 'bench') {
                state.decorations.benches.push({ coordinate: coord, bearing: 0 });
            }
        } else {
            if (state.tool === 'fountain') state.decorations.fountains.push(coord);
            else if (state.tool === 'tree') state.decorations.trees.push(coord);
            else if (state.tool === 'bench') {
                state.decorations.benches.push({ coordinate: coord, bearing: 0 });
            }
            else if (state.tool === 'stall') state.decorations.stalls.push(coord);
            else if (state.tool === 'statue') state.decorations.statues.push(coord);
        }
        render();
    }

    function finishPath() {
        if (state.pathPoints.length > 1) {
            let valid = false;
            try {
                valid = global.turf.booleanWithin(global.turf.lineString(state.pathPoints), state.boundary);
            } catch (_) { valid = false; }
            if (valid) state.decorations.paths.push(state.pathPoints.slice());
            else rejectOutside();
        }
        state.pathPoints = [];
        render();
    }

    function setTool(tool) {
        if (state.tool === 'path' && tool !== 'path') finishPath();
        state.tool = tool;
        updatePanelState();
    }

    function toolButton(tool, icon, label) {
        return `<button type="button" data-tool="${tool}" aria-pressed="false"><span>${icon}</span>${label}</button>`;
    }

    function ensurePanel() {
        if (state.panel || !global.document?.body) return state.panel;
        const panel = global.document.createElement('section');
        panel.className = 'structure-geometry-editor';
        panel.setAttribute('aria-label', 'Structure geometry editor');
        panel.addEventListener('click', handlePanelClick);
        global.document.body.appendChild(panel);
        state.panel = panel;
        return panel;
    }

    function panelMarkup() {
        const tools = state.kind === 'park'
            ? [
                toolButton('tree', '🌳', 'Tree'),
                toolButton('flowerbed', '🌸', 'Flowerbed'),
                toolButton('pond', '💧', 'Pond'),
                toolButton('path', '〰', 'Footpath'),
                toolButton('bench', '▰', 'Bench')
            ].join('')
            : [
                toolButton('fountain', '⛲', 'Fountain'),
                toolButton('tree', '🌳', 'Tree'),
                toolButton('bench', '▰', 'Bench'),
                toolButton('stall', '🍽️', 'Table'),
                toolButton('statue', '🗿', 'Statue')
            ].join('');
        return `
            <header><div><strong>${state.kind === 'park' ? 'Park' : 'Square'} editor</strong><small>Choose an item, then click inside the boundary. Drag point items to move them.</small></div><button type="button" data-action="cancel" aria-label="Close">×</button></header>
            <div class="structure-geometry-tools">${tools}${toolButton('erase', '⌫', 'Remove')}</div>
            <div class="structure-geometry-options">
                <button type="button" data-action="finish-path">Finish path</button>
            </div>
            <footer><span data-role="hint"></span><div><button type="button" data-action="cancel">Cancel</button><button type="button" data-action="save" class="is-primary">Save design</button></div></footer>`;
    }

    function updatePanelState() {
        const panel = state.panel;
        if (!panel) return;
        panel.querySelectorAll('[data-tool]').forEach(button => {
            const active = button.dataset.tool === state.tool;
            button.classList.toggle('is-active', active);
            button.setAttribute('aria-pressed', active ? 'true' : 'false');
        });
        const finish = panel.querySelector('[data-action="finish-path"]');
        if (finish) {
            finish.hidden = state.kind !== 'park' || state.tool !== 'path';
            finish.disabled = state.pathPoints.length < 2;
        }
        const hint = panel.querySelector('[data-role="hint"]');
        if (hint) hint.textContent = state.tool === 'erase'
            ? 'Click an item to remove it.'
            : (state.tool ? 'Click the map to place the selected item.' : 'Select an item to begin.');
    }

    function handlePanelClick(event) {
        const toolButton = event.target?.closest?.('.structure-geometry-tools [data-tool]');
        const tool = toolButton?.dataset.tool;
        if (tool) return setTool(tool);
        const action = event.target?.closest?.('[data-action]')?.dataset.action;
        if (action === 'finish-path') finishPath();
        else if (action === 'cancel') closeEditor(false);
        else if (action === 'save') saveEditor();
    }

    function onMapClick(event) {
        if (!state.draftId || !state.tool || state.tool === 'erase') return;
        placeAt([event.latlng.lng, event.latlng.lat]);
    }

    function onKeyDown(event) {
        if (!state.draftId) return;
        if (event.key === 'Escape') {
            event.preventDefault();
            closeEditor(false);
        } else if (event.key === 'Enter' && state.tool === 'path') {
            event.preventDefault();
            finishPath();
        }
    }

    function closeEditor(saved) {
        const draftId = state.draftId;
        const reselectKey = state.reselectKey || null;
        state.reselectKey = null;
        if (global.map) {
            global.map.off('click', onMapClick);
            if (state.layer) global.map.removeLayer(state.layer);
        }
        global.document?.removeEventListener('keydown', onKeyDown, true);
        if (state.panel) state.panel.classList.remove('is-open');
        state.draftId = null;
        state.kind = null;
        state.boundary = null;
        state.decorations = null;
        state.tool = null;
        state.pathPoints = [];
        state.layer = null;
        if (draftId && typeof global.finishProposalDraftDesignSession === 'function') {
            global.finishProposalDraftDesignSession(draftId);
        }
        // The applied structure resumes rendering its own decorations.
        if (global.structureGeometryEditorEditingProposalId) {
            global.structureGeometryEditorEditingProposalId = null;
            try { global.updateParksLayer?.(); } catch (_) { }
            try { global.updateSquaresLayer?.(); } catch (_) { }
        }
        if (saved && typeof global.updateStatus === 'function') global.updateStatus('Structure design saved.');
        // The editor replaced the proposal card for its duration — on cancel, bring the card
        // back for the proposal that was selected. (On save the shell re-selects the rebuilt
        // proposal itself, which may carry a NEW id.)
        if (!saved && reselectKey && typeof global.selectAndHighlightProposal === 'function') {
            try { global.selectAndHighlightProposal(reselectKey, null, false, true); } catch (_) { }
        }
    }

    function saveEditor() {
        if (!state.draftId) return false;
        if (state.tool === 'path') finishPath();
        const draft = global.proposalDraftStore?.getDraft?.(state.draftId);
        if (!draft) return closeEditor(false);
        const current = clone(draft.editorPayload?.structureProposal || {});
        current.kind = state.kind;
        current.geometry = clone(state.boundary.geometry);
        current.parentParcelIds = clone(draft.fields?.parentParcelIds || current.parentParcelIds || []);
        current.decorations = clone(state.decorations);
        global.syncActiveProposalDraftFromEditor?.('structure', { structureProposal: current }, { coalesceKey: 'editor:structure' });
        closeEditor(true);
        return true;
    }

    function openStructureGeometryEditor(draftOrId) {
        if (!global.map || !global.L || !global.turf) return false;
        const draft = typeof draftOrId === 'string' ? global.proposalDraftStore?.getDraft?.(draftOrId) : draftOrId;
        const kind = draft?.adapterKey || draft?.goal;
        if (!draft || !['park', 'square'].includes(kind)) return false;
        const rawGeometry = draft.editorPayload?.structureProposal?.geometry || draft.editorPayload?.geometry || draft.previewGeometry;
        const boundary = boundaryFeature(rawGeometry);
        if (!boundary) return false;
        if (state.draftId) closeEditor(false);
        state.draftId = draft.id;
        state.kind = kind;
        state.boundary = boundary;
        state.decorations = normalizeDecorations(kind, sourceDecorations(draft));
        state.tool = null;
        state.pathPoints = [];
        ensureEditorPane();
        state.layer = global.L.layerGroup().addTo(global.map);
        // The editor owns the map and the UI for its duration: remember which proposal card was
        // open (restored on cancel), then close the proposal card and any parcel panel — the
        // editor panel replaces them. Parcel hover/click stays suppressed via
        // isStructureGeometryEditorActive (checked in the parcel handlers).
        state.reselectKey = global.ProposalSelection?.getKey?.() || null;
        try { global.hideProposalDetailsPanel?.(true); } catch (_) { }
        try { global.hideParcelInfoPanel?.(); } catch (_) { }
        // Hide the applied structure's own decoration rendering for the duration — the editor
        // shows the live editable copy, and static duplicates read as "objects I cannot drag".
        global.structureGeometryEditorEditingProposalId = draft?.sourceProposalId
            || draft?.sourceSnapshot?.proposalId || draft?.sourceSnapshot?.id || null;
        try { global.updateParksLayer?.(); } catch (_) { }
        try { global.updateSquaresLayer?.(); } catch (_) { }
        const panel = ensurePanel();
        panel.innerHTML = panelMarkup();
        panel.classList.add('is-open');
        global.map.on('click', onMapClick);
        global.document?.addEventListener('keydown', onKeyDown, true);
        render();
        try {
            const bounds = global.L.geoJSON(boundary).getBounds();
            if (bounds?.isValid?.()) global.map.fitBounds(bounds, { padding: [80, 80], maxZoom: 20 });
        } catch (_) { }
        return true;
    }

    global.openStructureGeometryEditor = openStructureGeometryEditor;
    global.closeStructureGeometryEditor = () => closeEditor(false);
    // While the editor is open, the map belongs to it: parcel click/hover handlers consult this.
    global.isStructureGeometryEditorActive = () => !!state.draftId;

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { normalizeDecorations, boundaryFeature };
    }
})(typeof window !== 'undefined' ? window : globalThis);
