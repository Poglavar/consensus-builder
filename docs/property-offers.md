# Purchase and sale offers

An offer is a standalone `property-offer/v1` agreement to purchase or sell one or more
source-qualified cadastral parcels for a fixed total price in SOL. It requires no design or plan.
The selected parcels form one atomic bundle; partial acceptance is not supported. Buildings,
apartments and leases are outside this record.

## Browser workflow

1. Select one parcel or a parcel set. In its **Actions → Ownership** group, choose **Offer to buy**
   or **Offer to sell**. Connect the proposer’s Solana wallet, enter total SOL price, deadline and
   the ownership lens. A sale includes an explicit payout schedule totaling the price.
2. Select **Mint offer**. This publishes the exact terms and requests the Solana mint in one action.
   Before publishing, the browser verifies the network/program, the live lens service, its registered
   active SAS credential/schema and complete ownership coverage. A sale must name an owner as proposer
   and pay the exact owner union. A preflight failure leaves the form editable. If a later mint fails
   or the wallet declines, the published offer remains available for retry without changing its terms.
   Publication alone does not create an on-chain offer or escrow.
3. Find the offer in **Lists → Agreements**. Share opens `/property-offers/<cid>`; Download exports
   the canonical JSON and the Agreements import accepts it. An imported or unfinished offer uses
   the same **Mint offer** action to complete publication and minting.
4. Open **Accept offer** to prepare the parties and payments. A buy offer obtains its payout schedule
   here; a sale retains its published schedule. Each payout recipient signs **Sign my seller consent**
   with their own wallet. The signature names the buyer, exact offer, payout and current ownership
   evidence. It authorizes transfer upon finalized settlement. **Share acceptance link** creates one immutable shared candidate using a
   participant-signed request; other sellers open that link, review and sign. **Refresh signatures**
   collects their independently stored consents and shows which wallets are still needed. Acceptance
   refreshes signatures before submitting to the lens. JSON download/import remains available.
   Changing parties, the payment schedule or the ownership evidence starts a different candidate and clears prior consents.
5. The accepting counterparty submits **Accept offer**: the buyer for a sale, or the seller
   representative for a buy. The lens independently reads the offer, its open chain account and the
   complete source-qualified owner sets. It verifies every owner signature and the counterparty’s
   signed request, then issues a SAS `PropertyOfferDecision` attestation. Acceptance records this
   exact decision atomically on Solana.
6. The bound buyer selects **Fund**, depositing exactly the price. **Execute** pays all scheduled
   recipients atomically. An open offer can be cancelled by its proposer. After acceptance it can
   execute before the deadline or expire afterward; expiration refunds escrow to the bound buyer.

The review panel lists exact parcel references with map navigation, full buyer/seller wallets,
payout recipients and amounts, and the Solana account. Refresh can recover a confirmed account whose
index update failed; changing the connected wallet updates the available actions.

Parcel anchors remain ownerless and non-transferable; registered title comes from the land registry.
After finalized payment the offer lens publishes the seller-signed `parcel-ownership-transfer/v1`
evidence at `GET /lens/property-offers/:cid/transfer`. The record includes the offer and Solana network,
prior ownership evidence for each source-qualified parcel, the buyer, every outgoing owner’s signature,
the decision attestation, and the finalized account’s observation time. A predecessor from an earlier
sale identifies that sale’s lens and offer CID so another lens can retrieve and verify the link.

The reference lens follows these transfers from its configured ownership roots. It verifies the
current predecessor set before authorizing an offer and reserves those predecessors within its own
lens and network while settlement is pending. A finalized cancellation or expiry releases the
reservation. Final settlement recognizes the buyer as the successor for each parcel in the bundle.
Both property offers and agreements using this reference lens resolve through the same evidence chain.
Other lenses can verify the published evidence against the roots and issuers they trust.

## Identity and persistence

