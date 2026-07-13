// Draws corridor cross-sections on the 2D map.
//
// One function turns lanes into Leaflet polygons, and everything that has a cross-section goes through
// it: the road being drawn, an applied road proposal, and a street imported from OSM. The lane's
// appearance comes from CORRIDOR_LANE_TYPES, so retexturing a lane type retextures all three at once.

const CORRIDOR_STRIPS_PANE = 'corridorStripsPane';
const CORRIDOR_HIT_PANE = 'corridorHitPane';

function ensureCorridorStripsPane() {
    if (typeof map === 'undefined' || !map || typeof map.getPane !== 'function') return null;
    let pane = map.getPane(CORRIDOR_STRIPS_PANE);
    if (!pane && typeof map.createPane === 'function') {
        pane = map.createPane(CORRIDOR_STRIPS_PANE);
    }
    if (pane && pane.style) {
        // Proposal/parcel shading lives at 650. The designed road surface must remain legible above
        // that translucent fill, while proposal hover outlines and labels (660/670) stay on top.
        pane.style.zIndex = '655';
        pane.style.pointerEvents = 'none'; // enforce this even when another renderer created the pane first
    }
    return pane;
}

function ensureCorridorHitPane() {
    if (typeof map === 'undefined' || !map || typeof map.getPane !== 'function') return null;
    let pane = map.getPane(CORRIDOR_HIT_PANE);
    if (!pane && typeof map.createPane === 'function') pane = map.createPane(CORRIDOR_HIT_PANE);
    if (pane && pane.style) {
        pane.style.zIndex = '656'; // immediately above the visual strips; transparent paths only
        pane.style.pointerEvents = 'auto';
    }
    return pane;
}

// White lane-marking lines drawn on top of the surface — dashed everywhere, with the centerline
// slightly heavier and longer-dashed so the flow divide still reads. Same weights/patterns for a
// drawn road, an applied one and an OSM street, so they read alike.
function renderCorridorLaneMarkings(markings, group, pane) {
    if (!Array.isArray(markings)) return;
    markings.forEach(marking => {
        const isCenterline = marking.kind === 'centerline';
        marking.lines.forEach(line => {
            L.polyline(line, {
                color: '#f4f4f4',
                weight: isCenterline ? 2 : 1.5,
                opacity: 0.9,
                dashArray: isCenterline ? '10, 8' : '6, 9',
                interactive: false,
                pane: pane || undefined,
                className: `corridor-lane-marking corridor-lane-marking--${marking.kind}`
            }).addTo(group);
        });
    });
}

function renderCorridorJunctions(junctions, group, pane) {
    if (!Array.isArray(junctions)) return;
    junctions.forEach(junction => {
        (junction.surfacePolygons || []).forEach(polygon => {
            L.polygon(polygon, {
                color: '#2b2b2b', weight: 0, fillColor: '#2b2b2b', fillOpacity: 1,
                interactive: false, pane: pane || undefined,
                className: 'corridor-junction-surface'
            }).addTo(group);
        });
        (junction.crosswalkPolygons || []).forEach(polygon => {
            L.polygon(polygon, {
                color: '#ffffff', weight: 0, fillColor: '#ffffff', fillOpacity: 0.92,
                interactive: false, pane: pane || undefined,
                className: 'corridor-crosswalk-stripe'
            }).addTo(group);
        });
    });
}

function corridorDecorationHtml(decoration) {
    if (decoration.kind === 'tree') return '<i class="fas fa-tree" aria-hidden="true"></i>';
    if (decoration.kind === 'bike') return '<i class="fas fa-bicycle" aria-hidden="true"></i>';
    return '<span class="corridor-pedestrian-pair"><i class="fas fa-person-dress" aria-hidden="true"></i><i class="fas fa-child" aria-hidden="true"></i></span>';
}

function renderCorridorDecorations(decorations, group, pane) {
    if (!Array.isArray(decorations)) return;
    decorations.forEach(decoration => {
        const rotation = decoration.kind === 'tree' ? 0 : (Number(decoration.angle) * 180 / Math.PI);
        const icon = L.divIcon({
            className: `corridor-decoration corridor-decoration--${decoration.kind}`,
            html: `<span class="corridor-decoration-inner" style="transform:rotate(${rotation}deg)">${corridorDecorationHtml(decoration)}</span>`,
            iconSize: decoration.kind === 'tree' ? [18, 18] : [26, 26],
            iconAnchor: decoration.kind === 'tree' ? [9, 9] : [13, 13]
        });
        const markerOptions = { icon, interactive: false, keyboard: false };
        if (pane) markerOptions.pane = pane;
        L.marker([decoration.lat, decoration.lng], markerOptions).addTo(group);
    });
}

