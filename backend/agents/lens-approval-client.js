// An owner's decision on a binding owners' agreement, made with a node keypair exactly as the browser
// makes it with a wallet (plan-design-agreement.md M2 "Owner decisions", M3): the agreement's lens member
// attests its rights and that this wallet may act for its owner id (POST /lens/approval/challenge, sign the
// challenge, POST /lens/approval/authority), the wallet signs the agreement-decision/v1 statement over the
// agreement's CID (frontend/js/proposals/approval.js decisionContent, approval-proof.js decisionMessage),
// and the receipt is admitted here by the relay's own rules (approval-relay.js admit) before it is relayed
// to POST /agreements/:cid/decisions. Also the lens operator's request for the AgreementDecision-v1
// attestation (POST /lens/agreements/:cid/decision), which the agreement program records before it executes.
import { createRequire } from 'node:module';
import { signMessageBytes } from './lens-ownership-client.js';

const require = createRequire(import.meta.url);
const approval = require('../../frontend/js/proposals/approval.js');
const proof = require('../../frontend/js/proposals/approval-proof.js');
const relay = require('../../frontend/js/proposals/approval-relay.js');
const agreementRecord = require('../../frontend/js/agreement-record.js');
const LensCore = require('../../frontend/js/lens-core.js');

export const OPERATOR_TOKEN_HEADER = 'x-lens-operator-token';
const TIMEOUT_MS = 60_000;

function cleanServiceUrl(serviceUrl) {
    let url;
    try { url = new URL(String(serviceUrl)); } catch { throw new Error(`lens service URL "${serviceUrl}" is not a URL`); }
    if (!/^https?:$/.test(url.protocol)) throw new Error('the lens service URL must be http(s)');
    return url.toString().replace(/\/+$/, '');
}

async function postJson(fetchImpl, url, body, headers = {}) {
    const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: response.status, ok: response.ok, body: json, text };
}

// A lens member refuses with { error: <code>, message, ...details } (backend/lens/server.js).
function refusal(what, result) {
    const code = (typeof result.body?.error === 'string' && result.body.error) || `http-${result.status}`;
    const reason = result.body?.message || (result.text || '').replace(/\s+/g, ' ').slice(0, 300);
    return Object.assign(new Error(`${what} refused (${result.status} ${code}): ${reason}`), { status: result.status, code, body: result.body });
}

/** The approval engine's subject of a published agreement under its CID: { agreementCid, cadastreParcelIds, approvalConfig, lens }. */
export function decisionSubject(cid, content) {
    return { ...agreementRecord.approvalSubject(content), agreementCid: cid };
}

/** The current approval each owner id holds among relayed receipts (the relay's own fold). */
export function currentApprovals(cid, content, receipts) {
    return relay.fold(decisionSubject(cid, content), receipts || []).ownerApprovals;
}

/**
 * The keypair's approval of the agreement as its owner, signed and checked, not yet relayed:
 * challenge → signature → the lens's rights and authority facts → the signed statement → admit.
 * @param {{ serviceUrl: string, lensKey: string, cid: string, content: object, keypair: import('@solana/web3.js').Keypair,
 *   stored?: object[], now?: () => Date, fetchImpl?: Function }} options
 *   stored: the receipts the relay already holds (GET /agreements/:cid/decisions), judged against as the relay will
 * @returns {Promise<{ receipt: object, contextHash: string }>}
 */
