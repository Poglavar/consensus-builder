// Draws corridor cross-sections on the 2D map.
//
// One function turns lanes into Leaflet polygons, and everything that has a cross-section goes through
// it: the corridor being drawn, an applied corridor proposal, and a street imported from OSM. The lane's
// appearance comes from CORRIDOR_LANE_TYPES, so retexturing a lane type retextures all three at once.
//
// A ROAD AND A TRACK ARE THE SAME OBJECT. Both are a centerline plus a lane list, and both are drawn
// here. What makes a corridor look like a railway is not a flag on the proposal but a `rail` lane in its
// cross-section: a rail lane draws a pair of rails and their sleepers, on the lane's own centre, at the
// lane's gauge. So a tram lane added to a street draws rails down that street, and a sidewalk added to a
// track draws a pavement beside the rails — with no branch anywhere that asks "is this a track".

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

function renderCorridorGradeSeparations(records, group, pane) {
    if (!Array.isArray(records) || !group) return;
    records.forEach(record => {
        if (!record?.from || !record?.crossing || !record?.to) return;
        const isOverpass = record.mode === 'overpass';
        if (!isOverpass && record.mode !== 'underpass') return;
        const color = isOverpass ? '#d97706' : '#1d4ed8';
        L.polyline([record.from, record.crossing, record.to], {
            color,
            weight: Math.max(6, Number(record.width) || 2),
            opacity: 0.92,
            dashArray: isOverpass ? null : '8 7',
            lineCap: 'round',
            interactive: false,
            pane: pane || undefined,
            className: `corridor-grade-separation corridor-grade-separation--${record.mode}`
        }).addTo(group);
        [record.from, record.to].forEach(point => L.circleMarker(point, {
            radius: 4.5,
            color,
            weight: 2,
            fillColor: '#ffffff',
            fillOpacity: 1,
            interactive: false,
            pane: pane || undefined,
            className: `corridor-grade-separation-portal corridor-grade-separation-portal--${record.mode}`
        }).addTo(group));
    });
}

// ---------------------------------------------------------------------------
// Rail lanes
//
// The sleepers of a single kilometre of track are thousands of little lines, so they are all drawn onto
// ONE canvas element rather than becoming thousands of SVG paths.
// ---------------------------------------------------------------------------

let corridorRailCanvasRenderer = null;
function corridorRailRenderer() {
    if (!corridorRailCanvasRenderer && typeof L !== 'undefined' && L.canvas) {
        corridorRailCanvasRenderer = L.canvas({ padding: 0.5 });
    }
    return corridorRailCanvasRenderer;
}

const CORRIDOR_SLEEPER_SPACING = 0.6; // metres between sleepers
const CORRIDOR_SLEEPER_LENGTH = 2.5;  // metres, across the track

