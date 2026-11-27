# Purchase and sale offers

A `property-offer/v2` offers to buy or sell one plot or one flat for a fixed price in SOL or devnet
USDC, until a deadline. The plot is named as its parcel source gives it (source and id); the flat by
its [flat address](vocabulary.md#flat-address). Ownership is not a token: lens members state it, and
each reader sees it through the lens members they trust ([holder according to a lens](vocabulary.md#holder-according-to-a-lens)).

## Making, taking and settling an offer

1. **Make.** From a plot (Actions → Ownership: Put up for sale, Offer to buy) or a flat in X-ray
   (Put up for sale, Offer to buy), choose USDC or SOL, the price and the deadline. A buyer names the
   lens members it trusts to confirm the seller holds the asset (its lens, one to eight lens members
   and how many must confirm; the person's lens preference fills it in). A seller may name lens
   members who must qualify the buyer, or none. Minting publishes the terms (their CID) and creates
   the offer on Solana in one wallet approval; a buyer's price goes into escrow in the same approval.
2. **Take.** A buyer taking a listing names its lens and pays into escrow; a seller accepting a bid
   names its payout and, optionally, a lens that qualifies the buyer. One approval.
3. **Wait for the lenses.** Nothing approves by default. Each lens member confirms from its own
   wallet (Lens requests, or the offer sheet's Confirm). A buyer's-lens member confirms only when its
   own statements name the seller as holder; its confirmation sits at an address fixed by the asset
   and the holding sold, so it cannot confirm a second sale of the same holding. The confirmation
   that completes both lenses also pays the schedule, in the same approval.
4. **End.** The maker withdraws an offer nobody has taken; after the deadline anyone ends an unsettled
   offer and any escrow returns to the buyer.

## First holders and self-declarations

A lens member states who first holds an asset with a `PropertyHolding-v1` statement (basis: the
developer of a new building, the holder's own declaration it checked, or an official register), from
the asset's sheet ("State who holds it"). A person asks lens members for one with a signed request
("Ask lens members to confirm you hold it"); the request is listed for those lens members under Lens
requests, and nothing happens until one of them states it. A lens member withdraws its own statement
from the same sheet.

## Where offers are listed

The Market sheet lists offers for sale or wanted, flats or plots, in the map area or the whole city
(`GET /property-offers`). A plot's or a flat's sheet lists the offers on that asset and who holds it
according to the reader's lens. Lens requests lists the committed offers and the self-declaration
requests that wait for the connected wallet (`GET /property-offers/awaiting`, `GET /holding-requests`).

## Identity and index

The CID commits the canonical terms; the program commits their SHA-256 and the offer address is
`["property-offer", maker, sha256(cid)]`. `consensus.property_offer` indexes published offers with
the asset kind, identity hash and map location, and mirrors the chain account only as the server
reads it itself (`POST /property-offers/:cid/onchain`); a browser's status claim is never accepted.
`consensus.holding_request` keeps signed self-declaration requests; whether one was answered is read
from chain. `backend/scripts/migrate-property-offers-v2.mjs --apply` replaces the v1 tables.

## Solana

`programs/property_offer` v2 at `HrK4gvMqpYNvYSidaMLywy9mknQUatMig2fnWcG2UVyH` on devnet
([program contract](../blockchain/solana/programs/property_offer/README.md)). It checks the lens
members' `PropertyOfferConfirmation-v1` statements against the offer and pays the schedule; it does
not know what is sold or who holds it. Lens members' statements are SAS attestations under their own
`LensMember` credential, built in the browser by `frontend/js/solana/property-statements.js`;
`frontend/js/property-holders.js` reads a holder back from derived addresses only.

## MCP editing

`ugt_draft_property_offer`, `ugt_edit_property_offer`, `ugt_list_property_offer`,
`ugt_get_property_offer` and `ugt_publish_property_offer` share the canonical `property-offer/v2`
record model; `ugt_request_holding` prepares a holding request's exact message and relays a supplied
signature with `confirm=true`, and `ugt_list_holding_requests` lists requests. These hosted tools
never sign or send funds. Locally, a wallet-holding agent takes the chain steps with
`ugt_mint_property_offer`, `ugt_take_property_offer`, `ugt_confirm_property_offer`,
`ugt_execute_property_offer`, `ugt_cancel_property_offer`, `ugt_expire_property_offer` and
`ugt_state_holding` (`agents/property-offer-signer.js`).

## Bots

The homebuyer bots trade the flats of executed developer rounds in USDC through the same signer steps
([agents README](../backend/agents/README.md#developer-rounds-and-homebuyers)). The round's lens
member, whose key the developer's runner holds, states each round buyer as the flat's first holder
(basis developer) and confirms a committed offer as the buyer's lens only when its own statements name
the seller as holder; the bots trade only flats it states a holder for, and an offer it does not
confirm expires and its escrow returns.

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
