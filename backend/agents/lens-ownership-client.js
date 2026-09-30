// Client side of a lens member's owner-consent flow (backend/lens/README.md §API): request a
// challenge, sign its exact UTF-8 text with the agent's Solana key (ed25519 over node:crypto, the
// same primitive the member verifies with), and POST /lens/ownership. A free answer (dry-run member,
// or an attestation already issued) returns straight away; a 402 is paid only through the injected
// `pay` step, which the caller gates (UGT_MCP_LIVE + confirm) because money moves there.

import { createHash, createPrivateKey, sign } from 'node:crypto';
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from '@x402/core/http';
import { Keypair } from '@solana/web3.js';

const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
export const LENS_OWNERSHIP_PATH = '/lens/ownership';

function cleanServiceUrl(serviceUrl) {
    let url;
    try { url = new URL(String(serviceUrl)); } catch { throw new Error(`serviceUrl "${serviceUrl}" is not a URL`); }
    if (!/^https?:$/.test(url.protocol)) throw new Error('serviceUrl must be http(s)');
    return url.toString().replace(/\/+$/, '');
}

/**
 * Sign a lens challenge message with a 64-byte Solana secret key; base64 (the member accepts base58
 * or base64). Returns the signer's base58 address too, which must be the `owner` of the request.
 */
export function signChallengeMessage({ secretKey, message }) {
    if (!(secretKey instanceof Uint8Array) || secretKey.length !== 64) throw new Error('secretKey must be a 64-byte Solana secret key');
    if (typeof message !== 'string' || !message) throw new Error('message is required');
    const privateKey = createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(secretKey.subarray(0, 32))]), format: 'der', type: 'pkcs8' });
    const signature = sign(null, Buffer.from(message, 'utf8'), privateKey).toString('base64');
    return { owner: Keypair.fromSecretKey(secretKey).publicKey.toBase58(), signature };
}

/** Stable x402 payment id per (member, parcel, owner): a retry never pays twice for one fact. */
export function paymentIdForOwnership({ serviceUrl, parcelUid, owner }) {
    return `ownership_${createHash('sha256').update([cleanServiceUrl(serviceUrl), parcelUid, owner].join('|')).digest('hex')}`;
}

async function readBody(response) {
    const text = await response.text();
    if (!text) return null;
    try { return JSON.parse(text); } catch { return text; }
}

function refusal(label, response, body) {
    const detail = body && typeof body === 'object' ? (body.message || body.error || JSON.stringify(body)) : String(body ?? '');
    return new Error(`${label} returned HTTP ${response.status}: ${detail}`);
}

/**
 * challenge → sign → POST /lens/ownership [→ pay → retry].
 *
 * @param {{ serviceUrl: string, parcelUid: string, secretKey: Uint8Array, fetchImpl?: Function,
 *   pay?: (ctx: { challenge: object, paymentId: string, url: string, init: object }) => Promise<Response> }} options
 *   Without `pay`, a priced member makes this throw with the price instead of paying.
 * @returns {Promise<{ address: string, accountHash: string, payload: object, reused: boolean, owner: string,
 *   parcelUid: string, serviceUrl: string, paid: boolean, receipt: object|null, record: object }>}
 */
export async function requestOwnershipAttestation({ serviceUrl, parcelUid, secretKey, fetchImpl = globalThis.fetch, pay } = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('a fetch implementation is required');
    const base = cleanServiceUrl(serviceUrl);
    const parcel = typeof parcelUid === 'string' ? parcelUid.trim() : '';
    if (!parcel) throw new Error('parcelUid is required');
    const owner = Keypair.fromSecretKey(secretKey).publicKey.toBase58();

    const challengeResponse = await fetchImpl(`${base}/lens/challenge`, {
        method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ parcelUid: parcel, owner })
    });
    const challengeBody = await readBody(challengeResponse);
    if (challengeResponse.status !== 201 || !challengeBody?.challenge || !challengeBody?.message) {
        throw refusal(`${base}/lens/challenge`, challengeResponse, challengeBody);
    }
    const { signature } = signChallengeMessage({ secretKey, message: challengeBody.message });
    const url = `${base}${LENS_OWNERSHIP_PATH}`;
    const init = {
        method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ parcelUid: parcel, owner, signature, challenge: challengeBody.challenge })
    };

    let response = await fetchImpl(url, init);
    let body = await readBody(response);
    let paid = false;
    if (response.status === 402) {
        const header = response.headers.get('payment-required');
        if (!header) throw new Error(`${url} answered 402 without a payment-required header`);
        const paymentChallenge = decodePaymentRequiredHeader(header);
        if (typeof pay !== 'function') {
            const price = (paymentChallenge.accepts || []).map(item => `${item.amount} atomic on ${item.network}`).join(' or ');
            throw new Error(`lens member charges for this ownership attestation (${price || 'price unstated'}); paying needs a live, confirmed call`);
        }
        response = await pay({ challenge: paymentChallenge, paymentId: paymentIdForOwnership({ serviceUrl: base, parcelUid: parcel, owner }), url, init });
        body = await readBody(response);
        paid = true;
    }
    if (![200, 201].includes(response.status) || !body?.address) throw refusal(url, response, body);
    const receiptHeader = response.headers.get('payment-response');
    return {
        address: body.address,
        accountHash: body.accountHash ?? null,
        payload: body.payload ?? null,
        reused: Boolean(body.reused),
        owner,
        parcelUid: parcel,
        serviceUrl: base,
        paid,
        receipt: receiptHeader ? decodePaymentResponseHeader(receiptHeader) : null,
        record: body
    };
}

