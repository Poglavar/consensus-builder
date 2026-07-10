// Draws corridor cross-sections on the 2D map.
//
// One function turns lanes into Leaflet polygons, and everything that has a cross-section goes through
// it: the road being drawn, an applied road proposal, and a street imported from OSM. The lane's
// appearance comes from CORRIDOR_LANE_TYPES, so retexturing a lane type retextures all three at once.

const CORRIDOR_STRIPS_PANE = 'corridorStripsPane';

function ensureCorridorStripsPane() {
    if (typeof map === 'undefined' || !map || typeof map.getPane !== 'function') return null;
    let pane = map.getPane(CORRIDOR_STRIPS_PANE);
    if (!pane && typeof map.createPane === 'function') {
        pane = map.createPane(CORRIDOR_STRIPS_PANE);
        if (pane && pane.style) {
            pane.style.zIndex = '620'; // above parcels, below parks and proposal highlights
            pane.style.pointerEvents = 'none'; // the corridor parcel underneath stays clickable
        }
    }
    return pane;
}

// White lane-marking lines drawn on top of the surface: dashed between same-direction lanes, solid at
// the centerline where the flow reverses. Same weights/patterns for a drawn road, an applied one and an
// OSM street, so they read alike.
function renderCorridorLaneMarkings(markings, group, pane) {
    if (!Array.isArray(markings)) return;
    markings.forEach(marking => {
        const dashed = marking.kind !== 'centerline';
        marking.lines.forEach(line => {
            L.polyline(line, {
                color: '#f4f4f4',
                weight: dashed ? 1.5 : 2,
                opacity: 0.9,
                dashArray: dashed ? '6, 9' : null,
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

function setCorridorProfilePreview(proposalKey, profile) {
    corridorProfilePreview = (proposalKey && profile) ? { proposalKey: String(proposalKey), profile } : null;
    refreshAppliedCorridorStrips();
}

function clearCorridorProfilePreview() {
    setCorridorProfilePreview(null, null);
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

    proposalStorage.getAllProposals().filter(isAppliedCorridorProposal).forEach(proposal => {
        const definition = corridorProposalDefinition(proposal);
        const profile = corridorProfileForRender(proposal, definition);
        const centerline = corridorCenterlineOf(definition);
        if (!profile || !centerline.length) return;

        const strips = buildCorridorStrips(centerline, profile);
        const markings = (typeof buildCorridorLaneMarkings === 'function') ? buildCorridorLaneMarkings(centerline, profile) : [];
        const decorations = (typeof buildCorridorDecorations === 'function') ? buildCorridorDecorations(centerline, profile) : [];
        const junctions = (typeof buildCorridorJunctionTreatments === 'function') ? buildCorridorJunctionTreatments(centerline, profile) : [];
        const group = renderCorridorStrips(strips, { pane: CORRIDOR_STRIPS_PANE, markings, decorations, junctions });
        if (group) {
            group.addTo(layer);
            drawn += 1;
        }
    });

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
    window.isAppliedCorridorProposal = isAppliedCorridorProposal;
    window.setCorridorProfilePreview = setCorridorProfilePreview;
    window.clearCorridorProfilePreview = clearCorridorProfilePreview;
    window.corridorProposalDefinition = corridorProposalDefinition;
    window.refreshAppliedCorridorStrips = refreshAppliedCorridorStrips;
    window.scheduleCorridorStripRefresh = scheduleCorridorStripRefresh;
    window.clearAppliedCorridorStrips = clearAppliedCorridorStrips;
    window.CORRIDOR_STRIPS_PANE = CORRIDOR_STRIPS_PANE;
}
