// Corridor cross-section profiles.
//
// A corridor (road or track) is a centerline plus a cross-section: an ordered list of lanes running
// left-to-right across the corridor. The total width is the sum of the lanes, so `definition.width`
// becomes a derived cache rather than the truth, and every existing consumer of `width` keeps working.
//
// This separation is what lets a road's *content* be reshuffled (swap parking for trees, drag the seam
// between two lanes): as long as the lanes still sum to the same total, the corridor polygon — and
// therefore the parcel split and every descendant proposal — is untouched. When the lanes DO sum to
// something else (a lane is added, removed or resized) the total moves with them and the footprint
// follows, which is how a road is widened or narrowed. See the Editing section below.
//
// OSM COMPATIBILITY
// The lane list is the same object OSM's own cross-section tagging describes, and the same one the
// osm2lanes/osm2streets model uses: an ordered list of (type, direction, width). Lane types are named
// after the OSM keys and values they come from — `driving`, `sidewalk`, `cycleway`, `parking`, `verge`,
// `bus`, `rail` — and `corridorProfileFromOsmTags` / `corridorProfileToOsmTags` convert between a
// profile and a way's tags. A road we propose and a road imported from OSM therefore reach the renderer
// as the same object, so a change to how a lane type is drawn changes both at once.

// One entry per lane type. `osm` records how the lane appears on an OSM way, `surface` is the fill (2D)
// and material (3D), `height` the kerb height in metres — the surface table is the single place a lane
// type's appearance is defined, for our roads and OSM's alike.
const CORRIDOR_LANE_TYPES = {
    driving: { label: 'Traffic lane', surface: '#2b2b2b', height: 0, osm: { key: 'lanes' }, directional: true },
    bus: { label: 'Bus lane', surface: '#4a3b33', height: 0, osm: { key: 'busway', value: 'lane' }, directional: true },
    // Three ways to park a car against a kerb, one lane type each — they differ in how deep the lane is
    // and how the bays are painted, so a single `parking` type could never draw them right. `orientation`
    // is what the bay-marking renderer and the OSM bridge switch on; `fixedWidth` locks the lane to its
    // standard depth (a bay's depth is a real-world constant, not a slider). `parking` is the legacy key,
    // kept so stored/imported parking lanes stay valid — it IS parallel parking (a 2.5 m kerbside lane).
    parking: { label: 'Parallel parking', surface: '#3d3d3d', height: 0, osm: { key: 'parking', value: 'lane' }, orientation: 'parallel', fixedWidth: true },
    parking_perpendicular: { label: 'Perpendicular parking', surface: '#3d3d3d', height: 0, osm: { key: 'parking', value: 'lane' }, orientation: 'perpendicular', fixedWidth: true },
    parking_angled: { label: 'Angled parking', surface: '#3d3d3d', height: 0, osm: { key: 'parking', value: 'lane' }, orientation: 'angled', fixedWidth: true },
    cycleway: { label: 'Cycle path', surface: '#7d3b34', height: 0, osm: { key: 'cycleway', value: 'lane' }, directional: true },
    sidewalk: { label: 'Sidewalk', surface: '#c2beb4', height: 0.15, osm: { key: 'sidewalk', value: 'yes' } },
    verge: { label: 'Green verge', surface: '#4f7f52', height: 0.15, osm: { key: 'verge', value: 'yes' } },
    median: { label: 'Median', surface: '#4f7f52', height: 0.15, osm: { key: 'median', value: 'yes' } },
    // One TRACK — a single pair of rails and the ballast under it. A rail lane carries a `gauge`, the way
    // a verge carries a `landscape`: it is a property of the lane, and it sets the lane's width.
    // Ballast grey, and deliberately NOT #d3d3d3: that is the parcel fill, so a track drawn in it
    // was the same grey as the ground it crossed and disappeared into it. This is the base tone the
    // 2D ballast pattern is built on, kept here so 2D and 3D read as the same material.
    rail: { label: 'Track', surface: '#9a9a97', height: 0, osm: { key: 'railway', value: 'rail' } }
};

const CORRIDOR_GREEN_TYPES = new Set(['verge', 'median']);
const CORRIDOR_LANDSCAPES = ['grass', 'trees'];
// What a footway is surfaced with. Asphalt is the default (a strip of the same black the road is
// made of); paved is stone — drawn with the running-bond paving texture in 3D and photo view, and a
// stone fill in 2D. A property of the lane, exactly like a verge's landscape or a track's gauge.
const CORRIDOR_PAVINGS = ['asphalt', 'paved'];
const CORRIDOR_PAVED_TYPES = new Set(['sidewalk']);
// The stone a paved footway reads as where the texture cannot be drawn (2D, and 3D before the
// texture loads). Light enough to separate from the asphalt beside it at any zoom.
const CORRIDOR_PAVED_SURFACE = '#d8d2c4';
const CORRIDOR_DECORATION_SPACING = { bike: 50, pedestrian: 75, tree: 6 };

// The orientation a parking lane paints its bays at, or null for a lane that is not parking. The three
// parking types are the only ones that carry it; everything that draws or exports bays asks this rather
// than testing the type strings, so adding a fourth orientation is one entry in CORRIDOR_LANE_TYPES.
function corridorParkingOrientation(type) {
    const lane = CORRIDOR_LANE_TYPES[type];
    return (lane && lane.orientation) || null;
}

// A lane whose width is a real-world constant (a parking bay's depth), not a free slider: the editor
// shows it read-only, seam drags against it are refused, and a retype/reset snaps it to standard.
function corridorLaneWidthFixed(type) {
    return !!(CORRIDOR_LANE_TYPES[type] && CORRIDOR_LANE_TYPES[type].fixedWidth);
}

// The gauges a rail lane can have, in millimetres: 1000 mm is metre gauge (Zagreb's trams), 1435 mm is
// standard gauge (HŽ mainline). OSM spells this exactly the same way, in the `gauge=*` tag.
const CORRIDOR_RAIL_GAUGES = [1000, 1435];
const CORRIDOR_DEFAULT_RAIL_GAUGE = 1435;

// Presets keyed by the total widths the width picker already offers, so an existing road keeps its
// footprint exactly and only gains an interior. Every preset sums to its key.
//
// Right-hand traffic (Croatia): the strip list runs LEFT-of-travel → right (corridorStripSpans
// seeds the cursor at +total/2, the left offset, for index 0). So forward-travelling lanes must sit
// on the RIGHT half (later in the list) and the oncoming/backward lanes on the LEFT half — the near
// (right) kerb carries traffic moving in the drawing direction. Cycleways follow their adjacent
// carriageway. A single lane added in the editor still defaults to 'forward'; only these placed-road
// defaults must be handed the correct sides.
const CORRIDOR_PROFILE_PRESETS = {
    7.5: [
        { type: 'sidewalk', width: 1 }, { type: 'driving', width: 2.75, direction: 'backward' },
        { type: 'driving', width: 2.75, direction: 'forward' }, { type: 'sidewalk', width: 1 }
    ],
    10: [
        { type: 'sidewalk', width: 1.5 }, { type: 'driving', width: 3.5, direction: 'backward' },
        { type: 'driving', width: 3.5, direction: 'forward' }, { type: 'sidewalk', width: 1.5 }
    ],
    18: [
        { type: 'sidewalk', width: 2 }, { type: 'cycleway', width: 1.5, direction: 'backward' }, { type: 'parking', width: 2 },
        { type: 'driving', width: 3.5, direction: 'backward' }, { type: 'driving', width: 3.5, direction: 'forward' },
        { type: 'parking', width: 2 }, { type: 'cycleway', width: 1.5, direction: 'forward' }, { type: 'sidewalk', width: 2 }
    ],
    26: [
        { type: 'sidewalk', width: 3 }, { type: 'verge', width: 1.5, landscape: 'trees' }, { type: 'cycleway', width: 1.5, direction: 'backward' },
        { type: 'parking', width: 2.5 }, { type: 'driving', width: 3.25, direction: 'backward' }, { type: 'median', width: 2.5, landscape: 'grass' },
        { type: 'driving', width: 3.25, direction: 'forward' }, { type: 'parking', width: 2.5 }, { type: 'cycleway', width: 1.5, direction: 'forward' },
        { type: 'verge', width: 1.5, landscape: 'trees' }, { type: 'sidewalk', width: 3 }
    ],
    40: [
        { type: 'sidewalk', width: 4 }, { type: 'verge', width: 2, landscape: 'trees' }, { type: 'cycleway', width: 2, direction: 'backward' },
        { type: 'parking', width: 2.5 }, { type: 'driving', width: 3.25, direction: 'backward' }, { type: 'driving', width: 3.25, direction: 'backward' },
        { type: 'median', width: 6, landscape: 'grass' },
        { type: 'driving', width: 3.25, direction: 'forward' }, { type: 'driving', width: 3.25, direction: 'forward' }, { type: 'parking', width: 2.5 },
        { type: 'cycleway', width: 2, direction: 'forward' }, { type: 'verge', width: 2, landscape: 'trees' }, { type: 'sidewalk', width: 4 }
    ],
    80: [
        { type: 'sidewalk', width: 7 }, { type: 'verge', width: 5, landscape: 'trees' }, { type: 'cycleway', width: 3, direction: 'backward' },
        { type: 'parking', width: 2.5 }, { type: 'driving', width: 3.5, direction: 'backward' }, { type: 'driving', width: 3.5, direction: 'backward' },
        { type: 'driving', width: 3.5, direction: 'backward' },
        { type: 'median', width: 24, landscape: 'grass' },
        { type: 'driving', width: 3.5, direction: 'forward' }, { type: 'driving', width: 3.5, direction: 'forward' }, { type: 'driving', width: 3.5, direction: 'forward' },
        { type: 'parking', width: 2.5 }, { type: 'cycleway', width: 3, direction: 'forward' }, { type: 'verge', width: 5, landscape: 'trees' },
        { type: 'sidewalk', width: 7 }
    ]
};

// OSM default widths, used only when a way says nothing more specific.
const OSM_DEFAULT_SIDEWALK_WIDTH = 2;
const OSM_DEFAULT_CYCLEWAY_WIDTH = 1.5;
// The standard modern depth of a kerbside parking lane, by orientation: a parallel bay is only as deep
// as a car is wide (2.5 m), a 90° bay is a car length (5 m), and an angled bay sits between the two.
// These are the fixed widths the three parking lane types take — a bay's depth is a constant, not a slider.
const OSM_DEFAULT_PARKING_WIDTH = 2.5;
const CORRIDOR_PARKING_PERPENDICULAR_WIDTH = 5;
const CORRIDOR_PARKING_ANGLED_WIDTH = 4.5;
const OSM_DEFAULT_VERGE_WIDTH = 1.5;
const OSM_DEFAULT_MEDIAN_WIDTH = 2.5;

// Barely one way in five hundred carries a `width` tag (9 of 5167 across central Zagreb), so a
// corridor's width is normally *derived* from its cross-section rather than the other way round:
// lanes at their class's typical width, plus whatever furniture the per-side tags describe.
const OSM_LANE_WIDTH_BY_HIGHWAY = {
    motorway: 3.75, motorway_link: 3.5, trunk: 3.5, trunk_link: 3.25,
    primary: 3.5, primary_link: 3.25, secondary: 3.25, secondary_link: 3,
    tertiary: 3, tertiary_link: 3, residential: 3, unclassified: 3,
    living_street: 2.75, service: 2.75, track: 2.5, busway: 3.5, road: 3
};
const OSM_DEFAULT_LANE_WIDTH = 3;

// Ways with no carriageway at all: the whole width is one lane of another kind.
const OSM_CARRIAGEWAY_FREE_HIGHWAYS = {
    footway: { type: 'sidewalk', width: 2 },
    path: { type: 'sidewalk', width: 2 },
    steps: { type: 'sidewalk', width: 2 },
    bridleway: { type: 'sidewalk', width: 2 },
    pedestrian: { type: 'sidewalk', width: 8 },
    cycleway: { type: 'cycleway', width: 2.5 }
};
// Classes that carry a single lane unless the way says otherwise.
const OSM_SINGLE_LANE_HIGHWAYS = new Set(['service', 'track']);

// The width a lane of each type gets when it is added to a cross-section: the same numbers the OSM
// defaults above already use, so a lane we create and a lane read off an untagged OSM way are the same
// width. One standard per type, not per road class — a traffic lane is 3 m whether the street is a
// local road or an avenue; the difference between those streets is how many lanes they have, not how
// wide each one is, and the presets below carry that.
// The width of the STRIP one track occupies in the cross-section — sleepers, ballast shoulder and the
// clearance beside them — NOT the rail-to-rail distance the gauge names (that is 1.0 m and 1.435 m, and
// no track is that narrow). A metre-gauge tram track takes 2.75 m of street; a standard-gauge railway
// track takes 3.5 m. Two tracks side by side are two rail lanes, so a double track is 2 x this.
const CORRIDOR_RAIL_GAUGE_WIDTHS = {
    1000: 2.75,
    1435: 3.5
};

const CORRIDOR_STANDARD_WIDTHS = {
    driving: OSM_DEFAULT_LANE_WIDTH,
    bus: OSM_LANE_WIDTH_BY_HIGHWAY.busway,
    parking: OSM_DEFAULT_PARKING_WIDTH,
    parking_perpendicular: CORRIDOR_PARKING_PERPENDICULAR_WIDTH,
    parking_angled: CORRIDOR_PARKING_ANGLED_WIDTH,
    cycleway: OSM_DEFAULT_CYCLEWAY_WIDTH,
    sidewalk: OSM_DEFAULT_SIDEWALK_WIDTH,
    verge: OSM_DEFAULT_VERGE_WIDTH,
    median: OSM_DEFAULT_MEDIAN_WIDTH,
    // A rail lane has no single standard: its width follows its gauge (see corridorStandardWidth). This
    // entry is the default-gauge one, and it is what an untagged single track gets, here and from OSM.
    rail: CORRIDOR_RAIL_GAUGE_WIDTHS[CORRIDOR_DEFAULT_RAIL_GAUGE]
};

// The standard width of a lane of this type. Rail is the one type whose standard depends on a property
// of the lane — its gauge — so callers that have a lane pass its gauge; callers that only have a type
// (the palette, inserting a fresh lane) get the default gauge's width.
function corridorStandardWidth(type, gauge) {
    if (type === 'rail') return CORRIDOR_RAIL_GAUGE_WIDTHS[corridorRailGauge(gauge)];
    return CORRIDOR_STANDARD_WIDTHS[type] || OSM_DEFAULT_LANE_WIDTH;
}

function isCorridorLaneType(type) {
    return Object.prototype.hasOwnProperty.call(CORRIDOR_LANE_TYPES, type);
}

function corridorLandscapeOf(strip) {
    return strip && CORRIDOR_GREEN_TYPES.has(strip.type) && strip.landscape === 'trees' ? 'trees' : 'grass';
}

// A gauge value, coerced to one we know: anything unrecognised is standard gauge.
function corridorRailGauge(gauge) {
    const value = parseInt(gauge, 10);
    return CORRIDOR_RAIL_GAUGES.includes(value) ? value : CORRIDOR_DEFAULT_RAIL_GAUGE;
}

// The paving of a lane — only a footway has one, exactly as only a green lane has a landscape.
// Defaults to asphalt, so a profile written before paving existed reads as what it always was.
function corridorPavingOf(strip) {
    if (!strip || !CORRIDOR_PAVED_TYPES.has(strip.type)) return null;
    return CORRIDOR_PAVINGS.includes(strip.paving) ? strip.paving : 'asphalt';
}

// The colour a strip is drawn in, wherever it is drawn. Paving is the one property that changes it.
function corridorStripSurface(strip) {
    const lane = (typeof CORRIDOR_LANE_TYPES !== 'undefined' && CORRIDOR_LANE_TYPES[strip && strip.type]) || {};
    if (corridorPavingOf(strip) === 'paved') return CORRIDOR_PAVED_SURFACE;
    return lane.surface || '#2b2b2b';
}

// The gauge of a lane — only a rail lane has one, exactly as only a green lane has a landscape.
function corridorRailGaugeOf(strip) {
    return strip && strip.type === 'rail' ? corridorRailGauge(strip.gauge) : null;
}

const CORRIDOR_DIRECTIONS = ['forward', 'backward', 'both'];

