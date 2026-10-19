// Read the automated GUP restatement as source proposals. City-specific source fields stop here;
// the API and both renderers consume the same city-neutral spatial representation contract.
import { validateGeometry } from '../../parcels/source-contract.js';

export const zagrebGupSource = Object.freeze({
    id: 'zagreb-gup-2025', label: 'Zagreb GUP 2025', city: 'zagreb',
    url: 'https://www.zagreb.hr/izmjene-i-dopune-generalnogurbanistickog-plana-gr/187664',
    coverage: 'partial', kind: 'regulation'
});

const finite = value => typeof value === 'number' && Number.isFinite(value);

export function gupRepresentation(row) {
    const data = row.proposal_data;
    const evidence = data?.source;
    const buildings = data?.geometry?.buildings;
    if (!evidence?.inputHash || !Array.isArray(buildings) || !buildings.length) return null;
    const volumes = buildings.map((feature, index) => {
        const height = feature?.properties?.height;
        if (!validateGeometry(feature?.geometry) || !finite(height) || height <= 0) return null;
        return { id: `${row.proposal_id}:${index}`, geometry: feature.geometry, baseM: 0, topM: height };
    });
    if (volumes.some(volume => !volume)) return null;
    const limits = [
        ['dwellings', evidence.maxUnits, 'count', 'maximum'],
        ['floorArea', evidence.variables?.max_gbp, 'm2', 'maximum'],
        ['naturalGround', evidence.variables?.min_natural_terrain, 'percent', 'minimum']
    ].filter(([, value]) => finite(value)).map(([quantity, value, unit, bound]) => ({
        quantity, value, unit, bound, evaluation: 'not-evaluated'
    }));
    return {
        id: `${zagrebGupSource.id}:${row.proposal_id}`,
        role: 'permitted',
        proposalId: row.proposal_id,
        title: `GUP 2025 · ${evidence.zone || ''}`.trim(),
        site: data.geometry.superParcel?.geometry || null,
        volumes,
        spatialReference: { horizontal: 'OGC:CRS84', vertical: 'relative-ground', unit: 'm' },
        source: { ...zagrebGupSource, version: evidence.inputHash, computedAt: evidence.computedAt,
            solverVersion: evidence.solverVersion, rule: evidence.rule, parcel: evidence.parcel },
        authority: { effect: 'obligatory', basis: 'source-restatement', applicability: evidence.applicability || 'unresolved' },
        assessment: { geometry: 'approximate', meaning: 'one-calculated-option', constraints: 'not-evaluated',
            issues: evidence.flags || [] },
        metrics: { floorAreaM2: finite(evidence.gbpM2) ? evidence.gbpM2 : null,
            heightM: Math.max(...volumes.map(volume => volume.topM)) },
        constraints: limits,
        // Preserve the original conditions even when the initial UI/evaluator cannot interpret them.
        sourceEvidence: evidence
    };
}

export async function queryZagrebGup(pool, { bbox, limit }) {
    const { rows } = await pool.query(`
        SELECT proposal_id, proposal_data
        FROM proposal
        WHERE city = $1 AND building_proposal->>'createdFrom' = 'gup-spatial-restatement'
          AND lifecycle_status NOT IN ('Cancelled', 'Expired')
          AND (bounds->>0)::double precision <= $4 AND (bounds->>2)::double precision >= $2
          AND (bounds->>1)::double precision <= $5 AND (bounds->>3)::double precision >= $3
        ORDER BY proposal_id LIMIT $6`, ['zagreb', ...bbox, limit + 1]);
    const candidates = rows.slice(0, limit);
    const items = candidates.map(gupRepresentation).filter(Boolean);
    return { items, truncated: rows.length > limit, omitted: candidates.length - items.length };
}
