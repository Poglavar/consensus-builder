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
// A park forms its parcels from the cadastral parcels it takes, and those are the parcels it reaches more
// than the designs' intrusion allowance into (podbrezje-designs.mjs TOLERANCE_M, 5 cm). The plan's line
// runs within centimetres of the cadastral one, so a park field is cut to the parcels it takes: it must
// not stand on the hairlines of its neighbours' parcels that it does not take.
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
        WITH fields AS (SELECT objectid, oznaka, namjena, geom FROM public.planned_land_use WHERE naziv_plana = $1),
        taken AS (
            SELECT f.objectid, ST_Union(c.geom) AS geom
            FROM fields f JOIN public.parcel c ON c.current AND c.geom && f.geom AND ST_Intersects(c.geom, f.geom)
            WHERE f.oznaka IN ('Z', 'Z1') AND NOT ST_IsEmpty(ST_Buffer(ST_Intersection(c.geom, f.geom), -$2::float / 2))
            GROUP BY f.objectid
        ), shaped AS (
            SELECT f.objectid, f.oznaka, f.namjena, ST_Area(f.geom)::float AS area_m2,
                   CASE WHEN t.geom IS NULL THEN ST_SnapToGrid(f.geom, 0.01)
                        ELSE ST_CollectionExtract(ST_Intersection(f.geom, t.geom), 3) END AS geom
            FROM fields f LEFT JOIN taken t USING (objectid)
        )
        SELECT objectid, oznaka, namjena, ST_NumGeometries(geom) AS parts, area_m2,
               ST_AsGeoJSON(ST_GeometryN(geom, 1), 3)::json AS geometry
        FROM shaped ORDER BY objectid`, [PLAN_NAME, TOLERANCE_M]);
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
        SELECT 'jug', ST_AsGeoJSON(ST_SnapToGrid(ST_Intersection(land.geom, cut.geom), 0.01))::json FROM land, cut`,
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
        log(`${fields.length} kazete, ${built.length} built slabs, ${permits.length} permit footprints, road land ${land.map(item => item.properties.key).join(' + ')}, ${streets.length} built street centrelines`);
        if (!write) { log('dry run: nothing written'); return; }
        await mkdir(DATA, { recursive: true });
        const files = {
            'kazete.geojson': collection('UPU Podbrežje – kazete (planirana namjena površina)', fields),
            'built.geojson': collection('UPU Podbrežje – izvedene zgrade A3–A6 (DGU, visine GDI)', built),
            'permits.geojson': collection('UPU Podbrežje – tlocrti iz građevinskih dozvola (eDozvola)', permits),
            'road-land.geojson': collection('UPU Podbrežje – prometne površine IS po ulicama', land),
            'built-streets.geojson': collection('UPU Podbrežje – osi izvedenih ulica (OSM)', streets)
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
