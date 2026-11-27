// proposals/plan-decision.js — the decision-sheet figures of Compare plans (plan-stats.js) that MCP
// ugt_compare (backend/agents/mcp-compare.js) reads by the same rules: built form (tallest new
// building, site coverage, floor-area ratio), road and green area, the totals of what a plan
// demolishes, its build-out periods in brief, its Permitted-limit verdict and the agreements backing
// it. Pure: features and records in, figures out; geometry operations (turf) come from the caller.
// A figure that cannot be measured is null with its reason, never 0. window.__planDecision.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__planDecision = api;
})(typeof window !== 'undefined' ? window : null, function (root) {
    'use strict';

    const finite = value => typeof value === 'number' && Number.isFinite(value);
    const yieldApi = () => (root && root.__planYield) || require('./plan-yield.js');
    const densityApi = () => (root && root.BuildingDensityStats) || require('../building-density-stats.js');

    const asFeature = geometry => (geometry && geometry.type === 'Feature' ? geometry : geometry ? { type: 'Feature', properties: {}, geometry } : null);
    function unionOf(turf, features) {
        return features.reduce((out, feature) => (out ? turf.union(out, feature) || out : feature), null);
    }
    function clippedArea(turf, feature, land) {
        if (!feature) return 0;
        if (!land) return turf.area(feature);
        const part = turf.intersect(feature, land);
        return part ? turf.area(part) : 0;
    }

    /**
     * Road and green area of designs (records or design/v1 contents): the union of their road
     * corridors' polygons, and of their parks. On `land` (a Feature), the part on it. Square metres;
     * 0 when the plan has none (a known nothing), which is MCP's areas rule too.
     */
    function roadAndGreen(designs, { turf, land = null } = {}) {
        const green = [], roads = [];
        for (const design of designs || []) {
            const structure = design?.structureProposal;
            if (structure?.kind === 'park' && structure.geometry) green.push(asFeature(structure.geometry));
            const polygon = design?.roadProposal?.definition?.polygon;
            if (polygon) roads.push(asFeature(polygon));
        }
        return { roadAreaM2: roads.length ? clippedArea(turf, unionOf(turf, roads), land) : 0,
            greenAreaM2: green.length ? clippedArea(turf, unionOf(turf, green), land) : 0 };
    }

    /**
     * The built form of a plan: its tallest new building (height and storeys by plan-yield's rules),
     * and over its land the site coverage of every building standing after it (building-density-stats
     * summarizeDensity: the union of their footprints ÷ the land) and the floor-area ratio (the gross
     * floor area standing ÷ the land, the GFA row's own number). records: the plan's designs;
     * standing: the existing building records it leaves. Without land the ratios are null.
     */
    function builtForm({ records = [], standing = [], landFeature = null, grossFloorAreaM2 = null, turf } = {}) {
        const plan = yieldApi();
        let maxHeightM = null, maxStoreys = null, unmeasured = 0, buildings = 0;
        for (const record of records) {
            const bp = record?.buildingProposal || null;
            for (const feature of plan.buildingFeaturesOf(record)) {
                buildings += 1;
                const measured = plan.measureBuilding(feature, bp, {});
                if (!finite(measured.heightM)) { unmeasured += 1; continue; }
                // A mansard's roof holds a storey, so the building is as tall as its roof.
                const topM = finite(measured.topHeightM) ? measured.topHeightM : measured.heightM;
                if (maxHeightM === null || topM > maxHeightM) maxHeightM = topM;
                if (finite(measured.floors) && (maxStoreys === null || measured.floors > maxStoreys)) maxStoreys = measured.floors;
            }
        }
        const landAreaM2 = landFeature ? turf.area(landFeature) : null;
        let siteCoveragePercent = null;
        if (landFeature && landAreaM2 > 0) {
            const features = [...records, ...standing].flatMap(record => plan.buildingFeaturesOf(record));
            siteCoveragePercent = features.length
                ? densityApi().summarizeDensity({ parcelFeature: landFeature, buildings: features, turf }).siteCoveragePercent
                : 0;
        }
        return { buildings, unmeasuredBuildings: unmeasured, maxHeightM, maxStoreys, landAreaM2, siteCoveragePercent,
            floorAreaRatio: finite(landAreaM2) && landAreaM2 > 0 && finite(grossFloorAreaM2) ? grossFloorAreaM2 / landAreaM2 : null };
    }

    /**
     * What a plan demolishes, from one row per existing building it takes: { whole, footprintM2,
     * floorAreaM2 } (whole: gone, else cut; the footprint and floor area it loses; floorAreaM2 null when
     * the source states no height). The removed floor area is null while any is unknown (unmeasured
     * counts those). The rows are MCP's demolition records or Plan stats' cleared buildings.
     */
    function demolitionTotals(rows) {
        let buildingsRemoved = 0, buildingsCut = 0, removedFootprintM2 = 0, floorArea = 0, unmeasured = 0;
        for (const row of rows || []) {
            if (row.whole) buildingsRemoved += 1; else buildingsCut += 1;
            removedFootprintM2 += finite(row.footprintM2) ? row.footprintM2 : 0;
            if (finite(row.floorAreaM2)) floorArea += row.floorAreaM2; else unmeasured += 1;
        }
        return { buildingsRemoved, buildingsCut, removedFootprintM2, removedFloorAreaM2: unmeasured ? null : floorArea, unmeasured };
    }

    /**
     * Plan stats' cleared buildings ({ before, after } records, PresentState.clearanceSplit) as
     * demolition rows: the footprint and floor area each loses, by plan-yield's rules.
     */
    function clearedRows(cleared, assumptions = {}) {
        const plan = yieldApi();
        return (cleared || []).map(({ before, after }) => {
            const was = plan.planYield([before], assumptions).total;
            const left = after ? plan.planYield([after], assumptions).total : null;
            const footprintM2 = plan.buildingFeaturesOf(before).reduce((sum, feature) => sum + plan.geometryAreaM2(feature), 0)
                - (after ? plan.buildingFeaturesOf(after).reduce((sum, feature) => sum + plan.geometryAreaM2(feature), 0) : 0);
            return { whole: !after, footprintM2: Math.max(0, footprintM2),
                floorAreaM2: was.unmeasuredBuildings > 0 ? null : was.grossFloorAreaM2 - (left ? left.grossFloorAreaM2 : 0) };
        });
    }

    /**
     * A plan's build-out in brief, from plan-yield's periods: { first, last, periods, unscheduled }
     * (years; unscheduled designs), or null when no member is scheduled.
     */
    function periodSummary(result) {
        const years = (result?.byPeriod || []).map(bucket => bucket.year).filter(finite);
        if (!years.length) return null;
        return { first: Math.min(...years), last: Math.max(...years), periods: years.length,
            unscheduled: result.unassigned?.proposals || 0 };
    }

    /**
     * A plan's new buildings as the Permitted check takes them: { id, footprint, heightM, floors,
     * floorAreaM2 } by plan-yield's rules (floorAreaM2 null without a height). id: `<design>#<n>`.
     */
    function permittedBuildings(records) {
        const plan = yieldApi();
        return (records || []).flatMap((record, recordIndex) => plan.buildingFeaturesOf(record).map((feature, index) => {
            const measured = plan.measureBuilding(feature, record?.buildingProposal || null, {});
            return { id: `${record?.proposalId ?? `design-${recordIndex}`}#${index}`, footprint: feature,
                heightM: finite(measured.topHeightM) ? measured.topHeightM : finite(measured.heightM) ? measured.heightM : null, floors: finite(measured.floors) ? measured.floors : null,
                floorAreaM2: finite(measured.gfaM2) ? measured.gfaM2 : null };
        }));
    }

    /**
     * The buildings a plan's Permitted check (planning/permitted-check.js check) finds over the limits:
     * { state, buildings, breaking, breakingFloorAreaM2, conditional, unknown }. state 'none' (no
     * Permitted item under any building: no source here), 'unavailable' (the source could not be
     * read), 'breaks', 'unclear' (none fails, some conditional or unknown) or 'within'.
     * floorAreaOf(id) gives a building's gross floor area, null when unknown; the failing floor area
     * is null while any failing building's is unknown.
     */
    function permittedSummary(result, floorAreaOf = () => null) {
        const status = result?.status || 'none';
        if (status === 'unavailable') return { state: 'unavailable' };
        const byBuilding = result?.buildings || {};
        const ids = Object.keys(byBuilding);
        let breaking = 0, conditional = 0, unknown = 0, floorArea = 0, floorUnknown = false;
        for (const id of ids) {
            const value = byBuilding[id];
            if (value === 'fail') {
                breaking += 1;
                const area = floorAreaOf(id);
                if (finite(area)) floorArea += area; else floorUnknown = true;
            } else if (value === 'conditional') conditional += 1;
            else if (value === 'unknown') unknown += 1;
        }
        if (status === 'none' || ids.every(id => byBuilding[id] === 'none')) return { state: 'none', buildings: ids.length };
        return { state: breaking ? 'breaks' : conditional || unknown ? 'unclear' : 'within', buildings: ids.length,
            breaking, breakingFloorAreaM2: floorUnknown ? null : floorArea, conditional, unknown };
    }

    // An index row ({ cid, content, onchain, status }) or a stored agreement, as the Backing block reads it.
    function backingOf(row) {
        const content = row?.content && row.content.rule ? row.content : row || {};
        const rule = content.rule || {};
        const lenses = (Array.isArray(rule.lens) ? rule.lens : []).map(entry => (entry && typeof entry === 'object' ? entry.address : entry)).filter(Boolean);
        const crowdfunding = rule.electorate === 'investors';
        return {
            cid: row?.cid || row?.published?.cid || null,
            title: content.title || row?.title || null,
            electorate: rule.electorate || null,
            binding: rule.binding === true,
            stage: row?.onchain ? 'minted' : (row?.cid || row?.published) ? 'published' : 'draft',
            indexStatus: row?.onchain?.status || null,
            cluster: row?.onchain?.cluster || null,
            account: row?.onchain?.account || null,
            crowdfunding,
            lead: crowdfunding ? content.sponsor || null : null,
            lenses: crowdfunding ? lenses : [],
            lensThreshold: crowdfunding ? (lenses.length ? (rule.lensThreshold ?? 1) : 0) : null,
            targetUsdcAtomic: crowdfunding && content.funding?.targetUsdcAtomic ? String(content.funding.targetUsdcAtomic) : null,
            deadline: content.deadline || null
        };
    }

    // Comma-separated values for a table of text: quoted where a cell holds a comma, quote or line
    // break (RFC 4180), lines joined by CRLF.
    function csvOf(rows) {
        const cell = value => {
            const text = value === null || value === undefined ? '' : String(value);
            return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
        };
        return rows.map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
    }

    return { roadAndGreen, builtForm, demolitionTotals, clearedRows, periodSummary, permittedBuildings, permittedSummary, backingOf, csvOf };
});