// Drop anything unrecognisable rather than letting a bad lane silently swallow width. A direction is
// kept only where OSM would carry one (`lanes:forward`, `cycleway:left`), so a sidewalk never gets one.
function normalizeCorridorProfile(profile) {
    const raw = Array.isArray(profile) ? profile : (profile && Array.isArray(profile.strips) ? profile.strips : null);
    if (!raw) return null;
    const strips = raw.map(strip => {
        const type = String(strip && strip.type);
        const lane = { type, width: Number(strip && strip.width) };
        const direction = strip && strip.direction;
        if (isCorridorLaneType(type) && CORRIDOR_LANE_TYPES[type].directional && CORRIDOR_DIRECTIONS.includes(direction)) {
            lane.direction = direction;
        }
        if (CORRIDOR_GREEN_TYPES.has(type) && CORRIDOR_LANDSCAPES.includes(strip && strip.landscape)) {
            lane.landscape = strip.landscape;
        }
        // A parking lane may reserve every Nth bay for a tree; kept only when it is a positive whole number.
        if (corridorParkingOrientation(type)) {
            const treeEvery = parseInt(strip && strip.treeEvery, 10);
            if (Number.isFinite(treeEvery) && treeEvery > 0) lane.treeEvery = treeEvery;
        }
        // Every rail lane has a gauge; an unrecognised or missing one becomes the default.
        if (type === 'rail') lane.gauge = corridorRailGauge(strip && strip.gauge);
        // A footway's paving, likewise: kept only where it means something, and only when known.
        if (CORRIDOR_PAVED_TYPES.has(type) && CORRIDOR_PAVINGS.includes(strip && strip.paving)) {
            lane.paving = strip.paving;
        }
        return lane;
    }).filter(strip => isCorridorLaneType(strip.type) && Number.isFinite(strip.width) && strip.width > 0);
    return strips.length ? { strips } : null;
}

function corridorProfileWidth(profile) {
    const normalized = normalizeCorridorProfile(profile);
    if (!normalized) return 0;
    return normalized.strips.reduce((total, strip) => total + strip.width, 0);
}

// The same cross-section seen from the other end: the strips in reverse order and every one-way lane's
// direction swapped. Lanes are laid out left to right of the direction the centre line runs, and
// `forward`/`backward` are relative to it too, so a centre line that is reversed carries this profile.
function reversedCorridorProfile(profile) {
    const normalized = normalizeCorridorProfile(profile);
    if (!normalized) return null;
    const swapped = { forward: 'backward', backward: 'forward' };
    return {
        strips: normalized.strips.slice().reverse().map(strip => (swapped[strip.direction]
            ? { ...strip, direction: swapped[strip.direction] }
            : { ...strip }))
    };
}

