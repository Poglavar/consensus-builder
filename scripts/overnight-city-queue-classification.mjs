export function normalizeName(input) {
    return String(input || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
        .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

export function nameVariants(input) {
    const source = String(input || '');
    const variants = [source, source.replace(/\s*\([^)]*\)/g, ''), ...[...source.matchAll(/\(([^)]*)\)/g)].map(match => match[1])];
    return [...new Set(variants.map(normalizeName).filter(Boolean))];
}

export function candidateNames(city) {
    return [...new Set([city.name, ...(city.aliases || [])].flatMap(nameVariants))];
}

export function distanceKm(a, b) {
    const radians = Math.PI / 180;
    const lat1 = a[0] * radians;
    const lat2 = b[0] * radians;
    const x = (b[1] - a[1]) * radians * Math.cos((lat1 + lat2) / 2);
    const y = (b[0] - a[0]) * radians;
    return Math.hypot(x, y) * 6371;
}

export function classifyNameCoordinateMatch(candidate, prior, reviewDistanceKm = 40) {
    if (String(candidate.iso2 || '').toUpperCase() !== String(prior.countryCode || '').toUpperCase()) return null;
    const names = new Set(candidateNames(candidate));
    const priorNames = [prior.name, ...(prior.aliases || [])].flatMap(nameVariants);
    if (!priorNames.some(name => names.has(name))) return null;
    const point = Array.isArray(prior.centerLatLon) && prior.centerLatLon.length === 2 ? prior.centerLatLon : null;
    const distance = point ? distanceKm(candidate.point, point) : null;
    return {
        distanceKm: distance === null ? null : Number(distance.toFixed(2)),
        kind: distance !== null && distance > reviewDistanceKm ? 'same-country-name-distance-review' : 'same-country-name-coordinate-candidate'
    };
}

export function parseWup2025Fields(row) {
    if (![row.City_Code, row.Pop, row.PWCent_Latitude, row.PWCent_Longitude].every(value => typeof value === 'string' && value.trim())) return null;
    const cityCode = Number(row.City_Code), pop2025k = Number(row.Pop);
    const lat = Number(row.PWCent_Latitude), lon = Number(row.PWCent_Longitude);
    if (!Number.isInteger(cityCode) || !Number.isFinite(pop2025k) || pop2025k <= 0 || !Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180) return null;
    return { cityCode, pop2025k, point: [lat, lon] };
}

export function hasAttemptSignal(row, evidenceExists = () => false) {
    if (!row || row.checked === false) return false;
    const status = String(row.parcelStatus || row.status || '').toLowerCase();
    if (status && !['unchecked', 'not_checked', 'not_started', 'pending', 'queued'].includes(status)) return true;
    if ((row.sourceIds || []).length > 0 || row.latestAssessmentFile || row.regionalResearch?.evidenceFile) return true;
    return evidenceExists();
}

export function isSearchableEvidenceFile(file) {
    return !/(^|\/)attempt-crosswalks\.json$/i.test(String(file))
        && !/(^|\/)overnight-cities-[^/]+\/(ranked-top1000|skip-ledger|pending-queue|identity-review|provenance)\.json$/i.test(String(file));
}

export function applyCrosswalkDecision(city, matches, decision) {
    if (!decision) return { attempted: false, holdForReview: matches.length > 0, activeMatches: matches, resolvedMatches: [] };
    if (Number(decision.wupCityCode) !== Number(city.cityCode) || String(decision.countryCode).toUpperCase() !== String(city.iso2).toUpperCase()) {
        throw new Error(`Crosswalk identity mismatch for WUP ${city.cityCode}/${city.iso2}`);
    }
    if (decision.decision === 'confirmed_attempt') return { attempted: true, holdForReview: false, activeMatches: [], resolvedMatches: matches };
    if (decision.decision === 'different_settlement') {
        const excluded = new Set((decision.excludeEvidenceFiles || []).map(normalizeEvidencePath));
        const resolvedMatches = matches.filter(match => excluded.has(normalizeEvidencePath(match.evidenceFile)));
        const activeMatches = matches.filter(match => !excluded.has(normalizeEvidencePath(match.evidenceFile)));
        return { attempted: false, holdForReview: activeMatches.length > 0, activeMatches, resolvedMatches };
    }
    throw new Error(`Unknown crosswalk decision ${decision.decision}`);
}

function normalizeEvidencePath(file) {
    return String(file || '').replace(/^world-parcels\//, '').replace(/^\.\//, '');
}
