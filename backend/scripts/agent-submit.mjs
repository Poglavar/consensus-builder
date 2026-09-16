#!/usr/bin/env node
// Submit one proposal to the paid agent route (POST /agent/proposals) as an x402 client, paying the
// devnet-USDC fee from a Solana keypair. This is both the acceptance check for the pay-to-post gate
// and the worked example the agent quickstart (/docs/agents) points at: everything an outside agent
// needs is what this file does. `--dry-run` fetches the 402 challenge and pays nothing.
//
// Usage:
//   node scripts/agent-submit.mjs --keypair ~/.config/solana/persona.json --url http://localhost:3999 \
//       --city zagreb --parcels HR-1234-5678,HR-1234-5679 [--name ...] [--description ...] \
//       [--offer 1.5 --currency USDC] [--persona densifier-01] [--rationale ...] [--run-id ...] \
//       [--rpc https://api.devnet.solana.com] [--dry-run]

import { readFileSync } from 'node:fs';
import { createKeyPairSignerFromBytes } from '@solana/kit';
import { wrapFetchWithPaymentFromConfig, decodePaymentResponseHeader } from '@x402/fetch';
import { decodePaymentRequiredHeader } from '@x402/core/http';
import { ExactSvmScheme } from '@x402/svm';

const AGENT_PATH = '/agent/proposals';

function usage(exitCode) {
    const lines = [
        'Submit one proposal to POST /agent/proposals, paying the x402 fee in devnet USDC.',
        '',
        'Required:',
        '  --keypair <file>      Solana keypair JSON (64-byte array), the paying wallet',
        '  --url <base>          Backend base URL, e.g. http://localhost:3999',
        '  --city <id>           City id, e.g. zagreb',
        '  --parcels <a,b,...>   Cadastre parcel ids the proposal covers',
        'Optional:',
        '  --name, --description, --offer <number>, --currency <code>   proposal fields',
        '  --persona <name> --rationale <text> --run-id <id>             stored under agent.*',
        '  --rpc <url>           Solana RPC for the payment client (default: the network default)',
        '  --dry-run             Fetch and print the 402 challenge, pay nothing, write nothing',
        '  --help                This text'
    ];
    console.log(lines.join('\n'));
    process.exit(exitCode);
}

function parseArgs(argv) {
    const args = {};
    for (let i = 0; i < argv.length; i += 1) {
        const token = argv[i];
        if (!token.startsWith('--')) usage(2);
        const key = token.slice(2);
        if (key === 'help') usage(0);
        if (key === 'dry-run') { args.dryRun = true; continue; }
        const value = argv[i + 1];
        if (value === undefined || value.startsWith('--')) usage(2);
        args[key] = value;
        i += 1;
    }
    return args;
}

function log(message) {
    console.log(`[${new Date().toISOString()}] ${message}`);
}

async function main() {
    const argv = process.argv.slice(2);
    if (argv.length === 0) usage(0);
    const args = parseArgs(argv);
    for (const required of ['keypair', 'url', 'city', 'parcels']) {
        if (!args[required]) {
            console.error(`missing --${required}`);
            usage(2);
        }
    }

    const secret = new Uint8Array(JSON.parse(readFileSync(args.keypair, 'utf8')));
    const signer = await createKeyPairSignerFromBytes(secret);
    const target = new URL(AGENT_PATH, args.url).toString();
    log(`payer ${signer.address} → ${target}`);

    const body = {
        city: args.city,
        cadastreParcelIds: args.parcels.split(',').map(s => s.trim()).filter(Boolean),
        type: 'parcel',
        name: args.name ?? `Agent proposal ${new Date().toISOString()}`,
        description: args.description ?? null,
        offer: args.offer !== undefined ? Number(args.offer) : null,
        offerCurrency: args.currency ?? null,
        agent: {
            persona: args.persona ?? null,
            rationale: args.rationale ?? null,
            run_id: args['run-id'] ?? null
        }
    };

    // The challenge first, so a dry run shows exactly what would be paid.
    const challenge = await fetch(target, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
    });
    if (challenge.status !== 402) {
        console.error(`expected a 402 challenge, got ${challenge.status}: ${await challenge.text()}`);
        process.exit(1);
    }
    const required = decodePaymentRequiredHeader(challenge.headers.get('payment-required'));
    const accept = required.accepts[0];
    log(`challenge: ${accept.amount} atomic units of ${accept.asset} on ${accept.network} to ${accept.payTo} (flow ${accept.extra?.paymentFlow ?? 'authorization'})`);
    if (args.dryRun) {
        log('dry run: not paying, nothing written');
        return;
    }

    const fetchWithPayment = wrapFetchWithPaymentFromConfig(fetch, {
        schemes: [{
            network: accept.network,
            client: new ExactSvmScheme(signer, args.rpc ? { rpcUrl: args.rpc } : undefined)
        }]
    });
    const response = await fetchWithPayment(target, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
    });
    const text = await response.text();
    log(`response ${response.status}: ${text}`);
    const receiptHeader = response.headers.get('payment-response');
    if (receiptHeader) {
        const receipt = decodePaymentResponseHeader(receiptHeader);
        log(`settlement: success=${receipt.success} tx=${receipt.transaction} payer=${receipt.payer} network=${receipt.network}` +
            (receipt.errorReason ? ` error=${receipt.errorReason}` : ''));
    }
    if (response.status !== 201) process.exit(1);
}

main().catch((err) => {
    console.error(`[${new Date().toISOString()}] FAILED:`, err);
    process.exit(1);
});
