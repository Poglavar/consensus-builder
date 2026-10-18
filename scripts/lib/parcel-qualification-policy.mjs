// Share the initial parcel-availability threshold and retain every unresolved quality check.
import fs from 'node:fs';
export const qualificationPolicy = JSON.parse(fs.readFileSync(new URL('./parcel-qualification-policy.json', import.meta.url), 'utf8'));
export const REQUIRED_CHECKS = qualificationPolicy.requiredChecks;
export function initialQualificationReview(checks, failures = {}) {
    const followUp = qualificationPolicy.followUpChecks.filter(key => checks?.[key]?.passed !== true).map(check => ({
        check, reason: checks?.[check]?.reason || failures?.[check]?.message || failures?.[check]?.error
            || 'Not established during initial qualification; investigate in the second pass.'
    }));
    return { policy: qualificationPolicy.id, passed: REQUIRED_CHECKS.every(key => checks?.[key]?.passed === true),
        requiredChecks: [...REQUIRED_CHECKS], status: followUp.length ? 'follow-up-required' : 'no-open-findings', followUp };
}

export function hasUsableGeographicPolygons(features) {
    if (!Array.isArray(features) || features.length === 0) return false;
    const usableRing = ring => Array.isArray(ring) && ring.length >= 4 && ring.every(point => Array.isArray(point) && point.length >= 2
        && Number.isFinite(point[0]) && Number.isFinite(point[1]) && point[0] >= -180 && point[0] <= 180
        && point[1] >= -90 && point[1] <= 90) && JSON.stringify(ring[0]) === JSON.stringify(ring.at(-1));
    let hasArea = false;
    const valid = features.every(feature => {
        const { type, coordinates } = feature?.geometry || {};
        const polygons = type === 'Polygon' ? [coordinates] : type === 'MultiPolygon' ? coordinates : [];
        if (Array.isArray(polygons)) for (const polygon of polygons) {
            const ring = polygon?.[0];
            if (!usableRing(ring)) continue;
            const anchor = ring[0], other = ring.find(p => p[0] !== anchor[0] || p[1] !== anchor[1]) || anchor;
            hasArea ||= ring.some(p => (other[0] - anchor[0]) * (p[1] - anchor[1]) !== (other[1] - anchor[1]) * (p[0] - anchor[0]));
        }
        return Array.isArray(polygons) && polygons.length > 0 && polygons.every(polygon => Array.isArray(polygon) && polygon.length > 0 && polygon.every(usableRing));
    });
    return valid && hasArea;
}