The CID commits canonical immutable terms: direction, proposer, open counterparty role, city,
creation/expiry instants, lens, source-qualified parcel bundle and whole-lamport price. Sell terms
also commit sorted payout rows. There are at most 200 distinct parcels and 16 distinct recipients;
amounts are positive u64 decimal strings and the payout sum must equal the price exactly.

`consensus.property_offer` holds published terms separately from plan agreements. Local working
copies use the `property-offer:` storage prefix. Accepted counterparties and chain state are separate
from the immutable content. `consensus.property_offer_acceptance` stores up to 32 distinct shared
candidates per offer, keyed by the SHA-256 of canonical terms including parties and payout schedule.
Its seller signatures are verified and merged atomically per wallet. Sharing requires a signed
request by a candidate party; a stored signature proves consent to those terms, while the lens
independently establishes ownership at acceptance. Expired sessions remain readable but cannot
collect new signatures. `/property-offers/:cid/onchain` independently reads the expected Solana
PDA and checks its program, CID, terms hash, maker, lens, direction, price, deadline and sale payouts
before mirroring state; browser status claims are never accepted as evidence.

## Solana and lens runtime

The new program is `blockchain/solana/programs/property_offer`, with browser codec
`frontend/js/solana/property-offer-client.js`. Its configured address is
`2dYG7pCgQr83Nfor5LWRY5fRyf4UHDteVpUa4g2hj7mx`. This source configuration is not a statement that the
program is deployed on devnet. The bridge checks deployment at runtime. The existing `agreement`
program remains the program for plan agreements.

The SAS schema is `PropertyOfferDecision` v1. It binds the offer CID/PDA, canonical terms hash,
ordered payout hash, buyer, seller representative, ownership result and evidence time. The
[program contract](../blockchain/solana/programs/property_offer/README.md) defines its byte layout.

The lens serves `POST /lens/property-offers/check` for pre-mint ownership/schema configuration
checks and `POST /lens/property-offers/:cid/decision` for approval, with bounded request rates. Requests
supply proposed parties, payouts, seller signatures and the accepting wallet’s signed request.
The server derives truth fields itself. `lens/run.mjs` supplies the database index and RPC readers.
The reference identity adapter uses the explicitly configured devnet registry. Current `oss-wfs`
references with official `HR-*` IDs map to that registry’s existing raw cadastral IDs. Every other
source or snapshot uses the canonical JSON array `[sourceId, parcelId, snapshotIdOrNull]`; there is
no fallback to a bare ID. Returned owner sets are keyed by the offer’s canonical reference. All rows of a
parcel must agree on the complete owner count, and every owner must be a payout recipient and sign.
An identity adapter without complete owner-set reads cannot issue this decision. Registry
`establishedAt` records source provenance, not a claim of a new live registry observation.

Apply `db/property-offer-ddl.sql` and the updated `routes/lens-member-ddl.sql` with the usual backend
DDL process. A live lens also needs its SAS property-offer schema registered. API/bridge devnet
connections verify the devnet genesis hash. Localnet indexing is available only when
`SOLANA_LOCALNET_RPC_URL` explicitly names a loopback endpoint; the browser likewise needs an explicit
`SOLANA_RPC_URLS.localnet`. No public-network deployment or transaction is implicit in local tests.

## MCP editing

`ugt_draft_property_offer`, `ugt_edit_property_offer`, `ugt_list_property_offer`,
`ugt_get_property_offer`, `ugt_prepare_property_offer`, `ugt_consent_property_offer` and
`ugt_publish_property_offer` share the canonical record model.
Edits require the inspected `expectedCid`; publication requires the reviewed CID and `confirm=true`.
Draft content and prepared acceptance packages are portable JSON for browser import. Preparation
takes the ownership hash from the chosen lens’s offer preflight and returns exact seller,
accepting-wallet and sharing messages. The consent tool reads shared sessions
or relays supplied signatures with `confirm=true`. These tools never generate wallet signatures
or send funds. The person completes those steps with their wallet in the browser.
