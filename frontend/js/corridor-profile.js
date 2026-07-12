// Corridor cross-section profiles.
//
// A corridor (road or track) is a centerline plus a cross-section: an ordered list of lanes running
// left-to-right across the corridor. The total width is the sum of the lanes, so `definition.width`
// becomes a derived cache rather than the truth, and every existing consumer of `width` keeps working.
//
// This separation is what lets a road's *content* be reshuffled (swap parking for trees, widen the
// sidewalk) without moving its footprint: as long as the lanes still sum to the same total, the
// corridor polygon — and therefore the parcel split and every descendant proposal — is untouched.
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
    parking: { label: 'Parking', surface: '#3d3d3d', height: 0, osm: { key: 'parking', value: 'lane' } },
    cycleway: { label: 'Cycle path', surface: '#7d3b34', height: 0, osm: { key: 'cycleway', value: 'lane' }, directional: true },
    sidewalk: { label: 'Sidewalk', surface: '#c2beb4', height: 0.15, osm: { key: 'sidewalk', value: 'yes' } },
    verge: { label: 'Green verge', surface: '#4f7f52', height: 0.15, osm: { key: 'verge', value: 'yes' } },
    median: { label: 'Median', surface: '#4f7f52', height: 0.15, osm: { key: 'median', value: 'yes' } },
    rail: { label: 'Rail bed', surface: '#d3d3d3', height: 0, osm: { key: 'railway', value: 'rail' } }
};

const CORRIDOR_GREEN_TYPES = new Set(['verge', 'median']);
const CORRIDOR_LANDSCAPES = ['grass', 'trees'];
const CORRIDOR_DECORATION_SPACING = { bike: 50, pedestrian: 75, tree: 6 };

// Presets keyed by the total widths the width picker already offers, so an existing road keeps its
// footprint exactly and only gains an interior. Every preset sums to its key.
const CORRIDOR_PROFILE_PRESETS = {
    7.5: [
        { type: 'sidewalk', width: 1 }, { type: 'driving', width: 2.75, direction: 'forward' },
        { type: 'driving', width: 2.75, direction: 'backward' }, { type: 'sidewalk', width: 1 }
    ],
    10: [
        { type: 'sidewalk', width: 1.5 }, { type: 'driving', width: 3.5, direction: 'forward' },
        { type: 'driving', width: 3.5, direction: 'backward' }, { type: 'sidewalk', width: 1.5 }
    ],
    18: [
        { type: 'sidewalk', width: 2 }, { type: 'cycleway', width: 1.5, direction: 'forward' }, { type: 'parking', width: 2 },
        { type: 'driving', width: 3.5, direction: 'forward' }, { type: 'driving', width: 3.5, direction: 'backward' },
        { type: 'parking', width: 2 }, { type: 'cycleway', width: 1.5, direction: 'backward' }, { type: 'sidewalk', width: 2 }
    ],
    26: [
        { type: 'sidewalk', width: 3 }, { type: 'verge', width: 1.5, landscape: 'trees' }, { type: 'cycleway', width: 1.5, direction: 'forward' },
        { type: 'parking', width: 2.5 }, { type: 'driving', width: 3.25, direction: 'forward' }, { type: 'median', width: 2.5, landscape: 'grass' },
        { type: 'driving', width: 3.25, direction: 'backward' }, { type: 'parking', width: 2.5 }, { type: 'cycleway', width: 1.5, direction: 'backward' },
        { type: 'verge', width: 1.5, landscape: 'trees' }, { type: 'sidewalk', width: 3 }
    ],
    40: [
        { type: 'sidewalk', width: 4 }, { type: 'verge', width: 2, landscape: 'trees' }, { type: 'cycleway', width: 2, direction: 'forward' },
        { type: 'parking', width: 2.5 }, { type: 'driving', width: 3.25, direction: 'forward' }, { type: 'driving', width: 3.25, direction: 'forward' },
        { type: 'median', width: 6, landscape: 'grass' },
        { type: 'driving', width: 3.25, direction: 'backward' }, { type: 'driving', width: 3.25, direction: 'backward' }, { type: 'parking', width: 2.5 },
        { type: 'cycleway', width: 2, direction: 'backward' }, { type: 'verge', width: 2, landscape: 'trees' }, { type: 'sidewalk', width: 4 }
    ],
    80: [
        { type: 'sidewalk', width: 7 }, { type: 'verge', width: 5, landscape: 'trees' }, { type: 'cycleway', width: 3, direction: 'forward' },
        { type: 'parking', width: 2.5 }, { type: 'driving', width: 3.5, direction: 'forward' }, { type: 'driving', width: 3.5, direction: 'forward' },
        { type: 'driving', width: 3.5, direction: 'forward' },
        { type: 'median', width: 24, landscape: 'grass' },
        { type: 'driving', width: 3.5, direction: 'backward' }, { type: 'driving', width: 3.5, direction: 'backward' }, { type: 'driving', width: 3.5, direction: 'backward' },
        { type: 'parking', width: 2.5 }, { type: 'cycleway', width: 3, direction: 'backward' }, { type: 'verge', width: 5, landscape: 'trees' },
        { type: 'sidewalk', width: 7 }
    ]
};

