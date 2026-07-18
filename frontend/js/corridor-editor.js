// The cross-section editor: add, remove, resize, retype and reorder the lanes of a corridor — a road or
// a track, which differ only in the lanes they are made of (a track is a corridor with a rail lane in it).
//
// THE LANE LIST IS THE ROAD. The total width shown at the top is a READOUT — the sum of the lanes —
// not a control: you widen a street by giving it another lane, and narrow it by taking one away. There
// is no width slider, and adding a lane can never fail for want of room (the old model paid for every
// edit out of the traffic lanes, and once they hit their minimum "Add lane" silently did nothing).
// The one hard limit left is CORRIDOR_EDITOR_MAX_WIDTH, and hitting it says so.
//
// Dragging a seam in the schematic is the one gesture that keeps the total: it moves width from one
// lane to its neighbour, so the footprint does not budge.
//
// The presets row stamps a whole standard cross-section (the same road classes the drawing width
// picker offers), which is the fast path: take a correct section, then tweak it.
//
// For a placed road the resulting footprint is checked live: hitting a NEW building blocks Apply —
// tunnels are only made while drawing — while crossing an applied park/square/lake merely lights an
// indicator (the structure is cut at render time). A building this road already PARTIALLY demolished
// is different again: its remainder still stands, and widening into it is shown (amber, its own
// indicator) but does not block — the demolition was already consented, and Apply re-carves the cut
// at the new width (road-drawing's runLocalCorridorGeometryUpdate).
//
// Local unminted roads take the change in place (footprint + parcel cuts rebuild on Apply); minted
// proposals are immutable and reopen as a drawing draft instead.

let corridorEditorState = null;
let corridorEditorObstacleTimer = null;
// Red overlay of the buildings the CURRENT cross-section cuts into — the on-map counterpart of
// the "hits buildings" chip, repainted by every obstacle check while the editor is open.
let corridorEditorHitBuildingsLayer = null;
// The Corridor tab's map layers: the available-corridor halo, and the pinch tick with the
// obstacles that form it. Drawn only while that tab is active; removed on tab switch and close.
let corridorEditorHaloLayer = null;
let corridorEditorPinchLayer = null;
// The yellow probe tick a chart click drops on the map — "this point of the chart is HERE".
let corridorEditorChartProbeLayer = null;

const CORRIDOR_EDITOR_MAX_WIDTH = 80; // the widest drawing preset (Boulevard)
// How far a clearance ray reaches before a side counts as open, and how much of an open side
// the halo/chart display (an unbounded side is a floor, not a measurement).
const CORRIDOR_CLEARANCE_MAX = 100;
const CORRIDOR_CLEARANCE_DISPLAY_CAP = 30;

function corridorEditorI18n(key, fallback, params = {}) {
    try {
        if (window.i18n && typeof window.i18n.t === 'function') {
            const translated = window.i18n.t(key, params);
            if (translated && translated !== key) return translated;
        }
    } catch (_) { }
    // The fallback carries the same placeholders as the translation, so it interpolates too.
    return String(fallback).replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name) => (
        Object.prototype.hasOwnProperty.call(params, name) ? params[name] : match
    ));
}

// The derived total, as text. Two decimals, trailing zeros dropped: lanes step in 25 cm, and rounding
// 27.25 m to "27.3 m" would show a total that is not the sum of the numbers printed underneath it.
function corridorEditorTotalText(width) {
    return `${Number(Number(width).toFixed(2))} m`;
}

// CORRIDOR_LANE_TYPES carries an English label because the model is shared with the 3D renderers;
// anything the editor shows to a user goes through here so it is translated.
function corridorLaneTypeLabel(type) {
    const laneType = CORRIDOR_LANE_TYPES[type] || {};
    return corridorEditorI18n(`modal.corridor.laneTypes.${type}`, laneType.label || type);
}

function corridorEditorClose() {
    if (typeof clearCorridorProfilePreview === 'function') clearCorridorProfilePreview();
    corridorEditorRenderBuildingHits([]);
    corridorEditorClearClearanceOverlays();
    corridorEditorRestoreBuildingFootprints();
    document.body.classList.remove('corridor-editor-open');
    const overlay = document.getElementById('corridor-editor-overlay');
    if (overlay) overlay.remove();
    document.removeEventListener('keydown', corridorEditorKeydown);
    if (corridorEditorObstacleTimer) {
        clearTimeout(corridorEditorObstacleTimer);
        corridorEditorObstacleTimer = null;
    }
    corridorEditorState = null;
}

function corridorEditorCancel() {
    if (corridorEditorState && corridorEditorState.mode === 'drawing' && corridorEditorState.originalProfile
        && typeof setRoadDrawingProfile === 'function') {
        setRoadDrawingProfile(corridorEditorState.originalProfile);
    }
    corridorEditorClose();
}

function corridorEditorKeydown(event) {
    if (event.key === 'Escape') {
        event.preventDefault();
        corridorEditorCancel();
    }
}

// Apply an edit, or refuse it. `edit` returns a new profile or null; null means the edit was meaningless
// (a lane below its minimum, the last lane, an unknown type) and the right answer is to say so.
//
// The only other refusal is the hard width cap: the total is the sum of the lanes, so a widening edit
// cannot fail on room — it can only run past the widest corridor the app will draw, and then it must SAY
// so. A silent no-op here is the exact bug this editor was rebuilt to remove.
function corridorEditorApply(edit) {
    if (!corridorEditorState) return;
    const next = edit(corridorEditorState.profile);
    if (!next) {
        // Redraw from the model so the refused number does not sit in the input pretending to be real.
        corridorEditorState.notice = null;
        corridorEditorRender();
        corridorEditorFlashRefusal();
        return;
    }
    if (corridorProfileWidth(next) > CORRIDOR_EDITOR_MAX_WIDTH + 1e-6) {
        corridorEditorState.notice = corridorEditorI18n(
            'modal.corridor.maxWidthReached',
            'A corridor cannot be wider than {{max}} m. Remove or narrow a lane first.',
            { max: CORRIDOR_EDITOR_MAX_WIDTH }
        );
        corridorEditorRender();
        corridorEditorFlashRefusal();
        return;
    }
    corridorEditorState.notice = null;
    corridorEditorState.profile = next;
    corridorEditorState.dirty = true;
    if (corridorEditorState.mode === 'drawing' && typeof setRoadDrawingProfile === 'function') {
        setRoadDrawingProfile(next);
    } else if (typeof setCorridorProfilePreview === 'function') {
        setCorridorProfilePreview(
            corridorEditorState.proposalKey,
            next,
            corridorEditorState.scope === 'segment' ? corridorEditorState.segmentId : null
        );
    }
    corridorEditorRender();
}

// The total lives in the header, which a render does not rebuild, so the class has to come off by
// itself — left on, it would dye the number permanently red after the first refusal.
function corridorEditorFlashRefusal() {
    const total = document.querySelector('.corridor-editor-total');
    if (!total) return;
    total.classList.remove('corridor-editor-total--refused');
    void total.offsetWidth; // restart the animation
    total.classList.add('corridor-editor-total--refused');
    total.addEventListener(
        'animationend',
        () => total.classList.remove('corridor-editor-total--refused'),
        { once: true }
    );
}

// Pure: how this road's own demolition records partition for width-hit detection. A record
// WITHOUT a remainder is a full demolition — nothing is standing, so a width change cannot hit
// it and it is excluded like a tunnelled building. A record WITH a remainder left the building
// standing: widening into that remainder is a real, reportable hit, but a RE-CUT of an already
// consented demolition, not a new obstacle — shown, never blocking.
function corridorEditorPartitionDemolitions(records) {
    const excluded = new Set();
    const recut = new Set();
    (records || []).forEach(record => {
        if (!record || record.id === undefined || record.id === null) return;
        (record.remainder ? recut : excluded).add(String(record.id));
    });
    return { excluded, recut };
}

// Everything the corridor's footprint would collide with at the given total width: buildings the
// road is not already tunnelled through (from the base map AND applied building proposals), and
// applied parks/squares/lakes. Checked per edge, like drawing-time segment validation. Hits on
// buildings this road already partially demolished carry `recut: true` (the detection pool holds
// their REMAINDER footprint, so the hit is against what is actually still standing).
// The centerline segments the editor is scoped to: the clicked segment when the edit is
// segment-scoped, otherwise every segment of the road network.
function corridorEditorScopedSegments() {
    const state = corridorEditorState;
    if (!state || !state.definition || typeof corridorCenterlineOf !== 'function') return [];
    let segments = corridorCenterlineOf(state.definition);
    if (state.scope === 'segment' && state.segmentId && Array.isArray(state.definition.segmentIds)) {
        segments = segments.filter((_, index) => String(state.definition.segmentIds[index] || '') === state.segmentId);
    }
    return segments;
}

function corridorEditorCollectWidthHits(width) {
    const result = { buildings: [], structures: [] };
    const state = corridorEditorState;
    if (!state || state.mode !== 'proposal' || !state.definition) return result;
    if (typeof calculateRoadPolygon !== 'function') return result;
    const segments = corridorEditorScopedSegments();
    const tunnelled = new Set();
    const tunnelEdgeKeys = new Set();
    (state.definition.tunnels || []).forEach(record => {
        (record?.buildingIds || []).forEach(id => tunnelled.add(String(id)));
        if (record?.edgeKey) tunnelEdgeKeys.add(record.edgeKey);
    });
    const demolitions = corridorEditorPartitionDemolitions(state.definition.demolishedBuildings);
    demolitions.excluded.forEach(id => tunnelled.add(id));
    const seenBuildings = new Set();
    const seenStructures = new Set();
    segments.forEach(segment => {
        for (let i = 0; i < segment.length - 1; i++) {
            // A tunnel edge is already underground: nothing under it can be newly "hit".
            if (typeof corridorTunnelEdgeKey === 'function'
                && tunnelEdgeKeys.has(corridorTunnelEdgeKey(segment[i], segment[i + 1]))) continue;
            const polygon = calculateRoadPolygon([segment[i], segment[i + 1]], width);
            if (!polygon) continue;
            if (typeof detectLoadedBuildingTunnelIntersections === 'function') {
                detectLoadedBuildingTunnelIntersections(polygon).forEach(hit => {
                    const id = String(hit.id);
                    if (tunnelled.has(id) || seenBuildings.has(id)) return;
                    seenBuildings.add(id);
                    result.buildings.push(demolitions.recut.has(id) ? { ...hit, recut: true } : hit);
                });
            }
            if (typeof detectStructureCrossings === 'function') {
                detectStructureCrossings(polygon).forEach(hit => {
                    if (seenStructures.has(hit.id)) return;
                    seenStructures.add(hit.id);
                    result.structures.push(hit);
                });
            }
        }
    });
    return result;
}

// Paint the hit buildings' footprints on the map, replacing the previous paint. A widening
// that starts cutting into a building shows exactly WHERE, live, while the seam is still being
// dragged — the chip alone said only that it happened. Red = a new building (blocks Apply);
// amber = re-cutting deeper into a building this road already partially demolished (allowed —
// what is painted is its still-standing remainder). Buildings the road tunnels through or fully
// demolished are not hits (corridorEditorCollectWidthHits excludes them).
function corridorEditorRenderBuildingHits(buildingHits) {
    if (typeof map === 'undefined' || !map || typeof L === 'undefined') return;
    if (corridorEditorHitBuildingsLayer) {
        try { map.removeLayer(corridorEditorHitBuildingsLayer); } catch (_) { }
        corridorEditorHitBuildingsLayer = null;
    }
    const features = (buildingHits || [])
        .map(hit => {
            const geometry = hit && ((hit.feature && hit.feature.geometry) || hit.originalGeometry);
            return geometry ? { type: 'Feature', properties: { recut: hit.recut === true }, geometry } : null;
        })
        .filter(Boolean);
    if (!features.length) return;
    if (typeof ensureCorridorStripsPane === 'function') ensureCorridorStripsPane();
    corridorEditorHitBuildingsLayer = L.geoJSON({ type: 'FeatureCollection', features }, {
        interactive: false,
        pane: (typeof CORRIDOR_STRIPS_PANE !== 'undefined') ? CORRIDOR_STRIPS_PANE : undefined,
        style: feature => (feature.properties.recut
            ? {
                color: '#9a5b13',
                weight: 2,
                fillColor: '#d97706',
                fillOpacity: 0.35,
                className: 'corridor-editor-building-hit corridor-editor-building-hit--recut'
            }
            : {
                color: '#b3261e',
                weight: 2,
                fillColor: '#dc2626',
                fillOpacity: 0.4,
                className: 'corridor-editor-building-hit'
            })
    }).addTo(map);
}

