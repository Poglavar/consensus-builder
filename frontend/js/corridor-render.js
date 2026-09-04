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

// Z-order between corridors is a property of the PANES, not of build order. The applied-corridor
// render is keyed and rebuilds one corridor at a time, so a strip drawn later must never cover a
// neighbour's junction patch or lane markings: strips (655) < junction patches (656) < lane
// markings (657) < rails (658) < hit targets (659). Proposal hover outlines and labels stay above
// at 660/670.
const CORRIDOR_STRIPS_PANE = 'corridorStripsPane';
const CORRIDOR_JUNCTIONS_PANE = 'corridorJunctionsPane';
const CORRIDOR_MARKINGS_PANE = 'corridorMarkingsPane';
const CORRIDOR_HIT_PANE = 'corridorHitPane';
const CORRIDOR_RAIL_PANE = 'corridorRailPane';
const CORRIDOR_CANVAS_PANES = new Set([
    CORRIDOR_STRIPS_PANE,
    CORRIDOR_JUNCTIONS_PANE,
    CORRIDOR_MARKINGS_PANE,
    CORRIDOR_RAIL_PANE
]);

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

function ensureCorridorJunctionsPane() {
    if (typeof map === 'undefined' || !map || typeof map.getPane !== 'function') return null;
    let pane = map.getPane(CORRIDOR_JUNCTIONS_PANE);
    if (!pane && typeof map.createPane === 'function') pane = map.createPane(CORRIDOR_JUNCTIONS_PANE);
    if (pane && pane.style) {
        pane.style.zIndex = '656'; // asphalt patches over every corridor's strips, whichever was drawn last
        pane.style.pointerEvents = 'none';
    }
    return pane;
}

function ensureCorridorMarkingsPane() {
    if (typeof map === 'undefined' || !map || typeof map.getPane !== 'function') return null;
    let pane = map.getPane(CORRIDOR_MARKINGS_PANE);
    if (!pane && typeof map.createPane === 'function') pane = map.createPane(CORRIDOR_MARKINGS_PANE);
    if (pane && pane.style) {
        pane.style.zIndex = '657'; // through lanes read across every junction patch, own or shared
        pane.style.pointerEvents = 'none';
    }
    return pane;
}

function ensureCorridorHitPane() {
    if (typeof map === 'undefined' || !map || typeof map.getPane !== 'function') return null;
    let pane = map.getPane(CORRIDOR_HIT_PANE);
    if (!pane && typeof map.createPane === 'function') pane = map.createPane(CORRIDOR_HIT_PANE);
    if (pane && pane.style) {
        pane.style.zIndex = '659'; // above every visual corridor pane; transparent paths only
        pane.style.pointerEvents = 'auto';
    }
    return pane;
}

