// Deterministic, testable orchestration for the hackathon x402 demo. The CLI wrapper lives in
// scripts/x402-demo.mjs; keeping the flow here lets tests exercise discovery, paid submission,
// idempotent replay and read-back without a wallet, facilitator or network.

import { createHash } from 'node:crypto';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { withBazaar } from '@x402/extensions/bazaar';
import {
    createPaidClient,
    fetchChallenge,
    paymentIdForProposal,
    postAgentProposal
} from './x402-client.js';

const SOLANA_DEVNET = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1';

function clean(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeBaseUrl(value) {
    const url = new URL(value);
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
}

function responseIdentity(result) {
    return {
        id: result?.body?.id,
        proposalId: result?.body?.proposalId,
        createdAt: result?.body?.createdAt,
        screenshotUrl: result?.body?.screenshotUrl ?? null
    };
}

/** Build the same proposal body every time the same demo arguments are supplied. */
export function buildDemoProposal({
    city = 'zagreb',
    parcels,
    proposalId,
    name,
    description,
    offer,
    currency,
    persona,
    rationale,
    runId
} = {}) {
    const parcelIds = Array.isArray(parcels)
        ? parcels.map(clean).filter(Boolean)
        : String(parcels ?? '').split(',').map(clean).filter(Boolean);
    if (!parcelIds.length) throw new Error('at least one parcel id is required');
    const normalizedCity = clean(city) || 'zagreb';
    const bodyWithoutId = {
        city: normalizedCity,
        cadastreParcelIds: parcelIds,
        type: 'parcel',
        name: clean(name) || `x402 demo proposal in ${normalizedCity}`,
        description: clean(description) || 'Deterministic pay-to-propose demonstration for autonomous agents.',
        offer: offer === undefined || offer === null || offer === '' ? null : Number(offer),
        offerCurrency: clean(currency),
        agent: {
            persona: clean(persona) || 'hackathon-demo-agent',
            rationale: clean(rationale) || 'Demonstrate discovery, payment, provenance and safe retry in one run.',
            run_id: clean(runId) || 'hackathon-x402-demo'
        }
    };
    if (bodyWithoutId.offer !== null && !Number.isFinite(bodyWithoutId.offer)) {
        throw new Error('offer must be a finite number');
    }
    const digest = createHash('sha256').update(JSON.stringify(bodyWithoutId)).digest('hex').slice(0, 20);
    return { proposalId: clean(proposalId) || `agent-demo-${digest}`, ...bodyWithoutId };
}

/** Read the service-owned machine manifest before using the paid endpoint. */
export async function fetchAgentManifest({ baseUrl, fetchImpl = globalThis.fetch } = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('no fetch implementation available');
    const manifestUrl = new URL('/docs/agents.json', normalizeBaseUrl(baseUrl)).toString();
    const response = await fetchImpl(manifestUrl, { headers: { accept: 'application/json' } });
    const text = await response.text();
    if (!response.ok) throw new Error(`agent manifest ${manifestUrl} returned ${response.status}: ${text}`);
    let manifest;
    try {
        manifest = JSON.parse(text);
    } catch {
        throw new Error(`agent manifest ${manifestUrl} did not return JSON`);
    }
    if (!manifest?.endpoints?.submit || !manifest?.endpoints?.read || !manifest?.x402) {
        throw new Error('agent manifest is missing x402 or endpoint metadata');
    }
    return { manifestUrl, manifest };
}

/** Prove that the 402 itself carries the Bazaar machine schema, not merely a docs claim. */
export function inspectBazaarDeclaration(required) {
    const extension = required?.extensions?.bazaar;
    const input = extension?.info?.input;
    if (!extension?.schema || input?.type !== 'http' || input?.method !== 'POST' || input?.bodyType !== 'json') {
        throw new Error('402 challenge is missing a valid Bazaar POST/JSON declaration');
    }
    const parcelSchema = extension.schema?.properties?.input?.properties?.body?.properties?.cadastreParcelIds;
    if (!parcelSchema || parcelSchema.type !== 'array') {
        throw new Error('Bazaar declaration does not describe cadastreParcelIds');
    }
    return {
        type: input.type,
        method: input.method,
        bodyType: input.bodyType,
        example: input.body,
        outputType: extension.info?.output?.type ?? null
    };
}

/** Query the facilitator-owned public Bazaar catalog for this exact endpoint. */
export async function findBazaarListing({ facilitatorUrl, submitUrl, payTo, network, bazaarClient } = {}) {
    if (!clean(facilitatorUrl)) return { state: 'unconfigured', listing: null };
    try {
        const client = bazaarClient ?? withBazaar(new HTTPFacilitatorClient({ url: facilitatorUrl }));
        const expected = normalizeBaseUrl(submitUrl);
        // CDP's public catalog currently ignores list filters (including payTo/network) and caps
        // list pages at 20. Searching for the exact public URL avoids treating an unrelated first
        // page as the whole Bazaar. Older facilitators may not expose search, so keep the list call
        // as a compatibility fallback.
        if (typeof client.extensions.bazaar.search === 'function') {
            const result = await client.extensions.bazaar.search({
                query: expected,
                type: 'http',
                payTo: clean(payTo) || undefined,
                network: clean(network) || undefined,
                extensions: 'bazaar',
                // CDP currently rejects search limits above 20.
                limit: 20
            });
            const listing = (result?.resources || []).find(item => {
                try { return normalizeBaseUrl(item.resource) === expected; } catch { return false; }
            }) ?? null;
            return {
                state: listing ? 'listed' : 'not-listed',
                listing,
                total: result?.resources?.length ?? null,
                partialResults: Boolean(result?.partialResults)
            };
        }
        const page = await client.extensions.bazaar.listResources({
            type: 'http',
            payTo: clean(payTo) || undefined,
            network: clean(network) || undefined,
            extensions: 'bazaar',
            limit: 100,
            offset: 0
        });
        const listing = (page?.items || []).find(item => {
            try { return normalizeBaseUrl(item.resource) === expected; } catch { return false; }
        }) ?? null;
        return { state: listing ? 'listed' : 'not-listed', listing, total: page?.pagination?.total ?? null };
    } catch (error) {
        return { state: 'unavailable', listing: null, error: error instanceof Error ? error.message : String(error) };
    }
}

export function solanaExplorerUrl(transaction, network) {
    const tx = clean(transaction);
    if (!tx) return null;
    let cluster = '';
    if (new RegExp(`devnet|${SOLANA_DEVNET}`, 'i').test(clean(network) || '')) cluster = 'devnet';
    else if (/testnet/i.test(clean(network) || '')) cluster = 'testnet';
    return `https://explorer.solana.com/tx/${encodeURIComponent(tx)}${cluster ? `?cluster=${cluster}` : ''}`;
}

export function proposalRecordUrl(readTemplate, proposalId) {
    if (!clean(readTemplate)) return null;
    return readTemplate.replace('{id}', encodeURIComponent(proposalId));
}

export function proposalAppUrl(appUrl, proposalId) {
    if (!clean(appUrl)) return null;
    return new URL(`/proposals/${encodeURIComponent(proposalId)}`, normalizeBaseUrl(appUrl)).toString();
}

export function assertIdempotentReplay(first, replay) {
    if (first?.status !== 201 || replay?.status !== 201) {
        throw new Error(`expected 201 then 201, got ${first?.status ?? 'none'} then ${replay?.status ?? 'none'}`);
    }
    if (JSON.stringify(responseIdentity(first)) !== JSON.stringify(responseIdentity(replay))) {
        throw new Error('retry did not return the original proposal response');
    }
    const firstTx = clean(first?.receipt?.transaction);
    const replayTx = clean(replay?.receipt?.transaction);
    if (!firstTx || firstTx !== replayTx) {
        throw new Error('retry did not return the original settlement transaction');
    }
    return { proposal: responseIdentity(first), transaction: firstTx };
}

async function fetchStoredProposal({ readTemplate, proposalId, fetchImpl }) {
    const url = proposalRecordUrl(readTemplate, proposalId);
    const response = await fetchImpl(url, { headers: { accept: 'application/json' } });
    const text = await response.text();
    if (!response.ok) throw new Error(`proposal read-back ${url} returned ${response.status}: ${text}`);
    try {
        return { url, proposal: JSON.parse(text) };
    } catch {
        throw new Error(`proposal read-back ${url} did not return JSON`);
    }
}

/** Execute the discover → challenge → pay → replay → read-back demo. */
export async function runX402Demo({
    baseUrl,
    body,
    secretKey,
    dryRun = false,
    rpcUrl,
    appUrl,
    fetchImpl = globalThis.fetch,
    deps = {}
} = {}) {
    const getManifest = deps.fetchAgentManifest ?? fetchAgentManifest;
    const getChallenge = deps.fetchChallenge ?? fetchChallenge;
    const makePaidClient = deps.createPaidClient ?? createPaidClient;
    const postProposal = deps.postAgentProposal ?? postAgentProposal;
    const getListing = deps.findBazaarListing ?? findBazaarListing;

    const { manifestUrl, manifest } = await getManifest({ baseUrl, fetchImpl });
    if (!manifest.x402.enabled) throw new Error('the discovered endpoint reports that x402 is not configured');
    const submitUrl = manifest.endpoints.submit;
    // Use the endpoint named by discovery rather than silently falling back to the bootstrap host.
    // The current protocol client accepts a base and appends /agent/proposals, so reject a manifest
    // that points at some other path instead of paying an unexpected resource.
    const submit = new URL(submitUrl);
    if (submit.pathname.replace(/\/+$/, '') !== '/agent/proposals') {
        throw new Error(`discovered submit endpoint has an unexpected path: ${submit.pathname}`);
    }
    const discoveredBaseUrl = submit.origin;
    const required = await getChallenge({ baseUrl: discoveredBaseUrl, body, fetchImpl });
    const declaration = inspectBazaarDeclaration(required);
    const accept = required.accepts?.[0];
    if (!accept) throw new Error('402 challenge declares no accepted payment');
    const paymentId = paymentIdForProposal(body.proposalId);
    const catalogBefore = await getListing({
        facilitatorUrl: manifest.x402.facilitatorUrl,
        submitUrl,
        payTo: accept.payTo,
        network: accept.network
    });
    const discovered = { manifestUrl, manifest, required, declaration, catalogBefore };
    if (dryRun) return { dryRun: true, body, paymentId, discovered };
    if (!(secretKey instanceof Uint8Array)) throw new Error('secretKey is required for a live demo');

    const { payerAddress, paidFetch } = await makePaidClient({ secretKey, paymentId, rpcUrl, fetchImpl });
    const first = await postProposal({ baseUrl: discoveredBaseUrl, paidFetch, body });
    const replay = await postProposal({ baseUrl: discoveredBaseUrl, paidFetch, body });
    const replayProof = assertIdempotentReplay(first, replay);
    const stored = await fetchStoredProposal({
        readTemplate: manifest.endpoints.read,
        proposalId: body.proposalId,
        fetchImpl
    });
    if (stored.proposal?.proposalId !== body.proposalId) throw new Error('read-back returned another proposal');
    if (stored.proposal?.agent?.wallet !== payerAddress) throw new Error('stored proposal does not carry the paying wallet');
    if (stored.proposal?.agent?.paid?.tx !== replayProof.transaction) {
        throw new Error('stored proposal does not carry the settlement transaction');
    }
    const catalogAfter = await getListing({
        facilitatorUrl: manifest.x402.facilitatorUrl,
        submitUrl,
        payTo: accept.payTo,
        network: accept.network
    });
    return {
        dryRun: false,
        body,
        paymentId,
        payerAddress,
        discovered: { ...discovered, catalogAfter },
        first,
        replay,
        replayProof,
        stored,
        links: {
            manifest: manifestUrl,
            proposalApi: stored.url,
            // The public frontend's share route is keyed by the database row id; the stable
            // proposalId remains the API identity and is used by the read-back URL above.
            proposalApp: proposalAppUrl(appUrl, first.body?.id ?? body.proposalId),
            settlement: solanaExplorerUrl(replayProof.transaction, first.receipt?.network || accept.network)
        }
    };
}