// The bounds of what is being edited: the scoped segment when the edit is segment-scoped,
// otherwise the whole road network.
function corridorEditorRoadBounds() {
    const state = corridorEditorState;
    if (!state || state.mode !== 'proposal' || !state.definition) return null;
    if (typeof L === 'undefined' || typeof corridorCenterlineOf !== 'function') return null;
    const segments = corridorEditorScopedSegments();
    const bounds = L.latLngBounds([]);
    segments.forEach(segment => (segment || []).forEach(point => bounds.extend(point)));
    return bounds.isValid() ? bounds : null;
}

// Pure: the fitBounds padding that keeps the road inside the viewport the docked panel leaves
// free. Which edge the panel occupies is read off its own rectangle — a full-viewport-wide panel
// is the bottom dock (mobile), anything narrower is the right dock — so this cannot drift from
// the CSS breakpoint.
function corridorEditorFitPadding(viewportWidth, panelRect, margin = 40) {
    const width = (panelRect && Number(panelRect.width)) || 0;
    const height = (panelRect && Number(panelRect.height)) || 0;
    const bottomDocked = width >= viewportWidth - 1;
    return bottomDocked
        ? { topLeft: [margin, margin], bottomRight: [margin, height + margin] }
        : { topLeft: [margin, margin], bottomRight: [width + margin, margin] };
}

// Focus the road being edited in the part of the screen the panel does not cover.
function corridorEditorFocusMap() {
    const bounds = corridorEditorRoadBounds();
    if (!bounds || typeof map === 'undefined' || !map || typeof map.fitBounds !== 'function') return;
    const panel = document.querySelector('.corridor-editor');
    const padding = corridorEditorFitPadding(
        window.innerWidth,
        panel ? panel.getBoundingClientRect() : null
    );
    map.fitBounds(bounds, {
        paddingTopLeft: L.point(padding.topLeft[0], padding.topLeft[1]),
        paddingBottomRight: L.point(padding.bottomRight[0], padding.bottomRight[1]),
        maxZoom: 18
    });
}

// The map beside the editor must show what a width change collides with, so the GDI footprint
// layer turns on for the session (restored on close if the user had it off) and the pool is
// fetched to cover the road — the red highlight and the Apply block both read that pool.
function corridorEditorShowBuildingFootprints() {
    const state = corridorEditorState;
    if (!state || state.mode !== 'proposal') return;
    const checkbox = document.getElementById('showBuildings');
    if (checkbox && !checkbox.checked) {
        checkbox.checked = true;
        state.restoreBuildingsCheckbox = true;
    }
    if (typeof window.rebuildBuildingLayerFromPool === 'function') {
        try { window.rebuildBuildingLayerFromPool(); } catch (_) { }
    }
    const bounds = corridorEditorRoadBounds();
    if (bounds && typeof window.ensureBuildingFootprintsForBounds === 'function') {
        window.ensureBuildingFootprintsForBounds(bounds)
            // The pool may have just filled: re-check so buildings already being cut turn red now,
            // and re-measure the corridor against the buildings that just arrived.
            .then(() => {
                corridorEditorScheduleObstacleCheck();
                const current = corridorEditorState;
                if (current && current.activeTab === 'corridor') {
                    current.clearanceCache = null;
                    corridorEditorRender();
                }
            })
            .catch(error => console.warn('[corridorEditor] building footprints could not be prepared', error));
    }
}

function corridorEditorRestoreBuildingFootprints() {
    if (!corridorEditorState || !corridorEditorState.restoreBuildingsCheckbox) return;
    const checkbox = document.getElementById('showBuildings');
    if (checkbox) checkbox.checked = false;
    if (typeof window.rebuildBuildingLayerFromPool === 'function') {
        try { window.rebuildBuildingLayerFromPool(); } catch (_) { }
    }
}

function corridorEditorUpdateIndicators(hits, blocked) {
    const buildingsChip = document.querySelector('.corridor-editor-indicator--buildings');
    if (buildingsChip) buildingsChip.hidden = !blocked;
    const recutChip = document.querySelector('.corridor-editor-indicator--recut');
    if (recutChip) recutChip.hidden = !(hits && hits.buildings.some(hit => hit.recut));
    const structuresChip = document.querySelector('.corridor-editor-indicator--structures');
    if (structuresChip) structuresChip.hidden = !(hits && hits.structures.length);
    // A blocked widening is exactly when moving the road might help — point at the Corridor
    // tab, where the fit computation and the move button live (hidden once already there).
    const fitChip = document.querySelector('.corridor-editor-indicator--fit');
    if (fitChip) {
        fitChip.hidden = !blocked || (corridorEditorState && corridorEditorState.activeTab === 'corridor');
    }
}

// Widening is blocked only when it hits a building the road did not already touch at its
// opening width — tunnels are made while drawing, never by widening a placed road. Re-cut
// hits (deepening this road's own consented partial demolition) never block.
function corridorEditorRunObstacleCheck() {
    const current = corridorEditorState;
    if (!current || current.mode !== 'proposal') return;
    if (!current.baselineBuildingHitIds) {
        const openingWidth = corridorProfileWidth(current.originalProfile || current.profile);
        current.baselineBuildingHitIds = new Set(
            corridorEditorCollectWidthHits(openingWidth).buildings.map(hit => String(hit.id))
        );
    }
    const hits = corridorEditorCollectWidthHits(corridorProfileWidth(current.profile));
    current.widthBlocked = hits.buildings.some(hit => !hit.recut && !current.baselineBuildingHitIds.has(String(hit.id)));
    corridorEditorRenderBuildingHits(hits.buildings);
    corridorEditorUpdateIndicators(hits, current.widthBlocked);
    const saveButton = document.querySelector('.corridor-editor-save');
    if (saveButton) saveButton.disabled = !current.dirty || current.widthBlocked;
}

// Debounced (the per-building intersection test is too heavy to run on every tick of a seam drag).
function corridorEditorScheduleObstacleCheck() {
    const state = corridorEditorState;
    if (!state || state.mode !== 'proposal') return;
    if (corridorEditorObstacleTimer) clearTimeout(corridorEditorObstacleTimer);
    corridorEditorObstacleTimer = setTimeout(() => {
        corridorEditorObstacleTimer = null;
        corridorEditorRunObstacleCheck();
    }, 150);
}

// ---------------------------------------------------------------------------
// Corridor tab
//
// The cross-section says what the road IS; this tab says what the road COULD BE here. One
// clearance sampling pass along the scoped centerline (corridor-clearance.js) feeds all of it:
// the corridor min width (the widest the road can be without demolishing anything), the width
// profile chart, the pinch point and the obstacles that form it, and the move-to-fit shift.
// Obstacles are the same building pool the width-hit check collides against, plus — behind a
// toggle — every parcel that is neither road-classified nor already crossed by this road.
// ---------------------------------------------------------------------------

function corridorEditorClearanceReady() {
    return typeof corridorClearanceSamples === 'function'
        && typeof corridorClearanceStats === 'function'
        && typeof wgs84ToHTRS96 === 'function';
}

function corridorEditorPlanarLength(pointsXY) {
    let total = 0;
    for (let i = 1; i < pointsXY.length; i += 1) {
        total += Math.hypot(pointsXY[i][0] - pointsXY[i - 1][0], pointsXY[i][1] - pointsXY[i - 1][1]);
    }
    return total;
}

// GeoJSON Polygon/MultiPolygon -> planar rings for the clearance sampler.
function corridorEditorGeometryToPlanarRings(geometry) {
    if (!geometry) return [];
    const rings = geometry.type === 'Polygon'
        ? geometry.coordinates
        : (geometry.type === 'MultiPolygon' ? geometry.coordinates.flat() : []);
    return (rings || [])
        .filter(ring => Array.isArray(ring) && ring.length >= 3)
        .map(ring => ring
            .map(pair => (Array.isArray(pair) ? wgs84ToHTRS96(pair[1], pair[0]) : null))
            .filter(xy => Array.isArray(xy) && Number.isFinite(xy[0]) && Number.isFinite(xy[1])))
        .filter(ring => ring.length >= 3);
}

// Everything a clearance ray may stop at: the loaded buildings (minus the ones this road
// tunnels through or fully demolished — the same exclusions the width-hit check makes), and in
// 'parcels' mode also every loaded parcel that is not road land and not already crossed by the
// road at its current width (land the road already takes is part of the deal, not a wall).
function corridorEditorClearanceObstacles() {
    const state = corridorEditorState;
    const obstacles = [];
    if (!state || !state.definition || !corridorEditorClearanceReady()) return obstacles;
    const bounds = corridorEditorRoadBounds();
    if (!bounds) return obstacles;

    // Rough lat/lng prefilter: a feature whose first coordinate is farther than the ray reach
    // (plus the largest footprint we expect) cannot influence any sample.
    const pad = CORRIDOR_CLEARANCE_MAX + 200;
    const latPad = pad / 111320;
    const lngPad = pad / (111320 * Math.cos(bounds.getCenter().lat * Math.PI / 180));
    const south = bounds.getSouth() - latPad;
    const north = bounds.getNorth() + latPad;
    const west = bounds.getWest() - lngPad;
    const east = bounds.getEast() + lngPad;
    const firstCoordinate = geometry => {
        const rings = geometry && (geometry.type === 'Polygon'
            ? geometry.coordinates
            : (geometry.type === 'MultiPolygon' ? geometry.coordinates.flat() : []));
        return rings && rings[0] && rings[0][0];
    };
    const nearRoad = geometry => {
        const coord = firstCoordinate(geometry);
        return Array.isArray(coord) && coord[1] >= south && coord[1] <= north && coord[0] >= west && coord[0] <= east;
    };

    const tunnelled = new Set();
    (state.definition.tunnels || []).forEach(record => {
        (record?.buildingIds || []).forEach(id => tunnelled.add(String(id)));
    });
    corridorEditorPartitionDemolitions(state.definition.demolishedBuildings).excluded
        .forEach(id => tunnelled.add(id));

    if (typeof collectLoadedCorridorBuildings === 'function' && typeof corridorBuildingKey === 'function') {
        collectLoadedCorridorBuildings().forEach(feature => {
            if (!feature || !feature.geometry || !nearRoad(feature.geometry)) return;
            const id = String(corridorBuildingKey(feature));
            if (tunnelled.has(id)) return;
            const rings = corridorEditorGeometryToPlanarRings(feature.geometry);
            if (rings.length) obstacles.push({ id, kind: 'building', rings });
        });
    }

    if (state.clearanceMode === 'parcels' && typeof parcelLayer !== 'undefined' && parcelLayer
        && typeof parcelLayer.eachLayer === 'function') {
        const edgeFeatures = corridorEditorCurrentEdgeFeatures();
        const crossed = feature => edgeFeatures.some(edge => {
            try { return window.turf && window.turf.booleanDisjoint(edge, feature) === false; } catch (_) { return false; }
        });
        parcelLayer.eachLayer(layer => {
            const feature = layer && layer.feature;
            if (!feature || !feature.geometry || !nearRoad(feature.geometry)) return;
            const props = feature.properties || {};
            const parcelId = (props.parcelId !== undefined && props.parcelId !== null) ? String(props.parcelId)
                : (props.id !== undefined && props.id !== null ? String(props.id) : null);
            const isRoad = props.isRoad === true || props.isRoad === 'true'
                || (parcelId && typeof isRoadParcel === 'function' && isRoadParcel(parcelId));
            if (isRoad || crossed(feature)) return;
            const rings = corridorEditorGeometryToPlanarRings(feature.geometry);
            if (rings.length) obstacles.push({ id: `parcel:${parcelId || 'unknown'}`, kind: 'parcel', rings });
        });
    }
    return obstacles;
}

