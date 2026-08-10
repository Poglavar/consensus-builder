// Generic tree provider. Source: the SHARED `public.osm_decor` table that cadastre-data loads
// (`api/scripts/load-osm-decor.mjs`) and zagreb-isochrone renders through the /decor API. This app
// used to read its own Overture copy in `overture_feature`; both sets are OSM `natural=tree` in the
// end (Overture's base/land trees are derived from OSM), and they agreed to within 7 trees over
// Split — so the duplicate copy bought nothing and cost a second ingestion to keep current.
//
// Two sources of tree positions, unioned:
//
//   1. kind='trees'    — individually mapped trees. Authoritative, and in most of Croatia far too
//                        sparse to render as scenery: OSM has 139 of them across the whole
//                        Šibenik–Vodice strip, and an Overpass count confirms 43 in central Šibenik,
//                        exactly what we hold. The data does not exist; no reload produces more.
//   2. kind='greenery' — mapped green AREAS, of which the same strip has 1,812 covering 9,830 ha.
//                        We scatter trees through them, which is what zagreb-isochrone's world does
//                        with the same rows. This is derived presentation, computed per request, and
//                        deliberately NOT written back to the shared table — the isochrone plants its
//                        own, and stored copies would double up there.
//
// Returns [lng, lat] pairs; the frontend renders each as an instanced trunk+crown with a
// deterministic per-tree height (neither source carries one).

import { OVERTURE_CITIES } from '../buildings/overture-cities.js';
import { scopeLadder, queryDownScopeLadder, createScopeMemo } from '../data-scope.js';

// Trees are dense (a few thousand within 300 m in a leafy centre). Instanced rendering handles that
// fine, but cap the payload so a pathological radius can't return tens of thousands. Distance-ordered
// so the cap keeps the NEAREST trees deterministically (nearest-first), like the building providers.
const MAX_TREES = 8000;

// Scatter spacing through greenery, in real metres, when a city declares none. ~1 tree per 200 m²
// after the acceptance roll — dense enough to read as woodland, sparse enough to stay instanced.
const DEFAULT_GREENERY_TREE_SPACING_M = 12;
// Fraction of lattice cells that actually get a tree. Below 1 so the grid never reads as a grid.
const GREENERY_ACCEPTANCE = 0.72;
// A planted tree this close to a mapped one is the same tree twice — drop it.
const PLANTED_MIN_DISTANCE_TO_MAPPED_M = 5;