// ---- other lens member routes an agent calls (backend/lens/README.md §API) ----------------------

async function getJson(fetchImpl, url, init) {
    let response;
    try {
        response = await fetchImpl(url, init);
    } catch (error) {
        throw new Error(`${url} unreachable: ${error.cause?.code || error.cause?.message || error.message}`);
    }
    const body = await readBody(response);
    return { response, body };
}

/** GET /lens/status → { key, kind, credential, credentialName, schemas, dryRun, ... }. */
export async function fetchLensStatus({ serviceUrl, fetchImpl = globalThis.fetch } = {}) {
    const url = `${cleanServiceUrl(serviceUrl)}/lens/status`;
    const { response, body } = await getJson(fetchImpl, url, { headers: { accept: 'application/json' } });
    if (!response.ok || !body?.key) throw refusal(url, response, body);
    return body;
}

/** GET /lens/attestations?parcelUid=&owner=&proposalAccount=&kind= → the member's issued records. */
export async function listMemberAttestations({ serviceUrl, parcelUid, owner, proposalAccount, kind, fetchImpl = globalThis.fetch } = {}) {
    const url = new URL(`${cleanServiceUrl(serviceUrl)}/lens/attestations`);
    for (const [name, value] of Object.entries({ parcelUid, owner, proposalAccount, kind })) {
        if (value) url.searchParams.set(name, String(value));
    }
    const { response, body } = await getJson(fetchImpl, url.toString(), { headers: { accept: 'application/json' } });
    if (!response.ok || !Array.isArray(body?.attestations)) throw refusal(url.toString(), response, body);
    return body.attestations;
}

/**
 * The ownership attestation `member` issued for (parcelUid, owner), looked up on the member's own
 * service. Several (a re-attestation after the owner set changed) → the latest by issuedAt, then
 * address. None → an error that says to request one first.
 */
export async function findOwnershipAttestation({ serviceUrl, parcelUid, owner, member, fetchImpl } = {}) {
    const records = (await listMemberAttestations({ serviceUrl, parcelUid, owner, kind: 'ownership', fetchImpl }))
        .filter(record => record?.address && record.parcelUid === parcelUid && record.owner === owner && (!member || record.authority === member));
    if (!records.length) {
        throw new Error(`lens member ${member || serviceUrl} has no ownership attestation for parcel ${parcelUid} and owner ${owner}; request one first (ugt_request_ownership)`);
    }
    records.sort((a, b) => String(b.issuedAt ?? '').localeCompare(String(a.issuedAt ?? '')) || String(a.address).localeCompare(String(b.address)));
    return records[0];
}

/**
 * Operator-only POST /lens/verdict: the member attests ProposalVerdict-v1. The member's nonce is
 * deterministic per (proposal, verdict, sourceObservedAt), so a retry returns the stored record.
 */
export async function requestVerdictAttestation({
    serviceUrl, operatorToken, proposalAccount, verdict, evidenceRef = '', sourceObservedAt, fetchImpl = globalThis.fetch
} = {}) {
    if (!operatorToken) throw new Error('a lens operator token is required for POST /lens/verdict');
    if (!Number.isSafeInteger(sourceObservedAt) || sourceObservedAt <= 0) throw new Error('sourceObservedAt must be a positive Unix timestamp');
    const url = `${cleanServiceUrl(serviceUrl)}/lens/verdict`;
    const { response, body } = await getJson(fetchImpl, url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', 'x-lens-operator-token': operatorToken },
        body: JSON.stringify({ proposalAccount, verdict, evidenceRef, sourceObservedAt })
    });
    if (![200, 201].includes(response.status) || !body?.address) throw refusal(url, response, body);
    return body;
}