// The scoped road's footprint at its PREVIEW width, one turf polygon per centerline edge —
// what "already crossed by the road" is tested against.
function corridorEditorCurrentEdgeFeatures() {
    const state = corridorEditorState;
    const features = [];
    if (!state || typeof calculateRoadPolygon !== 'function' || typeof corridorFeatureFromLatLngRing !== 'function') return features;
    const width = corridorProfileWidth(state.profile);
    corridorEditorScopedSegments().forEach(segment => {
        for (let i = 0; i < segment.length - 1; i += 1) {
            const ring = calculateRoadPolygon([segment[i], segment[i + 1]], width);
            const feature = ring ? corridorFeatureFromLatLngRing(ring) : null;
            if (feature) features.push(feature);
        }
    });
    return features;
}

// Sample (or reuse) the clearance for the current scope, constraint mode and geometry. The
// samples do not depend on the cross-section — only the derived stats do — so profile edits
// never invalidate this cache; a scope change, a constraint toggle, a building-pool fill or a
// baked shift does (each bumps/clears its part of the key).
function corridorEditorEnsureClearance() {
    const state = corridorEditorState;
    if (!state || state.mode !== 'proposal' || !corridorEditorClearanceReady()) return null;
    const key = [state.scope, state.segmentId || '', state.clearanceMode, state.geometryVersion || 0].join('|');
    if (state.clearanceCache && state.clearanceCache.key === key) return state.clearanceCache;

    const obstacles = corridorEditorClearanceObstacles();
    const flat = [];
    let chain = 0;
    const samplesBySegment = corridorEditorScopedSegments().map(segment => {
        const planar = segment
            .map(point => wgs84ToHTRS96(point.lat, point.lng))
            .filter(xy => Array.isArray(xy) && Number.isFinite(xy[0]) && Number.isFinite(xy[1]));
        if (planar.length < 2) return [];
        const samples = corridorClearanceSamples(planar, obstacles, { maxDistance: CORRIDOR_CLEARANCE_MAX });
        samples.forEach(sample => flat.push({ ...sample, chain: chain + sample.s }));
        chain += corridorEditorPlanarLength(planar);
        return samples;
    });
    state.clearanceCache = { key, samplesBySegment, flat, obstacles, chainLength: chain };
    return state.clearanceCache;
}

function corridorEditorFormatMeters(value) {
    return `${Number(Number(value).toFixed(1))}`;
}

// The compass name of the corridor's LEFT side — how a direction is said to someone who cannot
// know which way the centerline was drawn. flip=true names the right side.
function corridorEditorSideLabel(flat, flip) {
    let x = 0;
    let y = 0;
    flat.forEach(sample => {
        x += -Math.sin(sample.angle);
        y += Math.cos(sample.angle);
    });
    if (flip) { x = -x; y = -y; }
    const key = (typeof corridorCompass8 === 'function') ? corridorCompass8([x, y]) : null;
    if (!key) return '';
    const fallbacks = { n: 'north', ne: 'north-east', e: 'east', se: 'south-east', s: 'south', sw: 'south-west', w: 'west', nw: 'north-west' };
    return corridorEditorI18n(`modal.corridor.compass.${key}`, fallbacks[key]);
}

// A shift's direction/magnitude as user-facing text: "1.8 m north-east".
function corridorEditorShiftText(flat, shift) {
    return `${corridorEditorFormatMeters(Math.abs(shift))} m ${corridorEditorSideLabel(flat, shift < 0)}`;
}

// What the corridor min width becomes without one pinch obstacle — the "what would demolishing
// it buy" number, one resample with that obstacle left out.
function corridorEditorWhatIfWithout(clearance, obstacleId) {
    const state = corridorEditorState;
    if (!state || !clearance) return null;
    const remaining = clearance.obstacles.filter(obstacle => obstacle.id !== obstacleId);
    const flat = [];
    corridorEditorScopedSegments().forEach(segment => {
        const planar = segment.map(point => wgs84ToHTRS96(point.lat, point.lng));
        corridorClearanceSamples(planar, remaining, { maxDistance: CORRIDOR_CLEARANCE_MAX })
            .forEach(sample => flat.push(sample));
    });
    const stats = flat.length
        ? corridorClearanceStats(flat, corridorProfileWidth(state.profile), { maxDistance: CORRIDOR_CLEARANCE_MAX })
        : null;
    return stats ? { minWidth: stats.minWidth, unbounded: stats.minWidthUnbounded } : null;
}

// The width-profile chart: chainage along the road against the corridor width there, with the
// current road width as a dashed reference line and the pinch marked. Values are clipped at a
// display cap — an open side is a floor, not a measurement — and the hover cursor (bound after
// insertion) reads out exact values and pans the map on click.
function corridorEditorChartSvg(stats, roadWidth, chainLength) {
    if (!stats || stats.widths.length < 2) return '';
    const W = 320;
    const H = 110;
    const M = { left: 34, right: 10, top: 10, bottom: 16 };
    const cap = Math.max(Math.min(60, Math.max(roadWidth * 1.6, stats.minWidth * 1.3, 15)), roadWidth * 1.15);
    const plotW = W - M.left - M.right;
    const plotH = H - M.top - M.bottom;
    const x = chain => M.left + (chainLength > 0 ? (chain / chainLength) : 0) * plotW;
    const y = width => M.top + (1 - Math.min(width, cap) / cap) * plotH;

    const line = stats.widths
        .map((entry, index) => `${index ? 'L' : 'M'}${x(entry.chain ?? entry.s).toFixed(1)},${y(entry.width).toFixed(1)}`)
        .join(' ');
    const first = stats.widths[0];
    const last = stats.widths[stats.widths.length - 1];
    const area = `${line} L${x(last.chain ?? last.s).toFixed(1)},${(M.top + plotH).toFixed(1)} L${x(first.chain ?? first.s).toFixed(1)},${(M.top + plotH).toFixed(1)} Z`;
    const roadY = y(roadWidth);
    const min = stats.widths[stats.pinch.index];
    const gridY = [cap, cap / 2];

    return `
        <div class="corridor-chart-title">${corridorEditorI18n('modal.corridor.chartTitle', 'Corridor width along the road (m)')}</div>
        <svg class="corridor-chart" viewBox="0 0 ${W} ${H}" role="img"
             aria-label="${corridorEditorI18n('modal.corridor.chartTitle', 'Corridor width along the road (m)')}">
            ${gridY.map(value => `<line class="corridor-chart-grid" x1="${M.left}" y1="${y(value).toFixed(1)}" x2="${W - M.right}" y2="${y(value).toFixed(1)}"></line>
            <text class="corridor-chart-tick" x="${M.left - 4}" y="${(y(value) + 3).toFixed(1)}" text-anchor="end">${corridorEditorFormatMeters(value)}</text>`).join('')}
            <line class="corridor-chart-grid" x1="${M.left}" y1="${M.top + plotH}" x2="${W - M.right}" y2="${M.top + plotH}"></line>
            <text class="corridor-chart-tick" x="${M.left - 4}" y="${M.top + plotH + 3}" text-anchor="end">0</text>
            <path class="corridor-chart-area" d="${area}"></path>
            <path class="corridor-chart-line" d="${line}"></path>
            <line class="corridor-chart-road" x1="${M.left}" y1="${roadY.toFixed(1)}" x2="${W - M.right}" y2="${roadY.toFixed(1)}"></line>
            <text class="corridor-chart-road-label" x="${W - M.right}" y="${(roadY - 3).toFixed(1)}" text-anchor="end">${corridorEditorI18n('modal.corridor.chartRoad', 'road')} ${corridorEditorFormatMeters(roadWidth)} m</text>
            <circle class="corridor-chart-min" cx="${x(min.chain ?? min.s).toFixed(1)}" cy="${y(min.width).toFixed(1)}" r="3.5"></circle>
            <text class="corridor-chart-min-label" x="${x(min.chain ?? min.s).toFixed(1)}" y="${Math.max(M.top + 8, y(min.width) - 7).toFixed(1)}" text-anchor="middle">${stats.minWidthUnbounded ? '≥ ' : ''}${corridorEditorFormatMeters(min.width)}</text>
            <line class="corridor-chart-cursor" y1="${M.top}" y2="${M.top + plotH}" hidden></line>
            <rect class="corridor-chart-hit" x="${M.left}" y="${M.top}" width="${plotW}" height="${plotH}" fill="transparent"></rect>
        </svg>
        <div class="corridor-chart-readout" hidden></div>`;
}

