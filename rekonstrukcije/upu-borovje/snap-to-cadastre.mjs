#!/usr/bin/env node
// Snap the UPU Borovje plan's outer boundary to the cadastre, and publish the corrected members as new records.
//
// The first reconstruction took the plan extent from the traced plan sheet and read its boundary line about
// 3 m too wide (the traced edge runs 2.4–3.3 m outside the drawn obuhvat line, all the way round). So every
// neighbouring parcel lost a jagged 1–15 % strip to the plan, and the collector's 19 m cross-section ran into
// the gardens south of it. The drawn boundary follows parcel lines, so the corrected extent is made of whole
// cadastral parcels: a parcel is in when the plan holds its body, out when the plan only holds a strip of it.
// Only parcels the plan genuinely divides (the large city parcel 1791/69, the old road 4302/4, …) keep a cut,
// along the traced line moved back onto the drawn one. Inside the extent nothing moves except where the
// boundary did: plots, street land and parks lose the strips. The collector, whose centre line had run along
// the southern edge of its band, is re-centred in the band as plan sheet 2a draws it, so its cross-section
// fits between the plots and the edge; the crossings that end on it move with it.
//
// Named plans never change (plans.md), so nothing existing is edited. The corrected members are published as
// new records `<proposal_id>-v2` (revisionOf the original) and named as new plan versions by name-plans.mjs.
//
//   PGHOST=127.0.0.1 node snap-to-cadastre.mjs --compute        # local PostGIS → data/cadastral-snap.json
//   node snap-to-cadastre.mjs --backend <api> --origin <app> [--apply]
import os from 'node:os';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';
import { publish, request } from '../../backend/scripts/lib/candlestick-common.mjs';
import { canonicalSeedRecord } from '../../backend/scripts/lib/canonical-seed-record.mjs';
import { REPAIR_VERSION, revisedRecord } from '../../backend/scripts/lib/borovje-revision.mjs';

const require = createRequire(new URL('../../backend/package.json', import.meta.url));
const log = message => console.log(`[${new Date().toISOString()}] ${message}`);
const SNAP_FILE = new URL('./data/cadastral-snap.json', import.meta.url);

// The rule, in metres (EPSG:3765). INSET_M: how far the traced edge sits outside the drawn boundary
// (measured on 22 neighbouring parcels: 2.4–3.3 m). CORE_M: a part of a parcel narrower than 2 × CORE_M
// is a strip, not a body. NARROW_KEEP_M2: a footpath-wide parcel crossing the edge keeps its inside part
// only when that part is at least this big. CLOSE_M closes hairline slits between neighbouring pieces.
// SMOOTH_CUT_M: how far a cut through a divided parcel may straighten the traced line. MIN_REMAINDER_M2: a
// divided parcel's remainder smaller than this is a scrap and goes to the plan.
export const RULE = Object.freeze({ INSET_M: 3, CORE_M: 2, NARROW_KEEP_M2: 10, CLOSE_M: 0.25, MIN_PART_M2: 50, SMOOTH_CUT_M: 1, MIN_REMAINDER_M2: 100, CLEARANCE_MARGIN_M: 0.25 });
const LAYOUTS = ['p-upu-borovje-parcelacija', 'p-upu-borovje-parcelacija-2', 'p-upu-borovje-parcelacija-3'];
const ROADS = ['upu-borovje-ulice', 'upu-borovje-ulice-split-1'];
const PARKS = ['upu-borovje-r2-0', ...Array.from({ length: 5 }, (_, i) => `upu-borovje-z1-${i + 1}`)];
const BUILDINGS = Array.from({ length: 11 }, (_, i) => `upu-borovje-m1-${i + 1}`);
const COLLECTOR = 'upu-sabirna-ulica';

const { values } = parseArgs({ options: {
    compute: { type: 'boolean' }, backend: { type: 'string' }, origin: { type: 'string' },
    apply: { type: 'boolean' }, help: { type: 'boolean' }
} });
if (values.help || (!values.compute && !values.backend)) {
    console.log(`Usage:
  PGHOST=127.0.0.1 node snap-to-cadastre.mjs --compute     # from the local rows + cadastre → data/cadastral-snap.json
  node snap-to-cadastre.mjs --backend <api> --origin <app> [--apply]
--compute reads the original rows and parcels through backend/.env (PG*), validates the result and writes the
file; it changes no row. The publish step is a dry run unless --apply; existing -v2 records are left alone.`);
    process.exit(0);
}

const geometryOf = value => (value?.type === 'Feature' ? value.geometry : value);