// White lane-marking lines drawn on top of the surface — dashed everywhere, with the centerline
// slightly heavier and longer-dashed so the flow divide still reads. Same weights/patterns for a
// drawn road, an applied one and an OSM street, so they read alike.
// One canvas per corridor pane, instead of one SVG <path> per lane marking, kerb, crosswalk stripe
// and hit area.
//
// Measured on a real session: 9,702 paths in corridorStripsPane and 2,151 in corridorHitPane — 94%
// of everything left in the SVG once parcels moved to canvas, and the reason a drag still stuttered.
// Nothing here needs a DOM element: the classNames on these shapes are labels, not selectors (only
// .corridor-decoration is styled, and decorations are divIcon markers, which canvas does not touch),
// and dashArray works on canvas exactly as it does in SVG.
//
// Per pane rather than one shared: a canvas renderer lives IN a pane, and the panes exist to keep
// strips, rails and hit areas in a fixed z-order.
const _corridorCanvasByPane = new Map();
function corridorCanvasFor(pane) {
    // A missing or interactive pane must fail visibly. Falling back to overlayPane creates a
    // full-viewport canvas above the parcel canvas; even with interactive:false paths, that DOM
    // element catches the click before the parcel renderer can see it.
    if (!CORRIDOR_CANVAS_PANES.has(pane)) {
        throw new Error(`Corridor canvas requires a non-interactive corridor pane; received ${String(pane)}.`);
    }
    if (!_corridorCanvasByPane.has(pane)) {
        _corridorCanvasByPane.set(pane, (typeof L !== 'undefined' && typeof L.canvas === 'function')
            ? L.canvas({ pane, padding: 0.5 })
            : undefined);
    }
    return _corridorCanvasByPane.get(pane);
}

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
                renderer: corridorCanvasFor(pane),
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
                renderer: corridorCanvasFor(pane),
                className: 'corridor-junction-surface'
            }).addTo(group);
        });
        (junction.crosswalkPolygons || []).forEach(polygon => {
            L.polygon(polygon, {
                color: '#ffffff', weight: 0, fillColor: '#ffffff', fillOpacity: 0.92,
                interactive: false, pane: pane || undefined,
                renderer: corridorCanvasFor(pane),
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
            renderer: corridorCanvasFor(pane),
            className: 'corridor-building-tunnel'
        }).addTo(group);
        points.forEach(point => L.circleMarker(point, {
            radius: 5, color: '#8b5cf6', weight: 2, fillColor: '#15121f', fillOpacity: 1,
            interactive: false, pane: pane || undefined,
            renderer: corridorCanvasFor(pane),
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
        // The structure is drawn as a real strip of the road's width, not as a fat polyline.
        // `weight` is PIXELS while record.width is METRES, so the old `weight: record.width` was
        // both wrong at every zoom (a 19 m deck drawn 19 px wide, never rescaling — there is no
        // zoomend re-render here) and round-capped, which bulged it past the ramp ends. A polygon
        // is in geographic coordinates, so it scales with the map for free and ends square.
        const width = Number(record.width);
        const deck = (typeof calculateRoadPolygon === 'function' && Number.isFinite(width) && width > 0)
            ? calculateRoadPolygon([record.from, record.crossing, record.to], width)
            : null;
        if (!deck) {
            console.warn('[corridor] grade separation has no usable width; skipping deck', record.mode, record.width);
        } else {
            L.polygon(deck, {
                color,
                weight: 1.5,
                opacity: 0.92,
                fillColor: color,
                fillOpacity: 0.35,
                dashArray: isOverpass ? null : '8 7',
                interactive: false,
                pane: pane || undefined,
                renderer: corridorCanvasFor(pane),
                className: `corridor-grade-separation corridor-grade-separation--${record.mode}`
            }).addTo(group);
        }
        [record.from, record.to].forEach(point => L.circleMarker(point, {
            radius: 4.5,
            color,
            weight: 2,
            fillColor: '#ffffff',
            fillOpacity: 1,
            interactive: false,
            pane: pane || undefined,
            renderer: corridorCanvasFor(pane),
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
// Rails and sleepers are drawn on a CANVAS while the ballast under them is an SVG polygon. Those are
// two different DOM containers, so adding the rails to the layer group after the strips does not put
// them on top — only the pane's z-index does. They shared the strips pane, which left the rails
// underneath the ballast: invisible once the ballast is opaque, and a washed-out grey rather than
// black while it was not. So the rail canvas gets its own pane, one above the strips.
function ensureCorridorRailPane() {
    if (typeof map === 'undefined' || !map || typeof map.getPane !== 'function') return null;
    let pane = map.getPane(CORRIDOR_RAIL_PANE);
    if (!pane && typeof map.createPane === 'function') pane = map.createPane(CORRIDOR_RAIL_PANE);
    if (pane && pane.style) {
        // Above the strips (655), junction patches (656) and lane markings (657), below the
        // transparent hit layer (659) and the proposal hover outlines and labels (660/670). Never
        // interactive, so it cannot steal a click from the hit layer above it.
        pane.style.zIndex = '658';
        pane.style.pointerEvents = 'none';
    }
    return pane;
}

function corridorRailRenderer() {
    if (!corridorRailCanvasRenderer && typeof L !== 'undefined' && L.canvas) {
        const pane = ensureCorridorRailPane();
        if (!pane) return undefined;
        corridorRailCanvasRenderer = L.canvas({ padding: 0.5, pane: CORRIDOR_RAIL_PANE });
    }
    return corridorRailCanvasRenderer;
}

const CORRIDOR_SLEEPER_SPACING = 0.6; // metres between sleepers
const CORRIDOR_SLEEPER_LENGTH = 2.5;  // metres, across the track
// Screen pixels, not metres: these are drawn as lines rather than as scale bodies. The rail must
// stay the heavier of the two — that difference is what distinguishes them once both are black.
const CORRIDOR_RAIL_WEIGHT = 2.6;
const CORRIDOR_SLEEPER_WEIGHT = 1.1;

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

    // The rail is the heavier of the two lines and the sleeper the lighter one, so the pair stays
    // readable once both are the same colour — on ballast, weight is what separates them.
    [leftRailPoints, rightRailPoints].forEach(railPoints => {
        L.polyline(railPoints, {
            pane, renderer, color: options.railColor, weight: CORRIDOR_RAIL_WEIGHT, opacity: 1,
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
            pane, renderer, color: options.sleeperColor, weight: CORRIDOR_SLEEPER_WEIGHT, opacity: 0.95,
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
            renderer: corridorCanvasFor(pane),
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
        // The colour is the lane's, unless the lane carries a paving that overrides it (a stone
        // footway). corridorStripSurface owns that rule so 2D and 3D cannot disagree about it.
        const surface = (typeof corridorStripSurface === 'function')
            ? corridorStripSurface(strip)
            : (((typeof CORRIDOR_LANE_TYPES !== 'undefined' && CORRIDOR_LANE_TYPES[strip.type]) || {}).surface || '#2b2b2b');
        const paving = (typeof corridorPavingOf === 'function') ? corridorPavingOf(strip) : null;
        // The stone pattern itself is CSS (an SVG pattern fill); at map zooms it is texture, not
        // information, so the colour above has to carry the difference on its own.
        const pavingClass = paving === 'paved' ? ' corridor-strip--paved' : '';
        // Ordinary surfaces go on the pane's canvas; the two that are painted with an SVG PATTERN
        // stay in the SVG, because a canvas has no <defs> to point at. That distinction is not
        // cosmetic for rail: .corridor-strip--rail's ballast pattern REPLACES the lane's surface
        // colour (see corridor-render.css), so drawing it on canvas would not merely drop a texture,
        // it would show a colour chosen on the assumption that something covers it. Paved footways
        // keep their stone for the same reason, at far smaller cost — between them these are a small
        // minority of strips, and the asphalt that makes up the rest is what moves.
        const usesSvgPattern = paving === 'paved' || strip.type === 'rail';
        strip.polygons.forEach(polygon => {
            L.polygon(polygon, {
                color: surface,
                weight: 0.5,
                fillColor: surface,
                fillOpacity,
                interactive: false,
                pane: options.pane || undefined,
                renderer: usesSvgPattern ? undefined : corridorCanvasFor(options.pane),
                className: `corridor-strip corridor-strip--${strip.type}${pavingClass}${ownerClass}`
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

// Applied-corridor render state, keyed by corridor. `byId` holds one entry per applied corridor:
// its Leaflet group (strips, edge fill, own junction patches, lane markings, tunnels, hit targets),
// the hash of the inputs it was drawn from, its bbox and the centerline runs the cross-corridor
// junction finder needs. `crossJunctions` holds one group per treatment between corridors, keyed
// by the sorted ids it joins plus its position. A refresh rebuilds only what the hashes say
// changed: one road edit is one corridor's strips plus the junctions it takes part in, not the
// whole town (~640 ms on the Šibenik plan when every refresh rebuilt all 127 corridors).
const corridorRenderState = { root: null, byId: new Map(), crossJunctions: new Map() };
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
    // A plain click selects the ROAD (one crisp footprint outline); the amber segment paint only
    // means something while the cross-section editor is open scoped to that segment — otherwise
    // "hover shows the whole road, click highlights a segment" reads as two different objects.
    // (try/catch: corridorEditorState is a top-level `let` in a later-loading script — TDZ.)
    let editor = null;
    try { editor = corridorEditorState; } catch (_) { editor = null; }
    if (!editor || editor.scope !== 'segment'
        || String(editor.proposalKey || '') !== String(clicked.proposalKey)
        || String(editor.segmentId || '') !== String(clicked.segmentId)) return;
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
    return proposal?.roadProposal?.definition || null;
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
    // (that is how connectors reach existing roads and merge), never a selection. An editing mode
    // holding the map wants the same forwarding: this hit target keeps bubblingMouseEvents off, so
    // without re-firing, the editor's own map handler would never see a click over a road.
    if (window.roadDrawingMode === true || window.__mapEditLock?.isHeld()) {
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
    // The drill resolves the whole stack at the point (an overlay may stand above the corridor)
    // and shows the chain; without it, select the road itself.
    let drillHandled = false;
    try {
        if (window.__drillUi && event && event.latlng) {
            drillHandled = window.__drillUi.handleSurfaceClick(event.latlng) === true;
        }
    } catch (_) { }
    if (drillHandled) return;
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
    // The drill owns hover when active: it draws the TOPMOST claim at the cursor, which may be
    // an overlay standing on the corridor rather than the corridor itself.
    if (window.__drillUi && typeof window.__drillUi.ownsHover === 'function' && window.__drillUi.ownsHover()) return;
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
        // SVG, deliberately — do NOT move these to canvas, however many paths they cost.
        //
        // These were canvas for exactly one afternoon, on the reasoning that an invisible layer
        // gains nothing from a DOM element. It gains the only thing that matters here: SHAPE. An
        // SVG path receives pointer events where the path IS, and a click anywhere else falls
        // through to the parcels below. A <canvas> is one element covering the whole viewport, and
        // this pane is pointer-events:auto at z-index 656 — far above the parcels at 400. So the
        // canvas received every click on the map, Leaflet hit-tested only the layers in that one
        // renderer, and every miss was swallowed instead of reaching the parcel underneath.
        //
        // The symptom was precise and awful: clicking worked all through a reload and stopped the
        // instant it finished, because a Leaflet renderer only creates its <canvas> when its first
        // layer is added — which is the corridor-strips phase at the very end of the rebuild.
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
        // bubblingMouseEvents is off (a bubbled click would re-fire on the map), which also
        // starves the map of mousemove while the cursor is INSIDE the corridor — so the drill
        // hover only ever fired on the border. Forward moves to it explicitly.
        layer.on('mousemove', event => {
            try { window.__drillUi?.notifyHover?.(event); } catch (_) { }
        });
    };
    // NO per-strip hit targets. There used to be one per lane polygon — ~2,000 SVG paths across a
    // plan of 132 corridors, and mapLoad measured them as the bulk of everything left in the SVG
    // after the parcels moved to canvas. They carried EXACTLY the footprint target's handlers
    // (rememberSegment(null) + the same forward + the same hover), and the footprint target below
    // covers at least their ground — it exists because the strips leave gaps. Redundant area,
    // one-sixth of it, at fifteen paths a corridor. Only the per-SEGMENT targets further down are
    // behaviourally distinct (they remember WHICH segment), and they stay.
    //
    // A hit target over the FULL footprint keeps every click within the corridor on the corridor,
    // instead of falling through to the parcel underneath.
    if (footprint) {
        try {
            const geometry = footprint.type ? footprint : { type: 'Polygon', coordinates: footprint };
            // interactive/bubbling are LAYER options, not styles — passed at the geoJSON level so
            // the created polygons inherit them (bubbling must stay off or a click would reach
            // the map too and, while drawing, place a second point).
            const fp = L.geoJSON({ type: 'Feature', properties: {}, geometry }, {
                style: hitOptions,
                pane: CORRIDOR_HIT_PANE,
                // SVG for the same reason as the options above: a canvas here eats every click
                // that misses a hit target, and most clicks on a map miss.
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
    const state = corridorRenderState;
    if (state.root && typeof map !== 'undefined' && map && map.hasLayer(state.root)) {
        map.removeLayer(state.root);
    }
    state.root = null;
    state.byId.clear();
    state.crossJunctions.clear();
    _appliedCorridorHoverKey = null;
}

// The filled footway of one corridor, as Leaflet polygons. Derived by the one shared builder
// (corridor-edge-fill-scene.js), so the map cannot disagree with the editor's preview or with 3D.
function renderCorridorEdgeFill(definition, group, ownerClass) {
    if (!definition || !group || !window.CorridorEdgeFill || typeof L === 'undefined') return;
    let regions = [];
    try { regions = window.CorridorEdgeFill.regionsFor(definition) || []; } catch (error) {
        console.warn('[corridor-render] edge fill could not be derived', error);
        return;
    }
    regions.forEach(region => {
        const lane = (typeof CORRIDOR_LANE_TYPES !== 'undefined' && CORRIDOR_LANE_TYPES[region.type]) || {};
        const surface = (typeof corridorStripSurface === 'function')
            ? corridorStripSurface({ type: region.type, paving: region.paving })
            : (lane.surface || '#c2beb4');
        const pavingClass = region.paving === 'paved' ? ' corridor-strip--paved' : '';
        L.geoJSON(region.geojson, {
            pane: CORRIDOR_STRIPS_PANE,
            interactive: false,
            style: {
                color: surface,
                weight: 0.5,
                fillColor: surface,
                fillOpacity: 0.85,
                className: `corridor-strip corridor-strip--${region.type}${pavingClass}${ownerClass ? ' ' + ownerClass : ''}`
            }
        }).addTo(group);
    });
}

// A refresh re-cuts the parks/squares/lakes and the building-ground surround against every applied
// corridor and rebuilds the 2D building layer, on top of the keyed strip work. One operation that
// touches several records (moving a junction moves every road that meets it) would otherwise pay
// that once per record. Hold the redraws for the length of the operation and do exactly one at the
// end. (Before the render was keyed, every refresh also rebuilt every corridor: ~640 ms on a
// town-sized plan, which is what made the hold indispensable.)
let corridorRefreshHeld = 0;
let corridorRefreshMissed = false;

async function withCorridorStripRefreshHeld(run) {
    corridorRefreshHeld += 1;
    try {
        return await run();
    } finally {
        corridorRefreshHeld -= 1;
        if (!corridorRefreshHeld && corridorRefreshMissed) {
            corridorRefreshMissed = false;
            scheduleCorridorStripRefresh();
        }
    }
}

function corridorKeyOf(proposal) {
    return String((typeof getProposalKey === 'function' ? getProposalKey(proposal) : null) || proposal.proposalId);
}

// Everything the drawing of one corridor depends on. Being applied is implicit (only applied
// corridors are listed); the cross-section editor's live preview counts for the corridor it
// previews, so a keystroke rebuilds that one corridor and clearing the preview rebuilds it once.
function corridorRenderHash(proposal, definition, preview) {
    const key = corridorKeyOf(proposal);
    const previewPart = preview && String(preview.proposalKey) === key ? [preview.profile, preview.segmentId] : null;
    return JSON.stringify([definition, corridorOwnerClass(key), previewPart]);
}

// Pure: which keyed entries to drop and which corridors to (re)build, from the hashes drawn last
// time and the hashes of the corridors applied now.
function corridorRenderDiff(previousHashes, applied) {
    const next = new Map(applied.map(entry => [entry.id, entry.hash]));
    const removed = Array.from(previousHashes.keys()).filter(id => !next.has(id));
    const changed = applied.filter(entry => previousHashes.get(entry.id) !== entry.hash).map(entry => entry.id);
    return { removed, changed };
}

function corridorBboxIntersects(a, b, pad = 0) {
    return !!a && !!b
        && a[0] <= b[2] + pad && a[2] + pad >= b[0]
        && a[1] <= b[3] + pad && a[3] + pad >= b[1];
}

// [west, south, east, north] of a corridor's centerline entries and footprint, or null.
function corridorRenderBbox(definition, entries) {
    let west = Infinity; let south = Infinity; let east = -Infinity; let north = -Infinity;
    const take = (lat, lng) => {
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
        west = Math.min(west, lng); east = Math.max(east, lng);
        south = Math.min(south, lat); north = Math.max(north, lat);
    };
    (entries || []).forEach(entry => (entry.points || []).forEach(point => take(Number(point.lat), Number(point.lng))));
    const polygon = definition && definition.polygon;
    const rings = !polygon ? [] : (polygon.type === 'Polygon' ? polygon.coordinates : (Array.isArray(polygon) ? polygon : []));
    (rings || []).forEach(ring => (Array.isArray(ring) ? ring : []).forEach(coordinate => {
        if (Array.isArray(coordinate)) take(Number(coordinate[1]), Number(coordinate[0]));
    }));
    return west === Infinity ? null : [west, south, east, north];
}

// One corridor's complete drawing: strips per segment, edge fill, its own junction patches, lane
// markings, tunnels and grade separations, and the hit targets — all in one group, so the corridor
// can leave and return as a unit. Never throws: one corrupt road must not strip the asphalt off
// every road on the map, so a failure is logged and the corridor keeps an (empty) entry until its
// definition changes.
function buildCorridorRender(proposal) {
    const definition = corridorProposalDefinition(proposal);
    const corridorId = corridorKeyOf(proposal);
    const group = L.layerGroup();
    const entry = { id: corridorId, group, renderedCorridors: [], bbox: null, strips: 0, drawn: false };
    try {
        const fallbackProfile = corridorProfileForRender(proposal, definition);
        const centerline = corridorCenterlineOf(definition);
        // Per-segment cross-sections: each segment renders with ITS profile; junction patches
        // (sized per arm) then cover the seams where different widths meet.
        const entries = (fallbackProfile && centerline.length)
            ? corridorRenderEntries(proposal, definition)
                .filter(candidate => Array.isArray(candidate.points) && candidate.points.length >= 2)
                .map(candidate => ({
                    ...(candidate.profile ? candidate : { ...candidate, profile: fallbackProfile }),
                    corridorId
                }))
            : [];
        entry.bbox = corridorRenderBbox(definition, entries);
        if (entries.length) {
            const markingsByEntry = (typeof buildCorridorLaneMarkingsForEntries === 'function')
                ? buildCorridorLaneMarkingsForEntries(entries)
                : entries.map(candidate => buildCorridorLaneMarkings([candidate.points], candidate.profile));
            const allStrips = [];
            const markings = [];
            const ownerClass = corridorOwnerClass(corridorId);
            entries.forEach((candidate, entryIndex) => {
                const strips = buildCorridorStrips([candidate.points], candidate.profile);
                // Trees are physical objects and stay; bike/pedestrian lane explainers are clutter
                // on the map — lane meaning lives in the cross-section editor.
                const decorations = ((typeof buildCorridorDecorations === 'function') ? buildCorridorDecorations([candidate.points], candidate.profile) : [])
                    .filter(decoration => decoration.kind === 'tree');
                const segmentGroup = renderCorridorStrips(strips, {
                    pane: CORRIDOR_STRIPS_PANE, markings: [], decorations, junctions: [], ownerClass,
                    // A placed corridor's rails and sleepers are both black, read against the
                    // ballast texture under them rather than against each other's colour.
                    centerlines: [candidate.points], profile: candidate.profile,
                    railColor: '#000000', sleeperColor: '#000000'
                });
                if (segmentGroup) {
                    segmentGroup.addTo(group);
                    allStrips.push(...strips);
                    markings.push(...(markingsByEntry[entryIndex] || []));
                }
            });
            if (allStrips.length) {
                // The pavement where the footway fills out to the frontage, in the lane's own
                // surface — so the 2D map shows the same road width the 3D model and photo view do,
                // rather than the drawn minimum. Over the strips, under the junction patches' pane.
                renderCorridorEdgeFill(definition, group, ownerClass);
                const junctions = (typeof buildCorridorJunctionTreatmentsForEntries === 'function')
                    ? buildCorridorJunctionTreatmentsForEntries(entries)
                    : [];
                if (junctions.length) renderCorridorJunctions(junctions, group, CORRIDOR_JUNCTIONS_PANE);
                // Through lanes are most important in the conflict area: their pane sits above
                // every junction patch, own or shared, so the crossroads never erase them.
                renderCorridorLaneMarkings(markings, group, CORRIDOR_MARKINGS_PANE);
                renderAppliedCorridorHitTargets(allStrips, proposal, group, definition, entries);
                const gradeSpans = (typeof gradeSeparationSpanRecords === 'function')
                    ? gradeSeparationSpanRecords(definition.gradeSeparations || [])
                    : [];
                entries.forEach(candidate => {
                    // A grade-separated span crosses in plan but is deliberately not a network
                    // junction. Remove only those edges from the render-only centerlines fed to
                    // the cross-road junction detector; the complete road stays visible above.
                    const junctionRuns = gradeSpans.length && typeof corridorSurfaceRuns === 'function'
                        ? corridorSurfaceRuns([candidate.points], gradeSpans)
                        : [candidate.points];
                    if (junctionRuns.length) entry.renderedCorridors.push({
                        centerline: junctionRuns,
                        profile: candidate.profile,
                        corridorId
                    });
                });
                entry.strips = allStrips.length;
            }
        }
        // Building passages and grade separations hang off the definition rather than the
        // cross-section, so they draw even for a corridor whose strips could not be built.
        const tunnels = Array.isArray(definition.tunnels) ? definition.tunnels : [];
        const gradeSeparations = Array.isArray(definition.gradeSeparations) ? definition.gradeSeparations : [];
        if (tunnels.length) renderCorridorBuildingTunnels(tunnels, group, CORRIDOR_STRIPS_PANE);
        if (gradeSeparations.length) renderCorridorGradeSeparations(gradeSeparations, group, CORRIDOR_STRIPS_PANE);
        entry.drawn = entry.strips > 0 || tunnels.length > 0 || gradeSeparations.length > 0;
    } catch (error) {
        console.error('[corridor-render] strips failed for proposal', proposal?.proposalId, error);
    }
    return entry;
}

function dropCorridorRender(id) {
    const state = corridorRenderState;
    const entry = state.byId.get(id);
    if (!entry) return;
    if (state.root && state.root.hasLayer(entry.group)) state.root.removeLayer(entry.group);
    state.byId.delete(id);
    // The hover latch remembers the corridor under the cursor; its hit targets are gone now.
    if (_appliedCorridorHoverKey === id) clearAppliedCorridorHover(id);
}

// Where two applied roads meet (a drawing snapped onto an existing road shares its exact
// coordinates), form a real intersection: the same asphalt + zebra treatment as a road's own
// junctions. Only treatments a changed or removed corridor takes part in are dropped and found
// again, over the corridors whose bboxes touch the changed ones; treatments between untouched
// neighbours stay as they are.
function refreshCrossCorridorJunctions(scopeIds) {
    const state = corridorRenderState;
    const scope = new Set(scopeIds.map(String));
    if (!scope.size) return;
    state.crossJunctions.forEach((group, key) => {
        const ids = key.slice(0, key.indexOf('@')).split('|');
        if (!ids.some(id => scope.has(id))) return;
        if (state.root && state.root.hasLayer(group)) state.root.removeLayer(group);
        state.crossJunctions.delete(key);
    });
    if (typeof buildCrossCorridorJunctionTreatments !== 'function') return;
    const scopedBoxes = Array.from(scope, id => state.byId.get(id)).filter(Boolean).map(entry => entry.bbox).filter(Boolean);
    if (!scopedBoxes.length) return;
    const PAD = 2e-5; // ~2 m in degrees, comfortably above the 0.75 m snap tolerance
    const candidates = Array.from(state.byId.values())
        .filter(entry => entry.renderedCorridors.length && entry.bbox && scopedBoxes.some(box => corridorBboxIntersects(box, entry.bbox, PAD)))
        .sort((left, right) => left.id.localeCompare(right.id));
    if (candidates.length < 2) return;
    const treatments = buildCrossCorridorJunctionTreatments(candidates.flatMap(entry => entry.renderedCorridors));
    treatments.forEach(treatment => {
        const ids = Array.isArray(treatment.corridorIds) ? treatment.corridorIds.map(String) : [];
        if (!ids.some(id => scope.has(id))) return;
        const key = `${ids.join('|')}@${Number(treatment.lat).toFixed(6)},${Number(treatment.lng).toFixed(6)}`;
        if (state.crossJunctions.has(key)) return;
        const group = L.layerGroup();
        renderCorridorJunctions([treatment], group, CORRIDOR_JUNCTIONS_PANE);
        state.root.addLayer(group);
        state.crossJunctions.set(key, group);
    });
}

function refreshAppliedCorridorStrips() {
    if (corridorRefreshHeld) {
        corridorRefreshMissed = true;
        return;
    }
    if (typeof map === 'undefined' || !map) return;
    if (typeof proposalStorage === 'undefined' || typeof proposalStorage.getAllProposals !== 'function') return;
    if (typeof buildCorridorStrips !== 'function') return;

    ensureCorridorStripsPane();
    ensureCorridorJunctionsPane();
    ensureCorridorMarkingsPane();
    const state = corridorRenderState;
    if (!state.root) state.root = L.layerGroup();
    if (!map.hasLayer(state.root)) state.root.addTo(map);

    const applied = proposalStorage.getAllProposals()
        .filter(isAppliedCorridorProposal)
        .map(proposal => ({
            proposal,
            id: corridorKeyOf(proposal),
            hash: corridorRenderHash(proposal, corridorProposalDefinition(proposal), corridorProfilePreview)
        }));
    const previousHashes = new Map(Array.from(state.byId.values(), entry => [entry.id, entry.hash]));
    const { removed, changed } = corridorRenderDiff(previousHashes, applied);
    const appliedById = new Map(applied.map(item => [item.id, item]));
    removed.forEach(id => dropCorridorRender(id));
    changed.forEach(id => {
        dropCorridorRender(id);
        const entry = buildCorridorRender(appliedById.get(id).proposal);
        entry.hash = appliedById.get(id).hash;
        state.byId.set(id, entry);
        state.root.addLayer(entry.group);
    });
    refreshCrossCorridorJunctions([...removed, ...changed]);

    if (removed.length || changed.length) {
        // Applied roads cut through parks/squares/lakes at render time — any corridor change
        // (apply, unapply, node drag, width edit) must re-cut them, including when the last
        // corridor disappears and the structures heal back to their full shape.
        try { if (typeof updateParksLayer === 'function') updateParksLayer(); } catch (_) { }
        try { if (typeof updateSquaresLayer === 'function') updateSquaresLayer(); } catch (_) { }
        try { if (typeof updateLakesLayer === 'function') updateLakesLayer(); } catch (_) { }
        // Same for the paved/green surround of a freeform building proposal, which is cut the same way.
        try { if (typeof window.updateBuildingGroundLayer === 'function') window.updateBuildingGroundLayer(); } catch (_) { }
    }
    renderSelectedCorridorSegmentHighlight();

    // Demolitions live on applied corridors: any corridor change can raze or restore buildings.
    // Not optional cosmetics — a failure here leaves razed buildings standing, so it must be loud.
    if ((removed.length || changed.length) && window.buildingFeaturePool?.length) {
        try {
            if (typeof window.refreshBuildingOutcomesFromRecords !== 'function') {
                throw new Error('map-core local building outcome refresher is unavailable');
            }
            window.refreshBuildingOutcomesFromRecords();
        } catch (error) {
            console.error('[corridor-render] local building demolition refresh failed — 2D building layer is stale', error);
        }
    }
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
    window.withCorridorStripRefreshHeld = withCorridorStripRefreshHeld;
    window.clearAppliedCorridorStrips = clearAppliedCorridorStrips;
    window.CORRIDOR_STRIPS_PANE = CORRIDOR_STRIPS_PANE;
    window.CORRIDOR_JUNCTIONS_PANE = CORRIDOR_JUNCTIONS_PANE;
    window.CORRIDOR_MARKINGS_PANE = CORRIDOR_MARKINGS_PANE;
    window.corridorOwnerClass = corridorOwnerClass;
    // Read-only inspection handle for probes and tests; nothing else may write through it.
    window.__corridorRenderState = corridorRenderState;

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

// The pure pieces of the keyed render, for node tests; the browser never sees this.
if (typeof module === 'object' && module.exports) {
    module.exports = { corridorRenderHash, corridorRenderDiff, corridorBboxIntersects, corridorRenderBbox, corridorOwnerClass };
}