export function createOvertureTreesProvider(pool, cityKey) {
    const cfg = OVERTURE_CITIES[cityKey];
    if (!cfg) throw new Error(`createOvertureTreesProvider: unknown Overture city '${cityKey}'`);
    // city → region → country → planet, exactly as the buildings read (data-scope.js). Decor is
    // ingested by area too, so the same city can find its trees under a broader label than its own.
    const ladder = scopeLadder({ city: cfg.city || cityKey, region: cfg.region, country: cfg.country });
    const scopeMemo = createScopeMemo();
    const spacingM = Number.isFinite(cfg.greeneryTreeSpacingM) && cfg.greeneryTreeSpacingM > 0
        ? cfg.greeneryTreeSpacingM
        : DEFAULT_GREENERY_TREE_SPACING_M;

    async function near(geometry, bufferMeters) {
        // ST_DWithin on geography gives a true metres-radius circle at any latitude with no per-city
        // projected CRS. Ordering by planar <-> distance before the cap keeps it deterministic.
        //
        // `box` is not redundant with ST_DWithin — it is what makes this query fast. The geography
        // cast hides `geom` behind a function call, so the GIST index cannot serve it and Postgres
        // scans all 316k decor rows computing geodesic distances: measured 2,654 ms without this
        // prefilter against 309 ms with it, same box, back to back. The envelope of the geodesic
        // buffer is an exact superset of the circle, so the result set is unchanged.
        //
        // PLANTING AND WHY THE LATTICE IS ANCHORED TO ABSOLUTE COORDINATES.
        // Scattered positions must not move when the query does. If the lattice were laid out
        // relative to the query point, or over a polygon clipped to the current radius, every pan
        // would re-roll every tree and the woodland would visibly crawl. So the lattice lives on
        // absolute EPSG:3857 metres and its jitter is hashed from the integer cell indices: clipping
        // then only ever REMOVES candidates, never shifts them, and the same ground yields the same
        // trees from any camera. `step` is divided by cos(latitude) because 3857 units are not
        // metres away from the equator (x1.38 at Šibenik) — taken from each polygon's own centroid,
        // which is a fixed property of that polygon, so the spacing is stable per polygon too.
        const sql = `
            WITH q AS (
                SELECT ST_SetSRID(ST_GeomFromGeoJSON($1), 4326) AS g
            ), box AS (
                SELECT ST_Envelope(ST_Buffer(q.g::geography, $3)::geometry) AS b FROM q
            ), mapped AS (
                SELECT t.geom
                FROM osm_decor t, q, box
                WHERE ($2::text IS NULL OR t.city = $2)
                  AND t.kind = 'trees'
                  AND t.geom && box.b
                  AND ST_DWithin(t.geom::geography, q.g::geography, $3)
            ), green AS (
                SELECT d.fid,
                       ST_Transform(ST_Intersection(d.geom, box.b), 3857) AS gm,
                       GREATEST(cos(radians(ST_Y(ST_Centroid(d.geom)))), 0.05) AS coslat
                FROM osm_decor d, box
                WHERE ($2::text IS NULL OR d.city = $2)
                  AND d.kind = 'greenery'
                  AND d.geom && box.b
            ), stepped AS (
                SELECT fid, gm, ($4::float / coslat) AS step
                FROM green
                WHERE gm IS NOT NULL AND NOT ST_IsEmpty(gm)
            ), lattice AS (
                SELECT s.fid, s.step, gx, gy
                FROM stepped s,
                     generate_series(floor(ST_XMin(s.gm) / s.step)::bigint,
                                     ceil(ST_XMax(s.gm) / s.step)::bigint) gx,
                     generate_series(floor(ST_YMin(s.gm) / s.step)::bigint,
                                     ceil(ST_YMax(s.gm) / s.step)::bigint) gy
            ), candidate AS (
                SELECT l.fid,
                       ST_SetSRID(ST_MakePoint(
                           (l.gx + 0.5 + ((abs(hashtext(l.gx || ':' || l.gy || ':x')) % 1000) / 1000.0 - 0.5) * 0.7) * l.step,
                           (l.gy + 0.5 + ((abs(hashtext(l.gx || ':' || l.gy || ':y')) % 1000) / 1000.0 - 0.5) * 0.7) * l.step
                       ), 3857) AS pm
                FROM lattice l
                WHERE (abs(hashtext(l.gx || ':' || l.gy || ':roll')) % 1000) / 1000.0 < $5::float
            ), planted AS (
                SELECT ST_Transform(c.pm, 4326) AS geom
                FROM candidate c
                JOIN stepped s ON s.fid = c.fid AND ST_Contains(s.gm, c.pm)
            ), planted_kept AS (
                SELECT p.geom
                FROM planted p, q
                WHERE ST_DWithin(p.geom::geography, q.g::geography, $3)
                  AND NOT EXISTS (
                      SELECT 1 FROM mapped m
                      WHERE ST_DWithin(m.geom::geography, p.geom::geography, $6::float)
                  )
            ), all_trees AS (
                SELECT geom FROM mapped
                UNION ALL
                SELECT geom FROM planted_kept
            )
            SELECT ST_X(a.geom) AS lng, ST_Y(a.geom) AS lat
            FROM all_trees a, q
            ORDER BY a.geom <-> q.g
            LIMIT ${MAX_TREES}
        `;
        // Not cfg.region alone — one regional decor load can serve several cities, and a city may
        // have no decor ingest of its own at all.
        const { rows, scope } = await queryDownScopeLadder(
            ladder,
            async (label) => (await pool.query(sql, [
                JSON.stringify(geometry), label, bufferMeters,
                spacingM, GREENERY_ACCEPTANCE, PLANTED_MIN_DISTANCE_TO_MAPPED_M
            ])).rows,
            scopeMemo,
            `trees:${cityKey}`
        );
        const trees = rows.map(r => [Number(r.lng), Number(r.lat)]);
        return { trees, count: trees.length, scope, source: 'overture-trees' };
    }

    return { near };
}