// One track: a pair of rails `gauge` apart, and the sleepers under them, laid along the centerline
// offset by `centerlineOffset` (the rail lane's own centre).
function renderCorridorRailLane(htrsPoints, centerlineOffset, gauge, options, layerGroup) {
    const railOffset = corridorRailGauge(gauge) / 2000; // half the gauge, mm -> m
    const renderer = corridorRailRenderer();
    const pane = options.pane || undefined;

    // Pre-compute segment directions.
    const segmentDirs = [];
    for (let i = 0; i < htrsPoints.length - 1; i++) {
        const dx = htrsPoints[i + 1][0] - htrsPoints[i][0];
        const dy = htrsPoints[i + 1][1] - htrsPoints[i][1];
        const length = Math.hypot(dx, dy);
        segmentDirs.push(length > 0.01 ? [dx / length, dy / length] : null);
    }

    const leftRailPoints = [];
    const rightRailPoints = [];
    for (let i = 0; i < htrsPoints.length; i++) {
        const point = htrsPoints[i];
        const previous = i > 0 ? segmentDirs[i - 1] : null;
        const next = i < segmentDirs.length ? segmentDirs[i] : null;

        let direction = next || previous;
        if (previous && next) {
            // Average the two directions so the rails turn a smooth corner.
            const dx = previous[0] + next[0];
            const dy = previous[1] + next[1];
            const length = Math.hypot(dx, dy);
            direction = length > 0.01 ? [dx / length, dy / length] : previous;
        }
        if (!direction) {
            const [lat, lng] = htrs96ToWGS84(point[0], point[1]);
            leftRailPoints.push(L.latLng(lat, lng));
            rightRailPoints.push(L.latLng(lat, lng));
            continue;
        }

        const perpendicular = [-direction[1], direction[0]];
        const trackCenter = [
            point[0] + perpendicular[0] * centerlineOffset,
            point[1] + perpendicular[1] * centerlineOffset
        ];
        const [leftLat, leftLng] = htrs96ToWGS84(
            trackCenter[0] + perpendicular[0] * railOffset,
            trackCenter[1] + perpendicular[1] * railOffset
        );
        const [rightLat, rightLng] = htrs96ToWGS84(
            trackCenter[0] - perpendicular[0] * railOffset,
            trackCenter[1] - perpendicular[1] * railOffset
        );
        leftRailPoints.push(L.latLng(leftLat, leftLng));
        rightRailPoints.push(L.latLng(rightLat, rightLng));
    }

    [leftRailPoints, rightRailPoints].forEach(railPoints => {
        L.polyline(railPoints, {
            pane, renderer, color: options.railColor, weight: 2, opacity: 0.9,
            interactive: false, className: 'corridor-rail'
        }).addTo(layerGroup);
    });

    // Every sleeper of this track becomes one polyline part of a single multi-polyline.
    const sleepers = [];
    for (let i = 0; i < htrsPoints.length - 1; i++) {
        const start = htrsPoints[i];
        const dx = htrsPoints[i + 1][0] - start[0];
        const dy = htrsPoints[i + 1][1] - start[1];
        const length = Math.hypot(dx, dy);
        if (length < 0.01) continue;
        const perpendicular = [-dy / length, dx / length];
        const count = Math.floor(length / CORRIDOR_SLEEPER_SPACING);

        for (let j = 0; j <= count; j++) {
            const t = j / Math.max(count, 1);
            const center = [
                start[0] + dx * t + perpendicular[0] * centerlineOffset,
                start[1] + dy * t + perpendicular[1] * centerlineOffset
            ];
            const half = CORRIDOR_SLEEPER_LENGTH / 2;
            const [startLat, startLng] = htrs96ToWGS84(
                center[0] + perpendicular[0] * half, center[1] + perpendicular[1] * half
            );
            const [endLat, endLng] = htrs96ToWGS84(
                center[0] - perpendicular[0] * half, center[1] - perpendicular[1] * half
            );
            sleepers.push([L.latLng(startLat, startLng), L.latLng(endLat, endLng)]);
        }
    }
    if (sleepers.length) {
        L.polyline(sleepers, {
            pane, renderer, color: options.sleeperColor, weight: 1, opacity: 0.7,
            interactive: false, className: 'corridor-sleepers'
        }).addTo(layerGroup);
    }
}

// Every track of a corridor: one per RAIL LANE of its cross-section, at that lane's gauge, on that
// lane's centre. A corridor with no rail lane has no rails — which is the whole rule.
function renderCorridorRails(centerlines, profile, group, options = {}) {
    if (typeof wgs84ToHTRS96 !== 'function' || typeof corridorStripSpans !== 'function') return;
    const railLanes = corridorStripSpans(profile).filter(strip => strip.type === 'rail');
    if (!railLanes.length) return;

    const railOptions = {
        pane: options.pane,
        railColor: options.railColor || '#333333',
        sleeperColor: options.sleeperColor || '#8B4513'
    };
    (centerlines || []).forEach(centerline => {
        if (!Array.isArray(centerline) || centerline.length < 2) return;
        const htrsPoints = centerline.map(point => wgs84ToHTRS96(point.lat, point.lng));
        railLanes.forEach(lane => {
            renderCorridorRailLane(htrsPoints, (lane.left + lane.right) / 2, lane.gauge, railOptions, group);
        });
    });
}

// Parking bay markings: the edge line where the lane meets the carriageway, and one divider per bay.
// Many short lines per lane, so they share the rail canvas renderer rather than becoming SVG paths.
function renderCorridorParkingBays(bays, group, pane) {
    if (!Array.isArray(bays) || !bays.length || typeof L === 'undefined') return;
    const renderer = corridorRailRenderer();
    bays.forEach(bay => {
        const isEdge = bay.kind === 'edge';
        L.polyline(bay.line, {
            pane: pane || undefined,
            renderer,
            color: '#f4f4f4',
            weight: isEdge ? 1.5 : 1,
            opacity: isEdge ? 0.85 : 0.7,
            interactive: false,
            className: `corridor-parking-marking corridor-parking-marking--${bay.kind}`
        }).addTo(group);
    });
}

