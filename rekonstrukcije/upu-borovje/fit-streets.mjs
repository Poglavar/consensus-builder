#!/usr/bin/env node
// UPU Borovje v3: every street takes exactly the ground its lanes cut.
//
// The reconstruction prepared each street's land separately (the plan's road band) and drew the lanes inside
// it, narrower in places and wider in others. The app never does that: a street's land is the footprint of its
// lanes (centre line + cross-section), cut by `corridorSurfaceFootprintForDefinition` in road-drawing.js. So
// here the land of both street records becomes exactly that footprint, computed by the app itself. The band
// the lanes do not use goes to the plot beside it where there is one (the plots grow to meet the street);
// where the only neighbour is the plan's edge (the strip between the collector and the gardens south of it)
// it is not taken at all and stays with its cadastral parcel, which is city land.
//
// Named plans never change (plans.md): the changed members are published as `<id>-v3` records and named as
// the -v3 plans by name-plans.mjs.
//
//   node fit-streets.mjs --capture --app <app url> --backend <api>         # the app's own footprints → data/street-footprints.json (agent-browser)
//   PGHOST=127.0.0.1 node fit-streets.mjs --compute --backend <api>        # → data/streets-fit.json (local PostGIS)
//   node fit-streets.mjs --backend <api> --origin <app> [--apply]          # publish the -v3 records
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';
import { publish, request } from '../../backend/scripts/lib/candlestick-common.mjs';
import { canonicalSeedRecord } from '../../backend/scripts/lib/canonical-seed-record.mjs';
import { revisedRecord } from '../../backend/scripts/lib/borovje-revision.mjs';

const require = createRequire(new URL('../../backend/package.json', import.meta.url));
const log = message => console.log(`[${new Date().toISOString()}] ${message}`);
const FOOTPRINT_FILE = new URL('./data/street-footprints.json', import.meta.url);
const FIT_FILE = new URL('./data/streets-fit.json', import.meta.url);
export const VERSION = 3;
export const REPAIR = 'borovje-streets-fit-v1';
// The records v3 starts from: the v2 corrections where they exist, the originals otherwise.
const LAYOUTS = ['p-upu-borovje-parcelacija-v2', 'p-upu-borovje-parcelacija-2-v2', 'p-upu-borovje-parcelacija-3-v2'];
const STREETS = ['upu-borovje-ulice-v2', 'upu-borovje-ulice-split-1-v2'];
const PARKS = { 'r2-1': 'upu-borovje-r2-0', 'z1-1': 'upu-borovje-z1-1-v2', 'z1-2': 'upu-borovje-z1-2', 'z1-3': 'upu-borovje-z1-3',
    'z1-4': 'upu-borovje-z1-4', 'z1-5': 'upu-borovje-z1-5-v2' };
const BUILDINGS = Array.from({ length: 11 }, (_, i) => `upu-borovje-m1-${i + 1}`);
// A band piece the lanes leave goes to a plot only if it shares at least this much edge with it; smaller
// pieces than MIN_PIECE_M2 are rounding between two clips and are dropped.
const RULE = Object.freeze({ MIN_SHARED_EDGE_M: 1, MIN_PIECE_M2: 0.5 });

const { values } = parseArgs({ options: {
    capture: { type: 'boolean' }, compute: { type: 'boolean' }, app: { type: 'string' }, backend: { type: 'string' },
    origin: { type: 'string' }, apply: { type: 'boolean' }, help: { type: 'boolean' }
} });
if (values.help || !values.backend) {
    console.log(`Usage:
  node fit-streets.mjs --capture --app <app url> --backend <api>     # needs agent-browser and a running app
  PGHOST=127.0.0.1 node fit-streets.mjs --compute --backend <api>
  node fit-streets.mjs --backend <api> --origin <app> [--apply]
--capture and --compute read records from --backend and change nothing. The publish step is a dry run
unless --apply; existing -v3 records are left alone.`);
    process.exit(0);
}
const origin = values.origin || values.backend;
const geometryOf = value => (value?.type === 'Feature' ? value.geometry : value);
async function record(id) {
    const { status, json } = await request(values.backend, origin, 'GET', `/proposals/${encodeURIComponent(id)}`);
    if (status !== 200) throw new Error(`${values.backend} has no ${id} (${status})`);
    return json;
}

