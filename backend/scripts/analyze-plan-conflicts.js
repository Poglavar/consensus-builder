#!/usr/bin/env node
// What a stored plan actually claims, measured against the cadastre and against itself.
//
// Written for the UPU Borovje import, where every member declares the SAME single parent parcel
// (HR-335550-1791/25) while its footprint sits somewhere else entirely — M1-11 is 100% inside
// 1791/69, a different parcel twenty times the size. Declared parents are the ground hints the
// replay loads and the ancestry the app reasons about, so a wrong one is not cosmetic.
//
// Reports, per member:
//   anchors   — the cadastral parcels the footprint really covers vs. the ones it declares
//   coverage  — how much of the footprint lands on current cadastre at all (a gap means the
//               geometry claims ground the cadastre does not have)
//   overlaps  — which OTHER members it materially overlaps (the input to the occupation gate:
//               a proposal standing on another proposal's ground is refused, not silently stacked)
//
// Read-only. Borovje repairs live in
// rekonstrukcije/upu-borovje/repair-imported-proposals.mjs, so there is one writer,
// not two.
//
//   node scripts/analyze-plan-conflicts.js --ids 633-651,699

import pkg from 'pg';
import 'dotenv/config';

const { Pool } = pkg;

// Same floor as plan-order.js: below this an intersection is shared-border noise, not a claim.
const MIN_INTERSECTION_M2 = 0.25;
// A member standing on another member's ground matters at the occupation gate's scale, not at
// the noise floor — kerf-sized touches between neighbours are normal composition.
const MIN_MEMBER_OVERLAP_M2 = 25;

const SUB_KEYS = ['roadProposal', 'buildingProposal', 'structureProposal', 'reparcellization', 'decideLaterProposal'];

function usage() {
    console.log([
        'Measure a stored plan against the cadastre and against itself.',
        '',
        '  --ids LIST   Row ids: comma-separated, ranges allowed (633-651,699). Required.',
        '  --help       Show this message.'
    ].join('\n'));
}

function parseIds(spec) {
    const out = [];
    String(spec || '').split(',').map(s => s.trim()).filter(Boolean).forEach(part => {
        const range = part.match(/^(\d+)\s*-\s*(\d+)$/);
        if (range) {
            const from = Number(range[1]);
            const to = Number(range[2]);
            for (let i = Math.min(from, to); i <= Math.max(from, to); i += 1) out.push(i);
            return;
        }
        if (/^\d+$/.test(part)) out.push(Number(part));
    });
    return Array.from(new Set(out));
}

// A corridor whose `definition.polygon` is null (the usual case — the app derives the surface at
// apply time from road-drawing.js, which needs a browser). For a measurement report a flat-capped,
// mitre-joined buffer of the centerline at half-width is the same construction; treat the numbers
// as ±the join detail, not as the surface the cut will use.
function corridorCenterline(definition) {
    const groups = Array.isArray(definition && definition.points) ? definition.points : [];
    const lines = groups
        .map(group => (Array.isArray(group) ? group : [])
            .map(pt => (pt && Number.isFinite(pt.lng) && Number.isFinite(pt.lat)) ? [pt.lng, pt.lat] : null)
            .filter(Boolean))
        .filter(line => line.length >= 2);
    if (!lines.length) return null;
    return { type: 'MultiLineString', coordinates: lines };
}

// Every polygon a record authors, as GeoJSON geometries. Mirrors plan-order.js footprintOf.
function footprintGeometries(data) {
    const out = [];
    const push = value => {
        if (!value) return;
        const geometry = value.type === 'Feature' ? value.geometry : value;
        if (geometry && /Polygon/.test(String(geometry.type || ''))) out.push(geometry);
    };
    if (data.reparcellization && Array.isArray(data.reparcellization.polygons)) {
        data.reparcellization.polygons.forEach(slice => push(slice && slice.geometry));
    }
    const definition = data.roadProposal && data.roadProposal.definition;
    if (definition && definition.polygon) push(definition.polygon);
    if (data.structureProposal && data.structureProposal.geometry) push(data.structureProposal.geometry);
    if (data.geometry && /Polygon/.test(String(data.geometry.type || ''))) push(data.geometry);
    if (data.buildingGeometry) push(data.buildingGeometry);
    if (data.geometry && Array.isArray(data.geometry.buildings)) data.geometry.buildings.forEach(push);
    return out;
}

const fmt = n => Math.round(Number(n) || 0).toLocaleString('en-US');

