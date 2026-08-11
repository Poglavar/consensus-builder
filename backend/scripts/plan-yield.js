#!/usr/bin/env node
// What a city's plan yields — floor area, apartments, people — read straight from the database.
//
// The stats dialog answers this for the plan loaded in a browser; this answers it for the plan of
// record, over every proposal the server holds, which is the only version a report can cite. Both
// call the SAME arithmetic (frontend/js/proposals/plan-yield.js), so a figure quoted from here and a
// figure read off the dialog cannot drift apart.
//
// Counts urban rules (block/row/parcel-based generators, whose buildings carry an urbanRule) and
// freeform structures (hand-drawn single buildings; parks/squares/lakes as open space) alike.
//
// Read-only.
//
//   node scripts/plan-yield.js --city sibenik
//   node scripts/plan-yield.js --city sibenik --json
//   node scripts/plan-yield.js --city sibenik --housing-share 60 --apartment 70

import pkg from 'pg';
import 'dotenv/config';
import { createRequire } from 'node:module';

const { Pool } = pkg;
// plan-yield.js is a classic browser script (UMD), so it is CommonJS from node's point of view.
const require = createRequire(import.meta.url);
const { DEFAULTS, planYield } = require('../../frontend/js/proposals/plan-yield.js');

function usage() {
    console.log([
        'What a city plan yields: floor area, apartments, people — per epoch.',
        '',
        '  --city NAME          City key as stored on the proposals (e.g. sibenik, zagreb). Required.',
        '  --all                Include proposals that are not applied (default: applied only).',
        '  --json               Print the raw result as JSON instead of a table.',
        '',
        'Assumptions (all optional, shown with their defaults):',
        `  --housing-share PCT  Share of floor area that is housing        [${DEFAULTS.housingShare * 100}]`,
        `  --efficiency PCT     Net internal area as a share of gross      [${DEFAULTS.efficiency * 100}]`,
        `  --apartment M2       Net m² of an average apartment             [${DEFAULTS.avgApartmentM2}]`,
        `  --persons N          People per apartment                       [${DEFAULTS.personsPerApartment}]`,
        `  --m2-per-job M2      Net m² of workplace per job                [${DEFAULTS.m2PerJob}]`,
        `  --floor-height M     Storey height when neither building nor rule says [${DEFAULTS.floorHeightM}]`,
        '',
        '  --help               Show this message.'
    ].join('\n'));
}

const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const log = message => console.log(`[${stamp()}] ${message}`);

function flag(argv, name) {
    return argv.includes(name);
}

function value(argv, name) {
    const at = argv.indexOf(name);
    if (at === -1 || at + 1 >= argv.length) return null;
    return argv[at + 1];
}

/** A CLI number or null — an unparseable --apartment must not silently become 0. */
function numberArg(argv, name) {
    const raw = value(argv, name);
    if (raw === null) return null;
    const n = Number(raw);
    if (!Number.isFinite(n)) {
        console.error(`${name} expects a number, got "${raw}"`);
        process.exit(1);
    }
    return n;
}

const int = n => Math.round(Number(n) || 0).toLocaleString('en-US');

function printTable(title, buckets, columns) {
    console.log('');
    console.log(title);
    const header = ['period', ...columns.map(c => c.head)];
    const rows = buckets.map(bucket => [
        bucket.year === null ? 'no epoch' : String(bucket.year),
        ...columns.map(c => c.get(bucket))
    ]);
    const widths = header.map((head, i) => Math.max(head.length, ...rows.map(r => r[i].length)));
    const line = cells => cells.map((cell, i) => (i === 0 ? cell.padEnd(widths[i]) : cell.padStart(widths[i]))).join('  ');
    console.log(line(header));
    console.log(widths.map(w => '─'.repeat(w)).join('  '));
    rows.forEach(row => console.log(line(row)));
}

