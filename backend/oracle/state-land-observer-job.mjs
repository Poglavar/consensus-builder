#!/usr/bin/env node
// CLI of the state land observer (state-land-observer.js): one pass reads every configured city's
// free state plots and land applications from the cadastre, archives each read as a snapshot and
// records every status change as a `state_land_status` land event. Dry run unless --apply.
// Restartable and idempotent: a pass diffs against the events already recorded, and an event's id
// is deterministic, so a repeated pass writes nothing new.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import dotenv from 'dotenv';
import { createPool } from '../db/connection.cjs';
import { createHttpsJsonFetch } from '../parcels/https-json-fetch.js';
import { createStateLandStore, observeStateLand, stateLandCities } from './state-land-observer.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
// The cadastre's server omits its intermediate certificate; the PKK parcel sources carry the same one.
const PKK_CA = path.join(HERE, '..', 'parcels', 'certificates', 'sectigo-public-server-authentication-ca-dv-r36.pem');
const PKK_REFERER = 'https://map.gov4c.kz/egkn/';

const log = message => console.log(`[${new Date().toISOString()}] [state-land-observer] ${message}`);

function usage(code = 0) {
    console.log([
        'Usage: node oracle/state-land-observer-job.mjs (--once | --apply) [--city <id>]',
        '',
        '  --once         One dry-run pass: read the cadastre, print what would be recorded, write nothing.',
        '  --apply        One written pass: store the snapshots and insert the land events.',
        '  --city <id>    Only this city (default: every city whose configuration has a stateLand block).',
        '  --help         This text.',
        '',
        'Exit code 1 when any city or view failed; the other views of the pass are still recorded.',
        'Env (backend/.env): DATABASE_URL.'
    ].join('\n'));
    process.exit(code);
}

function options() {
    const argv = process.argv.slice(2);
    if (!argv.length) usage(0);
    let values;
    try {
        ({ values } = parseArgs({ args: argv, options: {
            once: { type: 'boolean' }, apply: { type: 'boolean' }, city: { type: 'string' }, help: { type: 'boolean' }
        } }));
    } catch (error) {
        console.error(error.message);
        usage(2);
    }
    if (values.help) usage(0);
    if (!values.once && !values.apply) usage(2);
    return { apply: Boolean(values.apply), city: values.city || null };
}

async function main() {
    const opts = options();
    dotenv.config({ path: path.join(HERE, '..', '.env'), quiet: true });
    require('../../frontend/data/city-configs.js');
    const cities = stateLandCities(globalThis.__cityConfigs).filter(entry => !opts.city || entry.cityId === opts.city);
    if (!cities.length) throw new Error(opts.city ? `city ${opts.city} has no stateLand configuration` : 'no city has a stateLand configuration');
    const httpsFetch = createHttpsJsonFetch(fs.readFileSync(PKK_CA, 'utf8'));
    const fetchJson = async url => {
        const response = await httpsFetch(url, { headers: { Referer: PKK_REFERER, Accept: 'application/json' } });
        if (!response.ok) throw new Error(`the cadastre answered HTTP ${response.status}`);
        return response.json();
    };
    const pool = createPool();
    pool.on('error', error => log(`idle pg client error: ${error.message}`));
    log(`${opts.apply ? 'APPLY' : 'DRY RUN'}: ${cities.map(entry => entry.cityId).join(', ')}`);
    try {
        const result = await observeStateLand({ cities, fetchJson, store: createStateLandStore(pool), apply: opts.apply, log });
        const events = result.views.reduce((sum, view) => sum + view.events, 0);
        log(`pass done: ${result.views.length} view(s) read · ${events} event(s)${opts.apply ? ' recorded' : ' would be recorded'} · ${result.failed.length} failed`);
        process.exitCode = result.failed.length ? 1 : 0;
    } finally {
        await pool.end();
    }
}

main().catch(error => {
    log(`failed: ${error.stack || error.message}`);
    process.exit(1);
});
