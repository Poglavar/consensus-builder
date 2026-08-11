// Generic Overture-Maps 3D building provider. Source: the SHARED `public.overture_building_footprint`
// table — footprints (EPSG:4326) with an optional measured `height` and `num_floors`, ingested per
// area by cadastre-data (`buildings/fetch-overture-buildings.js`) and read by zagreb-isochrone's 3D
// world too. Each footprint is extruded to a flat-top LOD1 block, the same face-mesh shape every
// city's provider yields, so the route and renderer stay source-agnostic. This is the fallback for
// cities without a bespoke local 3D source.

import { extrudeFootprint } from './extrude.js';
import { OVERTURE_CITIES, effectiveHeight } from './overture-cities.js';
import { scopeLadder, queryDownScopeLadder, createScopeMemo } from '../data-scope.js';

// Sized above the densest 500m-radius query so the radius, not the cap, is the real limiter (it
// only binds on pathological inputs). Mirrors the Zagreb/NYC providers.
const MAX_BUILDINGS = 4000;

export function createOvertureProvider(pool, cityKey) {
    const cfg = OVERTURE_CITIES[cityKey];
    if (!cfg) throw new Error(`createOvertureProvider: unknown Overture city '${cityKey}'`);
    // city → region → country → planet. Which ingest actually holds this ground is a property of
    // how cadastre-data happened to pull it, not of the city, so it is discovered rather than
    // declared: the first rung that answers wins, and the winner is remembered.
    const ladder = scopeLadder({ city: cfg.city || cityKey, region: cfg.region, country: cfg.country });
    const scopeMemo = createScopeMemo();

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
            WHERE ($2::text IS NULL OR b.city = $2)
              AND b.geom && box.b
              AND ST_DWithin(b.geom::geography, q.g::geography, $3)
            ORDER BY b.geom <-> q.g
            LIMIT ${MAX_BUILDINGS}
        `;

        // Not cfg.region alone: several cities read one regional ingest (sibenik →
        // sjeverna-dalmacija) and some read only the countrywide one, so the scope is discovered.
        const { rows, scope } = await queryDownScopeLadder(
            ladder,
            async (label) => (await pool.query(sql, [JSON.stringify(geometry), label, bufferMeters])).rows,
            scopeMemo,
            `near:${cityKey}`
        );

        const buildings = [];
        for (const row of rows) {
            const { height } = effectiveHeight(Number(row.height_m), Number(row.num_floors), cfg);
            const rec = extrudeFootprint(row.overture_id, row.geometry, height);
            if (rec) buildings.push(rec);
        }

        return { buildings, count: buildings.length, scope, source: 'overture-3d' };
    }

    // 2D footprints (+ known heights) of the existing buildings mostly inside a polygon — the same
    // capability Zagreb serves off its cadastre, for every city whose stock is Overture.
    //
    // Two things depend on it, and both were dead in these cities: the urban rule's "based on
    // existing buildings" mode, and the frontend's footprint POOL — what a road reads to decide
    // which buildings it cuts, tunnels under or demolishes. The pool used to be filled from the GDI
    // bbox layer, which is the ZAGREB survey, so in Šibenik it was always empty and a road could
    // never find a building to demolish.
    //
    // "Mostly inside" = at least half the footprint's area, so a neighbour merely touching the
    // boundary is not swept into a "raise everything here" proposal. Planar areas in 4326 are only
    // compared with each other (a ratio), never returned, so the projection cancels.
    async function footprints(geometry) {
        const sql = `
            WITH q AS (
                SELECT ST_SetSRID(ST_GeomFromGeoJSON($1), 4326) AS g
            )
            SELECT b.id AS id,
                   b.height AS height_m,
                   b.num_floors,
                   ST_AsGeoJSON(b.geom, 7)::json AS geometry
            FROM overture_building_footprint b, q
            WHERE ($2::text IS NULL OR b.city = $2)
              AND b.geom && q.g
              AND ST_Intersects(b.geom, q.g)
              AND ST_Area(ST_Intersection(b.geom, q.g)) >= 0.5 * ST_Area(b.geom)
            ORDER BY b.id
            LIMIT ${MAX_BUILDINGS}
        `;

        // Down the same ladder as near(), for the same reason.
        const { rows, scope } = await queryDownScopeLadder(
            ladder,
            async (label) => (await pool.query(sql, [JSON.stringify(geometry), label])).rows,
            scopeMemo,
            `footprints:${cityKey}`
        );
        const list = rows.map(row => {
            const measured = Number(row.height_m);
            const floors = Number(row.num_floors);
            return {
                id: String(row.id),
                geometry: row.geometry,
                // MEASURED height only, null when Overture has none — the same contract Zagreb's
                // provider keeps. A consumer that wants a guess can derive one from the floors.
                height_m: Number.isFinite(measured) && measured > 0 ? measured : null,
                floors: Number.isFinite(floors) && floors > 0 ? floors : null
            };
        });
        // A capped result does not cover its query area, and a caller that believes otherwise stops
        // fetching ground it never loaded — the same trap the bbox layer guards with `truncated`.
        return {
            footprints: list,
            count: list.length,
            truncated: list.length >= MAX_BUILDINGS,
            scope,
            source: 'overture-footprints'
        };
    }

    return { near, footprints };
}