function corridorEditorCorridorBodyHtml() {
    const state = corridorEditorState;
    if (!corridorEditorClearanceReady()) return '<div class="corridor-editor-notice">corridor-clearance.js missing</div>';
    const clearance = corridorEditorEnsureClearance();
    const width = corridorProfileWidth(state.profile);
    const flat = clearance ? clearance.flat : [];
    const stats = flat.length ? corridorClearanceStats(flat, width, { maxDistance: CORRIDOR_CLEARANCE_MAX }) : null;
    if (stats) stats.widths.forEach((entry, index) => { entry.chain = flat[index].chain; });

    const constraint = `
        <label class="corridor-stats-constraint" title="${corridorEditorI18n('modal.corridor.constraintParcelsTitle', 'Treat every parcel that is not road land as a wall: the corridor can only use road parcels and land this road already takes.')}">
            <input type="checkbox" class="corridor-stats-parcels"${state.clearanceMode === 'parcels' ? ' checked' : ''}>
            <span>${corridorEditorI18n('modal.corridor.constraintParcels', 'Also stay within road parcels')}</span>
        </label>`;

    if (!stats) {
        return `<div class="corridor-stats">${constraint}
            <div class="corridor-editor-notice">${corridorEditorI18n('modal.corridor.noClearance', 'Nothing to measure yet — the road has no centerline here.')}</div>
        </div>`;
    }

    const noObstacles = !clearance.obstacles.length
        ? `<div class="corridor-stats-note">${corridorEditorI18n('modal.corridor.noObstacles', 'No buildings are loaded near this road, so nothing constrains the corridor yet.')}</div>`
        : '';

    const minText = `${stats.minWidthUnbounded ? '≥ ' : ''}${corridorEditorFormatMeters(stats.minWidth)} m`;
    const delta = stats.minWidth - width;
    const deltaText = delta >= 0
        ? `<span class="corridor-stats-delta corridor-stats-delta--ok">${corridorEditorI18n('modal.corridor.roomToWiden', 'Room to widen: +{{delta}} m', { delta: corridorEditorFormatMeters(delta) })}</span>`
        : `<span class="corridor-stats-delta corridor-stats-delta--over">${corridorEditorI18n('modal.corridor.overCorridor', 'Too wide for the corridor by {{delta}} m', { delta: corridorEditorFormatMeters(-delta) })}</span>`;

    // Fit: only a single scoped segment can be moved as one piece (pick a segment on a network).
    const singleSegment = clearance.samplesBySegment.filter(samples => samples.length).length === 1;
    const minted = typeof isProposalMinted === 'function' && isProposalMinted(state.source);
    const fit = corridorFitShift(flat, width, { maxDistance: CORRIDOR_CLEARANCE_MAX, margin: 0.05 });
    let fitHtml = '';
    if (stats.fitsAsIs) {
        fitHtml = `<div class="corridor-stats-fit-ok">${corridorEditorI18n('modal.corridor.fitsAsIs', 'The road fits in its current position.')}</div>`;
    } else if (!singleSegment) {
        fitHtml = `<div class="corridor-stats-note">${corridorEditorI18n('modal.corridor.fitPickSegment', 'Moving works one segment at a time — reopen the editor from a single segment of this road.')}</div>`;
    } else if (fit && fit.feasible && fit.shift !== 0) {
        fitHtml = `
            <div class="corridor-stats-fit-move">${corridorEditorI18n('modal.corridor.fitIfMoved', 'The road would fit if moved {{move}}.', { move: corridorEditorShiftText(flat, fit.shift) })}</div>
            <button type="button" class="btn btn-primary corridor-fit-move" data-shift="${fit.shift}"${minted ? ' disabled' : ''}>
                ${corridorEditorI18n('modal.corridor.moveToFit', 'Move road {{move}}', { move: corridorEditorShiftText(flat, fit.shift) })}
            </button>`;
    } else {
        fitHtml = `<div class="corridor-stats-fit-none">${corridorEditorI18n('modal.corridor.noFit', 'Does not fit even if moved — the corridor narrows to {{min}} m.', { min: corridorEditorFormatMeters(stats.minWidth) })}</div>`;
    }

    // A pending widening can be taken from one side instead of both: widen symmetrically, then
    // shift by half the added width, and the whole addition lands on the chosen side.
    const originalWidth = corridorProfileWidth(state.originalProfile || state.profile);
    let sideHtml = '';
    if (singleSegment && fit && width > originalWidth + 1e-6) {
        const half = (width - originalWidth) / 2;
        const options = [
            { shift: half, side: corridorEditorSideLabel(flat, false) },
            { shift: -half, side: corridorEditorSideLabel(flat, true) }
        ];
        const buttons = options.map(option => {
            const possible = fit.feasible && option.shift >= fit.dMin - 1e-9 && option.shift <= fit.dMax + 1e-9;
            return `<button type="button" class="btn btn-outline-secondary corridor-fit-side" data-shift="${option.shift}"
                ${possible && !minted ? '' : ' disabled'}>${corridorEditorI18n('modal.corridor.widenInto', 'Widen toward: {{side}}', { side: option.side })}</button>`;
        }).join('');
        sideHtml = `<div class="corridor-stats-sides">
            <div class="corridor-editor-group-label">${corridorEditorI18n('modal.corridor.widenIntoLabel', 'Take the added width ({{delta}} m) from one side', { delta: corridorEditorFormatMeters(width - originalWidth) })}</div>
            <div class="corridor-stats-side-buttons">${buttons}</div>
        </div>`;
    }
    const mintedNote = minted
        ? `<div class="corridor-stats-note">${corridorEditorI18n('modal.corridor.fitMinted', 'This proposal is minted and immutable — apply the cross-section to a drawing to move it.')}</div>`
        : '';

    // The pinch and what removing its obstacles would buy — the "what would demolition unlock" line.
    const pinchLines = [];
    pinchLines.push(corridorEditorI18n('modal.corridor.narrowest', 'Narrowest point: {{width}} m (marked on the map)', { width: `${stats.minWidthUnbounded ? '≥ ' : ''}${corridorEditorFormatMeters(stats.minWidth)}` }));
    [['leftObstacle', false], ['rightObstacle', true]].forEach(([sideKey, flip]) => {
        const obstacle = stats.pinch[sideKey];
        if (!obstacle || obstacle.kind !== 'building') return;
        const whatIf = corridorEditorWhatIfWithout(clearance, obstacle.obstacleId);
        if (!whatIf || whatIf.minWidth <= stats.minWidth + 0.05) return;
        pinchLines.push(corridorEditorI18n('modal.corridor.whatIfDemolished', 'Without the building on the {{side}} side: {{width}} m', {
            side: corridorEditorSideLabel(flat, flip),
            width: `${whatIf.unbounded ? '≥ ' : ''}${corridorEditorFormatMeters(whatIf.minWidth)}`
        }));
    });

    return `<div class="corridor-stats">
        ${constraint}
        ${noObstacles}
        <div class="corridor-stats-headline">
            <div class="corridor-stats-metric">
                <span class="corridor-stats-value">${minText}</span>
                <span class="corridor-stats-label">${corridorEditorI18n('modal.corridor.corridorMinWidth', 'Corridor min width — the widest this road can be here without demolishing anything')}</span>
            </div>
            <div class="corridor-stats-current">
                <span>${corridorEditorI18n('modal.corridor.currentRoad', 'Current road: {{width}} m', { width: corridorEditorFormatMeters(width) })}</span>
                ${deltaText}
            </div>
        </div>
        <div class="corridor-stats-fit">${fitHtml}${sideHtml}${mintedNote}</div>
        ${corridorEditorChartSvg(stats, width, clearance.chainLength)}
        <div class="corridor-stats-pinch">${pinchLines.map(line => `<div>${line}</div>`).join('')}</div>
    </div>`;
}

// The pane the clearance ticks and pinch-obstacle outlines draw in: ABOVE the road strips (655)
// so a tick crossing the road stays visible on it, still under proposal hover outlines (660).
function corridorEditorEnsureClearancePane() {
    if (typeof map === 'undefined' || !map || typeof map.getPane !== 'function') return null;
    let pane = map.getPane('corridorClearancePane');
    if (!pane && typeof map.createPane === 'function') pane = map.createPane('corridorClearancePane');
    if (pane && pane.style) {
        pane.style.zIndex = '658';
        pane.style.pointerEvents = 'none';
    }
    return pane ? 'corridorClearancePane' : undefined;
}

function corridorEditorClearClearanceOverlays() {
    if (typeof map === 'undefined' || !map) return;
    [corridorEditorHaloLayer, corridorEditorPinchLayer, corridorEditorChartProbeLayer].forEach(layer => {
        if (layer) { try { map.removeLayer(layer); } catch (_) { } }
    });
    corridorEditorHaloLayer = null;
    corridorEditorPinchLayer = null;
    corridorEditorChartProbeLayer = null;
}

// Draw the Corridor tab's story on the map: the available-corridor halo (the room the road has),
// the pinch tick labelled with the min width, and the outlines of the obstacles that form it.
function corridorEditorRenderClearanceOverlays() {
    corridorEditorClearClearanceOverlays();
    const state = corridorEditorState;
    if (!state || state.activeTab !== 'corridor' || typeof map === 'undefined' || !map || typeof L === 'undefined') return;
    if (!corridorEditorClearanceReady() || typeof htrs96ToWGS84 !== 'function') return;
    const clearance = corridorEditorEnsureClearance();
    if (!clearance || !clearance.flat.length) return;
    const stats = corridorClearanceStats(clearance.flat, corridorProfileWidth(state.profile), { maxDistance: CORRIDOR_CLEARANCE_MAX });
    if (!stats) return;
    if (typeof ensureCorridorStripsPane === 'function') ensureCorridorStripsPane();
    const pane = (typeof CORRIDOR_STRIPS_PANE !== 'undefined') ? CORRIDOR_STRIPS_PANE : undefined;
    const toLatLng = ([xCoord, yCoord]) => {
        const [lat, lng] = htrs96ToWGS84(xCoord, yCoord);
        return { lat, lng };
    };

    const haloRings = clearance.samplesBySegment
        .map(samples => corridorClearanceHalo(samples, CORRIDOR_CLEARANCE_DISPLAY_CAP))
        .filter(Boolean)
        .map(ring => ring.map(toLatLng));
    if (haloRings.length) {
        corridorEditorHaloLayer = L.polygon(haloRings, {
            pane,
            interactive: false,
            color: '#2563eb',
            weight: 1.5,
            dashArray: '6 4',
            fillColor: '#2563eb',
            fillOpacity: 0.06,
            className: 'corridor-clearance-halo'
        }).addTo(map);
    }

    // The pinch tick and its obstacles draw ABOVE the road (their own pane): the numbers live in
    // the panel and the chart — the map only shows WHERE.
    const tickPane = corridorEditorEnsureClearancePane();
    const pinch = stats.pinch;
    const sample = pinch.sample;
    const nx = -Math.sin(sample.angle);
    const ny = Math.cos(sample.angle);
    const L_ = Math.min(sample.left ? sample.left.distance : CORRIDOR_CLEARANCE_DISPLAY_CAP, CORRIDOR_CLEARANCE_DISPLAY_CAP);
    const R_ = Math.min(sample.right ? sample.right.distance : CORRIDOR_CLEARANCE_DISPLAY_CAP, CORRIDOR_CLEARANCE_DISPLAY_CAP);
    const tick = [
        toLatLng([sample.point[0] + nx * L_, sample.point[1] + ny * L_]),
        toLatLng([sample.point[0] - nx * R_, sample.point[1] - ny * R_])
    ];
    const group = [L.polyline(tick, { pane: tickPane, interactive: false, color: '#111827', weight: 3, className: 'corridor-clearance-pinch' })];
    [pinch.leftObstacle, pinch.rightObstacle].forEach(hit => {
        if (!hit) return;
        const obstacle = clearance.obstacles.find(candidate => candidate.id === hit.obstacleId);
        if (!obstacle) return;
        group.push(L.polygon(obstacle.rings.map(ring => ring.map(toLatLng)), {
            pane: tickPane,
            interactive: false,
            color: '#9a5b13',
            weight: 2,
            fillColor: '#d97706',
            fillOpacity: 0.2,
            className: 'corridor-clearance-pinch-obstacle'
        }));
    });
    corridorEditorPinchLayer = L.layerGroup(group).addTo(map);
}

// Bake a lateral shift into the scoped segment's stored centerline. The shift goes through
// updateLocalCorridorGeometry like any other geometry edit (a node drag, a reroute), so the
// footprint, parcel cuts, demolition re-carves and collision prompts all replay on the moved
// alignment. Endpoints welded to other roads (or to the rest of this network) are held: the
// shift tapers to zero toward them, the shape of a real realignment.
async function corridorEditorApplyFitShift(shiftMeters) {
    const state = corridorEditorState;
    if (!state || state.mode !== 'proposal' || !Number.isFinite(shiftMeters) || !shiftMeters) return;
    if (typeof updateLocalCorridorGeometry !== 'function' || !corridorEditorClearanceReady()) return;
    const segments = corridorEditorScopedSegments();
    if (segments.length !== 1) return;

    const planar = segments[0].map(point => wgs84ToHTRS96(point.lat, point.lng));
    const held = corridorHeldEndpoints(planar, corridorEditorOtherCenterlinesPlanar(), 1);
    const taper = Math.max(10, corridorProfileWidth(state.profile));
    let working = planar;
    if (held.start || held.end) {
        working = densifyPolylineXY(planar, Math.max(3, taper / 3));
    }
    const offsets = corridorShiftOffsets(working, shiftMeters, {
        holdStart: held.start,
        holdEnd: held.end,
        taperMeters: taper
    });
    const shifted = offsets ? offsetPolylineVariable(working, offsets) : null;
    if (!shifted) return;
    const moved = shifted.map(([xCoord, yCoord]) => {
        const [lat, lng] = htrs96ToWGS84(xCoord, yCoord);
        return { lat, lng };
    });

    // Name the move from the PRE-move samples (the direction hardly changes with the road).
    const moveText = (state.clearanceCache && state.clearanceCache.flat.length)
        ? corridorEditorShiftText(state.clearanceCache.flat, shiftMeters)
        : `${corridorEditorFormatMeters(Math.abs(shiftMeters))} m`;

    const updated = await updateLocalCorridorGeometry(state.proposalKey, definition => {
        corridorEditorWriteScopedSegmentPoints(definition, moved);
    });
    if (!corridorEditorState || corridorEditorState !== state) return;
    if (!updated) {
        state.notice = corridorEditorI18n('modal.corridor.moveFailed', 'The road could not be moved (a minted proposal is immutable).');
        corridorEditorRender();
        return;
    }
    // The centerline moved: every cache derived from it is stale, including the opening-width
    // baseline the blocking decision compares against.
    state.geometryVersion = (state.geometryVersion || 0) + 1;
    state.clearanceCache = null;
    state.baselineBuildingHitIds = null;
    if (typeof updateStatus === 'function') {
        updateStatus(corridorEditorI18n('modal.corridor.movedStatus', 'Road moved {{move}}.', { move: moveText }));
    }
    corridorEditorRender();
    corridorEditorFocusMap();
}

