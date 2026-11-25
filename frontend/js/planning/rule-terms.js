// Relative rule terms: limits a rule states against what already stands rather than as a number
// ("the existing height plus one storey", "twice the existing footprint", "at least half the
// undeveloped ground kept", "no taller than the street's tallest neighbour", "2.5 × the street
// width"). A constraint carries its term as `term` and gets its `value` from the parcel's existing
// context; an input that is not known makes the value unknown (null), never a number from a default.
// Pure: no DOM, no network; the same code runs in the browser, in node (MCP) and in tests.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.PlanningRuleTerms = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';
    const finite = value => typeof value === 'number' && Number.isFinite(value);
    // Building heights a rule may rely on: surveyed or tagged heights and stated storey counts
    // (building-extrusion.js resolveBuildingHeight). An `estimated` height is a display default.
    const KNOWN_HEIGHT_SOURCES = Object.freeze(['measured', 'levels']);
    const extrusion = () => typeof window !== 'undefined' && window.BuildingExtrusion ? window.BuildingExtrusion : require('../building-extrusion.js');
    // A building record's height as evidence: { heightM, known, source }. `heightM` is null unless known.
    // A 3D record states its basis (`height_source`); a footprint entry (`height_m`, `floors`, as
    // footprint-provider.js answers /buildings/under) gets it from the same height resolver.
    function buildingHeight(record) {
        const props = record?.properties || record || {};
        let source = props.height_source ?? props.heightSource ?? null;
        let value = finite(props.heightM) ? props.heightM : finite(props.height) ? props.height : null;
        if (!source && ('height_m' in props || 'floors' in props)) {
            const resolved = extrusion().resolveBuildingHeight({ id: String(record?.id ?? props.id ?? ''), heightM: props.height_m, levels: props.floors });
            source = resolved.source; value = resolved.heightM;
        }
        const known = KNOWN_HEIGHT_SOURCES.includes(source) && finite(value) && value > 0;
        return { heightM: known ? value : null, known, source: source || 'missing' };
    }
    const maxOf = values => values.reduce((a, b) => Math.max(a, b), -Infinity);
    function quantile(values, q) {
        const sorted = [...values].sort((a, b) => a - b), at = (sorted.length - 1) * q, low = Math.floor(at);
        return sorted[low] + (sorted[Math.min(low + 1, sorted.length - 1)] - sorted[low]) * (at - low);
    }

    // The existing context of one parcel, from evidence the caller read:
    //   parcel: Feature<Polygon|MultiPolygon>;
    //   buildings: the existing building records on it (GeoJSON features with height_source), or
    //     null when no building source answered (then every term about them is unknown);
    //   street: { widthM, source } from the street-width measure (backend/planning/street-width.js), or null;
    //   neighbours: building records along the same street, or null when not read.
    // Areas are the buildings' footprints within the parcel.
    function existingContext({ parcel, buildings = null, street = null, neighbours = null, geometryOps: ops }) {
        if (!ops) throw new TypeError('An existing context needs geometry operations.');
        const parcelAreaM2 = parcel ? ops.area(parcel) : null;
        const records = Array.isArray(buildings) ? buildings.map(record => {
            let footprintM2 = null;
            try {
                const inside = parcel ? ops.intersect(ops.feature(record.geometry), parcel) : ops.feature(record.geometry);
                footprintM2 = inside ? ops.area(inside) : 0;
            } catch (_) { footprintM2 = null; }
            return { id: String(record.id ?? record.properties?.id ?? ''), footprintM2, ...buildingHeight(record) };
        }).filter(record => record.footprintM2 === null || record.footprintM2 > 0) : null;
        const footprintM2 = records && records.every(record => finite(record.footprintM2))
            ? records.reduce((sum, record) => sum + record.footprintM2, 0) : null;
        const heightKnown = Boolean(records) && records.every(record => record.known);
        return {
            parcelAreaM2,
            buildings: records,
            footprintM2,
            // The parcel's ground no building stands on (the "undeveloped" or natural ground).
            naturalGroundM2: finite(parcelAreaM2) && finite(footprintM2) ? Math.max(0, parcelAreaM2 - footprintM2) : null,
            // The tallest existing building; none standing is a known 0 m.
            heightM: heightKnown ? (records.length ? maxOf(records.map(record => record.heightM)) : 0) : null,
            street: { widthM: finite(street?.widthM) ? street.widthM : null, source: street?.source ?? null },
            neighbours: Array.isArray(neighbours) ? neighbours.map(record => ({ id: String(record.id ?? record.properties?.id ?? ''), ...buildingHeight(record) })) : null
        };
    }

    // The inputs a term may stand on. Each returns { value } or { value: null, reason }.
    const inputs = {
        existingHeight: context => finite(context.heightM) ? { value: context.heightM } : { value: null, reason: 'existing-height-unknown' },
        existingFootprint: context => finite(context.footprintM2) ? { value: context.footprintM2 } : { value: null, reason: 'existing-buildings-unknown' },
        existingNaturalGround: context => finite(context.naturalGroundM2) ? { value: context.naturalGroundM2 } : { value: null, reason: 'existing-buildings-unknown' },
        parcelArea: context => finite(context.parcelAreaM2) ? { value: context.parcelAreaM2 } : { value: null, reason: 'parcel-unknown' },
        streetWidth: context => finite(context.street?.widthM) ? { value: context.street.widthM } : { value: null, reason: 'street-width-unknown' },
        // Precedent over the street's neighbours: `aggregate` max, min or median of their heights,
        // or `share-above` (the share taller than `aboveM`). One unknown height makes it unknown.
        neighbourHeight: (context, term) => {
            const list = context.neighbours;
            if (!Array.isArray(list) || !list.length) return { value: null, reason: 'neighbours-unknown' };
            if (list.some(neighbour => !neighbour.known)) return { value: null, reason: 'neighbour-height-unknown' };
            const heights = list.map(neighbour => neighbour.heightM);
            if (term.aggregate === 'max') return { value: maxOf(heights) };
            if (term.aggregate === 'min') return { value: Math.min(...heights) };
            if (term.aggregate === 'median') return { value: quantile(heights, 0.5) };
            if (term.aggregate === 'share-above' && finite(term.aboveM)) return { value: heights.filter(height => height > term.aboveM).length / heights.length };
            throw new Error(`Unknown neighbour aggregate: ${term.aggregate}`);
        }
    };
    const OF = Object.freeze(Object.keys(inputs));

    // A term's value: (input + add) × times, `add` in metres or in storeys (`addUnit: "storeys"`,
    // counted at `storeyHeightM`). Returns { value, known, reason? }.
    function evaluate(term, context, { storeyHeightM = null } = {}) {
        const input = inputs[term?.of];
        if (!input) throw new Error(`Unknown rule term input: ${term?.of}`);
        const base = input(context || {}, term);
        if (!finite(base.value)) return { value: null, known: false, reason: base.reason };
        let add = finite(term.add) ? term.add : 0;
        if (term.addUnit === 'storeys') {
            if (!finite(storeyHeightM) || storeyHeightM <= 0) return { value: null, known: false, reason: 'storey-height-unknown' };
            add *= storeyHeightM;
        }
        const times = finite(term.times) ? term.times : 1;
        return { value: (base.value + add) * times, known: true };
    }
    // Whether a constraint's `when` holds: a term compared with `atLeast` / `atMost`. True, false,
    // or null when its input is unknown.
    function holds(when, context, options) {
        if (!when) return true;
        const result = evaluate(when, context, options);
        if (!result.known) return null;
        return (!finite(when.atLeast) || result.value >= when.atLeast) && (!finite(when.atMost) || result.value <= when.atMost);
    }
    // Constraints with their relative terms resolved against one context. A resolved term becomes
    // a `derived` value; an unknown one keeps `value: null` with `evidence: "unknown"` and the reason;
    // a constraint whose `when` does not hold is dropped. Constraints without a term pass unchanged.
    function resolve(constraints, context, options = {}) {
        const out = [];
        for (const constraint of constraints || []) {
            if (!constraint?.term && !constraint?.when) { out.push(constraint); continue; }
            const applies = holds(constraint.when, context, options);
            if (applies === false) continue;
            if (applies === null) { out.push({ ...constraint, value: null, evidence: 'unknown', unknownReason: evaluate(constraint.when, context, options).reason }); continue; }
            if (!constraint.term) { out.push(constraint); continue; }
            const result = evaluate(constraint.term, context, options);
            out.push(result.known ? { ...constraint, value: result.value, evidence: 'derived' }
                : { ...constraint, value: null, evidence: 'unknown', unknownReason: result.reason });
        }
        return out;
    }
    return { KNOWN_HEIGHT_SOURCES, OF, buildingHeight, existingContext, evaluate, holds, resolve };
});
