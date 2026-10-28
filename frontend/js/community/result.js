// Signed community reports refer to an immutable agreement, independently of minting. The DID
// snapshot is committed by the signature; a browser separately checks the website's current wallet list.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.CommunityResult = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';
    const SCHEMA = 'community-result/v1';
    const MAX_STATEMENT = 280;
    const MAX_REPORT_BYTES = 96 * 1024;
    const CLOCK_SKEW_MS = 5 * 60 * 1000;
    const CLUSTERS = Object.freeze({
        'mainnet-beta': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
        devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
        testnet: '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z'
    });
    const did = () => root.CommunityDidWeb || require('./did-web.js');
    const cid = () => root.Cid || require('../cid.js');
    const core = () => root.LensCore || require('../lens-core.js');
    const proof = () => root.ProposalApprovalProof || require('../proposals/approval-proof.js');
    const FIELDS = ['schema', 'agreementCid', 'attester', 'signer', 'statement', 'url', 'postedAt', 'didDocumentSha256'];
    const failure = (code, message) => Object.assign(new Error(message), { code });

    function httpsUrl(value) {
        if (value == null || value === '') return null;
        if (typeof value !== 'string' || value.length > 2048) throw failure('invalid-url', 'Use an HTTPS page address.');
        let url;
        try { url = new URL(value); } catch (_) { throw failure('invalid-url', 'Use an HTTPS page address.'); }
        if (url.protocol !== 'https:' || url.username || url.password) throw failure('invalid-url', 'Use an HTTPS page address without credentials.');
        return url.href;
    }

    function statementOf(raw) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.schema !== SCHEMA) throw failure('invalid-community-report', 'Expected a community-result/v1 report.');
        const statement = Object.fromEntries(FIELDS.map(field => [field, raw[field]]));
        if (!cid().isCid(statement.agreementCid)) throw failure('invalid-community-report', 'The report must identify an agreement by its CID.');
        if (typeof statement.attester !== 'string' || did().normalizeDid(statement.attester) !== statement.attester) throw failure('invalid-community-report', 'The report must name a canonical website DID.');
        const account = did().parseCaip10(statement.signer);
        if (!account || account.namespace !== 'solana' || !Object.values(CLUSTERS).includes(account.reference) || !core().isBase58Pubkey(account.address)) {
            throw failure('invalid-community-report', 'The reporter must identify a Solana wallet and network.');
        }
        if (typeof statement.statement !== 'string' || !statement.statement.trim() || [...statement.statement].length > MAX_STATEMENT
            || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(statement.statement)) {
            throw failure('invalid-community-report', 'A report is a plain-text statement of at most 280 characters.');
        }
        if (statement.url !== null && httpsUrl(statement.url) !== statement.url) throw failure('invalid-community-report', 'The report link must be a canonical HTTPS address or null.');
        if (typeof statement.postedAt !== 'string' || !Number.isFinite(Date.parse(statement.postedAt)) || new Date(statement.postedAt).toISOString() !== statement.postedAt) {
            throw failure('invalid-community-report', 'The report must carry its signing time as an ISO instant.');
        }
        if (typeof statement.didDocumentSha256 !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(statement.didDocumentSha256)) throw failure('invalid-community-report', 'The report must commit to its website document.');
        return statement;
    }

    function reportMessage(raw) {
        const statement = statementOf(raw);
        return ['Urban Game Theory community result', `Agreement: ${statement.agreementCid}`,
            `Reported by: ${statement.attester}`, 'This statement reports a nonbinding agreement; it gives no owner consent.',
            '', new TextDecoder().decode(cid().canonicalBytes(statement))].join('\n');
    }

    function normalizeReport(raw) {
        const statement = statementOf(raw);
        const allowed = [...FIELDS, 'proof', 'didDocument'];
        if (Object.keys(raw).some(key => !allowed.includes(key))) throw failure('invalid-community-report', 'The report contains unsigned fields.');
        if (!raw.didDocument || typeof raw.didDocument !== 'object' || Array.isArray(raw.didDocument)) throw failure('invalid-community-report', 'The signed website document is missing.');
        if (!raw.proof || raw.proof.scheme !== 'ed25519-wallet/v1' || typeof raw.proof.signature !== 'string'
            || Object.keys(raw.proof).some(key => !['scheme', 'signature'].includes(key))) throw failure('invalid-community-report', 'The wallet signature is missing.');
        const report = { ...statement, didDocument: raw.didDocument, proof: { scheme: raw.proof.scheme, signature: raw.proof.signature } };
        if (cid().canonicalBytes(report).length > MAX_REPORT_BYTES) throw failure('invalid-community-report', 'The report exceeds its size limit.');
        return JSON.parse(new TextDecoder().decode(cid().canonicalBytes(report)));
    }

    // Admission proves the wallet signed these bytes and the supplied snapshot is self-consistent.
    // It cannot prove the website served that snapshot. Only a fresh client-side fetch can do that.
    async function verifyReport(raw, { agreementCid, organiser, now = Date.now() } = {}) {
        try {
            const report = normalizeReport(raw);
            if (report.agreementCid !== agreementCid || report.attester !== organiser) return { ok: false, code: 'wrong-consultation', error: 'This report belongs to a different agreement or organiser.' };
            if (Date.parse(report.postedAt) > now + CLOCK_SKEW_MS) return { ok: false, code: 'future-report', error: 'The report signing time is in the future.' };
            if (await did().documentHash(report.didDocument) !== report.didDocumentSha256) return { ok: false, code: 'document-hash-mismatch', error: 'The signed website document has changed.' };
            if (!did().authorizedWallet(report.didDocument, organiser, report.signer)) return { ok: false, code: 'wallet-not-listed', error: 'The signed website document does not list this reporting wallet.' };
            const account = did().parseCaip10(report.signer);
            if (!proof().verifySignature(account.address, reportMessage(report), report.proof.signature)) return { ok: false, code: 'invalid-signature', error: 'The report signature does not verify.' };
            return { ok: true };
        } catch (error) {
            return { ok: false, code: 'invalid-community-report', error: error.message };
        }
    }

    async function signReport({ agreementCid, organiser, statement, url = null, resolved, wallet, cluster, now = Date.now() }) {
        if (!wallet || typeof wallet.signMessage !== 'function' || !CLUSTERS[cluster]) throw failure('wallet-required', 'Connect a Solana wallet on a supported network.');
        const signer = `solana:${CLUSTERS[cluster]}:${wallet.address}`;
        const attester = did().normalizeDid(organiser);
        if (!resolved || resolved.did !== attester || !did().authorizedWallet(resolved.document, attester, signer)) throw failure('wallet-not-listed', 'The organiser website does not list this wallet for reporting.');
        const report = {
            schema: SCHEMA, agreementCid, attester, signer, statement: String(statement).trim(), url: httpsUrl(url),
            postedAt: new Date(now).toISOString(), didDocumentSha256: await did().documentHash(resolved.document), didDocument: resolved.document
        };
        const signature = await wallet.signMessage(reportMessage(report));
        const signed = normalizeReport({ ...report, proof: { scheme: 'ed25519-wallet/v1', signature } });
        const verified = await verifyReport(signed, { agreementCid, organiser: attester, now });
        if (!verified.ok) throw failure(verified.code, verified.error);
        return signed;
    }

    // Every row is checked afresh; the index cannot substitute a statement or carry a badge over
    // from an earlier website fetch. Timestamp ties have a deterministic CID order.
    async function inspectReports(rows, { agreementCid, organiser, resolved = null, now = Date.now() }) {
        const checked = await Promise.all((Array.isArray(rows) ? rows : []).map(async row => {
            if (!row || !cid().isCid(row.cid) || cid().cidOfObject(row.content) !== row.cid) throw failure('invalid-community-report', 'The report index returned content under a different CID.');
            const verified = await verifyReport(row.content, { agreementCid, organiser, now });
            if (!verified.ok) throw failure(verified.code, verified.error);
            return { ...row, websiteStatus: !resolved ? 'unavailable' : did().authorizedWallet(resolved.document, organiser, row.content.signer) ? 'listed' : 'unlisted' };
        }));
        return checked.sort((a, b) => b.content.postedAt.localeCompare(a.content.postedAt) || b.cid.localeCompare(a.cid));
    }

    return { SCHEMA, MAX_STATEMENT, MAX_REPORT_BYTES, CLOCK_SKEW_MS, CLUSTERS, httpsUrl, statementOf, reportMessage, normalizeReport, verifyReport, signReport, inspectReports };
});