// ---------------------------------------------------------------------------------------------------------
// --capture: ask the app itself for each street's footprint (the ground its lanes cut).
// ---------------------------------------------------------------------------------------------------------
async function capture() {
    if (!values.app) throw new Error('--capture needs --app <app url>');
    const definitions = {};
    for (const id of STREETS) {
        const definition = structuredClone((await record(id)).roadProposal.definition);
        delete definition.polygon; // the footprint comes from the lanes alone
        definitions[id] = definition;
    }
    const session = `fit-streets-${process.pid}`;
    const browser = (...args) => execFileSync('agent-browser', ['--session', session, ...args], { encoding: 'utf8', maxBuffer: 64 << 20 });
    try {
        // The builder measures metres in the active city's projection (HTRS96 for Zagreb), so the app must
        // be opened in Zagreb: without a city every width came out scaled by ~0.72.
        browser('open', `${values.app.replace(/\/$/, '')}/?city=zagreb&reduceMotion=1&backend=${encodeURIComponent(values.backend)}`);
        const script = `(async () => {
            const t0 = Date.now();
            while (typeof window.corridorSurfaceFootprintForDefinition !== 'function' && Date.now() - t0 < 60000) await new Promise(r => setTimeout(r, 300));
            const definitions = ${JSON.stringify(definitions)};
            return Object.fromEntries(Object.entries(definitions).map(([id, d]) => [id, window.corridorSurfaceFootprintForDefinition(d)]));
        })()`;
        const output = execFileSync('agent-browser', ['--session', session, 'eval', '--stdin'], { input: script, encoding: 'utf8', maxBuffer: 64 << 20 });
        const footprints = JSON.parse(output);
        for (const id of STREETS) {
            if (!/Polygon/.test(footprints[id]?.type || '')) throw new Error(`the app gave no footprint for ${id}`);
        }
        await writeFile(FOOTPRINT_FILE, `${JSON.stringify({
            comment: 'Generated by fit-streets.mjs --capture: each street\'s footprint as the app cuts it (corridorSurfaceFootprintForDefinition).',
            app: values.app.replace(/^https?:\/\/[^/]+/, '<app>'),
            footprints
        }, null, 1)}\n`);
        log(`captured ${STREETS.length} footprints → ${FOOTPRINT_FILE.pathname}`);
    } finally {
        try { browser('close'); } catch (_) { /* already closed */ }
    }
}