// Every centerline a shifted segment's endpoints could be welded to: the other segments of this
// road network, and the centerlines of every other road proposal on the map.
function corridorEditorOtherCenterlinesPlanar() {
    const state = corridorEditorState;
    const others = [];
    if (!state) return others;
    const toPlanar = segment => segment
        .map(point => wgs84ToHTRS96(point.lat, point.lng))
        .filter(xy => Array.isArray(xy) && Number.isFinite(xy[0]) && Number.isFinite(xy[1]));

    if (state.scope === 'segment' && state.segmentId && typeof corridorCenterlineOf === 'function') {
        const ids = Array.isArray(state.definition.segmentIds) ? state.definition.segmentIds : [];
        corridorCenterlineOf(state.definition).forEach((segment, index) => {
            if (String(ids[index] || '') !== state.segmentId) others.push(toPlanar(segment));
        });
    }
    try {
        const proposals = (typeof proposalStorage !== 'undefined' && proposalStorage.getAllProposals)
            ? proposalStorage.getAllProposals()
            : [];
        proposals.forEach(proposal => {
            if (!proposal || !proposal.roadProposal || !proposal.roadProposal.definition) return;
            const key = (typeof getProposalKey === 'function' ? getProposalKey(proposal) : null) || proposal.proposalId;
            if (String(key) === String(state.proposalKey)) return;
            if (typeof isProposalApplied === 'function' && !isProposalApplied(proposal)) return;
            corridorCenterlineOf(proposal.roadProposal.definition).forEach(segment => others.push(toPlanar(segment)));
        });
    } catch (_) { }
    return others.filter(poly => poly.length >= 2);
}

// Replace the scoped segment's points inside the stored definition, whatever raw shape it uses
// (one flat point list, or a list of segments under `points` or `segments`).
function corridorEditorWriteScopedSegmentPoints(definition, latlngs) {
    const state = corridorEditorState;
    const points = latlngs.map(point => ({ lat: point.lat, lng: point.lng }));
    const raw = (Array.isArray(definition.points) && definition.points.length && definition.points)
        || (Array.isArray(definition.segments) && definition.segments)
        || null;
    if (!raw) return;
    if (!Array.isArray(raw[0])) {
        definition.points = points;
        return;
    }
    // Raw indices of the segments corridorCenterlineOf would keep, in its output order — the
    // order segmentIds are indexed by.
    const validRawIndices = [];
    raw.forEach((segment, index) => {
        if (Array.isArray(segment) && segment.length >= 2) validRawIndices.push(index);
    });
    let target = -1;
    if (state && state.scope === 'segment' && state.segmentId) {
        const ids = Array.isArray(definition.segmentIds) ? definition.segmentIds : [];
        const position = validRawIndices.findIndex((rawIndex, order) => String(ids[order] || '') === state.segmentId);
        if (position >= 0) target = validRawIndices[position];
    } else if (validRawIndices.length === 1) {
        target = validRawIndices[0];
    }
    if (target < 0) return;
    raw[target] = points;
}

// Render the Corridor tab body and wire its controls.
function corridorEditorRenderCorridorTab(body) {
    body.innerHTML = corridorEditorCorridorBodyHtml();

    const toggle = body.querySelector('.corridor-stats-parcels');
    if (toggle) {
        toggle.addEventListener('change', () => {
            const state = corridorEditorState;
            if (!state) return;
            state.clearanceMode = toggle.checked ? 'parcels' : 'buildings';
            state.clearanceCache = null;
            corridorEditorRender();
        });
    }

    body.querySelectorAll('.corridor-fit-move, .corridor-fit-side').forEach(button => {
        button.addEventListener('click', () => {
            corridorEditorApplyFitShift(Number(button.dataset.shift));
        });
    });

    corridorEditorBindChart(body);
    corridorEditorRenderClearanceOverlays();
}

// The chart's hover crosshair and click-to-pan. Nearest-station lookup is by chainage, the same
// x the chart plots.
function corridorEditorBindChart(body) {
    const svg = body.querySelector('.corridor-chart');
    const readout = body.querySelector('.corridor-chart-readout');
    const cursor = svg && svg.querySelector('.corridor-chart-cursor');
    const hit = svg && svg.querySelector('.corridor-chart-hit');
    const state = corridorEditorState;
    if (!svg || !hit || !state) return;
    const clearance = state.clearanceCache;
    if (!clearance || !clearance.flat.length) return;
    const width = corridorProfileWidth(state.profile);

    const nearestSample = event => {
        const rect = hit.getBoundingClientRect();
        const fraction = Math.max(0, Math.min(1, (event.clientX - rect.left) / (rect.width || 1)));
        const chain = fraction * clearance.chainLength;
        let best = clearance.flat[0];
        clearance.flat.forEach(sample => {
            if (Math.abs(sample.chain - chain) < Math.abs(best.chain - chain)) best = sample;
        });
        return best;
    };

    hit.addEventListener('pointermove', event => {
        const sample = nearestSample(event);
        const L_ = sample.left ? sample.left.distance : CORRIDOR_CLEARANCE_MAX;
        const R_ = sample.right ? sample.right.distance : CORRIDOR_CLEARANCE_MAX;
        const unbounded = !sample.left || !sample.right;
        if (cursor) {
            // The hit rect carries the plot area in SVG coordinates; derive the cursor x from it.
            const plotX = Number(hit.getAttribute('x'));
            const plotW = Number(hit.getAttribute('width'));
            const x = plotX + (clearance.chainLength > 0 ? sample.chain / clearance.chainLength : 0) * plotW;
            cursor.setAttribute('x1', x);
            cursor.setAttribute('x2', x);
            cursor.hidden = false;
        }
        if (readout) {
            readout.hidden = false;
            readout.textContent = corridorEditorI18n('modal.corridor.chartReadout', 'At {{at}} m: corridor {{width}} m', {
                at: corridorEditorFormatMeters(sample.chain),
                width: `${unbounded ? '≥ ' : ''}${corridorEditorFormatMeters(L_ + R_)}`
            }) + (L_ + R_ < width ? ` — ${corridorEditorI18n('modal.corridor.chartTooNarrow', 'narrower than the road')}` : '');
        }
    });
    hit.addEventListener('pointerleave', () => {
        if (cursor) cursor.hidden = true;
        if (readout) readout.hidden = true;
    });
    hit.addEventListener('click', event => {
        corridorEditorShowChartProbe(nearestSample(event));
    });
}

// Drop a yellow tick across the corridor at a clicked chart station and pan to it — the chart's
// x-axis made visible: "the 75 m mark is HERE". No numbers on the map (the chart readout carries
// them); the tick draws above the road in its own pane. Replaced by the next click, cleared with
// the other Corridor-tab overlays.
function corridorEditorShowChartProbe(sample) {
    if (!sample || typeof map === 'undefined' || !map || typeof L === 'undefined'
        || typeof htrs96ToWGS84 !== 'function') return;
    if (corridorEditorChartProbeLayer) {
        try { map.removeLayer(corridorEditorChartProbeLayer); } catch (_) { }
        corridorEditorChartProbeLayer = null;
    }
    const toLatLng = ([xCoord, yCoord]) => {
        const [lat, lng] = htrs96ToWGS84(xCoord, yCoord);
        return { lat, lng };
    };
    const nx = -Math.sin(sample.angle);
    const ny = Math.cos(sample.angle);
    const left = Math.min(sample.left ? sample.left.distance : CORRIDOR_CLEARANCE_DISPLAY_CAP, CORRIDOR_CLEARANCE_DISPLAY_CAP);
    const right = Math.min(sample.right ? sample.right.distance : CORRIDOR_CLEARANCE_DISPLAY_CAP, CORRIDOR_CLEARANCE_DISPLAY_CAP);
    const tick = [
        toLatLng([sample.point[0] + nx * left, sample.point[1] + ny * left]),
        toLatLng([sample.point[0] - nx * right, sample.point[1] - ny * right])
    ];
    corridorEditorChartProbeLayer = L.polyline(tick, {
        pane: corridorEditorEnsureClearancePane(),
        interactive: false,
        color: '#eab308',
        weight: 4,
        className: 'corridor-clearance-probe'
    }).addTo(map);
    map.panTo(toLatLng(sample.point));
}

function corridorEditorSyncTabs() {
    const state = corridorEditorState;
    document.querySelectorAll('.corridor-editor-tab').forEach(tab => {
        const active = state && tab.dataset.tab === state.activeTab;
        tab.classList.toggle('corridor-editor-tab--active', !!active);
        tab.setAttribute('aria-selected', active ? 'true' : 'false');
    });
}

// A proportional bar of the cross-section, drawn to scale across the panel.
function corridorEditorSectionHtml(profile) {
    const total = corridorProfileWidth(profile);
    const cells = profile.strips.map((lane, index) => {
        const laneType = CORRIDOR_LANE_TYPES[lane.type] || {};
        const laneLabel = corridorLaneTypeLabel(lane.type);
        const percent = (lane.width / total) * 100;
        const selected = index === corridorEditorState.selected ? ' corridor-section-lane--selected' : '';
        return `<button type="button" class="corridor-section-lane${selected}" style="width:${percent}%;background:${laneType.surface}"
                    data-lane-index="${index}" title="${laneLabel} · ${lane.width} m"
                    aria-label="${laneLabel}, ${lane.width} metres"></button>`;
    }).join('');
    // Drag handles on the seams between lanes: dragging moves width from one side to the
    // other (total unchanged) — the schematic IS the editor, not just a picture. A seam touching a
    // fixed-width lane (parking) cannot move, so it is drawn locked and does not respond to a drag.
    const isFixed = type => typeof corridorLaneWidthFixed === 'function' && corridorLaneWidthFixed(type);
    let cumulative = 0;
    const seams = profile.strips.slice(0, -1).map((lane, index) => {
        cumulative += (lane.width / total) * 100;
        const locked = isFixed(lane.type) || isFixed(profile.strips[index + 1].type);
        const lockedClass = locked ? ' corridor-section-seam--locked' : '';
        const seamTitle = locked
            ? corridorEditorI18n('modal.corridor.seamLocked', 'Parking keeps its fixed width')
            : corridorEditorI18n('modal.corridor.dragSeam', 'Drag to resize the lanes on both sides');
        return `<span class="corridor-section-seam${lockedClass}" data-seam-index="${index}" style="left:${cumulative}%"
                    title="${seamTitle}"></span>`;
    }).join('');
    return `<div class="corridor-section">${cells}${seams}</div>`;
}

// Cheap in-place width sync used DURING a seam drag: a full corridorEditorRender would replace
// the seam element mid-drag and kill the pointer capture, so only widths/labels move here.
function corridorEditorSyncWidthsInPlace(profile) {
    const total = corridorProfileWidth(profile);
    const section = document.querySelector('.corridor-section');
    if (!section) return;
    const cells = section.querySelectorAll('.corridor-section-lane');
    let cumulative = 0;
    profile.strips.forEach((lane, index) => {
        const percent = (lane.width / total) * 100;
        const cell = cells[index];
        if (cell) cell.style.width = `${percent}%`;
        if (index < profile.strips.length - 1) {
            cumulative += percent;
            const seam = section.querySelector(`.corridor-section-seam[data-seam-index="${index}"]`);
            if (seam) seam.style.left = `${cumulative}%`;
        }
    });
    document.querySelectorAll('.corridor-lane-width').forEach(input => {
        const lane = profile.strips[Number(input.dataset.laneIndex)];
        if (lane) input.value = lane.width;
    });
    const totalEl = document.querySelector('.corridor-editor-total');
    if (totalEl) totalEl.textContent = corridorEditorTotalText(total);
}

// Every lane type is on offer in every corridor. A tram track running down a street is a normal street
// (this is Zagreb), and a track can have a platform, a verge or a service lane beside it — the corridor
// is the cross-section, and nothing about a rail lane makes it belong to only one kind of corridor.
function corridorEditorLaneTypes() {
    return Object.keys(CORRIDOR_LANE_TYPES);
}

// The standard width for a lane's type, and — only when the lane deviates from it — the one-click way
// back. A permanent reset button on every row would be clutter for something the user rarely wants.
// A track's standard is ITS GAUGE's standard, so the reset takes the lane's gauge, not just its type.
function corridorEditorStandardHtml(lane, index) {
    const standard = corridorStandardWidth(lane.type, lane.gauge);
    const label = `${Number(standard)} m`;
    if (Math.abs(lane.width - standard) < 1e-6) {
        return `<span class="corridor-lane-standard" title="${corridorEditorI18n('modal.corridor.standardWidth', 'Standard width: {{width}} m', { width: Number(standard) })}">${label}</span>`;
    }
    return `<button type="button" class="corridor-lane-standard corridor-lane-standard--reset" data-reset-standard="${index}"
                title="${corridorEditorI18n('modal.corridor.resetStandard', 'Reset to the standard width ({{width}} m)', { width: Number(standard) })}"
                aria-label="${corridorEditorI18n('modal.corridor.resetStandard', 'Reset to the standard width ({{width}} m)', { width: Number(standard) })}">↺ ${label}</button>`;
}

