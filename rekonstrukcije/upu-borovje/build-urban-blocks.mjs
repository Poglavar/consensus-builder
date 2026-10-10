#!/usr/bin/env node
// "Borovje – urbani blokovi": an alternative to UPU Borovje – zona jug on the SAME eleven building plots
// (kazete M1-1…M1-11 of the official parcel layout). Each plot gets an open urban block instead of the
// plan's free-standing slab: a 12 m deep ring along the plot edge with its park-facing middle left out,
// so the building holds the street and both ends and its yard opens onto the park. The official
// streets, parcel layouts and parks are reused as they are; only the buildings differ.
//
// Plots and parks are read from the target backend's own Borovje parcel layouts, so the blocks always
// sit on the plots that backend actually has. Records are published through the normal API (site
// binding, then POST /proposals). Edit tokens, returned once, are kept outside the repo.
//
//   node build-urban-blocks.mjs                                  # dry run against http://localhost:3000
//   node build-urban-blocks.mjs --backend <api> --origin <app> --apply
import os from 'node:os';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';
import { openBlock, streetSideOf, buildingFeature, summarize, STOREY_M } from '../../backend/scripts/lib/borovje-alternatives.mjs';
import { publish, request } from '../../backend/scripts/lib/candlestick-common.mjs';
import { canonicalSeedRecord } from '../../backend/scripts/lib/canonical-seed-record.mjs';

// Turf comes from the backend's dependencies, like the other scripts in this folder.
const turf = createRequire(new URL('../../backend/package.json', import.meta.url))('@turf/turf');
const log = message => console.log(`[${new Date().toISOString()}] ${message}`);
const LAYOUT_IDS = ['p-upu-borovje-parcelacija', 'p-upu-borovje-parcelacija-2', 'p-upu-borovje-parcelacija-3'];
const PLAN_ID = 'borovje-urbani-blokovi';
const AUTHOR = 'Urban Game Theory – alternativni prijedlog';
// Taller along the two city streets (Tigrovi on the north, Bonde on the west), lower inside.
const STREET_PLOTS = new Set(['m1-1', 'm1-2', 'm1-10', 'm1-11']);
const floorsFor = plot => (STREET_PLOTS.has(plot) ? 6 : 5);

const { values } = parseArgs({ options: {
    backend: { type: 'string', default: 'http://localhost:3000' },
    origin: { type: 'string' },
    apply: { type: 'boolean' },
    out: { type: 'string' },
    help: { type: 'boolean' }
} });
if (values.help) {
    console.log(`Usage: node build-urban-blocks.mjs [--backend <api>] [--origin <app origin>] [--apply] [--out <file.geojson>]
Dry run by default: builds the 11 block records from the backend's Borovje plots and prints a summary.
--apply publishes them (records that already exist are left alone). --origin is required with --apply.`);
    process.exit(0);
}
if (values.apply && !values.origin) throw new Error('--apply needs --origin (the app origin the API accepts writes from)');

async function loadLayouts() {
    const plots = [];
    const green = [];
    for (const id of LAYOUT_IDS) {
        const { status, json } = await request(values.backend, values.origin || values.backend, 'GET', `/proposals/${id}`);
        if (status !== 200) throw new Error(`${values.backend} has no ${id} (${status}); publish the official plan first`);
        for (const polygon of json.reparcellization?.polygons || []) {
            const key = polygon.ownerKey || '';
            if (/^m1-\d+$/.test(key)) plots.push({ key, geometry: polygon.geometry });
            if (/^(z1|r2)-/.test(key)) green.push(turf.feature(polygon.geometry));
        }
    }
    if (plots.length !== 11) throw new Error(`expected 11 building plots M1-1…M1-11, found ${plots.length}`);
    const greenUnion = green.reduce((acc, feature) => (acc ? turf.union(acc, feature) : feature), null);
    return { plots: plots.sort((a, b) => Number(a.key.slice(3)) - Number(b.key.slice(3))), green: greenUnion.geometry };
}

// The parcels the backend binds this footprint to (POST /proposals/binding only reads), so the record
// can be validated whole before anything is written. publish() binds again when it writes.
async function boundParcels(site) {
    const { status, json, text } = await request(values.backend, values.origin || values.backend, 'POST', '/proposals/binding',
        { site, toleranceM: 0, city: 'zagreb', parcelSourceId: null });
    if (status !== 200 || !json?.binding) throw new Error(`binding failed (${status}): ${text.slice(0, 200)}`);
    if (json.binding.coverage !== 'complete') throw new Error(`binding coverage ${json.binding.coverage}`);
    return json.binding.parcels.map(parcel => parcel.parcelId);
}