// ---------------------------------------------------------------------------------------------------------
// --compute: everything geometric happens here, once, in PostGIS; the result is committed and replayed.
// ---------------------------------------------------------------------------------------------------------
async function compute() {
    require('dotenv').config({ path: new URL('../../backend/.env', import.meta.url).pathname, quiet: true });
    const { Pool } = require('pg');
    const pool = new Pool({ max: 1, ...(process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : {}) });
    const db = await pool.connect();
    const q = (sql, params) => db.query(sql, params);
    try {
        const { rows: [{ schema }] } = await q(`SELECT table_schema AS schema FROM information_schema.tables
            WHERE table_name = 'proposal' AND table_schema IN ('public', 'consensus') ORDER BY table_schema = 'public' DESC LIMIT 1`);
        const ids = [...LAYOUTS, ...ROADS, ...PARKS, ...BUILDINGS];
        const { rows } = await q(`SELECT proposal_id, reparcellization, road_proposal, structure_proposal,
            ST_AsGeoJSON(site, 15) AS site FROM ${schema}.proposal WHERE proposal_id = ANY($1)`, [ids]);
        if (rows.length !== ids.length) throw new Error(`expected ${ids.length} Borovje rows, found ${rows.length}`);
        const byId = new Map(rows.map(row => [row.proposal_id, row]));

        // Pieces of ground: the 17 plots and the two street polygons. Together they are the plan's extent.
        await q('CREATE TEMP TABLE piece (key text PRIMARY KEY, member text, owner text, g geometry(Geometry, 4326), ng geometry)');
        for (const id of LAYOUTS) {
            for (const polygon of byId.get(id).reparcellization.polygons) {
                await q('INSERT INTO piece (key, member, owner, g) VALUES ($1, $2, $3, ST_SetSRID(ST_GeomFromGeoJSON($4), 4326))',
                    [`${id}#${polygon.ownerKey}`, id, polygon.ownerKey, JSON.stringify(geometryOf(polygon.geometry))]);
            }
        }
        for (const id of ROADS) {
            await q('INSERT INTO piece (key, member, owner, g) VALUES ($1, $2, NULL, ST_SetSRID(ST_GeomFromGeoJSON($3), 4326))',
                [id, id, JSON.stringify(geometryOf(byId.get(id).road_proposal.definition.polygon))]);
        }

        // E0: the traced extent. E1: E0 moved back onto the drawn boundary. E2: the cadastral extent.
        await q(`CREATE TEMP TABLE e0 AS SELECT ST_Buffer(ST_Buffer(ST_Transform(ST_Union(g), 3765), $1::float8, 'join=mitre'), -$1::float8, 'join=mitre') AS g FROM piece`, [RULE.CLOSE_M]);
        await q(`CREATE TEMP TABLE parcel_cut AS
            -- E1 cuts the parcels the plan divides, so it is drawn as a line would be: square corners, and
            -- simplified to SMOOTH_CUT_M so the cut does not carry the raster trace's wobble.
            WITH e AS (SELECT g AS e0, ST_SimplifyPreserveTopology(ST_Buffer(g, -$1::float8, 'join=mitre'), $4::float8) AS e1 FROM e0),
            p AS (SELECT c.maticni_broj_ko || '-' || c.broj_cestice AS parcel, c.geom, e.e0, e.e1,
                         ST_IsEmpty(ST_Buffer(c.geom, -$2::float8)) AS narrow
                  FROM public.parcel c, e WHERE c.current AND c.geom && e.e0 AND ST_Area(ST_Intersection(c.geom, e.e0)) > 0.01),
            -- the body of the parcel that lies outside the drawn boundary (strips narrower than 2 × CORE_M are not a body)
            -- (and of a parcel the plan holds most of, a remainder under MIN_REMAINDER_M2 is a scrap it would not leave)
            o AS (SELECT *, (SELECT ST_UnaryUnion(ST_Collect(d.geom)) FROM ST_Dump(ST_Intersection(ST_Buffer(ST_Buffer(ST_Difference(geom, e1), -$2::float8), $2::float8), geom)) d
                             WHERE ST_Area(d.geom) >= $5::float8 OR ST_Area(ST_Intersection(p.geom, p.e1)) < 0.5 * ST_Area(p.geom)) AS outside_body FROM p),
            k AS (SELECT parcel, geom, narrow, e1, ST_Area(ST_Intersection(geom, e0)) / ST_Area(geom) AS traced_share,
                         (SELECT ST_UnaryUnion(ST_Collect(d.geom)) FROM ST_Dump(CASE WHEN outside_body IS NULL THEN geom ELSE ST_Difference(geom, outside_body) END) d
                          WHERE NOT ST_IsEmpty(ST_Buffer(d.geom, -$2::float8))) AS inside_body
                  FROM o)
            SELECT parcel, geom, traced_share,
                   CASE WHEN narrow THEN CASE WHEN ST_Area(ST_Intersection(geom, e1)) >= $3::float8
                                              THEN CASE WHEN traced_share >= 0.999 THEN geom ELSE ST_Intersection(geom, e1) END END
                        WHEN inside_body IS NULL THEN NULL
                        WHEN ST_Area(inside_body) >= 0.999 * ST_Area(geom) THEN geom
                        ELSE inside_body END AS kept
            FROM k`, [RULE.INSET_M, RULE.CORE_M, RULE.NARROW_KEEP_M2, RULE.SMOOTH_CUT_M, RULE.MIN_REMAINDER_M2]);
        await q(`CREATE TEMP TABLE e2 AS
            WITH u AS (SELECT ST_Buffer(ST_Buffer(ST_UnaryUnion(ST_Collect(kept)), $1::float8, 'join=mitre'), -$1::float8, 'join=mitre') AS g FROM parcel_cut WHERE kept IS NOT NULL),
            parts AS (SELECT (ST_Dump(g)).geom AS g FROM u)
            SELECT ST_Multi(ST_Union(ST_MakePolygon(ST_ExteriorRing(g), ARRAY(SELECT ST_ExteriorRing(r.geom) FROM ST_DumpRings(g) r
                       WHERE r.path[1] > 0 AND ST_Area(r.geom) >= $2::float8)))) AS g
            FROM parts WHERE ST_Area(g) >= $2::float8`, [RULE.CLOSE_M, RULE.MIN_PART_M2]);
        const { rows: [extent] } = await q('SELECT ST_NumGeometries(g) AS parts, ST_Area(g) AS m2, (SELECT ST_Area(g) FROM e0) AS traced_m2 FROM e2');
        if (extent.parts !== 1) throw new Error(`the cadastral extent has ${extent.parts} parts, expected one`);
        await q('ALTER TABLE e2 ADD COLUMN g4326 geometry; UPDATE e2 SET g4326 = ST_Transform(g, 4326)');

        // Every piece keeps what lies inside E2 (in its own coordinates, so shared edges stay shared) ...
        await q(`UPDATE piece SET ng = (SELECT ST_UnaryUnion(ST_Collect(d.geom)) FROM ST_Dump(ST_CollectionExtract(ST_Intersection(piece.g, e2.g4326), 3)) d
            WHERE ST_Area(ST_Transform(d.geom, 3765)) >= 0.5) FROM e2`);
        const broken = (await q(`SELECT key, ST_NumGeometries(ng) AS n FROM piece WHERE ng IS NULL OR ST_NumGeometries(ng) > 1`)).rows;
        if (broken.length) throw new Error(`pieces lost or split by the cadastral extent: ${broken.map(r => `${r.key}(${r.n ?? 0})`).join(', ')}`);
        // ... and the cadastral fill outside the traced extent goes to the piece it shares the longest edge with.
        const added = (await q(`WITH a AS (SELECT (ST_Dump(ST_Difference(e2.g4326, (SELECT ST_Union(ng) FROM piece)))).geom AS g FROM e2)
            SELECT ST_AsGeoJSON(g, 15) AS g, ST_Area(ST_Transform(g, 3765)) AS m2,
                   (SELECT key FROM piece ORDER BY ST_Length(ST_Transform(ST_Intersection(ST_Boundary(a.g), ST_Buffer(piece.ng, 1e-7)), 3765)) DESC LIMIT 1) AS key
            FROM a WHERE ST_Area(ST_Transform(g, 3765)) >= 0.01`)).rows;
        for (const add of added) {
            await q(`UPDATE piece SET ng = ST_UnaryUnion(ST_Collect(ng, ST_SetSRID(ST_GeomFromGeoJSON($2), 4326))) WHERE key = $1`, [add.key, add.g]);
        }

        // Fabric checks: the pieces tile E2 with no gap or overlap, and each piece stays one polygon.
        const { rows: [fabric] } = await q(`SELECT
              ST_Area(ST_Difference((SELECT g FROM e2), ST_Transform(ST_Union(ng), 3765))) AS gap_m2,
              SUM(ST_Area(ST_Transform(ng, 3765))) - ST_Area(ST_Transform(ST_Union(ng), 3765)) AS overlap_m2,
              MAX(ST_NumGeometries(ST_Multi(ng))) AS max_parts FROM piece`);
        if (fabric.gap_m2 > 0.5 || fabric.overlap_m2 > 0.5 || fabric.max_parts > 1) {
            throw new Error(`fabric check failed: gap ${fabric.gap_m2} m², overlap ${fabric.overlap_m2} m², parts ${fabric.max_parts}`);
        }
        // Every official building must still stand on its plot.
        const homeless = (await q(`SELECT b.proposal_id, ST_Area(ST_Transform(ST_Difference(b.site, p.ng), 3765)) AS outside_m2
            FROM ${schema}.proposal b JOIN piece p ON p.owner = replace(b.proposal_id, 'upu-borovje-', '')
            WHERE b.proposal_id = ANY($1) AND ST_Area(ST_Transform(ST_Difference(b.site, p.ng), 3765)) > 0.01`, [BUILDINGS])).rows;
        if (homeless.length) throw new Error(`buildings leave their plots: ${homeless.map(r => `${r.proposal_id} ${Number(r.outside_m2).toFixed(2)} m²`).join(', ')}`);

        // The collector's cross-section must lie between the plots and the corrected edge. Plan sheet 2a draws
        // the collector as a hatched band from the plots to the plan boundary, with its axis down the middle;
        // the traced centre line ran along the band's southern edge instead, so the cross-section took the
        // gardens beyond it. So the line is re-centred: stations every STATION_M (and at every vertex) move
        // towards the middle between the plots and the corrected edge; the shifts are smoothed along the line
        // and taper to zero over RAMP_M towards the ends, where the street meets the city streets outside the
        // plan, then clamped so the cross-section clears both sides wherever the band is wide enough. A few
        // passes, because each station moves along its own local direction. Where the band is narrower than
        // the street (the plan's boundary steps in around a parcel it leaves alone), the street narrows: that
        // stretch becomes its own segment whose profile drops the verges. A junction vertex is shared with a
        // crossing, which moves with it.
        const main = byId.get(ROADS[0]).road_proposal.definition;
        const collectorIndex = main.segmentIds.indexOf(COLLECTOR);
        const halfOf = strips => strips.reduce((sum, strip) => sum + strip.width, 0) / 2;
        const fullStrips = main.segmentProfiles[COLLECTOR].strips;
        const narrowStrips = fullStrips.filter(strip => strip.type !== 'verge');
        const NARROW_ID = `${COLLECTOR}-suzenje`;
        const AFTER_ID = `${COLLECTOR}-2`;
        const END_M = 15;
        const RAMP_M = 25;
        const SMOOTH_M = 15;
        const STATION_M = 5;
        const SIMPLIFY_M = 0.75;
        const PASSES = 3;
        const PINCH_PAD_M = 10;
        const collector = main.segments[collectorIndex];
        const junctionKeys = new Set(main.segments.flatMap((segment, i) => (i === collectorIndex ? [] : [segment[0], segment[segment.length - 1]]))
            .map(point => `${point.lat},${point.lng}`));
        const junctions = collector.filter(point => junctionKeys.has(`${point.lat},${point.lng}`));
        await q(`CREATE TEMP TABLE plot_union AS SELECT ST_Transform(ST_Union(ng), 3765) AS g FROM piece WHERE owner IS NOT NULL`);
        // Parcels the streets' land does not reach. A street takes exactly its land polygon (the app's
        // footprint of it; the parcel list published with it is derived from that polygon). Its lanes are drawn
        // from the centre line and profile, so lanes over any of these parcels are drawn over ground the street
        // does not take.
        await q(`CREATE TEMP TABLE untouched AS WITH street AS (SELECT ST_Transform(ST_Union(ng), 3765) AS g FROM piece WHERE owner IS NULL)
            SELECT c.maticni_broj_ko || '-' || c.broj_cestice AS parcel, c.geom FROM public.parcel c, e2, street
            WHERE c.current AND c.geom && ST_Expand(e2.g, 50) AND ST_Area(ST_Intersection(c.geom, street.g)) < 0.25`);
        await q('CREATE TEMP TABLE pinch_zone (g geometry)');
        const lineSql = `ST_SetSRID(ST_MakeLine(ARRAY(SELECT ST_MakePoint((v->>'x')::float8, (v->>'y')::float8) FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY AS t(v, o) ORDER BY o)), 3765)`;
        const toLocal = async points => (await q(`SELECT ST_X(p) AS x, ST_Y(p) AS y FROM (SELECT ST_Transform(ST_SetSRID(ST_MakePoint((v->>'lng')::float8, (v->>'lat')::float8), 4326), 3765) AS p, o
            FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY AS t(v, o)) s ORDER BY o`, [JSON.stringify(points)])).rows.map(r => ({ x: r.x, y: r.y }));
        const recentre = async lineXY => {
            const stations = (await q(`WITH l AS (SELECT ${lineSql} AS g), l2 AS (SELECT g, ST_Length(g) AS len FROM l),
                d AS (SELECT n::float8 AS d FROM l2, generate_series(0::numeric, l2.len::numeric, $2::numeric) n
                      UNION SELECT ST_LineLocatePoint(l2.g, v.geom) * l2.len FROM l2, ST_DumpPoints(l2.g) v
                      UNION SELECT len FROM l2),
                s AS (SELECT d.d, ST_LineInterpolatePoint(l2.g, LEAST(1, d.d / l2.len)) AS p, l2.len FROM d, l2),
                m AS (SELECT s.d, s.p, s.len, CASE WHEN ST_Intersects(e2.g, s.p) THEN 1 ELSE -1 END * ST_Distance(s.p, ST_Boundary(e2.g)) AS edge_m,
                             ST_Distance(s.p, plot_union.g) AS plots_m, EXISTS (SELECT 1 FROM pinch_zone z WHERE ST_Intersects(z.g, s.p)) AS narrow,
                             ST_ClosestPoint(ST_Boundary(e2.g), s.p) AS c, ST_ClosestPoint(plot_union.g, s.p) AS cp FROM s, e2, plot_union)
                SELECT d, len, edge_m, plots_m, narrow, ST_X(p) AS x, ST_Y(p) AS y, (plots_m - edge_m) / 2 AS centre_shift,
                       ST_X(cp) - ST_X(c) AS ux, ST_Y(cp) - ST_Y(c) AS uy
                FROM m ORDER BY d`, [JSON.stringify(lineXY), STATION_M])).rows;
            // taper towards the ends, then a moving average over ±SMOOTH_M
            const ramp = st => Math.max(0, Math.min(1, (Math.min(st.d, st.len - st.d) - END_M) / RAMP_M));
            for (const st of stations) {
                const window = stations.filter(o => Math.abs(o.d - st.d) <= SMOOTH_M);
                st.shift = window.reduce((sum, o) => sum + o.centre_shift * ramp(o), 0) / window.length;
            }
            // the hard limit: the cross-section this station carries (plus what simplifying may give back)
            // clears both sides where the band allows it; where it does not, the station goes to the middle
            for (const st of stations) {
                if (ramp(st) === 0) continue;
                const clear = halfOf(st.narrow ? narrowStrips : fullStrips) + RULE.CLEARANCE_MARGIN_M + SIMPLIFY_M;
                const minShift = clear - st.edge_m;
                const maxShift = st.plots_m - clear;
                st.shift = minShift <= maxShift ? Math.min(Math.max(st.shift, minShift), maxShift) : st.centre_shift;
            }
            return {
                maxShift: Math.max(...stations.map(st => Math.abs(st.shift))),
                points: stations.map(st => {
                    const norm = Math.hypot(st.ux, st.uy) || 1;
                    return { x: st.x + st.ux / norm * st.shift, y: st.y + st.uy / norm * st.shift };
                })
            };
        };
        // Where the full cross-section, wherever it is placed, still covers land the plan leaves alone.
        const findPinch = async lineXY => (await q(`WITH l AS (SELECT ${lineSql} AS g),
                over AS (SELECT (ST_Dump(ST_Intersection(ST_Buffer(l.g, $2::float8, 'endcap=flat'), u.geom))).geom AS g, l.g AS line, ST_Length(l.g) AS len
                         FROM l, untouched u WHERE ST_Intersects(ST_Buffer(l.g, $2::float8, 'endcap=flat'), u.geom))
            SELECT ST_AsEWKT(g) AS g, ST_LineLocatePoint(line, ST_Centroid(g)) * len AS along, len FROM over WHERE ST_Area(g) >= 0.25`,
            [JSON.stringify(lineXY), halfOf(fullStrips)])).rows.filter(r => r.along > END_M && r.along < r.len - END_M);

        let lineXY = await toLocal(collector);
        let maxShift = 0;
        let pinches = [];
        for (let pass = 0; pass < PASSES; pass++) {
            const result = await recentre(lineXY);
            lineXY = result.points;
            maxShift = Math.max(maxShift, result.maxShift);
            if (pass === 0) {
                pinches = await findPinch(lineXY);
                for (const pinch of pinches) {
                    await q(`INSERT INTO pinch_zone SELECT ST_Buffer(ST_GeomFromEWKT($1), $2::float8)`, [pinch.g, PINCH_PAD_M + halfOf(fullStrips)]);
                }
            }
        }
        // Simplify, then make sure every junction, and both ends of a narrowed stretch, are vertices.
        let line = (await q(`SELECT ST_X(v.geom) AS x, ST_Y(v.geom) AS y FROM ST_DumpPoints(ST_Simplify(${lineSql}, $2::float8)) v ORDER BY v.path`,
            [JSON.stringify(lineXY), SIMPLIFY_M])).rows;
        const insertAt = (x, y, at) => {
            let along = 0;
            let index = 0;
            for (; index < line.length - 1; index++) {
                const length = Math.hypot(line[index + 1].x - line[index].x, line[index + 1].y - line[index].y);
                if (along + length >= at) break;
                along += length;
            }
            const existing = [index, index + 1].find(i => line[i] && Math.hypot(line[i].x - x, line[i].y - y) < 0.01);
            if (existing === undefined) line = [...line.slice(0, index + 1), { x, y }, ...line.slice(index + 1)];
        };
        const junctionMoves = new Map();
        for (const junction of junctions) {
            const { rows: [j] } = await q(`WITH old AS (SELECT ST_Transform(ST_SetSRID(ST_MakePoint($2::float8, $3::float8), 4326), 3765) AS p), l AS (SELECT ${lineSql} AS g)
                SELECT ST_X(ST_ClosestPoint(l.g, old.p)) AS x, ST_Y(ST_ClosestPoint(l.g, old.p)) AS y, ST_LineLocatePoint(l.g, old.p) * ST_Length(l.g) AS along,
                       ST_Distance(l.g, old.p) AS moved_m FROM l, old`, [JSON.stringify(line), junction.lng, junction.lat]);
            insertAt(j.x, j.y, j.along);
            junctionMoves.set(`${junction.lat},${junction.lng}`, { x: j.x, y: j.y, movedM: j.moved_m });
        }
        let narrowRange = null;
        if (pinches.length) {
            const { rows: [range] } = await q(`WITH l AS (SELECT ${lineSql} AS g), i AS (SELECT ST_Intersection(l.g, (SELECT ST_Union(g) FROM pinch_zone)) AS g, l.g AS line FROM l)
                SELECT ST_LineLocatePoint(line, ST_StartPoint(ST_LineMerge(g))) * ST_Length(line) AS a, ST_LineLocatePoint(line, ST_EndPoint(ST_LineMerge(g))) * ST_Length(line) AS b,
                       ST_X(ST_StartPoint(ST_LineMerge(g))) AS ax, ST_Y(ST_StartPoint(ST_LineMerge(g))) AS ay, ST_X(ST_EndPoint(ST_LineMerge(g))) AS bx, ST_Y(ST_EndPoint(ST_LineMerge(g))) AS by,
                       ST_GeometryType(ST_LineMerge(g)) AS type FROM i`, [JSON.stringify(line)]);
            if (range.type !== 'ST_LineString') throw new Error(`the narrowed stretch is not one piece of the collector (${range.type})`);
            insertAt(range.ax, range.ay, range.a);
            insertAt(range.bx, range.by, range.b);
            narrowRange = { from: { x: range.ax, y: range.ay }, to: { x: range.bx, y: range.by }, fromM: Math.round(range.a), toM: Math.round(range.b) };
        }
        const toLatLng = async points => (await q(`SELECT ST_X(p) AS lng, ST_Y(p) AS lat FROM (SELECT ST_Transform(ST_SetSRID(ST_MakePoint((v->>'x')::float8, (v->>'y')::float8), 3765), 4326) AS p, o
            FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY AS t(v, o)) s ORDER BY o`, [JSON.stringify(points)])).rows
            .map(r => ({ lat: Number(r.lat.toFixed(7)), lng: Number(r.lng.toFixed(7)) }));
        const latLng = await toLatLng(line);
        // Unmoved vertices keep their exact original coordinates (the ends always do).
        const newCollector = line.map((v, i) => collector.find(o => Math.abs(o.lat - latLng[i].lat) < 2e-7 && Math.abs(o.lng - latLng[i].lng) < 2e-7) || latLng[i]);
        newCollector[0] = collector[0];
        newCollector[newCollector.length - 1] = collector[collector.length - 1];
        const vertexAt = xy => line.findIndex(v => Math.abs(v.x - xy.x) < 0.01 && Math.abs(v.y - xy.y) < 0.01);
        const junctionLatLng = new Map([...junctionMoves].map(([key, j]) => [key, newCollector[vertexAt(j)]]));
        const segments = main.segments.map((segment, i) => (i === collectorIndex ? newCollector
            : segment.map(point => junctionLatLng.get(`${point.lat},${point.lng}`) || point)));
        const segmentIds = [...main.segmentIds];
        const segmentProfiles = structuredClone(main.segmentProfiles);
        if (narrowRange) {
            // the collector becomes three segments: up to the narrowing, the narrowed stretch, and the rest
            const a = vertexAt(narrowRange.from);
            const b = vertexAt(narrowRange.to);
            segments[collectorIndex] = newCollector.slice(0, a + 1);
            segments.push(newCollector.slice(a, b + 1), newCollector.slice(b));
            segmentIds.push(NARROW_ID, AFTER_ID);
            segmentProfiles[NARROW_ID] = { ...structuredClone(main.segmentProfiles[COLLECTOR]), strips: structuredClone(narrowStrips) };
            segmentProfiles[AFTER_ID] = structuredClone(main.segmentProfiles[COLLECTOR]);
        }
        const moves = { maxShiftM: Number(maxShift.toFixed(2)), verticesBefore: collector.length, verticesAfter: newCollector.length,
            junctionsMovedM: [...junctionMoves.values()].map(j => Number(j.movedM.toFixed(2))),
            narrowed: narrowRange ? { fromM: narrowRange.fromM, toM: narrowRange.toM, widthM: 2 * halfOf(narrowStrips) } : null };

        // Corridors (centre line ± half of each segment's own profile) as one table, for the checks below.
        const corridorTable = async (name, definitionSegments, ids, profiles) => {
            const lines = definitionSegments.map((segment, index) => ({
                line: { type: 'LineString', coordinates: segment.map(p => [p.lng, p.lat]) }, half: halfOf(profiles[ids[index]].strips) }));
            await q(`CREATE TEMP TABLE ${name} AS SELECT ST_Union(ST_Buffer(ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(x->>'line'), 4326), 3765), (x->>'half')::float8, 'endcap=flat')) AS g
                FROM jsonb_array_elements($1::jsonb) x`, [JSON.stringify(lines)]);
        };
        const corridorFit = async (name, extentTable) => {
            const { rows: [r] } = await q(`SELECT ST_Area(ST_Difference(c.g, e.g)) AS outside_m2, ST_Area(ST_Intersection(c.g, plot_union.g)) AS on_plots_m2
                FROM ${name} c, ${extentTable} e, plot_union`);
            return { outsideM2: Math.round(r.outside_m2), onPlotsM2: Math.round(r.on_plots_m2) };
        };
        await corridorTable('corridor_before', main.segments, main.segmentIds, main.segmentProfiles);
        await corridorTable('corridor_after', segments, segmentIds, segmentProfiles);
        const corridor = { before: { traced: await corridorFit('corridor_before', 'e0'), cadastral: await corridorFit('corridor_before', 'e2') },
            after: await corridorFit('corridor_after', 'e2') };
        // The hard check: lanes must lie on the street's own land. Where the collector meets the city streets
        // at its two ends its lanes run on onto them, which is reported (a join); anywhere else it is refused.
        const { rows: [ends] } = await q(`SELECT ST_AsEWKT(ST_Buffer(ST_Collect(ST_StartPoint(l.g), ST_EndPoint(l.g)), $2::float8)) AS g FROM (SELECT ${lineSql} AS g) l`,
            [JSON.stringify(line), END_M + halfOf(fullStrips)]);
        const covered = (await q(`SELECT u.parcel, ST_Area(ST_Intersection(c.g, u.geom)) AS m2, ST_Within(ST_Intersection(c.g, u.geom), ST_GeomFromEWKT($1)) AS at_end
            FROM corridor_after c, untouched u WHERE ST_Intersects(c.g, u.geom) AND ST_Area(ST_Intersection(c.g, u.geom)) >= 0.25 ORDER BY 2 DESC`, [ends.g])).rows;
        const refused = covered.filter(c => !c.at_end);
        if (refused.length) throw new Error(`street lanes run onto parcels the street's land does not reach: ${refused.map(c => `${c.parcel} ${Number(c.m2).toFixed(1)} m²`).join(', ')}`);
        corridor.joins = covered.map(c => ({ parcel: c.parcel, m2: Number(Number(c.m2).toFixed(1)) }));

        // An unchanged piece keeps its original coordinates exactly (an intersection rewrites them).
        const pieces = (await q(`SELECT key, member, owner, ST_AsGeoJSON(CASE WHEN ST_Equals(g, ng) THEN g ELSE ng END, 15) AS g,
            ST_Area(ST_Transform(ng, 3765)) AS m2, ST_Equals(g, ng) AS same FROM piece ORDER BY key`)).rows;
        const members = {};
        for (const id of LAYOUTS) {
            const own = pieces.filter(p => p.member === id);
            if (own.every(p => p.same)) continue;
            const { rows: [poolRow] } = await q(`SELECT ST_AsGeoJSON(ST_Union(ng), 15) AS g FROM piece WHERE member = $1`, [id]);
            members[id] = { pool: JSON.parse(poolRow.g), plots: Object.fromEntries(own.map(p => [p.owner, { geometry: JSON.parse(p.g), m2: Number(p.m2.toFixed(1)) }])) };
        }
        for (const id of ROADS) {
            const own = pieces.find(p => p.member === id);
            const moved = id === ROADS[0] && moves.maxShiftM > 0;
            if (own.same && !moved) continue;
            members[id] = { polygon: JSON.parse(own.g), ...(moved ? { segments, segmentIds, segmentProfiles } : {}) };
        }
        for (const id of PARKS) {
            const owner = id.replace('upu-borovje-', '').replace('r2-0', 'r2-1');
            const plot = pieces.find(p => p.owner === owner);
            if (!plot.same) members[id] = { geometry: JSON.parse(plot.g) };
        }
        const cut = (await q(`SELECT parcel, round(100 * traced_share) AS traced_pct,
                CASE WHEN kept IS NULL THEN 'out' WHEN ST_Equals(kept, geom) THEN 'whole' ELSE 'cut ' || round(100 * ST_Area(kept) / ST_Area(geom)) || '%' END AS verdict
            FROM parcel_cut WHERE traced_share < 0.999 ORDER BY verdict, parcel`)).rows;
        const result = {
            comment: 'Generated by snap-to-cadastre.mjs --compute. The corrected UPU Borovje members (geometry in EPSG:4326); replayed by its publish step.',
            repair: REPAIR_VERSION,
            rule: RULE,
            extent: { tracedM2: Math.round(extent.traced_m2), cadastralM2: Math.round(extent.m2),
                geometry: JSON.parse((await q('SELECT ST_AsGeoJSON(g4326, 15) AS g FROM e2')).rows[0].g) },
            fabric: { gapM2: Number(fabric.gap_m2.toFixed(3)), overlapM2: Number(fabric.overlap_m2.toFixed(3)) },
            addedToPieces: added.map(a => ({ key: a.key, m2: Number(a.m2.toFixed(2)) })),
            corridor,
            collector: moves,
            boundaryParcels: cut,
            members
        };
        await writeFile(SNAP_FILE, `${JSON.stringify(result, null, 1)}\n`);
        log(`extent ${result.extent.tracedM2} → ${result.extent.cadastralM2} m² · fabric gap ${result.fabric.gapM2} m², overlap ${result.fabric.overlapM2} m²`);
        log(`boundary parcels: ${cut.filter(c => c.verdict === 'out').length} out, ${cut.filter(c => c.verdict === 'whole').length} whole, ${cut.filter(c => c.verdict.startsWith('cut')).length} cut`);
        log(`collector: ${JSON.stringify(moves)}`);
        log(`corridors (m²): ${JSON.stringify(corridor)}`);
        log(`changed members: ${Object.keys(members).join(', ')}`);
        log(`wrote ${SNAP_FILE.pathname}`);
    } finally {
        db.release();
        await pool.end();
    }
}

