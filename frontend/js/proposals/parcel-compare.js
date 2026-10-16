// Compare how two proposals affect ONE parcel (the owner's view): which proposals touch the parcel at
// all, and, per proposal, what it does to that parcel only — how much ground it takes, what stands
// there afterwards (buildings, a park/square/lake, a road or track ribbon, readjustment plots), where
// the ownership of the taken ground goes, what the owner is asked and how far consent has got.
//
// A proposal touches the parcel when its declaration (binding) names it, or when its site reaches
// into it without naming it (a sub-tolerance intrusion, an old record); the latter is reported with
// its intrusion width (site-binding.js). A missing measurement stays null, never 0: a record without
// building geometry has an unknown building count, not zero buildings.
//
// Pure: plain records and GeoJSON in, plain objects (and an SVG string) out. No DOM, no map, no
// storage, no fetch. turf comes from options.turf, the global, or require('@turf/turf').
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__parcelCompare = api;
})(typeof window !== 'undefined' ? window : globalThis, function (global) {
    'use strict';

    // Below this an overlap is boundary noise (the same floor as plan-order's ancestry).
    const MIN_OVERLAP_M2 = 0.25;
    // A take of at least this share of the parcel (or leaving less than MIN_REMAINDER_M2) is the
    // whole parcel.
    const WHOLE_SHARE = 0.995;
    const MIN_REMAINDER_M2 = 1;
    // A take that reaches in from the parcel's outline and covers less than this share is "edge only".
    const EDGE_MAX_SHARE = 0.5;
    // A vertex of the take this close to the parcel outline counts as touching it.
    const EDGE_TOUCH_M = 0.05;

    const BUILDING_GOALS = new Set(['single', 'buildings', 'building(s)', 'single-building', 'row', 'parcelbased']);
    const STRUCTURE_KINDS = new Set(['park', 'square', 'lake', 'station']);

    function T(options) {
        if (options && options.turf) return options.turf;
        if (typeof turf !== 'undefined' && turf) return turf; // eslint-disable-line no-undef
        if (global && global.turf) return global.turf;
        try { return typeof require === 'function' ? require('@turf/turf') : null; } catch (_) { return null; }
    }

    function dep(globalName, path) {
        if (global && global[globalName]) return global[globalName];
        try { return typeof require === 'function' ? require(path) : null; } catch (_) { return null; }
    }
    const siteBindingApi = () => dep('__siteBinding', './site-binding.js');
    const planYieldApi = () => dep('__planYield', './plan-yield.js');
    const ownershipFlowApi = () => dep('__ownershipFlow', './ownership-flow.js');

    const finite = value => typeof value === 'number' && Number.isFinite(value);
    function num(value) {
        if (value === null || value === undefined || value === '') return null;
        const n = typeof value === 'number' ? value : Number(value);
        return Number.isFinite(n) ? n : null;
    }
    const round = (value, digits) => {
        if (!finite(value)) return null;
        const f = Math.pow(10, digits);
        return Math.round(value * f) / f;
    };

    function asPolygonGeometry(value) {
        const geometry = value && value.type === 'Feature' ? value.geometry : value;
        return geometry && (geometry.type === 'Polygon' || geometry.type === 'MultiPolygon') ? geometry : null;
    }

    function featureOf(value) {
        const geometry = asPolygonGeometry(value);
        return geometry ? { type: 'Feature', properties: {}, geometry } : null;
    }

    function normalizeGoal(goal) {
        return String(goal === undefined || goal === null ? '' : goal).trim().toLowerCase();
    }

    function idOf(record) {
        if (!record) return null;
        const id = record.proposalId !== undefined && record.proposalId !== null ? record.proposalId : record.id;
        return id === undefined || id === null ? null : String(id);
    }

    function declaredIds(record) {
        return Array.isArray(record && record.cadastreParcelIds) ? record.cadastreParcelIds.map(String) : [];
    }

    // The parcel as the comparison sees it: { id, cadastreIds: [...], feature }.
    function parcelKeys(parcel) {
        const ids = Array.isArray(parcel && parcel.cadastreIds) && parcel.cadastreIds.length
            ? parcel.cadastreIds
            : (parcel && parcel.id !== undefined && parcel.id !== null ? [parcel.id] : []);
        return new Set(ids.map(String));
    }

    function bboxesIntersect(a, b) {
        return !!a && !!b && a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
    }

    function safeIntersect(t, a, b) {
        try { return t.intersect(a, b) || null; } catch (_) { return null; }
    }

    function areaOf(t, feature) {
        if (!feature) return 0;
        try { return t.area(feature) || 0; } catch (_) { return 0; }
    }

    // The proposal's ground: its authored site, else its own footprint, else (a parcel act) the
    // declared parcels among `parcels`. Null when nothing says where it is.
    function siteFeatureOf(record, parcel, options) {
        const sb = siteBindingApi();
        if (!sb || typeof sb.siteOf !== 'function') return null;
        const parcels = parcel && parcel.feature
            ? Array.from(parcelKeys(parcel)).map(id => ({ id, geometry: asPolygonGeometry(parcel.feature) }))
            : [];
        let site = null;
        try { site = sb.siteOf(record, { turf: T(options), parcels }); } catch (_) { site = null; }
        return featureOf(site);
    }

    // The stored binding's entry for this parcel ({ overlapM2, intrusionM }), from `parcels` (bound)
    // or `touched` (reached into below the tolerance).
    function storedBindingEntry(record, keys) {
        const binding = record && record.binding;
        if (!binding || typeof binding !== 'object') return null;
        for (const list of [binding.parcels, binding.touched]) {
            if (!Array.isArray(list)) continue;
            const hit = list.find(entry => entry && keys.has(String(entry.parcelId)));
            if (hit) return hit;
        }
        return null;
    }

    function intrusionOf(t, clip) {
        const sb = siteBindingApi();
        if (!sb || typeof sb.intrusionWidth !== 'function' || !clip) return null;
        try { return round(sb.intrusionWidth(clip, { turf: t }), 2); } catch (_) { return null; }
    }

    /**
     * How one record touches the parcel, or null when it does not.
     * @returns {null | { relation: 'bound'|'intrudes', overlapM2: number|null, intrusionM: number|null, clip: object|null }}
     *   bound    — its declaration names the parcel (owner consent territory);
     *   intrudes — its site reaches into the parcel without naming it.
     * `options.measure === false` skips the intrusion-width bisection (cheap counting).
     */
    function relationOf(record, parcel, options) {
        const opts = options || {};
        const t = T(opts);
        if (!record || !parcel) return null;
        const keys = parcelKeys(parcel);
        const declared = declaredIds(record).some(id => keys.has(id));
        const parcelFeature = featureOf(parcel.feature);
        let clip = null;
        if (t && parcelFeature) {
            const site = siteFeatureOf(record, parcel, opts);
            if (site) {
                let overlaps = true;
                try { overlaps = bboxesIntersect(t.bbox(site), t.bbox(parcelFeature)); } catch (_) { overlaps = true; }
                if (overlaps) clip = safeIntersect(t, site, parcelFeature);
                if (clip && areaOf(t, clip) <= 0) clip = null;
            }
        }
        const stored = storedBindingEntry(record, keys);
        if (!declared && !clip) return null;
        const overlapM2 = clip ? round(areaOf(t, clip), 2) : (stored ? num(stored.overlapM2) : null);
        let intrusionM = null;
        if (opts.measure !== false) {
            intrusionM = clip ? intrusionOf(t, clip) : (stored ? num(stored.intrusionM) : null);
        }
        return { relation: declared ? 'bound' : 'intrudes', overlapM2, intrusionM, clip };
    }

    /**
     * Every record that touches the parcel: declared ones and those whose site reaches into it.
     * @returns {{ proposal, relation, overlapM2, intrusionM, clip }[]} declared first, then by overlap.
     */
    function proposalsTouchingParcel(parcel, records, options) {
        const out = [];
        const seen = new Set();
        for (const record of Array.isArray(records) ? records : []) {
            const id = idOf(record);
            if (!id || seen.has(id)) continue;
            const hit = relationOf(record, parcel, options);
            if (!hit) continue;
            seen.add(id);
            out.push(Object.assign({ proposal: record, proposalId: id }, hit));
        }
        const rank = entry => (entry.relation === 'bound' ? 0 : 1);
        out.sort((a, b) => (rank(a) - rank(b)) || ((b.overlapM2 || 0) - (a.overlapM2 || 0)));
        return out;
    }

    // ── per-parcel effect ────────────────────────────────────────────────────────────────────

    // Shortest distance (m) from any vertex of `clip` to the parcel's outline.
    function touchesOutline(t, clip, parcelFeature) {
        let outline = null;
        try { outline = t.polygonToLine(parcelFeature); } catch (_) { return false; }
        const lines = outline && outline.type === 'FeatureCollection' ? outline.features : [outline];
        let touching = false;
        try {
            t.coordEach(clip, coord => {
                if (touching) return;
                for (const line of lines) {
                    if (t.pointToLineDistance(t.point(coord), line, { units: 'meters' }) <= EDGE_TOUCH_M) {
                        touching = true;
                        return;
                    }
                }
            });
        } catch (_) { return false; }
        return touching;
    }

    // 'whole' | 'edge' | 'part' | 'none', or null when the proposal's ground is unknown.
    function extentOf(t, clip, parcelFeature, takenM2, parcelM2) {
        if (takenM2 === null) return null;
        if (!(takenM2 >= MIN_OVERLAP_M2)) return 'none';
        if (finite(parcelM2) && parcelM2 > 0) {
            if (takenM2 / parcelM2 >= WHOLE_SHARE || parcelM2 - takenM2 < MIN_REMAINDER_M2) return 'whole';
            if (takenM2 / parcelM2 < EDGE_MAX_SHARE && clip && touchesOutline(t, clip, parcelFeature)) return 'edge';
        }
        return 'part';
    }

    function isBuildingRecord(record) {
        return BUILDING_GOALS.has(normalizeGoal(record && record.goal))
            || !!(record && (record.buildingProposal || record.building_proposal));
    }

    // Buildings of the record standing on the parcel. count 0 for a record that builds nothing;
    // null figures when a building record carries no building geometry or no height.
    function buildingsOn(t, record, parcelFeature) {
        const yieldApi = planYieldApi();
        const features = yieldApi ? yieldApi.buildingFeaturesOf(record) : [];
        if (!features.length) {
            return isBuildingRecord(record)
                ? { count: null, footprintM2: null, floorAreaM2: null, heightM: null, floors: null }
                : { count: 0, footprintM2: null, floorAreaM2: null, heightM: null, floors: null };
        }
        const bp = record.buildingProposal || record.building_proposal || null;
        let count = 0;
        let footprintM2 = 0;
        let floorAreaM2 = 0;
        let floorAreaKnown = true;
        const heights = [];
        const floors = [];
        for (const feature of features) {
            const clip = parcelFeature ? safeIntersect(t, feature, parcelFeature) : null;
            const clipM2 = areaOf(t, clip);
            if (clipM2 < MIN_OVERLAP_M2) continue;
            count += 1;
            footprintM2 += clipM2;
            const measured = yieldApi.measureBuilding(feature, bp);
            if (finite(measured.heightM)) heights.push(measured.heightM);
            if (finite(measured.floors)) {
                floors.push(measured.floors);
                floorAreaM2 += clipM2 * measured.floors;
            } else {
                floorAreaKnown = false;
            }
        }
        const range = list => (list.length ? { min: round(Math.min(...list), 1), max: round(Math.max(...list), 1) } : null);
        return {
            count,
            footprintM2: count ? round(footprintM2, 1) : null,
            floorAreaM2: count && floorAreaKnown ? round(floorAreaM2, 1) : null,
            heightM: range(heights),
            floors: range(floors)
        };
    }

    function structureOn(t, record, parcelFeature) {
        const sp = record && (record.structureProposal || record.structure_proposal);
        const goal = normalizeGoal(record && record.goal);
        const kindRaw = (sp && (sp.kind || sp.type)) || (STRUCTURE_KINDS.has(goal) ? goal : null);
        if (!kindRaw) return null;
        const kind = String(kindRaw).toLowerCase();
        const geometry = sp && asPolygonGeometry(sp.geometry);
        const clip = geometry && parcelFeature ? safeIntersect(t, featureOf(geometry), parcelFeature) : null;
        return { kind, areaM2: geometry ? round(areaOf(t, clip), 1) : null };
    }

    function defaultIsTrack(record) {
        const definition = record && record.roadProposal && record.roadProposal.definition;
        return !!((definition && definition.metadata && definition.metadata.isTrack === true)
            || (record && record.primaryType === 'Track'));
    }

    function corridorOn(record, clip, takenM2, options) {
        const goal = normalizeGoal(record && record.goal);
        const road = record && record.roadProposal;
        if (goal !== 'road-track' && !road) return null;
        const isTrack = typeof options.isTrack === 'function' ? options.isTrack(record) : defaultIsTrack(record);
        const definition = road && road.definition;
        return {
            kind: isTrack ? 'track' : 'road',
            areaM2: takenM2,
            widthM: num(definition && definition.width)
        };
    }

    // Readjustment / subdivision plots that stand on the parcel (the plots it becomes), largest
    // share first. Null for a record that is no readjustment.
    function plotsOn(t, record, parcelFeature) {
        const plan = record && record.reparcellization;
        if (!plan || !Array.isArray(plan.polygons)) return null;
        if (!parcelFeature) return null;
        const plots = [];
        plan.polygons.forEach((plot, index) => {
            const feature = plot && featureOf(plot.geometry);
            if (!feature) return;
            const clip = safeIntersect(t, feature, parcelFeature);
            const overlapM2 = areaOf(t, clip);
            if (overlapM2 < MIN_OVERLAP_M2) return;
            plots.push({
                number: index + 1,
                areaM2: round(num(plot.area) !== null ? num(plot.area) : areaOf(t, feature), 1),
                overlapM2: round(overlapM2, 1),
                owner: typeof plot.displayName === 'string' && plot.displayName.trim() ? plot.displayName.trim() : null
            });
        });
        plots.sort((a, b) => b.overlapM2 - a.overlapM2);
        return plots;
    }

    // What the formation cedes from this parcel and where its ownership goes: the published stamp
    // when present, else computed from geometry. Null for content that forms no ground.
    // `hasGround` false = neither the record's footprint nor the parcel is known, so a computed
    // flow would read "takes 0 m²" for what is really unmeasured.
    function ownershipOn(record, parcel, hasGround) {
        const flowApi = ownershipFlowApi();
        if (!flowApi) return null;
        const keys = parcelKeys(parcel);
        let flow = Array.isArray(record && record.ownershipFlow) ? record.ownershipFlow : null;
        if (!flow) {
            if (!flowApi.hasFormation(record && record.goal)) return null;
            const parcelFeature = featureOf(parcel.feature);
            if (!parcelFeature || !hasGround) return { cededM2: null, destination: flowApi.destinationForGoal(record.goal) };
            try {
                flow = flowApi.computeOwnershipFlow(record, Array.from(keys).map(id => ({ id, feature: parcelFeature })));
            } catch (_) { flow = null; }
            if (!flow) return { cededM2: null, destination: flowApi.destinationForGoal(record.goal) };
        }
        const mine = flow.filter(entry => entry && keys.has(String(entry.parcelId)));
        const ceded = mine.reduce((sum, entry) => sum + (num(entry.cededM2) || 0), 0);
        const destination = mine.map(entry => entry.destination).find(Boolean)
            || (flowApi.destinationForGoal(record && record.goal)) || null;
        if (!mine.length && !flowApi.hasFormation(record && record.goal)) return null;
        return { cededM2: round(ceded, 1), destination };
    }

    function offerOf(record, options) {
        const amount = num(record && record.offer) !== null ? num(record.offer) : num(record && record.budget);
        if (amount === null) return null;
        const share = num(options.areaShare);
        return {
            amount,
            currency: (record.offerCurrency || record.budgetCurrency || record.currency || null),
            parcelShare: share !== null && share >= 0 && share <= 1 ? amount * share : null
        };
    }

    function consentOf(record, parcel, relation, options) {
        const keys = parcelKeys(parcel);
        const declared = declaredIds(record);
        const accepted = new Set((Array.isArray(record.acceptedParcelIds) ? record.acceptedParcelIds : []).map(String));
        const channel = typeof options.channel === 'string' ? options.channel : null;
        let owners = null;
        const acceptances = record.ownerAcceptances && typeof record.ownerAcceptances === 'object' ? record.ownerAcceptances : null;
        if (acceptances) {
            for (const key of keys) {
                const entry = acceptances[key];
                const order = entry && Array.isArray(entry.ownerOrder) ? entry.ownerOrder : [];
                if (!order.length) continue;
                const yes = new Set(Array.isArray(entry.acceptedOwnerKeys) ? entry.acceptedOwnerKeys : []);
                owners = { accepted: order.filter(owner => yes.has(owner)).length, total: order.length };
                break;
            }
        }
        return {
            channel,
            // Only a binding asks the owner; a site that merely reaches in has no consent channel.
            needed: relation === 'intrudes' ? false : (channel ? channel === 'acceptance' : null),
            parcelAccepted: relation === 'bound' ? declared.some(id => keys.has(id) && accepted.has(id)) : null,
            owners,
            parcels: declared.length ? { accepted: declared.filter(id => accepted.has(id)).length, total: declared.length } : null
        };
    }

    function statusOf(record, options) {
        const lifecycle = typeof options.lifecycleKey === 'string' ? options.lifecycleKey : null;
        const executed = lifecycle === 'executed'
            || String(record.lifecycleStatus || record.status || '').toLowerCase() === 'executed';
        const minted = typeof options.isMinted === 'boolean' ? options.isMinted : record.isMinted === true;
        const published = !!(record.serverProposalId || record.server_proposal_id);
        return {
            key: executed ? 'executed' : (minted ? 'minted' : (published ? 'published' : 'local')),
            lifecycle
        };
    }

    /**
     * What one record does to the parcel.
     * @param {object} record
     * @param {{ id, cadastreIds?: string[], feature, areaM2?: number }} parcel
     * @param {{ turf?, channel?: string, areaShare?: number, lifecycleKey?: string, isMinted?: boolean,
     *   isTrack?: Function }} options  (channel = the dossier's consent channel for this parcel;
     *   areaShare = this parcel's share of the proposal's declared area, for the offer payout)
     */
    function parcelEffect(record, parcel, options) {
        const opts = options || {};
        const t = T(opts);
        if (!t) throw new Error('parcel-compare: turf is not available');
        const parcelFeature = featureOf(parcel && parcel.feature);
        const parcelM2 = finite(parcel && parcel.areaM2) && parcel.areaM2 > 0
            ? parcel.areaM2
            : (parcelFeature ? areaOf(t, parcelFeature) : null);
        const hit = relationOf(record, parcel, opts);
        const relation = hit ? hit.relation : 'none';
        const clip = hit ? hit.clip : null;
        // Ground taken: measured from geometry when both are known; a declared record with no
        // geometry has an unknown take (null), not zero.
        const hasGround = !!(parcelFeature && siteFeatureOf(record, parcel, opts));
        let takenM2 = null;
        if (clip) takenM2 = round(areaOf(t, clip), 1);
        else if (hit && hit.overlapM2 !== null) takenM2 = round(hit.overlapM2, 1);
        else if (hasGround) takenM2 = 0;
        return {
            proposalId: idOf(record),
            relation,
            take: {
                areaM2: takenM2,
                share: takenM2 !== null && finite(parcelM2) && parcelM2 > 0 ? round(Math.min(1, takenM2 / parcelM2), 4) : null,
                intrusionM: hit ? hit.intrusionM : null,
                extent: extentOf(t, clip, parcelFeature, takenM2, parcelM2)
            },
            buildings: buildingsOn(t, record, parcelFeature),
            structure: structureOn(t, record, parcelFeature),
            corridor: corridorOn(record, clip, takenM2, opts),
            plots: plotsOn(t, record, parcelFeature),
            ownership: ownershipOn(record, parcel, hasGround),
            offer: offerOf(record, opts),
            consent: consentOf(record, parcel, relation, opts),
            status: statusOf(record, opts),
            clip: clip ? clip.geometry : null
        };
    }

    // ── preview ──────────────────────────────────────────────────────────────────────────────

    function ringsOf(geometry) {
        const g = asPolygonGeometry(geometry);
        if (!g) return [];
        return g.type === 'Polygon' ? g.coordinates : g.coordinates.flat();
    }

    /**
     * A small SVG of the parcel's outline with each layer's geometry drawn over it, in a local
     * equirectangular frame (north up, metres to scale). layers: [{ geometry, className }].
     * Returns '' when the parcel has no geometry.
     */
    function previewSvg(parcelGeometry, layers, options) {
        const opts = options || {};
        const size = finite(opts.size) ? opts.size : 160;
        const pad = finite(opts.pad) ? opts.pad : 6;
        const parcelRings = ringsOf(parcelGeometry);
        if (!parcelRings.length) return '';
        let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
        parcelRings.forEach(ring => ring.forEach(([x, y]) => {
            minX = Math.min(minX, x); maxX = Math.max(maxX, x);
            minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        }));
        const kx = Math.cos(((minY + maxY) / 2) * Math.PI / 180);
        const spanX = Math.max((maxX - minX) * kx, 1e-12);
        const spanY = Math.max(maxY - minY, 1e-12);
        const scale = (size - 2 * pad) / Math.max(spanX, spanY);
        const offX = pad + ((size - 2 * pad) - spanX * scale) / 2;
        const offY = pad + ((size - 2 * pad) - spanY * scale) / 2;
        const project = ([x, y]) => `${round(offX + (x - minX) * kx * scale, 2)},${round(offY + (maxY - y) * scale, 2)}`;
        const pathOf = geometry => ringsOf(geometry)
            .map(ring => `M${ring.map(project).join('L')}Z`)
            .join('');
        const escapeAttr = value => String(value).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
        const label = opts.label ? ` role="img" aria-label="${escapeAttr(opts.label)}"` : ' aria-hidden="true"';
        const layerPaths = (Array.isArray(layers) ? layers : [])
            .filter(layer => layer && asPolygonGeometry(layer.geometry))
            .map(layer => `<path class="${escapeAttr(layer.className || '')}" d="${pathOf(layer.geometry)}" fill-rule="evenodd"/>`)
            .join('');
        return `<svg xmlns="http://www.w3.org/2000/svg" class="${escapeAttr(opts.className || 'parcel-compare-svg')}" viewBox="0 0 ${size} ${size}"${label}>`
            + `<path class="parcel-compare-svg__parcel" d="${pathOf(parcelGeometry)}" fill-rule="evenodd"/>`
            + layerPaths
            + `<path class="parcel-compare-svg__outline" d="${pathOf(parcelGeometry)}" fill="none"/>`
            + '</svg>';
    }

    return {
        MIN_OVERLAP_M2,
        relationOf,
        proposalsTouchingParcel,
        parcelEffect,
        previewSvg
    };
});
