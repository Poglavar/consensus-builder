// The permitted-massing ↔ example-build-out split for urban rules: a deterministic PRNG, the
// canonical rule shape, the per-parcel maximum envelope, and one legal build-out sampled inside it.
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
        const maxFloors = Math.max(1, Math.round(num(source.maxFloors, DEFAULT_MAX_FLOORS)));
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
            minPlotAreaM2: nonNegative(source.minPlotAreaM2, 0)
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
            minPieceAreaM2: nonNegative(source.minPieceAreaM2, DEFAULT_MIN_PIECE_AREA_M2)
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

        if (normalized.minPlotAreaM2 > 0 && areaOf(feature, turf) < normalized.minPlotAreaM2) {
            return { envelope: null, status: 'below-min-plot' };
        }

        let envelope = feature;
        if (normalized.minDistance > 0) {
            let buffered = null;
            try {
                buffered = turf.buffer(feature, -normalized.minDistance / 1000, { units: 'kilometers', steps: 16 });
            } catch (_) {
                return { envelope: null, status: 'no-room-after-setback' };
            }
            if (!buffered || !buffered.geometry) return { envelope: null, status: 'no-room-after-setback' };
            envelope = toLargestPolygon(buffered, deps);
        }
        if (!envelope || !envelope.geometry) return { envelope: null, status: 'no-room-after-setback' };
        const envelopeArea = areaOf(envelope, turf);
        if (!(envelopeArea >= MIN_ENVELOPE_AREA_M2)) return { envelope: null, status: 'no-room-after-setback' };

        if (normalized.minFootprintAreaM2 > 0 && envelopeArea < normalized.minFootprintAreaM2) {
            return { envelope: null, status: 'cannot-meet-minimum' };
        }

        return {
            status: 'ok',
            envelope: {
                type: 'Feature',
                properties: {
                    floors: normalized.maxFloors,
                    height: normalized.maxFloors * normalized.floorHeightM,
                    massing: true
                },
                geometry: envelope.geometry
            }
        };
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

    // One legal build-out inside the envelope.
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
        const floors = lowest + Math.floor(rng() * (Math.max(0, normalized.maxFloors - lowest) + 1));
        const footprint = varyFootprint(envelopeFeature, rng, deps, normalized.minFootprintAreaM2) || envelopeFeature;

        return {
            type: 'Feature',
            properties: {
                ...(envelopeFeature.properties || {}),
                floors,
                height: floors * normalized.floorHeightM,
                massing: false
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
    function buildToMinimum(massingFeature, minDepthM, deps) {
        const turf = deps && deps.turf;
        if (!massingFeature || !massingFeature.geometry || !turf || !(minDepthM > 0)) return null;
        const filled = fillHoles(massingFeature, turf);
        if (!filled) return null;

        let core = null;
        try { core = turf.buffer(filled, -minDepthM / 1000, { units: 'kilometers', steps: 16 }); } catch (_) { core = null; }

        let band = filled;
        if (core && core.geometry) {
            try { band = turf.difference(filled, core) || filled; } catch (_) { band = filled; }
        }

        let clipped = null;
        try { clipped = turf.intersect(band, massingFeature); } catch (_) { clipped = null; }
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

            if (normalized.minPlotAreaM2 > 0 && areaOf(parcelFeature, turf) < normalized.minPlotAreaM2) {
                excluded.push({ parcelId, feature: parcelFeature, status: 'below-min-plot' });
                return;
            }

            let piece = null;
            try { piece = turf.intersect(massingFeature, parcelFeature); } catch (_) { piece = null; }
            if (!piece || !piece.geometry) {
                // The massing simply does not reach this parcel (a fully interior plot behind the
                // ring). Not a rule conflict — reported apart from the exclusions.
                excluded.push({ parcelId, feature: parcelFeature, status: 'no-massing-here' });
                return;
            }
            if (areaOf(piece, turf) < normalized.minPieceAreaM2) {
                excluded.push({ parcelId, feature: parcelFeature, status: 'sliver' });
                return;
            }

            // The part of this plot's building the rule compels. Absent means the rule permits
            // building here but compels nothing — a rule can be silent on a plot without
            // contradicting itself.
            let compelledHere = null;
            if (compelled) {
                try {
                    const clip = turf.intersect(compelled, piece);
                    if (clip && clip.geometry && areaOf(clip, turf) >= 1) compelledHere = clip.geometry;
                } catch (_) { compelledHere = null; }
            }

            pieces.push({
                type: 'Feature',
                properties: {
                    ...(massingFeature.properties || {}),
                    parcelId,
                    height,
                    massing: true,
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
                massing: false
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

    const api = {
        DEFAULT_FLOOR_HEIGHT_M,
        DEFAULT_MAX_FLOORS,
        DEFAULT_MIN_DISTANCE_M,
        RULE_KINDS,
        hashSeed,
        mulberry32,
        rngFor,
        hashIndex,
        shadeForKey,
        normalizeParcelRule,
        normalizeBlockRule,
        evaluateParcel,
        parcelEnvelope,
        buildToMinimum,
        splitMassingByParcels,
        summariseBlockRule,
        realizeFromEnvelope,
        realizeBlockPiece,
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
