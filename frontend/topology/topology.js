(function () {
    'use strict';

    const params = new URLSearchParams(location.search);
    const backend = (params.get('backend') || 'http://localhost:3003').replace(/\/$/, '');
    const initialLat = Number(params.get('lat')) || 45.7989;
    const initialLng = Number(params.get('lng')) || 15.9614;
    const initialZoom = Number(params.get('zoom')) || 16;
    const initialSolutionId = Number(params.get('solution')) || null;

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
        painted: 430,
        osm: 450,
        topology: 470,
        problems: 490
    };
    Object.entries(panes).forEach(([name, zIndex]) => {
        const pane = map.createPane(`topology-${name}`);
        pane.style.zIndex = String(zIndex);
    });

    const layers = {
        osm: L.layerGroup().addTo(map),
        topology: L.layerGroup().addTo(map),
        painted: L.layerGroup().addTo(map),
        problems: L.layerGroup().addTo(map)
    };
    const state = {
        evidence: null,
        currentSolution: null,
        solutions: [],
        toastTimer: null,
        topologyIndex: null,
        topologyVisuals: null,
        hoverFocus: null,
        pinnedFocus: null,
        requestedSolutionId: initialSolutionId
    };

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

    function updateBboxReadout() {
        element('bbox-readout').textContent = bboxString();
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

    function inspect(title, value) {
        element('inspector-title').textContent = title;
        element('inspector-content').textContent = JSON.stringify(value, null, 2);
    }

    function roadColor(feature) {
        if (feature.properties?.railway_type) return '#a78bfa';
        const lanes = Number(feature.properties?.tags?.lanes) || 0;
        if (lanes >= 5) return '#f6b94c';
        if (lanes >= 3) return '#7dd3fc';
        return '#a8bbc0';
    }

    function renderOsm() {
        layers.osm.clearLayers();
        if (!state.evidence?.features) return;
        L.geoJSON(state.evidence, {
            pane: 'topology-osm',
            style(feature) {
                const rail = !!feature.properties?.railway_type;
                return {
                    color: roadColor(feature),
                    weight: rail ? 2 : 3,
                    opacity: .86,
                    dashArray: rail ? '7 6' : null,
                    lineCap: 'round'
                };
            },
            onEachFeature(feature, layer) {
                layer.on('click', () => inspect(
                    `OSM way ${feature.properties?.osm_id || '—'}`,
                    feature.properties
                ));
                layer.bindTooltip(
                    `${feature.properties?.name || '(unnamed)'} · way ${feature.properties?.osm_id || '—'}`,
                    { sticky: true }
                );
            }
        }).addTo(layers.osm);
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

    function focusLabel(focus) {
        if (!focus) return 'Hover a lane or node to trace it. Click to pin; Esc clears.';
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

        const active = state.pinnedFocus || state.hoverFocus;
        element('focus-status').textContent = focusLabel(active);
        element('focus-status').classList.toggle('is-preview', !!state.hoverFocus && !state.pinnedFocus);
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
        state.pinnedFocus = window.LaneTopologyView.focusFor(state.topologyIndex, kind, id);
        state.hoverFocus = null;
        applyTopologyFocus();
    }

    function clearTopologyFocus() {
        state.pinnedFocus = null;
        state.hoverFocus = null;
        applyTopologyFocus();
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
            element('focus-status').textContent = focusLabel(null);
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

    function renderPainted(graph) {
        layers.painted.clearLayers();
        if (!graph) return;
        const entries = [];
        (graph.sections || []).forEach(section => {
            if (!section.profile?.strips?.length || !section.coordinates?.length) return;
            const centerline = section.coordinates.map(([lng, lat]) => ({ lat, lng }));
            entries.push({ corridorId: section.sourceWayId, points: centerline, profile: section.profile });
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
                window.buildCorridorLaneMarkingsForEntries(entries).forEach(markings => {
                    markings.forEach(marking => {
                        marking.lines.forEach(line => {
                            L.polyline(line, {
                                pane: 'topology-painted',
                                color: '#f4f4f4',
                                weight: marking.kind === 'centerline' ? 1.6 : 1.15,
                                opacity: .86,
                                dashArray: marking.kind === 'centerline' ? '10 8' : '6 8',
                                interactive: false
                            }).addTo(layers.painted);
                        });
                    });
                });
            } catch (error) {
                console.warn('[topology] lane markings unavailable', error);
            }
        }
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

    function applyLayerVisibility() {
        Object.entries(layers).forEach(([key, group]) => {
            const checkbox = element(`toggle-${key}`);
            if (checkbox?.checked) {
                if (!map.hasLayer(group)) group.addTo(map);
            } else if (map.hasLayer(group)) {
                map.removeLayer(group);
            }
        });
    }

    function updateStats(graph) {
        const stats = graph?.stats || {};
        const sourceWays = Number.isFinite(Number(stats.sourceWays))
            ? Number(stats.sourceWays)
            : new Set((graph?.sections || []).map(section => section.sourceWayId)).size;
        element('topbar-stats').innerHTML = [
            `<span><b>${sourceWays}</b> ways</span>`,
            `<span><b>${stats.lanes || 0}</b> lanes</span>`,
            `<span><b>${stats.connections || 0}</b> connections</span>`,
            `<span><b>${stats.problems || 0}</b> problems</span>`
        ].join('');
    }

    function displayGraph(solution) {
        state.currentSolution = solution;
        const graph = solution?.graph || null;
        renderTopology(graph);
        renderPainted(graph);
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

    async function loadViewport() {
        const button = element('load-viewport');
        setBusy(button, true, 'Loading OSM…');
        try {
            const bbox = bboxString();
            state.evidence = await api(`/lane-topology/osm?city=zagreb&bbox=${encodeURIComponent(bbox)}`);
            renderOsm();
            element('snapshot-pill').textContent = state.evidence.snapshotAt
                ? state.evidence.snapshotAt.slice(0, 10)
                : 'snapshot unknown';
            await loadSolutions();
            showToast(`Loaded ${state.evidence.features.length} OSM ways.`);
        } catch (error) {
            showToast(error.message, true);
        } finally {
            setBusy(button, false);
            applyLayerVisibility();
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

    async function loadSolution(id) {
        try {
            const body = await api(`/lane-topology/solutions/${id}`);
            displayGraph(body.solution);
            const nextUrl = new URL(location.href);
            nextUrl.searchParams.set('solution', String(id));
            history.replaceState(null, '', nextUrl);
        } catch (error) {
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

    async function loadSolutions() {
        try {
            const body = await api(`/lane-topology/solutions?city=zagreb&bbox=${encodeURIComponent(bboxString())}&limit=50`);
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
                await loadSolution(preferred.id);
            }
        } catch (error) {
            showToast(error.message, true);
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

    async function runProvider(provider) {
        const button = element(`run-${provider}`);
        setBusy(button, true, `Running ${provider}…`);
        try {
            const body = await api('/lane-topology/process', {
                method: 'POST',
                body: JSON.stringify({
                    city: 'zagreb',
                    bbox: viewportBbox(),
                    provider,
                    baseSolutionId: state.currentSolution?.id || null
                })
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

    map.on('moveend', updateBboxReadout);
    map.on('zoomend', () => {
        renderLaneArrows();
        applyTopologyFocus();
    });
    map.on('click', () => {
        if (state.pinnedFocus) clearTopologyFocus();
    });
    element('load-viewport').addEventListener('click', loadViewport);
    element('build-deterministic').addEventListener('click', buildDeterministic);
    element('run-codex').addEventListener('click', () => runProvider('codex'));
    element('run-claude').addEventListener('click', () => runProvider('claude'));
    element('refresh-solutions').addEventListener('click', loadSolutions);
    element('clear-topology-focus').addEventListener('click', clearTopologyFocus);
    ['osm', 'topology', 'painted', 'problems'].forEach(key => {
        element(`toggle-${key}`).addEventListener('change', applyLayerVisibility);
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && state.pinnedFocus) clearTopologyFocus();
    });

    updateBboxReadout();
    loadProviders();
    loadViewport();
})();
