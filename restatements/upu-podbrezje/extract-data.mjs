#!/usr/bin/env node
// Extracts the UPU Podbrežje restatement's source data (README.md) from the local spatial database into
// the committed data/*.geojson files (EPSG:3765) that podbrezje-designs.mjs builds both plans from:
// the plan's 23 land-use fields named by kazeta, the four built slabs (DGU footprints with GDI heights),
// the permit footprints of A11 and kindergarten C1 (eDozvola), the plan's road land split into the built
// north/east streets and the unbuilt south street, and the built streets' OSM centrelines.
// Reads only; writes no database row.
//
//   node restatements/upu-podbrezje/extract-data.mjs --dry-run   # check and summarise, write nothing
//   node restatements/upu-podbrezje/extract-data.mjs --write     # write data/*.geojson

import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../../backend/package.json', import.meta.url));
require('dotenv').config({ path: fileURLToPath(new URL('../../backend/.env', import.meta.url)), quiet: true });
const { createPool, describeDatabase, isLocalDatabase } = require('./db/connection.cjs');

const PLAN_NAME = 'UPU Podbrežje';
const DATA = new URL('./data/', import.meta.url);
// The plan's kazete by land-use object, matched on the "okvirna površina kazete" tables of the 2007
// decision as amended in 2011 (SGGZ 8/07, 12/11): every field is within 1.5 % of its tabled area, and
// the fields run west to east in label order. The 2017 sale of phase 2 names the remaining kazete.
const KAZETE = Object.freeze({
    1029: { kazeta: 'A1', tableM2: 4343 }, 1023: { kazeta: 'A2', tableM2: 5990 }, 1027: { kazeta: 'A3', tableM2: 4343 },
    1025: { kazeta: 'A4', tableM2: 5990 }, 1028: { kazeta: 'A5', tableM2: 4343 }, 1024: { kazeta: 'A6', tableM2: 5990 },
    1020: { kazeta: 'A7', tableM2: 12325 }, 1022: { kazeta: 'A8', tableM2: 6263 }, 1026: { kazeta: 'A9', tableM2: 5603 },
    1030: { kazeta: 'A10', tableM2: 4018 }, 1021: { kazeta: 'A11', tableM2: 8948 }, 697: { kazeta: 'B', tableM2: 5802 },
    229: { kazeta: 'C1', tableM2: 5014 }, 228: { kazeta: 'C2', tableM2: 4665 }, 254: { kazeta: 'D', tableM2: 16800 },
    201: { kazeta: 'E', tableM2: 5014 }, 1724: { kazeta: 'F1', tableM2: 5015 }, 1723: { kazeta: 'F2', tableM2: 5739 },
    2025: { kazeta: 'G1' }, 2024: { kazeta: 'G2' }, 538: { kazeta: 'G3' }, 1517: { kazeta: 'IS' }, 1518: { kazeta: 'IS-2' }
});
const MAX_TABLE_DEVIATION = 0.015;
// The designs' intrusion allowance (podbrezje-designs.mjs TOLERANCE_M): a parcel the plan's line reaches
// less than this into is not reached.
const TOLERANCE_M = 0.05;
// Phase 1 (ZGH): A3–A6 are built, one DGU building each.
const BUILT_KAZETE = Object.freeze(['A3', 'A4', 'A5', 'A6']);
// Building permits whose footprint the plan's under-construction buildings take (eDozvola building polygons).
const PERMITS = Object.freeze({
    A11: 'P20250320-1728612-Z01', // građevinska dozvola 30. 4. 2025., zgrada A11 (288 stanova)
    C1: 'P20230607-1296406-Z01' // građevinska dozvola, dječji vrtić Podbrežje (10 skupina); građenje od 29. 10. 2024.
});
// The south street begins where the built east street ends: road land below this latitude is the south
// street (the east street's permit, P20221230-1106973-Z01, reaches 45.76499).
const SOUTH_STREET_BELOW_LAT = 45.76515;
const DRIVABLE = ['tertiary', 'unclassified', 'residential', 'service', 'living_street'];

const log = message => console.log(`[${new Date().toISOString()}] ${message}`);

function usage() {
    console.log('Usage: node restatements/upu-podbrezje/extract-data.mjs --dry-run | --write');
}