function corridorEditorRowsHtml(profile) {
    const options = corridorEditorLaneTypes();
    const dragHint = corridorEditorI18n('modal.corridor.dragReorder', 'Drag to reorder the lanes');

    return profile.strips.map((lane, index) => {
        const laneType = CORRIDOR_LANE_TYPES[lane.type] || {};
        const selected = index === corridorEditorState.selected ? ' corridor-lane-row--selected' : '';
        // A parking lane's depth is a fixed standard, not a slider: its width shows read-only. (The reset
        // button still offers to snap a legacy off-standard parking lane back to the standard.)
        const fixedWidth = typeof corridorLaneWidthFixed === 'function' && corridorLaneWidthFixed(lane.type);
        const typeOptions = options.map(type => `<option value="${type}"${type === lane.type ? ' selected' : ''}>${corridorLaneTypeLabel(type)}</option>`).join('');
        const landscape = (lane.type === 'verge' || lane.type === 'median') ? corridorLandscapeOf(lane) : null;
        const landscapeSelect = landscape ? `
            <select class="corridor-lane-landscape" data-lane-index="${index}" aria-label="Green strip planting">
                <option value="grass"${landscape === 'grass' ? ' selected' : ''}>${corridorEditorI18n('modal.corridor.grass', 'Grass only')}</option>
                <option value="trees"${landscape === 'trees' ? ' selected' : ''}>${corridorEditorI18n('modal.corridor.trees', 'Tree grove')}</option>
            </select>` : '';
        // A track's gauge, the same shape the green strips' planting takes. Picking a gauge re-widths the
        // lane (a gauge IS a width here), so the selector belongs next to the number it moves.
        const gauge = corridorRailGaugeOf(lane);
        const gaugeSelect = gauge ? `
            <select class="corridor-lane-gauge" data-lane-index="${index}" aria-label="${corridorEditorI18n('modal.corridor.gauge', 'Track gauge')}">
                <option value="1000"${gauge === 1000 ? ' selected' : ''}>${corridorEditorI18n('modal.corridor.gauges.metre', '1000 mm (tram)')}</option>
                <option value="1435"${gauge === 1435 ? ' selected' : ''}>${corridorEditorI18n('modal.corridor.gauges.standard', '1435 mm (railway)')}</option>
            </select>` : '';
        // A directional lane carries the way it runs; a clickable arrow in the row flips it, and the map's
        // painted direction arrow turns with it. Glyph is abstract (the section is a cross-view), tooltip explains.
        const direction = laneType.directional ? (lane.direction || 'forward') : null;
        const directionGlyph = direction === 'backward' ? '←' : (direction === 'both' ? '↔' : '→');
        const directionBtn = direction ? `
                <button type="button" class="corridor-lane-btn corridor-lane-direction" data-direction-index="${index}"
                    title="${corridorEditorI18n('modal.corridor.flipDirection', 'Traffic direction (click to reverse)')}"
                    aria-label="${corridorEditorI18n('modal.corridor.flipDirection', 'Traffic direction (click to reverse)')}">${directionGlyph}</button>` : '';
        // A parking lane can reserve every Nth bay for a tree (0 = none). The parking width is fixed, so this
        // is the row's editable number — placed on the extras line, the same spot a green strip's planting takes.
        const parkingOrientation = typeof corridorParkingOrientation === 'function' && corridorParkingOrientation(lane.type);
        const treeEvery = parkingOrientation ? (Number(lane.treeEvery) || 0) : 0;
        const treesControl = parkingOrientation ? `
            <label class="corridor-lane-trees" title="${corridorEditorI18n('modal.corridor.treeEveryTitle', 'Plant a tree in every Nth parking space (0 = none)')}">
                <span>${corridorEditorI18n('modal.corridor.treeEveryLabel', 'Tree every')}</span>
                <input class="corridor-lane-tree-every" type="number" min="0" step="1" value="${treeEvery}" data-lane-index="${index}"
                       aria-label="${corridorEditorI18n('modal.corridor.treeEveryTitle', 'Plant a tree in every Nth parking space (0 = none)')}">
                <span>${corridorEditorI18n('modal.corridor.treeEverySuffix', 'spaces')}</span>
            </label>` : '';
        return `
        <div class="corridor-lane-row${selected}" data-lane-index="${index}" tabindex="0">
            <span class="corridor-lane-handle" draggable="true" data-drag-index="${index}" title="${dragHint}" aria-hidden="true">⠿</span>
            <span class="corridor-lane-swatch" style="background:${laneType.surface}"></span>
            <select class="corridor-lane-type" data-lane-index="${index}" aria-label="Lane type">${typeOptions}</select>
            <input class="corridor-lane-width${fixedWidth ? ' corridor-lane-width--fixed' : ''}" type="number" min="0.5" step="0.25" value="${lane.width}"
                   data-lane-index="${index}" aria-label="Lane width in metres"${fixedWidth ? ` disabled title="${corridorEditorI18n('modal.corridor.fixedWidth', 'Fixed at the standard bay depth')}"` : ''}>
            <span class="corridor-lane-unit">m</span>
            ${corridorEditorStandardHtml(lane, index)}
            <span class="corridor-lane-actions">
                ${directionBtn}
                <button type="button" class="corridor-lane-btn" data-move-up="${index}" aria-label="Move outward" ${index === 0 ? 'disabled' : ''}>↑</button>
                <button type="button" class="corridor-lane-btn" data-move-down="${index}" aria-label="Move inward" ${index === profile.strips.length - 1 ? 'disabled' : ''}>↓</button>
                <button type="button" class="corridor-lane-btn corridor-lane-btn--remove" data-remove="${index}" aria-label="Remove lane">✕</button>
            </span>
            ${landscapeSelect}${gaugeSelect}${treesControl}
        </div>`;
    }).join('');
}

// The standard cross-sections, keyed by the same totals the road-width picker offers. Picking one
// stamps a complete, correct section; tweaking it afterwards is what the rest of the editor is for.
const CORRIDOR_EDITOR_PRESETS = [
    { width: 7.5, key: 'alley', fallback: 'Alley ~7.5 m' },
    { width: 10, key: 'local', fallback: 'Local ~10 m' },
    { width: 18, key: 'collector', fallback: 'Collector ~18 m' },
    { width: 26, key: 'mainStreet', fallback: 'Main street ~26 m' },
    { width: 40, key: 'avenue', fallback: 'Avenue ~40 m' },
    { width: 80, key: 'boulevard', fallback: 'Boulevard ~80 m' }
];

// One compact row of two dropdowns: add a lane of a type (at its standard width — this is how a
// street is widened, there is no width slider), and stamp a standard cross-section. Dropdowns,
// not button grids: ten lane types and six presets as buttons pushed the lane rows below the fold.
function corridorEditorPickersHtml() {
    const laneOptions = corridorEditorLaneTypes().map(type => {
        const width = Number(corridorStandardWidth(type));
        return `<option value="${type}">${corridorLaneTypeLabel(type)} (${width} m)</option>`;
    }).join('');
    const presetOptions = CORRIDOR_EDITOR_PRESETS
        .filter(preset => CORRIDOR_PROFILE_PRESETS[preset.width])
        .map(preset => `<option value="${preset.width}">${
            corridorEditorI18n(`modal.corridor.presetWidths.${preset.key}`, preset.fallback)
        }</option>`).join('');
    const addLabel = corridorEditorI18n('modal.corridor.addLane', 'Add lane');
    const presetLabel = corridorEditorI18n('modal.corridor.presets', 'Standard cross-sections');
    return `
        <div class="corridor-editor-pickers">
            <select class="corridor-editor-preset-select" aria-label="${presetLabel}">
                <option value="" selected disabled>${presetLabel}…</option>
                ${presetOptions}
            </select>
            <select class="corridor-editor-add-lane" aria-label="${addLabel}">
                <option value="" selected disabled>${addLabel}…</option>
                ${laneOptions}
            </select>
        </div>`;
}

// Selection is one thing shown in two places. Both are updated IN PLACE: a full re-render would throw
// away the focus of whatever the user just clicked, and a click on a row is often the start of using it.
function corridorEditorSyncSelection(scrollIntoView) {
    if (!corridorEditorState) return;
    const selected = corridorEditorState.selected;
    document.querySelectorAll('.corridor-section-lane').forEach(cell => {
        cell.classList.toggle('corridor-section-lane--selected', Number(cell.dataset.laneIndex) === selected);
    });
    document.querySelectorAll('.corridor-lane-row').forEach(row => {
        const isSelected = Number(row.dataset.laneIndex) === selected;
        row.classList.toggle('corridor-lane-row--selected', isSelected);
        if (isSelected && scrollIntoView && typeof row.scrollIntoView === 'function') {
            row.scrollIntoView({ block: 'nearest' });
        }
    });
}

function corridorEditorSelect(index, scrollIntoView) {
    if (!corridorEditorState) return;
    corridorEditorState.selected = index;
    corridorEditorSyncSelection(scrollIntoView);
}

function corridorEditorRender() {
    const body = document.querySelector('.corridor-editor-body');
    if (!body || !corridorEditorState) return;
    corridorEditorSyncTabs();

    if (corridorEditorState.activeTab === 'corridor' && corridorEditorState.mode === 'proposal') {
        corridorEditorRenderCorridorTab(body);
        const corridorSave = document.querySelector('.corridor-editor-save');
        if (corridorSave) {
            corridorSave.disabled = !corridorEditorState.dirty || corridorEditorState.widthBlocked === true;
        }
        // The obstacle check keeps running here too: it owns the red hit paint and the Apply block.
        corridorEditorScheduleObstacleCheck();
        return;
    }

    const profile = corridorEditorState.profile;
    const notice = corridorEditorState.notice
        ? `<div class="corridor-editor-notice" role="status">${corridorEditorState.notice}</div>`
        : '';

    // The pickers, then the diagram — the controls that BUILD the road stay at the top, where
    // they cannot be pushed below the fold by a boulevard's fifteen lane rows.
    body.innerHTML = `
        ${corridorEditorPickersHtml()}
        ${corridorEditorSectionHtml(profile)}
        ${notice}
        <div class="corridor-editor-hint">${corridorEditorI18n('modal.corridor.dragReorderHint', 'Drag a lane by its handle to reorder it; drag a seam in the diagram to move width from one lane to its neighbour.')}</div>
        <div class="corridor-editor-lanes">${corridorEditorRowsHtml(profile)}</div>
    `;

    const currentWidth = corridorProfileWidth(profile);
    const total = document.querySelector('.corridor-editor-total');
    if (total) {
        total.textContent = corridorEditorTotalText(currentWidth);
        // The refusal flash is a moment, not a state: an edit that lands clears it.
        if (!corridorEditorState.notice) total.classList.remove('corridor-editor-total--refused');
    }

    const saveButton = document.querySelector('.corridor-editor-save');
    if (saveButton) {
        saveButton.disabled = corridorEditorState.saving === true
            || (corridorEditorState.mode !== 'drawing'
                && (!corridorEditorState.dirty || corridorEditorState.widthBlocked === true));
    }

    corridorEditorScheduleObstacleCheck();
    corridorEditorBindBody(body);
}

