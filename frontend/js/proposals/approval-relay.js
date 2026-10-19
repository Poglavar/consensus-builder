// Receipt relay for abstract owner decisions. The server stores signed decisions so another browser
// can count them; it re-verifies each before storing, and every browser verifies again on reading,
// so neither side has to trust the other. The rules (admit one submitted decision, fold signed
// decisions into each owner's current one) are pure and shared by both; the fetch calls are thin.
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
        const byTime = Date.parse(a.acceptedAt) - Date.parse(b.acceptedAt);
        if (byTime) return byTime;
        const sa = signatureOf(a), sb = signatureOf(b);
        return sa < sb ? -1 : sa > sb ? 1 : 0;
    }

    // A lens-wallet receipt checked from its signatures alone against this proposal: the evidence
    // names this context, owner and signer and members of the lens, and all three signatures verify.
    function verifyLensReceipt(proposal, receipt) {
        try {
            const A = approval();
            return receipt?.providerId === LENS_PROVIDER
                && A.evidenceAllows(proposal, receipt.ownerId, receipt.actorId, receipt.evidence)
                && proof().verifyReceipt({ receipt, statement: A.decisionContent(proposal, receipt),
                    parcelIds: A.contextContent(proposal).cadastreParcelIds }) === true;
        } catch (_) {
            return false;
        }
    }

    // Signed decisions, in any order and with duplicates, become each owner's current acceptance and
    // the history. They apply in signing order under the same rules as a local decision: a withdrawal
    // needs a current acceptance by the same signer, and re-accepting the same terms changes nothing.
    // Decisions that do not verify, or do not apply, are left out.
    function fold(proposal, decisions, verify = verifyLensReceipt) {
        const seen = new Set();
        const valid = [];
        for (const receipt of decisions || []) {
            const signature = signatureOf(receipt);
            if (!signature || seen.has(signature) || !DECISIONS.includes(receipt.decision) || !isInstant(receipt.acceptedAt)) continue;
            if (verify(proposal, receipt) !== true) continue;
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
                if (previous?.effectHash === receipt.effectHash) continue;
                if (previous) history.push(previous);
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
    // this proposal. Returns { ok: true } (or { ok: true, duplicate: true }) or a refusal with an
    // HTTP status. The server cannot know the client's current terms hash; readers count a receipt
    // only when its effectHash equals the terms they compute, so a stale one is stored but inert.
    function admit(proposal, stored, receipt, { verify = verifyLensReceipt, now = Date.now() } = {}) {
        if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return refusal(400, 'bad_request', 'A receipt object is required.');
        if (new TextEncoder().encode(JSON.stringify(receipt)).length > MAX_RECEIPT_BYTES) return refusal(413, 'too_large', 'The receipt is too large.');
        if (!DECISIONS.includes(receipt.decision) || !isInstant(receipt.acceptedAt) || !signatureOf(receipt)
            || typeof receipt.ownerId !== 'string' || typeof receipt.actorId !== 'string') {
            return refusal(400, 'bad_request', 'The receipt needs an owner, a signer, a decision, a signing time and a signature.');
        }
        if (receipt.providerId !== LENS_PROVIDER) {
            return refusal(422, 'unsupported_provider', 'The relay carries only lens-attested wallet decisions, which anyone can verify.');
        }
        const A = approval();
        let state;
        try { state = A.inspect(proposal); } catch (_) { state = { ready: false }; }
        if (!state.ready) return refusal(409, 'ownership_unresolved', 'This proposal has no complete ownership snapshot.');
        // A party: an owner or leaseholder of the snapshot, or an authority the rules require.
        if (!state.partyIds.includes(receipt.ownerId)) return refusal(404, 'unknown_owner', 'That owner is not in this proposal\'s ownership snapshot.');
        const status = proposal.lifecycleStatus;
        if (['Cancelled', 'Expired'].includes(status) || (status === 'Executed' && receipt.decision === 'approve')) {
            return refusal(409, 'proposal_closed', 'This proposal no longer takes decisions.');
        }
        if (!A.evidenceAllows(proposal, receipt.ownerId, receipt.actorId, receipt.evidence)) {
            return refusal(403, 'not_authorized', 'The receipt\'s lens evidence does not name this proposal, owner and signer.');
        }
        if (verify(proposal, receipt) !== true) return refusal(401, 'bad_signature', 'A signature in the receipt does not verify.');
        if (Date.parse(receipt.acceptedAt) > now + proof().CLOCK_SKEW_MS) return refusal(422, 'future_decision', 'The decision is signed in the future.');
        if ((stored || []).some(row => signatureOf(row) === signatureOf(receipt))) return { ok: true, duplicate: true };
        const folded = fold(proposal, stored, verify);
        const last = folded.last.get(receipt.ownerId);
        if (last && order(last, receipt) >= 0) return refusal(409, 'stale_decision', 'A later decision for this owner is already recorded.');
        const current = folded.ownerApprovals[receipt.ownerId];
        if (receipt.decision === 'withdraw') {
            if (!current) return refusal(409, 'nothing_to_withdraw', 'This owner has no acceptance to withdraw.');
            if (current.actorId !== receipt.actorId) return refusal(403, 'not_your_acceptance', 'Only the signer who accepted may withdraw.');
        } else if (current?.effectHash === receipt.effectHash) {
            return refusal(409, 'already_accepted', 'This owner has already accepted these terms.');
        }
        return { ok: true };
    }

    // Folds relayed decisions into a local proposal; returns whether its current acceptances changed.
    function merge(proposal, decisions, verify) {
        const local = [...Object.values(proposal.ownerApprovals || {}), ...(proposal.ownerApprovalHistory || [])];
        const folded = fold(proposal, [...local, ...(decisions || [])], verify);
        const key = approvals => Object.keys(approvals).sort().map(id => `${id}:${signatureOf(approvals[id])}`).join('|');
        const changed = key(folded.ownerApprovals) !== key(proposal.ownerApprovals || {})
            || folded.ownerApprovalHistory.length !== (proposal.ownerApprovalHistory || []).length;
        proposal.ownerApprovals = folded.ownerApprovals;
        proposal.ownerApprovalHistory = folded.ownerApprovalHistory;
        return { changed, applied: folded.applied };
    }

    // ---- browser transport --------------------------------------------------------------------

    function endpoint(proposal, base) {
        const id = proposal?.serverProposalId || null;
        return id ? `${String(base || '').replace(/\/$/, '')}/proposals/${encodeURIComponent(id)}/owner-decisions` : null;
    }
    const backendBase = () => (typeof root.getBackendBase === 'function' ? root.getBackendBase() : '');

    // Sends one signed decision; the answer says whether other browsers can now see it.
    async function push(proposal, receipt, { base = backendBase(), fetchImpl = root.fetch?.bind(root) } = {}) {
        const url = endpoint(proposal, base);
        if (!url) return { shared: false, code: 'not_published' };
        try {
            const response = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ receipt }) });
            const body = await response.json().catch(() => ({}));
            return response.ok ? { shared: true, duplicate: body.duplicate === true } : { shared: false, status: response.status, code: body.code || 'relay_error' };
        } catch (_) {
            return { shared: false, code: 'offline' };
        }
    }

    // Every decision the relay holds for this proposal, or null when it is unpublished or unreachable.
    async function pull(proposal, { base = backendBase(), fetchImpl = root.fetch?.bind(root) } = {}) {
        const url = endpoint(proposal, base);
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
    async function sync(proposal, { verify, ...transport } = {}) {
        const relayed = await pull(proposal, transport);
        if (!relayed) return { synced: false, changed: false };
        const { changed, applied } = merge(proposal, relayed, verify);
        const known = new Set(relayed.map(signatureOf));
        let sent = 0;
        for (const receipt of applied.filter(row => !known.has(signatureOf(row)))) {
            if ((await push(proposal, receipt, transport)).shared) sent += 1;
        }
        return { synced: true, changed, sent };
    }

    return { LENS_PROVIDER, MAX_RECEIPT_BYTES, signatureOf, verifyLensReceipt, fold, admit, merge, push, pull, sync };
});
