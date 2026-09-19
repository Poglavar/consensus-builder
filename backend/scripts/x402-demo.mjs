#!/usr/bin/env node
// One-command hackathon proof: discover the paid route, inspect its Bazaar schema, pay once, retry
// the exact operation without another settlement, read the server-stamped provenance back, and print
// links a judge can open. --dry-run performs discovery and the 402 challenge only.

import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildDemoProposal, runX402Demo } from '../agents/x402-demo.js';

function usage(exitCode) {
    console.log([
        'Deterministic x402 proposal demo: discover → pay → safe retry → verify.',
        '',
        'Choose exactly one:',
        '  --dry-run             Discover and inspect the 402; pay and write nothing',
        '  --live                Submit, retry and verify the stored proposal',
        '',
        'Required:',
        '  --url <base>          Backend base URL, e.g. http://localhost:3999',
        '  --parcels <a,b,...>   Cadastre parcel ids (or use --body-file)',
        '  --body-file <file>    Exact proposal JSON; useful for geometric proposals',
        '  --keypair <file>      Solana keypair JSON (live mode only)',
        '',
        'Optional:',
        '  --city <id>           Default: zagreb',
        '  --proposal-id <id>    Override the body-derived stable proposal id',
        '  --name <text> --description <text> --offer <n> --currency <code>',
        '  --persona <name> --rationale <text> --run-id <id>',
        '  --rpc <url>           Solana RPC override',
        '  --app-url <base>      Frontend base for a judge-facing proposal link',
        '  --json                Print one machine-readable result instead of the walkthrough',
        '  --help                This text'
    ].join('\n'));
    process.exit(exitCode);
}

function parseArgs(argv) {
    const args = {};
    for (let i = 0; i < argv.length; i += 1) {
        const token = argv[i];
        if (token === '--help') usage(0);
        if (token === '--dry-run') { args.dryRun = true; continue; }
        if (token === '--live') { args.live = true; continue; }
        if (token === '--json') { args.json = true; continue; }
        if (!token.startsWith('--')) usage(2);
        const value = argv[i + 1];
        if (value === undefined || value.startsWith('--')) usage(2);
        args[token.slice(2)] = value;
        i += 1;
    }
    if (Boolean(args.dryRun) === Boolean(args.live)) {
        console.error('choose exactly one of --dry-run or --live');
        usage(2);
    }
    if (!args.url || (!args.parcels && !args['body-file'])) {
        console.error('--url and either --parcels or --body-file are required');
        usage(2);
    }
    if (args.live && !args.keypair) {
        console.error('--keypair is required in live mode');
        usage(2);
    }
    return args;
}

function loadSecretKey(file) {
    const resolved = file.startsWith('~') ? path.join(os.homedir(), file.slice(1)) : file;
    const secret = new Uint8Array(JSON.parse(readFileSync(resolved, 'utf8')));
    if (secret.length !== 64) throw new Error(`keypair must contain 64 bytes, got ${secret.length}`);
    return secret;
}

function loadProposalBody(file) {
    const resolved = file.startsWith('~') ? path.join(os.homedir(), file.slice(1)) : file;
    const body = JSON.parse(readFileSync(resolved, 'utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new Error('body file must contain one proposal object');
    }
    if (!body.proposalId || !String(body.proposalId).trim()) {
        throw new Error('body file must contain a stable proposalId');
    }
    if (!Array.isArray(body.cadastreParcelIds) || body.cadastreParcelIds.length === 0) {
        throw new Error('body file must contain at least one cadastreParcelIds entry');
    }
    return body;
}

function catalogLabel(catalog) {
    if (catalog.state === 'listed') return 'listed in facilitator Bazaar';
    if (catalog.state === 'not-listed') return `not listed yet${catalog.total == null ? '' : ` (${catalog.total} filtered resources)`}`;
    if (catalog.state === 'unavailable') return `lookup unavailable: ${catalog.error}`;
    return 'facilitator not configured';
}

function printResult(result) {
    const accept = result.discovered.required.accepts[0];
    console.log('DISCOVERY');
    console.log(`  manifest       ${result.discovered.manifestUrl}`);
    console.log(`  paid endpoint  ${result.discovered.manifest.endpoints.submit}`);
    console.log(`  Bazaar schema  ${result.discovered.declaration.method} ${result.discovered.declaration.bodyType} ✓`);
    console.log(`  catalog        ${catalogLabel(result.discovered.catalogBefore)}`);
    console.log(`  payment        ${accept.amount} atomic units · ${accept.network} · to ${accept.payTo}`);
    console.log(`  proposal id    ${result.body.proposalId}`);
    console.log(`  payment id     ${result.paymentId}`);
    if (result.dryRun) {
        console.log('\nDRY RUN — no payment signed and no proposal written.');
        return;
    }
    console.log('\nVERIFICATION');
    console.log(`  payer          ${result.payerAddress}`);
    console.log(`  first submit   ${result.first.status} · stored or exact prior replay`);
    console.log(`  deliberate retry ${result.replay.status} · same proposal and settlement ✓`);
    console.log(`  read-back      wallet + settlement provenance verified ✓`);
    console.log(`  catalog after  ${catalogLabel(result.discovered.catalogAfter)}`);
    console.log('\nOPEN');
    console.log(`  proposal API   ${result.links.proposalApi}`);
    if (result.links.proposalApp) console.log(`  proposal app   ${result.links.proposalApp}`);
    console.log(`  settlement     ${result.links.settlement}`);
    console.log(`  agent manifest ${result.links.manifest}`);
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const body = args['body-file']
        ? loadProposalBody(args['body-file'])
        : buildDemoProposal({
            city: args.city,
            parcels: args.parcels,
            proposalId: args['proposal-id'],
            name: args.name,
            description: args.description,
            offer: args.offer,
            currency: args.currency,
            persona: args.persona,
            rationale: args.rationale,
            runId: args['run-id']
        });
    const result = await runX402Demo({
        baseUrl: args.url,
        body,
        secretKey: args.live ? loadSecretKey(args.keypair) : undefined,
        dryRun: args.dryRun,
        rpcUrl: args.rpc,
        appUrl: args['app-url']
    });
    if (args.json) {
        console.log(JSON.stringify({
            dryRun: result.dryRun,
            proposalId: result.body.proposalId,
            paymentId: result.paymentId,
            payer: result.payerAddress ?? null,
            bazaarBefore: result.discovered.catalogBefore.state,
            bazaarAfter: result.discovered.catalogAfter?.state ?? null,
            replayVerified: Boolean(result.replayProof),
            links: result.links ?? { manifest: result.discovered.manifestUrl }
        }, null, 2));
        return;
    }
    printResult(result);
}

main().catch(error => {
    console.error(`x402 demo failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
});
