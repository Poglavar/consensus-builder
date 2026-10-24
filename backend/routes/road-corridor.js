// Server-authoritative corridor acquisition stats. The client used to SCRAPE these numbers out of
// the road info panel's DOM (textContent.replace(/\D/g,'')), store them in proposal_data, and show
// them to everyone — the server trusted whatever arrived. This recomputes them from PostGIS: buffer
// the corridor footprint, intersect it with the supported parcel layer, classify each touched parcel's
// ownership (the shared classifier), and apply the caller's sourced area model.
//
// The query only supports the `oss-wfs` parcel source; callers must name it explicitly.

import { createRequire } from 'node:module';
import { buildOwnershipType, buildOwnershipSummary } from './parcels.js';

const require = createRequire(import.meta.url);
const EconomicSources = require('../../frontend/js/economic-sources.js');
// The road tool's acquisition-difficulty coefficients (frontend/js/road-drawing.js): government and
// institutions have weight 0 in this illustrative model, companies 1×, individuals/mixed 2×.
// These coefficients establish neither acquisition cost nor legal availability.
const OWNERSHIP_COEFFICIENTS = { government: 0, institution: 0, company: 1, individual: 2, mixed: 2 };

// The classifier returns 'private individual' / 'company' / 'government' / 'institution' / 'mixed';
// map to the coefficient keys the road tool uses.
export function normalizeCorridorOwnershipType(type) {
    const t = (type || '').toString().toLowerCase();
    if (t.includes('government') || t === 'city') return 'government';
    if (t.includes('institution')) return 'institution';
    if (t.includes('company')) return 'company';
    if (t.includes('mixed')) return 'mixed';
    return t === 'private individual' || t === 'individual' ? 'individual' : null;
}

// Aggregate per-parcel rows into the acquisition stats. Pure — inject the classifier so it is
// testable without a DB. rows: [{ parcelId, fullAreaM2, takenAreaM2, ownershipDetails }].
function normalizeEconomicObservation(value) {
    if (!value) return null;
    try {
        const table = EconomicSources.rateTable({
            version: 1, id: value.sourceId, name: value.sourceName, adapter: 'rate-table', url: value.sourceUrl,
            rates: [{ metric: value.metric, unit: value.unit, amount: value.amount, currency: value.currency,
                basis: value.basis, asOf: value.asOf, scope: value.scope }]
        });
        const row = table.rates[0];
        if (row.metric !== 'roadLand') return null;
        return { ...row, sourceId: table.id, sourceName: table.name, sourceUrl: table.url };
    } catch (_) { return null; }
}

export function computeCorridorAcquisitionStats(rows, opts = {}) {
    const economicSource = normalizeEconomicObservation(opts.economicSource);
    const pricePerM2 = economicSource ? economicSource.amount : null;
    const classify = typeof opts.classify === 'function' ? opts.classify : () => null;

    const ownershipCounts = { individual: 0, company: 0, government: 0, institution: 0, mixed: 0 };
    let totalMarketPrice = economicSource ? 0 : null;
    let unknownOwnershipParcelCount = 0;
    let knownOwnerEntryCount = 0;
    let missingOwnerEvidenceParcelCount = 0;
    let totalAcquiringDifficulty = economicSource ? 0 : null;
    let areaTakenM2 = 0;
    const parcelIds = [];

    for (const row of (rows || [])) {
        const fullArea = Number(row.fullAreaM2) || 0;
        if (!(fullArea > 0)) continue;
        areaTakenM2 += Number(row.takenAreaM2) || 0;
        const type = row.ownershipDetails ? normalizeCorridorOwnershipType(classify(row.ownershipDetails)) : null;
        if (type) ownershipCounts[type] += 1;
        else unknownOwnershipParcelCount += 1;
        const summary = buildOwnershipSummary(row.ownershipDetails);
        if (summary) knownOwnerEntryCount += summary.ownershipList.length;
        else missingOwnerEvidenceParcelCount += 1;
        if (economicSource) {
            const modeledPrice = fullArea * pricePerM2;
            totalMarketPrice += modeledPrice;
            if (type) totalAcquiringDifficulty += modeledPrice * OWNERSHIP_COEFFICIENTS[type];
        }
        if (row.parcelId) parcelIds.push(row.parcelId);
    }

    return {
        parcelIds,
        areaTakenM2: Math.round(areaTakenM2),
        ownershipCounts,
        ownerEntryCount: missingOwnerEvidenceParcelCount ? null : knownOwnerEntryCount,
        knownOwnerEntryCount, missingOwnerEvidenceParcelCount, unknownOwnershipParcelCount,
        currency: economicSource?.currency ?? null,
        priceBasis: { kind: economicSource ? 'area-model' : 'unavailable', ratePerM2: pricePerM2,
            currency: economicSource?.currency ?? null, economicSource },
        difficultyBasis: 'category-weighted value model',
        totalMarketPrice: Number.isFinite(totalMarketPrice) ? Math.round(totalMarketPrice) : null,
        totalAcquiringDifficulty: !economicSource || unknownOwnershipParcelCount ? null : Math.round(totalAcquiringDifficulty),
        source: 'server' // marks the stats as recomputed, not client-scraped
    };
}

