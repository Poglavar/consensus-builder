#!/usr/bin/env node
// UPU Borovje version 3: every street takes exactly the ground its lanes cut (README.md, "Streets take
// exactly their lanes").
//
// The reconstruction prepared each street's land separately (the plan's road band) and drew the lanes inside
// it, narrower in places and wider in others. The app never does that: a street's land is the footprint of its
// lanes (centre line + cross-section), cut by `corridorSurfaceFootprintForDefinition` in road-drawing.js. So
// here the land of both streets becomes exactly that footprint, computed by the app itself. The band the lanes
// do not use goes to the plot beside it where there is one (the plots grow to meet the street); where the only
// neighbour is the plan's edge (the strip between the collector and the gardens south of it) it is not taken
// at all and stays with its cadastral parcel, which is city land.
//
// Both steps start from version 2, which borovje-designs.mjs builds from the committed data (no proposal rows
// are read); the members version 3 changes are written to data/streets-fit.json by design key and replayed by
// borovje-designs.mjs.
//
//   node fit-streets.mjs --capture --app <app url> [--api <api>]   # the app's own footprints → data/street-footprints.json (agent-browser)
//   node fit-streets.mjs --compute                                 # version 2 + footprints + local cadastre → data/streets-fit.json
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';
import { canonicalRoadDefinition } from '../../backend/scripts/lib/restatement-publish.mjs';
import { borovjeState } from './borovje-designs.mjs';

const require = createRequire(new URL('../../backend/package.json', import.meta.url));
const log = message => console.log(`[${new Date().toISOString()}] ${message}`);
const FOOTPRINT_FILE = new URL('./data/street-footprints.json', import.meta.url);
const FIT_FILE = new URL('./data/streets-fit.json', import.meta.url);
export const REPAIR = 'borovje-streets-fit-v1';
// A band piece the lanes leave goes to a plot only if it shares at least this much edge with it; smaller
// pieces than MIN_PIECE_M2 are rounding between two clips and are dropped.
const RULE = Object.freeze({ MIN_SHARED_EDGE_M: 1, MIN_PIECE_M2: 0.5 });
// How long the app may take to load its road builder.
const APP_READY_MS = 5 * 60 * 1000;
const WAIT_ERROR_MS = 5 * 1000;

const { values } = parseArgs({ options: {
    capture: { type: 'boolean' }, compute: { type: 'boolean' }, app: { type: 'string' }, api: { type: 'string' }, help: { type: 'boolean' }
} });
if (values.help || (!values.capture && !values.compute)) {
    console.log(`Usage:
  node fit-streets.mjs --capture --app <app url> [--api <api>]   # needs agent-browser and a running app
  node fit-streets.mjs --compute
--capture asks the running app (opened in Zagreb, on --api when given) for the footprint each version-2 street's
lanes cut and writes data/street-footprints.json. --compute reads the cadastre through backend/.env (DATABASE_URL,
local PostGIS), validates the result and writes data/streets-fit.json. Version 2 is built from the committed data
(borovje-designs.mjs); neither step reads or writes a record anywhere.`);
    process.exit(0);
}
const geometryOf = value => (value?.type === 'Feature' ? value.geometry : value);
const firstLine = error => String((error && error.message) || error).split('\n')[0];

// ---------------------------------------------------------------------------------------------------------
// --capture: ask the app itself for each street's footprint (the ground its lanes cut).
// ---------------------------------------------------------------------------------------------------------
async function capture() {
    if (!values.app) throw new Error('--capture needs --app <app url>');
    const state = await borovjeState(2);
    const definitions = {};
    for (const road of state.roads) {
        // The street as the app holds it; the footprint comes from the lanes alone.
        const definition = canonicalRoadDefinition(road.definition);
        delete definition.polygon;
        definitions[road.key] = definition;
    }
    const app = values.app.replace(/\/+$/, '');
    const session = `fit-streets-${process.pid}`;
    const browser = (args, options = {}) => execFileSync('agent-browser', ['--session', session, ...args],
        { encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['pipe', 'pipe', 'pipe'], ...options });
    try {
        // The builder measures metres in the active city's projection (HTRS96 for Zagreb), so the app must
        // be opened in Zagreb: without a city every width came out scaled by ~0.72.
        const backend = values.api ? `&backend=${encodeURIComponent(values.api.replace(/\/+$/, ''))}` : '';
        browser(['open', `${app}/?city=zagreb&reduceMotion=1${backend}`], { timeout: 180_000 });
        const deadline = Date.now() + APP_READY_MS;
        for (;;) {
            const since = Date.now();
            try {
                browser(['wait', '--fn', "typeof window.corridorSurfaceFootprintForDefinition === 'function'"], { timeout: 180_000 });
                break;
            } catch (error) {
                if (Date.now() - since < WAIT_ERROR_MS) throw new Error(`agent-browser wait failed: ${firstLine(error)}`);
                if (Date.now() > deadline) throw new Error(`the app did not load its road builder within ${APP_READY_MS / 60000} minutes`);
                log('waiting for the app to load its road builder');
            }
        }
        const script = `(() => {
            const definitions = ${JSON.stringify(definitions)};
            return Object.fromEntries(Object.entries(definitions).map(([key, d]) => [key, window.corridorSurfaceFootprintForDefinition(d)]));
        })()`;
        const footprints = JSON.parse(browser(['eval', '--stdin'], { input: script, timeout: 120_000 }));
        for (const road of state.roads) {
            if (!/Polygon/.test(footprints[road.key]?.type || '')) throw new Error(`the app gave no footprint for ${road.key}`);
        }
        await writeFile(FOOTPRINT_FILE, `${JSON.stringify({
            comment: 'Generated by fit-streets.mjs --capture: each version-2 street\'s footprint as the app cuts it (corridorSurfaceFootprintForDefinition), by design key.',
            app: '<app>',
            footprints
        }, null, 1)}\n`);
        log(`captured ${state.roads.length} footprints → ${FOOTPRINT_FILE.pathname}`);
    } finally {
        try { browser(['close'], { timeout: 120_000 }); } catch (error) { log(`closing session ${session} failed: ${firstLine(error)}`); }
    }
}

