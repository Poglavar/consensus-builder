// Publish a reviewed standard bulk envelope only after eligibility is established.
// Unreviewed lots expose rule references and missing evidence, without capacity numbers.
import { getDistrictRules, RULE_VERSION, RULE_CHECKED_ON, RULE_SOURCES } from './districts.js';
import { inputFingerprint, screenPluto, validateReview, REVIEW_REQUIREMENTS } from './eligibility.js';
import { calculateR6aEnvelope } from './r6a-geometry.js';

export function computeEnvelope(pluto, review = null, options = {}) {
    if (!pluto) return null;
    const screening = screenPluto(pluto);
    const verification = validateReview(pluto, review, options);
    const publicScreen = options.publicScreen ?? null;
    const modeled = screening.status === 'candidate' && verification.valid && !publicScreen?.flags?.length;
    return {
        schemaVersion: 2,
        status: modeled ? 'modeled' : screening.status === 'excluded' ? 'outside-scope' : 'needs-review',
        scenario: 'New attached multifamily standard residences; full-site redevelopment',
        ruleVersion: RULE_VERSION,
        ruleCheckedOn: RULE_CHECKED_ON,
        source: { dataset: 'NYC DCP PLUTO', version: pluto.version, inputFingerprint: inputFingerprint(pluto) },
        district: pluto.zonedist1,
        screening,
        publicScreen,
        review: {
            valid: modeled,
            issues: verification.issues,
            pending: verification.pending.map(code => ({ code, requirement: REVIEW_REQUIREMENTS[code] })),
            checkedOn: modeled ? review.checkedOn : null,
            validThrough: modeled ? review.validThrough : null,
            checks: modeled ? review.checks : null,
        },
        referenceRules: getDistrictRules(pluto.zonedist1),
        ruleSources: RULE_SOURCES,
        result: modeled ? calculateR6aEnvelope(review.site) : null,
    };
}