const COLUMNS = [
    { head: 'proposals', get: b => int(b.proposals) },
    { head: 'buildings', get: b => int(b.buildings) },
    { head: 'footprint m²', get: b => int(b.footprintM2) },
    { head: 'GFA m²', get: b => int(b.grossFloorAreaM2) },
    { head: 'housing net m²', get: b => int(b.housingNetM2) },
    { head: 'apartments', get: b => int(b.apartments) },
    { head: 'people', get: b => int(b.people) },
    { head: 'jobs', get: b => int(b.jobs) },
    { head: 'open space m²', get: b => int(b.openSpaceM2) }
];

async function main() {
    const argv = process.argv.slice(2);
    if (flag(argv, '--help') || argv.length === 0) { usage(); process.exit(0); }

    const city = value(argv, '--city');
    if (!city) { console.error('--city is required (e.g. --city sibenik)'); process.exit(1); }

    const appliedOnly = !flag(argv, '--all');
    const asJson = flag(argv, '--json');

    const pct = name => {
        const n = numberArg(argv, name);
        return n === null ? null : n / 100;
    };
    const assumptions = {
        appliedOnly,
        housingShare: pct('--housing-share') ?? DEFAULTS.housingShare,
        efficiency: pct('--efficiency') ?? DEFAULTS.efficiency,
        avgApartmentM2: numberArg(argv, '--apartment') ?? DEFAULTS.avgApartmentM2,
        personsPerApartment: numberArg(argv, '--persons') ?? DEFAULTS.personsPerApartment,
        m2PerJob: numberArg(argv, '--m2-per-job') ?? DEFAULTS.m2PerJob,
        floorHeightM: numberArg(argv, '--floor-height') ?? DEFAULTS.floorHeightM
    };

    const pool = new Pool();
    try {
        if (!asJson) log(`database: ${process.env.PGDATABASE || 'geodata'} · city: ${city} · ${appliedOnly ? 'applied only' : 'all proposals'} (read-only)`);

        const { rows } = await pool.query(
            `SELECT id, proposal_id, name, applied, epoch_year, building_proposal, structure_proposal
               FROM public.proposal
              WHERE city = $1
              ORDER BY created_at`,
            [city]
        );
        if (!rows.length) {
            console.error(`No proposals found for city "${city}".`);
            process.exit(1);
        }

        const result = planYield(rows, assumptions);

        if (asJson) {
            console.log(JSON.stringify({ city, appliedOnly, ...result }, null, 2));
            return;
        }

        log(`${rows.length} proposals on record, ${result.total.proposals} counted`);

        printTable('ADDED per period', [...result.byEpoch, result.unassigned], COLUMNS);
        if (result.cumulative.length) {
            printTable('STANDING by the end of each period (cumulative, no-epoch proposals always in)', result.cumulative, COLUMNS);
        }
        printTable('TOTAL', [{ ...result.total, year: null }], COLUMNS);

        console.log('');
        console.log([
            `assumptions: housing ${Math.round(result.assumptions.housingShare * 100)}%`,
            `efficiency ${Math.round(result.assumptions.efficiency * 100)}%`,
            `${result.assumptions.avgApartmentM2} m²/apartment`,
            `${result.assumptions.personsPerApartment} persons/apartment`,
            `${result.assumptions.m2PerJob} m²/job`,
            `fallback storey ${result.assumptions.floorHeightM} m`
        ].join(' · '));
        console.log(`rule-driven proposals: ${result.total.ruleProposals} · freeform: ${result.total.freeformProposals} · open spaces: ${result.total.openSpaces}`);

        // A building whose height nothing states contributes footprint but NO floor area. Saying so
        // is the difference between a total that is low and a total that is quietly wrong.
        if (result.total.unmeasuredBuildings > 0) {
            console.log(`WARNING: ${result.total.unmeasuredBuildings} of ${result.total.buildings} buildings state no height — their floor area is NOT in these totals.`);
        }
        if (!result.byEpoch.length) {
            console.log('NOTE: no proposal carries an epoch year, so there is nothing to split by period yet.');
        }
    } finally {
        await pool.end();
    }
}

main().catch(error => {
    console.error(`[${stamp()}] plan-yield failed:`, error);
    process.exit(1);
});