// Direction arrows: one white filled convex ring per arrow piece (head triangle + stem rectangle),
// painted down each motor-vehicle lane in its direction of travel.
function renderCorridorDirectionArrows(arrows, group, pane) {
    if (!Array.isArray(arrows) || !arrows.length || typeof L === 'undefined') return;
    arrows.forEach(ring => {
        L.polygon(ring, {
            pane: pane || undefined,
            color: '#f4f4f4',
            weight: 0,
            fillColor: '#f4f4f4',
            fillOpacity: 0.9,
            interactive: false,
            className: 'corridor-direction-arrow'
        }).addTo(group);
    });
}

// Turn `[{type, polygons}]` into a LayerGroup. Surface, rails, markings, junction treatment and repeated
// symbols are layered in that order so junction asphalt suppresses through-lines and crossings stay on top.
// `centerlines` + `profile` are what the strips were built from; passing them lets the rail lanes among
// them lay their rails, so no caller can draw a cross-section and forget its track.
// A CSS-safe per-corridor class so a single corridor's strips can be targeted (e.g. hidden while the
// building-impact tour outlines just that road). Same sanitiser used on the render and the toggle
// sides, so they always agree.
function corridorOwnerClass(id) {
    if (id === undefined || id === null || id === '') return null;
    return 'corridor-owner-' + String(id).replace(/[^a-zA-Z0-9_-]/g, '-');
}

function renderCorridorStrips(strips, options = {}) {
    if (!Array.isArray(strips) || !strips.length) return null;
    const group = L.layerGroup();
    const fillOpacity = Number.isFinite(options.fillOpacity) ? options.fillOpacity : 0.85;
    const ownerClass = options.ownerClass ? ` ${options.ownerClass}` : '';

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
                className: `corridor-strip corridor-strip--${strip.type}${ownerClass}`
            }).addTo(group);
        });
    });

    if (options.centerlines && options.profile) {
        renderCorridorRails(options.centerlines, options.profile, group, {
            pane: options.pane,
            railColor: options.railColor,
            sleeperColor: options.sleeperColor
        });
        // Parking bays come with the cross-section, like rails: a parking lane in the profile paints its
        // bays right here, so drawn roads, applied roads and imported OSM streets all get them at once.
        if (typeof buildCorridorParkingBays === 'function') {
            renderCorridorParkingBays(buildCorridorParkingBays(options.centerlines, options.profile), group, options.pane);
        }
        if (typeof buildCorridorDirectionArrows === 'function') {
            renderCorridorDirectionArrows(buildCorridorDirectionArrows(options.centerlines, options.profile), group, options.pane);
        }
    }
    renderCorridorLaneMarkings(options.markings, group, options.pane);
    renderCorridorJunctions(options.junctions, group, options.pane);
    renderCorridorDecorations(options.decorations, group, options.pane);
    return group;
}