function recordFor(plot, building, cadastreParcelIds) {
    const label = plot.key.toUpperCase();
    const floors = building.properties.floors;
    const height = building.properties.height;
    const area = Math.round(turf.area(building));
    const title = `Borovje – urbani blokovi: blok ${label}`;
    return canonicalSeedRecord({
        proposalId: `${PLAN_ID}-${plot.key}`,
        city: 'zagreb',
        type: 'building',
        goal: 'buildings',
        typologyType: 'single',
        name: title,
        title,
        author: AUTHOR,
        description: `Alternativa planu UPU Borovje – zona jug na istoj građevnoj čestici ${label}: otvoreni gradski blok `
            + `umjesto samostojeće lamele. Krilo dubine 12 m drži ulicu i oba kraja čestice, a dvorište se otvara prema parku. `
            + `P+${floors - 1} (${floors} nadzemnih etaža, ${height} m), tlocrt ${area} m², oko ${area * floors} m² GBP. `
            + 'Ulice, parcelacija i parkovi isti su kao u službenom planu.',
        site: { type: 'MultiPolygon', coordinates: [building.geometry.coordinates] },
        toleranceM: 0,
        geometry: { buildings: [{
            type: 'Feature',
            geometry: building.geometry,
            properties: { type: 'proposedBuildingSingle', block: `Borovje urbani blokovi ${label}`, height, levels: floors, rotation: 0 }
        }] },
        buildingProposal: { blockName: 'Borovje', parameters: { floors, height, rotation: 0, typology: 'single' } },
        alternativeOf: 'upu-borovje',
        planId: PLAN_ID,
        cadastreParcelIds
    });
}

const { plots, green } = await loadLayouts();
log(`${values.backend}: ${plots.length} plots, green ${Math.round(turf.area(green))} m² · storey ${STOREY_M} m`);
const buildings = [];
const records = [];
for (const plot of plots) {
    const block = openBlock(plot.geometry, { streetSide: streetSideOf(plot.geometry, green) });
    if (!block) throw new Error(`${plot.key}: no block fits`);
    const building = buildingFeature(plot.key, block.geometry, floorsFor(plot.key), { kind: block.kind });
    if (!turf.booleanWithin(building, turf.feature(plot.geometry))) throw new Error(`${plot.key}: block leaves its plot`);
    buildings.push(building);
    const parcels = await boundParcels({ type: 'MultiPolygon', coordinates: [building.geometry.coordinates] });
    records.push(recordFor(plot, building, parcels));
    log(`${plot.key.padEnd(5)} ${block.kind.padEnd(11)} ${Math.round(turf.area(building))} m² × ${floorsFor(plot.key)} · ${parcels.length} parcel(s)`);
}
const total = summarize(buildings);
log(`total: ${total.buildings} buildings, footprint ${total.footprintM2} m², floor area ${total.floorAreaM2} m²`);
if (values.out) {
    await writeFile(values.out, JSON.stringify({ type: 'FeatureCollection', features: buildings }));
    log(`wrote ${values.out}`);
}
if (!values.apply) {
    log('DRY RUN: nothing published. Pass --apply --origin <app origin> to publish.');
    process.exit(0);
}

const tokenFile = path.join(os.homedir(), '.config', 'ugt', 'edit-tokens', `${new URL(values.backend).host}.json`);
await mkdir(path.dirname(tokenFile), { recursive: true });
let tokens = {};
try { tokens = JSON.parse(await readFile(tokenFile, 'utf8')); } catch (_) { tokens = {}; }
const ids = [];
for (const record of records) {
    const result = await publish(record, { backend: values.backend, origin: values.origin, city: 'zagreb', parcelSourceId: null });
    ids.push(result.id);
    if (result.editToken) {
        tokens[record.proposalId] = { id: result.id, editToken: result.editToken, createdAt: new Date().toISOString() };
        await writeFile(tokenFile, JSON.stringify(tokens, null, 2), { mode: 0o600 });
    }
}
log(`published ${ids.length} records: ${ids.join(',')} · edit tokens in ${tokenFile}`);
