// Exact wallet messages for a property-offer decision request. The lens recomputes all hashes;
// these messages prove each named wallet approved a candidate and its ownership basis.
(function (root, factory) { const api = factory(); if (typeof module === 'object' && module.exports) module.exports = api; if (root) root.PropertyOfferConsent = api; })(typeof window !== 'undefined' ? window : globalThis, function () {
    const stable = value => JSON.stringify(value);
    const sellerConsentMessage = ({ cid, offer, termsHash, payoutsHash, ownershipHash, buyer, seller }) => [
        'Urban Game Theory property-offer seller consent', `Offer CID: ${cid}`, `Offer account: ${offer}`,
        `Terms SHA-256: ${termsHash}`, `Payouts SHA-256: ${payoutsHash}`, `Ownership basis SHA-256: ${ownershipHash}`,
        `Buyer: ${buyer}`, `Seller: ${seller}`,
        'On finalized settlement, Seller transfers their interest in this offer’s parcels to Buyer.'
    ].join('\n');
    const requestMessage = ({ cid, offer, termsHash, payoutsHash, ownershipHash, buyer, seller, consents = [] }) => [
        'Urban Game Theory property-offer decision request', stable({ cid, offer, termsHash, payoutsHash, ownershipHash, buyer, seller,
            consents: consents.map(row => ({ owner: row.owner, signature: row.signature })).sort((a, b) => a.owner.localeCompare(b.owner)) })
    ].join('\n');
    const sessionMessage = ({ cid, id }) => ['Urban Game Theory shared property-offer acceptance', `Offer CID: ${cid}`, `Acceptance SHA-256: ${id}`].join('\n');
    return { sellerConsentMessage, requestMessage, sessionMessage };
});
