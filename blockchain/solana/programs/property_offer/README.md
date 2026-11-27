# Property offer (Solana)

`property_offer` v2 (`HrK4gvMqpYNvYSidaMLywy9mknQUatMig2fnWcG2UVyH`, devnet) settles a fixed-price
offer for one plot or one flat in SOL or devnet USDC. It is an escrow and settlement record only: it
does not know what is sold or who holds it, and it transfers no title.

## Safety model

- The offer CID and `terms_hash` commit the canonical `property-offer/v2` object. The offer address
  is `["property-offer", maker, sha256(cid)]`.
- Each side names its lens: up to 8 distinct member keys and a threshold. The buyer's lens is
  required (role 0: the seller holds the asset); the seller's lens may be empty (role 1: the buyer
  qualifies). The maker's lens is fixed at `create`, the counterparty's at `commit`.
- The buyer's money is escrowed when the buyer acts: at `create` for a buy offer, at `commit` for a
  sell offer. SOL is held in the offer account; USDC in the offer's associated token account.
- A sale has an explicit payout schedule of at most 16 unique recipients summing exactly to the
  price (`create` for a sell offer, `commit` for a buy offer).
- `confirm` records one lens member's `PropertyOfferConfirmation-v1` SAS attestation: owned by SAS,
  unexpired, issued under the member's own credential and the schema
  `["schema", credential, "PropertyOfferConfirmation", 1]`, binding this offer's CID, address, terms
  hash, payout hash, buyer and seller; its role picks the lens, and each member counts once.
- `execute` pays every scheduled recipient in one instruction once both lenses are met, before the
  deadline. Remaining accounts are the recipients (wallets for SOL, token accounts for USDC) in
  schedule order, so settlement is all-or-nothing.
- `cancel`: the maker, while Open; any escrow returns. `expire`: anyone after the deadline while
  Open or Committed; any escrow returns to the buyer.
- Nothing approves by default: an offer whose lenses do not confirm expires.

## Lens payload

`PropertyOfferConfirmation` version 1, borsh fields in order: `cid`, `offer` (base58), `termsHash`
(hex), `payoutsHash` (hex), `buyer`, `seller`, `role` (u8), `assetHash` (hex), `holding` (the
statement or settled offer through which the seller holds the asset; empty for role 1),
`observedAt` (i64). The program reads the first seven and checks `observedAt` is not in the future;
`assetHash` and `holding` are for readers. A role-0 confirmation's SAS nonce is
`sha256(["property-offer-sale/v1", assetHash, holding])`, so one lens member cannot confirm two sales of
one holding (`frontend/js/solana/property-offer-client.js` `decisionNonce`).

## Tests

`tests/property_offer.ts` (mock SAS, local USDC) and `tests/property_offer_integrated.ts` (the real
SAS cloned from devnet; refuses a second confirmation of one holding).
