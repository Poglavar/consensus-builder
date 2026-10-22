// Receipt relay for abstract owner decisions on an agreement. The server stores signed decisions so
// another browser can count them; it re-verifies each before storing, and every browser verifies
// again on reading, so neither side has to trust the other. The rules (admit one submitted decision,
// fold signed decisions into each owner's current one) are pure and shared by both; the fetch calls
// are thin. Every function takes the agreement-like object of ProposalApproval's decision functions
// ({ agreementCid, cadastreParcelIds, approvalConfig, lens, ownerApprovals?, ownerApprovalHistory?,
// lifecycleStatus? }); each decision signs the agreement's CID, which commits to its terms.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ProposalApprovalRelay = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';
    const LENS_PROVIDER = 'lens-wallet';
    // A receipt is two lens facts, one wallet signature and a few ids; anything larger is not one.
    const MAX_RECEIPT_BYTES = 32 * 1024;
    const DECISIONS = ['approve', 'withdraw'];
    const approval = () => root.ProposalApproval || (typeof require === 'function' ? require('./approval.js') : null);
    const proof = () => root.ProposalApprovalProof || (typeof require === 'function' ? require('./approval-proof.js') : null);

    const signatureOf = receipt => (typeof receipt?.decisionProof?.signature === 'string' && receipt.decisionProof.signature) || null;
    function isInstant(value) {
        if (typeof value !== 'string') return false;
        const ms = Date.parse(value);
        return Number.isFinite(ms) && new Date(ms).toISOString() === value;
    }
    // Signing time, then signature: every reader orders the same decisions the same way.
    function order(a, b) {
        const byTime = Date.parse(a.decidedAt) - Date.parse(b.decidedAt);
        if (byTime) return byTime;
        const sa = signatureOf(a), sb = signatureOf(b);
        return sa < sb ? -1 : sa > sb ? 1 : 0;
    }

    // A lens-wallet receipt checked from its signatures alone against this agreement: the evidence
    // names this context, owner and signer and members of the lens, and all three signatures verify,
    // the signer's over a statement naming this agreement's CID.
    function verifyLensReceipt(agreement, receipt) {
        try {
            const A = approval();
            return receipt?.providerId === LENS_PROVIDER
                && A.evidenceAllows(agreement, receipt.ownerId, receipt.actorId, receipt.evidence)
                && proof().verifyReceipt({ receipt, statement: A.decisionContent(agreement, receipt),
                    parcelIds: A.contextContent(agreement).cadastreParcelIds }) === true;
        } catch (_) {
            return false;
        }
    }

    // Signed decisions, in any order and with duplicates, become each owner's current acceptance and
    // the history. They apply in signing order under the same rules as a local decision: a withdrawal
    // needs a current acceptance by the same signer, and accepting an agreement already accepted
    // changes nothing. Decisions that do not verify, or do not apply, are left out.
    function fold(agreement, decisions, verify = verifyLensReceipt) {
        const seen = new Set();
        const valid = [];
        for (const receipt of decisions || []) {
            const signature = signatureOf(receipt);
            if (!signature || seen.has(signature) || !DECISIONS.includes(receipt.decision) || !isInstant(receipt.decidedAt)) continue;
            if (verify(agreement, receipt) !== true) continue;
            seen.add(signature);
            valid.push(JSON.parse(JSON.stringify(receipt)));
        }
        valid.sort(order);
        const current = new Map();
        const last = new Map();
        const history = [];
        const applied = [];
        for (const receipt of valid) {
            const previous = current.get(receipt.ownerId);
            if (receipt.decision === 'withdraw') {
                if (!previous || previous.actorId !== receipt.actorId) continue;
                current.delete(receipt.ownerId);
                history.push(previous, receipt);
            } else {
                if (previous) continue;
                current.set(receipt.ownerId, receipt);
            }
            last.set(receipt.ownerId, receipt);
            applied.push(receipt);
        }
        return { ownerApprovals: Object.fromEntries(current), ownerApprovalHistory: history, last, applied };
    }

    function refusal(status, code, message) {
        return { ok: false, status, code, message };
    }

    // Whether the relay may store one submitted decision, given the decisions it already holds for
    // this agreement. Returns { ok: true } (or { ok: true, duplicate: true }) or a refusal with an
    // HTTP status. Every decision signs the agreement's CID, which commits to its terms, so a stored
    // decision never goes stale; a changed agreement is another CID with decisions of its own.
    // M2: the server (/agreements/:cid/decisions) passes the indexed agreement as
    // { agreementCid, cadastreParcelIds: its input parcel ids, approvalConfig, lens, lifecycleStatus },
    // with lifecycleStatus 'Expired' once its deadline has passed.
    function admit(agreement, stored, receipt, { verify = verifyLensReceipt, now = Date.now() } = {}) {
        if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return refusal(400, 'bad_request', 'A receipt object is required.');
        if (new TextEncoder().encode(JSON.stringify(receipt)).length > MAX_RECEIPT_BYTES) return refusal(413, 'too_large', 'The receipt is too large.');
        if (!DECISIONS.includes(receipt.decision) || !isInstant(receipt.decidedAt) || !signatureOf(receipt)
            || typeof receipt.ownerId !== 'string' || typeof receipt.actorId !== 'string') {
            return refusal(400, 'bad_request', 'The receipt needs an owner, a signer, a decision, a signing time and a signature.');
        }
        if (receipt.providerId !== LENS_PROVIDER) {
            return refusal(422, 'unsupported_provider', 'The relay carries only lens-attested wallet decisions, which anyone can verify.');
        }
        const A = approval();
        let state;
        try { state = A.inspect(agreement); } catch (_) { state = { ready: false }; }
        if (!state.ready) return refusal(409, 'ownership_unresolved', 'This agreement has no complete ownership snapshot.');
        // A party: an owner or leaseholder of the snapshot, or an authority the rules require.
        if (!state.partyIds.includes(receipt.ownerId)) return refusal(404, 'unknown_owner', 'That owner is not in this agreement\'s ownership snapshot.');
        const status = agreement.lifecycleStatus;
        if (['Cancelled', 'Expired'].includes(status) || (status === 'Executed' && receipt.decision === 'approve')) {
            return refusal(409, 'agreement_closed', 'This agreement no longer takes decisions.');
        }
        if (!A.evidenceAllows(agreement, receipt.ownerId, receipt.actorId, receipt.evidence)) {
            return refusal(403, 'not_authorized', 'The receipt\'s lens evidence does not name this agreement, owner and signer.');
        }
        if (verify(agreement, receipt) !== true) return refusal(401, 'bad_signature', 'A signature in the receipt does not verify.');
        if (Date.parse(receipt.decidedAt) > now + proof().CLOCK_SKEW_MS) return refusal(422, 'future_decision', 'The decision is signed in the future.');
        if ((stored || []).some(row => signatureOf(row) === signatureOf(receipt))) return { ok: true, duplicate: true };
        const folded = fold(agreement, stored, verify);
        const last = folded.last.get(receipt.ownerId);
        if (last && order(last, receipt) >= 0) return refusal(409, 'stale_decision', 'A later decision for this owner is already recorded.');
        const current = folded.ownerApprovals[receipt.ownerId];
        if (receipt.decision === 'withdraw') {
            if (!current) return refusal(409, 'nothing_to_withdraw', 'This owner has no acceptance to withdraw.');
            if (current.actorId !== receipt.actorId) return refusal(403, 'not_your_acceptance', 'Only the signer who accepted may withdraw.');
        } else if (current) {
            return refusal(409, 'already_accepted', 'This owner has already accepted this agreement.');
        }
        return { ok: true };
    }

    // Folds relayed decisions into a local agreement-like object; returns whether its current
    // acceptances changed.
    function merge(agreement, decisions, verify) {
        const local = [...Object.values(agreement.ownerApprovals || {}), ...(agreement.ownerApprovalHistory || [])];
        const folded = fold(agreement, [...local, ...(decisions || [])], verify);
        const key = approvals => Object.keys(approvals).sort().map(id => `${id}:${signatureOf(approvals[id])}`).join('|');
        const changed = key(folded.ownerApprovals) !== key(agreement.ownerApprovals || {})
            || folded.ownerApprovalHistory.length !== (agreement.ownerApprovalHistory || []).length;
        agreement.ownerApprovals = folded.ownerApprovals;
        agreement.ownerApprovalHistory = folded.ownerApprovalHistory;
        return { changed, applied: folded.applied };
    }

    // ---- browser transport --------------------------------------------------------------------

    // The agreement's decisions at the index (plan-design-agreement.md, M2): POST { receipt },
    // GET → { decisions }. Null while the agreement has no CID.
    // M2: the browser flow (the agreement panel) passes push, pull, sync and merge the agreement-like
    // object it decides on ({ ...AgreementRecord.approvalSubject(agreement), agreementCid,
    // ownerApprovals, ownerApprovalHistory }) and keeps the receipts merge writes back on it.
    function endpoint(agreement, base) {
        let subject;
        try { subject = approval().subjectOf(agreement); } catch (error) {
            if (error.code !== 'invalid-proposal-approval') throw error;
            return null;
        }
        return `${String(base || '').replace(/\/$/, '')}/agreements/${encodeURIComponent(subject)}/decisions`;
    }
    const backendBase = () => (typeof root.getBackendBase === 'function' ? root.getBackendBase() : '');

    // Sends one signed decision; the answer says whether other browsers can now see it.
    async function push(agreement, receipt, { base = backendBase(), fetchImpl = root.fetch?.bind(root) } = {}) {
        const url = endpoint(agreement, base);
        if (!url) return { shared: false, code: 'not_published' };
        try {
            const response = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ receipt }) });
            const body = await response.json().catch(() => ({}));
            return response.ok ? { shared: true, duplicate: body.duplicate === true } : { shared: false, status: response.status, code: body.code || 'relay_error' };
        } catch (_) {
            return { shared: false, code: 'offline' };
        }
    }

    // Every decision the relay holds for this agreement, or null when it has no CID or is unreachable.
    async function pull(agreement, { base = backendBase(), fetchImpl = root.fetch?.bind(root) } = {}) {
        const url = endpoint(agreement, base);
        if (!url) return null;
        try {
            const response = await fetchImpl(url, { cache: 'no-store' });
            if (!response.ok) return null;
            const body = await response.json();
            return Array.isArray(body?.decisions) ? body.decisions : null;
        } catch (_) {
            return null;
        }
    }

    // Two-way sync: read the relay, fold it in, then send what only this browser holds, oldest first.
    async function sync(agreement, { verify, ...transport } = {}) {
        const relayed = await pull(agreement, transport);
        if (!relayed) return { synced: false, changed: false };
        const { changed, applied } = merge(agreement, relayed, verify);
        const known = new Set(relayed.map(signatureOf));
        let sent = 0;
        for (const receipt of applied.filter(row => !known.has(signatureOf(row)))) {
            if ((await push(agreement, receipt, transport)).shared) sent += 1;
        }
        return { synced: true, changed, sent };
    }

    return { LENS_PROVIDER, MAX_RECEIPT_BYTES, signatureOf, verifyLensReceipt, fold, admit, merge, push, pull, sync };
});
