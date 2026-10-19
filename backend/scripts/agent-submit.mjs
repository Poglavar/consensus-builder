#!/usr/bin/env node
// Submit one proposal to the paid agent route (POST /agent/proposals) as an x402 client, paying the
// devnet-USDC fee from a Solana keypair. This is both the acceptance check for the pay-to-post gate
// and the worked example the agent quickstart (/docs/agents) points at: everything an outside agent
// needs is what this file does. `--dry-run` fetches the 402 challenge and pays nothing.
//
// The client itself lives in agents/x402-client.js, which the server-side runner shares.
//
// Usage:
//   node scripts/agent-submit.mjs --keypair ~/.config/solana/persona.json --url http://localhost:3999 \
//       --city zagreb --parcels HR-1234-5678,HR-1234-5679 [--name ...] [--description ...] \
//       [--offer 1.5 --currency USDC] [--persona densifier-01] [--rationale ...] [--run-id ...] \
//       [--rpc https://api.devnet.solana.com] [--dry-run]

import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
    agentProposalsUrl,
    createPaidClient,
    fetchChallenge,
    paymentIdForProposal,
    postAgentProposal
} from '../agents/x402-client.js';

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
        '  --proposal-id <id>    Stable proposal id; reuse it to retry without paying twice',
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

    const body = {
        proposalId: args['proposal-id'] ?? `agent-submit-${randomUUID()}`,
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
    const secretKey = new Uint8Array(JSON.parse(readFileSync(args.keypair, 'utf8')));
    const { payerAddress, paidFetch } = await createPaidClient({
        secretKey,
        paymentId: paymentIdForProposal(body.proposalId),
        rpcUrl: args.rpc
    });
    const target = agentProposalsUrl(args.url);
    log(`payer ${payerAddress} → ${target} (${body.proposalId})`);

    // The challenge first, so a dry run shows exactly what would be paid.
    const required = await fetchChallenge({ baseUrl: args.url, body });
    const accept = required.accepts[0];
    log(`challenge: ${accept.amount} atomic units of ${accept.asset} on ${accept.network} to ${accept.payTo} (flow ${accept.extra?.paymentFlow ?? 'authorization'})`);
    if (args.dryRun) {
        log('dry run: not paying, nothing written');
        return;
    }

    const { status, body: responseBody, receipt } = await postAgentProposal({ baseUrl: args.url, paidFetch, body });
    log(`response ${status}: ${typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody)}`);
    if (receipt) {
        log(`settlement: success=${receipt.success} tx=${receipt.transaction} payer=${receipt.payer} network=${receipt.network}` +
            (receipt.errorReason ? ` error=${receipt.errorReason}` : ''));
    }
    if (status !== 201) process.exit(1);
}

main().catch((err) => {
    console.error(`[${new Date().toISOString()}] FAILED:`, err);
    process.exit(1);
});
