#!/usr/bin/env node
// Judge/operator proof for the paid oracle product: inspect its 402 and Bazaar contract, optionally
// pay with a low-value devnet wallet, validate the returned recipe-bound fact, then query the hosted
// catalog proof. No private event payload or key material is printed.

import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    buyOracleFact,
    createOracleFactClient,
    fetchOracleFactChallenge,
    oracleFactUrl
} from '../agents/oracle-fact-client.js';

function usage(code = 0) {
    console.log([
        'Paid oracle fact demo: inspect → pay → verify → discover.',
        '',
        'Choose exactly one: --dry-run | --live',
        'Required: --url <backend> --subject <proposal account>',
        'Live only: --keypair <Solana devnet keypair JSON>',
        'Optional: --market <market account> --rpc <URL> --json'
    ].join('\n'));
    process.exit(code);
}

function argsOf(argv) {
    const args = {};
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (token === '--help') usage(0);
        if (token === '--dry-run') { args.dryRun = true; continue; }
        if (token === '--live') { args.live = true; continue; }
        if (token === '--json') { args.json = true; continue; }
        if (!token.startsWith('--') || !argv[index + 1] || argv[index + 1].startsWith('--')) usage(2);
        args[token.slice(2)] = argv[index + 1];
        index += 1;
    }
    if (Boolean(args.dryRun) === Boolean(args.live) || !args.url || !args.subject || (args.live && !args.keypair)) usage(2);
    return args;
}

function secretFrom(file) {
    const location = file.startsWith('~/') ? path.join(os.homedir(), file.slice(2)) : file;
    return new Uint8Array(JSON.parse(readFileSync(location, 'utf8')));
}

function assertBundle(bundle, subject) {
    if (bundle?.verification?.status !== 'verified') throw new Error('response is not a verified fact bundle');
    if (bundle?.fact?.subject?.id !== subject) throw new Error('response subject does not match the request');
    if (bundle?.verification?.recipeHash !== bundle?.recipe?.hash) throw new Error('response recipe hash is inconsistent');
}

async function main() {
    const args = argsOf(process.argv.slice(2));
    const challenge = await fetchOracleFactChallenge({
        baseUrl: args.url, proposalAccount: args.subject, marketAccount: args.market
    });
    const accept = challenge.accepts[0];
    const result = {
        endpoint: oracleFactUrl(args.url, args.subject, args.market),
        dryRun: args.dryRun,
        challenge: {
            amountAtomic: accept.amount, asset: accept.asset, network: accept.network, payTo: accept.payTo,
            bazaarMethod: challenge.extensions?.bazaar?.info?.input?.method || null
        }
    };
    if (!args.dryRun) {
        const client = await createOracleFactClient({
            secretKey: secretFrom(args.keypair), rpcUrl: args.rpc
        });
        const paid = await buyOracleFact({
            baseUrl: args.url, proposalAccount: args.subject, marketAccount: args.market,
            paidFetch: client.paidFetch
        });
        if (paid.status !== 200) throw new Error(`paid fact request returned ${paid.status}: ${JSON.stringify(paid.body)}`);
        assertBundle(paid.body, args.subject);
        const discoveryUrl = new URL('/agent/discovery?resource=oracle-facts', args.url);
        const discoveryResponse = await fetch(discoveryUrl, { headers: { accept: 'application/json' } });
        result.payer = client.payerAddress;
        result.payment = paid.receipt;
        result.fact = {
            eventId: paid.body.fact.id,
            outcome: paid.body.fact.outcome,
            observedAt: paid.body.fact.observedAt,
            recipeHash: paid.body.recipe.hash,
            verified: true
        };
        result.discovery = discoveryResponse.ok ? await discoveryResponse.json() : { state: 'unavailable' };
    }
    if (args.json) return console.log(JSON.stringify(result, null, 2));
    console.log(`endpoint    ${result.endpoint}`);
    console.log(`challenge   ${result.challenge.amountAtomic} atomic · ${result.challenge.network} · Bazaar ${result.challenge.bazaarMethod}`);
    if (result.dryRun) return console.log('dry run     no payment signed');
    console.log(`settlement  ${result.payment?.transaction || 'missing receipt'}`);
    console.log(`fact        ${result.fact.outcome} · ${result.fact.eventId}`);
    console.log(`recipe      ${result.fact.recipeHash}`);
    console.log(`catalog     ${result.discovery?.state || 'unknown'}`);
}

main().catch(error => {
    console.error(`oracle fact demo failed: ${error.message}`);
    process.exit(1);
});