// ---------------------------------------------------------------------------------------------------------
// --compute: plots meet the streets; the rest of the band stays with its cadastral parcel.
// ---------------------------------------------------------------------------------------------------------
async function compute() {
    const { footprints } = JSON.parse(await readFile(FOOTPRINT_FILE, 'utf8'));
    const state = await borovjeState(2);
    log(`version 2: ${state.layouts.length} parcel layouts, ${state.roads.length} streets, ${state.buildings.length} buildings, ${state.parks.length} parks`);
    require('dotenv').config({ path: new URL('../../backend/.env', import.meta.url).pathname, quiet: true });
    const { createPool } = require('./db/connection.cjs');
    const pool = createPool({ max: 1 });
    const db = await pool.connect();
    const q = (sql, params) => db.query(sql, params);
    try {
        await q(`CREATE TEMP TABLE piece (key text PRIMARY KEY, member text, owner text, g geometry(Geometry, 4326), ng geometry)`);
        await q(`CREATE TEMP TABLE street (member text PRIMARY KEY, old geometry, land geometry)`);
        for (const layout of state.layouts) {
            for (const plot of layout.plots) {
                await q('INSERT INTO piece VALUES ($1, $2, $3, ST_SetSRID(ST_GeomFromGeoJSON($4), 4326), NULL)',
                    [`${layout.key}#${plot.key}`, layout.key, plot.key, JSON.stringify(geometryOf(plot.geometry))]);
            }
        }
        for (const road of state.roads) {
            if (!footprints[road.key]) throw new Error(`${FOOTPRINT_FILE.pathname} has no footprint for ${road.key}: recapture`);
            await q(`INSERT INTO street VALUES ($1, ST_SetSRID(ST_GeomFromGeoJSON($2), 4326), ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON($3), 4326)))`,
                [road.key, JSON.stringify(geometryOf(road.definition.polygon)), JSON.stringify(footprints[road.key])]);
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
        for (const building of state.buildings) {
            const { rows: [r] } = await q(`SELECT ST_Area(ST_Transform(ST_Difference(ST_SetSRID(ST_GeomFromGeoJSON($1), 4326), ng), 3765)) AS m2 FROM piece WHERE owner = $2`,
                [JSON.stringify(building.geometry), building.key]);
            if (!r || r.m2 > 0.01) throw new Error(`building ${building.name} leaves its plot by ${r?.m2} m²`);
        }

        // An unchanged piece keeps its original coordinates exactly.
        const pieces = (await q(`SELECT key, member, owner, ST_AsGeoJSON(CASE WHEN ST_Equals(g, ng) THEN g ELSE ng END, 15) AS g,
            ST_Area(ST_Transform(g, 3765)) AS before_m2, ST_Area(ST_Transform(ng, 3765)) AS m2, ST_Equals(g, ng) AS same FROM piece ORDER BY key`)).rows;
        const members = {};
        for (const layout of state.layouts) {
            const own = pieces.filter(p => p.member === layout.key);
            if (own.every(p => p.same)) continue;
            const { rows: [u] } = await q('SELECT ST_AsGeoJSON(ST_Union(ng), 15) AS g FROM piece WHERE member = $1', [layout.key]);
            members[layout.key] = { pool: JSON.parse(u.g), plots: Object.fromEntries(own.map(p => [p.owner, { geometry: JSON.parse(p.g), m2: Number(p.m2.toFixed(1)) }])) };
        }
        for (const road of state.roads) members[road.key] = { polygon: footprints[road.key] };
        for (const park of state.parks) {
            const plot = pieces.find(p => p.owner === park.key);
            if (!plot.same) members[park.key] = { geometry: JSON.parse(plot.g) };
        }
        const { rows: [areas] } = await q(`SELECT (SELECT ST_Area(ST_Transform(ST_Union(old), 3765)) FROM street) AS before, (SELECT ST_Area(ST_Transform(ST_Union(land), 3765)) FROM street) AS after`);
        const result = {
            comment: 'Generated by fit-streets.mjs --compute: the UPU Borovje members that change when streets take exactly their lanes (version 3), by design key, geometry in EPSG:4326. borovje-designs.mjs replays them onto version 2.',
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

if (values.capture) await capture();
else await compute();