function corridorEditorBindBody(body) {
    // Clicking a lane in the diagram selects its row below (and brings it into view).
    body.querySelectorAll('.corridor-section-lane').forEach(cell => {
        cell.addEventListener('click', () => corridorEditorSelect(Number(cell.dataset.laneIndex), true));
    });

    // ...and the other way round: touching a row highlights its lane in the diagram.
    body.querySelectorAll('.corridor-lane-row').forEach(row => {
        const select = () => corridorEditorSelect(Number(row.dataset.laneIndex), false);
        row.addEventListener('click', select);
        row.addEventListener('focusin', select);
    });

    body.querySelectorAll('.corridor-section-seam:not(.corridor-section-seam--locked)').forEach(seam => {
        seam.addEventListener('pointerdown', event => {
            const state = corridorEditorState;
            const section = seam.closest('.corridor-section');
            if (!state || !section || typeof withSeamMoved !== 'function') return;
            event.preventDefault();
            seam.setPointerCapture(event.pointerId);
            const seamIndex = Number(seam.dataset.seamIndex);
            const startX = event.clientX;
            const sectionWidth = section.getBoundingClientRect().width || 1;
            // Every move re-derives from the drag-start profile, so rounding never compounds.
            const startProfile = JSON.parse(JSON.stringify(state.profile));
            const startTotal = corridorProfileWidth(startProfile);
            let moved = false;

            const onMove = moveEvent => {
                const delta = ((moveEvent.clientX - startX) / sectionWidth) * startTotal;
                const next = withSeamMoved(startProfile, seamIndex, delta);
                if (!next) return; // clamped at the half-metre lane minimum
                state.profile = next;
                moved = true;
                corridorEditorSyncWidthsInPlace(next);
            };
            const onUp = () => {
                seam.removeEventListener('pointermove', onMove);
                seam.removeEventListener('pointerup', onUp);
                seam.removeEventListener('pointercancel', onUp);
                if (!moved) return;
                // Commit like any other edit: map preview, dirty flag, full re-render, checks.
                corridorEditorApply(() => state.profile);
            };
            seam.addEventListener('pointermove', onMove);
            seam.addEventListener('pointerup', onUp);
            seam.addEventListener('pointercancel', onUp);
        });
    });

    body.querySelectorAll('.corridor-lane-type').forEach(select => {
        select.addEventListener('change', () => {
            const index = Number(select.dataset.laneIndex);
            corridorEditorState.selected = index;
            corridorEditorApply(profile => withLaneType(profile, index, select.value));
        });
    });

    body.querySelectorAll('.corridor-lane-width').forEach(input => {
        input.addEventListener('change', () => {
            const index = Number(input.dataset.laneIndex);
            corridorEditorState.selected = index;
            corridorEditorApply(profile => withLaneWidth(profile, index, Number(input.value)));
        });
    });

    body.querySelectorAll('.corridor-lane-landscape').forEach(select => {
        select.addEventListener('change', () => {
            const index = Number(select.dataset.laneIndex);
            corridorEditorState.selected = index;
            corridorEditorApply(profile => withLaneLandscape(profile, index, select.value));
        });
    });

    body.querySelectorAll('.corridor-lane-gauge').forEach(select => {
        select.addEventListener('change', () => {
            const index = Number(select.dataset.laneIndex);
            corridorEditorState.selected = index;
            // withLaneGauge also re-widths the lane to that gauge's standard, so the corridor's total
            // moves with it — the same way any other width edit moves it.
            corridorEditorApply(profile => withLaneGauge(profile, index, select.value));
        });
    });

    // The direction arrow: click reverses the lane (both -> forward, so a click always resolves it).
    body.querySelectorAll('[data-direction-index]').forEach(button => {
        const index = Number(button.dataset.directionIndex);
        button.addEventListener('click', () => {
            corridorEditorState.selected = index;
            corridorEditorApply(profile => {
                const lane = profile.strips[index];
                return withLaneDirection(profile, index, lane && lane.direction === 'backward' ? 'forward' : 'backward');
            });
        });
    });

    body.querySelectorAll('.corridor-lane-tree-every').forEach(input => {
        input.addEventListener('change', () => {
            const index = Number(input.dataset.laneIndex);
            corridorEditorState.selected = index;
            corridorEditorApply(profile => withLaneTreeEvery(profile, index, Number(input.value)));
        });
    });

    body.querySelectorAll('[data-move-up]').forEach(button => {
        const index = Number(button.dataset.moveUp);
        button.addEventListener('click', () => {
            corridorEditorState.selected = index - 1;
            corridorEditorApply(profile => withLaneMoved(profile, index, index - 1));
        });
    });

    body.querySelectorAll('[data-move-down]').forEach(button => {
        const index = Number(button.dataset.moveDown);
        button.addEventListener('click', () => {
            corridorEditorState.selected = index + 1;
            corridorEditorApply(profile => withLaneMoved(profile, index, index + 1));
        });
    });

    body.querySelectorAll('[data-remove]').forEach(button => {
        const index = Number(button.dataset.remove);
        button.addEventListener('click', () => {
            corridorEditorState.selected = Math.max(0, index - 1);
            corridorEditorApply(profile => withLaneRemoved(profile, index));
        });
    });

    body.querySelectorAll('[data-reset-standard]').forEach(button => {
        const index = Number(button.dataset.resetStandard);
        button.addEventListener('click', () => {
            corridorEditorState.selected = index;
            corridorEditorApply(profile => {
                const lane = profile.strips[index];
                return withLaneWidth(profile, index, corridorStandardWidth(lane.type, lane.gauge));
            });
        });
    });

    // The add-lane dropdown. A new lane goes AFTER the selected one — the outermost strips are
    // almost always sidewalks, so appending on the right would put a traffic lane outside the
    // pavement. (The re-render after the edit resets the dropdown to its placeholder.)
    const addSelect = body.querySelector('.corridor-editor-add-lane');
    if (addSelect) {
        addSelect.addEventListener('change', () => {
            const type = addSelect.value;
            addSelect.value = '';
            if (!type || !isCorridorLaneType(type)) return;
            const state = corridorEditorState;
            const lanes = state.profile.strips.length;
            const at = (state.selected >= 0 && state.selected < lanes) ? state.selected + 1 : lanes;
            const lane = { type, width: corridorStandardWidth(type) };
            if ((CORRIDOR_LANE_TYPES[type] || {}).directional) lane.direction = 'forward';
            // A fresh track is a standard-gauge one; its row's gauge selector is how it becomes a tram.
            if (type === 'rail') lane.gauge = CORRIDOR_DEFAULT_RAIL_GAUGE;
            state.selected = at; // the new lane lands at `at`, and the render below highlights it
            corridorEditorApply(profile => withLaneInserted(profile, at, lane));
        });
    }

    const presetSelect = body.querySelector('.corridor-editor-preset-select');
    if (presetSelect) {
        presetSelect.addEventListener('change', () => {
            const preset = CORRIDOR_PROFILE_PRESETS[presetSelect.value];
            presetSelect.value = '';
            if (!preset) return;
            corridorEditorState.selected = 0;
            corridorEditorApply(() => normalizeCorridorProfile(preset.map(strip => ({ ...strip }))));
        });
    }

    corridorEditorBindLaneDrag(body);
}

// Drag a lane row by its handle to reorder it. The ↑/↓ buttons stay: they are the keyboard and touch
// path (HTML5 drag does not exist on a finger), and this is the same withLaneMoved either way.
function corridorEditorBindLaneDrag(body) {
    const rows = [...body.querySelectorAll('.corridor-lane-row')];
    const clearMarks = () => rows.forEach(row => row.classList.remove('corridor-lane-row--dragging', 'corridor-lane-row--drop'));

    body.querySelectorAll('.corridor-lane-handle').forEach(handle => {
        const row = handle.closest('.corridor-lane-row');
        handle.addEventListener('dragstart', event => {
            corridorEditorState.dragIndex = Number(handle.dataset.dragIndex);
            event.dataTransfer.effectAllowed = 'move';
            // Some browsers refuse a drag with no payload.
            event.dataTransfer.setData('text/plain', String(corridorEditorState.dragIndex));
            if (row && typeof event.dataTransfer.setDragImage === 'function') event.dataTransfer.setDragImage(row, 12, 12);
            if (row) row.classList.add('corridor-lane-row--dragging');
        });
        handle.addEventListener('dragend', () => {
            corridorEditorState.dragIndex = null;
            clearMarks();
        });
    });

    rows.forEach(row => {
        row.addEventListener('dragover', event => {
            if (corridorEditorState.dragIndex === null || corridorEditorState.dragIndex === undefined) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
            rows.forEach(other => other.classList.remove('corridor-lane-row--drop'));
            if (Number(row.dataset.laneIndex) !== corridorEditorState.dragIndex) row.classList.add('corridor-lane-row--drop');
        });
        row.addEventListener('drop', event => {
            event.preventDefault();
            const from = corridorEditorState.dragIndex;
            const to = Number(row.dataset.laneIndex);
            corridorEditorState.dragIndex = null;
            clearMarks();
            if (from === null || from === undefined || from === to) return;
            corridorEditorState.selected = to;
            corridorEditorApply(profile => withLaneMoved(profile, from, to));
        });
    });
}

// Apply returns a placed road to the normal drawing tool with its edited profile. No proposal exists
// until the user explicitly presses Create there; cancelling the drawing leaves the source untouched.
async function corridorEditorSave() {
    if (!corridorEditorState) return;
    if (corridorEditorState.mode === 'drawing') {
        const state = corridorEditorState;
        if (state.saving) return;
        const openingWidth = corridorProfileWidth(state.originalProfile || state.profile);
        const editedWidth = corridorProfileWidth(state.profile);
        const footprintChanged = Math.abs(editedWidth - openingWidth) > 1e-6;
        if (footprintChanged) {
            state.saving = true;
            corridorEditorRender();
            let accepted = false;
            try {
                accepted = typeof window.validateRoadDrawingProfileImpacts === 'function'
                    && await window.validateRoadDrawingProfileImpacts();
            } finally {
                if (corridorEditorState === state) state.saving = false;
            }
            if (!accepted) {
                if (corridorEditorState === state) {
                    state.notice = corridorEditorI18n(
                        'modal.corridor.unresolvedDrawingImpact',
                        'The cross-section was not applied. Adjust it or resolve its building impacts.'
                    );
                    corridorEditorRender();
                    corridorEditorFlashRefusal();
                }
                return;
            }
        }
        corridorEditorClose();
        if (typeof updateStatus === 'function') {
            updateStatus('Cross-section applied. Keep drawing or press F to finish the road.');
        }
        return;
    }
    // A width that newly hits a building cannot be applied — tunnels are made while drawing.
    // Settle any pending debounced check first so a quick drag-then-Apply cannot slip through.
    if (corridorEditorObstacleTimer) {
        clearTimeout(corridorEditorObstacleTimer);
        corridorEditorObstacleTimer = null;
        corridorEditorRunObstacleCheck();
    }
    if (corridorEditorState.widthBlocked) {
        corridorEditorFlashRefusal();
        return;
    }
    const { source, profile, scope, segmentId: scopedSegmentId } = corridorEditorState;
    const sourceKey = (typeof getProposalKey === 'function' ? getProposalKey(source) : null) || source.proposalId;
    const sourceName = source.title || source.name || sourceKey;
    corridorEditorClose();

    // SimCity object editing: a local, unminted road takes the new cross-section in place —
    // the footprint rebuilds and the road re-applies. Only minted (immutable) proposals fall
    // through to the redraw-as-replacement flow.
    const minted = typeof isProposalMinted === 'function' && isProposalMinted(source);
    if (!minted && typeof window.updateLocalCorridorGeometry === 'function') {
        const updated = await window.updateLocalCorridorGeometry(sourceKey, definition => {
            if (scope === 'segment' && scopedSegmentId) {
                // One segment of the network takes the new cross-section; the rest is untouched.
                definition.segmentProfiles = definition.segmentProfiles || {};
                const defaultProfile = (typeof corridorProfileOf === 'function') ? corridorProfileOf(definition) : null;
                if (defaultProfile && JSON.stringify(defaultProfile) === JSON.stringify(profile)) {
                    delete definition.segmentProfiles[String(scopedSegmentId)];
                } else {
                    definition.segmentProfiles[String(scopedSegmentId)] = JSON.parse(JSON.stringify(profile));
                }
                return;
            }
            // Whole network: the new profile becomes the uniform cross-section again.
            definition.profile = JSON.parse(JSON.stringify(profile));
            delete definition.segmentProfiles;
            if (typeof corridorProfileWidth === 'function') definition.width = corridorProfileWidth(profile);
            const sidewalks = (profile.strips || []).filter(strip => strip.type === 'sidewalk');
            definition.sidewalkWidth = sidewalks.length
                ? sidewalks.reduce((sum, strip) => sum + strip.width, 0) / sidewalks.length
                : 0;
        });
        if (updated) {
            if (typeof updateStatus === 'function') updateStatus('Cross-section updated.');
            return;
        }
    }

    const reopened = typeof copyCorridorIntoNewProposal === 'function'
        && await copyCorridorIntoNewProposal(source, sourceKey, sourceName, { profile });
    if (!reopened) {
        console.warn('[corridorEditor] could not reopen the placed road as a drawing', sourceKey);
        if (typeof showProposalAlertMessage === 'function') {
            showProposalAlertMessage('corridor_drawing_unavailable', "Could not reopen this road's drawing. Switch to the city it was created in, then try again.");
        }
    }
}