// Round to millimetres: the presets are exact, but rebalancing divides.
function roundStripWidth(width) {
    return Math.round(width * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// Editing
//
// THE LANE LIST IS THE TRUTH. The total width is derived from it — `corridorProfileWidth` is a sum —
// and the footprint follows the total. So you change a road's width by adding, removing, resizing and
// reordering its lanes: add a bus lane and the road gets 3.5 m wider, delete the parking and it gets
// 2.5 m narrower. There is nothing to "absorb" an edit and therefore nothing an edit can fail against;
// a caller that wants a width ceiling (the editor caps corridors at the widest preset) enforces it on
// the resulting total, where the user can be told about it.
//
// The one deliberate exception is `withSeamMoved`: dragging the boundary between two neighbours moves
// width from one to the other and holds the total — and therefore the footprint, the parcel split and
// every proposal derived from it — exactly where it was. That is a distinct gesture, not the rule.
//
// `withSidewalkWidth` also still pays out of the traffic lanes, because it is not a user edit: it fits
// a legacy corridor's recorded sidewalk number into a preset whose total is already the road's width.
//
// An edit returns null only when it is meaningless (no such lane, an unknown type, a width below the
// minimum, removing the last lane). That is a refusal the caller must show, not swallow.
// ---------------------------------------------------------------------------

// A traffic lane narrower than this is not a traffic lane.
const CORRIDOR_MIN_DRIVING_WIDTH = 2.5;
// Any other lane narrower than this is a line, not a lane.
const CORRIDOR_MIN_LANE_WIDTH = 0.5;

// The smallest a lane of this type may be.
function corridorMinLaneWidth(type) {
    return type === 'driving' ? CORRIDOR_MIN_DRIVING_WIDTH : CORRIDOR_MIN_LANE_WIDTH;
}

// Take `delta` metres out of the driving lanes (negative gives metres back), in proportion to their
// widths, holding the total. The one caller left is `withSidewalkWidth`, which fits a legacy corridor's
// sidewalks into a preset without moving the width that corridor was drawn at. `exceptIndex` holds one
// lane out of the redistribution. Returns new strips, or null when the lanes have no room.
function redistributeToDriving(strips, delta, exceptIndex = -1) {
    if (Math.abs(delta) < 1e-9) return strips.map(strip => ({ ...strip }));

    const isPayer = (strip, index) => strip.type === 'driving' && index !== exceptIndex;
    const driving = strips.filter(isPayer);
    if (!driving.length) return null;

    const drivingTotal = driving.reduce((sum, strip) => sum + strip.width, 0);
    const remaining = drivingTotal - delta;
    if (remaining < driving.length * CORRIDOR_MIN_DRIVING_WIDTH) return null;

    // Round every lane but the last, then give the last whatever is left. Scaling and rounding each lane
    // independently would drift the total by a fraction of a millimetre per edit — and the total is the
    // footprint, so it has to come back exact however many times the profile is edited.
    const scale = remaining / drivingTotal;
    let assigned = 0;
    let seen = 0;
    return strips.map((strip, index) => {
        if (!isPayer(strip, index)) return { ...strip };
        seen += 1;
        if (seen === driving.length) return { ...strip, width: roundStripWidth(remaining - assigned) };
        const width = roundStripWidth(strip.width * scale);
        assigned += width;
        return { ...strip, width };
    });
}

// Drag the seam between two adjacent lanes: width moves from one side to the other, the total stays put.
// This is the ONE edit that deliberately holds the total constant — it reshuffles what the road contains
// without touching its footprint, so nothing derived from that footprint is invalidated. Every other
// edit is free to change the width. Refused (null) when either lane would drop below half a metre.
function withSeamMoved(profile, seamIndex, delta) {
    const normalized = normalizeCorridorProfile(profile);
    if (!normalized) return null;
    const left = normalized.strips[seamIndex];
    const right = normalized.strips[seamIndex + 1];
    if (!left || !right || !Number.isFinite(delta)) return null;
    // A fixed-width lane (parking) cannot give or take width, so a seam touching one does not move.
    if (corridorLaneWidthFixed(left.type) || corridorLaneWidthFixed(right.type)) return null;
    const widthLeft = roundStripWidth(left.width + delta);
    const widthRight = roundStripWidth(right.width - delta);
    if (widthLeft < CORRIDOR_MIN_LANE_WIDTH || widthRight < CORRIDOR_MIN_LANE_WIDTH) return null;
    return normalizeCorridorProfile(normalized.strips.map((strip, index) => {
        if (index === seamIndex) return { ...strip, width: widthLeft };
        if (index === seamIndex + 1) return { ...strip, width: widthRight };
        return { ...strip };
    }));
}

// Set one lane's width. Nothing else moves: the road grows or shrinks by the difference.
// Refused (null) below the type's minimum — a 1 m traffic lane is not a traffic lane.
//
// A FIXED-WIDTH lane (parking) has no arbitrary width: any width edit on one snaps it to its type's
// standard depth. This is what makes "reset to standard" work on a legacy parking lane recorded at an
// off-standard width, while a free-typed value simply lands back on the standard.
function withLaneWidth(profile, index, width) {
    const normalized = normalizeCorridorProfile(profile);
    if (!normalized || !normalized.strips[index]) return null;

    const lane = normalized.strips[index];
    if (corridorLaneWidthFixed(lane.type)) {
        const standard = corridorStandardWidth(lane.type);
        if (Math.abs(lane.width - standard) < 1e-6) return null; // already there; a no-op edit is a refusal
        return normalizeCorridorProfile(normalized.strips.map((strip, i) => (
            i === index ? { ...strip, width: standard } : { ...strip }
        )));
    }

    const target = Number(width);
    if (!Number.isFinite(target) || target <= 0) return null;
    if (target < corridorMinLaneWidth(lane.type)) return null;

    return normalizeCorridorProfile(normalized.strips.map((strip, i) => (
        i === index ? { ...strip, width: roundStripWidth(target) } : { ...strip }
    )));
}

// Change what a lane *is* — a traffic lane becomes parking, parking becomes trees. The width is kept as
// it was, so retyping normally holds the total; the exception is a fixed-width target (parking), which
// takes its standard depth and moves the total by the difference, exactly as inserting one would.
function withLaneType(profile, index, type) {
    const normalized = normalizeCorridorProfile(profile);
    if (!normalized || !normalized.strips[index] || !isCorridorLaneType(type)) return null;

    return normalizeCorridorProfile(normalized.strips.map((strip, i) => {
        if (i !== index) return strip;
        const lane = { type, width: corridorLaneWidthFixed(type) ? corridorStandardWidth(type) : strip.width };
        if (CORRIDOR_LANE_TYPES[type].directional) lane.direction = strip.direction || 'forward';
        if (CORRIDOR_GREEN_TYPES.has(type)) {
            lane.landscape = CORRIDOR_GREEN_TYPES.has(strip.type) ? corridorLandscapeOf(strip) : 'grass';
        }
        // Becoming a track means becoming a track OF A GAUGE; the width is the caller's to keep.
        if (type === 'rail') lane.gauge = corridorRailGauge(strip.gauge);
        return lane;
    }));
}

function withLaneLandscape(profile, index, landscape) {
    const normalized = normalizeCorridorProfile(profile);
    if (!normalized || !normalized.strips[index] || !CORRIDOR_GREEN_TYPES.has(normalized.strips[index].type)) return null;
    if (!CORRIDOR_LANDSCAPES.includes(landscape)) return null;
    return normalizeCorridorProfile(normalized.strips.map((strip, i) => (
        i === index ? { ...strip, landscape } : { ...strip }
    )));
}

// Surface a footway with asphalt or stone. Purely a material: it changes no width and moves no seam.
function withLanePaving(profile, index, paving) {
    const normalized = normalizeCorridorProfile(profile);
    if (!normalized || !normalized.strips[index] || !CORRIDOR_PAVED_TYPES.has(normalized.strips[index].type)) return null;
    if (!CORRIDOR_PAVINGS.includes(paving)) return null;
    return normalizeCorridorProfile(normalized.strips.map((strip, i) => (
        i === index ? { ...strip, paving } : { ...strip }
    )));
}

// Re-gauge a track. The gauge IS the width of the strip a track occupies, so the lane takes its new
// gauge's standard width — and the corridor gets wider or narrower by the difference, like any other
// width edit. A hand-tuned width is deliberately overwritten: picking a gauge is picking a track.
function withLaneGauge(profile, index, gauge) {
    const normalized = normalizeCorridorProfile(profile);
    if (!normalized || !normalized.strips[index] || normalized.strips[index].type !== 'rail') return null;
    const value = parseInt(gauge, 10);
    if (!CORRIDOR_RAIL_GAUGES.includes(value)) return null;
    return normalizeCorridorProfile(normalized.strips.map((strip, i) => (
        i === index ? { ...strip, gauge: value, width: corridorStandardWidth('rail', value) } : { ...strip }
    )));
}

// Flip (or set) a directional lane's travel direction — the thing a direction arrow paints. Only lanes
// that carry a direction (traffic, bus, cycleway) have one to set; a sidewalk has none. Width is untouched.
function withLaneDirection(profile, index, direction) {
    const normalized = normalizeCorridorProfile(profile);
    if (!normalized || !normalized.strips[index]) return null;
    const lane = normalized.strips[index];
    if (!isCorridorLaneType(lane.type) || !CORRIDOR_LANE_TYPES[lane.type].directional) return null;
    if (!CORRIDOR_DIRECTIONS.includes(direction)) return null;
    return normalizeCorridorProfile(normalized.strips.map((strip, i) => (
        i === index ? { ...strip, direction } : { ...strip }
    )));
}

// Reserve every Nth bay of a parking lane for a tree (0 = none, the default). Purely a planting choice:
// it changes nothing about the lane's width or the bays, only how many of them hold a tree not a car.
function withLaneTreeEvery(profile, index, treeEvery) {
    const normalized = normalizeCorridorProfile(profile);
    if (!normalized || !normalized.strips[index] || !corridorParkingOrientation(normalized.strips[index].type)) return null;
    const n = parseInt(treeEvery, 10);
    if (!Number.isFinite(n) || n < 0) return null;
    return normalizeCorridorProfile(normalized.strips.map((strip, i) => {
        if (i !== index) return { ...strip };
        const next = { ...strip };
        if (n > 0) next.treeEvery = n; else delete next.treeEvery;
        return next;
    }));
}

// Insert a lane at `index`. The road gets that much wider — an insert cannot fail for want of room,
// which is exactly why adding a lane is a thing the user can always do.
function withLaneInserted(profile, index, lane) {
    const normalized = normalizeCorridorProfile(profile);
    if (!normalized || !lane || !isCorridorLaneType(lane.type)) return null;
    const width = Number(lane.width);
    if (!Number.isFinite(width) || width <= 0) return null;

    const at = Math.max(0, Math.min(index, normalized.strips.length));
    const strips = normalized.strips.map(strip => ({ ...strip }));
    strips.splice(at, 0, { ...lane, width: roundStripWidth(width) });
    return normalizeCorridorProfile(strips);
}

// Remove a lane. The road gets that much narrower. A corridor with no lanes is not a corridor, so the
// last one stays.
function withLaneRemoved(profile, index) {
    const normalized = normalizeCorridorProfile(profile);
    if (!normalized || !normalized.strips[index]) return null;
    if (normalized.strips.length < 2) return null;

    return normalizeCorridorProfile(normalized.strips.filter((strip, i) => i !== index).map(strip => ({ ...strip })));
}

// Reorder: move the lane at `from` to `to`. Pure permutation, so the total is untouched.
function withLaneMoved(profile, from, to) {
    const normalized = normalizeCorridorProfile(profile);
    if (!normalized || !normalized.strips[from]) return null;
    const target = Math.max(0, Math.min(to, normalized.strips.length - 1));
    if (target === from) return normalized;

    const strips = normalized.strips.map(strip => ({ ...strip }));
    const [lane] = strips.splice(from, 1);
    strips.splice(target, 0, lane);
    return normalizeCorridorProfile(strips);
}

// Set every sidewalk to `sidewalkWidth`, taking the difference out of (or giving it to) the traffic
// lanes. Returns null when the lanes cannot absorb the change, which is the caller's cue to reject the
// slider value.
function withSidewalkWidth(profile, sidewalkWidth) {
    const normalized = normalizeCorridorProfile(profile);
    if (!normalized) return null;
    const target = Number(sidewalkWidth);
    if (!Number.isFinite(target) || target < 0) return normalized;

    const sidewalks = normalized.strips.filter(s => s.type === 'sidewalk');
    if (!sidewalks.length || !normalized.strips.some(s => s.type === 'driving')) return normalized;

    const delta = sidewalks.reduce((sum, s) => sum + (target - s.width), 0);
    const resized = normalized.strips.map(strip => (strip.type === 'sidewalk'
        ? { ...strip, width: roundStripWidth(target) }
        : strip));
    const strips = redistributeToDriving(resized, delta);
    return strips ? { strips } : null;
}

// The cross-section a NEWLY drawn track starts from: one track, at the standard gauge, occupying the
// strip that gauge needs. Everything else — a second track, a platform-side sidewalk, a green verge —
// is added in the cross-section editor, and the corridor's width follows the lanes as it does for a road.
function corridorDefaultTrackProfile(gauge = CORRIDOR_DEFAULT_RAIL_GAUGE) {
    const value = corridorRailGauge(gauge);
    return { strips: [{ type: 'rail', width: corridorStandardWidth('rail', value), gauge: value }] };
}

// The profile a corridor should have when it predates this model (or was drawn by the older picker,
// which only ever produced a total width and an unused sidewalk number).
//
// It must SUM TO THE WIDTH IT IS GIVEN: the footprint of an existing corridor — and every parcel split
// and proposal derived from it — is that width. So a legacy track stays one rail lane stretched to its
// recorded width, however far that is from a standard track. New tracks are seeded by the drawing tool
// with corridorDefaultTrackProfile() instead; this function never sees them.
function corridorProfileFromLegacy(width, sidewalkWidth, isTrack) {
    const total = Number(width);
    if (!Number.isFinite(total) || total <= 0) return null;
    if (isTrack) return { strips: [{ type: 'rail', width: total, gauge: CORRIDOR_DEFAULT_RAIL_GAUGE }] };

    const preset = CORRIDOR_PROFILE_PRESETS[total];
    if (preset) {
        const profile = { strips: preset.map(strip => ({ ...strip })) };
        const sw = Number(sidewalkWidth);
        if (Number.isFinite(sw) && sw > 0) {
            const adjusted = withSidewalkWidth(profile, sw);
            if (adjusted) return adjusted;
        }
        return profile;
    }

    // No preset: two lanes, plus sidewalks if the drawing recorded any and they fit.
    const sw = Number(sidewalkWidth);
    const sidewalk = (Number.isFinite(sw) && sw > 0 && total - 2 * sw >= 5) ? roundStripWidth(sw) : 0;
    const lane = roundStripWidth((total - 2 * sidewalk) / 2);
    const strips = [];
    if (sidewalk) strips.push({ type: 'sidewalk', width: sidewalk });
    // Right-hand traffic: left-of-travel (lower index) is the oncoming/backward lane, the right the forward one.
    strips.push({ type: 'driving', width: lane, direction: 'backward' }, { type: 'driving', width: lane, direction: 'forward' });
    if (sidewalk) strips.push({ type: 'sidewalk', width: sidewalk });
    return { strips };
}

// ---------------------------------------------------------------------------
// OSM tags <-> profile
//
// OSM does not store a cross-section directly; it stores a way with tags that describe one, in the
// per-side schemes (`sidewalk:left`, `cycleway:right`, `parking:both`) plus `lanes` for the carriageway.
// These two functions are the whole bridge. Everything downstream — the strip geometry, the surface
// table, the 2D and 3D renderers — sees only the profile, so an OSM street and a proposed street are
// drawn by one engine and retextured in one place.
// ---------------------------------------------------------------------------

function parseOsmNumber(value) {
    if (value === undefined || value === null) return NaN;
    // OSM widths are metres by default; strip a trailing unit rather than parsing "3.5 m" as NaN.
    const number = parseFloat(String(value).replace(',', '.'));
    return Number.isFinite(number) ? number : NaN;
}

// Resolve a per-side OSM tag: `key:left`, `key:right`, `key:both`, or the bare `key`.
// Returns the value that applies to `side`, or undefined.
function osmSideValue(tags, key, side) {
    if (!tags) return undefined;
    const specific = tags[`${key}:${side}`];
    if (specific !== undefined) return specific;
    const both = tags[`${key}:both`];
    if (both !== undefined) return both;
    const bare = tags[key];
    if (bare === undefined) return undefined;
    // The bare tag can itself name the side it applies to: `sidewalk=left`, `cycleway=right`.
    if (bare === 'left' || bare === 'right') return bare === side ? 'yes' : 'no';
    if (bare === 'both') return 'yes';
    return bare;
}

// Widths hang off the side, not the key: `cycleway:both:width`, `sidewalk:left:width`.
function osmSideWidth(tags, key, side, fallback) {
    const candidates = [`${key}:${side}:width`, `${key}:both:width`, `${key}:width`];
    for (const candidate of candidates) {
        const width = parseOsmNumber(tags && tags[candidate]);
        if (Number.isFinite(width) && width > 0) return width;
    }
    return fallback;
}

const OSM_ABSENT = new Set(['no', 'none', 'separate', 'false', '0']);
function osmSidePresent(value) {
    return value !== undefined && !OSM_ABSENT.has(String(value));
}

// The orientation OSM records for a side's parking, from either scheme: the current
// `parking:<side>:orientation=parallel|diagonal|perpendicular`, or the older `parking:lane:<side>`
// whose value IS the orientation. Undefined when the way says nothing (an untagged `parking:<side>=lane`).
function osmParkingOrientation(tags, side) {
    if (!tags) return undefined;
    const explicit = [`parking:${side}:orientation`, 'parking:both:orientation', 'parking:orientation']
        .map(key => tags[key])
        .find(value => value !== undefined);
    if (explicit !== undefined) return explicit;
    return osmSideValue(tags, 'parking:lane', side);
}

// OSM's orientation value -> our parking lane type. Anything we do not recognise (including a plain
// `lane` with no orientation) is parallel parking, the ordinary kerbside lane.
function corridorParkingTypeFromOsm(orientation) {
    if (orientation === 'perpendicular') return 'parking_perpendicular';
    if (orientation === 'diagonal' || orientation === 'inclined') return 'parking_angled';
    return 'parking';
}

// Build a cross-section from an OSM way's tags. `lanes` (or the highway class) gives the carriageway;
// the per-side schemes give what flanks it.
//
// A tagged `width` is authoritative and the driving lanes absorb whatever the furniture leaves. Without
// one — which is the overwhelmingly common case — the width is derived from the cross-section instead:
// lanes at their class's typical width plus the furniture. Guessing a total from the highway class and
// then subtracting furniture from it does the opposite, and throws away every street whose guess was
// too narrow for the furniture it actually has.
function corridorProfileFromOsmTags(tags, fallbackWidth) {
    const source = tags || {};
    if (source.railway) {
        // OSM's `gauge` is the same millimetre figure a rail lane carries, so it maps straight across —
        // and with no tagged width the gauge is what says how much street each track takes.
        const gauge = corridorRailGauge(source.gauge);
        const tracks = Math.max(1, parseInt(source.tracks, 10) || 1);
        const railWidth = parseOsmNumber(source.width) || Number(fallbackWidth) || (corridorStandardWidth('rail', gauge) * tracks);
        return { strips: Array.from({ length: tracks }, () => ({ type: 'rail', width: railWidth / tracks, gauge })) };
    }

    const taggedWidth = parseOsmNumber(source.width) || Number(fallbackWidth) || 0;

    // A footway, a path or a pedestrian street has no carriageway to flank.
    const carriagewayFree = OSM_CARRIAGEWAY_FREE_HIGHWAYS[source.highway];
    if (carriagewayFree) {
        return normalizeCorridorProfile([{
            type: carriagewayFree.type,
            width: taggedWidth > 0 ? taggedWidth : carriagewayFree.width,
            direction: carriagewayFree.type === 'cycleway' ? 'both' : undefined
        }]);
    }
    if (!source.highway && !(taggedWidth > 0)) return null;

    const oneway = source.oneway === 'yes' || source.oneway === '-1';
    const defaultLanes = oneway || OSM_SINGLE_LANE_HIGHWAYS.has(source.highway) ? 1 : 2;
    const laneCount = Math.max(1, parseInt(source.lanes, 10) || defaultLanes);
    // `lanes` counts every lane; a centre turn lane (`lanes:both_ways`) runs neither way, and the
    // rest split into forward and backward — from `lanes:forward`, else from `lanes:backward`, else
    // the oneway, else evenly with the odd lane forward.
    const bothWaysCount = Math.min(laneCount, Math.max(0, parseInt(source['lanes:both_ways'], 10) || 0));
    const directedCount = laneCount - bothWaysCount;
    const taggedForward = parseInt(source['lanes:forward'], 10);
    const taggedBackward = parseInt(source['lanes:backward'], 10);
    const wantedForward = Number.isFinite(taggedForward)
        ? taggedForward
        : (Number.isFinite(taggedBackward)
            ? directedCount - taggedBackward
            : (oneway ? (source.oneway === '-1' ? 0 : directedCount) : Math.ceil(directedCount / 2)));
    const forwardCount = Math.max(0, Math.min(directedCount, wantedForward));
    const backwardCount = directedCount - forwardCount;

    // A cycle lane's direction, per side. Right-hand traffic, laid out as the presets lay it out
    // (corridorStripSpans puts the first-listed lane on the LEFT of travel): the left half of a
    // two-way street carries the oncoming flow, so its cycle lane runs backward and the right one
    // forward. A oneway's cycle lanes run with the oneway, and `cycleway:<side>:oneway` overrides
    // either. corridorProfileToOsmTags writes that tag exactly when this default would be wrong.
    const cyclewayDirection = side => {
        const own = source[`cycleway:${side}:oneway`] ?? source['cycleway:both:oneway'];
        if (own === 'yes') return 'forward';
        if (own === '-1') return 'backward';
        if (own === 'no') return 'both';
        if (source.oneway === 'yes') return 'forward';
        if (source.oneway === '-1') return 'backward';
        return side === 'left' ? 'backward' : 'forward';
    };

    const left = [];
    const right = [];
    ['left', 'right'].forEach(side => {
        const target = side === 'left' ? left : right;
        const direction = cyclewayDirection(side);

        if (osmSidePresent(osmSideValue(source, 'sidewalk', side))) {
            target.push({ type: 'sidewalk', width: osmSideWidth(source, 'sidewalk', side, OSM_DEFAULT_SIDEWALK_WIDTH) });
        }
        if (osmSidePresent(osmSideValue(source, 'verge', side))) {
            target.push({ type: 'verge', width: osmSideWidth(source, 'verge', side, OSM_DEFAULT_VERGE_WIDTH) });
        }
        if (osmSidePresent(osmSideValue(source, 'cycleway', side))) {
            target.push({ type: 'cycleway', width: osmSideWidth(source, 'cycleway', side, OSM_DEFAULT_CYCLEWAY_WIDTH), direction });
        }
        // The current `parking:<side>` scheme, falling back to the older `parking:lane:<side>`. The
        // orientation picks which of the three parking lane types it is, and with it the default depth.
        const parking = osmSidePresent(osmSideValue(source, 'parking', side))
            || osmSidePresent(osmSideValue(source, 'parking:lane', side));
        if (parking) {
            const parkingType = corridorParkingTypeFromOsm(osmParkingOrientation(source, side));
            target.push({ type: parkingType, width: osmSideWidth(source, 'parking', side, corridorStandardWidth(parkingType)) });
        }
    });

    // A median splits the carriageway; it sits between the backward and forward lanes.
    const medianWidth = osmSidePresent(source.median)
        ? (parseOsmNumber(source['median:width']) || OSM_DEFAULT_MEDIAN_WIDTH)
        : 0;

    const flanks = [...left, ...right].reduce((sum, lane) => sum + lane.width, 0) + medianWidth;
    const defaultLaneWidth = OSM_LANE_WIDTH_BY_HIGHWAY[source.highway] || OSM_DEFAULT_LANE_WIDTH;
    const carriageway = taggedWidth > 0 ? taggedWidth - flanks : laneCount * defaultLaneWidth;
    // Only a tagged width can be wrong about its own furniture; refuse rather than draw lanes of air.
    if (carriageway < laneCount * 2) return null;

    // Left of travel to right, as every profile runs: the backward (oncoming) lanes first, then any
    // centre turn lanes, then the forward ones on the right — the order the presets use, so an
    // imported street and a drawn one put their traffic on the same side.
    const laneWidth = roundStripWidth(carriageway / laneCount);
    const driving = Array.from({ length: laneCount }, (unused, index) => ({
        type: 'driving',
        width: laneWidth,
        direction: index < backwardCount
            ? 'backward'
            : (index < backwardCount + bothWaysCount ? 'both' : 'forward')
    }));
    // Rounding the lane width loses up to a millimetre per lane; give the remainder back to the last one
    // so the cross-section sums to exactly the width the corridor has.
    driving[driving.length - 1].width = roundStripWidth(carriageway - laneWidth * (laneCount - 1));

    const carriagewayLanes = medianWidth
        ? [...driving.slice(0, backwardCount), { type: 'median', width: medianWidth }, ...driving.slice(backwardCount)]
        : driving;

    // Left flank runs outside-in; the right flank mirrors it, so it is emitted inside-out.
    return normalizeCorridorProfile([...left, ...carriagewayLanes, ...right.reverse()]);
}

// The inverse: describe a profile as OSM way tags.
//
// Lossy in the way OSM itself is. The per-side schemes record a lane's *presence and width*, never its
// position in the sequence: `cycleway:left` and `verge:left` cannot say which of the two is nearer the
// kerb. So a profile survives the round trip with its lanes intact and its total exact, but reordered
// into the canonical outside-in order corridorProfileFromOsmTags reads back (sidewalk, verge, cycleway,
// parking). Reordering lanes within one side is expressible in a stored profile and not in OSM tags.
// Directions survive: the traffic lanes as counts (backward ones come back on the left, as in the
// presets), and each side's cycle lane through `cycleway:<side>:oneway` when it needs one.
function corridorProfileToOsmTags(profile) {
    const normalized = normalizeCorridorProfile(profile);
    if (!normalized) return null;

    const lanes = normalized.strips;
    const centre = lanes.findIndex(lane => lane.type === 'driving' || lane.type === 'rail');
    if (centre === -1) return null;

    if (lanes[centre].type === 'rail') {
        const rails = lanes.filter(lane => lane.type === 'rail');
        const tags = { railway: 'rail', width: String(roundStripWidth(corridorProfileWidth(normalized))) };
        if (rails.length > 1) tags.tracks = String(rails.length);
        // `gauge` is a way tag, so it can only speak for the way as a whole: emitted when every track
        // on it has the same gauge, and dropped (rather than guessed) for a mixed tram/railway corridor.
        const gauges = new Set(rails.map(lane => corridorRailGaugeOf(lane)));
        if (gauges.size === 1) tags.gauge = String([...gauges][0]);
        return tags;
    }

    const sideOf = (index) => (index < centre ? 'left' : 'right');
    const driving = lanes.filter(lane => lane.type === 'driving');
    // A traffic lane with no direction runs forward — the editor shows and flips it as one — so it
    // counts toward `lanes:forward`; a `both` lane is a centre turn lane (`lanes:both_ways`).
    const directionOf = lane => lane.direction || 'forward';
    const forward = driving.filter(lane => directionOf(lane) === 'forward').length;
    const backward = driving.filter(lane => directionOf(lane) === 'backward').length;
    const bothWays = driving.length - forward - backward;

    const tags = {
        width: String(roundStripWidth(corridorProfileWidth(normalized))),
        lanes: String(driving.length)
    };
    if (forward === driving.length) tags.oneway = 'yes';
    else if (backward === driving.length) tags.oneway = '-1';
    else {
        tags['lanes:forward'] = String(forward);
        tags['lanes:backward'] = String(backward);
        if (bothWays) tags['lanes:both_ways'] = String(bothWays);
    }
    const median = lanes.find(lane => lane.type === 'median');
    if (median) {
        tags.median = 'yes';
        tags['median:width'] = String(roundStripWidth(median.width));
    }

    // `sidewalk:both=yes` + `sidewalk:both:width=2`, collapsing to one side when only one side has it,
    // and to per-side widths when the two sides differ — the same shape OSM's own per-side schemes take.
    // `matches` picks the lanes (a predicate, so the three parking types can be emitted as one group);
    // `orientationOf`, when given, also writes `<key>:<side>:orientation` the same collapsing way.
    const emit = (matches, key, presentValue, orientationOf) => {
        const found = lanes
            .map((lane, index) => ({ lane, index }))
            .filter(entry => matches(entry.lane));
        if (!found.length) return;

        const sides = new Set(found.map(entry => sideOf(entry.index)));
        const sideKey = sides.size === 2 ? 'both' : [...sides][0];
        tags[`${key}:${sideKey}`] = presentValue;

        const widths = new Set(found.map(entry => roundStripWidth(entry.lane.width)));
        if (widths.size === 1) {
            tags[`${key}:${sideKey}:width`] = String([...widths][0]);
        } else {
            found.forEach(entry => { tags[`${key}:${sideOf(entry.index)}:width`] = String(roundStripWidth(entry.lane.width)); });
        }

        if (orientationOf) {
            const orientations = new Set(found.map(entry => orientationOf(entry.lane)));
            if (orientations.size === 1) {
                tags[`${key}:${sideKey}:orientation`] = [...orientations][0];
            } else {
                found.forEach(entry => { tags[`${key}:${sideOf(entry.index)}:orientation`] = orientationOf(entry.lane); });
            }
        }
    };

    // OSM's orientation values are our own, save that an angled bay is `diagonal` there.
    const osmParkingOrientationValue = lane => (corridorParkingOrientation(lane.type) === 'angled'
        ? 'diagonal' : corridorParkingOrientation(lane.type));

    emit(lane => lane.type === 'sidewalk', 'sidewalk', 'yes');
    emit(lane => lane.type === 'verge', 'verge', 'yes');
    emit(lane => lane.type === 'cycleway', 'cycleway', 'lane');
    emit(lane => !!corridorParkingOrientation(lane.type), 'parking', 'lane', osmParkingOrientationValue);

    // A cycle lane running against the direction corridorProfileFromOsmTags assumes for its side
    // (with a oneway's traffic; otherwise backward on the left, forward on the right) says so with
    // `cycleway:<side>:oneway`. One running the assumed way needs no tag, so the presets add none.
    ['left', 'right'].forEach(side => {
        const lane = lanes.find((candidate, index) => candidate.type === 'cycleway' && sideOf(index) === side);
        if (!lane) return;
        const assumed = tags.oneway === 'yes'
            ? 'forward'
            : (tags.oneway === '-1' ? 'backward' : (side === 'left' ? 'backward' : 'forward'));
        const actual = directionOf(lane);
        if (actual === assumed) return;
        tags[`cycleway:${side}:oneway`] = actual === 'forward' ? 'yes' : (actual === 'backward' ? '-1' : 'no');
    });
    return tags;
}

// The profile for an OSM road feature as produced by road-detection.js `osmToGeoJSON`.
function corridorProfileFromOsmFeature(feature) {
    const properties = (feature && feature.properties) || {};
    const tags = properties.osmTags || {};
    const width = parseOsmNumber(properties.width) || parseOsmNumber(tags.width);
    return corridorProfileFromOsmTags({ highway: properties.highway, railway: properties.railway, ...tags }, width);
}

// Read the profile off a stored corridor definition, synthesising one for corridors drawn before
// profiles existed. Always returns a profile whose total equals the definition's width — or null for a
// DESIGNATION, which has no cross-section at all (see below): its width is a leftover number, and
// synthesising lanes out of it would furnish a road that was never designed.
function corridorProfileOf(definition) {
    if (!definition) return null;
    const stored = normalizeCorridorProfile(definition.profile);
    if (stored) return stored;
    if (corridorIsDesignation(definition)) return null;
    const isTrack = !!(definition.metadata && definition.metadata.isTrack);
    return corridorProfileFromLegacy(definition.width, definition.sidewalkWidth, isTrack);
}

// ---------------------------------------------------------------------------
// Track-ness
//
// A road and a track are the SAME object — a centerline plus a cross-section — so "is this a track"
// is not a property the object carries, it is a fact about its lanes: a corridor is a track iff its
// cross-section contains a rail lane. Add a rail lane to a street in the cross-section editor and it
// is a tram street; take the rails out of a track and what is left is a road. Everything that used to
// branch on a stored `isTrack` flag asks these two instead.
// ---------------------------------------------------------------------------

function corridorProfileHasRail(profile) {
    const normalized = normalizeCorridorProfile(profile);
    return !!normalized && normalized.strips.some(strip => strip.type === 'rail');
}

// The same question of a stored corridor. Corridors created before rail was a lane type carry
// `metadata.isTrack`; that flag still answers for them (their profile is synthesised from a bare
// width, so it cannot be asked). It is honoured, never rewritten — the footprint is the width, and
// nothing may move it under an existing proposal.
function corridorIsTrack(definition) {
    if (!definition) return false;
    if (corridorProfileHasRail(corridorProfileOf(definition))) return true;
    return !!(definition.metadata && definition.metadata.isTrack === true);
}

// ---------------------------------------------------------------------------
// Designations
//
// A DESIGNATION is not a corridor that was designed — it is existing parcels DECLARED to be road land.
// Nothing was laid out: it has no centerline, only the polygon of the parcels it names. That makes it a
// different kind of object from everything above, and the distinction is not cosmetic: a corridor's
// footprint is swept from its centerline at its cross-section's width, while a designation's footprint
// simply IS the land it names. So a designation has no lanes to edit, no rails to lay, no strips to draw
// — and asking it for a cross-section would invent one out of a width that means nothing.
//
// This is the honest replacement for ticking a parcel "road" by hand: it goes through the proposal
// lifecycle, so it carries an author, terms and a record, and unapplying it gives the land back.
// ---------------------------------------------------------------------------
function corridorIsDesignation(definition) {
    if (!definition) return false;
    if (corridorCenterlineOf(definition).length) return false;
    return !!definition.polygon;
}

// ---------------------------------------------------------------------------
// Per-segment cross-sections
//
// One road proposal is a NETWORK of segments (nodes and edges) and the cross-section is a
// per-segment property: `definition.profile` is the default, `definition.segmentProfiles`
// ({ segmentId: profile }) overrides it segment by segment. A collector road with narrow
// side streets is ONE network whose segments differ in width. Everything that needs "the"
// profile of a piece of road goes through these helpers.
// ---------------------------------------------------------------------------

function corridorSegmentProfile(definition, segmentId) {
    const override = (definition && definition.segmentProfiles && segmentId !== undefined && segmentId !== null)
        ? definition.segmentProfiles[String(segmentId)]
        : null;
    return (override && normalizeCorridorProfile(override)) || corridorProfileOf(definition);
}

// The corridor as [{segmentId, points, profile, width}] — THE way to iterate a corridor
// whenever widths may differ per segment (footprint, strips, cuts, obstacle checks).
function corridorSegmentEntries(definition) {
    const segments = corridorCenterlineOf(definition);
    const ids = Array.isArray(definition && definition.segmentIds) ? definition.segmentIds : [];
    return segments.map((points, index) => {
        const segmentId = (ids[index] !== undefined && ids[index] !== null) ? String(ids[index]) : null;
        const profile = corridorSegmentProfile(definition, segmentId);
        const width = corridorProfileWidth(profile) || Number(definition && definition.width) || 10;
        return { segmentId, points, profile, width };
    });
}

function corridorHasSegmentProfiles(definition) {
    const map = definition && definition.segmentProfiles;
    return !!map && Object.keys(map).some(key => map[key]);
}

// The centerline of a stored corridor, as segments of {lat,lng}. A definition holds either one flat
// list of points (older single-segment corridors) or a list of segments; both live under `points`.
function corridorCenterlineOf(definition) {
    const raw = definition && (
        (Array.isArray(definition.points) && definition.points.length && definition.points)
        || (Array.isArray(definition.segments) && definition.segments)
    );
    if (!raw || !raw.length) return [];

    // `level` rides along because this is the funnel every consumer of a stored centreline goes
    // through, including the acquisition footprint — rebuilding a bare {lat,lng} here is precisely
    // how a vertical profile gets silently discarded and a tunnel starts taking land again. It is
    // only attached when the stored point actually has one, so a corridor without levels still
    // yields the identical bare {lat,lng} objects it always did.
    const toPoint = (point) => {
        if (!point) return null;
        const lat = Number(point.lat !== undefined ? point.lat : (Array.isArray(point) ? point[1] : NaN));
        const lng = Number(point.lng !== undefined ? point.lng : (Array.isArray(point) ? point[0] : NaN));
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
        const level = (point && typeof point.level === 'number' && Number.isFinite(point.level))
            ? point.level
            : null;
        return level === null ? { lat, lng } : { lat, lng, level };
    };

    const isFlat = !Array.isArray(raw[0]);
    const segments = isFlat ? [raw] : raw;
    return segments
        .map(segment => (Array.isArray(segment) ? segment.map(toPoint).filter(Boolean) : []))
        .filter(segment => segment.length >= 2);
}

// Signed offsets of each strip from the centerline, positive to the left of the direction of travel.
// `left` is always the larger value, so a strip spans [right, left].
function corridorStripSpans(profile) {
    const normalized = normalizeCorridorProfile(profile);
    if (!normalized) return [];
    const total = corridorProfileWidth(normalized);
    let cursor = total / 2;
    return normalized.strips.map((strip, index) => {
        const left = cursor;
        cursor -= strip.width;
        return { ...strip, index, left, right: cursor };
    });
}

// ---------------------------------------------------------------------------
// Geometry
//
// A strip is the band between two parallel offsets of the centerline. Both offsets are signed, so a
// strip need not contain the centerline (a kerbside parking lane does not).
//
// The corridor outline is built elsewhere by unioning one quad per edge with a bevel at each joint.
// Strips cannot be: unioned quads double-cover the inside of every bend, and adjacent strips would
// then bleed into one another exactly where the eye is drawn. So the boundaries are offset polylines
// with mitred joints — two neighbouring strips share a boundary offset, hence share its mitre points
// exactly, and the strips tile the corridor with no gap and no overlap.
// ---------------------------------------------------------------------------

// A mitre this much longer than the offset means a near-reversal; fall back to a bevel rather than
// letting the joint shoot off to infinity.
const CORRIDOR_MITRE_LIMIT = 4;

// Offset a polyline by a signed distance (positive is left of travel).
//
// Joints follow the corridor outline the rest of the app already builds by unioning one quad per edge:
// on the *inside* of a turn the two quads overlap and their union's boundary is the mitre point, while
// on the *outside* the gap is filled with a bevel. Reproducing that here — rather than mitring both
// sides — is what keeps the outermost strips flush with the corridor's own edge instead of poking out
// past it at every bend.
function offsetPolylinePlanar(pointsXY, offset) {
    const normals = [];
    for (let i = 0; i < pointsXY.length - 1; i++) {
        const dx = pointsXY[i + 1][0] - pointsXY[i][0];
        const dy = pointsXY[i + 1][1] - pointsXY[i][1];
        const length = Math.hypot(dx, dy);
        if (length < 1e-9) continue;
        normals.push({ index: i, normal: [-dy / length, dx / length], direction: [dx / length, dy / length] });
    }
    if (!normals.length) return null;

    const move = (point, normal, distance) => [point[0] + normal[0] * distance, point[1] + normal[1] * distance];
    const result = [move(pointsXY[normals[0].index], normals[0].normal, offset)];

    for (let i = 1; i < normals.length; i++) {
        const previous = normals[i - 1];
        const next = normals[i];
        const vertex = pointsXY[next.index];

        const mx = previous.normal[0] + next.normal[0];
        const my = previous.normal[1] + next.normal[1];
        const mitreLength = Math.hypot(mx, my);

        // Which side of this turn is the outside? Left turns (cross > 0) bulge to the right.
        const cross = previous.direction[0] * next.direction[1] - previous.direction[1] * next.direction[0];
        const onOutside = (cross > 0) ? offset < 0 : offset > 0;

        const bevel = () => result.push(move(vertex, previous.normal, offset), move(vertex, next.normal, offset));

        if (mitreLength < 1e-9) {
            bevel(); // the line doubles back on itself; a mitre is undefined
            continue;
        }
        if (onOutside || Math.abs(cross) < 1e-12) {
            bevel();
            continue;
        }

        const mitre = [mx / mitreLength, my / mitreLength];
        const cosHalf = mitre[0] * previous.normal[0] + mitre[1] * previous.normal[1]; // cos(half the turn angle)
        if (Math.abs(cosHalf) < 1 / CORRIDOR_MITRE_LIMIT) {
            bevel();
            continue;
        }
        result.push(move(vertex, mitre, offset / cosHalf));
    }

    const last = normals[normals.length - 1];
    result.push(move(pointsXY[last.index + 1], last.normal, offset));
    return result;
}

// Closed centerlines have no end caps. Keeping this separate from offsetPolylinePlanar is important:
// the 2D renderer intentionally retains its established even-odd strip behaviour, while the 3D
// renderer needs two clean cyclic boundaries so it can mesh a band with a real hole.
function offsetClosedPolylinePlanar(pointsXY, offset) {
    if (!Array.isArray(pointsXY) || pointsXY.length < 4 || !Number.isFinite(offset)) return null;
    const EPS = 1e-9;
    const same = (a, b) => a && b && Math.hypot(a[0] - b[0], a[1] - b[1]) < EPS;
    const points = pointsXY.slice();
    if (same(points[0], points[points.length - 1])) points.pop();

    const clean = [];
    points.forEach(point => {
        if (Array.isArray(point) && point.length >= 2 && Number.isFinite(point[0]) && Number.isFinite(point[1])
            && (!clean.length || !same(clean[clean.length - 1], point))) clean.push(point);
    });
    if (clean.length >= 2 && same(clean[0], clean[clean.length - 1])) clean.pop();
    if (clean.length < 3) return null;

    const edges = clean.map((point, index) => {
        const next = clean[(index + 1) % clean.length];
        const dx = next[0] - point[0];
        const dy = next[1] - point[1];
        const length = Math.hypot(dx, dy);
        if (length < EPS) return null;
        return { normal: [-dy / length, dx / length], direction: [dx / length, dy / length] };
    });
    if (edges.some(edge => !edge)) return null;

    const result = [];
    const push = point => {
        if (!result.length || !same(result[result.length - 1], point)) result.push(point);
    };
    const move = (point, normal) => [point[0] + normal[0] * offset, point[1] + normal[1] * offset];

    clean.forEach((vertex, index) => {
        const previous = edges[(index - 1 + edges.length) % edges.length];
        const next = edges[index];
        const mx = previous.normal[0] + next.normal[0];
        const my = previous.normal[1] + next.normal[1];
        const mitreLength = Math.hypot(mx, my);
        const cross = previous.direction[0] * next.direction[1] - previous.direction[1] * next.direction[0];
        const onOutside = (cross > 0) ? offset < 0 : offset > 0;
        const bevel = () => {
            push(move(vertex, previous.normal));
            push(move(vertex, next.normal));
        };

        if (mitreLength < EPS || onOutside || Math.abs(cross) < 1e-12) {
            bevel();
            return;
        }
        const mitre = [mx / mitreLength, my / mitreLength];
        const cosHalf = mitre[0] * previous.normal[0] + mitre[1] * previous.normal[1];
        if (Math.abs(cosHalf) < 1 / CORRIDOR_MITRE_LIMIT) {
            bevel();
            return;
        }
        push([vertex[0] + mitre[0] * offset / cosHalf, vertex[1] + mitre[1] * offset / cosHalf]);
    });
    return result.length >= 3 ? result : null;
}

function planarRingSignedArea(ring) {
    if (!Array.isArray(ring) || ring.length < 3) return 0;
    let twiceArea = 0;
    for (let i = 0; i < ring.length; i += 1) {
        const a = ring[i];
        const b = ring[(i + 1) % ring.length];
        twiceArea += a[0] * b[1] - b[0] * a[1];
    }
    return twiceArea / 2;
}

// Do two planar segments [a1,a2] and [b1,b2] properly cross? Endpoints touching don't count —
// we only care about a genuine interior crossing, which is what makes a strip ring a bowtie.
function planarSegmentsCross(a1, a2, b1, b2) {
    const cross = (o, p, q) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
    const d1 = cross(a1, a2, b1);
    const d2 = cross(a1, a2, b2);
    const d3 = cross(b1, b2, a1);
    const d4 = cross(b1, b2, a2);
    // Strictly opposite signs on both tests = the segments straddle each other (interior crossing).
    return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

// Does a closed ring of planar [x,y] points cross itself? A self-intersecting strip ring (a bowtie
// from an offset larger than a bend's turn radius — exactly what dragging a road node can create)
// extrudes into degenerate, black-lit 3D geometry, so the caller drops such a strip rather than mesh it.
function ringSelfIntersectsXY(ring) {
    const n = ring.length;
    if (n < 4) return false;
    for (let i = 0; i < n; i += 1) {
        const a1 = ring[i];
        const a2 = ring[(i + 1) % n];
        // Compare against every later edge that shares no vertex with edge i (skip i's neighbours).
        for (let j = i + 2; j < n; j += 1) {
            if (i === 0 && j === n - 1) continue; // edge (n-1,0) is adjacent to edge (0,1)
            const b1 = ring[j];
            const b2 = ring[(j + 1) % n];
            if (planarSegmentsCross(a1, a2, b1, b2)) return true;
        }
    }
    return false;
}

// The ring for one strip, in whatever coordinate system `pointsXY` is in (metres, x east, y north):
// the left boundary forward, the right boundary back. Kept free of the projection so it can be unit
// tested without a map.
function corridorStripRingPlanar(pointsXY, left, right) {
    if (!Array.isArray(pointsXY) || pointsXY.length < 2) return null;
    if (!Number.isFinite(left) || !Number.isFinite(right) || left === right) return null;

    const leftSide = offsetPolylinePlanar(pointsXY, Math.max(left, right));
    const rightSide = offsetPolylinePlanar(pointsXY, Math.min(left, right));
    if (!leftSide || !rightSide) return null;
    // NOTE: a sharp bend can fold this ring into a bowtie. That renders FINE in 2D (Leaflet fills it
    // with the even-odd rule), so the ring is returned as-is here — dropping it stripped the asphalt
    // off legitimate roads. The bowtie only misbehaves in 3D (ExtrudeGeometry → black faces), so the
    // self-intersection guard (ringSelfIntersectsXY) lives in the 3D mesh builder, not here.
    return [...leftSide, ...rightSide.reverse()];
}

// 3D-only closed-strip representation: an outer boundary plus an inner hole. This helper is pure;
// buildCorridorStripPolygon deliberately continues returning the established flat ring for 2D.
function corridorClosedStripPolygonPlanar(pointsXY, left, right) {
    if (!Array.isArray(pointsXY) || pointsXY.length < 4) return null;
    const first = pointsXY[0];
    const last = pointsXY[pointsXY.length - 1];
    if (!first || !last || Math.hypot(first[0] - last[0], first[1] - last[1]) >= 1e-7) return null;
    const a = offsetClosedPolylinePlanar(pointsXY, Math.max(left, right));
    const b = offsetClosedPolylinePlanar(pointsXY, Math.min(left, right));
    if (!a || !b || ringSelfIntersectsXY(a) || ringSelfIntersectsXY(b)) return null;
    return Math.abs(planarRingSignedArea(a)) >= Math.abs(planarRingSignedArea(b)) ? [a, b] : [b, a];
}

// Every builder below works in an explicit metric frame (metric-frame.js; the corridor's own,
// corridor-footprint.js frameForDefinition), never a city's projection (projections.md §2).
function assertCorridorFrame(frame, caller) {
    if (!frame || typeof frame.latLngToMetric !== 'function' || typeof frame.metricToLatLng !== 'function') {
        throw new Error(`${caller}: a metric frame is required (projections.md §2)`);
    }
}

// One strip of one centerline segment, as Leaflet LatLngs.
function buildCorridorStripPolygon(points, left, right, frame) {
    assertCorridorFrame(frame, 'buildCorridorStripPolygon');
    if (!Array.isArray(points) || points.length < 2) return null;

    const planar = points
        .map(point => (point && Number.isFinite(point.lat) && Number.isFinite(point.lng)) ? frame.latLngToMetric(point.lat, point.lng) : null)
        .filter(xy => Array.isArray(xy) && Number.isFinite(xy[0]) && Number.isFinite(xy[1]));
    if (planar.length < 2) return null;

    const ring = corridorStripRingPlanar(planar, left, right);
    if (!ring) return null;
    return ring.map(([x, y]) => {
        const [lat, lng] = frame.metricToLatLng(x, y);
        return { lat, lng };
    });
}

// Every strip of a whole corridor, ready to draw: `[{ type, left, right, polygons }]`, left edge first.
// `segments` is either one centerline (LatLng[]) or several disjoint ones (LatLng[][]); a strip gets one
// polygon per centerline segment, left unmerged because the segments are disjoint bands, not one shape.
function buildCorridorStrips(segments, profile, frame) {
    const spans = corridorStripSpans(profile);
    if (!spans.length) return [];

    const isLatLng = (p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lng);
    const centerlines = (Array.isArray(segments) && segments.length && isLatLng(segments[0]))
        ? [segments]
        : (Array.isArray(segments) ? segments.filter(seg => Array.isArray(seg) && seg.length >= 2) : []);
    if (!centerlines.length) return [];

    return spans.map(span => ({
        ...span,
        polygons: centerlines
            .map(centerline => buildCorridorStripPolygon(centerline, span.left, span.right, frame))
            .filter(Boolean)
    })).filter(strip => strip.polygons.length);
}

// Sample a planar polyline at a fixed interval. Short lines still get one mark at their midpoint so a
// cycle path or sidewalk remains identifiable before it reaches a full spacing interval.
function samplePolylinePlanar(pointsXY, spacing, phase = null) {
    if (!Array.isArray(pointsXY) || pointsXY.length < 2) return [];
    const step = Number(spacing);
    if (!Number.isFinite(step) || step <= 0) return [];

    const edges = [];
    let total = 0;
    for (let i = 0; i < pointsXY.length - 1; i++) {
        const a = pointsXY[i];
        const b = pointsXY[i + 1];
        const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (length < 1e-9) continue;
        edges.push({ a, b, start: total, length });
        total += length;
    }
    if (!edges.length) return [];

    const hasPhase = phase !== null && phase !== undefined && Number.isFinite(Number(phase));
    const first = total < step ? total / 2 : (hasPhase ? Number(phase) : step / 2);
    const samples = [];
    for (let distance = Math.max(0, first); distance < total - 1e-9; distance += step) {
        const edge = edges.find(candidate => distance <= candidate.start + candidate.length + 1e-9) || edges[edges.length - 1];
        const local = Math.max(0, Math.min(1, (distance - edge.start) / edge.length));
        const dx = edge.b[0] - edge.a[0];
        const dy = edge.b[1] - edge.a[1];
        samples.push({
            point: [edge.a[0] + dx * local, edge.a[1] + dy * local],
            angle: Math.atan2(dy, dx),
            distance
        });
    }
    return samples;
}

// Painted bike/pedestrian symbols and planted verge trees all come from the same strip centerlines.
// The result is view-agnostic: Leaflet and Three.js only decide how each point becomes pixels/meshes.
function buildCorridorDecorations(segments, profile, frame) {
    assertCorridorFrame(frame, 'buildCorridorDecorations');
    const spans = corridorStripSpans(profile);
    if (!spans.length) return [];
    const isLatLng = point => point && Number.isFinite(point.lat) && Number.isFinite(point.lng);
    const centerlines = (Array.isArray(segments) && segments.length && isLatLng(segments[0]))
        ? [segments]
        : (Array.isArray(segments) ? segments.filter(segment => Array.isArray(segment) && segment.length >= 2) : []);
    const planarCenterlines = centerlines.map(segment => segment.map(point => frame.latLngToMetric(point.lat, point.lng)));
    const junctionPoints = findCorridorJunctionsPlanar(planarCenterlines).map(junction => junction.point);
    const junctionClearance = corridorProfileWidth(profile) / 2 + 4;
    const decorations = [];

    spans.forEach(strip => {
        let kind = null;
        let spacing = null;
        if (strip.type === 'cycleway') { kind = 'bike'; spacing = CORRIDOR_DECORATION_SPACING.bike; }
        else if (strip.type === 'sidewalk') { kind = 'pedestrian'; spacing = CORRIDOR_DECORATION_SPACING.pedestrian; }
        else if (CORRIDOR_GREEN_TYPES.has(strip.type) && corridorLandscapeOf(strip) === 'trees') {
            kind = 'tree'; spacing = CORRIDOR_DECORATION_SPACING.tree;
        } else if (corridorParkingOrientation(strip.type) && strip.treeEvery > 0) {
            // A tree in every Nth parking bay: spaced N bays apart, so the trees line up with the stalls.
            kind = 'tree';
            const bay = CORRIDOR_PARKING_BAYS[corridorParkingOrientation(strip.type)] || CORRIDOR_PARKING_BAYS.parallel;
            spacing = strip.treeEvery * bay.spacingAlong;
        }
        if (!kind) return;

        const offset = (strip.left + strip.right) / 2;
        centerlines.forEach((centerline, segmentIndex) => {
            const offsetLine = buildCorridorOffsetLine(centerline, offset, frame);
            if (!offsetLine) return;
            const planar = offsetLine.map(point => frame.latLngToMetric(point.lat, point.lng));
            samplePolylinePlanar(planar, spacing).forEach(sample => {
                if (junctionPoints.some(point => Math.hypot(sample.point[0] - point[0], sample.point[1] - point[1]) < junctionClearance)) {
                    return;
                }
                const [lat, lng] = frame.metricToLatLng(sample.point[0], sample.point[1]);
                decorations.push({
                    kind,
                    lat,
                    lng,
                    angle: sample.angle,
                    stripIndex: strip.index,
                    stripWidth: strip.width,
                    segmentIndex
                });
            });
        });
    });
    return decorations;
}

// A junction is any shared centerline node with at least three distinct incident arms. This is OSM's
// topology directly: the node is the intersection, and the arms are the way edges that meet there.
function findCorridorJunctionsPlanar(segmentsXY) {
    const nodes = new Map();
    const keyOf = point => `${Math.round(point[0] * 100) / 100},${Math.round(point[1] * 100) / 100}`;
    const addArm = (point, other) => {
        const dx = other[0] - point[0];
        const dy = other[1] - point[1];
        const length = Math.hypot(dx, dy);
        if (length < 1e-9) return;
        const key = keyOf(point);
        if (!nodes.has(key)) nodes.set(key, { point: [point[0], point[1]], arms: [] });
        const arm = [dx / length, dy / length];
        const entry = nodes.get(key);
        if (!entry.arms.some(existing => existing[0] * arm[0] + existing[1] * arm[1] > 0.9999)) {
            entry.arms.push(arm);
        }
    };

    (segmentsXY || []).forEach(segment => {
        if (!Array.isArray(segment)) return;
        segment.forEach((point, index) => {
            if (index > 0) addArm(point, segment[index - 1]);
            if (index < segment.length - 1) addArm(point, segment[index + 1]);
        });
    });
    return [...nodes.values()].filter(node => node.arms.length >= 3).map(node => ({ ...node, degree: node.arms.length }));
}

// ---------------------------------------------------------------------------
// Junctions
//
// A junction is an object of its own: the node, its arms sorted by angle, a kerb-return fillet
// between every pair of angular neighbours, the carriageway surface that results, the footway band
// around each corner, the land each corner needs, stop lines and zebras on the approaches, and how
// far from the node each arm belongs to the junction. corridor-junction.js builds that geometry in
// metres; this file feeds it cross-sections and turns the result into lat/lng treatments every
// renderer draws the same way (road-editor.md decision 1). Arms carry the profile of the road piece
// they belong to, so a collector keeps its full reach where a side street gets a modest one.
// ---------------------------------------------------------------------------

function corridorJunctionModule() {
    if (typeof window !== 'undefined' && window.__corridorJunction) return window.__corridorJunction;
    if (typeof require === 'function') return require('./corridor-junction.js');
    throw new Error('corridor-profile: corridor-junction.js is not loaded');
}

// What a junction (and the land it takes) needs from a cross-section, in the stretch's own frame
// (left of the direction of travel is positive): where the kerbs are, how much footway lies
// outside them, which lanes run towards each end, and the outermost strip on each side (what a
// corner is paved as). Null for a profile without strips.
function corridorProfileEdges(profile) {
    const spans = corridorStripSpans(profile);
    if (!spans.length) return null;
    const total = corridorProfileWidth(profile);
    const roadway = spans.filter(strip => strip.type !== 'sidewalk' && strip.type !== 'verge');
    const carriagewayLeft = roadway.length ? Math.max(...roadway.map(strip => strip.left)) : total / 2;
    const carriagewayRight = roadway.length ? Math.min(...roadway.map(strip => strip.right)) : -total / 2;
    // The lanes that flow INTO a given end: towards the start means backward lanes, towards the
    // end means forward lanes; a lane without a direction flows both ways.
    const inboundSpan = towardStart => {
        const lanes = spans.filter(strip => isMarkedTrafficLane(strip)
            && (!strip.direction || strip.direction === 'both' || strip.direction === (towardStart ? 'backward' : 'forward')));
        if (!lanes.length) return null;
        return [Math.min(...lanes.map(strip => strip.right)), Math.max(...lanes.map(strip => strip.left))];
    };
    return {
        total,
        carriagewayLeft,
        carriagewayRight,
        outerLeft: Math.max(0, total / 2 - carriagewayLeft),
        outerRight: Math.max(0, carriagewayRight + total / 2),
        hasSidewalk: spans.some(strip => strip.type === 'sidewalk'),
        inbound: { start: inboundSpan(true), end: inboundSpan(false) },
        outerStrips: { left: spans[0], right: spans[spans.length - 1] }
    };
}

// Edges for an arm that only knows its total width (a drawing preview built from widths alone).
function corridorEdgesFromWidth(width) {
    const total = Number(width) > 0 ? Number(width) : 10;
    return { total, carriagewayLeft: total / 2, carriagewayRight: -total / 2, outerLeft: 0, outerRight: 0, hasSidewalk: false, inbound: { start: null, end: null }, outerStrips: { left: null, right: null } };
}

// Which nodes get a junction treatment.
//
// Three or more arms is a junction by any reading. TWO arms is the case that was missing: a node
// where two DIFFERENT corridors meet end to end. Within one corridor a two-arm node is just a bend
// in a polyline, and the strip offsetting already mitres it — but two corridors are offset
// independently, so at the bend their ribbons overlap on the inside (a dark wedge across the kerb)
// and leave a notch on the outside. Nothing joined them because nothing was looking for a two-arm
// node. The topology already calls it a junction (corridor-network-nodes.js gives the two records a
// shared node); only the drawing did not.
//
// A join that is nearly straight is left alone: the ribbons already line up, and patching it would
// only break the lane markings running through it for no gain.
const JUNCTION_STRAIGHT_DOT = -0.996;   // ~5 degrees of turn

function junctionNeedsTreatment(node) {
    const arms = (node && node.arms) || [];
    if (arms.length >= 3) return true;
    if (arms.length !== 2) return false;
    const ids = new Set(arms.map(arm => arm.corridorId).filter(id => id !== undefined && id !== null).map(String));
    if (ids.size < 2) return false;
    const dot = arms[0].dir[0] * arms[1].dir[0] + arms[0].dir[1] * arms[1].dir[1];
    return dot > JUNCTION_STRAIGHT_DOT;
}

// Planar entries for the junction finder: one per road piece, with its profile and identity.
function corridorJunctionPriority(profile, corridorId, segmentId) {
    const normalized = normalizeCorridorProfile(profile);
    const edges = normalized && corridorProfileEdges(normalized);
    if (!normalized || !edges) return null;
    const stableStrip = strip => Object.fromEntries(Object.keys(strip).sort().map(key => [key, strip[key]]));
    const stableId = [corridorId, segmentId].map(value => value === null || value === undefined ? '' : String(value));
    const orientedKey = reversed => {
        const leftEdge = reversed ? -edges.carriagewayRight : edges.carriagewayLeft;
        const rightEdge = reversed ? edges.carriagewayLeft : -edges.carriagewayRight;
        const outerLeft = reversed ? edges.outerRight : edges.outerLeft;
        const outerRight = reversed ? edges.outerLeft : edges.outerRight;
        const inbound = reversed ? edges.inbound.end : edges.inbound.start;
        const inboundOutward = inbound && reversed ? [-inbound[1], -inbound[0]] : inbound;
        const strips = (reversed ? reversedCorridorProfile(normalized) : normalized).strips.map(stableStrip);
        // This signature is a deterministic tie policy, not a claim about which duplicate source
        // is authoritative. Width remains the primary choice; canonical oriented content and then
        // stable source IDs only decide otherwise equal candidates.
        return JSON.stringify([
            leftEdge, rightEdge, outerLeft, outerRight, edges.total, edges.hasSidewalk,
            inboundOutward, strips, stableId
        ]);
    };
    return { forward: orientedKey(false), reverse: orientedKey(true) };
}

function planarJunctionEntries(entries, frame) {
    return (entries || [])
        .filter(entry => Array.isArray(entry && entry.points) && entry.points.length >= 2)
        .map(entry => ({
            profile: entry.profile || null,
            corridorId: (entry.corridorId !== undefined && entry.corridorId !== null) ? String(entry.corridorId) : null,
            segmentId: (entry.segmentId !== undefined && entry.segmentId !== null) ? String(entry.segmentId) : null,
            width: entry.profile ? corridorProfileWidth(entry.profile) : Number(entry.width) || 0,
            junctionPriority: entry.profile ? corridorJunctionPriority(
                entry.profile,
                (entry.corridorId !== undefined && entry.corridorId !== null) ? String(entry.corridorId) : null,
                (entry.segmentId !== undefined && entry.segmentId !== null) ? String(entry.segmentId) : null
            ) : null,
            points: entry.points
                .map(point => {
                    if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return null;
                    const xy = frame.latLngToMetric(point.lat, point.lng);
                    if (!Array.isArray(xy) || !Number.isFinite(xy[0]) || !Number.isFinite(xy[1])) return null;
                    // Preserve level only as a topological key for node matching. Junction math
                    // continues to use x/y alone; omitted levels share ground level 0.
                    const level = (typeof point.level === 'number' && Number.isFinite(point.level)) ? point.level : 0;
                    return [xy[0], xy[1], level];
                })
                .filter(xy => Array.isArray(xy) && Number.isFinite(xy[0]) && Number.isFinite(xy[1]))
        }))
        .filter(entry => entry.points.length >= 2);
}

function corridorJunctionNodes(planarEntries) {
    return corridorJunctionModule().collectNodes(planarEntries, { minDegree: 2 }).map(node => {
        node.arms.forEach(arm => { arm.corridorId = arm.entry.corridorId; });
        return node;
    });
}

// One junction's treatment, in lat/lng: what the 2D map paints, the 3D model builds and the land
// take unions. `arms` name the road pieces that meet (and how far each is the junction's), so the
// marking builders can stop their lines at the stop line.
function junctionTreatmentFor(node, frame, options = {}) {
    const junctionApi = corridorJunctionModule();
    const arms = node.arms.map(arm => {
        const edges = (arm.entry && arm.entry.profile && corridorProfileEdges(arm.entry.profile)) || corridorEdgesFromWidth(arm.width);
        return {
            dir: arm.dir,
            reversed: arm.reversed === true,
            length: arm.length,
            edges,
            hasSidewalk: edges.hasSidewalk,
            inbound: arm.reversed ? edges.inbound.end : edges.inbound.start,
            outerStrips: edges.outerStrips,
            corridorId: arm.corridorId,
            segmentId: arm.entry ? arm.entry.segmentId : null,
            entryIndex: arm.entryIndex,
            vertexIndex: arm.vertexIndex,
            step: arm.step
        };
    });
    const junction = junctionApi.buildJunction(node.point, arms, { crossings: options.crossings !== false });
    if (!junction) return null;
    const toLatLng = ring => planarRingToLatLng(ring, frame);
    const [lat, lng] = frame.metricToLatLng(node.point[0], node.point[1]);
    // Which corridors meet here, so a keyed renderer can drop and rebuild only the treatments a
    // changed corridor takes part in.
    const corridorIds = [...new Set(arms.map(arm => arm.corridorId).filter(id => id !== null))].sort();
    return {
        lat,
        lng,
        level: Number.isFinite(node.point[2]) ? node.point[2] : 0,
        degree: junction.degree,
        corridorIds,
        surfacePolygons: junction.surface.map(toLatLng),
        cornerPolygons: junction.corners.map(corner => ({ polygon: toLatLng(corner.ring), strip: corner.strip || null })),
        crosswalkPolygons: junction.crossings.map(toLatLng),
        stopLinePolygons: junction.stopLines.map(toLatLng),
        landPolygons: junction.land.map(toLatLng),
        arms: junction.arms.map(arm => {
            const toward = frame.metricToLatLng(node.point[0] + arm.dir[0], node.point[1] + arm.dir[1]);
            return {
                corridorId: arm.source.corridorId,
                segmentId: arm.source.segmentId,
                entryIndex: arm.source.entryIndex,
                vertexIndex: arm.source.vertexIndex,
                step: arm.source.step,
                cut: arm.cut,
                markingTrim: arm.markingTrim,
                toward: { lat: toward[0], lng: toward[1] }
            };
        })
    };
}

// Per-segment treatments for ONE road whose segments may differ in cross-section.
// entries: [{points: [{lat,lng}...], profile, corridorId?, segmentId?}].
function buildCorridorJunctionTreatmentsForEntries(entries, frame) {
    assertCorridorFrame(frame, 'buildCorridorJunctionTreatmentsForEntries');
    const planarEntries = planarJunctionEntries(entries, frame);
    if (!planarEntries.length) return [];
    return corridorJunctionNodes(planarEntries)
        .filter(junctionNeedsTreatment)
        .map(node => junctionTreatmentFor(node, frame, { crossings: node.arms.length >= 3 }))
        .filter(Boolean);
}

function planarRingToLatLng(ring, frame) {
    return ring.map(([x, y]) => {
        const [lat, lng] = frame.metricToLatLng(x, y);
        return { lat, lng };
    });
}

// Local treatment for every junction of one corridor drawn with one profile.
function buildCorridorJunctionTreatments(segments, profile, frame) {
    const isLatLng = point => point && Number.isFinite(point.lat) && Number.isFinite(point.lng);
    const centerlines = (Array.isArray(segments) && segments.length && isLatLng(segments[0]))
        ? [segments]
        : (Array.isArray(segments) ? segments.filter(segment => Array.isArray(segment) && segment.length >= 2) : []);
    return buildCorridorJunctionTreatmentsForEntries(centerlines.map(points => ({ points, profile })), frame);
}

// Every junction of a set of corridors, own and shared alike: ONE pass over everything that
// touches, so a road's own T and the crossing it forms with its neighbour are built from the same
// arms and drawn once each. Input: [{ corridorId, entries: [{ segmentId?, points, profile }] }] or
// the older [{ corridorId, profile, centerline: [[{lat,lng}…]…] }]. Snapping while drawing copies
// exact coordinates, so a road snapped onto another one shares a vertex with it, or ends exactly on
// one of its edges; a vertex counts as lying on another road's edge within 0.75 m (an unsnapped
// near-miss stays two roads). Output: treatments (see junctionTreatmentFor), each kept once.
function buildCorridorJunctionSet(corridors) {
    const input = (Array.isArray(corridors) ? corridors : []).map((corridor, index) => {
        const corridorId = (corridor && corridor.corridorId !== undefined && corridor.corridorId !== null) ? String(corridor.corridorId) : String(index);
        const entries = Array.isArray(corridor && corridor.entries)
            ? corridor.entries.map(entry => ({ ...entry, corridorId }))
            : (corridor && Array.isArray(corridor.centerline) ? corridor.centerline : [])
                .filter(segment => Array.isArray(segment) && segment.length >= 2)
                .map(points => ({ points, profile: corridor.profile, corridorId }));
        return {
            corridorId,
            entries: entries.filter(entry => Array.isArray(entry.points) && entry.points.length >= 2 && entry.profile),
            centerline: entries.map(entry => entry.points)
        };
    }).filter(corridor => corridor.entries.length);
    if (!input.length) return [];
    const frames = corridorMetricFrames();
    const seen = new Set();
    const treatments = [];
    const keep = list => list.forEach(treatment => {
        const level = Number.isFinite(treatment.level) ? treatment.level : 0;
        const key = `${(treatment.corridorIds || []).join('|')}@${Number(treatment.lat).toFixed(7)},${Number(treatment.lng).toFixed(7)}#${level}`;
        if (seen.has(key)) return;
        seen.add(key);
        treatments.push(treatment);
    });
    // A junction between roads can only be where they touch, so the input splits into contact
    // groups and each group is measured in the frame of its own centre lines — a city's (or a
    // region's) applied corridors never share one. A group wider than one frame (a chain of
    // touching corridors over 100 km) is measured corridor by corridor, each with the ones it
    // touches; a junction found twice is the same place, and is kept once.
    corridorContactGroups(input, CROSS_JUNCTION_PAD_DEG).forEach(group => {
        const members = group.indices.map(index => input[index]);
        const points = members.flatMap(member => member.centerline.flat());
        const frame = frames.frameFor(points);
        if (frame.contains(points)) {
            keep(corridorJunctionsIn(members, frame));
            return;
        }
        group.indices.forEach(index => {
            const near = group.indices.filter(other => other === index || corridorBoxesTouch(group.boxes.get(index), group.boxes.get(other)))
                .map(other => input[other]);
            const nearPoints = near.flatMap(member => member.centerline.flat());
            keep(corridorJunctionsIn(near, frames.frameFor(nearPoints))
                .filter(treatment => (treatment.corridorIds || []).includes(input[index].corridorId)));
        });
    });
    return treatments;
}

// Intersections BETWEEN applied roads only — the junction set without any road's own junctions.
function buildCrossCorridorJunctionTreatments(corridors) {
    if (!Array.isArray(corridors) || corridors.length < 2) return [];
    return buildCorridorJunctionSet(corridors).filter(treatment => (treatment.corridorIds || []).length >= 2);
}

const CROSS_JUNCTION_PAD_DEG = 2e-5; // ~2 m, comfortably above the 0.75 m snap tolerance below

function corridorMetricFrames() {
    if (typeof window !== 'undefined' && window.__metricFrame) return window.__metricFrame;
    if (typeof require === 'function') return require('./metric-frame.js');
    throw new Error('corridor-profile: metric-frame.js is not loaded');
}

function corridorBoxesTouch(a, b) {
    return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
}

// Corridors whose centre-line bounding boxes (lng/lat, padded by `padDeg`) touch, grouped by
// union-find: [{ indices, boxes: Map(index → box) }].
function corridorContactGroups(corridors, padDeg) {
    const boxes = corridors.map(corridor => {
        let minLng = Infinity; let minLat = Infinity; let maxLng = -Infinity; let maxLat = -Infinity;
        corridor.centerline.forEach(segment => segment.forEach(point => {
            minLng = Math.min(minLng, point.lng); maxLng = Math.max(maxLng, point.lng);
            minLat = Math.min(minLat, point.lat); maxLat = Math.max(maxLat, point.lat);
        }));
        return [minLng - padDeg, minLat - padDeg, maxLng + padDeg, maxLat + padDeg];
    });
    const parent = corridors.map((_, index) => index);
    const find = index => (parent[index] === index ? index : (parent[index] = find(parent[index])));
    for (let i = 0; i < boxes.length; i += 1) {
        for (let j = i + 1; j < boxes.length; j += 1) {
            if (corridorBoxesTouch(boxes[i], boxes[j])) parent[find(i)] = find(j);
        }
    }
    const groups = new Map();
    corridors.forEach((_, index) => {
        const root = find(index);
        if (!groups.has(root)) groups.set(root, { indices: [], boxes: new Map() });
        groups.get(root).indices.push(index);
        groups.get(root).boxes.set(index, boxes[index]);
    });
    return [...groups.values()];
}

// The junctions of corridors that touch, measured in `frame`: a vertex of one corridor that lies
// on another corridor's edge becomes a node of that edge too (render-only), so the junction finder
// sees the T-joint.
function corridorJunctionsIn(corridors, frame) {
    const TOLERANCE = 0.75; // metres
    const planarEntries = planarJunctionEntries(corridors.flatMap(corridor => corridor.entries), frame);
    planarEntries.forEach(target => {
        target.points = (() => {
            const result = [target.points[0]];
            for (let i = 0; i < target.points.length - 1; i++) {
                const a = target.points[i];
                const b = target.points[i + 1];
                const dx = b[0] - a[0];
                const dy = b[1] - a[1];
                const len2 = dx * dx + dy * dy;
                const inserts = [];
                if (len2 > 1e-9) {
                    const levelA = Number.isFinite(a[2]) ? a[2] : 0;
                    const levelB = Number.isFinite(b[2]) ? b[2] : 0;
                    planarEntries.forEach(other => {
                        if (other.corridorId === target.corridorId) return;
                        other.points.forEach(point => {
                            const t = ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / len2;
                            if (t <= 1e-6 || t >= 1 - 1e-6) return;
                            const px = a[0] + t * dx;
                            const py = a[1] + t * dy;
                            if (Math.hypot(point[0] - px, point[1] - py) > TOLERANCE) return;
                            const pointLevel = Number.isFinite(point[2]) ? point[2] : 0;
                            // Levels are discrete topology labels, not an elevation to interpolate.
                            // Only a same-level span can receive a render-only T node.
                            if (levelA !== levelB || pointLevel !== levelA) return;
                            inserts.push({ t, point: [point[0], point[1], pointLevel] });
                        });
                    });
                }
                inserts.sort((x, y) => x.t - y.t).forEach(insert => {
                    const last = result[result.length - 1];
                    if (Math.hypot(last[0] - insert.point[0], last[1] - insert.point[1]) > 1e-3) result.push(insert.point);
                });
                result.push(b);
            }
            return result;
        })();
    });
    return corridorJunctionNodes(planarEntries)
        .filter(junctionNeedsTreatment)
        .map(node => junctionTreatmentFor(node, frame, { crossings: node.arms.length >= 3 }))
        .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Junction trims
//
// Where an arm belongs to a junction, nothing of the arm's own furniture is drawn: lane lines stop
// at the stop line, parking bays and arrows keep clear. The trims of one road piece are read off
// the treatments it takes part in — by position and direction, so a treatment found in a group
// frame applies to a piece measured in its corridor's own frame.
// ---------------------------------------------------------------------------

// { start, end, interior: [{ station, before, after }] } in metres along `planar` (a centre line
// in `frame`), from the junction treatments that touch its vertices.
function corridorEntryJunctionTrims(planar, junctions, frame) {
    const trims = { start: 0, end: 0, interior: [] };
    if (!Array.isArray(junctions) || !junctions.length || !Array.isArray(planar) || planar.length < 2) return trims;
    const stations = [0];
    for (let i = 1; i < planar.length; i += 1) stations.push(stations[i - 1] + Math.hypot(planar[i][0] - planar[i - 1][0], planar[i][1] - planar[i - 1][1]));
    const interior = new Map();
    junctions.forEach(junction => {
        if (!junction || !Array.isArray(junction.arms)) return;
        const node = frame.latLngToMetric(junction.lat, junction.lng);
        planar.forEach((vertex, vertexIndex) => {
            if (Math.hypot(vertex[0] - node[0], vertex[1] - node[1]) > 0.05) return;
            junction.arms.forEach(arm => {
                if (!arm.toward || !(arm.markingTrim > 0)) return;
                const towardXY = frame.latLngToMetric(arm.toward.lat, arm.toward.lng);
                const dir = [towardXY[0] - node[0], towardXY[1] - node[1]];
                const length = Math.hypot(dir[0], dir[1]);
                if (length < 1e-9) return;
                const matches = (neighbour) => {
                    if (!neighbour) return false;
                    const v = [neighbour[0] - vertex[0], neighbour[1] - vertex[1]];
                    const vl = Math.hypot(v[0], v[1]);
                    return vl > 1e-9 && (v[0] * dir[0] + v[1] * dir[1]) / (vl * length) > 0.999;
                };
                const forward = matches(planar[vertexIndex + 1]);
                const backward = matches(planar[vertexIndex - 1]);
                if (!forward && !backward) return;
                if (vertexIndex === 0 && forward) trims.start = Math.max(trims.start, arm.markingTrim);
                else if (vertexIndex === planar.length - 1 && backward) trims.end = Math.max(trims.end, arm.markingTrim);
                else {
                    const current = interior.get(vertexIndex) || { station: stations[vertexIndex], before: 0, after: 0 };
                    if (forward) current.after = Math.max(current.after, arm.markingTrim);
                    if (backward) current.before = Math.max(current.before, arm.markingTrim);
                    interior.set(vertexIndex, current);
                }
            });
        });
    });
    trims.interior = [...interior.values()].sort((a, b) => a.station - b.station);
    return trims;
}

// The station intervals a trim removes from a line of `total` metres.
function corridorTrimIntervals(trims, total) {
    const intervals = [];
    if (!trims) return intervals;
    if (trims.start > 0) intervals.push([0, trims.start]);
    (trims.interior || []).forEach(gap => intervals.push([gap.station - gap.before, gap.station + gap.after]));
    if (trims.end > 0) intervals.push([total - trims.end, total]);
    return intervals;
}

function corridorStationIsTrimmed(station, intervals) {
    return (intervals || []).some(([from, to]) => station >= from && station <= to);
}

// Cut a planar polyline into the pieces that remain outside `intervals` ([from, to] stations along
// it); pieces shorter than half a metre are dropped.
function cutPolylineByStations(points, intervals) {
    if (!Array.isArray(points) || points.length < 2) return [];
    if (!intervals || !intervals.length) return [points];
    const stations = [0];
    for (let i = 1; i < points.length; i += 1) stations.push(stations[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
    const total = stations[stations.length - 1];
    const cuts = intervals.map(([from, to]) => [Math.max(0, from), Math.min(total, to)]).filter(([from, to]) => to > from).sort((a, b) => a[0] - b[0]);
    const keeps = [];
    let cursor = 0;
    cuts.forEach(([from, to]) => { if (from > cursor) keeps.push([cursor, from]); cursor = Math.max(cursor, to); });
    if (cursor < total) keeps.push([cursor, total]);
    const pointAt = station => {
        let i = 1;
        while (i < stations.length - 1 && stations[i] < station) i += 1;
        const a = points[i - 1]; const b = points[i];
        const span = stations[i] - stations[i - 1];
        const k = span > 1e-9 ? (station - stations[i - 1]) / span : 0;
        return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
    };
    return keeps.filter(([from, to]) => to - from >= 0.5).map(([from, to]) => {
        const piece = [pointAt(from)];
        points.forEach((point, index) => { if (stations[index] > from && stations[index] < to) piece.push(point); });
        piece.push(pointAt(to));
        return piece;
    });
}

// ---------------------------------------------------------------------------
// Transition zones
//
// A stretch whose neighbour has a different cross-section does not step into it: the wider side
// tapers over a zone (corridor-transition.js, road-editor.md decision 3). The zone is derived, never
// stored, and every consumer — strips, land, markings, 3D — iterates the same PIECES: a stretch
// becomes its body plus one zone per tapered end, each zone carrying the profile at either end.
// ---------------------------------------------------------------------------

function corridorTransitionModule() {
    if (typeof window !== 'undefined' && window.__corridorTransition) return window.__corridorTransition;
    if (typeof require === 'function') return require('./corridor-transition.js');
    throw new Error('corridor-profile: corridor-transition.js is not loaded');
}

// The pieces of one corridor's entries ([{ segmentId, points, profile, width, corridorId? }]) in
// `frame`: [{ ...entry, points, taper: null | { profileStart, profileEnd, widthStart, widthEnd,
// length, kind }, pieceIndex }]. A zone's `profile` is the WIDE profile it starts from at the
// node (so a junction there is built full width and its hit target covers it); its `width` is
// the wider of its two ends. `options.junctions` are the definition's stored junctions with other
// records ([{ lat, lng, arms: [{ toward: {lat,lng}, profile }] }]): their arms count as
// neighbours, so a record continuing a wider one widens back to it (corridor-transition.js).
function corridorRenderPieces(entries, frame, options = {}) {
    assertCorridorFrame(frame, 'corridorRenderPieces');
    const transition = corridorTransitionModule();
    const junctions = (Array.isArray(options.junctions) ? options.junctions : []).map(junction => {
        if (!junction || !Number.isFinite(junction.lat) || !Number.isFinite(junction.lng)) return null;
        const point = frame.latLngToMetric(junction.lat, junction.lng);
        const arms = (junction.arms || []).map(arm => {
            if (!arm || !arm.toward || !arm.profile) return null;
            const toward = frame.latLngToMetric(arm.toward.lat, arm.toward.lng);
            const profile = normalizeCorridorProfile(arm.profile);
            return profile ? { dir: [toward[0] - point[0], toward[1] - point[1]], profile, width: corridorProfileWidth(profile) } : null;
        }).filter(Boolean);
        return { point, arms };
    }).filter(Boolean);
    // Planar copies remember which authored vertex they came from, so a piece hands the ORIGINAL
    // point objects on (a vertex's `level` decides what the land acquires); only a cut point is new,
    // and it lies underground only when both ends of its edge do.
    const planar = (entries || []).map(entry => ({
        ...entry,
        profile: entry && entry.profile ? normalizeCorridorProfile(entry.profile) : null,
        width: entry && entry.profile ? corridorProfileWidth(entry.profile) : Number(entry && entry.width) || 0,
        points: Array.isArray(entry && entry.points)
            ? entry.points.map((point, source) => Object.assign(frame.latLngToMetric(point.lat, point.lng), { source })).filter(xy => Array.isArray(xy) && Number.isFinite(xy[0]) && Number.isFinite(xy[1]))
            : []
    }));
    const plans = options.transitions === false ? [] : transition.planTransitions(planar, { junctions });
    const pieces = [];
    planar.forEach((entry, entryIndex) => {
        const original = entries[entryIndex];
        if (entry.points.length < 2) { pieces.push({ ...original, taper: null, pieceIndex: 0 }); return; }
        const own = plans.filter(plan => plan.entryIndex === entryIndex);
        if (!own.length) { pieces.push({ ...original, taper: null, pieceIndex: 0 }); return; }
        const split = transition.piecesOf(entry.points, own);
        const levelOf = point => (point && typeof point.level === 'number' && Number.isFinite(point.level)) ? point.level : null;
        split.forEach((piece, pieceIndex) => {
            const points = piece.points.map((xy, index) => {
                if (xy.source !== undefined && original.points[xy.source]) return original.points[xy.source];
                const [lat, lng] = frame.metricToLatLng(xy[0], xy[1]);
                const before = piece.points[index - 1]; const after = piece.points[index + 1];
                const levelBefore = before && before.source !== undefined ? levelOf(original.points[before.source]) : null;
                const levelAfter = after && after.source !== undefined ? levelOf(original.points[after.source]) : null;
                const level = levelBefore !== null && levelBefore === levelAfter ? levelBefore : null;
                return level === null ? { lat, lng } : { lat, lng, level };
            });
            if (!piece.taper) { pieces.push({ ...original, points, taper: null, pieceIndex }); return; }
            const widthStart = corridorProfileWidth(piece.taper.profileStart);
            const widthEnd = corridorProfileWidth(piece.taper.profileEnd);
            pieces.push({
                ...original,
                points,
                profile: widthStart >= widthEnd ? piece.taper.profileStart : piece.taper.profileEnd,
                width: Math.max(widthStart, widthEnd),
                taper: { ...piece.taper, widthStart, widthEnd },
                pieceIndex
            });
        });
    });
    return pieces;
}

// Which end of a zone is the wide one, and the per-strip spans at both ends (wide strips first).
function corridorTaperSpans(taper) {
    const startIsWide = taper.widthStart >= taper.widthEnd;
    const wide = startIsWide ? taper.profileStart : taper.profileEnd;
    const narrow = startIsWide ? taper.profileEnd : taper.profileStart;
    const wideSpans = corridorStripSpans(wide);
    const narrowSpans = corridorStripSpans(narrow);
    const mapped = corridorTransitionModule().mapSpans(wideSpans, narrowSpans);
    return { startIsWide, wide, narrow, wideSpans, narrowSpans, mapped };
}

// Strips of one piece, ready to draw — exactly buildCorridorStrips' shape, so renderers need not
// know whether the piece tapers. A zone's strips run diagonally from the wide spans to the narrow.
function buildCorridorPieceStrips(piece, frame) {
    assertCorridorFrame(frame, 'buildCorridorPieceStrips');
    if (!piece || !Array.isArray(piece.points) || piece.points.length < 2) return [];
    if (!piece.taper) return buildCorridorStrips([piece.points], piece.profile, frame);
    const transition = corridorTransitionModule();
    const { startIsWide, wideSpans, mapped } = corridorTaperSpans(piece.taper);
    const planar = piece.points.map(point => frame.latLngToMetric(point.lat, point.lng));
    const samples = transition.sampleWithNormals(planar);
    return wideSpans.map((span, index) => {
        const wideSpan = { left: span.left, right: span.right };
        const narrowSpan = mapped[index];
        const ring = transition.taperStripRing(samples, startIsWide ? wideSpan : narrowSpan, startIsWide ? narrowSpan : wideSpan);
        return { ...span, polygons: ring ? [planarRingToLatLng(ring, frame)] : [] };
    }).filter(strip => strip.polygons.length);
}

// The painted lines of one zone, as lane-topology entries' paths (planar): separators and run
// boundaries of the wide profile, each sliding to where its strip lands in the narrow profile. A
// separator beside a lane that vanishes ends two thirds of the way in rather than running into
// its neighbour's line — lanes merge, their lines do not (roads.md §5).
function corridorTaperMarkingPaths(piece, planar) {
    const transition = corridorTransitionModule();
    const { startIsWide, wide, wideSpans, mapped } = corridorTaperSpans(piece.taper);
    const samples = transition.sampleWithNormals(planar);
    if (!samples.length) return [];
    const offsetOf = (wideOffset, side) => {
        const index = wideSpans.findIndex(span => Math.abs(span[side] - wideOffset) < 1e-9);
        return index >= 0 ? { end: mapped[index][side], unmatched: !mapped[index].matched } : { end: wideOffset, unmatched: false };
    };
    const line = (wideOffset, side, neighbours) => {
        const target = offsetOf(wideOffset, side);
        const ending = neighbours.some(index => index >= 0 && index < mapped.length && !mapped[index].matched);
        const kept = ending ? samples.filter(sample => (startIsWide ? sample.s : 1 - sample.s) <= 0.67) : samples;
        if (kept.length < 2) return null;
        return transition.taperOffsetLine(kept, startIsWide ? wideOffset : target.end, startIsWide ? target.end : wideOffset);
    };
    const runs = [];
    corridorLaneTrafficRuns(wide).forEach(run => {
        const paths = run.paths.map(path => {
            const index = wideSpans.findIndex(span => Math.abs(span.right - path.offset) < 1e-9);
            const points = line(path.offset, 'right', [index, index + 1]);
            return points ? { ...path, points: densifyCorridorMarkingLine(points) } : null;
        }).filter(Boolean);
        const boundaryPaths = run.boundaries.map(boundary => {
            const indexRight = wideSpans.findIndex(span => Math.abs(span.right - boundary.offset) < 1e-9);
            const indexLeft = wideSpans.findIndex(span => Math.abs(span.left - boundary.offset) < 1e-9);
            const side = indexRight >= 0 ? 'right' : 'left';
            const points = line(boundary.offset, side, []);
            return points ? { ...boundary, points: densifyCorridorMarkingLine(points) } : null;
        }).filter(Boolean);
        runs.push({ flowDirection: run.flowDirection, paths, boundaryPaths });
    });
    return runs;
}

// ---------------------------------------------------------------------------
// Lane markings
//
// A separator sits on the boundary two adjacent traffic lanes share. Between lanes running the same way
// it is a dashed line; where the flow reverses — the boundary between a forward and a backward lane — it
// is the solid centerline. No marking is drawn against parking, cycleways or the kerb: those are lane
// *edges*, a different thing, and the eye reads the surface change instead.
// ---------------------------------------------------------------------------

// The signed offsets, from the centerline, where a lane-separator line belongs. Same geometry the strips
// use (a strip boundary is `strip.right`), so a marking lands exactly on the seam between two strips.
function isMarkedTrafficLane(strip) {
    return strip && (strip.type === 'driving' || strip.type === 'bus');
}

function corridorLaneSeparators(profile) {
    const spans = corridorStripSpans(profile);
    const separators = [];
    for (let i = 0; i < spans.length - 1; i++) {
        const a = spans[i];
        const b = spans[i + 1];
        if (!isMarkedTrafficLane(a) || !isMarkedTrafficLane(b)) continue;
        separators.push({
            offset: a.right, // == b.left, the shared boundary
            kind: (a.direction && b.direction && a.direction !== b.direction) ? 'centerline' : 'lane'
        });
    }
    return separators;
}

// Contiguous motor-traffic lanes form one painted cross-section. The two outer boundaries are virtual
// curb ancestors: they are not painted here, but a newly inserted side lane may inherit one of them.
// A median creates two independent cross-sections, so its opposing carriageways cannot be paired.
function corridorLaneTrafficRuns(profile) {
    const runs = [];
    let current = [];
    const flush = () => {
        if (!current.length) return;
        const paths = [];
        for (let index = 0; index < current.length - 1; index += 1) {
            const a = current[index];
            const b = current[index + 1];
            paths.push({
                offset: a.right,
                kind: (a.direction && b.direction && a.direction !== b.direction)
                    ? 'centerline'
                    : 'lane'
            });
        }
        const directions = [...new Set(current.map(strip => strip.direction).filter(Boolean))];
        runs.push({
            paths,
            boundaries: [
                { offset: current[0].left, kind: 'edge' },
                ...paths.map(path => ({ ...path })),
                { offset: current[current.length - 1].right, kind: 'edge' }
            ],
            flowDirection: directions.length === 1 ? directions[0] : 'mixed'
        });
        current = [];
    };
    corridorStripSpans(profile).forEach(strip => {
        if (isMarkedTrafficLane(strip)) current.push(strip);
        else flush();
    });
    flush();
    return runs;
}

function densifyCorridorMarkingLine(points, maxStepM = 5) {
    if (!Array.isArray(points) || points.length < 2) return [];
    const dense = [points[0]];
    for (let index = 0; index < points.length - 1; index += 1) {
        const a = points[index];
        const b = points[index + 1];
        const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const pieces = Math.max(1, Math.ceil(length / maxStepM));
        for (let piece = 1; piece < pieces; piece += 1) {
            const progress = piece / pieces;
            dense.push([
                a[0] + (b[0] - a[0]) * progress,
                a[1] + (b[1] - a[1]) * progress
            ]);
        }
        dense.push(b);
    }
    return dense;
}

function corridorLaneTopologyApi() {
    if (typeof window !== 'undefined' && window.CorridorLaneTopology) {
        return window.CorridorLaneTopology;
    }
    if (typeof require === 'function') {
        try { return require('./corridor-lane-topology.js'); } catch (_) { }
    }
    return null;
}

// The shared topology pass for every segment entry. It is deliberately planar and view-agnostic:
// Leaflet and Three.js consume these exact same connected lines.
//
// Lane lines stop at the stop line: every path is cut back by the trims of the junctions the
// entry takes part in. `options.junctions` are the treatments to read those from (the whole set a
// renderer computed, own and shared); without them the entries' own junctions are used.
function buildCorridorLaneMarkingsForEntries(entries, frame, options = {}) {
    assertCorridorFrame(frame, 'buildCorridorLaneMarkingsForEntries');
    const topology = corridorLaneTopologyApi();
    if (!topology || typeof topology.build !== 'function') {
        throw new Error('CorridorLaneTopology.build is required for lane markings');
    }
    const junctions = Array.isArray(options.junctions)
        ? options.junctions
        : buildCorridorJunctionTreatmentsForEntries(entries, frame);
    const topologyEntries = [];
    const trimsByEntry = new Map();
    (entries || []).forEach((entry, ownerEntryIndex) => {
        if (!entry || !entry.profile || !Array.isArray(entry.points) || entry.points.length < 2) return;
        const centerline = entry.points
            .map(point => frame.latLngToMetric(point.lat, point.lng))
            .filter(point => Array.isArray(point) && point.every(Number.isFinite));
        if (centerline.length < 2) return;
        trimsByEntry.set(ownerEntryIndex, corridorEntryJunctionTrims(centerline, junctions, frame));
        if (entry.taper) {
            // A transition zone: its lines slide from one profile's seams to the other's.
            corridorTaperMarkingPaths(entry, centerline).forEach((run, runIndex) => {
                topologyEntries.push({
                    ownerEntryIndex,
                    runIndex,
                    corridorId: entry.corridorId,
                    fixed: true,
                    flowDirection: run.flowDirection,
                    centerline,
                    paths: run.paths,
                    boundaryPaths: run.boundaryPaths
                });
            });
            return;
        }
        corridorLaneTrafficRuns(entry.profile).forEach((run, runIndex) => {
            const buildPath = descriptor => {
                const offset = offsetPolylinePlanar(centerline, descriptor.offset);
                return offset && offset.length >= 2
                    ? {
                        ...descriptor,
                        points: densifyCorridorMarkingLine(offset)
                    }
                    : null;
            };
            topologyEntries.push({
                ownerEntryIndex,
                runIndex,
                corridorId: entry.corridorId,
                flowDirection: run.flowDirection,
                centerline,
                paths: run.paths.map(buildPath).filter(Boolean),
                boundaryPaths: run.boundaries.map(buildPath).filter(Boolean)
            });
        });
    });
    const markingsByEntry = (entries || []).map(() => []);
    topology.build(topologyEntries).forEach(result => {
        const topologyEntry = topologyEntries[result.sourceIndex];
        if (!topologyEntry) return;
        const trims = trimsByEntry.get(topologyEntry.ownerEntryIndex) || null;
        const groups = new Map();
        (result.paths || []).forEach(path => {
            const pathLength = path.points.reduce((sum, point, index) => (index ? sum + Math.hypot(point[0] - path.points[index - 1][0], point[1] - path.points[index - 1][1]) : 0), 0);
            // An interior junction sits at a centre-line station; on an offset path that is the
            // same station to within the curve, which is what the trim tolerates.
            cutPolylineByStations(path.points, corridorTrimIntervals(trims, pathLength)).forEach(piece => {
                const line = piece.map(([x, y]) => {
                    const [lat, lng] = frame.metricToLatLng(x, y);
                    return { lat, lng };
                });
                if (line.length < 2) return;
                const kind = path.kind || 'lane';
                if (!groups.has(kind)) groups.set(kind, []);
                groups.get(kind).push(line);
            });
        });
        groups.forEach((lines, kind) => {
            const existing = markingsByEntry[topologyEntry.ownerEntryIndex]
                .find(marking => marking.kind === kind);
            if (existing) existing.lines.push(...lines);
            else markingsByEntry[topologyEntry.ownerEntryIndex].push({ kind, lines });
        });
    });
    return markingsByEntry;
}

// One offset polyline of the centerline as Leaflet LatLngs — a lane marking is a line, not a band.
function buildCorridorOffsetLine(points, offset, frame) {
    assertCorridorFrame(frame, 'buildCorridorOffsetLine');
    if (!Array.isArray(points) || points.length < 2) return null;
    const planar = points
        .map(point => (point && Number.isFinite(point.lat) && Number.isFinite(point.lng)) ? frame.latLngToMetric(point.lat, point.lng) : null)
        .filter(xy => Array.isArray(xy) && Number.isFinite(xy[0]) && Number.isFinite(xy[1]));
    if (planar.length < 2) return null;
    const line = offsetPolylinePlanar(planar, offset);
    if (!line) return null;
    return line.map(([x, y]) => {
        const [lat, lng] = frame.metricToLatLng(x, y);
        return { lat, lng };
    });
}

// Every lane-separator line of a whole corridor: `[{ kind, lines }]`, one line per centerline segment.
function buildCorridorLaneMarkings(segments, profile, frame) {
    const isLatLng = (p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lng);
    const centerlines = (Array.isArray(segments) && segments.length && isLatLng(segments[0]))
        ? [segments]
        : (Array.isArray(segments) ? segments.filter(seg => Array.isArray(seg) && seg.length >= 2) : []);
    if (!centerlines.length) return [];
    const byEntry = buildCorridorLaneMarkingsForEntries(
        centerlines.map(points => ({ points, profile })),
        frame
    );
    const merged = new Map();
    byEntry.flat().forEach(marking => {
        if (!merged.has(marking.kind)) merged.set(marking.kind, []);
        merged.get(marking.kind).push(...marking.lines);
    });
    return [...merged].map(([kind, lines]) => ({ kind, lines }));
}

// ---------------------------------------------------------------------------
// Parking bays
//
// A parking lane is not a plain painted strip: its markings are the bay outlines, and their shape IS
// the difference between the three parking types. Each bay is a divider line drawn across the lane at a
// fixed interval along the road — perpendicular for parallel and 90° parking, slanted for angled — plus
// the single edge line where the lane meets the carriageway. The dividers and their spacing come from
// the standard bay dimensions, so what is drawn is a real row of bays, not a decorative hatch.
// ---------------------------------------------------------------------------

// Per orientation: the along-road interval between bay dividers and the angle each divider makes with
// the road. A parallel bay is a car-length long (6 m) with perpendicular ends; a 90° bay is a car-width
// apart (2.5 m); an angled bay is a car-width apart measured along the slant, so its along-road interval
// is that width divided by sin(angle).
const CORRIDOR_PARKING_STALL_WIDTH = 2.5; // the width of one bay, across the direction a car points
const CORRIDOR_PARKING_BAYS = {
    parallel: { spacingAlong: 6, angleDeg: 90 },
    perpendicular: { spacingAlong: CORRIDOR_PARKING_STALL_WIDTH, angleDeg: 90 },
    angled: { spacingAlong: CORRIDOR_PARKING_STALL_WIDTH / Math.sin(60 * Math.PI / 180), angleDeg: 60 }
};

// Every parking bay marking of a corridor, ready to draw: `[{ kind: 'edge' | 'divider', line: [latlng…] }]`.
// `edge` is the solid line between the parking lane and the carriageway; each `divider` is one bay
// boundary across the lane. View-agnostic (LatLngs), so 2D and 3D draw from the same geometry.
function buildCorridorParkingBays(segments, profile, frame, options = {}) {
    assertCorridorFrame(frame, 'buildCorridorParkingBays');
    // Bays keep clear of the junctions the piece takes part in (options.trims, see
    // corridorEntryJunctionTrims), on top of the clearance around its own interior T-nodes.
    const trimIntervals = options.trims ? corridorTrimIntervals(options.trims, Infinity) : [];
    const parkingSpans = corridorStripSpans(profile).filter(span => corridorParkingOrientation(span.type));
    if (!parkingSpans.length) return [];

    const isLatLng = point => point && Number.isFinite(point.lat) && Number.isFinite(point.lng);
    const centerlines = (Array.isArray(segments) && segments.length && isLatLng(segments[0]))
        ? [segments]
        : (Array.isArray(segments) ? segments.filter(segment => Array.isArray(segment) && segment.length >= 2) : []);
    if (!centerlines.length) return [];

    const planarCenterlines = centerlines.map(segment => segment.map(point => frame.latLngToMetric(point.lat, point.lng)));
    const junctionPoints = findCorridorJunctionsPlanar(planarCenterlines).map(junction => junction.point);
    const junctionClearance = corridorProfileWidth(profile) / 2 + 3;
    const nearJunction = point => junctionPoints.some(j => Math.hypot(point[0] - j[0], point[1] - j[1]) < junctionClearance);
    const toLatLng = ([x, y]) => { const [lat, lng] = frame.metricToLatLng(x, y); return { lat, lng }; };

    const bays = [];
    planarCenterlines.forEach(planar => {
        parkingSpans.forEach(span => {
            const bay = CORRIDOR_PARKING_BAYS[corridorParkingOrientation(span.type)] || CORRIDOR_PARKING_BAYS.parallel;
            // The lane edge nearer the road centre (the carriageway side) gets the solid edge line; the
            // far edge is the kerb, already the corridor's own boundary.
            const inner = Math.abs(span.left) <= Math.abs(span.right) ? span.left : span.right;
            const outer = inner === span.left ? span.right : span.left;
            const centerOffset = (span.left + span.right) / 2;

            const centerLine = offsetPolylinePlanar(planar, centerOffset);
            if (!centerLine) return;
            const centerLength = centerLine.reduce((sum, point, index) => (index ? sum + Math.hypot(point[0] - centerLine[index - 1][0], point[1] - centerLine[index - 1][1]) : 0), 0);
            const intervals = trimIntervals.map(([from, to]) => [from, Number.isFinite(to) ? to : centerLength]);

            // The edge line stops where the junction begins, like every other line on the road.
            const edge = offsetPolylinePlanar(planar, inner);
            if (edge) cutPolylineByStations(edge, intervals).forEach(piece => bays.push({ kind: 'edge', line: piece.map(toLatLng) }));

            // The slant only tilts the divider along the road; a 90° bay has no tilt at all.
            const slant = bay.angleDeg >= 90 ? 0 : span.width / Math.tan(bay.angleDeg * Math.PI / 180);
            samplePolylinePlanar(centerLine, bay.spacingAlong).forEach(sample => {
                if (nearJunction(sample.point)) return;
                if (corridorStationIsTrimmed(sample.distance, intervals)) return;
                const tangent = [Math.cos(sample.angle), Math.sin(sample.angle)];
                const normalLeft = [-Math.sin(sample.angle), Math.cos(sample.angle)];
                const at = (offset, along) => [
                    sample.point[0] + normalLeft[0] * (offset - centerOffset) + tangent[0] * along,
                    sample.point[1] + normalLeft[1] * (offset - centerOffset) + tangent[1] * along
                ];
                bays.push({ kind: 'divider', line: [toLatLng(at(inner, 0)), toLatLng(at(outer, slant))] });
            });
        });
    });
    return bays;
}

// ---------------------------------------------------------------------------
// Direction arrows
//
// A motor-vehicle lane (traffic or bus) carries a direction; this paints it, as a road does: a white
// arrow every so often down the lane, pointing the way it runs. So a one-way street reads as one, and a
// single-lane stretch stops being ambiguous. Flipping a lane's direction (withLaneDirection) turns its
// arrows around. Returned as flat convex rings (a head triangle + a stem rectangle) so 2D fills them
// and 3D triangulates them from the same geometry.
// ---------------------------------------------------------------------------

const CORRIDOR_ARROW_SPACING = 30; // metres between direction arrows down a lane
const CORRIDOR_ARROW = { length: 4, headLength: 1.6, headHalf: 0.7, stemHalf: 0.22 }; // metres
const CORRIDOR_ARROW_LANE_TYPES = new Set(['driving', 'bus']);

function buildCorridorDirectionArrows(segments, profile, frame, options = {}) {
    assertCorridorFrame(frame, 'buildCorridorDirectionArrows');
    const trimIntervals = options.trims ? corridorTrimIntervals(options.trims, Infinity) : [];
    const laneSpans = corridorStripSpans(profile).filter(span =>
        CORRIDOR_ARROW_LANE_TYPES.has(span.type) && (span.direction === 'forward' || span.direction === 'backward'));
    if (!laneSpans.length) return [];

    const isLatLng = point => point && Number.isFinite(point.lat) && Number.isFinite(point.lng);
    const centerlines = (Array.isArray(segments) && segments.length && isLatLng(segments[0]))
        ? [segments]
        : (Array.isArray(segments) ? segments.filter(segment => Array.isArray(segment) && segment.length >= 2) : []);
    if (!centerlines.length) return [];

    const planarCenterlines = centerlines.map(segment => segment.map(point => frame.latLngToMetric(point.lat, point.lng)));
    const junctionPoints = findCorridorJunctionsPlanar(planarCenterlines).map(junction => junction.point);
    const junctionClearance = corridorProfileWidth(profile) / 2 + 5;
    const toLatLng = ([x, y]) => { const [lat, lng] = frame.metricToLatLng(x, y); return { lat, lng }; };
    const { length: L, headLength: HL, headHalf: HH, stemHalf: SH } = CORRIDOR_ARROW;

    const arrows = [];
    laneSpans.forEach(span => {
        const offset = (span.left + span.right) / 2;
        const sign = span.direction === 'backward' ? -1 : 1;
        centerlines.forEach(centerline => {
            const offsetLine = buildCorridorOffsetLine(centerline, offset, frame);
            if (!offsetLine) return;
            const planar = offsetLine.map(point => frame.latLngToMetric(point.lat, point.lng));
            const planarLength = planar.reduce((sum, point, index) => (index ? sum + Math.hypot(point[0] - planar[index - 1][0], point[1] - planar[index - 1][1]) : 0), 0);
            const intervals = trimIntervals.map(([from, to]) => [from, Number.isFinite(to) ? to : planarLength]);
            samplePolylinePlanar(planar, CORRIDOR_ARROW_SPACING).forEach(sample => {
                if (junctionPoints.some(p => Math.hypot(sample.point[0] - p[0], sample.point[1] - p[1]) < junctionClearance)) return;
                if (corridorStationIsTrimmed(sample.distance, intervals)) return;
                const dir = [Math.cos(sample.angle) * sign, Math.sin(sample.angle) * sign];
                const perp = [-dir[1], dir[0]];
                const at = (along, across) => toLatLng([
                    sample.point[0] + dir[0] * along + perp[0] * across,
                    sample.point[1] + dir[1] * along + perp[1] * across
                ]);
                // Head triangle then stem rectangle — each convex, both filled white.
                arrows.push([at(L / 2, 0), at(L / 2 - HL, HH), at(L / 2 - HL, -HH)]);
                arrows.push([at(L / 2 - HL, SH), at(-L / 2, SH), at(-L / 2, -SH), at(L / 2 - HL, -SH)]);
            });
        });
    });
    return arrows;
}

// The cross-section of an OSM road, ready to draw — the same `{type, polygons}` the drawing tool and
// applied proposals produce, from the same geometry code. This is the point of the whole tag bridge:
// an imported street and a proposed street are one object by the time anything renders them.
function buildCorridorStripsForOsmFeature(feature) {
    const profile = corridorProfileFromOsmFeature(feature);
    const coordinates = feature && feature.geometry && feature.geometry.type === 'LineString'
        ? feature.geometry.coordinates
        : null;
    if (!profile || !Array.isArray(coordinates) || coordinates.length < 2) return [];
    const centerline = coordinates.map(([lng, lat]) => ({ lat, lng }));
    return buildCorridorStrips([centerline], profile);
}

if (typeof window !== 'undefined') {
    window.CORRIDOR_LANE_TYPES = CORRIDOR_LANE_TYPES;
    window.buildCorridorStripsForOsmFeature = buildCorridorStripsForOsmFeature;
    window.buildCorridorLaneMarkings = buildCorridorLaneMarkings;
    window.buildCorridorLaneMarkingsForEntries = buildCorridorLaneMarkingsForEntries;
    window.buildCorridorJunctionSet = buildCorridorJunctionSet;
    window.corridorRenderPieces = corridorRenderPieces;
    window.buildCorridorPieceStrips = buildCorridorPieceStrips;
    window.corridorProfileEdges = corridorProfileEdges;
    window.corridorEntryJunctionTrims = corridorEntryJunctionTrims;
    window.corridorTrimIntervals = corridorTrimIntervals;
    window.corridorStationIsTrimmed = corridorStationIsTrimmed;
    window.cutPolylineByStations = cutPolylineByStations;
    window.corridorLaneSeparators = corridorLaneSeparators;
    window.corridorProfileFromOsmTags = corridorProfileFromOsmTags;
    window.corridorProfileToOsmTags = corridorProfileToOsmTags;
    window.corridorProfileFromOsmFeature = corridorProfileFromOsmFeature;
    window.CORRIDOR_PROFILE_PRESETS = CORRIDOR_PROFILE_PRESETS;
    window.normalizeCorridorProfile = normalizeCorridorProfile;
    window.corridorProfileWidth = corridorProfileWidth;
    window.corridorProfileFromLegacy = corridorProfileFromLegacy;
    window.corridorProfileOf = corridorProfileOf;
    window.corridorStripSpans = corridorStripSpans;
    window.CORRIDOR_STANDARD_WIDTHS = CORRIDOR_STANDARD_WIDTHS;
    window.CORRIDOR_RAIL_GAUGES = CORRIDOR_RAIL_GAUGES;
    window.CORRIDOR_RAIL_GAUGE_WIDTHS = CORRIDOR_RAIL_GAUGE_WIDTHS;
    window.CORRIDOR_DEFAULT_RAIL_GAUGE = CORRIDOR_DEFAULT_RAIL_GAUGE;
    window.corridorStandardWidth = corridorStandardWidth;
    window.corridorMinLaneWidth = corridorMinLaneWidth;
    window.corridorParkingOrientation = corridorParkingOrientation;
    window.corridorLaneWidthFixed = corridorLaneWidthFixed;
    window.buildCorridorParkingBays = buildCorridorParkingBays;
    window.buildCorridorDirectionArrows = buildCorridorDirectionArrows;
    window.withLaneDirection = withLaneDirection;
    window.withLaneTreeEvery = withLaneTreeEvery;
    window.corridorRailGaugeOf = corridorRailGaugeOf;
    window.corridorProfileHasRail = corridorProfileHasRail;
    window.corridorIsTrack = corridorIsTrack;
    window.corridorIsDesignation = corridorIsDesignation;
    window.corridorDefaultTrackProfile = corridorDefaultTrackProfile;
    window.withSidewalkWidth = withSidewalkWidth;
    window.withLaneWidth = withLaneWidth;
    window.withLaneType = withLaneType;
    window.withLaneLandscape = withLaneLandscape;
    window.withLaneGauge = withLaneGauge;
    window.withLaneInserted = withLaneInserted;
    window.withLaneRemoved = withLaneRemoved;
    window.withLaneMoved = withLaneMoved;
    window.corridorCenterlineOf = corridorCenterlineOf;
    window.corridorLandscapeOf = corridorLandscapeOf;
    window.corridorPavingOf = corridorPavingOf;
    window.corridorStripSurface = corridorStripSurface;
    window.withLanePaving = withLanePaving;
    window.CORRIDOR_PAVINGS = CORRIDOR_PAVINGS;
    window.CORRIDOR_PAVED_TYPES = CORRIDOR_PAVED_TYPES;

    window.buildCorridorStrips = buildCorridorStrips;
    window.buildCorridorStripPolygon = buildCorridorStripPolygon;
    window.corridorStripRingPlanar = corridorStripRingPlanar;
    window.buildCorridorDecorations = buildCorridorDecorations;
    window.withSeamMoved = withSeamMoved;
    window.buildCorridorJunctionTreatments = buildCorridorJunctionTreatments;
    window.buildCorridorJunctionTreatmentsForEntries = buildCorridorJunctionTreatmentsForEntries;
    window.buildCrossCorridorJunctionTreatments = buildCrossCorridorJunctionTreatments;
    window.corridorSegmentProfile = corridorSegmentProfile;
    window.corridorSegmentEntries = corridorSegmentEntries;
    window.corridorHasSegmentProfiles = corridorHasSegmentProfiles;
}

// Node-visible for unit tests; the browser loads this file as a classic script.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        withSeamMoved,
        CORRIDOR_LANE_TYPES,
        corridorProfileFromOsmTags,
        corridorProfileToOsmTags,
        corridorProfileFromOsmFeature,
        CORRIDOR_PROFILE_PRESETS,
        normalizeCorridorProfile,
        corridorProfileWidth,
        reversedCorridorProfile,
        corridorProfileFromLegacy,
        corridorDefaultTrackProfile,
        corridorProfileOf,
        corridorProfileHasRail,
        corridorIsTrack,
        corridorIsDesignation,
        corridorStripSpans,
        corridorCenterlineOf,
        corridorLandscapeOf,
        corridorPavingOf,
        corridorStripSurface,
        withLanePaving,
        CORRIDOR_PAVINGS,
        CORRIDOR_PAVED_TYPES,
        CORRIDOR_PAVED_SURFACE,
        corridorRailGaugeOf,
        withSidewalkWidth,
        withLaneWidth,
        withLaneType,
        withLaneLandscape,
        withLaneGauge,
        withLaneInserted,
        withLaneRemoved,
        withLaneMoved,
        CORRIDOR_STANDARD_WIDTHS,
        CORRIDOR_RAIL_GAUGES,
        CORRIDOR_RAIL_GAUGE_WIDTHS,
        CORRIDOR_DEFAULT_RAIL_GAUGE,
        corridorStandardWidth,
        corridorMinLaneWidth,
        corridorParkingOrientation,
        corridorLaneWidthFixed,
        buildCorridorParkingBays,
        buildCorridorDirectionArrows,
        withLaneDirection,
        withLaneTreeEvery,
        CORRIDOR_MIN_DRIVING_WIDTH,
        CORRIDOR_MIN_LANE_WIDTH,
        offsetPolylinePlanar,
        offsetClosedPolylinePlanar,
        corridorStripRingPlanar,
        corridorClosedStripPolygonPlanar,
        ringSelfIntersectsXY,
        corridorLaneSeparators,
        corridorLaneTrafficRuns,
        buildCorridorLaneMarkings,
        buildCorridorLaneMarkingsForEntries,
        samplePolylinePlanar,
        findCorridorJunctionsPlanar,
        buildCorridorDecorations,
        buildCorridorJunctionTreatments,
        buildCorridorJunctionTreatmentsForEntries,
        buildCrossCorridorJunctionTreatments,
        buildCorridorJunctionSet,
        corridorRenderPieces,
        buildCorridorPieceStrips,
        corridorTaperMarkingPaths,
        junctionNeedsTreatment,
        corridorProfileEdges,
        corridorEntryJunctionTrims,
        corridorTrimIntervals,
        corridorStationIsTrimmed,
        cutPolylineByStations,
        corridorSegmentProfile,
        corridorSegmentEntries,
        corridorHasSegmentProfiles
    };
}