// ---------------------------------------------------------------------------------------------------------
// --compute: plots meet the streets; the rest of the band stays with its cadastral parcel.
// ---------------------------------------------------------------------------------------------------------
async function compute() {
    const { footprints } = JSON.parse(await readFile(FOOTPRINT_FILE, 'utf8'));
    require('dotenv').config({ path: new URL('../../backend/.env', import.meta.url).pathname, quiet: true });
    const { Pool } = require('pg');
    const pool = new Pool({ max: 1, ...(process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : {}) });
    const db = await pool.connect();
    const q = (sql, params) => db.query(sql, params);
    try {
        await q(`CREATE TEMP TABLE piece (key text PRIMARY KEY, member text, owner text, g geometry(Geometry, 4326), ng geometry)`);
        await q(`CREATE TEMP TABLE street (member text PRIMARY KEY, old geometry, land geometry)`);
        const layouts = {};
        for (const id of LAYOUTS) {
            layouts[id] = await record(id);
            for (const polygon of layouts[id].reparcellization.polygons) {
                await q('INSERT INTO piece VALUES ($1, $2, $3, ST_SetSRID(ST_GeomFromGeoJSON($4), 4326), NULL)',
                    [`${id}#${polygon.ownerKey}`, id, polygon.ownerKey, JSON.stringify(geometryOf(polygon.geometry))]);
            }
        }
        for (const id of STREETS) {
            const old = geometryOf((await record(id)).roadProposal.definition.polygon);
            await q(`INSERT INTO street VALUES ($1, ST_SetSRID(ST_GeomFromGeoJSON($2), 4326), ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON($3), 4326)))`,
                [id, JSON.stringify(old), JSON.stringify(footprints[id])]);
        }
        // Plots give up whatever the lanes now cover ...
        await q(`UPDATE piece SET ng = (SELECT ST_UnaryUnion(ST_Collect(d.geom)) FROM ST_Dump(ST_CollectionExtract(
                ST_Difference(piece.g, (SELECT ST_Union(land) FROM street)), 3)) d WHERE ST_Area(ST_Transform(d.geom, 3765)) >= $1::float8)`, [RULE.MIN_PIECE_M2]);
        // ... and take the band the lanes leave beside them.
        const leftovers = (await q(`WITH spare AS (SELECT (ST_Dump(ST_CollectionExtract(ST_Difference(
                    (SELECT ST_Union(old) FROM street), ST_Union((SELECT ST_Union(land) FROM street), (SELECT ST_Union(ng) FROM piece))), 3))).geom AS g)
            SELECT ST_AsGeoJSON(g, 15) AS g, ST_Area(ST_Transform(g, 3765)) AS m2,
                   (SELECT key FROM piece ORDER BY ST_Length(ST_Transform(ST_Intersection(ST_Boundary(spare.g), ST_Buffer(piece.ng, 1e-7)), 3765)) DESC LIMIT 1) AS key,
                   (SELECT max(ST_Length(ST_Transform(ST_Intersection(ST_Boundary(spare.g), ST_Buffer(piece.ng, 1e-7)), 3765))) FROM piece) AS shared_m
            FROM spare WHERE ST_Area(ST_Transform(g, 3765)) >= $1::float8 ORDER BY 2 DESC`, [RULE.MIN_PIECE_M2])).rows;
        const kept = [];
        for (const piece of leftovers) {
            if (piece.shared_m >= RULE.MIN_SHARED_EDGE_M) {
                await q(`UPDATE piece SET ng = ST_UnaryUnion(ST_Collect(ng, ST_SetSRID(ST_GeomFromGeoJSON($2), 4326))) WHERE key = $1`, [piece.key, piece.g]);
            } else {
                kept.push(piece);
            }
        }

        // Checks: plots are one polygon each and do not overlap a street or each other; each layout is one
        // connected pool; every official building and park still stands on its plot.
        const split = (await q(`SELECT key, ST_NumGeometries(ST_Multi(ng)) AS n FROM piece WHERE ng IS NULL OR ST_NumGeometries(ST_Multi(ng)) > 1`)).rows;
        if (split.length) throw new Error(`plots split or lost: ${split.map(r => `${r.key}(${r.n ?? 0})`).join(', ')}`);
        const { rows: [overlap] } = await q(`SELECT
              COALESCE((SELECT sum(ST_Area(ST_Transform(ST_Intersection(p.ng, s.land), 3765))) FROM piece p, street s), 0) AS on_street,
              (SELECT sum(ST_Area(ST_Transform(ng, 3765))) - ST_Area(ST_Transform(ST_Union(ng), 3765)) FROM piece) AS between_plots`);
        if (overlap.on_street > 0.5 || overlap.between_plots > 0.5) throw new Error(`overlap: plots on streets ${overlap.on_street} m², between plots ${overlap.between_plots} m²`);
        const brokenPools = (await q(`SELECT member FROM piece GROUP BY member HAVING ST_NumGeometries(ST_Multi(ST_Union(ng))) > 1`)).rows;
        if (brokenPools.length) throw new Error(`layouts no longer one connected pool: ${brokenPools.map(r => r.member).join(', ')}`);
        const { rows: buildings } = await q(`SELECT proposal_id, site FROM ${await proposalTable(q)} WHERE proposal_id = ANY($1)`, [BUILDINGS]);
        for (const building of buildings) {
            const owner = building.proposal_id.replace('upu-borovje-', '');
            const { rows: [r] } = await q(`SELECT ST_Area(ST_Transform(ST_Difference($1::geometry, ng), 3765)) AS m2 FROM piece WHERE owner = $2`, [building.site, owner]);
            if (!r || r.m2 > 0.01) throw new Error(`${building.proposal_id} leaves its plot by ${r?.m2} m²`);
        }

        // An unchanged piece keeps its original coordinates exactly.
        const pieces = (await q(`SELECT key, member, owner, ST_AsGeoJSON(CASE WHEN ST_Equals(g, ng) THEN g ELSE ng END, 15) AS g,
            ST_Area(ST_Transform(g, 3765)) AS before_m2, ST_Area(ST_Transform(ng, 3765)) AS m2, ST_Equals(g, ng) AS same FROM piece ORDER BY key`)).rows;
        const members = {};
        for (const id of LAYOUTS) {
            const own = pieces.filter(p => p.member === id);
            if (own.every(p => p.same)) continue;
            const { rows: [u] } = await q('SELECT ST_AsGeoJSON(ST_Union(ng), 15) AS g FROM piece WHERE member = $1', [id]);
            members[id] = { pool: JSON.parse(u.g), plots: Object.fromEntries(own.map(p => [p.owner, { geometry: JSON.parse(p.g), m2: Number(p.m2.toFixed(1)) }])) };
        }
        for (const id of STREETS) members[id] = { polygon: footprints[id] };
        for (const [owner, id] of Object.entries(PARKS)) {
            const plot = pieces.find(p => p.owner === owner);
            if (!plot.same) members[id] = { geometry: JSON.parse(plot.g) };
        }
        const { rows: [areas] } = await q(`SELECT (SELECT ST_Area(ST_Transform(ST_Union(old), 3765)) FROM street) AS before, (SELECT ST_Area(ST_Transform(ST_Union(land), 3765)) FROM street) AS after`);
        const result = {
            comment: 'Generated by fit-streets.mjs --compute. UPU Borovje v3: streets take exactly their lanes; geometry in EPSG:4326, replayed by its publish step.',
            repair: REPAIR,
            rule: RULE,
            streetLandM2: { before: Math.round(areas.before), after: Math.round(areas.after) },
            plotsGrew: pieces.filter(p => !p.same).map(p => ({ plot: p.owner, fromM2: Math.round(p.before_m2), toM2: Math.round(p.m2) })),
            leftWithItsParcel: kept.map(k => ({ m2: Number(k.m2.toFixed(1)), sharedWithPlotM: Number(Number(k.shared_m).toFixed(2)) })),
            members
        };
        await writeFile(FIT_FILE, `${JSON.stringify(result, null, 1)}\n`);
        log(`street land ${result.streetLandM2.before} → ${result.streetLandM2.after} m²; plots changed: ${result.plotsGrew.map(p => `${p.plot} ${p.fromM2}→${p.toM2}`).join(', ')}`);
        log(`left with its cadastral parcel: ${kept.length} pieces, ${Math.round(kept.reduce((s, k) => s + k.m2, 0))} m²`);
        log(`changed members: ${Object.keys(members).join(', ')} → ${FIT_FILE.pathname}`);
    } finally {
        db.release();
        await pool.end();
    }
}

