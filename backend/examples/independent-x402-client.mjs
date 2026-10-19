#!/usr/bin/env node
// Clean-room consumer proof: this file intentionally imports no Urban Game Theory module. It learns
// the paid fact URL from the public Bazaar proof, reads the x402 challenge, pays with the generic
// protocol SDK, and verifies the purchased bundle against the free public event feed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createKeyPairSignerFromBytes } from '@solana/kit';
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from '@x402/core/http';
import { wrapFetchWithPayment, x402Client } from '@x402/fetch';
import { ExactSvmScheme } from '@x402/svm';

function args(argv) {
    const out = { api: 'https://api.urbangametheory.xyz', live: false, maxAtomic: 20_000n };
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (token === '--live') { out.live = true; continue; }
        if (token === '--api' || token === '--keypair' || token === '--subject' || token === '--max-atomic') {
            if (!argv[index + 1]) throw new Error(`${token} requires a value`);
            out[token.slice(2).replace('-', '')] = argv[++index];
            continue;
        }
        throw new Error(`unknown argument ${token}`);
    }
    out.api = String(out.api).replace(/\/+$/, '');
    out.maxAtomic = BigInt(out.maxatomic ?? out.maxAtomic);
    return out;
}

function expandHome(value) {
    return value?.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
}

async function json(response, label) {
    const text = await response.text();
    let body = text;
    try { body = text ? JSON.parse(text) : null; } catch { /* preserve proxy text */ }
    if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
    return body;
}

export async function discoverFactPurchase({ api, subject = null, fetchImpl = globalThis.fetch, maxAtomic = 20_000n } = {}) {
    const discoveryUrl = `${api}/agent/discovery?resource=oracle-facts`;
    const discovery = await json(await fetchImpl(discoveryUrl, { headers: { accept: 'application/json' } }), 'discovery');
    if (discovery.state !== 'listed' || !discovery.listing?.resource) throw new Error('oracle fact is not listed in the hosted Bazaar');
    const resource = new URL(discovery.listing.resource);
    if (subject) resource.searchParams.set('subject', subject);
    const challengeResponse = await fetchImpl(resource, { headers: { accept: 'application/json' } });
    if (challengeResponse.status !== 402) throw new Error(`expected x402 challenge, got HTTP ${challengeResponse.status}`);
    const encoded = challengeResponse.headers.get('payment-required');
    if (!encoded) throw new Error('x402 challenge omitted payment-required');
    const challenge = decodePaymentRequiredHeader(encoded);
    const accepted = challenge.accepts?.[0];
    if (!accepted) throw new Error('x402 challenge has no accepted payment');
    const amount = BigInt(accepted.amount);
    if (amount <= 0n || amount > BigInt(maxAtomic)) throw new Error(`advertised payment ${amount} exceeds clean-room cap ${maxAtomic}`);
    return { discoveryUrl, discovery, resource: resource.toString(), challenge, amount };
}

export function verifyPurchasedFact(bundle, events) {
    const checks = bundle?.verification?.checks || {};
    const fact = bundle?.fact;
    const publicEvent = (events?.events || []).find(event => event.id === fact?.id);
    const valid = Boolean(
        bundle?.verification?.status === 'verified'
        && Object.values(checks).length > 0
        && Object.values(checks).every(Boolean)
        && /^sha256:[a-f0-9]{64}$/.test(fact?.source?.hash || '')
        && publicEvent?.source?.hash === fact.source.hash
        && publicEvent?.source?.transaction === fact.source.transaction
        && bundle?.recipe?.subject?.proposalAccount === fact?.subject?.id
    );
    if (!valid) throw new Error('purchased fact did not match the free public event and declared recipe');
    return { verified: true, eventId: fact.id, subject: fact.subject.id, sourceHash: fact.source.hash };
}

export async function run(options) {
    const plan = await discoverFactPurchase(options);
    if (!options.live) return {
        mode: 'dry-run', state: 'ready', resource: plan.resource,
        listing: { state: plan.discovery.state, network: plan.discovery.network, totalMatches: plan.discovery.totalMatches },
        payment: { network: plan.challenge.accepts[0].network, amountAtomic: plan.amount.toString(), payTo: plan.challenge.accepts[0].payTo }
    };
    const file = expandHome(options.keypair || process.env.UGT_COLD_START_KEYPAIR);
    if (!file) throw new Error('--keypair or UGT_COLD_START_KEYPAIR is required in live mode');
    const secret = Uint8Array.from(JSON.parse(fs.readFileSync(file, 'utf8')));
    if (secret.length !== 64) throw new Error('keypair file must contain a 64-byte Solana secret key');
    const signer = await createKeyPairSignerFromBytes(secret);
    const client = new x402Client().register(
        'solana:*', new ExactSvmScheme(signer, process.env.SOLANA_RPC_URL ? { rpcUrl: process.env.SOLANA_RPC_URL } : undefined)
    );
    const paidFetch = wrapFetchWithPayment(globalThis.fetch, client);
    const paid = await paidFetch(plan.resource, { headers: { accept: 'application/json' } });
    const receiptHeader = paid.headers.get('payment-response');
    const bundle = await json(paid, 'paid fact');
    if (!receiptHeader) throw new Error('paid response omitted payment-response receipt');
    const receipt = decodePaymentResponseHeader(receiptHeader);
    const eventsUrl = new URL('/oracle/events', options.api);
    eventsUrl.searchParams.set('subject', bundle.fact.subject.id);
    eventsUrl.searchParams.set('limit', '25');
    const events = await json(await fetch(eventsUrl, { headers: { accept: 'application/json' } }), 'public event verification');
    return {
        mode: 'live', payer: signer.address, resource: plan.resource,
        payment: { amountAtomic: plan.amount.toString(), transaction: receipt.transaction, network: receipt.network },
        fact: verifyPurchasedFact(bundle, events)
    };
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run(args(process.argv.slice(2)))
        .then(result => console.log(JSON.stringify(result, null, 2)))
        .catch(error => { console.error(error?.stack || error); process.exitCode = 1; });
}