async function main() {
    const argv = process.argv.slice(2);
    if (argv.includes('--help') || argv.length === 0) { usage(); process.exit(0); }
    const idsArg = argv[argv.indexOf('--ids') + 1];
    const ids = argv.includes('--ids') ? parseIds(idsArg) : [];
    if (!ids.length) { console.error('--ids is required (e.g. --ids 633-651,699)'); process.exit(1); }

    const pool = new Pool();
    const client = await pool.connect();
    console.log(`database: ${process.env.PGDATABASE || 'geodata'}   (read-only)`);

    try {
        const { rows } = await client.query(
            'SELECT id, proposal_id, proposal_data FROM public.proposal WHERE id = ANY($1::int[]) ORDER BY id', [ids]
        );
        if (!rows.length) { console.log('no matching rows'); return; }

        // One temp table of member footprints in 3765, so every measurement below is PostGIS.
        // ON COMMIT DROP only exists inside a transaction — created outside one it is dropped
        // the instant the statement autocommits.
        await client.query('BEGIN');
        await client.query('CREATE TEMP TABLE member (id int, title text, geom geometry(MultiPolygon,3765)) ON COMMIT DROP');
        const skipped = [];
        const derivedCorridors = [];
        for (const row of rows) {
            const data = row.proposal_data || {};
            const title = data.title || data.name || row.proposal_id;
            const geometries = footprintGeometries(data);
            if (geometries.length) {
                await client.query(`
                    INSERT INTO member (id, title, geom)
                    SELECT $1, $2, ST_Multi(ST_UnaryUnion(ST_Collect(ST_Transform(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON(g)::geometry, 4326)), 3765))))
                    FROM jsonb_array_elements($3::jsonb) AS g`,
                [row.id, title, JSON.stringify(geometries)]);
                continue;
            }
            const definition = data.roadProposal && data.roadProposal.definition;
            const centerline = corridorCenterline(definition);
            const width = Number(definition && definition.width);
            if (centerline && Number.isFinite(width) && width > 0) {
                await client.query(`
                    INSERT INTO member (id, title, geom)
                    VALUES ($1, $2, ST_Multi(ST_Buffer(
                        ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON($3)::geometry, 4326), 3765),
                        $4, 'endcap=flat join=mitre')))`,
                [row.id, title, JSON.stringify(centerline), width / 2]);
                derivedCorridors.push(row.id);
                continue;
            }
            skipped.push(row.id);
        }
        if (derivedCorridors.length) {
            console.log(`corridor surface derived from the centerline (no stored polygon): ${derivedCorridors.join(', ')}`);
        }
        if (skipped.length) console.log(`no authored geometry (skipped): ${skipped.join(', ')}`);

        const anchors = await client.query(`
            SELECT m.id,
                   m.title,
                   round(ST_Area(m.geom)::numeric, 0) AS footprint_m2,
                   round(COALESCE(SUM(ST_Area(ST_Intersection(m.geom, p.geom))), 0)::numeric, 0) AS on_cadastre_m2,
                   COALESCE(array_agg('HR-' || p.maticni_broj_ko || '-' || p.broj_cestice
                                      ORDER BY ST_Area(ST_Intersection(m.geom, p.geom)) DESC)
                            FILTER (WHERE p.cestica_id IS NOT NULL), '{}') AS covers
            FROM member m
            LEFT JOIN public.parcel p
              ON p.current AND p.geom && m.geom
             AND ST_Area(ST_Intersection(m.geom, p.geom)) >= $1
            GROUP BY m.id, m.title, m.geom
            ORDER BY m.id`, [MIN_INTERSECTION_M2]);

        const overlaps = await client.query(`
            SELECT a.id AS a_id, a.title AS a_title, b.id AS b_id, b.title AS b_title,
                   round(ST_Area(ST_Intersection(a.geom, b.geom))::numeric, 0) AS overlap_m2,
                   round((100 * ST_Area(ST_Intersection(a.geom, b.geom)) / NULLIF(ST_Area(b.geom), 0))::numeric, 1) AS pct_of_b
            FROM member a JOIN member b ON a.id < b.id
            WHERE ST_Intersects(a.geom, b.geom)
              AND ST_Area(ST_Intersection(a.geom, b.geom)) >= $1
            ORDER BY overlap_m2 DESC`, [MIN_MEMBER_OVERLAP_M2]);

        const byId = new Map(rows.map(r => [r.id, r]));
        const repairs = [];

        console.log('\nANCHORS — what each member stands on\n');
        for (const row of anchors.rows) {
            const record = byId.get(row.id);
            const data = record.proposal_data || {};
            const declared = Array.isArray(data.parentParcelIds) ? data.parentParcelIds.map(String) : [];
            const covers = row.covers || [];
            const off = Number(row.footprint_m2) - Number(row.on_cadastre_m2);
            const wrong = declared.filter(id => !covers.includes(id));
            const missing = covers.filter(id => !declared.includes(id));

            console.log(`#${row.id}  ${row.title}`);
            console.log(`    footprint ${fmt(row.footprint_m2)} m²` +
                (off > 1 ? `  (${fmt(off)} m² not on any current parcel)` : ''));
            console.log(`    declared: ${declared.length ? declared.join(', ') : '(none)'}`);
            console.log(`    covers:   ${covers.length ? covers.join(', ') : '(none)'}`);
            if (wrong.length) console.log(`    !! declares ground it does not touch: ${wrong.join(', ')}`);
            if (missing.length) console.log(`    !! stands on undeclared ground: ${missing.join(', ')}`);
            if (wrong.length || missing.length) repairs.push({ id: row.id, covers });
        }

        console.log('\nOVERLAPS — members standing on each other\n');
        if (!overlaps.rows.length) console.log('    none above ' + MIN_MEMBER_OVERLAP_M2 + ' m²');
        overlaps.rows.forEach(o => {
            console.log(`    #${o.a_id} ${o.a_title}`);
            console.log(`      overlaps #${o.b_id} ${o.b_title} by ${fmt(o.overlap_m2)} m² (${o.pct_of_b}% of it)`);
        });

        console.log(`\n${repairs.length} row(s) declare ground their geometry does not cover.`);
        await client.query('ROLLBACK');
    } catch (error) {
        try { await client.query('ROLLBACK'); } catch (_) { }
        throw error;
    } finally {
        client.release();
        await pool.end();
    }
}

main().catch(error => { console.error(error); process.exit(1); });