function renderCorridorBuildingTunnels(tunnels, group, pane) {
    if (!Array.isArray(tunnels) || !group) return;
    tunnels.forEach(tunnel => {
        if (tunnel?.kind !== 'building' || !tunnel.from || !tunnel.to) return;
        const points = [tunnel.from, tunnel.to];
        L.polyline(points, {
            color: '#6d28d9', weight: 9, opacity: 0.85, dashArray: '8 7',
            interactive: false, pane: pane || undefined,
            className: 'corridor-building-tunnel'
        }).addTo(group);
        points.forEach(point => L.circleMarker(point, {
            radius: 5, color: '#8b5cf6', weight: 2, fillColor: '#15121f', fillOpacity: 1,
            interactive: false, pane: pane || undefined,
            className: 'corridor-building-tunnel-portal'
        }).addTo(group));
    });
}

// Turn `[{type, polygons}]` into a LayerGroup. Surface, markings, junction treatment and repeated
// symbols are layered in that order so junction asphalt suppresses through-lines and crossings stay on top.
function renderCorridorStrips(strips, options = {}) {
    if (!Array.isArray(strips) || !strips.length) return null;
    const group = L.layerGroup();
    const fillOpacity = Number.isFinite(options.fillOpacity) ? options.fillOpacity : 0.85;

    strips.forEach(strip => {
        const lane = (typeof CORRIDOR_LANE_TYPES !== 'undefined' && CORRIDOR_LANE_TYPES[strip.type]) || {};
        const surface = lane.surface || '#2b2b2b';
        strip.polygons.forEach(polygon => {
            L.polygon(polygon, {
                color: surface,
                weight: 0.5,
                fillColor: surface,
                fillOpacity,
                interactive: false,
                pane: options.pane || undefined,
                className: `corridor-strip corridor-strip--${strip.type}`
            }).addTo(group);
        });
    });

    renderCorridorLaneMarkings(options.markings, group, options.pane);
    renderCorridorJunctions(options.junctions, group, options.pane);
    renderCorridorDecorations(options.decorations, group, options.pane);
    return group;
}

// ---------------------------------------------------------------------------
// Applied road proposals
//
// An applied road becomes a corridor parcel, which the parcel styler paints a single flat asphalt.
// Its cross-section is drawn over it, from the profile stored on the proposal. Only roads: a track's
// rails are already drawn by renderTrackWithRails.
// ---------------------------------------------------------------------------

let appliedCorridorLayer = null;
let corridorRefreshHandle = null;

// While the cross-section editor is open it overrides one proposal's profile, so the map shows the edit
// as it is made. Nothing is written to the proposal — an applied road on the map is still the road that
// was proposed until the edit is saved as a new proposal of its own.
let corridorProfilePreview = null;

function setCorridorProfilePreview(proposalKey, profile, segmentId = null) {
    corridorProfilePreview = (proposalKey && profile)
        ? { proposalKey: String(proposalKey), profile, segmentId: segmentId !== null && segmentId !== undefined ? String(segmentId) : null }
        : null;
    refreshAppliedCorridorStrips();
}

// The proposal's per-segment entries with the editor's live preview applied: a preview with a
// segmentId restyles just that segment, one without restyles the whole road.
function corridorRenderEntries(proposal, definition) {
    const entries = (typeof corridorSegmentEntries === 'function') ? corridorSegmentEntries(definition) : [];
    if (!corridorProfilePreview) return entries;
    const key = (typeof getProposalKey === 'function' ? getProposalKey(proposal) : null) || proposal.proposalId;
    if (String(key) !== corridorProfilePreview.proposalKey) return entries;
    const previewProfile = corridorProfilePreview.profile;
    const previewSegmentId = corridorProfilePreview.segmentId;
    return entries.map(entry => (previewSegmentId === null || entry.segmentId === previewSegmentId)
        ? { ...entry, profile: previewProfile, width: (typeof corridorProfileWidth === 'function' && corridorProfileWidth(previewProfile)) || entry.width }
        : entry);
}

function clearCorridorProfilePreview() {
    setCorridorProfilePreview(null, null);
}

// ---------------------------------------------------------------------------
// Selected-segment highlight: clicking a road records the segment (the cross-section editor
// scopes to it) — this paints that segment unmistakably: amber marching-ants outline over
// its exact footprint, so "which piece am I editing" is never a guess.
// ---------------------------------------------------------------------------
let selectedSegmentHighlightLayer = null;

