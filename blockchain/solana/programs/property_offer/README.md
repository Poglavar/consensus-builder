# Property offer (Solana)

`property_offer` settles an atomic, fixed-price purchase or sale offer. It is an escrow
settlement record only: it does not itself transfer cadastral title.

## Safety model

- The offer CID and `terms_hash` commit the canonical `property-offer/v1` object, including its
  exact apartment or sorted parcel bundle and price.
- A sale uses an explicit payout schedule of at most 16 unique recipient wallets. Amounts are
  positive and must sum exactly to the price. The program never divides proceeds or infers owners.
- A BUY is schedule-less when created; its accepting sellers supply the final schedule. A SELL has
  its schedule at creation.
- `accept` needs a current SAS `PropertyOfferDecision` v2 attestation. It atomically binds the
  offer CID/PDA, immutable terms hash, final payout hash, buyer, seller and the lens’s affirmative qualification before
  a counterparty is recorded. This prevents untrusted acceptance from reserving a public offer.
- The buyer deposits exactly the fixed price. `execute` then transfers to every scheduled recipient
  in one instruction/transaction. Its remaining accounts must be the recipient list in schedule
  order, so settlement is all-or-nothing.
- Only an open offer may be cancelled by its maker. Acceptance includes the lens decision in the
  same transaction, so an accepted offer cannot be cancelled. If it remains uncompleted past its
  deadline, expiry returns its escrow to the fixed buyer; an open sale has no buyer and names its
  maker as the zero-escrow expiry recipient.

## Lens payload

SAS schema `PropertyOfferDecision`, version 2, borsh fields in exact order:

1. `cid`: string
2. `offer`: base58 PDA string
3. `termsHash`: lowercase 64-character SHA-256 hex string
4. `payoutsHash`: lowercase 64-character SHA-256 hex string
5. `buyer`: base58 string
6. `seller`: base58 string
7. `counterpartyQualified`: u8 (`1` only)
8. `sourceObservedAt`: i64

`payoutsHash` is SHA-256 over the ordered raw concatenation of each recipient's 32-byte public key
and its little-endian `u64` lamport amount.

## Browser codec

`frontend/js/solana/property-offer-client.js` exports `PropertyOfferClient`. Its useful builders
are `buildCreateIx`, `buildAcceptIx`, `buildFundIx`, `buildExecuteIx`, `buildCancelIx` and
`buildExpireIx`. `buildExecuteIx` receives the full scheduled recipient list, not one recipient.
Configure it with injected `web3`; binary payout hashing additionally needs `sha256Bytes` outside
Node.
