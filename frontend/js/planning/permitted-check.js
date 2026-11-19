// Rule check: compares a design's buildings with the Permitted items they stand on (zones or parcel
// results of planning-representations.v1) and says, rule by rule, whether each limit is kept. This
// checks a given design; it never searches for the largest allowed one (that is the envelope
// solver's job). Pure: geometry operations (turf 6) are passed in. Used by the editors and by tests.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.PermittedCheck = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';
    const FOOT_M = 0.3048, ACRE_M2 = 4046.8564224;
    // Measurements within this of a limit pass: a slider in whole metres must be able to sit on it.
    const TOLERANCE = 0.01;
    // A footprint touching a zone along a shared edge does not stand in it.
    const MIN_OVERLAP_M2 = 0.5;
    const finite = value => typeof value === 'number' && Number.isFinite(value);
    const lengthM = (value, unit) => !finite(value) ? null : unit === 'm' ? value : unit === 'ft' ? value * FOOT_M : null;
    const areaM2 = (value, unit) => !finite(value) ? null : unit === 'm2' ? value : unit === 'sqft' ? value * FOOT_M * FOOT_M
        : unit === 'acres' ? value * ACRE_M2 : null;
    // Worst first: one failed rule makes the design fail, an unmet condition outranks an unknown.
    const RANK = { fail: 4, conditional: 3, unknown: 2, pass: 1 };
    const worst = statuses => statuses.reduce((current, status) => (RANK[status] || 0) > (RANK[current] || 0) ? status : current, null);

    function itemGeometries(item) {
        const areas = (item?.areas || []).map(area => area?.geometry).filter(Boolean);
        return areas.length ? areas : item?.site ? [item.site] : [];
    }
    function overlapM2(geometry, footprint, ops) {
        try {
            const part = ops.intersect(ops.feature(geometry), footprint);
            return part ? ops.area(part) : 0;
        } catch (_) { return 0; }
    }
    // The Permitted items a footprint stands on, with the share of the footprint on each.
    // Bounding boxes of item geometries, kept per geometry object: a drag rechecks every frame.
    const boxes = new WeakMap();
    function boxOf(geometry, ops) {
        let box = boxes.get(geometry);
        if (!box) { box = ops.bbox(geometry); boxes.set(geometry, box); }
        return box;
    }
    const boxesMeet = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
    function itemsUnder(items, footprint, ops) {
        const footprintM2 = ops.area(footprint), footprintBox = ops.bbox(footprint);
        const found = [];
        for (const item of Array.isArray(items) ? items : []) {
            if (item?.role !== 'permitted') continue;
            const m2 = itemGeometries(item).filter(geometry => boxesMeet(boxOf(geometry, ops), footprintBox))
                .reduce((sum, geometry) => sum + overlapM2(geometry, footprint, ops), 0);
            if (m2 >= MIN_OVERLAP_M2) found.push({ item, overlapM2: m2, share: footprintM2 > 0 ? Math.min(1, m2 / footprintM2) : 0 });
        }
        return found;
    }
    const constraintOf = (item, quantity) => (item.constraints || []).find(constraint => constraint.quantity === quantity) || null;
    // A taller limit the source grants only on a condition (an incentive, an asterisked legend class).
    function conditionalHeight(item) {
        const conditional = item.metrics?.conditional;
        return conditional && finite(conditional.heightM) ? { heightM: conditional.heightM, condition: conditional.condition || null } : null;
    }
    function storeyHeightOf(item) {
        const value = item.sourceEvidence?.rules?.storeyHeightM ?? item.sourceEvidence?.interpretation?.storeyHeightM;
        return finite(value) && value > 0 ? value : null;
    }
    const USE_STATUS = { allowed: 'pass', prohibited: 'fail' };

    // One building against one item: a check per rule the item records that a single design can test.
    function buildingChecks(item, building) {
        const checks = [];
        const base = { itemId: item.id, title: item.title || null, sourceLabel: item.source?.label || null };
        const useStatus = item.assessment?.status;
        checks.push({ ...base, rule: 'use', status: USE_STATUS[useStatus] || 'unknown', treatment: useStatus || 'unknown',
            use: item.use?.label || null, useKey: item.use?.key || null,
            reason: item.assessment?.reason || null });
        const height = constraintOf(item, 'height');
        const limitM = height && height.bound === 'maximum' ? lengthM(height.value, height.unit) : null;
        const storeys = constraintOf(item, 'storeys');
        const storeyLimit = storeys && storeys.bound === 'maximum' && finite(storeys.value) ? storeys.value : null;
        if (finite(limitM) && finite(building.heightM)) {
            const extra = conditionalHeight(item);
            const over = building.heightM > limitM + TOLERANCE;
            const status = !over ? 'pass' : extra && building.heightM <= extra.heightM + TOLERANCE ? 'conditional' : 'fail';
            checks.push({ ...base, rule: 'height', status, measured: building.heightM, limit: limitM, unit: 'm',
                storeyLimit, conditionalLimit: extra?.heightM ?? null, condition: status === 'conditional' ? extra.condition : null });
        } else if (finite(storeyLimit)) {
            // Only a storey rule: count the design's storeys at the source's own storey height.
            const storeyHeight = storeyHeightOf(item);
            const measured = finite(building.floors) ? building.floors
                : finite(building.heightM) && storeyHeight ? Math.ceil(building.heightM / storeyHeight - TOLERANCE) : null;
            checks.push({ ...base, rule: 'storeys', status: measured === null ? 'unknown' : measured <= storeyLimit ? 'pass' : 'fail',
                measured, limit: storeyLimit, unit: 'count' });
        }
        return checks;
    }
    // The site against one item: the plot-wide ratios a source records (coverage, floor area ratio,
    // minimum lot). They need the plot the design is on; without one they are not checked.
    function siteChecks(item, site) {
        const checks = [];
        const base = { itemId: item.id, title: item.title || null, sourceLabel: item.source?.label || null };
        const plot = site?.plotAreaM2;
        if (!finite(plot) || plot <= 0) return checks;
        const coverage = constraintOf(item, 'coverage');
        if (coverage && coverage.unit === 'percent' && finite(coverage.value) && finite(site.footprintM2)) {
            const measured = 100 * site.footprintM2 / plot;
            checks.push({ ...base, rule: 'coverage', status: measured <= coverage.value + TOLERANCE ? 'pass' : 'fail', measured, limit: coverage.value, unit: 'percent' });
        }
        const ratio = constraintOf(item, 'floorAreaRatio');
        if (ratio && ratio.unit === 'ratio' && finite(ratio.value) && finite(site.floorAreaM2)) {
            const measured = site.floorAreaM2 / plot;
            checks.push({ ...base, rule: 'floorAreaRatio', status: measured <= ratio.value + TOLERANCE ? 'pass' : 'fail', measured, limit: ratio.value, unit: 'ratio' });
        }
        const lot = constraintOf(item, 'lotArea');
        const minimum = lot && lot.bound === 'minimum' ? areaM2(lot.value, lot.unit) : null;
        if (finite(minimum)) checks.push({ ...base, rule: 'lotArea', status: plot + TOLERANCE >= minimum ? 'pass' : 'fail', measured: plot, limit: minimum, unit: 'm2' });
        return checks;
    }
    // `buildings`: [{ id, footprint: Feature<Polygon|MultiPolygon>, heightM, floors? }].
    // `site`: { plotAreaM2, footprintM2, floorAreaM2 } of the land the design takes, or null.
    // Returns { status, checks, buildings: { [id]: status } }; status 'none' when no Permitted item
    // lies under any building (no source here, or not loaded).
    function check({ items, buildings, site = null, geometryOps }) {
        if (!geometryOps) throw new TypeError('A permitted check needs geometry operations.');
        const checks = [], byBuilding = {}, siteItems = new Map();
        for (const building of buildings || []) {
            if (!building?.footprint?.geometry) continue;
            const under = itemsUnder(items, building.footprint, geometryOps);
            const own = under.flatMap(({ item, share }) => buildingChecks(item, building).map(entry => ({ ...entry, buildingId: building.id, share })));
            byBuilding[building.id] = worst(own.map(entry => entry.status)) || 'none';
            checks.push(...own);
            for (const { item } of under) siteItems.set(item.id, item);
        }
        for (const item of siteItems.values()) checks.push(...siteChecks(item, site));
        return { status: worst(checks.map(entry => entry.status)) || 'none', checks, buildings: byBuilding };
    }
    // The checks a person needs to read: one per rule and item, worst building first, failures first.
    function summarize(result) {
        const seen = new Map();
        for (const entry of result?.checks || []) {
            const key = `${entry.itemId}|${entry.rule}`;
            const known = seen.get(key);
            const worse = !known || RANK[entry.status] > RANK[known.status]
                || (RANK[entry.status] === RANK[known.status] && finite(entry.measured) && entry.measured > (known.measured ?? -Infinity));
            if (worse) seen.set(key, entry);
        }
        return [...seen.values()].sort((a, b) => RANK[b.status] - RANK[a.status]);
    }
    return { check, summarize, itemsUnder, worst, lengthM, areaM2, TOLERANCE };
});
