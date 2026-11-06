#!/usr/bin/env node
// DUP Travno: records which cadastral parcels each drawn building binds, by the design index's own
// binding (backend/proposals/binding.js computeBinding, tolerance 0 as for a design without one) over the
// local cadastre, into the committed data/bindings.json. travno-designs.mjs groups buildings that bind a
// common parcel into one design, because a freeform building replaces the parcels it binds and two
// designs of one plan cannot replace the same parcel.
//
//   node restatements/dup-travno/record-bindings.mjs --compute

import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';
import { planBuildings } from './travno-designs.mjs';
import { computeBinding } from '../../backend/proposals/binding.js';

const require = createRequire(new URL('../../backend/package.json', import.meta.url));
const turf = require('@turf/turf');
const log = message => console.log(`[${new Date().toISOString()}] ${message}`);
const OUT = new URL('./data/bindings.json', import.meta.url);

const { values } = parseArgs({ options: { compute: { type: 'boolean' }, help: { type: 'boolean' } } });
if (values.help || !values.compute) {
    console.log('Usage: node restatements/dup-travno/record-bindings.mjs --compute   (local cadastre → data/bindings.json)');
    process.exit(values.help ? 0 : 1);
}

require('dotenv').config({ path: new URL('../../backend/.env', import.meta.url).pathname, quiet: true });
const { createPool, describeDatabase, isLocalDatabase } = require('./db/connection.cjs');
if (!isLocalDatabase()) throw new Error(`refusing a non-local database: ${describeDatabase()}`);

const pool = createPool();
try {
    const buildings = planBuildings();
    const out = {};
    for (const [index, building] of buildings.entries()) {
        const site = building.parts.slice(1).reduce((merged, part) => turf.union(merged, turf.feature(part.geometry)), turf.feature(building.parts[0].geometry)).geometry;
        const { binding } = await computeBinding(pool, { site, toleranceM: 0, city: 'zagreb', parcelSourceId: 'oss-wfs' });
        if (binding.coverage !== 'complete') throw new Error(`${building.key}: binding coverage ${binding.coverage}`);
        out[building.key] = binding.parcels.map(parcel => parcel.parcelId).sort();
        log(`${index + 1}/${buildings.length} ${building.key}: ${out[building.key].length} parcel(s)`);
    }
    await writeFile(OUT, `${JSON.stringify({ rule: 'computeBinding, toleranceM 0, source oss-wfs (local public.parcel)', buildings: out }, null, 1)}\n`);
    log(`wrote ${Object.keys(out).length} bindings`);
} finally {
    await pool.end();
}
