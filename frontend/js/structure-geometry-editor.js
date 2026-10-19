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
        boundaryDrag: null,
        polygonEditor: null,
        layer: null,
        panel: null,
        session: null,
        reselectKey: null,
        lakeError: null,
        initialSite: null
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

    function moveDecorations(value, from, to) {
        const moveCoordinates = global.SingleBuildingGeometry?.moveCoordinateCollection;
        if (typeof moveCoordinates !== 'function' || !value) return value;
        const moved = { ...clone(value) };
        for (const [key, coordinates] of Object.entries(value)) {
            if (key !== 'benches' && Array.isArray(coordinates)) {
                moved[key] = moveCoordinates(coordinates, from, to);
            }
        }
        // Bench records carry metadata beside their point, so move the nested coordinate
        // explicitly and preserve each bearing without mutating the drag's starting snapshot.
        if (Array.isArray(value.benches)) {
            moved.benches = value.benches.map(bench => ({
                ...bench,
                coordinate: moveCoordinates(bench.coordinate, from, to)
            }));
        }
        return moved;
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

    function startBoundaryDrag(event) {
        if (state.tool !== 'move' || state.boundaryDrag || !event?.latlng || !state.boundary?.geometry) return;
        try {
            if (event.originalEvent) global.L.DomEvent.stop(event.originalEvent);
            else global.L.DomEvent.stopPropagation(event);
        } catch (_) { }
        const latlng = event.latlng;
        state.boundaryDrag = {
            startBoundary: clone(state.boundary),
            startDecorations: clone(state.decorations),
            startPathPoints: clone(state.pathPoints),
            from: { lng: Number(latlng.lng), lat: Number(latlng.lat) },
            recorded: false,
            mapDraggingWasEnabled: global.map?.dragging?.enabled?.() === true
        };
        try { global.map?.dragging?.disable?.(); } catch (_) { }
        global.map?.on('mousemove', moveBoundaryDrag);
        global.map?.on('touchmove', moveBoundaryDrag);
        global.map?.on('mouseup', endBoundaryDrag);
        global.map?.on('touchend', endBoundaryDrag);
        global.map?.on('touchcancel', endBoundaryDrag);
        global.document?.addEventListener('mouseup', endBoundaryDrag);
        global.document?.addEventListener('touchend', endBoundaryDrag);
        global.document?.addEventListener('touchcancel', endBoundaryDrag);
    }

    function moveBoundaryDrag(event) {
        const drag = state.boundaryDrag;
        const latlng = event?.latlng;
        if (!drag || !latlng || !Number.isFinite(latlng.lng) || !Number.isFinite(latlng.lat)) return;
        const placement = state.session?.placement;
        const rawTo = { lng: Number(latlng.lng), lat: Number(latlng.lat) };
        let target = rawTo;
        try {
            target = placement?.moveTarget?.(drag.startBoundary.geometry, drag.from, rawTo, event.originalEvent) || rawTo;
        } catch (_) { return; }
        if (!target || !Number.isFinite(target.lng) || !Number.isFinite(target.lat)) return;
        if (Math.abs(target.lng - drag.from.lng) < 1e-12 && Math.abs(target.lat - drag.from.lat) < 1e-12) return;
        const moveCoordinates = global.SingleBuildingGeometry?.moveCoordinateCollection;
        if (typeof moveCoordinates !== 'function' || typeof global.SingleBuildingGeometry?.moveGeometry !== 'function') {
            if (!drag.missingHelperReported) {
                drag.missingHelperReported = true;
                global.updateStatus?.(t('moveUnavailable', 'Could not move this design. Try again.'));
            }
            return;
        }
        let feature;
        let decorations;
        let pathPoints;
        try {
            const geometry = global.SingleBuildingGeometry.moveGeometry(drag.startBoundary.geometry, drag.from, target);
            feature = { ...clone(drag.startBoundary), geometry };
            if (placement?.accepts && !placement.accepts(feature)) return;
            decorations = drag.startDecorations
                ? moveDecorations(drag.startDecorations, drag.from, target)
                : drag.startDecorations;
            pathPoints = moveCoordinates(drag.startPathPoints || [], drag.from, target);
        } catch (_) {
            if (!drag.missingHelperReported) {
                drag.missingHelperReported = true;
                global.updateStatus?.(t('moveUnavailable', 'Could not move this design. Try again.'));
            }
            return;
        }
        if (!drag.recorded) {
            recordHistory();
            drag.recorded = true;
        }
        state.boundary = feature;
        state.decorations = decorations;
        state.pathPoints = pathPoints;
        state.pathCursor = null;
        placement?.update?.(feature);
        render();
    }

    function endBoundaryDrag() {
        const drag = state.boundaryDrag;
        state.boundaryDrag = null;
        if (!drag) return;
        if (global.map) {
            global.map.off('mousemove', moveBoundaryDrag);
            global.map.off('touchmove', moveBoundaryDrag);
            global.map.off('mouseup', endBoundaryDrag);
            global.map.off('touchend', endBoundaryDrag);
            global.map.off('touchcancel', endBoundaryDrag);
            if (drag.mapDraggingWasEnabled) {
                try { global.map.dragging?.enable?.(); } catch (_) { }
            }
        }
        global.document?.removeEventListener('mouseup', endBoundaryDrag);
        global.document?.removeEventListener('touchend', endBoundaryDrag);
        global.document?.removeEventListener('touchcancel', endBoundaryDrag);
        const changed = JSON.stringify(state.boundary?.geometry) !== JSON.stringify(drag.startBoundary.geometry);
        if (drag.recorded && !changed) historyCtl?.discardLast?.();
        state.session?.placement?.update?.(state.boundary);
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
        if (state.tool === 'move') return layer;
        bindErasable(layer, type, index);
        layer.on('mousedown', event => startGeometryDrag(event, layer, type, index));
        layer.on('touchstart', event => startGeometryDrag(event, layer, type, index));
        return layer;
    }

    function addPointMarker(group, type, coord, index, icon) {
        const marker = global.L.marker([coord[1], coord[0]], {
            icon,
            interactive: state.tool !== 'move',
            draggable: state.tool !== 'move',
            keyboard: state.tool !== 'move',
            // Point handles must stay above interactive paths regardless of the map's pan offset.
            pane: state.session.handlePane
        }).addTo(group);
        if (state.tool === 'move') return marker;
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
            interactive: state.tool !== 'move',
            className: 'structure-geometry-draggable'
        }).addTo(group), 'paths', index));
        state.decorations.ponds.forEach((ring, index) => bindDraggableGeometry(global.L.polygon(ring.map(([lng, lat]) => [lat, lng]), {
            color: '#1d4ed8', fillColor: '#38bdf8', fillOpacity: 0.75, weight: 2, pane: EDITOR_PANE,
            interactive: state.tool !== 'move',
            className: 'structure-geometry-draggable'
        }).addTo(group), 'ponds', index));
        state.decorations.flowerbeds.forEach((ring, index) => bindDraggableGeometry(global.L.polygon(ring.map(([lng, lat]) => [lat, lng]), {
            color: '#be185d', fillColor: '#f472b6', fillOpacity: 0.78, weight: 2, pane: EDITOR_PANE,
            interactive: state.tool !== 'move',
            className: 'structure-geometry-draggable'
        }).addTo(group), 'flowerbeds', index));
        state.decorations.trees.forEach((coord, index) => addPointMarker(group, 'trees', coord, index, makeIcon('is-tree', '🌳')));
        (state.decorations.benches || []).forEach((bench, index) => addPointMarker(group, 'benches', bench.coordinate, index, makeIcon('is-bench', '▰')));
        if (state.pathPoints.length) {
            global.L.polyline(state.pathPoints.map(([lng, lat]) => [lat, lng]), {
                color: '#f59e0b', weight: 4, dashArray: '5 5', pane: EDITOR_PANE,
                interactive: state.tool !== 'move'
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
            capture: () => ({
                boundary: clone(state.boundary),
                decorations: clone(state.decorations),
                pathPoints: clone(state.pathPoints)
            }),
            restore: (snapshot) => {
                state.boundary = clone(snapshot.boundary);
                state.decorations = clone(snapshot.decorations);
                state.pathPoints = clone(snapshot.pathPoints);
                state.pathCursor = null;
                state.session?.placement?.update?.(state.boundary);
                render();
                state.polygonEditor?.render?.({ refreshRing: true });
            }
        });
        historyCtl.bindKeyboard(global.document || global, {
            enabled: () => !!state.draftId   // only while the editor owns the map
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
            interactive: state.tool === 'move',
            pane: EDITOR_PANE,
            onEachFeature: (_feature, layer) => {
                if (state.tool !== 'move') return;
                layer.on('mousedown', startBoundaryDrag);
                layer.on('touchstart', startBoundaryDrag);
            },
            className: 'structure-geometry-boundary'
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

    function commitLakeOuterRing(ring, reason = 'move') {
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
        const currentRing = lakeOuterRing(state.boundary);
        const same = currentRing?.length === closed.length
            && currentRing.every((point, index) => point[0] === closed[index][0] && point[1] === closed[index][1]);
        if (same) {
            if (reason === 'move') historyCtl?.discardLast?.();
            return true;
        }
        if (reason !== 'move') recordHistory();
        state.boundary.geometry = geometry;
        state.session?.placement?.update?.(state.boundary);
        render();
        state.polygonEditor?.render?.({ refreshRing: true });
        return true;
    }

    function lakeBoundaryFailure(graphics) {
        const geometry = graphics?.geometry || state.boundary?.geometry;
        const ring = lakeOuterRing({ geometry });
        let simpleRing = false;
        try { simpleRing = !!global.SingleBuildingGeometry?.isSimpleRing?.(ring); } catch (_) { }
        if (!graphics || !oneConnectedLakeGeometry(geometry)
            || !Array.isArray(ring) || ring.length < 4 || !simpleRing) {
            return {
                code: 'proposal-footprint-invalid',
                message: t('lakeInvalid', 'A lake boundary must form one connected area. Adjust the outline and try again.')
            };
        }
        return null;
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
            if (state.tool === 'tree') {
                recordHistory();
                state.decorations.trees.push(coord);
            }
            else if (state.tool === 'pond' || state.tool === 'flowerbed') {
                const ring = circleRing(coord, footprintRadius());
                if (!ringInside(ring)) return rejectOutside();
                recordHistory();
                state.decorations[state.tool === 'pond' ? 'ponds' : 'flowerbeds'].push(ring);
            } else if (state.tool === 'path') {
                recordHistory();
                state.pathPoints.push(coord);
            } else if (state.tool === 'bench') {
                recordHistory();
                state.decorations.benches.push({ coordinate: coord, bearing: 0 });
            }
        } else {
            if (state.tool === 'fountain') {
                recordHistory();
                state.decorations.fountains.push(coord);
            }
            else if (state.tool === 'tree') {
                recordHistory();
                state.decorations.trees.push(coord);
            }
            else if (state.tool === 'bench') {
                recordHistory();
                state.decorations.benches.push({ coordinate: coord, bearing: 0 });
            }
            else if (state.tool === 'stall') {
                recordHistory();
                state.decorations.stalls.push(coord);
            }
            else if (state.tool === 'statue') {
                recordHistory();
                state.decorations.statues.push(coord);
            }
        }
        render();
    }

    function finishPath() {
        if (state.pathPoints.length > 1) {
            let valid = false;
            try {
                valid = global.turf.booleanWithin(global.turf.lineString(state.pathPoints), state.boundary);
            } catch (_) { valid = false; }
            if (valid) {
                recordHistory();
                state.decorations.paths.push(state.pathPoints.slice());
            }
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

    function createLakePolygonEditor() {
        if (state.kind !== 'lake' || !state.session || state.polygonEditor) return state.polygonEditor;
        const ring = lakeOuterRing(state.boundary);
        if (!Array.isArray(ring) || typeof global.PolygonGeometryEditor?.create !== 'function') return null;
        state.polygonEditor = global.PolygonGeometryEditor.create({
            map: global.map,
            pane: state.session.handlePane || EDITOR_PANE,
            leaflet: global.L,
            turf: global.turf,
            ring,
            getRing: () => lakeOuterRing(state.boundary) || ring,
            boundary: () => state.session?.placement?.locked ? state.initialSite : null,
            snapCoordinate: (coordinate, event) =>
                state.session?.placement?.snapCoordinate?.(coordinate, event) || coordinate,
            undo: false,
            showUndoButton: false,
            onDragStart: () => recordHistory(),
            vertexTitle: t('lakeVertexTitle', 'Drag to reshape the lake boundary'),
            deleteTitle: t('lakeDeleteVertexTitle', 'Delete this boundary point'),
            undoTitle: t('lakeUndoTitle', 'Undo lake boundary edit'),
            onCommit: ({ ring: nextRing, reason }) => commitLakeOuterRing(nextRing, reason)
        });
        return state.polygonEditor;
    }

    function setTool(tool) {
        const nextTool = state.tool === tool && state.kind === 'lake' && tool === 'move' ? null : tool;
        if (state.tool === 'path' && nextTool !== 'path') finishPath();
        if (state.kind === 'lake' && nextTool === 'move' && state.polygonEditor) {
            state.polygonEditor.destroy();
            state.polygonEditor = null;
        }
        state.tool = nextTool;
        if (state.kind === 'lake' && state.tool !== 'move') createLakePolygonEditor();
        render();
    }

    // A tool is a .btn toggle: the chosen one is aria-pressed (css/primitives.css).
    function toolButton(tool, icon, label) {
        return `<button type="button" class="btn btn-sm" data-tool="${tool}" aria-pressed="false"><i class="fa-solid ${icon}" aria-hidden="true"></i>${label}</button>`;
    }

    function panelMarkup() {
        if (state.kind === 'lake') {
            return `
                <p class="structure-geometry-options">${t('lakeBoundaryHint', 'The lake shape and its generated shore and water graphics will be saved together.')}</p>
                <div class="structure-geometry-tools">${toolButton('move', 'fa-arrows-up-down-left-right', t('tools.move', 'Move lake'))}</div>
                `;
        }
        const tools = state.kind === 'park'
            ? [
                toolButton('move', 'fa-arrows-up-down-left-right', t('tools.move', 'Move park')),
                toolButton('tree', 'fa-tree', t('tools.tree', 'Tree')),
                toolButton('flowerbed', 'fa-seedling', t('tools.flowerbed', 'Flowerbed')),
                toolButton('pond', 'fa-water', t('tools.pond', 'Pond')),
                toolButton('path', 'fa-shoe-prints', t('tools.path', 'Footpath')),
                toolButton('bench', 'fa-chair', t('tools.bench', 'Bench'))
            ].join('')
            : [
                toolButton('move', 'fa-arrows-up-down-left-right', t('tools.move', 'Move square')),
                toolButton('fountain', 'fa-droplet', t('tools.fountain', 'Fountain')),
                toolButton('tree', 'fa-tree', t('tools.tree', 'Tree')),
                toolButton('bench', 'fa-chair', t('tools.bench', 'Bench')),
                toolButton('stall', 'fa-utensils', t('tools.stall', 'Table')),
                toolButton('statue', 'fa-monument', t('tools.statue', 'Statue'))
            ].join('');
        return `
            <div class="structure-geometry-tools">${tools}${toolButton('erase', 'fa-eraser', t('tools.erase', 'Remove'))}</div>`;
    }

    function footerMarkup() {
        const error = state.kind === 'lake'
            ? '<p class="structure-geometry-error structure-geometry-footer-error" data-role="lake-error" role="status" aria-live="assertive" hidden></p>'
            : '';
        const undoLabel = t('undo', 'Undo');
        const undo = `<button type="button" class="btn btn-sm" data-action="undo" aria-label="${undoLabel}"><i class="fa-solid fa-rotate-left" aria-hidden="true"></i>${undoLabel}</button>`;
        const finish = state.kind === 'park'
            ? `<button type="button" class="btn btn-sm" data-action="finish-path" hidden>${t('finishPath', 'Finish path')}</button>`
            : '';
        return `${error}<div class="structure-geometry-footer-tools">${undo}${finish}</div>
            <div class="structure-geometry-footer-actions"><button type="button" class="btn" data-action="cancel">${t('cancel', 'Cancel')}</button><button type="button" class="btn btn-primary" data-action="save">${t('save', 'Save design')}</button></div>`;
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
        if (state.session?.setHint) {
            if (state.kind === 'lake') {
                state.session.setHint(state.tool === 'move'
                    ? t('hintMove', 'Drag inside the boundary to move the full design. The outline and all its contents move together.')
                    : t('hintLake', 'Use the map points to reshape the lake boundary. Undo is available on the map.'));
            } else if (!state.tool) {
                state.session.setHint(t('hintSelect', 'Select an item to begin.'));
            } else if (state.tool === 'move') {
                state.session.setHint(t('hintMove', 'Drag inside the boundary to move the full design. The outline and all its contents move together.'));
            } else {
                const toolLabels = {
                    tree: t('tools.tree', 'Tree'), flowerbed: t('tools.flowerbed', 'Flowerbed'),
                    pond: t('tools.pond', 'Pond'), path: t('tools.path', 'Footpath'),
                    bench: t('tools.bench', 'Bench'), fountain: t('tools.fountain', 'Fountain'),
                    stall: t('tools.stall', 'Table'), statue: t('tools.statue', 'Statue'),
                    erase: t('tools.erase', 'Remove')
                };
                const instruction = state.tool === 'erase'
                    ? t('hintErase', 'Click an item to remove it.')
                    : (state.tool === 'path'
                        ? t('hintPath', 'Click to add path points, then choose Finish path.')
                        : t('hintPlace', 'Click the map to place the selected item.'));
                state.session.setHint(`${toolLabels[state.tool] || ''}: ${instruction}`);
            }
        }
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
        if (!state.draftId || !state.tool || state.tool === 'erase' || state.tool === 'move') return;
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
        if (state.boundaryDrag) endBoundaryDrag();
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
        state.initialSite = null;
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
            const updated = global.syncActiveProposalDraftFromEditor?.('structure', { structureProposal: current }, {
                coalesceKey: 'editor:structure',
                placement: {
                    // The starting parcel is only a guide. A saved relocation must bind to the
                    // live edited footprint, so later edits cannot snap back to the old site.
                    site: clone(state.boundary.geometry),
                    free: true
                }
            });
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
        state.initialSite = clone(boundary);
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
            placement: {
                site: clone(state.initialSite),
                onLockChange: () => {
                    state.polygonEditor?.render?.({ refreshRing: true });
                    state.session?.placement?.update?.(state.boundary);
                }
            },
            modes: ['2d'],
            onCancel: () => closeEditor(false),
            onModeChange: mode => {
                if (mode === '2d' && state.session === session) session.fitFeature(boundary, { maxZoom: 20 });
            }
        });
        if (!session) {
            state.kind = null;
            state.boundary = null;
            state.initialSite = null;
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
        ensureHistory()?.bindButton(state.panel.querySelector('[data-action="undo"]'));
        state.session.placement?.update?.(state.boundary);
        global.map.on('click', onMapClick);
        global.map.on('mousemove', onMapMouseMove);
        global.document?.addEventListener('keydown', onKeyDown, true);
        render();
        if (kind === 'lake') {
            createLakePolygonEditor();
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