export async function signOwnerApproval({ serviceUrl, lensKey, cid, content, keypair, stored = [], now = () => new Date(), fetchImpl = globalThis.fetch } = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('a fetch implementation is required');
    if (!keypair?.secretKey) throw new Error('keypair is required');
    const base = cleanServiceUrl(serviceUrl);
    const subject = decisionSubject(cid, content);
    if (!subject.lens.includes(lensKey)) throw new Error(`agreement ${cid} does not name lens ${lensKey}`);
    const context = { cadastreParcelIds: subject.cadastreParcelIds, approvalConfig: subject.approvalConfig, lens: subject.lens };
    const contextHash = approval.contextHash(subject);
    const wallet = keypair.publicKey.toBase58();
    const signText = message => LensCore.base58Encode(new Uint8Array(signMessageBytes({ secretKey: keypair.secretKey, message })));

    const challenge = await postJson(fetchImpl, `${base}/lens/approval/challenge`, { wallet, contextHash });
    if (challenge.status !== 201 || !challenge.body?.challenge || !challenge.body?.message) throw refusal(`${base}/lens/approval/challenge`, challenge);
    // Sign only the text the protocol says this member asks of this wallet in this context.
    const expected = proof.approvalChallengeMessage({
        member: lensKey, wallet, contextHash, challenge: challenge.body.challenge, expiresAt: challenge.body.expiresAt
    });
    if (challenge.body.message !== expected) throw new Error(`the lens member at ${base} asked to sign an unexpected challenge text; nothing signed`);
    const facts = await postJson(fetchImpl, `${base}/lens/approval/authority`, {
        ...context, wallet, challenge: challenge.body.challenge, signature: signText(challenge.body.message)
    });
    if (facts.status !== 201 || !facts.body?.rights || !Array.isArray(facts.body?.authority)) throw refusal(`${base}/lens/approval/authority`, facts);
    const authority = facts.body.authority.find(fact => fact?.ownerId === wallet && fact?.actorId === wallet);
    if (!authority) throw new Error(`the lens member names no owner this wallet may act for as itself (${wallet}) in agreement ${cid}`);

    const decided = { ownerId: wallet, actorId: wallet, decision: 'approve', decidedAt: now().toISOString() };
    const statement = approval.decisionContent(subject, decided);
    const receipt = {
        ...decided,
        evidence: { rights: facts.body.rights, authority },
        decisionProof: { scheme: proof.DECISION_SCHEME, signature: signText(proof.decisionMessage(statement)) },
        providerId: relay.LENS_PROVIDER
    };
    const verdict = relay.admit({ ...subject, lifecycleStatus: 'Active' }, stored, receipt, { now: Date.now() });
    if (!verdict.ok) throw Object.assign(new Error(`the approval of ${cid} would be refused by the relay: ${verdict.code} ${verdict.message}`), { code: verdict.code });
    return { receipt, contextHash };
}

/**
 * The owner's approval of the agreement at the index: nothing when the relay already holds a current one
 * for this wallet; else sign it (signOwnerApproval) and relay it (POST /agreements/:cid/decisions).
 * @param index the publication client (publication-client.js createIndexClient)
 * @returns {Promise<{ replayed: boolean, decidedAt: string, signature: string, ownerId: string }>}
 */
export async function ensureOwnerApproval({ index, serviceUrl, lensKey, cid, content, keypair, now, fetchImpl } = {}) {
    const wallet = keypair.publicKey.toBase58();
    const stored = await index.listDecisions(cid);
    const current = currentApprovals(cid, content, stored)[wallet];
    if (current) return { replayed: true, decidedAt: current.decidedAt, signature: relay.signatureOf(current), ownerId: wallet };
    const { receipt } = await signOwnerApproval({ serviceUrl, lensKey, cid, content, keypair, stored, now, fetchImpl });
    const relayed = await index.relayDecision(cid, receipt);
    return { replayed: relayed.duplicate === true, decidedAt: receipt.decidedAt, signature: receipt.decisionProof.signature, ownerId: wallet };
}

/**
 * As the lens member's operator: its AgreementDecision-v1 `satisfied` for an indexed agreement whose rule
 * the relayed decisions pass (201 issued, 200 already issued). The member decides from the index alone;
 * a refusal (rule not met, deadline passed, …) is thrown with its code and the member's tally.
 * @returns {Promise<{ address, credential, schema, authority, payload, expiry, transactionSignature, issuedAt, reused, tally, counted }>}
 */
export async function requestAgreementDecision({ serviceUrl, operatorToken, cid, fetchImpl = globalThis.fetch } = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('a fetch implementation is required');
    if (!operatorToken) throw new Error('the lens operator token is required to ask for an agreement decision');
    const base = cleanServiceUrl(serviceUrl);
    const url = `${base}/lens/agreements/${encodeURIComponent(cid)}/decision`;
    const result = await postJson(fetchImpl, url, {}, { [OPERATOR_TOKEN_HEADER]: String(operatorToken) });
    if (result.status !== 201 && result.status !== 200) throw refusal(url, result);
    const record = result.body || {};
    if (record.kind !== 'decision' || record.payload?.agreementCid !== cid || record.payload?.decision !== 'satisfied' || !record.address || !record.credential) {
        throw new Error(`${url} answered something other than a satisfied AgreementDecision of ${cid}`);
    }
    return record;
}
