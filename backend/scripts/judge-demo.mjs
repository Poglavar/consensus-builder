#!/usr/bin/env node
// One-command, read-only judge walkthrough over the same public contracts used by the web demo.

import { auditHackathonProof } from '../agents/hackathon-proof-audit.js';
import { buildJudgeDemo } from '../agents/judge-demo.js';

function usage(code = 0) {
    console.log([
        'Run the public Hyperstition judge walkthrough.', '',
        'Usage: npm run demo:judge -- [options]',
        '  --url <backend>   Default: https://api.urbangametheory.xyz',
        '  --json            Print machine-readable output',
        '  --help'
    ].join('\n'));
    process.exit(code);
}

function parseArgs(argv) {
    const parsed = { baseUrl: 'https://api.urbangametheory.xyz', json: false };
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (token === '--help') usage(0);
        if (token === '--json') { parsed.json = true; continue; }
        if (token !== '--url' || !argv[index + 1]) usage(2);
        parsed.baseUrl = argv[index + 1].replace(/\/$/, '');
        index += 1;
    }
    return parsed;
}

async function fetchJson(url) {
    const response = await fetch(url, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`${url} returned ${response.status}`);
    return response.json();
}

const args = parseArgs(process.argv.slice(2));
try {
    const [audit, manifest, prospective] = await Promise.all([
        auditHackathonProof({ baseUrl: args.baseUrl }),
        fetchJson(`${args.baseUrl}/hackathon/proof.json`),
        fetchJson(`${args.baseUrl}/oracle/markets/prospective/status`)
    ]);
    const demo = buildJudgeDemo({ audit, manifest, prospective });
    if (args.json) console.log(JSON.stringify({ ...demo, audit }, null, 2));
    else {
        console.log(`${demo.title}\n${demo.thesis || ''}\n`);
        demo.steps.forEach((step, index) => console.log(`${index + 1}. ${step.label}\n   ${step.url || 'unavailable'}`));
        console.log(`\nPublic proof: ${demo.proofSummary.pass} passed · ${demo.proofSummary.warn} warning · ${demo.proofSummary.fail} failed`);
        console.log(`Demo readiness: ${demo.status.toUpperCase()}`);
    }
    if (demo.status !== 'ready') process.exitCode = 1;
} catch (error) {
    console.error(`judge demo failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
}

