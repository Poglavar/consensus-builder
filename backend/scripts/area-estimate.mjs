#!/usr/bin/env node
// Area estimate: what a rule set would add across an area if every building it allows were built, judged
// building by building — every building in the area, never a sample. Living Tradition (mansards): each house
// against the building eligibility set, from the shared API's building facts (OSM tags, the heritage register,
// building registers such as Colouring Britain). Strong Suburbs: each street's buildings, raised to the most the
// street code allows there, through the same StreetCode.check the agreement editor and ugt_draft_agreement run
// (density cap, historic limit, designations, facts). Floor area by Plan stats' arithmetic (plan-yield.js), money by
// the city's prices where each building stands (CityMoney through moneyOf, as ugt_compare).
//
// Checkpointed: each cell's buildings and verdicts, and each street's check, are written under --out as they finish;
// a rerun skips what is there and says so. Reads are serial and paced. Command line only.
//
// Usage: node scripts/area-estimate.mjs --city london (--bbox w,s,e,n | --small-areas <name> --search w,s,e,n)
//          [--rules living-tradition,strong-suburbs] [--out dir] [--max-cells N] [--assume-storeys N]

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createOverpassCellSource, PRIORITY } from '../buildings/osm-reference.js';
import { moneyOf } from '../agents/mcp-compare.js';
import { cellsOf, centreOf, inGeometry, factIdOf, judgeEligibility, existingHeightOf, extendedFeature, streetsOf, summarize, plotReader } from '../area-estimate/estimate.js';

const require = createRequire(import.meta.url);
const Eligibility = require('../../frontend/js/planning/eligibility.js');
const StreetCode = require('../../frontend/js/planning/street-code.js');
const Facts = require('../../frontend/js/buildings/building-facts.js');
const PlanYield = require('../../frontend/js/proposals/plan-yield.js');
const PLANNING_SOURCES = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../../frontend/data/planning-sources.json', import.meta.url)), 'utf8'));

const ts = () => new Date().toISOString();
const log = msg => console.log(`[${ts()}] [area-estimate] ${msg}`);
const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const box = text => { const b = String(text || '').split(',').map(Number); return b.length === 4 && b.every(Number.isFinite) && b[0] < b[2] && b[1] < b[3] ? b : null; };
const USAGE = `Usage: node scripts/area-estimate.mjs --city <id> (--bbox w,s,e,n | --small-areas <name> --search w,s,e,n) [options]
  --city C            the app city whose prices and planning rule sets apply (e.g. london)
  --bbox w,s,e,n      the area as a WGS84 box, or
  --small-areas NAME  the statistical small areas whose names start with NAME (e.g. "Havering": its MSOAs), found in
  --search w,s,e,n    this box (the shared API's population small areas)
  --rules R,...       living-tradition, strong-suburbs (default both)
  --out DIR           where cells, streets and the summary go (default tmp/area-estimate/<slug> in the repo)
  --max-cells N       only the first N cells (a test run)
  --assume-storeys N  also report Strong Suburbs with buildings of unknown height taken as N storeys (stated in the output)
  --parcel-source ID  the plots for the street code's light planes (default: the city's default parcel source)
  Reads: Overpass (Tracestrack per backend/.env) for buildings and streets, the shared API for building facts and
  densities, the planning constraint source for designations, the app's parcel source for plots (one 0.01° cell a read).`;
if (args.includes('--help') || args.includes('-h') || !opt('--city') || !(box(opt('--bbox')) || (opt('--small-areas') && box(opt('--search'))))) {
    console.log(USAGE);
    process.exit(args.includes('--help') || args.includes('-h') ? 0 : 1);
}
const city = opt('--city');
const rules = (opt('--rules') || 'living-tradition,strong-suburbs').split(',');
const assumeStoreys = opt('--assume-storeys') ? Number(opt('--assume-storeys')) : null;
const SHARED_API = process.env.BUILDING_FACTS_API || Facts.API_ROOT;
const APP_API = process.env.AREA_ESTIMATE_APP_API || 'https://api.urbangametheory.xyz';
const CELL_DEG = 0.01;
const FLOOR_H = 3.5;
// Street-code tests about what the designer chooses inside the storeys (ceiling heights), which no check of a site
// can settle: 3.5 m storeys leave a 2.5 m ceiling under any ordinary floor, and the setback storey's ceiling is set
// within its roof. An estimate counts them as met and says so.
const DESIGN_DETAILS = ['ssCeilingMin', 'ssSetbackCeiling'];
const LT = Eligibility.get('gb-living-tradition-mansards', '2026-11-27');
const SS = Eligibility.get('gb-strong-suburbs-street-code', '2021');
const cityConfig = require(`../../frontend/data/cities/${city}.js`) && globalThis.__cityConfigs?.[city];
const ruleSetIds = cityConfig?.planning?.ruleSetIds || [];

