// Read-only agreement/lens evidence walkthrough.  It deliberately keeps the chain outcome even
// when the historical SAS statement cannot be proved.
(function attach(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.LensAgreementEvidence = api;
})(typeof window !== 'undefined' ? window : globalThis, function factory() {
    'use strict';

    const text = value => typeof value === 'string' && value.trim() ? value.trim() : null;
    const bytesOf = value => value instanceof Uint8Array ? value : new Uint8Array(value || []);
    const equal = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

    async function hashHex(bytes, crypto) {
        if (crypto?.sha256Hex) return String(await crypto.sha256Hex(bytes));
        if (crypto?.subtle?.digest) {
            const digest = await crypto.subtle.digest('SHA-256', bytes);
            return Array.from(new Uint8Array(digest), x => x.toString(16).padStart(2, '0')).join('');
        }
        throw new Error('a SHA-256 implementation is required');
    }

    function credentialAuthority(info, web3, sasProgram) {
        const data = bytesOf(info?.data);
        if (!info?.owner || !new web3.PublicKey(info.owner).equals(new web3.PublicKey(sasProgram))) throw new Error('credential is not owned by SAS');
        if (data.length < 33 || data[0] !== 0) throw new Error('invalid SAS credential account');
        return new web3.PublicKey(data.slice(1, 33)).toBase58();
    }

    async function readChain({ record, connection, client, crypto = globalThis.crypto, web3 = globalThis.solanaWeb3 } = {}) {
        if (!record || !connection || !client) throw new Error('record, connection and client are required');
        const cid = text(record.cid), sponsor = text(record.content?.sponsor);
        if (!cid || !sponsor) throw new Error('published agreement CID and sponsor are required');
        if (!web3?.PublicKey) throw new Error('Solana web3 is required');
        const [derived] = client.getAgreementPda(cid, sponsor);
        if (record.onchain && record.onchain.cluster !== 'devnet') throw new Error(`unsupported Solana network: ${record.onchain.cluster || 'unknown'}`);
        if (record.onchain && record.onchain.programId !== client.constants.AGREEMENT_PROGRAM_ID) throw new Error('record onchain program does not match the AgreementClient program');
        if (record.onchain?.account && record.onchain.account !== derived.toBase58()) throw new Error('record onchain account does not match the derived agreement PDA');
        const account = await client.fetchAgreement(connection, { cid, authority: sponsor, address: derived });
        if (!account) return { account: null, statement: null };
        const result = { account, statement: null };
        // An agreement with no lens is satisfied by its contribution target alone and carries no statement.
        if (account.decisionCode === client.constants.DECISION_PENDING || !account.lenses.length || !account.decisionAttestation) return result;
        try {
            const info = await connection.getAccountInfo(new web3.PublicKey(account.decisionAttestation), 'confirmed');
            if (!info?.data) throw new Error('decision attestation account is absent');
            const raw = bytesOf(info.data);
            const hash = await hashHex(raw, crypto);
            const attestation = client.readDecisionAttestation(raw, account.decisionAttestation);
            if (!info.owner || !new web3.PublicKey(info.owner).equals(new web3.PublicKey(client.constants.SAS_PROGRAM_ID))) throw new Error('decision attestation is not owned by SAS');
            if (!equal(hash, account.decisionHash)) throw new Error('decision attestation bytes do not match decisionHash');
            if (!account.lenses.includes(attestation.signer)) throw new Error('attestation signer is not one of the agreement lens members');
            if (attestation.fields.agreementCid !== cid || attestation.fields.sponsor !== account.authority) throw new Error('attestation subject does not match agreement');
            if (attestation.fields.decision !== 'satisfied') throw new Error('attestation decision is not satisfied');
            const schema = client.getDecisionSchemaPda(attestation.credential)[0].toBase58();
            if (attestation.schema !== schema) throw new Error('attestation uses the wrong decision schema');
            const credentialInfo = await connection.getAccountInfo(new web3.PublicKey(attestation.credential), 'confirmed');
            if (credentialAuthority(credentialInfo, web3, client.constants.SAS_PROGRAM_ID) !== attestation.signer) throw new Error('credential authority is not the attestation signer');
            result.statement = { ...attestation, verified: true };
        } catch (error) {
            result.statementError = error.message;
        }
        return result;
    }

    return { readChain };
});