// ---------------------------------------------------------------------------
// Applied corridor proposals
//
// An applied corridor becomes a corridor parcel, which the parcel styler paints a single flat surface.
// Its cross-section is drawn over it, from the profile stored on the proposal. Every applied corridor
// comes through here — a track is a corridor whose cross-section happens to contain rail lanes, so it
// gets its strips, its rails, its hit targets and its 3D exactly as a road does.
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
    if (window.roadDrawingMode === true) {
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

// Applied road PROPOSALS get a hover outline (parcels do; roads only had click). Module-scoped so a
// mouseout on one hit target doesn't wipe the highlight of a corridor the cursor just moved onto.
let _appliedCorridorHoverKey = null;

function showAppliedCorridorHover(proposalKey, footprintFeature) {
    if (!footprintFeature || typeof highlightFeaturesForHover !== 'function') return;
    if (window.roadDrawingMode === true) return; // while drawing, a road is a surface, not a hover target
    if (_appliedCorridorHoverKey === proposalKey) return; // already shown for this corridor
    _appliedCorridorHoverKey = proposalKey;
    highlightFeaturesForHover([footprintFeature]);
}

function clearAppliedCorridorHover(proposalKey) {
    // A late mouseout must not wipe a corridor the cursor already moved onto.
    if (proposalKey != null && _appliedCorridorHoverKey !== proposalKey) return;
    _appliedCorridorHoverKey = null;
    if (typeof highlightFeaturesForHover === 'function') highlightFeaturesForHover([]);
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
    // The full corridor footprint, outlined on hover so an applied road reacts to the cursor.
    const footprint = definition && definition.polygon;
    let footprintFeature = null;
    if (footprint) {
        try {
            const geometry = footprint.type ? footprint : { type: 'Polygon', coordinates: footprint };
            footprintFeature = { type: 'Feature', properties: {}, geometry };
        } catch (_) { }
    }
    const attachHitBehaviour = (layer) => {
        layer.on('mouseover', () => showAppliedCorridorHover(proposalKey, footprintFeature));
        layer.on('mouseout', () => clearAppliedCorridorHover(proposalKey));
    };
    strips.forEach(strip => {
        (strip.polygons || []).forEach(polygon => {
            const hit = L.polygon(polygon, hitOptions)
                .on('click', event => { rememberSegment(null); forwardAppliedCorridorClick(proposal, event); });
            attachHitBehaviour(hit);
            hit.addTo(group);
        });
    });
    // The strips leave gaps (junction fills, verges, rounding); a hit target over the FULL
    // footprint keeps every click within the corridor on the corridor, instead of falling
    // through to the parcel underneath.
    if (footprint) {
        try {
            const geometry = footprint.type ? footprint : { type: 'Polygon', coordinates: footprint };
            // interactive/bubbling are LAYER options, not styles — passed at the geoJSON level so
            // the created polygons inherit them (bubbling must stay off or a click would reach
            // the map too and, while drawing, place a second point).
            const fp = L.geoJSON({ type: 'Feature', properties: {}, geometry }, {
                style: hitOptions,
                pane: CORRIDOR_HIT_PANE,
                interactive: true,
                bubblingMouseEvents: false
            }).on('click', event => { rememberSegment(null); forwardAppliedCorridorClick(proposal, event); });
            attachHitBehaviour(fp);
            fp.addTo(group);
        } catch (_) { }
    }
    // Per-segment hit polygons go on LAST (topmost in the pane), so a click inside a segment's
    // own footprint records that segment before the generic handlers would.
    if (Array.isArray(segmentEntries) && typeof calculateRoadPolygon === 'function') {
        segmentEntries.forEach(entry => {
            if (!entry.segmentId || !Array.isArray(entry.points) || entry.points.length < 2) return;
            const polygon = calculateRoadPolygon(entry.points, entry.width);
            if (!polygon) return;
            const hit = L.polygon(polygon, hitOptions)
                .on('click', event => { rememberSegment(entry.segmentId); forwardAppliedCorridorClick(proposal, event); });
            attachHitBehaviour(hit);
            hit.addTo(group);
        });
    }
}

function isAppliedCorridorProposal(proposal) {
    if (!proposal) return false;
    const definition = corridorProposalDefinition(proposal);
    if (!definition) return false;

    return isApplied(proposal, proposal.roadProposal);
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
        try {
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
        const ownerClass = corridorOwnerClass((typeof getProposalKey === 'function' ? getProposalKey(proposal) : null) || proposal.proposalId);
        entries.forEach(entry => {
            const strips = buildCorridorStrips([entry.points], entry.profile);
            const markings = (typeof buildCorridorLaneMarkings === 'function') ? buildCorridorLaneMarkings([entry.points], entry.profile) : [];
            // Trees are physical objects and stay; bike/pedestrian lane explainers are clutter on
            // the map — lane meaning lives in the cross-section editor.
            const decorations = ((typeof buildCorridorDecorations === 'function') ? buildCorridorDecorations([entry.points], entry.profile) : [])
                .filter(decoration => decoration.kind === 'tree');
            const segmentGroup = renderCorridorStrips(strips, {
                pane: CORRIDOR_STRIPS_PANE, markings, decorations, junctions: [], ownerClass,
                // A placed corridor's rails are black, like the asphalt it is laid in.
                centerlines: [entry.points], profile: entry.profile,
                railColor: '#000000', sleeperColor: '#666666'
            });
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
        const gradeSpans = (typeof gradeSeparationSpanRecords === 'function')
            ? gradeSeparationSpanRecords(definition.gradeSeparations || [])
            : [];
        entries.forEach(entry => {
            // A grade-separated span crosses in plan but is deliberately not a network junction.
            // Remove only those edges from the render-only centerlines fed to the cross-road
            // junction detector; the complete road remains visible in the strip layer above.
            const junctionRuns = gradeSpans.length && typeof corridorSurfaceRuns === 'function'
                ? corridorSurfaceRuns([entry.points], gradeSpans)
                : [entry.points];
            if (junctionRuns.length) renderedCorridors.push({
                centerline: junctionRuns,
                profile: entry.profile,
                corridorId
            });
        });
        drawn += 1;
        } catch (error) {
            // One corrupt road must not strip the asphalt off EVERY road on the map.
            console.error('[corridor-render] strips failed for proposal', proposal?.proposalId, error);
        }
    });

    // Where two applied roads meet (a drawing snapped onto an existing road shares its exact
    // coordinates), form a real intersection: the same asphalt + zebra treatment as a road's
    // own junctions, drawn once on top of both roads' markings.
    if (typeof buildCrossCorridorJunctionTreatments === 'function' && renderedCorridors.length >= 2) {
        const crossJunctions = buildCrossCorridorJunctionTreatments(renderedCorridors);
        if (crossJunctions.length) renderCorridorJunctions(crossJunctions, layer, CORRIDOR_STRIPS_PANE);
    }

    // Building passages hang off the definition rather than the cross-section, so they are a pass of
    // their own over every applied corridor — including ones whose strips failed to build.
    proposals.forEach(proposal => {
        const definition = corridorProposalDefinition(proposal);
        if (!definition) return;
        if (!isApplied(proposal, proposal.roadProposal)) return;
        const tunnels = Array.isArray(definition.tunnels) ? definition.tunnels : [];
        const gradeSeparations = Array.isArray(definition.gradeSeparations) ? definition.gradeSeparations : [];
        if (tunnels.length) renderCorridorBuildingTunnels(tunnels, layer, CORRIDOR_STRIPS_PANE);
        if (gradeSeparations.length) renderCorridorGradeSeparations(gradeSeparations, layer, CORRIDOR_STRIPS_PANE);
        if (tunnels.length || gradeSeparations.length) drawn += 1;
    });

    // Applied roads cut through parks/squares/lakes at render time — any corridor change
    // (apply, unapply, node drag, width edit) must re-cut them, including when the last
    // corridor disappears and the structures heal back to their full shape.
    try { if (typeof updateParksLayer === 'function') updateParksLayer(); } catch (_) { }
    try { if (typeof updateSquaresLayer === 'function') updateSquaresLayer(); } catch (_) { }
    try { if (typeof updateLakesLayer === 'function') updateLakesLayer(); } catch (_) { }
    // Same for the paved/green surround of a freeform building proposal, which is cut the same way.
    try { if (typeof window.updateBuildingGroundLayer === 'function') window.updateBuildingGroundLayer(); } catch (_) { }
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
    window.renderCorridorRails = renderCorridorRails;
    window.renderCorridorParkingBays = renderCorridorParkingBays;
    window.renderCorridorDirectionArrows = renderCorridorDirectionArrows;
    window.renderCorridorBuildingTunnels = renderCorridorBuildingTunnels;
    window.renderCorridorGradeSeparations = renderCorridorGradeSeparations;
    window.isAppliedCorridorProposal = isAppliedCorridorProposal;
    window.setCorridorProfilePreview = setCorridorProfilePreview;
    window.clearCorridorProfilePreview = clearCorridorProfilePreview;
    window.corridorProposalDefinition = corridorProposalDefinition;
    window.refreshAppliedCorridorStrips = refreshAppliedCorridorStrips;
    window.scheduleCorridorStripRefresh = scheduleCorridorStripRefresh;
    window.clearAppliedCorridorStrips = clearAppliedCorridorStrips;
    window.CORRIDOR_STRIPS_PANE = CORRIDOR_STRIPS_PANE;
    window.corridorOwnerClass = corridorOwnerClass;

    // Drop the amber selected-segment highlight the moment the selection changes to anything else
    // (another road, a parcel/building, or nothing). renderSelectedCorridorSegmentHighlight already
    // clears itself when the remembered segment's proposal is no longer the selected one, so
    // re-running it on every selection change is all that is needed — without this the amber outline
    // survived deselecting the road because nothing re-invoked it.
    if (window.ProposalSelection?.subscribe) {
        window.ProposalSelection.subscribe(() => {
            try { renderSelectedCorridorSegmentHighlight(); } catch (_) { }
        });
    }
}
