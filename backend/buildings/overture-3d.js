// Generic Overture-Maps 3D building provider. Source: the SHARED `public.overture_building_footprint`
// table — footprints (EPSG:4326) with an optional measured `height` and `num_floors`, ingested per
// area by cadastre-data (`buildings/fetch-overture-buildings.js`) and read by zagreb-isochrone's 3D
// world too. Each footprint is extruded to a flat-top LOD1 block, the same face-mesh shape every
// city's provider yields, so the route and renderer stay source-agnostic. This is the fallback for
// cities without a bespoke local 3D source.

import { extrudeFootprint } from './extrude.js';
import { OVERTURE_CITIES, effectiveHeight } from './overture-cities.js';

// Sized above the densest 500m-radius query so the radius, not the cap, is the real limiter (it
// only binds on pathological inputs). Mirrors the Zagreb/NYC providers.
const MAX_BUILDINGS = 4000;

export function createOvertureProvider(pool, cityKey) {
    const cfg = OVERTURE_CITIES[cityKey];
    if (!cfg) throw new Error(`createOvertureProvider: unknown Overture city '${cityKey}'`);

    async function near(geometry, bufferMeters) {
        // ST_DWithin on the geography type gives a true metres-radius circle that works at any
        // latitude without a per-city projected CRS — the generality the bespoke providers trade
        // away. Ordering by the planar <-> distance before the cap keeps it deterministic
        // (nearest-first): without the order the LIMIT keeps an arbitrary subset, so growing the
        // radius shuffles which buildings survive and they flicker in/out. With it, a larger radius
        // only ever adds farther rings.
        //
        // `box` is not redundant with the ST_DWithin below — it is what makes this query fast.
        // Casting to geography puts the operand behind a function call, so the GIST index on
        // `geom` cannot serve it and Postgres scans every row in the table computing geodesic
        // distances. Measured on the shared table (734k rows, 300 m radius at Šibenik):
        // 3,185 ms without this prefilter, 75 ms with it — 42x, same box, back to back. The
        // envelope of the geodesic buffer is an exact superset of the circle, so `&&` narrows to
        // an index scan and ST_DWithin only refines what survives; the result set is identical.
        const sql = `
            WITH q AS (
                SELECT ST_SetSRID(ST_GeomFromGeoJSON($1), 4326) AS g
            ), box AS (
                SELECT ST_Envelope(ST_Buffer(q.g::geography, $3)::geometry) AS b FROM q
            )
            SELECT
                b.id AS overture_id,
                b.height AS height_m,
                b.num_floors,
                ST_AsGeoJSON(b.geom, 7)::json AS geometry
            FROM overture_building_footprint b, q, box
            WHERE b.city = $2
              AND b.geom && box.b
              AND ST_DWithin(b.geom::geography, q.g::geography, $3)
            ORDER BY b.geom <-> q.g
            LIMIT ${MAX_BUILDINGS}
        `;

        // cfg.region, not cityKey: several cities can read one regional ingest (sibenik →
        // sjeverna-dalmacija), so the row set is named by the config, never by the city id.
        const { rows } = await pool.query(sql, [JSON.stringify(geometry), cfg.region, bufferMeters]);

        const buildings = [];
        for (const row of rows) {
            const { height } = effectiveHeight(Number(row.height_m), Number(row.num_floors), cfg);
            const rec = extrudeFootprint(row.overture_id, row.geometry, height);
            if (rec) buildings.push(rec);
        }

        return { buildings, count: buildings.length, source: 'overture-3d' };
    }

    return { near };
}
