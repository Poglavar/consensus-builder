(function () {
    'use strict';

    const params = new URLSearchParams(location.search);
    const backend = (params.get('backend') || 'http://localhost:3003').replace(/\/$/, '');
    const initialLat = Number(params.get('lat')) || 45.7989;
    const initialLng = Number(params.get('lng')) || 15.9614;
    const initialZoom = Number(params.get('zoom')) || 16;
    const initialSolutionId = Number(params.get('solution')) || null;
    const initialWidthAnalysisId = Number(params.get('width')) || null;

    proj4.defs('EPSG:3765', '+proj=tmerc +lat_0=0 +lon_0=16.5 +k=0.9999 +x_0=500000 +y_0=0 +ellps=GRS80 +units=m +no_defs');
    window.wgs84ToHTRS96 = function (lat, lng) {
        return proj4('EPSG:4326', 'EPSG:3765', [lng, lat]);
    };
    window.htrs96ToWGS84 = function (x, y) {
        const result = proj4('EPSG:3765', 'EPSG:4326', [x, y]);
        return [result[1], result[0]];
    };

    const map = L.map('map', {
        zoomControl: true,
        preferCanvas: true
    }).setView([initialLat, initialLng], initialZoom);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxNativeZoom: 19,
        maxZoom: 21,
        attribution: '&copy; OpenStreetMap contributors'
    }).addTo(map);

    const panes = {
        imagery: 210,
        painted: 430,
        observations: 465,
        widths: 467,
        topology: 470,
        problems: 490
    };
    Object.entries(panes).forEach(([name, zIndex]) => {
        const pane = map.createPane(`topology-${name}`);
        pane.style.zIndex = String(zIndex);
    });

    const layers = {
        imagery: L.layerGroup().addTo(map),
        osm: L.layerGroup().addTo(map),
        topology: L.layerGroup().addTo(map),
        observations: L.layerGroup().addTo(map),
        widths: L.layerGroup().addTo(map),
        painted: L.layerGroup().addTo(map),
        problems: L.layerGroup().addTo(map)
    };
    const state = {
        evidence: null,
        currentSolution: null,
        solutions: [],
        currentWidthAnalysis: null,
        widthAnalyses: [],
        toastTimer: null,
        // Lanes trimmed to their junction portals — built once per paint and shared by the junction
        // surface, the guide lines and the turn arrows so all three agree where a junction starts.
        displayGraph: null,
        topologyIndex: null,
        topologyVisuals: null,
        hoverFocus: null,
        pinnedFocus: null,
        hoveredOsmLayer: null,
        selectedOsmLayer: null,
        providerInfo: null,
        runDialog: { provider: null, bbox: null, plan: null },
        imagerySource: null,
        imageryTileLayer: null,
        requestedSolutionId: initialSolutionId,
        requestedWidthAnalysisId: initialWidthAnalysisId,
        // Every viewport-scoped fetch carries this token; a newer move bumps it and aborts the
        // controller, so a slow response can never overwrite the area the user is looking at now.
        autoLoad: {
            token: 0,
            controller: null,
            timer: null,
            loadedBbox: null
        }
    };

    // Debounce only, not a wait: Leaflet fires moveend once per gesture, this coalesces a flurry
    // of small pans into one request.
    const AUTO_LOAD_DEBOUNCE_MS = 350;
    // Mirrors MAX_RECOGNITION_GSD_M in backend/routes/lane-topology.js, which rejects coarser crops.
    const MAX_RECOGNITION_GSD_M = .35;

    const element = id => document.getElementById(id);

    function viewportBbox() {
        const bounds = map.getBounds();
        return [
            bounds.getWest(),
            bounds.getSouth(),
            bounds.getEast(),
            bounds.getNorth()
        ].map(value => Number(value.toFixed(7)));
    }

    function bboxString() {
        return viewportBbox().join(',');
    }

    // Version lists are matched against the area the drawn evidence actually covers, which is the
    // padded bbox once something is loaded, so they cannot disagree with what is on the map.
    function evidenceBboxString() {
        return (state.autoLoad.loadedBbox || viewportBbox()).join(',');
    }

    function updateBboxReadout() {
        element('bbox-readout').textContent = bboxString();
    }

    function planCurrentViewport(force) {
        return LaneTopologyViewport.planViewportLoad({
            viewport: viewportBbox(),
            loaded: state.autoLoad.loadedBbox,
            force: !!force
        });
    }

    function snapshotLabel() {
        if (!state.evidence) return 'not loaded';
        const date = state.evidence.snapshotAt ? state.evidence.snapshotAt.slice(0, 10) : 'snapshot unknown';
        // Nothing clicks to load any more, so the server-side feature cap has to announce itself.
        return state.evidence.truncated
            ? `${date} · capped at ${state.evidence.limit} ways`
            : date;
    }

    function setSnapshotStatus(text, kind) {
        const pill = element('snapshot-pill');
        pill.textContent = text;
        pill.title = text;
        pill.classList.toggle('is-busy', kind === 'busy');
        pill.classList.toggle('is-error', kind === 'error');
    }

    function showSnapshotLabel() {
        setSnapshotStatus(snapshotLabel(), state.evidence?.truncated ? 'error' : null);
    }

    function isStale(token) {
        return typeof token === 'number' && token !== state.autoLoad.token;
    }

    function isAbort(error) {
        return error?.name === 'AbortError';
    }

    function showToast(message, error) {
        const toast = element('toast');
        toast.textContent = message;
        toast.classList.toggle('is-error', !!error);
        toast.classList.add('is-visible');
        clearTimeout(state.toastTimer);
        state.toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 4500);
    }

    function setBusy(button, busy, label) {
        if (!button) return;
        if (!button.dataset.originalLabel) button.dataset.originalLabel = button.textContent;
        button.disabled = !!busy;
        button.textContent = busy ? label : button.dataset.originalLabel;
    }

    function setJobStatus(message, isError) {
        const status = element('job-status');
        status.textContent = message;
        status.classList.toggle('is-error', !!isError);
    }

    async function api(path, options) {
        const response = await fetch(`${backend}${path}`, {
            headers: { 'Content-Type': 'application/json' },
            ...options
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
        return body;
    }

    async function updateImageryStatus() {
        const status = element('imagery-status');
        if (!state.imagerySource) {
            status.textContent = 'Orthophoto source unavailable.';
            status.classList.add('is-error');
            return;
        }
        if (planCurrentViewport().reason === 'too-large') {
            status.textContent = `Zoom in — the viewport is wider than the ${LaneTopologyViewport.MAX_SPAN_DEG}° evidence limit.`;
            status.classList.add('is-error');
            return;
        }
        try {
            const body = await api(
                `/lane-topology/imagery/crop-spec?source=${encodeURIComponent(state.imagerySource.key)}`
                + `&bbox=${encodeURIComponent(bboxString())}`
            );
            const crop = body.crop;
            const tooCoarse = crop.effectiveGsdM > MAX_RECOGNITION_GSD_M;
            status.textContent = tooCoarse
                ? `Zoom in for recognition · current crop ${crop.effectiveGsdM.toFixed(2)} m/px`
                : `${state.imagerySource.label} · ${crop.width}×${crop.height}px`
                    + ` · ${crop.effectiveGsdM.toFixed(2)} m/px`;
            status.classList.toggle('is-error', tooCoarse);
        } catch (error) {
            status.textContent = `Imagery crop unavailable: ${error.message}`;
            status.classList.add('is-error');
        }
    }

    async function loadImagerySources() {
        try {
            const body = await api('/lane-topology/imagery/sources');
            state.imagerySource = (body.sources || []).find(source => source.role === 'primary')
                || body.sources?.[0]
                || null;
            layers.imagery.clearLayers();
            if (!state.imagerySource) throw new Error('No orthophoto source is configured.');
            state.imageryTileLayer = L.tileLayer.wms(state.imagerySource.wmsUrl, {
                pane: 'topology-imagery',
                layers: state.imagerySource.wmsLayer,
                version: '1.1.1',
                format: 'image/jpeg',
                transparent: false,
                maxZoom: 22,
                attribution: state.imagerySource.attribution,
                opacity: .9
            }).addTo(layers.imagery);
            await updateImageryStatus();
            applyLayerVisibility();
        } catch (error) {
            element('imagery-status').textContent = error.message;
            element('imagery-status').classList.add('is-error');
            // No source means no crop to attach; the run dialog reports it as a blocker if asked.
            element('run-dialog-imagery').checked = false;
            element('run-dialog-imagery').disabled = true;
            element('toggle-imagery').checked = false;
            element('toggle-imagery').disabled = true;
            applyLayerVisibility();
        }
    }

    function inspect(title, value) {
        const heading = element('inspector-title');
        heading.textContent = title;
        // The collapsed inspector shows only this line, so it has to carry the full name.
        heading.title = title;
        element('inspector-content').textContent = JSON.stringify(value, null, 2);
    }

    function setInspectorCollapsed(collapsed) {
        element('inspector').classList.toggle('is-collapsed', collapsed);
        element('inspector-toggle').setAttribute('aria-expanded', String(!collapsed));
    }

    function roadColor(feature) {
        if (feature.properties?.railway_type) return '#a78bfa';
        const lanes = Number(feature.properties?.tags?.lanes) || 0;
        if (lanes >= 5) return '#f6b94c';
        if (lanes >= 3) return '#7dd3fc';
        return '#a8bbc0';
    }

    function osmWayLabel(feature) {
        const properties = feature?.properties || {};
        return `${properties.name || '(unnamed)'} · way ${properties.osm_id || '—'}`;
    }

    function osmWayStyle(feature) {
        const rail = !!feature?.properties?.railway_type;
        return {
            color: roadColor(feature),
            weight: rail ? 2 : 3,
            opacity: .86,
            dashArray: rail ? '7 6' : null,
            lineCap: 'round'
        };
    }

    function styleOsmWay(layer) {
        if (!layer || typeof layer.setStyle !== 'function') return;
        const base = osmWayStyle(layer.feature);
        if (state.selectedOsmLayer === layer) {
            layer.setStyle({ ...base, color: '#ffffff', weight: base.weight + 3, opacity: 1 });
            return;
        }
        if (state.hoveredOsmLayer === layer) {
            layer.setStyle({ ...base, weight: base.weight + 2, opacity: 1 });
            return;
        }
        layer.setStyle(base);
    }

    function selectOsmWay(layer) {
        const previous = state.selectedOsmLayer;
        state.selectedOsmLayer = layer;
        if (previous && previous !== layer) styleOsmWay(previous);
        styleOsmWay(layer);
        inspect(`OSM way ${layer.feature?.properties?.osm_id || '—'}`, layer.feature?.properties);
    }

    function clearOsmSelection() {
        const previous = state.selectedOsmLayer;
        if (!previous) return;
        state.selectedOsmLayer = null;
        styleOsmWay(previous);
    }

    // Ways are drawn into the topology pane so a single canvas hit-tests ways and lanes together:
    // Leaflet picks the last-drawn match, and keepTopologyAboveOsm() keeps the ways drawn first. A
    // lane therefore wins wherever it covers a way, and the way answers everywhere else. Separate
    // panes cannot do this — a canvas only hit-tests its own layers and never falls through.
    function renderOsm() {
        layers.osm.clearLayers();
        state.hoveredOsmLayer = null;
        state.selectedOsmLayer = null;
        if (!state.evidence?.features) return;
        L.geoJSON(state.evidence, {
            pane: 'topology-topology',
            style: osmWayStyle,
            onEachFeature(feature, layer) {
                layer.on('mouseover', () => {
                    state.hoveredOsmLayer = layer;
                    styleOsmWay(layer);
                    setFocusStatus(osmWayLabel(feature), true);
                });
                layer.on('mouseout', () => {
                    if (state.hoveredOsmLayer !== layer) return;
                    state.hoveredOsmLayer = null;
                    styleOsmWay(layer);
                    refreshFocusStatus();
                });
                layer.on('click', event => {
                    if (event.originalEvent) L.DomEvent.stopPropagation(event.originalEvent);
                    selectOsmWay(layer);
                });
                layer.bindTooltip(osmWayLabel(feature), { sticky: true });
            }
        }).addTo(layers.osm);
        keepTopologyAboveOsm();
    }

    // Draw order decides both stacking and hit-test precedence inside a shared canvas, and a layer
    // only joins that order once its group is on the map — so this has to run after every render
    // and every visibility change, not just once.
    function keepTopologyAboveOsm() {
        layers.osm.eachLayer(layer => {
            if (typeof layer.bringToBack === 'function') layer.bringToBack();
        });
    }

    function laneColor(lane) {
        if (lane.type === 'bus' || lane.access === 'psv') return '#f6b94c';
        if (lane.embeddedRail) return '#a78bfa';
        if (lane.direction === 'backward') return '#f973d2';
        if (lane.direction === 'both') return '#fde047';
        return '#43d9ff';
    }

    function connectionColor(connection) {
        if (connection.type === 'turn') return '#f6b94c';
        if (connection.type === 'merge') return '#ff8d72';
        if (connection.type === 'split') return '#7ee2c4';
        return '#f8fafc';
    }

    function laneDirectionLabel(lane) {
        if (lane.direction === 'backward') return 'against OSM way direction';
        if (lane.direction === 'both') return 'both directions';
        return 'with OSM way direction';
    }

    function lineCoordinates(geometry) {
        return (geometry?.coordinates || []).map(([lng, lat]) => [lat, lng]);
    }

    function setLineInteractive(line, interactive) {
        line.options.interactive = interactive;
        const renderer = line._renderer;
        if (renderer && renderer._layers && renderer._layers[line._leaflet_id]) {
            renderer._layers[line._leaflet_id].options.interactive = interactive;
        }
    }

    function arrowMarker(coordinates, color, className, fraction) {
        const position = window.LaneTopologyView.pointAlong(coordinates, fraction);
        if (!position) return null;
        const before = map.latLngToLayerPoint([position.before[1], position.before[0]]);
        const after = map.latLngToLayerPoint([position.after[1], position.after[0]]);
        const angle = Math.atan2(after.y - before.y, after.x - before.x) * 180 / Math.PI;
        return L.marker([position.point[1], position.point[0]], {
            pane: 'topology-topology',
            interactive: false,
            keyboard: false,
            icon: L.divIcon({
                className: `topology-arrow-icon ${className}`,
                html: `<span style="--topology-arrow-angle:${angle}deg;--topology-arrow-color:${color}">➤</span>`,
                iconSize: [18, 18],
                iconAnchor: [9, 9]
            })
        });
    }

    function screenLength(coordinates) {
        let length = 0;
        for (let index = 1; index < coordinates.length; index += 1) {
            const before = map.latLngToLayerPoint([coordinates[index - 1][1], coordinates[index - 1][0]]);
            const after = map.latLngToLayerPoint([coordinates[index][1], coordinates[index][0]]);
            length += before.distanceTo(after);
        }
        return length;
    }

    function renderLaneArrows() {
        const visuals = state.topologyVisuals;
        if (!visuals?.laneArrowGroup) return;
        visuals.laneArrowGroup.clearLayers();
        visuals.lanes.forEach((visual, laneId) => {
            const coordinates = visual.lane.geometry?.coordinates || [];
            visual.arrow = null;
            if (coordinates.length < 2 || screenLength(coordinates) < 42) return;
            const marker = arrowMarker(coordinates, laneColor(visual.lane), 'topology-arrow-icon--lane', .57);
            if (!marker) return;
            marker.addTo(visuals.laneArrowGroup);
            visual.arrow = marker;
            visual.arrow.setOpacity(
                state.pinnedFocus && !state.pinnedFocus.laneIds.has(laneId) ? 0 : .9
            );
        });
    }

    function setFocusStatus(text, preview) {
        const status = element('focus-status');
        status.textContent = text;
        status.classList.toggle('is-preview', !!preview);
    }

    function refreshFocusStatus() {
        setFocusStatus(
            focusLabel(state.pinnedFocus || state.hoverFocus),
            !!state.hoverFocus && !state.pinnedFocus
        );
    }

    function focusLabel(focus) {
        if (!focus && !state.currentSolution) {
            return 'No lane topology solved here yet — build a deterministic base for this viewport.';
        }
        if (!focus) return 'Hover a lane or an OSM way to trace it. Click to pin; Esc clears.';
        if (focus.kind === 'node') {
            return `Junction ${focus.id} · ${focus.connectionIds.size} permitted movement${focus.connectionIds.size === 1 ? '' : 's'}`;
        }
        if (focus.kind === 'connection') {
            return `Movement ${focus.id} · ${focus.laneIds.size} linked lanes`;
        }
        return `Lane ${focus.id} · ${focus.connectionIds.size} immediate connection${focus.connectionIds.size === 1 ? '' : 's'}`;
    }

    function renderConnectionArrows(focus) {
        const visuals = state.topologyVisuals;
        if (!visuals?.connectionArrowGroup) return;
        visuals.connectionArrowGroup.clearLayers();
        if (!focus) return;
        focus.connectionIds.forEach(connectionId => {
            const visual = visuals.connections.get(connectionId);
            if (!visual || screenLength(visual.curve) < 24) return;
            const marker = arrowMarker(
                visual.curve,
                connectionColor(visual.connection),
                'topology-arrow-icon--connection',
                .62
            );
            if (marker) marker.addTo(visuals.connectionArrowGroup);
        });
    }

    function applyTopologyFocus() {
        const visuals = state.topologyVisuals;
        if (!visuals) return;
        const focus = state.pinnedFocus || state.hoverFocus;
        const pinned = !!state.pinnedFocus;

        visuals.lanes.forEach((visual, laneId) => {
            const included = !focus || focus.laneIds.has(laneId);
            const baseWeight = visual.lane.type === 'bus' ? 4 : 3;
            visual.line.setStyle({
                opacity: !focus ? .92 : (included ? 1 : (pinned ? .018 : .09)),
                weight: included && focus ? baseWeight + 2 : baseWeight
            });
            visual.portals.forEach(portal => portal.setStyle({
                opacity: !focus ? .72 : (included ? 1 : (pinned ? .018 : .09)),
                fillOpacity: !focus ? .9 : (included ? 1 : (pinned ? .018 : .09))
            }));
            setLineInteractive(visual.line, !pinned || included);
            if (visual.arrow) visual.arrow.setOpacity(!focus ? .9 : (included ? 1 : (pinned ? 0 : .07)));
        });
        visuals.connections.forEach((visual, connectionId) => {
            const included = !focus || focus.connectionIds.has(connectionId);
            visual.line.setStyle({
                opacity: !focus ? .24 : (included ? .98 : (pinned ? .012 : .045)),
                weight: included && focus ? 3.2 : 1.7
            });
            setLineInteractive(visual.line, !pinned || included);
        });
        visuals.nodes.forEach((visual, nodeId) => {
            const included = !focus || focus.nodeIds.has(nodeId);
            visual.marker.setStyle({
                opacity: !focus ? .86 : (included ? 1 : (pinned ? .025 : .12)),
                fillOpacity: !focus ? 1 : (included ? 1 : (pinned ? .025 : .12))
            });
            visual.marker.setRadius(included && focus ? visual.baseRadius + 2 : visual.baseRadius);
            setLineInteractive(visual.marker, !pinned || included);
        });
        renderConnectionArrows(focus);

        if (!state.hoveredOsmLayer) refreshFocusStatus();
        const clearButton = element('clear-topology-focus');
        clearButton.disabled = !state.pinnedFocus;
        clearButton.textContent = state.pinnedFocus ? 'Show whole graph' : 'Nothing pinned';
    }

    function hoverTopology(kind, id) {
        if (state.pinnedFocus || !state.topologyIndex) return;
        state.hoverFocus = window.LaneTopologyView.focusFor(state.topologyIndex, kind, id);
        applyTopologyFocus();
    }

    function clearTopologyHover() {
        if (state.pinnedFocus || !state.hoverFocus) return;
        state.hoverFocus = null;
        applyTopologyFocus();
    }

    function pinTopology(kind, id) {
        if (!state.topologyIndex) return;
        clearOsmSelection();
        state.pinnedFocus = window.LaneTopologyView.focusFor(state.topologyIndex, kind, id);
        state.hoverFocus = null;
        applyTopologyFocus();
    }

    function clearTopologyFocus() {
        state.pinnedFocus = null;
        state.hoverFocus = null;
        clearOsmSelection();
        applyTopologyFocus();
        refreshFocusStatus();
    }

    function bindTopologyInteraction(layer, kind, id, title, value) {
        layer.on('mouseover', () => hoverTopology(kind, id));
        layer.on('mouseout', clearTopologyHover);
        layer.on('click', event => {
            if (event.originalEvent) L.DomEvent.stopPropagation(event.originalEvent);
            inspect(title, value);
            pinTopology(kind, id);
        });
    }

    function renderTopology(graph) {
        layers.topology.clearLayers();
        state.hoverFocus = null;
        state.pinnedFocus = null;
        const displayGraph = graph ? window.LaneTopologyView.buildDisplayGraph(graph) : null;
        state.topologyIndex = displayGraph
            ? window.LaneTopologyView.createIndex(displayGraph)
            : null;
        state.topologyVisuals = null;
        if (!graph) {
            if (!state.hoveredOsmLayer) refreshFocusStatus();
            element('clear-topology-focus').disabled = true;
            return;
        }
        const visuals = {
            lanes: new Map(),
            connections: new Map(),
            nodes: new Map(),
            laneArrowGroup: L.layerGroup(),
            connectionArrowGroup: L.layerGroup()
        };
        state.topologyVisuals = visuals;

        (displayGraph.connections || []).forEach(connection => {
            const curve = window.LaneTopologyView.connectionCurve(
                connection,
                state.topologyIndex
            );
            const line = L.polyline(lineCoordinates({ coordinates: curve }), {
                pane: 'topology-topology',
                color: connectionColor(connection),
                weight: 1.7,
                opacity: .24,
                dashArray: connection.type === 'continue' ? '3 5' : '8 5',
                lineCap: 'round',
                lineJoin: 'round',
                bubblingMouseEvents: false
            }).addTo(layers.topology);
            line.bindTooltip(
                `${connection.type} · ${connection.priority || 'priority unknown'} · click to isolate`,
                { sticky: true, className: 'topology-tooltip' }
            );
            bindTopologyInteraction(
                line,
                'connection',
                connection.id,
                `Connection · ${connection.type}`,
                connection
            );
            visuals.connections.set(connection.id, { connection, line, curve });
        });
        (displayGraph.lanes || []).forEach(lane => {
            const line = L.polyline(lineCoordinates(lane.geometry), {
                pane: 'topology-topology',
                color: laneColor(lane),
                weight: lane.type === 'bus' ? 4 : 3,
                opacity: .92,
                lineCap: 'round',
                lineJoin: 'round',
                bubblingMouseEvents: false
            }).addTo(layers.topology);
            line.bindTooltip(
                `${lane.type} lane · ${laneDirectionLabel(lane)} · click to trace`,
                { sticky: true, className: 'topology-tooltip' }
            );
            bindTopologyInteraction(line, 'lane', lane.id, `Lane ${lane.id}`, lane);
            const portals = [];
            const coordinates = lane.geometry?.coordinates || [];
            const portalEndpoints = [
                lane.displayPortal?.startSetbackM ? coordinates[0] : null,
                lane.displayPortal?.endSetbackM ? coordinates[coordinates.length - 1] : null
            ].filter(Boolean);
            portalEndpoints.forEach(([lng, lat]) => {
                const portal = L.circleMarker([lat, lng], {
                    pane: 'topology-topology',
                    radius: 2.7,
                    color: laneColor(lane),
                    fillColor: '#11191b',
                    fillOpacity: .9,
                    opacity: .72,
                    weight: 1.4,
                    interactive: false
                }).addTo(layers.topology);
                portals.push(portal);
            });
            visuals.lanes.set(lane.id, { lane, line, arrow: null, portals });
        });
        (displayGraph.nodes || []).filter(node => node.degree > 1).forEach(node => {
            const baseRadius = node.degree > 2 ? 6 : 4;
            const marker = L.circleMarker([node.point[1], node.point[0]], {
                pane: 'topology-topology',
                radius: baseRadius,
                color: node.degree > 2 ? '#ff645f' : '#d8e3e5',
                fillColor: '#11191b',
                fillOpacity: 1,
                weight: 1.5,
                bubblingMouseEvents: false
            }).addTo(layers.topology);
            const movementCount = state.topologyIndex.connectionsByNode.get(node.id)?.length || 0;
            marker.bindTooltip(
                `${node.degree > 2 ? 'Junction' : 'Way boundary'} · ${movementCount} permitted movement${movementCount === 1 ? '' : 's'} · click to isolate`,
                { direction: 'top', className: 'topology-tooltip' }
            );
            bindTopologyInteraction(
                marker,
                'node',
                node.id,
                `Graph node · degree ${node.degree}`,
                { ...node, permittedMovements: movementCount }
            );
            visuals.nodes.set(node.id, { node, marker, baseRadius });
        });
        visuals.laneArrowGroup.addTo(layers.topology);
        visuals.connectionArrowGroup.addTo(layers.topology);
        renderLaneArrows();
        applyTopologyFocus();
    }

    function surfaceColor(type) {
        const configured = window.CORRIDOR_LANE_TYPES?.[type]?.surface;
        if (configured) return configured;
        const fallback = {
            driving: '#2b2b2b',
            bus: '#3a2c27',
            sidewalk: '#aaa59a',
            median: '#73766f',
            verge: '#517052',
            parking: '#2b2b2b',
            parking_angled: '#2b2b2b',
            parking_perpendicular: '#2b2b2b'
        };
        return fallback[type] || '#40494b';
    }

    // Closes the hole the portal setbacks leave, and carries solved movements across it. Drawn first
    // so section strips and markings sit on top of the junction surface rather than under it.
    function renderJunctionPaint(graph) {
        const display = window.LaneTopologyView.buildDisplayGraph(graph);
        state.displayGraph = display;
        const paint = window.LaneTopologyJunctionPaint.buildJunctionPaint(display);
        paint.surfaces.forEach(surface => {
            L.polygon(surface.ring.map(([lng, lat]) => [lat, lng]), {
                pane: 'topology-painted',
                stroke: false,
                fillColor: surfaceColor('driving'),
                fillOpacity: .96,
                interactive: false
            }).addTo(layers.painted);
        });
        return paint.guideLines;
    }

    // ONE broken white line for the whole map. A road has a single kind of dashed marking, so a lane
    // divider, a centre line and a junction guide line all get this exact stroke — anything that
    // varied weight or dash length would be inventing a distinction the paint does not make.
    const MARKING_STROKE = Object.freeze({
        color: '#f4f4f4',
        weight: 1.6,
        opacity: .86,
        dashArray: '10 8',
        interactive: false
    });

    // Turn arrows are solid paint, not a broken line — same colour and weight, no dash.
    function renderTurnArrows(graph) {
        window.LaneTurnArrows.buildTurnArrows(graph).forEach(arrow => {
            arrow.shapes.forEach(stroke => {
                L.polyline(stroke.map(([lng, lat]) => [lat, lng]), {
                    ...MARKING_STROKE,
                    dashArray: null,
                    pane: 'topology-painted'
                }).addTo(layers.painted);
            });
        });
    }

    // Guide lines go on last: they are paint on top of the junction surface, and a through line has
    // to read as the continuation of the divider it extends.
    function renderJunctionGuideLines(guideLines) {
        (guideLines || []).forEach(line => {
            L.polyline(line.coordinates.map(([lng, lat]) => [lat, lng]), {
                ...MARKING_STROKE,
                pane: 'topology-painted'
            }).addTo(layers.painted);
        });
    }

    function renderPainted(graph) {
        layers.painted.clearLayers();
        if (!graph) return;
        const guideLines = renderJunctionPaint(graph);
        const entries = [];
        // Clipped to the junction portals, so painted strips and markings stop where the lanes do
        // instead of running to the node at the centre of the crossing road.
        window.LaneTopologyView.paintableSections(graph).forEach(({ section, coordinates }) => {
            if (!section.profile?.strips?.length || coordinates.length < 2) return;
            const centerline = coordinates.map(([lng, lat]) => ({ lat, lng }));
            entries.push({
                corridorId: section.sourceWayId,
                sectionId: section.id,
                points: centerline,
                profile: section.profile
            });
            const strips = window.buildCorridorStrips(centerline, section.profile);
            strips.forEach(strip => {
                strip.polygons.forEach(polygon => {
                    L.polygon(polygon, {
                        pane: 'topology-painted',
                        stroke: false,
                        fillColor: surfaceColor(strip.type),
                        fillOpacity: .96,
                        interactive: false
                    }).addTo(layers.painted);
                });
            });
        });
        if (typeof window.buildCorridorLaneMarkingsForEntries === 'function') {
            try {
                // The solved graph says which lane continues into which, so the markings taper along
                // the topology instead of along a nearest-endpoint guess — that is what carries a
                // divider smoothly through a bend and lets a dropped lane fade into its neighbour.
                const links = window.LaneTopologyMarkingLinks.buildMarkingLinks(graph);
                window.buildCorridorLaneMarkingsForEntries(entries, { links }).forEach(markings => {
                    markings.forEach(marking => {
                        marking.lines.forEach(line => {
                            L.polyline(line, { ...MARKING_STROKE, pane: 'topology-painted' })
                                .addTo(layers.painted);
                        });
                    });
                });
            } catch (error) {
                console.warn('[topology] lane markings unavailable', error);
            }
        }
        renderTurnArrows(state.displayGraph);
        renderJunctionGuideLines(guideLines);
        (graph.lanes || []).filter(lane => lane.embeddedRail).forEach(lane => {
            L.geoJSON(lane.geometry, {
                pane: 'topology-painted',
                style: { color: '#16191a', weight: 4, opacity: .92, interactive: false }
            }).addTo(layers.painted);
            L.geoJSON(lane.geometry, {
                pane: 'topology-painted',
                style: { color: '#b7bec0', weight: 1.4, opacity: .95, interactive: false }
            }).addTo(layers.painted);
        });
    }

    function problemIcon(severity) {
        const text = severity === 'error' ? '!' : '?';
        return L.divIcon({
            className: '',
            html: `<div class="topology-problem-marker"><span>${text}</span></div>`,
            iconSize: [22, 22],
            iconAnchor: [11, 22]
        });
    }

    function renderProblems(graph) {
        layers.problems.clearLayers();
        if (!graph) return;
        (graph.problems || []).forEach(problem => {
            if (!Array.isArray(problem.point)) return;
            const marker = L.marker([problem.point[1], problem.point[0]], {
                pane: 'topology-problems',
                icon: problemIcon(problem.severity)
            }).addTo(layers.problems);
            marker.bindTooltip(problem.message || problem.type, { direction: 'top' });
            marker.on('click', () => inspect(`Problem · ${problem.type}`, problem));
        });
    }

    function observationLabel(feature) {
        const properties = feature.properties || {};
        const kind = String(properties.kind || 'observation').replaceAll('_', ' ');
        const width = Number(properties.measuredWidthM);
        const confidence = Number(properties.confidence);
        return [
            Number.isFinite(width) ? `${kind}: ${width.toFixed(2)} m` : kind,
            Number.isFinite(confidence) ? `${Math.round(confidence * 100)}% confidence` : null,
            properties.reason || null
        ].filter(Boolean).join(' · ');
    }

    function renderObservations(graph) {
        layers.observations.clearLayers();
        const evidence = graph?.observations?.imagery;
        if (!Array.isArray(evidence?.features) || !evidence.features.length) return;
        const styles = {
            road_edge: { color: '#bef264', weight: 3.2, opacity: .96 },
            lane_divider: { color: '#fde047', weight: 2.2, opacity: .96, dashArray: '7 5' },
            median_edge: { color: '#fb923c', weight: 3, opacity: .95 },
            stop_line: { color: '#f8fafc', weight: 4, opacity: .98 },
            lane_width: { color: '#ffffff', weight: 2.3, opacity: .98, dashArray: '3 3' }
        };
        L.geoJSON({
            type: 'FeatureCollection',
            features: evidence.features
        }, {
            pane: 'topology-observations',
            style(feature) {
                return styles[feature.properties?.kind]
                    || { color: '#bef264', weight: 2.5, opacity: .95 };
            },
            pointToLayer(feature, latlng) {
                const kind = feature.properties?.kind;
                return L.circleMarker(latlng, {
                    pane: 'topology-observations',
                    radius: kind === 'taper_start' ? 7 : 6,
                    color: '#0a1012',
                    weight: 2,
                    fillColor: kind === 'merge_point' ? '#ff8d72' : '#bef264',
                    fillOpacity: .98
                });
            },
            onEachFeature(feature, layer) {
                layer.bindTooltip(observationLabel(feature), {
                    sticky: true,
                    className: 'topology-tooltip'
                });
                layer.on('click', () => inspect(
                    `Imagery observation · ${feature.properties?.kind || 'unknown'}`,
                    {
                        ...feature.properties,
                        geometry: feature.geometry,
                        imagery: {
                            source: evidence.source,
                            effectiveGsdM: evidence.effectiveGsdM
                        }
                    }
                ));
            }
        }).addTo(layers.observations);
    }

    function widthCandidateLabel(feature) {
        const properties = feature.properties || {};
        const width = Number(properties.measuredWidthM);
        const confidence = Number(properties.confidence);
        return [
            Number.isFinite(width) ? `${width.toFixed(2)} m paint-to-paint` : 'width candidate',
            Number.isFinite(confidence) ? `${Math.round(confidence * 100)}% confidence` : null,
            properties.railInterference ? 'tram/rail interference risk' : null,
            properties.sourceWayId ? `OSM way ${properties.sourceWayId}` : null
        ].filter(Boolean).join(' · ');
    }

    function renderWidthAnalysis(analysis) {
        layers.widths.clearLayers();
        const result = analysis?.result;
        const boundaryFeatures = result?.boundaries?.features || [];
        const measurementFeatures = result?.measurements?.features || [];
        if (!boundaryFeatures.length && !measurementFeatures.length) return;

        L.geoJSON({
            type: 'FeatureCollection',
            features: boundaryFeatures
        }, {
            pane: 'topology-widths',
            style(feature) {
                const confidence = Number(feature.properties?.confidence);
                return {
                    color: feature.properties?.railInterference ? '#fb923c' : '#fde047',
                    weight: 2,
                    opacity: Number.isFinite(confidence) ? .22 + confidence * .6 : .58,
                    dashArray: '5 5',
                    interactive: false
                };
            }
        }).addTo(layers.widths);

        measurementFeatures.forEach(feature => {
            const properties = feature.properties || {};
            const confidence = Number(properties.confidence);
            const coordinates = lineCoordinates(feature.geometry);
            if (coordinates.length < 2) return;
            const color = properties.railInterference ? '#fb923c' : '#22d3ee';
            const line = L.polyline(coordinates, {
                pane: 'topology-widths',
                color,
                weight: 3,
                opacity: Number.isFinite(confidence) ? .3 + confidence * .7 : .8,
                dashArray: properties.railInterference ? '3 4' : null,
                lineCap: 'round',
                bubblingMouseEvents: false
            }).addTo(layers.widths);
            line.bindTooltip(widthCandidateLabel(feature), {
                sticky: true,
                className: 'topology-tooltip'
            });
            line.on('click', () => inspect(
                `Width candidate · ${Number(properties.measuredWidthM).toFixed(2)} m`,
                {
                    ...properties,
                    geometry: feature.geometry,
                    analysis: {
                        id: analysis.id,
                        algorithmVersion: analysis.algorithmVersion,
                        imagerySource: analysis.imagerySource,
                        imageryCapturedAt: analysis.imageryCapturedAt
                    }
                }
            ));
            const first = feature.geometry.coordinates[0];
            const last = feature.geometry.coordinates[feature.geometry.coordinates.length - 1];
            const midpoint = [(first[0] + last[0]) / 2, (first[1] + last[1]) / 2];
            const width = Number(properties.measuredWidthM);
            if (Number.isFinite(width)) {
                L.marker([midpoint[1], midpoint[0]], {
                    pane: 'topology-widths',
                    interactive: false,
                    keyboard: false,
                    icon: L.divIcon({
                        className: 'width-label-icon',
                        html: `<span>${width.toFixed(2)} m</span>`,
                        iconSize: [0, 0],
                        iconAnchor: [0, 0]
                    })
                }).addTo(layers.widths);
            }
        });
    }

    // A disabled toggle is one whose layer has no source (imagery with no configured provider), so
    // it is not something the button can turn on and must not decide what the button offers.
    function layerCheckboxes() {
        return Object.keys(layers)
            .map(key => element(`toggle-${key}`))
            .filter(Boolean);
    }

    function setAllLayers(checked) {
        layerCheckboxes().forEach(checkbox => {
            if (checkbox.disabled) return;
            checkbox.checked = checked;
        });
        applyLayerVisibility();
    }

    function refreshLayersToggleAll() {
        const available = layerCheckboxes().filter(checkbox => !checkbox.disabled);
        const button = element('layers-toggle-all');
        button.textContent = available.some(checkbox => !checkbox.checked) ? 'Check all' : 'Uncheck all';
        button.disabled = !available.length;
    }

    function applyLayerVisibility() {
        Object.entries(layers).forEach(([key, group]) => {
            const checkbox = element(`toggle-${key}`);
            if (checkbox?.checked) {
                if (!map.hasLayer(group)) group.addTo(map);
            } else if (map.hasLayer(group)) {
                map.removeLayer(group);
            }
        });
        keepTopologyAboveOsm();
        refreshLayersToggleAll();
    }

    function updateStats(graph) {
        const activeGraph = graph || state.currentSolution?.graph;
        const stats = activeGraph?.stats || {};
        const sourceWays = Number.isFinite(Number(stats.sourceWays))
            ? Number(stats.sourceWays)
            : new Set((activeGraph?.sections || []).map(section => section.sourceWayId)).size;
        const widthCandidates = state.currentWidthAnalysis?.stats?.widthCandidates || 0;
        element('topbar-stats').innerHTML = [
            `<span><b>${sourceWays}</b> ways</span>`,
            `<span><b>${stats.lanes || 0}</b> lanes</span>`,
            `<span><b>${stats.connections || 0}</b> connections</span>`,
            `<span><b>${stats.imageryObservations || 0}</b> observations</span>`,
            `<span><b>${widthCandidates}</b> widths</span>`,
            `<span><b>${stats.problems || 0}</b> problems</span>`
        ].join('');
    }

    function displayGraph(solution) {
        state.currentSolution = solution;
        const graph = solution?.graph || null;
        renderTopology(graph);
        renderPainted(graph);
        renderObservations(graph);
        renderProblems(graph);
        updateStats(graph);
        applyLayerVisibility();
        renderSolutions();
        if (solution) inspect(`Solution #${solution.id} · ${solution.sourceKind}`, {
            id: solution.id,
            parentId: solution.parentId,
            status: solution.status,
            sourceKind: solution.sourceKind,
            provider: solution.provider,
            snapshotAt: solution.snapshotAt,
            stats: solution.graph?.stats
        });
    }

    // Coalesces map movement into a single load; the map is the only trigger, there is no load button.
    function scheduleViewportLoad() {
        clearTimeout(state.autoLoad.timer);
        state.autoLoad.timer = setTimeout(() => {
            updateImageryStatus();
            loadViewport({ auto: true });
        }, AUTO_LOAD_DEBOUNCE_MS);
    }

    async function loadViewport(options) {
        const auto = !!options?.auto;
        clearTimeout(state.autoLoad.timer);

        const plan = planCurrentViewport(options?.force);
        if (plan.action === 'skip') {
            if (plan.reason === 'too-large') {
                setSnapshotStatus('zoom in to load', 'error');
                if (!auto) showToast(`Zoom in — the viewport is wider than the ${LaneTopologyViewport.MAX_SPAN_DEG}° evidence limit.`, true);
            } else {
                showSnapshotLabel();
            }
            return;
        }

        const token = ++state.autoLoad.token;
        state.autoLoad.controller?.abort();
        const controller = new AbortController();
        state.autoLoad.controller = controller;
        const signal = controller.signal;
        const scope = { signal, token };
        const button = element('reload-viewport');
        setBusy(button, true, 'Loading…');
        setSnapshotStatus('loading OSM…', 'busy');
        try {
            const evidence = await api(
                `/lane-topology/osm?city=zagreb&bbox=${encodeURIComponent(plan.bbox.join(','))}`,
                { signal }
            );
            if (isStale(token)) return;
            state.evidence = evidence;
            state.autoLoad.loadedBbox = plan.bbox;
            renderOsm();
            showSnapshotLabel();
            await Promise.all([loadSolutions(scope), loadWidthAnalyses(scope)]);
            if (isStale(token)) return;
            if (!auto) showToast(`Loaded ${state.evidence.features.length} OSM ways.`);
        } catch (error) {
            if (isAbort(error) || isStale(token)) return;
            state.autoLoad.loadedBbox = null;
            setSnapshotStatus('load failed', 'error');
            showToast(error.message, true);
        } finally {
            if (!isStale(token)) {
                setBusy(button, false);
                applyLayerVisibility();
            }
        }
    }

    async function buildDeterministic() {
        const button = element('build-deterministic');
        setBusy(button, true, 'Building graph…');
        try {
            const body = await api('/lane-topology/build', {
                method: 'POST',
                body: JSON.stringify({ city: 'zagreb', bbox: viewportBbox() })
            });
            displayGraph(body.solution);
            await loadSolutions();
            showToast(`Built solution #${body.solution.id}: ${body.solution.graph.stats.lanes} lanes.`);
        } catch (error) {
            showToast(error.message, true);
        } finally {
            setBusy(button, false);
        }
    }

    async function loadSolution(id, scope) {
        try {
            const body = await api(`/lane-topology/solutions/${id}`, { signal: scope?.signal });
            if (isStale(scope?.token)) return;
            displayGraph(body.solution);
            const nextUrl = new URL(location.href);
            nextUrl.searchParams.set('solution', String(id));
            history.replaceState(null, '', nextUrl);
        } catch (error) {
            if (isAbort(error) || isStale(scope?.token)) return;
            showToast(error.message, true);
        }
    }

    async function promoteSolution(id) {
        try {
            await api(`/lane-topology/solutions/${id}/promote`, {
                method: 'POST',
                body: '{}'
            });
            await loadSolutions();
            if (state.currentSolution?.id === id) state.currentSolution.status = 'canonical';
            showToast(`Solution #${id} is now canonical for this area.`);
        } catch (error) {
            showToast(error.message, true);
        }
    }

    function renderSolutions() {
        const list = element('version-list');
        list.innerHTML = '';
        if (!state.solutions.length) {
            list.innerHTML = '<div class="empty-state">No saved versions intersect this viewport.</div>';
            return;
        }
        state.solutions.forEach(solution => {
            const card = document.createElement('div');
            card.className = `version-card${state.currentSolution?.id === solution.id ? ' is-active' : ''}`;
            card.tabIndex = 0;
            card.setAttribute('role', 'button');
            const date = solution.createdAt ? new Date(solution.createdAt).toLocaleString() : '';
            card.innerHTML = `
                <div class="version-card__top">
                    <strong>#${solution.id} · ${solution.sourceKind}</strong>
                    <span class="version-badge${solution.status === 'canonical' ? ' version-badge--canonical' : ''}">${solution.status}</span>
                </div>
                <small>${solution.stats?.lanes || 0} lanes · ${solution.stats?.connections || 0} connections · ${solution.stats?.problems || 0} problems</small>
                <small>${date}</small>
                <div class="version-card__actions">
                    <button class="button button--tiny" type="button" data-action="load">Load</button>
                    <button class="button button--tiny" type="button" data-action="promote"
                        ${solution.status === 'canonical' ? 'disabled' : ''}>Make canonical</button>
                </div>
            `;
            card.addEventListener('click', () => loadSolution(solution.id));
            card.addEventListener('keydown', event => {
                if (event.target !== card) return;
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    loadSolution(solution.id);
                }
            });
            card.querySelector('[data-action="load"]').addEventListener('click', event => {
                event.stopPropagation();
                loadSolution(solution.id);
            });
            card.querySelector('[data-action="promote"]').addEventListener('click', event => {
                event.stopPropagation();
                promoteSolution(solution.id);
            });
            list.appendChild(card);
        });
    }

    async function loadSolutions(scope) {
        try {
            const body = await api(
                `/lane-topology/solutions?city=zagreb`
                + `&bbox=${encodeURIComponent(evidenceBboxString())}&limit=50`,
                { signal: scope?.signal }
            );
            if (isStale(scope?.token)) return;
            state.solutions = body.solutions || [];
            renderSolutions();
            const currentStillVisible = state.solutions.some(
                solution => solution.id === state.currentSolution?.id
            );
            if (!currentStillVisible && state.solutions.length) {
                const requested = state.requestedSolutionId
                    ? state.solutions.find(solution => solution.id === state.requestedSolutionId)
                    : null;
                const preferred = requested
                    || state.solutions.find(solution => solution.status === 'canonical')
                    || state.solutions[0];
                state.requestedSolutionId = null;
                await loadSolution(preferred.id, scope);
            } else if (!state.solutions.length) {
                // Pan into unsolved ground and the previous area's graph must go with it, or the
                // map, the stats and the version panel all describe somewhere you are not looking.
                displayGraph(null);
            }
        } catch (error) {
            if (isAbort(error) || isStale(scope?.token)) return;
            showToast(error.message, true);
        }
    }

    function displayWidthAnalysis(analysis) {
        state.currentWidthAnalysis = analysis;
        renderWidthAnalysis(analysis);
        renderWidthAnalyses();
        updateStats();
        applyLayerVisibility();
        element('width-status').classList.remove('is-error');
        if (!analysis) {
            element('width-status').textContent = 'No width analysis selected.';
            return;
        }
        const stats = analysis.stats || {};
        const median = Number(stats.medianWidthM);
        element('width-status').textContent = [
            `Run #${analysis.id}`,
            `${stats.widthCandidates || 0} candidates`,
            Number.isFinite(median) ? `median ${median.toFixed(2)} m` : null,
            `${Number(stats.runtimeMs || 0).toFixed(0)} ms`,
            '$0 external AI'
        ].filter(Boolean).join(' · ');
        inspect(`Width analysis #${analysis.id}`, {
            id: analysis.id,
            status: analysis.status,
            method: analysis.method,
            algorithmVersion: analysis.algorithmVersion,
            imagerySource: analysis.imagerySource,
            imageryCapturedAt: analysis.imageryCapturedAt,
            stats,
            limitations: analysis.result?.algorithm?.limitations
        });
    }

    async function loadWidthAnalysis(id, scope) {
        try {
            const body = await api(`/lane-topology/widths/analyses/${id}`, { signal: scope?.signal });
            if (isStale(scope?.token)) return;
            displayWidthAnalysis(body.analysis);
            const nextUrl = new URL(location.href);
            nextUrl.searchParams.set('width', String(id));
            history.replaceState(null, '', nextUrl);
        } catch (error) {
            if (isAbort(error) || isStale(scope?.token)) return;
            showToast(error.message, true);
        }
    }

    async function promoteWidthAnalysis(id) {
        try {
            await api(`/lane-topology/widths/analyses/${id}/promote`, {
                method: 'POST',
                body: '{}'
            });
            await loadWidthAnalyses();
            if (state.currentWidthAnalysis?.id === id) state.currentWidthAnalysis.status = 'canonical';
            showToast(`Width analysis #${id} is now canonical for this area.`);
        } catch (error) {
            showToast(error.message, true);
        }
    }

    function renderWidthAnalyses() {
        const list = element('width-version-list');
        list.innerHTML = '';
        if (!state.widthAnalyses.length) {
            list.innerHTML = '<div class="empty-state">No saved width runs intersect this viewport.</div>';
            return;
        }
        state.widthAnalyses.forEach(analysis => {
            const card = document.createElement('div');
            card.className = `version-card${state.currentWidthAnalysis?.id === analysis.id ? ' is-active' : ''}`;
            card.tabIndex = 0;
            card.setAttribute('role', 'button');
            const date = analysis.createdAt ? new Date(analysis.createdAt).toLocaleString() : '';
            const median = Number(analysis.stats?.medianWidthM);
            card.innerHTML = `
                <div class="version-card__top">
                    <strong>#${analysis.id} · ${analysis.algorithmVersion}</strong>
                    <span class="version-badge${analysis.status === 'canonical' ? ' version-badge--canonical' : ''}">${analysis.status}</span>
                </div>
                <small>${analysis.stats?.widthCandidates || 0} candidates${Number.isFinite(median) ? ` · median ${median.toFixed(2)} m` : ''}</small>
                <small>${date}</small>
                <div class="version-card__actions">
                    <button class="button button--tiny" type="button" data-action="load">Load</button>
                    <button class="button button--tiny" type="button" data-action="promote"
                        ${analysis.status === 'canonical' ? 'disabled' : ''}>Make canonical</button>
                </div>
            `;
            card.addEventListener('click', () => loadWidthAnalysis(analysis.id));
            card.addEventListener('keydown', event => {
                if (event.target !== card) return;
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    loadWidthAnalysis(analysis.id);
                }
            });
            card.querySelector('[data-action="load"]').addEventListener('click', event => {
                event.stopPropagation();
                loadWidthAnalysis(analysis.id);
            });
            card.querySelector('[data-action="promote"]').addEventListener('click', event => {
                event.stopPropagation();
                promoteWidthAnalysis(analysis.id);
            });
            list.appendChild(card);
        });
    }

    async function loadWidthAnalyses(scope) {
        try {
            const body = await api(
                `/lane-topology/widths/analyses?city=zagreb`
                + `&bbox=${encodeURIComponent(evidenceBboxString())}&limit=30`,
                { signal: scope?.signal }
            );
            if (isStale(scope?.token)) return;
            state.widthAnalyses = body.analyses || [];
            renderWidthAnalyses();
            const currentStillVisible = state.widthAnalyses.some(
                analysis => analysis.id === state.currentWidthAnalysis?.id
            );
            if (!currentStillVisible && state.widthAnalyses.length) {
                const requested = state.requestedWidthAnalysisId
                    ? state.widthAnalyses.find(analysis => analysis.id === state.requestedWidthAnalysisId)
                    : null;
                const preferred = requested
                    || state.widthAnalyses.find(analysis => analysis.status === 'canonical')
                    || state.widthAnalyses[0];
                state.requestedWidthAnalysisId = null;
                await loadWidthAnalysis(preferred.id, scope);
            } else if (!state.widthAnalyses.length) {
                displayWidthAnalysis(null);
            }
        } catch (error) {
            if (isAbort(error) || isStale(scope?.token)) return;
            showToast(error.message, true);
        }
    }

    async function analyzeWidths() {
        const button = element('analyze-widths');
        setBusy(button, true, 'Rectifying road strips…');
        element('width-status').classList.remove('is-error');
        element('width-status').textContent = 'Fetching CDOF and scanning recurring road paint…';
        try {
            const body = await api('/lane-topology/widths/analyze', {
                method: 'POST',
                body: JSON.stringify({
                    city: 'zagreb',
                    bbox: viewportBbox(),
                    imagerySource: state.imagerySource?.key || 'zagreb_cdof_2022',
                    parentId: state.currentWidthAnalysis?.id || null
                })
            });
            displayWidthAnalysis(body.analysis);
            await loadWidthAnalyses();
            showToast(
                `Width run #${body.analysis.id}: ${body.analysis.stats?.widthCandidates || 0} candidates.`
            );
        } catch (error) {
            element('width-status').textContent = error.message;
            element('width-status').classList.add('is-error');
            showToast(error.message, true);
        } finally {
            setBusy(button, false);
        }
    }

    async function pollJob(jobId) {
        for (;;) {
            await new Promise(resolve => setTimeout(resolve, 1800));
            const body = await api(`/lane-topology/jobs/${jobId}`);
            const job = body.job;
            setJobStatus(`${job.provider} job #${job.id}: ${job.status}`);
            if (job.status === 'completed') {
                await loadSolution(job.resultSolutionId);
                await loadSolutions();
                showToast(`${job.provider} produced solution #${job.resultSolutionId}.`);
                return;
            }
            if (job.status === 'failed') {
                const failure = new Error(job.error || `${job.provider} recognition failed.`);
                failure.job = job;
                throw failure;
            }
        }
    }

    // The same pure builder and options the backend uses, over the same bbox-intersecting subset of
    // ways, so the review shows the graph the run will actually receive rather than an impression.
    function previewGraphForBbox(bbox) {
        if (!state.evidence?.features?.length) return null;
        const scoped = window.LaneTopologyRunPlan.evidenceForBbox(state.evidence, bbox);
        if (!scoped.features.length) return null;
        return window.LaneTopologyGraph.build(scoped, {
            snapshotAt: scoped.snapshotAt || null,
            // The junction rules read these, so a preview without them shows more movements than
            // the backend will build — the exact impression this function exists to avoid.
            restrictions: scoped.restrictions || [],
            profileFromTags: window.corridorProfileFromOsmTags,
            orientProfile: window.OsmProfile.orientForRightHandTraffic
        });
    }

    function runFact(label, value) {
        return `<dt>${escapeText(label)}</dt><dd>${escapeText(value)}</dd>`;
    }

    function escapeText(value) {
        return String(value ?? '—').replace(/[&<>"']/g, character => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        })[character]);
    }

    function renderRunPlan(plan) {
        const { summary } = plan;
        element('run-dialog-version').textContent = summary.promptVersion || '—';
        element('run-dialog-notices').innerHTML = [
            ...plan.blockers.map(text => `<div class="run-notice run-notice--blocker">${escapeText(text)}</div>`),
            ...plan.warnings.map(text => `<div class="run-notice run-notice--warning">${escapeText(text)}</div>`)
        ].join('');

        const imagery = summary.imagery;
        element('run-dialog-facts').innerHTML = [
            runFact('Provider', `${plan.provider}${summary.providerVersion ? ` · ${summary.providerVersion}` : ''}`),
            runFact('Area', (plan.bbox || []).join(', ')),
            runFact('OSM evidence', `${summary.osmWays} ways${summary.snapshotAt ? ` · ${summary.snapshotAt.slice(0, 10)}` : ''}`),
            runFact('Deterministic base', `${summary.sections} sections · ${summary.lanes} lanes · ${summary.nodes} nodes`),
            runFact('Already connected', `${summary.connections} movements`),
            runFact('Parent solution', summary.parentSolution
                ? `#${summary.parentSolution.id} · ${summary.parentSolution.sourceKind}`
                : 'none — a fresh deterministic base'),
            runFact('Orthophoto', imagery
                ? `${imagery.label} · ${imagery.width ?? '?'}×${imagery.height ?? '?'} px`
                    + `${Number.isFinite(imagery.effectiveGsdM) ? ` · ${imagery.effectiveGsdM.toFixed(2)} m/px` : ''}`
                : 'not attached')
        ].join('');

        element('run-dialog-junctions-heading').textContent =
            `Junctions to solve · ${summary.junctionCount}`;
        element('run-dialog-junctions').innerHTML = summary.junctions.length
            ? summary.junctions.map(junction => `<li><span>${escapeText(junction.name)}</span>`
                + `<small>${junction.armCount} arms${junction.nodeCount > 1 ? ` · ${junction.nodeCount} nodes` : ''}</small></li>`).join('')
            : '<li><span>Nothing unsolved in this area</span></li>';

        element('run-dialog-request').textContent = JSON.stringify(plan.request, null, 2);
        element('run-dialog-confirm').disabled = !plan.canRun;
    }

    async function refreshRunPlan() {
        const provider = state.runDialog.provider;
        const bbox = state.runDialog.bbox;
        if (!provider || !bbox) return;
        const attachImagery = element('run-dialog-imagery').checked && !!state.imagerySource;
        element('run-dialog-imagery-note').textContent = state.imagerySource
            ? state.imagerySource.label
            : 'No orthophoto source configured.';

        let crop = null;
        if (attachImagery) {
            try {
                const body = await api(
                    `/lane-topology/imagery/crop-spec?source=${encodeURIComponent(state.imagerySource.key)}`
                    + `&bbox=${encodeURIComponent(bbox.join(','))}`
                );
                crop = body.crop;
            } catch (_) {
                crop = null; // Surfaces as a blocker rather than silently dropping the imagery.
            }
        }

        const graph = previewGraphForBbox(bbox);
        const junctions = graph
            ? window.LaneTopologyJunctions.deriveJunctions(graph).junctions
            : [];
        const availability = state.providerInfo?.providers?.[provider];
        const plan = window.LaneTopologyRunPlan.buildRunPlan({
            provider,
            city: 'zagreb',
            bbox,
            evidence: window.LaneTopologyRunPlan.evidenceForBbox(state.evidence, bbox),
            graph,
            junctions,
            parentSolution: state.currentSolution
                ? { id: state.currentSolution.id, sourceKind: state.currentSolution.sourceKind }
                : null,
            imagery: attachImagery ? state.imagerySource : null,
            crop,
            maxRecognitionGsdM: MAX_RECOGNITION_GSD_M,
            providerAvailable: !!(state.providerInfo?.enabled && availability?.available),
            providerVersion: availability?.version || null,
            promptVersion: state.providerInfo?.promptVersion || null
        });
        state.runDialog.plan = plan;
        renderRunPlan(plan);
    }

    async function openRunDialog(provider) {
        state.runDialog.provider = provider;
        state.runDialog.bbox = viewportBbox();
        state.runDialog.plan = null;
        element('run-dialog-title').textContent = `Run ${provider}`;
        element('run-dialog-confirm').disabled = true;
        element('run-dialog').hidden = false;
        await refreshRunPlan();
    }

    function closeRunDialog() {
        element('run-dialog').hidden = true;
        state.runDialog.provider = null;
        state.runDialog.plan = null;
    }

    function confirmRunDialog() {
        const plan = state.runDialog.plan;
        if (!plan?.canRun) return;
        closeRunDialog();
        runProvider(plan.provider, plan.request);
    }

    async function runProvider(provider, request) {
        const button = element(`run-${provider}`);
        setBusy(button, true, `Running ${provider}…`);
        try {
            const body = await api('/lane-topology/process', {
                method: 'POST',
                body: JSON.stringify(request)
            });
            setJobStatus(`${provider} job #${body.job.id}: queued`);
            await pollJob(body.job.id);
        } catch (error) {
            const jobLabel = error.job?.id ? ` job #${error.job.id}` : '';
            setJobStatus(`${provider}${jobLabel} failed: ${error.message}`, true);
            inspect(`${provider}${jobLabel} failed`, {
                provider,
                jobId: error.job?.id || null,
                message: error.message,
                outputTail: error.job?.outputTail || null,
                finishedAt: error.job?.finishedAt || null
            });
            showToast(`${provider}${jobLabel} failed. The full error remains in the Recognition panel and Inspector.`, true);
        } finally {
            setBusy(button, false);
        }
    }

    async function loadProviders() {
        try {
            const body = await api('/lane-topology/providers');
            state.providerInfo = body;
            ['codex', 'claude'].forEach(provider => {
                const available = body.enabled && body.providers?.[provider]?.available;
                element(`run-${provider}`).disabled = !available;
                element(`${provider}-status`).textContent = available
                    ? (body.providers[provider].version || 'CLI ready')
                    : 'CLI unavailable';
            });
        } catch (error) {
            ['codex', 'claude'].forEach(provider => {
                element(`${provider}-status`).textContent = 'backend unavailable';
            });
        }
    }

    map.on('moveend', () => {
        updateBboxReadout();
        scheduleViewportLoad();
    });
    map.on('zoomend', () => {
        renderLaneArrows();
        applyTopologyFocus();
    });
    map.on('click', () => {
        if (state.pinnedFocus || state.selectedOsmLayer) clearTopologyFocus();
    });
    element('reload-viewport').addEventListener('click', () => loadViewport({ force: true }));
    element('build-deterministic').addEventListener('click', buildDeterministic);
    element('run-codex').addEventListener('click', () => openRunDialog('codex'));
    element('run-claude').addEventListener('click', () => openRunDialog('claude'));
    element('run-dialog-cancel').addEventListener('click', closeRunDialog);
    element('run-dialog-backdrop').addEventListener('click', closeRunDialog);
    element('run-dialog-confirm').addEventListener('click', confirmRunDialog);
    element('run-dialog-imagery').addEventListener('change', refreshRunPlan);
    element('refresh-solutions').addEventListener('click', () => loadSolutions());
    element('analyze-widths').addEventListener('click', analyzeWidths);
    element('refresh-widths').addEventListener('click', () => loadWidthAnalyses());
    element('clear-topology-focus').addEventListener('click', clearTopologyFocus);
    element('inspector-toggle').addEventListener('click', () => {
        setInspectorCollapsed(!element('inspector').classList.contains('is-collapsed'));
    });
    ['imagery', 'osm', 'topology', 'observations', 'widths', 'painted', 'problems'].forEach(key => {
        element(`toggle-${key}`).addEventListener('change', applyLayerVisibility);
    });
    element('layers-toggle-all').addEventListener('click', () => {
        setAllLayers(layerCheckboxes().some(checkbox => !checkbox.disabled && !checkbox.checked));
    });
    refreshLayersToggleAll();
    document.addEventListener('keydown', event => {
        if (event.key !== 'Escape') return;
        if (!element('run-dialog').hidden) {
            closeRunDialog();
            return;
        }
        if (state.pinnedFocus || state.selectedOsmLayer) clearTopologyFocus();
    });

    updateBboxReadout();
    loadProviders();
    loadImagerySources();
    loadViewport();
})();
