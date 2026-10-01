// Open ground (PARCEL-OPTIONAL.md, phase 3): the part of a proposal's site that no bound cadastral
// parcel covers. At apply time it is hosted as ONE non-cadastral parent piece `ground:<siteHash>`,
// derived from the record's site and its binding (the declared parcels' repository geometry) —
// never from gaps in whatever parcels the browser happened to load. Pieces a formation mints on it
// carry no cadastral ids, only a `groundIds` provenance. Also a bbox grid so proposals standing on
// the same open ground find each other without an O(N²) scan.
//
// Pure: turf, site-binding and plan-order are injected or read from the global/require.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__openGround = api;
})(typeof window !== 'undefined' ? window : globalThis, function (global) {
    'use strict';

    const GROUND_ID_PREFIX = 'ground:';
    // Numerical floor for one component of open ground. The width floor (site-binding's
    // max(tolerance, INTRUSION_NOISE_M)) decides what is ground; this only skips the inward-buffer
    // test for specks that are certainly not.
    const MIN_GROUND_COMPONENT_M2 = 0.01;
    // Default grid cell of the interaction index, in degrees (~250-550 m). Proposals are tens to
    // hundreds of metres across, so a few cells per entry; larger entries go to an overflow list.
    const DEFAULT_CELL_DEG = 0.005;
    const MAX_CELLS_PER_ENTRY = 64;

    function T(options) {
        if (options && options.turf) return options.turf;
        if (typeof turf !== 'undefined' && turf) return turf; // eslint-disable-line no-undef
        if (global && global.turf) return global.turf;
        try { return typeof require === 'function' ? require('@turf/turf') : null; } catch (_) { return null; }
    }

    function siteBindingApi(options) {
        if (options && options.siteBinding) return options.siteBinding;
        if (global && global.__siteBinding) return global.__siteBinding;
        try { return typeof require === 'function' ? require('./site-binding.js') : null; } catch (_) { return null; }
    }

    function asPolygonGeometry(value) {
        const geometry = value && value.type === 'Feature' ? value.geometry : value;
        return geometry && (geometry.type === 'Polygon' || geometry.type === 'MultiPolygon') ? geometry : null;
    }

    function polygonsOf(value) {
        const g = asPolygonGeometry(value);
        if (!g) return [];
        return g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
    }

    function declaredIdsOf(record) {
        const raw = record && Array.isArray(record.cadastreParcelIds) ? record.cadastreParcelIds : [];
        return Array.from(new Set(raw.map(value => String(value === undefined || value === null ? '' : value).trim()).filter(Boolean)));
    }

    function isGroundId(value) {
        return typeof value === 'string' && value.startsWith(GROUND_ID_PREFIX) && value.length > GROUND_ID_PREFIX.length;
    }

    function groundIdFromHash(siteHashHex) {
        const hex = String(siteHashHex || '').trim().toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error('A ground id needs a 32-byte site hash in hex.');
        return GROUND_ID_PREFIX + hex;
    }

    function groundIdsOf(featureOrProps) {
        const props = featureOrProps && featureOrProps.properties && typeof featureOrProps.properties === 'object'
            ? featureOrProps.properties
            : (featureOrProps || {});
        const raw = Array.isArray(props.groundIds) ? props.groundIds : [];
        return Array.from(new Set(raw.map(String).filter(isGroundId)));
    }

    function cadastreIdsOfFeature(feature) {
        const raw = feature && feature.properties && Array.isArray(feature.properties.cadastreParcelIds)
            ? feature.properties.cadastreParcelIds
            : [];
        return raw.map(String).filter(Boolean);
    }

    // A live piece that stands only on open ground: ground provenance, no cadastral parcel. Such a
    // piece is never a cadastral parcel (declaration, owner offer, counts, history).
    function isGroundPiece(feature) {
        return groundIdsOf(feature).length > 0 && cadastreIdsOfFeature(feature).length === 0;
    }

    // The transient apply-time host itself (never stored in the fabric).
    function isOpenGroundHost(feature) {
        return !!(feature && feature.properties && feature.properties.openGroundHost === true);
    }

    /**
     * Whether a record stands (partly) on open ground: a material record with a site whose
     * declaration is empty, or whose binding says part of the site is on no parcel (coverage
     * partial/none). A declared record with coverage complete/unknown or no binding at all keeps
     * the cadastre-only behaviour: `unknown` is a city whose cadastre the server does not hold, and
     * its declaration is all we know. Parcel acts never stand on open ground.
     */
    function hasOpenGround(record, options) {
        if (!record || typeof record !== 'object') return false;
        const sb = siteBindingApi(options);
        if (!sb) return false;
        if (typeof sb.isParcelAct === 'function' && sb.isParcelAct(record)) return false;
        if (declaredIdsOf(record).length) {
            const coverage = record.binding && typeof record.binding === 'object' ? record.binding.coverage : null;
            if (coverage !== 'partial' && coverage !== 'none') return false;
        }
        if (typeof sb.requiresParcels === 'function' && sb.requiresParcels(record)) return false;
        return !!(typeof sb.siteOf === 'function' && sb.siteOf(record, options));
    }

    // A corridor with an empty declaration takes no cadastral parcel: its ribbon lies on open
    // ground (a road across unsurveyed land or an explore city). It is an undeclared CADASTRAL take
    // only when its binding names parcels the declaration lacks — that stays an error.
    function corridorOnOpenGroundOnly(record) {
        if (!record || declaredIdsOf(record).length) return false;
        const binding = record.binding;
        if (!binding || typeof binding !== 'object') return true;
        return !(Array.isArray(binding.parcels) && binding.parcels.length);
    }

    function bboxOf(value) {
        const box = [Infinity, Infinity, -Infinity, -Infinity];
        const visit = node => {
            if (!Array.isArray(node)) return;
            if (typeof node[0] === 'number' && typeof node[1] === 'number') {
                if (node[0] < box[0]) box[0] = node[0];
                if (node[1] < box[1]) box[1] = node[1];
                if (node[0] > box[2]) box[2] = node[0];
                if (node[1] > box[3]) box[3] = node[1];
                return;
            }
            node.forEach(visit);
        };
        polygonsOf(value).forEach(visit);
        return Number.isFinite(box[0]) ? box : null;
    }

    function bboxesIntersect(a, b) {
        return !!a && !!b && !(a[0] > b[2] || b[0] > a[2] || a[1] > b[3] || b[1] > a[3]);
    }

    function toGeometry(polygons) {
        if (!polygons.length) return null;
        return polygons.length === 1
            ? { type: 'Polygon', coordinates: polygons[0] }
            : { type: 'MultiPolygon', coordinates: polygons };
    }

    /**
     * site − ∪ parcels, keeping only components wider than the binding floor.
     * @param site Polygon/MultiPolygon (or Feature).
     * @param parcels [{ id, geometry }] — the BOUND parcels (their repository geometry).
     * @param options { toleranceM, turf, clip(op, a, b), siteBinding }
     * A failed difference throws (code `open-ground-derivation-failed`): a host computed without one
     * of the parcels would overlap that parcel's ground, which is the double cover this must prevent.
     * Parcels are subtracted one at a time — a difference against a union of several real parcels
     * is what throws "Maximum call stack size exceeded" in turf.
     */
    function openGroundGeometry(site, parcels, options) {
        const opts = options || {};
        const t = T(opts);
        if (!t) throw new Error('open-ground: turf is not available');
        const siteGeometry = asPolygonGeometry(site);
        if (!siteGeometry) throw new TypeError('site must be a GeoJSON Polygon or MultiPolygon');
        const clip = typeof opts.clip === 'function' ? opts.clip : (operation, a, b) => t[operation](a, b);
        const siteBox = bboxOf(siteGeometry);
        let open = t.feature(siteGeometry);
        for (const parcel of Array.isArray(parcels) ? parcels : []) {
            const geometry = parcel && asPolygonGeometry(parcel.geometry);
            if (!geometry) continue;
            if (!bboxesIntersect(siteBox, bboxOf(geometry))) continue;
            let next = null;
            try {
                next = clip('difference', open, t.feature(geometry));
            } catch (error) {
                const failure = new Error(`Open ground could not be separated from parcel ${parcel.id}: ${error && error.message}`);
                failure.code = 'open-ground-derivation-failed';
                failure.parcelId = parcel.id === undefined ? null : String(parcel.id);
                throw failure;
            }
            if (!next || !polygonsOf(next).length) return null;
            open = next;
        }
        const sb = siteBindingApi(opts);
        const floorM = Math.max(
            Number(opts.toleranceM) > 0 ? Number(opts.toleranceM) : 0,
            sb && Number.isFinite(sb.INTRUSION_NOISE_M) ? sb.INTRUSION_NOISE_M : 0.001
        );
        const kept = polygonsOf(open).filter(rings => {
            const piece = t.polygon(rings);
            if (!(t.area(piece) >= MIN_GROUND_COMPONENT_M2)) return false;
            return !sb || typeof sb.survivesInwardBuffer !== 'function'
                || sb.survivesInwardBuffer(piece, floorM / 2, { turf: t });
        });
        return toGeometry(kept);
    }

    /**
     * The open-ground host of a record, or null when it has none.
     * @param options { parcels: [{ id, geometry }] for EVERY declared id, siteHashHex, turf, clip,
     *   occupied: [{ id, geometry }] — pieces other proposals already formed on this open ground.
     *   They are taken out of the host and become parents in their own right, exactly as a formed
     *   piece on a cadastral parcel is a parent rather than part of the parcel. }
     */
    function openGroundHost(record, options) {
        const opts = options || {};
        if (!hasOpenGround(record, opts)) return null;
        const t = T(opts);
        const sb = siteBindingApi(opts);
        const site = sb.siteOf(record, opts);
        if (!site) return null;
        const declared = declaredIdsOf(record);
        const parcels = Array.isArray(opts.parcels) ? opts.parcels : [];
        const have = new Set(parcels.map(parcel => String(parcel && parcel.id)));
        const missing = declared.filter(id => !have.has(id));
        if (missing.length) {
            const error = new Error(`Open ground needs the bound parcels' geometry; missing: ${missing.join(', ')}`);
            error.code = 'open-ground-parcels-missing';
            error.parcelIds = missing;
            throw error;
        }
        const occupied = Array.isArray(opts.occupied) ? opts.occupied : [];
        const taken = parcels.filter(parcel => declared.includes(String(parcel.id))).concat(occupied);
        const geometry = taken.length
            ? openGroundGeometry(site, taken, { ...opts, toleranceM: record.toleranceM })
            : (polygonsOf(site).length ? toGeometry(polygonsOf(site)) : null);
        if (!geometry) return null;
        const id = groundIdFromHash(opts.siteHashHex);
        let areaM2 = null;
        try { areaM2 = t ? t.area(t.feature(geometry)) : null; } catch (_) { areaM2 = null; }
        return {
            type: 'Feature',
            properties: {
                parcelId: id,
                id,
                cadastreParcelIds: [],
                groundIds: [id],
                openGroundHost: true,
                siteHash: String(opts.siteHashHex).toLowerCase(),
                groundOfProposalId: record.proposalId === undefined || record.proposalId === null
                    ? null : String(record.proposalId),
                calculatedArea: typeof areaM2 === 'number' && Number.isFinite(areaM2) ? Math.round(areaM2) : null
            },
            geometry
        };
    }

    /**
     * A uniform-grid bbox index. `insert(key, bbox)`, `query(bbox)` → Set of keys whose bbox
     * intersects. Entries spanning more than MAX_CELLS_PER_ENTRY cells sit in an overflow list
     * checked on every query (a city-long road), so one huge entry cannot blow the grid up.
     */
    function createBboxIndex(options) {
        const cell = Number(options && options.cellDeg) > 0 ? Number(options.cellDeg) : DEFAULT_CELL_DEG;
        const cells = new Map();
        const boxes = new Map();
        const overflow = new Set();
        const range = box => [
            Math.floor(box[0] / cell), Math.floor(box[1] / cell),
            Math.floor(box[2] / cell), Math.floor(box[3] / cell)
        ];
        function insert(key, box) {
            if (!box) return;
            boxes.set(key, box);
            const [x0, y0, x1, y1] = range(box);
            if ((x1 - x0 + 1) * (y1 - y0 + 1) > MAX_CELLS_PER_ENTRY) { overflow.add(key); return; }
            for (let x = x0; x <= x1; x += 1) {
                for (let y = y0; y <= y1; y += 1) {
                    const k = `${x}:${y}`;
                    if (!cells.has(k)) cells.set(k, new Set());
                    cells.get(k).add(key);
                }
            }
        }
        function query(box) {
            const out = new Set();
            if (!box) return out;
            const consider = key => { if (!out.has(key) && bboxesIntersect(box, boxes.get(key))) out.add(key); };
            overflow.forEach(consider);
            const [x0, y0, x1, y1] = range(box);
            if ((x1 - x0 + 1) * (y1 - y0 + 1) > MAX_CELLS_PER_ENTRY) {
                boxes.forEach((_, key) => consider(key));
                return out;
            }
            for (let x = x0; x <= x1; x += 1) {
                for (let y = y0; y <= y1; y += 1) {
                    const bucket = cells.get(`${x}:${y}`);
                    if (bucket) bucket.forEach(consider);
                }
            }
            return out;
        }
        return { insert, query, size: () => boxes.size };
    }

    /**
     * Which candidates interact with `seeds` geometrically: their grounds (site, else footprint)
     * intersect with positive area and at least one of the two stands on open ground (cadastral
     * pairs already interact through shared anchors). Transitive through every member it adds.
     * @param seeds, candidates [{ id, bbox, geometry, openGround }]
     * @param options { intersects(a, b) → boolean (exact test, called only after the bbox test) }
     * @returns Set of candidate ids (seeds excluded)
     */
    function geometricInteractions(seeds, candidates, options) {
        const intersects = options && typeof options.intersects === 'function' ? options.intersects : null;
        if (!intersects) throw new Error('geometricInteractions needs an exact intersects test');
        const index = createBboxIndex(options);
        const byId = new Map();
        (Array.isArray(candidates) ? candidates : []).forEach(entry => {
            if (!entry || !entry.id || !entry.bbox) return;
            byId.set(String(entry.id), entry);
            index.insert(String(entry.id), entry.bbox);
        });
        const included = new Set();
        const seen = new Set();
        const queue = (Array.isArray(seeds) ? seeds : []).filter(entry => entry && entry.bbox);
        queue.forEach(entry => seen.add(String(entry.id)));
        while (queue.length) {
            const member = queue.shift();
            index.query(member.bbox).forEach(id => {
                if (seen.has(id)) return;
                const other = byId.get(id);
                if (!other || !(member.openGround || other.openGround)) return;
                if (!intersects(member.geometry, other.geometry)) return;
                seen.add(id);
                included.add(id);
                queue.push(other);
            });
        }
        return included;
    }

    // What a drawn corridor crosses, for the road tool's stats: cadastral parcels (counted, with
    // their owners) apart from pieces formed on open ground (subdivision plots, parks, building
    // plots with no cadastral parcel), which have no owner and nothing to acquire. Returns
    // { parcels, ground: { pieces: [{ id, areaM2 }], count, areaM2 } }; a ground piece's area is its stored
    // calculatedArea, else measured. Pieces are deduplicated by id.
    function splitCrossedPieces(features, options = {}) {
        const t = T(options);
        const idOf = typeof options.idOf === 'function'
            ? options.idOf
            : feature => (feature && feature.properties && (feature.properties.parcelId ?? feature.properties.id)) ?? null;
        const parcels = [];
        const pieces = [];
        const seen = new Set();
        let areaM2 = 0;
        (Array.isArray(features) ? features : []).forEach(feature => {
            if (!feature) return;
            if (!isGroundPiece(feature)) { parcels.push(feature); return; }
            const raw = idOf(feature);
            const id = raw === undefined || raw === null ? '' : String(raw);
            if (id && seen.has(id)) return;
            if (id) seen.add(id);
            const stored = Number(feature.properties && feature.properties.calculatedArea);
            let measured = 0;
            if (Number.isFinite(stored) && stored > 0) measured = stored;
            else if (t) { try { measured = t.area(feature) || 0; } catch (_) { measured = 0; } }
            pieces.push({ id, areaM2: measured });
            areaM2 += measured;
        });
        return { parcels, ground: { pieces, count: pieces.length, areaM2 } };
    }

    return {
        GROUND_ID_PREFIX,
        MIN_GROUND_COMPONENT_M2,
        isGroundId,
        groundIdFromHash,
        groundIdsOf,
        isGroundPiece,
        isOpenGroundHost,
        splitCrossedPieces,
        declaredIdsOf,
        hasOpenGround,
        corridorOnOpenGroundOnly,
        bboxOf,
        bboxesIntersect,
        openGroundGeometry,
        openGroundHost,
        createBboxIndex,
        geometricInteractions
    };
});
