// An agreement-bound question is published as canonical JSON. Its raw IPFS digest is also the
// recipe hash in the market and in the verifier's MarketEvidence-v1 attestation.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.ExternalMarketRecipe = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';
    const cid = () => root.Cid || require('../cid.js');
    const question = () => root.MarketQuestion || require('./market-question.js');
    const sha = () => root.Sha256 || require('./sha256.js');
    const hex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    const MAX_BYTES = 32 * 1024;

    function build({ proposal, trustedAttester, external }) {
        const { tuple, credential, schema } = external || {};
        if (!['adopted', 'permitted', 'built'].includes(tuple?.milestone)) throw new Error('Choose a supported public-record milestone.');
        for (const address of [proposal, trustedAttester, credential, schema]) {
            if (typeof address !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) throw new Error('A Solana account is required for each external evidence binding.');
        }
        if (tuple.subject?.agreementAccount && tuple.subject.agreementAccount !== proposal) throw new Error('The question names a different agreement.');
        const result = question().build(tuple);
        const body = {
            ...result.recipeBody,
            subject: { ...result.recipeBody.subject, agreementAccount: proposal },
            trustedAttesters: [{ kind: 'lens-member', address: trustedAttester }],
            verification: { ...result.recipeBody.verification, credential, schema,
                evidencePolicy: { threshold: 1, challengeWindowSeconds: 48 * 3600 } }
        };
        const bytes = cid().canonicalBytes(body);
        if (bytes.length > MAX_BYTES) throw new Error('A market recipe can contain up to 32 KiB of canonical JSON.');
        const contentId = cid().cidOf(bytes);
        return { body, cid: contentId, closesAt: result.closesAt, commitments: {
            recipeHash: cid().parse(contentId).digest, subjectHash: sha().digest(result.subjectText),
            yesValueHash: sha().digest(result.yesText), noValueHash: sha().digest(result.noText),
            trustedAttester, credential, schema
        } };
    }

    function verify(body, market) {
        const id = cid().cidOfObject(body);
        if (id !== cid().rawCidOfDigest(market.recipeHash)
            || body.subject?.agreementAccount !== market.proposal
            || body.trustedAttesters?.length !== 1 || body.trustedAttesters[0].address !== market.trustedAttester
            || body.verification?.schema !== market.schema || body.verification.credential !== market.credential
            || body.verification.closesAt !== Number(market.closesAt)
            || sha().hex(question().subjectTextOf(body)) !== hex(market.subjectHash)
            || sha().hex(body.outcomes?.yes) !== hex(market.yesValueHash)
            || sha().hex(body.outcomes?.no) !== hex(market.noValueHash)) {
            throw new Error('Published question does not match the market commitments.');
        }
        return { ...body, hash: 'sha256:' + hex(market.recipeHash) };
    }
    return { build, verify, MAX_BYTES };
});
