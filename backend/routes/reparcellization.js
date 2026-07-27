// Server-side validation of a reparcellization plan's land shares. The client draws the child
// polygons and stamps each with a `percent` (who gets how much land) + a `totalArea`; the server
// used to store those numbers unverified — a client could persist shares that don't match the
// geometry it drew. Because the child polygons are stored inline, this is a PURE turf recompute (no
// DB, any city): re-derive each polygon's area and its true percent from the geometry, overwrite the
// stored numbers with the geometry-truth, and flag `validated: false` when the client's claimed
// percents diverged (a bug, drift, or tampering).

import * as turf from '@turf/turf';

const PERCENT_TOLERANCE = 1.0; // percentage points — allow small rounding drift

function polygonArea(geometry) {
    if (!geometry || typeof geometry !== 'object') return 0;
    try {
        const feature = geometry.type === 'Feature'
            ? geometry
            : { type: 'Feature', properties: {}, geometry };
        return turf.area(feature);
    } catch (_) {
        return 0;
    }
}

// Recompute area/percent for each polygon from its geometry, and decide whether the client's stated
// shares agree. Returns a NEW reparcellization object (polygons' area/percent + totalArea overwritten
// with the geometry-truth) plus `validated` / `source`, or null if there is nothing to validate.
export function validateReparcellizationShares(reparcellization) {
    if (!reparcellization || !Array.isArray(reparcellization.polygons) || reparcellization.polygons.length === 0) {
        return null;
    }
    const polygons = reparcellization.polygons;
    const areas = polygons.map(p => polygonArea(p.geometry));
    const computedTotalArea = areas.reduce((sum, a) => sum + a, 0);

    let validated = computedTotalArea > 0;
    let claimedPercentSum = 0;

    const recomputed = polygons.map((p, i) => {
        const area = areas[i];
        const truePercent = computedTotalArea > 0 ? (area / computedTotalArea) * 100 : 0;
        const claimed = Number(p.percent) || 0;
        claimedPercentSum += claimed;
        if (Math.abs(claimed - truePercent) > PERCENT_TOLERANCE) {
            validated = false; // this polygon's stated share doesn't match its geometry
        }
        return { ...p, area: Math.round(area), percent: Number(truePercent.toFixed(2)) };
    });

    // The stated shares must also add up to ~100%.
    if (Math.abs(claimedPercentSum - 100) > PERCENT_TOLERANCE) {
        validated = false;
    }

    return {
        ...reparcellization,
        polygons: recomputed,
        totalArea: Math.round(computedTotalArea),
        validated,
        source: 'server'
    };
}

// Optional pre-submit check: POST /reparcellization/validate { reparcellization } → the validated
// object. Lets the editor warn before the user commits, without going through proposal creation.
export function setupReparcellizationRoute(app) {
    app.post('/reparcellization/validate', (req, res) => {
        try {
            const validated = validateReparcellizationShares(req.body && req.body.reparcellization);
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
