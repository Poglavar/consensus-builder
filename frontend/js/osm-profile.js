// Reconstructs the cross-section an existing street ALREADY has, for one adopted segment, from the
// OSM data covering that segment. The geometric fit (corridorProfileForAvailableWidth) knows only how
// many metres there are; this knows what is in them — how many lanes, which side the parking is on,
// whether there is a cycle lane — because OSM says so.
//
// Three jobs, in order:
//
//   1. MATCH. A run is a chain of pieces of several OSM ways, so the tags that describe it are the tags
//      of the ways that actually cover THIS run, length-weighted — not the ways of the whole street.
//      The same sweep finds the ways running BESIDE the run, which is what makes Zagreb legible (below).
//   2. RESOLVE. Zagreb's tagging says `sidewalk:both=separate` on 364 of 550 tagged sides in Donji Grad
//      and parks half the city `on_kerb`/`half_on_kerb`. Read literally by the OSM bridge, `separate`
//      means "no sidewalk" and a kerb parking bay means "a full lane of carriageway", both wrong. This
//      step rewrites the tags into what is physically there, using the matched neighbours for evidence.
//   3. FIT. The total is not ours to choose — it is the corridor the kerbs already make. The lanes OSM
//      describes are at their nominal widths, so they are grown or shrunk, in a fixed priority order,
//      until the section sums to exactly the measured width.
//
// Everything is planar (metres, x east, y north) and pure — projection, fetching and rendering stay
// with the caller, exactly like road-segmentation.js — so each step is unit-testable without a map.
(function (global) {
    'use strict';

    const OSM_PROFILE_DEFAULTS = {
        sampleSpacing: 5,        // m between the stations the run is measured at
        carrierTolerance: 4,     // m — a way this close all along the run IS the run
        carrierCoverage: 0.25,   // fraction of stations a way must cover to describe the run
        flankMinOffset: 1.5,     // m — nearer than this it is the carriageway, not a thing beside it
        flankMaxOffset: 25,      // m — further out it belongs to another street
        flankCoverage: 0.5,      // fraction of stations a neighbour must run beside to count
        flankSideAgreement: 0.75,// a way that crosses the run is on both sides; a pavement is on one
        maxLaneWidth: 3.5,       // m — wider than this is not a lane, it is unmarked asphalt
        minLaneWidth: 2.5,
        minSidewalkWidth: 1,
        maxSidewalkWidth: 6,
        defaultSidewalkWidth: 2,
        parkingWidth: 2.5,
        maxDrivingLanes: 6
    };

    // The classes that can carry a segment. Same list system-road-adoption segments on, plus the
    // carriageway-free ones — a pedestrian street or a footpath parcel is a corridor too, and adopting
    // it should give it the footway it is rather than nothing.
    const CARRIER_HIGHWAYS = new Set([
        'motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link',
        'secondary', 'secondary_link', 'tertiary', 'tertiary_link',
        'unclassified', 'residential', 'living_street', 'service', 'road',
        'pedestrian', 'footway', 'path', 'steps', 'cycleway', 'bridleway', 'track'
    ]);
    // Preferred when both kinds cover the run: a footway drawn along a street's pavement must never be
    // mistaken for the street.
    const DRIVEABLE_HIGHWAYS = new Set([
        'motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link',
        'secondary', 'secondary_link', 'tertiary', 'tertiary_link',
        'unclassified', 'residential', 'living_street', 'service', 'road', 'pedestrian', 'track'
    ]);
    const FOOT_HIGHWAYS = new Set(['footway', 'path', 'steps']);
    const CYCLE_HIGHWAYS = new Set(['cycleway']);

    // Values that mean "there is nothing here", as opposed to "it is mapped somewhere else".
    const ABSENT_VALUES = new Set(['no', 'none', 'false', '0']);
    // A cycleway that is only a pictogram painted in the traffic lane. It takes no width of its own,
    // and reading it as a 1.5 m strip steals that width from the carriageway. 77 of the 240 tagged
    // cycleway sides in Donji Grad are these.
    const NO_WIDTH_CYCLEWAY = new Set(['shared_lane', 'share_busway', 'opposite_share_busway', 'no', 'none']);
    // How much of a kerbside bay stands ON the pavement rather than in the carriageway. Zagreb parks
    // half the old town this way, and the difference is a whole lane of road.
    const PARKING_KERB_SHARE = { on_kerb: 1, half_on_kerb: 0.5, street_side: 0, lane: 0 };
    const PARKING_PRESENT = new Set(['lane', 'street_side', 'on_kerb', 'half_on_kerb', 'yes']);

    // ---------------------------------------------------------------------------
    // Planar geometry (no projection, no turf)
    // ---------------------------------------------------------------------------

    function isFinitePoint(p) {
        return Array.isArray(p) && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1]));
    }

    function polylineLength(points) {
        if (!Array.isArray(points) || points.length < 2) return 0;
        let total = 0;
        for (let i = 1; i < points.length; i += 1) {
            total += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
        }
        return total;
    }

    // Evenly spaced stations along a polyline, each carrying the unit tangent there. The whole match is
    // done at these stations, so a way is compared to the run along its length rather than at one point.
    function stationsAlong(points, spacing) {
        if (!Array.isArray(points) || points.length < 2) return [];
        const step = Number(spacing) > 0 ? Number(spacing) : OSM_PROFILE_DEFAULTS.sampleSpacing;
        const stations = [];
        let carry = 0;
        for (let i = 1; i < points.length; i += 1) {
            const [ax, ay] = points[i - 1];
            const [bx, by] = points[i];
            const dx = bx - ax;
            const dy = by - ay;
            const len = Math.hypot(dx, dy);
            if (!(len > 0)) continue;
            const tx = dx / len;
            const ty = dy / len;
            for (let d = carry; d < len; d += step) {
                stations.push({ x: ax + tx * d, y: ay + ty * d, tx, ty });
            }
            carry = ((carry - len) % step + step) % step;
        }
        const last = points[points.length - 1];
        const previous = points[points.length - 2];
        const tail = Math.hypot(last[0] - previous[0], last[1] - previous[1]);
        if (tail > 0) {
            stations.push({ x: last[0], y: last[1], tx: (last[0] - previous[0]) / tail, ty: (last[1] - previous[1]) / tail });
        }
        return stations;
    }

    // The nearest point on `line` to (px, py), with the line's own tangent there. The tangent is what
    // says whether the run and the way head the same way, which decides whether OSM's left is our left.
    function nearestOnPolyline(px, py, line) {
        let best = null;
        for (let i = 1; i < line.length; i += 1) {
            const [ax, ay] = line[i - 1];
            const [bx, by] = line[i];
            const dx = bx - ax;
            const dy = by - ay;
            const lengthSq = dx * dx + dy * dy;
            if (!(lengthSq > 0)) continue;
            let t = ((px - ax) * dx + (py - ay) * dy) / lengthSq;
            t = Math.max(0, Math.min(1, t));
            const x = ax + t * dx;
            const y = ay + t * dy;
            const distance = Math.hypot(px - x, py - y);
            if (!best || distance < best.distance) {
                const len = Math.sqrt(lengthSq);
                best = { distance, x, y, tx: dx / len, ty: dy / len };
            }
        }
        return best;
    }

    // Which side of the run a point lies on, in the run's own frame: +1 to the left of travel, -1 to
    // the right. (x east, y north, so rotating the tangent a quarter turn anticlockwise points left.)
    function sideOfStation(station, x, y) {
        const cross = station.tx * (y - station.y) - station.ty * (x - station.x);
        return cross >= 0 ? 1 : -1;
    }

    // Is a planar point inside a ring? Crossing count, the same test road-segmentation uses — kept
    // local so this module stays free of it.
    function pointInRing(point, ring) {
        if (!Array.isArray(point) || !Array.isArray(ring) || ring.length < 3) return false;
        const [x, y] = point;
        let inside = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const [xi, yi] = ring[i];
            const [xj, yj] = ring[j];
            if (((yi > y) !== (yj > y))
                && x < ((xj - xi) * (y - yi)) / ((yj - yi) || Number.EPSILON) + xi) inside = !inside;
        }
        return inside;
    }

    // Does any part of this line fall inside the ring?
    //
    // Sampled along its length, NOT at its vertices. An OSM way is drawn with a vertex only where it
    // bends: a 500 m straight has two, and a segment's corridor is a few metres wide and a couple of
    // hundred long, so testing vertices asks "does this way happen to bend inside the corridor" — to
    // which the answer for the very way the segment is made of is usually no. That mistake rejected
    // the carrier of nearly every segment.
    function lineTouchesRing(line, ring, step = 5) {
        for (let i = 1; i < line.length; i += 1) {
            const a = line[i - 1];
            const b = line[i];
            if (pointInRing(a, ring)) return true;
            const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
            const steps = Math.max(1, Math.ceil(length / step));
            for (let n = 1; n <= steps; n += 1) {
                const t = n / steps;
                if (pointInRing([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], ring)) return true;
            }
        }
        return false;
    }

    function median(values) {
        if (!values.length) return NaN;
        const sorted = values.slice().sort((a, b) => a - b);
        const mid = sorted.length >> 1;
        return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    }

    function roundWidth(width) {
        return Math.round(width * 1000) / 1000;
    }

    function highwayOf(way) {
        return String(way?.properties?.highway_type || way?.properties?.highway || '').trim().toLowerCase();
    }

    function tagsOf(way) {
        const tags = way?.properties?.tags;
        return (tags && typeof tags === 'object') ? tags : {};
    }

    // ---------------------------------------------------------------------------
    // 1. Match the ways to the run
    // ---------------------------------------------------------------------------

    // Sort the ways near a run into the ones that ARE it and the ones that run BESIDE it.
    //
    // `carriers` describe the segment: their tags, weighted by how much of the run each covers, are the
    // segment's tags. `flanks` are the evidence for everything Zagreb tags as `separate` — a pavement
    // mapped as its own way is invisible to the tags and obvious to the geometry, and its distance from
    // the centreline is a measurement of how much room the carriageway has.
    function matchWaysToRun(runXY, ways, options = {}) {
        const settings = { ...OSM_PROFILE_DEFAULTS, ...options };
        const empty = { carriers: [], flanks: [], reversed: false, stations: 0 };
        if (!Array.isArray(runXY) || runXY.length < 2 || !Array.isArray(ways) || !ways.length) return empty;

        const stations = stationsAlong(runXY, settings.sampleSpacing);
        if (!stations.length) return empty;

        // Measure every way against the run first, and only then decide what each one is. Deciding as
        // we go would let a pavement that hugs a narrow street be taken for the street itself and,
        // being a carrier, disappear as evidence for its own side.
        // WHICH WAYS DESCRIBE THIS SEGMENT.
        //
        // Given the segment's own polygon — the corridor between its kerb lines — the answer is every
        // way that falls inside it, which is the honest question: a segment is formed first, and what
        // is IN it is what describes it. A fixed reach cannot do that job, because the right reach is
        // the corridor's own width: 25 m drags in the parallel street beside a narrow lane, and misses
        // the pavement of a boulevard.
        //
        // Without a polygon (the adoption path, which measures before it has one) the fixed reach
        // remains the fallback.
        const polygon = Array.isArray(settings.polygonXY) && settings.polygonXY.length >= 3
            ? settings.polygonXY
            : null;
        // A road parcel's bbox can pull back hundreds of ways, nearly all of them irrelevant. Rejecting
        // by bounding box first keeps this to the handful that could touch the run.
        const reach = polygon ? Math.max(settings.flankMaxOffset, 5) : settings.flankMaxOffset;
        const bounds = runXY.reduce((box, [x, y]) => [
            Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x), Math.max(box[3], y)
        ], [Infinity, Infinity, -Infinity, -Infinity]);

        const measured = [];
        ways.forEach(way => {
            const line = Array.isArray(way?.pointsXY) ? way.pointsXY.filter(isFinitePoint) : [];
            if (line.length < 2) return;
            const highway = highwayOf(way);
            if (!CARRIER_HIGHWAYS.has(highway)) return;
            const box = line.reduce((b, [x, y]) => [
                Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)
            ], [Infinity, Infinity, -Infinity, -Infinity]);
            if (box[0] > bounds[2] + reach || box[2] < bounds[0] - reach
                || box[1] > bounds[3] + reach || box[3] < bounds[1] - reach) return;

            const insidePolygon = polygon ? lineTouchesRing(line, polygon) : false;
            let onRun = 0;
            let alignment = 0;
            const beside = { left: [], right: [] };
            stations.forEach(station => {
                const near = nearestOnPolyline(station.x, station.y, line);
                if (!near) return;
                if (near.distance <= settings.carrierTolerance) {
                    onRun += 1;
                    alignment += station.tx * near.tx + station.ty * near.ty;
                    return;
                }
                // A FLANK has to be inside the segment's own polygon when there is one — that is the
                // honest question, and one a fixed reach cannot answer, since the right reach is the
                // corridor's own width. (The CARRIER is never gated this way: a segment is made of its
                // carrier, and a polygon drawn from a mis-measured corridor would otherwise reject the
                // very way the section is meant to be read from.)
                const withinReach = polygon
                    ? (near.distance >= settings.flankMinOffset && insidePolygon)
                    : (near.distance >= settings.flankMinOffset && near.distance <= settings.flankMaxOffset);
                if (withinReach) {
                    beside[sideOfStation(station, near.x, near.y) > 0 ? 'left' : 'right'].push(near.distance);
                }
            });
            measured.push({
                way,
                highway,
                name: way?.properties?.name || undefined,
                tags: tagsOf(way),
                coverage: onRun / stations.length,
                driveable: DRIVEABLE_HIGHWAYS.has(highway),
                alignment,
                beside
            });
        });

        // Only the driveable ways describe a street; the footways that happen to lie along it are
        // pavements. With no driveable one at all the run IS a footway or a pedestrian street.
        const covering = measured.filter(entry => entry.coverage >= settings.carrierCoverage);
        const driveable = covering.filter(entry => entry.driveable);
        const carriers = (driveable.length ? driveable : covering).slice().sort((a, b) => b.coverage - a.coverage);

        const flanks = [];
        measured.forEach(entry => {
            if (carriers.includes(entry)) return;
            const kind = CYCLE_HIGHWAYS.has(entry.highway)
                ? 'cycleway'
                : (FOOT_HIGHWAYS.has(entry.highway) ? 'sidewalk' : null);
            if (!kind) return;
            // A neighbour has to stay on ONE side of the run to be a flank; a way that crosses it
            // registers on both, and a side street is not a pavement.
            const left = entry.beside.left.length;
            const right = entry.beside.right.length;
            const total = left + right;
            if (!total) return;
            const side = left >= right ? 'left' : 'right';
            const offsets = entry.beside[side];
            if (offsets.length / stations.length < settings.flankCoverage) return;
            if (offsets.length / total < settings.flankSideAgreement) return;
            flanks.push({
                way: entry.way,
                kind,
                side,                                   // side of the RUN, not of the OSM way
                offset: roundWidth(median(offsets)),    // m from the run's centreline to this way's
                coverage: offsets.length / stations.length,
                taggedWidth: parseNumber(entry.tags.width)
            });
        });

        return {
            carriers,
            // A way the run traverses backwards has its left on our right. Everything OSM says per-side
            // has to be mirrored for such a run, so this one sign is worth measuring properly.
            reversed: carriers.length > 0 && carriers[0].alignment < 0,
            flanks,
            stations: stations.length
        };
    }

    // ---------------------------------------------------------------------------
    // 2. One tag set for the segment, then resolved into what is physically there
    // ---------------------------------------------------------------------------

    function parseNumber(value) {
        if (value === undefined || value === null) return NaN;
        const number = parseFloat(String(value).replace(',', '.'));
        return Number.isFinite(number) ? number : NaN;
    }

    // The tags of the segment: for every key any carrier sets, the value covering the most of the run.
    // A run that spans two ways with different lane counts takes the one it is mostly made of, rather
    // than whichever way happens to come first.
    function mergeTagsAlongRun(carriers) {
        const weights = new Map();
        (carriers || []).forEach(carrier => {
            const weight = Number(carrier.coverage) || 0;
            // `highway` and `name` are columns of their own on an osm_road row as well as tags on the
            // way, so both spellings are merged and the tag wins where a way carries both.
            const source = { highway: carrier.highway, name: carrier.name, ...carrier.tags };
            Object.keys(source).forEach(key => {
                const value = source[key];
                if (value === undefined || value === null || value === '') return;
                if (!weights.has(key)) weights.set(key, new Map());
                const byValue = weights.get(key);
                byValue.set(String(value), (byValue.get(String(value)) || 0) + weight);
            });
        });
        const tags = {};
        weights.forEach((byValue, key) => {
            let best = null;
            byValue.forEach((weight, value) => {
                if (!best || weight > best.weight) best = { value, weight };
            });
            if (best) tags[key] = best.value;
        });
        return tags;
    }

    // Mirror every per-side tag, for a run that traverses its way backwards. Left becomes right, and
    // the direction of travel flips with it, so the section reads in the run's own frame from here on.
    function reverseOsmTagSides(tags) {
        const out = {};
        Object.keys(tags || {}).forEach(key => {
            const flippedKey = key
                .replace(/(^|:)left(:|$)/, '$1__SIDE__$2')
                .replace(/(^|:)right(:|$)/, '$1left$2')
                .replace(/(^|:)__SIDE__(:|$)/, '$1right$2');
            let value = tags[key];
            if (value === 'left') value = 'right';
            else if (value === 'right') value = 'left';
            out[flippedKey] = value;
        });
        if (out.oneway === 'yes') out.oneway = '-1';
        else if (out.oneway === '-1') out.oneway = 'yes';
        const forward = out['lanes:forward'];
        const backward = out['lanes:backward'];
        if (forward !== undefined || backward !== undefined) {
            if (backward !== undefined) out['lanes:forward'] = backward; else delete out['lanes:forward'];
            if (forward !== undefined) out['lanes:backward'] = forward; else delete out['lanes:backward'];
        }
        return out;
    }

    // Read a per-side tag the way OSM writes it: `key:left`, `key:both`, or a bare `key` that may itself
    // name a side.
    function sideValue(tags, key, side) {
        if (!tags) return undefined;
        const specific = tags[`${key}:${side}`];
        if (specific !== undefined) return specific;
        const both = tags[`${key}:both`];
        if (both !== undefined) return both;
        const bare = tags[key];
        if (bare === undefined) return undefined;
        if (bare === 'left' || bare === 'right') return bare === side ? 'yes' : 'no';
        if (bare === 'both') return 'yes';
        return bare;
    }

    function sideWidth(tags, key, side) {
        const candidates = [`${key}:${side}:width`, `${key}:both:width`, `${key}:width`];
        for (const candidate of candidates) {
            const width = parseNumber(tags && tags[candidate]);
            if (Number.isFinite(width) && width > 0) return width;
        }
        return NaN;
    }

    function parkingOrientation(tags, side) {
        const explicit = [`parking:${side}:orientation`, 'parking:both:orientation', 'parking:orientation']
            .map(key => tags && tags[key])
            .find(value => value !== undefined);
        if (explicit !== undefined) return String(explicit);
        const legacy = sideValue(tags, 'parking:lane', side);
        return legacy === undefined ? undefined : String(legacy);
    }

    const ORIENTATION_WIDTH = { perpendicular: 5, diagonal: 4.5, inclined: 4.5 };
    function parkingDepth(orientation, fallback) {
        return ORIENTATION_WIDTH[orientation] || fallback;
    }

    // Rewrite the merged tags into what the street physically has, so the OSM bridge can read them
    // literally. This is where Zagreb's conventions are decoded, and each decision leaves a note so the
    // result can be explained rather than just trusted.
    //
    //   * `sidewalk:<side>=separate` — the pavement is a way of its own. If we matched one beside the
    //     run its distance from the centreline MEASURES the pavement: everything outside that way's
    //     centreline is pavement, so it is 2 x (the room on that side - the offset). With no matched
    //     way it is still there (a Zagreb street tagged `separate` has a pavement), just at a default.
    //   * `cycleway:<side>=separate` — only believed when a cycleway way was actually matched beside
    //     the run. A separate cycle path can as easily be on the far side of the block.
    //   * `cycleway:<side>=shared_lane` — paint, not a strip. Dropped.
    //   * `parking:<side>=on_kerb|half_on_kerb` — the bay stands on the pavement. The bay is still a
    //     strip of its own (you cannot walk there), so the pavement pays for the part that overlaps it
    //     rather than the carriageway.
    //
    // Everything measured off a matched way is measured against THE ROOM ON THAT SIDE, not half the
    // total. `options.leftHalf`/`rightHalf` are what the caller measured from the centreline to each
    // kerb, and they are routinely unequal — a cadastral road parcel is often one side of the street
    // rather than the whole of it, which is the very reason the painter measures the two sides apart
    // and shifts the drawn line into the middle. Half the total instead gave the two pavements of a
    // 6 m / 14 m corridor the same width, both sized from a line down neither side's middle. They
    // default to half the total, so a caller with only one number (the adoption path) is unaffected.
    function resolveSegmentTags(mergedTags, flanks, availableWidth, options = {}) {
        const settings = { ...OSM_PROFILE_DEFAULTS, ...options };
        const tags = { ...(mergedTags || {}) };
        const notes = [];
        const half = Number(availableWidth) > 0 ? Number(availableWidth) / 2 : NaN;
        const halfOn = (side) => {
            const measured = Number(side === 'left' ? settings.leftHalf : settings.rightHalf);
            return (Number.isFinite(measured) && measured > 0) ? measured : half;
        };

        // A tagged width describes the way; the corridor is what the kerbs measure. Keeping it would
        // let the tag overrule the ground.
        delete tags.width;
        delete tags['est_width'];

        const flankOn = (kind, side) => (flanks || [])
            .filter(flank => flank.kind === kind && flank.side === side)
            .sort((a, b) => b.coverage - a.coverage)[0] || null;

        ['left', 'right'].forEach(side => {
            // --- pavement -------------------------------------------------------------------
            const sidewalk = sideValue(tags, 'sidewalk', side);
            const matched = flankOn('sidewalk', side);
            const explicitlyAbsent = sidewalk !== undefined && ABSENT_VALUES.has(String(sidewalk));
            if (!explicitlyAbsent && (String(sidewalk) === 'separate' || matched || sidewalk === undefined)) {
                let width = sideWidth(tags, 'sidewalk', side);
                if (!Number.isFinite(width) && matched) {
                    const room = halfOn(side);
                    if (Number.isFinite(matched.taggedWidth) && matched.taggedWidth > 0) {
                        width = matched.taggedWidth;
                    } else if (Number.isFinite(room) && room > matched.offset) {
                        width = 2 * (room - matched.offset);
                    }
                    if (Number.isFinite(width)) {
                        notes.push(`sidewalk ${side}: measured ${roundWidth(width)} m from a footway ${matched.offset} m off the centreline, with ${roundWidth(room)} m of room on that side`);
                    }
                }
                if (Number.isFinite(width) && width > 0) {
                    width = Math.min(settings.maxSidewalkWidth, Math.max(settings.minSidewalkWidth, width));
                } else if (matched || String(sidewalk) === 'separate') {
                    width = settings.defaultSidewalkWidth;
                    notes.push(`sidewalk ${side}: tagged separate with nothing matched, assumed ${width} m`);
                } else {
                    width = NaN;   // nothing said and nothing found — let the fit decide
                }
                if (Number.isFinite(width)) {
                    tags[`sidewalk:${side}`] = 'yes';
                    tags[`sidewalk:${side}:width`] = String(roundWidth(width));
                }
            } else if (explicitlyAbsent) {
                tags[`sidewalk:${side}`] = 'no';
            }

            // --- cycle lane -----------------------------------------------------------------
            const cycleway = sideValue(tags, 'cycleway', side);
            const cycleFlank = flankOn('cycleway', side);
            if (cycleway !== undefined && NO_WIDTH_CYCLEWAY.has(String(cycleway))) {
                tags[`cycleway:${side}`] = 'no';
                if (String(cycleway) === 'shared_lane') notes.push(`cycleway ${side}: shared_lane is paint, not a strip`);
            } else if (String(cycleway) === 'separate') {
                if (cycleFlank) {
                    tags[`cycleway:${side}`] = 'lane';
                    notes.push(`cycleway ${side}: separate, matched a cycleway ${cycleFlank.offset} m off the centreline`);
                } else {
                    tags[`cycleway:${side}`] = 'no';
                    notes.push(`cycleway ${side}: separate with nothing matched, left out`);
                }
            } else if (cycleway === undefined && cycleFlank) {
                tags[`cycleway:${side}`] = 'lane';
                notes.push(`cycleway ${side}: untagged, matched a cycleway ${cycleFlank.offset} m off the centreline`);
            }

            // --- kerbside parking -----------------------------------------------------------
            const parking = sideValue(tags, 'parking', side);
            const value = parking === undefined ? undefined : String(parking);
            if (value !== undefined && PARKING_PRESENT.has(value)) {
                const orientation = parkingOrientation(tags, side);
                const depth = Number.isFinite(sideWidth(tags, 'parking', side))
                    ? sideWidth(tags, 'parking', side)
                    : parkingDepth(orientation, settings.parkingWidth);
                // Nobody said which way the cars point, but the depth already did: 5 m of lane can
                // only be nose-in, 2.5 m can only be along the kerb. Stated so the bridge draws the
                // right bays rather than marking a 5 m lane out at a parallel bay's 6 m spacing.
                if (orientation === undefined && typeof global.corridorParkingTypeForWidth === 'function') {
                    const implied = global.corridorParkingTypeForWidth(depth);
                    if (implied === 'parking_perpendicular') tags[`parking:${side}:orientation`] = 'perpendicular';
                    else if (implied === 'parking_angled') tags[`parking:${side}:orientation`] = 'diagonal';
                }
                tags[`parking:${side}`] = 'lane';
                tags[`parking:${side}:width`] = String(roundWidth(depth));
                const kerbShare = PARKING_KERB_SHARE[value] || 0;
                if (kerbShare > 0) {
                    // The bay overlaps the pavement, so the pavement gives up that much of its width
                    // instead of the carriageway. Total unchanged; the strips land where the paint is.
                    const debit = depth * kerbShare;
                    const current = parseNumber(tags[`sidewalk:${side}:width`]);
                    if (Number.isFinite(current)) {
                        const reduced = Math.max(settings.minSidewalkWidth, current - debit);
                        tags[`sidewalk:${side}:width`] = String(roundWidth(reduced));
                        notes.push(`parking ${side}: ${value}, ${roundWidth(current - reduced)} m taken from the pavement`);
                    }
                }
            } else if (value !== undefined && (ABSENT_VALUES.has(value) || value === 'separate')) {
                tags[`parking:${side}`] = 'no';
            }
        });

        // A rail lane sharing the carriageway is not a strip of its own; it is a tram running in the
        // traffic. Recorded so the reason a track is missing is visible, not silently dropped.
        if (Object.keys(tags).some(key => key.startsWith('embedded_rails'))) {
            notes.push('tram rails embedded in the carriageway; drawn as traffic lanes');
        }
        return { tags, notes };
    }

    // ---------------------------------------------------------------------------
    // 3. Fit the section to the width the corridor actually has
    // ---------------------------------------------------------------------------

    function stripsWidth(strips) {
        return strips.reduce((total, strip) => total + (Number(strip.width) || 0), 0);
    }

    // Give `budget` metres to the strips `pick` selects, none of them past `cap`. Returns what is left.
    function grow(strips, pick, cap, budget) {
        const targets = strips.filter(pick);
        let left = budget;
        while (left > 1e-6 && targets.some(strip => strip.width < cap - 1e-6)) {
            const room = targets.filter(strip => strip.width < cap - 1e-6);
            // Bounded by the SMALLEST headroom in the group, so no strip is lifted past the cap.
            const share = Math.min(left / room.length, Math.min(...room.map(strip => cap - strip.width)));
            if (!(share > 1e-9)) break;
            room.forEach(strip => { strip.width += share; });
            left -= share * room.length;
        }
        return left;
    }

    // Take `budget` metres back off the strips `pick` selects, none of them below `floor`.
    function shrink(strips, pick, floor, budget) {
        const targets = strips.filter(pick);
        let left = budget;
        while (left > 1e-6 && targets.some(strip => strip.width > floor + 1e-6)) {
            const room = targets.filter(strip => strip.width > floor + 1e-6);
            const share = Math.min(left / room.length, Math.min(...room.map(strip => strip.width)) - floor);
            if (!(share > 1e-9)) break;
            room.forEach(strip => { strip.width -= share; });
            left -= share * room.length;
        }
        return left;
    }

    const isDriving = strip => strip.type === 'driving' || strip.type === 'bus';
    const isParking = strip => strip.type.indexOf('parking') === 0;
    const isSidewalk = strip => strip.type === 'sidewalk';

    // The kinds of kerbside bay, deepest first. A corridor too tight for the bays it has takes the
    // next kind down rather than losing its parking outright.
    const PARKING_LADDER = [['parking_perpendicular', 5], ['parking_angled', 4.5], ['parking', 2.5]];
    // The narrowest footway worth adding to a street that has none, per side. Under half a metre of
    // spare corridor there is nothing to add and the carriageway may as well keep it.
    const MIN_CREATED_SIDEWALK = 0.25;
    // The narrowest green verge worth adding, per side. Verges are where a corridor's leftover goes
    // once the pavements are as wide as pavements get.
    const MIN_CREATED_VERGE = 0.5;

    // Insert a kerbside parking lane on each side, just inside the pavement. Only ever in pairs: a bay
    // on one side of a two-way street is a lane the other direction cannot use.
    function insertParkingPair(strips, width) {
        const first = strips.findIndex(isDriving);
        const last = strips.length - 1 - strips.slice().reverse().findIndex(isDriving);
        if (first < 0) return strips;
        const out = strips.slice();
        out.splice(last + 1, 0, { type: 'parking', width });
        out.splice(first, 0, { type: 'parking', width });
        return out;
    }

    // Drop the outermost pair of traffic lanes, keeping the two directions balanced.
    function dropDrivingPair(strips) {
        const indexes = strips.map((strip, index) => (isDriving(strip) ? index : -1)).filter(index => index >= 0);
        if (indexes.length < 3) return null;
        const drop = new Set([indexes[0], indexes[indexes.length - 1]]);
        return strips.filter((strip, index) => !drop.has(index));
    }

    // Make the section sum to EXACTLY `available`, in a fixed order of preference.
    //
    // Growing: the lanes take what they need up to a real lane's width, then a pair of parking bays
    // appears if there is room for one and the street did not say there is none, and the pavements
    // absorb whatever is still left — a pavement 40 cm wider is invisible, a traffic lane 40 cm wider
    // is a road that invites 70 km/h.
    //
    // Shrinking: the pavements give first (down to a metre), then the parking, the verge and the cycle
    // lane are dropped outright, then the lanes narrow, then lanes are removed in pairs. A street that
    // is still too narrow at the end of that ladder is all carriageway.
    function fitProfileToWidth(profile, available, options = {}) {
        const settings = { ...OSM_PROFILE_DEFAULTS, ...options };
        const total = Number(available);
        if (!Number.isFinite(total) || total <= 0) return null;
        let strips = ((profile && profile.strips) || []).map(strip => ({ ...strip }));
        if (!strips.length) return { strips: [{ type: 'driving', width: roundWidth(total), direction: 'forward' }] };

        // Each rung recomputes what is still owed from the strips themselves, so a rung that frees more
        // than it was asked for (dropping a lane pair) simply ends the descent instead of overshooting.
        const owed = () => stripsWidth(strips) - total;
        if (owed() > 1e-6) {
            shrink(strips, isSidewalk, settings.minSidewalkWidth, owed());
            // A bay's depth is a real-world constant, so parking cannot simply be narrowed — but a
            // SHALLOWER KIND of bay is still parking, and a street OSM says has parking keeps it
            // rather than losing it and being handed a generic pair back by the growth ladder.
            PARKING_LADDER.forEach(([type, width]) => {
                if (owed() <= 1e-6) return;
                strips.filter(isParking).forEach(strip => {
                    if (strip.width > width) { strip.type = type; strip.width = width; }
                });
            });
            if (owed() > 1e-6 && strips.some(isParking)) strips = strips.filter(strip => !isParking(strip));
            if (owed() > 1e-6) strips = strips.filter(strip => strip.type !== 'verge');
            if (owed() > 1e-6) strips = strips.filter(strip => strip.type !== 'cycleway');
            if (owed() > 1e-6) shrink(strips, isDriving, settings.minLaneWidth, owed());
            while (owed() > 1e-6) {
                const fewer = dropDrivingPair(strips);
                if (!fewer) break;
                strips = fewer;
            }
            // Still over: the pavements go altogether, provided something is left to drive on.
            if (owed() > 1e-6 && strips.some(isDriving)) strips = strips.filter(strip => !isSidewalk(strip));
            // Last resort — the corridor is narrower than one lane's minimum. It is all carriageway.
            if (owed() > 1e-6) return { strips: [{ type: 'driving', width: roundWidth(total), direction: 'forward' }] };
        }

        let delta = total - stripsWidth(strips);
        if (delta > 1e-6) {
            delta = grow(strips, isDriving, settings.maxLaneWidth, delta);
            if (delta >= 2 * settings.parkingWidth - 1e-6 && settings.allowParking !== false && !strips.some(isParking)) {
                strips = insertParkingPair(strips, settings.parkingWidth);
                delta -= 2 * settings.parkingWidth;
            }
            // Nothing to put the leftover in. A corridor with metres to spare beside its carriageway
            // has something in them, whatever the tags say — `sidewalk=no` in OSM is as often about
            // there being no mapped pedestrian route as about there being no pavement. Without this
            // the carriageway swallowed the lot: over Donji Grad it produced traffic lanes up to 13 m
            // wide, which is the very thing an adopted street must never come out as.
            if (delta > 2 * MIN_CREATED_SIDEWALK && !strips.some(isSidewalk)) {
                strips.unshift({ type: 'sidewalk', width: MIN_CREATED_SIDEWALK });
                strips.push({ type: 'sidewalk', width: MIN_CREATED_SIDEWALK });
                delta -= 2 * MIN_CREATED_SIDEWALK;
            }
            if (delta > 1e-6 && strips.some(isSidewalk)) {
                delta = grow(strips, isSidewalk, settings.maxSidewalkWidth, delta);
            }
            // Past a pavement's sensible maximum the leftover is not pavement at all — it is the open
            // ground a wide corridor has beside its carriageway, and calling it footway paints a 20 m
            // slab of paving over what is actually grass. A verge takes it instead, which is both
            // truer and instantly legible as "this street does not use all its room".
            if (delta > 2 * MIN_CREATED_VERGE && !strips.some(strip => strip.type === 'verge')) {
                strips.splice(1, 0, { type: 'verge', width: MIN_CREATED_VERGE, landscape: 'grass' });
                strips.splice(strips.length - 1, 0, { type: 'verge', width: MIN_CREATED_VERGE, landscape: 'grass' });
                delta -= 2 * MIN_CREATED_VERGE;
            }
            // Whatever survives that has nowhere better to go than the verges, the pavements, or on a
            // street with neither, the carriageway. Uncapped, because the section MUST total the corridor.
            if (delta > 1e-6) {
                const verges = strips.filter(strip => strip.type === 'verge');
                const absorbers = verges.length
                    ? verges
                    : (strips.filter(isSidewalk).length ? strips.filter(isSidewalk) : strips.filter(isDriving));
                if (absorbers.length) {
                    const share = delta / absorbers.length;
                    absorbers.forEach(strip => { strip.width += share; });
                }
            }
        }

        // Round, then give the last thousandth of slack to the widest strip so the section sums exactly.
        strips = strips.filter(strip => Number(strip.width) > 0).map(strip => ({ ...strip, width: roundWidth(strip.width) }));
        if (!strips.length) return { strips: [{ type: 'driving', width: roundWidth(total), direction: 'forward' }] };
        const drift = roundWidth(total - stripsWidth(strips));
        if (Math.abs(drift) > 0) {
            const widest = strips.reduce((a, b) => (a.width >= b.width ? a : b));
            widest.width = roundWidth(widest.width + drift);
        }
        return { strips };
    }

    // ---------------------------------------------------------------------------
    // Right-hand traffic
    // ---------------------------------------------------------------------------

    // The OSM bridge lists the forward lanes first, i.e. on the LEFT of the way. In right-hand traffic
    // they are on the right, so the sequence of directions is reversed — a oneway (all one direction)
    // is unaffected, which is exactly right. A cycle lane then takes the direction of the traffic it
    // runs beside, which is what makes an adopted street's arrows point the way its traffic goes.
    function orientForRightHandTraffic(profile) {
        const strips = ((profile && profile.strips) || []).map(strip => ({ ...strip }));
        const driving = strips.map((strip, index) => (isDriving(strip) ? index : -1)).filter(index => index >= 0);
        const directions = driving.map(index => strips[index].direction).reverse();
        driving.forEach((index, i) => {
            if (directions[i]) strips[index].direction = directions[i];
        });
        strips.forEach((strip, index) => {
            if (strip.type !== 'cycleway' || !driving.length) return;
            const nearest = driving.reduce((a, b) => (Math.abs(a - index) <= Math.abs(b - index) ? a : b));
            if (strips[nearest].direction) strip.direction = strips[nearest].direction;
        });
        return { strips };
    }

    // ---------------------------------------------------------------------------
    // The whole translation
    // ---------------------------------------------------------------------------

    // Inputs: one segment's centreline (planar), the OSM ways around it (planar, with their properties),
    // and the width the corridor was measured at. Output: the cross-section that street already has,
    // summing to exactly that width — or null when there is no OSM way covering the run at all, which
    // is the caller's cue to fall back to the purely geometric fit.
    function osmProfileForSegment(input = {}) {
        const runXY = Array.isArray(input.runXY) ? input.runXY : null;
        const availableWidth = Number(input.availableWidth);
        const options = input.options || {};
        const toProfile = input.profileFromTags
            || (typeof global.corridorProfileFromOsmTags === 'function' ? global.corridorProfileFromOsmTags : null);
        if (!runXY || runXY.length < 2 || !Number.isFinite(availableWidth) || availableWidth <= 0 || !toProfile) return null;

        const match = matchWaysToRun(runXY, input.ways || [], options);
        if (!match.carriers.length) return null;

        // The flanks are already measured in the run's frame; the tags are in their way's, so they are
        // the ones mirrored. From here on left means left of the run, for both.
        const merged = mergeTagsAlongRun(match.carriers);
        const framed = match.reversed ? reverseOsmTagSides(merged) : merged;
        const resolved = resolveSegmentTags(framed, match.flanks, availableWidth, options);

        const nominal = toProfile(resolved.tags);
        if (!nominal || !nominal.strips || !nominal.strips.length) return null;

        // How wide to build it.
        //
        // ADOPTING (the default): exactly the corridor. The adopted road's footprint IS that width,
        // the parcel is split along it, and every proposal derived from it depends on the two agreeing.
        //
        // PAINTING an existing street: as wide as the street is, and no wider. The corridor is only a
        // ceiling. A street does not grow to fill its parcel — the ground beside it is a verge, a
        // layby, a tram median or somebody's forecourt — and spending the difference on pavement is
        // how a 9 m carriageway with 26 m of open ground beside it became a 35 m road.
        const nominalWidth = stripsWidth(nominal.strips);
        const target = (options.preferNominal && nominalWidth > 0)
            ? Math.min(availableWidth, nominalWidth)
            : availableWidth;

        // A street that says outright it has no parking must not be given any by the fit.
        const refusesParking = ['left', 'right'].every(side => {
            const value = sideValue(resolved.tags, 'parking', side);
            return value !== undefined && String(value) === 'no';
        });
        const fitted = fitProfileToWidth(nominal, target, { ...options, allowParking: !refusesParking });
        if (!fitted) return null;

        return {
            profile: orientForRightHandTraffic(fitted),
            width: target,
            nominalWidth,
            tags: resolved.tags,
            notes: resolved.notes,
            name: merged.name || null,
            highway: merged.highway || null,
            reversed: match.reversed,
            // The ways this section was read off, most of the run first — what a "this is wrong" link
            // has to point at, since the fault is in the tagging rather than in the reading of it.
            osmIds: match.carriers
                .map(carrier => carrier.way?.properties?.osm_id)
                .filter(id => id !== undefined && id !== null)
                .map(String),
            carriers: match.carriers.length,
            flanks: match.flanks.length,
            source: 'osm-tags'
        };
    }

    const api = {
        OSM_PROFILE_DEFAULTS,
        CARRIER_HIGHWAYS,
        matchWaysToRun,
        lineTouchesRing,
        mergeTagsAlongRun,
        reverseOsmTagSides,
        resolveSegmentTags,
        fitProfileToWidth,
        orientForRightHandTraffic,
        osmProfileForSegment,
        stationsAlong,
        polylineLength
    };

    global.OsmProfile = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