// OSM default widths, used only when a way says nothing more specific.
const OSM_DEFAULT_SIDEWALK_WIDTH = 2;
const OSM_DEFAULT_CYCLEWAY_WIDTH = 1.5;
const OSM_DEFAULT_PARKING_WIDTH = 2.5;
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

function isCorridorLaneType(type) {
    return Object.prototype.hasOwnProperty.call(CORRIDOR_LANE_TYPES, type);
}

function corridorLandscapeOf(strip) {
    return strip && CORRIDOR_GREEN_TYPES.has(strip.type) && strip.landscape === 'trees' ? 'trees' : 'grass';
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
        return lane;
    }).filter(strip => isCorridorLaneType(strip.type) && Number.isFinite(strip.width) && strip.width > 0);
    return strips.length ? { strips } : null;
}

function corridorProfileWidth(profile) {
    const normalized = normalizeCorridorProfile(profile);
    if (!normalized) return 0;
    return normalized.strips.reduce((total, strip) => total + strip.width, 0);
}

// Round to millimetres: the presets are exact, but rebalancing divides.
function roundStripWidth(width) {
    return Math.round(width * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// Editing
//
// Every edit here preserves the corridor's total width, and that is the whole point: the footprint is a
// function of the total alone, so a profile-only edit cannot move the corridor, cannot change the parcel
// split, and cannot invalidate a proposal derived from it. Whatever a lane gains or gives up is taken
// from or handed to the traffic lanes, which are the only lanes with slack.
//
// An edit that the traffic lanes cannot absorb returns null. That is a refusal, not a rounding problem:
// the caller must reject the change rather than quietly widening the road.
// ---------------------------------------------------------------------------

// A traffic lane narrower than this is not a traffic lane.
const CORRIDOR_MIN_DRIVING_WIDTH = 2.5;

// Take `delta` metres out of the driving lanes (negative gives metres back), in proportion to their
// widths. `exceptIndex` holds one lane out of the redistribution — the lane being resized cannot pay
// for its own change. Returns new strips, or null when the lanes have no room.
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

// Set one lane's width, paying for it out of the traffic lanes.
function withLaneWidth(profile, index, width) {
    const normalized = normalizeCorridorProfile(profile);
    if (!normalized || !normalized.strips[index]) return null;
    const target = Number(width);
    if (!Number.isFinite(target) || target <= 0) return null;

    const lane = normalized.strips[index];
    if (lane.type === 'driving' && target < CORRIDOR_MIN_DRIVING_WIDTH) return null;

    const resized = normalized.strips.map((strip, i) => (i === index ? { ...strip, width: roundStripWidth(target) } : { ...strip }));
    // A traffic lane cannot pay for its own widening, so it is held out of the redistribution.
    const strips = redistributeToDriving(resized, target - lane.width, index);
    return strips ? { strips } : null;
}

// Change the whole footprint while drawing. Roadside furniture keeps its real-world width; the traffic
// lanes absorb the difference, just as they do for an individual strip edit.
function withCorridorWidth(profile, width) {
    const normalized = normalizeCorridorProfile(profile);
    const target = Number(width);
    if (!normalized || !Number.isFinite(target) || target <= 0) return null;
    const current = corridorProfileWidth(normalized);
    const strips = redistributeToDriving(normalized.strips, current - target);
    return strips ? normalizeCorridorProfile(strips) : null;
}

// Change what a lane *is* without changing how wide it is — parking becomes trees, a lane becomes a
// cycleway. The total cannot move, so this never fails on width.
function withLaneType(profile, index, type) {
    const normalized = normalizeCorridorProfile(profile);
    if (!normalized || !normalized.strips[index] || !isCorridorLaneType(type)) return null;

    return normalizeCorridorProfile(normalized.strips.map((strip, i) => {
        if (i !== index) return strip;
        const lane = { type, width: strip.width };
        if (CORRIDOR_LANE_TYPES[type].directional) lane.direction = strip.direction || 'forward';
        if (CORRIDOR_GREEN_TYPES.has(type)) {
            lane.landscape = CORRIDOR_GREEN_TYPES.has(strip.type) ? corridorLandscapeOf(strip) : 'grass';
        }
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

// Insert a lane at `index`, taking its width out of the traffic lanes.
function withLaneInserted(profile, index, lane) {
    const normalized = normalizeCorridorProfile(profile);
    if (!normalized || !lane || !isCorridorLaneType(lane.type)) return null;
    const width = Number(lane.width);
    if (!Number.isFinite(width) || width <= 0) return null;

    const at = Math.max(0, Math.min(index, normalized.strips.length));
    const strips = redistributeToDriving(normalized.strips, width);
    if (!strips) return null;
    strips.splice(at, 0, { ...lane, width: roundStripWidth(width) });
    return normalizeCorridorProfile(strips);
}

// Remove a lane and hand its width back to the traffic lanes.
function withLaneRemoved(profile, index) {
    const normalized = normalizeCorridorProfile(profile);
    if (!normalized || !normalized.strips[index]) return null;
    if (normalized.strips.length < 2) return null;

    const removed = normalized.strips[index];
    const remaining = normalized.strips.filter((strip, i) => i !== index);
    // Removing the last traffic lane leaves nothing to hand the width to; widen the neighbours instead.
    const hasDriving = remaining.some(strip => strip.type === 'driving');
    if (!hasDriving) {
        const share = removed.width / remaining.length;
        return normalizeCorridorProfile(remaining.map(strip => ({ ...strip, width: roundStripWidth(strip.width + share) })));
    }
    const strips = redistributeToDriving(remaining, -removed.width);
    return strips ? normalizeCorridorProfile(strips) : null;
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

// The profile a corridor should have when it predates this model (or was drawn by the older picker,
// which only ever produced a total width and an unused sidewalk number).
function corridorProfileFromLegacy(width, sidewalkWidth, isTrack) {
    const total = Number(width);
    if (!Number.isFinite(total) || total <= 0) return null;
    if (isTrack) return { strips: [{ type: 'rail', width: total }] };

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
    strips.push({ type: 'driving', width: lane, direction: 'forward' }, { type: 'driving', width: lane, direction: 'backward' });
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
        const railWidth = parseOsmNumber(source.width) || Number(fallbackWidth) || 3;
        const tracks = Math.max(1, parseInt(source.tracks, 10) || 1);
        return { strips: Array.from({ length: tracks }, () => ({ type: 'rail', width: railWidth / tracks })) };
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
    const taggedForward = parseInt(source['lanes:forward'], 10);
    const forwardCount = Number.isFinite(taggedForward)
        ? taggedForward
        : (oneway ? (source.oneway === '-1' ? 0 : laneCount) : Math.ceil(laneCount / 2));

    const left = [];
    const right = [];
    ['left', 'right'].forEach(side => {
        const target = side === 'left' ? left : right;
        const direction = side === 'left' ? 'forward' : 'backward';

        if (osmSidePresent(osmSideValue(source, 'sidewalk', side))) {
            target.push({ type: 'sidewalk', width: osmSideWidth(source, 'sidewalk', side, OSM_DEFAULT_SIDEWALK_WIDTH) });
        }
        if (osmSidePresent(osmSideValue(source, 'verge', side))) {
            target.push({ type: 'verge', width: osmSideWidth(source, 'verge', side, OSM_DEFAULT_VERGE_WIDTH) });
        }
        if (osmSidePresent(osmSideValue(source, 'cycleway', side))) {
            target.push({ type: 'cycleway', width: osmSideWidth(source, 'cycleway', side, OSM_DEFAULT_CYCLEWAY_WIDTH), direction });
        }
        // The current `parking:<side>` scheme, falling back to the older `parking:lane:<side>`.
        const parking = osmSidePresent(osmSideValue(source, 'parking', side))
            || osmSidePresent(osmSideValue(source, 'parking:lane', side));
        if (parking) {
            target.push({ type: 'parking', width: osmSideWidth(source, 'parking', side, OSM_DEFAULT_PARKING_WIDTH) });
        }
    });

    // A median splits the carriageway; it sits between the forward and backward lanes.
    const medianWidth = osmSidePresent(source.median)
        ? (parseOsmNumber(source['median:width']) || OSM_DEFAULT_MEDIAN_WIDTH)
        : 0;

    const flanks = [...left, ...right].reduce((sum, lane) => sum + lane.width, 0) + medianWidth;
    const defaultLaneWidth = OSM_LANE_WIDTH_BY_HIGHWAY[source.highway] || OSM_DEFAULT_LANE_WIDTH;
    const carriageway = taggedWidth > 0 ? taggedWidth - flanks : laneCount * defaultLaneWidth;
    // Only a tagged width can be wrong about its own furniture; refuse rather than draw lanes of air.
    if (carriageway < laneCount * 2) return null;

    const laneWidth = roundStripWidth(carriageway / laneCount);
    const driving = Array.from({ length: laneCount }, (unused, index) => ({
        type: 'driving',
        width: laneWidth,
        direction: index < forwardCount ? 'forward' : 'backward'
    }));
    // Rounding the lane width loses up to a millimetre per lane; give the remainder back to the last one
    // so the cross-section sums to exactly the width the corridor has.
    driving[driving.length - 1].width = roundStripWidth(carriageway - laneWidth * (laneCount - 1));

    const carriagewayLanes = medianWidth
        ? [...driving.slice(0, forwardCount), { type: 'median', width: medianWidth }, ...driving.slice(forwardCount)]
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
        return tags;
    }

    const sideOf = (index) => (index < centre ? 'left' : 'right');
    const driving = lanes.filter(lane => lane.type === 'driving');
    const forward = driving.filter(lane => lane.direction === 'forward').length;

    const tags = {
        width: String(roundStripWidth(corridorProfileWidth(normalized))),
        lanes: String(driving.length)
    };
    if (forward === driving.length) tags.oneway = 'yes';
    else if (forward) {
        tags['lanes:forward'] = String(forward);
        tags['lanes:backward'] = String(driving.length - forward);
    }
    const median = lanes.find(lane => lane.type === 'median');
    if (median) {
        tags.median = 'yes';
        tags['median:width'] = String(roundStripWidth(median.width));
    }

    // `sidewalk:both=yes` + `sidewalk:both:width=2`, collapsing to one side when only one side has it,
    // and to per-side widths when the two sides differ — the same shape OSM's own per-side schemes take.
    const emit = (type, key, presentValue) => {
        const found = lanes
            .map((lane, index) => ({ lane, index }))
            .filter(entry => entry.lane.type === type);
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
    };

    emit('sidewalk', 'sidewalk', 'yes');
    emit('verge', 'verge', 'yes');
    emit('cycleway', 'cycleway', 'lane');
    emit('parking', 'parking', 'lane');
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
// profiles existed. Always returns a profile whose total equals the definition's width.
function corridorProfileOf(definition) {
    if (!definition) return null;
    const stored = normalizeCorridorProfile(definition.profile);
    if (stored) return stored;
    const isTrack = !!(definition.metadata && definition.metadata.isTrack);
    return corridorProfileFromLegacy(definition.width, definition.sidewalkWidth, isTrack);
}

// The centerline of a stored corridor, as segments of {lat,lng}. A definition holds either one flat
// list of points (older single-segment corridors) or a list of segments; both live under `points`.
function corridorCenterlineOf(definition) {
    const raw = definition && (
        (Array.isArray(definition.points) && definition.points.length && definition.points)
        || (Array.isArray(definition.segments) && definition.segments)
    );
    if (!raw || !raw.length) return [];

    const toPoint = (point) => {
        if (!point) return null;
        const lat = Number(point.lat !== undefined ? point.lat : (Array.isArray(point) ? point[1] : NaN));
        const lng = Number(point.lng !== undefined ? point.lng : (Array.isArray(point) ? point[0] : NaN));
        return (Number.isFinite(lat) && Number.isFinite(lng)) ? { lat, lng } : null;
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

// The ring for one strip, in whatever coordinate system `pointsXY` is in (metres, x east, y north):
// the left boundary forward, the right boundary back. Kept free of the projection so it can be unit
// tested without a map.
function corridorStripRingPlanar(pointsXY, left, right) {
    if (!Array.isArray(pointsXY) || pointsXY.length < 2) return null;
    if (!Number.isFinite(left) || !Number.isFinite(right) || left === right) return null;

    const leftSide = offsetPolylinePlanar(pointsXY, Math.max(left, right));
    const rightSide = offsetPolylinePlanar(pointsXY, Math.min(left, right));
    if (!leftSide || !rightSide) return null;
    return [...leftSide, ...rightSide.reverse()];
}

function corridorProjectionAvailable() {
    return typeof wgs84ToHTRS96 === 'function' && typeof htrs96ToWGS84 === 'function';
}

// One strip of one centerline segment, as Leaflet LatLngs.
function buildCorridorStripPolygon(points, left, right) {
    if (!corridorProjectionAvailable()) return null;
    if (!Array.isArray(points) || points.length < 2) return null;

    const planar = points
        .map(point => (point && Number.isFinite(point.lat) && Number.isFinite(point.lng)) ? wgs84ToHTRS96(point.lat, point.lng) : null)
        .filter(xy => Array.isArray(xy) && Number.isFinite(xy[0]) && Number.isFinite(xy[1]));
    if (planar.length < 2) return null;

    const ring = corridorStripRingPlanar(planar, left, right);
    if (!ring) return null;
    return ring.map(([x, y]) => {
        const [lat, lng] = htrs96ToWGS84(x, y);
        return { lat, lng };
    });
}

// Every strip of a whole corridor, ready to draw: `[{ type, left, right, polygons }]`, left edge first.
// `segments` is either one centerline (LatLng[]) or several disjoint ones (LatLng[][]); a strip gets one
// polygon per centerline segment, left unmerged because the segments are disjoint bands, not one shape.
function buildCorridorStrips(segments, profile) {
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
            .map(centerline => buildCorridorStripPolygon(centerline, span.left, span.right))
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
function buildCorridorDecorations(segments, profile) {
    if (!corridorProjectionAvailable()) return [];
    const spans = corridorStripSpans(profile);
    if (!spans.length) return [];
    const isLatLng = point => point && Number.isFinite(point.lat) && Number.isFinite(point.lng);
    const centerlines = (Array.isArray(segments) && segments.length && isLatLng(segments[0]))
        ? [segments]
        : (Array.isArray(segments) ? segments.filter(segment => Array.isArray(segment) && segment.length >= 2) : []);
    const planarCenterlines = centerlines.map(segment => segment.map(point => wgs84ToHTRS96(point.lat, point.lng)));
    const junctionPoints = findCorridorJunctionsPlanar(planarCenterlines).map(junction => junction.point);
    const junctionClearance = corridorProfileWidth(profile) / 2 + 4;
    const decorations = [];

    spans.forEach(strip => {
        let kind = null;
        if (strip.type === 'cycleway') kind = 'bike';
        if (strip.type === 'sidewalk') kind = 'pedestrian';
        if (CORRIDOR_GREEN_TYPES.has(strip.type) && corridorLandscapeOf(strip) === 'trees') kind = 'tree';
        if (!kind) return;

        const spacing = CORRIDOR_DECORATION_SPACING[kind];
        const offset = (strip.left + strip.right) / 2;
        centerlines.forEach((centerline, segmentIndex) => {
            const offsetLine = buildCorridorOffsetLine(centerline, offset);
            if (!offsetLine) return;
            const planar = offsetLine.map(point => wgs84ToHTRS96(point.lat, point.lng));
            samplePolylinePlanar(planar, spacing).forEach(sample => {
                if (junctionPoints.some(point => Math.hypot(sample.point[0] - point[0], sample.point[1] - point[1]) < junctionClearance)) {
                    return;
                }
                const [lat, lng] = htrs96ToWGS84(sample.point[0], sample.point[1]);
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

function planarRingToLatLng(ring) {
    return ring.map(([x, y]) => {
        const [lat, lng] = htrs96ToWGS84(x, y);
        return { lat, lng };
    });
}

// Local treatment for every junction. A plain asphalt arm patch hides lane/median lines through the
// conflict area while leaving the outer sidewalk bands visible as corners; zebra bars then bridge the
// roadway on every approach that belongs to a profile with sidewalks.
function buildCorridorJunctionTreatments(segments, profile) {
    if (!corridorProjectionAvailable()) return [];
    const spans = corridorStripSpans(profile);
    if (!spans.length) return [];
    const isLatLng = point => point && Number.isFinite(point.lat) && Number.isFinite(point.lng);
    const centerlines = (Array.isArray(segments) && segments.length && isLatLng(segments[0]))
        ? [segments]
        : (Array.isArray(segments) ? segments.filter(segment => Array.isArray(segment) && segment.length >= 2) : []);
    const planarSegments = centerlines.map(segment => segment.map(point => wgs84ToHTRS96(point.lat, point.lng)));
    const junctions = findCorridorJunctionsPlanar(planarSegments);
    if (!junctions.length) return [];
    return junctions.map(junction => corridorJunctionTreatmentPlanar(junction, profile)).filter(Boolean);
}

// One junction's visual treatment: an asphalt patch down every arm plus zebra bars on each
// approach, sized from the given profile. Shared by a road's own junctions and by the
// cross-corridor junctions formed where two applied roads meet.
function corridorJunctionTreatmentPlanar(junction, profile) {
    const spans = corridorStripSpans(profile);
    if (!spans.length) return null;
    const roadway = spans.filter(strip => strip.type !== 'sidewalk' && strip.type !== 'verge');
    const roadwayLeft = roadway.length ? Math.max(...roadway.map(strip => strip.left)) : corridorProfileWidth(profile) / 2;
    const roadwayRight = roadway.length ? Math.min(...roadway.map(strip => strip.right)) : -corridorProfileWidth(profile) / 2;
    const hasSidewalk = spans.some(strip => strip.type === 'sidewalk');
    const totalWidth = corridorProfileWidth(profile);
    const setback = Math.max(3, Math.min(8, totalWidth * 0.12));
    const crossingDepth = 3;
    const armLength = setback + crossingDepth + 1;

    const surfacePolygons = [];
    const crosswalkPolygons = [];
    junction.arms.forEach(direction => {
        const end = [junction.point[0] + direction[0] * armLength, junction.point[1] + direction[1] * armLength];
        const surface = corridorStripRingPlanar([junction.point, end], roadwayLeft, roadwayRight);
        if (surface) surfacePolygons.push(planarRingToLatLng(surface));
        if (!hasSidewalk) return;

        const normal = [-direction[1], direction[0]];
        const stripeWidth = 0.8;
        const stripeGap = 0.8;
        for (let across = roadwayRight + 0.25; across + stripeWidth <= roadwayLeft - 0.25; across += stripeWidth + stripeGap) {
            const corners = [
                [setback, across], [setback + crossingDepth, across],
                [setback + crossingDepth, across + stripeWidth], [setback, across + stripeWidth]
            ].map(([along, lateral]) => [
                junction.point[0] + direction[0] * along + normal[0] * lateral,
                junction.point[1] + direction[1] * along + normal[1] * lateral
            ]);
            crosswalkPolygons.push(planarRingToLatLng(corners));
        }
    });
    const [lat, lng] = htrs96ToWGS84(junction.point[0], junction.point[1]);
    return { lat, lng, degree: junction.degree, surfacePolygons, crosswalkPolygons };
}

// Intersections BETWEEN applied roads. Snapping while drawing copies exact coordinates, so a
// road snapped onto another one shares a vertex with it, or ends exactly on one of its edges.
// This finds those meeting points across corridors and gives them the same junction treatment
// a road's own T-joints get. Conditions: at least two DIFFERENT corridors at the node; a vertex
// counts as lying on another road's edge within 0.75 m (an unsnapped near-miss stays two roads).
function buildCrossCorridorJunctionTreatments(corridors) {
    if (!corridorProjectionAvailable() || !Array.isArray(corridors) || corridors.length < 2) return [];
    const TOLERANCE = 0.75; // metres
    const planarCorridors = corridors
        .map(entry => ({
            profile: entry.profile,
            segments: (entry.centerline || [])
                .filter(segment => Array.isArray(segment) && segment.length >= 2)
                .map(segment => segment.map(point => wgs84ToHTRS96(point.lat, point.lng)))
        }))
        .filter(corridor => corridor.segments.length && corridor.profile);
    if (planarCorridors.length < 2) return [];

    // A vertex of one corridor that lies on another corridor's edge becomes a node of that edge
    // too (render-only), so the junction finder sees the T-joint.
    const augmented = planarCorridors.map(corridor => ({
        profile: corridor.profile,
        segments: corridor.segments.map(segment => segment.map(point => point.slice()))
    }));
    augmented.forEach((target, targetIndex) => {
        target.segments = target.segments.map(segment => {
            const result = [segment[0]];
            for (let i = 0; i < segment.length - 1; i++) {
                const a = segment[i];
                const b = segment[i + 1];
                const dx = b[0] - a[0];
                const dy = b[1] - a[1];
                const len2 = dx * dx + dy * dy;
                const inserts = [];
                if (len2 > 1e-9) {
                    augmented.forEach((other, otherIndex) => {
                        if (otherIndex === targetIndex) return;
                        other.segments.forEach(otherSegment => otherSegment.forEach(point => {
                            const t = ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / len2;
                            if (t <= 1e-6 || t >= 1 - 1e-6) return;
                            const px = a[0] + t * dx;
                            const py = a[1] + t * dy;
                            if (Math.hypot(point[0] - px, point[1] - py) <= TOLERANCE) {
                                inserts.push({ t, point: [point[0], point[1]] });
                            }
                        }));
                    });
                }
                inserts.sort((x, y) => x.t - y.t).forEach(insert => {
                    const last = result[result.length - 1];
                    if (Math.hypot(last[0] - insert.point[0], last[1] - insert.point[1]) > 1e-3) {
                        result.push(insert.point);
                    }
                });
                result.push(b);
            }
            return result;
        });
    });

    const keyOf = point => `${Math.round(point[0] * 100) / 100},${Math.round(point[1] * 100) / 100}`;
    const touchingByNode = new Map();
    augmented.forEach((corridor, index) => corridor.segments.forEach(segment => segment.forEach(point => {
        const key = keyOf(point);
        if (!touchingByNode.has(key)) touchingByNode.set(key, new Set());
        touchingByNode.get(key).add(index);
    })));

    return findCorridorJunctionsPlanar(augmented.flatMap(corridor => corridor.segments))
        .filter(junction => (touchingByNode.get(keyOf(junction.point))?.size || 0) >= 2)
        .map(junction => {
            // The widest meeting road decides the junction's asphalt reach and zebra span.
            const profile = [...touchingByNode.get(keyOf(junction.point))]
                .map(index => planarCorridors[index].profile)
                .reduce((best, candidate) => corridorProfileWidth(candidate) > corridorProfileWidth(best) ? candidate : best);
            return corridorJunctionTreatmentPlanar(junction, profile);
        })
        .filter(Boolean);
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

// One offset polyline of the centerline as Leaflet LatLngs — a lane marking is a line, not a band.
function buildCorridorOffsetLine(points, offset) {
    if (!corridorProjectionAvailable() || !Array.isArray(points) || points.length < 2) return null;
    const planar = points
        .map(point => (point && Number.isFinite(point.lat) && Number.isFinite(point.lng)) ? wgs84ToHTRS96(point.lat, point.lng) : null)
        .filter(xy => Array.isArray(xy) && Number.isFinite(xy[0]) && Number.isFinite(xy[1]));
    if (planar.length < 2) return null;
    const line = offsetPolylinePlanar(planar, offset);
    if (!line) return null;
    return line.map(([x, y]) => {
        const [lat, lng] = htrs96ToWGS84(x, y);
        return { lat, lng };
    });
}

// Every lane-separator line of a whole corridor: `[{ kind, lines }]`, one line per centerline segment.
function buildCorridorLaneMarkings(segments, profile) {
    const separators = corridorLaneSeparators(profile);
    if (!separators.length) return [];

    const isLatLng = (p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lng);
    const centerlines = (Array.isArray(segments) && segments.length && isLatLng(segments[0]))
        ? [segments]
        : (Array.isArray(segments) ? segments.filter(seg => Array.isArray(seg) && seg.length >= 2) : []);
    if (!centerlines.length) return [];

    return separators.map(sep => ({
        kind: sep.kind,
        lines: centerlines.map(centerline => buildCorridorOffsetLine(centerline, sep.offset)).filter(Boolean)
    })).filter(marking => marking.lines.length);
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
    window.withSidewalkWidth = withSidewalkWidth;
    window.withCorridorWidth = withCorridorWidth;
    window.withLaneWidth = withLaneWidth;
    window.withLaneType = withLaneType;
    window.withLaneLandscape = withLaneLandscape;
    window.withLaneInserted = withLaneInserted;
    window.withLaneRemoved = withLaneRemoved;
    window.withLaneMoved = withLaneMoved;
    window.corridorCenterlineOf = corridorCenterlineOf;
    window.corridorLandscapeOf = corridorLandscapeOf;

    window.buildCorridorStrips = buildCorridorStrips;
    window.buildCorridorStripPolygon = buildCorridorStripPolygon;
    window.corridorStripRingPlanar = corridorStripRingPlanar;
    window.buildCorridorDecorations = buildCorridorDecorations;
    window.buildCorridorJunctionTreatments = buildCorridorJunctionTreatments;
    window.buildCrossCorridorJunctionTreatments = buildCrossCorridorJunctionTreatments;
}

// Node-visible for unit tests; the browser loads this file as a classic script.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        CORRIDOR_LANE_TYPES,
        corridorProfileFromOsmTags,
        corridorProfileToOsmTags,
        corridorProfileFromOsmFeature,
        CORRIDOR_PROFILE_PRESETS,
        normalizeCorridorProfile,
        corridorProfileWidth,
        corridorProfileFromLegacy,
        corridorProfileOf,
        corridorStripSpans,
        corridorCenterlineOf,
        corridorLandscapeOf,
        withSidewalkWidth,
        withCorridorWidth,
        withLaneWidth,
        withLaneType,
        withLaneLandscape,
        withLaneInserted,
        withLaneRemoved,
        withLaneMoved,
        CORRIDOR_MIN_DRIVING_WIDTH,
        offsetPolylinePlanar,
        corridorStripRingPlanar,
        corridorLaneSeparators,
        samplePolylinePlanar,
        findCorridorJunctionsPlanar,
        buildCorridorDecorations,
        buildCorridorJunctionTreatments,
        buildCrossCorridorJunctionTreatments
    };
}