function clearSelectedCorridorSegmentHighlight() {
    if (selectedSegmentHighlightLayer && typeof map !== 'undefined' && map && map.hasLayer(selectedSegmentHighlightLayer)) {
        map.removeLayer(selectedSegmentHighlightLayer);
    }
    selectedSegmentHighlightLayer = null;
}

function renderSelectedCorridorSegmentHighlight() {
    clearSelectedCorridorSegmentHighlight();
    const clicked = (typeof window !== 'undefined') ? window.corridorLastClickedSegment : null;
    if (!clicked || !clicked.proposalKey || !clicked.segmentId) return;
    const selection = window.ProposalSelection;
    if (selection && typeof selection.is === 'function' && !selection.is(clicked.proposalKey)) return;
    const proposal = (typeof getProposalByIdOrHash === 'function') ? getProposalByIdOrHash(clicked.proposalKey) : null;
    const definition = corridorProposalDefinition(proposal);
    if (!definition) return;
    const entries = (typeof corridorSegmentEntries === 'function') ? corridorSegmentEntries(definition) : [];
    const entry = entries.find(candidate => candidate.segmentId === String(clicked.segmentId));
    if (!entry || typeof calculateRoadPolygon !== 'function') return;
    const polygon = calculateRoadPolygon(entry.points, entry.width);
    if (!polygon) return;
    ensureCorridorStripsPane();
    selectedSegmentHighlightLayer = L.polygon(polygon, {
        pane: CORRIDOR_STRIPS_PANE,
        color: '#f59e0b',
        weight: 4,
        dashArray: '12 8',
        fillColor: '#f59e0b',
        fillOpacity: 0.12,
        interactive: false,
        className: 'corridor-segment-selected'
    }).addTo(map);
}
if (typeof window !== 'undefined') {
    window.refreshSelectedCorridorSegmentHighlight = renderSelectedCorridorSegmentHighlight;
}

function corridorProposalDefinition(proposal) {
    return (proposal && ((proposal.roadProposal && proposal.roadProposal.definition) || proposal.definition)) || null;
}

// The profile to draw for a proposal: the editor's working copy when it is the one being edited.
function corridorProfileForRender(proposal, definition) {
    if (corridorProfilePreview) {
        const key = (typeof getProposalKey === 'function' ? getProposalKey(proposal) : null) || proposal.proposalId;
        if (String(key) === corridorProfilePreview.proposalKey) return corridorProfilePreview.profile;
    }
    return corridorProfileOf(definition);
}

function forwardAppliedCorridorClick(proposal, event) {
    if (!proposal) return;
    // While a corridor tool is drawing, a click on an applied road places a drawing point on it
    // (that is how connectors reach existing roads and merge), never a selection.
    if (window.roadDrawingMode === true || window.trackDrawingMode === true) {
        try {
            if (event && event.latlng && typeof map !== 'undefined' && map) {
                map.fire('click', {
                    latlng: event.latlng,
                    layerPoint: event.layerPoint,
                    containerPoint: event.containerPoint,
                    originalEvent: event.originalEvent
                });
            }
        } catch (_) { }
        return;
    }
    // Clicking a road selects THE ROAD — one crisp selection outline, collapsed details, node
    // handles. Any active parcel selection ends first (panel closed, parcel restyled), so the
    // two selection systems never stack.
    try { if (typeof hideParcelInfoPanel === 'function') hideParcelInfoPanel(); } catch (_) { }
    const proposalKey = (typeof getProposalKey === 'function' && getProposalKey(proposal)) || proposal.proposalId;
    if (proposalKey && typeof selectAndHighlightProposal === 'function') {
        window.__openProposalDetailsCollapsed = true;
        selectAndHighlightProposal(proposalKey, null, false, true);
    }
}