// The authored road definition carries the one canonical cut/taking footprint.
export function resolveRoadFootprintGeometry(proposal) {
    if (!proposal) return null;
    return asGeometry(proposal.roadProposal?.definition?.polygon);
}

function asGeometry(candidate) {
    if (!candidate || typeof candidate !== 'object') return null;
    if (candidate.type === 'Feature' && candidate.geometry) return candidate.geometry;
    if ((candidate.type === 'Polygon' || candidate.type === 'MultiPolygon') && Array.isArray(candidate.coordinates)) {
        return candidate;
    }
    return null;
}

// Buffer the footprint, intersect it with the Zagreb parcel layer (EPSG:3765, metric), and pull each
// touched parcel's full area + intersection area + ownership details in one query.
const CORRIDOR_STATS_SQL = `
    WITH corridor AS (
        SELECT ST_MakeValid(ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON($1), 4326), 3765)) AS geom
    )
    SELECT
        p.maticni_broj_ko::text || '-' || p.broj_cestice AS parcel_id,
        ST_Area(ST_Transform(ST_MakeValid(p.geom), 4326)::geography) AS full_area_m2,
        ST_Area(ST_Transform(ST_Intersection(ST_MakeValid(p.geom), c.geom), 4326)::geography) AS taken_area_m2,
        pdx.details AS ownership_details
    FROM parcel p
    CROSS JOIN corridor c
    LEFT JOIN LATERAL (
        SELECT pi.details
        FROM parcel_info pi
        WHERE pi.details IS NOT NULL
          AND pi.maticni_broj_ko = p.maticni_broj_ko
          AND pi.broj_cestice = p.broj_cestice
        ORDER BY pi.version DESC
        LIMIT 1
    ) pdx ON TRUE
    WHERE p.current = true
      AND p.geom && c.geom
      AND ST_Intersects(ST_MakeValid(p.geom), c.geom)
`;

export async function queryCorridorAcquisitionStats(pool, footprintGeoJSON, opts = {}) {
    const result = await pool.query(CORRIDOR_STATS_SQL, [JSON.stringify(footprintGeoJSON)]);
    const rows = result.rows.map(r => ({
        parcelId: r.parcel_id,
        fullAreaM2: Number(r.full_area_m2),
        takenAreaM2: Number(r.taken_area_m2),
        ownershipDetails: r.ownership_details
    }));
    return computeCorridorAcquisitionStats(rows, { ...opts, classify: buildOwnershipType });
}

function normalizeRoadLandSource(value) {
    const table = EconomicSources.rateTable(value);
    const row = table.rates.find(rate => rate.metric === 'roadLand');
    if (!row) throw new Error('An economic source with a roadLand rate is required.');
    return normalizeEconomicObservation({ ...row, sourceId: table.id, sourceName: table.name, sourceUrl: table.url });
}

export function setupRoadCorridorRoute(app, pool) {
    // POST /road-corridor/stats requires the supported parcel source and a roadLand rate source.
    app.post('/road-corridor/stats', async (req, res) => {
        try {
            const body = req.body || {};
            if (body.parcelSourceId !== 'oss-wfs') {
                return res.status(400).json({ error: 'parcelSourceId must be the supported source.' });
            }
            let economicSource;
            try { economicSource = normalizeRoadLandSource(body.economicSource); }
            catch (error) { return res.status(400).json({ error: error.message || 'A valid roadLand economic source is required.' }); }
            let footprint = asGeometry(body.geometry);
            if (!footprint && Array.isArray(body.points) && body.points.length >= 2 && Number(body.width) > 0) {
                footprint = resolveRoadFootprintGeometry({ roadProposal: { definition: { points: body.points, width: Number(body.width) } } });
            }
            if (!footprint) {
                return res.status(400).json({ error: 'geometry (Polygon/MultiPolygon) or points[]+width is required' });
            }
            const stats = await queryCorridorAcquisitionStats(pool, footprint, { economicSource });
            res.json(stats);
        } catch (err) {
            console.error('Error in POST /road-corridor/stats:', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    });
}
