// Use the same authored LR validation as the editor and apply/consent paths, then recompute
// display areas/percentages from geometry. Source ownership evidence is an approval prerequisite,
// not a requirement to publish a geometric design with abstract recipients.

import * as turf from '@turf/turf';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const readjustmentDeal = require('../../frontend/js/reparcellization-deal.js');
const readjustmentValidation = require('../../frontend/js/reparcellization-validation.js');

export function validateReadjustmentProposal(proposal) {
    return readjustmentValidation.validate(proposal, { turf });
}

// Compute from the normalized authored record, never trust the uploader's effectHash. This is a
// content commitment plus structural allocation/cash validation, not a funding or title attestation.
export function readjustmentDealFingerprint(proposal) {
    return readjustmentDeal.fingerprint(proposal);
}

// Recompute area/percent for each polygon from its geometry, and decide whether the client's stated
// layout is valid. Area percentages are derived display values, not ownership title shares.
// Returns a NEW object with shared validation evidence, or null if no layout was supplied.
export function validateReparcellizationShares(reparcellization, proposal = null) {
    if (!reparcellization || !Array.isArray(reparcellization.polygons) || reparcellization.polygons.length === 0) {
        return null;
    }
    const result = proposal ? validateReadjustmentProposal({ ...proposal, reparcellization })
        : readjustmentValidation.validatePlan(reparcellization, {}, { turf });
    const measured = result.areas.filter(area => typeof area === 'number' && Number.isFinite(area));
    const computedTotalArea = measured.length === reparcellization.polygons.length
        ? measured.reduce((sum, area) => sum + area, 0) : null;
    const recomputed = reparcellization.polygons.map((p, i) => {
        const area = result.areas[i] ?? null;
        const truePercent = area !== null && computedTotalArea > 0 ? (area / computedTotalArea) * 100 : null;
        return { ...p, area: area === null ? null : Math.round(area), percent: truePercent === null ? null : Number(truePercent.toFixed(2)) };
    });

    return {
        ...reparcellization,
        polygons: recomputed,
        totalArea: computedTotalArea === null ? null : Math.round(computedTotalArea),
        validated: result.valid,
        validation: { valid: result.valid, errors: result.errors, warnings: result.warnings, metrics: result.metrics },
        source: 'server'
    };
}

// Optional pre-submit check: POST /reparcellization/validate { reparcellization } → the validated
// object. Lets the editor warn before the user commits, without going through proposal creation.
export function setupReparcellizationRoute(app) {
    app.post('/reparcellization/validate', (req, res) => {
        try {
            const validated = validateReparcellizationShares(req.body && req.body.reparcellization,
                req.body?.proposal ? { ...req.body.proposal, goal: 'reparcellization' } : null);
            if (!validated) {
                return res.status(400).json({ error: 'reparcellization with polygons[] is required' });
            }
            res.json(validated);
        } catch (err) {
            console.error('Error in POST /reparcellization/validate:', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    });
}
