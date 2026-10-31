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
// Trees are planted only through tree-bearing greenery (TREE_BEARING_GREENERY): the greenery rows
// also hold water, car parks, pitches, paving and sand, which got trees too before.
//
// Where the cache holds nothing for the area (any city it was never loaded for) or cannot be read,
// the same mapped trees and green areas come from OpenStreetMap live, through our backend's shared
// Overpass chain (osm-trees-overpass.js), and are planted by the same query, so cached and live
// ground give the same trees. OSM through our backend is the default; the cache only answers faster.
//
// Returns [lng, lat] pairs; the frontend renders each as an instanced trunk+crown with a
// deterministic per-tree height (neither source carries one).

import { scopeLadder, queryDownScopeLadder, createScopeMemo } from '../data-scope.js';
import { fetchOverpassTrees, TREE_BEARING_GREENERY, TREES_MAX_SPAN_DEG } from './osm-trees-overpass.js';

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

// How far around the asked area the cache must hold rows to count as covering it. A covered area
// with no trees nearby is a true answer; with nothing within this distance it was never loaded.
const CACHE_COVERAGE_MARGIN_M = 1000;

// The planting query. `source` 'cache' reads mapped trees and greenery from osm_decor; 'given'
// takes them as parameters ($7 [[lng, lat], …] mapped trees, $8 green-area GeoJSON geometries), as
// the live OSM fallback supplies them. Everything after the inputs is shared, so the same polygon
// is planted with the same trees from either source.
function plantingSql(source) {
    const inputs = source === 'cache' ? `
            mapped AS (
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
                  AND d.payload->>'t' = ANY($7::text[])
                  AND d.geom && box.b
            )` : `
            given_trees AS (
                SELECT ST_SetSRID(ST_MakePoint((p->>0)::float, (p->>1)::float), 4326) AS geom
                FROM json_array_elements($7::json) p
            ), mapped AS (
                SELECT t.geom FROM given_trees t, q
                WHERE ST_DWithin(t.geom::geography, q.g::geography, $3)
            ), given_green AS (
                SELECT n::text AS fid, ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON(e::text), 4326)) AS geom
                FROM json_array_elements($8::json) WITH ORDINALITY AS a(e, n)
            ), green AS (
                SELECT d.fid,
                       ST_Transform(ST_Intersection(d.geom, box.b), 3857) AS gm,
                       GREATEST(cos(radians(ST_Y(ST_Centroid(d.geom)))), 0.05) AS coslat
                FROM given_green d, box
                WHERE d.geom && box.b
            )`;
    return `
            WITH q AS (
                -- $2 is the cache's ingest label; named here so the live branch types it too.
                SELECT ST_SetSRID(ST_GeomFromGeoJSON($1), 4326) AS g, $2::text AS label
            ), box AS (
                SELECT ST_Envelope(ST_Buffer(q.g::geography, $3)::geometry) AS b FROM q
            ), ${inputs.trim()}, stepped AS (
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
}

const toTrees = rows => rows.map(r => [Number(r.lng), Number(r.lat)]);

// The WGS84 box a geometry and a metres buffer cover (a plain-degree envelope, generous at the edges).
function bufferedBbox(geometry, bufferMeters) {
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    const visit = coords => {
        if (typeof coords[0] === 'number') {
            w = Math.min(w, coords[0]); e = Math.max(e, coords[0]); s = Math.min(s, coords[1]); n = Math.max(n, coords[1]);
            return;
        }
        coords.forEach(visit);
    };
    visit(geometry.coordinates);
    const dLat = bufferMeters / 110570;
    const dLng = bufferMeters / (111320 * Math.max(Math.cos(((s + n) / 2) * Math.PI / 180), 0.05));
    return [w - dLng, s - dLat, e + dLng, n + dLat];
}

// Optional ingest labels and planting policy are supplied explicitly by the consumer;
// `cfg.fetchTrees` replaces the live OSM read (tests).
export function createOvertureTreesProvider(pool, cfg = {}) {
    const fetchTrees = cfg.fetchTrees || fetchOverpassTrees;
    const ladder = scopeLadder(cfg);
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
        // Not cfg.region alone — one regional decor load can serve several cities, and a city may
        // have no decor ingest of its own at all.
        const shared = [JSON.stringify(geometry), null, bufferMeters, spacingM, GREENERY_ACCEPTANCE, PLANTED_MIN_DISTANCE_TO_MAPPED_M];
        try {
            const { rows, scope } = await queryDownScopeLadder(
                ladder,
                async (label) => (await pool.query(plantingSql('cache'), [
                    shared[0], label, ...shared.slice(2), TREE_BEARING_GREENERY
                ])).rows,
                scopeMemo,
                'trees'
            );
            if (rows.length || await cacheCovers(geometry, bufferMeters)) {
                const trees = toTrees(rows);
                return { trees, count: trees.length, scope, source: 'overture-trees' };
            }
        } catch (error) {
            // The cache is a shortcut; OSM through our backend still answers.
            console.warn(`[${new Date().toISOString()}] [trees] osm_decor unreadable, reading OSM live: ${error.message}`);
        }
        return live(geometry, bufferMeters, shared);
    }

    // Whether osm_decor holds any tree or tree-bearing greenery row near the area at all.
    async function cacheCovers(geometry, bufferMeters) {
        const [w, s, e, n] = bufferedBbox(geometry, bufferMeters + CACHE_COVERAGE_MARGIN_M);
        const { rows } = await pool.query(
            `SELECT EXISTS (SELECT 1 FROM osm_decor d
                            WHERE (d.kind = 'trees' OR (d.kind = 'greenery' AND d.payload->>'t' = ANY($5::text[])))
                              AND d.geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)) AS covered`,
            [w, s, e, n, TREE_BEARING_GREENERY]);
        return rows[0]?.covered === true;
    }

    // Mapped trees and green areas from OpenStreetMap live, planted by the same query. A box wider
    // than the live source takes is read around its centre.
    async function live(geometry, bufferMeters, shared) {
        let [w, s, e, n] = bufferedBbox(geometry, bufferMeters);
        const half = TREES_MAX_SPAN_DEG * 0.99 / 2, cx = (w + e) / 2, cy = (s + n) / 2;
        w = Math.max(w, cx - half); e = Math.min(e, cx + half); s = Math.max(s, cy - half); n = Math.min(n, cy + half);
        const osm = await fetchTrees([w, s, e, n]);
        const mapped = [], green = [];
        for (const feature of osm.features) {
            if (feature.geometry?.type === 'Point') mapped.push(feature.geometry.coordinates);
            else if (feature.properties?.kind === 'greenery') green.push(feature.geometry);
        }
        const { rows } = await pool.query(plantingSql('given'), [...shared, JSON.stringify(mapped), JSON.stringify(green)]);
        const trees = toTrees(rows);
        return { trees, count: trees.length, scope: null, source: 'overpass', ...(osm.partial ? { partial: true } : {}) };
    }

    return { near };
}