function corridorEditorOpenOverlay() {
    if (!corridorEditorState) return;
    const profile = corridorEditorState.profile;
    const drawing = corridorEditorState.mode === 'drawing';
    const totalWidth = corridorProfileWidth(profile);
    // Output, not input: the total IS the sum of the lanes, and the lanes are edited below.
    const totalControl = `
        <strong class="corridor-editor-total" aria-live="polite">${corridorEditorTotalText(totalWidth)}</strong>`;
    const scopeHtml = (!drawing && corridorEditorState.canScopeSegment) ? `
            <div class="corridor-editor-scope" role="radiogroup" aria-label="${corridorEditorI18n('modal.corridor.scopeLabel', 'Applies to')}">
                <label class="corridor-editor-scope-option"><input type="radio" name="corridor-editor-scope" value="segment"${corridorEditorState.scope === 'segment' ? ' checked' : ''}><span>${corridorEditorI18n('modal.corridor.scopeSegment', 'This segment')}</span></label>
                <label class="corridor-editor-scope-option"><input type="radio" name="corridor-editor-scope" value="road"${corridorEditorState.scope === 'road' ? ' checked' : ''}><span>${corridorEditorI18n('modal.corridor.scopeRoad', 'Entire road network')}</span></label>
            </div>` : '';
    const indicatorsHtml = drawing ? '' : `
            <div class="corridor-editor-indicators">
                <span class="corridor-editor-indicator corridor-editor-indicator--buildings" hidden>${corridorEditorI18n('modal.corridor.hitsBuildings', 'Hits buildings (to tunnel through buildings, use drawing mode)')}</span>
                <span class="corridor-editor-indicator corridor-editor-indicator--recut" hidden>${corridorEditorI18n('modal.corridor.extendsCut', 'Cuts deeper into an already-cut building (amber on the map)')}</span>
                <span class="corridor-editor-indicator corridor-editor-indicator--structures" hidden>${corridorEditorI18n('modal.corridor.cutsStructures', 'Cuts applied parks/squares/lakes')}</span>
                <button type="button" class="corridor-editor-indicator corridor-editor-indicator--fit" hidden>${corridorEditorI18n('modal.corridor.fitHint', 'Can it fit if moved? Open the Corridor tab')}</button>
            </div>`;
    // Two tabs for a placed road: the cross-section (what the road is) and the corridor (what the
    // room around it allows). Drawing mode keeps the single cross-section view.
    const tabsHtml = drawing ? '' : `
            <div class="corridor-editor-tabs" role="tablist">
                <button type="button" class="corridor-editor-tab corridor-editor-tab--active" data-tab="section" role="tab" aria-selected="true">${corridorEditorI18n('modal.corridor.tabSection', 'Cross-section')}</button>
                <button type="button" class="corridor-editor-tab" data-tab="corridor" role="tab" aria-selected="false">${corridorEditorI18n('modal.corridor.tabCorridor', 'Corridor')}</button>
            </div>`;
    const overlay = document.createElement('div');
    overlay.id = 'corridor-editor-overlay';
    overlay.className = 'corridor-editor-overlay';
    overlay.innerHTML = `
        <div class="corridor-editor" role="dialog" aria-label="Cross-section">
            <div class="corridor-editor-header">
                <div>
                    <div class="corridor-editor-title">${corridorEditorI18n('modal.corridor.title', 'Cross-section')}</div>
                    <div class="corridor-editor-subtitle">${drawing
                        ? corridorEditorI18n('modal.corridor.drawingSubtitle', 'Changes update the road on the map before you create the proposal')
                        : corridorEditorI18n('modal.corridor.proposalSubtitle', 'Preview changes here, then apply them to an editable road drawing')}</div>
                </div>
                <button type="button" class="close-circle-btn corridor-editor-close" aria-label="Close">&times;</button>
            </div>
            ${scopeHtml}
            <div class="corridor-editor-meta">
                <span>${corridorEditorI18n('modal.corridor.totalWidth', 'Total width')}</span>
                ${totalControl}
            </div>${indicatorsHtml}${tabsHtml}
            <div class="corridor-editor-body"></div>
            <div class="corridor-editor-footer">
                <button type="button" class="btn btn-outline-secondary corridor-editor-cancel">${corridorEditorI18n('modal.corridor.cancel', 'Cancel')}</button>
                <button type="button" class="btn btn-primary corridor-editor-save"${drawing ? '' : ' disabled'}>${drawing
                    ? corridorEditorI18n('modal.corridor.applyDrawing', 'Apply to drawing')
                    : corridorEditorI18n('modal.corridor.applyDrawing', 'Apply to drawing')}</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    overlay.querySelectorAll('input[name="corridor-editor-scope"]').forEach(radio => {
        radio.addEventListener('change', () => {
            const state = corridorEditorState;
            if (!state || !radio.checked) return;
            state.scope = radio.value === 'segment' ? 'segment' : 'road';
            state.profile = state.scope === 'segment' && typeof corridorSegmentProfile === 'function'
                ? corridorSegmentProfile(state.definition, state.segmentId)
                : corridorProfileOf(state.definition);
            state.originalProfile = JSON.parse(JSON.stringify(state.profile));
            state.baselineBuildingHitIds = null;
            state.clearanceCache = null; // the scoped extent changed with the scope
            state.dirty = false;
            state.notice = null;
            if (typeof setCorridorProfilePreview === 'function') {
                setCorridorProfilePreview(state.proposalKey, state.profile, state.scope === 'segment' ? state.segmentId : null);
            }
            corridorEditorRender();
            corridorEditorScheduleObstacleCheck();
            // The edited extent changed with the scope, so point the map at it.
            corridorEditorFocusMap();
        });
    });

    overlay.querySelectorAll('.corridor-editor-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            const state = corridorEditorState;
            if (!state || state.activeTab === tab.dataset.tab) return;
            state.activeTab = tab.dataset.tab === 'corridor' ? 'corridor' : 'section';
            if (state.activeTab !== 'corridor') corridorEditorClearClearanceOverlays();
            corridorEditorRender();
        });
    });

    const fitHint = overlay.querySelector('.corridor-editor-indicator--fit');
    if (fitHint) {
        fitHint.addEventListener('click', () => {
            const state = corridorEditorState;
            if (!state || state.activeTab === 'corridor') return;
            state.activeTab = 'corridor';
            corridorEditorRender();
        });
    }

    overlay.querySelector('.corridor-editor-close').addEventListener('click', corridorEditorCancel);
    overlay.querySelector('.corridor-editor-cancel').addEventListener('click', corridorEditorCancel);
    overlay.querySelector('.corridor-editor-save').addEventListener('click', corridorEditorSave);
    // No backdrop and no click-outside-to-cancel: the overlay is click-transparent, so a click
    // beside the panel pans the map instead. Escape and the two buttons close the editor.
    document.addEventListener('keydown', corridorEditorKeydown);
    // Lock the map's objects (CSS kills .leaflet-interactive; map-level handlers check
    // isCorridorEditorOpen) while keeping pan and zoom live.
    document.body.classList.add('corridor-editor-open');

    corridorEditorRender();
    corridorEditorFocusMap();
    corridorEditorShowBuildingFootprints();
}

// Entry point, wired to the "Cross-section" button in a road proposal's details panel.
function openCorridorProfileEditor(proposalIdOrHash) {
    corridorEditorCancel();

    const source = (typeof getProposalByIdOrHash === 'function') ? getProposalByIdOrHash(proposalIdOrHash) : null;
    const definition = source ? corridorProposalDefinition(source) : null;
    if (!definition || !corridorProfileOf(definition)) {
        console.warn('[corridorEditor] proposal has no corridor cross-section:', proposalIdOrHash);
        return;
    }

    const proposalKey = String((typeof getProposalKey === 'function' ? getProposalKey(source) : null) || source.proposalId);
    // The proposal is the whole network; the cross-section is a per-SEGMENT property. When the
    // click that led here landed on a specific segment, the editor opens scoped to it.
    const clicked = window.corridorLastClickedSegment;
    const segmentIds = Array.isArray(definition.segmentIds) ? definition.segmentIds.filter(Boolean).map(String) : [];
    const segmentId = (clicked && clicked.proposalKey === proposalKey && segmentIds.includes(String(clicked.segmentId)))
        ? String(clicked.segmentId)
        : null;
    const scope = (segmentId && segmentIds.length > 1) ? 'segment' : 'road';
    const profile = (scope === 'segment' && typeof corridorSegmentProfile === 'function')
        ? corridorSegmentProfile(definition, segmentId)
        : corridorProfileOf(definition);

    corridorEditorState = {
        mode: 'proposal',
        source,
        definition,
        scope,
        segmentId,
        canScopeSegment: !!segmentId && segmentIds.length > 1,
        proposalKey,
        profile,
        // The opening cross-section: widening is compared against ITS footprint, so a building
        // the road already touched when the editor opened never blocks an unrelated edit.
        originalProfile: JSON.parse(JSON.stringify(profile)),
        baselineBuildingHitIds: null,
        widthBlocked: false,
        activeTab: 'section',
        // 'buildings' measures the corridor against buildings only; 'parcels' additionally walls
        // it in at every parcel that is not road land (and not already crossed by this road).
        clearanceMode: 'buildings',
        clearanceCache: null,
        geometryVersion: 0,
        // Set when the editor itself ticked the "show buildings" box, so closing un-ticks it.
        restoreBuildingsCheckbox: false,
        selected: 0,
        dragIndex: null,
        notice: null,
        dirty: false
    };
    corridorEditorOpenOverlay();
}

// The same editor while the corridor is still geometry-in-progress — a road OR a track, since a track's
// cross-section is a lane list like any other. Every change is previewed immediately; Cancel restores the
// opening profile, while Apply keeps the live profile and returns to drawing.
function openRoadDrawingCrossSectionEditor() {
    if (!window.roadDrawingMode || typeof getRoadDrawingProfile !== 'function') return;
    corridorEditorCancel();
    const profile = getRoadDrawingProfile();
    if (!profile) return;
    const clone = value => JSON.parse(JSON.stringify(value));
    corridorEditorState = {
        mode: 'drawing',
        source: null,
        definition: null,
        proposalKey: null,
        profile: clone(profile),
        originalProfile: clone(profile),
        selected: 0,
        dragIndex: null,
        notice: null,
        dirty: false
    };
    corridorEditorOpenOverlay();
}

// Any placed corridor can be re-sectioned from its details panel. A track is one of them: its lane list
// is a cross-section like a road's, and the map draws it as one — rails and all — so an edit to it shows.
//
// A DESIGNATION is not: it is parcels declared to be road land, with no centerline and therefore no
// cross-section. corridorProfileOf() returns null for one rather than inventing lanes out of its width,
// which is exactly what makes this check refuse it — there is nothing to re-section.
function proposalHasEditableCorridor(proposal) {
    const definition = (typeof corridorProposalDefinition === 'function') ? corridorProposalDefinition(proposal) : null;
    if (!definition) return false;
    return !!corridorProfileOf(definition);
}

// The map stays pannable while the editor is docked, so map-level click handlers (road drawing,
// measuring) must be able to ask whether a click should be ignored — the CSS lock only covers
// clicks on objects, not clicks on the map itself.
function isCorridorEditorOpen() {
    return !!corridorEditorState;
}

if (typeof window !== 'undefined') {
    window.openCorridorProfileEditor = openCorridorProfileEditor;
    window.openRoadDrawingCrossSectionEditor = openRoadDrawingCrossSectionEditor;
    window.proposalHasEditableCorridor = proposalHasEditableCorridor;
    window.isCorridorEditorOpen = isCorridorEditorOpen;
}

// Node-side exports for unit tests (backend/test); the browser loads this as a classic script.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        corridorEditorFitPadding,
        corridorEditorPartitionDemolitions,
        corridorEditorWriteScopedSegmentPoints
    };
}
