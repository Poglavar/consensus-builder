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

// Turn `[{type, polygons}]` into a LayerGroup. The only place a lane becomes pixels.
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

function corridorProposalDefinition(proposal) {
    return (proposal && ((proposal.roadProposal && proposal.roadProposal.definition) || proposal.definition)) || null;
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
        const profile = corridorProfileOf(definition);
        const centerline = corridorCenterlineOf(definition);
        if (!profile || !centerline.length) return;

        const strips = buildCorridorStrips(centerline, profile);
        const group = renderCorridorStrips(strips, { pane: CORRIDOR_STRIPS_PANE });
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
    window.corridorProposalDefinition = corridorProposalDefinition;
    window.refreshAppliedCorridorStrips = refreshAppliedCorridorStrips;
    window.scheduleCorridorStripRefresh = scheduleCorridorStripRefresh;
    window.clearAppliedCorridorStrips = clearAppliedCorridorStrips;
    window.CORRIDOR_STRIPS_PANE = CORRIDOR_STRIPS_PANE;
}
