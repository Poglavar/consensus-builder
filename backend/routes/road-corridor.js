// Server-authoritative corridor acquisition stats. The client used to SCRAPE these numbers out of
// the road info panel's DOM (textContent.replace(/\D/g,'')), store them in proposal_data, and show
// them to everyone — the server trusted whatever arrived. This recomputes them from PostGIS: buffer
// the corridor footprint, intersect it with the Zagreb parcel layer, classify each touched parcel's
// ownership (the shared classifier), and sum the market price + acquisition difficulty.
//
// Zagreb-only: the `parcel` table is the Croatian cadastre. Other cities have no recompute (the
// endpoint simply finds no parcels), and POST /proposals leaves their client value alone.

import { createRequire } from 'node:module';
import * as turf from '@turf/turf';
import { buildOwnershipType } from './parcels.js';

const require = createRequire(import.meta.url);
// The road tool's acquisition-difficulty coefficients (frontend/js/road-drawing.js): government and
// institutions are free to acquire, companies 1×, individuals/mixed 2× (hardest).
const OWNERSHIP_COEFFICIENTS = { government: 0, institution: 0, company: 1, individual: 2, mixed: 2 };
const DEFAULT_PRICE_PER_M2 = 100; // matches the client's area × 100 market-price fallback

// The classifier returns 'private individual' / 'company' / 'government' / 'institution' / 'mixed';
// map to the coefficient keys the road tool uses.
export function normalizeCorridorOwnershipType(type) {
    const t = (type || '').toString().toLowerCase();
    if (t.includes('government') || t === 'city') return 'government';
    if (t.includes('institution')) return 'institution';
    if (t.includes('company')) return 'company';
    if (t.includes('mixed')) return 'mixed';
    return 'individual'; // 'private individual' and the default
}

// Aggregate per-parcel rows into the acquisition stats. Pure — inject the classifier so it is
// testable without a DB. rows: [{ parcelId, fullAreaM2, takenAreaM2, ownershipDetails }].
export function computeCorridorAcquisitionStats(rows, opts = {}) {
    const pricePerM2 = Number.isFinite(opts.pricePerM2) ? opts.pricePerM2 : DEFAULT_PRICE_PER_M2;
    const classify = typeof opts.classify === 'function' ? opts.classify : () => null;

    const ownershipCounts = { individual: 0, company: 0, government: 0, institution: 0, mixed: 0 };
    let totalMarketPrice = 0;
    let totalAcquiringDifficulty = 0;
    let areaTakenM2 = 0;
    const parcelIds = [];

    for (const row of (rows || [])) {
        const fullArea = Number(row.fullAreaM2) || 0;
        if (!(fullArea > 0)) continue;
        areaTakenM2 += Number(row.takenAreaM2) || 0;
        const type = normalizeCorridorOwnershipType(classify(row.ownershipDetails));
        ownershipCounts[type] += 1;
        const marketPrice = fullArea * pricePerM2;
        totalMarketPrice += marketPrice;
        totalAcquiringDifficulty += marketPrice * OWNERSHIP_COEFFICIENTS[type];
        if (row.parcelId) parcelIds.push(row.parcelId);
    }

    return {
        parcelIds,
        areaTakenM2: Math.round(areaTakenM2),
        ownershipCounts,
        individualOwners: ownershipCounts.individual,
        totalMarketPrice: Math.round(totalMarketPrice),
        totalAcquiringDifficulty: Math.round(totalAcquiringDifficulty),
        source: 'server' // marks the stats as recomputed, not client-scraped
    };
}

// Pick the corridor FOOTPRINT polygon (WGS84 GeoJSON) from a proposal, mirroring the thumbnail's
// candidate order. Falls back to buffering the centerline by half the road width.
export function resolveRoadFootprintGeometry(proposal) {
    if (!proposal) return null;
    const rp = proposal.roadProposal || {};
    const def = rp.definition || proposal.definition || {};
    const candidates = [
        rp.polygon, rp.superGeometry, rp.geometry, def.polygon,
        proposal.geometry && proposal.geometry.roadGeometry && proposal.geometry.roadGeometry.polygon
    ];
    for (const candidate of candidates) {
        const g = asGeometry(candidate);
        if (g) return g;
    }
    // Last resort: buffer the centerline.
    const points = Array.isArray(def.points) ? def.points : [];
    const width = Number(def.width);
    if (points.length >= 2 && Number.isFinite(width) && width > 0) {
        const coords = points
            .map(p => {
                const lng = Number(p && (p.lng ?? p.lon ?? p.longitude ?? p[0]));
                const lat = Number(p && (p.lat ?? p.latitude ?? p[1]));
                return Number.isFinite(lat) && Number.isFinite(lng) ? [lng, lat] : null;
            })
            .filter(Boolean);
        if (coords.length >= 2) {
            try {
                const buffered = turf.buffer(turf.lineString(coords), width / 2, { units: 'meters' });
                return buffered && buffered.geometry ? buffered.geometry : null;
            } catch (_) { return null; }
        }
    }
    return null;
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
        ST_Area(ST_MakeValid(p.geom)) AS full_area_m2,
        ST_Area(ST_Intersection(ST_MakeValid(p.geom), c.geom)) AS taken_area_m2,
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

export async function queryCorridorAcquisitionStats(pool, footprintGeoJSON) {
    const result = await pool.query(CORRIDOR_STATS_SQL, [JSON.stringify(footprintGeoJSON)]);
    const rows = result.rows.map(r => ({
        parcelId: r.parcel_id,
        fullAreaM2: Number(r.full_area_m2),
        takenAreaM2: Number(r.taken_area_m2),
        ownershipDetails: r.ownership_details
    }));
    return computeCorridorAcquisitionStats(rows, { classify: buildOwnershipType });
}

// Used by POST /proposals: recompute the stats for a road proposal and OVERWRITE the client's copy.
// Best-effort — returns null (leaving the client value in place) on any failure or non-road input,
// so it can never fail proposal creation.
export async function recomputeCorridorStats(pool, proposal) {
    try {
        if (!pool || !proposal || !proposal.roadProposal) return null;
        const footprint = resolveRoadFootprintGeometry(proposal);
        if (!footprint) return null;
        const stats = await queryCorridorAcquisitionStats(pool, footprint);
        // No parcels touched (e.g. a non-Zagreb corridor) → don't clobber the client value.
        if (!stats.parcelIds.length) return null;
        return stats;
    } catch (err) {
        console.warn('[road-corridor] recompute failed, keeping client stats:', err.message);
        return null;
    }
}

export function setupRoadCorridorRoute(app, pool) {
    // POST /road-corridor/stats { geometry } or { points:[[lng,lat]], width } → acquisition stats.
    app.post('/road-corridor/stats', async (req, res) => {
        try {
            const body = req.body || {};
            let footprint = asGeometry(body.geometry);
            if (!footprint && Array.isArray(body.points) && body.points.length >= 2 && Number(body.width) > 0) {
                footprint = resolveRoadFootprintGeometry({ roadProposal: { definition: { points: body.points, width: Number(body.width) } } });
            }
            if (!footprint) {
                return res.status(400).json({ error: 'geometry (Polygon/MultiPolygon) or points[]+width is required' });
            }
            const stats = await queryCorridorAcquisitionStats(pool, footprint);
            res.json(stats);
        } catch (err) {
            console.error('Error in POST /road-corridor/stats:', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    });
}
