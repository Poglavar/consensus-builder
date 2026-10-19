// Screen PLUTO candidates and require cited, input-bound site reviews before
// publishing parcel-specific capacity. A clean tax-lot record is only a candidate.
import { createHash } from 'node:crypto';
import { getDistrictRules, RULE_VERSION } from './districts.js';

export const REVIEW_REQUIREMENTS = Object.freeze({
    zoningMap: 'Verify the entire legal lot is R6A with no overlays, special/limited-height districts or MIH requirements.',
    zoningLotAndRights: 'Verify this BBL is the entire zoning lot and has its full standard residential entitlement; review mergers, transfers, easements and restrictive declarations.',
    survey: 'Verify a rectangular interior zoning lot, dimensions, one legal street frontage and a horizontal established base plane from survey evidence.',
    streetAndBlock: 'Verify legal street width and line, no sidewalk widening, no lot portion within 100 feet of a street corner, and no frontage on the short dimension of a block.',
    geographicRestrictions: 'Verify no landmark/historic, waterfront, flood, environmental or other site-specific restriction affecting this path.',
    districtAdjacency: 'Verify no R1–R5 district boundary, public-park modification or transportation-infrastructure-adjacent frontage affecting the lot.',
    siteActions: 'Review DOB/BSA/CPC actions and recorded agreements for site-specific or vested bulk controls.',
    residentialScenario: 'Verify applicability of full-site new attached multifamily standard residences, with a full-width street wall on the street line and the ordinary bulk rules.',
});

const finitePositive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;

export function inputFingerprint(pluto) {
    const canonical = Object.fromEntries(Object.keys(pluto).sort().map(key => [key, pluto[key] ?? null]));
    return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export function screenPluto(pluto) {
    const issues = [];
    const add = (code, message, kind = 'exclusion') => issues.push({ code, message, kind });
    if (!getDistrictRules(pluto.zonedist1)) add('district', 'The first tier covers R6A only.');
    if (pluto.communityDistrict !== '303' || pluto.borough !== 'BK' || !pluto.bbl?.startsWith('3')) add('geography', 'The first pilot covers Brooklyn Community District 3 only.');
    if (!/^[1-5]\d{9}$/.test(pluto.bbl ?? '')) add('bbl', 'A valid tax-lot identity is required.', 'missing-data');
    if (!pluto.version) add('source-version', 'The PLUTO source version is missing.', 'missing-data');
    if (pluto.splitZone !== false) add('split-zone', pluto.splitZone === true ? 'PLUTO marks split zoning.' : 'The split-zone flag is unknown.', pluto.splitZone === true ? 'exclusion' : 'missing-data');
    if ([pluto.zonedist2, pluto.zonedist3, pluto.zonedist4].some(Boolean)) add('multiple-districts', 'PLUTO reports more than one zoning district.');
    for (const [code, fields, message] of [
        ['overlay', ['overlay1', 'overlay2'], 'PLUTO reports a commercial overlay.'],
        ['special-district', ['spdist1', 'spdist2', 'spdist3'], 'PLUTO reports a special district.'],
        ['limited-height', ['limitedHeight'], 'PLUTO reports a limited-height district.'],
        ['historic', ['historicDistrict', 'landmark'], 'PLUTO reports historic or landmark protection.'],
        ['environmental', ['eDesignation'], 'PLUTO reports an environmental designation.'],
    ]) if (fields.some(field => pluto[field])) add(code, message);
    if (pluto.flood2007 === true || pluto.flood2015 === true) add('flood', 'PLUTO flags a flood-hazard area.');
    if (pluto.lotType !== '5') add('lot-type', 'The pilot requires PLUTO interior-lot type 5.', pluto.lotType ? 'exclusion' : 'missing-data');
    if (pluto.irregularLot !== false) add('irregular-lot', 'A known regular-lot flag is required.', pluto.irregularLot === true ? 'exclusion' : 'missing-data');
    if (![pluto.lotArea, pluto.lotFront, pluto.lotDepth].every(finitePositive)) {
        add('dimensions-missing', 'Positive area, frontage and depth are required.', 'missing-data');
    } else {
        if (pluto.lotArea < 1700 || pluto.lotFront < 18 || pluto.lotFront >= 40 || pluto.lotDepth < 95 || pluto.lotDepth > 110) {
            add('dimensions-outside-tier', 'Pilot scope: area at least 1,700 sq ft, width 18–under 40 ft, depth 95–110 ft.');
        }
        if (Math.abs(pluto.lotFront * pluto.lotDepth - pluto.lotArea) / pluto.lotArea > 0.01) {
            add('dimension-conflict', 'PLUTO area differs from frontage × depth by more than 1%; survey review is required.', 'missing-data');
        }
    }
    if (pluto.residFar !== 3) add('far-conflict', 'PLUTO residential FAR does not match the R6A standard rule of 3.0.', 'missing-data');
    return { status: issues.some(i => i.kind === 'exclusion') ? 'excluded' : issues.length ? 'needs-data' : 'candidate', issues };
}

// Reviews are curated server-side records, never values taken from request input.
// checkedOn/validThrough are reviewer-specified dates; expiry invalidates the review.
export function validateReview(pluto, review, { asOf = new Date().toISOString().slice(0, 10) } = {}) {
    const missing = [];
    if (!review || review.bbl !== pluto.bbl || review.ruleVersion !== RULE_VERSION || review.inputFingerprint !== inputFingerprint(pluto)) {
        return { valid: false, issues: ['No site review matches this BBL, rule version and PLUTO snapshot.'], pending: Object.keys(REVIEW_REQUIREMENTS) };
    }
    const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
        && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
    if (!validDate(review.checkedOn) || !validDate(review.validThrough) || review.checkedOn > asOf || review.validThrough < asOf || review.validThrough < review.checkedOn) {
        missing.push('The site review is undated, expired or future-dated.');
    }
    const pending = Object.keys(REVIEW_REQUIREMENTS).filter(key => {
        const check = review.checks?.[key];
        return check?.status !== 'verified' || typeof check.note !== 'string' || !check.note.trim() || !Array.isArray(check.sources) || !check.sources.length
            || check.sources.some(source => typeof source !== 'string' || !/^https:\/\/[^\s/]+\/\S+/.test(source));
    });
    const site = review.site;
    if (!site || ![site.widthFt, site.depthFt, site.streetWidthFt].every(finitePositive)
        || site.widthFt < 18 || site.widthFt >= 40 || site.depthFt < 95 || site.depthFt > 110
        || site.widthFt * site.depthFt < 1700) {
        missing.push('Reviewed dimensions or legal street width are missing or outside the pilot.');
    } else if (Math.abs(site.widthFt * site.depthFt - pluto.lotArea) / pluto.lotArea > 0.01
        || Math.abs(site.widthFt - pluto.lotFront) > 0.5 || Math.abs(site.depthFt - pluto.lotDepth) > 0.5) {
        missing.push('Reviewed dimensions conflict with the bound PLUTO snapshot.');
    }
    return { valid: !pending.length && !missing.length, issues: missing, pending };
}
