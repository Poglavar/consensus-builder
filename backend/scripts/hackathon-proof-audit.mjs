#!/usr/bin/env node
// One-command, read-only verification of the public evidence used by the judge demo.

import { auditHackathonProof } from '../agents/hackathon-proof-audit.js';

function usage(code = 0) {
    console.log([
        'Audit the public Hyperstition hackathon proof.',
        '',
        'Usage: node scripts/hackathon-proof-audit.mjs [options]',
        '  --url <backend>        Default: https://api.urbangametheory.xyz',
        '  --max-age-hours <n>    Freshness window for the daily proposer (default: 48)',
        '  --json                 Print the complete machine-readable result',
        '  --help'
    ].join('\n'));
    process.exit(code);
}

function argsOf(argv) {
    const args = {};
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (token === '--help') usage(0);
        if (token === '--json') { args.json = true; continue; }
        if (!['--url', '--max-age-hours'].includes(token) || !argv[index + 1]) usage(2);
        args[token.slice(2)] = argv[index + 1];
        index += 1;
    }
    const maxRunAgeHours = args['max-age-hours'] === undefined ? 48 : Number(args['max-age-hours']);
    if (!Number.isFinite(maxRunAgeHours) || maxRunAgeHours <= 0) usage(2);
    return { baseUrl: args.url, maxRunAgeHours, json: Boolean(args.json) };
}

const args = argsOf(process.argv.slice(2));
try {
    const result = await auditHackathonProof(args);
    if (args.json) console.log(JSON.stringify(result, null, 2));
    else {
        console.log(`Hyperstition public proof: ${result.status.toUpperCase()}`);
        for (const item of result.checks) {
            const mark = item.status === 'pass' ? '✓' : item.status === 'warn' ? '!' : '✗';
            console.log(`${mark} ${item.label}`);
        }
        console.log(`${result.summary.pass} passed · ${result.summary.warn} warning · ${result.summary.fail} failed`);
    }
    if (result.status !== 'verified') process.exitCode = 1;
} catch (error) {
    console.error(`hackathon proof audit failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
}