// ---------------------------------------------------------------------------------------------------------
// publish: replay the committed geometry onto each original record and publish it as `<id>-v2`.
// ---------------------------------------------------------------------------------------------------------
async function publishAll() {
    if (values.apply && !values.origin) throw new Error('--apply needs --origin (the app origin the API accepts writes from)');
    const snap = JSON.parse(await readFile(SNAP_FILE, 'utf8'));
    const origin = values.origin || values.backend;
    const records = [];
    for (const [id, change] of Object.entries(snap.members)) {
        const { status, json } = await request(values.backend, origin, 'GET', `/proposals/${encodeURIComponent(id)}`);
        if (status !== 200) throw new Error(`${values.backend} has no ${id} (${status})`);
        const draft = revisedRecord(json, change);
        const bound = await request(values.backend, origin, 'POST', '/proposals/binding', { site: draft.site, toleranceM: 0, city: 'zagreb', parcelSourceId: null });
        if (bound.status !== 200 || bound.json?.binding?.coverage !== 'complete') {
            throw new Error(`${draft.proposalId}: binding ${bound.status} ${bound.json?.binding?.coverage || bound.text.slice(0, 200)}`);
        }
        const before = new Set(json.cadastreParcelIds || []);
        const after = bound.json.binding.parcels.map(parcel => parcel.parcelId);
        const dropped = [...before].filter(p => !after.includes(p));
        const gained = after.filter(p => !before.has(p));
        log(`${draft.proposalId.padEnd(34)} parcels ${before.size} → ${after.length}${dropped.length ? ` · drops ${dropped.join(' ')}` : ''}${gained.length ? ` · adds ${gained.join(' ')}` : ''}`);
        // validated whole before anything is written; publish() binds again when it writes
        records.push(canonicalSeedRecord({ ...draft, cadastreParcelIds: after }));
    }
    if (!values.apply) { log(`DRY RUN: ${records.length} records not published (add --apply --origin <app>).`); return; }
    const tokenFile = path.join(os.homedir(), '.config', 'ugt', 'edit-tokens', `${new URL(values.backend).host}.json`);
    await mkdir(path.dirname(tokenFile), { recursive: true });
    let tokens = {};
    try { tokens = JSON.parse(await readFile(tokenFile, 'utf8')); } catch (_) { tokens = {}; }
    for (const record of records) {
        const result = await publish(record, { backend: values.backend, origin: values.origin, city: 'zagreb', parcelSourceId: null });
        if (result.editToken) {
            tokens[record.proposalId] = { id: result.id, editToken: result.editToken, createdAt: new Date().toISOString() };
            await writeFile(tokenFile, JSON.stringify(tokens, null, 2), { mode: 0o600 });
        }
    }
    log(`published ${records.length} corrected records · edit tokens in ${tokenFile}`);
}

if (values.compute) await compute();
else await publishAll();
