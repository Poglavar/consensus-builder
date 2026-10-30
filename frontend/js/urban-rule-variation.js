// The permitted-massing ↔ example-build-out split for urban rules: a deterministic PRNG, the
// canonical rule shape, the per-parcel maximum envelope, and one model build-out sampled inside it.
//
// Pure — turf and the app's polygon sanitizers are injected — so the editor preview, the 3D view
// and the tests all derive the same geometry from the same (rule, seed). That determinism is the
// point: the generation used to run on unseeded Math.random(), which meant a reload, a shared link
// and a server-rendered thumbnail each showed a different city, and reopening a design produced
// geometry the saved parameters could not reproduce.
//
// The envelope is the proposal; the build-out is an illustration of it. Stats, € gain and the 2D
// map read the envelope, so re-rolling a variation can never move a proposal's numbers.
// Design: urban-rule-massing.md.

(function (global) {
    'use strict';
    const buildingUse = () => (global && global.BuildingUse) || require('./building-use.js');

    const DEFAULT_FLOOR_HEIGHT_M = 3;
    const DEFAULT_MAX_FLOORS = 5;
    const DEFAULT_MIN_DISTANCE_M = 3;
    const MIN_ENVELOPE_AREA_M2 = 1;    // below this the setback has eaten the whole parcel
    const MIN_FOOTPRINT_AREA_M2 = 25;  // a variation smaller than this is not a building
    const MAX_INSET_FRACTION = 0.18;   // how much of the envelope's short side variation may eat
    const SLIDE_ATTEMPTS = 8;
    const INSET_RETRIES = 5;           // halvings before a variation gives up and fills the envelope
    const BLOCK_FLOOR_HEIGHT_M = 3.5;  // matches the block editor's own storey height
    // A parcel clipping the corner of a block ring yields an unbuildable splinter. Dropped, not
    // given to the neighbour: merging it would need a decision about WHICH neighbour, which is a
    // reparcellization, not a rendering choice.
    const DEFAULT_MIN_PIECE_AREA_M2 = 20;
    // How often a plot builds only as deep as the street line compels, when a rule compels one.
    const SHALLOW_BUILD_CHANCE = 0.35;
    const RULE_KINDS = ['max', 'range', 'exact']; // A / B / C in urban-rule-massing.md
    const DEFAULT_BALCONY_DEPTH_M = 2;
    const MAX_BALCONY_DEPTH_M = 5;
    const ROOF_KINDS = ['flat', 'pitched'];
    // The detached rule's optional limits, each [min, max]. A limit is written only when set, so a
    // rule without it keeps exactly the shape (and the build-out) it always had.
    //   frontSetbackM / rearSetbackM — the yard along the street edge and opposite it; unset, the
    //       side distance (minDistance) applies there too
    //   setbackHeightRatio — sides and rear keep at least this share of the building's height
    //       (Zagreb's h/2 is 0.5)
    //   maxHeightM — to the top of the last floor; it caps maxFloors
    //   minFrontageM — the street edge a plot needs to be built on
    //   maxCoverage / minNaturalGround — shares of the plot (0–1) the ground floor may cover and
    //       must leave unbuilt; without paving in the model both cap the ground floor
    //   maxFloorAreaRatio — floor area over plot area
    //   maxFootprintAreaM2 — the largest ground floor, whatever the plot
    const PARCEL_LIMITS = {
        frontSetbackM: [0, 100],
        rearSetbackM: [0, 100],
        setbackHeightRatio: [0, 3],
        maxHeightM: [0.5, 800],
        minFrontageM: [0, 1000],
        maxCoverage: [0, 1],
        minNaturalGround: [0, 1],
        maxFloorAreaRatio: [0, 50],
        maxFootprintAreaM2: [0, 1000000]
    };
    // The yard limits are distances, so 0 is a real value (build to the street line); the rest
    // limit nothing at 0.
    const ZERO_IS_A_LIMIT = ['frontSetbackM', 'rearSetbackM'];

    // --- deterministic randomness ---------------------------------------------------------

    // FNV-1a over the joined parts. Stable across reloads, browsers and node, which is the whole
    // point — every consumer of a (proposal, parcel, seed) triple must land on the same number.
    function hashSeed(...parts) {
        const text = parts.map(part => (part === undefined || part === null) ? '' : String(part)).join('|');
        let h = 0x811c9dc5;
        for (let i = 0; i < text.length; i++) {
            h ^= text.charCodeAt(i);
            h = Math.imul(h, 0x01000193);
        }
        return h >>> 0;
    }

    function mulberry32(seed) {
        let a = (seed >>> 0) || 1;
        return function rng() {
            a = (a + 0x6D2B79F5) >>> 0;
            let t = a;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    function rngFor(...parts) {
        return mulberry32(hashSeed(...parts));
    }

    // Stable index into a fixed palette, so a parcel keeps its shade whatever order parcels arrive
    // in — an index-based colour reshuffles the whole block when one parcel joins or leaves.
    function hashIndex(key, length) {
        const size = Math.trunc(Number(length));
        if (!Number.isFinite(size) || size < 1) return 0;
        return hashSeed(key) % size;
    }

    // --- the rule -------------------------------------------------------------------------

    // Number(null) is 0 and Number('') is 0, so a missing value would silently become a real
    // setback or a real floor count. Only an actual finite number (or a non-empty numeric string)
    // counts; everything else takes the fallback.
    function num(value, fallback) {
        let n = value;
        if (typeof n === 'string') {
            const trimmed = n.trim();
            if (!trimmed) return fallback;
            n = Number(trimmed);
        }
        return (typeof n === 'number' && Number.isFinite(n)) ? n : fallback;
    }

    function nonNegative(value, fallback) {
        return Math.max(0, num(value, fallback));
    }

    // Balconies and the roof are the same for all three typologies. Balconies may stand out of the
    // envelope by balconyDepthM; a pitched roof (with its attic) sits on top of the top floor. Both
    // are written only when used, so a rule without them keeps exactly the shape it always had.
    function normalizeRuleExtras(params) {
        const source = (params && typeof params === 'object') ? params : {};
        const extras = {};
        const balconyDepthM = Math.min(MAX_BALCONY_DEPTH_M, nonNegative(source.balconyDepthM, 0));
        if (balconyDepthM > 0) extras.balconyDepthM = balconyDepthM;
        if (source.roof === 'pitched') extras.roof = 'pitched';
        // What the buildings are for (building-use.js). A Block rule without one keeps the suggested
        // layout's own ground floor: shops from five storeys.
        const use = buildingUse().normalize(source.use);
        if (use) extras.use = use;
        return extras;
    }

    // A new rule's extras: Row and Detached buildings start as housing, a Block as automatic.
    const defaultRuleExtras = typology => (typology === 'block' ? {} : { use: 'residential' });

    // The optional limits a parcel rule states (PARCEL_LIMITS), clamped to their ranges.
    function normalizeParcelLimits(source) {
        const limits = {};
        for (const [key, [min, max]] of Object.entries(PARCEL_LIMITS)) {
            const value = num(source[key], null);
            if (value === null) continue;
            if (value > 0 || (value === 0 && ZERO_IS_A_LIMIT.includes(key))) limits[key] = Math.min(max, Math.max(min, value));
        }
        // A plot that must keep all of itself unbuilt permits nothing: that is no limit, it is a ban.
        if (limits.minNaturalGround >= 1) delete limits.minNaturalGround;
        return limits;
    }

    // What the proposal asserts. `kind` is the A/B/C axis: 'max' permits up to the envelope,
    // 'range' also compels a minimum, 'exact' compels the envelope itself (so there is nothing to
    // vary and the build-out equals the massing).
    //
    // For a FREE-STANDING building the minimum is scalar — at least this many floors, at least this
    // much ground floor — not a polygon. A house may sit anywhere inside its setback envelope, so
    // there is no region it can be compelled to cover. The "minimum envelope you must contain" from
    // the design note is a block/row concept, where the street line pins one side of it.
    function normalizeParcelRule(params) {
        const source = (params && typeof params === 'object') ? params : {};
        const kind = RULE_KINDS.includes(source.kind) ? source.kind : 'max';
        const floorHeightM = Math.max(0.5, num(source.floorHeightM, DEFAULT_FLOOR_HEIGHT_M));
        const limits = normalizeParcelLimits(source);
        // A height limit is the floors that fit under it, never fewer than one.
        const floorsUnderHeight = limits.maxHeightM ? Math.max(1, Math.floor(limits.maxHeightM / floorHeightM + 1e-9)) : Infinity;
        const maxFloors = Math.min(floorsUnderHeight, Math.max(1, Math.round(num(source.maxFloors, DEFAULT_MAX_FLOORS))));
        const minFloors = Math.round(nonNegative(source.minFloors, 0));
        const minFootprint = nonNegative(source.minFootprintAreaM2, 0);
        return {
            typology: source.typology || 'parcelBased',
            kind,
            minDistance: nonNegative(source.minDistance, DEFAULT_MIN_DISTANCE_M),
            maxFloors,
            minFloors: kind === 'exact' ? maxFloors : Math.min(minFloors, maxFloors),
            // Only a range rule compels a minimum. Under 'max' nobody has to build at all, and
            // under 'exact' the envelope is the minimum, so a stray value must not leak in and
            // start excluding parcels the rule does not actually exclude.
            minFootprintAreaM2: kind === 'range' ? minFootprint : 0,
            floorHeightM,
            minPlotAreaM2: nonNegative(source.minPlotAreaM2, 0),
            ...limits,
            ...normalizeRuleExtras(source)
        };
    }

    // A block's massing is one ring, but the buildings under it belong to individual owners, so it
    // is drawn as one building per parcel in distinct shades — a street, not one extruded ring. A
    // full palette would read as a clown parade at block scale, so the shades are one hue at one
    // saturation, quantised in lightness: clearly distinct next to each other, still one material.
    function shadeForKey(key, options) {
        const opts = options || {};
        const hue = num(opts.hue, 28);
        const saturation = num(opts.saturation, 18);
        const lightMin = num(opts.lightMin, 56);
        const lightMax = num(opts.lightMax, 78);
        const steps = Math.max(2, Math.round(num(opts.steps, 7)));
        const step = hashIndex(key, steps);
        const light = lightMin + (lightMax - lightMin) * (step / (steps - 1));
        return `hsl(${hue}, ${saturation}%, ${light.toFixed(1)}%)`;
    }

    // What a block rule asserts. Heights are metres here, not floors — that is the block editor's
    // own parameter — but a build-out varies in whole storeys, because a building 4.7 storeys tall
    // is not a thing. The envelope keeps the slider's exact height so the massing is unchanged.
    function normalizeBlockRule(params) {
        const source = (params && typeof params === 'object') ? params : {};
        const kind = RULE_KINDS.includes(source.kind) ? source.kind : 'max';
        const floorHeightM = Math.max(0.5, num(source.floorHeightM, BLOCK_FLOOR_HEIGHT_M));
        const maxHeightM = Math.max(floorHeightM, num(source.maxHeightM, 17.5));
        const minHeightM = Math.min(nonNegative(source.minHeightM, 0), maxHeightM);
        const typology = source.typology === 'row' ? 'row' : 'block';
        return {
            typology,
            kind,
            maxHeightM,
            minHeightM: kind === 'exact' ? maxHeightM : (kind === 'range' ? minHeightM : 0),
            // How deep from the street line a building is compelled to be — the obvezni građevni
            // pravac. Blocks only: a block's outer boundary IS its street frontage (the courtyard
            // tells inside from outside), while a row bar has gardens behind it, so a band around
            // its whole perimeter would compel building along the back too. A row's minimum stays
            // its height. Only a range rule compels anything at all.
            minDepthM: (kind === 'range' && typology === 'block') ? nonNegative(source.minDepthM, 0) : 0,
            floorHeightM,
            minPlotAreaM2: nonNegative(source.minPlotAreaM2, 0),
            minPieceAreaM2: nonNegative(source.minPieceAreaM2, DEFAULT_MIN_PIECE_AREA_M2),
            ...normalizeRuleExtras(source)
        };
    }

    // --- geometry -------------------------------------------------------------------------

    // The app injects its own sanitizers (they handle the cadastre's quirks); the built-in keeps
    // the module usable on its own, in tests and anywhere without the browser globals loaded.
    function toLargestPolygon(feature, deps) {
        if (deps && typeof deps.largestPolygon === 'function') {
            const picked = deps.largestPolygon(feature);
            if (picked && picked.geometry) return picked;
        }
        if (!feature || !feature.geometry) return null;
        const geometry = feature.geometry;
        if (geometry.type === 'Polygon') return feature;
        if (geometry.type !== 'MultiPolygon' || !Array.isArray(geometry.coordinates)) return null;
        const turf = deps && deps.turf;
        let best = null;
        let bestArea = -Infinity;
        geometry.coordinates.forEach(coordinates => {
            const candidate = { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates } };
            let area = 0;
            try { area = turf ? turf.area(candidate) : 0; } catch (_) { area = 0; }
            if (area > bestArea) { bestArea = area; best = candidate; }
        });
        return best;
    }

    function areaOf(feature, turf) {
        try { return turf.area(feature); } catch (_) { return 0; }
    }

    // What the rule makes of one parcel: `{ envelope, status }`.
    //
    //   ok                  — buildable; `envelope` is the permitted volume
    //   below-min-plot      — the plot is smaller than the rule's minimum building plot
    //   no-room-after-setback — the setback consumed the whole plot
    //   cannot-meet-minimum — the plot is buildable, but too small to satisfy the rule's own
    //                         minimum. That is a conflict IN THE RULE, not a property of the plot,
    //                         and the planner has to be shown it rather than left with a silently
    //                         empty parcel.
    //
    // Callers get the reason because "no building here" and "your rule contradicts itself here" are
    // different problems with different fixes.
    function evaluateParcel(parcelFeature, rule, deps) {
        const turf = deps && deps.turf;
        if (!parcelFeature || !parcelFeature.geometry || !turf) return { envelope: null, status: 'invalid' };
        const normalized = normalizeParcelRule(rule);

        let feature = parcelFeature;
        if (deps && typeof deps.sanitize === 'function') feature = deps.sanitize(feature) || feature;
        feature = toLargestPolygon(feature, deps) || feature;
        if (!feature || !feature.geometry) return { envelope: null, status: 'invalid' };

        const plotAreaM2 = areaOf(feature, turf);
        if (normalized.minPlotAreaM2 > 0 && plotAreaM2 < normalized.minPlotAreaM2) {
            return { envelope: null, status: 'below-min-plot' };
        }

        const front = isOriented(normalized) ? frontOf(feature, deps) : null;
        if (normalized.minFrontageM > 0 && front && front.lengthM < normalized.minFrontageM) {
            return { envelope: null, status: 'below-min-frontage' };
        }

        // The tallest building the limits allow is not always the largest: a yard that grows with
        // height narrows the ground floor of a taller house, and a floor area ratio shares its
        // area among the floors. So every permitted floor count is tried and the one holding the
        // most floor area is the envelope (the taller one on a tie). Without a height-dependent
        // yard the ground does not change with height, and the tallest is always the largest.
        const lowest = Math.max(1, normalized.minFloors);
        const zones = new Map();
        const zoneFor = floors => {
            const distances = yardDistances(normalized, floors * normalized.floorHeightM);
            const key = distances.join('|');
            if (!zones.has(key)) zones.set(key, setbackZone(feature, distances, front, deps));
            return zones.get(key);
        };
        let best = null;
        let anyGround = false;
        for (let floors = normalized.maxFloors; floors >= lowest; floors--) {
            const zone = zoneFor(floors);
            const zoneAreaM2 = zone ? areaOf(zone, turf) : 0;
            if (zoneAreaM2 >= MIN_ENVELOPE_AREA_M2) {
                anyGround = true;
                const capM2 = footprintCapM2(normalized, plotAreaM2, zoneAreaM2, floors);
                const fits = capM2 >= MIN_ENVELOPE_AREA_M2 && capM2 >= normalized.minFootprintAreaM2;
                if (fits && (!best || capM2 * floors > best.capM2 * best.floors + 1e-6)) best = { floors, zone, zoneAreaM2, capM2 };
            }
            if (!(normalized.setbackHeightRatio > 0) && best) break;
        }
        if (!best) {
            if (!anyGround) return { envelope: null, status: 'no-room-after-setback' };
            return { envelope: null, status: normalized.minFootprintAreaM2 > 0 ? 'cannot-meet-minimum' : 'no-room-under-limits' };
        }

        // A ground floor capped below what the yards leave is drawn as that ground shrunk evenly to
        // the cap, so every view that measures the envelope reads the permitted floor area.
        let ground = best.zone;
        if (best.capM2 < best.zoneAreaM2 - 0.5) {
            ground = shrinkToArea(best.zone, best.capM2, deps);
            if (!ground) return { envelope: null, status: 'no-room-under-limits' };
        }

        return {
            status: 'ok',
            envelope: {
                type: 'Feature',
                properties: {
                    floors: best.floors,
                    height: best.floors * normalized.floorHeightM,
                    massing: true,
                    geometryRole: 'authored-rule-envelope',
                    ruleProvenance: { source: 'authored-proposal', generator: 'parcel-envelope', version: 1, definition: normalized },
                    planningCompliance: 'not-evaluated',
                    ...(front ? { frontage: { edgeIndex: front.index, basis: front.basis } } : {})
                },
                geometry: ground.geometry
            }
        };
    }

    // Whether the rule's yards or frontage depend on which edge faces the street.
    function isOriented(rule) {
        return rule.frontSetbackM !== undefined || rule.rearSetbackM !== undefined
            || rule.setbackHeightRatio > 0 || rule.minFrontageM > 0;
    }

    // [front, side, rear] yard depths for a building `heightM` tall.
    function yardDistances(rule, heightM) {
        const grown = (rule.setbackHeightRatio || 0) * heightM;
        const side = Math.max(rule.minDistance, grown);
        const rear = Math.max(rule.rearSetbackM ?? rule.minDistance, grown);
        const front = rule.frontSetbackM ?? rule.minDistance;
        return [front, side, rear].map(value => Math.round(value * 1000) / 1000);
    }

    // The largest ground floor the rule's caps allow at `floors` floors.
    function footprintCapM2(rule, plotAreaM2, zoneAreaM2, floors) {
        const caps = [zoneAreaM2];
        if (rule.maxCoverage > 0) caps.push(rule.maxCoverage * plotAreaM2);
        if (rule.minNaturalGround > 0) caps.push((1 - rule.minNaturalGround) * plotAreaM2);
        if (rule.maxFootprintAreaM2 > 0) caps.push(rule.maxFootprintAreaM2);
        if (rule.maxFloorAreaRatio > 0) caps.push(rule.maxFloorAreaRatio * plotAreaM2 / floors);
        return Math.min(...caps);
    }

    function sitePlotsModule() {
        return (global && global.__sitePlots)
            || (typeof require === 'function' ? require('./proposals/site-plots.js') : null);
    }

    function assessmentModule() {
        return (global && global.PlanningParcelAssessment)
            || (typeof require === 'function' ? require('./planning/parcel-assessment.js') : null);
    }

    // The plot's street edge: the edge that faces one of `deps.streets` (street centrelines, as the
    // site tool's frontage reads them), else its longest edge. `{ index, lengthM, basis }`.
    function frontOf(feature, deps) {
        const turf = deps.turf;
        const plots = sitePlotsModule();
        const edges = plots.frontageEdges(feature, { turf });
        if (!edges.length) return null;
        const streets = Array.isArray(deps.streets) ? deps.streets : [];
        let best = null;
        if (streets.length) {
            const [w, s, e, n] = turf.bbox(feature);
            const marginM = plots.FRONTAGE_STREET_MAX_DISTANCE_M + 5;
            const dLat = marginM / 110540;
            const dLng = marginM / (111320 * Math.cos(((s + n) / 2) * Math.PI / 180));
            const nearby = streets.filter(street => {
                try {
                    const [sw, ss, se, sn] = turf.bbox(street);
                    return sw <= e + dLng && se >= w - dLng && ss <= n + dLat && sn >= s - dLat;
                } catch (_) { return false; }
            });
            best = nearby.length ? plots.frontageScores(feature, nearby, { turf })[0] : null;
        }
        const index = best ? best.index : plots.defaultFrontageEdge(feature, { turf });
        const edge = edges.find(entry => entry.index === index);
        return edge ? { index, lengthM: edge.lengthM, basis: best ? 'street' : 'longest' } : null;
    }

    // The ground beyond the yards: [front, side, rear] metres measured from the edges in those
    // roles (planning/parcel-assessment.js classifies them from the street edge, the same
    // derivation the Permitted layer uses). Equal yards need no street edge, and keep the rounded
    // inward buffer this rule has always drawn.
    function setbackZone(feature, distances, front, deps) {
        const turf = deps.turf;
        const [frontM, sideM, rearM] = distances;
        const uniform = frontM === sideM && sideM === rearM;
        if (!uniform && front) {
            try {
                const quantity = (key, value) => ({ quantity: key, value, unit: 'm', evidence: 'direct' });
                const bound = assessmentModule().derive({
                    parcel: feature,
                    source: { constraints: [quantity('frontSetback', frontM), quantity('sideSetback', sideM), quantity('rearSetback', rearM)] }
                }, front.index, turf);
                if (!bound.geometry) return null;
                return toLargestPolygon({ type: 'Feature', properties: {}, geometry: bound.geometry }, deps);
            } catch (_) {
                // A plot the derivation cannot classify (a hole, a self-touching ring) keeps the
                // deepest yard on every side: the rule never permits more than it says.
            }
        }
        const depthM = uniform ? sideM : Math.max(frontM, sideM, rearM);
        if (!(depthM > 0)) return feature;
        let buffered = null;
        try {
            buffered = turf.buffer(feature, -depthM / 1000, { units: 'kilometers', steps: 16 });
        } catch (_) {
            return null;
        }
        return buffered && buffered.geometry ? toLargestPolygon(buffered, deps) : null;
    }

    // `feature` shrunk evenly until its area is at most `targetM2` (within 2 % below it): Newton's
    // step on the inset, since an inset of d removes about perimeter × d. null when no inset
    // leaves a polygon that small and still standing.
    function shrinkToArea(feature, targetM2, deps) {
        const turf = deps.turf;
        if (!(targetM2 > 0)) return null;
        let area = areaOf(feature, turf);
        if (area <= targetM2) return feature;
        let insetM = 0;
        let current = feature;
        let best = null;
        let tooFarM = Infinity;
        for (let step = 0; step < 16; step++) {
            let perimeterM = 0;
            try { perimeterM = turf.length(turf.polygonToLine(current), { units: 'kilometers' }) * 1000; } catch (_) { perimeterM = 0; }
            let next = insetM + (area - targetM2) / Math.max(perimeterM, 1);
            if (next >= tooFarM) next = (insetM + tooFarM) / 2;
            let candidate = null;
            try {
                const buffered = turf.buffer(feature, -next / 1000, { units: 'kilometers', steps: 8 });
                candidate = buffered && buffered.geometry ? toLargestPolygon(buffered, deps) : null;
            } catch (_) { candidate = null; }
            const candidateArea = candidate ? areaOf(candidate, turf) : 0;
            if (!candidate || candidateArea < MIN_ENVELOPE_AREA_M2) {
                tooFarM = next;
                continue;
            }
            insetM = next;
            current = candidate;
            area = candidateArea;
            if (area <= targetM2) {
                best = current;
                if (area >= targetM2 * 0.98) break;
            }
        }
        return best;
    }

    // The permitted volume for one parcel: the parcel set back by the rule's minimum distance,
    // extruded to the maximum floors. This — never the sampled build-out — is what the stats, the
    // € gain, the 2D map and the thumbnail read. null means the rule excludes this parcel; use
    // evaluateParcel when you need to say why.
    function parcelEnvelope(parcelFeature, rule, deps) {
        return evaluateParcel(parcelFeature, rule, deps).envelope;
    }

    function translateFeature(feature, dx, dy) {
        const shift = coords => coords.map(item => (Array.isArray(item[0]) ? shift(item) : [item[0] + dx, item[1] + dy]));
        return {
            type: 'Feature',
            properties: feature.properties || {},
            geometry: { type: feature.geometry.type, coordinates: shift(feature.geometry.coordinates) }
        };
    }

    // Shrink the envelope by a random extra inset, then slide it while it still fits. Setbacks are
    // minimums, not the building form, so a build-out that always filled the envelope would be the
    // massing with extra steps. Concave envelopes can refuse every slide; the unslid shrunken
    // footprint always fits, so it is the floor.
    //
    // `floorAreaM2` is the rule's compelled minimum ground floor (type B). The inset is a metric
    // shrink whose effect on area depends on the shape, so rather than solve for it the inset is
    // halved until the footprint complies — bounded, and it always terminates on the envelope,
    // which evaluateParcel has already proven big enough.
    function varyFootprint(envelopeFeature, rng, deps, floorAreaM2 = 0) {
        const turf = deps && deps.turf;
        try {
            const [minX, minY, maxX, maxY] = turf.bbox(envelopeFeature);
            // A degree of longitude is not a degree of latitude — at Zagreb's latitude it is ~70% of
            // one. Comparing the two raw would call a wide, shallow parcel "square" and let the
            // inset eat far more of it than intended.
            const midLat = (minY + maxY) / 2;
            const widthM = (maxX - minX) * 111320 * Math.cos(midLat * Math.PI / 180);
            const heightM = (maxY - minY) * 110540;
            let insetMeters = rng() * Math.min(widthM, heightM) * MAX_INSET_FRACTION;
            const floor = Math.max(MIN_FOOTPRINT_AREA_M2, floorAreaM2);

            let footprint = null;
            for (let attempt = 0; attempt < INSET_RETRIES && insetMeters >= 0.3; attempt++) {
                const shrunk = turf.buffer(envelopeFeature, -insetMeters / 1000, { units: 'kilometers', steps: 8 });
                const candidate = shrunk ? toLargestPolygon(shrunk, deps) : null;
                if (candidate && candidate.geometry && areaOf(candidate, turf) >= floor) {
                    footprint = candidate;
                    break;
                }
                insetMeters /= 2;
            }
            if (!footprint) return envelopeFeature;

            const [fMinX, fMinY, fMaxX, fMaxY] = turf.bbox(footprint);
            for (let attempt = 0; attempt < SLIDE_ATTEMPTS; attempt++) {
                const scale = 1 - attempt / SLIDE_ATTEMPTS;
                const dx = ((minX - fMinX) + rng() * ((maxX - fMaxX) - (minX - fMinX))) * scale;
                const dy = ((minY - fMinY) + rng() * ((maxY - fMaxY) - (minY - fMinY))) * scale;
                const shifted = translateFeature(footprint, dx, dy);
                try { if (turf.booleanContains(envelopeFeature, shifted)) return shifted; } catch (_) { }
            }
            return footprint;
        } catch (_) {
            return envelopeFeature; // variation is presentation; never lose the massing over it
        }
    }

    // One illustrative build-out satisfying this model's authored rule checks.
    //
    // Draw order is part of the contract: the floor count is drawn FIRST so it depends on the seed
    // alone and not on how many slide attempts the parcel's shape happened to need. Appending new
    // draws is safe; inserting one silently restyles every design ever shared.
    function realizeFromEnvelope(envelopeFeature, rule, seed, deps) {
        const turf = deps && deps.turf;
        if (!envelopeFeature || !envelopeFeature.geometry || !turf) return null;
        const normalized = normalizeParcelRule(rule);

        // C — build exactly the envelope. There is no variation to sample, so the build-out is the
        // massing; returning the same feature lets callers detect that and draw it only once.
        if (normalized.kind === 'exact') return envelopeFeature;

        const rng = mulberry32(num(seed, 0) >>> 0);
        const lowest = Math.max(1, normalized.minFloors);
        // The envelope's own floors are the ceiling: a yard that grows with height or a floor area
        // ratio can hold a plot's envelope below the rule's maximum floors.
        const envelopeFloors = num(envelopeFeature.properties && envelopeFeature.properties.floors, normalized.maxFloors);
        const ceiling = Math.max(lowest, Math.min(normalized.maxFloors, envelopeFloors));
        const floors = lowest + Math.floor(rng() * (Math.max(0, ceiling - lowest) + 1));
        const footprint = varyFootprint(envelopeFeature, rng, deps, normalized.minFootprintAreaM2) || envelopeFeature;

        return {
            type: 'Feature',
            properties: {
                ...(envelopeFeature.properties || {}),
                floors,
                height: floors * normalized.floorHeightM,
                massing: false,
                geometryRole: 'illustrative-buildout',
                planningCompliance: 'not-evaluated'
            },
            geometry: footprint.geometry
        };
    }

    // Drop every hole, keeping each part's outer ring. For a perimeter block that turns the ring
    // back into the solid it was cut from, which is what makes "inward from the street" computable.
    function fillHoles(feature, turf) {
        const geometry = feature && feature.geometry;
        if (!geometry) return null;
        try {
            if (geometry.type === 'Polygon') return turf.polygon([geometry.coordinates[0]]);
            if (geometry.type === 'MultiPolygon') return turf.multiPolygon(geometry.coordinates.map(part => [part[0]]));
        } catch (_) { }
        return null;
    }

    // The obvezni građevni pravac: a band `minDepthM` deep, measured inward from the massing's
    // outer boundary. Any legal building must CONTAIN this, so it must reach the street — the
    // mandatory building line falls out of the two-envelope model without a separate concept.
    //
    // Clipped back to the massing at the end, so gaps, chamfers and courtyards are voids in the
    // minimum exactly as they are in the maximum: containment holds by construction, whatever
    // shape the ring has, including a hand-drawn or imported one.
    //
    // When the massing is nowhere thicker than minDepthM the erosion vanishes and the minimum IS
    // the maximum — "build all of it", which is the correct reading, not a failure.
    // A polygon clip that cannot be done, typed and counted (parcel-arrangement.js ClipFailure).
    function variationArrangement() {
        return (global && global.__parcelArrangement)
            || (typeof require === 'function' ? require('./proposals/parcel-arrangement.js') : null);
    }

    function variationClipFailure(operation, error, site, operands, parcelId) {
        const api = variationArrangement();
        return api ? api.clipFailure(operation, error, { site, parcelId }, operands) : error;
    }

    // The shared parcel clip (parcel-arrangement.js clipWith) with the caller's turf: the same grid
    // as every other stage; a clip it cannot do throws a ClipFailure naming `site` and the parcel.
    function variationClip(turf, operation, a, b, site, parcelId) {
        return variationArrangement().clipWith(turf, operation, a, b, { site, parcelId });
    }

    // What counts as ground (geometry-tolerances.js), the rule every stage uses.
    function variationGround() {
        return (global && global.GeometryTolerances)
            || (typeof require === 'function' ? require('./geometry-tolerances.js') : null);
    }

    function buildToMinimum(massingFeature, minDepthM, deps) {
        const turf = deps && deps.turf;
        if (!massingFeature || !massingFeature.geometry || !turf || !(minDepthM > 0)) return null;
        const filled = fillHoles(massingFeature, turf);
        if (!filled) return null;

        let core = null;
        try { core = turf.buffer(filled, -minDepthM / 1000, { units: 'kilometers', steps: 16 }); } catch (_) { core = null; }

        let band = filled;
        if (core && core.geometry) {
            // The whole massing as the "minimum" (or no minimum at all) would be a rule the
            // proposal never stated: a clip that fails here refuses the envelope.
            const cut = variationClip(turf, 'difference', filled, core, 'urban-rule-variation.buildToMinimum');
            // The core is an inward buffer of `filled`, so the band cannot be empty: a null here
            // is the clipper losing it, not a band of nothing.
            if (!cut) throw variationClipFailure('difference', new Error('difference came back empty'), 'urban-rule-variation.buildToMinimum', [filled, core]);
            band = cut;
        }

        const clipped = variationClip(turf, 'intersect', band, massingFeature, 'urban-rule-variation.buildToMinimum');
        return (clipped && clipped.geometry) ? clipped : null;
    }

    // Cut a block's massing into one building per constituent parcel.
    //
    // `parcels` is [{ feature, parcelId }]. Returns { pieces, excluded }, where each piece carries
    // its parcelId, its shade and its own variation seed — so a block becomes a street of separately
    // owned buildings rather than one extruded ring, and gain becomes attributable per parcel
    // without any intersection guesswork downstream.
    //
    // The whole generator upstream is untouched: gaps, wings, chamfer, manual outlines and imported
    // shapes all arrive here as one finished massing and are cut the same way.
    function splitMassingByParcels(massingFeature, parcels, rule, designSeed, deps) {
        const turf = deps && deps.turf;
        const pieces = [];
        const excluded = [];
        if (!massingFeature || !massingFeature.geometry || !turf || !Array.isArray(parcels)) {
            return { pieces, excluded };
        }
        const normalized = normalizeBlockRule(rule);
        const height = normalized.maxHeightM;
        // Computed once for the whole block, then clipped per parcel — one erosion, not one per plot.
        const compelled = buildToMinimum(massingFeature, normalized.minDepthM, deps);

        parcels.forEach((entry, index) => {
            const parcelFeature = entry && entry.feature;
            if (!parcelFeature || !parcelFeature.geometry) return;
            const parcelId = (entry.parcelId === undefined || entry.parcelId === null)
                ? `parcel-${index}` : String(entry.parcelId);

            // What the block WOULD put here if the plot were eligible. An excluded parcel is still
            // part of the block — merge it with a neighbour, or buy it, and this is the building it
            // would carry — so the shape is reported alongside the exclusion rather than discarded.
            // Without it, a left-out plot reads as a hole in the block instead of a plot that cannot
            // take a building as it stands.
            // A failed intersect is not "the massing does not reach this parcel": refuse.
            const piece = variationClip(turf, 'intersect', massingFeature, parcelFeature, 'urban-rule-variation.splitMassingByParcels', parcelId);
            const wouldBe = (piece && piece.geometry) ? piece.geometry : null;

            if (normalized.minPlotAreaM2 > 0 && areaOf(parcelFeature, turf) < normalized.minPlotAreaM2) {
                excluded.push({ parcelId, feature: parcelFeature, status: 'below-min-plot', wouldBe });
                return;
            }

            if (!wouldBe) {
                // The massing simply does not reach this parcel (a fully interior plot behind the
                // ring, or one the setback pushes past). Nothing would be built here even if the
                // plot were eligible, so there is no shape to show — only the plot itself.
                excluded.push({ parcelId, feature: parcelFeature, status: 'no-massing-here', wouldBe: null });
                return;
            }
            if (areaOf(piece, turf) < normalized.minPieceAreaM2) {
                excluded.push({ parcelId, feature: parcelFeature, status: 'sliver', wouldBe });
                return;
            }

            // The part of this plot's building the rule compels. Absent means the rule permits
            // building here but compels nothing — a rule can be silent on a plot without
            // contradicting itself.
            let compelledHere = null;
            if (compelled) {
                // A failed clip is not "the rule compels nothing here": it throws and refuses.
                const clip = variationClip(turf, 'intersect', compelled, piece, 'urban-rule-variation.compelledPerParcel', parcelId);
                if (clip && clip.geometry && areaOf(clip, turf) >= 1) compelledHere = clip.geometry;
            }

            pieces.push({
                type: 'Feature',
                properties: {
                    ...(massingFeature.properties || {}),
                    parcelId,
                    height,
                    massing: true,
                    geometryRole: 'authored-rule-envelope',
                    ruleProvenance: { source: 'authored-proposal', generator: 'split-massing', version: 1, definition: normalized },
                    planningCompliance: 'not-evaluated',
                    urbanRule: normalized,
                    variationSeed: hashSeed(designSeed, parcelId),
                    color: shadeForKey(parcelId),
                    buildingIndex: pieces.length,
                    ...(compelledHere ? { minFootprint: compelledHere } : {})
                },
                geometry: piece.geometry
            });
        });

        return { pieces, excluded };
    }

    // The pieces an applied Block or Row stands as on the ground it has now (`ground`:
    // [{ feature, parcelId }], the live parcels under it). A block is one building per parcel, so its
    // saved pieces stand as saved while each lies on one parcel of that ground and no two share one.
    // Once the ground has changed under it (a parcel layout it was drawn on came off the map), a
    // piece straddles today's parcels or two pieces share one, and its saved massing is cut again by
    // today's parcels. The saved design is never changed: these pieces exist only on the map.
    function piecesOnGround(buildings, massing, ground, deps) {
        const turf = deps && deps.turf;
        const rule = massing && massing.properties && massing.properties.urbanRule;
        if (!turf || !massing || !massing.geometry || !rule || (rule.typology !== 'block' && rule.typology !== 'row')
            || !Array.isArray(buildings) || !buildings.length || !Array.isArray(ground) || !ground.length) return buildings;
        const hosts = new Set();
        const standsAsSaved = buildings.every(piece => {
            if (!piece || !piece.geometry) return false;
            const point = turf.pointOnFeature(piece);
            const host = ground.find(entry => entry && entry.feature && entry.feature.geometry
                && turf.booleanPointInPolygon(point, entry.feature));
            if (!host || hosts.has(String(host.parcelId))) return false;
            hosts.add(String(host.parcelId));
            // A piece lies on its host when none of it outside the host is ground (the shared rule,
            // geometry-tolerances.js isGround, of the difference on the shared clip).
            const outside = variationClip(turf, 'difference', piece, host.feature, 'urban-rule-variation.piecesOnGround', host.parcelId);
            return !variationGround().isGround(turf, outside);
        });
        if (standsAsSaved) return buildings;
        const { pieces } = splitMassingByParcels(massing, ground, rule, massing.properties.variationSeed, deps);
        return pieces.length ? pieces : buildings;
    }

    // One legal build-out of a single block piece. Only the height varies: the footprint is fixed by
    // the parcel it sits on and the ring it was cut from, so a street under one rule reads as
    // separate buildings of different heights on a common building line.
    function realizeBlockPiece(pieceFeature, rule, seed, deps) {
        if (!pieceFeature || !pieceFeature.geometry) return null;
        const normalized = normalizeBlockRule(rule);
        if (normalized.kind === 'exact') return pieceFeature;

        const rng = mulberry32(num(seed, 0) >>> 0);
        const maxStoreys = Math.max(1, Math.floor(normalized.maxHeightM / normalized.floorHeightM));
        const minStoreys = Math.min(Math.max(1, Math.ceil(normalized.minHeightM / normalized.floorHeightM)), maxStoreys);
        const storeys = minStoreys + Math.floor(rng() * (maxStoreys - minStoreys + 1));

        // Depth is drawn after the height, so adding it did not restyle any design that predates
        // it. With both footprints already stored the choice costs no geometry at render time:
        // some plots build only as deep as the street line compels, others build the full plot.
        // Two states rather than a continuum — legible, and it keeps the share payload small.
        const compelled = pieceFeature.properties && pieceFeature.properties.minFootprint;
        const shallow = compelled ? (rng() < SHALLOW_BUILD_CHANCE) : false;

        return {
            type: 'Feature',
            properties: {
                ...(pieceFeature.properties || {}),
                storeys,
                // Never above the envelope: a partial storey rounds down, it does not round up.
                height: Math.min(normalized.maxHeightM, storeys * normalized.floorHeightM),
                builtToMinimumDepth: shallow,
                massing: false,
                geometryRole: 'illustrative-buildout',
                planningCompliance: 'not-evaluated'
            },
            geometry: shallow ? compelled : pieceFeature.geometry
        };
    }

    // Permitted vs guaranteed floor area for a set of block pieces — the range that makes the rule
    // type legible in the one number people vote on:
    //   max   → "permits 0 – 12,400 m²"      (nobody is compelled to build)
    //   range → "guarantees 4,100 – 12,400 m²"
    //   exact → "delivers 12,400 m²"
    function summariseBlockRule(pieces, rule, deps) {
        const turf = deps && deps.turf;
        const normalized = normalizeBlockRule(rule);
        const list = Array.isArray(pieces) ? pieces : [];
        let permitted = 0;
        let guaranteed = 0;
        if (!turf) return { permittedFloorAreaM2: 0, guaranteedFloorAreaM2: 0, kind: normalized.kind };

        list.forEach(piece => {
            if (!piece || !piece.geometry) return;
            const area = areaOf(piece, turf);
            permitted += area * (normalized.maxHeightM / normalized.floorHeightM);
            if (normalized.kind === 'exact') {
                guaranteed += area * (normalized.maxHeightM / normalized.floorHeightM);
                return;
            }
            if (normalized.kind !== 'range') return; // 'max' compels nothing at all
            const compelled = piece.properties && piece.properties.minFootprint;
            const compelledArea = compelled
                ? areaOf({ type: 'Feature', properties: {}, geometry: compelled }, turf)
                : 0;
            guaranteed += compelledArea * (normalized.minHeightM / normalized.floorHeightM);
        });

        return { permittedFloorAreaM2: permitted, guaranteedFloorAreaM2: guaranteed, kind: normalized.kind };
    }

    // Keep the complete authored footprint and the renderer's rule inputs together. Parcel
    // pieces are preview/economic derivatives; saving one of those would crop a free design.
    function massingWithRule(feature, rule, seed, deps) {
        if (!feature || !feature.geometry) return null;
        const result = JSON.parse(JSON.stringify(feature));
        const normalized = normalizeBlockRule(rule);
        result.properties = {
            ...(result.properties || {}),
            height: normalized.maxHeightM,
            massing: true,
            geometryRole: 'authored-rule-envelope',
            ruleProvenance: { source: 'authored-proposal', generator: 'block-massing', version: 1, definition: normalized },
            planningCompliance: 'not-evaluated',
            urbanRule: normalized,
            variationSeed: num(seed, 0) >>> 0
        };
        delete result.properties.minFootprint;
        const compelled = normalized.kind === 'range' && normalized.minDepthM > 0
            ? buildToMinimum(result, normalized.minDepthM, deps)
            : null;
        if (compelled && compelled.geometry) result.properties.minFootprint = compelled.geometry;
        return result;
    }

    // What a Block or Row design saves: the per-parcel pieces the editor drew, each carrying the rule
    // and its own seed so every view realizes them as separate buildings, plus the complete massing
    // they were cut from. Saving only the massing hands every view one seed for the whole ring or
    // terrace, which draws one height where the editor showed a street of varied ones.
    function ruleDesignGeometry(massing, pieces, rule, seed, deps) {
        return {
            buildings: JSON.parse(JSON.stringify((pieces || []).filter(Boolean))),
            ruleMassing: massingWithRule(massing, rule, seed, deps)
        };
    }

    // Realize a stored massing feature from the rule and seed stamped on it. `salt` re-rolls the
    // variation without touching the stored seed — that is how the 3D view's Randomize can shuffle
    // the whole city without writing to a single proposal.
    //
    // A feature carrying no rule (an imported shape, a design saved before rules existed) has no
    // variation to derive and is returned unchanged, so it renders as itself in every view.
    function realizeFeature(feature, deps, salt) {
        const props = feature && feature.properties;
        const rule = props && props.urbanRule;
        if (!rule) return feature;
        const base = props.variationSeed;
        if (typeof base !== 'number' || !Number.isFinite(base)) return feature;
        const seed = (salt === undefined || salt === null || salt === '')
            ? (base >>> 0)
            : hashSeed(base, salt);
        // A free-standing house varies its footprint inside its envelope; a block or row piece has
        // its footprint fixed by the parcel and the building line, and varies only in height.
        const realize = (rule.typology === 'block' || rule.typology === 'row')
            ? realizeBlockPiece
            : realizeFromEnvelope;
        return realize(feature, rule, seed, deps) || feature;
    }

    // What a view should draw for one planned feature, given how it is asked to represent planned
    // proposals ('massing' | 'buildout' | 'both'). Kept here rather than in the renderer because it
    // is the one piece of branching the whole feature turns on, and a renderer cannot be unit-tested.
    //
    //   buildOut     — the example to draw solid, or null
    //   massing      — the permitted volume to draw, or null
    //   massingStyle — 'primary' when the massing IS what is being shown (draw it like any planned
    //                  building); 'envelope' when it sits behind an example (draw it translucent)
    //
    // When the build-out equals the massing — no rule to vary, or a build-exactly rule — only one
    // of the two comes back, so coincident volumes can never z-fight.
    function plannedDrawPlan(feature, representation, deps, salt) {
        const showMassing = representation !== 'buildout';
        const showBuildOut = representation !== 'massing';
        const built = showBuildOut ? realizeFeature(feature, deps, salt) : feature;
        const varies = built !== feature;
        return {
            buildOut: showBuildOut ? built : null,
            massing: (showMassing && (varies || !showBuildOut)) ? feature : null,
            massingStyle: (varies && showBuildOut) ? 'envelope' : 'primary'
        };
    }

    // --- the use, balconies and roof controls ------------------------------------------------
    // The Block, Row and Detached editors share these. They touch only the container an editor
    // passes in; everything above stays DOM-free.

    // The Use select: the six uses with the Freeform editor's labels; a Block also offers automatic.
    const USE_LABELS = { residential: ['useResidential', 'Residential'], 'residential-shops': ['useResidentialShops', 'Residential, shops on the ground floor'],
        mixed: ['useMixed', 'Mixed: shops, offices on the first floor, flats above'], office: ['useOffice', 'Office'],
        public: ['usePublic', 'Public (school, clinic, civic)'], industrial: ['useIndustrial', 'Industrial'] };
    function useOptionsMarkup(automatic) {
        const options = buildingUse().USES.map(use => `<option value="${use}" data-i18n-key="modal.singleBuilding.${USE_LABELS[use][0]}">${USE_LABELS[use][1]}</option>`);
        if (automatic) options.unshift('<option value="" data-i18n-key="urbanRule.useAutomatic">Automatic: shops on the ground floor from 5 storeys</option>');
        return options.join('');
    }

    // `automaticUse`: the Block editor, whose rule may leave the use to the suggested layout.
    function extrasControlsMarkup(prefix, { automaticUse = false } = {}) {
        return `
            <div class="parameter-group urban-rule-extras">
                <label class="urban-rule-extras__use" for="${prefix}-use">
                    <span data-i18n-key="modal.singleBuilding.useLabel" data-i18n-attr="text">Building use</span>
                    <select id="${prefix}-use">${useOptionsMarkup(automaticUse)}</select>
                </label>
                <label class="checkbox-label urban-rule-extras__toggle" for="${prefix}-balconies">
                    <input type="checkbox" id="${prefix}-balconies">
                    <span data-i18n-key="urbanRule.balconies" data-i18n-attr="text">Balconies</span>
                </label>
                <label class="urban-rule-extras__depth" for="${prefix}-balcony-depth" hidden>
                    <span data-i18n-key="urbanRule.balconyDepth" data-i18n-attr="text">May stand out of the envelope by (m):</span>
                    <input type="number" id="${prefix}-balcony-depth" min="0.5" max="${MAX_BALCONY_DEPTH_M}" step="0.1" value="${DEFAULT_BALCONY_DEPTH_M}">
                </label>
                <label class="checkbox-label urban-rule-extras__toggle" for="${prefix}-slanted-roof">
                    <input type="checkbox" id="${prefix}-slanted-roof">
                    <span data-i18n-key="urbanRule.slantedRoof" data-i18n-attr="text">Slanted roof with attic</span>
                </label>
            </div>`;
    }

    function extrasControls(container, prefix) {
        const find = suffix => container && container.querySelector(`#${prefix}-${suffix}`);
        return { use: find('use'), balconies: find('balconies'), depth: find('balcony-depth'), roof: find('slanted-roof') };
    }

    function syncExtrasControls(container, prefix, extras) {
        const c = extrasControls(container, prefix);
        if (!c.balconies || !c.depth || !c.roof) return;
        const depth = num(extras && extras.balconyDepthM, 0);
        c.balconies.checked = depth > 0;
        if (depth > 0) c.depth.value = String(depth);
        c.depth.closest('label').hidden = !(depth > 0);
        c.roof.checked = !!(extras && extras.roof === 'pitched');
        if (c.use) c.use.value = (extras && extras.use) || (c.use.querySelector('option[value=""]') ? '' : 'residential');
    }

    // `onChange(extras)` receives the normalized fields after every edit of the three controls.
    function bindExtrasControls(container, prefix, onChange) {
        const c = extrasControls(container, prefix);
        if (!c.balconies || !c.depth || !c.roof) return;
        const read = () => normalizeRuleExtras({
            balconyDepthM: c.balconies.checked ? num(c.depth.value, DEFAULT_BALCONY_DEPTH_M) : 0,
            roof: c.roof.checked ? 'pitched' : 'flat',
            use: c.use ? c.use.value : null
        });
        const changed = () => {
            c.depth.closest('label').hidden = !c.balconies.checked;
            onChange(read());
        };
        c.balconies.addEventListener('change', changed);
        c.roof.addEventListener('change', changed);
        c.depth.addEventListener('change', changed);
        if (c.use) c.use.addEventListener('change', changed);
    }

    const api = {
        DEFAULT_FLOOR_HEIGHT_M,
        DEFAULT_MAX_FLOORS,
        DEFAULT_MIN_DISTANCE_M,
        RULE_KINDS,
        DEFAULT_BALCONY_DEPTH_M,
        MAX_BALCONY_DEPTH_M,
        ROOF_KINDS,
        hashSeed,
        mulberry32,
        rngFor,
        hashIndex,
        shadeForKey,
        normalizeParcelRule,
        normalizeBlockRule,
        normalizeRuleExtras,
        defaultRuleExtras,
        extrasControlsMarkup,
        syncExtrasControls,
        bindExtrasControls,
        PARCEL_LIMITS,
        evaluateParcel,
        parcelEnvelope,
        buildToMinimum,
        splitMassingByParcels,
        piecesOnGround,
        summariseBlockRule,
        realizeFromEnvelope,
        realizeBlockPiece,
        massingWithRule,
        ruleDesignGeometry,
        realizeFeature,
        plannedDrawPlan
    };

    if (typeof global !== 'undefined') {
        global.UrbanRuleVariation = api;
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
})(typeof window !== 'undefined' ? window : globalThis);