function renderAppliedCorridorHitTargets(strips, proposal, group, definition, segmentEntries = null) {
    if (!Array.isArray(strips) || !proposal || !group) return;
    ensureCorridorHitPane();
    const proposalKey = String((typeof getProposalKey === 'function' ? getProposalKey(proposal) : null) || proposal.proposalId);
    // Remember which SEGMENT the click landed on: the cross-section editor scopes to it.
    const rememberSegment = segmentId => {
        window.corridorLastClickedSegment = segmentId
            ? { proposalKey, segmentId: String(segmentId) }
            : null;
        // The click may be the one SELECTING the proposal: paint after selection settles.
        requestAnimationFrame(() => renderSelectedCorridorSegmentHighlight());
    };
    const hitOptions = {
        color: '#000000',
        weight: 0,
        opacity: 0,
        fillColor: '#000000',
        fillOpacity: 0.001,
        interactive: true,
        bubblingMouseEvents: false,
        pane: CORRIDOR_HIT_PANE,
        className: 'corridor-applied-hit-target'
    };
    strips.forEach(strip => {
        (strip.polygons || []).forEach(polygon => {
            L.polygon(polygon, hitOptions)
                .on('click', event => { rememberSegment(null); forwardAppliedCorridorClick(proposal, event); }).addTo(group);
        });
    });
    // The strips leave gaps (junction fills, verges, rounding); a hit target over the FULL
    // footprint keeps every click within the corridor on the corridor, instead of falling
    // through to the parcel underneath.
    const footprint = definition && definition.polygon;
    if (footprint) {
        try {
            const geometry = footprint.type ? footprint : { type: 'Polygon', coordinates: footprint };
            // interactive/bubbling are LAYER options, not styles — passed at the geoJSON level so
            // the created polygons inherit them (bubbling must stay off or a click would reach
            // the map too and, while drawing, place a second point).
            L.geoJSON({ type: 'Feature', properties: {}, geometry }, {
                style: hitOptions,
                pane: CORRIDOR_HIT_PANE,
                interactive: true,
                bubblingMouseEvents: false
            }).on('click', event => { rememberSegment(null); forwardAppliedCorridorClick(proposal, event); }).addTo(group);
        } catch (_) { }
    }
    // Per-segment hit polygons go on LAST (topmost in the pane), so a click inside a segment's
    // own footprint records that segment before the generic handlers would.
    if (Array.isArray(segmentEntries) && typeof calculateRoadPolygon === 'function') {
        segmentEntries.forEach(entry => {
            if (!entry.segmentId || !Array.isArray(entry.points) || entry.points.length < 2) return;
            const polygon = calculateRoadPolygon(entry.points, entry.width);
            if (!polygon) return;
            L.polygon(polygon, hitOptions)
                .on('click', event => { rememberSegment(entry.segmentId); forwardAppliedCorridorClick(proposal, event); })
                .addTo(group);
        });
    }
}

function isAppliedCorridorProposal(proposal) {
    if (!proposal) return false;
    const definition = corridorProposalDefinition(proposal);
    if (!definition || (definition.metadata && definition.metadata.isTrack)) return false;

    const status = String(proposal.status || '').toLowerCase();
    const roadStatus = String((proposal.roadProposal && proposal.roadProposal.status) || '').toLowerCase();
    return status === 'applied' || status === 'executed' || roadStatus === 'applied' || roadStatus === 'executed';
}

function clearAppliedCorridorStrips() {
    if (appliedCorridorLayer && typeof map !== 'undefined' && map && map.hasLayer(appliedCorridorLayer)) {
        map.removeLayer(appliedCorridorLayer);
    }
    appliedCorridorLayer = null;
}

