# Purchase and sale offers

An offer is a standalone `property-offer/v1` agreement to purchase or sell one or more
source-qualified cadastral parcels for a fixed total price in SOL. It requires no design or plan.
The selected parcels form one atomic bundle; partial acceptance is not supported. Buildings,
apartments and leases are outside this record.

## Browser workflow

1. Select one parcel or a parcel set. In its **Actions → Ownership** group, choose **Offer to buy**
   or **Offer to sell**. Connect the proposer’s Solana wallet, enter total SOL price, deadline and
   the ownership lens. A sale includes an explicit payout schedule totaling the price.
2. Save the draft, then **Publish offer**. It appears in **Lists → Agreements**. Share opens
   `/property-offers/<cid>`; Download exports the canonical JSON and the Agreements import accepts it.
3. The proposer selects **Mint on Solana**. The browser verifies the network and executable program
   before asking for a transaction signature. Publication alone does not create escrow.
4. Open **Accept offer** to prepare the parties and payments. A buy offer obtains its payout schedule
   here; a sale retains its published schedule. Each payout recipient signs **Sign my seller consent**
   with their own wallet. Download/import the same acceptance JSON to collect multiple signatures.
   Changing the buyer or payment schedule invalidates those signatures.
5. The accepting counterparty submits **Accept offer**: the buyer for a sale, or the seller
   representative for a buy. The lens independently reads the offer, its open chain account and the
   complete source-qualified owner sets. It verifies every owner signature and the counterparty’s
   signed request, then issues a SAS `PropertyOfferDecision` attestation. Acceptance records this
   exact decision atomically on Solana.
6. The bound buyer selects **Fund**, depositing exactly the price. **Execute** pays all scheduled
   recipients atomically. An open offer can be cancelled by its proposer. After acceptance it can
   execute before the deadline or expire afterward; expiration refunds escrow to the bound buyer.

The contract settles SOL under the selected lens’s ownership evidence. It does not update a land
registry or itself convey cadastral title.

## Identity and persistence

The CID commits canonical immutable terms: direction, proposer, open counterparty role, city,
creation/expiry instants, lens, source-qualified parcel bundle and whole-lamport price. Sell terms
also commit sorted payout rows. There are at most 200 distinct parcels and 16 distinct recipients;
amounts are positive u64 decimal strings and the payout sum must equal the price exactly.

`consensus.property_offer` holds published terms separately from plan agreements. Local working
copies use the `property-offer:` storage prefix. Accepted counterparties and chain state are separate
from the immutable content. `/property-offers/:cid/onchain` independently reads the expected Solana
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

The lens serves `POST /lens/property-offers/:cid/decision`, with a bounded request rate. Requests
supply proposed parties, payouts, seller signatures and the accepting wallet’s signed request.
The server derives truth fields itself. `lens/run.mjs` supplies the database index and RPC readers.
The reference identity adapter uses the explicitly configured devnet registry; a source-qualified
registry key is the canonical JSON array `[sourceId, parcelId, snapshotIdOrNull]`. All rows of a
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
`ugt_get_property_offer`, `ugt_prepare_property_offer` and `ugt_publish_property_offer` share the canonical record model.
Edits require the inspected `expectedCid`; publication requires the reviewed CID and `confirm=true`.
Draft content and prepared acceptance packages are portable JSON for browser import. The preparation tool returns exact seller and accepting-wallet messages. These tools never sign wallet consents or send
funds. The person completes those steps with their wallet in the browser.
