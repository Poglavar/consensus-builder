// Edit area boundaries and their furniture through the shared map geometry controls.
(function attachStructureGeometryEditor(global) {
    'use strict';

    const state = {
        draftId: null,
        kind: null,
        boundary: null,
        decorations: null,
        tool: null,
        pathPoints: [],
        // Index of the tree whose card is open (Taller / Shorter / New look, and a square's pit), or null.
        selectedTree: null,
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
        initialSite: null,
        subeditor: null,
        initialSignature: null,
        // The structure's uploaded model fields (ProposalApplyStructures.structureModelFields), or null.
        model: null
    };

    // Everything the editor draws lives in its own pane ABOVE the structure panes (squares
    // surface z=630, icons 632; parks 625/627) — default marker/overlay panes sit BELOW them,
    // which buried the editor's icons under the square's semi-transparent surface.
    let EDITOR_PANE = 'onMapEditorPane';
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
        return String(fallback).replace(/\{\{(\w+)\}\}/g, (match, name) => (name in params ? params[name] : match));
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

    function parkPlanting() {
        const api = global.__parkPlanting || (typeof require === 'function' ? require('./park-planting.js') : null);
        if (!api) throw new Error('park-planting.js is not loaded');
        return api;
    }

    // Furniture kinds, models and lamp records (furniture-models.js), shared with the 3D view.
    function furnitureModels() {
        const api = global.FurnitureModels || (typeof require === 'function' ? require('./furniture-models.js') : null);
        if (!api) throw new Error('furniture-models.js is not loaded');
        return api;
    }

    // Records that carry metadata beside their point: a bench's, lamp's or stall's bearing (and a
    // stall's canopy colour), a tree's look.
    const POINT_RECORD_TYPES = ['benches', 'trees', 'lamps', 'stalls'];

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
            if (!POINT_RECORD_TYPES.includes(key) && Array.isArray(coordinates)) {
                moved[key] = moveCoordinates(coordinates, from, to);
            }
        }
        // Bench, lamp, stall and tree records carry metadata beside their point, so move the nested coordinate
        // explicitly and preserve each bearing and look without mutating the drag's starting snapshot.
        POINT_RECORD_TYPES.forEach(key => {
            if (!Array.isArray(value[key])) return;
            moved[key] = value[key].map(record => ({
                ...record,
                coordinate: moveCoordinates(record.coordinate, from, to)
            }));
        });
        return moved;
    }

    function normalizeDecorations(kind, input) {
        const value = clone(input || {});
        if (kind === 'park') {
            return {
                // A park stands on lawn: its trees have no pit in the paving.
                trees: (Array.isArray(value.trees) ? value.trees : []).map(entry => parkPlanting().withPit(entry, null)).filter(Boolean),
                flowerbeds: (Array.isArray(value.flowerbeds) ? value.flowerbeds : []).filter(Array.isArray),
                ponds: (Array.isArray(value.ponds) ? value.ponds : []).filter(Array.isArray),
                paths: (Array.isArray(value.paths) ? value.paths : []).map(path => (Array.isArray(path) ? path.map(coordinate).filter(Boolean) : [])).filter(path => path.length > 1),
                // Benches are first-class placeable objects (same as trees) — no orientation UI.
                benches: (Array.isArray(value.benches) ? value.benches : []).map(bench => {
                    const point = coordinate(bench?.coordinate || bench?.position || bench);
                    return point ? { coordinate: point, bearing: ((Number(bench?.bearing) || 0) % 360 + 360) % 360 } : null;
                }).filter(Boolean),
                stalls: furnitureModels().normalizeStalls(value.stalls, coordinate),
                lamps: furnitureModels().normalizeLamps(value.lamps, coordinate),
                ...withModels(kind, value.models),
                version: 3
            };
        }
        const fountains = Array.isArray(value.fountains)
            ? value.fountains
            : (coordinate(value.fountain) ? [value.fountain] : []);
        return {
            fountains: fountains.map(coordinate).filter(Boolean),
            trees: (Array.isArray(value.trees) ? value.trees : []).map(entry => parkPlanting().treeOf(entry)).filter(Boolean),
            benches: (Array.isArray(value.benches) ? value.benches : []).map(bench => {
                const point = coordinate(bench?.coordinate || bench?.position || bench);
                return point ? { coordinate: point, bearing: ((Number(bench?.bearing) || 0) % 360 + 360) % 360 } : null;
            }).filter(Boolean),
            stalls: furnitureModels().normalizeStalls(value.stalls, coordinate),
            statues: (Array.isArray(value.statues) ? value.statues : []).map(coordinate).filter(Boolean),
            lamps: furnitureModels().normalizeLamps(value.lamps, coordinate),
            ...withModels(kind, value.models),
            version: 2
        };
    }

    // decorationDesign.models is absent when no kind has a model.
    function withModels(kind, models) {
        const normalized = furnitureModels().normalizeModels(models, kind);
        return normalized ? { models: normalized } : {};
    }

    function boundaryFeature(raw) {
        const geometry = raw?.type === 'Feature' ? raw.geometry : (raw?.geometry || raw);
        if (!geometry || !['Polygon', 'MultiPolygon'].includes(geometry.type)) return null;
        return { type: 'Feature', properties: {}, geometry: clone(geometry) };
    }

    function boundaryOuterRing(boundary) {
        const geometry = boundary?.geometry;
        if (geometry?.type === 'Polygon') return geometry.coordinates?.[0] || null;
        if (geometry?.type === 'MultiPolygon' && geometry.coordinates?.length === 1) {
            return geometry.coordinates[0]?.[0] || null;
        }
        return null;
    }

    // The shared footprint validator checks simple rings and preserves contained holes.
    function reshapeBoundary(boundary, ring, geometryApi, turfApi) {
        if (!oneConnectedBoundaryGeometry(boundary?.geometry)) return null;
        const next = geometryApi.withFootprintRing(boundary, 0, 0, ring);
        return next && geometryApi.validFootprint(next, turfApi) ? next : null;
    }

    function oneConnectedBoundaryGeometry(geometry) {
        const value = geometry?.type === 'Feature' ? geometry.geometry : geometry;
        return value?.type === 'Polygon'
            || (value?.type === 'MultiPolygon' && Array.isArray(value.coordinates) && value.coordinates.length === 1);
    }

    function hasExplicitDecorationDesign(kind, decorations) {
        if (!decorations || typeof decorations !== 'object') return false;
        const decorationKeys = kind === 'park'
            ? ['trees', 'flowerbeds', 'ponds', 'paths', 'benches', 'stalls', 'lamps', 'models']
            : ['fountains', 'fountain', 'trees', 'benches', 'stalls', 'statues', 'lamps', 'models'];
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
        const definition = draft?.editorPayload?.structureProposal;
        const direct = definition?.decorationDesign || definition?.decorations;
        // An explicit schema (even with every list empty) is a deliberate saved design. Only fall
        // back to the rendered feature for legacy proposals that never stored decorations at all.
        if (hasExplicitDecorationDesign(state.kind, direct)) return direct;
        const proposalId = draft?.sourceLocalProposalId || draft?.sourceSnapshot?.proposalId || draft?.sourceSnapshot?.id;
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

    function makeTreeIcon(tree, selected = false) {
        return global.L.divIcon({
            className: `structure-geometry-icon is-tree${selected ? ' is-selected' : ''}`,
            ...parkPlanting().treeIcon(tree)
        });
    }

    function rejectOutside() {
        if (typeof global.updateStatus === 'function') global.updateStatus(t('statusOutside', 'Place items inside the structure boundary.'));
    }

    // Clicking a placed tree with a tree tool opens its card; clicking it again closes the card.
    function selectTree(index) {
        state.selectedTree = state.selectedTree === index ? null : index;
        render();
    }

    function selectedTree() {
        const trees = state.decorations?.trees;
        return Array.isArray(trees) && Number.isInteger(state.selectedTree) ? trees[state.selectedTree] || null : null;
    }

    // One change to the selected tree from its card: a new random look, a height step, or its pit.
    function changeSelectedTree(change) {
        const tree = selectedTree();
        if (!tree) return;
        const next = change(tree);
        if (!next || JSON.stringify(next) === JSON.stringify(tree)) return;
        recordHistory();
        state.decorations.trees[state.selectedTree] = next;
        render();
    }

    const TREE_TOOLS = ['tree', 'pavementTree'];

    function removeDecoration(type, index) {
        const list = state.decorations?.[type];
        if (!Array.isArray(list) || index < 0 || index >= list.length) return;
        recordHistory();
        list.splice(index, 1);
        if (type === 'trees') state.selectedTree = null;
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

    function boundaryEditing() {
        return !state.subeditor && (!state.tool || state.tool === 'boundary');
    }

    function startBoundaryDrag(event) {
        if (!boundaryEditing() || state.boundaryDrag || !event?.latlng || !state.boundary?.geometry) return;
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
        state.polygonEditor?.render?.({ refreshRing: true });
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
        if (boundaryEditing()) return layer;
        bindErasable(layer, type, index);
        layer.on('mousedown', event => startGeometryDrag(event, layer, type, index));
        layer.on('touchstart', event => startGeometryDrag(event, layer, type, index));
        return layer;
    }

    function addPointMarker(group, type, coord, index, icon) {
        const marker = global.L.marker([coord[1], coord[0]], {
            icon,
            interactive: !boundaryEditing(),
            draggable: !boundaryEditing(),
            keyboard: !boundaryEditing(),
            // Point handles must stay above interactive paths regardless of the map's pan offset.
            pane: state.session.handlePane
        }).addTo(group);
        if (boundaryEditing()) return marker;
        marker.on('dragstart', recordHistory);
        marker.on('dragend', () => {
            const next = marker.getLatLng();
            const nextCoord = [next.lng, next.lat];
            if (!pointInside(nextCoord)) {
                const previous = POINT_RECORD_TYPES.includes(type)
                    ? state.decorations[type][index].coordinate
                    : state.decorations[type][index];
                marker.setLatLng([previous[1], previous[0]]);
                rejectOutside();
                return;
            }
            if (POINT_RECORD_TYPES.includes(type)) state.decorations[type][index].coordinate = nextCoord;
            else state.decorations[type][index] = nextCoord;
        });
        marker.on('click', event => {
            global.L.DomEvent.stopPropagation(event);
            if (state.tool === 'erase') removeDecoration(type, index);
            else if (TREE_TOOLS.includes(state.tool) && type === 'trees') selectTree(index);
        });
    }

    function renderPark(group) {
        state.decorations.paths.forEach((path, index) => bindDraggableGeometry(global.L.polyline(path.map(([lng, lat]) => [lat, lng]), {
            color: '#f7edc8', weight: 5, opacity: 0.95, dashArray: '8 5', pane: EDITOR_PANE,
            interactive: !boundaryEditing(),
            className: 'structure-geometry-draggable'
        }).addTo(group), 'paths', index));
        state.decorations.ponds.forEach((ring, index) => bindDraggableGeometry(global.L.polygon(ring.map(([lng, lat]) => [lat, lng]), {
            color: '#1d4ed8', fillColor: '#38bdf8', fillOpacity: 0.75, weight: 2, pane: EDITOR_PANE,
            interactive: !boundaryEditing(),
            className: 'structure-geometry-draggable'
        }).addTo(group), 'ponds', index));
        state.decorations.flowerbeds.forEach((ring, index) => bindDraggableGeometry(global.L.polygon(ring.map(([lng, lat]) => [lat, lng]), {
            color: '#be185d', fillColor: '#f472b6', fillOpacity: 0.78, weight: 2, pane: EDITOR_PANE,
            interactive: !boundaryEditing(),
            className: 'structure-geometry-draggable'
        }).addTo(group), 'flowerbeds', index));
        state.decorations.trees.forEach((tree, index) => addPointMarker(group, 'trees', tree.coordinate, index, makeTreeIcon(tree, index === state.selectedTree)));
        (state.decorations.benches || []).forEach((bench, index) => addPointMarker(group, 'benches', bench.coordinate, index, makeIcon('is-bench', '▰')));
        renderStalls(group);
        renderLamps(group);
        if (state.pathPoints.length) {
            global.L.polyline(state.pathPoints.map(([lng, lat]) => [lat, lng]), {
                color: '#f59e0b', weight: 4, dashArray: '5 5', pane: EDITOR_PANE,
                interactive: !boundaryEditing()
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
        state.decorations.trees.forEach((tree, index) => addPointMarker(group, 'trees', tree.coordinate, index, makeTreeIcon(tree, index === state.selectedTree)));
        state.decorations.benches.forEach((bench, index) => {
            const icon = makeIcon('is-bench', `<span style="transform:rotate(${bench.bearing || 0}deg)">▰</span>`);
            addPointMarker(group, 'benches', bench.coordinate, index, icon);
        });
        renderStalls(group);
        (state.decorations.statues || []).forEach((coord, index) => addPointMarker(group, 'statues', coord, index, makeIcon('is-statue', '🗿')));
        renderLamps(group);
    }

    // A market stall's marker shows its canopy colour (--stall-color, css/structure-geometry-editor.css).
    function renderStalls(group) {
        (state.decorations.stalls || []).forEach((stall, index) => {
            const color = furnitureModels().stallColor(stall, index);
            addPointMarker(group, 'stalls', stall.coordinate, index,
                makeIcon('is-stall', `<i class="fa-solid fa-store" style="--stall-color:${color}" aria-hidden="true"></i>`));
        });
    }

    function renderLamps(group) {
        (state.decorations.lamps || []).forEach((lamp, index) => addPointMarker(group, 'lamps', lamp.coordinate, index,
            makeIcon('is-lamp', '<i class="fa-solid fa-lightbulb" aria-hidden="true"></i>')));
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
                pathPoints: clone(state.pathPoints),
                model: clone(state.model)
            }),
            restore: (snapshot) => {
                state.boundary = clone(snapshot.boundary);
                state.decorations = clone(snapshot.decorations);
                state.pathPoints = clone(snapshot.pathPoints);
                state.model = clone(snapshot.model);
                state.selectedTree = null;
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
            interactive: boundaryEditing(),
            pane: EDITOR_PANE,
            onEachFeature: (_feature, layer) => {
                if (!boundaryEditing()) return;
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

    function commitBoundaryOuterRing(ring, reason = 'move') {
        const candidate = reshapeBoundary(state.boundary, ring, global.SingleBuildingGeometry, global.turf);
        if (!candidate || (state.session?.placement?.accepts && !state.session.placement.accepts(candidate))) {
            if (reason === 'move') historyCtl?.discardLast?.();
            state.polygonEditor?.render?.({ refreshRing: true });
            return false;
        }
        const closed = boundaryOuterRing(candidate);
        const currentRing = boundaryOuterRing(state.boundary);
        const same = currentRing?.length === closed.length
            && currentRing.every((point, index) => point[0] === closed[index][0] && point[1] === closed[index][1]);
        if (same) {
            if (reason === 'move') historyCtl?.discardLast?.();
            return true;
        }
        if (reason !== 'move') recordHistory();
        state.boundary = candidate;
        if (state.decorations) state.decorations = global.ProposalApplyStructures.decorationsOnGround(
            state.decorations, candidate.geometry, global.turf);
        state.session?.placement?.update?.(state.boundary);
        render();
        state.polygonEditor?.render?.({ refreshRing: true });
        return true;
    }

    function lakeBoundaryFailure(graphics) {
        const geometry = graphics?.geometry || state.boundary?.geometry;
        const ring = boundaryOuterRing({ geometry });
        let simpleRing = false;
        try { simpleRing = !!global.SingleBuildingGeometry?.isSimpleRing?.(ring); } catch (_) { }
        if (!graphics || !oneConnectedBoundaryGeometry(geometry)
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

    // A new tree takes the look its position hashes to; a pavement tree starts under a grille. The new
    // tree's card opens, so its height or look can be changed at once.
    function plantTree(coord, pit) {
        recordHistory();
        state.decorations.trees.push(parkPlanting().withPit(coord, pit));
        state.selectedTree = state.decorations.trees.length - 1;
    }

    function placeAt(coord) {
        if (!pointInside(coord)) return rejectOutside();
        if (state.kind === 'park') {
            if (state.tool === 'tree') plantTree(coord, null);
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
            } else if (state.tool === 'stall') {
                recordHistory();
                state.decorations.stalls.push({ coordinate: coord, bearing: 0 });
            } else if (state.tool === 'lamp') {
                recordHistory();
                state.decorations.lamps.push({ coordinate: coord, bearing: 0 });
            }
        } else {
            if (state.tool === 'fountain') {
                recordHistory();
                state.decorations.fountains.push(coord);
            }
            else if (state.tool === 'tree') plantTree(coord, null);
            else if (state.tool === 'pavementTree') plantTree(coord, 'grille');
            else if (state.tool === 'bench') {
                recordHistory();
                state.decorations.benches.push({ coordinate: coord, bearing: 0 });
            }
            else if (state.tool === 'stall') {
                recordHistory();
                state.decorations.stalls.push({ coordinate: coord, bearing: 0 });
            }
            else if (state.tool === 'statue') {
                recordHistory();
                state.decorations.statues.push(coord);
            }
            else if (state.tool === 'lamp') {
                recordHistory();
                state.decorations.lamps.push({ coordinate: coord, bearing: 0 });
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

    function createBoundaryPolygonEditor() {
        if (state.subeditor || !state.session || state.polygonEditor) return state.polygonEditor;
        const ring = boundaryOuterRing(state.boundary);
        if (!Array.isArray(ring) || typeof global.PolygonGeometryEditor?.create !== 'function') return null;
        state.polygonEditor = global.PolygonGeometryEditor.create({
            map: global.map,
            pane: state.session.handlePane || EDITOR_PANE,
            leaflet: global.L,
            turf: global.turf,
            ring,
            getRing: () => boundaryOuterRing(state.boundary) || ring,
            boundary: () => state.session?.placement?.locked ? state.initialSite : null,
            snapCoordinate: (coordinate, event) =>
                state.session?.placement?.snapCoordinate?.(coordinate, event) || coordinate,
            undo: false,
            showUndoButton: false,
            onDragStart: () => recordHistory(),
            vertexTitle: t('boundaryVertexTitle', 'Drag to reshape the boundary'),
            deleteTitle: t('lakeDeleteVertexTitle', 'Delete this boundary point'),
            undoTitle: t('undo', 'Undo'),
            onCommit: ({ ring: nextRing, reason }) => commitBoundaryOuterRing(nextRing, reason)
        });
        return state.polygonEditor;
    }

    function setTool(tool) {
        const nextTool = state.tool === tool && tool === 'boundary' ? null : tool;
        if (state.tool === 'path' && nextTool !== 'path') finishPath();
        state.tool = nextTool;
        if (!TREE_TOOLS.includes(nextTool)) state.selectedTree = null;
        if (!state.subeditor && (!state.tool || state.tool === 'boundary')) createBoundaryPolygonEditor();
        else if (state.polygonEditor) {
            state.polygonEditor.destroy();
            state.polygonEditor = null;
        }
        render();
    }

    // A tool is a .btn toggle: the chosen one is aria-pressed (css/primitives.css).
    function toolButton(tool, icon, label) {
        return `<button type="button" class="btn btn-sm" data-tool="${tool}" aria-pressed="false"><i class="fa-solid ${icon}" aria-hidden="true"></i>${label}</button>`;
    }

    // Replace the boundary from a file: an uploaded model's outline (the model then renders in 3D)
    // or a GeoJSON polygon. Only the top-level editor owns a boundary.
    function importsMarkup() {
        if (state.subeditor) return '';
        return `
            <div class="structure-geometry-tools">
                <button type="button" class="btn btn-sm" data-action="upload-model"><i class="fa-solid fa-cube" aria-hidden="true"></i>${t('uploadModel', 'Upload model (.glb)')}</button>
                <label class="btn btn-sm" data-role="boundary-import"><i class="fa-solid fa-file-import" aria-hidden="true"></i>${t('importBoundary', 'Import boundary (GeoJSON)')}<input type="file" data-role="boundary-file" accept=".geojson,.json,application/geo+json,application/json" hidden></label>
            </div>`;
    }

    function panelMarkup() {
        if (state.kind === 'lake') {
            return `
                <p class="structure-geometry-options">${t('lakeBoundaryHint', 'The lake shape and its generated shore and water graphics will be saved together.')}</p>
                ${importsMarkup()}
                `;
        }
        const tools = state.kind === 'park'
            ? [
                toolButton('tree', 'fa-tree', t('tools.tree', 'Tree')),
                toolButton('flowerbed', 'fa-seedling', t('tools.flowerbed', 'Flowerbed')),
                toolButton('pond', 'fa-water', t('tools.pond', 'Pond')),
                toolButton('path', 'fa-shoe-prints', t('tools.path', 'Footpath')),
                toolButton('bench', 'fa-chair', t('tools.bench', 'Bench')),
                toolButton('stall', 'fa-store', t('tools.stall', 'Market stall')),
                toolButton('lamp', 'fa-lightbulb', t('tools.lamp', 'Lamp'))
            ].join('')
            : [
                toolButton('fountain', 'fa-droplet', t('tools.fountain', 'Fountain')),
                toolButton('tree', 'fa-tree', t('tools.tree', 'Tree')),
                toolButton('pavementTree', 'fa-table-cells', t('tools.pavementTree', 'Pavement tree')),
                toolButton('bench', 'fa-chair', t('tools.bench', 'Bench')),
                toolButton('stall', 'fa-store', t('tools.stall', 'Market stall')),
                toolButton('statue', 'fa-monument', t('tools.statue', 'Statue')),
                toolButton('lamp', 'fa-lightbulb', t('tools.lamp', 'Lamp'))
            ].join('');
        const boundaryTool = state.subeditor ? '' : toolButton('boundary', 'fa-draw-polygon', t('tools.boundary', 'Boundary'));
        return `
            <div class="structure-geometry-tools">${boundaryTool}${tools}${toolButton('erase', 'fa-eraser', t('tools.erase', 'Remove'))}</div>${treeCardMarkup()}${importsMarkup()}${furnitureModelsMarkup()}`;
    }

    // The selected tree's card: its kind and height, Shorter / Taller / New look, and on a square the
    // pit it stands in. updatePanelState shows it and fills it in.
    function treeCardMarkup() {
        const pits = state.kind === 'square' ? `
                <div class="structure-geometry-tree-pits" role="group" aria-label="${t('tree.base', 'Base')}">
                    <span class="structure-geometry-tree-label">${t('tree.base', 'Base')}</span>
                    ${['none', ...parkPlanting().TREE_PITS].map(pit => `<button type="button" class="btn btn-sm" data-tree-pit="${pit}" aria-pressed="false">${pitLabel(pit)}</button>`).join('')}
                </div>` : '';
        return `
            <section class="structure-geometry-tree-card" data-role="tree-card" aria-label="${t('tree.title', 'Selected tree')}" hidden>
                <p class="structure-geometry-tree-summary" data-role="tree-summary"></p>
                <div class="structure-geometry-tools">
                    <button type="button" class="btn btn-sm" data-action="tree-shorter"><i class="fa-solid fa-minus" aria-hidden="true"></i>${t('tree.shorter', 'Shorter')}</button>
                    <button type="button" class="btn btn-sm" data-action="tree-taller"><i class="fa-solid fa-plus" aria-hidden="true"></i>${t('tree.taller', 'Taller')}</button>
                    <button type="button" class="btn btn-sm" data-action="tree-reroll"><i class="fa-solid fa-shuffle" aria-hidden="true"></i>${t('tree.reroll', 'New look')}</button>
                </div>${pits}
            </section>`;
    }

    function pitLabel(pit) {
        return { none: t('tree.pitNone', 'Paving'), grille: t('tree.pitGrille', 'Grille'), grass: t('tree.pitGrass', 'Grass'), soil: t('tree.pitSoil', 'Soil') }[pit] || pit;
    }

    function treeKindLabel(kind) {
        return { broadleaf: t('tree.kindBroadleaf', 'Broadleaf'), conifer: t('tree.kindConifer', 'Conifer'),
            columnar: t('tree.kindColumnar', 'Columnar'), ornamental: t('tree.kindOrnamental', 'Ornamental') }[kind] || kind;
    }

    function updateTreeCard(panel) {
        const card = panel.querySelector?.('[data-role="tree-card"]');
        if (!card) return;
        const tree = selectedTree();
        card.hidden = !tree;
        if (!tree) return;
        const summary = card.querySelector('[data-role="tree-summary"]');
        if (summary) summary.textContent = t('tree.summary', '{{kind}}, {{height}} m', { kind: treeKindLabel(tree.kind), height: tree.heightM.toFixed(1) });
        const room = parkPlanting().heightRoom(tree);
        const taller = card.querySelector('[data-action="tree-taller"]');
        const shorter = card.querySelector('[data-action="tree-shorter"]');
        if (taller) taller.disabled = !room.taller;
        if (shorter) shorter.disabled = !room.shorter;
        card.querySelectorAll('[data-tree-pit]').forEach(button => {
            button.setAttribute('aria-pressed', button.dataset.treePit === (tree.pit || 'none') ? 'true' : 'false');
        });
    }

    function furnitureKindLabel(kind) {
        return {
            bench: t('tools.bench', 'Bench'), statue: t('tools.statue', 'Statue'), fountain: t('tools.fountain', 'Fountain'),
            stall: t('tools.stall', 'Market stall'), tree: t('tools.tree', 'Tree'), lamp: t('tools.lamp', 'Lamp')
        }[kind] || kind;
    }

    // One row per furniture kind: the model every item of that kind uses (or the default look),
    // an Upload control and Remove. updatePanelState fills in the names.
    function furnitureModelsMarkup() {
        const rows = furnitureModels().kindsFor(state.kind).map(kind => `
                <div class="structure-geometry-model-row" data-furniture-kind="${kind}">
                    <span class="structure-geometry-model-kind">${furnitureKindLabel(kind)}</span>
                    <span class="structure-geometry-model-name" data-role="furniture-model-name"></span>
                    <label class="btn btn-sm" data-role="furniture-model-upload"><i class="fa-solid fa-upload" aria-hidden="true"></i>${t('furniture.upload', 'Upload')}<input type="file" data-role="furniture-model-file" accept=".glb,.gltf,model/gltf-binary,model/gltf+json" hidden></label>
                    <button type="button" class="btn btn-sm" data-action="remove-furniture-model">${t('tools.erase', 'Remove')}</button>
                </div>`).join('');
        return rows ? `
            <section class="structure-geometry-models" aria-label="${t('furniture.title', 'Furniture models')}">
                <h3 class="structure-geometry-models-title">${t('furniture.title', 'Furniture models')}</h3>${rows}
            </section>` : '';
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
            <div class="structure-geometry-footer-actions"><button type="button" class="btn btn-primary" data-action="save">${t('done', 'Done')}</button></div>`;
    }

    function updatePanelState() {
        const panel = state.panel;
        if (!panel) return;
        panel.querySelectorAll('[data-tool]').forEach(button => {
            const active = button.dataset.tool === state.tool;
            button.setAttribute('aria-pressed', active ? 'true' : 'false');
        });
        panel.querySelectorAll?.('[data-furniture-kind]').forEach(row => {
            const model = state.decorations?.models?.[row.dataset.furnitureKind];
            const name = row.querySelector('[data-role="furniture-model-name"]');
            if (name) name.textContent = model ? (model.name || t('furniture.uploaded', 'Uploaded model')) : t('furniture.default', 'Default');
            const remove = row.querySelector('[data-action="remove-furniture-model"]');
            if (remove) remove.disabled = !model;
        });
        updateTreeCard(panel);
        const finish = panel.querySelector('[data-action="finish-path"]');
        if (finish) {
            finish.hidden = state.kind !== 'park' || state.tool !== 'path';
            finish.disabled = state.pathPoints.length < 2;
        }
        if (state.session?.setHint) {
            if (state.kind === 'lake') {
                state.session.setHint(t('hintBoundary', 'Drag the area to move it, or drag boundary points to reshape. Tap an edge to add a point; select a point to remove it.'));
            } else if (!state.subeditor && (!state.tool || state.tool === 'boundary')) {
                state.session.setHint(t('hintBoundary', 'Drag the area to move it, or drag boundary points to reshape. Tap an edge to add a point; select a point to remove it.'));
            } else if (!state.tool) {
                state.session.setHint(state.subeditor
                    ? t('hintSurroundings', 'Edit the surroundings, then return to the building with Done. Save the building to keep all changes.')
                    : t('hintSelect', 'Select an item to begin.'));
            } else {
                const toolLabels = {
                    tree: t('tools.tree', 'Tree'), pavementTree: t('tools.pavementTree', 'Pavement tree'), flowerbed: t('tools.flowerbed', 'Flowerbed'),
                    pond: t('tools.pond', 'Pond'), path: t('tools.path', 'Footpath'),
                    bench: t('tools.bench', 'Bench'), fountain: t('tools.fountain', 'Fountain'),
                    stall: t('tools.stall', 'Market stall'), statue: t('tools.statue', 'Statue'),
                    lamp: t('tools.lamp', 'Lamp'), erase: t('tools.erase', 'Remove')
                };
                const instruction = state.tool === 'erase'
                    ? t('hintErase', 'Click an item to remove it.')
                    : (state.tool === 'path'
                        ? t('hintPath', 'Click to add path points, then choose Finish path.')
                        : (state.tool === 'tree'
                            ? t('hintTree', 'Click the map to plant a tree. Click a planted tree to make it taller or shorter or give it a new look.')
                            : (state.tool === 'pavementTree'
                                ? t('hintPavementTree', 'Click the paving to plant a tree in a pit. Click a planted tree to change its height, look or base.')
                                : t('hintPlace', 'Click the map to place the selected item.'))));
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
        const actionButton = event.target?.closest?.('[data-action]');
        const action = actionButton?.dataset.action;
        if (action === 'finish-path') finishPath();
        else if (action === 'save') saveEditor();
        else if (action === 'upload-model' && !global.BusyControl?.isBusy?.(actionButton)) {
            global.BusyControl.track(actionButton, openModelUpload);
        }
        else if (action === 'remove-furniture-model') {
            removeFurnitureModel(actionButton.closest('[data-furniture-kind]')?.dataset.furnitureKind);
        }
        else if (action === 'tree-taller') changeSelectedTree(tree => parkPlanting().resizeTree(tree, 1));
        else if (action === 'tree-shorter') changeSelectedTree(tree => parkPlanting().resizeTree(tree, -1));
        else if (action === 'tree-reroll') changeSelectedTree(tree => parkPlanting().rerollTree(tree));
        else {
            const pit = event.target?.closest?.('[data-tree-pit]')?.dataset.treePit;
            if (pit) changeSelectedTree(tree => parkPlanting().withPit(tree, pit === 'none' ? null : pit));
        }
    }

    function handlePanelChange(event) {
        const modelInput = event.target?.closest?.('[data-role="furniture-model-file"]');
        if (modelInput) {
            const modelFile = modelInput.files?.[0];
            modelInput.value = '';
            const kind = modelInput.closest('[data-furniture-kind]')?.dataset.furnitureKind;
            const upload = modelInput.closest('[data-role="furniture-model-upload"]');
            if (modelFile && kind && !global.BusyControl?.isBusy?.(upload)) {
                global.BusyControl.track(upload, () => uploadFurnitureModel(kind, modelFile));
            }
            return;
        }
        const input = event.target?.closest?.('[data-role="boundary-file"]');
        const file = input?.files?.[0];
        if (!file) return;
        input.value = '';
        const label = input.closest('[data-role="boundary-import"]');
        global.BusyControl.track(label, () => importBoundaryFile(file));
    }

    function reportImport(message) {
        if (typeof global.showEphemeralMessage === 'function') global.showEphemeralMessage(message, 7000, 'error');
        if (typeof global.updateStatus === 'function') global.updateStatus(message);
    }

    // A new boundary from a file. Decorations keep what still lies on the new ground; undo
    // returns the previous boundary (and model).
    function replaceBoundary(geometry, model) {
        const candidate = boundaryFeature(geometry);
        const geometryApi = global.SingleBuildingGeometry;
        if (!candidate || !oneConnectedBoundaryGeometry(candidate.geometry)
            || !geometryApi?.validFootprint?.(candidate, global.turf)) {
            reportImport(t('importInvalidShape', 'The new boundary is not a valid single area.'));
            return false;
        }
        if (state.session?.placement?.accepts && !state.session.placement.accepts(candidate)) {
            reportImport(t('importOutsideSite', 'The new boundary does not fit the locked site. Unlock the site and try again.'));
            return false;
        }
        recordHistory();
        state.boundary = candidate;
        if (model !== undefined) state.model = clone(model);
        if (state.decorations) state.decorations = global.ProposalApplyStructures.decorationsOnGround(
            state.decorations, candidate.geometry, global.turf);
        state.pathPoints = [];
        state.pathCursor = null;
        state.session?.placement?.update?.(state.boundary);
        render();
        state.polygonEditor?.render?.({ refreshRing: true });
        if (!global.isThreeModeActive?.()) state.session?.fitFeature?.(state.boundary, { maxZoom: 20 });
        return true;
    }

    // The upload dialog's model replaces the boundary with its outline, placed at a point on the
    // current boundary; Done saves the model fields with the structure.
    async function openModelUpload() {
        const draftId = state.draftId;
        if (typeof global.BuildingUpload?.open !== 'function') {
            reportImport(t('uploadUnavailable', 'Model upload is unavailable.'));
            return;
        }
        await global.BuildingUpload.open({ kind: state.kind }, {
            onUse: upload => state.draftId === draftId && useUploadedModel(upload)
        });
    }

    function useUploadedModel(upload) {
        const api = global.ProposalApplyStructures;
        const geometry = api.structureModelGeometry(upload?.footprint, state.boundary, {
            turf: global.turf,
            placeModelFootprint: global.SingleBuildingGeometry?.placeModelFootprint
        });
        const model = api.structureModelFields({ ...upload, rotation: 0 });
        if (!geometry || !model) return false;
        return replaceBoundary(geometry, model);
    }

    async function importBoundaryFile(file) {
        let geometry;
        try {
            geometry = global.PolygonGeometryEditor.areaGeometryFromGeoJSON(JSON.parse(await file.text()), global.turf);
        } catch (error) {
            console.warn('[structure-geometry-editor] boundary import failed', error);
            reportImport(error?.code === 'disconnected'
                ? t('importDisconnected', 'The file holds separate areas. A boundary must be one connected area.')
                : t('importInvalid', 'This file is not a GeoJSON polygon in longitude/latitude.'));
            return false;
        }
        return replaceBoundary(geometry);
    }

    // The messages for FurnitureModels.validateModelSummary's codes, with the limit that was missed.
    function furnitureModelError(code, detail = {}) {
        const mb = value => (Number(value) / (1024 * 1024)).toFixed(1);
        if (code === 'triangles') return t('furniture.errorTriangles', `This model has ${detail.triangles} triangles. A furniture model may have at most ${detail.max}.`, { triangles: detail.triangles, max: detail.max });
        if (code === 'texture') return t('furniture.errorTexture', `A texture is ${detail.width} × ${detail.height} px. Furniture textures may be at most ${detail.max} px on each side.`, { width: detail.width, height: detail.height, max: detail.max });
        if (code === 'bytes') return t('furniture.errorBytes', `This file is ${mb(detail.bytes)} MB. A furniture model may be at most ${mb(detail.max)} MB.`, { size: mb(detail.bytes), max: mb(detail.max) });
        if (code === 'empty') return t('furniture.errorEmpty', 'The model contains no visible geometry.');
        if (code === 'parse') return t('furniture.errorParse', 'Could not read this file as glTF/GLB. Use a self-contained .glb or .gltf export.');
        if (code === 'upload') return t('furniture.errorUpload', 'The model could not be uploaded. Check the connection and try again.');
        return t('uploadUnavailable', 'Model upload is unavailable.');
    }

    // Parse, check against the furniture limits, upload, and use the model for every item of `kind`.
    async function uploadFurnitureModel(kind, file) {
        const draftId = state.draftId;
        const api = furnitureModels();
        if (!api.kindsFor(state.kind).includes(kind)) return false;
        let modelUpload;
        try {
            await global.ensureOptionalTool('modelUpload');
            modelUpload = global.ModelUpload;
        } catch (error) {
            console.warn('[structure-geometry-editor] model upload unavailable', error);
            reportImport(furnitureModelError('unavailable'));
            return false;
        }
        const sizeCheck = api.validateModelSummary({ triangles: 1, textures: [], bytes: file.size });
        if (!sizeCheck.ok) { reportImport(furnitureModelError(sizeCheck.code, sizeCheck.detail)); return false; }
        let summary;
        try {
            const scene = await modelUpload.parseModelFile(file);
            summary = modelUpload.modelSummary(scene, file.size);
            modelUpload.disposeScene(scene);
        } catch (error) {
            console.warn('[structure-geometry-editor] furniture model parse failed', error);
            reportImport(furnitureModelError(error?.code === 'engine' ? 'unavailable' : 'parse'));
            return false;
        }
        const check = api.validateModelSummary(summary);
        if (!check.ok) { reportImport(furnitureModelError(check.code, check.detail)); return false; }
        let url;
        try {
            url = await modelUpload.uploadModel(file);
        } catch (error) {
            console.warn('[structure-geometry-editor] furniture model upload failed', error);
            reportImport(furnitureModelError('upload'));
            return false;
        }
        if (state.draftId !== draftId || !state.decorations) return false;
        return setFurnitureModel(kind, { url, name: file.name });
    }

    function setFurnitureModel(kind, entry) {
        const models = { ...(state.decorations.models || {}) };
        if (entry) models[kind] = entry;
        else delete models[kind];
        const normalized = furnitureModels().normalizeModels(models, state.kind);
        if (JSON.stringify(normalized) === JSON.stringify(state.decorations.models || null)) return false;
        recordHistory();
        if (normalized) state.decorations.models = normalized;
        else delete state.decorations.models;
        render();
        return true;
    }

    function removeFurnitureModel(kind) {
        if (!kind || !state.decorations?.models?.[kind]) return false;
        return setFurnitureModel(kind, null);
    }

    function onMapClick(event) {
        if (!state.draftId || !state.tool || state.tool === 'erase' || boundaryEditing()) return;
        placeAt([event.latlng.lng, event.latlng.lat]);
    }

    function onKeyDown(event) {
        if (!state.draftId) return;
        if (event.key === 'Enter' && state.tool === 'path') {
            event.preventDefault();
            finishPath();
        }
    }

    function designSignature() {
        return JSON.stringify([state.boundary, state.decorations, state.pathPoints, state.model]);
    }

    async function requestCloseEditor() {
        if (state.initialSignature !== designSignature()) {
            const translate = (key, fallback) => {
                const value = global.i18n?.t?.(key);
                return value && value !== key ? value : fallback;
            };
            const proceed = await global.CbDialog.confirm(
                `${translate('proposalDrafts.discardDesign.title', 'Discard this design?')}\n${translate('proposalDrafts.discardDesign.body', 'Closing the editor throws away the changes you made here. Use Done to keep them.')}`,
                { destructive: true,
                    okText: translate('proposalDrafts.discardDesign.confirm', 'Discard'),
                    cancelText: translate('proposalDrafts.discardDesign.cancel', 'Keep editing') }
            );
            if (!proceed) return;
        }
        closeEditor(false);
    }

    function closeEditor(saved) {
        const subeditor = state.subeditor;
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
        state.panel?.removeEventListener?.('change', handlePanelChange);
        const session = state.session;
        state.session = null;
        state.panel = null;
        state.draftId = null;
        state.kind = null;
        state.boundary = null;
        state.initialSite = null;
        state.decorations = null;
        state.subeditor = null;
        state.initialSignature = null;
        state.model = null;
        if (historyCtl) { historyCtl.destroy(); historyCtl = null; }
        state.tool = null;
        state.selectedTree = null;
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
        if (subeditor) { subeditor.onClose?.(saved); return true; }
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
            try {
                global.selectAndHighlightProposal(reselectKey, null, false, true, false, {
                    presentation: 'details'
                });
            } catch (_) { }
        }
        return finished;
    }

    function saveEditor() {
        if (!state.draftId) return false;
        if (state.tool === 'path') finishPath();
        if (state.subeditor) {
            const complete = state.subeditor.onSave;
            const decorations = clone(state.decorations);
            closeEditor(true);
            complete(decorations);
            return true;
        }
        const draft = global.proposalDraftStore?.getDraft?.(state.draftId);
        if (!draft) {
            global.reportProposalDesignSaveFailure?.();
            return false;
        }
        const current = clone(draft.editorPayload?.structureProposal || {});
        current.kind = state.kind;
        current.geometry = clone(state.boundary.geometry);
        if (state.model) Object.assign(current, clone(state.model));
        if (state.kind === 'lake') {
            const graphics = global.buildLakeGraphicsFromGeometry?.(current.geometry);
            state.lakeError = lakeBoundaryFailure(graphics);
            updatePanelState();
            if (state.lakeError) return false;
            current.lakeGraphics = clone(graphics);
            delete current.decorations;
        } else {
            current.decorationDesign = clone(state.decorations);
            delete current.decorations;
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

    function openStructureGeometryEditor(draftOrId, options = {}) {
        if (!global.map || !global.L || !global.turf || !global.OnMapEditor?.open || state.draftId) return false;
        const draft = typeof draftOrId === 'string' ? global.proposalDraftStore?.getDraft?.(draftOrId) : draftOrId;
        const kind = draft?.adapterKey || draft?.goal;
        if (!draft || !['park', 'square', 'lake'].includes(kind)) return false;
        const rawGeometry = draft.editorPayload?.structureProposal?.geometry || draft.editorPayload?.geometry || draft.previewGeometry;
        const boundary = boundaryFeature(rawGeometry);
        if (!boundary) return false;
        const initialRing = boundaryOuterRing(boundary);
        if (!options.parentSession && (!oneConnectedBoundaryGeometry(boundary.geometry)
            || !Array.isArray(initialRing) || initialRing.length < 4
            || typeof global.PolygonGeometryEditor?.create !== 'function')) return false;
        state.kind = kind;
        state.subeditor = options.parentSession ? options : null;
        EDITOR_PANE = state.subeditor ? 'onMapSubeditorPane' : 'onMapEditorPane';
        state.boundary = boundary;
        state.initialSite = clone(boundary);
        state.decorations = kind === 'lake' ? null : normalizeDecorations(kind, sourceDecorations(draft));
        state.model = global.ProposalApplyStructures?.structureModelFields?.(draft.editorPayload?.structureProposal) || null;
        state.lakeError = null;
        state.tool = state.subeditor ? null : 'boundary';
        state.selectedTree = null;
        state.pathPoints = [];
        state.pathCursor = null;
        state.rubberBand = null;
        state.reselectKey = global.ProposalSelection?.getKey?.() || null;
        const title = kind === 'lake'
            ? t('titleLake', 'Lake boundary editor')
            : (kind === 'park' ? t('titlePark', 'Park editor') : t('titleSquare', 'Square editor'));
        let session = null;
        session = global.OnMapEditor.open({
            parentSession: options.parentSession || null,
            owner: EDIT_LOCK_OWNER,
            id: 'structure-geometry-editor',
            title,
            content: panelMarkup(),
            footer: footerMarkup(),
            placement: state.subeditor ? null : {
                site: clone(state.initialSite),
                onLockChange: () => {
                    state.polygonEditor?.render?.({ refreshRing: true });
                    state.session?.placement?.update?.(state.boundary);
                }
            },
            modes: ['2d'],
            onCancel: requestCloseEditor,
            onModeChange: mode => {
                if (mode === '2d' && state.session === session) session.fitFeature(boundary, { maxZoom: 20 });
            }
        });
        if (!session) {
            state.subeditor = null;
            state.kind = null;
            state.boundary = null;
            state.initialSite = null;
            state.decorations = null;
            state.model = null;
            state.reselectKey = null;
            return false;
        }
        state.session = session;
        state.initialSignature = designSignature();
        state.draftId = draft.id;
        state.panel = session.root;
        state.panel.addEventListener('click', handlePanelClick);
        state.panel.addEventListener('change', handlePanelChange);
        state.layer = global.L.layerGroup().addTo(global.map);
        // Hide the applied structure's own decoration rendering for the duration — the editor
        // shows the live editable copy, and static duplicates read as "objects I cannot drag".
        global.structureGeometryEditorEditingProposalId = draft?.sourceLocalProposalId
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
        if (!state.subeditor) createBoundaryPolygonEditor();
        if (!global.isThreeModeActive?.()) session.fitFeature(boundary, { maxZoom: 20 });
        return true;
    }

    global.openStructureGeometryEditor = openStructureGeometryEditor;
    global.closeStructureGeometryEditor = requestCloseEditor;
    // While the editor is open, the map belongs to it: parcel click/hover handlers consult this.
    global.isStructureGeometryEditorActive = () => !!state.draftId;

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = {
            normalizeDecorations,
            boundaryFeature,
            reshapeBoundary,
            hasExplicitDecorationDesign,
            translateCoordinateCollection
        };
    }
})(typeof window !== 'undefined' ? window : globalThis);
