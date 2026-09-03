// proposals/plan-yield.js — what a plan actually yields: parcels, floor area, apartments, people,
// per epoch.
//
// The plan is drawn as geometry, but the question asked of it is arithmetic: how much floor area did
// those blocks add, how many homes is that, how many people live in them. This file is the one place
// that arithmetic lives, so the stats dialog, a report and a command-line run cannot quietly disagree
// about it.
//
// Pure: proposals in, numbers out. No DOM, no map, no turf — areas are computed here from the
// GeoJSON, which is what lets a node test (and backend/scripts/plan-yield.js) run the same code the
// browser runs. Accepts BOTH shapes a proposal comes in: the client's camelCase `buildingProposal`
// and the server row's snake_case `building_proposal`.
//
// A measurement that is missing stays missing. A building with no height is counted and reported as
// unmeasured rather than given an invented storey count, because a plausible-looking floor area is
// far more expensive than an obviously absent one.
(function (global) {
    'use strict';

    // Same radius and the same ring formula turf.area uses, so a figure here and a figure measured
    // with turf elsewhere in the app agree to the digit rather than "roughly".
    const EARTH_RADIUS_M = 6378137;

    const DEFAULTS = Object.freeze({
        // Only ever used when neither the building nor its urban rule states one.
        floorHeightM: 3.0,
        // Net internal area as a share of gross floor area: stairs, lifts, walls, plant.
        efficiency: 0.8,
        // Share of floor area that is housing; the rest is counted as workplace.
        housingShare: 0.75,
        // Net m² of an average apartment.
        avgApartmentM2: 65,
        // People per apartment. Croatian census households run ~2,4 persons.
        personsPerApartment: 2.4,
        // Net m² of workplace per job.
        m2PerJob: 30
    });

    const OPEN_SPACE_KINDS = Object.freeze(['park', 'square', 'lake']);

    /** A number or null — never NaN, and never a 0 conjured out of null by Number(). */
    function num(value) {
        if (value === null || value === undefined || value === '') return null;
        const n = Number(value);
        return Number.isFinite(n) ? n : null;
    }

    function positive(value) {
        const n = num(value);
        return (n !== null && n > 0) ? n : null;
    }

    const rad = deg => (deg * Math.PI) / 180;

    // Geodesic area of one lon/lat ring, signed. Signed matters: a hole winds the other way, so
    // subtracting |hole| would be wrong for a ring whose winding the source did not normalise —
    // taking the absolute value only at the end of a polygon handles both conventions.
    function ringAreaM2(ring) {
        if (!Array.isArray(ring) || ring.length < 4) return 0;
        let total = 0;
        const n = ring.length;
        for (let i = 0; i < n; i += 1) {
            const p1 = ring[(i - 1 + n) % n];
            const p2 = ring[i];
            const p3 = ring[(i + 1) % n];
            if (!Array.isArray(p1) || !Array.isArray(p2) || !Array.isArray(p3)) continue;
            const lon1 = num(p1[0]);
            const lat2 = num(p2[1]);
            const lon3 = num(p3[0]);
            if (lon1 === null || lat2 === null || lon3 === null) continue;
            total += (rad(lon3) - rad(lon1)) * Math.sin(rad(lat2));
        }
        return (total * EARTH_RADIUS_M * EARTH_RADIUS_M) / 2;
    }

    function polygonRingsAreaM2(rings) {
        if (!Array.isArray(rings) || !rings.length) return 0;
        const outer = Math.abs(ringAreaM2(rings[0]));
        let holes = 0;
        for (let i = 1; i < rings.length; i += 1) holes += Math.abs(ringAreaM2(rings[i]));
        return Math.max(0, outer - holes);
    }

    /** Area in m² of a Polygon/MultiPolygon geometry (or a Feature wrapping one). 0 for anything else. */
    function geometryAreaM2(input) {
        if (!input || typeof input !== 'object') return 0;
        const geometry = input.type === 'Feature' ? input.geometry : input;
        if (!geometry || !Array.isArray(geometry.coordinates)) return 0;
        if (geometry.type === 'Polygon') return polygonRingsAreaM2(geometry.coordinates);
        if (geometry.type === 'MultiPolygon') {
            return geometry.coordinates.reduce((sum, rings) => sum + polygonRingsAreaM2(rings), 0);
        }
        return 0;
    }

    function buildingProposalOf(proposal) {
        if (!proposal || typeof proposal !== 'object') return null;
        const bp = proposal.buildingProposal || proposal.building_proposal;
        return (bp && typeof bp === 'object') ? bp : null;
    }

    function structureProposalOf(proposal) {
        if (!proposal || typeof proposal !== 'object') return null;
        const sp = proposal.structureProposal || proposal.structure_proposal;
        return (sp && typeof sp === 'object') ? sp : null;
    }

    /**
     * Every building feature a proposal carries. The generator writes plain features into
     * `buildings`; an older client shape wrapped each in `{ feature }`, and `geometry.buildings` is
     * the cache the map fills in — accept all three rather than making the caller guess.
     */
    function buildingFeaturesOf(proposal) {
        const bp = buildingProposalOf(proposal);
        const lists = [
            proposal && proposal.geometry && proposal.geometry.buildings,
            bp && bp.buildings
        ];
        for (const list of lists) {
            if (!Array.isArray(list) || !list.length) continue;
            const features = list
                .map(entry => (entry && entry.feature ? entry.feature : entry))
                .filter(feature => feature && feature.geometry);
            if (features.length) return features;
        }
        return [];
    }

    /** The urban rule behind a building, whether it is stamped on the feature or on the proposal. */
    function ruleOf(feature, bp) {
        const onFeature = feature && feature.properties && feature.properties.urbanRule;
        if (onFeature && typeof onFeature === 'object') return onFeature;
        const onProposal = bp && bp.parameters && bp.parameters.rule;
        return (onProposal && typeof onProposal === 'object') ? onProposal : null;
    }

    /**
     * How tall this building is, in metres, or null when nothing says.
     * A rule with a min and a max is a band the generator picked a height inside, so the band's
     * midpoint is the honest reading of it when the built feature itself did not record one.
     */
    function heightMetresOf(feature, rule) {
        const props = (feature && feature.properties) || {};
        const direct = positive(props.height) ?? positive(props.heightM) ?? positive(props.HEIGHT);
        if (direct !== null) return direct;

        const floorHeight = positive(props.floorHeightM) ?? positive(rule && rule.floorHeightM);
        const floors = positive(props.floors) ?? positive(props.storeys) ?? positive(props.katova);
        if (floors !== null && floorHeight !== null) return floors * floorHeight;

        const min = positive(rule && rule.minHeightM);
        const max = positive(rule && rule.maxHeightM);
        if (min !== null && max !== null) return (min + max) / 2;
        return max ?? min;
    }

    /**
     * One building measured. `gfaM2` is null — not 0 — when the height is unknown, so a caller that
     * sums it has to decide what to do about that instead of silently averaging in a zero.
     */
    function measureBuilding(feature, bp, assumptions) {
        const opts = { ...DEFAULTS, ...(assumptions || {}) };
        const footprintM2 = geometryAreaM2(feature);
        const rule = ruleOf(feature, bp);
        const heightM = heightMetresOf(feature, rule);
        const floorHeightM = positive(rule && rule.floorHeightM)
            ?? positive(feature && feature.properties && feature.properties.floorHeightM)
            ?? positive(opts.floorHeightM)
            ?? DEFAULTS.floorHeightM;

        if (heightM === null) {
            return { footprintM2, heightM: null, floorHeightM, floors: null, gfaM2: null, rule };
        }
        const floors = Math.max(1, Math.round(heightM / floorHeightM));
        return { footprintM2, heightM, floorHeightM, floors, gfaM2: footprintM2 * floors, rule };
    }

    function emptyBucket(year) {
        return {
            year: year === undefined ? null : year,
            proposals: 0,
            ruleProposals: 0,
            freeformProposals: 0,
            buildings: 0,
            unmeasuredBuildings: 0,
            footprintM2: 0,
            grossFloorAreaM2: 0,
            housingFloorAreaM2: 0,
            housingNetM2: 0,
            apartments: 0,
            people: 0,
            workFloorAreaM2: 0,
            workNetM2: 0,
            jobs: 0,
            openSpaces: 0,
            openSpaceM2: 0
        };
    }

    function addInto(target, source) {
        Object.keys(target).forEach(key => {
            if (key === 'year') return;
            target[key] += source[key] || 0;
        });
        return target;
    }

    /** Derived figures — computed once from the summed floor area, never accumulated per building. */
    function deriveBucket(bucket, opts) {
        const housingShare = Math.min(1, Math.max(0, num(opts.housingShare) ?? DEFAULTS.housingShare));
        const efficiency = Math.min(1, Math.max(0, num(opts.efficiency) ?? DEFAULTS.efficiency));
        const avgApartmentM2 = positive(opts.avgApartmentM2) ?? DEFAULTS.avgApartmentM2;
        const personsPerApartment = positive(opts.personsPerApartment) ?? DEFAULTS.personsPerApartment;
        const m2PerJob = positive(opts.m2PerJob) ?? DEFAULTS.m2PerJob;

        bucket.housingFloorAreaM2 = bucket.grossFloorAreaM2 * housingShare;
        bucket.workFloorAreaM2 = bucket.grossFloorAreaM2 * (1 - housingShare);
        bucket.housingNetM2 = bucket.housingFloorAreaM2 * efficiency;
        bucket.workNetM2 = bucket.workFloorAreaM2 * efficiency;
        bucket.apartments = Math.floor(bucket.housingNetM2 / avgApartmentM2);
        bucket.people = Math.round(bucket.apartments * personsPerApartment);
        bucket.jobs = Math.floor(bucket.workNetM2 / m2PerJob);
        return bucket;
    }

    function epochYearOf(proposal) {
        if (!proposal || typeof proposal !== 'object') return null;
        const raw = proposal.epochYear ?? proposal.epoch_year;
        const n = num(raw);
        return (n !== null && Number.isInteger(n)) ? n : null;
    }

    /** True when a proposal is part of the built plan rather than a draft sitting beside it. */
    function isApplied(proposal) {
        if (!proposal || typeof proposal !== 'object') return false;
        return proposal.applied === true;
    }

    /** One proposal's contribution, before any per-epoch grouping. */
    function measureProposal(proposal, assumptions) {
        const opts = { ...DEFAULTS, ...(assumptions || {}) };
        const bucket = emptyBucket(epochYearOf(proposal));
        bucket.proposals = 1;

        const bp = buildingProposalOf(proposal);
        const features = buildingFeaturesOf(proposal);
        let ruleDriven = false;

        features.forEach(feature => {
            const measured = measureBuilding(feature, bp, opts);
            bucket.buildings += 1;
            bucket.footprintM2 += measured.footprintM2;
            if (measured.gfaM2 === null) bucket.unmeasuredBuildings += 1;
            else bucket.grossFloorAreaM2 += measured.gfaM2;
            if (measured.rule) ruleDriven = true;
        });

        if (features.length) {
            if (ruleDriven) bucket.ruleProposals = 1;
            else bucket.freeformProposals = 1;
        }

        const sp = structureProposalOf(proposal);
        const kind = sp && sp.kind ? String(sp.kind).toLowerCase() : null;
        if (kind && OPEN_SPACE_KINDS.includes(kind)) {
            bucket.openSpaces = 1;
            bucket.openSpaceM2 = geometryAreaM2(sp.geometry);
        }

        return bucket;
    }

    /**
     * The whole plan.
     *
     * `byEpoch` is what each period ADDS; `cumulative` is what stands once that period is finished,
     * which is the figure a timeline wants. Proposals with no epoch are the plan's existing state —
     * they belong to every cumulative year, exactly as epoch.js's belongsCumulative() reads them.
     *
     * @param {Array} proposals raw proposals, either client- or server-shaped
     * @param {Object} [assumptions] overrides of DEFAULTS, plus { appliedOnly:boolean }
     */
    function planYield(proposals, assumptions) {
        const opts = { ...DEFAULTS, ...(assumptions || {}) };
        const list = (Array.isArray(proposals) ? proposals : [])
            .filter(p => p && typeof p === 'object')
            .filter(p => (opts.appliedOnly ? isApplied(p) : true));

        const total = emptyBucket(null);
        const byYear = new Map();
        const unassigned = emptyBucket(null);

        list.forEach(proposal => {
            const measured = measureProposal(proposal, opts);
            addInto(total, measured);
            const year = measured.year;
            if (year === null) {
                addInto(unassigned, measured);
                return;
            }
            if (!byYear.has(year)) byYear.set(year, emptyBucket(year));
            addInto(byYear.get(year), measured);
        });

        const years = [...byYear.keys()].sort((a, b) => a - b);
        const byEpoch = years.map(year => deriveBucket(byYear.get(year), opts));

        const cumulative = [];
        const running = emptyBucket(null);
        addInto(running, unassigned);
        years.forEach(year => {
            addInto(running, byYear.get(year));
            const snapshot = emptyBucket(year);
            cumulative.push(deriveBucket(addInto(snapshot, running), opts));
        });

        return {
            assumptions: {
                floorHeightM: opts.floorHeightM,
                efficiency: opts.efficiency,
                housingShare: opts.housingShare,
                avgApartmentM2: opts.avgApartmentM2,
                personsPerApartment: opts.personsPerApartment,
                m2PerJob: opts.m2PerJob
            },
            total: deriveBucket(total, opts),
            unassigned: deriveBucket(unassigned, opts),
            byEpoch,
            cumulative
        };
    }

    /**
     * The same result under different assumptions, without measuring anything again.
     *
     * Every figure the dialog's inputs move — apartments, people, jobs, the housing split — follows
     * from grossFloorAreaM2, which does not. So a changed apartment size re-runs the derivation and
     * nothing else. It goes through the SAME deriveBucket as planYield, so the two cannot drift:
     * rederive(planYield(list, A), B) is planYield(list, B).
     */
    function rederive(result, assumptions) {
        const opts = { ...DEFAULTS, ...(assumptions || {}) };
        const again = bucket => deriveBucket({ ...bucket }, opts);
        if (!result || typeof result !== 'object') return planYield([], opts);
        return {
            assumptions: {
                floorHeightM: opts.floorHeightM,
                efficiency: opts.efficiency,
                housingShare: opts.housingShare,
                avgApartmentM2: opts.avgApartmentM2,
                personsPerApartment: opts.personsPerApartment,
                m2PerJob: opts.m2PerJob
            },
            total: again(result.total),
            unassigned: again(result.unassigned),
            byEpoch: (result.byEpoch || []).map(again),
            cumulative: (result.cumulative || []).map(again)
        };
    }

    // ── The parcels a plan leaves standing ──────────────────────────────────────────────────────
    //
    // A proposal is an authored instruction. It knows its immutable cadastral scope, but it does
    // not know which live parcel pieces a particular application produced. Those pieces belong to
    // LiveParcelFabric and may legitimately differ after the same proposal is rebased onto another
    // current plan. Callers that need the materialized answer therefore pass an explicit fabric
    // snapshot; this pure module never reads saved parent/child ids from proposal records.

    function pushIds(target, list) {
        if (!Array.isArray(list)) return;
        list.forEach(id => {
            if (id === undefined || id === null) return;
            const text = String(id).trim();
            if (text) target.add(text);
        });
    }

    /** The one durable land declaration carried by a canonical proposal. */
    function cadastreIdsOf(proposal) {
        const ids = new Set();
        if (!proposal || typeof proposal !== 'object') return [];
        pushIds(ids, proposal.cadastreParcelIds);
        return [...ids];
    }

    function featureParcelId(feature) {
        const props = feature && feature.properties || {};
        const value = props.parcelId ?? props.id;
        return value === undefined || value === null ? '' : String(value).trim();
    }

    function featureCadastreIds(feature) {
        const ids = new Set();
        pushIds(ids, feature && feature.properties && feature.properties.cadastreParcelIds);
        return [...ids];
    }

    /**
     * @returns {{resulting: string[], produced: string[], consumed: string[], builtOn: string[],
     *            cadastre: string[], materialized: boolean}}
     *          `resulting` is the explicit live-fabric snapshot when supplied. With no snapshot,
     *          it is the proposal set's cadastral scope and `materialized` is false.
     */
    function resultingParcels(proposals, options) {
        const opts = options || {};
        const list = (Array.isArray(proposals) ? proposals : [])
            .filter(p => p && typeof p === 'object')
            .filter(p => (opts.appliedOnly ? isApplied(p) : true));

        const cadastre = new Set();
        list.forEach(proposal => cadastreIdsOf(proposal).forEach(id => cadastre.add(id)));

        if (!Array.isArray(opts.materializedFeatures)) {
            return {
                resulting: [...cadastre],
                produced: [],
                consumed: [],
                builtOn: [...cadastre],
                cadastre: [...cadastre],
                materialized: false
            };
        }

        const resulting = new Set();
        const produced = new Set();
        const coveredCadastre = new Set();
        opts.materializedFeatures.forEach(feature => {
            const id = featureParcelId(feature);
            const anchors = featureCadastreIds(feature).filter(anchor => cadastre.has(anchor));
            if (!id || !anchors.length) return;
            resulting.add(id);
            anchors.forEach(anchor => coveredCadastre.add(anchor));
            const props = feature.properties || {};
            const isOriginal = anchors.length === 1 && anchors[0] === id
                && !String(props.producedByProposalId || '').trim();
            if (!isOriginal) produced.add(id);
        });

        // An absent live entry is not evidence that land vanished. This can happen while a caller
        // is still hydrating cadastral ground. Keep that cadastral parcel in the result rather than
        // manufacturing a generated id.
        cadastre.forEach(id => {
            if (!coveredCadastre.has(id)) resulting.add(id);
        });

        const builtOn = new Set([...cadastre].filter(id => resulting.has(id)));
        const consumed = new Set([...cadastre].filter(id => !resulting.has(id)));

        return {
            resulting: [...resulting],
            produced: [...produced],
            consumed: [...consumed],
            builtOn: [...builtOn],
            cadastre: [...cadastre],
            materialized: true
        };
    }

    const api = {
        DEFAULTS,
        OPEN_SPACE_KINDS,
        ringAreaM2,
        geometryAreaM2,
        buildingFeaturesOf,
        heightMetresOf,
        measureBuilding,
        measureProposal,
        epochYearOf,
        planYield,
        rederive,
        cadastreIdsOf,
        resultingParcels
    };

    // Namespaced only — a bare global here could shadow a top-level function in the classic scripts
    // loaded alongside this file.
    if (typeof window !== 'undefined') window.__planYield = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