// Buildings and named streets of one Overpass cell, through the app's endpoint chain and throttle.
const fetchCell = createOverpassCellSource({
    label: 'area-estimate', priority: PRIORITY.other,
    buildQuery: ([w, s, e, n]) => `[out:json][timeout:25];(way["building"](${s},${w},${n},${e});way["highway"]["name"](${s},${w},${n},${e}););out geom;`,
    convert: (elements, cap) => {
        const features = [];
        for (const el of elements || []) {
            if (el.type !== 'way' || !Array.isArray(el.geometry)) continue;
            const pts = el.geometry.map(g => [g.lon, g.lat]);
            if (el.tags?.building !== undefined && pts.length >= 4 && pts[0][0] === pts.at(-1)[0] && pts[0][1] === pts.at(-1)[1]) {
                features.push({ type: 'Feature', id: `w${el.id}`, geometry: { type: 'Polygon', coordinates: [pts] }, properties: { osm_id: `w${el.id}`, kind: 'building' } });
            } else if (el.tags?.highway && el.tags?.name) {
                features.push({ type: 'Feature', id: `w${el.id}`, geometry: { type: 'LineString', coordinates: pts }, properties: { osm_id: `w${el.id}`, kind: 'street', name: el.tags.name } });
            }
        }
        return { features: features.slice(0, cap), truncated: features.length > cap };
    },
});

async function json(url) {
    const res = await fetch(url, { headers: { 'User-Agent': 'ugt-area-estimate', Accept: 'application/json' } });
    if (!res.ok) throw new Error(`${url.split('?')[0]}: HTTP ${res.status}`);
    return res.json();
}

// The area: a box, or the small areas named NAME (their outlines, read from the shared API in 0.1° tiles).
async function readArea() {
    if (box(opt('--bbox'))) { const b = box(opt('--bbox')); return { bbox: b, geometries: [{ type: 'Polygon', coordinates: [[[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]], [b[0], b[1]]]] }], areas: [] }; }
    const name = opt('--small-areas'), search = box(opt('--search'));
    const found = new Map();
    for (const tile of cellsOf(search, 0.1)) {
        const answer = await json(`${SHARED_API}/population/small-areas?bbox=${tile.bbox.map(v => v.toFixed(4)).join(',')}`);
        for (const area of answer.areas || []) if (String(area.name).startsWith(`${name} `)) found.set(area.code, area);
    }
    if (!found.size) throw new Error(`No small area named "${name} …" in ${search.join(',')}`);
    const geometries = [...found.values()].map(a => a.geometry);
    const pts = geometries.flatMap(g => (g.type === 'Polygon' ? [g.coordinates] : g.coordinates).flatMap(p => p[0]));
    const bbox = [Math.min(...pts.map(p => p[0])), Math.min(...pts.map(p => p[1])), Math.max(...pts.map(p => p[0])), Math.max(...pts.map(p => p[1]))];
    return { bbox, geometries, areas: [...found.values()].map(a => ({ code: a.code, name: a.name, densityPerHa: a.densityPerHa })) };
}

const factsCache = new Map();
async function readFacts(ids) {
    const missing = ids.filter(id => !factsCache.has(id));
    for (let i = 0; i < missing.length; i += 200) {
        const batch = missing.slice(i, i + 200);
        for (let attempt = 1; ; attempt++) {
            try {
                const answers = await Facts.readMany(batch, { base: SHARED_API });
                for (const id of batch) factsCache.set(id, answers.get(id) || null);
                break;
            } catch (err) {
                if (attempt >= 4) throw err;
                log(`facts read failed (${err.message}); retry ${attempt}/3 in ${20 * attempt} s`);
                await new Promise(resolve => setTimeout(resolve, 20000 * attempt)); // backoff before the next request
            }
        }
    }
    return new Map(ids.map(id => [id, factsCache.get(id)]));
}

