# Canton / DAML contracts

DAML smart contracts for the Canton chain option (the third blockchain backend
alongside EVM and Solana). See `../../feature-daml.md` for the full plan; this
folder implements the **M1 minimal slice**: a single-parcel purchase via the
propose-accept pattern, no money yet.

## Templates (`daml/Proposal.daml`)

- `OwnershipCertificate` — the verifier (lens) attests that an owner owns a parcel.
- `PurchaseProposal` — a buyer's offer for one parcel, referencing the certificate.
  - `Accept` (controller: owner) → archives the proposal, creates a `Sale`.
  - `Withdraw` (controller: buyer) → cancels the offer.
- `Sale` — the executed agreement, signed by both buyer and owner.

## Prerequisites

DAML SDK (installs `daml` CLI):

```bash
curl -sSL https://get.daml.com/ | sh
```

## Build & test

```bash
daml build      # compiles to .daml/dist/*.dar
daml test       # runs the Daml Script tests in daml/Test.daml
```

## Local ledger (M0 / M3)

```bash
daml sandbox            # in-memory ledger on :6865
daml json-api ...       # JSON Ledger API the frontend bridge will call
```
