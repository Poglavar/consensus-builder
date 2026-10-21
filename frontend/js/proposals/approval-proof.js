// Signed lens evidence and owner decisions for abstract approval: the canonical statements, the exact
// text each key signs and their Ed25519 verification. A decision is taken on an agreement and signs its
// CID (ProposalApproval.decisionContent). Shared by the browser, the lens member and Node tests, so all
// three accept exactly the same signatures.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ProposalApprovalProof = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';
    const RIGHTS_SCHEMA = 'lens-rights-attestation/v1';
    const AUTHORITY_SCHEMA = 'lens-authority-attestation/v1';
    const DECISION_SCHEME = 'ed25519-wallet/v1';
    // Wallet and member clocks differ; a decision may be stamped this much before its evidence.
    const CLOCK_SKEW_MS = 5 * 60 * 1000;
    // A verifier rebuilds exactly these fields from stored evidence; anything else is not signed.
    const FIELDS = Object.freeze({
        [RIGHTS_SCHEMA]: ['schema', 'member', 'contextHash', 'parcelIds', 'evidenceRef', 'issuedAt', 'expiresAt'],
        [AUTHORITY_SCHEMA]: ['schema', 'member', 'contextHash', 'ownerId', 'actorId', 'evidenceRef', 'issuedAt', 'expiresAt']
    });
    const ed25519 = () => root.__consentEd25519
        || (typeof require === 'function' ? require('../../vendor/noble-curves-1.2.0/ed25519.js') : null);
    const lensCore = () => root.LensCore || (typeof require === 'function' ? require('../lens-core.js') : null);
    const approval = () => root.ProposalApproval || (typeof require === 'function' ? require('./approval.js') : null);

    function fail(message) {
        const error = new Error(message);
        error.code = 'invalid-approval-proof';
        throw error;
    }
    const isKey = value => lensCore().isBase58Pubkey(value);
    function isInstant(value) {
        if (typeof value !== 'string') return false;
        const ms = Date.parse(value);
        return Number.isFinite(ms) && new Date(ms).toISOString() === value;
    }
    function reference(value, field) {
        if (typeof value !== 'string' || !value || value.length > 256) fail(`${field} must be a non-empty reference.`);
    }

    // The signed part of a lens fact, validated; the signature itself is not part of it.
    function statementOf(fact) {
        const fields = FIELDS[fact?.schema];
        if (!fields) fail('Unknown lens attestation schema.');
        const statement = {};
        fields.forEach(field => { statement[field] = fact[field]; });
        if (!isKey(statement.member)) fail('The attesting lens member must be a public key.');
        reference(statement.contextHash, 'contextHash');
        reference(statement.evidenceRef, 'evidenceRef');
        if (!isInstant(statement.issuedAt) || !isInstant(statement.expiresAt)
            || Date.parse(statement.expiresAt) <= Date.parse(statement.issuedAt)) {
            fail('Attestation times must be ISO instants, with expiry after issue.');
        }
        if (statement.schema === RIGHTS_SCHEMA) {
            const ids = statement.parcelIds;
            if (!Array.isArray(ids) || !ids.length || ids.some((id, index) => typeof id !== 'string' || !id
                || (index && !(ids[index - 1] < id)))) fail('A rights attestation names its parcels once each, in order.');
            statement.parcelIds = [...ids];
        } else {
            reference(statement.ownerId, 'ownerId');
            if (!isKey(statement.actorId)) fail('The authorized signer must be a wallet public key.');
        }
        return statement;
    }

    function attestationMessage(statement) {
        return ['Urban Game Theory lens attestation', approval().stableStringify(statement)].join('\n');
    }

    // The text a wallet signs for one decision on an agreement: a readable summary, then every signed
    // field. The agreement's CID commits to its designs, land, allocations, money and rule.
    function decisionMessage(statement) {
        const verb = statement.decision === 'withdraw' ? 'Withdraw the acceptance of' : 'Accept';
        return [
            'Urban Game Theory owner decision',
            `${verb} the agreement as owner ${statement.ownerId}.`,
            `Agreement: ${statement.agreementCid}`,
            `Approval context: ${statement.contextHash}`,
            `Signed at: ${statement.decidedAt}`,
            '',
            approval().stableStringify(statement)
        ].join('\n');
    }

    // The text a wallet signs to prove control before a lens member names the owners it may act for.
    function approvalChallengeMessage({ member, wallet, contextHash, challenge, expiresAt }) {
        return [
            `Urban Game Theory lens member ${member}`,
            `Wallet ${wallet} asks which owners it may act for in approval context ${contextHash}.`,
            `Challenge: ${challenge}`,
            `Expires: ${expiresAt}`
        ].join('\n');
    }

    // Tallies re-verify every receipt on each render; a verdict is a pure function of its inputs.
    const VERDICT_CACHE_LIMIT = 4096;
    const verdicts = new Map();

    // Never throws: anything malformed is simply not a valid signature.
    function verifySignature(publicKey, message, signature) {
        if (typeof publicKey !== 'string' || typeof message !== 'string' || typeof signature !== 'string') return false;
        const cacheKey = `${publicKey}\n${signature}\n${message}`;
        if (verdicts.has(cacheKey)) return verdicts.get(cacheKey);
        let valid = false;
        try {
            const signatureBytes = lensCore().base58Decode(signature);
            valid = isKey(publicKey) && !!signatureBytes && signatureBytes.length === 64
                && ed25519().verify(signatureBytes, new TextEncoder().encode(message), lensCore().base58Decode(publicKey)) === true;
        } catch (_) {
            valid = false;
        }
        if (verdicts.size >= VERDICT_CACHE_LIMIT) verdicts.delete(verdicts.keys().next().value);
        verdicts.set(cacheKey, valid);
        return valid;
    }

    function verifyAttestation(fact, schema) {
        try {
            if (!fact || fact.schema !== schema) return false;
            const statement = statementOf(fact);
            return verifySignature(statement.member, attestationMessage(statement), fact.signature);
        } catch (_) {
            return false;
        }
    }

    function validAt(fact, instant) {
        const at = Date.parse(instant);
        return Number.isFinite(at) && at >= Date.parse(fact.issuedAt) - CLOCK_SKEW_MS && at <= Date.parse(fact.expiresAt);
    }

    // A complete owner receipt: both lens facts verify and name this context, owner and signer; the
    // decision falls inside their validity; the signer's own signature covers the canonical statement,
    // and so the agreement's CID. Lens membership and the current context are checked by
    // ProposalApproval.evidenceAllows.
    function verifyReceipt({ receipt, statement, parcelIds = null }) {
        try {
            const { rights, authority } = receipt?.evidence || {};
            if (!verifyAttestation(rights, RIGHTS_SCHEMA) || !verifyAttestation(authority, AUTHORITY_SCHEMA)) return false;
            if (statement.ownerId !== receipt.ownerId || statement.actorId !== receipt.actorId
                || authority.ownerId !== receipt.ownerId || authority.actorId !== receipt.actorId
                || rights.contextHash !== statement.contextHash || authority.contextHash !== statement.contextHash) return false;
            if (parcelIds && approval().stableStringify(rights.parcelIds) !== approval().stableStringify(parcelIds)) return false;
            if (!validAt(rights, statement.decidedAt) || !validAt(authority, statement.decidedAt)) return false;
            const proof = receipt.decisionProof;
            return proof?.scheme === DECISION_SCHEME
                && verifySignature(receipt.actorId, decisionMessage(statement), proof.signature);
        } catch (_) {
            return false;
        }
    }

    return {
        RIGHTS_SCHEMA, AUTHORITY_SCHEMA, DECISION_SCHEME, CLOCK_SKEW_MS,
        statementOf, attestationMessage, decisionMessage, approvalChallengeMessage,
        verifySignature, verifyAttestation, validAt, verifyReceipt
    };
});