const moneyAt = (addedM2, at) => {
    if (!(typeof addedM2 === 'number' && addedM2 > 0)) return null;
    const m = moneyOf({ city, floorAreaM2: addedM2, keptFloorAreaM2: 0, plots: [], at });
    return { value: m.value, constructionCost: m.constructionCost, devCharge: m.devCharge, saleTax: m.saleTax, totalCost: m.totalCost, profit: m.profit, profitShare: m.profitShare };
};

async function main() {
    const area = await readArea();
    const slug = (opt('--small-areas') || area.bbox.map(v => v.toFixed(3)).join('_')).toLowerCase().replace(/[^a-z0-9_.-]+/g, '-');
    const out = path.resolve(opt('--out') || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'tmp', 'area-estimate', slug));
    fs.mkdirSync(path.join(out, 'cells'), { recursive: true });
    fs.mkdirSync(path.join(out, 'streets'), { recursive: true });
    const inArea = point => area.geometries.some(g => inGeometry(point, g));
    let cells = cellsOf(area.bbox, CELL_DEG);
    if (opt('--max-cells')) cells = cells.slice(0, Number(opt('--max-cells')));
    log(`${city}: area ${area.bbox.map(v => v.toFixed(4)).join(',')}${area.areas.length ? ` (${area.areas.length} small areas)` : ''}, ${cells.length} cells, rules ${rules.join(', ')} → ${out}`);
    const started = Date.now();

    // 1. Cells: the buildings whose centre lies in the cell and the area, their facts and the Living Tradition verdicts.
    let skipped = 0;
    for (const [index, cell] of cells.entries()) {
        const file = path.join(out, 'cells', `${cell.key}.json`);
        if (fs.existsSync(file)) { skipped++; continue; }
        const pad = 0.0006;
        const fc = await fetchCell([cell.bbox[0] - pad, cell.bbox[1] - pad, cell.bbox[2] + pad, cell.bbox[3] + pad]);
        if (fc.partial || fc.truncated) { log(`cell ${cell.key}: the read was ${fc.partial ? 'partial' : 'truncated'}; left for a rerun`); continue; }
        const buildings = fc.features.filter(f => f.properties.kind === 'building');
        const mine = buildings.filter(f => { const c = centreOf(f.geometry); return c && c[0] >= cell.bbox[0] && c[0] < cell.bbox[2] && c[1] >= cell.bbox[1] && c[1] < cell.bbox[3] && inArea(c); });
        const contracts = await readFacts(mine.map(factIdOf).filter(Boolean));
        const rows = mine.map(f => {
            const id = factIdOf(f), contract = contracts.get(id), at = centreOf(f.geometry);
            const row = { id, at, footprint: f.geometry, existingHeightM: existingHeightOf(contract, FLOOR_H), built: contract?.facts?.built?.value ?? null,
                builtSource: contract?.facts?.built?.source ?? null, contract: contract ?? null };
            if (rules.includes('living-tradition')) {
                const lt = judgeEligibility(LT, contract, f, buildings);
                row.lt = { ...lt, money: moneyAt(lt.addedM2, at) };
            }
            return row;
        });
        const streets = fc.features.filter(f => f.properties.kind === 'street').map(f => ({ name: f.properties.name, id: f.id, line: f.geometry.coordinates }));
        fs.writeFileSync(file, JSON.stringify({ cell, rows, streets }));
        const done = index + 1 - skipped, rate = (Date.now() - started) / Math.max(1, done);
        log(`cell ${index + 1}/${cells.length} ${cell.key}: ${mine.length} buildings · ETA ${Math.round(rate * (cells.length - index - 1) / 1000)} s`);
    }
    if (skipped) log(`${skipped} cells were already done (resumed)`);
    const cellFiles = cells.map(c => path.join(out, 'cells', `${c.key}.json`)).filter(f => fs.existsSync(f)).map(f => JSON.parse(fs.readFileSync(f, 'utf8')));
    const rows = cellFiles.flatMap(c => c.rows);
    const missingCells = cells.length - cellFiles.length;

    // 2. Streets: every named street's buildings, raised to the most the street code allows there, checked as a plan.
    const ssRows = [];
    if (rules.includes('strong-suburbs')) {
        const byName = new Map();
        for (const c of cellFiles) for (const s of c.streets) { if (!byName.has(s.name)) byName.set(s.name, new Map()); byName.get(s.name).set(s.id, s.line); }
        const streets = [...byName].map(([name, lines]) => ({ name, lines: [...lines.values()] }));
        const features = rows.map(r => ({ type: 'Feature', id: r.id, geometry: r.footprint, properties: { osm_id: `w${r.id.split('/')[1]}` } }));
        const grouped = streetsOf(features, streets);
        const rowById = new Map(rows.map(r => [r.id, r]));
        for (const r of rows) factsCache.set(r.id, r.contract);
        const readers = StreetCode.readers({ fetch: (url, init) => fetch(url.startsWith('/') ? APP_API + url : url, init), backendBase: APP_API, sharedApi: SHARED_API,
            config: PLANNING_SOURCES, ruleSetIds, readFacts });
        const allBuildings = features;
        // The density areas around the whole area, read once in 0.1° tiles (the source's limit).
        const densityAreas = new Map();
        const [w0, s0, e0, n0] = area.bbox;
        for (const tile of cellsOf([w0 - 0.01, s0 - 0.01, e0 + 0.01, n0 + 0.01], 0.1)) {
            const answer = await readers.density(tile.bbox);
            for (const a of answer.areas) densityAreas.set(`${a.scheme}:${a.code}`, a);
        }
        // The plots around each street (the light planes, paras 35 and 52), from the city's parcel source a cell at a time.
        const sources = (await json(`${APP_API}/parcel-sources`)).sources || [];
        const parcelSourceId = opt('--parcel-source') || sources.find(s => (s.cityIds || []).includes(city) && s.defaultForCity)?.id;
        if (!parcelSourceId) throw new Error(`No parcel source for ${city}; pass --parcel-source.`);
        const plots = plotReader(async ([w, s, e, n]) => {
            for (let attempt = 1; ; attempt++) {
                try {
                    const answer = await json(`${APP_API}/parcel-sources/${encodeURIComponent(parcelSourceId)}?bbox=${w},${s},${e},${n}`);
                    if (answer.complete !== true || !Array.isArray(answer.features)) throw new Error('the plots read was incomplete');
                    return answer.features.filter(f => f.id != null && f.geometry).map(f => ({ id: String(f.id), geometry: f.geometry }));
                } catch (err) {
                    if (attempt >= 4) throw err;
                    log(`plots read failed (${err.message}); retry ${attempt}/3 in ${20 * attempt} s`);
                    await new Promise(resolve => setTimeout(resolve, 20000 * attempt)); // backoff before the next request
                }
            }
        });
        log(`plots from ${parcelSourceId}`);
        const read = { ...readers, plots,
            density: async () => ({ areas: [...densityAreas.values()], sources: [] }),
            // The area's buildings are already read: the ones near a street come from them (outside the area, none).
            buildingsNear: async ([w, s, e, n]) => allBuildings.filter(f => { const c = centreOf(f.geometry); return c[0] >= w && c[0] <= e && c[1] >= s && c[1] <= n; }) };
        // Streets in the order of the cell their first building is in, so the plots read for a cell serve its streets.
        const cellOf = f => { const [x, y] = centreOf(f.geometry); return [Math.floor(y / CELL_DEG), Math.floor(x / CELL_DEG)]; };
        const ordered = [...grouped].sort(([, a], [, b]) => { const [ay, ax] = cellOf(a[0]), [by, bx] = cellOf(b[0]); return ay - by || ax - bx; });
        let n = 0;
        for (const [name, list] of ordered) {
            n++;
            if (!name) continue;
            const file = path.join(out, 'streets', `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.json`);
            let result;
            if (fs.existsSync(file)) result = JSON.parse(fs.readFileSync(file, 'utf8'));
            else {
                const lines = streets.find(s => s.name === name).lines;
                // The cap first (the density near the street), then each building at it with one setback storey (a mansard).
                const cap = StreetCode.storeyCap(SS, { areas: [...densityAreas.values()], street: lines, buildings: list.map(f => ({ geometry: f.geometry })) });
                const walls = cap.value ?? cap.bound;
                if (!walls) { result = { name, cap, buildings: list.map(f => ({ id: f.id, verdict: 'unknown', reason: 'no storey cap' })) }; }
                else {
                    const design = { buildingProposal: { typologyType: 'block', parameters: { mode: 'existing', roof: 'mansard' } },
                        geometry: { buildings: list.map(f => extendedFeature(f, { walls, floorHeightM: FLOOR_H, existingHeightM: rowById.get(f.id)?.existingHeightM ?? null })) } };
                    const outcome = await StreetCode.check(SS, { designs: [design], street: lines, read });
                    const measured = design.geometry.buildings.map(b => PlanYield.measureBuilding(b, design.buildingProposal, {}, design.geometry.buildings));
                    result = { name, walls, cap: outcome.cap, historic: outcome.historic, errors: outcome.errors,
                        buildings: outcome.buildings.map((b, i) => {
                            const m = measured[i];
                            const kept = m.keptGfaM2, assumedKept = assumeStoreys ? m.footprintM2 * Math.min(m.floors, assumeStoreys) : null;
                            return { id: list[i].id, verdict: b.result.verdict, failing: b.result.tests.filter(t => t.status === 'fail').map(t => t.id),
                                unknown: b.result.tests.filter(t => t.status === 'unknown').map(t => t.id),
                                addedM2: typeof kept === 'number' ? Math.max(0, m.gfaM2 - kept) : null,
                                assumedAddedM2: kept === null && assumedKept !== null ? Math.max(0, m.gfaM2 - assumedKept) : null };
                        }) };
                }
                fs.writeFileSync(file, JSON.stringify(result));
                log(`street ${n}/${grouped.size} ${name}: ${list.length} buildings, cap ${walls ?? 'unknown'}`);
            }
            for (const b of result.buildings) {
                const at = rowById.get(b.id)?.at;
                // Ceiling heights are the design's to state, not the site's: a building whose only unknown tests are
                // those counts as eligible here (DESIGN_DETAILS, stated in the summary).
                const verdict = b.verdict === 'unknown' && !(b.failing || []).length && (b.unknown || []).every(id => DESIGN_DETAILS.includes(id)) ? 'eligible' : b.verdict;
                ssRows.push({ ...b, verdict, street: name, money: moneyAt(b.addedM2, at), assumedMoney: moneyAt(b.assumedAddedM2, at) });
            }
        }
    }

    // 3. The summary.
    const summary = { city, area: { bbox: area.bbox, smallAreas: area.areas }, generatedAt: ts(), cells: cells.length, cellsMissing: missingCells,
        buildings: rows.length, builtKnown: rows.filter(r => r.built).length, builtBySource: rows.reduce((m, r) => { if (r.builtSource) m[r.builtSource] = (m[r.builtSource] || 0) + 1; return m; }, {}),
        heightKnown: rows.filter(r => r.existingHeightM !== null).length };
    if (rules.includes('living-tradition')) summary.livingTradition = summarize(rows.map(r => ({ ...r.lt })));
    if (rules.includes('strong-suburbs')) {
        summary.strongSuburbs = { designDetailsTakenAsMet: DESIGN_DETAILS, storeyHeightM: FLOOR_H, ...summarize(ssRows) };
        if (assumeStoreys) summary.strongSuburbsAssumed = { assumption: `buildings of unknown height taken as ${assumeStoreys} storeys`,
            ...summarize(ssRows.map(r => ({ ...r, addedM2: r.addedM2 ?? r.assumedAddedM2, money: r.money ?? r.assumedMoney }))) };
    }
    summary.elapsedS = Math.round((Date.now() - started) / 1000);
    fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 1));
    log(`done: ${rows.length} buildings in ${cellFiles.length}/${cells.length} cells${missingCells ? ` (${missingCells} to rerun)` : ''} · ${summary.elapsedS} s · ${path.join(out, 'summary.json')}`);
    if (missingCells) process.exitCode = 1;
}

main().catch(err => { console.error(`[${ts()}] [area-estimate] failed: ${err.stack || err.message}`); process.exit(1); });
