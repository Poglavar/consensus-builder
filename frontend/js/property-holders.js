// Who holds a plot or a flat according to a lens: for each lens member, its first-holder statement
// (PropertyHolding-v1) followed through the sales it confirmed (PropertyOfferConfirmation-v1, role 0)
// whose offers settled on chain. Every address is derived, so the walk needs only account reads.
// Pure: the caller supplies `getAccount(address) -> Uint8Array | null` and the codecs.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.PropertyHolders = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';
    const MAX_SALES = 64;

    /**
     * One lens member's view of an asset. `holding` is the reference a sale of the current holder's
     * holding must name (the first-holder statement's address, or the settled offer it was bought
     * through). `pending` is an offer this member confirmed that has not settled yet; `stale` one
     * that expired or was cancelled, which blocks this member's next confirmation until withdrawn.
     */
    async function viewOf({ member, assetHash, getAccount, statements, offers }) {
        const first = statements.holdingAddress(member, assetHash).toBase58();
        const data = await getAccount(first);
        if (!data) return { member, holder: null, holding: null, first: null, sales: [], pending: null, stale: null };
        const statement = statements.readHolding(data);
        if (!statement || statement.signer !== member || statement.fields.assetHash !== assetHash) {
            return { member, holder: null, holding: null, first: null, sales: [], pending: null, stale: null, invalid: first };
        }
        const view = { member, holder: statement.fields.holder, holding: first, first: { address: first, ...statement.fields }, sales: [], pending: null, stale: null };
        for (let i = 0; i < MAX_SALES; i++) {
            const nonce = offers.decisionNonce({ role: 0, assetHash, holding: view.holding });
            const address = statements.confirmationAddress(member, nonce).toBase58();
            const raw = await getAccount(address);
            if (!raw) break;
            const decision = offers.readDecisionAttestation(raw, address);
            if (decision.signer !== member || decision.fields.assetHash !== assetHash || decision.fields.holding !== view.holding || decision.fields.seller !== view.holder) {
                view.invalid = address; break;
            }
            const offerData = await getAccount(decision.fields.offer);
            const offer = offerData ? offers.readPropertyOffer(offerData, decision.fields.offer) : null;
            if (!offer || offer.cid !== decision.fields.cid) { view.invalid = address; break; }
            const entry = { confirmation: address, offer: offer.address, cid: offer.cid, seller: decision.fields.seller, buyer: decision.fields.buyer, status: offer.status, settledAt: offer.settledAt };
            if (offer.status === 'Settled' && offer.buyer === decision.fields.buyer && offer.seller === view.holder) {
                view.sales.push(entry); view.holder = offer.buyer; view.holding = offer.address; continue;
            }
            if (offer.status === 'Open' || offer.status === 'Committed') view.pending = entry; else view.stale = entry;
            break;
        }
        return view;
    }

    /**
     * The lens's answer: each member's view, and `holder` when the members who state anything agree.
     * `conflict` lists the different holders they name; members who state nothing are `silent`.
     */
    async function lensView({ members, assetHash, ...deps }) {
        const views = await Promise.all((members || []).map(member => viewOf({ member, assetHash, ...deps })));
        const named = views.filter(view => view.holder);
        const holders = [...new Set(named.map(view => view.holder))];
        return { views, holder: holders.length === 1 ? holders[0] : null, conflict: holders.length > 1 ? holders : null,
            silent: views.filter(view => !view.holder).map(view => view.member), stating: named.length };
    }

    return { viewOf, lensView, MAX_SALES };
});
