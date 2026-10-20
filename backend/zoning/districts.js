// Versioned standard-residence rules for the first NYC bulk-envelope path.
// District membership alone never establishes that a parcel can use these rules.
export const RULE_VERSION = 'r6a-interior-2026-10-19';
export const RULE_CHECKED_ON = '2026-10-19';
export const RULE_SOURCES = Object.freeze([
    ['12-10', 'Zoning lot, base plane and street-width definitions', 'article-i/chapter-2'],
    ['23-12', 'Minimum lot dimensions'],
    ['23-22', 'Standard residential FAR'],
    ['23-335', 'Side yards'],
    ['23-342', 'Rear yards'],
    ['23-344', 'Rear yard modifications near corners and short block frontages'],
    ['23-362', 'Lot coverage'],
    ['23-431', 'Street wall location'],
    ['23-432', 'Base and building heights'],
    ['23-433', 'Upper-story setbacks'],
    ['23-436', 'Additional height and setback provisions'],
    ['23-443', 'Transportation frontage, limited heights and district boundaries'],
].map(([section, title, chapter = 'article-ii/chapter-3']) => Object.freeze({
    section, title, url: `https://zoningresolution.planning.nyc.gov/${chapter}/${section}`,
})));

const R6A = Object.freeze({
    code: 'R6A', residentialFar: 3,
    minLotAreaSqFt: 1700, minLotWidthFt: 18,
    minBaseHeightFt: 40, maxBaseHeightFt: 65, maxBuildingHeightFt: 75,
    rearYardFt: 30, maxLotCoverage: 0.8,
    narrowStreetSetbackFt: 15, wideStreetSetbackFt: 10,
    wideStreetMinWidthFt: 75,
});

export function normalizeDistrictCode(code) {
    return typeof code === 'string' ? code.trim().toUpperCase() : '';
}

export function getDistrictRules(code) {
    return normalizeDistrictCode(code) === 'R6A' ? { ...R6A } : null;
}

export const SUPPORTED_DISTRICTS = Object.freeze(['R6A']);
