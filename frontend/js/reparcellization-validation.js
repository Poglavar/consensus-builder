// Shared LR design, allocation and approval-readiness checks. Pure authored records in; no map or ownership lookup.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ReparcellizationValidation = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';
    const ownership = () => root.ReparcellizationOwnership
        || (typeof require === 'function' ? require('./reparcellization-ownership.js') : null);
    const deal = () => root.ReparcellizationDeal
        || (typeof require === 'function' ? require('./reparcellization-deal.js') : null);
    const approval = () => root.ProposalApproval
        || (typeof require === 'function' ? require('./proposals/approval.js') : null);
    const finite = value => typeof value === 'number' && Number.isFinite(value);
    const feature = geometry => ({ type: 'Feature', properties: {}, geometry });
    // Match the fabric's absolute plus one-part-per-million conservation budget. Overlap is
    // checked separately, so a gap and an overlapping plot cannot cancel each other numerically.
    const coverageTolerance = area => 1 + area * 1e-6;
    const overlapTolerance = area => Math.min(coverageTolerance(area), Math.max(0.01, area * 1e-6));

    function polygon(value, turf) {
        const geometry = value?.type === 'Feature' ? value.geometry : value;
        if (!geometry || !['Polygon', 'MultiPolygon'].includes(geometry.type)) throw new Error('Use polygon geometry.');
        const parts = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
        if (!Array.isArray(parts) || !parts.length) throw new Error('Polygon geometry is empty.');
        let vertices = 0;
        const polygons = parts.map(rings => {
            if (!Array.isArray(rings) || !rings.length) throw new Error('Polygon rings are missing.');
            for (const ring of rings) {
                if (!Array.isArray(ring) || ring.length < 4 || (vertices += ring.length) > 100000
                    || ring.some(point => !Array.isArray(point) || point.length < 2 || !point.every(finite)
                        || Math.abs(point[0]) > 180 || Math.abs(point[1]) > 90)
                    || ring[0].length !== ring[ring.length - 1].length
                    || ring[0].some((n, i) => n !== ring[ring.length - 1][i])
                    || new Set(ring.slice(0, -1).map(point => `${point[0]},${point[1]}`)).size < 3) {
                    throw new Error('Rings need at least three distinct vertices and closed, finite longitude/latitude coordinates.');
                }
            }
            const part = feature({ type: 'Polygon', coordinates: rings });
            if (turf.kinks(part).features.length) throw new Error('Polygon boundaries intersect themselves.');
            const shell = feature({ type: 'Polygon', coordinates: [rings[0]] });
            const holes = rings.slice(1).map(ring => feature({ type: 'Polygon', coordinates: [ring] }));
            for (let i = 0; i < holes.length; i++) {
                const outside = turf.difference(holes[i], shell);
                if (outside && turf.area(outside) > 0.01) throw new Error('A hole lies outside its polygon.');
                for (let j = 0; j < i; j++) {
                    const hit = turf.intersect(holes[i], holes[j]);
                    if (hit && turf.area(hit) > 0.01) throw new Error('Polygon holes overlap.');
                }
            }
            if (!(turf.area(part) > 0)) throw new Error('A polygon must have positive area.');
            return part;
        });
        for (let i = 0; i < polygons.length; i++) for (let j = 0; j < i; j++) {
            const hit = turf.intersect(polygons[i], polygons[j]);
            if (hit && turf.area(hit) > 0.01) throw new Error('Parts of a polygon overlap.');
        }
        return feature(geometry);
    }

    function validate(proposal, options = {}) {
        const errors = [], warnings = [];
        const issue = (code, message, section, extra = {}) => errors.push({ code, message, section, ...extra });
        const plan = proposal?.reparcellization || {};
        const turf = options.turf || root.turf;
        const metrics = { poolAreaM2: null, plotAreaM2: null, uncoveredAreaM2: null, outsideAreaM2: null, overlapAreaM2: null };
        const plots = Array.isArray(plan.polygons) ? plan.polygons : [];
        const normalizedOwnership = [];
        const areas = [];
        const shapes = [];
        if (!plots.length) issue('missing-polygons', 'Add at least one new parcel.', 'geometry');
        if (plots.length > 1000) issue('too-many-polygons', 'Use at most 1,000 new parcels in one readjustment.', 'geometry');
        if (!turf || ['area', 'intersect', 'difference', 'union', 'kinks'].some(key => typeof turf[key] !== 'function')) {
            issue('geometry-unavailable', 'Geometry validation is unavailable. Try again after the map loads.', 'geometry');
        } else if (plots.length && plots.length <= 1000) {
            plots.forEach((plot, index) => {
                try { const shape = polygon(plot?.geometry, turf); shapes[index] = shape; areas[index] = turf.area(shape); }
                catch (error) { issue('invalid-polygon', `New parcel ${index + 1}: ${error.message}`, 'geometry', { plotIndex: index }); }
            });
            if (!errors.length) {
                try {
                    let union = null, overlapAreaM2 = 0;
                    for (let i = 0; i < shapes.length; i++) {
                        if (union) {
                            const hit = turf.intersect(union, shapes[i]);
                            const area = hit ? turf.area(hit) : 0;
                            overlapAreaM2 += area;
                            if (area > overlapTolerance(areas[i])) issue('overlapping-polygons', `New parcel ${i + 1} overlaps another new parcel.`, 'geometry', { plotIndex: i, areaM2: area });
                        }
                        union = union ? turf.union(union, shapes[i]) : shapes[i];
                        if (!union) throw new Error('The new parcel union could not be computed.');
                    }
                    // A saved pool is the proposed take, not the union of whole cadastral inputs.
                    // Without a declared pool, the authored plots define the take; outside source
                    // land remains with its owners. Site subdivisions always tile their explicit site.
                    const rawPool = plan.poolSource === 'site' ? (options.site || proposal.site || plan.poolGeometry)
                        : (options.site || plan.poolGeometry);
                    const pool = rawPool ? polygon(rawPool, turf) : union;
                    const area = turf.area(pool);
                    const gap = turf.difference(pool, union), outside = turf.difference(union, pool);
                    Object.assign(metrics, { poolAreaM2: area, plotAreaM2: areas.reduce((a, b) => a + b, 0),
                        uncoveredAreaM2: gap ? turf.area(gap) : 0, outsideAreaM2: outside ? turf.area(outside) : 0, overlapAreaM2 });
                    if (metrics.uncoveredAreaM2 > coverageTolerance(area)) issue('coverage-gap', 'The new parcels leave part of the declared pool uncovered.', 'geometry', { areaM2: metrics.uncoveredAreaM2 });
                    if (metrics.outsideAreaM2 > coverageTolerance(area)) issue('coverage-excess', 'The new parcels extend outside the declared pool.', 'geometry', { areaM2: metrics.outsideAreaM2 });
                    // Connectivity follows the intended pool. Tiny numerical seams between new
                    // neighbours are handled by the conservation budget, not a separate UI rule.
                    if (pool.geometry.type === 'MultiPolygon' && pool.geometry.coordinates.length > 1) {
                        issue('disconnected-readjustment', 'Use a separate readjustment for each disconnected pool.', 'geometry');
                    }
                } catch (error) { issue('invalid-pool', `The readjustment pool could not be validated: ${error.message}`, 'geometry'); }
            }
        }
        plots.forEach((plot, index) => {
            try { normalizedOwnership[index] = ownership().shapeSliceOwnership(plot, proposal); }
            catch (error) { issue('invalid-allocation', `New parcel ${index + 1}: ${error.message}`, 'allocation', { plotIndex: index }); }
        });
        let totalCashCents = null;
        let money = null;
        if (!errors.some(item => item.section === 'allocation')) {
            try {
                const content = deal().content(proposal);
                totalCashCents = content?.terms.totalCashCents ?? null;
                money = content ? deal().schedule(content) : null;
                for (const row of content?.ledger || []) {
                    if (['contributedArea', 'contributedValue', 'entitledValue', 'assignedArea', 'assignedValue']
                        .some(key => row[key] !== null && row[key] < 0)) throw new Error('Areas and allocation values cannot be negative.');
                }
                if (content?.valuation.poolUnitValue !== null && content?.valuation.poolUnitValue < 0) throw new Error('Unit value cannot be negative.');
            } catch (error) { issue('invalid-readjustment-deal', error.message, 'money'); }
        }
        let rightsReady = false;
        try {
            const rights = approval().inspect(proposal);
            rightsReady = rights.ready && (rights.context.policy.type !== 'threshold' || rights.parcels.every(row => row.areaM2 !== null));
            if (!rightsReady) warnings.push({ code: 'ownership-unresolved', section: 'approval', message: 'Design can be saved. Owner approval needs complete parcel rights and the areas required by its policy.' });
        } catch (error) { issue('invalid-proposal-approval', error.message, 'approval'); }
        const valid = errors.length === 0;
        // This is the existing local simulation's funding flag. It is never evidence of on-chain
        // escrow. Unspecified funding cannot execute a positive cash obligation. Only the sponsor's
        // share needs funding beforehand; owner payments are signed terms settled with the payouts.
        const fundingReady = !!money && (money.sponsorFundingCents === 0 || proposal?.funded === true);
        return { valid, errors, warnings, metrics, normalizedOwnership, areas, totalCashCents, money,
            rightsReady, readyForApproval: valid && rightsReady, fundingReady };
    }
    // An editor has a per-owner ledger before it has a proposal offer field. Derive the latter
    // exactly as publication does, so editing an allocation never validates an obsolete dialog sum.
    function validatePlan(plan, fields = {}, options = {}) {
        let offer = 0;
        try { offer = (plan?.ownerShares || []).reduce((sum, owner) => sum + deal().moneyCents(owner.cashOffer ?? 0), 0) / 100; }
        catch (_) { /* validate reports the malformed ledger itself below. */ }
        return validate({ ...fields, goal: 'reparcellization', reparcellization: plan, offer, offerCurrency: 'EUR' }, options);
    }
    return { validate, validatePlan, polygon, coverageTolerance, overlapTolerance };
});
