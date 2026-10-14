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
        pathCursor: null,
        rubberBand: null,
        geometryDrag: null,
        polygonEditor: null,
        layer: null,
        panel: null,
        session: null,
        reselectKey: null,
        lakeError: null
    };

    // Everything the editor draws lives in its own pane ABOVE the structure panes (squares
    // surface z=630, icons 632; parks 625/627) — default marker/overlay panes sit BELOW them,
    // which buried the editor's icons under the square's semi-transparent surface.
    const EDITOR_PANE = 'onMapEditorPane';
    const EDIT_LOCK_OWNER = 'structure-geometry-editor';

    // The panel is built in JS, so it translates at build time: same fallback-aware helper the
    // other JS-built panels use (window.i18n.t returns the key itself when a string is missing).
    function t(key, fallback, params = {}) {
        const fullKey = `structureEditor.${key}`;
        const api = global.i18n;
        if (api && typeof api.t === 'function') {
            const translated = api.t(fullKey, params);
            if (translated && translated !== fullKey) return translated;
        }
        return fallback;
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

    function translateCoordinateCollection(value, deltaLng, deltaLat) {
        if (!Array.isArray(value)) return value;
        if (value.length >= 2 && Number.isFinite(Number(value[0])) && Number.isFinite(Number(value[1]))) {
            return [Number(value[0]) + deltaLng, Number(value[1]) + deltaLat];
        }
        return value.map(item => translateCoordinateCollection(item, deltaLng, deltaLat));
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

    function lakeOuterRing(boundary) {
        const geometry = boundary?.geometry;
        if (geometry?.type === 'Polygon') return geometry.coordinates?.[0] || null;
        if (geometry?.type === 'MultiPolygon' && geometry.coordinates?.length === 1) {
            return geometry.coordinates[0]?.[0] || null;
        }
        return null;
    }

    function closeRing(ring) {
        if (!Array.isArray(ring) || ring.length < 3) return null;
        const points = ring.map(coordinate).filter(Boolean);
        if (points.length < 3) return null;
        points.push(points[0].slice());
        return points;
    }

    function oneConnectedLakeGeometry(geometry) {
        const value = geometry?.type === 'Feature' ? geometry.geometry : geometry;
        return value?.type === 'Polygon'
            || (value?.type === 'MultiPolygon' && Array.isArray(value.coordinates) && value.coordinates.length === 1);
    }

    function hasExplicitDecorationDesign(kind, decorations) {
        if (!decorations || typeof decorations !== 'object') return false;
        const decorationKeys = kind === 'park'
            ? ['trees', 'flowerbeds', 'ponds', 'paths', 'benches']
            : ['fountains', 'fountain', 'trees', 'benches', 'stalls', 'statues'];
        return Number.isFinite(Number(decorations.version))
            || decorationKeys.some(key => Object.prototype.hasOwnProperty.call(decorations, key));
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
        // An explicit schema (even with every list empty) is a deliberate saved design. Only fall
        // back to the rendered feature for legacy proposals that never stored decorations at all.
        if (hasExplicitDecorationDesign(state.kind, direct)) return direct;
        const proposalId = draft?.sourceProposalId || draft?.sourceSnapshot?.proposalId || draft?.sourceSnapshot?.id;
        if (!proposalId) return direct || null;
        const collection = state.kind === 'park' ? global.parks : global.squares;
        const feature = (Array.isArray(collection) ? collection : []).find(entry => String(entry?.properties?.proposalId || '') === String(proposalId));
        try {
            if (feature && state.kind === 'park') global.ensureParkDecorations?.(feature);
            if (feature && state.kind === 'square') global.ensureSquareDecorations?.(feature);
        } catch (_) { }
        return feature?.properties?.decorations || direct || null;
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
        if (typeof global.updateStatus === 'function') global.updateStatus(t('statusOutside', 'Place items inside the structure boundary.'));
    }

    function removeDecoration(type, index) {
        const list = state.decorations?.[type];
        if (!Array.isArray(list) || index < 0 || index >= list.length) return;
        recordHistory();
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

    function geometryInsideBoundary(type, coordinates) {
        if (!Array.isArray(coordinates)) return false;
        if (type === 'paths') {
            try {
                const line = global.turf.lineString(coordinates);
                return global.turf.booleanWithin(line, state.boundary);
            } catch (_) { return coordinates.every(pointInside); }
        }
        return ringInside(coordinates);
    }

    function endGeometryDrag() {
        const drag = state.geometryDrag;
        state.geometryDrag = null;
        if (global.map) {
            global.map.off('mousemove', moveGeometryDrag);
            global.map.off('touchmove', moveGeometryDrag);
            global.map.off('mouseup', endGeometryDrag);
            global.map.off('touchend', endGeometryDrag);
            global.map.off('touchcancel', endGeometryDrag);
            if (drag?.mapDraggingWasEnabled) {
                try { global.map.dragging?.enable?.(); } catch (_) { }
            }
        }
        global.document?.removeEventListener('mouseup', endGeometryDrag);
        global.document?.removeEventListener('touchend', endGeometryDrag);
        global.document?.removeEventListener('touchcancel', endGeometryDrag);
        if (!drag) return;
        if (drag.lastValid) state.decorations[drag.type][drag.index] = drag.lastValid;
        if (drag.rejected && !drag.lastValid) rejectOutside();
        render();
    }

    function moveGeometryDrag(event) {
        const drag = state.geometryDrag;
        const latlng = event?.latlng;
        if (!drag || !latlng) return;
        const next = translateCoordinateCollection(
            drag.original,
            latlng.lng - drag.start.lng,
            latlng.lat - drag.start.lat
        );
        if (!geometryInsideBoundary(drag.type, next)) {
            drag.rejected = true;
            return;
        }
        drag.lastValid = next;
        try { drag.layer.setLatLngs(next.map(([lng, lat]) => [lat, lng])); } catch (_) { }
    }

    function startGeometryDrag(event, layer, type, index) {
        if (state.tool === 'erase' || state.geometryDrag) return;
        recordHistory();   // before the item changes, so undo returns it
        const original = clone(state.decorations?.[type]?.[index]);
        if (!Array.isArray(original) || !event?.latlng) return;
        try {
            if (event.originalEvent) global.L.DomEvent.stop(event.originalEvent);
            else global.L.DomEvent.stopPropagation(event);
        } catch (_) { }
        state.geometryDrag = {
            layer,
            type,
            index,
            original,
            start: { lng: event.latlng.lng, lat: event.latlng.lat },
            lastValid: null,
            rejected: false,
            mapDraggingWasEnabled: global.map?.dragging?.enabled?.() === true
        };
        try { global.map?.dragging?.disable?.(); } catch (_) { }
        global.map?.on('mousemove', moveGeometryDrag);
        global.map?.on('touchmove', moveGeometryDrag);
        global.map?.on('mouseup', endGeometryDrag);
        global.map?.on('touchend', endGeometryDrag);
        global.map?.on('touchcancel', endGeometryDrag);
        global.document?.addEventListener('mouseup', endGeometryDrag);
        global.document?.addEventListener('touchend', endGeometryDrag);
        global.document?.addEventListener('touchcancel', endGeometryDrag);
    }

    function bindDraggableGeometry(layer, type, index) {
        bindErasable(layer, type, index);
        layer.on('mousedown', event => startGeometryDrag(event, layer, type, index));
        layer.on('touchstart', event => startGeometryDrag(event, layer, type, index));
        return layer;
    }

    function addPointMarker(group, type, coord, index, icon) {
        const marker = global.L.marker([coord[1], coord[0]], {
            icon,
            draggable: true,
            keyboard: true,
            // Point handles must stay above interactive paths regardless of the map's pan offset.
            pane: state.session.handlePane
        }).addTo(group);
        marker.on('dragstart', recordHistory);
        marker.on('dragend', () => {
            const next = marker.getLatLng();
            const nextCoord = [next.lng, next.lat];
            if (!pointInside(nextCoord)) {
                const previous = type === 'benches'
                    ? state.decorations.benches[index].coordinate
                    : state.decorations[type][index];
                marker.setLatLng([previous[1], previous[0]]);
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
        state.decorations.paths.forEach((path, index) => bindDraggableGeometry(global.L.polyline(path.map(([lng, lat]) => [lat, lng]), {
            color: '#f7edc8', weight: 5, opacity: 0.95, dashArray: '8 5', pane: EDITOR_PANE,
            className: 'structure-geometry-draggable'
        }).addTo(group), 'paths', index));
        state.decorations.ponds.forEach((ring, index) => bindDraggableGeometry(global.L.polygon(ring.map(([lng, lat]) => [lat, lng]), {
            color: '#1d4ed8', fillColor: '#38bdf8', fillOpacity: 0.75, weight: 2, pane: EDITOR_PANE,
            className: 'structure-geometry-draggable'
        }).addTo(group), 'ponds', index));
        state.decorations.flowerbeds.forEach((ring, index) => bindDraggableGeometry(global.L.polygon(ring.map(([lng, lat]) => [lat, lng]), {
            color: '#be185d', fillColor: '#f472b6', fillOpacity: 0.78, weight: 2, pane: EDITOR_PANE,
            className: 'structure-geometry-draggable'
        }).addTo(group), 'flowerbeds', index));
        state.decorations.trees.forEach((coord, index) => addPointMarker(group, 'trees', coord, index, makeIcon('is-tree', '🌳')));
        (state.decorations.benches || []).forEach((bench, index) => addPointMarker(group, 'benches', bench.coordinate, index, makeIcon('is-bench', '▰')));
        if (state.pathPoints.length) {
            global.L.polyline(state.pathPoints.map(([lng, lat]) => [lat, lng]), {
                color: '#f59e0b', weight: 4, dashArray: '5 5', pane: EDITOR_PANE
            }).addTo(group);
        }
        updateRubberBand();
    }

    // The segment from the last placed point to the pointer. Without it a half-drawn path just
    // sits there and the editor gives no sign that it is waiting for the next click. Red while
    // the pointer is outside the boundary, because finishing there is refused anyway.
    function updateRubberBand() {
        const live = state.tool === 'path' && state.pathPoints.length && state.pathCursor && state.layer;
        if (!live) {
            if (state.rubberBand && state.layer) state.layer.removeLayer(state.rubberBand);
            state.rubberBand = null;
            return;
        }
        const [fromLng, fromLat] = state.pathPoints[state.pathPoints.length - 1];
        const [toLng, toLat] = state.pathCursor;
        const latlngs = [[fromLat, fromLng], [toLat, toLng]];
        const color = pointInside(state.pathCursor) ? '#f59e0b' : '#dc2626';
        if (state.rubberBand) {
            state.rubberBand.setLatLngs(latlngs);
            state.rubberBand.setStyle({ color });
            return;
        }
        state.rubberBand = global.L.polyline(latlngs, {
            color, weight: 3, opacity: 0.9, dashArray: '4 6', interactive: false, pane: EDITOR_PANE
        }).addTo(state.layer);
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

    // Undo for furniture edits, on the shared stack every geometry editor uses.
    let historyCtl = null;

    function ensureHistory() {
        if (historyCtl) return historyCtl;
        const factory = global.GeometryEditHistory;
        if (!factory) return null;
        historyCtl = factory.create({
            capture: () => clone(state.decorations),
            restore: (snapshot) => {
                state.decorations = clone(snapshot);
                render();
            }
        });
        historyCtl.bindKeyboard(global.document || global, {
            enabled: () => !!state.decorations   // only while the editor owns the map
        });
        return historyCtl;
    }

    function recordHistory() {
        const h = ensureHistory();
        if (h) h.record();
    }

    function render() {
        if (!state.layer || !global.map) return;
        state.layer.clearLayers();
        // clearLayers just dropped it; renderPark rebuilds it from the live cursor.
        state.rubberBand = null;
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
        if (state.kind === 'lake') {
            const graphics = global.buildLakeGraphicsFromGeometry?.(state.boundary?.geometry) || null;
            state.lakeError = lakeBoundaryFailure(graphics);
            renderLakePreview(graphics);
            updatePanelState();
            return;
        }
        if (state.kind === 'park') renderPark(state.layer);
        else renderSquare(state.layer);
        updatePanelState();
    }

    function renderLakePreview(graphics) {
        if (!graphics) return;
        [
            [graphics.shore, { color: '#c48b4a', weight: 2, opacity: 0.9, fillColor: '#f3d7a0', fillOpacity: 0.9 }],
            [graphics.transition, { color: '#2c7abf', weight: 1.2, opacity: 0.55, fillColor: '#3c92d6', fillOpacity: 0.45 }],
            [graphics.water, { color: '#1769aa', weight: 1, opacity: 0.75, fillColor: '#258bd2', fillOpacity: 0.85 }]
        ].forEach(([geometry, style]) => {
            if (!geometry) return;
            global.L.geoJSON(geometry, { style: { ...style, pane: EDITOR_PANE }, pane: EDITOR_PANE, interactive: false }).addTo(state.layer);
        });
    }

    function commitLakeOuterRing(ring) {
        const closed = closeRing(ring);
        const geometry = clone(state.boundary?.geometry);
        if (!closed || !geometry) return false;
        if (geometry.type === 'Polygon') {
            geometry.coordinates = [closed, ...(geometry.coordinates || []).slice(1)];
        } else if (geometry.type === 'MultiPolygon' && geometry.coordinates?.length === 1) {
            geometry.coordinates = [[closed, ...(geometry.coordinates[0] || []).slice(1)]];
        } else {
            return false;
        }
        state.boundary.geometry = geometry;
        render();
        return true;
    }

    function localizedFailure(key, fallback) {
        const fullKey = `proposalApplyFailures.${key}`;
        try {
            const translated = global.i18n?.t?.(fullKey);
            if (translated && translated !== fullKey) return translated;
        } catch (_) { }
        return fallback;
    }

    function unavailableLakeCheck(reason) {
        if (reason === 'adapter') {
            const key = 'proposalDrafts.design.unavailable';
            try {
                const translated = global.i18n?.t?.(key);
                if (translated && translated !== key) return { code: 'lake-adapter-unavailable', message: translated };
            } catch (_) { }
            return { code: 'lake-adapter-unavailable', message: 'This design editor is unavailable.' };
        }
        return {
            code: 'cadastral-ground-unavailable',
            message: localizedFailure('groundUnavailable', 'Cadastral parcel data could not be loaded. Check your connection and try again.')
        };
    }

    function lakeBoundaryFailure(graphics) {
        if (!graphics || !oneConnectedLakeGeometry(graphics.geometry || state.boundary?.geometry)) {
            return {
                code: 'proposal-footprint-invalid',
                message: t('lakeInvalid', 'A lake boundary must form one connected area. Adjust the outline and try again.')
            };
        }

        const manager = global.ProposalManager;
        if (!manager || typeof manager.getProposalGroundFailure !== 'function') return unavailableLakeCheck('manager');
        const adapter = global.proposalEditorAdapterRegistry?.get?.('lake');
        if (!adapter || typeof adapter.serializeProposal !== 'function') return unavailableLakeCheck('adapter');

        const draft = global.proposalDraftStore?.getDraft?.(state.draftId);
        if (!draft) {
            return {
                code: 'proposal-not-found',
                message: localizedFailure('notFound', 'This proposal is no longer available. Refresh the proposals list and try again.')
            };
        }

        // Match the final serializer pipeline against a private candidate. Keep both geometry
        // projections aligned: the adapter reads editorPayload.geometry for the record footprint
        // and structureProposal.geometry for the authored structure payload.
        const candidate = clone(draft);
        candidate.editorPayload = clone(candidate.editorPayload || {});
        const structureProposal = clone(candidate.editorPayload.structureProposal || {});
        structureProposal.kind = 'lake';
        structureProposal.geometry = clone(state.boundary.geometry);
        structureProposal.lakeGraphics = clone(graphics);
        delete structureProposal.decorations;
        candidate.editorPayload.structureProposal = structureProposal;
        candidate.editorPayload.geometry = clone(state.boundary.geometry);
        candidate.previewGeometry = clone(state.boundary.geometry);
        let record;
        try { record = adapter.serializeProposal(candidate); } catch (_) {
            return {
                code: 'proposal-footprint-invalid',
                message: localizedFailure('invalidGeometry', 'The proposal geometry is missing or invalid. Edit its geometry before applying.')
            };
        }
        if (!record || typeof record !== 'object') {
            return {
                code: 'proposal-footprint-invalid',
                message: localizedFailure('invalidGeometry', 'The proposal geometry is missing or invalid. Edit its geometry before applying.')
            };
        }
        let failure;
        try { failure = manager.getProposalGroundFailure(record); } catch (_) {
            return unavailableLakeCheck('manager');
        }
        if (!failure) return null;
        return {
            ...failure,
            message: failure.message || localizedFailure('groundUnavailable', 'Cadastral parcel data could not be loaded. Check your connection and try again.')
        };
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
        state.pathCursor = null;
        render();
    }

    // Cheap: the rubber band is moved in place rather than through a full render, so dragging the
    // pointer across the park does not rebuild every tree, bench and pond on every frame.
    function onMapMouseMove(event) {
        if (state.tool !== 'path' || !state.pathPoints.length) return;
        state.pathCursor = [event.latlng.lng, event.latlng.lat];
        updateRubberBand();
    }

    function setTool(tool) {
        if (state.tool === 'path' && tool !== 'path') finishPath();
        state.tool = tool;
        updatePanelState();
    }

    // A tool is a .btn toggle: the chosen one is aria-pressed (css/primitives.css).
    function toolButton(tool, icon, label) {
        return `<button type="button" class="btn btn-sm" data-tool="${tool}" aria-pressed="false"><i class="fa-solid ${icon}" aria-hidden="true"></i>${label}</button>`;
    }

    function panelMarkup() {
        if (state.kind === 'lake') {
            return `
                <p class="on-map-editor__hint">${t('instructionsLake', 'Drag boundary points to reshape the lake. Click an edge to add a point; select a point to remove it.')}</p>
                <p class="structure-geometry-options">${t('lakeBoundaryHint', 'The lake shape and its generated shore and water graphics will be saved together.')}</p>
                <p class="structure-geometry-error" data-role="lake-error" role="alert" hidden></p>
                <p class="on-map-editor__hint" data-role="hint"></p>`;
        }
        const tools = state.kind === 'park'
            ? [
                toolButton('tree', 'fa-tree', t('tools.tree', 'Tree')),
                toolButton('flowerbed', 'fa-seedling', t('tools.flowerbed', 'Flowerbed')),
                toolButton('pond', 'fa-water', t('tools.pond', 'Pond')),
                toolButton('path', 'fa-shoe-prints', t('tools.path', 'Footpath')),
                toolButton('bench', 'fa-chair', t('tools.bench', 'Bench'))
            ].join('')
            : [
                toolButton('fountain', 'fa-droplet', t('tools.fountain', 'Fountain')),
                toolButton('tree', 'fa-tree', t('tools.tree', 'Tree')),
                toolButton('bench', 'fa-chair', t('tools.bench', 'Bench')),
                toolButton('stall', 'fa-utensils', t('tools.stall', 'Table')),
                toolButton('statue', 'fa-monument', t('tools.statue', 'Statue'))
            ].join('');
        const title = state.kind === 'park'
            ? t('titlePark', 'Park editor')
            : t('titleSquare', 'Square editor');
        return `
            <p class="on-map-editor__hint">${title}. ${t('instructions', 'Choose an item, then click inside the boundary. Drag any item to move it.')}</p>
            <div class="structure-geometry-tools">${tools}${toolButton('erase', 'fa-eraser', t('tools.erase', 'Remove'))}</div>
            <div class="structure-geometry-options">
                <button type="button" class="btn btn-sm" data-action="finish-path">${t('finishPath', 'Finish path')}</button>
            </div><p class="on-map-editor__hint" data-role="hint"></p>`;
    }

    function footerMarkup() {
        return `<button type="button" class="btn" data-action="cancel">${t('cancel', 'Cancel')}</button><button type="button" class="btn btn-primary" data-action="save">${t('save', 'Save design')}</button>`;
    }

    function updatePanelState() {
        const panel = state.panel;
        if (!panel) return;
        panel.querySelectorAll('[data-tool]').forEach(button => {
            const active = button.dataset.tool === state.tool;
            button.setAttribute('aria-pressed', active ? 'true' : 'false');
        });
        const finish = panel.querySelector('[data-action="finish-path"]');
        if (finish) {
            finish.hidden = state.kind !== 'park' || state.tool !== 'path';
            finish.disabled = state.pathPoints.length < 2;
        }
        const hint = panel.querySelector('[data-role="hint"]');
        if (hint) hint.textContent = state.kind === 'lake'
            ? t('hintLake', 'Use the map points to reshape the lake boundary. Undo is available on the map.')
            : (state.tool === 'erase'
            ? t('hintErase', 'Click an item to remove it.')
            : (state.tool
                ? t('hintPlace', 'Click the map to place the selected item.')
                : t('hintSelect', 'Select an item to begin.')));
        if (state.kind === 'lake') {
            const error = panel.querySelector('[data-role="lake-error"]');
            if (error) {
                error.textContent = state.lakeError?.message || '';
                error.hidden = !state.lakeError;
            }
            const save = panel.querySelector('[data-action="save"]');
            if (save) save.disabled = !!state.lakeError;
        }
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
        if (event.key === 'Enter' && state.tool === 'path') {
            event.preventDefault();
            finishPath();
        }
    }

    function closeEditor(saved) {
        const isCommit = global.isProposalDesignCommitSession?.() === true;
        const draftId = state.draftId;
        const reselectKey = state.reselectKey || null;
        state.reselectKey = null;
        state.lakeError = null;
        if (state.geometryDrag) endGeometryDrag();
        if (state.polygonEditor) {
            try { state.polygonEditor.destroy(); } catch (_) { }
            state.polygonEditor = null;
        }
        if (global.map) {
            global.map.off('click', onMapClick);
            global.map.off('mousemove', onMapMouseMove);
            if (state.layer) global.map.removeLayer(state.layer);
        }
        global.document?.removeEventListener('keydown', onKeyDown, true);
        state.panel?.removeEventListener?.('click', handlePanelClick);
        const session = state.session;
        state.session = null;
        state.panel = null;
        state.draftId = null;
        state.kind = null;
        state.boundary = null;
        state.decorations = null;
        if (historyCtl) { historyCtl.destroy(); historyCtl = null; }
        state.tool = null;
        state.pathPoints = [];
        state.pathCursor = null;
        state.rubberBand = null;
        state.geometryDrag = null;
        state.layer = null;
        state.polygonEditor = null;
        // Hand the map back BEFORE anything below re-selects a proposal — those calls are the
        // editor's own, and must not be turned away by the lock it just held.
        if (session?.close) session.close();
        else global.__mapEditLock?.release(EDIT_LOCK_OWNER);
        // Cancel must not commit a retained draft whose previous save failed.
        if (!saved && isCommit) global.discardProposalDraftDesignSession?.();
        let finished = true;
        if (draftId && typeof global.finishProposalDraftDesignSession === 'function') {
            finished = global.finishProposalDraftDesignSession(draftId) !== null;
        }
        // The applied structure resumes rendering its own decorations.
        if (global.structureGeometryEditorEditingProposalId) {
            global.structureGeometryEditorEditingProposalId = null;
            try { global.updateParksLayer?.(); } catch (_) { }
            try { global.updateSquaresLayer?.(); } catch (_) { }
            try { global.updateLakesLayer?.(); } catch (_) { }
        }
        // Commit sessions report their actual async result in the shared proposal shell.
        if (saved && finished && !isCommit && typeof global.updateStatus === 'function') global.updateStatus(t('statusSaved', 'Structure design saved.'));
        // The editor replaced the proposal card for its duration — on cancel, bring the card
        // back for the proposal that was selected. (On save the shell re-selects the rebuilt
        // proposal itself, which may carry a NEW id.)
        if (!saved && reselectKey && typeof global.selectAndHighlightProposal === 'function') {
            try { global.selectAndHighlightProposal(reselectKey, null, false, true); } catch (_) { }
        }
        return finished;
    }

    function saveEditor() {
        if (!state.draftId) return false;
        if (state.tool === 'path') finishPath();
        const draft = global.proposalDraftStore?.getDraft?.(state.draftId);
        if (!draft) {
            global.reportProposalDesignSaveFailure?.();
            return false;
        }
        const current = clone(draft.editorPayload?.structureProposal || {});
        current.kind = state.kind;
        current.geometry = clone(state.boundary.geometry);
        if (state.kind === 'lake') {
            const graphics = global.buildLakeGraphicsFromGeometry?.(current.geometry);
            state.lakeError = lakeBoundaryFailure(graphics);
            updatePanelState();
            if (state.lakeError) return false;
            current.lakeGraphics = clone(graphics);
            delete current.decorations;
        } else {
            current.decorations = clone(state.decorations);
        }
        try {
            const updated = global.syncActiveProposalDraftFromEditor?.('structure', { structureProposal: current }, { coalesceKey: 'editor:structure' });
            if (!updated) {
                global.reportProposalDesignSaveFailure?.();
                return false;
            }
        } catch (error) {
            global.reportProposalDesignSaveFailure?.(error);
            return false;
        }
        return closeEditor(true);
    }

    function openStructureGeometryEditor(draftOrId) {
        if (!global.map || !global.L || !global.turf || !global.OnMapEditor?.open || state.draftId) return false;
        const draft = typeof draftOrId === 'string' ? global.proposalDraftStore?.getDraft?.(draftOrId) : draftOrId;
        const kind = draft?.adapterKey || draft?.goal;
        if (!draft || !['park', 'square', 'lake'].includes(kind)) return false;
        const rawGeometry = draft.editorPayload?.structureProposal?.geometry || draft.editorPayload?.geometry || draft.previewGeometry;
        const boundary = boundaryFeature(rawGeometry);
        if (!boundary) return false;
        const initialLakeRing = kind === 'lake' ? lakeOuterRing(boundary) : null;
        if (kind === 'lake' && (!oneConnectedLakeGeometry(boundary.geometry)
            || !Array.isArray(initialLakeRing) || initialLakeRing.length < 4
            || typeof global.PolygonGeometryEditor?.create !== 'function')) return false;
        state.kind = kind;
        state.boundary = boundary;
        state.decorations = kind === 'lake' ? null : normalizeDecorations(kind, sourceDecorations(draft));
        state.lakeError = null;
        state.tool = null;
        state.pathPoints = [];
        state.pathCursor = null;
        state.rubberBand = null;
        state.reselectKey = global.ProposalSelection?.getKey?.() || null;
        const title = kind === 'lake'
            ? t('titleLake', 'Lake boundary editor')
            : (kind === 'park' ? t('titlePark', 'Park editor') : t('titleSquare', 'Square editor'));
        let session = null;
        session = global.OnMapEditor.open({
            owner: EDIT_LOCK_OWNER,
            id: 'structure-geometry-editor',
            title,
            content: panelMarkup(),
            footer: footerMarkup(),
            modes: ['2d'],
            onCancel: () => closeEditor(false),
            onModeChange: mode => {
                if (mode === '2d' && state.session === session) session.fitFeature(boundary, { maxZoom: 20 });
            }
        });
        if (!session) {
            state.kind = null;
            state.boundary = null;
            state.decorations = null;
            state.reselectKey = null;
            return false;
        }
        state.session = session;
        state.draftId = draft.id;
        state.panel = session.root;
        state.panel.addEventListener('click', handlePanelClick);
        state.layer = global.L.layerGroup().addTo(global.map);
        // Hide the applied structure's own decoration rendering for the duration — the editor
        // shows the live editable copy, and static duplicates read as "objects I cannot drag".
        global.structureGeometryEditorEditingProposalId = draft?.sourceProposalId
            || draft?.sourceSnapshot?.proposalId || draft?.sourceSnapshot?.id || null;
        try { global.updateParksLayer?.(); } catch (_) { }
        try { global.updateSquaresLayer?.(); } catch (_) { }
        try { global.updateLakesLayer?.(); } catch (_) { }
        if (kind !== 'lake') {
            global.map.on('click', onMapClick);
            global.map.on('mousemove', onMapMouseMove);
        }
        global.document?.addEventListener('keydown', onKeyDown, true);
        render();
        if (kind === 'lake') {
            state.polygonEditor = global.PolygonGeometryEditor.create({
                map: global.map,
                pane: session.handlePane || EDITOR_PANE,
                leaflet: global.L,
                turf: global.turf,
                ring: initialLakeRing,
                vertexTitle: t('lakeVertexTitle', 'Drag to reshape the lake boundary'),
                deleteTitle: t('lakeDeleteVertexTitle', 'Delete this boundary point'),
                undoTitle: t('lakeUndoTitle', 'Undo lake boundary edit'),
                onCommit: ({ ring }) => commitLakeOuterRing(ring)
            });
        }
        if (!global.isThreeModeActive?.()) session.fitFeature(boundary, { maxZoom: 20 });
        return true;
    }

    global.openStructureGeometryEditor = openStructureGeometryEditor;
    global.closeStructureGeometryEditor = () => closeEditor(false);
    // While the editor is open, the map belongs to it: parcel click/hover handlers consult this.
    global.isStructureGeometryEditorActive = () => !!state.draftId;

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = {
            normalizeDecorations,
            boundaryFeature,
            hasExplicitDecorationDesign,
            translateCoordinateCollection
        };
    }
})(typeof window !== 'undefined' ? window : globalThis);
