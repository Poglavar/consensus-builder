#!/usr/bin/env node
// Checks whether the San Francisco DBI building permits dataset answers a milestone market recipe:
// runs evidence/sf-dbi-permits.js over rows from a fixture file (dry run) or one live query, then
// prints each row's verdict and the MarketEvidence-v1 fact a lens member would attest. Never issues.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';
import {
    assessPermitRows, buildPermitQuery, fetchPermitRows, permitQueryForRecipe, readPermitRecipe, SF_TIME_ZONE
} from '../evidence/sf-dbi-permits.js';
import { RECIPE_HASH_PATTERN, validateMarketEvidence } from '../oracle/lens-schemas.js';

// The subject text is the builder's: jurisdiction and the canonical parcel-set hash, never the ids.
const require = createRequire(import.meta.url);
const { subjectTextOf } = require('../../frontend/js/bets/market-question.js');

function usage(code = 0) {
    console.log([
        'Usage: node scripts/check-permit-evidence.mjs --recipe <recipe.json> (--fixture <rows.json> --observed-at <time> | --live-fetch)',
        '',
        '  --recipe <path>         An sf-dbi-permits-v1 recipe body from the market question builder, or the',
        '                          served recipe (with trustedAttesters and hash; then the full attestation',
        '                          body for POST /lens/market-evidence is printed too).',
        '  --fixture <path>        Dry run over a JSON array of DBI permit rows (e.g. a saved response).',
        '  --observed-at <time>    With --fixture: when those rows were read, Unix seconds or an ISO instant',
        '                          with its zone (2026-10-12T01:12:30Z). Never taken from the rows.',
        '  --live-fetch            Query data.sf.gov once (the permit, or every permit on the parcels\' blocks);',
        '                          the observation time is the response\'s Date header.',
        '  --timeout-ms <n>        Live query timeout (default 15000).',
        '  --help                  This text.',
        '',
        'Prints timestamped lines and the conclusion: a fact (value, eventTime, sourceObservedAt, sourceRef)',
        'or "no qualifying record yet". Exit 0 when the check ran; 1 on an error or a fact that cannot be attested.'
    ].join('\n'));
    process.exit(code);
}

function log(message) {
    console.log(`[${new Date().toISOString()}] ${message}`);
}

const iso = seconds => new Date(seconds * 1000).toISOString();
// The same instant on San Francisco's clock, the zone the dataset's dates are written in.
const PACIFIC = new Intl.DateTimeFormat('sv-SE', {
    timeZone: SF_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
});
const pacific = seconds => `${PACIFIC.format(new Date(seconds * 1000))} Pacific`;

// Unix seconds, or an ISO instant that names its zone: a zoneless time would be guessed, not read.
function observedAtOf(value) {
    if (/^\d+$/.test(value)) return Number(value);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(value)) {
        throw new Error(`--observed-at ${value} must be Unix seconds or an ISO instant ending in Z or an offset`);
    }
    return Math.floor(Date.parse(value) / 1000);
}

// The recipe's subject text as frontend/js/bets/market-question.js builds it (jurisdiction, then the
// sorted parcel ids joined by ','): what a MarketEvidence-v1 attestation carries as `subject`.

async function main() {
    const argv = process.argv.slice(2);
    if (!argv.length) usage(0);
    let values;
    try {
        ({ values } = parseArgs({
            args: argv,
            options: {
                recipe: { type: 'string' },
                fixture: { type: 'string' },
                'observed-at': { type: 'string' },
                'live-fetch': { type: 'boolean' },
                'timeout-ms': { type: 'string', default: '15000' },
                help: { type: 'boolean' }
            }
        }));
    } catch (error) {
        console.error(error.message);
        usage(2);
    }
    if (values.help) usage(0);
    if (!values.recipe) throw new Error('--recipe is required');
    if (!!values.fixture === !!values['live-fetch']) throw new Error('pass exactly one of --fixture or --live-fetch');
    if (values.fixture && !values['observed-at']) throw new Error('--fixture needs --observed-at: when the rows were read (it is never taken from a row)');
    if (values['live-fetch'] && values['observed-at']) throw new Error('--observed-at is for --fixture; a live fetch takes the time from the response');

    const recipe = JSON.parse(fs.readFileSync(values.recipe, 'utf8'));
    const rule = readPermitRecipe(recipe);
    const query = permitQueryForRecipe(recipe);
    log(`recipe ${recipe.id ?? '(no id)'}: ${rule.permitNumber ? `permit ${rule.permitNumber}` : 'any new-construction permit'} ${rule.event} by ${pacific(rule.closesAt)} (closesAt ${rule.closesAt}); reads ${rule.dateField}`);
    if (rule.parcels) {
        log(`parcels as block/lot: ${recipe.subject.parcelIds.map((id, i) => `${id}=${rule.parcels[i].block}/${rule.parcels[i].lot}`).join(', ')}`);
    }

    let rows;
    let observedAt;
    if (values.fixture) {
        rows = JSON.parse(fs.readFileSync(values.fixture, 'utf8'));
        if (!Array.isArray(rows)) throw new Error(`${values.fixture} must hold a JSON array of permit rows`);
        observedAt = observedAtOf(values['observed-at']);
        log(`fixture ${values.fixture}: ${rows.length} row(s), observed at ${iso(observedAt)} (--observed-at)`);
    } else {
        const timeoutMs = Number(values['timeout-ms']);
        if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error('--timeout-ms must be a positive integer');
        log(`GET ${buildPermitQuery(query).url}`);
        const result = await fetchPermitRows(query, { timeoutMs });
        rows = result.rows;
        observedAt = result.observedAt;
        log(`${rows.length} row(s), observed at ${iso(observedAt)} (${result.observedAtSource}); dataset last modified ${result.lastModified ?? 'not reported'}`);
    }

    const assessment = assessPermitRows(recipe, rows, { observedAt });
    for (const row of assessment.rows) {
        log(`  permit ${row.permitNumber ?? '?'} block ${row.block ?? '?'} lot ${row.lot ?? '?'} (${row.type ?? 'no type'}, ${row.status ?? 'no status'}): ${row.qualifies ? 'qualifies' : 'does not qualify'}; ${row.reason}`);
    }
    const { fact } = assessment;
    if (!fact) {
        log(`conclusion: no qualifying record yet. Nothing to attest; if none appears by ${pacific(rule.closesAt)} plus the market's grace, the market resolves NO.`);
        return;
    }
    log(`conclusion: evidence for YES. value "${fact.value}", eventTime ${fact.eventTime} (${pacific(fact.eventTime)}), sourceObservedAt ${fact.sourceObservedAt} (${iso(fact.sourceObservedAt)}), sourceRef ${fact.sourceRef}`);
    if (!(typeof recipe.hash === 'string' && RECIPE_HASH_PATTERN.test(recipe.hash))) {
        log('the recipe has no hash (the server adds trustedAttesters and hash, then hashes); pass the served recipe to print the attestation body');
        return;
    }
    const body = { recipeHash: recipe.hash, subject: subjectTextOf(recipe), ...fact };
    try {
        validateMarketEvidence(body);
        log('MarketEvidence-v1 body for POST /lens/market-evidence (operator token required):');
    } catch (error) {
        process.exitCode = 1;
        log(`WARNING: this fact cannot be attested as is: ${error.message}`);
    }
    console.log(JSON.stringify(body, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => {
        console.error(`[${new Date().toISOString()}] check-permit-evidence failed: ${error.message}`);
        process.exit(1);
    });
}
