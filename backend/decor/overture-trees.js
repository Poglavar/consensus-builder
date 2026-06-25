// Generic Overture-Maps tree provider. Source: the `overture_tree` table — individual tree POINTs
// (EPSG:4326) ingested per city from Overture's base/land theme (see scripts/ingest-overture.js).
// Returns the trees within a metres radius of a query geometry as a compact [lng, lat] list; the
// frontend renders each as an instanced trunk+crown with a deterministic per-tree height (Overture
// has no tree height). Toggleable scenery for cities without a bespoke local source.

import { OVERTURE_CITIES } from '../buildings/overture-cities.js';

// Trees are dense (a few thousand within 300 m in a leafy centre). Instanced rendering handles that
// fine, but cap the payload so a pathological radius can't return tens of thousands. Distance-ordered
// so the cap keeps the NEAREST trees deterministically (nearest-first), like the building providers.
const MAX_TREES = 8000;

export function createOvertureTreesProvider(pool, cityKey) {
    if (!OVERTURE_CITIES[cityKey]) throw new Error(`createOvertureTreesProvider: unknown Overture city '${cityKey}'`);

    async function near(geometry, bufferMeters) {
        // ST_DWithin on geography gives a true metres-radius circle at any latitude with no per-city
        // projected CRS. Ordering by planar <-> distance before the cap keeps it deterministic.
        const sql = `
            WITH q AS (
                SELECT ST_SetSRID(ST_GeomFromGeoJSON($1), 4326) AS g
            )
            SELECT ST_X(t.geom) AS lng, ST_Y(t.geom) AS lat
            FROM overture_tree t, q
            WHERE t.city = $2
              AND ST_DWithin(t.geom::geography, q.g::geography, $3)
            ORDER BY t.geom <-> q.g
            LIMIT ${MAX_TREES}
        `;
        const { rows } = await pool.query(sql, [JSON.stringify(geometry), cityKey, bufferMeters]);
        const trees = rows.map(r => [Number(r.lng), Number(r.lat)]);
        return { trees, count: trees.length, source: 'overture-trees' };
    }

    return { near };
}