const featureOf = (geometry, properties) => ({ type: 'Feature', properties, geometry });
const collection = (name, features) => ({ type: 'FeatureCollection', name, crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::3765' } }, features });

async function kazete(pool) {
    const { rows } = await pool.query(`
        SELECT objectid, oznaka, namjena, ST_NumGeometries(geom) AS parts, ST_Area(geom)::float AS area_m2,
               ST_AsGeoJSON(ST_SnapToGrid(ST_GeometryN(geom, 1), 0.01))::json AS geometry
        FROM public.planned_land_use WHERE naziv_plana = $1 ORDER BY objectid`, [PLAN_NAME]);
    if (rows.length !== Object.keys(KAZETE).length) throw new Error(`expected ${Object.keys(KAZETE).length} land-use fields, found ${rows.length}`);
    return rows.map(row => {
        const known = KAZETE[row.objectid];
        if (!known) throw new Error(`land-use object ${row.objectid} is not a known kazeta`);
        if (Number(row.parts) !== 1) throw new Error(`${known.kazeta}: the field has ${row.parts} parts`);
        if (known.tableM2 && Math.abs(row.area_m2 - known.tableM2) / known.tableM2 > MAX_TABLE_DEVIATION) {
            throw new Error(`${known.kazeta}: field ${Math.round(row.area_m2)} m² is not its tabled ${known.tableM2} m²`);
        }
        return featureOf(row.geometry, {
            kazeta: known.kazeta, objectid: Number(row.objectid), oznaka: row.oznaka, namjena: row.namjena,
            areaM2: Math.round(row.area_m2), tableAreaM2: known.tableM2 || null
        });
    });
}

async function builtSlabs(pool, fields) {
    const out = [];
    for (const kazeta of BUILT_KAZETE) {
        const field = fields.find(item => item.properties.kazeta === kazeta);
        const { rows } = await pool.query(`
            SELECT b.zgrada_id, b.broj_zgrade, b.naziv_vrste_zgrade, ST_AsGeoJSON(ST_SnapToGrid(ST_GeometryN(b.geom, 1), 0.01))::json AS geometry,
                   ST_NumGeometries(b.geom) AS parts, gdi.object_id AS gdi_object_id, gdi.height_m, gdi.survey_year
            FROM public.dgu_building b
            LEFT JOIN LATERAL (
                SELECT m.object_id, s.height_m, s.survey_year FROM public.dgu_gdi_building_match m
                JOIN public.gdi_building s ON s.object_id = m.object_id
                WHERE m.zgrada_id = b.zgrada_id ORDER BY m.building_overlap_ratio DESC NULLS LAST, m.overlap_area_m2 DESC LIMIT 1
            ) gdi ON true
            WHERE b.current AND b.area_m2 >= 500
              AND ST_Covers(ST_SetSRID(ST_GeomFromGeoJSON($1), 3765), ST_PointOnSurface(b.geom))`,
        [JSON.stringify(field.geometry)]);
        if (rows.length !== 1 || Number(rows[0].parts) !== 1) throw new Error(`${kazeta}: expected one single-part DGU building, found ${rows.length}`);
        const row = rows[0];
        if (!(Number(row.height_m) > 0)) throw new Error(`${kazeta}: the DGU building has no GDI height`);
        out.push(featureOf(row.geometry, {
            kazeta, dguBuildingId: Number(row.zgrada_id), dguBuildingNumber: row.broj_zgrade, dguBuildingType: row.naziv_vrste_zgrade,
            gdiObjectId: row.gdi_object_id, gdiHeightM: Math.round(Number(row.height_m) * 10) / 10, gdiSurveyYear: Number(row.survey_year) || null
        }));
    }
    return out;
}

async function permitFootprints(pool) {
    const out = [];
    for (const [kazeta, caseId] of Object.entries(PERMITS)) {
        const { rows } = await pool.query(`
            SELECT case_kind, use_kind, received_on::text, final_on::text, ST_AsGeoJSON(ST_SnapToGrid(geom, 0.01))::json AS geometry
            FROM public.edozvola_feature
            WHERE current AND case_id = $1 AND layer = 'eDozvola_building_polygon'
              AND (use_kind LIKE 'mješovite namjene%' OR use_kind LIKE 'javne i društvene namjene%')`, [caseId]);
        if (rows.length !== 1) throw new Error(`${kazeta}: expected one building polygon of ${caseId}, found ${rows.length}`);
        const row = rows[0];
        if (row.geometry.type !== 'Polygon') throw new Error(`${kazeta}: the permit footprint is a ${row.geometry.type}`);
        out.push(featureOf(row.geometry, { kazeta, caseId, caseKind: row.case_kind, useKind: row.use_kind, receivedOn: row.received_on, finalOn: row.final_on }));
    }
    return out;
}

async function roadLand(pool) {
    const { rows } = await pool.query(`
        WITH land AS (SELECT geom FROM public.planned_land_use WHERE naziv_plana = $1 AND objectid = 1517),
        cut AS (SELECT ST_Transform(ST_MakeEnvelope(15.9, 45.7, 16.0, $2, 4326), 3765) AS geom)
        SELECT 'sjever-istok' AS key, ST_AsGeoJSON(ST_SnapToGrid(ST_Difference(land.geom, cut.geom), 0.01))::json AS geometry FROM land, cut
        UNION ALL
        -- The unbuilt south street also takes the slivers (under 0.1 m²) its land cuts off a parcel beside
        -- its main part, so cutting it leaves no parcel in pieces.
        SELECT 'jug', ST_AsGeoJSON(ST_SnapToGrid(ST_UnaryUnion(ST_Collect(street.geom, (
                   SELECT ST_Collect(d.geom) FROM public.parcel c
                   CROSS JOIN LATERAL (SELECT (ST_Dump(ST_CollectionExtract(ST_Difference(c.geom, street.geom), 3))).geom) d
                   WHERE c.current AND c.geom && street.geom AND ST_Intersects(c.geom, street.geom)
                     AND ST_Area(d.geom) < 0.1 AND ST_Area(d.geom) < ST_Area(c.geom) / 2
                     AND ST_Length(ST_CollectionExtract(ST_Intersection(ST_Buffer(d.geom, 0.001), ST_Boundary(street.geom)), 2)) > 0.01))), 0.01))::json
        FROM (SELECT ST_Intersection(land.geom, cut.geom) AS geom FROM land, cut) street`,
    [PLAN_NAME, SOUTH_STREET_BELOW_LAT]);
    return rows.map(row => {
        if (row.geometry.type !== 'Polygon') throw new Error(`road land ${row.key} is a ${row.geometry.type}, not one polygon`);
        return featureOf(row.geometry, { key: row.key });
    });
}

async function builtStreets(pool, northLand) {
    const { rows } = await pool.query(`
        WITH land AS (SELECT ST_SetSRID(ST_GeomFromGeoJSON($1), 3765) AS geom)
        SELECT r.osm_id, r.highway_type, r.name, r.width_meters, r.tags, d.path[1] AS part,
               ST_Length(d.geom)::float AS length_m, ST_AsGeoJSON(ST_SnapToGrid(d.geom, 0.01))::json AS geometry
        FROM public.osm_road r CROSS JOIN land
        CROSS JOIN LATERAL ST_Dump(ST_CollectionExtract(ST_Intersection(r.geom_3765, land.geom), 2)) d
        WHERE r.current AND r.city IN ('croatia', 'zagreb') AND r.highway_type = ANY($2)
          AND r.geom_3765 && land.geom AND ST_Length(d.geom) >= 3
        ORDER BY r.osm_id, d.path[1]`, [JSON.stringify(northLand.geometry), DRIVABLE]);
    if (!rows.length) throw new Error('the built streets have no OSM centreline');
    return rows.map(row => featureOf(row.geometry, {
        id: `osm-${row.osm_id}-${row.part || 1}`, osmWayId: Number(row.osm_id), highway: row.highway_type, name: row.name || null,
        widthMeters: row.width_meters === null ? null : Number(row.width_meters), lengthM: Math.round(row.length_m * 10) / 10, tags: row.tags || {}
    }));
}

// The plan's building plots: one per kazeta (odredbe: "jedna građevna čestica površine kazete").
// A cadastral parcel that already is its kazeta (A3–A6, A11, C1, E, A9, F2) stays as it is; the parcels
// of the built north and east streets are not touched. Every other parcel the kazete reach (more than
// 2 m²) is re-divided by a parcel layout, after the south street has taken its land: the kazete cut from
// that pool are the plots, and what the kazete leave of it goes to the plot it borders longest (or, when
// larger than LEFTOVER_PLOT_M2, becomes a plot of its own).
const MIN_PARENT_OVERLAP_M2 = 2;
// A parcel that lies mostly outside the kazete (a road parcel brushing them, the IS-2 strip) is not
// re-divided: its slivers inside a kazeta stay as they are.
const MIN_PARENT_SHARE = 0.1;
const LEFTOVER_PLOT_M2 = 50;
// The layout is built where the app keeps it: in WGS84 on its 1e-9° grid (geometry-tolerances.js
// GRID_DECIMALS, the grid parcels reach the browser on), so the plots meet the parcels they replace
// exactly and no rounding afterwards opens a gap, an overlap or a crossing between neighbours.
const GRID_DEG = 1e-9;
const GRID_DECIMALS = 9;
async function plots(pool, fields, land) {
    const client = await pool.connect();
    const byKey = key => JSON.stringify(land.find(item => item.properties.key === key).geometry);
    try {
        await client.query('BEGIN');
        await client.query(`
            CREATE TEMP TABLE k ON COMMIT DROP AS
            SELECT f->'properties'->>'kazeta' AS kazeta, f->'properties'->>'oznaka' AS oznaka,
                   ST_SetSRID(ST_GeomFromGeoJSON(f->>'geometry'), 3765) AS geom
            FROM json_array_elements($1::json) f`, [JSON.stringify(fields)]);
        await client.query(`
            CREATE TEMP TABLE cand ON COMMIT DROP AS
            WITH inner_ AS (SELECT ST_Union(geom) AS g FROM k WHERE oznaka <> 'IS'),
                 ne AS (SELECT ST_SetSRID(ST_GeomFromGeoJSON($1), 3765) AS g),
                 south AS (SELECT ST_SetSRID(ST_GeomFromGeoJSON($2), 3765) AS g)
            SELECT c.broj_cestice, c.geom, ST_CollectionExtract(ST_Difference(c.geom, south.g), 3) AS rest
            FROM public.parcel c, inner_, ne, south
            WHERE c.current AND c.geom && inner_.g AND ST_Area(ST_Intersection(c.geom, inner_.g)) >= $3
              AND ST_Area(ST_Intersection(c.geom, inner_.g)) >= $5 * ST_Area(c.geom)
              AND ST_IsEmpty(ST_Buffer(ST_Intersection(c.geom, ne.g), -$4::float / 2))`,
        [byKey('sjever-istok'), byKey('jug'), MIN_PARENT_OVERLAP_M2, TOLERANCE_M, MIN_PARENT_SHARE]);
        const whole = (await client.query(`
            SELECT cand.broj_cestice, k.kazeta, ST_AsGeoJSON(ST_Transform(cand.geom, 4326), ${GRID_DECIMALS})::json AS geometry, ST_NumGeometries(cand.geom) AS parts
            FROM cand JOIN k ON k.oznaka <> 'IS'
            WHERE ST_Area(ST_Intersection(cand.geom, k.geom)) >= 0.995 * ST_Area(cand.geom)
              AND ST_Area(ST_Intersection(cand.geom, k.geom)) >= 0.99 * ST_Area(k.geom)
            ORDER BY k.kazeta`)).rows;
        await client.query(`
            CREATE TEMP TABLE parents ON COMMIT DROP AS
            SELECT * FROM cand
            WHERE broj_cestice <> ALL($1::text[]) AND NOT ST_IsEmpty(rest)
              AND (SELECT count(*) FROM ST_Dump(rest) d WHERE ST_Area(d.geom) >= 0.05) = 1`, [whole.map(row => row.broj_cestice)]);
        await client.query('ALTER TABLE parents ADD COLUMN rest4 geometry');
        await client.query('UPDATE parents SET rest4 = ST_ReducePrecision(ST_Transform(rest, 4326), $1)', [GRID_DEG]);
        await client.query('CREATE TEMP TABLE k4 ON COMMIT DROP AS SELECT kazeta, oznaka, ST_Transform(geom, 4326) AS geom FROM k');
        // The pool is cut by the kazete into faces that tile it exactly: every overlay runs on one grid
        // (GRID_DEG), so neighbouring faces share their vertices and the app's millimetre tiling check
        // holds. A face inside a kazeta is that kazeta's; a face the kazete leave larger than
        // LEFTOVER_PLOT_M2 keeps its body (opened by 5 cm) as a plot of its own; every other face (a sliver
        // between the plan's line and the cadastre's, a body's hairline edge, a kazeta's stray second piece)
        // goes to the plot it shares the longest edge with.
        await client.query(`
            CREATE TEMP TABLE face ON COMMIT DROP AS
            WITH pool AS (SELECT ST_ReducePrecision(ST_Union(rest4), $2) AS g FROM parents),
                 cut AS (SELECT k4.kazeta AS label, ST_CollectionExtract(ST_Intersection(pool.g, k4.geom, $2), 3) AS g
                         FROM k4, pool WHERE k4.oznaka <> 'IS' AND k4.kazeta <> ALL($1::text[])),
                 rest AS (SELECT NULL::text AS label, ST_CollectionExtract(ST_Difference(pool.g, (SELECT ST_Union(g, $2) FROM cut), $2), 3) AS g FROM pool),
                 parts AS (SELECT label, (ST_Dump(g)).geom AS geom FROM (SELECT * FROM cut UNION ALL SELECT * FROM rest) all_)
            SELECT row_number() OVER () AS id, geom, label FROM parts WHERE ST_Area(geom) > 0`, [whole.map(row => row.kazeta), GRID_DEG]);
        // A kazeta cut in more than one piece keeps its largest; the others are leftover faces.
        await client.query(`UPDATE face SET label = NULL FROM (
            SELECT id, row_number() OVER (PARTITION BY label ORDER BY ST_Area(geom) DESC) AS rank FROM face WHERE label IS NOT NULL) r
            WHERE face.id = r.id AND r.rank > 1`);
        // A large leftover face's body and hairlines become faces of their own.
        const bodies = (await client.query(`SELECT id FROM face WHERE label IS NULL AND ST_Area(ST_Transform(geom, 3765)) >= $1`, [LEFTOVER_PLOT_M2])).rows;
        for (const { id } of bodies) {
            await client.query(`
                INSERT INTO face (id, geom, label)
                SELECT -($1::bigint * 1000 + row_number() OVER ()), d.geom, CASE WHEN part.body AND ST_Area(ST_Transform(d.geom, 3765)) >= $2 THEN
                           'ostatak k.č. ' || (SELECT broj_cestice FROM parents ORDER BY ST_Area(ST_Intersection(parents.rest4, d.geom)) DESC LIMIT 1) END
                FROM face,
                     LATERAL (SELECT ST_ReducePrecision(ST_Transform(ST_Buffer(ST_Buffer(ST_Transform(face.geom, 3765), -0.05, 'join=mitre'), 0.05, 'join=mitre'), 4326), $3) AS g) opened,
                     LATERAL (SELECT true AS body, ST_CollectionExtract(ST_Intersection(face.geom, opened.g, $3), 3) AS g
                              UNION ALL SELECT false, ST_CollectionExtract(ST_Difference(face.geom, opened.g, $3), 3)) part,
                     LATERAL ST_Dump(part.g) d
                WHERE face.id = $1 AND ST_Area(d.geom) > 0`, [id, LEFTOVER_PLOT_M2, GRID_DEG]);
            await client.query('DELETE FROM face WHERE id = $1', [id]);
        }
        // Unlabelled faces join the labelled face they share the longest edge with, until none is left.
        for (let pass = 0; ; pass += 1) {
            const { rowCount } = await client.query(`
                UPDATE face SET label = best.label FROM (
                    SELECT DISTINCT ON (u.id) u.id, n.label FROM face u JOIN face n ON n.label IS NOT NULL AND n.geom && u.geom
                    WHERE u.label IS NULL AND ST_Length(ST_CollectionExtract(ST_Intersection(u.geom, n.geom), 2)) > 0
                    -- a kazeta's plot before a leftover plot, so a leftover body never takes back its hairlines
                    ORDER BY u.id, n.label LIKE 'ostatak%', ST_Length(ST_CollectionExtract(ST_Intersection(u.geom, n.geom), 2)) DESC) best
                WHERE face.id = best.id`);
            const left = Number((await client.query('SELECT count(*) FROM face WHERE label IS NULL')).rows[0].count);
            if (!left) break;
            if (!rowCount || pass > 20) {
                // Dust that touches the plots only at a point (beside a parcel that stays as it is) is left
                // out of the layout: narrower than the designs' allowance, it is no ground.
                // A sliver that overlaps a plot by a hair instead of sharing its edge joins that plot.
                const overlapping = await client.query(`
                    UPDATE face SET label = best.label FROM (
                        SELECT DISTINCT ON (u.id) u.id, n.label FROM face u JOIN face n ON n.label IS NOT NULL AND n.geom && u.geom
                        WHERE u.label IS NULL AND ST_Area(ST_CollectionExtract(ST_Intersection(u.geom, n.geom), 3)) > 0
                        ORDER BY u.id, ST_Area(ST_CollectionExtract(ST_Intersection(u.geom, n.geom), 3)) DESC) best
                    WHERE face.id = best.id`);
                if (overlapping.rowCount) continue;
                const dust = (await client.query(`DELETE FROM face WHERE label IS NULL AND ST_IsEmpty(ST_Buffer(ST_Transform(geom, 3765), -$1::float / 2))
                    RETURNING ST_Area(ST_Transform(geom, 3765))::float AS area_m2, ST_AsText(ST_PointOnSurface(geom)) AS at,
                        (SELECT string_agg(broj_cestice, ',') FROM parents WHERE ST_Intersects(rest4, ST_PointOnSurface(face.geom))) AS parcel,
                        (SELECT string_agg(kazeta, ',') FROM k4 WHERE ST_DWithin(k4.geom, face.geom, 0.000001)) AS near`, [TOLERANCE_M])).rows;
                dust.forEach(row => log(`dust face ${row.area_m2.toFixed(4)} m² on k.č. ${row.parcel} at ${row.at} by ${row.near} left out of the layout`));
                const still = Number((await client.query('SELECT count(*) FROM face WHERE label IS NULL')).rows[0].count);
                if (still) throw new Error(`${still} leftover faces wider than ${TOLERANCE_M} m border no plot`);
                break;
            }
        }
        const leftovers = (await client.query(`SELECT label, round(sum(ST_Area(ST_Transform(geom, 3765)))::numeric, 1) AS area_m2 FROM face
            WHERE label LIKE 'ostatak%' GROUP BY label`)).rows;
        leftovers.forEach(row => log(`leftover plot ${row.label}: ${row.area_m2} m²`));
        const labels = (await client.query(`SELECT label, count(*) AS faces, round(sum(ST_Area(ST_Transform(geom, 3765)))::numeric) AS m2 FROM face GROUP BY label ORDER BY label`)).rows;
        log(`faces: ${labels.map(row => `${row.label} ${row.faces}×/${row.m2} m²`).join(', ')}`);
        await client.query(`CREATE TEMP TABLE plot ON COMMIT DROP AS SELECT label AS kazeta, ST_UnaryUnion(ST_Collect(geom), $1) AS geom FROM face GROUP BY label`, [GRID_DEG]);
        // A plot is formed from the parcels it stands on, and the app holds each of its vertices to them:
        // a hairline of a parcel (narrower than 10 cm, where the plan's line runs centimetres off the
        // cadastre's) that the parcel's own plot lies next to moves to that plot, so no plot reaches into a
        // parcel it is not formed from.
        const hairlines = (await client.query(`
            WITH piece AS (
                SELECT plot.kazeta, p.broj_cestice, ST_CollectionExtract(ST_Intersection(plot.geom, p.rest4, $1::float8), 3) AS g
                FROM plot JOIN parents p ON plot.geom && p.rest4),
            sized AS (SELECT *, ST_IsEmpty(ST_Buffer(ST_Transform(g, 3765), -0.05)) AS hair, ST_Area(ST_Transform(g, 3765)) AS m2 FROM piece WHERE NOT ST_IsEmpty(g))
            SELECT h.kazeta AS from_plot, h.broj_cestice, h.m2,
                   (SELECT o.kazeta FROM sized o WHERE o.broj_cestice = h.broj_cestice AND NOT o.hair AND o.kazeta <> h.kazeta ORDER BY o.m2 DESC LIMIT 1) AS to_plot
            FROM sized h WHERE h.hair AND h.m2 > 0
              AND NOT EXISTS (SELECT 1 FROM sized o WHERE o.broj_cestice = h.broj_cestice AND o.kazeta = h.kazeta AND NOT o.hair)`, [GRID_DEG])).rows;
        for (const row of hairlines.filter(item => item.to_plot)) {
            await client.query(`
                WITH piece AS (SELECT ST_CollectionExtract(ST_Intersection(plot.geom, p.rest4, $3::float8), 3) AS g
                               FROM plot, parents p WHERE plot.kazeta = $1 AND p.broj_cestice = $2)
                UPDATE plot SET geom = CASE WHEN plot.kazeta = $1 THEN ST_CollectionExtract(ST_Difference(plot.geom, piece.g, $3::float8), 3)
                                            ELSE ST_CollectionExtract(ST_Union(plot.geom, piece.g, $3::float8), 3) END
                FROM piece WHERE plot.kazeta IN ($1, $4)`, [row.from_plot, row.broj_cestice, GRID_DEG, row.to_plot]);
        }
        // A move can leave a part without area behind (a pinched hairline end): it is dropped.
        await client.query(`UPDATE plot SET geom = kept.g FROM (
                SELECT kazeta, ST_Multi(ST_Collect(d.geom)) AS g FROM plot, ST_Dump(geom) d
                WHERE ST_Area(ST_Transform(d.geom, 3765)) >= 0.001 GROUP BY kazeta) kept
            WHERE plot.kazeta = kept.kazeta AND ST_NumGeometries(plot.geom) > 1`);
        await client.query(`UPDATE plot SET geom = ST_GeometryN(geom, 1) WHERE ST_NumGeometries(geom) = 1 AND GeometryType(geom) = 'MULTIPOLYGON'`);
        const stranded = hairlines.filter(item => !item.to_plot);
        log(`hairlines: ${hairlines.length - stranded.length} moved to their parcel's plot`
            + (stranded.length ? `; ${stranded.length} with no plot of their own parcel: ${stranded.map(item => `k.č. ${item.broj_cestice} in ${item.from_plot} (${Number(item.m2).toFixed(3)} m²)`).join(', ')}` : ''));
        // A leftover plot gives way to the kazete: whatever a kazeta's plot covers is not the leftover's.
        await client.query(`UPDATE plot SET geom = ST_CollectionExtract(ST_Difference(geom,
                (SELECT ST_Union(o.geom, $1::float8) FROM plot o WHERE o.kazeta NOT LIKE 'ostatak%'), $1::float8), 3)
            WHERE kazeta LIKE 'ostatak%'`, [GRID_DEG]);
        // The plots cover exactly the parcels they replace (the agreement balances land to the square
        // centimetre): what reaches beyond the parents is trimmed, and every gap the steps above left
        // joins the plot that borders it longest (or, touching none along an edge, the one it is nearest).
        await client.query(`UPDATE plot SET geom = ST_CollectionExtract(ST_Intersection(plot.geom, parent.g, $1::float8), 3)
            FROM (SELECT ST_Union(rest4, $1::float8) AS g FROM parents) parent`, [GRID_DEG]);
        const gaps = (await client.query(`
            WITH parent AS (SELECT ST_Union(rest4, $1::float8) AS g FROM parents), plots AS (SELECT ST_Union(geom, $1::float8) AS g FROM plot)
            SELECT (ST_Dump(ST_CollectionExtract(ST_Difference(parent.g, plots.g, $1::float8), 3))).geom AS g FROM parent, plots`, [GRID_DEG])).rows;
        log(`reconciling ${gaps.length} gaps against the parents`);
        for (const gap of gaps) {
            await client.query(`
                WITH target AS (SELECT kazeta FROM plot WHERE ST_DWithin(geom, $1::geometry, 0.0000001)
                                ORDER BY ST_Length(ST_CollectionExtract(ST_Intersection(geom, $1::geometry), 2)) DESC, ST_Distance(geom, $1::geometry) LIMIT 1)
                UPDATE plot SET geom = ST_CollectionExtract(ST_Union(plot.geom, $1::geometry, $2::float8), 3) FROM target WHERE plot.kazeta = target.kazeta`,
            [gap.g, GRID_DEG]);
        }
        await client.query(`UPDATE plot SET geom = kept.g FROM (
                SELECT kazeta, ST_Multi(ST_Collect(d.geom)) AS g FROM plot, ST_Dump(geom) d
                WHERE ST_Area(ST_Transform(d.geom, 3765)) >= 0.001 GROUP BY kazeta) kept
            WHERE plot.kazeta = kept.kazeta AND ST_NumGeometries(plot.geom) > 1`);
        await client.query(`UPDATE plot SET geom = ST_GeometryN(geom, 1) WHERE ST_NumGeometries(geom) = 1 AND GeometryType(geom) = 'MULTIPOLYGON'`);
        // Every vertex of one plot that lies on a neighbour's edge becomes a vertex of that neighbour too
        // (the plots' outlines noded together and rebuilt from the faces they enclose): rounded to WGS84 as
        // the app stores them, two neighbours then still share their edge instead of crossing it by 1 mm.
        await client.query(`
            CREATE TEMP TABLE noded ON COMMIT DROP AS
            SELECT (ST_Dump(ST_Polygonize(g))).geom AS geom
            FROM (SELECT ST_Node(ST_CollectionExtract(ST_Collect(ST_Boundary(geom)), 2)) AS g FROM plot) lines`);
        await client.query(`UPDATE plot SET geom = (SELECT ST_UnaryUnion(ST_Collect(n.geom)) FROM noded n WHERE ST_Covers(plot.geom, ST_PointOnSurface(n.geom)))`);
        // Moves along shared edges can leave a zero-width spike (an edge out and back along itself): a zero
        // buffer takes it off without moving any vertex.
        await client.query(`UPDATE plot SET geom = ST_Buffer(geom, 0)`);
        // A hole under 1 m² (dust left out of the layout) is filled: the app takes a hole touching the
        // outline as a crossing. The pool is built from the plots, so it is filled alike.
        await client.query(`UPDATE plot SET geom = ST_MakePolygon(ST_ExteriorRing(geom), ARRAY(
                SELECT ST_ExteriorRing(r.geom) FROM ST_DumpRings(geom) r
                WHERE r.path[1] > 0 AND ST_Area(ST_Transform(r.geom, 3765)) >= 1))
            WHERE GeometryType(geom) = 'POLYGON' AND ST_NumInteriorRings(geom) > 0`);
        const offGrid = Number((await client.query(`SELECT count(*) FROM plot WHERE NOT ST_Equals(geom, ST_ReducePrecision(geom, $1))`, [GRID_DEG])).rows[0].count);
        if (offGrid) throw new Error(`${offGrid} plots left the ${GRID_DEG}° grid`);
        const plotRows = (await client.query(`
            SELECT kazeta, ST_NumGeometries(geom) AS parts, ST_Area(ST_Transform(geom, 3765))::float AS area_m2, ST_AsGeoJSON(geom, ${GRID_DECIMALS})::json AS geometry,
                   (SELECT ST_NumGeometries(ST_Polygonize(ring)) FROM (SELECT ST_Node(ST_ExteriorRing(ST_GeometryN(geom, 1))) AS ring) r) AS loops
            FROM plot ORDER BY kazeta`)).rows;
        const pinched = plotRows.filter(row => Number(row.loops) > 1);
        if (pinched.length) throw new Error(`plots whose outline touches itself: ${pinched.map(row => row.kazeta).join(', ')}`);
        const poolRows = (await client.query(`
            SELECT ST_AsGeoJSON(d.geom, ${GRID_DECIMALS})::json AS geometry, ST_Area(ST_Transform(d.geom, 3765))::float AS area_m2,
                   (SELECT ST_Area(ST_Transform(ST_Union(geom), 3765)) FROM plot)::float AS plots_m2
            FROM (SELECT (ST_Dump(ST_UnaryUnion(ST_Collect(geom), $1))).geom FROM plot) d ORDER BY ST_Area(d.geom) DESC`, [GRID_DEG])).rows;
        const parentNumbers = (await client.query('SELECT broj_cestice FROM parents ORDER BY broj_cestice')).rows.map(row => row.broj_cestice);
        // The plots must cover exactly the parcels they replace: what of the parents' land no plot covers
        // (or what a plot covers beyond it) is land the agreement could not balance.
        const drift = (await client.query(`
            WITH parent AS (SELECT ST_Union(rest4) AS g FROM parents), plots AS (SELECT ST_Union(geom) AS g FROM plot),
                 gap AS (SELECT (ST_Dump(ST_CollectionExtract(ST_Difference(parent.g, plots.g), 3))).geom AS g FROM parent, plots),
                 excess AS (SELECT (ST_Dump(ST_CollectionExtract(ST_Difference(plots.g, parent.g), 3))).geom AS g FROM parent, plots)
            SELECT 'gap' AS kind, ST_Area(ST_Transform(g, 3765))::float AS m2, ST_AsText(ST_PointOnSurface(g)) AS at FROM gap
            UNION ALL SELECT 'excess', ST_Area(ST_Transform(g, 3765))::float, ST_AsText(ST_PointOnSurface(g)) FROM excess
            ORDER BY 2 DESC`)).rows;
        const sum = kind => drift.filter(row => row.kind === kind).reduce((total, row) => total + row.m2, 0);
        log(`plots against their parcels: ${sum('gap').toFixed(4)} m² uncovered in ${drift.filter(row => row.kind === 'gap').length} pieces, ${sum('excess').toFixed(4)} m² beyond in ${drift.filter(row => row.kind === 'excess').length}`
            + `; largest: ${drift.slice(0, 4).map(row => `${row.kind} ${row.m2.toFixed(4)} m² at ${row.at}`).join('; ')}`);
        const coverage = (await client.query(`SELECT k4.kazeta, round((100 * ST_Area(ST_Intersection(k4.geom, plot.geom)) / ST_Area(k4.geom))::numeric, 2) AS pct
            FROM k4 JOIN plot ON plot.kazeta = k4.kazeta ORDER BY 2`)).rows;
        log(`kazeta covered by its plot: ${coverage.map(row => `${row.kazeta} ${row.pct} %`).join(', ')}`);
        await client.query('COMMIT');
        const split = plotRows.filter(row => Number(row.parts) !== 1);
        if (split.length) throw new Error(`plots in more than one piece: ${split.map(row => `${row.kazeta} (${row.parts})`).join(', ')}`);
        const totalPool = poolRows.reduce((sum, row) => sum + row.area_m2, 0);
        const plotSum = plotRows.reduce((sum, row) => sum + row.area_m2, 0);
        if (Math.abs(plotSum - poolRows[0].plots_m2) > 0.5) throw new Error(`the plots overlap by ${(plotSum - poolRows[0].plots_m2).toFixed(2)} m²`);
        if (Math.abs(totalPool - poolRows[0].plots_m2) > 0.01) throw new Error(`the plots cover ${poolRows[0].plots_m2.toFixed(1)} m² of a ${totalPool.toFixed(1)} m² pool`);
        log(`plots: ${whole.length} kazete stay their parcel, ${plotRows.length} plots from ${parentNumbers.length} parcels in ${poolRows.length} pool(s), ${leftovers.length} leftover plot(s)`);
        return [
            ...poolRows.map((row, index) => featureOf(row.geometry.type === 'MultiPolygon' ? row.geometry : row.geometry, { role: 'pool', index, areaM2: Math.round(row.area_m2 * 10) / 10, parcels: index === 0 ? parentNumbers : undefined })),
            ...plotRows.map(row => featureOf({ type: 'Polygon', coordinates: row.geometry.type === 'MultiPolygon' ? row.geometry.coordinates[0] : row.geometry.coordinates }, { role: 'plot', kazeta: row.kazeta, areaM2: Math.round(row.area_m2 * 10) / 10 })),
            ...whole.map(row => featureOf({ type: 'Polygon', coordinates: row.geometry.type === 'MultiPolygon' ? row.geometry.coordinates[0] : row.geometry.coordinates }, { role: 'parcel', kazeta: row.kazeta, parcel: row.broj_cestice }))
        ];
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
    } finally {
        client.release();
    }
}

async function main(argv = process.argv.slice(2)) {
    const write = argv.includes('--write');
    if (!write && !argv.includes('--dry-run')) { usage(); return; }
    if (!isLocalDatabase()) throw new Error(`refusing a non-local database (${describeDatabase()})`);
    const pool = createPool();
    try {
        const fields = await kazete(pool);
        const built = await builtSlabs(pool, fields);
        const permits = await permitFootprints(pool);
        const land = await roadLand(pool);
        const streets = await builtStreets(pool, land.find(item => item.properties.key === 'sjever-istok'));
        const plotFeatures = await plots(pool, fields, land);
        log(`${fields.length} kazete, ${built.length} built slabs, ${permits.length} permit footprints, road land ${land.map(item => item.properties.key).join(' + ')}, ${streets.length} built street centrelines`);
        if (!write) { log('dry run: nothing written'); return; }
        await mkdir(DATA, { recursive: true });
        const files = {
            'kazete.geojson': collection('UPU Podbrežje – kazete (planirana namjena površina)', fields),
            'built.geojson': collection('UPU Podbrežje – izvedene zgrade A3–A6 (DGU, visine GDI)', built),
            'permits.geojson': collection('UPU Podbrežje – tlocrti iz građevinskih dozvola (eDozvola)', permits),
            'road-land.geojson': collection('UPU Podbrežje – prometne površine IS po ulicama', land),
            'built-streets.geojson': collection('UPU Podbrežje – osi izvedenih ulica (OSM)', streets),
            // WGS84, as the layout is built (GRID_DEG).
            'plots.geojson': { type: 'FeatureCollection', name: 'UPU Podbrežje – građevne čestice kazeta (parcelacija, WGS84)', features: plotFeatures }
        };
        for (const [name, content] of Object.entries(files)) {
            await writeFile(new URL(name, DATA), `${JSON.stringify(content)}\n`, 'utf8');
            log(`wrote data/${name}`);
        }
    } finally {
        await pool.end();
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
