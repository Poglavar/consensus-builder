# Purchase and sale offers

A standalone `property-offer/v1` names one whole X-ray apartment or a bundle of source-qualified parcels, a fixed price in SOL, a deadline and the maker’s chosen lens. A bid opens the seller role. A listing opens the buyer role.

## Apartment offers

From the selected apartment in **X-ray**, choose **Offer to buy apartment** or **Offer to sell apartment**. The same actions appear under **Independent offers in SOL** on the apartment row of an open funding agreement. Enter the price, select a lens, and mint the offer. A seller specifies the payout schedule. A buyer’s offer receives its schedule at acceptance.

The mint transaction creates the offer and creates or reuses the apartment’s ownerless address. Every offer for the same X-ray building and unit shares that address. Anyone can pay the creation cost. The address stays fixed when a different wallet proposes an offer or a sale settles. The proposer’s lens sets the qualification criteria for the other party.

**Find apartment offers** in X-ray lists live standalone bids and listings and also finds USDC reservation agreements for the same unit. The USDC link opens the developer’s agreement with the unit selected. Its deposit and contract stay with that agreement. [Developer crowdfunding](developer-crowdfunding.md)

Acceptance sessions, operator qualification of a counterparty and the lens service's offer routes are gone. In v2 the counterparty commits on chain naming its own lens, the lens members confirm with `PropertyOfferConfirmation-v1` attestations from their wallets, and the offer pays out once both lenses are met or expires.

## Parcel offer workflow

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
4. The counterparty commits on chain (a buyer names its lens and pays the price into escrow; a seller
   of a buy offer names the payout schedule). The lens members confirm from their wallets, and the
   offer pays the schedule once both lenses are met. An open offer can be cancelled by its maker; an
   unsettled offer expires after its deadline and refunds the buyer.

The review panel lists exact parcel references with map navigation, full buyer/seller wallets,
payout recipients and amounts, and the Solana account. Refresh can recover a confirmed account whose
index update failed; changing the connected wallet updates the available actions.

Parcel anchors remain ownerless and non-transferable; registered title comes from the land registry.
Who holds an asset is what a lens member's statements say: its `PropertyHolding-v1` first-holder
statement and its sale confirmations (plan step 5). The server keeps no transfer evidence.

## Identity and persistence

The CID commits canonical immutable terms: direction, proposer, open counterparty role, city,
creation and expiry, lens, exact property and whole-lamport price. The property is either `parcels` or one `apartment` with `xrayBuilding`, `unit`, `at` and optional estimated-layout `access`. The apartment PDA uses the seeds `"apartment"` and the SHA-256 of the UTF-8 JSON array `["apartment/v1", xrayBuilding, unit]` under the parcel anchor program. Camera, terms, developer and payer are outside its identity. Sell terms
also commit sorted payout rows. There are at most 200 distinct parcels and 16 distinct recipients;
amounts are positive u64 decimal strings and the payout sum must equal the price exactly.

`consensus.property_offer` (v2) indexes published terms separately from plan agreements, with the
asset kind, hash and location, the status and the lens members. `/property-offers/:cid/onchain`
independently reads the expected Solana PDA and checks its program, CID, terms hash, maker, side,
currency, price, deadline, the maker's lens and a sale's payouts before mirroring state; browser
status claims are never accepted as evidence. `consensus.holding_request` holds people's signed
requests that lens members state they hold a plot or a flat (`POST/GET /holding-requests`).
`scripts/migrate-property-offers-v2.mjs` drops the v1 tables before the v2 DDL is applied.

Whole-building offers would need their own building-scoped identity. The current standalone asset choices are apartments and parcel bundles.

## Solana and lens runtime

The devnet `property_offer` program is `blockchain/solana/programs/property_offer`, with browser codec
`frontend/js/solana/property-offer-client.js` and address
`BasWrJJH6By9nkeeLAoAdYpPu35BM9VMtMCWGyXjqdBp`. The bridge checks that this program is executable on the
selected Solana network before it builds an offer instruction. The existing `agreement` program remains
the program for plan agreements.

The SAS schema is `PropertyOfferDecision` v2. It binds the offer CID and account, canonical terms hash,
ordered payout hash, buyer, seller, affirmative counterparty qualification and observation time. The
[program contract](../blockchain/solana/programs/property_offer/README.md) defines its byte layout.

The lens service no longer serves property-offer routes: lens members confirm offers from their own
wallets. The developer-round apartment reservation qualification
(`/lens/agreements/:cid/apartments/:unitId/qualify`) is a separate flow and stays.

Apply `db/property-offer-ddl.sql` and the updated `routes/lens-member-ddl.sql` with the usual backend
DDL process. A live lens needs the registered SAS schema `PropertyOfferDecision-v2`. Its affirmative field is `counterpartyQualified`. A v1 ownership decision cannot authorize a new acceptance. API/bridge devnet
connections verify the devnet genesis hash. Localnet indexing is available only when
`SOLANA_LOCALNET_RPC_URL` explicitly names a loopback endpoint; the browser likewise needs an explicit
`SOLANA_RPC_URLS.localnet`. No public-network deployment or transaction is implicit in local tests.

## MCP editing

`ugt_draft_property_offer`, `ugt_edit_property_offer`, `ugt_list_property_offer`,
`ugt_get_property_offer` and `ugt_publish_property_offer` share the canonical `property-offer/v2`
record model; `ugt_request_holding` prepares a holding request's exact message and relays a supplied
signature with `confirm=true`, and `ugt_list_holding_requests` lists requests. These hosted tools
never sign or send funds. Locally, a wallet-holding agent takes the chain steps with
`ugt_mint_property_offer`, `ugt_take_property_offer`, `ugt_confirm_property_offer`,
`ugt_execute_property_offer`, `ugt_cancel_property_offer`, `ugt_expire_property_offer` and
`ugt_state_holding` (`agents/property-offer-signer.js`).

## Open: double sale and multi-parcel offers

Unresolved as of 2026-11-27. The single-plot and single-apartment case is being built first; this
section holds the thinking reached so far.

**Observed.** Nothing prevents one seller selling the same asset several times: on devnet the
homebuyer bots sold one Alatau flat three times through the same lens member, and all three
settled. Apartment sellers are never checked as holders.

**Settled principles.**
- The `property_offer` program does not learn that a sale happened, under which rules, by whom or to
  whom, and enforces nothing about sales. A per-seller sale record in the program was rejected.
- It must be impossible to sell the same holding to several people through the same lens. Across
  lenses a conflict is the readers' call: a reader whose lens includes both lens members sees it.
- Proposed mechanism: a lens member's sale confirmation for one asset is a statement whose SAS
  address derives from the lens member, the asset and the statement by which the seller holds it.
  A second confirmation of the same holding lands on the same address and fails, unless the first
  is withdrawn (publicly). A seller who buys the asset back holds it through a new statement, so
  selling it again is possible.

**Multi-parcel offers (bundles).** A bundle is one thing at the level above cadastral parcels; on
chain the offer already stores only its terms hash, whatever the parcel count. Open questions:
- Per-parcel ownership changes must happen only if the whole sale settles. One idea: before
  payment, each confirming lens member writes one statement per parcel ("P passes from S to B when
  offer O settles"), each at its per-holding address, then one confirmation for the bundle; the
  program pays out at once, and readers treat each parcel statement as effective if O settled and
  void if it expired or was cancelled. Not decided.
- Very large bundles (a bid for 1000 parcels): hundreds of lens-member transactions; the 16-recipient
  payout limit with many co-owners; one consent per owner for the whole bundle.
- Whether a bundle is the offer's own parcel list or an existing record such as a design.