async function proposalTable(q) {
    const { rows: [r] } = await q(`SELECT table_schema AS s FROM information_schema.tables WHERE table_name = 'proposal'
        AND table_schema IN ('public', 'consensus') ORDER BY table_schema = 'public' DESC LIMIT 1`);
    return `${r.s}.proposal`;
}

// ---------------------------------------------------------------------------------------------------------
// publish: replay the committed geometry onto each v2/original record as `<base id>-v3`.
// ---------------------------------------------------------------------------------------------------------
async function publishAll() {
    if (values.apply && !values.origin) throw new Error('--apply needs --origin (the app origin the API accepts writes from)');
    const fit = JSON.parse(await readFile(FIT_FILE, 'utf8'));
    const records = [];
    for (const [id, change] of Object.entries(fit.members)) {
        const original = await record(id);
        const draft = revisedRecord(original, change, { version: VERSION, repair: REPAIR });
        const bound = await request(values.backend, origin, 'POST', '/proposals/binding', { site: draft.site, toleranceM: 0, city: 'zagreb', parcelSourceId: null });
        if (bound.status !== 200 || !bound.json?.binding) throw new Error(`${draft.proposalId}: binding ${bound.status} ${bound.text.slice(0, 200)}`);
        const before = new Set(original.cadastreParcelIds || []);
        const after = bound.json.binding.parcels.map(parcel => parcel.parcelId);
        const dropped = [...before].filter(p => !after.includes(p));
        const gained = after.filter(p => !before.has(p));
        log(`${draft.proposalId.padEnd(34)} parcels ${before.size} → ${after.length}${dropped.length ? ` · drops ${dropped.join(' ')}` : ''}${gained.length ? ` · adds ${gained.join(' ')}` : ''}`);
        records.push(canonicalSeedRecord({ ...draft, cadastreParcelIds: after }));
    }
    if (!values.apply) { log(`DRY RUN: ${records.length} records not published (add --apply --origin <app>).`); return; }
    const tokenFile = path.join(os.homedir(), '.config', 'ugt', 'edit-tokens', `${new URL(values.backend).host}.json`);
    await mkdir(path.dirname(tokenFile), { recursive: true });
    let tokens = {};
    try { tokens = JSON.parse(await readFile(tokenFile, 'utf8')); } catch (_) { tokens = {}; }
    for (const draft of records) {
        const result = await publish(draft, { backend: values.backend, origin: values.origin, city: 'zagreb', parcelSourceId: null });
        if (result.editToken) {
            tokens[draft.proposalId] = { id: result.id, editToken: result.editToken, createdAt: new Date().toISOString() };
            await writeFile(tokenFile, JSON.stringify(tokens, null, 2), { mode: 0o600 });
        }
    }
    log(`published ${records.length} records · edit tokens in ${tokenFile}`);
}

if (values.capture) await capture();
else if (values.compute) await compute();
else await publishAll();
