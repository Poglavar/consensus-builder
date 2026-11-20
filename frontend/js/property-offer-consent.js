// Exact wallet messages for a property-offer decision request.  The lens recomputes all hashes;
// these messages merely prove each named wallet approved the candidate it submitted.
(function (root, factory) { const api = factory(); if (typeof module === 'object' && module.exports) module.exports = api; if (root) root.PropertyOfferConsent = api; })(typeof window !== 'undefined' ? window : globalThis, function () {
    const stable = value => JSON.stringify(value);
    const sellerConsentMessage = ({ cid, offer, termsHash, payoutsHash, buyer, seller }) => [
        'Urban Game Theory property-offer seller consent', `Offer CID: ${cid}`, `Offer account: ${offer}`,
        `Terms SHA-256: ${termsHash}`, `Payouts SHA-256: ${payoutsHash}`, `Buyer: ${buyer}`, `Seller: ${seller}`
    ].join('\n');
    const requestMessage = ({ cid, offer, termsHash, payoutsHash, buyer, seller, consents = [] }) => [
        'Urban Game Theory property-offer decision request', stable({ cid, offer, termsHash, payoutsHash, buyer, seller,
            consents: consents.map(row => ({ owner: row.owner, signature: row.signature })).sort((a, b) => a.owner.localeCompare(b.owner)) })
    ].join('\n');
    const sessionMessage = ({ cid, id }) => ['Urban Game Theory shared property-offer acceptance', `Offer CID: ${cid}`, `Acceptance SHA-256: ${id}`].join('\n');
    return { sellerConsentMessage, requestMessage, sessionMessage };
});