function refreshAppliedCorridorStrips() {
    clearAppliedCorridorStrips();
    if (typeof map === 'undefined' || !map) return;
    if (typeof proposalStorage === 'undefined' || typeof proposalStorage.getAllProposals !== 'function') return;
    if (typeof buildCorridorStrips !== 'function') return;

    ensureCorridorStripsPane();
    const layer = L.layerGroup();
    let drawn = 0;
    const renderedCorridors = [];

    const proposals = proposalStorage.getAllProposals();
    proposals.filter(isAppliedCorridorProposal).forEach(proposal => {
        const definition = corridorProposalDefinition(proposal);
        const fallbackProfile = corridorProfileForRender(proposal, definition);
        const centerline = corridorCenterlineOf(definition);
        if (!fallbackProfile || !centerline.length) return;

        // Per-segment cross-sections: each segment renders with ITS profile; junction patches
        // (sized per arm) then cover the seams where different widths meet.
        const entries = corridorRenderEntries(proposal, definition)
            .filter(entry => Array.isArray(entry.points) && entry.points.length >= 2)
            .map(entry => entry.profile ? entry : { ...entry, profile: fallbackProfile });
        if (!entries.length) return;

        const group = L.layerGroup();
        const allStrips = [];
        entries.forEach(entry => {
            const strips = buildCorridorStrips([entry.points], entry.profile);
            const markings = (typeof buildCorridorLaneMarkings === 'function') ? buildCorridorLaneMarkings([entry.points], entry.profile) : [];
            // Trees are physical objects and stay; bike/pedestrian lane explainers are clutter on
            // the map — lane meaning lives in the cross-section editor.
            const decorations = ((typeof buildCorridorDecorations === 'function') ? buildCorridorDecorations([entry.points], entry.profile) : [])
                .filter(decoration => decoration.kind === 'tree');
            const segmentGroup = renderCorridorStrips(strips, { pane: CORRIDOR_STRIPS_PANE, markings, decorations, junctions: [] });
            if (segmentGroup) {
                segmentGroup.addTo(group);
                allStrips.push(...strips);
            }
        });
        if (!allStrips.length) return;
        const junctions = (typeof buildCorridorJunctionTreatmentsForEntries === 'function')
            ? buildCorridorJunctionTreatmentsForEntries(entries)
            : [];
        if (junctions.length) renderCorridorJunctions(junctions, group, CORRIDOR_STRIPS_PANE);

        group.addTo(layer);
        renderAppliedCorridorHitTargets(allStrips, proposal, layer, definition, entries);
        const corridorId = String((typeof getProposalKey === 'function' ? getProposalKey(proposal) : null) || proposal.proposalId);
        entries.forEach(entry => renderedCorridors.push({ centerline: [entry.points], profile: entry.profile, corridorId }));
        drawn += 1;
    });

    // Where two applied roads meet (a drawing snapped onto an existing road shares its exact
    // coordinates), form a real intersection: the same asphalt + zebra treatment as a road's
    // own junctions, drawn once on top of both roads' markings.
    if (typeof buildCrossCorridorJunctionTreatments === 'function' && renderedCorridors.length >= 2) {
        const crossJunctions = buildCrossCorridorJunctionTreatments(renderedCorridors);
        if (crossJunctions.length) renderCorridorJunctions(crossJunctions, layer, CORRIDOR_STRIPS_PANE);
    }

    // Tracks have their own rail renderer and therefore do not enter the road-strip loop above, but
    // their building passages use the same applied overlay and proposal definition.
    proposals.forEach(proposal => {
        const definition = corridorProposalDefinition(proposal);
        if (!definition || !Array.isArray(definition.tunnels) || !definition.tunnels.length) return;
        const status = String(proposal.status || '').toLowerCase();
        const roadStatus = String(proposal.roadProposal?.status || '').toLowerCase();
        if (!['applied', 'executed'].includes(status) && !['applied', 'executed'].includes(roadStatus)) return;
        renderCorridorBuildingTunnels(definition.tunnels, layer, CORRIDOR_STRIPS_PANE);
        drawn += 1;
    });

    // Applied roads cut through parks/squares/lakes at render time — any corridor change
    // (apply, unapply, node drag, width edit) must re-cut them, including when the last
    // corridor disappears and the structures heal back to their full shape.
    try { if (typeof updateParksLayer === 'function') updateParksLayer(); } catch (_) { }
    try { if (typeof updateSquaresLayer === 'function') updateSquaresLayer(); } catch (_) { }
    try { if (typeof updateLakesLayer === 'function') updateLakesLayer(); } catch (_) { }
    renderSelectedCorridorSegmentHighlight();

    // Demolitions live on applied corridors: any corridor change can raze or restore buildings.
    // Not optional cosmetics — a failure here leaves razed buildings standing, so it must be loud.
    if (window.buildingFeaturePool?.length) {
        try { window.rebuildBuildingLayerFromPool(); } catch (error) {
            console.error('[corridor-render] building demolition refresh failed — 2D building layer is stale', error);
        }
    }

    if (!drawn) return;
    appliedCorridorLayer = layer.addTo(map);
}

// Applying a proposal can rebuild a lot of the map; coalesce the redraws that follow into one.
// Deliberately not requestAnimationFrame: it never fires while the tab is not rendering, and the
// corridor would then have no cross-section until something else happened to repaint the map.
function scheduleCorridorStripRefresh() {
    if (corridorRefreshHandle) return;
    corridorRefreshHandle = setTimeout(() => {
        corridorRefreshHandle = null;
        try {
            refreshAppliedCorridorStrips();
        } catch (error) {
            console.warn('[corridor-render] failed to refresh applied corridor strips', error);
        }
    }, 0);
}

if (typeof window !== 'undefined') {
    window.renderCorridorStrips = renderCorridorStrips;
    window.renderCorridorBuildingTunnels = renderCorridorBuildingTunnels;
    window.isAppliedCorridorProposal = isAppliedCorridorProposal;
    window.setCorridorProfilePreview = setCorridorProfilePreview;
    window.clearCorridorProfilePreview = clearCorridorProfilePreview;
    window.corridorProposalDefinition = corridorProposalDefinition;
    window.refreshAppliedCorridorStrips = refreshAppliedCorridorStrips;
    window.scheduleCorridorStripRefresh = scheduleCorridorStripRefresh;
    window.clearAppliedCorridorStrips = clearAppliedCorridorStrips;
    window.CORRIDOR_STRIPS_PANE = CORRIDOR_STRIPS_PANE;
}
